import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { addUsage, fetchQuota, formatUsage, quotaSummary, usageReport } from '../src/usage.mjs';

// The shape the quota meter returned on 2026-10-20 (trimmed).
const QUOTA = {
  claude: { ok: true, parsed: { current_session: { used_percent: 70, resets: '2:20pm' }, current_week_all_models: { used_percent: 31, resets: 'Oct 21 at 9am' } } },
  codex: { ok: true, parsed: { five_hour_limit: { used_percent: 20, resets: '13:44' }, weekly_limit: { used_percent: 3, resets: '07:44 on 27 Oct' } } },
  last_update: '2026-10-20 13:44:46',
};

test('totals add up turn by turn; cost only when some turn had one', () => {
  let t = addUsage(undefined, { input: 1000, cached: 400, output: 50, cost: 0.01 });
  t = addUsage(t, { input: 3200, cached: 0, output: 70, cost: 0.02 });
  t = addUsage(t, null);
  assert.deepEqual({ ...t, cost: +t.cost.toFixed(2) }, { turns: 2, input: 4200, cached: 400, output: 120, cost: 0.03 });
  assert.equal(addUsage(undefined, { input: 5, cached: 0, output: 1 }).cost, undefined);
  assert.equal(formatUsage(t), '4.2k in · 120 out · $0.03');
  assert.equal(formatUsage({ input: 999, cached: 0, output: 5 }), '999 in · 5 out');
});

test('quota summary covers only the room\'s providers, and skips unavailable ones', () => {
  assert.equal(quotaSummary(QUOTA, ['claude', 'codex']), 'claude 70% 5h / 31% week · codex 20% 5h / 3% week');
  assert.equal(quotaSummary(QUOTA, ['codex']), 'codex 20% 5h / 3% week');
  assert.equal(quotaSummary({ ...QUOTA, claude: { ok: false } }, ['claude', 'codex']), 'codex 20% 5h / 3% week');
  assert.equal(quotaSummary(null, ['claude']), '');
});

test('the /usage report lists each agent and the quotas, or says the meter is unreachable', () => {
  const agents = [{ name: 'Claude', provider: 'claude' }, { name: 'Codex', provider: 'codex' }];
  const totals = { Claude: { turns: 2, input: 4200, cached: 400, output: 120, cost: 0.03 } };
  const report = usageReport({ totals, agents, quota: QUOTA });
  assert.match(report, /Claude +2 turns · 4\.2k in \(400 cached\) · 120 out · \$0\.03 at API prices/);
  assert.match(report, /Codex +no turns yet/);
  assert.match(report, /claude +5h 70% used \(resets 2:20pm\) · week 31% used/);
  assert.match(report, /updated 2026-10-20 13:44:46/);
  assert.match(usageReport({ totals, agents, quota: null, url: 'http://x' }), /meter at http:\/\/x is not reachable/);
});

test('fetchQuota reads the meter, and returns null when it is down', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(QUOTA)); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await fetchQuota(url), QUOTA);
  server.close();
  assert.equal(await fetchQuota(url, 500), null);
});
