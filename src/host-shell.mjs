// UNSAFE THROWAWAY TEST, step 1 (2026-11-10-quick-access-host-terminal-panel): a host shell in a pane
// of the room page, through the system `script` command. Off unless agent-room is started with
// --unsafe-shell-test (which also makes the server listen on 127.0.0.1 only). Output goes over the
// page's own room event stream (/__events), keystrokes over POST.
// Checks, unverified and not claimed to stop other websites: every shell request must come from a
// loopback address, with Host 127.0.0.1 or localhost, and carry the header X-Agent-Room-Shell with
// a random token made at startup and written only into room pages loaded from the host.
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

let token = null; // set by enableShellTest(), from cli.mjs
export function enableShellTest() { token = randomBytes(32).toString('hex'); }
export const shellTestOn = () => !!token;

const mac = process.platform === 'darwin';
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fromHost = (req) => LOOPBACK.has(req.socket.remoteAddress)
  && ['127.0.0.1', 'localhost'].includes((req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''));
const hasToken = (req) => {
  const got = Buffer.from(String(req.headers['x-agent-room-shell'] ?? '')), want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
};

// The room page: for a page loaded from the host, the token in a <meta>; other pages get none.
export function shellPage(req, html) {
  if (!token || !fromHost(req)) return html;
  return html.replace('<head>', `<head><meta name="agent-room-shell" content="${token}">`);
}

// Each host page's event stream gets an id (sent only to it); a shell belongs to one stream and
// ends when that stream closes (page reloaded or closed).
const streams = new Map(); // id → { res, shell }
export function shellAttach(req, res) {
  if (!token || !fromHost(req)) return;
  const id = randomBytes(8).toString('hex');
  streams.set(id, { res, shell: null });
  res.write(`data: ${JSON.stringify({ type: 'shellstream', id })}\n\n`);
  req.on('close', () => { streams.get(id)?.shell?.kill(); streams.delete(id); });
}

// `script` needs a pipe for input (macOS refuses Node's socket pair), so `cat` feeds it. Its
// terminal starts at 0×0: the size is set from outside with stty on the shell's terminal.
function startScript(cwd, cols, rows, onData, onExit) {
  const shell = process.env.SHELL || '/bin/sh';
  const args = mac ? ['-q', '/dev/null', shell, '-l'] : ['-q', '-f', '-c', `${q(shell)} -l`, '/dev/null'];
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const p = spawn('/bin/sh', ['-c', 'cat | exec script ' + args.map(q).join(' ')], { cwd, env, detached: true });
  const dec = new StringDecoder('utf8');
  p.stdout.on('data', (d) => onData(dec.write(d))); p.stderr.on('data', (d) => onData(dec.write(d)));
  p.stdin.on('error', () => {});
  p.on('exit', onExit);
  let tty = null, inner = null, size = [cols, rows];
  const setSize = () => { if (tty) try { execFileSync('stty', [mac ? '-f' : '-F', tty, 'rows', String(size[1]), 'cols', String(size[0])]); } catch {} };
  const find = (tries) => { // the shell: the child of `script`, in its own session
    if (!tries || p.exitCode !== null) return;
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/));
    const scr = ps.find((f) => /script$/.test(f[3] ?? '') && (f[0] === String(p.pid) || f[1] === String(p.pid)));
    const child = scr && ps.find((f) => f[1] === scr[0] && f[2] && !/^\?+$/.test(f[2]));
    if (!child) return setTimeout(() => find(tries - 1), 50);
    inner = Number(child[0]); tty = '/dev/' + child[2]; setSize();
  };
  find(40);
  return {
    pid: p.pid, write: (s) => p.stdin.write(s), resize: (c, r) => { size = [c, r]; setSize(); },
    // Hang up the shell's session (on Linux `script` outlives a TERM of its group), then the group.
    kill: () => { for (const [g, sig] of [[inner, 'SIGHUP'], [p.pid, 'SIGTERM']]) if (g) try { process.kill(-g, sig); } catch {} },
  };
}

const live = new Set();
let hooked = false;
function hookExit() { // the server stopping ends the shells (a SIGKILL can't be caught)
  if (hooked) return; hooked = true;
  const all = () => { for (const s of live) s.kill(); };
  process.on('exit', all);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const on = () => { all(); if (process.listenerCount(sig) === 1) { process.off(sig, on); process.kill(process.pid, sig); } };
    process.on(sig, on);
  }
}

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ghostty-web', 'dist', 'ghostty-web.js');
const readJson = (req) => new Promise((done) => {
  let body = ''; req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
});

// __shell/…: lib (the ghostty-web module), start, input, resize, stop. False for other paths, and
// for every path when the test is off.
export function handleShell(req, res, url, cwd) {
  if (!token || !url.pathname.startsWith('/__shell/')) return false;
  const send = (status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const what = url.pathname.slice('/__shell/'.length);
  const why = !fromHost(req) ? 'not from the host (address or Host header)' : !hasToken(req) ? 'missing or wrong X-Agent-Room-Shell token' : null;
  if (why) { console.log(`[shell test] refused ${req.method} ${what}: ${why}`); send(403, `Refused: ${why}.`); return true; }
  if (what === 'lib') { send(200, readFileSync(LIB), 'text/javascript; charset=utf-8'); return true; }
  if (req.method !== 'POST') { send(405, 'Use POST.'); return true; }
  readJson(req).then((body) => {
    const s = streams.get(String(body?.stream ?? ''));
    if (!s) return send(409, 'No event stream of this page with that id.');
    const cols = Math.max(2, Math.min(500, body.cols | 0 || 80)), rows = Math.max(2, Math.min(300, body.rows | 0 || 24));
    if (what === 'start') {
      s.shell?.kill(); hookExit();
      const shell = startScript(cwd, cols, rows,
        (data) => s.res.write(`data: ${JSON.stringify({ type: 'shell', data })}\n\n`),
        () => { live.delete(shell); if (s.shell === shell) { s.shell = null; s.res.write(`data: ${JSON.stringify({ type: 'shellexit' })}\n\n`); } });
      s.shell = shell; live.add(shell);
      console.log(`[shell test] started a shell (pid ${shell.pid})`);
      return send(204, '');
    }
    if (!s.shell) return send(409, 'No shell is running for this page.');
    if (what === 'input') { if (typeof body.data === 'string') s.shell.write(body.data); return send(204, ''); }
    if (what === 'resize') { s.shell.resize(cols, rows); return send(204, ''); }
    if (what === 'stop') { const sh = s.shell; s.shell = null; sh.kill(); console.log('[shell test] stopped a shell'); return send(204, ''); }
    send(404, 'No such shell request.');
  });
  return true;
}
