# agent-room

A group brainstorm between you and several CLI agents, on your own subscriptions.

```
You ──▶ Claude ──▶ Codex ──▶ Claude ──▶ … ──▶ back to you once everyone passes in a row
```

Each round, you speak, then the agents take turns in a fixed order until every one of them has
replied `PASS` in a row (passes are hidden on screen, kept in the transcript). A round is capped at
8 agent turns, and a failed turn ends it. Start a message with `@name` to address one agent only.
Each agent sees everything said since its last turn. The room is for brainstorming: its only
output is documents in `proposal/`.

```sh
npm start                                     # claude + codex, in the current directory
node src/cli.mjs --agents claude:Ada,codex:Linus --cwd ~/Software/some-project
npm test
```

## How it works

- `src/agents.mjs` runs each CLI headlessly, once per turn, and resumes its own session
  (`claude -p --resume <id>`, `codex exec resume <thread>`), so agents remember the conversation.
- `src/room.mjs` is the round loop: pass counting, the turn cap, `@name`, and sending each agent
  only the messages it has not seen yet.
- `src/cli.mjs` is the terminal front end. Every room is saved to `transcripts/` as markdown.

## Current limits (deliberate)

- **Writes only in `proposal/`.** Enforced for claude: `Read/Grep/Glob/Edit/Write`, no Bash, and
  `--allowedTools 'Write(proposal/**)' 'Edit(proposal/**)'`, so other writes are refused. **Not
  enforced for codex**: `sandbox_mode="workspace-write"` lets it write anywhere under the cwd, and
  only its instructions keep it in `proposal/`.
- **No streaming.** A reply appears when the agent finishes.
- **Two providers**: `claude` and `codex`. A failed agent is reported and skipped; the round goes on.
