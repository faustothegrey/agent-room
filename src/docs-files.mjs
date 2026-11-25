// Document rendering and room file helpers, loaded with the current Reload version.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { Marked } from 'marked';

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
    // ```csv (or ```csv <name>) shows as a table: see csvTable(). ```mermaid is drawn in the page
    // (page() loads mermaid only for a document that has one); until then, and without
    // JavaScript, its source shows.
    code({ text, lang }) {
      const [kind, name] = String(lang ?? '').trim().split(/\s+/);
      if (kind === 'mermaid') return `<div class="mermaid-box"><pre class="mermaid-src">${esc(text)}</pre></div>\n`;
      if (kind === 'vega-lite') return `<div class="vl-box"><pre class="vl-src">${esc(text)}</pre></div>\n`;
      return kind === 'csv' ? csvTable(text, name) : false;
    },
  },
  // [[D4]] or [[runs!D4]]: a reference the room page highlights in the shown document on hover.
  extensions: [{
    name: 'pointer', level: 'inline',
    start: (src) => src.indexOf('[['),
    tokenizer(src) {
      const m = /^\[\[([^[\]\n]{1,60})\]\]/.exec(src);
      if (m) return { type: 'pointer', raw: m[0], ref: m[1].trim() };
    },
    renderer: ({ ref }) => `<span class="ref" data-ref="${esc(ref)}">${esc(ref)}</span>`,
  }],
});

// ── Tables from ```csv blocks ──
// Column letters and row numbers as in a spreadsheet; a cell starting with = is a formula: cell
// references, numbers, + - * / and parentheses, and SUM, AVERAGE, MIN or MAX over a range (A1:B3).
// Formulas are worked out here; an error shows as #REF, #CYCLE, #DIV/0 or #VALUE. Every cell
// carries its reference (data-cell), so the room page can point at it.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.trim() || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}
const colName = (c) => { let s = ''; for (c++; c; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };
const parseRef = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return m ? [Number(m[2]) - 1, [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1] : null;
};
const RANGE_FUNCTIONS = {
  SUM: (v) => v.reduce((a, b) => a + b, 0),
  AVERAGE: (v) => { if (!v.length) throw new Error('#DIV/0'); return v.reduce((a, b) => a + b, 0) / v.length; },
  MIN: (v) => (v.length ? Math.min(...v) : 0),
  MAX: (v) => (v.length ? Math.max(...v) : 0),
};
function sheetValue(grid, ref, seen = new Set()) {
  const p = parseRef(ref), raw = p && grid[p[0]]?.[p[1]];
  if (raw === undefined || raw === null) throw new Error('#REF');
  if (!raw.startsWith('=')) return raw !== '' && !isNaN(raw) ? Number(raw) : raw;
  if (seen.has(ref)) throw new Error('#CYCLE');
  const inner = new Set(seen).add(ref);
  const only = /^\s*([A-Z]+\d+)\s*$/i.exec(raw.slice(1));
  if (only) return sheetValue(grid, only[1].toUpperCase(), inner); // =B3 shows B3, text included
  const number =(r) => { const v = sheetValue(grid, r, inner); return typeof v === 'number' ? v : 0; };
  const src = raw.slice(1).toUpperCase()
    .replace(/\b(SUM|AVERAGE|MIN|MAX)\(([A-Z]+\d+):([A-Z]+\d+)\)/g, (_, f, a, b) => {
      const [r1, c1] = parseRef(a), [r2, c2] = parseRef(b), values = [];
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const v = sheetValue(grid, colName(c) + (r + 1), inner); if (typeof v === 'number') values.push(v);
      }
      return '(' + RANGE_FUNCTIONS[f](values) + ')';
    })
    .replace(/[A-Z]+\d+/g, (r) => '(' + number(r) + ')');
  return arithmetic(src);
}
function arithmetic(src) { // numbers, + - * / and parentheses, by recursive descent (never eval)
  const s = src.replace(/\s+/g, ''); let i = 0;
  const num = () => { const m = /^\d+(\.\d+)?(e[+-]?\d+)?/i.exec(s.slice(i)); if (!m) throw new Error('#VALUE'); i += m[0].length; return Number(m[0]); };
  const atom = () => {
    if (s[i] === '-') { i++; return -atom(); }
    if (s[i] === '(') { i++; const v = sum(); if (s[i++] !== ')') throw new Error('#VALUE'); return v; }
    return num();
  };
  const product = () => {
    let v = atom();
    while (s[i] === '*' || s[i] === '/') { const op = s[i++], w = atom(); if (op === '/' && w === 0) throw new Error('#DIV/0'); v = op === '*' ? v * w : v / w; }
    return v;
  };
  const sum = () => { let v = product(); while (s[i] === '+' || s[i] === '-') { const op = s[i++], w = product(); v = op === '+' ? v + w : v - w; } return v; };
  const v = sum(); if (i !== s.length) throw new Error('#VALUE'); return v;
}
export function csvTable(text, name = 'table') {
  const grid = parseCsv(text), cols = Math.max(0, ...grid.map((r) => r.length));
  const shown = (ref) => {
    try { const v = sheetValue(grid, ref); return typeof v === 'number' ? String(Math.round(v * 100) / 100) : v; }
    catch (err) { return err.message; }
  };
  const head = '<tr><th></th>' + Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join('') + '</tr>';
  const body = grid.map((row, r) => `<tr><th>${r + 1}</th>` + Array.from({ length: cols }, (_, c) => {
    const ref = colName(c) + (r + 1), raw = row[c] ?? '', value = raw === '' ? '' : shown(ref);
    const cls = [raw.startsWith('=') && 'formula', value !== '' && !isNaN(value) && 'num'].filter(Boolean).join(' ');
    return `<td data-cell="${ref}"${cls ? ` class="${cls}"` : ''} title="${esc(ref + (raw.startsWith('=') ? ': ' + raw : ''))}">${esc(value)}</td>`;
  }).join('') + '</tr>').join('');
  return `<div class="sheet-box"><table class="sheet" data-sheet="${esc(name)}"><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
}

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
// Files inside a dated discussion (active, archived or deferred) or brainstorm (brainstorms/<date>-…):
// kept even when .gitignore ignores patterns such as transcripts/. Room checkout files outside them respect .gitignore.
function inDiscussion(rel) {
  const p = rel.split(/[/\\]/);
  if (p[0] === 'brainstorms') return p.length >= 2 && (isDatedDiscussion(p[1]) || DISC_SECTIONS.has(p[1]));
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
  const discFiles = [];
  for (const top of ['discussions', 'brainstorms']) {
    try { discFiles.push(...listFiles(join(dir, top)).map((f) => top + '/' + f.split(sep).join('/')).filter(inDiscussion)); } catch {}
  }
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

// Browser bundles a document page may load (/__lib/<name>), straight from node_modules.
const LIBS = {
  'mermaid.js': 'mermaid/dist/mermaid.min.js',
  'vega.js': 'vega/build/vega.min.js', 'vega-lite.js': 'vega-lite/build/vega-lite.min.js', 'vega-embed.js': 'vega-embed/build/vega-embed.min.js',
};

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
.sheet-box { overflow-x: auto; margin: 1rem 0; }
.sheet { font: 13px/1.4 ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.sheet th { font-weight: 400; opacity: .6; background: #8881; } .sheet td.num { text-align: right; }
.sheet td.formula { color: #2f6fde; } @media (prefers-color-scheme: dark) { .sheet td.formula { color: #7aa7ff; } }
.sheet td { cursor: pointer; } .sheet td:hover { background: #2f6fde1f; }
.sheet td.hl { outline: 2px solid #e07a10; outline-offset: -2px; background: #e07a1026; }
.mermaid-box { margin: 1rem 0; overflow-x: auto; } .mermaid-box svg { max-width: 100%; height: auto; }
.mermaid-box g.node { cursor: pointer; }
.mermaid-box g.node:hover :is(rect, polygon, path, circle, ellipse) { stroke: #2f6fde !important; stroke-width: 2.5px !important; }
.mermaid-box g.node.hl :is(rect, polygon, path, circle, ellipse) { stroke: #e07a10 !important; stroke-width: 3.5px !important; }
.mermaid-error { color: #c33; white-space: pre-wrap; font: 13px ui-monospace, Menlo, monospace; }
.vl-box { margin: 1rem 0; width: 100%; overflow-x: auto; } .vl-box .vega-embed { width: 100%; }
.vl-box .hl { stroke: #e07a10 !important; stroke-width: 3px !important; }
main { position: relative; }
#ink { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 5; }
body.drawing #ink { pointer-events: auto; cursor: crosshair; touch-action: none; }
#ink path, #ink ellipse, #ink line { fill: none; stroke: #d6337a; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
#ink-tools { position: sticky; top: .5rem; margin: 0 0 .75rem auto; width: max-content; z-index: 10; display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: Canvas; border: 1px solid #8886; font: 12px system-ui, sans-serif; }
#ink-tools button { font: inherit; border: 1px solid transparent; background: none; color: CanvasText; border-radius: 5px; padding: 2px 8px; cursor: pointer; }
#ink-tools button[aria-pressed="true"] { border-color: #2f6fde; color: #2f6fde; background: #2f6fde1f; }
nav { font-size: .85rem; opacity: .7; margin-bottom: 1rem; }
</style></head><body><nav>${home} · ${esc(title)}</nav><main>${body}</main>
${body.includes('<div class="mermaid-box">') ? `<script src="${esc(base)}__lib/mermaid.js"></script>` : ''}
${body.includes('<div class="vl-box">') ? ['vega', 'vega-lite', 'vega-embed'].map((l) => `<script src="${esc(base)}__lib/${l}.js"></script>`).join('') : ''}
<script>
// Vega-Lite blocks: drawn here as SVG. views keeps each chart, for pointing and highlighting.
const views = [];
if (window.vegaEmbed) for (const box of document.querySelectorAll('.vl-box')) {
  const src = box.querySelector('.vl-src'), fail = (err) => {
    const p = document.createElement('p'); p.className = 'mermaid-error'; p.textContent = 'This chart has an error: ' + ((err && err.message) || err);
    box.append(p);
  };
  let spec;
  try { spec = JSON.parse(src.textContent); } catch (err) { fail(err); continue; }
  vegaEmbed(box, spec, { renderer: 'svg', actions: false, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : undefined })
    .then(({ view }) => { views.push(view); view.addEventListener('click', (e, item) => pointAtDatum(item)); }).catch(fail);
}
// A chart item's plain fields, as "day: 16 Nov, runs: 42": not Vega's own (_x, and the
// runs_start/runs_end it adds for stacking).
const ownField = (d, k) => !k.startsWith('_') && !(/^(.+)_(start|end)$/.test(k) && k.replace(/_(start|end)$/, '') in d);
const datumText = (d) => Object.keys(d).filter((k) => ownField(d, k) && d[k] !== null && typeof d[k] !== 'object')
  .slice(0, 6).map((k) => k + ': ' + d[k]).join(', ');
function pointAtDatum(item) {
  if (parent === window || !item || !item.datum || !item.mark || item.mark.role !== 'mark') return;
  const text = datumText(item.datum); if (!text) return;
  parent.postMessage({ type: 'agent-room:point', label: '↳ ' + text.split(', ').slice(0, 2).map((p) => p.split(': ')[1]).join(': '),
    text: 'chart point ' + text + ' in ' + ${JSON.stringify(watch)} }, location.origin);
}
// The drawn marks of every chart (items keep their SVG element in _svg, with the SVG renderer).
function chartItems() {
  const out = [];
  const walk = (n) => { for (const c of (n && n.items) || []) { if (c.datum && c._svg && c.mark && c.mark.role === 'mark') out.push(c); walk(c); } };
  for (const v of views) walk(v.scenegraph().root);
  return out;
}
// Mermaid blocks: drawn here, with mermaid's strict security (no scripts or click handlers from
// the source). A source with an error shows mermaid's message under it.
if (window.mermaid) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default', flowchart: { htmlLabels: false } });
  let n = 0;
  for (const box of document.querySelectorAll('.mermaid-box')) {
    const src = box.querySelector('.mermaid-src'), id = 'mermaid-' + (++n);
    mermaid.render(id, src.textContent).then(({ svg }) => { box.innerHTML = svg; }).catch((err) => {
      const stray = document.getElementById('d' + id); if (stray) stray.remove(); // mermaid's own error drawing, left at the end of the page
      const p = document.createElement('p'); p.className = 'mermaid-error'; p.textContent = 'This diagram has an error: ' + ((err && err.message) || err);
      box.append(p);
    });
  }
}
// A diagram box's name: its id in the source (Worker in "Worker[The worker]").
const nodeName = (g) => g.dataset.id || (/flowchart-(.+)-\\d+$/.exec(g.id) || [])[1] || null;
let last = null;
setInterval(async () => {
  const t = await (await fetch(${JSON.stringify(mtime)} + encodeURIComponent(${JSON.stringify(watch)}), { cache: 'no-store' })).text();
  if (t === 'false') return; // missing for now (being saved?): keep showing it, ask again
  if (last !== null && t !== last) location.reload();
  last = t;
}, 2000);
// Shown in the room page, with tables, diagrams or charts: a markup layer. Pen, Circle and Arrow
// draw over the document; a finished mark points at what it covers (an arrow: what its tip is on).
// Marks stay until Clear marks or a reload. Esc goes back to Point.
const pointables = () => [
  ...[...document.querySelectorAll('.sheet td[data-cell]')].map((td) => {
    const sheet = td.closest('table').dataset.sheet;
    return { el: td, text: 'table cell ' + (sheet === 'table' ? '' : sheet + '!') + td.dataset.cell, short: (sheet === 'table' ? '' : sheet + '!') + td.dataset.cell };
  }),
  ...[...document.querySelectorAll('.mermaid-box g.node')].filter(nodeName).map((g) => ({ el: g, text: 'diagram box ' + nodeName(g), short: nodeName(g) })),
  ...chartItems().map((item) => ({ el: item._svg, text: 'chart point ' + datumText(item.datum), short: datumText(item.datum).split(', ').slice(0, 2).map((p) => p.split(': ')[1]).join(': ') })),
];
if (parent !== window && document.querySelector('.sheet, .mermaid-box, .vl-box')) {
  const NS = 'http://www.w3.org/2000/svg', main = document.querySelector('main');
  const ink = document.createElementNS(NS, 'svg'); ink.id = 'ink';
  ink.innerHTML = '<defs><marker id="ink-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill: #d6337a; stroke: none"/></marker></defs>';
  main.append(ink);
  const bar = document.createElement('div'); bar.id = 'ink-tools'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Markup');
  const TOOLS = { point: 'Point', pen: 'Pen', circle: 'Circle', arrow: 'Arrow' };
  let tool = 'point';
  const setTool = (t) => { tool = t; document.body.classList.toggle('drawing', t !== 'point'); for (const b of bar.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t)); };
  for (const [t, label] of Object.entries(TOOLS)) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.tool = t; b.textContent = label; b.onclick = () => setTool(t); bar.append(b);
  }
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear marks'; clear.title = 'Remove your marks from this page';
  clear.onclick = () => { for (const m of [...ink.children]) if (m.tagName !== 'defs') m.remove(); };
  bar.append(clear); document.body.prepend(bar); setTool('point'); // its own line at the top, never over the document
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setTool('point'); });
  let shape = null, pts = [];
  const local = (e) => { const b = main.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const draw = (p) => {
    pts.push(p); const s = pts[0];
    if (tool === 'pen') shape.setAttribute('d', 'M' + pts.map((q) => q.join(' ')).join('L'));
    else if (tool === 'circle') { shape.setAttribute('cx', (s[0] + p[0]) / 2); shape.setAttribute('cy', (s[1] + p[1]) / 2); shape.setAttribute('rx', Math.abs(p[0] - s[0]) / 2); shape.setAttribute('ry', Math.abs(p[1] - s[1]) / 2); }
    else { shape.setAttribute('x1', s[0]); shape.setAttribute('y1', s[1]); shape.setAttribute('x2', p[0]); shape.setAttribute('y2', p[1]); }
  };
  ink.addEventListener('pointerdown', (e) => {
    if (tool === 'point') return;
    ink.setPointerCapture(e.pointerId); pts = [];
    shape = document.createElementNS(NS, tool === 'pen' ? 'path' : tool === 'circle' ? 'ellipse' : 'line');
    if (tool === 'arrow') shape.setAttribute('marker-end', 'url(#ink-tip)');
    ink.append(shape); draw(local(e));
  });
  ink.addEventListener('pointermove', (e) => { if (shape) draw(local(e)); });
  ink.addEventListener('pointerup', (e) => {
    if (!shape) return;
    draw(local(e)); shape = null;
    const b = main.getBoundingClientRect(), xs = pts.map((q) => q[0] + b.left), ys = pts.map((q) => q[1] + b.top);
    const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const all = pointables().map((p) => Object.assign(p, { r: p.el.getBoundingClientRect() }));
    let hit;
    if (tool === 'arrow') hit = all.filter((p) => inside(p.r, xs[xs.length - 1], ys[ys.length - 1]));
    else {
      hit = all.filter((p) => inside(box, (p.r.left + p.r.right) / 2, (p.r.top + p.r.bottom) / 2));
      if (!hit.length) hit = all.filter((p) => p.r.left < box.right && p.r.right > box.left && p.r.top < box.bottom && p.r.bottom > box.top);
    }
    hit = hit.slice(0, 8);
    const verb = tool === 'pen' ? 'drew over' : tool === 'circle' ? 'circled' : 'pointed an arrow at';
    const what = hit.length ? hit.map((p) => p.short).join(', ') : 'an empty spot';
    parent.postMessage({ type: 'agent-room:point', label: '✎ ' + verb + ' ' + what,
      text: 'a mark: ' + verb + ' ' + (hit.length ? hit.map((p) => p.text).join('; ') : 'an empty spot') + ' in ' + ${JSON.stringify(watch)} }, location.origin);
  });
}
// Shown in the room page: a [[D4]] or [[runs!D4]] hovered in the chat highlights that cell here.
addEventListener('message', (e) => {
  const d = e.data;
  if (e.origin !== location.origin || e.source !== parent || !d || d.type !== 'agent-room:highlight') return;
  let first = null;
  for (const td of document.querySelectorAll('.sheet td[data-cell]')) {
    const sheet = td.closest('table').dataset.sheet, hit = d.ref === td.dataset.cell || d.ref === sheet + '!' + td.dataset.cell;
    td.classList.toggle('hl', !!d.on && hit);
    if (hit && !first) first = td;
  }
  for (const g of document.querySelectorAll('.mermaid-box g.node')) {
    const hit = d.ref === nodeName(g);
    g.classList.toggle('hl', !!d.on && hit);
    if (hit && !first) first = g;
  }
  for (const item of chartItems()) { // [[16 Nov]]: every mark with a field of that value
    const hit = Object.keys(item.datum).some((k) => !k.startsWith('_') && String(item.datum[k]) === d.ref);
    item._svg.classList.toggle('hl', !!d.on && hit);
    if (hit && !first) first = item._svg;
  }
  if (d.on && first) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// Shown in the room page: a click on a table cell or a diagram box points at it there (a chip by
// the message box).
document.addEventListener('click', (e) => {
  if (parent === window || !e.target.closest) return;
  const g = e.target.closest('.mermaid-box g.node'), box = g && nodeName(g);
  if (box) {
    const label = g.textContent.trim().replace(/\\s+/g, ' ');
    parent.postMessage({ type: 'agent-room:point', label: '↳ ' + box,
      text: 'diagram box ' + box + (label && label !== box ? ' ("' + label + '")' : '') + ' in ' + ${JSON.stringify(watch)} }, location.origin);
    g.classList.add('hl'); setTimeout(() => g.classList.remove('hl'), 1200);
    return;
  }
  const td = e.target.closest('.sheet td[data-cell]');
  if (!td) return;
  const table = td.closest('table'), sheet = table.dataset.sheet;
  const name = (sheet === 'table' ? '' : sheet + '!') + td.dataset.cell;
  const rowLabel = td.parentElement.querySelector('td').textContent, colLabel = table.tBodies[0].rows[0].cells[td.cellIndex].textContent;
  const formula = td.title.includes(': =') ? ', formula ' + td.title.slice(td.title.indexOf(': =') + 2) : '';
  parent.postMessage({ type: 'agent-room:point', label: '↳ ' + name + ' = ' + td.textContent,
    text: 'table cell ' + name + ' in ' + ${JSON.stringify(watch)} + ' = ' + td.textContent + ' (' + [rowLabel, colLabel].filter(Boolean).join(', ') + ')' + formula }, location.origin);
  td.classList.add('hl'); setTimeout(() => td.classList.remove('hl'), 1200);
});
</script></body></html>`;
}


export { TYPES, esc, md, mdText, servable, discussionDirs, LIBS, page };
