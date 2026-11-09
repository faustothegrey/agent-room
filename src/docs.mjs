// Document viewer: handle() serves the room's discussions/ over local HTTP,
// rendering Markdown with marked. Images (and links to images) show inline; pick() is the
// terminal document picker behind /docs.
// It also serves the discussion screen (/__room): the
// header with the root and active discussion; on the left two tabs, the discussion and the worker
// (one agent outside the round that carries out the User's instructions), each with a message box
// in UI mode; and on the right, when the User picks one, a document watched live (Discussions lists the
// room's discussions: their documents, drawings and transcripts). In terminal
// mode (npm run terminal) the page only watches.
// cli.mjs loads this module in load(), so /reload swaps it too.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { Marked } from 'marked';

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const md = new Marked({
  renderer: {
    // A plain link to an image also shows the image itself, right under the link.
    link({ href, tokens }) {
      if (!IMAGE.test(href)) return false;
      return `<a href="${esc(href)}">${this.parser.parseInline(tokens)}</a><img class="preview" src="${esc(href)}" alt="">`;
    },
  },
});

// Transcripts quote whatever was said, so raw HTML in them is shown as text, never run.
const mdText = new Marked({ renderer: { html: ({ text }) => esc(text) } });

// Every non-hidden file under dir, as sorted paths relative to it.
export function listFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(join(d, e.name));
      else files.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return files.sort();
}

// The URL path for a file returned by listFiles.
export const urlPath = (file) => file.split(sep).map(encodeURIComponent).join('/');

// The file at rel if it is a non-hidden file inside dir, else null: no ../ escapes, and no symbolic
// link leading out of dir (both are compared by real path), so a room serves only its own folder.
function inside(dir, rel) {
  let root;
  try { root = realpathSync(dir); } catch { return null; }
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep) || rel.split('/').some((p) => p.startsWith('.'))) return null;
  try {
    const target = realpathSync(file);
    return target.startsWith(root + sep) && statSync(target).isFile() ? target : null;
  } catch { return null; }
}

// A room serves only some folders of its root (screen.sections: discussions/);
// without sections (the plain viewer), all of dir.
const inSection = (screen, rel) => !screen?.sections || screen.sections.includes(rel.split('/')[0]);
const servable = (dir, rel, screen) => (inSection(screen, rel) ? inside(dir, rel) : null);
function docFiles(dir, screen) {
  if (!screen?.sections) return listFiles(dir);
  return screen.sections.flatMap((s) => { try { return listFiles(join(dir, s)).map((f) => join(s, f)); } catch { return []; } });
}

// The page polls the file's mtime and reloads when an agent changes it.
// base: the room's address (/r/<id>/), so the page's links stay in its room.
function page(title, body, watch, base = '/') {
  const home = `<a href="${esc(base)}">all files</a>`, mtime = `${base}__mtime?f=`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>
:root { color-scheme: light dark; }
body { font: 16px/1.55 -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
img { max-width: 100%; } img.preview { display: block; margin: .5rem 0; }
pre, code { background: #8881; border-radius: 4px; } pre { padding: .75rem; overflow-x: auto; } code { padding: 0 .2em; }
table { border-collapse: collapse; } th, td { border: 1px solid #8886; padding: .3rem .6rem; }
nav { font-size: .85rem; opacity: .7; margin-bottom: 1rem; }
</style></head><body><nav>${home} · ${esc(title)}</nav><main>${body}</main>
<script>
let last = null;
setInterval(async () => {
  const t = await (await fetch(${JSON.stringify(mtime)} + encodeURIComponent(${JSON.stringify(watch)}), { cache: 'no-store' })).text();
  if (t === 'false') return; // missing for now (being saved?): keep showing it, ask again
  if (last !== null && t !== last) location.reload();
  last = t;
}, 2000);
</script></body></html>`;
}

// ── The discussion screen ────────────────────────────────────────────────────────────────────
// `screen` is plain state kept by the caller across reloads:
// { clients: Set of open event streams, transcript: the room's entries, doc: file or null,
//   thinking: name or null, status: the last round's end line or null,
//   room: { folder (the full root path), agents: [names], worker: name, discussion: its title,
//     active: its folder under the root or null, started: first message sent (or a brainstorm),
//     brainstorm: a conversation kept only in memory, transcript: this session's transcript,
//     under the root, or null } for the header,
//   sections: the root's folders a room serves (discussions/),
//   worker: the worker tab's messages (messageView, plus meta: time and tokens),
//   working: the worker's name while it works, else null,
//   auto: whether auto-summarize is on, quota: the header's gauges ([{ provider, label, used,
//   resets }], null if the meter can't be read, undefined until first read),
//   say: (line) => void, work: (text) => void, setAuto: (on) => void and newRoom: () => Promise,
//   set only when the page is the input (UI mode) }.

// A transcript entry as the page shows it: the text rendered as Markdown. Summary turns are
// hidden (only the summary's result is shown); the result carries its label.
export function messageView(m) {
  const view = { speaker: m.speaker, html: md.parse(m.text ?? ''), error: !!m.error, pass: !!m.pass };
  if (m.summary) view.hidden = true;
  if (m.outcome) {
    view.outcome = m.outcome;
    view.speaker = m.outcome === 'agreed' ? `Summary — agreed, by ${m.by}` : `Summary — not agreed: the last version, by ${m.by}`;
  }
  return view;
}

// Sends one event ({ type, ... }) to every open screen. The last round's end line is remembered
// until the User speaks again, so a page opened later still shows that it is the User's turn.
export function broadcast(screen, event) {
  if (event.type === 'turn') screen.status = event.text;
  if (event.type === 'message' && event.message.speaker === 'User') screen.status = null;
  for (const res of screen.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Sends a last event to every open screen and closes their streams; resolves once it has gone out
// (or after a second), so the process can exit without dropping it.
export function endAll(screen, event) {
  const sent = [...screen.clients].map((res) => new Promise((done) => {
    res.end(`data: ${JSON.stringify(event)}\n\n`, done);
  }));
  screen.clients.clear();
  return Promise.race([Promise.all(sent), new Promise((done) => setTimeout(done, 1000))]);
}

const SCREEN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>agent-room</title><style>
:root { color-scheme: light dark; --line: #8884; --dim: #888; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr; grid-template-columns: var(--left, 38%) 7px 1fr; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
/* The header: three zones, room (left), current discussion (middle), server and monitoring (right).
   Rare room and server actions sit in the ▾ menus; the gauges never shrink. */
#header { grid-column: 1 / -1; display: grid; grid-template-columns: fit-content(20rem) minmax(16rem, 1fr) auto; gap: .5rem .8rem; align-items: center; padding: .4rem .8rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
.zone { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; border: 1.5px solid var(--zone); border-radius: 6px; padding: .3rem .6rem; align-self: stretch; justify-content: center; }
#room-zone { --zone: #5a7bd8; } #disc-zone { --zone: #4caf7a; } #server-zone { --zone: #d6a84c; }
/* Details shown on hover or keyboard focus of the room name and of "Server" (not while their menu is open). */
.hover-detail { display: none; position: absolute; top: 100%; left: 0; z-index: 11; flex-direction: column; gap: .1rem; width: max-content; max-width: min(26rem, 80vw); padding: .4rem .6rem; border: 1px solid var(--zone); border-radius: 6px; background: Canvas; box-shadow: 0 6px 20px #0004; font-size: .7rem; color: var(--dim); overflow-wrap: anywhere; }
/* No gap under the trigger, and it stays while hovered, so the version's own tooltip can be reached. */
.menu:not([open]):is(:hover, :has(> summary:focus-visible)) + .hover-detail:not(:empty), .hover-detail:not(:empty):hover { display: flex; }
#room-zone .zone-line, #server-head { position: relative; display: block; } /* the details hang right under their trigger */
.zone-line { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .5rem; min-width: 0; max-width: 100%; }
.zone button { font-size: .75rem; white-space: nowrap; }
.menu { position: relative; }
.menu > summary { list-style: none; cursor: pointer; border-radius: 6px; padding: .05rem .3rem; margin-left: -.3rem; white-space: nowrap; }
.menu > summary::-webkit-details-marker { display: none; }
.menu > summary::after { content: ' ▾'; color: light-dark(#555, #ccc); font-size: .85rem; }
.menu > summary:hover, .menu[open] > summary { background: #8882; }
.menu > summary b { font-size: .85rem; letter-spacing: -.02em; }
.menu-items { position: absolute; top: calc(100% + .25rem); left: -.3rem; z-index: 10; min-width: 13rem; display: flex; flex-direction: column; padding: .3rem; border: 1px solid var(--line); border-radius: 8px; background: Canvas; box-shadow: 0 6px 20px #0004; }
.menu-items button { border: 0; background: none; text-align: left; font-size: .85rem; padding: .3rem .6rem; border-radius: 4px; }
.menu-items button:hover { background: #8882; }
.menu-items .danger { color: #ef4444; }
.menu-items hr { width: 100%; border: 0; border-top: 1px solid var(--line); margin: .25rem 0; }
#disc-zone { flex-direction: row; align-items: center; gap: .3rem .5rem; justify-content: flex-start; }
#disc-text { flex: 0 1 auto; min-width: 5rem; display: flex; flex-direction: column; overflow-wrap: anywhere; }
#disc-heading { display: flex; align-items: baseline; gap: .15rem; min-width: 0; }
#disc { min-width: 0; }
#actions-menu, #auto-controls { flex: none; }
#disc-status { font-size: .7rem; color: var(--dim); line-height: 1.35; }
#actions-menu > summary { padding: .15rem .3rem; margin-left: 0; }
#actions-menu > summary::after { content: '▾'; }
#actions-menu[hidden] { display: none; }
#auto-controls { display: inline-flex; gap: .3rem; align-items: center; color: var(--dim); font-size: .75rem; white-space: nowrap; }
#new-discussion { display: contents; }
#new-discussion[hidden] { display: none; }
#server-zone { flex-direction: row; align-items: center; gap: .5rem; }
#server-box { flex: none; display: flex; flex-direction: column; align-items: flex-start; }
/* Under "● Server": some replication peer is unreachable (as in Peers…). Amber; red stays the server's. */
#peer-warning { border: 0; background: none; padding: 0 .2rem; margin-left: -.2rem; font-size: .8rem; line-height: 1.1; color: light-dark(#92600a, #d6a84c); }
#peer-warning[hidden] { display: none; }
#server-details { flex-direction: column; }
/* The gauges' own children join this grid, so "updated" sits above Usage, as in the drawing. */
#monitor { display: grid; grid-template-rows: auto auto; align-items: center; gap: .1rem .5rem; flex: none; font-size: .65rem; color: var(--dim); }
#gauges .quota { grid-row: 1 / span 2; }
#gauges .updated { grid-row: 1; align-self: end; }
#usage { grid-row: 2; justify-self: start; }
#gauges .quota + .updated, #monitor:has(.quota) #usage { grid-column: 2; }
#gauges .quota + .quota + .updated, #monitor:has(.quota + .quota) #usage { grid-column: 3; }
/* Without gauges (meter not reachable), the message, its time and Usage share one line. */
#monitor:not(:has(.quota)) { display: flex; align-items: center; gap: .3rem .8rem; white-space: nowrap; }
#monitor:not(:has(.quota)) .updated { align-self: center; }
#ask { max-width: min(32rem, 90vw); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.2rem; }
#ask::backdrop, #peers::backdrop { background: #0006; }
#peers { width: min(40rem, 90vw); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.2rem; }
#peers h3 { color: var(--dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 .5rem; }
#peers-buttons { display: flex; justify-content: flex-end; margin-top: 1rem; }
#ask-text { margin: 0 0 1rem; overflow-wrap: anywhere; }
#ask-buttons { display: flex; justify-content: flex-end; gap: .5rem; }
#rooms { max-width: min(28rem, 80vw); font: inherit; font-size: .75rem; }
#folder { font-family: ui-monospace, monospace; font-size: .75rem; overflow-wrap: anywhere; line-height: 1.35; }
#disc { font-size: .75rem; color: var(--dim); line-height: 1.35; }
#disc[data-active="true"] { color: #60a5fa; font-weight: 600; }
#code { font-size: .7rem; color: var(--dim); font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
#winfo { font-size: .75rem; color: var(--dim); padding: .4rem .8rem; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: .2rem; }
#winfo:empty { display: none; }
#winfo .error { color: #ef4444; }
#winfo code { font-size: .7rem; overflow-wrap: anywhere; user-select: all; }
#winfo button { align-self: flex-start; font-size: .75rem; margin-top: .2rem; }
#server { max-width: 100%; font-size: .75rem; color: light-dark(#92600a, #d6a84c); display: inline-flex; align-items: center; gap: .4rem; }
#server[data-state="down"] { color: #ef4444; font-weight: 600; }
#beat { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
#server[data-state="up"] #beat { background: #22c55e; } #server[data-state="down"] #beat { background: #ef4444; }
#beat.on { animation: beat 1.2s ease-out; } /* restarted on every answer, so each pulse is a real heartbeat */
@keyframes beat { 0% { transform: scale(1.4); box-shadow: 0 0 0 0 #22c55eaa; } 100% { transform: scale(1); box-shadow: 0 0 0 8px #22c55e00; } }
@media (prefers-reduced-motion: reduce) { #beat.on { animation: none; } }
#gauges .updated { white-space: nowrap; }
#files .hint { display: block; margin: 0 0 .8rem; }
#gauges { display: contents; }
.gauge { display: grid; grid-template-columns: 1.2rem 32px 1.8rem auto; gap: .2rem; align-items: center; line-height: 1.5; }
.quota { display: grid; grid-template-columns: auto 1fr; gap: .05rem .35rem; align-items: center; border-left: 1px solid var(--line); padding-left: .5rem; }
.gauge .bar { width: 32px; height: 6px; border-radius: 3px; background: #8883; overflow: hidden; }
.gauge .bar i { display: block; height: 100%; background: #10b981; }
.gauge.warn { color: #eab308; } .gauge.warn .bar i { background: #eab308; }
.gauge.high { color: #ef4444; font-weight: 600; } .gauge.high .bar i { background: #ef4444; }
.quota b { color: CanvasText; font-weight: 600; grid-column: 1; grid-row: 1 / span 2; text-transform: capitalize; font-size: .7rem; }
.quota .gauge { grid-column: 2; }
.gauge .resets { opacity: .8; white-space: nowrap; }
@media (max-width: 1150px) {
  #header { grid-template-columns: fit-content(20rem) minmax(0, 1fr); gap: .4rem .8rem; }
  #server-zone { grid-column: 1 / -1; grid-row: 2; justify-content: space-between; flex-wrap: wrap; width: 100%; }
}
@media (max-width: 600px) {
  #header { grid-template-columns: 1fr; }
  #disc-zone { grid-row: 2; }
  #server-zone { grid-row: 3; }
  .quota { padding-left: .5rem; }
}
.discussion-lines { margin: .4rem 0; min-width: 0; flex: 1; }
.discussion-lines > summary { cursor: pointer; padding: .4rem 0; overflow-wrap: anywhere; }
.line-row { padding: .35rem .5rem .35rem 1rem; display: flex; gap: .6rem; align-items: center; justify-content: space-between; font-size: .85rem; }
.line-row span { overflow-wrap: anywhere; }
.peer-row { padding: .35rem 0; font-size: .85rem; overflow-wrap: anywhere; }
.peer-dot { color: #888; } .peer-dot.up { color: #22c55e; } .peer-dot.down { color: #ef4444; }
/* Auto dev: its Start control in the latest agreed summary, and the run's line above the message box. */
.autodev-offer { display: flex; gap: .6rem; align-items: center; margin: .5rem 0; font-size: .8rem; color: var(--dim); }
.autodev-offer button, #autodev button { background: #2f6fde; color: #fff; border-color: #2f6fde; font-weight: 600; white-space: nowrap; }
#autodev { margin-bottom: .5rem; padding: .4rem .6rem; border-radius: 8px; font-size: .85rem; border: 1px solid #3a9a52; background: #3a9a5218; }
#autodev.paused { border-color: #b08900; background: #b0890018; } #autodev .why, #autodev .hint { color: var(--dim); }
#autodev p { margin: .25rem 0; } #autodev .next { white-space: pre-wrap; max-height: 6rem; overflow-y: auto; }
.msg.report .who { color: #3a9a52; }
#remote-view { border-bottom: 1px solid var(--line); padding-bottom: .5rem; margin-bottom: .5rem; font-size: .85rem; }
#auto-controls[hidden] { display: none; }
#remote-view p { margin: .2rem 0; } #remote-view .local-activity { color: var(--dim); font-size: .75rem; }
.tools label { display: inline-flex; gap: .3rem; align-items: center; color: var(--dim); }
#left { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#tabs, #subtabs { display: flex; border-bottom: 1px solid var(--line); }
#subtabs { --accent: #3b82f6; --tint: #3b82f612; }
.tab:disabled { opacity: .45; cursor: default; }
.tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: .45rem .9rem; font-size: .9rem; }
.tab.on { border-bottom-color: #3b82f6; font-weight: 600; }
.tab.news::after { content: ' •'; color: #3b82f6; }
.view { flex: 1; display: flex; flex-direction: column; min-height: 0; } .view[hidden] { display: none; }
#split { cursor: col-resize; background: var(--line); background-clip: content-box; padding: 0 3px; touch-action: none; }
#split:hover, #split:focus-visible, body.resizing #split { background-color: #3b82f6; outline: none; }
body.resizing { cursor: col-resize; user-select: none; }
body.resizing iframe { pointer-events: none; } /* the document would swallow the drag */
.chat-wrap { position: relative; display: flex; flex: 1; min-height: 0; }
.chat { flex: 1; min-width: 0; overflow-y: auto; padding: 1rem; }
.scroll-end { position: absolute; right: 1rem; bottom: .6rem; width: 2rem; height: 2rem; padding: 0; border-radius: 50%; background: Canvas; color: CanvasText; box-shadow: 0 2px 8px #0004; }
.msg { margin: 0 0 .9rem; padding: .5rem .75rem; border-radius: 8px; background: #8881; }
.msg.user { background: #3b82f622; } .msg.error { background: #ef444422; }
.msg.summary { background: #10b98122; border-left: 3px solid #10b981; } .msg.summary.not-agreed { background: #f59e0b22; border-left-color: #f59e0b; }
.who { font-weight: 600; font-size: .85rem; margin-bottom: .2rem; } .who .meta { font-weight: 400; color: var(--dim); }
.msg p { margin: .3rem 0; } .msg pre { overflow-x: auto; } .msg img { max-width: 100%; }
.status { color: var(--dim); font-size: .85rem; margin: .4rem 0 .9rem; white-space: pre-wrap; }
.status.error { color: #ef4444; }
#system-messages { flex: none; border-top: 1px solid var(--line); padding: .35rem .6rem; font-size: .75rem; line-height: 1.4; min-height: calc(2.8em + .7rem + 1px); }
#system-messages .status { margin: 0; font-size: inherit; line-height: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer { border-top: 1px solid var(--line); padding: .6rem; }
.box { width: 100%; min-height: 3.2rem; resize: vertical; font: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid var(--line); }
.tools { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; font-size: .85rem; }
.hint { color: var(--dim); flex: 1; }
button { font: inherit; font-size: .85rem; padding: .2rem .6rem; border-radius: 6px; border: 1px solid var(--line); background: #8882; cursor: pointer; }
#right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#bar { display: flex; gap: .6rem; align-items: center; padding: .4rem .6rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#current { color: var(--dim); } #feed { margin-left: auto; }
#siblings { max-height: 60vh; overflow-y: auto; } #siblings .shown { font-weight: 600; }
#pane, #docpane { flex: 1; min-height: 0; }
#pane { overflow-y: auto; }
#doc { border: 0; width: 100%; height: 100%; }
.empty { display: grid; place-items: center; color: var(--dim); height: 100%; padding: 1rem; text-align: center; }
#files { padding: 1rem; }
#files .entry { display: block; width: 100%; text-align: left; margin: 0; padding: .3rem .5rem; border: 0; border-radius: 4px; background: none; font-size: .9rem; }
#files .entry:hover { background: #8882; }
#files .entry::before { display: inline-block; width: 1.5em; }
#files .entry.folder::before { content: '📁'; } #files .entry.file::before { content: '📄'; } #files .entry.discussion::before { content: '💬'; }
#files .entry .tag { color: var(--dim); font-size: .8rem; margin-left: .5rem; }
#files .back { border: 0; background: none; padding: 0; color: var(--dim); font-size: .85rem; margin: 0 0 .4rem; }
#files .back:hover { color: CanvasText; text-decoration: underline; }
#files .title { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
#files .status { font-size: .75rem; font-weight: 400; padding: .05rem .45rem; border-radius: 9px; background: #8883; margin-left: .5rem; vertical-align: middle; }
#files .status.archive { background: #8882; } #files .status.deferred { background: #eab30833; } #files .status.inuse { background: #3b82f633; }
#files .actions { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 1rem; padding: 0 0 .8rem; border-bottom: 1px solid var(--line); }
#files .actions .primary { background: #3b82f6; border-color: #3b82f6; color: white; }
#files .row { display: flex; align-items: center; gap: .3rem; }
#files .row .entry { flex: 1; min-width: 0; }
#files button.archiving::before { content: ""; display: inline-block; width: .65em; height: .65em; margin-right: .35em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: archive-spin .7s linear infinite; }
@keyframes archive-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #files button.archiving::before { animation: none; } }
#files .row .reopen { font-size: .75rem; padding: .1rem .5rem; }
#files .discussion-row { align-items: baseline; flex-wrap: wrap; }
#files .discussion-row > .discussion-lines { flex-basis: 14rem; }
#files .discussion-row.in-use { background: #3b82f614; box-shadow: inset 3px 0 #60a5fa; border-radius: 4px; padding-left: .5rem; }
.inline-folder { margin-left: 1rem; }
.inline-folder > summary { cursor: pointer; padding: .3rem; }
.local-label { color: var(--dim); font-size: .8rem; margin: .3rem 0; }
.discussion-info { position: relative; display: inline-block; }
.discussion-info > button { border: 0; background: none; color: #8fa8ee; padding: .15rem; }
.info-detail { display: none; position: absolute; right: 0; top: 100%; z-index: 5; width: 15rem; padding: .5rem; background: Canvas; color: CanvasText; border: 1px solid var(--line); border-radius: 4px; font-size: .8rem; }
.discussion-info:hover .info-detail, .discussion-info:focus-within .info-detail { display: block; }
#files .actions .sep { width: 1px; align-self: stretch; background: var(--line); margin: 0 .3rem; }
#files h3 { color: var(--dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; margin: .9rem 0 .3rem; }
#talk, #tab-talk { --accent: #3b82f6; --tint: #3b82f612; }
#work, #tab-work { --accent: #a855f7; --tint: #a855f712; }
.tab.on { border-bottom-color: var(--accent); background: var(--tint); }
.tab.news::after { color: var(--accent); }
#header, #bar { background: #88808; }
.agent-settings { border-bottom: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--tint); padding: .5rem .8rem; max-height: 45%; overflow-y: auto; flex-shrink: 0; }
.agent-settings summary { cursor: pointer; font-weight: 600; font-size: .85rem; }
.settings-hint, .settings-status { font-size: .8rem; margin: .5rem 0; }
.settings-hint { color: var(--dim); }
.agent-row { display: flex; flex-wrap: wrap; gap: .5rem; padding: .6rem; margin: .6rem 0; border: 1px solid var(--line); border-left: 3px solid var(--provider); border-radius: 6px; background: Canvas; }
.agent-row[data-provider="claude"] { --provider: #d97706; }
.agent-row[data-provider="codex"] { --provider: #10b981; }
.agent-row label { display: flex; flex-direction: column; font-size: .8rem; flex: 1; min-width: 100px; }
.agent-row label[hidden] { display: none; }
.agent-row input, .agent-row select { font: inherit; padding: .3rem; width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 4px; }
#work .box:focus, #talk .box:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.msg { border-left: 3px solid #14b8a6; }
.msg.user { border-left-color: #3b82f6; }
#wchat .msg:not(.user):not(.error) { border-left-color: #a855f7; background: #a855f712; }
.msg.error { border-left-color: #ef4444; }
.tools { flex-wrap: wrap; }
</style></head><body>
<header id="header">
<div id="room-zone" class="zone" aria-label="Room"><div class="zone-line"><details class="menu" id="room-menu"><summary><b>agent-room</b></summary><div class="menu-items"><button id="switchroom">Switch room…</button><button id="newroom" title="Choose a folder and open its room in a new window, creating one there if you confirm. This room keeps running.">Open room in folder…</button><button id="peers-open" hidden title="Replication peers: reachability and pairing">Peers…</button><hr><button id="quit" class="danger" title="End this room only: its agents and worker stop. The server's other rooms keep running.">Quit room</button></div></details><span id="replica-header" class="hover-detail" role="tooltip"></span></div><span id="folder" title="The room's root folder"></span><select id="rooms" aria-label="Running rooms" hidden></select><dialog id="ask"><p id="ask-text"></p><div id="ask-buttons"></div></dialog><dialog id="peers"><div id="peers-list"></div><div id="peers-buttons"><button id="peers-close">Close</button></div></dialog></div>
<div id="disc-zone" class="zone" aria-label="Current discussion"><div id="disc-text"><div id="disc-heading"><span id="disc" title="The active discussion"></span><details class="menu" id="actions-menu"><summary aria-label="Discussion actions" title="Actions"></summary><div class="menu-items"><button id="pause-discussion" hidden>Pause discussion</button><button id="summary">Summarize</button><span id="new-discussion" hidden><hr><button id="newdisc" title="End this session: the chat clears and your next message starts a new discussion. The worker carries on.">New discussion</button><button id="newbrainstorm" title="A conversation with the same agents, kept only in memory: no folder, transcript or notes. It ends this session; Restart or Quit room loses it, and a new one replaces it.">New brainstorm</button></span></div></details></div><span id="disc-status" aria-live="polite"></span></div><label id="auto-controls" title="After every round in which an agent spoke, the agents agree a short summary"><input type="checkbox" id="auto"> Auto-summarize</label></div>
<div id="server-zone" class="zone" aria-label="Server and monitoring"><div id="server-box"><span id="server-head"><details class="menu" id="server-menu"><summary><span id="server"><i id="beat"></i>Server</span></summary><div class="menu-items"><button id="reload">Reload</button><button id="restart" title="Start a new server on this address, with every room, each in its discussion in use, from its handoff. The chats clear.">Restart</button><hr><button id="shutdown" class="danger" title="End every room on this server, then the server.">Shutdown server</button></div></details><span id="server-details" class="hover-detail" role="tooltip"><span id="server-text">Connecting to the server…</span><span id="code"></span></span></span><button id="peer-warning" hidden>⚠</button></div><div id="monitor"><span id="gauges" aria-label="Subscription usage"></span><button id="usage">Usage</button></div></div>
</header>
<div id="left">
  <div id="tabs" role="tablist"><button class="tab on" id="tab-talk" role="tab">Discussion</button><button class="tab" id="tab-work" role="tab">Worker</button></div>
  <div class="view" id="talk">
    <details class="agent-settings" id="talk-settings">
      <summary>Discussion agents · provider & model</summary>
      <form id="talk-settings-form">
        <p class="settings-hint" id="talk-settings-hint"></p>
        <div id="talk-agent-rows"></div>
        <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
        <p class="settings-status" id="talk-settings-status" role="status"></p>
      </form>
    </details>
    <div class="chat-wrap"><div class="chat" id="chat"></div><button class="scroll-end" id="talk-end" aria-label="Scroll to latest discussion messages" title="Scroll to latest messages" hidden>↓</button></div>
    <div class="composer" id="composer">
      <div id="remote-view" hidden></div>
      <div id="autodev" role="status" hidden></div>
      <textarea class="box" id="box" placeholder="Message the agents (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown"></textarea>
    </div>
  </div>
  <div class="view" id="work" hidden>
    <details class="agent-settings" id="work-settings">
      <summary>Worker · provider & model</summary>
      <form id="work-settings-form">
        <p class="settings-hint" id="work-settings-hint"></p>
        <div id="work-agent-rows"></div>
        <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
        <p class="settings-status" id="work-settings-status" role="status"></p>
      </form>
    </details>
    <div id="winfo" aria-live="polite"></div>
    <div class="chat-wrap"><div class="chat" id="wchat"></div><button class="scroll-end" id="work-end" aria-label="Scroll to latest worker messages" title="Scroll to latest messages" hidden>↓</button></div>
    <div class="composer" id="wcomposer">
      <textarea class="box" id="wbox" placeholder="Instructions for the worker (Enter sends, Shift+Enter for a new line). It sees only what you send here; it can edit files and run commands."></textarea>
      <div class="tools"><span class="hint" id="whint"></span></div>
    </div>
  </div>
  <div id="system-messages" role="log" aria-label="System messages" aria-live="polite" aria-relevant="additions"></div>
</div>
<div id="split" role="separator" aria-orientation="vertical" aria-label="Resize the chat and the document" tabindex="0" title="Drag to resize"></div>
<div id="right">
  <div id="subtabs" role="tablist"><button class="tab on" id="tab-explorer" role="tab">Explorer</button><button class="tab" id="tab-document" role="tab" disabled title="Choose a file in Explorer">Document</button></div>
  <div class="view" id="explorer"><div id="pane"></div></div>
  <div class="view" id="document" hidden>
    <div id="bar"><details class="menu" id="doc-menu"><summary title="Other files in this folder"><span id="current">No document shown.</span></summary><div class="menu-items" id="siblings"></div></details><button id="feed" hidden title="Ask the agents to read this transcript in full">Send to agents</button></div>
    <div id="docpane"></div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pane = $('pane'), docpane = $('docpane'), box = $('box'), wbox = $('wbox');
let replica = null, replicaOff = null, viewing = null, localMessages = [], localInput = true, localThinking = null, yourTurn = false, localWorking = null, viewExpired = false, viewNotice = null;
// crypto.randomUUID exists only in secure contexts (HTTPS or localhost); over plain HTTP from another machine, use random bytes.
const viewClient = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
let ended = false, doc = null, tab = 'talk', page = null;
// Refreshing the page keeps what was being typed in the two message boxes.
function refreshPage() {
  sessionStorage.setItem('drafts', JSON.stringify([box.value, wbox.value]));
  location.reload();
}
try { [box.value, wbox.value] = JSON.parse(sessionStorage.getItem('drafts')) ?? ['', '']; } catch {}
sessionStorage.removeItem('drafts');

// A chat list that keeps its "is thinking" line last and follows new messages when already at the bottom.
function makeChat(list, endButton) {
  let thinking = null;
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const updateEnd = () => { endButton.hidden = atBottom(); };
  list.addEventListener('scroll', updateEnd);
  new ResizeObserver(updateEnd).observe(list);
  endButton.onclick = () => list.scrollTo({ top: list.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  const add = (el) => { const stick = atBottom(); list.insertBefore(el, thinking); if (stick) list.scrollTop = list.scrollHeight; updateEnd(); };
  return {
    add,
    clear() { list.textContent = ''; thinking = null; updateEnd(); },
    think(text) {
      thinking?.remove(); thinking = null;
      if (!text) { updateEnd(); return; }
      thinking = document.createElement('div'); thinking.className = 'status'; thinking.textContent = text;
      const stick = atBottom(); list.append(thinking); if (stick) list.scrollTop = list.scrollHeight; updateEnd();
    },
  };
}
const talk = makeChat($('chat'), $('talk-end')), work = makeChat($('wchat'), $('work-end'));
function bubble(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.speaker === 'User' || m.speaker === 'Relayed from discussion' ? ' user' : '') + (m.speaker === 'Worker report' ? ' report' : '') + (m.error ? ' error' : '')
    + (m.outcome ? ' summary' + (m.outcome === 'agreed' ? '' : ' not-agreed') : '');
  el.innerHTML = '<div class="who"></div>' + m.html;
  el.firstChild.textContent = m.speaker + (m.error ? ' — failed' : '');
  if (m.meta) { const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = ' · ' + m.meta; el.firstChild.append(meta); }
  return el;
}
function statusEl(text, error) { const el = document.createElement('div'); el.className = 'status' + (error ? ' error' : ''); el.textContent = text; return el; }

// The two tabs. A worker reply while the Discussion tab is shown marks the Worker tab.
function showTab(name) {
  tab = name;
  $('talk').hidden = name !== 'talk'; $('work').hidden = name !== 'work';
  $('tab-talk').classList.toggle('on', name === 'talk'); $('tab-work').classList.toggle('on', name === 'work');
  if (name === 'work') $('tab-work').classList.remove('news');
  updateReplicaView();
  (name === 'work' ? wbox : box).focus();
}
$('tab-talk').onclick = () => showTab('talk');
$('tab-work').onclick = () => showTab('work');
function workMessage(m, live) {
  if (m.note) return status(m.note, m.error, 'Worker'); // a marker (New discussion) or an error
  work.add(bubble(m));
  if (live && m.speaker !== 'User' && tab !== 'work') $('tab-work').classList.add('news');
}
// The Worker tab's line: its worktree, or why the worker is disabled.
function setWorkerInfo(info) {
  const el = $('winfo');
  el.replaceChildren();
  if (!info) return;
  for (const line of info.lines) { const p = document.createElement('div'); p.textContent = line; if (info.error || info.disabled) p.className = 'error'; el.append(p); }
  wbox.disabled = !!info.disabled;
  if (info.disabled) wbox.placeholder = info.lines[0];
}
function setWorking(name) {
  localWorking = name; updateReplicaView();
  $('whint').textContent = name ? 'The worker is busy: what you send now waits for it to finish.' : '';
  $('tab-work').textContent = name ? 'Worker …' : 'Worker';
}

// The divider between the chat and the document: drag it, or use ←/→ when it has focus. Neither
// side gets narrower than MIN. The width is kept in this browser, per address: rooms on the usual
// port (5566) share it.
const split = $('split'), MIN = 260, KEY = 'agent-room:left';
function setLeft(px) {
  const room = document.documentElement.clientWidth - split.offsetWidth; // no scrollbar, no divider
  const w = Math.round(Math.max(MIN, Math.min(room - MIN, px)));
  document.body.style.setProperty('--left', w + 'px');
  return w;
}
const keep = (w) => { try { localStorage.setItem(KEY, String(w)); } catch {} };
try { const saved = Number(localStorage.getItem(KEY)); if (saved) setLeft(saved); } catch {}
split.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  split.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const move = (ev) => setLeft(ev.clientX - 3);
  const stop = (ev) => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', stop);
    split.removeEventListener('pointercancel', stop);
    document.body.classList.remove('resizing');
    keep(setLeft(ev.clientX - 3));
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', stop);
  split.addEventListener('pointercancel', stop);
});
split.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  keep(setLeft($('left').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -24 : 24)));
});
// A narrower window must not squeeze one side below MIN.
window.addEventListener('resize', () => { if (document.body.style.getPropertyValue('--left')) setLeft($('left').getBoundingClientRect().width); });
function message(m) {
  localMessages.push(m);
  if (viewing) return;
  if (m.pass || m.hidden) return; // passes and summary turns are hidden, as in the terminal
  talk.add(bubble(m));
  if (m.outcome) renderAutoDev();
}
// Auto dev (see ui.mjs): Start beside the latest agreed summary's instruction, or why it can't be
// sent; while a run is going or paused, its line above the message box, with Restart when paused.
function renderAutoDev() {
  document.querySelectorAll('.autodev-offer').forEach((e) => e.remove());
  const a = room?.autoDev, el = $('autodev');
  el.hidden = true; el.replaceChildren(); el.className = '';
  if (!a || viewing || !localInput) return;
  const button = (label) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => send('/autodev'); return b; };
  const span = (text, cls) => { const e = document.createElement('span'); e.textContent = text; if (cls) e.className = cls; return e; };
  const para = (...parts) => { const p = document.createElement('p'); p.append(...parts); el.append(p); return p; };
  if (a.status === 'running') {
    el.hidden = false;
    para(span('Auto dev running · cycle ' + a.cycle + ' of ' + a.max + ' · ' + (a.waiting ? 'worker is working' : 'discussion is reviewing') + ' '), span('(typing a message pauses it)', 'hint'));
    return;
  }
  if (a.status === 'paused') {
    el.hidden = false; el.className = 'paused';
    para(span('Auto dev paused · '), span('reason: ' + a.reason, 'why'));
    if (a.offer?.text) {
      para(span('Next agreed instruction:', 'hint')); para(span(a.offer.text, 'next'));
      para(button('Restart auto dev (' + a.max + ' more)'), span(' Restarting grants another ' + a.max + ' worker cycles.', 'hint'));
    } else if (a.offer?.error) para(span("The latest agreed instruction can’t be sent: " + a.offer.error + '.', 'why'));
    return;
  }
  if (a.status === 'finished') { el.hidden = false; para(span('Auto dev finished. Review and merge worker/main yourself.')); }
  if (!a.offer) return;
  const summaries = [...$('chat').querySelectorAll('.msg.summary:not(.not-agreed)')];
  const target = summaries.at(-1);
  if (!target) return;
  const offer = document.createElement('div'); offer.className = 'autodev-offer';
  if (a.offer.text) offer.append(button('Start auto dev'), span('Sends this instruction as cycle 1 of up to ' + a.max + '. Auto-summarize is on for this run; your saved setting is unchanged.'));
  else offer.append(span("Auto dev can’t send this instruction: " + a.offer.error + '.'));
  // Right after the instruction: before the summary's next section (Later) or its Outcome line.
  const after = [...target.children].find((c) => /^(Later|Outcome:)/.test(c.textContent.trim()));
  target.insertBefore(offer, after ?? null);
}
function status(text, error, source) {
  if (!text) return;
  const hub = $('system-messages');
  const line = statusEl((source ? source + ' · ' : '') + text, error);
  line.title = line.textContent; // Long messages keep their full text on hover.
  hub.append(line);
  while (hub.children.length > 2) hub.firstChild.remove();
}
function setThinking(name) {
  localThinking = name; if (name) yourTurn = false; updateReplicaView();
  if (viewing) return;
  talk.think(name ? '… ' + name + ' is thinking' : null);
}
const urlFor = (file) => file.split('/').map(encodeURIComponent).join('/');
// The right pane's two subtabs. Each keeps its place while the other is shown: Explorer its folder
// and scroll position, Document its file and scroll position. Document needs a file.
function showSub(name) {
  if (name === 'document' && !doc) return;
  $('explorer').hidden = name !== 'explorer'; $('document').hidden = name !== 'document';
  $('tab-explorer').classList.toggle('on', name === 'explorer'); $('tab-document').classList.toggle('on', name === 'document');
}
$('tab-explorer').onclick = () => { showSub('explorer'); revealDoc(); };
// Back to Explorer with a local file shown: open the list where that file is and scroll it into
// view. Active discussions unfold in place; archive/ and deferred/ open the file's folder page.
// A received snapshot's files keep Explorer where it was.
async function revealDoc() {
  if (!doc || doc.startsWith('__received/') || viewing) return;
  const parts = doc.split('/');
  if (parts[0] === 'discussions' && SECTIONS[parts[1]] && parts.length > 3) await openFiles(parts.slice(0, -1).join('/'));
  else {
    if (parts[0] === 'discussions' && parts.length > 2)
      for (let i = 2; i < parts.length; i++) expandedLines.add(parts.slice(0, i).join('/'));
    await openFiles('');
  }
  requestAnimationFrame(() => [...pane.querySelectorAll('.entry.file')].find((b) => b.querySelector('.tag')?.textContent === 'shown')?.scrollIntoView({ block: 'center' }));
}
$('tab-document').onclick = () => showSub('document');
// A file chosen (here, on another page, or by the room) opens in Document, which comes to the front.
function showDoc(file) {
  const same = !!file && file === doc && !!docpane.firstChild;
  doc = file || null;
  // Send to agents, on a transcript of an earlier session (not this one): a normal message asking
  // the agents to read it as background; its old sessions are not resumed.
  const feed = $('feed');
  const p = doc ? doc.split('/') : [];
  const transcript = p.length >= 3 && p.length <= 5 && p[0] === 'discussions' && p.at(-2) === 'transcripts' && p.at(-1).endsWith('.md');
  feed.hidden = !transcript || !room || doc === room.transcript || !!viewing || $('composer').hidden;
  feed.onclick = () => {
    showTab('talk');
    const root = room.folder.endsWith('/') ? room.folder : room.folder + '/';
    send('Please read this transcript of an earlier session in full, as background for our discussion: ' + root + file);
  };
  $('current').textContent = doc ? doc.split('/').pop() : 'No document shown.';
  $('doc-menu').open = false;
  $('current').title = doc || ''; // the full path, on hover
  $('tab-document').disabled = !doc;
  if (!doc) { docpane.replaceChildren(); return showSub('explorer'); }
  if (!same) { docpane.innerHTML = '<iframe id="doc"></iframe>'; docpane.firstChild.src = urlFor(doc); }
  document.title = doc + ' · agent-room';
  showSub('document');
}
// The file name's ▾ menu: the shown file's siblings (files in its folder), to switch without Explorer.
// Local files open as from Explorer; a received snapshot's siblings come from that snapshot.
$('doc-menu').addEventListener('toggle', async () => {
  const box = $('siblings');
  if (!$('doc-menu').open) return;
  box.replaceChildren();
  if (!doc) return;
  const received = doc.startsWith('__received/');
  const prefix = received ? doc.split('/').slice(0, 4).join('/') + '/' : '';
  const rel = doc.slice(prefix.length), folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  let files = [];
  try {
    files = received ? (viewing ? await (await fetch('__rfiles?d=' + viewing.discussion + '&n=' + viewing.node + '&c=' + viewing.commit)).json() : [])
      : await (await fetch('__files')).json();
  } catch {}
  const siblings = files.filter((f) => f.startsWith(folder) && !f.slice(folder.length).includes('/')).sort();
  for (const f of siblings) {
    const b = document.createElement('button'); b.textContent = f.slice(folder.length);
    if (prefix + f === doc) b.className = 'shown';
    b.onclick = () => { closeMenus(); if (prefix + f === doc) return; if (received) showDoc(prefix + f); else post('__show', { file: f }); };
    box.append(b);
  }
  if (!siblings.length) box.textContent = 'No other files here.';
});
// Every two seconds, the shown file's modification time; a change reloads it in place (the browser
// keeps its scroll position where it can). Markdown pages poll themselves, and received snapshots
// never change. A missing file (being saved?) keeps showing and is asked about again.
let docStamp = null; // { file, t }: the shown file's last known modification time
setInterval(async () => {
  const shown = doc;
  if (!shown || viewing || shown.startsWith('__received/') || /\\.md$/i.test(shown)) return;
  let t;
  try { t = await (await fetch('__mtime?f=' + encodeURIComponent(shown), { cache: 'no-store' })).text(); } catch { return; }
  if (shown !== doc || t === 'false') return;
  if (docStamp?.file === shown && docStamp.t !== t) $('doc')?.contentWindow.location.reload();
  docStamp = { file: shown, t };
}, 2000);
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': viewClient }, body: JSON.stringify(body) });
// Each browser owns a leased View pin, independent of other browsers and local agents.
async function viewRemote(line) {
  const res = await post('__view', line ? { discussion: line.discussion, node: line.node } : { back: true });
  if (!res.ok) return status(await res.text(), true);
  viewing = (await res.json()).viewing;
  viewExpired = false; viewNotice = null;
  updateReplicaView();
  showDoc(null);
  talk.clear();
  if (viewing) {
    viewing.messages.forEach((m) => { if (!m.pass && !m.hidden) talk.add(bubble(m)); });
    await remoteFiles();
  } else {
    localMessages.forEach((m) => { if (!m.pass && !m.hidden) talk.add(bubble(m)); });
    setThinking(localThinking); openFiles();
  }
}
const receivedTime = (at) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
const peerActivity = (name) => {
  const p = replica?.peers.find((p) => p.name === name);
  if (!p) return 'unreachable (not configured)';
  return p?.reachable === false ? 'unreachable' + (p.since ? ' since ' + receivedTime(p.since) : '') : p?.activity || 'checking';
};
function updateReplicaHeader() {
  const el = $('replica-header');
  if (!el || !replica) { if (el) el.textContent = ''; return; }
  const r = replica, own = r.own[room?.active?.split('/').at(-1)];
  const project = r.project?.commit ? 'Project ' + r.project.commit + (r.project.dirty ? ' + uncommitted' : '') : 'Version unavailable';
  const line = viewing ? '[Viewing ' + viewing.node + "'s line, round " + viewing.round + ', received ' + receivedTime(viewing.receivedAt) + ' · read-only] · ' + viewing.node + ': ' + peerActivity(viewing.node)
    : r.node + "'s line" + (own ? ', round ' + own.round : ', no saved round') + ' · agents run on ' + r.node;
  el.textContent = r.node + ' ' + (r.addresses[0] || '127.0.0.1:' + location.port) + ' · ' + line + ' · ' + project;
}
// The status under the title, for the selected tab. While auto dev runs, the turn is not the User's.
function talkStatus() {
  if (tab === 'work') return localWorking ? localWorking + ' is working' : 'idle';
  if (!room) return '';
  if (viewing) return 'read-only';
  if (room.paused) return 'paused';
  if (localThinking) return localThinking + ' is thinking';
  if (room.autoDev?.status === 'running') return 'Auto dev running';
  return room.started && yourTurn ? 'your turn' : '';
}
function updateReplicaView() {
  updateReplicaHeader();
  renderAutoDev();
  if (room) { $('disc').textContent = viewing ? viewing.title : room.discussion; $('disc').dataset.active = !viewing && room.active ? 'true' : 'false'; }
  // Under the title, show the activity of the selected tab.
  $('disc-status').textContent = talkStatus();
  const panel = $('remote-view'); panel.hidden = !viewing; panel.replaceChildren();
  $('composer').hidden = !viewing && !localInput;
  $('pause-discussion').hidden = !room?.started || room.brainstorm || ended || !!viewing || !localInput;
  box.hidden = !!viewing;
  $('talk-settings').hidden = !!viewing;
  $('summary').hidden = !!viewing;
  $('auto').parentElement.hidden = !!viewing;
  $('reload').hidden = !!viewing;
  // New discussion (in the header): ends this session, as Re-open does; the next message starts the new one.
  // New brainstorm, beside it, is always offered (it ends a session or a brainstorm the same way).
  $('new-discussion').hidden = !(room && localInput && !viewing);
  $('newdisc').hidden = !(room?.active || room?.brainstorm);
  $('actions-menu').hidden = ['pause-discussion', 'summary', 'new-discussion'].every((id) => $(id).hidden);
  if (!viewing) return;
  const label = document.createElement('p');
  label.textContent = viewExpired ? 'View expired. Select the received line again.' : viewing.node + "'s line, round " + viewing.round + ', received ' + receivedTime(viewing.receivedAt) + '. Read-only.';
  panel.append(label);
  const local = document.createElement('p'); local.className = 'local-activity';
  local.textContent = 'Local ' + replica.node + ': ' + (localThinking ? localThinking + ' is thinking' : 'discussion idle') + ' · ' + (localWorking ? 'Worker ' + localWorking + ' is working' : 'worker idle'); panel.append(local);
  if (viewNotice) { const note = document.createElement('p'); note.className = 'local-activity'; note.textContent = 'Local status: ' + viewNotice; panel.append(note); }
  const own = Object.values(replica.own).find((l) => l.discussion === viewing.discussion);
  if (own) {
    const back = document.createElement('button'); back.textContent = 'Back to ' + replica.node + "'s line"; back.onclick = () => viewRemote(null); panel.append(back);
  }
  const latest = replica.received.find((l) => l.discussion === viewing.discussion && l.node === viewing.node);
  if (latest && latest.commit !== viewing.commit) {
    const newer = document.createElement('button'); newer.textContent = 'View newer received round ' + latest.round; newer.onclick = () => viewRemote(latest); panel.append(newer);
  }
}
async function remoteFiles() {
  if (!viewing) return;
  const v = viewing;
  const files = await (await fetch('__rfiles?d=' + v.discussion + '&n=' + v.node + '&c=' + v.commit)).json();
  pane.replaceChildren(); listed = null;
  const title = document.createElement('p'); title.textContent = v.node + ' · round ' + v.round + ' · received files'; pane.append(title);
  for (const f of files) {
    const b = document.createElement('button'); b.className = 'entry file'; b.textContent = f;
    b.onclick = () => showDoc('__received/' + v.discussion + '/' + v.node + '/' + v.commit + '/' + f); pane.append(b);
  }
}
function showReplica(r) {
  replica = r;
  updateReplicaView();
  if (listed !== null) openFiles(listed);
  $('peers-open').hidden = !replica && !replicaOff;
  const down = replica?.peers.filter((p) => p.reachable === false).length ?? 0, warning = $('peer-warning');
  warning.hidden = !down;
  warning.title = down + (down === 1 ? ' peer unreachable' : ' peers unreachable');
  warning.setAttribute('aria-label', warning.title);
  if ($('peers').open) showPeers();
}
// Peers… (room menu): the replication peers, with their reachability and Pair buttons.
function showPeers() {
  const list = $('peers-list');
  list.replaceChildren();
  appendPeers(list);
}
$('peers-open').onclick = () => { closeMenus(); showPeers(); $('peers').showModal(); };
$('peers-close').onclick = () => $('peers').close();
$('peer-warning').onclick = () => { showPeers(); $('peers').showModal(); };
function appendPeers(list) {
  if (!replica && replicaOff) {
    const title = document.createElement('h3'); title.textContent = 'Peers'; list.append(title);
    list.append(statusEl(replicaOff));
  }
  if (!replica) return;
  const title = document.createElement('h3'); title.textContent = 'Peers'; list.append(title);
  for (const peer of replica.peers) {
    const row = document.createElement('div'); row.className = 'peer-row';
    const dot = document.createElement('span'); dot.className = 'peer-dot ' + (peer.reachable === true ? 'up' : peer.reachable === false ? 'down' : ''); dot.textContent = '● '; row.append(dot);
    row.append(document.createTextNode(peer.name + ' · ' + peer.address + ' · ' + peerActivity(peer.name) + (peer.paired ? ' · paired' : ' · not paired')));
    if (!peer.paired) {
      const b = document.createElement('button'); b.textContent = 'Pair with ' + peer.name + '…';
      b.onclick = async () => {
        const check = await post('__pair', { peer: peer.name });
        if (!check.ok) return status(await check.text(), true);
        const x = await check.json();
        if (!confirm('Pair these room folders?\\n' + x.local.node + ': ' + x.local.root + '\\n' + x.peer.node + ': ' + x.peer.root)) return;
        const result = await post('__pair', { peer: peer.name, confirm: true });
        if (!result.ok) status(await result.text(), true);
      }; row.append(b);
    }
    row.append(document.createTextNode(' · project ' + (peer.project?.commit ? peer.project.commit + (peer.project.dirty ? '+' : '') : 'version unavailable')));
    if (peer.error) row.title = peer.error;
    list.append(row);
  }
}
setInterval(async () => { if (viewing) { try { const r = await post('__view', { renew: true }); if (!r.ok) { viewExpired = true; updateReplicaView(); } } catch {} } }, 30000);
// Discussions: the room's active discussions (newest first), then its own documents, then archive/
// and deferred/ (always shown, at the bottom), which hold whole discussions moved there. Open a
// discussion to see its documents, and its subfolders (drawings/, transcripts/, …) one level at a
// time. Looking is not switching: Re-open this discussion is a separate action, and Archive / Defer /
// Make active move the whole discussion. A discussion is a folder named <date>-<title> (as ui.mjs
// creates them); anything else directly in discussions/ is the room's own material (in agent-room
// itself: the index of its discussions).
const isDiscussion = (name) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name);
const SECTIONS = { archive: 'Archive', deferred: 'Deferred' };
// The discussion a list path shows, as /reopen and /move name it ("<name>" or "archive/<name>"), or null.
function discussionOf(parts) {
  if (parts.length === 2 && isDiscussion(parts[1])) return { ref: parts[1], section: null };
  if (parts.length === 3 && SECTIONS[parts[1]] && isDiscussion(parts[2])) return { ref: parts[1] + '/' + parts[2], section: parts[1] };
  return null;
}
const REOPEN_TIP = 'A fresh session in this discussion: the agents start from its handoff. Its documents and transcripts stay. Any saved Pause for this discussion is discarded.';
// Re-open and New discussion: once this session has started, they end it (the chat clears), so they
// take two clicks, like Quit. ask: when the first click only asks (by default, as said above).
function confirmed(b, run, warning, ask = () => room?.started || warning) {
  const label = b.textContent;
  b.onclick = (e) => {
    e.stopPropagation();
    if (ask() && !b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = warning || 'Click again: this session ends and the chat clears';
      return setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
    }
    run();
  };
}
// Resume: during a brainstorm with messages it discards them, so it takes two clicks.
function resumeButton(b, name) {
  confirmed(b, () => send('/resume ' + name), 'Click again: the brainstorm will be discarded', () => !!room?.brainstorm && localMessages.length > 0);
}
const pendingArchives = new Set();
function archiveButton(b, ref) {
  const pending = pendingArchives.has('discussions/' + ref);
  b.classList.toggle('archiving', pending);
  b.setAttribute('aria-busy', String(pending));
  if (pending) b.disabled = true;
  b.onclick = async () => {
    if (ended) return;
    pendingArchives.add('discussions/' + ref);
    archiveButton(b, ref);
    try {
      const res = await post('__say', { text: '/move ' + ref + ' archive' });
      if (res.ok) return; // Accepted into the queue: keep spinning until the moved event.
      status(await res.text(), true);
    } catch (err) { status(err.message, true); }
    pendingArchives.delete('discussions/' + ref);
    if (listed !== null) openFiles(listed);
  };
}
const expandedLines = new Set();
let listed = null; // the list path shown in the pane ('' for the top), or null when a document is shown
async function openFiles(group) {
  if (typeof group !== 'string') group = ''; // as a click handler, group is the event
  const scroll = group === listed ? pane.scrollTop : 0; // drawn again in place: keep where you were
  listed = group;
  const files = await (await fetch('__files')).json();
  pane.innerHTML = '<div id="files"></div>';
  const list = pane.firstChild;
  requestAnimationFrame(() => { pane.scrollTop = scroll; });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  // A row in the list: a discussion, a folder or a file, with an optional grey tag after its name.
  const entry = (kind, label, onclick, tag, title) => {
    const b = el('button', 'entry ' + kind, label); b.onclick = onclick;
    if (tag) b.append(el('span', 'tag', tag));
    if (title) b.title = title;
    list.append(b);
  };
  const heading = (text) => list.append(el('h3', '', text));
  const storedDiscussionRow = (name, path, id = replica?.own[name]?.discussion) => {
    if (!replica) return entry('discussion', name, () => openFiles(path), path === room?.active ? 'in use' : '');
    const remote = replica.received.filter((l) => id ? l.discussion === id : l.local === name);
    const key = path || id;
    const details = el('details', 'discussion-lines');
    details.open = expandedLines.has(key);
    details.ontoggle = () => { if (details.open) expandedLines.add(key); else expandedLines.delete(key); };
    const summary = el('summary', '', '💬 ' + name + (path && path === room?.active ? ' · in use' : '')); details.append(summary);
    if (path) {
      const own = replica.own[name];
      const label = replica.node + ' (this node) · ' + (own ? 'round ' + own.round : 'no saved round') + (own ? Object.entries(own.sent).map(([n, sent]) => ' · ' + (sent ? 'sent to ' + n + ' ✓' : n + ' pending')).join('') : '');
      const b = el('button', 'entry', '● ' + label);
      b.onclick = async () => { if (viewing) await viewRemote(null); openFiles(path); }; details.append(b);
    }
    for (const line of remote) {
      const row = el('div', 'line-row'); row.append(el('span', '', '● ' + line.node + ' · round ' + line.round + ' · received ' + receivedTime(line.receivedAt) + ' · ' + line.node + ' ' + peerActivity(line.node)));
      const b = el('button', '', 'View'); b.onclick = () => viewRemote(line); row.append(b); details.append(row);
    }
    list.append(details);
  };
  const info = (text) => {
    const wrap = el('span', 'discussion-info');
    const b = el('button', '', 'ⓘ'); b.setAttribute('aria-label', text);
    wrap.append(b, el('span', 'info-detail', text)); return wrap;
  };
  const localFile = async (file) => {
    if (viewing) await viewRemote(null);
    if (!viewing) post('__show', { file });
  };
  const inlineFiles = (parent, path) => {
    const rel = files.filter((f) => f.startsWith(path + '/')).map((f) => f.slice(path.length + 1));
    const folders = [...new Set(rel.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
    for (const folder of folders) {
      const nested = el('details', 'inline-folder'), key = path + '/' + folder;
      nested.open = expandedLines.has(key);
      nested.ontoggle = () => { if (nested.open) expandedLines.add(key); else expandedLines.delete(key); };
      nested.append(el('summary', '', folder + '/')); inlineFiles(nested, key); parent.append(nested);
    }
    for (const name of rel.filter((f) => !f.includes('/'))) {
      const file = path + '/' + name, b = el('button', 'entry file', name);
      b.onclick = () => localFile(file);
      if (file === doc) b.append(el('span', 'tag', 'shown'));
      parent.append(b);
    }
    if (!rel.length) parent.append(el('span', 'hint', 'No files yet.'));
  };
  const receivedRow = (line, label) => {
    const row = el('div', 'line-row'); row.append(el('span', '', label));
    row.append(info(line.node + ' · round ' + line.round + ' · received ' + receivedTime(line.receivedAt) + ' · ' + line.node + ' ' + peerActivity(line.node)));
    const b = el('button', '', 'View'); b.onclick = () => viewRemote(line); row.append(b); return row;
  };
  const discussionRow = (name, path) => {
    // Archive/deferred retain their existing discussion pages and Make active action.
    if (!path.startsWith('discussions/') || path.split('/').length !== 2)
      return storedDiscussionRow(name, path);
    const own = replica?.own[name];
    const remote = replica?.received.filter((l) => own ? l.discussion === own.discussion : l.local === name) || [];
    const details = el('details', 'discussion-lines');
    details.open = expandedLines.has(path);
    details.ontoggle = () => { if (details.open) expandedLines.add(path); else expandedLines.delete(path); };
    details.append(el('summary', '', name + (path === room?.active ? ' · in use' : '')));
    const row = el('div', 'row discussion-row' + (path === room?.active ? ' in-use' : '')); row.append(details);
    const label = (replica?.node || 'Local') + ' (this node) · ' + (own ? 'round ' + own.round : 'no saved round') +
      (own ? Object.entries(own.sent).map(([n, sent]) => ' · ' + (sent ? 'sent to ' + n + ' ✓' : n + ' pending')).join('') : '');
    row.append(info(label));
    if (canAct) {
      const paused = room.pausedSessions?.some((p) => p.name === name);
      if (!(path === room.active && !room.started)) {
        const b = el('button', 'reopen', 'Re-open'); b.title = REOPEN_TIP;
        confirmed(b, () => send('/reopen ' + name), paused ? 'Click again: discard the saved Pause and start fresh' : null); row.append(b);
      }
      for (const [label, target] of [['Archive', 'archive'], ['Defer', 'deferred']]) {
        const b = el('button', 'reopen', label);
        b.disabled = path === room.active || paused;
        b.title = path === room.active ? 'The discussion in use cannot be moved' : paused ? 'Resume the paused discussion before moving it' : 'Move the whole discussion into ' + target + '/';
        b.onclick = () => send('/move ' + name + ' ' + target);
        if (target === 'archive') archiveButton(b, name);
        row.append(b);
      }
    }
    if (remote.length) details.append(el('div', 'local-label', 'Local · ' + (replica?.node || 'this node')));
    inlineFiles(details, path);
    for (const line of remote) details.append(receivedRow(line, 'Received · ' + line.node));
    list.append(row);
  };
  const inUse = (path) => path === room?.active;
  const discussionsIn = (prefix) => [...new Set(files.filter((f) => f.startsWith(prefix + '/'))
    .map((f) => f.slice(prefix.length + 1)).filter((r) => r.includes('/')).map((r) => r.split('/')[0]))]
    .filter(isDiscussion).sort((a, b) => b.localeCompare(a));
  const canAct = room && localInput && !viewing;
  const back = (label, to) => { const b = el('button', 'back', '← ' + label); b.onclick = () => openFiles(to); list.append(b); };
  const title = (text, status, cls) => { const t = el('div', 'title', text); if (status) t.append(el('span', 'status ' + (cls || ''), status)); list.append(t); };

  if (group === 'discussions/archive' || group === 'discussions/deferred') { // archive/ or deferred/: their discussions
    const section = group.split('/')[1];
    back('All discussions', '');
    title(section === 'archive' ? 'Archive' : 'Deferred');
    const found = discussionsIn(group);
    if (!found.length) list.append(el('span', 'hint', section === 'archive' ? 'No archived discussions.' : 'No deferred discussions.'));
    for (const d of found) discussionRow(d, group + '/' + d);
    return;
  }
  if (group) { // a discussion or one of its folders
    const parts = group.split('/');
    const disc = discussionOf(parts);
    const parent = parts.length > 2 ? parts.slice(0, -1).join('/') : '';
    back(parent ? (SECTIONS[parent.split('/')[1]] && parts.length === 3 ? SECTIONS[parent.split('/')[1]] : parts.at(-2) + '/') : 'All discussions', parent);
    if (disc) {
      const status = inUse(group) ? ['in use', 'inuse'] : disc.section ? [disc.section === 'archive' ? 'archived' : 'deferred', disc.section] : ['active', ''];
      title(parts.at(-1), status[0], status[1]);
    } else title(parts.slice(1).join('/'));
    if (disc && canAct) {
      // Actions, apart from the files: Re-open, then moving the whole discussion.
      const actions = el('div', 'actions');
      const action = (label, onclick, tip, cls) => { const b = el('button', cls || '', label); b.onclick = onclick; b.title = tip; actions.append(b); return b; };
      if (room.pausedSessions?.some((p) => p.name === disc.ref))
        resumeButton(action('Resume', null, 'Continue the saved agent sessions and chat'), disc.ref);
      // Re-open: not for the discussion in use before anything was said in it (nothing to restart).
      if (!(inUse(group) && !room.started)) {
        const b = action(disc.section ? 'Re-open (makes it active)' : 'Re-open', null, REOPEN_TIP, 'primary');
        confirmed(b, () => send('/reopen ' + disc.ref), room.pausedSessions?.some((p) => p.name === disc.ref) ? 'Click again: discard the saved Pause and start fresh' : null);
      }
      // Moving the whole discussion; not the one in use (its transcript is open there).
      if (!inUse(group)) {
        if (actions.children.length) actions.append(el('span', 'sep'));
        if (disc.section) action('Make active', () => send('/move ' + disc.ref + ' active'), 'Move it back to the active discussions');
        if (disc.section !== 'archive') archiveButton(action('Archive', null, 'Move the whole discussion into archive/'), disc.ref);
        if (disc.section !== 'deferred') action('Defer', () => send('/move ' + disc.ref + ' deferred'), 'Move the whole discussion into deferred/');
      }
      if (actions.children.length) list.append(actions);
    }
    const rel = files.filter((f) => f.startsWith(group + '/')).map((f) => f.slice(group.length + 1));
    const folders = [...new Set(rel.filter((r) => r.includes('/')).map((r) => r.split('/')[0]))].sort();
    const own = rel.filter((r) => !r.includes('/'));
    heading('Files');
    if (!folders.length && !own.length) list.append(el('span', 'hint', 'No files yet.'));
    for (const d of folders) entry('folder', d + '/', () => openFiles(group + '/' + d), '', 'Open this folder');
    for (const r of own) {
      const f = group + '/' + r;
      entry('file', r, () => post('__show', { file: f }), f === room?.transcript ? 'this session' : f === doc ? 'shown' : '');
    }
    return;
  }
  // The top: active discussions, the room's own documents, then archive/ and deferred/.
  // The discussion in use first; the others newest first.
  const active = room?.active?.startsWith('discussions/') ? room.active.slice('discussions/'.length) : null;
  const discussions = discussionsIn('discussions').sort((a, b) => (b === active) - (a === active));
  if (canAct && room.pausedSessions?.length) {
    heading('Paused on this machine');
    for (const saved of room.pausedSessions) {
      const row = el('div', 'row');
      row.append(el('span', '', saved.title));
      const resume = el('button', 'reopen', 'Resume');
      resume.title = 'Continue the saved discussion and worker sessions, including their chat';
      resumeButton(resume, saved.name);
      row.append(resume); list.append(row);
    }
  }
  if (room?.brainstorm && canAct) list.append(el('span', 'hint', 'A brainstorm is in progress: agent-room keeps no record of it. New discussion, Re-open or Resume ends it.'));
  else if (!discussions.length && !replica?.received.some((l) => !l.local)) list.append(el('span', 'hint', room?.started ? '' : 'No active discussions: your first message starts one.'));
  else if (room && !room.started && canAct) list.append(el('span', 'hint', 'Your first message starts a new discussion. To go back to one instead, choose Re-open on its row.'));
  heading('Discussions');
  for (const d of discussions) {
    const path = 'discussions/' + d;
    discussionRow(d, path);
  }
  if (replica) {
    const remoteOnly = replica.received.filter((l) => !l.local && !discussions.some((d) => replica.own[d]?.discussion === l.discussion));
    if (remoteOnly.length) heading('Received from peers · read-only');
    for (const line of remoteOnly) list.append(receivedRow(line, line.name + ' · ' + line.node));
  }
  const top = files.filter((f) => f.startsWith('discussions/')).map((f) => f.slice('discussions/'.length));
  const own = [...new Set(top.filter((r) => r.includes('/')).map((r) => r.split('/')[0]))].filter((n) => !isDiscussion(n) && !SECTIONS[n]).sort();
  const loose = top.filter((r) => !r.includes('/'));
  if (own.length || loose.length) {
    heading("This room's own documents");
    for (const d of own) entry('folder', d + '/', () => openFiles('discussions/' + d), '', 'Open this folder');
    for (const r of loose) entry('file', r, () => post('__show', { file: 'discussions/' + r }), 'discussions/' + r === doc ? 'shown' : '');
  }
  heading('Archive and deferred');
  for (const s of Object.keys(SECTIONS)) {
    const n = discussionsIn('discussions/' + s).length;
    entry('folder', s + '/', () => openFiles('discussions/' + s), n + (n === 1 ? ' discussion' : ' discussions'), s === 'archive' ? 'Finished discussions' : 'Postponed discussions');
  }
}
// The header: the room's full root path and its active discussion, if one has been selected.
let room = null;
function setRoom(r) {
  room = r;
  renderAutoDev();
  $('folder').textContent = r.folder;
  $('disc').textContent = r.discussion || '';
  const pause = $('pause-discussion');
  pause.hidden = !r.started || r.brainstorm || ended || viewing || $('composer').hidden;
  pause.textContent = r.paused ? 'Resume discussion' : 'Pause discussion';
  pause.title = r.paused ? 'Continue the saved provider sessions' : 'Wait for the round and worker tasks to finish, then save their sessions on this machine';
  pause.onclick = () => send(r.paused ? '/resume ' + r.active.slice('discussions/'.length) : '/pause');
  $('disc').dataset.active = r.active ? 'true' : 'false';
  showVersion(r.code);
  updateReplicaView();
}
// The version the server runs: the commit its checkout was at when it started, and at the last
// Reload, each with + for uncommitted changes. Snapshots taken then, never read live.
function showVersion(c) {
  const el = $('code');
  if (!c) { el.textContent = ''; el.title = ''; return; }
  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const full = (t) => new Date(t).toLocaleString();
  const at = (commit, dirty) => (commit ?? 'not in Git') + (dirty ? '+' : '');
  let text = at(c.commit, c.dirty) + (c.startedAt ? ' · started ' + hm(c.startedAt) : '');
  let title = 'Started ' + (c.startedAt ? full(c.startedAt) : '') + ' at ' + at(c.commit, c.dirty);
  if (c.reloaded) {
    text += ' · reloaded ' + hm(c.reloaded.at) + ' (' + at(c.reloaded.commit, c.reloaded.dirty) + ')';
    title += '\\nReloaded ' + full(c.reloaded.at) + ' at ' + at(c.reloaded.commit, c.reloaded.dirty);
  }
  title += '\\nCheckout: ' + c.path + (c.branch ? ' (' + c.branch + ')' : '') +
    '\\n+ means uncommitted changes (outside discussions/). These are snapshots of the checkout, taken at start and at the last Reload: after a Reload the process may run a mix of files from both.';
  el.textContent = text; el.title = title;
}
// Settings stay outside the conversation; saving never changes an active CLI session.
const settingsRows = {};
let settingsSave = Promise.resolve();
function agentRow(parent, a, models, title) {
  const row = document.createElement('div'); row.className = 'agent-row';
  const field = (text, el) => { const label = document.createElement('label'); label.textContent = title + ' ' + text; label.append(el); row.append(label); return el; };
  const name = field('name', document.createElement('input')); name.value = a.name; name.required = true;
  const provider = field('provider', document.createElement('select'));
  for (const p of ['claude', 'codex']) provider.add(new Option(p === 'claude' ? 'Claude' : 'Codex', p));
  provider.value = a.provider;
  const model = field('model', document.createElement('select'));
  const custom = field('custom model ID', document.createElement('input')); custom.placeholder = 'Model ID';
  function choices(value) {
    row.dataset.provider = provider.value;
    model.replaceChildren(new Option('CLI default', ''));
    for (const m of models[provider.value]) model.add(new Option(m.label, m.id));
    model.add(new Option('Custom…', '__custom'));
    model.value = [...model.options].some((o) => o.value === value) ? value : '__custom';
    custom.value = model.value === '__custom' ? value : ''; custom.parentElement.hidden = model.value !== '__custom';
  }
  choices(a.model);
  provider.onchange = () => choices('');
  model.onchange = () => { custom.parentElement.hidden = model.value !== '__custom'; };
  parent.append(row);
  return () => ({ name: name.value.trim(), provider: provider.value, model: model.value === '__custom' ? custom.value.trim() : model.value });
}
function selectedSettings(data) {
  return data.started && data.defaults ? data.defaults : data.settings;
}
for (const scope of ['talk', 'work']) {
  const panel = $(scope + '-settings'), form = $(scope + '-settings-form');
  const hint = $(scope + '-settings-hint'), result = $(scope + '-settings-status');
  panel.ontoggle = async () => {
    if (!panel.open) return;
    result.textContent = '';
    $(scope + '-agent-rows').replaceChildren();
    delete settingsRows[scope];
    try {
      await settingsSave;
      const res = await fetch('__settings');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json(), selected = selectedSettings(data);
      if (scope === 'work') selected.worker = data.settings.worker;
      const parent = $(scope + '-agent-rows'); parent.replaceChildren();
      const agents = scope === 'talk' ? selected.agents : [selected.worker];
      settingsRows[scope] = agents.map((a, i) => agentRow(parent, a, data.models, scope === 'talk' ? 'Agent ' + (i + 1) : 'Worker'));
      hint.textContent = scope === 'work' ? 'Changes apply to the next instruction. A running instruction finishes with its current settings. Switching provider carries the Worker conversation into a fresh session.' : data.started ? 'Changes save automatically for future rooms. Active sessions keep their settings.' : 'Changes save automatically and apply to this room before any agent starts.';
    } catch (err) { result.textContent = 'Could not load settings: ' + err.message; }
  };
  function saveChanges() {
    if (!settingsRows[scope]) return;
    // Choosing Custom opens its text field; persist once a model ID has been entered.
    if ([...form.querySelectorAll('.agent-row')].some((row) =>
      row.querySelectorAll('select')[1].value === '__custom' && !row.querySelectorAll('input')[1].value.trim())) {
      result.textContent = 'Enter a custom model ID to save this choice.';
      return;
    }
    const choices = settingsRows[scope].map((get) => get());
    result.textContent = 'Saving…';
    // Serialize saves from both tabs so a quick second change cannot overwrite a newer choice.
    settingsSave = settingsSave.then(async () => {
      const latest = await fetch('__settings');
      if (!latest.ok) throw new Error(await latest.text());
      const settings = selectedSettings(await latest.json());
      if (scope === 'talk') settings.agents = choices; else settings.worker = choices[0];
      const res = await post('__settings', settings);
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      result.textContent = scope === 'work' && saved.workerApplied ? 'Saved. Applies to the next worker instruction.' : saved.applied ? 'Saved.' : 'Saved for future rooms. This room keeps its settings.';
    }).catch((err) => { result.textContent = 'Could not save: ' + err.message; });
  }
  form.onchange = saveChanges;
  form.onsubmit = (e) => { e.preventDefault(); saveChanges(); };
}
// This server's rooms. Their addresses are paths on this page's host, so switching also works from
// another LAN device.
$('switchroom').onclick = async () => {
  const button = $('switchroom'), menu = $('rooms');
  button.disabled = true;
  try {
    const res = await fetch('__rooms');
    if (!res.ok) throw new Error(await res.text());
    const rooms = await res.json();
    menu.replaceChildren(new Option('Choose a running room…', ''));
    // The same rooms twice: switch this tab, or open a new window. A room with a page open
    // (on any device) is disabled in both, so the chooser doesn't open it twice.
    for (const [mode, heading] of [['tab', 'Switch this tab to'], ['window', 'Open in new window']]) {
      const group = document.createElement('optgroup');
      group.label = heading;
      for (const room of rooms) {
        const current = !!room.current;
        const open = !current && room.pages > 0;
        const pages = room.pages == null ? '' : ' · ' + room.pages + (room.pages === 1 ? ' page' : ' pages') + ' open';
        const label = room.root + ' · ' + (room.discussion || 'No discussion started') + pages + (current ? ' (current)' : open ? ' (open in another window)' : '');
        const option = new Option(label, mode + ':' + room.path);
        option.disabled = current || open;
        group.append(option);
      }
      menu.append(group);
    }
    menu.hidden = false;
    menu.focus();
    if (!rooms.some((r) => !r.current)) status('No other rooms are open on this server: Open room in folder… adds one.');
  } catch (err) { status('✗ Switch room: ' + err.message, true); }
  finally { button.disabled = false; }
};
$('rooms').onchange = () => {
  const menu = $('rooms'), at = menu.value.indexOf(':'), mode = menu.value.slice(0, at), path = menu.value.slice(at + 1);
  if (!path) return;
  const url = new URL(path, location.href);
  if (mode === 'tab') return location.assign(url.href);
  // Opened during the choice, so the browser doesn't block it; this window stays on its room.
  const win = window.open(url.href, '_blank', 'width=' + window.outerWidth + ',height=' + window.outerHeight);
  menu.value = '';
  menu.hidden = true;
  status(win ? 'Opened the room in a new window. This window stays on its room.' : 'The browser blocked the new window; open ' + url.href + ' yourself.', !win);
};
// A modal question drawn in the page. buttons: [label, act]; act runs inside the click (so it may
// open a window) and the promise resolves to what it returns (undefined for Escape or no act).
function ask(text, buttons) {
  const dialog = $('ask');
  $('ask-text').textContent = text;
  return new Promise((done) => {
    $('ask-buttons').replaceChildren(...buttons.map(([label, act]) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.onclick = () => { dialog.onclose = null; dialog.close(); done(act ? act() : undefined); };
      return button;
    }));
    dialog.onclose = () => done(undefined);
    dialog.showModal();
    $('ask-buttons').lastChild.focus();
  });
}
const newWindow = () => window.open('', '_blank', 'width=' + window.outerWidth + ',height=' + window.outerHeight);
// Open room in folder…: the server shows the Mac's folder chooser. A folder whose room exists opens
// it in a new window; one without a room is created only after the page has asked.
$('newroom').onclick = async () => {
  // Opened during the click, so the browser doesn't block it; pointed at the room below.
  let win = newWindow();
  if (win) win.document.body.textContent = 'Choose a folder in the window that has just opened…';
  let res = await post('__newroom', {});
  if (!res.ok) { win?.close(); return status('✗ Open room: ' + await res.text(), true); }
  let r = await res.json();
  if (r.cancelled) { win?.close(); return; }
  if (r.open) { win?.close(); return ask('The room in ' + r.folder + ' is already open in another window.', [['OK']]); }
  if (r.confirm) {
    win?.close();
    const chosen = await ask('Create a room in ' + r.folder + '?', [['Cancel'], ['Create room', () => ({ win: newWindow() })]]);
    if (!chosen) { post('__newroom', { token: r.token, cancel: true }).catch(() => {}); return; }
    win = chosen.win;
    if (win) win.document.body.textContent = 'Creating the room in ' + r.folder + '…';
    res = await post('__newroom', { token: r.token });
    if (!res.ok) { win?.close(); return status('✗ Open room: ' + await res.text(), true); }
    r = await res.json();
    if (r.open) { win?.close(); return ask('The room in ' + r.folder + ' is already open in another window.', [['OK']]); }
  }
  if (win) win.location = new URL(r.url, location.href).href;
  status((r.existing ? 'Opened the room already in ' : 'Opened a new room in ') + r.folder + (win ? '' : ' at ' + r.url + ' (the browser blocked the new window)') + '. This room keeps running.');
};
async function send(text) {
  text = text.trim();
  if (!text || ended) return;
  if (text === '/docs') { showSub('explorer'); return openFiles(); }
  const res = await post('__say', { text });
  if (res.status === 409 && ['/restart', '/shutdown'].includes(text)) {
    const warning = await res.text();
    if (confirm(warning)) {
      const retry = await post('__say', { text, confirmed: true });
      if (!retry.ok) status(await retry.text(), true);
    }
    return;
  }
  if (!res.ok) status(await res.text(), true);
}
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(box.value); box.value = ''; }
});
async function sendWork(text) {
  text = text.trim();
  if (!text || ended) return;
  const res = await post('__work', { text });
  if (!res.ok) status(await res.text(), true, 'Worker');
}
wbox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendWork(wbox.value); wbox.value = ''; }
});
// The header's quota gauges: one bar per window (5h, week) for each provider.
// at: { measured: the meter's own time for these values, checked: when the room last asked it }.
const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function quotaUpdated(at) {
  const el = document.createElement('span'); el.className = 'updated';
  const checked = at?.checked ? new Date(at.checked) : null;
  // The meter reports local time as "YYYY-MM-DD HH:MM:SS"; a day other than today is shown too.
  const m = /^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})/.exec(at?.measured ?? '');
  const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
  el.textContent = m ? 'updated ' + (m[1] === today ? '' : m[1] + ' ') + m[2] : checked ? 'checked ' + hhmm(checked) : '';
  el.title = (at?.measured ? 'Measured by the quota meter at ' + at.measured + '. ' : '') +
    (checked ? 'The room last asked the meter at ' + hhmm(checked) + ' (every minute, and after each turn).' : '');
  return el;
}
function showQuota(gauges, at) {
  const box = $('gauges');
  box.textContent = '';
  if (gauges === undefined) return; // not read yet
  if (gauges === null || !gauges.length) { box.textContent = 'quota meter not reachable'; box.append(' · ', quotaUpdated({ checked: at?.checked })); return; }
  let provider = null, group = null;
  for (const g of gauges) {
    if (g.provider !== provider) {
      provider = g.provider;
      group = document.createElement('span'); group.className = 'quota';
      group.innerHTML = '<b></b>'; group.firstChild.textContent = provider;
      box.append(group);
    }
    const el = document.createElement('span');
    // Highlighted by what is left: yellow under 30%, red under 10%.
    const left = 100 - g.used;
    el.className = 'gauge' + (left < 10 ? ' high' : left < 30 ? ' warn' : '');
    el.title = provider + ' ' + g.label + ': ' + g.used + '% used' + (g.resets ? ', at ' + g.resets : '');
    el.innerHTML = '<span></span><span class="bar"><i></i></span><span></span><span class="resets"></span>';
    el.children[0].textContent = g.label === 'week' ? 'wk' : g.label;
    el.children[1].firstChild.style.width = Math.min(100, Math.max(0, g.used)) + '%';
    el.children[2].textContent = g.used + '%';
    // The shared usage formatter supplies the local date and 24-hour time.
    if (g.resets) el.children[3].textContent = 'at ' + g.resets.split(' (')[0];
    group.append(el);
  }
  box.append(quotaUpdated(at));
}
$('auto').onchange = async (e) => {
  const res = await post('__auto', { on: e.target.checked });
  if (!res.ok) { status(await res.text(), true); e.target.checked = !e.target.checked; }
};
// The header's ▾ menus: one open at a time; a click outside or Escape closes them. Actions that
// open something else close their menu; the two-click ones keep it open for the second click.
const menus = [...document.querySelectorAll('details.menu')];
for (const m of menus) m.ontoggle = () => { if (m.open) menus.forEach((o) => { if (o !== m) o.open = false; }); };
const closeMenus = () => menus.forEach((m) => { m.open = false; });
document.addEventListener('click', (e) => { if (!e.target.closest('details.menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
for (const id of ['switchroom', 'newroom', 'reload', 'pause-discussion', 'summary']) $(id).addEventListener('click', closeMenus);
confirmed($('newdisc'), () => send('/new'));
confirmed($('newbrainstorm'), () => send('/brainstorm'));
$('summary').onclick = () => send('/summary');
$('usage').onclick = () => send('/usage');
$('reload').onclick = () => send('/reload');
// Two clicks to quit or shut down, so a stray click doesn't end anything.
$('quit').onclick = (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed) return send('/quit');
  b.dataset.armed = '1'; b.textContent = 'Click again to quit this room';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Quit room'; }, 3000);
};
$('shutdown').onclick = (e) => {
  const b = e.currentTarget;
  // The server's own address (as the Dock app's Quit uses), not this room's.
  if (b.dataset.armed) return post('/__shutdown', {}).then(async (res) => {
    if (res.status === 409) {
      if (confirm(await res.text())) {
        const retry = await post('/__shutdown?confirmed=yes', {});
        if (!retry.ok) status(await retry.text(), true);
      }
    } else if (!res.ok) status(await res.text(), true);
  });
  b.dataset.armed = '1'; b.textContent = 'Click again: every room ends';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Shutdown server'; }, 3000);
};
$('restart').onclick = (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed) return send('/restart');
  b.dataset.armed = '1'; b.textContent = 'Click again: the chat clears';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Restart'; }, 3000);
};
// The heartbeat: every 3 s the page asks the server how it is, and says so in the header. When a
// different server answers on this address (after Restart, or the Dock app starting it again), the
// page reloads, so it also gets that server's page code.
let serverPid = null, restarting = false;
const upFor = (t) => { const m = Math.max(0, Math.floor((Date.now() - Date.parse(t)) / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
async function heartbeat() {
  let h = null, gone = false;
  try {
    const res = await fetch('__health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.status === 404) gone = true; else h = await res.json();
  } catch {}
  const el = $('server'), text = $('server-text'), dot = $('beat');
  if (!h) {
    el.dataset.state = 'down';
    // 404: the server answers, but this room isn't on it (quit, or not brought back).
    text.textContent = gone ? 'This room is not open on the server' : restarting ? 'Restarting the server…' : ended ? 'Server stopped' : 'Server not responding';
    el.title = gone ? 'Open it again with Open room in folder… from another room.' : 'Start it again from the Dock app (or npm start): this page reloads when it answers.';
    return;
  }
  if (serverPid && h.pid !== serverPid) return refreshPage();
  serverPid = h.pid;
  el.dataset.state = 'up';
  dot.classList.remove('on'); void dot.offsetWidth; dot.classList.add('on'); // one pulse per answer
  text.textContent = 'Server up' + (h.startedAt ? ' ' + upFor(h.startedAt) : '') + ' · port ' + location.port;
  el.title = 'Process ' + h.pid + (h.startedAt ? ', started ' + new Date(h.startedAt).toLocaleString() : '');
}
heartbeat(); setInterval(heartbeat, 3000);
const events = new EventSource('__events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  // A reload that changed the page's code: refresh, so the page runs the new code too.
  if ((ev.type === 'reset' || ev.type === 'reloaded') && ev.page) {
    if (page && ev.page !== page) return refreshPage();
    page = ev.page;
  }
  if (ev.type === 'reset') {
    localMessages = []; localInput = ev.input;
    talk.clear();
    ev.messages.forEach(message);
    yourTurn = !ev.thinking; setThinking(ev.thinking); if (!viewing) { showDoc(ev.doc); openFiles(listed ?? ''); }
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
    work.clear();
    if (!ev.worker.length) work.add(statusEl('Give the worker instructions here. It works alongside the discussion and sees only what you send it.'));
    ev.worker.forEach((m) => workMessage(m, false));
    if (ev.status) status(ev.status);
    setWorking(ev.working);
    if (!ev.workInput) { $('wcomposer').hidden = true; }
    setWorkerInfo(ev.workerInfo);
    showQuota(ev.quota, ev.quotaAt);
    $('auto').checked = !!ev.auto;
    if (ev.room) setRoom(ev.room);
    $('newroom').hidden = !ev.newRoom;
    replicaOff = ev.replicaOff ?? null;
    showReplica(ev.replica);
  }
  if (ev.type === 'replica') showReplica(ev.replica);
  if (ev.type === 'room') { setRoom(ev.room); if (listed !== null) openFiles(listed); } // its buttons and "in use" follow
  if (ev.type === 'work') workMessage(ev.message, true);
  if (ev.type === 'quota') showQuota(ev.gauges, ev.at);
  if (ev.type === 'auto') $('auto').checked = ev.on;
  if (ev.type === 'working') setWorking(ev.name);
  if (ev.type === 'workerinfo') setWorkerInfo(ev.info);
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') { yourTurn = true; status(ev.text); updateReplicaView(); }
  if (ev.type === 'note') {
    status(ev.text, ev.error);
    if (ev.error && pendingArchives.size) {
      pendingArchives.clear();
      if (listed !== null) openFiles(listed);
    }
  }
  if (ev.type === 'doc' && !viewing) showDoc(ev.file);
  if (ev.type === 'files') { showSub('explorer'); openFiles(); }
  if (ev.type === 'moved') {
    pendingArchives.delete(ev.from);
    if (listed !== null) openFiles(listed === ev.from || listed.startsWith(ev.from + '/') ? ev.to + listed.slice(ev.from.length) : listed);
  }
  if (ev.type === 'ended') { ended = true; status('This room has ended. You can close this window.'); events.close(); box.disabled = true; wbox.disabled = true; }
  if (ev.type === 'restarting') { restarting = true; status('Restarting the server: this page reloads when the new one answers.'); events.close(); box.disabled = true; wbox.disabled = true; }
};
</script></body></html>`;

// Input endpoints accept only the page itself: same host, JSON. A page on another site can't send
// a JSON POST here without a CORS preflight, which this server never approves, and the Host check
// stops DNS-rebinding tricks. That matters because the agents act on what the User says.
// The room listens on the LAN too: this machine's own addresses and names count as its own host.
function ownHost(host) {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  const mine = ['127.0.0.1', 'localhost', hostname().toLowerCase(), `${hostname().toLowerCase().replace(/\.local$/, '')}.local`,
    ...Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4').map((i) => i.address)];
  return mine.includes(name);
}
export function fromOwnPage(req) {
  const host = req.headers.host ?? '';
  if (!ownHost(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  return (req.headers['content-type'] ?? '').startsWith('application/json');
}

function readJson(req, limit = 100_000) {
  return new Promise((done) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > limit) req.destroy(); });
    req.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
  });
}

// Serves the page, its event stream, the file list and the two inputs (say, show); returns false
// for any other path.
function handleScreen(req, res, url, dir, screen) {
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/__room') { send(200, 'text/html; charset=utf-8', SCREEN); return true; }
  // The heartbeat: the page and the Dock app ask every few seconds; a new pid means a new process.
  if (url.pathname === '/__health') {
    send(200, 'application/json', JSON.stringify({ app: 'agent-room', pid: process.pid, root: dir,
      startedAt: screen.startedAt ?? null, discussion: screen.room?.active ?? null, pages: screen.clients.size }));
    return true;
  }
  if (url.pathname === '/__rooms') {
    if (req.method !== 'GET') { send(405, 'text/plain', 'Use GET.'); return true; }
    if (!screen.listRooms) { send(409, 'text/plain', 'Room discovery is unavailable.'); return true; }
    screen.listRooms().then((rooms) => send(200, 'application/json', JSON.stringify(rooms)),
      (err) => send(500, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (url.pathname === '/__files') {
    let files = [];
    try { files = docFiles(dir, screen); } catch {} // no discussions/ yet
    send(200, 'application/json', JSON.stringify(files));
    return true;
  }
  if (url.pathname === '/__settings') {
    if (!screen.getSettings || !screen.saveSettings) { send(409, 'text/plain', 'Settings are unavailable in this room.'); return true; }
    if (req.method === 'GET') { send(200, 'application/json', JSON.stringify(screen.getSettings())); return true; }
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can save settings.'); return true; }
    readJson(req).then((body) => screen.saveSettings(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  // A received snapshot's files, while its line is open in View (or still its latest round).
  if (url.pathname === '/__rfiles') {
    const q = url.searchParams;
    send(200, 'application/json', JSON.stringify(screen.receivedFiles?.(q.get('d') ?? '', q.get('n') ?? '', q.get('c') ?? '') ?? []));
    return true;
  }
  if (['/__view', '/__pair'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can do this.'); return true; }
    const act = url.pathname === '/__view' ? screen.view : screen.pair;
    if (!act) { send(409, 'text/plain; charset=utf-8', 'This room doesn\'t replicate (start it with --node).'); return true; }
    readJson(req).then((body) => (url.pathname === '/__view' ? act({ ...body, client: req.headers['x-view-client'] }) : act(String(body?.peer ?? ''), !!body?.confirm))).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (['/__say', '/__show', '/__work', '/__auto', '/__newroom'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req).then((body) => {
      if (url.pathname === '/__newroom') {
        if (!screen.newRoom) return send(409, 'text/plain; charset=utf-8', 'This room can\'t open another one.');
        // {}: the chooser's answer; { token }: Create room for that answer (see newRoom in ui.mjs).
        return screen.newRoom(body ?? {}).then((r) => send(200, 'application/json', JSON.stringify(r)),
          (err) => send(err.status ?? 500, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__show') {
        const file = typeof body?.file === 'string' && servable(dir, body.file, screen) ? body.file : null;
        if (!file) return send(404, 'text/plain; charset=utf-8', 'No such document.');
        screen.doc = file;
        broadcast(screen, { type: 'doc', file });
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__auto') {
        if (!screen.setAuto) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal: use /autosummary there.');
        if (typeof body?.on !== 'boolean') return send(400, 'text/plain; charset=utf-8', 'Expected { on: true | false }.');
        screen.setAuto(body.on);
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__work') {
        if (!screen.work) return send(409, 'text/plain; charset=utf-8', 'This room has no worker input; the page only watches.');
        if (typeof body?.text !== 'string' || !body.text.trim()) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
        screen.work(body.text.trim());
        return send(204, 'text/plain', '');
      }
      if (!screen.say) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal; the page only watches.');
      if (typeof body?.text !== 'string' || !body.text.trim()) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
      // While another node's line is open in View, it is read-only: only these commands pass.
      if (screen.isViewing?.(req.headers['x-view-client']) && !VIEW_COMMANDS.includes(body.text.trim())) return send(409, 'text/plain; charset=utf-8', `Read-only: you are viewing a received line. Go back to this node's line first.`);
      const warning = screen.say(body.text.trim(), body.confirmed === true);
      if (typeof warning === 'string') return send(409, 'text/plain; charset=utf-8', warning);
      send(204, 'text/plain', '');
    });
    return true;
  }
  if (url.pathname !== '/__events') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  screen.clients.add(res);
  req.on('close', () => screen.clients.delete(res));
  // A page that (re)connects first gets everything so far, so it never shows a partial room.
  res.write(`data: ${JSON.stringify(resetEvent(screen))}\n\n`);
  return true;
}

// Everything a page shows, to start over from: sent to a page that (re)connects, and to every open
// page when a discussion is re-opened.
export function resetEvent(screen) {
  return { type: 'reset', messages: screen.transcript.map(messageView), doc: screen.doc,
    thinking: screen.thinking, status: screen.status, input: !!screen.say,
    room: screen.room ?? null, worker: screen.worker ?? [], working: screen.working ?? null, workInput: !!screen.work, workerInfo: screen.workerInfo ?? null,
    auto: screen.auto ?? false, quota: screen.quota, quotaAt: screen.quotaAt ?? null, newRoom: !!screen.newRoom, page: PAGE,
    replica: screen.replica ?? null, replicaOff: screen.replicaOff ?? null, viewing: screen.viewing ?? null };
}

// What the page can still send while viewing another node's line.
const VIEW_COMMANDS = ['/usage', '/reload', '/restart', '/quit', '/shutdown'];

// The page's own code, as a short hash: after a reload, open pages refresh only if it changed.
export const PAGE = createHash('sha1').update(SCREEN).digest('hex').slice(0, 12);

// dir: the room's folder; base: its address on the server (/r/<id>/), for the links in its pages.
export function handle(req, res, dir, screen, base = '/') {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  // Other nodes' rooms (replicate.mjs), with --node only.
  if (url.pathname.startsWith('/replica/') && (!ownHost(req.headers.host ?? '') || req.headers.origin)) return send(403, 'text/plain', 'Refused peer origin or Host.');
  if (url.pathname.startsWith('/replica/')) return screen?.replicaHandler ? screen.replicaHandler(req, res) : send(404, 'text/plain', 'This room doesn\'t replicate.');
  if (screen && handleScreen(req, res, url, dir, screen)) return;
  if (url.pathname === '/__mtime') {
    const rel = url.searchParams.get('f') ?? '';
    if (rel.startsWith('__received/')) return send(200, 'text/plain', 'fixed'); // a received snapshot never changes
    const file = rel ? servable(dir, rel, screen) : null;
    const stamp = rel ? !!file && statSync(file).mtimeMs : docFiles(dir, screen).join('\n');
    return send(200, 'text/plain', String(stamp));
  }
  const rel = decodeURIComponent(url.pathname.slice(1));
  if (rel === '') {
    const items = docFiles(dir, screen).map((f) => `<li><a href="${esc(base + urlPath(f))}">${esc(f)}</a></li>`).join('');
    return send(200, 'text/html; charset=utf-8', page('all files', `<ul>${items}</ul>`, '', base));
  }
  // __received/<discussion>/<node>/<commit>/<path>: a file of a received snapshot, read-only.
  const got = /^__received\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(rel);
  const file = got ? screen?.receivedFile?.(got[1], got[2], got[3], got[4]) : servable(dir, rel, screen);
  if (!file) return send(404, 'text/plain; charset=utf-8', `Not found: ${rel}`);
  // A session transcript quotes whatever was said: its HTML is shown as text, never run.
  // no-cache: a reload after the file changes shows the new content, not a cached copy.
  const sendDoc = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }); res.end(body); };
  if (/\.md$/i.test(file)) return sendDoc('text/html; charset=utf-8', page(rel, ((/(^|\/)transcripts\//.test(rel)) ? mdText : md).parse(readFileSync(file, 'utf8')), rel, base));
  sendDoc(TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', readFileSync(file));
}

// Terminal list: ↑/↓ (or j/k) to move, Enter calls onOpen(file) and stays, Esc/q resolves.
// The caller must keep other keypress listeners (readline's) away from input meanwhile.
export function pick(files, { input, output, onOpen, header = '', rows = 15 }) {
  return new Promise((done) => {
    let i = 0;
    let drawn = 0;
    const draw = () => {
      const top = Math.min(Math.max(0, i - Math.floor(rows / 2)), Math.max(0, files.length - rows));
      const lines = [`\x1b[2m${header}↑/↓ move · Enter open · Esc back\x1b[0m`];
      for (let k = top; k < Math.min(files.length, top + rows); k++) {
        lines.push(k === i ? `\x1b[7m› ${files[k]}\x1b[0m` : `  ${files[k]}`);
      }
      if (drawn) output.write(`\x1b[${drawn}A`);
      output.write(lines.map((l) => `\r\x1b[2K${l}\n`).join(''));
      drawn = lines.length;
    };
    const onKey = (str, key = {}) => {
      if (key.name === 'up' || str === 'k') i = (i - 1 + files.length) % files.length;
      else if (key.name === 'down' || str === 'j') i = (i + 1) % files.length;
      else if (key.name === 'return') onOpen(files[i]);
      else if (key.name === 'escape' || str === 'q' || (key.ctrl && key.name === 'c')) {
        input.off('keypress', onKey);
        output.write(`\x1b[${drawn}A\x1b[J`);
        return done();
      } else return;
      draw();
    };
    input.on('keypress', onKey);
    draw();
  });
}
