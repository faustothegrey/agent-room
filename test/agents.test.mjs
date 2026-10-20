import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAgent, createCodexAgent, parseCodexEvents } from '../src/agents.mjs';

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
    assert.deepEqual(allowed.slice(0, 7), ['Write', 'Edit', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch']);
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
