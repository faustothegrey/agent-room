// Branch diagrams for worker lanes. Loaded with the room's Reload version.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
export const git = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out.trim()))));
export const gitOk = (dir, ...args) => git(dir, ...args).then(() => true, () => false);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── Branch diagram for the Worker tab ──
// Builds a Mermaid gitGraph of `place.branch` against the room's current branch, from their
// fork/merge-base to both tips, using each side's first-parent history and real merge commits
// between the two branches. Other merges (such as main merging a third branch) stay as one commit
// tagged "merge". At most `limit` commits per side; cut-off history is marked with a "+N more
// commits" node (`type: HIGHLIGHT`) and never drawn as a direct parent link. When gitGraph cannot
// represent the history faithfully (no common ancestor, criss-cross / non-monotonic merges,
// octopus merges involving both branches, merges crossing the cut-off window), returns `{ note }`
// instead of a wrong picture.
export const BRANCH_DIAGRAM_LIMIT = 15;
const gitLogFirstParent = async (top, range) => {
  const out = await git(top, 'log', '--first-parent', '--format=%H%x1f%P%x1f%s', range);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [id, p = '', ...rest] = line.split('\x1f');
    return { id, parents: p ? p.split(' ').filter(Boolean) : [], subject: rest.join('\x1f') };
  });
};
const gitCommitInfo = async (top, sha) => {
  const out = await git(top, 'log', '-1', '--format=%H%x1f%P%x1f%s', sha);
  const [id, p = '', ...rest] = out.split('\x1f');
  return { id, parents: p ? p.split(' ').filter(Boolean) : [], subject: rest.join('\x1f') };
};
function formatDiagramLabel(commit) {
  const raw = String(commit.subject ?? '')
    .replace(/^\s*\[[^\]]+\]\s+/, '')
    .replace(/"/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const subj = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
  return subj ? `${commit.id.slice(0, 7)} ${subj}` : commit.id.slice(0, 7);
}
export async function branchDiagram(place, { limit = BRANCH_DIAGRAM_LIMIT } = {}) {
  const branchHead = await git(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${place.branch}^{commit}`).catch(() => null);
  if (!branchHead) return null;
  const [roomHead, roomBranch] = await Promise.all([
    git(place.top, 'rev-parse', 'HEAD'),
    git(place.top, 'rev-parse', '--abbrev-ref', 'HEAD'),
  ]);
  const note = (msg) => ({ note: msg, roomBranch, branch: place.branch });
  if (roomBranch === place.branch) return note(`${place.branch} is the room's current branch.`);
  if (/["\r\n]/.test(roomBranch) || /["\r\n]/.test(place.branch)) return note('Branch diagram unavailable: branch name contains unsupported characters.');

  const basesOut = await git(place.top, 'merge-base', '--all', roomHead, branchHead).catch(() => '');
  const bases = basesOut.split('\n').filter(Boolean);
  if (!bases.length) return note(`Branch diagram unavailable: ${place.branch} and ${roomBranch} have no common ancestor.`);
  if (bases.length > 1) return note(`Branch diagram unavailable: ${place.branch} and ${roomBranch} have multiple merge-bases (criss-cross merge) that gitGraph cannot draw faithfully.`);

  // Walk both first-parent chains back to their shared fork point so repeated merges between the
  // two branches stay anchored to the commit where they split.
  let base, rCommits, bCommits;
  if (roomHead === branchHead) {
    base = roomHead; rCommits = []; bCommits = [];
  } else {
    const [bRaw, rRaw] = await Promise.all([
      gitLogFirstParent(place.top, `${roomHead}..${branchHead}`),
      gitLogFirstParent(place.top, `${branchHead}..${roomHead}`),
    ]);
    const bBase = bRaw.length ? bRaw.at(-1).parents[0] : branchHead;
    const rBase = rRaw.length ? rRaw.at(-1).parents[0] : roomHead;
    if (!bBase || !rBase) return note(`Branch diagram unavailable: could not find a common first-parent base between ${place.branch} and ${roomBranch}.`);
    if (bBase === rBase) {
      base = bBase; rCommits = rRaw.reverse(); bCommits = bRaw.reverse();
    } else if (await gitOk(place.top, 'merge-base', '--is-ancestor', bBase, rBase)) {
      const rFull = await gitLogFirstParent(place.top, `${bBase}..${roomHead}`);
      const ok = rFull.length ? rFull.at(-1).parents[0] === bBase : roomHead === bBase;
      if (!ok) return note(`Branch diagram unavailable: history between ${place.branch} and ${roomBranch} does not follow a single first-parent fork.`);
      base = bBase; rCommits = rFull.reverse(); bCommits = bRaw.reverse();
    } else if (await gitOk(place.top, 'merge-base', '--is-ancestor', rBase, bBase)) {
      const bFull = await gitLogFirstParent(place.top, `${rBase}..${branchHead}`);
      const ok = bFull.length ? bFull.at(-1).parents[0] === rBase : branchHead === rBase;
      if (!ok) return note(`Branch diagram unavailable: history between ${place.branch} and ${roomBranch} does not follow a single first-parent fork.`);
      base = rBase; rCommits = rRaw.reverse(); bCommits = bFull.reverse();
    } else {
      return note(`Branch diagram unavailable: ${place.branch} and ${roomBranch} do not share a single first-parent fork point.`);
    }
  }

  // Classify merges between the two branches; merges from outside the two branches stay as one
  // commit tagged "merge".
  const rSet = new Set([base, ...rCommits.map((c) => c.id)]);
  const bSet = new Set([base, ...bCommits.map((c) => c.id)]);
  for (const c of bCommits) {
    const extra = c.parents.slice(1);
    const rParents = extra.filter((p) => rSet.has(p));
    if (rParents.length > 1 || (rParents.length === 1 && extra.length > 1)) {
      return note(`Branch diagram unavailable: ${place.branch} has an octopus merge (${c.id.slice(0, 7)}) involving ${roomBranch}.`);
    }
    if (rParents.length === 1) c.mergeFrom = rParents[0];
    else if (extra.length > 0) c.externalMerge = true;
  }
  for (const c of rCommits) {
    const extra = c.parents.slice(1);
    const bParents = extra.filter((p) => bSet.has(p) && p !== base);
    if (bParents.length > 1 || (bParents.length === 1 && extra.length > 1)) {
      return note(`Branch diagram unavailable: ${roomBranch} has an octopus merge (${c.id.slice(0, 7)}) involving ${place.branch}.`);
    }
    if (bParents.length === 1) c.mergeFrom = bParents[0];
    else if (extra.length > 0) c.externalMerge = true;
  }

  // Limit each side to `limit` commits, marking any cut-off prefix with a "+N more commits" node.
  // Never drop or fake a merge that crosses the cut-off boundary.
  const rCut = Math.max(0, rCommits.length - limit);
  const bCut = Math.max(0, bCommits.length - limit);
  const rCutSet = new Set(rCommits.slice(0, rCut).map((c) => c.id));
  const bCutSet = new Set(bCommits.slice(0, bCut).map((c) => c.id));
  const rKept = rCommits.slice(rCut);
  const bKept = bCommits.slice(bCut);
  if (bKept.some((c) => c.mergeFrom && rCutSet.has(c.mergeFrom)) || rKept.some((c) => c.mergeFrom && bCutSet.has(c.mergeFrom))) {
    return note(`Branch diagram unavailable: a shown merge crosses history older than the ${limit}-commit display limit.`);
  }
  if (bCommits.slice(0, bCut).some((c) => c.mergeFrom && !rCutSet.has(c.mergeFrom)) || rCommits.slice(0, rCut).some((c) => c.mergeFrom && !bCutSet.has(c.mergeFrom))) {
    return note(`Branch diagram unavailable: cut-off history merges a commit within the ${limit}-commit display window.`);
  }

  const sameCut = rCut > 0 && bCut > 0 && rCut === bCut;
  const rSeq = rCut > 0 ? [{ cut: true, id: '__cut_r', label: `+${rCut} more ${plural(rCut, 'commit').slice(String(rCut).length + 1)}${sameCut ? ` (${roomBranch})` : ''}` }, ...rKept] : [...rKept];
  const bSeq = bCut > 0 ? [{ cut: true, id: '__cut_b', label: `+${bCut} more ${plural(bCut, 'commit').slice(String(bCut).length + 1)}${sameCut ? ` (${place.branch})` : ''}` }, ...bKept] : [...bKept];

  // Replay both sides into Mermaid gitGraph commands, checking that every merge targets the
  // other branch's current tip and never violates Mermaid's own gitGraph rules.
  const baseCommit = await gitCommitInfo(place.top, base);
  const lines = ['---', 'config:', '  gitGraph:', '    rotateCommitLabel: false'];
  if (roomBranch !== 'main') lines.push(`    mainBranchName: "${roomBranch}"`);
  lines.push('---', 'gitGraph TB:');
  lines.push(`  commit id: "${formatDiagramLabel(baseCommit)}"${baseCommit.parents.length > 1 ? ' tag: "merge"' : ''}`);
  lines.push(`  branch "${place.branch}"`);

  let curr = place.branch;
  let rTip = base, rTipBranch = roomBranch;
  let bTip = base, bTipBranch = roomBranch;
  let ri = 0, bi = 0;

  const checkout = (name) => { if (curr !== name) { lines.push(`  checkout "${name}"`); curr = name; } };
  while (ri < rSeq.length || bi < bSeq.length) {
    const rPinned = bSeq.slice(bi).some((c) => c.mergeFrom === rTip);
    const bPinned = rSeq.slice(ri).some((c) => c.mergeFrom === bTip);
    const canR = ri < rSeq.length && !rPinned && (!rSeq[ri].mergeFrom || bTip === rSeq[ri].mergeFrom);
    const canB = bi < bSeq.length && !bPinned && (!bSeq[bi].mergeFrom || rTip === bSeq[bi].mergeFrom);
    if (!canR && !canB) {
      return note(`Branch diagram unavailable: merge order between ${place.branch} and ${roomBranch} cannot be drawn faithfully as a gitGraph.`);
    }
    const pickB = canB && (!canR || curr === place.branch);
    if (pickB) {
      const c = bSeq[bi++];
      if (c.mergeFrom) {
        if (bTipBranch === roomBranch) {
          return note(`Branch diagram unavailable: ${place.branch} merges ${roomBranch} (${c.id.slice(0, 7)}) before any commit of its own, which gitGraph cannot draw.`);
        }
        checkout(place.branch);
        lines.push(`  merge "${roomBranch}" id: "${formatDiagramLabel(c)}"`);
      } else if (c.cut) {
        checkout(place.branch);
        lines.push(`  commit id: "${c.label}" type: HIGHLIGHT`);
      } else {
        checkout(place.branch);
        lines.push(`  commit id: "${formatDiagramLabel(c)}"${c.externalMerge ? ' tag: "merge"' : ''}`);
      }
      bTip = c.id; bTipBranch = place.branch;
    } else {
      const c = rSeq[ri++];
      if (c.mergeFrom) {
        if (rTipBranch === place.branch) {
          return note(`Branch diagram unavailable: ${roomBranch} merges ${place.branch} (${c.id.slice(0, 7)}) before any commit of its own, which gitGraph cannot draw.`);
        }
        checkout(roomBranch);
        lines.push(`  merge "${place.branch}" id: "${formatDiagramLabel(c)}"`);
      } else if (c.cut) {
        checkout(roomBranch);
        lines.push(`  commit id: "${c.label}" type: HIGHLIGHT`);
      } else {
        checkout(roomBranch);
        lines.push(`  commit id: "${formatDiagramLabel(c)}"${c.externalMerge ? ' tag: "merge"' : ''}`);
      }
      rTip = c.id; rTipBranch = roomBranch;
    }
  }
  return { graph: lines.join('\n'), truncated: rCut > 0 || bCut > 0, roomBranch, branch: place.branch };
}


const baseKey = (ctx) => String(ctx.key ?? ctx.cwd).split('#')[0];
const pad = (n) => String(n).padStart(2, '0');
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'at an unknown time' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function worktreeOperation(privateDir) {
  if (existsSync(join(privateDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(privateDir, 'rebase-merge')) || existsSync(join(privateDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(privateDir, 'REVERT_HEAD')) || existsSync(join(privateDir, 'sequencer'))) return 'revert';
  return null;
}
export const gitRaw = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 24 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out))));

export async function labelledCommits(dir, range) {
  const lines = (await git(dir, 'log', '--reverse', '--format=%H %s', range)).split('\n');
  const commits = [];
  for (const line of lines) {
    const m = /^([0-9a-f]+) \[([^\]]+)\]/.exec(line);
    if (!m) continue;
    const files = (await git(dir, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', m[1])).split('\n').filter(Boolean);
    commits.push({ id: m[1], origin: m[2], files });
  }
  return commits;
}

export const WORKER_BRANCH = 'worker/main';
const NO_GIT = 'Worker requires a source Git repository for its isolated worktree.';
const real = (p) => (existsSync(p) ? realpathSync(p) : p);

// A discussion's folder name as the end of a branch name (worker/<name>), or null if Git refuses it.
const branchSafe = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..') && !/(\.lock|\.)$/.test(name);
// Where the room's worker works for `lane` (a discussion's folder name; null: a brainstorm, or no
// discussion yet): { root, top, path, cwd, branch, lane } (cwd: the room's subfolder inside the
// worktree, when the room isn't the repository's top), or { disabled: why }.
// A room's repository, once found usable, stays so: its top folder is asked once (lanes ask often).
const usableTops = new Map();
export async function workerPlace(roomRoot, lane = null) {
  const root = real(roomRoot);
  let top = usableTops.get(root);
  if (!top) {
    try { top = await git(root, 'rev-parse', '--show-toplevel'); } catch { return { disabled: NO_GIT }; }
    if (!(await gitOk(top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'))) return { disabled: `${NO_GIT} This one has no commit yet.` };
    const [own, common] = await Promise.all([git(top, 'rev-parse', '--absolute-git-dir'), git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')]);
    if (real(own) !== real(common)) return { disabled: `${top} is itself a linked Git worktree (such as a worker's): open the room in the main checkout instead.` };
    usableTops.set(root, top);
  }
  if (lane && !branchSafe(lane)) return { disabled: `The discussion's folder name "${lane}" can't be a Git branch name (worker/${lane}), so its worker has no worktree. Rename the folder (letters, digits, ".", "_" and "-").` };
  const path = lane ? join(dirname(top), `${basename(top)}.workers`, lane) : join(dirname(top), `${basename(top)}.worker`);
  return { root, top, path, cwd: join(path, relative(top, root)), branch: lane ? `worker/${lane}` : WORKER_BRANCH, lane };
}
// The lane of a task: its discussion's when it was queued, else worker/main.
export const lanePlace = async (ctx, lane) => sharedWorktree(ctx, await workerPlace(ctx.cwd, lane ?? null));
// The lanes that exist: worker/main's worktree and each <repo>.workers/<name>/ on worker/<name>.
export async function existingLanes(ctx) {
  const base = await lanePlace(ctx, null);
  if (base.disabled) return [];
  const found = [];
  for (const w of await worktrees(base.top)) {
    if (w.path === real(base.path) && w.branch === WORKER_BRANCH) found.push(base);
    else if (dirname(w.path) === real(join(dirname(base.top), `${basename(base.top)}.workers`)) && w.branch === `worker/${basename(w.path)}`) {
      const place = await workerPlace(base.root, basename(w.path));
      if (!place.disabled) found.push(place);
    }
  }
  return found;
}

// Rooms on one server in the same Git repository would share one worktree: the first room opened
// there has the worker; a later one gets none, with the reason.
export async function sharedWorktree(ctx, place) {
  if (place.disabled || !ctx.hub) return place;
  for (const other of ctx.hub.rooms.values()) {
    if (other === ctx) break; // only rooms opened before this one
    if (baseKey(other) === baseKey(ctx)) continue; // the same folder's open discussions share its worker
    if ((await workerPlace(other.cwd)).top === place.top) {
      return { disabled: `No worker in this room: ${other.cwd} is already open on this server in the same Git repository (${place.top}), and its worker uses ${place.path}.` };
    }
  }
  return place;
}

// The worktrees Git knows about: [{ path, branch }].
export async function worktrees(top) {
  return (await git(top, 'worktree', 'list', '--porcelain')).split('\n\n').map((block) => ({
    path: real(/^worktree (.*)$/m.exec(block)?.[1] ?? ''), branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] ?? null }));
}

// Creates the worktree, reattaches the branch, or reuses both; refuses (changing nothing) otherwise.
export async function ensureWorktree(place) {
  const list = await worktrees(place.top);
  const here = list.find((w) => w.path === real(place.path));
  if (here && here.branch !== place.branch) throw new Error(`${place.path} is a worktree on ${here.branch ?? 'a detached HEAD'}, not ${place.branch}: nothing was changed.`);
  if (here && !existsSync(place.path)) throw new Error(`Git still lists ${place.path} as a worktree, but the folder is gone: run git worktree prune in ${place.top}, then try again.`);
  if (here) return;
  if (existsSync(place.path)) throw new Error(`${place.path} already exists and isn't the worker's worktree: nothing was changed.`);
  const elsewhere = list.find((w) => w.branch === place.branch);
  if (elsewhere) throw new Error(`${place.branch} is already checked out in ${elsewhere.path}: nothing was changed.`);
  const exists = await gitOk(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${place.branch}`);
  if (place.lane && !exists) await migrationCheck(place, list);
  if (exists) await git(place.top, 'worktree', 'add', place.path, place.branch);
  else await git(place.top, 'worktree', 'add', '-b', place.branch, place.path, 'HEAD');
}
// Before a discussion's first lane is made: worker/main (shared by every discussion before lanes)
// must have no uncommitted edits, and none of this discussion's commits missing from main. Its
// commits are never moved, dropped or rewritten: they stay on worker/main until the User merges them.
async function migrationCheck(place, list) {
  const base = await workerPlace(place.root);
  const shared = list.find((w) => w.path === real(base.path) && w.branch === WORKER_BRANCH);
  if (shared && existsSync(base.path) && (await worktreeStatus(base)).treeDirty)
    throw new Error(`${base.path} (${WORKER_BRANCH}) has uncommitted edits: this discussion's own worktree is not created until they are committed or resolved there. Nothing was changed.`);
  if (await gitOk(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${WORKER_BRANCH}`)) {
    const main = await mainRef(place.top);
    const mine = (await labelledCommits(place.top, `${main}..${WORKER_BRANCH}`)).filter((c) => c.origin === place.lane);
    if (mine.length) throw new Error(`${WORKER_BRANCH} has commits of [${place.lane}] not in ${main}: ${mine.map((c) => c.id.slice(0, 7)).join(', ')}. Merge ${WORKER_BRANCH} into ${main} first (git merge ${WORKER_BRANCH} in the room), so that ${place.branch} starts with them; they were left where they are. Nothing was changed.`);
  }
}
// The branch the lanes catch up with: main, or the room's HEAD in a repository without one.
export const mainRef = async (top) => (await gitOk(top, 'rev-parse', '--verify', '-q', 'refs/heads/main') ? 'main' : 'HEAD');

// The worker's scratch notes, <worktree>/.worker-notes/<task>/, are ignored by Git in any project:
// listed in the repository's own info/exclude (local, never committed), once.
export const NOTES = '.worker-notes';
export async function ignoreNotes(place) { await appendExclude(place, `${NOTES}/`); }
// Adds an entry to the worktree's local info/exclude (local to that worktree, never committed),
// once. `entry` is the exact line: a trailing slash ignores a folder only, none ignores a file,
// folder or symlink.
export async function appendExclude(place, entry) {
  const file = await git(place.path, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim().replace(/^\/|\/$/g, '') === entry.replace(/^\/|\/$/g, ''))) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
}
// The worktree has no node_modules of its own (it isn't committed): link the room's in, so the
// worker's code and tests run without installing again. The link is ignored locally, so it never
// dirties the worktree; the worktree and its room are on one filesystem, so the link is valid.
export async function linkDeps(place) {
  const source = [join(place.root, 'node_modules'), join(place.top, 'node_modules')].find((p) => existsSync(p));
  if (!source) return;                    // nothing installed to link
  const target = join(place.path, 'node_modules');
  try { if (lstatSync(target).isSymbolicLink()) return; } catch {} // already linked
  if (existsSync(target)) return;         // a real node_modules already there: leave it
  symlinkSync(source, target, 'dir');
  await appendExclude(place, 'node_modules');
}

const UNMERGED_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
export function parsePorcelainConflicts(raw) {
  if (!raw) return [];
  const parts = raw.split('\0');
  const conflicts = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++;
      continue;
    }
    if (UNMERGED_CODES.has(xy) && path) conflicts.push(path);
  }
  return conflicts;
}

// The worktree compared with the room: whether it exists, the room's HEAD, commits on each side,
// the commit it's based on, and uncommitted changes (the room's outside discussions/, the worktree's).
export async function worktreeStatus(place) {
  const head = await git(place.top, 'rev-parse', 'HEAD');
  const roomDirty = (await git(place.root, 'status', '--porcelain', '--', '.', ':(exclude)discussions', ':(exclude).agent-room')) !== '';
  const exists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === real(place.path) && w.branch === place.branch);
  if (!exists) return { exists, head, roomDirty };
  const count = async (range) => Number(await git(place.top, 'rev-list', '--count', range));
  const [ahead, behind, base, statusOut] = await Promise.all([count(`HEAD..${place.branch}`), count(`${place.branch}..HEAD`),
    git(place.top, 'merge-base', 'HEAD', place.branch).then((sha) => sha.slice(0, 7), () => 'no common commit'),
    gitRaw(place.path, 'status', '--porcelain', '-z')]);
  const dirty = statusOut !== '';
  const conflicts = parsePorcelainConflicts(statusOut);
  const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
  const operation = worktreeOperation(privateDir);
  return { exists, head, roomDirty, ahead, behind, base, treeDirty: dirty || !!operation, operation, conflicts };
}

// Before each instruction: the lane's branch moves forward to the room's HEAD only when it is strictly
// behind it, with a clean worktree. Returns the new status.
export async function catchUp(place, s) {
  if (!s.exists || !s.behind || s.ahead || s.treeDirty) return s;
  await git(place.path, 'merge', '--ff-only', s.head);
  return worktreeStatus(place);
}

export function worktreeLines(place, s) {
  if (!s.exists) return [`The worker's worktree will be created at ${place.path}, on ${place.branch}, from ${s.head.slice(0, 7)}, with its first instruction.`];
  const lines = [`Worktree ${place.path} · branch ${place.branch} · based on ${s.base}`];
  if (s.operation) lines.push(`A ${s.operation} is in progress in the worker's worktree: dispatch holds for recovery by its origin.`);
  if (s.roomDirty) lines.push('The room has uncommitted changes: the worker doesn\'t see them.');
  if (s.ahead) lines.push(`${place.branch} has ${plural(s.ahead, 'commit')} not in the room: review and merge them when ready.`);
  if (s.behind) {
    lines.push(`${place.branch} is ${plural(s.behind, 'commit')} behind the room${s.ahead ? ' and has commits of its own: it is left as it is.'
      : s.treeDirty ? ': its worktree has uncommitted changes, so it is left as it is.' : ': it catches up with the next instruction.'}`);
  }
  return lines;
}
// The Worker tab shows each lane collapsible, under this line: its branch and its state in brief.
export function laneSummary(place, s, brief) {
  if (!s.exists) return `${place.branch} · worktree not created yet`;
  const parts = [s.operation && `${s.operation} in progress`, s.ahead && `${plural(s.ahead, 'commit')} to review`,
    s.treeDirty && 'uncommitted changes', ...brief].filter(Boolean);
  return [place.branch, ...(parts.length ? parts : ['nothing to review'])].join(' · ');
}


// ── Guardrails for merging a lane into main ──
// For a branch with commits not in main: whether it contains main's current commit; the commits its
// worker last reported testing together (its "Tested:" line, checked against Git and kept in the
// worktree's private Git directory); and, with Git 2.38 or newer, a merge preview. All read-only,
// and only advice: the User merges.
export async function laneChecks(place) {
  const main = await mainRef(place.top);
  const [mainId, tip] = await Promise.all([git(place.top, 'rev-parse', main), git(place.top, 'rev-parse', place.branch)]);
  if (!Number(await git(place.top, 'rev-list', '--count', `${main}..${place.branch}`))) return { lines: [], brief: [] };
  const lines = [], brief = [];
  if (await gitOk(place.top, 'merge-base', '--is-ancestor', mainId, tip)) lines.push(`${place.branch} contains current ${main} (${mainId.slice(0, 7)}).`);
  else {
    const missing = Number(await git(place.top, 'rev-list', '--count', `${place.branch}..${main}`));
    brief.push(`lacks ${plural(missing, 'commit')} of ${main}`);
    lines.push(`${place.branch} lacks ${plural(missing, 'commit')} of current ${main} (${mainId.slice(0, 7)}): its worker merges ${main} in with its next instruction. Merge it into ${main} after that, once its tests pass on top of ${main}.`);
  }
  const t = await readTested(place);
  if (!t) { lines.push(`${place.branch}: no test report on top of ${main} from its worker yet.`); brief.push('not tested on ' + main); }
  else {
    const moved = [t.branch !== tip && `${place.branch} is now at ${tip.slice(0, 7)}`, t.main !== mainId && `${main} is now at ${mainId.slice(0, 7)}`].filter(Boolean);
    brief.push(moved.length ? 'test report out of date' : `tests ${t.result}`);
    lines.push(`Last tested (the worker's report): ${place.branch} ${t.branch.slice(0, 7)} with ${main} ${t.main.slice(0, 7)}, tests ${t.result}, ${clock(t.at)}. ${moved.length ? `Out of date: ${moved.join(' and ')}.` : 'Still current.'}`);
  }
  const preview = await mergePreview(place, main);
  if (preview) { lines.push(preview.line); brief.push(preview.brief); }
  return { lines, brief };
}
export const testedFile = async (place) => join(await git(place.path, 'rev-parse', '--absolute-git-dir'), 'agent-room-tested.json');
export async function readTested(place) {
  try {
    const r = JSON.parse(readFileSync(await testedFile(place), 'utf8'));
    return r.version === 1 && /^[0-9a-f]{40,64}$/.test(r.branch) && /^[0-9a-f]{40,64}$/.test(r.main) && ['passed', 'failed'].includes(r.result) ? r : null;
  } catch { return null; }
}
const TESTED_FULL = /^Tested: ([0-9a-f]{40,64}) with (?:main|\S+) ([0-9a-f]{40,64}): tests (passed|failed)\.?$/;
const TESTED_SHORT = /^Tested: ([0-9a-f]{7,64}) with (?:main|\S+) ([0-9a-f]{7,64}): tests (passed|failed)\.?$/i;
const TESTED_ANY = /^\s*[*_`]*Tested\b/i;
const DOCS_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?Docs:(?:\*\*)?\s+\S/i;
// Checks a worker report's formal structure against the task's Git state. Returns a list of problems.
export function checkWorkerReport(reply, { askedCatchUp = false, mergePending = false, mainInHead = false, mainMoved = false, ownCommits = 0 } = {}) {
  const oweTested = Boolean((askedCatchUp || ownCommits > 0) && !mergePending && mainInHead && !mainMoved);
  const oweDocs = ownCommits > 0;
  const lines = String(reply ?? '').split('\n');
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && !lines[lastIdx].trim()) lastIdx--;
  const problems = [];
  const testedIndices = [];
  let docsIdx = -1;
  lines.forEach((l, i) => {
    if (TESTED_ANY.test(l)) testedIndices.push(i);
    if (docsIdx < 0 && DOCS_LINE.test(l)) docsIdx = i;
  });
  if (oweDocs && docsIdx < 0) {
    problems.push('has no Docs: line (include "Docs: <what you updated>" or "Docs: none needed, because <reason>")');
  }
  if (!testedIndices.length) {
    if (oweTested) problems.push('has no Tested: line (end with "Tested: <full branch commit ID> with main <full main commit ID>: tests passed|failed")');
  } else {
    const tIdx = testedIndices.at(-1);
    const raw = lines[tIdx].trimEnd();
    const trimmed = raw.trim();
    const unstyled = trimmed.replace(/[*_`]/g, '').trim();
    if (/^[*_`]+Tested\b/i.test(trimmed) || (unstyled !== trimmed && TESTED_SHORT.test(unstyled))) {
      problems.push('has a bold or styled Tested: line (write plain "Tested: <full branch commit ID> with main <full main commit ID>: tests passed|failed")');
    }
    if (TESTED_FULL.test(unstyled)) {
      if (raw !== trimmed && !/^[*_`]+Tested\b/i.test(trimmed)) {
        problems.push('has leading spaces on its Tested: line');
      }
    } else if (TESTED_SHORT.test(unstyled)) {
      problems.push('has short commit IDs in its Tested: line (use full 40-to-64-character hex commit IDs)');
    } else if (!/^[*_`]+Tested\b/i.test(trimmed)) {
      problems.push('has a malformed Tested: line (use "Tested: <full branch commit ID> with main <full main commit ID>: tests passed|failed")');
    }
    if (tIdx !== lastIdx || testedIndices.length > 1) {
      problems.push('has a Tested: line that is not the reply\'s last non-empty line');
    }
  }
  if (docsIdx >= 0 && testedIndices.length && docsIdx > testedIndices[0]) {
    problems.push('has its Docs: line after its Tested: line (place Docs: before Tested:)');
  }
  return problems;
}
export async function workerGitFacts(place, { before, mainAtStart, askedCatchUp = false } = {}) {
  const [head, mainNow, gitDir, unmerged] = await Promise.all([
    git(place.path, 'rev-parse', 'HEAD'),
    git(place.path, 'rev-parse', 'main').catch(() => null),
    git(place.path, 'rev-parse', '--absolute-git-dir'),
    git(place.path, 'ls-files', '-u').catch(() => ''),
  ]);
  const mergePending = existsSync(join(gitDir, 'MERGE_HEAD')) || unmerged.trim() !== '';
  const mainInHead = Boolean(mainAtStart && await gitOk(place.path, 'merge-base', '--is-ancestor', mainAtStart, head));
  const mainMoved = Boolean(mainAtStart && mainNow && mainNow !== mainAtStart);
  const ownCommits = before
    ? Number(await git(place.path, 'rev-list', '--no-merges', '--count', `${before}..${head}`, ...(mainAtStart ? ['--not', mainAtStart] : [])).catch(() => '0'))
    : 0;
  return { before, mainAtStart, mainNow, head, askedCatchUp, mergePending, mainInHead, mainMoved, ownCommits };
}

// Git's exit status as well as its output (git merge-tree exits 1 for a conflict).
export const gitStatus = (dir, ...args) => new Promise((done) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: out.trim(), err: String(errOut ?? '').trim() })));
let mergeTreeGit = null; // whether this Git has `merge-tree --write-tree` (2.38 or newer), asked once
export const hasMergeTree = () => (mergeTreeGit ??= git(tmpdir(), 'version').then((v) => {
  const [, major, minor] = /(\d+)\.(\d+)/.exec(v) ?? [];
  return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38);
}, () => false));
// The preview changes no branch, worktree or index; it does write unreferenced Git objects (the
// merged tree), which Git's own cleanup (gc) removes in time. Not shown with an older Git.
export async function mergePreview(place, main) {
  if (!await hasMergeTree()) return null;
  const advice = `Merge preview of ${place.branch} into ${main} (advice only: it can go stale, and a clean merge doesn't prove the combined code works)`;
  const r = await gitStatus(place.top, 'merge-tree', '--write-tree', '--name-only', '--no-messages', main, place.branch);
  if (r.code === 0) return { line: `${advice}: clean.`, brief: 'merges cleanly' };
  if (r.code === 1) {
    const files = [...new Set(r.out.split('\n').slice(1).filter(Boolean))];
    return { line: `${advice}: would conflict in ${files.join(', ') || 'files Git did not name'}.`, brief: files.length ? `would conflict in ${plural(files.length, 'file')}` : 'would conflict' };
  }
  return { line: `${advice}: it could not be computed (${r.err || `git exited with ${r.code}`}).`, brief: 'merge preview failed' };
}


// Callbacks belong to the current ui version; this factory stores no shared room state.
export function createLaneActions({
  shopOf, laneState, siblings, isDiscussion, parseSpec, readCheckpoint, writeCheckpoint,
  note, discussionRef, closedDiscussions, runningTasks, queuedTasks, firstLine,
  closeNamedDiscussion, queueWork, toScreen, workNote,
}) {
async function checkLaneCleanMerged(place) {
  const worktreeExists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === real(place.path));
  const branchHead = await git(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${place.branch}^{commit}`).catch(() => null);
  const branchExists = !!branchHead;
  if (!worktreeExists && !branchExists) return { exists: false, worktreeExists: false, branchExists: false, ahead: 0, dirty: false, op: null, hasLoss: false };
  const ahead = branchExists ? Number(await git(place.top, 'rev-list', '--count', `HEAD..${branchHead}`)) : 0;
  let op = null, dirty = false;
  if (worktreeExists) {
    const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
    op = worktreeOperation(privateDir);
    // `git status --porcelain` (without --ignored) checks tracked edits and untracked files only;
    // gitignored files such as .worker-notes/ and node_modules/ are treated as transient.
    dirty = (await git(place.path, 'status', '--porcelain')) !== '';
  }
  return { exists: true, worktreeExists, branchExists, ahead, dirty, op, hasLoss: ahead > 0 || dirty || !!op };
}

async function cleanupMergedOnClose(ctx, name) {
  const place = await lanePlace(ctx, name);
  if (place.disabled) return null;
  const pre = await checkLaneCleanMerged(place);
  if (!pre.exists || pre.hasLoss) return null;
  const shop = shopOf(ctx);
  if (shop.merging) {
    const msg = `Worker worktree and branch not removed (${shop.merging} was in progress): nothing removed.`;
    note(ctx, msg, true);
    return msg;
  }
  const lock = `Close cleanup for ${name}`;
  shop.merging = lock;
  const done = [];
  const partial = (err, notDone) => {
    const msg = `Worker worktree/branch cleanup failed (${err.message}). Removed: ${done.length ? done.join('; ') : 'nothing'}. Not removed: ${notDone.join('; ')}.`;
    note(ctx, `✗ ${msg}`, true);
    return msg;
  };
  try {
    const cur = await checkLaneCleanMerged(place);
    if (!cur.exists || cur.hasLoss) return null;
    if (cur.worktreeExists) {
      try {
        await git(place.top, 'worktree', 'remove', '--force', place.path);
        done.push(`worktree ${place.path}`);
      } catch (err) {
        return partial(err, [
          `worktree ${place.path}`,
          ...(cur.branchExists ? [`branch ${place.branch}`] : []),
          'lane hold and worker session',
        ]);
      }
    }
    if (cur.branchExists) {
      try {
        await git(place.top, 'branch', '-d', place.branch);
        done.push(`branch ${place.branch}`);
      } catch (err) {
        return partial(err, [`branch ${place.branch}`, 'lane hold and worker session']);
      }
    }
    clearLaneAndWorkerSession(ctx, name);
    await refreshWorker(ctx).catch(() => {});
    return 'Worker worktree and branch removed (already merged).';
  } finally {
    if (shop.merging === lock) shop.merging = null;
  }
}


// ── Close and Discard ─────────────────────────────────────────────────
// Two-click confirmation: first click previews everything that would be lost (commits not in main,
// tracked edits, untracked files, ignored files summarised by top-level folder) and snapshots it;
// second click re-checks the snapshot before saving refs/discarded/<name>/<timestamp>, removing
// the worktree and branch, clearing the lane's hold and saved worker session, and closing.
function fileContentHash(fullPath) {
  try {
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) return `symlink:${readlinkSync(fullPath)}`;
    if (st.isDirectory()) return 'dir';
    return createHash('sha256').update(readFileSync(fullPath)).digest('hex');
  } catch { return 'missing'; }
}
// Walks an ignored folder without following symlinks, collecting count + metadata hash (size, mtime).
function walkIgnoredMeta(rootDir, relDir, hash) {
  let count = 0;
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return; }
    for (const e of entries) {
      const childAbs = join(abs, e.name), childRel = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try { st = lstatSync(childAbs); } catch { continue; }
      if (st.isSymbolicLink()) {
        count++;
        hash.update(`L\0${childRel}\0${st.size}\0${st.mtimeMs}\n`);
      } else if (st.isDirectory()) {
        walk(childAbs, childRel);
      } else {
        count++;
        hash.update(`F\0${childRel}\0${st.size}\0${st.mtimeMs}\n`);
      }
    }
  };
  walk(join(rootDir, relDir), relDir);
  return count;
}
function parseStatusZ(raw) {
  const parts = raw.split('\0');
  const tracked = [], untracked = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2), path = entry.slice(3);
    if (xy === '??') untracked.push(path);
    else if (xy !== '!!') {
      const renamed = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
      const orig = renamed ? parts[++i] : null;
      tracked.push({ status: xy.trim() || xy, path, ...(orig && { orig }) });
    }
  }
  return { tracked, untracked };
}
// Shared snapshot collector for Close and Discard (Step 3) and Close and Merge (Step 4):
// snapshots the branch tip, tracked diff/status, content hashes for tracked/untracked files,
// and metadata (count, size, mtime) for ignored files summarised by top-level folder.
async function collectWorktreeSnapshot(place, branchHead, worktreeExists, { includeIgnored = true } = {}) {
  let tracked = [], untracked = [], ignored = [];
  const snap = createHash('sha256');
  snap.update(`branch:${branchHead ?? 'none'}\nworktree:${worktreeExists}\n`);

  if (worktreeExists) {
    const [statusZ, diffCached, ignoredZ] = await Promise.all([
      gitRaw(place.path, 'status', '--porcelain', '-z', '-uall'),
      gitRaw(place.path, 'diff', '--cached'),
      includeIgnored ? gitRaw(place.path, 'status', '--porcelain', '-z', '--ignored=matching') : Promise.resolve(''),
    ]);
    snap.update(`status:${statusZ}\ncached:${createHash('sha256').update(diffCached).digest('hex')}\n`);
    const parsed = parseStatusZ(statusZ);
    tracked = parsed.tracked;
    untracked = parsed.untracked.sort();
    for (const t of tracked) snap.update(`T\0${t.status}\0${t.path}\0${fileContentHash(join(place.path, t.path))}\n`);
    for (const u of untracked) snap.update(`U\0${u}\0${fileContentHash(join(place.path, u))}\n`);

    if (includeIgnored) {
      const groups = new Map();
      const getGroup = (key, isDir) => {
        if (!groups.has(key)) groups.set(key, { key, isDir, count: 0, hash: createHash('sha256') });
        return groups.get(key);
      };
      const ignoredEntries = ignoredZ.split('\0').filter((e) => e.startsWith('!! ')).map((e) => e.slice(3)).sort();
      for (const entry of ignoredEntries) {
        const clean = entry.replace(/\/$/, '');
        const full = join(place.path, clean);
        let st;
        try { st = lstatSync(full); } catch { continue; }
        const topFolder = clean.includes('/') ? `${clean.split('/')[0]}/` : null;
        if (st.isSymbolicLink()) {
          const g = getGroup(topFolder ?? clean, !!topFolder);
          g.count++;
          g.hash.update(`L\0${clean}\0${st.size}\0${st.mtimeMs}\n`);
        } else if (st.isDirectory()) {
          const key = topFolder ?? `${clean}/`;
          const g = getGroup(key, true);
          g.count += walkIgnoredMeta(place.path, clean, g.hash);
        } else {
          const g = getGroup(topFolder ?? clean, !!topFolder);
          g.count++;
          g.hash.update(`F\0${clean}\0${st.size}\0${st.mtimeMs}\n`);
        }
      }
      ignored = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map((g) => {
        const metaDigest = g.hash.digest('hex');
        snap.update(`I\0${g.key}\0${g.count}\0${metaDigest}\n`);
        const label = g.isDir ? `${g.key} ${g.count.toLocaleString('en-US')} ${g.count === 1 ? 'file' : 'files'}` : g.key;
        return { key: g.key, count: g.count, label };
      });
    }
  }
  return { tracked, untracked, ignored, snapshot: snap.digest('hex') };
}

function clearLaneAndWorkerSession(ctx, name) {
  const shop = shopOf(ctx);
  const lane = laneState(shop, name);
  lane.blockedBy = null;
  lane.holdContext = null;
  lane.inspectionError = null;
  if (lane.recheck) { clearTimeout(lane.recheck); lane.recheck = null; }
  const opened = siblings(ctx).find((c) => !c.stopped && isDiscussion(c, name));
  if (opened) {
    const wName = parseSpec(opened.workerSpec ?? 'claude', true).name;
    const ws = opened.sessions?.get(`worker:${wName}`);
    if (ws) for (const k of Object.keys(ws)) delete ws[k];
    opened.workerBriefed = false;
    opened.workerTree = null;
    opened.workerLabel = null;
    if (opened.workerDir) opened.workerDir.path = null;
  }
  const cp = readCheckpoint(ctx, name);
  if (cp && !cp.invalid && Array.isArray(cp.sessions)) {
    writeCheckpoint(ctx, name, { ...cp, sessions: cp.sessions.filter(([k]) => !String(k).startsWith('worker:')) });
  }
}

function failActionReport(ctx, action, name, step, err, done, notDone, extra = '') {
  const summary = `${action} for ${name} stopped at "${step}": ${err.message}. Done: ${done.length ? done.join('; ') : 'nothing'}. Not done: ${notDone.join('; ')}.${extra ? ` ${extra}` : ''} The discussion was left open.`;
  note(ctx, `✗ ${summary}`, true);
  throw new Error(summary);
}

async function inspectDiscard(ctx, name, { selfLock = null } = {}) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name);
  if (!d) throw new Error(`No discussion "${name}".`);
  const shop = shopOf(ctx), closing = shop.closing ??= new Map();
  if (closing.has(d.name)) throw new Error(`${d.name} is already closing.`);
  if (closedDiscussions(ctx).includes(d.name)) throw new Error(`${d.name} is already closed.`);
  if (shop.merging && shop.merging !== selfLock) throw new Error(`Cannot Close and Discard ${d.name}: ${shop.merging} is already in progress in this room.`);
  const tasks = [...runningTasks(shop), ...queuedTasks(shop)].filter((t) => t.owner === d.name);
  if (tasks.length) {
    const names = tasks.map((t) => `"${firstLine(t.text)}"`).join(', ');
    throw new Error(`Cannot Close and Discard ${d.name}: ${plural(tasks.length, 'worker task')} running or queued (${names}).`);
  }
  const place = await lanePlace(ctx, d.name);
  if (place.disabled) throw new Error(place.disabled);
  const worktreeExists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === real(place.path));
  const branchHead = await git(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${place.branch}^{commit}`).catch(() => null);
  const branchExists = !!branchHead;
  if (!worktreeExists && !branchExists) throw new Error(`${d.name} has no worker worktree or branch to discard.`);
  if (worktreeExists) {
    const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
    const op = worktreeOperation(privateDir);
    if (op) throw new Error(`Cannot Close and Discard ${d.name}: its worktree is mid-${op}. Resolve or abort it first.`);
  }

  let commits = [];
  if (branchExists) {
    const main = await mainRef(place.top);
    const logOut = await git(place.top, 'log', '--format=%h%x1f%s', `${main}..refs/heads/${place.branch}`);
    commits = logOut ? logOut.split('\n').filter(Boolean).map((l) => {
      const [hash, ...rest] = l.split('\x1f');
      return { hash, subject: rest.join('\x1f') };
    }) : [];
  }

  const { tracked, untracked, ignored, snapshot } = await collectWorktreeSnapshot(place, branchHead, worktreeExists);
  return {
    d, place, branchHead, worktreeExists, branchExists,
    preview: {
      name: d.name, branch: place.branch, path: place.path, worktreeExists, branchExists,
      commits, tracked, untracked, ignored, snapshot,
    },
  };
}

function discardTimestamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
async function saveDiscardRef(top, name, tip) {
  const baseTs = discardTimestamp();
  const zero = '0'.repeat(40);
  for (let n = 1; n <= 100; n++) {
    const ref = `refs/discarded/${name}/${n === 1 ? baseTs : `${baseTs}-${n}`}`;
    try {
      await git(top, 'update-ref', ref, tip, zero);
      return ref;
    } catch {
      if (!(await gitOk(top, 'rev-parse', '--verify', '-q', ref))) throw new Error(`Could not save recovery ref ${ref}.`);
    }
  }
  throw new Error(`Could not allocate a unique refs/discarded/${name}/${baseTs} ref.`);
}

async function discardPreview(ctx, name) {
  const { preview } = await inspectDiscard(ctx, name);
  return { ok: true, preview };
}

async function closeAndDiscard(ctx, name, snapshot) {
  const shop = shopOf(ctx);
  if (shop.merging) throw new Error(`Cannot Close and Discard ${name}: ${shop.merging} is already in progress in this room.`);
  const lock = `Close and Discard for ${name}`;
  shop.merging = lock;
  try {
    const info = await inspectDiscard(ctx, name, { selfLock: lock });
    if (!snapshot || info.preview.snapshot !== snapshot) {
      return { changed: true, preview: info.preview };
    }
    const { d, place, branchHead, worktreeExists, branchExists, preview } = info;
    const done = [];
    const failReport = (step, err, notDone) => failActionReport(ctx, 'Close and Discard', d.name, step, err, done, notDone);

    let savedRef = null;
    if (branchExists && preview.commits.length > 0) {
      try {
        savedRef = await saveDiscardRef(place.top, d.name, branchHead);
        done.push(`saved ${plural(preview.commits.length, 'commit')} at ${savedRef}`);
      } catch (err) {
        failReport('save recovery ref', err, [
          ...(worktreeExists ? [`worktree ${place.path} not removed`] : []),
          `branch ${place.branch} not deleted`,
          'lane hold and worker session not cleared',
          'discussion not closed',
        ]);
      }
    }
    if (worktreeExists) {
      try {
        await git(place.top, 'worktree', 'remove', '--force', place.path);
        done.push(`removed worktree ${place.path}`);
      } catch (err) {
        failReport('remove worktree', err, [
          ...(branchExists ? [`branch ${place.branch} not deleted`] : []),
          'lane hold and worker session not cleared',
          'discussion not closed',
        ]);
      }
    }
    if (branchExists) {
      try {
        await git(place.top, 'branch', '-D', place.branch);
        done.push(`deleted branch ${place.branch}`);
      } catch (err) {
        failReport('delete branch', err, [
          'lane hold and worker session not cleared',
          'discussion not closed',
        ]);
      }
    }
    clearLaneAndWorkerSession(ctx, d.name);
    done.push('cleared lane hold and worker session');
    await refreshWorker(ctx).catch(() => {});

    const discardLine = savedRef
      ? `Worker work discarded: ${plural(preview.commits.length, 'commit')} kept at \`${savedRef}\`.`
      : 'Worker work discarded: nothing committed.';
    try {
      await closeNamedDiscussion(ctx, d.name, { extraLine: discardLine, rethrow: true });
    } catch (err) {
      failReport('close discussion', err, ['discussion not closed']);
    }
    return { ok: true, savedRef };
  } finally {
    if (shop.merging === lock) shop.merging = null;
  }
}

// ── Close and Merge ───────────────────────────────────────────────────
// Reuses Step 3's snapshot and step-by-step failure report. Checks all merge prerequisites
// (greyed-out reasons), offers Catch up with <branch> when the target branch has moved,
// runs one merge at a time with best-effort abort on conflict, then removes the worktree,
// deletes the branch with `git branch -d`, clears hold/session, and closes.
async function mergeReadiness(ctx, place) {
  const name = place.lane;
  const shop = shopOf(ctx);
  const [roomBranch, roomHead, roomGitDir] = await Promise.all([
    git(place.top, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(place.top, 'rev-parse', 'HEAD'),
    git(place.top, 'rev-parse', '--absolute-git-dir'),
  ]);
  const branchHead = await git(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${place.branch}^{commit}`).catch(() => null);
  if (!branchHead) return { show: false };
  const ahead = Number(await git(place.top, 'rev-list', '--count', `${roomHead}..${branchHead}`));
  if (!ahead) return { show: false };

  const targetBranch = roomBranch === 'HEAD' ? null : roomBranch;
  const tasks = [...runningTasks(shop), ...queuedTasks(shop)].filter((t) => t.owner === name);
  const worktreeExists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === real(place.path));
  let worktreeOp = null, worktreeDirty = false;
  if (worktreeExists) {
    const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
    worktreeOp = worktreeOperation(privateDir);
    worktreeDirty = (await git(place.path, 'status', '--porcelain')) !== '';
  }
  const roomOp = worktreeOperation(roomGitDir);
  const roomTrackedDirty = (await git(place.root, 'status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)discussions', ':(exclude).agent-room')) !== '';
  const behind = Number(await git(place.top, 'rev-list', '--count', `${branchHead}..${roomHead}`));

  // Order of checks: active tasks / worktree state / room state first.
  const block = (disabledReason) => ({ show: true, canMerge: false, catchUp: false, disabledReason, targetBranch, roomHead, branchHead, worktreeExists, ahead, behind });
  if (tasks.length) {
    const names = tasks.map((t) => `"${firstLine(t.text)}"`).join(', ');
    return block(`${plural(tasks.length, 'worker task')} running or queued (${names}).`);
  }
  if (worktreeOp) return block(`The worker's worktree is mid-${worktreeOp}.`);
  if (worktreeDirty) return block('The worker\'s worktree has uncommitted edits.');
  if (!targetBranch) return block('The room\'s checkout is on a detached HEAD.');
  if (roomOp) return block(`The room's checkout is mid-${roomOp}.`);
  if (roomTrackedDirty) return block('The room\'s checkout has tracked edits outside discussions/.');

  // Target branch has moved: offer Catch up with <branch> instead of merging.
  if (behind > 0) {
    return { show: true, canMerge: false, catchUp: true, disabledReason: null, targetBranch, roomHead, branchHead, worktreeExists, ahead, behind };
  }

  // Merge preview check (Git 2.38+).
  if (await hasMergeTree()) {
    const r = await gitStatus(place.top, 'merge-tree', '--write-tree', '--name-only', '--no-messages', targetBranch, place.branch);
    if (r.code === 1) {
      const files = [...new Set(r.out.split('\n').slice(1).filter(Boolean))];
      return block(`Merge preview is not clean (would conflict in ${files.join(', ') || 'files Git did not name'}).`);
    }
    if (r.code !== 0) return block(`Merge preview could not be computed (${r.err || `git exited with ${r.code}`}).`);
  }

  // Recorded Tested: result for the branch's current tip with the room's current tip.
  const t = worktreeExists ? await readTested(place) : null;
  if (!t) return block(`No passing Tested: report from the worker for ${place.branch} with ${targetBranch} yet.`);
  if (t.result !== 'passed') return block('The worker\'s last test report failed.');
  if (t.branch !== branchHead || t.main !== roomHead) {
    return block(`The worker's test report is out of date (${place.branch} or ${targetBranch} moved since it was tested).`);
  }
  return { show: true, canMerge: true, catchUp: false, disabledReason: null, targetBranch, roomHead, branchHead, worktreeExists, ahead, behind };
}

async function activeWorkNotice(ctx, name, place, targetBranch) {
  const shop = shopOf(ctx);
  const otherRounds = siblings(ctx).filter((c) => !c.stopped && c.discussion?.name !== name && !!c.screen?.thinking).length;
  const otherRunning = runningTasks(shop).filter((t) => t.owner !== name);
  const otherQueued = queuedTasks(shop).filter((t) => t.owner !== name);
  const taskBranch = (t) => (t.lane ? `worker/${t.lane}` : WORKER_BRANCH);

  const branchRefs = await git(place.top, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/worker/').catch(() => '');
  const otherBranches = [];
  for (const b of branchRefs.split('\n').filter(Boolean)) {
    if (b === place.branch) continue;
    const ahead = Number(await git(place.top, 'rev-list', '--count', `${targetBranch}..refs/heads/${b}`).catch(() => '0'));
    if (ahead > 0) otherBranches.push(b);
  }

  const activeParts = [];
  if (otherRounds) activeParts.push(`${plural(otherRounds, 'discussion')} in a round`);
  if (otherRunning.length) {
    const branches = [...new Set(otherRunning.map(taskBranch))].join(', ');
    activeParts.push(`${plural(otherRunning.length, 'worker task')} running (${branches})`);
  }
  if (otherQueued.length) {
    const branches = [...new Set(otherQueued.map(taskBranch))].join(', ');
    activeParts.push(`${otherQueued.length} queued (${branches})`);
  }
  const sentences = [];
  if (activeParts.length) sentences.push(`Active now: ${activeParts.join(', ')}.`);
  if (otherBranches.length) sentences.push(`Other branches may need Catch up with ${targetBranch} afterwards: ${otherBranches.join(', ')}.`);
  return sentences.length ? sentences.join(' ') : null;
}

async function inspectCloseMerge(ctx, name, { selfLock = null } = {}) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name);
  if (!d) throw new Error(`No discussion "${name}".`);
  const shop = shopOf(ctx), closing = shop.closing ??= new Map();
  if (closing.has(d.name)) throw new Error(`${d.name} is already closing.`);
  if (closedDiscussions(ctx).includes(d.name)) throw new Error(`${d.name} is already closed.`);
  if (shop.merging && shop.merging !== selfLock) throw new Error(`Cannot Close and Merge ${d.name}: ${shop.merging} is already in progress in this room.`);
  const place = await lanePlace(ctx, d.name);
  if (place.disabled) throw new Error(place.disabled);
  const state = await mergeReadiness(ctx, place);
  if (!state.show) throw new Error(`${d.name} has no commits not in the room's current branch to merge.`);
  if (state.catchUp) {
    return {
      d, place, state, catchUp: true,
      message: `${state.targetBranch} has moved (${place.branch} lacks ${plural(state.behind, 'commit')} of ${state.targetBranch}). Catch up with ${state.targetBranch} first; nothing was merged.`,
    };
  }
  if (!state.canMerge) throw new Error(`Cannot Close and Merge ${d.name}: ${state.disabledReason}`);

  const [logOut, worktreeSnap, activeNotice] = await Promise.all([
    git(place.top, 'log', '--format=%h%x1f%s', `${state.roomHead}..${state.branchHead}`),
    collectWorktreeSnapshot(place, state.branchHead, state.worktreeExists, { includeIgnored: false }),
    activeWorkNotice(ctx, d.name, place, state.targetBranch),
  ]);
  const commits = logOut ? logOut.split('\n').filter(Boolean).map((l) => {
    const [hash, ...rest] = l.split('\x1f');
    return { hash, subject: rest.join('\x1f') };
  }) : [];
  // activeNotice and gitignored files are intentionally excluded from the Close and Merge snapshot.
  const mergeSnap = createHash('sha256')
    .update(`target:${state.targetBranch}\nroomHead:${state.roomHead}\nwt:${worktreeSnap.snapshot}\n`)
    .digest('hex');

  return {
    d, place, state, catchUp: false,
    preview: {
      name: d.name, branch: place.branch, targetBranch: state.targetBranch,
      title: `Merge ${place.branch} into ${state.targetBranch}`,
      path: place.path, commits, untracked: worktreeSnap.untracked,
      ...(activeNotice && { activeNotice }),
      snapshot: mergeSnap,
    },
  };
}

async function closeMergePreview(ctx, name) {
  const info = await inspectCloseMerge(ctx, name);
  if (info.catchUp) return { catchUp: true, targetBranch: info.state.targetBranch, behind: info.state.behind, message: info.message };
  return { ok: true, preview: info.preview };
}

async function catchUpWithBranch(ctx, name) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name);
  if (!d) throw new Error(`No discussion "${name}".`);
  const opened = siblings(ctx).find((c) => !c.stopped && isDiscussion(c, d.name));
  if (!opened) throw new Error(`Continue ${d.name} first so its worker can catch up.`);
  const place = await lanePlace(opened, d.name);
  if (place.disabled) throw new Error(place.disabled);
  const state = await mergeReadiness(opened, place);
  if (!state.show) throw new Error(`${d.name} has no unmerged commits.`);
  if (!state.catchUp) {
    if (state.disabledReason) throw new Error(`Cannot catch up ${d.name}: ${state.disabledReason}`);
    throw new Error(`${place.branch} already contains ${state.targetBranch}.`);
  }
  const target = state.targetBranch;
  const text = `Catch up with ${target}: merge ${target} into ${place.branch} with a normal merge (git merge ${target}). Label any merge commit "[${d.name}] catch up with ${target}". If it clashes, only if every conflict is purely additive (both sides only added independent lines or blocks with no overlapping edits or deletions), resolve it by keeping both additions, stage and commit the merge with the same label, and note what you resolved; for any other conflict, do not force it: leave the state intact and report the conflict. After a successful merge, run the project's tests (npm test, if it has them), report their real output, and end your reply with the line "Tested: <full commit ID of ${place.branch}> with ${target} <full commit ID of ${target}>: tests passed" (or "tests failed"). Never merge into ${target} or push.`;
  queueWork(opened, text, null, null, null, { catchUp: true });
  return { ok: true, targetBranch: target };
}

async function closeAndMerge(ctx, name, snapshot, { _beforeMerge = null } = {}) {
  const shop = shopOf(ctx);
  if (shop.merging) throw new Error(`Cannot Close and Merge ${name}: ${shop.merging} is already in progress in this room.`);
  const lock = `Close and Merge for ${name}`;
  shop.merging = lock;
  try {
    const info = await inspectCloseMerge(ctx, name, { selfLock: lock });
    if (info.catchUp) return { catchUp: true, targetBranch: info.state.targetBranch, behind: info.state.behind, message: info.message };
    if (!snapshot || info.preview.snapshot !== snapshot) {
      return { changed: true, preview: info.preview };
    }
    const { d, place, state } = info;
    const targetBranch = state.targetBranch;
    const roomGitDir = await git(place.top, 'rev-parse', '--absolute-git-dir');
    const done = [];
    const failAfterMerge = (step, err, notDone) =>
      failActionReport(ctx, 'Close and Merge', d.name, step, err, done, notDone, `The merge in ${targetBranch} stays.`);

    if (_beforeMerge) await _beforeMerge(place);

    // 1. Run normal merge (--no-ff) in the room checkout.
    try {
      await git(place.top, 'merge', '--no-ff', '-m', `[${d.name}] Merge ${place.branch}`, place.branch);
    } catch (err) {
      const hasMergeHead = existsSync(join(roomGitDir, 'MERGE_HEAD'));
      let report;
      if (hasMergeHead) {
        try {
          await git(place.top, 'merge', '--abort');
          report = `Merge of ${place.branch} into ${targetBranch} failed (${err.message}). Aborted the merge; the room's checkout is back as it was. The branch, worktree and discussion were left open.`;
        } catch (abortErr) {
          report = `Merge of ${place.branch} into ${targetBranch} failed (${err.message}), and git merge --abort also failed (${abortErr.message}). The room's checkout may still be mid-merge: inspect git status and git diff in ${place.top}, then run git merge --abort or git reset --merge as appropriate. The branch, worktree and discussion were left open.`;
        }
      } else {
        report = `Merge of ${place.branch} into ${targetBranch} failed (${err.message}). No merge was left in progress; the branch, worktree and discussion were left open.`;
      }
      note(ctx, `✗ ${report}`, true);
      throw new Error(report);
    }

    const mergeCommit = await git(place.top, 'rev-parse', '--short=7', 'HEAD');
    done.push(`merged ${place.branch} into ${targetBranch} as ${mergeCommit}`);

    // 2. Remove worktree.
    if (state.worktreeExists) {
      try {
        await git(place.top, 'worktree', 'remove', '--force', place.path);
        done.push(`removed worktree ${place.path}`);
      } catch (err) {
        failAfterMerge('remove worktree', err, [
          `branch ${place.branch} not deleted`,
          'lane hold and worker session not cleared',
          'discussion not closed',
        ]);
      }
    }

    // 3. Delete branch with `git branch -d` (not -D).
    try {
      await git(place.top, 'branch', '-d', place.branch);
      done.push(`deleted branch ${place.branch}`);
    } catch (err) {
      failAfterMerge('delete branch', err, [
        'lane hold and worker session not cleared',
        'discussion not closed',
      ]);
    }

    // 4. Clear lane hold and saved worker session.
    clearLaneAndWorkerSession(ctx, d.name);
    done.push('cleared lane hold and worker session');
    await refreshWorker(ctx).catch(() => {});

    // 5. Close discussion with closing-statement line.
    const mergeLine = `Worker work merged into \`${targetBranch}\` as \`${mergeCommit}\`.`;
    try {
      await closeNamedDiscussion(ctx, d.name, { extraLine: mergeLine, rethrow: true });
    } catch (err) {
      failAfterMerge('close discussion', err, ['discussion not closed']);
    }
    return { ok: true, mergeCommit, targetBranch };
  } finally {
    if (shop.merging === lock) shop.merging = null;
  }
}


// Reads the worktree's state for the Worker tab; with `prepare` (before each instruction), creates
// or reattaches the worktree and catches up first. Returns the place (disabled or not).
// `place`: the lane to prepare (a task's); by default the lane of the discussion in use. The Worker
// tab of each open discussion shows its own lane first, then every other lane with something to
// review, each with its checks (laneChecks), recomputed here: after each task, and when the tab is shown.
async function refreshWorker(ctx, { prepare = false, fastForward = true, place = null, _beforeBroadcast = null } = {}) {
  place ??= await lanePlace(ctx, laneOf(ctx));
  const holder = siblings(ctx).find((c) => c.screen);
  const shop = holder ? shopOf(holder) : null;
  const nextSeq = () => (shop ? (shop.refreshSeq = (shop.refreshSeq ?? 0) + 1) : 0);
  if (prepare && !place.disabled) {
    try {
      await ensureWorktree(place); await ignoreNotes(place); await linkDeps(place);
      let s = await worktreeStatus(place);
      if (fastForward) s = await catchUp(place, s);
      (ctx.workerDir ??= { path: null }).path = s.exists ? place.cwd : null;
    } catch (err) {
      const seq = nextSeq();
      const info = { lines: [`✗ ${err.message}`], error: true };
      if (!shop || seq === shop.refreshSeq) {
        for (const c of siblings(ctx)) if (c.screen) { c.screen.workerInfo = info; toScreen(c, { type: 'workerinfo', info }); }
      }
      throw err;
    }
  }
  const seq = nextSeq();
  const seen = new Map(); // each lane's lines, computed once for all the open discussions
  const updates = [];
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    if (shop && seq !== shop.refreshSeq) return place;
    const info = await workerInfo(c, seen, c === ctx && !prepare ? place : null);
    updates.push([c, info]);
  }
  if (_beforeBroadcast) await _beforeBroadcast();
  if (shop && seq !== shop.refreshSeq) return place;
  for (const [c, info] of updates) {
    if (!c.screen) continue;
    c.screen.workerInfo = info;
    toScreen(c, { type: 'workerinfo', info });
  }
  return place;
}
// A context's lane: its discussion's, or worker/main's for a brainstorm or before the first message.
const laneOf = (ctx) => (ctx.discussion && !ctx.state?.brainstorm ? ctx.discussion.name : null);
async function workerInfo(ctx, seen = new Map(), own = null) {
  own ??= await lanePlace(ctx, laneOf(ctx));
  if (own.disabled) return { lines: [own.disabled], disabled: true };
  // A lane's lines, a one-line summary for the page, its branch diagram against the room's current
  // branch, and whether it has something to review: { lines, summary, review, diagram }, with
  // `pending` when it has: its discussion (lane; null for worker/main), branch, commits not in main
  // and uncommitted edits, for the Discussions tab.
  const of = (place) => {
    if (!seen.has(place.path)) seen.set(place.path, (async () => {
      const s = await worktreeStatus(place);
      const [checks, diagram, merge] = s.exists
        ? await Promise.all([
          laneChecks(place),
          (ctx.lanes?.branchDiagram ?? branchDiagram)(place).catch((err) => ({ note: `Branch diagram unavailable: ${err.message}` })),
          place.lane ? mergeReadiness(ctx, place).catch((err) => ({ show: true, canMerge: false, catchUp: false, disabledReason: err.message })) : null,
        ])
        : [{ lines: [], brief: [] }, null, null];
      return { lines: [...worktreeLines(place, s), ...checks.lines], summary: laneSummary(place, s, checks.brief), review: !!(s.ahead || s.treeDirty),
        diagram, merge,
        pending: { lane: place.lane ?? null, branch: place.branch, ahead: s.ahead || 0, dirty: !!s.treeDirty, conflicts: s.conflicts ?? [] } };
    })());
    return seen.get(place.path);
  };
  try {
    const mine = await of(own);
    const lines = [...mine.lines], lanes = [{ ...mine, own: true }];
    if (!seen.has('lanes')) seen.set('lanes', existingLanes(ctx));
    const existing = await seen.get('lanes');
    for (const other of existing) {
      if (other.path === own.path) continue;
      const o = await of(other);
      if (o.review) { lines.push(...o.lines); lanes.push(o); }
    }
    if (!seen.has('discardable')) {
      seen.set('discardable', (async () => {
        const branchRefs = await git(own.top, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/worker/').catch(() => '');
        const fromBranches = branchRefs.split('\n').filter(Boolean).map((r) => r.slice('worker/'.length)).filter((n) => n && n !== 'main');
        const fromWorktrees = existing.map((l) => l.lane).filter(Boolean);
        const candidates = [...new Set([...fromWorktrees, ...fromBranches])].sort();
        const out = [];
        for (const n of candidates) {
          const p = await workerPlace(own.root, n);
          if (p.disabled) continue;
          const st = await checkLaneCleanMerged(p).catch(() => null);
          if (st?.exists && (st.ahead > 0 || st.dirty)) out.push(n);
        }
        return out;
      })());
    }
    if (!seen.has('merged')) {
      seen.set('merged', (async () => {
        const out = await git(own.top, 'log', '--format=%s', 'HEAD').catch(() => '');
        const names = new Set();
        for (const line of out.split('\n')) {
          const m = /^\[([0-9]{4}-[0-9]{2}-[0-9]{2}-[^\]]+)\]/.exec(line.trim());
          if (m) names.add(m[1]);
        }
        return [...names].sort();
      })());
    }
    const mergeable = {};
    for (const l of lanes) {
      if (l.pending?.lane && l.merge?.show) {
        mergeable[l.pending.lane] = {
          canMerge: !!l.merge.canMerge,
          catchUp: !!l.merge.catchUp,
          disabledReason: l.merge.disabledReason ?? null,
          targetBranch: l.merge.targetBranch ?? null,
          behind: l.merge.behind ?? 0,
        };
      }
    }
    return { lines, lanes: lanes.map(({ lines, summary, own, diagram }) => ({ lines, summary, own: !!own, ...(diagram && { diagram }) })),
      pending: lanes.filter((l) => l.review).map((l) => l.pending),
      discardable: await seen.get('discardable'),
      mergeable,
      merged: await seen.get('merged') };
  } catch (err) { return { lines: [`✗ ${err.message}`], error: true }; }
}

async function worktreeFingerprint(place) {
  const head = await git(place.path, 'rev-parse', 'HEAD');
  const { snapshot } = await collectWorktreeSnapshot(place, head, existsSync(place.path), { includeIgnored: false });
  return snapshot;
}
// The worker's last "Tested: <branch commit> with main <main commit>: tests passed|failed" line, if
// Git agrees: the branch commit is on its branch, it contains the main commit, which is main's.
async function recordTested(ctx, place, text, owner, label) {
  const m = [...String(text).matchAll(/^Tested: ([0-9a-f]{7,64}) with (?:main|\S+) ([0-9a-f]{7,64}): tests (passed|failed)\.?[ \t]*$/gm)].at(-1);
  if (!m) return;
  try {
    const main = await mainRef(place.top);
    const id = (ref) => git(place.path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`).catch(() => { throw new Error(`${ref} is not a commit here`); });
    const [branch, mainId] = [await id(m[1]), await id(m[2])];
    if (!await gitOk(place.path, 'merge-base', '--is-ancestor', branch, 'HEAD')) throw new Error(`${m[1].slice(0, 7)} is not on ${place.branch}`);
    if (!await gitOk(place.path, 'merge-base', '--is-ancestor', mainId, branch)) throw new Error(`${m[1].slice(0, 7)} doesn't contain ${m[2].slice(0, 7)}`);
    const onMain = await gitOk(place.path, 'merge-base', '--is-ancestor', mainId, main);
    const onRoomHead = onMain || await gitOk(place.top, 'merge-base', '--is-ancestor', mainId, 'HEAD');
    if (!onRoomHead) throw new Error(`${m[2].slice(0, 7)} is not a commit of ${main}`);
    const file = await testedFile(place);
    writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, branch, main: mainId, result: m[3], at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) { workNote(ctx, `✗ The worker's "Tested:" line was not recorded: ${err.message}.`, true, label, owner); }
}

return { discardPreview, closeAndDiscard, mergeReadiness, closeMergePreview, catchUpWithBranch,
  closeAndMerge, refreshWorker, laneOf, cleanupMergedOnClose, worktreeFingerprint, recordTested };
}
