// Usage stats: token counts per turn (from the CLIs' own output, via agent.lastUsage) and
// subscription quotas from an optional local quota meter (AGENT_ROOM_METER, or port 9899).
// Missing quota data does not prevent the room from running.
// Loaded by ui.mjs, so /reload swaps it too.

import { execFile } from 'node:child_process';

export const METER_URL = process.env.AGENT_ROOM_METER ?? 'http://127.0.0.1:9899';
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
  const measuredMs = parseMeterTime(quota.last_update);
  if (measuredMs === null) return { ok: false, reason: 'quota meter timestamp is missing or unreadable' };
  const ageMs = now - measuredMs;
  if (ageMs > maxAgeMs) {
    const mins = Math.round(ageMs / 60_000);
    return { ok: false, reason: `quota meter reading is stale (${mins}m old, updated ${quota.last_update})` };
  }
  for (const p of unique) {
    const gauges = quotaGauges(quota, [p]);
    const has5h = gauges.some((g) => g.label === '5h');
    const hasWeek = gauges.some((g) => g.label === 'week');
    if (!has5h || !hasWeek) {
      const missing = [!has5h && '5h', !hasWeek && 'weekly'].filter(Boolean).join(' and ');
      return { ok: false, reason: `${p} ${missing} quota reading is missing` };
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

// The meter's /usage JSON, or null if it can't be read within the timeout.
export async function fetchQuota(url = METER_URL, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/usage`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
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

// The quota windows as gauges for the screen's header: [{ provider, label, used, resets }], in the
// order of providers; [] if the meter had nothing for them.
export function quotaGauges(quota, providers) {
  return providers.flatMap((p) => {
    const block = quota?.antigravity;
    const groups = p === 'agy' && block?.ok ? block.parsed?.groups : null;
    if (groups) return [['gemini', '5h', '5h'], ['gemini', 'week', 'weekly'], ['argon', 'week', 'weekly']]
      .flatMap(([group, label, window]) => {
        const x = groups[group]?.windows?.[window];
        return typeof x?.used_percent === 'number' ? [{ provider: p, group, label, used: x.used_percent, resets: resetTime(x.resets, quota.last_update) }] : [];
      });
    return windows(quota, p).map(([label, x]) => ({ provider: p, label, used: x.used_percent, resets: resetTime(x.resets, quota.last_update) }));
  });
}

// One-line self-usage header for an agent's or worker's prompt, holding only that agent's own
// cumulative reported session total and its own provider's cached quota snapshot.
function meterTime(measured, now = new Date()) {
  if (!measured) return '';
  const text = String(measured).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(text);
  if (!m) return text;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return m[1] === today ? m[2] : `${m[1]} ${m[2]}`;
}

function formatProviderGauges(gauges, provider) {
  const mine = Array.isArray(gauges) ? gauges.filter((g) => g?.provider === provider && typeof g.used === 'number') : [];
  if (!mine.length) return null;
  const grouped = new Map();
  for (const g of mine) {
    const key = g.group ?? '';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(`${g.used}% ${g.label}`);
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
  const at = quotaText ? meterTime(measured, now) : '';
  const quotaPart = quotaText ? `${quotaText}${at ? `, meter at ${at}` : ''}` : 'quota unavailable';
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
    lines.push(`Subscription quota: the meter at ${url} is not reachable (best-effort; skipped).`);
    return lines.join('\n');
  }
  lines.push(`Subscription quota (meter, updated ${quota.last_update ?? '?'}):`);
  for (const p of [...new Set(agents.map((a) => a.provider))]) {
    const w = windows(quota, p);
    lines.push(`  ${p.padEnd(10)} ${w.length ? w.map(([label, x]) => `${label} ${x.used_percent}% used${x.resets ? ` (at ${resetTime(x.resets, quota.last_update)})` : ''}`).join(' · ') : 'unavailable'}`);
  }
  return lines.join('\n');
}

// Login, as each provider's own status command reports it: { state, expiresAt?, error? }, state
// 'ok', 'ending' (in 2 days or less), 'expired', 'out' (logged out) or 'unknown' (the command failed
// or its output can't be read: never a guess).
const ENDING_MS = 2 * 24 * 3600 * 1000;
export function parseClaudeAuth(stdout, now = Date.now()) {
  let s;
  try { s = JSON.parse(stdout); } catch { return { state: 'unknown', error: `claude auth status: unreadable output: ${String(stdout).trim().slice(0, 200) || '(none)'}` }; }
  if (s?.loggedIn === false) return { state: 'out' };
  if (s?.loggedIn !== true) return { state: 'unknown', error: 'claude auth status: no loggedIn field' };
  if (s.loginExpiresAt == null) return { state: 'ok', expiresAt: null };
  const at = Date.parse(s.loginExpiresAt);
  if (Number.isNaN(at)) return { state: 'unknown', error: `claude auth status: unreadable loginExpiresAt: ${s.loginExpiresAt}` };
  const expiresAt = new Date(at).toISOString();
  return { state: at <= now ? 'expired' : at - now <= ENDING_MS ? 'ending' : 'ok', expiresAt };
}
// `codex login status` prints one line (on stderr, measured), with no expiry.
export function parseCodexLogin(text) {
  const t = String(text).trim();
  if (/^not logged in\b/im.test(t)) return { state: 'out' };
  if (/^logged in\b/im.test(t)) return { state: 'ok', expiresAt: null };
  return { state: 'unknown', error: `codex login status: unreadable output: ${t.slice(0, 200) || '(none)'}` };
}
const LOGIN_COMMANDS = { claude: ['claude', ['auth', 'status', '--json'], (out) => parseClaudeAuth(out)],
  codex: ['codex', ['login', 'status'], (out, err) => parseCodexLogin(`${out}\n${err}`)] };
// Runs the provider's status command. Its exit code isn't trusted alone (logged out may exit
// non-zero with a readable answer); a failure to run, or unreadable output, is 'unknown'.
export function checkLogin(provider, exec = execFile) {
  if (provider === 'agy') return Promise.resolve({ state: 'unmonitored' });
  const known = LOGIN_COMMANDS[provider];
  if (!known) return Promise.resolve({ state: 'unknown', error: `no login check for ${provider}` });
  const [command, args, parse] = known;
  return new Promise((done) => exec(command, args, { timeout: 20_000 }, (err, stdout = '', stderr = '') => {
    if (err && (typeof err.code !== 'number' || err.killed)) return done({ state: 'unknown', error: `${command} ${args.join(' ')}: ${err.message}` });
    const login = parse(String(stdout), String(stderr));
    if (err && login.state === 'unknown') login.error += ` (exit ${err.code}: ${String(stderr).trim().slice(-200)})`;
    done(login);
  }));
}
