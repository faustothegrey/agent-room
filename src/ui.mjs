// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: agent-room [--agents claude,codex] [--worker claude:Worker] [--cwd DIR] [--port 5566] [--no-screen] [--open]

Each agent is provider[:name[:model]], e.g. --agents claude:Ada:opus,codex:Linus
Without saved defaults: discussion claude,codex; worker claude:Worker.
The provider/model sections in the Discussion and Worker tabs save changes automatically to
~/.config/agent-room/defaults.json. CLI flags override the corresponding defaults for this launch.
Settings changes apply to this room only before discussion, summary or worker work starts;
after that they set defaults for future rooms.
The worker (the screen's Worker tab) is one more agent, outside the discussion: it carries out the
instructions sent from that tab, sees only those (and the active discussion's folder, for its
notes), and can edit files and run commands.
By default (npm start) the room is used from the discussion screen in the browser; the terminal
only shows a log. --no-screen (or npm run terminal): the room is used from the terminal instead,
and /docs opens each file alone in the browser.
--open opens the discussion screen even without an interactive terminal (for a Dock launcher).
--port: the screen's port on 127.0.0.1 (default 5566); if it is taken, any free port is used.
The --cwd folder is the room's root. Opening it writes nothing: the first message starts a new
discussion in DIR/discussions/<date>-<title>/ (its documents, drawings and transcripts/), unless
/reopen <name> picked an existing one first.
Type a message to start a round; start it with @name to address one agent.
Commands: /docs (pick a document to view in the browser), /reopen <name> (re-open that
discussion: a fresh session there, starting from its handoff), /summary (the agents agree a short
summary by points; only the result is shown), /autosummary [on|off] (a summary after every round
in which an agent spoke; on by default), /usage (tokens this session and subscription quotas),
/reload (load edited code and both agent rulebooks; conversation continues), /quit
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
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const { provider, name, model } = parseSpec(spec);
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    return createAgent(provider, { name, model, cwd: ctx.cwd, instructions, session: ctx.sessions.get(name) });
  });
  // The worker's session is kept under its own key, so it never mixes with a room agent's.
  const { provider: wProvider, name: wName, model: wModel } = parseSpec(ctx.workerSpec, true);
  if (agents.some((a) => a.name === wName)) throw new Error(`The worker's name "${wName}" is taken by a room agent`);
  if (!ctx.sessions.has(`worker:${wName}`)) ctx.sessions.set(`worker:${wName}`, {});
  const worker = createAgent(wProvider, { name: wName, model: wModel, cwd: ctx.cwd, instructions: workerInstructions, shell: true,
    timeoutMs: WORKER_TIMEOUT_MS, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: [], working: null };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, totals: ctx.totals ?? {}, screen, suggestTitle: claudeTitle };
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
    transcript: ctx.logPath ? relative(ctx.cwd, ctx.logPath).split(sep).join('/') : null };
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

// Creates the folder (and discussions/ if needed) and returns its name. mkdir itself is the check
// that the name is free, so two rooms naming a discussion at once can't both get it.
export function createDiscussionFolder(parent, title, now = new Date()) {
  const base = `${day(now)}-${(title && slug(title)) || hhmm(now)}`;
  mkdirSync(parent, { recursive: true });
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
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
  if (!name || /[/\\]/.test(name) || !/^\d{4}-\d{2}-\d{2}-/.test(name) || !existsSync(join(parent, name))) {
    return note(ctx, `✗ No discussion "${name}" in ${parent} (discussions are folders named <date>-<title>).`, true);
  }
  if (ctx.logPath) {
    await ctx.workQueue; // let a running worker instruction finish in this session
    log(ctx, `_(session ended: re-opening the discussion ${name})_\n\n`);
    for (const a of [...ctx.room.agents, ctx.worker]) a.reset?.();
    const { state, screen } = ctx;
    state.transcript.length = 0; // emptied in place: the room and the screen hold this array
    for (const a of ctx.room.agents) state.seen.set(a.name, 0);
    state.summaries = 0;
    state.briefing = null;
    screen.worker.length = 0;
    Object.assign(screen, { doc: null, thinking: null, working: null, status: null });
    ctx.logPath = null;
    ctx.pendingLog = '';
    ctx.agentsStarted = false;
    ctx.workerBriefed = null;
  }
  ctx.discussion = { name, dir: join(parent, name), title: name, continued: true };
  showHeader(ctx);
  toScreen(ctx, ctx.docs.resetEvent(ctx.screen)); // open pages start over with the empty chat
  note(ctx, `Re-opened the discussion ${name}: your next message starts a fresh session there; the agents start from its handoff.`);
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
  toScreen(ctx, { type: 'quota', gauges: ctx.screen.quota });
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
  console.log(`Room: ${describe(ctx.room)} · worker ${ctx.worker.name} (${ctx.worker.provider}) · root ${ctx.cwd}`);
  console.log(`Transcript: in ${join(ctx.cwd, 'discussions')}/, once the first message starts a discussion`);
  wire(ctx);
  // Calls through ctx, so after a reload it runs the new code.
  ctx.quotaTimer ??= setInterval(() => ctx.refreshQuota?.(), 60_000).unref();
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  ctx.refreshQuota();
  if (ctx.noScreen) {
    return console.log('Type a message, /docs to browse the discussions, /summary to sum up, /usage for tokens and quotas, /reload after editing the code, or /quit.\n');
  }
  ctx.screen.say = (line) => ctx.say(line);
  const screenUrl = `${await viewerUrl(ctx)}__room`;
  console.log(`Discussion screen: ${screenUrl}${tty || ctx.open ? ' (opening it in your browser)' : ''}`);
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

export function reloaded(ctx) {
  wire(ctx);
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  log(ctx, '_(code reloaded)_\n\n');
  note(ctx, 'Reloaded the code and the agents\' rulebook; the conversation continues.\n');
}

// The room is over (after /quit): screens say so and stop reconnecting.
export function ended(ctx) {
  return ctx.docs.endAll(ctx.screen, { type: 'ended' });
}

export async function handleLine(line, ctx) {
  if (!line) return;
  if (line === '/docs') return showDocs(ctx);
  const reopen = /^\/(?:reopen|continue)(?:\s+(.*))?$/.exec(line); // /continue: its former name
  if (reopen) return reopenDiscussion(ctx, (reopen[1] ?? '').trim());
  if (line === '/summary') { ctx.agentsStarted = true; return runSummary(ctx); }
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
  });
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
}

async function runRound(line, ctx) {
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  let roundUsage;
  let spoke = 0; // agent replies that weren't passes or failures
  try {
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
    });
    const secs = Math.round((Date.now() - roundStart) / 1000);
    const providers = [...new Set(ctx.room.agents.map((a) => a.provider))];
    const quota = ctx.usage.quotaSummary(await refreshQuota(ctx).catch(() => null), providers);
    const parts = [ending, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(roundUsage), quota];
    // Auto-summarize: after a round in which an agent spoke and none failed. Its own end line is
    // then the "your turn" one; this round's line is just a note.
    if (autoOn(ctx) && spoke && !ending.endsWith('failed')) {
      console.log(dim(`── round over · ${parts.filter(Boolean).join(' · ')} · summarizing ──`));
      toScreen(ctx, { type: 'note', text: `round over · ${parts.filter(Boolean).join(' · ')} · summarizing` });
      return runSummary(ctx, true);
    }
    console.log(dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
    toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
  } catch (err) {
    // An unknown @name: nothing was sent or recorded.
    note(ctx, `✗ ${err.message}`, true);
  }
}

// The worker: instructions from the Worker tab run one at a time, in the order sent, alongside the
// discussion (they don't wait for a round, and a round doesn't wait for them). The queue is in ctx,
// so it carries over a reload. The worker is sent only the instruction itself; its CLI session holds
// the earlier ones.
export function queueWork(ctx, text) {
  ctx.agentsStarted = true;
  // A bug here must not jam the queue: report it, and the next instruction still runs.
  ctx.workQueue = (ctx.workQueue ?? Promise.resolve()).then(() => runWork(ctx, text))
    .catch((err) => note(ctx, `✗ ${err.stack}\n`, true));
}

async function runWork(ctx, text) {
  const { worker, screen } = ctx;
  const show = (entry, meta) => {
    const view = { ...ctx.docs.messageView(entry), ...(meta && { meta }) };
    screen.worker.push(view);
    toScreen(ctx, { type: 'work', message: view });
  };
  log(ctx, `**User → ${worker.name}** (worker)\n\n${text}\n\n`);
  console.log(`\n${bold(`You → ${worker.name}`)} › ${text}\n`);
  show({ speaker: 'User', text });
  screen.working = worker.name;
  toScreen(ctx, { type: 'working', name: worker.name });
  const t0 = Date.now();
  let entry;
  try {
    // The worker learns the active discussion's folder (for its notes) with its first instruction there.
    const d = ctx.discussion;
    const brief = d && ctx.workerBriefed !== d.dir
      ? `The active discussion's folder is ${d.dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in the root, ${ctx.cwd}.\n\n`
      : '';
    entry = { speaker: worker.name, text: (await worker.turn(brief + text)) || '(no reply)' };
    if (d) ctx.workerBriefed = d.dir;
    if (worker.lastUsage) ctx.totals[worker.name] = ctx.usage.addUsage(ctx.totals[worker.name], worker.lastUsage);
  } catch (err) {
    entry = { speaker: worker.name, text: err.message, error: true };
  }
  const meta = [`${Math.round((Date.now() - t0) / 1000)}s`, entry.error ? '' : ctx.usage.formatUsage(worker.lastUsage)].filter(Boolean).join(' · ');
  log(ctx, `**${worker.name}** (worker${entry.error ? ', failed' : ''}, ${meta})\n\n${entry.text}\n\n`);
  console.log(entry.error ? red(`\n✗ ${worker.name} (worker) failed: ${entry.text}\n`) : `\n${bold(worker.name)}${dim(` (worker, ${meta})`)} › ${entry.text}\n`);
  screen.working = null;
  toScreen(ctx, { type: 'working', name: null });
  show(entry, meta);
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
    // else) has it, any free port will do, and the banner shows which.
    const listen = (port) => new Promise((ok, fail) => {
      ctx.server.once('error', fail);
      ctx.server.listen(port, '127.0.0.1', () => { ctx.server.off('error', fail); ok(); });
    });
    try {
      await listen(ctx.port ?? 5566);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      console.log(dim(`Port ${ctx.port ?? 5566} is in use; using a free port instead.`));
      await listen(0);
    }
    if (ctx.noScreen) ctx.server.unref();
  }
  return `http://127.0.0.1:${ctx.server.address().port}/`;
}

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
