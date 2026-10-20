#!/usr/bin/env node
// The only part of agent-room that never reloads: arguments, the terminal input loop, /reload and
// /quit. Everything else is in ui.mjs (and what it loads), which /reload swaps between rounds.
// The conversation lives in `ctx`, so it carries over. Keep this file small: changes here need a
// restart.
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    agents: { type: 'string', default: 'claude,codex' },
    cwd: { type: 'string', default: process.cwd() },
    'log-dir': { type: 'string', default: join(process.cwd(), 'transcripts') },
    help: { type: 'boolean', short: 'h' },
  },
});

const ctx = {
  cwd: resolve(values.cwd),
  agentSpecs: values.agents,
  logDir: values['log-dir'],
  state: { transcript: [], seen: new Map() },
  sessions: new Map(),
};

// Imports a fresh ui.mjs (the query defeats the module cache); ui.load imports the rest with the
// same tag. Nothing changes unless everything loads.
let ui;
async function load() {
  const v = `?v=${Date.now()}`;
  const next = await import(`./ui.mjs${v}`);
  Object.assign(ctx, await next.load(ctx, v));
  ui = next;
}

await load();
if (values.help) {
  console.log(ui.USAGE);
  process.exit(0);
}
ui.start(ctx);

// Iterating the lines (rather than rl.question) buffers anything typed during a round,
// so it becomes the next round instead of being lost.
const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputOpen = true;
rl.on('close', () => { inputOpen = false; });
const prompt = () => {
  if (!inputOpen) return;
  try { rl.setPrompt(ui.promptText()); } catch { rl.setPrompt('You › '); }
  rl.prompt();
};
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/quit') break;
  if (line === '/reload') {
    try {
      await load();
      ui.reloaded(ctx);
    } catch (err) {
      console.log(`✗ Reload failed, still running the previous code: ${err.message}\n`);
    }
  } else {
    // A bug in the loaded code must not end the room: report it, so it can be fixed and reloaded.
    try { await ui.handleLine(line, ctx); } catch (err) { console.log(`✗ ${err.stack}\n`); }
  }
  prompt();
}
rl.close();
