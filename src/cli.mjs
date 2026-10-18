#!/usr/bin/env node
// Terminal front end: read a user message, run one round, print each reply, repeat.
import { createInterface } from 'node:readline/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createAgent } from './agents.mjs';
import { createRoom } from './room.mjs';

const USAGE = `Usage: agent-room [--agents claude,codex] [--cwd DIR] [--log-dir DIR]

Each agent is provider[:name], e.g. --agents claude:Ada,codex:Linus
Type a message to start a round. Commands: /quit`;

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
const agents = values.agents.split(',').map((spec) => {
  const [provider, name] = spec.trim().split(':');
  return createAgent(provider, { name: name || provider[0].toUpperCase() + provider.slice(1), cwd });
});
const room = createRoom(agents);

mkdirSync(values['log-dir'], { recursive: true });
const logPath = join(values['log-dir'], `room-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
appendFileSync(logPath, `# Room — ${agents.map((a) => `${a.name} (${a.provider})`).join(', ')}\n\nWorking directory: ${cwd}\n\n`);

console.log(`Room: ${agents.map((a) => `${a.name} (${a.provider})`).join(', ')} · talk-only · cwd ${cwd}`);
console.log(`Transcript: ${logPath}\nType a message, or /quit.\n`);

// Iterating the lines (rather than rl.question) buffers anything typed during a round,
// so it becomes the next round instead of being lost.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'You › ' });
let inputOpen = true;
rl.on('close', () => { inputOpen = false; });
const prompt = () => { if (inputOpen) rl.prompt(); };
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) { prompt(); continue; }
  if (line === '/quit') break;
  let started = 0;
  await room.round(line, {
    onTurnStart(agent) {
      started = Date.now();
      process.stdout.write(`  … ${agent.name} is thinking\r`);
    },
    onMessage(m) {
      const secs = m.speaker === 'User' ? '' : ` (${((Date.now() - started) / 1000).toFixed(0)}s)`;
      appendFileSync(logPath, `**${m.speaker}**${m.error ? ' — failed' : ''}${secs}\n\n${m.text}\n\n`);
      if (m.speaker === 'User') return;
      process.stdout.write('\x1b[2K');
      console.log(m.error ? `\n✗ ${m.speaker} failed${secs}: ${m.text}\n` : `\n${m.speaker}${secs} › ${m.text}\n`);
    },
  });
  prompt();
}
rl.close();
