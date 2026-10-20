// Proposal viewer: handle() serves proposal/ over local HTTP, rendering Markdown with marked so
// images (and plain links to images) show inline; pick() is the terminal list behind /docs.
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

export function handle(req, res, dir) {
  const url = new URL(req.url, 'http://localhost');
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
