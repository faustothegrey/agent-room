import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRoom } from '../src/ui.mjs';
import { listRoomsTool, listBoardsTool } from '../src/mcp.mjs';

const MCP_BIN = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));

async function withMockServer(roomsProvider, fn) {
  const server = createServer((req, res) => {
    const rooms = typeof roomsProvider === 'function' ? roomsProvider() : roomsProvider;
    if (req.url === '/__health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'agent-room', rooms: rooms.map(({ id, root, pages }) => ({ id, root, pages })) }));
      return;
    }
    const match = /^\/r\/([^/]+)\/__health$/.exec(req.url);
    const room = match && rooms.find((r) => r.id === decodeURIComponent(match[1]));
    if (room && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'agent-room', root: room.root, board: room.board }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

test('mcp room recording stores canonical realpath, deduplicates, and never removes entries', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-record-')));
  try {
    const file = join(dir, 'state', 'rooms.json');
    const roomA = join(dir, 'room-a');
    const roomB = join(dir, 'room-b');
    const linkA = join(dir, 'room-a-link');
    mkdirSync(roomA);
    mkdirSync(roomB);
    symlinkSync(roomA, linkA);

    recordRoom(linkA, file);
    recordRoom(roomA, file);
    recordRoom(roomB, file);
    rmSync(roomA, { recursive: true, force: true });
    // Recording another room never removes roomA even though roomA was deleted.
    const roomC = join(dir, 'room-c');
    mkdirSync(roomC);
    recordRoom(roomC, file);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved, [roomA, roomB, roomC]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp list_rooms merges saved and running rooms, skips missing folders, and handles unreachable server', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-rooms-')));
  try {
    const roomsFile = join(dir, 'rooms.json');
    const runningRoom = join(dir, 'alpha');
    const stoppedRoom = join(dir, 'beta');
    const serverOnlyRoom = join(dir, 'gamma');
    const missingRoom = join(dir, 'deleted-room');
    for (const d of [runningRoom, stoppedRoom, serverOnlyRoom]) mkdirSync(d);

    writeFileSync(roomsFile, JSON.stringify([runningRoom, stoppedRoom, missingRoom]) + '\n');

    await withMockServer([
      { id: 'a1', root: runningRoom, board: 'discussions/2026-11-22-live-topic', pages: 1 },
      { id: 'g1', root: serverOnlyRoom, board: null, pages: 0 },
    ], async (port) => {
      const res = await listRoomsTool({ port, roomsFile });
      assert.equal(res.isError, undefined);
      const text = res.content[0].text;
      assert.match(text, new RegExp(`${runningRoom} — running, active: discussions/2026-11-22-live-topic`));
      assert.match(text, new RegExp(`${stoppedRoom} — not running on this server`));
      assert.match(text, new RegExp(`${serverOnlyRoom} — running, active: none`));
      assert.doesNotMatch(text, /deleted-room/);
      assert.match(text, /Skipped 1 saved folder that no longer exists\./);
    });

    const deadPort = await unusedPort();
    const offline = await listRoomsTool({ port: deadPort, roomsFile });
    assert.equal(offline.isError, undefined);
    const offlineText = offline.content[0].text;
    assert.match(offlineText, new RegExp(`No agent-room server answered on 127\\.0\\.0\\.1:${deadPort}`));
    assert.match(offlineText, new RegExp(`${runningRoom} — unknown`));
    assert.match(offlineText, new RegExp(`${stoppedRoom} — unknown`));
    assert.match(offlineText, /Skipped 1 saved folder that no longer exists\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp list_boards lists open dated discussions and brainstorms and matches active status by realpath', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-discs-')));
  try {
    const room = join(dir, 'proj');
    const roomLink = join(dir, 'proj-link');
    const plain = join(dir, 'not-a-room');
    mkdirSync(join(room, 'discussions', '2026-11-22-open-one'), { recursive: true });
    mkdirSync(join(room, 'discussions', 'archive', '2026-11-01-old-one'), { recursive: true });
    mkdirSync(join(room, 'discussions', 'deferred', '2026-11-02-later-one'), { recursive: true });
    mkdirSync(join(room, 'discussions', 'not-dated'), { recursive: true });
    writeFileSync(join(room, 'discussions', 'README.md'), '# index\n');
    mkdirSync(join(room, 'brainstorms', '2026-11-21-wild-idea'), { recursive: true });
    mkdirSync(join(room, 'brainstorms', 'misc'), { recursive: true });
    mkdirSync(plain);
    symlinkSync(room, roomLink);

    // Running on server (matched through symlink via realpath)
    await withMockServer([
      { id: 'p1', root: room, board: 'discussions/2026-11-22-open-one', pages: 1 },
    ], async (port) => {
      const res = await listBoardsTool({ root: roomLink }, { port });
      assert.equal(res.isError, undefined);
      const text = res.content[0].text;
      assert.match(text, new RegExp(`Room: ${room}`));
      assert.match(text, /Status: running/);
      assert.match(text, /2026-11-22-open-one \(sprint\) \[active\]/);
      assert.match(text, /2026-11-21-wild-idea \(brainstorm\)(?! \[active\])/);
      assert.doesNotMatch(text, /2026-11-01-old-one/);
      assert.doesNotMatch(text, /2026-11-02-later-one/);
      assert.doesNotMatch(text, /not-dated/);
      assert.doesNotMatch(text, /README\.md/);
      assert.doesNotMatch(text, /misc/);
    });

    // Server answers without this room
    await withMockServer([], async (port) => {
      const res = await listBoardsTool({ root: room }, { port });
      assert.equal(res.isError, undefined);
      assert.match(res.content[0].text, /Status: not running on this server/);
    });

    // No server answers
    const deadPort = await unusedPort();
    const offline = await listBoardsTool({ root: room }, { port: deadPort });
    assert.equal(offline.isError, undefined);
    assert.match(offline.content[0].text, new RegExp(`running status unknown \\(no server answered on port ${deadPort}\\)`));

    // Non-room folder returns an error
    const bad = await listBoardsTool({ root: plain }, { port: deadPort });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Not a room folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp stdio server handles initialize, ping, tools/list, and tools/call over JSON-RPC', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-stdio-')));
  try {
    const home = join(dir, 'home');
    const room = join(dir, 'room');
    mkdirSync(join(home, '.local', 'state', 'agent-room'), { recursive: true });
    mkdirSync(join(room, 'discussions', '2026-11-22-stdio-test'), { recursive: true });
    writeFileSync(join(home, '.local', 'state', 'agent-room', 'rooms.json'), JSON.stringify([room]) + '\n');

    await withMockServer([
      { id: 'r1', root: room, board: 'discussions/2026-11-22-stdio-test', pages: 1 },
    ], async (port) => {
      const child = spawn(process.execPath, [MCP_BIN], {
        env: { ...process.env, HOME: home, AGENT_ROOM_PORT: String(port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const responses = [];
      let buf = '';
      let wake = null;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            responses.push(JSON.parse(line));
            wake?.();
          }
        }
      });
      const nextMsg = async () => {
        while (!responses.length) await new Promise((r) => { wake = r; });
        return responses.shift();
      };
      const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

      try {
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
        const init = await nextMsg();
        assert.equal(init.id, 1);
        assert.equal(init.result.protocolVersion, '2025-11-25');
        assert.deepEqual(init.result.capabilities, { tools: {} });

        // Notification: must produce no response
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'ping' });
        const pong = await nextMsg();
        assert.equal(pong.id, 2);
        assert.deepEqual(pong.result, {});

        send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
        const listed = await nextMsg();
        assert.equal(listed.id, 3);
        assert.deepEqual(listed.result.tools.map((t) => t.name), ['list_rooms', 'list_boards']);

        send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_rooms', arguments: {} } });
        const roomsRes = await nextMsg();
        assert.equal(roomsRes.id, 4);
        assert.match(roomsRes.result.content[0].text, new RegExp(`${room} — running, active: discussions/2026-11-22-stdio-test`));

        send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_boards', arguments: { root: room } } });
        const discsRes = await nextMsg();
        assert.equal(discsRes.id, 5);
        assert.match(discsRes.result.content[0].text, /2026-11-22-stdio-test \(sprint\) \[active\]/);

        send({ jsonrpc: '2.0', id: 6, method: 'unknown/method' });
        const errRes = await nextMsg();
        assert.equal(errRes.id, 6);
        assert.equal(errRes.error.code, -32601);
      } finally {
        child.stdin.end();
        await new Promise((done) => child.once('exit', done));
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
