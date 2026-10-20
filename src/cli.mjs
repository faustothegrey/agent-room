#!/usr/bin/env node
// Terminal front end: read a user message, run one cycle, print each reply, repeat.
// room.mjs and agents.mjs are loaded by load(), so /reload swaps in edited code between rounds.
// The conversation (transcript, seen, CLI sessions) lives here and is carried over.
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage: agent-room [--agents claude,codex] [--cwd DIR] [--log-dir DIR]

Each agent is provider[:name], e.g. --agents claude:Ada,codex:Linus
Type a message to start a round; start it with @name to address one agent.
Commands: /docs (open proposal/ in Finder), /reload (load edited room.mjs, agents.mjs and
README-for-brainstorming-agents.md), /quit`;

const { values } = parseArgs({
  options: {
    agents: { type: 'string', default: 'claude,codex' },
    cwd: { type: 'string', default: process.cwd() },
    'log-dir': { type: 'string', default: join(process.cwd(), 'transcripts') },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const cwd = resolve(values.cwd);
const specs = values.agents.split(',').map((spec) => {
  const [provider, name] = spec.trim().split(':');
  return { provider, name: name || provider[0].toUpperCase() + provider.slice(1) };
});
const state = { transcript: [], seen: new Map() };
const sessions = new Map(specs.map((s) => [s.name, {}]));

// Imports fresh copies of the modules (the query defeats the module cache) and the rulebook, and
// builds a room on the existing state. If anything throws, the caller keeps its current room.
async function load() {
  const instructions = readFileSync(new URL('../README-for-brainstorming-agents.md', import.meta.url), 'utf8');
  const v = `?v=${Date.now()}`;
  const { createAgent } = await import(`./agents.mjs${v}`);
  const { createRoom } = await import(`./room.mjs${v}`);
  const agents = specs.map((s) => createAgent(s.provider, { name: s.name, cwd, instructions, session: sessions.get(s.name) }));
  return createRoom(agents, state);
}
let room = await load();
const { agents } = room;

mkdirSync(values['log-dir'], { recursive: true });
const logPath = join(values['log-dir'], `room-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
appendFileSync(logPath, `# Room — ${agents.map((a) => `${a.name} (${a.provider})`).join(', ')}\n\nWorking directory: ${cwd}\n\n`);

console.log(`Room: ${agents.map((a) => `${a.name} (${a.provider})`).join(', ')} · cwd ${cwd}`);
console.log(`Transcript: ${logPath}\nType a message, /docs to see the proposals, or /quit.\n`);

// Colours and the live "thinking" line only on a terminal; piped output stays plain.
const tty = process.stdout.isTTY;
const style = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = style('1');
const dim = style('2');
const red = style('31');

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

// Iterating the lines (rather than rl.question) buffers anything typed during a round,
// so it becomes the next round instead of being lost.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? '\x1b[1;36mYou ›\x1b[0m ' : 'You › ' });
let inputOpen = true;
rl.on('close', () => { inputOpen = false; });
const prompt = () => { if (inputOpen) rl.prompt(); };
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) { prompt(); continue; }
  if (line === '/quit') break;
  if (line === '/docs') {
    const dir = join(cwd, 'proposal');
    if (!existsSync(dir)) console.log(`No ${dir} yet: it appears when an agent writes the first proposal.\n`);
    else {
      const err = await new Promise((done) => execFile('open', [dir], done));
      console.log(err ? red(`✗ Could not open ${dir}: ${err.message}\n`) : `Opened ${dir} in Finder.\n`);
    }
    prompt();
    continue;
  }
  if (line === '/reload') {
    try {
      room = await load();
      appendFileSync(logPath, '_(code reloaded)_\n\n');
      console.log('Reloaded room.mjs, agents.mjs and the agents\' rulebook; the conversation continues.\n');
    } catch (err) {
      console.log(`✗ Reload failed, still running the previous code: ${err.message}\n`);
    }
    prompt();
    continue;
  }
  let started = 0;
  const roundStart = Date.now();
  let turns = 0;
  let ending = 'all passed';
  try {
    await room.round(line, {
      onTurnStart(agent) {
        started = Date.now();
        startThinking(agent.name);
      },
      onMessage(m) {
        const secs = m.speaker === 'User' ? '' : ` (${((Date.now() - started) / 1000).toFixed(0)}s)`;
        appendFileSync(logPath, `**${m.speaker}**${m.error ? ' — failed' : ''}${secs}\n\n${m.text}\n\n`);
        if (m.speaker === 'User') return;
        stopThinking();
        turns++;
        if (m.error) ending = `${m.speaker} failed`;
        if (m.pass) return; // passes are logged, not shown
        console.log(m.error ? red(`\n✗ ${m.speaker} failed${secs}: ${m.text}\n`) : `\n${bold(m.speaker)}${dim(secs)} › ${m.text}\n`);
      },
      onNotice(text) {
        appendFileSync(logPath, `_${text}_\n\n`);
        console.log(`${text}\n`);
        ending = 'turn cap reached';
      },
    });
    const secs = Math.round((Date.now() - roundStart) / 1000);
    console.log(dim(`── your turn · ${ending} · ${turns} agent turn${turns === 1 ? '' : 's'} · ${secs}s ──`));
  } catch (err) {
    // An unknown @name: nothing was sent or recorded.
    console.log(red(`✗ ${err.message}`));
  }
  prompt();
}
rl.close();
