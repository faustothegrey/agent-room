# agent-room

A group conversation between you and several CLI agents, on your own subscriptions.

```
You ──▶ Claude replies ──▶ Codex replies ──▶ back to you
```

Each round, you speak, then every agent replies **exactly once**, in order. Each agent sees
everything said since its last turn, including the replies just before it in the same round.
Agents never trigger each other, so a room cannot run away.

```sh
npm start                                     # claude + codex, in the current directory
node src/cli.mjs --agents claude:Ada,codex:Linus --cwd ~/Software/some-project
npm test
```

## How it works

- `src/agents.mjs` runs each CLI headlessly, once per turn, and resumes its own session
  (`claude -p --resume <id>`, `codex exec resume <thread>`), so agents remember the conversation.
- `src/room.mjs` is the round loop: it sends each agent only the messages it has not seen yet.
- `src/cli.mjs` is the terminal front end. Every room is saved to `transcripts/` as markdown.

## Current limits (deliberate)

- **Talk-only.** Agents can read files but not change them: claude gets only `Read/Grep/Glob`,
  codex is forced to `sandbox_mode="read-only"` on every call.
- **No streaming.** A reply appears when the agent finishes.
- **Two providers**: `claude` and `codex`. A failed agent is reported and skipped; the round goes on.
