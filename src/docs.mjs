// Proposal viewer: handle() serves proposal/ over local HTTP, rendering Markdown with marked so
// images (and plain links to images) show inline; pick() is the terminal list behind /docs.
// It also serves the discussion screen (/__room, first cycle of proposal/discussion-ide.md): the
// chat on the left, mirrored live from the terminal, and the document picked with /docs on the
// right. The screen is read-only: the User types in the terminal.
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
//   thinking: name or null, status: the last round's end line or null }.

// A transcript entry as the page shows it: the text rendered as Markdown.
export const messageView = (m) => ({ speaker: m.speaker, html: md.parse(m.text ?? ''), error: !!m.error, pass: !!m.pass });

// Sends one event ({ type, ... }) to every open screen. The last round's end line is remembered
// until the User speaks again, so a page opened later still shows that it is the User's turn.
export function broadcast(screen, event) {
  if (event.type === 'turn') screen.status = event.text;
  if (event.type === 'message' && event.message.speaker === 'User') screen.status = null;
  for (const res of screen.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const SCREEN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>agent-room</title><style>
:root { color-scheme: light dark; --line: #8884; --dim: #888; }
body { margin: 0; height: 100vh; display: grid; grid-template-columns: minmax(300px, 38%) 1fr; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
#chat { overflow-y: auto; padding: 1rem; border-right: 1px solid var(--line); }
.msg { margin: 0 0 .9rem; padding: .5rem .75rem; border-radius: 8px; background: #8881; }
.msg.user { background: #3b82f622; } .msg.error { background: #ef444422; }
.who { font-weight: 600; font-size: .85rem; margin-bottom: .2rem; }
.msg p { margin: .3rem 0; } .msg pre { overflow-x: auto; } .msg img { max-width: 100%; }
.status { color: var(--dim); font-size: .85rem; margin: .4rem 0 .9rem; }
#doc { border: 0; width: 100%; height: 100vh; }
#empty { display: grid; place-items: center; color: var(--dim); height: 100vh; padding: 1rem; text-align: center; }
</style></head><body>
<div id="chat"></div>
<div id="right"><div id="empty">Pick a document with <code>/docs</code> in the terminal.</div></div>
<script>
const chat = document.getElementById('chat'), right = document.getElementById('right');
let thinking = null;
const atBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
function add(el) { const stick = atBottom(); chat.insertBefore(el, thinking); if (stick) chat.scrollTop = chat.scrollHeight; }
function message(m) {
  if (m.pass) return; // passes are hidden, as in the terminal
  const el = document.createElement('div');
  el.className = 'msg' + (m.speaker === 'User' ? ' user' : '') + (m.error ? ' error' : '');
  el.innerHTML = '<div class="who"></div>' + m.html;
  el.firstChild.textContent = m.speaker + (m.error ? ' — failed' : '');
  add(el);
}
function status(text) { const el = document.createElement('div'); el.className = 'status'; el.textContent = text; add(el); }
function setThinking(name) {
  thinking?.remove(); thinking = null;
  if (!name) return;
  thinking = document.createElement('div'); thinking.className = 'status'; thinking.textContent = '… ' + name + ' is thinking';
  const stick = atBottom(); chat.append(thinking); if (stick) chat.scrollTop = chat.scrollHeight;
}
function showDoc(file) {
  if (!file) return;
  right.innerHTML = '<iframe id="doc"></iframe>';
  right.firstChild.src = '/' + file.split('/').map(encodeURIComponent).join('/');
  document.title = file + ' · agent-room';
}
new EventSource('/__events').onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'reset') {
    chat.textContent = ''; thinking = null;
    ev.messages.forEach(message);
    if (ev.status) status(ev.status);
    setThinking(ev.thinking); showDoc(ev.doc);
  }
  if (ev.type === 'message') message(ev.message);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'turn') status(ev.text);
  if (ev.type === 'doc') showDoc(ev.file);
};
</script></body></html>`;

// Serves /__room (the page) and /__events (its live stream); returns false for any other path.
function handleScreen(req, res, url, screen) {
  if (url.pathname === '/__room') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SCREEN);
    return true;
  }
  if (url.pathname !== '/__events') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  screen.clients.add(res);
  req.on('close', () => screen.clients.delete(res));
  // A page that (re)connects first gets everything so far, so it never shows a partial room.
  const reset = { type: 'reset', messages: screen.transcript.map(messageView), doc: screen.doc, thinking: screen.thinking, status: screen.status };
  res.write(`data: ${JSON.stringify(reset)}\n\n`);
  return true;
}

export function handle(req, res, dir, screen) {
  const url = new URL(req.url, 'http://localhost');
  if (screen && handleScreen(req, res, url, screen)) return;
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
