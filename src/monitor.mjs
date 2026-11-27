// Per-room quota and server-wide provider monitoring, bound to the current room coordinator.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Check now's diagnostics (README, "Provider health"): what the server's own environment shows of each
// provider's launch, and the CLI processes it can see. Names of variables only, never their values.
export const AUTH_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
  agy: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI'],
};
export const configFolder = (provider, env = process.env, home = homedir()) => provider === 'claude' ? env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  : provider === 'codex' ? env.CODEX_HOME || join(home, '.codex') : join(home, '.gemini', 'antigravity-cli');
// `ps -axo pid=,pgid=,etime=,tty=,comm=` → the claude, codex and agy processes, by executable name
// only (never arguments or folders). Owner: 'agent-room' when the process or its group leader is a
// recorded program (agent-room starts each CLI as its own group); 'external' when it has a terminal
// (agent-room starts CLIs detached, without one); otherwise 'unknown'.
export function parseProcesses(text, recorded) {
  return String(text).split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    const provider = m?.[5].split('/').pop();
    if (!m || !['claude', 'codex', 'agy'].includes(provider)) return [];
    const pid = Number(m[1]), pgid = Number(m[2]), tty = m[4];
    const [owner, evidence] = recorded.has(pid) ? ['agent-room', 'recorded program'] : recorded.has(pgid) ? ['agent-room', "in a recorded program's process group"]
      : !['?', '??', '-'].includes(tty) ? ['external', 'has a terminal; agent-room starts CLIs without one'] : ['unknown', 'no record and no terminal'];
    return [{ pid, provider, elapsed: m[3], owner, evidence }];
  });
}
const execText = (command, args, { ok = [] } = {}) => new Promise((resolve, reject) => execFile(command, args, { timeout: 20_000, env: { ...process.env, LC_ALL: 'C' } },
  (err, out) => err && !ok.includes(err.code) ? reject(err) : resolve(String(out ?? ''))));

export function createMonitor({ hubOf, toScreen, currentSettings, claudeModels, codexModels, agyModels,
  modelAlignment, readDefaults, sessionView, folderOf }) {
// Turn records live only in memory, keyed by the actual provider session, never in checkpoints.
// With `ctx` (its room), each turn that ends also updates its provider's quota (turnQuota).
function monitorAgentTurns(agent, session, records, ctx) {
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
    } finally { if (ctx) turnQuota(ctx, agent); }
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
  ctx.screen.quotaAt = { measured: quota?.last_update ?? null, providers: Object.fromEntries(providers.map((p) => [p, quota?.[p === 'agy' ? 'antigravity' : p]?.updated_at ?? null])), checked: new Date().toISOString() };
  toScreen(ctx, { type: 'quota', gauges: ctx.screen.quota, at: ctx.screen.quotaAt });
  return quota;
}

// After a turn: its provider's entry in the shared quota cache (a Claude turn's own reading, the
// Codex rollouts, agy's /usage), then every open room's gauges, without waiting for the 120 s poll.
// Not with an HTTP meter (AGENT_ROOM_METER), which the cache doesn't feed.
function turnQuota(ctx, agent) { return feedQuota(ctx, agent.provider, agent.lastQuota); }
function feedQuota(ctx, provider, reading) {
  const hub = hubOf(ctx), usage = ctx.usage;
  if (!hub.quotaCache || !usage?.refreshProviderQuota || usage.METER_URL) return Promise.resolve();
  return usage.refreshProviderQuota(provider, reading, hub.quotaCache)
    .then(() => Promise.all(loadedRooms(hub).map((r) => refreshQuota(r).catch(() => null)))).catch(() => {});
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
  if (ctx.usage.useQuotaCache) {
    hub.quotaCache ??= { value: null };
    ctx.usage.useQuotaCache(hub.quotaCache);
    hub.refreshQuotaCache = () => ctx.usage.refreshQuotaCache(hub.quotaCache);
    if (!hub.quotaCacheTimer && !ctx.usage.METER_URL) {
      hub.refreshQuotaCache();
      hub.quotaCacheTimer = setInterval(() => hub.refreshQuotaCache(), 120_000).unref();
    }
  }
  ctx.showMonitor = () => showMonitor(ctx);
  // The latest startup summary, sent again to pages that connect later (screen-events.mjs).
  if (ctx.screen) ctx.screen.startup = hub.startupSummary ?? null;
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
async function checkLogins(hub, all, requested, options) {
  const rooms = loadedRooms(hub);
  if (!rooms.length) return;
  const providers = (requested ?? [...new Set(rooms.flatMap(providersOf))]).filter((p) => all || !(p in hub.monitor.login));
  await Promise.all(providers.map(async (p) => {
    try {
      const result = await rooms[0].usage.checkLogin(p, undefined, options), checked = new Date().toISOString();
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
  let dir, reply = '', error = null, quota = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'agent-room-prompt-test-'));
    let args;
    if (provider === 'claude') {
      args = ['-p', ...parsers.CLAUDE_STREAM, '--no-session-persistence', '--strict-mcp-config'];
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
      const parsed = parsers.parseClaudeStream(output), { result } = parsed;
      quota = parsed.quota ?? null;
      // Its init event's permission mode: Claude's live report for the permission check.
      if (parsed.permissionMode) (hub.permissionLive ??= {}).claude = { mode: parsed.permissionMode, at };
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
  // Claude's reply carries its quota reading: the gauges need not wait for a turn or the poll.
  if (quota) await feedQuota(ctx, 'claude', quota);
  updateStartupSummary(hub);
  return result;
}
// Each provider's permission configuration, read afresh (Check now and the startup checks).
async function checkPermissions(hub) {
  const rooms = loadedRooms(hub), perms = rooms[0]?.permissions;
  if (!perms) return;
  hub.monitor.permissions ??= {};
  for (const p of PROVIDERS) hub.monitor.permissions[p] = { config: perms.read(p), checked: new Date().toISOString() };
}
function permissionReports(hub) {
  const perms = loadedRooms(hub)[0]?.permissions;
  if (!perms || !hub.monitor?.permissions) return null;
  return Object.fromEntries(PROVIDERS.map((p) => [p, { ...perms.report(p, hub.monitor.permissions[p]?.config, hub.permissionLive?.[p] ?? null), checked: hub.monitor.permissions[p]?.checked ?? null }]));
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
    defaults: defaults ? configured(defaults) : null, diagnostics: m.diagnostics ?? null, permissions: permissionReports(hub), login: m.login, loginCurrent: m.loginCurrent ?? {}, cli: m.cli, errors: m.errors,
    leftovers: m.leftovers, leftoversChecked: m.leftoversChecked, nextLogin: m.nextLogin, nextLeftovers: m.nextLeftovers,
    running: loadedRooms(hub).flatMap((r) => [...(r.programs?.running ?? [])].map((p) => ({ pid: p.pid, provider: p.provider, ...p.monitorInfo }))),
    quota: loadedRooms(hub).map((r) => ({ room: r.cwd, reachable: r.screen.quota === undefined ? null : r.screen.quota !== null, ...r.screen.quotaAt })) };
}
// `diagnostics`: Check now only (not the startup checks), which also runs checkDiagnostics.
async function checkProviderHealth(ctx, { diagnostics = false } = {}) {
  const hub = hubOf(ctx);
  codexModels();
  await Promise.all([agyModels.refresh(), checkLogins(hub, true, ['claude', 'codex', 'agy'], { authMode: diagnostics }), checkLeftovers(hub), checkPermissions(hub),
    ...['claude', 'codex', 'agy'].map((p) => checkCli(hub, p)), ...loadedRooms(hub).map((r) => refreshQuota(r).catch(() => null))]);
  if (diagnostics) await checkDiagnostics(hub);
  updateStartupSummary(hub);
  return healthView(ctx);
}
// Each diagnostic keeps { result, checked, error }: a failed rerun records its error and keeps the
// previous result with its own time. Runs after the login and leftovers checks it reads.
async function checkDiagnostics(hub, { run = execText, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const rooms = loadedRooms(hub);
  const d = hub.monitor.diagnostics ??= { processes: {}, launch: Object.fromEntries(PROVIDERS.map((p) => [p, { executables: {}, configFolder: {}, env: {}, authMode: {} }])) };
  const attempt = async (slot, fn) => {
    try { Object.assign(slot, { result: await fn(), checked: new Date().toISOString(), error: null }); }
    catch (err) { slot.error = errorAt(err); }
  };
  const recorded = () => new Set([...rooms.flatMap((r) => [...(r.programs?.running ?? [])].map((p) => p.pid)),
    ...(hub.monitor.leftovers ?? []).map((l) => l.pid), ...(rooms[0]?.recordedPids?.() ?? [])]);
  await Promise.all([
    attempt(d.processes, async () => parseProcesses(await run('ps', ['-axo', 'pid=,pgid=,etime=,tty=,comm=']), recorded())),
    ...PROVIDERS.flatMap((p) => { const l = d.launch[p]; return [
      // `which` exits 1 when nothing matches; the first path is the one agent-room's spawn finds.
      attempt(l.executables, async () => [...new Set((await run('which', ['-a', p], { ok: [1] })).split('\n').map((x) => x.trim()).filter(Boolean))]),
      attempt(l.configFolder, async () => { const path = configFolder(p, env, home); return { path, exists: exists(path) }; }),
      attempt(l.env, async () => AUTH_ENV[p].filter((name) => !!env[name])),
      // Only what checkLogin's status command said; agy's login is not monitored.
      p !== 'agy' && attempt(l.authMode, async () => {
        const login = hub.monitor.loginCurrent?.[p];
        if (!login || login.state === 'unknown') throw new Error('login status not read');
        return login.authMode ?? 'unknown';
      })]; })]);
}

// Startup diagnostics (README, "Providers"): once per server start or Restart, after the restored
// rooms have loaded (cli.mjs; not on Reload), everything Check now does plus one Test prompt per
// provider with its CLI default model, in the background.
const PROVIDERS = ['claude', 'codex', 'agy'];
async function startupChecks(hub, health = checkProviderHealth) {
  const rooms = loadedRooms(hub);
  if (!rooms.length || hub.startupChecks) return;
  const ctx = rooms[0];
  hub.startupChecks = 'running';
  await Promise.all([health(ctx).catch(() => null),
    ...PROVIDERS.map((p) => ctx.testPrompt(ctx, p, '').catch(() => null))]);
  hub.startupChecks = 'done';
  updateStartupSummary(hub, true);
}
// What the startup summary counts as a problem, from the latest results (so a later Check now or
// Test prompt can resolve it). An error counts while no success is newer.
function startupProblems(hub) {
  const m = hub.monitor ?? {}, errors = m.errors ?? {}, rooms = loadedRooms(hub);
  const current = (err, ok) => !!err?.at && !(ok && ok >= err.at);
  const problems = [];
  for (const p of ['claude', 'codex']) if ((m.loginCurrent?.[p] ?? m.login?.[p])?.state !== 'ok') problems.push(`${p} login`);
  for (const p of PROVIDERS) if (current(errors.cli?.[p], m.cli?.[p]?.checked)) problems.push(`${p} CLI`);
  const catalogs = { codex: codexModels.status(), agy: agyModels.status() };
  const settings = [...rooms.map((r) => currentSettings(r)), readDefaults()].filter(Boolean);
  for (const p of ['codex', 'agy']) {
    if (!catalogs[p].loaded) problems.push(`${p} model list`);
    else if (settings.some((s) => [...s.agents, s.worker].some((a) => a.provider === p && modelAlignment(a.model, catalogs[p]) === 'not in list'))) problems.push(`${p} model not in list`);
  }
  if (current(errors.leftovers, m.leftoversChecked)) problems.push('leftovers check');
  const reports = permissionReports(hub);
  for (const p of PROVIDERS) if (reports && reports[p].state !== 'ok') problems.push(`${p} permission mode`);
  for (const p of PROVIDERS) {
    const latest = [...(hub.promptResults?.get(p)?.values() ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    if (latest?.outcome === 'failed') problems.push(`${p} test prompt`);
  }
  return problems;
}
// One line in every open room's System messages when the startup checks find problems (none when
// all pass). Kept in hub.startupSummary for pages that connect later; a later Check now or Test
// prompt updates it, or clears it once the problems are resolved.
function updateStartupSummary(hub, first = false) {
  if (hub.startupChecks !== 'done') return;
  const before = hub.startupSummary ?? null;
  if (!first && before === null) return;
  const problems = startupProblems(hub), n = problems.length;
  const text = n ? `Startup checks: ${n} problem${n === 1 ? '' : 's'} (${problems.join(', ')}) · see Providers` : null;
  hub.startupSummary = text;
  if (text === before) return;
  const shown = text ?? 'Startup checks: the problems are resolved';
  console.log(shown);
  for (const r of loadedRooms(hub)) {
    if (r.screen) r.screen.startup = text;
    toScreen(r, { type: 'note', text: shown, error: !!text });
  }
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
  runPromptTest, healthView, checkProviderHealth, checkDiagnostics, monitorView, showMonitor, startupChecks, startupProblems, checkPermissions };
}
