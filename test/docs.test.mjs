import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACH_LIMIT, broadcast, csvTable, docFiles, handle, isTextFile, isViewable, listFiles, messageView, pick, roomBranch, saveAttachments } from '../src/docs.mjs';

// A proposal/ folder with a doc, a drawing, a hidden file, and a file just outside it.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docs-test-'));
  const dir = join(root, 'proposal');
  mkdirSync(join(dir, 'drawings'), { recursive: true });
  writeFileSync(join(dir, 'plan.md'), '# Plan\n\n![flow](drawings/flow.png)\n\n[the sketch](drawings/sketch.png) · [site](https://example.com)\n');
  writeFileSync(join(dir, 'drawings', 'flow.png'), 'PNGDATA');
  writeFileSync(join(dir, 'drawings', 'sketch.png'), 'PNGDATA');
  writeFileSync(join(dir, '.DS_Store'), 'x');
  writeFileSync(join(root, 'secret.txt'), 'secret');
  return dir;
}

async function serve(dir, screen) {
  const server = createServer((req, res) => handle(req, res, dir, screen));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, get: (path) => fetch(base + path), close: () => server.close() };
}

test('listFiles: every non-hidden file, recursively, sorted', () => {
  assert.deepEqual(listFiles(fixture()), ['drawings/flow.png', 'drawings/sketch.png', 'plan.md']);
});

test('Markdown is rendered with images inline, and plain links to images get a preview', async () => {
  const s = await serve(fixture());
  const res = await s.get('/plan.md');
  const html = await res.text();
  s.close();
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /<h1>Plan<\/h1>/);
  assert.match(html, /<img src="drawings\/flow.png" alt="flow">/);
  assert.match(html, /<a href="drawings\/sketch.png">the sketch<\/a><img class="preview" src="drawings\/sketch.png"/);
  assert.match(html, /<a href="https:\/\/example.com">site<\/a>(?!<img)/);
});

test('a ```csv block shows as a table: column letters, row numbers, formulas worked out, every cell named', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'runs.md'), '# Runs\n\n```csv runs\nday,runs,minutes,per run\n11 Nov,9,54,=C2/B2\n"16 Nov, late",42,250,=C3/B3\nTotal,=SUM(B2:B3),=SUM(C2:C3),=C4/B4\n```\n\n```js\nconst a = 1;\n```\n');
  const s = await serve(dir);
  const html = await (await s.get('/runs.md')).text();
  s.close();
  assert.match(html, /<table class="sheet" data-sheet="runs"><thead><tr><th><\/th><th>A<\/th><th>B<\/th><th>C<\/th><th>D<\/th><\/tr>/);
  assert.match(html, /<tr><th>1<\/th><td data-cell="A1" title="A1">day<\/td>/);
  assert.match(html, /<td data-cell="A3" title="A3">16 Nov, late<\/td>/); // a quoted comma stays in its cell
  assert.match(html, /<td data-cell="D2" class="formula num" title="D2: =C2\/B2">6<\/td>/);
  assert.match(html, /<td data-cell="B4" class="formula num" title="B4: =SUM\(B2:B3\)">51<\/td>/);
  assert.match(html, /<td data-cell="D4" class="formula num" title="D4: =C4\/B4">5.96<\/td>/); // 304 / 51, two decimals at most
  assert.match(html, /<pre><code class="language-js">const a = 1;/); // other code blocks are unchanged
});

test('table formulas: AVERAGE, MIN, MAX, precedence; errors show in the cell; cell text is escaped', () => {
  const html = csvTable('2,4,=AVERAGE(A1:B1)+MIN(A1:B1)*MAX(A1:B1)\n=A1/0,=Z9,=C2\n=B3,<b>x</b>,=A1+\n,=(A1+B1)*-2,=A2');
  const cell = (ref) => new RegExp(`data-cell="${ref}"[^>]*>([^<]*)<`).exec(html)[1];
  assert.equal(cell('C1'), '11'); // 3 + 2 * 4
  assert.equal(cell('A2'), '#DIV/0');
  assert.equal(cell('B2'), '#REF');
  assert.equal(cell('C2'), '#CYCLE');
  assert.equal(cell('A3'), '&lt;b&gt;x&lt;/b&gt;'); // a reference to text shows the text, escaped
  assert.equal(cell('C3'), '#VALUE');
  assert.equal(cell('A4'), ''); // an empty cell stays empty
  assert.equal(cell('B4'), '-12');
  assert.equal(cell('C4'), '#DIV/0'); // an error passes through a reference
  assert.ok(!html.includes('<b>'));
  assert.match(html, /data-sheet="table"/);
});

test('pointing: a cell click from the shown document becomes a chip, and the next message carries it as text', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  // The room page's script is a template literal in docs.mjs: read it as the browser gets it.
  const slice = source.slice(source.indexOf('// Pointing: a click on a table cell'), source.indexOf("box.addEventListener('keydown'"));
  const code = new Function('return `' + slice.replace(/`/g, '\\`') + '`')();
  const frame ={ contentWindow: {} }, chips = { children: [], replaceChildren(...c) { this.children = c; } };
  const node = () => ({ append() {} });
  let onMessage;
  const window = { addEventListener: (type, f) => { if (type === 'message') onMessage = f; } };
  const document = { getElementById: (id) => (id === 'doc' ? frame : null), createElement: node, addEventListener() {} };
  const box = { value: '' };
  const page = new Function('window', 'document', 'location', '$', 'box', code + '; return { withPointing, pointed: () => pointed };')(
    window, document, { origin: 'http://127.0.0.1:5566' }, () => chips, box);
  const point = { type: 'agent-room:point', label: '↳ runs!D4 = 5.96', text: 'table cell runs!D4 in discussions/x/notes.md = 5.96 (Total, per run), formula =C4/B4' };
  onMessage({ origin: 'http://evil.example', source: frame.contentWindow, data: point }); // another site
  onMessage({ origin: 'http://127.0.0.1:5566', source: {}, data: point }); // not the shown document
  onMessage({ origin: 'http://127.0.0.1:5566', source: frame.contentWindow, data: { type: 'other' } });
  assert.equal(page.pointed().length, 0);
  onMessage({ origin: 'http://127.0.0.1:5566', source: frame.contentWindow, data: point });
  onMessage({ origin: 'http://127.0.0.1:5566', source: frame.contentWindow, data: point }); // the same cell again: one chip
  assert.equal(chips.children.length, 1);
  box.value = '/summary';
  page.withPointing(); // a command never gets the pointing
  assert.equal(box.value, '/summary');
  box.value = 'Why is this lower?  ';
  page.withPointing();
  assert.equal(box.value, 'Why is this lower?\n[pointing at: ' + point.text + ']');
  assert.equal(page.pointed().length, 0);
  assert.equal(chips.children.length, 0);
});

test('a shown document posts a table cell click to the room page, with its sheet, labels and formula', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'runs.md'), '```csv runs\nday,runs\nTotal,=1+1\n```\n');
  const s = await serve(dir);
  const html = await (await s.get('/runs.md')).text();
  s.close();
  assert.match(html, /parent\.postMessage\(\{ type: 'agent-room:point'/);
  assert.match(html, /' in ' \+ "runs\.md" \+ ' = '/);
  assert.match(html, /location\.origin\);/); // only to a page of the same room server
});

test('[[D4]] in a message becomes a reference the room page can highlight; text is escaped, code stays code', () => {
  const { html } = messageView({ speaker: 'Claude', text: 'See [[runs!D4]] and [[<b>x</b>]], not `[[B2]]` or [link](https://example.com).' });
  assert.match(html, /<span class="ref" data-ref="runs!D4">runs!D4<\/span>/);
  assert.match(html, /<span class="ref" data-ref="&lt;b&gt;x&lt;\/b&gt;">&lt;b&gt;x&lt;\/b&gt;<\/span>/);
  assert.match(html, /<code>\[\[B2\]\]<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com">link<\/a>/);
});

test('a shown document highlights the cells a hovered [[reference]] names, only when its room page asks', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'runs.md'), '```csv runs\nday,runs\n```\n');
  const s = await serve(dir);
  const html = await (await s.get('/runs.md')).text();
  s.close();
  assert.match(html, /e\.origin !== location\.origin \|\| e\.source !== parent \|\| !d \|\| d\.type !== 'agent-room:highlight'/);
  assert.match(html, /d\.ref === td\.dataset\.cell \|\| d\.ref === sheet \+ '!' \+ td\.dataset\.cell/);
});

test('a ```mermaid block: its source is kept (escaped) for the page to draw, and only then is mermaid loaded', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'flow.md'), '# Flow\n\n```mermaid\nflowchart LR\n  A[<b>Room</b>] --> Worker\n```\n');
  const s = await serve(dir);
  const flow = await (await s.get('/flow.md')).text();
  const plan = await (await s.get('/plan.md')).text();
  const lib = await s.get('/__lib/mermaid.js');
  const body = await lib.text();
  const post = await fetch(s.base + '/__lib/mermaid.js', { method: 'POST' });
  s.close();
  assert.match(flow, /<div class="mermaid-box"><pre class="mermaid-src">flowchart LR\n {2}A\[&lt;b&gt;Room&lt;\/b&gt;\] --&gt; Worker<\/pre><\/div>/);
  assert.match(flow, /<script src="\/__lib\/mermaid\.js"><\/script>/);
  assert.ok(!plan.includes('__lib/mermaid.js')); // a document without a diagram doesn't load it
  assert.match(lib.headers.get('content-type'), /text\/javascript/);
  assert.ok(body.length > 1e6 && body.includes('mermaid'));
  assert.equal(post.status, 405);
});

test('a document page\'s own script parses as served (it is written inside a template string)', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'both.md'), '```mermaid\nflowchart LR\n  A --> B\n```\n\n```csv\na,b\n```\n\n```vega-lite\n{"mark": "bar"}\n```\n');
  const s = await serve(dir);
  const html = await (await s.get('/both.md')).text();
  s.close();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.match(scripts[0], /\/flowchart-\(\.\+\)-\\d\+\$\//); // the regular expression reaches the browser intact
  assert.match(scripts[0], /'diagram box ' \+ box/);
  assert.match(scripts[0], /for \(const g of document\.querySelectorAll\('\.mermaid-box g\.node'\)\)/);
  assert.match(scripts[0], /'chart point ' \+ text \+ ' in ' \+ "both\.md"/);
  assert.match(scripts[0], /for \(const item of chartItems\(\)\)/);
  assert.match(scripts[0], /if \(parent !== window && document\.querySelector\('\.sheet, \.mermaid-box, \.vl-box'\)\)/); // the markup layer, in the room only
  assert.match(scripts[0], /text: 'a mark: ' \+ verb/);
});

test('a ```vega-lite block: its spec is kept (escaped) for the page to draw, with Vega loaded only then; /__lib serves only its list', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'chart.md'), '```vega-lite\n{"mark": "bar", "title": "<i>runs</i>"}\n```\n');
  const s = await serve(dir);
  const chart = await (await s.get('/chart.md')).text();
  const plan = await (await s.get('/plan.md')).text();
  const libs = await Promise.all(['vega', 'vega-lite', 'vega-embed'].map(async (l) => {
    const res = await s.get(`/__lib/${l}.js`); return [res.status, res.headers.get('content-type'), (await res.text()).length];
  }));
  const unknown = await Promise.all(['/__lib/constructor', '/__lib/../package.json', '/__lib/vega'].map(async (p) => (await s.get(p)).status));
  s.close();
  assert.match(chart, /<div class="vl-box"><pre class="vl-src">\{&quot;mark&quot;: &quot;bar&quot;, &quot;title&quot;: &quot;&lt;i&gt;runs&lt;\/i&gt;&quot;\}<\/pre><\/div>/);
  assert.match(chart, /<script src="\/__lib\/vega\.js"><\/script><script src="\/__lib\/vega-lite\.js"><\/script><script src="\/__lib\/vega-embed\.js"><\/script>/);
  assert.ok(!chart.includes('__lib/mermaid.js') && !plan.includes('__lib/vega'));
  for (const [status, type, size] of libs) { assert.equal(status, 200); assert.match(type, /text\/javascript/); assert.ok(size > 30000); }
  assert.deepEqual(unknown, [404, 404, 404]);
});

test('the room page\'s script parses as served (it is written inside a template string)', async () => {
  const s = await serve(fixture(), { clients: new Set(), transcript: [] });
  const html = await (await s.get('/__room')).text();
  s.close();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
  assert.match(html, /<input type="checkbox" id="follow"> Follow mentions/);
  assert.equal((html.match(/<div class="mention-offer" hidden><\/div>/g) || []).length, 2); // by both message boxes
});

test('mentions: a path names a file of the room, as given or inside the current discussion', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const slice = source.slice(source.indexOf('function resolveMention('), source.indexOf('// Turns the known file paths'));
  const resolve = (files, active) => new Function('mentionFiles', 'room', new Function('return `' + slice.replace(/`/g, '\\`') + '`')() + '; return resolveMention;')(files, { active });
  const r = resolve(['README.md', 'discussions/a/notes.md', 'discussions/a/drawings/flow.svg', 'discussions/b/notes.md'], 'discussions/a');
  assert.equal(r('notes.md'), 'discussions/a/notes.md'); // the current discussion's, not b's
  assert.equal(r('./drawings/flow.svg'), 'discussions/a/drawings/flow.svg');
  assert.equal(r('discussions/b/notes.md'), 'discussions/b/notes.md');
  assert.equal(r('README.md'), 'README.md');
  assert.equal(r('missing.md'), null);
  assert.equal(resolve(null, 'discussions/a')('notes.md'), null); // before the list loads
});

test('files are served with their type; nothing outside proposal/ or hidden is', async () => {
  const s = await serve(fixture());
  const png = await s.get('/drawings/flow.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(await png.text(), 'PNGDATA');
  assert.equal((await s.get('/%2e%2e/secret.txt')).status, 404);
  assert.equal((await s.get('/.DS_Store')).status, 404);
  assert.equal((await s.get('/missing.md')).status, 404);
  s.close();
});

test('the mtime endpoint changes when a doc is rewritten, so open pages reload', async () => {
  const dir = fixture();
  const s = await serve(dir);
  const before = await (await s.get('/__mtime?f=plan.md')).text();
  writeFileSync(join(dir, 'plan.md'), '# Changed\n');
  const after = await (await s.get('/__mtime?f=plan.md')).text();
  s.close();
  assert.notEqual(before, after);
});

test('pick: arrows move, Enter opens and stays, Esc closes', async () => {
  const input = new EventEmitter();
  const output = { write() {} };
  const opened = [];
  const done = pick(['a.md', 'b.md', 'c.md'], { input, output, onOpen: (f) => opened.push(f) });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'return' });
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '', { name: 'return' });
  input.emit('keypress', '', { name: 'escape' });
  await done;
  assert.deepEqual(opened, ['b.md', 'c.md']);
  assert.equal(input.listenerCount('keypress'), 0);
});

// Reads server-sent events from a fetch response, one parsed event per call.
function eventReader(res) {
  const reader = res.body.getReader();
  let buf = '';
  return async () => {
    while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
    const [chunk, ...rest] = buf.split('\n\n');
    buf = rest.join('\n\n');
    return JSON.parse(chunk.replace(/^data: /, ''));
  };
}

test('the discussion screen: a new page gets the room so far, then live events', async () => {
  const transcript = [{ speaker: 'User', text: 'look at **this**' }, { speaker: 'A', text: 'PASS', pass: true }];
  const screen = { clients: new Set(), transcript, doc: 'plan.md', thinking: 'B' };
  const s = await serve(fixture(), screen);
  const page = await (await s.get('/__room')).text();
  assert.match(page, /EventSource\('__events'\)/); // relative: the page's own room

  const next = eventReader(await s.get('/__events'));
  const reset = await next();
  assert.equal(reset.type, 'reset');
  assert.equal(reset.doc, 'plan.md');
  assert.equal(reset.thinking, 'B');
  assert.deepEqual(reset.messages.map((m) => [m.speaker, m.pass]), [['User', false], ['A', true]]);
  assert.match(reset.messages[0].html, /<strong>this<\/strong>/);
  assert.equal(screen.clients.size, 1);

  broadcast(screen, { type: 'doc', file: 'drawings/flow.png' });
  assert.deepEqual(await next(), { type: 'doc', file: 'drawings/flow.png' });
  for (const c of screen.clients) c.end();
  s.close();
});

test('the screen remembers "your turn" until the User speaks again', () => {
  const screen = { clients: new Set(), transcript: [] };
  broadcast(screen, { type: 'turn', text: 'your turn · all passed' });
  assert.equal(screen.status, 'your turn · all passed');
  broadcast(screen, { type: 'message', message: { speaker: 'Claude', html: '' } });
  assert.equal(screen.status, 'your turn · all passed');
  broadcast(screen, { type: 'message', message: { speaker: 'User', html: '' } });
  assert.equal(screen.status, null);
});

test('a page that connects learns whether a command from the screen is still running (the busy bar)', async () => {
  const docs = await import('../src/docs.mjs');
  assert.equal(docs.resetEvent({ transcript: [] }).busy, false);
  assert.equal(docs.resetEvent({ transcript: [], busy: true }).busy, true);
});

test('without a screen, /__room is just a missing file', async () => {
  const s = await serve(fixture());
  assert.equal((await s.get('/__room')).status, 404);
  s.close();
});

test('messageView marks errors and passes for the page', () => {
  assert.deepEqual(messageView({ speaker: 'A', text: 'quota', error: true }), { speaker: 'A', html: '<p>quota</p>\n', error: true, pass: false });
});

// A POST as the room page sends it (same host, JSON), with optional header overrides.
const postFrom = (s, path, body, headers = {}) =>
  fetch(s.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the screen lists proposal/ files and shows the one picked, for every open page', async () => {
  const screen = { clients: new Set(), transcript: [] };
  const s = await serve(fixture(), screen);
  assert.deepEqual(await (await s.get('/__files')).json(), ['drawings/flow.png', 'drawings/sketch.png', 'plan.md']);
  const next = eventReader(await s.get('/__events'));
  await next(); // reset
  assert.equal((await postFrom(s, '/__show', { file: 'plan.md' })).status, 204);
  assert.equal(screen.doc, 'plan.md');
  assert.deepEqual(await next(), { type: 'doc', file: 'plan.md' });
  assert.equal((await postFrom(s, '/__show', { file: '../secret.txt' })).status, 404);
  assert.equal(screen.doc, 'plan.md');
  for (const c of screen.clients) c.end();
  s.close();
});

// A POST with a forged Host header (fetch ignores one, so this uses node:http); resolves to the status.
const postWithHost = (s, path, host) => new Promise((done) => {
  const req = request(s.base + path, { method: 'POST', headers: { host, 'content-type': 'application/json' } }, (res) => { res.resume(); done(res.statusCode); });
  req.end(JSON.stringify({ text: 'x' }));
});

test('what the User types on the screen reaches the room only from the page itself', async () => {
  const said = [];
  const screen = { clients: new Set(), transcript: [], say: (line) => said.push(line) };
  const s = await serve(fixture(), screen);
  try {
    assert.equal((await postFrom(s, '/__say', { text: '  hello @Claude  ' })).status, 204);
    assert.deepEqual(said, ['hello @Claude']);
    // Another site's page, a form post, or a rebinding host are refused.
    assert.equal((await postFrom(s, '/__say', { text: 'x' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postFrom(s, '/__say', { text: 'x' }, { 'content-type': 'text/plain' })).status, 403);
    assert.equal(await postWithHost(s, '/__say', 'evil.example'), 403);
    assert.equal((await postFrom(s, '/__show', { file: 'plan.md' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.get('/__say')).status, 403); // GET
    assert.deepEqual(said, ['hello @Claude']);
  } finally {
    s.close();
  }
});

test('in terminal mode the page only watches: /__say is refused and the reset says so', async () => {
  const screen = { clients: new Set(), transcript: [] };
  const s = await serve(fixture(), screen);
  assert.equal((await postFrom(s, '/__say', { text: 'hi' })).status, 409);
  const next = eventReader(await s.get('/__events'));
  assert.equal((await next()).input, false);
  for (const c of screen.clients) c.end();
  s.close();
});

test('messageView hides summary turns and labels a summary\'s result', () => {
  assert.equal(messageView({ speaker: 'A', text: 'draft', summary: true }).hidden, true);
  const agreed = messageView({ speaker: 'Summary', text: '- x', outcome: 'agreed', by: 'A' });
  assert.deepEqual([agreed.speaker, agreed.outcome, agreed.hidden], ['Summary — agreed, by A', 'agreed', undefined]);
  assert.equal(messageView({ speaker: 'Summary', text: '- y', outcome: 'not agreed', by: 'B' }).speaker, 'Summary — not agreed: the last version, by B');
});

test('the Worker tab: instructions reach the worker only from the page, and a new page gets its chat', async () => {
  const sent = [];
  const worker = [{ speaker: 'User', html: '<p>fix</p>' }, { speaker: 'W', html: '<p>done</p>', meta: '3s' }];
  const screen = { clients: new Set(), transcript: [], worker, working: 'W', room: { folder: 'x', agents: ['A'], worker: 'W' },
    say: () => {}, work: (text) => sent.push(text) };
  const s = await serve(fixture(), screen);
  try {
    assert.equal((await postFrom(s, '/__work', { text: '  run the tests  ' })).status, 204);
    assert.equal((await postFrom(s, '/__work', { text: 'x' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postFrom(s, '/__work', { text: '  ' })).status, 400);
    assert.deepEqual(sent, ['run the tests']);
    const next = eventReader(await s.get('/__events'));
    const reset = await next();
    assert.deepEqual([reset.workInput, reset.working, reset.room.worker], [true, 'W', 'W']);
    assert.deepEqual(reset.worker.map((m) => m.speaker), ['User', 'W']);
    for (const c of screen.clients) c.end();
  } finally {
    s.close();
  }
});

test('showing the Worker tab asks the room to recheck its branches, only from the room page', async () => {
  let asked = 0;
  const s = await serve(fixture(), { clients: new Set(), transcript: [], refreshWorker: () => { asked++; } });
  try {
    assert.equal((await postFrom(s, '/__workerinfo', {})).status, 204);
    assert.equal((await postFrom(s, '/__workerinfo', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal(asked, 1);
  } finally { s.close(); }
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const showTab = source.slice(source.indexOf('function showTab('), source.indexOf("$('tab-talk').onclick"));
  assert.match(showTab, /if \(name === 'work'\) \{[^}]*post\('__workerinfo', \{\}\)/);
});

test('the Worker tab draws a Mermaid gitGraph when a lane is expanded and shows a plain-text note when gitGraph cannot draw it', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('// Mermaid for the Worker tab'), source.indexOf('function setWorking('));
  const node = (tag = 'div') => {
    const listeners = {};
    return {
      tag, className: '', textContent: '', innerHTML: '', open: false, disabled: false, placeholder: '',
      children: [], dataset: {},
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; },
      addEventListener(ev, fn) { (listeners[ev] ??= []).push(fn); },
      trigger(ev) { for (const fn of listeners[ev] ?? []) fn(); },
    };
  };
  const rendered = [];
  const winfo = node('div'), wbox = node('textarea');
  const win = { mermaid: { render: async (id, src) => { rendered.push({ id, src }); return { svg: '<svg>ok</svg>' }; } } };
  const harness = new Function('$', 'document', 'window', 'matchMedia', 'wbox',
    code + '\nreturn { setWorkerInfo };'
  )((id) => (id === 'winfo' ? winfo : node(id)), { createElement: node, getElementById: () => null, head: node('head') }, win, () => ({ matches: false }), wbox);

  harness.setWorkerInfo({
    lines: [],
    lanes: [
      { summary: 'worker/a · 1 commit to review', lines: ['line a'], diagram: { graph: 'gitGraph TB:\n  commit id: "abc1234 base"\n  branch "worker/a"' } },
      { summary: 'worker/b · 1 commit to review', lines: ['line b'], diagram: { note: 'Branch diagram unavailable: criss-cross merge.' } },
    ],
  });
  assert.equal(winfo.children.length, 2);
  // Collapsed lane has the diagram container ready, and draws on toggle open.
  assert.equal(rendered.length, 0);
  const laneA = winfo.children[0];
  laneA.open = true;
  laneA.trigger('toggle');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rendered.length, 1);
  assert.match(rendered[0].src, /^gitGraph TB:/);
  const boxA = laneA.children[1].children.find((c) => c.className === 'branch-diagram');
  assert.equal(boxA.innerHTML, '<svg>ok</svg>');
  // Unfaithful history lane renders the plain-text note.
  const laneB = winfo.children[1];
  const noteB = laneB.children[1].children.find((c) => c.className === 'branch-diagram-note');
  assert.equal(noteB.textContent, 'Branch diagram unavailable: criss-cross merge.');
});

test('the Close action switches between Close and Close with pending work in Actions and Discussions', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const winfoCode = source.slice(source.indexOf('const BRAINSTORM_NO_WORK ='), source.indexOf('function setWorking('));
  const closeCode = source.slice(source.indexOf('function closeActionLabel('), source.indexOf('function updateReplicaView('));
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', placeholder: '', disabled: false, children: [], dataset: {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    addEventListener() {},
  });
  const closedisc = node('button'), closemerge = node('button'), closediscard = node('button'), winfo = node('div'), wbox = node('textarea');
  let renders = 0;
  const harness = new Function('$', 'document', 'window', 'matchMedia', 'wbox', 'renderDiscussions',
    'let room = { active: "discussions/2026-11-19-a", brainstorm: false }, workerPending = null, workerDiscardable = new Set(), workerMergeable = {}, workerMerged = new Set(), ended = false, restarting = false;\n' +
    closeCode + '\n' + winfoCode + '\nreturn { showWorkerInfo, closeActionLabel, updateCloseButton, setRoom: (r) => { room = r; updateCloseButton(); } };'
  )((id) => (id === 'closedisc' ? closedisc : id === 'closemerge' ? closemerge : id === 'closediscard' ? closediscard : id === 'winfo' ? winfo : node(id)),
    { createElement: node, getElementById: () => null, head: node('head') }, {}, () => ({ matches: false }), wbox, () => { renders++; });

  // No pending work: Close in Actions and for every discussion row; Merge and Discard hidden until relevant.
  harness.showWorkerInfo({ lines: [], pending: [], discardable: [], mergeable: {} });
  assert.equal(closedisc.textContent, 'Close');
  assert.equal(closemerge.hidden, true);
  assert.equal(closediscard.hidden, true);
  assert.equal(harness.closeActionLabel('2026-11-19-a'), 'Close');
  assert.equal(harness.closeActionLabel('2026-11-19-b'), 'Close');

  // Pending work with greyed-out Close and Merge (tooltip gives reason) and visible Close and Discard.
  const before = renders;
  harness.showWorkerInfo({
    lines: [],
    pending: [{ lane: '2026-11-19-a', branch: 'worker/2026-11-19-a', ahead: 2, dirty: true }],
    discardable: ['2026-11-19-a'],
    mergeable: { '2026-11-19-a': { canMerge: false, catchUp: false, disabledReason: 'The worker\'s worktree has uncommitted edits.', targetBranch: 'main', behind: 0 } },
  });
  assert.equal(closedisc.textContent, 'Close with pending work');
  assert.equal(closemerge.hidden, false);
  assert.equal(closemerge.disabled, true);
  assert.equal(closemerge.title, 'The worker\'s worktree has uncommitted edits.');
  assert.equal(closediscard.hidden, false);
  assert.equal(harness.closeActionLabel('2026-11-19-a'), 'Close with pending work');
  assert.equal(harness.closeActionLabel('2026-11-19-b'), 'Close');
  assert.equal(renders, before + 1);

  // Target branch moved: switches to enabled Catch up with main.
  harness.showWorkerInfo({
    lines: [],
    pending: [{ lane: '2026-11-19-a', branch: 'worker/2026-11-19-a', ahead: 2, dirty: false }],
    discardable: ['2026-11-19-a'],
    mergeable: { '2026-11-19-a': { canMerge: false, catchUp: true, disabledReason: null, targetBranch: 'main', behind: 1 } },
  });
  assert.equal(closemerge.disabled, false);
  assert.equal(closemerge.textContent, 'Catch up with main');

  // Ready to merge: enabled Close and Merge.
  harness.showWorkerInfo({
    lines: [],
    pending: [{ lane: '2026-11-19-a', branch: 'worker/2026-11-19-a', ahead: 2, dirty: false }],
    discardable: ['2026-11-19-a'],
    mergeable: { '2026-11-19-a': { canMerge: true, catchUp: false, disabledReason: null, targetBranch: 'main', behind: 0 } },
  });
  assert.equal(closemerge.disabled, false);
  assert.equal(closemerge.textContent, 'Close and Merge');

  // Pending work cleared: returns to Close; hides Merge and Discard.
  harness.showWorkerInfo({ lines: [], pending: [], discardable: [], mergeable: {} });
  assert.equal(closedisc.textContent, 'Close');
  assert.equal(closemerge.hidden, true);
  assert.equal(closediscard.hidden, true);
  assert.equal(harness.closeActionLabel('2026-11-19-a'), 'Close');

  // Merged list change re-renders Discussions even when pending/discardable/mergeable are unchanged.
  const beforeMerged = renders;
  harness.showWorkerInfo({ lines: [], pending: [], discardable: [], mergeable: {}, merged: ['2026-11-19-a'] });
  assert.equal(renders, beforeMerged + 1);

  // Brainstorm stays Close brainstorm and hides Merge and Discard.
  harness.setRoom({ active: 'brainstorms/2026-11-19-idea', brainstorm: true });
  assert.equal(closedisc.textContent, 'Close brainstorm');
  assert.equal(closemerge.hidden, true);
  assert.equal(closediscard.hidden, true);
});

test('POST /__discard previews and confirms Close and Discard only from the room page', async () => {
  const calls = [];
  const s = await serve(fixture(), {
    clients: new Set(), transcript: [],
    discardPreview: async (name) => { calls.push(['preview', name]); return { ok: true, preview: { name, snapshot: 'snap1' } }; },
    closeAndDiscard: async (name, snap) => { calls.push(['confirm', name, snap]); return snap === 'snap1' ? { ok: true } : { changed: true, preview: { name, snapshot: 'snap2' } }; },
  });
  try {
    assert.equal((await postFrom(s, '/__discard', { name: '2026-11-19-a' }, { origin: 'https://evil.example' })).status, 403);
    const r1 = await postFrom(s, '/__discard', { name: '2026-11-19-a' });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).preview.snapshot, 'snap1');
    const r2 = await postFrom(s, '/__discard', { name: '2026-11-19-a', snapshot: 'stale' });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).changed, true);
    const r3 = await postFrom(s, '/__discard', { name: '2026-11-19-a', snapshot: 'snap1' });
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).ok, true);
    assert.deepEqual(calls, [['preview', '2026-11-19-a'], ['confirm', '2026-11-19-a', 'stale'], ['confirm', '2026-11-19-a', 'snap1']]);
  } finally { s.close(); }
});

test('POST /__merge and POST /__catchup enforce same-origin and wire preview, confirm and catch-up', async () => {
  const calls = [];
  const s = await serve(fixture(), {
    clients: new Set(), transcript: [],
    mergePreviewClose: async (name) => { calls.push(['preview', name]); return { ok: true, preview: { name, snapshot: 'ms1' } }; },
    closeAndMerge: async (name, snap) => { calls.push(['merge', name, snap]); return snap === 'ms1' ? { ok: true } : { changed: true, preview: { name, snapshot: 'ms2' } }; },
    catchUpMerge: async (name) => { calls.push(['catchup', name]); return { ok: true, targetBranch: 'main' }; },
  });
  try {
    assert.equal((await postFrom(s, '/__merge', { name: '2026-11-19-a' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postFrom(s, '/__catchup', { name: '2026-11-19-a' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await (await postFrom(s, '/__merge', { name: '2026-11-19-a' })).json()).preview.snapshot, 'ms1');
    assert.equal((await (await postFrom(s, '/__merge', { name: '2026-11-19-a', snapshot: 'stale' })).json()).changed, true);
    assert.equal((await (await postFrom(s, '/__merge', { name: '2026-11-19-a', snapshot: 'ms1' })).json()).ok, true);
    assert.equal((await (await postFrom(s, '/__catchup', { name: '2026-11-19-a' })).json()).targetBranch, 'main');
    assert.deepEqual(calls, [['preview', '2026-11-19-a'], ['merge', '2026-11-19-a', 'stale'], ['merge', '2026-11-19-a', 'ms1'], ['catchup', '2026-11-19-a']]);
  } finally { s.close(); }
});

test('showMergeDialog omits ignored files and mentions untracked files only when present', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function showMergeDialog('), source.indexOf('async function startDiscard('));
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', children: [],
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    showModal() {}, close() {}, remove() {},
  });
  const dialogs = [];
  const doc = { createElement: node, body: { append(el) { dialogs.push(el); } } };
  const showMergeDialog = new Function('document', 'post', 'showCatchUpDialog', `${fn}\nreturn showMergeDialog;`)(doc, async () => ({ ok: true, json: async () => ({}) }), () => {});

  const texts = (el) => [el.textContent, ...el.children.flatMap(texts)].filter(Boolean);
  showMergeDialog('topic', { title: 'Merge worker/topic into main', commits: [{ hash: 'abc1234', subject: 'work' }], untracked: [], snapshot: 's1' }, false);
  const t1 = texts(dialogs[0]).join('\n');
  assert.ok(t1.includes('After merging, the worktree and branch will be removed and the discussion closed.'));
  assert.ok(!/ignored/i.test(t1));
  assert.ok(!/Untracked files/.test(t1));

  showMergeDialog('topic', { title: 'Merge worker/topic into main', commits: [{ hash: 'abc1234', subject: 'work' }], untracked: ['notes.tmp'], snapshot: 's2' }, false);
  const t2 = texts(dialogs[1]).join('\n');
  assert.ok(t2.includes('Untracked files in the worktree will be deleted for good: notes.tmp'));
  assert.ok(!/ignored/i.test(t2));
});

test('the Worker tab\'s stop buttons: /__stopworker reaches the room only from its page, with a known mode; each button asks to click again', async () => {
  const calls = [];
  const s = await serve(fixture(), { clients: new Set(), transcript: [], stopWorker: (mode) => { if (mode !== 'after' && mode !== 'now') throw new Error('Unknown stop'); calls.push(mode); } });
  try {
    assert.equal((await postFrom(s, '/__stopworker', { mode: 'after' })).status, 204);
    assert.equal((await postFrom(s, '/__stopworker', { mode: 'now' })).status, 204);
    assert.equal((await postFrom(s, '/__stopworker', { mode: 'now' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postFrom(s, '/__stopworker', { mode: 'later' })).status, 400);
    assert.deepEqual(calls, ['after', 'now']);
  } finally { s.close(); }
  const off = await serve(fixture(), { clients: new Set(), transcript: [] });
  try { assert.equal((await postFrom(off, '/__stopworker', { mode: 'now' })).status, 409); } finally { off.close(); }
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  assert.match(source, /confirmed\(\$\('wstop-after'\), \(\) => stopWorker\('after'\), 'Click again: [^']+', \(\) => true\)/);
  assert.match(source, /confirmed\(\$\('wstop-now'\), \(\) => stopWorker\('now'\), 'Click again: [^']+', \(\) => true\)/);
});

test('the stop buttons hide while peeking at another discussion or viewing a peer\'s, and come back at once on returning, before any room update', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', hidden: false, disabled: false, children: [], dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    get firstChild() { return this.children[0] || null; }, set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  });
  const els = {};
  const answers = [];
  const fetch = async (path) => (path === '__view' ? { ok: true, json: async () => answers.shift() } : { ok: false });
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'localStorage', 'fetch', 'send',
    'let tab = "work", replica = { node: "here", addresses: [], own: {}, received: [], peers: [{ name: "mac", reachable: true }], project: null }, localThinking = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'let attaching = false, pending = [], localMessages = [], localWorking = null, viewExpired = false, viewNotice = null, posting = 0;\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, notesGuard = (act) => act(), updateBusy = () => {}, busyFailed = () => {};\n' +
    'const talk = { clear() {}, add() {} }, viewClient = "c", setThinking = () => {}, status = () => {};\n' +
    code + '\n' +
    'return { setRoom, setPeeking, viewRemote };'
  )((id) => els[id] || (els[id] = node(id)), { createElement: node, title: '', querySelectorAll: () => [] }, { href: '' }, null, null, () => {}, (cb) => cb(), () => {},
    { getItem: () => null, setItem() {} }, fetch, () => {});
  const shown = () => !els.wstop.hidden;

  // The shown discussion's worker runs an instruction: the buttons show.
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-16-x', discussion: 'X', started: true, workerStop: { after: false, now: false } });
  assert.equal(shown(), true);
  // Peeking at a closed discussion (the reset event), and back: no room update in between.
  harness.setPeeking({ title: 'Closed one', doc: null });
  assert.equal(shown(), false);
  harness.setPeeking(null);
  assert.equal(shown(), true);
  // Viewing a peer's discussion, and back.
  answers.push({ viewing: { title: "Peer topic", discussion: "peer-topic", node: "mac", round: 3, messages: [] } });
  await harness.viewRemote({ discussion: 'peer-topic', node: 'mac' });
  assert.equal(shown(), false);
  answers.push({ viewing: null });
  await harness.viewRemote(null);
  assert.equal(shown(), true);
});

test('without a worker input (terminal mode), /__work is refused', async () => {
  const s = await serve(fixture(), { clients: new Set(), transcript: [] });
  assert.equal((await postFrom(s, '/__work', { text: 'hi' })).status, 409);
  s.close();
});

test('a new page gets the gauges; the former auto-summarize endpoint is gone', async () => {
  const gauges = [{ provider: 'claude', label: '5h', used: 20, resets: null }];
  const screen = { clients: new Set(), transcript: [], say: () => {}, quota: gauges };
  const s = await serve(fixture(), screen);
  try {
    assert.notEqual((await postFrom(s, '/__auto', { on: false })).status, 204);
    const next = eventReader(await s.get('/__events'));
    const reset = await next();
    assert.deepEqual([reset.auto, reset.quota], [undefined, gauges]);
    for (const c of screen.clients) c.end();
  } finally {
    s.close();
  }
});

test('a room serves only its sections of the root: discussions/ and proposal/, with transcripts as text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'root-test-'));
  mkdirSync(join(root, 'discussions', '2026-11-02-a', 'transcripts'), { recursive: true });
  mkdirSync(join(root, 'proposal'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'discussions', '2026-11-02-a', 'notes.md'), '# Notes');
  writeFileSync(join(root, 'discussions', '2026-11-02-a', 'transcripts', 'session-2026-11-02-1014.md'), '**B**\n\n<script>alert(1)</script>\n');
  writeFileSync(join(root, 'proposal', 'old.md'), '# Old');
  writeFileSync(join(root, 'src', 'code.mjs'), 'secret');
  const screen = { clients: new Set(), transcript: [], sections: ['discussions', 'proposal'] };
  const s = await serve(root, screen);
  try {
    assert.deepEqual(await (await s.get('/__files')).json(),
      ['discussions/2026-11-02-a/notes.md', 'discussions/2026-11-02-a/transcripts/session-2026-11-02-1014.md', 'proposal/old.md']);
    assert.match(await (await s.get('/discussions/2026-11-02-a/notes.md')).text(), /<h1>Notes<\/h1>/);
    const transcript = await (await s.get('/discussions/2026-11-02-a/transcripts/session-2026-11-02-1014.md')).text();
    assert.match(transcript, /&lt;script&gt;alert/);
    assert.doesNotMatch(transcript, /<script>alert/);
    assert.equal((await s.get('/src/code.mjs')).status, 404);
    assert.equal((await postFrom(s, '/__show', { file: 'src/code.mjs' })).status, 404);
    assert.equal((await postFrom(s, '/__show', { file: 'proposal/old.md' })).status, 204);
    assert.equal((await postFrom(s, '/__newroom', {})).status, 409); // only where the room offers it
  } finally {
    s.close();
  }
});

test('agent settings endpoint reads choices and protects saves with the same-origin check', async () => {
  let saved;
  const screen = { getSettings: () => ({ models: { claude: [], codex: [] } }), saveSettings: async (body) => {
    if (!body?.agents) throw new Error('Missing agents');
    saved = body; return { applied: false };
  } };
  const s = await serve(fixture(), screen);
  try {
    assert.deepEqual(await (await s.get('/__settings')).json(), { models: { claude: [], codex: [] } });
    const post = (body, origin = s.base) => fetch(s.base + '/__settings', { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    assert.equal((await post({ agents: [] }, 'http://elsewhere.test')).status, 403);
    assert.equal(saved, undefined);
    assert.equal((await post({})).status, 400);
    const res = await post({ agents: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { applied: false });
    assert.deepEqual(saved, { agents: [] });
    // Check the inline browser program parses as JavaScript, rather than only the server module.
    const html = await (await s.get('/__room')).text();
    new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
    // Over plain HTTP from another machine the browser has no crypto.randomUUID: the page still gets a client id.
    const idLine = html.match(/const viewClient = (.*);/)[1];
    const insecure = { getRandomValues: (a) => globalThis.crypto.getRandomValues(a) };
    const ids = [0, 1].map(() => new Function('crypto', `return ${idLine};`)(insecure));
    assert.match(ids[0], /^[0-9a-f]{32}$/);
    assert.notEqual(ids[0], ids[1]);
  } finally { s.close(); }
});

test('the heartbeat: /__health says it is agent-room, with its process, root and discussion', async () => {
  const dir = fixture();
  const screen = { clients: new Set(), transcript: [], startedAt: '2026-11-03T10:00:00.000Z', room: { active: 'discussions/2026-11-03-x' } };
  const s = await serve(dir, screen);
  const res = await s.get('/__health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { app: 'agent-room', pid: process.pid, root: dir, startedAt: '2026-11-03T10:00:00.000Z', discussion: 'discussions/2026-11-03-x', pages: 0 });
  s.close();
});

test('the heartbeat counts the room pages open on it, and stops counting a closed one', async () => {
  const screen = { clients: new Set(), transcript: [] };
  const s = await serve(fixture(), screen);
  try {
    const pages = async () => (await (await s.get('/__health')).json()).pages;
    const controller = new AbortController();
    const events = await fetch(s.base + '/__events', { signal: controller.signal });
    await eventReader(events)();
    assert.equal(await pages(), 1);
    controller.abort();
    for (let i = 0; i < 50 && screen.clients.size; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await pages(), 0);
  } finally { s.close(); }
});

test('a page learns its code version, so it can refresh after a reload that changed it', async () => {
  const screen = { clients: new Set(), transcript: [] };
  const s = await serve(fixture(), screen);
  const reset = await eventReader(await s.get('/__events'))();
  assert.match(reset.page, /^[0-9a-f]{12}$/);
  for (const c of screen.clients) c.end();
  s.close();
});

test('running rooms can be listed without changing the current conversation', async () => {
  const rooms = [{ id: 'other-0a1b2c', path: '/r/other-0a1b2c/__room', root: '/tmp/other', discussion: 'discussions/example', pages: 1, current: false }];
  const screen = { clients: new Set(), transcript: [], listRooms: async () => rooms };
  const s = await serve(fixture(), screen);
  try {
    const res = await s.get('/__rooms');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), rooms);
    assert.deepEqual(screen.transcript, []);
    screen.listRooms = async () => { throw new Error('Discovery failed'); };
    const failed = await s.get('/__rooms');
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), 'Discovery failed');
  } finally { s.close(); }
});

test('Open room in folder…: the page\'s request reaches the room, and a refused token answers 400', async () => {
  const bodies = [];
  const screen = { clients: new Set(), transcript: [], newRoom: async (body) => {
    bodies.push(body);
    if (body.token) throw Object.assign(new Error('this folder choice has expired or was already used: choose the folder again.'), { status: 400 });
    return { confirm: true, token: 't', folder: '/tmp/x' };
  } };
  const s = await serve(fixture(), screen);
  try {
    assert.deepEqual(await (await postFrom(s, '/__newroom', {})).json(), { confirm: true, token: 't', folder: '/tmp/x' });
    const refused = await postFrom(s, '/__newroom', { token: 'made-up' });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /choose the folder again/);
    assert.equal((await postFrom(s, '/__newroom', { token: 't' }, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(bodies, [{}, { token: 'made-up' }]);
  } finally {
    s.close();
  }
});

// Attachments: a room root with one started discussion, and a page that sends files with a message.
const b64 = (text) => Buffer.from(text).toString('base64');
function attachRoom(say = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'attach-test-'));
  mkdirSync(join(root, 'discussions', '2026-11-10-topic'), { recursive: true });
  const said = [];
  const screen = { clients: new Set(), transcript: [], room: { active: 'discussions/2026-11-10-topic', brainstorm: false },
    say: (line, confirmed) => { said.push(line); return say(line, confirmed); } };
  return { root, said, screen, files: join(root, 'discussions', '2026-11-10-topic', 'files') };
}

test('attachments never overwrite: a taken name is saved as name-2.ext, name-3.ext, …', () => {
  const folder = join(mkdtempSync(join(tmpdir(), 'attach-test-')), 'files'); // created if missing
  assert.deepEqual(saveAttachments(folder, [{ name: 'sketch.png', data: b64('one') }]), ['sketch.png']);
  assert.deepEqual(saveAttachments(folder, [{ name: 'sketch.png', data: b64('two') }, { name: 'sketch.png', data: b64('three') }, { name: 'notes', data: b64('n') }]),
    ['sketch-2.png', 'sketch-3.png', 'notes']);
  assert.deepEqual(saveAttachments(folder, [{ name: '../notes', data: b64('n2') }]), ['notes-2']); // only the base name counts
  assert.equal(readFileSync(join(folder, 'sketch.png'), 'utf8'), 'one');
  assert.equal(readFileSync(join(folder, 'sketch-3.png'), 'utf8'), 'three');
  assert.deepEqual(readdirSync(folder).sort(), ['notes', 'notes-2', 'sketch-2.png', 'sketch-3.png', 'sketch.png']);
});

test('a message with attachments: the files are saved in files/ and their paths appended to the text', async () => {
  const { root, said, screen, files } = attachRoom();
  const s = await serve(root, screen);
  try {
    assert.equal((await postFrom(s, '/__say', { text: 'look', files: [{ name: 'a.txt', data: b64('A') }, { name: 'a.txt', data: b64('B') }] })).status, 204);
    assert.deepEqual(said, ['look\n\nAttached: files/a.txt, files/a-2.txt']);
    assert.equal(readFileSync(join(files, 'a-2.txt'), 'utf8'), 'B');
    assert.equal((await postFrom(s, '/__say', { text: '', files: [{ name: 'b.txt', data: b64('C') }] })).status, 204); // files alone
    assert.equal(said[1], 'Attached: files/b.txt');
  } finally {
    s.close();
  }
});

test('attachments over 25 MB are refused, and nothing is saved or sent', async () => {
  const { root, said, screen, files } = attachRoom();
  const s = await serve(root, screen);
  try {
    const big = Buffer.alloc(ATTACH_LIMIT + 1).toString('base64');
    assert.throws(() => saveAttachments(files, [{ name: 'big.bin', data: big }]), /over 25 MB/);
    const res = await postFrom(s, '/__say', { text: 'hi', files: [{ name: 'ok.txt', data: b64('fine') }, { name: 'big.bin', data: big }] });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /big\.bin is over 25 MB.*Nothing was sent/);
    assert.deepEqual(said, []);
    assert.deepEqual(existsSync(files) ? readdirSync(files) : [], []);
    // Exactly 25 MB is accepted.
    assert.deepEqual(saveAttachments(files, [{ name: 'max.bin', data: Buffer.alloc(ATTACH_LIMIT).toString('base64') }]), ['max.bin']);
  } finally {
    s.close();
  }
});

test('if any attachment fails to save, or the message is not taken, nothing is sent and nothing stays saved', async () => {
  // A save that fails part way: the second file's name is too long to write.
  const { root, said, screen, files } = attachRoom();
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, 'first.txt'), 'old');
  const s = await serve(root, screen);
  try {
    const res = await postFrom(s, '/__say', { text: 'hi', files: [{ name: 'first.txt', data: b64('1') }, { name: 'x'.repeat(300) + '.txt', data: b64('2') }] });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Couldn't save the attachments.*Nothing was sent/);
    assert.deepEqual(said, []);
    assert.deepEqual(readdirSync(files), ['first.txt']); // first-2.txt removed, the old file untouched
    assert.equal(readFileSync(join(files, 'first.txt'), 'utf8'), 'old');
  } finally {
    s.close();
  }
  // The room refuses the message (a warning): the saved files are removed.
  const refused = attachRoom(() => 'Not now.');
  const r = await serve(refused.root, refused.screen);
  try {
    const res = await postFrom(r, '/__say', { text: 'hi', files: [{ name: 'x.txt', data: b64('x') }] });
    assert.equal(res.status, 409);
    assert.deepEqual(readdirSync(refused.files), []);
    // A brainstorm, a discussion not started yet, or a command: refused before anything is saved.
    for (const [room, text] of [[{ active: null, brainstorm: true }, 'hi'], [{ active: null, brainstorm: false }, 'hi'], [refused.screen.room, '/summary']]) {
      refused.screen.room = room;
      assert.notEqual((await postFrom(r, '/__say', { text, files: [{ name: 'y.txt', data: b64('y') }] })).status, 204);
    }
    assert.deepEqual(readdirSync(refused.files), []);
    assert.deepEqual(refused.said, ['hi\n\nAttached: files/x.txt']); // offered once, refused
  } finally {
    r.close();
  }
});

test('the page keeps the text and the attachments when sending them fails, and clears them once sent', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const ATTACH_LIMIT = 25'), source.indexOf('async function send(text)'));
  const node = () => ({ replaceChildren() {}, append() {} });
  const els = { attachments: node(), attach: {}, 'attach-input': {} };
  const box = { value: '  see these  ' }, errors = [], posted = [];
  let answer = { ok: false, text: async () => "Couldn't save the attachments: disk full. Nothing was sent." };
  class FileReader { readAsDataURL(f) { this.result = 'data:;base64,' + Buffer.from(f.body).toString('base64'); this.onload(); } }
  const page = new Function('$', 'box', 'room', 'ended', 'status', 'post', 'document', 'FileReader',
    'let pending = [], attaching = false;' + code + '; return { add: (f) => { pending.push(...f); }, pending: () => pending, sendWithFiles };')(
    (id) => els[id], box, { active: 'discussions/x' }, false, (text, error) => error && errors.push(text),
    async (path, body) => { posted.push(body); return answer; }, { createElement: node, createTextNode: () => ({}) }, FileReader);
  page.add([{ name: 'a.txt', size: 1, body: 'A' }, { name: 'b.txt', size: 1, body: 'B' }]);
  await page.sendWithFiles();
  assert.deepEqual(posted, [{ text: 'see these', files: [{ name: 'a.txt', data: b64('A') }, { name: 'b.txt', data: b64('B') }] }]);
  assert.match(errors[0], /Nothing was sent/);
  assert.equal(box.value, '  see these  ');
  assert.equal(page.pending().length, 2);
  // Over 25 MB: refused on the page, before anything is sent.
  page.add([{ name: 'big.bin', size: ATTACH_LIMIT + 1, body: '' }]);
  await page.sendWithFiles();
  assert.equal(posted.length, 1);
  assert.match(errors[1], /big\.bin is over 25 MB/);
  page.pending().pop();
  answer = { ok: true };
  await page.sendWithFiles();
  assert.equal(box.value, '');
  assert.deepEqual(page.pending(), []);
});

test('a brainstorm message with attachments saves into brainstorms/<name>/files/ and appends their paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'attach-brainstorm-test-'));
  mkdirSync(join(root, 'brainstorms', '2026-11-20-idea'), { recursive: true });
  const said = [];
  const screen = { clients: new Set(), transcript: [], room: { active: 'brainstorms/2026-11-20-idea', brainstorm: true },
    say: (line) => { said.push(line); } };
  const files = join(root, 'brainstorms', '2026-11-20-idea', 'files');
  const s = await serve(root, screen);
  try {
    assert.equal((await postFrom(s, '/__say', { text: 'look', files: [{ name: 'sketch.png', data: b64('img1') }, { name: 'sketch.png', data: b64('img2') }] })).status, 204);
    assert.deepEqual(said, ['look\n\nAttached: files/sketch.png, files/sketch-2.png']);
    assert.equal(readFileSync(join(files, 'sketch.png'), 'utf8'), 'img1');
    assert.equal(readFileSync(join(files, 'sketch-2.png'), 'utf8'), 'img2');
    // Without a started folder, attachments are still refused.
    screen.room = { active: null, brainstorm: true };
    const refused = await postFrom(s, '/__say', { text: 'early', files: [{ name: 'a.txt', data: b64('A') }] });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /started discussion or brainstorm.*Nothing was sent/);
  } finally {
    s.close();
  }
});

test('the attach row (and pointing chips) is shown for a brainstorm, and the attach button stays disabled before its first message', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const viewCode = source.slice(source.indexOf('function updateReplicaView()'), source.indexOf('async function remoteFiles()'));
  const attachCode = source.slice(source.indexOf('const ATTACH_LIMIT = 25'), source.indexOf('$(\'attach\').onclick'));
  const node = (tag = 'div') => ({
    tag, hidden: false, disabled: false, title: '', textContent: '', dataset: {}, style: {}, children: [],
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
  });
  const els = {};
  const $ = (id) => els[id] || (els[id] = node(id));
  const harness = new Function('$', 'document', 'box',
    'let room = null, viewing = null, peeking = null, localInput = true, attaching = false, pending = [], viewExpired = false, viewNotice = null, localThinking = null, localWorking = null, replica = { node: "local", own: {}, received: [] };\n' +
    'const updateDiscWorkers = () => {}, renderWorkerStop = () => {}, updateReplicaHeader = () => {}, renderAutoDev = () => {}, updateCloseButton = () => {}, talkStatus = () => "", receivedTime = () => "", currentTitle = () => "", updateTabTitle = () => {}, displayTitle = (n, t) => t || n || "";\n' +
    viewCode + '\n' + attachCode + '\n' +
    'return { update: (r, v = null, p = null) => { room = r; viewing = v; peeking = p; updateReplicaView(); } };'
  )($, { createElement: node, createTextNode: () => ({}) }, node('textarea'));

  // No room: hidden.
  harness.update(null);
  assert.equal($('attach-row').hidden, true);

  // Unstarted brainstorm: row (and pointing chips) shown, attach button disabled.
  harness.update({ active: null, brainstorm: true, discussion: 'New brainstorm', started: true });
  assert.equal($('attach-row').hidden, false);
  assert.equal($('attach').disabled, true);
  assert.match($('attach').title, /brainstorm/);

  // Started brainstorm: row shown, attach button enabled.
  harness.update({ active: 'brainstorms/2026-11-20-idea', brainstorm: true, discussion: 'Idea', started: true });
  assert.equal($('attach-row').hidden, false);
  assert.equal($('attach').disabled, false);
  assert.match($('attach').title, /brainstorm's files\//);

  // Read-only (viewing or peeking): hidden.
  harness.update({ active: 'brainstorms/2026-11-20-idea', brainstorm: true, discussion: 'Idea', started: true }, { title: 'Remote', node: 'peer', round: 1, receivedAt: 0, discussion: 'd', commit: 'c' });
  assert.equal($('attach-row').hidden, true);
  harness.update({ active: 'brainstorms/2026-11-20-idea', brainstorm: true, discussion: 'Idea', started: true }, null, { title: 'Other', doc: null });
  assert.equal($('attach-row').hidden, true);
});

// Exercise the same member state and row code embedded in the screen, without a browser.
function memberFunctions() {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function memberPlan('), source.indexOf('function selectedSettings('));
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; this.value = ''; }
    append(child) { child.parentElement = this; this.children.push(child); }
    add(option) { this.children.push(option); }
    replaceChildren(...children) { this.children = children; }
    get options() { return this.children; }
  }
  const document = { createElement: (tag) => new Element(tag) };
  const Option = function (label, value) { this.label = label; this.value = value; };
  return new Function('document', 'Option', code + '; return { memberPlan, agentRow };')(document, Option);
}

test('member rows lock two checked boxes and keep the selected row order', () => {
  const { memberPlan, agentRow } = memberFunctions();
  const plan = memberPlan([{ provider: 'claude', name: 'Claude', model: '' }, { provider: 'codex', name: 'Codex', model: '' }], { name: 'Worker' });
  const parent = { append() {} }, controls = [];
  const refresh = () => controls.forEach((c) => c.refresh());
  plan.rows.forEach((a, i) => controls.push(agentRow(parent, a, { claude: [], codex: [], agy: [] }, 'Agent', {
    provider: (p) => plan.setProvider(i, p), name: (n) => plan.setName(i, n),
    toggle: (on) => plan.toggle(i, on), locked: () => plan.locked(i), refresh,
  })));
  const box = (i) => controls[i].row.children[0].children[0];
  assert.equal(controls.length, 3);
  assert.deepEqual(plan.rows.map((r) => [r.provider, r.name, r.active]), [['claude', 'Claude', true], ['codex', 'Codex', true], ['agy', 'Agy', false]]);
  assert.deepEqual(controls.map((_, i) => box(i).disabled), [true, true, false]);
  assert.equal(plan.toggle(0, false), false);
  box(2).checked = true; box(2).onchange();
  assert.deepEqual(controls.map((_, i) => box(i).disabled), [false, false, false]);
  box(0).checked = false; box(0).onchange();
  assert.deepEqual(controls.map((_, i) => box(i).disabled), [false, true, true]);
  assert.deepEqual(controls.filter((c) => c.active()).map((c) => c.get().name), ['Codex', 'Agy']);
});

test('automatic member names avoid rows and worker, while typed names stay editable', () => {
  const { memberPlan } = memberFunctions();
  const plan = memberPlan([{ provider: 'claude', name: 'Claude', model: '' }, { provider: 'codex', name: 'Codex', model: '' }], { name: 'Claude2' });
  plan.setProvider(1, 'claude');
  assert.equal(plan.rows[1].name, 'Claude3');
  plan.setName(1, 'My_name');
  plan.setProvider(1, 'agy');
  assert.equal(plan.rows[1].name, 'My_name');
  const duplicate = memberPlan([{ provider: 'claude', name: 'Claude', model: '' }, { provider: 'claude', name: 'Claude2', model: '' }, { provider: 'agy', name: 'Agy', model: '' }], { name: 'Worker' });
  duplicate.setProvider(2, 'claude');
  assert.equal(duplicate.rows[2].name, 'Claude3');
});

test('member panel keeps legacy agent lists intact rather than truncating them', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function selectedSettings('), source.indexOf("for (const scope of ['talk', 'work'])"));
  const select = new Function(code + '; return memberPanelAgents;')();
  for (const n of [1, 4, 8]) {
    const agents = Array.from({ length: n }, (_, i) => ({ name: 'A' + i }));
    assert.deepEqual(select({ settings: { agents }, defaults: { agents: [{ name: 'other' }, { name: 'next' }] }, started: true }), agents);
  }
  const launch = [{ name: 'FlagA' }, { name: 'FlagB' }];
  assert.equal(select({ settings: { agents: launch }, defaults: { agents: [{ name: 'SavedA' }, { name: 'SavedB' }] }, launchDefaults: { agents: launch }, started: true }), launch);
  assert.match(source, /This discussion has .* agents, set outside this panel; members can be chosen here only for 2 or 3/);
  assert.match(source, /At least two members\. To swap one, tick the new row first, then untick the old one\./);
});

test('the room header shows the folder basename, puts the full path in #replica-header with and without replication, and places #server-box and #peer-warning in #room-zone', async () => {
  const s = await serve(fixture(), { clients: new Set(), transcript: [] });
  const html = await (await s.get('/__room')).text();
  s.close();

  // #folder is gone from the header; #server-box and #peer-warning sit inside #room-zone, under the room name.
  assert.doesNotMatch(html, /id="folder"/);
  const header = html.slice(html.indexOf('<header id="header">'), html.indexOf('</header>'));
  const roomZone = header.slice(header.indexOf('<div id="room-zone"'), header.indexOf('<div id="disc-zone"'));
  const serverZone = header.slice(header.indexOf('<div id="server-zone"'));
  assert.match(roomZone, /id="room-menu"[\s\S]*id="replica-header"[\s\S]*id="server-box"[\s\S]*id="server-head"[\s\S]*id="server-menu"[\s\S]*id="server-details"[\s\S]*id="peer-warning"/);
  assert.doesNotMatch(serverZone, /id="server-box"|id="peer-warning"/);
  assert.match(serverZone, /aria-label="Monitoring"/);
  assert.match(html, /#room-zone \{ --zone: #5a7bd8; padding-inline: 1\.5rem; \}/);
  assert.match(html, /#server \{[^}]*color: light-dark\(#3d5fc4, #5a7bd8\);/);
  assert.match(html, /#server\[data-state="down"\] \{[^}]*color: #ef4444;/);
  assert.match(html, /\.quota:not\(:first-child\) \{ border-left: 1px solid var\(--line\); padding-left: \.5rem; \}/);

  // Exercise setRoom and updateReplicaHeader from the page script.
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const titleCode = source.slice(source.indexOf('function displayTitle('), source.indexOf('let subtab ='));
  const replicaCode = source.slice(source.indexOf('const receivedTime ='), source.indexOf('// The status under the title'));
  const roomCode = source.slice(source.indexOf('let room = null;\nfunction setRoom('), source.indexOf('// Settings stay outside'));
  const node = (tag = 'span') => ({ tag, textContent: '', title: '', hidden: false, dataset: {}, children: [],
    replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); } });
  const els = { 'room-name': node('b'), 'replica-header': node('span'), disc: node('span'), code: node('span') };
  const harness = new Function('$', 'document', 'location', 'viewing', 'renderAutoDev',
    'let replica = null;\n' + titleCode + '\n' + replicaCode + '\nfunction updateReplicaView() { updateReplicaHeader(); }\n' + roomCode +
    '\nreturn { setRoom, setReplica: (r) => { replica = r; updateReplicaHeader(); } };')(
    (id) => els[id], { createElement: (tag) => node(tag) }, { port: '5566' }, null, () => {});

  // Without replication: basename in the room menu title, full path as the first (monospace <code>) line of #replica-header.
  harness.setRoom({ folder: '/Users/fausto/Software/agent-room', discussion: 'Topic', active: 'discussions/2026-11-13-topic' });
  assert.equal(els['room-name'].textContent, 'agent-room');
  assert.deepEqual(els['replica-header'].children.map((c) => [c.tag, c.textContent]), [
    ['code', '/Users/fausto/Software/agent-room'],
  ]);

  // Trailing slash in folder still yields the basename, and replication adds its line below the full path.
  harness.setRoom({ folder: '/tmp/other-project/', discussion: 'Topic', active: 'discussions/2026-11-13-topic' });
  assert.equal(els['room-name'].textContent, 'other-project');
  harness.setReplica({ node: 'mac', addresses: ['127.0.0.1:5566'], own: { '2026-11-13-topic': { round: 4 } }, peers: [], project: { commit: 'abc123', dirty: false } });
  assert.deepEqual(els['replica-header'].children.map((c) => [c.tag, c.textContent]), [
    ['code', '/tmp/other-project/'],
    ['span', "mac 127.0.0.1:5566 · mac's line, round 4 · agents run on mac · Project abc123"],
  ]);
});

test('room checkout: docFiles, servable, unknown text files as plain text, gitignored/binary files handling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\nbuild/\n');
  writeFileSync(join(root, 'README.md'), '# Hello World\n');
  writeFileSync(join(root, 'config.json'), '{"key": "value"}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.js'), 'console.log("hi");\n');
  writeFileSync(join(root, 'ignored.txt'), 'secret ignored\n');
  writeFileSync(join(root, '.hidden'), 'hidden\n');
  mkdirSync(join(root, 'discussions', '2026-11-13-topic'), { recursive: true });
  writeFileSync(join(root, 'discussions', 'README.md'), '# Discussions Readme\n');
  writeFileSync(join(root, 'discussions', '2026-11-13-topic', 'notes.md'), '# Notes\n');
  writeFileSync(join(root, 'app.icns'), Buffer.from([0, 0, 1, 0, 0, 0, 0, 0]));
  writeFileSync(join(root, 'zero.bin'), Buffer.from([65, 66, 0, 67]));
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'README.md', 'config.json', 'src/index.js', 'discussions/README.md', 'discussions/2026-11-13-topic/notes.md', 'app.icns', 'zero.bin']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'Initial commit']);

  assert.equal(roomBranch(root), 'main');
  const files = docFiles(root);
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('config.json'));
  assert.ok(files.includes('src/index.js'));
  assert.ok(files.includes('discussions/README.md'));
  assert.ok(files.includes('discussions/2026-11-13-topic/notes.md'));
  assert.ok(files.includes('app.icns'));
  assert.ok(files.includes('zero.bin'));
  assert.ok(!files.includes('ignored.txt'));
  assert.ok(!files.includes('.hidden'));

  assert.equal(isTextFile(join(root, 'src/index.js')), true);
  assert.equal(isTextFile(join(root, 'config.json')), true);
  assert.equal(isTextFile(join(root, 'app.icns')), false);
  assert.equal(isTextFile(join(root, 'zero.bin')), false);
  assert.equal(isViewable(join(root, 'app.icns')), false);
  assert.equal(isViewable(join(root, 'zero.bin')), false);
  assert.equal(isViewable(join(root, 'src/index.js')), true);
  assert.equal(isViewable(join(root, 'README.md')), true);

  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const listRes = await s.get('/__files');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(Array.isArray(list));

    const detailRes = await s.get('/__files?detail=1');
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.branch, 'main');
    assert.deepEqual(detail.unviewable.sort(), ['app.icns', 'zero.bin']);
    assert.ok(detail.files.includes('README.md'));

    const txtRes = await s.get('/src/index.js');
    assert.equal(txtRes.status, 200);
    assert.match(txtRes.headers.get('content-type'), /text\/plain; charset=utf-8/);
    assert.equal(await txtRes.text(), 'console.log("hi");\n');

    const mdRes = await s.get('/discussions/README.md');
    assert.equal(mdRes.status, 200);
    assert.match(mdRes.headers.get('content-type'), /text\/html/);
    assert.match(await mdRes.text(), /<h1>Discussions Readme<\/h1>/);

    assert.equal((await s.get('/ignored.txt')).status, 404);
    assert.equal((await s.get('/.hidden')).status, 404);

    assert.equal((await postFrom(s, '/__show', { file: 'src/index.js' })).status, 204);
    assert.equal((await postFrom(s, '/__show', { file: 'app.icns' })).status, 404);
    assert.equal((await postFrom(s, '/__show', { file: 'zero.bin' })).status, 404);
  } finally {
    s.close();
  }
});

test('right pane three tabs, header disc-workers, and docLabel behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'html-test-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text();
    assert.match(html, /id="list-panel"/);
    assert.match(html, /id="list-pane"/);
    assert.match(html, /id="list-split"/);
    assert.match(html, /id="list-toggle"/);
    assert.doesNotMatch(html, /id="tab-discussions"/);
    assert.doesNotMatch(html, /id="tab-brainstorms"/);
    assert.match(html, /id="tab-explorer"/);
    assert.match(html, /id="tab-document"/);
    assert.match(html, /id="explorer"/);
    assert.match(html, /id="pane"/);
    assert.match(html, /id="docpane"/);
    assert.match(html, /id="disc-workers"/);
    assert.doesNotMatch(html, /id="activity"/);
    assert.match(html, /#tab-explorer\.peeking::after/);
    assert.match(html, /\.explorer-bar/);
    assert.match(html, /\.peek-banner/);

    // Exercise updateDiscWorkers
    const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
    const titleCode = source.slice(source.indexOf('function displayTitle('), source.indexOf('let subtab ='));
    const workerCode = source.slice(source.indexOf('function updateDiscWorkers() {'), source.indexOf('function updateReplicaView() {'));
    const node = (tag = 'span') => ({
      tag, textContent: '', style: {}, children: [], hidden: false,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
    });
    const discWorkers = node('div');
    const fn = new Function('$', 'document', 'room', titleCode + '\n' + workerCode + '; return updateDiscWorkers;')((id) => id === 'disc-workers' ? discWorkers : null, { createElement: node }, {
      open: [
        { active: 'discussions/2026-11-13-topic-a', title: 'Topic A', working: true },
        { active: 'discussions/2026-11-13-topic-b', title: 'Topic B', working: false },
        { active: 'discussions/2026-11-13-topic-c', title: '2026-11-13-topic-c', working: 'W' },
      ],
    });
    fn();
    assert.equal(discWorkers.hidden, false);
    assert.equal(discWorkers.children.length, 2);
    assert.match(discWorkers.children[0].children[1], /Topic A · Worker is working/);
    assert.match(discWorkers.children[1].children[1], /topic c · Worker is working/);

    // Exercise docLabel
    const labelCode = source.slice(source.indexOf('function docLabel(file) {'), source.indexOf('function currentTitle() {'));
    const docLabelFn = new Function('replica', 'peek', 'room',
      'const isDiscussion = (name) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-/.test(name);\n' +
      'const SECTIONS = { archive: "Archived", deferred: "Deferred" };\n' +
      titleCode + '\n' + labelCode + '; return docLabel;')(null, null, null);
    assert.equal(docLabelFn(null), 'No document shown.');
    assert.equal(docLabelFn('README.md'), 'Room checkout · README.md');
    assert.equal(docLabelFn('src/index.js'), 'Room checkout · src/index.js');
    assert.equal(docLabelFn('discussions/2026-11-13-topic/notes.md'), 'topic · notes.md');
    assert.equal(docLabelFn('discussions/archive/2026-11-10-old/notes.md'), 'old · notes.md');
    assert.equal(docLabelFn('discussions/README.md'), 'Room checkout · discussions/README.md');
    assert.equal(docLabelFn('__received/2026-11-13-topic/peer1/abc123/notes.md'), 'topic · notes.md');
  } finally {
    s.close();
  }
});

test('peek lifecycle: tab indicator, banner, Back to current, revealDoc immunity, and active discussion change', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(cls) { s.add(cls); }, remove(cls) { s.delete(cls); }, contains(cls) { return s.has(cls); }
    };
  };
  const node = (tag = 'div') => ({
    tag, textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {},
    classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) {
      this.children = [node('div')];
    },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
  });
  const els = {
    'tab-discussions': node('button'),
    'tab-explorer': node('button'),
    'tab-document': node('button'),
    'discussions': node('div'),
    'explorer': node('div'),
    'document': node('div'),
    'discussions-pane': node('div'),
    'pane': node('div'),
    'docpane': node('div'),
    'current': node('span'),
    'feed': node('button'),
    'doc-menu': node('details'),
    'room-name': node('b'),
    'disc': node('span'),
    'code': node('span'),
    'disc-status': node('span'),
    'remote-view': node('div'),
    'composer': node('div'),
    'attach-row': node('div'),
    'disc-workers': node('div'),
    'replica-header': node('span'),
  };
  const document = { createElement: node, title: '' };
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {};\n' +
    code + '\n' +
    'return { ' +
    '  setRoom, updateTabs, renderExplorer, revealDoc, showDoc, ' +
    '  getPeek: () => peek, setPeek: (p) => { peek = p; updateTabs(); }, ' +
    '  getDoc: () => doc, getSubtab: () => subtab ' +
    '};'
  )(
    (id) => els[id] || (els[id] = node(id)), document, { href: '' }, null, null, () => {}, (cb) => cb(), () => {}
  );

  // Initialize room with active discussion
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-13-current', discussion: 'Current' });
  assert.equal(harness.getPeek(), null);
  assert.equal(els['tab-explorer'].classList.contains('peeking'), false);

  // Enter peek for another discussion
  harness.setPeek({ kind: 'local', path: 'discussions/2026-11-13-other', name: '2026-11-13-other', readonly: false });
  assert.equal(els['tab-explorer'].classList.contains('peeking'), true);

  // renderExplorer renders peek banner
  await harness.renderExplorer();
  const banner = els['pane'].children[0]?.children?.[0]; // inside #files container
  assert.ok(banner);
  assert.equal(banner.children[0].children[0].textContent, 'other');
  const backBtn = banner.children[1];
  assert.equal(backBtn.textContent, 'Back to current');

  // Show a doc from the peeked discussion
  harness.showDoc('discussions/2026-11-13-other/notes.md');
  assert.equal(harness.getDoc(), 'discussions/2026-11-13-other/notes.md');

  // Click Back to current
  backBtn.onclick();
  assert.equal(harness.getPeek(), null);
  assert.equal(els['tab-explorer'].classList.contains('peeking'), false);
  // Document keeps its file after Back to current
  assert.equal(harness.getDoc(), 'discussions/2026-11-13-other/notes.md');

  // Calling revealDoc() after Back to current must NOT re-enter peek
  harness.revealDoc();
  assert.equal(harness.getPeek(), null);
  assert.equal(els['tab-explorer'].classList.contains('peeking'), false);

  // Peeking again, then switching active discussion clears peek
  harness.setPeek({ kind: 'local', path: 'discussions/2026-11-13-other', name: '2026-11-13-other', readonly: false });
  assert.ok(harness.getPeek());
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-13-next', discussion: 'Next' });
  assert.equal(harness.getPeek(), null);
  assert.equal(els['tab-explorer'].classList.contains('peeking'), false);
});

test('Room checkout in Explorer lists root files including discussions/README.md and excludes dated discussions', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(cls) { s.add(cls); }, remove(cls) { s.delete(cls); }, contains(cls) { return s.has(cls); }
    };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {},
    classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) {
      this.children = [node('div')];
    },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
  });
  const els = {
    'tab-discussions': node('button'),
    'tab-explorer': node('button'),
    'tab-document': node('button'),
    'discussions': node('div'),
    'explorer': node('div'),
    'document': node('div'),
    'discussions-pane': node('div'),
    'pane': node('div'),
    'docpane': node('div'),
    'current': node('span'),
    'feed': node('button'),
    'doc-menu': node('details'),
    'room-name': node('b'),
    'disc': node('span'),
    'code': node('span'),
    'disc-status': node('span'),
    'remote-view': node('div'),
    'composer': node('div'),
    'attach-row': node('div'),
    'disc-workers': node('div'),
    'replica-header': node('span'),
  };
  const document = { createElement: node, title: '' };
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {};\n' +
    code + '\n' +
    'return { ' +
    '  setRoom, renderExplorer, ' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } ' +
    '};'
  )(
    (id) => els[id] || (els[id] = node(id)), document, { href: '' }, null, null, () => {}, (cb) => cb(), () => {}
  );

  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-13-current', discussion: 'Current' });
  harness.setFiles([
    'README.md',
    'discussions/README.md',
    'discussions/2026-11-13-current/notes.md',
    'discussions/archive/2026-11-10-old/notes.md',
    'discussions/deferred/2026-11-11-later/notes.md',
  ]);

  await harness.renderExplorer();
  const bar = els['pane'].firstChild.children.find((c) => c.className === 'explorer-bar');
  const btnRoot = bar.children.find((b) => b.textContent === 'Room checkout');
  assert.ok(btnRoot);
  btnRoot.onclick();
  await harness.renderExplorer();

  const filesContainer = els['pane'].firstChild;
  const topFiles = filesContainer.children.filter((c) => c.tag === 'button' && c.className === 'entry file').map((c) => c.textContent);
  const folders = filesContainer.children.filter((c) => c.tag === 'details' && c.className === 'inline-folder');

  assert.deepEqual(topFiles, ['README.md']);
  assert.deepEqual(folders.map((f) => f.children.find((c) => c.tag === 'summary')?.textContent), ['discussions/']);
  const discFolder = folders[0];
  const discFiles = discFolder.children.filter((c) => c.tag === 'button' && c.className === 'entry file').map((c) => c.textContent);
  const discSubfolders = discFolder.children.filter((c) => c.tag === 'details');
  assert.deepEqual(discFiles, ['README.md']);
  assert.deepEqual(discSubfolders, []);
});

test('Explorer marks the shown file with .shown and aria-current, and wraps levels with more than 10 files in .file-columns', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(cls) { s.add(cls); }, remove(cls) { s.delete(cls); }, contains(cls) { return s.has(cls); }
    };
  };
  const node = (tag = 'div') => {
    const attrs = new Map();
    return {
      tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {},
      classList: classListFor(),
      get firstChild() { return this.children[0] || null; },
      set innerHTML(html) {
        this.children = [node('div')];
      },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    };
  };
  const els = {
    'tab-discussions': node('button'),
    'tab-explorer': node('button'),
    'tab-document': node('button'),
    'discussions': node('div'),
    'explorer': node('div'),
    'document': node('div'),
    'discussions-pane': node('div'),
    'pane': node('div'),
    'docpane': node('div'),
    'current': node('span'),
    'feed': node('button'),
    'doc-menu': node('details'),
    'room-name': node('b'),
    'disc': node('span'),
    'code': node('span'),
    'disc-status': node('span'),
    'remote-view': node('div'),
    'composer': node('div'),
    'attach-row': node('div'),
    'disc-workers': node('div'),
    'replica-header': node('span'),
  };
  const document = { createElement: node, title: '' };
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {};\n' +
    code + '\n' +
    'return { ' +
    '  setRoom, showDoc, renderExplorer, ' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } ' +
    '};'
  )(
    (id) => els[id] || (els[id] = node(id)), document, { href: '' }, null, null, () => {}, (cb) => cb(), () => {}
  );

  // 10 root files + 12 files in src/: root files stay direct children; src/ files wrap in .file-columns
  const tenRootFiles = Array.from({ length: 10 }, (_, i) => `file-${String(i + 1).padStart(2, '0')}.md`);
  const twelveSrcFiles = Array.from({ length: 12 }, (_, i) => `src/mod-${String(i + 1).padStart(2, '0')}.mjs`);
  harness.setRoom({ folder: '/tmp/project', active: null, discussion: null });
  harness.setFiles([...tenRootFiles, ...twelveSrcFiles]);
  harness.showDoc('file-03.md');
  await harness.renderExplorer();

  let filesContainer = els['pane'].firstChild;
  assert.equal(filesContainer.children.some((c) => c.className === 'file-columns'), false);
  const rootButtons = filesContainer.children.filter((c) => c.tag === 'button');
  assert.equal(rootButtons.length, 10);
  const shownBtn = rootButtons.find((b) => b.textContent === 'file-03.md');
  assert.ok(shownBtn);
  assert.equal(shownBtn.className, 'entry file shown');
  assert.equal(shownBtn.classList.contains('shown'), true);
  assert.equal(shownBtn.getAttribute('aria-current'), 'true');
  assert.equal(shownBtn.children.length, 0);

  const otherBtn = rootButtons.find((b) => b.textContent === 'file-01.md');
  assert.equal(otherBtn.className, 'entry file');
  assert.equal(otherBtn.getAttribute('aria-current'), null);

  // Inside src/ (12 files > 10), files are wrapped in .file-columns
  const srcFolder = filesContainer.children.find((c) => c.tag === 'details' && c.className === 'inline-folder');
  assert.ok(srcFolder);
  const srcCols = srcFolder.children.find((c) => c.tag === 'div' && c.className === 'file-columns');
  assert.ok(srcCols);
  assert.equal(srcCols.children.length, 12);

  // With 11 root files (> 10), root files also wrap in .file-columns after the folder
  harness.setFiles([...tenRootFiles, 'file-11.md', ...twelveSrcFiles]);
  await harness.renderExplorer();
  filesContainer = els['pane'].firstChild;
  const rootCols = filesContainer.children.find((c) => c.tag === 'div' && c.className === 'file-columns');
  assert.ok(rootCols);
  assert.equal(rootCols.children.length, 11);
  assert.ok(filesContainer.children.indexOf( filesContainer.children.find((c) => c.tag === 'details')) < filesContainer.children.indexOf(rootCols));
});

test('Discussions tab: active discussions keep the User\'s order in localStorage, new ones on top, Move up / Move down', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(...c) { c.forEach((x) => s.add(x)); }, remove(...c) { c.forEach((x) => s.delete(x)); }, contains(cls) { return s.has(cls); }
    };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {},
    classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
  });
  const els = {};
  const store = new Map();
  const localStorage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) };
  let fetchAnswer = null;
  const fetch = async () => fetchAnswer();
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'localStorage', 'fetch',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, send = () => {};\n' +
    code + '\n' +
    'return { setRoom, renderDiscussions, openFiles, forgetOrder, ' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } };'
  )((id) => els[id] || (els[id] = node(id)), { createElement: node, title: '' }, { href: '' }, null, null, () => {}, (cb) => cb(), () => {}, localStorage, fetch);

  const KEY = 'agent-room.discussion-order:/tmp/project';
  const filesFor = (names) => ['discussions/README.md', ...names.map((n) => 'discussions/' + n + '/notes.md'), 'discussions/archive/2026-11-01-old/notes.md'];
  const rows = () => {
    const discSec = els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'discussions');
    return (discSec?.children ?? []).filter((c) => c.className.includes('discussion-row'));
  };
  const names = () => rows().map((r) => r.children.find((c) => c.className === 'discussion-block').children[0].title.replace('discussions/', ''));
  const menuButton = (name, label) => {
    const row = rows().find((r) => r.children.find((c) => c.className === 'discussion-block').children[0].title === 'discussions/' + name);
    return row.children.find((c) => c.tag === 'details').children[1].children.find((b) => b.textContent === label);
  };

  // An unloaded file list neither shows nor prunes the saved order.
  store.set(KEY, JSON.stringify(['2026-11-10-b', '2026-11-12-a']));
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-12-a', discussion: 'A', started: true });
  harness.renderDiscussions();
  assert.deepEqual(names(), []);
  assert.equal(store.get(KEY), JSON.stringify(['2026-11-10-b', '2026-11-12-a']));

  // A failed or malformed answer leaves the list unloaded and the order untouched.
  fetchAnswer = () => ({ ok: false, json: async () => ({ error: 'nope' }) });
  await harness.openFiles();
  fetchAnswer = () => ({ ok: true, json: async () => ({ files: 'nope' }) });
  await harness.openFiles();
  fetchAnswer = () => { throw new Error('offline'); };
  await harness.openFiles();
  assert.deepEqual(names(), []);
  assert.equal(store.get(KEY), JSON.stringify(['2026-11-10-b', '2026-11-12-a']));

  // Loaded: new discussions on top newest first, then the saved order; the current one keeps its place.
  fetchAnswer = () => ({ ok: true, json: async () => ({ files: filesFor(['2026-11-12-a', '2026-11-10-b', '2026-11-13-c', '2026-11-14-d']), branch: 'main' }) });
  await harness.openFiles();
  assert.deepEqual(names(), ['2026-11-14-d', '2026-11-13-c', '2026-11-10-b', '2026-11-12-a']);
  assert.equal(store.get(KEY), JSON.stringify(names()));
  assert.ok(rows()[3].className.includes('in-use'));

  // A later failure keeps the list shown and the order saved.
  fetchAnswer = () => ({ ok: false, json: async () => [] });
  await harness.openFiles();
  assert.deepEqual(names(), ['2026-11-14-d', '2026-11-13-c', '2026-11-10-b', '2026-11-12-a']);

  // Move up / Move down, disabled at the ends.
  assert.equal(menuButton('2026-11-14-d', 'Move up').disabled, true);
  assert.equal(menuButton('2026-11-14-d', 'Move down').disabled, false);
  assert.equal(menuButton('2026-11-12-a', 'Move down').disabled, true);
  menuButton('2026-11-12-a', 'Move up').onclick();
  assert.deepEqual(names(), ['2026-11-14-d', '2026-11-13-c', '2026-11-12-a', '2026-11-10-b']);
  menuButton('2026-11-14-d', 'Move down').onclick();
  assert.deepEqual(names(), ['2026-11-13-c', '2026-11-14-d', '2026-11-12-a', '2026-11-10-b']);
  assert.equal(store.get(KEY), JSON.stringify(names()));
  assert.ok(rows()[2].className.includes('in-use'));

  // A name gone from discussions/ is pruned; when it was moved out while open, it returns on top.
  harness.setFiles(filesFor(['2026-11-12-a', '2026-11-10-b', '2026-11-13-c']));
  harness.forgetOrder('2026-11-14-d');
  harness.renderDiscussions();
  assert.deepEqual(names(), ['2026-11-13-c', '2026-11-12-a', '2026-11-10-b']);
  assert.equal(store.get(KEY), JSON.stringify(names()));
  harness.setFiles(filesFor(['2026-11-12-a', '2026-11-10-b', '2026-11-13-c', '2026-11-14-d', '2026-11-09-e']));
  harness.renderDiscussions();
  assert.deepEqual(names(), ['2026-11-14-d', '2026-11-09-e', '2026-11-13-c', '2026-11-12-a', '2026-11-10-b']);

  // A moved discussion still in the saved list (moved and back before the list reloaded) also goes on top.
  harness.forgetOrder('2026-11-10-b');
  harness.renderDiscussions();
  assert.deepEqual(names(), ['2026-11-10-b', '2026-11-14-d', '2026-11-09-e', '2026-11-13-c', '2026-11-12-a']);

  // Archive and deferred stay newest first; the order is per room.
  harness.setRoom({ folder: '/tmp/other', active: null, discussion: null, started: true });
  harness.renderDiscussions();
  assert.deepEqual(names(), ['2026-11-14-d', '2026-11-13-c', '2026-11-12-a', '2026-11-10-b', '2026-11-09-e']);
  assert.ok(store.has('agent-room.discussion-order:/tmp/other'));
});

test('the Worker tab shows a merge preview collapsed, its outcome in the summary, and keeps it open across refreshes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'html-test-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text(); // the page as served, escapes resolved
    const code = html.slice(html.indexOf('function setWorkerInfo('), html.indexOf('function setWorking('));
    const node = (tag) => ({
      tag, textContent: '', dataset: {}, children: [], open: false,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      querySelectorAll() { const all = (n) => (n.children ?? []).flatMap((c) => [c, ...all(c)]); return all(this).filter((c) => c.tag === 'details' && c.open); },
    });
    const winfo = node('div'), wbox = {};
    const setWorkerInfo = new Function('$', 'document', 'wbox', code + '; return setWorkerInfo;')(() => winfo, { createElement: node }, wbox);
    const advice = 'Merge preview of worker/x into main (advice only: it can go stale, and a clean merge doesn\'t prove the combined code works)';
    const lines = ['worktree line', `${advice}: would conflict in a.txt, b.txt, c.txt.`];
    setWorkerInfo({ lines });
    const [plain, preview] = winfo.children;
    assert.equal(plain.tag, 'div'); assert.equal(plain.textContent, 'worktree line');
    assert.equal(preview.tag, 'details'); assert.equal(preview.open, false);
    assert.equal(preview.children[0].textContent, 'Merge preview of worker/x into main: would conflict in 3 files');
    assert.match(preview.children[1].textContent, /^would conflict in a\.txt, b\.txt, c\.txt\. \(advice only: /);
    preview.open = true;
    setWorkerInfo({ lines: [lines[0], `${advice}: would conflict in a.txt.`] });
    assert.equal(winfo.children[1].open, true);
    assert.equal(winfo.children[1].children[0].textContent, 'Merge preview of worker/x into main: would conflict in 1 file');
    setWorkerInfo({ lines: [`${advice}: clean.`] });
    assert.equal(winfo.children[0].children[0].textContent, 'Merge preview of worker/x into main: clean');

    // With lanes: each is collapsed under its summary, its lines (and its preview) inside.
    const lanes = [
      { own: true, summary: 'worker/x · 1 commit to review · would conflict in 3 files', lines },
      { own: false, summary: 'worker/y · nothing to review', lines: ['Worktree y'] },
    ];
    setWorkerInfo({ lines: [...lines, 'Worktree y'], lanes });
    assert.deepEqual(winfo.children.map((d) => [d.tag, d.open, d.children[0].textContent]),
      [['details', false, lanes[0].summary], ['details', false, lanes[1].summary]]);
    const inside = winfo.children[0].children[1].children;
    assert.equal(inside[0].textContent, 'worktree line');
    assert.equal(inside[1].tag, 'details');
    winfo.children[0].open = true; inside[1].open = true;
    setWorkerInfo({ lines: [...lines, 'Worktree y'], lanes: [{ ...lanes[0], summary: 'worker/x · 2 commits to review' }, lanes[1]] });
    assert.deepEqual(winfo.children.map((d) => d.open), [true, false]); // kept open across a refresh, by branch
    assert.equal(winfo.children[0].children[1].children[1].open, true);
  } finally {
    s.close();
  }
});

test('Discussions tab Resume: navigates directly to openHere.url via notesGuard when open, or sends /resume when closed', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const notesCode = source.slice(source.indexOf('function notesAsk('), source.indexOf('function setEditor('));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(cls) { s.add(cls); }, remove(cls) { s.delete(cls); }, contains(cls) { return s.has(cls); }
    };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', value: '', hidden: false, disabled: false, children: [], dataset: {}, style: {},
    classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children.at(-1) || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
  });
  const els = {};
  const $ = (id) => els[id] || (els[id] = node(id));
  const document = { createElement: node, title: '' };
  const location = { href: '/r/current-id/__room' };
  const sent = [];
  const notes = { open: false, list: [], id: null, base: '', editing: false, session: 0 };
  const noteText = $('notes-text');
  let openedNotes = 0;

  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'send', 'notes', 'noteText', 'openNotes',
    'let tab = "talk", replica = null, localThinking = "Claude", yourTurn = false, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {};\n' +
    'const notesDirty = () => notes.editing && noteText.value !== notes.base;\n' +
    code + '\n' +
    notesCode + '\n' +
    'return { setRoom, renderDiscussions, setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; }, setPeeking: (p) => { peeking = p; }, setWorker: ({ pending = null, merged = [] } = {}) => { workerPending = pending; workerMerged = new Set(merged); } };'
  )($, document, location, null, null, () => {}, (cb) => cb(), () => {}, (cmd) => sent.push(cmd), notes, noteText, () => { notes.open = true; openedNotes++; });

  harness.setFiles([
    'discussions/2026-11-15-current/notes.md',
    'discussions/2026-11-15-open/notes.md',
    'discussions/2026-11-15-unstarted/notes.md',
    'discussions/2026-11-14-closed/notes.md',
    'discussions/2026-11-13-paused/notes.md',
    'discussions/archive/2026-11-12-archived/notes.md',
    'discussions/archive/2026-11-11-archived-closed/notes.md',
    'discussions/deferred/2026-11-10-deferred/notes.md',
    'discussions/deferred/2026-11-09-deferred-closed/notes.md',
  ]);
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-15-current',
    discussion: 'Current',
    started: true,
    closedDiscussions: ['2026-11-14-closed', '2026-11-11-archived-closed', '2026-11-09-deferred-closed'],
    open: [
      { active: 'discussions/2026-11-15-current', title: 'Current', started: true, current: true, url: '/r/current-id/__room' },
      { active: 'discussions/2026-11-15-open', title: 'Open', started: true, current: false, url: '/r/open-id/__room' },
      { active: 'discussions/2026-11-15-unstarted', title: 'Unstarted', started: false, current: false, url: '/r/unstarted-id/__room' },
    ],
  });
  harness.renderDiscussions();

  const list = els['list-pane'].firstChild;
  const sectionOf = (key) => list.children.find((c) => c.dataset?.section === key);
  const rows = sectionOf('discussions').children.filter((c) => c.tag === 'div' && c.className.includes('discussion-row'));
  const rowFor = (name) => rows.find((r) => r.children.find((c) => c.className !== 'drag-handle')?.children?.[0]?.title === 'discussions/' + name); // active rows start with the drag handle
  const menuItems = (row) => row.children.find((c) => c.tag === 'details').children[1].children;
  const continueBtn = (name) => menuItems(rowFor(name)).find((c) => c.tag === 'button' && c.textContent === 'Continue');
  const resumeBtn = (name) => menuItems(rowFor(name)).find((c) => c.tag === 'button' && c.textContent === 'Resume');
  const label = (name) => rowFor(name).children.find((c) => c.className === 'discussion-block').children.find((c) => c.className === 'local-label').textContent;
  assert.equal(label('2026-11-15-current'), 'idle');
  assert.ok(rowFor('2026-11-15-current').className.includes('in-use'));
  assert.equal(label('2026-11-15-open'), 'idle');
  assert.equal(label('2026-11-15-unstarted'), 'not started');
  assert.equal(label('2026-11-14-closed'), 'closed');
  assert.equal(label('2026-11-13-paused'), 'idle');
  assert.ok(continueBtn('2026-11-15-open'));
  assert.ok(!resumeBtn('2026-11-15-open'));
  assert.ok(continueBtn('2026-11-13-paused'));
  assert.ok(!resumeBtn('2026-11-13-paused'));
  assert.ok(resumeBtn('2026-11-14-closed'));
  assert.ok(!continueBtn('2026-11-14-closed'));
  const moveButton = (name, label) => menuItems(rowFor(name)).find((c) => c.textContent === label);
  for (const action of ['Archive', 'Defer']) {
    assert.equal(moveButton('2026-11-13-paused', action).disabled, true);
    assert.match(moveButton('2026-11-13-paused', action).title, /Close the discussion/);
    assert.equal(moveButton('2026-11-14-closed', action).disabled, false);
  }
  const sectionRow = (name) => els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'archived-deferred').children
    .find((r) => r.className?.includes('discussion-row') && r.children[0].children[0].title.endsWith('/' + name));
  const sectionLabel = (name) => sectionRow(name).children[0].children.find((c) => c.className === 'local-label').textContent;
  assert.equal(sectionLabel('2026-11-12-archived'), 'archived');
  assert.equal(sectionLabel('2026-11-11-archived-closed'), 'archived · closed');
  assert.equal(sectionLabel('2026-11-10-deferred'), 'deferred');
  assert.equal(sectionLabel('2026-11-09-deferred-closed'), 'deferred · closed');
  assert.equal(menuItems(sectionRow('2026-11-12-archived'))[0]?.textContent, 'Continue');
  assert.equal(menuItems(sectionRow('2026-11-12-archived'))[0]?.title, 'Continue: makes it active first');
  assert.equal(menuItems(sectionRow('2026-11-11-archived-closed'))[0]?.textContent, 'Resume');
  assert.equal(menuItems(sectionRow('2026-11-11-archived-closed'))[0]?.title, 'Resume: makes it active first');
  assert.equal(menuItems(sectionRow('2026-11-10-deferred'))[0]?.textContent, 'Continue');
  assert.equal(menuItems(sectionRow('2026-11-09-deferred-closed'))[0]?.textContent, 'Resume');

  // 1. Open discussion, clean notes: Continue (or clicking the row) navigates straight to openHere.url during a round without sending /resume.
  continueBtn('2026-11-15-open').onclick();
  assert.equal(location.href, '/r/open-id/__room');
  assert.deepEqual(sent, []);

  // 2. Open discussion, unsaved note in Notes: notesGuard asks before navigating.
  location.href = '/r/current-id/__room';
  notes.editing = true;
  notes.base = 'saved body';
  noteText.value = 'My draft';
  continueBtn('2026-11-15-open').onclick();
  assert.equal(location.href, '/r/current-id/__room');
  assert.equal(openedNotes, 1);
  assert.equal(els['notes-ask'].hidden, false);
  assert.equal(els['notes-ask-text'].textContent, '"My draft" has unsaved changes.');

  // Keep editing cancels the navigation and leaves the unsaved note intact.
  const keepBtn = els['notes-ask-buttons'].children.find((b) => b.textContent === 'Keep editing');
  keepBtn.onclick();
  assert.equal(els['notes-ask'].hidden, true);
  assert.equal(location.href, '/r/current-id/__room');
  assert.equal(noteText.value, 'My draft');

  // Discard changes resets the note and completes the navigation to openHere.url.
  continueBtn('2026-11-15-open').onclick();
  const discardBtn = els['notes-ask-buttons'].children.find((b) => b.textContent === 'Discard changes');
  discardBtn.onclick();
  assert.equal(els['notes-ask'].hidden, true);
  assert.equal(noteText.value, 'saved body');
  assert.equal(location.href, '/r/open-id/__room');
  assert.deepEqual(sent, []);

  // 3. Closed discussion: Resume still sends /resume <name>.
  location.href = '/r/current-id/__room';
  resumeBtn('2026-11-14-closed').onclick();
  assert.equal(location.href, '/r/current-id/__room');
  assert.deepEqual(sent, ['/resume 2026-11-14-closed']);

  // 4. While peeking, the current discussion offers Back to this discussion in its menu (and clicking its row leaves peek).
  const freshRow = (name) => els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'discussions').children
    .filter((c) => c.tag === 'div' && c.className?.includes('discussion-row'))
    .find((r) => r.children.find((c) => c.className === 'discussion-block')?.children[0].title === 'discussions/' + name);
  harness.setPeeking({ name: '2026-11-14-closed', title: '2026-11-14-closed' });
  harness.renderDiscussions();
  const backItem = menuItems(freshRow('2026-11-15-current')).find((c) => c.tag === 'button' && c.textContent === 'Back to this discussion');
  assert.ok(backItem);
  backItem.onclick();
  assert.deepEqual(sent, ['/resume 2026-11-14-closed', '/peek']);
  harness.setPeeking(null);
  harness.renderDiscussions();
  assert.ok(!menuItems(freshRow('2026-11-15-current')).some((c) => c.tag === 'button' && c.textContent === 'Back to this discussion'));

  // 5. Closing phases: waiting shows Cancel close; writing hides Cancel close; header status follows active discussion.
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-15-current',
    discussion: 'Current',
    started: true,
    closingDiscussions: {
      '2026-11-15-current': 'waiting',
      '2026-11-12-archived': 'waiting',
      '2026-11-10-deferred': 'writing',
    },
    open: [{ active: 'discussions/2026-11-15-current', title: 'Current', started: true, current: true, url: '/r/current-id/__room' }],
  });
  harness.renderDiscussions();
  assert.equal(els['disc-status'].textContent, 'closing · waiting for worker');
  assert.equal(freshRow('2026-11-15-current').children.find((c) => c.className === 'discussion-block').children.find((c) => c.className === 'local-label').textContent, 'ongoing · closing · waiting for worker');
  assert.ok(freshRow('2026-11-15-current').children.some((c) => c.tag === 'button' && c.textContent === 'Cancel close'));
  assert.equal(sectionLabel('2026-11-12-archived'), 'archived · closing · waiting for worker');
  assert.ok(sectionRow('2026-11-12-archived').children.some((c) => c.tag === 'button' && c.textContent === 'Cancel close'));
  assert.equal(sectionLabel('2026-11-10-deferred'), 'deferred · closing · writing statement');
  assert.ok(!sectionRow('2026-11-10-deferred').children.some((c) => c.tag === 'button' && c.textContent === 'Cancel close'));

  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-15-current',
    discussion: 'Current',
    started: true,
    closingDiscussions: { '2026-11-15-current': 'writing' },
    open: [{ active: 'discussions/2026-11-15-current', title: 'Current', started: true, current: true, url: '/r/current-id/__room' }],
  });
  harness.renderDiscussions();
  assert.equal(els['disc-status'].textContent, 'closing · writing statement');
  assert.equal(freshRow('2026-11-15-current').children.find((c) => c.className === 'discussion-block').children.find((c) => c.className === 'local-label').textContent, 'ongoing · closing · writing statement');
  assert.ok(!freshRow('2026-11-15-current').children.some((c) => c.tag === 'button' && c.textContent === 'Cancel close'));

  // 6. Merged state across open, closed, archive and deferred rows: replaces "no changes", coexists with pending warning.
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-15-current',
    discussion: 'Current',
    started: true,
    closedDiscussions: ['2026-11-14-closed', '2026-11-11-archived-closed', '2026-11-09-deferred-closed'],
    open: [
      { active: 'discussions/2026-11-15-current', title: 'Current', started: true, current: true, url: '/r/current-id/__room' },
      { active: 'discussions/2026-11-15-open', title: 'Open', started: true, current: false, url: '/r/open-id/__room' },
    ],
  });
  harness.setWorker({
    pending: [{ lane: '2026-11-15-open', branch: 'worker/2026-11-15-open', ahead: 1, dirty: true }],
    merged: ['2026-11-15-current', '2026-11-15-open', '2026-11-14-closed', '2026-11-12-archived', '2026-11-11-archived-closed', '2026-11-09-deferred-closed'],
  });
  harness.renderDiscussions();
  const blockOf = (name) => freshRow(name).children.find((c) => c.className === 'discussion-block');
  const labelOf = (name) => blockOf(name).children.find((c) => c.className === 'local-label').textContent;
  const warningOf = (name) => blockOf(name).children.find((c) => c.className === 'worker-pending')?.textContent ?? null;
  assert.equal(labelOf('2026-11-15-current'), 'idle · merged');
  assert.equal(warningOf('2026-11-15-current'), null);
  assert.equal(labelOf('2026-11-15-open'), 'idle · merged');
  assert.equal(warningOf('2026-11-15-open'), '⚠ Worker: 1 commit not merged into main · uncommitted changes');
  assert.equal(labelOf('2026-11-14-closed'), 'closed · merged');
  assert.equal(labelOf('2026-11-13-paused'), 'idle · no changes');
  assert.equal(sectionLabel('2026-11-12-archived'), 'archived · merged');
  assert.equal(sectionLabel('2026-11-11-archived-closed'), 'archived · closed · merged');
  assert.equal(sectionLabel('2026-11-10-deferred'), 'deferred');
  assert.equal(sectionLabel('2026-11-09-deferred-closed'), 'deferred · closed · merged');

  harness.setWorker({ pending: null, merged: [] });
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-15-current', started: false, open: [] });
  harness.renderDiscussions();
  const current = els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'discussions').children.find((r) => r.className?.includes('discussion-row') && r.children.find((c) => c.className === 'discussion-block')?.children[0].title === 'discussions/2026-11-15-current');
  assert.equal(current.children.find((c) => c.className === 'discussion-block').children.find((c) => c.className === 'local-label').textContent, 'not started');
});

test('a started discussion\'s members panel lists the agents it started with, locked but for On, which enables or disables each', async () => {
  const root = mkdtempSync(join(tmpdir(), 'html-test-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text();
    const code = html.slice(html.indexOf('function agentRow('), html.indexOf('function selectedSettings('));
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; }
      append(...c) { for (const x of c) { if (typeof x === 'object') x.parentElement = this; this.children.push(x); } }
      add(o) { this.children.push(o); }
      replaceChildren(...c) { this.children = c; }
      get options() { return this.children; }
      querySelectorAll() { const all = (n) => n.children.flatMap((c) => typeof c === 'object' && c.tag ? [c, ...all(c)] : []); return all(this).filter((e) => e.tag === 'select' || (e.tag === 'input' && e.type !== 'checkbox')); }
    }
    const els = { 'talk-agent-rows': new El('div'), 'talk-settings-status': new El('p'), 'talk-member-note': new El('p') };
    const posted = [];
    let answer = { ok: true };
    const room = { started: true, members: [{ provider: 'claude', name: 'Claude', model: 'opus', enabled: true }, { provider: 'codex', name: 'Codex', model: '', enabled: false }] };
    const { renderMembers, setModels } = new Function('$', 'document', 'Option', 'room', 'settingsRows', 'post',
      'let membersModels = null;\n' + code + '; return { renderMembers, setModels: (m) => { membersModels = m; } };')(
      (id) => els[id], { createElement: (t) => new El(t) }, function (label, value) { this.label = label; this.value = value; }, room, { talk: [] },
      async (path, body) => { posted.push([path, body]); return answer; });
    setModels({ claude: [{ id: 'opus', label: 'Opus' }], codex: [], agy: [] });
    renderMembers();
    const rows = els['talk-agent-rows'].children;
    const parts = (row) => { const inputs = []; const walk = (n) => n.children.forEach((c) => { if (c.tag) { if (c.tag === 'input' || c.tag === 'select') inputs.push(c); walk(c); } }); walk(row); return inputs; };
    assert.equal(rows.length, 2);
    const [on1, provider1, name1, model1] = parts(rows[0]), [on2] = parts(rows[1]);
    assert.equal(on1.type, 'checkbox'); assert.equal(on1.checked, true); assert.equal(on2.checked, false);
    assert.equal(on1.disabled, true); // the only one enabled: can't be unticked
    assert.deepEqual([provider1.disabled, name1.disabled, model1.disabled], [true, true, true]);
    assert.equal(name1.value, 'Claude'); assert.equal(model1.value, 'opus');
    on2.checked = true; on2.onchange();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(posted, [['__agent-enabled', { name: 'Codex', enabled: true, member: true }]]);
    // A refused change puts the box back and says why.
    answer = { ok: false, text: async () => 'Wait.' };
    const again = parts(els['talk-agent-rows'].children[1])[0];
    again.checked = false; again.onchange();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(room.members[1].enabled, true);
    assert.match(els['talk-settings-status'].textContent, /Could not change Codex: Wait\./);
  } finally {
    s.close();
  }
});

test('Brainstorms tab: rows by title with their actions, and an order of their own (agent-room.brainstorm-order:<folder>), apart from the Discussions order', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return { toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(...c) { c.forEach((x) => s.add(x)); }, remove(...c) { c.forEach((x) => s.delete(x)); }, contains(cls) { return s.has(cls); } };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {}, classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  });
  const els = {}, store = new Map(), sent = [], location = { href: '' };
  const localStorage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) };
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'localStorage', 'fetch', 'send',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, ended = false, posting = 0, viewClient = "t", box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'let attaching = false, pending = [];\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, notesGuard = (act) => act(), status = () => {}, updateBusy = () => {}, busyFailed = () => {};\n' +
    code + '\n' +
    'return { setRoom, renderBrainstorms, renderDiscussions, forgetOrder, ' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } };'
  )((id) => els[id] || (els[id] = node(id)), { createElement: node, title: '' }, location, null, null, () => {}, (cb) => cb(), () => {}, localStorage, async () => ({ ok: false }),
    (line) => sent.push(line));

  const KEY = 'agent-room.brainstorm-order:/tmp/project', DKEY = 'agent-room.discussion-order:/tmp/project';
  const files = (brainstorms) => ['discussions/2026-11-10-d/notes.md', ...brainstorms.map((n) => 'brainstorms/' + n + '/transcripts/session.md')];
  const rows = () => els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'brainstorms').children.filter((c) => c.className.includes('discussion-row'));
  const block = (r) => r.children.find((c) => c.className === 'discussion-block');
  const titles = () => rows().map((r) => block(r).children[0].textContent);
  const row = (title) => rows().find((r) => block(r).children[0].textContent === title);
  const menuLabels = (title) => row(title).children.find((c) => c.tag === 'details').children[1].children.filter((b) => b.tag === 'button').map((b) => b.textContent);
  const action = (title, label) => row(title).children.find((c) => c.tag === 'details').children[1].children.find((b) => b.textContent.startsWith(label) || b.dataset.label === label);
  const click = (b) => b.onclick({ stopPropagation() {} });
  const open = [
    { url: '/r/x/__room', current: true, title: 'Current idea', active: 'brainstorms/2026-11-14-current', brainstorm: true, started: true },
    { url: '/r/x-d2/__room', current: false, title: 'Open idea', active: 'brainstorms/2026-11-13-open', brainstorm: true, started: true }];
  const checkpoints = [{ name: 'brainstorms/2026-11-12-closed', at: 'x', kind: 'full', title: 'Closed idea' }, { name: '2026-11-10-d', at: 'x', kind: 'full' }];
  harness.setRoom({ folder: '/tmp/project', active: 'brainstorms/2026-11-14-current', brainstorm: true, discussion: 'Current idea', started: true, multi: true, open, checkpoints });
  harness.setFiles(files(['2026-11-12-closed', '2026-11-13-open', '2026-11-14-current', '2026-11-11-untitled']));
  harness.renderDiscussions();
  harness.renderBrainstorms();

  // Rows by display title (without date), newest first at first.
  assert.deepEqual(titles(), ['Current idea', 'Open idea', 'Closed idea', 'untitled']);
  assert.equal(store.get(KEY), JSON.stringify(['2026-11-14-current', '2026-11-13-open', '2026-11-12-closed', '2026-11-11-untitled']));
  assert.equal(store.get(DKEY), JSON.stringify(['2026-11-10-d'])); // the Discussions order, apart
  assert.ok(row('Current idea').className.includes('in-use'));
  assert.ok(row('Closed idea').children.some((c) => c.className === 'drag-handle'));
  // Resume for a closed one, Go to for one open elsewhere, neither for the one shown (in the ⋯ menu).
  assert.ok(!menuLabels('Current idea').includes('Resume') && !menuLabels('Current idea').includes('Go to'));
  assert.ok(menuLabels('Open idea').includes('Go to'));
  assert.ok(menuLabels('Closed idea').includes('Resume'));
  click(action('Closed idea', 'Resume'));
  assert.equal(sent.at(-1), '/resume brainstorms/2026-11-12-closed');
  click(action('Open idea', 'Go to'));
  assert.equal(location.href, '/r/x-d2/__room');
  // The actions menu: Resume, Peek files, Close, Archive, Defer, Turn into a discussion, Start fresh, Delete, Move up / Move down.
  assert.deepEqual(menuLabels('Closed idea'), ['Resume', 'Peek files', 'Close', 'Archive', 'Defer', 'Turn into a discussion', 'Start fresh', 'Delete', 'Move up', 'Move down']);
  assert.equal(action('Current idea', 'Archive').disabled, true);
  assert.equal(action('Open idea', 'Defer').disabled, true);
  assert.equal(action('Closed idea', 'Archive').disabled, false);
  assert.equal(action('Closed idea', 'Defer').disabled, false);
  assert.equal(action('Closed idea', 'Close').disabled, true); // not open
  assert.equal(action('Open idea', 'Close').disabled, false);
  click(action('Open idea', 'Close'));
  assert.equal(sent.at(-1), '/close brainstorms/2026-11-13-open');
  // Delete: disabled while open (here or elsewhere); otherwise two clicks, the first one warning.
  assert.equal(action('Current idea', 'Delete').disabled, true);
  assert.equal(action('Open idea', 'Delete').disabled, true);
  assert.equal(action('Open idea', 'Delete').title, 'Close this brainstorm before deleting it');
  const del = action('Closed idea', 'Delete');
  assert.equal(del.disabled, false);
  const before = sent.length;
  click(del);
  assert.equal(sent.length, before);
  assert.equal(del.textContent, 'Click again: its folder (transcripts, drawings) and checkpoint are removed; uncommitted files are lost for good');
  click(del);
  assert.equal(sent.at(-1), '/delete brainstorms/2026-11-12-closed');
  // Turn into a discussion and Start fresh: two clicks too.
  for (const [label, line] of [['Turn into a discussion', '/convert brainstorms/2026-11-12-closed'], ['Start fresh', '/fresh brainstorms/2026-11-12-closed']]) {
    const b = action('Closed idea', label), n = sent.length;
    click(b); assert.equal(sent.length, n);
    click(b); assert.equal(sent.at(-1), line);
  }
  // Move up / Move down change only the Brainstorms order.
  assert.equal(action('Current idea', 'Move up').disabled, true);
  action('Current idea', 'Move down').onclick();
  assert.deepEqual(titles(), ['Open idea', 'Current idea', 'Closed idea', 'untitled']);
  action('untitled', 'Move up').onclick();
  assert.deepEqual(titles(), ['Open idea', 'Current idea', 'untitled', 'Closed idea']);
  assert.equal(store.get(KEY), JSON.stringify(['2026-11-13-open', '2026-11-14-current', '2026-11-11-untitled', '2026-11-12-closed']));
  assert.equal(store.get(DKEY), JSON.stringify(['2026-11-10-d']));
  // A new brainstorm goes on top; one turned into a discussion leaves this order only.
  harness.setFiles(files(['2026-11-12-closed', '2026-11-13-open', '2026-11-14-current', '2026-11-11-untitled', '2026-11-15-new']));
  harness.renderBrainstorms();
  assert.equal(titles()[0], 'new');
  harness.forgetOrder('2026-11-13-open', 'brainstorms');
  assert.ok(!JSON.parse(store.get(KEY)).includes('2026-11-13-open'));
  assert.equal(store.get(DKEY), JSON.stringify(['2026-11-10-d']));
});

test('displayTitle helper and UI titles hide YYYY-MM-DD- across rows, header, tab title, and peek/view', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return { toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(...c) { c.forEach((x) => s.add(x)); }, remove(...c) { c.forEach((x) => s.delete(x)); }, contains(cls) { return s.has(cls); } };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', disabled: false, hidden: false, children: [], dataset: {}, style: {}, classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  });
  const els = {}, document = { createElement: node, title: '' };
  const harness = new Function('$', 'document', 'location', 'renderAutoDev', 'requestAnimationFrame', 'setInterval',
    'let tab = "talk", replica = null, viewing = null, peeking = null, localThinking = null, localWorking = null, viewExpired = false, viewNotice = null, yourTurn = true, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane"), attaching = false, pending = [];\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, send = () => {}, notesGuard = (act) => act();\n' +
    code + '\n' +
    'return { displayTitle, setRoom, renderDiscussions, renderBrainstorms, showDoc, updateReplicaView,\n' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; },\n' +
    '  setReplica: (r) => { replica = r; },\n' +
    '  setPeeking: (p) => { peeking = p; updateReplicaView(); },\n' +
    '  setViewing: (v) => { viewing = v; updateReplicaView(); } };'
  )((id) => els[id] || (els[id] = node(id)), document, { href: '' }, () => {}, (cb) => cb(), () => {});

  // 1. displayTitle helper
  assert.equal(harness.displayTitle('2026-11-20-remove-date', 'Remove date from titles'), 'Remove date from titles');
  assert.equal(harness.displayTitle('2026-11-20-remove-date'), 'remove date');
  assert.equal(harness.displayTitle('2026-11-20-remove-date', ''), 'remove date');
  assert.equal(harness.displayTitle('2026-11-20-remove-date', null), 'remove date');
  assert.equal(harness.displayTitle('2026-11-20-remove-date', '2026-11-20-remove-date'), 'remove date');
  assert.equal(harness.displayTitle('2026-11-20-1014'), '1014');
  assert.equal(harness.displayTitle('1014'), '1014');
  assert.equal(harness.displayTitle('10-14'), '10 14');

  // 2. Discussion rows (active, archived, deferred, received from peers) and Brainstorm rows
  harness.setFiles([
    'discussions/2026-11-20-with-title/notes.md',
    'discussions/2026-11-19-same-as-folder/notes.md',
    'discussions/2026-11-18-no-checkpoint/notes.md',
    'discussions/archive/2026-11-17-old-one/notes.md',
    'discussions/deferred/2026-11-16-later-one/notes.md',
    'brainstorms/2026-11-20-current-idea/transcripts/session.md',
    'brainstorms/2026-11-19-open-idea/transcripts/session.md',
    'brainstorms/2026-11-18-closed-idea/transcripts/session.md',
  ]);
  harness.setReplica({
    node: 'Mac', addresses: ['127.0.0.1:5566'], own: {}, peers: [],
    received: [
      { discussion: 'd-1', node: 'Linux', commit: 'abc', round: 2, name: '2026-11-15-peer-topic', title: 'Peer Topic', local: null },
      { discussion: 'd-2', node: 'Linux', commit: 'def', round: 1, name: '2026-11-14-peer-raw', title: '2026-11-14-peer-raw', local: null },
    ],
  });
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-19-same-as-folder',
    discussion: '2026-11-19-same-as-folder', // resume path storing folder name as title
    started: true,
    open: [
      { active: 'discussions/2026-11-19-same-as-folder', title: '2026-11-19-same-as-folder', started: true, current: true, url: '/r/a/__room' },
      { active: 'brainstorms/2026-11-20-current-idea', title: 'Current Idea', started: true, current: false, url: '/r/b/__room' },
      { active: 'brainstorms/2026-11-19-open-idea', title: '2026-11-19-open-idea', started: true, current: false, url: '/r/c/__room' },
    ],
    checkpoints: [
      { name: '2026-11-20-with-title', at: 'x', kind: 'full', title: 'Saved Discussion Title' },
      { name: '2026-11-17-old-one', at: 'x', kind: 'full', title: 'Archived Title' },
      { name: 'brainstorms/2026-11-18-closed-idea', at: 'x', kind: 'full', title: 'Closed Idea' },
    ],
  });
  harness.renderDiscussions();
  harness.renderBrainstorms();

  const boardList = els['list-pane'].firstChild;
  const sectionRows = (key) => (boardList.children.find((c) => c.dataset?.section === key)?.children ?? [])
    .filter((c) => c.className?.includes('discussion-row'));
  const activeBtns = [...sectionRows('discussions'), ...sectionRows('peers')]
    .map((r) => r.children.find((c) => c.className === 'discussion-block').children[0])
    .map((b) => [b.textContent, b.title]);
  assert.deepEqual(activeBtns, [
    ['Saved Discussion Title', 'discussions/2026-11-20-with-title'],
    ['same as folder', 'discussions/2026-11-19-same-as-folder'],
    ['no checkpoint', 'discussions/2026-11-18-no-checkpoint'],
    ['Peer Topic', 'discussions/2026-11-15-peer-topic'],
    ['peer raw', 'discussions/2026-11-14-peer-raw'],
  ]);
  const sectionBtns = sectionRows('archived-deferred')
    .map((r) => r.children.find((c) => c.className === 'discussion-block').children[0])
    .map((b) => [b.textContent, b.title]);
  assert.deepEqual(sectionBtns, [
    ['Archived Title', 'discussions/archive/2026-11-17-old-one'],
    ['later one', 'discussions/deferred/2026-11-16-later-one'],
  ]);

  const brainRows = sectionRows('brainstorms')
    .map((r) => {
      const block = r.children.find((c) => c.className === 'discussion-block');
      return [block.children[0].textContent, block.children[0].title, block.children[1].textContent];
    });
  assert.deepEqual(brainRows, [
    ['Current Idea', 'brainstorms/2026-11-20-current-idea', 'idle'],
    ['open idea', 'brainstorms/2026-11-19-open-idea', 'idle'],
    ['Closed Idea', 'brainstorms/2026-11-18-closed-idea', 'closed'],
  ]);

  // 3. Header (#disc), browser tab title, and peek/view titles (including folder-name titles)
  assert.equal(els['disc'].textContent, 'same as folder');
  assert.equal(document.title, 'same as folder · agent-room');

  harness.showDoc('discussions/2026-11-20-with-title/notes.md');
  assert.equal(document.title, 'Saved Discussion Title · notes.md · agent-room');
  harness.showDoc(null);
  assert.equal(document.title, 'same as folder · agent-room');

  harness.setPeeking({ name: '2026-11-17-old-one', title: '2026-11-17-old-one', doc: null });
  assert.equal(els['disc'].textContent, 'old one');
  assert.equal(els['disc-status'].textContent, 'peeking at old one · read-only');
  assert.equal(document.title, 'old one · agent-room');
  assert.match(els['remote-view'].children[0].textContent, /^Peeking at old one\./);

  harness.setPeeking(null);
  harness.setViewing({ name: '2026-11-14-peer-raw', title: '2026-11-14-peer-raw', node: 'Linux', round: 1, discussion: 'd-2', commit: 'def' });
  assert.equal(els['disc'].textContent, 'peer raw');
  assert.equal(document.title, 'peer raw · agent-room');
  harness.setViewing(null);

  // Brainstorm grey status line uses the five states (no "current" or "open" word; current row stays highlighted)
  harness.setRoom({
    folder: '/tmp/project',
    active: 'brainstorms/2026-11-20-current-idea',
    brainstorm: true,
    discussion: 'Current Idea',
    started: true,
    open: [
      { active: 'brainstorms/2026-11-20-current-idea', title: 'Current Idea', started: true, current: true, url: '/r/b/__room' },
      { active: 'brainstorms/2026-11-19-open-idea', title: '2026-11-19-open-idea', started: true, current: false, url: '/r/c/__room' },
    ],
    checkpoints: [
      { name: 'brainstorms/2026-11-18-closed-idea', at: 'x', kind: 'full', title: 'Closed Idea' },
    ],
  });
  harness.renderBrainstorms();
  const currentBrainRowEls = (els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'brainstorms')?.children ?? [])
    .filter((c) => c.className?.includes('discussion-row'));
  assert.ok(currentBrainRowEls[0].className.includes('in-use'));
  const currentBrainRows = currentBrainRowEls.map((r) => {
    const block = r.children.find((c) => c.className === 'discussion-block');
    return [block.children[0].textContent, block.children[0].title, block.children[1].textContent];
  });
  assert.deepEqual(currentBrainRows, [
    ['Current Idea', 'brainstorms/2026-11-20-current-idea', 'idle'],
    ['open idea', 'brainstorms/2026-11-19-open-idea', 'idle'],
    ['Closed Idea', 'brainstorms/2026-11-18-closed-idea', 'closed'],
  ]);
});

test('while peeking a closed board, /__say (messages/attachments) and /__work are refused with 409 while /peek and /resume pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peek-guard-'));
  const said = [], worked = [];
  const screen = {
    clients: new Set(), transcript: [],
    room: { active: 'discussions/2026-11-20-live' },
    peek: { name: '2026-11-01-closed', ref: '2026-11-01-closed', path: 'discussions/2026-11-01-closed', kind: 'discussion', title: 'Closed', messages: [], doc: null },
    say: (t) => { said.push(t); },
    work: (t) => { worked.push(t); },
  };
  const s = await serve(root, screen);
  try {
    const r1 = await postFrom(s, '/__say', { text: 'hello wrong board' });
    assert.equal(r1.status, 409);
    assert.match(await r1.text(), /peeking/i);
    const r2 = await postFrom(s, '/__say', { text: 'note', files: [{ name: 'a.txt', data: Buffer.from('hi').toString('base64') }] });
    assert.equal(r2.status, 409);
    const r3 = await postFrom(s, '/__work', { text: 'run task on wrong board' });
    assert.equal(r3.status, 409);
    assert.match(await r3.text(), /peeking/i);
    assert.deepEqual(said, []);
    assert.deepEqual(worked, []);

    assert.equal((await postFrom(s, '/__say', { text: '/peek' })).status, 204);
    assert.equal((await postFrom(s, '/__say', { text: '/resume 2026-11-01-closed' })).status, 204);
    assert.deepEqual(said, ['/peek', '/resume 2026-11-01-closed']);
  } finally {
    s.close();
  }
});

test('List panel: collapsible sections, row click switches active or peeks closed (chat and files), and peeking disables both composers', async () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const workerInfoCode = source.slice(source.indexOf('let workerInfoShown ='), source.indexOf('// Mermaid for the Worker tab'));
  const classListFor = () => {
    const s = new Set();
    return { toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(...c) { c.forEach((x) => s.add(x)); }, remove(...c) { c.forEach((x) => s.delete(x)); }, contains(cls) { return s.has(cls); } };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', placeholder: '', disabled: false, hidden: false, open: false, children: [], dataset: {}, style: {}, classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  });
  const els = {}, sent = [], location = { href: '/r/live/__room' };
  const box = node('textarea'); box.placeholder = 'Message the agents';
  const wbox = node('textarea'); wbox.placeholder = 'Instructions for the worker';
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'send', 'box', 'wbox',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, ended = false, restarting = false;\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane"), attaching = false, pending = [];\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, notesGuard = (act) => act();\n' +
    'const BRAINSTORM_NO_WORK = "Turn this brainstorm into a discussion to send work.";\n' +
    'function setWorkerInfo(info) { if (!info) return; wbox.disabled = !!info.disabled; if (info.disabled) wbox.placeholder = info.lines[0]; }\n' +
    workerInfoCode + '\n' + code + '\n' +
    'return { setRoom, renderBoards, renderExplorer, setPeeking, updateReplicaView, showWorkerInfo, getPeek: () => peek, ' +
    '  setReplica: (r) => { replica = r; }, setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } };'
  )((id) => els[id] || (els[id] = node(id)), { createElement: node, title: '' }, location, null, null, () => {}, (cb) => cb(), () => {}, (cmd) => sent.push(cmd), box, wbox);

  harness.setFiles([
    'discussions/2026-11-20-live/notes.md',
    'discussions/2026-11-19-open/notes.md',
    'discussions/2026-11-18-closed/notes.md',
    'discussions/archive/2026-11-10-old/notes.md',
    'brainstorms/2026-11-17-open-b/transcripts/s.md',
    'brainstorms/2026-11-16-closed-b/transcripts/s.md',
  ]);
  harness.setReplica({ node: 'Mac', addresses: ['127.0.0.1:5566'], peers: [], own: {}, received: [{ discussion: 'd-peer', node: 'Linux', commit: 'abc', round: 2, name: '2026-11-15-peer', title: 'Peer Talk', local: false }] });
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-20-live',
    discussion: 'Live',
    started: true,
    closedDiscussions: ['2026-11-18-closed', '2026-11-10-old'],
    open: [
      { active: 'discussions/2026-11-20-live', title: 'Live', started: true, current: true, url: '/r/live/__room' },
      { active: 'discussions/2026-11-19-open', title: 'Open', started: true, current: false, url: '/r/open/__room' },
      { active: 'brainstorms/2026-11-17-open-b', title: 'Open B', started: true, current: false, url: '/r/open-b/__room' },
    ],
  });
  harness.renderBoards();

  // Default section folding and counts
  const sections = Object.fromEntries(els['list-pane'].firstChild.children.map((d) => [d.dataset.section, d]));
  assert.equal(sections['discussions'].open, true);
  assert.equal(sections['discussions'].children[0].textContent, 'Discussions (3)');
  assert.equal(sections['brainstorms'].open, true);
  assert.equal(sections['brainstorms'].children[0].textContent, 'Brainstorms (2)');
  assert.equal(sections['archived-deferred'].open, false);
  assert.equal(sections['archived-deferred'].children[0].textContent, 'Archived · Deferred (1)');
  assert.equal(sections['peers'].open, false);
  assert.equal(sections['peers'].children[0].textContent, 'Received from peers (1)');

  const findEntry = (secKey, path) => sections[secKey].children
    .filter((c) => c.className?.includes('discussion-row'))
    .map((r) => r.children.find((c) => c.className === 'discussion-block').children[0])
    .find((b) => b.title === path);

  // 4. Clicking an active discussion or open brainstorm switches to it directly (like Go to).
  findEntry('discussions', 'discussions/2026-11-19-open').onclick();
  assert.equal(location.href, '/r/open/__room');
  assert.deepEqual(sent, []);
  findEntry('brainstorms', 'brainstorms/2026-11-17-open-b').onclick();
  assert.equal(location.href, '/r/open-b/__room');
  assert.deepEqual(sent, []);

  // 5. Clicking a closed discussion or closed brainstorm peeks read-only (chat + files) without resuming.
  findEntry('discussions', 'discussions/2026-11-18-closed').onclick();
  assert.equal(sent.at(-1), '/peek 2026-11-18-closed');
  assert.equal(harness.getPeek()?.path, 'discussions/2026-11-18-closed');
  assert.equal(harness.getPeek()?.readonly, true);

  findEntry('archived-deferred', 'discussions/archive/2026-11-10-old').onclick();
  assert.equal(sent.at(-1), '/peek archive/2026-11-10-old');
  assert.equal(harness.getPeek()?.path, 'discussions/archive/2026-11-10-old');

  findEntry('brainstorms', 'brainstorms/2026-11-16-closed-b').onclick();
  assert.equal(sent.at(-1), '/peek brainstorms/2026-11-16-closed-b');
  assert.equal(harness.getPeek()?.path, 'brainstorms/2026-11-16-closed-b');
  assert.ok(!sent.some((s) => s.startsWith('/resume')));

  // 6. Entering peek disables both Discussion and Worker message boxes with notices, Back, and Resume.
  harness.setPeeking({ name: '2026-11-16-closed-b', ref: 'brainstorms/2026-11-16-closed-b', path: 'brainstorms/2026-11-16-closed-b', kind: 'brainstorm', title: 'Closed B', doc: null });
  harness.updateReplicaView();
  assert.equal(box.disabled, true);
  assert.equal(wbox.disabled, true);
  assert.equal(els['remote-view'].hidden, false);
  assert.equal(els['work-remote-view'].hidden, false);
  assert.match(els['remote-view'].children[0].textContent, /Read-only/);
  assert.match(els['work-remote-view'].children[0].textContent, /Read-only/);

  // Refreshing worker info while peeking must NOT re-enable wbox.
  harness.showWorkerInfo({ lines: ['branch worker/live'], disabled: false });
  assert.equal(wbox.disabled, true);

  // Explicit Resume and Back buttons in the peek banner
  const resumeBtn = els['remote-view'].children.find((c) => c.tag === 'button' && c.textContent === 'Resume');
  const backBtn = els['work-remote-view'].children.find((c) => c.tag === 'button' && c.textContent === 'Back');
  assert.ok(resumeBtn);
  assert.ok(backBtn);
  resumeBtn.onclick();
  assert.equal(sent.at(-1), '/resume brainstorms/2026-11-16-closed-b');
  backBtn.onclick();
  assert.equal(sent.at(-1), '/peek');

  // Leaving peek re-enables both composers and clears the synced Explorer peek.
  harness.setPeeking(null);
  harness.updateReplicaView();
  assert.equal(box.disabled, false);
  assert.equal(wbox.disabled, false);
  assert.equal(els['remote-view'].hidden, true);
  assert.equal(els['work-remote-view'].hidden, true);
  assert.equal(harness.getPeek(), null);
});

test('Side pane: two tabs (Explorer/Document), close/reopen, [[D4]] reopen, and split orientation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'side-pane-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text();
    assert.match(html, /id="main-panel"/);
    assert.match(html, /id="tab-explorer"/);
    assert.match(html, /id="tab-document"/);
    assert.doesNotMatch(html, /id="tab-notes"/);
    assert.doesNotMatch(html, /id="tab-terminal"/);
    assert.match(html, /id="split-orient"/);
    assert.match(html, /id="side-close"/);
    assert.match(html, /id="side-open"/);
    assert.match(html, /id="terminal-end"/);
    assert.doesNotMatch(html, /id="hostshell"/);
    assert.doesNotMatch(html, /id="notes-toggle"/);
    assert.match(html, /placeholder="Message to the agents…/);
    assert.match(html, /placeholder="Instruction to the worker…/);

    const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
    const dividerCode = source.slice(source.indexOf('// The dividers:'), source.indexOf('function message('));
    const subCode = source.slice(source.indexOf('let subtab ='), source.indexOf('function docLabel('));
    const refCode = source.slice(source.indexOf('// A [[D4]] in the chat:'), source.indexOf('// Moves the chips'));
    const classListFor = () => {
      const set = new Set();
      return { toggle(cls, v) { if (v === undefined ? !set.has(cls) : v) set.add(cls); else set.delete(cls); },
        add(...c) { c.forEach((x) => set.add(x)); }, remove(...c) { c.forEach((x) => set.delete(x)); }, contains(cls) { return set.has(cls); } };
    };
    const node = (tag = 'div') => ({
      tag, className: '', textContent: '', title: '', value: '', hidden: false, disabled: false, children: [], dataset: {},
      style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; }, getPropertyValue(k) { return this.props[k] || ''; } },
      attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      offsetWidth: 7, offsetHeight: 7, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      classList: classListFor(),
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      addEventListener() {}, focus() {},
    });
    const els = {};
    const $ = (id) => els[id] || (els[id] = node(id));
    const docListeners = {};
    const posted = [];
    const docFrame = { contentWindow: { postMessage: (msg, origin) => posted.push([msg, origin]) } };
    const document = {
      body: node('body'),
      documentElement: { clientWidth: 1200, clientHeight: 800 },
      createElement: node,
      getElementById: (id) => (id === 'doc' ? docFrame : els[id] || null),
      addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    };
    const store = new Map();
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const window = { addEventListener() {} };
    const harness = new Function('$', 'document', 'window', 'localStorage', 'location', 'requestAnimationFrame', 'post',
      'let viewing = null, room = { active: "discussions/2026-11-21-a" }, doc = "discussions/2026-11-21-a/notes.md";\n' +
      'const openFiles = async () => {}, pane = { querySelectorAll: () => [] }, expandedLines = new Set(), inDiscussion = () => false;\n' +
      dividerCode + '\n' + subCode + '\n' + refCode + '\n' +
      'return { setStacked, setSideClosed, showSub, selectSub, getSubtab: () => subtab, isSideClosed: () => sideClosed, isStacked: () => stacked };'
    )($, document, window, localStorage, { origin: 'http://127.0.0.1:5566' }, (cb) => cb(), async () => {});

    // 1. Switch between Explorer and Document.
    $('tab-document').onclick();
    assert.equal(harness.getSubtab(), 'document');
    assert.equal($('document').hidden, false);
    assert.equal($('explorer').hidden, true);
    $('tab-explorer').onclick();
    assert.equal(harness.getSubtab(), 'explorer');
    assert.equal($('explorer').hidden, false);
    assert.equal($('document').hidden, true);

    // 2. Close side pane with ✕: hides side pane, shows side-open; side-open restores last tab.
    $('side-close').onclick();
    assert.equal(harness.isSideClosed(), true);
    assert.equal($('main-panel').classList.contains('side-closed'), true);
    assert.equal($('side-open').hidden, false);
    $('side-open').onclick();
    assert.equal(harness.isSideClosed(), false);
    assert.equal(harness.getSubtab(), 'explorer');

    // 3. Clicking [[D4]] in chat while side pane is closed reopens it to Document and highlights D4.
    $('side-close').onclick();
    const refEl = { dataset: { ref: 'D4' } };
    for (const fn of docListeners.click) fn({ target: { closest: (sel) => (sel === '.ref[data-ref]' ? refEl : null) } });
    assert.equal(harness.isSideClosed(), false);
    assert.equal(harness.getSubtab(), 'document');
    assert.deepEqual(posted.at(-1), [{ type: 'agent-room:highlight', ref: 'D4', on: true }, 'http://127.0.0.1:5566']);

    // 4. Split orientation toggle switches between side-by-side and stacked and remembers in localStorage.
    assert.equal(harness.isStacked(), false);
    assert.equal($('split-orient').textContent || '⇅', '⇅');
    $('split-orient').onclick();
    assert.equal(harness.isStacked(), true);
    assert.equal($('main-panel').classList.contains('stacked'), true);
    assert.equal($('split').getAttribute('aria-orientation'), 'horizontal');
    assert.equal($('split-orient').textContent, '⇆');
    assert.equal(store.get('agent-room:split-orient'), 'stacked');
    $('split-orient').onclick();
    assert.equal(harness.isStacked(), false);
    assert.equal($('split').getAttribute('aria-orientation'), 'vertical');
    assert.equal($('split-orient').textContent, '⇅');
    assert.equal(store.get('agent-room:split-orient'), 'side');
  } finally {
    s.close();
  }
});

test('Services panel: Control bar services, half-window grid, list collapse/restore, Terminal fit & dot, My notes draft/guard, Discussion/Worker independence, and saved sizes preserved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'services-panel-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text();
    assert.match(html, /id="control-bar"/);
    assert.match(html, /id="ctrl-boards"/);
    assert.match(html, /id="ctrl-providers"/);
    assert.match(html, /id="ctrl-instructions"/);
    assert.match(html, /id="ctrl-schedule"/);
    assert.match(html, /id="ctrl-notes"[^>]*hidden/);
    assert.match(html, /id="ctrl-terminal"[^>]*hidden/);
    assert.match(html, /id="services-panel"[^>]*hidden/);
    assert.match(html, /id="services-close"/);
    assert.doesNotMatch(html, /id="main-page"/);
    assert.doesNotMatch(html, /id="tab-providers"/);
    assert.doesNotMatch(html, /id="tab-instructions"/);
    assert.doesNotMatch(html, /id="tab-notes"/);
    assert.doesNotMatch(html, /id="tab-terminal"/);

    // CSS grid places #services-panel between #control-bar and #list-panel at half width.
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    assert.match(style, /body\.service-open\s*\{[^}]*grid-template-columns:/);
    assert.match(style, /body\.service-open\.list-collapsed\s*\{[^}]*grid-template-columns:/);
    assert.match(style, /#ctrl-terminal\.running::after/);
    assert.ok(html.indexOf('id="control-bar"') < html.indexOf('id="services-panel"'));
    assert.ok(html.indexOf('id="services-panel"') < html.indexOf('id="list-panel"'));

    const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
    const ctrlCode = source.slice(source.indexOf('// Control bar & Services panel'), source.indexOf('// The Schedule page:'));
    const dividerCode = source.slice(source.indexOf('// The dividers:'), source.indexOf('function message('));
    const monitorCode = source.slice(source.indexOf('function providerName('), source.indexOf('function showMonitor('));
    const notesGuardCode = source.slice(source.indexOf('function notesAsk('), source.indexOf('function setEditor('));
    const classListFor = () => {
      const set = new Set();
      return { toggle(cls, v) { if (v === undefined ? !set.has(cls) : v) set.add(cls); else set.delete(cls); },
        add(...c) { c.forEach((x) => set.add(x)); }, remove(...c) { c.forEach((x) => set.delete(x)); }, contains(cls) { return set.has(cls); } };
    };
    const node = (tag = 'div') => ({
      tag, className: '', textContent: '', title: '', value: '', hidden: false, disabled: false, open: false, children: [], dataset: {},
      style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; }, getPropertyValue(k) { return this.props[k] || ''; } },
      attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      offsetWidth: 7, offsetHeight: 7, getBoundingClientRect: () => ({ width: 800, height: 600, left: 62, top: 0 }),
      classList: classListFor(),
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      get lastChild() { return this.children[this.children.length - 1] || null; },
      addEventListener() {}, focus() {}, scrollIntoView() {},
    });
    const els = {};
    const $ = (id) => els[id] || (els[id] = node(id));
    const document = {
      body: node('body'),
      documentElement: { clientWidth: 1400, clientHeight: 800 },
      createElement: node,
      getElementById: (id) => els[id] || null,
      addEventListener() {},
    };
    // Simulate #control-bar (62px), #services-panel (669px when open), and #main-panel narrowing to 540px while a service is open.
    $('control-bar').getBoundingClientRect = () => ({ width: 62, height: 600, left: 0, top: 0 });
    $('main-panel').getBoundingClientRect = () => ({ width: document.body.classList.contains('service-open') ? 540 : 1100, height: 600, left: 62, top: 0 });
    $('services-panel').getBoundingClientRect = () => ({ width: document.body.classList.contains('service-open') ? 669 : 0, height: 600, left: 62, top: 0 });
    const store = new Map([['agent-room:left', '620'], ['agent-room:list', '280']]);
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const winListeners = {};
    const window = { addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); } };
    const harness = new Function('$', 'document', 'window', 'localStorage', 'requestAnimationFrame', 'post',
      'let tab = "talk", subtab = "explorer", box = $("box"), wbox = $("wbox"), renderedProviders = 0, renderedInstructions = 0, fitCalls = 0, shellStarts = 0;\n' +
      'let hostShell = null, notes = { open: false, editing: false, base: "" }, noteText = $("notes-text");\n' +
      'const notesDirty = () => notes.editing && noteText.value !== notes.base;\n' +
      'const openNotes = () => { notes.open = true; };\n' +
      'const openHostShell = () => { shellStarts++; hostShell = { alive: true, fit: { fit: () => { fitCalls++; } }, term: { focus: () => {} } }; $("ctrl-terminal").classList.add("running"); };\n' +
      'const closeHostShell = () => { hostShell = null; $("ctrl-terminal").classList.remove("running"); };\n' +
      'const currentTitle = () => "WhatsApp UI", updateReplicaView = () => {}, providerHealth = () => ({ level: "amber", box: document.createElement("span") });\n' +
      'const renderProviders = () => { renderedProviders++; }, renderInstructions = () => { renderedInstructions++; };\n' +
      ctrlCode + '\n' + dividerCode + '\n' + monitorCode + '\n' + notesGuardCode + '\n' +
      'return { openService, showTab, setListCollapsed, providerName, notes, noteText, notesGuard, closeHostShell, getService: () => openServiceName, getHostShell: () => hostShell, getTab: () => tab, isSideClosed: () => sideClosed, isStacked: () => stacked, counts: () => ({ renderedProviders, renderedInstructions, fitCalls, shellStarts }) };'
    )($, document, window, localStorage, (cb) => cb(), async () => {});

    // Saved divider width (620px) is applied initially.
    assert.equal($('main-panel').style.getPropertyValue('--left'), '620px');
    assert.equal(document.body.style.getPropertyValue('--list'), '280px');

    // 1. Open Providers from Control bar: opens Services panel, collapses List panel (was open), leaves side pane open, clamps --left without overwriting localStorage.
    assert.equal(document.body.classList.contains('list-collapsed'), false);
    $('ctrl-providers').onclick();
    assert.equal(harness.getService(), 'providers');
    assert.equal(document.body.classList.contains('service-open'), true);
    assert.equal($('services-panel').hidden, false);
    assert.equal($('services-title').textContent, 'Providers');
    assert.equal($('providers').hidden, false);
    assert.equal($('instructions').hidden, true);
    assert.equal(document.body.classList.contains('list-collapsed'), true);
    assert.equal(store.get('agent-room:list-collapsed'), undefined); // temporary collapse does not overwrite saved preference
    assert.equal(harness.isSideClosed(), false); // Explorer/Document stays open
    assert.equal(harness.isStacked(), false); // not stacked automatically
    assert.equal($('main-panel').style.getPropertyValue('--left'), '273px'); // clamped to fit 540px board area
    assert.equal(store.get('agent-room:left'), '620'); // saved divider size is NOT overwritten
    assert.equal(store.get('agent-room:list'), '280'); // saved list size is NOT overwritten
    assert.equal($('ctrl-providers').classList.contains('on'), true);
    assert.equal($('ctrl-boards').classList.contains('on'), false);

    // 2. Clicking Discussion or Worker never closes the open service.
    $('tab-work').onclick();
    assert.equal(harness.getTab(), 'work');
    assert.equal(harness.getService(), 'providers');
    $('tab-talk').onclick();
    assert.equal(harness.getTab(), 'talk');
    assert.equal(harness.getService(), 'providers');

    // 3. Switch to My notes, make an unsaved edit, then switch to Terminal: hides My notes without asking and keeps edits.
    $('ctrl-notes').onclick();
    assert.equal(harness.getService(), 'notes');
    assert.equal($('notes').hidden, false);
    assert.equal($('providers').hidden, true);
    harness.notes.editing = true;
    harness.notes.base = 'saved';
    harness.noteText.value = 'unsaved edit';
    $('notes-ask').hidden = true;

    $('ctrl-terminal').onclick();
    assert.equal(harness.getService(), 'terminal');
    assert.equal($('notes').hidden, true);
    assert.equal($('notes-ask').hidden, true); // no prompt on switching services
    assert.equal(harness.noteText.value, 'unsaved edit'); // edits kept
    assert.equal(harness.counts().shellStarts, 1);
    assert.ok(harness.getHostShell()?.alive);
    assert.equal($('ctrl-terminal').classList.contains('running'), true); // green dot on Control bar button

    // Window resize fits Terminal when open.
    const fitsBefore = harness.counts().fitCalls;
    for (const fn of winListeners.resize || []) fn();
    assert.equal(harness.counts().fitCalls, fitsBefore + 1);
    assert.equal(store.get('agent-room:left'), '620'); // resize while service open never overwrites saved width

    // 4. Close Services panel via active Terminal button: restores List panel and saved --left (620px), keeps Terminal alive and My notes edits.
    $('ctrl-terminal').onclick();
    assert.equal(harness.getService(), null);
    assert.equal(document.body.classList.contains('service-open'), false);
    assert.equal($('services-panel').hidden, true);
    assert.equal(document.body.classList.contains('list-collapsed'), false);
    assert.equal($('main-panel').style.getPropertyValue('--left'), '620px'); // restored saved width!
    assert.equal($('ctrl-boards').classList.contains('on'), true);
    assert.ok(harness.getHostShell()?.alive);
    assert.equal($('ctrl-terminal').classList.contains('running'), true);
    assert.equal(harness.noteText.value, 'unsaved edit');

    // Reopening Terminal does not start a second shell and refits the running one.
    const fitsBeforeReopen = harness.counts().fitCalls;
    $('ctrl-terminal').onclick();
    assert.equal(harness.counts().shellStarts, 1);
    assert.equal(harness.counts().fitCalls, fitsBeforeReopen + 1);

    // 5. notesGuard opens My notes in the Services panel (not side pane) when leaving a board with unsaved edits.
    let leftBoard = false;
    harness.notesGuard(() => { leftBoard = true; });
    assert.equal(harness.getService(), 'notes');
    assert.equal($('notes-ask').hidden, false);
    assert.equal(leftBoard, false);
    $('notes-ask-buttons').children[0].onclick(); // Discard changes
    assert.equal(leftBoard, true);

    // 6. If List panel was already collapsed before opening a service, closing via Boards keeps it collapsed.
    $('ctrl-boards').onclick(); // close notes
    harness.setListCollapsed(true, true);
    $('ctrl-providers').onclick();
    assert.equal(harness.getService(), 'providers');
    $('ctrl-boards').onclick();
    assert.equal(harness.getService(), null);
    assert.equal(document.body.classList.contains('list-collapsed'), true);

    // 7. Clicking a provider name in Monitor opens Providers in Services panel and expands #health-details.
    harness.setListCollapsed(false, true);
    const monitorBadge = harness.providerName('claude', 'Claude', true);
    monitorBadge.onclick();
    assert.equal(harness.getService(), 'providers');
    assert.equal($('health-details').open, true);
    assert.equal(document.body.classList.contains('list-collapsed'), true);

    // 8. End shell removes the green dot from #ctrl-terminal.
    harness.closeHostShell();
    assert.equal($('ctrl-terminal').classList.contains('running'), false);

    // 9. noteDraftKept after reload opens My notes in Services panel (not side pane).
    assert.match(source, /if \(noteDraftKept\) \{ openService\('notes', \{ skipNotesOpen: true \}\); openNotes\(noteDraftKept\); \}/);
  } finally {
    s.close();
  }
});

test('list-collapsed grid places #main-panel in the last column with a real width', async () => {
  const root = mkdtempSync(join(tmpdir(), 'list-collapsed-grid-'));
  const s = await serve(root, { clients: new Set(), transcript: [] });
  try {
    const html = await (await s.get('/__room')).text();
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
    const bodyMatch = style.match(/body\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
    const collapsedMatch = style.match(/body\.list-collapsed\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
    assert.ok(bodyMatch, 'body grid-template-columns rule exists');
    assert.ok(collapsedMatch, 'body.list-collapsed grid-template-columns rule exists');

    // Split CSS track list while keeping var(...) intact.
    const splitTracks = (s) => s.trim().match(/(?:[a-z-]+\([^)]*\)|[^\s]+)/gi) || [];
    const bodyTracks = splitTracks(bodyMatch[1]);
    const collapsedTracks = splitTracks(collapsedMatch[1]);

    // Row 2 direct children of <body>, in DOM order: #control-bar, #list-panel, #list-split, #main-panel.
    const row2 = ['control-bar', 'list-panel', 'list-split', 'main-panel'];
    const positions = row2.map((id) => html.indexOf(`id="${id}"`));
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i - 1] > 0 && positions[i] > positions[i - 1], `${row2[i - 1]} precedes ${row2[i]}`);
    }
    assert.equal(bodyTracks.length, row2.length);
    assert.equal(bodyTracks.at(-1), '1fr');

    // When list-collapsed hides #list-split (display: none), #main-panel auto-places into the remaining visible slot.
    const hidesListSplit = /body\.list-collapsed\s+#list-split\s*\{[^}]*display:\s*none/.test(style);
    const visibleWhenCollapsed = row2.filter((id) => !(id === 'list-split' && hidesListSplit));
    const mainColIndex = visibleWhenCollapsed.indexOf('main-panel');

    assert.equal(collapsedTracks.length, visibleWhenCollapsed.length, 'collapsed grid track count matches visible row-2 children');
    assert.equal(mainColIndex, collapsedTracks.length - 1, '#main-panel lands in the last column');
    const mainTrack = collapsedTracks[mainColIndex];
    assert.equal(mainTrack, '1fr', `#main-panel track should be 1fr, got ${mainTrack}`);
  } finally {
    s.close();
  }
});

test('Schedule Control bar button, page view, and /__schedule GET/POST endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-sched-docs-'));
  const calls = [];
  const screen = {
    clients: new Set(), transcript: [], worker: [],
    getSchedule: () => ({ quotaFloor: 50, tasks: [], discussions: [{ ref: '2026-11-21-review', name: '2026-11-21-review', title: 'Review', section: null }] }),
    saveSchedule: (body) => { calls.push(body); return { quotaFloor: body.quotaFloor ?? 50, tasks: [], discussions: [] }; },
  };
  const s = await serve(dir, screen);
  try {
    const html = await (await s.get('/__room')).text();
    assert.match(html, /id="ctrl-schedule"/);
    assert.match(html, /id="schedule"/);
    const getRes = await s.get('/__schedule');
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).quotaFloor, 50);
    // POST from a foreign Origin is refused
    const badRes = await fetch(`${s.base}/__schedule`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ action: 'floor', quotaFloor: 60 }) });
    assert.equal(badRes.status, 403);
    // POST from own page succeeds
    const okRes = await postFrom(s, '/__schedule', { action: 'floor', quotaFloor: 60 });
    assert.equal(okRes.status, 200);
    assert.equal((await okRes.json()).quotaFloor, 60);
    assert.deepEqual(calls, [{ action: 'floor', quotaFloor: 60 }]);
  } finally {
    s.close();
  }
});

test('Boards rows show the five states in priority order (ongoing > closed > not started > waiting for input > idle) with additions intact', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return {
      toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(cls) { s.add(cls); }, remove(cls) { s.delete(cls); }, contains(cls) { return s.has(cls); },
    };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', value: '', hidden: false, disabled: false, children: [], dataset: {}, style: {},
    classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children.at(-1) || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
  });
  const els = {};
  const $ = (id) => els[id] || (els[id] = node(id));
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'send',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = false, localInput = true, box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, notesGuard = (fn) => fn();\n' +
    code + '\n' +
    'return { setRoom, renderDiscussions, setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; }, setWorker: ({ pending = null, merged = [] } = {}) => { workerPending = pending; workerMerged = new Set(merged); } };'
  )($, { createElement: node, title: '' }, { href: '/r/4/__room' }, null, null, () => {}, (cb) => cb(), () => {}, () => {});
  harness.setFiles([
    'discussions/2026-11-22-ongoing-round/notes.md',
    'discussions/2026-11-22-ongoing-worker/notes.md',
    'discussions/2026-11-22-ongoing-closing/notes.md',
    'discussions/2026-11-22-closed/notes.md',
    'discussions/2026-11-22-not-started/notes.md',
    'discussions/2026-11-22-waiting/notes.md',
    'discussions/2026-11-22-idle-open/notes.md',
    'discussions/2026-11-22-idle-saved/notes.md',
    'brainstorms/2026-11-22-b-ongoing/transcripts/s.md',
    'brainstorms/2026-11-22-b-waiting/transcripts/s.md',
    'brainstorms/2026-11-22-b-idle/transcripts/s.md',
    'brainstorms/2026-11-22-b-closed/transcripts/s.md',
  ]);
  harness.setRoom({
    folder: '/tmp/project',
    active: 'discussions/2026-11-22-waiting',
    discussion: 'Waiting',
    started: true,
    closedDiscussions: ['2026-11-22-closed'],
    closingDiscussions: { '2026-11-22-ongoing-closing': 'waiting' },
    open: [
      { active: null, title: 'New discussion (not started)', started: false, current: false, working: false, ongoing: false, waitingForInput: false, url: '/r/u1/__room' },
      { active: null, title: 'New discussion (worker)', started: false, current: false, working: true, ongoing: true, waitingForInput: false, url: '/r/u2/__room' },
      { active: 'discussions/2026-11-22-ongoing-round', title: 'Round', started: true, current: false, working: false, ongoing: true, waitingForInput: true, url: '/r/1/__room' },
      { active: 'discussions/2026-11-22-ongoing-worker', title: 'Worker', started: true, current: false, working: true, ongoing: true, waitingForInput: false, url: '/r/2/__room' },
      { active: 'discussions/2026-11-22-not-started', title: 'Not started', started: false, current: false, working: false, ongoing: false, waitingForInput: true, url: '/r/3/__room' },
      { active: 'discussions/2026-11-22-waiting', title: 'Waiting', started: true, current: true, working: false, ongoing: false, waitingForInput: true, url: '/r/4/__room' },
      { active: 'discussions/2026-11-22-idle-open', title: 'Idle open', started: true, current: false, working: false, ongoing: false, waitingForInput: false, url: '/r/5/__room' },
      { active: 'brainstorms/2026-11-22-b-ongoing', title: 'B ongoing', brainstorm: true, started: true, current: false, ongoing: true, waitingForInput: true, url: '/r/b1/__room' },
      { active: 'brainstorms/2026-11-22-b-waiting', title: 'B waiting', brainstorm: true, started: true, current: false, ongoing: false, waitingForInput: true, url: '/r/b2/__room' },
      { active: 'brainstorms/2026-11-22-b-idle', title: 'B idle', brainstorm: true, started: true, current: false, ongoing: false, waitingForInput: false, url: '/r/b3/__room' },
    ],
  });
  harness.setWorker({
    pending: [{ lane: '2026-11-22-ongoing-worker', branch: 'worker/2026-11-22-ongoing-worker', ahead: 2, dirty: false }],
    merged: ['2026-11-22-closed'],
  });
  harness.renderDiscussions();

  const boardList = els['list-pane'].firstChild;
  const rowsIn = (section) => boardList.children.find((c) => c.dataset?.section === section).children
    .filter((c) => c.className?.includes('discussion-row'));
  const discRows = rowsIn('discussions');
  const labelFor = (rows, match) => {
    const row = rows.find((r) => {
      const btn = r.children.find((c) => c.className === 'discussion-block')?.children[0];
      return btn?.title === match || btn?.textContent === match;
    });
    const block = row.children.find((c) => c.className === 'discussion-block');
    return { row, label: block.children.find((c) => c.className === 'local-label').textContent, warn: block.children.find((c) => c.className === 'worker-pending')?.textContent ?? null };
  };

  assert.equal(labelFor(discRows, 'New discussion (not started)').label, 'not started');
  assert.equal(labelFor(discRows, 'New discussion (worker)').label, 'ongoing · worker working');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-ongoing-round').label, 'ongoing · no changes');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-ongoing-worker').label, 'ongoing · worker working');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-ongoing-worker').warn, '⚠ Worker: 2 commits not merged into main');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-ongoing-closing').label, 'ongoing · closing · waiting for worker · no changes');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-closed').label, 'closed · merged');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-not-started').label, 'not started · no changes');
  const waiting = labelFor(discRows, 'discussions/2026-11-22-waiting');
  assert.equal(waiting.label, 'waiting for input · no changes');
  assert.ok(waiting.row.className.includes('in-use'), 'current row stays highlighted without a "current" label');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-idle-open').label, 'idle · no changes');
  assert.equal(labelFor(discRows, 'discussions/2026-11-22-idle-saved').label, 'idle · no changes');

  const brainRows = rowsIn('brainstorms');
  assert.equal(labelFor(brainRows, 'brainstorms/2026-11-22-b-ongoing').label, 'ongoing');
  assert.equal(labelFor(brainRows, 'brainstorms/2026-11-22-b-waiting').label, 'waiting for input');
  assert.equal(labelFor(brainRows, 'brainstorms/2026-11-22-b-idle').label, 'idle');
  assert.equal(labelFor(brainRows, 'brainstorms/2026-11-22-b-closed').label, 'closed');
});

test('Per-board layout: saved per room+board, copies on first open, survives Archive/Defer/Convert, read-only peek/view, unnamed new board, and divider drag while service open', () => {
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const ctrlCode = source.slice(source.indexOf('// Control bar & Services panel'), source.indexOf('// The Schedule page:'));
  const dividerCode = source.slice(source.indexOf('// The dividers:'), source.indexOf('function message('));
  const classListFor = () => {
    const set = new Set();
    return { toggle(cls, v) { if (v === undefined ? !set.has(cls) : v) set.add(cls); else set.delete(cls); },
      add(...c) { c.forEach((x) => set.add(x)); }, remove(...c) { c.forEach((x) => set.delete(x)); }, contains(cls) { return set.has(cls); } };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', value: '', hidden: false, disabled: false, children: [], dataset: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; }, getPropertyValue(k) { return this.props[k] || ''; } },
    attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    offsetWidth: 7, offsetHeight: 7, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    classList: classListFor(),
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    setPointerCapture() {},
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    focus() {},
  });
  const els = {};
  const $ = (id) => els[id] || (els[id] = node(id));
  const document = {
    body: node('body'),
    documentElement: { clientWidth: 1400, clientHeight: 800 },
    createElement: node,
    getElementById: (id) => els[id] || null,
    addEventListener() {},
  };
  $('control-bar').getBoundingClientRect = () => ({ width: 62, height: 600, left: 0, top: 0 });
  $('main-panel').getBoundingClientRect = () => ({ width: document.body.classList.contains('service-open') ? 540 : 1100, height: 600, left: 62, top: 0 });
  $('services-panel').getBoundingClientRect = () => ({ width: document.body.classList.contains('service-open') ? 669 : 0, height: 600, left: 62, top: 0 });
  $('left').getBoundingClientRect = () => ({ width: parseInt($('main-panel').style.getPropertyValue('--left') || '500', 10), height: parseInt($('main-panel').style.getPropertyValue('--top') || '300', 10), left: 62, top: 0 });

  // Starting layout on page load comes from the old shared keys.
  const store = new Map([
    ['agent-room:left', '620'],
    ['agent-room:top', '310'],
    ['agent-room:split-orient', 'side'],
    ['agent-room:side-closed', '0'],
    ['agent-room:list', '260'],
  ]);
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const window = { addEventListener() {} };

  const harness = new Function('$', 'document', 'window', 'localStorage', 'requestAnimationFrame', 'post',
    'let tab = "talk", room = null, peeking = null, viewing = null, box = $("box"), wbox = $("wbox");\n' +
    'const updateReplicaView = () => {};\n' +
    ctrlCode + '\n' + dividerCode + '\n' +
    'return {\n' +
    '  setRoomState: (r) => { room = r; syncBoardLayout(); },\n' +
    '  setPeekState: (p) => { peeking = p; syncBoardLayout(); },\n' +
    '  setViewState: (v) => { viewing = v; syncBoardLayout(); },\n' +
    '  openService, boardLayoutStorageKey, readBoardLayout,\n' +
    '  state: () => ({ stacked, sideClosed, savedLeft, savedTop, savedList, leftCss: $("main-panel").style.getPropertyValue("--left"), topCss: $("main-panel").style.getPropertyValue("--top") }),\n' +
    '};'
  )($, document, window, localStorage, (cb) => cb(), async () => {});

  // 1. Page load reads old shared keys and does not delete them.
  assert.deepEqual(harness.state(), { stacked: false, sideClosed: false, savedLeft: 620, savedTop: 310, savedList: 260, leftCss: '620px', topCss: '310px' });
  assert.equal(store.get('agent-room:left'), '620');

  // 2. First time Board A is shown with no saved layout: copies on-screen layout and saves at once.
  const folder = '/tmp/my-room';
  harness.setRoomState({ folder, active: 'discussions/2026-11-21-alpha' });
  const keyA = harness.boardLayoutStorageKey(folder, '2026-11-21-alpha');
  assert.deepEqual(JSON.parse(store.get(keyA)), { stacked: false, sideClosed: false, left: 620, top: 310 });

  // Customize Board A: stack it, drag divider vertically via keyboard, close side pane.
  $('split-orient').onclick();
  for (const fn of $('split').listeners.keydown) fn({ key: 'ArrowDown', preventDefault() {} }); // 310 + 24 = 334
  $('side-close').onclick();
  assert.deepEqual(JSON.parse(store.get(keyA)), { stacked: true, sideClosed: true, left: 620, top: 334 });

  // 3. Switch to Board B (already has a saved layout): applies B's layout; list stays shared.
  const keyB = harness.boardLayoutStorageKey(folder, '2026-11-21-beta');
  store.set(keyB, JSON.stringify({ stacked: false, sideClosed: false, left: 480, top: null }));
  harness.setRoomState({ folder, active: 'discussions/2026-11-21-beta' });
  assert.equal(harness.state().stacked, false);
  assert.equal(harness.state().sideClosed, false);
  assert.equal(harness.state().savedLeft, 480);
  assert.equal(harness.state().leftCss, '480px');
  assert.equal(harness.state().savedList, 260); // shared Boards list width untouched

  // 4. Key matches across Archive, Defer, and Turn into a discussion (brainstorms/<name> -> discussions/<name>).
  const keyIdea = harness.boardLayoutStorageKey(folder, '2026-11-21-idea');
  store.set(keyIdea, JSON.stringify({ stacked: true, sideClosed: false, left: 500, top: 270 }));
  harness.setRoomState({ folder, active: 'brainstorms/2026-11-21-idea' });
  assert.equal(harness.state().stacked, true);
  assert.equal(harness.state().savedTop, 270);
  // Turn into a discussion keeps the same key & layout.
  harness.setRoomState({ folder, active: 'discussions/2026-11-21-idea' });
  assert.equal(harness.state().stacked, true);
  assert.equal(harness.state().savedTop, 270);
  // Archive / Defer paths resolve to the same key when peeking.
  harness.setRoomState({ folder, active: 'discussions/2026-11-21-beta' }); // back to B (stacked: false, left: 480)
  assert.equal(harness.state().stacked, false);
  harness.setPeekState({ path: 'discussions/archive/2026-11-21-idea', name: 'archive/2026-11-21-idea' });
  assert.equal(harness.state().stacked, true);
  assert.equal(harness.state().savedTop, 270);

  // 5. While peeking: drags and toggles apply on screen only and NEVER save; leaving peek restores Board B.
  $('side-close').onclick();
  for (const fn of $('split').listeners.keydown) fn({ key: 'ArrowUp', preventDefault() {} });
  assert.deepEqual(JSON.parse(store.get(keyIdea)), { stacked: true, sideClosed: false, left: 500, top: 270 }); // unchanged!
  assert.deepEqual(JSON.parse(store.get(keyB)), { stacked: false, sideClosed: false, left: 480, top: null }); // unchanged!
  harness.setPeekState(null);
  assert.equal(harness.state().stacked, false);
  assert.equal(harness.state().sideClosed, false);
  assert.equal(harness.state().savedLeft, 480);

  // Viewing a peer's chat read-only also shows saved layout if present, never saves, and restores on return.
  harness.setViewState({ discussion: '2026-11-21-idea', name: '2026-11-21-idea', node: 'peer1' });
  assert.equal(harness.state().stacked, true);
  $('split-orient').onclick(); // temporary toggle while viewing
  assert.deepEqual(JSON.parse(store.get(keyIdea)), { stacked: true, sideClosed: false, left: 500, top: 270 }); // unchanged!
  harness.setViewState(null);
  assert.equal(harness.state().stacked, false);
  assert.equal(harness.state().savedLeft, 480);

  // 6. Unnamed new board: keep layout changes made before first message, save once named.
  harness.setRoomState({ folder, active: null });
  $('split-orient').onclick(); // stacked: true
  $('side-close').onclick(); // sideClosed: true
  harness.setRoomState({ folder, active: 'discussions/2026-11-23-fresh-topic' });
  const keyFresh = harness.boardLayoutStorageKey(folder, '2026-11-23-fresh-topic');
  assert.deepEqual(JSON.parse(store.get(keyFresh)), { stacked: true, sideClosed: true, left: 480, top: null });

  // 7. Widths applied only because a service is open are NOT saved, but a user-dragged divider IS saved for that board.
  harness.setRoomState({ folder, active: 'discussions/2026-11-21-beta' }); // left: 480, side-by-side, side open
  assert.equal(harness.state().leftCss, '480px');
  harness.openService('providers');
  assert.equal(harness.state().leftCss, '273px'); // automatically clamped for narrower board area
  assert.equal(JSON.parse(store.get(keyB)).left, 480); // NOT overwritten by automatic clamping!
  // Now user drags/keys the divider while Providers is open: saved for Board B!
  for (const fn of $('split').listeners.keydown) fn({ key: 'ArrowRight', preventDefault() {} }); // clamped to max of narrowed area (273) or moved
  const draggedLeft = parseInt($('main-panel').style.getPropertyValue('--left'), 10);
  assert.equal(JSON.parse(store.get(keyB)).left, draggedLeft);
  harness.openService(null);
  assert.equal(harness.state().savedLeft, draggedLeft);
});

test('Archived and deferred brainstorms appear in Archived · Deferred with read-only peek, expected ⋯ menu (no Turn into a discussion), and servable files', async () => {
  // 1. Server-side docFiles includes archived and deferred brainstorm files.
  const root = mkdtempSync(join(tmpdir(), 'brainstorm-archive-docs-'));
  mkdirSync(join(root, 'brainstorms', 'archive', '2026-11-10-old-idea', 'transcripts'), { recursive: true });
  mkdirSync(join(root, 'brainstorms', 'deferred', '2026-11-11-later-idea', 'transcripts'), { recursive: true });
  writeFileSync(join(root, 'brainstorms', 'archive', '2026-11-10-old-idea', 'transcripts', 's.md'), 'hi');
  writeFileSync(join(root, 'brainstorms', 'deferred', '2026-11-11-later-idea', 'transcripts', 's.md'), 'later');
  const listed = docFiles(root, null);
  assert.ok(listed.includes('brainstorms/archive/2026-11-10-old-idea/transcripts/s.md'));
  assert.ok(listed.includes('brainstorms/deferred/2026-11-11-later-idea/transcripts/s.md'));

  // 2. Client-side Boards rendering & menus.
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const urlFor ='), source.indexOf('// Settings stay outside'));
  const classListFor = () => {
    const s = new Set();
    return { toggle(cls, v) { if (v === undefined ? !s.has(cls) : v) s.add(cls); else s.delete(cls); },
      add(...c) { c.forEach((x) => s.add(x)); }, remove(...c) { c.forEach((x) => s.delete(x)); }, contains(cls) { return s.has(cls); } };
  };
  const node = (tag = 'div') => ({
    tag, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {}, style: {}, classList: classListFor(),
    get firstChild() { return this.children[0] || null; },
    set innerHTML(html) { this.children = [node('div')]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
  });
  const els = {}, store = new Map(), sent = [], posted = [], location = { href: '' };
  const localStorage = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)) };
  const harness = new Function('$', 'document', 'location', 'viewing', 'peeking', 'renderAutoDev', 'requestAnimationFrame', 'setInterval', 'localStorage', 'fetch', 'send',
    'let tab = "talk", replica = null, localThinking = null, yourTurn = true, localInput = true, ended = false, posting = 0, viewClient = "t", box = { hidden: false }, wbox = {};\n' +
    'let doc = null, docpane = $("docpane"), pane = $("pane");\n' +
    'let attaching = false, pending = [];\n' +
    'const renderAttachments = () => {}, closeMenus = () => {}, notesGuard = (act) => act(), status = () => {}, updateBusy = () => {}, busyFailed = () => {};\n' +
    code + '\n' +
    'return { setRoom, renderBoards, docLabel, getPeek: () => peek, ' +
    '  setFiles: (files) => { cachedDetail = { files, unviewable: new Set(), branch: "main" }; } };'
  )((id) => els[id] || (els[id] = node(id)), { createElement: node, title: '' }, location, null, null, () => {}, (cb) => cb(), () => {}, localStorage,
    async (url, opts) => { posted.push(JSON.parse(opts.body).text); return { ok: true }; },
    (line) => sent.push(line));

  const checkpoints = [
    { name: 'brainstorms/2026-11-10-old-idea', at: 'x', kind: 'full', title: 'Old Idea' },
    { name: 'brainstorms/2026-11-11-later-idea', at: 'x', kind: 'full', title: 'Later Idea' },
  ];
  harness.setRoom({ folder: '/tmp/project', active: 'discussions/2026-11-20-main', brainstorm: false, discussion: 'Main', started: true, multi: true, open: [], checkpoints, closedDiscussions: [] });
  harness.setFiles([
    'discussions/2026-11-20-main/notes.md',
    'brainstorms/archive/2026-11-10-old-idea/transcripts/s.md',
    'brainstorms/deferred/2026-11-11-later-idea/transcripts/s.md',
  ]);
  harness.renderBoards();

  assert.equal(harness.docLabel('brainstorms/archive/2026-11-10-old-idea/transcripts/s.md'), 'Old Idea · transcripts/s.md');
  assert.equal(harness.docLabel('brainstorms/deferred/2026-11-11-later-idea/transcripts/s.md'), 'Later Idea · transcripts/s.md');

  const section = els['list-pane'].firstChild.children.find((c) => c.dataset?.section === 'archived-deferred');
  assert.equal(section.open, false);
  assert.equal(section.children[0].textContent, 'Archived · Deferred (2)');
  const rows = section.children.filter((c) => c.className.includes('discussion-row'));
  const block = (r) => r.children.find((c) => c.className === 'discussion-block');
  const rowByTitle = (t) => rows.find((r) => block(r).children[0].textContent === t);
  const menuLabels = (t) => rowByTitle(t).children.find((c) => c.tag === 'details').children[1].children.filter((b) => b.tag === 'button').map((b) => b.textContent);
  const action = (t, label) => rowByTitle(t).children.find((c) => c.tag === 'details').children[1].children.find((b) => b.textContent === label || b.dataset.label === label);
  const click = (b) => b.onclick({ stopPropagation() {} });

  // Labels
  assert.equal(block(rowByTitle('Old Idea')).children[1].textContent, 'archived brainstorm');
  assert.equal(block(rowByTitle('Later Idea')).children[1].textContent, 'deferred brainstorm');

  // Menus mirror archived/deferred discussions + Delete, and omit Turn into a discussion.
  assert.deepEqual(menuLabels('Old Idea'), ['Resume', 'Peek files', 'Peek chat & files', 'Make active', 'Defer', 'Start fresh', 'Delete']);
  assert.deepEqual(menuLabels('Later Idea'), ['Resume', 'Peek files', 'Peek chat & files', 'Make active', 'Archive', 'Start fresh', 'Delete']);

  // Clicking peeks read-only (chat & files).
  block(rowByTitle('Old Idea')).children[0].onclick();
  assert.equal(sent.at(-1), '/peek brainstorms/archive/2026-11-10-old-idea');
  assert.equal(harness.getPeek()?.path, 'brainstorms/archive/2026-11-10-old-idea');

  // Menu actions send the right commands.
  click(action('Old Idea', 'Make active'));
  assert.equal(sent.at(-1), '/move brainstorms/archive/2026-11-10-old-idea active');
  click(action('Old Idea', 'Defer'));
  assert.equal(sent.at(-1), '/move brainstorms/archive/2026-11-10-old-idea deferred');
  await click(action('Later Idea', 'Archive'));
  assert.equal(posted.at(-1), '/move brainstorms/deferred/2026-11-11-later-idea archive');
  click(action('Old Idea', 'Resume'));
  assert.equal(sent.at(-1), '/resume brainstorms/archive/2026-11-10-old-idea');
  const freshBtn = action('Old Idea', 'Start fresh');
  click(freshBtn); click(freshBtn);
  assert.equal(sent.at(-1), '/fresh brainstorms/archive/2026-11-10-old-idea');
  const delBtn = action('Old Idea', 'Delete');
  click(delBtn); click(delBtn);
  assert.equal(sent.at(-1), '/delete brainstorms/archive/2026-11-10-old-idea');
});
