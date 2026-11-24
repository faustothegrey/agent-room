// The round loop: the user speaks, then the selected agents take turns in order until every one
// of them has passed in a row (or the lap cap is hit, or a turn fails). And /summary: the agents
// agree a short summary by points, in a few turns each.
// Each agent is sent only what it has not yet seen; its own CLI session holds the rest.
// The transcript and `seen` live in `state`, owned by the caller, so they survive a code reload;
// so does state.briefing, read when an agent gets its first prompt.

import * as defaultInstructions from './instructions.mjs';

export const MAX_LAPS = 10;
export const BRAINSTORM_MAX_LAPS = 20;
export const SUMMARY_TURNS_EACH = 3;

export function isPass(text) {
  return /^PASS\.?$/.test(text.trim());
}

export function formatMessages(messages) {
  return messages.map((m) => `[${m.outcome ? `Summary, ${m.outcome}` : m.speaker}]: ${m.pass ? '(passed)' : m.text}`).join('\n\n');
}

// Runs one turn of `agent`, applies `check(reply, attempt)` (returning a list of problems, empty
// when fine), and on problems asks the same session once to reply again.
export async function formattedTurn(agent, prompt, { check, retryPrompt, onTurn, onProblems } = {}) {
  const first = await agent.turn(prompt);
  await onTurn?.(first, 1);
  const problems = (await check?.(first, 1)) ?? [];
  if (!problems.length) return { text: first, problems: [], retried: false };
  await onProblems?.(problems, first);
  const again = typeof retryPrompt === 'function' ? await retryPrompt(problems, first) : retryPrompt;
  agent.lastUsage = null;
  const second = await agent.turn(again);
  await onTurn?.(second, 2);
  return { text: second, problems: (await check?.(second, 2)) ?? [], firstProblems: problems, retried: true };
}

export function checkClosingStatement(text) {
  const statement = String(text ?? '').trim();
  if (!statement || isPass(statement)) return ['the reply was empty or PASS'];
  if (!statement.includes('pending-instructions.md')) return ['it must point to pending-instructions.md'];
  return [];
}

// The closing statement of a discussion: one turn of `agent`, a one-off session with the worker's
// provider and model (see closeNamedDiscussion in ui.mjs), which reads the discussion's folder. The
// caller installs it only when this succeeds, so a failed attempt can't replace the previous one.
export async function closingStatement(agent, { dir, workerReports = '', onFormatNote } = {}, instr = defaultInstructions) {
  const task = instr.closingTask({ dir, workerReports });
  const res = await formattedTurn(agent, task, {
    check: checkClosingStatement,
    onProblems: (problems) => onFormatNote?.(`Format check: ${agent.name}'s closing statement ${problems.join('; ')}. Asked once to fix it.`, true),
    retryPrompt: (problems) => `Your closing statement has a format problem: ${problems.join('; ')}.\nReply again with the complete closing statement only, pointing to pending-instructions.md; do not write or rename any files.`,
  });
  if (res.retried) {
    if (!res.problems.length) onFormatNote?.('Format check: fixed on retry.', false);
    else onFormatNote?.(`Format check: still wrong: ${res.problems.join('; ')}.`, true);
  }
  if (res.problems.length) {
    throw new Error(`${agent.name} did not provide a complete closing statement: ${res.problems.join('; ')}.`);
  }
  return String(res.text ?? '').trim();
}

export function createRoom(agents, state = { transcript: [], seen: new Map() }, instr = defaultInstructions, usageLine = null) {
  const { intro, summaryFormat, draftTask, reviewTask } = instr;
  const names = new Set();
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`Duplicate agent name "${a.name}"`);
    names.add(a.name);
  }
  // Every entry: { speaker, text, error?, pass?, usage?, summary? }. Errors are shown to the user,
  // never sent to agents; usage is the agent's lastUsage for that turn, when its CLI reported one;
  // summary marks a turn of /summary (kept, but not shown). A summary's result is an entry
  // { speaker: 'Summary', text, outcome: 'agreed' | 'not agreed', by }.
  const { transcript, seen } = state;
  const superseded = new WeakSet();
  for (const a of agents) if (!seen.has(a.name)) seen.set(a.name, 0);

  const activeAgents = () => agents.filter((a) => !(state.disabledAgents ?? []).includes(a.name));

  function unseenFor(agent) {
    return transcript
      .slice(seen.get(agent.name))
      .filter((m) => !m.error && !superseded.has(m) && m.speaker !== agent.name);
  }

  // `task`: extra instructions for this turn only (used by /summary).
  function promptFor(agent, task) {
    const parts = [];
    const usage = usageLine?.(agent);
    if (usage) parts.push(usage);
    // state.briefing (set by ui.mjs once the discussion folder exists): where to write, and so on.
    if (seen.get(agent.name) === 0) parts.push(intro(agent, activeAgents(), !!state.research), ...(state.briefing ? [state.briefing] : []));
    // After a Resume or Restart (ui.mjs): one sentence, in each agent's next prompt only.
    if (state.restored?.pending?.includes(agent.name)) parts.push(state.restored.text);
    parts.push('New messages since your last turn:', formatMessages(unseenFor(agent)));
    if (task) parts.push(task);
    parts.push(`Your reply as ${agent.name}:`);
    return parts.join('\n\n');
  }

  // One agent turn: prompt, reply (or error), recorded in the transcript.
  async function takeTurn(agent, task) {
    const prompt = promptFor(agent, task);
    let entry;
    try {
      const text = await agent.turn(prompt);
      entry = isPass(text) ? { speaker: agent.name, text: 'PASS', pass: true } : { speaker: agent.name, text };
      if (agent.lastUsage) entry.usage = agent.lastUsage;
      // Advance only on success: a failed agent gets these messages again next time.
      seen.set(agent.name, transcript.length + 1);
      if (state.restored?.pending) state.restored.pending = state.restored.pending.filter((n) => n !== agent.name);
    } catch (err) {
      entry = { speaker: agent.name, text: err.message, error: true };
    }
    transcript.push(entry);
    return entry;
  }

  // "@name ..." at the very start addresses one agent; anything else goes to all of them.
  function selectFor(userText) {
    const match = /^@(\w[\w-]*)/.exec(userText);
    if (!match) return activeAgents();
    const agent = activeAgents().find((a) => a.name.toLowerCase() === match[1].toLowerCase());
    if (!agent) throw new Error(`Unknown agent "@${match[1]}". Known: ${agents.map((a) => a.name).join(', ')}`);
    return [agent];
  }

  return {
    transcript,
    agents,
    promptFor,
    // Rejects on an unknown @name, before anything is recorded or sent. `speaker`: who the round's
    // first message is from (auto dev's "Worker report", or "Scheduler", sent to every agent), the User by default.
    // `beforeLap`: optional async hook called with the 0-based lap number before each lap after the first;
    // returning a truthy string stops the round early and passes it to onNotice.
    async round(userText, { onTurnStart, onMessage, onNotice, speaker = 'User', beforeLap, onLapStart } = {}) {
      const selected = speaker === 'User' ? selectFor(userText) : activeAgents();
      const user = { speaker, text: userText };
      transcript.push(user);
      onMessage?.(user);
      const maxTurns = (state.brainstorm || state.research ? BRAINSTORM_MAX_LAPS : MAX_LAPS) * selected.length;
      let passes = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        if (turn > 0 && turn % selected.length === 0 && beforeLap) {
          const stop = await beforeLap(Math.floor(turn / selected.length));
          if (stop) {
            onNotice?.(typeof stop === 'string' ? stop : '(stopped early)');
            return { stopped: true, reason: typeof stop === 'string' ? stop : 'stopped early' };
          }
        }
        if (turn % selected.length === 0) onLapStart?.(Math.floor(turn / selected.length));
        const agent = selected[turn % selected.length];
        onTurnStart?.(agent);
        const entry = await takeTurn(agent);
        onMessage?.(entry);
        if (entry.error) return;
        passes = entry.pass ? passes + 1 : 0;
        if (passes === selected.length) return;
      }
      onNotice?.('(lap cap reached)');
    },

    // /summary. The drafter rotates from one summary to the next. Writing or revising a version
    // counts as accepting it; the summary is agreed when every other agent then passes on it. After
    // SUMMARY_TURNS_EACH turns each without that, it fails and the last version stands, marked
    // "not agreed". Resolves to { status: 'agreed' | 'not agreed', result } (result is the recorded
    // Summary entry), { status: 'empty' } if the drafter had nothing to summarize, or
    // { status: 'failed' } if a turn failed.
    async summary({ onTurnStart, onMessage, onFormatNote, check, extra } = {}) {
      const active = activeAgents();
      const n = active.length;
      const first = (state.summaries ?? 0) % n;
      state.summaries = (state.summaries ?? 0) + 1;
      const order = [...active.slice(first), ...active.slice(0, first)];
      const maxTurns = SUMMARY_TURNS_EACH * n;
      let version = null;
      let author = null;
      let passes = 0;
      const finish = (outcome) => {
        const result = { speaker: 'Summary', text: version, outcome, by: author.name };
        transcript.push(result);
        return { status: outcome, result };
      };
      for (let turn = 0; turn < maxTurns; turn++) {
        const agent = order[turn % n];
        onTurnStart?.(agent, { turn: turn + 1, of: maxTurns });
        const noWorker = !!state.brainstorm || !!state.research;
        const task = version === null ? draftTask(noWorker, extra) : reviewTask(author.name, noWorker, extra);
        const prompt = promptFor(agent, task);
        let firstEntry = null, secondEntry = null, turnResult;
        try {
          turnResult = await formattedTurn(agent, prompt, {
            onTurn: (text, attempt) => {
              const entry = isPass(text) ? { speaker: agent.name, text: 'PASS', pass: true, summary: true } : { speaker: agent.name, text, summary: true };
              if (agent.lastUsage) entry.usage = agent.lastUsage;
              seen.set(agent.name, transcript.length + 1);
              if (state.restored?.pending) state.restored.pending = state.restored.pending.filter((name) => name !== agent.name);
              transcript.push(entry);
              if (attempt === 1) firstEntry = entry; else secondEntry = entry;
              onMessage?.(entry);
            },
            check: async (text, attempt) => {
              if (attempt === 1 && isPass(text)) return [];
              if (attempt === 2 && isPass(text)) return ['replied PASS instead of the corrected summary'];
              return check ? (await check(text)) ?? [] : [];
            },
            onProblems: (problems) => {
              onFormatNote?.(`Format check: ${agent.name}'s summary ${problems.join('; ')}. Asked once to fix it.`, true);
              onTurnStart?.(agent, { turn: turn + 1, of: maxTurns });
            },
            retryPrompt: (problems) => {
              const usage = usageLine?.(agent);
              const body = `Your summary has a format problem: ${problems.join('; ')}.\nReply again with the complete corrected summary only (not PASS, and not a list of changes).`;
              return usage ? `${usage}\n\n${body}` : body;
            },
          });
        } catch (err) {
          const entry = { speaker: agent.name, text: err.message, error: true, summary: true };
          transcript.push(entry);
          onMessage?.(entry);
          return { status: 'failed' };
        }
        if (firstEntry.pass) {
          if (version === null) return { status: 'empty' };
          if (++passes === n - 1) return finish('agreed');
        } else {
          if (turnResult.retried) {
            if (!turnResult.problems.length) onFormatNote?.('Format check: fixed on retry.', false);
            else onFormatNote?.(`Format check: still wrong: ${turnResult.problems.join('; ')}.`, true);
            if (secondEntry.pass) {
              superseded.add(secondEntry);
              version = firstEntry.text;
            } else {
              superseded.add(firstEntry);
              version = secondEntry.text;
            }
          } else {
            version = firstEntry.text;
          }
          author = agent;
          passes = 0;
          if (n === 1) return finish('agreed');
        }
      }
      return finish('not agreed');
    },
  };
}
