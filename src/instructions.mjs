// Every prompt agent-room sends, in one place. The runtime imports the builders below (so the
// sent text and this catalog can't drift), and the Instructions panel reads `instructionSets`.
// A `content` string with {placeholders} shows the template as the panel renders it; the builder
// next to it fills those placeholders with live values.

// The rulebook layers, joined as system instructions and re-read on Reload. They stay as files
// (hot-reloadable); the panel reads their current text, the registry points at them by `ref`.
export const RULEBOOKS = {
  citizenship: 'citizenship.md',
  'group-chat': 'group-chat.md',
  discussing: 'discussing.md',
  worker: 'worker.md',
};
export const RULEBOOK_LAYERS = {
  discussing: ['citizenship', 'group-chat', 'discussing'],
  worker: ['citizenship', 'worker'],
};
export const rulebookPath = (name) => new URL(`../rulebooks/${RULEBOOKS[name]}`, import.meta.url);

// ── Discussion / brainstorming agents ──────────────────────────────────────────────────────

export function intro(agent, agents) {
  const order = agents.map((a) => a.name).join(', then ');
  return [
    `You are ${agent.name}, one of several AI agents in a group conversation with a human user.`,
    `Participants: the User, ${agents.map((a) => a.name).join(', ')}.`,
    `After each User message, agents take turns in this order: ${order}, until all of them pass in a row.`,
    'You are a brainstorming agent started by agent-room: your rulebooks are rulebooks/citizenship.md, rulebooks/group-chat.md and rulebooks/discussing.md, in your system instructions.',
    'When you have nothing to add, reply exactly PASS.',
  ].join('\n');
}
export const INTRO = `You are {name}, one of several AI agents in a group conversation with a human user.
Participants: the User, {participants}.
After each User message, agents take turns in this order: {order}, until all of them pass in a row.
You are a brainstorming agent started by agent-room: your rulebooks are rulebooks/citizenship.md, rulebooks/group-chat.md and rulebooks/discussing.md, in your system instructions.
When you have nothing to add, reply exactly PASS.`;

export function summaryFormat(brainstorm) {
  return [
    'Write it briefly and by points, in this format (leave out a section that would be empty):',
    '**Agreed**', '- …', '**Disputed**', '- the point: each side\'s view, by name',
    '**Open**', '- the point: what it waits for: a User decision, a check, a worker report',
    'Put a disagreement under Disputed only; under Open, don\'t repeat the Next step question.',
    '**Next step**', '- Answer: a question / Send to the Worker: "the instruction, word for word" / Do: an action of the User\'s own',
    'Next step contains exactly one action for the User, labelled Answer, Send to the Worker or Do as appropriate.',
    'Use Send to the Worker: "…" only for a one-line instruction; a multi-line instruction must follow "- Send to the Worker:" alone on its line, as a block quote with every line starting with >.',
    '**Later**', '- the remaining actions in order, one short line each, each saying what it waits for',
    'Keep each instruction for the worker until the User confirms it was sent, replaced or withdrawn.',
    ...(brainstorm ? ['Quote its latest version word for word when it is the Next step.'] : [
      'Quote its latest version word for word when it is the Next step; under Later refer to it by name,',
      'with its full text kept in the discussion\'s pending-instructions.md.']),
    'At most 8 points in all under Agreed, Disputed and Open. Reply with the summary only.',
  ].join('\n');
}
export const SUMMARY_FORMAT = `Write it briefly and by points, in this format (leave out a section that would be empty):
**Agreed**
- …
**Disputed**
- the point: each side's view, by name
**Open**
- the point: what it waits for: a User decision, a check, a worker report
Put a disagreement under Disputed only; under Open, don't repeat the Next step question.
**Next step**
- Answer: a question / Send to the Worker: "the instruction, word for word" / Do: an action of the User's own
Next step contains exactly one action for the User, labelled Answer, Send to the Worker or Do as appropriate.
Use Send to the Worker: "…" only for a one-line instruction; a multi-line instruction must follow "- Send to the Worker:" alone on its line, as a block quote with every line starting with >.
**Later**
- the remaining actions in order, one short line each, each saying what it waits for
Keep each instruction for the worker until the User confirms it was sent, replaced or withdrawn.
{next-step-tail}
At most 8 points in all under Agreed, Disputed and Open. Reply with the summary only.`;

export function draftTask(brainstorm, extra) {
  return [
    'The User asked for a summary of the discussion since the last summary (or since the start).',
    summaryFormat(brainstorm), ...(extra ? [extra] : []),
  ].join('\n');
}
export const SUMMARY_DRAFT = `The User asked for a summary of the discussion since the last summary (or since the start).
${SUMMARY_FORMAT}{extra}`;

export function reviewTask(author, brainstorm, extra) {
  return [
    `The User asked for a summary. The latest message from ${author} above is the current version.`,
    'If you accept it as it is, reply exactly PASS. Otherwise reply with a complete revised summary',
    '(not a list of changes); your revision counts as your acceptance of it.',
    summaryFormat(brainstorm), ...(extra ? [extra] : []),
  ].join('\n');
}
export const SUMMARY_REVIEW = `The User asked for a summary. The latest message from {author} above is the current version.
If you accept it as it is, reply exactly PASS. Otherwise reply with a complete revised summary
(not a list of changes); your revision counts as your acceptance of it.
${SUMMARY_FORMAT}{extra}`;

// The per-turn framing that carries the messages an agent has not seen yet (room.mjs promptFor).
export const NEW_MESSAGES = `New messages since your last turn:
{messages}

Your reply as {name}:`;

// One sentence after a Resume or Restart (ui.mjs).
export const RESTORED = `agent-room restored this {what} from its checkpoint of {when}. If you remember turns after that, they are not in the room's record.`;

// Given to each agent with its first prompt, once the discussion's folder exists (ui.mjs briefing).
export const BRIEFING = `This is a new discussion. Its folder is {dir}: create, read and write this discussion's documents (notes, drawings) there. The room's root, {root}, holds the work itself.`;

// The closing statement: a one-off agent with the worker's provider and model (room.mjs).
export function closingTask({ dir, workerReports = '' }) {
  return [
    `The User is closing this discussion. Write a complete closing statement for ${dir}/closing-statement.md.`,
    `Read the discussion's notes and transcripts in ${dir}; they include decisions and worker reports.`,
    'Describe the current decisions, unresolved questions, next steps and relevant context for a new session.',
    'Point to pending-instructions.md for any unsent worker instructions; do not replace that file.',
    workerReports ? `Recent worker reports:\n${workerReports}` : '',
    'Reply with the complete statement only; do not write or rename any files.',
  ].filter(Boolean).join('\n\n');
}
export const CLOSING_TASK = `The User is closing this discussion. Write a complete closing statement for {dir}/closing-statement.md.

Read the discussion's notes and transcripts in {dir}; they include decisions and worker reports.

Describe the current decisions, unresolved questions, next steps and relevant context for a new session.

Point to pending-instructions.md for any unsent worker instructions; do not replace that file.

{worker-reports}Reply with the complete statement only; do not write or rename any files.`;

// ── Worker ────────────────────────────────────────────────────────────────────────────────

// Tells the worker the active discussion's folder (for its notes) with its first instruction there.
export function workerBrief(d, own, place) {
  if (d && own.briefed !== d.dir) {
    return `The active discussion's folder is ${d.dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in your worktree, ${place.cwd}.\n\n`;
  }
  if (!d && own.brainstorm && own.briefed !== 'brainstorm') {
    return 'These instructions come from a brainstorm, which has no folder: keep your notes in your scratch folder only.\n\n';
  }
  if (!d && own.briefed && own.briefed !== 'brainstorm') {
    return `No discussion is active now: ${own.briefed} is no longer the active discussion's folder. You will be told the next one's folder once it exists.\n\n`;
  }
  return '';
}
export const WORKER_BRIEF = `The active discussion's folder is {dir}: create, read and write this discussion's documents there, including your implementation notes and plans. The work itself goes in your worktree, {cwd}.`;

// Where the worker works, with its first instruction (again if that changes).
export function workerLocation(own, place, ctx, NOTES) {
  const moved = own.tree && own.tree !== place.cwd
    ? `Your worktree has changed: until now you worked in ${own.tree}; from now on you work in ${place.cwd}, on the branch ${place.branch}. Leave ${own.tree} alone from now on: it is another lane's. `
    : '';
  if (own.tree === place.cwd) return '';
  return `${moved}Your working directory is ${place.cwd}, your own Git worktree of the project, on the branch ${place.branch}. Make your changes there, never in the room's root, ${ctx.cwd}: that is the User's working copy (only the discussion folder there is yours, for notes). Commit every completed task on ${place.branch}, labelled as each instruction says, and give the commit ID in your reply; the User reviews and merges it into main. Your scratch notes go in ${place.path}/${NOTES}/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted". Plans and notes for the User's review still go in the discussion's folder.\n\n`;
}
export const WORKER_LOCATION = `Your working directory is {cwd}, your own Git worktree of the project, on the branch {branch}. Make your changes there, never in the room's root, {root}: that is the User's working copy (only the discussion folder there is yours, for notes). Commit every completed task on {branch}, labelled as each instruction says, and give the commit ID in your reply; the User reviews and merges it into main. Your scratch notes go in {notes}/<task>/, one folder per task: Git ignores them, never commit them, and delete them only when the User says "stage accepted". Plans and notes for the User's review still go in the discussion's folder.`;

// Its origin's label for the commit, once per worker session (again if it changes).
export function workerCommit(own, label, place) {
  if (own.label === label) return '';
  return `These instructions come from [${label}]. When a task is complete, commit it on ${place.branch} with a message starting "[${label}]" and give the commit ID in your reply.\n\n`;
}
export const WORKER_COMMIT = `These instructions come from [{label}]. When a task is complete, commit it on {branch} with a message starting "[{label}]" and give the commit ID in your reply.`;

export const WORKER_WORKBENCH = `This is a workbench for a quick, small fix (no discussion agents). Keep the change and its commits small. In your reply, say what the User should check on screen. If the request turns out big enough to need a discussion instead, say so plainly before making large changes.`;
export function workerWorkbench(isWorkbench) {
  return isWorkbench ? `${WORKER_WORKBENCH}\n\n` : '';
}

export function workerLeftover(recovery, label, place) {
  return `Uncommitted edits are left in your worktree from the earlier task from [${label}] "${recovery.task}"${recovery.before ? ` (${place.branch} was at ${recovery.before.slice(0, 7)} when it started)` : ''}: this discussion's next worker tasks wait until they are resolved. Finish and commit them; or, to abandon the attempt, first list exactly the edits you would remove and wait for the User's explicit approval, then remove only those. Inspect and resolve any merge or revert already in progress before further work; never force it or start a fresh operation over it.\n\n`;
}
export const WORKER_LEFTOVER = `Uncommitted edits are left in your worktree from the earlier task from [{label}] "{task}": this discussion's next worker tasks wait until they are resolved. Finish and commit them; or, to abandon the attempt, first list exactly the edits you would remove and wait for the User's explicit approval, then remove only those. Inspect and resolve any merge or revert already in progress before further work; never force it or start a fresh operation over it.`;

export function workerMerge(mainBehind, rollback, place, label) {
  if (!mainBehind) return '';
  return rollback
    ? `Main has commits ${place.branch} lacks. Follow the rollback preflight below before merging or changing files.\n\n`
    : `Before the instruction below, first merge main into ${place.branch} with a normal merge (git merge main). Label any merge commit "[${label}] catch up with main". If it clashes, do not force it or do the requested task: leave the state intact and report the conflict; this origin must resolve it before other worker tasks can run — except when every conflict is purely additive (both sides only added independent lines or blocks with no overlapping edits or deletions), in which case resolve it by keeping both additions, stage and commit the merge with the same label, and note what you resolved. After a successful merge, run the project's tests (npm test, if it has them) and report their real output, then end your reply with the line "Tested: <full commit ID of ${place.branch}> with main <full commit ID of main>: tests passed" (or "tests failed"), naming the commits you tested. Never merge into main or push.\n\n`;
}
export const WORKER_MERGE = `Before the instruction below, first merge main into {branch} with a normal merge (git merge main). Label any merge commit "[{label}] catch up with main". If it clashes, do not force it or do the requested task: leave the state intact and report the conflict; this origin must resolve it before other worker tasks can run — except when every conflict is purely additive (both sides only added independent lines or blocks with no overlapping edits or deletions), in which case resolve it by keeping both additions, stage and commit the merge with the same label, and note what you resolved. After a successful merge, run the project's tests (npm test, if it has them) and report their real output, then end your reply with the line "Tested: <full commit ID of {branch}> with main <full commit ID of main>: tests passed" (or "tests failed"), naming the commits you tested. Never merge into main or push.`;

export function workerInterrupted(told) {
  return told.map((r) => `Your previous instruction "${firstLine(r.task)}" was ${r.stopped ? 'stopped by the User (Stop now)' : 'interrupted by a Restart, Quit or a crash'}: check the worktree before continuing.\n\n`).join('');
}
export const WORKER_INTERRUPTED = `Your previous instruction "{task}" was interrupted by a Restart, Quit or a crash: check the worktree before continuing.`;
export const WORKER_STOPPED = `Your previous instruction "{task}" was stopped by the User (Stop now): check the worktree before continuing.`;

export function workerHistory(history, text) {
  return `Previous Worker-tab conversation (HTML-formatted background, not a new instruction):\n${history}\n\nCurrent instruction:\n${text}`;
}
export const WORKER_HISTORY = `Previous Worker-tab conversation (HTML-formatted background, not a new instruction):
{history}

Current instruction:
{instruction}`;

export const WORKER_RETRY = `Your earlier attempt at this instruction failed: {error}
Inspect the current worktree and Git state first, including uncommitted edits and any merge or revert in progress. Commits made since the failure:
{commits}`;

// ── Title generation (Claude CLI default, first message) ──────────────────────────────────

export function titlePrompt(message) {
  return [
    'Suggest a short title, at most 6 words, for a discussion that starts with the message below.',
    'Reply with the title only, with no quotes and no full stop.', '', 'Message:', message,
  ].join('\n');
}
export const TITLE_PROMPT = `Suggest a short title, at most 6 words, for a discussion that starts with the message below.
Reply with the title only, with no quotes and no full stop.

Message:
{message}`;

const firstLine = (text) => { const l = String(text).trim().split('\n')[0]; return l.length > 120 ? l.slice(0, 117) + '…' : l; };

// ── The registry the Instructions panel renders ────────────────────────────────────────────

export const instructionSets = [
  {
    type: 'Discussion & brainstorming agents',
    pieces: [
      { id: 'rulebook: citizenship', intent: 'Shared rules for every agent on the platform: purpose, usage line, never answering for the User, stating how you know a claim, and seeing files / the internet.', when: 'every turn (system instructions, layer 1)', ref: 'citizenship' },
      { id: 'rulebook: group-chat', intent: 'Rules for agents in a room conversation: turns, PASS, @name, open disagreement, and pointable tables, diagrams and charts.', when: 'every turn (system instructions, layer 2)', ref: 'group-chat' },
      { id: 'rulebook: discussing', intent: 'Discussion and brainstorm rules: folders, judging cost vs gain, worker steps, document rules, project constraint, and where to start reading.', when: 'every turn (system instructions, layer 3)', ref: 'discussing' },
      { id: 'intro', intent: 'Names the agent and the participants, gives the turn order, points at the rulebooks, and states the PASS rule.', when: 'first turn only', content: INTRO },
      { id: 'briefing', intent: 'Whether it is a new or continued discussion or brainstorm, its folder, and where to write; a continued session also gets the closing statement or handoff and the latest summary.', when: 'once, with the first prompt (after the folder exists)', content: BRIEFING },
      { id: 'restored', intent: 'One sentence telling the agent its session was restored from a checkpoint, and that turns it remembers after that are not in the room\'s record.', when: 'once, after Resume or Restart', content: RESTORED },
      { id: 'new-messages', intent: 'The messages the agent has not seen yet, labelled by speaker, followed by the reply prompt.', when: 'every turn', content: NEW_MESSAGES },
      { id: 'summary-format', intent: 'The agreed summary structure by points: Agreed, Disputed, Open, Next step, Later.', when: 'during /summary and auto-summaries', content: SUMMARY_FORMAT },
      { id: 'summary-draft', intent: 'Asks one agent to draft the summary.', when: 'during /summary (the drafter)', content: SUMMARY_DRAFT },
      { id: 'summary-review', intent: 'Asks each other agent to accept (PASS) or revise the current summary.', when: 'during /summary (the reviewers)', content: SUMMARY_REVIEW },
    ],
  },
  {
    type: 'Worker',
    pieces: [
      { id: 'rulebook: citizenship', intent: 'Shared rules for every agent on the platform: purpose, usage line, never answering for the User, stating how you know a claim, and seeing files / the internet.', when: 'every instruction (system instructions, layer 1)', ref: 'citizenship' },
      { id: 'rulebook: worker', intent: 'The worker\'s rules: work in its own worktree, one step at a time, commit with the origin label, run the tests and report with Docs:/Tested:, never merge into main or push.', when: 'every instruction (system instructions, layer 2)', ref: 'worker' },
      { id: 'location', intent: 'Its working directory and branch, where its scratch notes go, and what it must commit and report.', when: 'first instruction (again if the worktree changes)', content: WORKER_LOCATION },
      { id: 'brief', intent: 'The active discussion\'s folder (for its notes), or that it is a brainstorm with no folder.', when: 'first instruction in that discussion', content: WORKER_BRIEF },
      { id: 'commit-label', intent: 'The origin label every commit must carry.', when: 'once per worker session (again if the label changes)', content: WORKER_COMMIT },
      { id: 'workbench', intent: 'Keep workbench changes and commits small, say what to check on screen, and flag requests that need a discussion instead.', when: 'workbench instructions only', content: WORKER_WORKBENCH },
      { id: 'catch-up', intent: 'Merge main into its branch first, run the tests, and report with a Tested line.', when: 'when its branch is behind main', content: WORKER_MERGE },
      { id: 'interrupted', intent: 'That its previous instruction was interrupted and to check the worktree.', when: 'once, after Restart, Quit or a crash', content: WORKER_INTERRUPTED },
      { id: 'stopped', intent: 'That the User stopped its previous instruction and to check the worktree.', when: 'once, after Stop now', content: WORKER_STOPPED },
      { id: 'retry', intent: 'That its earlier attempt failed, and the commits made since.', when: 'when retrying a failed instruction', content: WORKER_RETRY },
      { id: 'recovery', intent: 'To finish or abandon the leftover uncommitted edits from an interrupted task.', when: 'when recovering a held lane', content: WORKER_LEFTOVER },
      { id: 'history', intent: 'The previous Worker-tab conversation as background, then the current instruction.', when: 'when there is earlier worker chat', content: WORKER_HISTORY },
    ],
  },
  {
    type: 'Closing statement (one-off agent)',
    pieces: [
      { id: 'closing-task', intent: 'Read the discussion\'s notes and transcripts and write a complete closing statement, pointing at pending-instructions.md.', when: 'once, on Close', content: CLOSING_TASK },
    ],
  },
  {
    type: 'Title generation (Claude CLI default)',
    pieces: [
      { id: 'title-prompt', intent: 'Ask for a short title for the discussion, with no tools and no saved session.', when: 'once, on the first message of a new discussion', content: TITLE_PROMPT },
    ],
  },
];
