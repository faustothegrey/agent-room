import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { addUsage, checkLogin, fetchQuota, parseClaudeAuth, parseCodexLogin, formatUsage, quotaGauges, quotaSummary, usageReport } from '../src/usage.mjs';

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
  assert.match(report, /claude +5h 70% used \(at 20 Oct 14:20\) · week 31% used/);
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

test('quota gauges: one per window, for the room\'s providers only, in their order', () => {
  const quota = {
    claude: { ok: true, parsed: { current_session: { used_percent: 20, resets: '2:59pm' }, current_week_all_models: { used_percent: 6 } } },
    codex: { ok: true, parsed: { five_hour_limit: { used_percent: 8, resets: '13:31' }, weekly_limit: { used_percent: 26 } } },
    last_update: '2026-10-20 12:00:00',
  };
  assert.deepEqual(quotaGauges(quota, ['codex', 'claude']), [
    { provider: 'codex', label: '5h', used: 8, resets: '20 Oct 13:31' },
    { provider: 'codex', label: 'week', used: 26, resets: null },
    { provider: 'claude', label: '5h', used: 20, resets: '20 Oct 14:59' },
    { provider: 'claude', label: 'week', used: 6, resets: null },
  ]);
  assert.deepEqual(quotaGauges({ codex: { ok: false } }, ['codex']), []);
});

test('reset dates share a local 24-hour format without changing the clock or zone', () => {
  const cases = [
    ['10:59pm (Europe/Rome)', '2026-11-08 18:00:00', '8 Nov 22:59 (Europe/Rome)'],
    ['3:59am (Europe/Rome)', '2026-11-08 23:05:21', '9 Nov 03:59 (Europe/Rome)'],
    ['Nov 11 at 7:59am (Europe/Rome)', '2026-11-08 23:05:21', '11 Nov 07:59 (Europe/Rome)'],
    ['01:59 on 9 Nov', '2026-11-08 23:05:21', '9 Nov 01:59'],
    ['07:45 on 11 Nov', '2026-11-08 23:05:21', '11 Nov 07:45'],
    ['12am', '2026-12-31 23:00:00', '1 Jan 00:00'],
    ['12pm', '2026-11-08 10:00:00', '8 Nov 12:00'],
    ['13:44', '2026-10-20 13:44:46', '20 Oct 13:44'],
    ['unknown reset', '2026-11-08 23:05:21', 'unknown reset'],
  ];
  for (const [resets, last_update, expected] of cases) {
    const quota = { claude: { ok: true, parsed: { current_session: { used_percent: 20, resets } } }, last_update };
    assert.equal(quotaGauges(quota, ['claude'])[0].resets, expected);
    assert.ok(usageReport({ totals: {}, agents: [{ name: 'A', provider: 'claude' }], quota }).includes('(at ' + expected + ')'));
  }
});

test('claude login: from loginExpiresAt in claude auth status; ending in 2 days or less, expired, logged out, unreadable', () => {
  const now = Date.parse('2026-11-11T10:00:00Z');
  const status = (o) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...o });
  assert.deepEqual(parseClaudeAuth(status({ loginExpiresAt: '2026-12-08T05:24:23.660Z' }), now), { state: 'ok', expiresAt: '2026-12-08T05:24:23.660Z' });
  assert.equal(parseClaudeAuth(status({ loginExpiresAt: '2026-11-13T10:00:00Z' }), now).state, 'ending');
  assert.equal(parseClaudeAuth(status({ loginExpiresAt: '2026-11-13T10:00:01Z' }), now).state, 'ok');
  assert.equal(parseClaudeAuth(status({ loginExpiresAt: '2026-11-11T09:59:00Z' }), now).state, 'expired');
  assert.deepEqual(parseClaudeAuth(status({}), now), { state: 'ok', expiresAt: null });
  assert.deepEqual(parseClaudeAuth(JSON.stringify({ loggedIn: false }), now), { state: 'out' });
  assert.equal(parseClaudeAuth('Logged in', now).state, 'unknown');
  assert.equal(parseClaudeAuth('{}', now).state, 'unknown');
  assert.match(parseClaudeAuth(status({ loginExpiresAt: 'soon' }), now).error, /unreadable loginExpiresAt: soon/);
});

test('codex login: logged in with no expiry, logged out, or unknown', () => {
  assert.deepEqual(parseCodexLogin('Logged in using ChatGPT\n'), { state: 'ok', expiresAt: null });
  assert.deepEqual(parseCodexLogin('\nNot logged in\n'), { state: 'out' });
  assert.match(parseCodexLogin('something else').error, /unreadable output: something else/);
});

test('checkLogin: a command that fails or times out is unknown, with its error; a logged-out exit code still reads', async () => {
  const exec = (result) => (command, args, options, done) => done(...result);
  const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(await checkLogin('codex', exec([missing])), { state: 'unknown', error: 'codex login status: spawn codex ENOENT' });
  const killed = Object.assign(new Error('timed out'), { code: null, killed: true });
  assert.equal((await checkLogin('claude', exec([killed]))).state, 'unknown');
  const out = Object.assign(new Error('exit 1'), { code: 1 });
  assert.deepEqual(await checkLogin('claude', exec([out, '{"loggedIn": false}', ''])), { state: 'out' });
  assert.deepEqual(await checkLogin('codex', exec([null, '', 'Logged in using ChatGPT\n'])), { state: 'ok', expiresAt: null });
  assert.match((await checkLogin('codex', exec([out, '', 'boom']))).error, /exit 1: boom/);
});
