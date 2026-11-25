// Board lifecycle and checkpoint persistence, bound to the current room code on Reload.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

export function createBoards({
  day, hhmm, pad, slug, SCHEDULE_TIME_RE, readSchedule, siblings, multi, fresh, ownerOf, originLabel,
  baseKey, roomPath, roomDefaults, parseSpec, specFor, load, wire, note, out, red, dim, bold, log,
  toScreen, showHeader, runRound, refreshWorker, laneOf, lanePlace, workerPlace, workerHold, WORKER_BRANCH,
  worktreeStatus, git, gitOk, labelledCommits, plural, shopOf, laneState, lanesOf, runningTasks, queuedTasks,
  workNote, queueWork, pump, leftovers, autoDevInput, cleanupMergedOnClose, refreshQuota, pushReplica,
  recoverWorkerOwner, startThinking, stopThinking, setScreenThinking, when, describe, writeSchedule,
  broadcastSchedule, pageOf, mainRef, modelLabel, currentSettings, saveClosed,
}) {
const SECTIONS = ['archive', 'deferred'];
const DATED = /^\d{4}-\d{2}-\d{2}-/;

// A brainstorm is a folder in <root>/brainstorms/ (or brainstorms/archive/, brainstorms/deferred/),
// named as a discussion is (never the name of one in discussions/, archive/ or deferred/, nor the
// other way round), holding transcripts/ and, if agents draw, drawings/. Its checkpoint key is
// "brainstorms/<name>" in every section (a discussion's is its name). Turn into a discussion moves
// an active brainstorm to discussions/.
const BRAINSTORMS = 'brainstorms';
const WORKBENCH_MARKER = '.workbench';
const isWorkbenchDir = (dir) => !!dir && existsSync(join(dir, WORKBENCH_MARKER));
function isWorkbenchName(ctx, name) {
  if (!name || !DATED.test(name)) return false;
  const parent = join(ctx.cwd, 'discussions');
  return [parent, ...SECTIONS.map((s) => join(parent, s))].some((dir) => isWorkbenchDir(join(dir, name)));
}
function workbenchNames(ctx) {
  const parent = join(ctx.cwd, 'discussions');
  if (!existsSync(parent)) return [];
  const names = [];
  for (const dir of [parent, ...SECTIONS.map((s) => join(parent, s))]) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && DATED.test(e.name) && isWorkbenchDir(join(dir, e.name))) names.push(e.name);
    }
  }
  return names;
}
const RESEARCH_MARKER = '.research';
const isResearchDir = (dir) => !!dir && existsSync(join(dir, RESEARCH_MARKER));
function researchNames(ctx) {
  const parent = join(ctx.cwd, 'discussions');
  if (!existsSync(parent)) return [];
  const names = [];
  for (const dir of [parent, ...SECTIONS.map((s) => join(parent, s))]) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && DATED.test(e.name) && isResearchDir(join(dir, e.name))) names.push(e.name);
    }
  }
  return names;
}
// Lap data belongs to the board, so it survives fresh sessions, close, and archive moves.
const RESEARCH_STATS = '.research-stats.json';
function readResearchStats(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, RESEARCH_STATS), 'utf8'));
    return { laps: Number.isSafeInteger(data.laps) && data.laps >= 0 ? data.laps : 0,
      lastRun: typeof data.lastRun === 'string' ? data.lastRun : null, priorUnknown: !!data.priorUnknown };
  } catch {
    const transcripts = join(dir, 'transcripts');
    return { laps: 0, lastRun: null, priorUnknown: existsSync(transcripts) && readdirSync(transcripts).some((name) => name.endsWith('.md')) };
  }
}
function recordResearchLap(ctx, lap) {
  const dir = ctx.discussion.dir, file = join(dir, RESEARCH_STATS), stats = readResearchStats(dir);
  if (!existsSync(file) && !ctx.discussion.continued) stats.priorUnknown = false;
  stats.laps++;
  if (lap === 0) stats.lastRun = new Date().toISOString();
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(stats) + '\n');
    renameSync(temp, file);
  } catch (err) {
    note(ctx, `✗ Couldn't save research lap count: ${err.message}`, true);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
  showHeader(ctx);
}
function researchStats(ctx, now = new Date()) {
  const parent = join(ctx.cwd, 'discussions'), result = {};
  const tasks = readSchedule(ctx).tasks;
  for (const section of [null, ...SECTIONS]) {
    const dir = section ? join(parent, section) : parent;
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !DATED.test(e.name) || !isResearchDir(join(dir, e.name))) continue;
      const stats = readResearchStats(join(dir, e.name));
      const next = tasks.filter((t) => t.kind === 'recurring' && t.board === e.name && t.enabled && SCHEDULE_TIME_RE.test(t.time))
        .map((t) => {
          const [hours, minutes] = t.time.split(':').map(Number);
          const candidate = new Date(now); candidate.setHours(hours, minutes, 0, 0);
          const trigger = `${day(candidate)} ${t.time}`;
          if (candidate.getTime() + 60_000 <= now.getTime() || (candidate <= now && t.lastTriggerKey === trigger)) candidate.setDate(candidate.getDate() + 1);
          return candidate;
        }).sort((a, b) => a - b)[0];
      result[e.name] = { ...stats, nextRun: next?.toISOString() ?? null };
    }
  }
  return result;
}
const brainstormRef = (ref) => /^brainstorms\/([^/\\]+)$/.exec(ref ?? '')?.[1] ?? null;
function brainstormDirRef(parent, ref) {
  if (!ref?.startsWith(`${BRAINSTORMS}/`)) return null;
  const d = discussionRef(parent, ref.slice(BRAINSTORMS.length + 1));
  return d ? { ...d, key: `${BRAINSTORMS}/${d.name}` } : null;
}
const isBrainstorm = (c, name) => !!c.state?.brainstorm && c.discussion?.name === name;
const isDiscussion = (c, name) => !c.state?.brainstorm && c.discussion?.name === name;
// Its folder under the root ("discussions/<name>" or "brainstorms/<name>"), its checkpoint key and
// its ref in commands, once it has a name; null before.
const folderOf = (ctx) => (ctx.discussion ? `${ctx.state?.brainstorm ? BRAINSTORMS : 'discussions'}/${ctx.discussion.name}` : null);
const keyOf = (ctx) => (ctx.state?.brainstorm ? `${BRAINSTORMS}/${ctx.discussion.name}` : ctx.discussion.name);
// Where a new discussion's or brainstorm's name must also be free: the other kind's folders.
const takenElsewhere = (cwd, brainstorm) => {
  const other = join(cwd, brainstorm ? 'discussions' : BRAINSTORMS);
  return [other, ...SECTIONS.map((s) => join(other, s))];
};

// A discussion named by the User or the page: "<date>-<title>" (active) or "archive/<date>-<title>" /
// "deferred/<date>-<title>". Resolves to { section: null | 'archive' | 'deferred', name } or null.
function discussionRef(parent, ref) {
  const parts = ref.split('/');
  const [section, name] = parts.length === 2 ? parts : [null, parts[0]];
  if (parts.length > 2 || (section && !SECTIONS.includes(section)) || !DATED.test(name ?? '') || /[\\]/.test(name)) return null;
  return existsSync(join(parent, section ?? '', name)) ? { section, name } : null;
}

// /move <discussion|brainstorms/...> active|archive|deferred: the whole folder moves (documents and transcripts).
// Not the discussion this session is using (its transcript is open there), and never an open brainstorm.
async function moveDiscussion(ctx, ref, to, { rollbackConfirmed = false } = {}) {
  if (ref?.startsWith(`${BRAINSTORMS}/`)) return moveBrainstorm(ctx, ref, to);
  const parent = join(ctx.cwd, 'discussions');
  const d = discussionRef(parent, ref ?? '');
  if (!d) return note(ctx, `✗ No discussion "${ref}" in ${parent}.`, true), null;
  if (shopOf(ctx).closing?.has(d.name)) return note(ctx, `✗ ${d.name} is closing.`, true), null;
  const target = to === 'active' ? null : to;
  if (to !== 'active' && !SECTIONS.includes(to)) return note(ctx, '✗ Move it to active, archive or deferred.', true), null;
  if (d.section === target) return { name: d.name }; // already there
  if (target && !closedDiscussions(ctx).includes(d.name)) return note(ctx, `✗ ${d.name} must be closed before it can be moved to ${target}/.`, true), null;
  await recoverWorkerOwner(ctx);
  const from = join(parent, d.section ?? '', d.name);
  if (ctx.discussion?.dir === from) return note(ctx, `✗ ${d.name} is the discussion in use in this room: it can't move now.`, true), null;
  const shop = shopOf(ctx);
  if (target === 'archive' && shop.rollbacks?.has(d.name) && !rollbackConfirmed)
    return note(ctx, '✗ Review the rollback report and use its explicit archive confirmation; the discussion has not been archived.', true), null;
  if (target === 'deferred') {
    // Its own branch: any commit not in main. worker/main (shared before lanes): its labelled ones.
    const place = await lanePlace(ctx, null);
    if (!place.disabled) {
      try {
        const own = await workerPlace(ctx.cwd, d.name);
        if (!own.disabled && await gitOk(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${own.branch}`)) {
          const pending = (await git(place.top, 'rev-list', '--reverse', `main..${own.branch}`)).split('\n').filter(Boolean);
          if (pending.length) return note(ctx, `✗ ${d.name} can't be deferred: commits on ${own.branch} are not merged into main: ${pending.join(', ')}.`, true), null;
        }
        if (await gitOk(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${WORKER_BRANCH}`)) {
          const pending = (await labelledCommits(place.top, `main..${WORKER_BRANCH}`)).filter((c) => c.origin === d.name);
          if (pending.length) return note(ctx, `✗ ${d.name} can't be deferred: commits on worker/main are not merged into main: ${pending.map((c) => c.id).join(', ')}.`, true), null;
        }
      } catch (err) { return note(ctx, `✗ Can't check unmerged commits: ${err.message}`, true), null; }
    }
  }
  if (shop.writing?.has(from)) return note(ctx, `✗ A worker task is still writing to ${d.name}; try again when it finishes.`, true), null;
  // Open in another context of this folder: it can move between its rounds, unless it holds worker edits.
  const open = siblings(ctx).find((c) => c !== ctx && c.discussion?.dir === from);
  if (open && workerHold(open)) return note(ctx, `✗ ${d.name} can't move: ${workerHold(open)}.`, true), null;
  if (!open && lanesOf(shop).some((l) => l.blockedBy?.label === d.name)) return note(ctx, `✗ ${d.name} can't move: its worker edits are unresolved.`, true), null;
  if (open?.busy) return note(ctx, `✗ ${d.name} is in the middle of a round; try again when it ends.`, true), null;
  const dest = join(parent, target ?? '', d.name);
  if (existsSync(dest)) return note(ctx, `✗ There is already a discussion ${d.name} in ${target ?? 'discussions'}/.`, true), null;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(from, dest);
  if (open) {
    // Its session follows: its folder and transcript paths, and its agents are told.
    open.discussion.dir = dest;
    if (open.logPath?.startsWith(from + sep)) open.logPath = dest + open.logPath.slice(from.length);
    const moved = { speaker: 'agent-room', text: `This discussion's folder moved to ${dest}: use that path from now on.` };
    open.state.transcript.push(moved);
    log(open, `**${moved.speaker}**\n\n${moved.text}\n\n`);
    toScreen(open, { type: 'message', message: open.docs.messageView(moved) });
    showHeader(open);
  }
  const rel = (section) => ['discussions', ...(section ? [section] : []), d.name].join('/');
  // A page showing a file in it follows the move.
  if (ctx.screen.doc?.startsWith(rel(d.section) + '/')) {
    ctx.screen.doc = rel(target) + ctx.screen.doc.slice(rel(d.section).length);
    toScreen(ctx, { type: 'doc', file: ctx.screen.doc });
  }
  toScreen(ctx, { type: 'moved', from: rel(d.section), to: rel(target) });
  log(ctx, `_(moved the discussion ${d.name} to ${target ?? 'active'})_\n\n`);
  note(ctx, `Moved the discussion ${d.name} to ${target ? `${target}/` : 'the active discussions'}.`);
  return { name: d.name };
}

// /move brainstorms/<name>|brainstorms/archive/<name>|brainstorms/deferred/<name> active|archive|deferred:
// moves the whole brainstorm folder. Refuses while open or on screen, and never overwrites an existing folder.
// The checkpoint stays under its key "brainstorms/<name>".
function moveBrainstorm(ctx, ref, to) {
  const parent = join(ctx.cwd, BRAINSTORMS);
  const b = brainstormDirRef(parent, ref ?? '');
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${parent}.`, true), null;
  const target = to === 'active' ? null : to;
  if (to !== 'active' && !SECTIONS.includes(to)) return note(ctx, '✗ Move it to active, archive or deferred.', true), null;
  if (b.section === target) return { name: b.name };
  const from = join(parent, b.section ?? '', b.name);
  if (ctx.discussion?.dir === from || siblings(ctx).some((c) => !c.stopped && (c.discussion?.dir === from || isBrainstorm(c, b.name))))
    return note(ctx, `✗ ${b.name} is open: close it before moving it.`, true), null;
  const dest = join(parent, target ?? '', b.name);
  if (existsSync(dest)) return note(ctx, `✗ There is already a brainstorm ${b.name} in ${target ?? BRAINSTORMS}/.`, true), null;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(from, dest);
  const rel = (section) => [BRAINSTORMS, ...(section ? [section] : []), b.name].join('/');
  const fromRel = rel(b.section), toRel = rel(target);
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    if (c.screen.doc?.startsWith(fromRel + '/')) {
      c.screen.doc = toRel + c.screen.doc.slice(fromRel.length);
      toScreen(c, { type: 'doc', file: c.screen.doc });
    }
    if (c.screen.peek?.path === fromRel) {
      c.screen.peek = {
        ...c.screen.peek,
        ref: toRel,
        path: toRel,
        doc: c.screen.peek.doc?.startsWith(fromRel + '/') ? toRel + c.screen.peek.doc.slice(fromRel.length) : c.screen.peek.doc,
      };
      toScreen(c, c.docs.resetEvent(c.screen));
    }
    toScreen(c, { type: 'moved', from: fromRel, to: toRel });
  }
  log(ctx, `_(moved the brainstorm ${b.name} to ${target ?? 'active'})_\n\n`);
  note(ctx, `Moved the brainstorm ${b.name} to ${target ? `${target}/` : 'the active brainstorms'}.`);
  return { name: b.name };
}

// Rollback is an ordinary, origin-labelled worker task. Git reasoning and changes stay with
// the worker; only the User's later, explicit command may move the discussion into archive/.
function rollbackTask(name) {
  return `Archive with rollback for [${name}]. Work only on worker/${name}, this discussion's own branch; never merge into main or push, reset, rebase or clean the worktree.
Before changing any file (including a preliminary merge), inspect the complete history of worker/${name}, main and worker/main (the branch every discussion shared before each had its own: older [${name}] commits may be there), commit messages, parents and diffs. Find this discussion's [${name}]-labelled implementation commits, INCLUDING those already merged into main (do not restrict the search to main..worker/${name}).
Distinguish implementation commits from catch-up merges and earlier rollback/revert commits. Inspect Agent-Room-Rollback-Origin and Agent-Room-Reverted trailers, standard "This reverts commit" records, and any later reverts of those reverts. Exclude catch-up merges, earlier rollback commits, and implementation changes already undone: never revert a rollback and restore changes already removed. Do not infer the set from labels alone. If the intended set or an earlier rollback's coverage is unclear, stop and report the ambiguity BEFORE changing any file. Do not guess a merge mainline.
Identify later work by other origins that may depend on the changes, in main and in other discussions' unmerged branches (git branch --list 'worker/*'), using history, overlapping files and affected symbols/callers; report the origins, commit IDs and dependency evidence. A clean revert or passing tests do not prove there are no semantic dependencies. If dependencies make a safe rollback unclear, stop and report before changing files.
Once the set is clear, if main has commits worker/${name} lacks and the worktree has no unresolved edits or Git operation, first merge main into worker/${name} with a normal merge. Label any merge commit [${name}] catch up with main. If it clashes, do not force it or continue the rollback: leave the state intact and report the conflict for recovery by this origin. Recheck the intended set after the merge; report any new ambiguity before reverting.
Revert the intended implementation commits newest first. If a revert conflicts, stop and report it; do not force or silently abandon changes. Run npm test and read its real output. Commit the rollback on worker/${name} with a message starting "[${name}] rollback" and the trailer "Agent-Room-Rollback-Origin: ${name}", plus one "Agent-Room-Reverted: <full implementation commit ID>" trailer per commit undone. If everything was already undone, do not restore it: explain that and make a labelled empty rollback commit with the origin trailer and no reverted IDs.
Report the commit ID, the exact set undone or already undone, npm test's real output, dependencies found on other origins' work and what you could not check. Only if rollback and tests succeeded and the worktree is clean with no Git operation in progress, end the report with "Rollback ready: <full rollback commit ID>". Otherwise omit that line. Do not archive the discussion: the User must review this report and explicitly confirm archiving; the User retains the final merge into main.`;
}
async function requestRollback(ctx, ref) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), ref);
  if (!d || d.section === 'archive') return note(ctx, '✗ Choose a local discussion outside archive/ for rollback.', true);
  let origin = siblings(ctx).find((c) => c.discussion?.name === d.name);
  if (!origin) {
    if (!multi(ctx)) return note(ctx, '✗ Resume that discussion before requesting rollback in terminal mode.', true);
    origin = await openBeside(ctx);
    try { await resumeDiscussion(origin, ref); } catch (err) { closeContext(origin); throw err; }
    if (fresh(origin)) return closeContext(origin); // it couldn't open there (its note says why)
  }
  if (origin.stopped || origin.screen.workerInfo?.disabled)
    return note(ctx, '✗ This discussion\'s worker must be enabled before requesting rollback.', true);
  const shop = shopOf(origin), rollbacks = shop.rollbacks ??= new Map();
  if (['queued', 'running'].includes(rollbacks.get(d.name)?.status)) return note(ctx, 'Rollback is already queued or running.');
  autoDevInput(origin, 'you requested archive with rollback');
  const task = rollbackTask(d.name);
  const rollback = { name: d.name, task, status: 'queued', report: null, commit: null };
  rollbacks.set(d.name, rollback);
  queueWork(origin, task, null, rollback);
  showHeader(origin);
  note(ctx, `Rollback queued for [${d.name}]. Review its Worker report before confirming archive.`);
}
async function confirmRollbackArchive(ctx, ref) {
  const shop = shopOf(ctx);
  const d = discussionRef(join(ctx.cwd, 'discussions'), ref);
  const rollback = d && shop.rollbacks?.get(d.name);
  if (!rollback || rollback.status !== 'ready') return note(ctx, '✗ No successful rollback report awaiting archive confirmation.', true);
  const lane = laneState(shop, d.name); // its own lane, where its rollback ran
  if (lane.running || lane.tasks.length || lane.pumping || shop.confirming)
    return note(ctx, '✗ Wait for this discussion\'s worker queue to be idle before confirming archive.', true);
  shop.confirming = true;
  try {
    const place = await lanePlace(ctx, d.name); // the discussion's own lane, where its rollback ran
    if (place.disabled || await leftovers(ctx, place) !== false || await git(place.path, 'rev-parse', 'HEAD') !== rollback.commit)
      return note(ctx, '✗ The worker state changed since the rollback report. Resolve it and request a fresh rollback report before archiving.', true);
    if (await moveDiscussion(ctx, ref, 'archive', { rollbackConfirmed: true })) {
      shop.rollbacks.delete(d.name);
      showHeader(ctx);
    }
  } finally { shop.confirming = false; pump(shop).catch((err) => note(ctx, `✗ ${err.message}`, true)); }
}

async function rollbackReport(ctx, rollback, entry, left = null) {
  rollback.report = entry.text;
  rollback.status = 'needs review';
  rollback.commit = null;
  const match = /^Rollback ready: ([0-9a-f]{40,64})$/.exec(entry.text.trim().split('\n').at(-1));
  const place = await lanePlace(ctx, rollback.name);
  if (!entry.error && match && await leftovers(ctx, place) === false) {
    const dir = place.path, id = match[1];
    const body = await git(dir, 'show', '-s', '--format=%B', id).catch(() => '');
    if (await git(dir, 'rev-parse', 'HEAD') === id && body.startsWith(`[${rollback.name}] rollback`) &&
        body.split('\n').includes(`Agent-Room-Rollback-Origin: ${rollback.name}`)) {
      rollback.commit = id;
      rollback.status = 'ready';
    }
  }
  // It is a report, not a new round: the User decides whether to archive.
  // In its own discussion: the one in use, or, left meanwhile, that session's transcript.
  const m = { speaker: 'Worker rollback report', text: entry.text };
  if (left) { if (left.logPath) try { appendFileSync(left.logPath, `**${m.speaker}**\n\n${m.text}\n\n`); } catch {} }
  else {
    ctx.state.transcript.push(m);
    log(ctx, `**${m.speaker}**\n\n${m.text}\n\n`);
    toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) });
  }
  note(ctx, rollback.status === 'ready'
    ? `Review the rollback report for [${rollback.name}]; then confirm archive in Explorer (switch away from it first), or /archive-rollback ${rollback.name}. Main is still yours to merge.`
    : `Rollback for [${rollback.name}] needs review: no verified successful report yet; archiving was not done.`);
  showHeader(ctx);
}

// Creates the folder (and discussions/ if needed) and returns its name. mkdir itself is the check
// that the name is free, so two rooms naming a discussion at once can't both get it. `elsewhere`:
// folders whose names it must not take either (a brainstorm's and a discussion's, see takenElsewhere).
function createDiscussionFolder(parent, title, now = new Date(), elsewhere = []) {
  const base = `${day(now)}-${(title && slug(title)) || hhmm(now)}`;
  mkdirSync(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (SECTIONS.some((s) => existsSync(join(parent, s, name)))) continue; // taken by an archived or deferred one
    if (elsewhere.some((dir) => existsSync(join(dir, name)))) continue;
    try { mkdirSync(join(parent, name)); return name; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}

// The session's transcript, transcripts/session-<date>-<time>.md (-2, -3… if taken), created with
// `text` in it. Returns its path.
function createSessionFile(dir, text, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const path = join(dir, `session-${day(now)}-${hhmm(now)}${n === 1 ? '' : `-${n}`}.md`);
    try { writeFileSync(path, text, { flag: 'wx' }); return path; } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}

// The first message of the session, before the agents see it: for a new discussion, a title from
// Claude (no tools) and the folder named after it; then the transcript, holding everything said
// so far. Returns false (the message is not sent) if the folder or transcript can't be created.
async function openDiscussion(ctx, line) {
  const now = new Date();
  const brainstorm = !!ctx.state.brainstorm, workbench = !!ctx.state.workbench, research = !!ctx.state.research;
  const kind = brainstorm ? 'brainstorm' : workbench ? 'workbench' : research ? 'research board' : 'discussion';
  const kindCap = kind[0].toUpperCase() + kind.slice(1);
  try {
    if (!ctx.discussion) {
      const label = `Claude (choosing the ${kind}'s title)`;
      startThinking(ctx, label);
      setScreenThinking(ctx, label);
      const t0 = Date.now();
      let title = null;
      let how;
      try {
        const got = await ctx.suggestTitle(line, { cwd: tmpdir() });
        title = got.title;
        how = `_(title by Claude, ${Math.round((Date.now() - t0) / 1000)}s${got.usage ? ` · ${ctx.usage.formatUsage(got.usage)}` : ''}: ${title})_\n\n`;
      } catch (err) {
        how = `_(no title, so the folder is named after the date and time: ${err.message})_\n\n`;
      } finally {
        stopThinking(ctx);
        setScreenThinking(ctx, null);
      }
      const parent = join(ctx.cwd, brainstorm ? BRAINSTORMS : 'discussions');
      const name = createDiscussionFolder(parent, title, now, takenElsewhere(ctx.cwd, brainstorm));
      const dir = join(parent, name);
      if (workbench) writeFileSync(join(dir, WORKBENCH_MARKER), 'workbench\n');
      if (research) writeFileSync(join(dir, RESEARCH_MARKER), 'research\n');
      ctx.discussion = { name, dir, title: title ?? `${kindCap} — ${when(now)}`, continued: false };
      log(ctx, how);
    }
    const { title, dir } = ctx.discussion;
    const head = `# ${title} — session of ${when(now)}\n\nRoom: ${describe(ctx.room)} · worker ${ctx.worker.name}\n\nRoot: ${ctx.cwd}\n\n`;
    ctx.logPath = createSessionFile(join(dir, 'transcripts'), head + (ctx.pendingLog ?? ''), now);
    ctx.pendingLog = '';
    ctx.previous = null; // the "← back to …" link lasts until this discussion starts
  } catch (err) {
    note(ctx, `✗ Couldn't create the ${kind}'s folder or transcript: ${err.message}\nYour message was not sent${workbench ? ' to the worker' : ' to the agents'}. Here it is, to send again:\n\n${line}\n`, true);
    return false;
  }
  ctx.state.briefing = workbench ? null : briefing(ctx);
  out(ctx, `${kindCap}: ${ctx.discussion.dir}\nTranscript: ${ctx.logPath}`);
  if (workbench) captureRound(ctx);
  else showHeader(ctx);
  return true;
}

// Given to each agent with its first prompt.
function briefing(ctx) {
  const { dir, continued } = ctx.discussion;
  // Start fresh: its checkpoint's latest summary, marked if it wasn't agreed (see startFresh).
  const s = continued ? ctx.freshSummary : null;
  const summary = !s ? '' : `\n\nThe latest summary from the previous session (${s.outcome === 'agreed' ? `agreed, by ${s.by}` : `**not agreed**: the last version, by ${s.by}; treat its points as proposals`}):\n\n${s.text}`;
  if (ctx.state.brainstorm) {
    const rules = `This is a brainstorm, not a discussion. Its folder is ${dir}: write nothing except drawings, in ${join(dir, 'drawings')}/. `
      + `You may read the project in the room's root, ${ctx.cwd}.`;
    if (!continued) return rules;
    // A fresh start with no summary: its saved transcripts are the record to read first.
    const transcripts = `${join(dir, 'transcripts')}/`;
    return `${rules} This session continues the brainstorm from an earlier one. ` + (s
      ? `Its earlier sessions' transcripts, in ${transcripts}, are the source: this summary of them may omit details.${summary}`
      : `Before replying, read its earlier sessions' transcripts in ${transcripts}: the transcripts are the source, and a summary of them may omit details.`);
  }
  if (ctx.state.research) {
    if (continued) {
      if (ctx.discussion.fromBrainstorm) {
        const transcripts = `${join(dir, 'transcripts')}/`;
        return `This research board was turned from a brainstorm. Its folder is ${dir}: create, read and write this board's documents (quest.md, learnings.md, drawings) there. `
          + `The room's root, ${ctx.cwd}, holds the work itself. `
          + `Before replying, read its earlier brainstorm transcripts in ${transcripts}`
          + (s ? ` (the transcripts are the source; this summary of them may omit details):${summary}` : '.');
      }
      if (existsSync(join(dir, 'closing-statement.md'))) {
        const text = readFileSync(join(dir, 'closing-statement.md'), 'utf8');
        return `This session continues the research board in ${dir}: create, read and write this board's documents (quest.md, learnings.md, drawings) there. Start from its closing statement:\n\n${text}${summary}`;
      }
      return `This session continues the research board in ${dir}: create, read and write this board's documents (quest.md, learnings.md, drawings) there. Read its quest.md, learnings.md and transcripts/ folder.${summary}`;
    }
    return `This is a new research board. Its folder is ${dir}: create, read and write this board's documents (quest.md, learnings.md, drawings) there. `
      + `The room's root, ${ctx.cwd}, holds the work itself.`;
  }
  if (continued) {
    if (ctx.discussion.fromResearch) {
      return `This discussion was turned from a research board. Its folder is ${dir}: create, read and write this discussion's documents there. `
        + `Before replying, read its research notes and earlier transcripts in ${join(dir, 'transcripts')}/${s ? ` (the transcripts are the source; this summary may omit details):${summary}` : '.'}`;
    }
    if (existsSync(join(dir, 'closing-statement.md'))) {
      const text = readFileSync(join(dir, 'closing-statement.md'), 'utf8');
      return `This session continues the discussion in ${dir}: create, read and write this discussion's documents (notes, drawings) there. Start from its closing statement:\n\n${text}${summary}`;
    }
    return `This session continues the discussion in ${dir}: create, read and write this discussion's documents (notes, drawings) there. Start from its handoff `
      + '(see "Where to start reading" in your rulebook); you can also read its notes and its transcripts/ folder.' + summary;
  }
  return `This is a new discussion. Its folder is ${dir}: create, read and write this discussion's documents (notes, drawings) there. `
    + `The room's root, ${ctx.cwd}, holds the work itself.`;
}

// ── Checkpoints ───────────────────────────────────────────────────────
// Every discussion saves itself, on this machine: after each round (with or without its summary) and
// each /summary, after each worker task, when its session ends and when its room stops. A
// checkpoint holds what Resume needs to continue it: the provider session IDs of its agents and its
// worker, its chat and unread positions, its transcript path and the shown document. Its
// discussion part is the copy taken at the end of the latest round (ctx.lastRound), when it is
// consistent; its worker part is current. Start fresh leaves a small one instead (fresh: true),
// holding only the summary its fresh session is briefed with, until that session's first round.
// Local application data, never in the discussion's replicated files. The folder keeps its former
// name, paused/: checkpoints saved by the former Pause are read as they are.
const checkpointDirectory = (ctx) => join(homedir(), '.local', 'state', 'agent-room', 'paused',
  createHash('sha256').update(realpathSync(ctx.cwd)).digest('hex'));
const checkpointFile = (ctx, name) => join(checkpointDirectory(ctx), createHash('sha256').update(name).digest('hex') + '.json');
// Explicit closes are local lifecycle state, separate from checkpoints (which keep changing as
// detached worker tasks finish). Missing markers, including discussions from older versions, mean paused.
const closedDirectory = (ctx) => join(checkpointDirectory(ctx), 'closed');
const closedFile = (ctx, name) => join(closedDirectory(ctx), createHash('sha256').update(name).digest('hex'));
function closedEntries(ctx) {
  const dir = closedDirectory(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-f0-9]{64}$/.test(f)).flatMap((f) => {
    try {
      const text = readFileSync(join(dir, f), 'utf8');
      return [text.startsWith('{') ? JSON.parse(text) : { name: text }];
    } catch { return []; }
  });
}
const closedDiscussions = (ctx) => closedEntries(ctx).map((entry) => entry.name);
function setClosed(ctx, name, closed, snapshot = null) {
  const file = closedFile(ctx, name);
  if (closed) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, snapshot ? JSON.stringify({ name, snapshot: { discussion: snapshot.discussion, commit: snapshot.commit, parent: snapshot.parent } }) : name, { mode: 0o600 });
      renameSync(temp, file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  } else {
    try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
const listedCheckpoints = new Map(); // file → { stamp, entry }: the header lists them often
// [{ name, at, kind: 'full' | 'fresh', title }], for the page's Resume tooltips and row titles.
// A brainstorm's name is its key, "brainstorms/<name>".
function checkpoints(ctx) {
  const dir = checkpointDirectory(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    const file = join(dir, f);
    try {
      const { mtimeMs, size } = statSync(file), stamp = `${mtimeMs}:${size}`;
      const had = listedCheckpoints.get(file);
      if (had?.stamp === stamp) return had.entry;
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const entry = saved.version === 1 && saved.root === realpathSync(ctx.cwd) && typeof saved.discussion?.name === 'string'
        ? [{ name: (saved.brainstorm ? `${BRAINSTORMS}/` : '') + saved.discussion.name, at: saved.at, kind: saved.fresh ? 'fresh' : 'full',
          ...(saved.fresh && { summary: !!saved.summary }),
          title: typeof saved.discussion.title === 'string' ? saved.discussion.title : saved.discussion.name }] : [];
      listedCheckpoints.set(file, { stamp, entry });
      return entry;
    } catch { return []; }
  });
}
function writeCheckpoint(ctx, name, data) {
  const file = checkpointFile(ctx, name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    renameSync(temp, file); // replaces the previous one at once
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function readCheckpoint(ctx, name) {
  const file = checkpointFile(ctx, name);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { invalid: true }; }
}
const logSize = (ctx) => { try { return statSync(ctx.logPath).size; } catch { return undefined; } };
// A started discussion or brainstorm, with its agents' and worker's specs (a room built by hand,
// without them, couldn't be resumed).
const saveable = (ctx) => !!ctx.discussion && !!ctx.logPath && !!ctx.agentSpecs && !!ctx.workerSpec;
// At the end of a round, and of /summary: the discussion part, copied, then saved.
function captureRound(ctx) {
  if (!saveable(ctx)) { showHeader(ctx); return; }
  ctx.logBytes = logSize(ctx);
  const agents = new Set(ctx.room.agents.map((a) => a.name));
  ctx.lastRound = JSON.parse(JSON.stringify({
    sessions: [...ctx.sessions].filter(([key]) => agents.has(key)),
    state: { ...ctx.state, seen: [...ctx.state.seen] }, totals: ctx.totals ?? {}, doc: ctx.screen.doc ?? null,
  }));
  saveCheckpoint(ctx);
  showHeader(ctx);
}
// The latest round's copy and the worker's current session and briefing. Nothing before the first
// round of this session (or a Resume): until then the previous checkpoint stands. A brainstorm's has
// no worker part (it sends no work): brainstorm: true, under its key brainstorms/<name>.
function saveCheckpoint(ctx) {
  const d = ctx.discussion, r = ctx.lastRound;
  if (!r || !saveable(ctx)) return;
  const worker = `worker:${parseSpec(ctx.workerSpec, true).name}`;
  // The transcript's size goes with the chat: not while a round is writing lines the chat lacks.
  if (!ctx.busy || ctx.logBytes === undefined) ctx.logBytes = logSize(ctx);
  const base = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(), discussion: d, agentSpecs: ctx.agentSpecs };
  const rest = { state: r.state, logPath: ctx.logPath, totals: r.totals, doc: r.doc, logBytes: ctx.logBytes };
  try {
    writeCheckpoint(ctx, keyOf(ctx), ctx.state.brainstorm ? { ...base, brainstorm: true, sessions: r.sessions, ...rest } : {
      ...base, ...(ctx.state.workbench && { workbench: true }), ...(ctx.state.research && { research: true }), workerSpec: ctx.workerSpec,
      sessions: [...r.sessions, [worker, ctx.sessions.get(worker) ?? {}]], ...rest,
      worker: shopOf(ctx).log.filter((m) => m.origin === originLabel(ctx)),
      workerBriefed: ctx.workerBriefed ?? null, workerTree: ctx.workerTree ?? null,
      workerLabel: ctx.workerLabel ?? null, workerHandoff: !!ctx.workerHandoff, workerSeat: ctx.workerSeat ??= randomBytes(6).toString('hex'),
      work: workOf(shopOf(ctx), d.name),
    });
    ctx.checkpointError = null;
  } catch (err) {
    if (ctx.checkpointError !== err.message) note(ctx, `✗ Couldn't save this ${ctx.state.brainstorm ? 'brainstorm' : 'discussion'}'s checkpoint: ${err.message}. ${ctx.state.brainstorm ? 'Resume' : 'Continue'} would continue from an earlier one.`, true);
    ctx.checkpointError = err.message;
  }
}
// ── Work in flight (part of each checkpoint) ──
// The worker tasks a discussion queued, the one running, and those a stop or crash cut off, by
// discussion name, in the folder's workshop (shop.work), so a task keeps its own discussion's
// record even if its context moves on. Saved in that discussion's checkpoint at each change.
// A task is recorded when queued, and as running in runWork's first step, before anything else.
// Resume and Restart report what was interrupted or never started (reportWork).
const workOf = (shop, name) => {
  shop.work ??= new Map();
  if (!shop.work.has(name)) shop.work.set(name, { queued: [], running: null, interrupted: [], notStarted: [] });
  return shop.work.get(name);
};
function cleanWork(w) {
  const list = (x) => (Array.isArray(x) ? x.filter((r) => r && typeof r.task === 'string') : []);
  return { queued: list(w?.queued), running: w?.running && typeof w.running.task === 'string' ? w.running : null,
    interrupted: list(w?.interrupted), notStarted: list(w?.notStarted) };
}
// Saves a discussion's work record: through its open context when it has a round to save with,
// otherwise into its checkpoint file as it is (a closed or not yet started discussion). A named
// discussion with no checkpoint yet (before its first message, after Resume without one) gets a
// small one, as Start fresh leaves: it starts from the handoff, and holds only this record.
// Brainstorms have no name, so their tasks are never recorded.
function persistWork(ctx, name) {
  const shop = shopOf(ctx), w = workOf(shop, name);
  const owner = siblings(ctx).find((c) => isDiscussion(c, name) && c.lastRound && saveable(c));
  if (owner) return saveCheckpoint(owner);
  try {
    const saved = readCheckpoint(ctx, name);
    if (!saved) {
      writeCheckpoint(ctx, name, { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
        discussion: { name, title: name }, fresh: true, summary: null, work: w });
      showHeader(ctx); // Explorer's Resume tooltip follows
    }
    else if (!saved.invalid && saved.version === 1 && saved.root === realpathSync(ctx.cwd)) writeCheckpoint(ctx, name, { ...saved, work: w });
  } catch (err) { note(ctx, `✗ Couldn't save the worker task record of ${name}: ${err.message}`, true); }
}
// On Resume or Restart: a running task with no live run was interrupted; a queued one that is no
// longer queued was never started.
function restoreWork(ctx, name, saved) {
  const shop = shopOf(ctx);
  shop.work ??= new Map();
  if (!shop.work.has(name)) shop.work.set(name, cleanWork(saved));
  const w = shop.work.get(name);
  if (w.running && !runningTasks(shop).some((t) => t.record?.id === w.running.id)) { w.interrupted.push(w.running); w.running = null; }
  const live = (r) => queuedTasks(shop).some((t) => t.record?.id === r.id);
  w.notStarted.push(...w.queued.filter((r) => !live(r)));
  w.queued = w.queued.filter(live);
  return w;
}
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'at an unknown time' : `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const firstLine = (text) => { const l = String(text).trim().split('\n')[0]; return l.length > 120 ? l.slice(0, 117) + '…' : l; };
// What an interrupted task left in the worktree, as one line of a report. `stopped`: the User
// stopped it (Stop now) rather than Restart, Quit or a crash; `preparing`: before its worker started.
async function leftBehind(ctx, name, r, { stopped = false, preparing = false, place = null } = {}) {
  const what = `[${name}] "${firstLine(r.task)}" (started ${clock(r.at)})`;
  let s = null;
  try { place ??= await lanePlace(ctx, r.lane ?? null); if (!place.disabled) s = await worktreeStatus(place); } catch {}
  const found = !s ? 'it could not be inspected' : !s.exists ? 'it does not exist' : s.treeDirty ? 'it has uncommitted edits' : 'it is clean';
  let commits = null;
  if (r.before && s?.exists && !s.treeDirty) {
    try { commits = (await labelledCommits(place.path, `${r.before}..HEAD`)).filter((c) => c.origin === name); } catch { commits = null; }
  }
  if (stopped) {
    if (preparing || !r.before) return `Result unknown: ${what} was stopped by the User while its worktree was being prepared; its worker never started. Check the worktree (${found}).`;
    if (!s?.exists || (!s.treeDirty && !commits)) return `Result unknown: ${what} was stopped by the User. Check the worktree (${found}).`;
    if (s.treeDirty) return `Stopped by the User: ${what} left uncommitted edits in the worktree. Ask the worker to finish and commit them, or to abandon them.`;
    if (commits.length) return `Stopped by the User after committing: ${what}: ${commits.map((c) => `${c.id.slice(0, 7)} (${c.files.join(', ') || 'no files changed'})`).join(' · ')}. Its reply was lost. Ask the worker to check whether the task is complete.`;
    return `Stopped by the User: ${what} left no commits or edits in the worktree. It may still have written notes elsewhere, such as the discussion's folder. Send it again if still wanted.`;
  }
  if (!r.before) return `Result unknown: ${what} was interrupted before its starting point was recorded. Check the worktree (${found}).`;
  if (!s?.exists || (!s.treeDirty && !commits)) return `Result unknown: ${what} was interrupted by Restart, Quit or a crash. Check the worktree (${found}).`;
  if (s.treeDirty) return `Interrupted by Restart, Quit or a crash: ${what} left uncommitted edits in the worktree. Ask the worker to finish and commit them, or to abandon them.`;
  if (commits.length) return `Interrupted after committing: ${what}: ${commits.map((c) => `${c.id.slice(0, 7)} (${c.files.join(', ') || 'no files changed'})`).join(' · ')}. Its reply was lost. Ask the worker to check whether the task is complete.`;
  return `Interrupted: ${what} left no commits or edits in the worktree. It may still have written notes elsewhere, such as the discussion's folder. Send it again if still wanted.`;
}
// Each interrupted task, with what the worktree shows now; each task that never started. Shown in
// the Worker tab, and as one agent-room message in the discussion's chat (so its agents learn it).
async function reportWork(ctx, name, saved) {
  const w = restoreWork(ctx, name, saved);
  const lines = [];
  for (const r of w.interrupted.filter((x) => !x.reported)) {
    lines.push(await leftBehind(ctx, name, r));
    r.reported = true;
  }
  for (const r of w.notStarted) lines.push(`Not started: [${name}] "${firstLine(r.task)}" was still queued when the room stopped. Nothing was re-sent; send it again if still wanted.`);
  w.notStarted = [];
  if (!lines.length) return;
  for (const line of lines) workNote(ctx, `✗ ${line}`, true);
  const m = { speaker: 'agent-room', text: lines.join('\n\n') };
  ctx.state.transcript.push(m);
  log(ctx, `**${m.speaker}**\n\n${m.text}\n\n`);
  toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) });
  persistWork(ctx, name);
}

// The summary a Start fresh briefs with: the checkpoint's latest one, or none.
function checkpointSummary(saved) {
  if (!saved || saved.invalid) return null;
  if (saved.fresh) return saved.summary && typeof saved.summary.text === 'string' ? saved.summary : null;
  const s = (Array.isArray(saved.state?.transcript) ? saved.state.transcript : []).findLast((m) => m.speaker === 'Summary' && m.outcome);
  return s ? { text: s.text, outcome: s.outcome, by: s.by } : null;
}

// Checks a full checkpoint and builds its room, changing nothing; resolves to the function that
// puts it in ctx. A checkpoint that can't be used is kept, and the room stays as it is. A
// brainstorm's (brainstorm: true) has no worker part: its context keeps its own worker settings.
async function loadCheckpoint(ctx, saved, name, brainstorm = false, directory = null, loadRoom = load) {
  const what = brainstorm ? 'brainstorm' : 'discussion';
  const fallback = brainstorm ? 'Start fresh starts the brainstorm from its latest summary or transcripts instead' : 'Start fresh starts the discussion from its handoff instead';
  const invalid = () => new Error(`The checkpoint of ${name} is invalid. It was kept; ${fallback}.`);
  const workerSpec = brainstorm ? ctx.workerSpec ?? roomDefaults(ctx).worker : saved.workerSpec;
  if (saved.invalid || saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name || !!saved.brainstorm !== brainstorm
    || typeof saved.agentSpecs !== 'string' || typeof workerSpec !== 'string' || typeof saved.logPath !== 'string'
    || !Array.isArray(saved.sessions) || !Array.isArray(saved.state?.transcript) || !Array.isArray(saved.state?.seen))
    throw invalid();
  const sessions = new Map(saved.sessions), seen = new Map(saved.state.seen);
  const specs = saved.agentSpecs.split(',').map((spec) => ({ ...parseSpec(spec), worker: false }));
  if (brainstorm) sessions.set(`worker:${parseSpec(workerSpec, true).name}`, {}); // never used there
  else specs.push({ ...parseSpec(workerSpec, true), worker: true });
  for (const spec of specs) {
    const session = sessions.get(spec.worker ? `worker:${spec.name}` : spec.name);
    if (!session || typeof session !== 'object'
      || (spec.provider === 'claude' && !session.id)
      || (spec.provider === 'codex' && !spec.worker && seen.get(spec.name) > 0 && !session.threadId)
      || (spec.provider === 'agy' && !spec.worker && seen.get(spec.name) > 0 && !session.conversationId))
      throw new Error(`The saved provider session for ${spec.name} is missing. The checkpoint was kept; ${fallback}.`);
    // A Claude session whose first turn never completed may exist under its ID already: a new one.
    if (spec.provider === 'claude' && !session.started) session.id = randomUUID();
  }
  // Its folder as it is now (it may have moved while open elsewhere), and the transcript in it.
  const dir = directory ?? join(ctx.cwd, brainstorm ? BRAINSTORMS : 'discussions', name), was = saved.discussion.dir;
  const logPath = typeof was === 'string' && saved.logPath.startsWith(was + sep) ? dir + saved.logPath.slice(was.length) : saved.logPath;
  if (!existsSync(logPath)) throw new Error(`The transcript of ${name}'s checkpoint is missing (${logPath}). The checkpoint was kept.`);
  // Every agent's next prompt says it was restored (room.mjs): its own session may remember more.
  // A notice still waiting there (a brainstorm turned into a discussion while closed) comes first.
  const restored = `agent-room restored this ${what} from its checkpoint of ${when(new Date(saved.at))}. If you remember turns after that, they are not in the room's record.`;
  const waiting = saved.state.restored?.pending?.length && typeof saved.state.restored.text === 'string' ? saved.state.restored.text : null;
  const state = { ...saved.state, ...(saved.workbench || isWorkbenchDir(dir) ? { workbench: true } : {}), ...(saved.research || isResearchDir(dir) ? { research: true } : {}), seen, restored: { text: waiting ? `${waiting}\n\n${restored}` : restored,
    pending: saved.agentSpecs.split(',').map((spec) => parseSpec(spec).name) } };
  const next = { ...ctx, agentSpecs: saved.agentSpecs, workerSpec, sessions, state };
  const loaded = await loadRoom(next, `?resume=${Date.now()}`);
  return () => {
    const label = name, shop = shopOf(ctx);
    Object.assign(ctx, loaded, {
      discussion: { ...saved.discussion, dir }, agentSpecs: saved.agentSpecs, workerSpec,
      sessions, state, logPath, pendingLog: '', totals: saved.totals ?? {},
      workerBriefed: saved.workerBriefed ?? null, workerTree: saved.workerTree ?? null,
      workerLabel: saved.workerLabel ?? null, workerHandoff: !!saved.workerHandoff, workerSeat: saved.workerSeat ?? randomBytes(6).toString('hex'),
      agentsStarted: true, autoDev: null, autoDevSent: [], workDispatchedLen: 0, workReady: false, freshSummary: null,
      lastRound: { sessions: saved.sessions.filter(([key]) => !String(key).startsWith('worker:')), state: saved.state, totals: saved.totals ?? {}, doc: saved.doc ?? null },
    });
    const busy = leftWorker(ctx, saved.workerSeat); // its worker, still at work since it was left
    if (busy) reattachWorker(ctx, busy);
    Object.assign(ctx.screen, { transcript: state.transcript, doc: saved.doc ?? null, thinking: null, status: null });
    // Its own part of the Worker tab, unless the tab (shared by the folder's discussions) still has it.
    const own = Array.isArray(saved.worker) ? saved.worker.filter((m) => m?.origin === label) : [];
    if (own.length && !shop.log.some((m) => m.origin === label)) shop.log.push(...own.map((m) => ({ ...m, owner: label })));
    // What can be detected of a round cut off after the checkpoint: the transcript grew since.
    const size = logSize(ctx);
    if (typeof saved.logBytes === 'number' && size > saved.logBytes) {
      let line = 1;
      try { line += readFileSync(logPath).subarray(0, saved.logBytes).toString('utf8').split('\n').length - 1; } catch {}
      log(ctx, `_(restored from the checkpoint of ${when(new Date(saved.at))}; the transcript had grown after it)_\n\n`);
      ctx.grown = `The transcript grew after the checkpoint of ${when(new Date(saved.at))}. What was written after it is not in the restored chat; it is in the transcript file (from line ${line}). The agents may remember some of it. Send your last message again if needed.`;
    }
    ctx.logBytes = logSize(ctx);
  };
}

// The session in use ends (Resume and Start fresh in place): its checkpoint is saved first; the
// agents and the worker get fresh CLI sessions.
async function leaveSession(ctx, why) {
  if (ctx.logPath) {
    // No wait: its worker tasks still running or queued finish in its own session (detachWorker).
    endSession(ctx, why);
    if (siblings(ctx).length === 1) ctx.screen.worker.length = 0; // the Worker tab is shared otherwise
  }
  if (ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, ctx.state.workbench ? 'ending the workbench' : ctx.state.research ? 'ending the research board' : 'ending the brainstorm');
}

// ── A worker session per discussion ──
// The worker session belongs to its discussion (or brainstorm). When that session ends in a
// context (New discussion, Resume, Start fresh, New brainstorm, Close), the agent, its session and
// its briefing go with it as its seat: the tasks already sent to it finish there, their reports go
// to that discussion's transcript and checkpoint (saveLeftWorker), and nothing waits. The context
// gets a new agent on a fresh session; Resume then puts the discussion's own back (reattachWorker).
// The old session object is never changed (reset would change it under a running task).
function detachWorker(ctx) {
  const old = ctx.worker;
  if (!old) return;
  const key = `worker:${parseSpec(ctx.workerSpec ?? 'claude:Worker', true).name}`;
  old.seat = { id: ctx.workerSeat ?? null, key, session: ctx.sessions?.get(key) ?? null, origin: originLabel(ctx),
    discussion: ctx.discussion ?? null, logPath: ctx.logPath ?? null, brainstorm: !!ctx.state.brainstorm, workbench: !!ctx.state.workbench,
    briefed: ctx.workerBriefed ?? null, tree: ctx.workerTree ?? null, label: ctx.workerLabel ?? null, handoff: !!ctx.workerHandoff };
  const session = {};
  ctx.sessions?.set(key, session);
  ctx.worker = ctx.makeWorker ? ctx.makeWorker(session) : { ...old, seat: undefined };
  ctx.workerBriefed = ctx.workerTree = ctx.workerLabel = null;
  ctx.workerHandoff = false;
  ctx.workerSeat = randomBytes(6).toString('hex');
}
// A left discussion's worker, still busy with its tasks, whose checkpoint names its seat.
function leftWorker(ctx, id) {
  if (!id) return null;
  const shop = shopOf(ctx);
  return [...runningTasks(shop), ...queuedTasks(shop)].map((t) => t.worker).find((w) => w?.seat?.id === id) ?? null;
}
// Resume of a discussion whose worker is still busy there: the same agent and session come back
// (and the briefing it has since), rather than a copy of the session from the checkpoint.
function reattachWorker(ctx, worker) {
  const s = worker.seat;
  delete worker.seat;
  ctx.worker = worker;
  ctx.sessions?.set(s.key, s.session ?? {});
  Object.assign(ctx, { workerBriefed: s.briefed, workerTree: s.tree, workerLabel: s.label, workerHandoff: s.handoff, workerSeat: s.id });
}
// A task of a discussion left meanwhile has ended: its worker session, briefing, Worker-tab entries
// and task records go into that discussion's checkpoint, only if it is still the checkpoint of that
// session (not one Start fresh replaced, nor a later session's).
function saveLeftWorker(ctx, worker, usages = []) {
  const s = worker.seat, d = s.discussion;
  if (!d || s.brainstorm || !s.id) return;
  const saved = readCheckpoint(ctx, d.name);
  if (!saved || saved.invalid || saved.fresh || saved.workerSeat !== s.id) return;
  const shop = shopOf(ctx), kept = Array.isArray(saved.worker) ? saved.worker : [];
  const known = new Set(kept.map((m) => JSON.stringify(m)));
  const list = Array.isArray(usages) ? usages : (usages ? [usages] : []);
  try {
    writeCheckpoint(ctx, d.name, { ...saved,
      sessions: [...(saved.sessions ?? []).filter(([k]) => k !== s.key), [s.key, s.session ?? {}]],
      workerBriefed: s.briefed, workerTree: s.tree, workerLabel: s.label, workerHandoff: s.handoff,
      ...(list.length && { totals: { ...(saved.totals ?? {}), [worker.name]: list.reduce((tot, u) => ctx.usage.addUsage(tot, u), saved.totals?.[worker.name]) } }),
      worker: [...kept, ...shop.log.filter((m) => m.origin === s.origin && !known.has(JSON.stringify(m)))],
      work: workOf(shop, d.name) });
  } catch (err) { note(ctx, `✗ Couldn't save ${d.name}'s worker session in its checkpoint: ${err.message}`, true); }
}

// /peek <name> (Peek): a closed discussion's or closed brainstorm's conversation and notes,
// read-only, without reopening it: no agent or worker session is touched, and it stays closed.
// /peek alone (or Back on the screen) returns to the discussion in use. One in archive/ or
// deferred/ is peeked in place (it is never made active). In the terminal the conversation is
// printed instead.
function peekDiscussion(ctx, ref) {
  const parent = join(ctx.cwd, 'discussions');
  if (!ref) {
    ctx.screen.peek = null;
    toScreen(ctx, ctx.docs.resetEvent(ctx.screen));
    return note(ctx, 'Back to the discussion in use.');
  }
  if (ref.startsWith(`${BRAINSTORMS}/`)) {
    const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
    if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
    const { name, section, key } = b;
    const dir = join(ctx.cwd, BRAINSTORMS, section ?? '', name);
    const path = section ? `${BRAINSTORMS}/${section}/${name}` : `${BRAINSTORMS}/${name}`;
    if (siblings(ctx).some((c) => isBrainstorm(c, name))) return note(ctx, `✗ ${name} is not closed. Peek is for closed boards: the open ones are already on screen.`, true);
    const saved = readCheckpoint(ctx, key);
    const transcript = Array.isArray(saved?.state?.transcript) ? saved.state.transcript : [];
    if (ctx.noScreen) {
      const body = transcript.length ? transcript.map((m) => `**${m.speaker}**\n\n${m.text ?? ''}`).join('\n\n') : 'This brainstorm has no saved conversation.';
      return note(ctx, `${name}\n\n${body}\n`);
    }
    const notes = existsSync(join(dir, 'notes.md')) ? relative(ctx.cwd, join(dir, 'notes.md')).split(sep).join('/') : null;
    ctx.screen.peek = { name, ref: path, path, kind: 'brainstorm', title: saved?.discussion?.title ?? name, messages: transcript.map(ctx.docs.messageView), doc: notes };
    toScreen(ctx, ctx.docs.resetEvent(ctx.screen));
    return note(ctx, `Peeking at ${name} — read-only. Back (or /peek) returns to the discussion in use.`);
  }
  const d = discussionRef(parent, ref);
  if (!d) return note(ctx, `✗ No discussion "${ref}" in ${parent}.`, true);
  if (shopOf(ctx).closing?.has(d.name)) return note(ctx, `✗ ${d.name} is closing.`, true);
  if (!closedDiscussions(ctx).includes(d.name)) return note(ctx, `✗ ${d.name} is not closed. Peek is for closed discussions: the open ones are already on screen.`, true);
  const saved = readCheckpoint(ctx, d.name);
  const transcript = Array.isArray(saved?.state?.transcript) ? saved.state.transcript : [];
  if (ctx.noScreen) {
    const body = transcript.length ? transcript.map((m) => `**${m.speaker}**\n\n${m.text ?? ''}`).join('\n\n') : 'This discussion has no saved conversation.';
    return note(ctx, `${d.name}\n\n${body}\n`);
  }
  const dir = join(parent, d.section ?? '', d.name);
  const isWb = isWorkbenchDir(dir) || !!saved?.workbench;
  const isRes = isResearchDir(dir) || !!saved?.research;
  const notes = existsSync(join(dir, 'notes.md')) ? relative(ctx.cwd, join(dir, 'notes.md')).split(sep).join('/')
    : (isRes && existsSync(join(dir, 'quest.md')) ? relative(ctx.cwd, join(dir, 'quest.md')).split(sep).join('/') : null);
  const refKey = d.section ? `${d.section}/${d.name}` : d.name;
  const path = d.section ? `discussions/${d.section}/${d.name}` : `discussions/${d.name}`;
  ctx.screen.peek = { name: d.name, ref: refKey, path, kind: isWb ? 'workbench' : isRes ? 'research' : 'discussion', title: saved?.discussion?.title ?? d.name,
    messages: transcript.map(ctx.docs.messageView), ...(isWb && { worker: Array.isArray(saved?.worker) ? saved.worker : [] }), doc: notes };
  toScreen(ctx, ctx.docs.resetEvent(ctx.screen));
  return note(ctx, `Peeking at ${d.name} — read-only. Back (or /peek) returns to the discussion in use.`);
}

// /resume <name> (Resume): a discussion that isn't on screen. Open in another context of this folder,
// it is only shown there, as it is. Otherwise it continues from its checkpoint (the same agent and
// worker sessions, and its chat), or, with none, starts from its handoff: a fresh session at the
// next message. One in archive/ or deferred/ is made active first. On the screen it opens beside
// the open discussions (in this context, if it is still empty); in the terminal the session in use
// ends first. It runs between rounds (commands are queued).
async function resumeDiscussion(ctx, ref, { loadRoom = load } = {}) {
  const parent = join(ctx.cwd, 'discussions');
  if (!ref) return note(ctx, '✗ Name the discussion to resume: /resume <name> (its folder\'s name).', true);
  if (ref.startsWith(`${BRAINSTORMS}/`)) return resumeBrainstorm(ctx, ref);
  // A discussion is a folder named <date>-<title>; other folders there are the room's own material.
  const d = discussionRef(parent, ref);
  if (!d) return note(ctx, `✗ No discussion "${ref}" in ${parent} (discussions are folders named <date>-<title>).`, true);
  if (shopOf(ctx).closing?.has(d.name)) return note(ctx, `✗ ${d.name} is closing.`, true);
  const open = siblings(ctx).find((c) => c !== ctx && isDiscussion(c, d.name));
  if (open) return goto(ctx, open);
  if (isDiscussion(ctx, d.name)) return note(ctx, `${d.name} is the discussion in use here.`);
  if (multi(ctx) && !fresh(ctx)) return besideWith(ctx, (next) => resumeDiscussion(next, ref, { loadRoom }));
  if (d.section && !await moveDiscussion(ctx, ref, 'active')) return;
  const name = d.name, dir = join(parent, name), saved = readCheckpoint(ctx, name);
  const isWb = isWorkbenchDir(dir) || !!saved?.workbench;
  const isRes = isResearchDir(dir) || !!saved?.research;
  const kindLabel = isWb ? 'workbench' : isRes ? 'research board' : 'discussion';
  const wasClosed = closedDiscussions(ctx).includes(name);
  if (wasClosed || saved?.fromClosed) {
    const release = await suspendTransfers(ctx, name);
    try {
    if (saved && (saved.invalid || saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name))
      throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the ${kindLabel} from its handoff instead.`);
    const state = { transcript: [], seen: new Map(), ...(isWb && { workbench: true }), ...(isRes && { research: true }) }, sessions = new Map();
    const next = { ...ctx, state, sessions, agentSpecs: saved?.agentSpecs ?? ctx.agentSpecs, workerSpec: saved?.workerSpec ?? ctx.workerSpec };
    const loaded = await loadRoom(next, `?reopen=${Date.now()}`);
    await leaveSession(ctx, `resuming the ${kindLabel} ${name}`);
    const savedWorker = isWb && Array.isArray(saved?.worker) ? saved.worker : [];
    const freshSaved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(), discussion: { name, title: saved?.discussion?.title ?? name },
      ...(isWb && { workbench: true, worker: savedWorker }),
      ...(isRes && { research: true }),
      ...(saved?.fromResearch && { fromResearch: true, summary: checkpointSummary(saved) }),
      fresh: true, fromClosed: true, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, work: saved?.work ?? workOf(shopOf(ctx), name) };
    writeCheckpoint(ctx, name, freshSaved);
    setClosed(ctx, name, false);
    Object.assign(ctx, loaded, { state, sessions, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec,
      freshSummary: null, lastRound: null, agentsStarted: false, workerBriefed: null, workerTree: null,
      workerLabel: null, workerHandoff: false, workerSeat: randomBytes(6).toString('hex') });
    ctx.screen.transcript = state.transcript;
    if (isWb && savedWorker.length) {
      const shop = shopOf(ctx);
      if (!shop.log.some((m) => m.origin === name)) shop.log.push(...savedWorker.map((m) => ({ ...m, owner: name })));
    }
    switchTo(ctx, { name, dir, title: freshSaved.discussion.title, continued: true, ...(freshSaved.fromResearch && { fromResearch: true }) });
    ctx.freshSummary = checkpointSummary(freshSaved);
    ctx.closedBriefing = !isWb;
    wire(ctx);
    await reportWork(ctx, name, freshSaved.work);
    if (isWb) {
      note(ctx, `Resumed the workbench ${name}.`);
      refreshWorker(ctx).catch(() => {});
    }
    } finally { release(); }
    return;
  }
  if (saved && !saved.fresh) {
    await continueFrom(ctx, saved, name, false, loadRoom);
    setClosed(ctx, name, false);
    showHeader(ctx);
    await reportWork(ctx, name, saved.work);
    if (!isRes) refreshWorker(ctx).catch(() => {});
    return;
  }
  if (saved?.fresh && (saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name))
    throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the ${kindLabel} from its handoff instead.`);
  await leaveSession(ctx, `resuming the ${kindLabel} ${name}`);
  if (isWb) {
    ctx.state.workbench = true;
    const savedWorker = Array.isArray(saved?.worker) ? saved.worker : [];
    if (savedWorker.length) {
      const shop = shopOf(ctx);
      if (!shop.log.some((m) => m.origin === name)) shop.log.push(...savedWorker.map((m) => ({ ...m, owner: name })));
    }
  }
  if (isRes) ctx.state.research = true;
  if (isRes) await defaultsForNew(ctx, { reloadAgents: true });
  switchTo(ctx, { name, dir, title: saved?.discussion?.title ?? name, continued: true, ...(saved?.fromBrainstorm && { fromBrainstorm: true }), ...(saved?.fromResearch && { fromResearch: true }) });
  setClosed(ctx, name, false);
  showHeader(ctx);
  ctx.freshSummary = isWb ? null : checkpointSummary(saved);
  note(ctx, isWb ? `Resumed the workbench ${name}.` : `Resumed the ${kindLabel} ${name}: it has no saved session, so your next message starts a fresh one there, from its ${isRes ? 'quest notes' : 'handoff and notes'}${ctx.freshSummary ? ' and the summary chosen at Start fresh' : ''}.`);
  await reportWork(ctx, name, saved?.work);
}

// Resume from a full checkpoint (a discussion's or a brainstorm's): built first, then the session in
// use ends and the saved one takes its place.
async function continueFrom(ctx, saved, name, brainstorm, loadRoom = load) {
  const apply = await loadCheckpoint(ctx, saved, name, brainstorm, null, loadRoom); // built before anything changes
  const was = ctx.discussion && { name: refOf(ctx), title: ctx.discussion.title };
  const ref = brainstorm ? `${BRAINSTORMS}/${name}` : name;
  await leaveSession(ctx, `resuming the ${brainstorm ? 'brainstorm' : 'discussion'} ${name}`);
  apply();
  if (was && was.name !== ref) ctx.previous = was;
  if (ctx.previous?.name === ref) ctx.previous = null;
  wire(ctx);
  showHeader(ctx);
  toScreen(ctx, ctx.docs.resetEvent(ctx.screen));
  note(ctx, brainstorm ? `Resumed the brainstorm ${name}: the same agent sessions continue, with its chat.`
    : `Resumed the discussion ${name}: the same agent and worker sessions continue, with its chat.`);
  if (ctx.grown) { note(ctx, `✗ ${ctx.grown}`, true); ctx.grown = null; }
}
// What /resume names the conversation in use by: its folder's name, or brainstorms/<name>.
const refOf = (ctx) => (ctx.discussion ? keyOf(ctx) : null);

// /resume brainstorms/<name>: as a discussion's Resume. Open elsewhere, it is shown; with a full
// checkpoint, the same agent sessions and chat continue; otherwise (none, or after Start fresh) the
// next message starts a fresh session there, briefed from the latest summary or its transcripts.
async function resumeBrainstorm(ctx, ref) {
  const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const { name, section, key } = b;
  const open = siblings(ctx).find((c) => c !== ctx && isBrainstorm(c, name));
  if (open) return goto(ctx, open);
  if (isBrainstorm(ctx, name)) return note(ctx, `${name} is the brainstorm in use here.`);
  if (multi(ctx) && !fresh(ctx)) return besideWith(ctx, (next) => resumeBrainstorm(next, ref));
  if (section && !moveBrainstorm(ctx, ref, 'active')) return;
  const saved = readCheckpoint(ctx, key);
  if (saved && !saved.fresh) return continueFrom(ctx, saved, name, true);
  if (saved?.fresh && (saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name || !saved.brainstorm))
    throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the brainstorm from its latest summary or transcripts instead.`);
  await leaveSession(ctx, `resuming the brainstorm ${name}`);
  enterBrainstorm(ctx, name, saved);
  note(ctx, `Resumed the brainstorm ${name}: it has no saved session, so your next message starts a fresh one there, from ${ctx.freshSummary ? 'its latest summary' : 'its transcripts'}.`);
}
// Makes the brainstorm in brainstorms/<name>/ the one in use, to continue in a fresh session.
function enterBrainstorm(ctx, name, saved) {
  ctx.state.brainstorm = true;
  ctx.state.brainstormId = randomBytes(12).toString('hex');
  const title = typeof saved?.discussion?.title === 'string' ? saved.discussion.title : name;
  switchTo(ctx, { name, dir: join(ctx.cwd, BRAINSTORMS, name), title, continued: true });
  ctx.freshSummary = checkpointSummary(saved);
}

// /fresh <name> (Start fresh): new agent and worker sessions, from the discussion's handoff and
// notes and its checkpoint's latest summary (marked if it wasn't agreed). The saved sessions and
// chat are discarded: the checkpoint is replaced by one holding only that summary, so a Restart or
// Resume before the first message still briefs with it.
async function startFresh(ctx, ref) {
  const parent = join(ctx.cwd, 'discussions');
  if (!ref) return note(ctx, '✗ Name the discussion to start afresh: /fresh <name> (its folder\'s name).', true);
  if (ref.startsWith(`${BRAINSTORMS}/`)) return freshBrainstorm(ctx, ref);
  const d = discussionRef(parent, ref);
  if (!d) return note(ctx, `✗ No discussion "${ref}" in ${parent} (discussions are folders named <date>-<title>).`, true);
  if (shopOf(ctx).closing?.has(d.name)) return note(ctx, `✗ ${d.name} is closing.`, true);
  const open = siblings(ctx).find((c) => c !== ctx && isDiscussion(c, d.name));
  if (open) { open.say?.(`/fresh ${d.name}`); return goto(ctx, open); } // it starts afresh there
  if (multi(ctx) && !fresh(ctx) && !isDiscussion(ctx, d.name)) return besideWith(ctx, (next) => startFresh(next, ref));
  if (d.section && !await moveDiscussion(ctx, ref, 'active')) return;
  const name = d.name;
  const dir = join(parent, name);
  const isRes = isResearchDir(dir);
  const release = await suspendTransfers(ctx, name);
  try {
  const wasResearch = !!ctx.state.research;
  await leaveSession(ctx, `starting the ${isRes ? 'research board' : 'discussion'} ${name} afresh`); // saves its checkpoint first
  const summary = checkpointSummary(readCheckpoint(ctx, name));
  writeCheckpoint(ctx, name, { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
    discussion: { name, title: name }, ...(isRes && { research: true }), fresh: true, summary, work: workOf(shopOf(ctx), name) });
  if (isRes) ctx.state.research = true;
  if (isRes || wasResearch) await defaultsForNew(ctx, { reloadAgents: true });
  switchTo(ctx, { name, dir, title: name, continued: true });
  setClosed(ctx, name, false);
  showHeader(ctx);
  ctx.freshSummary = summary;
  note(ctx, `Started ${name} afresh: your next message starts a new session there, from its ${isRes ? 'quest notes' : 'handoff and notes'}${summary ? `, with its latest summary${summary.outcome === 'agreed' ? '' : ' (not agreed)'}` : ''}. Its saved sessions and chat were discarded.`);
  } finally { release(); }
}

async function suspendTransfers(ctx, name) {
  const state = ctx.replica?.state;
  if (!state) return () => {};
  (state.reopening ??= new Set()).add(name);
  await Promise.allSettled([...(state.transfers?.get(name) ?? [])]);
  return () => state.reopening.delete(name);
}

// /fresh brainstorms/<name>: new agent sessions there, briefed from its latest summary (marked if it
// wasn't agreed) or, with none, pointed at its transcripts. Its saved sessions and chat are
// discarded: the checkpoint keeps only that summary, until the fresh session's first round.
async function freshBrainstorm(ctx, ref) {
  const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const { name, section, key } = b;
  const open = siblings(ctx).find((c) => c !== ctx && isBrainstorm(c, name));
  if (open) { open.say?.(`/fresh ${key}`); return goto(ctx, open); } // it starts afresh there
  if (multi(ctx) && !fresh(ctx) && !isBrainstorm(ctx, name)) return besideWith(ctx, (next) => freshBrainstorm(next, ref));
  if (section && !moveBrainstorm(ctx, ref, 'active')) return;
  const title = ctx.discussion && isBrainstorm(ctx, name) ? ctx.discussion.title : null;
  await leaveSession(ctx, `starting the brainstorm ${name} afresh`); // saves its checkpoint first
  const before = readCheckpoint(ctx, key);
  const summary = checkpointSummary(before);
  const saved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
    discussion: { name, title: title ?? (typeof before?.discussion?.title === 'string' ? before.discussion.title : name) }, brainstorm: true, fresh: true, summary };
  writeCheckpoint(ctx, key, saved);
  enterBrainstorm(ctx, name, saved);
  note(ctx, `Started the brainstorm ${name} afresh: your next message starts a new session there, ${summary ? `with its latest summary${summary.outcome === 'agreed' ? '' : ' (not agreed)'}` : 'pointing the agents to its transcripts'}. Its saved sessions and chat were discarded.`);
}

// /convert brainstorms/<name> research (Turn into research): moves brainstorms/<name>/ to
// discussions/<name>/, writes .research, ends old sessions, and starts fresh sessions with the
// researching rulebook (briefed from its transcripts/ and latest summary).
async function convertBrainstormToResearch(ctx, ref) {
  const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}. Nothing was changed.`, true);
  if (b.section) return note(ctx, `✗ ${b.name} is in ${b.section}/: make it active before turning it into a research board. Nothing was moved.`, true);
  const name = b.name, from = join(ctx.cwd, BRAINSTORMS, name);
  const open = siblings(ctx).find((c) => isBrainstorm(c, name));
  if (ctx.busy || open?.busy) {
    return note(ctx, `✗ ${name} can't become a research board while a round or summary is running. Try again when it finishes; nothing was moved.`, true);
  }
  if (open && open !== ctx) { open.say?.(`/convert ${ref} research`); return goto(ctx, open); }
  const parent = join(ctx.cwd, 'discussions'), dest = join(parent, name);
  const clash = [dest, ...SECTIONS.map((s) => join(parent, s, name)), ...SECTIONS.map((s) => join(ctx.cwd, BRAINSTORMS, s, name))].find((p) => existsSync(p));
  if (clash) return note(ctx, `✗ ${name} can't become a research board: ${relative(ctx.cwd, clash)} already exists. Nothing was moved.`, true);

  const saved = readCheckpoint(ctx, ref);
  const title = open?.discussion?.title ?? (typeof saved?.discussion?.title === 'string' ? saved.discussion.title : name);
  const agentSpecs = open?.agentSpecs ?? saved?.agentSpecs ?? ctx.agentSpecs;
  const workerSpec = open?.workerSpec ?? saved?.workerSpec ?? ctx.workerSpec ?? roomDefaults(ctx).worker;
  const openSummary = open
    ? (() => {
        const s = (open.state?.transcript ?? []).findLast((m) => m.speaker === 'Summary' && m.outcome);
        return s ? { text: s.text, outcome: s.outcome, by: s.by } : null;
      })()
    : null;
  const summary = openSummary ?? checkpointSummary(saved);

  // Build fresh research sessions BEFORE moving files or ending the brainstorm's sessions, so a
  // failure here leaves the brainstorm's files, sessions and checkpoint untouched.
  let loaded = null, nextState = null, nextSessions = null;
  if (open) {
    nextState = { transcript: [], seen: new Map(), brainstorm: false, research: true };
    nextSessions = new Map();
    const next = { ...open, discussion: null, agentSpecs, workerSpec, sessions: nextSessions, state: nextState };
    try {
      loaded = await load(next, `?convert-research=${Date.now()}`);
    } catch (err) {
      return note(ctx, `✗ Couldn't start fresh research sessions for ${name}: ${err.message}. Nothing was moved; the brainstorm's files, sessions and checkpoint are untouched.`, true);
    }
  }

  try { mkdirSync(parent, { recursive: true }); } catch (err) {
    return note(ctx, `✗ Couldn't prepare discussions/ for ${name}: ${err.message}. Nothing was moved.`, true);
  }
  try { mkdirSync(dest); } catch (err) {
    return note(ctx, `✗ ${name} can't become a research board: ${err.code === 'EEXIST' ? `discussions/${name} already exists` : err.message}. Nothing was moved.`, true);
  }
  try { renameSync(from, dest); } catch (err) {
    try { rmdirSync(dest); } catch {}
    return note(ctx, `✗ Couldn't move ${name} to discussions/: ${err.message}. Nothing was moved; the brainstorm's files and checkpoint are untouched.`, true);
  }
  const markerPath = join(dest, RESEARCH_MARKER);
  try {
    writeFileSync(markerPath, 'research\n');
  } catch (err) {
    try {
      renameSync(dest, from);
      return note(ctx, `✗ Couldn't write .research in discussions/${name}: ${err.message}. Moved the folder back to brainstorms/${name}; the brainstorm's files and checkpoint are intact.`, true);
    } catch (rbErr) {
      return note(ctx, `✗ Couldn't write .research in discussions/${name}: ${err.message}. The folder was moved to discussions/${name} and moving it back failed (${rbErr.message}); its old checkpoint is still under ${ref}.`, true);
    }
  }

  const freshSaved = {
    version: 1,
    root: realpathSync(ctx.cwd),
    at: new Date().toISOString(),
    discussion: { name, title },
    research: true,
    fromBrainstorm: true,
    fresh: true,
    summary,
    agentSpecs,
    workerSpec,
  };
  try {
    writeCheckpoint(ctx, name, freshSaved);
  } catch (err) {
    try {
      try { unlinkSync(markerPath); } catch {}
      renameSync(dest, from);
      return note(ctx, `✗ Couldn't save the research board checkpoint for ${name}: ${err.message}. Removed .research and moved the folder back to brainstorms/${name}; the brainstorm's files and checkpoint are intact.`, true);
    } catch (rbErr) {
      return note(ctx, `✗ Couldn't save the research board checkpoint for ${name}: ${err.message}. The folder is at discussions/${name} with .research and moving it back failed (${rbErr.message}); the old checkpoint is still under ${ref}.`, true);
    }
  }

  const moveFile = (p) => (typeof p === 'string' && p.startsWith(from + sep) ? dest + p.slice(from.length) : p);
  if (open) {
    if (open.logPath) {
      open.logPath = moveFile(open.logPath);
      try { appendFileSync(open.logPath, `_(turned into a research board: ${dest})_\n\n`); } catch {}
    }
    for (const a of open.room.agents) if (a.reset) a.reset();
    detachWorker(open);
    Object.assign(open, loaded, {
      state: nextState,
      sessions: nextSessions,
      agentSpecs,
      workerSpec,
      logPath: null,
      pendingLog: '',
      lastRound: null,
      freshSummary: summary,
      agentsStarted: false,
      retryFailure: null,
      autoDev: null,
      autoDevSent: [],
      workDispatchedLen: 0,
      workReady: false,
    });
    open.screen.transcript = nextState.transcript;
    Object.assign(open.screen, { doc: null, thinking: null, status: null, peek: null });
    wire(open);
    switchTo(open, { name, dir: dest, title, continued: true, fromBrainstorm: true });
    open.freshSummary = summary;
  }

  let cleanupWarning = '';
  try { unlinkSync(checkpointFile(ctx, ref)); } catch (err) {
    if (err.code !== 'ENOENT') cleanupWarning = ` (Warning: couldn't remove the old brainstorm checkpoint ${ref}: ${err.message}.)`;
  }
  listedCheckpoints.clear();
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    if (c.screen.doc?.startsWith(`${BRAINSTORMS}/${name}/`)) {
      c.screen.doc = `discussions/${name}/` + c.screen.doc.slice(`${BRAINSTORMS}/${name}/`.length);
      toScreen(c, { type: 'doc', file: c.screen.doc });
    }
    toScreen(c, { type: 'moved', from: `${BRAINSTORMS}/${name}`, to: `discussions/${name}` });
  }
  showHeader(ctx);
  note(ctx, `Turned the brainstorm ${name} into the research board ${name}, in discussions/: old sessions ended; the same agents start fresh with the research rulebook, reading its transcripts/${summary ? ` and latest summary${summary.outcome === 'agreed' ? '' : ' (not agreed)'}` : ''}.${cleanupWarning}`);
}

// Turn an active research board into a discussion in the same folder, with fresh sessions.
async function convertResearchToDiscussion(ctx, ref) {
  const parent = join(ctx.cwd, 'discussions');
  const normalized = ref.startsWith('discussions/') ? ref.slice('discussions/'.length) : ref;
  const d = discussionRef(parent, normalized);
  if (!d || !isResearchDir(join(parent, d.section ?? '', d.name))) return note(ctx, `✗ No research board "${ref}". Nothing was changed.`, true);
  if (d.section) return note(ctx, `✗ ${d.name} is in ${d.section}/: make it active before turning it into a discussion.`, true);
  const name = d.name, dir = join(parent, name), marker = join(dir, RESEARCH_MARKER);
  const open = siblings(ctx).find((c) => !c.stopped && isDiscussion(c, name));
  if (open?.busy) return note(ctx, `✗ ${name} can't become a discussion while a round or summary is running. Nothing was changed.`, true);
  if (open && open !== ctx) { open.say?.(`/convert discussions/${name}`); return goto(ctx, open); }
  const saved = readCheckpoint(ctx, name);
  if (saved?.invalid) return note(ctx, `✗ The checkpoint of ${name} is invalid. Nothing was changed.`, true);
  const title = open?.discussion?.title ?? saved?.discussion?.title ?? name;
  const agentSpecs = open?.agentSpecs ?? saved?.agentSpecs ?? ctx.agentSpecs;
  const workerSpec = open?.workerSpec ?? saved?.workerSpec ?? ctx.workerSpec ?? roomDefaults(ctx).worker;
  const latest = open?.state?.transcript?.findLast((m) => m.speaker === 'Summary' && m.outcome);
  const summary = latest ? { text: latest.text, outcome: latest.outcome, by: latest.by } : checkpointSummary(saved);
  let loaded = null, state = null, sessions = null;
  if (open) {
    state = { transcript: [], seen: new Map() }; sessions = new Map();
    try { loaded = await load({ ...open, discussion: null, agentSpecs, workerSpec, sessions, state }, `?convert-discussion=${Date.now()}`); }
    catch (err) { return note(ctx, `✗ Couldn't start fresh discussion sessions for ${name}: ${err.message}. Nothing was changed.`, true); }
    if (open.busy) return note(ctx, `✗ ${name} can't become a discussion while a round or summary is running. Nothing was changed.`, true);
  }
  const freshSaved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
    discussion: { name, title }, fresh: true, fromResearch: true, summary, agentSpecs, workerSpec };
  const schedule = readSchedule(ctx), linked = schedule.tasks.filter((t) => t.kind === 'recurring' && t.board === name);
  const cp = checkpointFile(ctx, name);
  let oldMarker, oldCheckpoint;
  try { oldMarker = readFileSync(marker); oldCheckpoint = existsSync(cp) ? readFileSync(cp) : null; }
  catch (err) { return note(ctx, `✗ Couldn't inspect ${name} before conversion: ${err.message}. Nothing was changed.`, true); }
  try {
    unlinkSync(marker);
    writeCheckpoint(ctx, name, freshSaved);
    if (linked.length) { for (const task of linked) task.enabled = false; writeSchedule(ctx, schedule); }
  } catch (err) {
    try {
      if (!existsSync(marker)) writeFileSync(marker, oldMarker, { flag: 'wx' });
      if (oldCheckpoint) writeFileSync(cp, oldCheckpoint); else if (existsSync(cp)) unlinkSync(cp);
    } catch (rollback) { return note(ctx, `✗ Conversion failed (${err.message}); restoring the research board also failed (${rollback.message}). Check ${dir} and its checkpoint.`, true); }
    return note(ctx, `✗ Couldn't convert ${name}: ${err.message}. The research board was restored.`, true);
  }
  if (open) {
    if (open.logPath) { try { appendFileSync(open.logPath, '_(turned into a discussion)_\n\n'); } catch {} }
    for (const agent of open.room.agents) agent.reset?.();
    detachWorker(open);
    Object.assign(open, loaded, { state, sessions, agentSpecs, workerSpec, logPath: null, pendingLog: '', lastRound: null,
      freshSummary: summary, agentsStarted: false, retryFailure: null, autoDev: null, autoDevSent: [], workDispatchedLen: 0, workReady: false });
    open.screen.transcript = state.transcript;
    Object.assign(open.screen, { doc: null, thinking: null, status: null, peek: null });
    wire(open);
    switchTo(open, { name, dir, title, continued: true, fromResearch: true });
    open.freshSummary = summary;
    refreshWorker(open).catch(() => {});
  }
  listedCheckpoints.clear();
  if (linked.length) broadcastSchedule(ctx);
  showHeader(ctx);
  note(ctx, `Turned research board ${name} into a discussion: the same agents start fresh with discussion rules, reading the research notes, transcripts and latest summary.${linked.length ? ` Turned off ${linked.length} recurring scheduled task${linked.length === 1 ? '' : 's'} linked to this board.` : ''}`);
}

// /convert brainstorms/<name> (Turn into a discussion): its folder moves to discussions/<name>/
// (never over an existing folder, checked as it moves), with its checkpoint. Its agents keep their
// sessions; each is told once, in its next prompt (state.restored), the new folder and that the
// discussion rules apply. The worker starts fresh at the discussion's first task. Open elsewhere, it
// is converted there, between its rounds.
async function convertBrainstorm(ctx, ref) {
  const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  if (b.section) return note(ctx, `✗ ${b.name} is in ${b.section}/: make it active before turning it into a discussion.`, true);
  const name = b.name, from = join(ctx.cwd, BRAINSTORMS, name);
  const open = siblings(ctx).find((c) => isBrainstorm(c, name));
  if (open && open !== ctx) { open.say?.(`/convert ${ref}`); return goto(ctx, open); }
  const parent = join(ctx.cwd, 'discussions'), dest = join(parent, name);
  const clash = [dest, ...SECTIONS.map((s) => join(parent, s, name)), ...SECTIONS.map((s) => join(ctx.cwd, BRAINSTORMS, s, name))].find((p) => existsSync(p));
  if (clash) return note(ctx, `✗ ${name} can't become a discussion: ${relative(ctx.cwd, clash)} already exists. Nothing was moved.`, true);
  mkdirSync(parent, { recursive: true });
  // mkdir claims the name (it fails if the folder exists by now); the rename then replaces that empty folder.
  try { mkdirSync(dest); } catch (err) { return note(ctx, `✗ ${name} can't become a discussion: ${err.code === 'EEXIST' ? `discussions/${name} already exists` : err.message}. Nothing was moved.`, true); }
  try { renameSync(from, dest); } catch (err) { try { rmdirSync(dest); } catch {} return note(ctx, `✗ Couldn't move ${name} to discussions/: ${err.message}`, true); }
  const notice = `agent-room turned this brainstorm into a discussion. Its folder is now ${dest}: from now on the discussion rules of your rulebook apply (create, read and write this discussion's documents there), and the User can send work to the worker.`;
  const moveFile = (p) => (typeof p === 'string' && p.startsWith(from + sep) ? dest + p.slice(from.length) : p);
  const saved = readCheckpoint(ctx, ref);
  if (open) {
    // In use here: the session goes on, as a discussion, in its new folder.
    Object.assign(open.discussion, { dir: dest });
    open.logPath = moveFile(open.logPath);
    open.state.brainstorm = false;
    delete open.state.brainstormId;
    open.state.restored = { text: notice, pending: open.room.agents.map((a) => a.name) };
    if (open.lastRound) open.lastRound.state = { ...open.lastRound.state, brainstorm: false, restored: open.state.restored };
    log(open, `_(turned into a discussion: ${dest})_\n\n`);
    saveCheckpoint(open);
    if (!open.lastRound && saved && !saved.invalid) writeCheckpoint(ctx, name, { ...saved, brainstorm: undefined, discussion: { ...saved.discussion, dir: dest } });
  } else if (saved && !saved.invalid) {
    // Closed: its checkpoint moves to the discussion's key, carrying the notice for its next Resume.
    const agents = typeof saved.agentSpecs === 'string' ? saved.agentSpecs.split(',').map((spec) => parseSpec(spec).name) : [];
    const workerSpec = ctx.workerSpec ?? roomDefaults(ctx).worker, wKey = `worker:${parseSpec(workerSpec, true).name}`;
    writeCheckpoint(ctx, name, saved.fresh ? { ...saved, brainstorm: undefined } : { ...saved, brainstorm: undefined,
      discussion: { ...saved.discussion, dir: dest }, logPath: moveFile(saved.logPath), workerSpec,
      // The worker starts fresh: a new session, never run.
      sessions: [...(Array.isArray(saved.sessions) ? saved.sessions : []).filter(([k]) => !String(k).startsWith('worker:')), [wKey, { id: randomUUID() }]],
      state: { ...saved.state, brainstorm: false, brainstormId: undefined, restored: { text: notice, pending: agents } } });
  }
  try { unlinkSync(checkpointFile(ctx, ref)); } catch (err) { if (err.code !== 'ENOENT') note(ctx, `✗ Couldn't remove the brainstorm's old checkpoint: ${err.message}`, true); }
  listedCheckpoints.clear();
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    // A page showing a file in it follows the move.
    if (c.screen.doc?.startsWith(`${BRAINSTORMS}/${name}/`)) {
      c.screen.doc = `discussions/${name}/` + c.screen.doc.slice(`${BRAINSTORMS}/${name}/`.length);
      toScreen(c, { type: 'doc', file: c.screen.doc });
    }
    toScreen(c, { type: 'moved', from: `${BRAINSTORMS}/${name}`, to: `discussions/${name}` });
  }
  showHeader(ctx);
  if (open) refreshWorker(open).catch(() => {});
  note(ctx, `Turned the brainstorm ${name} into the discussion ${name}, in discussions/: ${open ? 'its agents carry on' : 'Continue it to carry on'} with the same sessions, told of the new folder; the worker starts fresh with its first task.`);
}

// /delete brainstorms/<name> (Delete): its folder (transcripts, drawings) and checkpoint are removed
// for good. Never an open brainstorm (the page disables the button too).
function deleteBrainstorm(ctx, ref) {
  const b = brainstormDirRef(join(ctx.cwd, BRAINSTORMS), ref);
  if (!b) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const { name, section, key } = b;
  const dir = join(ctx.cwd, BRAINSTORMS, section ?? '', name);
  const fromRel = section ? `${BRAINSTORMS}/${section}/${name}` : `${BRAINSTORMS}/${name}`;
  if (siblings(ctx).some((c) => !c.stopped && isBrainstorm(c, name))) return note(ctx, `✗ ${name} is open: close it before deleting it. Nothing was deleted.`, true);
  try { rmSync(dir, { recursive: true }); } catch (err) { return note(ctx, `✗ Couldn't delete ${name}: ${err.message}`, true); }
  try { unlinkSync(checkpointFile(ctx, key)); } catch (err) { if (err.code !== 'ENOENT') note(ctx, `✗ Couldn't remove ${name}'s checkpoint: ${err.message}`, true); }
  listedCheckpoints.clear();
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    if (c.screen.peek?.path === fromRel) {
      c.screen.peek = null;
      toScreen(c, c.docs.resetEvent(c.screen));
    }
    toScreen(c, { type: 'moved', from: fromRel, to: null });
  }
  showHeader(ctx);
  note(ctx, `Deleted the brainstorm ${name}: its folder and checkpoint are gone.`);
}

// /delete <name|archive/<name>|deferred/<name>> (Delete): for a closed research board only.
function deleteResearch(ctx, ref) {
  const parent = join(ctx.cwd, 'discussions');
  const d = discussionRef(parent, ref);
  if (!d) return note(ctx, `✗ No research board "${ref}" in ${parent}.`, true);
  const dir = join(parent, d.section ?? '', d.name);
  if (!isResearchDir(dir)) return note(ctx, `✗ ${d.name} is not a research board: only brainstorms and research boards can be deleted.`, true);
  if (shopOf(ctx).closing?.has(d.name)) return note(ctx, `✗ ${d.name} is closing.`, true);
  if (!closedDiscussions(ctx).includes(d.name) || siblings(ctx).some((c) => !c.stopped && isDiscussion(c, d.name))) {
    return note(ctx, `✗ ${d.name} is open: close it before deleting it. Nothing was deleted.`, true);
  }
  const fromRel = d.section ? `discussions/${d.section}/${d.name}` : `discussions/${d.name}`;
  try { rmSync(dir, { recursive: true }); } catch (err) { return note(ctx, `✗ Couldn't delete ${d.name}: ${err.message}`, true); }
  try { unlinkSync(checkpointFile(ctx, d.name)); } catch (err) { if (err.code !== 'ENOENT') note(ctx, `✗ Couldn't remove ${d.name}'s checkpoint: ${err.message}`, true); }
  setClosed(ctx, d.name, false);
  listedCheckpoints.clear();
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    if (c.screen.peek?.path === fromRel) {
      c.screen.peek = null;
      toScreen(c, c.docs.resetEvent(c.screen));
    }
    toScreen(c, { type: 'moved', from: fromRel, to: null });
  }
  showHeader(ctx);
  note(ctx, `Deleted the research board ${d.name}: its folder and checkpoint are gone.`);
}

// On the screen: `run` in a new context beside the open discussions, which the window then shows.
// If it fails, the empty context closes again.
async function besideWith(ctx, run) {
  const next = await openBeside(ctx);
  try { await run(next); } catch (err) { closeContext(next); throw err; }
  if (fresh(next)) return closeContext(next); // nothing opened there (its note says why)
  goto(ctx, next);
}

// Ends this room's discussion session (Resume, Start fresh, New discussion, Close): its checkpoint
// is saved, a last line goes in its transcript, which is then closed; the chat clears and the
// discussion agents get fresh CLI sessions. The worker session goes with the session that ends
// (detachWorker): the context's next worker task starts a fresh one, or Resume's own.
function endSession(ctx, why, onReset = null) {
  log(ctx, `_(session ended: ${why})_\n\n`);
  saveCheckpoint(ctx); // the latest checkpoint stays: Resume continues from it
  detachWorker(ctx); // its worker session goes with it; this context's worker starts a fresh one
  ctx.lastRound = null;
  ctx.freshSummary = null;
  for (const a of ctx.room.agents) if (a.reset) { a.reset(); onReset?.(a); }
  const { state, screen } = ctx;
  state.transcript.length = 0; // emptied in place: the room and the screen hold this array
  for (const a of ctx.room.agents) state.seen.set(a.name, 0);
  state.summaries = 0;
  delete state.disabledAgents;
  state.briefing = null;
  state.brainstorm = false;
  state.workbench = false;
  state.research = false;
  ctx.retryFailure = null;
  ctx.autoDev = null; // Resume, Start fresh, New discussion and New brainstorm end an auto dev run
  ctx.autoDevSent = [];
  ctx.workDispatchedLen = 0;
  ctx.workReady = false;
  Object.assign(screen, { doc: null, thinking: null, status: null, peek: null });
  ctx.logPath = null;
  ctx.pendingLog = '';
  ctx.agentsStarted = false;
}

// Makes `next` (or no discussion) the one in use. The one it replaces is remembered for the header's
// "← back to …" link, until the next message opens a discussion.
function switchTo(ctx, next) {
  const was = ctx.discussion;
  ctx.closedBriefing = false;
  ctx.screen.peek = null; // a peek ends when a discussion becomes the one in use
  if (was && was.dir !== next?.dir) ctx.previous = { name: was.name, title: was.title };
  if (next && ctx.previous?.name === next.name) ctx.previous = null; // went back to it
  ctx.discussion = next;
  ctx.screen.working = runningTasks(shopOf(ctx)).find((t) => t.owner === ownerOf(ctx))?.worker.name ?? null;
  showHeader(ctx);
  toScreen(ctx, ctx.docs.resetEvent(ctx.screen)); // open pages start over with the empty chat
}

// /new (New discussion): between rounds, like every command. The discussion session ends (its
// checkpoint is kept); the next message names and creates the new discussion, as in a fresh room. Nothing is
// created until then. A running task keeps its target, log and session; the new discussion uses
// this folder’s launch defaults.
// A new terminal discussion or brainstorm starts with this folder’s launch defaults.
async function defaultsForNew(ctx, { reloadAgents = false } = {}) {
  if (!ctx.agentSpecs || !ctx.workerSpec) return; // a room built directly with in-memory agents
  const launch = roomDefaults(ctx);
  const workerSpec = launch.worker, agentSpecs = launch.agents;
  const worker = parseSpec(workerSpec, true);
  if (!reloadAgents && workerSpec === ctx.workerSpec && agentSpecs === ctx.agentSpecs) return;
  const sessions = new Map();
  if (worker) sessions.set(`worker:${worker.name}`, workerSpec === ctx.workerSpec ? ctx.sessions.get(`worker:${worker.name}`) ?? {} : {});
  const state = { ...ctx.state, seen: new Map() };
  const next = { ...ctx, discussion: null, agentSpecs, workerSpec, sessions, state };
  const loaded = await load(next, new URL(import.meta.url).search);
  Object.assign(ctx, { room: loaded.room, worker: loaded.worker, makeWorker: loaded.makeWorker, closingStatement: loaded.closingStatement, rulebooks: loaded.rulebooks, agentSpecs, workerSpec, sessions, state });
  wire(ctx);
}
async function newDiscussion(ctx) {
  const was = ctx.discussion, ref = refOf(ctx), brain = !!ctx.state.brainstorm, wasRes = !!ctx.state.research;
  if (!was && !ctx.logPath && !ctx.state.brainstorm && !ctx.state.workbench && !ctx.state.research) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, 'starting a new discussion');
  await defaultsForNew(ctx, { reloadAgents: wasRes });
  if (was && !brain && ctx.screen.worker.length) {
    const view = { owner: ownerOf(ctx), note: `New discussion: ${was.name} keeps its worker session; its tasks still running or queued finish there and report to it. The new discussion's worker starts a fresh session.` };
    ctx.screen.worker.push(view);
    toScreen(ctx, { type: 'work', message: view });
  }
  switchTo(ctx, null);
  note(ctx, `New discussion: your next message names it and starts it.${ref ? ` To go back, /resume ${ref}.` : ''}`);
}

// /brainstorm (New brainstorm): a conversation like a discussion's, with the same agents, turns and
// PASS rules. Its first message names it, as a discussion's does, in brainstorms/<date>-<title>/
// (transcripts/, and drawings/ if agents draw), and it saves checkpoints like a discussion (with no
// worker part). No worker tasks, Attach, auto dev or automatic summary; Turn into a discussion
// (/convert) makes it a discussion. In place, it ends the session in use as New discussion does.
async function newBrainstorm(ctx) {
  const was = refOf(ctx), wasRes = !!ctx.state.research;
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, 'starting a brainstorm');
  await defaultsForNew(ctx, { reloadAgents: wasRes });
  ctx.state.brainstorm = true;
  ctx.state.brainstormId = randomBytes(12).toString('hex');
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New brainstorm: your next message names it and starts it, in ${BRAINSTORMS}/.${was ? ` To go back, /resume ${was}.` : ''}`);
}

// /workbench (New workbench): a worker-only board for one small fix, stored in discussions/<date>-<title>/
// with a .workbench marker. Its first message gives the title, creates the folder and goes straight to the worker.
async function newWorkbench(ctx) {
  const was = refOf(ctx), wasRes = !!ctx.state.research;
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, 'starting a workbench');
  await defaultsForNew(ctx, { reloadAgents: wasRes });
  ctx.state.workbench = true;
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New workbench: your first message names it and goes straight to the worker.${was ? ` To go back, /resume ${was}.` : ''}`);
}

// /research (New research): a research board stored in discussions/<date>-<title>/ with a .research
// marker. Agents receive citizenship + group-chat + researching; no worker, no auto dev, no automatic summary.
async function newResearch(ctx) {
  const was = refOf(ctx);
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, 'starting a research board');
  ctx.state.research = true;
  await defaultsForNew(ctx, { reloadAgents: true });
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New research board: your first message names it and starts it.${was ? ` To go back, /resume ${was}.` : ''}`);
}


// Sends this context's pages to another one (the window switches discussion).
const goto = (ctx, target) => toScreen(ctx, { type: 'goto', url: pageOf(target) });
async function openBeside(ctx) {
  const shop = shopOf(ctx);
  let tag;
  do tag = `d${++shop.contexts}`; while (ctx.hub.rooms.has(`${baseKey(ctx)}#${tag}`));
  const launch = roomDefaults(ctx);
  const { ctx: next } = await ctx.hub.addRoom(ctx.cwd, { agents: launch.agents, worker: launch.worker, context: tag });
  next.creationOrigin = ctx;
  showHeader(ctx);
  return next;
}
// Ends context `c` (its agents stop; its queued worker tasks are dropped and reported by stopRoom).
// Its pages go to `to`.
function closeContext(c, to) {
  if (to) goto(c, to);
  c.say?.('/quit');
}

// /new on the screen: the discussion (or brainstorm) in use stays open. A new brainstorm not
// started yet becomes the new discussion instead.
async function newDiscussionBeside(ctx) {
  if ((ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) && fresh(ctx)) {
    const wasRes = !!ctx.state.research;
    endSession(ctx, 'starting a new discussion');
    await defaultsForNew(ctx, { reloadAgents: wasRes });
    switchTo(ctx, null);
    return note(ctx, 'New discussion: your next message names it and starts it.');
  }
  if (fresh(ctx)) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  const next = await openBeside(ctx);
  goto(ctx, next);
  note(ctx, `New discussion: ${ctx.discussion?.name ?? 'this one'} stays open (${ctx.state.brainstorm ? 'Brainstorms: Go to' : 'Discussions: Continue'} shows it again).`);
}
// /brainstorm on the screen: beside the open discussions and brainstorms (in this context if it is empty).
async function newBrainstormBeside(ctx) {
  if (fresh(ctx)) return newBrainstorm(ctx);
  const next = await openBeside(ctx);
  next.say?.('/brainstorm');
  goto(ctx, next);
}
// /workbench on the screen: beside the open boards (in this context if it is empty).
async function newWorkbenchBeside(ctx) {
  if (fresh(ctx)) return newWorkbench(ctx);
  const next = await openBeside(ctx);
  next.say?.('/workbench');
  goto(ctx, next);
}
// /research on the screen: beside the open boards (in this context if it is empty).
async function newResearchBeside(ctx) {
  if (fresh(ctx)) return newResearch(ctx);
  const next = await openBeside(ctx);
  next.say?.('/research');
  goto(ctx, next);
}
// /close (Close discussion): this discussion (or brainstorm or workbench or research board) closes; the others stay open. The last
// one open ends its session instead, leaving an empty room, as New discussion does in the terminal.
function closeDiscussion(ctx) {
  if (!ctx.state.brainstorm && ctx.discussion) return closeNamedDiscussion(ctx, ctx.discussion.name);
  const hold = workerHold(ctx);
  if (hold) return note(ctx, `✗ This can't be closed yet: ${hold}.`, true);
  const others = siblings(ctx).filter((c) => c !== ctx);
  if ((!others.length || !multi(ctx)) && fresh(ctx) && !ctx.state.brainstorm && !ctx.state.workbench && !ctx.state.research)
    return note(ctx, 'Nothing to close: no discussion is open here.');
  if (others.length && multi(ctx) && ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  if (!others.length || !multi(ctx)) {
    const was = ctx.discussion, brain = !!ctx.state.brainstorm, wb = !!ctx.state.workbench, res = !!ctx.state.research;
    if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) endSession(ctx, brain ? 'closing the brainstorm' : wb ? 'closing the workbench' : res ? 'closing the research board' : 'closing the discussion');
    switchTo(ctx, null);
    return note(ctx, was ? `Closed ${was.name}; its checkpoint is kept. To go back, Resume it in ${brain ? 'Brainstorms' : 'Explorer'}.` : wb ? 'Closed the workbench.' : res ? 'Closed the research board.' : 'Closed the brainstorm.');
  }
  closeContext(ctx, others[0]);
}

function cancelCreation(ctx) {
  if (!fresh(ctx)) return;
  const others = siblings(ctx).filter((c) => c !== ctx && !c.stopped);
  if (others.length && ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  if (others.length) return closeContext(ctx, others.includes(ctx.creationOrigin) ? ctx.creationOrigin : others[0]);
  if (ctx.state.brainstorm || ctx.state.workbench || ctx.state.research) return closeDiscussion(ctx);
}

function cancelClose(ctx, name) {
  const c = shopOf(ctx).closing?.get(name);
  if (!c?.waiting) return false;
  c.cancelled = true;
  c.wake?.();
  return true;
}

// Restore a paused discussion in an isolated context, without switching any visible page to it.
async function closingContext(ctx, d) {
  const dir = join(ctx.cwd, 'discussions', d.section ?? '', d.name);
  const state = { transcript: [], seen: new Map(), ...(isWorkbenchDir(dir) && { workbench: true }), ...(isResearchDir(dir) && { research: true }) };
  const shadow = { ...ctx, state, discussion: null, sessions: new Map(), programs: { running: new Set(), stopping: false },
    screen: { clients: new Set(), transcript: state.transcript, worker: shopOf(ctx).log }, lastRound: null, logPath: null, checkpointError: null };
  const saved = readCheckpoint(ctx, d.name);
  if (saved && !saved.fresh) {
    const apply = await loadCheckpoint(shadow, saved, d.name, false, dir);
    apply();
  } else {
    Object.assign(shadow, await load(shadow, `?close=${Date.now()}`));
    shadow.discussion = { name: d.name, title: saved?.discussion?.title ?? d.name, dir, continued: true };
    shadow.state.briefing = shadow.state.workbench ? null : briefing(shadow);
  }
  return shadow;
}

async function pendingWorkLine(ctx, name) {
  const place = await lanePlace(ctx, name);
  if (place.disabled) return null;
  const s = await worktreeStatus(place);
  if (!s.exists) return null;
  const main = await mainRef(place.top);
  const ahead = Number(await git(place.top, 'rev-list', '--count', `${main}..${place.branch}`));
  const dirty = !!s.treeDirty;
  if (!ahead && !dirty) return null;
  const where = ctx.node || hostname();
  return `Worker work pending on ${where}: \`${place.branch}\`, ${plural(ahead, 'commit')} not in main, uncommitted edits: ${dirty ? 'yes' : 'no'}, worktree \`${place.path}\`.`;
}

async function closeNamedDiscussion(ctx, name, { extraLine = null, rethrow = false } = {}) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name);
  if (!d) { const msg = `No discussion "${name}".`; note(ctx, `✗ ${msg}`, true); if (rethrow) throw new Error(msg); return false; }
  const shop = shopOf(ctx), closing = shop.closing ??= new Map();
  if (closing.has(d.name)) { const msg = `${d.name} is already closing.`; note(ctx, `✗ ${msg}`, true); if (rethrow) throw new Error(msg); return false; }
  if (closedDiscussions(ctx).includes(d.name)) { const msg = `${d.name} is already closed.`; note(ctx, `✗ ${msg}`, true); if (rethrow) throw new Error(msg); return false; }
  const opened = siblings(ctx).find((c) => !c.stopped && isDiscussion(c, d.name));
  const blockedQueued = () => lanesOf(shop).flatMap((l) =>
    l.blockedBy ? l.tasks.filter((t) => t.owner === d.name && l.blockedBy.owner !== t.owner) : []);
  const checkBlocked = () => {
    const blocked = blockedQueued();
    if (!blocked.length) return;
    const names = blocked.map((t) => `"${firstLine(t.text)}"`).join(', ');
    throw new Error(`${blocked.length} worker ${blocked.length === 1 ? 'task is' : 'tasks are'} queued behind unresolved edits: remove them from the queue first (${names}).`);
  };
  const c = { waiting: true, cancelled: false, wake: null };
  closing.set(d.name, c);
  showHeader(ctx);
  try {
    checkBlocked();
    const tasks = [...runningTasks(shop), ...queuedTasks(shop)].filter((t) => t.owner === d.name && t.finished);
    let finished = !tasks.length;
    Promise.all(tasks.map((t) => t.finished)).then(() => { finished = true; c.wake?.(); });
    const pending = () => [...runningTasks(shop), ...queuedTasks(shop)].some((t) => t.owner === d.name);
    while ((!finished || pending()) && !c.cancelled) {
      if (!runningTasks(shop).some((t) => t.owner === d.name)) checkBlocked();
      await new Promise((resolve) => { c.wake = resolve; setTimeout(resolve, 100); });
    }
    c.wake = null;
    if (c.cancelled) { note(ctx, `Close cancelled for ${d.name}.`); return false; }
    if (ctx.stopped || opened?.stopped) throw new Error('The room stopped while Close was waiting.');
    c.waiting = false;
    showHeader(ctx);
    const target = opened ?? await closingContext(ctx, d);
    const workbench = !!target.state?.workbench || isWorkbenchDir(target.discussion?.dir);
    if (runningTasks(shop).some((t) => (t.owner ?? ownerOf(t.origin)) === ownerOf(target))) {
      throw new Error('This can\'t be closed yet: a worker task from it is running.');
    }
    if (target.checkpointError) throw new Error(`The latest checkpoint could not be saved: ${target.checkpointError}`);
    let writer = null, statement = null;
    if (!workbench) {
      const reports = shop.log.filter((m) => m.owner === d.name && m.speaker).map((m) => `${m.speaker}: ${m.html ?? m.text ?? ''}`).join('\n\n');
      // Written by the worker's provider and model as set for this discussion, not by its discussion
      // agents (`closingAgent`: a stand-in for tests).
      if (!target.closingStatement) throw new Error('No agent is available to write the closing statement: Reload or Restart, then close again.');
      const spec = parseSpec(target.workerSpec ?? 'claude', true);
      writer = `${spec.provider[0].toUpperCase() + spec.provider.slice(1)} (${modelLabel(spec.provider, spec.model)})`;
      note(ctx, `Closing ${d.name}: ${writer} is writing the closing statement…`);
      const onFormatNote = (text, err) => { log(target, `_(${text})_\n\n`); note(ctx, text, err); };
      try { statement = await target.closingStatement({ dir: target.discussion.dir, workerReports: reports, onFormatNote }, target.closingAgent?.()); }
      catch (err) { toScreen(ctx, { type: 'agent-failure', agent: writer, error: err.message }); throw err; }
    }
    const cleanupLine = extraLine ? null : await cleanupMergedOnClose(target, d.name).catch((err) => {
      const msg = `Worker worktree/branch cleanup failed (${err.message}): nothing removed.`;
      note(ctx, `✗ ${msg}`, true);
      return msg;
    });
    const appendedLine = workbench ? null : (extraLine ?? cleanupLine ?? await pendingWorkLine(target, d.name).catch(() => null));
    const body = workbench ? null : (appendedLine ? `${statement.trimEnd()}\n\n${appendedLine}\n` : `${statement}\n`);
    const file = join(target.discussion.dir, 'closing-statement.md');
    const temp = `${file}.${process.pid}.tmp`;
    const previous = !workbench && existsSync(file) ? readFileSync(file) : null;
    const checkpoint = readCheckpoint(ctx, d.name);
    const sessions = [...(target.sessions?.values() ?? [])].map((s) => [s, { ...s }]);
    let snapshot, markedClosed = false;
    try {
      if (!workbench) writeFileSync(temp, body);
      // CLI calls run one process per turn; the worker and closing turns have returned. Drop their
      // provider IDs without stopping another discussion's detached worker in this context.
      for (const [session] of sessions) for (const key of Object.keys(session)) delete session[key];
      if (checkpoint?.invalid) throw new Error('The discussion checkpoint is invalid.');
      if (checkpoint) {
        const wbWorker = workbench ? shop.log.filter((m) => m.origin === d.name) : null;
        writeCheckpoint(ctx, d.name, {
          ...checkpoint,
          ...(workbench && { workbench: true, ...(wbWorker?.length && { worker: wbWorker }) }),
          sessions: [],
          closedSessions: true,
        });
      }
      if (!workbench) renameSync(temp, file);
      if (target.replica && !workbench) {
        const conversation = target.state.transcript.map(({ speaker, text, error, pass, summary, outcome, by }) =>
          ({ speaker, text: String(text ?? ''), ...(error && { error }), ...(pass && { pass }), ...(summary && { summary: true }), ...(outcome && { outcome, by }) }));
        const r = target.replica, R = target.replicate;
        const capture = (r.s.captures ?? Promise.resolve()).then(() => R.capture(r.s, target.discussion,
          { kind: 'round', outcome: 'completed', ending: 'closed', summary: null, agents: currentSettings(target).agents, conversation }, { detached: true }));
        r.s.captures = capture.catch(() => {});
        snapshot = await capture;
      }
      setClosed(ctx, d.name, true, snapshot);
      markedClosed = true;
      if (snapshot) await target.replicate.publishCapture(target.replica.s, snapshot);
    } catch (err) {
      if (markedClosed) setClosed(ctx, d.name, false);
      let discardError;
      if (snapshot) try { await target.replicate.discardCapture(target.replica.s, snapshot); } catch (e) { discardError = e; }
      for (const [session, old] of sessions) { for (const key of Object.keys(session)) delete session[key]; Object.assign(session, old); }
      if (checkpoint && !checkpoint.invalid) writeCheckpoint(ctx, d.name, checkpoint);
      if (!workbench) {
        if (previous === null) { if (existsSync(file)) unlinkSync(file); }
        else writeFileSync(file, previous);
      }
      if (discardError) throw new Error(`${err.message}; could not discard the provisional snapshot: ${discardError.message}`);
      throw err;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    if (opened) {
      target.lastRound = null;
      const others = siblings(target).filter((x) => x !== target);
      const foreignWork = [...runningTasks(shop), ...queuedTasks(shop)].some((t) => t.origin === target && t.owner !== d.name);
      if (others.length && multi(target) && !target.replicaOwner && !foreignWork) closeContext(target, others[0]);
      else {
        if (others.length && multi(target)) goto(target, others[0]);
        endSession(target, workbench ? 'closing the workbench' : 'closing the discussion', (agent) => note(ctx, `${agent.name}'s ended session was reset for a new discussion.`));
        switchTo(target, null);
      }
    }
    note(ctx, workbench ? `Closed workbench ${d.name}.${(extraLine ?? cleanupLine) ? ` ${extraLine ?? cleanupLine}` : ''}` : `Closed ${d.name}. Closing statement written by ${writer}.`);
    if (snapshot) saveClosed(ctx, target, snapshot);
    return true;
  } catch (err) {
    note(ctx, `✗ Could not close ${d.name}: ${err.message}`, true);
    if (rethrow) throw err;
    return false;
  } finally {
    closing.delete(d.name);
    showHeader(ctx);
  }
}


return { SECTIONS, DATED, BRAINSTORMS, isWorkbenchDir, isWorkbenchName, workbenchNames, isResearchDir, researchNames, recordResearchLap, researchStats, isDiscussion, folderOf, discussionRef, moveDiscussion, requestRollback, confirmRollbackArchive, rollbackReport, openDiscussion, briefing, closedEntries, closedDiscussions, checkpoints, writeCheckpoint, readCheckpoint, captureRound, saveCheckpoint, workOf, persistWork, clock, firstLine, leftBehind, detachWorker, saveLeftWorker, peekDiscussion, resumeDiscussion, refOf, startFresh, convertBrainstormToResearch, convertResearchToDiscussion, convertBrainstorm, deleteBrainstorm, deleteResearch, newDiscussion, newBrainstorm, newWorkbench, newResearch, goto, openBeside, closeContext, newDiscussionBeside, newBrainstormBeside, newWorkbenchBeside, newResearchBeside, closeDiscussion, cancelCreation, cancelClose, closeNamedDiscussion, WORKBENCH_MARKER, RESEARCH_MARKER, createDiscussionFolder, createSessionFile };
}
