// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultInstructions from './instructions.mjs';
import { formattedTurn as defaultFormattedTurn } from './room.mjs';
// Preserve the public exports for callers that import ui.mjs directly.
const laneModule = await import(`./lanes.mjs${new URL(import.meta.url).search}`);
const workshopModule = await import(`./workshop.mjs${new URL(import.meta.url).search}`);
const boardsModule = await import(`./boards.mjs${new URL(import.meta.url).search}`);
const monitorModule = await import(`./monitor.mjs${new URL(import.meta.url).search}`);
const schedulerModule = await import(`./scheduler.mjs${new URL(import.meta.url).search}`);
const { SCHEDULE_TIME_RE } = schedulerModule;
export const { branchDiagram, BRANCH_DIAGRAM_LIMIT, WORKER_BRANCH, NOTES, workerPlace, ensureWorktree,
  parsePorcelainConflicts, worktreeStatus, catchUp, checkWorkerReport } = laneModule;
const { git, gitOk, plural, labelledCommits, lanePlace, existingLanes, mainRef, workerGitFacts } = laneModule;
const real = (p) => (existsSync(p) ? realpathSync(p) : p);

export const USAGE = `Usage: agent-room [--agents claude,codex] [--worker claude:Worker] [--cwd DIR] [--port 5566] [--no-screen] [--open] [--reopen NAME] [--dev]
                  [--node NAME [--peer NAME=http://ADDRESS:PORT ...]]

Providers: claude, codex, agy. Each agent is provider[:name[:model]], e.g. --agents claude:Ada:opus,codex:Linus
Without saved defaults: discussion claude,codex; worker claude:Worker.
The provider/model sections in the Discussion and Worker tabs save changes automatically to
~/.config/agent-room/defaults.json. CLI flags override the corresponding defaults for this launch.
Worker changes apply to this discussion on the next instruction, and become defaults only before work starts.
Discussion changes apply before work starts; after that they set defaults for future rooms.
The worker (the screen's Worker tab) is one more agent, outside the discussion: it carries out the
instructions sent from that tab, sees only those (and the active discussion's folder, for its
notes), and can edit files and run commands. It works in its own Git worktree of the room's
repository, one per discussion (<repo>.workers/<name>/, branch worker/<name>; before a discussion's
first message, <repo>.worker/, branch worker/main), created at its first instruction; you review and merge its work.
A brainstorm sends no work: turn it into a discussion first. Without a Git repository the worker is disabled.
By default (npm start) the room is used from the discussion screen in the browser; the terminal
only shows a log. --no-screen (or npm run terminal): the room is used from the terminal instead,
and /docs opens each file alone in the browser.
--open opens the discussion screen even without an interactive terminal (for a Dock launcher).
--dev (part of npm start, which the Dock app runs too): saving a source module or a rulebook
reloads it by itself, as /reload does; open pages refresh when their own code changed. cli.mjs
changes still need /restart. Without --dev (node src/cli.mjs), only /reload does.
--port: the server's port (default 5566), on every address of this machine, so other devices on
the LAN can open it too; if it is taken, any free port is used (with --peer, the server stops instead).
One server runs several rooms, one per folder, each at /r/<room>/__room; /__room opens the first.
Open room in folder… (on the screen) opens the folder's room, or asks, then adds one to this server.
--node NAME: replicate the launch room's (--cwd's) discussions under this node name: each round is saved as a Git
commit in <root>/.agent-room/ (not the project's repository). --peer NAME=http://ADDRESS:PORT
(repeatable): another node's server, whose launch room is paired with once (Discussions → Peers) and
sent rounds. Rooms added with Open room in folder… don't replicate.
The --cwd folder is the room's root. Opening it writes nothing: the first message starts a new
discussion in DIR/discussions/<date>-<title>/ (its documents, drawings and transcripts/), unless
/resume <name> (or --reopen <name> at launch) picked an existing one first.
Every discussion saves a checkpoint on this machine after each round, so it can continue later.
Type a message to start a round; start it with @name to address one agent.
Commands: /resume <name> (continue that discussion where it stopped: the same agent and worker
sessions, and its chat; from its handoff if it was never saved; one in archive/ or deferred/ is made
active first), /fresh <name> (Start fresh: new sessions there, from its handoff and notes and its
latest saved summary; its saved sessions are discarded), /peek <name> (a closed discussion's or brainstorm's conversation and notes, read-only, without reopening it; /peek alone returns), /docs (pick a document to view in the
browser), /new (end this session; your next message starts a new discussion; the worker
carries on), /brainstorm (New brainstorm: its first message names it, in DIR/brainstorms/<date>-<title>/,
saved like a discussion but sending no work; /resume brainstorms/<name> and /fresh brainstorms/<name> as
for discussions), /workbench (New workbench: a worker-only board in DIR/discussions/<date>-<title>/; its first
message names it and goes straight to the worker), /research (New research: a research board in DIR/discussions/<date>-<title>/ with a .research marker and no worker), /convert brainstorms/<name> [research] (Turn into a discussion or, with research, into a research board: its folder moves to discussions/,
its agents keep their sessions), /delete brainstorms/<name> (delete a closed brainstorm's folder and
checkpoint for good), /move <name> active|archive|deferred (move a whole discussion; not the one in use),
/rollback <name> (queue archive with rollback), /archive-rollback <name> (confirm archive after reviewing its report),
/autodev (screen only: Start auto dev, relaying the latest agreed summary's worker instruction
and the worker's reports, for up to 5 worker cycles), /summary (the agents agree a short
summary by points; only the result is shown; a summary also follows every round in which an
agent spoke), /usage (tokens this session and subscription quotas),
/reload (load edited code and all agent rulebooks, in every room; conversations continue), /restart
(screen only: a new process on the same port, with every room, each in its discussion in use, from
its checkpoint), /quit (Quit room: ends this room only, after its round in progress or at most 30s,
then stopping its agent and worker programs), /shutdown (screen only: Shutdown server, ending every
room; the same as POST /__shutdown, which the Dock app uses)
Refresh the browser after /reload to see page changes.`;

// How long one worker instruction may run before it is stopped (a room turn gets 5 minutes).
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

// Shared defaults are read only at startup; explicit CLI choices take precedence.
export const defaultsFile = () => join(homedir(), '.config', 'agent-room', 'defaults.json');
const parseSpec = (spec, worker = false) => {
  const [provider, name = worker ? 'Worker' : provider[0].toUpperCase() + provider.slice(1), model = ''] = spec.trim().split(':');
  return { provider, name, model };
};
const specFor = ({ provider, name, model }) => `${provider}:${name}:${model}`;
export function validateSettings(value) {
  if (!value || !Array.isArray(value.agents) || !value.agents.length || value.agents.length > 8)
    throw new Error('Choose between 1 and 8 discussion agents.');
  const names = new Set();
  const agent = (a) => {
    if (!a || !['claude', 'codex', 'agy'].includes(a.provider)) throw new Error('Choose Claude, Codex or Agy.');
    if (typeof a.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(a.name)) throw new Error('Names must use letters, numbers, underscores or hyphens.');
    if (names.has(a.name.toLowerCase())) throw new Error('Each agent and the worker need a different name.');
    names.add(a.name.toLowerCase());
    if (typeof a.model !== 'string' || !/^[A-Za-z0-9._[\]()-]*$/.test(a.model) || a.model.length > 150) throw new Error('Invalid model ID.');
    return { provider: a.provider, name: a.name, model: a.model };
  };
  return { agents: value.agents.map(agent), worker: agent(value.worker) };
}
export function readDefaults(file = defaultsFile()) {
  try { return validateSettings(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read agent defaults (${file}): ${err.message}. Using CLI defaults.`);
    return null;
  }
}
function currentSettings(ctx) {
  return { agents: ctx.agentSpecs.split(',').map((s) => parseSpec(s)), worker: parseSpec(ctx.workerSpec, true) };
}
// Refresh in the background at most once every five minutes, including after a failed lookup.
// Keep the previous list while refreshing; an unavailable catalog still allows a custom ID.
export function agyModelCatalog(exec = execFile, now = Date.now) {
  let models = [], lastAttempt = -Infinity, pending = null, loaded = false, lastError = null, checked = null;
  const start = () => {
    lastAttempt = now();
    let finish;
    pending = new Promise((resolve) => { finish = resolve; });
    const done = (err, stdout = '') => {
      checked = new Date(now()).toISOString();
      if (err) { loaded = false; lastError = { message: err.message ?? String(err), at: checked }; }
      else {
        models = String(stdout).split('\n').flatMap((line) => {
          const [id, label] = line.trim().split('\t');
          return label && /^[A-Za-z0-9._[\]()-]+$/.test(id) ? [{ id, label: label.trim() }] : [];
        });
        loaded = true;
      }
      pending = null;
      finish();
    };
    const result = pending;
    try { exec('agy', ['models'], { timeout: 5000 }, done); } catch (err) { done(err); }
    return result;
  };
  const catalog = () => {
    if (!pending && now() - lastAttempt >= 5 * 60_000) start();
    return models;
  };
  catalog.status = () => ({ models, loaded, checked, error: lastError });
  catalog.refresh = async () => { if (pending) await pending; await start(); };
  return catalog;
}
const agyModels = agyModelCatalog();
let agyModelsWarmed = false;
export function codexModelCatalog(read = readFileSync, now = Date.now) {
  let models = [], loaded = false, checked = null, error = null;
  const refresh = () => {
    checked = new Date(now()).toISOString();
    try {
      const cache = JSON.parse(read(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
      models = cache.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
      loaded = true;
    } catch (err) { loaded = false; error = { message: err.message ?? String(err), at: checked }; }
    return loaded ? models : [];
  };
  refresh.status = () => ({ models, loaded, checked, error });
  return refresh;
}
const codexModels = codexModelCatalog();
const claudeModels = ['opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
export function modelChoices() {
  return { claude: claudeModels, codex: codexModels(), agy: agyModels() };
}
export function modelAlignment(model, catalog) {
  if (!model) return 'CLI default';
  if (!catalog.loaded) return catalog.checked ? 'list unavailable' : 'list not read yet';
  return catalog.models.some((m) => m.id === model) ? 'in list' : 'not in list';
}
// A model's name for the tab titles: its label in the catalog (or its ID), "<Provider> default" for the CLI default.
function modelLabel(provider, model) {
  if (!model) return `${provider[0].toUpperCase() + provider.slice(1)} default`;
  return modelChoices()[provider]?.find((m) => m.id === model)?.label ?? model;
}
// The Providers tab: the shared defaults for discussion members and the worker together. Before
// this discussion starts they also apply to it, as the tab panels' changes do then. After, they
// change only the defaults (the file, and this room's for new discussions), never the running
// agents or worker: those stay with the Discussion and Worker tabs' own panels.
export async function saveDefaultSettings(ctx, value, file = defaultsFile()) {
  const settings = validateSettings(value);
  if (!settingsStarted(ctx)) return saveSettings(ctx, settings, file);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  const launch = roomDefaults(ctx);
  launch.agents = settings.agents.map(specFor).join(',');
  launch.worker = specFor(settings.worker);
  showHeader(ctx);
  return { applied: false, settings };
}
// Work in another open discussion must not change this discussion's settings boundary.
const settingsStarted = (ctx) => !!ctx.agentsStarted || !!ctx.logPath || !!ctx.state.transcript.length;
export async function saveSettings(ctx, value, file = defaultsFile()) {
  const applied = !settingsStarted(ctx);
  const scope = value?.scope;
  const current = ctx.agentSpecs ? currentSettings(ctx) : { agents: value.agents, worker: parseSpec(ctx.workerSpec, true) };
  const launch = roomDefaults(ctx, current);
  const defaults = readDefaults(file) ?? { agents: launch.agents.split(',').map((s) => parseSpec(s)), worker: parseSpec(launch.worker, true) };
  // Once work has started, the worker tab validates against the running agents, not future defaults.
  const settings = validateSettings(!applied && scope === 'work' ? { ...value, agents: current.agents } : value);
  const worker = !applied && scope === 'talk' ? current.worker : settings.worker;
  if (!applied && ctx.room.agents.some((a) => a.name.toLowerCase() === worker.name.toLowerCase()))
    throw new Error('The worker needs a different name from the running discussion agents.');
  // Discussion changes still save as defaults. A started discussion's worker changes do not.
  const saved = validateSettings({ agents: scope === 'work' ? defaults.agents : settings.agents,
    worker: applied && scope !== 'talk' ? worker : defaults.worker });
  const next = { ...ctx, agentSpecs: settings.agents.map(specFor).join(','), workerSpec: specFor(worker),
    sessions: new Map(), state: { ...ctx.state, seen: new Map(ctx.state.seen) } };
  const workerChanged = next.workerSpec !== ctx.workerSpec;
  const previous = parseSpec(ctx.workerSpec, true);
  const freshWorker = previous.provider !== worker.provider || previous.name !== worker.name;
  if (!applied) {
    next.sessions = new Map(ctx.sessions);
    if (freshWorker) next.sessions.set(`worker:${worker.name}`, {});
  }
  // The two launch defaults must also form a valid room when a panel updates one of them.
  validateSettings({ agents: (scope !== 'work' ? settings.agents : launch.agents.split(',').map((s) => parseSpec(s))),
    worker: applied && scope !== 'talk' ? worker : parseSpec(launch.worker, true) });
  // Build first so validation/loading errors cannot replace defaults or the running room.
  const loaded = await load(next, new URL(import.meta.url).search);
  if (applied || JSON.stringify(saved) !== JSON.stringify(defaults)) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, file);
  }
  if (scope !== 'work') launch.agents = settings.agents.map(specFor).join(',');
  if (applied && scope !== 'talk') launch.worker = specFor(worker);
  if (applied) {
    Object.assign(ctx, loaded, { agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, sessions: next.sessions, state: next.state });
    wire(ctx);
  } else if (workerChanged) {
    ctx.worker = loaded.worker;
    ctx.makeWorker = loaded.makeWorker;
    ctx.closingStatement = loaded.closingStatement;
    ctx.workerSpec = next.workerSpec;
    ctx.sessions.set(`worker:${worker.name}`, next.sessions.get(`worker:${worker.name}`));
    if (freshWorker) {
      ctx.workerBriefed = null;
      ctx.workerTree = null;
      ctx.workerLabel = null;
      ctx.workerHandoff = true;
    }
    saveCheckpoint(ctx);
  }
  showHeader(ctx);
  return { applied, workerApplied: true, settings: saved };
}

// Imports fresh copies of the modules and the rulebook layers and builds a room on ctx.state, and the worker. Returns
// the parts to put into ctx; if anything fails it throws, leaving ctx as it was (at most an
// unused empty session added).
export async function load(ctx, v) {
  // A workshop built by the code before each discussion had its own queue (slice 1a) can't be taken
  // over by this code: Reload (and --dev's) is refused, in every room, before anything changes, and
  // so is a discussion opened beside the others meanwhile; Restart starts this code afresh.
  const existing = ctx.shop ?? siblings(ctx).find((r) => r !== ctx && r.shop)?.shop;
  if (existing && !existing.lanes) throw new Error(UPDATE_NEEDS_RESTART);
  if (!ctx.agentSpecs || !ctx.workerSpec) {
    const saved = readDefaults();
    ctx.agentSpecs ??= saved ? saved.agents.map(specFor).join(',') : 'claude,codex';
    ctx.workerSpec ??= saved ? specFor(saved.worker) : 'claude:Worker';
  }
  const instr = await import(`./instructions.mjs${v}`);
  const readRulebook = (name) => readFileSync(ctx.rulebooksDir ? join(ctx.rulebooksDir, instr.RULEBOOKS[name]) : instr.rulebookPath(name), 'utf8');
  const readRulebooks = (kind) => instr.RULEBOOK_LAYERS[kind]
    .map((name) => readRulebook(name).trimEnd())
    .join('\n\n');
  const isResearch = !!ctx.state?.research || isResearchDir(ctx.discussion?.dir);
  const discussingInstructions = readRulebooks('discussing');
  const researchingInstructions = readRulebooks('researching');
  const instructions = isResearch ? researchingInstructions : discussingInstructions;
  const workerInstructions = readRulebooks('worker');
  const { createAgent, claudeTitle, run, findLeftovers, parseCodexEvents, parseAgyOutput, parseClaudeStream, CLAUDE_STREAM } = await import(`./agents.mjs${v}`);
  const { createRoom, closingStatement, formattedTurn } = await import(`./room.mjs${v}`);
  const docs = await import(`./docs.mjs${v}`);
  const lanes = await import(`./lanes.mjs${v}`);
  const workshopModule = await import(`./workshop.mjs${v}`);
  const boardsModule = await import(`./boards.mjs${v}`);
  const monitorModule = await import(`./monitor.mjs${v}`);
  const schedulerModule = await import(`./scheduler.mjs${v}`);
  const usage = await import(`./usage.mjs${v}`);
  // Replication is loaded only with --node.
  const replicate = ctx.node ? await import(`./replicate.mjs${v}`) : null;
  // The room's identity on its server: its folder's real path, and the id in its addresses.
  ctx.key ??= real(ctx.cwd);
  ctx.id ??= roomId(ctx.key);
  // Every agent program this room starts is tracked, so Quit room can stop it; once the room is
  // stopping, none starts (shared by reference, so copies of ctx and reloads see the same).
  const programs = ctx.programs ??= { running: new Set(), stopping: false };
  // Each is in the record of programs too (agents.mjs), so a leftover is found after a crash; the
  // header's count of programs running follows each start and end.
  const runner = (command, args, options) => {
    if (programs.stopping) return Promise.reject(new Error('not started: the room is quitting'));
    const turn = run(command, args, { ...options, procs: programs.running, record: { agent: options?.agent ?? command, room: ctx.cwd } });
    for (const proc of programs.running) if (!proc.monitorInfo) proc.monitorInfo = { agent: options?.agent ?? command, room: ctx.cwd, started: new Date().toISOString() };
    ctx.showMonitor?.();
    turn.then(() => ctx.showMonitor?.(), () => ctx.showMonitor?.());
    return turn;
  };
  const turnRecords = ctx.turnRecords ??= new WeakMap();
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const { provider, name, model } = parseSpec(spec);
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    const session = ctx.sessions.get(name);
    return monitorAgentTurns(createAgent(provider, { name, model, cwd: ctx.cwd, instructions, runner, session }), session, turnRecords, ctx);
  });
  // The worker's session is kept under its own key, so it never mixes with a room agent's.
  const { provider: wProvider, name: wName, model: wModel } = parseSpec(ctx.workerSpec, true);
  if (agents.some((a) => a.name === wName)) throw new Error(`The worker's name "${wName}" is taken by a room agent`);
  if (!ctx.sessions.has(`worker:${wName}`)) ctx.sessions.set(`worker:${wName}`, {});
  // The folder's workshop (see "Several open discussions"): the worker's queue, worktree and tab,
  // shared by every discussion open in this folder, and by reference so it survives reloads.
  const shop = ctx.shop ?? siblings(ctx).find((r) => r !== ctx && r.shop)?.shop ?? null;
  // The worktree its worker's task runs in (see refreshWorker): its own, as tasks of different
  // discussions run at the same time; by reference, so it survives reloads and settings copies.
  const workerDir = ctx.workerDir ??= { path: null };
  // A worker agent keeps the programs of its task in `programs`, so Stop now (stopWorker) stops only
  // those; once that task is stopped, none starts. One worker session runs one task at a time.
  const makeWorker = (session) => {
    const programs = { running: new Set(), stopped: false };
    const own = (command, args, options) => (programs.stopped ? Promise.reject(new Error('not started: the User stopped this instruction'))
      : runner(command, args, { ...options, started: (p) => programs.running.add(p) }));
    return Object.assign(monitorAgentTurns(createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions,
      timeoutMs: WORKER_TIMEOUT_MS, runner: own, session }), session, turnRecords, ctx), { programs });
  };
  const worker = makeWorker(ctx.sessions.get(`worker:${wName}`));
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: shop?.log ?? [], working: shop && runningTasks(shop).some((t) => t.origin === ctx) ? wName : null };
  const roomShop = shop ?? newShop(screen.worker);
  roomShop.launchDefaults ??= { agents: ctx.agentSpecs, worker: ctx.workerSpec };
  const usageLine = (agent) => usage.agentUsageLine({
    total: ctx.totals?.[agent.name],
    provider: agent.provider,
    gauges: ctx.screen?.quota,
    measured: ctx.screen?.quotaAt?.providers ?? ctx.screen?.quotaAt?.measured,
  });
  return { room: createRoom(agents, ctx.state, instr, usageLine), worker, docs, lanes, workshopModule, boardsModule, monitorModule, schedulerModule, usage, replicate, totals: ctx.totals ?? {}, screen, findLeftovers,
    shop: roomShop,
    testPrompt: (room, provider, model) => runPromptTest(room, provider, model, runner, { parseCodexEvents, parseAgyOutput, parseClaudeStream, CLAUDE_STREAM }),
    // A new worker agent on `session` (detachWorker), as this load made ctx.worker.
    makeWorker,
    // Close's closing statement, written by a one-off agent with the worker's provider and model, in
    // the room's folder, with no rulebook and a session of its own (never the worker's session or
    // worktree). `agent`: a stand-in for tests (ctx.closingAgent).
    closingStatement: (options, agent = createAgent(wProvider, { name: wName, model: wModel, cwd: ctx.cwd, runner, session: {} })) =>
      closingStatement(agent, options, instr),
    suggestTitle: (message, options) => claudeTitle(message, { ...options, runner }, instr),
    instructions: instr,
    rulebooks: { discussing: discussingInstructions, researching: researchingInstructions, active: instructions, worker: workerInstructions },
    formattedTurn };
}

export const UPDATE_NEEDS_RESTART = 'This update changes the worker\'s queues: Restart to apply it (Reload can\'t).';

// A room's id in its addresses (/r/<id>/…): its folder's name and a short hash of its real path, so
// it stays the same across a Restart and open pages reconnect to their own room.
export const roomId = (key) => `${slug(basename(key)) || 'room'}-${createHash('sha256').update(key).digest('hex').slice(0, 6)}`;

const tty = process.stdout.isTTY;
const style = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = style('1');
const dim = style('2');
const red = style('31');
// A line for the terminal (or the Dock app's log). In UI mode one server runs several rooms, so
// each line says which room it is from: ctx.label, set by cli.mjs.
const labelled = (ctx, text) => (ctx?.label ? String(text).replace(/^(?=.)/gm, `[${ctx.label}] `) : String(text));
const out = (ctx, text) => console.log(labelled(ctx, text));
// Until the discussion's (or brainstorm's) folder exists (at the first message), the transcript is kept in memory.
const log = (ctx, text) => {
  if (ctx.logPath) appendFileSync(ctx.logPath, text);
  else ctx.pendingLog = (ctx.pendingLog ?? '') + text;
};
const describe = (room) => room.agents.map((a) => `${a.name} (${a.provider})`).join(', ');
const when = (d) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// The Instructions tab's content: the catalog from instructions.mjs, with each rulebook's ref
// resolved to its current file text (read afresh, so an edited rulebook shows its new content).
function instructionRegistry(ctx) {
  const instr = ctx.instructions ?? defaultInstructions;
  const pathFor = (name) => (ctx.rulebooksDir ? join(ctx.rulebooksDir, instr.RULEBOOKS[name]) : instr.rulebookPath(name));
  return instr.instructionSets.map((set) => ({
    type: set.type,
    pieces: set.pieces.map((piece) => piece.ref
      ? { id: piece.id, intent: piece.intent, when: piece.when, content: readFileSync(pathFor(piece.ref), 'utf8') }
      : { id: piece.id, intent: piece.intent, when: piece.when, content: piece.content }),
  }));
}

// Points the screen at the code loaded now (at start and after each reload): the header's names and,
// in UI mode, the Worker tab's input.
function wire(ctx) {
  ctx.screen.room = header(ctx);
  // With --node only the launch room replicates: its Peers panel works, the others' says why.
  ctx.screen.replicaOff = ctx.hub?.node && !ctx.node ? replicaOff(ctx) : null;
  if (ctx.replica) wireReplica(ctx); // its peer endpoint works in terminal mode too
  ctx.screen.refreshWorker = () => refreshWorker(ctx).catch(() => {}); // when the Worker tab is shown
  if (ctx.noScreen) return;
  // What the User types pauses a running auto dev (as it arrives, not when its turn comes).
  ctx.screen.work = (text) => {
    autoDevInput(ctx, 'you sent the Worker an instruction');
    if (ctx.state.workbench) return sendWorkbenchInstruction(ctx, text).catch((err) => note(ctx, `✗ ${err.message}`, true));
    return queueWork(ctx, text);
  };
  ctx.screen.say = (line, confirmed) => {
    if (!line.trim().startsWith('/')) autoDevInput(ctx, 'you sent a message');
    // Quit room closes every discussion open in this folder.
    if (line.trim() === '/quit') for (const c of siblings(ctx)) if (c !== ctx) c.say?.('/quit');
    return ctx.say(line, confirmed);
  };
  ctx.screen.newRoom = (body) => newRoom(ctx, body);
  ctx.screen.listRooms = async () => listRooms(ctx);
  ctx.screen.instructions = () => instructionRegistry(ctx);
  if (!agyModelsWarmed) { agyModelsWarmed = true; agyModels(); } // start without delaying room startup
  ctx.screen.getSettings = () => {
    const launch = roomDefaults(ctx);
    return { settings: currentSettings(ctx), defaults: readDefaults(),
      launchDefaults: { agents: launch.agents.split(',').map((s) => parseSpec(s)), worker: parseSpec(launch.worker, true) },
      models: modelChoices(), started: settingsStarted(ctx) };
  };
  ctx.screen.providerHealth = () => healthView(ctx);
  ctx.screen.testPrompt = (body) => ctx.testPrompt(ctx, body?.provider, body?.model);
  ctx.screen.checkProviderHealth = () => checkProviderHealth(ctx);
  ctx.screen.saveSettings = (value) => (value?.scope === 'defaults' ? saveDefaultSettings(ctx, value) : saveSettings(ctx, value));
  ctx.screen.retryWork = (id, settings) => retryWork(ctx, id, settings);
  ctx.screen.stopWorker = (mode) => stopWorker(ctx, mode);
  ctx.screen.cancelClose = (name) => cancelClose(ctx, name);
  ctx.screen.discardPreview = (name) => discardPreview(ctx, name);
  ctx.screen.closeAndDiscard = (name, snapshot) => closeAndDiscard(ctx, name, snapshot);
  ctx.screen.mergePreviewClose = (name) => closeMergePreview(ctx, name);
  ctx.screen.closeAndMerge = (name, snapshot) => closeAndMerge(ctx, name, snapshot);
  ctx.screen.catchUpMerge = (name) => catchUpWithBranch(ctx, name);
  ctx.screen.setAgentEnabled = (name, enabled, member) => setAgentEnabled(ctx, name, enabled, { member });
  ctx.screen.getSchedule = () => getSchedule(ctx);
  ctx.screen.saveSchedule = (body) => saveSchedule(ctx, body);
}

// The screen's header: the full root path, the active discussion (active: its folder, under the
// root), and whether this session has started (its first message sent, so its discussion is fixed).
function header(ctx) {
  const d = ctx.discussion;
  const specs = (ctx.agentSpecs ?? '').split(',').filter(Boolean).map((s) => parseSpec(s));
  const workerSpec = ctx.workerSpec ? parseSpec(ctx.workerSpec, true) : null;
  return { folder: ctx.cwd, ownCheckout: real(ctx.cwd) === real(dirname(dirname(fileURLToPath(import.meta.url)))), agents: ctx.room.agents.map((a) => a.name), worker: ctx.worker.name,
    workerModel: workerSpec ? modelLabel(workerSpec.provider, workerSpec.model) : null, // for the Worker tab's title
    cliSessions: sessionView(ctx),
    discussion: d ? d.title : ctx.state.brainstorm ? 'New brainstorm' : ctx.state.workbench ? 'New workbench' : ctx.state.research ? 'New research board' : 'No discussion started',
    active: folderOf(ctx), started: !!ctx.logPath || !!ctx.state.brainstorm || !!ctx.state.workbench || !!ctx.state.research,
    fresh: !settingsStarted(ctx) && !ctx.state.workbench, // its members can still be chosen: the page opens their panel
    brainstorm: !!ctx.state.brainstorm, // a brainstorm, in brainstorms/<name>/ once started (see newBrainstorm)
    workbench: !!ctx.state.workbench, // a worker-only board, in discussions/<name>/ with .workbench marker
    research: !!ctx.state.research, // a research board, in discussions/<name>/ with .research marker
    workbenches: workbenchNames(ctx),
    researches: researchNames(ctx), researchStats: researchStats(ctx),
    // The agents this discussion started with, for the members panel once it has started.
    members: ctx.room.agents.map((a) => ({ provider: a.provider, name: a.name,
      model: specs.find((s) => s.name === a.name)?.model ?? '',
      modelLabel: modelLabel(a.provider, specs.find((s) => s.name === a.name)?.model ?? ''), // for the Discussion tab's title
      enabled: !(ctx.state.disabledAgents ?? []).includes(a.name) })),
    failedAgents: ctx.room.agents.filter((a) => ctx.state.transcript.some((m) => m.error && m.speaker === a.name) || (ctx.state.disabledAgents ?? []).includes(a.name)).map((a) => ({ name: a.name, disabled: (ctx.state.disabledAgents ?? []).includes(a.name) })),
    autoDev: autoDevView(ctx), workerStop: workerStopView(ctx), retryId: ctx.retryFailure?.available ? ctx.retryFailure.id : null,
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null,
    checkpoints: checkpoints(ctx), // the saved discussions, for Explorer's Resume (see "Checkpoints")
    closedDiscussions: closedDiscussions(ctx),
    closingDiscussions: Object.fromEntries([...(shopOf(ctx).closing?.entries() ?? [])].map(([name, c]) => [name, c.waiting ? 'waiting' : 'writing'])),
    busyWorkers: [...new Set([...runningTasks(shopOf(ctx)), ...queuedTasks(shopOf(ctx))].map((t) => t.owner).filter(Boolean))],
    back: ctx.previous ?? null, // the discussion before the last switch, until the next one starts
    code: ctx.code ?? null, // the version this process runs (see codeInfo)
    rollbacks: [...(shopOf(ctx).rollbacks?.values() ?? [])].map(({ name, status, report, commit }) => ({ name, status, report, commit })),
    multi: multi(ctx), open: openList(ctx) }; // the folder's open discussions (see openList)
}
// The Worker tab's stop buttons: while this discussion's worker runs an instruction (see stopWorker).
function workerStopView(ctx) {
  if (!ctx.shop) return null;
  const t = runningTasks(ctx.shop).find((x) => x.owner === ownerOf(ctx));
  return t ? { after: !!t.stopAfter, now: !!t.stopNow } : null;
}
export function sessionView(ctx) {
  const id = (agent, key) => {
    const session = ctx.sessions?.get(key);
    return agent.provider === 'claude' ? (session?.started ? session.id : null)
      : agent.provider === 'codex' ? session?.threadId : agent.provider === 'agy' ? session?.conversationId : null;
  };
  return { agents: ctx.room.agents.map((a) => ({ name: a.name, provider: a.provider, id: id(a, a.name) ?? null })),
    worker: { name: ctx.worker.name, provider: ctx.worker.provider, id: id(ctx.worker, `worker:${ctx.worker.name}`) ?? null } };
}
// Every page of the folder's open discussions: they list each other.
function showHeader(ctx) {
  for (const c of siblings(ctx)) {
    if (c.stopped || !c.room || !c.worker) continue; // still loading or already stopped
    c.screen.room = header(c);
    toScreen(c, { type: 'room', room: c.screen.room });
  }
}

// A participant can be disabled in this discussion without changing future-room defaults: a failed
// one from its notice, any one of a started discussion from the members panel (`member`). During a
// round, the change counts from the next round (a round keeps the speakers it started with) and is
// checkpointed with that round; between rounds, at once.
export function setAgentEnabled(ctx, name, enabled, { member = false } = {}) {
  const agent = ctx.room.agents.find((a) => a.name === name);
  if (!agent || typeof enabled !== 'boolean') throw new Error('Unknown discussion agent.');
  if (ctx.stopped || (ctx.busy && !member)) throw new Error('Wait for the current discussion turn to end.');
  if (member && !settingsStarted(ctx)) throw new Error('Before the discussion starts, choose its members in the panel.');
  const disabled = new Set(ctx.state.disabledAgents ?? []);
  if (!enabled) {
    if (!member && !ctx.state.transcript.some((m) => m.speaker === name && m.error)) throw new Error('Only a failed agent can be disabled here.');
    if (!disabled.has(name) && ctx.room.agents.length - disabled.size <= 1) throw new Error('At least one discussion agent must stay enabled.');
    disabled.add(name);
  } else disabled.delete(name);
  ctx.state.disabledAgents = [...disabled];
  if (!ctx.busy) captureRound(ctx);
  showHeader(ctx);
}

// ── Discussions ───────────────────────────────────────────────────────
// A discussion is a folder in <root>/discussions/, named once as date + first title (or date and
// time when there is no title) and never moved; -2, -3… if the name is taken.
const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = (d) => `${pad(d.getHours())}${pad(d.getMinutes())}`;
export const slug = (title) => title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

// Finished discussions move, whole, into discussions/archive/, postponed ones into discussions/deferred/
// (/move); both folders are created when first needed.
// ── Several open discussions ──────────────────────────────────────────
// On the browser screen a folder can have several discussions open at once. Each is its own context:
// a ctx with its own agents' sessions, chat, input queue, auto dev and page, made by cli.mjs's addRoom
// with a `context` tag (ctx.key is then "<folder>#<tag>"). They share the folder's workshop
// (ctx.shop): one worker queue, worktree and Worker tab; each task is labelled with its origin and
// its report goes back there, and each context has its own worker settings and session. One window shows one
// context; Explorer and the header switch between them ('goto'). New discussion, Resume and Start
// fresh open another context and keep this one; Close discussion closes one (its checkpoint stays);
// Quit room closes them all.
// Terminal mode keeps one discussion at a time: its one input can't switch between contexts.
const baseKey = (ctx) => String(ctx.key ?? ctx.cwd).split('#')[0];
export function siblings(ctx) {
  const list = ctx.hub?.rooms ? [...ctx.hub.rooms.values()].filter((r) => r.screen && baseKey(r) === baseKey(ctx)) : [];
  return list.includes(ctx) ? list : [ctx, ...list];
}
const multi = (ctx) => !ctx.noScreen;
// A context with nothing in it yet: New discussion, Resume, Start fresh and New brainstorm use it in place
// (a new brainstorm not started yet too, for New brainstorm, New discussion, Resume and Start fresh).
const fresh = (ctx) => !ctx.discussion && !ctx.logPath && !ctx.state.transcript.length;
// Which discussion a context works for now, as an identity for worker holds: its folder name, the
// brainstorm's own ID, or (no discussion yet) its worker session. Not the context, which a terminal
// switches between discussions, nor the label, which every brainstorm shares.
const ownerOf = (ctx) => (ctx.discussion && !ctx.state?.brainstorm ? ctx.discussion.name
  : ctx.state?.brainstorm ? `brainstorm:${ctx.state.brainstormId}` : `no discussion:${ctx.workerSeat ??= randomBytes(6).toString('hex')}`);
// The task label: the discussion's folder name, or the brainstorm.
const originLabel = (ctx) => (ctx.state.brainstorm ? 'brainstorm' : ctx.discussion?.name ?? 'no discussion');
const pageOf = (ctx) => `${roomPath(ctx)}__room`;
// started: its first message was sent (Explorer shows Resume for it then, Go to before).
function hasWorkerTask(ctx) {
  const shop = ctx.shop;
  const owner = ownerOf(ctx);
  return !!ctx.screen?.working || (ctx.workPending ?? 0) > 0
    || !!(shop && (runningTasks(shop).some((t) => t.owner === owner)
      || queuedTasks(shop).some((t) => t.owner === owner)));
}
function isOngoing(ctx) {
  const shop = ctx.shop;
  return !!ctx.busy || hasWorkerTask(ctx)
    || !!(shop && ctx.discussion && !ctx.state.brainstorm && shop.closing?.has(ctx.discussion.name));
}
function waitingState(ctx) {
  const workReady = !!ctx.workReady && !ctx.state.brainstorm && !ctx.state.workbench && !ctx.state.research;
  if (ctx.autoDev?.status === 'paused') {
    return { waitingForInput: true, waitingReason: ctx.autoDev.reason || 'Auto dev paused', readyForAutoDev: false, workReady };
  }
  if (ctx.retryFailure?.available) {
    return {
      waitingForInput: true,
      waitingReason: ctx.retryFailure.error ? `Worker failed: ${ctx.retryFailure.error}` : 'Worker failed: Retry available',
      readyForAutoDev: false,
      workReady,
    };
  }
  const offer = autoDevOffer(ctx);
  if (offer?.error) {
    return { waitingForInput: true, waitingReason: offer.error, readyForAutoDev: false, workReady };
  }
  const t = ctx.state?.transcript ?? [];
  const last = t.at(-1);
  if (t.length > (ctx.workDispatchedLen ?? 0) && last?.outcome === 'agreed' && summaryHasNextStep(last.text) && !offer?.text
      && !(workReady && summaryOutcome(last.text) === 'FINISH')) {
    return { waitingForInput: true, waitingReason: null, readyForAutoDev: false, workReady };
  }
  if (offer?.text) {
    return { waitingForInput: false, waitingReason: null, readyForAutoDev: true, workReady };
  }
  return { waitingForInput: false, waitingReason: null, readyForAutoDev: false, workReady };
}
function openList(ctx) {
  return siblings(ctx).filter((c) => c.state && c.id && !c.stopped).map((c) => ({ url: pageOf(c), current: c === ctx,
    title: c.discussion?.title ?? (c.state.brainstorm ? 'New brainstorm (not started)' : c.state.workbench ? 'New workbench (not started)' : c.state.research ? 'New research board (not started)' : 'New discussion (not started)'),
    active: folderOf(c), brainstorm: !!c.state.brainstorm, workbench: !!c.state.workbench, research: !!c.state.research, started: !!c.logPath, working: !!c.screen.working,
    workerBusy: hasWorkerTask(c),
    ongoing: isOngoing(c), ...waitingState(c) }));
}
// One set of new-discussion defaults for this folder's open contexts, not the whole server.
function roomDefaults(ctx, fallback) {
  const shop = shopOf(ctx);
  if (shop.launchDefaults) return shop.launchDefaults;
  const initial = fallback ?? { agents: ctx.room.agents.map((a) => ({ ...a, model: a.model ?? '' })), worker: { ...ctx.worker, model: ctx.worker.model ?? '' } };
  return shop.launchDefaults ??= { agents: ctx.agentSpecs ?? initial.agents.map(specFor).join(','), worker: ctx.workerSpec ?? specFor(initial.worker) };
}
// ── Open room in folder… ────────────────────────────────────────
// The Mac's own folder chooser, run by the server because it needs the full path (a browser's
// picker gives only the name). Resolves to the path, or null if the User cancelled.
function chooseFolder() {
  const script = 'POSIX path of (choose folder with prompt "Choose the folder of the room to open")';
  return new Promise((done, fail) => execFile('osascript', ['-e', 'activate', '-e', script], (err, stdout, stderr) => {
    if (err) return /-128/.test(stderr) ? done(null) : fail(new Error(`the folder chooser failed: ${stderr.trim() || err.message}`));
    const path = stdout.trim();
    done(path.length > 1 ? path.replace(/\/$/, '') : path || null);
  }));
}

export const roomsFile = () => join(homedir(), '.local', 'state', 'agent-room', 'rooms.json');

// Record a room's canonical root folder for local tools (such as the MCP service).
// Adds it if missing; never removes entries automatically.
export function recordRoom(dir, file = roomsFile()) {
  const root = realpathSync(dir);
  let rooms = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) rooms = parsed.filter((r) => typeof r === 'string' && r.length > 0);
    } catch {}
  }
  if (rooms.includes(root)) return rooms;
  rooms.push(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(rooms, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return rooms;
}

// Switch room…: this server's rooms, straight from its list. `pages`: the pages open on each (on
// any device), so the chooser doesn't offer a room already open in another window.
export function listRooms(ctx) {
  const rooms = ctx.hub ? [...ctx.hub.rooms.values()] : [ctx];
  return rooms.filter((r) => r.id && r.screen).map((r) => ({ id: r.id, path: roomPath(r) + '__room', root: r.cwd,
    discussion: r.screen.room?.active ?? null, pages: r.screen.clients.size, current: r === ctx }))
    .sort((a, b) => a.root.localeCompare(b.root));
}
const roomPath = (ctx) => `/r/${ctx.id}/`;

export function assertRoomCreation(hub) {
  if (hub?.ending) throw new Error('The server is ending: no room can be created.');
}

// Confirmation is checked on the server for every entry point.
export function serverEndWarning(hub) {
  const busy = [...hub.rooms.values()].filter((r) => r.busy || r.screen?.working);
  if (!busy.length) return null;
  return 'Busy rooms:\n' + busy.map((r) => r.cwd + ': ' +
    [r.busy && 'discussion round in progress', r.screen?.working && 'worker instruction running'].filter(Boolean).join(', ')).join('\n') +
    '\nRunning workers may be stopped at once, leaving partial changes. Continue?';
}

// Open room in folder…: the folder's room on this server, or (once the page has asked the User) a
// new room there, using saved defaults (or this room's agents if none are saved).
// The first request ({}) runs the chooser and creates nothing. It resolves to { cancelled: true };
// { url, folder, existing: true, open } when the folder (by its real path) has a room, `open` when a
// page shows it already; or { confirm: true, token, folder } when it has none. The second request
// ({ token }, or { token, cancel: true }) creates the room for that folder, or drops it: a token
// works once and names only a folder this room's chooser returned, so a page can't name a folder.
export async function newRoom(ctx, body = {}, choose = chooseFolder) {
  assertRoomCreation(ctx.hub);
  const tokens = ctx.roomTokens ??= new Map();
  if (body?.token !== undefined) {
    const folder = typeof body.token === 'string' ? tokens.get(body.token) : undefined;
    if (!folder) throw Object.assign(new Error('this folder choice has expired or was already used: choose the folder again.'), { status: 400 });
    tokens.delete(body.token);
    if (body.cancel) return { cancelled: true };
    return openRoom(ctx, folder);
  }
  const folder = await choose();
  if (!folder) return { cancelled: true };
  if (!ctx.hub?.addRoom) throw new Error('this room can\'t open another one.');
  const had = ctx.hub.rooms.get(realpathSync(folder));
  if (had) return { url: roomPath(had) + '__room', folder: had.cwd, existing: true, open: had.screen?.clients.size > 0 };
  const token = randomBytes(16).toString('hex');
  tokens.set(token, folder);
  return { confirm: true, token, folder };
}

async function openRoom(ctx, folder) {
  const defaults = readDefaults();
  const { ctx: room, existing } = await ctx.hub.addRoom(folder, {
    agents: defaults ? defaults.agents.map(specFor).join(',') : ctx.agentSpecs,
    worker: defaults ? specFor(defaults.worker) : ctx.workerSpec ?? 'claude:Worker' });
  const url = roomPath(room) + '__room';
  // Added meanwhile (another page's Create room): that room, as the first request would have said.
  if (existing) return { url, folder: room.cwd, existing: true, open: room.screen?.clients.size > 0 };
  log(ctx, `_(opened a new room in ${room.cwd})_\n\n`);
  out(ctx, `New room in ${room.cwd}: ${url}`);
  return { url, folder: room.cwd };
}

function replicaOff(ctx) {
  const launch = [...ctx.hub.rooms.values()].find((r) => r.launch);
  return `Replication runs only for this server's launch room${launch ? ` (${launch.cwd})` : ''}. A --peer address names a whole server, `
    + 'not one of its rooms, so this room has no peer: its rounds are neither saved for replication nor sent.';
}

export const promptText = () => (tty ? '\x1b[1;36mYou ›\x1b[0m ' : 'You › ');

// Once per session: print the banner. Nothing is written in the root yet: the transcript waits in
// memory for the first message, which creates the discussion's folder (openDiscussion).
// UI mode (not --no-screen): the discussion screen is the room's input and output, so it is opened
// here (in an interactive terminal or with --open; other piped runs just print its address)
// and lines the User sends from it go to ctx.say. The terminal then only shows a log.
export async function start(ctx) {
  ctx.openedAt = new Date();
  ctx.screen.startedAt = ctx.openedAt.toISOString(); // the page's and the Dock app's heartbeat show it
  try { recordRoom(ctx.cwd); } catch {}
  out(ctx, `Room: ${describe(ctx.room)} · worker ${ctx.worker.name} (${ctx.worker.provider}) · root ${ctx.cwd}`);
  out(ctx, `Transcript: in ${join(ctx.cwd, 'discussions')}/, once the first message starts a discussion`);
  // Another open discussion of the launch room replicates as the launch room does.
  const owner = !ctx.node && ctx.context && siblings(ctx).find((c) => c.replicaOwner);
  if (owner) Object.assign(ctx, { node: owner.node, peers: owner.peers, replicate: owner.replicate });
  // With --node: the server first (with --peer its port must be the configured one), then the storage.
  if (ctx.node) { await viewerUrl(ctx); await setupReplica(ctx); }
  wire(ctx);
  // Calls through ctx, so after a reload it runs the new code.
  ctx.quotaTimer ??= setInterval(() => ctx.refreshQuota?.(), 60_000).unref();
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  ctx.refreshQuota();
  watchMonitor(ctx);
  startScheduler(ctx);
  ctx.code = { ...await codeInfo(), startedAt: ctx.screen.startedAt };
  if (ctx.replica) { ctx.project = await codeInfo(ctx.cwd); await pushReplica(ctx); }
  showHeader(ctx);
  refreshWorker(ctx).catch(() => {}); // the Worker tab's line; creates nothing
  await recoverWorkerOwner(ctx);
  if (ctx.noScreen) {
    return out(ctx, 'Type a message, /docs to browse the discussions, /summary to sum up, /usage for tokens and quotas, /reload after editing the code, or /quit.\n');
  }
  const base = await viewerUrl(ctx);
  const screenUrl = `${base.slice(0, -1)}${roomPath(ctx)}__room`;
  out(ctx, `Room screen: ${screenUrl}`);
  // A room added later (Open room in folder…, or brought back by Restart) opens in its own window.
  if (ctx.added) return;
  // The server's address, which opens its first room: what the Dock app reads from the log.
  console.log(`Discussion screen: ${base}__room${tty || ctx.open ? ' (opening it in your browser)' : ''}`);
  if (!ctx.node) for (const address of lanAddresses()) console.log(`  LAN: http://${address}:${hubOf(ctx).server.address().port}/__room`);
  console.log('Use the rooms from the browser. This terminal only shows a log; Shutdown server there, or Ctrl-C here, ends them all.\n');
  if (ctx.open) {
    await new Promise((done, fail) => execFile('open', [screenUrl], (err) => err ? fail(err) : done()));
  } else if (tty) browse(screenUrl);
}

const browse = (url) => execFile('open', [url], (err) => err && console.log(red(`✗ ${err.message}`)));

// Output that isn't a chat message: printed in the terminal and shown on the screen.
export function note(ctx, text, error = false) {
  out(ctx, error ? red(text) : text);
  toScreen(ctx, { type: 'note', text, error });
}

export async function reloaded(ctx) {
  if (ctx.node) await setupReplica(ctx).catch((err) => note(ctx, `✗ Replication: ${err.message}`, true));
  wire(ctx);
  if (ctx.hub) { ctx.hub.route = route; ctx.hub.upgrade = upgrade; } // the server's routing runs the new code too
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  watchMonitor(ctx);
  startScheduler(ctx);
  log(ctx, '_(code reloaded)_\n\n');
  // A relay whose worker result can't come back any more: pause visibly rather than send again.
  const run = ctx.autoDev;
  if (run?.status === 'running' && run.waiting && !runningTasks(shopOf(ctx)).some((t) => t.origin === ctx) && !ctx.workPending) pauseAutoDev(ctx, 'the worker\'s result was lost in the Reload');
  note(ctx, 'Reloaded the code and the agents\' rulebooks; the conversation continues.\n');
  toScreen(ctx, { type: 'reloaded', page: ctx.docs.PAGE, webVersion: ctx.docs.nextVersion?.() ?? null }); // pages refresh if their code changed
  // The header's version: the checkout as it is at this Reload (the start's snapshot is kept).
  const at = new Date().toISOString();
  codeInfo().then(({ commit, dirty }) => {
    if (ctx.code) ctx.code.reloaded = { at, commit, dirty };
    showHeader(ctx);
  }).catch(() => {});
  if (ctx.replica) codeInfo(ctx.cwd).then((p) => { ctx.project = p; pushReplica(ctx); }).catch(() => {});
}

// The room is over (Quit room, or the whole server ending): its screens say so and stop
// reconnecting. After /restart they wait for the new process instead, and reload when it answers.
export function ended(ctx, restarting = false) {
  if (ctx.replicaOwner && ctx.replica) ctx.replicate.stopPeers(ctx.replica); // its other discussions close with it (Quit room)
  clearInterval(ctx.quotaTimer);
  stopSchedulerIfLast(ctx);
  if (!restarting) showHeader(ctx);
  return ctx.docs.endAll(ctx.screen, { type: restarting ? 'restarting' : 'ended' });
}

// How long Quit room (and Shutdown, Restart) waits for the room's round in progress, or other
// queued lines, before stopping its agents mid-turn. Without it a round could hold Quit for up to
// 10 laps (20 in a brainstorm) of 5-minute turns, plus its summary's turns, plus every line queued before Quit.
export const QUIT_GRACE_MS = 30_000;

// Stops every agent and worker program the room runs (SIGTERM, then SIGKILL after 5s); from then on
// none starts, nor any queued worker instruction. Resolves to what it found, for the report.
async function stopPrograms(ctx) {
  const programs = ctx.programs ??= { running: new Set(), stopping: false };
  programs.stopping = true;
  ctx.stopped = true;
  const procs = [...programs.running];
  const worker = ctx.screen?.working ?? null;
  const gone = (p) => p.groupAlive ? !p.groupAlive() : p.exitCode !== null || p.signalCode !== null;
  for (const p of procs) (p.stopGroup ? p.stopGroup('SIGTERM') : p.kill('SIGTERM'));
  for (let i = 0; i < 50 && procs.some((p) => !gone(p)); i++) await new Promise((r) => setTimeout(r, 100));
  const stuck = procs.filter((p) => !gone(p));
  for (const p of stuck) (p.stopGroup ? p.stopGroup('SIGKILL') : p.kill('SIGKILL'));
  for (let i = 0; i < 10 && stuck.some((p) => !gone(p)); i++) await new Promise((r) => setTimeout(r, 100));
  const survivors = stuck.filter((p) => !gone(p));
  const lines = [];
  if (survivors.length) lines.push(`Could not verify that ${survivors.length} process group(s) stopped after SIGKILL: ${survivors.map((p) => p.pid).join(', ')}.`);
  if (worker && procs.length) lines.push(`The worker ${worker} was stopped in the middle of an instruction: its worktree may hold partial, uncommitted changes.`);
  const others = procs.length - (worker && procs.length ? 1 : 0);
  if (others > 0) lines.push(`${plural(others, 'agent program')} ${others === 1 ? 'was' : 'were'} stopped mid-turn.`);
  if (stuck.length) lines.push(`${plural(stuck.length, 'program')} didn't stop within 5s and ${stuck.length === 1 ? 'was' : 'were'} killed: ${stuck.map((p) => p.spawnargs[0]).join(', ')}.`);
  return lines;
}

// Quit room was asked for (cli.mjs calls this as the line arrives, before it waits in the queue):
// if the room hasn't ended within graceMs, its programs are stopped, so the round in progress fails
// at once and Quit goes ahead.
export function quitRequested(ctx, graceMs = QUIT_GRACE_MS) {
  if (ctx.quitTimer || ctx.programs?.stopping) return;
  ctx.quitTimer = setTimeout(() => {
    // Kept, so the room's end (stopRoom) waits for this report before closing its pages.
    ctx.quitStop = stopPrograms(ctx).then((lines) => {
      note(ctx, `✗ Quitting: the round in progress didn't end within ${Math.round(graceMs / 1000)}s, so the room's agents were stopped.`, true);
      for (const line of lines) note(ctx, `✗ ${line}`, true);
    });
  }, graceMs);
  ctx.quitTimer.unref?.();
}

// Before a room's state goes (Quit room, Shutdown, Restart): the agent and worker programs it still
// runs are stopped, and queued worker instructions are not started. What couldn't end cleanly is
// reported on the room's screen and in the log. Resolves to those report lines.
export async function stopRoom(ctx) {
  for (const socket of ctx.upgraded ?? []) socket.destroy(); // its Terminal panes' WebSockets: their shells end
  clearTimeout(ctx.quitTimer);
  await ctx.quitStop;
  const report = await stopPrograms(ctx);
  const shop = ctx.shop;
  if (shop) for (const t of queuedTasks(shop).filter((x) => x.origin === ctx)) dropTask(shop, t); // its own, in each lane's queue
  const queued = (ctx.workPending ?? 0) + (ctx.workSkipped ?? 0);
  if (queued) report.push(`${plural(queued, 'queued worker instruction')} ${queued === 1 ? 'was' : 'were'} not started.`);
  ctx.workSkipped = 0;
  // The stopped instruction's own reply (an error) is recorded before the room closes.
  await Promise.race([ctx.workQueue, new Promise((r) => setTimeout(r, 3000))]);
  saveCheckpoint(ctx); // the worker's latest session and briefing; Resume continues from here
  for (const line of report) note(ctx, `✗ ${line}`, true);
  return report;
}

// /restart (the whole server): this process frees its port and a new agent-room process takes it
// over with the same launch flags and every room, each with its current agents and worker, and the
// discussion in use resumed (as /resume: from its checkpoint, or from its handoff without one; the
// flag keeps its former name, --reopen), and each started brainstorm (as /resume brainstorms/<name>).
// The first room is passed as --cwd (replicating, with --node, only if it is the launch
// room); the others as --room. The new process writes where this one did (the terminal or the Dock
// app's log) and runs on its own once this one exits.
export function restartArgs(rooms, values, port) {
  const reopen = (r) => (r.discussion ? (r.state?.brainstorm ? `${BRAINSTORMS}/` : '') + r.discussion.name : null);
  // A folder's other open discussions and brainstorms come back too, each in its own context; empty
  // ones (a new brainstorm not started yet included) don't.
  const [first, ...rest] = rooms.filter((r) => !r.context || reopen(r));
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--cwd', first.cwd, '--port', String(port)];
  if (first.agentSpecs) args.push('--agents', first.agentSpecs);
  if (first.workerSpec) args.push('--worker', first.workerSpec);
  if (values.dev) args.push('--dev');
  if (values.node && first.launch !== false) {
    args.push('--node', values.node);
    for (const p of values.peer ?? []) args.push('--peer', p);
  }
  if (reopen(first)) args.push('--reopen', reopen(first));
  for (const r of rest) args.push('--room', JSON.stringify({ cwd: r.cwd, agents: r.agentSpecs, worker: r.workerSpec, ...(reopen(r) && { reopen: reopen(r) }), ...(r.context && { context: r.context }) }));
  return args;
}
export async function restart(hub, rooms, values) {
  const args = restartArgs(rooms, values, hub.server.address().port);
  hub.server.closeAllConnections();
  for (const socket of hub.upgraded ?? []) socket.destroy(); // the Terminal panes' WebSockets (their shells end)
  await new Promise((done) => hub.server.close(done));
  spawn(process.execPath, args, { cwd: rooms[0].cwd, detached: true, stdio: 'inherit' }).unref();
}

function removedHint(command, name) {
  const n = name || '<name>';
  if (command === 'pause') return 'Pause is gone: every discussion saves itself after each round, and Continue (or /resume) continues it where it stopped.';
  if (command === 'autosummary') return 'Auto-summarize is always on now (in discussions, not brainstorms): a summary follows every round in which an agent spoke.';
  return `/${command} is now /resume ${n} (it continues where the discussion stopped, or starts from its handoff if it was never saved), or /fresh ${n} to start new sessions from its handoff.`;
}

export async function handleLine(line, ctx) {
  if (!line) return;
  if (line === '/docs') return showDocs(ctx);
  // Commands that were removed: a hint, rather than a message to the agents.
  const removed = /^\/(pause|reopen|continue|autosummary)(?:\s+(.*))?$/.exec(line);
  if (removed) return note(ctx, removedHint(removed[1], (removed[2] ?? '').trim()));
  // On the screen, several discussions stay open (see "Several open discussions").
  const resume = /^\/resume(?:\s+(.*))?$/.exec(line);
  if (resume) return resumeDiscussion(ctx, (resume[1] ?? '').trim());
  const fresh = /^\/fresh(?:\s+(.*))?$/.exec(line);
  if (fresh) return startFresh(ctx, (fresh[1] ?? '').trim());
  const peek = /^\/peek(?:\s+(.*))?$/.exec(line);
  if (peek) return peekDiscussion(ctx, (peek[1] ?? '').trim());
  if (line === '/new') return multi(ctx) ? newDiscussionBeside(ctx) : newDiscussion(ctx);
  if (line === '/brainstorm') return multi(ctx) ? newBrainstormBeside(ctx) : newBrainstorm(ctx);
  if (line === '/workbench') return multi(ctx) ? newWorkbenchBeside(ctx) : newWorkbench(ctx);
  if (line === '/research') return multi(ctx) ? newResearchBeside(ctx) : newResearch(ctx);
  if (line === '/cancel' && multi(ctx)) return cancelCreation(ctx);
  if (line === '/close') return closeDiscussion(ctx);
  // /close <ref> (a row's Close in Brainstorms): that open discussion or brainstorm closes, between its own rounds.
  const closeRef = /^\/close\s+(\S+)$/.exec(line);
  if (closeRef) {
    const target = siblings(ctx).find((c) => !c.stopped && c.discussion && refOf(c) === closeRef[1]);
    if (!target && !closeRef[1].startsWith(`${BRAINSTORMS}/`)) return closeNamedDiscussion(ctx, closeRef[1]);
    if (!target) return note(ctx, `✗ ${closeRef[1]} is not open.`, true);
    return target === ctx ? closeDiscussion(ctx) : void target.say?.('/close');
  }
  const convert = /^\/convert\s+(\S+)(?:\s+(research))?$/.exec(line);
  if (convert) return convert[2] === 'research' ? convertBrainstormToResearch(ctx, convert[1]) : convert[1].startsWith('brainstorms/') ? convertBrainstorm(ctx, convert[1]) : convertResearchToDiscussion(ctx, convert[1]);
  const remove = /^\/delete\s+(\S+)$/.exec(line);
  if (remove) return remove[1].startsWith(`${BRAINSTORMS}/`) ? deleteBrainstorm(ctx, remove[1]) : deleteResearch(ctx, remove[1]);
  if (line === '/autodev') return startAutoDev(ctx);
  if (line === AUTO_DEV_REPORT) return autoDevReport(ctx);
  if (line === AUTO_DEV_FAILURE) {
    const failure = ctx.workerFailures?.shift();
    if (failure && failure.owner === ownerOf(ctx)) { ctx.state.transcript.push(failure.message); showHeader(ctx); }
    return;
  }
  const rollback = /^\/rollback\s+(\S+)$/.exec(line);
  if (rollback) return requestRollback(ctx, rollback[1]);
  const archiveRollback = /^\/archive-rollback\s+(\S+)$/.exec(line);
  if (archiveRollback) return confirmRollbackArchive(ctx, archiveRollback[1]);
  const move = /^\/move\s+(\S+)\s+(\S+)$/.exec(line);
  if (move) return void await moveDiscussion(ctx, move[1], move[2]);
  if (line === '/summary') {
    if (ctx.state.workbench) return note(ctx, '✗ Summaries are not used on a workbench.', true);
    ctx.agentsStarted = true;
    await runSummary(ctx);
    captureRound(ctx);
    return;
  }
  if (line === '/restart') return note(ctx, '/restart is for the browser screen; in the terminal, /quit and start the room again.');
  if (line === '/usage') {
    const quota = await ctx.usage.fetchQuota();
    return note(ctx, `${ctx.usage.usageReport({ totals: ctx.totals, agents: [...ctx.room.agents, ctx.worker], quota })}\n`);
  }
  if (ctx.state.workbench) return sendWorkbenchInstruction(ctx, line);
  autoDevInput(ctx, 'you sent a message');
  // The session's first message opens its discussion, unless it names an unknown agent (runRound
  // then refuses it, and nothing is created).
  const to = /^@(\w[\w-]*)/.exec(line)?.[1].toLowerCase();
  const known = !to || ctx.room.agents.some((a) => a.name.toLowerCase() === to);
  if (known) ctx.agentsStarted = true;
  if (known && !ctx.logPath && !(await openDiscussion(ctx, line))) return;
  return runRound(line, ctx);
}

// One status line per turn, rewritten every second so a long (or silently passing) turn is visible.
// The timer is the room's own (ctx.ticker): rooms on one server think independently.
function startThinking(ctx, name) {
  const t0 = Date.now();
  const show = () => process.stdout.write(`\r\x1b[2K${labelled(ctx, dim(`  … ${name} is thinking (${Math.round((Date.now() - t0) / 1000)}s)`))}`);
  if (!tty) return out(ctx, `  … ${name} is thinking`);
  clearInterval(ctx.ticker);
  show();
  ctx.ticker = setInterval(show, 1000);
}
function stopThinking(ctx) {
  clearInterval(ctx.ticker);
  ctx.ticker = null;
  if (tty) process.stdout.write('\r\x1b[2K');
}

// Mirrors an event to every open discussion screen (none is fine).
const toScreen = (ctx, event) => ctx.docs.broadcast(ctx.screen, event);
function setScreenThinking(ctx, name) {
  ctx.screen.thinking = name;
  toScreen(ctx, { type: 'thinking', name });
}

// /summary: only the result is shown; every turn goes to the transcript file, marked as a summary
// turn, and its tokens count like any other turn. `auto`: started by auto-summarize after a round.
async function runSummary(ctx, auto = false, extra) {
  const t0 = Date.now();
  // A paused auto dev run: this summary (asked for, or after a User round) may finish it.
  const paused = !extra && ctx.autoDev?.status === 'paused' ? ctx.autoDev : null;
  if (paused) extra = pausedTask(paused);
  const autoDevMode = paused ? 'paused' : (extra && ctx.autoDev?.status === 'running' ? 'running' : null);
  let started = 0;
  let turns = 0;
  let used;
  log(ctx, auto ? '_(auto-summary)_\n\n' : '_(summary requested)_\n\n');
  ctx.busy = true;
  showHeader(ctx);
  const { status, result } = await ctx.room.summary({ extra,
    check: (text) => checkSummary(text, { autoDev: autoDevMode, noWorker: !!ctx.state.research }),
    onFormatNote(text, err) {
      log(ctx, `_(${text})_\n\n`);
      note(ctx, text, err);
    },
    onTurnStart(agent, { turn, of }) {
      started = Date.now();
      const label = `${agent.name} (summary, turn ${turn} of at most ${of})`;
      startThinking(ctx, label);
      setScreenThinking(ctx, label);
    },
    onMessage(m) {
      const tokens = m.usage ? ` · ${ctx.usage.formatUsage(m.usage)}` : '';
      log(ctx, `**${m.speaker}** — summary turn${m.error ? ', failed' : ''} (${((Date.now() - started) / 1000).toFixed(0)}s${tokens})\n\n${m.text}\n\n`);
      stopThinking(ctx);
      setScreenThinking(ctx, null);
      turns++;
      if (m.usage) {
        used = ctx.usage.addUsage(used, m.usage);
        ctx.totals[m.speaker] = ctx.usage.addUsage(ctx.totals[m.speaker], m.usage);
      }
      if (m.error) {
        note(ctx, `✗ ${m.speaker} failed: ${m.text}`, true);
        toScreen(ctx, { type: 'agent-failure', agent: m.speaker, error: m.text });
      }
    },
  }).finally(() => { ctx.busy = false; showHeader(ctx); });
  if (result) {
    const label = result.outcome === 'agreed' ? `agreed, by ${result.by}` : `not agreed: the last version, by ${result.by}`;
    log(ctx, `**Summary** — ${label}\n\n${result.text}\n\n`);
    out(ctx, `\n${bold('Summary')} ${dim(`(${label})`)} ›\n${result.text}\n`);
    toScreen(ctx, { type: 'message', message: ctx.docs.messageView(result) });
    showHeader(ctx); // auto dev's offer follows the latest agreed summary
  }
  if (status === 'empty' && !auto) note(ctx, 'Nothing to summarize yet.');
  if (status === 'failed') note(ctx, 'The summary stopped because a turn failed.', true);
  if (paused && ctx.autoDev === paused && paused.status === 'paused' && status === 'agreed' && summaryOutcome(result.text) === 'FINISH') finishAutoDev(ctx, paused);
  const secs = Math.round((Date.now() - t0) / 1000);
  const parts = [`${auto ? 'auto-summary' : 'summary'} ${status === 'failed' ? 'stopped' : status}`, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(used)];
  refreshQuota(ctx).catch(() => {});
  out(ctx, dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
  toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
  return status;
}

// `speaker`: who the opening message is from (the User, auto dev's "Worker report", or "Scheduler").
// `run`: the auto dev run this round belongs to: it is always summarized, and the summary decides what's next.
// `beforeLap`: optional async hook checked before each lap after the first; returning a reason stops the round early.
async function runRound(line, ctx, { speaker = 'User', run = null, beforeLap = null } = {}) {
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  let stoppedReason = null;
  let failedError = null;
  let roundUsage;
  let spoke = 0; // agent replies that weren't passes or failures
  try {
    ctx.workReady = false;
    ctx.busy = true;
    showHeader(ctx);
    workNotice(ctx);
    const roundRes = await ctx.room.round(line, { speaker, beforeLap,
      onLapStart(lap) { if (ctx.state.research && ctx.discussion) recordResearchLap(ctx, lap); },
      onTurnStart(agent) {
        started = Date.now();
        startThinking(ctx, agent.name);
        setScreenThinking(ctx, agent.name);
      },
      onMessage(m) {
        const tokens = m.usage ? ` · ${ctx.usage.formatUsage(m.usage)}` : '';
        const secs = m.speaker === speaker ? '' : ` (${((Date.now() - started) / 1000).toFixed(0)}s${tokens})`;
        log(ctx, `**${m.speaker}**${m.error ? ' — failed' : ''}${secs}\n\n${m.text}\n\n`);
        if (m.speaker !== speaker) setScreenThinking(ctx, null);
        toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) }); // the page hides passes
        if (m.speaker === speaker) return;
        stopThinking(ctx);
        turns++;
        if (m.usage) {
          roundUsage = ctx.usage.addUsage(roundUsage, m.usage);
          ctx.totals[m.speaker] = ctx.usage.addUsage(ctx.totals[m.speaker], m.usage);
        }
        if (m.error) { ending = `${m.speaker} failed`; failedError = `${m.speaker}: ${m.text}`; }
        if (m.pass) return; // passes are logged, not shown
        if (!m.error) spoke++;
        out(ctx, m.error ? red(`\n✗ ${m.speaker} failed${secs}: ${m.text}\n`) : `\n${bold(m.speaker)}${dim(secs)} › ${m.text}\n`);
      },
      onNotice(text) {
        log(ctx, `_${text}_\n\n`);
        out(ctx, `${text}\n`);
        toScreen(ctx, { type: 'turn', text });
        ending = 'lap cap reached';
      },
    }).finally(() => { ctx.busy = false; });
    if (roundRes?.stopped) {
      stoppedReason = roundRes.reason;
      ending = 'stopped early';
      ctx.state.transcript.push({ speaker, text: stoppedReason });
    }
    const secs = Math.round((Date.now() - roundStart) / 1000);
    const providers = [...new Set(ctx.room.agents.map((a) => a.provider))];
    const quota = ctx.usage.quotaSummary(await refreshQuota(ctx).catch(() => null), providers);
    const parts = [ending, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(roundUsage), quota];
    // A failed turn pauses auto dev; otherwise its round is always summarized, to decide what's next.
    const deciding = run && ctx.autoDev === run && run.status === 'running';
    if (deciding && ending.endsWith('failed')) pauseAutoDev(ctx, ending);
    // Auto-summarize (always on in discussions, not in brainstorms or research boards): after a round in which an agent
    // spoke and none failed (and not stopped early by a quota guard). Its own end line is then the
    // "your turn" one; this round's line is just a note.
    if (!ctx.state.brainstorm && !ctx.state.research && (spoke || deciding) && !ending.endsWith('failed') && !stoppedReason) {
      out(ctx, dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      const summary = await runSummary(ctx, true, deciding ? autoDevTask(run) : undefined);
      captureRound(ctx);
      if (deciding) decide(ctx, run, summary);
      return { ending, stoppedReason, failedError, turns, spoke };
    }
    out(ctx, dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
    toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
    captureRound(ctx);
    showHeader(ctx);
    return { ending, stoppedReason, failedError, turns, spoke };
  } catch (err) {
    // An unknown @name: nothing was sent or recorded.
    showHeader(ctx);
    note(ctx, `✗ ${err.message}`, true);
    return { ending: 'failed', stoppedReason: null, failedError: err.message, turns, spoke };
  }
}

// ── The worker's worktrees ────────────────────────────────────────────
// The worker works in a Git worktree of the room's repository, never in the room's own files (its
// notes still go in the room's discussion folder). Each discussion has its own lane: the worktree
// <repo>.workers/<name>/ on the branch worker/<name>. A brainstorm, and a task sent before a
// discussion's first message, use <repo>.worker/ on worker/main (the one worktree all discussions
// shared before lanes; its commits stay there). The folder still has one queue, one task at a time
// (see "The shared worker queue"). A worktree is created at its first instruction and reused after
// Restart or Reload reads it back from Git. Task ownership is saved in its private Git directory.
// The only branch/worktree writes are `worktree add` and
// a fast-forward of a lane's branch when it has nothing of its own: never a reset, merge, rebase or
// deletion, and never anything in the room's own working copy. Decided by the User, 2026-11-07.
// That is agent-room's own code: the worker itself may do such Git actions in its worktree when the
// task asks (catching up with main, a rollback, or abandoning listed edits after approval). Decided 2026-11-09.
// The checkout this process's code comes from, as it is now: its Git top folder, branch, commit and
// whether it has uncommitted changes (outside discussions/, which hold no code). A snapshot, taken
// at start and at each Reload, never read live: the header shows both.
export async function codeInfo(dir = dirname(dirname(fileURLToPath(import.meta.url)))) {
  try {
    const top = await git(dir, 'rev-parse', '--show-toplevel');
    const [branch, commit, status] = await Promise.all([git(top, 'rev-parse', '--abbrev-ref', 'HEAD'), git(top, 'rev-parse', '--short', 'HEAD'),
      git(top, 'status', '--porcelain', '--', '.', ':(exclude)discussions', ':(exclude).agent-room')]);
    return { path: top, branch: branch === 'HEAD' ? null : branch, commit, dirty: status !== '' };
  } catch { return { path: dir, branch: null, commit: null, dirty: false }; }
}

// The server's state for a room started without cli.mjs's hub (some tests): just that room, served
// at its own address like any other.
const hubOf = (ctx) => (ctx.hub ??= { rooms: new Map([[ctx.key ?? ctx.cwd, ctx]]) });

// The document viewer and discussion screens: one HTTP server for all the server's rooms, kept in
// hub.server, started with the first room in UI mode and on the first /docs in terminal mode. It
// calls hub.route (replaced on Reload) on every request. Its connections (open screens hold one)
// never keep the process alive; in terminal mode the server doesn't either, while in UI mode it is
// the rooms' input.
async function viewerUrl(ctx) {
  const hub = hubOf(ctx);
  if (!hub.server) {
    hub.route ??= route;
    hub.upgrade ??= upgrade;
    const server = createServer((req, res) => {
      try { hub.route(hub, req, res); } catch (err) { res.writeHead(500); res.end(String(err)); }
    });
    // WebSocket upgrades: only the terminal pane's (docs.mjs, host-shell.mjs) are accepted.
    // Their sockets leave the server's own connection list, so they are kept here: Restart ends them.
    hub.upgraded = new Set();
    server.on('upgrade', (req, socket, head) => {
      hub.upgraded.add(socket); socket.on('close', () => hub.upgraded.delete(socket));
      try { hub.upgrade(hub, req, socket, head); } catch { socket.destroy(); }
    });
    server.on('connection', (socket) => socket.unref());
    // The fixed port gives the screen the same address every time; if another server (or anything
    // else) has it, any free port will do, and the banner shows which. With --peer the server stops
    // instead: its peers know it by that port. It listens on every address (the LAN too).
    const listen = (port) => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(port, '0.0.0.0', () => { server.off('error', fail); ok(); });
    });
    const port = ctx.port ?? 5566;
    try {
      // On macOS a listener on 127.0.0.1 alone doesn't stop one on 0.0.0.0 (measured), and would
      // keep answering 127.0.0.1: so the port counts as taken when something answers there.
      if (port && await answers(port)) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
      await listen(port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (ctx.peers?.length) throw new Error(`Port ${port} is in use. With --peer this server must listen on its configured port, where its peers reach it: stop whatever uses ${port}, or choose another --port (and tell the peers).`);
      console.log(dim(`Port ${port} is in use; using a free port instead.`));
      await listen(0);
    }
    if (ctx.noScreen) server.unref();
    hub.server = server;
  }
  ctx.server = hub.server; // shared by every room of the server
  return `http://127.0.0.1:${hub.server.address().port}/`;
}

// Every request goes to one room, named by its address: /r/<id>/… is served by that room alone,
// from its own folder and state (docs.mjs keeps file access inside that folder). The few addresses
// without a room are the server's: its heartbeat, Shutdown, /__room (the first room's page) and
// /replica/… (the launch room's peer endpoint, unchanged for peers).
// A WebSocket upgrade for /r/<id>/…: that room's terminal pane, or nothing (the socket is closed).
export function upgrade(hub, req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const m = /^\/r\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const ctx = m && [...hub.rooms.values()].find((r) => r.id === m[1] && r.docs && r.screen);
  if (!ctx?.docs.handleUpgrade) return socket.destroy();
  // Kept per room as well: when the room ends (Quit room, its discussion closed), stopRoom closes
  // its Terminal panes' sockets, and so their shells end; other rooms' shells keep running.
  (ctx.upgraded ??= new Set()).add(socket); socket.on('close', () => ctx.upgraded.delete(socket));
  req.url = (m[2] ?? '/') + url.search;
  if (!ctx.docs.handleUpgrade(req, socket, head, ctx.cwd)) socket.destroy();
}

export function route(hub, req, res) {
  if (/^\/(?:r\/[^/]+\/)?__next\//.test(req.url)) {
    try { if (decodeURIComponent(req.url.split('?')[0]).split('/').includes('..')) { res.writeHead(404); return res.end('Not found'); } }
    catch { res.writeHead(404); return res.end('Not found'); }
  }
  const url = new URL(req.url, 'http://localhost');
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  const rooms = [...hub.rooms.values()].filter((r) => r.id && r.docs && r.screen);
  const m = /^\/r\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (m) {
    const ctx = rooms.find((r) => r.id === m[1]);
    if (!ctx) return send(404, 'text/plain; charset=utf-8', 'No such room on this server: it may have been quit.');
    if (!m[2]) { res.writeHead(302, { location: `${roomPath(ctx)}__room` }); return res.end(); }
    req.url = m[2] + url.search; // what the room's handler sees: its own paths, as with one room
    return ctx.docs.handle(req, res, ctx.cwd, ctx.screen, roomPath(ctx));
  }
  if (url.pathname === '/__health') {
    return send(200, 'application/json', JSON.stringify({ app: 'agent-room', pid: process.pid, startedAt: hub.startedAt ?? null,
      rooms: rooms.map((r) => ({ id: r.id, root: r.cwd, pages: r.screen.clients.size })) }));
  }
  if (url.pathname === '/__next') {
    if (!rooms.length) return send(404, 'text/plain; charset=utf-8', 'This server has no room open.');
    res.writeHead(302, { location: `${roomPath(rooms[0])}__room${url.search}` });
    return res.end();
  }
  if (url.pathname.startsWith('/__next/')) {
    if (!rooms.length) return send(404, 'text/plain; charset=utf-8', 'This server has no room open.');
    return rooms[0].docs.handle(req, res, rooms[0].cwd, rooms[0].screen);
  }
  if (url.pathname === '/__room' || url.pathname === '/') {
    if (!rooms.length) return send(404, 'text/plain; charset=utf-8', 'This server has no room open.');
    res.writeHead(302, { location: `${roomPath(rooms[0])}__room` });
    return res.end();
  }
  if (url.pathname === '/__shutdown') {
    if (req.method !== 'POST' || !rooms[0]?.docs.fromOwnPage(req)) return send(403, 'text/plain; charset=utf-8', 'Refused: only a room page can shut the server down.');
    if (!hub.shutdown) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal: use /quit there.');
    const warning = hub.shutdown(url.searchParams.get('confirmed') === 'yes');
    if (warning) return send(409, 'text/plain; charset=utf-8', warning);
    return send(202, 'text/plain; charset=utf-8', 'Shutting down: every room ends after its round in progress.');
  }
  if (url.pathname.startsWith('/replica/')) {
    const launch = rooms.find((r) => r.replica);
    if (!launch) return send(404, 'text/plain', 'This server doesn\'t replicate.');
    return launch.docs.handle(req, res, launch.cwd, launch.screen);
  }
  send(404, 'text/plain; charset=utf-8', 'Not found: room pages are at /r/<room>/__room.');
}

const answers = (port) => new Promise((ok) => {
  const c = createConnection(port, '127.0.0.1');
  c.once('connect', () => { c.destroy(); ok(true); });
  c.once('error', () => ok(false));
});

// /docs. UI mode: the screen opens its own file list. Terminal mode: a list in the terminal, where
// Enter opens the file alone in the browser.
async function showDocs(ctx) {
  if (!ctx.noScreen) return toScreen(ctx, { type: 'files' });
  const files = ctx.docs.docFiles ? ctx.docs.docFiles(ctx.cwd, ctx.screen)
    : (ctx.screen.sections ? ctx.screen.sections.flatMap((s) => (existsSync(join(ctx.cwd, s)) ? ctx.docs.listFiles(join(ctx.cwd, s)).map((f) => join(s, f)) : [])) : ctx.docs.listFiles(ctx.cwd));
  if (!files.length) return console.log(`No documents in ${join(ctx.cwd, 'discussions')} yet: they appear when an agent writes one.\n`);
  const base = `${(await viewerUrl(ctx)).slice(0, -1)}${roomPath(ctx)}`;
  const open = (f) => browse(base + ctx.docs.urlPath(f));
  if (!tty) return console.log(`${files.map((f) => base + ctx.docs.urlPath(f)).join('\n')}\n`);
  // Take the keys away from readline while the list is up, then give them back.
  const readlineKeys = process.stdin.listeners('keypress');
  process.stdin.removeAllListeners('keypress');
  try {
    await ctx.docs.pick(files, { input: process.stdin, output: process.stdout, onOpen: open, header: `${base} · ` });
  } finally {
    for (const l of readlineKeys) process.stdin.on('keypress', l);
  }
}

// ── Replication (with --node; see replicate.mjs) ─────────────────────
// This node's IPv4 addresses on the LAN, for the banner and the header.
export const lanAddresses = () => Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);

// Opens the storage (recovering an interrupted receive) and starts one background loop per peer,
// once per process: on Reload only the code changes (its state stays in ctx.replicaState).
// The launch room's other open discussions use its replica as it is (one storage, one set of peer
// loops): each saves and sends its own rounds; received rounds show on every page.
async function setupReplica(ctx) {
  const owner = siblings(ctx).find((c) => c !== ctx && c.replicaOwner && c.replica);
  if (owner && !ctx.replicaOwner) { ctx.replica = owner.replica; ctx.replicaState = owner.replicaState; return; }
  const R = ctx.replicate, first = !ctx.replicaState?.s;
  ctx.replicaState ??= {};
  ctx.replicaOwner = true;
  const all = () => siblings(ctx).filter((c) => c.replica);
  const r = ctx.replica = await R.createReplica({ root: ctx.cwd, node: ctx.node, peers: ctx.peers, state: ctx.replicaState,
    activity: () => (siblings(ctx).some((c) => c.busy) ? 'running a round' : 'idle'), project: () => ctx.project ?? null, log: (t) => out(ctx, red(t)) });
  if (first) {
    const lines = await R.ownLines(r.s);
    for (const { name, snapshot } of closedEntries(ctx)) {
      if (isWorkbenchName(ctx, name)) continue;
      if (snapshot && lines[snapshot.discussion]?.commit !== snapshot.commit) await R.publishCapture(r.s, snapshot);
    }
  }
  r.canSend = (name) => !isWorkbenchName(ctx, name) && !r.state.reopening?.has(name) && !shopOf(ctx).closing?.has(name) && closedDiscussions(ctx).includes(name);
  r.changed = () => { for (const c of all()) pushReplica(c); };
  r.onReceived = (p) => { for (const c of all()) note(c, `Received ${p.node}'s ${p.kind} ${p.round} of "${p.title}".`); r.changed(); };
  r.onSent = (x) => { if (x.late) R.lineRound(r.s, x.acked).then((n) => note(ctx, `Round ${n} sent to ${x.peer} ✓`), () => {}); };
  if (!first) return;
  const port = hubOf(ctx).server.address().port, rec = r.s.recovered;
  out(ctx, `agent-room on ${ctx.node}, listening on 0.0.0.0:${port} · ${r.git ?? 'git not found'}`);
  for (const a of lanAddresses()) out(ctx, `  open:  http://${a}:${port}/__room`);
  out(ctx, `  peers: ${ctx.peers.length ? ctx.peers.map((p) => `${p.name} ${p.url.replace(/^http:\/\//, '')}`).join(', ') : 'none'}`);
  if (rec.tmp + rec.snapshots + rec.incomingRefs + rec.refRepaired) out(ctx, `  recovered an interrupted receive: ${JSON.stringify(rec)}`);
  R.startPeers(r);
}

function wireReplica(ctx) {
  const R = ctx.replicate, r = ctx.replica;
  // A peeked received snapshot is not pinned (so the room stays writable); if a newer round
  // replaces it, fall back to the line's current published snapshot.
  const resolveCommit = (d, n, c) => {
    const dir = R.snapshotPath(r.s, d, n, c);
    if (dir && existsSync(dir)) return c;
    if (!R.snapshotPath(r.s, d, n, '0'.repeat(40))) return c;
    try { return JSON.parse(readFileSync(join(r.s.received, d, n, 'published.json'), 'utf8')).commit; } catch { return c; }
  };
  Object.assign(ctx.screen, {
    replicaHandler: (req, res) => R.handle(r, req, res),
    receivedFile: (d, n, c, rel) => R.snapshotFile(r.s, d, n, resolveCommit(d, n, c), rel),
    receivedFiles: (d, n, c) => { const dir = R.snapshotPath(r.s, d, n, resolveCommit(d, n, c)); return dir && existsSync(dir) ? ctx.docs.listFiles(dir).map((f) => f.split(sep).join('/')) : []; },
    view: (body) => {
      const task = (ctx.viewQueue ?? Promise.resolve()).then(() => viewLine(ctx, body));
      ctx.viewQueue = task.catch(() => {});
      return task;
    },
    isViewing: (client) => ctx.viewPins?.has(client),
    pair: (peer, confirm) => pairWith(ctx, peer, confirm),
  });
  pushReplica(ctx);
}

// The page's view of replication: this node, its lines and what each peer has, the received lines,
// and the peers (reachable, paired). Peer reachability changes are logged in the terminal too.
async function replicaStatus(ctx) {
  const R = ctx.replicate, r = ctx.replica, s = r.s, room = await R.roomInfo(s);
  const names = Object.fromEntries(Object.entries(await R.discussionIds(s)).map(([name, id]) => [id, name]));
  const own = {};
  for (const [d, { commit }] of Object.entries(await R.ownLines(s))) {
    const sent = {};
    for (const p of ctx.peers) if (room.paired[p.name]) sent[p.name] = (await R.acked(s, p.name, d)) === commit;
    own[names[d] ?? d] = { discussion: d, round: await R.lineRound(s, commit), sent };
  }
  const received = (await R.receivedLines(s)).map((l) => ({ ...l, local: names[l.discussion] ?? null }));
  const peers = ctx.peers.map((p) => {
    const st = r.state.peers[p.name] ?? {};
    return { name: p.name, address: p.url.replace(/^http:\/\//, ''), reachable: st.reachable ?? null, since: st.since ?? null, activity: st.activity ?? null, project: st.project ?? null,
      paired: !!room.paired[p.name], mismatch: !!(room.paired[p.name] && st.roomId && st.roomId !== room.roomId), error: st.error ?? null };
  });
  const port = ctx.hub?.server?.address()?.port;
  return { node: ctx.node, addresses: lanAddresses().map((a) => `${a}:${port}`), roomId: room.roomId, project: ctx.project ?? null, own, received, peers };
}
async function pushReplica(ctx) {
  if (!ctx.replica) return;
  try {
    const status = await replicaStatus(ctx), before = ctx.screen.replica?.peers ?? [];
    for (const p of status.peers) {
      const was = before.find((b) => b.name === p.name);
      if (p.reachable !== null && was?.reachable !== p.reachable) out(ctx, dim(`Peer ${p.name}: ${p.reachable ? `reachable${p.paired ? ', paired' : ', not paired yet'}` : `unreachable (${p.error})`}`));
    }
    ctx.screen.replica = status;
    toScreen(ctx, { type: 'replica', replica: status });
  } catch (err) { out(ctx, red(`✗ replication status: ${err.message}`)); }
}

// Only a successful Close captures a discussion. The existing round metadata format is kept for
// peer compatibility; its round number now counts closed snapshots.
function saveClosed(ctx, target, c) {
  const R = target.replicate, r = target.replica, label = 'Round', outcome = 'completed';
  const head = `${label} ${c.round} saved${c.skipped.length ? ` (left out: ${c.skipped.join(', ')})` : ''}`;
  pushReplica(ctx);
  R.sendNow(r, c.discussion, c.commit).then((sent) => {
    note(ctx, [head, ...sent.map((x) => (x.sent ? `sent to ${x.peer} ✓` : x.reachable ? `${x.peer} refused it (${x.error})` : `${x.peer} unreachable, will send when it's back`))].join(' · '));
    pushReplica(ctx);
  }, (err) => note(ctx, `${head} · ✗ sending: ${err.message}`, true));
}

// View (from the page): pins the received line's published snapshot for every page until Back, so
// newer rounds can arrive meanwhile without changing what is shown. Never touches the local round,
// the agents or the worker. { discussion, node } (or again, for the newer round), or { back: true }.
async function viewLine(ctx, body) {
  const R = ctx.replicate, s = ctx.replica.s, client = body?.client;
  if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(client)) throw new Error('Missing View client.');
  ctx.viewPins ??= new Map();
  const was = ctx.viewPins.get(client);
  if (was) clearTimeout(was.timer);
  const release = async () => {
    const pin = ctx.viewPins.get(client);
    ctx.viewPins.delete(client);
    if (pin) await R.unpin(s, pin.discussion, pin.node, pin.commit);
  };
  if (body.renew) {
    if (!was) throw new Error('View expired. Select the line again.');
    was.timer = setTimeout(release, 120000).unref();
    return { viewing: true };
  }
  let next = null;
  if (!body.back) {
    const v = await R.pin(s, body.discussion, body.node);
    if (!v) throw new Error('No such received line.');
    const { conversation, ...rest } = v;
    next = { ...rest, messages: conversation.map(ctx.docs.messageView) };
  }
  await release();
  if (next) ctx.viewPins.set(client, { ...next, timer: setTimeout(release, 120000).unref() });
  return { viewing: next };
}

// Pair with … (from the page): first the check, showing both rooms' folders; then, confirmed, the pairing.
async function pairWith(ctx, peer, confirm) {
  const R = ctx.replicate, r = ctx.replica;
  if (!ctx.peers.some((p) => p.name === peer)) throw new Error(`No peer ${peer}.`);
  if (!confirm) {
    const room = await R.roomInfo(r.s);
    return { local: { node: ctx.node, root: ctx.cwd, roomId: room.roomId }, peer: await R.peerStatus(r, peer) };
  }
  const result = await R.pair(r, peer);
  note(ctx, `Paired with ${peer} (${result.peer.root}). Its rounds will arrive here, and this room's rounds will be sent there.`);
  pushReplica(ctx);
  return result;
}

// Monitoring binds the current coordinator; hub and room state retain timer ownership.
const monitor = monitorModule.createMonitor({ hubOf, toScreen, currentSettings, claudeModels, codexModels, agyModels,
  modelAlignment, readDefaults, sessionView, folderOf: (...args) => folderOf(...args) });
export const { monitorAgentTurns, checkLogins, checkLeftovers, checkCli, runPromptTest, monitorView } = monitor;
const { refreshQuota, watchMonitor, healthView, checkProviderHealth, showMonitor } = monitor;

// Board callbacks are rebound with each UI version; running operations keep their original set.
const boards = boardsModule.createBoards({
  day, hhmm, pad, slug, SCHEDULE_TIME_RE, readSchedule: (...args) => readSchedule(...args), siblings, multi, fresh, ownerOf, originLabel,
  baseKey, roomPath, roomDefaults, parseSpec, specFor, load, wire, note, out, red, dim, bold, log,
  toScreen, showHeader, runRound, refreshWorker: (...args) => refreshWorker(...args),
  laneOf: (...args) => laneOf(...args), lanePlace, workerPlace, workerHold: (...args) => workerHold(...args), WORKER_BRANCH,
  worktreeStatus, git, gitOk, labelledCommits, plural, shopOf: (...args) => shopOf(...args),
  laneState: (...args) => laneState(...args), lanesOf: (...args) => lanesOf(...args),
  runningTasks: (...args) => runningTasks(...args), queuedTasks: (...args) => queuedTasks(...args),
  workNote: (...args) => workNote(...args), queueWork: (...args) => queueWork(...args),
  pump: (...args) => pump(...args), leftovers: (...args) => leftovers(...args),
  autoDevInput: (...args) => autoDevInput(...args), cleanupMergedOnClose: (...args) => cleanupMergedOnClose(...args),
  refreshQuota, pushReplica, recoverWorkerOwner: (...args) => recoverWorkerOwner(...args),
  startThinking, stopThinking, setScreenThinking, when, describe,
  writeSchedule: (...args) => writeSchedule(...args), broadcastSchedule: (...args) => broadcastSchedule(...args), pageOf,
  mainRef, modelLabel, currentSettings, saveClosed,
});
export const { WORKBENCH_MARKER, isWorkbenchDir, RESEARCH_MARKER, isResearchDir, createDiscussionFolder, createSessionFile, cancelClose } = boards;
const { SECTIONS, DATED, BRAINSTORMS, isWorkbenchName, workbenchNames, researchNames, recordResearchLap, researchStats, isDiscussion, folderOf, discussionRef, moveDiscussion, requestRollback, confirmRollbackArchive, rollbackReport, openDiscussion, briefing, closedEntries, closedDiscussions, checkpoints, writeCheckpoint, readCheckpoint, captureRound, saveCheckpoint, workOf, persistWork, clock, firstLine, leftBehind, detachWorker, saveLeftWorker, peekDiscussion, resumeDiscussion, refOf, startFresh, convertBrainstormToResearch, convertResearchToDiscussion, convertBrainstorm, deleteBrainstorm, deleteResearch, newDiscussion, newBrainstorm, newWorkbench, newResearch, goto, openBeside, closeContext, newDiscussionBeside, newBrainstormBeside, newWorkbenchBeside, newResearchBeside, closeDiscussion, cancelCreation, closeNamedDiscussion } = boards;

// Workshop callbacks refer to the current room code; lane operations are resolved when called.
const workshop = workshopModule.createWorkshop({
  siblings, ownerOf, originLabel, toScreen, out, red, bold, dim, note, showHeader,
  workOf, persistWork, discussionRef, firstLine, clock, log, runRound, saveSettings,
  openDiscussion, leftBehind, rollbackReport, saveCheckpoint, saveLeftWorker, refreshQuota,
  isWorkbenchDir, defaultInstructions, defaultFormattedTurn, real, git, gitOk, labelledCommits,
  lanePlace, existingLanes, worktreeStatus, workerGitFacts, checkWorkerReport, NOTES, WORKER_BRANCH,
  plural, laneOf: (...args) => laneOf(...args), refreshWorker: (...args) => refreshWorker(...args),
  worktreeFingerprint: (...args) => worktreeFingerprint(...args), recordTested: (...args) => recordTested(...args),
});
export const { workerLane, workNote, workerHold, PARALLEL_WORKERS, recoverWorkerOwner, stopWorker,
  AUTO_DEV_CYCLES, summaryInstruction, summaryOutcome, summarySteps, summaryHasNextStep, checkSummary,
  retryWork, BRAINSTORM_NO_WORK, queueWork } = workshop;
const { newShop, shopOf, laneState, lanesOf, runningTasks, queuedTasks, visibleWorker, toShop, leftovers,
  pump, dropTask, AUTO_DEV_REPORT, AUTO_DEV_FAILURE, autoDevTask, pausedTask, autoDevOffer, autoDevView,
  startAutoDev, autoDevInput, pauseAutoDev, finishAutoDev, autoDevReport, decide, workNotice,
  sendWorkbenchInstruction } = workshop;

// A new callback set is bound for each reloaded ui module. In-flight actions keep their own set.
const laneActions = laneModule.createLaneActions({
  shopOf, laneState, siblings, isDiscussion, parseSpec, readCheckpoint, writeCheckpoint,
  note, discussionRef, closedDiscussions, runningTasks, queuedTasks, firstLine,
  closeNamedDiscussion, queueWork, toScreen, workNote,
});
export const { discardPreview, closeAndDiscard, mergeReadiness, closeMergePreview,
  catchUpWithBranch, closeAndMerge, refreshWorker } = laneActions;
const { laneOf, cleanupMergedOnClose, worktreeFingerprint, recordTested } = laneActions;

// Scheduler callbacks are rebound after the board and worker factories for each UI version.
const scheduler = schedulerModule.createScheduler({ siblings, toScreen, showHeader, checkpoints, DATED, isWorkbenchDir,
  SECTIONS, shopOf, discussionRef, day, pad, load, isResearchDir, isDiscussion, readCheckpoint,
  roomDefaults, parseSpec, refreshQuota, openBeside, resumeDiscussion, newResearch, wire,
  openDiscussion, runRound, saveCheckpoint, fresh, closeContext });
export const { scheduleFile, readSchedule, getSchedule, saveSchedule, runScheduledTask, checkSchedule } = scheduler;
const { writeSchedule, broadcastSchedule, startScheduler, stopSchedulerIfLast } = scheduler;
