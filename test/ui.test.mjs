import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLine, load, restartArgs } from '../src/ui.mjs';

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

test('the worker is a separate claude agent with its own session, kept across reloads', async () => {
  const ctx = freshCtx();
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
  const { createRoom } = await import('../src/room.mjs');
  const docs = await import('../src/docs.mjs');
  const usage = await import('../src/usage.mjs');
  const fake = (name) => ({ name, provider: 'claude', turn: async () => replies.shift() ?? 'PASS' });
  const state = { transcript: [], seen: new Map() };
  return {
    state, room: createRoom([fake('A'), fake('B')], state), worker: fake('W'), docs, totals: {},
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

test('auto-summarize: no summary after a round of passes, or when turned off', async () => {
  const quiet = await scriptedCtx([]);
  await handleLine('hello', quiet);
  assert.ok(!quiet.state.transcript.some((m) => m.speaker === 'Summary'));

  const off = await scriptedCtx(['an idea']);
  await handleLine('/autosummary off', off);
  assert.equal(off.autoSummary, false);
  await handleLine('hello', off);
  assert.ok(!off.state.transcript.some((m) => m.speaker === 'Summary'));
  await handleLine('/autosummary', off); // toggles
  assert.equal(off.autoSummary, true);
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
  await handleLine('/autosummary off', ctx); // said before the folder exists: kept for the transcript
  assert.deepEqual(readdirSync(ctx.cwd), []); // nothing written yet
  await handleLine('pendulums', ctx);
  const [name] = readdirSync(`${ctx.cwd}/discussions`);
  assert.match(name, /^\d{4}-\d{2}-\d{2}-about-pendulums$/);
  assert.equal(ctx.discussion.title, 'About pendulums');
  assert.match(prompts[0], new RegExp(`Its folder is ${ctx.cwd}/discussions/${name}: create, read and write this discussion's documents`));
  const text = readFileSync(ctx.logPath, 'utf8');
  assert.match(text, /^# About pendulums — session of/);
  assert.match(text, /auto-summarize off[\s\S]*title by Claude[\s\S]*\*\*User\*\*\n\npendulums/);
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

test('/continue: only before the first message; no title asked, the transcript goes in that discussion', async () => {
  const { mkdirSync, readdirSync } = await import('node:fs');
  const prompts = [];
  const ctx = await freshSession([], async () => { throw new Error('no title should be asked'); });
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`, { recursive: true });
  await handleLine('/continue nosuch', ctx);
  await handleLine('/continue ../x', ctx);
  assert.equal(ctx.discussion, undefined);
  await handleLine('/continue 2026-11-01-old', ctx);
  await handleLine('where were we?', ctx);
  assert.deepEqual(readdirSync(`${ctx.cwd}/discussions`), ['2026-11-01-old']);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/2026-11-01-old/transcripts`).length, 1);
  assert.match(prompts[0], /continues the discussion in .*2026-11-01-old.*Start from its handoff/);
});

test('/reopen after the session started: a fresh session in that discussion, from its handoff', async () => {
  const { mkdirSync, readdirSync, readFileSync } = await import('node:fs');
  const prompts = [];
  const ctx = await freshSession([], async () => ({ title: 'First topic' }));
  const resets = [];
  for (const a of [...ctx.room.agents, ctx.worker]) a.reset = () => resets.push(a.name);
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx);
  const first = ctx.logPath;
  const [name] = readdirSync(`${ctx.cwd}/discussions`);
  mkdirSync(`${ctx.cwd}/discussions/2026-11-01-old`);

  await handleLine('/reopen 2026-11-01-old', ctx);
  assert.equal(ctx.discussion.name, '2026-11-01-old');
  assert.deepEqual(resets, ['A', 'B', 'W']); // fresh CLI sessions for the agents and the worker
  assert.equal(ctx.logPath, null);
  assert.deepEqual(ctx.state.transcript, []); // the chat starts over (the same array, emptied)
  assert.equal(ctx.screen.transcript, ctx.state.transcript);
  assert.match(readFileSync(first, 'utf8'), /session ended: re-opening the discussion 2026-11-01-old/);

  await handleLine('back to it', ctx);
  assert.match(ctx.logPath, /discussions\/2026-11-01-old\/transcripts\/session-/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /You are A, one of several AI agents/); // introduced again, as in a new session
  assert.match(prompts[1], /continues the discussion in .*2026-11-01-old.*Start from its handoff/);
  assert.equal(readdirSync(`${ctx.cwd}/discussions/${name}/transcripts`).length, 1); // the first discussion keeps its transcript

  await handleLine('/reopen ../x', ctx);
  mkdirSync(`${ctx.cwd}/discussions/archive`); // the room's own material, not a discussion
  await handleLine('/reopen archive', ctx);
  assert.equal(ctx.discussion.name, '2026-11-01-old');
});

test('the worker is told the active discussion\'s folder with its first instruction there', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const got = [];
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  await gitRoom(ctx.cwd);
  ctx.worker.turn = async (p) => { got.push(p); return 'done'; };
  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx);
  queueWork(ctx, 'fix the bug'); // as the Worker tab sends it
  queueWork(ctx, 'and the test');
  await ctx.workQueue;
  assert.match(got[0], new RegExp(`^The active discussion's folder is ${ctx.discussion.dir}: create, read and write this discussion's documents`));
  assert.match(got[0], /fix the bug$/);
  assert.equal(got[1], 'and the test');
});

test('agent settings persist, apply before startup, and leave active sessions unchanged', async () => {
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
  for (const [key, value] of Object.entries(active)) assert.equal(ctx[key], value);
  assert.deepEqual(readDefaults(file), future);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(saveSettings(ctx, { ...settings, worker: settings.agents[0] }, file), /different name/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('/move: a whole discussion into archive/ or deferred/ and back; never the one in use', async () => {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'In use' }));
  const root = `${ctx.cwd}/discussions`;
  mkdirSync(`${root}/2026-11-01-old/transcripts`, { recursive: true });
  writeFileSync(`${root}/2026-11-01-old/notes.md`, 'n');
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

  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx); // creates the discussion in use
  await handleLine(`/move ${ctx.discussion.name} archive`, ctx);
  assert.ok(existsSync(ctx.discussion.dir));
});

test('/reopen of an archived discussion makes it active first; new names skip archived ones', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const { createDiscussionFolder } = await import('../src/ui.mjs');
  const ctx = await freshSession([], async () => { throw new Error('no title should be asked'); });
  const root = `${ctx.cwd}/discussions`;
  mkdirSync(`${root}/archive/2026-11-01-old`, { recursive: true });
  await handleLine('/reopen archive/2026-11-01-old', ctx);
  assert.equal(ctx.discussion.dir, `${root}/2026-11-01-old`);
  assert.ok(existsSync(`${root}/2026-11-01-old`) && !existsSync(`${root}/archive/2026-11-01-old`));

  mkdirSync(`${root}/deferred/2026-11-02-topic`, { recursive: true });
  assert.equal(createDiscussionFolder(root, 'Topic', new Date(2026, 10, 2)), '2026-11-02-topic-2');
});

test('Restart keeps the launch flags that matter: the same port, agents, worker and dev mode, in the discussion in use', () => {
  const ctx = { cwd: '/r', server: { address: () => ({ port: 5566 }) }, discussion: { name: '2026-11-03-a-topic' } };
  const args = restartArgs(ctx, { agents: 'claude:Ada', worker: 'codex:W', dev: true, open: true });
  assert.match(args[0], /src\/cli\.mjs$/);
  assert.deepEqual(args.slice(1), ['--cwd', '/r', '--port', '5566', '--agents', 'claude:Ada', '--worker', 'codex:W', '--dev', '--reopen', '2026-11-03-a-topic']);
  assert.deepEqual(restartArgs({ ...ctx, discussion: null }, {}).slice(1), ['--cwd', '/r', '--port', '5566']);
});

test('/new: nothing to end before the first message; it creates nothing and changes nothing', async () => {
  const { readdirSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'Topic' }));
  await handleLine('/new', ctx);
  assert.equal(ctx.discussion, undefined);
  assert.deepEqual(readdirSync(ctx.cwd), []);
});

test('/new after a round: the session ends as with Re-open; the next message starts a new titled discussion', async () => {
  const { mkdirSync, readdirSync, readFileSync, chmodSync } = await import('node:fs');
  const ctx = await freshSession([], async (text) => ({ title: text === 'hello' ? 'First topic' : 'Second topic' }));
  const resets = [];
  for (const a of [...ctx.room.agents, ctx.worker]) a.reset = () => resets.push(a.name);
  const prompts = [];
  ctx.room.agents[0].turn = async (p) => { prompts.push(p); return 'PASS'; };
  await handleLine('/autosummary off', ctx);
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

  // Going back: Re-open the first one (it remembers this one in turn).
  mkdirSync(`${ctx.cwd}/discussions/x`, { recursive: true });
  await handleLine(`/reopen ${name}`, ctx);
  assert.equal(ctx.discussion.name, name);
  assert.equal(ctx.screen.room.back.title, 'Second topic');
});

test('/new leaves the worker alone: a running task keeps its transcript, its log stays, the next instruction learns the new folder', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { readFileSync } = await import('node:fs');
  const titles = ['First topic', 'Second topic'];
  const ctx = await freshSession([], async () => ({ title: titles.shift() }));
  await gitRoom(ctx.cwd);
  let resetWorker = false;
  ctx.worker.reset = () => { resetWorker = true; };
  const got = [];
  let finish;
  ctx.worker.turn = async (p) => { got.push(p); return got.length === 2 ? new Promise((done) => { finish = done; }) : 'ok'; };
  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx);
  const first = ctx.logPath, firstDir = ctx.discussion.dir;
  queueWork(ctx, 'one');
  await ctx.workQueue;
  queueWork(ctx, 'long task');
  await until(() => finish);

  await handleLine('/new', ctx); // returns while the worker is still busy: it doesn't wait for it
  assert.equal(resetWorker, false);
  assert.ok(ctx.screen.worker.some((m) => m.note?.includes('is no longer the active one')));
  finish('long done');
  await ctx.workQueue;
  assert.match(readFileSync(first, 'utf8'), /long task[\s\S]*session ended[\s\S]*long done/); // in the old transcript
  assert.equal(ctx.screen.worker.filter((m) => m.speaker === 'W').length, 2); // the log stays

  queueWork(ctx, 'before the folder exists');
  await ctx.workQueue;
  assert.match(got[2], /^No discussion is active now: .* is no longer the active discussion's folder/);
  assert.ok(!got[2].includes('create, read and write'));
  assert.ok(got[2].includes(firstDir));

  await handleLine('second', ctx);
  queueWork(ctx, 'after');
  await ctx.workQueue;
  assert.match(got[3], new RegExp(`^The active discussion's folder is ${ctx.discussion.dir}: `));
  assert.ok(!readFileSync(ctx.logPath, 'utf8').includes('long done'));
});

test('after New discussion, the previous one can\'t move while its worker task runs; it can once the task ends', async () => {
  const { queueWork } = await import('../src/ui.mjs');
  const { existsSync, readFileSync } = await import('node:fs');
  const ctx = await freshSession([], async () => ({ title: 'First topic' }));
  let finish;
  await gitRoom(ctx.cwd);
  ctx.worker.turn = () => new Promise((done) => { finish = done; });
  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx);
  const name = ctx.discussion.name, first = ctx.logPath;
  queueWork(ctx, 'long task');
  await until(() => finish);
  await handleLine('/new', ctx);
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
  await handleLine('/autosummary off', ctx);
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
  assert.match(got[0], new RegExp(`^Your working directory is ${path}, your own Git worktree of the project, on the branch worker/main\\. Make your changes there, never in the room's root`));
  assert.match(got[0], /do it$/);
  await work(ctx, 'again');
  assert.equal(got[1], 'again'); // told once
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
  const again = (await workerRoom()).ctx; // a new process on the same room
  again.cwd = first.cwd;
  await work(again, 'more');
  assert.equal(again.workerDir.path, path);
  assert.equal(git('-C', path, 'status', '--porcelain'), '?? wip.txt'); // kept

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
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  const path = `${realpathSync(ctx.cwd)}.worker`;
  await work(ctx, 'start');
  git('commit', '-q', '--allow-empty', '-m', 'merged by the User');
  await work(ctx, 'next');
  assert.equal(git('rev-parse', 'worker/main'), git('rev-parse', 'HEAD')); // fast-forwarded

  git('commit', '-q', '--allow-empty', '-m', 'room 2');
  writeFileSync(`${path}/wip.txt`, 'x\n');
  const before = git('rev-parse', 'worker/main');
  await work(ctx, 'dirty');
  assert.equal(git('rev-parse', 'worker/main'), before);
  assert.ok(ctx.screen.workerInfo.lines.some((l) => /1 commit behind the room: its worktree has uncommitted changes, so it is left as it is/.test(l)));

  git('-C', path, 'add', 'wip.txt'); git('-C', path, 'commit', '-q', '-m', 'worker work');
  const own = git('rev-parse', 'worker/main');
  await work(ctx, 'own commits');
  assert.equal(git('rev-parse', 'worker/main'), own); // never reset, merged or rebased
  assert.ok(ctx.screen.workerInfo.lines.includes('worker/main has 1 commit not in the room: review and merge them when ready.'));
  assert.ok(ctx.screen.workerInfo.lines.some((l) => /behind the room and has commits of its own: it is left as it is/.test(l)));
});

test('/code worker: refused unless this code is the room\'s; waits for the worker; a failed install switches nothing; then restarts from the worktree', async () => {
  const { mkdirSync, writeFileSync, existsSync, realpathSync } = await import('node:fs');
  const { ctx } = await workerRoom();
  const git = await gitRoom(ctx.cwd);
  mkdirSync(`${ctx.cwd}/src`);
  writeFileSync(`${ctx.cwd}/src/cli.mjs`, '');
  writeFileSync(`${ctx.cwd}/package.json`, '{ not json');
  writeFileSync(`${ctx.cwd}/package-lock.json`, '{ "name": "x", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "x" } } }\n');
  git('add', '.'); git('commit', '-q', '-m', 'code');
  const said = [];
  ctx.say = (line) => said.push(line);
  ctx.server = { address: () => ({ port: 5599 }) };
  await work(ctx, 'start');
  const path = `${realpathSync(ctx.cwd)}.worker`;

  ctx.code = { path: '/somewhere/else', branch: 'main', cli: 'src/cli.mjs' };
  await handleLine('/code worker', ctx);
  assert.match(ctx.notes.at(-1), /can't switch to the worker's version now/);

  ctx.code = { path: realpathSync(ctx.cwd), branch: 'main', cli: 'src/cli.mjs' };
  await handleLine('/code worker', ctx);
  assert.match(ctx.notes.at(-1), /Not switching: installing the worker's dependencies failed/);
  assert.deepEqual(said, []);
  assert.equal(ctx.restartFrom, undefined);

  writeFileSync(`${path}/package.json`, '{ "name": "x", "private": true }\n'); // fixed in the worktree
  let finish;
  ctx.screen.working = 'W';
  ctx.workQueue = new Promise((done) => { finish = done; }).then(() => { ctx.screen.working = null; });
  const switching = handleLine('/code worker', ctx);
  await until(() => ctx.notes.at(-1)?.startsWith('Waiting for the worker'));
  assert.deepEqual(said, []);
  finish();
  await switching;
  assert.deepEqual(said, ['/restart']);
  assert.equal(ctx.restartFrom, `${path}/src/cli.mjs`);
  assert.equal(restartArgs(ctx, {})[0], `${path}/src/cli.mjs`);
  assert.match(ctx.notes.at(-1), new RegExp(`fresh sessions from the handoff.*run: cd ${realpathSync(ctx.cwd)} && npm start -- --port 5599$`));
  assert.ok(existsSync(`${path}/node_modules/.agent-room-install`));
  ctx.notes.length = 0;
  await handleLine('/code worker', ctx); // installed already: no second install
  assert.ok(!ctx.notes.some((n) => n.startsWith('Installing')));

  ctx.code = { path, branch: 'worker/main', cli: 'src/cli.mjs' }; // now running the worker's version
  await handleLine('/code room', ctx);
  assert.equal(ctx.restartFrom, `${realpathSync(ctx.cwd)}/src/cli.mjs`);
});

test('a worker task keeps the discussion it started in, even if New discussion comes while it prepares its worktree', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { queueWork } = await import('../src/ui.mjs');
  const { ctx, got } = await workerRoom();
  await gitRoom(ctx.cwd);
  let finish;
  ctx.worker.turn = (p) => { got.push(p); return new Promise((done) => { finish = done; }); };
  await handleLine('/autosummary off', ctx);
  await handleLine('hello', ctx);
  const first = ctx.discussion, transcript = ctx.logPath;
  queueWork(ctx, 'the task');
  await until(() => ctx.screen.working); // started: now preparing its worktree (Git calls)
  await handleLine('/new', ctx); // the room's discussion changes before the task's first turn
  assert.equal(ctx.discussion, null);
  await until(() => finish);
  assert.match(got[0], new RegExp(`^The active discussion's folder is ${first.dir}: `)); // its own, not "no discussion"
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
