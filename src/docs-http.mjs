// Document, file and library HTTP routes and the terminal document picker.
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export function createFileRoutes({ handleScreen, ownHost, files }) {
const { LIBS, servable, docFiles, esc, urlPath, page, md, mdText, TYPES, isTextFile } = files;
// dir: the room's folder; base: its address on the server (/r/<id>/), for the links in its pages.
function handle(req, res, dir, screen, base = '/') {
  if (/^\/__next\//.test(req.url)) {
    try { if (decodeURIComponent(req.url.split('?')[0]).split('/').includes('..')) { res.writeHead(404); return res.end('Not found'); } }
    catch { res.writeHead(404); return res.end('Not found'); }
  }
  const url = new URL(req.url, 'http://localhost');
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  // Other nodes' rooms (replicate.mjs), with --node only.
  if (url.pathname.startsWith('/replica/') && (!ownHost(req.headers.host ?? '') || req.headers.origin)) return send(403, 'text/plain', 'Refused peer origin or Host.');
  if (url.pathname.startsWith('/replica/')) return screen?.replicaHandler ? screen.replicaHandler(req, res) : send(404, 'text/plain', 'This room doesn\'t replicate.');
  if (screen && handleScreen(req, res, url, dir, screen)) return;
  // The browser bundles for documents with ```mermaid or ```vega-lite blocks (LIBS).
  if (url.pathname.startsWith('/__lib/')) {
    const lib = Object.hasOwn(LIBS, url.pathname.slice(7)) && LIBS[url.pathname.slice(7)];
    if (!lib) return send(404, 'text/plain', 'Not found');
    if (req.method !== 'GET') return send(405, 'text/plain', 'Method Not Allowed');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=3600' });
    return res.end(readFileSync(new URL('../node_modules/' + lib, import.meta.url)));
  }
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
function pick(files, { input, output, onOpen, header = '', rows = 15 }) {
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

return { handle, pick };
}
