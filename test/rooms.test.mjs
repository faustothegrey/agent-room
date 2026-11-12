import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One real server process with two rooms (the second brought in as Restart does, with --room), and
// fake provider CLIs. Each room is reached only at its own address; their state, files and rounds
// stay apart; Quit room ends one room and stops its worker while the other keeps running.
test('one server, two rooms: separate state and files, independent rounds, Quit room ends only one', { timeout: 40000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooms-home-'));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'rooms-repo-')));
  const alpha = join(repo, 'alpha'), beta = join(repo, 'beta');
  for (const d of [alpha, beta]) mkdirSync(join(d, 'discussions'), { recursive: true });
  // A document in alpha, a secret beside the rooms, and a link from beta to alpha's document.
  mkdirSync(join(alpha, 'discussions', '2026-11-08-alpha-topic'));
  const alphaDoc = join(alpha, 'discussions', '2026-11-08-alpha-topic', 'notes.md');
  writeFileSync(alphaDoc, '# alpha only\n');
  writeFileSync(join(repo, 'secret.txt'), 'secret');
  symlinkSync(alphaDoc, join(beta, 'discussions', 'link.md'));
  // Links that stay inside beta's folder: to a file, and to a folder.
  mkdirSync(join(beta, 'material'));
  writeFileSync(join(beta, 'material', 'own.md'), '# beta material\n');
  symlinkSync(join(beta, 'material', 'own.md'), join(beta, 'discussions', 'own-link.md'));
  symlinkSync(join(beta, 'material'), join(beta, 'discussions', 'material-link'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'initial');

  const bin = join(home, 'bin'), pids = join(home, 'pids');
  mkdirSync(bin);
  // claude: a title for the first message; "slow" turns take 3s; a worker "long task" never ends by itself.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => input += d);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const reply = (result) => console.log(JSON.stringify({ result }));
  if (args.includes('--no-session-persistence')) return reply('A topic');
  if (args.includes('Bash') && input.includes('long task')) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n' + child.pid + '\\n'); return setTimeout(() => reply('done'), 60000); }
  setTimeout(() => reply('PASS'), input.includes('slow') ? 3000 : 0);
});
`, { mode: 0o755 });

  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', alpha, '--port', '0',
    '--agents', 'claude:Ada', '--worker', 'claude:Wa',
    '--room', JSON.stringify({ cwd: beta, agents: 'claude:Bea', worker: 'claude:Wb' })],
  { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH } });
  const exited = new Promise((done) => cli.once('exit', done));
  let out = '';
  cli.stderr.on('data', (d) => { out += d; });
  try {
    const [baseA, baseB] = await new Promise((done, fail) => {
      cli.once('exit', () => fail(new Error(out)));
      cli.stdout.on('data', (d) => {
        out += d;
        const found = [...out.matchAll(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/g)].map((m) => m[1]);
        if (found.length === 2) done(found);
      });
    });
    const server = new URL(baseA).origin;
    assert.notEqual(baseA, baseB);
    // Each log line says its room.
    assert.match(out, /^\[alpha\] Room: Ada/m);
    assert.match(out, /^\[beta\] Room: Bea/m);

    const stream = async (base) => {
      const reader = (await fetch(base + '__events')).body.getReader();
      let buffer = '';
      const next = async () => {
        while (!buffer.includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buffer += new TextDecoder().decode(value);
        }
        const at = buffer.indexOf('\n\n'), chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        return JSON.parse(chunk.replace(/^data: /, ''));
      };
      return { next, until: async (p) => { for (;;) { const ev = await next(); if (p(ev)) return ev; } } };
    };
    const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = await stream(baseA), b = await stream(baseB);
    const [resetA, resetB] = [await a.next(), await b.next()];
    assert.equal(resetA.room.folder, alpha);
    assert.equal(resetB.room.folder, beta);
    assert.deepEqual(resetA.room.agents, ['Ada']);
    assert.deepEqual(resetB.room.agents, ['Bea']);
    // Two rooms in one Git repository: the second gets no worker, and says why.
    // (The Worker tab's line is read in the background at start: it may come after the first reset.)
    const infoA = resetA.workerInfo ?? (await a.until((e) => e.type === 'workerinfo')).info;
    const infoB = resetB.workerInfo ?? (await b.until((e) => e.type === 'workerinfo')).info;
    assert.equal(infoB.disabled, true);
    assert.match(infoB.lines[0], /No worker in this room: .*alpha is already open on this server in the same Git repository/);
    assert.notEqual(infoA.disabled, true);

    // The server's own addresses: its rooms, and /__room opening the first one.
    const health = await (await fetch(server + '/__health')).json();
    assert.equal(health.app, 'agent-room');
    assert.deepEqual(health.rooms.map((r) => r.root), [alpha, beta]);
    const first = await fetch(server + '/__room', { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.equal(new URL(first.headers.get('location'), server).href, baseA + '__room');
    assert.equal((await fetch(server + '/r/no-such-room/__room')).status, 404);
    assert.equal((await fetch(server + '/__events')).status, 404);
    // Switch room…: this server's rooms, each marked from the asking room's side.
    const listed = await (await fetch(baseB + '__rooms')).json();
    assert.deepEqual(listed.map((r) => [r.root, r.current, r.pages]), [[alpha, false, 1], [beta, true, 1]]);

    // A slow round in alpha doesn't hold up beta's.
    const t0 = Date.now();
    assert.equal((await post(baseA, '__say', { text: 'slow, in alpha' })).status, 204);
    assert.equal((await post(baseB, '__say', { text: 'quick, in beta' })).status, 204);
    await b.until((e) => e.type === 'message' && e.message.speaker === 'Bea');
    const betaDone = Date.now() - t0;
    await a.until((e) => e.type === 'message' && e.message.speaker === 'Ada');
    const alphaDone = Date.now() - t0;
    assert.ok(betaDone < alphaDone && alphaDone >= 3000, `beta should finish before alpha, and alpha take at least 3000ms: beta ${betaDone}ms, alpha ${alphaDone}ms`);
    // Each room's discussion and transcript are in its own folder, and its page sees only its own.
    const disc = (root) => readdirSync(join(root, 'discussions')).filter((n) => n.endsWith('a-topic'));
    const [discA] = disc(alpha).filter((n) => n !== '2026-11-08-alpha-topic'), [discB] = disc(beta);
    const transcript = (root, d) => readFileSync(join(root, 'discussions', d, 'transcripts', readdirSync(join(root, 'discussions', d, 'transcripts'))[0]), 'utf8');
    assert.match(transcript(alpha, discA), /slow, in alpha/);
    assert.doesNotMatch(transcript(alpha, discA), /in beta/);
    assert.match(transcript(beta, discB), /quick, in beta/);
    assert.doesNotMatch(transcript(beta, discB), /in alpha/);
    const filesB = await (await fetch(baseB + '__files')).json();
    assert.ok(filesB.every((f) => !f.includes('alpha')), filesB.join(', '));
    const pageB = await (await stream(baseB)).next();
    assert.ok(pageB.messages.every((m) => !/in alpha/.test(m.html)));

    // Files: each room serves its own; nothing outside its folder, by ../, encoded ../ or a link.
    const notes = 'discussions/2026-11-08-alpha-topic/notes.md';
    assert.equal((await fetch(baseA + notes)).status, 200);
    for (const path of [notes, `..%2Falpha%2F${notes.replaceAll('/', '%2F')}`, '..%2Fsecret.txt', '%2E%2E%2F%2E%2E%2Fsecret.txt', 'discussions/link.md', `discussions%2F..%2F..%2Falpha%2F${notes.replaceAll('/', '%2F')}`]) {
      assert.equal((await fetch(baseB + path)).status, 404, path);
    }
    assert.equal((await fetch(baseA + 'discussions/..%2F..%2Fsecret.txt')).status, 404);
    // A link whose target stays inside the room's folder is still served.
    for (const path of ['discussions/own-link.md', 'discussions/material-link/own.md']) {
      const res = await fetch(baseB + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /beta material/);
    }
    assert.equal((await post(baseB, '__show', { file: 'discussions/own-link.md' })).status, 204);
    assert.equal(await (await fetch(baseB + '__mtime?f=' + encodeURIComponent('discussions/link.md'))).text(), 'false');
    assert.equal(await (await fetch(baseB + '__mtime?f=' + encodeURIComponent('../alpha/' + notes))).text(), 'false');
    for (const file of ['../alpha/' + notes, 'discussions/link.md', '../secret.txt']) {
      assert.equal((await post(baseB, '__show', { file })).status, 404, file);
    }

    // Quit room in alpha while its worker runs: the worker's program is stopped and reported, the
    // room ends, beta goes on.
    assert.equal((await post(baseA, '__work', { text: 'a long task' })).status, 204);
    await a.until((e) => e.type === 'working' && e.name === 'Wa');
    for (let i = 0; i < 100 && !existsSync(pids); i++) await new Promise((r) => setTimeout(r, 50));
    const [workerPid, commandPid] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
    // All unconfirmed server-wide routes refuse before stopping a busy room.
    for (const command of ['/restart', '/shutdown']) {
      const refused = await post(baseB, '__say', { text: command });
      assert.equal(refused.status, 409);
      assert.match(await refused.text(), /alpha: worker instruction running/);
    }
    const dock = await fetch(server + '/__shutdown', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(dock.status, 409);
    assert.match(await dock.text(), /stopped at once, leaving partial changes/);
    process.kill(workerPid, 0); // warning did not stop the worker

    await post(baseA, '__say', { text: '/quit' });
    const stopped = await a.until((e) => e.type === 'note' && /stopped in the middle of an instruction/.test(e.text));
    assert.equal(stopped.error, true);
    await a.until((e) => e.type === 'ended');
    assert.throws(() => process.kill(workerPid, 0)); // the worker's program is gone
    assert.throws(() => process.kill(commandPid, 0)); // its command is gone too
    assert.equal((await fetch(baseA + '__room')).status, 404);
    const after = await (await fetch(server + '/__health')).json();
    assert.deepEqual(after.rooms.map((r) => r.root), [beta]);
    assert.equal((await post(baseB, '__say', { text: '/usage' })).status, 204);
    assert.match((await b.until((e) => e.type === 'note')).text, /Usage this session/);
    assert.match(out, /^\[alpha\] Room ended\.$/m);

    // Quitting the last room ends the server.
    await post(baseB, '__say', { text: '/quit' });
    assert.equal(await exited, 0);
    assert.match(out, /Server ended\.\n$/);
  } finally {
    cli.kill();
    try { for (const pid of readFileSync(pids, 'utf8').trim().split('\n')) process.kill(Number(pid)); } catch {}
  }
});

// The real server with fake provider CLIs: New discussion opens a second discussion beside the
// first (its own context and page, made by cli.mjs's addRoom and reached through the server's
// routing), the window switches between them, each keeps its agents' sessions, and a worker task's
// report goes back to the discussion that sent it. Quit room closes both.
test('two open discussions in one room: switching keeps their sessions, and a worker report returns to its origin', { timeout: 40000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'open-home-'));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'open-repo-')));
  mkdirSync(join(repo, 'discussions'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'initial');
  const bin = join(home, 'bin'), calls = join(home, 'calls.jsonl');
  mkdirSync(bin);
  // claude: titles from the message; the worker reports on its instruction; agents pass. Every
  // agent call is logged with its arguments, so sessions can be told apart.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => input += d);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const reply = (result) => console.log(JSON.stringify({ result }));
  if (args.includes('--no-session-persistence')) return reply(input.includes('alpha') ? 'Alpha topic' : 'Beta topic');
  if (args.includes('Bash')) return reply('report on: ' + input.trim().split('\\n').at(-1));
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + '\\n');
  reply('PASS');
});
`, { mode: 0o755 });
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', repo, '--port', '0', '--agents', 'claude:Ada', '--worker', 'claude:W'],
    { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH } });
  const exited = new Promise((done) => cli.once('exit', done));
  let out = '';
  cli.stderr.on('data', (d) => { out += d; });
  try {
    const baseA = await new Promise((done, fail) => {
      cli.once('exit', () => fail(new Error(out)));
      cli.stdout.on('data', (d) => { out += d; const m = /Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)__room/.exec(out); if (m) done(m[1]); });
    });
    const origin = new URL(baseA).origin;
    const stream = async (base) => {
      const reader = (await fetch(base + '__events')).body.getReader();
      let buffer = '';
      const next = async () => {
        while (!buffer.includes('\n\n')) { const { value, done } = await reader.read(); if (done) throw new Error('stream ended'); buffer += new TextDecoder().decode(value); }
        const at = buffer.indexOf('\n\n'), chunk = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        return JSON.parse(chunk.replace(/^data: /, ''));
      };
      return { next, until: async (p) => { for (;;) { const ev = await next(); if (p(ev)) return ev; } } };
    };
    const say = (base, text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const a = await stream(baseA);
    await a.next();
    await say(baseA, 'about alpha');
    await a.until((e) => e.type === 'turn');
    // New discussion: this window goes to a second discussion's page; the first stays open.
    await say(baseA, '/new');
    const toB = await a.until((e) => e.type === 'goto');
    const baseB = origin + toB.url.replace(/__room$/, '');
    assert.notEqual(baseB, baseA);
    assert.equal((await fetch(origin + toB.url)).status, 200); // routed to its own page
    const b = await stream(baseB);
    const resetB = await b.next();
    assert.equal(resetB.room.discussion, 'No discussion started');
    assert.deepEqual(resetB.room.open.map((o) => [o.title, o.current]), [['Alpha topic', false], ['New discussion (not started)', true]]);
    await say(baseB, 'about beta');
    await b.until((e) => e.type === 'turn');
    // Resume the first from the second: it is open, so the window only goes back to it, as it was.
    const alpha = readdirSync(join(repo, 'discussions')).find((n) => n.endsWith('alpha-topic'));
    await say(baseB, `/resume ${alpha}`);
    assert.equal((await b.until((e) => e.type === 'goto')).url, new URL(baseA).pathname + '__room');
    const pageA = await stream(baseA);
    const resetA = await pageA.next();
    assert.ok(resetA.messages.some((m) => m.html.includes('about alpha'))); // its chat is still there
    await say(baseA, 'more on alpha');
    await pageA.until((e) => e.type === 'turn');
    // The agent's sessions: the first discussion's continues (resumed), the second has its own.
    const logged = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const session = (text) => { const c = logged.find((x) => x.input.includes(text)); const at = c.args.findIndex((x) => x === '--resume' || x === '--session-id'); return [c.args[at], c.args[at + 1]]; };
    const [startA, idA] = session('about alpha'), [startB, idB] = session('about beta'), [againA, idA2] = session('more on alpha');
    assert.deepEqual([startA, startB, againA], ['--session-id', '--session-id', '--resume']);
    assert.equal(idA2, idA);
    assert.notEqual(idB, idA);
    // A worker task from the second discussion: its report goes back there (both pages see the shared tab).
    await fetch(baseB + '__work', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'task from beta' }) });
    const report = await pageA.until((e) => e.type === 'work' && e.message.speaker === 'W');
    assert.match(report.message.html, /report on: task from beta/);
    assert.match(report.message.origin, /beta-topic$/);
    const transcript = (d) => readFileSync(join(repo, 'discussions', d, 'transcripts', readdirSync(join(repo, 'discussions', d, 'transcripts'))[0]), 'utf8');
    const beta = readdirSync(join(repo, 'discussions')).find((n) => n.endsWith('beta-topic'));
    assert.match(transcript(beta), /task from beta[\s\S]*report on: task from beta/);
    assert.doesNotMatch(transcript(alpha), /task from beta/);
    // Quit room closes both open discussions, and the server with them.
    await say(baseA, '/quit');
    await exited;
    assert.equal((out.match(/Room ended\./g) ?? []).length, 2);
  } finally {
    if (cli.exitCode === null) cli.kill();
  }
});

test('Shutdown server, from the server\'s own address, ends every room; with --node only the launch room replicates', { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooms-home-'));
  const one = mkdtempSync(join(tmpdir(), 'room-one-')), two = mkdtempSync(join(tmpdir(), 'room-two-'));
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', one, '--port', '0', '--node', 'Mac',
    '--room', JSON.stringify({ cwd: two })], { env: { ...process.env, HOME: home } });
  const exited = new Promise((done) => cli.once('exit', done));
  let out = '';
  try {
    const bases = await new Promise((done) => cli.stdout.on('data', (d) => {
      out += d;
      const found = [...out.matchAll(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)/g)].map((m) => m[1]);
      if (found.length === 2) done(found);
    }));
    const server = new URL(bases[0]).origin;
    const reset = async (base) => {
      const reader = (await fetch(base + '__events')).body.getReader();
      let text = '';
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
      reader.cancel();
      return JSON.parse(text.slice(0, text.indexOf('\n\n')).replace(/^data: /, ''));
    };
    const [launch, added] = [await reset(bases[0]), await reset(bases[1])];
    assert.equal(launch.replica.node, 'Mac');
    assert.equal(launch.replicaOff, null);
    assert.equal(added.replica, null);
    assert.match(added.replicaOff, /Replication runs only for this server's launch room/);
    assert.equal(existsSync(join(two, '.agent-room')), false); // nothing of replication in the other room's folder
    const shutdown = (origin) => fetch(server + '/__shutdown', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
    assert.equal((await shutdown('https://evil.example')).status, 403);
    assert.equal((await shutdown(server)).status, 202);
    assert.equal(await exited, 0);
    assert.match(out, /Room ended\.[\s\S]*Room ended\.[\s\S]*Server ended\.\n$/);
  } finally { cli.kill(); }
});

test('Restart with two rooms: both come back at the same addresses, with their current agents, worker and discussion', { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooms-home-'));
  const one = realpathSync(mkdtempSync(join(tmpdir(), 'restart-one-'))), two = realpathSync(mkdtempSync(join(tmpdir(), 'restart-two-')));
  for (const d of [one, two]) mkdirSync(join(d, 'discussions', '2026-11-08-topic'), { recursive: true });
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', one, '--port', '0',
    '--agents', 'claude:Ada', '--worker', 'claude:Wa', '--room', JSON.stringify({ cwd: two, agents: 'codex:Bea', worker: 'claude:Wb' })],
  { env: { ...process.env, HOME: home } });
  const exited = new Promise((done) => cli.once('exit', done));
  let out = '', newPid = null;
  try {
    const [baseA, baseB] = await new Promise((done) => cli.stdout.on('data', (d) => {
      out += d;
      const found = [...out.matchAll(/Room screen: (http:\/\/127\.0\.0\.1:\d+\/r\/[^/]+\/)/g)].map((m) => m[1]);
      if (found.length === 2) done(found);
    }));
    const json = async (url) => { try { return await (await fetch(url)).json(); } catch { return null; } };
    const say = (base, text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const until = async (check) => { for (const t0 = Date.now(); Date.now() - t0 < 15000;) { const v = await check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } assert.fail('timed out'); };
    // Room two's settings change while it runs (saved as defaults too): Restart must keep each room's
    // current choice, so room one stays on its launch agents rather than those defaults.
    const changed = { agents: [{ provider: 'claude', name: 'Zed', model: '' }], worker: { provider: 'claude', name: 'Wz', model: '' } };
    const saved = await fetch(baseB + '__settings', { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(baseB).origin }, body: JSON.stringify(changed) });
    assert.equal((await saved.json()).applied, true);
    await say(baseA, '/resume 2026-11-08-topic');
    await say(baseB, '/resume 2026-11-08-topic');
    const before = await until(async () => {
      const [a, b] = [await json(baseA + '__health'), await json(baseB + '__health')];
      return a?.discussion && b?.discussion && [a, b];
    });

    await say(baseB, '/restart');
    assert.equal(await exited, 0);
    assert.match(out, /Restarting: a new process takes over the server\./);
    // The same addresses answer from the new process, each room in its discussion (each re-opens it
    // just after it starts answering: open pages get a reset then).
    const [a, b] = await until(async () => {
      const [x, y] = [await json(baseA + '__health'), await json(baseB + '__health')];
      return x && y && x.pid !== before[0].pid && x.discussion && y.discussion && [x, y];
    });
    newPid = a.pid;
    assert.equal(b.pid, a.pid);
    assert.deepEqual([a.root, a.discussion], [one, 'discussions/2026-11-08-topic']);
    assert.deepEqual([b.root, b.discussion], [two, 'discussions/2026-11-08-topic']);
    const [sa, sb] = [await json(baseA + '__settings'), await json(baseB + '__settings')];
    assert.deepEqual(sa.settings, { agents: [{ provider: 'claude', name: 'Ada', model: '' }], worker: { provider: 'claude', name: 'Wa', model: '' } });
    assert.deepEqual(sb.settings, changed);

    const shut = await fetch(new URL(baseA).origin + '/__shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(shut.status, 202);
    await until(async () => !(await json(baseA + '__health')));
    newPid = null;
  } finally {
    cli.kill();
    if (newPid) try { process.kill(newPid); } catch {}
  }
});

test('ending refuses room creation, including a delayed folder choice; busy warnings name all rooms', async () => {
  const { assertRoomCreation, serverEndWarning } = await import('../src/ui.mjs');
  const hub = { rooms: new Map([['a', { cwd: '/alpha', busy: true }], ['b', { cwd: '/beta', screen: { working: 'W' } }]]) };
  assert.match(serverEndWarning(hub), /alpha: discussion round in progress/);
  assert.match(serverEndWarning(hub), /beta: worker instruction running/);
  assert.match(serverEndWarning(hub), /stopped at once, leaving partial changes/);
  for (const ending of ['restart', 'shutdown']) {
    delete hub.ending;
    assertRoomCreation(hub); // chooser opens
    const chosen = Promise.resolve('/chosen');
    hub.ending = ending;
    await chosen;
    assert.throws(() => assertRoomCreation(hub), /no room can be created/);
  }
  assert.equal(serverEndWarning({ rooms: new Map() }), null);
});

test('stopping a room kills provider child commands even after the provider exits', { timeout: 15000 }, async () => {
  const { run } = await import('../src/agents.mjs');
  const { stopRoom } = await import('../src/ui.mjs');
  for (const exits of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'room-children-'));
    const pidFile = join(dir, 'child');
    const ctx = { programs: { running: new Set(), stopping: false }, noScreen: true, docs: { broadcast() {} }, screen: {} };
    const task = run(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      ${exits ? 'child.unref();' : 'setInterval(()=>{},1000);'}
    `], { procs: ctx.programs.running });
    const settled = task.catch(() => {});
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const child = Number(readFileSync(pidFile, 'utf8'));
    if (exits) await settled;
    await stopRoom(ctx);
    await settled;
    assert.throws(() => process.kill(child, 0));
  }
});
