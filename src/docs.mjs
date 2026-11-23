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

// ── The discussion screen ────────────────────────────────────────────────────────────────────
// `screen` is plain state kept by the caller across reloads:
// { clients: Set of open event streams, transcript: the room's entries, doc: file or null,
//   thinking: name or null, status: the last round's end line or null,
//   busy: a command from the screen has been waiting or running for a while (set by cli.mjs),
//   room: { folder (the full root path), agents: [names], worker: name, discussion: its title,
//     active: its folder under the root or null, started: first message sent (or a brainstorm),
//     brainstorm: a brainstorm (active: brainstorms/<name>), transcript: this session's transcript,
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
body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto 1fr; grid-template-columns: 62px var(--list, 240px) 7px 1fr; font: 15px/1.5 -apple-system, system-ui, sans-serif; }
body.list-collapsed { grid-template-columns: 62px 32px 1fr; }
body.service-open { grid-template-columns: 62px minmax(0, calc((100% - 62px) / 2)) var(--list, 240px) 7px 1fr; }
body.service-open.list-collapsed { grid-template-columns: 62px minmax(0, calc((100% - 62px) / 2)) 32px 1fr; }
#control-bar { display: flex; flex-direction: column; align-items: center; gap: .35rem; padding: .45rem .25rem; border-right: 1px solid var(--line); background: linear-gradient(#88812, #88812), Canvas; min-height: 0; }
.ctrl-btn { position: relative; width: 54px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .12rem; padding: .42rem .15rem; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--dim); cursor: pointer; }
.ctrl-btn[hidden] { display: none; }
.ctrl-btn:hover { background: #8882; color: CanvasText; }
.ctrl-btn.on { background: #3b82f624; border-color: #3b82f666; color: CanvasText; font-weight: 600; }
#ctrl-terminal.running::after { content: ''; position: absolute; top: 5px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: #22c55e; }
.ctrl-ico { font-size: 1.05rem; line-height: 1.1; }
.ctrl-lbl { font-size: .62rem; line-height: 1.1; }
#services-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--line); background: Canvas; }
#services-panel[hidden] { display: none; }
#services-bar { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .35rem .65rem; border-bottom: 1px solid var(--line); background: #88808; min-height: 2.2rem; flex: none; }
#services-title { font-size: .88rem; font-weight: 600; color: CanvasText; }
#main-panel { display: grid; min-width: 0; min-height: 0; grid-template-columns: var(--left, 55%) 7px 1fr; grid-template-rows: 1fr; }
#main-panel.stacked { grid-template-columns: 1fr; grid-template-rows: var(--top, 55%) 7px 1fr; }
#main-panel.side-closed { grid-template-columns: 1fr; grid-template-rows: 1fr; }
#main-panel.side-closed > #split, #main-panel.side-closed > #right { display: none; }
/* The header: three zones, room (left), current discussion (middle), monitoring (right).
   Rare room and server actions sit in the ▾ menus; the gauges never shrink. */
#header { position: relative; grid-column: 1 / -1; display: grid; grid-template-columns: fit-content(20rem) minmax(16rem, 1fr) auto; gap: .5rem .8rem; align-items: center; padding: .4rem .8rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
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
.discard-dialog { width: min(38rem, 92vw); max-height: 85vh; border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.2rem; overflow: auto; }
.discard-dialog::backdrop { background: #0006; }
.discard-dialog h3 { margin: 0 0 .5rem; font-size: .95rem; }
.discard-dialog h4 { margin: .65rem 0 .25rem; font-size: .78rem; color: var(--dim); text-transform: uppercase; letter-spacing: .03em; }
.discard-dialog ul { margin: 0; padding-left: 1.2rem; max-height: 10rem; overflow-y: auto; font-size: .8rem; font-family: ui-monospace, monospace; }
.discard-dialog .discard-warn { color: #d97706; font-size: .82rem; margin: .4rem 0; }
.discard-dialog .discard-err { color: #ef4444; font-size: .82rem; margin: .5rem 0 0; overflow-wrap: anywhere; }
.discard-dialog .discard-note { color: var(--dim); font-size: .78rem; margin: .4rem 0; }
.discard-dialog .discard-buttons { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .9rem; }
.discard-dialog .danger { color: #ef4444; border-color: #ef4444; }
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
#winfo .branch-diagram { margin-top: .3rem; padding: .35rem .5rem; border: 1px solid var(--line); border-radius: 6px; overflow: auto; max-height: 22rem; background: Canvas; }
#winfo .branch-diagram svg { max-width: 100%; height: auto; display: block; }
#winfo .branch-diagram-note { margin-top: .25rem; font-style: italic; }
#winfo button { align-self: flex-start; font-size: .75rem; margin-top: .2rem; }
#server { max-width: 100%; font-size: .75rem; color: light-dark(#3d5fc4, #5a7bd8); display: inline-flex; align-items: center; gap: .4rem; }
#server[data-state="down"] { color: #ef4444; font-weight: 600; }
#beat { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
#server[data-state="up"] #beat { background: #22c55e; } #server[data-state="down"] #beat { background: #ef4444; }
#beat.on { animation: beat 1.2s ease-out; } /* restarted on every answer, so each pulse is a real heartbeat */
@keyframes beat { 0% { transform: scale(1.4); box-shadow: 0 0 0 0 #22c55eaa; } 100% { transform: scale(1); box-shadow: 0 0 0 8px #22c55e00; } }
@media (prefers-reduced-motion: reduce) { #beat.on { animation: none; } }
/* The busy bar, on the header's bottom edge: moving while an action of this page runs, red when it failed. */
#busy { position: absolute; left: 0; right: 0; bottom: -2px; height: 3px; z-index: 5; pointer-events: none; opacity: 0; transition: opacity .2s; }
#busy[data-state] { opacity: 1; }
#busy[data-state="on"] { background: linear-gradient(90deg, #3b82f633, #3b82f6, #a855f7, #3b82f6, #3b82f633) 0 0 / 200% 100%; animation: busy 1.4s linear infinite; }
#busy[data-state="failed"] { background: #ef4444; }
@keyframes busy { from { background-position: 200% 0; } to { background-position: 0 0; } }
@media (prefers-reduced-motion: reduce) { #busy[data-state="on"] { animation: none; } }
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
.quota b[role=button] { cursor: pointer; }
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
#remote-view, #work-remote-view { border-bottom: 1px solid var(--line); padding-bottom: .5rem; margin-bottom: .5rem; font-size: .85rem; }
#remote-view p, #work-remote-view p { margin: .2rem 0; } #remote-view .local-activity { color: var(--dim); font-size: .75rem; }
#remote-view button, #work-remote-view button { margin-right: .4rem; margin-top: .25rem; }
.tools label { display: inline-flex; gap: .3rem; align-items: center; color: var(--dim); }
#list-panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; border-right: 1px solid var(--line); background: linear-gradient(#88808, #88808), Canvas; }
#list-head { display: flex; align-items: center; justify-content: space-between; gap: .3rem; padding: .35rem .5rem; border-bottom: 1px solid var(--line); min-height: 2.2rem; }
#list-title { font-size: .8rem; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#list-toggle { border: 0; background: none; padding: .1rem .35rem; font-size: .95rem; line-height: 1; color: var(--dim); }
#list-toggle:hover { background: #8882; color: CanvasText; }
#list-pane { flex: 1; min-height: 0; overflow-y: auto; }
body.list-collapsed #list-title, body.list-collapsed #list-pane { display: none; }
body.list-collapsed #list-head { justify-content: center; padding: .35rem 0; }
body.list-collapsed #list-split { display: none; }
#left { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#tabs, #subtabs { display: flex; align-items: center; border-bottom: 1px solid var(--line); }
#subtabs { --accent: #3b82f6; --tint: #3b82f618; }
.tab:disabled { opacity: .45; cursor: default; }
.tab[hidden] { display: none; }
.tab { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: none; padding: .45rem .85rem; font-size: .88rem; color: var(--dim); }
.tab:hover:not(:disabled):not(.on) { color: CanvasText; background: #8881; }
.tab.on { border-bottom-color: var(--accent, #3b82f6); background: var(--tint, #3b82f618); color: CanvasText; font-weight: 600; }
.tab.news::after { content: ' •'; color: #3b82f6; }
#tab-explorer.peeking::after { content: ' ●'; color: #f59e0b; }
#side-open { margin-left: auto; margin-right: .35rem; }
#side-controls { margin-left: auto; display: flex; align-items: center; gap: .15rem; padding-right: .3rem; }
.pane-ctrl { border: 0; background: none; padding: .2rem .45rem; font-size: .82rem; color: var(--dim); border-radius: 4px; }
.pane-ctrl:hover { background: #8882; color: CanvasText; }
.pane-ctrl[hidden] { display: none; }
.view { flex: 1; display: flex; flex-direction: column; min-height: 0; } .view[hidden] { display: none; }
#split, #list-split { cursor: col-resize; background: var(--line); background-clip: content-box; padding: 0 3px; touch-action: none; }
#main-panel.stacked > #split { cursor: row-resize; padding: 3px 0; }
#split:hover, #split:focus-visible, #list-split:hover, #list-split:focus-visible, body.resizing #split, body.resizing-v #split, body.resizing-list #list-split { background-color: #3b82f6; outline: none; }
body.resizing, body.resizing-list { cursor: col-resize; user-select: none; }
body.resizing-v { cursor: row-resize; user-select: none; }
body.resizing iframe, body.resizing-v iframe, body.resizing-list iframe { pointer-events: none; } /* the document would swallow the drag */
.chat-wrap { position: relative; display: flex; flex: 1; min-height: 0; }
.chat-wrap::before, #explorer::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .07; background: 0 0 / 240px repeat; }
.chat-wrap::before { background-image: ${DOODLE}; } #explorer::before { background-image: ${DOODLE_EXPLORER}; }
@media (prefers-color-scheme: dark) { .chat-wrap::before, #explorer::before { opacity: .09; filter: invert(1); } }
#explorer { position: relative; } #explorer > * { position: relative; } /* its content above the wallpaper */
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
a.mention { text-decoration: underline dotted; cursor: pointer; }
.mention-offer { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-bottom: .35rem; font-size: .8rem; }
.mention-offer button { font-size: .8rem; }
#follow-label { margin-left: auto; display: flex; align-items: center; gap: .3rem; white-space: nowrap; opacity: .8; }
#attach-row { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin-top: .35rem; font-size: .8rem; }
#attach { font-size: .8rem; padding: .1rem .5rem; }
.ref { font-family: ui-monospace, Menlo, monospace; font-size: .9em; background: #e07a1026; border: 1px solid transparent; border-radius: 4px; padding: 0 .25em; cursor: pointer; } .ref:hover { border-color: #e07a10; }
#attachments .chip, #pointed .chip { display: inline-flex; align-items: center; gap: .25rem; padding: .05rem .2rem .05rem .5rem; border: 1px solid var(--line); border-radius: 9px; margin-right: .3rem; }
#attachments .chip button, #pointed .chip button { border: 0; background: none; padding: 0 .25rem; font-size: .8rem; cursor: pointer; }
.box { width: 100%; min-height: 3.2rem; resize: vertical; font: inherit; padding: .4rem .5rem; border-radius: 6px; border: 1px solid var(--line); }
.tools { display: flex; gap: .4rem; align-items: center; margin-top: .4rem; font-size: .85rem; }
.hint { color: var(--dim); flex: 1; }
button { font: inherit; font-size: .85rem; padding: .2rem .6rem; border-radius: 6px; border: 1px solid var(--line); background: #8882; cursor: pointer; }
#right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
#bar { display: flex; gap: .6rem; align-items: center; padding: .4rem .6rem; border-bottom: 1px solid var(--line); font-size: .85rem; }
#current { color: var(--dim); } #feed { margin-left: auto; }
#siblings { max-height: 60vh; overflow-y: auto; } #siblings .shown { font-weight: 600; }
#pane, #docpane { flex: 1; min-height: 0; }
/* The Terminal tab (host-shell.mjs): a shell on this computer, shown only in pages opened on this computer. */
#terminal-bar { display: flex; align-items: center; gap: .5rem; padding: .3rem .6rem; border-bottom: 1px solid var(--line); font-size: .8rem; }
#terminal-status { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#terminal-bar button { font-size: .78rem; padding: .12rem .5rem; }
#terminal-bar button[hidden] { display: none; }
#hostshell-term { flex: 1; min-height: 0; padding: .3rem; background: #1e1e1e; overflow: hidden; }
/* The My notes tab (notes.mjs): the User's own notes for this room's folder, on this computer only. */
#notes[hidden], #notes-ask[hidden] { display: none; }
#notes-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(8rem, 32%) 1fr; }
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
#pane { overflow-y: auto; }
#doc { border: 0; width: 100%; height: 100%; }
.empty { display: grid; place-items: center; color: var(--dim); height: 100%; padding: 1rem; text-align: center; }
#files { padding: 1rem; }
#board-list { padding: .4rem .45rem; }
#files .entry, #board-list .entry { display: block; width: 100%; text-align: left; margin: 0; padding: .28rem .4rem; border: 0; border-radius: 4px; background: none; font-size: .86rem; break-inside: avoid; overflow-wrap: anywhere; }
#files .entry:hover, #board-list .entry:hover { background: #8882; }
#files .entry.file.shown, #files .entry.file.shown:hover { background: #3b82f633; box-shadow: inset 3px 0 #60a5fa; }
#files .entry.unviewable { opacity: .5; cursor: default; }
#files .entry.unviewable:hover { background: none; }
#files .entry::before, #board-list .entry::before { display: inline-block; width: 1.4em; }
#files .entry.folder::before, #board-list .entry.folder::before { content: '📁'; } #files .entry.file::before { content: '📄'; } #files .entry.discussion::before, #board-list .entry.discussion::before { content: '💬'; } #board-list .entry.brainstorm::before { content: '💡'; }
#files .entry .tag, #board-list .entry .tag { color: var(--dim); font-size: .8rem; margin-left: .5rem; }
#files .back, #board-list .back { border: 0; background: none; padding: 0; color: var(--dim); font-size: .85rem; margin: 0 0 .4rem; }
#files .back:hover, #board-list .back:hover { color: CanvasText; text-decoration: underline; }
#files .title, #board-list .title { font-size: .9rem; font-weight: 600; margin: 0 0 .15rem; }
#files .status, #board-list .status { font-size: .75rem; font-weight: 400; padding: .05rem .45rem; border-radius: 9px; background: #8883; margin-left: .5rem; vertical-align: middle; }
#files .status.archive, #board-list .status.archive { background: #8882; } #files .status.deferred, #board-list .status.deferred { background: #eab30833; } #files .status.inuse, #board-list .status.inuse { background: #3b82f633; }
#files .actions, #board-list .actions { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: 0 0 1rem; padding: 0 0 .8rem; border-bottom: 1px solid var(--line); }
#files .actions .primary, #board-list .actions .primary { background: #3b82f6; border-color: #3b82f6; color: white; }
#files .row, #board-list .row { display: flex; align-items: flex-start; gap: .2rem; }
#files .row .entry, #board-list .row .entry { flex: 1; min-width: 0; }
#files button.archiving::before, #board-list button.archiving::before { content: ""; display: inline-block; width: .65em; height: .65em; margin-right: .35em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: archive-spin .7s linear infinite; }
@keyframes archive-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #files button.archiving::before, #board-list button.archiving::before { animation: none; } }
#files .row .reopen, #board-list .row .reopen { font-size: .72rem; padding: .1rem .4rem; }
#files .row-menu > summary, #board-list .row-menu > summary { font-size: .85rem; margin-left: 0; padding: .1rem .35rem; color: var(--dim); }
#board-list .row-menu > summary::after { content: ''; }
#files .row-menu .menu-items, #board-list .row-menu .menu-items { left: auto; right: 0; }
#files .row-menu .menu-items button, #board-list .row-menu .menu-items button { font-size: .82rem; padding: .3rem .6rem; }
.menu-items button:disabled { color: var(--dim); cursor: default; background: none; }
#files .discussion-row, #board-list .discussion-row { align-items: flex-start; flex-wrap: nowrap; padding: .2rem .2rem .25rem; margin: .15rem 0; border-radius: 5px; }
#files .discussion-row > .discussion-lines, #board-list .discussion-row > .discussion-block { flex: 1; min-width: 0; }
#files .discussion-row.in-use, #board-list .discussion-row.in-use { background: linear-gradient(#3b82f614, #3b82f614), Canvas; box-shadow: inset 3px 0 #60a5fa; border-radius: 4px; padding-left: .45rem; }
#board-list .drag-handle { cursor: grab; color: var(--dim); padding: .25rem .1rem 0; user-select: none; font-size: .8rem; }
#board-list .discussion-row.dragging { opacity: .5; }
#board-list .discussion-row.drop-before { box-shadow: inset 0 2px #60a5fa; }
#board-list .discussion-row.drop-after { box-shadow: inset 0 -2px #60a5fa; }
#board-list .discussion-row.peeking { background: linear-gradient(#f59e0b18, #f59e0b18), Canvas; box-shadow: inset 3px 0 #f59e0b; border-radius: 4px; padding-left: .45rem; }
.list-section { margin: .25rem 0 .45rem; }
.list-section > summary { cursor: pointer; padding: .25rem .35rem; border-radius: 4px; font-size: .74rem; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; user-select: none; }
.list-section > summary:hover { background: #8882; color: CanvasText; }
#board-list .local-label { color: var(--dim); font-size: .74rem; margin: .05rem 0 .1rem .4rem; overflow-wrap: anywhere; }
#board-list .worker-pending { color: light-dark(#b45309, #f59e0b); font-size: .74rem; margin: .1rem 0 .1rem .4rem; overflow-wrap: anywhere; }
#board-list > .worker-pending, .list-section > .worker-pending { margin: .2rem .35rem; }
#board-list .hint { display: block; font-size: .78rem; margin: .25rem .35rem .45rem; }
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
.worker-pending { color: light-dark(#b45309, #f59e0b); font-size: .8rem; margin: .3rem 0; }
.discussion-info { position: relative; display: inline-block; }
.discussion-info > button { border: 0; background: none; color: #8fa8ee; padding: .15rem; }
.info-detail { display: none; position: absolute; right: 0; top: 100%; z-index: 5; width: 15rem; padding: .5rem; background: Canvas; color: CanvasText; border: 1px solid var(--line); border-radius: 4px; font-size: .8rem; }
.discussion-info:hover .info-detail, .discussion-info:focus-within .info-detail { display: block; }
#files .actions .sep, #board-list .actions .sep { width: 1px; align-self: stretch; background: var(--line); margin: 0 .3rem; }
#files h3, #board-list h3 { color: var(--dim); font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; margin: .9rem 0 .3rem; }
#talk, #tab-talk { --accent: #3b82f6; --tint: #3b82f612; }
#work, #tab-work { --accent: #a855f7; --tint: #a855f712; }
.tab.on { border-bottom-color: var(--accent); background: var(--tint); }
.tab.news::after { color: var(--accent); }
#header, #bar { background: #88808; }
.agent-settings { border-bottom: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--tint); padding: .5rem .8rem; max-height: 45%; overflow-y: auto; flex-shrink: 0; }
.agent-settings summary { cursor: pointer; font-weight: 600; font-size: .85rem; }
#providers { display: block; overflow-y: auto; }
#providers[hidden] { display: none; }
.providers-panel { padding: .6rem .9rem; }
#health-details > summary { cursor: pointer; font-weight: 600; }
#health-warning { color: light-dark(#b45309, #d6a84c); }
#provider-health table { border-collapse: collapse; margin: .5rem 0; }
#provider-health th, #provider-health td { border: 1px solid var(--line); padding: .3rem .5rem; text-align: left; vertical-align: top; }
/* The Instructions tab: prompt sets, each piece expandable, its content in a monospace block. */
#instructions { overflow-y: auto; padding: .8rem 1rem; }
.ins-set { margin-bottom: 1.3rem; }
.ins-set > h3 { font-size: .85rem; margin: 0 0 .35rem; }
.ins-piece { border: 1px solid var(--line); border-radius: 6px; margin: .35rem 0; }
.ins-piece summary { cursor: pointer; padding: .4rem .6rem; display: flex; gap: .5rem; align-items: baseline; }
.ins-piece summary b { font-size: .82rem; }
.ins-piece .when { font-size: .7rem; color: var(--dim); margin-left: auto; white-space: nowrap; }
.ins-intent { font-size: .76rem; color: var(--dim); padding: .1rem .6rem .45rem; }
.ins-content { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .7rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; padding: .45rem .6rem; border-top: 1px solid var(--line); max-height: 42vh; overflow-y: auto; }
/* The Schedule page: quota floor, task list, and add/edit form. */
#schedule { overflow-y: auto; padding: .8rem 1rem; }
.sched-section { margin-bottom: 1.2rem; max-width: 48rem; }
.sched-section h3 { font-size: .85rem; margin: 0 0 .4rem; }
.sched-floor-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.sched-floor-row input { width: 4.5rem; font: inherit; padding: .25rem .4rem; border: 1px solid var(--line); border-radius: 4px; }
.sched-card { border: 1px solid var(--line); border-radius: 6px; padding: .6rem .75rem; margin: .5rem 0; background: Canvas; }
.sched-card[data-enabled="false"] { opacity: .68; }
.sched-head { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; margin-bottom: .35rem; }
.sched-time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; font-size: .82rem; padding: .1rem .35rem; border: 1px solid var(--line); border-radius: 4px; }
.sched-disc { font-weight: 600; font-size: .86rem; }
.sched-actions { margin-left: auto; display: flex; gap: .35rem; }
.sched-prompt { font-size: .8rem; white-space: pre-wrap; overflow-wrap: anywhere; margin: .3rem 0; padding: .35rem .5rem; border-left: 2px solid var(--line); }
.sched-last { font-size: .76rem; color: var(--dim); margin-top: .3rem; }
.sched-last.ok { color: light-dark(#15803d, #86efac); }
.sched-last.warn { color: light-dark(#b45309, #fcd34d); }
.sched-last.err { color: light-dark(#b91c1c, #fca5a5); }
.sched-form { display: flex; flex-direction: column; gap: .55rem; border: 1px solid var(--line); border-radius: 6px; padding: .75rem; background: Canvas; }
.sched-form-row { display: flex; flex-wrap: wrap; gap: .6rem; }
.sched-form label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; }
.sched-form label.grow { flex: 1; min-width: 14rem; }
.sched-form label.inline { flex-direction: row; align-items: center; gap: .4rem; }
.sched-form select, .sched-form input[type="time"], .sched-form textarea { font: inherit; padding: .35rem .45rem; border: 1px solid var(--line); border-radius: 4px; background: Canvas; color: CanvasText; }
.sched-form-buttons { display: flex; gap: .5rem; align-items: center; }
.providers-heading { font-size: .85rem; margin: .9rem 0 .2rem; }
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
<div id="disc-zone" class="zone" aria-label="Current discussion"><div id="disc-text"><div id="disc-heading"><span id="disc" title="The active discussion"></span><details class="menu" id="actions-menu"><summary aria-label="Discussion actions" title="Actions"></summary><div class="menu-items"><button id="summary">Summarize</button><span id="new-discussion" hidden><hr><button id="newdisc" title="End this session: the chat clears and your next message starts a new discussion. Its worker tasks finish in its own worker session; the new one gets a fresh worker session.">New discussion</button><button id="newbrainstorm" title="A conversation with the same agents, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a discussion for that. It ends this session.">New brainstorm</button><button id="convert" hidden title="Move this brainstorm to discussions/: its agents keep their sessions and are told the new folder; the discussion rules apply, and the worker can be sent work.">Turn into a discussion</button><button id="closedisc" hidden title="Close this discussion: its agents stop; the other open discussions stay. Its checkpoint is kept: Resume it from Discussions.">Close</button><button id="closemerge" hidden title="Merge this discussion's worker branch into the room's current branch, clean up its worktree and branch, and close.">Close and Merge</button><button id="closediscard" class="danger" hidden title="Close this discussion and discard its worker worktree and branch (asks to confirm with a list of what will be lost).">Close and Discard</button></span></div></details></div><span id="disc-status" aria-live="polite"></span></div><div id="disc-workers" aria-live="polite" hidden></div></div>
<div id="server-zone" class="zone" aria-label="Monitoring"><div id="monitor"><span id="gauges" aria-label="Subscription usage"></span></div></div>
<div id="busy" aria-hidden="true"></div>
</header>
<nav id="control-bar" aria-label="Primary navigation">
  <button type="button" class="ctrl-btn on" id="ctrl-boards" aria-pressed="true" title="Boards and conversation"><span class="ctrl-ico">💬</span><span class="ctrl-lbl">Boards</span></button>
  <button type="button" class="ctrl-btn" id="ctrl-providers" aria-pressed="false" title="Default providers and models for new discussions, and provider health"><span class="ctrl-ico">⚙</span><span class="ctrl-lbl">Providers</span></button>
  <button type="button" class="ctrl-btn" id="ctrl-instructions" aria-pressed="false" title="The prompts and rulebooks sent to each agent, and when"><span class="ctrl-ico">📜</span><span class="ctrl-lbl">Instructions</span></button>
  <button type="button" class="ctrl-btn" id="ctrl-schedule" aria-pressed="false" title="Scheduled recurring discussions and quota guard"><span class="ctrl-ico">⏰</span><span class="ctrl-lbl">Schedule</span></button>
  <button type="button" class="ctrl-btn" id="ctrl-notes" aria-pressed="false" hidden title="Your own notes for this room's folder, kept on this computer only (not in the folder, not sent to peers). The agents are not told about them; the files are outside the room's folder."><span class="ctrl-ico">📝</span><span class="ctrl-lbl">My notes</span></button>
  <button type="button" class="ctrl-btn" id="ctrl-terminal" aria-pressed="false" hidden title="A shell on this computer, in the room's folder. Only from this computer, not from other devices."><span class="ctrl-ico">⌨</span><span class="ctrl-lbl">Terminal</span></button>
</nav>
<section id="services-panel" aria-label="Services" hidden>
  <div id="services-bar"><span id="services-title"></span><button type="button" id="services-close" class="pane-ctrl" title="Close services panel" aria-label="Close services panel">✕</button></div>
  <div class="view" id="providers" hidden>
    <form class="providers-panel" id="providers-form">
      <p class="settings-hint" id="providers-hint"></p>
      <h3 class="providers-heading">Discussion members</h3>
      <div id="providers-agent-rows"></div>
      <p class="settings-hint member-note" id="providers-member-note" hidden></p>
      <h3 class="providers-heading">Worker</h3>
      <div id="providers-worker-row"></div>
      <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access. Changes save automatically.</p>
      <p class="settings-status" id="providers-status" role="status"></p>
      <button type="button" id="providers-done">Go to the discussion</button>
    </form>
    <details class="providers-panel" id="health-details"><summary>Provider health · all rooms on this server <span id="health-warning" hidden>⚠</span></summary><button type="button" id="health-check">Check now</button><div id="provider-health" role="status"></div></details>
  </div>
  <div class="view" id="instructions" hidden><div id="instructions-pane"></div></div>
  <div class="view" id="schedule" hidden><div id="schedule-pane"></div></div>
  <div class="view" id="notes" hidden><div id="notes-body">
    <div id="notes-side"><button id="notes-new" title="Start a new note: the first line is its title">New</button><div id="notes-list"></div></div>
    <div id="notes-main"><div id="notes-ask" role="alertdialog" aria-labelledby="notes-ask-text" hidden><span id="notes-ask-text"></span><span id="notes-ask-buttons"></span></div><textarea class="box" id="notes-text" aria-label="Note" placeholder="Choose a note, or New. The first line is the note's title." disabled></textarea>
      <div id="notes-bar"><button id="notes-save" disabled title="Save this note (nothing is saved until you press Save)">Save</button><button id="notes-remove" disabled>Remove</button><span id="notes-status" role="status"></span></div></div>
  </div></div>
  <div class="view" id="terminal" hidden>
    <div id="terminal-bar"><span id="terminal-status">Shell in this room’s folder (this computer only)</span><button type="button" id="terminal-start" hidden title="Start a fresh shell">Start shell</button><button type="button" id="terminal-end" hidden title="Stop the running shell">End shell</button></div>
    <div id="hostshell-term"></div>
  </div>
</section>
<aside id="list-panel" aria-label="Boards">
  <div id="list-head"><span id="list-title">Boards</span><button type="button" id="list-toggle" aria-expanded="true" aria-label="Collapse boards list" title="Collapse boards list">«</button></div>
  <div id="list-pane"></div>
</aside>
<div id="list-split" role="separator" aria-orientation="vertical" aria-label="Resize the boards list" tabindex="0" title="Drag to resize"></div>
<div id="main-panel">
<div id="left">
  <div id="tabs" role="tablist"><button class="tab on" id="tab-talk" role="tab">Discussion</button><button class="tab" id="tab-work" role="tab">Worker</button><button type="button" id="side-open" class="pane-ctrl" hidden title="Show side pane" aria-label="Show side pane">◫ Side pane</button></div>
  <div class="view" id="talk">
    <details class="agent-settings" id="talk-settings">
      <summary>Discussion members · <span id="talk-models">provider & model</span></summary>
      <form id="talk-settings-form">
        <p class="settings-hint" id="talk-settings-hint"></p>
        <div id="talk-agent-rows"></div>
        <div class="settings-hint" id="talk-sessions"></div>
        <p class="settings-hint member-note" id="talk-member-note" hidden></p>
        <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
        <p class="settings-status" id="talk-settings-status" role="status"></p>
      </form>
    </details>
    <div id="failed-agents" role="status" hidden></div>
    <div class="chat-wrap"><div class="chat" id="chat"></div><button class="scroll-end" id="talk-end" aria-label="Scroll to latest discussion messages" title="Scroll to latest messages" hidden>↓</button></div>
    <div class="composer" id="composer"><div class="mention-offer" hidden></div>
      <div id="remote-view" hidden></div>
      <div id="autodev" role="status" hidden></div>
      <textarea class="box" id="box" placeholder="Message to the agents… (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown"></textarea>
      <div id="attach-row"><button type="button" id="attach" title="Attach files to your next message: saved into the files/ folder when you send it (25 MB at most each)">📎 Attach</button><input type="file" id="attach-input" multiple hidden><span id="attachments"></span><span id="pointed"></span></div>
    </div>
  </div>
  <div class="view" id="work" hidden>
    <details class="agent-settings" id="work-settings">
      <summary>Worker · <span id="work-models">provider & model</span></summary>
      <form id="work-settings-form">
        <p class="settings-hint" id="work-settings-hint"></p>
        <div id="work-agent-rows"></div>
        <div class="settings-hint" id="work-sessions"></div>
        <p class="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
        <p class="settings-status" id="work-settings-status" role="status"></p>
      </form>
    </details>
    <div id="winfo" aria-live="polite"></div>
    <div class="chat-wrap"><div class="chat" id="wchat"></div><button class="scroll-end" id="work-end" aria-label="Scroll to latest worker messages" title="Scroll to latest messages" hidden>↓</button></div>
    <div class="composer" id="wcomposer"><div class="mention-offer" hidden></div>
      <div id="work-remote-view" hidden></div>
      <textarea class="box" id="wbox" placeholder="Instruction to the worker… (Enter sends, Shift+Enter for a new line). It sees only what you send here; it can edit files and run commands."></textarea>
      <div class="tools"><span class="hint" id="whint"></span><span id="wstop" hidden><button id="wstop-after" title="The running instruction finishes and is reported as usual; this discussion's queued instructions are cancelled, and auto dev pauses">Stop after this task</button> <button id="wstop-now" title="The running instruction's programs are stopped at once; this discussion's queued instructions are cancelled, auto dev pauses, and what it left in the worktree is reported">Stop now</button></span></div>
    </div>
  </div>
  <div id="system-messages" role="log" aria-label="System messages" aria-live="polite" aria-relevant="additions"></div>
</div>
<div id="split" role="separator" aria-orientation="vertical" aria-label="Resize the chat and the document" tabindex="0" title="Drag to resize"></div>
<div id="right">
  <div id="subtabs" role="tablist"><button class="tab on" id="tab-explorer" role="tab">Explorer</button><button class="tab" id="tab-document" role="tab" disabled title="Choose a file in Explorer">Document</button><span id="side-controls"><button type="button" id="split-orient" class="pane-ctrl" title="Stack conversation above side pane" aria-label="Stack conversation above side pane">⇅</button><button type="button" id="side-close" class="pane-ctrl" title="Close side pane" aria-label="Close side pane">✕</button></span></div>
  <div class="view" id="explorer"><div id="pane"></div></div>
  <div class="view" id="document" hidden>
    <div id="bar"><details class="menu" id="doc-menu"><summary title="Other files in this folder"><span id="current">No document shown.</span></summary><div class="menu-items" id="siblings"></div></details><button id="feed" hidden title="Ask the agents to read this transcript in full">Send to agents</button><label id="follow-label" title="When an agent or the worker names a file in a new message, show it here at once (this browser only)"><input type="checkbox" id="follow"> Follow mentions</label></div>
    <div id="docpane"></div>
  </div>
</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const pane = $('pane'), docpane = $('docpane'), box = $('box'), wbox = $('wbox');
let pending = [], attaching = false; // attachments waiting for the next message (see sendWithFiles)
let replica = null, replicaOff = null, viewing = null, peeking = null, localMessages = [], localInput = true, localThinking = null, yourTurn = false, localWorking = null, viewExpired = false, viewNotice = null;
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
// Files named in messages. A path the room has (notes.md or drawings/flow.svg in the current
// discussion, or a full path from the root) becomes a link that shows it in Document. A new
// message from an agent or the worker that names files offers them by the message box; with
// Follow mentions on (this browser only, off by default) the first one is shown at once instead.
let mentionFiles = null, mentionLoad = null;
const loadMentionFiles = () => mentionLoad ??= fetch('__files').then((r) => r.json())
  .then((f) => { mentionFiles = Array.isArray(f) ? f : []; }, () => { mentionFiles = mentionFiles || []; })
  .finally(() => { mentionLoad = null; });
function resolveMention(word) {
  const w = word.replace(/^\\.\\//, '');
  if (!mentionFiles) return null;
  if (mentionFiles.includes(w)) return w;
  const inDiscussion = room && room.active ? room.active + '/' + w : null;
  return inDiscussion && mentionFiles.includes(inDiscussion) ? inDiscussion : null;
}
// Turns the known file paths in a message into links; returns the files found, in order.
function linkMentions(el) {
  const found = [], nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('a, pre, .who') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.textContent.split(/([\\w~+-][\\w~+./-]*\\.[A-Za-z0-9]{1,6})/);
    if (parts.length < 2) continue;
    let changed = false;
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => {
      const file = i % 2 ? resolveMention(part) : null;
      if (!file) { frag.append(part); return; }
      const a = document.createElement('a'); a.href = '#'; a.className = 'mention'; a.textContent = part; a.title = 'Show ' + file + ' in Document';
      a.onclick = (e) => { e.preventDefault(); showMention(file); };
      frag.append(a); changed = true;
      if (!found.includes(file)) found.push(file);
    });
    if (changed) node.replaceWith(frag);
  }
  return found;
}
const showMention = (file) => { clearMentionOffer(); post('__show', { file }).catch((err) => status(err.message, true)); };
const followMentions = () => { try { return localStorage.getItem('agent-room.followMentions') === '1'; } catch { return false; } };
$('follow').checked = followMentions();
$('follow').onchange = (e) => { try { localStorage.setItem('agent-room.followMentions', e.target.checked ? '1' : '0'); } catch {} };
function clearMentionOffer() { for (const bar of document.querySelectorAll('.mention-offer')) { bar.hidden = true; bar.replaceChildren(); } }
function offerMentions(files) {
  files = files.filter((f) => f !== doc).slice(0, 3);
  if (!files.length) return;
  if (followMentions()) return showMention(files[0]);
  for (const bar of document.querySelectorAll('.mention-offer')) {
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.title = 'Dismiss'; close.onclick = clearMentionOffer;
    bar.replaceChildren(...files.map((f) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '📄 Show ' + f.split('/').pop(); b.title = 'Show ' + f + ' in Document';
      b.onclick = () => showMention(f); return b;
    }), close);
    bar.hidden = false;
  }
}
// Links a message's file paths; a new one (live) from an agent or the worker also offers them.
function mention(el, m, live) {
  const offer = live && m.speaker !== 'User' && m.speaker !== 'Relayed from discussion' && !m.error;
  if (live && m.speaker === 'User') clearMentionOffer();
  const run = () => { const found = linkMentions(el); if (offer) offerMentions(found); };
  if (mentionFiles && !offer) run(); else loadMentionFiles().then(run); // a live message: the files again, it may name a new one
}
function statusEl(text, error) { const el = document.createElement('div'); el.className = 'status' + (error ? ' error' : ''); el.textContent = text; return el; }

// Control bar & Services panel (Providers / Instructions / Schedule / My notes / Terminal):
// opens beside the Control bar at half the window, pushing the board area right and collapsing the
// Boards list while open, restoring its prior open/collapsed state on close. Closing or switching
// services only hides the panel without asking: rounds, worker tasks, running Terminal shells and
// unsaved My notes edits stay untouched.
const SERVICES = { providers: 'Providers', instructions: 'Instructions', schedule: 'Schedule', notes: 'My notes', terminal: 'Terminal' };
let openServiceName = null, listCollapsedBeforeService = null;
function fitHostShell(focus = false) {
  if (openServiceName !== 'terminal' || typeof hostShell === 'undefined' || !hostShell?.fit) return;
  requestAnimationFrame(() => {
    if (openServiceName !== 'terminal' || !hostShell?.fit) return;
    try { hostShell.fit.fit(); if (focus) hostShell.term?.focus(); } catch {}
  });
}
function openService(name, opts = {}) {
  const next = name && SERVICES[name] ? name : null;
  if (next) {
    if (openServiceName === null) {
      listCollapsedBeforeService = document.body.classList.contains('list-collapsed');
      if (typeof setListCollapsed === 'function') setListCollapsed(true, false);
    }
    openServiceName = next;
    document.body.classList.add('service-open');
    $('services-panel').hidden = false;
    if ($('services-title')) $('services-title').textContent = SERVICES[next];
    for (const key of Object.keys(SERVICES)) { if ($(key)) $(key).hidden = next !== key; }
    if (typeof notes !== 'undefined' && notes) notes.open = next === 'notes';
    if (typeof syncBoardSizes === 'function') syncBoardSizes();
    if (next === 'providers' && typeof renderProviders === 'function') renderProviders();
    if (next === 'instructions' && typeof renderInstructions === 'function') renderInstructions();
    if (next === 'schedule' && typeof renderSchedule === 'function') renderSchedule();
    if (next === 'notes' && !opts.skipNotesOpen && typeof openNotes === 'function') openNotes();
    if (next === 'terminal' && typeof openHostShell === 'function') {
      if (typeof hostShell === 'undefined' || !hostShell) openHostShell();
      else fitHostShell(true);
    }
  } else {
    if (openServiceName === null) return;
    openServiceName = null;
    document.body.classList.remove('service-open');
    $('services-panel').hidden = true;
    for (const key of Object.keys(SERVICES)) { if ($(key)) $(key).hidden = true; }
    if (typeof notes !== 'undefined' && notes) notes.open = false;
    if (listCollapsedBeforeService !== null && typeof setListCollapsed === 'function') {
      const restore = listCollapsedBeforeService;
      listCollapsedBeforeService = null;
      setListCollapsed(restore, false);
    }
    if (typeof syncBoardSizes === 'function') syncBoardSizes();
  }
  const active = openServiceName ?? 'boards';
  for (const [id, key] of [['ctrl-boards', 'boards'], ['ctrl-providers', 'providers'], ['ctrl-instructions', 'instructions'], ['ctrl-schedule', 'schedule'], ['ctrl-notes', 'notes'], ['ctrl-terminal', 'terminal']]) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('on', active === key);
    b.setAttribute('aria-pressed', active === key ? 'true' : 'false');
  }
  if (typeof updateReplicaView === 'function') updateReplicaView();
}

// The two conversation tabs (Discussion and Worker). A worker reply while Discussion is shown marks Worker.
// Switching between Discussion and Worker never closes the open service.
function showTab(name) {
  if (SERVICES[name]) { openService(name); return; }
  tab = name;
  $('talk').hidden = name !== 'talk'; $('work').hidden = name !== 'work';
  $('tab-talk').classList.toggle('on', name === 'talk'); $('tab-work').classList.toggle('on', name === 'work');
  if (name === 'work') { $('tab-work').classList.remove('news'); post('__workerinfo', {}).catch(() => {}); } // its branches' checks, again
  updateReplicaView();
  const target = name === 'work' ? wbox : box;
  if (!target.disabled) target.focus();
}
$('tab-talk').onclick = () => showTab('talk');
$('tab-work').onclick = () => showTab('work');
if ($('ctrl-boards')) $('ctrl-boards').onclick = () => {
  if (openServiceName !== null) return openService(null);
  if (document.body.classList.contains('list-collapsed') && typeof setListCollapsed === 'function') {
    setListCollapsed(false);
    post('__workerinfo', {}).catch(() => {});
  }
};
for (const key of Object.keys(SERVICES)) {
  const b = $('ctrl-' + key);
  if (b) b.onclick = () => openService(openServiceName === key ? null : key);
}
if ($('services-close')) $('services-close').onclick = () => openService(null);
if ($('providers-done')) $('providers-done').onclick = () => openService(null);

// The Schedule page: quota floor, recurring discussion tasks, and last-run results.
let scheduleEditingId = null;
function formatScheduleRun(task) {
  if (task.running) return { text: 'Running now…', cls: 'warn' };
  const r = task.lastRun;
  if (!r) return { text: 'Last run: never', cls: '' };
  const at = r.at ? longDate(r.at) : '';
  if (r.status === 'ran') return { text: 'Last run: ' + at + ' · ran', cls: 'ok' };
  if (r.status === 'skipped') return { text: 'Last run: ' + at + ' · skipped' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'warn' };
  if (r.status === 'stopped') return { text: 'Last run: ' + at + ' · stopped by the quota guard' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'warn' };
  return { text: 'Last run: ' + at + ' · failed' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'err' };
}
async function renderSchedule(notice = '', isError = false) {
  const pane = $('schedule-pane');
  if (!pane) return;
  try {
    const res = await fetch('__schedule');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    drawSchedule(data, notice, isError);
  } catch (err) {
    pane.textContent = "Couldn't load the schedule: " + err.message;
  }
}
function drawSchedule(data, notice = '', isError = false) {
  const pane = $('schedule-pane');
  if (!pane) return;
  pane.replaceChildren();
  const statusEl = document.createElement('p');
  statusEl.className = 'settings-status';
  statusEl.setAttribute('role', 'status');
  if (notice) { statusEl.textContent = notice; if (isError) statusEl.style.color = 'light-dark(#b91c1c, #fca5a5)'; }

  async function mutate(payload, okMsg) {
    try {
      const res = await post('__schedule', payload);
      if (!res.ok) throw new Error(await res.text());
      const next = await res.json();
      drawSchedule(next, okMsg, false);
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.style.color = 'light-dark(#b91c1c, #fca5a5)';
    }
  }

  // 1. Quota guard floor
  const guardSec = document.createElement('section'); guardSec.className = 'sched-section';
  const guardH = document.createElement('h3'); guardH.textContent = 'Quota guard'; guardSec.append(guardH);
  const floorRow = document.createElement('div'); floorRow.className = 'sched-floor-row';
  const floorLbl = document.createElement('label'); floorLbl.textContent = 'Minimum quota remaining (% for all providers): ';
  const floorIn = document.createElement('input');
  floorIn.type = 'number'; floorIn.id = 'sched-floor'; floorIn.min = '0'; floorIn.max = '100'; floorIn.step = '1';
  floorIn.value = String(data.quotaFloor ?? 50);
  const floorBtn = document.createElement('button'); floorBtn.type = 'button'; floorBtn.textContent = 'Save floor';
  floorBtn.onclick = () => mutate({ action: 'floor', quotaFloor: Number(floorIn.value) }, 'Quota floor saved (' + floorIn.value + '%).');
  floorRow.append(floorLbl, floorIn, floorBtn);
  const guardHint = document.createElement('p'); guardHint.className = 'settings-hint';
  guardHint.textContent = 'Checked before each scheduled run and before each lap across every agent’s 5-hour and weekly windows. Missing or stale meter readings skip or stop the run. Runs happen only while agent-room is open (no catch-up).';
  guardSec.append(floorRow, guardHint);
  pane.append(guardSec);

  // 2. Task list
  const listSec = document.createElement('section'); listSec.className = 'sched-section';
  const listH = document.createElement('h3'); listH.textContent = 'Scheduled tasks (' + data.tasks.length + ')'; listSec.append(listH);
  const discByRef = new Map((data.discussions || []).map((d) => [d.ref, d]));
  if (!data.tasks.length) {
    const empty = document.createElement('p'); empty.className = 'settings-hint';
    empty.textContent = 'No scheduled tasks for this room yet.';
    listSec.append(empty);
  } else {
    for (const task of data.tasks) {
      const card = document.createElement('div'); card.className = 'sched-card'; card.dataset.enabled = task.enabled ? 'true' : 'false';
      const head = document.createElement('div'); head.className = 'sched-head';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = !!task.enabled;
      toggle.setAttribute('aria-label', 'Enable scheduled task for ' + task.discussion);
      toggle.onchange = () => mutate({ action: 'toggle', id: task.id, enabled: toggle.checked }, toggle.checked ? 'Task enabled.' : 'Task disabled.');
      const time = document.createElement('span'); time.className = 'sched-time'; time.textContent = task.time + ' daily';
      const d = discByRef.get(task.discussion);
      const disc = document.createElement('span'); disc.className = 'sched-disc';
      disc.textContent = d ? d.title + (d.section ? ' (' + d.section + ')' : '') : task.discussion;
      disc.title = 'discussions/' + task.discussion;
      const actions = document.createElement('span'); actions.className = 'sched-actions';
      const editBtn = document.createElement('button'); editBtn.type = 'button'; editBtn.textContent = 'Edit';
      editBtn.onclick = () => { scheduleEditingId = task.id; drawSchedule(data); };
      const delBtn = document.createElement('button'); delBtn.type = 'button'; delBtn.className = 'danger'; delBtn.textContent = 'Delete';
      delBtn.onclick = () => {
        if (delBtn.dataset.armed) {
          if (scheduleEditingId === task.id) scheduleEditingId = null;
          mutate({ action: 'delete', id: task.id }, 'Task deleted.');
        } else {
          delBtn.dataset.armed = '1'; delBtn.textContent = 'Confirm delete';
          setTimeout(() => { delete delBtn.dataset.armed; delBtn.textContent = 'Delete'; }, 4000);
        }
      };
      actions.append(editBtn, delBtn);
      head.append(toggle, time, disc, actions);
      const prompt = document.createElement('div'); prompt.className = 'sched-prompt'; prompt.textContent = task.prompt;
      const runInfo = formatScheduleRun(task);
      const last = document.createElement('div'); last.className = 'sched-last' + (runInfo.cls ? ' ' + runInfo.cls : ''); last.textContent = runInfo.text;
      card.append(head, prompt, last);
      listSec.append(card);
    }
  }
  pane.append(listSec);

  // 3. Add / Edit form
  const editing = scheduleEditingId ? data.tasks.find((t) => t.id === scheduleEditingId) : null;
  if (scheduleEditingId && !editing) scheduleEditingId = null;
  const formSec = document.createElement('section'); formSec.className = 'sched-section';
  const formH = document.createElement('h3'); formH.textContent = editing ? 'Edit scheduled task' : 'Add scheduled task'; formSec.append(formH);
  const form = document.createElement('form'); form.className = 'sched-form'; form.id = 'sched-form';
  const row = document.createElement('div'); row.className = 'sched-form-row';

  const discLbl = document.createElement('label'); discLbl.className = 'grow'; discLbl.textContent = 'Discussion';
  const discSel = document.createElement('select'); discSel.id = 'sched-discussion'; discSel.required = true;
  const discussions = data.discussions || [];
  if (!discussions.length) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'No discussions in this room yet';
    discSel.append(opt);
  } else {
    for (const d of discussions) {
      const opt = document.createElement('option'); opt.value = d.ref;
      opt.textContent = d.title + ' (' + d.ref + ')';
      discSel.append(opt);
    }
    if (editing && !discByRef.has(editing.discussion)) {
      const opt = document.createElement('option'); opt.value = editing.discussion;
      opt.textContent = editing.discussion + ' (missing)';
      discSel.append(opt);
    }
    if (editing) discSel.value = editing.discussion;
  }
  discLbl.append(discSel);

  const timeLbl = document.createElement('label'); timeLbl.textContent = 'Daily time (local)';
  const timeIn = document.createElement('input'); timeIn.type = 'time'; timeIn.id = 'sched-time'; timeIn.required = true;
  timeIn.value = editing ? editing.time : '03:00';
  timeLbl.append(timeIn);
  row.append(discLbl, timeLbl);

  const promptLbl = document.createElement('label'); promptLbl.textContent = 'Saved prompt (posted as Scheduler)';
  const promptIn = document.createElement('textarea'); promptIn.id = 'sched-prompt'; promptIn.rows = 4; promptIn.required = true;
  promptIn.placeholder = 'Write the prompt the Scheduler should post to this discussion…';
  promptIn.value = editing ? editing.prompt : '';
  promptLbl.append(promptIn);

  const enLbl = document.createElement('label'); enLbl.className = 'inline';
  const enIn = document.createElement('input'); enIn.type = 'checkbox'; enIn.id = 'sched-enabled';
  enIn.checked = editing ? !!editing.enabled : true;
  enLbl.append(enIn, 'Enabled');

  const btns = document.createElement('div'); btns.className = 'sched-form-buttons';
  const submitBtn = document.createElement('button'); submitBtn.type = 'submit';
  submitBtn.textContent = editing ? 'Save changes' : 'Add task';
  submitBtn.disabled = !discussions.length && !editing;
  btns.append(submitBtn);
  if (editing) {
    const cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => { scheduleEditingId = null; drawSchedule(data); };
    btns.append(cancelBtn);
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    const payload = editing
      ? { action: 'edit', id: editing.id, discussion: discSel.value, time: timeIn.value, prompt: promptIn.value, enabled: enIn.checked }
      : { action: 'add', discussion: discSel.value, time: timeIn.value, prompt: promptIn.value, enabled: enIn.checked };
    scheduleEditingId = null;
    mutate(payload, editing ? 'Task updated.' : 'Task added.');
  };
  form.append(row, promptLbl, enLbl, btns);
  formSec.append(form, statusEl);
  pane.append(formSec);
}
// The Instructions tab: the prompt catalog, fetched once and rendered as expandable pieces.
let instructionsLoaded = false;
async function renderInstructions() {
  if (instructionsLoaded) return;
  instructionsLoaded = true;
  const pane = $('instructions-pane');
  pane.textContent = '';
  try {
    const res = await fetch('__instructions');
    if (!res.ok) throw new Error(await res.text());
    renderInstructionSets(await res.json());
  } catch (err) { pane.textContent = "Couldn't load the instructions: " + err.message; }
}
function renderInstructionSets(sets) {
  const pane = $('instructions-pane');
  for (const set of sets) {
    const box = document.createElement('div'); box.className = 'ins-set';
    const h = document.createElement('h3'); h.textContent = set.type; box.append(h);
    for (const piece of set.pieces) {
      const d = document.createElement('details'); d.className = 'ins-piece';
      const s = document.createElement('summary');
      const b = document.createElement('b'); b.textContent = piece.id;
      const when = document.createElement('span'); when.className = 'when'; when.textContent = piece.when;
      s.append(b, when); d.append(s);
      const intent = document.createElement('div'); intent.className = 'ins-intent'; intent.textContent = piece.intent; d.append(intent);
      const content = document.createElement('pre'); content.className = 'ins-content'; content.textContent = piece.content; d.append(content);
      box.append(d);
    }
    pane.append(box);
  }
}
function workMessage(m, live) {
  if (m.note) return status(m.note, m.error, 'Worker'); // a marker (New discussion) or an error
  const el = bubble(m);
  if (m.retryId) el.dataset.retryId = m.retryId;
  work.add(el);
  mention(el, m, live);
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
// A brainstorm sends no work: its Worker tab says so, whatever the worker's own state. Every
// update goes through here, which keeps the latest info for when the window shows a discussion.
const BRAINSTORM_NO_WORK = 'Turn this brainstorm into a discussion to send work.';
let workerInfoShown = null, workPlaceholder = null;
function showWorkerInfo(info) {
  const pendingChanged = JSON.stringify(info?.pending ?? null) !== JSON.stringify(workerPending);
  const nextDiscardable = info?.discardable ?? [];
  const discardableChanged = JSON.stringify(nextDiscardable) !== JSON.stringify([...workerDiscardable]);
  const nextMergeable = info?.mergeable ?? {};
  const mergeableChanged = JSON.stringify(nextMergeable) !== JSON.stringify(workerMergeable);
  const nextMerged = info?.merged ?? [];
  const mergedChanged = JSON.stringify(nextMerged) !== JSON.stringify([...workerMerged]);
  workerInfoShown = info;
  if (pendingChanged || discardableChanged || mergeableChanged || mergedChanged) {
    workerPending = info?.pending ?? null;
    workerDiscardable = new Set(nextDiscardable);
    workerMergeable = nextMergeable;
    workerMerged = new Set(nextMerged);
    updateCloseButton();
    renderDiscussions();
  } // its rows and Close/Merge/Discard actions follow pending work and existing worker lanes
  workPlaceholder ??= wbox.placeholder;
  const readOnly = (typeof peeking !== 'undefined' && !!peeking) || (typeof viewing !== 'undefined' && !!viewing);
  if (readOnly) {
    setWorkerInfo(info);
    wbox.disabled = true;
    wbox.placeholder = (typeof peeking !== 'undefined' && peeking) ? 'Peeking read-only — click Back to return to the active discussion.' : 'Read-only: viewing a peer’s discussion.';
  } else if (room?.brainstorm) setWorkerInfo({ lines: [BRAINSTORM_NO_WORK], disabled: true });
  else {
    setWorkerInfo(info);
    if (!info?.disabled) { wbox.disabled = false; wbox.placeholder = workPlaceholder; }
  }
  if (ended || restarting) wbox.disabled = true;
}
// Mermaid for the Worker tab's branch diagrams: loaded once, only when a diagram is drawn.
let mermaidReady = null, diagramSeq = 0;
const diagramCache = new Map();
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  return mermaidReady ??= new Promise((done, fail) => {
    const s = document.createElement('script');
    s.src = '__lib/mermaid.js';
    s.onload = () => {
      if (!window.mermaid) { mermaidReady = null; return fail(new Error('Mermaid failed to load')); }
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
      done(window.mermaid);
    };
    s.onerror = () => { mermaidReady = null; fail(new Error('Could not load Mermaid')); };
    document.head.append(s);
  });
}
function drawBranchDiagram(box, source) {
  if (box.dataset.drawn === source) return;
  box.dataset.drawn = source;
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
  const key = theme + '\\n' + source;
  if (diagramCache.has(key)) { box.innerHTML = diagramCache.get(key); return; }
  box.textContent = 'Drawing branch diagram…';
  loadMermaid().then((m) => {
    const id = 'wgit-' + (++diagramSeq);
    return m.render(id, source).then(({ svg }) => {
      if (diagramCache.size > 40) diagramCache.clear();
      diagramCache.set(key, svg);
      if (box.dataset.drawn === source) box.innerHTML = svg;
    }, (err) => {
      const stray = document.getElementById('d' + id); if (stray) stray.remove();
      throw err;
    });
  }).catch((err) => {
    if (box.dataset.drawn !== source) return;
    box.className = 'branch-diagram-note';
    box.textContent = 'Branch diagram could not be drawn: ' + ((err && err.message) || err);
  });
}
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
    if (lane.diagram?.note) {
      const note = document.createElement('div'); note.className = 'branch-diagram-note'; note.textContent = lane.diagram.note;
      body.append(note);
    } else if (lane.diagram?.graph) {
      const box = document.createElement('div'); box.className = 'branch-diagram';
      body.append(box);
      const draw = () => drawBranchDiagram(box, lane.diagram.graph);
      d.addEventListener('toggle', () => { if (d.open) draw(); });
      if (d.open) draw();
    }
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
  $('tab-work').dataset.working = name ? '1' : '';
  tabTitles();
}

// The dividers: #list-split resizes the Boards list panel, and #split resizes the conversation vs
// the side pane (horizontally when side by side, vertically when stacked). Boards list width and
// collapsed state are shared per browser; side-pane open/closed, orientation and divider position
// are saved per room and board folder name in this browser (with the old shared keys giving the
// starting layout on page load).
const mainPanel = $('main-panel'), split = $('split'), listSplit = $('list-split'), listToggle = $('list-toggle');
const splitOrient = $('split-orient'), sideCloseBtn = $('side-close'), sideOpenBtn = $('side-open');
const MIN = 260, MIN_H = 140, LIST_MIN = 160, LIST_MAX = 420;
const KEY = 'agent-room:left', TOP_KEY = 'agent-room:top', LIST_KEY = 'agent-room:list';
const LIST_COLLAPSED_KEY = 'agent-room:list-collapsed', ORIENT_KEY = 'agent-room:split-orient', SIDE_CLOSED_KEY = 'agent-room:side-closed';
const BOARD_LAYOUT_KEY = 'agent-room:board-layout:';
let stacked = false, sideClosed = false;
let savedLeft = null, savedTop = null, savedList = null;
let appliedLayoutId = null, layoutBeforeReadOnly = null;
const isBoardNarrowed = () => typeof openServiceName !== 'undefined' && openServiceName !== null;
const isReadOnlyLayout = () => (typeof peeking !== 'undefined' && !!peeking) || (typeof viewing !== 'undefined' && !!viewing);
const boardFolderName = (ref) => {
  if (!ref || typeof ref !== 'string') return null;
  return ref.replace(/[/]+$/, '').split('/').at(-1) || null;
};
function boardLayoutStorageKey(folder, boardName) {
  if (!folder || !boardName) return null;
  return BOARD_LAYOUT_KEY + JSON.stringify([folder, boardName]);
}
function readBoardLayout(folder, boardName) {
  const k = boardLayoutStorageKey(folder, boardName);
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return {
      stacked: !!v.stacked,
      sideClosed: !!v.sideClosed,
      left: typeof v.left === 'number' && v.left > 0 ? Math.round(v.left) : null,
      top: typeof v.top === 'number' && v.top > 0 ? Math.round(v.top) : null,
    };
  } catch { return null; }
}
function captureLayout() {
  return { stacked, sideClosed, left: savedLeft, top: savedTop };
}
function saveBoardLayout(folder = typeof room !== 'undefined' ? room?.folder : null, boardName = typeof room !== 'undefined' ? boardFolderName(room?.active) : null) {
  if (isReadOnlyLayout()) return;
  const k = boardLayoutStorageKey(folder, boardName);
  if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(captureLayout())); } catch {}
}
function applyLayout(layout) {
  if (!layout) return;
  savedLeft = typeof layout.left === 'number' && layout.left > 0 ? Math.round(layout.left) : null;
  savedTop = typeof layout.top === 'number' && layout.top > 0 ? Math.round(layout.top) : null;
  if (!savedLeft) mainPanel.style.removeProperty('--left');
  if (!savedTop) mainPanel.style.removeProperty('--top');
  setStacked(!!layout.stacked, false);
  setSideClosed(!!layout.sideClosed, false);
  syncBoardSizes();
}
function syncBoardLayout() {
  const folder = typeof room !== 'undefined' ? room?.folder : null;
  if (!folder) return;
  const ro = isReadOnlyLayout();
  const boardName = (typeof viewing !== 'undefined' && viewing)
    ? boardFolderName(viewing.name || viewing.discussion)
    : (typeof peeking !== 'undefined' && peeking)
      ? boardFolderName(peeking.path || peeking.name)
      : boardFolderName(room?.active);
  const nextId = JSON.stringify([ro, folder, boardName || '']);
  if (nextId === appliedLayoutId) return;
  const wasRo = typeof appliedLayoutId === 'string' && appliedLayoutId.startsWith('[true,');
  if (ro && !wasRo) layoutBeforeReadOnly = captureLayout();
  appliedLayoutId = nextId;
  if (ro) {
    const saved = readBoardLayout(folder, boardName);
    if (saved) applyLayout(saved);
    return;
  }
  if (wasRo) {
    const restore = (boardName && readBoardLayout(folder, boardName)) || layoutBeforeReadOnly;
    layoutBeforeReadOnly = null;
    if (restore) applyLayout(restore);
    if (boardName && !readBoardLayout(folder, boardName)) saveBoardLayout(folder, boardName);
    return;
  }
  layoutBeforeReadOnly = null;
  if (!boardName) return; // unnamed new board: keep layout changes on screen until named
  const saved = readBoardLayout(folder, boardName);
  if (saved) applyLayout(saved);
  else saveBoardLayout(folder, boardName);
}
function setLeft(px) {
  const avail = mainPanel.getBoundingClientRect().width - split.offsetWidth;
  const min = avail > 0 && avail < MIN * 2 ? Math.max(120, Math.floor(avail / 2)) : MIN;
  const w = Math.round(Math.max(min, Math.min(Math.max(min, avail - min), px)));
  mainPanel.style.setProperty('--left', w + 'px');
  return w;
}
function setTop(px) {
  const avail = mainPanel.getBoundingClientRect().height - split.offsetHeight;
  const h = Math.round(Math.max(MIN_H, Math.min(Math.max(MIN_H, avail - MIN_H), px)));
  mainPanel.style.setProperty('--top', h + 'px');
  return h;
}
function setList(px) {
  const ctrlW = $('control-bar')?.getBoundingClientRect().width || 62;
  const svcW = isBoardNarrowed() ? ($('services-panel')?.getBoundingClientRect().width || 0) : 0;
  const max = Math.max(LIST_MIN, Math.min(LIST_MAX, document.documentElement.clientWidth - ctrlW - svcW - MIN * 2 - 14));
  const w = Math.round(Math.max(LIST_MIN, Math.min(max, px)));
  document.body.style.setProperty('--list', w + 'px');
  if (!stacked && !sideClosed && mainPanel.style.getPropertyValue('--left')) setLeft(savedLeft ?? $('left').getBoundingClientRect().width);
  return w;
}
function syncBoardSizes() {
  if (!document.body.classList.contains('list-collapsed')) {
    if (savedList) setList(savedList);
    else document.body.style.removeProperty('--list');
  }
  if (!sideClosed) {
    if (stacked) {
      if (savedTop) setTop(savedTop);
      else mainPanel.style.removeProperty('--top');
    } else {
      if (savedLeft) setLeft(savedLeft);
      else mainPanel.style.removeProperty('--left');
    }
  }
}
function setListCollapsed(collapsed, save = true) {
  document.body.classList.toggle('list-collapsed', collapsed);
  listToggle.textContent = collapsed ? '»' : '«';
  listToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  listToggle.setAttribute('aria-label', collapsed ? 'Expand boards list' : 'Collapse boards list');
  listToggle.title = collapsed ? 'Expand boards list' : 'Collapse boards list';
  if (save) { try { localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {} }
  if (!collapsed && savedList) setList(savedList);
  if (!stacked && !sideClosed && mainPanel.style.getPropertyValue('--left')) setLeft(savedLeft ?? $('left').getBoundingClientRect().width);
}
function setStacked(on, save = true) {
  stacked = !!on;
  mainPanel.classList.toggle('stacked', stacked);
  split.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  splitOrient.textContent = stacked ? '⇆' : '⇅';
  splitOrient.title = stacked ? 'Place conversation and side pane side by side' : 'Stack conversation above side pane';
  splitOrient.setAttribute('aria-label', splitOrient.title);
  if (save && !isReadOnlyLayout()) {
    try { localStorage.setItem(ORIENT_KEY, stacked ? 'stacked' : 'side'); } catch {}
    saveBoardLayout();
  }
  if (stacked) {
    if (savedTop) setTop(savedTop);
  } else {
    if (savedLeft) setLeft(savedLeft);
  }
}
function setSideClosed(closed, save = true) {
  sideClosed = !!closed;
  mainPanel.classList.toggle('side-closed', sideClosed);
  if (sideOpenBtn) sideOpenBtn.hidden = !sideClosed;
  if (save && !isReadOnlyLayout()) {
    try { localStorage.setItem(SIDE_CLOSED_KEY, sideClosed ? '1' : '0'); } catch {}
    saveBoardLayout();
  }
  if (!sideClosed) {
    if (!stacked && (savedLeft || mainPanel.style.getPropertyValue('--left'))) setLeft(savedLeft ?? $('left').getBoundingClientRect().width);
    if (stacked && (savedTop || mainPanel.style.getPropertyValue('--top'))) setTop(savedTop ?? $('left').getBoundingClientRect().height);
  }
}
const keep = (w) => {
  if (isReadOnlyLayout()) return;
  savedLeft = w;
  if (!isBoardNarrowed()) { try { localStorage.setItem(KEY, String(w)); } catch {} }
  saveBoardLayout();
};
const keepTop = (h) => {
  if (isReadOnlyLayout()) return;
  savedTop = h;
  if (!isBoardNarrowed()) { try { localStorage.setItem(TOP_KEY, String(h)); } catch {} }
  saveBoardLayout();
};
const keepList = (w) => { if (isBoardNarrowed()) return; savedList = w; try { localStorage.setItem(LIST_KEY, String(w)); } catch {} };
try {
  savedList = Number(localStorage.getItem(LIST_KEY)) || null;
  savedLeft = Number(localStorage.getItem(KEY)) || null;
  savedTop = Number(localStorage.getItem(TOP_KEY)) || null;
  if (savedList) setList(savedList);
  if (localStorage.getItem(LIST_COLLAPSED_KEY) === '1') setListCollapsed(true, false);
  if (localStorage.getItem(ORIENT_KEY) === 'stacked') setStacked(true, false);
  if (localStorage.getItem(SIDE_CLOSED_KEY) === '1') setSideClosed(true, false);
  if (savedLeft) setLeft(savedLeft);
  if (savedTop) setTop(savedTop);
} catch {}
listToggle.onclick = () => {
  const next = !document.body.classList.contains('list-collapsed');
  setListCollapsed(next, !isBoardNarrowed());
  if (!next) post('__workerinfo', {}).catch(() => {});
};
splitOrient.onclick = () => setStacked(!stacked);
sideCloseBtn.onclick = () => setSideClosed(true);
sideOpenBtn.onclick = () => setSideClosed(false);
listSplit.addEventListener('pointerdown', (e) => {
  if (document.body.classList.contains('list-collapsed')) return;
  e.preventDefault();
  listSplit.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing-list');
  const listStart = () => $('list-panel').getBoundingClientRect().left;
  const move = (ev) => setList(ev.clientX - listStart() - 3);
  const stop = (ev) => {
    listSplit.removeEventListener('pointermove', move);
    listSplit.removeEventListener('pointerup', stop);
    listSplit.removeEventListener('pointercancel', stop);
    document.body.classList.remove('resizing-list');
    keepList(setList(ev.clientX - listStart() - 3));
  };
  listSplit.addEventListener('pointermove', move);
  listSplit.addEventListener('pointerup', stop);
  listSplit.addEventListener('pointercancel', stop);
});
listSplit.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (document.body.classList.contains('list-collapsed')) return;
  e.preventDefault();
  keepList(setList($('list-panel').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -24 : 24)));
});
split.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  split.setPointerCapture(e.pointerId);
  const vert = stacked;
  document.body.classList.add(vert ? 'resizing-v' : 'resizing');
  const rect = () => mainPanel.getBoundingClientRect();
  const move = (ev) => (vert ? setTop(ev.clientY - rect().top - 3) : setLeft(ev.clientX - rect().left - 3));
  const stop = (ev) => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', stop);
    split.removeEventListener('pointercancel', stop);
    document.body.classList.remove('resizing', 'resizing-v');
    if (vert) keepTop(setTop(ev.clientY - rect().top - 3));
    else keep(setLeft(ev.clientX - rect().left - 3));
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', stop);
  split.addEventListener('pointercancel', stop);
});
split.addEventListener('keydown', (e) => {
  if (stacked) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    keepTop(setTop($('left').getBoundingClientRect().height + (e.key === 'ArrowUp' ? -24 : 24)));
  } else {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    keep(setLeft($('left').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -24 : 24)));
  }
});
// A narrower/shorter window must not squeeze one side below MIN/MIN_H, and must not overwrite saved sizes.
window.addEventListener('resize', () => {
  syncBoardSizes();
  if (typeof fitHostShell === 'function') fitHostShell(false);
});
function message(m, live = false) {
  localMessages.push(m);
  if (viewing || peeking) return;
  if (m.pass || m.hidden) return; // passes and summary turns are hidden, as in the terminal
  const el = bubble(m);
  talk.add(el);
  mention(el, m, live);
  if (m.outcome) renderAutoDev();
}
// The stop buttons (see stopWorker in ui.mjs and renderWorkerStop): each takes a second click to
// confirm, as Close discussion does.
async function stopWorker(mode) {
  try { const res = await post('__stopworker', { mode }); if (!res.ok) throw new Error(await res.text()); }
  catch (err) { status(err.message, true, 'Worker'); }
}
confirmed($('wstop-after'), () => stopWorker('after'), 'Click again: stop after this task; queued instructions are cancelled', () => true);
confirmed($('wstop-now'), () => stopWorker('now'), 'Click again: stop now; partial edits may be left', () => true);
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
  if (error && source !== 'Worker') busyFailed();
}
// The busy bar: shown while a request of this page is in flight or the room still has a command
// from the screen waiting or running (the busy event), once that has lasted BUSY_AFTER ms. It is
// for actions of the screen only, not for agents thinking or the worker working. An error shown
// during an action, or just after it, turns the bar red for BUSY_FAILED ms.
const BUSY_AFTER = 300, BUSY_FAILED = 1500;
let posting = 0, commandBusy = false, busyShow = null, busyFail = null, busyEnded = 0;
const isBusy = () => posting > 0 || commandBusy;
function updateBusy() {
  const bar = $('busy');
  if (isBusy()) { busyShow ??= setTimeout(() => { busyShow = null; if (!busyFail && isBusy()) bar.dataset.state = 'on'; }, BUSY_AFTER); return; }
  busyEnded = Date.now();
  clearTimeout(busyShow); busyShow = null;
  if (!busyFail) delete bar.dataset.state;
}
function busyFailed() {
  if (!isBusy() && Date.now() - busyEnded > BUSY_FAILED) return; // not an action of this page
  const bar = $('busy');
  bar.dataset.state = 'failed';
  clearTimeout(busyFail);
  busyFail = setTimeout(() => { busyFail = null; if (isBusy()) bar.dataset.state = 'on'; else delete bar.dataset.state; }, BUSY_FAILED);
}
function setThinking(name) {
  localThinking = name; if (name) yourTurn = false; updateReplicaView();
  if (viewing || peeking) return;
  talk.think(name ? '… ' + name + ' is thinking' : null);
}
const urlFor = (file) => file.split('/').map(encodeURIComponent).join('/');
const BINARY_FILE = /\.(icns|ico|bmp|tiff?|heic|avif|zip|tar|gz|tgz|bz2|xz|7z|rar|zst|dmg|pkg|iso|bin|exe|dll|so|dylib|a|o|wasm|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|m4a|aac|mp4|mov|webm|avi|mkv|sqlite3?|db|pyc|class|jar)$/i;
// Display title for a discussion or brainstorm: the saved title when it isn't just the folder
// name; otherwise the folder name with its leading YYYY-MM-DD- stripped and hyphens as spaces.
function displayTitle(name, title) {
  const saved = typeof title === 'string' ? title.trim() : '';
  if (saved && saved !== name) return saved;
  return String(name ?? '').replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/, '').replace(/-/g, ' ');
}
function discussionTitle(name, path = 'discussions/' + name) {
  const saved = room?.open?.find((o) => o.active === path)?.title
    ?? (room?.active === path ? room.discussion : null)
    ?? room?.checkpoints?.find((c) => c.name === name)?.title;
  return displayTitle(name, saved);
}
function brainstormTitle(name) {
  const path = 'brainstorms/' + name;
  const saved = room?.open?.find((o) => o.active === path)?.title
    ?? (room?.active === path ? room.discussion : null)
    ?? room?.checkpoints?.find((c) => c.name === path)?.title;
  return displayTitle(name, saved);
}
// The side pane's two tabs: Explorer and Document. Each keeps its place while the other is shown:
// Explorer its tree and scroll position, Document its file and scroll position.
let subtab = 'explorer', explorerMode = 'discussion', peek = null, lastActiveKey = undefined;
const hasDiscussionTree = () => !!(peek || viewing || room?.active);
const effectiveExplorerMode = () => (hasDiscussionTree() ? explorerMode : 'root');
function showSub(name) {
  if (name === 'document' && !doc) return;
  subtab = name;
  $('explorer').hidden = name !== 'explorer';
  $('document').hidden = name !== 'document';
  $('tab-explorer').classList.toggle('on', name === 'explorer');
  $('tab-document').classList.toggle('on', name === 'document');
}
function selectSub(name) {
  if (name === 'document' && !doc) return;
  if (typeof sideClosed !== 'undefined' && sideClosed && typeof setSideClosed === 'function') setSideClosed(false);
  showSub(name);
  if (name === 'explorer') revealDoc();
}
$('tab-explorer').onclick = () => selectSub('explorer');
// Back to Explorer with a local file shown: if that file is inside the tree Explorer is showing now,
// unfold its parent folders and scroll it into view. Never re-enters a peek that was ended.
async function revealDoc() {
  if (!doc || doc.startsWith('__received/') || viewing) return;
  const mode = effectiveExplorerMode();
  if (mode === 'root') {
    const p = doc.split('/');
    if (!inDiscussion(doc)) {
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
$('tab-document').onclick = () => selectSub('document');
// Document's path line: names the discussion (current, peeked or received) or "Room checkout", plus the file's path inside it.
function docLabel(file) {
  if (!file) return 'No document shown.';
  if (file.startsWith('__received/')) {
    const [, d, node, , ...rest] = file.split('/');
    const rec = replica?.received?.find((l) => l.discussion === d && l.node === node);
    const raw = (peek?.kind === 'received' && peek.discussion === d ? peek.name : null) || rec?.local || rec?.name || d;
    const title = (peek?.kind === 'received' && peek.discussion === d ? peek.title : null) || rec?.title;
    return displayTitle(raw, title) + ' · ' + rest.join('/');
  }
  const p = file.split('/');
  if (p[0] === 'discussions' && p.length >= 3 && isDiscussion(p[1])) return discussionTitle(p[1], 'discussions/' + p[1]) + ' · ' + p.slice(2).join('/');
  if (p[0] === 'brainstorms' && p.length >= 3 && isDiscussion(p[1])) return brainstormTitle(p[1]) + ' · ' + p.slice(2).join('/');
  if (p[0] === 'discussions' && p.length >= 4 && SECTIONS[p[1]] && isDiscussion(p[2])) return discussionTitle(p[2], 'discussions/' + p[1] + '/' + p[2]) + ' · ' + p.slice(3).join('/');
  if (p[0] === 'brainstorms' && p.length >= 4 && SECTIONS[p[1]] && isDiscussion(p[2])) return brainstormTitle(p[2]) + ' · ' + p.slice(3).join('/');
  return 'Room checkout · ' + file;
}
function currentTitle() {
  if (viewing) return displayTitle(viewing.name, viewing.title);
  if (peeking) return displayTitle(peeking.name, peeking.title);
  if (room) return displayTitle(room.active?.split('/').at(-1), room.discussion);
  return '';
}
function updateTabTitle() {
  if (doc) { document.title = docLabel(doc) + ' · agent-room'; return; }
  const title = currentTitle();
  document.title = title && (viewing || peeking || room?.active || room?.brainstorm) ? title + ' · agent-room' : 'agent-room';
}
// A file chosen (here, on another page, or by the room) opens in Document, which comes to the front.
function showDoc(file) {
  const same = !!file && file === doc && !!docpane.firstChild;
  doc = file || null;
  // Send to agents, on a transcript of an earlier session (not this one): a normal message asking
  // the agents to read it as background; its old sessions are not resumed.
  const feed = $('feed');
  const p = doc ? doc.split('/') : [];
  const transcript = p.length >= 3 && p.length <= 5 && (p[0] === 'discussions' || p[0] === 'brainstorms') && p.at(-2) === 'transcripts' && p.at(-1).endsWith('.md');
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
  if (!doc) { docpane.replaceChildren(); updateTabTitle(); if (subtab === 'document') showSub('explorer'); return; }
  if (typeof sideClosed !== 'undefined' && sideClosed && typeof setSideClosed === 'function') setSideClosed(false);
  if (!same) { docpane.innerHTML = '<iframe id="doc"></iframe>'; docpane.firstChild.src = urlFor(doc); }
  updateTabTitle();
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
const post = (path, body) => {
  posting++; updateBusy();
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': viewClient }, body: JSON.stringify(body) })
    .catch((err) => { busyFailed(); throw err; }).finally(() => { posting--; updateBusy(); });
};
// Each browser owns a leased View pin, independent of other browsers and local agents.
async function viewRemote(line) {
  const res = await post('__view', line ? { discussion: line.discussion, node: line.node } : { back: true });
  if (!res.ok) return status(await res.text(), true);
  viewing = (await res.json()).viewing;
  peek = null;
  viewExpired = false; viewNotice = null;
  if (typeof syncBoardLayout === 'function') syncBoardLayout();
  updateReplicaView();
  showDoc(null);
  talk.clear();
  if (viewing) {
    explorerMode = 'discussion';
    viewing.messages.forEach((m) => { if (!m.pass && !m.hidden) talk.add(bubble(m)); });
    await openFiles();
  } else {
    localMessages.forEach((m) => { if (!m.pass && !m.hidden) { const el = bubble(m); talk.add(el); mention(el, m, false); } });
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
  const activeName = !room?.brainstorm && room?.active?.startsWith('discussions/') ? room.active.split('/').at(-1) : null;
  const closing = !peeking && !viewing ? closingPhase(activeName) : null;
  if (closing) return closingLabel(closing);
  if (tab === 'work') return localWorking ? localWorking + ' is working' : 'idle';
  if (!room) return '';
  if (peeking) return 'peeking at ' + displayTitle(peeking.name, peeking.title) + ' · read-only';
  if (viewing) return 'read-only';
  if (localThinking) return localThinking + ' is thinking';
  if (room.autoDev?.status === 'running') return 'Auto dev running';
  return room.started && yourTurn ? 'your turn' : '';
}
function closingPhase(name) { return (name && room?.closingDiscussions?.[name]) || null; }
function closingLabel(phase) { return phase === 'waiting' ? 'closing · waiting for worker' : phase === 'writing' ? 'closing · writing statement' : ''; }
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
    s.append(dot, displayTitle(o.active?.split('/').at(-1), o.title) + ' · Worker is working');
    return s;
  }));
}
// The Worker tab's stop buttons: while this discussion's worker runs an instruction, and not while
// the page peeks at another discussion or views a peer's (they come back at once on returning).
function renderWorkerStop() {
  const w = room?.workerStop;
  $('wstop').hidden = !w || w.now || !!viewing || !!peeking || !localInput;
  $('wstop-after').disabled = !!w?.after;
}
// Entering or leaving a peek (the reset event): the stop buttons and Explorer file peek follow at once.
function setPeeking(p) {
  peeking = p;
  if (p?.path) {
    peek = { kind: 'local', path: p.path, name: p.name, title: p.title, readonly: true };
    explorerMode = 'discussion';
    updateTabs();
  } else if (!p && peek?.readonly) {
    peek = null;
    updateTabs();
  }
  renderWorkerStop();
  if (typeof syncBoardLayout === 'function') syncBoardLayout();
}
function closeActionLabel(lane) {
  return lane && (workerPending ?? []).some((p) => p.lane === lane) ? 'Close with pending work' : 'Close';
}
function configureMergeButton(btn, lane) {
  const m = lane && workerMergeable ? workerMergeable[lane] : null;
  if (!m) { btn.hidden = true; return false; }
  btn.hidden = false;
  if (m.catchUp) {
    btn.textContent = 'Catch up with ' + m.targetBranch;
    btn.disabled = false;
    btn.title = 'Ask the worker to merge ' + m.targetBranch + ' into worker/' + lane + ' and run tests; nothing merges into ' + m.targetBranch + ' automatically.';
  } else if (m.canMerge) {
    btn.textContent = 'Close and Merge';
    btn.disabled = false;
    btn.title = 'Merge worker/' + lane + ' into ' + m.targetBranch + ', remove the worktree and branch, and close.';
  } else {
    btn.textContent = 'Close and Merge';
    btn.disabled = true;
    btn.title = m.disabledReason || 'Cannot Close and Merge yet.';
  }
  return true;
}
function updateCloseButton() {
  const b = $('closedisc');
  if (!b) return;
  const activeLane = !room?.brainstorm && room?.active?.startsWith('discussions/') ? room.active.slice('discussions/'.length) : null;
  const label = room?.brainstorm ? 'Close brainstorm' : closeActionLabel(activeLane);
  if (b.dataset.armed) b.dataset.label = label;
  else b.textContent = label;
  const m = $('closemerge');
  if (m) {
    if (b.hidden || !activeLane || !!room?.brainstorm || !!room?.closedDiscussions?.includes(activeLane)) m.hidden = true;
    else configureMergeButton(m, activeLane);
  }
  const d = $('closediscard');
  if (d) d.hidden = b.hidden || !activeLane || !!room?.brainstorm || !workerDiscardable?.has(activeLane) || !!room?.closedDiscussions?.includes(activeLane);
}
async function startCatchUp(name) {
  try {
    const res = await post('__catchup', { name });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    status('Queued catch-up with ' + data.targetBranch + ' for ' + name + '. Review the report, then click Close and Merge again.', false);
  } catch (err) { status(err.message, true); }
}
async function startMerge(name) {
  const m = workerMergeable?.[name];
  if (m?.catchUp) return startCatchUp(name);
  try {
    const res = await post('__merge', { name });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    if (data.catchUp) return showCatchUpDialog(name, data);
    showMergeDialog(name, data.preview, false);
  } catch (err) { status(err.message, true); }
}
function showCatchUpDialog(name, data) {
  const dialog = document.createElement('dialog');
  dialog.className = 'discard-dialog';
  const h = document.createElement('h3'); h.textContent = 'Catch up with ' + data.targetBranch + '?'; dialog.append(h);
  const p = document.createElement('p'); p.className = 'discard-note'; p.textContent = data.message; dialog.append(p);
  const buttons = document.createElement('div'); buttons.className = 'discard-buttons';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  const go = document.createElement('button'); go.type = 'button'; go.textContent = 'Catch up with ' + data.targetBranch;
  go.onclick = async () => { dialog.close(); await startCatchUp(name); };
  buttons.append(cancel, go); dialog.append(buttons);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
function showMergeDialog(name, initialPreview, initialChanged) {
  const dialog = document.createElement('dialog');
  dialog.className = 'discard-dialog';
  let current = initialPreview;
  const render = (preview, changed, errMsg = '') => {
    current = preview;
    dialog.replaceChildren();
    const h = document.createElement('h3'); h.textContent = preview.title; dialog.append(h);
    if (changed) {
      const w = document.createElement('p'); w.className = 'discard-warn';
      w.textContent = 'The room branch or worktree changed since your first click. Review the updated preview below and confirm again.';
      dialog.append(w);
    }
    const note = document.createElement('p'); note.className = 'discard-note';
    note.textContent = 'After merging, the worktree and branch will be removed and the discussion closed.';
    dialog.append(note);
    if (preview.untracked?.length) {
      const u = document.createElement('p'); u.className = 'discard-note';
      u.textContent = 'Untracked files in the worktree will be deleted for good: ' + preview.untracked.join(', ');
      dialog.append(u);
    }
    if (preview.activeNotice) {
      const act = document.createElement('p'); act.className = 'discard-note';
      act.textContent = preview.activeNotice;
      dialog.append(act);
    }
    const section = (title, items) => {
      const sh = document.createElement('h4'); sh.textContent = title + ' (' + items.length + ')'; dialog.append(sh);
      if (!items.length) { const p = document.createElement('p'); p.className = 'discard-note'; p.textContent = 'None.'; dialog.append(p); return; }
      const ul = document.createElement('ul');
      for (const text of items) { const li = document.createElement('li'); li.textContent = text; ul.append(li); }
      dialog.append(ul);
    };
    section('Commits to merge', preview.commits.map((c) => c.hash + ' ' + c.subject));
    const errEl = document.createElement('p'); errEl.className = 'discard-err'; errEl.textContent = errMsg;
    if (errMsg) dialog.append(errEl);
    const buttons = document.createElement('div'); buttons.className = 'discard-buttons';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Confirm ' + preview.title;
    confirm.onclick = async () => {
      confirm.disabled = true; cancel.disabled = true;
      try {
        const res = await post('__merge', { name, snapshot: current.snapshot });
        if (!res.ok) throw new Error(await res.text());
        const out = await res.json();
        if (out.catchUp) { dialog.close(); showCatchUpDialog(name, out); return; }
        if (out.changed) { render(out.preview, true); return; }
        dialog.close();
      } catch (err) {
        render(current, false, err.message);
      }
    };
    buttons.append(cancel, confirm); dialog.append(buttons);
  };
  render(initialPreview, initialChanged);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
async function startDiscard(name) {
  try {
    const res = await post('__discard', { name });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    showDiscardDialog(name, data.preview, false);
  } catch (err) { status(err.message, true); }
}
function showDiscardDialog(name, initialPreview, initialChanged) {
  const dialog = document.createElement('dialog');
  dialog.className = 'discard-dialog';
  let current = initialPreview;
  const render = (preview, changed, errMsg = '') => {
    current = preview;
    dialog.replaceChildren();
    const h = document.createElement('h3'); h.textContent = 'Close and Discard ' + name + '?'; dialog.append(h);
    if (changed) {
      const w = document.createElement('p'); w.className = 'discard-warn';
      w.textContent = 'The worktree or branch changed since your first click. Review the updated list below and confirm again.';
      dialog.append(w);
    }
    const note = document.createElement('p'); note.className = 'discard-note';
    note.textContent = preview.commits.length
      ? 'Commits will be saved to a recovery ref under refs/discarded/' + name + '/… (commits only; uncommitted, untracked and ignored files are deleted for good).'
      : 'Nothing committed to save; the worktree and branch will be removed and all uncommitted, untracked and ignored files deleted for good.';
    dialog.append(note);
    const section = (title, items) => {
      const sh = document.createElement('h4'); sh.textContent = title + ' (' + items.length + ')'; dialog.append(sh);
      if (!items.length) { const p = document.createElement('p'); p.className = 'discard-note'; p.textContent = 'None.'; dialog.append(p); return; }
      const ul = document.createElement('ul');
      for (const text of items) { const li = document.createElement('li'); li.textContent = text; ul.append(li); }
      dialog.append(ul);
    };
    section('Commits not in main', preview.commits.map((c) => c.hash + ' ' + c.subject));
    section('Tracked edits', preview.tracked.map((t) => t.status + ' ' + t.path));
    section('Untracked files', preview.untracked);
    section('Ignored files (by top-level folder)', preview.ignored.map((i) => i.label));
    const errEl = document.createElement('p'); errEl.className = 'discard-err'; errEl.textContent = errMsg;
    if (errMsg) dialog.append(errEl);
    const buttons = document.createElement('div'); buttons.className = 'discard-buttons';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'danger'; confirm.textContent = 'Confirm Close and Discard';
    confirm.onclick = async () => {
      confirm.disabled = true; cancel.disabled = true;
      try {
        const res = await post('__discard', { name, snapshot: current.snapshot });
        if (!res.ok) throw new Error(await res.text());
        const out = await res.json();
        if (out.changed) { render(out.preview, true); return; }
        dialog.close();
      } catch (err) {
        render(current, false, err.message);
      }
    };
    buttons.append(cancel, confirm); dialog.append(buttons);
  };
  render(initialPreview, initialChanged);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
function updateReplicaView() {
  updateDiscWorkers();
  renderWorkerStop();
  updateReplicaHeader();
  renderAutoDev();
  const readOnly = !!(viewing || peeking);
  if (room) { $('disc').textContent = currentTitle(); $('disc').dataset.active = !readOnly && room.active ? 'true' : 'false'; }
  updateTabTitle();
  // Under the title, show the activity of the selected tab.
  $('disc-status').textContent = talkStatus();
  const panel = $('remote-view'); panel.hidden = !readOnly; panel.replaceChildren();
  const wpanel = $('work-remote-view');
  if (wpanel) { wpanel.hidden = !readOnly; wpanel.replaceChildren(); }
  $('composer').hidden = !readOnly && !localInput;
  if (!updateReplicaView.talkPlaceholder && box.placeholder) updateReplicaView.talkPlaceholder = box.placeholder;
  box.hidden = !!viewing;
  box.disabled = readOnly || (typeof ended !== 'undefined' && ended) || (typeof restarting !== 'undefined' && restarting);
  if (peeking && !viewing) box.placeholder = 'Peeking read-only — click Back to return to the active discussion.';
  else if (updateReplicaView.talkPlaceholder) box.placeholder = updateReplicaView.talkPlaceholder;
  if (typeof wbox !== 'undefined' && wbox) {
    if (readOnly) {
      wbox.disabled = true;
      wbox.placeholder = peeking ? 'Peeking read-only — click Back to return to the active discussion.' : 'Read-only: viewing a peer’s discussion.';
    } else if (typeof showWorkerInfo === 'function' && typeof workerInfoShown !== 'undefined') {
      showWorkerInfo(workerInfoShown);
    }
  }
  // Attach and pointing chips: shown in discussions and brainstorms (Attach is disabled until the first message creates the folder).
  $('attach-row').hidden = readOnly || !room;
  if ($('attach-row').hidden && !attaching) pending = [];
  const kind = room?.brainstorm ? 'brainstorm' : 'discussion';
  $('attach').title = room?.active ? 'Attach files to your next message: saved into this ' + kind + "'s files/ folder when you send it (25 MB at most each)" : 'Send a first message to start the ' + kind + '; then you can attach files';
  renderAttachments();
  $('talk-settings').hidden = readOnly;
  $('summary').hidden = readOnly;
  $('reload').hidden = readOnly;
  // New discussion (in the header): ends this session (in the terminal); the next message starts the new one.
  // New brainstorm, beside it, is always offered (it ends a session or a brainstorm the same way).
  $('new-discussion').hidden = !(room && localInput && !readOnly);
  $('newdisc').hidden = !(room?.active || room?.brainstorm);
  // Turn into a discussion: a brainstorm once its first message has named it.
  $('convert').hidden = !(room?.brainstorm && room.active);
  // With several discussions open (the screen), New discussion and Resume keep this one open;
  // Close closes it (labelled "Close with pending work" when its branch has pending work).
  $('closedisc').hidden = !room?.multi || !(room.active || room.brainstorm || room.open?.length > 1);
  updateCloseButton();
  if (room?.multi) {
    $('newdisc').title = 'Open a new discussion beside this one, which stays open (click it in Boards to show it again).';
    $('newbrainstorm').title = 'A conversation with the same agents, beside the open discussions and brainstorms, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a discussion for that.';
  }
  $('actions-menu').hidden = ['summary', 'new-discussion'].every((id) => $(id).hidden);
  if (peeking && !viewing) {
    const noticeText = 'Peeking at ' + displayTitle(peeking.name, peeking.title) + '. Read-only — click Back to return to the active discussion.' + (peeking.doc ? '' : ' No notes to show.');
    const fillPeekBanner = (target) => {
      if (!target) return;
      const label = document.createElement('p');
      label.textContent = noticeText;
      target.append(label);
      const back = document.createElement('button'); back.textContent = 'Back'; back.title = 'Return to the active discussion'; back.onclick = () => send('/peek'); target.append(back);
      if (peeking.ref) {
        const res = document.createElement('button'); res.textContent = 'Resume'; res.title = 'Resume this closed board'; res.onclick = () => send('/resume ' + peeking.ref); target.append(res);
      }
    };
    fillPeekBanner(panel);
    fillPeekBanner(wpanel);
    return;
  }
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
  if (wpanel) {
    const wl = document.createElement('p'); wl.textContent = 'Read-only: viewing ' + viewing.node + "'s line."; wpanel.append(wl);
    if (own) { const wb = document.createElement('button'); wb.textContent = 'Back to ' + replica.node + "'s line"; wb.onclick = () => viewRemote(null); wpanel.append(wb); }
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
const inDiscussion = (f) => { const p = f.split('/'); return (p[0] === 'brainstorms' || p[0] === 'discussions') && p.length >= 2 && (isDiscussion(p[1]) || Boolean(SECTIONS[p[1]])); };
// The discussion a list path shows, as /resume and /move name it ("<name>" or "archive/<name>"), or null.
function discussionOf(parts) {
  if (parts.length === 2 && isDiscussion(parts[1])) return { ref: parts[1], section: null };
  if (parts.length === 3 && SECTIONS[parts[1]] && isDiscussion(parts[2])) return { ref: parts[1] + '/' + parts[2], section: parts[1] };
  return null;
}
// Continue / Resume (one button for a discussion not on screen): what it does, by the discussion's state.
// open: its entry in room.open when it is open in another context (started: Continue only shows it).
function resumeTip(name, open, section, closed) {
  const saved = room?.checkpoints?.find((c) => c.name === name);
  const what = open ? 'Show it: its agents carry on, nothing is restarted.'
    : closed ? 'Reopen from its closing statement (or pending handoff) with new agent and worker sessions.'
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
  b.onclick = (e) => {
    e.stopPropagation();
    if (ask() && !b.dataset.armed) {
      b.dataset.armed = '1'; b.dataset.label = b.textContent;
      b.textContent = warning || 'Click again: this session ends and the chat clears';
      return setTimeout(() => { delete b.dataset.armed; b.textContent = b.dataset.label; }, 4000);
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
    confirm.disabled = !!inUse || !room?.closedDiscussions?.includes(name);
    confirm.title = !room?.closedDiscussions?.includes(name) ? 'Close the discussion before archiving it.' : inUse ? 'Switch to another discussion before confirming archive' : 'Review the rollback report first. Archive the discussion; merging its worker branch into main stays manual.';
    confirmed(confirm, () => send('/archive-rollback ' + ref), 'Click again: I reviewed the rollback report; archive', () => true);
    row.append(confirm);
  }
}
const pendingArchives = new Set();
function archiveButton(b, ref) {
  const key = ref.startsWith('brainstorms/') ? ref : 'discussions/' + ref;
  const pending = pendingArchives.has(key);
  b.classList.toggle('archiving', pending);
  b.setAttribute('aria-busy', String(pending));
  if (pending) b.disabled = true;
  b.onclick = async () => {
    if (ended) return;
    pendingArchives.add(key);
    archiveButton(b, ref);
    try {
      const res = await post('__say', { text: '/move ' + ref + ' archive' });
      if (res.ok) return; // Accepted into the queue: keep spinning until the moved event.
      status(await res.text(), true);
    } catch (err) { status(err.message, true); }
    pendingArchives.delete(key);
    openFiles();
  };
}
const expandedLines = new Set();
const expandedSections = new Set(['discussions', 'brainstorms']);
let openRowMenu = null; // the board path whose ⋯ menu is open
let cachedDetail = { files: null, unviewable: new Set(), branch: null }; // files: null until the list loads

// The User's order of active discussions (and, in the Brainstorms tab, of brainstorms), kept in this
// browser per room (room.folder) as a JSON array of names, under each list's own key. Names it does
// not list go on top, newest first; names gone are dropped.
const ORDER_KEYS = { discussions: 'agent-room.discussion-order:', brainstorms: 'agent-room.brainstorm-order:' };
let dragging = false, renderAfterDrag = false; // the list is not replaced while a row is dragged
function readOrder(folder, kind = 'discussions') {
  let raw = null;
  try { raw = localStorage.getItem(ORDER_KEYS[kind] + folder); } catch {}
  let list = [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string'); } catch {}
  return { raw, list };
}
function saveOrder(folder, order, kind = 'discussions') {
  try { localStorage.setItem(ORDER_KEYS[kind] + folder, JSON.stringify(order)); } catch {}
}
const renderOrdered = () => renderBoards();
// The names found in the files list, in the User's order (saved back when it changed), or as found
// while the list hasn't loaded (null: no ordering then).
function ordered(found, kind) {
  if (!room?.folder || !Array.isArray(cachedDetail?.files)) return null;
  const saved = readOrder(room.folder, kind);
  const list = orderDiscussions(found, saved.list);
  if (JSON.stringify(list) !== saved.raw) saveOrder(room.folder, list, kind);
  return list;
}
function orderDiscussions(found, saved) {
  const here = new Set(found);
  const kept = [...new Set(saved)].filter((d) => here.has(d));
  const known = new Set(kept);
  return [...found.filter((d) => !known.has(d)), ...kept];
}
// Moves name to index in order, saves it and redraws (Move up / Move down, and a drop).
function moveDiscussion(order, name, index, kind = 'discussions') {
  const next = order.filter((d) => d !== name);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, name);
  if (room?.folder) saveOrder(room.folder, next, kind);
  renderOrdered(kind);
}
// A discussion moved out of or back into discussions/ loses its place: it returns on top.
function forgetOrder(name, kind = 'discussions') {
  if (!room?.folder || !name) return;
  const { raw, list } = readOrder(room.folder, kind);
  if (raw !== null && list.includes(name)) saveOrder(room.folder, list.filter((d) => d !== name), kind);
}
if (typeof addEventListener === 'function') {
  addEventListener('storage', (e) => {
    for (const kind of Object.keys(ORDER_KEYS)) if (room?.folder && e.key === ORDER_KEYS[kind] + room.folder) renderOrdered(kind);
  });
}
// A row of an ordered list (names, in order): its ⠿ handle, and the row as a drop target.
function dragRow(row, name, names, kind) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const handle = el('span', 'drag-handle', '⠿');
  handle.title = 'Drag to reorder';
  handle.draggable = true;
  handle.addEventListener('dragstart', (e) => {
    dragging = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.setDragImage?.(row, 0, 0);
    row.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    dragging = false;
    row.classList.remove('dragging');
    if (renderAfterDrag) { renderAfterDrag = false; renderBoards(); }
  });
  row.append(handle);
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
    const moved = e.dataTransfer.getData('text/plain');
    if (!dragging || !names.includes(moved)) return;
    e.preventDefault();
    const rest = names.filter((x) => x !== moved);
    const next = rest.indexOf(name) + (after(e) ? 1 : 0);
    if (moved !== name) { rest.splice(next, 0, moved); saveOrder(room.folder, rest, kind); }
    renderAfterDrag = true; // drawn on dragend, which follows the drop
  });
}
// Move up / Move down in a row's menu, disabled at the ends.
function orderButtons(items, name, i, names, kind) {
  for (const [label, to, off] of [['Move up', i - 1, i === 0], ['Move down', i + 1, i === names.length - 1]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = off;
    b.onclick = () => { openRowMenu = null; closeMenus(); moveDiscussion(names, name, to, kind); };
    items.append(b);
  }
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

// Boards list panel (left of Discussion/Worker): collapsible sections for active Discussions,
// Brainstorms, Archived · Deferred, and Received from peers (the latter two folded by default with
// counts). Clicking an active row switches to it; clicking a closed row peeks chat + files read-only
// without starting any session; secondary actions live in each row's ⋯ menu.
let workerPending = null, workerDiscardable = new Set(), workerMergeable = {}, workerMerged = new Set();
function renderBoards() {
  const container = $('list-pane');
  if (!container) return;
  if (dragging) { renderAfterDrag = true; return; }
  const scroll = container.scrollTop;
  container.innerHTML = '<div id="board-list"></div>';
  const list = container.firstChild;
  requestAnimationFrame(() => { container.scrollTop = scroll; });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const canAct = room && localInput && !viewing;
  const makeSection = (key, title, count) => {
    const details = el('details', 'list-section');
    details.dataset.section = key;
    details.open = expandedSections.has(key);
    details.ontoggle = () => { if (details.open) expandedSections.add(key); else expandedSections.delete(key); };
    details.append(el('summary', '', title + ' (' + count + ')'));
    list.append(details);
    return details;
  };
  const makeRowMenu = (path) => {
    const menu = el('details', 'menu row-menu'), items = el('div', 'menu-items');
    const sum = el('summary', '', '⋯');
    sum.setAttribute('aria-label', 'Board actions');
    sum.title = 'Actions';
    menu.append(sum, items);
    menu.open = openRowMenu === path;
    menu.addEventListener('toggle', () => { if (menu.open) openRowMenu = path; else if (openRowMenu === path) openRowMenu = null; });
    return { menu, items };
  };
  const peekFiles = (info) => {
    peek = info;
    explorerMode = 'discussion';
    showSub('explorer');
    updateTabs();
    renderExplorer();
    renderBoards();
  };
  const enterClosedPeek = (ref, path, name, title) => {
    peek = { kind: 'local', path, name, title, readonly: true };
    explorerMode = 'discussion';
    showSub('explorer');
    updateTabs();
    renderExplorer();
    renderBoards();
    send('/peek ' + ref);
  };

  const boardState = (openEntry, { closed = false, isCurrent = false, closing = null } = {}) => {
    if (openEntry?.ongoing || openEntry?.working || closing) return 'ongoing';
    if (closed) return 'closed';
    if (openEntry ? !openEntry.started : isCurrent && !room?.started) return 'not started';
    if (openEntry?.waitingForInput) return 'waiting for input';
    return 'idle';
  };

  // --- 1. Discussions (active) ---
  const inOrder = ordered(discussionsIn('discussions'), 'discussions');
  const discussions = inOrder ?? discussionsIn('discussions');
  const unstartedOpen = (room?.open ?? []).filter((x) => !x.current && !x.active);
  const discSection = makeSection('discussions', 'Discussions', discussions.length + unstartedOpen.length);

  for (const o of unstartedOpen) {
    const r = el('div', 'row discussion-row');
    const block = el('div', 'discussion-block');
    const btn = el('button', 'entry discussion', o.title);
    btn.title = 'Show this open discussion: it has not started yet';
    btn.onclick = () => notesGuard(() => { location.href = o.url; });
    block.append(btn);
    block.append(el('div', 'local-label', boardState(o) + (o.working ? ' · worker working' : '')));
    r.append(block);
    discSection.append(r);
  }

  const currentWorker = room?.open?.find((o) => o.current)?.working ? ' · worker working' : '';
  if (room?.brainstorm && canAct) {
    discSection.append(el('span', 'hint', 'A brainstorm is shown: it is listed in Brainstorms. Turn it into a discussion (Actions ▾) to have it here.'));
  } else if (!discussions.length && !unstartedOpen.length && !replica?.received?.some((l) => !l.local)) {
    discSection.append(el('span', 'hint', (room?.started ? '' : 'No active discussions: your first message starts one.') + currentWorker));
  } else if (room && !room.started && canAct) {
    discSection.append(el('span', 'hint', 'Your first message starts a new discussion, or click a board to switch or peek.' + currentWorker));
  }

  // Worker work not yet in main: on its discussion's row, or here when its branch is worker/main
  // or belongs to no row of this list.
  const pendingWork = workerPending ?? [];
  const pendingText = (p) => [p.ahead && p.ahead + (p.ahead === 1 ? ' commit' : ' commits') + ' not merged into main', p.dirty && 'uncommitted changes'].filter(Boolean).join(' · ');
  for (const p of pendingWork.filter((p) => !discussions.includes(p.lane)))
    discSection.append(el('div', 'worker-pending', '⚠ ' + p.branch + ': ' + pendingText(p)));

  const canOrderDisc = canAct && !!inOrder && discussions.length > 1;
  for (const [i, d] of discussions.entries()) {
    const path = 'discussions/' + d;
    const isCurrent = path === room?.active;
    const isPeeking = (peek?.kind === 'local' && peek.path === path) || (peeking?.path === path);
    const openEntry = room?.open?.find((o) => o.active === path);
    const openHere = openEntry?.current ? null : openEntry;
    const closed = !!room?.closedDiscussions?.includes(d);
    const row = el('div', 'row discussion-row' + (isCurrent ? ' in-use' : '') + (isPeeking ? ' peeking' : ''));
    const block = el('div', 'discussion-block');
    if (canOrderDisc) dragRow(row, d, discussions, 'discussions');

    const label = discussionTitle(d, path);
    const nameBtn = el('button', 'entry discussion', label);
    nameBtn.title = path;
    nameBtn.onclick = () => {
      if (isCurrent) {
        if (peeking) { peek = null; send('/peek'); }
        else peekFiles(null);
      } else if (openHere) {
        notesGuard(() => { location.href = openHere.url; });
      } else if (closed) {
        enterClosedPeek(d, path, d, label);
      } else if (canAct) {
        send('/resume ' + d);
      } else {
        peekFiles({ kind: 'local', path, name: d, title: label, readonly: false });
      }
    };
    block.append(nameBtn);

    const closing = closingPhase(d);
    let statusText = boardState(openEntry, { closed, isCurrent, closing });
    if (openEntry?.working) statusText += ' · worker working';
    if (closing) statusText += ' · ' + closingLabel(closing);
    const work = pendingWork.find((p) => p.lane === d);
    const merged = workerMerged.has(d);
    if (merged) statusText += ' · merged';
    else if (workerPending && !work) statusText += ' · no changes';
    block.append(el('div', 'local-label', statusText));
    if (work) block.append(el('div', 'worker-pending', '⚠ Worker: ' + pendingText(work)));
    row.append(block);

    if (canAct) {
      if (closing === 'waiting') {
        const cancel = el('button', 'reopen', 'Cancel close');
        cancel.onclick = () => post('__cancelclose', { name: d }).catch((err) => status(err.message, true));
        row.append(cancel);
      }
      const { menu, items } = makeRowMenu(path);
      if (isCurrent && peeking) {
        const back = el('button', '', 'Back to this discussion');
        back.title = 'Return to this discussion: leave the peek.';
        back.onclick = () => { closeMenus(); send('/peek'); };
        items.append(back);
      } else if (openHere && !openHere.started) {
        const b = el('button', '', 'Go to');
        b.title = 'Show this open discussion: it has not started yet';
        b.onclick = () => { closeMenus(); notesGuard(() => { location.href = openHere.url; }); };
        items.append(b);
      } else if (!isCurrent) {
        const b = el('button', '', closed ? 'Resume' : 'Continue');
        b.title = resumeTip(d, openHere, null, closed);
        b.onclick = () => { closeMenus(); if (openHere) notesGuard(() => { location.href = openHere.url; }); else send('/resume ' + d); };
        items.append(b);
        const pf = el('button', '', 'Peek files');
        pf.title = 'Show this discussion’s files in Explorer without switching';
        pf.onclick = () => { closeMenus(); peekFiles({ kind: 'local', path, name: d, title: label, readonly: closed }); };
        items.append(pf);
        if (closed) {
          const p = el('button', '', 'Peek chat & files');
          p.title = 'Look at this closed discussion read-only: its conversation and files, without reopening it.';
          p.onclick = () => { closeMenus(); enterClosedPeek(d, path, d, label); };
          items.append(p);
        }
      }
      if (!closed) {
        const close = el('button', '', closeActionLabel(d));
        close.onclick = () => { closeMenus(); send('/close ' + d); };
        items.append(close);
        if (workerMergeable?.[d]) {
          const merge = el('button', '', 'Close and Merge');
          configureMergeButton(merge, d);
          merge.onclick = () => { closeMenus(); startMerge(d); };
          items.append(merge);
        }
        if (workerDiscardable.has(d)) {
          const discard = el('button', 'danger', 'Close and Discard');
          discard.onclick = () => { closeMenus(); startDiscard(d); };
          items.append(discard);
        }
      }
      for (const [mLabel, target] of [['Archive', 'archive'], ['Defer', 'deferred']]) {
        const b = el('button', '', mLabel);
        b.disabled = isCurrent || !closed;
        b.title = !closed ? 'Close the discussion before moving it into ' + target + '/.' : isCurrent ? 'The discussion in use cannot be moved' : 'Move the whole discussion into ' + target + '/';
        b.onclick = () => { closeMenus(); send('/move ' + d + ' ' + target); };
        if (target === 'archive') archiveButton(b, d);
        items.append(b);
      }
      if (!(isCurrent && !room.started)) {
        const f = el('button', '', 'Start fresh'); freshButton(f, d); items.append(f);
      }
      if (inOrder) {
        items.append(el('hr'));
        orderButtons(items, d, i, discussions, 'discussions');
      }
      items.append(el('hr'));
      rollbackButtons(items, block, d, d, isCurrent);
      row.append(menu);
    }
    discSection.append(row);
  }

  // --- 2. Brainstorms ---
  const brainOrder = ordered(discussionsIn('brainstorms'), 'brainstorms');
  const brainNames = brainOrder ?? discussionsIn('brainstorms');
  const brainSection = makeSection('brainstorms', 'Brainstorms', brainNames.length);
  if (room?.brainstorm && !room.active && canAct) brainSection.append(el('span', 'hint', 'Your first message names this brainstorm and saves it here.'));
  else if (!brainNames.length) brainSection.append(el('span', 'hint', "No brainstorms yet: New brainstorm (in the header's Actions ▾) starts one."));
  const canOrderBrain = canAct && !!brainOrder && brainNames.length > 1;
  for (const [i, b] of brainNames.entries()) {
    const path = 'brainstorms/' + b;
    const isCurrent = path === room?.active;
    const isPeeking = (peek?.kind === 'local' && peek.path === path) || (peeking?.path === path);
    const openEntry = room?.open?.find((o) => o.active === path);
    const openHere = openEntry?.current ? null : openEntry;
    const closed = !isCurrent && !openHere;
    const row = el('div', 'row discussion-row' + (isCurrent ? ' in-use' : '') + (isPeeking ? ' peeking' : ''));
    const block = el('div', 'discussion-block');
    if (canOrderBrain) dragRow(row, b, brainNames, 'brainstorms');
    const label = brainstormTitle(b);
    const nameBtn = el('button', 'entry brainstorm', label);
    nameBtn.title = path;
    nameBtn.onclick = () => {
      if (isCurrent) {
        if (peeking) { peek = null; send('/peek'); }
        else peekFiles(null);
      } else if (openHere) {
        notesGuard(() => { location.href = openHere.url; });
      } else {
        enterClosedPeek(path, path, b, label);
      }
    };
    block.append(nameBtn);
    block.append(el('div', 'local-label', boardState(openEntry, { closed, isCurrent })));
    row.append(block);
    if (canAct) {
      const { menu, items } = makeRowMenu(path);
      if (isCurrent && peeking) {
        const back = el('button', '', 'Back to this brainstorm');
        back.title = 'Return to this brainstorm: leave the peek.';
        back.onclick = () => { closeMenus(); send('/peek'); };
        items.append(back);
      } else if (openHere) {
        const g = el('button', '', 'Go to');
        g.title = 'Show this open brainstorm: its agents carry on';
        g.onclick = () => { closeMenus(); notesGuard(() => { location.href = openHere.url; }); };
        items.append(g);
      } else if (closed) {
        const r = el('button', '', 'Resume');
        const saved = room?.checkpoints?.find((c) => c.name === path);
        r.title = saved?.kind === 'full' ? 'Continue where it stopped: the same agent sessions, and its chat.'
          : 'No saved session: a fresh one starts, from its latest summary or its transcripts.';
        r.onclick = () => { closeMenus(); send('/resume ' + path); };
        items.append(r);
      }
      if (!isCurrent) {
        const pf = el('button', '', 'Peek files');
        pf.title = 'Show this brainstorm’s files in Explorer without switching';
        pf.onclick = () => { closeMenus(); peekFiles({ kind: 'local', path, name: b, title: label, readonly: closed }); };
        items.append(pf);
      }
      const close = el('button', '', 'Close');
      close.disabled = !(isCurrent || openHere);
      close.title = close.disabled ? 'It is not open' : 'Close it: its agents stop; its checkpoint is kept';
      close.onclick = () => { closeMenus(); send('/close ' + path); };
      items.append(close);
      for (const [mLabel, target] of [['Archive', 'archive'], ['Defer', 'deferred']]) {
        const mb = el('button', '', mLabel);
        mb.disabled = !closed;
        mb.title = !closed ? 'Close this brainstorm before moving it into ' + target + '/.' : 'Move the whole brainstorm into ' + target + '/';
        mb.onclick = () => { closeMenus(); send('/move ' + path + ' ' + target); };
        if (target === 'archive') archiveButton(mb, path);
        items.append(mb);
      }
      const convert = el('button', '', 'Turn into a discussion');
      convert.title = 'Move it to discussions/: its agents keep their sessions and are told the new folder; the worker can then be sent work.';
      confirmed(convert, () => { closeMenus(); send('/convert ' + path); }, 'Click again: it moves to discussions/', () => true);
      items.append(convert);
      const fresh = el('button', '', 'Start fresh');
      fresh.title = 'New agent sessions, briefed from its latest summary or, with none, pointed at its transcripts. Its saved sessions and chat are discarded.';
      confirmed(fresh, () => { closeMenus(); send('/fresh ' + path); }, 'Click again: its saved sessions and chat are discarded', () => true);
      items.append(fresh);
      const del = el('button', 'danger', 'Delete');
      del.disabled = isCurrent || !!openHere;
      del.title = del.disabled ? 'Close this brainstorm before deleting it' : 'Delete its folder (transcripts, drawings) and its checkpoint';
      confirmed(del, () => { closeMenus(); send('/delete ' + path); }, 'Click again: its folder (transcripts, drawings) and checkpoint are removed; uncommitted files are lost for good', () => true);
      items.append(del);
      if (brainOrder) {
        items.append(el('hr'));
        orderButtons(items, b, i, brainNames, 'brainstorms');
      }
      row.append(menu);
    }
    brainSection.append(row);
  }

  // --- 3. Archived · Deferred (folded by default) ---
  const archivedItems = [
    ...discussionsIn('discussions/archive').map((d) => ({ s: 'archive', d, kind: 'discussion' })),
    ...discussionsIn('brainstorms/archive').map((d) => ({ s: 'archive', d, kind: 'brainstorm' })),
  ].sort((a, b) => b.d.localeCompare(a.d));
  const deferredItems = [
    ...discussionsIn('discussions/deferred').map((d) => ({ s: 'deferred', d, kind: 'discussion' })),
    ...discussionsIn('brainstorms/deferred').map((d) => ({ s: 'deferred', d, kind: 'brainstorm' })),
  ].sort((a, b) => b.d.localeCompare(a.d));
  const inactiveItems = [...archivedItems, ...deferredItems];
  const inactiveSection = makeSection('archived-deferred', 'Archived · Deferred', inactiveItems.length);
  if (!inactiveItems.length) {
    inactiveSection.append(el('span', 'hint', 'No archived or deferred discussions or brainstorms.'));
  }
  for (const { s, d, kind } of inactiveItems) {
    if (kind === 'brainstorm') {
      const path = 'brainstorms/' + s + '/' + d;
      const isPeeking = (peek?.kind === 'local' && peek.path === path) || (peeking?.path === path);
      const row = el('div', 'row discussion-row' + (isPeeking ? ' peeking' : ''));
      const block = el('div', 'discussion-block');
      const label = brainstormTitle(d);
      const nameBtn = el('button', 'entry brainstorm', label);
      nameBtn.title = path;
      nameBtn.onclick = () => enterClosedPeek(path, path, d, label);
      block.append(nameBtn);
      block.append(el('div', 'local-label', s === 'archive' ? 'archived brainstorm' : 'deferred brainstorm'));
      row.append(block);

      if (canAct) {
        const { menu, items } = makeRowMenu(path);
        const b = el('button', '', 'Resume');
        b.title = 'Resume: makes it active first';
        b.onclick = () => { closeMenus(); send('/resume ' + path); };
        items.append(b);
        const pf = el('button', '', 'Peek files');
        pf.title = 'Show this brainstorm’s files in Explorer without moving it';
        pf.onclick = () => { closeMenus(); peekFiles({ kind: 'local', path, name: d, title: label, readonly: true }); };
        items.append(pf);
        const p = el('button', '', 'Peek chat & files');
        p.title = 'Look at this closed brainstorm read-only: its conversation and files, without reopening it.';
        p.onclick = () => { closeMenus(); enterClosedPeek(path, path, d, label); };
        items.append(p);
        const makeActive = el('button', '', 'Make active');
        makeActive.onclick = () => { closeMenus(); send('/move ' + path + ' active'); };
        items.append(makeActive);
        const otherSection = s === 'archive' ? 'deferred' : 'archive';
        const moveOther = el('button', '', otherSection === 'archive' ? 'Archive' : 'Defer');
        moveOther.onclick = () => { closeMenus(); send('/move ' + path + ' ' + otherSection); };
        if (otherSection === 'archive') archiveButton(moveOther, path);
        items.append(moveOther);
        const fresh = el('button', '', 'Start fresh');
        fresh.title = 'Makes it active first. New agent sessions, briefed from its latest summary or, with none, pointed at its transcripts. Its saved sessions and chat are discarded.';
        confirmed(fresh, () => { closeMenus(); send('/fresh ' + path); }, 'Click again: its saved sessions and chat are discarded', () => true);
        items.append(fresh);
        const del = el('button', 'danger', 'Delete');
        del.title = 'Delete its folder (transcripts, drawings) and its checkpoint';
        confirmed(del, () => { closeMenus(); send('/delete ' + path); }, 'Click again: its folder (transcripts, drawings) and checkpoint are removed; uncommitted files are lost for good', () => true);
        items.append(del);
        row.append(menu);
      }
      inactiveSection.append(row);
      continue;
    }
    const path = 'discussions/' + s + '/' + d;
    const isPeeking = (peek?.kind === 'local' && peek.path === path) || (peeking?.path === path);
    const row = el('div', 'row discussion-row' + (isPeeking ? ' peeking' : ''));
    const block = el('div', 'discussion-block');
    const label = discussionTitle(d, path);
    const closed = !!room?.closedDiscussions?.includes(d);
    const nameBtn = el('button', 'entry discussion', label);
    nameBtn.title = path;
    nameBtn.onclick = () => {
      if (closed) enterClosedPeek(s + '/' + d, path, d, label);
      else peekFiles({ kind: 'local', path, name: d, title: label, readonly: true });
    };
    block.append(nameBtn);
    const closing = closingPhase(d);
    const merged = workerMerged.has(d);
    block.append(el('div', 'local-label', (s === 'archive' ? 'archived' : 'deferred') + (closed ? ' · closed' : '') + (closing ? ' · ' + closingLabel(closing) : '') + (merged ? ' · merged' : '')));
    row.append(block);

    if (canAct) {
      if (closing === 'waiting') {
        const cancel = el('button', 'reopen', 'Cancel close');
        cancel.onclick = () => post('__cancelclose', { name: d }).catch((err) => status(err.message, true));
        row.append(cancel);
      }
      const { menu, items } = makeRowMenu(path);
      const b = el('button', '', closed ? 'Resume' : 'Continue');
      b.title = (closed ? 'Resume' : 'Continue') + ': makes it active first';
      b.onclick = () => { closeMenus(); send('/resume ' + s + '/' + d); };
      items.append(b);
      const pf = el('button', '', 'Peek files');
      pf.title = 'Show this discussion’s files in Explorer without moving it';
      pf.onclick = () => { closeMenus(); peekFiles({ kind: 'local', path, name: d, title: label, readonly: true }); };
      items.append(pf);
      if (closed) {
        const p = el('button', '', 'Peek chat & files');
        p.title = 'Look at this closed discussion read-only: its conversation and files, without reopening it.';
        p.onclick = () => { closeMenus(); enterClosedPeek(s + '/' + d, path, d, label); };
        items.append(p);
      }
      if (!closed) {
        const close = el('button', '', 'Close');
        close.onclick = () => { closeMenus(); send('/close ' + s + '/' + d); };
        items.append(close);
      }
      const makeActive = el('button', '', 'Make active');
      makeActive.onclick = () => { closeMenus(); send('/move ' + s + '/' + d + ' active'); };
      items.append(makeActive);

      const otherSection = s === 'archive' ? 'deferred' : 'archive';
      const moveOther = el('button', '', otherSection === 'archive' ? 'Archive' : 'Defer');
      moveOther.disabled = !closed;
      if (moveOther.disabled) moveOther.title = 'Close the discussion before moving it into ' + otherSection + '/.';
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
    inactiveSection.append(row);
  }

  // --- 4. Received from peers (folded by default) ---
  if (replica) {
    const remoteOnly = replica.received.filter((l) => !l.local && !discussions.some((d) => replica.own[d]?.discussion === l.discussion));
    if (remoteOnly.length) {
      const peerSection = makeSection('peers', 'Received from peers', remoteOnly.length);
      for (const line of remoteOnly) {
        const isPeeking = peek?.kind === 'received' && peek.discussion === line.discussion;
        const row = el('div', 'row discussion-row' + (isPeeking ? ' peeking' : ''));
        const block = el('div', 'discussion-block');
        const folderName = line.name || line.local || line.discussion;
        const label = displayTitle(folderName, line.title);
        const nameBtn = el('button', 'entry discussion', label);
        nameBtn.title = line.local ? 'discussions/' + line.local : isDiscussion(folderName) ? 'discussions/' + folderName : folderName;
        const peerPeek = { kind: 'received', discussion: line.discussion, node: line.node, commit: line.commit, round: line.round, name: folderName, title: line.title };
        nameBtn.onclick = () => peekFiles(peerPeek);
        block.append(nameBtn);
        block.append(el('div', 'local-label', line.node + ' · round ' + line.round));
        row.append(block);

        const { menu, items } = makeRowMenu('peer:' + line.discussion + ':' + line.node);
        const viewBtn = el('button', '', 'View chat');
        viewBtn.title = 'View this peer’s discussion in full, read-only';
        viewBtn.onclick = () => { closeMenus(); viewRemote(line); };
        items.append(viewBtn);
        const peekBtn = el('button', '', 'Peek files');
        peekBtn.title = 'Peek at this received discussion’s files in Explorer';
        peekBtn.onclick = () => { closeMenus(); peekFiles(peerPeek); };
        items.append(peekBtn);
        row.append(menu);
        peerSection.append(row);
      }
    }
  }
}
const renderDiscussions = renderBoards, renderBrainstorms = renderBoards;

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
    const bold = el('b', '', displayTitle(peek.name, peek.title));
    note.append(bold);
    banner.append(note);
    const backBtn = el('button', '', 'Back to current');
    backBtn.onclick = () => {
      peek = null;
      updateTabs();
      renderExplorer();
      renderBoards();
      if (peeking) send('/peek');
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
      subline.textContent = displayTitle(peek.name, peek.title) + ' (' + peek.node + ')';
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
  renderBoards();
  await renderExplorer();
}
// The header: the room's folder name, its full root path (in the tooltip) and its active discussion.
let room = null;
function setRoom(r) {
  const changed = room && r && room.active !== r.active;
  const fresh = r?.fresh && !room?.fresh; // a new discussion or brainstorm, or a page on one: its members are chosen first
  room = r;
  if (typeof syncBoardLayout === 'function') syncBoardLayout();
  tabTitles();
  for (const [target, sessions] of [['talk-sessions', r.cliSessions?.agents ?? []], ['work-sessions', r.cliSessions?.worker ? [r.cliSessions.worker] : []]]) {
    const el = $(target); if (!el) continue; el.replaceChildren();
    for (const session of sessions) {
      const line = document.createElement('div');
      line.textContent = session.name + ' (' + session.provider + ') session ID: ' + (session.id ?? 'available after its first completed turn');
      el.append(line);
    }
  }
  if (changed) { peek = null; updateTabs(); }
  // The members panel follows the room: each agent's state, or the usual panel once a new discussion begins.
  if (membersModels && $('talk-settings').open) { if (!r?.fresh) renderMembers(); else $('talk-settings').ontoggle(); }
  if (fresh) { $('talk-settings').open = true; if (localInput) showTab('providers'); }
  renderAutoDev();
  $('room-name').textContent = r.folder?.replace(/[/]+$/, '').split('/').pop() || r.folder || 'agent-room';
  $('disc').textContent = displayTitle(r.active?.split('/').at(-1), r.discussion);
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
let membersModels = null; // the model lists, while the members panel shows a started discussion's agents (renderMembers)
// The tabs name the models in use: "Discussion (Claude default, Codex default)", "Worker (Opus)".
function tabTitles() {
  const models = (room?.members ?? []).filter((m) => m.enabled && m.modelLabel).map((m) => m.modelLabel);
  const talk = $('tab-talk'), work = $('tab-work'); if (!talk || !work) return;
  // The tabs keep their plain names; each panel's heading names its providers and models.
  talk.textContent = 'Discussion';
  work.textContent = 'Worker' + (work.dataset.working ? ' …' : '');
  $('talk-models').textContent = models.length ? models.join(', ') : 'provider & model';
  $('work-models').textContent = room?.workerModel || 'provider & model';
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
  for (const p of ['claude', 'codex', 'agy']) provider.add(new Option(p === 'claude' ? 'Claude' : p === 'codex' ? 'Codex' : 'Agy', p));
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
// Once the discussion has started, the members panel lists the agents it started with (room.members):
// each one's On box leaves it out of this discussion or brings it back, from its next round. Their
// provider, name and model are fixed; new discussions get theirs before their first message.
function renderMembers() {
  const parent = $('talk-agent-rows'), result = $('talk-settings-status'), members = room?.members ?? [];
  parent.replaceChildren();
  delete settingsRows.talk; // nothing here saves settings
  const on = () => members.filter((m) => m.enabled).length;
  members.forEach((m, i) => {
    const a = { ...m, active: m.enabled, automatic: false };
    const { row } = agentRow(parent, a, membersModels, 'Agent ' + (i + 1), {
      provider() {}, name() {}, refresh() {},
      locked: () => a.active && on() <= 1,
      toggle(enabled) {
        a.active = m.enabled = enabled;
        result.textContent = '';
        post('__agent-enabled', { name: m.name, enabled, member: true })
          .then(async (res) => { if (!res.ok) throw new Error(await res.text()); })
          .catch((err) => { m.enabled = !enabled; renderMembers(); result.textContent = 'Could not change ' + m.name + ': ' + err.message; });
      },
    });
    for (const el of row.querySelectorAll('select, input:not([type="checkbox"])')) el.disabled = true;
  });
  $('talk-member-note').hidden = true;
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
      if (scope === 'talk') membersModels = data.started && room?.members ? data.models : null;
      if (scope === 'talk' && membersModels) {
        renderMembers();
        hint.textContent = 'This discussion’s members. Untick one to leave it out of this discussion from its next round; tick it to bring it back. Their provider and model stay as they started: choose those for a new discussion before its first message.';
        return;
      }
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
// The Providers tab: the defaults for new discussions, members and worker together, saved to the
// shared defaults file (every room). Before this discussion starts they apply to it too. Shown
// first on a new discussion; the Discussion and Worker tabs' own panels work as before.
let providerRows = null;
async function renderProviders() {
  const status = $('providers-status'), agentsBox = $('providers-agent-rows'), workerBox = $('providers-worker-row'), note = $('providers-member-note');
  if ($('health-details').open) loadHealth();
  status.textContent = ''; providerRows = null;
  agentsBox.replaceChildren(); workerBox.replaceChildren();
  try {
    await settingsSave;
    const res = await fetch('__settings');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json(), sel = selectedSettings(data);
    let agents;
    if (sel.agents.length >= 2 && sel.agents.length <= 3) {
      const plan = memberPlan(sel.agents, sel.worker), controls = [];
      const refresh = () => { controls.forEach((c) => c.refresh()); note.hidden = !plan.rows.some((r, i) => plan.locked(i)); };
      note.textContent = 'At least two members. To swap one, tick the new row first, then untick the old one.';
      plan.rows.forEach((a, i) => controls.push(agentRow(agentsBox, a, data.models, 'Agent ' + (i + 1), {
        provider: (p) => plan.setProvider(i, p), name: (n) => plan.setName(i, n),
        toggle: (on) => plan.toggle(i, on), locked: () => plan.locked(i), refresh,
      })));
      agents = controls; refresh();
    } else agents = sel.agents.map((a, i) => agentRow(agentsBox, a, data.models, 'Agent ' + (i + 1)));
    providerRows = { agents, worker: agentRow(workerBox, sel.worker, data.models, 'Worker') };
    $('providers-hint').textContent = data.started
      ? 'Defaults for new discussions, in this room and every other. This discussion has started: it keeps its agents and worker (change those in its own tabs).'
      : 'Defaults for new discussions, in this room and every other. This discussion hasn’t started, so they apply to it too.';
  } catch (err) { status.textContent = 'Could not load settings: ' + err.message; }
}
async function loadHealth(check = false) {
  const box = $('provider-health'), button = $('health-check');
  button.disabled = true;
  try {
    const res = check ? await post('__provider-health', {}) : await fetch('__provider-health');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    box.replaceChildren();
    const line = (text) => { const p = document.createElement('p'); p.textContent = text; box.append(p); };
    const when = (t) => t ? longDate(t) : 'not yet';
    const error = (e) => e ? ' · latest error ' + when(e.at) + ': ' + e.message : '';
    for (const provider of ['claude', 'codex', 'agy']) {
      const cli = data.cli[provider], login = data.login[provider];
      line(provider.toUpperCase() + ' · CLI: ' + (cli ? cli.path + ' · ' + cli.version + ' · last success ' + when(cli.checked) : (data.errors.cli[provider]?.path ? 'found at ' + data.errors.cli[provider].path + ', version unavailable' : 'not checked successfully')) + error(data.errors.cli[provider]));
      line('Login: ' + (provider === 'agy' ? 'not monitored' : login ? login.state + (login.expiresAt ? ' · ends ' + when(login.expiresAt) : '') + ' · last success ' + when(login.checked) : 'not checked successfully') + error(data.errors.login[provider]) + (provider === 'agy' ? '' : data.scheduledProviders.includes(provider) ? ' · next scheduled check ' + when(data.nextLogin) : ' · not on the 10-minute schedule (Check now only)'));
    }
    const sources = { claude: "agent-room's fixed list in modelChoices", codex: 'models_cache.json', agy: 'agy models' };
    for (const provider of ['claude', 'codex', 'agy']) {
      const c = data.catalogs[provider];
      line(provider.toUpperCase() + ' model list · ' + sources[provider] + ' · ' + (c.loaded ? 'loaded' : c.checked ? 'unavailable' : 'not read yet') + ' · ' + c.models.length + ' models' + (c.checked ? ' · last attempt ' + when(c.checked) : '') + error(c.error));
    }
    line("Claude's list is agent-room's own; being in that list proves little about availability.");
    const showConfigured = (label, agents) => {
      line(label);
      for (const a of agents) line(a.role + ' ' + a.name + ' · ' + a.provider + ' · ' + (a.model || 'CLI default') + ' · ' + a.alignment);
    };
    for (const group of data.configured) showConfigured('Room ' + group.room + ' · ' + (group.discussion || 'no discussion started'), group.agents);
    if (data.defaults) showConfigured('Saved defaults', data.defaults);
    else line('Saved defaults: none available');
    line('Prompt tests use quota and prove only that the model answered at that moment.');
    for (const provider of ['claude', 'codex', 'agy']) {
      const row = document.createElement('p'), label = document.createElement('label'), select = document.createElement('select');
      label.textContent = provider.toUpperCase() + ' model: ';
      const choices = [...new Set(data.configured.flatMap((group) => group.agents.filter((a) => a.provider === provider && a.model).map((a) => a.model)))];
      for (const model of ['', ...choices]) { const option = document.createElement('option'); option.value = model; option.textContent = model || 'CLI default'; select.append(option); }
      label.append(select); row.append(label, ' ');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Test prompt (uses quota)';
      button.disabled = data.promptRunning.includes(provider);
      const result = document.createElement('span');
      button.onclick = async () => {
        button.disabled = true; result.textContent = ' Running…';
        try {
          const res = await post('__prompt-test', { provider, model: select.value });
          if (!res.ok) throw new Error(await res.text());
          await loadHealth();
        } catch (err) { result.textContent = ' Could not run test: ' + err.message; button.disabled = false; }
      };
      row.append(button, result); box.append(row);
      for (const r of data.promptResults.filter((item) => item.provider === provider)) {
        line(provider.toUpperCase() + ' · ' + (r.model || 'CLI default') + ' · ' + when(r.at) + ' · ' + (r.durationMs / 1000).toFixed(1) + ' s · ' + r.outcome + ' · reply: ' + (r.reply || '(none)') + (r.error ? ' · error: ' + r.error : ''));
      }
    }
    const table = (headings, rows) => {
      const t = document.createElement('table'), thead = t.createTHead(), tr = thead.insertRow();
      for (const h of headings) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; tr.append(th); }
      const body = t.createTBody();
      for (const row of rows) { const r = body.insertRow(); for (const cell of row) r.insertCell().textContent = cell; }
      box.append(t);
    };
    line('Operations · provider and model used now');
    for (const group of data.configured) {
      line('Room ' + group.room + ' · ' + (group.discussion || 'no discussion started'));
      const members = group.agents.filter((a) => a.role === 'member'), worker = group.agents.find((a) => a.role === 'worker');
      const model = (a) => a.model || 'CLI default';
      const rows = members.map((a) => ['Discussion turn · ' + a.name + (a.enabled ? '' : ' (disabled)'), a.provider, model(a)]);
      rows.push(...members.filter((a) => a.enabled).map((a) => ['Summary · ' + a.name, a.provider, model(a)]));
      rows.push(['Worker tasks · ' + worker.name, worker.provider, model(worker)],
        ['Closing statement · new session', worker.provider, model(worker)],
        ['Discussion title', 'Claude', 'CLI default'],
        ['Login check · claude auth status', 'Claude', 'not applicable'],
        ['Login check · codex login status', 'Codex', 'not applicable'],
        ['Login check', 'Agy', 'not monitored'], ['Quota meter', 'quota meter', 'not applicable']);
      table(['Operation', 'Provider', 'Model'], rows);
    }
    line('Sessions are memory between turns, not running programs. This list covers only sessions known to agent-room.');
    for (const group of data.sessions) {
      line('Room ' + group.room + ' · ' + (group.discussion || 'no discussion started'));
      table(['Agent', 'Provider', 'Session ID', 'Last turn', 'Latest error'], group.agents.map((a) => [
        a.role + ' ' + a.name, a.provider, a.id || 'none yet', a.lastTurn ? when(a.lastTurn.ended) + ' · ' + a.lastTurn.outcome : 'none yet',
        a.lastTurn?.error ? when(a.lastTurn.error.at) + ' · ' + a.lastTurn.error.message : 'none' ]));
    }
    line('Leftovers: last success ' + when(data.leftoversChecked) + error(data.errors.leftovers) + ' · next scheduled check ' + when(data.nextLeftovers));
    const age = (started) => started ? Math.max(0, Math.floor((Date.now() - new Date(started)) / 60000)) + ' min' : 'unknown';
    for (const [label, programs] of [['Running', data.running], ['Leftover', data.leftovers]]) {
      if (!programs.length) line(label + ': none in last available results');
      for (const p of programs) line(label + ': PID ' + p.pid + ' · ' + p.provider + ' · ' + p.agent + ' · room ' + p.room + ' · age ' + age(p.started) + (p.unverified ? ' · unverified' : ''));
    }
    for (const q of data.quota) line('Quota meter · room ' + q.room + ': ' + (q.reachable === null ? 'not checked' : q.reachable ? 'reachable' : 'not reachable') + ' · measured ' + (q.measured || 'unknown') + ' · checked ' + when(q.checked));
  } catch (err) { box.textContent = 'Could not load provider health: ' + err.message; }
  finally { button.disabled = false; }
}
$('health-details').ontoggle = () => { if ($('health-details').open) loadHealth(); };
$('health-check').onclick = () => loadHealth(true);
function saveProviders() {
  const status = $('providers-status');
  if (!providerRows) return;
  if ([...providerRows.agents, providerRows.worker].some((row) => row.incomplete())) { status.textContent = 'Enter a custom model ID to save this choice.'; return; }
  const value = { agents: providerRows.agents.filter((row) => row.active()).map((row) => row.get()), worker: providerRows.worker.get(), scope: 'defaults' };
  status.textContent = 'Saving…';
  settingsSave = settingsSave.then(async () => {
    const res = await post('__settings', value);
    if (!res.ok) throw new Error(await res.text());
    status.textContent = (await res.json()).applied ? 'Saved: the defaults, and this discussion.' : 'Saved as the defaults for new discussions.';
  }).catch((err) => { status.textContent = 'Could not save: ' + err.message; });
}
$('providers-form').onchange = saveProviders;
$('providers-form').onsubmit = (e) => { e.preventDefault(); saveProviders(); };
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
// the text and the files stay here. Needs a started discussion or brainstorm.
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
  if (peeking && !text.startsWith('/')) return;
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
// Pointing: a click on a table cell in the shown document (its page posts it here) becomes a chip
// by the message box; the next message carries what was pointed at, as text, for the agents.
let pointed = [];
window.addEventListener('message', (e) => {
  const frame = document.getElementById('doc'), p = e.data;
  if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
  if (p?.type !== 'agent-room:point' || typeof p.label !== 'string' || typeof p.text !== 'string') return;
  pointed = pointed.filter((q) => q.label !== p.label).concat({ label: p.label.slice(0, 80), text: p.text.slice(0, 300) });
  renderPointed();
});
function renderPointed() {
  $('pointed').replaceChildren(...pointed.map((p, i) => {
    const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = p.label; chip.title = p.text;
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Stop pointing at this';
    x.onclick = () => { pointed.splice(i, 1); renderPointed(); };
    chip.append(x); return chip;
  }));
}
// A [[D4]] in the chat: hovering highlights that cell/box/mark; clicking reopens the side pane
// to Document (if closed) and highlights it.
function highlightRef(refName, on) {
  const frame = document.getElementById('doc');
  if (frame?.contentWindow) frame.contentWindow.postMessage({ type: 'agent-room:highlight', ref: refName, on }, location.origin);
}
for (const [type, on] of [['mouseover', true], ['mouseout', false]]) document.addEventListener(type, (e) => {
  const ref = e.target.closest && e.target.closest('.ref[data-ref]');
  if (ref) highlightRef(ref.dataset.ref, on);
});
document.addEventListener('click', (e) => {
  const ref = e.target.closest && e.target.closest('.ref[data-ref]');
  if (!ref) return;
  if (typeof sideClosed !== 'undefined' && sideClosed && typeof setSideClosed === 'function') setSideClosed(false);
  if (doc) showSub('document');
  highlightRef(ref.dataset.ref, true);
});
// Moves the chips into the message's text as it is sent (not into a command).
function withPointing() {
  if (!pointed.length || box.value.trim().startsWith('/')) return;
  box.value = box.value.trimEnd() + (box.value.trim() ? '\\n' : '') + '[pointing at: ' + pointed.map((p) => p.text).join('; ') + ']';
  pointed = []; renderPointed();
}
box.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); withPointing(); if (pending.length) return sendWithFiles(); send(box.value); box.value = ''; }
});
async function sendWork(text) {
  text = text.trim();
  if (!text || ended || peeking || viewing) return;
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
  if (!health) return b;
  const openHealth = () => { showTab('providers'); $('health-details').open = true; $('health-details').scrollIntoView({ block: 'start' }); };
  b.tabIndex = 0; b.setAttribute('role', 'button'); b.onclick = openHealth;
  b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHealth(); } };
  if (h?.level) { const a = document.createElement('span'); a.className = 'alert' + (h.level === 'red' ? ' red' : ''); a.textContent = '⚠'; b.append(a); }
  if (h) b.append(h.box);
  return b;
}
function showMonitor(view) { monitor = view ?? {}; $('health-warning').hidden = !Object.keys(monitor).some((p) => providerHealth(p)?.level); showQuota(...lastQuota); }
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
// On the screen with several discussions, New discussion and New brainstorm open beside the others,
// ending nothing, so one click is enough; in the terminal they end the session in use.
confirmed($('newdisc'), () => send('/new'), null, () => !room?.multi && room?.started);
confirmed($('newbrainstorm'), () => send('/brainstorm'), null, () => !room?.multi && room?.started);
confirmed($('convert'), () => { closeMenus(); send('/convert ' + room.active); }, 'Click again: it moves to discussions/', () => true);
confirmed($('closedisc'), () => send('/close'), 'Click again: this discussion closes (its agents stop)', () => !!room?.started);
$('closemerge').onclick = () => {
  closeMenus();
  const activeLane = !room?.brainstorm && room?.active?.startsWith('discussions/') ? room.active.slice('discussions/'.length) : null;
  if (activeLane) startMerge(activeLane);
};
$('closediscard').onclick = () => {
  closeMenus();
  const activeLane = !room?.brainstorm && room?.active?.startsWith('discussions/') ? room.active.slice('discussions/'.length) : null;
  if (activeLane) startDiscard(activeLane);
};
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
    setPeeking(ev.peek ?? null);
    talk.clear();
    if (peeking) {
      for (const m of ev.messages) if (!m.pass && !m.hidden) talk.add(bubble(m));
    } else {
      ev.messages.forEach((m) => message(m, false));
    }
    yourTurn = !ev.thinking; setThinking(ev.thinking); if (!viewing) { showDoc(ev.doc); openFiles(); }
    if (!ev.input) { $('composer').hidden = true; } // terminal mode: the page only watches
    work.clear();
    if (!ev.worker.length) work.add(statusEl('Give the worker instructions here. It works alongside the discussion and sees only what you send it.'));
    ev.worker.forEach((m) => workMessage(m, false));
    if (ev.status) status(ev.status);
    commandBusy = !!ev.busy; updateBusy();
    setWorking(ev.working);
    if (!ev.workInput) { $('wcomposer').hidden = true; }
    showWorkerInfo(ev.workerInfo);
    showMonitor(ev.monitor);
    showQuota(ev.quota, ev.quotaAt);
    if (ev.room) { retryId = ev.room.retryId ?? null; updateRetry(); showFailedAgents(ev.room.failedAgents); setRoom(ev.room); renderWorkerStop(); showWorkerInfo(workerInfoShown); }
    $('newroom').hidden = !ev.newRoom;
    replicaOff = ev.replicaOff ?? null;
    showReplica(ev.replica);
  }
  if (ev.type === 'replica') showReplica(ev.replica);
  if (ev.type === 'room') { retryId = ev.room.retryId ?? null; updateRetry(); showFailedAgents(ev.room.failedAgents); setRoom(ev.room); renderWorkerStop(); showWorkerInfo(workerInfoShown); openFiles(); } // its buttons and "in use" follow (a brainstorm: no work)
  if (ev.type === 'work') workMessage(ev.message, true);
  if (ev.type === 'quota') showQuota(ev.gauges, ev.at);
  if (ev.type === 'monitor') showMonitor(ev.monitor);
  if (ev.type === 'schedule' && openServiceName === 'schedule') renderSchedule();
  if (ev.type === 'working') setWorking(ev.name);
  if (ev.type === 'workerinfo') showWorkerInfo(ev.info);
  if (ev.type === 'message') message(ev.message, true);
  if (ev.type === 'thinking') setThinking(ev.name);
  if (ev.type === 'busy') { commandBusy = ev.on; updateBusy(); }
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
    forgetOrder(ev.from?.split('/').pop(), ev.from?.startsWith('brainstorms/') ? 'brainstorms' : 'discussions');
    openFiles();
  }
  if (ev.type === 'goto') { location.href = ev.url; return; } // this window switches discussion
  if (ev.type === 'ended') { ended = true; status('This room has ended. You can close this window.'); events.close(); box.disabled = true; wbox.disabled = true; }
  if (ev.type === 'restarting') { restarting = true; commandBusy = true; updateBusy(); status('Restarting the server: this page reloads when the new one answers.'); events.close(); box.disabled = true; wbox.disabled = true; }
};

// The Terminal service (host-shell.mjs, after ghostty-web's demo): opening it fetches the token and
// opens a WebSocket, and the server starts a fresh shell. Switching to another service or closing the
// Services panel hides the terminal while keeping the shell alive (shown by a green dot on the
// Terminal Control bar button). End shell, reloading the page, or stopping the server ends it.
// Shown only in pages opened on this computer (the server refuses the others anyway).
let hostShell = null;
const isLocalPage = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
if (isLocalPage && $('ctrl-terminal')) $('ctrl-terminal').hidden = false;
function updateTerminalUI() {
  const alive = !!(hostShell && hostShell.alive);
  if ($('ctrl-terminal')) $('ctrl-terminal').classList.toggle('running', alive);
  if ($('terminal-end')) $('terminal-end').hidden = !alive;
  if ($('terminal-start')) $('terminal-start').hidden = alive;
}
function closeHostShell() {
  if (hostShell) {
    try { hostShell.ws?.close(); } catch {}
    try { hostShell.term?.dispose(); } catch {}
  }
  hostShell = null;
  $('hostshell-term').replaceChildren();
  if ($('terminal-status')) $('terminal-status').textContent = 'Shell ended. Click Start shell for a new shell.';
  updateTerminalUI();
}
async function openHostShell() {
  const box = $('hostshell-term');
  box.replaceChildren();
  if ($('terminal-status')) $('terminal-status').textContent = 'Shell running in this room’s folder (this computer only)';
  // Start on first open: End shell while loading cancels it, and each step below stops then.
  const shell = hostShell = { term: null, ws: null, fit: null, alive: true };
  updateTerminalUI();
  const { init, Terminal, FitAddon } = await import('./__shell/ghostty-web.js');
  await init();
  if (hostShell !== shell) return; // ended meanwhile
  const term = shell.term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', cursorBlink: true });
  const fit = shell.fit = new FitAddon(); term.loadAddon(fit); term.open(box); fit.fit(); fit.observeResize();
  let token;
  try {
    const r = await fetch('__shell/token', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + await r.text());
    token = (await r.json()).token;
  } catch (err) {
    if (hostShell === shell) { shell.alive = false; updateTerminalUI(); }
    term.write('\\r\\nNo terminal: ' + err.message + '\\r\\n');
    return;
  }
  if (hostShell !== shell) return; // ended meanwhile
  const params = new URLSearchParams({ token, cols: term.cols, rows: term.rows });
  const ws = shell.ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + location.pathname.replace(/[^/]*$/, '') + '__shell/ws?' + params);
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => {
    if (hostShell === shell) {
      shell.alive = false;
      updateTerminalUI();
      if ($('terminal-status')) $('terminal-status').textContent = 'Shell exited. Click Start shell for a new shell.';
      term.write('\\r\\n\\x1b[31mConnection closed. Click Start shell for a new shell.\\x1b[0m\\r\\n');
    }
  };
  term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
  term.focus();
}
if ($('terminal-end')) $('terminal-end').onclick = () => closeHostShell();
if ($('terminal-start')) $('terminal-start').onclick = () => openHostShell();

// The My notes service (notes.mjs): the User's notes for this room's folder, on this computer only.
// A note is saved only by Save. Closing or switching services only hides the panel without asking,
// keeping unsaved edits. Unsaved changes are never dropped without asking: inside the panel before
// another note, New, or switching board or room; the browser's leave-page warning otherwise; a
// refresh after a code change keeps them (refreshPage).
const notes = { open: false, list: [], id: null, base: '', editing: false, session: 0 }; // id null: a new note; base: its saved text
// session: changed whenever the editor starts something else (setEditor, clearEditor, a read). A
// save or read response is applied to the editor only if the session it started in is still current;
// otherwise it only refreshes the list.
const noteText = $('notes-text');
const notesDirty = () => notes.editing && noteText.value !== notes.base;
function noteDraft() { return notesDirty() ? { id: notes.id, base: notes.base, text: noteText.value } : null; }
if (isLocalPage) {
  if ($('ctrl-notes')) $('ctrl-notes').hidden = false;
  if (noteDraftKept) { openService('notes', { skipNotesOpen: true }); openNotes(noteDraftKept); }
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
  if (typeof openService === 'function') { if (openServiceName !== 'notes') openService('notes'); }
  else if (!notes.open) openNotes();
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
  notes.open = true;
  if (draft) setEditor(draft.id, draft.text, draft.base);
  try { await loadNotes(); } catch (err) { return notesStatus('✗ Notes: ' + err.message, true); }
  if (!draft) return;
  if (draft.id && !notes.list.some((n) => n.id === draft.id)) { setEditor(null, draft.text, ''); return notesStatus('Kept your unsaved text; its note was removed meanwhile, so Save makes it a new note.'); }
  notesStatus('Kept your unsaved changes from before the page refreshed.');
}
function closeNotes() {
  if (!notes.open) return;
  clearEditor(); notes.open = false;
}
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
  if (url.pathname === '/__provider-health') {
    if (!screen.providerHealth || !screen.checkProviderHealth) { send(409, 'text/plain', 'Provider health is unavailable.'); return true; }
    if (req.method !== 'GET' && (req.method !== 'POST' || !fromOwnPage(req))) { send(403, 'text/plain', 'Refused.'); return true; }
    Promise.resolve().then(() => req.method === 'GET' ? screen.providerHealth() : screen.checkProviderHealth()).then(
      (data) => send(200, 'application/json', JSON.stringify(data)), (err) => send(500, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (url.pathname === '/__prompt-test') {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can run a prompt test.'); return true; }
    if (!screen.testPrompt) { send(409, 'text/plain', 'Prompt tests are unavailable in this room.'); return true; }
    readJson(req).then((body) => screen.testPrompt(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  // The Instructions tab: the prompt catalog, with each rulebook's current text.
  if (url.pathname === '/__instructions') {
    if (req.method !== 'GET') { send(405, 'text/plain', 'Use GET.'); return true; }
    if (!screen.instructions) { send(409, 'text/plain', 'Instructions are unavailable in this room.'); return true; }
    try { send(200, 'application/json', JSON.stringify(screen.instructions())); }
    catch (err) { send(500, 'text/plain; charset=utf-8', err.message); }
    return true;
  }
  // The Schedule page: recurring discussion tasks and quota floor for this room.
  if (url.pathname === '/__schedule') {
    if (!screen.getSchedule || !screen.saveSchedule) { send(409, 'text/plain', 'Schedule is unavailable in this room.'); return true; }
    if (req.method === 'GET') {
      Promise.resolve().then(() => screen.getSchedule()).then(
        (data) => send(200, 'application/json', JSON.stringify(data)),
        (err) => send(500, 'text/plain; charset=utf-8', err.message));
      return true;
    }
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can update the schedule.'); return true; }
    readJson(req).then((body) => screen.saveSchedule(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
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
  if (['/__say', '/__show', '/__work', '/__workerinfo', '/__newroom', '/__retry', '/__agent-enabled', '/__cancelclose', '/__stopworker', '/__discard', '/__merge', '/__catchup'].includes(url.pathname)) {
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
      if (url.pathname === '/__cancelclose') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before cancelling Close.');
        if (!screen.cancelClose?.(body?.name)) return send(409, 'text/plain; charset=utf-8', 'Close is no longer waiting for the worker.');
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__discard') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before discarding worker work.');
        if (!screen.discardPreview || !screen.closeAndDiscard) return send(409, 'text/plain; charset=utf-8', 'Close and Discard is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        const act = body?.snapshot ? screen.closeAndDiscard(name, String(body.snapshot)) : screen.discardPreview(name);
        return Promise.resolve(act).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__merge') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before merging worker work.');
        if (!screen.mergePreviewClose || !screen.closeAndMerge) return send(409, 'text/plain; charset=utf-8', 'Close and Merge is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        const act = body?.snapshot ? screen.closeAndMerge(name, String(body.snapshot)) : screen.mergePreviewClose(name);
        return Promise.resolve(act).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__catchup') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before catching up.');
        if (!screen.catchUpMerge) return send(409, 'text/plain; charset=utf-8', 'Catch up is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        return Promise.resolve(screen.catchUpMerge(name)).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__agent-enabled') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before changing discussion agents.');
        if (!screen.setAgentEnabled) return send(409, 'text/plain', 'Discussion agent controls are unavailable.');
        return Promise.resolve().then(() => screen.setAgentEnabled(body?.name, body?.enabled, body?.member === true)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__retry') {
        if (!screen.retryWork) return send(409, 'text/plain', 'Retry is unavailable.');
        return Promise.resolve(screen.retryWork(body?.id, body?.settings)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__stopworker') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before stopping the worker.');
        if (!screen.stopWorker) return send(409, 'text/plain', 'Stopping the worker is unavailable.');
        try { screen.stopWorker(body?.mode); } catch (err) { return send(400, 'text/plain', err.message); }
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__work') {
        if (screen.peek) return send(409, 'text/plain; charset=utf-8', 'Read-only: you are peeking at a closed board. Click Back to return to the active discussion first.');
        if (!screen.work) return send(409, 'text/plain; charset=utf-8', 'This room has no worker input; the page only watches.');
        if (typeof body?.text !== 'string' || !body.text.trim()) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
        screen.work(body.text.trim());
        return send(204, 'text/plain', '');
      }
      if (!screen.say) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal; the page only watches.');
      const files = Array.isArray(body?.files) && body.files.length ? body.files : null;
      if (typeof body?.text !== 'string' || (!body.text.trim() && !files)) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
      // While peeking at a closed board, non-command messages and attachments are refused so nothing can go to the wrong board.
      if (screen.peek && (files || !body.text.trim().startsWith('/'))) return send(409, 'text/plain; charset=utf-8', 'Read-only: you are peeking at a closed board. Click Back to return to the active discussion first.');
      // While another node's line is open in View, it is read-only: only these commands pass.
      if (screen.isViewing?.(req.headers['x-view-client']) && !VIEW_COMMANDS.includes(body.text.trim())) return send(409, 'text/plain; charset=utf-8', `Read-only: you are viewing a received line. Go back to this node's line first.`);
      if (files) return sayWithFiles(body.text.trim(), files, body.confirmed === true);
      const warning = screen.say(body.text.trim(), body.confirmed === true);
      if (typeof warning === 'string') return send(409, 'text/plain; charset=utf-8', warning);
      send(204, 'text/plain', '');
    });
    return true;
  }
  // A message with attachments: every file is saved into the discussion's or brainstorm's files/ first, and their
  // paths are appended to the text; if any save fails, or the message isn't taken, nothing stays saved.
  function sayWithFiles(text, files, confirmed) {
    const fail = (status, message) => send(status, 'text/plain; charset=utf-8', message + ' Nothing was sent.');
    const active = screen.room?.active;
    if (!active) return fail(409, 'Attachments need a started discussion or brainstorm.');
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
  const peek = screen.peek ?? null;
  return { type: 'reset', messages: peek ? peek.messages : screen.transcript.map(messageView),
    doc: peek ? peek.doc : screen.doc,
    thinking: screen.thinking, status: screen.status, busy: !!screen.busy, input: !!screen.say,
    room: screen.room ?? null, worker: screen.workerForPage?.() ?? screen.worker ?? [], working: screen.working ?? null, workInput: !!screen.work, workerInfo: screen.workerInfo ?? null,
    quota: screen.quota, quotaAt: screen.quotaAt ?? null, monitor: screen.monitor ?? null, newRoom: !!screen.newRoom, page: PAGE,
    replica: screen.replica ?? null, replicaOff: screen.replicaOff ?? null, viewing: screen.viewing ?? null, peek };
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
