// The round loop: the user speaks, then the selected agents take turns in order until every one
// of them has passed in a row (or the turn cap is hit, or a turn fails).
// Each agent is sent only what it has not yet seen; its own CLI session holds the rest.
// The transcript and `seen` live in `state`, owned by the caller, so they survive a code reload.

export const MAX_TURNS = 8;

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
  return messages.map((m) => `[${m.speaker}]: ${m.pass ? '(passed)' : m.text}`).join('\n\n');
}

export function createRoom(agents, state = { transcript: [], seen: new Map() }) {
  const names = new Set();
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`Duplicate agent name "${a.name}"`);
    names.add(a.name);
  }
  // Every entry: { speaker, text, error?, pass?, usage? }. Errors are shown to the user, never sent
  // to agents; usage is the agent's lastUsage for that turn, when its CLI reported one.
  const { transcript, seen } = state;
  for (const a of agents) if (!seen.has(a.name)) seen.set(a.name, 0);

  function unseenFor(agent) {
    return transcript
      .slice(seen.get(agent.name))
      .filter((m) => !m.error && m.speaker !== agent.name);
  }

  function promptFor(agent) {
    const parts = [];
    if (seen.get(agent.name) === 0) parts.push(introduction(agent, agents));
    parts.push('New messages since your last turn:', formatMessages(unseenFor(agent)));
    parts.push(`Your reply as ${agent.name}:`);
    return parts.join('\n\n');
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
        const prompt = promptFor(agent);
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
        onMessage?.(entry);
        if (entry.error) return;
        passes = entry.pass ? passes + 1 : 0;
        if (passes === selected.length) return;
      }
      onNotice?.('(turn cap reached)');
    },
  };
}
