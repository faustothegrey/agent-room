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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

// The file at rel if it is a non-hidden file inside dir (no ../ escapes), else null.
function inside(dir, rel) {
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep) || rel.split('/').some((p) => p.startsWith('.'))) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
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
function page(title, body, watch, home = '<a href="/">all files</a>', mtime = '/__mtime?f=') {
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
  const t = await (await fetch(${JSON.stringify(mtime)} + encodeURIComponent(${JSON.stringify(watch)}))).text();
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
//     active: its folder under the root or null, started: first message sent, transcript: this
//     session's transcript, under the root, or null } for the header,
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
#header { grid-column: 1 / -1; display: grid; grid-template-columns: auto minmax(180px, 1fr) auto auto; gap: .65rem 1rem; align-items: center; padding: .5rem .8rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#header > b { font-size: .85rem; letter-spacing: -.02em; }
#room-location { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: .15rem; }
#newroom { font-size: .75rem; white-space: nowrap; }
#folder { font-family: ui-monospace, monospace; font-size: .75rem; overflow-wrap: anywhere; line-height: 1.35; }
#disc { font-size: .75rem; color: var(--dim); line-height: 1.35; }
#disc[data-active="true"] { color: #60a5fa; font-weight: 600; }
#server { font-size: .7rem; color: var(--dim); display: inline-flex; align-items: center; gap: .4rem; }
#server[data-state="down"] { color: #ef4444; font-weight: 600; }
#beat { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
#server[data-state="up"] #beat { background: #22c55e; } #server[data-state="down"] #beat { background: #ef4444; }
#beat.on { animation: beat 1.2s ease-out; } /* restarted on every answer, so each pulse is a real heartbeat */
@keyframes beat { 0% { transform: scale(1.4); box-shadow: 0 0 0 0 #22c55eaa; } 100% { transform: scale(1); box-shadow: 0 0 0 8px #22c55e00; } }
@media (prefers-reduced-motion: reduce) { #beat.on { animation: none; } }
#gauges .updated { white-space: nowrap; }
#files .hint { display: block; margin: 0 0 .8rem; }
#gauges { display: flex; gap: .8rem; align-items: center; font-size: .65rem; color: var(--dim); }
.gauge { display: grid; grid-template-columns: 2rem 32px 2rem auto; gap: .3rem; align-items: center; line-height: 1.5; }
.quota { display: grid; grid-template-columns: auto 1fr; gap: .05rem .55rem; align-items: center; border-left: 1px solid var(--line); padding-left: .8rem; }
.gauge .bar { width: 32px; height: 6px; border-radius: 3px; background: #8883; overflow: hidden; }
.gauge .bar i { display: block; height: 100%; background: #10b981; }
.gauge.warn { color: #eab308; } .gauge.warn .bar i { background: #eab308; }
.gauge.high { color: #ef4444; font-weight: 600; } .gauge.high .bar i { background: #ef4444; }
.quota b { color: CanvasText; font-weight: 600; grid-column: 1; grid-row: 1 / span 2; text-transform: capitalize; font-size: .7rem; }
.quota .gauge { grid-column: 2; }
.gauge .resets { opacity: .8; white-space: nowrap; }
@media (max-width: 1150px) {
  #header { grid-template-columns: auto minmax(0, 1fr) auto; gap: .4rem .8rem; }
  #gauges { grid-column: 1 / -1; grid-row: 2; justify-content: flex-end; flex-wrap: wrap; }
}
@media (max-width: 600px) {
  #header { grid-template-columns: 1fr auto; }
  #room-location { grid-column: 1 / -1; grid-row: 2; }
  #gauges { grid-row: 3; justify-content: flex-start; }
  .quota { padding-left: .5rem; }
}
.tools label { display: inline-flex; gap: .3rem; align-items: center; color: var(--dim); }
#left { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#tabs { display: flex; border-bottom: 1px solid var(--line); }
.tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: .45rem .9rem; font-size: .9rem; }
.tab.on { border-bottom-color: #3b82f6; font-weight: 600; }
.tab.news::after { content: ' •'; color: #3b82f6; }
.view { flex: 1; display: flex; flex-direction: column; min-height: 0; } .view[hidden] { display: none; }
#split { cursor: col-resize; background: var(--line); background-clip: content-box; padding: 0 3px; touch-action: none; }
#split:hover, #split:focus-visible, body.resizing #split { background-color: #3b82f6; outline: none; }
body.resizing { cursor: col-resize; user-select: none; }
body.resizing iframe { pointer-events: none; } /* the document would swallow the drag */
.chat { flex: 1; overflow-y: auto; padding: 1rem; }
.msg { margin: 0 0 .9rem; padding: .5rem .75rem; border-radius: 8px; background: #8881; }
.msg.user { background: #3b82f622; } .msg.error { background: #ef444422; }
.msg.summary { background: #10b98122; border-left: 3px solid #10b981; } .msg.summary.not-agreed { background: #f59e0b22; border-left-color: #f59e0b; }
.who { font-weight: 600; font-size: .85rem; margin-bottom: .2rem; } .who .meta { font-weight: 400; color: var(--dim); }
.msg p { margin: .3rem 0; } .msg pre { overflow-x: auto; } .msg img { max-width: 100%; }
.status { color: var(--dim); font-size: .85rem; margin: .4rem 0 .9rem; white-space: pre-wrap; }
.status.error { color: #ef4444; }
.composer { border-top: 1px solid var(--line); padding: .6rem; }
.box { width: 100%; min-height: 3.2rem; resize: vertical; font: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid var(--line); }
.tools { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; font-size: .85rem; }
.hint { color: var(--dim); flex: 1; }
button { font: inherit; font-size: .85rem; padding: .2rem .6rem; border-radius: 6px; border: 1px solid var(--line); background: #8882; cursor: pointer; }
#right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#bar { display: flex; gap: .6rem; align-items: center; padding: .4rem .6rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#current { color: var(--dim); } #feed { margin-left: auto; }
#pane { flex: 1; min-height: 0; }
#doc { border: 0; width: 100%; height: 100%; }
.empty { display: grid; place-items: center; color: var(--dim); height: 100%; padding: 1rem; text-align: center; }
#files { padding: 1rem; overflow-y: auto; height: 100%; }
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
<header id="header"><b>agent-room</b><div id="room-location"><span id="folder" title="The room's root folder"></span><span id="disc" title="The active discussion"></span><span id="server"><i id="beat"></i><span id="server-text">Connecting to the server…</span></span></div><span id="gauges" aria-label="Subscription usage"></span><button id="newroom" title="Choose a folder and open a new room there, in a new window. This room keeps running.">New room in folder…</button></header>
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
    <div class="chat" id="chat"></div>
    <div class="composer" id="composer">
      <textarea class="box" id="box" placeholder="Message the agents (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit"></textarea>
      <div class="tools" style="justify-content: flex-end">
        <label title="After every round in which an agent spoke, the agents agree a short summary"><input type="checkbox" id="auto"> Auto-summarize</label>
        <button id="summary">Summarize</button><button id="usage">Usage</button><button id="reload">Reload</button><button id="restart" title="Start a new server on this address, in the discussion in use, from its handoff. The chat clears.">Restart</button><button id="quit">Quit</button></div>
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
    <div class="chat" id="wchat"></div>
    <div class="composer" id="wcomposer">
      <textarea class="box" id="wbox" placeholder="Instructions for the worker (Enter sends, Shift+Enter for a new line). It sees only what you send here; it can edit files and run commands."></textarea>
      <div class="tools"><span class="hint" id="whint"></span></div>
    </div>
  </div>
</div>
<div id="split" role="separator" aria-orientation="vertical" aria-label="Resize the chat and the document" tabindex="0" title="Drag to resize"></div>
<div id="right">
  <div id="bar"><button id="docs">Discussions</button><span id="current">No document shown.</span><button id="feed" hidden title="Ask the agents to read this transcript in full">Send to agents</button></div>
  <div id="pane"><div class="empty">The agents can talk without a document. Pick one with Discussions (or /docs) to watch it live.</div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pane = $('pane'), box = $('box'), wbox = $('wbox');
let ended = false, doc = null, tab = 'talk', page = null;
// Refreshing the page keeps what was being typed in the two message boxes.
function refreshPage() {
  sessionStorage.setItem('drafts', JSON.stringify([box.value, wbox.value]));
  location.reload();
}
try { [box.value, wbox.value] = JSON.parse(sessionStorage.getItem('drafts')) ?? ['', '']; } catch {}
sessionStorage.removeItem('drafts');

// A chat list that keeps its "is thinking" line last and follows new messages when already at the bottom.
function makeChat(list) {
  let thinking = null;
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const add = (el) => { const stick = atBottom(); list.insertBefore(el, thinking); if (stick) list.scrollTop = list.scrollHeight; };
  return {
    add,
    clear() { list.textContent = ''; thinking = null; },
    think(text) {
      thinking?.remove(); thinking = null;
      if (!text) return;
      thinking = document.createElement('div'); thinking.className = 'status'; thinking.textContent = text;
      const stick = atBottom(); list.append(thinking); if (stick) list.scrollTop = list.scrollHeight;
    },
  };
}
const talk = makeChat($('chat')), work = makeChat($('wchat'));
function bubble(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.speaker === 'User' ? ' user' : '') + (m.error ? ' error' : '')
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
  (name === 'work' ? wbox : box).focus();
}
$('tab-talk').onclick = () => showTab('talk');
$('tab-work').onclick = () => showTab('work');
function workMessage(m, live) {
  work.add(bubble(m));
  if (live && m.speaker !== 'User' && tab !== 'work') $('tab-work').classList.add('news');
}
function setWorking(name) {
  work.think(name ? '… ' + name + ' is working' : null);
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
  if (m.pass || m.hidden) return; // passes and summary turns are hidden, as in the terminal
  talk.add(bubble(m));
}
function status(text, error) { talk.add(statusEl(text, error)); }
function setThinking(name) {
  talk.think(name ? '… ' + name + ' is thinking' : null);
}
const urlFor = (file) => '/' + file.split('/').map(encodeURIComponent).join('/');
function showDoc(file) {
  doc = file || null;
  // Send to agents, on a transcript of an earlier session (not this one): a normal message asking
  // the agents to read it as background; its old sessions are not resumed.
  const feed = $('feed');
  const p = doc ? doc.split('/') : [];
  const transcript = p.length >= 3 && p.length <= 5 && p[0] === 'discussions' && p.at(-2) === 'transcripts' && p.at(-1).endsWith('.md');
  feed.hidden = !transcript || !room || doc === room.transcript || $('composer').hidden;
  feed.onclick = () => {
    showTab('talk');
    const root = room.folder.endsWith('/') ? room.folder : room.folder + '/';
    send('Please read this transcript of an earlier session in full, as background for our discussion: ' + root + file);
  };
  $('current').textContent = doc ? doc : 'No document shown.';
  if (!doc) return;
  listed = null;
  pane.innerHTML = '<iframe id="doc"></iframe>';
  pane.firstChild.src = urlFor(doc);
  document.title = doc + ' · agent-room';
}
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
let listed = null; // the list path shown in the pane ('' for the top), or null when a document is shown
async function openFiles(group) {
  if (typeof group !== 'string') group = ''; // as a click handler, group is the event
  listed = group;
  $('feed').hidden = true;
  const files = await (await fetch('/__files')).json();
  pane.innerHTML = '<div id="files"></div>';
  const list = pane.firstChild;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  // A row in the list: a discussion, a folder or a file, with an optional grey tag after its name.
  const entry = (kind, label, onclick, tag, title) => {
    const b = el('button', 'entry ' + kind, label); b.onclick = onclick;
    if (tag) b.append(el('span', 'tag', tag));
    if (title) b.title = title;
    list.append(b);
  };
  const heading = (text) => list.append(el('h3', '', text));
  const inUse = (path) => path === room?.active;
  const discussionsIn = (prefix) => [...new Set(files.filter((f) => f.startsWith(prefix + '/'))
    .map((f) => f.slice(prefix.length + 1)).filter((r) => r.includes('/')).map((r) => r.split('/')[0]))]
    .filter(isDiscussion).sort((a, b) => b.localeCompare(a));
  const canAct = room && !$('composer').hidden;
  const back = (label, to) => { const b = el('button', 'back', '← ' + label); b.onclick = () => openFiles(to); list.append(b); };
  const title = (text, status, cls) => { const t = el('div', 'title', text); if (status) t.append(el('span', 'status ' + (cls || ''), status)); list.append(t); };

  if (group === 'discussions/archive' || group === 'discussions/deferred') { // archive/ or deferred/: their discussions
    const section = group.split('/')[1];
    back('All discussions', '');
    title(section === 'archive' ? 'Archive' : 'Deferred');
    const found = discussionsIn(group);
    if (!found.length) list.append(el('span', 'hint', section === 'archive' ? 'No archived discussions.' : 'No deferred discussions.'));
    for (const d of found) entry('discussion', d, () => openFiles(group + '/' + d));
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
      // Re-open: not for the discussion in use before anything was said in it (nothing to restart).
      if (!(inUse(group) && !room.started)) {
        const label = disc.section ? 'Re-open (makes it active)' : 'Re-open';
        const b = action(label, () => {
          // Once this session has started, re-opening ends it (the chat clears): two clicks, like Quit.
          if (room.started && !b.dataset.armed) {
            b.dataset.armed = '1'; b.textContent = 'Click again: this session ends and the chat clears';
            return setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
          }
          send('/reopen ' + disc.ref);
        }, 'A fresh session in this discussion: the agents start from its handoff. Its documents and transcripts stay.', 'primary');
      }
      // Moving the whole discussion; not the one in use (its transcript is open there).
      if (!inUse(group)) {
        if (actions.children.length) actions.append(el('span', 'sep'));
        if (disc.section) action('Make active', () => send('/move ' + disc.ref + ' active'), 'Move it back to the active discussions');
        if (disc.section !== 'archive') action('Archive', () => send('/move ' + disc.ref + ' archive'), 'Move the whole discussion into archive/');
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
      entry('file', r, () => post('/__show', { file: f }), f === room?.transcript ? 'this session' : f === doc ? 'shown' : '');
    }
    return;
  }
  // The top: active discussions, the room's own documents, then archive/ and deferred/.
  const discussions = discussionsIn('discussions');
  title('Discussions');
  if (!discussions.length) list.append(el('span', 'hint', room?.started ? '' : 'No active discussions: your first message starts one.'));
  else if (room && !room.started && canAct) list.append(el('span', 'hint', 'Your first message starts a new discussion. To go back to one instead, open it and choose Re-open.'));
  heading('Active');
  for (const d of discussions) entry('discussion', d, () => openFiles('discussions/' + d), inUse('discussions/' + d) ? 'in use' : '');
  const top = files.filter((f) => f.startsWith('discussions/')).map((f) => f.slice('discussions/'.length));
  const own = [...new Set(top.filter((r) => r.includes('/')).map((r) => r.split('/')[0]))].filter((n) => !isDiscussion(n) && !SECTIONS[n]).sort();
  const loose = top.filter((r) => !r.includes('/'));
  if (own.length || loose.length) {
    heading("This room's own documents");
    for (const d of own) entry('folder', d + '/', () => openFiles('discussions/' + d), '', 'Open this folder');
    for (const r of loose) entry('file', r, () => post('/__show', { file: 'discussions/' + r }), 'discussions/' + r === doc ? 'shown' : '');
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
  $('folder').textContent = r.folder;
  $('disc').textContent = r.discussion || '';
  $('disc').dataset.active = r.active ? 'true' : 'false';
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
      const res = await fetch('/__settings');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json(), selected = selectedSettings(data);
      const parent = $(scope + '-agent-rows'); parent.replaceChildren();
      const agents = scope === 'talk' ? selected.agents : [selected.worker];
      settingsRows[scope] = agents.map((a, i) => agentRow(parent, a, data.models, scope === 'talk' ? 'Agent ' + (i + 1) : 'Worker'));
      hint.textContent = data.started ? 'Changes save automatically for future rooms. Active sessions keep their settings.' : 'Changes save automatically and apply to this room before any agent starts.';
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
      const latest = await fetch('/__settings');
      if (!latest.ok) throw new Error(await latest.text());
      const settings = selectedSettings(await latest.json());
      if (scope === 'talk') settings.agents = choices; else settings.worker = choices[0];
      const res = await post('/__settings', settings);
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      result.textContent = saved.applied ? 'Saved.' : 'Saved for future rooms. This room keeps its settings.';
    }).catch((err) => { result.textContent = 'Could not save: ' + err.message; });
  }
  form.onchange = saveChanges;
  form.onsubmit = (e) => { e.preventDefault(); saveChanges(); };
}
// New room in folder…: the room's server shows the Mac's folder chooser and starts the new room.
$('newroom').onclick = async () => {
  // Opened during the click, so the browser doesn't block it; pointed at the new room below.
  const win = window.open('', '_blank', 'width=' + window.outerWidth + ',height=' + window.outerHeight);
  if (win) win.document.body.textContent = 'Choose a folder in the window that has just opened…';
  const res = await post('/__newroom', {});
  if (!res.ok) { win?.close(); return status('✗ New room: ' + await res.text(), true); }
  const r = await res.json();
  if (r.cancelled) { win?.close(); return; }
  if (win) win.location = r.url;
  status('Opened a new room in ' + r.folder + (win ? '' : ' at ' + r.url + ' (the browser blocked the new window)') + '. This room keeps running.');
};
async function send(text) {
  text = text.trim();
  if (!text || ended) return;
  if (text === '/docs') return openFiles();
  const res = await post('/__say', { text });
  if (!res.ok) status(await res.text(), true);
}
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(box.value); box.value = ''; }
});
async function sendWork(text) {
  text = text.trim();
  if (!text || ended) return;
  const res = await post('/__work', { text });
  if (!res.ok) work.add(statusEl(await res.text(), true));
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
    el.title = provider + ' ' + g.label + ': ' + g.used + '% used' + (g.resets ? ', resets ' + g.resets : '');
    el.innerHTML = '<span></span><span class="bar"><i></i></span><span></span><span class="resets"></span>';
    el.children[0].textContent = g.label;
    el.children[1].firstChild.style.width = Math.min(100, Math.max(0, g.used)) + '%';
    el.children[2].textContent = g.used + '%';
    // As the meter reports it (each CLI has its own format), without the time zone.
    if (g.resets) el.children[3].textContent = 'resets ' + g.resets.split(' (')[0];
    group.append(el);
  }
  box.append(quotaUpdated(at));
}
$('auto').onchange = async (e) => {
  const res = await post('/__auto', { on: e.target.checked });
  if (!res.ok) { status(await res.text(), true); e.target.checked = !e.target.checked; }
};
$('docs').onclick = openFiles;
$('summary').onclick = () => send('/summary');
$('usage').onclick = () => send('/usage');
$('reload').onclick = () => send('/reload');
// Two clicks to quit, so a stray click doesn't end the room.
$('quit').onclick = (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed) return send('/quit');
  b.dataset.armed = '1'; b.textContent = 'Click again to quit';
  setTimeout(() => { delete b.dataset.armed; b.textContent = 'Quit'; }, 3000);
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
  let h = null;
  try { h = await (await fetch('/__health', { cache: 'no-store', signal: AbortSignal.timeout(2500) })).json(); } catch {}
  const el = $('server'), text = $('server-text'), dot = $('beat');
  if (!h) {
    el.dataset.state = 'down';
    text.textContent = restarting ? 'Restarting the server…' : ended ? 'Server stopped' : 'Server not responding';
    el.title = 'Start it again from the Dock app (or npm start): this page reloads when it answers.';
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
const events = new EventSource('/__events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  // A reload that changed the page's code: refresh, so the page runs the new code too.
  if ((ev.type === 'reset' || ev.type === 'reloaded') && ev.page) {
    if (page && ev.page !== page) return refreshPage();
    page = ev.page;
  }
  if (ev.type === 'reset') {
    talk.clear();
    ev.messages.forEach(message);
    if (ev.status) status(ev.status);
    setThinking(ev.thinking); showDoc(ev.doc);
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
    work.clear();
    if (!ev.worker.length) work.add(statusEl('Give the worker instructions here. It works alongside the discussion and sees only what you send it.'));
    ev.worker.forEach((m) => workMessage(m, false));
    setWorking(ev.working);
    if (!ev.workInput) { $('wcomposer').hidden = true; }
    showQuota(ev.quota, ev.quotaAt);
    $('auto').checked = !!ev.auto;
    if (ev.room) setRoom(ev.room);
    $('newroom').hidden = !ev.newRoom;
  }
  if (ev.type === 'room') setRoom(ev.room);
  if (ev.type === 'work') workMessage(ev.message, true);
  if (ev.type === 'quota') showQuota(ev.gauges, ev.at);
  if (ev.type === 'auto') $('auto').checked = ev.on;
  if (ev.type === 'working') setWorking(ev.name);
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') status(ev.text);
  if (ev.type === 'note') status(ev.text, ev.error);
  if (ev.type === 'doc') showDoc(ev.file);
  if (ev.type === 'files') openFiles();
  if (ev.type === 'moved' && listed !== null) {
    openFiles(listed === ev.from || listed.startsWith(ev.from + '/') ? ev.to + listed.slice(ev.from.length) : listed);
  }
  if (ev.type === 'ended') { ended = true; status('The room has ended. You can close this tab.'); events.close(); box.disabled = true; wbox.disabled = true; }
  if (ev.type === 'restarting') { restarting = true; status('Restarting the server: this page reloads when the new one answers.'); events.close(); box.disabled = true; wbox.disabled = true; }
};
</script></body></html>`;

// Input endpoints accept only the page itself: same host, JSON. A page on another site can't send
// a JSON POST here without a CORS preflight, which this server never approves, and the Host check
// stops DNS-rebinding tricks. That matters because the agents act on what the User says.
function fromOwnPage(req) {
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
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
      startedAt: screen.startedAt ?? null, discussion: screen.room?.active ?? null }));
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
  if (['/__say', '/__show', '/__work', '/__auto', '/__newroom'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req).then((body) => {
      if (url.pathname === '/__newroom') {
        if (!screen.newRoom) return send(409, 'text/plain; charset=utf-8', 'This room can\'t open another one.');
        // Resolves when the User has chosen (or cancelled) and the new room answers: { url } or { cancelled }.
        return screen.newRoom().then((r) => send(200, 'application/json', JSON.stringify(r)),
          (err) => send(500, 'text/plain; charset=utf-8', err.message));
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
      screen.say(body.text.trim());
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
    room: screen.room ?? null, worker: screen.worker ?? [], working: screen.working ?? null, workInput: !!screen.work,
    auto: screen.auto ?? false, quota: screen.quota, quotaAt: screen.quotaAt ?? null, newRoom: !!screen.newRoom, page: PAGE };
}

// The page's own code, as a short hash: after a reload, open pages refresh only if it changed.
export const PAGE = createHash('sha1').update(SCREEN).digest('hex').slice(0, 12);

export function handle(req, res, dir, screen) {
  const url = new URL(req.url, 'http://localhost');
  if (screen && handleScreen(req, res, url, dir, screen)) return;
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/__mtime') {
    const rel = url.searchParams.get('f') ?? '';
    const stamp = rel ? servable(dir, rel, screen) && statSync(inside(dir, rel)).mtimeMs : docFiles(dir, screen).join('\n');
    return send(200, 'text/plain', String(stamp));
  }
  const rel = decodeURIComponent(url.pathname.slice(1));
  if (rel === '') {
    const items = docFiles(dir, screen).map((f) => `<li><a href="/${urlPath(f)}">${esc(f)}</a></li>`).join('');
    return send(200, 'text/html; charset=utf-8', page('all files', `<ul>${items}</ul>`, ''));
  }
  const file = servable(dir, rel, screen);
  if (!file) return send(404, 'text/plain; charset=utf-8', `Not found: ${rel}`);
  // A session transcript quotes whatever was said: its HTML is shown as text, never run.
  if (/\.md$/i.test(file)) return send(200, 'text/html; charset=utf-8', page(rel, ((/(^|\/)transcripts\//.test(rel)) ? mdText : md).parse(readFileSync(file, 'utf8')), rel));
  send(200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', readFileSync(file));
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
