// Per-room quota and server-wide provider monitoring, bound to the current room coordinator.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createMonitor({ hubOf, toScreen, currentSettings, claudeModels, codexModels, agyModels,
  modelAlignment, readDefaults, sessionView, folderOf }) {
// Turn records live only in memory, keyed by the actual provider session, never in checkpoints.
function monitorAgentTurns(agent, session, records) {
  const turn = agent.turn.bind(agent), reset = agent.reset?.bind(agent);
  agent.turn = async (...args) => {
    try {
      const result = await turn(...args);
      records.set(session, { ...records.get(session), ended: new Date().toISOString(), outcome: 'ok' });
      return result;
    } catch (err) {
      const ended = new Date().toISOString();
      records.set(session, { ended, outcome: 'error', error: { message: err?.message ?? String(err), at: ended } });
      throw err;
    }
  };
  if (reset) agent.reset = (...args) => { records.delete(session); return reset(...args); };
  return agent;
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

// The monitor panel's warnings (see README, "The header"), checked once per server: each provider's
// login at startup and every 10 minutes, the record of programs for leftovers at startup and every
// minute. Each room's panel shows its own part (monitorView). The timers call through the hub, so
// after a reload they run the new code.
const LOGIN_EVERY_MS = 10 * 60_000, LEFTOVERS_EVERY_MS = 60_000;
const loadedRooms = (hub) => [...hub.rooms.values()].filter((r) => r.room && r.usage);
const providersOf = (ctx) => [...new Set([...ctx.room.agents, ctx.worker].map((a) => a.provider))];
function watchMonitor(ctx) {
  const hub = hubOf(ctx);
  hub.monitor ??= { login: {}, leftovers: [] };
  hub.monitor.errors ??= { login: {}, leftovers: null, cli: {} };
  hub.monitor.cli ??= {};
  hub.checkLogins = (all, requested) => checkLogins(hub, all, requested);
  hub.checkLeftovers = () => checkLeftovers(hub);
  ctx.showMonitor = () => showMonitor(ctx);
  if (!hub.monitorTimers) {
    hub.monitor.nextLogin = new Date(Date.now() + LOGIN_EVERY_MS).toISOString();
    hub.monitor.nextLeftovers = new Date(Date.now() + LEFTOVERS_EVERY_MS).toISOString();
    hub.monitorTimers = [setInterval(() => { hub.monitor.nextLogin = new Date(Date.now() + LOGIN_EVERY_MS).toISOString(); hub.checkLogins(true); }, LOGIN_EVERY_MS).unref(),
      setInterval(() => { hub.monitor.nextLeftovers = new Date(Date.now() + LEFTOVERS_EVERY_MS).toISOString(); hub.checkLeftovers(); }, LEFTOVERS_EVERY_MS).unref()];
    hub.checkLeftovers();
  }
  hub.checkLogins(false);
}
const errorAt = (err) => ({ message: err?.message ?? String(err), at: new Date().toISOString() });
// Preserve the last success separately from the latest failure, including unreadable login output.
async function checkLogins(hub, all, requested) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  const providers = (requested ?? [...new Set(rooms.flatMap(providersOf))]).filter((p) => all || !(p in hub.monitor.login));
  await Promise.all(providers.map(async (p) => {
    try {
      const result = await rooms[0].usage.checkLogin(p), checked = new Date().toISOString();
      if (result.state === 'unknown') hub.monitor.errors.login[p] = { message: result.error, at: checked };
      else hub.monitor.login[p] = { ...result, checked };
      hub.monitor.loginCurrent ??= {};
      hub.monitor.loginCurrent[p] = { ...result, checked };
    } catch (err) {
      hub.monitor.errors.login[p] = errorAt(err);
      (hub.monitor.loginCurrent ??= {})[p] = { state: 'unknown', error: hub.monitor.errors.login[p].message, checked: hub.monitor.errors.login[p].at };
    }
  }));
  for (const r of loadedRooms(hub)) showMonitor(r);
}
async function checkLeftovers(hub) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  try {
    const tracked = new Set(rooms.flatMap((r) => [...(r.programs?.running ?? [])].map((p) => p.pid)));
    hub.monitor.leftovers = await rooms[0].findLeftovers(tracked);
    hub.monitor.leftoversChecked = new Date().toISOString();
  } catch (err) { hub.monitor.errors.leftovers = errorAt(err); }
  for (const r of loadedRooms(hub)) showMonitor(r);
}
const commandOutput = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 20_000 }, (err, out) => err ? reject(err) : resolve(String(out).trim())));
async function checkCli(hub, provider, run = commandOutput) {
  let path;
  try {
    path = await run('which', [provider]);
    const version = await run(path, ['--version']);
    hub.monitor.cli[provider] = { path, version, checked: new Date().toISOString() };
  } catch (err) { hub.monitor.errors.cli[provider] = { ...errorAt(err), path: path ?? null }; }
}
// A diagnostic is a fresh provider invocation, separate from every agent's session and rulebook.
async function runPromptTest(ctx, provider, model, runner, parsers) {
  const hub = hubOf(ctx), rooms = loadedRooms(hub);
  if (!['claude', 'codex', 'agy'].includes(provider) || typeof model !== 'string') throw new Error('Choose a provider and model.');
  const configured = rooms.flatMap((r) => { const s = currentSettings(r); return [...s.agents, s.worker]; });
  if (model && !configured.some((a) => a.provider === provider && a.model === model)) throw new Error('Choose a model configured on this server.');
  hub.promptRunning ??= new Set();
  if (hub.promptRunning.has(provider)) throw new Error('A prompt test for this provider is already running.');
  hub.promptRunning.add(provider);
  const started = Date.now(), at = new Date(started).toISOString();
  let dir, reply = '', error = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'agent-room-prompt-test-'));
    let args;
    if (provider === 'claude') {
      args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'];
      if (model) args.push('--model', model);
      args.push('--tools', '');
    } else if (provider === 'codex') {
      args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', 'web_search="disabled"'];
      if (model) args.push('-m', model);
      args.push('-');
    } else {
      args = ['--output-format', 'json', '--sandbox'];
      if (model) args.push('--model', model);
    }
    const output = await runner(provider, args, { input: 'Reply with exactly OK.', cwd: dir, timeoutMs: 30_000, agent: 'prompt test' });
    if (provider === 'claude') {
      const result = JSON.parse(output);
      if (result.is_error) throw new Error(`claude: ${result.result || 'test failed'}`);
      reply = String(result.result ?? '').trim();
    } else if (provider === 'codex') reply = parsers.parseCodexEvents(output).text;
    else reply = parsers.parseAgyOutput(output).text;
    if (!reply) throw new Error(`${provider}: no reply`);
  } catch (err) { error = err?.message ?? String(err); }
  finally {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); }
    catch (err) { error = [error, `Could not remove temporary folder: ${err.message}`].filter(Boolean).join('; '); }
    hub.promptRunning.delete(provider);
  }
  const result = { provider, model, at, durationMs: Date.now() - started, outcome: error ? 'failed' : 'ok', reply: reply.slice(0, 200), error };
  hub.promptResults ??= new Map();
  if (!hub.promptResults.has(provider)) hub.promptResults.set(provider, new Map());
  hub.promptResults.get(provider).set(model, result);
  return result;
}
function healthView(ctx) {
  const hub = hubOf(ctx), m = hub.monitor;
  const rooms = loadedRooms(hub);
  const catalogs = { claude: { models: claudeModels, loaded: true, error: null }, codex: codexModels.status(), agy: agyModels.status() };
  const configured = (settings) => [...settings.agents.map((a) => ({ ...a, role: 'member' })), { ...settings.worker, role: 'worker' }]
    .map((a) => ({ ...a, alignment: modelAlignment(a.model, catalogs[a.provider]) }));
  const defaults = readDefaults();
  const sessions = rooms.map((r) => {
    const view = sessionView(r);
    const entry = (agent, role, key) => ({ ...agent, role, lastTurn: r.turnRecords?.get(r.sessions.get(key)) ?? null });
    return { room: r.cwd, discussion: folderOf(r), agents: [
      ...view.agents.map((a) => entry(a, 'member', a.name)), entry(view.worker, 'worker', `worker:${view.worker.name}`) ] };
  });
  return { promptResults: [...(hub.promptResults?.values() ?? [])].flatMap((results) => [...results.values()]),
    promptRunning: [...(hub.promptRunning ?? [])], sessions, scheduledProviders: [...new Set(rooms.flatMap(providersOf))], catalogs,
    configured: rooms.map((r) => ({ room: r.cwd, discussion: folderOf(r), agents: configured(currentSettings(r)).map((a) => ({ ...a, enabled: a.role === 'worker' || !(r.state.disabledAgents ?? []).includes(a.name) })) })),
    defaults: defaults ? configured(defaults) : null, login: m.login, loginCurrent: m.loginCurrent ?? {}, cli: m.cli, errors: m.errors,
    leftovers: m.leftovers, leftoversChecked: m.leftoversChecked, nextLogin: m.nextLogin, nextLeftovers: m.nextLeftovers,
    running: loadedRooms(hub).flatMap((r) => [...(r.programs?.running ?? [])].map((p) => ({ pid: p.pid, provider: p.provider, ...p.monitorInfo }))),
    quota: loadedRooms(hub).map((r) => ({ room: r.cwd, reachable: r.screen.quota === undefined ? null : r.screen.quota !== null, ...r.screen.quotaAt })) };
}
async function checkProviderHealth(ctx) {
  const hub = hubOf(ctx);
  codexModels();
  await Promise.all([agyModels.refresh(), checkLogins(hub, true, ['claude', 'codex', 'agy']), checkLeftovers(hub),
    ...['claude', 'codex', 'agy'].map((p) => checkCli(hub, p)), ...loadedRooms(hub).map((r) => refreshQuota(r).catch(() => null))]);
  return healthView(ctx);
}
// What this room's panel shows, per provider: its login, how many of this room's programs are in its
// procs, and the leftovers of this room, or of a room not open on this server. A provider with a
// leftover is shown even when no agent of this room uses it.
function monitorView(ctx) {
  const hub = hubOf(ctx);
  const open = new Set(loadedRooms(hub).map((r) => r.cwd));
  const leftovers = (hub.monitor?.leftovers ?? []).filter((l) => l.room === ctx.cwd || !open.has(l.room));
  const running = [...(ctx.programs?.running ?? [])];
  const view = {};
  for (const p of new Set([...providersOf(ctx), ...leftovers.map((l) => l.provider)])) {
    view[p] = { login: hub.monitor?.loginCurrent?.[p] ?? hub.monitor?.login[p] ?? null, running: running.filter((r) => r.provider === p).length,
      leftovers: leftovers.filter((l) => l.provider === p), inRoom: providersOf(ctx).includes(p) };
  }
  return view;
}
function showMonitor(ctx) {
  if (!ctx.screen || !ctx.room) return;
  ctx.screen.monitor = monitorView(ctx);
  toScreen(ctx, { type: 'monitor', monitor: ctx.screen.monitor });
}


return { monitorAgentTurns, refreshQuota, watchMonitor, checkLogins, checkLeftovers, checkCli,
  runPromptTest, healthView, checkProviderHealth, monitorView, showMonitor };
}
