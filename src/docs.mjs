// Proposal viewer: handle() serves proposal/ over local HTTP, rendering Markdown with marked so
// images (and plain links to images) show inline; pick() is the terminal list behind /docs.
// It also serves the discussion screen (/__room, first cycle of proposal/discussion-ide.md): the
// chat on the left, with a message box in UI mode, and on the right, when the User picks one, a
// proposal/ file watched live. In terminal mode (npm run terminal) the page only watches.
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
function page(title, body, watch) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>
:root { color-scheme: light dark; }
body { font: 16px/1.55 -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
img { max-width: 100%; } img.preview { display: block; margin: .5rem 0; }
pre, code { background: #8881; border-radius: 4px; } pre { padding: .75rem; overflow-x: auto; } code { padding: 0 .2em; }
table { border-collapse: collapse; } th, td { border: 1px solid #8886; padding: .3rem .6rem; }
nav { font-size: .85rem; opacity: .7; margin-bottom: 1rem; }
</style></head><body><nav><a href="/">proposal/</a> · ${esc(title)}</nav><main>${body}</main>
<script>
let last = null;
setInterval(async () => {
  const t = await (await fetch('/__mtime?f=' + encodeURIComponent(${JSON.stringify(watch)}))).text();
  if (last !== null && t !== last) location.reload();
  last = t;
}, 2000);
</script></body></html>`;
}

// ── The discussion screen ────────────────────────────────────────────────────────────────────
// `screen` is plain state kept by the caller across reloads:
// { clients: Set of open event streams, transcript: the room's entries, doc: file or null,
//   thinking: name or null, status: the last round's end line or null,
//   say: (line) => void, set only when the page is the room's input (UI mode) }.

// A transcript entry as the page shows it: the text rendered as Markdown.
export const messageView = (m) => ({ speaker: m.speaker, html: md.parse(m.text ?? ''), error: !!m.error, pass: !!m.pass });

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
body { margin: 0; height: 100vh; display: grid; grid-template-columns: minmax(320px, 38%) 1fr; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
#left { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
#chat { flex: 1; overflow-y: auto; padding: 1rem; }
.msg { margin: 0 0 .9rem; padding: .5rem .75rem; border-radius: 8px; background: #8881; }
.msg.user { background: #3b82f622; } .msg.error { background: #ef444422; }
.who { font-weight: 600; font-size: .85rem; margin-bottom: .2rem; }
.msg p { margin: .3rem 0; } .msg pre { overflow-x: auto; } .msg img { max-width: 100%; }
.status { color: var(--dim); font-size: .85rem; margin: .4rem 0 .9rem; white-space: pre-wrap; }
.status.error { color: #ef4444; }
#composer { border-top: 1px solid var(--line); padding: .6rem; }
#box { width: 100%; min-height: 3.2rem; resize: vertical; font: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid var(--line); }
#tools { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; font-size: .85rem; }
#hint { color: var(--dim); flex: 1; }
button { font: inherit; font-size: .85rem; padding: .2rem .6rem; border-radius: 6px; border: 1px solid var(--line); background: #8882; cursor: pointer; }
#right { display: flex; flex-direction: column; min-height: 0; }
#bar { display: flex; gap: .6rem; align-items: center; padding: .4rem .6rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#current { color: var(--dim); }
#pane { flex: 1; min-height: 0; }
#doc { border: 0; width: 100%; height: 100%; }
.empty { display: grid; place-items: center; color: var(--dim); height: 100%; padding: 1rem; text-align: center; }
#files { padding: 1rem; overflow-y: auto; height: 100%; }
#files button { display: block; width: 100%; text-align: left; margin: 0 0 .3rem; }
</style></head><body>
<div id="left">
  <div id="chat"></div>
  <div id="composer">
    <textarea id="box" placeholder="Message the agents (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /usage, /reload, /quit"></textarea>
    <div id="tools"><span id="hint"></span>
      <button id="usage">Usage</button><button id="reload">Reload</button><button id="quit">Quit</button></div>
  </div>
</div>
<div id="right">
  <div id="bar"><button id="docs">Documents</button><span id="current">No document shown.</span></div>
  <div id="pane"><div class="empty">The agents can talk without a document. Pick one with Documents (or /docs) to watch it live.</div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const chat = $('chat'), pane = $('pane'), box = $('box'), hint = $('hint');
let thinking = null, busy = false, ended = false, doc = null;
const atBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
function add(el) { const stick = atBottom(); chat.insertBefore(el, thinking); if (stick) chat.scrollTop = chat.scrollHeight; }
function setBusy(b) { busy = b; hint.textContent = b ? 'Agents are talking: what you send now waits for the round to end.' : ''; }
function message(m) {
  if (m.speaker === 'User') setBusy(true);
  if (m.pass) return; // passes are hidden, as in the terminal
  const el = document.createElement('div');
  el.className = 'msg' + (m.speaker === 'User' ? ' user' : '') + (m.error ? ' error' : '');
  el.innerHTML = '<div class="who"></div>' + m.html;
  el.firstChild.textContent = m.speaker + (m.error ? ' — failed' : '');
  add(el);
}
function status(text, error) { const el = document.createElement('div'); el.className = 'status' + (error ? ' error' : ''); el.textContent = text; add(el); }
function setThinking(name) {
  thinking?.remove(); thinking = null;
  if (!name) return;
  thinking = document.createElement('div'); thinking.className = 'status'; thinking.textContent = '… ' + name + ' is thinking';
  const stick = atBottom(); chat.append(thinking); if (stick) chat.scrollTop = chat.scrollHeight;
}
const urlFor = (file) => '/' + file.split('/').map(encodeURIComponent).join('/');
function showDoc(file) {
  doc = file || null;
  $('current').textContent = doc ? doc : 'No document shown.';
  if (!doc) return;
  pane.innerHTML = '<iframe id="doc"></iframe>';
  pane.firstChild.src = urlFor(doc);
  document.title = doc + ' · agent-room';
}
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function openFiles() {
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
$('docs').onclick = openFiles;
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
    chat.textContent = ''; thinking = null;
    ev.messages.forEach(message);
    setBusy(!ev.status && ev.messages.some((m) => m.speaker === 'User'));
    if (ev.status) status(ev.status);
    setThinking(ev.thinking); showDoc(ev.doc);
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
  }
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') { status(ev.text); setBusy(false); }
  if (ev.type === 'note') status(ev.text, ev.error);
  if (ev.type === 'doc') showDoc(ev.file);
  if (ev.type === 'files') openFiles();
  if (ev.type === 'ended') { ended = true; status('The room has ended. You can close this tab.'); events.close(); box.disabled = true; }
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
  if (url.pathname === '/__say' || url.pathname === '/__show') {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req).then((body) => {
      if (url.pathname === '/__show') {
        const file = typeof body?.file === 'string' && inside(dir, body.file) ? body.file : null;
        if (!file) return send(404, 'text/plain; charset=utf-8', 'No such file in proposal/.');
        screen.doc = file;
        broadcast(screen, { type: 'doc', file });
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
  const reset = { type: 'reset', messages: screen.transcript.map(messageView), doc: screen.doc,
    thinking: screen.thinking, status: screen.status, input: !!screen.say };
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
