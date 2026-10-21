// The round loop: the user speaks, then the selected agents take turns in order until every one
// of them has passed in a row (or the turn cap is hit, or a turn fails). And /summary: the agents
// agree a short summary by points, in a few turns each.
// Each agent is sent only what it has not yet seen; its own CLI session holds the rest.
// The transcript and `seen` live in `state`, owned by the caller, so they survive a code reload.

export const MAX_TURNS = 8;
export const SUMMARY_TURNS_EACH = 3;

const SUMMARY_FORMAT = [
  'Write it briefly and by points, in this format (leave out a section that would be empty):',
  '**Agreed**', '- …', '**Not agreed**', '- the point: each side\'s view, by name', '**Questions for the User**', '- …',
  'At most 8 points in all. Reply with the summary only.',
].join('\n');
const draftTask = () => [
  'The User asked for a summary of the discussion since the last summary (or since the start).',
  SUMMARY_FORMAT,
].join('\n');
const reviewTask = (author) => [
  `The User asked for a summary. The latest message from ${author} above is the current version.`,
  'If you accept it as it is, reply exactly PASS. Otherwise reply with a complete revised summary',
  '(not a list of changes); your revision counts as your acceptance of it.',
  SUMMARY_FORMAT,
].join('\n');

export function introduction(agent, agents) {
  const order = agents.map((a) => a.name).join(', then ');
  return [
    `You are ${agent.name}, one of several AI agents in a group conversation with a human user.`,
    `Participants: the User, ${agents.map((a) => a.name).join(', ')}.`,
    `After each User message, agents take turns in this order: ${order}, until all of them pass in a row.`,
    'You are a brainstorming agent started by agent-room: your rulebook is README-for-brainstorming-agents.md, in your system instructions.',
    'When you have nothing to add, reply exactly PASS.',
  ].join('\n');
}

export function isPass(text) {
  return /^PASS\.?$/.test(text.trim());
}

export function formatMessages(messages) {
  return messages.map((m) => `[${m.outcome ? `Summary, ${m.outcome}` : m.speaker}]: ${m.pass ? '(passed)' : m.text}`).join('\n\n');
}

export function createRoom(agents, state = { transcript: [], seen: new Map() }) {
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
  for (const a of agents) if (!seen.has(a.name)) seen.set(a.name, 0);

  function unseenFor(agent) {
    return transcript
      .slice(seen.get(agent.name))
      .filter((m) => !m.error && m.speaker !== agent.name);
  }

  // `task`: extra instructions for this turn only (used by /summary).
  function promptFor(agent, task) {
    const parts = [];
    if (seen.get(agent.name) === 0) parts.push(introduction(agent, agents));
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
    } catch (err) {
      entry = { speaker: agent.name, text: err.message, error: true };
    }
    transcript.push(entry);
    return entry;
  }

  // "@name ..." at the very start addresses one agent; anything else goes to all of them.
  function selectFor(userText) {
    const match = /^@(\w[\w-]*)/.exec(userText);
    if (!match) return agents;
    const agent = agents.find((a) => a.name.toLowerCase() === match[1].toLowerCase());
    if (!agent) throw new Error(`Unknown agent "@${match[1]}". Known: ${agents.map((a) => a.name).join(', ')}`);
    return [agent];
  }

  return {
    transcript,
    agents,
    promptFor,
    // Rejects on an unknown @name, before anything is recorded or sent.
    async round(userText, { onTurnStart, onMessage, onNotice } = {}) {
      const selected = selectFor(userText);
      const user = { speaker: 'User', text: userText };
      transcript.push(user);
      onMessage?.(user);
      let passes = 0;
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const agent = selected[turn % selected.length];
        onTurnStart?.(agent);
        const entry = await takeTurn(agent);
        onMessage?.(entry);
        if (entry.error) return;
        passes = entry.pass ? passes + 1 : 0;
        if (passes === selected.length) return;
      }
      onNotice?.('(turn cap reached)');
    },

    // /summary. The drafter rotates from one summary to the next. Writing or revising a version
    // counts as accepting it; the summary is agreed when every other agent then passes on it. After
    // SUMMARY_TURNS_EACH turns each without that, it fails and the last version stands, marked
    // "not agreed". Resolves to { status: 'agreed' | 'not agreed', result } (result is the recorded
    // Summary entry), { status: 'empty' } if the drafter had nothing to summarize, or
    // { status: 'failed' } if a turn failed.
    async summary({ onTurnStart, onMessage } = {}) {
      const n = agents.length;
      const first = (state.summaries ?? 0) % n;
      state.summaries = (state.summaries ?? 0) + 1;
      const order = [...agents.slice(first), ...agents.slice(0, first)];
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
        const entry = await takeTurn(agent, version === null ? draftTask() : reviewTask(author.name));
        entry.summary = true;
        onMessage?.(entry);
        if (entry.error) return { status: 'failed' };
        if (entry.pass) {
          if (version === null) return { status: 'empty' };
          if (++passes === n - 1) return finish('agreed');
        } else {
          version = entry.text;
          author = agent;
          passes = 0;
          if (n === 1) return finish('agreed');
        }
      }
      return finish('not agreed');
    },
  };
}
