import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { closingStatement, createRoom, isPass } from '../src/room.mjs';

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

test('the closing statement is one turn of the given agent, with the worker reports', async () => {
  const writer = fakeAgent('W', ['Final: pending-instructions.md']);
  const result = await closingStatement(writer, { dir: '/project/discussions/topic', workerReports: 'worker finished' });
  assert.equal(result, 'Final: pending-instructions.md');
  assert.equal(writer.prompts.length, 1);
  assert.match(writer.prompts[0], /The User is closing this discussion\./);
  assert.match(writer.prompts[0], /\/project\/discussions\/topic\/closing-statement\.md/);
  assert.match(writer.prompts[0], /worker finished/);
});

test('a closing statement that is empty, a pass or without the pending instructions reference is refused; a failed turn is reported', async () => {
  await assert.rejects(closingStatement(fakeAgent('W', ['PASS']), { dir: '/topic' }), /W did not provide a complete closing statement/);
  await assert.rejects(closingStatement(fakeAgent('W', ['  ']), { dir: '/topic' }), /W did not provide a complete closing statement/);
  await assert.rejects(closingStatement(fakeAgent('W', ['No reference']), { dir: '/topic' }), /must point to pending-instructions\.md/);
  await assert.rejects(closingStatement(fakeAgent('W', [new Error('quota')]), { dir: '/topic' }), /quota/);
});

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

test('the lap cap ends the round with a notice (10 laps in a discussion, 20 in a brainstorm)', async () => {
  const room = createRoom([fakeAgent('A'), fakeAgent('B')]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.equal(speakers.length, 1 + 10 * 2);
  assert.deepEqual(notices, ['(lap cap reached)']);
  const addressed = await roundOf(room, '@A u2');
  assert.equal(addressed.speakers.length, 1 + 10);
  assert.deepEqual(addressed.notices, ['(lap cap reached)']);

  const brainstorm = createRoom([fakeAgent('A'), fakeAgent('B')], { transcript: [], seen: new Map(), brainstorm: true });
  const bRound = await roundOf(brainstorm, 'u1');
  assert.equal(bRound.speakers.length, 1 + 20 * 2);
  assert.deepEqual(bRound.notices, ['(lap cap reached)']);
  const bAddressed = await roundOf(brainstorm, '@A u2');
  assert.equal(bAddressed.speakers.length, 1 + 20);
  assert.deepEqual(bAddressed.notices, ['(lap cap reached)']);
});

test('no cap notice when the 10th lap completes the all-pass condition', async () => {
  const room = createRoom([fakeAgent('A', [...Array(9).fill('a'), 'PASS']), fakeAgent('B', [...Array(9).fill('b'), 'PASS'])]);
  const { speakers, notices } = await roundOf(room, 'u1');
  assert.equal(speakers.length, 1 + 10 * 2);
  assert.deepEqual(notices, []);
});

test('the pass count resets for each user message', async () => {
  // Round 1 hits the cap with B's pass pending; if it carried over, A's pass alone would end round 2.
  const a = fakeAgent('A', [...Array(10).fill('a'), 'PASS']);
  const b = fakeAgent('B', [...Array(9).fill('b'), 'PASS', 'PASS']);
  const room = createRoom([a, b]);
  assert.deepEqual((await roundOf(room, 'u1')).notices, ['(lap cap reached)']);
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

test('summary: the draft is agreed when the other agent passes on it', async () => {
  const a = fakeAgent('A', ['**Agreed**\n- blue button']);
  const b = fakeAgent('B', ['PASS']);
  const room = createRoom([a, b]);
  const r = await room.summary();
  assert.equal(r.status, 'agreed');
  assert.deepEqual(r.result, { speaker: 'Summary', text: '**Agreed**\n- blue button', outcome: 'agreed', by: 'A' });
  assert.match(a.prompts[0], /asked for a summary/);
  // Both drafter and reviewer receive the action order and pending-instruction contract.
  for (const p of [a.prompts[0], b.prompts[0]]) {
    assert.match(p, /\*\*Next step\*\*\n- Answer: a question \/ Send to the Worker: "the instruction, word for word" \/ Do: an action of the User's own/);
    assert.match(p, /Next step contains exactly one action for the User, labelled Answer, Send to the Worker or Do as appropriate/);
    assert.match(p, /\*\*Later\*\*\n- the remaining actions in order, one short line each, each saying what it waits for/);
    assert.match(p, /Keep each instruction for the worker until the User confirms it was sent, replaced or withdrawn/);
    assert.match(p, /Quote its latest version word for word when it is the Next step; under Later refer to it by name,\nwith its full text kept in the discussion's pending-instructions\.md/);
    assert.match(p, /At most 8 points in all under Agreed and Not agreed/);
    assert.doesNotMatch(p, /\*\*Questions for the User\*\*|\*\*Instructions for the Worker\*\*/);
  }
  assert.match(b.prompts[0], /latest message from A above is the current version/);
  assert.match(b.prompts[0], /\[A\]: \*\*Agreed\*\*/);
  // The turns are kept, marked as summary turns; the result comes last.
  assert.deepEqual(room.transcript.map((m) => [m.speaker, !!m.summary]), [['A', true], ['B', true], ['Summary', false]]);
});

test('summary in a brainstorm: the same format and agreement, without the sentence about pending-instructions.md', async () => {
  const a = fakeAgent('A', ['**Agreed**\n- blue button']);
  const b = fakeAgent('B', ['PASS']);
  const room = createRoom([a, b], { transcript: [], seen: new Map(), brainstorm: true });
  assert.equal((await room.summary()).status, 'agreed');
  for (const p of [a.prompts[0], b.prompts[0]]) {
    assert.match(p, /Send to the Worker: "the instruction, word for word"/); // still allowed, in the chat
    assert.match(p, /Next step contains exactly one action for the User/);
    assert.match(p, /\*\*Later\*\*\n- the remaining actions in order/);
    assert.match(p, /Quote its latest version word for word when it is the Next step\./);
    assert.match(p, /At most 8 points in all under Agreed and Not agreed/);
    assert.doesNotMatch(p, /pending-instructions|refer to it by name/);
  }
  assert.match(b.prompts[0], /latest message from A above is the current version/);
});

test('summary: a revision counts as its author\'s acceptance', async () => {
  const room = createRoom([fakeAgent('A', ['v1', 'PASS']), fakeAgent('B', ['v2'])]);
  const r = await room.summary();
  assert.deepEqual([r.status, r.result.text, r.result.by], ['agreed', 'v2', 'B']);
  assert.equal(room.transcript.filter((m) => m.summary).length, 3);
});

test('summary: three turns each without agreement fail, and the last revision stands', async () => {
  const a = fakeAgent('A', ['a1', 'a2', 'a3']);
  const b = fakeAgent('B', ['b1', 'b2', 'b3']);
  const room = createRoom([a, b]);
  const r = await room.summary();
  assert.deepEqual([r.status, r.result.text, r.result.by, r.result.outcome], ['not agreed', 'b3', 'B', 'not agreed']);
  assert.equal(a.prompts.length, 3);
  assert.equal(b.prompts.length, 3);
});

test('summary: the drafter rotates, and agents see the result in later rounds', async () => {
  const a = fakeAgent('A', ['sA', 'PASS', 'PASS']);
  const b = fakeAgent('B', ['PASS', 'sB', 'PASS']);
  const room = createRoom([a, b]);
  assert.equal((await room.summary()).result.by, 'A');
  assert.equal((await room.summary()).result.by, 'B'); // B drafted this time
  await room.round('next');
  assert.match(a.prompts.at(-1), /\[Summary, agreed\]: sB/);
});

test('summary: nothing to summarize, or a failed turn, records no result', async () => {
  const empty = createRoom([fakeAgent('A', ['PASS']), fakeAgent('B')]);
  assert.deepEqual(await empty.summary(), { status: 'empty' });
  const broken = createRoom([fakeAgent('A', ['v1']), fakeAgent('B', [new Error('quota')])]);
  assert.deepEqual(await broken.summary(), { status: 'failed' });
  assert.ok(!empty.transcript.some((m) => m.outcome) && !broken.transcript.some((m) => m.outcome));
});

test('summary: with a single agent, its draft is the summary', async () => {
  const room = createRoom([fakeAgent('A', ['solo'])]);
  assert.deepEqual([(await room.summary()).status, room.transcript.at(-1).text], ['agreed', 'solo']);
});

test('state.briefing goes with each agent\'s first prompt only', async () => {
  const a = fakeAgent('A');
  const state = { transcript: [], seen: new Map(), briefing: 'Write in /x/discussions/d.' };
  const room = createRoom([a, fakeAgent('B')], state);
  await room.round('one');
  await room.round('two');
  assert.match(a.prompts[0], /You are A[\s\S]*Write in \/x\/discussions\/d\.\n\nNew messages/);
  assert.doesNotMatch(a.prompts[1], /Write in/);
});

test('discussion agents take turns in the selected row order', async () => {
  const { createRoom } = await import('../src/room.mjs');
  const turns = [];
  const agents = ['Agy', 'Claude2', 'Codex'].map((name) => ({ name, provider: 'claude', turn: async () => { turns.push(name); return 'PASS'; } }));
  const room = createRoom(agents);
  await room.round('Hello');
  assert.deepEqual(turns, ['Agy', 'Claude2', 'Codex']);
});

test('usageLine callback is read per prompt (including summary turns) and placed at the top', async () => {
  const counts = { A: 0, B: 0 };
  const a = fakeAgent('A', ['a1', 'PASS', '**Agreed**\n- x']);
  const b = fakeAgent('B', ['b1', 'PASS', 'PASS']);
  const room = createRoom([a, b], { transcript: [], seen: new Map() }, undefined, (agent) => `[usage ${agent.name} #${++counts[agent.name]}]`);
  await room.round('hi');
  await room.summary();
  assert.match(a.prompts[0], /^\[usage A #1\]\n\nYou are A/);
  assert.match(a.prompts[1], /^\[usage A #2\]\n\nNew messages/);
  assert.match(a.prompts[2], /^\[usage A #3\]\n\nNew messages[\s\S]*asked for a summary/);
  assert.match(b.prompts[0], /^\[usage B #1\]\n\nYou are B/);
  assert.match(b.prompts[1], /^\[usage B #2\]\n\nNew messages/);
  assert.match(b.prompts[2], /^\[usage B #3\]\n\nNew messages[\s\S]*latest message from A/);
});

test('summary format check: draft fixed on retry (only corrected version is reviewed), reviewer PASS not checked, revision still wrong after one retry, and retry answered with PASS keeps first reply', async () => {
  // 1. Draft fixed on retry: B reviews only the corrected version, B's PASS is never checked, and both A replies stay in transcript with their usage.
  const checked = [];
  const check = (text) => {
    checked.push(text);
    return text.includes('BAD') ? ['contains BAD'] : [];
  };
  const a = fakeAgent('A', ['**Agreed**\n- BAD draft', '**Agreed**\n- fixed draft']);
  const origATurn = a.turn;
  let aCall = 0;
  a.turn = async (p) => {
    const r = await origATurn(p);
    a.lastUsage = { input: 100 + (++aCall * 10), cached: 0, output: 20 + aCall };
    return r;
  };
  const b = fakeAgent('B', ['PASS']);
  const notes = [];
  const room = createRoom([a, b]);
  const res = await room.summary({ check, onFormatNote: (msg, err) => notes.push([msg, err]) });
  assert.equal(res.status, 'agreed');
  assert.equal(res.result.text, '**Agreed**\n- fixed draft');
  // Retry prompt names the problem and does not repeat the summary opening words.
  assert.equal(a.prompts.length, 2);
  assert.match(a.prompts[1], /Your summary has a format problem: contains BAD\./);
  assert.doesNotMatch(a.prompts[1], /asked for a summary of the discussion|asked for a summary\. The latest/);
  // B saw only the corrected draft, never the superseded BAD draft; B's PASS was never passed to check().
  assert.equal(b.prompts.length, 1);
  assert.match(b.prompts[0], /\[A\]: \*\*Agreed\*\*\n- fixed draft/);
  assert.doesNotMatch(b.prompts[0], /BAD draft/);
  assert.deepEqual(checked, ['**Agreed**\n- BAD draft', '**Agreed**\n- fixed draft']);
  // Both of A's replies stay in the transcript with their own usage.
  const aEntries = room.transcript.filter((m) => m.speaker === 'A');
  assert.equal(aEntries.length, 2);
  assert.deepEqual(aEntries.map((m) => [m.text, m.usage.input]), [['**Agreed**\n- BAD draft', 110], ['**Agreed**\n- fixed draft', 120]]);
  assert.deepEqual(notes, [
    ["Format check: A's summary contains BAD. Asked once to fix it.", true],
    ['Format check: fixed on retry.', false],
  ]);

  // 2. Revision still wrong after one retry: summary goes on and logs Format check: still wrong.
  const a2 = fakeAgent('A', ['**Agreed**\n- initial ok', 'PASS']);
  const b2 = fakeAgent('B', ['**Agreed**\n- BAD rev 1', '**Agreed**\n- BAD rev 2']);
  const notes2 = [];
  const room2 = createRoom([a2, b2]);
  const res2 = await room2.summary({ check, onFormatNote: (msg, err) => notes2.push([msg, err]) });
  assert.equal(res2.status, 'agreed');
  assert.equal(res2.result.text, '**Agreed**\n- BAD rev 2');
  assert.equal(b2.prompts.length, 2);
  assert.deepEqual(notes2, [
    ["Format check: B's summary contains BAD. Asked once to fix it.", true],
    ['Format check: still wrong: contains BAD.', true],
  ]);

  // 3. If the agent answers the retry with PASS, the retry counts as failed and its first reply stays the version.
  const a3 = fakeAgent('A', ['**Agreed**\n- BAD but kept', 'PASS']);
  const b3 = fakeAgent('B', ['PASS']);
  const notes3 = [];
  const room3 = createRoom([a3, b3]);
  const res3 = await room3.summary({ check, onFormatNote: (msg, err) => notes3.push([msg, err]) });
  assert.equal(res3.status, 'agreed');
  assert.equal(res3.result.text, '**Agreed**\n- BAD but kept');
  assert.match(b3.prompts[0], /\[A\]: \*\*Agreed\*\*\n- BAD but kept/);
  assert.doesNotMatch(b3.prompts[0], /\[A\]: \(passed\)/);
  assert.match(notes3[1][0], /^Format check: still wrong: replied PASS/);
});

test('closingStatement format check: fixed on retry and still wrong after one retry', async () => {
  // 1. Fixed on retry.
  const notes1 = [];
  const writer1 = fakeAgent('W', ['Forgot the reference.', 'Complete statement see pending-instructions.md.']);
  const out = await closingStatement(writer1, { dir: '/topic', onFormatNote: (m, err) => notes1.push([m, err]) });
  assert.equal(out, 'Complete statement see pending-instructions.md.');
  assert.equal(writer1.prompts.length, 2);
  assert.match(writer1.prompts[1], /Your closing statement has a format problem: it must point to pending-instructions\.md\./);
  assert.deepEqual(notes1, [
    ["Format check: W's closing statement it must point to pending-instructions.md. Asked once to fix it.", true],
    ['Format check: fixed on retry.', false],
  ]);

  // 2. Still wrong after one retry: throws with <name> did not provide a complete closing statement and the final reply's problem.
  const notes2 = [];
  const writer2 = fakeAgent('W', ['PASS', 'Still no file reference']);
  await assert.rejects(
    closingStatement(writer2, { dir: '/topic', onFormatNote: (m, err) => notes2.push([m, err]) }),
    /^Error: W did not provide a complete closing statement: it must point to pending-instructions\.md\.$/,
  );
  assert.equal(writer2.prompts.length, 2);
  assert.deepEqual(notes2, [
    ["Format check: W's closing statement the reply was empty or PASS. Asked once to fix it.", true],
    ['Format check: still wrong: it must point to pending-instructions.md.', true],
  ]);
});

test('round beforeLap hook checks before each subsequent lap and stops early with notice', async () => {
  const a = fakeAgent('A', ['a1', 'a2', 'PASS']);
  const b = fakeAgent('B', ['b1', 'b2', 'PASS']);
  const room = createRoom([a, b]);
  const lapsSeen = [];
  const notices = [];
  const res = await room.round('check code', {
    speaker: 'Scheduler',
    onNotice: (n) => notices.push(n),
    beforeLap: async (lap) => {
      lapsSeen.push(lap);
      return lap === 1 ? 'Stopped by quota guard before lap 2' : null;
    },
  });
  assert.deepEqual(lapsSeen, [1]);
  assert.deepEqual(res, { stopped: true, reason: 'Stopped by quota guard before lap 2' });
  assert.deepEqual(notices, ['Stopped by quota guard before lap 2']);
  assert.equal(a.prompts.length, 1);
  assert.equal(b.prompts.length, 1);
  assert.match(a.prompts[0], /\[Scheduler\]: check code/);
});
