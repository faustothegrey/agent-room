import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// UI mode end to end: the real CLI, driven only through the discussion screen's endpoints, the way
// the page drives it. Output is piped, so no browser opens; nothing here starts an agent.
test('UI mode: the screen is the room\'s input, its replies come back as events, Quit ends the room', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-test-'));
  const cli = spawn('node', [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', dir]);
  const exited = new Promise((done) => cli.on('exit', done));
  try {
    let out = '';
    const base = await new Promise((done) => cli.stdout.on('data', (d) => {
      out += d;
      // The banner may arrive in several chunks: wait for its last line.
      const m = out.match(/Discussion screen: (http:\/\/127\.0\.0\.1:\d+\/)__room/);
      if (m && out.includes('This terminal only shows a log')) done(m[1]);
    }));

    const events = (await fetch(`${base}__events`)).body.getReader();
    let buf = '';
    const next = async () => {
      while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await events.read()).value);
      const [chunk, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      return JSON.parse(chunk.replace(/^data: /, ''));
    };
    const say = (text) => fetch(`${base}__say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

    const reset = await next();
    assert.equal(reset.input, true);

    assert.equal((await say('/usage')).status, 204);
    const usage = await next();
    assert.equal(usage.type, 'note');
    assert.match(usage.text, /Usage this session/);

    await say('@nobody hello'); // an unknown agent: refused before anything is sent to an agent
    const refused = await next();
    assert.deepEqual([refused.type, refused.error], ['note', true]);
    assert.match(refused.text, /Unknown agent "@nobody"/);

    await say('/docs'); // the screen opens its own file list
    assert.deepEqual(await next(), { type: 'files' });

    await say('/quit');
    assert.deepEqual(await next(), { type: 'ended' });
    assert.equal(await exited, 0);
    assert.deepEqual(readdirSync(dir), []); // opening a room, with no message sent, writes nothing in it
  } finally {
    cli.kill(); // no-op once it has exited; stops a stalled run from hanging the suite
  }
});

test('saved provider/model choices survive CLI restarts and explicit CLI flags override them', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-defaults-test-'));
  const settings = { agents: [
    { provider: 'codex', name: 'One', model: 'gpt-6.1-sol' },
    { provider: 'claude', name: 'Two', model: 'opus' },
  ], worker: { provider: 'codex', name: 'Worker', model: 'gpt-6.1-terra' } };
  async function room(extra, check) {
    const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', home, '--port', '0', ...extra],
      { env: { ...process.env, HOME: home } });
    const exited = new Promise((resolve) => cli.once('exit', resolve));
    try {
      let out = '', errors = '';
      cli.stderr.on('data', (d) => { errors += d; });
      const base = await new Promise((resolve, reject) => {
        cli.once('error', reject);
        cli.once('exit', (code) => reject(new Error(`CLI exited ${code}: ${errors}`)));
        cli.stdout.on('data', (d) => {
          out += d;
          const match = out.match(/Discussion screen: (http:\/\/127\.0\.0\.1:\d+\/)__room/);
          if (match) resolve(match[1]);
        });
      });
      const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base.slice(0, -1) }, body: JSON.stringify(value) });
      await check(base, post);
      await post('__say', { text: '/quit' });
      assert.equal(await exited, 0);
    } finally { cli.kill(); }
  }
  await room([], async (base, post) => {
    const saved = await post('__settings', settings);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).applied, true);
    assert.deepEqual((await (await fetch(base + '__settings')).json()).settings, settings);
  });
  await room([], async (base) => {
    assert.deepEqual((await (await fetch(base + '__settings')).json()).settings, settings);
  });
  await room(['--agents', 'claude:Explicit:sonnet'], async (base) => {
    const data = await (await fetch(base + '__settings')).json();
    assert.deepEqual(data.settings.agents, [{ provider: 'claude', name: 'Explicit', model: 'sonnet' }]);
    assert.deepEqual(data.settings.worker, settings.worker);
    assert.deepEqual(data.defaults, settings); // a CLI override never rewrites saved defaults
  });
});

// /restart: a new process takes over the same address, in the discussion in use; the old one exits.
test('Restart: a new server process on the same port, re-opening the discussion in use', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-test-'));
  mkdirSync(join(dir, 'discussions', '2026-11-03-a-topic'), { recursive: true });
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', dir, '--port', '0'],
    { env: { ...process.env, HOME: dir } });
  const exited = new Promise((done) => cli.once('exit', done));
  let newPid = null;
  try {
    let out = '';
    const base = await new Promise((done) => cli.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/Discussion screen: (http:\/\/127\.0\.0\.1:\d+\/)__room/);
      if (m) done(m[1]);
    }));
    const health = async () => { try { return await (await fetch(base + '__health')).json(); } catch { return null; } };
    const say = (text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const until = async (check) => { for (const t0 = Date.now(); Date.now() - t0 < 10000;) { const h = await health(); if (check(h)) return h; await new Promise((r) => setTimeout(r, 100)); } assert.fail('timed out'); };

    const before = await health();
    assert.equal(before.app, 'agent-room');
    assert.equal(before.pid, cli.pid);
    await say('/reopen 2026-11-03-a-topic');
    await until((h) => h?.discussion === 'discussions/2026-11-03-a-topic');

    await say('/restart');
    assert.equal(await exited, 0);
    const after = await until((h) => h && h.pid !== before.pid);
    newPid = after.pid;
    assert.equal(after.discussion, 'discussions/2026-11-03-a-topic'); // re-opened there
    assert.match(out, /Restarting: a new process takes over this room\./);

    await say('/quit');
    await until((h) => h === null);
    newPid = null;
  } finally {
    cli.kill();
    if (newPid) try { process.kill(newPid); } catch {}
  }
});
