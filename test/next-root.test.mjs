import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { route } from '../src/ui.mjs';
import * as docs from '../src/docs.mjs';

test('root React page redirects to the first room like the legacy page in UI and terminal modes', async () => {
  for (const noScreen of [false, true]) {
    const screen = { clients: new Set(), transcript: [] };
    const ctx = { id: 'first', cwd: process.cwd(), docs, screen, noScreen };
    const hub = { noScreen, rooms: new Map([['first', ctx]]) };
    const server = createServer((req, res) => route(hub, req, res));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const page of ['__room', '__next']) {
        const res = await fetch(`${origin}/${page}`, { redirect: 'manual' });
        assert.equal(res.status, 302); assert.equal(res.headers.get('location'), `/r/first/${page}`);
      }
      hub.rooms.clear();
      assert.equal((await fetch(origin + '/__next', { redirect: 'manual' })).status, 404);
    } finally { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); }
  }
});
