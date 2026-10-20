import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle, listFiles, pick } from '../src/docs.mjs';

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

async function serve(dir) {
  const server = createServer((req, res) => handle(req, res, dir));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (path) => fetch(base + path), close: () => server.close() };
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
