// Research scheduler and its per-workshop timer, bound to the current room coordinator.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SCHEDULE_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function createScheduler({ siblings, toScreen, showHeader, checkpoints, DATED, isWorkbenchDir,
  SECTIONS, shopOf, boardRef, day, pad, load, isResearchDir, isBoard, readCheckpoint,
  roomDefaults, parseSpec, refreshQuota, openBeside, resumeBoard, newResearch, wire,
  openBoard, runRound, saveCheckpoint, fresh, closeContext, chooseResearchKind }) {
// ── Scheduler (research tasks) ─────────────────────────────────
// Per-room schedule stored in agent-room's local state, outside the project's working tree:
// ~/.local/state/agent-room/schedules/<sha256 of realpath(room folder)>.json
const DEFAULT_QUOTA_FLOOR = 50;
const SCHEDULE_EVERY_MS = 15_000;


function scheduleFile(ctx) {
  return ctx.scheduleFile ?? join(homedir(), '.local', 'state', 'agent-room', 'schedules',
    createHash('sha256').update(realpathSync(ctx.cwd)).digest('hex') + '.json');
}

function readSchedule(ctx) {
  const file = scheduleFile(ctx);
  const empty = () => ({ version: 1, root: realpathSync(ctx.cwd), quotaFloor: DEFAULT_QUOTA_FLOOR, tasks: [] });
  if (!existsSync(file)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty();
    const quotaFloor = typeof parsed.quotaFloor === 'number' && Number.isFinite(parsed.quotaFloor) && parsed.quotaFloor >= 0 && parsed.quotaFloor <= 100
      ? parsed.quotaFloor : DEFAULT_QUOTA_FLOOR;
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter((t) => t && typeof t.id === 'string') : [];
    return { version: 1, root: realpathSync(ctx.cwd), quotaFloor, tasks };
  } catch {
    return empty();
  }
}

function writeSchedule(ctx, data) {
  const file = scheduleFile(ctx);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ version: 1, root: realpathSync(ctx.cwd), quotaFloor: data.quotaFloor, tasks: data.tasks }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function broadcastSchedule(ctx) {
  for (const c of siblings(ctx)) if (!c.stopped && c.screen) toScreen(c, { type: 'schedule' });
  showHeader(ctx);
}

function listScheduleBoards(ctx) {
  const parent = join(ctx.cwd, 'discussions');
  if (!existsSync(parent)) return [];
  const savedTitles = new Map(checkpoints(ctx).map((c) => [c.name, c.title]));
  const titleFor = (name) => savedTitles.get(name) ?? name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
  const scan = (dir, section) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DATED.test(e.name) && !isWorkbenchDir(join(dir, e.name)))
      .map((e) => ({ ref: section ? `${section}/${e.name}` : e.name, name: e.name, title: titleFor(e.name), section }))
      .sort((a, b) => b.name.localeCompare(a.name));
  };
  return [
    ...scan(parent, null),
    ...SECTIONS.flatMap((s) => scan(join(parent, s), s)),
  ];
}

function getSchedule(ctx) {
  const data = readSchedule(ctx);
  const running = shopOf(ctx).schedulerRunningTasks ?? new Set();
  return {
    quotaFloor: data.quotaFloor,
    boards: listScheduleBoards(ctx),
    tasks: data.tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title, date: t.date, board: t.board ?? null,
      prompt: t.prompt,
      time: t.time,
      enabled: !!t.enabled,
      researchKind: taskKind(t),
      lastRun: t.lastRun ?? null,
      running: running.has(t.id),
    })),
  };
}

// The research kind a task's board is created with; a task saved before kinds has none: Feasibility.
const taskKind = (t) => ({ deep: t?.researchKind?.deep === true, theoretical: t?.researchKind?.theoretical === true });

function validateTaskInput(ctx, body) {
  const kind = body?.kind;
  if (kind !== 'research' && kind !== 'recurring') {
    const d = body?.board && boardRef(join(ctx.cwd, 'discussions'), body.board);
    if (d && isWorkbenchDir(join(ctx.cwd, 'discussions', d.section ?? '', d.name))) throw new Error('Workbenches cannot be scheduled.');
    throw new Error('Choose a research task type.');
  }
  const title = String(body.title ?? '').trim();
  const prompt = String(body.prompt ?? '').trim();
  const time = String(body.time ?? '').trim();
  if (!prompt) throw new Error('Enter a prompt for the scheduled run.');
  if (!SCHEDULE_TIME_RE.test(time)) throw new Error('Enter a local time in 24-hour HH:MM format.');
  if (kind === 'research') {
    const date = String(body.date ?? '').trim();
    const parsed = new Date(`${date}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || day(parsed) !== date) throw new Error('Enter a valid local date.');
    return { kind, title, prompt, date, time, enabled: true, researchKind: taskKind(body) };
  }
  return { kind, title, prompt, time, enabled: body.enabled === undefined ? true : !!body.enabled, researchKind: taskKind(body) };
}

function saveSchedule(ctx, body) {
  if (!body || typeof body !== 'object') throw new Error('Invalid schedule request.');
  const data = readSchedule(ctx);
  const action = body.action;
  if (action === 'floor') {
    const floor = Number(body.quotaFloor);
    if (!Number.isFinite(floor) || floor < 0 || floor > 100) throw new Error('Quota floor must be a number between 0 and 100.');
    data.quotaFloor = Math.round(floor);
  } else if (action === 'add') {
    const fields = validateTaskInput(ctx, body);
    data.tasks.push({ id: randomBytes(8).toString('hex'), ...fields, lastRun: null, lastTriggerKey: null });
  } else if (action === 'edit') {
    const task = data.tasks.find((t) => t.id === body.id);
    if (!task) throw new Error('Scheduled task not found.');
    if (task.kind !== body.kind) throw new Error('Cannot change task type.');
    const fields = validateTaskInput(ctx, body);
    const timeChanged = task.time !== fields.time || task.date !== fields.date;
    // Once a task's board exists, the board's saved kind wins: the task keeps the kind it had.
    if (task.board) fields.researchKind = taskKind(task);
    Object.assign(task, fields);
    if (timeChanged) { task.lastTriggerKey = null; if (task.kind === 'research') task.lastRun = null; }
  } else if (action === 'toggle') {
    const task = data.tasks.find((t) => t.id === body.id);
    if (!task) throw new Error('Scheduled task not found.');
    task.enabled = !!body.enabled;
  } else if (action === 'delete') {
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.id !== body.id);
    if (data.tasks.length === before) throw new Error('Scheduled task not found.');
  } else {
    throw new Error('Unknown schedule action.');
  }
  writeSchedule(ctx, data);
  broadcastSchedule(ctx);
  return getSchedule(ctx);
}

function recordTaskRun(ctx, taskId, status, reason, at, triggerKey = undefined) {
  const data = readSchedule(ctx);
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task || (triggerKey !== undefined && task.lastTriggerKey !== triggerKey)) return;
  task.lastRun = { at, status, reason: reason ?? null };
  writeSchedule(ctx, data);
  broadcastSchedule(ctx);
}

async function runScheduledTask(ctx, taskId, { now = null, loadRoom = load } = {}) {
  const data = readSchedule(ctx);
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  return runScheduledResearch(ctx, task, data, { now, loadRoom });
}

async function runScheduledResearch(ctx, task, data, { now, loadRoom }) {
  const at = (now ?? new Date()).toISOString();
  const clockMs = () => now ? now.getTime() : Date.now();
  const shop = shopOf(ctx);
  shop.schedulerRunningTasks ??= new Set();
  if (shop.schedulerRunningTasks.has(task.id)) {
    const reason = 'A round or summary is already in progress for this task';
    recordTaskRun(ctx, task.id, 'skipped', reason, at, task.lastTriggerKey);
    return { status: 'skipped', reason };
  }
  shop.schedulerRunningTasks.add(task.id);
  broadcastSchedule(ctx);
  let runCtx = null;
  let createdBeside = false;
  try {
    const parent = join(ctx.cwd, 'discussions');
    const ref = task.board && [task.board, ...SECTIONS.map((section) => `${section}/${task.board}`)]
      .find((candidate) => boardRef(parent, candidate));
    if (task.board && (!ref || !isResearchDir(join(parent, ref)))) throw new Error(`Research board ${task.board} was not found.`);
    let open = task.board && siblings(ctx).find((c) => !c.stopped && isBoard(c, task.board));
    if (open?.busy) {
      const reason = `${task.board} has a round or summary in progress`;
      recordTaskRun(ctx, task.id, 'skipped', reason, at, task.lastTriggerKey);
      return { status: 'skipped', reason };
    }
    const saved = task.board && readCheckpoint(ctx, task.board);
    const specs = open?.agentSpecs ?? saved?.agentSpecs ?? roomDefaults(ctx).agents ?? ctx.agentSpecs ?? '';
    const configured = specs.split(',').filter(Boolean).map((s) => parseSpec(s));
    const disabled = (open ? open.state : saved?.state)?.disabledAgents ?? [];
    const models = new Map();
    for (const { name, provider } of open?.room.agents ?? configured) {
      if (disabled.includes(name)) continue;
      const model = configured.find((a) => a.name === name && a.provider === provider)?.model ?? '';
      if (!models.has(provider)) models.set(provider, new Set());
      models.get(provider).add(model);
    }
    const providers = [...models.keys()];
    const failures = await Promise.all([...models].flatMap(([provider, providerModels]) => [...providerModels].map(async (model) => {
      const label = `${provider} (${model || 'CLI default'})`;
      try {
        const result = await ctx.testPrompt(ctx, provider, model, { scheduled: true });
        return result.outcome === 'ok' ? null : `${label}: ${result.error}`;
      } catch (err) {
        return `${label}: ${err?.message || String(err)}`;
      }
    })));
    const failure = failures.find(Boolean);
    if (failure) {
      const reason = `Test prompt failed for ${failure}`;
      recordTaskRun(ctx, task.id, 'skipped', reason, at, task.lastTriggerKey);
      return { status: 'skipped', reason };
    }
    const quota = await ctx.usage.fetchQuota();
    refreshQuota(ctx, quota).catch(() => {});
    const check = ctx.usage.checkQuotaFloor(quota, providers, data.quotaFloor, { now: clockMs() });
    if (!check.ok) {
      recordTaskRun(ctx, task.id, 'skipped', check.reason, at, task.lastTriggerKey);
      return { status: 'skipped', reason: check.reason };
    }
    if (task.board && !isResearchDir(join(parent, ref))) throw new Error(`Research board ${task.board} is no longer research.`);
    // Another round may have started during the prompt checks or quota fetch.
    open = task.board && siblings(ctx).find((c) => !c.stopped && isBoard(c, task.board));
    if (open?.busy) {
      const reason = `${task.board} has a round or summary in progress`;
      recordTaskRun(ctx, task.id, 'skipped', reason, at, task.lastTriggerKey);
      return { status: 'skipped', reason };
    }
    if (open) {
      runCtx = open;
    } else if (ctx.hub?.addRoom) {
      runCtx = await openBeside(ctx);
      createdBeside = true;
      if (task.board) {
        await resumeBoard(runCtx, ref, { loadRoom });
        if (!isBoard(runCtx, task.board)) throw new Error(`Could not resume research board ${task.board}.`);
      } else await newResearch(runCtx);
    } else {
      const state = { transcript: [], seen: new Map(), research: true }, sessions = new Map();
      runCtx = { ...ctx, state, sessions, board: null, programs: { running: new Set(), stopping: false },
        screen: { clients: new Set(), transcript: state.transcript, worker: shop.log }, lastRound: null, logPath: null,
        checkpointError: null, hub: null, noScreen: true };
      Object.assign(runCtx, await loadRoom(runCtx, `?sched=${Date.now()}`), { state, sessions, usage: ctx.usage });
      wire(runCtx);
      if (task.board) {
        await resumeBoard(runCtx, ref, { loadRoom });
        if (!isBoard(runCtx, task.board)) throw new Error(`Could not resume research board ${task.board}.`);
      }
    }
    if (runCtx.busy) {
      const reason = `${task.board} has a round or summary in progress`;
      recordTaskRun(ctx, task.id, 'skipped', reason, at, task.lastTriggerKey);
      return { status: 'skipped', reason };
    }
    if (!runCtx.logPath) {
      const suggestTitle = runCtx.suggestTitle;
      if (!task.board && task.title) runCtx.suggestTitle = async () => ({ title: task.title });
      // A new board is created with the task's kind (ignored when the board already exists).
      chooseResearchKind(runCtx, taskKind(task));
      let opened;
      try { opened = await openBoard(runCtx, task.prompt); } finally { runCtx.suggestTitle = suggestTitle; }
      if (!opened) throw new Error('Could not create the research board or transcript.');
    }
    if (task.kind === 'recurring' && !task.board) {
      const current = readSchedule(ctx), stored = current.tasks.find((t) => t.id === task.id);
      if (stored) { stored.board = runCtx.board.name; writeSchedule(ctx, current); broadcastSchedule(ctx); }
    }
    const result = await runRound(task.prompt, runCtx, {
      speaker: 'Scheduler',
      beforeLap: async (lap) => {
        const q = await runCtx.usage.fetchQuota();
        refreshQuota(runCtx, q).catch(() => {});
        const active = [...new Set(runCtx.room.agents.filter((a) => !(runCtx.state.disabledAgents ?? []).includes(a.name)).map((a) => a.provider))];
        const next = runCtx.usage.checkQuotaFloor(q, active, readSchedule(ctx).quotaFloor, { now: clockMs() });
        return next.ok ? null : `Scheduled run stopped early by quota guard before lap ${lap + 1}: ${next.reason}`;
      },
    });
    const status = result?.stoppedReason ? 'stopped' : result?.failedError ? 'failed' : 'ran';
    const reason = result?.stoppedReason ?? result?.failedError ?? null;
    saveCheckpoint(runCtx);
    recordTaskRun(ctx, task.id, status, reason, at, task.lastTriggerKey);
    return { status, reason };
  } catch (err) {
    recordTaskRun(ctx, task.id, 'failed', err.message, at, task.lastTriggerKey);
    if (createdBeside && runCtx && !runCtx.stopped && fresh(runCtx)) closeContext(runCtx);
    return { status: 'failed', reason: err.message };
  } finally {
    shop.schedulerRunningTasks.delete(task.id);
    broadcastSchedule(ctx);
    showHeader(ctx);
  }
}

async function checkSchedule(ctx, now = null, opts = {}) {
  const data = readSchedule(ctx);
  if (!data.tasks.length) return [];
  const current = now ?? new Date();
  const today = day(current);
  const nowTime = `${pad(current.getHours())}:${pad(current.getMinutes())}`;
  const triggerKey = `${today} ${nowTime}`;
  const due = [];
  let changed = false;
  for (const task of data.tasks) {
    if (!task.enabled) continue;
    if (task.time !== nowTime) continue;
    if (task.kind === 'research' && (task.date !== today || task.lastTriggerKey || shopOf(ctx).schedulerRunningTasks?.has(task.id))) continue;
    if (task.lastTriggerKey === triggerKey) continue;
    task.lastTriggerKey = triggerKey;
    changed = true;
    due.push(task.id);
  }
  if (changed) writeSchedule(ctx, data);
  return Promise.all(due.map((id) => runScheduledTask(ctx, id, { ...opts, now })));
}

function startScheduler(ctx) {
  const shop = shopOf(ctx);
  shop.schedulerCtx = ctx;
  shop.checkSchedule = () => {
    const live = siblings(shop.schedulerCtx).find((c) => !c.stopped && c.room && c.usage);
    if (live) checkSchedule(live).catch(() => {});
  };
  shop.schedulerTimer ??= setInterval(() => shop.checkSchedule?.(), SCHEDULE_EVERY_MS).unref();
}

function stopSchedulerIfLast(ctx) {
  const shop = ctx.shop;
  if (!shop?.schedulerTimer) return;
  if (!siblings(ctx).some((c) => c !== ctx && !c.stopped)) {
    clearInterval(shop.schedulerTimer);
    shop.schedulerTimer = null;
  }
}


return { scheduleFile, readSchedule, writeSchedule, broadcastSchedule, getSchedule, saveSchedule,
  runScheduledTask, checkSchedule, startScheduler, stopSchedulerIfLast };
}
