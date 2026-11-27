// Usage stats: token counts per turn (from the CLIs' own output, via agent.lastUsage) and
// subscription quotas from a background cache, or an optional HTTP meter.
// Missing quota data does not prevent the room from running.
// Loaded by ui.mjs, so /reload swaps it too.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const METER_URL = process.env.AGENT_ROOM_METER || null;
export const QUOTA_STALE_MS = 15 * 60_000;

// Parse the meter's `last_update` timestamp ("YYYY-MM-DD HH:MM:SS" in local time, or ISO with zone).
export function parseMeterTime(text) {
  if (!text) return null;
  const s = String(text).trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, sec = '0'] = local;
    const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// Check that the quota meter reading is present, fresh, and every provider has at least `floor`%
// remaining in both its 5-hour and weekly windows. Returns { ok: true } or { ok: false, reason }.
export function checkQuotaFloor(quota, providers, floor = 50, { now = Date.now(), maxAgeMs = QUOTA_STALE_MS } = {}) {
  const unique = [...new Set(providers)].filter(Boolean);
  if (!unique.length) return { ok: true };
  if (!quota || typeof quota !== 'object') return { ok: false, reason: 'quota meter reading is missing' };
  for (const p of unique) {
    const measured = quota?.[p === 'agy' ? 'antigravity' : p]?.updated_at;
    const measuredMs = parseMeterTime(measured);
    if (measuredMs === null) return { ok: false, reason: `${p} quota timestamp is missing or unreadable` };
    const ageMs = now - measuredMs;
    if (ageMs > maxAgeMs) return { ok: false, reason: `${p} quota reading is stale (${Math.round(ageMs / 60_000)}m old, updated ${measured})` };
    const gauges = quotaGauges(quota, [p]);
    const has5h = gauges.some((g) => g.label === '5h');
    const hasWeek = gauges.some((g) => g.label === 'week');
    if (!has5h || !hasWeek) {
      const missing = [!has5h && '5h', !hasWeek && 'weekly'].filter(Boolean).join(' and ');
      return { ok: false, reason: `${p} ${missing} quota reading is missing` };
    }
    const block = quota[p === 'agy' ? 'antigravity' : p];
    const readings = p === 'agy' && block?.parsed?.groups
      ? Object.entries(block.parsed.groups).flatMap(([group, data]) => Object.entries(data?.windows ?? {})
        .map(([name, window]) => ({ label: `${p} (${group}) ${name === 'weekly' ? 'week' : name}`, window })))
      : p === 'agy' && Array.isArray(block?.parsed?.models)
        ? block.parsed.models.map((w) => ({ label: `${p}${w.group ? ` (${w.group})` : ''} ${w.window === 'weekly' ? 'week' : w.window}`, window: w }))
        : windows(quota, p).map(([label, window]) => ({ label: `${p} ${label}`, window }));
    for (const { label, window } of readings) {
      if (!window) continue;
      const reset = quotaResetTime(window, measuredMs);
      if (reset !== null && reset > measuredMs && reset <= now) return { ok: false, reason: `${label} quota reset since its reading; a new reading is required` };
    }
    for (const g of gauges) {
      const remaining = 100 - g.used;
      if (remaining < floor) {
        const label = g.group ? `${p} (${g.group}) ${g.label}` : `${p} ${g.label}`;
        return { ok: false, reason: `${label} has ${Math.round(remaining)}% remaining (below ${floor}% floor)` };
      }
    }
  }
  return { ok: true };
}

// Adds one turn's usage ({ input, cached, output, cost? }) to a running total.
export function addUsage(total = { turns: 0, input: 0, cached: 0, output: 0 }, u) {
  if (!u) return total;
  const next = { turns: total.turns + 1, input: total.input + u.input, cached: total.cached + u.cached, output: total.output + u.output };
  if (typeof u.cost === 'number' || typeof total.cost === 'number') next.cost = (total.cost ?? 0) + (u.cost ?? 0);
  return next;
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// "4.2k in · 120 out · $0.02"
export function formatUsage(u) {
  if (!u) return '';
  return `${k(u.input)} in · ${k(u.output)} out${typeof u.cost === 'number' ? ` · $${u.cost.toFixed(2)}` : ''}`;
}

// Shared by all rooms; the server owns and starts the polling timer.
let quotaCache = { value: null };
export function useQuotaCache(cache) { quotaCache = cache; }
const stamp = (ms) => new Date(ms).toISOString();
function quotaWindow(used, reset) {
  if (used == null || !Number.isFinite(Number(used))) return null;
  let n = Number(used), out = {};
  const ms = typeof reset === 'number' ? reset * 1000 : Date.parse(reset);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    out.resets_at = d.toISOString();
    out.resets = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} on ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  out.used_percent = Math.max(0, Math.min(100, Math.round(n)));
  out.left_percent = 100 - out.used_percent;
  return out;
}
export async function readClaudeQuota(path = join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')), c = data.cachedUsageUtilization;
    if (!c || (c.accountUuid != null && c.accountUuid !== data.oauthAccount?.accountUuid) || !Number.isFinite(Number(c.fetchedAtMs)) || c.fetchedAtMs == null) return { ok: false, source: 'claude.json' };
    const parsed = {};
    for (const [key, source] of [['current_session', 'five_hour'], ['current_week_all_models', 'seven_day']]) {
      const w = c.utilization?.[source], value = w && quotaWindow(w.utilization, w.resets_at);
      if (value) parsed[key] = value;
    }
    return { ok: !!Object.keys(parsed).length, source: 'claude.json', updated_at: stamp(Number(c.fetchedAtMs)), parsed };
  } catch { return { ok: false, source: 'claude.json' }; }
}
export async function readCodexQuota(root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), readSession = readFile) {
  const files = [];
  async function walk(dir) {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { files.push({ path, mtime: (await stat(path)).mtimeMs }); } catch {} }
    }));
  }
  await walk(root); files.sort((a, b) => b.mtime - a.mtime);
  let best;
  for (const f of files.slice(0, 30)) {
    let data; try { data = await readSession(f.path, 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const ev = JSON.parse(line), rl = ev.payload?.rate_limits, time = Date.parse(ev.timestamp);
        if (rl && (rl.limit_id == null || rl.limit_id === 'codex') && (rl.primary || rl.secondary) && Number.isFinite(time) && (!best || time > best.time)) best = { time, rl };
      } catch {}
    }
    if (best) break;
  }
  if (!best) return { ok: false, source: 'codex-sessions' };
  const parsed = {};
  for (const [slot, fallback] of [['primary', 'five_hour_limit'], ['secondary', 'weekly_limit']]) {
    const w = best.rl[slot]; if (!w) continue;
    const value = quotaWindow(w.used_percent, w.resets_at);
    if (value) parsed[w.window_minutes === 300 ? 'five_hour_limit' : w.window_minutes === 10080 ? 'weekly_limit' : fallback] = { ...value, window_minutes: w.window_minutes };
  }
  if (best.rl.plan_type) parsed.plan_type = best.rl.plan_type;
  return { ok: !!(parsed.five_hour_limit || parsed.weekly_limit), source: 'codex-sessions', updated_at: stamp(best.time), parsed };
}
export function parseAgyQuota(data, now = Date.now()) {
  const groups = {}, models = [];
  for (const g of data?.command?.data?.groups ?? []) {
    const buckets = g.buckets ?? [], ids = buckets.map((b) => String(b.id ?? ''));
    const key = ids.some((i) => i.includes('argon')) || /argon/i.test(g.name ?? '') ? 'argon' : ids.map((i) => /^(.*?)-(?:weekly|5h)$/.exec(i)?.[1]).find(Boolean) || String(g.name ?? 'group').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const windows = {};
    for (const b of buckets) {
      if (b.remaining_fraction == null || !Number.isFinite(Number(b.remaining_fraction))) continue;
      const value = quotaWindow((1 - Number(b.remaining_fraction)) * 100, b.reset_time);
      const window = b.window || (String(b.id).includes('weekly') ? 'weekly' : '5h');
      windows[window] = { ...value, id: b.id };
      models.push({ label: `${g.name} (${b.name})`, group: key, window, ...value });
    }
    if (Object.keys(windows).length) groups[key] = { name: g.name, description: g.description, windows, highest_used_percent: Math.max(...Object.values(windows).map((w) => w.used_percent)) };
  }
  const parsed = { groups, models };
  if (models.length) { const top = models.reduce((a, b) => a.used_percent >= b.used_percent ? a : b); Object.assign(parsed, { highest_used_percent: top.used_percent, lowest_left_percent: 100 - top.used_percent, highest_used_group: top.group }); }
  return { ok: !!models.length, source: 'agy-json', updated_at: stamp(now), parsed };
}
export async function readAgyQuota(exec = execFile) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'agy-quota-'));
    const stdout = await new Promise((resolve, reject) => { const child = exec('agy', ['-p', '/usage', '--output-format', 'json'], { cwd: dir, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(String(out))); child?.stdin?.end(); });
    const data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    if (data.status != null && data.status !== 'SUCCESS') throw new Error('agy status ' + data.status);
    return parseAgyQuota(data);
  } catch { return { ok: false, source: 'agy-json' }; }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}
// A Claude turn's reading (parseClaudeStream in agents.mjs) as the cache's claude entry, in the
// shape readClaudeQuota gives; updated_at is when the turn received it.
export function claudeStreamQuota(reading) {
  const parsed = {};
  for (const [key, source] of [['current_session', 'five_hour'], ['current_week_all_models', 'seven_day']]) {
    const w = reading?.[source], value = w && quotaWindow(w.used_percent, w.resets_at);
    if (value) parsed[key] = value;
  }
  const at = Number(reading?.received_at);
  return { ok: !!Object.keys(parsed).length && Number.isFinite(at), source: 'claude-stream', updated_at: Number.isFinite(at) ? stamp(at) : null, parsed };
}
// Puts a provider's new reading in the cache: a successful one replaces the entry unless that holds
// a newer successful reading (so an older ~/.claude.json can't overwrite a turn's); a failed one
// only fills an empty entry.
function storeQuota(cache, key, result) {
  const value = { ...cache.value, last_update: stamp(Date.now()) }, old = value[key];
  const newer = () => !old?.ok || !((parseMeterTime(result.updated_at) ?? -Infinity) < (parseMeterTime(old.updated_at) ?? -Infinity));
  if (result.ok ? newer() : !old) value[key] = result;
  cache.value = value;
}
export async function refreshQuotaCache(cache = quotaCache, readers = [readClaudeQuota, readCodexQuota, readAgyQuota]) {
  if (cache.running) return;
  cache.running = true;
  try {
    await Promise.all(['claude', 'codex', 'antigravity'].map((key, i) => [key, readers[i]]).map(async ([key, read]) => {
      storeQuota(cache, key, await read());
    }));
  } finally { cache.running = false; }
}
// After one turn of `provider`: its entry alone, from the turn's own reading for Claude (or
// ~/.claude.json without one), the rollouts for Codex, `agy -p /usage` for agy.
export async function refreshProviderQuota(provider, reading, cache = quotaCache, readers = { claude: readClaudeQuota, codex: readCodexQuota, agy: readAgyQuota }) {
  const key = provider === 'agy' ? 'antigravity' : provider;
  if (!readers[provider]) return;
  storeQuota(cache, key, provider === 'claude' && reading ? claudeStreamQuota(reading) : await readers[provider]());
}
// The override keeps the old HTTP behavior; internal reads return the background snapshot immediately.
export async function fetchQuota(url = METER_URL, timeoutMs = 1500) {
  if (!url) return quotaCache.value;
  try {
    const res = await fetch(`${url}/usage`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// Each provider's quota windows as [label, { used_percent, resets }] pairs; empty if unavailable.
function windows(quota, provider) {
  const block = quota?.[provider === 'agy' ? 'antigravity' : provider];
  if (!block?.ok) return [];
  const p = block.parsed ?? {};
  if (provider === 'agy') {
    const models = Array.isArray(p.models) ? p.models : [];
    return [['5h', '5h'], ['week', 'weekly']].flatMap(([label, window]) => {
      const entries = models.filter((m) => m?.window === window && typeof m.used_percent === 'number');
      return entries.length ? [[label, entries.reduce((a, b) => a.used_percent >= b.used_percent ? a : b)]] : [];
    });
  }
  const pairs = provider === 'claude'
    ? [['5h', p.current_session], ['week', p.current_week_all_models]]
    : provider === 'codex' ? [['5h', p.five_hour_limit], ['week', p.weekly_limit]] : [];
  return pairs.filter(([, w]) => typeof w?.used_percent === 'number');
}

// One short line for the round marker: "claude 70% 5h / 31% week · codex 20% 5h / 3% week".
export function quotaSummary(quota, providers) {
  return providers
    .map((p) => [p, windows(quota, p)])
    .filter(([, w]) => w.length)
    .map(([p, w]) => `${p} ${w.map(([label, x]) => `${x.used_percent}% ${label}`).join(' / ')}`)
    .join(' · ');
}

// The meter uses local wall-clock text in two formats. Reorder it without converting zones.
// A time without a date means its next occurrence relative to the meter's measurement.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function resetTime(text, measured) {
  if (!text) return null;
  const zone = text.match(/ \([^)]+\)$/)?.[0] ?? '';
  const value = text.slice(0, text.length - zone.length).trim();
  const match = /^(?:([A-Za-z]{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm)?(?: on (\d{1,2}) ([A-Za-z]{3}))?$/i.exec(value);
  if (!match) return text; // Leave an unfamiliar meter format intact.
  let [, month, day, hour, minute = '00', period, endDay, endMonth] = match;
  hour = Number(hour);
  if (period) {
    if (hour < 1 || hour > 12) return text;
    hour = hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0);
  }
  if (hour > 23 || Number(minute) > 59) return text;
  month ||= endMonth; day ||= endDay;
  if (month) {
    month = MONTHS.find((m) => m.toLowerCase() === month.toLowerCase());
    if (!month || Number(day) < 1 || Number(day) > 31) return text;
  } else {
    const stamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(measured ?? '');
    const now = new Date();
    const [year, mon, date, h, min] = stamp ? stamp.slice(1).map(Number)
      : [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()];
    // UTC is calendar arithmetic only: the reset's local clock and zone stay untouched.
    const calendar = new Date(Date.UTC(year, mon - 1, date + (hour * 60 + Number(minute) < h * 60 + min ? 1 : 0)));
    day = calendar.getUTCDate(); month = MONTHS[calendar.getUTCMonth()];
  }
  return `${Number(day)} ${month} ${String(hour).padStart(2, '0')}:${minute}${zone}`;
}

// The HTTP meter can supply a human-readable reset instead of resets_at.
function quotaResetTime(window, measuredMs) {
  const explicit = typeof window.resets_at === 'number' ? window.resets_at * 1000 : Date.parse(window.resets_at);
  if (Number.isFinite(explicit)) return explicit;
  if (!window.resets) return null;
  const measured = new Date(measuredMs);
  const local = `${measured.getFullYear()}-${String(measured.getMonth() + 1).padStart(2, '0')}-${String(measured.getDate()).padStart(2, '0')} ${String(measured.getHours()).padStart(2, '0')}:${String(measured.getMinutes()).padStart(2, '0')}`;
  const formatted = resetTime(window.resets, local)?.replace(/ \([^)]+\)$/, '');
  const match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{2}):(\d{2})$/.exec(formatted ?? '');
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]);
  if (month < 0) return null;
  let date = new Date(measured.getFullYear(), month, Number(match[1]), Number(match[3]), Number(match[4]));
  if (date.getTime() < measuredMs - 180 * 86400_000) date = new Date(measured.getFullYear() + 1, month, Number(match[1]), Number(match[3]), Number(match[4]));
  return date.getTime();
}

// The quota windows as gauges for the screen's header: [{ provider, label, used, resets }], in the
// order of providers; [] if the meter had nothing for them.
export function quotaGauges(quota, providers) {
  return providers.flatMap((p) => {
    const block = quota?.antigravity;
    const groups = p === 'agy' && block?.ok ? block.parsed?.groups : null;
    if (groups) return [['gemini', '5h', '5h'], ['gemini', 'week', 'weekly'], ['argon', 'week', 'weekly']]
      .flatMap(([group, label, window]) => {
        const x = groups[group]?.windows?.[window];
        return typeof x?.used_percent === 'number' ? [{ provider: p, group, label, used: x.used_percent, resets: resetTime(x.resets, quota?.[p === 'agy' ? 'antigravity' : p]?.updated_at ?? quota.last_update) }] : [];
      });
    return windows(quota, p).map(([label, x]) => ({ provider: p, label, used: x.used_percent, resets: resetTime(x.resets, quota?.[p === 'agy' ? 'antigravity' : p]?.updated_at ?? quota.last_update) }));
  });
}

// One-line self-usage header for an agent's or worker's prompt, holding only that agent's own
// cumulative reported session total and its own provider's cached quota snapshot.
function meterTime(measured, now = new Date()) {
  const ms = parseMeterTime(measured);
  return ms === null ? '' : `${Math.max(0, Math.floor((now.getTime() - ms) / 60_000))}m old`;
}

function formatProviderGauges(gauges, provider) {
  const mine = Array.isArray(gauges) ? gauges.filter((g) => g?.provider === provider && typeof g.used === 'number') : [];
  if (!mine.length) return null;
  const grouped = new Map();
  for (const g of mine) {
    const key = g.group ?? '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(`${g.used}% used ${g.label}`);
  }
  const parts = [...grouped.entries()].map(([group, items]) => (group ? `${group} ` : '') + items.join(' / '));
  return `${provider} quota ${parts.join(', ')}`;
}

export function agentUsageLine({ total, usageUnavailable = false, provider, gauges, measured, now = new Date() } = {}) {
  const usagePart = usageUnavailable
    ? 'usage unavailable'
    : total?.turns
      ? `${total.turns} turn${total.turns === 1 ? '' : 's'}, ${k(total.input)} in (${k(total.cached)} cached) / ${k(total.output)} out`
      : 'none yet';
  const quotaText = formatProviderGauges(gauges, provider);
  const at = quotaText ? meterTime(typeof measured === 'object' && measured ? measured[provider] : measured, now) : '';
  const quotaPart = quotaText ? `${quotaText}${at ? `, reading ${at}` : ''}` : 'quota unavailable';
  return `[your reported usage this session: ${usagePart} · ${quotaPart}]`;
}

// The full /usage report: session totals per agent, then the quotas.
export function usageReport({ totals, agents, quota, url = METER_URL }) {
  const lines = ['Usage this session (from the CLIs\' own reports):'];
  for (const a of agents) {
    const t = totals[a.name];
    if (!t?.turns) { lines.push(`  ${a.name.padEnd(10)} no turns yet`); continue; }
    lines.push(`  ${a.name.padEnd(10)} ${t.turns} turn${t.turns === 1 ? '' : 's'} · ${k(t.input)} in (${k(t.cached)} cached) · ${k(t.output)} out` +
      (typeof t.cost === 'number' ? ` · $${t.cost.toFixed(2)} at API prices` : ''));
  }
  if (!quota) {
    lines.push(url ? `Subscription quota: the meter at ${url} is not reachable (best-effort; skipped).` : 'Subscription quota: readings unavailable (best-effort; skipped).');
    return lines.join('\n');
  }
  lines.push('Subscription quota:');
  for (const p of [...new Set(agents.map((a) => a.provider))]) {
    const w = windows(quota, p);
    lines.push(`  ${p.padEnd(10)} ${w.length ? w.map(([label, x]) => `${label} ${x.used_percent}% used${x.resets ? ` (at ${resetTime(x.resets, quota?.[p === 'agy' ? 'antigravity' : p]?.updated_at ?? quota.last_update)})` : ''}`).join(' · ') : 'unavailable'}${quota[p === 'agy' ? 'antigravity' : p]?.updated_at ? ` (updated ${quota[p === 'agy' ? 'antigravity' : p].updated_at}, ${meterTime(quota[p === 'agy' ? 'antigravity' : p].updated_at)})` : ''}`);
  }
  return lines.join('\n');
}

// Login, as each provider's own status command reports it: { state, expiresAt?, error? }, state
// 'ok', 'ending' (in 2 days or less), 'expired', 'out' (logged out) or 'unknown' (the command failed
// or its output can't be read: never a guess).
const ENDING_MS = 2 * 24 * 3600 * 1000;
export function parseClaudeAuth(stdout, now = Date.now()) {
  let s;
  try { s = JSON.parse(stdout); } catch { return { state: 'unknown', error: 'claude auth status --json: output not JSON' }; }
  if (s?.loggedIn === false) return { state: 'out' };
  if (s?.loggedIn !== true) return { state: 'unknown', error: 'claude auth status --json: no loggedIn field' };
  if (s.loginExpiresAt == null) return { state: 'ok', expiresAt: null };
  const at = Date.parse(s.loginExpiresAt);
  if (Number.isNaN(at)) return { state: 'unknown', error: 'claude auth status --json: login expiry unreadable' };
  const expiresAt = new Date(at).toISOString();
  return { state: at <= now ? 'expired' : at - now <= ENDING_MS ? 'ending' : 'ok', expiresAt };
}
// `codex login status` prints one line (on stderr, measured), with no expiry.
export function parseCodexLogin(text) {
  const t = String(text).trim();
  if (/^not logged in\b/im.test(t)) return { state: 'out' };
  if (/^logged in\b/im.test(t)) return { state: 'ok', expiresAt: null };
  return { state: 'unknown', error: 'codex login status: output not recognised' };
}
const LOGIN_COMMANDS = { claude: ['claude', ['auth', 'status', '--json'], (out) => parseClaudeAuth(out)],
  codex: ['codex', ['login', 'status'], (out, err) => parseCodexLogin(`${out}\n${err}`)] };
// The auth mode the status command states, for Check now's Launch environment, or 'unknown'. Only
// known values mapped to fixed display labels: never anything from CLI output verbatim.
const CLAUDE_AUTH_METHODS = new Map([
  ['claude.ai', 'claude.ai'],
  ['oauth_token', 'OAuth token'],
  ['api_key', 'API key'],
  ['console', 'Console'],
  ['third_party', 'third-party'],
]);
const CLAUDE_API_PROVIDERS = new Map([
  ['firstParty', 'firstParty'],
  ['bedrock', 'Bedrock'],
  ['vertex', 'Vertex'],
  ['foundry', 'Foundry'],
]);
export function authModeOf(provider, stdout, stderr = '') {
  if (provider === 'claude') {
    let s; try { s = JSON.parse(stdout); } catch { return 'unknown'; }
    const method = typeof s?.authMethod === 'string' ? CLAUDE_AUTH_METHODS.get(s.authMethod) : null;
    if (!method) return 'unknown';
    const apiProvider = typeof s?.apiProvider === 'string' ? CLAUDE_API_PROVIDERS.get(s.apiProvider) : null;
    return apiProvider ? `${method} (${apiProvider})` : method;
  }
  const t = `${stdout}\n${stderr}`;
  return /^logged in using chatgpt\b/im.test(t) ? 'ChatGPT' : /^logged in using an api key\b/im.test(t) ? 'API key' : 'unknown';
}
// Runs the provider's status command. Its exit code isn't trusted alone (logged out may exit
// non-zero with a readable answer); a failure to run, or unreadable output, is 'unknown'. With
// `authMode` (Check now only), the result also carries authModeOf's answer.
export function checkLogin(provider, exec = execFile, { authMode = false } = {}) {
  if (provider === 'agy') return Promise.resolve({ state: 'unmonitored' });
  const known = LOGIN_COMMANDS[provider];
  if (!known) return Promise.resolve({ state: 'unknown', error: `no login check for ${provider}` });
  const [command, args, parse] = known, label = `${command} ${args.join(' ')}`;
  return new Promise((done) => exec(command, args, { timeout: 20_000 }, (err, stdout = '', stderr = '') => {
    if (err && (typeof err.code !== 'number' || err.killed)) {
      const reason = err.killed ? 'timed out' : err.code === 'ENOENT' ? 'not found' : 'failed to run';
      return done({ state: 'unknown', error: `${label}: ${reason}` });
    }
    const login = parse(String(stdout), String(stderr));
    if (err && login.state === 'unknown') login.error = `${label}: exit ${err.code}`;
    if (authMode) login.authMode = authModeOf(provider, String(stdout), String(stderr));
    done(login);
  }));
}
