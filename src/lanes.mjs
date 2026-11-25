// Branch diagrams for worker lanes. Loaded with the room's Reload version.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
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

