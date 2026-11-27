// Worker queue and auto dev; callbacks are bound by each reloaded room module.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createWorkshop({
  siblings, ownerOf, originLabel, toScreen, out, red, bold, dim, note, showHeader,
  workOf, persistWork, discussionRef, firstLine, clock, log, runRound, saveSettings,
  openDiscussion, leftBehind, rollbackReport, saveCheckpoint, saveLeftWorker, refreshQuota,
  isWorkbenchDir, defaultInstructions, defaultFormattedTurn, real, git, gitOk, labelledCommits,
  lanePlace, existingLanes, worktreeStatus, workerGitFacts, checkWorkerReport, NOTES, WORKER_BRANCH,
  plural, laneOf, refreshWorker, worktreeFingerprint, recordTested,
}) {
// The folder's workshop: its lanes (each with its own queue and hold), the discussions' directories
// a running task writes to, and the Worker tab's log.
function newShop(log) {
  return { lanes: new Map(), writing: new Set(), contexts: 0, log };
}
function shopOf(ctx) {
  if (ctx.shop) {
    ctx.screen.workerForPage = () => ctx.shop.log.filter((m) => visibleWorker(ctx, m));
    return ctx.shop;
  }
  const other = siblings(ctx).find((c) => c !== ctx && c.shop);
  ctx.shop = other?.shop ?? newShop(ctx.screen.worker);
  ctx.screen.worker = ctx.shop.log;
  ctx.screen.workerForPage = () => ctx.shop.log.filter((m) => visibleWorker(ctx, m));
  return ctx.shop;
}

// A lane's queue and hold (see "The worker queues"), by its discussion's name (null: worker/main's).
function laneState(shop, name) {
  const key = name ?? '';
  if (!shop.lanes.has(key)) shop.lanes.set(key, { name: name ?? null, tasks: [], running: null, blockedBy: null, holdContext: null, inspectionError: null, pumping: false, recheck: null });
  return shop.lanes.get(key);
}
// Exported for the tests: the lane of `ctx`'s discussion (or of `name`).
const workerLane = (ctx, name = laneOf(ctx)) => laneState(shopOf(ctx), name);
const lanesOf = (shop) => [...(shop.lanes?.values() ?? [])];
const runningTasks = (shop) => lanesOf(shop).map((l) => l.running).filter(Boolean);
const queuedTasks = (shop) => lanesOf(shop).flatMap((l) => l.tasks);
// Room-wide messages are retained only for contexts open when they were emitted.
const visibleWorker = (ctx, m) => m.owner === ownerOf(ctx) || (m.room && m.recipients?.includes(ownerOf(ctx)));
const toShop = (ctx, event) => { for (const c of siblings(ctx)) if (c.screen && visibleWorker(c, event.message)) toScreen(c, event); };
function workNote(ctx, text, error = false, origin = null, owner = ownerOf(ctx), room = false) {
  const view = { note: text, error, ...(origin && { origin }), ...(room ? { room: true, recipients: siblings(ctx).map(ownerOf) } : { owner }) };
  shopOf(ctx).log.push(view);
  toShop(ctx, { type: 'work', message: view });
  out(ctx, error ? red(text) : text);
}

// Why `c` can't be closed (or its folder moved): it holds unresolved worker edits, or its task runs.
function workerHold(c) {
  const shop = shopOf(c);
  const held = lanesOf(shop).map((l) => l.blockedBy).find((b) => b && (b.owner ? b.owner === ownerOf(c) : b.label === originLabel(c)));
  if (held) return `its worker edits from "${held.task}" are unresolved: ask the worker to finish and commit them, or to abandon them`;
  if (runningTasks(shop).some((t) => (t.owner ?? ownerOf(t.origin)) === ownerOf(c))) return 'a worker task from it is running';
  return null;
}

// ── The worker queues ─────────────────────────────────────────────────
// Each lane (see "The worker's worktrees") has its own queue: its tasks run one at a time, in the
// order sent. Different lanes run at the same time, at most PARALLEL_WORKERS tasks in the folder,
// and never two of one worker session (one discussion's context) at once. agent-room checks a lane's
// worktree after each of its tasks and again before the next: uncommitted edits hold that lane
// (lane.blockedBy) until their origin resolves them; that origin's own tasks still go through (to
// finish or abandon them), and keep the original task's details. Edits whose origin is unknown
// (without a valid saved owner) hold that lane until it is clean. Other lanes go on.
const PARALLEL_WORKERS = 2; // decided by the User, 2026-11-12
// The private, per-worktree Git directory is outside both working copies and their indexes.
async function ownerFile(place) {
  return join(await git(place.path, 'rev-parse', '--absolute-git-dir'), 'agent-room-task.json');
}
async function leftovers(ctx, place) {
  if (place.disabled) return false;
  let s;
  const shop = shopOf(ctx), lane = laneState(shop, place.lane);
  try { s = await worktreeStatus(place); }
  catch (err) {
    // Unknown is neither clean nor dirty: even the holding origin's recovery must wait.
    const origin = lane.blockedBy?.origin ?? lane.running?.origin ?? ctx;
    if (lane.inspectionError?.message !== err.message || lane.inspectionError?.origin !== origin) {
      const text = `✗ Worker worktree inspection failed: ${err.message} (${place.branch}). This lane's dispatch, including recovery, waits until inspection succeeds; other lanes go on.`;
      workNote(ctx, text, true, null, lane.blockedBy?.owner ?? lane.running?.owner ?? ownerOf(origin));
      note(origin, text, true);
    }
    lane.inspectionError = { message: err.message, origin, place };
    if (!lane.pumping) watchLane(shop, lane);
    return null;
  }
  lane.inspectionError = null;
  if (!s.exists) return false;
  if (!s.treeDirty) {
    const file = await ownerFile(place);
    if (existsSync(file)) {
      const owner = await recordedOwner(ctx, place);
      if (owner.before) rememberCommits(shopOf(ctx), await labelledCommits(place.path, `${owner.before}..HEAD`));
    }
    try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return !!s.treeDirty;
}
async function recordedOwner(ctx, place) {
  try {
    if (place.disabled) return { origin: null };
    const r = JSON.parse(readFileSync(await ownerFile(place), 'utf8'));
    if (r.version !== 1 || r.root !== real(ctx.cwd) || typeof r.label !== 'string' ||
        typeof r.task !== 'string' || !r.task.trim() || typeof r.before !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(r.before) || !await gitOk(place.path, 'cat-file', '-e', `${r.before}^{commit}`)) return { origin: null };
    const origin = siblings(ctx).find((c) => !c.stopped && (r.label === 'brainstorm'
      ? c.state.brainstorm && typeof r.brainstormId === 'string' && c.state.brainstormId === r.brainstormId : c.discussion?.name === r.label && existsSync(c.discussion.dir)));
    const exists = r.label !== 'brainstorm' && [r.label, `archive/${r.label}`, `deferred/${r.label}`]
      .some((ref) => discussionRef(join(ctx.cwd, 'discussions'), ref));
    const owner = r.label === 'brainstorm' ? (typeof r.brainstormId === 'string' ? `brainstorm:${r.brainstormId}` : null) : r.label;
    return origin || exists ? { origin: origin ?? null, owner, label: r.label, task: r.task, before: r.before } : { origin: null };
  } catch { return { origin: null }; }
}
// Restart creates each context before reopening its discussion; try again after that restoration.
// One lane's worktree (`place`): its hold is set, kept or released. False: it couldn't be read.
async function recoverLane(ctx, lane, place) {
  if (lane.running) return true;
  const dirty = await leftovers(ctx, place);
  if (dirty === null) return false;
  if (dirty) {
    if (lane.blockedBy?.origin) return true;
    const owner = await recordedOwner(ctx, place);
    if (!lane.blockedBy || owner.origin) hold(ctx, { ...owner, place });
  } else if (lane.blockedBy) release(ctx, lane);
  return true;
}
// Every lane (at start, before a move), or only lane `name`. False: a worktree couldn't be read.
async function recoverWorkerOwner(ctx, name) {
  const shop = shopOf(ctx);
  const places = name !== undefined ? [await lanePlace(ctx, name)]
    : [...await existingLanes(ctx), ...lanesOf(shop).filter((l) => l.blockedBy).map((l) => l.blockedBy.place)];
  let ok = true;
  const done = new Set();
  for (const place of places) {
    if (place.disabled || done.has(place.path)) continue;
    done.add(place.path);
    if (!await recoverLane(ctx, laneState(shop, place.lane), place)) ok = false;
  }
  return ok;
}
function rememberCommits(shop, commits) {
  const completed = shop.completed ??= [];
  const ids = new Set(completed.map((c) => c.id));
  for (const c of commits) if (!ids.has(c.id)) { completed.push(c); ids.add(c.id); }
}
function workNotice(ctx) {
  if (!ctx.discussion || ctx.state.brainstorm) return; // a brainstorm sends no work
  const shop = shopOf(ctx), reported = shop.reported ??= new Map();
  if (!reported.has(originLabel(ctx))) reported.set(originLabel(ctx), new Set());
  const seen = reported.get(originLabel(ctx));
  const pending = (shop.completed ?? []).filter((c) => c.origin !== originLabel(ctx) && !seen.has(c.id));
  if (!pending.length) return;
  const text = `Work finished elsewhere: ${pending.map((c) => `[${c.origin}] ${c.id} (${c.files.join(', ') || 'no files changed'})`).join(' · ')}`;
  const m = { speaker: 'agent-room', text };
  ctx.state.transcript.push(m);
  log(ctx, `**${m.speaker}**\n\n${text}\n\n`);
  toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) });
  for (const c of pending) seen.add(c.id);
}

function hold(ctx, blockedBy) {
  const shop = shopOf(ctx), lane = laneState(shop, blockedBy.place.lane);
  lane.blockedBy = blockedBy;
  lane.holdContext = ctx;
  const where = blockedBy.label ? `[${blockedBy.label}]` : 'an unknown origin';
  workNote(ctx, `✗ The worker's folder ${blockedBy.place.path} (${blockedBy.place.branch}) has uncommitted edits from ${where}${blockedBy.task ? ` ("${blockedBy.task}")` : ''}: its queue holds${blockedBy.label ? ` until [${blockedBy.label}] resolves them (its own instructions still go through)` : ' until the folder is clean (commit or remove those edits yourself)'}; other lanes go on.`, true, null, blockedBy.owner ?? (blockedBy.place.lane || ownerOf(ctx)));
  if (blockedBy.origin) note(blockedBy.origin, `✗ The worker left uncommitted edits from "${blockedBy.task}": the worker lane of [${blockedBy.label}] holds them until they are resolved (other sprints' tasks go on). Ask the worker to finish and commit them, or to abandon the attempt (it lists the edits and waits for your approval).`, true);
  showHeader(ctx);
  if (!lane.pumping) watchLane(shop, lane);
}
function release(ctx, lane) {
  const was = lane.blockedBy;
  lane.blockedBy = null;
  workNote(ctx, `The worker's folder ${was.place.path} is clean again: its queue resumes.`, false, null, was.owner ?? (was.place.lane || ownerOf(ctx)));
  if (was?.origin) note(was.origin, 'The worker\'s folder is clean again: this sprint\'s worker tasks resume.');
  showHeader(ctx);
}
// Starts every lane that has work and may run. A lane that can't start for lack of a free place
// says so once per task, in the Worker tab; it starts as soon as another task ends.
async function pump(shop) {
  if (shop.confirming) return;
  await Promise.all(lanesOf(shop).map((lane) => pumpLane(shop, lane).catch((err) => {
    const c = lane.tasks[0]?.origin ?? lane.holdContext;
    if (c) note(c, `✗ ${err.stack}\n`, true);
  })));
}
async function pumpLane(shop, lane) {
  if (lane.pumping || shop.confirming) return;
  lane.pumping = true;
  try {
    // A hold (or an unreadable worktree) is rechecked even without queued tasks.
    const holder = lane.holdContext ?? lane.inspectionError?.origin;
    if ((lane.blockedBy || lane.inspectionError) && !lane.running && holder &&
        !await recoverLane(holder, lane, lane.blockedBy?.place ?? lane.inspectionError.place)) return;
    while (!lane.running && lane.tasks.length) {
      for (const t of lane.tasks.filter((x) => x.origin.stopped)) dropTask(shop, t);
      const any = lane.tasks[0]?.origin;
      if (!any) break;
      // Before the next task: is the lane's worktree clean?
      const place = await lanePlace(any, lane.name);
      if (!place.disabled && !await recoverLane(any, lane, place)) break;
      const t = !lane.blockedBy ? lane.tasks[0] : lane.blockedBy.owner && lane.tasks.find((x) => x.owner === lane.blockedBy.owner);
      if (!t) break; // held
      // A free place in the folder, and its worker session neither busy in another lane nor owing an
      // earlier task there (no await between this check and taking the place, so two lanes can't
      // both take the last one).
      const running = runningTasks(shop);
      const earlier = queuedTasks(shop).some((x) => x.origin === t.origin && x.sent < t.sent);
      if (running.length >= PARALLEL_WORKERS || running.some((r) => r.origin === t.origin) || earlier) {
        if (!t.waitNoted && running.length >= PARALLEL_WORKERS) {
          t.waitNoted = true;
          workNote(t.origin, `[${t.label}] "${firstLine(t.text)}" waits for a free place: ${plural(running.length, 'worker task')} running, at most ${PARALLEL_WORKERS} at once.`, false, t.label, t.owner);
        }
        break;
      }
      lane.tasks.splice(lane.tasks.indexOf(t), 1);
      t.origin.workPending--;
      lane.running = t;
      const recovery = lane.blockedBy?.owner && lane.blockedBy.owner === t.owner ? lane.blockedBy : null;
      try { t.before = await runWork(t.origin, t.text, t.run, t.cycle, recovery, t.rollback, t, recovery ? recovery.place : place); }
      catch (err) { note(t.origin, `✗ ${err.stack}\n`, true); }
      finally { lane.running = null; showHeader(t.origin); } // its stop buttons go
      // After it: edits left uncommitted hold the lane; a recovery keeps the first task's details.
      try {
        const dirty = place.disabled ? false : await leftovers(t.origin, place);
        // Its own discussion's: the task's owner and label, not the discussion the context shows now.
        if (dirty === true) { if (!lane.blockedBy) hold(t.origin, { origin: t.origin, owner: t.owner, label: t.label, task: t.text, before: t.before, place }); }
        else if (dirty === false && lane.blockedBy) release(t.origin, lane);
      } catch (err) { note(t.origin, `✗ ${err.message}`, true); }
      await refreshWorker(t.origin).catch(() => {}); // lane.running is null and hold/release settled: Close actions & Worker tab see final state
      t.done();
      // A place is free: the lanes waiting for one can start.
      for (const other of lanesOf(shop)) if (other !== lane && other.tasks.length && !other.running) pumpLane(shop, other).catch(() => {});
    }
  } finally { lane.pumping = false; watchLane(shop, lane); }
}
// Recheck holds even without queued tasks, so cleaning up by hand removes the record and hold.
function watchLane(shop, lane) {
  if ((lane.tasks.length || lane.blockedBy || lane.inspectionError) && !lane.running && !lane.recheck) {
    lane.recheck = setTimeout(() => { lane.recheck = null; pumpLane(shop, lane).catch(() => {}); }, 2000);
    lane.recheck.unref?.();
  }
}

function dropTask(shop, t) {
  const lane = laneState(shop, t.lane);
  lane.tasks.splice(lane.tasks.indexOf(t), 1);
  if (t.rollback) { t.rollback.status = 'needs review'; t.rollback.report = 'The rollback task was not started.'; showHeader(t.origin); }
  if (t.record) { // reported as not started when the discussion is resumed
    const w = workOf(shop, t.workName);
    w.queued = w.queued.filter((r) => r.id !== t.record.id);
    w.notStarted.push(t.record);
    persistWork(t.origin, t.workName);
  }
  t.origin.workPending--;
  t.origin.workSkipped = (t.origin.workSkipped ?? 0) + 1;
  t.done();
}

// ── Stopping a discussion's worker ──────────────────────────────────
// The Worker tab's two buttons, for the shown discussion's worker while it runs an instruction
// (other discussions' workers and the room's agents go on). Both cancel this discussion's queued
// instructions at once (before anything awaits, so none can start meanwhile) and pause a running
// auto dev. 'after' (Stop after this task): the running instruction finishes and is reported as
// usual. 'now' (Stop now): its process group is killed, or, while its worktree is prepared, its
// worker never starts; runWork then reports what it left (leftBehind), without Retry.
function stopWorker(ctx, mode) {
  if (mode !== 'after' && mode !== 'now') throw new Error('Unknown stop: use "after" or "now".');
  const shop = shopOf(ctx), owner = ownerOf(ctx);
  const t = runningTasks(shop).find((x) => x.owner === owner);
  const cancelled = queuedTasks(shop).filter((x) => x.owner === owner).sort((a, b) => a.sent - b.sent);
  for (const x of cancelled) cancelTask(shop, x);
  if (t && mode === 'after') t.stopAfter = true;
  if (t && mode === 'now') {
    t.stopNow = true;
    if (t.programs) {
      t.programs.stopped = true;
      for (const p of t.programs.running) { try { (p.stopGroup ? p.stopGroup('SIGKILL') : p.kill('SIGKILL')); } catch {} } // one that never spawned has no group
    }
  }
  const label = t?.label ?? originLabel(ctx);
  workNote(ctx, !t ? `No instruction from [${label}] was running.${cancelled.length ? '' : ' Nothing was stopped.'}`
    : mode === 'now' ? `Stop now: [${label}] "${firstLine(t.text)}" is being stopped; what it left follows.`
      : `Stop after this task: [${label}] "${firstLine(t.text)}" finishes and is reported as usual; nothing more from this sprint runs after it.`, false, label, owner);
  for (const x of cancelled) {
    const view = { ...ctx.docs.messageView({ speaker: 'agent-room', text: `Not started, cancelled by the stop: [${x.label}] instruction sent ${x.record ? clock(x.record.at) : 'earlier'}. Its full text, to send again if still wanted:\n\n${x.retry?.text ?? x.text}` }), origin: x.label, owner };
    shop.log.push(view);
    toShop(ctx, { type: 'work', message: view });
  }
  if (ctx.autoDev?.status === 'running') pauseAutoDev(ctx, mode === 'now' ? 'you stopped the worker' : 'you asked the worker to stop after this task');
  showHeader(ctx);
}
// A queued task the User's stop cancelled: reported at once (stopWorker), so not kept as "not started".
function cancelTask(shop, t) {
  const lane = laneState(shop, t.lane);
  lane.tasks.splice(lane.tasks.indexOf(t), 1);
  if (t.rollback) { t.rollback.status = 'needs review'; t.rollback.report = 'The rollback task was cancelled by a stop before it started.'; showHeader(t.origin); }
  if (t.run && t.origin.autoDev === t.run) t.run.waiting = false;
  if (t.record) {
    const w = workOf(shop, t.workName);
    w.queued = w.queued.filter((r) => r.id !== t.record.id);
    persistWork(t.origin, t.workName);
  }
  t.origin.workPending--;
  t.done();
}
// Stop now's report in the discussion's chat too (so its agents learn it), while it is shown. A
// round in progress takes it in its own time (as reportBack's failures).
function stopReport(ctx, owner, logPath, text) {
  if (ownerOf(ctx) !== owner || ctx.logPath !== logPath || ctx.stopped) return;
  const message = { speaker: 'agent-room', text };
  if (ctx.busy && ctx.say) {
    (ctx.workerFailures ??= []).push({ message, owner });
    ctx.say(AUTO_DEV_FAILURE);
  } else ctx.state.transcript.push(message);
  log(ctx, `**${message.speaker}**\n\n${text}\n\n`);
  toScreen(ctx, { type: 'message', message: ctx.docs.messageView(message) });
}

// ── Auto dev ────────────────────────────────────────────────────────
// Start auto dev (/autodev) sends the latest agreed summary's instruction to the worker; its reply
// comes back as a "Worker report" that starts a round, always followed by an auto-summary whose last
// line decides: SEND (the next instruction, once per report), FINISH or WAIT FOR USER. At most
// a plan-based limit (default AUTO_DEV_CYCLES). ctx.autoDev: { status: 'running' | 'paused' | 'finished',
// cycle, limit, lastSteps, reason, waiting (a relay at the worker), report (its reply, until its round) }, in ctx so
// it survives a Reload; ctx.autoDevSent: the summaries already sent (transcript indexes) this session.
const AUTO_DEV_CYCLES = 5;
const AUTO_DEV_REPORT = '/autodev report';
const AUTO_DEV_FAILURE = '/autodev failure';
const AUTO_DEV_MEANS = 'FINISH: development is complete and reviewed; only the User\'s merge, Reload or live trial may remain. '
  + 'WAIT FOR USER: the User must answer or act before development can continue.';
const autoDevTask = (run) => [
  `Auto dev is running (worker cycle ${run.cycle} of at most ${run.limit ?? AUTO_DEV_CYCLES}): an agreed summary can send its Next step instruction to the Worker by itself.`,
  'Passing on a version accepts its quoted instruction for the worker exactly as it stands.',
  'End the summary with one last line: Outcome: SEND, Outcome: FINISH or Outcome: WAIT FOR USER.',
  'SEND sends the Next step\'s "Send to the Worker" instruction now: say it only when you mean to send it (repeating earlier text is a deliberate retry).',
  'When the Next step sends one step of a planned series, put a line Steps left: N just before the Outcome line, outside the instruction, counting the step being sent. When N is higher than the last one given, the cycle limit becomes cycles used + N + 2 (at most 15); otherwise it stays or falls, so fix rounds use up its slack.',
  AUTO_DEV_MEANS,
].join('\n');
// While a run is paused, any summary may end it: it can only say FINISH or WAIT FOR USER, and sends nothing.
const pausedTask = (run) => [
  `Auto dev is paused (${run.reason}): this summary sends nothing to the Worker.`,
  'End the summary with one last line: Outcome: FINISH or Outcome: WAIT FOR USER.',
  AUTO_DEV_MEANS,
].join('\n');

// The instruction in a summary's Next step: { text }, { error } when it can't be read reliably, or
// null when there is none. Two forms: `Send to the Worker: "…"`, whose text runs to the last
// quotation mark before the next section (**Later**) or the Outcome line, so it may hold quotes and
// paragraphs; or the label alone on its line, followed (blank lines allowed) by one contiguous
// Markdown block quote, whose lines lose their `>` and one following space.
const BLOCK_LABEL = /^\s*(?:[-*]\s+)?\*{0,2}Send to the Worker\*{0,2}:\*{0,2}\s*$/i;
const INLINE_OPEN = /\*{0,2}Send to the Worker\*{0,2}:\*{0,2}[ \t]*["“]/gi;
const INLINE_PREFIX = /^\*{0,2}Send to the Worker\*{0,2}:\*{0,2}[ \t]*["“]/i;
const NEXT_STEP_END = (l) => /^\s*(?:#+\s*(?:\*\*)?|\*\*)Later:?(\*\*)?[\s:]*$/i.test(l) || /^[\s*_`]*Outcome\b[\s*_`]*:/i.test(l);
const STEPS_LINE = (l) => /^Steps left:\s*\d+$/i.test(l.replace(/[*_`]/g, '').trim());
const QUOTED = /^\s*>/;
function summaryInstruction(summary) {
  const { start, sectionLines, blocks } = nextStepBlocks(summary);
  if (start < 0) return /Send to the Worker\*{0,2}:/i.test(summary ?? '') ? { error: 'its "Send to the Worker" line isn\'t under a Next step heading' } : null;
  const inBlock = (i) => blocks.some((b) => i === b.label || (i >= b.from && i < b.to));
  const section = sectionLines.filter((l, i) => !inBlock(i)).join('\n');
  const unquoted = sectionLines.filter((l, i) => !inBlock(i) && !QUOTED.test(l)).join('\n');
  const marks = unquoted.match(INLINE_OPEN)?.length ?? 0;
  if (marks + blocks.length > 1) return { error: 'its Next step holds more than one instruction for the worker' };
  if (blocks.length) {
    const b = blocks[0];
    if (sectionLines.slice(b.to).some((l) => QUOTED.test(l))) return { error: 'its block-quoted instruction is broken by lines that aren\'t quoted' };
    const trailing = sectionLines.slice(b.to).filter((l) => l.trim());
    if (trailing.length > 1 || (trailing.length === 1 && !STEPS_LINE(trailing[0])))
      return { error: 'its block-quoted instruction is followed by unquoted lines' };
    const quoted = sectionLines.slice(b.from, b.to).map((l) => l.replace(/^\s*> ?/, ''));
    while (quoted.length && !quoted[0].trim()) quoted.shift();
    while (quoted.length && !quoted.at(-1).trim()) quoted.pop();
    const text = quoted.join('\n');
    return text ? { text } : { error: 'its block-quoted instruction is empty' };
  }
  if (!marks) return /Send to the Worker/i.test(section) ? { error: 'its Next step has no quoted instruction (Send to the Worker: "…", or the label alone followed by a > block quote)' } : null;
  const after = section.slice(section.search(INLINE_OPEN)).replace(INLINE_PREFIX, '');
  const close = Math.max(after.lastIndexOf('"'), after.lastIndexOf('”'));
  if (close < 0) return { error: 'its quoted instruction has no closing quotation mark' };
  const text = after.slice(0, close).trim();
  return text ? { text } : { error: 'its quoted instruction is empty' };
}
// The summary's last line: 'SEND', 'FINISH', 'WAIT FOR USER', or null.
function summaryOutcome(summary) {
  const last = String(summary ?? '').trim().split('\n').at(-1).replace(/[*_`]/g, '').trim();
  return /^Outcome:\s*(SEND|FINISH|WAIT FOR USER)\.?$/i.exec(last)?.[1].toUpperCase() ?? null;
}
// Metadata is only the last non-empty line before a valid final Outcome, outside a quoted instruction.
function summarySteps(summary) {
  if (!summaryOutcome(summary)) return null;
  const lines = String(summary).trim().split('\n');
  let i = lines.length - 2;
  while (i >= 0 && !lines[i].trim()) i--;
  const match = /^Steps left:\s*(\d+)$/i.exec((lines[i] ?? '').replace(/[*_`]/g, '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}
function nextStepBlocks(summary) {
  const lines = String(summary ?? '').split('\n');
  const start = lines.findIndex((l) => /^[\s*_#-]*Next step[\s*_:]*$/i.test(l));
  if (start < 0) return { lines, start, end: lines.length, sectionLines: [], blocks: [] };
  let end = lines.findIndex((l, i) => i > start && NEXT_STEP_END(l));
  if (end < 0) end = lines.length;
  const sectionLines = lines.slice(start + 1, end);
  const blocks = [];
  sectionLines.forEach((l, i) => {
    if (!BLOCK_LABEL.test(l)) return;
    let j = i + 1;
    while (j < sectionLines.length && !sectionLines[j].trim()) j++;
    const from = j;
    while (j < sectionLines.length && QUOTED.test(sectionLines[j])) j++;
    if (j > from) blocks.push({ label: i, from, to: j });
  });
  return { lines, start, end, sectionLines, blocks };
}
function summaryHasNextStep(summary) {
  const { start, sectionLines } = nextStepBlocks(summary);
  return start >= 0 && sectionLines.some((l) => l.trim() && !STEPS_LINE(l));
}
function isInlineMultiLineInstruction(summary, instr) {
  if (!instr?.text || !instr.text.includes('\n')) return false;
  return nextStepBlocks(summary).blocks.length === 0;
}
function linesOutsideInstruction(summary) {
  const { lines, start, end, sectionLines, blocks } = nextStepBlocks(summary);
  if (start < 0) return lines;
  if (blocks.length === 1) {
    const b = blocks[0];
    return [...lines.slice(0, start + 1 + b.from), ...lines.slice(start + 1 + b.to)];
  }
  const section = sectionLines.join('\n');
  const openIdx = section.search(INLINE_OPEN);
  if (openIdx < 0) return lines;
  const closeIdx = Math.max(section.lastIndexOf('"'), section.lastIndexOf('”'));
  if (closeIdx <= openIdx) return lines;
  const strippedSection = (section.slice(0, openIdx) + section.slice(closeIdx + 1)).split('\n');
  return [...lines.slice(0, start + 1), ...strippedSection, ...lines.slice(end)];
}
// Checks a newly drafted or revised summary before other agents review it. Returns a list of problems.
function checkSummary(summary, { autoDev = null, noWorker = false } = {}) {
  const mode = typeof autoDev === 'string' ? autoDev : autoDev?.status ?? null;
  const problems = [];
  const instr = summaryInstruction(summary);
  if (noWorker && instr) {
    problems.push('a research board has no worker (use Answer or Do in Next step, never Send to the Worker)');
  } else if (instr?.error) problems.push(instr.error);
  else if (isInlineMultiLineInstruction(summary, instr)) {
    problems.push('its Next step uses inline quotes for a multi-line instruction (use "Send to the Worker:" alone on its line followed by a > block quote)');
  }
  if (mode === 'running') {
    const outcome = summaryOutcome(summary);
    if (!outcome) problems.push('the summary has no Outcome line (end with Outcome: SEND, Outcome: FINISH or Outcome: WAIT FOR USER)');
    else if (outcome === 'SEND' && !instr) problems.push('the summary says SEND, but its Next step has no instruction for the worker');
    const stepsLines = linesOutsideInstruction(summary).filter((l) => /^[\s*_`-]*Steps left:/i.test(l));
    if (stepsLines.length > 0 && (stepsLines.length > 1 || summarySteps(summary) === null)) {
      problems.push('Steps left: must be a whole number above 0 just before the Outcome line');
    }
  } else if (mode === 'paused') {
    const outcome = summaryOutcome(summary);
    if (outcome === 'SEND') problems.push('auto dev is paused: Outcome must be FINISH or WAIT FOR USER, not SEND');
    else if (!outcome) problems.push('the summary has no Outcome line (end with Outcome: FINISH or Outcome: WAIT FOR USER)');
  }
  return problems;
}
function latestAgreed(ctx) {
  const t = ctx.state.transcript;
  for (let i = t.length - 1; i >= 0; i--) if (t[i].outcome === 'agreed') return { index: i, instruction: summaryInstruction(t[i].text), steps: summarySteps(t[i].text) };
  return null;
}
// What the page offers: the latest agreed summary's instruction, unless it was sent (or a run is
// going, or this is no saved discussion): { text } with a Start or Restart button, or { error }.
function autoDevOffer(ctx) {
  if (!ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.state.research || ctx.autoDev?.status === 'running') return null;
  const s = latestAgreed(ctx);
  return s && !(ctx.autoDevSent ?? []).includes(s.index) ? s.instruction : null;
}
function autoDevView(ctx) {
  const run = ctx.autoDev;
  return { status: run?.status ?? null, cycle: run?.cycle ?? 0, max: run?.limit ?? AUTO_DEV_CYCLES, reason: run?.reason ?? null, waiting: !!run?.waiting, offer: autoDevOffer(ctx) };
}

// /autodev: Start or Restart from the latest agreed summary.
function startAutoDev(ctx) {
  const s = latestAgreed(ctx);
  const why = ctx.state.brainstorm ? 'auto dev is for sprints; a brainstorm keeps no saved record'
    : ctx.state.workbench ? 'auto dev is not used on a workbench'
    : ctx.state.research ? 'auto dev is not used on a research board'
    : !ctx.logPath ? 'it needs a started sprint'
    : !ctx.say ? 'it works from the browser screen'
    : ctx.autoDev?.status === 'running' ? 'it is already running'
    : ctx.screen.workerInfo?.disabled ? ctx.screen.workerInfo.lines[0]
    : !s ? 'there is no agreed summary yet'
    : (ctx.autoDevSent ?? []).includes(s.index) ? 'the latest agreed summary\'s instruction was already sent'
    : !s.instruction ? 'the latest agreed summary has no instruction for the worker'
    : s.instruction.error ?? null;
  if (why) return note(ctx, `✗ Auto dev can't start: ${why}.`, true);
  ctx.workReady = false;
  ctx.autoDev = { status: 'running', cycle: 0, limit: s.steps === null ? AUTO_DEV_CYCLES : Math.min(15, s.steps + 2), lastSteps: s.steps, reason: null, waiting: false, report: null };
  log(ctx, `_(auto dev started: up to ${ctx.autoDev.limit} worker cycles)_\n\n`);
  note(ctx, `Auto dev started: up to ${ctx.autoDev.limit} worker cycles.`);
  relay(ctx, s);
}
function relay(ctx, s) {
  const run = ctx.autoDev;
  run.cycle++;
  run.waiting = true;
  (ctx.autoDevSent ??= []).push(s.index);
  // The agents learn it was sent (it is no longer "sending unconfirmed"): a notice in the
  // conversation, which they receive, the transcript keeps and the page shows. relay() runs between
  // rounds (from the room's input), so the notice never lands in the middle of one.
  const notice = { speaker: 'Auto dev', text: `Auto dev sent the instruction "${s.instruction.text.split('\n')[0].trim()}" to the Worker (cycle ${run.cycle} of ${run.limit ?? AUTO_DEV_CYCLES}).` };
  ctx.state.transcript.push(notice);
  log(ctx, `**${notice.speaker}**\n\n${notice.text}\n\n`);
  toScreen(ctx, { type: 'message', message: ctx.docs.messageView(notice) });
  showHeader(ctx);
  queueWork(ctx, s.instruction.text, run);
}
// The User typed something: a running auto dev pauses. A worker already running finishes, and its
// report is still shown and discussed, but nothing more is sent.
function autoDevInput(ctx, why) {
  if (ctx.workReady) {
    ctx.workReady = false;
    if (ctx.autoDev?.status !== 'running') showHeader(ctx);
  }
  if (ctx.autoDev?.status === 'running') pauseAutoDev(ctx, why);
}
function pauseAutoDev(ctx, reason) {
  const run = ctx.autoDev;
  if (!run || run.status !== 'running') return;
  Object.assign(run, { status: 'paused', reason });
  log(ctx, `_(auto dev paused: ${reason})_\n\n`);
  note(ctx, `Auto dev paused: ${reason}.`);
  showHeader(ctx);
}
// A failure is added to the conversation without starting a round. A reply is queued as a report;
// only a retry may report after its original run has ended or been replaced.
function reportBack(ctx, run, entry, retry = false) {
  if (entry.error) {
    if (ctx.autoDev !== run || ctx.stopped) return;
    run.waiting = false;
    if (run.status === 'running') pauseAutoDev(ctx, 'the worker failed: Retry or Retry with…');
    else if (run.status === 'paused') { run.reason = 'the worker failed: Retry or Retry with…'; showHeader(ctx); }
    else return;
    const message = { speaker: 'Worker report', text: `The worker's attempt failed: ${entry.text}` };
    // A turn already in progress must not mark this new message as seen before its agent received it.
    if (ctx.busy && ctx.say) {
      (ctx.workerFailures ??= []).push({ message, owner: ownerOf(ctx) });
      ctx.say(AUTO_DEV_FAILURE);
    } else ctx.state.transcript.push(message);
    log(ctx, `**${message.speaker}**\n\n${message.text}\n\n`);
    toScreen(ctx, { type: 'message', message: ctx.docs.messageView(message) });
    return;
  }
  if (ctx.autoDev !== run && !retry) return;
  if (ctx.autoDev === run) {
    run.waiting = false;
    if (retry && run.status === 'paused' && run.reason === 'the worker failed: Retry or Retry with…') Object.assign(run, { status: 'running', reason: null });
  }
  (ctx.workerReports ??= []).push({ text: entry.text, run, retry, owner: ownerOf(ctx) });
  showHeader(ctx);
  if (ctx.say) ctx.say(AUTO_DEV_REPORT);
}
async function autoDevReport(ctx) {
  const report = ctx.workerReports?.shift();
  if (!report || report.owner !== ownerOf(ctx) || (!report.retry && ctx.autoDev !== report.run)) return;
  await runRound(report.text, ctx, { speaker: 'Worker report', run: ctx.autoDev === report.run && report.run.status === 'running' ? report.run : null });
}
function finishAutoDev(ctx, run) {
  Object.assign(run, { status: 'finished', reason: null });
  ctx.workReady = !ctx.state.brainstorm && !ctx.state.workbench;
  log(ctx, '_(auto dev finished)_\n\n');
  note(ctx, `Auto dev finished. Review and merge ${laneOf(ctx) ? `worker/${laneOf(ctx)}` : WORKER_BRANCH} yourself.`);
  showHeader(ctx);
}
// After a report's round and its summary: send the next instruction, or stop.
function decide(ctx, run, status) {
  if (ctx.autoDev !== run || run.status !== 'running') return;
  const result = ctx.state.transcript.at(-1);
  if (status === 'failed') return pauseAutoDev(ctx, 'a summary turn failed');
  if (status !== 'agreed' || result?.outcome !== 'agreed') return pauseAutoDev(ctx, status === 'empty' ? 'the summary was empty' : 'the summary was not agreed');
  const outcome = summaryOutcome(result.text);
  if (outcome === 'FINISH') return finishAutoDev(ctx, run);
  if (outcome === 'WAIT FOR USER') return pauseAutoDev(ctx, 'the discussion waits for you (WAIT FOR USER)');
  if (outcome !== 'SEND') return pauseAutoDev(ctx, 'the summary has no Outcome line');
  const s = { index: ctx.state.transcript.length - 1, instruction: summaryInstruction(result.text) };
  if (!s.instruction) return pauseAutoDev(ctx, 'the summary says SEND, but its Next step has no instruction for the worker');
  if (s.instruction.error) return pauseAutoDev(ctx, `the instruction can't be sent: ${s.instruction.error}`);
  if (isInlineMultiLineInstruction(result.text, s.instruction)) {
    return pauseAutoDev(ctx, 'the instruction can\'t be sent: its Next step uses inline quotes for a multi-line instruction (use "Send to the Worker:" alone on its line followed by a > block quote)');
  }
  const steps = summarySteps(result.text);
  if (steps !== null) {
    const proposed = Math.min(15, run.cycle + steps + 2);
    run.limit = run.lastSteps == null || steps > run.lastSteps ? proposed : Math.min(run.limit ?? AUTO_DEV_CYCLES, proposed);
    run.lastSteps = steps;
  }
  if (run.cycle >= (run.limit ?? AUTO_DEV_CYCLES)) return pauseAutoDev(ctx, `${run.limit ?? AUTO_DEV_CYCLES} cycles used`);
  relay(ctx, s);
}


// The worker: instructions from the Worker tab run one at a time, in the order sent, alongside the
// discussion (they don't wait for a round, and a round doesn't wait for them), in the folder's shared
// queue (see "The shared worker queue"), which carries over a reload. The worker is sent only the
// instruction itself; the origin's own worker session holds the earlier ones. ctx.workQueue settles
// when this context's queued tasks have run (or were dropped).
// `run`: an auto dev run relaying this instruction (shown as "Relayed from discussion").
async function retryWork(ctx, id, settings = null) {
  const failure = ctx.retryFailure;
  if (!failure?.available || failure.id !== id || ctx.stopped || ctx.screen.workerInfo?.disabled) throw new Error('This failure is no longer available for retry.');
  failure.available = false;
  showHeader(ctx);
  try {
    if (settings) await saveSettings(ctx, { ...settings, scope: 'work' });
    if (ctx.retryFailure !== failure || ctx.stopped) throw new Error('This failure is no longer available for retry.');
    if (failure.run && ctx.autoDev === failure.run) failure.run.waiting = true;
    queueWork(ctx, failure.text, failure.run, failure.rollback, failure, { catchUp: !!failure.catchUp });
  } catch (err) {
    if (ctx.retryFailure === failure) failure.available = true;
    showHeader(ctx);
    throw err;
  }
}

const BRAINSTORM_NO_WORK = 'Turn this brainstorm into a sprint to send work.';
async function sendWorkbenchInstruction(ctx, text) {
  if (ctx.stopped) return note(ctx, 'This room is ending: the instruction was not sent.', true);
  if (ctx.discussion && shopOf(ctx).closing?.has(ctx.discussion.name)) return note(ctx, '✗ This workbench is closing; the instruction was not sent.', true);
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  if (!ctx.logPath) {
    if (!ctx.openingWorkbench) {
      ctx.openingWorkbench = openDiscussion(ctx, text).finally(() => { ctx.openingWorkbench = null; });
    }
    const ok = await ctx.openingWorkbench;
    if (!ok || !ctx.logPath) return;
  }
  queueWork(ctx, text);
}
function queueWork(ctx, text, run = null, rollback = null, retry = null, { catchUp = false } = {}) {
  if (ctx.state.brainstorm) return note(ctx, `✗ ${BRAINSTORM_NO_WORK} The instruction was not sent.`, true);
  if (ctx.state.research) return note(ctx, '✗ A research board has no worker. Open a sprint to send work. The instruction was not sent.', true);
  if (ctx.discussion && shopOf(ctx).closing?.has(ctx.discussion.name)) return note(ctx, '✗ This sprint is closing; the instruction was not sent.', true);
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  if (ctx.stopped) return note(ctx, 'This room is ending: the instruction was not sent.', true);
  ctx.agentsStarted = true;
  if (!catchUp) ctx.workReady = false;
  const shop = shopOf(ctx);
  let done;
  const finished = new Promise((r) => { done = r; });
  // Recorded in its discussion's checkpoint (see "Work in flight"); a brainstorm sends none (see BRAINSTORM_NO_WORK).
  const workName = ctx.discussion && !ctx.state.brainstorm ? ctx.discussion.name : null;
  const record = workName ? { id: randomBytes(6).toString('hex'), task: text, at: new Date().toISOString() } : null;
  shop.sent = (shop.sent ?? 0) + 1; // the order sent, across lanes: one worker session's tasks keep it
  const task = { origin: ctx, text, run, cycle: retry?.cycle ?? run?.cycle, done, finished, rollback, retry, catchUp: !!catchUp, record, workName, lane: workName, sent: retry?.sent ?? shop.sent, worker: ctx.worker, owner: ownerOf(ctx), label: originLabel(ctx) };
  const tasks = laneState(shop, workName).tasks;
  if (retry) { const i = tasks.findIndex((t) => t.sent > retry.sent); tasks.splice(i < 0 ? tasks.length : i, 0, task); }
  else tasks.push(task);
  if (record) { const queued = workOf(shop, workName).queued; if (retry) queued.unshift(record); else queued.push(record); persistWork(ctx, workName); }
  ctx.workDispatchedLen = ctx.state.transcript.length;
  ctx.workPending = (ctx.workPending ?? 0) + 1;
  showHeader(ctx);
  ctx.workQueue = Promise.all([ctx.workQueue, finished]).then(() => {});
  // A bug here must not jam the queue: report it, and the next instruction still runs.
  pump(shop).catch((err) => note(ctx, `✗ ${err.stack}\n`, true));
}

// One task, for its origin `ctx`. `recovery`: the edits this origin left uncommitted, which this
// task is to resolve; `lane`: the place it runs in. Resolves to its branch's commit before the task (or null).
async function runWork(ctx, text, run = null, cycle = 0, recovery = null, rollback = null, t = null, lane = null) {
  // The worker it was sent to. One its discussion left meanwhile (/new, Resume, Start fresh in the
  // terminal) keeps that discussion's session and briefing in its seat (see detachWorker).
  const worker = t?.worker?.seat ? t.worker : ctx.worker;
  const seat = worker !== ctx.worker ? worker.seat : null;
  const own = seat ?? { briefed: ctx.workerBriefed, tree: ctx.workerTree, label: ctx.workerLabel, handoff: ctx.workerHandoff, brainstorm: !!ctx.state.brainstorm, workbench: !!ctx.state.workbench };
  const shop = shopOf(ctx), screen = ctx.screen, label = t?.label ?? (seat ? seat.origin : originLabel(ctx)), owner = t?.owner ?? ownerOf(ctx);
  // First of all: its discussion's checkpoint records it as running (see "Work in flight").
  const record = t?.record, work = record ? workOf(shop, t.workName) : null;
  if (record) {
    work.queued = work.queued.filter((r) => r.id !== record.id);
    work.running = { ...record, at: new Date().toISOString(), before: null, lane: lane?.lane ?? null };
    persistWork(ctx, t.workName);
  }
  // Stop now (stopWorker) stops only this task's programs: the worker's set, empty as it starts.
  if (t) t.programs = worker.programs ?? null;
  if (t?.programs) { t.programs.running.clear(); t.programs.stopped = !!t.stopNow; }
  // Tasks of this discussion interrupted (or stopped) earlier: the worker is told once, with this one.
  const told = work ? [...work.interrupted] : [];
  if (!rollback && recovery && shop.rollbacks?.get(label)?.task === recovery.task) rollback = shop.rollbacks.get(label);
  if (rollback) { rollback.status = 'running'; showHeader(ctx); }
  let before = null, mainAtStart = null;
  const leftUsages = [];
  const history = own.handoff ? screen.worker.filter((m) => m.owner === owner && m.speaker).map((m) =>
    `${m.speaker}${m.error ? ' (failed)' : ''}:\n${m.html}`).join('\n\n') : '';
  // The task's context, read once, here, before anything awaits: its discussion (for the briefing
  // and the /move lock) and its transcript. If New discussion or Resume changes the room's
  // meanwhile, the task keeps its own; the reply still goes into its transcript.
  const task = seat ? { discussion: seat.discussion, logPath: seat.logPath } : { discussion: ctx.discussion ?? null, logPath: ctx.logPath ?? null };
  const started = task.logPath;
  // A transcript that can't be written to doesn't lose the reply: it is still shown, with the error.
  // A left brainstorm's task has no transcript: its reply stays in the Worker tab only.
  let saveError = null;
  const workLog = (t) => {
    try { if (started && started !== ctx.logPath) appendFileSync(started, t); else if (!seat) log(ctx, t); }
    catch (err) { saveError ??= err; }
  };
  const show = (entry, meta) => {
    const view = { ...ctx.docs.messageView(entry), ...(entry.retryId && { retryId: entry.retryId }), ...(meta && { meta }), origin: label, owner };
    shop.log.push(view);
    toShop(ctx, { type: 'work', message: view });
  };
  // Its own discussion's window shows its worker working: other discussions' tasks run alongside.
  const working = (name) => { if (ownerOf(ctx) === owner) { ctx.screen.working = name; toScreen(ctx, { type: 'working', name }); } showHeader(ctx); };
  // The discussion this task writes to (transcript, notes): /move refuses it until the task ends.
  ctx.workingIn = task.discussion?.dir ?? null;
  if (ctx.workingIn) shop.writing.add(ctx.workingIn);
  try {
    const from = run ? 'Relayed from discussion' : 'User';
    workLog(`**${from} → ${worker.name}** (worker${run ? `, auto dev cycle ${cycle} of ${run.limit ?? AUTO_DEV_CYCLES}` : ''})\n\n${text}\n\n`);
    out(ctx, `\n${bold(`${run ? 'Relayed' : 'You'} → ${worker.name}`)} › ${text}\n`);
    show({ speaker: from, text });
    working(worker.name);
    const t0 = Date.now();
    let entry, formatProblems = [], retryChanged = false;
    try {
      // Its own worktree first (created, reattached or caught up); without one it doesn't run.
      // Preserve the existing safe fast-forward contract for ordinary tasks, while still telling
      // the worker about main's advance. Rollback must inspect ambiguity before any file changes.
      lane ??= await lanePlace(ctx, t?.lane ?? null);
      const owedMain = !recovery && Number(await git(ctx.cwd, 'rev-list', '--count', `${lane.branch}..main`).catch(() => '0')) > 0;
      const place = await refreshWorker(ctx, { prepare: true, fastForward: !rollback, place: lane });
      if (place.disabled) throw new Error(place.disabled);
      before = await git(place.path, 'rev-parse', 'HEAD');
      if (record && work.running?.id === record.id) { work.running.before = before; persistWork(ctx, t.workName); }
      mainAtStart = await git(place.path, 'rev-parse', 'main').catch(() => null);
      if (!recovery) {
        const file = await ownerFile(place);
        const record = { version: 1, root: real(ctx.cwd), label, task: text, before, ...(ctx.state.brainstorm && { brainstormId: ctx.state.brainstormId }) };
        writeFileSync(`${file}.tmp`, JSON.stringify(record) + '\n', { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      }
      // The worker learns the active discussion's folder (for its notes) with its first instruction there.
      // After New discussion, until the next one exists, it learns only that the old one is closed.
      const instr = ctx.instructions ?? defaultInstructions;
      const d = task.discussion;
      // The worker learns the active discussion's folder, where it works, its commit label, and what
      // to do before the instruction (merge, leftover edits, interruptions). These pieces come from
      // instructions.mjs, the same catalog the Instructions tab shows.
      const brief = instr.workerBrief(d, own, place);
      const tree = instr.workerLocation(own, place, ctx, NOTES);
      const commit = instr.workerCommit(own, label, place);
      const workbenchNote = instr.workerWorkbench ? instr.workerWorkbench(!!own.workbench || isWorkbenchDir(d?.dir)) : '';
      const leftover = recovery ? instr.workerLeftover(recovery, label, place) : '';
      const isCatchUpAction = /^Catch up with \S+: merge \S+ into /i.test(text);
      const mainBehind = owedMain || !recovery && await gitOk(place.path, 'rev-parse', '--verify', 'main^{commit}') &&
        Number(await git(place.path, 'rev-list', '--count', 'HEAD..main')) > 0;
      const merge = isCatchUpAction ? '' : instr.workerMerge(mainBehind, rollback, place, label);
      const interrupted = instr.workerInterrupted(told);
      if (told.length) work.interrupted = work.interrupted.filter((r) => !told.includes(r));
      const retryBrief = t?.retry ? instr.fill(instr.WORKER_RETRY, { error: t.retry.error,
        commits: t.retry.after ? (await git(place.path, 'log', '--format=%H %s', `${t.retry.after}..HEAD`).catch(() => '(could not read commits)') || '(none)') : '(the failure commit could not be determined)' }) + '\n\n' : '';
      const makeUsageLine = () => ctx.usage.agentUsageLine({
        total: worker === ctx.worker ? ctx.totals?.[worker.name] : undefined,
        usageUnavailable: worker !== ctx.worker,
        provider: worker.provider,
        gauges: ctx.screen?.quota,
        measured: ctx.screen?.quotaAt?.providers ?? ctx.screen?.quotaAt?.measured,
      });
      const prompt = `${makeUsageLine()}\n\n` + interrupted + brief + tree + commit + workbenchNote + retryBrief + leftover + merge + (history ? instr.workerHistory(history, text) : text);
      // Stopped while its worktree was prepared: its worker never starts.
      if (t?.stopNow) throw new Error('stopped by the User before the worker started');
      if (t) t.turnStarted = true;
      const askedCatchUp = Boolean((mainBehind && !rollback) || isCatchUpAction);
      const formatLog = (msg, err = false) => {
        workLog(`_(${msg})_\n\n`);
        workNote(ctx, msg, err, label, owner);
        if (!seat && ownerOf(ctx) === owner) toScreen(ctx, { type: 'note', text: msg, error: err });
      };
      let turnStart = t0, beforeRetrySnap = null, beforeRetryHead = null;
      const runFormatted = ctx.formattedTurn ?? defaultFormattedTurn;
      const turnResult = await runFormatted(worker, prompt, {
        onTurn: async (raw, attempt) => {
          const replyText = raw || '(no reply)';
          if (attempt === 1) {
            const now = worker === ctx.worker ? null : worker.seat;
            if (now) Object.assign(now, { ...(brief && { briefed: d?.dir ?? (own.brainstorm ? 'brainstorm' : null) }), tree: place.cwd, label, handoff: false });
            else if (worker === ctx.worker) {
              if (brief) ctx.workerBriefed = d?.dir ?? (ctx.state.brainstorm ? 'brainstorm' : null);
              ctx.workerTree = place.cwd;
              ctx.workerLabel = label;
              ctx.workerHandoff = false;
            }
          }
          if (worker.lastUsage && worker === ctx.worker) ctx.totals[worker.name] = ctx.usage.addUsage(ctx.totals[worker.name], worker.lastUsage);
          else if (worker.lastUsage) leftUsages.push(worker.lastUsage);
          const meta = [`${Math.round((Date.now() - turnStart) / 1000)}s`, ctx.usage.formatUsage(worker.lastUsage)].filter(Boolean).join(' · ');
          workLog(`**${worker.name}** (worker, ${meta})\n\n${replyText}\n\n`);
          out(ctx, `\n${bold(worker.name)}${dim(` (worker, ${meta})`)} › ${replyText}\n`);
          show({ speaker: worker.name, text: replyText }, meta);
        },
        check: async (raw, attempt) => {
          if (attempt === 2 && beforeRetrySnap !== null) {
            const afterSnap = await worktreeFingerprint(place);
            if (afterSnap !== beforeRetrySnap) {
              retryChanged = true;
              const afterHead = await git(place.path, 'rev-parse', 'HEAD');
              const detail = beforeRetryHead !== afterHead ? `HEAD moved from ${beforeRetryHead.slice(0, 7)} to ${afterHead.slice(0, 7)}` : 'files changed';
              formatLog(`Format check: the ${worker.name}'s format retry changed the worktree or HEAD (${detail}); keeping the changes and pausing for review.`, true);
            }
          }
          if (rollback) return [];
          const facts = await workerGitFacts(place, { before, mainAtStart, askedCatchUp });
          return checkWorkerReport(raw || '(no reply)', facts);
        },
        onProblems: async (problems) => {
          if (t?.stopNow) throw new Error('stopped by the User');
          beforeRetryHead = await git(place.path, 'rev-parse', 'HEAD');
          beforeRetrySnap = await worktreeFingerprint(place);
          formatLog(`Format check: the ${worker.name}'s report ${problems.join('; ')}. Asked once to fix it.`, true);
          turnStart = Date.now();
        },
        retryPrompt: (problems) => `${makeUsageLine()}\n\nYour report has a format problem: ${problems.join('; ')}.\nReply again with the complete corrected report only. Do no new work: do not run commands, do not edit files, and do not commit.`,
      });
      entry = { speaker: worker.name, text: turnResult.text || '(no reply)' };
      formatProblems = turnResult.problems;
      if (turnResult.retried) {
        if (!formatProblems.length) formatLog('Format check: fixed on retry.', false);
        else formatLog(`Format check: still wrong: ${formatProblems.join('; ')}.`, true);
      }
      if (!formatProblems.some((p) => p.includes('Tested:'))) {
        await recordTested(ctx, place, entry.text, owner, label); // its "Tested:" line, if Git agrees
      }
    } catch (err) {
      entry = { speaker: worker.name, text: err.message, error: true };
    }
    // Stopped by the User (Stop now): what it left in the worktree is its reply, and in the chat.
    // A reply that came before the stop took effect is kept as it is.
    const stopped = !!(t?.stopNow && entry.error);
    if (stopped) {
      const r = { task: text, at: work?.running?.at ?? new Date(t0).toISOString(), before, lane: t.lane ?? null };
      entry.text = await leftBehind(ctx, label, r, { stopped: true, preparing: !t.turnStarted, place: lane?.path ? lane : null });
    }
    if (entry.error) {
      const meta = [`${Math.round((Date.now() - t0) / 1000)}s`].filter(Boolean).join(' · ');
      workLog(`**${worker.name}** (worker, failed, ${meta})\n\n${entry.text}\n\n`);
      out(ctx, red(`\n✗ ${worker.name} (worker) failed: ${entry.text}\n`));
      if (!stopped && !ctx.stopped && record && ownerOf(ctx) === owner) {
        const id = randomBytes(6).toString('hex');
        ctx.retryFailure = { id, available: true, text: t.retry?.text ?? text, error: entry.text, after: lane?.path ? await git(lane.path, 'rev-parse', 'HEAD').catch(() => null) : null, sent: t.retry?.sent ?? t.sent, cycle, run, rollback, catchUp: !!t?.catchUp };
        entry.retryId = id;
      }
      show(entry, meta);
    }
    showHeader(ctx);
    if (saveError) workNote(ctx, `✗ ${worker.name}: couldn't save to the transcript: ${saveError.message}`, true, label, owner);
    // Its commits must carry its label: one without it is reported, not trusted.
    if (before) {
      const finished = await labelledCommits(lane.path, `${before}..HEAD`);
      rememberCommits(shop, finished);
      const subjects = (await git(lane.path, 'log', '--format=%h %s', `${before}..HEAD`, ...(mainAtStart ? ['--not', mainAtStart] : [])).catch(() => '')).split('\n').filter(Boolean);
      const unlabelled = subjects.filter((l) => !l.slice(l.indexOf(' ') + 1).startsWith(`[${label}]`));
      if (unlabelled.length) workNote(ctx, `✗ Commits without the [${label}] label: ${unlabelled.join(' · ')}.`, true, label, owner);
    }
    if (record && work.running?.id === record.id) {
      // Stopped by the User: already reported; its worker is told with the next instruction.
      if (stopped) work.interrupted.push({ ...work.running, stopped: true, reported: true });
      // Stopped by Quit or Restart: kept as interrupted, to report on Resume.
      else if (ctx.stopped && entry.error) work.interrupted.push(work.running);
      work.running = null;
      persistWork(ctx, t.workName);
    }
    if (rollback) await rollbackReport(ctx, rollback, entry, worker === ctx.worker ? null : worker.seat);
    if (stopped) stopReport(ctx, owner, started, entry.text);
    else if (run && ownerOf(ctx) === owner) {
      if (retryChanged && ctx.autoDev === run) {
        if (run.status === 'running') pauseAutoDev(ctx, 'the worker\'s format retry changed the worktree or HEAD');
        else if (run.status === 'paused') { run.reason = 'the worker\'s format retry changed the worktree or HEAD'; showHeader(ctx); }
      }
      const reported = !entry.error && formatProblems.length
        ? { ...entry, text: `${entry.text}\n\nFormat check still wrong: ${formatProblems.join('; ')}.` }
        : entry;
      reportBack(ctx, run, reported, !!t?.retry);
    }
  } finally {
    if (ctx.workingIn) shop.writing.delete(ctx.workingIn);
    ctx.workingIn = null;
    working(null);
  }
  // Its worker session and briefing, in its own discussion's checkpoint: the one in use, or the one
  // left meanwhile (saveLeftWorker).
  if (worker === ctx.worker) saveCheckpoint(ctx); else if (worker.seat) saveLeftWorker(ctx, worker, leftUsages);
  showHeader(ctx);
  await refreshWorker(ctx).catch(() => {}); // the tab's checks are current when the task counts as done
  refreshQuota(ctx).catch(() => {});
  return before;
}


return { newShop, shopOf, laneState, workerLane, lanesOf, runningTasks, queuedTasks, visibleWorker,
  toShop, workNote, workerHold, PARALLEL_WORKERS, recoverWorkerOwner, leftovers, pump, dropTask, stopWorker,
  AUTO_DEV_CYCLES, AUTO_DEV_REPORT, AUTO_DEV_FAILURE, autoDevTask, pausedTask, summaryInstruction,
  summaryOutcome, summarySteps, summaryHasNextStep, checkSummary, autoDevOffer, autoDevView,
  startAutoDev, autoDevInput, pauseAutoDev, finishAutoDev, autoDevReport, decide, workNotice,
  retryWork, BRAINSTORM_NO_WORK, sendWorkbenchInstruction, queueWork };
}
