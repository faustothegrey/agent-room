import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addUsage, agentUsageLine, checkLogin, checkQuotaFloor, fetchQuota, parseClaudeAuth, parseCodexLogin, formatUsage, quotaGauges, quotaSummary, usageReport, readClaudeQuota, readCodexQuota, parseAgyQuota, refreshQuotaCache, useQuotaCache, claudeStreamQuota, refreshProviderQuota } from '../src/usage.mjs';

// The shape the quota meter returned on 2026-10-20 (trimmed).
const QUOTA = {
  claude: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { current_session: { used_percent: 70, resets: '2:20pm' }, current_week_all_models: { used_percent: 31, resets: 'Oct 21 at 9am' } } },
  codex: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { five_hour_limit: { used_percent: 20, resets: '13:44' }, weekly_limit: { used_percent: 3, resets: '07:44 on 27 Oct' } } },
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
  assert.equal(parseClaudeAuth('Logged in', now).error, 'claude auth status --json: output not JSON');
  assert.equal(parseClaudeAuth('{}', now).state, 'unknown');
  assert.equal(parseClaudeAuth(status({ loginExpiresAt: 'soon' }), now).error, 'claude auth status --json: login expiry unreadable');
});

test('codex login: logged in with no expiry, logged out, or unknown', () => {
  assert.deepEqual(parseCodexLogin('Logged in using ChatGPT\n'), { state: 'ok', expiresAt: null });
  assert.deepEqual(parseCodexLogin('\nNot logged in\n'), { state: 'out' });
  assert.equal(parseCodexLogin('something else').error, 'codex login status: output not recognised');
});

test('checkLogin: a command that fails or times out is unknown, with fixed error; a logged-out exit code still reads', async () => {
  const exec = (result) => (command, args, options, done) => done(...result);
  const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(await checkLogin('codex', exec([missing])), { state: 'unknown', error: 'codex login status: not found' });
  const killed = Object.assign(new Error('timed out'), { code: null, killed: true });
  assert.deepEqual(await checkLogin('claude', exec([killed])), { state: 'unknown', error: 'claude auth status --json: timed out' });
  const denied = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' });
  assert.deepEqual(await checkLogin('claude', exec([denied])), { state: 'unknown', error: 'claude auth status --json: failed to run' });
  const out = Object.assign(new Error('exit 1'), { code: 1 });
  assert.deepEqual(await checkLogin('claude', exec([out, '{"loggedIn": false}', ''])), { state: 'out' });
  assert.deepEqual(await checkLogin('codex', exec([null, '', 'Logged in using ChatGPT\n'])), { state: 'ok', expiresAt: null });
  assert.deepEqual(await checkLogin('codex', exec([out, '', 'boom'])), { state: 'unknown', error: 'codex login status: exit 1' });
});


test('agy gauges use Antigravity model windows and hide missing data', () => {
  const quota = { ...QUOTA, antigravity: { ok: true, parsed: { models: [
    { window: 'weekly', used_percent: 12, resets: 'in 12h' }, { window: '5h', used_percent: 5 },
    { window: 'weekly', used_percent: 30, resets: 'in 4h' }, { window: 'other', used_percent: 99 },
    { window: '5h', used_percent: 'bad' },
  ] } } };
  assert.deepEqual(quotaGauges(quota, ['agy']), [
    { provider: 'agy', label: '5h', used: 5, resets: null },
    { provider: 'agy', label: 'week', used: 30, resets: 'in 4h' },
  ]);
  assert.equal(quotaSummary(quota, ['agy']), 'agy 5% 5h / 30% week');
  assert.deepEqual(quotaGauges({ antigravity: { ok: false, parsed: quota.antigravity.parsed } }, ['agy']), []);
  assert.deepEqual(quotaGauges({ antigravity: { ok: true, parsed: {} } }, ['agy']), []);
});

test('agy login is unmonitored without invoking a command', async () => {
  assert.deepEqual(await checkLogin('agy', () => { throw new Error('must not run'); }), { state: 'unmonitored' });
});

test('agy grouped gauges show Gemini and Argon while summaries retain all models', () => {
  const quota = { last_update: '2026-11-14 10:30:00', antigravity: { ok: true, parsed: {
    groups: {
      gemini: { windows: { '5h': { used_percent: 3, resets: '2pm' }, weekly: { used_percent: 10, resets: 'Nov 19 at 3pm' } } },
      argon: { windows: { weekly: { used_percent: 20, resets: 'Nov 20 at 4pm' } } },
      '3p': { windows: { weekly: { used_percent: 80, resets: 'Nov 21 at 5pm' } } },
    },
    models: [ { group: 'gemini', window: '5h', used_percent: 3 }, { group: 'gemini', window: 'weekly', used_percent: 10 },
      { group: 'argon', window: 'weekly', used_percent: 20 }, { group: '3p', window: 'weekly', used_percent: 80, resets: 'Nov 21 at 5pm' } ],
  } } };
  assert.deepEqual(quotaGauges(quota, ['agy']), [
    { provider: 'agy', group: 'gemini', label: '5h', used: 3, resets: '14 Nov 14:00' },
    { provider: 'agy', group: 'gemini', label: 'week', used: 10, resets: '19 Nov 15:00' },
    { provider: 'agy', group: 'argon', label: 'week', used: 20, resets: '20 Nov 16:00' },
  ]);
  assert.equal(quotaSummary(quota, ['agy']), 'agy 3% 5h / 80% week');
  assert.match(usageReport({ totals: {}, agents: [{ name: 'A', provider: 'agy' }], quota }), /agy.*week 80% used/i);
});

test('agentUsageLine formats only the agent\'s own totals and provider quota, with none yet / quota unavailable for missing data', () => {
  const gauges = quotaGauges(QUOTA, ['claude', 'codex']);
  const sameDay = new Date(2026, 9, 20, 14, 0); // 2026-10-20
  const nextDay = new Date(2026, 9, 21, 9, 0);  // 2026-10-21

  // Full line: cumulative totals + own provider's quota + same-day HH:MM meter time; no codex figures.
  const line = agentUsageLine({
    total: { turns: 12, input: 1400000, cached: 1200000, output: 18000, cost: 1.5 },
    provider: 'claude', gauges, measured: QUOTA.last_update, now: sameDay,
  });
  assert.equal(line, '[your reported usage this session: 12 turns, 1400.0k in (1200.0k cached) / 18.0k out · claude quota 70% used 5h / 31% used week, reading 15m old]');
  assert.doesNotMatch(line, /codex|\$/);

  // Singular turn, small counts, and previous-day meter time includes the date.
  assert.equal(
    agentUsageLine({ total: { turns: 1, input: 500, cached: 0, output: 120 }, provider: 'codex', gauges, measured: QUOTA.last_update, now: nextDay }),
    '[your reported usage this session: 1 turn, 500 in (0 cached) / 120 out · codex quota 20% used 5h / 3% used week, reading 1155m old]',
  );

  // Missing usage and/or missing quota: never show zeros for missing data.
  assert.equal(
    agentUsageLine({ total: undefined, provider: 'claude', gauges, measured: null, now: sameDay }),
    '[your reported usage this session: none yet · claude quota 70% used 5h / 31% used week]',
  );
  assert.equal(
    agentUsageLine({ total: { turns: 0, input: 0, cached: 0, output: 0 }, provider: 'agy', gauges, measured: QUOTA.last_update, now: sameDay }),
    '[your reported usage this session: none yet · quota unavailable]',
  );
  assert.equal(
    agentUsageLine({ total: { turns: 2, input: 4200, cached: 400, output: 120 }, provider: 'claude', gauges: null, measured: null }),
    '[your reported usage this session: 2 turns, 4.2k in (400 cached) / 120 out · quota unavailable]',
  );

  // Unavailable session usage (e.g. a detached worker from another discussion) says "usage unavailable", not "none yet".
  assert.equal(
    agentUsageLine({ total: undefined, usageUnavailable: true, provider: 'claude', gauges, measured: QUOTA.last_update, now: sameDay }),
    '[your reported usage this session: usage unavailable · claude quota 70% used 5h / 31% used week, reading 15m old]',
  );
  assert.equal(
    agentUsageLine({ usageUnavailable: true, provider: 'agy', gauges: null, measured: null }),
    '[your reported usage this session: usage unavailable · quota unavailable]',
  );

  // Agy grouped gauges (Gemini and Argon).
  const agyQuota = { last_update: '2026-11-14 10:30:00', antigravity: { ok: true, parsed: {
    groups: {
      gemini: { windows: { '5h': { used_percent: 3 }, weekly: { used_percent: 10 } } },
      argon: { windows: { weekly: { used_percent: 20 } } },
    },
  } } };
  assert.equal(
    agentUsageLine({ total: null, provider: 'agy', gauges: quotaGauges(agyQuota, ['agy']), measured: agyQuota.last_update, now: new Date(2026, 10, 14, 11, 0) }),
    '[your reported usage this session: none yet · agy quota gemini 3% used 5h / 10% used week, argon 20% used week, reading 30m old]',
  );
});

test('checkQuotaFloor: passes above floor, fails below floor on 5h or weekly, and rejects missing or stale meter readings', () => {
  const now = new Date(2026, 9, 20, 13, 50, 0).getTime(); // 5m14s after QUOTA.last_update
  const freshQuota = {
    claude: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { current_session: { used_percent: 40 }, current_week_all_models: { used_percent: 20 } } },
    codex: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { five_hour_limit: { used_percent: 50 }, weekly_limit: { used_percent: 10 } } },
    antigravity: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { groups: {
      gemini: { windows: { '5h': { used_percent: 10 }, weekly: { used_percent: 30 } } },
      argon: { windows: { weekly: { used_percent: 40 } } },
    } } },
    last_update: '2026-10-20 13:44:46',
  };
  assert.deepEqual(checkQuotaFloor(freshQuota, ['claude', 'codex', 'agy'], 50, { now }), { ok: true });
  // Below 50% remaining on 5h (used 51% -> 49% remaining)
  const low5h = { ...freshQuota, claude: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { current_session: { used_percent: 51 }, current_week_all_models: { used_percent: 10 } } } };
  assert.equal(checkQuotaFloor(low5h, ['claude', 'codex'], 50, { now }).ok, false);
  assert.match(checkQuotaFloor(low5h, ['claude', 'codex'], 50, { now }).reason, /claude 5h has 49% remaining \(below 50% floor\)/);
  // Below 50% remaining on weekly (agy argon used 60% -> 40% remaining)
  const lowWeek = { ...freshQuota, antigravity: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { groups: {
    gemini: { windows: { '5h': { used_percent: 10 }, weekly: { used_percent: 10 } } },
    argon: { windows: { weekly: { used_percent: 60 } } },
  } } } };
  assert.equal(checkQuotaFloor(lowWeek, ['agy'], 50, { now }).ok, false);
  assert.match(checkQuotaFloor(lowWeek, ['agy'], 50, { now }).reason, /agy \(argon\) week has 40% remaining/);
  // Missing meter or missing timestamp
  assert.match(checkQuotaFloor(null, ['claude'], 50, { now }).reason, /missing/);
  assert.match(checkQuotaFloor({ ...freshQuota, claude: { ...freshQuota.claude, updated_at: '' } }, ['claude'], 50, { now }).reason, /timestamp is missing/);
  // Stale reading (> 15m old)
  const staleNow = new Date(2026, 9, 20, 14, 5, 0).getTime();
  assert.equal(checkQuotaFloor(freshQuota, ['claude'], 50, { now: staleNow }).ok, false);
  assert.match(checkQuotaFloor(freshQuota, ['claude'], 50, { now: staleNow }).reason, /stale/);
  // Missing provider window
  const missingWeek = { ...freshQuota, codex: { ok: true, updated_at: '2026-10-20 13:44:46', parsed: { five_hour_limit: { used_percent: 10 } } } };
  assert.equal(checkQuotaFloor(missingWeek, ['codex'], 50, { now }).ok, false);
  assert.match(checkQuotaFloor(missingWeek, ['codex'], 50, { now }).reason, /codex weekly quota reading is missing/);
});


test('internal readers preserve provider reading times and parse quota windows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quota-test-'));
  try {
    const claude = join(dir, '.claude.json');
    await writeFile(claude, JSON.stringify({ oauthAccount: { accountUuid: 'a' }, cachedUsageUtilization: { accountUuid: 'a', fetchedAtMs: 1700000000000, utilization: { five_hour: { utilization: 20, resets_at: '2023-11-14T22:14:00Z' }, seven_day: { utilization: 30 } } } }));
    const c = await readClaudeQuota(claude);
    assert.equal(c.updated_at, '2023-11-14T22:13:20.000Z');
    assert.equal(c.parsed.current_session.used_percent, 20);
    await mkdir(join(dir, 'sessions'));
    const event = (timestamp, used) => JSON.stringify({ timestamp, payload: { rate_limits: { primary: { used_percent: used, window_minutes: 300 }, secondary: { used_percent: 10, window_minutes: 10080 } } } });
    await writeFile(join(dir, 'sessions', 'a.jsonl'), [event('2026-01-01T00:00:00Z', 20), event('2026-01-02T00:00:00Z', 40)].join('\n'));
    const x = await readCodexQuota(join(dir, 'sessions'));
    assert.equal(x.updated_at, '2026-01-02T00:00:00.000Z');
    assert.equal(x.parsed.five_hour_limit.used_percent, 40);
    const agy = parseAgyQuota({ command: { data: { groups: [{ name: 'Gemini', buckets: [{ id: 'gemini-5h', remaining_fraction: 0.75 }] }] } } }, 1700000000000);
    assert.equal(agy.parsed.groups.gemini.windows['5h'].used_percent, 25);
    assert.equal(agy.updated_at, '2023-11-14T22:13:20.000Z');
    assert.match(checkQuotaFloor({ claude: c, last_update: new Date().toISOString() }, ['claude'], 50, { now: Date.parse('2023-11-14T23:13:20Z') }).reason, /claude.*60m old/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('background quota cache returns immediately while Agy is pending and retains last success', async () => {
  const cache = { value: null }; useQuotaCache(cache);
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const updating = refreshQuotaCache(cache, [async () => ({ ok: true, updated_at: '2026-01-01' }), async () => ({ ok: false }), () => pending]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fetchQuota()).claude.updated_at, '2026-01-01');
  release({ ok: false }); await updating;
  await refreshQuotaCache(cache, [async () => ({ ok: false }), async () => ({ ok: false }), async () => ({ ok: false })]);
  assert.equal((await fetchQuota()).claude.updated_at, '2026-01-01');
  useQuotaCache({ value: null });
});


test('a Claude turn reading becomes the claude entry, and an older reading never replaces a newer one', async () => {
  const turn = claudeStreamQuota({ received_at: Date.parse('2026-11-27T07:00:00Z'), five_hour: { used_percent: 5, resets_at: 1795780200 }, seven_day: { used_percent: 31.4 } });
  assert.equal(turn.ok, true); assert.equal(turn.source, 'claude-stream'); assert.equal(turn.updated_at, '2026-11-27T07:00:00.000Z');
  assert.equal(turn.parsed.current_session.used_percent, 5);
  assert.equal(turn.parsed.current_session.resets_at, new Date(1795780200 * 1000).toISOString());
  assert.equal(turn.parsed.current_week_all_models.used_percent, 31);
  assert.equal(claudeStreamQuota({ received_at: 1 }).ok, false);
  const cache = { value: null }, used = [];
  const readers = { claude: async () => { used.push('claude'); return { ok: false }; }, codex: async () => { used.push('codex'); return { ok: true, updated_at: '2026-11-27T06:00:00Z' }; }, agy: async () => { used.push('agy'); return { ok: false }; } };
  await refreshProviderQuota('claude', { received_at: Date.parse('2026-11-27T07:00:00Z'), five_hour: { used_percent: 5 } }, cache, readers);
  await refreshProviderQuota('codex', null, cache, readers);
  assert.deepEqual(used, ['codex']); // no reader (and no agy -p /usage) for a Claude turn with a reading
  assert.equal(cache.value.claude.source, 'claude-stream');
  assert.equal(cache.value.codex.updated_at, '2026-11-27T06:00:00Z');
  // An older ~/.claude.json reading is kept out; a newer one replaces the turn reading.
  const old = { ok: true, source: 'claude.json', updated_at: '2026-11-27T06:59:00.000Z', parsed: {} };
  await refreshQuotaCache(cache, [async () => old, async () => ({ ok: false }), async () => ({ ok: false })]);
  assert.equal(cache.value.claude.source, 'claude-stream');
  assert.equal(cache.value.codex.updated_at, '2026-11-27T06:00:00Z');
  await refreshQuotaCache(cache, [async () => ({ ...old, updated_at: '2026-11-27T07:01:00.000Z' }), async () => ({ ok: false }), async () => ({ ok: false })]);
  assert.equal(cache.value.claude.source, 'claude.json');
  await refreshProviderQuota('agy', null, cache, readers);
  assert.deepEqual(used, ['codex', 'agy']);
});

test('Codex reads at most 30 newest files and stops after the first with a valid event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-files-'));
  try {
    const event = (used) => JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', payload: { rate_limits: { primary: { used_percent: used } } } });
    for (let i = 0; i < 32; i++) {
      const path = join(dir, `${i}.jsonl`);
      await writeFile(path, i === 1 || i === 31 ? event(i) : '{}');
      await utimes(path, new Date(1700000000000 + i * 1000), new Date(1700000000000 + i * 1000));
    }
    const read = [];
    const result = await readCodexQuota(dir, async (path, encoding) => { read.push(path); return readFile(path, encoding); });
    assert.equal(result.parsed.five_hour_limit.used_percent, 31);
    assert.deepEqual(read, [join(dir, '31.jsonl')]);
    await writeFile(join(dir, '31.jsonl'), '{}');
    await utimes(join(dir, '31.jsonl'), new Date(1700000031000), new Date(1700000031000));
    read.length = 0;
    assert.equal((await readCodexQuota(dir, async (path, encoding) => { read.push(path); return readFile(path, encoding); })).ok, false);
    assert.equal(read.length, 30);
    assert.ok(!read.includes(join(dir, '1.jsonl')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quota guard rejects a window after its reset until a later reading arrives', async () => {
  const measured = '2026-11-26T12:00:00Z', reset = '2026-11-26T12:05:00Z';
  const quota = { claude: { ok: true, updated_at: measured, parsed: {
    current_session: { used_percent: 20, resets_at: reset }, current_week_all_models: { used_percent: 10 },
  } } };
  assert.equal(checkQuotaFloor(quota, ['claude'], 50, { now: Date.parse('2026-11-26T12:04:00Z') }).ok, true);
  assert.match(checkQuotaFloor(quota, ['claude'], 50, { now: Date.parse('2026-11-26T12:05:00Z') }).reason, /claude 5h.*reset/);
  quota.claude.updated_at = '2026-11-26T12:06:00Z';
  assert.equal(checkQuotaFloor(quota, ['claude'], 50, { now: Date.parse('2026-11-26T12:07:00Z') }).ok, true);
  const http = { codex: { ok: true, updated_at: '2026-11-26 12:00:00', parsed: {
    five_hour_limit: { used_percent: 20 }, weekly_limit: { used_percent: 10, resets: '12:05' },
  } } };
  const server = createServer((req, res) => res.end(JSON.stringify(http)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const reading = await fetchQuota(`http://127.0.0.1:${server.address().port}`);
    assert.match(checkQuotaFloor(reading, ['codex'], 50, { now: new Date(2026, 10, 26, 12, 6).getTime() }).reason, /codex week.*reset/);
  } finally { server.close(); }
  const agy = { antigravity: { ok: true, updated_at: measured, parsed: { groups: {
    gemini: { windows: { '5h': { used_percent: 1 }, weekly: { used_percent: 1 } } },
    argon: { windows: { weekly: { used_percent: 1, resets_at: reset } } },
  } } } };
  assert.match(checkQuotaFloor(agy, ['agy'], 50, { now: Date.parse('2026-11-26T12:06:00Z') }).reason, /agy \(argon\) week.*reset/);
});

test('auth mode: only known labels, never key text (even short plain tokens); only when asked', async () => {
  const { authModeOf } = await import('../src/usage.mjs');
  const shortTok = 'sk-ant-tok12345';
  assert.equal(authModeOf('claude', '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'), 'claude.ai (firstParty)');
  assert.equal(authModeOf('claude', '{"loggedIn":true,"authMethod":"api_key","apiProvider":"bedrock"}'), 'API key (Bedrock)');
  assert.equal(authModeOf('claude', '{"loggedIn":true,"authMethod":"claude.ai"}'), 'claude.ai');
  assert.equal(authModeOf('claude', '{"loggedIn":true}'), 'unknown');
  assert.equal(authModeOf('claude', JSON.stringify({ loggedIn: true, authMethod: shortTok, apiProvider: 'firstParty' })), 'unknown');
  assert.equal(authModeOf('claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: shortTok })), 'claude.ai');
  assert.equal(authModeOf('claude', '{"authMethod":"sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'), 'unknown');
  assert.equal(authModeOf('claude', `not json ${shortTok}`), 'unknown');
  assert.equal(authModeOf('codex', '', 'Logged in using ChatGPT\n'), 'ChatGPT');
  assert.equal(authModeOf('codex', '', `Logged in using an API key - ${shortTok}\n`), 'API key');
  assert.equal(authModeOf('codex', '', `Unexpected status ${shortTok}\n`), 'unknown');
  assert.equal(authModeOf('codex', '', 'Not logged in\n'), 'unknown');
  const exec = (result) => (command, args, options, done) => done(...result);
  assert.deepEqual(await checkLogin('codex', exec([null, '', 'Logged in using ChatGPT\n'])), { state: 'ok', expiresAt: null });
  assert.deepEqual(await checkLogin('codex', exec([null, '', 'Logged in using ChatGPT\n']), { authMode: true }), { state: 'ok', expiresAt: null, authMode: 'ChatGPT' });
});
