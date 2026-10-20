// Everything about a running room except the input loop: loading the other modules, building the
// room, the transcript file, the screen, and the commands. cli.mjs re-imports this file on /reload;
// it imports the local modules with the same version tag, so they are fresh too. (A static import
// of a local module here would stay cached and never reload.)
// What must survive a reload lives in `ctx`, owned by cli.mjs: the conversation state, the CLI
// sessions, the transcript path and the viewer server.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const USAGE = `Usage: agent-room [--agents claude,codex] [--cwd DIR] [--log-dir DIR] [--no-screen]

Each agent is provider[:name], e.g. --agents claude:Ada,codex:Linus
--no-screen (or npm run terminal): terminal only; /docs opens each file alone in the browser
instead of on the discussion screen.
Type a message to start a round; start it with @name to address one agent.
Commands: /docs (pick a proposal/ file to view in the browser), /usage (tokens this session and
subscription quotas), /reload (load edited code and README-for-brainstorming-agents.md; the
conversation continues), /quit`;

// Imports fresh copies of the modules and the rulebook and builds a room on ctx.state. Returns
// the parts to put into ctx; if anything fails it throws, leaving ctx as it was (at most an
// unused empty session added).
export async function load(ctx, v) {
  const instructions = readFileSync(new URL('../README-for-brainstorming-agents.md', import.meta.url), 'utf8');
  const { createAgent } = await import(`./agents.mjs${v}`);
  const { createRoom } = await import(`./room.mjs${v}`);
  const docs = await import(`./docs.mjs${v}`);
  const usage = await import(`./usage.mjs${v}`);
  const agents = ctx.agentSpecs.split(',').map((spec) => {
    const [provider, name = provider[0].toUpperCase() + provider.slice(1)] = spec.trim().split(':');
    if (!ctx.sessions.has(name)) ctx.sessions.set(name, {});
    return createAgent(provider, { name, cwd: ctx.cwd, instructions, session: ctx.sessions.get(name) });
  });
  // Session token totals per agent name, and the discussion screen's state (see docs.mjs): kept in
  // ctx so they survive a reload.
  const screen = ctx.screen ?? { clients: new Set(), transcript: ctx.state.transcript, doc: null, thinking: null };
  return { room: createRoom(agents, ctx.state), docs, usage, totals: ctx.totals ?? {}, screen };
}

const tty = process.stdout.isTTY;
const style = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = style('1');
const dim = style('2');
const red = style('31');
const log = (ctx, text) => appendFileSync(ctx.logPath, text);
const describe = (room) => room.agents.map((a) => `${a.name} (${a.provider})`).join(', ');

export const promptText = () => (tty ? '\x1b[1;36mYou ›\x1b[0m ' : 'You › ');

// Once per session: create the transcript file and print the banner.
export function start(ctx) {
  mkdirSync(ctx.logDir, { recursive: true });
  ctx.logPath = join(ctx.logDir, `room-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  log(ctx, `# Room — ${describe(ctx.room)}\n\nWorking directory: ${ctx.cwd}\n\n`);
  console.log(`Room: ${describe(ctx.room)} · cwd ${ctx.cwd}`);
  console.log(`Transcript: ${ctx.logPath}\nType a message, /docs to see the proposals, /usage for tokens and quotas, /reload after editing the code, or /quit.\n`);
}

export function reloaded(ctx) {
  log(ctx, '_(code reloaded)_\n\n');
  console.log('Reloaded the code and the agents\' rulebook; the conversation continues.\n');
}

export async function handleLine(line, ctx) {
  if (!line) return;
  if (line === '/docs') return showDocs(ctx);
  if (line === '/usage') {
    const quota = await ctx.usage.fetchQuota();
    return console.log(`${ctx.usage.usageReport({ totals: ctx.totals, agents: ctx.room.agents, quota })}\n`);
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

async function runRound(line, ctx) {
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  let roundUsage;
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
    const quota = ctx.usage.quotaSummary(await ctx.usage.fetchQuota(), providers);
    const parts = [ending, `${turns} agent turn${turns === 1 ? '' : 's'}`, `${secs}s`, ctx.usage.formatUsage(roundUsage), quota];
    console.log(dim(`── your turn · ${parts.filter(Boolean).join(' · ')} ──`));
    toScreen(ctx, { type: 'turn', text: `your turn · ${parts.filter(Boolean).join(' · ')}` });
  } catch (err) {
    // An unknown @name: nothing was sent or recorded.
    console.log(red(`✗ ${err.message}`));
  }
}

// The proposal viewer and discussion screen: a local-only HTTP server kept in ctx, started on the
// first /docs. It calls ctx.docs on every request, so a reload applies to it too. Neither the
// server nor its connections (open screens hold one) keep the process alive after /quit.
async function viewerUrl(ctx) {
  if (!ctx.server) {
    ctx.server = createServer((req, res) => {
      try { ctx.docs.handle(req, res, join(ctx.cwd, 'proposal'), ctx.screen); } catch (err) { res.writeHead(500); res.end(String(err)); }
    });
    ctx.server.on('connection', (socket) => socket.unref());
    await new Promise((ok) => ctx.server.listen(0, '127.0.0.1', ok));
    ctx.server.unref();
  }
  return `http://127.0.0.1:${ctx.server.address().port}/`;
}

async function showDocs(ctx) {
  const dir = join(ctx.cwd, 'proposal');
  const files = existsSync(dir) ? ctx.docs.listFiles(dir) : [];
  if (!files.length) return console.log(`No files in ${dir} yet: they appear when an agent writes a proposal.\n`);
  const base = await viewerUrl(ctx);
  const screenUrl = `${base}__room`;
  const browse = (url) => execFile('open', [url], (err) => err && console.log(red(`✗ ${err.message}`)));
  // Enter puts the file on the screen's right pane, and opens the screen if none is open yet.
  // With --no-screen it opens the file alone in the browser instead, as before the screen existed.
  const open = (f) => {
    if (ctx.noScreen) return browse(base + ctx.docs.urlPath(f));
    ctx.screen.doc = f;
    toScreen(ctx, { type: 'doc', file: f });
    if (!ctx.screen.clients.size) browse(screenUrl);
  };
  const urls = files.map((f) => base + ctx.docs.urlPath(f)).join('\n');
  if (!tty) return console.log(`${ctx.noScreen ? '' : `Discussion screen: ${screenUrl}\n`}${urls}\n`);
  const header = ctx.noScreen ? `${base} · ` : `${screenUrl} · Enter shows the file there · `;
  // Take the keys away from readline while the list is up, then give them back.
  const readlineKeys = process.stdin.listeners('keypress');
  process.stdin.removeAllListeners('keypress');
  try {
    await ctx.docs.pick(files, { input: process.stdin, output: process.stdout, onOpen: open, header });
  } finally {
    for (const l of readlineKeys) process.stdin.on('keypress', l);
  }
}
