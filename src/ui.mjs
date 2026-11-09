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
/summary (the agents agree a short
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
  if (!applied) {
    // Validate against the running discussion names, not just future defaults.
    if (ctx.room.agents.some((a) => a.name.toLowerCase() === settings.worker.name.toLowerCase()))
      throw new Error('The worker needs a different name from the running discussion agents.');
    next.sessions = new Map(ctx.sessions);
    if (freshWorker) next.sessions.set(`worker:${settings.worker.name}`, {});
  }
  const loaded = await load(next, '');
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  if (applied) {
    Object.assign(ctx, loaded, { agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, sessions: next.sessions, state: next.state });
    wire(ctx);
    showHeader(ctx);
  } else if (workerChanged) {
    ctx.worker = loaded.worker;
    ctx.workerSpec = next.workerSpec;
    ctx.sessions.set(`worker:${settings.worker.name}`, next.sessions.get(`worker:${settings.worker.name}`));
    if (freshWorker) {
      ctx.workerBriefed = null;
      ctx.workerTree = null;
      ctx.workerHandoff = true;
    }
    showHeader(ctx);
  }
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
  // Its worktree (see refreshWorker), shared by reference so it survives reloads and settings copies.
  const workerDir = ctx.workerDir ??= { path: null };
  const worker = createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions, shell: true,
    timeoutMs: WORKER_TIMEOUT_MS, runner, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: [], working: null };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, replicate, totals: ctx.totals ?? {}, screen,
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
  ctx.screen.work = (text) => queueWork(ctx, text);
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
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null,
    paused: !!ctx.paused, pausedSessions: pausedSessions(ctx),
    back: ctx.previous ?? null, // the discussion before the last switch, until the next one starts
    code: ctx.code ?? null }; // the version this process runs (see codeInfo)
}
function showHeader(ctx) {
  ctx.screen.room = header(ctx);
  toScreen(ctx, { type: 'room', room: ctx.screen.room });
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
function moveDiscussion(ctx, ref, to) {
  const parent = join(ctx.cwd, 'discussions');
  const d = discussionRef(parent, ref ?? '');
  if (!d) return note(ctx, `✗ No discussion "${ref}" in ${parent}.`, true), null;
  const target = to === 'active' ? null : to;
  if (to !== 'active' && !SECTIONS.includes(to)) return note(ctx, '✗ Move it to active, archive or deferred.', true), null;
  if (d.section === target) return { name: d.name }; // already there
  const from = join(parent, d.section ?? '', d.name);
  if (ctx.discussion?.dir === from) return note(ctx, `✗ ${d.name} is the discussion in use in this room: it can't move now.`, true), null;
  if (pausedSessions(ctx).some((p) => p.name === d.name)) return note(ctx, '✗ Resume the paused discussion before moving it.', true), null;
  if (ctx.workingIn === from) return note(ctx, `✗ A worker task is still writing to ${d.name}; try again when it finishes.`, true), null;
  const dest = join(parent, target ?? '', d.name);
  if (existsSync(dest)) return note(ctx, `✗ There is already a discussion ${d.name} in ${target ?? 'discussions'}/.`, true), null;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(from, dest);
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
  if (!ctx.paused && !brainstorm && (ctx.logPath || ctx.state.transcript.length || ctx.screen.worker.length || ctx.screen.working))
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
      screen: { ...ctx.screen, transcript: saved.state.transcript, worker: saved.worker, doc: saved.doc,
        thinking: null, working: null, status: null }, agentsStarted: true,
      workerDir: { path: null } };
    // Build before consuming the checkpoint; a failed load leaves it available for retry.
    const loaded = await load(next, `?resume=${Date.now()}`);
    unlinkSync(file);
    const { root, version, at, worker: workerLog, ...restored } = saved;
    Object.assign(ctx, restored, loaded, { state: next.state, sessions: next.sessions,
      paused: false, agentsStarted: true, workerDir: next.workerDir, previous: null });
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
  if (d.section && !moveDiscussion(ctx, name, 'active')) return;
  name = d.name;
  const checkpoint = pauseFile(ctx, name);
  if (existsSync(checkpoint)) unlinkSync(checkpoint); // Re-open explicitly starts fresh.
  if (ctx.logPath) {
    await ctx.workQueue; // let a running worker instruction finish in this session
    endSession(ctx, `re-opening the discussion ${name}`);
    ctx.worker.reset?.();
    ctx.screen.worker.length = 0;
    ctx.screen.working = null;
    ctx.workerBriefed = null;
    ctx.workerTree = null; // its fresh session is told about its worktree again
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
    ctx.workerBriefed = ctx.workerTree = null;
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
    ctx.workerBriefed = ctx.workerTree = null;
    ctx.workerHandoff = false;
  }
  if (ctx.logPath || ctx.state.brainstorm) endSession(ctx, 'starting a brainstorm');
  ctx.state.brainstorm = true;
  ctx.state.briefing = `This is a brainstorm, not a discussion: it has no folder and agent-room keeps no record of it. Write no files; you may read the project in the room's root, ${ctx.cwd}.`;
  ctx.pendingLog = '';
  switchTo(ctx, null);
  note(ctx, `New brainstorm: agent-room keeps no record of it, and Restart or Quit room loses it.${was ? ` To go back, /reopen ${was.name}.` : ''}`);
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
  if (ctx.noScreen) {
    return out(ctx, 'Type a message, /docs to browse the discussions, /summary to sum up, /usage for tokens and quotas, /reload after editing the code, or /quit.\n');
  }
  ctx.screen.say = (line, confirmed) => ctx.say(line, confirmed);
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
  if (ctx.replica) ctx.replicate.stopPeers(ctx.replica);
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
  const [first, ...rest] = rooms;
  const reopen = (r) => (r.discussion && !r.paused ? r.discussion.name : null);
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--cwd', first.cwd, '--port', String(port)];
  if (first.agentSpecs) args.push('--agents', first.agentSpecs);
  if (first.workerSpec) args.push('--worker', first.workerSpec);
  if (values.dev) args.push('--dev');
  if (values.node && first.launch !== false) {
    args.push('--node', values.node);
    for (const p of values.peer ?? []) args.push('--peer', p);
  }
  if (reopen(first)) args.push('--reopen', reopen(first));
  for (const r of rest) args.push('--room', JSON.stringify({ cwd: r.cwd, agents: r.agentSpecs, worker: r.workerSpec, ...(reopen(r) && { reopen: reopen(r) }) }));
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
  if (reopen) return reopenDiscussion(ctx, (reopen[1] ?? '').trim());
  if (line === '/pause') return pauseDiscussion(ctx);
  const resume = /^\/resume(?:\s+(.*))?$/.exec(line);
  if (resume) return resumeDiscussion(ctx, (resume[1] ?? '').trim());
  if (line === '/new') return newDiscussion(ctx);
  if (line === '/brainstorm') return newBrainstorm(ctx);
  const move = /^\/move\s+(\S+)\s+(\S+)$/.exec(line);
  if (move) return void moveDiscussion(ctx, move[1], move[2]);
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
async function runSummary(ctx, auto = false) {
  const t0 = Date.now();
  let started = 0;
  let turns = 0;
  let used;
  log(ctx, auto ? '_(auto-summary)_\n\n' : '_(summary requested)_\n\n');
  ctx.busy = true;
  const { status, result } = await ctx.room.summary({
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
  }
  if (status === 'empty' && !auto) note(ctx, 'Nothing to summarize yet.');
  if (status === 'failed') note(ctx, 'The summary stopped because a turn failed.', true);
  const secs = Math.round((Date.now() - t0) / 1000);
  const parts = [`${auto ? 'auto-summary' : 'summary'} ${status === 'failed' ? 'stopped' : status}`, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(used)];
  refreshQuota(ctx).catch(() => {});
  out(ctx, dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
  toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
  return status;
}

async function runRound(line, ctx) {
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  let roundUsage;
  let spoke = 0; // agent replies that weren't passes or failures
  try {
    ctx.busy = true;
    await ctx.room.round(line, {
      onTurnStart(agent) {
        started = Date.now();
        startThinking(ctx, agent.name);
        setScreenThinking(ctx, agent.name);
      },
      onMessage(m) {
        const tokens = m.usage ? ` · ${ctx.usage.formatUsage(m.usage)}` : '';
        const secs = m.speaker === 'User' ? '' : ` (${((Date.now() - started) / 1000).toFixed(0)}s${tokens})`;
        log(ctx, `**${m.speaker}**${m.error ? ' — failed' : ''}${secs}\n\n${m.text}\n\n`);
        if (m.speaker !== 'User') setScreenThinking(ctx, null);
        toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) }); // the page hides passes
        if (m.speaker === 'User') return;
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
    // Auto-summarize: after a round in which an agent spoke and none failed. Its own end line is
    // then the "your turn" one; this round's line is just a note.
    if (autoOn(ctx) && spoke && !ending.endsWith('failed')) {
      out(ctx, dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      const summary = await runSummary(ctx, true);
      return await saveRound(ctx, { kind: 'round', outcome: summary === 'failed' ? 'failed' : 'completed', ending, summary });
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
// Reload (read back from Git; agent-room stores nothing). The only Git writes are `worktree add` and
// a fast-forward of worker/main when it has nothing of its own: never a reset, merge, rebase or
// deletion, and never anything in the room's own working copy. Decided by the User, 2026-11-07.
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
  const [ahead, behind, base, treeDirty] = await Promise.all([count(`HEAD..${WORKER_BRANCH}`), count(`${WORKER_BRANCH}..HEAD`),
    git(place.top, 'merge-base', 'HEAD', WORKER_BRANCH).then((sha) => sha.slice(0, 7), () => 'no common commit'),
    git(place.path, 'status', '--porcelain').then((out) => out !== '')]);
  return { exists, head, roomDirty, ahead, behind, base, treeDirty };
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
export async function refreshWorker(ctx, { prepare = false } = {}) {
  const place = await sharedWorktree(ctx, await workerPlace(ctx.cwd));
  let info;
  try {
    if (place.disabled) info = { lines: [place.disabled], disabled: true };
    else {
      if (prepare) { await ensureWorktree(place); await ignoreNotes(place); }
      let s = await worktreeStatus(place);
      if (prepare) s = await catchUp(place, s);
      (ctx.workerDir ??= { path: null }).path = s.exists ? place.cwd : null;
      info = { lines: worktreeLines(place, s) };
    }
  } catch (err) {
    info = { lines: [`✗ ${err.message}`], error: true };
    if (prepare) throw err;
  } finally {
    if (info) { ctx.screen.workerInfo = info; toScreen(ctx, { type: 'workerinfo', info }); }
  }
  return place;
}

// The worker: instructions from the Worker tab run one at a time, in the order sent, alongside the
// discussion (they don't wait for a round, and a round doesn't wait for them). The queue is in ctx,
// so it carries over a reload. The worker is sent only the instruction itself; its CLI session holds
// the earlier ones.
export function queueWork(ctx, text) {
  if (ctx.paused || ctx.pausing) return note(ctx, 'The discussion is pausing or paused. Resume before sending worker instructions.', true);
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  if (ctx.stopped) return note(ctx, 'This room is ending: the instruction was not sent.', true);
  ctx.agentsStarted = true;
  // A bug here must not jam the queue: report it, and the next instruction still runs. Once the
  // room is ending (Quit room), queued instructions are not started.
  ctx.workPending = (ctx.workPending ?? 0) + 1;
  ctx.workQueue = (ctx.workQueue ?? Promise.resolve()).then(() => {
    ctx.workPending--;
    if (ctx.stopped) { ctx.workSkipped = (ctx.workSkipped ?? 0) + 1; return; }
    return runWork(ctx, text);
  }).catch((err) => note(ctx, `✗ ${err.stack}\n`, true));
}

async function runWork(ctx, text) {
  const { worker, screen } = ctx;
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
    const view = { ...ctx.docs.messageView(entry), ...(meta && { meta }) };
    screen.worker.push(view);
    toScreen(ctx, { type: 'work', message: view });
  };
  // The discussion this task writes to (transcript, notes): /move refuses it until the task ends.
  ctx.workingIn = task.discussion?.dir ?? null;
  screen.working = worker.name;
  try {
    workLog(`**User → ${worker.name}** (worker)\n\n${text}\n\n`);
    out(ctx, `\n${bold(`You → ${worker.name}`)} › ${text}\n`);
    show({ speaker: 'User', text });
    toScreen(ctx, { type: 'working', name: worker.name });
    const t0 = Date.now();
    let entry;
    try {
      // Its own worktree first (created, reattached or caught up); without one it doesn't run.
      const place = await refreshWorker(ctx, { prepare: true });
      if (place.disabled) throw new Error(place.disabled);
      // The worker learns the active discussion's folder (for its notes) with its first instruction there.
      // After New discussion, until the next one exists, it learns only that the old one is closed.
      const d = task.discussion;
      const brief = d && ctx.workerBriefed !== d.dir
        ? `The active discussion's folder is ${d.dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in your worktree, ${place.cwd}.\n\n`
        : !d && ctx.workerBriefed
          ? `No discussion is active now: ${ctx.workerBriefed} is no longer the active discussion's folder. You will be told the next one's folder once it exists.\n\n`
          : '';
      // And where it works, with its first instruction (again if that changes).
      const tree = ctx.workerTree !== place.cwd
        ? `Your working directory is ${place.cwd}, your own Git worktree of the project, on the branch ${WORKER_BRANCH}. Make your changes there, never in the room's root, ${ctx.cwd}: that is the User's working copy (only the discussion folder there is yours, for notes). Commit on ${WORKER_BRANCH} only when asked; the User reviews and merges it. Your scratch notes go in ${join(place.path, NOTES)}/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted". Plans and notes for the User's review still go in the discussion's folder.\n\n`
        : '';
      entry = { speaker: worker.name, text: (await worker.turn(brief + tree + (history ? `Previous Worker-tab conversation (HTML-formatted background, not a new instruction):\n${history}\n\nCurrent instruction:\n` : '') + text)) || '(no reply)' };
      if (ctx.worker === worker) {
        if (brief) ctx.workerBriefed = d?.dir ?? null;
        ctx.workerTree = place.cwd;
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
    if (saveError) {
      const view = { note: `✗ ${worker.name}: couldn't save to the transcript: ${saveError.message}`, error: true };
      screen.worker.push(view);
      toScreen(ctx, { type: 'work', message: view });
      out(ctx, red(view.note));
    }
  } finally {
    ctx.workingIn = null;
    screen.working = null;
    toScreen(ctx, { type: 'working', name: null });
  }
  refreshWorker(ctx).catch(() => {});
  refreshQuota(ctx).catch(() => {});
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
async function setupReplica(ctx) {
  const R = ctx.replicate, first = !ctx.replicaState?.s;
  ctx.replicaState ??= {};
  const r = ctx.replica = await R.createReplica({ root: ctx.cwd, node: ctx.node, peers: ctx.peers, state: ctx.replicaState,
    activity: () => (ctx.busy ? 'running a round' : 'idle'), project: () => ctx.project ?? null, log: (t) => out(ctx, red(t)) });
  r.changed = () => pushReplica(ctx);
  r.onReceived = (p) => { note(ctx, `Received ${p.node}'s ${p.kind} ${p.round} of "${p.title}".`); pushReplica(ctx); };
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
    c = await R.capture(r.s, ctx.discussion, { kind, outcome, ending, summary, agents: currentSettings(ctx).agents, conversation });
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
