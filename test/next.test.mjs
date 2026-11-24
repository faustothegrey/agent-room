import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as docs from '../src/docs.mjs';
import { route } from '../src/ui.mjs';

test('new page routes contain assets and signal version changes on room events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'next-page-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html><head><script type="module" src="./assets/app.js"></script></head><body></body></html>');
  writeFileSync(join(dist, 'assets/app.js'), 'first');
  writeFileSync(join(root, 'secret'), 'secret');
  for (const dir of ['next', 'assets']) { mkdirSync(join(root, dir)); writeFileSync(join(root, dir, 'room.txt'), dir + ' room file'); }
  symlinkSync(join(root, 'secret'), join(dist, 'assets/link.js'));
  const screen = { clients: new Set(), transcript: [], nextDist: dist };
  const ctx = { id: 'room-one', cwd: root, docs, screen };
  const hub = { rooms: new Map([['one', ctx]]) };
  const server = createServer((req, res) => route(hub, req, res));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let reader;
  try {
    for (const path of ['/__next', '/r/room-one/__next']) {
      const res = await fetch(origin + path); assert.equal(res.status, 200);
      const html = await res.text();
      const asset = html.match(/src="([^"]+)"/)[1];
      assert.match(asset, /^\.\/__next\/assets\//);
      assert.equal(await (await fetch(new URL(asset, origin + path))).text(), 'first');
      assert.match(html, /agent-room-next-version/);
    }
    for (const dir of ['next', 'assets']) assert.match(await (await fetch(origin + '/r/room-one/' + dir + '/room.txt')).text(), new RegExp(dir + ' room file'));
    for (const path of ['/__next/..%2fsecret', '/__next/assets/link.js', '/r/room-one/__next/%2e%2e%2fsecret'])
      assert.equal((await fetch(origin + path)).status, 404, path);
    const { request } = await import('node:http');
    const raw = await new Promise((ok, fail) => { const r = request({ hostname: '127.0.0.1', port: server.address().port, path: '/__next/../secret' }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', fail); r.end(); });
    assert.equal(raw, 404);
    assert.equal((await fetch(origin + '/r/room-one/__next/events')).status, 404);
    const response = await fetch(origin + '/r/room-one/__events');
    reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    writeFileSync(join(dist, 'assets/app.js'), 'second');
    docs.notifyNext(screen);
    const second = new TextDecoder().decode((await reader.read()).value);
    const reset = JSON.parse(first.trim().slice(6));
    const changed = JSON.parse(second.trim().slice(6));
    assert.equal(reset.type, 'reset'); assert.equal(changed.type, 'web-version');
    assert.notEqual(reset.webVersion, changed.webVersion);
    assert.equal(screen.clients.size, 1);
    renameSync(dist, dist + '-old');
    const gap = await fetch(origin + '/__next');
    assert.equal(gap.status, 404); assert.match(await gap.text(), /Web build missing/);
    renameSync(dist + '-old', dist);
    rmSync(join(dist, 'index.html'));
    const missing = await fetch(origin + '/__next');
    assert.equal(missing.status, 404); assert.match(await missing.text(), /Web build missing/);
    assert.equal((await fetch(origin + '/r/room-one/__room')).status, 200);
  } finally {
    await reader?.cancel(); server.closeAllConnections(); await new Promise((ok) => server.close(ok));
    rmSync(root, { recursive: true, force: true });
  }
});

