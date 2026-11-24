// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultInstructions from './instructions.mjs';
import { formattedTurn as defaultFormattedTurn } from './room.mjs';

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
message names it and goes straight to the worker), /convert brainstorms/<name> (Turn into a discussion: its folder moves to discussions/,
its agents keep their sessions), /delete brainstorms/<name> (delete a closed brainstorm's folder and
checkpoint for good), /move <name> active|archive|deferred (move a whole discussion; not the one in use),
/rollback <name> (queue archive with rollback), /archive-rollback <name> (confirm archive after reviewing its report),
/autodev (screen only: Start auto dev, relaying the latest agreed summary's worker instruction
and the worker's reports, for up to 5 worker cycles), /summary (the agents agree a short
summary by points; only the result is shown; a summary also follows every round in which an
agent spoke), /usage (tokens this session and subscription quotas),
/reload (load edited code and both agent rulebooks, in every room; conversations continue), /restart
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
  const loaded = await load(next, '');
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

// Turn records live only in memory, keyed by the actual provider session, never in checkpoints.
export function monitorAgentTurns(agent, session, records) {
  const turn = agent.turn.bind(agent), reset = agent.reset?.bind(agent);
  agent.turn = async (...args) => {
    try {
      const result = await turn(...args);
      records.set(session, { ...records.get(session), ended: new Date().toISOString(), outcome: 'ok' });
      return result;
    } catch (err) {
      const ended = new Date().toISOString();
      records.set(session, { ended, outcome: 'error', error: { message: err?.message ?? String(err), at: ended } });
      throw err;
    }
  };
  if (reset) agent.reset = (...args) => { records.delete(session); return reset(...args); };
  return agent;
}

// Imports fresh copies of the modules and the two rulebooks and builds a room on ctx.state, and the worker. Returns
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
  const instructions = readFileSync(instr.rulebookPath('brainstorming'), 'utf8');
  const workerInstructions = readFileSync(instr.rulebookPath('worker'), 'utf8');
  const { createAgent, claudeTitle, run, findLeftovers, parseCodexEvents, parseAgyOutput } = await import(`./agents.mjs${v}`);
  const { createRoom, closingStatement, formattedTurn } = await import(`./room.mjs${v}`);
  const docs = await import(`./docs.mjs${v}`);
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
    return monitorAgentTurns(createAgent(provider, { name, model, cwd: ctx.cwd, instructions, runner, session }), session, turnRecords);
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
      timeoutMs: WORKER_TIMEOUT_MS, runner: own, session }), session, turnRecords), { programs });
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
    measured: ctx.screen?.quotaAt?.measured,
  });
  return { room: createRoom(agents, ctx.state, instr, usageLine), worker, docs, usage, replicate, totals: ctx.totals ?? {}, screen, findLeftovers,
    shop: roomShop,
    testPrompt: (room, provider, model) => runPromptTest(room, provider, model, runner, { parseCodexEvents, parseAgyOutput }),
    // A new worker agent on `session` (detachWorker), as this load made ctx.worker.
    makeWorker,
    // Close's closing statement, written by a one-off agent with the worker's provider and model, in
    // the room's folder, with no rulebook and a session of its own (never the worker's session or
    // worktree). `agent`: a stand-in for tests (ctx.closingAgent).
    closingStatement: (options, agent = createAgent(wProvider, { name: wName, model: wModel, cwd: ctx.cwd, runner, session: {} })) =>
      closingStatement(agent, options, instr),
    suggestTitle: (message, options) => claudeTitle(message, { ...options, runner }, instr),
    instructions: instr,
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
  return instr.instructionSets.map((set) => ({
    type: set.type,
    pieces: set.pieces.map((piece) => piece.ref
      ? { id: piece.id, intent: piece.intent, when: piece.when, content: readFileSync(instr.rulebookPath(piece.ref), 'utf8') }
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
  return { folder: ctx.cwd, agents: ctx.room.agents.map((a) => a.name), worker: ctx.worker.name,
    workerModel: workerSpec ? modelLabel(workerSpec.provider, workerSpec.model) : null, // for the Worker tab's title
    cliSessions: sessionView(ctx),
    discussion: d ? d.title : ctx.state.brainstorm ? 'New brainstorm' : ctx.state.workbench ? 'New workbench' : 'No discussion started',
    active: folderOf(ctx), started: !!ctx.logPath || !!ctx.state.brainstorm || !!ctx.state.workbench,
    fresh: !settingsStarted(ctx) && !ctx.state.workbench, // its members can still be chosen: the page opens their panel
    brainstorm: !!ctx.state.brainstorm, // a brainstorm, in brainstorms/<name>/ once started (see newBrainstorm)
    workbench: !!ctx.state.workbench, // a worker-only board, in discussions/<name>/ with .workbench marker
    workbenches: workbenchNames(ctx),
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
const SECTIONS = ['archive', 'deferred'];
const DATED = /^\d{4}-\d{2}-\d{2}-/;

// A brainstorm is a folder in <root>/brainstorms/ (or brainstorms/archive/, brainstorms/deferred/),
// named as a discussion is (never the name of one in discussions/, archive/ or deferred/, nor the
// other way round), holding transcripts/ and, if agents draw, drawings/. Its checkpoint key is
// "brainstorms/<name>" in every section (a discussion's is its name). Turn into a discussion moves
// an active brainstorm to discussions/.
const BRAINSTORMS = 'brainstorms';
export const WORKBENCH_MARKER = '.workbench';
export const isWorkbenchDir = (dir) => !!dir && existsSync(join(dir, WORKBENCH_MARKER));
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
export function createDiscussionFolder(parent, title, now = new Date(), elsewhere = []) {
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
export function createSessionFile(dir, text, now = new Date()) {
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
  const brainstorm = !!ctx.state.brainstorm, workbench = !!ctx.state.workbench;
  const kind = brainstorm ? 'brainstorm' : workbench ? 'workbench' : 'discussion';
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
  if (continued) {
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
      ...base, ...(ctx.state.workbench && { workbench: true }), workerSpec: ctx.workerSpec,
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
async function loadCheckpoint(ctx, saved, name, brainstorm = false, directory = null) {
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
  const state = { ...saved.state, ...(saved.workbench || isWorkbenchDir(dir) ? { workbench: true } : {}), seen, restored: { text: waiting ? `${waiting}\n\n${restored}` : restored,
    pending: saved.agentSpecs.split(',').map((spec) => parseSpec(spec).name) } };
  const next = { ...ctx, agentSpecs: saved.agentSpecs, workerSpec, sessions, state };
  const loaded = await load(next, `?resume=${Date.now()}`);
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
  if (ctx.state.brainstorm || ctx.state.workbench) endSession(ctx, ctx.state.workbench ? 'ending the workbench' : 'ending the brainstorm');
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
  const notes = existsSync(join(dir, 'notes.md')) ? relative(ctx.cwd, join(dir, 'notes.md')).split(sep).join('/') : null;
  const refKey = d.section ? `${d.section}/${d.name}` : d.name;
  const path = d.section ? `discussions/${d.section}/${d.name}` : `discussions/${d.name}`;
  ctx.screen.peek = { name: d.name, ref: refKey, path, kind: isWb ? 'workbench' : 'discussion', title: saved?.discussion?.title ?? d.name,
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
async function resumeDiscussion(ctx, ref) {
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
  if (multi(ctx) && !fresh(ctx)) return besideWith(ctx, (next) => resumeDiscussion(next, ref));
  if (d.section && !await moveDiscussion(ctx, ref, 'active')) return;
  const name = d.name, dir = join(parent, name), saved = readCheckpoint(ctx, name);
  const isWb = isWorkbenchDir(dir) || !!saved?.workbench;
  const wasClosed = closedDiscussions(ctx).includes(name);
  if (wasClosed || saved?.fromClosed) {
    const release = await suspendTransfers(ctx, name);
    try {
    if (saved && (saved.invalid || saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name))
      throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the ${isWb ? 'workbench' : 'discussion'} from its handoff instead.`);
    const state = { transcript: [], seen: new Map(), ...(isWb && { workbench: true }) }, sessions = new Map();
    const next = { ...ctx, state, sessions, agentSpecs: saved?.agentSpecs ?? ctx.agentSpecs, workerSpec: saved?.workerSpec ?? ctx.workerSpec };
    const loaded = await load(next, `?reopen=${Date.now()}`);
    await leaveSession(ctx, `resuming the ${isWb ? 'workbench' : 'discussion'} ${name}`);
    const savedWorker = isWb && Array.isArray(saved?.worker) ? saved.worker : [];
    const freshSaved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(), discussion: { name, title: saved?.discussion?.title ?? name },
      ...(isWb && { workbench: true, worker: savedWorker }),
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
    switchTo(ctx, { name, dir, title: freshSaved.discussion.title, continued: true });
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
    await continueFrom(ctx, saved, name, false);
    setClosed(ctx, name, false);
    showHeader(ctx);
    await reportWork(ctx, name, saved.work);
    refreshWorker(ctx).catch(() => {});
    return;
  }
  if (saved?.fresh && (saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name))
    throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the discussion from its handoff instead.`);
  await leaveSession(ctx, `resuming the ${isWb ? 'workbench' : 'discussion'} ${name}`);
  if (isWb) {
    ctx.state.workbench = true;
    const savedWorker = Array.isArray(saved?.worker) ? saved.worker : [];
    if (savedWorker.length) {
      const shop = shopOf(ctx);
      if (!shop.log.some((m) => m.origin === name)) shop.log.push(...savedWorker.map((m) => ({ ...m, owner: name })));
    }
  }
  switchTo(ctx, { name, dir, title: saved?.discussion?.title ?? name, continued: true });
  setClosed(ctx, name, false);
  showHeader(ctx);
  ctx.freshSummary = isWb ? null : checkpointSummary(saved);
  note(ctx, isWb ? `Resumed the workbench ${name}.` : `Resumed the discussion ${name}: it has no saved session, so your next message starts a fresh one there, from its handoff and notes${ctx.freshSummary ? ' and the summary chosen at Start fresh' : ''}.`);
  await reportWork(ctx, name, saved?.work);
}

// Resume from a full checkpoint (a discussion's or a brainstorm's): built first, then the session in
// use ends and the saved one takes its place.
async function continueFrom(ctx, saved, name, brainstorm) {
  const apply = await loadCheckpoint(ctx, saved, name, brainstorm); // built before anything changes
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
  const release = await suspendTransfers(ctx, name);
  try {
  await leaveSession(ctx, `starting the discussion ${name} afresh`); // saves its checkpoint first
  const summary = checkpointSummary(readCheckpoint(ctx, name));
  writeCheckpoint(ctx, name, { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
    discussion: { name, title: name }, fresh: true, summary, work: workOf(shopOf(ctx), name) });
  switchTo(ctx, { name, dir: join(parent, name), title: name, continued: true });
  setClosed(ctx, name, false);
  showHeader(ctx);
  ctx.freshSummary = summary;
  note(ctx, `Started ${name} afresh: your next message starts a new session there, from its handoff and notes${summary ? `, with its latest summary${summary.outcome === 'agreed' ? '' : ' (not agreed)'}` : ''}. Its saved sessions and chat were discarded.`);
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
async function defaultsForNew(ctx) {
  if (!ctx.agentSpecs || !ctx.workerSpec) return; // a room built directly with in-memory agents
  const launch = roomDefaults(ctx);
  const workerSpec = launch.worker, agentSpecs = launch.agents;
  const worker = parseSpec(workerSpec, true);
  if (workerSpec === ctx.workerSpec && agentSpecs === ctx.agentSpecs) return;
  const sessions = new Map();
  if (worker) sessions.set(`worker:${worker.name}`, workerSpec === ctx.workerSpec ? ctx.sessions.get(`worker:${worker.name}`) ?? {} : {});
  const state = { ...ctx.state, seen: new Map() };
  const next = { ...ctx, agentSpecs, workerSpec, sessions, state };
  const loaded = await load(next, '');
  Object.assign(ctx, { room: loaded.room, worker: loaded.worker, makeWorker: loaded.makeWorker, closingStatement: loaded.closingStatement, agentSpecs, workerSpec, sessions, state });
  wire(ctx);
}
async function newDiscussion(ctx) {
  const was = ctx.discussion, ref = refOf(ctx), brain = !!ctx.state.brainstorm;
  if (!was && !ctx.logPath && !ctx.state.brainstorm && !ctx.state.workbench) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench) endSession(ctx, 'starting a new discussion');
  await defaultsForNew(ctx);
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
  const was = refOf(ctx);
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench) endSession(ctx, 'starting a brainstorm');
  await defaultsForNew(ctx);
  ctx.state.brainstorm = true;
  ctx.state.brainstormId = randomBytes(12).toString('hex');
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New brainstorm: your next message names it and starts it, in ${BRAINSTORMS}/.${was ? ` To go back, /resume ${was}.` : ''}`);
}

// /workbench (New workbench): a worker-only board for one small fix, stored in discussions/<date>-<title>/
// with a .workbench marker. Its first message gives the title, creates the folder and goes straight to the worker.
async function newWorkbench(ctx) {
  const was = refOf(ctx);
  if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench) endSession(ctx, 'starting a workbench');
  await defaultsForNew(ctx);
  ctx.state.workbench = true;
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New workbench: your first message names it and goes straight to the worker.${was ? ` To go back, /resume ${was}.` : ''}`);
}

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
  const workReady = !!ctx.workReady && !ctx.state.brainstorm && !ctx.state.workbench;
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
    title: c.discussion?.title ?? (c.state.brainstorm ? 'New brainstorm (not started)' : c.state.workbench ? 'New workbench (not started)' : 'New discussion (not started)'),
    active: folderOf(c), brainstorm: !!c.state.brainstorm, workbench: !!c.state.workbench, started: !!c.logPath, working: !!c.screen.working,
    workerBusy: hasWorkerTask(c),
    ongoing: isOngoing(c), ...waitingState(c) }));
}
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
// One set of new-discussion defaults for this folder's open contexts, not the whole server.
function roomDefaults(ctx, fallback) {
  const shop = shopOf(ctx);
  if (shop.launchDefaults) return shop.launchDefaults;
  const initial = fallback ?? { agents: ctx.room.agents.map((a) => ({ ...a, model: a.model ?? '' })), worker: { ...ctx.worker, model: ctx.worker.model ?? '' } };
  return shop.launchDefaults ??= { agents: ctx.agentSpecs ?? initial.agents.map(specFor).join(','), worker: ctx.workerSpec ?? specFor(initial.worker) };
}
// A lane's queue and hold (see "The worker queues"), by its discussion's name (null: worker/main's).
function laneState(shop, name) {
  const key = name ?? '';
  if (!shop.lanes.has(key)) shop.lanes.set(key, { name: name ?? null, tasks: [], running: null, blockedBy: null, holdContext: null, inspectionError: null, pumping: false, recheck: null });
  return shop.lanes.get(key);
}
// Exported for the tests: the lane of `ctx`'s discussion (or of `name`).
export const workerLane = (ctx, name = laneOf(ctx)) => laneState(shopOf(ctx), name);
const lanesOf = (shop) => [...(shop.lanes?.values() ?? [])];
const runningTasks = (shop) => lanesOf(shop).map((l) => l.running).filter(Boolean);
const queuedTasks = (shop) => lanesOf(shop).flatMap((l) => l.tasks);
// Room-wide messages are retained only for contexts open when they were emitted.
const visibleWorker = (ctx, m) => m.owner === ownerOf(ctx) || (m.room && m.recipients?.includes(ownerOf(ctx)));
const toShop = (ctx, event) => { for (const c of siblings(ctx)) if (c.screen && visibleWorker(c, event.message)) toScreen(c, event); };
export function workNote(ctx, text, error = false, origin = null, owner = ownerOf(ctx), room = false) {
  const view = { note: text, error, ...(origin && { origin }), ...(room ? { room: true, recipients: siblings(ctx).map(ownerOf) } : { owner }) };
  shopOf(ctx).log.push(view);
  toShop(ctx, { type: 'work', message: view });
  out(ctx, error ? red(text) : text);
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
// Why `c` can't be closed (or its folder moved): it holds unresolved worker edits, or its task runs.
export function workerHold(c) {
  const shop = shopOf(c);
  const held = lanesOf(shop).map((l) => l.blockedBy).find((b) => b && (b.owner ? b.owner === ownerOf(c) : b.label === originLabel(c)));
  if (held) return `its worker edits from "${held.task}" are unresolved: ask the worker to finish and commit them, or to abandon them`;
  if (runningTasks(shop).some((t) => (t.owner ?? ownerOf(t.origin)) === ownerOf(c))) return 'a worker task from it is running';
  return null;
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
  if ((ctx.state.brainstorm || ctx.state.workbench) && fresh(ctx)) {
    endSession(ctx, 'starting a new discussion');
    await defaultsForNew(ctx);
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
// /close (Close discussion): this discussion (or brainstorm or workbench) closes; the others stay open. The last
// one open ends its session instead, leaving an empty room, as New discussion does in the terminal.
function closeDiscussion(ctx) {
  if (!ctx.state.brainstorm && ctx.discussion) return closeNamedDiscussion(ctx, ctx.discussion.name);
  const hold = workerHold(ctx);
  if (hold) return note(ctx, `✗ This can't be closed yet: ${hold}.`, true);
  const others = siblings(ctx).filter((c) => c !== ctx);
  if ((!others.length || !multi(ctx)) && fresh(ctx) && !ctx.state.brainstorm && !ctx.state.workbench)
    return note(ctx, 'Nothing to close: no discussion is open here.');
  if (others.length && multi(ctx) && ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  if (!others.length || !multi(ctx)) {
    const was = ctx.discussion, brain = !!ctx.state.brainstorm, wb = !!ctx.state.workbench;
    if (ctx.logPath || ctx.state.brainstorm || ctx.state.workbench) endSession(ctx, brain ? 'closing the brainstorm' : wb ? 'closing the workbench' : 'closing the discussion');
    switchTo(ctx, null);
    return note(ctx, was ? `Closed ${was.name}; its checkpoint is kept. To go back, Resume it in ${brain ? 'Brainstorms' : 'Explorer'}.` : wb ? 'Closed the workbench.' : 'Closed the brainstorm.');
  }
  closeContext(ctx, others[0]);
}

function cancelCreation(ctx) {
  if (!fresh(ctx)) return;
  const others = siblings(ctx).filter((c) => c !== ctx && !c.stopped);
  if (others.length && ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  if (others.length) return closeContext(ctx, others.includes(ctx.creationOrigin) ? ctx.creationOrigin : others[0]);
  if (ctx.state.brainstorm || ctx.state.workbench) return closeDiscussion(ctx);
}

export function cancelClose(ctx, name) {
  const c = shopOf(ctx).closing?.get(name);
  if (!c?.waiting) return false;
  c.cancelled = true;
  c.wake?.();
  return true;
}

// Restore a paused discussion in an isolated context, without switching any visible page to it.
async function closingContext(ctx, d) {
  const dir = join(ctx.cwd, 'discussions', d.section ?? '', d.name);
  const state = { transcript: [], seen: new Map(), ...(isWorkbenchDir(dir) && { workbench: true }) };
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
      statement = await target.closingStatement({ dir: target.discussion.dir, workerReports: reports, onFormatNote }, target.closingAgent?.());
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

// ── Close and Discard ─────────────────────────────────────────────────
// Two-click confirmation: first click previews everything that would be lost (commits not in main,
// tracked edits, untracked files, ignored files summarised by top-level folder) and snapshots it;
// second click re-checks the snapshot before saving refs/discarded/<name>/<timestamp>, removing
// the worktree and branch, clearing the lane's hold and saved worker session, and closing.
function worktreeOperation(privateDir) {
  if (existsSync(join(privateDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(privateDir, 'rebase-merge')) || existsSync(join(privateDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(privateDir, 'REVERT_HEAD')) || existsSync(join(privateDir, 'sequencer'))) return 'revert';
  return null;
}
const gitRaw = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 24 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out))));
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

export async function discardPreview(ctx, name) {
  const { preview } = await inspectDiscard(ctx, name);
  return { ok: true, preview };
}

export async function closeAndDiscard(ctx, name, snapshot) {
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
export async function mergeReadiness(ctx, place) {
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

export async function closeMergePreview(ctx, name) {
  const info = await inspectCloseMerge(ctx, name);
  if (info.catchUp) return { catchUp: true, targetBranch: info.state.targetBranch, behind: info.state.behind, message: info.message };
  return { ok: true, preview: info.preview };
}

export async function catchUpWithBranch(ctx, name) {
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

export async function closeAndMerge(ctx, name, snapshot, { _beforeMerge = null } = {}) {
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

// ── The worker queues ─────────────────────────────────────────────────
// Each lane (see "The worker's worktrees") has its own queue: its tasks run one at a time, in the
// order sent. Different lanes run at the same time, at most PARALLEL_WORKERS tasks in the folder,
// and never two of one worker session (one discussion's context) at once. agent-room checks a lane's
// worktree after each of its tasks and again before the next: uncommitted edits hold that lane
// (lane.blockedBy) until their origin resolves them; that origin's own tasks still go through (to
// finish or abandon them), and keep the original task's details. Edits whose origin is unknown
// (without a valid saved owner) hold that lane until it is clean. Other lanes go on.
export const PARALLEL_WORKERS = 2; // decided by the User, 2026-11-12
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
export async function recoverWorkerOwner(ctx, name) {
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
async function labelledCommits(dir, range) {
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
  if (blockedBy.origin) note(blockedBy.origin, `✗ The worker left uncommitted edits from "${blockedBy.task}": the worker lane of [${blockedBy.label}] holds them until they are resolved (other discussions' tasks go on). Ask the worker to finish and commit them, or to abandon the attempt (it lists the edits and waits for your approval).`, true);
  showHeader(ctx);
  if (!lane.pumping) watchLane(shop, lane);
}
function release(ctx, lane) {
  const was = lane.blockedBy;
  lane.blockedBy = null;
  workNote(ctx, `The worker's folder ${was.place.path} is clean again: its queue resumes.`, false, null, was.owner ?? (was.place.lane || ownerOf(ctx)));
  if (was?.origin) note(was.origin, 'The worker\'s folder is clean again: this discussion\'s worker tasks resume.');
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
export function stopWorker(ctx, mode) {
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
      : `Stop after this task: [${label}] "${firstLine(t.text)}" finishes and is reported as usual; nothing more from this discussion runs after it.`, false, label, owner);
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
export const AUTO_DEV_CYCLES = 5;
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
export function summaryInstruction(summary) {
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
export function summaryOutcome(summary) {
  const last = String(summary ?? '').trim().split('\n').at(-1).replace(/[*_`]/g, '').trim();
  return /^Outcome:\s*(SEND|FINISH|WAIT FOR USER)\.?$/i.exec(last)?.[1].toUpperCase() ?? null;
}
// Metadata is only the last non-empty line before a valid final Outcome, outside a quoted instruction.
export function summarySteps(summary) {
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
export function summaryHasNextStep(summary) {
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
export function checkSummary(summary, { autoDev = null } = {}) {
  const mode = typeof autoDev === 'string' ? autoDev : autoDev?.status ?? null;
  const problems = [];
  const instr = summaryInstruction(summary);
  if (instr?.error) problems.push(instr.error);
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
  if (!ctx.logPath || ctx.state.brainstorm || ctx.state.workbench || ctx.autoDev?.status === 'running') return null;
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
  const why = ctx.state.brainstorm ? 'auto dev is for discussions; a brainstorm keeps no saved record'
    : ctx.state.workbench ? 'auto dev is not used on a workbench'
    : !ctx.logPath ? 'it needs a started discussion'
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

// The header's quota gauges, for the room's and the worker's providers: refreshed every minute and
// after each turn. screen.quota is null when the meter can't be read.
async function refreshQuota(ctx, quota) {
  quota ??= await ctx.usage.fetchQuota();
  const providers = [...new Set([...ctx.room.agents, ctx.worker].map((a) => a.provider))];
  ctx.screen.quota = quota ? ctx.usage.quotaGauges(quota, providers) : null;
  // When the meter measured these values, and when the room last asked it.
  ctx.screen.quotaAt = { measured: quota?.last_update ?? null, checked: new Date().toISOString() };
  toScreen(ctx, { type: 'quota', gauges: ctx.screen.quota, at: ctx.screen.quotaAt });
  return quota;
}

// The monitor panel's warnings (see README, "The header"), checked once per server: each provider's
// login at startup and every 10 minutes, the record of programs for leftovers at startup and every
// minute. Each room's panel shows its own part (monitorView). The timers call through the hub, so
// after a reload they run the new code.
const LOGIN_EVERY_MS = 10 * 60_000, LEFTOVERS_EVERY_MS = 60_000;
const loadedRooms = (hub) => [...hub.rooms.values()].filter((r) => r.room && r.usage);
const providersOf = (ctx) => [...new Set([...ctx.room.agents, ctx.worker].map((a) => a.provider))];
function watchMonitor(ctx) {
  const hub = hubOf(ctx);
  hub.monitor ??= { login: {}, leftovers: [] };
  hub.monitor.errors ??= { login: {}, leftovers: null, cli: {} };
  hub.monitor.cli ??= {};
  hub.checkLogins = (all, requested) => checkLogins(hub, all, requested);
  hub.checkLeftovers = () => checkLeftovers(hub);
  ctx.showMonitor = () => showMonitor(ctx);
  if (!hub.monitorTimers) {
    hub.monitor.nextLogin = new Date(Date.now() + LOGIN_EVERY_MS).toISOString();
    hub.monitor.nextLeftovers = new Date(Date.now() + LEFTOVERS_EVERY_MS).toISOString();
    hub.monitorTimers = [setInterval(() => { hub.monitor.nextLogin = new Date(Date.now() + LOGIN_EVERY_MS).toISOString(); hub.checkLogins(true); }, LOGIN_EVERY_MS).unref(),
      setInterval(() => { hub.monitor.nextLeftovers = new Date(Date.now() + LEFTOVERS_EVERY_MS).toISOString(); hub.checkLeftovers(); }, LEFTOVERS_EVERY_MS).unref()];
    hub.checkLeftovers();
  }
  hub.checkLogins(false);
}
const errorAt = (err) => ({ message: err?.message ?? String(err), at: new Date().toISOString() });
// Preserve the last success separately from the latest failure, including unreadable login output.
export async function checkLogins(hub, all, requested) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  const providers = (requested ?? [...new Set(rooms.flatMap(providersOf))]).filter((p) => all || !(p in hub.monitor.login));
  await Promise.all(providers.map(async (p) => {
    try {
      const result = await rooms[0].usage.checkLogin(p), checked = new Date().toISOString();
      if (result.state === 'unknown') hub.monitor.errors.login[p] = { message: result.error, at: checked };
      else hub.monitor.login[p] = { ...result, checked };
      hub.monitor.loginCurrent ??= {};
      hub.monitor.loginCurrent[p] = { ...result, checked };
    } catch (err) {
      hub.monitor.errors.login[p] = errorAt(err);
      (hub.monitor.loginCurrent ??= {})[p] = { state: 'unknown', error: hub.monitor.errors.login[p].message, checked: hub.monitor.errors.login[p].at };
    }
  }));
  for (const r of loadedRooms(hub)) showMonitor(r);
}
export async function checkLeftovers(hub) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  try {
    const tracked = new Set(rooms.flatMap((r) => [...(r.programs?.running ?? [])].map((p) => p.pid)));
    hub.monitor.leftovers = await rooms[0].findLeftovers(tracked);
    hub.monitor.leftoversChecked = new Date().toISOString();
  } catch (err) { hub.monitor.errors.leftovers = errorAt(err); }
  for (const r of loadedRooms(hub)) showMonitor(r);
}
const commandOutput = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 20_000 }, (err, out) => err ? reject(err) : resolve(String(out).trim())));
export async function checkCli(hub, provider, run = commandOutput) {
  let path;
  try {
    path = await run('which', [provider]);
    const version = await run(path, ['--version']);
    hub.monitor.cli[provider] = { path, version, checked: new Date().toISOString() };
  } catch (err) { hub.monitor.errors.cli[provider] = { ...errorAt(err), path: path ?? null }; }
}
// A diagnostic is a fresh provider invocation, separate from every agent's session and rulebook.
export async function runPromptTest(ctx, provider, model, runner, parsers) {
  const hub = hubOf(ctx), rooms = loadedRooms(hub);
  if (!['claude', 'codex', 'agy'].includes(provider) || typeof model !== 'string') throw new Error('Choose a provider and model.');
  const configured = rooms.flatMap((r) => { const s = currentSettings(r); return [...s.agents, s.worker]; });
  if (model && !configured.some((a) => a.provider === provider && a.model === model)) throw new Error('Choose a model configured on this server.');
  hub.promptRunning ??= new Set();
  if (hub.promptRunning.has(provider)) throw new Error('A prompt test for this provider is already running.');
  hub.promptRunning.add(provider);
  const started = Date.now(), at = new Date(started).toISOString();
  let dir, reply = '', error = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'agent-room-prompt-test-'));
    let args;
    if (provider === 'claude') {
      args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (model) args.push('--model', model);
      args.push('--tools', '');
    } else if (provider === 'codex') {
      args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', 'web_search="disabled"'];
      if (model) args.push('-m', model);
      args.push('-');
    } else {
      args = ['--output-format', 'json', '--sandbox'];
      if (model) args.push('--model', model);
    }
    const output = await runner(provider, args, { input: 'Reply with exactly OK.', cwd: dir, timeoutMs: 30_000, agent: 'prompt test' });
    if (provider === 'claude') {
      const result = JSON.parse(output);
      if (result.is_error) throw new Error(`claude: ${result.result || 'test failed'}`);
      reply = String(result.result ?? '').trim();
    } else if (provider === 'codex') reply = parsers.parseCodexEvents(output).text;
    else reply = parsers.parseAgyOutput(output).text;
    if (!reply) throw new Error(`${provider}: no reply`);
  } catch (err) { error = err?.message ?? String(err); }
  finally {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); }
    catch (err) { error = [error, `Could not remove temporary folder: ${err.message}`].filter(Boolean).join('; '); }
    hub.promptRunning.delete(provider);
  }
  const result = { provider, model, at, durationMs: Date.now() - started, outcome: error ? 'failed' : 'ok', reply: reply.slice(0, 200), error };
  hub.promptResults ??= new Map();
  if (!hub.promptResults.has(provider)) hub.promptResults.set(provider, new Map());
  hub.promptResults.get(provider).set(model, result);
  return result;
}
function healthView(ctx) {
  const hub = hubOf(ctx), m = hub.monitor;
  const rooms = loadedRooms(hub);
  const catalogs = { claude: { models: claudeModels, loaded: true, error: null }, codex: codexModels.status(), agy: agyModels.status() };
  const configured = (settings) => [...settings.agents.map((a) => ({ ...a, role: 'member' })), { ...settings.worker, role: 'worker' }]
    .map((a) => ({ ...a, alignment: modelAlignment(a.model, catalogs[a.provider]) }));
  const defaults = readDefaults();
  const sessions = rooms.map((r) => {
    const view = sessionView(r);
    const entry = (agent, role, key) => ({ ...agent, role, lastTurn: r.turnRecords?.get(r.sessions.get(key)) ?? null });
    return { room: r.cwd, discussion: folderOf(r), agents: [
      ...view.agents.map((a) => entry(a, 'member', a.name)), entry(view.worker, 'worker', `worker:${view.worker.name}`) ] };
  });
  return { promptResults: [...(hub.promptResults?.values() ?? [])].flatMap((results) => [...results.values()]),
    promptRunning: [...(hub.promptRunning ?? [])], sessions, scheduledProviders: [...new Set(rooms.flatMap(providersOf))], catalogs,
    configured: rooms.map((r) => ({ room: r.cwd, discussion: folderOf(r), agents: configured(currentSettings(r)).map((a) => ({ ...a, enabled: a.role === 'worker' || !(r.state.disabledAgents ?? []).includes(a.name) })) })),
    defaults: defaults ? configured(defaults) : null, login: m.login, loginCurrent: m.loginCurrent ?? {}, cli: m.cli, errors: m.errors,
    leftovers: m.leftovers, leftoversChecked: m.leftoversChecked, nextLogin: m.nextLogin, nextLeftovers: m.nextLeftovers,
    running: loadedRooms(hub).flatMap((r) => [...(r.programs?.running ?? [])].map((p) => ({ pid: p.pid, provider: p.provider, ...p.monitorInfo }))),
    quota: loadedRooms(hub).map((r) => ({ room: r.cwd, reachable: r.screen.quota === undefined ? null : r.screen.quota !== null, ...r.screen.quotaAt })) };
}
async function checkProviderHealth(ctx) {
  const hub = hubOf(ctx);
  codexModels();
  await Promise.all([agyModels.refresh(), checkLogins(hub, true, ['claude', 'codex', 'agy']), checkLeftovers(hub),
    ...['claude', 'codex', 'agy'].map((p) => checkCli(hub, p)), ...loadedRooms(hub).map((r) => refreshQuota(r).catch(() => null))]);
  return healthView(ctx);
}
// What this room's panel shows, per provider: its login, how many of this room's programs are in its
// procs, and the leftovers of this room, or of a room not open on this server. A provider with a
// leftover is shown even when no agent of this room uses it.
export function monitorView(ctx) {
  const hub = hubOf(ctx);
  const open = new Set(loadedRooms(hub).map((r) => r.cwd));
  const leftovers = (hub.monitor?.leftovers ?? []).filter((l) => l.room === ctx.cwd || !open.has(l.room));
  const running = [...(ctx.programs?.running ?? [])];
  const view = {};
  for (const p of new Set([...providersOf(ctx), ...leftovers.map((l) => l.provider)])) {
    view[p] = { login: hub.monitor?.loginCurrent?.[p] ?? hub.monitor?.login[p] ?? null, running: running.filter((r) => r.provider === p).length,
      leftovers: leftovers.filter((l) => l.provider === p), inRoom: providersOf(ctx).includes(p) };
  }
  return view;
}
function showMonitor(ctx) {
  if (!ctx.screen || !ctx.room) return;
  ctx.screen.monitor = monitorView(ctx);
  toScreen(ctx, { type: 'monitor', monitor: ctx.screen.monitor });
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
  note(ctx, 'Reloaded the code and the agents\' rulebook; the conversation continues.\n');
  toScreen(ctx, { type: 'reloaded', page: ctx.docs.PAGE }); // pages refresh if their code changed
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
  const convert = /^\/convert\s+(\S+)$/.exec(line);
  if (convert) return convertBrainstorm(ctx, convert[1]);
  const remove = /^\/delete\s+(\S+)$/.exec(line);
  if (remove) return deleteBrainstorm(ctx, remove[1]);
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
    check: (text) => checkSummary(text, { autoDev: autoDevMode }),
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
      if (m.error) note(ctx, `✗ ${m.speaker} failed: ${m.text}`, true);
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
    // Auto-summarize (always on in discussions, not in brainstorms): after a round in which an agent
    // spoke and none failed (and not stopped early by a quota guard). Its own end line is then the
    // "your turn" one; this round's line is just a note.
    if (!ctx.state.brainstorm && (spoke || deciding) && !ending.endsWith('failed') && !stoppedReason) {
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
export const WORKER_BRANCH = 'worker/main';
const NO_GIT = 'Worker requires a source Git repository for its isolated worktree.';
const git = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out.trim()))));
const gitOk = (dir, ...args) => git(dir, ...args).then(() => true, () => false);
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
const lanePlace = async (ctx, lane) => sharedWorktree(ctx, await workerPlace(ctx.cwd, lane ?? null));
// The lanes that exist: worker/main's worktree and each <repo>.workers/<name>/ on worker/<name>.
async function existingLanes(ctx) {
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
async function sharedWorktree(ctx, place) {
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
async function worktrees(top) {
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
const mainRef = async (top) => (await gitOk(top, 'rev-parse', '--verify', '-q', 'refs/heads/main') ? 'main' : 'HEAD');

// The worker's scratch notes, <worktree>/.worker-notes/<task>/, are ignored by Git in any project:
// listed in the repository's own info/exclude (local, never committed), once.
export const NOTES = '.worker-notes';
async function ignoreNotes(place) { await appendExclude(place, `${NOTES}/`); }
// Adds an entry to the worktree's local info/exclude (local to that worktree, never committed),
// once. `entry` is the exact line: a trailing slash ignores a folder only, none ignores a file,
// folder or symlink.
async function appendExclude(place, entry) {
  const file = await git(place.path, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim().replace(/^\/|\/$/g, '') === entry.replace(/^\/|\/$/g, ''))) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
}
// The worktree has no node_modules of its own (it isn't committed): link the room's in, so the
// worker's code and tests run without installing again. The link is ignored locally, so it never
// dirties the worktree; the worktree and its room are on one filesystem, so the link is valid.
async function linkDeps(place) {
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function worktreeLines(place, s) {
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
function laneSummary(place, s, brief) {
  if (!s.exists) return `${place.branch} · worktree not created yet`;
  const parts = [s.operation && `${s.operation} in progress`, s.ahead && `${plural(s.ahead, 'commit')} to review`,
    s.treeDirty && 'uncommitted changes', ...brief].filter(Boolean);
  return [place.branch, ...(parts.length ? parts : ['nothing to review'])].join(' · ');
}

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

// Reads the worktree's state for the Worker tab; with `prepare` (before each instruction), creates
// or reattaches the worktree and catches up first. Returns the place (disabled or not).
// `place`: the lane to prepare (a task's); by default the lane of the discussion in use. The Worker
// tab of each open discussion shows its own lane first, then every other lane with something to
// review, each with its checks (laneChecks), recomputed here: after each task, and when the tab is shown.
export async function refreshWorker(ctx, { prepare = false, fastForward = true, place = null, _beforeBroadcast = null } = {}) {
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
          branchDiagram(place).catch((err) => ({ note: `Branch diagram unavailable: ${err.message}` })),
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

// ── Guardrails for merging a lane into main ──
// For a branch with commits not in main: whether it contains main's current commit; the commits its
// worker last reported testing together (its "Tested:" line, checked against Git and kept in the
// worktree's private Git directory); and, with Git 2.38 or newer, a merge preview. All read-only,
// and only advice: the User merges.
async function laneChecks(place) {
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
const testedFile = async (place) => join(await git(place.path, 'rev-parse', '--absolute-git-dir'), 'agent-room-tested.json');
async function readTested(place) {
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
async function workerGitFacts(place, { before, mainAtStart, askedCatchUp = false } = {}) {
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
// Git's exit status as well as its output (git merge-tree exits 1 for a conflict).
const gitStatus = (dir, ...args) => new Promise((done) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => done({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: out.trim(), err: String(errOut ?? '').trim() })));
let mergeTreeGit = null; // whether this Git has `merge-tree --write-tree` (2.38 or newer), asked once
const hasMergeTree = () => (mergeTreeGit ??= git(tmpdir(), 'version').then((v) => {
  const [, major, minor] = /(\d+)\.(\d+)/.exec(v) ?? [];
  return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38);
}, () => false));
// The preview changes no branch, worktree or index; it does write unreferenced Git objects (the
// merged tree), which Git's own cleanup (gc) removes in time. Not shown with an older Git.
async function mergePreview(place, main) {
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

// The worker: instructions from the Worker tab run one at a time, in the order sent, alongside the
// discussion (they don't wait for a round, and a round doesn't wait for them), in the folder's shared
// queue (see "The shared worker queue"), which carries over a reload. The worker is sent only the
// instruction itself; the origin's own worker session holds the earlier ones. ctx.workQueue settles
// when this context's queued tasks have run (or were dropped).
// `run`: an auto dev run relaying this instruction (shown as "Relayed from discussion").
export async function retryWork(ctx, id, settings = null) {
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

export const BRAINSTORM_NO_WORK = 'Turn this brainstorm into a discussion to send work.';
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
export function queueWork(ctx, text, run = null, rollback = null, retry = null, { catchUp = false } = {}) {
  if (ctx.state.brainstorm) return note(ctx, `✗ ${BRAINSTORM_NO_WORK} The instruction was not sent.`, true);
  if (ctx.discussion && shopOf(ctx).closing?.has(ctx.discussion.name)) return note(ctx, '✗ This discussion is closing; the instruction was not sent.', true);
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
      const retryBrief = t?.retry ? `Your earlier attempt at this instruction failed: ${t.retry.error}\nInspect the current worktree and Git state first, including uncommitted edits and any merge or revert in progress. Commits made since the failure:\n${t.retry.after ? (await git(place.path, 'log', '--format=%H %s', `${t.retry.after}..HEAD`).catch(() => '(could not read commits)') || '(none)') : '(the failure commit could not be determined)'}\n\n` : '';
      const makeUsageLine = () => ctx.usage.agentUsageLine({
        total: worker === ctx.worker ? ctx.totals?.[worker.name] : undefined,
        usageUnavailable: worker !== ctx.worker,
        provider: worker.provider,
        gauges: ctx.screen?.quota,
        measured: ctx.screen?.quotaAt?.measured,
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

// ── Scheduler (recurring discussions) ─────────────────────────────────
// Per-room schedule stored in agent-room's local state, outside the project's working tree:
// ~/.local/state/agent-room/schedules/<sha256 of realpath(room folder)>.json
const DEFAULT_QUOTA_FLOOR = 50;
const SCHEDULE_EVERY_MS = 15_000;
const SCHEDULE_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function scheduleFile(ctx) {
  return ctx.scheduleFile ?? join(homedir(), '.local', 'state', 'agent-room', 'schedules',
    createHash('sha256').update(realpathSync(ctx.cwd)).digest('hex') + '.json');
}

export function readSchedule(ctx) {
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
}

function listScheduleDiscussions(ctx) {
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

export function getSchedule(ctx) {
  const data = readSchedule(ctx);
  const running = shopOf(ctx).schedulerRunningTasks ?? new Set();
  return {
    quotaFloor: data.quotaFloor,
    tasks: data.tasks.map((t) => ({
      id: t.id,
      discussion: t.discussion,
      prompt: t.prompt,
      time: t.time,
      enabled: !!t.enabled,
      lastRun: t.lastRun ?? null,
      running: running.has(t.id),
    })),
    discussions: listScheduleDiscussions(ctx),
  };
}

function validateTaskInput(ctx, body) {
  const discussion = String(body?.discussion ?? '').trim();
  const d = discussion ? discussionRef(join(ctx.cwd, 'discussions'), discussion) : null;
  if (!d) {
    throw new Error('Choose an existing discussion from this room.');
  }
  if (isWorkbenchDir(join(ctx.cwd, 'discussions', d.section ?? '', d.name))) {
    throw new Error('Workbenches cannot be scheduled.');
  }
  const prompt = String(body?.prompt ?? '').trim();
  if (!prompt) throw new Error('Enter a prompt for the scheduled run.');
  const time = String(body?.time ?? '').trim();
  if (!SCHEDULE_TIME_RE.test(time)) throw new Error('Enter a daily time in 24-hour HH:MM format.');
  const enabled = body?.enabled === undefined ? true : !!body.enabled;
  return { discussion, prompt, time, enabled };
}

export function saveSchedule(ctx, body) {
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
    const fields = validateTaskInput(ctx, body);
    const timeChanged = task.time !== fields.time;
    Object.assign(task, fields);
    if (timeChanged) task.lastTriggerKey = null;
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

function recordTaskRun(ctx, taskId, status, reason, at) {
  const data = readSchedule(ctx);
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.lastRun = { at, status, reason: reason ?? null };
  writeSchedule(ctx, data);
  broadcastSchedule(ctx);
}

export async function runScheduledTask(ctx, taskId, { now = null, loadRoom = load } = {}) {
  const startedAt = now ?? new Date();
  const clockMs = () => (now ? now.getTime() : Date.now());
  const at = startedAt.toISOString();
  const data = readSchedule(ctx);
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const parent = join(ctx.cwd, 'discussions');
  const d = discussionRef(parent, task.discussion);
  if (!d) {
    recordTaskRun(ctx, taskId, 'skipped', `discussion "${task.discussion}" was not found`, at);
    return { status: 'skipped', reason: `discussion "${task.discussion}" was not found` };
  }
  const shop = shopOf(ctx);
  if (shop.closing?.has(d.name)) {
    const reason = `${d.name} is closing`;
    recordTaskRun(ctx, taskId, 'skipped', reason, at);
    return { status: 'skipped', reason };
  }
  if (siblings(ctx).some((c) => !c.stopped && isDiscussion(c, d.name))) {
    const reason = `${d.name} is open in a board`;
    recordTaskRun(ctx, taskId, 'skipped', reason, at);
    return { status: 'skipped', reason };
  }
  if ([...runningTasks(shop), ...queuedTasks(shop)].some((t) => (t.owner ?? ownerOf(t.origin)) === d.name)) {
    const reason = `${d.name} is busy with a worker task`;
    recordTaskRun(ctx, taskId, 'skipped', reason, at);
    return { status: 'skipped', reason };
  }
  shop.schedulerRunning ??= new Set();
  shop.schedulerRunningTasks ??= new Set();
  if (shop.schedulerRunning.has(d.name)) {
    const reason = `${d.name} already has a scheduled run in progress`;
    recordTaskRun(ctx, taskId, 'skipped', reason, at);
    return { status: 'skipped', reason };
  }

  // Determine the discussion's saved agents and check the quota floor before resuming.
  const saved = readCheckpoint(ctx, d.name);
  const agentSpecs = saved?.agentSpecs ?? roomDefaults(ctx).agents ?? ctx.agentSpecs ?? '';
  const providers = [...new Set(agentSpecs.split(',').filter(Boolean).map((s) => parseSpec(s).provider))];
  const quota = await ctx.usage.fetchQuota();
  refreshQuota(ctx, quota).catch(() => {});
  const preCheck = ctx.usage.checkQuotaFloor(quota, providers, data.quotaFloor, { now: clockMs() });
  if (!preCheck.ok) {
    recordTaskRun(ctx, taskId, 'skipped', preCheck.reason, at);
    return { status: 'skipped', reason: preCheck.reason };
  }

  shop.schedulerRunning.add(d.name);
  shop.schedulerRunningTasks.add(task.id);
  broadcastSchedule(ctx);

  let runCtx = null;
  let createdBeside = false;
  try {
    if (ctx.hub?.addRoom) {
      runCtx = await openBeside(ctx);
      createdBeside = true;
    } else {
      const state = { transcript: [], seen: new Map() };
      runCtx = { ...ctx, state, discussion: null, sessions: new Map(), programs: { running: new Set(), stopping: false },
        screen: { clients: new Set(), transcript: state.transcript, worker: shop.log }, lastRound: null, logPath: null,
        checkpointError: null, hub: null, noScreen: true };
    }
    if (ctx.closingAgent) runCtx.closingAgent = ctx.closingAgent;
    if (d.section && !await moveDiscussion(runCtx, task.discussion, 'active')) {
      throw new Error(`Could not move ${task.discussion} to active discussions.`);
    }

    // Resume the way a closed discussion is resumed: fresh sessions, its saved agents, its closing statement.
    const release = await suspendTransfers(runCtx, d.name);
    try {
      if (saved && (saved.invalid || saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== d.name)) {
        throw new Error(`The checkpoint of ${d.name} is invalid.`);
      }
      const state = { transcript: [], seen: new Map() }, sessions = new Map();
      const next = { ...runCtx, state, sessions, agentSpecs: saved?.agentSpecs ?? runCtx.agentSpecs, workerSpec: saved?.workerSpec ?? runCtx.workerSpec };
      const loaded = await loadRoom(next, `?sched=${Date.now()}`);
      const freshSaved = {
        version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
        discussion: { name: d.name, title: saved?.discussion?.title ?? d.name },
        fresh: true, fromClosed: true, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec,
        work: saved?.work ?? workOf(shop, d.name),
      };
      writeCheckpoint(runCtx, d.name, freshSaved);
      setClosed(runCtx, d.name, false);
      Object.assign(runCtx, loaded, {
        usage: ctx.usage ?? loaded.usage,
        state, sessions, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec,
        freshSummary: null, lastRound: null, agentsStarted: false, workerBriefed: null,
        workerTree: null, workerLabel: null, workerHandoff: false, workerSeat: randomBytes(6).toString('hex'),
      });
      runCtx.screen.transcript = state.transcript;
      switchTo(runCtx, { name: d.name, dir: join(parent, d.name), title: freshSaved.discussion.title, continued: true });
      runCtx.closedBriefing = true;
      wire(runCtx);
    } finally {
      release();
    }

    if (!await openDiscussion(runCtx, task.prompt)) {
      throw new Error(`Could not open transcript for ${d.name}.`);
    }

    const activeProviders = () => [...new Set(runCtx.room.agents
      .filter((a) => !(runCtx.state.disabledAgents ?? []).includes(a.name))
      .map((a) => a.provider))];

    const roundRes = await runRound(task.prompt, runCtx, {
      speaker: 'Scheduler',
      beforeLap: async (lap) => {
        const q = await runCtx.usage.fetchQuota();
        refreshQuota(runCtx, q).catch(() => {});
        const check = runCtx.usage.checkQuotaFloor(q, activeProviders(), readSchedule(ctx).quotaFloor, { now: clockMs() });
        if (check.ok) return null;
        return `Scheduled run stopped early by quota guard before lap ${lap + 1}: ${check.reason}`;
      },
    });

    const extraLine = roundRes?.stoppedReason
      ? `${roundRes.stoppedReason}. This run stopped early and is not a completed review.`
      : roundRes?.failedError
        ? `Scheduled run failed (${roundRes.failedError}). This run is not a completed review.`
        : null;

    await closeNamedDiscussion(runCtx, d.name, { extraLine, rethrow: true });

    if (roundRes?.stoppedReason) {
      recordTaskRun(ctx, taskId, 'stopped', roundRes.stoppedReason, at);
      return { status: 'stopped', reason: roundRes.stoppedReason };
    }
    if (roundRes?.failedError) {
      recordTaskRun(ctx, taskId, 'failed', roundRes.failedError, at);
      return { status: 'failed', reason: roundRes.failedError };
    }
    recordTaskRun(ctx, taskId, 'ran', null, at);
    return { status: 'ran', reason: null };
  } catch (err) {
    recordTaskRun(ctx, taskId, 'failed', err.message, at);
    if (createdBeside && runCtx && !runCtx.stopped && fresh(runCtx)) closeContext(runCtx);
    return { status: 'failed', reason: err.message };
  } finally {
    shop.schedulerRunning.delete(d.name);
    shop.schedulerRunningTasks.delete(task.id);
    broadcastSchedule(ctx);
    showHeader(ctx);
  }
}

export async function checkSchedule(ctx, now = null, opts = {}) {
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
