#!/usr/bin/env node
// The only part of agent-room that never reloads: arguments, the input loop (terminal or screen),
// /reload, /quit and /restart. Everything else is in ui.mjs (and what it loads), which /reload swaps between
// rounds.
// The conversation lives in `ctx`, so it carries over. Keep this file small: changes here need a
// restart.
import { watch } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    agents: { type: 'string' },
    worker: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() },
    port: { type: 'string', default: '5566' },
    'no-screen': { type: 'boolean' },
    open: { type: 'boolean' },
    reopen: { type: 'string' },
    dev: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) {
  console.error(`--port must be a number from 0 to 65535, not "${values.port}"`);
  process.exit(1);
}

const ctx = {
  cwd: resolve(values.cwd),
  agentSpecs: values.agents,
  workerSpec: values.worker,
  port: Number(values.port),
  noScreen: !!values['no-screen'],
  open: !!values.open,
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
// --reopen <discussion>: start in that discussion, as /reopen would (a restart passes the one in use).
if (values.reopen) { try { await ui.handleLine(`/reopen ${values.reopen}`, ctx); } catch (err) { report(`✗ ${err.message}\n`); } }
if (values.dev && !ctx.noScreen) watchSource();
prompt();
let restart = false;
for await (const raw of input) {
  const line = raw.trim();
  if (line === '/quit') break;
  // UI mode: a new process takes over this room's port, so the page and the Dock app keep their address.
  if (line === '/restart' && !ctx.noScreen) { restart = true; break; }
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
try { await ui.ended(ctx, restart); } catch {}
rl?.close();
// "Room ended." is the log's last line after a normal Quit: the Dock app shows the log otherwise.
let last = 'Room ended.';
if (restart) {
  try { await ui.restart(ctx, values); last = 'Restarting: a new process takes over this room.'; }
  catch (err) { last = `✗ Restart failed, the room has ended: ${err.message}`; }
}
console.log(last);
// In UI mode the viewer server is what kept the process running, so end it explicitly.
process.exit(0);

// --dev: saving a module in src/ or a rulebook queues /reload (after a round in progress, like the
// button); an editor's burst of events makes one reload. This file can't reload: it asks for Restart.
function watchSource() {
  let timer = null;
  const files = new Set();
  const changed = (file) => {
    files.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (files.has('cli.mjs')) report('cli.mjs changed: Restart to apply it (Reload can\'t).\n');
      if ([...files].some((f) => f !== 'cli.mjs')) input.push('/reload');
      files.clear();
    }, 300);
  };
  watch(new URL('./', import.meta.url), (_, f) => f?.endsWith('.mjs') && changed(f));
  watch(new URL('../', import.meta.url), (_, f) => /^README-for-.+\.md$/.test(f ?? '') && changed(f));
  console.log('Dev mode: saved source and rulebook edits reload by themselves.');
}

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
