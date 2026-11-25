// Branch diagrams for worker lanes. Loaded with the room's Reload version.
import { execFile } from 'node:child_process';
const git = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out.trim()))));
const gitOk = (dir, ...args) => git(dir, ...args).then(() => true, () => false);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

