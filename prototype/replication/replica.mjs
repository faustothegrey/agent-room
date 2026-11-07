// Stage B0 replication prototype: one discussion line sent from one node to another as Git
// bundles over HTTP. Stand-alone: the room never loads this file. See README.md beside it.
//
// A node is a folder: store.git (its own bare Git storage, separate from any project repository),
// tmp/ (incoming bundles, staging indexes), state.json (what each peer acknowledged) and
// received/<discussion>/<node>/ (read-only snapshots and the published.json pointer).
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export const PROTOCOL = 1;
export const META = '.agent-room-round.json'; // the round metadata, at the root of every commit's tree
export const OUTCOMES = ['completed', 'interrupted', 'failed'];
export const LIMITS = { bundleBytes: 64 << 20, files: 5000, fileBytes: 16 << 20, metaBytes: 4096, offerBytes: 2048 };
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);
const rand = () => randomBytes(6).toString('hex');

export class Refused extends Error {
  constructor(status, code, detail) { super(`${code}: ${detail}`); Object.assign(this, { status, code, detail }); }
}

// ── Git, always with an argument array, never a shell ───────────────────
// No system/global config (no user filters or hooks), no hooks at all, no automatic gc.
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
const BASE = ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
export const gitUsed = new Set(); // "git <subcommand> <flags>", operands left out, for the report
const describe = (args) => {
  const out = ['git'];
  let sub = null;
  args.forEach((a, i) => {
    if (a === '-c' || args[i - 1] === '-c' || a.startsWith('-')) out.push(a);
    else if (!sub) out.push(sub = a);
    else if (sub === 'bundle' && (a === 'create' || a === 'verify')) out.push(a);
  });
  return out.join(' ');
};

export let gitCalls = 0; // processes started, for the measurements
export function git(store, args, { input, binary, cwd, env } = {}) {
  gitUsed.add(describe(args)); gitCalls++;
  return new Promise((ok, fail) => {
    const child = execFile('git', ['--git-dir', store, ...BASE, ...args],
      { cwd, env: { ...ENV, ...env }, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 28 },
      (err, out, errOut) => (err ? fail(Object.assign(new Error(`${describe(args)}: ${String(errOut || err.message).trim()}`), { stderr: String(errOut) }))
        : ok(binary ? out : out.replace(/\n$/, ''))));
    if (input !== undefined) child.stdin.end(input);
  });
}
const has = (store, sha) => git(store, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
const isAncestor = (store, a, b) => git(store, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
export const revParse = (store, ref) => git(store, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => null);

export function checkId(...ids) { for (const id of ids) if (typeof id !== 'string' || !ID.test(id)) throw new Refused(400, 'invalid-identity', `bad id ${JSON.stringify(id)}`); }
export const lineRef = (d, n) => (checkId(d, n), `refs/lines/${d}/${n}`);          // a node's own line, and what a bundle carries
const receivedRef = (d, n) => (checkId(d, n), `refs/received/${d}/${n}`);         // follows published.json
const incomingRef = (d, n) => (checkId(d, n), `refs/incoming/${d}/${n}`);         // controlled temporary ref

// ── Small file helpers ──────────────────────────────────────────────────
async function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${rand()}`;
  const fh = await fs.open(tmp, 'wx');
  try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
  await fs.rename(tmp, path);
}
const readJson = (path) => fs.readFile(path, 'utf8').then(JSON.parse, (e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
async function chmodDirs(dir, mode) { // directories only; files keep 0444
  await fs.chmod(dir, mode);
  for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await chmodDirs(join(dir, e.name), mode);
}
export async function removeTree(dir) { // read-only snapshot folders need their directories made writable first
  try { await chmodDirs(dir, 0o755); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  await fs.rm(dir, { recursive: true, force: true });
}

// ── A node ──────────────────────────────────────────────────────────────
// Opening a node is its (re)start: it runs recovery before anything else.
export async function openNode(dir, { room, node, peers = [] }) {
  checkId(room, node, ...peers);
  const n = { dir, room, node, peers, store: join(dir, 'store.git'), tmp: join(dir, 'tmp') };
  await fs.mkdir(n.tmp, { recursive: true });
  await fs.access(join(n.store, 'HEAD')).catch(() => execGitInit(n.store));
  n.recovered = await recover(n);
  return n;
}
const execGitInit = (store) => new Promise((ok, fail) => execFile('git', ['init', '-q', '--bare', store], { env: ENV }, (e) => (e ? fail(e) : ok())));

const lineDir = (n, d, from) => join(n.dir, 'received', d, from);
export const readPointer = (n, d, from) => readJson(join(lineDir(n, d, from), 'published.json'));
export async function snapshotDir(n, d, from) { // what a reader shows: always a complete snapshot, or null
  const p = await readPointer(n, d, from);
  return p && join(lineDir(n, d, from), 'snapshots', p.commit);
}

// Restart recovery. Staging data never becomes visible: incoming bundles, staging folders,
// snapshots no pointer ever named, and the incoming ref are removed; the received ref follows the
// pointer, which is the single source of truth for "what this node shows".
export async function recover(n) {
  const report = { tmp: 0, staging: 0, unpublished: 0, incomingRefs: 0, refRepaired: 0 };
  for (const f of await fs.readdir(n.tmp)) { await fs.rm(join(n.tmp, f), { recursive: true, force: true }); report.tmp++; }
  const refs = await git(n.store, ['for-each-ref', '--format=%(refname)', 'refs/incoming/']);
  for (const ref of refs.split('\n').filter(Boolean)) { await git(n.store, ['update-ref', '-d', ref]); report.incomingRefs++; }
  const root = join(n.dir, 'received');
  for (const d of await fs.readdir(root).catch(() => [])) {
    for (const from of await fs.readdir(join(root, d))) {
      const line = join(root, d, from), pointer = await readPointer(n, d, from);
      for (const f of await fs.readdir(line)) if (f.startsWith('published.json.tmp-')) await fs.rm(join(line, f));
      const keep = new Set(pointer?.history ?? []);
      for (const s of await fs.readdir(join(line, 'snapshots')).catch(() => [])) {
        if (keep.has(s)) continue;
        await removeTree(join(line, 'snapshots', s));
        if (s.startsWith('.staging-')) report.staging++; else report.unpublished++;
      }
      if (pointer && (await revParse(n.store, receivedRef(d, from))) !== pointer.commit) {
        await git(n.store, ['update-ref', receivedRef(d, from), pointer.commit]); report.refRepaired++;
      }
    }
  }
  return report;
}

// ── Sending side ────────────────────────────────────────────────────────
// One round = one commit on refs/lines/<discussion>/<this node>, built with plumbing from the folder's
// bytes: no index of the project, no ignore rules, no attributes or filters, no symlinks.
export async function capture(n, d, folder, { round, outcome = 'completed', parent } = {}) {
  const files = [];
  const walk = async (rel) => {
    for (const e of await fs.readdir(join(folder, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (/[\n\\]/.test(p) || p === META) throw new Error(`capture: unsupported name ${JSON.stringify(p)}`);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.push(p);
      else throw new Error(`capture: ${p} is not a regular file or folder`);
    }
  };
  await walk('');
  files.sort();
  const ref = lineRef(d, n.node);
  const old = parent === undefined ? await revParse(n.store, ref) : parent;
  const meta = { schema: 1, room: n.room, discussion: d, node: n.node, round, outcome };
  const shas = files.length ? (await git(n.store, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { cwd: folder, input: files.join('\n') + '\n' })).split('\n') : [];
  const metaSha = await git(n.store, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(meta, null, 2) + '\n' });
  const index = join(n.tmp, `index-${rand()}`);
  const entries = [[META, metaSha], ...files.map((f, i) => [f, shas[i]])];
  try {
    await git(n.store, ['update-index', '--add', '-z', '--index-info'], { env: { GIT_INDEX_FILE: index }, input: entries.map(([p, s]) => `100644 ${s}\t${p}\0`).join('') });
    const tree = await git(n.store, ['write-tree'], { env: { GIT_INDEX_FILE: index } });
    const when = `${1_800_000_000 + round * 60} +0000`; // fixed dates: the same fixtures give the same commit IDs
    const who = { GIT_AUTHOR_NAME: n.node, GIT_AUTHOR_EMAIL: `${n.node}@agent-room.invalid`, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: n.node, GIT_COMMITTER_EMAIL: `${n.node}@agent-room.invalid`, GIT_COMMITTER_DATE: when };
    const commit = await git(n.store, ['commit-tree', tree, ...(old ? ['-p', old] : []), '-m', `round ${round} (${outcome})`], { env: who });
    // Normal capture is append-only (the old value is checked); `parent` exists only to stage a rewrite.
    const current = await revParse(n.store, ref);
    await git(n.store, ['update-ref', ref, commit, parent === undefined ? (old ?? ZERO) : (current ?? ZERO)]);
    return commit;
  } finally { await fs.rm(index, { force: true }); }
}

export async function makeBundle(n, d, base, file = join(n.tmp, `out-${rand()}.bundle`)) {
  const ref = lineRef(d, n.node);
  await git(n.store, ['bundle', 'create', '-q', file, ref, ...(base ? [`^${base}`] : [])]);
  return { file, bytes: (await fs.stat(file)).size };
}

const statePath = (n) => join(n.dir, 'state.json');
export const acked = async (n, peer, d) => (await readJson(statePath(n)))?.acked?.[`${peer}/${d}`] ?? null;
async function recordAck(n, peer, d, commit) {
  const s = (await readJson(statePath(n))) ?? { acked: {} };
  s.acked[`${peer}/${d}`] = commit;
  await writeAtomic(statePath(n), JSON.stringify(s, null, 2) + '\n');
}

function request(url, { method = 'POST', headers = {}, body, file, timeoutMs = 30_000 }) {
  return new Promise((ok, fail) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { ok({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { fail(e); } });
      res.on('error', fail);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    if (file) createReadStream(file).on('error', (e) => req.destroy(e)).pipe(req); else req.end(body);
  });
}
export const offerHeader = (o) => ({ 'x-replica-offer': JSON.stringify(o) });
export async function postBundle(url, offer, file) {
  const { size } = await fs.stat(file);
  return request(`${url}/bundle`, { headers: { ...offerHeader(offer), 'content-type': 'application/octet-stream', 'content-length': size }, file });
}

// One send to one peer: offer, then a bundle based on the last acknowledged commit; a missing base
// falls back to a full bundle once. Returns what happened, for the report.
export async function send(n, peer, url, d) {
  const t0 = performance.now();
  const commit = await revParse(n.store, lineRef(d, n.node));
  let base = await acked(n, peer, d);
  const offer = { protocol: PROTOCOL, room: n.room, discussion: d, node: n.node, commit, base };
  const o = await request(`${url}/offer`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(offer) });
  if (o.status !== 200) throw new Refused(o.status, o.body.error, o.body.detail);
  const done = async (r) => {
    if (r.body.acked !== commit) throw new Error(`peer acknowledged ${r.body.acked}, offered ${commit}`);
    await recordAck(n, peer, d, commit);
    return r.body;
  };
  if (o.body.status === 'have') return { kind: 'already-had', acked: (await done({ body: { acked: o.body.commit } })).acked, bytes: 0, ms: performance.now() - t0 };
  if (base && !(await isAncestor(n.store, base, commit))) base = null; // our own line was rewritten: send it all
  const attempts = [];
  for (;;) {
    const b = await makeBundle(n, d, base);
    try {
      const r = await postBundle(url, { ...offer, base }, b.file);
      attempts.push({ kind: base ? 'incremental' : 'full', bytes: b.bytes, status: r.status, error: r.body.error });
      if (r.status === 409 && r.body.error === 'missing-base' && base) { base = null; continue; }
      if (r.status !== 200) throw new Refused(r.status, r.body.error, r.body.detail);
      const body = await done(r);
      return { kind: attempts.map((a) => a.kind).join('→'), attempts, acked: body.acked, duplicate: !!body.duplicate, bytes: b.bytes, ms: performance.now() - t0 };
    } finally { await fs.rm(b.file, { force: true }); }
  }
}

// ── Receiving side ──────────────────────────────────────────────────────
function checkOffer(n, o) {
  if (!o || typeof o !== 'object') throw new Refused(400, 'invalid-schema', 'offer is not an object');
  if (o.protocol !== PROTOCOL) throw new Refused(400, 'invalid-schema', `protocol ${o.protocol}`);
  checkId(o.room, o.discussion, o.node);
  if (o.room !== n.room) throw new Refused(403, 'wrong-identity', `room ${o.room}, this node is in ${n.room}`);
  if (o.node === n.node) throw new Refused(403, 'wrong-identity', `a peer cannot write this node's own line (${o.node})`);
  if (!n.peers.includes(o.node)) throw new Refused(403, 'wrong-identity', `node ${o.node} is not a paired peer`);
  if (!SHA.test(o.commit ?? '') || !(o.base === null || SHA.test(o.base ?? ''))) throw new Refused(400, 'invalid-schema', 'commit/base are not full commit IDs');
}

async function bundleHeader(file) { // v2 header: "-<sha> …" prerequisites, "<sha> <ref>" heads, then a blank line
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(65536); const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('latin1'); const end = text.indexOf('\n\n');
    const lines = text.slice(0, end).split('\n');
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

// The tree of a received commit: regular files only, safe relative paths, no names that collide on
// a case- or normalization-insensitive disk (macOS), within limits. Throws Refused('unsafe-tree').
export function validateTree(entries) {
  const bad = (why) => { throw new Refused(422, 'unsafe-tree', why); };
  if (entries.length > LIMITS.files) bad(`${entries.length} files (limit ${LIMITS.files})`);
  const seen = new Map();
  for (const e of entries) {
    if (e.mode === '120000') bad(`symlink ${e.path}`);
    if (e.mode === '160000') bad(`submodule ${e.path}`);
    if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) bad(`unsupported entry ${e.mode} ${e.type} ${e.path}`);
    if (e.path.startsWith('/')) bad(`absolute path ${e.path}`);
    const parts = e.path.split('/');
    for (const p of parts) if (!p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[\\\0]/.test(p)) bad(`unsafe path ${JSON.stringify(e.path)}`);
    if (e.size > LIMITS.fileBytes) bad(`${e.path} is ${e.size} bytes`);
    parts.forEach((_, i) => { // "a" as a file and "A/x" (or "a/x") as a folder collide too
      const key = parts.slice(0, i + 1).join('/').normalize('NFC').toLowerCase(), kind = i === parts.length - 1 ? `file:${e.path}` : 'dir';
      if (seen.has(key) && (kind !== 'dir' || seen.get(key) !== 'dir')) bad(`names collide on this disk: ${e.path}`);
      seen.set(key, kind);
    });
  }
  return entries;
}
export async function listTree(store, commit) {
  const out = await git(store, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
  return out.split('\0').filter(Boolean).map((l) => {
    const [head, path] = [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)];
    const [mode, type, sha, size] = head.split(/ +/);
    return { mode, type, sha, size: size === '-' ? 0 : Number(size), path };
  });
}
export function validateMeta(n, m, o, published) {
  const bad = (code, why) => { throw new Refused(422, code, why); };
  if (!m || typeof m !== 'object') bad('invalid-schema', 'round metadata is not an object');
  const keys = Object.keys(m).sort().join(',');
  if (keys !== 'discussion,node,outcome,room,round,schema') bad('invalid-schema', `round metadata keys ${keys}`);
  if (m.schema !== 1) bad('invalid-schema', `schema ${m.schema}`);
  if (!Number.isInteger(m.round) || m.round < 1) bad('invalid-schema', `round ${JSON.stringify(m.round)}`);
  if (!OUTCOMES.includes(m.outcome)) bad('invalid-schema', `outcome ${JSON.stringify(m.outcome)}`);
  if (m.room !== n.room || m.discussion !== o.discussion || m.node !== o.node) bad('wrong-identity', `commit says ${m.room}/${m.discussion}/${m.node}, offer is ${n.room}/${o.discussion}/${o.node}`);
  if (published && m.round <= published.round) bad('invalid-schema', `round ${m.round} after published round ${published.round}`);
}

// Receive one saved bundle file. `at(point)` is for restart tests only.
export async function receive(n, file, o, at = async () => {}) {
  checkOffer(n, o);
  await at('after-save');
  const line = lineDir(n, o.discussion, o.node), published = await readPointer(n, o.discussion, o.node);
  if (published?.commit === o.commit) return { acked: o.commit, duplicate: true }; // duplicate or lost reply: same answer
  const { prereqs, heads } = await bundleHeader(file);
  const want = lineRef(o.discussion, o.node);
  if (heads.length !== 1 || heads[0].ref !== want) throw new Refused(422, 'wrong-identity', `bundle carries ${heads.map((h) => h.ref).join(', ')}, expected ${want}`);
  if (heads[0].sha !== o.commit) throw new Refused(422, 'wrong-identity', 'bundle tip differs from the offered commit');
  for (const p of prereqs) if (!(await has(n.store, p.sha))) throw new Refused(409, 'missing-base', `this node lacks ${p.sha}`);
  try { await git(n.store, ['bundle', 'verify', '-q', file]); } catch (e) { throw new Refused(400, 'corrupt', e.message); }
  const tmpRef = incomingRef(o.discussion, o.node);
  try {
    try { await git(n.store, ['-c', 'fetch.fsckObjects=true', 'fetch', '-q', '--no-tags', '--no-write-fetch-head', file, `+${want}:${tmpRef}`]); }
    catch (e) { throw new Refused(400, 'corrupt', e.message); }
    await at('after-import');
    if ((await revParse(n.store, tmpRef)) !== o.commit) throw new Refused(422, 'wrong-identity', 'imported tip differs from the offer');
    const entries = validateTree(await listTree(n.store, o.commit));
    if (published && !(await isAncestor(n.store, published.commit, o.commit))) throw new Refused(409, 'rewrite', `${o.commit} does not descend from the published ${published.commit}; nothing changed`);
    const metaEntry = entries.find((e) => e.path === META);
    if (!metaEntry || metaEntry.size > LIMITS.metaBytes) throw new Refused(422, 'invalid-schema', `no ${META} (or too big)`);
    let meta; try { meta = JSON.parse(await git(n.store, ['cat-file', 'blob', metaEntry.sha])); } catch { throw new Refused(422, 'invalid-schema', `${META} is not JSON`); }
    validateMeta(n, meta, o, published);

    // Materialize into a staging folder, then rename it into place: a reader never sees it half-written.
    const snaps = join(line, 'snapshots'), staging = join(snaps, `.staging-${rand()}`), final = join(snaps, o.commit);
    await fs.mkdir(staging, { recursive: true });
    for (const [i, e] of entries.entries()) {
      const dest = join(staging, ...e.path.split('/'));
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.writeFile(dest, await git(n.store, ['cat-file', 'blob', e.sha], { binary: true }), { flag: 'wx', mode: 0o444 });
      if (i === Math.floor(entries.length / 2)) await at('mid-materialize');
    }
    await fs.rename(staging, final);
    await chmodDirs(final, 0o555);
    await at('after-materialize');

    // Publish: the pointer switch is the one atomic step; the received ref then follows it.
    const tree = await git(n.store, ['rev-parse', `${o.commit}^{tree}`]);
    const pointer = { protocol: PROTOCOL, room: n.room, discussion: o.discussion, node: o.node, commit: o.commit, tree, round: meta.round, outcome: meta.outcome, history: [...(published?.history ?? []), o.commit] };
    await writeAtomic(join(line, 'published.json'), JSON.stringify(pointer, null, 2) + '\n');
    await git(n.store, ['update-ref', receivedRef(o.discussion, o.node), o.commit]);
    await at('after-publish');
    return { acked: o.commit };
  } finally { await git(n.store, ['update-ref', '-d', tmpRef]).catch(() => {}); }
}

// The minimal HTTP endpoint: POST /offer (JSON) and POST /bundle (raw bundle, offer in a header).
// Receives are serialized; `dropReplyOnce` loses one reply after publishing (lost-acknowledgement test).
export function serve(n, { port = 0, limits = LIMITS } = {}) {
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
  const pending = new Set();
  const reply = (res, status, body) => { if (!res.writableEnded && !res.destroyed) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
  const fail = (res, e) => reply(res, e.status ?? 500, { ok: false, error: e.code ?? 'internal', detail: e.detail ?? e.message });
  const server = http.createServer((req, res) => {
    const job = (async () => {
      try {
        if (req.method === 'POST' && req.url === '/offer') {
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > limits.offerBytes) throw new Refused(413, 'too-large', 'offer'); chunks.push(c); }
          let o; try { o = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refused(400, 'invalid-schema', 'offer is not JSON'); }
          checkOffer(n, o);
          const p = await readPointer(n, o.discussion, o.node);
          return reply(res, 200, p?.commit === o.commit ? { status: 'have', commit: p.commit } : { status: 'send', published: p?.commit ?? null });
        }
        if (req.method === 'POST' && req.url === '/bundle') {
          const raw = req.headers['x-replica-offer'] ?? '';
          if (raw.length > limits.offerBytes) throw new Refused(413, 'too-large', 'offer header');
          let o; try { o = JSON.parse(raw); } catch { throw new Refused(400, 'invalid-schema', 'offer header is not JSON'); }
          checkOffer(n, o);
          const len = Number(req.headers['content-length']);
          if (!Number.isSafeInteger(len) || len <= 0) throw new Refused(411, 'length-required', 'content-length');
          if (len > limits.bundleBytes) { res.setHeader('connection', 'close'); throw new Refused(413, 'too-large', `${len} bytes (limit ${limits.bundleBytes})`); }
          const file = join(n.tmp, `in-${rand()}.bundle`);
          try {
            await pipeline(req, createWriteStream(file, { flags: 'wx' }));
            const got = (await fs.stat(file)).size;
            if (got !== len) throw new Refused(400, 'incomplete', `${got} of ${len} bytes`);
            const r = await serial(() => receive(n, file, o));
            if (server.dropReplyOnce) { server.dropReplyOnce = false; return req.socket.destroy(); }
            return reply(res, 200, { ok: true, ...r });
          } finally { await fs.rm(file, { force: true }); }
        }
        reply(res, 404, { ok: false, error: 'not-found' });
      } catch (e) { fail(res, e); }
    })();
    pending.add(job); job.finally(() => pending.delete(job));
  });
  server.settled = () => Promise.all([...pending]);
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(Object.assign(server, { url: `http://127.0.0.1:${server.address().port}` }))));
}
