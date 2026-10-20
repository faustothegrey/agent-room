import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, isPass } from '../src/room.mjs';

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

test('a round is: user, then agents in order until all of them pass in a row', async () => {
  const a = fakeAgent('A', ['a1', 'PASS', 'PASS']);
  const b = fakeAgent('B', ['PASS', 'PASS']);
  const room = createRoom([a, b]);
  await room.round('hello');
  assert.deepEqual(room.transcript.map((m) => m.speaker), ['User', 'A', 'B', 'A']);
  await room.round('again');
  assert.deepEqual(room.transcript.map((m) => m.speaker), ['User', 'A', 'B', 'A', 'User', 'A', 'B']);
  assert.equal(a.prompts.length, 3);
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
  const a = fakeAgent('A', ['a1', 'PASS', 'a2', 'PASS']);
  const b = fakeAgent('B', ['b1', 'PASS', 'b2', 'PASS']);
  const room = createRoom([a, b]);
  await room.round('u1');
  // B speaks after A in the same round, so it sees A's reply.
  assert.match(b.prompts[0], /\[User\]: u1\n\n\[A\]: a1/);
  // A's second turn in the same round: only B's reply, not its own a1.
  assert.match(a.prompts[1], /New messages since your last turn:\n\n\[B\]: b1\n\nYour reply/);
  assert.doesNotMatch(a.prompts[1], /a1|u1/);
  await room.round('u2');
  // A's next turn: B's pass and the new user message.
  assert.match(a.prompts[2], /\[B\]: \(passed\)\n\n\[User\]: u2/);
  assert.doesNotMatch(a.prompts[2], /a1|b1|u1/);
  // B's next turn: from the new user message on.
  assert.match(b.prompts[2], /\[User\]: u2\n\n\[A\]: a2/);
  assert.doesNotMatch(b.prompts[2], /b1|u1/);
});

test('a failing agent is recorded and ends the round; it gets what it missed next time', async () => {
  const a = fakeAgent('A', [new Error('quota exceeded'), 'a2', 'PASS']);
  const b = fakeAgent('B', ['b1', 'PASS']);
  const room = createRoom([a, b]);
  await room.round('u1');
  assert.deepEqual(room.transcript.map((m) => [m.speaker, !!m.error]), [['User', false], ['A', true]]);
  assert.equal(b.prompts.length, 0);
  // The failed agent gets everything it missed next time, introduction included.
  await room.round('u2');
  assert.match(a.prompts[1], /You are A/);
  assert.match(a.prompts[1], /\[User\]: u1\n\n\[User\]: u2/);
  assert.doesNotMatch(a.prompts[1], /quota/);
  // Other agents never see the error text.
  assert.doesNotMatch(b.prompts[0], /quota/);
});

test('duplicate agent names are refused', () => {
  assert.throws(() => createRoom([fakeAgent('A'), fakeAgent('A')]), /Duplicate agent name/);
});

// Runs one round and returns the speakers and notices it produced.
async function roundOf(room, text) {
  const start = room.transcript.length;
  const notices = [];
  await room.round(text, { onNotice: (n) => notices.push(n) });
  return { speakers: room.transcript.slice(start).map((m) => m.speaker), notices };
}

test('a pass is exactly PASS, whitespace trimmed, optional trailing period', () => {
  for (const t of ['PASS', 'PASS.', '  PASS \n']) assert.ok(isPass(t), t);
  for (const t of ['pass', 'PASS!', 'PASS: nothing to add', 'Updated proposal/x.md']) assert.ok(!isPass(t), t);
});

test('all selected agents passing in a row ends the round, without a notice', async () => {
  const room = createRoom([fakeAgent('A', ['PASS.']), fakeAgent('B', ['PASS'])]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.deepEqual(speakers, ['User', 'A', 'B']);
  assert.deepEqual(notices, []);
  assert.ok(room.transcript.slice(1).every((m) => m.pass && m.text === 'PASS'));
});

test('a real reply resets the pass count', async () => {
  // Without the reset, A's second pass would end the round after 3 turns.
  const room = createRoom([fakeAgent('A', ['PASS', 'PASS']), fakeAgent('B', ['b1', 'PASS'])]);
  const { speakers } = await roundOf(room, 'u1');
  assert.deepEqual(speakers, ['User', 'A', 'B', 'A', 'B']);
});

test('the turn cap ends the round with a notice', async () => {
  const room = createRoom([fakeAgent('A'), fakeAgent('B')]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.equal(speakers.length, 1 + 8);
  assert.deepEqual(notices, ['(turn cap reached)']);
});

test('no cap notice when the 8th turn completes the all-pass condition', async () => {
  const room = createRoom([fakeAgent('A', ['a1', 'a2', 'a3', 'PASS']), fakeAgent('B', ['b1', 'b2', 'b3', 'PASS'])]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.equal(speakers.length, 1 + 8);
  assert.deepEqual(notices, []);
});

test('the pass count resets for each user message', async () => {
  // Round 1 hits the cap with B's pass pending; if it carried over, A's pass alone would end round 2.
  const a = fakeAgent('A', ['a1', 'a2', 'a3', 'a4', 'PASS']);
  const b = fakeAgent('B', ['b1', 'b2', 'b3', 'PASS', 'PASS']);
  const room = createRoom([a, b]);
  assert.deepEqual((await roundOf(room, 'u1')).notices, ['(turn cap reached)']);
  assert.deepEqual((await roundOf(room, 'u2')).speakers, ['User', 'A', 'B']);
});

test('an error mid-round ends the round', async () => {
  const b = fakeAgent('B', ['b1']);
  const room = createRoom([fakeAgent('A', ['a1', new Error('boom')]), b]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.deepEqual(speakers, ['User', 'A', 'B', 'A']);
  assert.ok(room.transcript.at(-1).error);
  assert.equal(b.prompts.length, 1);
  assert.deepEqual(notices, []);
});

test('passes are flagged for the screen to hide, and shown to other agents as (passed)', async () => {
  const b = fakeAgent('B', ['b1', 'PASS']);
  const room = createRoom([fakeAgent('A', ['PASS', 'PASS']), b]);
  const messages = [];
  await room.round('u1', { onMessage: (m) => messages.push(m) });
  assert.deepEqual(messages.map((m) => [m.speaker, !!m.pass]), [['User', false], ['A', true], ['B', false], ['A', true], ['B', true]]);
  assert.match(b.prompts[0], /\[A\]: \(passed\)/);
  assert.doesNotMatch(b.prompts[0], /\[A\]: PASS/);
});

test('@name addresses only that agent, case-insensitively, and keeps the text as typed', async () => {
  const a = fakeAgent('A');
  const b = fakeAgent('B', ['b1', 'PASS']);
  const room = createRoom([a, b]);
  const { speakers } = await roundOf(room, '@b what do you think?');
  assert.deepEqual(speakers, ['User', 'B', 'B']);
  assert.equal(a.prompts.length, 0);
  assert.equal(room.transcript[0].text, '@b what do you think?');
  assert.match(b.prompts[0], /\[User\]: @b what do you think\?/);
});

test('a single PASS ends an addressed round', async () => {
  const room = createRoom([fakeAgent('A'), fakeAgent('B', ['PASS'])]);
  assert.deepEqual((await roundOf(room, '@B hi')).speakers, ['User', 'B']);
});

test('an unknown @name sends nothing to any agent and records nothing', async () => {
  const a = fakeAgent('A');
  const b = fakeAgent('B');
  const room = createRoom([a, b]);
  await assert.rejects(room.round('@zed hi'), /Unknown agent "@zed"/);
  assert.equal(a.prompts.length + b.prompts.length, 0);
  assert.equal(room.transcript.length, 0);
});

test('an @mention later in the message is ordinary text', async () => {
  const room = createRoom([fakeAgent('A', ['PASS']), fakeAgent('B', ['PASS'])]);
  assert.deepEqual((await roundOf(room, 'hey @B, only you')).speakers, ['User', 'A', 'B']);
});

test('an agent left out of a round receives that exchange when next selected', async () => {
  const a = fakeAgent('A', ['PASS']);
  const room = createRoom([a, fakeAgent('B', ['b1', 'PASS', 'PASS'])]);
  await room.round('@B hi');
  await room.round('all of you');
  assert.match(a.prompts[0], /You are A/);
  assert.match(a.prompts[0], /\[User\]: @B hi\n\n\[B\]: b1\n\n\[B\]: \(passed\)\n\n\[User\]: all of you/);
});

test('a room recreated on the same state continues the conversation', async () => {
  const state = { transcript: [], seen: new Map() };
  const a = fakeAgent('A', ['a1', 'PASS']);
  const b = fakeAgent('B', ['PASS', 'PASS']);
  await createRoom([a, b], state).round('u1');
  const room = createRoom([a, b], state);
  await room.round('u2');
  assert.equal(room.transcript.filter((m) => m.speaker === 'User').length, 2);
  // No second introduction, and only what is new since A's last turn.
  assert.doesNotMatch(a.prompts[2], /You are A|u1|a1/);
  assert.match(a.prompts[2], /New messages since your last turn:\n\n\[User\]: u2\n\nYour reply/);
});

test('a reply carries the usage its agent reported for that turn', async () => {
  const a = fakeAgent('A', ['a1', 'PASS']);
  const b = fakeAgent('B', ['PASS', 'PASS']);
  const turn = a.turn;
  a.turn = async (p) => { const r = await turn(p); a.lastUsage = { input: 10, cached: 0, output: 2 }; return r; };
  const room = createRoom([a, b]);
  await room.round('u1');
  assert.deepEqual(room.transcript[1].usage, { input: 10, cached: 0, output: 2 });
  assert.equal(room.transcript[2].usage, undefined); // B reported none
});
