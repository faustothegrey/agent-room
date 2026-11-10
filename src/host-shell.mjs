// The terminal pane's server side: a shell on this computer, shown in the room page with ghostty-web.
// It follows ghostty-web's demo server (github.com/coder/ghostty-web, demo/bin/demo.js and auth.js,
// MIT): @lydell/node-pty for the shell, a `ws` WebSocket, a random token from a token endpoint,
// and the demo's Host and Origin checks. agent-room listens on every address (the LAN too), unlike
// the demo's 127.0.0.1, so every request here must also come from a loopback address.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// One token per server process, as in the demo (this module isn't reloaded by /reload).
const TOKEN = randomBytes(32).toString('base64url');
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Host header → { hostname, port }, or null when malformed (the demo's parseHostHeader, shortened).
function parseHost(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  const m = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::([0-9]{1,5}))?$/i.exec(value);
  if (!m) return null;
  const hostname = (m[1] ?? m[2]).toLowerCase(), port = m[3] ?? '';
  if (m[1] && isIP(hostname) !== 6) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return { hostname, port: port ? String(Number(port)) : '' };
}
// Origin header → { protocol, hostname, port }, or null (the demo's parseOriginHeader).
function parseOrigin(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) return null;
  let u; try { u = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  const host = parseHost(u.host);
  return host && { protocol: u.protocol, ...host };
}
const defaultPort = (protocol) => (protocol === 'https:' ? '443' : '80');

// The checks: null when allowed, else [status, reason]. Every request: from a loopback address
// (added for agent-room), Host one of the allowed names (demo). Origin: optional for the token,
// required for the WebSocket, and when present the same host and port as Host (demo). The
// WebSocket also needs the token (demo).
export function refusal(req, { originRequired, token }) {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)) return [403, 'Forbidden: not from this computer'];
  const host = parseHost(req.headers.host);
  if (!host) return [400, 'Bad Request'];
  if (!ALLOWED_HOSTS.includes(host.hostname)) return [403, 'Forbidden: Host not allowed'];
  const originHeader = req.headers.origin;
  if (originHeader === undefined) { if (originRequired) return [403, 'Forbidden: no Origin']; }
  else {
    const origin = parseOrigin(originHeader);
    if (!origin) return [400, 'Bad Request: Origin'];
    const fallback = defaultPort(origin.protocol);
    if (origin.hostname !== host.hostname || (origin.port || fallback) !== (host.port || fallback)) return [403, 'Forbidden: Origin does not match Host'];
  }
  if (token !== undefined) {
    const got = Buffer.from(String(token ?? '')), want = Buffer.from(TOKEN);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return [401, 'Unauthorized'];
  }
  return null;
}
const log = (req, what, why) => console.log(`[terminal] refused ${what}: ${why} (from ${req.socket.remoteAddress}, Host ${req.headers.host ?? 'none'}, Origin ${req.headers.origin ?? 'none'})`);

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ghostty-web', 'dist', 'ghostty-web.js');

// __shell/token and __shell/ghostty-web.js (GET); false for other paths.
export function handleShell(req, res, url) {
  if (url.pathname !== '/__shell/token' && url.pathname !== '/__shell/ghostty-web.js') return false;
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  if (req.method !== 'GET') { res.writeHead(405, { ...headers, allow: 'GET' }); res.end('Method Not Allowed'); return true; }
  const why = refusal(req, { originRequired: false });
  if (why) { log(req, url.pathname.slice(9), why[1]); res.writeHead(why[0], headers); res.end(why[1]); return true; }
  if (url.pathname === '/__shell/token') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ token: TOKEN })); return true; }
  // ghostty-web's module, straight from node_modules (its WebAssembly is inside it, as a data URI).
  res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }); res.end(readFileSync(LIB));
  return true;
}

// The shells, one per WebSocket. Closing the socket (pane collapsed, page reloaded or closed) ends
// the shell; the shell ending closes the socket; the server stopping ends them all.
const sessions = new Map(); // ws → pty
const wss = new WebSocketServer({ noServer: true });
let hooked = false;
function hookExit() {
  if (hooked) return; hooked = true;
  const all = () => { for (const p of sessions.values()) try { p.kill(); } catch {} };
  process.on('exit', all);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    // Then the default action, as if this handler weren't there.
    const on = () => { all(); if (process.listenerCount(sig) === 1) { process.off(sig, on); process.kill(process.pid, sig); } };
    process.on(sig, on);
  }
}

// /__shell/ws?token=…&cols=…&rows=…: true when handled (accepted or refused).
export function handleUpgrade(req, socket, head, cwd) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/__shell/ws') return false;
  const why = refusal(req, { originRequired: true, token: url.searchParams.get('token') });
  if (why) {
    log(req, 'ws', why[1]);
    const body = why[1] + '\n';
    socket.end(`HTTP/1.1 ${why[0]} ${why[1]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.destroy();
    return true;
  }
  wss.handleUpgrade(req, socket, head, async (ws) => {
    const size = (v, d) => Math.max(2, Math.min(1000, Number.parseInt(v ?? '', 10) || d));
    let p;
    // A shell that can't start (spawn throws) is reported in the pane; it must not end agent-room.
    try {
      const pty = (await import('@lydell/node-pty')).default;
      p = pty.spawn(process.env.SHELL || '/bin/bash', [], {
        name: 'xterm-256color', cols: size(url.searchParams.get('cols'), 80), rows: size(url.searchParams.get('rows'), 24), cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      console.log(`[terminal] the shell did not start: ${err.message}`);
      if (ws.readyState === ws.OPEN) { ws.send(`\r\n\x1b[31mThe shell did not start: ${err.message}\x1b[0m\r\n`); ws.close(); }
      return;
    }
    if (ws.readyState !== ws.OPEN) { try { p.kill(); } catch {} return; } // the pane closed meanwhile
    sessions.set(ws, p); hookExit();
    console.log(`[terminal] shell started (pid ${p.pid})`);
    p.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
    p.onExit(({ exitCode }) => {
      sessions.delete(ws);
      if (ws.readyState === ws.OPEN) { ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`); ws.close(); }
    });
    ws.on('message', (data) => {
      const message = data.toString('utf8');
      if (message.startsWith('{')) {
        try { const msg = JSON.parse(message); if (msg.type === 'resize') { p.resize(size(msg.cols, 80), size(msg.rows, 24)); return; } } catch {}
      }
      p.write(message);
    });
    ws.on('close', () => { if (sessions.get(ws) === p) { sessions.delete(ws); try { p.kill(); } catch {} console.log(`[terminal] shell ended (pid ${p.pid})`); } });
    ws.on('error', () => {});
  });
  return true;
}
