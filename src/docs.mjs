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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';
import { Marked } from 'marked';
import { handleShell } from './host-shell.mjs';
export { handleUpgrade } from './host-shell.mjs'; // the terminal pane's WebSocket (ui.mjs)
import { handleNotes } from './notes.mjs';

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};
const BINARY_EXT = new Set([
  '.icns', '.ico', '.bmp', '.tiff', '.tif', '.heic', '.avif',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.dmg', '.pkg', '.iso', '.bin', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac',
  '.mp4', '.mov', '.webm', '.avi', '.mkv',
  '.sqlite', '.sqlite3', '.db', '.pyc', '.class', '.jar',
]);
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Code, config and other UTF-8/ASCII files without NUL bytes open as plain text; binary files
// that aren't already in TYPES are marked unviewable in Explorer ("can't be shown here").
export function isTextFile(file) {
  if (BINARY_EXT.has(extname(file).toLowerCase())) return false;
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.allocUnsafe(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } catch { return false; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
export function isViewable(file) {
  if (/\.md$/i.test(file) || TYPES[extname(file).toLowerCase()]) return true;
  return isTextFile(file);
}

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

const isDatedDiscussion = (name) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name);
const DISC_SECTIONS = new Set(['archive', 'deferred']);
// Files inside a dated discussion (active, archived or deferred): kept even when .gitignore ignores
// patterns such as transcripts/. Room checkout files outside discussions respect .gitignore.
function inDiscussion(rel) {
  const p = rel.split(/[/\\]/);
  return p[0] === 'discussions' && ((p.length >= 2 && isDatedDiscussion(p[1])) || (p.length >= 2 && DISC_SECTIONS.has(p[1])));
}
function isGitIgnored(dir, rel) {
  try {
    execFileSync('git', ['-C', dir, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
// A room serves its discussions and its non-hidden, non-gitignored root checkout files
// (or only screen.sections when a caller sets that explicitly).
const inSection = (screen, rel) => !screen?.sections || screen.sections.includes(rel.split('/')[0]);
const servable = (dir, rel, screen) => {
  if (!inSection(screen, rel)) return null;
  const target = inside(dir, rel);
  if (!target) return null;
  if (!screen?.sections && !inDiscussion(rel) && isGitIgnored(dir, rel)) return null;
  return target;
};
export function docFiles(dir, screen) {
  if (screen?.sections) {
    return screen.sections.flatMap((s) => { try { return listFiles(join(dir, s)).map((f) => join(s, f).split(sep).join('/')); } catch { return []; } });
  }
  let rootFiles;
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    rootFiles = [...new Set(out.split('\0').filter(Boolean))]
      .filter((f) => !f.split('/').some((p) => p.startsWith('.')) && !inDiscussion(f) && inside(dir, f));
  } catch {
    rootFiles = listFiles(dir).map((f) => f.split(sep).join('/')).filter((f) => !inDiscussion(f));
  }
  let discFiles = [];
  try {
    discFiles = listFiles(join(dir, 'discussions')).map((f) => 'discussions/' + f.split(sep).join('/')).filter(inDiscussion);
  } catch {}
  return [...new Set([...rootFiles, ...discFiles])].sort();
}
export function roomBranch(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
function discussionDirs(dir) {
  const found = [];
  for (const prefix of ['discussions', 'discussions/archive', 'discussions/deferred']) {
    try {
      for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
        if (e.isDirectory() && isDatedDiscussion(e.name)) found.push(`${prefix}/${e.name}`);
      }
    } catch {}
  }
  return found.sort();
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
//   quota: the header's gauges ([{ provider, label, used,
//   resets }], null if the meter can't be read, undefined until first read),
//   monitor: the header's warnings per provider ({ login, running, leftovers, inRoom }, see
//   monitorView in ui.mjs),
//   say: (line) => void, work: (text) => void and newRoom: () => Promise,
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

// The conversation's wallpaper: one doodle tile (black strokes), faint, behind the message lists.
const DOODLE = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(30 30)"><circle r="9"/><path d="M0-15v-5M0 15v5M-15 0h-5M15 0h5M-11-11l-3-3M11 11l3 3M-11 11l-3 3M11-11l3-3"/></g><path d="M90 42h34a9 9 0 0 0 0-18 13 13 0 0 0-25-3 10 10 0 0 0-9 21z"/><g transform="translate(175 22)"><path d="M0 14L40 0 26 34 18 20z"/><path d="M18 20L40 0"/></g><path d="M60 95c-6-8-20-4-16 8 3 7 16 16 16 16s13-9 16-16c4-12-10-16-16-8z"/><g transform="translate(120 78)"><path d="M0 0h26v18a8 8 0 0 1-8 8h-10a8 8 0 0 1-8-8z"/><path d="M26 5h4a5 5 0 0 1 0 10h-4"/><path d="M7-6c-2-3 2-4 0-8M15-6c-2-3 2-4 0-8"/></g><g transform="translate(195 85)"><path d="M8 0v24M8 0l14 4v18"/><ellipse cx="4" cy="25" rx="5" ry="4"/><ellipse cx="18" cy="23" rx="5" ry="4"/></g><g transform="translate(20 150)"><path d="M0 30C0 10 15 0 35 0c0 20-15 30-35 30z"/><path d="M0 30L22 10"/></g><g transform="translate(100 165)"><circle r="16"/><circle cx="-6" cy="-4" r="1.2"/><circle cx="6" cy="-4" r="1.2"/><path d="M-7 5c4 5 10 5 14 0"/></g><g transform="translate(170 140)"><path d="M-22 0a22 22 0 0 1 44 0c-5-4-10-4-14 0-5-4-11-4-16 0-4-4-9-4-14 0z"/><path d="M0 0v22a5 5 0 0 1-10 0"/></g><path d="M215 195l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"/><path d="M60 220a12 12 0 1 1 14-15 9 9 0 1 0-14 15z"/><g transform="translate(150 200)"><ellipse rx="10" ry="13"/><path d="M0 13l-3 4h6zM0 17c-3 6 3 9 0 16"/></g><circle cx="70" cy="60" r="3"/><circle cx="155" cy="60" r="2"/><circle cx="225" cy="60" r="3"/><circle cx="95" cy="125" r="2"/><circle cx="215" cy="135" r="2"/><circle cx="30" cy="110" r="3"/><circle cx="60" cy="175" r="2"/><circle cx="125" cy="225" r="3"/><circle cx="200" cy="230" r="2"/><path d="M120 130h12M140 130h4M10 205h10M228 165h6"/></svg>')}")`;
// The Explorer's wallpaper: its own tile, same style and strength.
const DOODLE_EXPLORER = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(30 15)"><path d="M0 0l14 16-14 22-14-22z"/><path d="M-14 16h28M0 0v38"/><path d="M0 38c-4 6 4 9 0 15s4 9 0 14"/></g><g transform="translate(105 30)"><path d="M-6 16a12 12 0 1 1 12 0v6h-12z"/><path d="M-5 26h10M-3 30h6"/><path d="M-3 4l3 4 3-4"/></g><g transform="translate(170 22)"><rect width="40" height="26" rx="3"/><path d="M0 2l20 14 20-14"/></g><g transform="translate(60 105)"><circle r="5"/><circle cy="-11" r="6"/><circle cy="11" r="6"/><circle cx="-11" r="6"/><circle cx="11" r="6"/><path d="M0 17v20M0 30c-6-2-9-6-9-10"/></g><g transform="translate(130 95)"><path d="M0 14L18 0l18 14"/><path d="M4 11v21h28V11"/><path d="M14 32V21h8v11"/></g><g transform="translate(190 108)"><path d="M0 0c8-10 24-10 32 0-8 10-24 10-32 0z"/><path d="M32 0l10-7v14z"/><circle cx="8" cy="-2" r="1.2"/></g><g transform="translate(22 180) rotate(-35)"><path d="M0 0h36l8 5-8 5H0z"/><path d="M36 0v10M6 0v10"/></g><g transform="translate(100 172)"><circle r="8"/><path d="M8 0h26M28 0v6M22 0v5"/></g><g transform="translate(185 175)"><path d="M0-14v28M-12-7l24 14M-12 7l24-14"/><path d="M-4-10l4 4 4-4M-4 10l4-4 4 4"/></g><g transform="translate(70 215)"><circle cy="-14" r="3"/><path d="M0-11v22M-6-6h12M-11 2c0 7 5 9 11 9s11-2 11-9"/></g><g transform="translate(145 222)"><path d="M-10 6c3-3 2-8 2-12a8 8 0 0 1 16 0c0 4-1 9 2 12z"/><path d="M-3 10a3 3 0 0 0 6 0"/></g><path d="M75 45h6M78 42v6M225 70h6M228 67v6M95 140h6M98 137v6M230 150h6M233 147v6M15 75h6M18 72v6"/><circle cx="150" cy="60" r="2"/><circle cx="40" cy="140" r="2.5"/><circle cx="215" cy="215" r="2.5"/><circle cx="110" cy="230" r="2"/><circle cx="160" cy="150" r="2"/></svg>')}")`;

const SCREEN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>agent-room</title><style>
:root { color-scheme: light dark; --line: #8884; --dim: #888; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr; grid-template-columns: var(--left, 38%) 7px 1fr; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
/* The header: three zones, room (left), current discussion (middle), monitoring (right).
   Rare room and server actions sit in the ▾ menus; the gauges never shrink. */
#header { grid-column: 1 / -1; display: grid; grid-template-columns: fit-content(20rem) minmax(16rem, 1fr) auto; gap: .5rem .8rem; align-items: center; padding: .4rem .8rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
.zone { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; border: 1.5px solid var(--zone); border-radius: 6px; padding: .3rem .6rem; align-self: stretch; justify-content: center; }
#room-zone { --zone: #5a7bd8; padding-inline: 1.5rem; } #disc-zone { --zone: #4caf7a; } #server-zone { --zone: #d6a84c; }
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
#disc-zone { flex-direction: row; align-items: center; gap: .3rem .8rem; justify-content: space-between; }
#disc-text { flex: 0 1 auto; min-width: 5rem; display: flex; flex-direction: column; overflow-wrap: anywhere; }
#disc-workers { flex: 0 1 auto; display: flex; flex-direction: column; align-items: flex-end; gap: .1rem; font-size: .72rem; color: light-dark(#b45309, #f59e0b); text-align: right; }
#disc-workers[hidden] { display: none; }
#disc-heading { display: flex; align-items: baseline; gap: .15rem; min-width: 0; }
#disc { min-width: 0; }
#actions-menu { flex: none; }
#disc-status { font-size: .7rem; color: var(--dim); line-height: 1.35; }
#actions-menu > summary { padding: .15rem .3rem; margin-left: 0; }
#actions-menu > summary::after { content: '▾'; }
#actions-menu[hidden] { display: none; }
#new-discussion { display: contents; }
#new-discussion[hidden] { display: none; }
#server-zone { flex-direction: row; align-items: center; gap: .5rem; }
#server-box { flex: none; display: flex; align-items: center; gap: .15rem; }
/* Right of "● Server": some replication peer is unreachable (as in Peers…). Amber; red stays the server's. */
#peer-warning { border: 0; background: none; padding: 0 .2rem; font-size: .8rem; line-height: 1.1; color: light-dark(#92600a, #d6a84c); }
#peer-warning[hidden] { display: none; }
#server-details { flex-direction: column; }
/* The gauges' own children join this grid, with "on" above "HH:MM" in the first column. */
#monitor { display: grid; grid-template-rows: auto auto; align-items: center; gap: .1rem .5rem; flex: none; font-size: .65rem; color: var(--dim); }
#gauges .quota { grid-row: 1 / span 2; }
#gauges .updated { grid-row: 1 / span 2; grid-column: 1; white-space: pre; line-height: 1.3; }
/* Without gauges (meter not reachable), the message, its time and any provider with a warning share one line. */
#monitor:not(:has(.gauge)) { display: flex; align-items: center; gap: .3rem .8rem; white-space: nowrap; }
#monitor:not(:has(.gauge)) .updated { align-self: center; }
#ask { max-width: min(32rem, 90vw); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.2rem; }
#ask::backdrop, #peers::backdrop { background: #0006; }
#peers { width: min(40rem, 90vw); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.2rem; }
#peers h3 { color: var(--dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 .5rem; }
#peers-buttons { display: flex; justify-content: flex-end; margin-top: 1rem; }
#ask-text { margin: 0 0 1rem; overflow-wrap: anywhere; }
#ask-buttons { display: flex; justify-content: flex-end; gap: .5rem; }
#rooms { max-width: min(28rem, 80vw); font: inherit; font-size: .75rem; }
#disc { font-size: .75rem; color: var(--dim); line-height: 1.35; }
#disc[data-active="true"] { color: #60a5fa; font-weight: 600; }
#code { font-size: .7rem; color: var(--dim); font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
#winfo { font-size: .75rem; color: var(--dim); padding: .4rem .8rem; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: .2rem; }
#winfo:empty { display: none; }
#winfo .error { color: #ef4444; }
#winfo code { font-size: .7rem; overflow-wrap: anywhere; user-select: all; }
#winfo summary { cursor: pointer; }
#winfo .lane-lines { margin: .2rem 0 .2rem 1rem; display: flex; flex-direction: column; gap: .2rem; overflow-wrap: anywhere; }
#winfo .preview-files { margin: .2rem 0 0 1rem; max-height: 12rem; overflow-y: auto; }
#winfo button { align-self: flex-start; font-size: .75rem; margin-top: .2rem; }
#server { max-width: 100%; font-size: .75rem; color: light-dark(#3d5fc4, #5a7bd8); display: inline-flex; align-items: center; gap: .4rem; }
#server[data-state="down"] { color: #ef4444; font-weight: 600; }
#beat { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
#server[data-state="up"] #beat { background: #22c55e; } #server[data-state="down"] #beat { background: #ef4444; }
#beat.on { animation: beat 1.2s ease-out; } /* restarted on every answer, so each pulse is a real heartbeat */
@keyframes beat { 0% { transform: scale(1.4); box-shadow: 0 0 0 0 #22c55eaa; } 100% { transform: scale(1); box-shadow: 0 0 0 8px #22c55e00; } }
@media (prefers-reduced-motion: reduce) { #beat.on { animation: none; } }
#files .hint { display: block; margin: 0 0 .8rem; }
#gauges { display: contents; }
.gauge { display: grid; grid-template-columns: 1.2rem 32px 1.8rem; gap: .2rem; align-items: center; line-height: 1.5; }
.quota { display: grid; grid-template-columns: auto 1fr; gap: .05rem .35rem; align-items: center; }
.quota:not(:first-child) { border-left: 1px solid var(--line); padding-left: .5rem; }
.updated + .quota { border-left: 0; padding-left: 0; }
.gauge .bar { width: 32px; height: 6px; border-radius: 3px; background: #8883; overflow: hidden; }
.gauge .bar i { display: block; height: 100%; background: #10b981; }
.gauge.warn { color: #eab308; } .gauge.warn .bar i { background: #eab308; }
.gauge.high { color: #ef4444; font-weight: 600; } .gauge.high .bar i { background: #ef4444; }
.quota b { color: CanvasText; font-weight: 600; grid-column: 1; grid-row: 1 / span 2; text-transform: capitalize; font-size: .7rem; }
.quota b:has(+ .running) { grid-row: 1; }
.quota .running { grid-column: 1; grid-row: 2; font-size: .6rem; color: var(--dim); white-space: nowrap; }
.quota .gauge { grid-column: 2; }
/* A provider's name and each gauge: hover or focus shows details; a ⚠ right of the name on a problem. */
.quota b, .gauge { position: relative; cursor: default; }
.quota b .alert { margin-left: .25rem; font-weight: 700; color: light-dark(#b45309, #d6a84c); }
.quota b .alert.red { color: #ef4444; }
.quota b .hover-detail, .gauge .hover-detail { left: auto; right: 0; text-transform: none; font-weight: 400; white-space: normal; }
.quota b:is(:hover, :focus-visible) > .hover-detail, .gauge:is(:hover, :focus-visible) > .hover-detail { display: flex; }
.hover-detail strong { color: CanvasText; font-weight: 600; }
.hover-detail .problem { font-weight: 600; color: light-dark(#b45309, #d6a84c); }
.hover-detail .problem.red { color: #ef4444; }
.hover-detail code { font-family: ui-monospace, monospace; user-select: all; }
@media (max-width: 1150px) {
  #header { grid-template-columns: fit-content(20rem) minmax(0, 1fr); gap: .4rem .8rem; }
  #server-zone { grid-column: 1 / -1; grid-row: 2; justify-content: space-between; flex-wrap: wrap; width: 100%; }
}
@media (max-width: 600px) {
  #header { grid-template-columns: 1fr; }
  #disc-zone { grid-row: 2; }
  #server-zone { grid-row: 3; }
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
#remote-view p { margin: .2rem 0; } #remote-view .local-activity { color: var(--dim); font-size: .75rem; }
.tools label { display: inline-flex; gap: .3rem; align-items: center; color: var(--dim); }
#left { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#tabs, #subtabs { display: flex; border-bottom: 1px solid var(--line); }
#subtabs { --accent: #3b82f6; --tint: #3b82f612; }
.tab:disabled { opacity: .45; cursor: default; }
.tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: .45rem .9rem; font-size: .9rem; }
.tab.on { border-bottom-color: #3b82f6; font-weight: 600; }
.tab.news::after { content: ' •'; color: #3b82f6; }
#tab-explorer.peeking::after { content: ' ●'; color: #f59e0b; }
.view { flex: 1; display: flex; flex-direction: column; min-height: 0; } .view[hidden] { display: none; }
#split { cursor: col-resize; background: var(--line); background-clip: content-box; padding: 0 3px; touch-action: none; }
#split:hover, #split:focus-visible, body.resizing #split { background-color: #3b82f6; outline: none; }
body.resizing { cursor: col-resize; user-select: none; }
body.resizing iframe { pointer-events: none; } /* the document would swallow the drag */
.chat-wrap { position: relative; display: flex; flex: 1; min-height: 0; }
.chat-wrap::before, #discussions::before, #explorer::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .07; background: 0 0 / 240px repeat; }
.chat-wrap::before { background-image: ${DOODLE}; } #discussions::before, #explorer::before { background-image: ${DOODLE_EXPLORER}; }
@media (prefers-color-scheme: dark) { .chat-wrap::before, #discussions::before, #explorer::before { opacity: .09; filter: invert(1); } }
#discussions, #explorer { position: relative; } #discussions > *, #explorer > * { position: relative; } /* its content above the wallpaper */
.chat { position: relative; flex: 1; min-width: 0; overflow-y: auto; padding: 1rem; }
.scroll-end { position: absolute; right: 1rem; bottom: .6rem; width: 2rem; height: 2rem; padding: 0; border-radius: 50%; background: Canvas; color: CanvasText; box-shadow: 0 2px 8px #0004; }
.msg { margin: 0 0 .9rem; padding: .5rem .75rem; border-radius: 8px; background: linear-gradient(#8881, #8881), Canvas; }
.msg.user { background: linear-gradient(#3b82f622, #3b82f622), Canvas; } .msg.error { background: linear-gradient(#ef444422, #ef444422), Canvas; }
.msg.summary { background: linear-gradient(#10b98122, #10b98122), Canvas; border-left: 3px solid #10b981; } .msg.summary.not-agreed { background: linear-gradient(#f59e0b22, #f59e0b22), Canvas; border-left-color: #f59e0b; }
.who { font-weight: 600; font-size: .85rem; margin-bottom: .2rem; } .who .meta { font-weight: 400; color: var(--dim); }
.msg p { margin: .3rem 0; } .msg pre { overflow-x: auto; } .msg img { max-width: 100%; }
.status { color: var(--dim); font-size: .85rem; margin: .4rem 0 .9rem; white-space: pre-wrap; }
.status.error { color: #ef4444; }
#system-messages { flex: none; border-top: 1px solid var(--line); padding: .35rem .6rem; font-size: .75rem; line-height: 1.4; min-height: calc(2.8em + .7rem + 1px); }
#system-messages .status { margin: 0; font-size: inherit; line-height: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.composer { border-top: 1px solid var(--line); padding: .6rem; }
#attach-row { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-top: .35rem; font-size: .8rem; }
#attach { font-size: .8rem; padding: .1rem .5rem; }
#attachments .chip { display: inline-flex; align-items: center; gap: .25rem; padding: .05rem .2rem .05rem .5rem; border: 1px solid var(--line); border-radius: 9px; margin-right: .3rem; }
#attachments .chip button { border: 0; background: none; padding: 0 .25rem; font-size: .8rem; cursor: pointer; }
.box { width: 100%; min-height: 3.2rem; resize: vertical; font: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid var(--line); }
.tools { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; font-size: .85rem; }
.hint { color: var(--dim); flex: 1; }
button { font: inherit; font-size: .85rem; padding: .2rem .6rem; border-radius: 6px; border: 1px solid var(--line); background: #8882; cursor: pointer; }
#right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#bar { display: flex; gap: .6rem; align-items: center; padding: .4rem .6rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#current { color: var(--dim); } #feed { margin-left: auto; }
#siblings { max-height: 60vh; overflow-y: auto; } #siblings .shown { font-weight: 600; }
#discussions-pane, #pane, #docpane { flex: 1; min-height: 0; }
/* The terminal pane (host-shell.mjs): a shell on this computer, shown only in pages opened on this computer. */
#hostshell { border-top: 1px solid var(--line); } #hostshell[hidden], #hostshell-term[hidden] { display: none; }
#hostshell-toggle { width: 100%; text-align: left; border: 0; border-radius: 0; background: none; padding: .3rem .6rem; font-size: .8rem; }
#hostshell-term { height: 16rem; padding: .3rem; background: #1e1e1e; overflow: hidden; }
/* The Notes pane (notes.mjs): the User's own notes, in the same place and only one of the two open. */
#notes { border-top: 1px solid var(--line); } #notes[hidden], #notes-body[hidden], #notes-ask[hidden] { display: none; }
#notes-toggle { width: 100%; text-align: left; border: 0; border-radius: 0; background: none; padding: .3rem .6rem; font-size: .8rem; }
#notes-body { height: 16rem; display: grid; grid-template-columns: minmax(8rem, 30%) 1fr; }
#notes-side { display: flex; flex-direction: column; gap: .3rem; min-height: 0; padding: .3rem; border-right: 1px solid var(--line); }
#notes-new { align-self: flex-start; font-size: .8rem; } #notes-list { overflow-y: auto; min-height: 0; }
#notes-list .note { display: block; width: 100%; text-align: left; border: 0; border-radius: 4px; background: none; padding: .2rem .4rem; font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#notes-list .note:hover { background: #8882; } #notes-list .note.on { background: #3b82f622; }
#notes-list .when { display: block; color: var(--dim); font-size: .7rem; } #notes-list .hint { font-size: .8rem; }
#notes-main { display: flex; flex-direction: column; gap: .3rem; min-width: 0; min-height: 0; padding: .3rem; }
#notes-text { flex: 1; min-height: 0; resize: none; font-family: ui-monospace, Menlo, monospace; font-size: .8rem; }
#notes-bar { display: flex; gap: .4rem; align-items: center; font-size: .8rem; } #notes-bar button { font-size: .8rem; }
#notes-status { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } #notes-status.error { color: #ef4444; }
#notes-ask { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; padding: .3rem .5rem; border: 1px solid #b08900; border-radius: 6px; background: #b0890018; font-size: .8rem; }
#notes-ask button { font-size: .8rem; }
#discussions-pane, #pane { overflow-y: auto; }
#doc { border: 0; width: 100%; height: 100%; }
.empty { display: grid; place-items: center; color: var(--dim); height: 100%; padding: 1rem; text-align: center; }
#files, #disc-list { padding: 1rem; }
#files .entry, #disc-list .entry { display: block; width: 100%; text-align: left; margin: 0; padding: .3rem .5rem; border: 0; border-radius: 4px; background: none; font-size: .9rem; break-inside: avoid; }
#files .entry:hover, #disc-list .entry:hover { background: #8882; }
#files .entry.file.shown, #files .entry.file.shown:hover { background: #3b82f633; box-shadow: inset 3px 0 #60a5fa; }
#files .entry.unviewable { opacity: .5; cursor: default; }
#files .entry.unviewable:hover { background: none; }
#files .entry::before, #disc-list .entry::before { display: inline-block; width: 1.5em; }
#files .entry.folder::before, #disc-list .entry.folder::before { content: '📁'; } #files .entry.file::before { content: '📄'; } #files .entry.discussion::before, #disc-list .entry.discussion::before { content: '💬'; }
#files .entry .tag, #disc-list .entry .tag { color: var(--dim); font-size: .8rem; margin-left: .5rem; }
#files .back, #disc-list .back { border: 0; background: none; padding: 0; color: var(--dim); font-size: .85rem; margin: 0 0 .4rem; }
#files .back:hover, #disc-list .back:hover { color: CanvasText; text-decoration: underline; }
#files .title, #disc-list .title { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
#files .status, #disc-list .status { font-size: .75rem; font-weight: 400; padding: .05rem .45rem; border-radius: 9px; background: #8883; margin-left: .5rem; vertical-align: middle; }
#files .status.archive, #disc-list .status.archive { background: #8882; } #files .status.deferred, #disc-list .status.deferred { background: #eab30833; } #files .status.inuse, #disc-list .status.inuse { background: #3b82f633; }
#files .actions, #disc-list .actions { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 1rem; padding: 0 0 .8rem; border-bottom: 1px solid var(--line); }
#files .actions .primary, #disc-list .actions .primary { background: #3b82f6; border-color: #3b82f6; color: white; }
#files .row, #disc-list .row { display: flex; align-items: center; gap: .3rem; }
#files .row .entry, #disc-list .row .entry { flex: 1; min-width: 0; }
#files button.archiving::before, #disc-list button.archiving::before { content: ""; display: inline-block; width: .65em; height: .65em; margin-right: .35em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: archive-spin .7s linear infinite; }
@keyframes archive-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #files button.archiving::before, #disc-list button.archiving::before { animation: none; } }
#files .row .reopen, #disc-list .row .reopen { font-size: .75rem; padding: .1rem .5rem; }
#files .row-menu > summary, #disc-list .row-menu > summary { font-size: .75rem; margin-left: 0; }
#files .row-menu .menu-items, #disc-list .row-menu .menu-items { left: auto; right: 0; }
#files .row-menu .menu-items button, #disc-list .row-menu .menu-items button { font-size: .85rem; padding: .3rem .6rem; }
.menu-items button:disabled { color: var(--dim); cursor: default; background: none; }
#files .discussion-row, #disc-list .discussion-row { align-items: baseline; flex-wrap: wrap; }
#files .discussion-row > .discussion-lines, #disc-list .discussion-row > .discussion-lines, #disc-list .discussion-row > .discussion-block { flex-basis: 14rem; flex: 1; min-width: 0; }
#files .discussion-row.in-use, #disc-list .discussion-row.in-use { background: linear-gradient(#3b82f614, #3b82f614), Canvas; box-shadow: inset 3px 0 #60a5fa; border-radius: 4px; padding-left: .5rem; }
#disc-list .drag-handle { cursor: grab; color: var(--dim); padding: 0 .2rem; user-select: none; }
#disc-list .discussion-row.dragging { opacity: .5; }
#disc-list .discussion-row.drop-before { box-shadow: inset 0 2px #60a5fa; }
#disc-list .discussion-row.drop-after { box-shadow: inset 0 -2px #60a5fa; }
#disc-list .discussion-row.peeking { background: linear-gradient(#f59e0b18, #f59e0b18), Canvas; box-shadow: inset 3px 0 #f59e0b; border-radius: 4px; padding-left: .5rem; }
.peek-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem; margin: 0 0 .6rem; padding: .35rem .6rem; border: 1px solid #f59e0b; border-radius: 6px; background: #f59e0b1f; color: light-dark(#92400e, #fcd34d); font-size: .82rem; }
.peek-banner button { font-size: .78rem; padding: .1rem .5rem; border-color: #f59e0b88; color: inherit; background: #f59e0b22; }
.explorer-bar { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; margin: 0 0 .35rem; }
.explorer-bar button { border: 0; border-right: 1px solid var(--line); border-radius: 0; background: none; padding: .22rem .65rem; font-size: .8rem; }
.explorer-bar button:last-child { border-right: 0; }
.explorer-bar button.on { background: #3b82f622; color: #60a5fa; font-weight: 600; }
.explorer-bar button:disabled { opacity: .45; cursor: default; }
.explorer-sub { font-size: .75rem; color: var(--dim); font-family: ui-monospace, monospace; margin: 0 0 .6rem; overflow-wrap: anywhere; }
.section-group { margin: .3rem 0; }
.section-group > summary { cursor: pointer; padding: .3rem .5rem; border-radius: 4px; font-size: .9rem; }
.section-group > summary:hover { background: #8882; }
.section-group > summary .tag { color: var(--dim); font-size: .8rem; margin-left: .5rem; }
.inline-folder { position: relative; }
.inline-folder[open]::before { content: ""; position: absolute; left: .75rem; top: 1.9rem; bottom: .2rem; border-left: 1px solid var(--line); pointer-events: none; }
.inline-folder > summary { cursor: pointer; padding: .3rem .5rem; border-radius: 4px; font-size: .9rem; }
.inline-folder > summary:hover { background: #8882; }
.inline-folder > summary::before { content: '📁'; display: inline-block; width: 1.5em; }
#files .inline-folder > :not(summary) { margin-left: 1.1rem; width: calc(100% - 1.1rem); }
.file-columns { column-width: 14rem; column-gap: .6rem; }
.local-label { color: var(--dim); font-size: .8rem; margin: .3rem 0; }
.discussion-info { position: relative; display: inline-block; }
.discussion-info > button { border: 0; background: none; color: #8fa8ee; padding: .15rem; }
.info-detail { display: none; position: absolute; right: 0; top: 100%; z-index: 5; width: 15rem; padding: .5rem; background: Canvas; color: CanvasText; border: 1px solid var(--line); border-radius: 4px; font-size: .8rem; }
.discussion-info:hover .info-detail, .discussion-info:focus-within .info-detail { display: block; }
#files .actions .sep, #disc-list .actions .sep { width: 1px; align-self: stretch; background: var(--line); margin: 0 .3rem; }
#files h3, #disc-list h3 { color: var(--dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; margin: .9rem 0 .3rem; }
#disc-list .hint { display: block; margin: 0 0 .8rem; }
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
.agent-row[data-provider="agy"] { --provider: #6366f1; }
.agent-row label { display: flex; flex-direction: column; font-size: .8rem; flex: 1; min-width: 100px; }
.agent-row label[hidden] { display: none; }
.agent-row.member-row { flex-wrap: nowrap; align-items: end; padding: .35rem; margin: .25rem 0; }
.agent-row.member-row .member-toggle { flex: 0 0 2.3rem; min-width: 0; align-items: center; }
.agent-row.member-row .member-toggle input { width: auto; margin: .45rem 0; }
.agent-row.member-row label { min-width: 0; }
.agent-row.member-row .auto-name { background: light-dark(#fffbe6, #544a15); border-color: #d9a900; }
.agent-row.member-row[data-active="false"] label:not(.member-toggle) { opacity: .58; }
.member-note { color: light-dark(#a60, #e8ae54); }
@media (max-width: 550px) { .agent-row.member-row { flex-wrap: wrap; } .agent-row.member-row label:not(.member-toggle) { min-width: 6rem; } }
.agent-row input, .agent-row select { font: inherit; padding: .3rem; width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 4px; }
#work .box:focus, #talk .box:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.msg { border-left: 3px solid #14b8a6; }
.msg.user { border-left-color: #3b82f6; }
#wchat .msg:not(.user):not(.error) { border-left-color: #a855f7; background: linear-gradient(#a855f712, #a855f712), Canvas; }
.msg.error { border-left-color: #ef4444; }
.tools { flex-wrap: wrap; }
</style></head><body>
<header id="header">
<div id="room-zone" class="zone" aria-label="Room"><div class="zone-line"><details class="menu" id="room-menu"><summary><b id="room-name">agent-room</b></summary><div class="menu-items"><button id="switchroom">Switch room…</button><button id="newroom" title="Choose a folder and open its room in a new window, creating one there if you confirm. This room keeps running.">Open room in folder…</button><button id="peers-open" hidden title="Replication peers: reachability and pairing">Peers…</button><hr><button id="quit" class="danger" title="End this room only: its agents and worker stop. The server's other rooms keep running.">Quit room</button></div></details><span id="replica-header" class="hover-detail" role="tooltip"></span></div><div id="server-box"><span id="server-head"><details class="menu" id="server-menu"><summary><span id="server"><i id="beat"></i>Server</span></summary><div class="menu-items"><button id="reload">Reload</button><button id="restart" title="Start a new server on this address, with every room, each in its discussion in use, from its handoff. The chats clear.">Restart</button><hr><button id="shutdown" class="danger" title="End every room on this server, then the server.">Shutdown server</button></div></details><span id="server-details" class="hover-detail" role="tooltip"><span id="server-text">Connecting to the server…</span><span id="code"></span></span></span><button id="peer-warning" hidden>⚠</button></div><select id="rooms" aria-label="Running rooms" hidden></select><dialog id="ask"><p id="ask-text"></p><div id="ask-buttons"></div></dialog><dialog id="peers"><div id="peers-list"></div><div id="peers-buttons"><button id="peers-close">Close</button></div></dialog></div>
<div id="disc-zone" class="zone" aria-label="Current discussion"><div id="disc-text"><div id="disc-heading"><span id="disc" title="The active discussion"></span><details class="menu" id="actions-menu"><summary aria-label="Discussion actions" title="Actions"></summary><div class="menu-items"><button id="summary">Summarize</button><span id="new-discussion" hidden><hr><button id="newdisc" title="End this session: the chat clears and your next message starts a new discussion. Its worker tasks finish in its own worker session; the new one gets a fresh worker session.">New discussion</button><button id="newbrainstorm" title="A conversation with the same agents, kept only in memory: no folder, transcript or notes. It ends this session; Restart or Quit room loses it, and a new one replaces it.">New brainstorm</button><button id="closedisc" hidden title="Close this discussion: its agents stop; the other open discussions stay. Its checkpoint is kept: Resume it from Discussions.">Close discussion</button></span></div></details></div><span id="disc-status" aria-live="polite"></span></div><div id="disc-workers" aria-live="polite" hidden></div></div>
<div id="server-zone" class="zone" aria-label="Monitoring"><div id="monitor"><span id="gauges" aria-label="Subscription usage"></span></div></div>
</header>
<div id="left">
  <div id="tabs" role="tablist"><button class="tab on" id="tab-talk" role="tab">Discussion</button><button class="tab" id="tab-work" role="tab">Worker</button></div>
  <div class="view" id="talk">
    <details class="agent-settings" id="talk-settings">
      <summary>Discussion members · provider & model</summary>
      <form id="talk-settings-form">
        <p class="settings-hint" id="talk-settings-hint"></p>
        <div id="talk-agent-rows"></div>
        <p class="settings-hint member-note" id="talk-member-note" hidden></p>
        <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
        <p class="settings-status" id="talk-settings-status" role="status"></p>
      </form>
    </details>
    <div id="failed-agents" role="status" hidden></div>
    <div class="chat-wrap"><div class="chat" id="chat"></div><button class="scroll-end" id="talk-end" aria-label="Scroll to latest discussion messages" title="Scroll to latest messages" hidden>↓</button></div>
    <div class="composer" id="composer">
      <div id="remote-view" hidden></div>
      <div id="autodev" role="status" hidden></div>
      <textarea class="box" id="box" placeholder="Message the agents (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown"></textarea>
      <div id="attach-row"><button type="button" id="attach" title="Attach files to your next message: saved into the discussion's files/ folder when you send it (25 MB at most each)">📎 Attach</button><input type="file" id="attach-input" multiple hidden><span id="attachments"></span></div>
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
  <div id="subtabs" role="tablist"><button class="tab" id="tab-discussions" role="tab">Discussions</button><button class="tab on" id="tab-explorer" role="tab">Explorer</button><button class="tab" id="tab-document" role="tab" disabled title="Choose a file in Explorer">Document</button></div>
  <div class="view" id="discussions" hidden><div id="discussions-pane"></div></div>
  <div class="view" id="explorer"><div id="pane"></div></div>
  <div class="view" id="document" hidden>
    <div id="bar"><details class="menu" id="doc-menu"><summary title="Other files in this folder"><span id="current">No document shown.</span></summary><div class="menu-items" id="siblings"></div></details><button id="feed" hidden title="Ask the agents to read this transcript in full">Send to agents</button></div>
    <div id="docpane"></div>
  </div>
  <div id="notes" hidden><button id="notes-toggle" aria-expanded="false" title="Your own notes for this room's folder, kept on this computer only (not in the folder, not sent to peers). The agents are not told about them; the files are outside the room's folder.">▸ Notes (this computer only)</button><div id="notes-body" hidden>
    <div id="notes-side"><button id="notes-new" title="Start a new note: the first line is its title">New</button><div id="notes-list"></div></div>
    <div id="notes-main"><div id="notes-ask" role="alertdialog" aria-labelledby="notes-ask-text" hidden><span id="notes-ask-text"></span><span id="notes-ask-buttons"></span></div><textarea class="box" id="notes-text" aria-label="Note" placeholder="Choose a note, or New. The first line is the note's title." disabled></textarea>
      <div id="notes-bar"><button id="notes-save" disabled title="Save this note (nothing is saved until you press Save)">Save</button><button id="notes-remove" disabled>Remove</button><span id="notes-status" role="status"></span></div></div>
  </div></div>
  <div id="hostshell" hidden><button id="hostshell-toggle" aria-expanded="false" title="A shell on this computer, in the room's folder. Only from this computer, not from other devices.">▸ Terminal (this computer only)</button><div id="hostshell-term" hidden></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pane = $('pane'), docpane = $('docpane'), box = $('box'), wbox = $('wbox');
let pending = [], attaching = false; // attachments waiting for the next message (see sendWithFiles)
let replica = null, replicaOff = null, viewing = null, localMessages = [], localInput = true, localThinking = null, yourTurn = false, localWorking = null, viewExpired = false, viewNotice = null;
// crypto.randomUUID exists only in secure contexts (HTTPS or localhost); over plain HTTP from another machine, use random bytes.
const viewClient = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
let ended = false, doc = null, tab = 'talk', page = null;
// Refreshing the page keeps what was being typed in the two message boxes, and an unsaved note.
let refreshing = false, noteDraftKept = null;
function refreshPage() {
  sessionStorage.setItem('drafts', JSON.stringify([box.value, wbox.value, noteDraft()]));
  refreshing = true; // no leave-page warning: the draft is kept
  location.reload();
}
try { [box.value, wbox.value, noteDraftKept = null] = JSON.parse(sessionStorage.getItem('drafts')) ?? ['', '']; } catch {}
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
  if (name === 'work') { $('tab-work').classList.remove('news'); post('__workerinfo', {}).catch(() => {}); } // its branches' checks, again
  updateReplicaView();
  (name === 'work' ? wbox : box).focus();
}
$('tab-talk').onclick = () => showTab('talk');
$('tab-work').onclick = () => showTab('work');
function workMessage(m, live) {
  if (m.note) return status(m.note, m.error, 'Worker'); // a marker (New discussion) or an error
  const el = bubble(m);
  if (m.retryId) el.dataset.retryId = m.retryId;
  work.add(el);
  updateRetry();
  if (live && m.speaker !== 'User' && tab !== 'work') $('tab-work').classList.add('news');
}
let retryId = null;
function updateRetry() {
  document.querySelectorAll('#wchat .retry-actions').forEach((el) => el.remove());
  if (!retryId) return;
  const target = [...document.querySelectorAll('#wchat [data-retry-id]')].find((el) => el.dataset.retryId === retryId);
  if (!target) return;
  const actions = document.createElement('div'); actions.className = 'retry-actions';
  const retry = document.createElement('button'); retry.textContent = 'Retry';
  const choose = document.createElement('button'); choose.textContent = 'Retry with…';
  retry.onclick = async () => { retry.disabled = choose.disabled = true; try { const res = await post('__retry', { id: retryId }); if (!res.ok) throw new Error(await res.text()); } catch (err) { status(err.message, true, 'Worker'); retry.disabled = choose.disabled = false; } };
  choose.onclick = () => chooseRetry(retryId);
  actions.append(retry, choose); target.append(actions);
}
async function chooseRetry(id) {
  try {
    await settingsSave;
    const res = await fetch('__settings'); if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const dialog = document.createElement('dialog'), form = document.createElement('form');
    const title = document.createElement('h3'); title.textContent = 'Retry with…'; form.append(title);
    const row = agentRow(form, data.settings.worker, data.models, 'Worker');
    row.row.querySelector('input').readOnly = true; // Retry changes the provider and model, not the worker name.
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
    const send = document.createElement('button'); send.type = 'submit'; send.textContent = 'Retry';
    const error = document.createElement('p'); form.append(cancel, send, error); dialog.append(form); document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    form.onsubmit = async (e) => {
      e.preventDefault(); if (row.incomplete()) { error.textContent = 'Enter a custom model ID.'; return; }
      send.disabled = true;
      try {
        const latest = await fetch('__settings'); if (!latest.ok) throw new Error(await latest.text());
        const now = await latest.json(), settings = { ...selectedSettings(now), worker: row.get(), scope: 'work' };
        const result = await post('__retry', { id, settings }); if (!result.ok) throw new Error(await result.text());
        dialog.close();
      } catch (err) { error.textContent = err.message; send.disabled = false; }
    };
    dialog.showModal();
  } catch (err) { status(err.message, true, 'Worker'); }
}
function showFailedAgents(agents) {
  const panel = $('failed-agents'); panel.replaceChildren(); panel.hidden = !agents?.length;
  for (const agent of agents ?? []) {
    const row = document.createElement('div');
    const text = document.createElement('span'); text.textContent = agent.name + (agent.disabled ? ' is disabled. ' : ' failed. ');
    const button = document.createElement('button'); button.textContent = agent.disabled ? 'Enable' : 'Disable';
    button.onclick = async () => {
      button.disabled = true;
      try { const res = await post('__agent-enabled', { name: agent.name, enabled: agent.disabled }); if (!res.ok) throw new Error(await res.text()); }
      catch (err) { status(err.message, true); button.disabled = false; }
    };
    row.append(text, button); panel.append(row);
  }
}
// The Worker tab's line: its worktree, or why the worker is disabled.
// Each lane (the discussion's own branch first, then every other one with something to review) is
// shown collapsed under a one-line summary; what the User opens stays open across refreshes.
function setWorkerInfo(info) {
  const el = $('winfo');
  const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.key));
  el.replaceChildren();
  if (!info) return;
  const lineEl = (line) => {
    let p = mergePreviewLine(line, open);
    if (!p) { p = document.createElement('div'); p.textContent = line; }
    if (info.error || info.disabled) p.className = 'error';
    return p;
  };
  if (!info.lanes) { for (const line of info.lines) el.append(lineEl(line)); }
  else for (const lane of info.lanes) {
    const d = document.createElement('details'); d.dataset.key = 'lane ' + lane.summary.split(' · ')[0]; d.open = open.has(d.dataset.key);
    const summary = document.createElement('summary'); summary.textContent = lane.summary;
    const body = document.createElement('div'); body.className = 'lane-lines';
    for (const line of lane.lines) body.append(lineEl(line));
    d.append(summary, body);
    el.append(d);
  }
  wbox.disabled = !!info.disabled;
  if (info.disabled) wbox.placeholder = info.lines[0];
}
// A merge preview line can name many conflicting files: shown collapsed, its outcome in the summary.
function mergePreviewLine(line, open) {
  const m = /^(Merge preview of \\S+ into \\S+) \\((.+?)\\): (.*)$/.exec(line);
  if (!m) return null;
  const files = /^would conflict in (.*)\\.$/.exec(m[3])?.[1].split(', ');
  const outcome = m[3].startsWith('clean') ? 'clean' : files ? 'would conflict in ' + files.length + (files.length === 1 ? ' file' : ' files') : 'could not be computed';
  const d = document.createElement('details'); d.dataset.key = m[1]; d.open = open.has(m[1]);
  const summary = document.createElement('summary'); summary.textContent = m[1] + ': ' + outcome;
  const body = document.createElement('div'); body.className = 'preview-files'; body.textContent = m[3] + ' (' + m[2] + ')';
  d.append(summary, body);
  return d;
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
  if (a.status === 'finished') { el.hidden = false; para(span('Auto dev finished. Review and merge its worker branch yourself (the Worker tab names it).')); }
  if (!a.offer) return;
  const summaries = [...$('chat').querySelectorAll('.msg.summary:not(.not-agreed)')];
  const target = summaries.at(-1);
  if (!target) return;
  const offer = document.createElement('div'); offer.className = 'autodev-offer';
  if (a.offer.text) offer.append(button('Start auto dev'), span('Sends this instruction as cycle 1 of up to ' + a.max + '.'));
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
const BINARY_FILE = /\.(icns|ico|bmp|tiff?|heic|avif|zip|tar|gz|tgz|bz2|xz|7z|rar|zst|dmg|pkg|iso|bin|exe|dll|so|dylib|a|o|wasm|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|m4a|aac|mp4|mov|webm|avi|mkv|sqlite3?|db|pyc|class|jar)$/i;
// The right pane's three subtabs: Discussions, Explorer, Document. Each keeps its place while
// another is shown: Explorer its tree and scroll position, Document its file and scroll position.
let subtab = 'explorer', explorerMode = 'discussion', peek = null, lastActiveKey = undefined;
const hasDiscussionTree = () => !!(peek || viewing || room?.active);
const effectiveExplorerMode = () => (hasDiscussionTree() ? explorerMode : 'root');
function showSub(name) {
  if (name === 'document' && !doc) return;
  subtab = name;
  if ($('discussions')) $('discussions').hidden = name !== 'discussions';
  $('explorer').hidden = name !== 'explorer'; $('document').hidden = name !== 'document';
  if ($('tab-discussions')) $('tab-discussions').classList.toggle('on', name === 'discussions');
  $('tab-explorer').classList.toggle('on', name === 'explorer'); $('tab-document').classList.toggle('on', name === 'document');
}
if ($('tab-discussions')) $('tab-discussions').onclick = () => showSub('discussions');
$('tab-explorer').onclick = () => { showSub('explorer'); revealDoc(); };
// Back to Explorer with a local file shown: if that file is inside the tree Explorer is showing now,
// unfold its parent folders and scroll it into view. Never re-enters a peek that was ended.
async function revealDoc() {
  if (!doc || doc.startsWith('__received/') || viewing) return;
  const mode = effectiveExplorerMode();
  if (mode === 'root') {
    const p = doc.split('/');
    if (p[0] !== 'discussions' || (p.length >= 2 && !isDiscussion(p[1]) && !SECTIONS[p[1]])) {
      for (let i = 1; i < p.length; i++) expandedLines.add('root:' + p.slice(0, i).join('/'));
    }
  } else {
    const base = peek?.kind === 'local' ? peek.path : room?.active;
    if (base && doc.startsWith(base + '/')) {
      const rel = doc.slice(base.length + 1).split('/');
      for (let i = 1; i < rel.length; i++) expandedLines.add(base + '/' + rel.slice(0, i).join('/'));
    }
  }
  await openFiles();
  requestAnimationFrame(() => [...pane.querySelectorAll('.entry.file')].find((b) => b.classList.contains('shown'))?.scrollIntoView({ block: 'center' }));
}
$('tab-document').onclick = () => showSub('document');
// Document's path line: names the discussion (current, peeked or received) or "Room checkout", plus the file's path inside it.
function docLabel(file) {
  if (!file) return 'No document shown.';
  if (file.startsWith('__received/')) {
    const [, d, node, , ...rest] = file.split('/');
    const rec = replica?.received?.find((l) => l.discussion === d && l.node === node);
    const name = (peek?.kind === 'received' && peek.discussion === d ? peek.name : null) || rec?.local || rec?.name || d;
    return name + ' · ' + rest.join('/');
  }
  const p = file.split('/');
  if (p[0] === 'discussions' && p.length >= 3 && isDiscussion(p[1])) return p[1] + ' · ' + p.slice(2).join('/');
  if (p[0] === 'discussions' && p.length >= 4 && SECTIONS[p[1]] && isDiscussion(p[2])) return p[2] + ' · ' + p.slice(3).join('/');
  return 'Room checkout · ' + file;
}
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
  $('current').textContent = docLabel(doc);
  $('doc-menu').open = false;
  $('current').title = doc || ''; // the full path, on hover
  $('tab-document').disabled = !doc;
  if (!doc) { docpane.replaceChildren(); if (subtab === 'document') showSub('explorer'); return; }
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
  const parts = doc.split('/');
  const prefix = received ? parts.slice(0, 4).join('/') + '/' : '';
  const rel = doc.slice(prefix.length), folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  let files = [], unviewable = new Set();
  try {
    if (received) {
      files = await (await fetch('__rfiles?d=' + encodeURIComponent(parts[1]) + '&n=' + encodeURIComponent(parts[2]) + '&c=' + encodeURIComponent(parts[3]))).json();
    } else {
      const raw = await (await fetch('__files?detail=1')).json();
      files = Array.isArray(raw) ? raw : raw.files;
      unviewable = new Set(Array.isArray(raw) ? [] : raw.unviewable);
    }
  } catch {}
  const siblings = files.filter((f) => f.startsWith(folder) && !f.slice(folder.length).includes('/')).sort();
  for (const f of siblings) {
    const b = document.createElement('button');
    const cantShow = !received && (unviewable.has(f) || BINARY_FILE.test(f)) || (received && BINARY_FILE.test(f));
    b.textContent = f.slice(folder.length) + (cantShow ? " · can't be shown here" : '');
    if (cantShow) { b.disabled = true; b.title = "can't be shown here"; }
    if (prefix + f === doc) b.className = 'shown';
    b.onclick = () => { closeMenus(); if (cantShow || prefix + f === doc) return; if (received) showDoc(prefix + f); else post('__show', { file: f }); };
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
  peek = null;
  viewExpired = false; viewNotice = null;
  updateReplicaView();
  showDoc(null);
  talk.clear();
  if (viewing) {
    explorerMode = 'discussion';
    viewing.messages.forEach((m) => { if (!m.pass && !m.hidden) talk.add(bubble(m)); });
    await openFiles();
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
  if (!el) return;
  el.replaceChildren();
  if (room?.folder) {
    const path = document.createElement('code');
    path.textContent = room.folder;
    el.append(path);
  }
  if (!replica) return;
  const r = replica, own = r.own[room?.active?.split('/').at(-1)];
  const project = r.project?.commit ? 'Project ' + r.project.commit + (r.project.dirty ? ' + uncommitted' : '') : 'Version unavailable';
  const line = viewing ? '[Viewing ' + viewing.node + "'s line, round " + viewing.round + ', received ' + receivedTime(viewing.receivedAt) + ' · read-only] · ' + viewing.node + ': ' + peerActivity(viewing.node)
    : r.node + "'s line" + (own ? ', round ' + own.round : ', no saved round') + ' · agents run on ' + r.node;
  const info = document.createElement('span');
  info.textContent = r.node + ' ' + (r.addresses[0] || '127.0.0.1:' + location.port) + ' · ' + line + ' · ' + project;
  el.append(info);
}
// The status under the title, for the selected tab. While auto dev runs, the turn is not the User's.
function talkStatus() {
  if (tab === 'work') return localWorking ? localWorking + ' is working' : 'idle';
  if (!room) return '';
  if (viewing) return 'read-only';
  if (localThinking) return localThinking + ' is thinking';
  if (room.autoDev?.status === 'running') return 'Auto dev running';
  return room.started && yourTurn ? 'your turn' : '';
}
function updateDiscWorkers() {
  const el = $('disc-workers');
  if (!el) return;
  const workers = (room?.open ?? []).filter((o) => o.working);
  el.hidden = !workers.length;
  el.replaceChildren(...workers.map((o) => {
    const s = document.createElement('span');
    const dot = document.createElement('span');
    dot.textContent = '● ';
    dot.style.color = '#f59e0b';
    s.append(dot, o.title + ' · Worker is working');
    return s;
  }));
}
function updateReplicaView() {
  updateDiscWorkers();
  updateReplicaHeader();
  renderAutoDev();
  if (room) { $('disc').textContent = viewing ? viewing.title : room.discussion; $('disc').dataset.active = !viewing && room.active ? 'true' : 'false'; }
  // Under the title, show the activity of the selected tab.
  $('disc-status').textContent = talkStatus();
  const panel = $('remote-view'); panel.hidden = !viewing; panel.replaceChildren();
  $('composer').hidden = !viewing && !localInput;
  box.hidden = !!viewing;
  // Attach: in discussions only (disabled until the first message creates the folder), not in brainstorms.
  $('attach-row').hidden = !!viewing || !room || !!room.brainstorm;
  if ($('attach-row').hidden && !attaching) pending = [];
  $('attach').title = room?.active ? "Attach files to your next message: saved into the discussion's files/ folder when you send it (25 MB at most each)" : 'Send a first message to start the discussion; then you can attach files';
  renderAttachments();
  $('talk-settings').hidden = !!viewing;
  $('summary').hidden = !!viewing;
  $('reload').hidden = !!viewing;
  // New discussion (in the header): ends this session (in the terminal); the next message starts the new one.
  // New brainstorm, beside it, is always offered (it ends a session or a brainstorm the same way).
  $('new-discussion').hidden = !(room && localInput && !viewing);
  $('newdisc').hidden = !(room?.active || room?.brainstorm);
  // With several discussions open (the screen), New discussion and Resume keep this one open;
  // Close discussion closes it. Their tooltips say so.
  $('closedisc').hidden = !room?.multi || !(room.active || room.brainstorm || room.open?.length > 1);
  if (room?.multi) {
    $('newdisc').title = 'Open a new discussion beside this one, which stays open (Explorer: Resume shows it again). An open brainstorm ends.';
    $('newbrainstorm').title = 'A conversation with the same agents, kept only in memory, beside the open discussions (one per folder; a new one replaces it).';
  }
  $('actions-menu').hidden = ['summary', 'new-discussion'].every((id) => $(id).hidden);
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
  openFiles();
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
// time. Looking is not switching: Resume and Start fresh are separate actions, and Archive / Defer /
// Make active move the whole discussion. A discussion is a folder named <date>-<title> (as ui.mjs
// creates them); anything else directly in discussions/ is the room's own material (in agent-room
// itself: the index of its discussions).
const isDiscussion = (name) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name);
const SECTIONS = { archive: 'Archive', deferred: 'Deferred' };
const inDiscussion = (f) => { const p = f.split('/'); return p[0] === 'discussions' && p.length >= 2 && (isDiscussion(p[1]) || Boolean(SECTIONS[p[1]])); };
// The discussion a list path shows, as /resume and /move name it ("<name>" or "archive/<name>"), or null.
function discussionOf(parts) {
  if (parts.length === 2 && isDiscussion(parts[1])) return { ref: parts[1], section: null };
  if (parts.length === 3 && SECTIONS[parts[1]] && isDiscussion(parts[2])) return { ref: parts[1] + '/' + parts[2], section: parts[1] };
  return null;
}
// Resume (one button for a discussion not on screen): what it does, by the discussion's state.
// open: its entry in room.open when it is open in another context (started: Resume only shows it).
function resumeTip(name, open, section) {
  const saved = room?.checkpoints?.find((c) => c.name === name);
  const what = open ? 'Show it: its agents carry on, nothing is restarted.'
    : saved?.kind === 'full' ? 'Continue where it stopped: the same agent and worker sessions, and its chat.'
    : saved?.kind === 'fresh' && saved.summary !== false ? 'Start from its handoff and notes, with the summary chosen at Start fresh.'
    : 'No saved session: start from its handoff and notes.';
  return (section ? 'Makes it active first. ' : '') + what;
}
// Start fresh: discards the saved sessions and chat, so it always takes two clicks.
function freshButton(b, ref) {
  b.title = 'New agent and worker sessions, from its handoff and notes and its latest saved summary. Its saved sessions and chat are discarded.';
  confirmed(b, () => send('/fresh ' + ref), 'Click again: its saved sessions and chat are discarded; it starts from its handoff', () => true);
}
// New discussion: once this session has started, it ends it (the chat clears), so it takes two
// clicks, like Quit. ask: when the first click only asks (by default, as said above).
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
// Rollback queues work; archiving is a separate, two-click action after its report.
function rollbackButtons(row, details, name, ref, inUse) {
  const r = room?.rollbacks?.find((r) => r.name === name);
  const b = document.createElement('button'); b.className = 'reopen';
  b.textContent = r && ['queued', 'running'].includes(r.status) ? 'Rollback ' + r.status : 'Archive with rollback';
  b.disabled = !!r && ['queued', 'running'].includes(r.status);
  b.title = 'Queue a worker rollback, including merged commits. Review its report before separately confirming archive; main stays yours to merge.';
  confirmed(b, () => send('/rollback ' + ref), 'Click again: queue rollback of this discussion’s implementation', () => true);
  row.append(b);
  if (r?.report) {
    const report = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Rollback report · ' + r.status; report.append(summary);
    const text = document.createElement('pre'); text.style.whiteSpace = 'pre-wrap'; text.textContent = r.report; report.append(text);
    details.append(report);
  }
  if (r?.status === 'ready') {
    const confirm = document.createElement('button'); confirm.className = 'reopen'; confirm.textContent = 'Confirm archive after rollback';
    confirm.disabled = !!inUse;
    confirm.title = inUse ? 'Switch to another discussion before confirming archive' : 'Review the rollback report first. Archive the discussion; merging its worker branch into main stays manual.';
    confirmed(confirm, () => send('/archive-rollback ' + ref), 'Click again: I reviewed the rollback report; archive', () => true);
    row.append(confirm);
  }
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
    openFiles();
  };
}
const expandedLines = new Set();
const expandedDiscussions = new Set();
let openRowMenu = null; // the discussion path whose ▾ Actions menu is open
let cachedDetail = { files: null, unviewable: new Set(), branch: null }; // files: null until the list loads

// The User's order of active discussions, kept in this browser per room (room.folder) as a JSON
// array of names. Discussions it does not list go on top, newest first; names gone are dropped.
const ORDER_KEY = 'agent-room.discussion-order:';
let dragging = false, renderAfterDrag = false; // the list is not replaced while a row is dragged
function readOrder(folder) {
  let raw = null;
  try { raw = localStorage.getItem(ORDER_KEY + folder); } catch {}
  let list = [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string'); } catch {}
  return { raw, list };
}
function saveOrder(folder, order) {
  try { localStorage.setItem(ORDER_KEY + folder, JSON.stringify(order)); } catch {}
}
function orderDiscussions(found, saved) {
  const here = new Set(found);
  const kept = [...new Set(saved)].filter((d) => here.has(d));
  const known = new Set(kept);
  return [...found.filter((d) => !known.has(d)), ...kept];
}
// Moves name to index in order, saves it and redraws (Move up / Move down, and a drop).
function moveDiscussion(order, name, index) {
  const next = order.filter((d) => d !== name);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, name);
  if (room?.folder) saveOrder(room.folder, next);
  renderDiscussions();
}
// A discussion moved out of or back into discussions/ loses its place: it returns on top.
function forgetOrder(name) {
  if (!room?.folder || !name) return;
  const { raw, list } = readOrder(room.folder);
  if (raw !== null && list.includes(name)) saveOrder(room.folder, list.filter((d) => d !== name));
}
if (typeof addEventListener === 'function') {
  addEventListener('storage', (e) => { if (room?.folder && e.key === ORDER_KEY + room.folder) renderDiscussions(); });
}

function updateTabs() {
  const tabExp = $('tab-explorer');
  if (tabExp) tabExp.classList.toggle('peeking', !!peek);
}

function discussionsIn(prefix) {
  const all = cachedDetail?.files || [];
  return [...new Set(all.filter((f) => f.startsWith(prefix + '/'))
    .map((f) => f.slice(prefix.length + 1)).filter((r) => r.includes('/')).map((r) => r.split('/')[0]))]
    .filter(isDiscussion).sort((a, b) => b.localeCompare(a));
}

function renderDiscussions() {
  const container = $('discussions-pane');
  if (!container) return;
  if (dragging) { renderAfterDrag = true; return; }
  const scroll = container.scrollTop;
  container.innerHTML = '<div id="disc-list"></div>';
  const list = container.firstChild;
  requestAnimationFrame(() => { container.scrollTop = scroll; });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const heading = (text) => list.append(el('h3', '', text));
  const canAct = room && localInput && !viewing;

  let discussions = discussionsIn('discussions');
  const ordered = !!room?.folder && Array.isArray(cachedDetail?.files);
  if (ordered) {
    const saved = readOrder(room.folder);
    discussions = orderDiscussions(discussions, saved.list);
    if (JSON.stringify(discussions) !== saved.raw) saveOrder(room.folder, discussions);
  }

  for (const o of (room?.open ?? []).filter((x) => !x.current && !x.active)) {
    const r = el('div', 'row discussion-row');
    const block = el('div', 'discussion-block');
    block.append(el('div', 'title', o.title));
    block.append(el('div', 'local-label', 'open' + (o.working ? ' · worker working' : '')));
    r.append(block);
    const b = el('button', 'reopen', 'Go to');
    b.onclick = () => { location.href = o.url; };
    r.append(b);
    list.append(r);
  }

  const currentWorker = room?.open?.find((o) => o.current)?.working ? ' · worker working' : '';
  if (room?.brainstorm && canAct) {
    list.append(el('span', 'hint', (room.multi ? 'A brainstorm is in progress: agent-room keeps no record of it. New discussion or Close discussion ends it.' : 'A brainstorm is in progress: agent-room keeps no record of it. New discussion or Resume ends it.') + currentWorker));
  } else if (!discussions.length && !replica?.received?.some((l) => !l.local)) {
    list.append(el('span', 'hint', (room?.started ? '' : 'No active discussions: your first message starts one.') + currentWorker));
  } else if (room && !room.started && canAct) {
    list.append(el('span', 'hint', 'Your first message starts a new discussion. To go back to one instead, choose Resume on its row.' + currentWorker));
  }

  heading('Discussions');
  const canOrder = canAct && ordered && discussions.length > 1;
  for (const [i, d] of discussions.entries()) {
    const path = 'discussions/' + d;
    const isCurrent = path === room?.active;
    const isPeeking = peek?.kind === 'local' && peek.path === path;
    const row = el('div', 'row discussion-row' + (isCurrent ? ' in-use' : '') + (isPeeking ? ' peeking' : ''));
    const block = el('div', 'discussion-block');
    if (canOrder) {
      const handle = el('span', 'drag-handle', '⠿');
      handle.title = 'Drag to reorder';
      handle.draggable = true;
      handle.addEventListener('dragstart', (e) => {
        dragging = true;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', d);
        e.dataTransfer.setDragImage?.(row, 0, 0);
        row.classList.add('dragging');
      });
      handle.addEventListener('dragend', () => {
        dragging = false;
        row.classList.remove('dragging');
        if (renderAfterDrag) { renderAfterDrag = false; renderDiscussions(); }
      });
      row.append(handle);
    }
    if (canOrder) {
      const after = (e) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
      const clear = () => row.classList.remove('drop-before', 'drop-after');
      row.addEventListener('dragover', (e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.toggle('drop-after', after(e));
        row.classList.toggle('drop-before', !after(e));
      });
      row.addEventListener('dragleave', clear);
      row.addEventListener('drop', (e) => {
        clear();
        const name = e.dataTransfer.getData('text/plain');
        if (!dragging || !discussions.includes(name)) return;
        e.preventDefault();
        const rest = discussions.filter((x) => x !== name);
        const next = rest.indexOf(d) + (after(e) ? 1 : 0);
        if (name !== d) { rest.splice(next, 0, name); saveOrder(room.folder, rest); }
        renderAfterDrag = true; // drawn on dragend, which follows the drop
      });
    }

    const nameBtn = el('button', 'entry discussion', d);
    nameBtn.onclick = () => {
      if (isCurrent) {
        peek = null;
        explorerMode = 'discussion';
        showSub('explorer');
        renderExplorer();
        renderDiscussions();
      } else {
        peek = { kind: 'local', path, name: d, readonly: false };
        explorerMode = 'discussion';
        showSub('explorer');
        renderExplorer();
        renderDiscussions();
      }
    };
    block.append(nameBtn);

    const openEntry = room?.open?.find((o) => o.active === path);
    const openHere = openEntry?.current ? null : openEntry;
    let statusText = '';
    if (isCurrent) statusText = 'current' + (room?.started ? ' · started' : '');
    else if (openHere) statusText = openHere.started ? 'open, paused' : 'not started';
    else statusText = 'paused';
    if (openEntry?.working) statusText += ' · worker working';
    block.append(el('div', 'local-label', statusText));
    row.append(block);

    if (canAct) {
      if (openHere && !openHere.started) {
        const b = el('button', 'reopen', 'Go to');
        b.title = 'Show this open discussion: it has not started yet';
        b.onclick = () => { location.href = openHere.url; };
        row.append(b);
      } else if (!isCurrent) {
        const b = el('button', 'reopen primary', 'Resume');
        b.title = resumeTip(d, openHere, null);
        b.onclick = (e) => { e.stopPropagation(); if (openHere) notesGuard(() => { location.href = openHere.url; }); else send('/resume ' + d); };
        row.append(b);
      }
      const menu = el('details', 'menu row-menu'), items = el('div', 'menu-items');
      menu.append(el('summary', '', 'Actions'), items);
      menu.open = openRowMenu === path;
      menu.addEventListener('toggle', () => { if (menu.open) openRowMenu = path; else if (openRowMenu === path) openRowMenu = null; });
      for (const [label, target] of [['Archive', 'archive'], ['Defer', 'deferred']]) {
        const b = el('button', '', label);
        b.disabled = isCurrent;
        b.title = isCurrent ? 'The discussion in use cannot be moved' : 'Move the whole discussion into ' + target + '/';
        b.onclick = () => { closeMenus(); send('/move ' + d + ' ' + target); };
        if (target === 'archive') archiveButton(b, d);
        items.append(b);
      }
      if (!(isCurrent && !room.started)) {
        const f = el('button', '', 'Start fresh'); freshButton(f, d); items.append(f);
      }
      if (ordered) {
        items.append(el('hr'));
        for (const [label, to, off] of [['Move up', i - 1, i === 0], ['Move down', i + 1, i === discussions.length - 1]]) {
          const b = el('button', '', label);
          b.disabled = off;
          b.onclick = () => { openRowMenu = null; closeMenus(); moveDiscussion(discussions, d, to); };
          items.append(b);
        }
      }
      items.append(el('hr'));
      rollbackButtons(items, block, d, d, isCurrent);
      row.append(menu);
    }
    list.append(row);
  }

  if (replica) {
    const remoteOnly = replica.received.filter((l) => !l.local && !discussions.some((d) => replica.own[d]?.discussion === l.discussion));
    if (remoteOnly.length) {
      heading('Received from peers · read-only');
      for (const line of remoteOnly) {
        const isPeeking = peek?.kind === 'received' && peek.discussion === line.discussion;
        const row = el('div', 'row discussion-row' + (isPeeking ? ' peeking' : ''));
        const block = el('div', 'discussion-block');
        const nameBtn = el('button', 'entry discussion', line.name || line.local || line.discussion);
        nameBtn.onclick = () => {
          peek = { kind: 'received', discussion: line.discussion, node: line.node, commit: line.commit, round: line.round, name: line.name || line.local || line.discussion };
          explorerMode = 'discussion';
          showSub('explorer');
          renderExplorer();
          renderDiscussions();
        };
        block.append(nameBtn);
        block.append(el('div', 'local-label', line.node + ' · round ' + line.round));
        row.append(block);

        const peekBtn = el('button', 'reopen', 'Peek files');
        peekBtn.title = 'Peek at this received discussion’s files in Explorer';
        peekBtn.onclick = () => {
          peek = { kind: 'received', discussion: line.discussion, node: line.node, commit: line.commit, round: line.round, name: line.name || line.local || line.discussion };
          explorerMode = 'discussion';
          showSub('explorer');
          renderExplorer();
          renderDiscussions();
        };
        row.append(peekBtn);

        const viewBtn = el('button', 'reopen primary', 'View chat');
        viewBtn.title = 'View this peer’s discussion in full, read-only';
        viewBtn.onclick = () => viewRemote(line);
        row.append(viewBtn);

        list.append(row);
      }
    }
  }

  heading('Archive and deferred');
  for (const s of ['archive', 'deferred']) {
    const sList = discussionsIn('discussions/' + s);
    const details = el('details', 'section-group');
    details.open = expandedDiscussions.has(s);
    details.ontoggle = () => { if (details.open) expandedDiscussions.add(s); else expandedDiscussions.delete(s); };
    const summary = el('summary', '', (s === 'archive' ? 'Archived' : 'Deferred') + ' (' + sList.length + ')');
    details.append(summary);
    if (!sList.length) {
      details.append(el('span', 'hint', s === 'archive' ? 'No archived discussions.' : 'No deferred discussions.'));
    }
    for (const d of sList) {
      const path = 'discussions/' + s + '/' + d;
      const isPeeking = peek?.kind === 'local' && peek.path === path;
      const row = el('div', 'row discussion-row' + (isPeeking ? ' peeking' : ''));
      const block = el('div', 'discussion-block');
      const nameBtn = el('button', 'entry discussion', d);
      nameBtn.onclick = () => {
        peek = { kind: 'local', path, name: d, readonly: true };
        explorerMode = 'discussion';
        showSub('explorer');
        renderExplorer();
        renderDiscussions();
      };
      block.append(nameBtn);
      block.append(el('div', 'local-label', s === 'archive' ? 'archived' : 'deferred'));
      row.append(block);

      if (canAct) {
        const b = el('button', 'reopen primary', 'Resume');
        b.title = 'Resume: makes it active first';
        b.onclick = (e) => { e.stopPropagation(); send('/resume ' + s + '/' + d); };
        row.append(b);

        const menu = el('details', 'menu row-menu'), items = el('div', 'menu-items');
        menu.append(el('summary', '', 'Actions'), items);
        menu.open = openRowMenu === path;
        menu.addEventListener('toggle', () => { if (menu.open) openRowMenu = path; else if (openRowMenu === path) openRowMenu = null; });

        const makeActive = el('button', '', 'Make active');
        makeActive.onclick = () => { closeMenus(); send('/move ' + s + '/' + d + ' active'); };
        items.append(makeActive);

        const otherSection = s === 'archive' ? 'deferred' : 'archive';
        const moveOther = el('button', '', otherSection === 'archive' ? 'Archive' : 'Defer');
        moveOther.onclick = () => { closeMenus(); send('/move ' + s + '/' + d + ' ' + otherSection); };
        if (otherSection === 'archive') archiveButton(moveOther, s + '/' + d);
        items.append(moveOther);

        const fresh = el('button', '', 'Start fresh');
        freshButton(fresh, s + '/' + d);
        items.append(fresh);

        items.append(el('hr'));
        rollbackButtons(items, block, d, s + '/' + d, false);
        row.append(menu);
      }
      details.append(row);
    }
    list.append(details);
  }
}

async function renderExplorer() {
  const container = $('pane');
  if (!container) return;
  const scroll = container.scrollTop;
  container.innerHTML = '<div id="files"></div>';
  const list = container.firstChild;
  requestAnimationFrame(() => { container.scrollTop = scroll; });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  if (peek) {
    const banner = el('div', 'peek-banner');
    const note = el('span', '', 'Looking at ');
    const bold = el('b', '', peek.name);
    note.append(bold);
    banner.append(note);
    const backBtn = el('button', '', 'Back to current');
    backBtn.onclick = () => {
      peek = null;
      updateTabs();
      renderExplorer();
      renderDiscussions();
    };
    banner.append(backBtn);
    list.append(banner);
  }

  const bar = el('div', 'explorer-bar');
  const hasDisc = hasDiscussionTree();
  const effMode = effectiveExplorerMode();

  const btnDisc = el('button', effMode === 'discussion' ? 'on' : '', 'Discussion');
  btnDisc.title = "This discussion's own files: notes, drawings, transcripts, attachments. Always read from the room's folder (discussions/<name>/).";
  btnDisc.disabled = !hasDisc;
  btnDisc.onclick = () => { explorerMode = 'discussion'; renderExplorer(); };

  const btnRoot = el('button', effMode === 'root' ? 'on' : '', 'Room checkout');
  const roomFolder = (room?.folder || 'agent-room').replace(/[/]+$/, '').split('/').pop() || 'agent-room';
  const roomBranchName = cachedDetail?.branch || room?.code?.branch || 'main';
  btnRoot.title = "The project as it is in the room's folder (" + roomFolder + "/, branch " + roomBranchName + "): what you have merged, plus your own uncommitted edits.";
  btnRoot.onclick = () => { explorerMode = 'root'; renderExplorer(); };

  const btnWorker = el('button', '', 'Worker copy');
  btnWorker.disabled = true;
  btnWorker.title = 'Coming soon';

  bar.append(btnDisc, btnRoot, btnWorker);
  list.append(bar);

  const subline = el('div', 'explorer-sub');
  if (effMode === 'root') {
    subline.textContent = roomFolder + '/ · ' + roomBranchName;
  } else {
    if (peek?.kind === 'received') {
      subline.textContent = peek.name + ' (' + peek.node + ')';
    } else {
      const activePath = peek?.kind === 'local' ? peek.path : room?.active;
      subline.textContent = activePath ? activePath + '/' : '';
    }
  }
  list.append(subline);

  const renderFileEntry = (parent, name, fullPath, clickHandler) => {
    const cantShow = cachedDetail.unviewable?.has(fullPath) || BINARY_FILE.test(fullPath);
    const shown = !cantShow && fullPath === doc;
    const b = el('button', 'entry file' + (cantShow ? ' unviewable' : shown ? ' shown' : ''), name + (cantShow ? " · can't be shown here" : ''));
    if (cantShow) {
      b.disabled = true;
      b.title = "can't be shown here";
    } else {
      b.onclick = () => clickHandler(fullPath);
      if (shown) {
        b.classList.add('shown');
        b.setAttribute('aria-current', 'true');
      }
    }
    parent.append(b);
  };

  const renderTreeNested = (parent, items, prefix, clickHandler) => {
    const folders = [...new Set(items.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
    const files = items.filter((f) => !f.includes('/')).sort();

    for (const folder of folders) {
      const folderKey = prefix + '/' + folder;
      const details = el('details', 'inline-folder');
      details.open = expandedLines.has(folderKey);
      details.ontoggle = () => { if (details.open) expandedLines.add(folderKey); else expandedLines.delete(folderKey); };
      details.append(el('summary', '', folder + '/'));
      const subItems = items.filter((f) => f.startsWith(folder + '/')).map((f) => f.slice(folder.length + 1));
      renderTreeNested(details, subItems, folderKey, clickHandler);
      parent.append(details);
    }

    const fileBox = files.length > 10 ? el('div', 'file-columns') : parent;
    for (const name of files) {
      const fullPath = prefix + '/' + name;
      renderFileEntry(fileBox, name, fullPath, clickHandler);
    }
    if (fileBox !== parent) parent.append(fileBox);
  };

  const renderTree = (items, prefix, clickHandler) => {
    const folders = [...new Set(items.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
    const files = items.filter((f) => !f.includes('/')).sort();

    for (const folder of folders) {
      const folderKey = (prefix ? prefix + '/' : '') + folder;
      const details = el('details', 'inline-folder');
      details.open = expandedLines.has(folderKey);
      details.ontoggle = () => { if (details.open) expandedLines.add(folderKey); else expandedLines.delete(folderKey); };
      details.append(el('summary', '', folder + '/'));
      const subItems = items.filter((f) => f.startsWith(folder + '/')).map((f) => f.slice(folder.length + 1));
      renderTreeNested(details, subItems, folderKey, clickHandler);
      list.append(details);
    }

    const fileBox = files.length > 10 ? el('div', 'file-columns') : list;
    for (const name of files) {
      const fullPath = (prefix ? prefix + '/' : '') + name;
      renderFileEntry(fileBox, name, fullPath, clickHandler);
    }
    if (fileBox !== list) list.append(fileBox);
    if (!folders.length && !files.length) {
      list.append(el('span', 'hint', 'No files yet.'));
    }
  };

  if (effMode === 'root') {
    const rootFiles = (cachedDetail.files || []).filter((f) => !inDiscussion(f));
    renderTree(rootFiles, '', (fullPath) => post('__show', { file: fullPath }));
  } else {
    if (peek?.kind === 'received') {
      let rfiles = [];
      try {
        rfiles = await (await fetch('__rfiles?d=' + encodeURIComponent(peek.discussion) + '&n=' + encodeURIComponent(peek.node) + '&c=' + encodeURIComponent(peek.commit || ''))).json();
      } catch {}
      renderTree(rfiles, '', (relPath) => {
        const fullReceivedPath = '__received/' + peek.discussion + '/' + peek.node + '/' + peek.commit + '/' + relPath;
        showDoc(fullReceivedPath);
      });
    } else {
      const basePath = peek?.kind === 'local' ? peek.path : room?.active;
      if (!basePath) {
        list.append(el('span', 'hint', 'No discussion open: choose Room checkout above.'));
      } else {
        const discFiles = (cachedDetail.files || []).filter((f) => f.startsWith(basePath + '/')).map((f) => f.slice(basePath.length + 1));
        renderTree(discFiles, basePath, (fullPath) => {
          if (peek?.readonly) showDoc(fullPath);
          else post('__show', { file: fullPath });
        });
      }
    }
  }
}

async function openFiles() {
  try {
    const res = await fetch('__files?detail=1');
    const raw = res.ok ? await res.json() : null;
    if (Array.isArray(raw)) cachedDetail = { files: raw, unviewable: new Set(), branch: null };
    else if (Array.isArray(raw?.files)) cachedDetail = { files: raw.files, unviewable: new Set(raw.unviewable || []), branch: raw.branch || null };
  } catch {}
  updateTabs();
  renderDiscussions();
  await renderExplorer();
}
// The header: the room's folder name, its full root path (in the tooltip) and its active discussion.
let room = null;
function setRoom(r) {
  const changed = room && r && room.active !== r.active;
  room = r;
  if (changed) { peek = null; updateTabs(); }
  renderAutoDev();
  $('room-name').textContent = r.folder?.replace(/[/]+$/, '').split('/').pop() || r.folder || 'agent-room';
  $('disc').textContent = r.discussion || '';
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
// Member editor state is independent of the DOM, so automatic names and ordering have one rule.
function memberPlan(agents, worker, currentWorker = worker) {
  const providers = ['claude', 'codex', 'agy'];
  const display = (p) => p[0].toUpperCase() + p.slice(1);
  const rows = agents.map((a) => ({ ...a, active: true,
    automatic: new RegExp('^' + display(a.provider) + '[0-9]*$', 'i').test(a.name) }));
  function freeName(provider, skip) {
    const base = display(provider), used = new Set([worker.name, currentWorker.name, ...rows.filter((r) => r !== skip).map((r) => r.name)].map((n) => n.toLowerCase()));
    const duplicate = rows.some((r) => r !== skip && r.provider === provider);
    let n = duplicate ? 2 : 0, name = n ? base + n : base;
    while (used.has(name.toLowerCase())) { n = n ? n + 1 : 2; name = base + n; }
    return name;
  }
  while (rows.length < 3) {
    const provider = providers.find((p) => !rows.some((r) => r.provider === p)) || 'claude';
    rows.push({ provider, name: freeName(provider, null), model: '', active: false, automatic: true });
  }
  return {
    rows,
    setProvider(i, provider) { const row = rows[i]; row.provider = provider; row.model = ''; if (row.automatic) row.name = freeName(provider, row); },
    setName(i, name) { rows[i].name = name; rows[i].automatic = false; },
    toggle(i, checked) { if (!checked && rows[i].active && rows.filter((r) => r.active).length <= 2) return false; rows[i].active = checked; return true; },
    locked(i) { return rows[i].active && rows.filter((r) => r.active).length <= 2; },
    selected() { return rows.filter((r) => r.active).map(({ provider, name, model }) => ({ provider, name: name.trim(), model })); },
  };
}
function agentRow(parent, a, models, title, member = null) {
  const row = document.createElement('div'); row.className = 'agent-row' + (member ? ' member-row' : '');
  const field = (text, el) => { const label = document.createElement('label'); label.textContent = member ? text : title + ' ' + text; label.append(el); row.append(label); return el; };
  let checked;
  if (member) { checked = field('On', document.createElement('input')); checked.type = 'checkbox'; checked.parentElement.className = 'member-toggle'; checked.checked = a.active; }
  const provider = field('provider', document.createElement('select'));
  for (const p of ['claude', 'codex', 'agy']) provider.add(new Option(p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'agy', p));
  provider.value = a.provider;
  const name = field('name', document.createElement('input')); name.value = a.name; name.required = !member || a.active;
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
  provider.onchange = () => { if (member) { member.provider(provider.value); name.value = a.name; } choices(''); member?.refresh(); };
  name.oninput = () => { if (member) { member.name(name.value); member.refresh(); } };
  model.onchange = () => { custom.parentElement.hidden = model.value !== '__custom'; };
  if (member) checked.onchange = () => { member.toggle(checked.checked); member.refresh(); };
  function refresh() {
    if (!member) return;
    checked.checked = a.active; checked.disabled = member.locked();
    name.required = a.active; row.dataset.active = String(a.active);
    name.classList.toggle('auto-name', a.automatic);
  }
  refresh(); parent.append(row);
  return { row, refresh, get: () => ({ name: name.value.trim(), provider: provider.value, model: model.value === '__custom' ? custom.value.trim() : model.value }),
    active: () => !member || checked.checked, incomplete: () => (!member || checked.checked) && model.value === '__custom' && !custom.value.trim() };
}
function selectedSettings(data) {
  return data.started ? data.launchDefaults ?? data.defaults ?? data.settings : data.settings;
}
function memberPanelAgents(data) {
  const current = data.settings.agents;
  return current.length < 2 || current.length > 3 ? current : selectedSettings(data).agents;
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
      if (scope === 'talk') selected.agents = memberPanelAgents(data);
      if (scope === 'work') selected.worker = data.settings.worker;
      const parent = $(scope + '-agent-rows'); parent.replaceChildren();
      const agents = scope === 'talk' ? selected.agents : [selected.worker];
      const note = $('talk-member-note');
      if (scope === 'talk' && agents.length >= 2 && agents.length <= 3) {
        const plan = memberPlan(agents, selected.worker, data.settings.worker), controls = [];
        const refresh = () => { controls.forEach((c) => c.refresh()); note.hidden = !plan.rows.some((r, i) => plan.locked(i)); };
        note.textContent = 'At least two members. To swap one, tick the new row first, then untick the old one.';
        plan.rows.forEach((a, i) => controls.push(agentRow(parent, a, data.models, 'Agent ' + (i + 1), {
          provider: (p) => plan.setProvider(i, p), name: (n) => plan.setName(i, n),
          toggle: (on) => plan.toggle(i, on), locked: () => plan.locked(i), refresh,
        })));
        settingsRows[scope] = controls; refresh();
      } else {
        if (scope === 'talk') { note.textContent = 'This discussion has ' + agents.length + ' agents, set outside this panel; members can be chosen here only for 2 or 3.'; note.hidden = false; }
        settingsRows[scope] = agents.map((a, i) => agentRow(parent, a, data.models, scope === 'talk' ? 'Agent ' + (i + 1) : 'Worker'));
      }
      hint.textContent = scope === 'work' ? (data.started ? 'Changes apply to this discussion only' : 'Changes apply to this discussion, and the default for new ones') + ', starting with the next instruction. A running instruction finishes with its current settings. Switching provider carries the Worker conversation into a fresh session.' : data.started ? 'Changes save automatically for future rooms. Active sessions keep their settings.' : 'Changes save automatically and apply to this room before any agent starts.';
    } catch (err) { result.textContent = 'Could not load settings: ' + err.message; }
  };
  function saveChanges() {
    if (!settingsRows[scope]) return;
    // Choosing Custom opens its text field; persist once a model ID has been entered.
    if (settingsRows[scope].some((row) => row.incomplete())) {
      result.textContent = 'Enter a custom model ID to save this choice.';
      return;
    }
    const choices = settingsRows[scope].filter((row) => row.active()).map((row) => row.get());
    result.textContent = 'Saving…';
    // Serialize saves from both tabs so a quick second change cannot overwrite a newer choice.
    settingsSave = settingsSave.then(async () => {
      const latest = await fetch('__settings');
      if (!latest.ok) throw new Error(await latest.text());
      const latestData = await latest.json(), settings = selectedSettings(latestData);
      if (scope === 'talk' && choices.some((a) => a.name.toLowerCase() === latestData.settings.worker.name.toLowerCase()))
        throw new Error('Each member and the worker need a different name.');
      if (scope === 'talk') settings.agents = choices; else settings.worker = choices[0];
      settings.scope = scope;
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
  if (mode === 'tab') return notesGuard(() => location.assign(url.href), () => { menu.value = ''; menu.hidden = true; });
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
// Attachments: files chosen with Attach wait beside the composer (each removable) and go with the
// next message, which is sent only once the server has saved them all (see sayWithFiles); on failure
// the text and the files stay here. Only in a started discussion, never in a brainstorm.
const ATTACH_LIMIT = 25 * 1024 * 1024, ATTACH_TOTAL = 250 * 1024 * 1024;
const sizeText = (n) => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
function renderAttachments() {
  const chips = pending.map((f, i) => {
    const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = f.name + ' · ' + sizeText(f.size);
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Remove this attachment'; x.disabled = attaching;
    x.onclick = () => { pending.splice(i, 1); renderAttachments(); };
    chip.append(x); return chip;
  });
  if (attaching) chips.push(document.createTextNode('Saving the attachments…'));
  $('attachments').replaceChildren(...chips);
  $('attach').disabled = attaching || !room?.active;
}
$('attach').onclick = () => $('attach-input').click();
$('attach-input').onchange = (e) => { pending.push(...e.target.files); e.target.value = ''; renderAttachments(); };
const base64 = (file) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => fail(r.error || new Error('could not read ' + file.name));
  r.readAsDataURL(file);
});
async function sendWithFiles() {
  if (attaching || ended) return;
  const text = box.value.trim();
  const fail = (message) => status('✗ ' + message + ' Nothing was sent.', true);
  if (text.startsWith('/')) return fail('Attachments go with a message, not a command.');
  const big = pending.find((f) => f.size > ATTACH_LIMIT);
  if (big) return fail(big.name + ' is over 25 MB.');
  if (pending.reduce((n, f) => n + f.size, 0) > ATTACH_TOTAL) return fail('Over 250 MB at once: attach fewer files per message.');
  attaching = true; renderAttachments();
  try {
    const files = await Promise.all(pending.map(async (f) => ({ name: f.name, data: await base64(f) })));
    const res = await post('__say', { text, files });
    if (!res.ok) return status('✗ ' + await res.text(), true);
    box.value = ''; pending = [];
  } catch (err) { fail("Couldn't send the attachments: " + err.message + '.'); }
  finally { attaching = false; renderAttachments(); }
}
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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (pending.length) return sendWithFiles(); send(box.value); box.value = ''; }
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
  el.textContent = m ? 'on\\n' + (m[1] === today ? '' : m[1] + ' ') + m[2] : checked ? 'checked ' + hhmm(checked) : '';
  el.title = (at?.measured ? 'Measured by the quota meter at ' + at.measured + '. ' : '') +
    (checked ? 'The room last asked the meter at ' + hhmm(checked) + ' (every minute, and after each turn).' : '');
  return el;
}
// The monitor's warnings per provider (monitorView in ui.mjs): a ⚠ right of the provider's name,
// amber or red, only on a problem; hovering or focusing the name shows the problems, then the state.
let monitor = {}, lastQuota = [undefined, null];
const longDate = (iso) => { const d = new Date(iso); return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + hhmm(d); };
const startTime = (iso) => { const d = new Date(iso); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ') + hhmm(d); };
function providerHealth(provider) {
  const m = monitor[provider];
  if (!m) return null;
  const name = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
  const problems = [], state = []; // lines: [text, red?] or a list of { text, code }
  let level = null;
  const problem = (text, red) => { problems.push([text, red]); level = red || level === 'red' ? 'red' : 'amber'; };
  const l = m.login, ends = l?.expiresAt ? longDate(l.expiresAt) : null;
  if (!l) state.push('login not checked yet');
  else if (l.state === 'unmonitored') state.push('login not monitored');
  else if (l.state === 'out') { problem('logged out', true); state.push('logged out'); }
  else if (l.state === 'expired') { problem('login expired on ' + ends, true); state.push(name + ' reports login ended ' + ends); }
  else if (l.state === 'unknown') { problem('login status unknown: ' + l.error); state.push('login status unknown'); }
  else {
    if (l.state === 'ending') problem('login ends ' + ends + ', in 2 days or less');
    state.push(ends ? name + ' reports login ends ' + ends : 'logged in, no expiry given');
  }
  if (m.leftovers.length) {
    const n = m.leftovers.length;
    problem(n + ' program' + (n === 1 ? '' : 's') + ' left over (alive after a crash or Restart)');
    for (const o of m.leftovers) {
      problems.push([{ text: 'PID ' + o.pid + ' · ' + o.agent + ' · room ' + o.room + ' · started ' + startTime(o.started) }]);
      problems.push(o.unverified
        ? [{ text: 'unverified: its leader is gone, or a start time cannot be read, so the number may have been reused. Look at it: ', code: 'ps -g ' + o.pid }]
        : [{ text: 'stop it: ', code: 'kill -TERM -' + o.pid }]);
    }
  }
  state.push(m.running + ' running now in this room');
  const box = document.createElement('span'); box.className = 'hover-detail'; box.setAttribute('role', 'tooltip');
  const line = (content, cls) => {
    const el = document.createElement('span'); if (cls) el.className = cls;
    if (typeof content === 'string') el.textContent = content;
    else { el.append(content.text); if (content.code) { const c = document.createElement('code'); c.textContent = content.code; el.append(c); } }
    box.append(el);
  };
  for (const [p, red] of problems) line(typeof p === 'string' ? 'Problem: ' + p : p, typeof p === 'string' ? 'problem' + (red ? ' red' : '') : '');
  state.forEach((t, i) => line((i ? '' : 'State: ') + t));
  return { level, box };
}
// A provider's name, with its ⚠ and its details.
function providerName(provider, display = provider, health = true) {
  const b = document.createElement('b'); b.textContent = display;
  const h = health ? providerHealth(provider) : null;
  if (!h) return b;
  b.tabIndex = 0;
  if (h.level) { const a = document.createElement('span'); a.className = 'alert' + (h.level === 'red' ? ' red' : ''); a.textContent = '⚠'; b.append(a); }
  b.append(h.box);
  return b;
}
function showMonitor(view) { monitor = view ?? {}; showQuota(...lastQuota); }
function showQuota(gauges, at) {
  lastQuota = [gauges, at];
  const box = $('gauges');
  box.textContent = '';
  // Providers with no gauges (meter not reachable, or used by no agent here but with a leftover).
  const bare = (shown) => Object.keys(monitor).filter((p) => !shown.has(p)).forEach((p) => {
    const h = providerHealth(p);
    if (!h?.level) return;
    const group = document.createElement('span'); group.className = 'quota'; group.append(providerName(p)); box.append(group);
  });
  if (gauges === undefined) return bare(new Set()); // not read yet
  if (gauges === null || !gauges.length) { box.textContent = 'quota meter not reachable'; box.append(' · ', quotaUpdated({ checked: at?.checked })); return bare(new Set()); }
  box.append(quotaUpdated(at));
  let provider = null, groupName = null, group = null;
  for (const g of gauges) {
    if (g.provider !== provider || (g.group ?? null) !== groupName) {
      provider = g.provider; groupName = g.group ?? null;
      group = document.createElement('span'); group.className = 'quota';
      group.append(providerName(provider, groupName ?? provider, groupName !== 'argon'));
      if (groupName !== 'argon' && monitor[provider]?.running != null) {
        const running = document.createElement('span'); running.className = 'running';
        running.textContent = monitor[provider].running + ' running';
        group.append(running);
      }
      box.append(group);
    }
    const el = document.createElement('span');
    // Highlighted by what is left: yellow under 30%, red under 10%.
    const left = 100 - g.used;
    el.className = 'gauge' + (left < 10 ? ' high' : left < 30 ? ' warn' : '');
    if (g.label === '5h') el.style.gridRow = '1';
    if (g.label === 'week') el.style.gridRow = '2';
    el.tabIndex = 0;
    el.innerHTML = '<span></span><span class="bar"><i></i></span><span></span>';
    el.children[0].textContent = g.label === 'week' ? 'wk' : g.label;
    el.children[1].firstChild.style.width = Math.min(100, Math.max(0, g.used)) + '%';
    el.children[2].textContent = g.used + '%';
    const tip = document.createElement('span'); tip.className = 'hover-detail'; tip.setAttribute('role', 'tooltip');
    if (g.label === '5h' && g.resets) {
      const reset = document.createElement('strong'); reset.textContent = 'Resets at ' + g.resets; tip.append(reset);
    }
    const info = document.createElement('span');
    info.textContent = provider + (groupName ? ' ' + groupName : '') + ' ' + g.label + ': ' + g.used + '% used' + (g.label !== '5h' && g.resets ? ', at ' + g.resets : '');
    tip.append(info);
    el.append(tip);
    group.append(el);
  }
  bare(new Set(gauges.map((g) => g.provider)));
}
// The ▾ menus (the header's and Explorer's discussion rows): one open at a time; a click outside or
// Escape closes them. Actions that open something else close their menu; the two-click ones keep it
// open for the second click.
const menus = () => [...document.querySelectorAll('details.menu')];
document.addEventListener('toggle', (e) => { const m = e.target; if (m.matches?.('details.menu') && m.open) menus().forEach((o) => { if (o !== m) o.open = false; }); }, true);
const closeMenus = () => menus().forEach((m) => { m.open = false; });
document.addEventListener('click', (e) => { if (!e.target.closest('details.menu')) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
for (const id of ['switchroom', 'newroom', 'reload', 'summary']) $(id).addEventListener('click', closeMenus);
// On the screen with several discussions, New discussion asks twice only when it ends a brainstorm,
// and New brainstorm only when it discards one.
const brainstormOpen = () => !!room?.open?.some((o) => o.brainstorm);
confirmed($('newdisc'), () => send('/new'), null, () => (room?.multi ? brainstormOpen() : room?.started));
confirmed($('newbrainstorm'), () => send('/brainstorm'), null, () => (room?.multi ? brainstormOpen() : room?.started));
confirmed($('closedisc'), () => send('/close'), 'Click again: this discussion closes (its agents stop)', () => !!room?.started);
$('summary').onclick = () => send('/summary');
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
    yourTurn = !ev.thinking; setThinking(ev.thinking); if (!viewing) { showDoc(ev.doc); openFiles(); }
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
    work.clear();
    if (!ev.worker.length) work.add(statusEl('Give the worker instructions here. It works alongside the discussion and sees only what you send it.'));
    ev.worker.forEach((m) => workMessage(m, false));
    if (ev.status) status(ev.status);
    setWorking(ev.working);
    if (!ev.workInput) { $('wcomposer').hidden = true; }
    setWorkerInfo(ev.workerInfo);
    monitor = ev.monitor ?? {};
    showQuota(ev.quota, ev.quotaAt);
    if (ev.room) { retryId = ev.room.retryId ?? null; updateRetry(); showFailedAgents(ev.room.failedAgents); setRoom(ev.room); }
    $('newroom').hidden = !ev.newRoom;
    replicaOff = ev.replicaOff ?? null;
    showReplica(ev.replica);
  }
  if (ev.type === 'replica') showReplica(ev.replica);
  if (ev.type === 'room') { retryId = ev.room.retryId ?? null; updateRetry(); showFailedAgents(ev.room.failedAgents); setRoom(ev.room); openFiles(); } // its buttons and "in use" follow
  if (ev.type === 'work') workMessage(ev.message, true);
  if (ev.type === 'quota') showQuota(ev.gauges, ev.at);
  if (ev.type === 'monitor') showMonitor(ev.monitor);
  if (ev.type === 'working') setWorking(ev.name);
  if (ev.type === 'workerinfo') setWorkerInfo(ev.info);
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') { yourTurn = true; status(ev.text); updateReplicaView(); }
  if (ev.type === 'note') {
    status(ev.text, ev.error);
    if (ev.error && pendingArchives.size) {
      pendingArchives.clear();
      openFiles();
    }
  }
  if (ev.type === 'doc' && !viewing) showDoc(ev.file);
  if (ev.type === 'files') { showSub('explorer'); openFiles(); }
  if (ev.type === 'moved') {
    pendingArchives.delete(ev.from);
    forgetOrder(ev.from?.split('/').pop());
    openFiles();
  }
  if (ev.type === 'goto') { location.href = ev.url; return; } // this window switches discussion
  if (ev.type === 'ended') { ended = true; status('This room has ended. You can close this window.'); events.close(); box.disabled = true; wbox.disabled = true; }
  if (ev.type === 'restarting') { restarting = true; status('Restarting the server: this page reloads when the new one answers.'); events.close(); box.disabled = true; wbox.disabled = true; }
};

// The terminal pane (host-shell.mjs, after ghostty-web's demo): opening it fetches the token and
// opens a WebSocket, and the server starts a fresh shell; collapsing it or reloading the page
// closes the socket, and the server ends the shell. Shown only in pages opened on this computer
// (the server refuses the others anyway).
const SHELL_LABEL = 'Terminal (this computer only)';
let hostShell = null;
if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) $('hostshell').hidden = false;
// Opening the terminal collapses Notes, after asking about unsaved changes there.
$('hostshell-toggle').onclick = () => (hostShell ? closeHostShell() : notesGuard(() => { closeNotes(); openHostShell(); }));
function closeHostShell() {
  try { hostShell.ws?.close(); } catch {}
  try { hostShell.term?.dispose(); } catch {}
  hostShell = null; $('hostshell-term').hidden = true; $('hostshell-term').replaceChildren();
  $('hostshell-toggle').textContent = '▸ ' + SHELL_LABEL; $('hostshell-toggle').setAttribute('aria-expanded', 'false');
}
async function openHostShell() {
  const box = $('hostshell-term'); box.hidden = false;
  $('hostshell-toggle').textContent = '▾ ' + SHELL_LABEL; $('hostshell-toggle').setAttribute('aria-expanded', 'true');
  // Open from the first click: a click while it loads collapses it, and each step below stops then.
  const shell = hostShell = { term: null, ws: null };
  const { init, Terminal, FitAddon } = await import('./__shell/ghostty-web.js');
  await init();
  if (hostShell !== shell) return; // collapsed meanwhile
  const term = shell.term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', cursorBlink: true });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(box); fit.fit(); fit.observeResize();
  let token;
  try {
    const r = await fetch('__shell/token', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + await r.text());
    token = (await r.json()).token;
  } catch (err) { term.write('\\r\\nNo terminal: ' + err.message + '\\r\\n'); return; }
  if (hostShell !== shell) return; // collapsed meanwhile
  const params = new URLSearchParams({ token, cols: term.cols, rows: term.rows });
  const ws = shell.ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + location.pathname.replace(/[^/]*$/, '') + '__shell/ws?' + params);
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => { if (hostShell === shell) term.write('\\r\\n\\x1b[31mConnection closed. Collapse and open the pane for a new shell.\\x1b[0m\\r\\n'); };
  term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  term.focus();
}

// The Notes pane (notes.mjs): the User's notes for this room's folder, on this computer only. A note
// is saved only by Save. Unsaved changes are never dropped without asking: inside the pane before
// another note, New, collapsing, the terminal or another room; the browser's leave-page warning
// otherwise; a refresh after a code change keeps them (refreshPage).
const NOTES_LABEL = 'Notes (this computer only)';
const notes = { open: false, list: [], id: null, base: '', editing: false, session: 0 }; // id null: a new note; base: its saved text
// session: changed whenever the editor starts something else (setEditor, clearEditor, a read). A
// save or read response is applied to the editor only if the session it started in is still current;
// otherwise it only refreshes the list.
const noteText = $('notes-text');
const notesDirty = () => notes.editing && noteText.value !== notes.base;
function noteDraft() { return notesDirty() ? { id: notes.id, base: notes.base, text: noteText.value } : null; }
if (['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
  $('notes').hidden = false;
  if (noteDraftKept) openNotes(noteDraftKept);
}
addEventListener('beforeunload', (e) => { if (notesDirty() && !refreshing) { e.preventDefault(); e.returnValue = ''; } });
function notesStatus(text, error) { $('notes-status').textContent = text; $('notes-status').className = error ? 'error' : ''; }
// A question inside the pane: buttons [label, act]; any button closes it.
function notesAsk(text, buttons) {
  $('notes-ask-text').textContent = text;
  $('notes-ask-buttons').replaceChildren(...buttons.map(([label, act]) => {
    const b = document.createElement('button'); b.textContent = label;
    b.onclick = () => { $('notes-ask').hidden = true; act?.(); };
    return b;
  }));
  $('notes-ask').hidden = false;
  $('notes-ask-buttons').lastChild.focus(); // the safe choice: Keep editing, Cancel
}
const noteTitle = () => noteText.value.split('\\n')[0].replace(/^\\s*#+\\s*/, '').trim() || 'Untitled';
// Runs act now, or once the User agrees to discard the unsaved changes (cancel: if they don't).
function notesGuard(act, cancel) {
  if (!notesDirty()) return act();
  if (!notes.open) openNotes();
  notesAsk('"' + noteTitle() + '" has unsaved changes.', [
    ['Discard changes', () => { noteText.value = notes.base; act(); }],
    ['Keep editing', () => { cancel?.(); noteText.focus(); }],
  ]);
}
function setEditor(id, text, base = text) {
  Object.assign(notes, { id, base, editing: true }); notes.session++;
  noteText.value = text; noteText.disabled = false;
  $('notes-save').disabled = $('notes-remove').disabled = false;
  $('notes-remove').textContent = id ? 'Remove' : 'Discard';
  showNoteList();
}
function clearEditor() {
  Object.assign(notes, { id: null, base: '', editing: false }); notes.session++;
  noteText.value = ''; noteText.disabled = true;
  $('notes-save').disabled = $('notes-remove').disabled = true;
  $('notes-ask').hidden = true; notesStatus('');
  showNoteList();
}
function showNoteList() {
  const list = $('notes-list');
  if (!notes.list.length) { list.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'No notes yet.' })); return; }
  list.replaceChildren(...notes.list.map((n) => {
    const b = document.createElement('button'); b.className = 'note' + (n.id === notes.id ? ' on' : '');
    b.textContent = n.title; b.title = n.title;
    b.append(Object.assign(document.createElement('span'), { className: 'when', textContent: 'Saved ' + new Date(n.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }));
    b.onclick = () => { if (n.id !== notes.id) notesGuard(() => readNote(n.id)); };
    return b;
  }));
}
async function loadNotes() {
  const r = await fetch('__notes', { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  notes.list = await r.json(); showNoteList();
}
async function readNote(id) {
  const session = ++notes.session; // a later click on another note wins, whichever answer comes first
  try {
    const r = await fetch('__notes/read?id=' + encodeURIComponent(id), { cache: 'no-store' });
    if (!r.ok) throw new Error(await r.text());
    const n = await r.json();
    if (notes.session !== session) return loadNotes().catch(() => {});
    setEditor(n.id, n.text); notesStatus('');
  } catch (err) { if (notes.session === session) notesStatus('✗ ' + err.message, true); loadNotes().catch(() => {}); }
}
async function openNotes(draft) {
  if (hostShell) closeHostShell();
  notes.open = true; $('notes-body').hidden = false;
  $('notes-toggle').textContent = '▾ ' + NOTES_LABEL; $('notes-toggle').setAttribute('aria-expanded', 'true');
  if (draft) setEditor(draft.id, draft.text, draft.base);
  try { await loadNotes(); } catch (err) { return notesStatus('✗ Notes: ' + err.message, true); }
  if (!draft) return;
  if (draft.id && !notes.list.some((n) => n.id === draft.id)) { setEditor(null, draft.text, ''); return notesStatus('Kept your unsaved text; its note was removed meanwhile, so Save makes it a new note.'); }
  notesStatus('Kept your unsaved changes from before the page refreshed.');
}
function closeNotes() {
  if (!notes.open) return;
  clearEditor(); notes.open = false; $('notes-body').hidden = true;
  $('notes-toggle').textContent = '▸ ' + NOTES_LABEL; $('notes-toggle').setAttribute('aria-expanded', 'false');
}
$('notes-toggle').onclick = () => (notes.open ? notesGuard(closeNotes) : openNotes());
$('notes-new').onclick = () => notesGuard(() => { setEditor(null, ''); notesStatus('A new note: the first line is its title. Nothing is saved until Save.'); noteText.focus(); });
$('notes-save').onclick = async () => {
  const text = noteText.value, id = notes.id, session = notes.session, title = noteTitle();
  const current = () => notes.session === session; // still the editing session this save started in
  $('notes-save').disabled = true;
  try {
    const r = await post(id ? '__notes/save' : '__notes/new', id ? { id, text } : { text });
    if (!current() && (r.ok || r.status === 404)) return loadNotes().catch(() => {}); // a failure is still reported below
    if (r.status === 404) { setEditor(null, noteText.value, ''); return notesStatus('✗ That note was removed elsewhere: Save again keeps this text as a new note.', true); }
    if (!r.ok) throw new Error(await r.text());
    const n = await r.json();
    setEditor(n.id, noteText.value, text);
    notesStatus('Saved ' + new Date(n.savedAt).toLocaleTimeString() + '.');
    await loadNotes();
  } catch (err) { notesStatus('✗ ' + (current() ? 'Not saved: ' : '"' + title + '" was not saved: ') + err.message, true); }
  finally { $('notes-save').disabled = !notes.editing; }
};
$('notes-remove').onclick = () => {
  if (!notes.id) return notesAsk('Discard this new note? It was never saved.', [['Discard', clearEditor], ['Cancel']]);
  const id = notes.id, session = notes.session, title = noteTitle();
  const current = () => notes.session === session; // as in Save: still the editing session it was asked in
  notesAsk('Remove "' + title + '"? Its file is deleted from this computer.', [['Remove', async () => {
    try {
      const r = await post('__notes/remove', { id });
      if (!r.ok && r.status !== 404) throw new Error(await r.text());
      if (current()) { clearEditor(); notesStatus('Removed.'); }
      // A later session: its text stays; if it shows the removed note, it becomes an unsaved new one.
      else if (notes.id === id) { setEditor(null, noteText.value, ''); notesStatus('✗ That note was removed elsewhere: Save again keeps this text as a new note.', true); }
    } catch (err) { notesStatus('✗ ' + (current() ? 'Not removed: ' : '"' + title + '" was not removed: ') + err.message, true); }
    loadNotes().catch(() => {});
  }], ['Cancel']]);
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

// Attachments to a discussion message: saved into its files/ folder, each file at most 25 MB. They
// travel base64-encoded inside /__say's JSON body (so the same-page check applies), at most
// ATTACH_TOTAL bytes per message.
export const ATTACH_LIMIT = 25 * 1024 * 1024;
export const ATTACH_TOTAL = 250 * 1024 * 1024;
const attachName = (name) => String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '').trim() || 'file';
// Saves files ([{ name, data: base64 }]) into folder, created if missing. A name already there is saved
// as name-2.ext, name-3.ext, …: nothing is overwritten. All or nothing: on any failure, the files saved
// by this call are removed and the error is thrown. Returns the names saved, in order.
export function saveAttachments(folder, files) {
  const blobs = files.map((f) => {
    const name = attachName(f?.name);
    if (typeof f?.data !== 'string') throw new Error(`${name}: no content.`);
    const data = Buffer.from(f.data, 'base64');
    if (data.length > ATTACH_LIMIT) throw new Error(`${name} is over 25 MB.`);
    return { name, data };
  });
  const saved = [];
  try {
    mkdirSync(folder, { recursive: true });
    for (const { name, data } of blobs) {
      const ext = extname(name), stem = name.slice(0, name.length - ext.length);
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
        try { writeFileSync(join(folder, candidate), data, { flag: 'wx' }); saved.push(candidate); break; } catch (err) {
          if (err.code === 'EEXIST') continue;
          try { rmSync(join(folder, candidate), { force: true }); } catch {} // created by this call, partly written
          throw err;
        }
      }
    }
  } catch (err) {
    removeAttachments(folder, saved);
    throw err;
  }
  return saved;
}
const removeAttachments = (folder, names) => { for (const f of names) rmSync(join(folder, f), { force: true }); };

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
  if (handleShell(req, res, url)) return true; // the terminal pane (host-shell.mjs)
  if (handleNotes(req, res, url, dir)) return true; // the Notes pane (notes.mjs)
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
    if (url.searchParams.get('detail') === '1') {
      const unviewable = files.filter((f) => {
        const full = servable(dir, f, screen);
        return full ? !isViewable(full) : false;
      });
      const branch = roomBranch(dir);
      send(200, 'application/json', JSON.stringify({ files, unviewable, branch }));
      return true;
    }
    send(200, 'application/json', JSON.stringify(files));
    return true;
  }
  if (url.pathname === '/__settings') {
    if (!screen.getSettings || !screen.saveSettings) { send(409, 'text/plain', 'Settings are unavailable in this room.'); return true; }
    if (req.method === 'GET') {
      Promise.resolve().then(() => screen.getSettings()).then(
        (settings) => send(200, 'application/json', JSON.stringify(settings)),
        (err) => send(500, 'text/plain; charset=utf-8', err.message));
      return true;
    }
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
  if (['/__say', '/__show', '/__work', '/__workerinfo', '/__newroom', '/__retry', '/__agent-enabled'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req, url.pathname === '/__say' ? ATTACH_TOTAL * 1.4 : undefined).then((body) => {
      if (url.pathname === '/__newroom') {
        if (!screen.newRoom) return send(409, 'text/plain; charset=utf-8', 'This room can\'t open another one.');
        // {}: the chooser's answer; { token }: Create room for that answer (see newRoom in ui.mjs).
        return screen.newRoom(body ?? {}).then((r) => send(200, 'application/json', JSON.stringify(r)),
          (err) => send(err.status ?? 500, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__show') {
        const target = typeof body?.file === 'string' ? servable(dir, body.file, screen) : null;
        if (!target || !isViewable(target)) return send(404, 'text/plain; charset=utf-8', 'No such document.');
        screen.doc = body.file;
        broadcast(screen, { type: 'doc', file: body.file });
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__workerinfo') { // the Worker tab is shown: recheck its branches (sent as a workerinfo event)
        screen.refreshWorker?.();
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__agent-enabled') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before changing discussion agents.');
        if (!screen.setAgentEnabled) return send(409, 'text/plain', 'Discussion agent controls are unavailable.');
        return Promise.resolve().then(() => screen.setAgentEnabled(body?.name, body?.enabled)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__retry') {
        if (!screen.retryWork) return send(409, 'text/plain', 'Retry is unavailable.');
        return Promise.resolve(screen.retryWork(body?.id, body?.settings)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__work') {
        if (!screen.work) return send(409, 'text/plain; charset=utf-8', 'This room has no worker input; the page only watches.');
        if (typeof body?.text !== 'string' || !body.text.trim()) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
        screen.work(body.text.trim());
        return send(204, 'text/plain', '');
      }
      if (!screen.say) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal; the page only watches.');
      const files = Array.isArray(body?.files) && body.files.length ? body.files : null;
      if (typeof body?.text !== 'string' || (!body.text.trim() && !files)) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
      // While another node's line is open in View, it is read-only: only these commands pass.
      if (screen.isViewing?.(req.headers['x-view-client']) && !VIEW_COMMANDS.includes(body.text.trim())) return send(409, 'text/plain; charset=utf-8', `Read-only: you are viewing a received line. Go back to this node's line first.`);
      if (files) return sayWithFiles(body.text.trim(), files, body.confirmed === true);
      const warning = screen.say(body.text.trim(), body.confirmed === true);
      if (typeof warning === 'string') return send(409, 'text/plain; charset=utf-8', warning);
      send(204, 'text/plain', '');
    });
    return true;
  }
  // A message with attachments: every file is saved into the discussion's files/ first, and their
  // paths are appended to the text; if any save fails, or the message isn't taken, nothing stays saved.
  function sayWithFiles(text, files, confirmed) {
    const fail = (status, message) => send(status, 'text/plain; charset=utf-8', message + ' Nothing was sent.');
    const active = screen.room?.active;
    if (!active || screen.room.brainstorm) return fail(409, 'Attachments need a started discussion (not a brainstorm).');
    if (text.startsWith('/')) return fail(400, 'Attachments go with a message, not a command.');
    const folder = join(dir, active, 'files');
    let saved;
    try { saved = saveAttachments(folder, files); } catch (err) { return fail(/over 25 MB/.test(err.message) ? 413 : 400, `Couldn't save the attachments: ${err.message}`); }
    const line = (text ? text + '\n\n' : '') + 'Attached: ' + saved.map((f) => 'files/' + f).join(', ');
    let warning;
    try { warning = screen.say(line, confirmed); } catch (err) { warning = err.message; }
    if (typeof warning === 'string') { removeAttachments(folder, saved); return fail(409, warning); }
    send(204, 'text/plain', '');
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
// page when a discussion is resumed or started afresh.
export function resetEvent(screen) {
  return { type: 'reset', messages: screen.transcript.map(messageView), doc: screen.doc,
    thinking: screen.thinking, status: screen.status, input: !!screen.say,
    room: screen.room ?? null, worker: screen.workerForPage?.() ?? screen.worker ?? [], working: screen.working ?? null, workInput: !!screen.work, workerInfo: screen.workerInfo ?? null,
    quota: screen.quota, quotaAt: screen.quotaAt ?? null, monitor: screen.monitor ?? null, newRoom: !!screen.newRoom, page: PAGE,
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
  const type = TYPES[extname(file).toLowerCase()] ?? (isTextFile(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  sendDoc(type, readFileSync(file));
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
