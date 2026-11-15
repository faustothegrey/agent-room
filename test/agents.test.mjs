import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeTitle, createAgyAgent, createClaudeAgent, createCodexAgent, parseAgyOutput, findLeftovers, parseCodexEvents, probeProcess, recordProgram, run } from '../src/agents.mjs';

// A fake runner that records each call and returns scripted stdout.
function fakeRunner(outputs) {
  const calls = [];
  const runner = async (command, args, opts) => {
    calls.push({ command, args, input: opts.input });
    return outputs[calls.length - 1];
  };
  return { calls, runner };
}

test('claude: first turn creates the session, later turns resume it, writes anywhere and has Bash', async () => {
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
    assert.deepEqual(c.args.slice(-12), ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch', 'Bash']);
    assert.ok(!c.args.includes('--permission-mode'));
    const i = c.args.indexOf('--allowedTools');
    const allowed = c.args.slice(i + 1, c.args.indexOf('--tools'));
    assert.deepEqual(allowed.slice(0, 10), ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch']);
    // Writes and Bash are pre-approved (owner's call).
    assert.ok(allowed.includes('Bash'));
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

test('claude: a session that a turn left behind ("already in use") is resumed, keeping its work', async () => {
  const calls = [];
  const session = { id: 'dbf385e1-cf7b-44eb-82b1-e2e868fcc74d' };
  const runner = async (command, args) => {
    calls.push(args);
    if (args.includes('--session-id')) throw new Error(`claude exited with code 1: Error: Session ID ${session.id} is already in use.`);
    return JSON.stringify({ result: 'resumed', is_error: false });
  };
  const agent = createClaudeAgent({ name: 'W', runner, session });
  assert.equal(await agent.turn('p1'), 'resumed');
  assert.equal(calls[0][calls[0].indexOf('--session-id') + 1], session.id);
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], session.id);
  assert.equal(session.started, true);
  // Any other failure, or one on a started session, is not retried.
  const other = createClaudeAgent({ name: 'X', runner: async () => { throw new Error('claude exited with code 1: boom'); } });
  await assert.rejects(other.turn('p'), /boom/);
  let n = 0;
  const started = createClaudeAgent({ name: 'Y', session: { id: 's', started: true }, runner: async () => { n++; throw new Error('Session ID s is already in use.'); } });
  await assert.rejects(started.turn('p'), /already in use/);
  assert.equal(n, 1);
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
    assert.deepEqual(call.args.slice(-12), ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch', 'Bash']);
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

test('claude worker: Bash is available and pre-approved', async () => {
  const { calls, runner } = fakeRunner([JSON.stringify({ result: 'done', is_error: false })]);
  const agent = createClaudeAgent({ name: 'W', runner });
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

test('a record is written through a temporary file; a scan ignores an incomplete one and never deletes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'programs-'));
  const now = Date.now();
  const alive = { group: true, leader: true, startedAt: now };
  const probe = async (pid) => (pid === 301 ? alive : { group: false, leader: false, startedAt: null });
  // Another server, mid-write: half a record under its temporary name.
  const temp = '302.json.4242.tmp';
  writeFileSync(join(dir, temp), '{"pid": 302, "sta');
  recordProgram({ pid: 301, started: new Date(now).toISOString(), provider: 'claude', agent: 'A', room: '/r', server: { pid: 999, started: new Date(now).toISOString() } }, dir);
  // Only the renamed record: this write left no temporary file of its own.
  assert.deepEqual(readdirSync(dir).sort(), ['301.json', temp]);
  const found = await findLeftovers(new Set(), { dir, probe });
  assert.deepEqual(found.map((f) => [f.pid, f.agent, f.unverified]), [[301, 'A', false]]);
  assert.equal(readFileSync(join(dir, temp), 'utf8'), '{"pid": 302, "sta');
  assert.deepEqual(readdirSync(dir).sort(), ['301.json', temp]);
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


test('agy turns resume and resend changed rulebooks, including after session serialization', async () => {
  const output = JSON.stringify({ status: 'SUCCESS', conversation_id: 'c1', response: ' hello\n',
    usage: { input_tokens: 100, cache_read_tokens: 30, output_tokens: 15, thinking_tokens: 10 } });
  const { calls, runner } = fakeRunner([output, output, output, output, output]);
  let session = {};
  let agent = createAgyAgent({ name: 'A', model: 'model-one', instructions: 'rules one', session, runner });
  assert.equal(await agent.turn('first'), 'hello');
  assert.deepEqual(agent.lastUsage, { input: 100, cached: 30, output: 15 });
  await agent.turn('second');
  session = JSON.parse(JSON.stringify(session)); // checkpoint round trip
  agent = createAgyAgent({ name: 'A', model: 'model-one', instructions: 'rules one', session, runner });
  await agent.turn('third');
  agent = createAgyAgent({ name: 'A', instructions: 'rules two', session, runner });
  await agent.turn('fourth');
  agent.reset();
  await agent.turn('fifth');
  assert.deepEqual(calls.map((c) => c.input), ['rules one\n\nfirst', 'second', 'third', 'rules two\n\nfourth', 'rules two\n\nfifth']);
  assert.deepEqual(calls[0].args, ['--output-format', 'json', '--dangerously-skip-permissions', '--model', 'model-one']);
  assert.deepEqual(calls[1].args, [...calls[0].args, '--conversation', 'c1']);
  assert.deepEqual(calls[3].args, ['--output-format', 'json', '--dangerously-skip-permissions', '--conversation', 'c1']);
  assert.ok(!calls[4].args.includes('--conversation'));
  assert.ok(calls.every((c) => c.command === 'agy' && !c.args.includes('--print-timeout')));
});

test('agy errors do not record rules or leave stale usage', async () => {
  assert.throws(() => parseAgyOutput('{"status":"ERROR","error":"bad"}'), /agy: bad/);
  assert.throws(() => parseAgyOutput('bad'), /agy: non-JSON output \(unrecognized error\)/);
  const session = { conversationId: 'old', receivedInstructions: 'old' };
  const { calls, runner } = fakeRunner(['{"status":"ERROR","error":"bad"}', '{"status":"SUCCESS","response":"ok"}',
    '{"status":"SUCCESS","conversation_id":"old","response":"ok"}']);
  const agent = createAgyAgent({ name: 'Worker', instructions: 'new', session, runner });
  await assert.rejects(agent.turn('one'), /agy: bad/);
  await assert.rejects(agent.turn('two'), /missing conversation ID/);
  assert.equal(agent.lastUsage, null);
  assert.equal(session.receivedInstructions, 'old');
  await agent.turn('three');
  assert.ok(calls.every((c) => c.input.startsWith('new\n\n')));
});


test('agy non-JSON diagnostics are short and do not echo authentication data', () => {
  for (const text of ['Error: authentication failed bearer SECRET-123', 'API_KEY=private-value',
    'unlabelled-private-credential-' + 'x'.repeat(5000)]) {
    assert.throws(() => parseAgyOutput(text), (err) => {
      assert.match(err.message, /agy: non-JSON output/);
      assert.ok(err.message.length < 120);
      assert.doesNotMatch(err.message, /SECRET-123|private-value|unlabelled|xxx/);
      return true;
    });
  }
  assert.throws(() => parseAgyOutput('Network connection failed'), /connection error/);
});
