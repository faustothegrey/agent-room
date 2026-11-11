import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeTitle, createClaudeAgent, createCodexAgent, findLeftovers, parseCodexEvents, probeProcess, recordProgram, run } from '../src/agents.mjs';

// A fake runner that records each call and returns scripted stdout.
function fakeRunner(outputs) {
  const calls = [];
  const runner = async (command, args, opts) => {
    calls.push({ command, args, input: opts.input });
    return outputs[calls.length - 1];
  };
  return { calls, runner };
}

test('claude: first turn creates the session, later turns resume it, writes anywhere but no shell', async () => {
  const { calls, runner } = fakeRunner([
    JSON.stringify({ result: 'hi', is_error: false }),
    JSON.stringify({ result: 'again', is_error: false }),
  ]);
  const agent = createClaudeAgent({ name: 'A', runner });
  assert.equal(await agent.turn('p1'), 'hi');
  assert.equal(await agent.turn('p2'), 'again');
  const id = calls[0].args[calls[0].args.indexOf('--session-id') + 1];
  assert.ok(id);
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], id);
  for (const c of calls) {
    assert.deepEqual(c.args.slice(-11), ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch']);
    assert.ok(!c.args.includes('--permission-mode'));
    const i = c.args.indexOf('--allowedTools');
    const allowed = c.args.slice(i + 1, c.args.indexOf('--tools'));
    assert.deepEqual(allowed.slice(0, 10), ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch']);
    // Writes go anywhere (owner's call), but still no shell.
    assert.ok(!allowed.includes('Bash'));
  }
  assert.equal(calls[0].input, 'p1');
});

test('claude: an error result throws and does not mark the session started', async () => {
  const { calls, runner } = fakeRunner([
    JSON.stringify({ result: 'boom', is_error: true }),
    JSON.stringify({ result: 'ok', is_error: false }),
  ]);
  const agent = createClaudeAgent({ name: 'A', runner });
  await assert.rejects(agent.turn('p1'), /boom/);
  await agent.turn('p2');
  assert.ok(calls[1].args.includes('--session-id'));
});

test('codex: resumes the thread it was given and runs without a sandbox every call', async () => {
  const first = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
  ].join('\n');
  const second = '{"type":"item.completed","item":{"type":"agent_message","text":"42"}}';
  const { calls, runner } = fakeRunner([first, second]);
  const agent = createCodexAgent({ name: 'B', runner });
  assert.equal(await agent.turn('p1'), 'ok');
  assert.equal(await agent.turn('p2'), '42');
  assert.deepEqual(calls[0].args.slice(0, 1), ['exec']);
  assert.deepEqual(calls[1].args.slice(0, 2), ['exec', 'resume']);
  assert.ok(calls[1].args.includes('t-1'));
  for (const c of calls) {
    assert.ok(c.args.includes('sandbox_mode="danger-full-access"'));
    assert.ok(c.args.includes('web_search="live"'));
  }
});

test('codex events: last agent_message wins, noise lines are ignored, turn.failed throws', () => {
  const out = [
    'not json',
    '{"type":"item.completed","item":{"type":"error","message":"deprecated flag"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
  ].join('\n');
  assert.equal(parseCodexEvents(out).text, 'final');
  assert.throws(() => parseCodexEvents('{"type":"turn.failed","error":{"message":"quota"}}'), /quota/);
});

test('a recreated agent on the same session object resumes instead of starting over', async () => {
  const session = {};
  const c = fakeRunner([JSON.stringify({ result: 'hi' }), JSON.stringify({ result: 'again' })]);
  await createClaudeAgent({ name: 'A', runner: c.runner, session }).turn('p1');
  await createClaudeAgent({ name: 'A', runner: c.runner, session }).turn('p2');
  assert.equal(c.calls[1].args[c.calls[1].args.indexOf('--resume') + 1], session.id);

  const codexSession = {};
  const x = fakeRunner(['{"type":"thread.started","thread_id":"t-9"}', '']);
  await createCodexAgent({ name: 'B', runner: x.runner, session: codexSession }).turn('p1');
  await createCodexAgent({ name: 'B', runner: x.runner, session: codexSession }).turn('p2');
  assert.deepEqual(x.calls[1].args.slice(0, 2), ['exec', 'resume']);
  assert.ok(x.calls[1].args.includes('t-9'));
});

test('the rulebook goes in as system-level instructions on every turn, for both providers', async () => {
  const rules = 'Rule one.\nSay "PASS" when done.';
  const c = fakeRunner([JSON.stringify({ result: 'a' }), JSON.stringify({ result: 'b' })]);
  const claude = createClaudeAgent({ name: 'A', runner: c.runner, instructions: rules });
  await claude.turn('p1');
  await claude.turn('p2');
  for (const call of c.calls) {
    assert.equal(call.args[call.args.indexOf('--append-system-prompt') + 1], rules);
    assert.deepEqual(call.args.slice(-11), ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch']);
  }

  const x = fakeRunner(['{"type":"thread.started","thread_id":"t-1"}', '']);
  const codex = createCodexAgent({ name: 'B', runner: x.runner, instructions: rules });
  await codex.turn('p1');
  await codex.turn('p2');
  for (const call of x.calls) {
    assert.ok(call.args.includes('developer_instructions="Rule one.\\nSay \\"PASS\\" when done."'));
  }
});

test('each turn reports its usage: claude from its JSON result, codex from turn.completed', async () => {
  const c = fakeRunner([JSON.stringify({
    result: 'hi', total_cost_usd: 0.02,
    usage: { input_tokens: 2, cache_creation_input_tokens: 2499, cache_read_input_tokens: 1670, output_tokens: 5 },
  })]);
  const claude = createClaudeAgent({ name: 'A', runner: c.runner });
  await claude.turn('p');
  assert.deepEqual(claude.lastUsage, { input: 4171, cached: 1670, output: 5, cost: 0.02 });

  const x = fakeRunner([[
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed","usage":{"input_tokens":15973,"cached_input_tokens":7168,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n'), '{"type":"item.completed","item":{"type":"agent_message","text":"again"}}']);
  const codex = createCodexAgent({ name: 'B', runner: x.runner });
  await codex.turn('p1');
  assert.deepEqual(codex.lastUsage, { input: 15973, cached: 7168, output: 5 });
  await codex.turn('p2'); // no turn.completed this time: no stale usage from the previous turn
  assert.equal(codex.lastUsage, null);
});

test('claude with shell (the worker): Bash is added to the tools and pre-approved', async () => {
  const { calls, runner } = fakeRunner([JSON.stringify({ result: 'done', is_error: false })]);
  const agent = createClaudeAgent({ name: 'W', runner, shell: true });
  assert.equal(await agent.turn('fix it'), 'done');
  const { args } = calls[0];
  assert.equal(args.at(-1), 'Bash');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--tools'));
  assert.ok(allowed.includes('Bash'));
});

test('claudeTitle: one claude call with no tools and no saved session; the first line, unquoted', async () => {
  const { calls, runner } = fakeRunner([JSON.stringify({ result: '"Pendulum lessons."\nextra', is_error: false })]);
  const { title } = await claudeTitle('plan the pendulum lessons', { runner });
  assert.equal(title, 'Pendulum lessons');
  assert.deepEqual(calls[0].args.slice(-2), ['--tools', '']);
  assert.ok(calls[0].args.includes('--no-session-persistence'));
  assert.ok(!calls[0].args.includes('--allowedTools'));
  assert.match(calls[0].input, /plan the pendulum lessons/);
  await assert.rejects(claudeTitle('x', { runner: async () => JSON.stringify({ result: '  ', is_error: false }) }), /empty title/);
  await assert.rejects(claudeTitle('x', { runner: async () => JSON.stringify({ result: 'no', is_error: true }) }), /claude: no/);
});

test('selected models are passed to the provider on initial and resumed turns', async () => {
  for (const [create, model, flag, outputs] of [
    [createClaudeAgent, 'opus', '--model', ['{"result":"hi"}', '{"result":"again"}']],
    [createCodexAgent, 'gpt-6.1-sol', '-m', ['{"type":"thread.started","thread_id":"t"}', '']],
  ]) {
    const { calls, runner } = fakeRunner(outputs);
    const agent = create({ name: 'A', model, runner });
    await agent.turn('first'); await agent.turn('second');
    for (const call of calls) assert.equal(call.args[call.args.indexOf(flag) + 1], model);
  }
});

test('a working directory given as a function is read at each turn (the worker\'s worktree)', async () => {
  const seen = [];
  const runner = async (command, args, opts) => { seen.push(opts.cwd); return command === 'claude' ? JSON.stringify({ result: 'ok', session_id: 's' }) : ''; };
  let dir = '/one';
  const claude = createClaudeAgent({ name: 'W', runner, cwd: () => dir });
  const codex = createCodexAgent({ name: 'X', runner, cwd: () => dir });
  await claude.turn('a');
  dir = '/two';
  await claude.turn('b');
  await codex.turn('c');
  assert.deepEqual(seen, ['/one', '/two', '/two']);
  const fixed = createClaudeAgent({ name: 'A', runner, cwd: '/room' });
  await fixed.turn('d');
  assert.equal(seen.at(-1), '/room');
});

// The record of programs, for leftovers after a crash or a Restart.
test('a recorded program: written at spawn with its start, removed when its process group ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'programs-'));
  const procs = new Set();
  const turn = run('sh', ['-c', 'sleep 0.3; echo done'], { procs, record: { agent: 'A', room: '/room', dir } });
  const [proc] = procs;
  const entry = JSON.parse(readFileSync(join(dir, `${proc.pid}.json`), 'utf8'));
  assert.deepEqual({ ...entry, started: typeof entry.started, server: { ...entry.server, started: typeof entry.server.started } },
    { pid: proc.pid, started: 'string', provider: 'sh', agent: 'A', room: '/room', server: { pid: process.pid, started: 'string' } });
  assert.ok(Math.abs(Date.parse(entry.started) - Date.now()) < 5000);
  // The server's start is this process's, as ps reports it.
  assert.ok(Math.abs(Date.parse(entry.server.started) - (await probeProcess(process.pid)).startedAt) <= 5000);
  assert.equal(await turn, 'done\n');
  assert.deepEqual(readdirSync(dir), []);
  // Without `record` nothing is written.
  await run('true', [], { record: undefined });
});

test('leftovers: not in this server\'s procs and group alive, with the same start; reused PIDs and gone groups dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'programs-'));
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const entry = (pid, started) => recordProgram({ pid, started: at(started), provider: 'claude', agent: 'A', room: '/r' }, dir);
  entry(101, now); entry(102, now); entry(103, now - 3600_000); entry(104, now); entry(105, now); entry(106, now);
  writeFileSync(join(dir, '107.json'), '{"pid": 1'); // cut short by a crash
  const probes = {
    101: { group: true, leader: true, startedAt: now - 1000 }, // ours, left over
    102: { group: true, leader: true, startedAt: now }, // ours, still running in this server
    103: { group: true, leader: true, startedAt: now - 60_000 }, // the number was reused by another program
    104: { group: true, leader: false, startedAt: null }, // leader gone, group alive: unverified
    105: { group: false, leader: false, startedAt: null }, // gone
    106: { group: false, leader: true, startedAt: now }, // a lone process with that number, not our group
  };
  const found = await findLeftovers(new Set([102]), { dir, probe: async (pid) => probes[pid] });
  assert.deepEqual(found.map((f) => [f.pid, f.unverified]), [[101, false], [104, true]]);
  assert.deepEqual(readdirSync(dir).sort(), ['101.json', '102.json', '104.json']);
});

test('leftovers: another live server\'s program is not one; a server PID reused by another process counts as gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'programs-'));
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const entry = (pid, server) => recordProgram({ pid, started: at(now), provider: 'codex', agent: 'B', room: '/r', server: { pid: server, started: at(now - 600_000) } }, dir);
  entry(201, 901); entry(202, 902); entry(203, 903); entry(204, 904);
  const program = { group: true, leader: true, startedAt: now };
  const probes = {
    201: program, 202: program, 203: program, 204: program,
    901: { group: true, leader: true, startedAt: now - 600_000 + 2000 }, // that server, still running
    902: { group: false, leader: true, startedAt: now - 60_000 }, // its number, reused by another process
    903: { group: false, leader: false, startedAt: null }, // gone
    904: { group: true, leader: true, startedAt: null }, // alive, start unreadable
  };
  const found = await findLeftovers(new Set(), { dir, probe: async (pid) => probes[pid] });
  assert.deepEqual(found.map((f) => [f.pid, f.unverified]), [[202, false], [203, false], [204, true]]);
  assert.deepEqual(readdirSync(dir).sort(), ['201.json', '202.json', '203.json', '204.json']); // 201 kept for its server
});

test('leftovers with real processes: a live group is found until it ends; a reused PID (other start) is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'programs-'));
  const procs = new Set();
  const turn = run('sleep', ['30'], { procs, record: { agent: 'W', room: '/r', dir }, timeoutMs: 60_000 });
  const [proc] = procs;
  const p = await probeProcess(proc.pid);
  assert.equal(p.group, true); assert.equal(p.leader, true);
  assert.ok(Math.abs(p.startedAt - Date.now()) < 5000);
  assert.deepEqual(await findLeftovers(new Set([proc.pid]), { dir }), []); // in procs: not a leftover
  assert.deepEqual(await findLeftovers(new Set(), { dir }), []); // its server (this process) still runs
  // The server's number recorded with a day-older start: this process merely reuses it, so that server is gone.
  const file = join(dir, `${proc.pid}.json`);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  const day = new Date(Date.now() - 86_400_000).toISOString();
  writeFileSync(file, JSON.stringify({ ...entry, server: { pid: process.pid, started: day } }));
  assert.deepEqual((await findLeftovers(new Set(), { dir })).map((f) => [f.pid, f.agent, f.unverified]), [[proc.pid, 'W', false]]);
  // The same number recorded with an hour-older start: another program now has it.
  writeFileSync(file, JSON.stringify({ ...entry, server: { pid: process.pid, started: day }, started: new Date(Date.now() - 3600_000).toISOString() }));
  assert.deepEqual(await findLeftovers(new Set(), { dir }), []);
  assert.equal(existsSync(file), false);
  proc.stopGroup('SIGTERM');
  await assert.rejects(turn, /stopped/);
});
