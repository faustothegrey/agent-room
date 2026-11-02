import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { broadcast, handle, listFiles, messageView, pick } from '../src/docs.mjs';

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
  assert.match(page, /EventSource\('\/__events'\)/);

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

test('without a worker input (terminal mode), /__work is refused', async () => {
  const s = await serve(fixture(), { clients: new Set(), transcript: [] });
  assert.equal((await postFrom(s, '/__work', { text: 'hi' })).status, 409);
  s.close();
});

test('the auto-summarize checkbox reaches the room only from the page, and a new page gets its state and the gauges', async () => {
  const set = [];
  const gauges = [{ provider: 'claude', label: '5h', used: 20, resets: null }];
  const screen = { clients: new Set(), transcript: [], say: () => {}, auto: true, quota: gauges, setAuto: (on) => set.push(on) };
  const s = await serve(fixture(), screen);
  try {
    assert.equal((await postFrom(s, '/__auto', { on: false })).status, 204);
    assert.equal((await postFrom(s, '/__auto', { on: 'no' })).status, 400);
    assert.equal((await postFrom(s, '/__auto', { on: true }, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(set, [false]);
    const next = eventReader(await s.get('/__events'));
    const reset = await next();
    assert.deepEqual([reset.auto, reset.quota], [true, gauges]);
    for (const c of screen.clients) c.end();
  } finally {
    s.close();
  }
  const watcher = await serve(fixture(), { clients: new Set(), transcript: [] });
  assert.equal((await postFrom(watcher, '/__auto', { on: true })).status, 409);
  watcher.close();
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
  } finally { s.close(); }
});
