import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { handleLine, load, restartArgs, sessionView, workerLane, workNote } from '../src/ui.mjs';

const freshCtx = () => ({ cwd: '/tmp', agentSpecs: 'claude:A,codex:B', state: { transcript: [], seen: new Map() }, sessions: new Map() });

test('session IDs identify each current agent and the separate worker', () => {
  const ctx = { room: { agents: [{ name: 'A', provider: 'claude' }, { name: 'B', provider: 'codex' }, { name: 'C', provider: 'agy' }] },
    worker: { name: 'W', provider: 'claude' }, sessions: new Map([['A', { id: 'a', started: true }], ['B', { threadId: 'b' }],
      ['C', { conversationId: 'c' }], ['worker:W', { id: 'w', started: false }]]) };
  assert.deepEqual(sessionView(ctx), { agents: [{ name: 'A', provider: 'claude', id: 'a' }, { name: 'B', provider: 'codex', id: 'b' },
    { name: 'C', provider: 'agy', id: 'c' }], worker: { name: 'W', provider: 'claude', id: null } });
  ctx.sessions.get('worker:W').started = true;
  assert.equal(sessionView(ctx).worker.id, 'w');
});

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

test('the worker is a separate claude agent with its own session, kept across reloads', async () => {
  const ctx = { ...freshCtx(), workerSpec: 'claude:Worker' };
  Object.assign(ctx, await load(ctx, '?v=5'));
  assert.deepEqual([ctx.worker.name, ctx.worker.provider], ['Worker', 'claude']);
  const session = ctx.sessions.get('worker:Worker');
  assert.ok(session);
  Object.assign(ctx, await load(ctx, '?v=6'));
  assert.equal(ctx.sessions.get('worker:Worker'), session);
  ctx.workerSpec = 'claude:A'; // taken by a room agent
  await assert.rejects(load(ctx, '?v=7'), /worker's name "A" is taken/);
});

// A room on scripted fake agents, run through handleLine as the screen or terminal would.
async function scriptedCtx(replies) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRoom, closingStatement } = await import('../src/room.mjs');
  const docs = await import('../src/docs.mjs');
  const usage = await import('../src/usage.mjs');
  const fake = (name) => ({ name, provider: 'claude', turn: async (prompt) => prompt.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : replies.shift() ?? 'PASS' });
  const state = { transcript: [], seen: new Map() };
  return {
    state, room: createRoom([fake('A'), fake('B')], state), worker: fake('W'), docs, totals: {},
    // Close's writer, in place of a real CLI (see load in ui.mjs).
    closingStatement: (options, agent) => closingStatement(agent, options), closingAgent: () => fake('W'),
    usage: { ...usage, fetchQuota: async () => null }, // never the real meter
    screen: { clients: new Set(), transcript: state.transcript, worker: [] },
    logPath: join(mkdtempSync(join(tmpdir(), 'ui-test-')), 'room.md'), cwd: '/tmp',
  };
}

test('auto-summarize: on by default, a summary follows a round in which an agent spoke', async () => {
  const ctx = await scriptedCtx(['an idea', 'PASS', 'PASS', '- the idea', 'PASS']);
  await handleLine('hello', ctx);
  const result = ctx.state.transcript.at(-1);
  assert.deepEqual([result.speaker, result.outcome, result.text], ['Summary', 'agreed', '- the idea']);
});

test('auto-summarize: no summary after a round of passes', async () => {
  const quiet = await scriptedCtx([]);
  await handleLine('hello', quiet);
  assert.ok(!quiet.state.transcript.some((m) => m.speaker === 'Summary'));
});

// ── Discussions ──
const tmp = async (prefix) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), prefix));
};

test('discussion folders: date + title, date and time without a title, -2 when taken', async () => {
  const { createDiscussionFolder, slug } = await import('../src/ui.mjs');
  const parent = `${await tmp('disc-test-')}/discussions`;
  const now = new Date(2026, 10, 2, 9, 5);
  assert.equal(slug('Organising discussions: É/è & more!'), 'organising-discussions-e-e-more');
  assert.equal(createDiscussionFolder(parent, 'Organising discussions', now), '2026-11-02-organising-discussions');
  assert.equal(createDiscussionFolder(parent, 'Organising discussions', now), '2026-11-02-organising-discussions-2');
  assert.equal(createDiscussionFolder(parent, null, now), '2026-11-02-0905');
  assert.equal(createDiscussionFolder(parent, '!!!', now), '2026-11-02-0905-2'); // nothing left of the title
});

test('session transcripts: session-<date>-<time>.md, -2 when taken, never overwritten', async () => {
  const { createSessionFile } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const dir = `${await tmp('sess-test-')}/transcripts`;
  const now = new Date(2026, 10, 2, 10, 14);
  const first = createSessionFile(dir, 'one', now);
  const second = createSessionFile(dir, 'two', now);
  assert.match(first, /transcripts\/session-2026-11-02-1014\.md$/);
  assert.match(second, /session-2026-11-02-1014-2\.md$/);
  assert.equal(readFileSync(first, 'utf8'), 'one');
});

// A scripted room whose session hasn't started: no transcript yet, a root folder, a fake title.
async function freshSession(replies, suggestTitle) {
  const ctx = await scriptedCtx(replies);
  delete ctx.logPath;
  ctx.cwd = await tmp('root-test-');
  ctx.suggestTitle = suggestTitle;
  return ctx;
}

// The room's folder as a Git repository with one commit: the worker needs one for its worktree.
async function gitRoom(dir) {
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  return git;
}
// Waits (at most 2 seconds) until `ready()` is true.
async function until(ready) {
  for (let t = 0; !ready(); t++) { if (t > 2000) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 1)); }
}

test('the first message creates the discussion (titled by Claude) and its transcript before the agents see it', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const prompts = [];
  const ctx = await freshSession([], async (text) => ({ title: `About ${text}` }));
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  assert.deepEqual(readdirSync(ctx.cwd), []); // nothing written yet
  await handleLine('pendulums', ctx);
  const [name] = readdirSync(`${ctx.cwd}/discussions`);
  assert.match(name, /^\d{4}-\d{2}-\d{2}-about-pendulums$/);
  assert.equal(ctx.discussion.title, 'About pendulums');
  assert.match(prompts[0], new RegExp(`Its folder is ${ctx.cwd}/discussions/${name}: create, read and write this discussion's documents`));
  const text = readFileSync(ctx.logPath, 'utf8');
  assert.match(text, /^# About pendulums — session of/);
  assert.match(text, /title by Claude[\s\S]*\*\*User\*\*\n\npendulums/); // said before the folder existed: kept for the transcript
  assert.match(ctx.logPath, new RegExp(`discussions/${name}/transcripts/session-.*\\.md$`));
});

test('if the title fails, the folder is named after the date and time; an unknown @name creates nothing', async () => {
  const { readdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => { throw new Error('timed out'); });
  await handleLine('@nobody hi', ctx);
  assert.deepEqual(readdirSync(ctx.cwd), []);
  await handleLine('hi', ctx);
  assert.match(readdirSync(`${ctx.cwd}/discussions`)[0], /^\d{4}-\d{2}-\d{2}-\d{4}$/);
});

test('/resume without a checkpoint, before the first message: no title asked, the transcript goes in that discussion', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs');
  const prompts = [];
  const ctx = await freshSession([], async () => { throw new Error('no title should be asked'); });
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`, { recursive: true });
  await handleLine('/resume nosuch', ctx);
  await handleLine('/resume ../x', ctx);
  assert.equal(ctx.discussion, undefined);
  await handleLine('/resume 2026-11-01-old', ctx);
  await handleLine('where were we?', ctx);
  assert.deepEqual(readdirSync(`${ctx.cwd}/discussions`), ['2026-11-01-old']);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/2026-11-01-old/transcripts`).length, 1);
  assert.match(prompts[0], /continues the discussion in .*2026-11-01-old.*Start from its handoff/);
});

test('/resume, after the session started, of a discussion without a checkpoint: a fresh session there, from its handoff', async () => {
  const { mkdirSync, readdirSync, readFileSync } = await import('node:fs');
  const prompts = [];
  const ctx = await freshSession([], async () => ({ title: 'First topic' }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  const resets = [];
  for (const a of [...ctx.room.agents, ctx.worker]) a.reset = () => resets.push(a.name);
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('hello', ctx);
  const first = ctx.logPath;
  const [name] = readdirSync(`${ctx.cwd}/discussions`);
  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`);

  const worker = ctx.worker;
  await handleLine('/resume 2026-11-01-old', ctx);
  assert.equal(ctx.discussion.name, '2026-11-01-old');
  assert.deepEqual(resets, ['A', 'B']); // fresh CLI sessions for the agents
  assert.notEqual(ctx.worker, worker); // and a new worker, on a fresh session: the old one stays with its discussion
  assert.equal(worker.seat.discussion.name, name);
  assert.equal(ctx.logPath, null);
  assert.deepEqual(ctx.state.transcript, []); // the chat starts over (the same array, emptied)
  assert.equal(ctx.screen.transcript, ctx.state.transcript);
  assert.match(readFileSync(first, 'utf8'), /session ended: resuming the discussion 2026-11-01-old/);

  await handleLine('back to it', ctx);
  assert.match(ctx.logPath, /discussions\/2026-11-01-old\/transcripts\/session-/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /You are A, one of several AI agents/); // introduced again, as in a new session
  assert.match(prompts[1], /continues the discussion in .*2026-11-01-old.*Start from its handoff/);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/${name}/transcripts`).length, 1); // the first discussion keeps its transcript

  await handleLine('/resume ../x', ctx);
  mkdirSync(`${ctx.cwd}/discussions/archive`); // the room's own material, not a discussion
  await handleLine('/resume archive', ctx);
  assert.equal(ctx.discussion.name, '2026-11-01-old');
});

test('the worker is told the active discussion\'s folder with its first instruction there', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const got = [];
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  await gitRoom(ctx.cwd);
  ctx.worker.turn = async (p) => { got.push(p); return 'done'; };
  await handleLine('hello', ctx);
  queueWork(ctx, 'fix the bug'); // as the Worker tab sends it
  queueWork(ctx, 'and the test');
  await ctx.workQueue;
  assert.match(got[0], new RegExp(`^\\[your reported usage this session: [^\\]]+\\]\\n\\nThe active discussion's folder is ${ctx.discussion.dir}: create, read and write this discussion's documents`));
  assert.match(got[0], /fix the bug$/);
  assert.match(got[1], /^\[your reported usage this session: [^\]]+\]\n\nand the test$/);
});

test('agent settings persist, apply before startup, and switch only the active worker after startup', async () => {
  const { saveSettings, readDefaults } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const file = `${await tmp('settings-test-')}/config/defaults.json`;
  const ctx = { ...freshCtx(), workerSpec: 'claude:Worker' };
  Object.assign(ctx, await load(ctx, ''));
  const settings = { agents: [
    { provider: 'codex', name: 'Ada', model: 'gpt-6.1-sol' },
    { provider: 'claude', name: 'Linus', model: 'opus' },
  ], worker: { provider: 'codex', name: 'Worker', model: 'gpt-6.1-terra' } };
  assert.equal((await saveSettings(ctx, settings, file)).applied, true);
  assert.deepEqual(readDefaults(file), settings);
  assert.equal(ctx.agentSpecs, 'codex:Ada:gpt-6.1-sol,claude:Linus:opus');
  assert.equal(ctx.worker.provider, 'codex');
  assert.equal(ctx.room.transcript, ctx.state.transcript);
  const active = { room: ctx.room, worker: ctx.worker, sessions: ctx.sessions, state: ctx.state };
  ctx.agentsStarted = true; // includes a queued worker or title lookup before a first reply
  const future = { ...settings, worker: { provider: 'claude', name: 'Bob', model: 'haiku' } };
  assert.equal((await saveSettings(ctx, future, file)).applied, false);
  for (const key of ['room', 'sessions', 'state']) assert.equal(ctx[key], active[key]);
  assert.notEqual(ctx.worker, active.worker);
  assert.equal(ctx.worker.provider, 'claude');
  assert.equal(ctx.worker.name, 'Bob');
  assert.equal(ctx.workerSpec, 'claude:Bob:haiku');
  assert.equal(ctx.workerHandoff, true);
  assert.deepEqual(readDefaults(file), settings);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(saveSettings(ctx, { ...settings, worker: settings.agents[0] }, file), /different name/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('Providers tab: members and worker together; before the start they apply too, after it only the defaults change', async () => {
  const { saveDefaultSettings, readDefaults } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const file = `${await tmp('defaults-test-')}/config/defaults.json`;
  const ctx = { ...freshCtx(), workerSpec: 'claude:Worker' };
  Object.assign(ctx, await load(ctx, ''));
  const first = { agents: [{ provider: 'codex', name: 'Ada', model: '' }, { provider: 'claude', name: 'Linus', model: 'opus' }],
    worker: { provider: 'codex', name: 'Worker', model: '' }, scope: 'defaults' };
  assert.equal((await saveDefaultSettings(ctx, first, file)).applied, true); // not started: this discussion too
  assert.equal(ctx.agentSpecs, 'codex:Ada:,claude:Linus:opus');
  assert.equal(ctx.workerSpec, 'codex:Worker:');
  ctx.agentsStarted = true;
  const running = { room: ctx.room, worker: ctx.worker, agentSpecs: ctx.agentSpecs, workerSpec: ctx.workerSpec };
  const later = { agents: [{ provider: 'claude', name: 'Bob', model: 'haiku' }, { provider: 'agy', name: 'Agy', model: '' }],
    worker: { provider: 'claude', name: 'Ada', model: '' }, scope: 'defaults' }; // Ada: a running agent's name is fine for the worker of future discussions
  assert.equal((await saveDefaultSettings(ctx, later, file)).applied, false);
  for (const key of Object.keys(running)) assert.equal(ctx[key], running[key]); // the running discussion is untouched
  const { scope, ...expected } = later;
  assert.deepEqual(readDefaults(file), expected);
  assert.deepEqual(ctx.screen.getSettings().launchDefaults, expected); // new discussions in this room use them
  const before = readFileSync(file, 'utf8');
  await assert.rejects(saveDefaultSettings(ctx, { ...later, worker: later.agents[0] }, file), /different name/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('/move: a whole discussion into archive/ or deferred/ and back; never the one in use', async () => {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, basename, join } = await import('node:path');
  const ctx = await freshSession([], async () => ({ title: 'In use' }));
  const root = `${ctx.cwd}/discussions`;
  mkdirSync(`${root}/2026-11-01-old/transcripts`, { recursive: true });
  writeFileSync(`${root}/2026-11-01-old/notes.md`, 'n');
  const checkpoint = await checkpointPath(ctx.cwd, '2026-11-01-old');
  const closed = join(dirname(checkpoint), 'closed');
  mkdirSync(closed, { recursive: true });
  writeFileSync(join(closed, basename(checkpoint, '.json')), '2026-11-01-old');
  await handleLine('/move 2026-11-01-old archive', ctx);
  assert.ok(existsSync(`${root}/archive/2026-11-01-old/notes.md`)); // archive/ created when first needed
  assert.ok(!existsSync(`${root}/2026-11-01-old`));
  await handleLine('/move archive/2026-11-01-old deferred', ctx);
  assert.ok(existsSync(`${root}/deferred/2026-11-01-old/transcripts`));
  await handleLine('/move deferred/2026-11-01-old active', ctx);
  assert.ok(existsSync(`${root}/2026-11-01-old/notes.md`));
  await handleLine('/move 2026-11-01-old elsewhere', ctx); // not a place
  await handleLine('/move nosuch archive', ctx);
  assert.ok(existsSync(`${root}/2026-11-01-old`));

  await handleLine('hello', ctx); // creates the discussion in use
  await handleLine(`/move ${ctx.discussion.name} archive`, ctx);
  assert.ok(existsSync(ctx.discussion.dir));
});

test('/resume of an archived discussion makes it active first; new names skip archived ones', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { createDiscussionFolder } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => { throw new Error('no title should be asked'); });
  const root = `${ctx.cwd}/discussions`;
  mkdirSync(`${root}/archive/2026-11-01-old`, { recursive: true });
  await handleLine('/resume archive/2026-11-01-old', ctx);
  assert.equal(ctx.discussion.dir, `${root}/2026-11-01-old`);
  assert.ok(existsSync(`${root}/2026-11-01-old`) && !existsSync(`${root}/archive/2026-11-01-old`));

  mkdirSync(`${root}/deferred/2026-11-02-topic`, { recursive: true });
  assert.equal(createDiscussionFolder(root, 'Topic', new Date(2026, 10, 2)), '2026-11-02-topic-2');
});

test('archive and defer require a closed discussion, and Make active keeps it closed', async () => {
  const { existsSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Move state' }));
  ctx.noScreen = true;
  const notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, event) => { if (event.type === 'note') notes.push(event.text); } };
  await handleLine('hello', ctx);
  const name = ctx.discussion.name, root = `${ctx.cwd}/discussions`;
  await handleLine(`/move ${name} archive`, ctx);
  assert.match(notes.at(-1), /must be closed before.*archive/);
  await handleLine('/new', ctx);
  await handleLine(`/move ${name} deferred`, ctx);
  assert.match(notes.at(-1), /must be closed before.*deferred/);
  assert.ok(existsSync(`${root}/${name}`));
  await handleLine(`/resume ${name}`, ctx);
  await handleLine('/close', ctx);
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
  await handleLine(`/move ${name} archive`, ctx);
  assert.ok(existsSync(`${root}/archive/${name}`));
  await handleLine(`/move archive/${name} active`, ctx);
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
  await handleLine(`/move ${name} deferred`, ctx);
  assert.ok(existsSync(`${root}/deferred/${name}`));
});

test('/peek shows a closed discussion read-only, in place, without reopening it', async () => {
  const { mkdirSync, writeFileSync, existsSync, realpathSync } = await import('node:fs');
  const { dirname, basename, join } = await import('node:path');
  const ctx = await freshSession([], async () => ({ title: 'Peek me' }));
  const root = `${ctx.cwd}/discussions`;
  const marker = async (name) => { const cp = await checkpointPath(ctx.cwd, name); return join(dirname(cp), 'closed', basename(cp, '.json')); };
  mkdirSync(`${root}/2026-11-01-closed`, { recursive: true });
  writeFileSync(`${root}/2026-11-01-closed/notes.md`, '# notes\n');
  const closedCp = await checkpointPath(ctx.cwd, '2026-11-01-closed');
  mkdirSync(dirname(closedCp), { recursive: true });
  writeFileSync(closedCp, JSON.stringify({
    version: 1, root: realpathSync(ctx.cwd), discussion: { name: '2026-11-01-closed', title: 'Peek me' },
    state: { transcript: [{ speaker: 'User', text: 'hi' }, { speaker: 'A', text: 'yo' }] },
  }));
  await markClosed(ctx.cwd, '2026-11-01-closed');

  await handleLine('/peek 2026-11-01-closed', ctx);
  assert.equal(ctx.screen.peek.name, '2026-11-01-closed');
  assert.equal(ctx.screen.peek.title, 'Peek me');
  assert.equal(ctx.screen.peek.doc, 'discussions/2026-11-01-closed/notes.md');
  assert.deepEqual(ctx.screen.peek.messages.map((m) => m.speaker), ['User', 'A']);
  assert.equal(ctx.discussion, undefined); // not resumed
  assert.ok(existsSync(await marker('2026-11-01-closed'))); // still closed

  await handleLine('/peek', ctx);
  assert.equal(ctx.screen.peek, null);

  // Not closed, unknown, and brainstorms are refused.
  mkdirSync(`${root}/2026-11-02-open`, { recursive: true });
  await handleLine('/peek 2026-11-02-open', ctx);
  await handleLine('/peek brainstorms/2026-11-03-b', ctx);
  assert.equal(ctx.screen.peek, null);

  // An archived discussion is peeked in place, never moved back to active.
  mkdirSync(`${root}/archive/2026-11-04-old`, { recursive: true });
  const oldCp = await checkpointPath(ctx.cwd, '2026-11-04-old');
  mkdirSync(dirname(oldCp), { recursive: true });
  writeFileSync(oldCp, JSON.stringify({
    version: 1, root: realpathSync(ctx.cwd), discussion: { name: '2026-11-04-old', title: 'Archived' }, state: { transcript: [] },
  }));
  await markClosed(ctx.cwd, '2026-11-04-old');
  await handleLine('/peek archive/2026-11-04-old', ctx);
  assert.equal(ctx.screen.peek.name, '2026-11-04-old');
  assert.deepEqual(ctx.screen.peek.messages, []);
  assert.ok(existsSync(`${root}/archive/2026-11-04-old`));
  assert.ok(!existsSync(`${root}/2026-11-04-old`));
});

test('/peek then /peek restores the live discussion transcript', async () => {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const ctx = await freshSession(['from A', 'from B'], async () => ({ title: 'Live' }));
  await handleLine('hello', ctx);
  const live = ctx.screen.transcript.map((m) => m.speaker);
  assert.ok(live.length >= 1);

  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-closed`, { recursive: true });
  const cp = await checkpointPath(ctx.cwd, '2026-11-01-closed');
  mkdirSync(dirname(cp), { recursive: true });
  writeFileSync(cp, JSON.stringify({ version: 1, root: realpathSync(ctx.cwd), discussion: { name: '2026-11-01-closed', title: 'Closed' }, state: { transcript: [{ speaker: 'User', text: 'x' }] } }));
  await markClosed(ctx.cwd, '2026-11-01-closed');

  await handleLine('/peek 2026-11-01-closed', ctx);
  assert.equal(ctx.screen.peek.name, '2026-11-01-closed');
  assert.deepEqual(ctx.docs.resetEvent(ctx.screen).messages.map((m) => m.speaker), ['User']);

  await handleLine('/peek', ctx);
  assert.equal(ctx.screen.peek, null);
  assert.deepEqual(ctx.docs.resetEvent(ctx.screen).messages.map((m) => m.speaker), live);
});

test('/peek shows a closed brainstorm read-only without starting sessions, and refuses an open brainstorm', async () => {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const ctx = await freshSession(['from A', 'from B'], async () => ({ title: 'Open idea' }));
  mkdirSync(`${ctx.cwd}/brainstorms/2026-11-03-closed-idea`, { recursive: true });
  const cp = await checkpointPath(ctx.cwd, 'brainstorms/2026-11-03-closed-idea');
  mkdirSync(dirname(cp), { recursive: true });
  writeFileSync(cp, JSON.stringify({
    version: 1, root: realpathSync(ctx.cwd), brainstorm: true,
    discussion: { name: '2026-11-03-closed-idea', title: 'Closed idea' },
    state: { transcript: [{ speaker: 'User', text: 'sketch' }, { speaker: 'A', text: 'nice' }] },
  }));

  await handleLine('/peek brainstorms/2026-11-03-closed-idea', ctx);
  assert.equal(ctx.screen.peek.name, '2026-11-03-closed-idea');
  assert.equal(ctx.screen.peek.ref, 'brainstorms/2026-11-03-closed-idea');
  assert.equal(ctx.screen.peek.path, 'brainstorms/2026-11-03-closed-idea');
  assert.equal(ctx.screen.peek.kind, 'brainstorm');
  assert.equal(ctx.screen.peek.title, 'Closed idea');
  assert.deepEqual(ctx.screen.peek.messages.map((m) => m.speaker), ['User', 'A']);
  assert.equal(ctx.discussion, undefined); // no session started
  assert.ok(!ctx.agentsStarted);

  await handleLine('/peek', ctx);
  assert.equal(ctx.screen.peek, null);

  // An open brainstorm cannot be peeked.
  await handleLine('/brainstorm', ctx);
  await handleLine('hello brainstorm', ctx);
  const openName = ctx.discussion.name;
  await handleLine(`/peek brainstorms/${openName}`, ctx);
  assert.equal(ctx.screen.peek, null);
});

test('Restart keeps the launch flags that matter: the same port, agents, worker and dev mode, in the discussion in use', () => {
  // The agents and worker are the room's current ones (ctx), not the launch flags.
  const ctx = { cwd: '/r', agentSpecs: 'claude:Ada', workerSpec: 'codex:W', discussion: { name: '2026-11-03-a-topic' } };
  const args = restartArgs([ctx], { agents: 'claude:Old', worker: 'codex:Old', dev: true, open: true }, 5566);
  assert.match(args[0], /src\/cli\.mjs$/);
  assert.deepEqual(args.slice(1), ['--cwd', '/r', '--port', '5566', '--agents', 'claude:Ada', '--worker', 'codex:W', '--dev', '--reopen', '2026-11-03-a-topic']);
  assert.deepEqual(restartArgs([{ cwd: '/r', discussion: null }], {}, 5566).slice(1), ['--cwd', '/r', '--port', '5566']);
  // Every other room of the server comes back too, with its own settings and discussion.
  const other = { cwd: '/o', launch: false, agentSpecs: 'codex:Lin', workerSpec: 'claude:Wo', discussion: { name: '2026-11-04-b' } };
  assert.deepEqual(restartArgs([ctx, other], {}, 5566).slice(-2),
    ['--room', JSON.stringify({ cwd: '/o', agents: 'codex:Lin', worker: 'claude:Wo', reopen: '2026-11-04-b' })]);
  // Replication flags only when the first room is the launch room.
  assert.equal(restartArgs([other], { node: 'Mac', peer: ['p=http://x:1'] }, 5566).some((a) => a === '--node' || a === '--peer'), false);
  assert.deepEqual(restartArgs([ctx], { node: 'Mac', peer: ['p=http://x:1'] }, 5566).slice(9, 13), ['--node', 'Mac', '--peer', 'p=http://x:1']);
});

test('/brainstorm: its first message names it in brainstorms/<date>-<title>/ with a transcript; the agents are told it is a brainstorm, and its folder', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const titled = [];
  const ctx = await freshSession(['an idea', 'PASS', 'PASS', '- the idea', 'PASS'], async (text) => { titled.push(text); return { title: 'Bright idea' }; });
  const prompts = [];
  const turn = ctx.room.agents[0].turn;
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return turn(p); };
  await handleLine('/brainstorm', ctx);
  assert.deepEqual([ctx.screen.room.discussion, ctx.screen.room.brainstorm, ctx.screen.room.started, ctx.screen.room.active], ['New brainstorm', true, true, null]);
  assert.deepEqual(readdirSync(ctx.cwd), []); // nothing yet
  await handleLine('hello', ctx); // a round, with no automatic summary
  assert.deepEqual(titled, ['hello']);
  const [name] = readdirSync(`${ctx.cwd}/brainstorms`);
  assert.match(name, /^\d{4}-\d{2}-\d{2}-bright-idea$/);
  assert.deepEqual(readdirSync(ctx.cwd), ['brainstorms']); // no discussions/
  assert.equal(ctx.discussion.title, 'Bright idea');
  assert.deepEqual([ctx.screen.room.discussion, ctx.screen.room.active], ['Bright idea', `brainstorms/${name}`]);
  assert.match(ctx.logPath, new RegExp(`brainstorms/${name}/transcripts/session-`));
  assert.match(readFileSync(ctx.logPath, 'utf8'), /\*\*User\*\*\n\nhello[\s\S]*\*\*A\*\*/);
  assert.deepEqual(ctx.state.transcript.map((m) => m.speaker), ['User', 'A', 'B', 'A']);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /This is a brainstorm, not a discussion\. Its folder is .*brainstorms\/[^ ]*: write nothing except drawings, in .*\/drawings\//);
  assert.doesNotMatch(prompts[0], /discussions\//);
  await handleLine('/summary', ctx); // manual /summary still works in a brainstorm
  assert.deepEqual(ctx.state.transcript.filter((m) => !m.summary).map((m) => m.speaker), ['User', 'A', 'B', 'A', 'Summary']);
  assert.equal(ctx.state.transcript.at(-1).text, '- the idea');
  assert.match(prompts.at(-1), /asked for a summary/);
  assert.doesNotMatch(prompts.at(-1), /pending-instructions/); // the summary prompt
  assert.match(readFileSync(ctx.logPath, 'utf8'), /\*\*Summary\*\* — agreed/);
  assert.deepEqual(readdirSync(`${ctx.cwd}/brainstorms/${name}`), ['transcripts']);
});

test('brainstorm and discussion names never clash: each skips the names the other kind (and archive/, deferred/) has taken', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Same topic' }));
  ctx.noScreen = true;
  const now = new Date(), d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  mkdirSync(`${ctx.cwd}/discussions/archive/${d}-same-topic`, { recursive: true });
  await handleLine('/brainstorm', ctx);
  await handleLine('one', ctx);
  assert.equal(ctx.discussion.name, `${d}-same-topic-2`); // taken in discussions/archive/
  await handleLine('/new', ctx);
  await handleLine('two', ctx);
  assert.equal(ctx.discussion.name, `${d}-same-topic-3`); // -2 is the brainstorm's
  assert.deepEqual(readdirSync(`${ctx.cwd}/brainstorms`), [`${d}-same-topic-2`]);
  assert.deepEqual(readdirSync(`${ctx.cwd}/discussions`).sort(), [`${d}-same-topic-3`, 'archive']);
});

test('terminal: New brainstorm ends the session in use (a discussion, or a brainstorm), which keeps its folder and transcript', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  const resets = [];
  for (const a of [...ctx.room.agents, ctx.worker]) a.reset = () => resets.push(a.name);
  await handleLine('first', ctx); // a discussion
  const [name] = readdirSync(`${ctx.cwd}/discussions`);
  const transcript = ctx.logPath;
  await handleLine('/brainstorm', ctx);
  assert.deepEqual(resets, ['A', 'B']); // the worker carries on
  assert.equal(ctx.discussion, null);
  assert.equal(ctx.logPath, null);
  assert.deepEqual(ctx.state.transcript, []);
  assert.match(readFileSync(transcript, 'utf8'), /session ended: starting a brainstorm/);
  await handleLine('idea one', ctx);
  assert.equal(ctx.state.transcript[0].text, 'idea one');
  const first = ctx.discussion.name;
  await handleLine('/brainstorm', ctx); // the terminal has one at a time: the first one's session ends, its folder stays
  assert.deepEqual(resets, ['A', 'B', 'A', 'B']);
  assert.match(readFileSync(`${ctx.cwd}/brainstorms/${first}/transcripts/${readdirSync(`${ctx.cwd}/brainstorms/${first}/transcripts`)[0]}`, 'utf8'), /idea one[\s\S]*session ended: starting a brainstorm/);
  assert.deepEqual(ctx.state.transcript, []);
  assert.equal(ctx.screen.room.brainstorm, true);
  await handleLine('idea two', ctx);
  assert.deepEqual(ctx.state.transcript.map((m) => m.text), ['idea two', 'PASS', 'PASS']);
  assert.deepEqual(readdirSync(`${ctx.cwd}/discussions`), [name]);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/${name}/transcripts`).length, 1);
  assert.doesNotMatch(readFileSync(transcript, 'utf8'), /idea/);
});

test('terminal: New discussion or Resume ends the brainstorm session (its folder stays); the next message then starts a discussion', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Real topic' }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  await handleLine('/brainstorm', ctx);
  await handleLine('just talking', ctx);
  await handleLine('/new', ctx);
  assert.deepEqual([ctx.state.brainstorm, ctx.state.transcript.length, ctx.screen.room.discussion], [false, 0, 'No discussion started']);
  await handleLine('now for real', ctx);
  assert.equal(ctx.discussion.title, 'Real topic');
  assert.match(ctx.logPath, /discussions\/[^/]*-real-topic-2\/transcripts\/session-/); // -1 is the brainstorm's
  assert.equal(readdirSync(`${ctx.cwd}/brainstorms`).length, 1);

  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`);
  await handleLine('/brainstorm', ctx);
  await handleLine('more talk', ctx);
  await handleLine('/resume 2026-11-01-old', ctx);
  assert.deepEqual([ctx.state.brainstorm, ctx.state.transcript.length, ctx.discussion.name], [false, 0, '2026-11-01-old']);
  await handleLine('back to it', ctx);
  assert.match(ctx.logPath, /2026-11-01-old\/transcripts\/session-/);
  assert.equal(readdirSync(`${ctx.cwd}/discussions`).length, 2);
});

test('Reload keeps the brainstorm\'s messages and its mode: the next message goes on in its folder, creating no discussion', async () => {
  const { readdirSync } = await import('node:fs');
  const { reloaded } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => { throw new Error('no title this time'); });
  await handleLine('/brainstorm', ctx);
  await handleLine('an idea', ctx);
  const said = ctx.state.transcript.map((m) => m.text), logPath = ctx.logPath;
  // What cli.mjs does on Reload: load fresh modules on the same ctx, then reloaded().
  Object.assign(ctx, { agentSpecs: 'claude:A,claude:B', workerSpec: 'claude:W', sessions: new Map(), code: {}, refreshQuota: () => {} });
  Object.assign(ctx, await load(ctx, `?brainstorm=${Date.now()}`));
  for (const a of ctx.room.agents) a.turn = async () => 'PASS';
  await reloaded(ctx);
  assert.deepEqual(ctx.screen.transcript.map((m) => m.text), said); // a refreshed page gets them
  assert.equal(ctx.screen.room.brainstorm, true);
  assert.match(ctx.screen.room.discussion, /^Brainstorm — /); // no title: named after the date and time
  await handleLine('another idea', ctx);
  assert.deepEqual(ctx.state.transcript.map((m) => m.text), [...said, 'another idea', 'PASS', 'PASS']);
  assert.deepEqual(readdirSync(ctx.cwd), ['brainstorms']);
  assert.equal(ctx.logPath, logPath);
});

test('/new: nothing to end before the first message; it creates nothing and changes nothing', async () => {
  const { readdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  await handleLine('/new', ctx);
  assert.equal(ctx.discussion, undefined);
  assert.deepEqual(readdirSync(ctx.cwd), []);
});

test('/new after a round: the session ends as with Resume; the next message starts a new titled discussion', async () => {
  const { mkdirSync, readdirSync, readFileSync, chmodSync } = await import('node:fs');
  const ctx = await freshSession([], async (text) => ({ title: text === 'hello' ? 'First topic' : 'Second topic' }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  const resets = [];
  for (const a of [...ctx.room.agents, ctx.worker]) a.reset = () => resets.push(a.name);
  const prompts = [];
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('hello', ctx);
  const first = ctx.logPath;
  const [name] = readdirSync(`${ctx.cwd}/discussions`);

  await handleLine('/new', ctx);
  assert.deepEqual(resets, ['A', 'B']); // fresh discussion sessions; the worker's is kept
  assert.equal(ctx.discussion, null);
  assert.equal(ctx.logPath, null);
  assert.deepEqual(ctx.state.transcript, []);
  assert.equal(ctx.screen.room.discussion, 'No discussion started');
  assert.deepEqual(ctx.screen.room.back, { name, title: 'First topic' });
  assert.match(readFileSync(first, 'utf8'), /session ended: starting a new discussion/);
  assert.deepEqual(readdirSync(`${ctx.cwd}/discussions`), [name]); // nothing created yet

  // A failed folder creation sends nothing and keeps the way back.
  chmodSync(`${ctx.cwd}/discussions`, 0o555);
  try { await handleLine('second', ctx); } finally { chmodSync(`${ctx.cwd}/discussions`, 0o755); }
  assert.equal(prompts.length, 1);
  assert.deepEqual(ctx.screen.room.back, { name, title: 'First topic' });

  await handleLine('second', ctx);
  assert.equal(ctx.discussion.title, 'Second topic');
  assert.equal(ctx.screen.room.back, null); // the link lasts until the new discussion starts
  assert.match(ctx.logPath, /second-topic\/transcripts\/session-/);
  assert.match(prompts[1], /You are A, one of several AI agents/); // introduced again
  assert.match(prompts[1], /This is a new discussion/);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/${name}/transcripts`).length, 1);

  // Going back: Resume the first one (it remembers this one in turn).
  mkdirSync(`${ctx.cwd}/discussions/x`, { recursive: true });
  await handleLine(`/resume ${name}`, ctx);
  assert.equal(ctx.discussion.name, name);
  assert.equal(ctx.screen.room.back.title, 'Second topic');
});

test('/new in the terminal doesn\'t wait: a running task finishes in the old discussion\'s worker session and transcript, its log stays, and the new discussion\'s worker starts fresh', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const titles = ['First topic', 'Second topic'];
  const ctx = await freshSession([], async () => ({ title: titles.shift() }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  await gitRoom(ctx.cwd);
  let resetWorker = false;
  ctx.worker.reset = () => { resetWorker = true; };
  const got = [];
  let finish;
  ctx.worker.turn = async (p) => { got.push(p); return got.length === 2 ? new Promise((done) => { finish = done; }) : 'ok'; };
  await handleLine('hello', ctx);
  const first = ctx.logPath, firstDir = ctx.discussion.dir;
  queueWork(ctx, 'one');
  await ctx.workQueue;
  queueWork(ctx, 'long task');
  await until(() => finish);

  const old = ctx.worker;
  await handleLine('/new', ctx); // returns while the worker is still busy: it doesn't wait for it
  assert.equal(resetWorker, false); // its session isn't touched: it goes with its discussion
  assert.notEqual(ctx.worker, old);
  assert.equal(old.seat.logPath, first);
  assert.ok(ctx.screen.worker.some((m) => m.note?.includes('keeps its worker session; its tasks still running or queued finish there and report to it')));
  finish('long done');
  await ctx.workQueue;
  assert.match(readFileSync(first, 'utf8'), /long task[\s\S]*session ended[\s\S]*long done/); // in the old transcript
  assert.equal(ctx.screen.worker.filter((m) => m.speaker === 'W').length, 2); // the log stays

  queueWork(ctx, 'before the folder exists'); // the new, fresh session: told where it works, no discussion yet
  await ctx.workQueue;
  assert.match(got[2], /^\[your reported usage this session: [^\]]+\]\n\nYour working directory is /);
  assert.ok(!got[2].includes('create, read and write'));
  assert.ok(!got[2].includes(firstDir));

  await handleLine('second', ctx);
  queueWork(ctx, 'after');
  await ctx.workQueue;
  assert.match(got[3], new RegExp(`^\\[your reported usage this session: [^\\]]+\\]\\n\\nThe active discussion's folder is ${ctx.discussion.dir}: `));
  assert.ok(!readFileSync(ctx.logPath, 'utf8').includes('long done'));
});

test('after New discussion, the previous one can\'t move while its worker task runs; it can once the task ends', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { existsSync, readFileSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'First topic' }));
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  let finish;
  await gitRoom(ctx.cwd);
  ctx.worker.turn = () => new Promise((done) => { finish = done; });
  await handleLine('hello', ctx);
  const name = ctx.discussion.name, first = ctx.logPath;
  queueWork(ctx, 'long task');
  await until(() => finish);
  await handleLine('/new', ctx);
  await markClosed(ctx.cwd, name);
  const notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { if (ev.type === 'note') notes.push(ev); } };

  await handleLine(`/move ${name} archive`, ctx);
  assert.ok(existsSync(`${ctx.cwd}/discussions/${name}`)); // not moved
  assert.match(notes.at(-1).text, /A worker task is still writing to .*; try again when it finishes/);
  assert.equal(notes.at(-1).error, true);

  finish('done');
  await ctx.workQueue;
  assert.equal(ctx.screen.working, null);
  assert.match(readFileSync(first, 'utf8'), /done/); // saved in its own transcript
  await handleLine(`/move ${name} archive`, ctx);
  assert.ok(existsSync(`${ctx.cwd}/discussions/archive/${name}`));
});

test('a transcript that can\'t be written keeps the worker\'s reply visible, reports the error and ends the busy state', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { rmSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'First topic' }));
  let finish;
  await gitRoom(ctx.cwd);
  ctx.worker.turn = () => new Promise((done) => { finish = done; });
  const events = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => events.push(ev) };
  await handleLine('hello', ctx);
  queueWork(ctx, 'task');
  await until(() => finish);
  rmSync(ctx.discussion.dir, { recursive: true }); // the transcript's folder is gone

  finish('the reply');
  await ctx.workQueue;
  const shown = ctx.screen.worker;
  assert.ok(shown.some((m) => m.speaker === 'W' && m.html.includes('the reply')));
  assert.match(shown.at(-1).note, /couldn't save to the transcript: .*ENOENT/);
  assert.equal(shown.at(-1).error, true);
  assert.equal(ctx.screen.working, null);
  assert.deepEqual(events.filter((e) => e.type === 'working').at(-1), { type: 'working', name: null });
  assert.equal(ctx.workingIn, null);
});

// ── Stage A: the worker's own worktree ──
// A room whose worker records its prompts; its notes go to ctx.notes.
async function workerRoom() {
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  const got = [];
  ctx.worker.turn = async (p) => { got.push(p); return 'ok'; };
  ctx.notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { if (ev.type === 'note') ctx.notes.push(ev.text); } };
  return { ctx, got };
}
const work = async (ctx, text) => { const { queueWork } = await import('../src/ui.mjs'); queueWork(ctx, text); await ctx.workQueue; };

test('without a Git repository, or without a commit, the worker is disabled with an explanation', async () => {
  const { execFileSync } = await import('node:child_process');
  const { refreshWorker } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  await refreshWorker(ctx);
  assert.equal(ctx.screen.workerInfo.disabled, true);
  assert.equal(ctx.screen.workerInfo.lines[0], 'Worker requires a source Git repository for its isolated worktree.');
  await work(ctx, 'do it');
  assert.deepEqual(got, []);
  assert.match(ctx.notes.at(-1), /Worker requires a source Git repository.*The instruction was not sent/);

  const empty = (await workerRoom()).ctx;
  execFileSync('git', ['-C', empty.cwd, 'init', '-q']);
  await refreshWorker(empty);
  assert.match(empty.screen.workerInfo.lines[0], /no commit yet/);
});

test('workerInfo.merged lists discussions with labelled commits in HEAD without needing worker branches', async () => {
  const { writeFileSync } = await import('node:fs');
  const { refreshWorker } = await import('../src/ui.mjs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  // Direct labelled commit on main (no worker/<name> branch exists).
  writeFileSync(`${ctx.cwd}/a.txt`, 'a\n'); git('add', 'a.txt');
  git('commit', '-q', '-m', '[2026-11-20-merged-one] add feature');
  // Branch merged into main and then deleted.
  git('checkout', '-q', '-b', 'worker/2026-11-20-merged-two');
  writeFileSync(`${ctx.cwd}/b.txt`, 'b\n'); git('add', 'b.txt');
  git('commit', '-q', '-m', '[2026-11-20-merged-two] branch work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', 'worker/2026-11-20-merged-two', '-m', 'Merge worker/2026-11-20-merged-two');
  git('branch', '-d', '-q', 'worker/2026-11-20-merged-two');
  // Unlabelled commit and non-discussion bracket prefix are ignored.
  writeFileSync(`${ctx.cwd}/c.txt`, 'c\n'); git('add', 'c.txt');
  git('commit', '-q', '-m', 'plain commit');
  writeFileSync(`${ctx.cwd}/d.txt`, 'd\n'); git('add', 'd.txt');
  git('commit', '-q', '-m', '[brainstorm] note');

  await refreshWorker(ctx);
  assert.deepEqual(ctx.screen.workerInfo.merged, ['2026-11-20-merged-one', '2026-11-20-merged-two']);
});

test('the first instruction creates the worktree beside the repository, on worker/main from HEAD; the worker runs there', async () => {
  const { existsSync, realpathSync } = await import('node:fs');
  const { refreshWorker } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  const head = git('rev-parse', 'HEAD');
  const path = `${realpathSync(ctx.cwd)}.worker`;
  await refreshWorker(ctx); // at start: says where it will be, creates nothing
  assert.match(ctx.screen.workerInfo.lines[0], /will be created at .*\.worker, on worker\/main, from [0-9a-f]{7}/);
  assert.equal(existsSync(path), false);

  await work(ctx, 'do it');
  assert.equal(ctx.workerDir.path, path);
  assert.equal(git('-C', path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worker/main');
  assert.equal(git('rev-parse', 'worker/main'), head);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main'); // the room's branch is unchanged
  assert.match(got[0], new RegExp(`^\\[your reported usage this session: [^\\]]+\\]\\n\\nYour working directory is ${path}, your own Git worktree of the project, on the branch worker/main\\. Make your changes there, never in the room's root`));
  assert.match(got[0], /do it$/);
  await work(ctx, 'again');
  assert.match(got[1], /^\[your reported usage this session: [^\]]+\]\n\nagain$/); // told once
  assert.match(ctx.screen.workerInfo.lines[0], new RegExp(`^Worktree ${path} · branch worker/main · based on ${head.slice(0, 7)}$`));
});

test('a dirty room is left exactly as it was; the worker doesn\'t see its uncommitted changes, and the tab says so', async () => {
  const { writeFileSync, readFileSync, existsSync, realpathSync } = await import('node:fs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  writeFileSync(`${ctx.cwd}/a.txt`, 'one\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'a');
  writeFileSync(`${ctx.cwd}/a.txt`, 'edited\n');
  writeFileSync(`${ctx.cwd}/b.txt`, 'staged\n'); git('add', 'b.txt');
  writeFileSync(`${ctx.cwd}/c.txt`, 'untracked\n');
  const before = [git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('rev-parse', '--abbrev-ref', 'HEAD'), git('diff', '--cached')];
  await work(ctx, 'do it');
  assert.deepEqual([git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('rev-parse', '--abbrev-ref', 'HEAD'), git('diff', '--cached')], before);
  assert.equal(readFileSync(`${ctx.cwd}/a.txt`, 'utf8'), 'edited\n');
  const path = `${realpathSync(ctx.cwd)}.worker`;
  assert.equal(readFileSync(`${path}/a.txt`, 'utf8'), 'one\n');
  assert.ok(!existsSync(`${path}/b.txt`) && !existsSync(`${path}/c.txt`));
  assert.ok(ctx.screen.workerInfo.lines.includes('The room has uncommitted changes: the worker doesn\'t see them.'));
});

test('after a restart the worktree is reused; an existing worker/main without a worktree is reattached; nothing is deleted', async () => {
  const { writeFileSync, realpathSync } = await import('node:fs');
  const first = (await workerRoom()).ctx;
  const git = await gitRoom(first.cwd);
  await work(first, 'do it');
  const path = `${realpathSync(first.cwd)}.worker`;
  writeFileSync(`${path}/wip.txt`, 'unfinished\n'); // the worker's uncommitted work
  const { ctx: again, got } = await workerRoom(); // a new process on the same room
  again.cwd = first.cwd;
  // Its owner is unknown to the new process: the queue holds, and the edits are left as they are.
  const { queueWork } = await import('../src/ui.mjs');
  queueWork(again, 'more');
  await until(() => workerLane(again).blockedBy);
  assert.equal(workerLane(again).blockedBy.origin, null);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(got, []);
  assert.equal(git('-C', path, 'status', '--porcelain'), '?? wip.txt'); // kept
  // Committed (here by hand): the held instruction runs, in the reused worktree.
  git('-C', path, 'add', 'wip.txt'); git('-C', path, 'commit', '-q', '-m', 'unfinished work');
  await again.workQueue;
  assert.equal(again.workerDir.path, path);
  assert.match(got[0], /more$/);

  const other = (await workerRoom()).ctx; // a branch made earlier, its worktree removed by hand
  const g2 = await gitRoom(other.cwd);
  g2('branch', 'worker/main');
  g2('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'room moves on');
  await work(other, 'do it');
  assert.equal(g2('-C', `${realpathSync(other.cwd)}.worker`, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worker/main');
});

test('a folder already at the worktree\'s place is refused and left alone; the worker doesn\'t run', async () => {
  const { mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
  const { ctx, got } = await workerRoom();
  await gitRoom(ctx.cwd);
  mkdirSync(`${ctx.cwd}.worker`);
  writeFileSync(`${ctx.cwd}.worker/mine.txt`, 'keep\n');
  await work(ctx, 'do it');
  assert.deepEqual(got, []);
  assert.deepEqual(readdirSync(`${ctx.cwd}.worker`), ['mine.txt']);
  const reply = ctx.screen.worker.at(-1);
  assert.equal(reply.error, true);
  assert.match(reply.html, /already exists and isn&#39;t the worker&#39;s worktree: nothing was changed/); // HTML
  assert.equal(ctx.screen.working, null);
});

test('worker/main catches up with the room only when strictly behind with a clean worktree; otherwise it is left as it is', async () => {
  const { writeFileSync, realpathSync } = await import('node:fs');
  const { ctx, got } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  const path = `${realpathSync(ctx.cwd)}.worker`;
  await work(ctx, 'start');
  git('commit', '-q', '--allow-empty', '-m', 'merged by the User');
  await work(ctx, 'next');
  assert.equal(git('rev-parse', 'worker/main'), git('rev-parse', 'HEAD')); // fast-forwarded

  git('commit', '-q', '--allow-empty', '-m', 'room 2');
  writeFileSync(`${path}/wip.txt`, 'x\n');
  const before = git('rev-parse', 'worker/main');
  // Uncommitted edits: the queue holds, with the edits intact and worker/main where it was.
  const { queueWork, refreshWorker } = await import('../src/ui.mjs');
  queueWork(ctx, 'dirty');
  await until(() => workerLane(ctx).blockedBy);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!got.some((p) => p.endsWith('dirty')));
  assert.equal(git('-C', path, 'status', '--porcelain'), '?? wip.txt');
  assert.equal(git('rev-parse', 'worker/main'), before);
  await refreshWorker(ctx);
  assert.ok(ctx.screen.workerInfo.lines.some((l) => /1 commit behind the room: its worktree has uncommitted changes, so it is left as it is/.test(l)));

  // Committed: the held instruction runs; worker/main has its own commit now, so it isn't moved.
  git('-C', path, 'add', 'wip.txt'); git('-C', path, 'commit', '-q', '-m', 'worker work');
  const own = git('rev-parse', 'worker/main');
  await ctx.workQueue;
  assert.ok(got.some((p) => p.endsWith('dirty')));
  assert.equal(git('rev-parse', 'worker/main'), own);
  await work(ctx, 'own commits');
  assert.equal(git('rev-parse', 'worker/main'), own); // never reset, merged or rebased
  assert.ok(ctx.screen.workerInfo.lines.includes('worker/main has 1 commit not in the room: review and merge them when ready.'));
  assert.ok(ctx.screen.workerInfo.lines.some((l) => /behind the room and has commits of its own: it is left as it is/.test(l)));
});

// ── Lanes: a worktree and branch per discussion ──
test('each discussion works in its own lane, <repo>.workers/<name>/ on worker/<name>; before the first message, worker/main; a saved session is told its worktree changed; a brainstorm sends none', async () => {
  const { realpathSync } = await import('node:fs');
  const { ctx, got } = await workerRoom();
  ctx.noScreen = true; // terminal mode: one discussion at a time
  const git = await gitRoom(ctx.cwd);
  const root = realpathSync(ctx.cwd);
  await work(ctx, 'before the first message');
  assert.equal(ctx.workerDir.path, `${root}.worker`);
  let resets = 0;
  ctx.worker.reset = () => { resets++; };
  await handleLine('hello', ctx);
  const name = ctx.discussion.name;
  await work(ctx, 'in the discussion');
  assert.equal(ctx.workerDir.path, `${root}.workers/${name}`);
  assert.equal(git('-C', ctx.workerDir.path, 'rev-parse', '--abbrev-ref', 'HEAD'), `worker/${name}`);
  assert.equal(git('rev-parse', `worker/${name}`), git('rev-parse', 'HEAD')); // from the room's HEAD
  assert.ok(got[1].includes(`Your worktree has changed: until now you worked in ${root}.worker; from now on you work in ${root}.workers/${name}, on the branch worker/${name}. Leave ${root}.worker alone from now on`));
  assert.ok(got[1].includes(`commit it on worker/${name} with a message starting "[${name}]"`));
  assert.equal(resets, 0); // the same session continues
  await work(ctx, 'again');
  assert.match(got[2], /^\[your reported usage this session: [^\]]+\]\n\nagain$/); // told once
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main'); // the room's branch is unchanged
  await handleLine('/brainstorm', ctx);
  await work(ctx, 'brainstorm task');
  assert.equal(got.length, 3); // not sent
  assert.match(ctx.notes.at(-1), /Turn this brainstorm into a discussion to send work\. The instruction was not sent/);
});

test('a task queued before the discussion\'s first message stays on worker/main, even if it runs after the message created the discussion', async () => {
  const { realpathSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  ctx.noScreen = true;
  await gitRoom(ctx.cwd);
  const root = realpathSync(ctx.cwd);
  let finish;
  const dirs = [];
  ctx.worker.turn = (p) => { got.push(p); dirs.push(ctx.workerDir.path); return got.length === 1 ? new Promise((r) => { finish = r; }) : 'ok'; };
  queueWork(ctx, 'first');
  await until(() => finish);
  queueWork(ctx, 'queued before the message');
  await handleLine('hello', ctx); // creates the discussion while both wait
  queueWork(ctx, 'after the message');
  finish('done');
  await ctx.workQueue;
  assert.deepEqual(dirs, [`${root}.worker`, `${root}.worker`, `${root}.workers/${ctx.discussion.name}`]);
});

test('migration: a discussion\'s lane waits while worker/main has uncommitted edits or that discussion\'s commits not in main, which are left where they are; Defer counts those commits too', async () => {
  const { writeFileSync, existsSync, mkdirSync, realpathSync } = await import('node:fs');
  const { ensureWorktree, workerPlace } = await import('../src/ui.mjs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  await work(ctx, 'before lanes'); // no discussion: worker/main, in <repo>.worker/
  const shared = `${realpathSync(ctx.cwd)}.worker`;
  const name = '2026-11-12-old-topic';
  mkdirSync(`${ctx.cwd}/discussions/${name}`, { recursive: true });
  await markClosed(ctx.cwd, name);
  git('-C', shared, 'commit', '-q', '--allow-empty', '-m', `[${name}] earlier work`);
  const kept = git('rev-parse', 'worker/main');
  const lane = await workerPlace(ctx.cwd, name);
  await assert.rejects(ensureWorktree(lane), new RegExp(`worker/main has commits of \\[${name}\\] not in main: ${kept.slice(0, 7)}\\. Merge worker/main into main first`));
  await handleLine(`/move ${name} deferred`, ctx);
  assert.match(ctx.notes.at(-1), new RegExp(`${name} can't be deferred: commits on worker/main are not merged into main: ${kept}`));
  writeFileSync(`${shared}/wip.txt`, 'x\n');
  await assert.rejects(ensureWorktree(lane), /\.worker \(worker\/main\) has uncommitted edits: this discussion's own worktree is not created until they are committed or resolved there/);
  assert.equal(existsSync(lane.path), false);
  assert.equal(git('branch', '--list', `worker/${name}`), '');
  assert.equal(git('rev-parse', 'worker/main'), kept); // never moved, dropped or rewritten
  assert.equal(git('-C', shared, 'status', '--porcelain'), '?? wip.txt');
  git('-C', shared, 'add', 'wip.txt'); git('-C', shared, 'commit', '-q', '-m', 'brainstorm work');
  git('merge', '-q', '--no-ff', 'worker/main', '-m', 'User merges worker/main');
  await ensureWorktree(lane);
  assert.equal(git('-C', lane.path, 'rev-parse', '--abbrev-ref', 'HEAD'), `worker/${name}`);
  assert.equal(git('rev-parse', `worker/${name}`), git('rev-parse', 'main'));
  const bad = await workerPlace(ctx.cwd, '2026-11-12-has space');
  assert.match(bad.disabled, /can't be a Git branch name/);
});

test('the Worker tab checks each branch with work not in main: whether it contains main, the commits its worker last reported testing, and an advisory merge preview that changes no branch, worktree or index', async () => {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { refreshWorker } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  ctx.noScreen = true;
  const git = await gitRoom(ctx.cwd);
  writeFileSync(`${ctx.cwd}/shared.txt`, 'base\n'); git('add', 'shared.txt'); git('commit', '-q', '-m', 'base');
  const [major, minor] = execFileSync('git', ['version']).toString().match(/(\d+)\.(\d+)/).slice(1).map(Number);
  const preview = major > 2 || (major === 2 && minor >= 38); // merge-tree --write-tree
  await handleLine('hello', ctx);
  const name = ctx.discussion.name, branch = `worker/${name}`;
  const lines = () => ctx.screen.workerInfo.lines;
  let reply;
  ctx.worker.turn = async (p) => { got.push(p); return typeof reply === 'function' ? reply() : reply; };
  reply = () => { const tree = ctx.workerDir.path; writeFileSync(`${tree}/shared.txt`, 'worker\n'); git('-C', tree, 'commit', '-q', '-am', `[${name}] change`); return 'committed\nDocs: none needed, because test.'; };
  await work(ctx, 'change it');
  const main1 = git('rev-parse', 'main');
  assert.ok(lines().includes(`${branch} contains current main (${main1.slice(0, 7)}).`));
  assert.ok(lines().includes(`${branch}: no test report on top of main from its worker yet.`));
  const advice = `Merge preview of ${branch} into main (advice only: it can go stale, and a clean merge doesn't prove the combined code works)`;
  if (preview) assert.ok(lines().includes(`${advice}: clean.`));
  else assert.ok(!lines().some((l) => l.startsWith('Merge preview'))); // not shown with an older Git

  // Main moves on with a clashing change: the checks say so, and the preview touches nothing.
  writeFileSync(`${ctx.cwd}/shared.txt`, 'main\n'); git('commit', '-q', '-am', 'main change');
  const main2 = git('rev-parse', 'main');
  const state = () => [git('for-each-ref'), git('status', '--porcelain'), git('-C', ctx.workerDir.path, 'status', '--porcelain'), git('diff', '--cached'), git('-C', ctx.workerDir.path, 'diff', '--cached')];
  const before = state();
  await refreshWorker(ctx);
  assert.deepEqual(state(), before);
  assert.ok(lines().includes(`${branch} lacks 1 commit of current main (${main2.slice(0, 7)}): its worker merges main in with its next instruction. Merge it into main after that, once its tests pass on top of main.`));
  if (preview) assert.ok(lines().includes(`${advice}: would conflict in shared.txt.`));
  // The page shows the lane collapsed under a summary of the same checks.
  assert.equal(ctx.screen.workerInfo.lanes[0].own, true);
  assert.deepEqual(ctx.screen.workerInfo.lanes[0].lines, lines());
  assert.equal(ctx.screen.workerInfo.lanes[0].summary, [branch, '1 commit to review', 'lacks 1 commit of main', 'not tested on main', ...(preview ? ['would conflict in 1 file'] : [])].join(' · '));

  // The next task merges main, resolves, tests, and names the commits it tested.
  reply = () => {
    const tree = ctx.workerDir.path;
    try { git('-C', tree, 'merge', 'main', '--no-edit'); } catch {} // the conflict
    writeFileSync(`${tree}/shared.txt`, 'both\n'); git('-C', tree, 'commit', '-q', '-am', `[${name}] catch up with main`);
    return `npm test: 3 passed\nTested: ${git('-C', tree, 'rev-parse', 'HEAD')} with main ${main2}: tests passed`;
  };
  await work(ctx, 'next');
  assert.match(got.at(-1), /After a successful merge, run the project's tests \(npm test, if it has them\) and report their real output/);
  const tip = git('rev-parse', branch);
  assert.ok(lines().includes(`${branch} contains current main (${main2.slice(0, 7)}).`));
  assert.ok(lines().some((l) => l.startsWith(`Last tested (the worker's report): ${branch} ${tip.slice(0, 7)} with main ${main2.slice(0, 7)}, tests passed, `) && l.endsWith('Still current.')));
  if (preview) assert.ok(lines().includes(`${advice}: clean.`));

  // Rechecked when shown again: main has moved, so the report is out of date.
  git('commit', '-q', '--allow-empty', '-m', 'main moves on');
  const main3 = git('rev-parse', 'main');
  await refreshWorker(ctx);
  assert.ok(lines().some((l) => l.startsWith('Last tested') && l.endsWith(`Out of date: main is now at ${main3.slice(0, 7)}.`)));
  // A "Tested:" line Git doesn't agree with is reported, not recorded.
  reply = `Tested: ${main3} with main ${main2}: tests passed`; // main's commit, not one on the branch
  await work(ctx, 'claim');
  assert.ok(ctx.screen.worker.some((m) => m.note === `✗ The worker's "Tested:" line was not recorded: ${main3.slice(0, 7)} is not on ${branch}.`));
  assert.ok(lines().some((l) => l.startsWith(`Last tested (the worker's report): ${branch} ${tip.slice(0, 7)}`)));
});

// ── Updating from the code before lanes (slice 1a): Reload is refused, Restart applies it ──
// Slice 1a's real code, from Git: the last commit before each discussion had its own worker queue.
const BEFORE_LANES = 'fc0ca68dbfffea4a48a5b8529fc7b308ed4efdb0';
let beforeLanes; // its ui.mjs module, or null if the commit isn't in this repository (the tests skip)
async function codeBeforeLanes() {
  if (beforeLanes !== undefined) return beforeLanes;
  const { execFileSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const repo = new URL('..', import.meta.url).pathname;
  try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${BEFORE_LANES}^{commit}`], { stdio: 'pipe' }); }
  catch { return (beforeLanes = null); }
  const root = await tmp('before-lanes-');
  execFileSync('sh', ['-c', `git -C "${repo}" archive ${BEFORE_LANES} | tar -x -C "${root}"`]);
  symlinkSync(`${repo}/node_modules`, `${root}/node_modules`);
  return (beforeLanes = await import(`${root}/src/ui.mjs`));
}
// A folder with `n` discussions open on 1a's code, as cli.mjs's addRoom makes them (with no
// discussion started, their tasks go to worker/main). Each worker's turn is `turn(ctx, prompt)`.
async function folderBeforeLanes(old, n, turn = async (c, p) => `done: ${p.split('\n').at(-1)}`) {
  const { realpathSync } = await import('node:fs');
  const cwd = await tmp('before-lanes-room-'), git = await gitRoom(cwd), hub = { rooms: new Map() };
  const make = async (tag, ui = old) => {
    const ctx = { cwd, hub, context: tag, key: realpathSync(cwd) + (tag ? `#${tag}` : ''), agentSpecs: 'claude:A', workerSpec: 'claude:W', noScreen: true,
      state: { transcript: [], seen: new Map() }, sessions: new Map(), code: {}, refreshQuota: () => {}, say: () => {}, prompts: [] };
    hub.rooms.set(ctx.key, ctx);
    try { Object.assign(ctx, await ui.load(ctx, '')); } catch (err) { hub.rooms.delete(ctx.key); throw err; } // as addRoom does
    ctx.ui = ui;
    ctx.worker.turn = (p) => { ctx.prompts.push(p.split('\n').at(-1)); return turn(ctx, p); };
    return ctx;
  };
  const contexts = [];
  for (let i = 0; i < n; i++) contexts.push(await make(i ? `d${i}` : null));
  return { cwd, git, hub, contexts, make, tree: `${realpathSync(cwd)}.worker` };
}
// cli.mjs's applyReload: the new code's load, then reloaded. Resolves to the error, or null.
async function applyReload(ctx) {
  const next = await import('../src/ui.mjs');
  try { Object.assign(ctx, await next.load(ctx, '')); ctx.ui = next; await next.reloaded(ctx); return null; }
  catch (err) { return err.message; }
}
// Everything a refused Reload must leave as it was: the shared workshop (the same object and the
// same value in every field, no lanes) and each context's code, worker, room and worktree setting.
function before(contexts) {
  const shop = contexts[0].shop;
  return { shop, fields: { ...shop }, per: contexts.map((c) => [c.ui, c.worker, c.room, c.workerDir, c.shop]) };
}
function unchanged(contexts, was) {
  const shop = contexts[0].shop;
  assert.equal(shop, was.shop);
  assert.deepEqual(Object.keys(shop).sort(), Object.keys(was.fields).sort());
  for (const [k, v] of Object.entries(was.fields)) assert.equal(shop[k], v, k);
  assert.equal(shop.lanes, undefined);
  contexts.forEach((c, i) => was.per[i].forEach((v, j) => assert.equal([c.ui, c.worker, c.room, c.workerDir, c.shop][j], v)));
}
const refusal = async (contexts) => {
  const { UPDATE_NEEDS_RESTART } = await import('../src/ui.mjs');
  assert.equal(UPDATE_NEEDS_RESTART, 'This update changes the worker\'s queues: Restart to apply it (Reload can\'t).');
  for (const c of contexts) assert.equal(await applyReload(c), UPDATE_NEEDS_RESTART); // every room
};

test('Reload from the code before lanes is refused, before anything changes, idle or busy; the tasks then go on under that code', async (t) => {
  const old = await codeBeforeLanes();
  if (!old) return t.skip(`commit ${BEFORE_LANES.slice(0, 7)} (the code before lanes) is not in this repository`);
  const gates = [];
  const { contexts: [ctx], tree } = await folderBeforeLanes(old, 1, (c, p) => (p.endsWith('wait') ? new Promise((r) => gates.push(r)) : 'ok'));
  // Idle.
  let was = before([ctx]);
  await refusal([ctx]);
  unchanged([ctx], was);
  old.queueWork(ctx, 'on the old code'); await ctx.workQueue;
  assert.deepEqual(ctx.prompts, ['on the old code']);
  // Busy: one task running, one queued.
  old.queueWork(ctx, 'first, wait'); old.queueWork(ctx, 'second, wait');
  await until(() => gates.length === 1);
  assert.deepEqual([ctx.shop.running?.text, ctx.shop.tasks.map((x) => x.text)], ['first, wait', ['second, wait']]);
  was = before([ctx]);
  await refusal([ctx]);
  unchanged([ctx], was);
  gates[0]('done'); await until(() => gates.length === 2); gates[1]('done'); await ctx.workQueue;
  assert.deepEqual([ctx.prompts, ctx.shop.running, ctx.shop.tasks.length, ctx.workerDir.path === tree], [['on the old code', 'first, wait', 'second, wait'], null, 0, true]);
});

test('Reload from the code before lanes is refused with a hold over uncommitted edits, or after a failed worktree inspection; the hold and the wait go on under that code', async (t) => {
  const old = await codeBeforeLanes();
  if (!old) return t.skip(`commit ${BEFORE_LANES.slice(0, 7)} (the code before lanes) is not in this repository`);
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { contexts: [a, b], git, tree } = await folderBeforeLanes(old, 2, (c, p) => {
    if (p.endsWith('leave edits')) writeFileSync(`${c.workerDir.path}/wip.txt`, 'half done\n');
    return 'ok';
  });
  // A hold: a's task left edits; b's task waits for them to be resolved.
  old.queueWork(a, 'leave edits'); await a.workQueue;
  const hold = a.shop.blockedBy;
  assert.equal(hold.origin, a);
  let ran = false;
  old.queueWork(b, 'after the edits'); b.workQueue.then(() => { ran = true; });
  let was = before([a, b]);
  await refusal([a, b]);
  unchanged([a, b], was);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([ran, a.shop.blockedBy, git('-C', tree, 'status', '--porcelain')], [false, hold, '?? wip.txt']);
  git('-C', tree, 'add', 'wip.txt'); git('-C', tree, 'commit', '-q', '-m', 'resolved by hand');
  await b.workQueue; // 1a's own recheck releases it
  assert.deepEqual([b.prompts, a.shop.blockedBy], [['after the edits'], null]);
  // A failed inspection: the worktree can't be read; the task waits.
  const index = `${git('-C', tree, 'rev-parse', '--absolute-git-dir')}/index`, saved = readFileSync(index);
  writeFileSync(index, 'bad');
  let done = false;
  try {
    old.queueWork(b, 'while unreadable'); b.workQueue.then(() => { done = true; });
    await eventually(() => a.shop.inspectionError);
    was = before([a, b]);
    await refusal([a, b]);
    unchanged([a, b], was);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(done, false);
  } finally { writeFileSync(index, saved); }
  await b.workQueue; // readable again: 1a's recheck lets it run
  assert.deepEqual([b.prompts.at(-1), a.shop.inspectionError], ['while unreadable', null]);
});

test('Reload from the code before lanes with two or three open discussions is refused in each, and a discussion opened beside is refused too; their tasks run one at a time in 1a\'s worktree, and a fresh start loads the new code', async (t) => {
  const old = await codeBeforeLanes();
  if (!old) return t.skip(`commit ${BEFORE_LANES.slice(0, 7)} (the code before lanes) is not in this repository`);
  const { realpathSync } = await import('node:fs');
  const { load: loadNew, queueWork, UPDATE_NEEDS_RESTART, workerLane } = await import('../src/ui.mjs');
  for (const n of [2, 3]) {
    const gates = new Map(), running = [];
    let overlap = false;
    const { contexts, hub, make, tree, cwd } = await folderBeforeLanes(old, n, (c, p) => {
      if (running.length) overlap = true;
      running.push(c);
      return new Promise((r) => gates.set(c, () => { running.splice(running.indexOf(c), 1); r('done'); }));
    });
    const was = before(contexts);
    await refusal(contexts);
    unchanged(contexts, was);
    // A discussion opened beside them meanwhile (addRoom with the new code): refused, nothing attached.
    await assert.rejects(make(`d${n}`, await import('../src/ui.mjs')), new Error(UPDATE_NEEDS_RESTART));
    assert.equal(hub.rooms.size, n);
    unchanged(contexts, was);
    // A task to each discussion that didn't switch: 1a's one queue runs them one at a time, in 1a's worktree.
    const others = contexts.slice(1);
    for (const c of others) old.queueWork(c, `from ${c.context}`);
    for (const c of others) { await until(() => gates.has(c)); assert.equal(realpathSync(c.workerDir.path), tree); gates.get(c)(); await c.workQueue; }
    assert.deepEqual([overlap, others.map((c) => c.prompts)], [false, others.map((c) => [`from ${c.context}`])]);

    // After Restart (a fresh start in that folder), the new code loads normally: lanes, its own queue.
    const fresh = { cwd, hub: { rooms: new Map() }, key: realpathSync(cwd), agentSpecs: 'claude:A', workerSpec: 'claude:W', noScreen: true,
      state: { transcript: [], seen: new Map() }, sessions: new Map() };
    fresh.hub.rooms.set(fresh.key, fresh);
    Object.assign(fresh, await loadNew(fresh, ''));
    fresh.worker.turn = async () => 'new code';
    assert.ok(fresh.shop.lanes instanceof Map);
    queueWork(fresh, 'after Restart'); await fresh.workQueue;
    assert.equal(workerLane(fresh).blockedBy, null);
    assert.ok(fresh.shop.log.some((m) => m.speaker === 'W' && /new code/.test(m.html)));
  }
});

test('the header\'s version: the checkout\'s commit and uncommitted changes, outside discussions/, as a snapshot', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { codeInfo } = await import('../src/ui.mjs');
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/ar-code-`));
  assert.deepEqual(await codeInfo(dir), { path: dir, branch: null, commit: null, dirty: false }); // not in Git
  const git = await gitRoom(dir);
  const commit = git('rev-parse', '--short', 'HEAD');
  assert.deepEqual(await codeInfo(dir), { path: dir, branch: 'main', commit, dirty: false });
  mkdirSync(`${dir}/discussions`);
  writeFileSync(`${dir}/discussions/notes.md`, 'x');
  assert.equal((await codeInfo(dir)).dirty, false); // discussions hold no code
  writeFileSync(`${dir}/code.mjs`, 'x');
  assert.equal((await codeInfo(dir)).dirty, true);
});

test('Reload adds its own snapshot of the checkout to the header, keeping the start\'s', async () => {
  const { reloaded } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  const start = { path: '/x', branch: 'main', commit: 'abc1234', dirty: false, startedAt: '2026-11-07T12:28:00.000Z' };
  ctx.code = { ...start };
  ctx.refreshQuota = () => {};
  reloaded(ctx);
  await until(() => ctx.screen.room.code?.reloaded);
  const { reloaded: r, ...kept } = ctx.screen.room.code;
  assert.deepEqual(kept, start);
  assert.match(r.commit, /^[0-9a-f]{7,}$/);
  assert.equal(typeof r.dirty, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(r.at)));
});

test('a worker task keeps the discussion it started in, even if New discussion comes while it prepares its worktree', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  ctx.noScreen = true; // terminal mode: one discussion at a time (on the screen, see "Several open discussions")
  await gitRoom(ctx.cwd);
  let finish;
  ctx.worker.turn = (p) => { got.push(p); return new Promise((done) => { finish = done; }); };
  await handleLine('hello', ctx);
  const first = ctx.discussion, transcript = ctx.logPath;
  queueWork(ctx, 'the task');
  await until(() => ctx.screen.working); // started: now preparing its worktree (Git calls)
  await handleLine('/new', ctx); // the room's discussion changes before the task's first turn
  assert.equal(ctx.discussion, null);
  await until(() => finish);
  assert.match(got[0], new RegExp(`^\\[your reported usage this session: [^\\]]+\\]\\n\\nThe active discussion's folder is ${first.dir}: `)); // its own, not "no discussion"
  await markClosed(ctx.cwd, first.name);
  await handleLine(`/move ${first.name} archive`, ctx); // still locked by the task
  assert.match(ctx.notes.at(-1), /A worker task is still writing to/);
  finish('done');
  await ctx.workQueue;
  assert.match(readFileSync(transcript, 'utf8'), /the task[\s\S]*session ended[\s\S]*done/);
  await handleLine(`/move ${first.name} archive`, ctx);
  assert.ok(existsSync(`${ctx.cwd}/discussions/archive/${first.name}`));
});

test('the worker is told about its scratch notes; .worker-notes is ignored by Git in its worktree', async () => {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { ctx, got } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  await work(ctx, 'do it');
  const path = `${realpathSync(ctx.cwd)}.worker`;
  assert.match(got[0], new RegExp(`Your scratch notes go in ${path}/\\.worker-notes/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted"`));
  mkdirSync(`${path}/.worker-notes/stage-a`, { recursive: true });
  writeFileSync(`${path}/.worker-notes/stage-a/scratch.md`, 'x\n');
  assert.equal(git('-C', path, 'status', '--porcelain'), '');
  await work(ctx, 'again'); // listed once, not again
  const exclude = git('-C', path, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(exclude, 'utf8').split('\n').filter((l) => l === '.worker-notes/').length, 1);
});

test("the worker's worktree links the room's node_modules and ignores the link", async () => {
  const { mkdirSync, writeFileSync, realpathSync, lstatSync } = await import('node:fs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  mkdirSync(`${ctx.cwd}/node_modules`, { recursive: true });
  writeFileSync(`${ctx.cwd}/node_modules/a-package.js`, 'x\n');
  await work(ctx, 'do it');
  const path = `${realpathSync(ctx.cwd)}.worker`;
  assert.ok(lstatSync(`${path}/node_modules`).isSymbolicLink());
  assert.equal(realpathSync(`${path}/node_modules`), realpathSync(`${ctx.cwd}/node_modules`));
  assert.equal(git('-C', path, 'status', '--porcelain'), '');
});


test('worker switches after a running failure, carries history, and retains its session on model changes', async () => {
  const { queueWork, saveSettings } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  await gitRoom(ctx.cwd);
  ctx.workerSpec = 'claude:W';
  ctx.sessions = new Map();
  let release, began;
  const started = new Promise((resolve) => { began = resolve; });
  ctx.worker.turn = async () => {
    began();
    await new Promise((resolve) => { release = resolve; });
    throw new Error('quota exhausted');
  };
  queueWork(ctx, 'implement the feature');
  await started;
  const settings = { agents: ctx.room.agents.map((a) => ({ name: a.name, provider: 'claude', model: '' })),
    worker: { name: 'W', provider: 'codex', model: 'model-one' } };
  const file = `${ctx.cwd}/defaults.json`;
  await saveSettings(ctx, settings, file);
  const session = ctx.sessions.get('worker:W');
  session.threadId = 'new-provider-thread';
  assert.equal(ctx.worker.provider, 'codex');
  assert.equal(ctx.screen.working, 'W');
  release();
  await ctx.workQueue;
  assert.equal(ctx.workerHandoff, true);
  assert.equal(ctx.workerTree, null); // the old task cannot mark the new session briefed
  let prompt;
  ctx.worker.turn = async (p) => { prompt = p; return 'completed'; };
  queueWork(ctx, 'retry the feature');
  await ctx.workQueue;
  assert.match(prompt, /Previous Worker-tab conversation/);
  assert.match(prompt, /implement the feature/);
  assert.match(prompt, /quota exhausted/);
  assert.match(prompt, /Your working directory is/);
  assert.match(prompt, /Current instruction:\nretry the feature$/);
  assert.equal(ctx.workerHandoff, false);
  await saveSettings(ctx, { ...settings, worker: { ...settings.worker, model: 'model-two' } }, file);
  assert.equal(ctx.workerSpec, 'codex:W:model-two');
  assert.equal(ctx.sessions.get('worker:W'), session);
  assert.equal(session.threadId, 'new-provider-thread');
});

test('Switch room lists this server\'s rooms, with the pages open on each and which one is asking', async () => {
  const { listRooms } = await import('../src/ui.mjs');
  const room = (cwd, id, pages) => ({ cwd, id, screen: { clients: new Set(Array(pages).fill(0).map((_, i) => i)), room: { active: null } } });
  const a = room('/tmp/b-room', 'b-room-111111', 2), b = room('/tmp/a-room', 'a-room-222222', 0);
  const hub = { rooms: new Map([['/tmp/b-room', a], ['/tmp/a-room', b]]) };
  a.hub = b.hub = hub;
  assert.deepEqual(listRooms(b), [
    { id: 'a-room-222222', path: '/r/a-room-222222/__room', root: '/tmp/a-room', discussion: null, pages: 0, current: true },
    { id: 'b-room-111111', path: '/r/b-room-111111/__room', root: '/tmp/b-room', discussion: null, pages: 2, current: false },
  ]);
});

// ── Checkpoints (continue by default) ──
// Where a room's discussion saves itself (npm test runs with a temporary HOME).
async function checkpointPath(cwd, name) {
  const { createHash } = await import('node:crypto');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { realpathSync } = await import('node:fs');
  return join(homedir(), '.local', 'state', 'agent-room', 'paused',
    createHash('sha256').update(realpathSync(cwd)).digest('hex'), createHash('sha256').update(name).digest('hex') + '.json');
}
async function markClosed(cwd, name) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, basename, join } = await import('node:path');
  const checkpoint = await checkpointPath(cwd, name);
  const dir = join(dirname(checkpoint), 'closed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, basename(checkpoint, '.json')), name);
}
// A loaded room (real agents' adapters, their turns scripted), in terminal mode.
async function savedRoom(cwd, tag) {
  const ctx = { ...freshCtx(), cwd, workerSpec: 'claude:W', noScreen: true };
  Object.assign(ctx, await load(ctx, `?${tag}`));
  ctx.suggestTitle = async () => ({ title: 'Saved context' });
  for (const agent of ctx.room.agents) agent.turn = async () => 'PASS';
  // Close's writer, in place of a real CLI: it answers as the room's last agent is scripted to.
  ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) });
  return ctx;
}

// ── A worker session per discussion, in the terminal too (slice 1c) ──
test('terminal: /new while a worker task runs, a task in the new discussion, then Resume of the first: each report reaches its own discussion, and each continues its own worker session', async () => {
  const { readFileSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('own-session-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'own-session');
  const titles = ['Topic A', 'Topic B'];
  ctx.suggestTitle = async () => ({ title: titles.shift() });
  const key = 'worker:W', calls = [];
  let release = null;
  // The worker agent in use answers as `tag`; with `wait`, only once released.
  const stub = (tag, wait = false) => { ctx.worker.turn = async () => { calls.push(tag); return wait ? new Promise((r) => { release = () => r(`${tag} report`); }) : `${tag} report`; }; };
  const saved = (d) => checkpointPath(cwd, d.name).then((f) => JSON.parse(readFileSync(f, 'utf8')));
  const codex = (id) => Object.assign(ctx.sessions.get('B'), { threadId: id }); // a real Codex turn sets it
  codex('codex-a');
  await handleLine('first topic', ctx);
  const a = ctx.discussion, aLog = ctx.logPath;
  Object.assign(ctx.sessions.get(key), { id: 'worker-a', started: true });
  stub('A', true);
  queueWork(ctx, 'task in A');
  await until(() => release);

  await handleLine('/new', ctx); // returns at once: A's task goes on in A's session
  assert.equal(ctx.discussion, null);
  assert.notEqual(ctx.sessions.get(key).id, 'worker-a');
  stub('B');
  codex('codex-b');
  await handleLine('second topic', ctx);
  const b = ctx.discussion, bLog = ctx.logPath;
  Object.assign(ctx.sessions.get(key), { id: 'worker-b', started: true });
  queueWork(ctx, 'task in B'); // waits behind A's: one context's worker tasks run one at a time
  release();
  await ctx.workQueue;
  assert.deepEqual(calls, ['A', 'B']);
  const A = readFileSync(aLog, 'utf8'), B = readFileSync(bLog, 'utf8');
  assert.match(A, /task in A[\s\S]*session ended[\s\S]*A report/);
  assert.doesNotMatch(A, /task in B|B report/);
  assert.match(B, /task in B[\s\S]*B report/);
  assert.doesNotMatch(B, /task in A|A report/);
  // A's checkpoint has A's worker session and A's report; B's in-memory session is untouched.
  assert.equal(new Map((await saved(a)).sessions).get(key).id, 'worker-a');
  assert.ok((await saved(a)).worker.some((m) => m.speaker === 'W' && /A report/.test(m.html)));
  assert.equal(ctx.sessions.get(key).id, 'worker-b');

  await handleLine(`/resume ${a.name}`, ctx); // back to A: its own worker session
  assert.equal(ctx.sessions.get(key).id, 'worker-a');
  assert.equal(new Map((await saved(b)).sessions).get(key).id, 'worker-b'); // B keeps its own
  stub('A again');
  queueWork(ctx, 'more in A'); await ctx.workQueue;
  assert.match(readFileSync(aLog, 'utf8'), /more in A[\s\S]*A again report/);
  await handleLine(`/resume ${b.name}`, ctx); // and B continues its own
  assert.equal(ctx.sessions.get(key).id, 'worker-b');
});

test('terminal: a task that leaves edits after the room switched holds its own discussion\'s worktree, named for it; only that discussion\'s instructions resolve it; and its usage counts for it', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { queueWork, workerHold } = await import('../src/ui.mjs');
  const cwd = await tmp('own-hold-');
  const git = await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'own-hold');
  const titles = ['Topic A', 'Topic B'];
  ctx.suggestTitle = async () => ({ title: titles.shift() });
  const prompts = [];
  let release = null, tree = null;
  // The worker in use answers as `tag`; A's first task leaves edits and reports its usage.
  const stub = (tag, wait = false) => {
    const w = ctx.worker;
    w.turn = async (p) => {
      prompts.push([tag, p]);
      if (!wait) return `${tag} report`;
      tree = ctx.workerDir.path;
      writeFileSync(`${tree}/wip.txt`, 'half done\n');
      return new Promise((r) => { release = () => { w.lastUsage = { input: 100, cached: 0, output: 7 }; r(`${tag} report`); }; });
    };
  };
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-a' });
  await handleLine('first topic', ctx);
  const a = ctx.discussion.name;
  stub('A', true);
  queueWork(ctx, 'edit things in A');
  await until(() => release);
  await handleLine('/new', ctx);
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-b' });
  stub('B');
  await handleLine('second topic', ctx);
  const b = ctx.discussion.name;
  ctx.totals.W = { input: 1, cached: 0, output: 1 }; // B's own
  queueWork(ctx, 'task in B'); // queued behind A's (one context, one task at a time)
  release();
  await ctx.workQueue;

  // The hold names A and A's worktree, though B is the discussion in use.
  const held = workerLane(ctx, a).blockedBy;
  assert.deepEqual([held.label, held.owner, held.task, held.place.lane, git('-C', tree, 'status', '--porcelain')], [a, a, 'edit things in A', a, '?? wip.txt']);
  assert.equal(workerLane(ctx, b).blockedBy, null); // B's queue isn't held
  const [, bPrompt] = prompts.find(([tag]) => tag === 'B');
  assert.ok(!bPrompt.includes('Uncommitted edits are left'));
  assert.ok(!bPrompt.includes(tree));
  assert.equal(workerHold(ctx), null); // B can be closed: the edits are A's
  // A's usage went to A's checkpoint, not to B's totals.
  const saved = JSON.parse(readFileSync(await checkpointPath(cwd, a), 'utf8'));
  assert.deepEqual([saved.totals.W?.input, saved.totals.W?.output], [100, 7]);
  assert.deepEqual(ctx.totals.W, { input: 1, cached: 0, output: 1 });

  // Back in A: its own instruction resolves the edits, told of A's task.
  await handleLine(`/resume ${a}`, ctx);
  assert.deepEqual([ctx.totals.W?.input, ctx.totals.W?.output], [100, 7]);
  ctx.worker.turn = async (p) => { prompts.push(['A again', p]); git('-C', tree, 'add', 'wip.txt'); git('-C', tree, 'commit', '-q', '-m', `[${a}] finished`); return `resolved\nDocs: none needed, because test.\nTested: ${git('-C', tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`; };
  queueWork(ctx, 'finish it'); await ctx.workQueue;
  assert.match(prompts.at(-1)[1], new RegExp(`Uncommitted edits are left in your worktree from the earlier task from \\[${a}\\] "edit things in A"`));
  assert.equal(workerLane(ctx, a).blockedBy, null);
});

test('no worker sends from a brainstorm, before or after its first message, on the screen or in the terminal; once turned into a discussion, its work goes to its own lane', async () => {
  const { realpathSync } = await import('node:fs');
  const { queueWork, BRAINSTORM_NO_WORK } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  const root = realpathSync(ctx.cwd);
  assert.equal(BRAINSTORM_NO_WORK, 'Turn this brainstorm into a discussion to send work.');
  await handleLine('/brainstorm', ctx);
  queueWork(ctx, 'before its first message');
  await handleLine('an idea', ctx);
  queueWork(ctx, 'after it');
  assert.deepEqual(got, []);
  assert.equal(ctx.workQueue, undefined); // nothing was ever queued
  assert.deepEqual(workerLane(ctx, null).tasks, []);
  assert.equal(ctx.notes.filter((n) => /^✗ Turn this brainstorm into a discussion to send work\. The instruction was not sent\.$/.test(n)).length, 2);
  // Auto dev, which relays to the worker, doesn't start either.
  ctx.say = () => {};
  ctx.state.transcript.push({ speaker: 'Summary', text: '**Next step**\n- Send to the Worker: "go"', outcome: 'agreed', by: 'A' });
  await handleLine('/autodev', ctx);
  assert.equal(ctx.autoDev, undefined);
  const name = ctx.discussion.name;
  await handleLine(`/convert brainstorms/${name}`, ctx);
  await work(ctx, 'now as a discussion');
  assert.equal(got.length, 1);
  assert.equal(ctx.workerDir.path, `${root}.workers/${name}`);
  assert.equal(git('-C', ctx.workerDir.path, 'rev-parse', '--abbrev-ref', 'HEAD'), `worker/${name}`);
  assert.match(got[0], new RegExp(`These instructions come from \\[${name}\\]`));
});

test('terminal: a brainstorm\'s worker session is never carried into a discussion, by New discussion or Resume', async () => {
  const { mkdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  ctx.noScreen = true;
  await handleLine('/brainstorm', ctx);
  const brainstorm = ctx.worker;
  await handleLine('/new', ctx);
  assert.notEqual(ctx.worker, brainstorm);
  assert.equal(brainstorm.seat.brainstorm, true);
  await handleLine('/brainstorm', ctx);
  const again = ctx.worker;
  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`, { recursive: true });
  await handleLine('/resume 2026-11-01-old', ctx); // no checkpoint: a fresh session from its handoff
  assert.notEqual(ctx.worker, again);
  assert.equal(again.seat.brainstorm, true);
});

test('terminal: Start fresh while the discussion\'s old worker task still runs: its report goes to the old session\'s transcript, and neither its report nor its checkpoint update replaces the new worker session', async () => {
  const { readFileSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('fresh-session-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'fresh-session');
  const key = 'worker:W';
  let release = null;
  const stub = (tag, wait = false) => { ctx.worker.turn = async () => (wait ? new Promise((r) => { release = () => r(`${tag} report`); }) : `${tag} report`); };
  const saved = () => checkpointPath(cwd, name).then((f) => JSON.parse(readFileSync(f, 'utf8')));
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-old' }); // a real Codex turn sets it
  await handleLine('the topic', ctx);
  const name = ctx.discussion.name, oldLog = ctx.logPath;
  Object.assign(ctx.sessions.get(key), { id: 'worker-old', started: true });
  stub('old', true);
  queueWork(ctx, 'old task');
  await until(() => release);

  await handleLine(`/fresh ${name}`, ctx); // returns at once
  assert.notEqual(ctx.sessions.get(key).id, 'worker-old');
  stub('new');
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-new' });
  await handleLine('start again', ctx); // the fresh session's first round: a full checkpoint, with the new session
  Object.assign(ctx.sessions.get(key), { id: 'worker-new', started: true });
  queueWork(ctx, 'new task'); // waits behind the old one (one context, one task at a time)
  release();
  await ctx.workQueue;
  const newLog = ctx.logPath;
  assert.notEqual(newLog, oldLog);
  assert.match(readFileSync(oldLog, 'utf8'), /old task[\s\S]*session ended[\s\S]*old report/); // the old session's transcript
  assert.doesNotMatch(readFileSync(newLog, 'utf8'), /old task|old report/);
  assert.match(readFileSync(newLog, 'utf8'), /new task[\s\S]*new report/);
  assert.equal(ctx.sessions.get(key).id, 'worker-new');
  assert.equal(new Map((await saved()).sessions).get(key).id, 'worker-new');
  // Leaving and resuming continues the new session, not the old one.
  await handleLine('/new', ctx);
  await handleLine(`/resume ${name}`, ctx);
  assert.equal(ctx.sessions.get(key).id, 'worker-new');
});

test('Close writes a statement and drops saved provider IDs only after the agents finish', async () => {
  const { readFileSync } = await import('node:fs');
  const cwd = await tmp('close-statement-');
  const ctx = await savedRoom(cwd, 'close-statement');
  Object.assign(ctx.sessions.get('B'), { threadId: 'prior-thread' });
  Object.assign(ctx.sessions.get('A'), { id: 'prior-agent', started: true });
  Object.assign(ctx.sessions.get('worker:W'), { id: 'prior-worker', started: true });
  const sessions = [...ctx.sessions.values()];
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion;
  for (const a of ctx.room.agents) a.turn = async () => 'Decisions and pending-instructions.md';
  await handleLine('/close', ctx);
  assert.match(readFileSync(`${dir}/closing-statement.md`, 'utf8'), /pending-instructions\.md/);
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
  assert.deepEqual(JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8')).sessions, []);
  assert.ok(sessions.every((session) => !['prior-agent', 'prior-thread', 'prior-worker'].includes(session.id ?? session.threadId ?? session.conversationId)));
  await handleLine('/resume ' + name, ctx);
  assert.ok(!ctx.screen.room.closedDiscussions.includes(name));
  assert.notEqual(ctx.sessions.get('A').id, 'prior-agent');
  assert.notEqual(ctx.sessions.get('B').threadId, 'prior-thread');
  assert.notEqual(ctx.sessions.get('worker:W').id, 'prior-worker');
  const prompts = [];
  for (const agent of ctx.room.agents) agent.turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('continue', ctx);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => p.includes('Decisions and pending-instructions.md')));
});

test('Close asks one agent with the worker\'s settings for the statement, never the discussion agents', async () => {
  const { readFileSync } = await import('node:fs');
  const ctx = await savedRoom(await tmp('close-writer-'), 'close-writer');
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion;
  for (const agent of ctx.room.agents) agent.turn = async () => { throw new Error('a discussion agent was asked'); };
  const prompts = [];
  ctx.closingAgent = () => ({ name: 'W', turn: async (p) => { prompts.push(p); return 'Statement: pending-instructions.md'; } });
  const notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, event) => { if (event.type === 'note') notes.push(event.text); } };
  await handleLine('/close', ctx);
  // The system messages say who writes the statement: the worker's provider and model (claude:W, CLI default).
  assert.ok(notes.includes(`Closing ${name}: Claude (Claude default) is writing the closing statement…`));
  assert.equal(notes.at(-1), `Closed ${name}. Closing statement written by Claude (Claude default).`);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /The User is closing this discussion\./);
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
  assert.equal(readFileSync(`${dir}/closing-statement.md`, 'utf8'), 'Statement: pending-instructions.md\n');
});

test('Close waits for queued work, refuses instructions and can be cancelled', async () => {
  const { cancelClose, queueWork } = await import('../src/ui.mjs');
  const ctx = await savedRoom(await tmp('close-wait-'), 'close-wait');
  await handleLine('decide', ctx);
  const name = ctx.discussion.name, lane = workerLane(ctx, name);
  const queued = { owner: name, origin: ctx };
  lane.tasks.push(queued);
  const closing = handleLine('/close', ctx);
  assert.deepEqual(ctx.screen.room.closingDiscussions, { [name]: 'waiting' });
  queueWork(ctx, 'not accepted');
  assert.deepEqual(lane.tasks, [queued]);
  assert.equal(cancelClose(ctx, name), true);
  await closing;
  assert.deepEqual(ctx.screen.room.closingDiscussions, {});
  assert.equal(ctx.discussion.name, name);
  assert.deepEqual(ctx.screen.room.closedDiscussions, []);
  lane.tasks.length = 0;
});

test('Close reports waiting then writing phases in room.closingDiscussions, and cancelClose works only while waiting', async () => {
  const { cancelClose } = await import('../src/ui.mjs');
  const ctx = await savedRoom(await tmp('close-phases-'), 'close-phases');
  await handleLine('decide', ctx);
  const name = ctx.discussion.name, lane = workerLane(ctx, name);
  let finishTask, startWriting, finishWriting;
  const writingStarted = new Promise((r) => { startWriting = r; });
  const writingDone = new Promise((r) => { finishWriting = r; });
  const taskDone = new Promise((r) => { finishTask = r; });
  const queued = { owner: name, origin: ctx, finished: taskDone };
  lane.tasks.push(queued);
  ctx.closingAgent = () => ({
    name: 'W',
    turn: async () => {
      startWriting();
      await writingDone;
      return 'Statement: pending-instructions.md';
    },
  });
  const closing = handleLine('/close', ctx);
  assert.deepEqual(ctx.screen.room.closingDiscussions, { [name]: 'waiting' });
  lane.tasks.length = 0;
  finishTask();
  await writingStarted;
  assert.deepEqual(ctx.screen.room.closingDiscussions, { [name]: 'writing' });
  assert.equal(cancelClose(ctx, name), false);
  finishWriting();
  await closing;
  assert.deepEqual(ctx.screen.room.closingDiscussions, {});
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
});

test('a reopened discussion retains its statement briefing across restart before its first message', async () => {
  const cwd = await tmp('reopen-restart-');
  const ctx = await savedRoom(cwd, 'reopen-restart-1');
  ctx.sessions.get('B').threadId = 'before-close';
  await handleLine('decide', ctx);
  const name = ctx.discussion.name;
  for (const agent of ctx.room.agents) agent.turn = async () => 'reopen context: pending-instructions.md';
  await handleLine('/close', ctx);
  await handleLine('/resume ' + name, ctx);
  const after = await savedRoom(cwd, 'reopen-restart-2');
  await handleLine('/resume ' + name, after);
  const prompts = [];
  for (const agent of after.room.agents) agent.turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('continue', after);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => p.includes('reopen context: pending-instructions.md')));
});

test('a reopened discussion without a closing statement starts from its pending handoff', async () => {
  const { unlinkSync, writeFileSync } = await import('node:fs');
  const ctx = await savedRoom(await tmp('reopen-handoff-'), 'reopen-handoff');
  ctx.sessions.get('B').threadId = 'before-close';
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion;
  for (const agent of ctx.room.agents) agent.turn = async () => 'statement: pending-instructions.md';
  await handleLine('/close', ctx);
  unlinkSync(`${dir}/closing-statement.md`);
  writeFileSync(`${dir}/handoff.md`, 'Pending handoff');
  await handleLine('/resume ' + name, ctx);
  const prompts = [];
  for (const agent of ctx.room.agents) agent.turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('continue', ctx);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => p.includes('Start from its handoff')));
});

test('Close waits for running and queued worker reports before asking the agents', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => ({ title: 'Worker reports' }));
  ctx.noScreen = true;
  await gitRoom(ctx.cwd);
  await handleLine('decide', ctx);
  let finish;
  ctx.worker.turn = async (p) => p.endsWith('first task') ? new Promise((r) => { finish = r; }) : 'second report';
  const prompts = [];
  ctx.closingAgent = () => ({ name: 'W', turn: async (p) => { prompts.push(p); return 'statement pending-instructions.md'; } });
  queueWork(ctx, 'first task');
  await until(() => finish);
  queueWork(ctx, 'second task');
  const closing = handleLine('/close', ctx);
  assert.equal(prompts.length, 0);
  finish('first report');
  await closing;
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /first report/);
  assert.match(prompts[0], /second report/);
  assert.ok(ctx.screen.room.closedDiscussions.length);
});

test('closing a discussion does not stop an earlier discussion\'s detached worker', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async (text) => ({ title: text }));
  ctx.noScreen = true;
  await gitRoom(ctx.cwd);
  await handleLine('first', ctx);
  let finish;
  ctx.worker.turn = () => new Promise((r) => { finish = r; });
  queueWork(ctx, 'work on first');
  await until(() => finish);
  await handleLine('/new', ctx);
  await handleLine('second', ctx);
  for (const agent of ctx.room.agents) agent.turn = async () => 'statement pending-instructions.md';
  await handleLine('/close', ctx);
  assert.equal(ctx.discussion, null);
  finish('finished first');
  await ctx.workQueue;
  assert.ok(ctx.screen.worker.some((m) => m.html?.includes('finished first')));
});

test('a failed statement leaves the previous file and discussion intact for a retry', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const ctx = await savedRoom(await tmp('close-retry-'), 'close-retry');
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion, file = `${dir}/closing-statement.md`;
  writeFileSync(file, 'previous statement\n');
  ctx.room.agents[0].turn = async () => 'partial: pending-instructions.md';
  ctx.room.agents[1].turn = async () => { throw new Error('agent failed'); };
  await handleLine('/close', ctx);
  assert.equal(readFileSync(file, 'utf8'), 'previous statement\n');
  assert.equal(ctx.discussion.name, name);
  assert.deepEqual(ctx.screen.room.closedDiscussions, []);
  ctx.room.agents[1].turn = async () => 'complete: pending-instructions.md';
  await handleLine('/close', ctx);
  assert.equal(readFileSync(file, 'utf8'), 'complete: pending-instructions.md\n');
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
});

test('a failure persisting Close restores the statement, checkpoint and provider IDs', async () => {
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { dirname, basename, join } = await import('node:path');
  const ctx = await savedRoom(await tmp('close-storage-failure-'), 'close-storage-failure');
  Object.assign(ctx.sessions.get('A'), { id: 'keep-agent', started: true });
  Object.assign(ctx.sessions.get('B'), { threadId: 'keep-thread' });
  Object.assign(ctx.sessions.get('worker:W'), { id: 'keep-worker', started: true });
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion, checkpoint = await checkpointPath(ctx.cwd, name);
  const before = readFileSync(checkpoint, 'utf8');
  writeFileSync(`${dir}/closing-statement.md`, 'previous statement\n');
  mkdirSync(join(dirname(checkpoint), 'closed', basename(checkpoint, '.json')), { recursive: true });
  for (const agent of ctx.room.agents) agent.turn = async () => 'replacement: pending-instructions.md';
  await handleLine('/close', ctx);
  assert.equal(ctx.discussion.name, name);
  assert.equal(readFileSync(`${dir}/closing-statement.md`, 'utf8'), 'previous statement\n');
  assert.deepEqual(JSON.parse(readFileSync(checkpoint, 'utf8')), JSON.parse(before));
  assert.deepEqual([ctx.sessions.get('A').id, ctx.sessions.get('B').threadId, ctx.sessions.get('worker:W').id], ['keep-agent', 'keep-thread', 'keep-worker']);
  assert.deepEqual(ctx.screen.room.closedDiscussions, []);
});

test('a paused discussion can be closed without replacing the current discussion', async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const cwd = await tmp('close-paused-'), bin = `${cwd}/bin`;
  mkdirSync(bin);
  writeFileSync(`${bin}/claude`, '#!/bin/sh\nprintf \'%s\\n\' "{\\"result\\":\\"Claude draft pending-instructions.md\\"}"\n', { mode: 0o755 });
  const ctx = await savedRoom(cwd, 'close-paused');
  delete ctx.closingAgent;
  Object.assign(ctx.sessions.get('B'), { threadId: 'prior-thread' });
  await handleLine('decide', ctx);
  const { name, dir } = ctx.discussion;
  await handleLine('/new', ctx);
  await handleLine('second', ctx);
  const current = ctx.discussion.name;
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try { await handleLine(`/close ${name}`, ctx); }
  finally { process.env.PATH = path; }
  assert.equal(ctx.discussion.name, current);
  assert.ok(ctx.screen.room.closedDiscussions.includes(name));
  assert.match(readFileSync(`${dir}/closing-statement.md`, 'utf8'), /Claude draft pending-instructions\.md/);
});

test('closed state persists independently of checkpoints, and Resume clears it', async () => {
  const { mkdirSync } = await import('node:fs');
  const cwd = await tmp('closed-state-');
  const ctx = await savedRoom(cwd, 'closed-state-1');
  ctx.sessions.get('B').threadId = 'saved-thread';
  mkdirSync(`${cwd}/discussions/2026-01-01-old`, { recursive: true });
  await handleLine('hello', ctx);
  const name = ctx.discussion.name;
  assert.deepEqual(ctx.screen.room.closedDiscussions, []); // old and open discussions have no marker
  const restarted = await savedRoom(cwd, 'closed-state-2');
  await handleLine('/resume 2026-01-01-old', restarted);
  assert.deepEqual(restarted.screen.room.closedDiscussions, []); // an open discussion left behind is paused
  for (const agent of ctx.room.agents) agent.turn = async () => 'Statement: pending-instructions.md';
  await handleLine('/close', ctx);
  assert.deepEqual(ctx.screen.room.closedDiscussions, [name]);
  const after = await savedRoom(cwd, 'closed-state-3');
  await handleLine('/resume 2026-01-01-old', after);
  assert.deepEqual(after.screen.room.closedDiscussions, [name]);
  await handleLine('/resume ' + name, after);
  assert.deepEqual(after.screen.room.closedDiscussions, []);
  const again = await savedRoom(cwd, 'closed-state-4');
  await handleLine('/resume 2026-01-01-old', again);
  assert.deepEqual(again.screen.room.closedDiscussions, []);
});

test('every round saves a checkpoint; a corrupt or missing-session checkpoint leaves the file and room intact; Resume continues the same sessions', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const ctx = await savedRoom(await tmp('checkpoint-test-'), 'checkpoint-unit');
  Object.assign(ctx.sessions.get('A'), { id: 'claude-original', started: true });
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-original' });
  Object.assign(ctx.sessions.get('worker:W'), { id: 'worker-original', started: true });
  ctx.totals.A = { input: 42, output: 10 };
  ctx.state.summaries = 3;
  await handleLine('Remember this', ctx);
  const name = ctx.discussion.name, file = await checkpointPath(ctx.cwd, name);
  const first = JSON.parse(readFileSync(file, 'utf8')); // written by the round, which had no summary
  assert.equal(new Map(first.sessions).get('A').id, 'claude-original');
  assert.equal(new Map(first.sessions).get('worker:W').id, 'worker-original');
  assert.deepEqual(first.state.transcript.map((m) => m.text), ['Remember this', 'PASS', 'PASS']);
  ctx.screen.worker.push({ speaker: 'W', html: '<p>Saved worker</p>', origin: name });
  await handleLine('And this', ctx); // the next round saves again, with this discussion's Worker tab
  const snapshot = readFileSync(file, 'utf8'), saved = JSON.parse(snapshot);
  assert.deepEqual(saved.worker.map((m) => m.html), ['<p>Saved worker</p>']);
  assert.equal(saved.state.transcript.length, 6);

  await handleLine('/new', ctx);
  assert.equal(ctx.discussion, null);
  assert.equal(readFileSync(file, 'utf8').length > 0 && JSON.parse(readFileSync(file, 'utf8')).state.transcript.length, 6); // kept
  assert.notEqual(ctx.sessions.get('A').id, 'claude-original'); // fresh agent sessions here
  const emptyState = ctx.state;
  writeFileSync(file, JSON.stringify({ ...saved, version: 999 }));
  await assert.rejects(handleLine('/resume ' + name, ctx), /checkpoint of .* is invalid/);
  assert.equal(ctx.state, emptyState);
  assert.equal(ctx.discussion, null);
  assert.equal(existsSync(file), true);
  writeFileSync(file, JSON.stringify({ ...saved, sessions: [] }));
  await assert.rejects(handleLine('/resume ' + name, ctx), /provider session.*missing/);
  assert.equal(ctx.state, emptyState);
  assert.equal(existsSync(file), true);
  writeFileSync(file, snapshot);
  await handleLine('/resume ' + name, ctx);
  assert.equal(ctx.sessions.get('A').id, 'claude-original');
  assert.equal(ctx.sessions.get('B').threadId, 'codex-original');
  assert.equal(ctx.sessions.get('worker:W').id, 'worker-original');
  assert.deepEqual(ctx.state.transcript, saved.state.transcript);
  assert.deepEqual([...ctx.state.seen], saved.state.seen);
  assert.equal(ctx.state.summaries, 3);
  assert.deepEqual(ctx.totals, saved.totals);
  assert.ok(ctx.screen.worker.some((m) => m.html === '<p>Saved worker</p>'));
  assert.equal(ctx.logPath, saved.logPath);
  assert.doesNotMatch(ctx.room.promptFor(ctx.room.agents[0]), /Remember this|And this/); // nothing sent again
  assert.equal(existsSync(file), true); // kept: the next round replaces it
});

test('Resume replaces a brainstorm only with a valid checkpoint; on the discussion in use it changes nothing; Start fresh asks twice and keeps only the latest summary', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const ctx = await savedRoom(await tmp('brainstorm-resume-test-'), 'brainstorm-resume');
  Object.assign(ctx.sessions.get('A'), { id: 'claude-original', started: true });
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-original' }); // a real Codex turn sets it
  await handleLine('Remember this', ctx);
  const name = ctx.discussion.name, file = await checkpointPath(ctx.cwd, name);
  const snapshot = readFileSync(file, 'utf8'), saved = JSON.parse(snapshot);
  await handleLine('/brainstorm', ctx);
  await handleLine('a brainstorm idea', ctx);
  const brainstorm = ctx.state, brainFolder = ctx.discussion;
  const said = ctx.state.transcript.map((m) => m.text);
  const intact = () => {
    assert.equal(ctx.state, brainstorm);
    assert.equal(ctx.state.brainstorm, true);
    assert.deepEqual(ctx.state.transcript.map((m) => m.text), said);
    assert.equal(ctx.screen.room.brainstorm, true);
    assert.equal(ctx.discussion, brainFolder);
  };
  // An invalid checkpoint: the error, and the brainstorm as it was.
  writeFileSync(file, JSON.stringify({ ...saved, version: 999 }));
  await assert.rejects(handleLine('/resume ' + name, ctx), /checkpoint of .* is invalid/);
  intact();
  writeFileSync(file, snapshot);
  // Replaced by the saved discussion.
  await handleLine('/resume ' + name, ctx);
  assert.equal(ctx.state.brainstorm, undefined);
  assert.equal(ctx.screen.room.brainstorm, false);
  assert.equal(ctx.discussion.name, name);
  assert.deepEqual(ctx.state.transcript, saved.state.transcript);
  assert.equal(ctx.sessions.get('A').id, 'claude-original');
  assert.equal(ctx.logPath, saved.logPath);

  // The discussion in use: Resume says so and changes nothing.
  await handleLine('carry on', ctx);
  const length = ctx.state.transcript.length;
  await handleLine('/resume ' + name, ctx);
  assert.deepEqual([ctx.discussion.name, ctx.state.transcript.length, ctx.sessions.get('A').id], [name, length, 'claude-original']);

  // Start fresh, from the page's own button: the first click only asks.
  const page = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('function resumeTip('), page.indexOf('const pendingArchives'));
  const sent = [];
  const freshButton = new Function('room', 'send', 'setTimeout', `${code}; return freshButton;`)(
    ctx.screen.room, (line) => sent.push(handleLine(line, ctx)), () => {});
  const button = { textContent: 'Start fresh', dataset: {} };
  freshButton(button, name);
  const click = () => button.onclick({ stopPropagation() {} });
  click();
  assert.equal(button.textContent, 'Click again: its saved sessions and chat are discarded; it starts from its handoff');
  assert.equal(sent.length, 0);
  click();
  assert.equal(sent.length, 1);
  await sent[0];
  assert.deepEqual([ctx.discussion.name, ctx.logPath, ctx.state.transcript.length], [name, null, 0]);
  assert.notEqual(ctx.sessions.get('A').id, 'claude-original');
  const left = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([left.fresh, left.summary, left.sessions, left.state], [true, null, undefined, undefined]); // no summary was agreed here
  assert.deepEqual(ctx.screen.room.checkpoints.find((c) => c.name === name).kind, 'fresh');
});

test('Start fresh briefs with the latest summary, marked if not agreed, or none; a Restart before the first message keeps it; the first round replaces it', async () => {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const cwd = await tmp('fresh-summary-test-');
  const ctx = await savedRoom(cwd, 'fresh-1');
  const script = ['an idea', 'PASS', '- the idea'];
  ctx.room.agents[0].turn = async () => script.shift() ?? 'PASS';
  await handleLine('hello', ctx); // A speaks, so the round is summarized: agreed, by A
  const name = ctx.discussion.name, file = await checkpointPath(cwd, name);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).state.transcript.at(-1), { speaker: 'Summary', text: '- the idea', outcome: 'agreed', by: 'A' });
  await handleLine('/fresh ' + name, ctx);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).summary, { text: '- the idea', outcome: 'agreed', by: 'A' });

  // Restart before the first message: a new process resumes it (as cli.mjs does with --reopen).
  const after = await savedRoom(cwd, 'fresh-2');
  const prompts = [];
  after.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('/resume ' + name, after);
  assert.ok(!after.logPath);
  await handleLine('go on', after);
  assert.match(prompts[0], /You are A, one of several AI agents/); // a fresh session
  assert.match(prompts[0], /Start from its handoff[\s\S]*The latest summary from the previous session \(agreed, by A\):\n\n- the idea/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).fresh, undefined); // the first round saved a full checkpoint

  // A summary that wasn't agreed is marked so.
  await handleLine('/new', after);
  const full = JSON.parse(readFileSync(file, 'utf8'));
  full.state.transcript.push({ speaker: 'Summary', text: '- maybe', outcome: 'not agreed', by: 'B' });
  writeFileSync(file, JSON.stringify(full));
  await handleLine('/fresh ' + name, after);
  await handleLine('again', after);
  assert.match(prompts.at(-1), /The latest summary from the previous session \(\*\*not agreed\*\*: the last version, by B; treat its points as proposals\):\n\n- maybe/);

  // No checkpoint: only the handoff and notes.
  mkdirSync(`${cwd}/discussions/2026-11-01-none`);
  await handleLine('/fresh 2026-11-01-none', after);
  await handleLine('hi', after);
  assert.match(prompts.at(-1), /continues the discussion in .*2026-11-01-none.*Start from its handoff/);
  assert.doesNotMatch(prompts.at(-1), /latest summary/);
});

test('removed commands answer with a hint and reach no agent', async () => {
  const ctx = await scriptedCtx([]);
  const notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { if (ev.type === 'note') notes.push(ev.text); } };
  let turns = 0;
  for (const a of ctx.room.agents) a.turn = async () => { turns++; return 'PASS'; };
  for (const line of ['/pause', '/reopen 2026-11-01-x', '/continue', '/autosummary off']) await handleLine(line, ctx);
  assert.equal(turns, 0);
  assert.deepEqual(ctx.state.transcript, []);
  assert.match(notes[0], /^Pause is gone: every discussion saves itself after each round/);
  assert.match(notes[1], /^\/reopen is now \/resume 2026-11-01-x .* or \/fresh 2026-11-01-x/);
  assert.match(notes[2], /^\/continue is now \/resume <name>/);
  assert.match(notes[3], /^Auto-summarize is always on now/);
});

test('Explorer\'s Resume says what it will do: show an open one, continue a saved one, or start from the handoff', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('function resumeTip('), page.indexOf('// Start fresh: discards'));
  const room = { checkpoints: [{ name: 'full', kind: 'full' }, { name: 'fresh', kind: 'fresh' }] };
  const tip = new Function('room', `${code}; return resumeTip;`)(room);
  assert.match(tip('full', { started: true }, null), /^Show it: its agents carry on, nothing is restarted/);
  assert.match(tip('full', null, null), /^Continue where it stopped: the same agent and worker sessions/);
  assert.match(tip('fresh', null, null), /with the summary chosen at Start fresh/);
  assert.match(tip('other', null, 'archive'), /^Makes it active first\. No saved session: start from its handoff and notes/);
});

// ── Auto dev ──
// A discussion in a Git room on scripted agents: a summary draft takes the next of `summaries`, a
// review answers `review(prompt)` (PASS by default), anything else is PASS. The worker answers
// `worker(prompt)`. Lines auto dev queues (its reports) are run by settle(), as the room's input would.
const summaryWith = (instruction, outcome) => `**Agreed**\n- ok\n\n**Next step**\n- Send to the Worker: "${instruction}"\n\n**Later**\n- review it${outcome ? `\n\nOutcome: ${outcome}` : ''}`;
async function autoDevRoom({ summaries, review = () => 'PASS', worker = async () => 'done' }) {
  const ctx = await freshSession([], async () => ({ title: 'Relay' }));
  await gitRoom(ctx.cwd);
  const prompts = [];
  for (const a of ctx.room.agents) a.turn = async (p) => {
    prompts.push(p);
    if (/asked for a summary of the discussion/.test(p)) return summaries.shift() ?? 'PASS';
    return /asked for a summary\. The latest/.test(p) ? review(p) : 'PASS';
  };
  const got = [];
  ctx.worker.turn = async (p) => { got.push(p); return worker(p); };
  const queued = [];
  ctx.say = (line) => queued.push(line);
  ctx.notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { if (ev.type === 'note') ctx.notes.push(ev.text); } };
  const settle = async () => { for (;;) { await ctx.workQueue; if (!queued.length) return; await handleLine(queued.shift(), ctx); } };
  await handleLine('plan it', ctx);
  await handleLine('/summary', ctx); // the agreed summary auto dev starts from
  return { ctx, prompts, got, settle };
}
const sentTo = (got) => got.map((p) => p.split('\n').at(-1));

test('auto dev: reading the instruction only from Next step, and the Outcome line', async () => {
  const { summaryInstruction, summaryOutcome } = await import('../src/ui.mjs');
  assert.deepEqual(summaryInstruction(summaryWith('Fix "the" test.\n\n1. **Step:** then more')), { text: 'Fix "the" test.\n\n1. **Step:** then more' });
  assert.deepEqual(summaryInstruction(summaryWith('Do it', 'SEND')), { text: 'Do it' });
  assert.equal(summaryInstruction('**Agreed**\n- x\n\n**Next step**\n- Answer: which one?'), null);
  assert.match(summaryInstruction('**Agreed**\n- Send to the Worker: "x"').error, /isn't under a Next step heading/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker: "a" and Send to the Worker: "b"').error, /more than one/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker: "unclosed\n\n**Later**\n- "quoted later"').error, /no closing quotation mark/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker the fix').error, /no quoted instruction/);
  // The quotation-mark form, unchanged; and the block-quote form.
  assert.deepEqual(summaryInstruction('**Next step**\n- Send to the Worker: "Run > the tests."'), { text: 'Run > the tests.' });
  const block = '**Next step**\n- Send to the Worker:\n\n  > Fix the "parser".\n  >\n  > Then run `npm test`.\n  >   indented line';
  assert.deepEqual(summaryInstruction(block), { text: 'Fix the "parser".\n\nThen run `npm test`.\n  indented line' });
  assert.deepEqual(summaryInstruction(`${block}\n\n**Later**\n- review it\n> a later note\n\nOutcome: SEND`), { text: 'Fix the "parser".\n\nThen run `npm test`.\n  indented line' });
  assert.match(summaryInstruction('**Next step**\nSend to the Worker:\n>\n> \n\n**Later**\n- x').error, /block-quoted instruction is empty/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker:\n> a\n- Send to the Worker:\n> b').error, /more than one/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker:\n> a\n- and Send to the Worker: "b"').error, /more than one/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker:\n> a\n\n> b').error, /broken by lines/);
  assert.match(summaryInstruction('**Next step**\n- Send to the Worker:\n\nthe fix').error, /no quoted instruction/);
  // Bold lines alone inside both forms, case/bold label variations, quotes/escapes/indentation/nested >/placeholders in block quotes, and errors.
  assert.deepEqual(summaryInstruction('**Next step**\n- **Send to the Worker:** "First part.\n\n**Tests**\nRun `npm test`."\n\n**Later**\n- review'),
    { text: 'First part.\n\n**Tests**\nRun `npm test`.' });
  assert.deepEqual(summaryInstruction('**Next step**\n- **send to the worker:**\n> First part.\n>\n> **Tests**\n> Run `npm test`.\n\n**Later**\n- review'),
    { text: 'First part.\n\n**Tests**\nRun `npm test`.' });
  assert.deepEqual(summaryInstruction('**Next step**\nSend to the Worker:\n> Fix "one", “two” and an unmatched " quote.\n> Keep \\"escaped\\" quotes as written.'),
    { text: 'Fix "one", “two” and an unmatched " quote.\nKeep \\"escaped\\" quotes as written.' });
  assert.deepEqual(summaryInstruction('**Next step**\nSend to the Worker:\n> Outer line\n> > nested quote\n> >> deeper quote'),
    { text: 'Outer line\n> nested quote\n>> deeper quote' });
  assert.match(summaryInstruction('**Next step**\nSend to the Worker:\n> first line\nmissing quote in the middle\n> third line').error, /broken by lines/);
  assert.match(summaryInstruction('**Next step**\nSend to the Worker:\n> first line\n> second line\nmissing quote after the end\n\n**Later**\n- x').error, /followed by unquoted lines/);
  assert.deepEqual(summaryInstruction('**Next step**\nSend to the Worker:\n> Explain headings:\n> **Later**\n> Outcome: SEND\n> and finish.\n\n**Later**\n- real later\n\nOutcome: SEND'),
    { text: 'Explain headings:\n**Later**\nOutcome: SEND\nand finish.' });
  assert.deepEqual(summaryInstruction('**Next step**\nSend to the Worker:\n>\n>   if (ok) {\n>     run(\\"now\\");\n>   }\n> '),
    { text: '  if (ok) {\n    run(\\"now\\");\n  }' });
  assert.deepEqual(summaryInstruction('**Next step**\n- send to the worker: "Old multi-line inline summary.\n\n**Checks**\n- keep \\"quotes\\" and <branch>\n- run tests"\n\nOutcome: SEND'),
    { text: 'Old multi-line inline summary.\n\n**Checks**\n- keep \\"quotes\\" and <branch>\n- run tests' });
  for (const wrapped of ['**Next step**\n- Send to the Worker: <do the task>', '**Next step**\n- Send to the Worker:\n<do the task>', '**Next step**\n- Send to the Worker: `do the task`']) {
    const res = summaryInstruction(wrapped);
    assert.match(res.error, /no quoted instruction/);
    assert.match(res.error, /Send to the Worker: "…".*> block quote/);
  }
  assert.deepEqual(summaryInstruction('**Next step**\nSend to the Worker:\n> Merge worker/<branch> into <target>.\n> <placeholder> at start of line'),
    { text: 'Merge worker/<branch> into <target>.\n<placeholder> at start of line' });
  assert.equal(summaryOutcome(summaryWith('x', 'SEND')), 'SEND');
  assert.equal(summaryOutcome('…\n**Outcome: WAIT FOR USER**'), 'WAIT FOR USER');
  assert.equal(summaryOutcome('Outcome: FINISH\nmore'), null);
});

test('auto dev: step metadata is only before the Outcome and outside the instruction', async () => {
  const { summarySteps, summaryInstruction } = await import('../src/ui.mjs');
  const quoted = '**Next step**\nSend to the Worker: "Do it"\n\n**Steps left: 3**\n\n**Outcome: SEND**';
  const block = '**Next step**\nSend to the Worker:\n> Do it\n\nSteps left: 3\nOutcome: SEND';
  for (const summary of [quoted, block]) {
    assert.equal(summarySteps(summary), 3);
    assert.deepEqual(summaryInstruction(summary), { text: 'Do it' });
  }
  const inside = '**Next step**\nSend to the Worker: "Say \"hello\"\nSteps left: 8\nthen finish"\nOutcome: SEND';
  assert.equal(summarySteps(inside), null);
  assert.deepEqual(summaryInstruction(inside), { text: 'Say "hello"\nSteps left: 8\nthen finish' });
  const boundary = '**Next step**\nSend to the Worker: "Do it\nSteps left: 3"\nOutcome: SEND';
  assert.equal(summarySteps(boundary), null);
  assert.deepEqual(summaryInstruction(boundary), { text: 'Do it\nSteps left: 3' });
  for (const text of ['Steps left: 0', 'Steps left: -1', 'Steps left: 1.5', 'Steps left: 2 extra', 'Steps left: 3\nother']) {
    assert.equal(summarySteps(`**Next step**\nSend to the Worker: "x"\n${text}\nOutcome: SEND`), null);
  }
  assert.equal(summarySteps('Steps left: 3\nOutcome: SEND\nother'), null);
});

test('auto dev: step counts adjust the limit and fix rounds consume slack', async () => {
  const withSteps = (instruction, steps, outcome = 'SEND') => summaryWith(instruction, outcome).replace('Outcome:', `${steps}\nOutcome:`);
  const summaries = [withSteps('A', 'Steps left: 2'), withSteps('B', 'Steps left: 4'),
    withSteps('C', 'Steps left: 4'), withSteps('D', 'Steps left: 1'),
    withSteps('E', 'Steps left: nope'), summaryWith('F', 'SEND'), summaryWith('G', 'SEND')];
  const seen = [];
  let room;
  room = await autoDevRoom({ summaries, worker: async () => { seen.push([room.ctx.autoDev.cycle, room.ctx.autoDev.limit, room.ctx.autoDev.lastSteps]); return 'done'; } });
  await handleLine('/autodev', room.ctx);
  assert.equal(room.ctx.screen.room.autoDev.max, 4);
  assert.match(room.ctx.notes.at(-1), /up to 4 worker cycles/);
  await room.settle();
  assert.deepEqual(seen, [[1, 4, 2], [2, 7, 4], [3, 7, 4], [4, 6, 1], [5, 6, 1], [6, 6, 1]]);
  assert.deepEqual([room.ctx.autoDev.status, room.ctx.autoDev.reason], ['paused', '6 cycles used']);
  assert.equal(room.ctx.screen.room.autoDev.max, 6);
  assert.match(room.ctx.state.transcript.find((m) => m.speaker === 'Auto dev').text, /cycle 1 of 4/);
  await handleLine('/autodev', room.ctx);
  assert.deepEqual([room.ctx.autoDev.limit, room.ctx.autoDev.lastSteps], [5, null]);
  await room.settle();
});

test('auto dev: the step limit is capped at 15 at start and when raised', async () => {
  const withSteps = (name, n) => summaryWith(name, 'SEND').replace('Outcome:', `Steps left: ${n}\nOutcome:`);
  const room = await autoDevRoom({ summaries: [withSteps('A', 30), withSteps('B', 40), '**Agreed**\nOutcome: FINISH'] });
  await handleLine('/autodev', room.ctx);
  assert.deepEqual([room.ctx.autoDev.limit, room.ctx.autoDev.lastSteps], [15, 30]);
  await room.settle();
  assert.deepEqual([room.ctx.autoDev.limit, room.ctx.autoDev.lastSteps], [15, 40]);
});

test('auto dev: Start relays the instruction; the report starts a round; one SEND per report; FINISH ends it', async () => {
  const { readFileSync } = await import('node:fs');
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx, prompts, got, settle } = await autoDevRoom({
    summaries: [summaryWith('Do "step" 1'), summaryWith('Merely quoted', 'SEND'), summaryWith('Do step 2', 'SEND'), '**Agreed**\n- all done\n\nOutcome: FINISH'],
    worker: async (p) => { if (p.endsWith('step" 1')) await gate; return p.endsWith('step" 1') ? 'did step 1' : 'did step 2'; },
  });
  assert.deepEqual(ctx.screen.room.autoDev.offer, { text: 'Do "step" 1' });
  await handleLine('/autodev', ctx);
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.cycle, ctx.screen.room.autoDev.offer], ['running', 1, null]);
  // A summary asked for while the worker works decides nothing, whatever it says.
  await handleLine('/summary', ctx);
  release();
  await settle();
  assert.deepEqual(sentTo(got), ['Do "step" 1', 'Do step 2']);
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.cycle], ['finished', 2]);
  // Ordinary messages on both sides, in the transcript too.
  assert.deepEqual(ctx.state.transcript.filter((m) => m.speaker === 'Worker report').map((m) => m.text), ['did step 1', 'did step 2']);
  assert.deepEqual(ctx.screen.worker.filter((m) => m.speaker === 'Relayed from discussion').length, 2);
  const log = readFileSync(ctx.logPath, 'utf8');
  assert.match(log, /\*\*Relayed from discussion → W\*\* \(worker, auto dev cycle 1 of 5\)\n\nDo "step" 1/);
  assert.match(log, /\*\*Worker report\*\*\n\ndid step 1/);
  // Each instruction handed to the worker is announced to the agents: in the conversation they
  // receive, in the transcript and on the page. None for the summary that merely quoted one.
  const notices = ctx.state.transcript.filter((m) => m.speaker === 'Auto dev').map((m) => m.text);
  assert.deepEqual(notices, ['Auto dev sent the instruction "Do "step" 1" to the Worker (cycle 1 of 5).', 'Auto dev sent the instruction "Do step 2" to the Worker (cycle 2 of 5).']);
  assert.match(log, /\*\*Auto dev\*\*\n\nAuto dev sent the instruction "Do step 2" to the Worker \(cycle 2 of 5\)\./);
  assert.ok(prompts.some((p) => p.includes('[Auto dev]: Auto dev sent the instruction "Do "step" 1" to the Worker (cycle 1 of 5).')));
  // The run's summaries were asked for the Outcome line and told what passing means.
  const draft = prompts.filter((p) => /asked for a summary of the discussion/.test(p)).at(-1);
  assert.match(draft, /Passing on a version accepts its quoted instruction for the worker exactly as it stands/);
  assert.match(draft, /End the summary with one last line: Outcome: SEND, Outcome: FINISH or Outcome: WAIT FOR USER/);
  assert.equal(ctx.notes.at(-1), `Auto dev finished. Review and merge worker/${ctx.discussion.name} yourself.`); // its own lane's branch
});

test('auto dev: at most 5 worker cycles per start; the 5th report is still reviewed; Restart grants 5 more', async () => {
  const summaries = [summaryWith('Step 1'), ...[2, 3, 4, 5, 6, 7].map((n) => summaryWith(`Step ${n}`, 'SEND'))];
  const { ctx, got, settle } = await autoDevRoom({ summaries });
  await handleLine('/autodev', ctx);
  await settle();
  assert.deepEqual(sentTo(got), ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']);
  assert.equal(ctx.state.transcript.filter((m) => m.speaker === 'Worker report').length, 5);
  // A notice for each instruction sent, none for the 6th, which waits for Restart.
  assert.deepEqual(ctx.state.transcript.filter((m) => m.speaker === 'Auto dev').map((m) => m.text.match(/"(.*)"/)[1]), ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5']);
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.reason], ['paused', '5 cycles used']);
  assert.deepEqual(ctx.screen.room.autoDev.offer, { text: 'Step 6' }); // shown with Restart
  await handleLine('/autodev', ctx);
  await handleLine('/autodev', ctx); // already running: refused
  assert.equal(ctx.autoDev.cycle, 1);
  assert.match(ctx.notes.at(-1), /can't start: it is already running/);
  await settle();
  assert.deepEqual(sentTo(got).slice(5), ['Step 6', 'Step 7']);
});

test('auto dev pauses on WAIT FOR USER, an unagreed summary, a failed turn, or a User message; a failed worker counts as a cycle', async () => {
  // WAIT FOR USER, then a failed worker attempt reported and counted.
  let fail = false;
  const wait = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'SEND'), summaryWith('C', 'WAIT FOR USER')],
    worker: async () => { if (fail) throw new Error('timed out'); fail = true; return 'did A'; } });
  await handleLine('/autodev', wait.ctx);
  await wait.settle();
  assert.deepEqual([wait.ctx.autoDev.status, wait.ctx.autoDev.reason, wait.ctx.autoDev.cycle], ['paused', 'the worker failed: Retry or Retry with…', 2]);
  assert.match(wait.ctx.state.transcript.filter((m) => m.speaker === 'Worker report')[1].text, /^The worker's attempt failed: timed out/);
  assert.equal(wait.ctx.screen.room.autoDev.offer, null);

  // Not agreed: the reviewer keeps revising.
  let n = 0;
  const revise = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'SEND')],
    review: (p) => (/Outcome: SEND, Outcome: FINISH/.test(p) ? summaryWith(`B${++n}`, 'SEND') : 'PASS') });
  await handleLine('/autodev', revise.ctx);
  await revise.settle();
  assert.deepEqual([revise.ctx.autoDev.status, revise.ctx.autoDev.reason, revise.got.length], ['paused', 'the summary was not agreed', 1]);

  // A failed discussion turn.
  const broken = await autoDevRoom({ summaries: [summaryWith('A')] });
  broken.ctx.room.agents[1].turn = async () => { throw new Error('crashed'); };
  await handleLine('/autodev', broken.ctx);
  await broken.settle();
  assert.deepEqual([broken.ctx.autoDev.status, broken.ctx.autoDev.reason, broken.got.length], ['paused', 'B failed', 1]);

  // The User's message while the worker works: its report is still shown, nothing more is sent.
  let release;
  const gate = new Promise((r) => { release = r; });
  const typed = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'SEND')], worker: async () => { await gate; return 'did A'; } });
  await handleLine('/autodev', typed.ctx);
  await handleLine('wait, one thing', typed.ctx);
  assert.deepEqual([typed.ctx.autoDev.status, typed.ctx.autoDev.reason], ['paused', 'you sent a message']);
  release();
  await typed.settle();
  assert.deepEqual(sentTo(typed.got), ['A']);
  assert.equal(typed.ctx.state.transcript.at(-3).speaker, 'Worker report');
  assert.equal(typed.ctx.state.transcript.at(-3).text, 'did A');
});

test('auto dev: while paused, any agreed summary ending in Outcome: FINISH finishes the run, and none sends anything', async () => {
  const { readFileSync } = await import('node:fs');
  const done = '**Agreed**\n- The work is done and reviewed.\n\nOutcome: FINISH';
  const { ctx, prompts, got, settle } = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'WAIT FOR USER'),
    summaryWith('C', 'WAIT FOR USER'), summaryWith('D', 'SEND'), done, '**Agreed**\n- Nothing more.'] });
  const turn = ctx.room.agents[0].turn;
  ctx.room.agents[0].turn = async (p) => (/\[User\]: is it done\?/.test(p) && !/asked for a summary/.test(p) ? 'Yes, it is done.' : turn(p));
  const drafts = () => prompts.filter((p) => /asked for a summary of the discussion/.test(p));
  await handleLine('/autodev', ctx);
  await settle();
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.cycle, got.length], ['paused', 1, 1]);
  // The running run's summary already used the two definitions.
  assert.match(drafts().at(-1), /FINISH: development is complete and reviewed; only the User's merge, Reload or live trial may remain\. WAIT FOR USER: the User must answer or act before development can continue\./);

  await handleLine('/summary', ctx); // WAIT FOR USER: still paused
  const asked = drafts().at(-1);
  assert.match(asked, /Auto dev is paused \(the discussion waits for you \(WAIT FOR USER\)\): this summary sends nothing to the Worker\./);
  assert.match(asked, /End the summary with one last line: Outcome: FINISH or Outcome: WAIT FOR USER\./);
  assert.match(asked, /FINISH: development is complete and reviewed/);
  assert.doesNotMatch(asked, /Outcome: SEND/);
  await handleLine('/summary', ctx); // says SEND anyway: nothing is sent
  await settle();
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.cycle, got.length], ['paused', 1, 1]);
  assert.ok(!ctx.state.transcript.some((m) => m.speaker === 'Auto dev' && /"D"/.test(m.text)));

  // An automatic summary after a User round agrees it is done.
  await handleLine('is it done?', ctx);
  await settle();
  assert.deepEqual([ctx.autoDev.status, ctx.autoDev.reason, ctx.autoDev.cycle, got.length], ['finished', null, 1, 1]);
  assert.equal(ctx.notes.at(-1), `Auto dev finished. Review and merge worker/${ctx.discussion.name} yourself.`); // its own lane's branch
  assert.match(readFileSync(ctx.logPath, 'utf8'), /_\(auto dev finished\)_/);
  assert.equal(ctx.screen.room.autoDev.status, 'finished');
  // With the run finished, summaries are as before.
  await handleLine('/summary', ctx);
  assert.doesNotMatch(drafts().at(-1), /Auto dev is|End the summary with one last line/);
});

test('auto dev: while a run is active, the status under the title says so instead of "your turn"', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('function talkStatus('), page.indexOf('function updateReplicaView('));
  const status = (room, more = {}) => new Function('tab', 'localWorking', 'room', 'viewing', 'peeking', 'localThinking', 'yourTurn', `${code}; return talkStatus();`)(
    more.tab ?? 'talk', more.working ?? null, room, null, null, more.thinking ?? null, true);
  const started = { started: true, paused: false };
  assert.equal(status({ ...started, autoDev: { status: null } }), 'your turn');
  assert.equal(status({ ...started, autoDev: { status: 'running' } }), 'Auto dev running');
  assert.equal(status({ ...started, autoDev: { status: 'running' } }, { thinking: 'A' }), 'A is thinking');
  assert.equal(status({ ...started, autoDev: { status: 'paused' } }), 'your turn');
  assert.equal(status({ ...started, autoDev: { status: 'finished' } }), 'your turn');
  assert.equal(status({ ...started, autoDev: { status: 'running' } }, { tab: 'work', working: 'W' }), 'W is working');
});

test('auto dev: never in a brainstorm; New discussion ends a run; Reload keeps it, and a lost worker result pauses it', async () => {
  const { reloaded } = await import('../src/ui.mjs');
  const brainstorm = await freshSession([], async () => ({ title: 'x' }));
  brainstorm.noScreen = true; // terminal mode: one discussion at a time
  brainstorm.say = () => {};
  await handleLine('/brainstorm', brainstorm);
  brainstorm.state.transcript.push({ speaker: 'Summary', text: summaryWith('A'), outcome: 'agreed', by: 'A' });
  assert.equal(brainstorm.screen.room.autoDev.offer, null);
  await handleLine('/autodev', brainstorm);
  assert.equal(brainstorm.autoDev, undefined);

  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx, got, settle } = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'SEND')], worker: async () => { await gate; return 'did A'; } });
  ctx.noScreen = true; // terminal mode: New discussion ends the session here
  await handleLine('/autodev', ctx);
  const run = ctx.autoDev;
  Object.assign(ctx, { code: {}, refreshQuota: () => {} });
  await reloaded(ctx); // the worker is still at it: nothing changes
  assert.deepEqual([ctx.autoDev, run.status, run.cycle, ctx.autoDevSent.length], [run, 'running', 1, 1]);
  await handleLine('/new', ctx);
  assert.equal(ctx.autoDev, null);
  release();
  await settle();
  assert.deepEqual(sentTo(got), ['A']); // its reply stays in the Worker tab only
  assert.ok(!ctx.state.transcript.some((m) => m.speaker === 'Worker report'));

  // A relay whose result is gone after a Reload pauses instead of sending again.
  const lost = await autoDevRoom({ summaries: [summaryWith('A')] });
  await handleLine('/autodev', lost.ctx);
  await lost.ctx.workQueue;
  Object.assign(lost.ctx.autoDev, { waiting: true, report: null }); // as if its result never came back
  Object.assign(lost.ctx, { code: {}, refreshQuota: () => {} });
  await reloaded(lost.ctx);
  assert.deepEqual([lost.ctx.autoDev.status, lost.ctx.autoDev.reason], ['paused', 'the worker\'s result was lost in the Reload']);
  assert.equal(lost.got.length, 1);
});

// ── Several open discussions (the screen) ──
// A folder whose open discussions are scripted contexts on one hub, as cli.mjs's addRoom makes them:
// each records its pages' events, its worker's prompts and the lines it queues for itself.
async function multiRoom({ worker } = {}) {
  const { realpathSync } = await import('node:fs');
  const { roomId } = await import('../src/ui.mjs');
  const cwd = await tmp('multi-test-');
  const git = await gitRoom(cwd);
  const hub = { rooms: new Map() };
  const make = async (context) => {
    const ctx = await scriptedCtx([]);
    delete ctx.logPath;
    Object.assign(ctx, { cwd, hub, context: context ?? null, key: realpathSync(cwd) + (context ? `#${context}` : '') });
    ctx.id = roomId(ctx.key);
    ctx.suggestTitle = async (text) => ({ title: text });
    ctx.events = []; ctx.notes = []; ctx.queued = []; ctx.prompts = []; ctx.resets = 0;
    ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { ctx.events.push(ev); if (ev.type === 'note') ctx.notes.push(ev.text); } };
    ctx.say = (line) => ctx.queued.push(line);
    for (const a of ctx.room.agents) a.reset = () => ctx.resets++;
    ctx.worker.turn = async (p) => { ctx.prompts.push(p); return worker ? worker(ctx, p) : 'done'; };
    hub.rooms.set(ctx.key, ctx);
    return ctx;
  };
  hub.addRoom = async (folder, { context, reopen }) => {
    const c = await make(context);
    if (reopen) await handleLine(`/resume ${reopen}`, c); // as cli.mjs does
    return { ctx: c };
  };
  const first = await make(null);
  // The lines contexts queued for themselves (except /quit, recorded only), run as their input would.
  const settle = async () => {
    for (let more = true; more;) {
      more = false;
      for (const c of [...hub.rooms.values()]) {
        while (c.queued.some((l) => l !== '/quit')) { more = true; await handleLine(c.queued.splice(c.queued.findIndex((l) => l !== '/quit'), 1)[0], c); }
      }
    }
  };
  const gotoOf = (c) => c.events.filter((e) => e.type === 'goto').at(-1)?.url;
  const pageOf = (c) => `/r/${c.id}/__room`;
  return { hub, first, settle, git, gotoOf, pageOf, contexts: () => [...hub.rooms.values()] };
}

test('on the screen, New discussion keeps the discussion open with its sessions; Resume of an open one goes there; brainstorms open beside them, several at once', async () => {
  const { readFileSync } = await import('node:fs');
  const { hub, first, settle, gotoOf, pageOf, contexts } = await multiRoom();
  await handleLine('topic-a', first);
  const a = first.discussion, transcript = first.logPath;
  await handleLine('/new', first);
  const [, second] = contexts();
  assert.equal(contexts().length, 2);
  assert.equal(gotoOf(first), pageOf(second)); // this window shows the new one
  assert.deepEqual([first.discussion, first.logPath, first.resets], [a, transcript, 0]); // kept as it was
  assert.deepEqual(first.state.transcript.map((m) => m.text), ['topic-a', 'PASS', 'PASS']);
  assert.doesNotMatch(readFileSync(transcript, 'utf8'), /session ended/);
  await handleLine('topic-b', second);
  assert.equal(second.discussion.title, 'topic-b');
  assert.deepEqual(first.screen.room.open.map((o) => [o.title, o.current]), [['topic-a', true], ['topic-b', false]]);

  await handleLine(`/resume ${a.name}`, second); // open already: shown as it is
  assert.equal(gotoOf(second), pageOf(first));
  assert.equal(first.resets, 0);
  assert.equal(contexts().length, 2);

  await handleLine('/brainstorm', second); // beside, in a context of its own
  await settle();
  const brain = contexts().find((c) => c.state.brainstorm);
  assert.ok(brain && brain !== second && second.discussion);
  assert.equal(gotoOf(second), pageOf(brain));
  await handleLine('idea one', brain);
  await handleLine('/new', first); // the brainstorm stays open, as discussions do
  assert.deepEqual(brain.queued, []);
  assert.equal(contexts().length, 4);
  assert.equal(gotoOf(first), pageOf(contexts().at(-1)));
  await handleLine('/brainstorm', brain); // a second brainstorm, beside the first
  await settle();
  const brains = contexts().filter((c) => c.state.brainstorm);
  assert.equal(brains.length, 2);
  await handleLine('idea two', brains[1]);
  assert.deepEqual(first.screen.room.open.filter((o) => o.brainstorm).map((o) => [o.title, o.active]),
    [['idea one', `brainstorms/${brains[0].discussion.name}`], ['idea two', `brainstorms/${brains[1].discussion.name}`]]);
  assert.equal(hub.rooms.size, 5);
});

test('one workshop per folder: tasks labelled by origin, one worker session, lane and queue each, reports back there; Close discussion; Quit room closes them all', async () => {
  const { readFileSync, realpathSync } = await import('node:fs');
  const { queueWork, reloaded } = await import('../src/ui.mjs');
  const commit = (msg) => (ctx) => { const g = (...a) => require('node:child_process').execFileSync('git', ['-C', ctx.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]); g('commit', '-q', '--allow-empty', '-m', msg); return 'committed\nDocs: none needed, because test.'; };
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { first, gotoOf, pageOf, contexts } = await multiRoom({ worker: (ctx, p) => commit(ctx === contexts()[0] ? `[${ctx.discussion.name}] done` : 'no label')(ctx) });
  await handleLine('topic-a', first);
  await handleLine('/new', first);
  const second = contexts()[1];
  await handleLine('topic-b', second);
  queueWork(first, 'task for a');
  queueWork(second, 'task for b');
  await Promise.all([first.workQueue, second.workQueue]);
  assert.equal(first.shop, second.shop); // one workshop, one Worker tab
  assert.notEqual(workerLane(first), workerLane(second)); // a queue each
  assert.match(first.prompts[0], new RegExp(`These instructions come from \\[${first.discussion.name}\\]\\. When a task is complete, commit it on worker/${first.discussion.name} with a message starting "\\[${first.discussion.name}\\]" and give the commit ID in your reply`));
  assert.match(second.prompts[0], new RegExp(`come from \\[${second.discussion.name}\\]`));
  assert.match(first.prompts[0], new RegExp(`The active discussion's folder is ${first.discussion.dir}:`)); // its own folder, its own session
  assert.match(second.prompts[0], new RegExp(`The active discussion's folder is ${second.discussion.dir}:`));
  // The two tasks run at once (two lanes), so their entries may come in either order.
  assert.deepEqual(first.shop.log.filter((m) => m.speaker === 'User').map((m) => m.origin).sort(), [first.discussion.name, second.discussion.name].sort());
  assert.match(readFileSync(first.logPath, 'utf8'), /task for a[\s\S]*committed/); // each report goes back to its origin
  assert.doesNotMatch(readFileSync(first.logPath, 'utf8'), /task for b/);
  assert.match(readFileSync(second.logPath, 'utf8'), /task for b/);
  assert.ok(first.shop.log.some((m) => m.note && new RegExp(`Commits without the \\[${second.discussion.name}\\] label: [0-9a-f]+ no label`).test(m.note)));
  assert.ok(!first.shop.log.some((m) => m.note?.includes(`[${first.discussion.name}] label`)));
  // Each discussion's task ran in its own lane, and committed on its own branch.
  assert.deepEqual([realpathSync(first.workerDir.path), realpathSync(second.workerDir.path)],
    [`${realpathSync(first.cwd)}.workers/${first.discussion.name}`, `${realpathSync(first.cwd)}.workers/${second.discussion.name}`]);
  const subject = (branch) => require('node:child_process').execFileSync('git', ['-C', first.cwd, 'log', '-1', '--format=%s', branch]).toString().trim();
  assert.deepEqual([subject(`worker/${first.discussion.name}`), subject(`worker/${second.discussion.name}`)], [`[${first.discussion.name}] done`, 'no label']);

  await handleLine('/close', second); // the others stay open
  assert.deepEqual(second.queued, ['/quit']);
  assert.equal(gotoOf(second), pageOf(first));
  Object.assign(first, { code: {}, refreshQuota: () => {} });
  await reloaded(first); // wires the page's input
  first.screen.say('/quit', false);
  assert.deepEqual([first.queued.at(-1), second.queued.at(-1)], ['/quit', '/quit']); // every open discussion
});

test('lanes run at the same time: two discussions\' tasks overlap with separate queues, holds, worker sessions and worktrees; a hold in one doesn\'t stop the other; a third waits for a free place', async () => {
  const { queueWork, PARALLEL_WORKERS } = await import('../src/ui.mjs');
  const { writeFileSync, realpathSync } = await import('node:fs');
  assert.equal(PARALLEL_WORKERS, 2);
  const gates = new Map(); // each running task's release, by its text
  const started = []; // [text, worktree, worker], as each turn starts
  const { first, contexts } = await multiRoom({ worker: (c, p) => {
    const text = p.split('\n').at(-1);
    started.push([text, realpathSync(c.workerDir.path), c.worker]);
    if (text === 'a: leave edits') writeFileSync(`${c.workerDir.path}/wip.txt`, 'half done\n');
    return new Promise((done) => gates.set(text, done));
  } });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second); await handleLine('/new', second);
  const third = contexts()[2]; await handleLine('topic-c', third);
  const root = realpathSync(first.cwd), [la, lb, lc] = [first, second, third].map((c) => workerLane(c));
  queueWork(first, 'a: leave edits'); queueWork(second, 'b: one'); queueWork(second, 'b: two');
  await until(() => gates.has('a: leave edits') && gates.has('b: one')); // both running at once

  // While both run: a queue, a worktree and a worker session each; each window shows its own worker working.
  assert.deepEqual([la.running?.text, lb.running?.text, la.tasks.length, lb.tasks.map((t) => t.text)], ['a: leave edits', 'b: one', 0, ['b: two']]);
  // (The two lanes start together: either turn may begin first.)
  const byText = Object.fromEntries(started.map(([t, dir, w]) => [t, { dir, w }]));
  assert.deepEqual([byText['a: leave edits'].dir, byText['b: one'].dir], [`${root}.workers/${first.discussion.name}`, `${root}.workers/${second.discussion.name}`]);
  assert.deepEqual([byText['a: leave edits'].w, byText['b: one'].w], [first.worker, second.worker]); // two worker agents, each with its own session
  assert.notEqual(first.worker, second.worker);
  assert.deepEqual([first, second, third].map((c) => c.screen.working ?? null), [first.worker.name, second.worker.name, null]);
  assert.deepEqual([la.blockedBy, lb.blockedBy], [null, null]);

  // A third discussion's task waits for a free place, and says so in the Worker tab.
  queueWork(third, 'c: waits');
  await until(() => first.shop.log.some((m) => m.note === `[${third.discussion.name}] "c: waits" waits for a free place: 2 worker tasks running, at most 2 at once.`));
  assert.deepEqual([gates.has('c: waits'), lc.tasks.map((t) => t.text)], [false, ['c: waits']]);

  // a's task ends with edits left: its lane holds; the free place goes to c; b's lane goes on.
  gates.get('a: leave edits')('left edits behind');
  await until(() => la.blockedBy && gates.has('c: waits'));
  assert.deepEqual([la.blockedBy.origin, lb.blockedBy, lc.blockedBy], [first, null, null]);
  gates.get('b: one')('ok');
  await until(() => gates.has('b: two')); // b's next task, in order, while a's lane holds
  gates.get('b: two')('ok'); gates.get('c: waits')('ok');
  await Promise.all([second.workQueue, third.workQueue]);
  assert.deepEqual([started.slice(0, 2).map(([t]) => t).sort(), started.slice(2).map(([t]) => t)], [['a: leave edits', 'b: one'], ['c: waits', 'b: two']]);
  assert.equal(la.blockedBy.origin, first); // still held, and it stopped no one else
  assert.deepEqual([second.prompts.length, third.prompts.length], [2, 1]);
});

test('a queued task starting after its context switches does not mark the new discussion working', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const gates = new Map();
  const { first, hub } = await multiRoom({ worker: (_ctx, prompt) => new Promise((done) => gates.set(prompt.split('\n').at(-1), done)) });
  first.noScreen = true; // switch this context in place while its queued task remains with A
  await handleLine('topic-a', first);
  const observer = (await hub.addRoom(first.cwd, { context: 'observer' })).ctx;
  await handleLine('observer', observer);
  queueWork(first, 'first in A');
  await until(() => gates.has('first in A'));
  queueWork(first, 'queued in A');
  await handleLine('/new', first);
  await handleLine('topic-b', first);
  const pathB = `discussions/${first.discussion.name}`;
  assert.equal(first.screen.working, null);
  gates.get('first in A')('done');
  await until(() => gates.has('queued in A'));
  const atStart = observer.events.filter((e) => e.type === 'room').at(-1).room.open.find((o) => o.active === pathB);
  assert.equal(first.screen.working, null);
  assert.equal(atStart.working, false);
  const count = observer.events.length;
  gates.get('queued in A')('done');
  await first.workQueue;
  const after = observer.events.slice(count).filter((e) => e.type === 'room');
  assert.ok(after.length, 'the other page receives the finish update');
  assert.equal(first.screen.working, null);
  assert.equal(after.at(-1).room.open.find((o) => o.active === pathB).working, false);
});

test('switching discussion while one waits for its worker task: the message typed in the other and the worker\'s later report each reach their own discussion', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  let finish;
  const { first, contexts, gotoOf, pageOf } = await multiRoom({ worker: () => new Promise((done) => { finish = done; }) });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  await handleLine(`/resume ${first.discussion.name}`, second); // the window shows a again
  assert.equal(gotoOf(second), pageOf(first));
  queueWork(first, 'a long task');
  await until(() => finish);
  assert.deepEqual([first, second].map((c) => c.screen.working ?? null), [first.worker.name, null]);
  await handleLine(`/resume ${second.discussion.name}`, first); // switch to b while a's task runs: nothing blocks it
  assert.equal(gotoOf(first), pageOf(second));
  await handleLine('a message in b', second); // typed in the window, which now shows b
  assert.ok(second.state.transcript.some((m) => m.text === 'a message in b'));
  assert.ok(!first.state.transcript.some((m) => m.text === 'a message in b'));
  finish('the long task\'s report');
  await first.workQueue;
  const a = readFileSync(first.logPath, 'utf8'), b = readFileSync(second.logPath, 'utf8');
  assert.match(a, /a long task[\s\S]*the long task's report/);
  assert.doesNotMatch(a, /a message in b/);
  assert.match(b, /a message in b/);
  assert.doesNotMatch(b, /a long task|the long task's report/);
  assert.deepEqual(first.shop.log.filter((m) => m.speaker).map((m) => [m.origin, m.speaker]), [[first.discussion.name, 'User'], [first.discussion.name, first.worker.name]]);
  assert.deepEqual([first, second].map((c) => c.screen.working ?? null), [null, null]);
});

test('leftover edits hold their own lane for their origin, which can recover them; other lanes go on; they block Archive and Defer; unknown leftovers hold their lane', async () => {
  const { writeFileSync, existsSync } = await import('node:fs');
  const { queueWork, start, workerHold } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const inTree = (ctx, ...a) => execFileSync('git', ['-C', ctx.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  const { first, git, contexts } = await multiRoom({ worker: (ctx, p) => {
    if (p.endsWith('make wip')) writeFileSync(`${ctx.workerDir.path}/wip.txt`, 'half done\n');
    if (p.endsWith('finish it')) { inTree(ctx, 'add', 'wip.txt'); inTree(ctx, 'commit', '-q', '-m', `[${ctx.discussion.name}] finished`); }
    return 'ok\nDocs: none needed, because test.';
  } });
  await handleLine('topic-a', first);
  await handleLine('/new', first);
  const second = contexts()[1];
  await handleLine('topic-b', second);
  queueWork(first, 'make wip');
  await first.workQueue;
  assert.equal(workerLane(first).blockedBy.origin, first);
  assert.match(first.notes.at(-1), new RegExp(`The worker left uncommitted edits from "make wip": the worker lane of \\[${first.discussion.name}\\] holds them until they are resolved \\(other discussions' tasks go on\\)`));
  queueWork(second, 'other work'); // another lane: not held
  await second.workQueue;
  assert.deepEqual([second.prompts.length, workerLane(second).blockedBy, workerLane(first).blockedBy.origin], [1, null, first]);

  assert.match(workerHold(first), /its worker edits from "make wip" are unresolved/);
  await markClosed(first.cwd, first.discussion.name);
  await handleLine(`/move ${first.discussion.name} archive`, second);
  assert.match(second.notes.at(-1), /can't move: its worker edits from "make wip" are unresolved/);
  await handleLine(`/move ${first.discussion.name} deferred`, second);
  assert.ok(existsSync(first.discussion.dir));

  queueWork(first, 'finish it'); // its origin's recovery goes through, with the first task's details
  await first.workQueue;
  assert.match(first.prompts[1], new RegExp(`Uncommitted edits are left in your worktree from the earlier task from \\[${first.discussion.name}\\] "make wip" \\(worker/${first.discussion.name} was at [0-9a-f]{7} when it started\\)`));
  assert.match(first.prompts[1], /first list exactly the edits you would remove and wait for the User's explicit approval/);
  assert.equal(workerLane(first).blockedBy, null);
  assert.ok(first.shop.log.some((m) => m.note === `The worker's folder ${first.workerDir.path} is clean again: its queue resumes.`));

  // Edits of unknown origin (here, made by hand) hold their lane, the origin's tasks too, until it is clean; other lanes go on.
  writeFileSync(`${first.workerDir.path}/stray.txt`, 'x\n');
  let ran = false;
  queueWork(first, 'next');
  first.workQueue.then(() => { ran = true; });
  await until(() => workerLane(first).blockedBy);
  assert.deepEqual([ran, workerLane(first).blockedBy?.origin], [false, null]);
  assert.match(first.shop.log.filter((m) => m.note).at(-1).note, /uncommitted edits from an unknown origin: its queue holds until the folder is clean \(commit or remove those edits yourself\); other lanes go on/);
  queueWork(second, 'meanwhile'); await second.workQueue;
  assert.equal(second.prompts.at(-1).split('\n').at(-1), 'meanwhile');
  assert.equal(ran, false);
  inTree(first, 'add', 'stray.txt'); inTree(first, 'commit', '-q', '-m', 'by hand');
  queueWork(first, 'after');
  await first.workQueue;
  assert.deepEqual(first.prompts.slice(-2).map((p) => p.split('\n').at(-1)), ['next', 'after']);

  // At start (after a Restart, say), leftovers in a lane belong to no known task: that lane holds,
  // and a task of another lane (here worker/main's, with no discussion yet) still runs.
  writeFileSync(`${first.workerDir.path}/left.txt`, 'x\n');
  const restarted = await workerRoom();
  Object.assign(restarted.ctx, { cwd: first.cwd, noScreen: true, refreshQuota: () => {} });
  await start(restarted.ctx);
  assert.equal(workerLane(restarted.ctx, first.discussion.name).blockedBy.origin, null);
  queueWork(restarted.ctx, 'do it');
  await restarted.ctx.workQueue;
  assert.equal(restarted.got.length, 1);
  assert.equal(workerLane(restarted.ctx, first.discussion.name).blockedBy.origin, null); // still held
  void git;
});

test('worker changes stay in their discussion and only unstarted changes update defaults', async () => {
  const { readFileSync } = await import('node:fs');
  const { saveSettings, readDefaults } = await import('../src/ui.mjs');
  const { first, contexts } = await multiRoom();
  await handleLine('topic-a', first);
  await handleLine('/new', first);
  const second = contexts()[1];
  const agents = [{ provider: 'claude', name: 'A', model: '' }, { provider: 'claude', name: 'B', model: '' }];
  for (const c of [first, second]) Object.assign(c, { agentSpecs: 'claude:A,claude:B', workerSpec: 'claude:W',
    sessions: new Map([['worker:W', { id: 'session-' + (c === first ? 'first' : 'second') }]]) });
  const file = `${await tmp('settings-')}/defaults.json`;
  // The other open discussion is already active, and its session and worker must not change.
  const oldWorker = first.worker, oldSpec = first.workerSpec;
  const oldSession = first.sessions.get('worker:W');
  const oldSessionData = JSON.stringify(oldSession);
  // A shared Worker-tab log must not make the new discussion count as started.
  second.screen.worker.push({ speaker: 'W', origin: first.discussion.name, html: 'old work' });
  const beforeStart = { provider: 'codex', name: 'W', model: 'model-one' };
  await saveSettings(second, { agents, worker: beforeStart, scope: 'work' }, file);
  assert.deepEqual(readDefaults(file).worker, beforeStart);
  assert.equal(second.screen.getSettings().started, false);
  assert.equal(second.workerSpec, 'codex:W:model-one');
  assert.equal(first.worker, oldWorker);
  assert.equal(first.workerSpec, oldSpec);
  assert.equal(first.sessions.get('worker:W'), oldSession);
  assert.equal(JSON.stringify(oldSession), oldSessionData);
  for (const agent of second.room.agents) agent.turn = async () => 'PASS';
  await handleLine('topic-b', second);
  const savedDefaults = readFileSync(file, 'utf8');
  const afterStart = { provider: 'claude', name: 'A2', model: 'sonnet' };
  // A name used by a different discussion is permitted.
  first.room.agents[0].name = 'A2';
  await saveSettings(second, { agents, worker: afterStart, scope: 'work' }, file);
  assert.equal(second.workerSpec, 'claude:A2:sonnet');
  assert.equal(readFileSync(file, 'utf8'), savedDefaults);
  assert.equal(first.worker, oldWorker);
  assert.equal(first.workerSpec, oldSpec);
  assert.equal(first.sessions.get('worker:W'), oldSession);
  const name = second.discussion.name;
  const checkpoint = JSON.parse(readFileSync(await checkpointPath(second.cwd, name), 'utf8'));
  assert.equal(checkpoint.workerSpec, 'claude:A2:sonnet');
  // Pausing and resuming restores that worker, rather than the saved default.
  second.noScreen = true;
  await handleLine('/new', second);
  await handleLine('/resume ' + name, second);
  assert.equal(second.workerSpec, 'claude:A2:sonnet');
  assert.equal(second.worker.name, 'A2');
  assert.deepEqual(readDefaults(file).worker, beforeStart);
  assert.equal(first.worker, oldWorker);
});

test('Restart brings back every open discussion and started brainstorm of a folder, each in its own context', () => {
  const rooms = [{ cwd: '/r', discussion: { name: '2026-11-09-a' }, agentSpecs: 'claude:A', workerSpec: 'claude:W' },
    { cwd: '/r', context: 'd1', discussion: { name: '2026-11-09-b' }, agentSpecs: 'claude:A', workerSpec: 'claude:W' },
    { cwd: '/r', context: 'd2', state: { brainstorm: true } },
    { cwd: '/r', context: 'd3', state: { brainstorm: true }, discussion: { name: '2026-11-09-idea' }, agentSpecs: 'claude:A', workerSpec: 'claude:W' }];
  const args = restartArgs(rooms, {}, 5566);
  assert.deepEqual(args.slice(1, 9), ['--cwd', '/r', '--port', '5566', '--agents', 'claude:A', '--worker', 'claude:W']);
  assert.equal(args[args.indexOf('--reopen') + 1], '2026-11-09-a');
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--room').map((a) => JSON.parse(a)),
    [{ cwd: '/r', agents: 'claude:A', worker: 'claude:W', reopen: '2026-11-09-b', context: 'd1' },
      { cwd: '/r', agents: 'claude:A', worker: 'claude:W', reopen: 'brainstorms/2026-11-09-idea', context: 'd3' }]); // not the unstarted brainstorm
});


test('Quit room during a round: after the grace period the agent mid-turn is stopped, and no new one starts', { timeout: 20000 }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { quitRequested, QUIT_GRACE_MS } = await import('../src/ui.mjs');
  const home = mkdtempSync(join(tmpdir(), 'quit-round-')), bin = join(home, 'bin'), pidFile = join(home, 'pid');
  mkdirSync(bin);
  // A claude whose turn never ends by itself (a minute, far past this test). Its PID is written whole:
  // a temporary file renamed into place, so a reader never sees an empty or partial ID.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));\nrequire('node:fs').renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});\nsetTimeout(() => console.log('{"result":"late"}'), 60000);\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try {
    const ctx = { cwd: home, agentSpecs: 'claude:A', workerSpec: 'claude:W', noScreen: true, state: { transcript: [], seen: new Map() }, sessions: new Map() };
    Object.assign(ctx, await load(ctx, ''));
    ctx.suggestTitle = async () => ({ title: 'Quit test' });
    ctx.usage = { ...ctx.usage, fetchQuota: async () => null };
    const round = handleLine('a turn that never ends', ctx);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(pidFile), 'the fake claude never wrote its PID');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // 0 would make the check below pass or fail by accident: process.kill(0, 0) signals this test's own group.
    assert.ok(pid > 0, `the fake claude's PID should be positive: read ${pid}`);
    const t0 = Date.now();
    quitRequested(ctx, 300);
    await round; // the round ends because its agent was stopped
    assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
    assert.deepEqual([ctx.state.transcript.at(-1).speaker, ctx.state.transcript.at(-1).error], ['A', true]);
    assert.throws(() => process.kill(pid, 0)); // its program is gone
    assert.equal(ctx.programs.running.size, 0);
    // A line queued behind it doesn't start another agent program.
    await handleLine('queued before Quit', ctx);
    assert.match(ctx.state.transcript.at(-1).text, /not started: the room is quitting/);
    assert.equal(QUIT_GRACE_MS, 30000); // the real wait, stated in the README
  } finally { process.env.PATH = path; }
});

test('Open room in folder… opens an existing room, says when it is open elsewhere, and creates one only with its one-time token', async () => {
  const { newRoom } = await import('../src/ui.mjs');
  const { realpathSync } = await import('node:fs');
  const [shown, hidden, fresh, other] = await Promise.all(['open-shown-', 'open-hidden-', 'open-fresh-', 'open-other-'].map(tmp));
  const room = (cwd, id, pages) => ({ cwd, id, screen: { clients: new Set(Array(pages).fill(0).map((_, i) => i)) } });
  const added = [];
  const hub = { rooms: new Map([[realpathSync(shown), room(shown, 'shown-1', 1)], [realpathSync(hidden), room(hidden, 'hidden-1', 0)]]),
    addRoom: async (folder) => {
      const key = realpathSync(folder), had = hub.rooms.get(key);
      if (had) return { ctx: had, existing: true };
      const made = room(folder, `made-${added.push(folder)}`, 0);
      hub.rooms.set(key, made);
      return { ctx: made, existing: false };
    } };
  const ctx = { cwd: '/tmp', agentSpecs: 'claude:A', hub };
  const choosing = (folder) => async () => folder;
  // Cancelling the chooser.
  assert.deepEqual(await newRoom(ctx, {}, choosing(null)), { cancelled: true });
  // A room a page shows already: no window, and nothing created.
  assert.deepEqual(await newRoom(ctx, {}, choosing(shown)), { url: '/r/shown-1/__room', folder: shown, existing: true, open: true });
  // A room no page shows: opened as it is.
  assert.deepEqual(await newRoom(ctx, {}, choosing(hidden)), { url: '/r/hidden-1/__room', folder: hidden, existing: true, open: false });
  // No room yet: the first request only asks, with a token.
  const asked = await newRoom(ctx, {}, choosing(fresh));
  assert.deepEqual([asked.confirm, asked.folder, typeof asked.token], [true, fresh, 'string']);
  assert.deepEqual(added, []);
  // A made-up token, or a token that isn't a string, creates nothing.
  for (const token of ['not-a-token', { folder: other }, '']) {
    await assert.rejects(newRoom(ctx, { token }), (err) => err.status === 400 && /choose the folder again/.test(err.message));
  }
  assert.deepEqual(added, []);
  // Create room: the chooser's folder, once; the same token again is refused.
  const chooserNotRun = async () => { throw new Error('Create room must not run the chooser'); };
  assert.deepEqual(await newRoom(ctx, { token: asked.token }, chooserNotRun), { url: '/r/made-1/__room', folder: fresh });
  assert.deepEqual(added, [fresh]);
  await assert.rejects(newRoom(ctx, { token: asked.token }), /choose the folder again/);
  // Cancel in the dialog: the token is dropped and nothing is created.
  const second = await newRoom(ctx, {}, choosing(other));
  assert.deepEqual(await newRoom(ctx, { token: second.token, cancel: true }), { cancelled: true });
  await assert.rejects(newRoom(ctx, { token: second.token }), /choose the folder again/);
  assert.deepEqual(added, [fresh]);
});

test('Stage 2: completed work is reported once before a round, including Worker report rounds, never just by switching', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, readFileSync } = await import('node:fs');
  const commits = [];
  const { first, contexts, settle } = await multiRoom({ worker: (c) => {
    const tree = c.workerDir.path;
    const g = (...a) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
    writeFileSync(`${tree}/changed.txt`, String(commits.length));
    g('add', 'changed.txt'); g('commit', '-qm', `[${c.discussion.name}] completed`);
    const head = g('rev-parse', 'HEAD'); commits.push(head); return `done\nDocs: none needed, because test.\nTested: ${head} with main ${g('rev-parse', 'main')}: tests passed`;
  } });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  const notices = (c) => c.state.transcript.filter((m) => m.text.startsWith('Work finished elsewhere:'));
  queueWork(second, 'work b'); queueWork(second, 'more work b'); await second.workQueue;
  await handleLine(`/resume ${first.discussion.name}`, second);
  assert.equal(notices(first).length, 0); // viewing starts no round
  let prompt = '';
  first.room.agents[0].turn = async (p) => { prompt += p; return 'PASS'; };
  await handleLine('review', first);
  assert.equal(notices(first).length, 1);
  assert.match(notices(first)[0].text, new RegExp(commits[0]));
  assert.match(notices(first)[0].text, /changed.txt/);
  assert.ok(notices(first)[0].text.includes(commits[1]));
  assert.equal(first.events.filter((e) => e.type === 'message' && e.message.html?.includes('Work finished elsewhere:')).length, 1);
  assert.ok(prompt.includes(notices(first)[0].text));
  assert.ok(readFileSync(first.logPath, 'utf8').includes(notices(first)[0].text));
  await handleLine('again', first);
  assert.equal(notices(first).length, 1);
  assert.equal(notices(second).length, 0); // own work isn't reported
  queueWork(second, 'more b'); await second.workQueue;
  first.autoDev = { status: 'paused', cycle: 1, waiting: true };
  queueWork(first, 'work a', first.autoDev); await first.workQueue;
  await settle();
  assert.equal(notices(first).length, 2);
  assert.ok(notices(first)[1].text.includes(commits[2]));
  assert.ok(!notices(first)[1].text.includes(commits[0]));
  assert.ok(first.state.transcript.some((m) => m.speaker === 'Worker report'));
});

test('Stage 2: Defer refuses labelled commits absent from main and permits them after a normal merge', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { first, contexts, git } = await multiRoom({ worker: (c) => {
    execFileSync('git', ['-C', c.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `[${c.discussion.name}] done`]); return 'done\nDocs: none needed, because test.';
  } });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  queueWork(first, 'work'); await first.workQueue;
  const name = first.discussion.name;
  await markClosed(first.cwd, name);
  await handleLine(`/move ${name} deferred`, second);
  assert.match(second.notes.at(-1), new RegExp(`can't be deferred: commits on worker/${name} are not merged into main: [0-9a-f]+`)); // its own lane's branch
  assert.ok(existsSync(`${first.cwd}/discussions/${name}`));
  git('merge', '--no-ff', `worker/${name}`, '-m', 'merge worker');
  await handleLine(`/move ${name} deferred`, second);
  assert.ok(existsSync(`${first.cwd}/discussions/deferred/${name}`));
});

test('Stage 2: private owner records survive restart and recovery, invalid records block as unknown, and a brainstorm writes none', async () => {
  const { queueWork, recoverWorkerOwner } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } = await import('node:fs');
  let record, original, tree;
  const { first, contexts, settle } = await multiRoom({ worker: (c, p) => {
    tree = c.workerDir.path;
    const g = (...a) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
    record = `${g('rev-parse', '--absolute-git-dir')}/agent-room-task.json`;
    assert.ok(existsSync(record)); // on disk before the provider starts
    if (p.endsWith('leave edits')) {
      original = readFileSync(record, 'utf8');
      const r = JSON.parse(original);
      assert.equal(r.task, 'leave edits'); assert.equal(r.before, g('rev-parse', 'HEAD'));
      writeFileSync(`${tree}/wip`, c.state.brainstorm ? 'brainstorm unfinished' : 'unfinished');
    } else {
      assert.equal(readFileSync(record, 'utf8'), original); // recovery doesn't replace ownership
      g('add', 'wip'); g('commit', '-qm', `[${c.state.brainstorm ? 'brainstorm' : c.discussion.name}] recovered`);
    }
    return 'ok\nDocs: none needed, because test.';
  } });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  queueWork(first, 'leave edits'); await first.workQueue;
  assert.equal(JSON.parse(original).label, first.discussion.name);
  const resetShop = () => { for (const c of contexts()) { for (const l of c.shop?.lanes?.values() ?? []) clearTimeout(l.recheck); delete c.shop; } };
  const heldA = () => workerLane(second, first.discussion.name).blockedBy; // first's lane, seen from second
  resetShop(); await recoverWorkerOwner(second);
  assert.equal(heldA().origin, first);
  assert.match(first.notes.at(-1), /worker left uncommitted edits/);
  for (const bad of [null, '{broken', JSON.stringify({ ...JSON.parse(original), before: 'invalid' }), JSON.stringify({ ...JSON.parse(original), label: '2026-11-09-missing' })]) {
    if (bad === null) unlinkSync(record); else writeFileSync(record, bad);
    resetShop(); await recoverWorkerOwner(second);
    assert.equal(heldA().origin, null);
  }
  writeFileSync(record, original); resetShop(); await recoverWorkerOwner(second);
  queueWork(first, 'recover'); await first.workQueue;
  assert.equal(existsSync(record), false);
  assert.equal(workerLane(first).blockedBy, null);
  assert.ok(!execFileSync('git', ['-C', tree, 'ls-files']).toString().includes('agent-room-task'));
  // A brainstorm sends no work, so it never writes an owner record (nor manufactures a discussion folder).
  await handleLine('/brainstorm', second); await settle();
  const brain = contexts().find((c) => c.state.brainstorm);
  const folders = readdirSync(`${first.cwd}/discussions`);
  queueWork(brain, 'leave edits'); await brain.workQueue;
  assert.equal(existsSync(record), false);
  assert.equal(workerLane(first, null).blockedBy, null);
  assert.deepEqual(readdirSync(`${first.cwd}/discussions`), folders);
});


test('Stage 2: cleaning held edits by hand clears the private record and hold without another task', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { writeFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { first } = await multiRoom({ worker: (c) => { writeFileSync(`${c.workerDir.path}/wip`, 'unfinished'); return 'stopped'; } });
  await handleLine('topic-a', first);
  queueWork(first, 'start'); await first.workQueue;
  const tree = first.workerDir.path;
  const g = (...a) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();
  const record = `${g('rev-parse', '--absolute-git-dir')}/agent-room-task.json`;
  g('add', 'wip'); g('commit', '-qm', `[${first.discussion.name}] completed by hand`);
  for (let n = 0; n < 100 && workerLane(first).blockedBy; n++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(workerLane(first).blockedBy, null);
  assert.equal(existsSync(record), false);
  assert.equal(first.prompts.length, 1);
  assert.equal(first.shop.completed[0].id, g('rev-parse', 'HEAD'));
});

test('Stage 3: a diverged clean worker is instructed to merge main normally before its task', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { first, git } = await multiRoom({ worker: (c, p) => {
    if (p.endsWith('catch up task')) {
      assert.match(p, new RegExp(`first merge main into worker/${c.discussion.name} with a normal merge`));
      assert.match(p, /If it clashes, do not force it or do the requested task/);
      assert.match(p, new RegExp(`After a successful merge, run the project's tests \\(npm test, if it has them\\) and report their real output, then end your reply with the line "Tested: <full commit ID of worker/${c.discussion.name}> with main <full commit ID of main>: tests passed"`));
      execFileSync('git', ['-C', c.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'main', '-m', `[${c.discussion.name}] catch up with main`]);
      const head = execFileSync('git', ['-C', c.workerDir.path, 'rev-parse', 'HEAD']).toString().trim();
      return `done\nTested: ${head} with main ${git('rev-parse', 'main')}: tests passed`;
    }
    return 'done';
  } });
  await handleLine('topic-a', first);
  queueWork(first, 'prepare'); await first.workQueue;
  const tree = first.workerDir.path;
  git('-C', tree, 'commit', '--allow-empty', '-qm', `[${first.discussion.name}] own work`);
  writeFileSync(`${first.cwd}/main-file`, 'new on main'); git('add', 'main-file'); git('commit', '-qm', 'main advances');
  const main = git('rev-parse', 'main');
  queueWork(first, 'catch up task'); await first.workQueue;
  assert.equal(git('rev-parse', 'main'), main); // app and worker leave the User's branch untouched
  assert.equal(git('-C', tree, 'rev-parse', 'HEAD^2'), main);
  assert.ok(!first.shop.log.some((m) => m.note?.includes('Commits without'))); // imported main history isn't newly authored worker work
  assert.equal(workerLane(first).blockedBy, null);
});

test('Stage 3: a worker merge conflict holds its own lane, not other discussions\', and recovery keeps the original ownership', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  let record, saved, otherRan = false;
  const { first, contexts, git } = await multiRoom({ worker: (c, p) => {
    const tree = c.workerDir.path;
    const g = (...a) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
    record = `${g('rev-parse', '--absolute-git-dir')}/agent-room-task.json`;
    if (p.endsWith('conflicting task')) {
      saved = readFileSync(record, 'utf8');
      assert.match(p, /first merge main/);
      assert.throws(() => g('merge', 'main', '--no-edit'));
      return 'Merge conflicts in shared.txt; task not attempted.';
    }
    if (p.endsWith('recover conflict')) {
      assert.equal(readFileSync(record, 'utf8'), saved);
      assert.match(p, /earlier task[\s\S]*conflicting task/);
      writeFileSync(`${tree}/shared.txt`, 'resolved\n'); g('add', 'shared.txt'); g('commit', '-qm', `[${c.discussion.name}] resolve catch up`);
    }
    if (p.endsWith('other task')) otherRan = true;
    return 'done';
  } });
  writeFileSync(`${first.cwd}/shared.txt`, 'base\n'); git('add', 'shared.txt'); git('commit', '-qm', 'base');
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  queueWork(first, 'prepare'); await first.workQueue;
  const tree = first.workerDir.path;
  writeFileSync(`${tree}/shared.txt`, 'worker\n'); git('-C', tree, 'add', 'shared.txt'); git('-C', tree, 'commit', '-qm', `[${first.discussion.name}] own change`);
  writeFileSync(`${first.cwd}/shared.txt`, 'main\n'); git('add', 'shared.txt'); git('commit', '-qm', 'main change');
  queueWork(first, 'conflicting task'); await first.workQueue;
  assert.equal(workerLane(first).blockedBy.origin, first);
  assert.ok(existsSync(`${git('-C', tree, 'rev-parse', '--absolute-git-dir')}/MERGE_HEAD`));
  queueWork(second, 'other task'); await second.workQueue; // another lane goes on
  assert.equal(otherRan, true); assert.equal(workerLane(first).blockedBy.origin, first);
  queueWork(first, 'recover conflict'); await first.workQueue;
  assert.equal(workerLane(first).blockedBy, null);
  assert.equal(existsSync(record), false);
});

test('Stage 3: clean merge, revert and sequencer states hold their lane\'s dispatch and survive ownership restoration', async () => {
  const { queueWork, recoverWorkerOwner, worktreeStatus, workerPlace } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, unlinkSync, mkdirSync, rmdirSync } = await import('node:fs');
  for (const marker of ['MERGE_HEAD', 'REVERT_HEAD', 'sequencer']) {
    let privateDir;
    const { first, contexts, git } = await multiRoom({ worker: (c, p) => {
      const tree = c.workerDir.path;
      privateDir = execFileSync('git', ['-C', tree, 'rev-parse', '--absolute-git-dir']).toString().trim();
      if (p.endsWith('leave operation')) {
        if (marker === 'sequencer') mkdirSync(`${privateDir}/${marker}`);
        else writeFileSync(`${privateDir}/${marker}`, git('rev-parse', 'HEAD') + '\n');
      } else if (p.endsWith('resolve operation')) {
        if (marker === 'sequencer') rmdirSync(`${privateDir}/${marker}`);
        else unlinkSync(`${privateDir}/${marker}`);
      }
      return 'done';
    } });
    await handleLine('topic-a', first); await handleLine('/new', first);
    const second = contexts()[1]; await handleLine('topic-b', second);
    queueWork(first, 'leave operation'); await first.workQueue;
    const tree = first.workerDir.path;
    assert.equal(git('-C', tree, 'status', '--porcelain'), ''); // operation alone must hold
    assert.equal((await worktreeStatus(await workerPlace(first.cwd, first.discussion.name))).treeDirty, true); // its own lane
    for (const c of contexts()) { for (const l of c.shop?.lanes?.values() ?? []) clearTimeout(l.recheck); delete c.shop; }
    await recoverWorkerOwner(second);
    assert.equal(workerLane(second, first.discussion.name).blockedBy.origin, first); // first's lane, seen from second
    queueWork(second, 'later'); await second.workQueue; // another lane goes on
    assert.equal(second.prompts.length, 1);
    queueWork(first, 'resolve operation'); await first.workQueue;
    assert.equal(workerLane(first).blockedBy, null);
  }
});

test('Stage 3: rollback includes merged implementation, never restores prior rollback, and archives only on explicit confirmation', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, existsSync, readFileSync } = await import('node:fs');
  let implementation, attempts = 0;
  const { first, contexts, git } = await multiRoom({ worker: (c, p) => {
    const tree = c.workerDir.path;
    const g = (...a) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
    if (p.endsWith('implement')) {
      writeFileSync(`${tree}/feature.txt`, 'feature\n'); g('add', 'feature.txt'); g('commit', '-qm', `[${c.discussion.name}] implement`);
      implementation = g('rev-parse', 'HEAD'); return 'implemented\nDocs: none needed, because test.';
    }
    assert.match(p, /INCLUDING those already merged into main/);
    assert.match(p, /never revert a rollback and restore changes already removed/);
    assert.match(p, /before changing any file/i);
    assert.match(p, /newest first/);
    assert.match(p, /dependencies[\s\S]*other origins/);
    assert.match(p, /Run npm test and read its real output/);
    assert.match(p, /Do not archive the discussion/);
    // This scripted worker executes the requested strategy against a real disposable Git history.
    // Already-reverted targets are read from history, not selected again on a repeated request.
    if (!g('log', '--format=%B').includes(`Agent-Room-Reverted: ${implementation}`)) {
      g('merge', 'main', '-m', `[${c.discussion.name}] catch up with main`);
      g('revert', '--no-commit', implementation);
      g('commit', '-qm', `[${c.discussion.name}] rollback\n\nAgent-Room-Rollback-Origin: ${c.discussion.name}\nAgent-Room-Reverted: ${implementation}`);
    } else {
      assert.equal(existsSync(`${tree}/feature.txt`), false);
      g('commit', '--allow-empty', '-qm', `[${c.discussion.name}] rollback already undone\n\nAgent-Room-Rollback-Origin: ${c.discussion.name}`);
    }
    const output = execFileSync('npm', ['test'], { cwd: tree, encoding: 'utf8' });
    attempts++;
    return `Reverted or already undone: ${implementation}\n${output}\nDependencies: no other origin in this fixture uses feature.txt. Semantic dependencies require review.\nNot checked: real provider or deployed state.\nRollback ready: ${g('rev-parse', 'HEAD')}`;
  } });
  writeFileSync(`${first.cwd}/package.json`, JSON.stringify({ scripts: { test: 'node -e "console.log(\'fixture tests passed\')"' } }));
  git('add', 'package.json'); git('commit', '-qm', 'fixture test script');
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  const name = first.discussion.name;
  queueWork(first, 'implement'); await first.workQueue;
  git('merge', '--no-ff', `worker/${name}`, '-m', 'User merges implementation'); // its own lane's branch
  assert.equal(existsSync(`${first.cwd}/feature.txt`), true);
  git('commit', '--allow-empty', '-qm', 'main advances again');
  await handleLine(`/rollback ${name}`, second); await first.workQueue;
  assert.equal(attempts, 1);
  assert.equal(first.shop.rollbacks.get(name).status, 'ready');
  assert.ok(first.state.transcript.some((m) => m.speaker === 'Worker rollback report' && m.text.includes('fixture tests passed')));
  assert.match(readFileSync(first.logPath, 'utf8'), /Worker rollback report/);
  assert.equal(existsSync(`${first.cwd}/discussions/${name}`), true); // report alone archives nothing
  assert.equal(existsSync(`${first.cwd}/feature.txt`), true); // main untouched
  assert.equal(existsSync(`${first.workerDir.path}/feature.txt`), false);
  await markClosed(first.cwd, name);
  await handleLine(`/move ${name} archive`, second);
  assert.match(second.notes.at(-1), /explicit archive confirmation/);
  await handleLine(`/archive-rollback ${name}`, second);
  assert.equal(existsSync(`${first.cwd}/discussions/archive/${name}`), true);
  git('merge', '--no-ff', `worker/${name}`, '-m', 'User merges rollback');
  assert.equal(existsSync(`${first.cwd}/feature.txt`), false);
  await handleLine(`/move archive/${name} active`, second);
  await handleLine(`/rollback ${name}`, second); await first.workQueue;
  assert.equal(attempts, 2);
  assert.equal(existsSync(`${first.workerDir.path}/feature.txt`), false);
  assert.equal(first.shop.rollbacks.get(name).status, 'ready');
  // A later change invalidates the reviewed snapshot, even if its worktree is clean.
  git('-C', first.workerDir.path, 'commit', '--allow-empty', '-qm', '[another-origin] subsequent work');
  await handleLine(`/archive-rollback ${name}`, second);
  assert.match(second.notes.at(-1), /state changed since the rollback report/);
  assert.equal(existsSync(`${first.cwd}/discussions/${name}`), true);
});

test('Stage 3: an ambiguous or failed rollback report cannot authorize archiving', async () => {
  const { first, contexts, git } = await multiRoom({ worker: (c) => `Ambiguous earlier revert: no files changed.\nRollback ready: ${git('rev-parse', `worker/${c.discussion.name}`)}` }); // its own lane's branch
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  const name = first.discussion.name;
  await handleLine(`/rollback ${name}`, second); await first.workQueue;
  assert.equal(first.shop.rollbacks.get(name).status, 'needs review'); // marker alone isn't sufficient
  await handleLine(`/archive-rollback ${name}`, second);
  assert.match(second.notes.at(-1), /No successful rollback report/);
  assert.equal(git('rev-parse', `worker/${name}`), git('rev-parse', 'main'));
});

test('Stage 3: Explorer queues rollback separately from two-click archive confirmation after a report', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  const confirmed = source.slice(source.indexOf('function confirmed('), source.indexOf('// Rollback queues work'));
  const buttons = source.slice(source.indexOf('function rollbackButtons('), source.indexOf('const pendingArchives'));
  const element = () => ({ children: [], dataset: {}, style: {}, append(...items) { this.children.push(...items); } });
  const sent = [], room = { rollbacks: [] };
  const build = new Function('room', 'document', 'send', 'setTimeout', confirmed + buttons + '; return rollbackButtons;')(
    room, { createElement: element }, (line) => sent.push(line), () => {});
  const name = '2026-11-09-topic', row = element(), details = element(), ev = { stopPropagation() {} };
  build(row, details, name, name, false);
  row.children[0].onclick(ev); assert.deepEqual(sent, []);
  row.children[0].onclick(ev); assert.deepEqual(sent, [`/rollback ${name}`]);
  assert.equal(row.children.length, 1); // no archive confirmation before a successful report
  room.rollbacks = [{ name, status: 'ready', report: 'Tests passed; review dependencies. Rollback ready: abc' }];
  const ready = element(); build(ready, details, name, name, false);
  assert.equal(details.children[0].children[1].textContent, room.rollbacks[0].report);
  ready.children[1].onclick(ev); assert.equal(sent.length, 1);
  ready.children[1].onclick(ev); assert.equal(sent[1], `/archive-rollback ${name}`);
  const current = element(); build(current, element(), name, name, true);
  assert.equal(current.children[1].disabled, true); // unchanged Archive guard for the one in use
});

test('failed worktree inspection blocks even the holding origin recovery in its lane, preserves ownership and retries; other lanes go on', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  let recovered = false, otherRan = false;
  const { first, contexts, git } = await multiRoom({ worker: (c, p) => {
    const tree = c.workerDir.path;
    if (p.endsWith('leave edits')) writeFileSync(`${tree}/wip`, 'unfinished');
    if (p.endsWith('repair')) {
      recovered = true;
      git('-C', tree, 'add', 'wip'); git('-C', tree, 'commit', '-qm', `[${c.discussion.name}] repaired`);
    }
    if (p.endsWith('other work')) otherRan = true;
    return 'done\nDocs: none needed, because test.';
  } });
  await handleLine('topic-a', first); await handleLine('/new', first);
  const second = contexts()[1]; await handleLine('topic-b', second);
  queueWork(first, 'leave edits'); await first.workQueue;
  const shop = first.shop, lane = workerLane(first), hold = lane.blockedBy;
  const privateDir = git('-C', first.workerDir.path, 'rev-parse', '--absolute-git-dir');
  const record = `${privateDir}/agent-room-task.json`, index = `${privateDir}/index`;
  const savedRecord = readFileSync(record), savedIndex = readFileSync(index);
  try {
    // A damaged fixture index makes git status throw, without damaging the owner record.
    writeFileSync(index, 'bad');
    assert.throws(() => execFileSync('git', ['-C', first.workerDir.path, 'status', '--porcelain'], { stdio: 'pipe' }));
    queueWork(first, 'repair'); queueWork(second, 'other work');
    await until(() => lane.inspectionError);
    await second.workQueue; // another lane goes on
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(recovered, false); assert.equal(otherRan, true);
    assert.equal(first.prompts.length, 1);
    assert.deepEqual(lane.tasks.map((t) => t.text), ['repair']);
    assert.equal(lane.blockedBy, hold); // same ownership object, not unknown/reassigned/released
    assert.deepEqual(readFileSync(record), savedRecord);
    assert.match(first.notes.at(-1), /inspection failed:[\s\S]*index[\s\S]*including recovery/);
    assert.ok(shop.log.some((m) => m.error && /inspection failed:[\s\S]*index/.test(m.note)));
    assert.ok(lane.recheck); // failure keeps the existing two-second retry alive
  } finally { writeFileSync(index, savedIndex); }
  // No new instruction: the re-check alone must resume the held recovery.
  for (let n = 0; n < 120 && !recovered; n++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(recovered, true);
  await first.workQueue;
  assert.equal(lane.inspectionError, null); assert.equal(lane.blockedBy, null);
  assert.equal(existsSync(record), false);
});

// ── Recovery on Resume (continue by default, part b) ──
// Waits (at most 10 seconds) until `ready()` is true.
async function eventually(ready) {
  for (const t0 = Date.now(); !ready();) { if (Date.now() - t0 > 10000) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
const savedWork = async (cwd, name) => { const { readFileSync } = await import('node:fs'); return JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8')).work; };

test('a worker task cut off with a clean worktree: Resume reports it and the task never started; the worker is told once; "Result unknown" without a starting commit', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('work-crash-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'work-1');
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-thread' }); // a real Codex turn sets it
  await handleLine('plan it', ctx);
  const name = ctx.discussion.name, file = await checkpointPath(cwd, name);
  ctx.worker.turn = () => new Promise(() => {}); // the process "crashes" during this turn
  queueWork(ctx, 'first task\nwith details');
  queueWork(ctx, 'second task');
  let work;
  await eventually(() => { work = JSON.parse(readFileSync(file, 'utf8')).work; return !!work?.running?.before; });
  assert.deepEqual([work.running.task, work.queued.map((r) => r.task)], ['first task\nwith details', ['second task']]);
  const crashed = readFileSync(file, 'utf8');

  // A new process: Resume reports both, in the Worker tab and in the chat.
  const after = await savedRoom(cwd, 'work-2');
  const prompts = [];
  await handleLine('/resume ' + name, after);
  after.worker.turn = async (p) => { prompts.push(p); return 'ok'; };
  const notes = after.screen.worker.filter((m) => m.note).map((m) => m.note);
  assert.match(notes[0], new RegExp(`^✗ Interrupted: \\[${name}\\] "first task" \\(started \\d\\d:\\d\\d\\) left no commits or edits in the worktree\\. It may still have written notes elsewhere`));
  assert.match(notes[1], new RegExp(`^✗ Not started: \\[${name}\\] "second task" was still queued when the room stopped\\. Nothing was re-sent`));
  const chat = after.state.transcript.at(-1);
  assert.equal(chat.speaker, 'agent-room');
  assert.match(chat.text, /Interrupted: [\s\S]*Not started: /);
  assert.deepEqual(await savedWork(cwd, name), { queued: [], running: null, interrupted: [{ ...work.running, at: work.running.at, reported: true }], notStarted: [] });
  // The next instruction from this discussion carries the notice, once.
  queueWork(after, 'next task');
  await after.workQueue;
  assert.match(prompts[0], /^\[your reported usage this session: [^\]]+\]\n\nYour previous instruction "first task" was interrupted by a Restart, Quit or a crash: check the worktree before continuing\./);
  queueWork(after, 'another task');
  await after.workQueue;
  assert.doesNotMatch(prompts[1], /was interrupted/);
  assert.deepEqual((await savedWork(cwd, name)).interrupted, []);

  // Cut off before its starting commit was recorded: the result is unknown.
  const early = JSON.parse(crashed);
  early.work.running.before = null;
  writeFileSync(file, JSON.stringify(early));
  const third = await savedRoom(cwd, 'work-3');
  await handleLine('/resume ' + name, third);
  assert.match(third.screen.worker.find((m) => m.note).note,
    new RegExp(`^✗ Result unknown: \\[${name}\\] "first task" \\(started \\d\\d:\\d\\d\\) was interrupted before its starting point was recorded\\. Check the worktree \\(it is clean\\)\\.$`));
});

test('a worker task cut off after an edit: Resume reports the uncommitted edits, and the queue holds for that discussion', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { queueWork, recoverWorkerOwner } = await import('../src/ui.mjs');
  const cwd = await tmp('work-edit-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'edit-1');
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-thread' }); // a real Codex turn sets it
  await handleLine('plan it', ctx);
  const name = ctx.discussion.name, file = await checkpointPath(cwd, name);
  let edited = null;
  ctx.worker.turn = () => { edited = join(ctx.workerDir.path, 'half.txt'); writeFileSync(edited, 'half done'); return new Promise(() => {}); };
  queueWork(ctx, 'edit things');
  await eventually(() => edited && existsSync(edited) && !!JSON.parse(readFileSync(file, 'utf8')).work?.running?.before);

  const after = await savedRoom(cwd, 'edit-2');
  await handleLine('/resume ' + name, after);
  assert.match(after.screen.worker.find((m) => m.note).note,
    new RegExp(`^✗ Interrupted by Restart, Quit or a crash: \\[${name}\\] "edit things" \\(started \\d\\d:\\d\\d\\) left uncommitted edits in the worktree\\. Ask the worker to finish and commit them, or to abandon them\\.$`));
  await recoverWorkerOwner(after);
  assert.deepEqual([workerLane(after).blockedBy?.origin, workerLane(after).blockedBy?.label, workerLane(after).blockedBy?.task], [after, name, 'edit things']);
});

test('an interrupted round: Resume says the transcript grew after the checkpoint; every restore tells the agents once; an unstarted Claude session gets a new ID', async () => {
  const { readFileSync } = await import('node:fs');
  const cwd = await tmp('round-crash-');
  const ctx = await savedRoom(cwd, 'round-1');
  Object.assign(ctx.sessions.get('A'), { id: 'never-started', started: false });
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-thread' });
  Object.assign(ctx.sessions.get('worker:W'), { id: 'worker-session', started: true });
  await handleLine('first', ctx);
  const name = ctx.discussion.name, transcript = ctx.logPath;
  ctx.room.agents[0].turn = () => new Promise(() => {});
  handleLine('cut off', ctx); // the process "crashes" during this round
  await eventually(() => readFileSync(transcript, 'utf8').includes('cut off'));

  const said = [];
  const console_log = console.log;
  console.log = (...a) => { said.push(a.join(' ')); };
  let after;
  try {
    after = await savedRoom(cwd, 'round-2');
    await handleLine('/resume ' + name, after);
  } finally { console.log = console_log; }
  assert.ok(said.some((l) => /✗ The transcript grew after the checkpoint of .*\. What was written after it is not in the restored chat; it is in the transcript file \(from line \d+\)\. The agents may remember some of it\./.test(l)));
  assert.match(readFileSync(transcript, 'utf8'), /_\(restored from the checkpoint of .*; the transcript had grown after it\)_/);
  assert.doesNotMatch(after.state.transcript.map((m) => m.text).join('\n'), /cut off/);
  assert.notEqual(after.sessions.get('A').id, 'never-started');
  assert.deepEqual([after.sessions.get('B').threadId, after.sessions.get('worker:W').id], ['codex-thread', 'worker-session']);
  const prompts = [];
  for (const a of after.room.agents) a.turn = async (p) => { prompts.push([a.name, p]); return 'PASS'; };
  await handleLine('again', after);
  const restored = /^agent-room restored this discussion from its checkpoint of .*\. If you remember turns after that, they are not in the room's record\.$/m;
  assert.deepEqual(prompts.filter(([, p]) => restored.test(p)).map(([n]) => n), ['A', 'B']); // each agent's next prompt
  prompts.length = 0;
  await handleLine('later', after);
  assert.ok(prompts.length && !prompts.some(([, p]) => restored.test(p))); // only that one

  // No growth: no notice, but the agents are still told.
  await handleLine('/new', after);
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  let third;
  try {
    third = await savedRoom(cwd, 'round-3');
    await handleLine('/resume ' + name, third);
  } finally { console.log = console_log; }
  assert.ok(!lines.some((l) => /transcript grew/.test(l)));
  const more = [];
  for (const a of third.room.agents) a.turn = async (p) => { more.push(p); return 'PASS'; };
  await handleLine('once more', third);
  assert.match(more[0], restored);
});

test('Quit room during a worker task: the stopped task is kept as interrupted, the queued one as not started, and Resume reports both', async () => {
  const { readFileSync } = await import('node:fs');
  const { queueWork, stopRoom } = await import('../src/ui.mjs');
  const cwd = await tmp('work-quit-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'quit-1');
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-thread' }); // a real Codex turn sets it
  await handleLine('plan it', ctx);
  const name = ctx.discussion.name, file = await checkpointPath(cwd, name);
  let stop;
  ctx.worker.turn = () => new Promise((_, fail) => { stop = fail; });
  queueWork(ctx, 'long task');
  queueWork(ctx, 'waiting task');
  await eventually(() => !!stop && !!JSON.parse(readFileSync(file, 'utf8')).work?.running?.before);
  const quitting = stopRoom(ctx); // as Quit room does; the worker's program is stopped
  stop(new Error('claude was stopped (SIGTERM)'));
  await quitting;
  const work = JSON.parse(readFileSync(file, 'utf8')).work;
  assert.deepEqual([work.running, work.queued, work.interrupted.map((r) => r.task), work.notStarted.map((r) => r.task)],
    [null, [], ['long task'], ['waiting task']]);

  const after = await savedRoom(cwd, 'quit-2');
  await handleLine('/resume ' + name, after);
  const notes = after.screen.worker.filter((m) => m.note).map((m) => m.note);
  assert.match(notes[0], new RegExp(`^✗ Interrupted: \\[${name}\\] "long task" `));
  assert.match(notes[1], new RegExp(`^✗ Not started: \\[${name}\\] "waiting task" `));
});

test('a worker task from a discussion with no full checkpoint yet is recorded too, and reported on the next Resume', async () => {
  const { readFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('work-unsaved-');
  await gitRoom(cwd);
  mkdirSync(`${cwd}/discussions/2026-11-01-old`, { recursive: true });
  const ctx = await savedRoom(cwd, 'unsaved-1');
  await handleLine('/resume 2026-11-01-old', ctx); // no checkpoint: from its handoff, no message yet
  const file = await checkpointPath(cwd, '2026-11-01-old');
  assert.equal(existsSync(file), false);
  ctx.worker.turn = () => new Promise(() => {}); // the process "crashes" during this turn
  queueWork(ctx, 'early task');
  let saved;
  await eventually(() => existsSync(file) && !!(saved = JSON.parse(readFileSync(file, 'utf8'))).work?.running?.before);
  assert.deepEqual([saved.fresh, saved.summary, saved.sessions, saved.work.running.task], [true, null, undefined, 'early task']);
  assert.deepEqual(ctx.screen.room.checkpoints.find((c) => c.name === '2026-11-01-old'), { name: '2026-11-01-old', at: saved.at, kind: 'fresh', summary: false, title: '2026-11-01-old' });

  const after = await savedRoom(cwd, 'unsaved-2');
  await handleLine('/resume 2026-11-01-old', after);
  assert.equal(after.discussion.name, '2026-11-01-old');
  assert.ok(!after.logPath); // still from its handoff
  assert.match(after.screen.worker.find((m) => m.note).note,
    /^✗ Interrupted: \[2026-11-01-old\] "early task" \(started \d\d:\d\d\) left no commits or edits in the worktree\./);
  assert.match(after.state.transcript.at(-1)?.text ?? '', /Interrupted: \[2026-11-01-old\] "early task"/);
});


test('worker notes follow their captured owner, including brainstorms and room-wide events', async () => {
  const docs = await import('../src/docs.mjs');
  const eventsA = [], eventsB = [];
  const screen = (events) => ({ transcript: [], worker: [], clients: new Set([{ write: (s) => events.push(JSON.parse(s.slice(6))) }]) });
  const a = { cwd: '/tmp/routing', id: 'a', state: { transcript: [] }, discussion: { name: 'alpha' }, screen: screen(eventsA), docs };
  const b = { cwd: a.cwd, id: 'b', state: { transcript: [] }, discussion: { name: 'beta' }, screen: screen(eventsB), docs };
  const hub = { rooms: new Map([['a', a], ['b', b]]) }; a.hub = b.hub = hub;
  workNote(a, 'alpha note');
  workNote(b, 'beta note');
  assert.deepEqual(eventsA.map((e) => e.message.note), ['alpha note']);
  assert.deepEqual(eventsB.map((e) => e.message.note), ['beta note']);
  assert.deepEqual(docs.resetEvent(a.screen).worker.map((m) => m.note), ['alpha note']);
  assert.deepEqual(docs.resetEvent(b.screen).worker.map((m) => m.note), ['beta note']);
  a.discussion = { name: 'gamma' };
  workNote(a, 'late note', true, null, 'alpha');
  assert.deepEqual(docs.resetEvent(a.screen).worker, []);
  a.discussion = { name: 'alpha' };
  assert.equal(docs.resetEvent(a.screen).worker.at(-1).note, 'late note');
  workNote(a, 'all workers', true, null, 'alpha', true);
  assert.equal(eventsA.at(-1).message.note, 'all workers');
  assert.equal(eventsB.at(-1).message.note, 'all workers');
  a.discussion = null; a.state.brainstorm = true; a.state.brainstormId = 'one';
  workNote(a, 'first brainstorm');
  a.state.brainstormId = 'two';
  assert.deepEqual(docs.resetEvent(a.screen).worker, []);
});

test('agy is accepted for discussion and worker settings, and its catalog is read with a fallback', async () => {
  const { agyModelCatalog, validateSettings, readDefaults } = await import('../src/ui.mjs');
  const { writeFileSync } = await import('node:fs');
  const settings = { agents: [{ provider: 'agy', name: 'Ada', model: 'gemini-4-argon-high' }],
    worker: { provider: 'agy', name: 'Worker', model: '' } };
  assert.deepEqual(validateSettings(settings), settings);
  const file = `${await tmp('agy-defaults-')}/defaults.json`;
  writeFileSync(file, JSON.stringify(settings));
  assert.deepEqual(readDefaults(file), settings);
  const ctx = { ...freshCtx(), agentSpecs: 'agy:Ada:gemini-4-argon-high', workerSpec: 'agy:Worker' };
  Object.assign(ctx, await load(ctx, '?agy-settings'));
  assert.equal(ctx.room.agents[0].provider, 'agy');
  assert.equal(ctx.worker.provider, 'agy');
  let reply, time = 0, calls = 0;
  const catalog = agyModelCatalog((cmd, args, opts, done) => {
    assert.equal(cmd, 'agy'); assert.deepEqual(args, ['models']); calls++; reply = done;
  }, () => time);
  assert.deepEqual(catalog(), []); // request starts but the panel does not wait
  assert.deepEqual(catalog(), []);
  assert.equal(calls, 1);
  reply(null, 'Fetching available models...\ngemini-one\tGemini One\ninvalid entry\n');
  assert.deepEqual(catalog(), [{ id: 'gemini-one', label: 'Gemini One' }]);
  time += 300_000;
  assert.deepEqual(catalog(), [{ id: 'gemini-one', label: 'Gemini One' }]);
  assert.equal(calls, 2);
  reply(new Error('missing'));
  assert.deepEqual(catalog(), [{ id: 'gemini-one', label: 'Gemini One' }]);
  assert.equal(calls, 2);
  time += 300_000;
  catalog(); reply(null, 'gemini-two\tGemini Two\n');
  assert.deepEqual(catalog(), [{ id: 'gemini-two', label: 'Gemini Two' }]);
});

test('agy rulebook delivery state survives a saved checkpoint for both roles', async () => {
  const { readFileSync } = await import('node:fs');
  const cwd = await tmp('agy-checkpoint-');
  const ctx = { ...freshCtx(), cwd, agentSpecs: 'agy:A', workerSpec: 'agy:W', noScreen: true };
  Object.assign(ctx, await load(ctx, '?agy-checkpoint'));
  ctx.suggestTitle = async () => ({ title: 'Agy checkpoint' });
  ctx.room.agents[0].turn = async () => 'PASS';
  Object.assign(ctx.sessions.get('A'), { conversationId: 'talk-id', receivedInstructions: 'talk-rules' });
  Object.assign(ctx.sessions.get('worker:W'), { conversationId: 'work-id', receivedInstructions: 'work-rules' });
  ctx.state.summaries = 3;
  await handleLine('hello', ctx);
  const name = ctx.discussion.name;
  const saved = JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8'));
  assert.deepEqual(new Map(saved.sessions).get('A'), { conversationId: 'talk-id', receivedInstructions: 'talk-rules' });
  assert.deepEqual(new Map(saved.sessions).get('worker:W'), { conversationId: 'work-id', receivedInstructions: 'work-rules' });
  await handleLine('/new', ctx);
  await handleLine('/resume ' + name, ctx);
  assert.deepEqual(ctx.sessions.get('A'), { conversationId: 'talk-id', receivedInstructions: 'talk-rules' });
  assert.deepEqual(ctx.sessions.get('worker:W'), { conversationId: 'work-id', receivedInstructions: 'work-rules' });
});

test('agy model lookup failure keeps the initial fallback and is throttled', async () => {
  const { agyModelCatalog } = await import('../src/ui.mjs');
  let calls = 0, finish;
  const catalog = agyModelCatalog((cmd, args, opts, done) => { calls++; finish = done; }, () => 0);
  assert.deepEqual(catalog(), []);
  finish(new Error('not installed'));
  assert.deepEqual(catalog(), []);
  assert.equal(calls, 1);
});

test('started discussion settings preserve the local worker and permit names from future agent defaults', async () => {
  const { saveSettings, readDefaults } = await import('../src/ui.mjs');
  const ctx = { ...freshCtx(), workerSpec: 'claude:W' };
  Object.assign(ctx, await load(ctx, '?worker-local-settings'));
  const file = `${await tmp('local-settings-')}/defaults.json`;
  const currentAgents = [{ provider: 'claude', name: 'A', model: '' }, { provider: 'codex', name: 'B', model: '' }];
  const futureAgents = [{ provider: 'claude', name: 'Future', model: '' }];
  const defaultWorker = { provider: 'claude', name: 'W', model: '' };
  await saveSettings(ctx, { agents: currentAgents, worker: defaultWorker }, file);
  ctx.agentsStarted = true;
  await saveSettings(ctx, { agents: futureAgents, worker: defaultWorker, scope: 'talk' }, file);
  const localWorker = { provider: 'agy', name: 'Future', model: 'model' };
  await saveSettings(ctx, { agents: futureAgents, worker: localWorker, scope: 'work' }, file);
  assert.equal(ctx.workerSpec, 'agy:Future:model');
  assert.deepEqual(readDefaults(file), { agents: futureAgents, worker: defaultWorker });
  const laterAgents = [{ provider: 'claude', name: 'Next', model: '' }];
  await saveSettings(ctx, { agents: laterAgents, worker: defaultWorker, scope: 'talk' }, file);
  assert.equal(ctx.workerSpec, 'agy:Future:model');
  assert.deepEqual(readDefaults(file), { agents: laterAgents, worker: defaultWorker });
});

test('new screen discussions and terminal sessions use the saved worker default', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const home = await tmp('worker-default-home-'), before = process.env.HOME;
  process.env.HOME = home;
  try {
    const defaults = { agents: [{ provider: 'claude', name: 'A', model: '' }, { provider: 'claude', name: 'B', model: '' }],
      worker: { provider: 'codex', name: 'W', model: 'default-model' } };
    mkdirSync(join(home, '.config', 'agent-room'), { recursive: true });
    writeFileSync(join(home, '.config', 'agent-room', 'defaults.json'), JSON.stringify(defaults));
    const { first, hub } = await multiRoom();
    await handleLine('topic', first);
    first.shop.launchDefaults = { agents: 'claude:A,claude:B', worker: 'codex:W:default-model' };
    first.agentSpecs = 'claude:A,claude:B'; first.workerSpec = 'agy:W:local-model';
    let options;
    const add = hub.addRoom;
    hub.addRoom = async (folder, opts) => { options = opts; return add(folder, opts); };
    await handleLine('/new', first);
    assert.equal(options.worker, 'codex:W:default-model');

    const terminal = await savedRoom(await tmp('worker-default-terminal-'), 'worker-default-terminal');
    await handleLine('topic', terminal);
    terminal.workerSpec = 'agy:W:local-model';
    await handleLine('/new', terminal);
    assert.equal(terminal.workerSpec, 'claude:W');
    assert.equal(terminal.worker.provider, 'claude');
  } finally { process.env.HOME = before; }
});

test('a started worker-only change leaves an absent defaults file absent', async () => {
  const { existsSync } = await import('node:fs');
  const { saveSettings } = await import('../src/ui.mjs');
  const ctx = { ...freshCtx(), workerSpec: 'claude:W' };
  Object.assign(ctx, await load(ctx, '?no-default-write'));
  ctx.agentsStarted = true;
  const file = `${await tmp('absent-worker-defaults-')}/defaults.json`;
  const agents = [{ provider: 'claude', name: 'A', model: '' }, { provider: 'codex', name: 'B', model: '' }];
  await saveSettings(ctx, { agents, worker: { provider: 'agy', name: 'W', model: '' }, scope: 'work' }, file);
  assert.equal(existsSync(file), false);
  assert.equal(ctx.workerSpec, 'agy:W:');
  assert.equal(ctx.shop.launchDefaults.worker, 'claude:W');
});

test('open discussions keep their members and sessions; new and resumed discussions use their own sets', async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { saveSettings } = await import('../src/ui.mjs');
  const home = await tmp('members-home-'), before = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = await tmp('members-room-'), hub = { rooms: new Map() };
    const create = async (context, agents, worker) => {
      const ctx = { cwd, context, key: cwd + (context ? '#' + context : ''), hub, noScreen: false,
        agentSpecs: agents, workerSpec: worker, state: { transcript: [], seen: new Map() }, sessions: new Map() };
      Object.assign(ctx, await load(ctx, '?members-' + (context ?? 'first')));
      ctx.suggestTitle = async (text) => ({ title: text });
      for (const a of ctx.room.agents) a.turn = async () => { ctx.sessions.get(a.name).started = true; return 'PASS'; };
      hub.rooms.set(ctx.key, ctx);
      return ctx;
    };
    const first = await create(null, 'claude:A,claude:B', 'claude:W');
    hub.addRoom = async (folder, opts) => ({ ctx: await create(opts.context, opts.agents, opts.worker) });
    await handleLine('first topic', first);
    const firstIds = [first.sessions.get('A'), first.sessions.get('B')];
    const future = { agents: [{ provider: 'claude', name: 'C', model: '' }, { provider: 'claude', name: 'D', model: '' }, { provider: 'claude', name: 'E', model: '' }],
      worker: { provider: 'claude', name: 'W', model: '' }, scope: 'talk' };
    await saveSettings(first, future);
    assert.deepEqual(first.room.agents.map((a) => a.name), ['A', 'B']);
    assert.equal(first.sessions.get('A'), firstIds[0]);
    await handleLine('/new', first);
    const second = [...hub.rooms.values()].find((c) => c !== first);
    assert.deepEqual(second.room.agents.map((a) => a.name), ['C', 'D', 'E']);
    await handleLine('second topic', second);
    const name = second.discussion.name, checkpoint = JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8'));
    assert.equal(checkpoint.agentSpecs, 'claude:C:,claude:D:,claude:E:');
    assert.deepEqual(first.room.agents.map((a) => a.name), ['A', 'B']);
    assert.deepEqual([first.sessions.get('A'), first.sessions.get('B')], firstIds);
    // The next defaults change cannot replace either open discussion's sessions.
    const ids = second.room.agents.map((a) => second.sessions.get(a.name));
    await saveSettings(second, { ...future, agents: future.agents.slice(0, 2) });
    assert.deepEqual(second.room.agents.map((a) => a.name), ['C', 'D', 'E']);
    assert.deepEqual(second.room.agents.map((a) => second.sessions.get(a.name)), ids);
    const savedIds = ids.map((s) => s.id);
    second.noScreen = true;
    await handleLine('/new', second);
    await handleLine('/resume ' + name, second);
    assert.deepEqual(second.room.agents.map((a) => a.name), ['C', 'D', 'E']);
    assert.deepEqual(second.room.agents.map((a) => second.sessions.get(a.name).id), savedIds);
  } finally { process.env.HOME = before; }
});

test('launch defaults follow flags and panel changes per folder, without changing other rooms', async () => {
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { saveSettings } = await import('../src/ui.mjs');
  const home = await tmp('launch-defaults-home-'), before = process.env.HOME;
  process.env.HOME = home;
  try {
    const file = join(home, '.config', 'agent-room', 'defaults.json');
    const saved = { agents: [{ provider: 'claude', name: 'SavedA', model: '' }, { provider: 'codex', name: 'SavedB', model: '' }],
      worker: { provider: 'claude', name: 'SavedW', model: '' } };
    mkdirSync(join(home, '.config', 'agent-room'), { recursive: true });
    writeFileSync(file, JSON.stringify(saved));
    const folderA = await tmp('launch-room-a-'), folderB = await tmp('launch-room-b-');
    const hub = { rooms: new Map() }, options = [];
    const make = async (cwd, context, agents, worker) => {
      const ctx = { cwd, context, key: cwd + (context ? '#' + context : ''), hub, noScreen: false,
        agentSpecs: agents, workerSpec: worker, state: { transcript: [], seen: new Map() }, sessions: new Map() };
      Object.assign(ctx, await load(ctx, '?launch-' + (context ?? cwd)));
      ctx.suggestTitle = async () => ({ title: 'topic' });
      for (const a of ctx.room.agents) a.turn = async () => 'PASS';
      hub.rooms.set(ctx.key, ctx);
      return ctx;
    };
    hub.addRoom = async (folder, opts) => { options.push(opts); return { ctx: await make(folder, opts.context, opts.agents, opts.worker) }; };
    const first = await make(folderA, null, 'claude:FlagA,codex:FlagB', 'agy:FlagW:chosen');
    const other = await make(folderB, null); // no flags: initialized from defaults.json
    assert.deepEqual(other.shop.launchDefaults, { agents: 'claude:SavedA:,codex:SavedB:', worker: 'claude:SavedW:' });
    first.noScreen = true;
    await handleLine('first message', first);
    await handleLine('/new', first);
    assert.deepEqual([first.agentSpecs, first.workerSpec], ['claude:FlagA,codex:FlagB', 'agy:FlagW:chosen']);
    await handleLine('/brainstorm', first);
    assert.deepEqual([first.agentSpecs, first.workerSpec], ['claude:FlagA,codex:FlagB', 'agy:FlagW:chosen']);
    first.noScreen = false;
    await handleLine('/new', first); // end brainstorm in place
    for (const a of first.room.agents) a.turn = async () => 'PASS';
    await handleLine('second message', first);
    await handleLine('/new', first); // beside
    assert.deepEqual([options.at(-1).agents, options.at(-1).worker], ['claude:FlagA,codex:FlagB', 'agy:FlagW:chosen']);
    const beside = [...hub.rooms.values()].find((c) => c.cwd === folderA && c !== first);
    assert.equal(beside.shop.launchDefaults, first.shop.launchDefaults);
    const memberChange = { agents: [{ provider: 'claude', name: 'NewA', model: '' }, { provider: 'codex', name: 'NewB', model: '' }], worker: saved.worker, scope: 'talk' };
    await saveSettings(first, memberChange, file); // started: members become this folder's defaults
    assert.equal(first.shop.launchDefaults.agents, 'claude:NewA:,codex:NewB:');
    assert.equal(first.shop.launchDefaults.worker, 'agy:FlagW:chosen');
    assert.deepEqual(other.shop.launchDefaults, { agents: 'claude:SavedA:,codex:SavedB:', worker: 'claude:SavedW:' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).worker, saved.worker);
    await handleLine('/new', first);
    assert.deepEqual([options.at(-1).agents, options.at(-1).worker], ['claude:NewA:,codex:NewB:', 'agy:FlagW:chosen']);
    await saveSettings(first, { agents: memberChange.agents, worker: { provider: 'codex', name: 'LocalW', model: '' }, scope: 'work' }, file);
    assert.equal(first.workerSpec, 'codex:LocalW:');
    assert.equal(first.shop.launchDefaults.worker, 'agy:FlagW:chosen');
    await handleLine('/new', first);
    assert.equal(options.at(-1).worker, 'agy:FlagW:chosen');
    // A not-yet-started discussion's worker update changes the folder default, not the other room.
    await saveSettings(beside, { agents: memberChange.agents, worker: { provider: 'claude', name: 'NewW', model: '' }, scope: 'work' }, file);
    assert.equal(first.shop.launchDefaults.worker, 'claude:NewW:');
    assert.equal(other.shop.launchDefaults.worker, 'claude:SavedW:');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).worker.name, 'NewW');
    // A room opened later with no flags reads the saved defaults, not the first folder's old flags.
    const later = await make(await tmp('launch-room-c-'), null);
    assert.equal(later.shop.launchDefaults.worker, 'claude:NewW:');
    assert.equal(later.shop.launchDefaults.agents, 'claude:NewA:,codex:NewB:');
  } finally { process.env.HOME = before; }
});


test('auto dev: retry keeps the failure pause through discussion and resumes the same cycle', async () => {
  const { retryWork, reloaded } = await import('../src/ui.mjs');
  let attempts = 0;
  const room = await autoDevRoom({ summaries: [summaryWith('A'), summaryWith('B', 'WAIT FOR USER')],
    worker: async () => { if (!attempts++) throw new Error('quota'); return 'fixed'; } });
  const promptCount = room.prompts.length;
  await handleLine('/autodev', room.ctx);
  await room.settle();
  assert.equal(room.prompts.length, promptCount); // the failure starts no agent round
  const run = room.ctx.autoDev, failure = room.ctx.retryFailure;
  assert.equal(run.reason, 'the worker failed: Retry or Retry with…');
  assert.equal(run.cycle, 1);
  assert.equal(failure.available, true);
  Object.assign(room.ctx, { code: {}, refreshQuota: () => {} });
  await reloaded(room.ctx);
  await handleLine('let us discuss', room.ctx);
  assert.ok(room.prompts.some((p) => p.includes("The worker's attempt failed: quota")));
  assert.equal(run.reason, 'the worker failed: Retry or Retry with…');
  assert.equal(room.ctx.retryFailure, failure);
  await retryWork(room.ctx, failure.id);
  await room.settle();
  assert.equal(run.cycle, 1);
  assert.equal(run.reason, 'the discussion waits for you (WAIT FOR USER)');
  assert.ok(room.got[1].includes('quota'));
  assert.ok(room.got[1].includes('merge or revert in progress'));
  assert.equal(room.got[1].split('\n').at(-1), 'A');
  assert.ok(room.ctx.state.transcript.some((m) => m.speaker === 'Worker report' && m.text === 'fixed'));
});

test('auto dev: a retry cannot resume a run that ended while it was working', async () => {
  const { retryWork } = await import('../src/ui.mjs');
  let release, attempts = 0;
  const gate = new Promise((r) => { release = r; });
  const room = await autoDevRoom({ summaries: [summaryWith('A')], worker: async () => {
    if (!attempts++) throw new Error('quota'); await gate; return 'fixed';
  } });
  await handleLine('/autodev', room.ctx); await room.settle();
  const run = room.ctx.autoDev;
  await retryWork(room.ctx, room.ctx.retryFailure.id);
  run.status = 'finished';
  release(); await room.settle();
  assert.equal(run.status, 'finished');
  assert.ok(room.ctx.state.transcript.some((m) => m.speaker === 'Worker report' && m.text === 'fixed'));
});

test('retry runs before later queued instructions and reports commits made since the failure', async () => {
  const { queueWork, retryWork } = await import('../src/ui.mjs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  await handleLine('hello', ctx);
  let release, attempts = 0;
  const prompts = [];
  ctx.worker.turn = async (p) => {
    prompts.push(p);
    if (!attempts++) throw new Error('failed once');
    if (p.endsWith('in progress')) return new Promise((r) => { release = r; });
    return 'ok';
  };
  queueWork(ctx, 'original');
  await ctx.workQueue;
  const failure = ctx.retryFailure;
  queueWork(ctx, 'in progress');
  await until(() => release);
  queueWork(ctx, 'later');
  git('-C', ctx.workerDir.path, 'commit', '-q', '--allow-empty', '-m', `[${ctx.discussion.name}] later work`);
  await retryWork(ctx, failure.id);
  release(`done\nDocs: none needed, because test.\nTested: ${git('-C', ctx.workerDir.path, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`);
  await ctx.workQueue;
  assert.deepEqual(prompts.map((p) => p.split('\n').at(-1)), ['original', 'in progress', 'original', 'later']);
  assert.match(prompts[2], /failed once/);
  assert.match(prompts[2], /later work/);
});

test('Retry with applies worker settings for later instructions', async () => {
  const { retryWork, queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('retry-settings-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'retry-settings');
  await handleLine('hello', ctx);
  ctx.worker.turn = async () => { throw new Error('quota'); };
  queueWork(ctx, 'original'); await ctx.workQueue;
  const lane = workerLane(ctx); lane.pumping = true;
  const settings = { agents: [{ provider: 'claude', name: 'A', model: '' }, { provider: 'codex', name: 'B', model: '' }], worker: { provider: 'codex', name: 'W', model: 'gpt-6.1-terra' } };
  await retryWork(ctx, ctx.retryFailure.id, settings);
  assert.equal(ctx.workerSpec, 'codex:W:gpt-6.1-terra');
  assert.equal(ctx.worker.provider, 'codex');
  assert.equal(ctx.workerHandoff, true);
  const got = [];
  ctx.worker.turn = async (prompt) => { got.push(prompt); return 'ok'; };
  lane.pumping = false;
  queueWork(ctx, 'later'); await ctx.workQueue;
  assert.deepEqual(got.map((p) => p.split('\n').at(-1)), ['original', 'later']);
  assert.match(got[0], /Previous Worker-tab conversation/);
  assert.equal(ctx.workerSpec, 'codex:W:gpt-6.1-terra');
});

test('auto dev: restarting while a retry runs cannot resume the old run', async () => {
  const { retryWork } = await import('../src/ui.mjs');
  let release, attempts = 0;
  const gate = new Promise((r) => { release = r; });
  const room = await autoDevRoom({ summaries: [summaryWith('A')], worker: async () => {
    if (!attempts++) throw new Error('quota'); await gate; return 'fixed';
  } });
  await handleLine('/autodev', room.ctx); await room.settle();
  const old = room.ctx.autoDev;
  await retryWork(room.ctx, room.ctx.retryFailure.id);
  room.ctx.state.transcript.push({ speaker: 'Summary', outcome: 'agreed', by: 'A', text: summaryWith('new task') });
  await handleLine('/autodev', room.ctx);
  const restarted = room.ctx.autoDev;
  assert.notEqual(restarted, old);
  // Keep the new run from sending further work when its own report is reviewed.
  restarted.status = 'paused'; restarted.reason = 'test pause';
  release(); await room.settle();
  assert.equal(old.status, 'paused');
  assert.equal(restarted.status, 'paused');
  assert.ok(room.ctx.state.transcript.some((m) => m.speaker === 'Worker report' && m.text === 'fixed'));
});

test('a failed retry offers another retry and keeps the auto dev failure pause', async () => {
  const { retryWork } = await import('../src/ui.mjs');
  let attempts = 0;
  const room = await autoDevRoom({ summaries: [summaryWith('A')], worker: async () => { throw new Error(`failure ${++attempts}`); } });
  await handleLine('/autodev', room.ctx); await room.settle();
  const first = room.ctx.retryFailure;
  await retryWork(room.ctx, first.id);
  assert.equal(first.available, false);
  await room.settle();
  assert.notEqual(room.ctx.retryFailure.id, first.id);
  assert.equal(room.ctx.retryFailure.available, true);
  assert.equal(room.ctx.retryFailure.error, 'failure 2');
  assert.equal(room.ctx.autoDev.reason, 'the worker failed: Retry or Retry with…');
  assert.equal(room.ctx.autoDev.cycle, 1);
});

test('auto dev: a failure during an agent turn reaches that agent with the next message', async () => {
  let failWorker, finishTurn;
  const workerGate = new Promise((resolve) => { failWorker = resolve; });
  const turnGate = new Promise((resolve) => { finishTurn = resolve; });
  const room = await autoDevRoom({ summaries: [summaryWith('A')], worker: async () => { await workerGate; throw new Error('quota'); } });
  const prompts = [];
  room.ctx.room.agents[0].turn = async (p) => { prompts.push(p); if (prompts.length === 1) await turnGate; return 'PASS'; };
  await handleLine('/autodev', room.ctx);
  const round = handleLine('message already in progress', room.ctx);
  await until(() => prompts.length === 1);
  failWorker(); await room.ctx.workQueue;
  assert.equal(room.ctx.autoDev.reason, 'the worker failed: Retry or Retry with…');
  finishTurn(); await round; await room.settle();
  await handleLine('next message', room.ctx);
  assert.ok(prompts.at(-1).includes("The worker's attempt failed: quota"));
});

test('a failed discussion agent can be disabled across Reload and Resume, and enabled again', async () => {
  const { setAgentEnabled, reloaded } = await import('../src/ui.mjs');
  const ctx = await savedRoom(await tmp('disabled-agent-'), 'disabled-agent');
  Object.assign(ctx.sessions.get('A'), { id: 'claude-original', started: true });
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-original' });
  let a = 0, b = 0;
  ctx.room.agents[0].turn = async () => { a++; throw new Error('quota'); };
  ctx.room.agents[1].turn = async () => { b++; return 'PASS'; };
  await handleLine('start', ctx);
  const name = ctx.discussion.name;
  assert.equal(a, 1);
  assert.throws(() => setAgentEnabled(ctx, 'B', false), /Only a failed agent/);
  setAgentEnabled(ctx, 'A', false);
  assert.deepEqual(ctx.state.disabledAgents, ['A']);
  assert.equal(ctx.screen.room.failedAgents[0].disabled, true);
  await handleLine('continue', ctx);
  assert.equal(a, 1); assert.equal(b, 1);
  await handleLine('@A hello', ctx);
  assert.equal(a, 1); assert.equal(b, 1);
  await handleLine('/summary', ctx);
  assert.equal(a, 1); assert.equal(b, 2);
  Object.assign(ctx, await load(ctx, ''));
  await reloaded(ctx);
  assert.deepEqual(ctx.state.disabledAgents, ['A']);
  await handleLine('/new', ctx);
  await handleLine('/resume ' + name, ctx);
  assert.deepEqual(ctx.state.disabledAgents, ['A']);
  ctx.room.agents[0].turn = async () => { a++; return 'PASS'; };
  ctx.room.agents[1].turn = async () => { b++; return 'PASS'; };
  setAgentEnabled(ctx, 'A', true);
  assert.deepEqual(ctx.state.disabledAgents, []);
  await handleLine('both again', ctx);
  assert.equal(a, 2);
  setAgentEnabled(ctx, 'A', false);
  ctx.state.transcript.push({ speaker: 'B', text: 'failed too', error: true });
  assert.throws(() => setAgentEnabled(ctx, 'B', false), /At least one/);
});

// ── Saved brainstorms ──
// A terminal room on the three providers' real adapters (turns scripted), with their session IDs set
// as real turns would set them.
async function brainstormRoom(cwd, tag) {
  const ctx = { cwd, agentSpecs: 'claude:A,codex:B,agy:C', workerSpec: 'claude:W', noScreen: true,
    state: { transcript: [], seen: new Map() }, sessions: new Map() };
  Object.assign(ctx, await load(ctx, `?${tag}`));
  ctx.suggestTitle = async () => ({ title: 'An idea' });
  ctx.prompts = [];
  stubTurns(ctx);
  Object.assign(ctx.sessions.get('A'), { id: 'claude-1', started: true });
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-1' });
  Object.assign(ctx.sessions.get('C'), { conversationId: 'agy-1' });
  return ctx;
}
// Scripted turns, again after each Resume (it builds the room anew): never a real CLI.
const stubTurns = (ctx) => { for (const agent of ctx.room.agents) agent.turn = async (p) => { ctx.prompts.push([agent.name, p]); return 'PASS'; }; };
const sessionIds = (ctx) => [ctx.sessions.get('A').id, ctx.sessions.get('B').threadId, ctx.sessions.get('C').conversationId];

test('a brainstorm saves its checkpoint under brainstorms/<name>, without a worker part; Resume and Restart bring it back with its sessions and chat', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const cwd = await tmp('brain-save-');
  const ctx = await brainstormRoom(cwd, 'brain-save');
  await handleLine('/brainstorm', ctx);
  await handleLine('first idea', ctx);
  const name = ctx.discussion.name, ref = `brainstorms/${name}`;
  assert.equal(existsSync(await checkpointPath(cwd, name)), false); // not under a discussion's key
  const saved = JSON.parse(readFileSync(await checkpointPath(cwd, ref), 'utf8'));
  assert.equal(saved.brainstorm, true);
  assert.deepEqual([saved.workerSpec, saved.worker, saved.work, saved.workerSeat], [undefined, undefined, undefined, undefined]);
  assert.ok(!saved.sessions.some(([k]) => k.startsWith('worker:')));
  assert.deepEqual(ctx.screen.room.checkpoints.find((c) => c.name === ref), { name: ref, at: saved.at, kind: 'full', title: 'An idea' });
  // Restart: the context comes back with /resume brainstorms/<name>.
  assert.ok(restartArgs([ctx], {}, 5566).join(' ').includes(`--reopen ${ref}`));
  const again = await brainstormRoom(cwd, 'brain-save-2');
  for (const k of ['A', 'B', 'C']) again.sessions.set(k, {}); // a new process: nothing in memory
  Object.assign(again, await load(again, '?brain-save-3'));
  for (const agent of again.room.agents) agent.turn = async (p) => { again.prompts.push([agent.name, p]); return 'PASS'; };
  await handleLine(`/resume ${ref}`, again);
  stubTurns(again);
  assert.deepEqual([again.state.brainstorm, again.discussion.name, again.discussion.title, again.screen.room.active], [true, name, 'An idea', ref]);
  assert.deepEqual(sessionIds(again), ['claude-1', 'codex-1', 'agy-1']);
  assert.deepEqual(again.state.transcript.map((m) => m.text), ['first idea', 'PASS', 'PASS', 'PASS']);
  await handleLine('second idea', again);
  assert.match(again.prompts[0][1], /restored this brainstorm from its checkpoint/);
  assert.match(readFileSync(again.logPath, 'utf8'), /first idea[\s\S]*second idea/);
  // Close, then Resume from Brainstorms: the same again.
  await handleLine('/close', again);
  assert.equal(again.discussion, null);
  await handleLine(`/resume ${ref}`, again);
  assert.deepEqual([again.state.brainstorm, again.state.transcript.length], [true, 8]);
});

test('an existing discussion checkpoint, saved before brainstorms had their own, still loads under its name', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { realpathSync } = await import('node:fs');
  const cwd = await tmp('old-checkpoint-');
  const name = '2026-11-01-old-topic', dir = `${realpathSync(cwd)}/discussions/${name}`;
  mkdirSync(`${dir}/transcripts`, { recursive: true });
  writeFileSync(`${dir}/transcripts/session-2026-11-01-1000.md`, '# old\n\n');
  const file = await checkpointPath(cwd, name);
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, root: realpathSync(cwd), at: '2026-11-01T10:00:00.000Z',
    discussion: { name, dir, title: 'Old topic', continued: false }, agentSpecs: 'claude:A,codex:B', workerSpec: 'claude:W',
    sessions: [['A', { id: 'claude-old', started: true }], ['B', { threadId: 'codex-old' }], ['worker:W', { id: 'w-old', started: true }]],
    state: { transcript: [{ speaker: 'User', text: 'old words' }], seen: [['A', 1], ['B', 1]] },
    logPath: `${dir}/transcripts/session-2026-11-01-1000.md`, totals: {}, doc: null, worker: [], workerSeat: 'seat' }));
  const ctx = await savedRoom(cwd, 'old-checkpoint');
  await handleLine(`/resume ${name}`, ctx);
  assert.deepEqual([ctx.discussion.name, ctx.state.brainstorm, ctx.sessions.get('A').id, ctx.sessions.get('B').threadId, ctx.sessions.get('worker:W').id],
    [name, undefined, 'claude-old', 'codex-old', 'w-old']);
  assert.deepEqual(ctx.state.transcript.map((m) => m.text), ['old words']);
  assert.deepEqual(ctx.screen.room.checkpoints.map((c) => c.name), [name]);
});

test('Turn into a discussion, closed: the folder and checkpoint move, never over an existing folder; Resume keeps each provider\'s session and tells each agent once', async () => {
  const { readFileSync, existsSync, mkdirSync, readdirSync, rmdirSync } = await import('node:fs');
  const cwd = await tmp('convert-closed-');
  const ctx = await brainstormRoom(cwd, 'convert-closed');
  await handleLine('/brainstorm', ctx);
  await handleLine('an idea', ctx);
  const name = ctx.discussion.name, ref = `brainstorms/${name}`;
  mkdirSync(`${cwd}/brainstorms/${name}/drawings`); // agents drew
  await handleLine('/new', ctx); // closes it (terminal)
  // A discussion folder of that name already exists: nothing moves.
  mkdirSync(`${cwd}/discussions/${name}`, { recursive: true });
  ctx.notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (screen, ev) => { if (ev.type === 'note') ctx.notes.push(ev.text); } };
  await handleLine(`/convert ${ref}`, ctx);
  assert.match(ctx.notes.at(-1), /can't become a discussion: discussions\/.* already exists\. Nothing was moved/);
  assert.ok(existsSync(`${cwd}/brainstorms/${name}/transcripts`));
  assert.ok(existsSync(await checkpointPath(cwd, ref)));
  rmdirSync(`${cwd}/discussions/${name}`);
  await handleLine(`/convert ${ref}`, ctx);
  assert.equal(existsSync(`${cwd}/brainstorms/${name}`), false);
  assert.deepEqual(readdirSync(`${cwd}/discussions/${name}`).sort(), ['drawings', 'transcripts']);
  assert.equal(existsSync(await checkpointPath(cwd, ref)), false);
  const saved = JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8'));
  assert.equal(saved.brainstorm, undefined);
  assert.equal(saved.state.brainstorm, false);
  ctx.prompts.length = 0;
  await handleLine(`/resume ${name}`, ctx);
  stubTurns(ctx);
  assert.deepEqual([ctx.state.brainstorm, ctx.discussion.name, ctx.discussion.dir.endsWith(`discussions/${name}`)], [false, name, true]);
  assert.deepEqual(sessionIds(ctx), ['claude-1', 'codex-1', 'agy-1']); // Claude, Codex and agy sessions kept
  assert.notEqual(ctx.sessions.get('worker:W').started, true); // the worker starts fresh
  await handleLine('carry on', ctx);
  await handleLine('and again', ctx);
  const told = (agent) => ctx.prompts.filter(([a, p]) => a === agent && p.includes('turned this brainstorm into a discussion')).length;
  for (const agent of ['A', 'B', 'C']) {
    assert.equal(told(agent), 1);
    assert.ok(ctx.prompts.find(([a]) => a === agent)[1].includes(`Its folder is now ${ctx.discussion.dir}`));
  }
  assert.match(ctx.logPath, new RegExp(`discussions/${name}/transcripts/`));
});

test('Turn into a discussion, open: its session goes on in discussions/<name>/ with the same sessions, each agent told once; then the worker can be sent work', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const cwd = await tmp('convert-open-');
  const ctx = await brainstormRoom(cwd, 'convert-open');
  await handleLine('/brainstorm', ctx);
  await handleLine('an idea', ctx);
  const name = ctx.discussion.name, ids = sessionIds(ctx), said = ctx.state.transcript.length;
  await handleLine(`/convert brainstorms/${name}`, ctx);
  assert.deepEqual([ctx.state.brainstorm, ctx.screen.room.brainstorm, ctx.screen.room.active], [false, false, `discussions/${name}`]);
  assert.equal(existsSync(`${cwd}/brainstorms/${name}`), false);
  assert.match(ctx.logPath, new RegExp(`discussions/${name}/transcripts/`));
  assert.deepEqual(sessionIds(ctx), ids);
  assert.equal(ctx.state.transcript.length, said); // the chat goes on
  ctx.prompts.length = 0;
  await handleLine('next', ctx);
  await handleLine('more', ctx);
  for (const agent of ['A', 'B', 'C']) assert.equal(ctx.prompts.filter(([a, p]) => a === agent && p.includes(`turned this brainstorm into a discussion. Its folder is now ${ctx.discussion.dir}`)).length, 1);
  assert.match(readFileSync(ctx.logPath, 'utf8'), /an idea[\s\S]*turned into a discussion[\s\S]*more/);
  assert.equal(JSON.parse(readFileSync(await checkpointPath(cwd, name), 'utf8')).state.brainstorm, false);
});

test('Delete: refused while the brainstorm is open (here or beside), otherwise its folder and checkpoint are removed', async () => {
  const { existsSync } = await import('node:fs');
  const { first, contexts, settle } = await multiRoom();
  await handleLine('/brainstorm', first);
  await handleLine('idea', first);
  const name = first.discussion.name, ref = `brainstorms/${name}`;
  await handleLine('/new', first); await settle();
  const other = contexts().at(-1);
  await handleLine(`/delete ${ref}`, other);
  assert.match(other.notes.at(-1), /is open: close it before deleting it\. Nothing was deleted/);
  assert.ok(existsSync(`${first.cwd}/brainstorms/${name}`));
  await handleLine(`/delete ${ref}`, first);
  assert.ok(existsSync(`${first.cwd}/brainstorms/${name}`));
  // The page's button: disabled while open, two clicks with the warning otherwise.
  const page = (await import('node:fs')).readFileSync(new URL('../src/docs.mjs', import.meta.url), 'utf8');
  assert.match(page, /del\.disabled = isCurrent \|\| !!openHere;/);
  assert.match(page, /confirmed\(del, .*'Click again: its folder \(transcripts, drawings\) and checkpoint are removed; uncommitted files are lost for good', \(\) => true\)/);
  first.stopped = true; // closed
  await handleLine(`/delete ${ref}`, other);
  assert.equal(existsSync(`${first.cwd}/brainstorms/${name}`), false);
  assert.match(other.notes.at(-1), /Deleted the brainstorm/);
});

test('the members panel leaves any agent of a started discussion out, from its next round, and brings it back', async () => {
  const { setAgentEnabled } = await import('../src/ui.mjs');
  const ctx = await savedRoom(await tmp('member-off-'), 'member-off');
  assert.throws(() => setAgentEnabled(ctx, 'B', false, { member: true }), /Before the discussion starts/);
  let a = 0, b = 0;
  ctx.room.agents[0].turn = async () => { a++; return 'PASS'; };
  ctx.room.agents[1].turn = async () => { b++; return 'PASS'; };
  await handleLine('start', ctx);
  assert.equal(a, 1); assert.equal(b, 1);
  assert.deepEqual(ctx.screen.room.members.map((m) => [m.name, m.enabled]), [['A', true], ['B', true]]);
  // Not failed, yet the panel can leave it out; the failed-agent notice still can't.
  assert.throws(() => setAgentEnabled(ctx, 'B', false), /Only a failed agent/);
  setAgentEnabled(ctx, 'B', false, { member: true });
  assert.deepEqual(ctx.state.disabledAgents, ['B']);
  assert.deepEqual(ctx.screen.room.members.map((m) => m.enabled), [true, false]);
  assert.throws(() => setAgentEnabled(ctx, 'A', false, { member: true }), /At least one/);
  await handleLine('next', ctx);
  assert.equal(a, 2); assert.equal(b, 1);
  // During a round: that round keeps its speakers, the next one goes without.
  ctx.room.agents[0].turn = async () => { a++; if (a === 3) setAgentEnabled(ctx, 'B', true, { member: true }); return 'PASS'; };
  await handleLine('during', ctx);
  assert.equal(a, 3); assert.equal(b, 1);
  assert.deepEqual(ctx.state.disabledAgents, []);
  ctx.room.agents[0].turn = async () => { a++; if (a === 4) setAgentEnabled(ctx, 'A', false, { member: true }); return 'PASS'; };
  await handleLine('both', ctx);
  assert.equal(a, 4); assert.equal(b, 2);
  assert.deepEqual(ctx.lastRound.state.disabledAgents, ['A']); // checkpointed with the round it came in
  await handleLine('only B', ctx);
  assert.equal(a, 4); assert.equal(b, 3);
});

// ── Stopping a discussion's worker (the Worker tab's two buttons) ──
// A worker turn as a program: it registers in the worker's own programs; stopping its group fails the turn.
const stoppableTurn = (ctx, during = () => {}) => () => new Promise((_, fail) => {
  const proc = { stopped: null, stopGroup: (signal) => { proc.stopped = signal; fail(new Error(`claude was stopped (${signal})`)); } };
  ctx.worker.programs.running.add(proc);
  during(proc);
});

test('Stop now: only this task\'s programs are killed, queued instructions are cancelled with their full text, the report says what it left, no Retry, and the next instruction is told once', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { queueWork, stopWorker } = await import('../src/ui.mjs');
  const cwd = await tmp('stop-now-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'stop-now');
  Object.assign(ctx.sessions.get('B'), { threadId: 'codex-thread' });
  await handleLine('plan it', ctx);
  const name = ctx.discussion.name;
  let proc = null;
  ctx.worker.turn = stoppableTurn(ctx, (p) => { writeFileSync(join(ctx.workerDir.path, 'half.txt'), 'half'); proc = p; });
  // An agent's program of the same room: Stop now leaves it alone.
  const agentProc = { stopped: null, stopGroup: (signal) => { agentProc.stopped = signal; } };
  ctx.programs.running.add(agentProc);
  queueWork(ctx, 'long task');
  queueWork(ctx, 'waiting task\nsecond line\nthird line');
  queueWork(ctx, 'another one');
  await eventually(() => !!proc);
  assert.deepEqual(ctx.screen.room.workerStop, { after: false, now: false });
  stopWorker(ctx, 'now');
  // At once: the queue is empty and nothing more starts.
  assert.deepEqual(workerLane(ctx).tasks, []);
  assert.equal(proc.stopped, 'SIGKILL');
  assert.equal(agentProc.stopped, null);
  await ctx.workQueue;
  ctx.programs.running.delete(agentProc);
  const log = ctx.screen.worker;
  const cancelled = log.filter((m) => m.speaker === 'agent-room').map((m) => m.html);
  assert.equal(cancelled.length, 2);
  assert.match(cancelled[0], /Not started, cancelled by the stop: \[[^\]]+\] instruction sent \d\d:\d\d[\s\S]*waiting task\nsecond line\nthird line/);
  assert.match(cancelled[1], /another one/);
  const reply = log.filter((m) => m.speaker === 'W').at(-1);
  assert.equal(reply.error, true);
  assert.equal(reply.retryId, undefined); // no Retry for a stopped instruction
  assert.equal(ctx.screen.room.retryId, null);
  const expected = new RegExp(`^Stopped by the User: \\[${name}\\] "long task" \\(started \\d\\d:\\d\\d\\) left uncommitted edits in the worktree\\. Ask the worker to finish and commit them, or to abandon them\\.`);
  assert.match(reply.html, /^<p>Stopped by the User: /);
  const chat = ctx.state.transcript.at(-1);
  assert.equal(chat.speaker, 'agent-room');
  assert.match(chat.text, expected);
  assert.equal(ctx.screen.room.workerStop, null);
  const work = await savedWork(cwd, name);
  assert.deepEqual([work.running, work.queued, work.notStarted, work.interrupted.map((r) => [r.task, r.stopped, r.reported])],
    [null, [], [], [['long task', true, true]]]);
  // Its own discussion's next instruction (its edits hold the lane for it) is told once.
  const prompts = [];
  ctx.worker.turn = async (p) => { prompts.push(p); return 'ok'; };
  queueWork(ctx, 'finish it');
  await ctx.workQueue;
  queueWork(ctx, 'and then');
  await ctx.workQueue;
  assert.match(prompts[0], /^\[your reported usage this session: [^\]]+\]\n\nYour previous instruction "long task" was stopped by the User \(Stop now\): check the worktree before continuing\./);
  assert.doesNotMatch(prompts[1], /was stopped by the User/);
});

test('Stop now while the worktree is prepared: the worker never starts, and the result is unknown', async () => {
  const { queueWork, stopWorker } = await import('../src/ui.mjs');
  const cwd = await tmp('stop-early-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'stop-early');
  await handleLine('plan it', ctx);
  const name = ctx.discussion.name;
  let started = false;
  ctx.worker.turn = async () => { started = true; return 'ran'; };
  // Stopped the moment it is taken from the queue, before its worktree is prepared.
  const lane = workerLane(ctx);
  let running = null;
  Object.defineProperty(lane, 'running', { configurable: true, get: () => running, set: (t) => { running = t; if (t) stopWorker(ctx, 'now'); } });
  queueWork(ctx, 'early task');
  await ctx.workQueue;
  delete lane.running;
  assert.equal(started, false);
  const reply = ctx.screen.worker.filter((m) => m.speaker === 'W').at(-1);
  assert.match(ctx.state.transcript.at(-1).text, new RegExp(`^Result unknown: \\[${name}\\] "early task" \\(started \\d\\d:\\d\\d\\) was stopped by the User while its worktree was being prepared; its worker never started\\. Check the worktree \\(it is clean\\)\\.$`));
  assert.match(reply.html, /^<p>Result unknown: /);
  assert.equal(reply.retryId, undefined);
});

test('Stop after this task: the running instruction finishes and is reported as usual; queued ones are cancelled; auto dev pauses; other discussions\' workers go on', async () => {
  const { queueWork, stopWorker } = await import('../src/ui.mjs');
  const cwd = await tmp('stop-after-');
  await gitRoom(cwd);
  const ctx = await savedRoom(cwd, 'stop-after');
  await handleLine('plan it', ctx);
  let finish;
  ctx.worker.turn = () => new Promise((done) => { finish = done; });
  ctx.autoDev = { status: 'running', cycle: 1, limit: 4, reason: null, waiting: true };
  queueWork(ctx, 'current task');
  queueWork(ctx, 'next task');
  // Another discussion's queued task, in its own lane: not cancelled.
  const other = { owner: 'someone-else', label: 'someone-else', lane: 'someone-else', text: 'theirs', sent: 0, origin: { stopped: false }, done: () => {} };
  workerLane(ctx, 'someone-else').tasks.push(other);
  await eventually(() => !!finish);
  stopWorker(ctx, 'after');
  assert.deepEqual(workerLane(ctx).tasks, []);
  assert.deepEqual(workerLane(ctx, 'someone-else').tasks, [other]);
  workerLane(ctx, 'someone-else').tasks.length = 0;
  assert.equal(ctx.autoDev.status, 'paused');
  assert.deepEqual(ctx.screen.room.workerStop, { after: true, now: false });
  finish('all done');
  await ctx.workQueue;
  const reply = ctx.screen.worker.filter((m) => m.speaker === 'W').at(-1);
  assert.equal(reply.error, false);
  assert.match(reply.html, /all done/);
  assert.match(ctx.screen.worker.find((m) => m.speaker === 'agent-room').html, /cancelled by the stop[\s\S]*next task/);
  assert.equal(ctx.screen.room.workerStop, null);
});

test('a worker agent\'s programs: once its task is stopped, none starts', async () => {
  const ctx = { ...freshCtx(), workerSpec: 'claude:W', noScreen: true };
  Object.assign(ctx, await load(ctx, '?stop-gate'));
  assert.deepEqual([ctx.worker.programs.running.size, ctx.worker.programs.stopped], [0, false]);
  ctx.worker.programs.stopped = true;
  await assert.rejects(ctx.worker.turn('hi'), /not started: the User stopped this instruction/);
  assert.equal(ctx.programs.running.size, 0);
});

test('provider health retains the latest errors separately from successful checks', async () => {
  const { checkCli, checkLogins, checkLeftovers } = await import('../src/ui.mjs');
  const monitor = { login: {}, cli: {}, leftovers: [], errors: { login: {}, cli: {}, leftovers: null } };
  const room = { room: { agents: [{ provider: 'claude' }] }, worker: { provider: 'codex' },
    usage: { checkLogin: async () => ({ state: 'ok' }) }, findLeftovers: async () => [{ pid: 1 }], programs: { running: new Set() } };
  const hub = { monitor, rooms: new Map([['room', room]]) };
  await checkLogins(hub, true, ['claude']);
  await checkLeftovers(hub);
  await checkCli(hub, 'claude', async (command) => command === 'which' ? '/bin/claude' : '1.0');
  const login = monitor.login.claude, leftovers = monitor.leftovers, cli = monitor.cli.claude;
  room.usage.checkLogin = async () => ({ state: 'unknown', error: 'unreadable' });
  room.findLeftovers = async () => { throw new Error('scan failed'); };
  await checkLogins(hub, true, ['claude']);
  await checkLeftovers(hub);
  await checkCli(hub, 'claude', async () => { throw new Error('missing'); });
  assert.equal(monitor.login.claude, login);
  assert.equal(monitor.leftovers, leftovers);
  assert.equal(monitor.cli.claude, cli);
  for (const e of [monitor.errors.login.claude, monitor.errors.leftovers, monitor.errors.cli.claude]) assert.ok(e.at);
  assert.equal(monitor.errors.login.claude.message, 'unreadable');
  assert.equal(monitor.loginCurrent.claude.state, 'unknown');
  assert.equal(monitor.errors.leftovers.message, 'scan failed');
  assert.equal(monitor.errors.cli.claude.message, 'missing');
  room.usage.checkLogin = async () => { throw new Error('login failed'); };
  await checkLogins(hub, true, ['claude']);
  assert.equal(monitor.errors.login.claude.message, 'login failed');
  room.usage.checkLogin = async () => ({ state: 'out' });
  await checkLogins(hub, true, ['claude']);
  assert.equal(monitor.login.claude.state, 'out');
  assert.equal(monitor.errors.login.claude.message, 'login failed');
});

test('model catalogs retain their latest error and Check now bypasses the Agy throttle', async () => {
  const { agyModelCatalog, codexModelCatalog } = await import('../src/ui.mjs');
  let time = 0, finish, calls = 0;
  const agy = agyModelCatalog((cmd, args, opts, done) => { calls++; finish = done; }, () => time);
  agy(); finish(new Error('agy missing'));
  assert.equal(agy.status().loaded, false);
  assert.deepEqual(agy.status().error, { message: 'agy missing', at: new Date(0).toISOString() });
  time = 1000;
  const forced = agy.refresh();
  assert.equal(calls, 2);
  finish(null, 'gemini-one\tGemini One\n');
  await forced;
  assert.equal(agy.status().loaded, true);
  assert.equal(agy.status().models.length, 1);
  assert.equal(agy.status().error.message, 'agy missing');
  const forcedFailure = agy.refresh();
  finish(new Error('agy failed again'));
  await forcedFailure;
  assert.equal(agy.status().loaded, false);
  assert.equal(agy.status().models.length, 1);
  assert.equal(agy.status().error.message, 'agy failed again');

  let cache = '{"models":[{"visibility":"list","slug":"one"}]}';
  const codex = codexModelCatalog(() => { if (cache instanceof Error) throw cache; return cache; }, () => time);
  assert.equal(codex().length, 1);
  cache = new Error('cache missing'); time = 2000;
  assert.deepEqual(codex(), []);
  assert.equal(codex.status().loaded, false);
  assert.equal(codex.status().models.length, 1);
  assert.deepEqual(codex.status().error, { message: 'cache missing', at: new Date(time).toISOString() });
  cache = '{"models":[]}';
  codex();
  assert.equal(codex.status().loaded, true);
  assert.equal(codex.status().error.message, 'cache missing');
});

test('model alignment distinguishes defaults, membership and unavailable lists', async () => {
  const { modelAlignment } = await import('../src/ui.mjs');
  const loaded = { loaded: true, models: [{ id: 'one' }] }, unavailable = { loaded: false, checked: '2026-01-01T00:00:00.000Z', models: [{ id: 'one' }] };
  assert.equal(modelAlignment('', unavailable), 'CLI default');
  assert.equal(modelAlignment('one', loaded), 'in list');
  assert.equal(modelAlignment('two', loaded), 'not in list');
  assert.equal(modelAlignment('one', unavailable), 'list unavailable');
});

test('scheduled login checks use only providers in open rooms, while explicit checks include all', async () => {
  const { checkLogins } = await import('../src/ui.mjs');
  const called = [];
  const room = { room: { agents: [{ provider: 'claude' }] }, worker: { provider: 'claude' },
    usage: { checkLogin: async (provider) => { called.push(provider); return { state: 'ok' }; } } };
  const hub = { rooms: new Map([['room', room]]), monitor: { login: {}, errors: { login: {} } } };
  await checkLogins(hub, true);
  assert.deepEqual(called, ['claude']);
  called.length = 0;
  await checkLogins(hub, true, ['claude', 'codex', 'agy']);
  assert.deepEqual(called, ['claude', 'codex', 'agy']);
});


test('unread model catalogs differ from failed reads when checking alignment', async () => {
  const { agyModelCatalog, codexModelCatalog, modelAlignment } = await import('../src/ui.mjs');
  const agy = agyModelCatalog(() => {}, () => 0), codex = codexModelCatalog(() => { throw new Error('missing'); }, () => 0);
  for (const catalog of [agy.status(), codex.status()]) {
    assert.equal(catalog.checked, null);
    assert.equal(modelAlignment('example', catalog), 'list not read yet');
    assert.equal(modelAlignment('', catalog), 'CLI default');
  }
  codex();
  assert.equal(modelAlignment('example', codex.status()), 'list unavailable');
});

test('last-turn records stay in memory by session and retain the latest error after success', async () => {
  const { monitorAgentTurns } = await import('../src/ui.mjs');
  const records = new WeakMap(), session = {}, other = {};
  let failure = null, resets = 0;
  const agent = monitorAgentTurns({ turn: async (value) => { if (failure) throw failure; return value; }, reset: () => { resets++; } }, session, records);
  assert.equal(records.get(session), undefined);
  assert.equal(await agent.turn('reply'), 'reply');
  assert.equal(records.get(session).outcome, 'ok');
  assert.ok(records.get(session).ended);
  failure = new Error('first failure');
  await assert.rejects(agent.turn('again'), /first failure/);
  assert.equal(records.get(session).outcome, 'error');
  assert.equal(records.get(session).error.message, 'first failure');
  assert.equal(records.get(session).error.at, records.get(session).ended);
  failure = new Error('latest failure');
  await assert.rejects(agent.turn('again'), /latest failure/);
  failure = null;
  await agent.turn('recovered');
  assert.equal(records.get(session).outcome, 'ok');
  assert.equal(records.get(session).error.message, 'latest failure');
  assert.equal(records.get(other), undefined);
  assert.deepEqual(session, {});
  agent.reset();
  assert.equal(resets, 1);
  assert.equal(records.get(session), undefined);
});

test('prompt diagnostics use isolated calls, retain results and leave agent sessions alone', async () => {
  const { runPromptTest } = await import('../src/ui.mjs');
  const { parseCodexEvents, parseAgyOutput } = await import('../src/agents.mjs');
  const { existsSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const agentSession = { threadId: 'existing-thread' }, workerSession = { conversationId: 'existing-worker' };
  const ctx = { cwd: '/tmp', agentSpecs: 'codex:A:configured,claude:B:opus', workerSpec: 'agy:W:gemini',
    room: { agents: [{ provider: 'codex' }, { provider: 'claude' }] }, worker: { provider: 'agy' }, usage: {},
    sessions: new Map([['A', agentSession], ['worker:W', workerSession]]) };
  ctx.hub = { rooms: new Map([['room', ctx]]) };
  const parsers = { parseCodexEvents, parseAgyOutput }, calls = [], dirs = [];
  const runner = async (provider, args, options) => {
    calls.push({ provider, args, options }); dirs.push(options.cwd);
    assert.ok(options.cwd.startsWith(tmpdir()));
    assert.deepEqual(readdirSync(options.cwd), []);
    assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.input, 'Reply with exactly OK.');
    if (provider === 'codex') return '{"type":"thread.started","thread_id":"new-test-thread"}\n{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n';
    if (provider === 'agy') return JSON.stringify({ status: 'SUCCESS', conversation_id: 'new-test-session', response: 'OK' });
    return JSON.stringify({ result: 'X'.repeat(250), is_error: false });
  };
  const codex = await runPromptTest(ctx, 'codex', 'configured', runner, parsers);
  assert.equal(codex.outcome, 'ok'); assert.equal(codex.reply, 'OK'); assert.ok(codex.at); assert.ok(codex.durationMs >= 0);
  assert.ok(calls[0].args.includes('read-only')); assert.ok(calls[0].args.includes('web_search="disabled"'));
  assert.ok(calls[0].args.includes('--ephemeral')); assert.ok(!calls[0].args.includes('resume'));
  const claude = await runPromptTest(ctx, 'claude', 'opus', runner, parsers);
  assert.equal(claude.reply.length, 200); assert.ok(calls[1].args.includes('--no-session-persistence'));
  assert.deepEqual(calls[1].args.slice(-2), ['--tools', '']); assert.ok(calls[1].args.includes('opus'));
  await runPromptTest(ctx, 'agy', 'gemini', runner, parsers);
  assert.ok(calls[2].args.includes('--sandbox')); assert.ok(!calls[2].args.includes('--dangerously-skip-permissions'));
  assert.ok(!calls[2].args.includes('--conversation'));
  const failure = await runPromptTest(ctx, 'codex', 'configured', async () => { throw new Error('CLI failed'); }, parsers);
  assert.equal(failure.outcome, 'failed'); assert.equal(failure.error, 'CLI failed'); assert.equal(failure.reply, '');
  assert.equal(ctx.hub.promptResults.get('codex').get('configured'), failure);
  assert.equal(ctx.hub.promptResults.get('claude').get('opus'), claude);
  assert.deepEqual(agentSession, { threadId: 'existing-thread' });
  assert.deepEqual(workerSession, { conversationId: 'existing-worker' });
  assert.ok(dirs.every((dir) => !existsSync(dir)));
  await assert.rejects(runPromptTest(ctx, 'codex', 'not-configured', runner, parsers), /configured/);
});

test('Stop now with a real program: the worker\'s process group is killed through its monitored turn, and its last-turn record is an error', async () => {
  const { writeFileSync, chmodSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { queueWork, stopWorker } = await import('../src/ui.mjs');
  const cwd = await tmp('stop-real-');
  await gitRoom(cwd);
  // A stand-in `claude` that runs a child in its group and never answers.
  const bin = join(cwd, '..', `bin-${Date.now()}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nsleep 30 &\nwait\n');
  chmodSync(join(bin, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const ctx = await savedRoom(cwd, 'stop-real');
    await handleLine('plan it', ctx);
    const worker = ctx.worker;
    queueWork(ctx, 'count slowly');
    await eventually(() => worker.programs.running.size > 0);
    const [proc] = worker.programs.running;
    assert.equal(proc.groupAlive(), true);
    stopWorker(ctx, 'now');
    await ctx.workQueue;
    await eventually(() => !proc.groupAlive());
    const record = ctx.turnRecords.get(ctx.sessions.get('worker:W'));
    assert.equal(record.outcome, 'error');
    assert.equal(record.error.message, 'claude was stopped (SIGKILL)');
    assert.match(ctx.screen.worker.filter((m) => m.speaker === 'W').at(-1).html, /^<p>Stopped by the User: /);
  } finally { process.env.PATH = path; }
});

test('branchDiagram: behind main, diverged, main merged into branch twice, and history longer than the limit (real git repos)', async () => {
  const { writeFileSync } = await import('node:fs');
  const { parse } = await import('@mermaid-js/parser');
  const { branchDiagram, workerPlace, ensureWorktree, refreshWorker } = await import('../src/ui.mjs');

  const checkGraph = async (d) => {
    assert.ok(d && d.graph && !d.note, `expected graph, got: ${JSON.stringify(d)}`);
    assert.match(d.graph, /^---\nconfig:\n  gitGraph:\n    rotateCommitLabel: false\n/);
    const ast = await parse('gitGraph', d.graph);
    assert.ok(ast.statements.length > 0);
    return d.graph;
  };

  // 1. Branch behind main
  {
    const dir = await tmp('diag-behind-');
    const g = await gitRoom(dir);
    const base = g('rev-parse', '--short=7', 'HEAD');
    const place = await workerPlace(dir, '2026-11-19-behind');
    await ensureWorktree(place);
    writeFileSync(`${dir}/a.txt`, '1\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'main step one');
    const m1 = g('rev-parse', '--short=7', 'HEAD');
    writeFileSync(`${dir}/a.txt`, '2\n'); g('commit', '-q', '-am', 'main step two');
    const m2 = g('rev-parse', '--short=7', 'HEAD');

    const graph = await checkGraph(await branchDiagram(place));
    assert.match(graph, new RegExp(`commit id: "${base} `));
    assert.match(graph, new RegExp(`branch "${place.branch}"`));
    assert.match(graph, new RegExp(`checkout "main"\\n  commit id: "${m1} main step one"\\n  commit id: "${m2} main step two"`));
    assert.doesNotMatch(graph, /merge /);
  }

  // 2. Diverged branches (also checked via refreshWorker on a room)
  {
    const { ctx } = await workerRoom();
    ctx.noScreen = true;
    const g = await gitRoom(ctx.cwd);
    const base = g('rev-parse', '--short=7', 'HEAD');
    await handleLine('hello', ctx);
    const name = ctx.discussion.name;
    const place = await workerPlace(ctx.cwd, name);
    await ensureWorktree(place);
    writeFileSync(`${ctx.cwd}/m.txt`, 'm\n'); g('add', 'm.txt'); g('commit', '-q', '-m', 'main diverged');
    const m1 = g('rev-parse', '--short=7', 'HEAD');
    writeFileSync(`${place.path}/w.txt`, 'w\n'); g('-C', place.path, 'add', 'w.txt'); g('-C', place.path, 'commit', '-q', '-m', `[${name}] worker diverged`);
    const w1 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

    await refreshWorker(ctx);
    const lane = ctx.screen.workerInfo.lanes[0];
    const graph = await checkGraph(lane.diagram);
    assert.match(graph, new RegExp(`commit id: "${base} `));
    assert.match(graph, new RegExp(`commit id: "${w1} worker diverged"`));
    assert.doesNotMatch(graph, new RegExp(`\\[${name}\\]`));
    assert.match(graph, new RegExp(`commit id: "${m1} main diverged"`));
  }

  // 3. Main merged into the branch twice (and main moves on after the second merge)
  {
    const dir = await tmp('diag-merges-');
    const g = await gitRoom(dir);
    const base = g('rev-parse', '--short=7', 'HEAD');
    const place = await workerPlace(dir, '2026-11-19-merges');
    await ensureWorktree(place);
    writeFileSync(`${place.path}/w.txt`, '1\n'); g('-C', place.path, 'add', 'w.txt'); g('-C', place.path, 'commit', '-q', '-m', 'worker 1');
    const w1 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

    writeFileSync(`${dir}/m.txt`, '1\n'); g('add', 'm.txt'); g('commit', '-q', '-m', 'main 1');
    const m1 = g('rev-parse', '--short=7', 'HEAD');
    g('-C', place.path, 'merge', 'main', '-m', 'catch up 1');
    const wm1 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

    writeFileSync(`${place.path}/w.txt`, '2\n'); g('-C', place.path, 'commit', '-q', '-am', 'worker 2');
    const w2 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

    writeFileSync(`${dir}/m.txt`, '2\n'); g('commit', '-q', '-am', 'main 2');
    const m2 = g('rev-parse', '--short=7', 'HEAD');
    g('-C', place.path, 'merge', 'main', '-m', 'catch up 2');
    const wm2 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

    writeFileSync(`${dir}/m.txt`, '3\n'); g('commit', '-q', '-am', 'main 3');
    const m3 = g('rev-parse', '--short=7', 'HEAD');

    const graph = await checkGraph(await branchDiagram(place));
    const lines = graph.split('\n');
    const idx = (pat) => lines.findIndex((l) => pat.test(l));
    assert.ok(idx(new RegExp(`commit id: "${base} `)) >= 0);
    assert.ok(idx(new RegExp(`commit id: "${w1} worker 1"`)) < idx(new RegExp(`merge "main" id: "${wm1} catch up 1"`)));
    assert.ok(idx(new RegExp(`commit id: "${m1} main 1"`)) < idx(new RegExp(`merge "main" id: "${wm1} catch up 1"`)));
    assert.ok(idx(new RegExp(`merge "main" id: "${wm1} catch up 1"`)) < idx(new RegExp(`commit id: "${m2} main 2"`)));
    assert.ok(idx(new RegExp(`commit id: "${w2} worker 2"`)) < idx(new RegExp(`merge "main" id: "${wm2} catch up 2"`)));
    assert.ok(idx(new RegExp(`commit id: "${m2} main 2"`)) < idx(new RegExp(`merge "main" id: "${wm2} catch up 2"`)));
    assert.ok(idx(new RegExp(`merge "main" id: "${wm2} catch up 2"`)) < idx(new RegExp(`commit id: "${m3} main 3"`)));
  }

  // 4. History longer than the limit: cut-off marked with "+N more commits", never a direct parent link
  {
    const dir = await tmp('diag-limit-');
    const g = await gitRoom(dir);
    const place = await workerPlace(dir, '2026-11-19-long');
    await ensureWorktree(place);
    const mainHashes = [];
    for (let i = 1; i <= 19; i++) {
      g('commit', '-q', '--allow-empty', '-m', `main commit ${i}`);
      mainHashes.push(g('rev-parse', '--short=7', 'HEAD'));
    }
    const workerHashes = [];
    for (let i = 1; i <= 17; i++) {
      g('-C', place.path, 'commit', '-q', '--allow-empty', '-m', `worker commit ${i}`);
      workerHashes.push(g('-C', place.path, 'rev-parse', '--short=7', 'HEAD'));
    }

    const res = await branchDiagram(place); // default limit 15
    const graph = await checkGraph(res);
    assert.equal(res.truncated, true);
    assert.match(graph, /commit id: "\+4 more commits" type: HIGHLIGHT/);
    assert.match(graph, /commit id: "\+2 more commits" type: HIGHLIGHT/);
    // Cut-off commits are omitted; the newest 15 commits per side are present right after the cut node.
    assert.ok(!graph.includes(mainHashes[0]));
    assert.ok(!graph.includes(mainHashes[3]));
    assert.ok(graph.includes(mainHashes[4]));
    assert.ok(graph.includes(mainHashes[18]));
    assert.ok(!graph.includes(workerHashes[0]));
    assert.ok(!graph.includes(workerHashes[1]));
    assert.ok(graph.includes(workerHashes[2]));
    assert.ok(graph.includes(workerHashes[16]));
    const lines = graph.split('\n');
    assert.ok(lines.findIndex((l) => l.includes('+4 more commits')) < lines.findIndex((l) => l.includes(mainHashes[4])));
    assert.ok(lines.findIndex((l) => l.includes('+2 more commits')) < lines.findIndex((l) => l.includes(workerHashes[2])));
  }
});

test('branchDiagram: falls back to a plain-text note when gitGraph cannot draw the history faithfully, and supports non-main room branches', async () => {
  const { writeFileSync } = await import('node:fs');
  const { parse } = await import('@mermaid-js/parser');
  const { branchDiagram, workerPlace, ensureWorktree } = await import('../src/ui.mjs');

  // 1. Criss-cross merge (two merge-bases): returns a plain-text note, no graph.
  {
    const dir = await tmp('diag-crisscross-');
    const g = await gitRoom(dir);
    const place = await workerPlace(dir, '2026-11-19-cross');
    await ensureWorktree(place);
    writeFileSync(`${dir}/a.txt`, 'a\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'main a');
    const m1 = g('rev-parse', 'HEAD');
    writeFileSync(`${place.path}/b.txt`, 'b\n'); g('-C', place.path, 'add', 'b.txt'); g('-C', place.path, 'commit', '-q', '-m', 'worker b');
    const w1 = g('-C', place.path, 'rev-parse', 'HEAD');
    g('merge', w1, '-m', 'main merges w1');
    g('-C', place.path, 'merge', m1, '-m', 'worker merges m1');

    const res = await branchDiagram(place);
    assert.ok(res.note && !res.graph);
    assert.match(res.note, /multiple merge-bases|criss-cross/i);
  }

  // 2. Non-main room branch (e.g. feature/dev): emits YAML frontmatter with mainBranchName and parses cleanly.
  {
    const dir = await tmp('diag-nonmain-');
    const g = await gitRoom(dir);
    g('checkout', '-q', '-b', 'feature/dev');
    const place = await workerPlace(dir, '2026-11-19-dev');
    await ensureWorktree(place);
    g('-C', place.path, 'commit', '-q', '--allow-empty', '-m', 'work on dev');

    const res = await branchDiagram(place);
    assert.ok(res.graph && !res.note);
    assert.match(res.graph, /^---\nconfig:\n  gitGraph:\n    rotateCommitLabel: false\n    mainBranchName: "feature\/dev"\n---\ngitGraph TB:\n/);
    const ast = await parse('gitGraph', res.graph);
    assert.ok(ast.statements.length > 0);
  }
});

test('branchDiagram: strips leading [label] from subjects and tags third-branch merges with tag: "merge"', async () => {
  const { writeFileSync } = await import('node:fs');
  const { parse } = await import('@mermaid-js/parser');
  const { branchDiagram, workerPlace, ensureWorktree } = await import('../src/ui.mjs');

  const dir = await tmp('diag-labels-and-third-');
  const g = await gitRoom(dir);
  const place = await workerPlace(dir, '2026-11-19-readable-labels');
  await ensureWorktree(place);

  // Long leading [label] is stripped BEFORE truncating to 48 chars so the actual subject stays readable.
  const longLabel = '2026-11-19-a-very-long-discussion-folder-name-that-would-fill-the-label';
  writeFileSync(`${place.path}/w.txt`, '1\n'); g('-C', place.path, 'add', 'w.txt');
  g('-C', place.path, 'commit', '-q', '-m', `[${longLabel}] Add branch diagram labels`);
  const w1 = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

  // Main merges a third branch (not the worker branch): stays in the diagram as one commit tagged "merge".
  g('checkout', '-q', '-b', 'worker/other');
  writeFileSync(`${dir}/other.txt`, 'other\n'); g('add', 'other.txt');
  g('commit', '-q', '-m', '[2026-11-19-other] Other branch work');
  g('checkout', '-q', 'main');
  g('merge', '--no-ff', 'worker/other', '-m', '[2026-11-19-other] Merge other branch');
  const mMerge = g('rev-parse', '--short=7', 'HEAD');

  const res = await branchDiagram(place);
  assert.ok(res.graph && !res.note, `expected graph, got: ${JSON.stringify(res)}`);
  const ast = await parse('gitGraph', res.graph);
  assert.ok(ast.statements.length > 0);
  assert.match(res.graph, new RegExp(`commit id: "${w1} Add branch diagram labels"`));
  assert.ok(!res.graph.includes(longLabel));
  assert.match(res.graph, new RegExp(`commit id: "${mMerge} Merge other branch" tag: "merge"`));
  assert.doesNotMatch(res.graph, /type: HIGHLIGHT/);

  // Worker branch merging a third branch also stays as one commit tagged "merge" (no text-note fallback).
  g('checkout', '-q', '-b', 'side-helper', 'HEAD~1');
  writeFileSync(`${dir}/helper.txt`, 'h\n'); g('add', 'helper.txt');
  g('commit', '-q', '-m', 'helper commit');
  g('checkout', '-q', 'main');
  g('-C', place.path, 'merge', '--no-ff', 'side-helper', '-m', `[${longLabel}] Bring in helper`);
  const wMerge = g('-C', place.path, 'rev-parse', '--short=7', 'HEAD');

  const res2 = await branchDiagram(place);
  assert.ok(res2.graph && !res2.note, `expected graph, got: ${JSON.stringify(res2)}`);
  const ast2 = await parse('gitGraph', res2.graph);
  assert.ok(ast2.statements.length > 0);
  assert.match(res2.graph, new RegExp(`commit id: "${wMerge} Bring in helper" tag: "merge"`));
  assert.doesNotMatch(res2.graph, /type: HIGHLIGHT/);
});

test('Close with pending work: allowed with unresolved edits (hold and files kept), appends pending-work line to closing-statement.md, and refuses tasks queued behind an unresolved-edits hold', async () => {
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { hostname } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, workerHold } = await import('../src/ui.mjs');
  const inTree = (ctx, ...a) => execFileSync('git', ['-C', ctx.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);

  const { first, contexts } = await multiRoom({ worker: (ctx, p) => {
    if (p.endsWith('make pending')) {
      writeFileSync(`${ctx.workerDir.path}/committed.txt`, 'c\n');
      inTree(ctx, 'add', 'committed.txt');
      inTree(ctx, 'commit', '-q', '-m', `[${ctx.discussion.name}] committed step`);
      writeFileSync(`${ctx.workerDir.path}/wip.txt`, 'uncommitted\n');
    }
    return 'ok\nDocs: none needed, because test.';
  } });
  await handleLine('pending-topic', first);
  const { name, dir } = first.discussion;
  queueWork(first, 'make pending');
  await first.workQueue;
  const worktreePath = first.workerDir.path;
  assert.ok(workerLane(first).blockedBy);
  assert.match(workerHold(first), /unresolved/);

  // Close succeeds despite unresolved edits, keeps the worktree/edits/hold, and writes the pending-work line.
  first.node = 'MacBook';
  await handleLine('/close', first);
  assert.match(first.notes.at(-1), new RegExp(`^Closed ${name}\\.`));
  assert.ok(existsSync(`${worktreePath}/wip.txt`));
  assert.ok(workerLane(first, name).blockedBy, 'queue hold stays intact after Close');
  const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
  assert.ok(stmt.includes(`Worker work pending on MacBook: \`worker/${name}\`, 1 commit not in main, uncommitted edits: yes, worktree \`${worktreePath}\`.`));

  // Resume later finds the edits and hold still there.
  await handleLine(`/resume ${name}`, first);
  const resumed = contexts().find((c) => c.discussion?.name === name);
  assert.ok(resumed);
  resumed.docs = { ...resumed.docs, broadcast: (s, ev) => { if (ev.type === 'note') resumed.notes.push(ev.text); } };
  assert.ok(existsSync(`${worktreePath}/wip.txt`));
  assert.ok(workerLane(resumed, name).blockedBy);

  // A task queued behind an unknown-origin unresolved-edits hold cannot start: Close refuses immediately.
  const { unlinkSync } = await import('node:fs');
  const gitDir = inTree(first, 'rev-parse', '--absolute-git-dir').toString().trim();
  if (existsSync(`${gitDir}/agent-room-owner.json`)) unlinkSync(`${gitDir}/agent-room-owner.json`);
  workerLane(resumed, name).blockedBy = { origin: null, owner: null, label: null, task: null, place: workerLane(resumed, name).blockedBy.place };
  resumed.worker.turn = async () => 'ok';
  queueWork(resumed, 'stuck task');
  await handleLine(`/close ${name}`, resumed);
  assert.match(resumed.notes.at(-1), /1 worker task is queued behind unresolved edits: remove them from the queue first/);
  assert.match(resumed.notes.at(-1), /"stuck task"/);
  workerLane(resumed, name).tasks.length = 0;

  // Without a replication node name, the pending-work line falls back to hostname(); without pending work, no line is written.
  const { first: clean } = await multiRoom();
  await handleLine('clean-topic', clean);
  const { dir: cleanDir } = clean.discussion;
  await handleLine('/close', clean);
  assert.doesNotMatch(readFileSync(`${cleanDir}/closing-statement.md`, 'utf8'), /Worker work pending on/);
  assert.ok(hostname().length > 0);
});

test('Close and Discard: refuses with a queued task or mid-operation, previews commits/edits/untracked/ignored summary, detects changes between clicks, saves unique discard ref, removes worktree and branch, clears hold/session, and closes', async () => {
  const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, discardPreview, closeAndDiscard } = await import('../src/ui.mjs');
  const inTree = (path, ...a) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  let releaseRunning;
  const runningGate = new Promise((r) => { releaseRunning = r; });
  const { first, git } = await multiRoom({ worker: async (ctx, p) => {
    if (p.endsWith('slow task')) {
      writeFileSync(`${ctx.workerDir.path}/a.txt`, 'v1\n');
      inTree(ctx.workerDir.path, 'add', 'a.txt');
      inTree(ctx.workerDir.path, 'commit', '-q', '-m', `[${ctx.discussion.name}] add a.txt`);
      await runningGate;
    }
    return 'ok\nDocs: none needed, because test.';
  } });
  writeFileSync(`${first.cwd}/.gitignore`, 'dist/\n*.log\n');
  git('add', '.gitignore'); git('commit', '-q', '-m', 'add gitignore');

  await handleLine('discard-topic', first);
  const { name, dir } = first.discussion;

  // 1. Refusal while a task is running or queued (names them).
  queueWork(first, 'slow task');
  queueWork(first, 'queued followup');
  await until(() => workerLane(first, name).running);
  await assert.rejects(
    () => discardPreview(first, name),
    (err) => /running or queued/.test(err.message) && err.message.includes('"slow task"') && err.message.includes('"queued followup"'),
  );
  releaseRunning();
  await first.workQueue;

  const tree = first.workerDir.path;
  // Create tracked edit, untracked file, and ignored files in a folder (summarised, not listed one-by-one).
  writeFileSync(`${tree}/a.txt`, 'edited\n');
  writeFileSync(`${tree}/untracked.txt`, 'u1\n');
  mkdirSync(`${tree}/dist/sub`, { recursive: true });
  writeFileSync(`${tree}/dist/one.js`, '1');
  writeFileSync(`${tree}/dist/sub/two.js`, '2');
  writeFileSync(`${tree}/debug.log`, 'log');

  // 2. Preview listing (commits, tracked edits, untracked files, ignored-files summary by top-level folder).
  const firstClick = await discardPreview(first, name);
  const p1 = firstClick.preview;
  assert.equal(p1.commits.length, 1);
  assert.match(p1.commits[0].subject, /add a\.txt/);
  assert.deepEqual(p1.tracked.map((t) => t.path), ['a.txt']);
  assert.deepEqual(p1.untracked, ['untracked.txt']);
  assert.ok(p1.ignored.some((i) => i.label === 'dist/ 2 files'), `expected dist/ 2 files, got ${JSON.stringify(p1.ignored)}`);
  assert.ok(p1.ignored.some((i) => i.label === 'debug.log'), `expected debug.log, got ${JSON.stringify(p1.ignored)}`);
  assert.ok(!p1.ignored.some((i) => i.label.includes('one.js') || i.label.includes('two.js')));

  // 3. A change between the two clicks (even inside an already-listed untracked file) returns { changed: true, preview } and deletes nothing.
  writeFileSync(`${tree}/untracked.txt`, 'u2-modified\n');
  const changedRes = await closeAndDiscard(first, name, p1.snapshot);
  assert.equal(changedRes.changed, true);
  assert.notEqual(changedRes.preview.snapshot, p1.snapshot);
  assert.ok(existsSync(tree), 'worktree must not be removed when snapshot changed');

  // Also detects a change in an ignored file's size/mtime.
  writeFileSync(`${tree}/dist/one.js`, '111111');
  const changedIgnored = await closeAndDiscard(first, name, changedRes.preview.snapshot);
  assert.equal(changedIgnored.changed, true);

  // 4. Mid-rebase / mid-merge refusal.
  const gitDir = inTree(tree, 'rev-parse', '--absolute-git-dir');
  writeFileSync(`${gitDir}/MERGE_HEAD`, git('rev-parse', 'HEAD') + '\n');
  await assert.rejects(() => discardPreview(first, name), /mid-merge/);
  const { unlinkSync } = await import('node:fs');
  unlinkSync(`${gitDir}/MERGE_HEAD`);

  // 5. Confirm with fresh snapshot: saves refs/discarded/<name>/<ts>, removes worktree and branch, clears hold/session, and closes with closing-statement line.
  const tipBefore = git('rev-parse', `worker/${name}`);
  const finalPreview = await discardPreview(first, name);
  const done = await closeAndDiscard(first, name, finalPreview.preview.snapshot);
  assert.equal(done.ok, true);
  assert.match(done.savedRef, new RegExp(`^refs/discarded/${name}/\\d{8}-\\d{6}`));
  assert.equal(git('rev-parse', done.savedRef), tipBefore);
  assert.equal(existsSync(tree), false, 'worktree removed');
  assert.throws(() => git('rev-parse', '--verify', `refs/heads/worker/${name}`), 'branch deleted');
  assert.equal(workerLane(first, name).blockedBy, null);
  assert.ok(first.screen.room.closedDiscussions.includes(name));
  const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
  assert.ok(stmt.includes(`Worker work discarded: 1 commit kept at \`${done.savedRef}\`.`));
});

test('Close and Merge: greyed-out reasons, Catch up when main moved, change between clicks, conflicting merge aborted cleanly, and successful merge with cleanup and close', async () => {
  const { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, workerPlace, mergeReadiness, closeMergePreview, catchUpWithBranch, closeAndMerge } = await import('../src/ui.mjs');
  const inTree = (path, ...a) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  let releaseSlow;
  const slowGate = new Promise((r) => { releaseSlow = r; });
  let replyMode = 'commit-untested';
  const { first, git } = await multiRoom({ worker: async (ctx, p) => {
    const tree = ctx.workerDir.path;
    if (replyMode === 'slow') { await slowGate; return 'done'; }
    if (replyMode === 'commit-untested') {
      writeFileSync(`${tree}/shared.txt`, 'worker-v1\n');
      inTree(tree, 'add', 'shared.txt');
      inTree(tree, 'commit', '-q', '-m', `[${ctx.discussion.name}] add shared`);
      return 'committed without tested line\nDocs: none needed, because test.';
    }
    if (replyMode === 'test-fail') {
      return `Tested: ${inTree(tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests failed`;
    }
    if (replyMode === 'test-pass') {
      return `Tested: ${inTree(tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`;
    }
    if (replyMode === 'catchup') {
      inTree(tree, 'merge', 'main', '--no-edit');
      return `Tested: ${inTree(tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`;
    }
    return 'ok';
  } });
  writeFileSync(`${first.cwd}/.gitignore`, 'cache/\n');
  writeFileSync(`${first.cwd}/base.txt`, 'base\n');
  git('add', '.gitignore', 'base.txt'); git('commit', '-q', '-m', 'init files');

  await handleLine('merge-topic', first);
  const { name, dir } = first.discussion;
  queueWork(first, 'make change');
  await first.workQueue;
  const tree = first.workerDir.path;
  const place = await workerPlace(first.cwd, name);
  const wtGitDir = inTree(tree, 'rev-parse', '--absolute-git-dir');
  const roomGitDir = git('rev-parse', '--absolute-git-dir');

  // 1. Greyed-out reasons:
  // (a) No Tested: report yet
  let st = await mergeReadiness(first, place);
  assert.equal(st.show, true); assert.equal(st.canMerge, false);
  assert.match(st.disabledReason, /No passing Tested: report/);

  // (b) Failed Tested: report
  replyMode = 'test-fail';
  queueWork(first, 'run failing test');
  await first.workQueue;
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false);
  assert.match(st.disabledReason, /last test report failed/);

  // (c) Record passing Tested: report -> now canMerge is true!
  replyMode = 'test-pass';
  queueWork(first, 'run passing test');
  await first.workQueue;
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, true); assert.equal(st.disabledReason, null);

  // (d) Uncommitted edit in worktree
  writeFileSync(`${tree}/wip.txt`, 'dirty\n');
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /uncommitted edits/);
  unlinkSync(`${tree}/wip.txt`);

  // (e) Worktree mid-rebase
  mkdirSync(`${wtGitDir}/rebase-merge`, { recursive: true });
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /mid-rebase/);
  const { rmSync } = await import('node:fs');
  rmSync(`${wtGitDir}/rebase-merge`, { recursive: true, force: true });

  // (f) Room tracked edits outside discussions/ (while edits inside discussions/ are fine)
  writeFileSync(`${first.cwd}/base.txt`, 'edited in room\n');
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /tracked edits outside discussions/);
  git('checkout', '--', 'base.txt');

  // (g) Room mid-operation
  writeFileSync(`${roomGitDir}/MERGE_HEAD`, git('rev-parse', 'HEAD') + '\n');
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /room's checkout is mid-merge/);
  unlinkSync(`${roomGitDir}/MERGE_HEAD`);

  // (h) Room detached HEAD
  const mainSha = git('rev-parse', 'main');
  git('checkout', '-q', '--detach', mainSha);
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /detached HEAD/);
  git('checkout', '-q', 'main');

  // (i) Worker task running or queued
  replyMode = 'slow';
  queueWork(first, 'running task');
  await until(() => workerLane(first, name).running);
  st = await mergeReadiness(first, place);
  assert.equal(st.canMerge, false); assert.match(st.disabledReason, /running or queued.*"running task"/);
  releaseSlow();
  await first.workQueue;

  // 2. Main moves on: Catch up with main is offered instead, queues catch-up task, and does NOT merge automatically.
  writeFileSync(`${first.cwd}/other.txt`, 'from main\n');
  git('add', 'other.txt'); git('commit', '-q', '-m', 'main moved');
  const mainAfterMove = git('rev-parse', 'main');
  const previewMoved = await closeMergePreview(first, name);
  assert.equal(previewMoved.catchUp, true);
  assert.equal(previewMoved.targetBranch, 'main');
  replyMode = 'catchup';
  const cu = await catchUpWithBranch(first, name);
  assert.equal(cu.ok, true);
  await first.workQueue;
  // Nothing merged into main automatically: main is still at mainAfterMove!
  assert.equal(git('rev-parse', 'main'), mainAfterMove);
  assert.equal(existsSync(tree), true);

  // 3. Two-click preview: ignored files are omitted and changes to them do not invalidate the snapshot;
  // a real change (such as a new commit on the branch) returns { changed: true } without merging.
  mkdirSync(`${tree}/cache`, { recursive: true });
  writeFileSync(`${tree}/cache/c1.bin`, 'abc');
  const p1 = await closeMergePreview(first, name);
  assert.equal(p1.ok, true);
  assert.equal(p1.preview.title, `Merge worker/${name} into main`);
  assert.equal(p1.preview.ignored, undefined);
  writeFileSync(`${tree}/cache/c2.bin`, 'def');
  const p1AfterIgnored = await closeMergePreview(first, name);
  assert.equal(p1AfterIgnored.preview.snapshot, p1.preview.snapshot, 'ignored-file change must not change merge snapshot');
  const changed = await closeAndMerge(first, name, 'stale-snapshot');
  assert.equal(changed.changed, true);
  assert.equal(git('rev-parse', 'main'), mainAfterMove, 'must not merge when snapshot changed');

  // 4. Conflicting merge aborted cleanly: room left clean, branch/worktree/discussion left open.
  const p2 = await closeMergePreview(first, name);
  await assert.rejects(
    () => closeAndMerge(first, name, p2.preview.snapshot, {
      _beforeMerge: async () => {
        // Create a conflicting commit on main right after the preflight check to exercise real merge conflict + abort.
        writeFileSync(`${first.cwd}/shared.txt`, 'main-conflict\n');
        git('add', 'shared.txt'); git('commit', '-q', '-m', 'conflicting main commit');
      },
    }),
    /Aborted the merge; the room's checkout is back as it was/,
  );
  assert.equal(existsSync(`${roomGitDir}/MERGE_HEAD`), false, 'MERGE_HEAD must be aborted');
  assert.equal(git('status', '--porcelain', '--', '.', ':(exclude)discussions'), '');
  assert.equal(existsSync(tree), true, 'worktree kept open on conflict');
  assert.ok(!first.screen.room.closedDiscussions.includes(name), 'discussion left open on conflict');

  // Reset main back to mainAfterMove (undo the injected conflict commit) so we can test a clean merge!
  git('reset', '--hard', '-q', mainAfterMove);

  // 5. Successful Close and Merge: merges with --no-ff, removes worktree and branch (-d), clears hold/session, and closes with closing-statement line.
  const p3 = await closeMergePreview(first, name);
  assert.equal(p3.ok, true);
  const merged = await closeAndMerge(first, name, p3.preview.snapshot);
  assert.equal(merged.ok, true);
  assert.equal(merged.targetBranch, 'main');
  assert.match(merged.mergeCommit, /^[0-9a-f]{7}$/);
  assert.equal(git('rev-parse', '--short=7', 'main'), merged.mergeCommit);
  assert.equal(git('show', '-s', '--format=%s', 'main'), `[${name}] Merge worker/${name}`);
  assert.equal(existsSync(tree), false, 'worktree removed after merge');
  assert.throws(() => git('rev-parse', '--verify', `refs/heads/worker/${name}`), 'branch deleted after merge');
  assert.ok(first.screen.room.closedDiscussions.includes(name));
  const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
  assert.ok(stmt.includes(`Worker work merged into \`main\` as \`${merged.mergeCommit}\`.`));
});

test('Close and Merge active-work notice and shared room lock with Close and Discard', async () => {
  const { writeFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, closeMergePreview, closeAndMerge, discardPreview, closeAndDiscard } = await import('../src/ui.mjs');
  const inTree = (path, ...a) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  let releaseOther;
  const otherGate = new Promise((r) => { releaseOther = r; });
  const { first, git, contexts } = await multiRoom({ worker: async (ctx, p) => {
    const tree = ctx.workerDir.path;
    if (p.endsWith('commit a')) {
      writeFileSync(`${tree}/a.txt`, 'a\n');
      inTree(tree, 'add', 'a.txt');
      inTree(tree, 'commit', '-q', '-m', `[${ctx.discussion.name}] a`);
      return `Docs: none needed, because test.\nTested: ${inTree(tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`;
    }
    if (p.endsWith('commit b')) {
      writeFileSync(`${tree}/b.txt`, 'b\n');
      inTree(tree, 'add', 'b.txt');
      inTree(tree, 'commit', '-q', '-m', `[${ctx.discussion.name}] b`);
      return 'ok\nDocs: none needed, because test.';
    }
    if (p.endsWith('run b')) { await otherGate; return 'ok'; }
    return 'ok';
  } });

  await handleLine('disc-a', first);
  const nameA = first.discussion.name;
  queueWork(first, 'commit a');
  await first.workQueue;

  // 1. With nothing else active and no other branches with unmerged commits: notice is omitted.
  const quiet = await closeMergePreview(first, nameA);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.preview.activeNotice, undefined);

  // 2. With another discussion in a round, another worker task running + queued, and another branch with unmerged commits:
  // notice lists all of them, does not block merge, and does NOT invalidate the snapshot from before!
  await handleLine('/new', first);
  const second = contexts()[1];
  await handleLine('disc-b', second);
  const nameB = second.discussion.name;
  queueWork(second, 'commit b');
  await second.workQueue;

  second.screen.thinking = 'A'; // simulate disc-b in the middle of a round
  queueWork(second, 'run b');
  queueWork(second, 'queued b');
  await until(() => workerLane(second, nameB).running);

  const busy = await closeMergePreview(first, nameA);
  assert.equal(busy.ok, true);
  assert.match(busy.preview.activeNotice, /Active now: 1 discussion in a round, 1 worker task running \(worker\/[^)]+\), 1 queued \(worker\/[^)]+\)\./);
  assert.match(busy.preview.activeNotice, new RegExp(`Other branches may need Catch up with main afterwards: worker/${nameB}\\.`));
  // Active-work notice is not part of the snapshot!
  assert.equal(busy.preview.snapshot, quiet.preview.snapshot);

  // 3. Shared lock: while Close and Merge holds the lock, Close and Discard is refused at once and changes nothing.
  let discardAttempt;
  const mergeRes = await closeAndMerge(first, nameA, quiet.preview.snapshot, {
    _beforeMerge: async () => {
      discardAttempt = await closeAndDiscard(second, nameB, 'any-snap').then(() => null, (err) => err);
    },
  });
  assert.equal(mergeRes.ok, true);
  assert.ok(discardAttempt instanceof Error);
  assert.match(discardAttempt.message, new RegExp(`Cannot Close and Discard ${nameB}: Close and Merge for ${nameA} is already in progress`));
  assert.ok(existsSync(second.workerDir.path), 'second worktree untouched while lock held');

  // Release disc-b's running/queued tasks so we can test failed Discard releasing the lock.
  second.screen.thinking = null;
  releaseOther();
  await second.workQueue;

  // 4. Shared lock is released after a failed Close and Discard (e.g. refusal error inside lock).
  const treeB = second.workerDir.path;
  const wtGitDirB = inTree(treeB, 'rev-parse', '--absolute-git-dir');
  writeFileSync(`${wtGitDirB}/MERGE_HEAD`, git('rev-parse', 'HEAD') + '\n');
  await assert.rejects(() => closeAndDiscard(second, nameB, 'snap'), /mid-merge/);
  assert.equal(first.shop.merging, null, 'lock must be released after failed Discard');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(`${wtGitDirB}/MERGE_HEAD`);
  // Subsequent discardPreview succeeds immediately now that the lock is free.
  const afterFail = await discardPreview(second, nameB);
  assert.equal(afterFail.ok, true);
});

test('plain Close implicitly cleans up an already-merged clean branch (removing .worker-notes/ and node_modules/), hides Close and Discard when nothing would be lost, keeps unmerged/untracked work, and reports when the shared lock is held', async () => {
  const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, refreshWorker } = await import('../src/ui.mjs');
  const inTree = (path, ...a) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  // 1. Merged clean branch with .worker-notes/ and node_modules/ -> Close and Discard hidden; plain Close removes worktree & branch.
  {
    const { first, git } = await multiRoom({ worker: (ctx) => {
      writeFileSync(`${ctx.workerDir.path}/done.txt`, 'ok\n');
      inTree(ctx.workerDir.path, 'add', 'done.txt');
      inTree(ctx.workerDir.path, 'commit', '-q', '-m', `[${ctx.discussion.name}] done`);
      return 'ok\nDocs: none needed, because test.';
    } });
    writeFileSync(`${first.cwd}/.gitignore`, 'node_modules/\n');
    git('add', '.gitignore'); git('commit', '-q', '-m', 'ignore node_modules');
    await handleLine('merged-clean', first);
    const { name, dir } = first.discussion;
    queueWork(first, 'do work');
    await first.workQueue;
    const tree = first.workerDir.path;

    // Before merging: has unmerged commit -> Close and Discard IS offered.
    await refreshWorker(first);
    assert.ok(first.screen.workerInfo.discardable.includes(name));

    // Merge into main, and add gitignored .worker-notes/ and node_modules/ in the worktree.
    git('merge', '--no-ff', '-q', `worker/${name}`, '-m', 'merge manually');
    mkdirSync(`${tree}/.worker-notes/stage-1`, { recursive: true });
    writeFileSync(`${tree}/.worker-notes/stage-1/scratch.md`, 'scratch\n');
    mkdirSync(`${tree}/node_modules/pkg`, { recursive: true });
    writeFileSync(`${tree}/node_modules/pkg/index.js`, 'module.exports = 1;\n');

    // Now merged & clean (only ignored files): Close and Discard is NOT offered.
    await refreshWorker(first);
    assert.ok(!first.screen.workerInfo.discardable.includes(name));

    // Plain Close cleans up automatically and writes the closing-statement line.
    await handleLine('/close', first);
    assert.equal(existsSync(tree), false, 'merged worktree removed on Close');
    assert.throws(() => git('rev-parse', '--verify', `refs/heads/worker/${name}`), 'merged branch deleted on Close');
    const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
    assert.ok(stmt.includes('Worker worktree and branch removed (already merged).'));
  }

  // 2. Unmerged commit or untracked file -> Close keeps everything, Close and Discard stays offered.
  {
    const { first, git } = await multiRoom({ worker: (ctx) => {
      writeFileSync(`${ctx.workerDir.path}/done.txt`, 'ok\n');
      inTree(ctx.workerDir.path, 'add', 'done.txt');
      inTree(ctx.workerDir.path, 'commit', '-q', '-m', `[${ctx.discussion.name}] done`);
      return 'ok\nDocs: none needed, because test.';
    } });
    await handleLine('merged-untracked', first);
    const { name, dir } = first.discussion;
    queueWork(first, 'do work');
    await first.workQueue;
    const tree = first.workerDir.path;
    git('merge', '--no-ff', '-q', `worker/${name}`, '-m', 'merge manually');
    writeFileSync(`${tree}/untracked-note.txt`, 'keep me\n');

    await refreshWorker(first);
    assert.ok(first.screen.workerInfo.discardable.includes(name), 'Close and Discard offered for untracked file');
    await handleLine('/close', first);
    assert.equal(existsSync(`${tree}/untracked-note.txt`), true, 'untracked file kept on Close');
    assert.ok(git('rev-parse', '--verify', `refs/heads/worker/${name}`), 'branch kept on Close');
    const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
    assert.doesNotMatch(stmt, /Worker worktree and branch removed/);
    assert.match(stmt, /Worker work pending on/);
  }

  // 3. Shared lock held by another operation -> cleanup skipped, discussion still closes, reported in room and closing statement.
  {
    const { first, git } = await multiRoom({ worker: () => 'ok' });
    await handleLine('locked-clean', first);
    const { name, dir } = first.discussion;
    queueWork(first, 'create worktree');
    await first.workQueue;
    const tree = first.workerDir.path;

    first.shop.merging = 'Close and Merge for other-disc';
    try {
      await handleLine('/close', first);
    } finally {
      first.shop.merging = null;
    }
    assert.ok(first.screen.room.closedDiscussions.includes(name), 'discussion still closes when lock is held');
    assert.equal(existsSync(tree), true, 'worktree left untouched when lock is held');
    assert.ok(git('rev-parse', '--verify', `refs/heads/worker/${name}`), 'branch left untouched when lock is held');
    assert.ok(first.notes.some((n) => /not removed.*Close and Merge for other-disc was in progress/.test(n)));
    const stmt = readFileSync(`${dir}/closing-statement.md`, 'utf8');
    assert.match(stmt, /Worker worktree and branch not removed \(Close and Merge for other-disc was in progress\): nothing removed\./);
  }
});

test('after a worker task ends, refreshed workerInfo clears the finished task so Close and Merge is enabled without clicking Worker tab, and reflects holds for uncommitted edits', async () => {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork } = await import('../src/ui.mjs');
  const inTree = (path, ...a) => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  let mode = 'clean-pass';
  const { first, git } = await multiRoom({ worker: (ctx) => {
    const tree = ctx.workerDir.path;
    if (mode === 'clean-pass') {
      writeFileSync(`${tree}/feat.txt`, 'ok\n');
      inTree(tree, 'add', 'feat.txt');
      inTree(tree, 'commit', '-q', '-m', `[${ctx.discussion.name}] add feat`);
      return `Docs: none needed, because test.\nTested: ${inTree(tree, 'rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`;
    }
    if (mode === 'leave-dirty') {
      writeFileSync(`${tree}/uncommitted.txt`, 'wip\n');
      return 'left wip';
    }
    return 'ok';
  } });

  await handleLine('post-task-refresh', first);
  const { name } = first.discussion;

  // 1. Clean task with passing Tested: line -> without clicking Worker tab or calling refreshWorker,
  // the last workerinfo event sent to the page shows canMerge: true (not greyed out for running/queued).
  queueWork(first, 'implement feature');
  await first.workQueue;
  const lastInfo1 = first.events.filter((e) => e.type === 'workerinfo').at(-1)?.info;
  assert.ok(lastInfo1, 'workerinfo event sent after task');
  assert.equal(lastInfo1.mergeable[name]?.canMerge, true);
  assert.equal(lastInfo1.mergeable[name]?.disabledReason, null);
  assert.equal(first.screen.workerInfo.mergeable[name]?.canMerge, true);

  // 2. Task that leaves uncommitted edits -> refreshed workerInfo after hold reflects dirty state and disables Close and Merge for uncommitted edits (not running/queued).
  mode = 'leave-dirty';
  queueWork(first, 'leave edits');
  await first.workQueue;
  const lastInfo2 = first.events.filter((e) => e.type === 'workerinfo').at(-1)?.info;
  assert.ok(workerLane(first, name).blockedBy, 'lane is held for uncommitted edits');
  assert.equal(lastInfo2.mergeable[name]?.canMerge, false);
  assert.match(lastInfo2.mergeable[name]?.disabledReason, /uncommitted edits/);
  assert.ok(lastInfo2.pending.some((p) => p.lane === name && p.dirty === true));
  assert.ok(lastInfo2.discardable.includes(name));
});

test('discussion and brainstorm prompts (including summary turns) start with each agent\'s own usage line from live totals and cached quota', async () => {
  const cwd = await tmp('usage-line-disc-');
  const ctx = { cwd, agentSpecs: 'claude:A,codex:B', workerSpec: 'claude:W', state: { transcript: [], seen: new Map() }, sessions: new Map() };
  Object.assign(ctx, await load(ctx, ''));
  ctx.suggestTitle = async () => ({ title: 'Usage line' });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  ctx.screen.quota = [
    { provider: 'claude', label: '5h', used: 70, resets: null },
    { provider: 'claude', label: 'week', used: 31, resets: null },
    { provider: 'codex', label: '5h', used: 20, resets: null },
    { provider: 'codex', label: 'week', used: 3, resets: null },
  ];
  ctx.screen.quotaAt = { measured: `${today} 09:42:00`, checked: now.toISOString() };
  const fakeQuota = {
    claude: { ok: true, parsed: { current_session: { used_percent: 70 }, current_week_all_models: { used_percent: 31 } } },
    codex: { ok: true, parsed: { five_hour_limit: { used_percent: 20 }, weekly_limit: { used_percent: 3 } } },
    last_update: `${today} 09:42:00`,
  };
  let meterCallsDuringRound = 0;
  let meterCalls = 0;
  ctx.usage = { ...ctx.usage, fetchQuota: async () => { meterCalls++; return fakeQuota; } };

  const [a, b] = ctx.room.agents;
  const aPrompts = [], bPrompts = [];
  const aReplies = ['idea', 'PASS', '**Agreed**\n- idea'];
  const bReplies = ['ok', 'PASS', 'PASS'];
  a.turn = async (p) => { if (aPrompts.length < 2) meterCallsDuringRound = meterCalls; aPrompts.push(p); a.lastUsage = { input: 1200, cached: 800, output: 150 }; return aReplies.shift() ?? 'PASS'; };
  b.turn = async (p) => { bPrompts.push(p); b.lastUsage = { input: 900, cached: 100, output: 50 }; return bReplies.shift() ?? 'PASS'; };

  await handleLine('hello', ctx);
  assert.equal(meterCallsDuringRound, 0);
  // First turn of each agent: none yet + own provider's cached quota only.
  assert.match(aPrompts[0], /^\[your reported usage this session: none yet · claude quota 70% 5h \/ 31% week, meter at 09:42\]\n\nYou are A/);
  assert.doesNotMatch(aPrompts[0].split('\n')[0], /codex/);
  assert.match(bPrompts[0], /^\[your reported usage this session: none yet · codex quota 20% 5h \/ 3% week, meter at 09:42\]\n\nYou are B/);
  assert.doesNotMatch(bPrompts[0].split('\n')[0], /claude/);
  // Second turn within the same round: reads updated ctx.totals, never the other agent's figures.
  assert.match(aPrompts[1], /^\[your reported usage this session: 1 turn, 1\.2k in \(800 cached\) \/ 150 out · claude quota 70% 5h \/ 31% week, meter at 09:42\]\n\n/);
  assert.match(bPrompts[1], /^\[your reported usage this session: 1 turn, 900 in \(100 cached\) \/ 50 out · codex quota 20% 5h \/ 3% week, meter at 09:42\]\n\n/);
  // Summary turn (auto-summarize) also carries the updated line.
  assert.match(aPrompts[2], /^\[your reported usage this session: 2 turns, 2\.4k in \(1\.6k cached\) \/ 300 out · claude quota 70% 5h \/ 31% week, meter at 09:42\]\n\n/);
  assert.match(aPrompts[2], /asked for a summary/);

  // Brainstorm prompt also carries the line at the top.
  ctx.state.brainstorm = true;
  assert.match(ctx.room.promptFor(a), /^\[your reported usage this session: 3 turns, 3\.6k in \(2\.4k cached\) \/ 450 out · claude quota 70% 5h \/ 31% week, meter at 09:42\]\n\n/);
});

test('worker prompt starts with only the worker\'s own usage line from ctx.totals and cached quota', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('usage-line-worker-');
  await gitRoom(cwd);
  const ctx = { cwd, agentSpecs: 'claude:A', workerSpec: 'codex:W', state: { transcript: [], seen: new Map() }, sessions: new Map() };
  Object.assign(ctx, await load(ctx, ''));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  ctx.totals.A = { turns: 9, input: 99000, cached: 50000, output: 4000 }; // another agent's totals: must never appear
  ctx.screen.quota = [
    { provider: 'claude', label: '5h', used: 70, resets: null },
    { provider: 'codex', label: '5h', used: 20, resets: null },
    { provider: 'codex', label: 'week', used: 3, resets: null },
  ];
  ctx.screen.quotaAt = { measured: `${today} 09:42:00`, checked: now.toISOString() };
  let meterCallsBeforeTurn = 0;
  let meterCalls = 0;
  ctx.usage = { ...ctx.usage, fetchQuota: async () => { meterCalls++; return null; } };

  const got = [];
  ctx.worker.turn = async (p) => {
    if (got.length === 0) meterCallsBeforeTurn = meterCalls;
    got.push(p);
    ctx.worker.lastUsage = { input: 5000, cached: 3000, output: 400 };
    return 'done';
  };
  queueWork(ctx, 'first work');
  await ctx.workQueue;
  assert.equal(meterCallsBeforeTurn, 0);
  assert.match(got[0], /^\[your reported usage this session: none yet · codex quota 20% 5h \/ 3% week, meter at 09:42\]\n\n/);
  assert.doesNotMatch(got[0].split('\n')[0], /claude|99\.0k/);

  // Restore cached quota (refreshQuota after turn 1 overwrote it with null because our stub returned null) and run turn 2.
  ctx.screen.quota = [{ provider: 'codex', label: '5h', used: 21, resets: null }, { provider: 'codex', label: 'week', used: 4, resets: null }];
  ctx.screen.quotaAt = { measured: `${today} 09:43:00`, checked: now.toISOString() };
  queueWork(ctx, 'second work');
  await ctx.workQueue;
  assert.match(got[1], /^\[your reported usage this session: 1 turn, 5\.0k in \(3\.0k cached\) \/ 400 out · codex quota 21% 5h \/ 4% week, meter at 09:43\]\n\nsecond work$/);
});

test('a detached worker from another discussion reports usage unavailable instead of none yet or the new discussion\'s totals', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const cwd = await tmp('usage-line-detached-');
  await gitRoom(cwd);
  const ctx = { cwd, agentSpecs: 'claude:A', workerSpec: 'codex:W', noScreen: true, state: { transcript: [], seen: new Map() }, sessions: new Map() };
  Object.assign(ctx, await load(ctx, ''));
  ctx.suggestTitle = async () => ({ title: 'First' });
  ctx.room.agents[0].turn = async () => 'PASS';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const fakeQuota = {
    codex: { ok: true, parsed: { five_hour_limit: { used_percent: 20 }, weekly_limit: { used_percent: 3 } } },
    last_update: `${today} 09:42:00`,
  };
  ctx.screen.quota = [{ provider: 'codex', label: '5h', used: 20, resets: null }, { provider: 'codex', label: 'week', used: 3, resets: null }];
  ctx.screen.quotaAt = { measured: fakeQuota.last_update, checked: now.toISOString() };
  ctx.usage = { ...ctx.usage, fetchQuota: async () => fakeQuota };

  await handleLine('hello', ctx);
  const got = [];
  let releaseFirst;
  ctx.worker.turn = async (p) => {
    got.push(p);
    return got.length === 1 ? new Promise((r) => { releaseFirst = r; }) : 'second done';
  };
  queueWork(ctx, 'first task');
  queueWork(ctx, 'queued from old discussion');
  await until(() => releaseFirst);

  await handleLine('/new', ctx);
  ctx.totals.W = { turns: 7, input: 77000, cached: 1000, output: 500 }; // new discussion's totals: must not leak to old worker
  releaseFirst('first done');
  await ctx.workQueue;
  assert.equal(got.length, 2);
  assert.match(got[1], /^\[your reported usage this session: usage unavailable · codex quota 20% 5h \/ 3% week, meter at 09:42\]\n\nqueued from old discussion$/);
  assert.doesNotMatch(got[1].split('\n')[0], /none yet|77\.0k/);
});

test('closing one of two open discussions removes it from the other page\'s open list once its quit finishes', async () => {
  const { stopRoom, ended } = await import('../src/ui.mjs');
  const { hub, first, contexts } = await multiRoom();
  await handleLine('topic-a', first);
  await handleLine('/new', first);
  const [, second] = contexts();
  await handleLine('topic-b', second);
  const closedName = second.discussion.name;
  second.closingAgent = () => ({ name: 'W', turn: async () => 'Closing statement: pending-instructions.md' });

  await handleLine('/close', second);
  assert.ok(second.queued.includes('/quit'));

  // Run the /quit tail as cli.mjs does: stopRoom, ended, then delete from hub.rooms.
  await stopRoom(second);
  await ended(second, false);
  hub.rooms.delete(second.key);

  assert.deepEqual(first.screen.room.open.map((o) => o.active), [`discussions/${first.discussion.name}`]);
  assert.ok(first.screen.room.closedDiscussions.includes(closedName));
  const lastRoomEvent = first.events.filter((e) => e.type === 'room').at(-1)?.room;
  assert.deepEqual(lastRoomEvent.open.map((o) => o.active), [`discussions/${first.discussion.name}`]);
  assert.ok(lastRoomEvent.closedDiscussions.includes(closedName));
});

test('checkWorkerReport and formattedTurn: good reports, Tested/Docs rules, conflict stop, pure catch-up, and generic one-retry helper', async () => {
  const { checkWorkerReport } = await import('../src/ui.mjs');
  const { formattedTurn } = await import('../src/room.mjs');
  const branchId = 'a'.repeat(40), mainId = 'b'.repeat(40);
  const testedLine = `Tested: ${branchId} with main ${mainId}: tests passed`;
  const bothOwed = { askedCatchUp: true, mergePending: false, mainInHead: true, ownCommits: 1 };

  // 1. A good report (with both Docs: and Tested:).
  assert.deepEqual(checkWorkerReport(`Done.\n\nDocs: updated README.md.\n${testedLine}`, bothOwed), []);

  // 2. Tested: missing, bold, short IDs, not last.
  assert.match(checkWorkerReport('Done.\nDocs: none needed, because internal.', bothOwed).join('\n'), /has no Tested: line/);
  assert.match(checkWorkerReport(`Done.\nDocs: none needed, because internal.\n**${testedLine}**`, bothOwed).join('\n'), /bold or styled Tested: line/);
  assert.match(checkWorkerReport('Done.\nDocs: none needed, because internal.\nTested: aaaaaaa with main bbbbbbb: tests passed', bothOwed).join('\n'), /short commit IDs/);
  assert.match(checkWorkerReport(`Done.\nDocs: none needed, because internal.\n${testedLine}\nTrailing line.`, bothOwed).join('\n'), /not the reply's last non-empty line/);

  // 3. Docs: missing or after Tested:.
  assert.match(checkWorkerReport(`Done.\n${testedLine}`, bothOwed).join('\n'), /has no Docs: line/);
  const afterTested = checkWorkerReport(`Done.\n${testedLine}\nDocs: none needed, because internal.`, bothOwed).join('\n');
  assert.match(afterTested, /Docs: line after its Tested: line/);
  assert.match(afterTested, /not the reply's last non-empty line/);

  // 4. Conflict stop (asked to catch up, merge pending, no own commits): owes neither Tested: nor Docs:.
  assert.deepEqual(checkWorkerReport('Merge conflict in shared.txt; stopped as instructed.', {
    askedCatchUp: true, mergePending: true, mainInHead: false, ownCommits: 0,
  }), []);

  // 5. Pure catch-up (asked to catch up, main in HEAD, no merge pending, 0 own non-merge commits): owes Tested: only, no Docs:.
  assert.deepEqual(checkWorkerReport(`Merged main and ran npm test.\n${testedLine}`, {
    askedCatchUp: true, mergePending: false, mainInHead: true, ownCommits: 0,
  }), []);
  assert.match(checkWorkerReport('Merged main and ran npm test.', {
    askedCatchUp: true, mergePending: false, mainInHead: true, ownCommits: 0,
  }).join('\n'), /has no Tested: line/);

  // 6. Own commit without catch-up: owes Tested: when main is in HEAD and main did not move; not owed when main is not in HEAD, no commit was made, or main moved.
  assert.match(checkWorkerReport('Committed.\nDocs: none needed, because internal.', {
    askedCatchUp: false, mergePending: false, mainInHead: true, mainMoved: false, ownCommits: 1,
  }).join('\n'), /has no Tested: line/);
  assert.deepEqual(checkWorkerReport(`Committed.\nDocs: none needed, because internal.\n${testedLine}`, {
    askedCatchUp: false, mergePending: false, mainInHead: true, mainMoved: false, ownCommits: 1,
  }), []);
  assert.deepEqual(checkWorkerReport('Committed on behind branch.\nDocs: none needed, because internal.', {
    askedCatchUp: false, mergePending: false, mainInHead: false, mainMoved: false, ownCommits: 1,
  }), []);
  assert.deepEqual(checkWorkerReport('Checked files, no commit made.', {
    askedCatchUp: false, mergePending: false, mainInHead: true, mainMoved: false, ownCommits: 0,
  }), []);
  assert.deepEqual(checkWorkerReport('Committed, but main moved during tests so no Tested line.\nDocs: none needed, because internal.', {
    askedCatchUp: false, mergePending: false, mainInHead: true, mainMoved: true, ownCommits: 1,
  }), []);
  assert.deepEqual(checkWorkerReport('Caught up, but main moved during tests.', {
    askedCatchUp: true, mergePending: false, mainInHead: true, mainMoved: true, ownCommits: 0,
  }), []);

  // 7. formattedTurn generic helper: asks the same session at most once.
  const calls = [];
  const fakeAgent = { turn: async (p) => { calls.push(p); return calls.length === 1 ? 'bad' : 'good'; } };
  const ok = await formattedTurn(fakeAgent, 'initial', {
    check: (r) => (r === 'good' ? [] : ['missing tag']),
    retryPrompt: (probs) => `fix: ${probs.join(',')}`,
  });
  assert.deepEqual(ok, { text: 'good', problems: [], firstProblems: ['missing tag'], retried: true });
  assert.deepEqual(calls, ['initial', 'fix: missing tag']);
});

test('worker report format retry flow: fixed on retry and still wrong after one retry', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, mergeReadiness, workerPlace } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  writeFileSync(`${ctx.cwd}/a.txt`, 'base\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  await handleLine('hello', ctx);
  const name = ctx.discussion.name;
  const inTree = (...a) => execFileSync('git', ['-C', ctx.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  // Case 1: Fixed on retry (first reply has short Tested: IDs and no Docs:; retry fixes both).
  let step = 0;
  ctx.worker.turn = async (p) => {
    got.push(p);
    step++;
    if (step === 1) {
      writeFileSync(`${ctx.workerDir.path}/a.txt`, 'v1\n');
      inTree('commit', '-q', '-am', `[${name}] step 1`);
      ctx.worker.lastUsage = { input: 100, cached: 0, output: 20 };
      return `Done.\nTested: ${inTree('rev-parse', '--short', 'HEAD')} with main ${git('rev-parse', '--short', 'main')}: tests passed`;
    }
    ctx.worker.lastUsage = { input: 50, cached: 10, output: 15 };
    return `Done.\nDocs: updated README.md.\nTested: ${inTree('rev-parse', 'HEAD')} with main ${git('rev-parse', 'main')}: tests passed`;
  };
  writeFileSync(`${ctx.cwd}/m.txt`, 'main1\n'); git('add', 'm.txt'); git('commit', '-q', '-m', 'main advances');
  queueWork(ctx, 'do step 1');
  await ctx.workQueue;

  assert.equal(step, 2, 'asked once to fix format');
  assert.match(got[1], /Your report has a format problem:.*has no Docs: line.*short commit IDs/s);
  assert.match(got[1], /Do no new work: do not run commands, do not edit files, and do not commit/);
  // Both replies and their usage are kept in the Worker tab and transcript, and totals sum both turns.
  const workerReplies1 = ctx.screen.worker.filter((m) => m.speaker === 'W');
  assert.equal(workerReplies1.length, 2);
  assert.deepEqual(ctx.totals.W, { turns: 2, input: 150, cached: 10, output: 35 });
  assert.ok(ctx.screen.worker.some((m) => m.note?.startsWith('Format check: the W\'s report ') && m.note.endsWith('Asked once to fix it.')));
  assert.ok(ctx.screen.worker.some((m) => m.note === 'Format check: fixed on retry.'));
  assert.match(readFileSync(ctx.logPath, 'utf8'), /Format check: the W's report .* Asked once to fix it\.[\s\S]*Format check: fixed on retry\./);
  const place = await workerPlace(ctx.cwd, name);
  assert.equal((await mergeReadiness(ctx, place)).canMerge, true, 'valid Tested: line on retry is recorded');

  // Case 2: Still wrong after one retry (short IDs rejected and not recorded; problems listed for discussion agents).
  writeFileSync(`${ctx.cwd}/m.txt`, 'main2\n'); git('commit', '-q', '-am', 'main advances again');
  const main2 = git('rev-parse', 'main');
  const relayed = [];
  ctx.autoDev = { status: 'running', cycle: 1, limit: 5, waiting: true };
  ctx.say = (line) => relayed.push(line);
  let step2 = 0;
  ctx.worker.turn = async (p) => {
    got.push(p);
    step2++;
    if (step2 === 1) {
      inTree('merge', 'main', '--no-edit');
      writeFileSync(`${ctx.workerDir.path}/a.txt`, 'v2\n');
      inTree('commit', '-q', '-am', `[${name}] step 2`);
    }
    return `Still missing docs and using short IDs.\nTested: ${inTree('rev-parse', '--short', 'HEAD')} with main ${main2.slice(0, 7)}: tests passed`;
  };
  queueWork(ctx, 'do step 2', ctx.autoDev);
  await ctx.workQueue;
  assert.equal(step2, 2, 'only one retry attempt, no loop');
  assert.ok(ctx.screen.worker.some((m) => m.note?.startsWith('Format check: still wrong:') && m.note.includes('has no Docs: line') && m.note.includes('short commit IDs')));
  // Rejected short-ID Tested: line was NOT recorded for the new HEAD/main2.
  assert.equal((await mergeReadiness(ctx, place)).canMerge, false);
  // The report queued for the discussion agents uses the final reply and lists the remaining format problems.
  assert.equal(ctx.workerReports?.length, 1);
  assert.match(ctx.workerReports[0].text, /Still missing docs[\s\S]*Format check still wrong:.*has no Docs: line.*short commit IDs/);

  // Case 3: When main moves during a task that makes a commit on a branch containing mainAtStart, Tested: is not owed (decided from Git).
  let step3 = 0;
  ctx.worker.turn = async () => {
    step3++;
    writeFileSync(`${ctx.workerDir.path}/a.txt`, 'v3\n');
    inTree('commit', '-q', '-am', `[${name}] step 3`);
    writeFileSync(`${ctx.cwd}/m.txt`, 'main3\n'); git('commit', '-q', '-am', 'main advances during turn');
    return 'Committed while main moved.\nDocs: none needed, because internal.';
  };
  queueWork(ctx, 'do step 3');
  await ctx.workQueue;
  assert.equal(step3, 1, 'no retry when main moved during the task');
});

test('worker report format retry flow: retry that changes HEAD keeps changes, logs it, re-runs checks and recordTested, and pauses auto dev', async () => {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { queueWork, mergeReadiness, workerPlace } = await import('../src/ui.mjs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  writeFileSync(`${ctx.cwd}/f.txt`, 'base\n'); git('add', 'f.txt'); git('commit', '-q', '-m', 'base');
  await handleLine('hello', ctx);
  const name = ctx.discussion.name;
  const inTree = (...a) => execFileSync('git', ['-C', ctx.workerDir.path, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).toString().trim();

  ctx.autoDev = { status: 'running', cycle: 1, limit: 5, waiting: true };
  ctx.say = () => {};
  let attempt = 0, headAfterRetry = null;
  ctx.worker.turn = async () => {
    attempt++;
    if (attempt === 1) {
      writeFileSync(`${ctx.workerDir.path}/f.txt`, 'turn1\n');
      inTree('commit', '-q', '-am', `[${name}] turn 1 commit`);
      return 'Forgot Docs line on turn 1.';
    }
    // Misbehaving retry makes a new commit on HEAD and reports Docs: + Tested: for the new HEAD.
    writeFileSync(`${ctx.workerDir.path}/f.txt`, 'turn2\n');
    inTree('commit', '-q', '-am', `[${name}] extra commit during retry`);
    headAfterRetry = inTree('rev-parse', 'HEAD');
    return `Fixed report.\nDocs: none needed, because internal.\nTested: ${headAfterRetry} with main ${git('rev-parse', 'main')}: tests passed`;
  };
  queueWork(ctx, 'task with misbehaving retry', ctx.autoDev);
  await ctx.workQueue;

  assert.equal(attempt, 2);
  assert.equal(inTree('rev-parse', 'HEAD'), headAfterRetry, 'changes made during retry are kept');
  assert.ok(ctx.screen.worker.some((m) => m.note?.includes('format retry changed the worktree or HEAD (HEAD moved from')));
  assert.equal(ctx.autoDev.status, 'paused');
  assert.match(ctx.autoDev.reason, /format retry changed the worktree or HEAD/);
  const place = await workerPlace(ctx.cwd, name);
  assert.equal((await mergeReadiness(ctx, place)).canMerge, true, 'recordTested ran against the new HEAD after retry');
});

test('checkSummary: inline-form rule, Outcome and Steps left rules while running and while paused, and auto dev blocks invalid instructions', async () => {
  const { checkSummary } = await import('../src/ui.mjs');

  // 1. Missing Next step is not a problem by itself; one-line inline instruction (with quotes inside) is fine; multi-line inline instruction is rejected.
  assert.deepEqual(checkSummary('**Agreed**\n- point only'), []);
  assert.deepEqual(checkSummary('**Next step**\n- Send to the Worker: "Fix \\"the\\" test on one line."'), []);
  assert.match(checkSummary('**Next step**\n- Send to the Worker: "Line one.\nLine two."').join('\n'),
    /uses inline quotes for a multi-line instruction/);
  assert.deepEqual(checkSummary('**Next step**\n- Send to the Worker:\n> Line one.\n> Line two.'), []);
  assert.match(checkSummary('**Next step**\n- Send to the Worker: <angle>').join('\n'), /no quoted instruction/);

  // 2. While auto dev is running: Outcome required (SEND, FINISH or WAIT FOR USER); SEND requires an instruction; Steps left (if any) must be a whole number > 0 just before Outcome.
  assert.match(checkSummary('**Agreed**\n- x', { autoDev: 'running' }).join('\n'), /no Outcome line/);
  assert.match(checkSummary('**Agreed**\n- x\n\nOutcome: SEND', { autoDev: 'running' }).join('\n'), /says SEND, but its Next step has no instruction/);
  assert.deepEqual(checkSummary('**Agreed**\n- x\n\nOutcome: FINISH', { autoDev: 'running' }), []);
  assert.deepEqual(checkSummary('**Agreed**\n- x\n\nOutcome: WAIT FOR USER', { autoDev: 'running' }), []);
  assert.deepEqual(checkSummary('**Next step**\n- Send to the Worker: "Do it"\n\nSteps left: 3\nOutcome: SEND', { autoDev: 'running' }), []);
  for (const badSteps of ['Steps left: 0', 'Steps left: -2', 'Steps left: 1.5', 'Steps left: nope', 'Steps left: 3\nextra line']) {
    assert.match(
      checkSummary(`**Next step**\n- Send to the Worker: "Do it"\n\n${badSteps}\nOutcome: SEND`, { autoDev: 'running' }).join('\n'),
      /Steps left: must be a whole number above 0 just before the Outcome line/,
    );
  }
  // A "Steps left:" line inside a block-quoted instruction is instruction text, not metadata.
  assert.deepEqual(
    checkSummary('**Next step**\n- Send to the Worker:\n> Keep Steps left: 0 as text.\n\nOutcome: SEND', { autoDev: 'running' }),
    [],
  );

  // 3. While auto dev is paused: Outcome must be FINISH or WAIT FOR USER (never SEND or missing).
  assert.deepEqual(checkSummary('**Agreed**\n- done\n\nOutcome: FINISH', { autoDev: 'paused' }), []);
  assert.deepEqual(checkSummary('**Agreed**\n- wait\n\nOutcome: WAIT FOR USER', { autoDev: 'paused' }), []);
  assert.match(checkSummary('**Next step**\n- Send to the Worker: "Do it"\n\nOutcome: SEND', { autoDev: 'paused' }).join('\n'),
    /auto dev is paused: Outcome must be FINISH or WAIT FOR USER, not SEND/);
  assert.match(checkSummary('**Agreed**\n- no outcome', { autoDev: 'paused' }).join('\n'), /no Outcome line/);

  // 4. In auto dev, a summary whose multi-line inline instruction is not fixed on retry pauses the run and is never sent.
  const ctx = await scriptedCtx(['spoke', 'PASS', 'PASS', summaryWith('Line 1\nLine 2', 'SEND'), 'PASS', 'PASS']);
  ctx.discussion = { name: 'test-disc' };
  ctx.autoDev = { status: 'running', cycle: 1, limit: 5, waiting: false };
  ctx.notes = [];
  ctx.docs = { ...ctx.docs, broadcast: (s, ev) => { if (ev.type === 'note') ctx.notes.push(ev.text); } };
  ctx.workerReports = [{ text: 'worker done', run: ctx.autoDev, retry: false, owner: 'test-disc' }];
  await handleLine('/autodev report', ctx);
  assert.equal(ctx.autoDev.status, 'paused');
  assert.match(ctx.autoDev.reason, /uses inline quotes for a multi-line instruction/);
  assert.ok(ctx.notes.some((n) => n.startsWith('Format check: A\'s summary ') && n.includes('uses inline quotes for a multi-line instruction')));
  assert.ok(ctx.notes.some((n) => n.startsWith('Format check: still wrong:')));
});
