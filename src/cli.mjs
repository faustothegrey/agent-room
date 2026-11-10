#!/usr/bin/env node
// The only part of agent-room that never reloads: arguments, the server's rooms and each room's
// input loop (terminal or screen), /reload, /quit, /shutdown and /restart. Everything else is in
// ui.mjs (and what it loads), which /reload swaps between rounds.
// One process serves several rooms, one per folder (identified by its real path). Each room's
// conversation lives in its own `ctx`, with its own input queue, so it carries over a reload and a
// round in one room never waits for another. Keep this file small: changes here need a restart.
import { realpathSync, watch } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, resolve } from 'node:path';
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
    node: { type: 'string' },
    peer: { type: 'string', multiple: true },
    // Used by Restart only: another room to bring back, as JSON { cwd, agents, worker, reopen?, context? }.
    room: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
    // UNSAFE TEST ONLY (host-shell.mjs): a host shell in the room page; the server listens on 127.0.0.1 only.
    'unsafe-shell-test': { type: 'boolean' },
  },
});
if (values['unsafe-shell-test']) {
  (await import('./host-shell.mjs')).enableShellTest();
  console.log('UNSAFE TEST: --unsafe-shell-test is on: a host shell in the room page, listening on 127.0.0.1 only.');
}

if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) {
  console.error(`--port must be a number from 0 to 65535, not "${values.port}"`);
  process.exit(1);
}
// --peer <name>=http://<address>:<port>, repeatable; only with --node (replicate.mjs checks the rest).
const peers = (values.peer ?? []).map((p) => { const at = p.indexOf('='); return { name: p.slice(0, at), url: p.slice(at + 1).replace(/\/+$/, '') }; });
if ((peers.length && !values.node) || peers.some((p) => !p.name)) {
  console.error('--peer needs --node, and is written --peer <name>=http://<address>:<port>');
  process.exit(1);
}
let restored;
try { restored = (values.room ?? []).map((r) => JSON.parse(r)); }
catch { console.error('--room expects the JSON that Restart writes'); process.exit(1); }

// The latest loaded code (each room also keeps the version it last applied, in ctx.ui). The query
// defeats the module cache; ui.load imports the rest with the same tag.
let ui = await import(`./ui.mjs?v=${Date.now()}`);
if (values.help) {
  console.log(ui.USAGE);
  process.exit(0);
}

const END = Symbol('end'); // pushed into a room's input when the whole server ends
// The server: its rooms by real path, in the order they opened (the first is the launch room, the
// only one that replicates with --node). The HTTP server itself is created by ui.mjs, in hub.server.
const noScreen = !!values['no-screen'];
const hub = { rooms: new Map(), noScreen, node: values.node ?? null, startedAt: new Date().toISOString(), addRoom };
if (!noScreen) hub.shutdown = (confirmed) => endServer('shutdown', confirmed);

// Opens a room in `folder`, or returns the one already open there: { ctx, existing }. `context`: one
// more open discussion in a folder that already has a room (see ui.mjs, "Several open discussions"),
// with its own key, input queue and page; it shares the folder's worker.
async function addRoom(folder, { launch = false, agents, worker, reopen, context } = {}) {
  ui.assertRoomCreation(hub);
  const cwd = resolve(folder);
  // A symbolic link can't make a second room for the same folder.
  const key = realpathSync(cwd) + (context ? `#${context}` : '');
  const had = hub.rooms.get(key);
  if (had) return { ctx: had, existing: true };
  const ctx = {
    cwd, key, hub, launch, added: !launch, context: context ?? null,
    agentSpecs: agents, workerSpec: worker,
    port: Number(values.port), listen: values['unsafe-shell-test'] ? '127.0.0.1' : '0.0.0.0', noScreen, open: launch && !!values.open,
    node: launch ? values.node ?? null : null, peers: launch ? peers : [],
    state: { transcript: [], seen: new Map() },
    sessions: new Map(),
  };
  let ready;
  ctx.ready = new Promise((resolve) => { ready = resolve; });
  hub.rooms.set(key, ctx); // first, so a second request for this folder finds it
  try {
    Object.assign(ctx, await ui.load(ctx, `?v=${Date.now()}`));
    ctx.ui = ui;
    // Each log line says which room it is from (UI mode; the terminal mode has a single room).
    const name = basename(key);
    if (!noScreen) ctx.label = [...hub.rooms.values()].some((o) => o !== ctx && o.label === name) ? ctx.id : name;
    if (noScreen) {
      // Iterating the lines (rather than rl.question) buffers anything typed during a round,
      // so it becomes the next round instead of being lost.
      const rl = ctx.rl = createInterface({ input: process.stdin, output: process.stdout });
      let inputOpen = true;
      rl.on('close', () => { inputOpen = false; });
      // /quit typed during a round: it waits its turn, but not indefinitely (see ui.quitRequested).
      rl.on('line', (l) => { if (['/quit', '/shutdown'].includes(l.trim())) ctx.ui.quitRequested(ctx); });
      ctx.prompt = () => {
        if (!inputOpen) return;
        try { rl.setPrompt(ctx.ui.promptText()); } catch { rl.setPrompt('You › '); }
        rl.prompt();
      };
      ctx.input = rl;
    } else {
      ctx.prompt = () => {};
      ctx.input = lineQueue();
      // Seen as they arrive, not when their turn comes: Restart and Shutdown start at once (every
      // room then ends after its round in progress), and Quit room can't wait indefinitely.
      ctx.say = (line, confirmed = false) => {
        const command = line.trim();
        if (command === '/restart' || command === '/shutdown') return endServer(command.slice(1), confirmed);
        if (command === '/quit') ctx.ui.quitRequested(ctx);
        ctx.input.push(line);
      };
    }
    await ui.start(ctx);
  } catch (err) {
    hub.rooms.delete(key);
    ctx.rl?.close();
    ready();
    throw err;
  }
  // --reopen <discussion> (or a restored room's): start in that discussion, as /reopen would.
  if (reopen) { try { await ctx.ui.handleLine(`/reopen ${reopen}`, ctx); } catch (err) { report(ctx, `✗ ${err.message}\n`); } }
  await ctx.ui.recoverWorkerOwner(ctx);
  ctx.done = runRoom(ctx);
  ready();
  return { ctx, existing: false };
}

// Messages from this shell: on the room's screen too, when its loaded code can still show them.
const report = (ctx, text) => { try { ctx.ui.note(ctx, text, true); } catch { console.log(text); } };

// The room's input, one line at a time: a line sent during a round waits for it to end.
async function runRoom(ctx) {
  ctx.prompt();
  for await (const raw of ctx.input) {
    if (raw === END) break;
    if (raw?.reload) { await applyReload(ctx, raw); ctx.prompt(); continue; }
    const line = raw.trim();
    if (line === '/quit' || (noScreen && line === '/shutdown')) break;
    // UI mode: Restart and Shutdown act on the whole server, after every room's round in progress.
    if (!noScreen && (line === '/restart' || line === '/shutdown')) { endServer(line.slice(1)); continue; }
    if (line === '/reload') await reloadAll(ctx);
    else {
      // A bug in the loaded code must not end the room: report it, so it can be fixed and reloaded.
      try { await ctx.ui.handleLine(line, ctx); } catch (err) { report(ctx, `✗ ${err.stack}\n`); }
    }
    ctx.prompt();
  }
  // Its running programs are stopped before its state goes (anything not stopped cleanly is reported).
  try { await ctx.ui.stopRoom(ctx); } catch (err) { console.log(`✗ ${err.message}`); }
  try { await ctx.ui.ended(ctx, hub.ending === 'restart'); } catch {}
  ctx.rl?.close();
  hub.rooms.delete(ctx.key);
  if (!noScreen) console.log(`[${ctx.label}] Room ended.`);
  if (!hub.ending && !hub.rooms.size) finish('shutdown', [ctx]); // the last room: the server ends too
}

// Shutdown server and Restart: every room ends after its round in progress (for at most
// ui.QUIT_GRACE_MS, then its agents are stopped), then the process.
function endServer(kind, confirmed = false) {
  if (hub.ending) return;
  const warning = ui.serverEndWarning(hub);
  if (warning && !confirmed) return warning;
  hub.ending = kind;
  const closing = [...hub.rooms.values()];
  Promise.all(closing.map(async (ctx) => {
    await ctx.ready;
    if (!ctx.done) return;
    ctx.input.push(END);
    ctx.ui.quitRequested(ctx);
    await ctx.done;
  })).then(() => finish(kind, closing));
}

async function finish(kind, rooms) {
  hub.ending ??= kind;
  // "Server ended." is the log's last line after a normal end: the Dock app shows the log otherwise.
  let last = noScreen ? 'Room ended.' : 'Server ended.';
  if (kind === 'restart') {
    try { await ui.restart(hub, rooms, values); last = 'Restarting: a new process takes over the server.'; }
    catch (err) { last = `✗ Restart failed, the server has ended: ${err.message}`; }
  }
  console.log(last);
  // In UI mode the viewer server is what kept the process running, so end it explicitly.
  process.exit(0);
}

// /reload: the code is imported once, then each room applies it between its own rounds.
async function reloadAll(from) {
  const v = `?v=${Date.now()}`;
  let next;
  try { next = await import(`./ui.mjs${v}`); }
  catch (err) { for (const ctx of from ? [from] : hub.rooms.values()) report(ctx, `✗ Reload failed, still running the previous code: ${err.message}\n`); return; }
  ui = next;
  for (const ctx of hub.rooms.values()) {
    if (ctx === from) await applyReload(ctx, { reload: v, ui: next });
    else ctx.input.push({ reload: v, ui: next });
  }
}
async function applyReload(ctx, { reload: v, ui: next }) {
  try {
    Object.assign(ctx, await next.load(ctx, v));
    ctx.ui = next;
    await next.reloaded(ctx);
  } catch (err) {
    report(ctx, `✗ Reload failed, still running the previous code: ${err.message}\n`);
  }
}

// A start that can't go on (a taken port with --peer, a bad --node or --peer) ends with its reason.
try {
  await addRoom(values.cwd, { launch: true, agents: values.agents, worker: values.worker, reopen: values.reopen });
} catch (err) { console.error(`✗ ${err.message}`); process.exit(1); }
for (const r of restored) {
  try { await addRoom(r.cwd, { agents: r.agents, worker: r.worker, reopen: r.reopen, context: r.context }); }
  catch (err) { console.error(`✗ The room in ${r.cwd} could not be restored: ${err.message}`); }
}
if (values.dev && !noScreen) watchSource();

// --dev: saving a module in src/ or a rulebook reloads every room (after a round in progress, like
// the button); an editor's burst of events makes one reload. This file can't reload: it asks for Restart.
function watchSource() {
  let timer = null;
  const files = new Set();
  const changed = (file) => {
    files.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (files.has('cli.mjs')) for (const ctx of hub.rooms.values()) report(ctx, 'cli.mjs changed: Restart to apply it (Reload can\'t).\n');
      if ([...files].some((f) => f !== 'cli.mjs')) reloadAll(null);
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
