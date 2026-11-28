#!/usr/bin/env node
// Read-only MCP stdio service for local clients (such as Hermes Agent).
// Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout with no external dependencies.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 5566;
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DATED = /^\d{4}-\d{2}-\d{2}-/;
const SERVER_INFO = { name: 'agent-room', version: '0.1.0' };

export const roomsFilePath = (home = homedir()) => join(home, '.local', 'state', 'agent-room', 'rooms.json');

export const TOOLS = [
  {
    name: 'list_rooms',
    description: 'List known agent-room rooms (saved in ~/.local/state/agent-room/rooms.json plus any open on the running local server), with running status and active board.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_boards',
    description: 'List open boards (in discussions/) and brainstorms (in brainstorms/) for a room folder, excluding discussions/archive/ and discussions/deferred/, with running/active status from the local server.',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Path to the room root folder (containing discussions/ or brainstorms/).',
        },
      },
      required: ['root'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function isDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function safeRealpath(p) {
  try { return realpathSync(p); } catch { return null; }
}

export function resolvePort(env = process.env) {
  const raw = env?.AGENT_ROOM_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (/^\d+$/.test(String(raw))) {
    const port = Number(raw);
    if (port >= 1 && port <= 65535) return port;
  }
  throw new Error(`AGENT_ROOM_PORT must be a port number from 1 to 65535, not "${raw}"`);
}

function readSavedRooms(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rooms) ? parsed.rooms : [];
    return list.filter((entry) => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

export async function fetchRunningRooms(port, fetchImpl = fetch) {
  try {
    const base = `http://127.0.0.1:${port}`;
    const get = async (path) => {
      const res = await fetchImpl(base + path, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error('Server did not answer');
      return res.json();
    };
    const health = await get('/__health');
    if (health.app !== 'agent-room' || !Array.isArray(health.rooms) ||
        !health.rooms.every((r) => r && typeof r.id === 'string' && typeof r.root === 'string')) {
      return { reachable: false, rooms: [] };
    }
    const rooms = await Promise.all(health.rooms.map(async (r) => {
      const room = await get(`/r/${encodeURIComponent(r.id)}/__health`);
      if (room.app !== 'agent-room' || room.root !== r.root) throw new Error('Invalid room health');
      return { ...r, board: room.board };
    }));
    return { reachable: true, rooms };
  } catch {
    return { reachable: false, rooms: [] };
  }
}

function textResult(text, isError = false) {
  const result = { content: [{ type: 'text', text }] };
  if (isError) result.isError = true;
  return result;
}

export async function listRoomsTool(opts = {}) {
  const env = opts.env ?? process.env;
  let port;
  try { port = opts.port ?? resolvePort(env); }
  catch (err) { return textResult(err.message, true); }

  const file = opts.roomsFile ?? roomsFilePath(opts.home ?? homedir());
  const saved = readSavedRooms(file);
  const { reachable, rooms: running } = await fetchRunningRooms(port, opts.fetch ?? fetch);

  const byRoot = new Map();
  for (const r of running) {
    const root = safeRealpath(r.root) ?? r.root;
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { root, status: 'running', active: [] };
      byRoot.set(root, entry);
    }
    if (r.board && !entry.active.includes(r.board)) {
      entry.active.push(r.board);
    }
  }

  let skippedMissing = 0;
  for (const p of saved) {
    if (!isDirectory(p)) {
      skippedMissing++;
      continue;
    }
    const root = safeRealpath(p) ?? p;
    if (!byRoot.has(root)) {
      byRoot.set(root, {
        root,
        status: reachable ? 'not running on this server' : 'unknown',
        active: [],
      });
    }
  }

  const rows = [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
  const lines = [];
  if (!reachable) {
    lines.push(`No agent-room server answered on 127.0.0.1:${port} (saved rooms' running status is unknown).`);
  }
  if (!rows.length) {
    lines.push('No rooms found.');
  } else {
    for (const r of rows) {
      if (r.status === 'running') {
        const active = r.active.length ? r.active.join(', ') : 'none';
        lines.push(`- ${r.root} — running, active: ${active}`);
      } else {
        lines.push(`- ${r.root} — ${r.status}`);
      }
    }
  }
  if (skippedMissing > 0) {
    const noun = skippedMissing === 1 ? 'folder' : 'folders';
    const verb = skippedMissing === 1 ? 'exists' : 'exist';
    lines.push(`Skipped ${skippedMissing} saved ${noun} that no longer ${verb}.`);
  }
  return textResult(lines.join('\n'));
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export async function listBoardsTool(args = {}, opts = {}) {
  const rawRoot = args?.root;
  if (typeof rawRoot !== 'string' || !rawRoot.trim()) {
    return textResult('Missing required argument: root', true);
  }
  const env = opts.env ?? process.env;
  let port;
  try { port = opts.port ?? resolvePort(env); }
  catch (err) { return textResult(err.message, true); }

  const home = opts.home ?? homedir();
  const resolved = resolve(expandHome(rawRoot.trim(), home));
  if (!isDirectory(resolved)) {
    return textResult(`Folder does not exist or is not a directory: ${rawRoot}`, true);
  }
  const realRoot = safeRealpath(resolved) ?? resolved;
  const discDir = join(realRoot, 'discussions');
  const brainDir = join(realRoot, 'brainstorms');
  const hasDisc = isDirectory(discDir);
  const hasBrain = isDirectory(brainDir);
  if (!hasDisc && !hasBrain) {
    return textResult(`Not a room folder (no discussions/ or brainstorms/ directory): ${realRoot}`, true);
  }

  const items = [];
  const scan = (dir, prefix, kind) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && DATED.test(entry.name)) {
        const itemKind = kind === 'sprint' && existsSync(join(dir, entry.name, '.workbench')) ? 'workbench' : kind;
        items.push({ name: entry.name, kind: itemKind, ref: `${prefix}/${entry.name}` });
      }
    }
  };
  if (hasDisc) scan(discDir, 'discussions', 'sprint');
  if (hasBrain) scan(brainDir, 'brainstorms', 'brainstorm');
  items.sort((a, b) => b.name.localeCompare(a.name) || a.kind.localeCompare(b.kind));

  const { reachable, rooms: running } = await fetchRunningRooms(port, opts.fetch ?? fetch);
  const activeSet = new Set();
  let statusLine;
  if (!reachable) {
    statusLine = `running status unknown (no server answered on port ${port})`;
  } else {
    const matched = running.filter((r) => (safeRealpath(r.root) ?? r.root) === realRoot);
    if (!matched.length) {
      statusLine = 'not running on this server';
    } else {
      for (const r of matched) if (r.board) activeSet.add(r.board);
      statusLine = activeSet.size
        ? `running (active: ${[...activeSet].join(', ')})`
        : 'running (no active board)';
    }
  }

  const lines = [`Room: ${realRoot}`, `Status: ${statusLine}`];
  if (!items.length) {
    lines.push('No open boards or brainstorms.');
  } else {
    for (const item of items) {
      const mark = activeSet.has(item.ref) ? ' [active]' : '';
      lines.push(`- ${item.name} (${item.kind})${mark}`);
    }
  }
  return textResult(lines.join('\n'));
}

export async function handleMessage(msg, opts = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  const { id, method, params } = msg;

  // Notifications carry no id and must not receive a response.
  if (!hasId) return null;

  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'list_rooms') {
      return { jsonrpc: '2.0', id, result: await listRoomsTool(opts) };
    }
    if (name === 'list_boards') {
      return { jsonrpc: '2.0', id, result: await listBoardsTool(args, opts) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function serveStdio(input = process.stdin, output = process.stdout, opts = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  const send = (res) => {
    if (res) output.write(JSON.stringify(res) + '\n');
  };
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      try {
        send(await handleMessage(msg, opts));
      } catch (err) {
        if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err?.message ?? 'Internal error' } });
        }
      }
    });
  });
  return { rl, done: () => chain };
}

const isMain = process.argv[1]
  && (safeRealpath(fileURLToPath(import.meta.url)) ?? fileURLToPath(import.meta.url))
    === (safeRealpath(resolve(process.argv[1])) ?? resolve(process.argv[1]));

if (isMain) {
  serveStdio();
}
