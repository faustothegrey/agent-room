// Proposal viewer: handle() serves proposal/ over local HTTP, rendering Markdown with marked so
// images (and plain links to images) show inline; pick() is the terminal list behind /docs.
// It also serves the discussion screen (/__room, first cycle of proposal/discussion-ide.md): the
// header with the room and its participants; on the left two tabs, the discussion and the worker
// (one agent outside the round that carries out the User's instructions), each with a message box
// in UI mode; and on the right, when the User picks one, a proposal/ file watched live. In terminal
// mode (npm run terminal) the page only watches. Transcripts (on the right too) lists the rooms
// saved in the log folder and shows one, read-only.
// cli.mjs loads this module in load(), so /reload swaps it too.
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

// The page polls the file's mtime and reloads when an agent changes it.
function page(title, body, watch, home = '<a href="/">proposal/</a>', mtime = '/__mtime?f=') {
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

// The saved rooms in logDir, newest first: { file, path (absolute, for the agents to read), title
// (the agents), date (ISO), first (the start of the User's first message, to tell rooms apart), current }.
// A room's file is named after the time it started (ui.mjs), e.g. room-2026-11-02T09-15-56-854Z.md.
export function listTranscripts(logDir, currentFile) {
  let names = [];
  try { names = readdirSync(logDir).filter((f) => /^room-.*\.md$/.test(f)); } catch { return []; } // no log folder yet
  return names.sort().reverse().map((file) => {
    const m = /^room-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
    let text = '';
    try { text = readFileSync(join(logDir, file), 'utf8'); } catch {}
    const title = text.split('\n', 1)[0].replace(/^# Room — /, '');
    const said = /^\*\*User\*\*\n\n(.+)/m.exec(text)?.[1] ?? '';
    const first = said.length > 100 ? `${said.slice(0, 100)}…` : said;
    return { file, path: resolve(logDir, file), title, first, date: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null, current: file === currentFile };
  });
}

// ── The discussion screen ────────────────────────────────────────────────────────────────────
// `screen` is plain state kept by the caller across reloads:
// { clients: Set of open event streams, transcript: the room's entries, doc: file or null,
//   thinking: name or null, status: the last round's end line or null,
//   room: { folder, agents: [names], worker: name } for the header,
//   logDir: where transcripts are saved, logFile: this room's transcript (a file name in logDir),
//   worker: the worker tab's messages (messageView, plus meta: time and tokens),
//   working: the worker's name while it works, else null,
//   say: (line) => void and work: (text) => void, set only when the page is the input (UI mode) }.

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
#header { grid-column: 1 / -1; display: flex; gap: .8rem; align-items: baseline; padding: .45rem .8rem; border-bottom: 1px solid var(--line); font-size: .9rem; }
#header .who { color: var(--dim); }
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
#files button { display: block; width: 100%; text-align: left; margin: 0 0 .3rem; }
#files .first { display: block; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head><body>
<header id="header"><b>agent-room</b><span id="folder"></span><span class="who" id="who"></span></header>
<div id="left">
  <div id="tabs" role="tablist"><button class="tab on" id="tab-talk" role="tab">Discussion</button><button class="tab" id="tab-work" role="tab">Worker</button></div>
  <div class="view" id="talk">
    <div class="chat" id="chat"></div>
    <div class="composer" id="composer">
      <textarea class="box" id="box" placeholder="Message the agents (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit"></textarea>
      <div class="tools"><span class="hint" id="hint"></span>
        <button id="summary">Summarize</button><button id="usage">Usage</button><button id="reload">Reload</button><button id="quit">Quit</button></div>
    </div>
  </div>
  <div class="view" id="work" hidden>
    <div class="chat" id="wchat"></div>
    <div class="composer" id="wcomposer">
      <textarea class="box" id="wbox" placeholder="Instructions for the worker (Enter sends, Shift+Enter for a new line). It sees only what you send here; it can edit files and run commands."></textarea>
      <div class="tools"><span class="hint" id="whint"></span></div>
    </div>
  </div>
</div>
<div id="split" role="separator" aria-orientation="vertical" aria-label="Resize the chat and the document" tabindex="0" title="Drag to resize"></div>
<div id="right">
  <div id="bar"><button id="docs">Documents</button><button id="logs">Transcripts</button><span id="current">No document shown.</span><button id="feed" hidden title="Ask the agents to read this transcript in full">Send to agents</button></div>
  <div id="pane"><div class="empty">The agents can talk without a document. Pick one with Documents (or /docs) to watch it live.</div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pane = $('pane'), box = $('box'), hint = $('hint'), wbox = $('wbox');
let busy = false, ended = false, doc = null, tab = 'talk';

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
function setBusy(b) { busy = b; hint.textContent = b ? 'Agents are talking: what you send now waits for the round to end.' : ''; }
function message(m) {
  if (m.speaker === 'User') setBusy(true);
  if (m.pass || m.hidden) return; // passes and summary turns are hidden, as in the terminal
  talk.add(bubble(m));
}
function status(text, error) { talk.add(statusEl(text, error)); }
function setThinking(name) {
  talk.think(name ? '… ' + name + ' is thinking' : null);
  if (name) setBusy(true); // a round or a summary is running
}
const urlFor = (file) => '/' + file.split('/').map(encodeURIComponent).join('/');
function showDoc(file) {
  doc = file || null;
  $('feed').hidden = true;
  $('current').textContent = doc ? doc : 'No document shown.';
  if (!doc) return;
  pane.innerHTML = '<iframe id="doc"></iframe>';
  pane.firstChild.src = urlFor(doc);
  document.title = doc + ' · agent-room';
}
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// Transcripts are shown in this page only (picking a document is shared by every open page).
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
function showTranscript(t) {
  doc = null;
  // Send to agents: a normal message asking them to read the file (the old sessions aren't resumed).
  // Only where the page is the room's input, and not for this room's own transcript.
  const feed = $('feed');
  feed.hidden = $('composer').hidden || t.current;
  feed.onclick = () => {
    showTab('talk');
    send('Please read this transcript of an earlier room in full, as background for our discussion: ' + t.path);
  };
  const label = when(t.date) + (t.current ? ' (this room)' : '');
  $('current').textContent = 'Transcript: ' + label;
  pane.innerHTML = '<iframe id="doc"></iframe>';
  pane.firstChild.src = '/__transcript/' + encodeURIComponent(t.file);
  document.title = 'Transcript ' + label + ' · agent-room';
}
async function openTranscripts() {
  $('feed').hidden = true;
  const list = await (await fetch('/__transcripts')).json();
  pane.innerHTML = '<div id="files"></div>';
  const box = pane.firstChild;
  if (!list.length) { box.innerHTML = '<div class="empty">No saved transcripts yet.</div>'; return; }
  for (const t of list) {
    const b = document.createElement('button');
    b.innerHTML = '<b></b><span class="first"></span>';
    b.firstChild.textContent = when(t.date) + ' · ' + t.title + (t.current ? '  (this room)' : '');
    b.lastChild.textContent = t.first || '(nothing said)';
    b.onclick = () => showTranscript(t);
    box.append(b);
  }
}
async function openFiles() {
  $('feed').hidden = true;
  const files = await (await fetch('/__files')).json();
  pane.innerHTML = '<div id="files"></div>';
  const list = pane.firstChild;
  if (!files.length) { list.innerHTML = '<div class="empty">No files in proposal/ yet: they appear when an agent writes a proposal.</div>'; return; }
  for (const f of files) {
    const b = document.createElement('button');
    b.textContent = f + (f === doc ? '  (shown)' : '');
    b.onclick = () => post('/__show', { file: f });
    list.append(b);
  }
}
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
$('docs').onclick = openFiles;
$('logs').onclick = openTranscripts;
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
const events = new EventSource('/__events');
events.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'reset') {
    talk.clear();
    ev.messages.forEach(message);
    setBusy(!ev.status && ev.messages.some((m) => m.speaker === 'User'));
    if (ev.status) status(ev.status);
    setThinking(ev.thinking); showDoc(ev.doc);
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
    work.clear();
    if (!ev.worker.length) work.add(statusEl('Give the worker instructions here. It works alongside the discussion and sees only what you send it.'));
    ev.worker.forEach((m) => workMessage(m, false));
    setWorking(ev.working);
    if (!ev.workInput) { $('wcomposer').hidden = true; }
    if (ev.room) {
      $('folder').textContent = ev.room.folder;
      $('who').textContent = ev.room.agents.join(', ') + ' · worker: ' + ev.room.worker;
    }
  }
  if (ev.type === 'work') workMessage(ev.message, true);
  if (ev.type === 'working') setWorking(ev.name);
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') { status(ev.text); setBusy(false); }
  if (ev.type === 'note') status(ev.text, ev.error);
  if (ev.type === 'doc') showDoc(ev.file);
  if (ev.type === 'files') openFiles();
  if (ev.type === 'ended') { ended = true; status('The room has ended. You can close this tab.'); events.close(); box.disabled = true; wbox.disabled = true; }
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
  if (url.pathname === '/__files') {
    let files = [];
    try { files = listFiles(dir); } catch {} // no proposal/ yet
    send(200, 'application/json', JSON.stringify(files));
    return true;
  }
  if (url.pathname === '/__say' || url.pathname === '/__show' || url.pathname === '/__work') {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req).then((body) => {
      if (url.pathname === '/__show') {
        const file = typeof body?.file === 'string' && inside(dir, body.file) ? body.file : null;
        if (!file) return send(404, 'text/plain; charset=utf-8', 'No such file in proposal/.');
        screen.doc = file;
        broadcast(screen, { type: 'doc', file });
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
  if (url.pathname === '/__transcripts') {
    send(200, 'application/json', JSON.stringify(screen.logDir ? listTranscripts(screen.logDir, screen.logFile) : []));
    return true;
  }
  if (url.pathname.startsWith('/__transcript/') || url.pathname === '/__tmtime') {
    const name = url.pathname === '/__tmtime' ? url.searchParams.get('f') ?? '' : decodeURIComponent(url.pathname.slice('/__transcript/'.length));
    const file = screen.logDir && /^room-[^/]*\.md$/.test(name) ? inside(screen.logDir, name) : null;
    if (!file) { send(404, 'text/plain; charset=utf-8', `No such transcript: ${name}`); return true; }
    if (url.pathname === '/__tmtime') { send(200, 'text/plain', String(statSync(file).mtimeMs)); return true; }
    // The page reloads as the room's transcript grows, like a document.
    send(200, 'text/html; charset=utf-8', page(name, mdText.parse(readFileSync(file, 'utf8')), name, 'transcripts', '/__tmtime?f='));
    return true;
  }
  if (url.pathname !== '/__events') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  screen.clients.add(res);
  req.on('close', () => screen.clients.delete(res));
  // A page that (re)connects first gets everything so far, so it never shows a partial room.
  const reset = { type: 'reset', messages: screen.transcript.map(messageView), doc: screen.doc,
    thinking: screen.thinking, status: screen.status, input: !!screen.say,
    room: screen.room ?? null, worker: screen.worker ?? [], working: screen.working ?? null, workInput: !!screen.work };
  res.write(`data: ${JSON.stringify(reset)}\n\n`);
  return true;
}

export function handle(req, res, dir, screen) {
  const url = new URL(req.url, 'http://localhost');
  if (screen && handleScreen(req, res, url, dir, screen)) return;
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/__mtime') {
    const rel = url.searchParams.get('f') ?? '';
    const stamp = rel ? inside(dir, rel) && statSync(inside(dir, rel)).mtimeMs : listFiles(dir).join('\n');
    return send(200, 'text/plain', String(stamp));
  }
  const rel = decodeURIComponent(url.pathname.slice(1));
  if (rel === '') {
    const items = listFiles(dir).map((f) => `<li><a href="/${urlPath(f)}">${esc(f)}</a></li>`).join('');
    return send(200, 'text/html; charset=utf-8', page('all files', `<ul>${items}</ul>`, ''));
  }
  const file = inside(dir, rel);
  if (!file) return send(404, 'text/plain; charset=utf-8', `Not found: ${rel}`);
  if (/\.md$/i.test(file)) return send(200, 'text/html; charset=utf-8', page(rel, md.parse(readFileSync(file, 'utf8')), rel));
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
