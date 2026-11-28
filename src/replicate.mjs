// Replication of discussions between paired rooms on other machines (nodes), loaded only with
// --node. Each round ends with one commit on this node's line of the discussion, in Git storage of
// its own (<root>/.agent-room/store.git, never the project's repository); the line is sent to each
// paired peer as a Git bundle over HTTP, in the background. A peer's lines arrive read-only: checked,
// written into a complete snapshot folder, then published by one atomic rename of a pointer file.
// Ported from the stage B0 prototype (discussions/2026-11-06-teleporting-agent-room-sessions-to-background/).
//
// <root>/.agent-room/  store.git/  tmp/  room.json (room ID, pairings)  discussions.json (folder → ID)
//   acked.json (what each peer acknowledged)  received/<discussion>/<node>/{published.json, snapshots/<commit>/}
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { join, dirname, basename, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export const PROTOCOL = 1;
export const META = '.agent-room-round.json'; // the round's metadata and conversation, at the tree's root
export const STORE = '.agent-room';
export const LIMITS = { bundleBytes: 64 << 20, files: 5000, fileBytes: 16 << 20, jsonBytes: 4096 };
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;            // room and discussion IDs (made here)
export const NODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/; // node names (given with --node, --peer)
const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);
const OUTCOMES = ['completed', 'failed', 'interrupted'];
const rand = () => randomBytes(6).toString('hex');
const RETRY = { first: 5_000, max: 300_000, idle: 15_000, timeout: 30_000 };

export class Refused extends Error {
  constructor(status, code, detail) { super(detail); Object.assign(this, { status, code, detail }); }
}

// ── Git: argument arrays, never a shell; no system/global config, no hooks, no automatic gc ──
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const BASE = ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
export const gitStats = { runs: 0 };
export function git(store, args, { input, binary, cwd, env } = {}) {
  gitStats.runs++;
  return new Promise((ok, fail) => {
    const child = execFile('git', ['--git-dir', store, ...BASE, ...args], { cwd, env: { ...ENV, ...env }, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 28 },
      (err, out, errOut) => (err ? fail(new Error(`git ${args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c')}: ${String(errOut || err.message).trim()}`))
        : ok(binary ? out : out.replace(/\n$/, ''))));
    if (input !== undefined) child.stdin.end(input);
  });
}
// Many blobs in one process: `git cat-file --batch`. Resolves to their contents, in order.
function catBlobs(store, shas) {
  if (!shas.length) return Promise.resolve([]);
  gitStats.runs++;
  return new Promise((ok, fail) => {
    const child = spawn('git', ['--git-dir', store, ...BASE, 'cat-file', '--batch'], { env: ENV });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', fail);
    child.on('close', (code) => {
      const out = Buffer.concat(chunks), blobs = [];
      for (let at = 0; blobs.length < shas.length;) {
        const nl = out.indexOf(10, at);
        const [, type, size] = nl < 0 ? [] : out.subarray(at, nl).toString().split(' ');
        if (type !== 'blob') return fail(new Error(`git cat-file: ${code ? `exit ${code}` : `no blob ${shas[blobs.length]}`}`));
        blobs.push(out.subarray(nl + 1, nl + 1 + Number(size)));
        at = nl + 2 + Number(size);
      }
      ok(blobs);
    });
    child.stdin.end(shas.join('\n') + '\n');
  });
}
export const gitVersion = () => new Promise((ok) => execFile('git', ['--version'], (e, out) => ok(e ? null : out.trim())));
const has = (store, sha) => git(store, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
const isAncestor = (store, a, b) => git(store, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
export const revParse = (store, ref) => git(store, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => null);
export const lineRef = (d, n) => `refs/lines/${d}/${n}`;
const receivedRef = (d, n) => `refs/received/${d}/${n}`;
const incomingRef = (d, n) => `refs/incoming/${d}/${n}`;

// ── Files ──
async function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${rand()}`;
  const fh = await fs.open(tmp, 'wx');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, path);
}
const readJson = (path) => fs.readFile(path, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
async function chmodDirs(dir, mode) { // folders only: snapshot files stay 0444
  if (!(await fs.lstat(dir)).isDirectory()) return;
  await fs.chmod(dir, mode);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await chmodDirs(join(dir, e.name), mode);
}
export async function removeTree(dir) {
  try { await chmodDirs(dir, 0o755); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  await fs.rm(dir, { recursive: true, force: true });
}
const dirs = (path) => fs.readdir(path).catch(() => []);

// ── The storage ──
// Opening it is a (re)start: recovery runs first. `root` is the room's root folder.
export async function openStore(root, node) {
  const dir = join(root, STORE);
  const s = { root, node, dir, store: join(dir, 'store.git'), tmp: join(dir, 'tmp'), received: join(dir, 'received'), chains: new Map(), pins: new Map() };
  await fs.mkdir(s.tmp, { recursive: true });
  if (!existsSync(join(s.store, 'HEAD'))) await new Promise((ok, fail) => execFile('git', ['init', '-q', '--bare', s.store], { env: ENV }, (e) => (e ? fail(e) : ok())));
  const identity = await readJson(join(dir, 'node.json'));
  if (identity && identity.node !== node) throw new Error(`This storage belongs to node ${identity.node}, not ${node}. Use its existing --node name.`);
  if (!identity) await writeAtomic(join(dir, 'node.json'), JSON.stringify({ node }) + '\n');
  await excludeFromProject(root);
  s.recovered = await recover(s);
  return s;
}

// The project's Git (if any) ignores .agent-room/, through its local info/exclude: never committed.
async function excludeFromProject(root) {
  const file = await new Promise((ok) => execFile('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], (e, out) => ok(e ? null : out.trim())));
  if (!file) return;
  const top = await new Promise((ok) => execFile('git', ['-C', root, 'rev-parse', '--show-toplevel'], (e, out) => ok(e ? null : out.trim())));
  const rel = `/${[...(top ? root.slice(top.length).split(sep).filter(Boolean) : []), STORE].join('/')}/`;
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (text.split('\n').some((l) => l.trim() === rel)) return;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${rel}\n`);
}

// Serializes everything that changes one received line (receiving, pinning, cleaning up).
function serial(s, key, fn) {
  const run = (s.chains.get(key) ?? Promise.resolve()).then(fn);
  s.chains.set(key, run.catch(() => {}));
  return run;
}
const lineDir = (s, d, n) => join(s.received, d, n);
export const readPointer = (s, d, n) => readJson(join(lineDir(s, d, n), 'published.json'));
const pinned = (s, d, n) => new Set([...s.pins.keys()].filter((k) => k.startsWith(`${d}/${n}/`)).map((k) => k.split('/')[2]));

// Snapshot folders other than the published one and pinned ones (open in View) are deleted; their
// commits stay in Git.
async function cleanLine(s, d, n) {
  const p = await readPointer(s, d, n), keep = pinned(s, d, n);
  let removed = 0;
  for (const f of await dirs(join(lineDir(s, d, n), 'snapshots'))) {
    if (f === p?.commit || keep.has(f)) continue;
    await removeTree(join(lineDir(s, d, n), 'snapshots', f)); removed++;
  }
  return removed;
}

// At start: uploads, staging folders, snapshots no pointer names and incoming refs go; the received
// ref follows the pointer, which alone says what this node shows.
export async function recover(s) {
  const report = { tmp: 0, snapshots: 0, incomingRefs: 0, refRepaired: 0 };
  for (const f of await dirs(s.tmp)) { await removeTree(join(s.tmp, f)); report.tmp++; }
  const refs = (await git(s.store, ['for-each-ref', '--format=%(refname)', 'refs/incoming/'])).split('\n').filter(Boolean);
  for (const ref of refs) { await git(s.store, ['update-ref', '-d', ref]); report.incomingRefs++; }
  for (const d of await dirs(s.received)) {
    for (const n of await dirs(join(s.received, d))) {
      for (const f of await dirs(lineDir(s, d, n))) if (f.startsWith('published.json.tmp-')) await fs.rm(join(lineDir(s, d, n), f));
      report.snapshots += await cleanLine(s, d, n);
      const p = await readPointer(s, d, n);
      if (p && (await revParse(s.store, receivedRef(d, n))) !== p.commit) { await git(s.store, ['update-ref', receivedRef(d, n), p.commit]); report.refRepaired++; }
    }
  }
  return report;
}

// room.json: { roomId, paired: { <node>: { roomId, at } } }. discussions.json: { <folder name>: <ID> }.
export const roomInfo = async (s) => (await readJson(join(s.dir, 'room.json'))) ?? { roomId: null, paired: {} };
const saveRoom = (s, r) => writeAtomic(join(s.dir, 'room.json'), JSON.stringify(r, null, 2) + '\n');
export async function boardId(s, name, create = false) {
  name = basename(name);
  const map = (await readJson(join(s.dir, 'discussions.json'))) ?? {};
  if (!map[name] && create) { map[name] = `d-${rand()}`; await writeAtomic(join(s.dir, 'discussions.json'), JSON.stringify(map, null, 2) + '\n'); }
  return map[name] ?? null;
}
export const boardIds = async (s) => (await readJson(join(s.dir, 'discussions.json'))) ?? {};

// ── Capture: one commit per round on refs/lines/<discussion>/<this node> ──
// Built from the folder's bytes with plumbing: no project index, ignore rules, attributes or filters
// (the project's .gitignore ignores transcripts/; they are captured all the same). Hidden files and
// anything not a regular file are left out (and reported). Files that change while they are read
// (the worker may be writing its notes) make it try again, then fail.
async function folderFiles(folder) {
  const files = [], skipped = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(join(folder, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.')) continue;
      if (/[\n\\]/.test(p)) { skipped.push(p); continue; }
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.push(p);
      else skipped.push(p);
    }
  };
  await walk('');
  return { files: files.sort(), skipped };
}
const stamps = (folder, files) => Promise.all(files.map((f) => fs.stat(join(folder, f)).then((st) => `${st.size}:${st.mtimeMs}`, () => 'gone')));

export async function capture(s, { name, dir, title }, round, { attempts = 3, detached = false } = {}) {
  const d = await boardId(s, name, true), ref = lineRef(d, s.node);
  const room = (await roomInfo(s)).roomId ?? null;
  for (let attempt = 1; ; attempt++) {
    const { files, skipped } = await folderFiles(dir);
    if (files.length + 1 > LIMITS.files) throw new Error('Too many board files');
    const stats = await Promise.all(files.map(f => fs.lstat(join(dir, f))));
    if (stats.some(st => !st.isFile() || st.size > LIMITS.fileBytes) || stats.reduce((n, st) => n + st.size, 0) > LIMITS.bundleBytes * 4) throw new Error('Board files exceed snapshot limits');
    const before = await stamps(dir, files);
    const shas = files.length ? (await git(s.store, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { cwd: dir, input: files.join('\n') + '\n' })).split('\n') : [];
    const after = await stamps(dir, files);
    const again = await folderFiles(dir);
    if (files.join('\0') !== again.files.join('\0') || before.some((b, i) => b !== after[i] || b === 'gone')) {
      if (attempt < attempts) { await new Promise((r) => setTimeout(r, 200)); continue; }
      throw new Error(`files kept changing while they were saved (${files.filter((_, i) => before[i] !== after[i]).slice(0, 3).join(', ')})`);
    }
    const parent = await revParse(s.store, ref);
    const number = parent ? JSON.parse(await git(s.store, ['cat-file', 'blob', `${parent}:${META}`])).round + 1 : 1;
    const meta = { schema: 1, room, discussion: d, node: s.node, round: number, name, title, at: new Date().toISOString(), ...round };
    const metaSha = await git(s.store, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(meta, null, 1) + '\n' });
    const index = join(s.tmp, `index-${rand()}`);
    try {
      const entries = [[META, metaSha], ...files.map((f, i) => [f, shas[i]])];
      await git(s.store, ['update-index', '--add', '-z', '--index-info'], { env: { GIT_INDEX_FILE: index }, input: entries.map(([p, h]) => `100644 ${h}\t${p}\0`).join('') });
      const tree = await git(s.store, ['write-tree'], { env: { GIT_INDEX_FILE: index } });
      const who = { GIT_AUTHOR_NAME: s.node, GIT_AUTHOR_EMAIL: `${s.node}@agent-room.invalid`, GIT_COMMITTER_NAME: s.node, GIT_COMMITTER_EMAIL: `${s.node}@agent-room.invalid` };
      const commit = await git(s.store, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `${round.kind} ${number} (${round.outcome})`], { env: who });
      if (!detached) await git(s.store, ['update-ref', ref, commit, parent ?? ZERO]); // append-only: the old value is checked
      return { board: d, commit, round: number, skipped, ...(detached && { parent }) };
    } finally { await fs.rm(index, { force: true }); }
  }
}
export async function publishCapture(s, capture) {
  await git(s.store, ['update-ref', lineRef(capture.board, s.node), capture.commit, capture.parent ?? ZERO]);
}
export async function discardCapture(s, capture) {
  const ref = lineRef(capture.board, s.node);
  if (await revParse(s.store, ref) !== capture.commit) return;
  if (capture.parent) await git(s.store, ['update-ref', ref, capture.parent, capture.commit]);
  else await git(s.store, ['update-ref', '-d', ref, capture.commit]);
}
// This node's lines: { <discussion ID>: { commit, round } }.
export async function ownLines(s) {
  const out = (await git(s.store, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/lines/`])).split('\n').filter(Boolean);
  const lines = {};
  for (const l of out) {
    const [ref, commit] = l.split(' '), [, , d, n] = ref.split('/');
    if (n === s.node) lines[d] = { commit };
  }
  return lines;
}

export const lineRound = async (s, commit) => JSON.parse(await git(s.store, ['cat-file', 'blob', `${commit}:${META}`])).round;

// ── Sending ──
const ackFile = (s) => join(s.dir, 'acked.json');
export const acked = async (s, peer, d) => (await readJson(ackFile(s)))?.[`${peer}/${d}`] ?? null;
async function recordAck(s, peer, d, commit) {
  return serial(s, 'acknowledgements', async () => {
    const a = (await readJson(ackFile(s))) ?? {};
    a[`${peer}/${d}`] = commit;
    await writeAtomic(ackFile(s), JSON.stringify(a, null, 2) + '\n');
  });
}
export async function makeBundle(s, d, base, file = join(s.tmp, `out-${rand()}.bundle`)) {
  await git(s.store, ['bundle', 'create', '-q', file, lineRef(d, s.node), ...(base ? [`^${base}`] : [])]);
  return { file, bytes: (await fs.stat(file)).size };
}
function request(url, { method = 'POST', headers = {}, body, file, timeoutMs = RETRY.timeout } = {}) {
  return new Promise((ok, fail) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 65536) req.destroy(new Error('peer response exceeds 64 KiB')); else chunks.push(c); });
      res.on('end', () => { try { ok({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { fail(e); } });
      res.on('error', fail);
    });
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.once('close', () => clearTimeout(deadline));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', fail);
    if (file) createReadStream(file).on('error', (e) => req.destroy(e)).pipe(req); else req.end(body);
  });
}
const JSON_TYPE = { 'content-type': 'application/json' };
export const BUNDLE_TYPE = 'application/x-git-bundle';
export const offerHeader = (o) => ({ 'x-agent-room-offer': JSON.stringify(o) });
export async function postBundle(url, offer, file) {
  const { size } = await fs.stat(file);
  return request(`${url}/replica/bundle`, { headers: { ...offerHeader(offer), 'content-type': BUNDLE_TYPE, 'content-length': size }, file });
}

// One line to one peer: an offer, then a bundle based on the last acknowledged commit; a missing
// base falls back once to a full bundle. Returns what happened.
export async function send(s, peer, url, d) {
  const t0 = performance.now();
  const room = (await roomInfo(s)).roomId;
  const commit = await revParse(s.store, lineRef(d, s.node));
  let base = await acked(s, peer, d);
  const offer = { protocol: PROTOCOL, room, board: d, node: s.node, commit, base };
  const o = await request(`${url}/replica/offer`, { headers: JSON_TYPE, body: JSON.stringify(offer) });
  if (o.status !== 200) throw new Refused(o.status, o.body.error, o.body.detail);
  const done = async (got) => {
    if (got !== commit) throw new Error(`${peer} acknowledged ${got}, not the offered ${commit}`);
    await recordAck(s, peer, d, commit);
  };
  if (o.body.status === 'have') { await done(o.body.commit); return { kind: 'already-had', bytes: 0, acked: commit, ms: performance.now() - t0 }; }
  if (base && !(await isAncestor(s.store, base, commit))) base = null; // our own line was rewritten: send it all
  const attempts = [];
  for (;;) {
    const b = await makeBundle(s, d, base);
    try {
      const r = await postBundle(url, { ...offer, base }, b.file);
      attempts.push({ kind: base ? 'incremental' : 'full', bytes: b.bytes, status: r.status, error: r.body.error });
      if (r.status === 409 && r.body.error === 'missing-base' && base) { base = null; continue; }
      if (r.status !== 200) throw new Refused(r.status, r.body.error, r.body.detail);
      await done(r.body.acked);
      return { kind: attempts.map((a) => a.kind).join('→'), attempts, bytes: b.bytes, acked: commit, duplicate: !!r.body.duplicate, ms: performance.now() - t0 };
    } finally { await fs.rm(b.file, { force: true }); }
  }
}

// ── Receiving ──
// The offer's identities: this room, a paired peer that isn't this node, full commit IDs.
async function checkOffer(s, peers, o) {
  const bad = (status, code, why) => { throw new Refused(status, code, why); };
  if (!o || typeof o !== 'object' || o.protocol !== PROTOCOL) bad(400, 'invalid-schema', `protocol ${o?.protocol}`);
  if (typeof o.board !== 'string' || !ID.test(o.board) || typeof o.node !== 'string' || !NODE.test(o.node)) bad(400, 'invalid-identity', 'bad board or node ID');
  if (!SHA.test(o.commit ?? '') || !(o.base === null || SHA.test(o.base ?? ''))) bad(400, 'invalid-schema', 'commit/base are not full commit IDs');
  if (o.node === s.node) bad(403, 'wrong-identity', `a peer can't write this node's own line (${o.node})`);
  const r = await roomInfo(s);
  if (!peers.includes(o.node) || !r.paired[o.node]) bad(403, 'not-paired', `${o.node} is not a paired peer of this room`);
  if (!r.roomId || o.room !== r.roomId) bad(403, 'wrong-identity', `room ${o.room}, this room is ${r.roomId}`);
}

async function bundleHeader(file) { // v2: "-<sha> …" prerequisites, "<sha> <ref>" heads, then a blank line
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536), { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('latin1'), end = text.indexOf('\n\n'), lines = text.slice(0, end).split('\n');
    if (end < 0 || lines[0] !== '# v2 git bundle') throw new Refused(400, 'corrupt', 'not a v2 bundle header');
    const prereqs = [], heads = [];
    for (const l of lines.slice(1)) {
      const m = /^(-?)([0-9a-f]{40})(?: (.*))?$/.exec(l);
      if (!m) throw new Refused(400, 'corrupt', `bad bundle header line ${JSON.stringify(l)}`);
      (m[1] ? prereqs : heads).push({ sha: m[2], ref: m[3] });
    }
    return { prereqs, heads };
  } finally { await fh.close(); }
}

// A received tree: regular files only, safe relative paths, no names that collide on a case- or
// normalization-insensitive disk (macOS), within limits.
export function validateTree(entries) {
  const bad = (why) => { throw new Refused(422, 'unsafe-tree', why); };
  if (entries.length > LIMITS.files) bad(`${entries.length} files (limit ${LIMITS.files})`);
  if (entries.reduce((n, e) => n + e.size, 0) > LIMITS.bundleBytes * 4) bad('expanded tree exceeds 256 MiB');
  const seen = new Map();
  for (const e of entries) {
    if (e.mode === '120000') bad(`symlink ${e.path}`);
    if (e.mode === '160000') bad(`submodule ${e.path}`);
    if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) bad(`unsupported entry ${e.mode} ${e.type} ${e.path}`);
    if (e.path.startsWith('/')) bad(`absolute path ${e.path}`);
    const parts = e.path.split('/');
    for (const p of parts) if (!p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[\\\0]/.test(p)) bad(`unsafe path ${JSON.stringify(e.path)}`);
    if (e.size > LIMITS.fileBytes) bad(`${e.path} is ${e.size} bytes`);
    parts.forEach((_, i) => {
      const key = parts.slice(0, i + 1).join('/').normalize('NFC').toLowerCase(), kind = i === parts.length - 1 ? `file:${e.path}` : 'dir';
      if (seen.has(key) && (kind !== 'dir' || seen.get(key) !== 'dir')) bad(`names collide on this disk: ${e.path}`);
      seen.set(key, kind);
    });
  }
  return entries;
}
export async function listTree(store, commit) {
  return (await git(store, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit])).split('\0').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t'), [mode, type, sha, size] = l.slice(0, tab).split(/ +/);
    return { mode, type, sha, size: size === '-' ? 0 : Number(size), path: l.slice(tab + 1) };
  });
}
// The round metadata: exactly these keys, of these types, naming this room, discussion and node.
const META_KEYS = 'agents,at,conversation,discussion,ending,kind,name,node,outcome,room,round,schema,summary,title';
export function validateMeta(roomId, m, o, published) {
  const bad = (code, why) => { throw new Refused(422, code, why); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('invalid-schema', 'round metadata is not an object');
  const keys = Object.keys(m).sort().join(',');
  if (keys !== META_KEYS) bad('invalid-schema', `round metadata keys ${keys}`);
  if (m.schema !== 1) bad('invalid-schema', `schema ${m.schema}`);
  if (!Number.isInteger(m.round) || m.round < 1) bad('invalid-schema', `round ${JSON.stringify(m.round)}`);
  if (!['round', 'summary'].includes(m.kind) || !OUTCOMES.includes(m.outcome)) bad('invalid-schema', `kind ${JSON.stringify(m.kind)}, outcome ${JSON.stringify(m.outcome)}`);
  if (!/^\d{4}-\d{2}-\d{2}-[^/\\]{1,120}$/.test(m.name ?? '') || m.name.startsWith('.') || typeof m.title !== 'string' || m.title.length > 300) bad('invalid-schema', `name or title ${JSON.stringify(m.name)}`);
  if (typeof m.at !== 'string' || Number.isNaN(Date.parse(m.at)) || typeof m.ending !== 'string' || !(m.summary === null || typeof m.summary === 'string')) bad('invalid-schema', 'at, ending or summary');
  if (!Array.isArray(m.agents) || !m.agents.every((a) => a && typeof a.name === 'string' && typeof a.provider === 'string')) bad('invalid-schema', 'agents');
  if (!Array.isArray(m.conversation) || !m.conversation.every((e) => e && typeof e.speaker === 'string' && typeof e.text === 'string')) bad('invalid-schema', 'conversation');
  // A commit made before this room was paired carries no room ID yet (null); later ones carry this room's.
  if ((m.room !== null && m.room !== roomId) || m.discussion !== o.board || m.node !== o.node) bad('wrong-identity', `commit says ${m.room}/${m.discussion}/${m.node}, offer is ${roomId}/${o.board}/${o.node}`);
  if (published && m.round <= published.round) bad('invalid-schema', `round ${m.round} after published round ${published.round}`);
}

// Receives one saved bundle. `at(point)` exists for the restart tests only.
export async function receive(s, peers, file, o, at = async () => {}) {
  await checkOffer(s, peers, o);
  await at('after-save');
  return serial(s, `${o.board}/${o.node}`, async () => {
    const line = lineDir(s, o.board, o.node), published = await readPointer(s, o.board, o.node);
    if (published?.commit === o.commit) return { acked: o.commit, duplicate: true }; // a duplicate, or a lost reply
    const { prereqs, heads } = await bundleHeader(file);
    const want = lineRef(o.board, o.node);
    if (heads.length !== 1 || heads[0].ref !== want) throw new Refused(422, 'wrong-identity', `bundle carries ${heads.map((h) => h.ref).join(', ')}, expected ${want}`);
    if (heads[0].sha !== o.commit) throw new Refused(422, 'wrong-identity', 'bundle tip differs from the offered commit');
    for (const p of prereqs) if (!(await has(s.store, p.sha))) throw new Refused(409, 'missing-base', `this node lacks ${p.sha}`);
    try { await git(s.store, ['bundle', 'verify', '-q', file]); } catch (e) { throw new Refused(400, 'corrupt', e.message); }
    const tmpRef = incomingRef(o.board, o.node);
    try {
      try { await git(s.store, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', file, `+${want}:${tmpRef}`]); }
      catch (e) { throw new Refused(400, 'corrupt', e.message); }
      await at('after-import');
      if ((await revParse(s.store, tmpRef)) !== o.commit) throw new Refused(422, 'wrong-identity', 'imported tip differs from the offer');
      const entries = validateTree(await listTree(s.store, o.commit));
      if (published && !(await isAncestor(s.store, published.commit, o.commit))) throw new Refused(409, 'rewrite', `${o.commit} does not descend from the published ${published.commit}; nothing changed`);
      const metaAt = entries.findIndex((e) => e.path === META);
      if (metaAt < 0) throw new Refused(422, 'invalid-schema', `no ${META}`);
      const blobs = await catBlobs(s.store, entries.map((e) => e.sha));
      let meta; try { meta = JSON.parse(blobs[metaAt].toString('utf8')); } catch { throw new Refused(422, 'invalid-schema', `${META} is not JSON`); }
      validateMeta((await roomInfo(s)).roomId, meta, o, published);

      // A staging folder renamed into place: no reader ever sees a half-written snapshot.
      const snaps = join(line, 'snapshots'), staging = join(snaps, `.staging-${rand()}`), final = join(snaps, o.commit);
      await fs.mkdir(staging, { recursive: true });
      for (const [i, e] of entries.entries()) {
        const dest = join(staging, ...e.path.split('/'));
        await fs.mkdir(dirname(dest), { recursive: true });
        await fs.writeFile(dest, blobs[i], { flag: 'wx', mode: 0o444 });
        if (i === Math.floor(entries.length / 2)) await at('mid-materialize');
      }
      if (existsSync(final)) await removeTree(final); // a pinned copy of the same commit can't be: it would be published
      await fs.rename(staging, final);
      await chmodDirs(final, 0o555);
      await at('after-materialize');
      // Publication: the pointer's rename is the one atomic step; the received ref then follows it.
      const pointer = { commit: o.commit, round: meta.round, kind: meta.kind, outcome: meta.outcome, name: meta.name, title: meta.title, at: meta.at, receivedAt: new Date().toISOString() };
      await writeAtomic(join(line, 'published.json'), JSON.stringify(pointer, null, 2) + '\n');
      await git(s.store, ['update-ref', receivedRef(o.board, o.node), o.commit]);
      await at('after-publish');
      await cleanLine(s, o.board, o.node);
      return { acked: o.commit, pointer };
    } finally { await git(s.store, ['update-ref', '-d', tmpRef]).catch(() => {}); }
  });
}

// Every received line: [{ board, node, ...pointer }].
export async function receivedLines(s) {
  const out = [];
  for (const d of await dirs(s.received)) for (const n of await dirs(join(s.received, d))) {
    const p = await readPointer(s, d, n).catch(() => null);
    if (p) out.push({ board: d, node: n, ...p });
  }
  return out;
}

// View pins the published snapshot of a line until unpinned: cleanup leaves it alone, so pages can
// keep reading it while newer rounds arrive. Resolves to the pinned pointer and its conversation.
export function pin(s, d, n, commit = null) {
  if (!ID.test(d ?? '') || !NODE.test(n ?? '') || (commit && !SHA.test(commit))) return Promise.resolve(null);
  return serial(s, `${d}/${n}`, async () => {
    const p = await readPointer(s, d, n);
    if (!p || (commit && commit !== p.commit && !existsSync(join(lineDir(s, d, n), 'snapshots', commit)))) return null;
    const c = commit ?? p.commit, key = `${d}/${n}/${c}`;
    s.pins.set(key, (s.pins.get(key) ?? 0) + 1);
    const meta = JSON.parse(await fs.readFile(join(lineDir(s, d, n), 'snapshots', c, META), 'utf8'));
    return { board: d, node: n, commit: c, round: meta.round, kind: meta.kind, outcome: meta.outcome, name: meta.name, title: meta.title, receivedAt: c === p.commit ? p.receivedAt : null, conversation: meta.conversation };
  });
}
export function unpin(s, d, n, commit) {
  const key = `${d}/${n}/${commit}`, left = (s.pins.get(key) ?? 1) - 1;
  if (left > 0) s.pins.set(key, left); else s.pins.delete(key);
  return serial(s, `${d}/${n}`, () => cleanLine(s, d, n));
}
// The file at rel in a kept snapshot, or null (no escapes, nothing hidden).
export function snapshotFile(s, d, n, commit, rel) {
  if (!ID.test(d) || !NODE.test(n) || !SHA.test(commit)) return null;
  const parts = rel.split('/');
  if (!rel || parts.some((p) => !p || p.startsWith('.'))) return null;
  const file = join(lineDir(s, d, n), 'snapshots', commit, ...parts);
  return existsSync(file) ? file : null;
}
export const snapshotPath = (s, d, n, commit) => (ID.test(d) && NODE.test(n) && SHA.test(commit) ? join(lineDir(s, d, n), 'snapshots', commit) : null);

// ── The peer endpoint: GET /replica/status, POST /replica/pair, /replica/offer, /replica/bundle ──
// No browser page can post here: JSON and the bundle type need a CORS preflight, which is never approved.
const sendJson = (res, status, body) => { if (!res.writableEnded && !res.destroyed) res.writeHead(status, JSON_TYPE).end(JSON.stringify(body)); };
async function bodyJson(req, limit = LIMITS.jsonBytes) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Refused(413, 'too-large', 'request body'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refused(400, 'invalid-schema', 'not JSON'); }
}
export async function handle(r, req, res) {
  const { s } = r;
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/replica/status' && req.method === 'GET') {
      const room = await roomInfo(s);
      return sendJson(res, 200, { app: 'agent-room', protocol: PROTOCOL, node: s.node, roomId: room.roomId, root: s.root, activity: r.activity(), project: r.project?.() ?? null, git: r.git });
    }
    if (req.method !== 'POST') throw new Refused(405, 'method', 'POST only');
    const type = (req.headers['content-type'] ?? '').split(';')[0];
    if (path === '/replica/pair' || path === '/replica/offer') {
      if (type !== 'application/json') throw new Refused(415, 'type', 'JSON only');
      const body = await bodyJson(req);
      if (path === '/replica/pair') return sendJson(res, 200, await acceptPairing(r, body));
      await checkOffer(s, r.peers.map((p) => p.name), body);
      const p = await readPointer(s, body.board, body.node);
      return sendJson(res, 200, p?.commit === body.commit ? { status: 'have', commit: p.commit } : { status: 'send', published: p?.commit ?? null });
    }
    if (path !== '/replica/bundle') throw new Refused(404, 'not-found', path);
    if (type !== BUNDLE_TYPE) throw new Refused(415, 'type', BUNDLE_TYPE);
    const raw = req.headers['x-agent-room-offer'] ?? '';
    if (raw.length > LIMITS.jsonBytes) throw new Refused(413, 'too-large', 'offer header');
    let o; try { o = JSON.parse(raw); } catch { throw new Refused(400, 'invalid-schema', 'offer header is not JSON'); }
    await checkOffer(s, r.peers.map((p) => p.name), o);
    const len = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(len) || len <= 0) throw new Refused(411, 'length-required', 'content-length');
    if (len > r.limits.bundleBytes) { res.setHeader('connection', 'close'); throw new Refused(413, 'too-large', `${len} bytes (limit ${r.limits.bundleBytes})`); }
    req.setTimeout(RETRY.timeout, () => req.destroy(new Error('upload timed out')));
    const file = join(s.tmp, `in-${rand()}.bundle`);
    try {
      await pipeline(req, createWriteStream(file, { flags: 'wx' }));
      const got = (await fs.stat(file)).size;
      if (got !== len) throw new Refused(400, 'incomplete', `${got} of ${len} bytes`);
      const result = await receive(s, r.peers.map((p) => p.name), file, o);
      if (result.pointer) r.onReceived?.({ board: o.board, node: o.node, ...result.pointer });
      if (r.dropReplyOnce) { r.dropReplyOnce = false; return req.socket.destroy(); } // tests: a lost acknowledgement
      return sendJson(res, 200, { ok: true, acked: result.acked, duplicate: !!result.duplicate });
    } finally { await fs.rm(file, { force: true }); }
  } catch (e) {
    if (!(e instanceof Refused)) r.log?.(`✗ replication: ${e.message}`);
    sendJson(res, e.status ?? 500, { ok: false, error: e.code ?? 'internal', detail: e.detail ?? e.message });
  }
}

// ── Pairing ──
// The asking side's room ID is adopted when this room has none yet (bootstrap, confirmed by the
// User on the asking side); a different established room ID is refused and nothing is replaced.
async function acceptPairing(r, b) {
  return serial(r.s, 'pairings', async () => {
    const { s } = r;
    if (b?.protocol !== PROTOCOL || typeof b.node !== 'string' || !ID.test(b.roomId ?? '')) throw new Refused(400, 'invalid-schema', 'pairing request');
    if (!r.peers.some((p) => p.name === b.node)) throw new Refused(403, 'not-a-peer', `${b.node} isn't among this room's --peer nodes`);
    const room = await roomInfo(s);
    if (room.roomId && room.roomId !== b.roomId) throw new Refused(409, 'room-mismatch', `this room (${s.root}) is ${room.roomId}, not ${b.roomId}: they are different rooms. Nothing was changed.`);
    room.roomId = b.roomId;
    room.paired[b.node] = { roomId: b.roomId, at: new Date().toISOString() };
    await saveRoom(s, room);
    r.changed?.();
    return { ok: true, roomId: room.roomId, node: s.node, root: s.root };
  });
}
export async function pair(r, peerName) {
  const { s } = r, peer = r.peers.find((p) => p.name === peerName);
  if (!peer) throw new Error(`no peer ${peerName}`);
  const st = await request(`${peer.url}/replica/status`, { method: 'GET', timeoutMs: 5000 });
  const room = await roomInfo(s);
  if (st.status !== 200 || st.body.app !== 'agent-room' || st.body.protocol !== PROTOCOL || st.body.node !== peerName) throw new Error('Peer identity or protocol mismatch');
  if (room.roomId && st.body.roomId && room.roomId !== st.body.roomId) throw new Error(`${peerName}'s room (${st.body.root}) is ${st.body.roomId}, this one is ${room.roomId}: they are different rooms. Nothing was changed.`);
  const roomId = room.roomId ?? st.body.roomId ?? `r-${rand()}`;
  const res = await request(`${peer.url}/replica/pair`, { headers: JSON_TYPE, body: JSON.stringify({ protocol: PROTOCOL, node: s.node, roomId, root: s.root }), timeoutMs: 5000 });
  if (res.status !== 200) throw new Error(res.body.detail ?? res.body.error);
  await serial(s, 'pairings', async () => {
    const now = await roomInfo(s); // re-read: nothing else may have set another ID meanwhile
    if (now.roomId && now.roomId !== roomId) throw new Error(`this room became ${now.roomId} meanwhile: nothing was changed here.`);
    now.roomId = roomId;
    now.paired[peerName] = { roomId, at: new Date().toISOString() };
    await saveRoom(s, now);
  });
  r.changed?.();
  kick(r, peerName);
  return { roomId, peer: res.body };
}
export async function peerStatus(r, peerName) {
  const peer = r.peers.find((p) => p.name === peerName);
  return (await request(`${peer.url}/replica/status`, { method: 'GET', timeoutMs: 5000 })).body;
}

// ── Peers: one background loop each. It checks the peer's status and sends every line whose tip
// the peer hasn't acknowledged; failures retry with a growing delay (5 s up to 5 min). Its state is
// kept in `r.state` (in ctx), so a Reload never adds a second loop. ──
export function kick(r, name) {
  const p = r.state.peers[name] ??= { reachable: null, since: null, activity: null, delay: RETRY.first, timer: null, running: null, again: false, waiting: new Set() };
  if (p.running) { p.again = true; return p.running; }
  clearTimeout(p.timer);
  p.running = (async () => {
    let pending = false;
    try {
      do {
        p.again = false;
        pending = await syncPeer(r, name, p);
      } while (p.again);
      p.delay = RETRY.first;
    } catch (e) {
      if (p.reachable !== false) p.since = new Date().toISOString();
      p.reachable = false; p.error = e.message; pending = true;
      p.delay = Math.min(p.delay * 2, RETRY.max);
    } finally {
      p.running = null;
      r.changed?.();
      if (!r.state.stopped) p.timer = setTimeout(() => r.state.tick(name), p.reachable === false || pending ? p.delay : RETRY.idle);
      p.timer?.unref?.();
    }
  })();
  return p.running;
}
async function syncPeer(r, name, p) {
  const { s } = r, peer = r.peers.find((x) => x.name === name);
  const st = (await request(`${peer.url}/replica/status`, { method: 'GET', timeoutMs: 5000 })).body;
  if (st.node !== name) throw new Error(`${peer.url} answers as ${st.node}, not ${name}`);
  Object.assign(p, { reachable: true, since: null, activity: st.activity, project: st.project ?? null, root: st.root, roomId: st.roomId, error: null });
  const room = await roomInfo(s);
  if (!room.paired[name] || st.roomId !== room.roomId) return false; // not paired (yet): nothing is sent
  let pending = false;
  const names = r.canSend ? Object.fromEntries(Object.entries(await boardIds(s)).map(([folder, id]) => [id, folder])) : {};
  for (const [d, { commit }] of Object.entries(await ownLines(s))) {
    if ((await acked(s, name, d)) === commit) continue;
    const folder = names[d];
    if (r.canSend && (!folder || !r.canSend(folder))) continue;
    try {
      const transfer = send(s, name, peer.url, d);
      const active = r.state.transfers ??= new Map();
      if (!active.has(folder)) active.set(folder, new Set());
      active.get(folder).add(transfer);
      let res;
      try { res = await transfer; } finally { active.get(folder).delete(transfer); }
      r.onSent?.({ peer: name, board: d, ...res, late: p.waiting.has(d) });
      p.waiting.delete(d);
    } catch (e) {
      if (!(e instanceof Refused)) throw e; // unreachable: the whole peer waits
      p.error = `${e.code}: ${e.detail}`; pending = true; p.waiting.add(d); // refused (e.g. a rewrite): reported, retried later
    }
  }
  return pending;
}

// Sends one new commit to every paired peer now; resolves to [{ peer, sent, error }] once each first
// attempt is over. Those not reached keep retrying in the background.
export async function sendNow(r, d, commit) {
  const room = await roomInfo(r.s);
  return Promise.all(r.peers.filter((p) => room.paired[p.name]).map(async ({ name }) => {
    await kick(r, name);
    if (r.state.peers[name].running) await r.state.peers[name].running; // a send that started before this commit
    const sent = (await acked(r.s, name, d)) === commit;
    if (!sent) r.state.peers[name].waiting.add(d);
    const st = r.state.peers[name];
    return { peer: name, sent, reachable: st.reachable !== false, error: sent ? null : st.error ?? 'not sent yet' };
  }));
}

// The replica of a room: r.s (storage), r.peers ([{ name, url }]), r.state (kept in ctx across reloads).
export async function createReplica({ root, node, peers, state, activity, project, log, limits = LIMITS }) {
  if (!NODE.test(node ?? '')) throw new Error(`--node must be letters, digits, - or _ (at most 32), not "${node}"`);
  const seen = new Set([node.toLowerCase()]);
  for (const p of peers) {
    if (!NODE.test(p.name)) throw new Error(`--peer name "${p.name}": letters, digits, - or _ only`);
    if (seen.has(p.name.toLowerCase())) throw new Error(`--peer ${p.name}: names must differ (ignoring case) from each other and from --node`);
    seen.add(p.name.toLowerCase());
    if (!/^http:\/\/[^/@?#\s]+$/.test(p.url)) throw new Error(`--peer ${p.name}=${p.url}: expected http://<address>:<port>`);
  }
  state.peers ??= {};
  const s = state.s ??= await openStore(root, node);
  const r = { s, node, peers, state, activity, project, log, limits, git: state.git ??= await gitVersion() };
  state.tick = (name) => kick(r, name); // timers call through state, so a Reload runs the new code
  return r;
}
export function startPeers(r) { for (const p of r.peers) if (!r.state.peers[p.name]?.timer) kick(r, p.name); }
export function stopPeers(r) { r.state.stopped = true; for (const p of Object.values(r.state.peers)) clearTimeout(p.timer); }
