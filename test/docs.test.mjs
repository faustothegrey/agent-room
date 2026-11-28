import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ATTACH_LIMIT, broadcast, csvTable, docFiles, handle, isTextFile, isViewable, listFiles, messageView, pick, roomBranch, saveAttachments } from '../src/docs.mjs';
import { md, page, RECENT_VERSION_LIMIT, readReviewed, renderMarkdownWithDiff, reviewedDir, sourceHash } from '../src/docs-files.mjs';

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
  assert.deepEqual(messageView({ speaker: 'A', text: 'quota', error: true }), { speaker: 'A', html: '<p>quota</p>\n', error: true, pass: false, errorText: 'quota' });
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
  } finally { s.close(); }
});

test('the heartbeat: /__health says it is agent-room, with its process, root and discussion', async () => {
  const dir = fixture();
  const screen = { clients: new Set(), transcript: [], startedAt: '2026-11-03T10:00:00.000Z', room: { active: 'discussions/2026-11-03-x' } };
  const s = await serve(dir, screen);
  const res = await s.get('/__health');
  assert.equal(res.status, 200);
  const { host, ...rest } = await res.json();
  assert.deepEqual(rest, { app: 'agent-room', pid: process.pid, root: dir, startedAt: '2026-11-03T10:00:00.000Z', board: 'discussions/2026-11-03-x', pages: 0 });
  // The machine's short name: its hostname cut at the first dot, unless that is an IPv4 address.
  const { hostname } = await import('node:os');
  const name = hostname().trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) assert.equal(host, name);
  else if (name.split('.')[0]) assert.equal(host, name.split('.')[0]);
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
  const rooms = [{ id: 'other-0a1b2c', path: '/r/other-0a1b2c/__room', root: '/tmp/other', board: 'discussions/example', pages: 1, current: false }];
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
    assert.match(await refused.text(), /started sprint or brainstorm.*Nothing was sent/);
  } finally {
    s.close();
  }
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











test('while peeking a closed board, /__say (messages/attachments) and /__work are refused with 409 while /peek and /resume pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peek-guard-'));
  const said = [], worked = [];
  const screen = {
    clients: new Set(), transcript: [],
    room: { active: 'discussions/2026-11-20-live' },
    peek: { name: '2026-11-01-closed', ref: '2026-11-01-closed', path: 'discussions/2026-11-01-closed', kind: 'sprint', title: 'Closed', messages: [], doc: null },
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





test('Schedule Control bar button, page view, and /__schedule GET/POST endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-sched-docs-'));
  const calls = [];
  const screen = {
    clients: new Set(), transcript: [], worker: [],
    getSchedule: () => ({ quotaFloor: 50, tasks: [] }),
    saveSchedule: (body) => { calls.push(body); return { quotaFloor: body.quotaFloor ?? 50, tasks: [] }; },
  };
  const s = await serve(dir, screen);
  try {
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

});

function openDocDom(rel, markdown) {
  const html = page(rel, md.parse(markdown), rel);
  const posted = [];
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:5566/${rel}`,
    runScripts: 'dangerously',
    beforeParse(win) {
      Object.defineProperty(win, 'parent', {
        value: { postMessage: (data, origin) => posted.push({ data, origin }) },
      });
    },
  });
  return { dom, posted };
}

function selectElement(win, el) {
  const range = win.document.createRange();
  range.selectNodeContents(el);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

test('passage pointing: selecting the second copy of a sentence with bold and a link names the second heading with the full quote', () => {
  const markdown = [
    '# Notes',
    '',
    '## First section',
    '',
    'Intro paragraph.',
    '',
    'Keep the **shared draft** clean and see [the spec](https://example.com/spec) before merging.',
    '',
    '## Second section',
    '',
    'Lead-in paragraph.',
    '',
    'Keep the **shared draft** clean and see [the spec](https://example.com/spec) before merging.',
  ].join('\n');
  const { dom, posted } = openDocDom('discussions/x/notes.md', markdown);
  try {
    const win = dom.window;
    const paragraphs = [...win.document.querySelectorAll('main p')];
    assert.equal(paragraphs.length, 4);
    selectElement(win, paragraphs[3]);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].origin, 'http://127.0.0.1:5566');
    assert.equal(posted[0].data.type, 'agent-room:point');
    assert.equal(posted[0].data.kind, 'passage');
    assert.equal(
      posted[0].data.text,
      'passage in discussions/x/notes.md, under "Second section", paragraph 2: "Keep the shared draft clean and see the spec before merging."',
    );
    assert.equal(posted[0].data.label, '↳ "Keep the shared draft … the spec before merging."');
  } finally {
    dom.window.close();
  }
});

test('passage pointing: 4000-character limit counts location + quote, shows a note when over, and ignores empty clicks and drawing tools', () => {
  const rel = 'discussions/2026-11-28-a-very-long-sprint-folder-name-for-testing-limits/sub/notes.md';
  const heading = 'B. A long section heading that takes up plenty of characters in the location hint';
  const prefix1 = `passage in ${rel}, under "${heading}", paragraph 1: "`;
  const prefix2 = `passage in ${rel}, under "${heading}", paragraph 2: "`;
  const exactQuote = 'w'.repeat(4000 - prefix1.length - 1);
  const overQuote = 'z'.repeat(4001 - prefix2.length - 1);
  const markdown = [
    `## ${heading}`,
    '',
    exactQuote,
    '',
    overQuote,
    '',
    '```csv runs',
    'a,b',
    '1,2',
    '```',
  ].join('\n');
  const { dom, posted } = openDocDom(rel, markdown);
  try {
    const win = dom.window;
    const [p1, p2] = [...win.document.querySelectorAll('main p')];

    // Empty selection points at nothing.
    win.getSelection().removeAllRanges();
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 0);

    // Click without drag points at nothing even if a selection exists.
    selectElement(win, p1);
    win.document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 20, clientY: 20 }));
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: 20, clientY: 20, detail: 1 }));
    assert.equal(posted.length, 0);

    // Exactly 4000 characters (location + quote) is sent with no note.
    selectElement(win, p1);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].data.text.length, 4000);
    assert.equal(win.document.getElementById('passage-note'), null);

    // 4001 characters (location + quote) is not sent and shows the note.
    selectElement(win, p2);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 1);
    const note = win.document.getElementById('passage-note');
    assert.ok(note);
    assert.match(note.textContent, /shorter passage/i);

    // Drawing tools (Pen, Circle, Arrow) never also point at a passage.
    for (const tool of ['pen', 'circle', 'arrow']) {
      win.document.querySelector(`#ink-tools [data-tool="${tool}"]`).click();
      selectElement(win, p1);
      win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
      assert.equal(posted.length, 1, `tool ${tool} should not point at a passage`);
    }

    // Returning to Point re-enables passage pointing and clears the note.
    win.document.querySelector('#ink-tools [data-tool="point"]').click();
    selectElement(win, p1);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 2);
    assert.equal(win.document.getElementById('passage-note'), null);
  } finally {
    dom.window.close();
  }
});

// Helper for in-place update tests: stubs polling interval, fetch, scroll, and dynamic Mermaid/Vega script loading.
function openLiveDocDom(rel, initialMd, { withMermaid = false, withVega = false } = {}) {
  let currentMd = initialMd;
  let currentMtime = '1000';
  let failPageFetch = false;
  let pollFn = null;
  let reloaded = false;
  const loadedScripts = [];
  const posted = [];
  const scrollState = { x: 0, y: 0 };

  const installMermaid = (win) => {
    win.mermaid = {
      initialize() {},
      async render(id, src) {
        const node = /([A-Za-z0-9_]+)\[([^\]]+)\]/.exec(src);
        const nid = node ? node[1] : 'NodeA';
        const label = node ? node[2] : 'NodeA';
        return { svg: `<svg id="${id}"><g class="node" data-id="${nid}"><rect></rect><text>${label}</text></g></svg>` };
      },
    };
  };
  const installVega = (win) => {
    win.vegaEmbed = async (box, spec) => {
      const datum = (spec.data && spec.data.values && spec.data.values[0]) || { day: '16 Nov', runs: 42 };
      const svg = win.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const rect = win.document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      svg.append(rect);
      box.innerHTML = '';
      box.append(svg);
      const item = { datum, _svg: rect, mark: { role: 'mark' } };
      let clickHandler = null;
      const view = {
        scenegraph: () => ({ root: { items: [item] } }),
        addEventListener: (ev, fn) => { if (ev === 'click') clickHandler = fn; },
        triggerClick: () => clickHandler && clickHandler({}, item),
        finalize() {},
      };
      box._view = view;
      return { view };
    };
  };

  const html = page(rel, md.parse(currentMd), rel);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (/Not implemented: navigation/i.test(err.message)) reloaded = true;
    else console.error(err);
  });
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:5566/${rel}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(win) {
      Object.defineProperty(win, 'parent', {
        value: { postMessage: (data, origin) => posted.push({ data, origin }) },
      });
      win.setInterval = (fn) => { pollFn = fn; return 1; };
      Object.defineProperty(win, 'scrollX', { get: () => scrollState.x, configurable: true });
      Object.defineProperty(win, 'scrollY', { get: () => scrollState.y, configurable: true });
      win.scrollTo = (x, y) => { scrollState.x = x; scrollState.y = y; };
      win.fetch = async (url) => {
        const u = String(url);
        if (u.includes('__mtime')) return { ok: true, text: async () => currentMtime };
        if (failPageFetch) throw new Error('network down');
        return { ok: true, text: async () => page(rel, md.parse(currentMd), rel) };
      };
      if (withMermaid) installMermaid(win);
      if (withVega) installVega(win);
      // Intercept dynamic <script src="/__lib/..."> appended to document.head.
      const origAppend = win.Element.prototype.append;
      win.Element.prototype.append = function (...nodes) {
        const res = origAppend.apply(this, nodes);
        for (const n of nodes) {
          if (n && n.tagName === 'SCRIPT' && n.src && n.src.includes('/__lib/')) {
            const name = n.src.slice(n.src.lastIndexOf('/') + 1);
            loadedScripts.push(name);
            if (name === 'mermaid.js') installMermaid(win);
            if (name === 'vega-embed.js') installVega(win);
            queueMicrotask(() => n.onload && n.onload());
          }
        }
        return res;
      };
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 15));
  return {
    dom,
    posted,
    loadedScripts,
    scrollState,
    wasReloaded: () => reloaded,
    setDoc(nextMd, nextMtime) { currentMd = nextMd; currentMtime = String(nextMtime); },
    setFailPageFetch(flag) { failPageFetch = flag; },
    async poll() { await pollFn(); await flush(); },
  };
}

test('in-place update (1): preserves scroll and drawn marks while updating table, diagram, chart and pointing', async () => {
  const initial = [
    '# Live Doc',
    '',
    'Old intro paragraph.',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,10',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  OldBox[Old box]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"16 Nov","runs":10}]}}',
    '```',
  ].join('\n');
  const updated = [
    '# Live Doc',
    '',
    'Updated intro paragraph.',
    '',
    '```csv runs',
    'day,runs',
    '17 Nov,42',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  NewBox[New box]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"17 Nov","runs":42}]}}',
    '```',
  ].join('\n');

  const env = openLiveDocDom('discussions/x/notes.md', initial, { withMermaid: true, withVega: true });
  try {
    const win = env.dom.window;
    await env.poll(); // baseline mtime

    // Scroll down, choose Pen tool, and add a drawn mark into #ink.
    env.scrollState.y = 240;
    win.document.querySelector('#ink-tools [data-tool="pen"]').click();
    const ink = win.document.getElementById('ink');
    assert.ok(ink);
    const mark = win.document.createElementNS('http://www.w3.org/2000/svg', 'path');
    mark.setAttribute('d', 'M10 10L50 50');
    mark.id = 'test-mark';
    ink.append(mark);

    // File changes on disk.
    env.setDoc(updated, 2000);
    await env.poll();

    assert.equal(env.wasReloaded(), false);
    assert.equal(env.scrollState.y, 240);
    assert.equal(win.document.getElementById('test-mark'), mark);
    assert.equal(win.document.body.classList.contains('drawing'), true);
    assert.match(win.document.querySelector('main p').textContent, /Updated intro paragraph/);

    // Switch back to Point and verify clicking cell, diagram box, chart mark, and selecting prose still point.
    win.document.querySelector('#ink-tools [data-tool="point"]').click();
    win.document.querySelector('.sheet td[data-cell="B2"]').click();
    win.document.querySelector('.mermaid-box g.node').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    win.document.querySelector('.vl-box')._view.triggerClick();
    selectElement(win, win.document.querySelector('main p'));
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));

    assert.equal(env.posted.length, 4);
    assert.match(env.posted[0].data.text, /table cell runs!B2 in discussions\/x\/notes\.md = 42/);
    assert.match(env.posted[1].data.text, /diagram box NewBox \("New box"\)/);
    assert.match(env.posted[2].data.text, /chart point day: 17 Nov, runs: 42/);
    assert.match(env.posted[3].data.text, /passage in discussions\/x\/notes\.md, under "Live Doc", paragraph 1: "Updated intro paragraph\."/);
  } finally {
    env.dom.window.close();
  }
});

test('in-place update (2): prose-only reloads on first diagram; table-only loads diagram and chart in place keeping marks', async () => {
  // Part A: prose-only document gets its first diagram -> reloads so toolbar + Mermaid load.
  const proseEnv = openLiveDocDom('discussions/x/prose.md', '# Prose\n\nJust words.\n');
  try {
    await proseEnv.poll();
    assert.equal(proseEnv.dom.window.document.getElementById('ink'), null);
    proseEnv.setDoc('# Prose\n\n```mermaid\nflowchart LR\n  A[Start]\n```\n', 2000);
    await proseEnv.poll();
    assert.equal(proseEnv.wasReloaded(), true);
  } finally {
    proseEnv.dom.window.close();
  }

  // Part B: table-only document with a drawn mark gets its first diagram and chart -> updates in place, loads libs, keeps mark.
  const tableOnly = '# Table\n\n```csv t\na,b\n1,2\n```\n';
  const withFigures = [
    '# Table',
    '',
    '```csv t',
    'a,b',
    '1,3',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  Worker[The worker]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"18 Nov","runs":7}]}}',
    '```',
  ].join('\n');
  const tableEnv = openLiveDocDom('discussions/x/table.md', tableOnly);
  try {
    const win = tableEnv.dom.window;
    await tableEnv.poll();
    const ink = win.document.getElementById('ink');
    assert.ok(ink);
    const mark = win.document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    mark.id = 'kept-mark';
    ink.append(mark);

    tableEnv.setDoc(withFigures, 2000);
    await tableEnv.poll();

    assert.equal(tableEnv.wasReloaded(), false);
    assert.equal(win.document.getElementById('kept-mark'), mark);
    assert.ok(tableEnv.loadedScripts.includes('mermaid.js'));
    assert.ok(tableEnv.loadedScripts.includes('vega.js'));
    assert.ok(tableEnv.loadedScripts.includes('vega-lite.js'));
    assert.ok(tableEnv.loadedScripts.includes('vega-embed.js'));
    assert.ok(win.document.querySelector('.mermaid-box g.node[data-id="Worker"]'));
    assert.ok(win.document.querySelector('.vl-box svg'));
  } finally {
    tableEnv.dom.window.close();
  }
});

test('in-place update (3): failed fetch keeps pane and marks intact, and next successful poll updates it', async () => {
  const initial = '# Doc\n\nBefore change.\n\n```csv t\na\n1\n```\n';
  const updated = '# Doc\n\nAfter change.\n\n```csv t\na\n2\n```\n';
  const env = openLiveDocDom('discussions/x/retry.md', initial);
  try {
    const win = env.dom.window;
    await env.poll();
    const ink = win.document.getElementById('ink');
    const mark = win.document.createElementNS('http://www.w3.org/2000/svg', 'line');
    mark.id = 'retry-mark';
    ink.append(mark);

    env.setDoc(updated, 2000);
    env.setFailPageFetch(true);
    await env.poll();

    assert.equal(env.wasReloaded(), false);
    assert.equal(win.document.getElementById('retry-mark'), mark);
    assert.match(win.document.querySelector('main p').textContent, /Before change/);

    // Next poll succeeds with the same mtime (2000) because last was not advanced on failure.
    env.setFailPageFetch(false);
    await env.poll();

    assert.equal(env.wasReloaded(), false);
    assert.equal(win.document.getElementById('retry-mark'), mark);
    assert.match(win.document.querySelector('main p').textContent, /After change/);
  } finally {
    env.dom.window.close();
  }
});

test('change tracking (1, 2, 5, 7): multi-edit diff, Mark reviewed saves shown version, survives restart, stale version refused, path/origin checked', async () => {
  const dir = fixture();
  const screen = { clients: new Set(), transcript: [] };
  const notesPath = join(dir, 'plan.md');
  const v1 = [
    '# Plan',
    '',
    'First paragraph stays here.',
    '',
    'Second paragraph mentions draft.',
    '',
    'Third paragraph is quite wordy and really should be tightened up nicely.',
  ].join('\n');
  writeFileSync(notesPath, v1);

  const s1 = await serve(dir, screen);
  try {
    // First open establishes first-opened baseline.
    const html1 = await (await s1.get('/plan.md')).text();
    assert.match(html1, /Tracking changes since you first opened this document/);
    const hash1 = /data-doc-hash="([0-9a-f]+)"/.exec(html1)?.[1];
    assert.equal(hash1, sourceHash(v1));

    // Security checks on /__review: foreign origin -> 403, unservable path -> 404.
    assert.equal((await postFrom(s1, '/__review', { file: 'plan.md', hash: hash1 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postFrom(s1, '/__review', { file: '../secret.txt', hash: hash1 })).status, 404);

    // (1) Two sequential edits to paragraph 3 plus an outside edit to paragraph 2.
    const v2 = v1.replace('Third paragraph is quite wordy and really should be tightened up nicely.', 'Third paragraph is wordy and should be tightened.');
    writeFileSync(notesPath, v2);
    const v3 = v2
      .replace('Second paragraph mentions draft.', 'Second paragraph mentions final draft.')
      .replace('Third paragraph is wordy and should be tightened.', 'Third paragraph is tight.');
    writeFileSync(notesPath, v3);

    const html3 = await (await s1.get('/plan.md')).text();
    assert.match(html3, /Tracking changes since you first opened this document · 2 changes/);
    assert.match(html3, /<ins class="diff-ins">final<\/ins>/);
    assert.match(html3, /<ins class="diff-ins">tight\.<\/ins>/);
    assert.match(html3, /<del class="diff-del">quite wordy and really should be tightened up nicely\.<\/del>/);
    const hash3 = /data-doc-hash="([0-9a-f]+)"/.exec(html3)?.[1];
    assert.equal(hash3, sourceHash(v3));

    // (2) Save v4 lands on disk BEFORE Mark reviewed is clicked for shown version v3.
    const v4 = v3 + '\n\nFourth paragraph added during review.\n';
    writeFileSync(notesPath, v4);
    const revRes = await postFrom(s1, '/__review', { file: 'plan.md', hash: hash3 });
    assert.equal(revRes.status, 200);
    // Now fetching plan.md compares v4 against reviewed v3: v4 stays shown as unreviewed!
    const html4 = await (await s1.get('/plan.md')).text();
    assert.match(html4, /1 change since you reviewed/);
    assert.match(html4, /<p class="diff-ins-block">Fourth paragraph added during review\.<\/p>/);

    // (5) Restart: close server 1, clear in-memory recent versions, start server 2 -> reviewed version v3 persists.
    s1.close();
    globalThis.__agentRoomDocVersions?.clear();
    const s2 = await serve(dir, screen);
    try {
      const htmlAfterRestart = await (await s2.get('/plan.md')).text();
      assert.match(htmlAfterRestart, /1 change since you reviewed/);
      assert.match(htmlAfterRestart, /Fourth paragraph added during review/);
      assert.equal(readReviewed(dir, 'plan.md')?.hash, hash3);

      // (7) Stale pane: render RECENT_VERSION_LIMIT + 2 newer versions so an older rendered version drops out.
      const staleSource = '# Plan\n\nStale version that will be evicted.\n';
      writeFileSync(notesPath, staleSource);
      const staleHtml = await (await s2.get('/plan.md')).text();
      const staleHash = /data-doc-hash="([0-9a-f]+)"/.exec(staleHtml)?.[1];
      for (let i = 0; i < RECENT_VERSION_LIMIT + 2; i++) {
        writeFileSync(notesPath, `# Plan\n\nNewer version ${i}.\n`);
        await (await s2.get('/plan.md')).text();
      }
      const beforeStaleReview = readReviewed(dir, 'plan.md');
      const staleRes = await postFrom(s2, '/__review', { file: 'plan.md', hash: staleHash });
      assert.equal(staleRes.status, 409);
      const staleJson = await staleRes.json();
      assert.equal(staleJson.unavailable, true);
      assert.match(staleJson.message, /This version is no longer available: the pane will show the latest/);
      // Reviewed version on disk is unchanged.
      assert.deepEqual(readReviewed(dir, 'plan.md'), beforeStaleReview);
    } finally {
      s2.close();
    }
  } finally {
    s1.close();
    rmSync(reviewedDir(dir), { recursive: true, force: true });
  }
});

test('change tracking (3): save B before the first poll is caught because poll compares against rendered hash', async () => {
  const dir = fixture();
  const screen = { clients: new Set(), transcript: [] };
  const notesPath = join(dir, 'plan.md');
  writeFileSync(notesPath, '# Plan\n\nVersion A.\n');
  const s = await serve(dir, screen);
  try {
    const htmlA = await (await s.get('/plan.md')).text();
    // Save Version B on disk BEFORE the first poll runs in the page.
    writeFileSync(notesPath, '# Plan\n\nVersion B.\n');
    let pollFn = null;
    const dom = new JSDOM(htmlA, {
      url: `${s.base}/plan.md`,
      runScripts: 'dangerously',
      beforeParse(win) {
        Object.defineProperty(win, 'parent', { value: { postMessage() {} } });
        win.setInterval = (fn) => { pollFn = fn; return 1; };
        win.scrollTo = () => {};
        win.fetch = (u, opts) => fetch(new URL(String(u), `${s.base}/plan.md`), opts);
      },
    });
    try {
      await new Promise((r) => setTimeout(r, 80));
      if (pollFn) await pollFn();
      await new Promise((r) => setTimeout(r, 80));
      const d = dom.window.document;
      assert.match(d.querySelector('main p').textContent, /Version/);
      assert.ok(d.querySelector('main ins.diff-ins'));
      assert.match(d.querySelector('main ins.diff-ins').textContent, /B\./);
      assert.match(d.querySelector('#review-bar .review-status').textContent, /1 change/);
    } finally {
      dom.window.close();
    }
  } finally {
    s.close();
    rmSync(reviewedDir(dir), { recursive: true, force: true });
  }
});

test('change tracking (4, 6): changed cell, changed box, removed box, changed chart, and top paragraph insertion', () => {
  // (4) Table cell changed, diagram box changed + removed, chart changed.
  const oldDoc = [
    '# Figures',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,10',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  Worker[Old worker] --> GoneBox[Will be removed]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"16 Nov","runs":10}]}}',
    '```',
  ].join('\n');
  const newDoc = [
    '# Figures',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,42',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  Worker[New worker] --> StayBox[Stays]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"16 Nov","runs":42}]}}',
    '```',
  ].join('\n');

  const diff4 = renderMarkdownWithDiff(oldDoc, newDoc, md);
  assert.match(diff4.html, /<td data-cell="B2" class="num diff-changed"/);
  assert.doesNotMatch(diff4.html, /<td data-cell="A2"[^>]*diff-changed/);
  assert.match(diff4.html, /data-changed-nodes="\[&quot;Worker&quot;,&quot;StayBox&quot;\]"/);
  assert.ok(diff4.removed.includes('diagram box GoneBox'));
  assert.match(diff4.html, /<div class="vl-box diff-changed"><div class="diff-chart-badge">Changed since review<\/div>/);

  // (6) Insert a paragraph near the top: one insertion shown, paragraphs below untouched.
  const base6 = '# Doc\n\nPara one.\n\nPara two.\n\nPara three.\n';
  const ins6 = '# Doc\n\nInserted near top.\n\nPara one.\n\nPara two.\n\nPara three.\n';
  const diff6 = renderMarkdownWithDiff(base6, ins6, md);
  assert.equal(diff6.changeCount, 1);
  assert.match(diff6.html, /<p class="diff-ins-block">Inserted near top\.<\/p>/);
  assert.match(diff6.html, /<p>Para one\.<\/p>\n<p>Para two\.<\/p>\n<p>Para three\.<\/p>/);
});

test('change tracking (8): pointing at a paragraph with a deletion and one below a deleted paragraph uses only current text and current paragraph number', () => {
  const oldDoc = [
    '## Section',
    '',
    'Keep the old slow path clean.',
    '',
    'This entire second paragraph will be deleted.',
    '',
    'Final paragraph stays below.',
  ].join('\n');
  const newDoc = [
    '## Section',
    '',
    'Keep the fast path clean.',
    '',
    'Final paragraph stays below.',
  ].join('\n');
  const diff = renderMarkdownWithDiff(oldDoc, newDoc, md);
  const html = page('discussions/x/notes.md', diff.html, 'discussions/x/notes.md', '/', {
    hash: sourceHash(newDoc),
    reviewed: true,
    changeCount: diff.changeCount,
    removed: diff.removed,
  });
  const posted = [];
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:5566/discussions/x/notes.md',
    runScripts: 'dangerously',
    beforeParse(win) {
      Object.defineProperty(win, 'parent', {
        value: { postMessage: (data, origin) => posted.push({ data, origin }) },
      });
    },
  });
  try {
    const win = dom.window;
    const ps = [...win.document.querySelectorAll('main p')];
    assert.equal(ps.length, 3); // edited p1, deleted p2 (.diff-del-block), current p3
    assert.ok(ps[0].querySelector('del.diff-del'));
    assert.ok(ps[1].classList.contains('diff-del-block'));

    // Select paragraph 1 (which contains <del class="diff-del">old slow</del>).
    selectElement(win, ps[0]);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 1);
    assert.equal(
      posted[0].data.text,
      'passage in discussions/x/notes.md, under "Section", paragraph 1: "Keep the fast path clean."',
    );

    // Select paragraph below the deleted paragraph: must be paragraph 2 (matching current Markdown).
    selectElement(win, ps[2]);
    win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
    assert.equal(posted.length, 2);
    assert.equal(
      posted[1].data.text,
      'passage in discussions/x/notes.md, under "Section", paragraph 2: "Final paragraph stays below."',
    );
  } finally {
    dom.window.close();
  }
});

test('change tracking fidelity: varied document renders identically to normal view and preserves ordered start, nested/task/loose lists and reference-style links across edits', () => {
  const varied = [
    '# Varied Document',
    '',
    'Opening paragraph to edit later.',
    '',
    'Paragraph with **bold**, an [inline link](https://example.com/inline), and a [reference link][spec].',
    '',
    '4. Fourth ordered item',
    '5. Fifth item with nested list',
    '   - Nested bullet one',
    '   - Nested bullet two',
    '',
    '- [x] Completed task',
    '- [ ] Pending task',
    '',
    '- Loose item one',
    '',
    '- Loose item two',
    '',
    '> Quoted wisdom with [reference link][spec].',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,10',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Alpha] --> B[Beta]',
    '```',
    '',
    '```vega-lite',
    '{"mark":"bar","data":{"values":[{"day":"16 Nov","runs":10}]}}',
    '```',
    '',
    '[spec]: https://example.com/spec',
    '',
  ].join('\n');

  const normalHtml = md.parse(varied);
  // Unchanged version (both identical string and whitespace-only difference hitting the block diff path) renders identical HTML.
  assert.equal(renderMarkdownWithDiff(varied, varied, md).html, normalHtml);
  const diffWhitespace = renderMarkdownWithDiff(varied + '\n', varied, md);
  assert.equal(diffWhitespace.changeCount, 0);
  assert.equal(diffWhitespace.html, normalHtml);

  // After editing a different paragraph, the unchanged paragraph with reference-style link, ordered start=4, nested, task, and loose lists all survive intact.
  const edited = varied.replace('Opening paragraph to edit later.', 'Opening paragraph was edited.');
  const diffEdited = renderMarkdownWithDiff(varied, edited, md);
  assert.equal(diffEdited.changeCount, 1);
  assert.match(diffEdited.html, /<a href="https:\/\/example\.com\/spec">reference link<\/a>/);
  assert.match(diffEdited.html, /<ol start="4">/);
  assert.match(diffEdited.html, /<ul>\n<li>Nested bullet one<\/li>/);
  assert.match(diffEdited.html, /<input checked="" disabled="" type="checkbox"> Completed task/);
  assert.match(diffEdited.html, /<li><p>Loose item one<\/p>\n<\/li>/);
  assert.match(diffEdited.html, /<pre><code class="language-js">const x = 1;/);
});

test('change tracking: removing a table cell and changing only an arrow in a Mermaid diagram counts and flags both', () => {
  const before = [
    '# Combined',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,10',
    '17 Nov,20',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Alpha] --> B[Beta]',
    '```',
  ].join('\n');
  const after = [
    '# Combined',
    '',
    '```csv runs',
    'day,runs',
    '16 Nov,10',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Alpha] -.-> B[Beta]',
    '```',
  ].join('\n');

  const diff = renderMarkdownWithDiff(before, after, md);
  assert.ok(diff.removed.includes('table cell runs!A3'));
  assert.ok(diff.removed.includes('table cell runs!B3'));
  // 2 removed table cells + 1 arrow-only diagram change = 3 changes.
  assert.equal(diff.changeCount, 3);
  assert.match(diff.html, /<div class="mermaid-box diff-changed" data-changed-nodes="\[\]"><div class="diff-chart-badge">Changed since review<\/div>/);
});
