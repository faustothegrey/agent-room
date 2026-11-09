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
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: agent-room [--agents claude,codex] [--worker claude:Worker] [--cwd DIR] [--port 5566] [--no-screen] [--open] [--reopen NAME] [--dev]
                  [--node NAME [--peer NAME=http://ADDRESS:PORT ...]]

Each agent is provider[:name[:model]], e.g. --agents claude:Ada:opus,codex:Linus
Without saved defaults: discussion claude,codex; worker claude:Worker.
The provider/model sections in the Discussion and Worker tabs save changes automatically to
~/.config/agent-room/defaults.json. CLI flags override the corresponding defaults for this launch.
Worker changes apply to the next instruction. Discussion changes apply before work starts;
after that they set defaults for future rooms.
The worker (the screen's Worker tab) is one more agent, outside the discussion: it carries out the
instructions sent from that tab, sees only those (and the active discussion's folder, for its
notes), and can edit files and run commands. It works in its own Git worktree of the room's
repository (<repo>.worker/, branch worker/main), created at its first instruction; you review and
merge its work. Without a Git repository the worker is disabled.
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
/reopen <name> (or --reopen <name> at launch) picked an existing one first.
Type a message to start a round; start it with @name to address one agent.
Commands: /pause (save discussion and worker sessions locally), /resume <name> (continue a saved session),
/docs (pick a document to view in the browser), /reopen <name> (re-open that
discussion: a fresh session there, starting from its handoff; one in archive/ or deferred/ is made
active first), /new (end this session; your next message starts a new discussion; the worker
carries on), /brainstorm (New brainstorm: a conversation kept only in memory, with no folder or
transcript; it ends this session as /new does, and a new one, /new, /reopen or /resume ends it), /move <name> active|archive|deferred (move a whole discussion; not the one in use),
/rollback <name> (queue archive with rollback), /archive-rollback <name> (confirm archive after reviewing its report),
/autodev (screen only: Start auto dev, relaying the latest agreed summary's worker instruction
and the worker's reports, for up to 5 worker cycles), /summary (the agents agree a short
summary by points; only the result is shown), /autosummary [on|off] (a summary after every round
in which an agent spoke; on by default), /usage (tokens this session and subscription quotas),
/reload (load edited code and both agent rulebooks, in every room; conversations continue), /restart
(screen only: a new process on the same port, with every room, each in its discussion in use, from
its handoff), /quit (Quit room: ends this room only, after its round in progress or at most 30s,
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
    if (!a || !['claude', 'codex'].includes(a.provider)) throw new Error('Choose Claude or Codex.');
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
export function modelChoices() {
  // Codex maintains this catalog itself; unavailable catalogs still allow a custom model ID.
  let codex = [];
  try {
    const cache = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = cache.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch {}
  return { claude: ['opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })), codex };
}
export async function saveSettings(ctx, value, file = defaultsFile()) {
  if (ctx.paused || ctx.pausing) throw new Error('Resume the discussion before changing agent settings.');
  const settings = validateSettings(value);
  const next = { ...ctx, agentSpecs: settings.agents.map(specFor).join(','), workerSpec: specFor(settings.worker), sessions: new Map(), state: { ...ctx.state, seen: new Map(ctx.state.seen) } };
  // Build first so validation/loading errors cannot replace defaults or the running room.
  const applied = !ctx.agentsStarted && !ctx.logPath && !ctx.state.transcript.length && !ctx.screen.worker.length;
  const workerChanged = next.workerSpec !== ctx.workerSpec;
  const previous = parseSpec(ctx.workerSpec, true);
  const freshWorker = previous.provider !== settings.worker.provider || previous.name !== settings.worker.name;
  // The worker is one, shared by the folder's open discussions: its provider and model are one
  // setting for all of them. Its name must differ from the running discussion agents in every one,
  // checked before anything changes: a clash rejects the change for the whole room.
  const taken = (c) => c.room.agents.some((a) => a.name.toLowerCase() === settings.worker.name.toLowerCase());
  if (!applied && taken(ctx)) throw new Error('The worker needs a different name from the running discussion agents.');
  const others = workerChanged ? siblings(ctx).filter((c) => c !== ctx && c.room && c.workerSpec !== next.workerSpec) : [];
  const clash = others.find(taken);
  if (clash) throw new Error(`The worker needs a different name from the discussion agents in every open discussion: [${originLabel(clash)}] has an agent named ${settings.worker.name}. Nothing was changed.`);
  if (!applied) {
    next.sessions = new Map(ctx.sessions);
    if (freshWorker) next.sessions.set(`worker:${settings.worker.name}`, {});
  }
  const loaded = await load(next, '');
  // Every other open discussion's worker, built before anything is applied (each keeps its own
  // worker session, a fresh one if the provider changed).
  const built = [];
  for (const c of others) {
    const sessions = new Map(c.sessions);
    if (freshWorker) sessions.set(`worker:${settings.worker.name}`, {});
    built.push([c, await load({ ...c, workerSpec: next.workerSpec, sessions }, ''), sessions]);
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  const useWorker = (c, built, sessions) => {
    c.worker = built.worker;
    c.workerSpec = next.workerSpec;
    c.sessions.set(`worker:${settings.worker.name}`, sessions.get(`worker:${settings.worker.name}`));
    if (freshWorker) {
      c.workerBriefed = null;
      c.workerTree = null;
      c.workerLabel = null;
      c.workerHandoff = true;
    }
  };
  if (applied) {
    Object.assign(ctx, loaded, { agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, sessions: next.sessions, state: next.state });
    wire(ctx);
  } else if (workerChanged) useWorker(ctx, loaded, next.sessions);
  for (const [c, b, sessions] of built) useWorker(c, b, sessions);
  showHeader(ctx);
  return { applied, workerApplied: true, settings };
}

// Imports fresh copies of the modules and the two rulebooks and builds a room on ctx.state, and the worker. Returns
// the parts to put into ctx; if anything fails it throws, leaving ctx as it was (at most an
// unused empty session added).
export async function load(ctx, v) {
  if (!ctx.agentSpecs || !ctx.workerSpec) {
    const saved = readDefaults();
    ctx.agentSpecs ??= saved ? saved.agents.map(specFor).join(',') : 'claude,codex';
    ctx.workerSpec ??= saved ? specFor(saved.worker) : 'claude:Worker';
  }
  const instructions = readFileSync(new URL('../README-for-brainstorming-agents.md', import.meta.url), 'utf8');
  const workerInstructions = readFileSync(new URL('../README-for-worker-agents.md', import.meta.url), 'utf8');
  const { createAgent, claudeTitle, run } = await import(`./agents.mjs${v}`);
  const { createRoom } = await import(`./room.mjs${v}`);
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
  const runner = (command, args, options) => (programs.stopping
    ? Promise.reject(new Error('not started: the room is quitting'))
    : run(command, args, { ...options, procs: programs.running }));
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
  // Its worktree (see refreshWorker), shared by reference so it survives reloads and settings copies.
  const workerDir = ctx.workerDir = shop?.workerDir ?? ctx.workerDir ?? { path: null };
  const worker = createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions, shell: true,
    timeoutMs: WORKER_TIMEOUT_MS, runner, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: shop?.log ?? [], working: shop?.running ? shop.running.origin.worker.name : null };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, replicate, totals: ctx.totals ?? {}, screen,
    shop: shop ?? newShop(workerDir, screen.worker),
    suggestTitle: (message, options) => claudeTitle(message, { ...options, runner }) };
}

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
// Until the discussion's folder exists (at the first message), the transcript is kept in memory.
// A brainstorm (ctx.state.brainstorm) keeps no record at all.
const log = (ctx, text) => {
  if (ctx.logPath) appendFileSync(ctx.logPath, text);
  else if (!ctx.state?.brainstorm) ctx.pendingLog = (ctx.pendingLog ?? '') + text;
};
const describe = (room) => room.agents.map((a) => `${a.name} (${a.provider})`).join(', ');
const when = (d) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// Points the screen at the code loaded now (at start and after each reload): the header's names and,
// in UI mode, the Worker tab's input.
function wire(ctx) {
  ctx.screen.room = header(ctx);
  ctx.screen.sections = ['discussions'];
  ctx.screen.auto = autoOn(ctx);
  // With --node only the launch room replicates: its Peers panel works, the others' says why.
  ctx.screen.replicaOff = ctx.hub?.node && !ctx.node ? replicaOff(ctx) : null;
  if (ctx.replica) wireReplica(ctx); // its peer endpoint works in terminal mode too
  if (ctx.noScreen) return;
  // What the User types pauses a running auto dev (as it arrives, not when its turn comes).
  ctx.screen.work = (text) => { autoDevInput(ctx, 'you sent the Worker an instruction'); return queueWork(ctx, text); };
  ctx.screen.say = (line, confirmed) => {
    if (!line.trim().startsWith('/')) autoDevInput(ctx, 'you sent a message');
    // Quit room closes every discussion open in this folder.
    if (line.trim() === '/quit') for (const c of siblings(ctx)) if (c !== ctx) c.say?.('/quit');
    return ctx.say(line, confirmed);
  };
  // The screen's checkbox: applied at once, not queued behind a round, so it can stop the next summary.
  ctx.screen.setAuto = (on) => setAuto(ctx, on);
  ctx.screen.newRoom = (body) => newRoom(ctx, body);
  ctx.screen.listRooms = async () => listRooms(ctx);
  ctx.screen.getSettings = () => ({ settings: currentSettings(ctx), defaults: readDefaults(), models: modelChoices(), started: !!ctx.agentsStarted || !!ctx.logPath || !!ctx.state.transcript.length || !!ctx.screen.worker.length });
  ctx.screen.saveSettings = (value) => saveSettings(ctx, value);
}

// The screen's header: the full root path, the active discussion (active: its folder, under the
// root), and whether this session has started (its first message sent, so its discussion is fixed).
function header(ctx) {
  const d = ctx.discussion;
  return { folder: ctx.cwd, agents: ctx.room.agents.map((a) => a.name), worker: ctx.worker.name,
    discussion: d ? d.title : ctx.state.brainstorm ? 'Brainstorm' : 'No discussion started',
    active: d ? `discussions/${d.name}` : null, started: !!ctx.logPath || !!ctx.state.brainstorm,
    brainstorm: !!ctx.state.brainstorm, // a conversation kept only in memory (see newBrainstorm)
    autoDev: autoDevView(ctx),
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null,
    paused: !!ctx.paused, pausedSessions: pausedSessions(ctx),
    back: ctx.previous ?? null, // the discussion before the last switch, until the next one starts
    code: ctx.code ?? null, // the version this process runs (see codeInfo)
    rollbacks: [...(shopOf(ctx).rollbacks?.values() ?? [])].map(({ name, status, report, commit }) => ({ name, status, report, commit })),
    multi: multi(ctx), open: openList(ctx) }; // the folder's open discussions (see openList)
}
// Every page of the folder's open discussions: they list each other.
function showHeader(ctx) {
  for (const c of siblings(ctx)) {
    if (!c.room || !c.worker) continue; // still loading
    c.screen.room = header(c);
    toScreen(c, { type: 'room', room: c.screen.room });
  }
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
  const target = to === 'active' ? null : to;
  if (to !== 'active' && !SECTIONS.includes(to)) return note(ctx, '✗ Move it to active, archive or deferred.', true), null;
  if (d.section === target) return { name: d.name }; // already there
  await recoverWorkerOwner(ctx);
  const from = join(parent, d.section ?? '', d.name);
  if (ctx.discussion?.dir === from) return note(ctx, `✗ ${d.name} is the discussion in use in this room: it can't move now.`, true), null;
  if (pausedSessions(ctx).some((p) => p.name === d.name)) return note(ctx, '✗ Resume the paused discussion before moving it.', true), null;
  const shop = shopOf(ctx);
  if (target === 'archive' && shop.rollbacks?.has(d.name) && !rollbackConfirmed)
    return note(ctx, '✗ Review the rollback report and use its explicit archive confirmation; the discussion has not been archived.', true), null;
  if (target === 'deferred') {
    const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
    if (!place.disabled && await gitOk(place.top, 'rev-parse', '--verify', WORKER_BRANCH)) {
      try {
        const commits = await labelledCommits(place.top, `main..${WORKER_BRANCH}`);
        const pending = commits.filter((c) => c.origin === d.name);
        if (pending.length) return note(ctx, `✗ ${d.name} can't be deferred: commits on worker/main are not merged into main: ${pending.map((c) => c.id).join(', ')}.`, true), null;
      } catch (err) { return note(ctx, `✗ Can't check unmerged commits: ${err.message}`, true), null; }
    }
  }
  if (shop.workingIn === from) return note(ctx, `✗ A worker task is still writing to ${d.name}; try again when it finishes.`, true), null;
  // Open in another context of this folder: it can move between its rounds, unless it holds worker edits.
  const open = siblings(ctx).find((c) => c !== ctx && c.discussion?.dir === from);
  if (open && workerHold(open)) return note(ctx, `✗ ${d.name} can't move: ${workerHold(open)}.`, true), null;
  if (!open && shop.blockedBy?.label === d.name) return note(ctx, `✗ ${d.name} can't move: its worker edits are unresolved.`, true), null;
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
  return `Archive with rollback for [${name}]. Work only on worker/main; never merge into main or push, reset, rebase or clean the worktree.
Before changing any file (including a preliminary merge), inspect the complete history of worker/main and main, commit messages, parents and diffs. Find this discussion's [${name}]-labelled implementation commits, INCLUDING those already merged into main (do not restrict the search to main..worker/main).
Distinguish implementation commits from catch-up merges and earlier rollback/revert commits. Inspect Agent-Room-Rollback-Origin and Agent-Room-Reverted trailers, standard "This reverts commit" records, and any later reverts of those reverts. Exclude catch-up merges, earlier rollback commits, and implementation changes already undone: never revert a rollback and restore changes already removed. Do not infer the set from labels alone. If the intended set or an earlier rollback's coverage is unclear, stop and report the ambiguity BEFORE changing any file. Do not guess a merge mainline.
Identify later work by other origins that may depend on the changes, using history, overlapping files and affected symbols/callers; report the origins, commit IDs and dependency evidence. A clean revert or passing tests do not prove there are no semantic dependencies. If dependencies make a safe rollback unclear, stop and report before changing files.
Once the set is clear, if main has commits worker/main lacks and the worktree has no unresolved edits or Git operation, first merge main into worker/main with a normal merge. Label any merge commit [${name}] catch up with main. If it clashes, do not force it or continue the rollback: leave the state intact and report the conflict for recovery by this origin. Recheck the intended set after the merge; report any new ambiguity before reverting.
Revert the intended implementation commits newest first. If a revert conflicts, stop and report it; do not force or silently abandon changes. Run npm test and read its real output. Commit the rollback on worker/main with a message starting "[${name}] rollback" and the trailer "Agent-Room-Rollback-Origin: ${name}", plus one "Agent-Room-Reverted: <full implementation commit ID>" trailer per commit undone. If everything was already undone, do not restore it: explain that and make a labelled empty rollback commit with the origin trailer and no reverted IDs.
Report the commit ID, the exact set undone or already undone, npm test's real output, dependencies found on other origins' work and what you could not check. Only if rollback and tests succeeded and the worktree is clean with no Git operation in progress, end the report with "Rollback ready: <full rollback commit ID>". Otherwise omit that line. Do not archive the discussion: the User must review this report and explicitly confirm archiving; the User retains the final merge into main.`;
}
async function requestRollback(ctx, ref) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), ref);
  if (!d || d.section === 'archive') return note(ctx, '✗ Choose a local discussion outside archive/ for rollback.', true);
  if (pausedSessions(ctx).some((p) => p.name === d.name)) return note(ctx, '✗ Resume the saved Pause before requesting rollback.', true);
  let origin = siblings(ctx).find((c) => c.discussion?.name === d.name);
  if (!origin) {
    if (!multi(ctx)) return note(ctx, '✗ Re-open that discussion before requesting rollback in terminal mode.', true);
    origin = await openBeside(ctx, { reopen: ref });
  }
  if (origin.paused || origin.pausing || origin.stopped || origin.screen.workerInfo?.disabled)
    return note(ctx, '✗ Resume the discussion and enable its worker before requesting rollback.', true);
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
  if (shop.running || shop.tasks.length || shop.pumping || shop.confirming)
    return note(ctx, '✗ Wait for the worker queue to be idle before confirming archive.', true);
  shop.confirming = true;
  try {
    const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
    if (place.disabled || await leftovers(ctx) !== false || await git(place.path, 'rev-parse', 'HEAD') !== rollback.commit)
      return note(ctx, '✗ The worker state changed since the rollback report. Resolve it and request a fresh rollback report before archiving.', true);
    if (await moveDiscussion(ctx, ref, 'archive', { rollbackConfirmed: true })) {
      shop.rollbacks.delete(d.name);
      showHeader(ctx);
    }
  } finally { shop.confirming = false; pump(shop).catch((err) => note(ctx, `✗ ${err.message}`, true)); }
}

async function rollbackReport(ctx, rollback, entry) {
  rollback.report = entry.text;
  rollback.status = 'needs review';
  rollback.commit = null;
  const match = /^Rollback ready: ([0-9a-f]{40,64})$/.exec(entry.text.trim().split('\n').at(-1));
  if (!entry.error && match && await leftovers(ctx) === false) {
    const dir = workerDir(ctx), id = match[1];
    const body = await git(dir, 'show', '-s', '--format=%B', id).catch(() => '');
    if (await git(dir, 'rev-parse', 'HEAD') === id && body.startsWith(`[${rollback.name}] rollback`) &&
        body.split('\n').includes(`Agent-Room-Rollback-Origin: ${rollback.name}`)) {
      rollback.commit = id;
      rollback.status = 'ready';
    }
  }
  // It is a report, not a new round: the User decides whether to archive.
  const m = { speaker: 'Worker rollback report', text: entry.text };
  ctx.state.transcript.push(m);
  log(ctx, `**${m.speaker}**\n\n${m.text}\n\n`);
  toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) });
  note(ctx, rollback.status === 'ready'
    ? `Review the rollback report for [${rollback.name}]; then confirm archive in Explorer (switch away from it first), or /archive-rollback ${rollback.name}. Main is still yours to merge.`
    : `Rollback for [${rollback.name}] needs review: no verified successful report yet; archiving was not done.`);
  showHeader(ctx);
}

// Creates the folder (and discussions/ if needed) and returns its name. mkdir itself is the check
// that the name is free, so two rooms naming a discussion at once can't both get it.
export function createDiscussionFolder(parent, title, now = new Date()) {
  const base = `${day(now)}-${(title && slug(title)) || hhmm(now)}`;
  mkdirSync(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (SECTIONS.some((s) => existsSync(join(parent, s, name)))) continue; // taken by an archived or deferred one
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
    if (!ctx.discussion) {
      const label = 'Claude (choosing the discussion\'s title)';
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
      const parent = join(ctx.cwd, 'discussions');
      const name = createDiscussionFolder(parent, title, now);
      ctx.discussion = { name, dir: join(parent, name), title: title ?? `Discussion — ${when(now)}`, continued: false };
      log(ctx, how);
    }
    const { title, dir } = ctx.discussion;
    const head = `# ${title} — session of ${when(now)}\n\nRoom: ${describe(ctx.room)} · worker ${ctx.worker.name}\n\nRoot: ${ctx.cwd}\n\n`;
    ctx.logPath = createSessionFile(join(dir, 'transcripts'), head + (ctx.pendingLog ?? ''), now);
    ctx.pendingLog = '';
    ctx.previous = null; // the "← back to …" link lasts until this discussion starts
  } catch (err) {
    note(ctx, `✗ Couldn't create the discussion's folder or transcript: ${err.message}\nYour message was not sent to the agents. Here it is, to send again:\n\n${line}\n`, true);
    return false;
  }
  ctx.state.briefing = briefing(ctx);
  out(ctx, `Discussion: ${ctx.discussion.dir}\nTranscript: ${ctx.logPath}`);
  showHeader(ctx);
  return true;
}

// Given to each agent with its first prompt.
function briefing(ctx) {
  const { dir, continued } = ctx.discussion;
  if (continued) {
    return `This session continues the discussion in ${dir}: create, read and write this discussion's documents (notes, drawings) there. Start from its handoff `
      + '(see "Where to start reading" in your rulebook); you can also read its notes and its transcripts/ folder.';
  }
  return `This is a new discussion. Its folder is ${dir}: create, read and write this discussion's documents (notes, drawings) there. `
    + `The room's root, ${ctx.cwd}, holds the work itself.`;
}

// Checkpoints are local application data: never placed in the discussion's replicated files.
const pauseDirectory = (ctx) => join(homedir(), '.local', 'state', 'agent-room', 'paused',
  createHash('sha256').update(realpathSync(ctx.cwd)).digest('hex'));
const pauseFile = (ctx, name) => join(pauseDirectory(ctx), createHash('sha256').update(name).digest('hex') + '.json');
function pausedSessions(ctx) {
  const dir = pauseDirectory(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try {
      const saved = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return saved.version === 1 && saved.root === realpathSync(ctx.cwd)
        ? [{ name: saved.discussion.name, title: saved.discussion.title, at: saved.at }] : [];
    } catch { return []; }
  });
}

async function pauseDiscussion(ctx) {
  if (ctx.paused) return note(ctx, 'This discussion is already paused.');
  if (!ctx.discussion || !ctx.logPath) return note(ctx, 'Start a discussion before pausing it.', true);
  const shop = shopOf(ctx);
  if (shop.blockedBy && shop.blockedBy.origin !== ctx && shop.tasks.some((t) => t.origin === ctx))
    return note(ctx, '✗ This discussion\'s worker tasks are waiting for another discussion\'s edits to be resolved: Pause once they have run.', true);
  ctx.pausing = true;
  try {
    await ctx.workQueue; // commands already wait for the round; also drain the independent worker
    const snapshot = {
      version: 1, root: realpathSync(ctx.cwd), at: new Date().toISOString(),
      discussion: ctx.discussion, agentSpecs: ctx.agentSpecs, workerSpec: ctx.workerSpec,
      sessions: [...ctx.sessions], state: { ...ctx.state, seen: [...ctx.state.seen] },
      logPath: ctx.logPath, pendingLog: ctx.pendingLog ?? '', totals: ctx.totals,
      autoSummary: autoOn(ctx), worker: ctx.screen.worker, doc: ctx.screen.doc,
      workerBriefed: ctx.workerBriefed ?? null, workerTree: ctx.workerTree ?? null, workerHandoff: !!ctx.workerHandoff,
    };
    const file = pauseFile(ctx, ctx.discussion.name);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
      linkSync(temp, file); // Publish without overwriting another room's saved Pause.
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    ctx.paused = true;
    ctx.autoDev = null; // Pause ends an auto dev run
    showHeader(ctx);
    note(ctx, 'Paused. The discussion and worker sessions are saved on this machine; you can quit or start another discussion, then Resume later.');
  } finally { ctx.pausing = false; }
}

async function resumeDiscussion(ctx, name) {
  name ||= ctx.paused ? ctx.discussion?.name : '';
  if (!discussionRef(join(ctx.cwd, 'discussions'), name) || name.includes('/'))
    throw new Error('Choose a paused active discussion to Resume.');
  // A brainstorm can't be paused: Resume replaces it, as Re-open does, once the checkpoint loads.
  const brainstorm = !ctx.paused && !!ctx.state.brainstorm;
  const shop = shopOf(ctx), ownWork = !!ctx.workerTree || shop.running?.origin === ctx || shop.tasks.some((t) => t.origin === ctx);
  if (!ctx.paused && !brainstorm && (ctx.logPath || ctx.state.transcript.length || ownWork))
    throw new Error('Pause the current discussion before resuming another one.');
  ctx.pausing = true;
  try {
    await ctx.workQueue;
    const file = pauseFile(ctx, name);
    if (!existsSync(file)) throw new Error('No saved Pause is available for this discussion on this machine.');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1 || saved.root !== realpathSync(ctx.cwd) || saved.discussion?.name !== name
      || !Array.isArray(saved.sessions) || !Array.isArray(saved.state?.transcript) || !Array.isArray(saved.state?.seen))
      throw new Error('The paused discussion checkpoint is invalid.');
    const sessions = new Map(saved.sessions), seen = new Map(saved.state.seen);
    const specs = saved.agentSpecs.split(',').map((spec) => ({ ...parseSpec(spec), worker: false }));
    specs.push({ ...parseSpec(saved.workerSpec, true), worker: true });
    for (const spec of specs) {
      const session = sessions.get(spec.worker ? `worker:${spec.name}` : spec.name);
      if (!session || typeof session !== 'object'
        || (spec.provider === 'claude' && !session.id)
        || (spec.provider === 'codex' && !spec.worker && seen.get(spec.name) > 0 && !session.threadId))
        throw new Error(`The saved provider session for ${spec.name} is missing. The checkpoint was kept.`);
    }
    if (!existsSync(saved.logPath)) throw new Error('The paused discussion transcript is missing.');
    const next = { ...ctx, ...saved, sessions: new Map(saved.sessions),
      state: { ...saved.state, seen: new Map(saved.state.seen) }, paused: false,
      screen: { ...ctx.screen, transcript: saved.state.transcript, worker: shopOf(ctx).log, doc: saved.doc,
        thinking: null, working: null, status: null }, agentsStarted: true,
      workerDir: { path: null } };
    // Build before consuming the checkpoint; a failed load leaves it available for retry.
    const loaded = await load(next, `?resume=${Date.now()}`);
    unlinkSync(file);
    const { root, version, at, worker: workerLog, ...restored } = saved;
    Object.assign(ctx, restored, loaded, { state: next.state, sessions: next.sessions,
      paused: false, agentsStarted: true, workerDir: next.workerDir, previous: null, autoDev: null, autoDevSent: [] });
    if (!ctx.shop.log.length) ctx.shop.log.push(...workerLog); // shared by the folder's open discussions
    wire(ctx);
    toScreen(ctx, ctx.docs.resetEvent(ctx.screen));
    note(ctx, `Resumed the saved discussion and worker sessions.${brainstorm ? ' The brainstorm was discarded.' : ''}`);
    refreshWorker(ctx).catch(() => {});
  } finally { ctx.pausing = false; }
}

// /reopen <name> (Re-open this discussion): make an existing discussion the active one. It runs
// between rounds (commands are queued). Once this session has started, the session ends first: its
// transcript is closed, the chat is cleared, and the agents and the worker get fresh CLI sessions;
// the next message starts a new session in the re-opened discussion, from its handoff. Discussions
// retain native agent memory only through an explicit Pause, not through Re-open.
async function reopenDiscussion(ctx, name) {
  const parent = join(ctx.cwd, 'discussions');
  // A discussion is a folder named <date>-<title>; other folders there are the room's own material.
  // One in archive/ or deferred/ is made active first.
  const d = discussionRef(parent, name ?? '');
  if (!d) return note(ctx, `✗ No discussion "${name}" in ${parent} (discussions are folders named <date>-<title>).`, true);
  if (d.section && !await moveDiscussion(ctx, name, 'active')) return;
  name = d.name;
  const checkpoint = pauseFile(ctx, name);
  if (existsSync(checkpoint)) unlinkSync(checkpoint); // Re-open explicitly starts fresh.
  if (ctx.logPath) {
    await ctx.workQueue; // let a running worker instruction finish in this session
    endSession(ctx, `re-opening the discussion ${name}`);
    ctx.worker.reset?.();
    if (siblings(ctx).length === 1) ctx.screen.worker.length = 0; // the Worker tab is shared otherwise
    ctx.workerBriefed = null;
    ctx.workerTree = ctx.workerLabel = null; // its fresh session is told about its worktree again
  }
  if (ctx.state.brainstorm) endSession(ctx, 'ending the brainstorm');
  switchTo(ctx, { name, dir: join(parent, name), title: name, continued: true });
  note(ctx, `Re-opened the discussion ${name}: your next message starts a fresh session there; the agents start from its handoff.`);
}

// Ends this room's discussion session (Re-open and New discussion): a last line in its transcript,
// which is then closed; the chat clears and the discussion agents get fresh CLI sessions. The worker
// is left alone here: Re-open resets it itself, New discussion doesn't.
function endSession(ctx, why) {
  ctx.paused = false;
  log(ctx, `_(session ended: ${why})_\n\n`);
  for (const a of ctx.room.agents) a.reset?.();
  const { state, screen } = ctx;
  state.transcript.length = 0; // emptied in place: the room and the screen hold this array
  for (const a of ctx.room.agents) state.seen.set(a.name, 0);
  state.summaries = 0;
  state.briefing = null;
  state.brainstorm = false;
  ctx.autoDev = null; // Re-open, New discussion and New brainstorm end an auto dev run
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
  if (was && was.dir !== next?.dir) ctx.previous = { name: was.name, title: was.title };
  if (next && ctx.previous?.name === next.name) ctx.previous = null; // went back to it
  ctx.discussion = next;
  showHeader(ctx);
  toScreen(ctx, ctx.docs.resetEvent(ctx.screen)); // open pages start over with the empty chat
}

// /new (New discussion): between rounds, like every command. The discussion session ends as with
// Re-open; the next message names and creates the new discussion, as in a fresh room. Nothing is
// created until then. The worker is not affected: a task already running keeps its target, its log
// stays (with a marker line), and its session is kept (decided by the User, 2026-11-07).
function newDiscussion(ctx) {
  const was = ctx.discussion;
  if (!was && !ctx.logPath && !ctx.state.brainstorm) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  if (ctx.paused) {
    // The saved worker session must not receive turns from the new discussion.
    ctx.worker.reset?.();
    ctx.screen.worker.length = 0;
    ctx.workerBriefed = ctx.workerTree = ctx.workerLabel = null;
    ctx.workerHandoff = false;
  }
  if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'starting a new discussion');
  if (was && ctx.screen.worker.length) {
    const view = { note: `New discussion: ${was.name} is no longer the active one. The next instruction gets the new discussion's folder once your first message creates it.` };
    ctx.screen.worker.push(view);
    toScreen(ctx, { type: 'work', message: view });
  }
  switchTo(ctx, null);
  note(ctx, `New discussion: your next message names it and starts it.${was ? ` To go back, /reopen ${was.name}.` : ''}`);
}

// /brainstorm (New brainstorm): a conversation like a discussion's, with no title, folder,
// transcript, notes or handoff; it lives only in server memory (ctx.state, so it survives a
// Reload and a page refresh, not a Restart or Quit). One per room: a new one discards it, and New
// discussion, Re-open or Resume ends it. It ends the discussion session in use as New discussion does; the
// worker carries on as with no discussion.
function newBrainstorm(ctx) {
  const was = ctx.discussion;
  if (ctx.paused) { // as New discussion: the saved worker session must not receive these turns
    ctx.worker.reset?.();
    ctx.screen.worker.length = 0;
    ctx.workerBriefed = ctx.workerTree = ctx.workerLabel = null;
    ctx.workerHandoff = false;
  }
  if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'starting a brainstorm');
  ctx.state.brainstorm = true;
  ctx.state.brainstormId = randomBytes(12).toString('hex');
  ctx.state.briefing = `This is a brainstorm, not a discussion: it has no folder and agent-room keeps no record of it. Write no files; you may read the project in the room's root, ${ctx.cwd}.`;
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New brainstorm: agent-room keeps no record of it, and Restart or Quit room loses it.${was ? ` To go back, /reopen ${was.name}.` : ''}`);
}

// ── Several open discussions ──────────────────────────────────────────
// On the browser screen a folder can have several discussions open at once. Each is its own context:
// a ctx with its own agents' sessions, chat, input queue, auto dev and page, made by cli.mjs's addRoom
// with a `context` tag (ctx.key is then "<folder>#<tag>"). They share the folder's workshop
// (ctx.shop): one worker queue, worktree and Worker tab; each task is labelled with its origin and
// its report goes back there, and each context has its own worker session. One window shows one
// context; Explorer and the header switch between them ('goto'). New discussion and Re-open open
// another context and keep this one; Close discussion closes one; Quit room closes them all.
// Terminal mode keeps one discussion at a time: its one input can't switch between contexts.
const baseKey = (ctx) => String(ctx.key ?? ctx.cwd).split('#')[0];
export function siblings(ctx) {
  const list = ctx.hub?.rooms ? [...ctx.hub.rooms.values()].filter((r) => r.screen && baseKey(r) === baseKey(ctx)) : [];
  return list.includes(ctx) ? list : [ctx, ...list];
}
const multi = (ctx) => !ctx.noScreen;
// A context with nothing in it yet: New discussion, Re-open and New brainstorm use it in place.
const fresh = (ctx) => !ctx.discussion && !ctx.logPath && !ctx.state.brainstorm && !ctx.state.transcript.length && !ctx.paused;
// The task label: the discussion's folder name, or the brainstorm.
const originLabel = (ctx) => ctx.discussion?.name ?? (ctx.state.brainstorm ? 'brainstorm' : 'no discussion');
const pageOf = (ctx) => `${roomPath(ctx)}__room`;
function openList(ctx) {
  return siblings(ctx).filter((c) => c.state && c.id).map((c) => ({ url: pageOf(c), current: c === ctx,
    title: c.discussion?.title ?? (c.state.brainstorm ? 'Brainstorm' : 'New discussion (not started)'),
    active: c.discussion ? `discussions/${c.discussion.name}` : null, brainstorm: !!c.state.brainstorm, paused: !!c.paused }));
}
function newShop(workerDir, log) {
  return { tasks: [], running: null, blockedBy: null, workingIn: null, contexts: 0, workerDir, log };
}
function shopOf(ctx) {
  if (ctx.shop) return ctx.shop;
  const other = siblings(ctx).find((c) => c !== ctx && c.shop);
  ctx.shop = other?.shop ?? newShop(ctx.workerDir ??= { path: null }, ctx.screen.worker);
  ctx.workerDir = ctx.shop.workerDir;
  ctx.screen.worker = ctx.shop.log;
  return ctx.shop;
}
// Worker events go to every open discussion's pages.
const toShop = (ctx, event) => { for (const c of siblings(ctx)) if (c.screen) toScreen(c, event); };
function workNote(ctx, text, error = false) {
  const view = { note: text, error };
  shopOf(ctx).log.push(view);
  toShop(ctx, { type: 'work', message: view });
  out(ctx, error ? red(text) : text);
}
// Sends this context's pages to another one (the window switches discussion).
const goto = (ctx, target) => toScreen(ctx, { type: 'goto', url: pageOf(target) });
async function openBeside(ctx, opts = {}) {
  const shop = shopOf(ctx);
  let tag;
  do tag = `d${++shop.contexts}`; while (ctx.hub.rooms.has(`${baseKey(ctx)}#${tag}`));
  const { ctx: next } = await ctx.hub.addRoom(ctx.cwd, { agents: ctx.agentSpecs, worker: ctx.workerSpec, context: tag, reopen: opts.reopen });
  showHeader(ctx);
  return next;
}
// Why `c` can't be closed (or its folder moved): it holds unresolved worker edits, or its task runs.
function workerHold(c) {
  const shop = shopOf(c);
  if (shop.blockedBy && (shop.blockedBy.origin === c || shop.blockedBy.label === originLabel(c))) return `its worker edits from "${shop.blockedBy.task}" are unresolved: ask the worker to finish and commit them, or to abandon them`;
  if (shop.running?.origin === c) return 'a worker task from it is running';
  return null;
}
// Ends context `c` (its agents stop; its queued worker tasks are dropped and reported by stopRoom).
// Its pages go to `to`.
function closeContext(c, to) {
  if (to) goto(c, to);
  c.say?.('/quit');
}

// /new on the screen: the discussion in use stays open; an open brainstorm ends.
async function newDiscussionBeside(ctx) {
  const brain = siblings(ctx).find((c) => c.state?.brainstorm);
  if (brain) {
    const hold = workerHold(brain);
    if (hold) return note(ctx, `✗ The brainstorm can't end yet: ${hold}.`, true);
    if (brain !== ctx) closeContext(brain, ctx);
    else {
      endSession(ctx, 'starting a new discussion');
      switchTo(ctx, null);
      return note(ctx, 'New discussion: the brainstorm ended; your next message names the new discussion and starts it.');
    }
  }
  if (fresh(ctx)) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  const next = await openBeside(ctx);
  goto(ctx, next);
  note(ctx, `New discussion: ${originLabel(ctx)} stays open (Explorer: Go to).`);
}
// /brainstorm on the screen: at most one per folder, beside the discussions.
async function newBrainstormBeside(ctx) {
  const brain = siblings(ctx).find((c) => c !== ctx && c.state?.brainstorm);
  if (brain) { brain.say?.('/brainstorm'); return goto(ctx, brain); }
  if (ctx.state.brainstorm || fresh(ctx)) return newBrainstorm(ctx);
  const next = await openBeside(ctx);
  next.say?.('/brainstorm');
  goto(ctx, next);
}
// /reopen on the screen: a discussion open in another context is shown there, as it is; otherwise
// it opens in a context of its own (this one, if it is still empty), fresh from its handoff.
async function reopenBeside(ctx, name) {
  const d = discussionRef(join(ctx.cwd, 'discussions'), name ?? '');
  const open = d && siblings(ctx).find((c) => c !== ctx && c.discussion?.name === d.name);
  if (open) return goto(ctx, open);
  if (!d || ctx.discussion?.name === d.name || fresh(ctx)) return reopenDiscussion(ctx, name);
  goto(ctx, await openBeside(ctx, { reopen: name }));
}
// /resume on the screen: as Re-open, for a paused discussion.
async function resumeBeside(ctx, name) {
  const open = name && siblings(ctx).find((c) => c !== ctx && c.discussion?.name === name);
  if (open) { if (open.paused) open.say?.(`/resume ${name}`); return goto(ctx, open); }
  if (!name || ctx.paused || fresh(ctx) || ctx.state.brainstorm) return resumeDiscussion(ctx, name);
  const next = await openBeside(ctx);
  next.say?.(`/resume ${name}`);
  goto(ctx, next);
}
// /close (Close discussion): this discussion (or brainstorm) closes; the others stay open. The last
// one open ends its session instead, leaving an empty room, as New discussion does in the terminal.
function closeDiscussion(ctx) {
  const hold = workerHold(ctx);
  if (hold) return note(ctx, `✗ This can't be closed yet: ${hold}.`, true);
  const others = siblings(ctx).filter((c) => c !== ctx);
  if (!others.length || !multi(ctx)) {
    if (fresh(ctx)) return note(ctx, 'Nothing to close: no discussion is open here.');
    const was = ctx.discussion;
    if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'closing the discussion');
    ctx.paused = false;
    switchTo(ctx, null);
    return note(ctx, `Closed${was ? ` ${was.name}` : ' the brainstorm'}. To go back, Re-open it in Explorer.`);
  }
  if (ctx.replicaOwner) return note(ctx, '✗ This discussion holds the room\'s replication (its peers and storage): it stays open while others are. Close them first, or Quit room.', true);
  closeContext(ctx, others[0]);
}

// ── The shared worker queue ───────────────────────────────────────────
// Tasks run one at a time in the order sent, from any open discussion. agent-room checks the
// worktree after each task and again before the next: uncommitted edits hold the queue
// (shop.blockedBy) until their origin resolves them; that origin's own tasks still go through (to
// finish or abandon them), and keep the original task's details. Edits whose origin is unknown
// (without a valid saved owner) hold every task until the folder is clean.
// The private, per-worktree Git directory is outside both working copies and their indexes.
async function ownerFile(place) {
  return join(await git(place.path, 'rev-parse', '--absolute-git-dir'), 'agent-room-task.json');
}
async function leftovers(ctx) {
  const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
  if (place.disabled) return false;
  let s;
  const shop = shopOf(ctx);
  try { s = await worktreeStatus(place); }
  catch (err) {
    // Unknown is neither clean nor dirty: even the holding origin's recovery must wait.
    const origin = shop.blockedBy?.origin ?? shop.running?.origin ?? ctx;
    if (shop.inspectionError?.message !== err.message || shop.inspectionError?.origin !== origin) {
      const text = `✗ Worker worktree inspection failed: ${err.message}. All worker dispatch, including recovery, waits until inspection succeeds.`;
      workNote(ctx, text, true);
      note(origin, text, true);
    }
    shop.inspectionError = { message: err.message, origin };
    if (!shop.pumping) watchShop(shop);
    return null;
  }
  shop.inspectionError = null;
  if (!s.exists) return false;
  if (!s.treeDirty) {
    const file = await ownerFile(place);
    if (existsSync(file)) {
      const owner = await recordedOwner(ctx);
      if (owner.before) rememberCommits(shopOf(ctx), await labelledCommits(place.path, `${owner.before}..HEAD`));
    }
    try { unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return !!s.treeDirty;
}
async function recordedOwner(ctx) {
  try {
    const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
    if (place.disabled) return { origin: null };
    const r = JSON.parse(readFileSync(await ownerFile(place), 'utf8'));
    if (r.version !== 1 || r.root !== real(ctx.cwd) || typeof r.label !== 'string' ||
        typeof r.task !== 'string' || !r.task.trim() || typeof r.before !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(r.before) || !await gitOk(place.path, 'cat-file', '-e', `${r.before}^{commit}`)) return { origin: null };
    const origin = siblings(ctx).find((c) => !c.stopped && (r.label === 'brainstorm'
      ? c.state.brainstorm && typeof r.brainstormId === 'string' && c.state.brainstormId === r.brainstormId : c.discussion?.name === r.label && existsSync(c.discussion.dir)));
    const exists = r.label !== 'brainstorm' && [r.label, `archive/${r.label}`, `deferred/${r.label}`]
      .some((ref) => discussionRef(join(ctx.cwd, 'discussions'), ref));
    return origin || exists ? { origin: origin ?? null, label: r.label, task: r.task, before: r.before } : { origin: null };
  } catch { return { origin: null }; }
}
// Restart creates each context before reopening its discussion; try again after that restoration.
export async function recoverWorkerOwner(ctx) {
  const shop = shopOf(ctx);
  if (shop.running) return true;
  const dirty = await leftovers(ctx);
  if (dirty === null) return false;
  if (dirty) {
    if (shop.blockedBy?.origin) return true;
    const owner = await recordedOwner(ctx);
    if (!shop.blockedBy || owner.origin) hold(ctx, owner);
  } else if (shop.blockedBy) release(ctx);
  return true;
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
  if (!ctx.discussion) return;
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
  const shop = shopOf(ctx);
  shop.blockedBy = blockedBy;
  shop.holdContext = ctx;
  const where = blockedBy.label ? `[${blockedBy.label}]` : 'an unknown origin';
  workNote(ctx, `✗ The worker's folder has uncommitted edits from ${where}${blockedBy.task ? ` ("${blockedBy.task}")` : ''}: the queue holds${blockedBy.label ? ` until [${blockedBy.label}] resolves them (its own instructions still go through)` : ' until the folder is clean (commit or remove those edits yourself)'}.`, true);
  if (blockedBy.origin) note(blockedBy.origin, `✗ The worker left uncommitted edits from "${blockedBy.task}": other discussions' worker tasks wait. Ask the worker to finish and commit them, or to abandon the attempt (it lists the edits and waits for your approval).`, true);
  showHeader(ctx);
  if (!shop.pumping) watchShop(shop);
}
function release(ctx) {
  const shop = shopOf(ctx), was = shop.blockedBy;
  shop.blockedBy = null;
  workNote(ctx, 'The worker\'s folder is clean again: the queue resumes.');
  if (was?.origin) note(was.origin, 'The worker\'s folder is clean again: other worker tasks resume.');
  showHeader(ctx);
}
async function pump(shop) {
  if (shop.pumping || shop.confirming) return;
  shop.pumping = true;
  try {
    if ((shop.blockedBy || shop.inspectionError) && !shop.running &&
        !await recoverWorkerOwner(shop.holdContext ?? shop.inspectionError.origin)) return;
    while (!shop.running && shop.tasks.length) {
      for (const t of shop.tasks.filter((x) => x.origin.stopped)) dropTask(shop, t);
      const any = shop.tasks[0]?.origin;
      if (!any) break;
      // Before the next task: is the folder clean?
      const dirty = await leftovers(any);
      if (dirty === null) break;
      if (dirty && !shop.blockedBy?.origin && !await recoverWorkerOwner(any)) break;
      else if (!dirty && shop.blockedBy) release(any);
      const t = !shop.blockedBy ? shop.tasks[0] : shop.blockedBy.origin && shop.tasks.find((x) => x.origin === shop.blockedBy.origin);
      if (!t) break; // held
      shop.tasks.splice(shop.tasks.indexOf(t), 1);
      t.origin.workPending--;
      shop.running = t;
      const recovery = shop.blockedBy?.origin === t.origin ? shop.blockedBy : null;
      try { t.before = await runWork(t.origin, t.text, t.run, t.cycle, recovery, t.rollback); }
      catch (err) { note(t.origin, `✗ ${err.stack}\n`, true); }
      finally { shop.running = null; }
      // After it: edits left uncommitted hold the queue; a recovery keeps the first task's details.
      try {
        const dirty = await leftovers(t.origin);
        if (dirty === true) { if (!shop.blockedBy) hold(t.origin, { origin: t.origin, label: originLabel(t.origin), task: t.text, before: t.before }); }
        else if (dirty === false && shop.blockedBy) release(t.origin);
      } catch (err) { note(t.origin, `✗ ${err.message}`, true); }
      t.done();
    }
  } finally { shop.pumping = false; watchShop(shop); }
}
// Recheck holds even without queued tasks, so cleaning up by hand removes the record and hold.
function watchShop(shop) {
  if ((shop.tasks.length || shop.blockedBy || shop.inspectionError) && !shop.running && !shop.recheck) {
    shop.recheck = setTimeout(() => { shop.recheck = null; pump(shop).catch(() => {}); }, 2000);
    shop.recheck.unref?.();
  }
}

function dropTask(shop, t) {
  shop.tasks.splice(shop.tasks.indexOf(t), 1);
  if (t.rollback) { t.rollback.status = 'needs review'; t.rollback.report = 'The rollback task was not started.'; showHeader(t.origin); }
  t.origin.workPending--;
  t.origin.workSkipped = (t.origin.workSkipped ?? 0) + 1;
  t.done();
}

// ── Auto dev ────────────────────────────────────────────────────────
// Start auto dev (/autodev) sends the latest agreed summary's instruction to the worker; its reply
// comes back as a "Worker report" that starts a round, always followed by an auto-summary whose last
// line decides: SEND (the next instruction, once per report), FINISH or WAIT FOR USER. At most
// AUTO_DEV_CYCLES worker cycles per start. ctx.autoDev: { status: 'running' | 'paused' | 'finished',
// cycle, reason, waiting (a relay at the worker), report (its reply, until its round) }, in ctx so
// it survives a Reload; ctx.autoDevSent: the summaries already sent (transcript indexes) this session.
export const AUTO_DEV_CYCLES = 5;
const AUTO_DEV_REPORT = '/autodev report';
const AUTO_DEV_MEANS = 'FINISH: development is complete and reviewed; only the User\'s merge, Reload or live trial may remain. '
  + 'WAIT FOR USER: the User must answer or act before development can continue.';
const autoDevTask = (run) => [
  `Auto dev is running (worker cycle ${run.cycle} of at most ${AUTO_DEV_CYCLES}): an agreed summary can send its Next step instruction to the Worker by itself.`,
  'Passing on a version accepts its quoted instruction for the worker exactly as it stands.',
  'End the summary with one last line: Outcome: SEND, Outcome: FINISH or Outcome: WAIT FOR USER.',
  'SEND sends the Next step\'s "Send to the Worker" instruction now: say it only when you mean to send it (repeating earlier text is a deliberate retry).',
  AUTO_DEV_MEANS,
].join('\n');
// While a run is paused, any summary may end it: it can only say FINISH or WAIT FOR USER, and sends nothing.
const pausedTask = (run) => [
  `Auto dev is paused (${run.reason}): this summary sends nothing to the Worker.`,
  'End the summary with one last line: Outcome: FINISH or Outcome: WAIT FOR USER.',
  AUTO_DEV_MEANS,
].join('\n');

// The instruction in a summary's Next step: { text }, { error } when it can't be read reliably, or
// null when there is none. The text runs from `Send to the Worker: "` to the last quotation mark
// before the next section (**Later**) or the Outcome line, so it may hold quotes and paragraphs.
export function summaryInstruction(summary) {
  const lines = String(summary ?? '').split('\n');
  const start = lines.findIndex((l) => /^[\s*_#-]*Next step[\s*_:]*$/i.test(l));
  if (start < 0) return /Send to the Worker:/i.test(summary ?? '') ? { error: 'its "Send to the Worker" line isn\'t under a Next step heading' } : null;
  let end = lines.findIndex((l, i) => i > start && (/^\s*\*\*[^*]+\*\*[\s:]*$/.test(l) || /^[\s*_]*Outcome:/i.test(l)));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).join('\n');
  const opening = /Send to the Worker:\s*["“]/g;
  const marks = section.match(opening)?.length ?? 0;
  if (!marks) return /Send to the Worker/i.test(section) ? { error: 'its Next step has no quoted instruction (Send to the Worker: "…")' } : null;
  if (marks > 1) return { error: 'its Next step holds more than one instruction for the worker' };
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
function latestAgreed(ctx) {
  const t = ctx.state.transcript;
  for (let i = t.length - 1; i >= 0; i--) if (t[i].outcome === 'agreed') return { index: i, instruction: summaryInstruction(t[i].text) };
  return null;
}
// What the page offers: the latest agreed summary's instruction, unless it was sent (or a run is
// going, or this is no saved discussion): { text } with a Start or Restart button, or { error }.
function autoDevOffer(ctx) {
  if (!ctx.logPath || ctx.state.brainstorm || ctx.paused || ctx.autoDev?.status === 'running') return null;
  const s = latestAgreed(ctx);
  return s && !(ctx.autoDevSent ?? []).includes(s.index) ? s.instruction : null;
}
function autoDevView(ctx) {
  const run = ctx.autoDev;
  return { status: run?.status ?? null, cycle: run?.cycle ?? 0, max: AUTO_DEV_CYCLES, reason: run?.reason ?? null, waiting: !!run?.waiting, offer: autoDevOffer(ctx) };
}

// /autodev: Start auto dev, or Restart it (another AUTO_DEV_CYCLES cycles), from the latest agreed summary.
function startAutoDev(ctx) {
  const s = latestAgreed(ctx);
  const why = ctx.state.brainstorm ? 'auto dev is for discussions; a brainstorm keeps no saved record'
    : !ctx.logPath || ctx.paused ? 'it needs a started discussion that isn\'t paused'
    : !ctx.say ? 'it works from the browser screen'
    : ctx.autoDev?.status === 'running' ? 'it is already running'
    : ctx.screen.workerInfo?.disabled ? ctx.screen.workerInfo.lines[0]
    : !s ? 'there is no agreed summary yet'
    : (ctx.autoDevSent ?? []).includes(s.index) ? 'the latest agreed summary\'s instruction was already sent'
    : !s.instruction ? 'the latest agreed summary has no instruction for the worker'
    : s.instruction.error ?? null;
  if (why) return note(ctx, `✗ Auto dev can't start: ${why}.`, true);
  ctx.autoDev = { status: 'running', cycle: 0, reason: null, waiting: false, report: null };
  log(ctx, `_(auto dev started: up to ${AUTO_DEV_CYCLES} worker cycles)_\n\n`);
  note(ctx, `Auto dev started: up to ${AUTO_DEV_CYCLES} worker cycles. Auto-summarize is on for this run; your saved setting is unchanged.`);
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
  const notice = { speaker: 'Auto dev', text: `Auto dev sent the instruction "${s.instruction.text.split('\n')[0].trim()}" to the Worker (cycle ${run.cycle} of ${AUTO_DEV_CYCLES}).` };
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
// The worker finished a relayed instruction: its reply (or failure) goes to the discussion as a
// round of its own, queued like a typed line. Not if the run has ended meanwhile.
function reportBack(ctx, run, entry) {
  if (ctx.autoDev !== run) return;
  run.waiting = false;
  run.report = entry.error ? `The worker's attempt failed: ${entry.text}` : entry.text;
  showHeader(ctx);
  if (ctx.say) ctx.say(AUTO_DEV_REPORT);
}
async function autoDevReport(ctx) {
  const run = ctx.autoDev;
  if (!run?.report) return;
  const text = run.report;
  run.report = null;
  await runRound(text, ctx, { speaker: 'Worker report', run: run.status === 'running' ? run : null });
}
function finishAutoDev(ctx, run) {
  Object.assign(run, { status: 'finished', reason: null });
  log(ctx, '_(auto dev finished)_\n\n');
  note(ctx, 'Auto dev finished. Review and merge worker/main yourself.');
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
  if (run.cycle >= AUTO_DEV_CYCLES) return pauseAutoDev(ctx, `${AUTO_DEV_CYCLES} cycles used`);
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

// Auto-summarize: on unless turned off (ctx.autoSummary, so it survives a reload).
const autoOn = (ctx) => ctx.autoSummary !== false;
function setAuto(ctx, on) {
  ctx.autoSummary = on;
  ctx.screen.auto = on;
  toScreen(ctx, { type: 'auto', on });
  log(ctx, `_(auto-summarize ${on ? 'on' : 'off'})_\n\n`);
  note(ctx, `Auto-summarize is ${on ? 'on: a summary follows every round in which an agent spoke' : 'off'}.`);
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
  if (ctx.hub) ctx.hub.route = route; // the server's routing runs the new code too
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  log(ctx, '_(code reloaded)_\n\n');
  // A relay whose worker result can't come back any more: pause visibly rather than send again.
  const run = ctx.autoDev;
  if (run?.status === 'running' && run.waiting && shopOf(ctx).running?.origin !== ctx && !ctx.workPending) pauseAutoDev(ctx, 'the worker\'s result was lost in the Reload');
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
// 8 turns of 5 minutes, plus its summary's turns, plus every line queued before Quit.
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
  clearTimeout(ctx.quitTimer);
  await ctx.quitStop;
  const report = await stopPrograms(ctx);
  const shop = ctx.shop;
  if (shop) for (const t of shop.tasks.filter((x) => x.origin === ctx)) dropTask(shop, t); // its own, in the shared queue
  const queued = (ctx.workPending ?? 0) + (ctx.workSkipped ?? 0);
  if (queued) report.push(`${plural(queued, 'queued worker instruction')} ${queued === 1 ? 'was' : 'were'} not started.`);
  ctx.workSkipped = 0;
  // The stopped instruction's own reply (an error) is recorded before the room closes.
  await Promise.race([ctx.workQueue, new Promise((r) => setTimeout(r, 3000))]);
  for (const line of report) note(ctx, `✗ ${line}`, true);
  return report;
}

// /restart (the whole server): this process frees its port and a new agent-room process takes it
// over with the same launch flags and every room, each with its current agents and worker, and the
// discussion in use re-opened (a fresh session from its handoff, as /reopen). A paused discussion
// instead stays saved for explicit Resume; no --reopen is passed. An unpaused chat in memory doesn't
// carry over. The first room is passed as --cwd (replicating, with --node, only if it is the launch
// room); the others as --room. The new process writes where this one did (the terminal or the Dock
// app's log) and runs on its own once this one exits.
export function restartArgs(rooms, values, port) {
  const reopen = (r) => (r.discussion && !r.paused ? r.discussion.name : null);
  // A folder's other open discussions come back too, each in its own context; empty ones,
  // brainstorms and paused ones don't (a paused one stays saved for Resume).
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
  await new Promise((done) => hub.server.close(done));
  spawn(process.execPath, args, { cwd: rooms[0].cwd, detached: true, stdio: 'inherit' }).unref();
}

export async function handleLine(line, ctx) {
  if (!line) return;
  if (line === '/docs') return showDocs(ctx);
  const reopen = /^\/(?:reopen|continue)(?:\s+(.*))?$/.exec(line); // /continue: its former name
  // On the screen, several discussions stay open (see "Several open discussions").
  if (reopen) return (multi(ctx) ? reopenBeside : reopenDiscussion)(ctx, (reopen[1] ?? '').trim());
  if (line === '/pause') return pauseDiscussion(ctx);
  const resume = /^\/resume(?:\s+(.*))?$/.exec(line);
  if (resume) return (multi(ctx) ? resumeBeside : resumeDiscussion)(ctx, (resume[1] ?? '').trim());
  if (line === '/new') return multi(ctx) ? newDiscussionBeside(ctx) : newDiscussion(ctx);
  if (line === '/brainstorm') return multi(ctx) ? newBrainstormBeside(ctx) : newBrainstorm(ctx);
  if (line === '/close') return closeDiscussion(ctx);
  if (line === '/autodev') return startAutoDev(ctx);
  if (line === AUTO_DEV_REPORT) return autoDevReport(ctx);
  const rollback = /^\/rollback\s+(\S+)$/.exec(line);
  if (rollback) return requestRollback(ctx, rollback[1]);
  const archiveRollback = /^\/archive-rollback\s+(\S+)$/.exec(line);
  if (archiveRollback) return confirmRollbackArchive(ctx, archiveRollback[1]);
  const move = /^\/move\s+(\S+)\s+(\S+)$/.exec(line);
  if (move) return void await moveDiscussion(ctx, move[1], move[2]);
  if (line === '/summary' && ctx.paused) return note(ctx, 'Resume the paused discussion before requesting a summary.', true);
  if (line === '/summary') {
    ctx.agentsStarted = true;
    const status = await runSummary(ctx);
    if (status !== 'empty') await saveRound(ctx, { kind: 'summary', outcome: status === 'failed' ? 'failed' : 'completed', ending: `summary ${status}`, summary: status });
    return;
  }
  if (line === '/restart') return note(ctx, '/restart is for the browser screen; in the terminal, /quit and start the room again.');
  const auto = /^\/autosummary(?:\s+(on|off))?$/.exec(line);
  if (auto) return setAuto(ctx, auto[1] ? auto[1] === 'on' : !autoOn(ctx));
  if (line === '/usage') {
    const quota = await ctx.usage.fetchQuota();
    return note(ctx, `${ctx.usage.usageReport({ totals: ctx.totals, agents: [...ctx.room.agents, ctx.worker], quota })}\n`);
  }
  if (ctx.paused) return note(ctx, 'This discussion is paused. Resume it before sending messages.', true);
  autoDevInput(ctx, 'you sent a message');
  // The session's first message opens its discussion, unless it names an unknown agent (runRound
  // then refuses it, and nothing is created).
  const to = /^@(\w[\w-]*)/.exec(line)?.[1].toLowerCase();
  const known = !to || ctx.room.agents.some((a) => a.name.toLowerCase() === to);
  if (known) ctx.agentsStarted = true;
  if (known && !ctx.logPath && !ctx.state.brainstorm && !(await openDiscussion(ctx, line))) return;
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
        ending = 'turn cap reached';
      },
    }).finally(() => { ctx.busy = false; });
    const secs = Math.round((Date.now() - roundStart) / 1000);
    const providers = [...new Set(ctx.room.agents.map((a) => a.provider))];
    const quota = ctx.usage.quotaSummary(await refreshQuota(ctx).catch(() => null), providers);
    const parts = [ending, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(roundUsage), quota];
    // A failed turn pauses auto dev; otherwise its round is always summarized, to decide what's next.
    const deciding = run && ctx.autoDev === run && run.status === 'running';
    if (deciding && ending.endsWith('failed')) pauseAutoDev(ctx, ending);
    // Auto-summarize: after a round in which an agent spoke and none failed. Its own end line is
    // then the "your turn" one; this round's line is just a note.
    if ((autoOn(ctx) && spoke || deciding) && !ending.endsWith('failed')) {
      out(ctx, dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      const summary = await runSummary(ctx, true, deciding ? autoDevTask(run) : undefined);
      await saveRound(ctx, { kind: 'round', outcome: summary === 'failed' ? 'failed' : 'completed', ending, summary });
      if (deciding) decide(ctx, run, summary);
      return;
    }
    out(ctx, dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
    toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
    await saveRound(ctx, { kind: 'round', outcome: ending.endsWith('failed') ? 'failed' : 'completed', ending, summary: null });
  } catch (err) {
    if (ctx.replica && ctx.state.transcript.at(-1)?.error) await saveRound(ctx, { kind: 'round', outcome: 'interrupted', ending: err.message, summary: null });
    // An unknown @name: nothing was sent or recorded.
    note(ctx, `✗ ${err.message}`, true);
  }
}

// ── The worker's worktree ─────────────────────────────────────────────
// The worker works in its own Git worktree of the room's repository, on the branch worker/main, in
// the sibling folder <repo>.worker/: never in the room's own files (its notes still go in the room's
// discussion folder). The worktree is created at the first instruction and reused after Restart or
// Reload reads it back from Git. Task ownership is saved in the private Git directory.
// The only branch/worktree writes are `worktree add` and
// a fast-forward of worker/main when it has nothing of its own: never a reset, merge, rebase or
// deletion, and never anything in the room's own working copy. Decided by the User, 2026-11-07.
// That is agent-room's own code: the worker itself may do such Git actions in its worktree when the
// task asks (catching up with main, a rollback, or abandoning listed edits after approval). Decided 2026-11-09.
export const WORKER_BRANCH = 'worker/main';
const NO_GIT = 'Worker requires a source Git repository for its isolated worktree.';
const git = (dir, ...args) => new Promise((done, fail) => execFile('git', ['-C', dir, ...args], { maxBuffer: 1 << 22 },
  (err, out, errOut) => (err ? fail(new Error(`git ${args[0]}: ${(errOut || err.message).trim()}`)) : done(out.trim()))));
const gitOk = (dir, ...args) => git(dir, ...args).then(() => true, () => false);
const real = (p) => (existsSync(p) ? realpathSync(p) : p);

// Where the room's worker works: { root, top, path, cwd } (cwd: the room's subfolder inside the
// worktree, when the room isn't the repository's top), or { disabled: why }.
export async function workerPlace(roomRoot) {
  const root = real(roomRoot);
  let top;
  try { top = await git(root, 'rev-parse', '--show-toplevel'); } catch { return { disabled: NO_GIT }; }
  if (!(await gitOk(top, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'))) return { disabled: `${NO_GIT} This one has no commit yet.` };
  const [own, common] = await Promise.all([git(top, 'rev-parse', '--absolute-git-dir'), git(top, 'rev-parse', '--path-format=absolute', '--git-common-dir')]);
  if (real(own) !== real(common)) return { disabled: `${top} is itself a linked Git worktree (such as a worker's): open the room in the main checkout instead.` };
  const path = join(dirname(top), `${basename(top)}.worker`);
  return { root, top, path, cwd: join(path, relative(top, root)) };
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
  const here = list.find((w) => w.path === place.path);
  if (here && here.branch !== WORKER_BRANCH) throw new Error(`${place.path} is a worktree on ${here.branch ?? 'a detached HEAD'}, not ${WORKER_BRANCH}: nothing was changed.`);
  if (here && !existsSync(place.path)) throw new Error(`Git still lists ${place.path} as a worktree, but the folder is gone: run git worktree prune in ${place.top}, then try again.`);
  if (here) return;
  if (existsSync(place.path)) throw new Error(`${place.path} already exists and isn't the worker's worktree: nothing was changed.`);
  const elsewhere = list.find((w) => w.branch === WORKER_BRANCH);
  if (elsewhere) throw new Error(`${WORKER_BRANCH} is already checked out in ${elsewhere.path}: nothing was changed.`);
  if (await gitOk(place.top, 'rev-parse', '--verify', '-q', `refs/heads/${WORKER_BRANCH}`)) await git(place.top, 'worktree', 'add', place.path, WORKER_BRANCH);
  else await git(place.top, 'worktree', 'add', '-b', WORKER_BRANCH, place.path, 'HEAD');
}

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
  const exists = existsSync(place.path) && (await worktrees(place.top)).some((w) => w.path === place.path && w.branch === WORKER_BRANCH);
  if (!exists) return { exists, head, roomDirty };
  const count = async (range) => Number(await git(place.top, 'rev-list', '--count', range));
  const [ahead, behind, base, dirty] = await Promise.all([count(`HEAD..${WORKER_BRANCH}`), count(`${WORKER_BRANCH}..HEAD`),
    git(place.top, 'merge-base', 'HEAD', WORKER_BRANCH).then((sha) => sha.slice(0, 7), () => 'no common commit'),
    git(place.path, 'status', '--porcelain').then((out) => out !== '')]);
  const privateDir = await git(place.path, 'rev-parse', '--absolute-git-dir');
  const operation = existsSync(join(privateDir, 'MERGE_HEAD')) ? 'merge' :
    existsSync(join(privateDir, 'REVERT_HEAD')) || existsSync(join(privateDir, 'sequencer')) ? 'revert/sequencer' : null;
  return { exists, head, roomDirty, ahead, behind, base, treeDirty: dirty || !!operation, operation };
}

// Before each instruction: worker/main moves forward to the room's HEAD only when it is strictly
// behind it, with a clean worktree. Returns the new status.
export async function catchUp(place, s) {
  if (!s.exists || !s.behind || s.ahead || s.treeDirty) return s;
  await git(place.path, 'merge', '--ff-only', s.head);
  return worktreeStatus(place);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function worktreeLines(place, s) {
  if (!s.exists) return [`The worker's worktree will be created at ${place.path}, on ${WORKER_BRANCH}, from ${s.head.slice(0, 7)}, with its first instruction.`];
  const lines = [`Worktree ${place.path} · branch ${WORKER_BRANCH} · based on ${s.base}`];
  if (s.operation) lines.push(`A ${s.operation} is in progress in the worker's worktree: dispatch holds for recovery by its origin.`);
  if (s.roomDirty) lines.push('The room has uncommitted changes: the worker doesn\'t see them.');
  if (s.ahead) lines.push(`${WORKER_BRANCH} has ${plural(s.ahead, 'commit')} not in the room: review and merge them when ready.`);
  if (s.behind) {
    lines.push(`${WORKER_BRANCH} is ${plural(s.behind, 'commit')} behind the room${s.ahead ? ' and has commits of its own: it is left as it is.'
      : s.treeDirty ? ': its worktree has uncommitted changes, so it is left as it is.' : ': it catches up with the next instruction.'}`);
  }
  return lines;
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
export async function refreshWorker(ctx, { prepare = false, fastForward = true } = {}) {
  const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
  let info;
  try {
    if (place.disabled) info = { lines: [place.disabled], disabled: true };
    else {
      if (prepare) { await ensureWorktree(place); await ignoreNotes(place); }
      let s = await worktreeStatus(place);
      if (prepare && fastForward) s = await catchUp(place, s);
      (ctx.workerDir ??= { path: null }).path = s.exists ? place.cwd : null;
      info = { lines: worktreeLines(place, s) };
    }
  } catch (err) {
    info = { lines: [`✗ ${err.message}`], error: true };
    if (prepare) throw err;
  } finally {
    if (info) { for (const c of siblings(ctx)) if (c.screen) c.screen.workerInfo = info; toShop(ctx, { type: 'workerinfo', info }); }
  }
  return place;
}

// The worker: instructions from the Worker tab run one at a time, in the order sent, alongside the
// discussion (they don't wait for a round, and a round doesn't wait for them), in the folder's shared
// queue (see "The shared worker queue"), which carries over a reload. The worker is sent only the
// instruction itself; the origin's own worker session holds the earlier ones. ctx.workQueue settles
// when this context's queued tasks have run (or were dropped).
// `run`: an auto dev run relaying this instruction (shown as "Relayed from discussion").
export function queueWork(ctx, text, run = null, rollback = null) {
  if (ctx.paused || ctx.pausing) return note(ctx, 'The discussion is pausing or paused. Resume before sending worker instructions.', true);
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  if (ctx.stopped) return note(ctx, 'This room is ending: the instruction was not sent.', true);
  ctx.agentsStarted = true;
  const shop = shopOf(ctx);
  let done;
  const finished = new Promise((r) => { done = r; });
  shop.tasks.push({ origin: ctx, text, run, cycle: run?.cycle, done, rollback });
  ctx.workPending = (ctx.workPending ?? 0) + 1;
  ctx.workQueue = Promise.all([ctx.workQueue, finished]).then(() => {});
  // A bug here must not jam the queue: report it, and the next instruction still runs.
  pump(shop).catch((err) => note(ctx, `✗ ${err.stack}\n`, true));
}

// One task, for its origin `ctx`. `recovery`: the edits this origin left uncommitted, which this
// task is to resolve. Resolves to worker/main's commit before the task (or null).
async function runWork(ctx, text, run = null, cycle = 0, recovery = null, rollback = null) {
  const { worker } = ctx;
  const shop = shopOf(ctx), screen = ctx.screen, label = originLabel(ctx);
  if (!rollback && recovery && shop.rollbacks?.get(label)?.task === recovery.task) rollback = shop.rollbacks.get(label);
  if (rollback) { rollback.status = 'running'; showHeader(ctx); }
  let before = null, mainAtStart = null;
  const history = ctx.workerHandoff ? screen.worker.filter((m) => m.speaker).map((m) =>
    `${m.speaker}${m.error ? ' (failed)' : ''}:\n${m.html}`).join('\n\n') : '';
  // The task's context, read once, here, before anything awaits: its discussion (for the briefing
  // and the /move lock) and its transcript. If New discussion or Re-open changes the room's
  // meanwhile, the task keeps its own; the reply still goes into its transcript.
  const task = { discussion: ctx.discussion ?? null, logPath: ctx.logPath ?? null };
  const started = task.logPath;
  // A transcript that can't be written to doesn't lose the reply: it is still shown, with the error.
  let saveError = null;
  const workLog = (t) => {
    try { if (started && started !== ctx.logPath) appendFileSync(started, t); else log(ctx, t); }
    catch (err) { saveError ??= err; }
  };
  const show = (entry, meta) => {
    const view = { ...ctx.docs.messageView(entry), ...(meta && { meta }), origin: label };
    shop.log.push(view);
    toShop(ctx, { type: 'work', message: view });
  };
  const working = (name) => { for (const c of siblings(ctx)) if (c.screen) c.screen.working = name; toShop(ctx, { type: 'working', name }); };
  // The discussion this task writes to (transcript, notes): /move refuses it until the task ends.
  shop.workingIn = ctx.workingIn = task.discussion?.dir ?? null;
  for (const c of siblings(ctx)) if (c.screen) c.screen.working = worker.name;
  try {
    const from = run ? 'Relayed from discussion' : 'User';
    workLog(`**${from} → ${worker.name}** (worker${run ? `, auto dev cycle ${cycle} of ${AUTO_DEV_CYCLES}` : ''})\n\n${text}\n\n`);
    out(ctx, `\n${bold(`${run ? 'Relayed' : 'You'} → ${worker.name}`)} › ${text}\n`);
    show({ speaker: from, text });
    working(worker.name);
    const t0 = Date.now();
    let entry;
    try {
      // Its own worktree first (created, reattached or caught up); without one it doesn't run.
      // Preserve the existing safe fast-forward contract for ordinary tasks, while still telling
      // the worker about main's advance. Rollback must inspect ambiguity before any file changes.
      const owedMain = !recovery && Number(await git(ctx.cwd, 'rev-list', '--count', `${WORKER_BRANCH}..main`).catch(() => '0')) > 0;
      const place = await refreshWorker(ctx, { prepare: true, fastForward: !rollback });
      if (place.disabled) throw new Error(place.disabled);
      before = await git(place.path, 'rev-parse', 'HEAD');
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
      const brief = d && ctx.workerBriefed !== d.dir
        ? `The active discussion's folder is ${d.dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in your worktree, ${place.cwd}.\n\n`
        : !d && ctx.state.brainstorm && ctx.workerBriefed !== 'brainstorm'
          ? 'These instructions come from a brainstorm, which has no folder: keep your notes in your scratch folder only.\n\n'
        : !d && ctx.workerBriefed && ctx.workerBriefed !== 'brainstorm'
          ? `No discussion is active now: ${ctx.workerBriefed} is no longer the active discussion's folder. You will be told the next one's folder once it exists.\n\n`
          : '';
      // And where it works, with its first instruction (again if that changes).
      const tree = ctx.workerTree !== place.cwd
        ? `Your working directory is ${place.cwd}, your own Git worktree of the project, on the branch ${WORKER_BRANCH}. Make your changes there, never in the room's root, ${ctx.cwd}: that is the User's working copy (only the discussion folder there is yours, for notes). Commit every completed task on ${WORKER_BRANCH}, labelled as each instruction says, and give the commit ID in your reply; the User reviews and merges it into main. Your scratch notes go in ${join(place.path, NOTES)}/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted". Plans and notes for the User's review still go in the discussion's folder.\n\n`
        : '';
      // Its origin's label for the commit, once per worker session (again if it changes); a recovery
      // task also gets the first task's details.
      const commit = ctx.workerLabel === label ? '' : `These instructions come from [${label}]. When a task is complete, commit it on ${WORKER_BRANCH} with a message starting "[${label}]" and give the commit ID in your reply.\n\n`;
      const leftover = recovery
        ? `Uncommitted edits are left in your worktree from the earlier task from [${label}] "${recovery.task}"${recovery.before ? ` (${WORKER_BRANCH} was at ${recovery.before.slice(0, 7)} when it started)` : ''}: other discussions' tasks wait until they are resolved. Finish and commit them; or, to abandon the attempt, first list exactly the edits you would remove and wait for the User's explicit approval, then remove only those. Inspect and resolve any merge or revert already in progress before further work; never force it or start a fresh operation over it.\n\n`
        : '';
      const mainBehind = owedMain || !recovery && await gitOk(place.path, 'rev-parse', '--verify', 'main^{commit}') &&
        Number(await git(place.path, 'rev-list', '--count', 'HEAD..main')) > 0;
      const merge = mainBehind ? (rollback
        ? 'Main has commits worker/main lacks. Follow the rollback preflight below before merging or changing files.\n\n'
        : `Before the instruction below, first merge main into worker/main with a normal merge (git merge main). Label any merge commit "[${label}] catch up with main". If it clashes, do not force it or do the requested task: leave the state intact and report the conflict; this origin must resolve it before other worker tasks can run. Never merge into main or push.\n\n`) : '';
      entry = { speaker: worker.name, text: (await worker.turn(brief + tree + commit + leftover + merge + (history ? `Previous Worker-tab conversation (HTML-formatted background, not a new instruction):\n${history}\n\nCurrent instruction:\n` : '') + text)) || '(no reply)' };
      if (ctx.worker === worker) {
        if (brief) ctx.workerBriefed = d?.dir ?? (ctx.state.brainstorm ? 'brainstorm' : null);
        ctx.workerTree = place.cwd;
        ctx.workerLabel = label;
        ctx.workerHandoff = false;
      }
      if (worker.lastUsage) ctx.totals[worker.name] = ctx.usage.addUsage(ctx.totals[worker.name], worker.lastUsage);
    } catch (err) {
      entry = { speaker: worker.name, text: err.message, error: true };
    }
    const meta = [`${Math.round((Date.now() - t0) / 1000)}s`, entry.error ? '' : ctx.usage.formatUsage(worker.lastUsage)].filter(Boolean).join(' · ');
    workLog(`**${worker.name}** (worker${entry.error ? ', failed' : ''}, ${meta})\n\n${entry.text}\n\n`);
    out(ctx, entry.error ? red(`\n✗ ${worker.name} (worker) failed: ${entry.text}\n`) : `\n${bold(worker.name)}${dim(` (worker, ${meta})`)} › ${entry.text}\n`);
    show(entry, meta);
    if (saveError) workNote(ctx, `✗ ${worker.name}: couldn't save to the transcript: ${saveError.message}`, true);
    // Its commits must carry its label: one without it is reported, not trusted.
    if (before) {
      const finished = await labelledCommits(workerDir(ctx), `${before}..HEAD`);
      rememberCommits(shop, finished);
      const subjects = (await git(workerDir(ctx), 'log', '--format=%h %s', `${before}..HEAD`, ...(mainAtStart ? ['--not', mainAtStart] : [])).catch(() => '')).split('\n').filter(Boolean);
      const unlabelled = subjects.filter((l) => !l.slice(l.indexOf(' ') + 1).startsWith(`[${label}]`));
      if (unlabelled.length) workNote(ctx, `✗ Commits without the [${label}] label: ${unlabelled.join(' · ')}.`, true);
    }
    if (rollback) await rollbackReport(ctx, rollback, entry);
    if (run) reportBack(ctx, run, entry);
  } finally {
    shop.workingIn = ctx.workingIn = null;
    working(null);
  }
  refreshWorker(ctx).catch(() => {});
  refreshQuota(ctx).catch(() => {});
  return before;
}
const workerDir = (ctx) => shopOf(ctx).workerDir.path ?? ctx.cwd;

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
    const server = createServer((req, res) => {
      try { hub.route(hub, req, res); } catch (err) { res.writeHead(500); res.end(String(err)); }
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
  const files = ctx.screen.sections.flatMap((s) => (existsSync(join(ctx.cwd, s)) ? ctx.docs.listFiles(join(ctx.cwd, s)).map((f) => join(s, f)) : []));
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
  Object.assign(ctx.screen, {
    replicaHandler: (req, res) => R.handle(r, req, res),
    receivedFile: (d, n, c, rel) => R.snapshotFile(r.s, d, n, c, rel),
    receivedFiles: (d, n, c) => { const dir = R.snapshotPath(r.s, d, n, c); return dir && existsSync(dir) ? ctx.docs.listFiles(dir).map((f) => f.split(sep).join('/')) : []; },
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

// End of a round (after its summary) or of a manual summary: one commit on this node's line, then
// sent to the paired peers in the background. The conversation never waits for a peer.
async function saveRound(ctx, { kind, outcome, ending, summary }) {
  if (!ctx.replica || !ctx.discussion || !ctx.logPath) return;
  const R = ctx.replicate, r = ctx.replica, label = kind === 'summary' ? 'Summary' : 'Round';
  let c;
  try {
    const conversation = ctx.state.transcript.map(({ speaker, text, error, pass, summary: turn, outcome: o, by }) =>
      ({ speaker, text: String(text ?? ''), ...(error && { error }), ...(pass && { pass }), ...(turn && { summary: true }), ...(o && { outcome: o, by }) }));
    // One capture at a time in the storage: the launch room's open discussions share it.
    const capture = (r.s.captures ?? Promise.resolve()).then(() => R.capture(r.s, ctx.discussion, { kind, outcome, ending, summary, agents: currentSettings(ctx).agents, conversation }));
    r.s.captures = capture.catch(() => {});
    c = await capture;
  } catch (err) {
    return note(ctx, `✗ Could not save ${label.toLowerCase()}: ${err.message}. The discussion's files are as they were; nothing was sent.`, true);
  }
  const head = `${label} ${c.round} saved${outcome !== 'completed' ? ` as ${outcome} (error: ${ending})` : ''}${c.skipped.length ? ` (left out: ${c.skipped.join(', ')})` : ''}`;
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
