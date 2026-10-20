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

test('claude: first turn creates the session, later turns resume it, writes limited to proposal/', async () => {
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
    assert.deepEqual(c.args.slice(-6), ['--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write']);
    assert.ok(!c.args.includes('--permission-mode'));
    const i = c.args.indexOf('--allowedTools');
    assert.deepEqual(c.args.slice(i + 1, i + 3), ['Write(proposal/**)', 'Edit(proposal/**)']);
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

test('codex: resumes the thread it was given and forces the workspace-write sandbox every call', async () => {
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
  for (const c of calls) assert.ok(c.args.includes('sandbox_mode="workspace-write"'));
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
