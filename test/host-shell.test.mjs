import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { handleShell, handleUpgrade } from '../src/host-shell.mjs';

// The Terminal pane's checks (host-shell.mjs). A test can't connect from a LAN address, so those
// cases use fake requests: a socket with any remote address, and the headers a client may forge.
const fakeReq = (url, { from = '127.0.0.1', host = '127.0.0.1:5566', origin, method = 'GET' } = {}) => {
  const socket = { remoteAddress: from, written: '', end(s) { this.written += s ?? ''; }, destroy() { this.destroyed = true; } };
  const headers = {}; if (host !== null) headers.host = host; if (origin !== undefined) headers.origin = origin;
  return { url, method, headers, socket };
};
// The token endpoint: [status, body].
function tokenRequest(opts) {
  const req = fakeReq('/__shell/token', opts);
  let status, body = '';
  const res = { writeHead(s) { status = s; }, end(b) { body = String(b ?? ''); } };
  assert.equal(handleShell(req, res, new URL(req.url, 'http://x')), true);
  return [status, body];
}
// A WebSocket upgrade: the status of its HTTP refusal, or 'accepted' (nothing written yet).
function upgradeRequest(query, opts) {
  const req = fakeReq('/__shell/ws' + query, opts);
  assert.equal(handleUpgrade(req, req.socket, Buffer.alloc(0), '/tmp'), true);
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(req.socket.written);
  return m ? Number(m[1]) : 'accepted';
}
const realToken = () => JSON.parse(tokenRequest({})[1]).token;

test('terminal: a non-loopback address is refused, even with a forged Host, Origin and the real token', () => {
  const token = realToken();
  for (const from of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1']) {
    const forged = { from, host: '127.0.0.1:5566', origin: 'http://127.0.0.1:5566' };
    const [status, body] = tokenRequest(forged);
    assert.equal(status, 403, from); assert.match(body, /not from this computer/);
    assert.equal(tokenRequest({ from, host: 'localhost:5566' })[0], 403, from);
    assert.equal(upgradeRequest(`?token=${token}`, forged), 403, from);
  }
  // The same request from loopback gets the token: the address is what was refused.
  assert.equal(tokenRequest({ host: '127.0.0.1:5566', origin: 'http://127.0.0.1:5566' })[0], 200);
  assert.equal(tokenRequest({ from: '::1', host: '[::1]:5566' })[0], 200);
});

test('terminal: a Host other than localhost, 127.0.0.1 or ::1 is refused (DNS rebinding, LAN name)', () => {
  const token = realToken();
  for (const host of ['localhost:5566', '127.0.0.1:5566', '[::1]:5566', 'LOCALHOST:5566', '127.0.0.1']) assert.equal(tokenRequest({ host })[0], 200, host);
  for (const host of ['rebind.example:5566', '192.168.1.20:5566', 'localhost.evil.example:5566', '127.0.0.2:5566', 'mac.local:5566']) {
    assert.equal(tokenRequest({ host })[0], 403, host);
    assert.equal(upgradeRequest(`?token=${token}`, { host, origin: `http://${host}` }), 403, host);
  }
  for (const host of ['', ' 127.0.0.1:5566', '127.0.0.1:99999', '127.0.0.1:x', '[::1', 'user@127.0.0.1']) assert.equal(tokenRequest({ host })[0], 400, JSON.stringify(host));
  assert.equal(tokenRequest({ host: null })[0], 400); // no Host header at all
});

test('terminal: the WebSocket needs an Origin matching Host; the token endpoint allows none, refuses a mismatch', () => {
  const token = realToken(), host = '127.0.0.1:5566';
  assert.equal(upgradeRequest(`?token=${token}`, { host }), 403); // no Origin
  // (As in the demo, only the Origin's host and port are compared with Host, not its scheme.)
  for (const origin of ['http://evil.example', 'http://localhost:5566', 'http://127.0.0.1:8080', 'http://127.0.0.1']) {
    assert.equal(upgradeRequest(`?token=${token}`, { host, origin }), 403, origin);
    assert.equal(tokenRequest({ host, origin })[0], 403, origin);
  }
  for (const origin of ['null', 'http://127.0.0.1:5566/path', 'file://', 'not a url']) assert.equal(upgradeRequest(`?token=${token}`, { host, origin }), 400, origin);
  assert.equal(tokenRequest({ host })[0], 200); // as in ghostty-web's demo: Origin optional here
  assert.equal(tokenRequest({ host, origin: 'http://127.0.0.1:5566' })[0], 200);
  assert.equal(tokenRequest({ host, method: 'POST', origin: 'http://127.0.0.1:5566' })[0], 405);
});

test('terminal: a missing or wrong token gets 401 on the WebSocket', () => {
  const token = realToken(), ok = { host: '127.0.0.1:5566', origin: 'http://127.0.0.1:5566' };
  assert.equal(upgradeRequest('', ok), 401);
  assert.equal(upgradeRequest('?token=', ok), 401);
  assert.equal(upgradeRequest('?token=wrong', ok), 401);
  assert.equal(upgradeRequest(`?token=${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`, ok), 401); // one character off
  assert.equal(upgradeRequest(`?token=${token}x`, ok), 401);
});

// A real local server for the rest: the token, then a WebSocket from the ws client.
async function serve(cwd) {
  const server = createServer((req, res) => { if (!handleShell(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end(); } });
  server.on('upgrade', (req, socket, head) => { if (!handleUpgrade(req, socket, head, cwd)) socket.destroy(); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `127.0.0.1:${server.address().port}`;
  const token = (await (await fetch(`http://${base}/__shell/token`)).json()).token;
  // Everything the shell sent until the socket closed (or `until` matched), and the close.
  const connect = (until) => new Promise((done, fail) => {
    const ws = new WebSocket(`ws://${base}/__shell/ws?token=${token}&cols=80&rows=24`, { origin: `http://${base}` });
    let text = '';
    ws.on('message', (d) => { text += d; if (until?.test(text)) { ws.close(); } });
    ws.on('close', () => done(text));
    ws.on('unexpected-response', (_, res) => fail(new Error('refused: ' + res.statusCode)));
    ws.on('error', fail);
    if (until) ws.on('open', () => ws.send('echo shell-$((6*7))\r'));
  });
  return { base, token, connect, close: () => { server.closeAllConnections(); server.close(); } };
}

test('terminal: a shell that fails to start is reported in the pane, and the server keeps answering', { timeout: 10000 }, async () => {
  const s = await serve({}); // a cwd node-pty refuses: pty.spawn() throws
  try {
    const text = await s.connect();
    assert.match(text, /The shell did not start: .*cwd must be a string/);
    const res = await fetch(`http://${s.base}/__shell/token`);
    assert.equal(res.status, 200); // the server is still up
  } finally { s.close(); }
});

test('terminal: with the token and a matching Origin, the WebSocket runs a shell', { timeout: 10000 }, async () => {
  const shell = process.env.SHELL;
  process.env.SHELL = '/bin/sh';
  const s = await serve(process.cwd());
  try { assert.match(await s.connect(/shell-42/), /shell-42/); }
  finally { s.close(); process.env.SHELL = shell; }
});

// Quit room on a server with another room open: the quit room's Terminal shells end, the other's
// keeps working. The real server (cli.mjs) with two rooms and a fake `claude`, as in rooms.test.mjs.
test('terminal: Quit room ends that room\'s shells; another room\'s shell keeps working', { timeout: 60000 }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync, spawn } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'term-quit-')), bin = join(home, 'bin');
  mkdirSync(bin);
  const rooms = ['alpha', 'beta'].map((name) => {
    const dir = join(home, name); mkdirSync(dir); writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'initial');
    return dir;
  });
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: 'ok' })));\n`, { mode: 0o755 });
  const cli = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', rooms[0], '--port', '0',
    '--agents', 'claude:Ada', '--worker', 'claude:Wa', '--room', JSON.stringify({ cwd: rooms[1], agents: 'claude:Bea', worker: 'claude:Wb' })],
  { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH, SHELL: '/bin/sh' } });
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
    const origin = new URL(baseA).origin;
    // A pane: the WebSocket, everything it received, and a way to wait for some text or the close.
    const pane = async (base) => {
      const { token } = await (await fetch(base + '__shell/token')).json();
      const ws = new WebSocket(base.replace('http', 'ws') + '__shell/ws?token=' + token, { origin });
      const p = { ws, text: '', closed: false };
      ws.on('message', (d) => { p.text += d; });
      p.closing = new Promise((done) => ws.on('close', () => { p.closed = true; done(); }));
      await new Promise((ok, fail) => { ws.on('open', ok); ws.on('error', fail); });
      p.until = async (re) => { for (let i = 0; i < 100 && !re.test(p.text); i++) await new Promise((r) => setTimeout(r, 50)); return re.exec(p.text); };
      return p;
    };
    const a = await pane(baseA), b = await pane(baseB);
    a.ws.send('echo "pid-$$"\r'); b.ws.send('echo "pid-$$"\r');
    const pidA = Number((await a.until(/pid-(\d+)/))[1]), pidB = Number((await b.until(/pid-(\d+)/))[1]);
    assert.ok(pidA && pidB && pidA !== pidB);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const say = (base, text) => fetch(base + '__say', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ text }) });
    assert.equal((await say(baseA, '/quit')).status, 204);
    await Promise.race([a.closing, new Promise((r) => setTimeout(r, 15000))]);
    assert.equal(a.closed, true, 'room alpha\'s pane socket closes');
    for (let i = 0; i < 40 && alive(pidA); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pidA), false, 'room alpha\'s shell is gone');
    assert.equal(b.closed, false);
    b.ws.send('echo "still-$((6*7))"\r');
    assert.ok(await b.until(/still-42/), 'room beta\'s shell still works');
    assert.equal(alive(pidB), true);
    b.ws.close();
    for (let i = 0; i < 40 && alive(pidB); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pidB), false, 'closing beta\'s pane ends its shell');
    await say(baseB, '/quit');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
  } finally { cli.kill('SIGKILL'); }
});
