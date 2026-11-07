// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: agent-room [--agents claude,codex] [--worker claude:Worker] [--cwd DIR] [--port 5566] [--no-screen] [--open] [--reopen NAME] [--dev]
                  [--node NAME [--peer NAME=http://ADDRESS:PORT ...]]

Each agent is provider[:name[:model]], e.g. --agents claude:Ada:opus,codex:Linus
Without saved defaults: discussion claude,codex; worker claude:Worker.
The provider/model sections in the Discussion and Worker tabs save changes automatically to
~/.config/agent-room/defaults.json. CLI flags override the corresponding defaults for this launch.
Settings changes apply to this room only before discussion, summary or worker work starts;
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
--port: the screen's port (default 5566), on every address of this machine, so other devices on
the LAN can open it too; if it is taken, any free port is used (with --peer, the room stops instead).
--node NAME: replicate this room's discussions under this node name: each round is saved as a Git
commit in <root>/.agent-room/ (not the project's repository). --peer NAME=http://ADDRESS:PORT
(repeatable): another node's room, to pair with once (Discussions → Peers) and send rounds to.
The --cwd folder is the room's root. Opening it writes nothing: the first message starts a new
discussion in DIR/discussions/<date>-<title>/ (its documents, drawings and transcripts/), unless
/reopen <name> (or --reopen <name> at launch) picked an existing one first.
Type a message to start a round; start it with @name to address one agent.
Commands: /docs (pick a document to view in the browser), /reopen <name> (re-open that
discussion: a fresh session there, starting from its handoff; one in archive/ or deferred/ is made
active first), /new (end this session; your next message starts a new discussion; the worker
carries on), /move <name> active|archive|deferred (move a whole discussion; not the one in use),
/summary (the agents agree a short
summary by points; only the result is shown), /autosummary [on|off] (a summary after every round
in which an agent spoke; on by default), /usage (tokens this session and subscription quotas),
/reload (load edited code and both agent rulebooks; conversation continues), /restart (screen
only: a new process on the same port, in the discussion in use, from its handoff), /quit
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
  const settings = validateSettings(value);
  const next = { ...ctx, agentSpecs: settings.agents.map(specFor).join(','), workerSpec: specFor(settings.worker), sessions: new Map(), state: { ...ctx.state, seen: new Map(ctx.state.seen) } };
  // Build first so validation/loading errors cannot replace defaults or the running room.
  const loaded = await load(next, '');
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  const applied = !ctx.agentsStarted && !ctx.logPath && !ctx.state.transcript.length && !ctx.screen.worker.length;
  if (applied) {
    Object.assign(ctx, loaded, { agentSpecs: next.agentSpecs, workerSpec: next.workerSpec, sessions: next.sessions, state: next.state });
    wire(ctx);
    showHeader(ctx);
  }
  return { applied, settings };
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
  const { createAgent, claudeTitle } = await import(`./agents.mjs${v}`);
  const { createRoom } = await import(`./room.mjs${v}`);
  const docs = await import(`./docs.mjs${v}`);
  const usage = await import(`./usage.mjs${v}`);
  // Replication is loaded only with --node.
  const replicate = ctx.node ? await import(`./replicate.mjs${v}`) : null;
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const { provider, name, model } = parseSpec(spec);
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    return createAgent(provider, { name, model, cwd: ctx.cwd, instructions, session: ctx.sessions.get(name) });
  });
  // The worker's session is kept under its own key, so it never mixes with a room agent's.
  const { provider: wProvider, name: wName, model: wModel } = parseSpec(ctx.workerSpec, true);
  if (agents.some((a) => a.name === wName)) throw new Error(`The worker's name "${wName}" is taken by a room agent`);
  if (!ctx.sessions.has(`worker:${wName}`)) ctx.sessions.set(`worker:${wName}`, {});
  // Its worktree (see refreshWorker), shared by reference so it survives reloads and settings copies.
  const workerDir = ctx.workerDir ??= { path: null };
  const worker = createAgent(wProvider, { name: wName, model: wModel, cwd: () => workerDir.path, instructions: workerInstructions, shell: true,
    timeoutMs: WORKER_TIMEOUT_MS, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: [], working: null };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, replicate, totals: ctx.totals ?? {}, screen, suggestTitle: claudeTitle };
}

const tty = process.stdout.isTTY;
const style = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = style('1');
const dim = style('2');
const red = style('31');
// Until the discussion's folder exists (at the first message), the transcript is kept in memory.
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
  ctx.screen.sections = ['discussions'];
  ctx.screen.auto = autoOn(ctx);
  if (ctx.replica) wireReplica(ctx); // its peer endpoint works in terminal mode too
  if (ctx.noScreen) return;
  ctx.screen.work = (text) => queueWork(ctx, text);
  // The screen's checkbox: applied at once, not queued behind a round, so it can stop the next summary.
  ctx.screen.setAuto = (on) => setAuto(ctx, on);
  ctx.screen.newRoom = () => newRoom(ctx);
  ctx.screen.getSettings = () => ({ settings: currentSettings(ctx), defaults: readDefaults(), models: modelChoices(), started: !!ctx.agentsStarted || !!ctx.logPath || !!ctx.state.transcript.length || !!ctx.screen.worker.length });
  ctx.screen.saveSettings = (value) => saveSettings(ctx, value);
}

// The screen's header: the full root path, the active discussion (active: its folder, under the
// root), and whether this session has started (its first message sent, so its discussion is fixed).
function header(ctx) {
  const d = ctx.discussion;
  return { folder: ctx.cwd, agents: ctx.room.agents.map((a) => a.name), worker: ctx.worker.name,
    discussion: d ? d.title : 'No discussion started',
    active: d ? `discussions/${d.name}` : null, started: !!ctx.logPath,
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null,
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
      startThinking(label);
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
        stopThinking();
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
  console.log(`Discussion: ${ctx.discussion.dir}\nTranscript: ${ctx.logPath}`);
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

// /reopen <name> (Re-open this discussion): make an existing discussion the active one. It runs
// between rounds (commands are queued). Once this session has started, the session ends first: its
// transcript is closed, the chat is cleared, and the agents and the worker get fresh CLI sessions;
// the next message starts a new session in the re-opened discussion, from its handoff. Discussions
// don't keep their own agent memory (decided by the User, 2026-11-02).
async function reopenDiscussion(ctx, name) {
  const parent = join(ctx.cwd, 'discussions');
  // A discussion is a folder named <date>-<title>; other folders there are the room's own material.
  // One in archive/ or deferred/ is made active first.
  const d = discussionRef(parent, name ?? '');
  if (!d) return note(ctx, `✗ No discussion "${name}" in ${parent} (discussions are folders named <date>-<title>).`, true);
  if (d.section && !moveDiscussion(ctx, name, 'active')) return;
  name = d.name;
  if (ctx.logPath) {
    await ctx.workQueue; // let a running worker instruction finish in this session
    endSession(ctx, `re-opening the discussion ${name}`);
    ctx.worker.reset?.();
    ctx.screen.worker.length = 0;
    ctx.screen.working = null;
    ctx.workerBriefed = null;
    ctx.workerTree = null; // its fresh session is told about its worktree again
  }
  switchTo(ctx, { name, dir: join(parent, name), title: name, continued: true });
  note(ctx, `Re-opened the discussion ${name}: your next message starts a fresh session there; the agents start from its handoff.`);
}

// Ends this room's discussion session (Re-open and New discussion): a last line in its transcript,
// which is then closed; the chat clears and the discussion agents get fresh CLI sessions. The worker
// is left alone here: Re-open resets it itself, New discussion doesn't.
function endSession(ctx, why) {
  log(ctx, `_(session ended: ${why})_\n\n`);
  for (const a of ctx.room.agents) a.reset?.();
  const { state, screen } = ctx;
  state.transcript.length = 0; // emptied in place: the room and the screen hold this array
  for (const a of ctx.room.agents) state.seen.set(a.name, 0);
  state.summaries = 0;
  state.briefing = null;
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
  if (!was && !ctx.logPath) return note(ctx, 'No discussion started yet: your next message starts a new one.');
  if (ctx.logPath) endSession(ctx, 'starting a new discussion');
  if (was && ctx.screen.worker.length) {
    const view = { note: `New discussion: ${was.name} is no longer the active one. The next instruction gets the new discussion's folder once your first message creates it.` };
    ctx.screen.worker.push(view);
    toScreen(ctx, { type: 'work', message: view });
  }
  switchTo(ctx, null);
  note(ctx, `New discussion: your next message names it and starts it.${was ? ` To go back, /reopen ${was.name}.` : ''}`);
}

// ── New room in folder… ─────────────────────────────────────────
// The Mac's own folder chooser, run by the server because it needs the full path (a browser's
// picker gives only the name). Resolves to the path, or null if the User cancelled.
function chooseFolder() {
  const script = 'POSIX path of (choose folder with prompt "Choose the folder for the new room")';
  return new Promise((done, fail) => execFile('osascript', ['-e', 'activate', '-e', script], (err, stdout, stderr) => {
    if (err) return /-128/.test(stderr) ? done(null) : fail(new Error(`the folder chooser failed: ${stderr.trim() || err.message}`));
    const path = stdout.trim();
    done(path.length > 1 ? path.replace(/\/$/, '') : path || null);
  }));
}

const freePort = () => new Promise((done, fail) => {
  const s = createNetServer().once('error', fail);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

// A separate agent-room process in the chosen folder, using saved defaults (or this room's agents
// if none are saved), on a port of its own,
// so each window keeps its own address. It runs on its own: quitting this room doesn't end it.
// Its output goes to a log file in the temp folder, shown here if it stops at once.
// Resolves to { url, folder } once it answers, or { cancelled: true }.
async function newRoom(ctx) {
  const folder = await chooseFolder();
  if (!folder) return { cancelled: true };
  const port = await freePort();
  const out = join(tmpdir(), `agent-room-${port}-${Date.now()}.log`);
  const fd = openSync(out, 'a');
  const defaults = readDefaults();
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--cwd', folder, '--agents', defaults ? defaults.agents.map(specFor).join(',') : ctx.agentSpecs,
    '--worker', defaults ? specFor(defaults.worker) : ctx.workerSpec ?? 'claude:Worker', '--port', String(port)];
  const child = spawn(process.execPath, args, { cwd: folder, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  let exited = false;
  child.once('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}/__room`;
  for (const t0 = Date.now(); Date.now() - t0 < 20_000;) {
    if (exited) throw new Error(`the new room stopped at once. Its log (${out}):\n${readFileSync(out, 'utf8').trim().slice(-800)}`);
    try {
      if ((await fetch(url)).ok) {
        log(ctx, `_(opened a new room in ${folder})_\n\n`);
        console.log(`New room in ${folder}: ${url} (log: ${out})`);
        return { url, folder };
      }
    } catch {} // not listening yet
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the new room didn't answer at ${url} within 20s. Its log: ${out}`);
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
  console.log(`Room: ${describe(ctx.room)} · worker ${ctx.worker.name} (${ctx.worker.provider}) · root ${ctx.cwd}`);
  console.log(`Transcript: in ${join(ctx.cwd, 'discussions')}/, once the first message starts a discussion`);
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
    return console.log('Type a message, /docs to browse the discussions, /summary to sum up, /usage for tokens and quotas, /reload after editing the code, or /quit.\n');
  }
  ctx.screen.say = (line) => ctx.say(line);
  const screenUrl = `${await viewerUrl(ctx)}__room`;
  console.log(`Discussion screen: ${screenUrl}${tty || ctx.open ? ' (opening it in your browser)' : ''}`);
  if (!ctx.node) for (const address of lanAddresses()) console.log(`  LAN: http://${address}:${ctx.server.address().port}/__room`);
  console.log('Use the room from the browser. This terminal only shows a log; Quit there, or Ctrl-C here, ends the room.\n');
  if (ctx.open) {
    await new Promise((done, fail) => execFile('open', [screenUrl], (err) => err ? fail(err) : done()));
  } else if (tty) browse(screenUrl);
}

const browse = (url) => execFile('open', [url], (err) => err && console.log(red(`✗ ${err.message}`)));

// Output that isn't a chat message: printed in the terminal and shown on the screen.
export function note(ctx, text, error = false) {
  console.log(error ? red(text) : text);
  toScreen(ctx, { type: 'note', text, error });
}

export async function reloaded(ctx) {
  if (ctx.node) await setupReplica(ctx).catch((err) => note(ctx, `✗ Replication: ${err.message}`, true));
  wire(ctx);
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

// The room is over (after /quit): screens say so and stop reconnecting. After /restart they wait
// for the new process instead, and reload when it answers.
export function ended(ctx, restarting = false) {
  if (ctx.replica) ctx.replicate.stopPeers(ctx.replica);
  return ctx.docs.endAll(ctx.screen, { type: restarting ? 'restarting' : 'ended' });
}

// /restart: this process frees its port and a new agent-room process takes it over, with the same
// launch flags and the discussion in use re-opened (a fresh session from its handoff, as /reopen).
// The chat in memory doesn't carry over. The new process writes where this one did (the terminal or
// the Dock app's log) and runs on its own once this one exits.
export function restartArgs(ctx, values) {
  const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--cwd', ctx.cwd, '--port', String(ctx.server.address().port)];
  if (values.agents) args.push('--agents', values.agents);
  if (values.worker) args.push('--worker', values.worker);
  if (values.dev) args.push('--dev');
  if (values.node) args.push('--node', values.node);
  for (const p of values.peer ?? []) args.push('--peer', p);
  if (ctx.discussion) args.push('--reopen', ctx.discussion.name);
  return args;
}
export async function restart(ctx, values) {
  const args = restartArgs(ctx, values);
  ctx.server.closeAllConnections();
  await new Promise((done) => ctx.server.close(done));
  spawn(process.execPath, args, { cwd: ctx.cwd, detached: true, stdio: 'inherit' }).unref();
}

export async function handleLine(line, ctx) {
  if (!line) return;
  if (line === '/docs') return showDocs(ctx);
  const reopen = /^\/(?:reopen|continue)(?:\s+(.*))?$/.exec(line); // /continue: its former name
  if (reopen) return reopenDiscussion(ctx, (reopen[1] ?? '').trim());
  if (line === '/new') return newDiscussion(ctx);
  const move = /^\/move\s+(\S+)\s+(\S+)$/.exec(line);
  if (move) return void moveDiscussion(ctx, move[1], move[2]);
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
  // The session's first message opens its discussion, unless it names an unknown agent (runRound
  // then refuses it, and nothing is created).
  const to = /^@(\w[\w-]*)/.exec(line)?.[1].toLowerCase();
  const known = !to || ctx.room.agents.some((a) => a.name.toLowerCase() === to);
  if (known) ctx.agentsStarted = true;
  if (known && !ctx.logPath && !(await openDiscussion(ctx, line))) return;
  return runRound(line, ctx);
}

// One status line per turn, rewritten every second so a long (or silently passing) turn is visible.
let ticker = null;
function startThinking(name) {
  const t0 = Date.now();
  const show = () => process.stdout.write(`\r\x1b[2K${dim(`  … ${name} is thinking (${Math.round((Date.now() - t0) / 1000)}s)`)}`);
  if (!tty) return console.log(`  … ${name} is thinking`);
  show();
  ticker = setInterval(show, 1000);
}
function stopThinking() {
  clearInterval(ticker);
  ticker = null;
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
      startThinking(label);
      setScreenThinking(ctx, label);
    },
    onMessage(m) {
      const tokens = m.usage ? ` · ${ctx.usage.formatUsage(m.usage)}` : '';
      log(ctx, `**${m.speaker}** — summary turn${m.error ? ', failed' : ''} (${((Date.now() - started) / 1000).toFixed(0)}s${tokens})\n\n${m.text}\n\n`);
      stopThinking();
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
    console.log(`\n${bold('Summary')} ${dim(`(${label})`)} ›\n${result.text}\n`);
    toScreen(ctx, { type: 'message', message: ctx.docs.messageView(result) });
  }
  if (status === 'empty' && !auto) note(ctx, 'Nothing to summarize yet.');
  if (status === 'failed') note(ctx, 'The summary stopped because a turn failed.', true);
  const secs = Math.round((Date.now() - t0) / 1000);
  const parts = [`${auto ? 'auto-summary' : 'summary'} ${status === 'failed' ? 'stopped' : status}`, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(used)];
  refreshQuota(ctx).catch(() => {});
  console.log(dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
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
        startThinking(agent.name);
        setScreenThinking(ctx, agent.name);
      },
      onMessage(m) {
        const tokens = m.usage ? ` · ${ctx.usage.formatUsage(m.usage)}` : '';
        const secs = m.speaker === 'User' ? '' : ` (${((Date.now() - started) / 1000).toFixed(0)}s${tokens})`;
        log(ctx, `**${m.speaker}**${m.error ? ' — failed' : ''}${secs}\n\n${m.text}\n\n`);
        if (m.speaker !== 'User') setScreenThinking(ctx, null);
        toScreen(ctx, { type: 'message', message: ctx.docs.messageView(m) }); // the page hides passes
        if (m.speaker === 'User') return;
        stopThinking();
        turns++;
        if (m.usage) {
          roundUsage = ctx.usage.addUsage(roundUsage, m.usage);
          ctx.totals[m.speaker] = ctx.usage.addUsage(ctx.totals[m.speaker], m.usage);
        }
        if (m.error) ending = `${m.speaker} failed`;
        if (m.pass) return; // passes are logged, not shown
        if (!m.error) spoke++;
        console.log(m.error ? red(`\n✗ ${m.speaker} failed${secs}: ${m.text}\n`) : `\n${bold(m.speaker)}${dim(secs)} › ${m.text}\n`);
      },
      onNotice(text) {
        log(ctx, `_${text}_\n\n`);
        console.log(`${text}\n`);
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
      console.log(dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      const summary = await runSummary(ctx, true);
      return await saveRound(ctx, { kind: 'round', outcome: summary === 'failed' ? 'failed' : 'completed', ending, summary });
    }
    console.log(dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
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
  const place = await workerPlace(ctx.cwd);
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
  if (ctx.screen.workerInfo?.disabled) return note(ctx, `✗ ${ctx.screen.workerInfo.lines[0]} The instruction was not sent.`, true);
  ctx.agentsStarted = true;
  // A bug here must not jam the queue: report it, and the next instruction still runs.
  ctx.workQueue = (ctx.workQueue ?? Promise.resolve()).then(() => runWork(ctx, text))
    .catch((err) => note(ctx, `✗ ${err.stack}\n`, true));
}

async function runWork(ctx, text) {
  const { worker, screen } = ctx;
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
    console.log(`\n${bold(`You → ${worker.name}`)} › ${text}\n`);
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
      entry = { speaker: worker.name, text: (await worker.turn(brief + tree + text)) || '(no reply)' };
      if (brief) ctx.workerBriefed = d?.dir ?? null;
      ctx.workerTree = place.cwd;
      if (worker.lastUsage) ctx.totals[worker.name] = ctx.usage.addUsage(ctx.totals[worker.name], worker.lastUsage);
    } catch (err) {
      entry = { speaker: worker.name, text: err.message, error: true };
    }
    const meta = [`${Math.round((Date.now() - t0) / 1000)}s`, entry.error ? '' : ctx.usage.formatUsage(worker.lastUsage)].filter(Boolean).join(' · ');
    workLog(`**${worker.name}** (worker${entry.error ? ', failed' : ''}, ${meta})\n\n${entry.text}\n\n`);
    console.log(entry.error ? red(`\n✗ ${worker.name} (worker) failed: ${entry.text}\n`) : `\n${bold(worker.name)}${dim(` (worker, ${meta})`)} › ${entry.text}\n`);
    show(entry, meta);
    if (saveError) {
      const view = { note: `✗ ${worker.name}: couldn't save to the transcript: ${saveError.message}`, error: true };
      screen.worker.push(view);
      toScreen(ctx, { type: 'work', message: view });
      console.log(red(view.note));
    }
  } finally {
    ctx.workingIn = null;
    screen.working = null;
    toScreen(ctx, { type: 'working', name: null });
  }
  refreshWorker(ctx).catch(() => {});
  refreshQuota(ctx).catch(() => {});
}

// The document viewer and discussion screen: a local-only HTTP server kept in ctx, started at
// start-up in UI mode and on the first /docs in terminal mode. It calls ctx.docs on every request,
// so a reload applies to it too. Its connections (open screens hold one) never keep the process
// alive; in terminal mode the server doesn't either, while in UI mode it is the room's input.
async function viewerUrl(ctx) {
  if (!ctx.server) {
    ctx.server = createServer((req, res) => {
      // The root, limited to ctx.screen.sections (discussions/).
      try { ctx.docs.handle(req, res, ctx.cwd, ctx.screen); } catch (err) { res.writeHead(500); res.end(String(err)); }
    });
    ctx.server.on('connection', (socket) => socket.unref());
    // The fixed port gives the screen the same address every time; if another room (or anything
    // else) has it, any free port will do, and the banner shows which. With --peer the room stops
    // instead: its peers know it by that port. It listens on every address (the LAN too).
    const listen = (port) => new Promise((ok, fail) => {
      ctx.server.once('error', fail);
      ctx.server.listen(port, '0.0.0.0', () => { ctx.server.off('error', fail); ok(); });
    });
    const port = ctx.port ?? 5566;
    try {
      // On macOS a listener on 127.0.0.1 alone doesn't stop one on 0.0.0.0 (measured), and would
      // keep answering 127.0.0.1: so the port counts as taken when something answers there.
      if (port && await answers(port)) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
      await listen(port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (ctx.peers?.length) throw new Error(`Port ${port} is in use. With --peer this room must listen on its configured port, where its peers reach it: stop whatever uses ${port}, or choose another --port (and tell the peers).`);
      console.log(dim(`Port ${port} is in use; using a free port instead.`));
      await listen(0);
    }
    if (ctx.noScreen) ctx.server.unref();
  }
  return `http://127.0.0.1:${ctx.server.address().port}/`;
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
  const base = await viewerUrl(ctx);
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
    activity: () => (ctx.busy ? 'running a round' : 'idle'), project: () => ctx.project ?? null, log: (t) => console.log(red(t)) });
  r.changed = () => pushReplica(ctx);
  r.onReceived = (p) => { note(ctx, `Received ${p.node}'s ${p.kind} ${p.round} of "${p.title}".`); pushReplica(ctx); };
  r.onSent = (x) => { if (x.late) R.lineRound(r.s, x.acked).then((n) => note(ctx, `Round ${n} sent to ${x.peer} ✓`), () => {}); };
  if (!first) return;
  const port = ctx.server.address().port, rec = r.s.recovered;
  console.log(`agent-room on ${ctx.node}, listening on 0.0.0.0:${port} · ${r.git ?? 'git not found'}`);
  for (const a of lanAddresses()) console.log(`  open:  http://${a}:${port}/__room`);
  console.log(`  peers: ${ctx.peers.length ? ctx.peers.map((p) => `${p.name} ${p.url.replace(/^http:\/\//, '')}`).join(', ') : 'none'}`);
  if (rec.tmp + rec.snapshots + rec.incomingRefs + rec.refRepaired) console.log(`  recovered an interrupted receive: ${JSON.stringify(rec)}`);
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
  const port = ctx.server?.address()?.port;
  return { node: ctx.node, addresses: lanAddresses().map((a) => `${a}:${port}`), roomId: room.roomId, project: ctx.project ?? null, own, received, peers };
}
async function pushReplica(ctx) {
  if (!ctx.replica) return;
  try {
    const status = await replicaStatus(ctx), before = ctx.screen.replica?.peers ?? [];
    for (const p of status.peers) {
      const was = before.find((b) => b.name === p.name);
      if (p.reachable !== null && was?.reachable !== p.reachable) console.log(dim(`Peer ${p.name}: ${p.reachable ? `reachable${p.paired ? ', paired' : ', not paired yet'}` : `unreachable (${p.error})`}`));
    }
    ctx.screen.replica = status;
    toScreen(ctx, { type: 'replica', replica: status });
  } catch (err) { console.log(red(`✗ replication status: ${err.message}`)); }
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
