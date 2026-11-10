// THROWAWAY TEST (2026-11-10-quick-access-host-terminal-panel), not a decision: a shell on the host,
// shown in a pane of the room page with ghostty-web. Off unless AGENT_ROOM_HOST_SHELL is `script`
// (the system command, no npm dependency) or `node-pty` (installed separately, not in package.json).
// Host only: every shell request must come from this machine's loopback address, name this server
// by a loopback Host (no DNS rebinding), carry an Origin equal to that Host (no other website, no
// Origin-less client), be JSON (a cross-site form can't send it), and after start carry the shell's
// random token. Collapsing the pane or reloading the page closes its output stream: the shell ends.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const MODE = process.env.AGENT_ROOM_HOST_SHELL || '';
const mac = process.platform === 'darwin';
const shells = new Map(); // id → { token, pty, stream }
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// The `script` command: a pseudo-terminal without a native module. Its input must be a pipe (macOS
// refuses Node's socket pair), so `cat` feeds it. The size is set from outside with stty on the
// shell's terminal, which also sends SIGWINCH to the program in front.
function scriptPty(shell, cwd, env, cols, rows) {
  const inner = [shell, '-l'];
  const args = mac ? ['-q', '/dev/null', ...inner] : ['-q', '-f', '-c', inner.map(q).join(' '), '/dev/null'];
  const p = spawn('/bin/sh', ['-c', 'cat | exec script ' + args.map(q).join(' ')], { cwd, env, detached: true });
  const decoder = new StringDecoder('utf8');
  let data = () => {}, exit = () => {}, tty = null, inner_ = null, size = [cols, rows];
  p.stdout.on('data', (d) => data(decoder.write(d)));
  p.stderr.on('data', (d) => data(decoder.write(d)));
  p.on('exit', () => exit());
  p.stdin.on('error', () => {});
  const setSize = () => { if (tty) try { execFileSync('stty', [mac ? '-f' : '-F', tty, 'rows', String(size[1]), 'cols', String(size[0])]); } catch {} };
  // The shell: the child of `script`, in its own session, with the terminal to resize.
  const find = (tries) => {
    if (!tries || p.exitCode !== null) return;
    const rows_ = execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/));
    const scr = rows_.find((f) => /script$/.test(f[3] || '') && (f[1] === String(p.pid) || f[0] === String(p.pid)) );
    const child = scr && rows_.find((f) => f[1] === scr[0] && f[2] && !/^\?+$/.test(f[2]));
    if (!child) return setTimeout(() => find(tries - 1), 50);
    inner_ = Number(child[0]); tty = '/dev/' + child[2]; setSize();
  };
  find(40);
  return {
    pid: p.pid, onData: (f) => { data = f; }, onExit: (f) => { exit = f; },
    write: (s) => p.stdin.write(s),
    resize: (c, r) => { size = [c, r]; setSize(); },
    // Hang up the shell's session (Linux `script` survives a TERM of its own group), then the group.
    kill: () => {
      if (inner_) try { process.kill(-inner_, 'SIGHUP'); } catch {}
      try { process.kill(-p.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { for (const g of [inner_, p.pid]) if (g) try { process.kill(-g, 'SIGKILL'); } catch {} }, 1000).unref();
    },
  };
}

async function nodePty(shell, cwd, env, cols, rows) {
  const pty = (await import('node-pty')).default;
  const p = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env });
  let data = () => {}, exit = () => {};
  p.onData((d) => data(d)); p.onExit(() => exit());
  return { pid: p.pid, onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (s) => p.write(s),
    resize: (c, r) => p.resize(c, r), kill: () => { try { p.kill('SIGHUP'); } catch {} } };
}

// The server stopping ends every shell: on exit, and on Ctrl-C or TERM (then the default action,
// as if this handler weren't there). A SIGKILL can't be caught: see the test notes.
const killAll = () => { for (const s of shells.values()) s.pty.kill(); shells.clear(); };
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const on = () => { killAll(); if (process.listenerCount(sig) === 1) { process.off(sig, on); process.kill(process.pid, sig); } };
    process.on(sig, on);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// The checks every shell request passes; returns the reason for a refusal, or null.
export function refusal(req, { needOrigin = true } = {}) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return 'not from this machine';
  const port = req.socket.localPort;
  const host = (req.headers.host ?? '').toLowerCase();
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return 'unexpected Host';
  if (!needOrigin) return null;
  if (req.method !== 'POST') return 'not a POST';
  if (!req.headers.origin) return 'no Origin';
  if (req.headers.origin !== `http://${host}`) return 'another Origin';
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return 'not JSON';
  return null;
}

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ghostty-web', 'dist');
const readJson = (req) => new Promise((done) => {
  let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
});

// Handles __shell/…; returns false for any other path (and for every path when the test is off).
export function handleShell(req, res, url, cwd) {
  if (!MODE || !url.pathname.startsWith('/__shell/')) return false;
  const send = (status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const what = url.pathname.slice('/__shell/'.length);
  // The library: one JS file (the WebAssembly is inside it, as a data URI), straight from node_modules.
  if (what === 'ghostty-web.js' || /^__vite-browser-external-[0-9a-f]+\.js$/.test(what)) {
    const why = refusal(req, { needOrigin: false });
    if (why) { console.log(`[host shell] refused ${req.method} ${what}: ${why} (from ${req.socket.remoteAddress}, Host ${req.headers.host}, Origin ${req.headers.origin ?? 'none'})`); return send(403, `Refused: ${why}.`), true; }
    try { send(200, readFileSync(join(LIB, what)), 'text/javascript; charset=utf-8'); } catch { send(404, 'ghostty-web is not installed: npm install'); }
    return true;
  }
  const why = refusal(req);
  if (why) { console.log(`[host shell] refused ${req.method} ${what}: ${why} (from ${req.socket.remoteAddress}, Host ${req.headers.host}, Origin ${req.headers.origin ?? 'none'})`); send(403, `Refused: ${why}.`); return true; }
  readJson(req).then(async (body) => {
    if (!body) return send(400, 'Expected JSON.');
    const cols = Math.max(2, Math.min(500, body.cols | 0 || 80)), rows = Math.max(2, Math.min(300, body.rows | 0 || 24));
    if (what === 'start') {
      hookExit();
      const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      delete env.AGENT_ROOM_HOST_SHELL;
      const shell = process.env.SHELL || '/bin/sh';
      let pty;
      try { pty = MODE === 'node-pty' ? await nodePty(shell, cwd, env, cols, rows) : scriptPty(shell, cwd, env, cols, rows); }
      catch (err) { return send(500, `The shell did not start (${MODE}): ${err.message}`); }
      const id = randomBytes(8).toString('hex'), token = randomBytes(32).toString('hex');
      const s = { token, pty, stream: null, buffered: '' };
      pty.onData((d) => { if (s.stream) s.stream.write(`data: ${JSON.stringify(d)}\n\n`); else s.buffered += d; });
      pty.onExit(() => { s.stream?.end('event: exit\ndata: {}\n\n'); shells.delete(id); });
      shells.set(id, s);
      // Nobody opens the output within 10 s: the page went away, so the shell ends.
      setTimeout(() => { if (!s.stream && shells.get(id) === s) { pty.kill(); shells.delete(id); } }, 10000).unref();
      console.log(`[host shell] started ${id} (${MODE}, pid ${pty.pid})`);
      return send(200, JSON.stringify({ id, token, mode: MODE }), 'application/json');
    }
    const s = shells.get(String(body.id));
    if (!s || typeof body.token !== 'string' || body.token !== s.token) { console.log(`[host shell] refused ${what}: unknown shell or wrong token`); return send(403, 'Refused: unknown shell or wrong token.'); }
    if (what === 'output') {
      if (s.stream) return send(409, 'This shell already has its output open.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      s.stream = res;
      if (s.buffered) { res.write(`data: ${JSON.stringify(s.buffered)}\n\n`); s.buffered = ''; }
      // The page closed the stream (pane collapsed, page reloaded or closed): the shell ends.
      res.on('close', () => { if (shells.get(String(body.id)) === s) { s.pty.kill(); shells.delete(String(body.id)); console.log(`[host shell] ended ${body.id}`); } });
      return;
    }
    if (what === 'input') { if (typeof body.data === 'string') s.pty.write(body.data); return send(204, ''); }
    if (what === 'resize') { s.pty.resize(cols, rows); return send(204, ''); }
    send(404, 'No such shell request.');
  });
  return true;
}

export const hostShellOn = !!MODE;
