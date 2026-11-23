import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
      const m = out.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/);
      if (m && out.includes('This terminal only shows a log')) done(m[1]);
    }));

    const events = (await fetch(`${base}__events`)).body.getReader();
    let buf = '';
    // The next event, skipping header refreshes ('room'): the screen sends them whenever the header may change.
    const next = async () => {
      for (;;) {
        while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await events.read()).value);
        const [chunk, ...rest] = buf.split('\n\n');
        buf = rest.join('\n\n');
        const event = JSON.parse(chunk.replace(/^data: /, ''));
        if (event.type !== 'room') return event;
      }
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
          const match = out.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/);
          if (match) resolve(match[1]);
        });
      });
      const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(base).origin }, body: JSON.stringify(value) });
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
test('Restart: a new server process on the same port, resuming the discussion in use', { timeout: 20000 }, async () => {
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
      const m = out.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/);
      if (m) done(m[1]);
    }));
    const health = async () => { try { return await (await fetch(base + '__health')).json(); } catch { return null; } };
    const say = (text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const until = async (check) => { for (const t0 = Date.now(); Date.now() - t0 < 10000;) { const h = await health(); if (check(h)) return h; await new Promise((r) => setTimeout(r, 100)); } assert.fail('timed out'); };

    const before = await health();
    assert.equal(before.app, 'agent-room');
    assert.equal(before.pid, cli.pid);
    await say('/resume 2026-11-03-a-topic');
    await until((h) => h?.discussion === 'discussions/2026-11-03-a-topic');

    await say('/restart');
    assert.equal(await exited, 0);
    const after = await until((h) => h && h.pid !== before.pid);
    newPid = after.pid;
    assert.equal(after.discussion, 'discussions/2026-11-03-a-topic'); // resumed there
    assert.match(out, /Restarting: a new process takes over the server\./);

    await say('/quit');
    await until((h) => h === null);
    newPid = null;
  } finally {
    cli.kill();
    if (newPid) try { process.kill(newPid); } catch {}
  }
});

// Two real server processes, with fake provider CLIs: proves the app restores native session
// identifiers and unread-message positions after Quit, rather than replaying the chat as context.
// The second starts in the discussion with --reopen, as Restart starts the new process.
test('Quit room, then start again in the discussion: its checkpoint restores the discussion and worker provider sessions', { timeout: 20000 }, async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'pause-home-'));
  const root = mkdtempSync(join(tmpdir(), 'pause-room-'));
  const bin = join(home, 'bin'), callsFile = join(home, 'calls.jsonl');
  mkdirSync(bin);
  const fake = `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => input += d);
process.stdin.on('end', () => {
  const args = process.argv.slice(2), codex = process.argv[1].endsWith('codex');
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ codex, args, input }) + '\\n');
  if (codex) {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'saved-thread' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PASS' } }));
  } else console.log(JSON.stringify({ result: args.includes('--no-session-persistence') ? 'Memory test' : args[args.indexOf('--append-system-prompt') + 1]?.includes('Read me first: for the WORKER agent only') ? 'Worker reply' : 'PASS' }));
});
`;
  for (const name of ['claude', 'codex']) writeFileSync(join(bin, name), fake, { mode: 0o755 });
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'initial');
  const children = [];
  async function open(extra = []) {
    const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', root, '--port', '0', ...extra], {
      env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, CALLS_FILE: callsFile },
    });
    children.push(cli);
    const exited = new Promise((done) => cli.on('exit', done));
    let output = '';
    cli.stderr.on('data', (d) => output += d);
    const base = await new Promise((done, fail) => {
      cli.once('exit', () => fail(new Error(output)));
      cli.stdout.on('data', (d) => {
        output += d;
        const m = output.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/);
        if (m) done(m[1]);
      });
    });
    const reader = (await fetch(base + '__events')).body.getReader();
    let buffer = '';
    async function next() {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream ended: ' + output);
        buffer += new TextDecoder().decode(value);
      }
      const at = buffer.indexOf('\n\n'), chunk = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      return JSON.parse(chunk.replace(/^data: /, ''));
    }
    async function until(predicate) {
      for (;;) { const ev = await next(); if (predicate(ev)) return ev; }
    }
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { next, until, exited, say: (text) => post('__say', { text }), work: (text) => post('__work', { text }) };
  }
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  try {
    const first = await open(['--agents', 'claude:A:sonnet,codex:B:my-model', '--worker', 'claude:W:haiku']);
    await first.next();
    await first.say('Before quit');
    const room = await first.until((e) => e.type === 'room' && e.room.active);
    const name = room.room.active.slice('discussions/'.length);
    await first.until((e) => e.type === 'message' && e.message.speaker === 'B');
    await first.work('Worker before quit');
    await first.until((e) => e.type === 'work' && e.message.speaker === 'W');
    const original = calls();
    const claude = original.find((c) => c.input.includes('Before quit') && !c.args.includes('--no-session-persistence'));
    const worker = original.find((c) => c.input.includes('Worker before quit'));
    assert.ok(worker);
    await first.say('/quit'); assert.equal(await first.exited, 0);

    const second = await open(['--reopen', name]); // no original provider/model flags supplied
    const resumed = await second.until((e) => e.type === 'reset' && e.room?.active && e.messages.length);
    assert.equal(resumed.room.active, 'discussions/' + name);
    assert.ok(resumed.messages.some((m) => m.speaker === 'User' && /Before quit/.test(m.html)));
    assert.ok(resumed.worker.some((m) => m.speaker === 'W' && /Worker reply/.test(m.html)));
    assert.deepEqual(resumed.room.checkpoints.map((c) => [c.name, c.kind]), [[name, 'full']]);
    await second.say('After resume');
    await second.until((e) => e.type === 'message' && e.message.speaker === 'B');
    await second.work('Worker after resume');
    await second.until((e) => e.type === 'work' && e.message.speaker === 'W');
    const continued = calls().slice(original.length);
    const a = continued.find((c) => !c.codex && c.input.includes('After resume'));
    assert.equal(a.args[a.args.indexOf('--resume') + 1], claude.args[claude.args.indexOf('--session-id') + 1]);
    assert.equal(a.args[a.args.indexOf('--model') + 1], 'sonnet');
    assert.doesNotMatch(a.input, /Before quit|Participants:/);
    const b = continued.find((c) => c.codex && c.args[0] === 'exec'); // not the startup's `codex login status`
    assert.deepEqual(b.args.slice(0, 2), ['exec', 'resume']);
    assert.ok(b.args.includes('saved-thread'));
    assert.equal(b.args[b.args.indexOf('-m') + 1], 'my-model');
    const w = continued.find((c) => c.input.includes('Worker after resume'));
    assert.equal(w.args[w.args.indexOf('--resume') + 1], worker.args[worker.args.indexOf('--session-id') + 1]);
    assert.equal(w.args[w.args.indexOf('--model') + 1], 'haiku');
    assert.doesNotMatch(w.input, /Worker before quit|Your working directory is/);
    await second.say('/quit'); assert.equal(await second.exited, 0);
  } finally {
    for (const cli of children) cli.kill();
  }
});

test('CLI accepts agy for discussion and worker and exposes both in settings', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-agy-'));
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname,
    '--cwd', dir, '--port', '0', '--agents', 'agy:A:gemini-4-argon-high', '--worker', 'agy:W']);
  const exited = new Promise((done) => cli.once('exit', done));
  try {
    let out = '', errors = '';
    cli.stderr.on('data', (d) => { errors += d; });
    const base = await new Promise((resolve, reject) => {
      cli.once('error', reject);
      cli.once('exit', (code) => reject(new Error(`CLI exited ${code}: ${errors}`)));
      cli.stdout.on('data', (d) => {
        out += d;
        const match = out.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/);
        if (match) resolve(match[1]);
      });
    });
    const data = await (await fetch(base + '__settings')).json();
    assert.deepEqual(data.settings, { agents: [{ provider: 'agy', name: 'A', model: 'gemini-4-argon-high' }],
      worker: { provider: 'agy', name: 'W', model: '' } });
    await fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(base).origin }, body: JSON.stringify({ text: '/quit' }) });
    assert.equal(await exited, 0);
  } finally { cli.kill(); }
});

test('CLI flags remain the defaults for a new brainstorm and a beside discussion', { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'screen-launch-defaults-'));
  const room = join(home, 'room'), bin = join(home, 'bin'), config = join(home, '.config', 'agent-room');
  mkdirSync(room); mkdirSync(bin); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'defaults.json'), JSON.stringify({ agents: [{ provider: 'claude', name: 'Saved', model: '' }],
    worker: { provider: 'claude', name: 'SavedWorker', model: '' } }));
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: process.argv.includes('--no-session-persistence') ? 'Topic' : 'PASS' })));\n`, { mode: 0o755 });
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', room, '--port', '0',
    '--agents', 'claude:FlagA,claude:FlagB', '--worker', 'agy:FlagW:chosen'],
    { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH } });
  const exited = new Promise((done) => cli.once('exit', done));
  try {
    let out = '';
    const base = await new Promise((resolve, reject) => {
      cli.once('exit', (code) => reject(new Error('CLI exited ' + code)));
      cli.stdout.on('data', (d) => { out += d; const match = out.match(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/); if (match) resolve(match[1]); });
    });
    const reader = (await fetch(base + '__events')).body.getReader();
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) buffer += new TextDecoder().decode((await reader.read()).value);
      const at = buffer.indexOf('\n\n'), chunk = buffer.slice(0, at); buffer = buffer.slice(at + 2);
      return JSON.parse(chunk.replace(/^data: /, ''));
    };
    const until = async (fn) => { for (;;) { const e = await next(); if (fn(e)) return e; } };
    const say = (text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const flags = { agents: [{ provider: 'claude', name: 'FlagA', model: '' }, { provider: 'claude', name: 'FlagB', model: '' }],
      worker: { provider: 'agy', name: 'FlagW', model: 'chosen' } };
    await next();
    await say('/brainstorm'); await until((e) => e.type === 'note' && /New brainstorm/.test(e.text));
    assert.deepEqual((await (await fetch(base + '__settings')).json()).settings, flags);
    await say('/new'); await until((e) => e.type === 'note' && /New discussion: your next message names it/.test(e.text)); // the new brainstorm, not started, becomes it
    assert.deepEqual((await (await fetch(base + '__settings')).json()).settings, flags);
    await say('hello'); await until((e) => e.type === 'turn');
    await say('/new');
    const nextRoom = await until((e) => e.type === 'goto');
    assert.deepEqual((await (await fetch(new URL(nextRoom.url.replace('__room', '__settings'), base))).json()).settings, flags);
    await fetch(new URL('/__shutdown', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(await exited, 0);
  } finally { cli.kill(); }
});
