// Document rendering and room file helpers, loaded with the current Reload version.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
export function csvTable(text, name = 'table', changedCells = null) {
  const grid = parseCsv(text), cols = Math.max(0, ...grid.map((r) => r.length));
  const shown = (ref) => {
    try { const v = sheetValue(grid, ref); return typeof v === 'number' ? String(Math.round(v * 100) / 100) : v; }
    catch (err) { return err.message; }
  };
  const head = '<tr><th></th>' + Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join('') + '</tr>';
  const body = grid.map((row, r) => `<tr><th>${r + 1}</th>` + Array.from({ length: cols }, (_, c) => {
    const ref = colName(c) + (r + 1), raw = row[c] ?? '', value = raw === '' ? '' : shown(ref);
    const cls = [raw.startsWith('=') && 'formula', value !== '' && !isNaN(value) && 'num', changedCells?.has(ref) && 'diff-changed'].filter(Boolean).join(' ');
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

const isDatedBoard = (name) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name);
const DISC_SECTIONS = new Set(['archive', 'deferred']);
// Files inside a dated board (active, archived or deferred) or brainstorm (brainstorms/<date>-…):
// kept even when .gitignore ignores patterns such as transcripts/. Room checkout files outside them respect .gitignore.
function inBoard(rel) {
  const p = rel.split(/[/\\]/);
  if (p[0] === 'brainstorms') return p.length >= 2 && (isDatedBoard(p[1]) || DISC_SECTIONS.has(p[1]));
  return p[0] === 'discussions' && ((p.length >= 2 && isDatedBoard(p[1])) || (p.length >= 2 && DISC_SECTIONS.has(p[1])));
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
  if (!screen?.sections && !inBoard(rel) && isGitIgnored(dir, rel)) return null;
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
      .filter((f) => !f.split('/').some((p) => p.startsWith('.')) && !inBoard(f) && inside(dir, f));
  } catch {
    rootFiles = listFiles(dir).map((f) => f.split(sep).join('/')).filter((f) => !inBoard(f));
  }
  const discFiles = [];
  for (const top of ['discussions', 'brainstorms']) {
    try { discFiles.push(...listFiles(join(dir, top)).map((f) => top + '/' + f.split(sep).join('/')).filter(inBoard)); } catch {}
  }
  return [...new Set([...rootFiles, ...discFiles])].sort();
}
export function roomBranch(dir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
function boardDirs(dir) {
  const found = [];
  for (const prefix of ['discussions', 'discussions/archive', 'discussions/deferred']) {
    try {
      for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
        if (e.isDirectory() && isDatedBoard(e.name)) found.push(`${prefix}/${e.name}`);
      }
    } catch {}
  }
  return found.sort();
}

// ── Reviewed versions & Markdown change tracking ──
// One baseline per room and document, stored in ~/.local/state/agent-room/reviewed/<room-hash>/<doc-hash>.json
// (keyed by room realpath like checkpointDirectory in src/boards.mjs), plus an in-memory LRU of the
// most recently rendered versions per document so Mark reviewed always saves the exact shown version.
export const RECENT_VERSION_LIMIT = 12;
export const sourceHash = (text) => createHash('sha256').update(String(text)).digest('hex');
const roomReal = (dir) => { try { return realpathSync(dir); } catch { return resolve(dir); } };
export const reviewedDir = (dir) => join(homedir(), '.local', 'state', 'agent-room', 'reviewed', createHash('sha256').update(roomReal(dir)).digest('hex'));
export const reviewedFile = (dir, rel) => join(reviewedDir(dir), createHash('sha256').update(rel).digest('hex') + '.json');

const recentVersionsStore = (globalThis.__agentRoomDocVersions ??= new Map());
const recentKey = (dir, rel) => `${roomReal(dir)}\0${rel}`;

export function recordRenderedVersion(dir, rel, hash, source) {
  const key = recentKey(dir, rel);
  let versions = recentVersionsStore.get(key);
  if (!versions) { versions = new Map(); recentVersionsStore.set(key, versions); }
  if (versions.has(hash)) versions.delete(hash);
  versions.set(hash, source);
  while (versions.size > RECENT_VERSION_LIMIT) versions.delete(versions.keys().next().value);
}

export function readReviewed(dir, rel) {
  try {
    const file = reviewedFile(dir, rel);
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return typeof data?.source === 'string' && typeof data?.hash === 'string' ? data : null;
  } catch { return null; }
}

export function writeReviewed(dir, rel, entry) {
  mkdirSync(reviewedDir(dir), { recursive: true });
  writeFileSync(reviewedFile(dir, rel), JSON.stringify(entry), 'utf8');
}

export function ensureBaseline(dir, rel, hash, source) {
  let saved = readReviewed(dir, rel);
  if (!saved) {
    saved = { rel, hash, source, reviewed: false, updatedAt: new Date().toISOString() };
    writeReviewed(dir, rel, saved);
  }
  return saved;
}

export function markReviewed(dir, rel, hash, currentDiskSource = null) {
  if (typeof hash !== 'string' || !hash) {
    return { ok: false, unavailable: true, message: 'This version is no longer available: the pane will show the latest' };
  }
  const versions = recentVersionsStore.get(recentKey(dir, rel));
  let source = versions?.get(hash);
  if (source === undefined && typeof currentDiskSource === 'string' && sourceHash(currentDiskSource) === hash) {
    source = currentDiskSource;
  }
  if (source === undefined) {
    const existing = readReviewed(dir, rel);
    if (existing && existing.hash === hash) source = existing.source;
  }
  if (source === undefined) {
    return { ok: false, unavailable: true, message: 'This version is no longer available: the pane will show the latest' };
  }
  writeReviewed(dir, rel, { rel, hash, source, reviewed: true, updatedAt: new Date().toISOString() });
  return { ok: true };
}

function diffSeq(a, b, eq = (x, y) => x === y) {
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start], b[start])) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1], b[endB - 1])) { endA--; endB--; }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: 'eq', a: a[i], b: b[i] });
  const subA = a.slice(start, endA), subB = b.slice(start, endB);
  const m = subA.length, n = subB.length;
  if (m * n > 250000) {
    for (const x of subA) out.push({ op: 'del', a: x });
    for (const y of subB) out.push({ op: 'ins', b: y });
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = eq(subA[i], subB[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (eq(subA[i], subB[j])) out.push({ op: 'eq', a: subA[i++], b: subB[j++] });
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', a: subA[i++] });
      else out.push({ op: 'ins', b: subB[j++] });
    }
    while (i < m) out.push({ op: 'del', a: subA[i++] });
    while (j < n) out.push({ op: 'ins', b: subB[j++] });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) out.push({ op: 'eq', a: a[i], b: b[j] });
  return out;
}

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const stripTags = (html) => decodeEntities(html.replace(/<[^>]+>/g, ''));

function tokenizeNewHtml(html) {
  const pieces = [], words = [];
  const re = /(<[^>]+>|[^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const part = m[0];
    if (part.startsWith('<')) pieces.push({ kind: 'tag', html: part });
    else {
      const sub = /(\S+|\s+)/g;
      let sm;
      while ((sm = sub.exec(part)) !== null) {
        const seg = sm[0];
        if (/^\s+$/.test(seg)) pieces.push({ kind: 'space', html: seg });
        else {
          const word = decodeEntities(seg);
          pieces.push({ kind: 'word', html: seg, word });
          words.push(word);
        }
      }
    }
  }
  return { pieces, words };
}

function diffHtmlWords(oldHtml, newHtml) {
  const oldWords = stripTags(oldHtml).trim().split(/\s+/).filter(Boolean);
  const { pieces, words: newWords } = tokenizeNewHtml(newHtml);
  const ops = diffSeq(oldWords, newWords);
  const inserted = new Array(newWords.length).fill(false);
  const deletedBefore = Array.from({ length: newWords.length + 1 }, () => []);
  let ni = 0;
  for (const op of ops) {
    if (op.op === 'eq') ni++;
    else if (op.op === 'ins') inserted[ni++] = true;
    else if (op.op === 'del') deletedBefore[ni].push(op.a);
  }
  let out = '', wi = 0;
  for (const piece of pieces) {
    if (piece.kind !== 'word') { out += piece.html; continue; }
    if (deletedBefore[wi].length) out += `<del class="diff-del">${esc(deletedBefore[wi].join(' '))}</del> `;
    out += inserted[wi] ? `<ins class="diff-ins">${piece.html}</ins>` : piece.html;
    wi++;
  }
  if (deletedBefore[newWords.length].length) {
    out += `${newWords.length ? ' ' : ''}<del class="diff-del">${esc(deletedBefore[newWords.length].join(' '))}</del>`;
  }
  return out.replace(/<\/ins>(\s+)<ins class="diff-ins">/g, '$1');
}

function mermaidBoxes(src) {
  const boxes = new Map();
  for (const rawLine of String(src).split('\n')) {
    const line = rawLine.trim();
    if (!line || /^(flowchart|graph|subgraph|end|classDef|class|style|linkStyle|click|direction|%%)\b/i.test(line)) continue;
    const defRe = /\b([A-Za-z_][\w-]*)\s*(\[\[[^\]]*\]\]|\[\([^\)]*\)\]|\(\[[^\]]*\]\)|\(\([^\)]*\)\)|\{\{[^\}]*\}\}|\[[^\]]*\]|\([^\)]*\)|\{[^\}]*\})/g;
    let m;
    while ((m = defRe.exec(line)) !== null) boxes.set(m[1], m[2].trim());
    // Bare node ids connected by arrows (e.g. "A --> B").
    const cleaned = line.replace(defRe, '$1').replace(/\|[^|]*\|/g, ' ');
    if (/-->|---|-\.-|==>|<--/.test(cleaned)) {
      for (const seg of cleaned.split(/\s*(?:<-->|-->|---|-\.->|-\.-|==>|<--)\s*/)) {
        const id = /^([A-Za-z_][\w-]*)$/.exec(seg.trim());
        if (id && !boxes.has(id[1])) boxes.set(id[1], id[1]);
      }
    }
  }
  return boxes;
}

function csvCellMap(text) {
  const grid = parseCsv(text);
  const map = new Map();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const ref = colName(c) + (r + 1);
      const raw = grid[r][c] ?? '';
      let shown = '';
      if (raw !== '') {
        try { const v = sheetValue(grid, ref); shown = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v); }
        catch (err) { shown = err.message; }
      }
      map.set(ref, { raw, shown });
    }
  }
  return map;
}

const renderToken = (tok, links, parser) => parser.parser(Object.assign([tok], { links }));

const addRootClass = (html, cls) => {
  if (/^<[a-z][a-z0-9]*\b[^>]*\bclass="/i.test(html)) {
    return html.replace(/^(<[a-z][a-z0-9]*\b[^>]*\bclass=")/i, `$1${cls} `);
  }
  if (/^<[a-z][a-z0-9]*\b/i.test(html)) {
    return html.replace(/^(<[a-z][a-z0-9]*\b)/i, `$1 class="${cls}"`);
  }
  return `<div class="${cls}">${html}</div>\n`;
};

const stripOuterTag = (html) => {
  const m = /^(<([a-z][a-z0-9]*)\b[^>]*>)([\s\S]*)(<\/\2>\s*)$/i.exec(html);
  return m ? { open: m[1], inner: m[3], close: m[4] } : null;
};

const renderListItemHtml = (item, listTok, links, parser) => {
  const single = { ...listTok, items: [item] };
  return renderToken(single, links, parser)
    .replace(/^<(?:ul|ol)[^>]*>\n?/, '')
    .replace(/<\/(?:ul|ol)>\n?$/, '');
};

function extractBlocks(source, parser) {
  const tokens = parser.lexer(source);
  const links = tokens.links;
  const blocks = [];
  for (const tok of tokens) {
    if (tok.type === 'space' || tok.type === 'def') continue;
    const html = renderToken(tok, links, parser);
    if (tok.type === 'heading') {
      blocks.push({ kind: 'heading', depth: tok.depth, text: tok.text, raw: tok.raw, tok, links, html, key: `h${tok.depth}:${html}` });
    } else if (tok.type === 'paragraph') {
      blocks.push({ kind: 'paragraph', text: tok.text, raw: tok.raw, tok, links, html, key: `p:${html}` });
    } else if (tok.type === 'list') {
      blocks.push({ kind: 'list', ordered: !!tok.ordered, start: tok.start, text: tok.raw, raw: tok.raw, tok, links, html, key: `list:${html}` });
    } else if (tok.type === 'blockquote') {
      blocks.push({ kind: 'blockquote', text: tok.text, raw: tok.raw, tok, links, html, key: `bq:${html}` });
    } else if (tok.type === 'code') {
      const [langKind, name] = String(tok.lang ?? '').trim().split(/\s+/);
      if (langKind === 'csv') blocks.push({ kind: 'csv', name: name || 'table', text: tok.text, raw: tok.raw, tok, links, html, key: `csv:${name || 'table'}:${tok.text}` });
      else if (langKind === 'mermaid') blocks.push({ kind: 'mermaid', text: tok.text, raw: tok.raw, tok, links, html, key: `mermaid:${tok.text}` });
      else if (langKind === 'vega-lite') blocks.push({ kind: 'vega-lite', text: tok.text, raw: tok.raw, tok, links, html, key: `vl:${tok.text}` });
      else blocks.push({ kind: 'code', lang: tok.lang ?? '', text: tok.text, raw: tok.raw, tok, links, html, key: `code:${html}` });
    } else {
      blocks.push({ kind: 'other', raw: tok.raw, tok, links, html, key: `other:${html}` });
    }
  }
  return blocks;
}

const wordOverlap = (a, b) => {
  const wa = new Set(String(a).toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(String(b).toLowerCase().split(/\W+/).filter(Boolean));
  if (!wa.size && !wb.size) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size, 1);
};

function pairHunk(dels, inss) {
  const usedIns = new Set();
  const matched = new Map(); // delIndex -> insIndex
  for (let di = 0; di < dels.length; di++) {
    const d = dels[di];
    let bestIdx = -1, bestScore = -1;
    for (let ii = 0; ii < inss.length; ii++) {
      if (usedIns.has(ii) || inss[ii].kind !== d.kind) continue;
      if (d.kind === 'csv') {
        if (d.name === inss[ii].name) { bestIdx = ii; bestScore = 1; break; }
        continue;
      }
      if (d.kind === 'mermaid' || d.kind === 'vega-lite' || d.kind === 'code') {
        bestIdx = ii; bestScore = 1; break;
      }
      if (d.kind === 'list') {
        if (d.ordered === inss[ii].ordered) {
          const score = wordOverlap(d.text ?? d.raw, inss[ii].text ?? inss[ii].raw);
          if (score > bestScore) { bestIdx = ii; bestScore = score; }
        }
        continue;
      }
      const score = wordOverlap(d.text ?? d.raw, inss[ii].text ?? inss[ii].raw);
      if (score >= 0.25 && score > bestScore) { bestIdx = ii; bestScore = score; }
    }
    if (bestIdx >= 0) { matched.set(di, bestIdx); usedIns.add(bestIdx); }
  }
  // Emit in document order: unmatched ins before paired mod, paired mod, unmatched del.
  const out = [];
  const pairedIns = new Map([...matched.entries()].map(([di, ii]) => [ii, di]));
  let nextDel = 0;
  for (let ii = 0; ii < inss.length; ii++) {
    if (pairedIns.has(ii)) {
      const di = pairedIns.get(ii);
      while (nextDel < di) {
        if (!matched.has(nextDel)) out.push({ op: 'del', a: dels[nextDel] });
        nextDel++;
      }
      out.push({ op: 'mod', a: dels[di], b: inss[ii] });
      nextDel = di + 1;
    } else {
      out.push({ op: 'ins', b: inss[ii] });
    }
  }
  while (nextDel < dels.length) {
    if (!matched.has(nextDel)) out.push({ op: 'del', a: dels[nextDel] });
    nextDel++;
  }
  return out;
}

function diffBlockList(oldArr, newArr) {
  const rawOps = diffSeq(oldArr, newArr, (x, y) => x.key === y.key);
  const ops = [];
  let dels = [], inss = [];
  const flushHunk = () => {
    if (!dels.length && !inss.length) return;
    if (dels.length && inss.length) ops.push(...pairHunk(dels, inss));
    else {
      for (const a of dels) ops.push({ op: 'del', a });
      for (const b of inss) ops.push({ op: 'ins', b });
    }
    dels = []; inss = [];
  };
  for (const op of rawOps) {
    if (op.op === 'eq') { flushHunk(); ops.push(op); }
    else if (op.op === 'del') dels.push(op.a);
    else inss.push(op.b);
  }
  flushHunk();
  return ops;
}

function renderListDiff(oldBlock, newBlock, parser) {
  const oldItems = oldBlock.tok.items.map((item) => {
    const html = renderListItemHtml(item, oldBlock.tok, oldBlock.links, parser);
    return { kind: 'list_item', text: item.text, raw: item.raw, html, key: html };
  });
  const newItems = newBlock.tok.items.map((item) => {
    const html = renderListItemHtml(item, newBlock.tok, newBlock.links, parser);
    return { kind: 'list_item', text: item.text, raw: item.raw, html, key: html };
  });
  const ops = diffBlockList(oldItems, newItems);
  const tag = newBlock.tok.ordered ? 'ol' : 'ul';
  const startAttr = newBlock.tok.ordered && newBlock.tok.start !== 1 && newBlock.tok.start !== '' ? ` start="${newBlock.tok.start}"` : '';
  let out = `<${tag}${startAttr}>\n`;
  let changes = 0;
  for (const op of ops) {
    if (op.op === 'eq') out += op.b.html;
    else if (op.op === 'ins') { changes++; out += addRootClass(op.b.html, 'diff-ins-block'); }
    else if (op.op === 'del') { changes++; out += addRootClass(op.a.html, 'diff-del-block'); }
    else if (op.op === 'mod') {
      changes++;
      const oldParts = stripOuterTag(op.a.html), newParts = stripOuterTag(op.b.html);
      out += oldParts && newParts
        ? `${newParts.open}${diffHtmlWords(oldParts.inner, newParts.inner)}${newParts.close}`
        : addRootClass(op.b.html, 'diff-ins-block');
    }
  }
  if (changes === 0 && oldBlock.html !== newBlock.html) changes = 1; // e.g. start number changed
  out += `</${tag}>\n`;
  return { html: out, changes };
}

export function renderMarkdownWithDiff(oldSource, newSource, parser = md) {
  if (oldSource === newSource) return { html: parser.parse(newSource), changeCount: 0, removed: [] };
  const oldBlocks = extractBlocks(oldSource, parser);
  const newBlocks = extractBlocks(newSource, parser);
  const ops = diffBlockList(oldBlocks, newBlocks);

  let html = '', changeCount = 0;
  const removed = [];

  for (const op of ops) {
    const blk = op.b ?? op.a;
    if (op.op === 'eq') {
      html += blk.html;
    } else if (op.op === 'ins') {
      changeCount++;
      if (blk.kind === 'csv') {
        const cells = csvCellMap(blk.text);
        const changed = new Set([...cells.entries()].filter(([, v]) => v.raw !== '').map(([k]) => k));
        html += csvTable(blk.text, blk.name, changed);
      } else if (blk.kind === 'mermaid') {
        const ids = [...mermaidBoxes(blk.text).keys()];
        html += `<div class="mermaid-box" data-changed-nodes="${esc(JSON.stringify(ids))}"><pre class="mermaid-src">${esc(blk.text)}</pre></div>\n`;
      } else if (blk.kind === 'vega-lite') {
        html += `<div class="vl-box diff-changed"><div class="diff-chart-badge">Changed since review</div><pre class="vl-src">${esc(blk.text)}</pre></div>\n`;
      } else {
        html += addRootClass(blk.html, 'diff-ins-block');
      }
    } else if (op.op === 'del') {
      changeCount++;
      if (blk.kind === 'csv') {
        const prefix = blk.name === 'table' ? '' : `${blk.name}!`;
        for (const [ref, v] of csvCellMap(blk.text)) {
          if (v.raw !== '') removed.push(`table cell ${prefix}${ref}`);
        }
      } else if (blk.kind === 'mermaid') {
        const boxes = mermaidBoxes(blk.text);
        if (boxes.size) { for (const id of boxes.keys()) removed.push(`diagram box ${id}`); }
        else removed.push('diagram');
      } else if (blk.kind === 'vega-lite') {
        removed.push('chart');
      } else {
        html += addRootClass(blk.html, 'diff-del-block');
      }
    } else if (op.op === 'mod') {
      const a = op.a, b = op.b;
      if (b.kind === 'heading' || b.kind === 'paragraph' || b.kind === 'blockquote') {
        changeCount++;
        const oldParts = stripOuterTag(a.html), newParts = stripOuterTag(b.html);
        html += oldParts && newParts
          ? `${newParts.open}${diffHtmlWords(oldParts.inner, newParts.inner)}${newParts.close}`
          : addRootClass(b.html, 'diff-ins-block');
      } else if (b.kind === 'list') {
        const res = renderListDiff(a, b, parser);
        changeCount += res.changes;
        html += res.html;
      } else if (b.kind === 'csv') {
        const oldCells = csvCellMap(a.text), newCells = csvCellMap(b.text);
        const changed = new Set();
        const prefix = b.name === 'table' ? '' : `${b.name}!`;
        for (const [ref, nv] of newCells) {
          const ov = oldCells.get(ref);
          if (!ov || ov.raw !== nv.raw || ov.shown !== nv.shown) {
            if (nv.raw !== '' || (ov && ov.raw !== '')) { changed.add(ref); changeCount++; }
          }
        }
        for (const [ref, ov] of oldCells) {
          if (ov.raw !== '' && !newCells.has(ref)) { removed.push(`table cell ${prefix}${ref}`); changeCount++; }
        }
        html += csvTable(b.text, b.name, changed);
      } else if (b.kind === 'mermaid') {
        const oldBoxes = mermaidBoxes(a.text), newBoxes = mermaidBoxes(b.text);
        const changedIds = [];
        const removedBoxes = [];
        for (const [id, spec] of newBoxes) {
          if (!oldBoxes.has(id) || oldBoxes.get(id) !== spec) { changedIds.push(id); changeCount++; }
        }
        for (const id of oldBoxes.keys()) {
          if (!newBoxes.has(id)) { removedBoxes.push(`diagram box ${id}`); changeCount++; }
        }
        removed.push(...removedBoxes);
        const wholeChanged = !changedIds.length && !removedBoxes.length;
        if (wholeChanged) changeCount++;
        html += `<div class="mermaid-box${wholeChanged ? ' diff-changed' : ''}" data-changed-nodes="${esc(JSON.stringify(changedIds))}">${wholeChanged ? '<div class="diff-chart-badge">Changed since review</div>' : ''}<pre class="mermaid-src">${esc(b.text)}</pre></div>\n`;
      } else if (b.kind === 'vega-lite') {
        changeCount++;
        html += `<div class="vl-box diff-changed"><div class="diff-chart-badge">Changed since review</div><pre class="vl-src">${esc(b.text)}</pre></div>\n`;
      } else {
        changeCount++;
        html += addRootClass(b.html, 'diff-ins-block');
      }
    }
  }
  return { html, changeCount, removed };
}

// Browser bundles a document page may load (/__lib/<name>), straight from node_modules.
const LIBS = {
  'mermaid.js': 'mermaid/dist/mermaid.min.js',
  'vega.js': 'vega/build/vega.min.js', 'vega-lite.js': 'vega-lite/build/vega-lite.min.js', 'vega-embed.js': 'vega-embed/build/vega-embed.min.js',
};

function reviewBarHtml(meta) {
  if (!meta || meta.reviewed === undefined) return '';
  const status = !meta.reviewed
    ? (meta.changeCount > 0
      ? `Tracking changes since you first opened this document · ${meta.changeCount} ${meta.changeCount === 1 ? 'change' : 'changes'}`
      : 'Tracking changes since you first opened this document')
    : (meta.changeCount === 0
      ? '0 changes since you reviewed'
      : `${meta.changeCount} ${meta.changeCount === 1 ? 'change' : 'changes'} since you reviewed`);
  const removed = meta.removed?.length
    ? `<div id="removed-list"><strong>Removed since review:</strong> ${meta.removed.map(esc).join(' · ')}</div>`
    : '';
  return `<div id="review-bar" role="region" aria-label="Review status"><span class="review-status">${esc(status)}</span><button type="button" id="mark-reviewed"${meta.reviewed && meta.changeCount === 0 ? ' disabled' : ''}>Mark reviewed</button>${removed}</div>`;
}

// The page polls the file's mtime and updates its content in place when an agent changes it.
// base: the room's address (/r/<id>/), so the page's links stay in its room.
function page(title, body, watch, base = '/', meta = null) {
  const home = `<a href="${esc(base)}">all files</a>`, mtime = `${base}__mtime?f=`;
  const docHash = meta?.hash ?? null;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><style>
:root { color-scheme: dark; }
body { font: 14px/1.55 -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
img { max-width: 100%; } img.preview { display: block; margin: .5rem 0; }
pre, code { background: #8881; border-radius: 4px; } pre { padding: .75rem; overflow-x: auto; } code { padding: 0 .2em; }
table { border-collapse: collapse; } th, td { border: 1px solid #8886; padding: .3rem .6rem; }
.sheet-box { overflow-x: auto; margin: 1rem 0; }
.sheet { font: 13px/1.4 ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; }
.sheet th { font-weight: 400; opacity: .6; background: #8881; } .sheet td.num { text-align: right; }
.sheet td.formula { color: #7aa7ff; }
.sheet td { cursor: pointer; } .sheet td:hover { background: #2f6fde1f; }
.sheet td.hl { outline: 2px solid #e07a10; outline-offset: -2px; background: #e07a1026; }
.sheet td.diff-changed { background: #a6e3a128; outline: 1px solid #a6e3a199; outline-offset: -1px; }
.mermaid-box { margin: 1rem 0; overflow-x: auto; } .mermaid-box svg { max-width: 100%; height: auto; }
.mermaid-box.diff-changed { border: 1px solid #a6e3a199; border-radius: 6px; padding: .4rem; background: #a6e3a10d; }
.mermaid-box g.node { cursor: pointer; }
.mermaid-box g.node:hover :is(rect, polygon, path, circle, ellipse) { stroke: #2f6fde !important; stroke-width: 2.5px !important; }
.mermaid-box g.node.diff-changed :is(rect, polygon, path, circle, ellipse) { stroke: #a6e3a1 !important; stroke-width: 3px !important; }
.mermaid-box g.node.hl :is(rect, polygon, path, circle, ellipse) { stroke: #e07a10 !important; stroke-width: 3.5px !important; }
.mermaid-error { color: #c33; white-space: pre-wrap; font: 13px ui-monospace, Menlo, monospace; }
.vl-box { margin: 1rem 0; width: 100%; overflow-x: auto; } .vl-box .vega-embed { width: 100%; }
.vl-box.diff-changed { border: 1px solid #a6e3a199; border-radius: 6px; padding: .4rem; background: #a6e3a10d; }
.diff-chart-badge { font: 12px/1.3 system-ui, sans-serif; color: #a6e3a1; margin-bottom: .3rem; }
.vl-box .hl { stroke: #e07a10 !important; stroke-width: 3px !important; }
.diff-ins { text-decoration: none; background: #a6e3a12e; border-bottom: 1px solid #a6e3a188; border-radius: 2px; }
.diff-ins-block { background: #a6e3a11a; border-left: 3px solid #a6e3a199; padding-left: .5rem; }
.diff-del { text-decoration: line-through; color: #f38ba8; background: #f38ba81f; border-radius: 2px; user-select: none; -webkit-user-select: none; }
.diff-del-block { text-decoration: line-through; opacity: .7; color: #f38ba8; background: #f38ba814; border-left: 3px solid #f38ba888; padding-left: .5rem; user-select: none; -webkit-user-select: none; }
#review-bar { display: none; align-items: center; flex-wrap: wrap; gap: .5rem; margin: 0 0 .75rem; padding: .4rem .65rem; border-radius: 8px; background: #1e2430; border: 1px solid #8885; font: 12px/1.4 system-ui, sans-serif; }
body.in-room #review-bar { display: flex; }
#review-bar .review-status { flex: 1 1 auto; color: #cdd6f4; }
#review-bar button { font: inherit; border: 1px solid #2f6fde; background: #2f6fde22; color: #89b4fa; border-radius: 5px; padding: 2px 10px; cursor: pointer; }
#review-bar button:disabled { opacity: .45; cursor: default; }
#review-notice { width: 100%; color: #f6c177; }
#removed-list { width: 100%; padding-top: .25rem; border-top: 1px solid #8883; color: #f38ba8; }
main { position: relative; }
#ink { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 5; }
body.drawing #ink { pointer-events: auto; cursor: crosshair; touch-action: none; }
#ink path, #ink ellipse, #ink line { fill: none; stroke: #d6337a; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
#ink-tools { position: sticky; top: .5rem; margin: 0 0 .75rem auto; width: max-content; z-index: 10; display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: Canvas; border: 1px solid #8886; font: 12px system-ui, sans-serif; }
#ink-tools button { font: inherit; border: 1px solid transparent; background: none; color: CanvasText; border-radius: 5px; padding: 2px 8px; cursor: pointer; }
#ink-tools button[aria-pressed="true"] { border-color: #2f6fde; color: #2f6fde; background: #2f6fde1f; }
#passage-note { position: fixed; top: .5rem; left: 50%; transform: translateX(-50%); z-index: 20; max-width: 90%; padding: .35rem .75rem; border-radius: 6px; background: #3b2416; color: #f6c177; border: 1px solid #e07a10; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 2px 8px #0006; }
nav { font-size: .85rem; opacity: .7; margin-bottom: 1rem; }
</style></head><body><nav>${home} · ${esc(title)}</nav>${reviewBarHtml(meta)}<main${docHash ? ` data-doc-hash="${esc(docHash)}"` : ''}>${body}</main>
${body.includes('<div class="mermaid-box') ? `<script src="${esc(base)}__lib/mermaid.js"></script>` : ''}
${body.includes('<div class="vl-box') ? ['vega', 'vega-lite', 'vega-embed'].map((l) => `<script src="${esc(base)}__lib/${l}.js"></script>`).join('') : ''}
<script>
if (parent !== window) document.body.classList.add('in-room');
// Dynamic loader for Mermaid and Vega bundles when an in-place update adds the first diagram or chart.
const LIB_BASE = ${JSON.stringify(base)} + '__lib/';
const loadedLibs = new Map();
const loadScript = (name) => {
  if (loadedLibs.has(name)) return loadedLibs.get(name);
  const p = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = LIB_BASE + name;
    s.onload = () => ok();
    s.onerror = () => { loadedLibs.delete(name); fail(new Error('Failed to load ' + name)); };
    document.head.append(s);
  });
  loadedLibs.set(name, p);
  return p;
};
// Vega-Lite blocks: drawn here as SVG. views keeps each chart, for pointing and highlighting.
const views = [];
async function renderCharts() {
  for (const v of views.splice(0)) { try { v.finalize(); } catch {} }
  const boxes = [...document.querySelectorAll('.vl-box')].filter((b) => b.querySelector('.vl-src'));
  if (!boxes.length) return;
  if (!window.vegaEmbed) {
    try {
      await loadScript('vega.js');
      await loadScript('vega-lite.js');
      await loadScript('vega-embed.js');
    } catch { return; }
  }
  if (!window.vegaEmbed) return;
  for (const box of boxes) {
    const src = box.querySelector('.vl-src'); if (!src) continue;
    const badge = box.querySelector('.diff-chart-badge');
    const fail = (err) => {
      if (!box.isConnected) return;
      const p = document.createElement('p'); p.className = 'mermaid-error'; p.textContent = 'This chart has an error: ' + ((err && err.message) || err);
      box.append(p);
    };
    let spec;
    try { spec = JSON.parse(src.textContent); } catch (err) { fail(err); continue; }
    vegaEmbed(box, spec, { renderer: 'svg', actions: false, theme: 'dark' })
      .then(({ view }) => {
        if (!box.isConnected) { try { view.finalize(); } catch {} return; }
        if (badge && !box.contains(badge)) box.prepend(badge);
        views.push(view);
        view.addEventListener('click', (e, item) => pointAtDatum(item));
      }).catch(fail);
  }
}
renderCharts();
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
let mermaidSeq = 0, mermaidInit = false;
async function renderDiagrams() {
  const boxes = [...document.querySelectorAll('.mermaid-box')].filter((b) => b.querySelector('.mermaid-src'));
  if (!boxes.length) return;
  if (!window.mermaid) {
    try { await loadScript('mermaid.js'); } catch { return; }
  }
  if (!window.mermaid) return;
  if (!mermaidInit) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', flowchart: { htmlLabels: false } });
    mermaidInit = true;
  }
  for (const box of boxes) {
    const src = box.querySelector('.mermaid-src'); if (!src) continue;
    const badge = box.querySelector('.diff-chart-badge');
    const changedNodes = (() => { try { return new Set(JSON.parse(box.dataset.changedNodes || '[]')); } catch { return new Set(); } })();
    const id = 'mermaid-' + (++mermaidSeq);
    try {
      const { svg } = await mermaid.render(id, src.textContent);
      if (box.isConnected) {
        box.innerHTML = svg;
        if (badge) box.prepend(badge);
        if (changedNodes.size) {
          for (const g of box.querySelectorAll('g.node')) {
            if (changedNodes.has(nodeName(g))) g.classList.add('diff-changed');
          }
        }
      }
    } catch (err) {
      const stray = document.getElementById('d' + id); if (stray) stray.remove(); // mermaid's own error drawing, left at the end of the page
      if (box.isConnected) {
        const p = document.createElement('p'); p.className = 'mermaid-error'; p.textContent = 'This diagram has an error: ' + ((err && err.message) || err);
        box.append(p);
      }
    }
  }
}
renderDiagrams();
// A diagram box's name: its id in the source (Worker in "Worker[The worker]").
const nodeName = (g) => g.dataset.id || (/flowchart-(.+)-\\d+$/.exec(g.id) || [])[1] || null;
let shownHash = ${JSON.stringify(docHash)};
let last = shownHash, updating = false;
async function refreshDoc(preserveNotice = null) {
  const res = await fetch(location.href, { cache: 'no-store' });
  if (!res.ok) return false;
  const html = await res.text();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const nextMain = parsed.querySelector('main');
  const main = document.querySelector('main');
  if (!nextMain || !main) return false;
  const inkEl = document.getElementById('ink');
  const nextHasFigures = !!nextMain.querySelector('.sheet, .mermaid-box, .vl-box');
  if (parent !== window && !inkEl && nextHasFigures) { location.reload(); return true; }
  const sx = window.scrollX, sy = window.scrollY;
  const frag = document.createDocumentFragment();
  for (const node of [...nextMain.childNodes]) frag.append(document.adoptNode(node));
  for (const child of [...main.childNodes]) if (child !== inkEl) child.remove();
  if (inkEl) main.insertBefore(frag, inkEl); else main.append(frag);
  const nextHash = nextMain.dataset.docHash || null;
  if (nextHash) { shownHash = nextHash; main.dataset.docHash = nextHash; }
  const curBar = document.getElementById('review-bar'), nextBar = parsed.getElementById('review-bar');
  if (curBar && nextBar) {
    curBar.innerHTML = nextBar.innerHTML;
    if (preserveNotice) {
      const note = document.createElement('div'); note.id = 'review-notice'; note.setAttribute('role', 'status'); note.textContent = preserveNotice;
      curBar.append(note);
    }
  }
  window.scrollTo(sx, sy);
  renderDiagrams();
  renderCharts();
  return nextHash || true;
}
async function pollMtime() {
  if (updating) return;
  updating = true;
  try {
    const res = await fetch(${JSON.stringify(mtime)} + encodeURIComponent(${JSON.stringify(watch)}), { cache: 'no-store' });
    if (!res.ok) return;
    const t = await res.text();
    if (t === 'false') return; // missing for now (being saved?): keep showing it, ask again
    if (last === null) { last = t; return; }
    if (t !== last) {
      const ok = await refreshDoc();
      if (ok) last = typeof ok === 'string' ? ok : t;
    }
  } catch {
    // Keep the current pane as it is and try again at the next poll.
  } finally {
    updating = false;
  }
}
pollMtime();
setInterval(pollMtime, 2000);
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest && e.target.closest('#mark-reviewed');
  if (!btn || btn.disabled || !${JSON.stringify(watch)} || !shownHash) return;
  btn.disabled = true;
  try {
    const res = await fetch(${JSON.stringify(base + '__review')}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: ${JSON.stringify(watch)}, hash: shownHash }),
    });
    if (res.ok) {
      const next = await refreshDoc();
      if (typeof next === 'string') last = next;
    } else {
      let msg = 'This version is no longer available: the pane will show the latest';
      try { const data = await res.json(); if (data && data.message) msg = data.message; } catch {}
      const next = await refreshDoc(msg);
      if (typeof next === 'string') last = next;
    }
  } catch {
    btn.disabled = false;
  }
});
// Shown in the room page, with tables, diagrams or charts: a markup layer. Pen, Circle and Arrow
// draw over the document; a finished mark points at what it covers (an arrow: what its tip is on).
// Marks stay until Clear marks or a manual reload. Esc goes back to Point.
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
// Shown in the room page: selecting prose in any Markdown document points at it on mouseup.
const DOC_PATH = ${JSON.stringify(watch)};
if (parent !== window && DOC_PATH) {
  const PASSAGE_LIMIT = 4000;
  const cleanText = (s) => String(s).replace(/\\s+/g, ' ').trim();
  const passageLabel = (q) => {
    const max = 56;
    if (q.length <= max) return '↳ "' + q + '"';
    const words = q.split(' ');
    if (words.length === 1) return '↳ "' + q.slice(0, 26) + '…' + q.slice(-26) + '"';
    const half = Math.floor((max - 3) / 2);
    let head = words[0], i = 1;
    while (i < words.length - 1 && head.length + 1 + words[i].length <= half) head += ' ' + words[i++];
    let tail = words[words.length - 1], j = words.length - 2;
    while (j >= i && tail.length + 1 + words[j].length <= half) tail = words[j--] + ' ' + tail;
    if (head.length > half) head = head.slice(0, half);
    if (tail.length > half) tail = tail.slice(-half);
    return '↳ "' + head + ' … ' + tail + '"';
  };
  let noteTimer = null;
  const clearNote = () => {
    clearTimeout(noteTimer); noteTimer = null;
    const el = document.getElementById('passage-note'); if (el) el.remove();
  };
  const showNote = (msg) => {
    clearNote();
    const el = document.createElement('div'); el.id = 'passage-note'; el.setAttribute('role', 'status'); el.textContent = msg;
    document.body.append(el);
    noteTimer = setTimeout(clearNote, 5000);
  };
  const isDeletedBlock = (el) => el.classList.contains('diff-del-block') || !!el.closest('.diff-del-block');
  const currentHeadingText = (h) => {
    const clone = h.cloneNode(true);
    for (const d of clone.querySelectorAll('.diff-del, .diff-del-block')) d.remove();
    return cleanText(clone.textContent);
  };
  const extractQuote = (range) => {
    const frag = range.cloneContents();
    for (const el of frag.querySelectorAll('.diff-del, .diff-del-block')) el.remove();
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const isBlock = node.nodeType === 1 && /^(P|LI|PRE|H[1-6]|BLOCKQUOTE|DIV|TR)$/.test(node.tagName);
      if (isBlock && parts.length) parts.push(' ');
      for (const child of node.childNodes) walk(child);
      if (isBlock) parts.push(' ');
    };
    walk(frag);
    return cleanText(parts.join(''));
  };
  const passageLocation = (range, main) => {
    let start = range.startContainer;
    if (start === main && range.startOffset < main.childNodes.length) start = main.childNodes[range.startOffset];
    const startEl = start.nodeType === 1 ? start : start.parentElement;
    if (!startEl || !main.contains(startEl)) return 'passage in ' + DOC_PATH;
    let heading = null, inHeading = null;
    for (const h of main.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (isDeletedBlock(h)) continue;
      if (h.contains(startEl)) { inHeading = h; break; }
      if (h.compareDocumentPosition(startEl) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
    }
    if (inHeading) return 'passage in ' + DOC_PATH + ', heading "' + currentHeadingText(inHeading) + '"';
    let loc = 'passage in ' + DOC_PATH;
    if (heading) loc += ', under "' + currentHeadingText(heading) + '"';
    let block = startEl.closest('p, li, pre');
    if (block && block.tagName === 'LI' && [...block.children].some((c) => c.tagName === 'P')) {
      block = [...block.children].find((c) => c.tagName === 'P') || block;
    }
    if (block && main.contains(block) && !isDeletedBlock(block) && !block.closest('.mermaid-box, .vl-box')) {
      const blocks = [...main.querySelectorAll('p, li, pre')].filter((el) =>
        !isDeletedBlock(el) && !(el.tagName === 'LI' && [...el.children].some((c) => c.tagName === 'P')) && !el.closest('.mermaid-box, .vl-box')
      );
      let n = 0, found = false;
      for (const el of blocks) {
        if (heading && !(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        n++;
        if (el === block) { found = true; break; }
      }
      if (found) loc += ', paragraph ' + n;
    }
    return loc;
  };
  let downPos = null;
  document.addEventListener('mousedown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
  document.addEventListener('mouseup', (e) => {
    const prev = downPos; downPos = null;
    if (document.body.classList.contains('drawing')) return;
    if (e.target && e.target.closest && e.target.closest('#ink-tools, nav, #passage-note, #review-bar')) return;
    if (prev && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 3 && e.detail < 2) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const main = document.querySelector('main');
    if (!main) return;
    const raw = sel.getRangeAt(0);
    const insideMain = main.contains(raw.startContainer) && main.contains(raw.endContainer);
    const touchesMain = insideMain || main.contains(raw.startContainer) || main.contains(raw.endContainer)
      || (raw.commonAncestorContainer && raw.commonAncestorContainer.contains && raw.commonAncestorContainer.contains(main));
    if (!touchesMain) return;
    const commonEl = raw.commonAncestorContainer.nodeType === 1 ? raw.commonAncestorContainer : raw.commonAncestorContainer.parentElement;
    if (commonEl && commonEl.closest('.sheet, .mermaid-box, .vl-box, .diff-del-block')) return;
    const range = raw.cloneRange();
    if (!main.contains(range.startContainer)) range.setStart(main, 0);
    if (!main.contains(range.endContainer)) range.setEnd(main, main.childNodes.length);
    const quote = extractQuote(range);
    if (!quote) return;
    const text = passageLocation(range, main) + ': "' + quote + '"';
    if (text.length > PASSAGE_LIMIT) {
      showNote('Selection is too long to point at (over 4,000 characters with its location) — select a shorter passage.');
      return;
    }
    clearNote();
    parent.postMessage({ type: 'agent-room:point', kind: 'passage', label: passageLabel(quote), text }, location.origin);
  });
}
</script></body></html>`;
}


export { TYPES, esc, md, mdText, servable, boardDirs, LIBS, page };
