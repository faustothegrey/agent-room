// Usage stats: token counts per turn (from the CLIs' own output, via agent.lastUsage) and
// subscription quotas from the local quota meter (~/Software/scripts-ai/quota-monitoring, the
// service AgentTalk read too). The meter is best-effort: if it is down, quotas are simply left out.
// Loaded by ui.mjs, so /reload swaps it too.

export const METER_URL = process.env.AGENT_ROOM_METER ?? 'http://127.0.0.1:9899';

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
  const block = quota?.[provider];
  if (!block?.ok) return [];
  const p = block.parsed ?? {};
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
    lines.push(`  ${p.padEnd(10)} ${w.length ? w.map(([label, x]) => `${label} ${x.used_percent}% used${x.resets ? ` (resets ${x.resets})` : ''}`).join(' · ') : 'unavailable'}`);
  }
  return lines.join('\n');
}
