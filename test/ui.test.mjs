import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../src/ui.mjs';

const freshCtx = () => ({ cwd: '/tmp', agentSpecs: 'claude:A,codex:B', state: { transcript: [], seen: new Map() }, sessions: new Map() });

test('each load builds a new room on the same conversation state and CLI sessions', async () => {
  const ctx = freshCtx();
  Object.assign(ctx, await load(ctx, '?v=1'));
  const first = { room: ctx.room, docs: ctx.docs, a: ctx.sessions.get('A') };
  ctx.state.transcript.push({ speaker: 'User', text: 'hi' });
  ctx.sessions.get('A').started = true;

  Object.assign(ctx, await load(ctx, '?v=2'));
  assert.notEqual(ctx.room, first.room);
  assert.notEqual(ctx.docs, first.docs); // a fresh copy of the module, not the cached one
  assert.equal(ctx.room.transcript, ctx.state.transcript);
  assert.equal(ctx.room.transcript.length, 1);
  assert.equal(ctx.sessions.get('A'), first.a);
  assert.deepEqual(ctx.room.agents.map((a) => [a.name, a.provider]), [['A', 'claude'], ['B', 'codex']]);
});

test('a failing load leaves ctx as it was', async () => {
  const ctx = freshCtx();
  Object.assign(ctx, await load(ctx, '?v=3'));
  const room = ctx.room;
  ctx.agentSpecs = 'nosuch:X';
  await assert.rejects(load(ctx, '?v=4'), /Unknown provider/);
  assert.equal(ctx.room, room);
});
