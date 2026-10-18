// The round loop: the user speaks, then each agent replies exactly once, in order.
// Each agent is sent only what it has not yet seen; its own CLI session holds the rest.

export function introduction(agent, agents) {
  const order = agents.map((a) => a.name).join(', then ');
  return [
    `You are ${agent.name}, one of several AI agents in a group conversation with a human user.`,
    `Participants: the User, ${agents.map((a) => a.name).join(', ')}.`,
    `Each round the User speaks, then each agent replies once, in this order: ${order}.`,
    'Reply only as yourself, in plain text, in under 200 words. Never write lines for other participants.',
    'You may read files to answer, but do not modify anything.',
  ].join('\n');
}

export function formatMessages(messages) {
  return messages.map((m) => `[${m.speaker}]: ${m.text}`).join('\n\n');
}

export function createRoom(agents) {
  const names = new Set();
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`Duplicate agent name "${a.name}"`);
    names.add(a.name);
  }
  // Every entry: { speaker, text, error? }. Errors are shown to the user, never sent to agents.
  const transcript = [];
  const seen = new Map(agents.map((a) => [a.name, 0]));

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

  return {
    transcript,
    agents,
    promptFor,
    async round(userText, { onTurnStart, onMessage } = {}) {
      const user = { speaker: 'User', text: userText };
      transcript.push(user);
      onMessage?.(user);
      for (const agent of agents) {
        onTurnStart?.(agent);
        const prompt = promptFor(agent);
        let entry;
        try {
          entry = { speaker: agent.name, text: await agent.turn(prompt) };
          // Advance only on success: a failed agent gets these messages again next round.
          seen.set(agent.name, transcript.length + 1);
        } catch (err) {
          entry = { speaker: agent.name, text: err.message, error: true };
        }
        transcript.push(entry);
        onMessage?.(entry);
      }
    },
  };
}
