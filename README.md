# agent-room

Agent-room helps a human and multiple AI agents discuss and revise ideas around a shared
document or drawing, keeping the conversation and its subject visible together. It runs the
agents' own CLIs, on your own subscriptions. Longer term, it serves building educational
software for maths and science by vibecoding, with costs under control.

**First implementation cycle** (decided by the owner, 2026-10-20; **first version built**): the
discussion screen, a browser page with the chat between you and the agents on the left and, when
you want one, a Markdown document or SVG drawing from `proposal/` on the right, watched live.
`npm start` opens it and you use the room from there: you type in its message box, the agents
discuss freely, and at any time Documents (or `/docs`) lets you pick a file. The terminal you
started it from only shows a log. `npm run terminal` keeps the room in the terminal instead. See
`proposal/discussion-ide.md`.

## Today

```
You ──▶ Claude ──▶ Codex ──▶ Claude ──▶ … ──▶ back to you once everyone passes in a row
```

Each round, you speak, then the agents take turns in a fixed order until every one of them has
replied `PASS` in a row (passes are hidden on screen, kept in the transcript). A round is capped at
8 agent turns, and a failed turn ends it. Start a message with `@name` to address one agent only.
Each agent sees everything said since its last turn. The room is for brainstorming: its output
is documents in `proposal/`, and agents write elsewhere only when you ask them to.

```sh
npm install                                   # once: installs marked
npm start                                     # claude + codex, in the current directory; used from the browser
npm run terminal                              # the same, used from the terminal: /docs opens files alone
node src/cli.mjs --agents claude:Ada,codex:Linus --cwd ~/Software/some-project
node src/cli.mjs --log-dir ~/room-logs        # transcripts elsewhere (default: ./transcripts)
npm test
```

## How it works

- `src/agents.mjs` runs each CLI headlessly, once per turn, and resumes its own session
  (`claude -p --resume <id>`, `codex exec resume <thread>`), so agents remember the conversation.
- `README-for-brainstorming-agents.md` is the agents' rulebook. The room sends it to every agent it
  starts as system instructions (claude `--append-system-prompt`, codex `developer_instructions`),
  so a `claude` or `codex` you start yourself is not a brainstorming agent.
- `src/room.mjs` is the round loop: pass counting, the turn cap, `@name`, and sending each agent
  only the messages it has not seen yet. It also runs `/summary` (Summarize on the screen): the
  agents agree a short summary by points (Agreed / Not agreed / Questions for you), at most three
  turns each. One drafts (taking turns from one summary to the next); writing or revising a
  version counts as accepting it, and the summary is agreed when every other agent passes on it.
  Otherwise the last revision is shown, marked "not agreed". Only the result is shown; every
  turn is in the transcript.
- `src/cli.mjs` is a small shell that never reloads: arguments, the input loop, `/reload`, `/quit`.
- `src/ui.mjs` is everything else: building the room, the display, the commands, and the
  transcript (every room is saved to `transcripts/` as markdown). In the terminal, `/docs` lists
  the room's `proposal/` files: move with ↑/↓, and Enter opens one alone in the browser.
- `src/docs.mjs` is the viewer and the discussion screen: a local-only web server (127.0.0.1)
  that renders Markdown with [marked](https://marked.js.org), the project's one dependency.
  Images show inline, plain links to images get a preview, and an open document is checked every
  2 seconds and reloaded when an agent edits it. The screen (`/__room`) does everything the
  terminal does: the chat with who is thinking and each round's end line (passes hidden), a
  message box (with `@name`, `/docs`, `/usage`, `/reload`, `/quit`), Usage, Reload and Quit
  buttons, and Documents to pick the file on the right at any time, even mid-round. A screen
  opened later catches up on the whole chat. Only the room's own page can send it input.
- `src/usage.mjs` is usage stats. Each reply shows its tokens (and, for claude, the API-price
  cost) as reported by the CLI itself; the round's end line adds the round's totals and your
  subscription quotas, and `/usage` shows the session totals per agent. Quotas come from the
  local quota meter (`~/Software/scripts-ai/quota-monitoring`, `http://127.0.0.1:9899`, or
  `AGENT_ROOM_METER`); if it isn't running, quotas are left out.
- **Hot reload:** edit any file in `src/` except `cli.mjs`, or the rulebook, while a room is
  running, then type `/reload`. The new code takes over from the next round and the conversation
  carries on. If the new code fails to load, the room keeps running the old code; if it fails
  while running a command, the error is shown and the room carries on. Only `cli.mjs` itself
  needs a restart.

## Current limits (deliberate)

- **Full filesystem access; no shell for claude.** Both agents can read and write anywhere on
  disk, and only their instructions keep them to `proposal/` unless you ask otherwise. Claude:
  the file tools (`Read`/`Grep`/`Glob`/`Edit`/`Write` pre-approved for any path), web search
  and fetch, sub-agents, skills, and the look-and-click part of Claude in Chrome (to see
  rendered pages); no Bash; your claude.ai connectors (Gmail, Calendar, Drive) left out. Codex: `sandbox_mode="danger-full-access"`
  (no sandbox: any file, any command, network) and live web search.
- **No streaming.** A reply appears when the agent finishes.
- **Two providers**: `claude` and `codex`. A failed turn is reported and ends the round.
