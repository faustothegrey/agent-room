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
npm install                                   # once: installs marked
npm start                                     # claude + codex, in the current directory
node src/cli.mjs --agents claude:Ada,codex:Linus --cwd ~/Software/some-project
npm test
```

## How it works

- `src/agents.mjs` runs each CLI headlessly, once per turn, and resumes its own session
  (`claude -p --resume <id>`, `codex exec resume <thread>`), so agents remember the conversation.
- `README-for-brainstorming-agents.md` is the agents' rulebook. The room sends it to every agent it
  starts as system instructions (claude `--append-system-prompt`, codex `developer_instructions`),
  so a `claude` or `codex` you start yourself is not a brainstorming agent.
- `src/room.mjs` is the round loop: pass counting, the turn cap, `@name`, and sending each agent
  only the messages it has not seen yet.
- `src/cli.mjs` is a small shell that never reloads: arguments, the input loop, `/reload`, `/quit`.
- `src/ui.mjs` is everything else on screen: building the room, the display, the commands, and the
  transcript (every room is saved to `transcripts/` as markdown). `/docs` lists the room's
  `proposal/` files: move with ↑/↓, Enter opens one in the browser.
- `src/docs.mjs` is that viewer: a local-only web server (127.0.0.1, started on the first `/docs`)
  that renders Markdown with [marked](https://marked.js.org), the project's one dependency.
  Images show inline, plain links to images get a preview, and an open page reloads when an
  agent edits the file.
- **Hot reload:** edit any file in `src/` except `cli.mjs`, or the rulebook, while a room is
  running, then type `/reload`. The new code takes over from the next round and the conversation
  carries on. If the new code fails to load, the room keeps running the old code; if it fails
  while running a command, the error is shown and the room carries on. Only `cli.mjs` itself
  needs a restart.

## Current limits (deliberate)

- **Writes only in `proposal/`.** Enforced for claude: `Read/Grep/Glob/Edit/Write`, no Bash, and
  `--allowedTools 'Write(proposal/**)' 'Edit(proposal/**)'`, so other writes are refused. **Not
  enforced for codex**: `sandbox_mode="workspace-write"` lets it write anywhere under the cwd, and
  only its instructions keep it in `proposal/`.
- **No streaming.** A reply appears when the agent finishes.
- **Two providers**: `claude` and `codex`. A failed turn is reported and ends the round.
