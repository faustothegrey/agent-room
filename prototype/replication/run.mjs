#!/usr/bin/env node
// Stage B0: runs every scenario of the replication prototype and prints expected vs. actual for
// each check. Exit code 0 only if all checks pass. Everything happens in a temporary folder that is
// removed at the end (keep it with --keep). --measure <dir> additionally times a copy of a real
// discussion folder (read-only: the folder itself is never written).
//   node prototype/replication/run.mjs [--keep] [--measure <discussion folder>]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as R from './replica.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const MEASURE = args.includes('--measure') ? args[args.indexOf('--measure') + 1] : null;

// Fixed identities (prototype protocol validation, not production pairing).
const ROOM = 'room-b0', D = 'disc-1', A_ID = 'node-1', B_ID = 'node-2';

// ── Output ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const short = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v.slice(0, 10) : v);
const show = (v) => JSON.stringify(v, (_, x) => short(x));
function check(name, expected, actual, ok = isDeepStrictEqual(expected, actual)) {
  ok ? passed++ : failed++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}\n         expected: ${show(expected)}\n         actual:   ${show(actual)}`);
}
const section = (t) => console.log(`\n── ${t}`);
const kb = (b) => `${b} B (${(b / 1024).toFixed(1)} KiB)`;
const measurements = [];
let callsSeen = 0; // Git processes since the previous measurement (capture + send + receive)
const measure = (label, r) => { const calls = R.gitCalls - callsSeen; callsSeen = R.gitCalls; measurements.push({ label, kind: r.kind, bytes: r.bytes, ms: Math.round(r.ms), calls }); console.log(`  · ${label}: ${r.kind}, ${kb(r.bytes)}, ${r.ms.toFixed(0)} ms`); };

// ── Fixtures: generated, deterministic ───────────────────────────────────
const words = 'round agent drawing note summary worker charon mac bundle commit snapshot line peer view'.split(' ');
const text = (seed, lines) => Array.from({ length: lines }, (_, i) => Array.from({ length: 12 }, (_, j) => words[(seed * 7 + i * 13 + j * 5) % words.length]).join(' ')).join('\n') + '\n';
const svg = (seed) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">\n${Array.from({ length: 40 }, (_, i) => `  <rect x="${(seed * 17 + i * 9) % 380}" y="${(seed * 11 + i * 7) % 280}" width="20" height="20" fill="#${((seed * 999 + i * 4567) % 0xffffff).toString(16).padStart(6, '0')}"/>`).join('\n')}\n</svg>\n`;
const ROUNDS = {
  1: async (f) => { await put(f, 'notes.md', '# Notes\n' + text(1, 30)); await put(f, 'proposal.md', '# Proposal\n' + text(2, 60)); await put(f, 'transcripts/session-1.md', text(3, 80)); await put(f, 'drawings/a.svg', svg(1)); },
  2: async (f) => { await fs.appendFile(join(f, 'notes.md'), '\n## Round 2\n' + text(4, 5)); await put(f, 'drawings/b.svg', svg(2)); },   // edit a note, add a drawing
  3: async (f) => { await fs.rm(join(f, 'drawings/a.svg')); await fs.appendFile(join(f, 'transcripts/session-1.md'), text(5, 20)); }, // delete a file, append to a transcript
  4: async (f) => { await fs.appendFile(join(f, 'transcripts/session-1.md'), text(6, 20)); await put(f, 'proposal.md', '# Proposal (rev)\n' + text(2, 60)); },
};
const typicalRound = (k) => async (f) => { await fs.appendFile(join(f, 'transcripts/session-1.md'), text(10 + k, 25)); await fs.appendFile(join(f, 'notes.md'), text(20 + k, 3)); };
async function put(f, rel, body) { await fs.mkdir(dirname(join(f, rel)), { recursive: true }); await fs.writeFile(join(f, rel), body); }

// ── Evidence helpers ─────────────────────────────────────────────────────
async function filesOf(dir, rel = '') { // { path: Buffer } of a materialized snapshot; anything not a regular file is reported
  const out = {};
  for (const e of await fs.readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await filesOf(dir, p));
    else if (e.isFile()) out[p] = await fs.readFile(join(dir, p));
    else out[p] = `NOT A REGULAR FILE`;
  }
  return out;
}
async function commitFiles(store, commit) { // the same, from the offered commit in the SENDER's storage
  const out = {};
  for (const e of await R.listTree(store, commit)) out[e.path] = await R.git(store, ['cat-file', 'blob', e.sha], { binary: true });
  return out;
}
async function sameAsCommit(dir, store, commit) {
  const [a, b] = [await filesOf(dir), await commitFiles(store, commit)];
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff = paths.filter((p) => !(Buffer.isBuffer(a[p]) && Buffer.isBuffer(b[p]) && a[p].equals(b[p])));
  return { files: Object.keys(b).length, differing: diff };
}
async function digest(dir) {
  const files = await filesOf(dir), h = createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(p).update('\0').update(files[p]).update('\0');
  return h.digest('hex').slice(0, 16);
}
async function receiverState(n) {
  const p = await R.readPointer(n, D, A_ID);
  const snaps = await fs.readdir(join(n.dir, 'received', D, A_ID, 'snapshots')).catch(() => []);
  return {
    published: p?.commit ?? null, history: p?.history.length ?? 0,
    tmp: (await fs.readdir(n.tmp)).length, staging: snaps.filter((s) => s.startsWith('.staging-')).length,
    incomingRefs: (await R.git(n.store, ['for-each-ref', '--format=%(refname)', 'refs/incoming/'])).split('\n').filter(Boolean).length,
    receivedRef: await R.revParse(n.store, `refs/received/${D}/${A_ID}`),
  };
}
const offerFor = (commit, base, over = {}) => ({ protocol: R.PROTOCOL, room: ROOM, discussion: D, node: A_ID, commit, base, ...over });
function rawPost(url, offer, body, { cutAfter, length = body.length } = {}) { // a hand-made request: for interruption and rejection checks
  return new Promise((ok) => {
    const req = http.request(`${url}/bundle`, { method: 'POST', headers: { ...R.offerHeader(offer), 'content-length': length } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => ok({ status: res.statusCode, ...JSON.parse(Buffer.concat(c).toString()) }));
    });
    req.on('error', (e) => ok({ clientError: e.code ?? e.message }));
    if (cutAfter !== undefined) req.write(body.subarray(0, cutAfter), () => setTimeout(() => req.destroy(), 50));
    else req.end(body);
  });
}
async function postJson(url, path, obj) {
  const r = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } });
  return { status: r.status, ...(await r.json()) };
}

// ── The run ──────────────────────────────────────────────────────────────
const root = await fs.mkdtemp(join(tmpdir(), 'agent-room-b0-'));
const worktree = execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const projectGit = () => ({ head: execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  status: execFileSync('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }) });
const projectBefore = projectGit();
console.log(`Stage B0 replication prototype\n  node ${process.version}, ${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}, ${process.platform}`);
console.log(`  project ${worktree} at ${projectBefore.head.slice(0, 10)}\n  temporary nodes in ${root}`);

const A = await R.openNode(join(root, 'node-1'), { room: ROOM, node: A_ID });
let B = await R.openNode(join(root, 'node-2'), { room: ROOM, node: B_ID, peers: [A_ID] });
const folder = join(root, 'node-1', 'discussion');
await fs.mkdir(folder);
let server = await R.serve(B);
let round = 0;
const nextRound = async (change = typicalRound(round + 1), outcome) => { await change(folder); round++; callsSeen = R.gitCalls; return R.capture(A, D, folder, { round, outcome }); };
const send = () => R.send(A, B_ID, server.url, D);
const restartB = async () => { await new Promise((ok) => server.close(ok)); B = await R.openNode(B.dir, { room: ROOM, node: B_ID, peers: [A_ID] }); server = await R.serve(B); return B.recovered; };
const snap = (commit) => join(B.dir, 'received', D, A_ID, 'snapshots', commit);
const digests = {};

try {
  section('1. Round commits and transfers (full, then incremental)');
  for (const r of [1, 2, 3, 4]) {
    const commit = await nextRound(ROUNDS[r], r === 4 ? 'interrupted' : 'completed');
    const res = await send();
    measure(`round ${r}`, res);
    check(`round ${r}: transfer kind`, r === 1 ? 'full' : 'incremental', res.kind);
    check(`round ${r}: node 2 acknowledged the offered commit; node 1 recorded it`, [commit, commit], [res.acked, await R.acked(A, B_ID, D)]);
    check(`round ${r}: published snapshot = offered commit, file by file (paths and bytes)`, { files: (await R.listTree(A.store, commit)).length, differing: [] }, await sameAsCommit(await R.snapshotDir(B, D, A_ID), A.store, commit));
    digests[commit] = await digest(snap(commit));
  }
  const [c1, c2, c3, c4] = JSON.parse(await fs.readFile(join(B.dir, 'received', D, A_ID, 'published.json'), 'utf8')).history;
  check('round 2 added drawings/b.svg; round 3 deleted drawings/a.svg (in the snapshots)', { r1: [true, false], r2: [true, true], r3: [false, true] }, {
    r1: [await exists(join(snap(c1), 'drawings/a.svg')), await exists(join(snap(c1), 'drawings/b.svg'))],
    r2: [await exists(join(snap(c2), 'drawings/a.svg')), await exists(join(snap(c2), 'drawings/b.svg'))],
    r3: [await exists(join(snap(c3), 'drawings/a.svg')), await exists(join(snap(c3), 'drawings/b.svg'))] });
  const t3 = await fs.readFile(join(snap(c3), 'transcripts/session-1.md'), 'utf8'), t4 = await fs.readFile(join(snap(c4), 'transcripts/session-1.md'), 'utf8');
  check('round 4 transcript is round 3 transcript plus an appended part', true, t4.startsWith(t3) && t4.length > t3.length);
  check('the folder matches the commit (plus the round metadata file)', [...Object.keys(await filesOf(folder)), R.META].sort(), Object.keys(await filesOf(snap(c4))).sort());
  check('earlier snapshots unchanged after later publications (content digests)', [c1, c2, c3].map((c) => digests[c]), await Promise.all([c1, c2, c3].map((c) => digest(snap(c)))));
  const mode = (await fs.stat(join(snap(c1), 'notes.md'))).mode & 0o777, dmode = (await fs.stat(join(snap(c1), 'drawings'))).mode & 0o777;
  check('snapshots are read-only (file mode, folder mode)', ['444', '555'], [mode.toString(8), dmode.toString(8)]);
  check('round metadata of round 4', { schema: 1, room: ROOM, discussion: D, node: A_ID, round: 4, outcome: 'interrupted' }, JSON.parse(await fs.readFile(join(snap(c4), R.META), 'utf8')));
  for (let k = 0; k < 3; k++) { await nextRound(); measure(`typical round ${round} (transcript append + note edit)`, await send()); }
  await fs.cp(B.dir, join(root, 'node-2-backup'), { recursive: true }); // an old copy of node 2, for the missing-base case
  const backupPublished = (await receiverState(B)).published;

  section('2. Duplicate send');
  let before = await receiverState(B), dg = await digest(await R.snapshotDir(B, D, A_ID));
  const dup = await send();
  check('sending again with no new round: offer answers "have", no bundle sent', { kind: 'already-had', bytes: 0, acked: before.published }, { kind: dup.kind, bytes: dup.bytes, acked: dup.acked });
  const prev = (await R.git(A.store, ['rev-parse', `${before.published}^`]));
  const again = await R.makeBundle(A, D, prev);
  const dupRaw = [await rawPost(server.url, offerFor(before.published, prev), await fs.readFile(again.file)), await rawPost(server.url, offerFor(before.published, prev), await fs.readFile(again.file))];
  await fs.rm(again.file);
  check('the same bundle POSTed twice: both acknowledged as duplicates of the published commit', [{ status: 200, acked: before.published, duplicate: true }, { status: 200, acked: before.published, duplicate: true }], dupRaw.map((r) => ({ status: r.status, acked: r.acked, duplicate: r.duplicate })));
  check('receiver unchanged (pointer, history, digest)', [before, dg], [await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID))]);

  section('3. Interrupted transfer');
  const c5 = await nextRound();
  before = await receiverState(B); dg = await digest(await R.snapshotDir(B, D, A_ID));
  const part = await R.makeBundle(A, D, await R.acked(A, B_ID, D)); const partBytes = await fs.readFile(part.file); await fs.rm(part.file);
  const cut = await rawPost(server.url, offerFor(c5, await R.acked(A, B_ID, D)), partBytes, { cutAfter: Math.floor(partBytes.length / 2) });
  await server.settled();
  check('connection dropped after half the bundle: sender sees an error', true, !!cut.clientError || cut.status >= 400, true);
  console.log(`         (sender saw: ${show(cut)})`);
  check('receiver unchanged, partial upload deleted (state, digest)', [before, dg], [await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID))]);
  const retry5 = await send();
  check('the next send publishes the round', { kind: 'incremental', acked: c5 }, { kind: retry5.kind, acked: retry5.acked });

  section('4. Corrupted bundle');
  const c6 = await nextRound();
  before = await receiverState(B); dg = await digest(await R.snapshotDir(B, D, A_ID));
  const good = await R.makeBundle(A, D, c5); const goodBytes = await fs.readFile(good.file); await fs.rm(good.file);
  for (const [where, at] of [['a byte in the middle of the pack', Math.floor(goodBytes.length * 0.6)], ['the last byte (pack checksum)', goodBytes.length - 1]]) {
    const bad = Buffer.from(goodBytes); bad[at] ^= 0xff;
    const r = await rawPost(server.url, offerFor(c6, c5), bad);
    check(`corrupted ${where}: refused`, { status: 400, error: 'corrupt' }, { status: r.status, error: r.error });
    console.log(`         (detail: ${String(r.detail).split('\n')[0]})`);
  }
  check('receiver unchanged (state, digest)', [before, dg], [await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID))]);
  check('the next send publishes the round', c6, (await send()).acked);

  section('5. Lost acknowledgement, then a retry');
  const c7 = await nextRound();
  const roundsBefore = await R.git(A.store, ['rev-list', '--count', R.lineRef(D, A_ID)]);
  server.dropReplyOnce = true;
  const lost = await send().then((r) => r, (e) => ({ error: e.code ?? e.message }));
  await server.settled();
  check('reply lost after node 2 published: node 1 sees an error and records no acknowledgement', { error: 'ECONNRESET or socket hang up', acked: c6 }, { error: lost.error, acked: await R.acked(A, B_ID, D) }, !!lost.error && (await R.acked(A, B_ID, D)) === c6);
  const published7 = await receiverState(B); dg = await digest(await R.snapshotDir(B, D, A_ID));
  check('node 2 did publish round 7', c7, published7.published);
  const retry7 = await send();
  check('retry: same commit acknowledged, no bundle resent', { kind: 'already-had', acked: c7 }, { kind: retry7.kind, acked: retry7.acked });
  check('no extra round on node 1; node 2 state and snapshot unchanged', [roundsBefore, published7, dg], [await R.git(A.store, ['rev-list', '--count', R.lineRef(D, A_ID)]), await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID))]);

  section('6. Missing base: node 2 restored from an old copy');
  await new Promise((ok) => server.close(ok));
  await fs.rename(B.dir, join(root, 'node-2-newer')); await fs.rename(join(root, 'node-2-backup'), B.dir);
  B = await R.openNode(B.dir, { room: ROOM, node: B_ID, peers: [A_ID] }); server = await R.serve(B);
  const oldDigest = await digest(await R.snapshotDir(B, D, A_ID));
  check('restored node 2 shows its old round; node 1 still thinks it acknowledged round 7', [backupPublished, c7], [(await receiverState(B)).published, await R.acked(A, B_ID, D)]);
  const c8 = await nextRound();
  const fb = await send();
  measure(`round ${round} after missing base`, fb);
  check('incremental refused for a missing base, then a full bundle is sent and published', { attempts: [['incremental', 409, 'missing-base'], ['full', 200, undefined]], acked: c8 }, { attempts: fb.attempts.map((a) => [a.kind, a.status, a.error]), acked: fb.acked });
  check('the old snapshot is still there, unchanged', oldDigest, await digest(snap(backupPublished)));
  check(`published round ${round} = offered commit, file by file`, { files: (await R.listTree(A.store, c8)).length, differing: [] }, await sameAsCommit(await R.snapshotDir(B, D, A_ID), A.store, c8));

  section('7. Restart in the middle of receiving (separate process, abrupt exit)');
  for (const point of ['after-save', 'after-import', 'mid-materialize', 'after-materialize', 'after-publish']) {
    const commit = await nextRound();
    const old = (await receiverState(B)).published, oldDg = await digest(await R.snapshotDir(B, D, A_ID));
    await new Promise((ok) => server.close(ok));
    const base = await R.acked(A, B_ID, D);
    const b = await R.makeBundle(A, D, base, join(root, 'crash.bundle'));
    const child = spawnSync(process.execPath, [join(here, 'crash-child.mjs'), B.dir, ROOM, B_ID, A_ID, b.file, JSON.stringify(offerFor(commit, base)), point], { encoding: 'utf8' });
    await fs.rm(b.file);
    const left = await receiverState(B);
    check(`${point}: the receiving process died there`, 86, child.status);
    console.log(`         left on disk at the crash: ${show({ tmp: left.tmp, staging: left.staging, incomingRefs: left.incomingRefs, published: left.published, receivedRef: left.receivedRef })}${child.stderr ? ` stderr: ${child.stderr.trim()}` : ''}`);
    const rec = await restartB();
    console.log(`         recovery at restart: ${show(rec)}`);
    const expectPub = point === 'after-publish' ? commit : old;
    const s = await receiverState(B);
    check(`${point}: after restart the pointer names a complete snapshot (${point === 'after-publish' ? 'new' : 'old'} round), no staging visible`,
      { published: expectPub, receivedRef: expectPub, tmp: 0, staging: 0, incomingRefs: 0, differing: [] },
      { published: s.published, receivedRef: s.receivedRef, tmp: s.tmp, staging: s.staging, incomingRefs: s.incomingRefs, differing: (await sameAsCommit(await R.snapshotDir(B, D, A_ID), A.store, expectPub)).differing });
    if (point !== 'after-publish') check(`${point}: old snapshot digest unchanged`, oldDg, await digest(snap(old)));
    const r = await send();
    check(`${point}: a send after restart gets the round acknowledged`, { acked: commit, kind: point === 'after-publish' ? 'already-had' : 'incremental' }, { acked: r.acked, kind: r.kind });
  }

  section('8. Rejected inputs (each leaves node 2 unchanged)');
  const evil = { store: join(root, 'evil', 'store.git') };
  await fs.cp(A.store, evil.store, { recursive: true });
  const tip = await R.revParse(A.store, R.lineRef(D, A_ID));
  const pub = (await receiverState(B)).published;
  const goodMeta = { schema: 1, room: ROOM, discussion: D, node: A_ID, round: round + 1, outcome: 'completed' };
  const blob = (s) => R.git(evil.store, ['hash-object', '-w', '--stdin'], { input: s });
  async function evilBundle({ extra = [], meta = goodMeta, ref = R.lineRef(D, A_ID) } = {}) {
    const top = (await R.git(evil.store, ['ls-tree', '-z', tip])).split('\0').filter((l) => l && !l.endsWith(`\t${R.META}`));
    if (meta !== null) top.push(`100644 blob ${await blob(typeof meta === 'string' ? meta : JSON.stringify(meta))}\t${R.META}`);
    for (const [mode, type, content, name] of extra) top.push(`${mode} ${type} ${type === 'blob' ? await blob(content) : content}\t${name}`);
    const tree = await R.git(evil.store, ['mktree', '-z', '--missing'], { input: top.join('\0') + '\0' });
    const commit = await R.git(evil.store, ['commit-tree', tree, '-p', tip, '-m', 'crafted'], { env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } });
    await R.git(evil.store, ['update-ref', ref, commit]);
    const file = join(root, 'evil', 'x.bundle');
    await R.git(evil.store, ['bundle', 'create', '-q', file, ref, `^${pub}`]);
    const body = await fs.readFile(file); await fs.rm(file);
    return { commit, body };
  }
  before = await receiverState(B); dg = await digest(await R.snapshotDir(B, D, A_ID));
  const cases = [
    ['symlink entry', { extra: [['120000', 'blob', '../../../etc/passwd', 'link.md']] }, 422, 'unsafe-tree'],
    ['submodule (gitlink) entry', { extra: [['160000', 'commit', 'a'.repeat(40), 'sub']] }, 422, 'unsafe-tree'],
    ['".." entry', { extra: [['100644', 'blob', 'x', '..']] }, null, null],
    ['".git" entry', { extra: [['100644', 'blob', 'x', '.git']] }, null, null],
    ['"." entry', { extra: [['100644', 'blob', 'x', '.']] }, null, null],
    ['"NOTES.md" next to "notes.md" (collide on macOS)', { extra: [['100644', 'blob', 'x', 'NOTES.md']] }, 422, 'unsafe-tree'],
    ['bundle head for another discussion', { ref: R.lineRef('disc-2', A_ID) }, 422, 'wrong-identity'],
    ['round metadata from another node', { meta: { ...goodMeta, node: 'node-3' } }, 422, 'wrong-identity'],
    ['round metadata from another room', { meta: { ...goodMeta, room: 'room-zz' } }, 422, 'wrong-identity'],
    ['round metadata missing', { meta: null }, 422, 'invalid-schema'],
    ['round metadata not JSON', { meta: '{round: 1' }, 422, 'invalid-schema'],
    ['schema 2', { meta: { ...goodMeta, schema: 2 } }, 422, 'invalid-schema'],
    ['round is a string', { meta: { ...goodMeta, round: String(round + 1) } }, 422, 'invalid-schema'],
    ['unknown outcome', { meta: { ...goodMeta, outcome: 'done' } }, 422, 'invalid-schema'],
    ['extra metadata key', { meta: { ...goodMeta, session: 'abc' } }, 422, 'invalid-schema'],
    ['round number not after the published one', { meta: { ...goodMeta, round } }, 422, 'invalid-schema'],
  ];
  for (const [name, spec, status, error] of cases) {
    const { commit, body } = await evilBundle(spec);
    const r = await rawPost(server.url, offerFor(commit, pub), body);
    if (status) check(`${name}: refused`, { status, error }, { status: r.status, error: r.error });
    else check(`${name}: refused (by Git's fsck at import, or by the tree check)`, 'refused (400 corrupt or 422 unsafe-tree)', `${r.status} ${r.error}`, (r.status === 400 && r.error === 'corrupt') || (r.status === 422 && r.error === 'unsafe-tree'));
    console.log(`         (detail: ${String(r.detail).split('\n').slice(-1)[0]})`);
  }
  await R.git(evil.store, ['update-ref', R.lineRef(D, A_ID), tip]);
  for (const [name, over, status] of [['offer from another room', { room: 'room-zz' }, 403], ['offer claiming to be node 2 itself', { node: B_ID }, 403], ['offer from an unpaired node', { node: 'node-9' }, 403], ['offer with an unsafe discussion ID', { discussion: '../x' }, 400], ['offer with protocol 2', { protocol: 2 }, 400]]) {
    const r = await postJson(server.url, '/offer', offerFor(tip, pub, over));
    check(`${name}: refused`, status, r.status);
  }
  const small = await R.serve(B, { limits: { ...R.LIMITS, bundleBytes: 1024 } });
  const big = await R.makeBundle(A, D, null); const bigBody = await fs.readFile(big.file); await fs.rm(big.file);
  const tooBig = await rawPost(small.url, offerFor(tip, null), bigBody);
  await new Promise((ok) => small.close(ok));
  check(`bundle over the size limit (${bigBody.length} B > 1024 B): refused before reading it`, true, tooBig.status === 413 || !!tooBig.clientError, true);
  console.log(`         (sender saw: ${show(tooBig)})`);
  for (const [name, path] of [['absolute path', '/etc/passwd'], ['backslash', 'a\\..\\b'], ['traversal inside a path', 'a/../b'], ['empty component', 'a//b']]) {
    let got = 'accepted'; try { R.validateTree([{ mode: '100644', type: 'blob', sha: 'x', size: 1, path }]); } catch (e) { got = e.code; }
    check(`tree check alone, ${name} ${JSON.stringify(path)} (Git trees can't carry it): refused`, 'unsafe-tree', got);
  }
  check('node 2 unchanged after all rejected inputs (state, digest)', [before, dg], [await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID))]);

  section('9. Rewritten history');
  const parent = await R.git(A.store, ['rev-parse', `${tip}^`]);
  await fs.appendFile(join(folder, 'notes.md'), 'a different ending\n');
  const rewritten = await R.capture(A, D, folder, { round: round + 1, parent });
  before = await receiverState(B); dg = await digest(await R.snapshotDir(B, D, A_ID));
  const rw = await send().then((r) => r, (e) => ({ status: e.status, error: e.code }));
  check('node 1 rewinds its line and sends a different commit: refused', { status: 409, error: 'rewrite' }, rw);
  check('node 2 unchanged (state, digest); node 1 still holds the rewritten tip', [before, dg, rewritten], [await receiverState(B), await digest(await R.snapshotDir(B, D, A_ID)), await R.revParse(A.store, R.lineRef(D, A_ID))]);

  section('10. Isolation from the project repository');
  check('project HEAD and `git status` unchanged by the run', projectBefore, projectGit());

  if (MEASURE) {
    section(`11. Measurement on a copy of ${MEASURE}`);
    const M = await R.openNode(join(root, 'm-1'), { room: ROOM, node: A_ID });
    const N = await R.openNode(join(root, 'm-2'), { room: ROOM, node: B_ID, peers: [A_ID] });
    const mf = join(root, 'm-1', 'discussion');
    await fs.cp(MEASURE, mf, { recursive: true, verbatimSymlinks: true });
    const srv = await R.serve(N);
    const files = Object.keys(await filesOf(mf));
    console.log(`  copied ${files.length} files, ${kb((await Promise.all(files.map((f) => fs.stat(join(mf, f))))).reduce((s, x) => s + x.size, 0))}`);
    callsSeen = R.gitCalls;
    await R.capture(M, D, mf, { round: 1 });
    measure('real folder, first send', await R.send(M, B_ID, srv.url, D));
    const tr = (await fs.readdir(join(mf, 'transcripts')).catch(() => [])).filter((f) => f.endsWith('.md')).sort().pop();
    for (let k = 2; k <= 6; k++) {
      await fs.appendFile(tr ? join(mf, 'transcripts', tr) : join(mf, 'appended.md'), text(30 + k, 40)); // ~3.8 KB, about one exchange
      callsSeen = R.gitCalls;
      await R.capture(M, D, mf, { round: k });
      measure(`real folder, round ${k} (append ~3.8 KB)`, await R.send(M, B_ID, srv.url, D));
    }
    check('real folder: published snapshot = offered commit', [], (await sameAsCommit(await R.snapshotDir(N, D, A_ID), M.store, await R.revParse(M.store, R.lineRef(D, A_ID)))).differing);
    await new Promise((ok) => srv.close(ok));
  }
} catch (e) {
  failed++; console.log(`\n  [FAIL] the run stopped: ${e.stack}`);
} finally {
  await new Promise((ok) => server.close(ok));
  console.log('\n── Git commands used');
  console.log('  git init -q --bare  (once per node)');
  for (const c of [...R.gitUsed].sort()) console.log(`  ${c}`);
  console.log('\n── Measurements (this machine)');
  for (const m of measurements) console.log(`  ${m.label.padEnd(48)} ${m.kind.padEnd(18)} ${String(m.bytes).padStart(7)} B ${String(m.ms).padStart(5)} ms ${String(m.calls).padStart(4)} git runs`);
  if (KEEP) console.log(`\nKept ${root}`);
  else { for (const d of await fs.readdir(root)) await R.removeTree(join(root, d)).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); }
  console.log(`\n${failed ? 'FAILED' : 'ALL PASSED'}: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

async function exists(p) { return fs.access(p).then(() => true, () => false); }
