import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../src/docs.mjs';
import { handleNotes, notesDirectory } from '../src/notes.mjs';
import { refusal } from '../src/host-shell.mjs';

// The Notes pane's server side (notes.mjs), reached through the room page's handler (docs.mjs).
process.env.HOME = mkdtempSync(join(tmpdir(), 'notes-home-'));
const room = () => mkdtempSync(join(tmpdir(), 'notes-room-'));
async function serve(dir) {
  const server = createServer((req, res) => handle(req, res, dir, { transcript: [], clients: new Set() }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base.slice(0, -1), ...headers }, body: JSON.stringify(body) });
  return { base, post, list: async () => (await fetch(base + '__notes')).json(), close: () => { server.closeAllConnections(); server.close(); } };
}

test('notes: create, list, read, save exactly as typed, remove; stored outside the room, one set per room folder', async () => {
  const dir = room(), other = room(), s = await serve(dir), t = await serve(other);
  try {
    assert.deepEqual(await s.list(), []);
    const text = '# Groceries\r\n\n  milk  \n\ttabs and trailing spaces   \n\n';
    let r = await s.post('__notes/new', { text });
    assert.equal(r.status, 201);
    const a = await r.json();
    assert.equal(a.title, 'Groceries'); assert.equal(a.text, text);
    const folder = notesDirectory(dir);
    assert.equal(folder, join(process.env.HOME, '.local', 'share', 'agent-room', 'notes', folder.split('/').at(-1)));
    assert.ok(!folder.startsWith(realpathSync(dir)));
    assert.deepEqual(readdirSync(dir), []); // nothing in the room's folder
    assert.equal(readFileSync(join(folder, a.id + '.md'), 'utf8'), text); // byte for byte
    // Same title again: a second note, the first untouched.
    const b = await (await s.post('__notes/new', { text: '# Groceries\nother' })).json();
    assert.notEqual(b.id, a.id);
    assert.deepEqual((await s.list()).map((n) => n.title).sort(), ['Groceries', 'Groceries']);
    assert.ok((await s.list()).every((n) => n.savedAt && !('text' in n)));
    // Renaming by its first line keeps its file; the other note is unchanged.
    r = await s.post('__notes/save', { id: a.id, text: 'Renamed\nbody' });
    assert.equal(r.status, 200); assert.equal((await r.json()).title, 'Renamed');
    assert.deepEqual(readdirSync(folder).sort(), [a.id + '.md', b.id + '.md'].sort());
    assert.equal((await (await fetch(s.base + '__notes/read?id=' + b.id)).json()).text, '# Groceries\nother');
    assert.equal((await (await fetch(s.base + '__notes/read?id=' + a.id)).json()).text, 'Renamed\nbody');
    // The other room's folder has its own set.
    assert.deepEqual(await t.list(), []);
    assert.equal((await t.post('__notes/save', { id: a.id, text: 'x' })).status, 404);
    // Remove.
    assert.equal((await s.post('__notes/remove', { id: a.id })).status, 204);
    assert.deepEqual((await s.list()).map((n) => n.id), [b.id]);
    assert.equal((await s.post('__notes/remove', { id: a.id })).status, 404);
    assert.equal((await s.post('__notes/save', { id: a.id, text: 'back?' })).status, 404); // a removed note isn't recreated
    assert.equal((await fetch(s.base + '__notes/read?id=' + a.id)).status, 404);
    // An empty first line: Untitled.
    assert.equal((await (await s.post('__notes/new', { text: '' })).json()).title, 'Untitled');
  } finally { s.close(); t.close(); }
});

test('notes: tags require the entire last non-empty line and never supply the title', async () => {
  const s = await serve(room());
  try {
    const cases = [
      ['Title\n#Work #[ Big   Idea ] #work #[big idea]\n\n', 'Title', ['work', 'big idea']],
      ['#solo', 'Untitled', ['solo']],
      ['#[ Only   Tags ]', 'Untitled', ['only tags']],
      ['Title\n#', 'Title', []],
      ['# Heading', 'Heading', []],
      ['Title\n#[unclosed', 'Title', []],
      ['Title\n#work ordinary', 'Title', []],
      ['Title\n#work #[ ]', 'Title', []],
      ['Title\n#work\nordinary', 'Title', []],
    ];
    for (const [text, title, tags] of cases) {
      const created = await (await s.post('__notes/new', { text })).json();
      assert.equal(created.title, title, text); assert.deepEqual(created.tags, tags, text);
      const listed = (await s.list()).find((n) => n.id === created.id);
      assert.deepEqual(listed.tags, tags, text);
    }
  } finally { s.close(); }
});

test('notes: bad ids, bodies and methods are refused; ids never reach outside the folder', async () => {
  const s = await serve(room());
  try {
    for (const id of ['../../x', '', 'a.md', '20261111-120000-zzzzzzzz']) {
      assert.equal((await s.post('__notes/save', { id, text: 'x' })).status, 404, id);
      assert.equal((await s.post('__notes/remove', { id })).status, 404, id);
    }
    assert.equal((await s.post('__notes/new', {})).status, 400); // no text
    assert.equal((await s.post('__notes/new', { text: 'x' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fetch(s.base + '__notes/new', { method: 'PUT' })).status, 405);
    assert.equal((await s.post('__notes/rename', { text: 'x' })).status, 405);
  } finally { s.close(); }
});

// Requests a test can't send from a LAN address: a fake one, as in host-shell.test.mjs.
function fake(path, { from = '127.0.0.1', host = '127.0.0.1:5566', origin, method = 'GET' } = {}) {
  const headers = { host }; if (origin) headers.origin = origin; if (method === 'POST') headers['content-type'] = 'application/json';
  const req = { url: path, method, headers, socket: { remoteAddress: from }, on() {} };
  let status = 'pending'; // a POST that passed the checks waits for its body
  const res = { writeHead(s) { status = s; }, end() {} };
  return handleNotes(req, res, new URL(path, 'http://x'), room()) ? status : 'not handled';
}

test('notes: from the room\'s own addresses (this machine\'s LAN ones too), never a foreign Host or Origin', () => {
  assert.equal(fake('/__notes'), 200);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
  const mine = [`${hostname()}:5566`, `${hostname().replace(/\.local$/, '')}.local:5566`, ...(lan ? [`${lan}:5566`] : [])];
  for (const host of mine) {
    assert.equal(fake('/__notes', { from: lan ?? '192.168.1.20', host }), 200, host); // a page on another device
    assert.equal(fake('/__notes/new', { from: lan ?? '192.168.1.20', host, method: 'POST', origin: `http://${host}` }), 'pending', host);
    assert.equal(fake('/__notes', { host, origin: 'http://127.0.0.1:5566' }), 403, host); // Origin not matching Host
  }
  for (const host of ['rebind.example:5566', '203.0.113.9:5566', 'box.tail1234.ts.net:5566', '']) assert.equal(fake('/__notes', { host }), 403, host);
  assert.equal(fake('/__notes/remove', { method: 'POST', origin: 'http://evil.example' }), 403); // another site's page
  assert.equal(fake('/__notes/new', { method: 'POST', origin: 'http://evil.example' }), 403);
  assert.equal(fake('/__notes', { origin: 'http://localhost:5566' }), 403); // Origin not matching Host
  assert.equal(fake('/__notes', { host: 'localhost:5566' }), 200);
  assert.equal(fake('/__notes', { from: '::1', host: '[::1]:5566' }), 200);
  assert.equal(fake('/__notes', { from: '::1', host: '[::1]:5566', origin: 'http://[::1]:5566' }), 200);
  // The terminal's checks are unchanged: loopback only.
  for (const from of ['192.168.1.20', '::ffff:192.168.1.20', 'fe80::1']) assert.equal(refusal({ socket: { remoteAddress: from }, headers: { host: '127.0.0.1:5566' } }, { originRequired: false })?.[0], 403, from);
  if (lan) assert.equal(refusal({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: `${lan}:5566` } }, { originRequired: false })?.[0], 403);
  assert.equal(refusal({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5566' } }, { originRequired: false }), null);
  assert.equal(fake('/__other'), 'not handled'); // not a notes path: left to the page's other handlers
});
