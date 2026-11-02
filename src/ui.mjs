// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const USAGE = `Usage: agent-room [--agents claude,codex] [--worker claude:Worker] [--cwd DIR] [--log-dir DIR] [--port 5566] [--no-screen] [--open]

Each agent is provider[:name], e.g. --agents claude:Ada,codex:Linus
The worker (the screen's Worker tab) is one more agent, outside the discussion: it carries out the
instructions sent from that tab, sees only those, and can edit files and run commands.
By default (npm start) the room is used from the discussion screen in the browser; the terminal
only shows a log. --no-screen (or npm run terminal): the room is used from the terminal instead,
and /docs opens each file alone in the browser.
--open opens the discussion screen even without an interactive terminal (for a Dock launcher).
--port: the screen's port on 127.0.0.1 (default 5566); if it is taken, any free port is used.
Type a message to start a round; start it with @name to address one agent.
Commands: /docs (pick a proposal/ file to view in the browser), /summary (the agents agree a short
summary by points; only the result is shown), /autosummary [on|off] (a summary after every round
in which an agent spoke; on by default), /usage (tokens this session and subscription quotas),
/reload (load edited code and README-for-brainstorming-agents.md; the conversation continues), /quit`;

// How long one worker instruction may run before it is stopped (a room turn gets 5 minutes).
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

// Imports fresh copies of the modules and the two rulebooks and builds a room on ctx.state, and the worker. Returns
// the parts to put into ctx; if anything fails it throws, leaving ctx as it was (at most an
// unused empty session added).
export async function load(ctx, v) {
  const instructions = readFileSync(new URL('../README-for-brainstorming-agents.md', import.meta.url), 'utf8');
  const workerInstructions = readFileSync(new URL('../README-for-worker-agents.md', import.meta.url), 'utf8');
  const { createAgent } = await import(`./agents.mjs${v}`);
  const { createRoom } = await import(`./room.mjs${v}`);
  const docs = await import(`./docs.mjs${v}`);
  const usage = await import(`./usage.mjs${v}`);
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const [provider, name = provider[0].toUpperCase() + provider.slice(1)] = spec.trim().split(':');
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    return createAgent(provider, { name, cwd: ctx.cwd, instructions, session: ctx.sessions.get(name) });
  });
  // The worker's session is kept under its own key, so it never mixes with a room agent's.
  const [wProvider, wName = 'Worker'] = (ctx.workerSpec ?? 'claude:Worker').trim().split(':');
  if (agents.some((a) => a.name === wName)) throw new Error(`The worker's name "${wName}" is taken by a room agent`);
  if (!ctx.sessions.has(`worker:${wName}`)) ctx.sessions.set(`worker:${wName}`, {});
  const worker = createAgent(wProvider, { name: wName, cwd: ctx.cwd, instructions: workerInstructions, shell: true,
    timeoutMs: WORKER_TIMEOUT_MS, session: ctx.sessions.get(`worker:${wName}`) });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null, worker: [], working: null };
  return { room: createRoom(agents, ctx.state), worker, docs, usage, totals: ctx.totals ?? {}, screen };
}

const tty = process.stdout.isTTY;
const style = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = style('1');
const dim = style('2');
const red = style('31');
const log = (ctx, text) => appendFileSync(ctx.logPath, text);
const describe = (room) => room.agents.map((a) => `${a.name} (${a.provider})`).join(', ');

// Points the screen at the code loaded now (at start and after each reload): the header's names and,
// in UI mode, the Worker tab's input.
function wire(ctx) {
  ctx.screen.room = { folder: basename(ctx.cwd), agents: ctx.room.agents.map((a) => a.name), worker: ctx.worker.name };
  ctx.screen.logDir = ctx.logDir;
  ctx.screen.logFile = basename(ctx.logPath);
  ctx.screen.auto = autoOn(ctx);
  if (ctx.noScreen) return;
  ctx.screen.work = (text) => queueWork(ctx, text);
  // The screen's checkbox: applied at once, not queued behind a round, so it can stop the next summary.
  ctx.screen.setAuto = (on) => setAuto(ctx, on);
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

// Once per session: create the transcript file and print the banner.
// UI mode (not --no-screen): the discussion screen is the room's input and output, so it is opened
// here (in an interactive terminal or with --open; other piped runs just print its address)
// and lines the User sends from it go to ctx.say. The terminal then only shows a log.
export async function start(ctx) {
  mkdirSync(ctx.logDir, { recursive: true });
  ctx.logPath = join(ctx.logDir, `room-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  log(ctx, `# Room — ${describe(ctx.room)}\n\nWorking directory: ${ctx.cwd}\n\n`);
  console.log(`Room: ${describe(ctx.room)} · worker ${ctx.worker.name} (${ctx.worker.provider}) · cwd ${ctx.cwd}`);
  console.log(`Transcript: ${ctx.logPath}`);
  wire(ctx);
  // Calls through ctx, so after a reload it runs the new code.
  ctx.quotaTimer ??= setInterval(() => ctx.refreshQuota?.(), 60_000).unref();
  ctx.refreshQuota = () => refreshQuota(ctx).catch(() => {});
  ctx.refreshQuota();
  if (ctx.noScreen) {
    return console.log('Type a message, /docs to see the proposals, /summary to sum up, /usage for tokens and quotas, /reload after editing the code, or /quit.\n');
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
  if (line === '/summary') return runSummary(ctx);
  const auto = /^\/autosummary(?:\s+(on|off))?$/.exec(line);
  if (auto) return setAuto(ctx, auto[1] ? auto[1] === 'on' : !autoOn(ctx));
  if (line === '/usage') {
    const quota = await ctx.usage.fetchQuota();
    return note(ctx, `${ctx.usage.usageReport({ totals: ctx.totals, agents: [...ctx.room.agents, ctx.worker], quota })}\n`);
  }
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
function queueWork(ctx, text) {
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
    entry = { speaker: worker.name, text: (await worker.turn(text)) || '(no reply)' };
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

// The proposal viewer and discussion screen: a local-only HTTP server kept in ctx, started at
// start-up in UI mode and on the first /docs in terminal mode. It calls ctx.docs on every request,
// so a reload applies to it too. Its connections (open screens hold one) never keep the process
// alive; in terminal mode the server doesn't either, while in UI mode it is the room's input.
async function viewerUrl(ctx) {
  if (!ctx.server) {
    ctx.server = createServer((req, res) => {
      try { ctx.docs.handle(req, res, join(ctx.cwd, 'proposal'), ctx.screen); } catch (err) { res.writeHead(500); res.end(String(err)); }
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
  const dir = join(ctx.cwd, 'proposal');
  const files = existsSync(dir) ? ctx.docs.listFiles(dir) : [];
  if (!files.length) return console.log(`No files in ${dir} yet: they appear when an agent writes a proposal.\n`);
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
