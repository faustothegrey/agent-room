#!/usr/bin/env node
// The only part of agent-room that never reloads: arguments, the input loop (terminal or screen),
// /reload and /quit. Everything else is in ui.mjs (and what it loads), which /reload swaps between
// rounds.
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
    'no-screen': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const ctx = {
  cwd: resolve(values.cwd),
  agentSpecs: values.agents,
  logDir: values['log-dir'],
  noScreen: !!values['no-screen'],
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
// The room's input. Terminal mode: lines typed here. UI mode: lines sent from the discussion
// screen (ui.mjs passes them to ctx.say). Either way they are handled one at a time, so a line
// sent during a round waits for it to end.
let input;
let prompt = () => {};
let rl = null;
if (ctx.noScreen) {
  // Iterating the lines (rather than rl.question) buffers anything typed during a round,
  // so it becomes the next round instead of being lost.
  rl = createInterface({ input: process.stdin, output: process.stdout });
  let inputOpen = true;
  rl.on('close', () => { inputOpen = false; });
  prompt = () => {
    if (!inputOpen) return;
    try { rl.setPrompt(ui.promptText()); } catch { rl.setPrompt('You › '); }
    rl.prompt();
  };
  input = rl;
} else {
  input = lineQueue();
  ctx.say = (line) => input.push(line);
}

// Messages from this shell: on the screen too, when the loaded code can still show them.
const report = (text) => { try { ui.note(ctx, text, true); } catch { console.log(text); } };

await ui.start(ctx);
prompt();
for await (const raw of input) {
  const line = raw.trim();
  if (line === '/quit') break;
  if (line === '/reload') {
    try {
      await load();
      ui.reloaded(ctx);
    } catch (err) {
      report(`✗ Reload failed, still running the previous code: ${err.message}\n`);
    }
  } else {
    // A bug in the loaded code must not end the room: report it, so it can be fixed and reloaded.
    try { await ui.handleLine(line, ctx); } catch (err) { report(`✗ ${err.stack}\n`); }
  }
  prompt();
}
try { await ui.ended(ctx); } catch {}
rl?.close();
// In UI mode the viewer server is what kept the process running, so end it explicitly.
process.exit(0);

// Lines pushed in from elsewhere, read with for await.
function lineQueue() {
  const lines = [];
  let wake = null;
  return {
    push(line) { lines.push(line); wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (lines.length) yield lines.shift();
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
}
