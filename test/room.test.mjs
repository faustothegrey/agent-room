import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../src/room.mjs';

// A fake agent that records every prompt it receives and answers from a script.
function fakeAgent(name, replies = []) {
  const prompts = [];
  let i = 0;
  return {
    name,
    prompts,
    async turn(prompt) {
      prompts.push(prompt);
      const r = replies[i++] ?? `${name} reply ${i}`;
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('a round is: user, then each agent once, in order', async () => {
  const a = fakeAgent('A');
  const b = fakeAgent('B');
  const room = createRoom([a, b]);
  await room.round('hello');
  assert.deepEqual(room.transcript.map((m) => m.speaker), ['User', 'A', 'B']);
  await room.round('again');
  assert.deepEqual(room.transcript.map((m) => m.speaker), ['User', 'A', 'B', 'User', 'A', 'B']);
  assert.equal(a.prompts.length, 2);
  assert.equal(b.prompts.length, 2);
});

test('the first prompt carries the introduction; later prompts do not', async () => {
  const a = fakeAgent('A');
  const room = createRoom([a, fakeAgent('B')]);
  await room.round('one');
  await room.round('two');
  assert.match(a.prompts[0], /You are A, one of several AI agents/);
  assert.doesNotMatch(a.prompts[1], /You are A/);
});

test('each agent sees exactly what it has not seen, never its own replies', async () => {
  const a = fakeAgent('A', ['a1', 'a2']);
  const b = fakeAgent('B', ['b1', 'b2']);
  const room = createRoom([a, b]);
  await room.round('u1');
  // B speaks after A in the same round, so it sees A's reply.
  assert.match(b.prompts[0], /\[User\]: u1\n\n\[A\]: a1/);
  await room.round('u2');
  // A's second turn: B's last reply and the new user message, not its own a1.
  assert.match(a.prompts[1], /\[B\]: b1\n\n\[User\]: u2/);
  assert.doesNotMatch(a.prompts[1], /a1|u1/);
  // B's second turn: from the new user message on.
  assert.match(b.prompts[1], /\[User\]: u2\n\n\[A\]: a2/);
  assert.doesNotMatch(b.prompts[1], /b1|u1/);
});

test('a failing agent is recorded, skipped, and does not stop the round', async () => {
  const a = fakeAgent('A', [new Error('quota exceeded'), 'a2']);
  const b = fakeAgent('B', ['b1', 'b2']);
  const room = createRoom([a, b]);
  await room.round('u1');
  assert.deepEqual(room.transcript.map((m) => [m.speaker, !!m.error]), [['User', false], ['A', true], ['B', false]]);
  // Other agents never see the error text.
  assert.doesNotMatch(b.prompts[0], /quota/);
  // The failed agent gets everything it missed next time, introduction included.
  await room.round('u2');
  assert.match(a.prompts[1], /You are A/);
  assert.match(a.prompts[1], /\[User\]: u1\n\n\[B\]: b1\n\n\[User\]: u2/);
  assert.doesNotMatch(a.prompts[1], /quota/);
});

test('duplicate agent names are refused', () => {
  assert.throws(() => createRoom([fakeAgent('A'), fakeAgent('A')]), /Duplicate agent name/);
});
