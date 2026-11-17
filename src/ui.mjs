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
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
latest saved summary; its saved sessions are discarded), /docs (pick a document to view in the
browser), /new (end this session; your next message starts a new discussion; the worker
carries on), /brainstorm (New brainstorm: its first message names it, in DIR/brainstorms/<date>-<title>/,
saved like a discussion but sending no work; /resume brainstorms/<name> and /fresh brainstorms/<name> as
for discussions), /convert brainstorms/<name> (Turn into a discussion: its folder moves to discussions/,
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
    if (!a || !['claude', 'codex', 'agy'].includes(a.provider)) throw new Error('Choose Claude, Codex or agy.');
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
  let models = [], lastAttempt = -Infinity, pending = false;
  return () => {
    if (!pending && now() - lastAttempt >= 5 * 60_000) {
      lastAttempt = now();
      pending = true;
      exec('agy', ['models'], { timeout: 5000 }, (err, stdout = '') => {
        if (!err) models = String(stdout).split('\n').flatMap((line) => {
          const [id, label] = line.trim().split('\t');
          return label && /^[A-Za-z0-9._[\]()-]+$/.test(id) ? [{ id, label: label.trim() }] : [];
        });
        pending = false;
      });
    }
    return models;
  };
}
const agyModels = agyModelCatalog();
let agyModelsWarmed = false;
export function modelChoices() {
  // Codex maintains this catalog itself; unavailable catalogs still allow a custom model ID.
  let codex = [];
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = cache.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch {}
  return { claude: ['opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })), codex, agy: agyModels() };
}
// A model's name for the tab titles: its label in the catalog (or its ID), "<Provider> default" for the CLI default.
function modelLabel(provider, model) {
  if (!model) return `${provider === 'agy' ? 'agy' : provider[0].toUpperCase() + provider.slice(1)} default`;
  return modelChoices()[provider]?.find((m) => m.id === model)?.label ?? model;
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
  const instructions = readFileSync(new URL('../README-for-brainstorming-agents.md', import.meta.url), 'utf8');
  const workerInstructions = readFileSync(new URL('../README-for-worker-agents.md', import.meta.url), 'utf8');
  const { createAgent, claudeTitle, run, findLeftovers } = await import(`./agents.mjs${v}`);
  const { createRoom, closingStatement } = await import(`./room.mjs${v}`);
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
    ctx.showMonitor?.();
    turn.then(() => ctx.showMonitor?.(), () => ctx.showMonitor?.());
    return turn;
  };
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const { provider, name, model } = parseSpec(spec);
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    return createAgent(provider, { name, model, cwd: ctx.cwd, instructions, runner, session: ctx.sessions.get(name) });
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
  const worker = createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions,
    timeoutMs: WORKER_TIMEOUT_MS, runner, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: shop?.log ?? [], working: shop && runningTasks(shop).some((t) => t.origin === ctx) ? wName : null };
  const roomShop = shop ?? newShop(screen.worker);
  roomShop.launchDefaults ??= { agents: ctx.agentSpecs, worker: ctx.workerSpec };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, replicate, totals: ctx.totals ?? {}, screen, findLeftovers,
    shop: roomShop,
    // A new worker agent on `session` (detachWorker), as this load made ctx.worker.
    makeWorker: (session) => createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions,
      timeoutMs: WORKER_TIMEOUT_MS, runner, session }),
    // Close's closing statement, written by a one-off agent with the worker's provider and model, in
    // the room's folder, with no rulebook and a session of its own (never the worker's session or
    // worktree). `agent`: a stand-in for tests (ctx.closingAgent).
    closingStatement: (options, agent = createAgent(wProvider, { name: wName, model: wModel, cwd: ctx.cwd, runner, session: {} })) =>
      closingStatement(agent, options),
    suggestTitle: (message, options) => claudeTitle(message, { ...options, runner }) };
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
  ctx.screen.work = (text) => { autoDevInput(ctx, 'you sent the Worker an instruction'); return queueWork(ctx, text); };
  ctx.screen.say = (line, confirmed) => {
    if (!line.trim().startsWith('/')) autoDevInput(ctx, 'you sent a message');
    // Quit room closes every discussion open in this folder.
    if (line.trim() === '/quit') for (const c of siblings(ctx)) if (c !== ctx) c.say?.('/quit');
    return ctx.say(line, confirmed);
  };
  ctx.screen.newRoom = (body) => newRoom(ctx, body);
  ctx.screen.listRooms = async () => listRooms(ctx);
  if (!agyModelsWarmed) { agyModelsWarmed = true; agyModels(); } // start without delaying room startup
  ctx.screen.getSettings = () => {
    const launch = roomDefaults(ctx);
    return { settings: currentSettings(ctx), defaults: readDefaults(),
      launchDefaults: { agents: launch.agents.split(',').map((s) => parseSpec(s)), worker: parseSpec(launch.worker, true) },
      models: modelChoices(), started: settingsStarted(ctx) };
  };
  ctx.screen.saveSettings = (value) => saveSettings(ctx, value);
  ctx.screen.retryWork = (id, settings) => retryWork(ctx, id, settings);
  ctx.screen.cancelClose = (name) => cancelClose(ctx, name);
  ctx.screen.setAgentEnabled = (name, enabled, member) => setAgentEnabled(ctx, name, enabled, { member });
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
    discussion: d ? d.title : ctx.state.brainstorm ? 'New brainstorm' : 'No discussion started',
    active: folderOf(ctx), started: !!ctx.logPath || !!ctx.state.brainstorm,
    fresh: !settingsStarted(ctx), // its members can still be chosen: the page opens their panel
    brainstorm: !!ctx.state.brainstorm, // a brainstorm, in brainstorms/<name>/ once started (see newBrainstorm)
    // The agents this discussion started with, for the members panel once it has started.
    members: ctx.room.agents.map((a) => ({ provider: a.provider, name: a.name,
      model: specs.find((s) => s.name === a.name)?.model ?? '',
      modelLabel: modelLabel(a.provider, specs.find((s) => s.name === a.name)?.model ?? ''), // for the Discussion tab's title
      enabled: !(ctx.state.disabledAgents ?? []).includes(a.name) })),
    failedAgents: ctx.room.agents.filter((a) => ctx.state.transcript.some((m) => m.error && m.speaker === a.name) || (ctx.state.disabledAgents ?? []).includes(a.name)).map((a) => ({ name: a.name, disabled: (ctx.state.disabledAgents ?? []).includes(a.name) })),
    autoDev: autoDevView(ctx), retryId: ctx.retryFailure?.available ? ctx.retryFailure.id : null,
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null,
    checkpoints: checkpoints(ctx), // the saved discussions, for Explorer's Resume (see "Checkpoints")
    closedDiscussions: closedDiscussions(ctx),
    closingDiscussions: [...(shopOf(ctx).closing?.entries() ?? [])].filter(([, c]) => c.waiting).map(([name]) => name),
    back: ctx.previous ?? null, // the discussion before the last switch, until the next one starts
    code: ctx.code ?? null, // the version this process runs (see codeInfo)
    rollbacks: [...(shopOf(ctx).rollbacks?.values() ?? [])].map(({ name, status, report, commit }) => ({ name, status, report, commit })),
    multi: multi(ctx), open: openList(ctx) }; // the folder's open discussions (see openList)
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
    if (!c.room || !c.worker) continue; // still loading
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

// A brainstorm is a folder in <root>/brainstorms/, named as a discussion is (never the name of one in
// discussions/, archive/ or deferred/, nor the other way round), holding transcripts/ and, if agents
// draw, drawings/. Its checkpoint key is "brainstorms/<name>" (a discussion's is its name), and so
// is its ref in /resume, /fresh, /convert and /delete. Turn into a discussion moves it to discussions/.
const BRAINSTORMS = 'brainstorms';
const brainstormRef = (ref) => /^brainstorms\/([^/\\]+)$/.exec(ref ?? '')?.[1] ?? null;
const isBrainstorm = (c, name) => !!c.state?.brainstorm && c.discussion?.name === name;
const isDiscussion = (c, name) => !c.state?.brainstorm && c.discussion?.name === name;
// Its folder under the root ("discussions/<name>" or "brainstorms/<name>"), its checkpoint key and
// its ref in commands, once it has a name; null before.
const folderOf = (ctx) => (ctx.discussion ? `${ctx.state?.brainstorm ? BRAINSTORMS : 'discussions'}/${ctx.discussion.name}` : null);
const keyOf = (ctx) => (ctx.state?.brainstorm ? `${BRAINSTORMS}/${ctx.discussion.name}` : ctx.discussion.name);
// Where a new discussion's or brainstorm's name must also be free: the other kind's folders.
const takenElsewhere = (cwd, brainstorm) => (brainstorm
  ? [join(cwd, 'discussions'), ...SECTIONS.map((s) => join(cwd, 'discussions', s))] : [join(cwd, BRAINSTORMS)]);

// A discussion named by the User or the page: "<date>-<title>" (active) or "archive/<date>-<title>" /
// "deferred/<date>-<title>". Resolves to { section: null | 'archive' | 'deferred', name } or null.
function discussionRef(parent, ref) {
  const parts = ref.split('/');
  const [section, name] = parts.length === 2 ? parts : [null, parts[0]];
  if (parts.length > 2 || (section && !SECTIONS.includes(section)) || !DATED.test(name ?? '') || /[\\]/.test(name)) return null;
  return existsSync(join(parent, section ?? '', name)) ? { section, name } : null;
}

// /move <discussion> active|archive|deferred: the whole folder moves (documents and transcripts).
// Not the discussion this session is using (its transcript is open there).
async function moveDiscussion(ctx, ref, to, { rollbackConfirmed = false } = {}) {
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
  try {
    const brainstorm = !!ctx.state.brainstorm;
    if (!ctx.discussion) {
      const label = `Claude (choosing the ${brainstorm ? 'brainstorm' : 'discussion'}'s title)`;
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
      ctx.discussion = { name, dir: join(parent, name), title: title ?? `${brainstorm ? 'Brainstorm' : 'Discussion'} — ${when(now)}`, continued: false };
      log(ctx, how);
    }
    const { title, dir } = ctx.discussion;
    const head = `# ${title} — session of ${when(now)}\n\nRoom: ${describe(ctx.room)} · worker ${ctx.worker.name}\n\nRoot: ${ctx.cwd}\n\n`;
    ctx.logPath = createSessionFile(join(dir, 'transcripts'), head + (ctx.pendingLog ?? ''), now);
    ctx.pendingLog = '';
    ctx.previous = null; // the "← back to …" link lasts until this discussion starts
  } catch (err) {
    note(ctx, `✗ Couldn't create the ${ctx.state.brainstorm ? 'brainstorm' : 'discussion'}'s folder or transcript: ${err.message}\nYour message was not sent to the agents. Here it is, to send again:\n\n${line}\n`, true);
    return false;
  }
  ctx.state.briefing = briefing(ctx);
  out(ctx, `${ctx.state.brainstorm ? 'Brainstorm' : 'Discussion'}: ${ctx.discussion.dir}\nTranscript: ${ctx.logPath}`);
  showHeader(ctx);
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
// [{ name, at, kind: 'full' | 'fresh' }], for the page's Resume tooltips. A brainstorm's name is its
// key, "brainstorms/<name>", with its title (the Brainstorms tab shows it).
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
          ...(saved.fresh && { summary: !!saved.summary }), ...(saved.brainstorm && { title: typeof saved.discussion.title === 'string' ? saved.discussion.title : saved.discussion.name }) }] : [];
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
      ...base, workerSpec: ctx.workerSpec,
      sessions: [...r.sessions, [worker, ctx.sessions.get(worker) ?? {}]], ...rest,
      worker: shopOf(ctx).log.filter((m) => m.origin === originLabel(ctx)),
      workerBriefed: ctx.workerBriefed ?? null, workerTree: ctx.workerTree ?? null,
      workerLabel: ctx.workerLabel ?? null, workerHandoff: !!ctx.workerHandoff, workerSeat: ctx.workerSeat ??= randomBytes(6).toString('hex'),
      work: workOf(shopOf(ctx), d.name),
    });
    ctx.checkpointError = null;
  } catch (err) {
    if (ctx.checkpointError !== err.message) note(ctx, `✗ Couldn't save this ${ctx.state.brainstorm ? 'brainstorm' : 'discussion'}'s checkpoint: ${err.message}. Resume would continue from an earlier one.`, true);
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
// Each interrupted task, with what the worktree shows now; each task that never started. Shown in
// the Worker tab, and as one agent-room message in the discussion's chat (so its agents learn it).
async function reportWork(ctx, name, saved) {
  const w = restoreWork(ctx, name, saved);
  const lines = [];
  for (const r of w.interrupted.filter((x) => !x.reported)) {
    const what = `[${name}] "${firstLine(r.task)}" (started ${clock(r.at)})`;
    let place = null, s = null;
    try { place = await lanePlace(ctx, r.lane ?? null); if (!place.disabled) s = await worktreeStatus(place); } catch {}
    const found = !s ? 'it could not be inspected' : !s.exists ? 'it does not exist' : s.treeDirty ? 'it has uncommitted edits' : 'it is clean';
    let commits = null;
    if (r.before && s?.exists && !s.treeDirty) {
      try { commits = (await labelledCommits(place.path, `${r.before}..HEAD`)).filter((c) => c.origin === name); } catch { commits = null; }
    }
    if (!r.before) lines.push(`Result unknown: ${what} was interrupted before its starting point was recorded. Check the worktree (${found}).`);
    else if (!s?.exists || (!s.treeDirty && !commits)) lines.push(`Result unknown: ${what} was interrupted by Restart, Quit or a crash. Check the worktree (${found}).`);
    else if (s.treeDirty) lines.push(`Interrupted by Restart, Quit or a crash: ${what} left uncommitted edits in the worktree. Ask the worker to finish and commit them, or to abandon them.`);
    else if (commits.length) lines.push(`Interrupted after committing: ${what}: ${commits.map((c) => `${c.id.slice(0, 7)} (${c.files.join(', ') || 'no files changed'})`).join(' · ')}. Its reply was lost. Ask the worker to check whether the task is complete.`);
    else lines.push(`Interrupted: ${what} left no commits or edits in the worktree. It may still have written notes elsewhere, such as the discussion's folder. Send it again if still wanted.`);
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
  const state = { ...saved.state, seen, restored: { text: waiting ? `${waiting}\n\n${restored}` : restored,
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
      agentsStarted: true, autoDev: null, autoDevSent: [], freshSummary: null,
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
  if (ctx.state.brainstorm) endSession(ctx, 'ending the brainstorm');
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
    discussion: ctx.discussion ?? null, logPath: ctx.logPath ?? null, brainstorm: !!ctx.state.brainstorm,
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
function saveLeftWorker(ctx, worker, usage = null) {
  const s = worker.seat, d = s.discussion;
  if (!d || s.brainstorm || !s.id) return;
  const saved = readCheckpoint(ctx, d.name);
  if (!saved || saved.invalid || saved.fresh || saved.workerSeat !== s.id) return;
  const shop = shopOf(ctx), kept = Array.isArray(saved.worker) ? saved.worker : [];
  const known = new Set(kept.map((m) => JSON.stringify(m)));
  try {
    writeCheckpoint(ctx, d.name, { ...saved,
      sessions: [...(saved.sessions ?? []).filter(([k]) => k !== s.key), [s.key, s.session ?? {}]],
      workerBriefed: s.briefed, workerTree: s.tree, workerLabel: s.label, workerHandoff: s.handoff,
      ...(usage && { totals: { ...(saved.totals ?? {}), [worker.name]: ctx.usage.addUsage(saved.totals?.[worker.name], usage) } }),
      worker: [...kept, ...shop.log.filter((m) => m.origin === s.origin && !known.has(JSON.stringify(m)))],
      work: workOf(shop, d.name) });
  } catch (err) { note(ctx, `✗ Couldn't save ${d.name}'s worker session in its checkpoint: ${err.message}`, true); }
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
  const name = d.name, saved = readCheckpoint(ctx, name);
  const wasClosed = closedDiscussions(ctx).includes(name);
  if (wasClosed || saved?.fromClosed) {
    const release = await suspendTransfers(ctx, name);
    try {
    if (saved && (saved.invalid || saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name))
      throw new Error(`The checkpoint of ${name} is invalid. It was kept; Start fresh starts the discussion from its handoff instead.`);
    const state = { transcript: [], seen: new Map() }, sessions = new Map();
    const next = { ...ctx, state, sessions, agentSpecs: saved?.agentSpecs ?? ctx.agentSpecs, workerSpec: saved?.workerSpec ?? ctx.workerSpec };
    const loaded = await load(next, `?reopen=${Date.now()}`);
    await leaveSession(ctx, `resuming the discussion ${name}`);
    const freshSaved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(), discussion: { name, title: saved?.discussion?.title ?? name },
      fresh: true, fromClosed: true, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, work: saved?.work ?? workOf(shopOf(ctx), name) };
    writeCheckpoint(ctx, name, freshSaved);
    setClosed(ctx, name, false);
    Object.assign(ctx, loaded, { state, sessions, agentSpecs: next.agentSpecs, workerSpec: next.workerSpec,
      freshSummary: null, lastRound: null, agentsStarted: false, workerBriefed: null, workerTree: null,
      workerLabel: null, workerHandoff: false, workerSeat: randomBytes(6).toString('hex') });
    ctx.screen.transcript = state.transcript;
    switchTo(ctx, { name, dir: join(parent, name), title: freshSaved.discussion.title, continued: true });
    ctx.closedBriefing = true;
    wire(ctx);
    await reportWork(ctx, name, freshSaved.work);
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
  await leaveSession(ctx, `resuming the discussion ${name}`);
  switchTo(ctx, { name, dir: join(parent, name), title: name, continued: true });
  setClosed(ctx, name, false);
  showHeader(ctx);
  ctx.freshSummary = checkpointSummary(saved);
  note(ctx, `Resumed the discussion ${name}: it has no saved session, so your next message starts a fresh one there, from its handoff and notes${ctx.freshSummary ? ' and the summary chosen at Start fresh' : ''}.`);
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
  const name = brainstormRef(ref), dir = name && join(ctx.cwd, BRAINSTORMS, name);
  if (!name || !DATED.test(name) || !existsSync(dir)) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const open = siblings(ctx).find((c) => c !== ctx && isBrainstorm(c, name));
  if (open) return goto(ctx, open);
  if (isBrainstorm(ctx, name)) return note(ctx, `${name} is the brainstorm in use here.`);
  if (multi(ctx) && !fresh(ctx)) return besideWith(ctx, (next) => resumeBrainstorm(next, ref));
  const saved = readCheckpoint(ctx, ref);
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
  const name = brainstormRef(ref), dir = name && join(ctx.cwd, BRAINSTORMS, name);
  if (!name || !DATED.test(name) || !existsSync(dir)) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const open = siblings(ctx).find((c) => c !== ctx && isBrainstorm(c, name));
  if (open) { open.say?.(`/fresh ${ref}`); return goto(ctx, open); } // it starts afresh there
  if (multi(ctx) && !fresh(ctx) && !isBrainstorm(ctx, name)) return besideWith(ctx, (next) => freshBrainstorm(next, ref));
  const title = ctx.discussion && isBrainstorm(ctx, name) ? ctx.discussion.title : null;
  await leaveSession(ctx, `starting the brainstorm ${name} afresh`); // saves its checkpoint first
  const before = readCheckpoint(ctx, ref);
  const summary = checkpointSummary(before);
  const saved = { version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
    discussion: { name, title: title ?? (typeof before?.discussion?.title === 'string' ? before.discussion.title : name) }, brainstorm: true, fresh: true, summary };
  writeCheckpoint(ctx, ref, saved);
  enterBrainstorm(ctx, name, saved);
  note(ctx, `Started the brainstorm ${name} afresh: your next message starts a new session there, ${summary ? `with its latest summary${summary.outcome === 'agreed' ? '' : ' (not agreed)'}` : 'pointing the agents to its transcripts'}. Its saved sessions and chat were discarded.`);
}

// /convert brainstorms/<name> (Turn into a discussion): its folder moves to discussions/<name>/
// (never over an existing folder, checked as it moves), with its checkpoint. Its agents keep their
// sessions; each is told once, in its next prompt (state.restored), the new folder and that the
// discussion rules apply. The worker starts fresh at the discussion's first task. Open elsewhere, it
// is converted there, between its rounds.
async function convertBrainstorm(ctx, ref) {
  const name = brainstormRef(ref), from = name && join(ctx.cwd, BRAINSTORMS, name);
  if (!name || !DATED.test(name) || !existsSync(from)) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  const open = siblings(ctx).find((c) => isBrainstorm(c, name));
  if (open && open !== ctx) { open.say?.(`/convert ${ref}`); return goto(ctx, open); }
  const parent = join(ctx.cwd, 'discussions'), dest = join(parent, name);
  const clash = [dest, ...SECTIONS.map((s) => join(parent, s, name))].find((p) => existsSync(p));
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
  note(ctx, `Turned the brainstorm ${name} into the discussion ${name}, in discussions/: ${open ? 'its agents carry on' : 'Resume it to carry on'} with the same sessions, told of the new folder; the worker starts fresh with its first task.`);
}

// /delete brainstorms/<name> (Delete): its folder (transcripts, drawings) and checkpoint are removed
// for good. Never an open brainstorm (the page disables the button too).
function deleteBrainstorm(ctx, ref) {
  const name = brainstormRef(ref), dir = name && join(ctx.cwd, BRAINSTORMS, name);
  if (!name || !DATED.test(name) || !existsSync(dir)) return note(ctx, `✗ No brainstorm "${ref}" in ${join(ctx.cwd, BRAINSTORMS)}.`, true);
  if (siblings(ctx).some((c) => !c.stopped && isBrainstorm(c, name))) return note(ctx, `✗ ${name} is open: close it before deleting it. Nothing was deleted.`, true);
  try { rmSync(dir, { recursive: true }); } catch (err) { return note(ctx, `✗ Couldn't delete ${name}: ${err.message}`, true); }
  try { unlinkSync(checkpointFile(ctx, ref)); } catch (err) { if (err.code !== 'ENOENT') note(ctx, `✗ Couldn't remove ${name}'s checkpoint: ${err.message}`, true); }
  listedCheckpoints.clear();
  for (const c of siblings(ctx)) if (c.screen) toScreen(c, { type: 'moved', from: `${BRAINSTORMS}/${name}`, to: null });
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
  ctx.retryFailure = null;
  ctx.autoDev = null; // Resume, Start fresh, New discussion and New brainstorm end an auto dev run
  ctx.autoDevSent = [];
  Object.assign(screen, { doc: null, thinking: null, status: null });
  ctx.logPath = null;
  ctx.pendingLog = '';
  ctx.agentsStarted = false;
}

// Makes `next` (or no discussion) the one in use. The one it replaces is remembered for the header's
// "← back to …" link, until the next message opens a discussion.
function switchTo(ctx, next) {
  const was = ctx.discussion;
  ctx.closedBriefing = false;
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
  if (!was && !ctx.logPath && !ctx.state.brainstorm) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'starting a new discussion');
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
  if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'starting a brainstorm');
  await defaultsForNew(ctx);
  ctx.state.brainstorm = true;
  ctx.state.brainstormId = randomBytes(12).toString('hex');
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New brainstorm: your next message names it and starts it, in ${BRAINSTORMS}/.${was ? ` To go back, /resume ${was}.` : ''}`);
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
function openList(ctx) {
  return siblings(ctx).filter((c) => c.state && c.id).map((c) => ({ url: pageOf(c), current: c === ctx,
    title: c.discussion?.title ?? (c.state.brainstorm ? 'New brainstorm (not started)' : 'New discussion (not started)'),
    active: folderOf(c), brainstorm: !!c.state.brainstorm, started: !!c.logPath, working: !!c.screen.working }));
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
  if (ctx.state.brainstorm && fresh(ctx)) {
    endSession(ctx, 'starting a new discussion');
    await defaultsForNew(ctx);
    switchTo(ctx, null);
    return note(ctx, 'New discussion: your next message names it and starts it.');
  }
  if (fresh(ctx)) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  const next = await openBeside(ctx);
  goto(ctx, next);
  note(ctx, `New discussion: ${ctx.discussion?.name ?? 'this one'} stays open (${ctx.state.brainstorm ? 'Brainstorms' : 'Discussions'}: Resume shows it again).`);
}
// /brainstorm on the screen: beside the open discussions and brainstorms (in this context if it is empty).
async function newBrainstormBeside(ctx) {
  if (fresh(ctx)) return newBrainstorm(ctx);
  const next = await openBeside(ctx);
  next.say?.('/brainstorm');
  goto(ctx, next);
}
// /close (Close discussion): this discussion (or brainstorm) closes; the others stay open. The last
// one open ends its session instead, leaving an empty room, as New discussion does in the terminal.
function closeDiscussion(ctx) {
  if (!ctx.state.brainstorm && ctx.discussion) return closeNamedDiscussion(ctx, ctx.discussion.name);
  const hold = workerHold(ctx);
  if (hold) return note(ctx, `✗ This can't be closed yet: ${hold}.`, true);
  const others = siblings(ctx).filter((c) => c !== ctx);
  if ((!others.length || !multi(ctx)) && fresh(ctx) && !ctx.state.brainstorm)
    return note(ctx, 'Nothing to close: no discussion is open here.');
  if (others.length && multi(ctx) && ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  if (!others.length || !multi(ctx)) {
    const was = ctx.discussion, brain = !!ctx.state.brainstorm;
    if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, brain ? 'closing the brainstorm' : 'closing the discussion');
    switchTo(ctx, null);
    return note(ctx, was ? `Closed ${was.name}; its checkpoint is kept. To go back, Resume it in ${brain ? 'Brainstorms' : 'Explorer'}.` : 'Closed the brainstorm.');
  }
  closeContext(ctx, others[0]);
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
  const state = { transcript: [], seen: new Map() };
  const shadow = { ...ctx, state, discussion: null, sessions: new Map(), programs: { running: new Set(), stopping: false },
    screen: { clients: new Set(), transcript: state.transcript, worker: shopOf(ctx).log }, lastRound: null, logPath: null, checkpointError: null };
  const saved = readCheckpoint(ctx, d.name);
  if (saved && !saved.fresh) {
    const apply = await loadCheckpoint(shadow, saved, d.name, false, dir);
    apply();
  } else {
    Object.assign(shadow, await load(shadow, `?close=${Date.now()}`));
    shadow.discussion = { name: d.name, title: d.name, dir, continued: true };
    shadow.state.briefing = briefing(shadow);
  }
  return shadow;
}

async function closeNamedDiscussion(ctx, name) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name);
  if (!d) return note(ctx, `✗ No discussion "${name}".`, true);
  const shop = shopOf(ctx), closing = shop.closing ??= new Map();
  if (closing.has(d.name)) return note(ctx, `✗ ${d.name} is already closing.`, true);
  if (closedDiscussions(ctx).includes(d.name)) return note(ctx, `✗ ${d.name} is already closed.`, true);
  const opened = siblings(ctx).find((c) => !c.stopped && isDiscussion(c, d.name));
  const c = { waiting: true, cancelled: false, wake: null };
  closing.set(d.name, c);
  showHeader(ctx);
  try {
    const tasks = [...runningTasks(shop), ...queuedTasks(shop)].filter((t) => t.owner === d.name && t.finished);
    let finished = !tasks.length;
    Promise.all(tasks.map((t) => t.finished)).then(() => { finished = true; c.wake?.(); });
    const pending = () => [...runningTasks(shop), ...queuedTasks(shop)].some((t) => t.owner === d.name);
    while ((!finished || pending()) && !c.cancelled) await new Promise((resolve) => { c.wake = resolve; setTimeout(resolve, 100); });
    c.wake = null;
    if (c.cancelled) return note(ctx, `Close cancelled for ${d.name}.`);
    if (ctx.stopped || opened?.stopped) throw new Error('The room stopped while Close was waiting.');
    c.waiting = false;
    showHeader(ctx);
    const target = opened ?? await closingContext(ctx, d);
    const hold = workerHold(target);
    if (hold) throw new Error(`This can't be closed yet: ${hold}.`);
    if (target.checkpointError) throw new Error(`The latest checkpoint could not be saved: ${target.checkpointError}`);
    const reports = shop.log.filter((m) => m.owner === d.name && m.speaker).map((m) => `${m.speaker}: ${m.html ?? m.text ?? ''}`).join('\n\n');
    // Written by the worker's provider and model as set for this discussion, not by its discussion
    // agents (`closingAgent`: a stand-in for tests).
    if (!target.closingStatement) throw new Error('No agent is available to write the closing statement: Reload or Restart, then close again.');
    const statement = await target.closingStatement({ dir: target.discussion.dir, workerReports: reports }, target.closingAgent?.());
    const file = join(target.discussion.dir, 'closing-statement.md');
    const temp = `${file}.${process.pid}.tmp`;
    const previous = existsSync(file) ? readFileSync(file) : null;
    const checkpoint = readCheckpoint(ctx, d.name);
    const sessions = [...(target.sessions?.values() ?? [])].map((s) => [s, { ...s }]);
    let snapshot, markedClosed = false;
    try {
      writeFileSync(temp, statement + '\n');
      // CLI calls run one process per turn; the worker and closing turns have returned. Drop their
      // provider IDs without stopping another discussion's detached worker in this context.
      for (const [session] of sessions) for (const key of Object.keys(session)) delete session[key];
      if (checkpoint?.invalid) throw new Error('The discussion checkpoint is invalid.');
      if (checkpoint) writeCheckpoint(ctx, d.name, { ...checkpoint, sessions: [], closedSessions: true });
      renameSync(temp, file);
      if (target.replica) {
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
      if (previous === null) { if (existsSync(file)) unlinkSync(file); }
      else writeFileSync(file, previous);
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
        endSession(target, 'closing the discussion', (agent) => note(ctx, `${agent.name}'s ended session was reset for a new discussion.`));
        switchTo(target, null);
      }
    }
    note(ctx, `Closed ${d.name}.`);
    if (snapshot) saveClosed(ctx, target, snapshot);
  } catch (err) {
    note(ctx, `✗ Could not close ${d.name}: ${err.message}`, true);
  } finally {
    closing.delete(d.name);
    showHeader(ctx);
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
      finally { lane.running = null; }
      // After it: edits left uncommitted hold the lane; a recovery keeps the first task's details.
      try {
        const dirty = place.disabled ? false : await leftovers(t.origin, place);
        // Its own discussion's: the task's owner and label, not the discussion the context shows now.
        if (dirty === true) { if (!lane.blockedBy) hold(t.origin, { origin: t.origin, owner: t.owner, label: t.label, task: t.text, before: t.before, place }); }
        else if (dirty === false && lane.blockedBy) release(t.origin, lane);
      } catch (err) { note(t.origin, `✗ ${err.message}`, true); }
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
const BLOCK_LABEL = /^\s*(?:[-*]\s+)?(?:\*\*)?Send to the Worker:(?:\*\*)?\s*$/i;
const QUOTED = /^\s*>/;
export function summaryInstruction(summary) {
  const lines = String(summary ?? '').split('\n');
  const start = lines.findIndex((l) => /^[\s*_#-]*Next step[\s*_:]*$/i.test(l));
  if (start < 0) return /Send to the Worker:/i.test(summary ?? '') ? { error: 'its "Send to the Worker" line isn\'t under a Next step heading' } : null;
  let end = lines.findIndex((l, i) => i > start && (/^\s*\*\*[^*]+\*\*[\s:]*$/.test(l) || /^[\s*_]*Outcome:/i.test(l)));
  if (end < 0) end = lines.length;
  const sectionLines = lines.slice(start + 1, end);
  // Block-quoted instructions: each label line and the quote lines that follow it.
  const blocks = [];
  sectionLines.forEach((l, i) => {
    if (!BLOCK_LABEL.test(l)) return;
    let j = i + 1;
    while (j < sectionLines.length && !sectionLines[j].trim()) j++;
    const from = j;
    while (j < sectionLines.length && QUOTED.test(sectionLines[j])) j++;
    if (j > from) blocks.push({ label: i, from, to: j });
  });
  const inBlock = (i) => blocks.some((b) => i === b.label || (i >= b.from && i < b.to));
  const section = sectionLines.filter((l, i) => !inBlock(i)).join('\n');
  const opening = /Send to the Worker:\s*["“]/g;
  const marks = section.match(opening)?.length ?? 0;
  if (marks + blocks.length > 1) return { error: 'its Next step holds more than one instruction for the worker' };
  if (blocks.length) {
    const b = blocks[0];
    if (sectionLines.slice(b.to).some((l) => QUOTED.test(l))) return { error: 'its block-quoted instruction is broken by lines that aren\'t quoted' };
    const text = sectionLines.slice(b.from, b.to).map((l) => l.replace(/^\s*> ?/, '')).join('\n').trim();
    return text ? { text } : { error: 'its block-quoted instruction is empty' };
  }
  if (!marks) return /Send to the Worker/i.test(section) ? { error: 'its Next step has no quoted instruction (Send to the Worker: "…", or the label alone followed by a > block quote)' } : null;
  const after = section.slice(section.search(opening)).replace(/^Send to the Worker:\s*["“]/, '');
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
function latestAgreed(ctx) {
  const t = ctx.state.transcript;
  for (let i = t.length - 1; i >= 0; i--) if (t[i].outcome === 'agreed') return { index: i, instruction: summaryInstruction(t[i].text), steps: summarySteps(t[i].text) };
  return null;
}
// What the page offers: the latest agreed summary's instruction, unless it was sent (or a run is
// going, or this is no saved discussion): { text } with a Start or Restart button, or { error }.
function autoDevOffer(ctx) {
  if (!ctx.logPath || ctx.state.brainstorm || ctx.autoDev?.status === 'running') return null;
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
    : !ctx.logPath ? 'it needs a started discussion'
    : !ctx.say ? 'it works from the browser screen'
    : ctx.autoDev?.status === 'running' ? 'it is already running'
    : ctx.screen.workerInfo?.disabled ? ctx.screen.workerInfo.lines[0]
    : !s ? 'there is no agreed summary yet'
    : (ctx.autoDevSent ?? []).includes(s.index) ? 'the latest agreed summary\'s instruction was already sent'
    : !s.instruction ? 'the latest agreed summary has no instruction for the worker'
    : s.instruction.error ?? null;
  if (why) return note(ctx, `✗ Auto dev can't start: ${why}.`, true);
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
  hub.checkLogins = (all) => checkLogins(hub, all).catch(() => {});
  hub.checkLeftovers = () => checkLeftovers(hub).catch(() => {});
  ctx.showMonitor = () => showMonitor(ctx);
  if (!hub.monitorTimers) {
    hub.monitorTimers = [setInterval(() => hub.checkLogins(true), LOGIN_EVERY_MS).unref(),
      setInterval(() => hub.checkLeftovers(), LEFTOVERS_EVERY_MS).unref()];
    hub.checkLeftovers();
  }
  hub.checkLogins(false); // this room's providers not checked yet
}
// Every provider in use on the server (all), or only those not checked yet. null: being checked.
async function checkLogins(hub, all) {
  const rooms = loadedRooms(hub);
  const providers = [...new Set(rooms.flatMap(providersOf))].filter((p) => all || !(p in hub.monitor.login));
  if (!providers.length) return;
  for (const p of providers) if (!(p in hub.monitor.login)) hub.monitor.login[p] = null;
  await Promise.all(providers.map(async (p) => {
    hub.monitor.login[p] = { ...await rooms[0].usage.checkLogin(p), checked: new Date().toISOString() };
  }));
  for (const r of loadedRooms(hub)) showMonitor(r);
}
async function checkLeftovers(hub) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  const tracked = new Set(rooms.flatMap((r) => [...(r.programs?.running ?? [])].map((p) => p.pid)));
  hub.monitor.leftovers = await rooms[0].findLeftovers(tracked);
  for (const r of loadedRooms(hub)) showMonitor(r);
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
    view[p] = { login: hub.monitor?.login[p] ?? null, running: running.filter((r) => r.provider === p).length,
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
  if (command === 'pause') return 'Pause is gone: every discussion saves itself after each round, and Resume continues it where it stopped.';
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
  if (line === '/new') return multi(ctx) ? newDiscussionBeside(ctx) : newDiscussion(ctx);
  if (line === '/brainstorm') return multi(ctx) ? newBrainstormBeside(ctx) : newBrainstorm(ctx);
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
    if (failure && failure.owner === ownerOf(ctx)) ctx.state.transcript.push(failure.message);
    return;
  }
  const rollback = /^\/rollback\s+(\S+)$/.exec(line);
  if (rollback) return requestRollback(ctx, rollback[1]);
  const archiveRollback = /^\/archive-rollback\s+(\S+)$/.exec(line);
  if (archiveRollback) return confirmRollbackArchive(ctx, archiveRollback[1]);
  const move = /^\/move\s+(\S+)\s+(\S+)$/.exec(line);
  if (move) return void await moveDiscussion(ctx, move[1], move[2]);
  if (line === '/summary') {
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
  let started = 0;
  let turns = 0;
  let used;
  log(ctx, auto ? '_(auto-summary)_\n\n' : '_(summary requested)_\n\n');
  ctx.busy = true;
  const { status, result } = await ctx.room.summary({ extra,
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
  }).finally(() => { ctx.busy = false; });
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

// `speaker`: who the opening message is from (the User, or auto dev's "Worker report"). `run`: the
// auto dev run this round belongs to: it is always summarized, and the summary decides what's next.
async function runRound(line, ctx, { speaker = 'User', run = null } = {}) {
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  let roundUsage;
  let spoke = 0; // agent replies that weren't passes or failures
  try {
    ctx.busy = true;
    workNotice(ctx);
    await ctx.room.round(line, { speaker,
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
        if (m.error) ending = `${m.speaker} failed`;
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
    const secs = Math.round((Date.now() - roundStart) / 1000);
    const providers = [...new Set(ctx.room.agents.map((a) => a.provider))];
    const quota = ctx.usage.quotaSummary(await refreshQuota(ctx).catch(() => null), providers);
    const parts = [ending, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(roundUsage), quota];
    // A failed turn pauses auto dev; otherwise its round is always summarized, to decide what's next.
    const deciding = run && ctx.autoDev === run && run.status === 'running';
    if (deciding && ending.endsWith('failed')) pauseAutoDev(ctx, ending);
    // Auto-summarize (always on in discussions, not in brainstorms): after a round in which an agent
    // spoke and none failed. Its own end line is then the "your turn" one; this round's line is just a note.
    if (!ctx.state.brainstorm && (spoke || deciding) && !ending.endsWith('failed')) {
      out(ctx, dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      const summary = await runSummary(ctx, true, deciding ? autoDevTask(run) : undefined);
      captureRound(ctx);
      if (deciding) decide(ctx, run, summary);
      return;
    }
    out(ctx, dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
    toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
    captureRound(ctx);
  } catch (err) {
    // An unknown @name: nothing was sent or recorded.
    note(ctx, `✗ ${err.message}`, true);
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
async function ignoreNotes(place) {
  const file = await git(place.path, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim().replace(/^\/|\/$/g, '') === NOTES)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${NOTES}/\n`);
}

// The worktree compared with the room: whether it exists, the room's HEAD, commits on each side,
// the commit it's based on, and uncommitted changes (the room's outside discussions/, the worktree's).
export async function worktreeStatus(place) {
  const head = await git(place.top, 'rev-parse', 'HEAD');
  const roomDirty = (await git(place.root, 'status', '--porcelain', '--', '.', ':(exclude)discussions', ':(exclude).agent-room')) !== '';
  const exists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === real(place.path) && w.branch === place.branch);
  if (!exists) return { exists, head, roomDirty };
  const count = async (range) => Number(await git(place.top, 'rev-list', '--count', range));
  const [ahead, behind, base, dirty] = await Promise.all([count(`HEAD..${place.branch}`), count(`${place.branch}..HEAD`),
    git(place.top, 'merge-base', 'HEAD', place.branch).then((sha) => sha.slice(0, 7), () => 'no common commit'),
    git(place.path, 'status', '--porcelain').then((out) => out !== '')]);
  const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
  const operation = existsSync(join(privateDir, 'MERGE_HEAD')) ? 'merge' :
    existsSync(join(privateDir, 'REVERT_HEAD')) || existsSync(join(privateDir, 'sequencer')) ? 'revert/sequencer' : null;
  return { exists, head, roomDirty, ahead, behind, base, treeDirty: dirty || !!operation, operation };
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
export async function refreshWorker(ctx, { prepare = false, fastForward = true, place = null } = {}) {
  place ??= await lanePlace(ctx, laneOf(ctx));
  if (prepare && !place.disabled) {
    try {
      await ensureWorktree(place); await ignoreNotes(place);
      let s = await worktreeStatus(place);
      if (fastForward) s = await catchUp(place, s);
      (ctx.workerDir ??= { path: null }).path = s.exists ? place.cwd : null;
    } catch (err) {
      const info = { lines: [`✗ ${err.message}`], error: true };
      for (const c of siblings(ctx)) if (c.screen) { c.screen.workerInfo = info; toScreen(c, { type: 'workerinfo', info }); }
      throw err;
    }
  }
  const seen = new Map(); // each lane's lines, computed once for all the open discussions
  for (const c of siblings(ctx)) {
    if (!c.screen) continue;
    const info = await workerInfo(c, seen, c === ctx && !prepare ? place : null);
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
  // A lane's lines, a one-line summary for the page, and whether it has something to review:
  // { lines, summary, review }, with `pending` when it has: its discussion (lane; null for
  // worker/main), branch, commits not in main and uncommitted edits, for the Discussions tab.
  const of = (place) => {
    if (!seen.has(place.path)) seen.set(place.path, (async () => {
      const s = await worktreeStatus(place);
      const checks = s.exists ? await laneChecks(place) : { lines: [], brief: [] };
      return { lines: [...worktreeLines(place, s), ...checks.lines], summary: laneSummary(place, s, checks.brief), review: !!(s.ahead || s.treeDirty),
        pending: { lane: place.lane ?? null, branch: place.branch, ahead: s.ahead || 0, dirty: !!s.treeDirty } };
    })());
    return seen.get(place.path);
  };
  try {
    const mine = await of(own);
    const lines = [...mine.lines], lanes = [{ ...mine, own: true }];
    if (!seen.has('lanes')) seen.set('lanes', existingLanes(ctx));
    for (const other of await seen.get('lanes')) {
      if (other.path === own.path) continue;
      const o = await of(other);
      if (o.review) { lines.push(...o.lines); lanes.push(o); }
    }
    return { lines, lanes: lanes.map(({ lines, summary, own }) => ({ lines, summary, own: !!own })),
      pending: lanes.filter((l) => l.review).map((l) => l.pending) };
  } catch (err) { return { lines: [`✗ ${err.message}`], error: true }; }
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
// The worker's last "Tested: <branch commit> with main <main commit>: tests passed|failed" line, if
// Git agrees: the branch commit is on its branch, it contains the main commit, which is main's.
async function recordTested(ctx, place, text, owner, label) {
  const m = [...String(text).matchAll(/^Tested: ([0-9a-f]{7,64}) with main ([0-9a-f]{7,64}): tests (passed|failed)\.?$/gm)].at(-1);
  if (!m) return;
  try {
    const main = await mainRef(place.top);
    const id = (ref) => git(place.path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`).catch(() => { throw new Error(`${ref} is not a commit here`); });
    const [branch, mainId] = [await id(m[1]), await id(m[2])];
    if (!await gitOk(place.path, 'merge-base', '--is-ancestor', branch, 'HEAD')) throw new Error(`${m[1].slice(0, 7)} is not on ${place.branch}`);
    if (!await gitOk(place.path, 'merge-base', '--is-ancestor', mainId, branch)) throw new Error(`${m[1].slice(0, 7)} doesn't contain ${m[2].slice(0, 7)}`);
    if (!await gitOk(place.path, 'merge-base', '--is-ancestor', mainId, main)) throw new Error(`${m[2].slice(0, 7)} is not a commit of ${main}`);
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
    queueWork(ctx, failure.text, failure.run, failure.rollback, failure);
  } catch (err) {
    if (ctx.retryFailure === failure) failure.available = true;
    showHeader(ctx);
    throw err;
  }
}

export const BRAINSTORM_NO_WORK = 'Turn this brainstorm into a discussion to send work.';
export function queueWork(ctx, text, run = null, rollback = null, retry = null) {
  if (ctx.state.brainstorm) return note(ctx, `✗ ${BRAINSTORM_NO_WORK} The instruction was not sent.`, true);
  if (ctx.discussion && shopOf(ctx).closing?.has(ctx.discussion.name)) return note(ctx, '✗ This discussion is closing; the instruction was not sent.', true);
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  if (ctx.stopped) return note(ctx, 'This room is ending: the instruction was not sent.', true);
  ctx.agentsStarted = true;
  const shop = shopOf(ctx);
  let done;
  const finished = new Promise((r) => { done = r; });
  // Recorded in its discussion's checkpoint (see "Work in flight"); a brainstorm sends none (see BRAINSTORM_NO_WORK).
  const workName = ctx.discussion && !ctx.state.brainstorm ? ctx.discussion.name : null;
  const record = workName ? { id: randomBytes(6).toString('hex'), task: text, at: new Date().toISOString() } : null;
  shop.sent = (shop.sent ?? 0) + 1; // the order sent, across lanes: one worker session's tasks keep it
  const task = { origin: ctx, text, run, cycle: retry?.cycle ?? run?.cycle, done, finished, rollback, retry, record, workName, lane: workName, sent: retry?.sent ?? shop.sent, worker: ctx.worker, owner: ownerOf(ctx), label: originLabel(ctx) };
  const tasks = laneState(shop, workName).tasks;
  if (retry) { const i = tasks.findIndex((t) => t.sent > retry.sent); tasks.splice(i < 0 ? tasks.length : i, 0, task); }
  else tasks.push(task);
  if (record) { const queued = workOf(shop, workName).queued; if (retry) queued.unshift(record); else queued.push(record); persistWork(ctx, workName); }
  ctx.workPending = (ctx.workPending ?? 0) + 1;
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
  const own = seat ?? { briefed: ctx.workerBriefed, tree: ctx.workerTree, label: ctx.workerLabel, handoff: ctx.workerHandoff, brainstorm: !!ctx.state.brainstorm };
  const shop = shopOf(ctx), screen = ctx.screen, label = t?.label ?? (seat ? seat.origin : originLabel(ctx)), owner = t?.owner ?? ownerOf(ctx);
  // First of all: its discussion's checkpoint records it as running (see "Work in flight").
  const record = t?.record, work = record ? workOf(shop, t.workName) : null;
  if (record) {
    work.queued = work.queued.filter((r) => r.id !== record.id);
    work.running = { ...record, at: new Date().toISOString(), before: null, lane: lane?.lane ?? null };
    persistWork(ctx, t.workName);
  }
  // Tasks of this discussion interrupted earlier: the worker is told once, with this one.
  const told = work ? [...work.interrupted] : [];
  if (!rollback && recovery && shop.rollbacks?.get(label)?.task === recovery.task) rollback = shop.rollbacks.get(label);
  if (rollback) { rollback.status = 'running'; showHeader(ctx); }
  let before = null, mainAtStart = null, leftUsage = null;
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
    let entry;
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
      const d = task.discussion;
      // A brainstorm has no folder: it is told so once.
      const brief = d && own.briefed !== d.dir
        ? `The active discussion's folder is ${d.dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in your worktree, ${place.cwd}.\n\n`
        : !d && own.brainstorm && own.briefed !== 'brainstorm'
          ? 'These instructions come from a brainstorm, which has no folder: keep your notes in your scratch folder only.\n\n'
        : !d && own.briefed && own.briefed !== 'brainstorm'
          ? `No discussion is active now: ${own.briefed} is no longer the active discussion's folder. You will be told the next one's folder once it exists.\n\n`
          : '';
      // And where it works, with its first instruction (again if that changes: a saved session that
      // worked in the shared worktree before lanes, or a context moving between lanes, is told so).
      const moved = own.tree && own.tree !== place.cwd
        ? `Your worktree has changed: until now you worked in ${own.tree}; from now on you work in ${place.cwd}, on the branch ${place.branch}. Leave ${own.tree} alone from now on: it is another lane's. `
        : '';
      const tree = own.tree !== place.cwd
        ? `${moved}Your working directory is ${place.cwd}, your own Git worktree of the project, on the branch ${place.branch}. Make your changes there, never in the room's root, ${ctx.cwd}: that is the User's working copy (only the discussion folder there is yours, for notes). Commit every completed task on ${place.branch}, labelled as each instruction says, and give the commit ID in your reply; the User reviews and merges it into main. Your scratch notes go in ${join(place.path, NOTES)}/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted". Plans and notes for the User's review still go in the discussion's folder.\n\n`
        : '';
      // Its origin's label for the commit, once per worker session (again if it changes); a recovery
      // task also gets the first task's details.
      const commit = own.label === label ? '' : `These instructions come from [${label}]. When a task is complete, commit it on ${place.branch} with a message starting "[${label}]" and give the commit ID in your reply.\n\n`;
      const leftover = recovery
        ? `Uncommitted edits are left in your worktree from the earlier task from [${label}] "${recovery.task}"${recovery.before ? ` (${place.branch} was at ${recovery.before.slice(0, 7)} when it started)` : ''}: this discussion's next worker tasks wait until they are resolved. Finish and commit them; or, to abandon the attempt, first list exactly the edits you would remove and wait for the User's explicit approval, then remove only those. Inspect and resolve any merge or revert already in progress before further work; never force it or start a fresh operation over it.\n\n`
        : '';
      const mainBehind = owedMain || !recovery && await gitOk(place.path, 'rev-parse', '--verify', 'main^{commit}') &&
        Number(await git(place.path, 'rev-list', '--count', 'HEAD..main')) > 0;
      const merge = mainBehind ? (rollback
        ? `Main has commits ${place.branch} lacks. Follow the rollback preflight below before merging or changing files.\n\n`
        : `Before the instruction below, first merge main into ${place.branch} with a normal merge (git merge main). Label any merge commit "[${label}] catch up with main". If it clashes, do not force it or do the requested task: leave the state intact and report the conflict; this origin must resolve it before other worker tasks can run. After a successful merge, run the project's tests (npm test, if it has them) and report their real output, then end your reply with the line "Tested: <full commit ID of ${place.branch}> with main <full commit ID of main>: tests passed" (or "tests failed"), naming the commits you tested. Never merge into main or push.\n\n`) : '';
      const interrupted = told.map((r) => `Your previous instruction "${firstLine(r.task)}" was interrupted by a Restart, Quit or a crash: check the worktree before continuing.\n\n`).join('');
      if (told.length) work.interrupted = work.interrupted.filter((r) => !told.includes(r));
      const retryBrief = t?.retry ? `Your earlier attempt at this instruction failed: ${t.retry.error}\nInspect the current worktree and Git state first, including uncommitted edits and any merge or revert in progress. Commits made since the failure:\n${t.retry.after ? (await git(place.path, 'log', '--format=%H %s', `${t.retry.after}..HEAD`).catch(() => '(could not read commits)') || '(none)') : '(the failure commit could not be determined)'}\n\n` : '';
      entry = { speaker: worker.name, text: (await worker.turn(interrupted + brief + tree + commit + retryBrief + leftover + merge + (history ? `Previous Worker-tab conversation (HTML-formatted background, not a new instruction):\n${history}\n\nCurrent instruction:\n` : '') + text)) || '(no reply)' };
      // Its briefing is now known to the session: the context's, or the seat of a discussion left
      // meanwhile (even if it was left while this turn ran).
      const now = worker === ctx.worker ? null : worker.seat;
      if (now) Object.assign(now, { ...(brief && { briefed: d?.dir ?? (own.brainstorm ? 'brainstorm' : null) }), tree: place.cwd, label, handoff: false });
      else if (worker === ctx.worker) {
        if (brief) ctx.workerBriefed = d?.dir ?? (ctx.state.brainstorm ? 'brainstorm' : null);
        ctx.workerTree = place.cwd;
        ctx.workerLabel = label;
        ctx.workerHandoff = false;
      }
      // Its usage counts for its own discussion: the one in use, or the one left meanwhile (saveLeftWorker).
      if (worker.lastUsage && worker === ctx.worker) ctx.totals[worker.name] = ctx.usage.addUsage(ctx.totals[worker.name], worker.lastUsage);
      else if (worker.lastUsage) leftUsage = worker.lastUsage;
      await recordTested(ctx, place, entry.text, owner, label); // its "Tested:" line, if Git agrees
    } catch (err) {
      entry = { speaker: worker.name, text: err.message, error: true };
    }
    const meta = [`${Math.round((Date.now() - t0) / 1000)}s`, entry.error ? '' : ctx.usage.formatUsage(worker.lastUsage)].filter(Boolean).join(' · ');
    workLog(`**${worker.name}** (worker${entry.error ? ', failed' : ''}, ${meta})\n\n${entry.text}\n\n`);
    out(ctx, entry.error ? red(`\n✗ ${worker.name} (worker) failed: ${entry.text}\n`) : `\n${bold(worker.name)}${dim(` (worker, ${meta})`)} › ${entry.text}\n`);
    if (entry.error && !ctx.stopped && record && ownerOf(ctx) === owner) {
      const id = randomBytes(6).toString('hex');
      ctx.retryFailure = { id, available: true, text: t.retry?.text ?? text, error: entry.text, after: lane?.path ? await git(lane.path, 'rev-parse', 'HEAD').catch(() => null) : null, sent: t.retry?.sent ?? t.sent, cycle, run, rollback };
      entry.retryId = id;
    }
    show(entry, meta);
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
      // Stopped by Quit or Restart: kept as interrupted, to report on Resume.
      if (ctx.stopped && entry.error) work.interrupted.push(work.running);
      work.running = null;
      persistWork(ctx, t.workName);
    }
    if (rollback) await rollbackReport(ctx, rollback, entry, worker === ctx.worker ? null : worker.seat);
    if (run && ownerOf(ctx) === owner) reportBack(ctx, run, entry, !!t?.retry);
  } finally {
    if (ctx.workingIn) shop.writing.delete(ctx.workingIn);
    ctx.workingIn = null;
    working(null);
  }
  // Its worker session and briefing, in its own discussion's checkpoint: the one in use, or the one
  // left meanwhile (saveLeftWorker).
  if (worker === ctx.worker) saveCheckpoint(ctx); else if (worker.seat) saveLeftWorker(ctx, worker, leftUsage);
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
    for (const { snapshot } of closedEntries(ctx)) {
      if (snapshot && lines[snapshot.discussion]?.commit !== snapshot.commit) await R.publishCapture(r.s, snapshot);
    }
  }
  r.canSend = (name) => !r.state.reopening?.has(name) && !shopOf(ctx).closing?.has(name) && closedDiscussions(ctx).includes(name);
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
