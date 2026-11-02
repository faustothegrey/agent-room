# agent-room

Agent-room helps a human and multiple AI agents discuss and revise ideas around a shared
document or drawing, keeping the conversation and its subject visible together. It runs the
agents' own CLIs, on your own subscriptions. Longer term, it serves building educational
software for maths and science by vibecoding, with costs under control.

**First implementation cycle** (decided by the owner, 2026-10-20; **first version built**): the
discussion screen, a browser page with the chat between you and the agents on the left and, when
you want one, a Markdown document or SVG drawing from the room's discussions on the right, watched live.
`npm start` opens it and you use the room from there: you type in its message box, the agents
discuss freely, and at any time Documents (or `/docs`) lets you pick a file. The terminal you
started it from only shows a log. `npm run terminal` keeps the room in the terminal instead. See
[the proposal index](proposal/README.md) for historical designs and deferred work.

## Today

```
You ──▶ Claude ──▶ Codex ──▶ Claude ──▶ … ──▶ back to you once everyone passes in a row
```

Each round, you speak, then the agents take turns in a fixed order until every one of them has
replied `PASS` in a row (passes are hidden on screen, kept in the transcript). A round is capped at
8 agent turns, and a failed turn ends it. Start a message with `@name` to address one agent only.
Each agent sees everything said since its last turn. The room is for brainstorming: its output
is notes and drawings in the active discussion's folder, and agents write elsewhere only when
you ask them to.

**Discussions** (remaining decisions: [proposal/discussions.md](proposal/discussions.md)). The folder a room
runs in (`--cwd`, default the current one) is its **root**, shown in full in the header. Opening a
room writes nothing there. Your first message starts a **new discussion**: Claude, with no tools,
suggests a short title, then agent-room creates `discussions/<date>-<title>/` (`-2`, `-3`… if
taken; date and time if the title fails within 30s) with the session's transcript in its
`transcripts/`, and only then do the agents get the message, told where to write. You wait for
the title before the first reply (one measured title took 4.5s). To **continue** a discussion
instead, open it in Documents before your first message and choose Continue (or
`/continue <name>`): no title, the new session's transcript goes in that discussion, and the
agents start fresh from its `handoff.md`. Documents lists the discussions (newest first) and,
in this repo, the older `proposal/` folder; looking at a discussion doesn't switch to it.
**New room in folder…** (in the header) opens the Mac's folder chooser and starts a separate
room in the chosen folder, with the same agents, on its own port, in a new browser window. Both
rooms keep running; quitting one doesn't end the other.

```sh
npm install                                   # once: installs marked
npm start                                     # claude + codex, in the current directory; used from the browser
npm run terminal                              # the same, used from the terminal: /docs opens files alone
node src/cli.mjs --agents claude:Ada,codex:Linus --cwd ~/Software/some-project
node src/cli.mjs --worker claude:Bob          # the worker's provider and name (default claude:Worker)
node src/cli.mjs --log-dir ~/room-logs        # where Transcripts lists older rooms from (default: ./transcripts)
node src/cli.mjs --port 6000                  # the screen's port (default 5566: http://127.0.0.1:5566/__room)
npm test
```

## Choose agents and models

Open **Discussion agents · provider & model** in the Discussion tab, or **Worker · provider & model**
in the Worker tab. Each tab saves its own choices automatically. Each agent has a provider dropdown
(Claude or Codex) and a model dropdown. Claude offers Opus, Sonnet and Haiku; Codex uses its
local model catalog when available. Both also offer **CLI default** and **Custom…** for a model ID.
Names can be edited so two agents using the same provider can still be addressed separately.

Changes automatically update `~/.config/agent-room/defaults.json`, shared across project folders and
used on subsequent launches (including the Dock launcher and New room in folder…). Before any
agent starts, changes also apply to the current room. Once a discussion or worker
has started, changes affect future rooms only; existing sessions keep their settings.

Explicit `--agents` or `--worker` arguments override that part of the saved defaults for that
launch. Their format is `provider[:name[:model]]`, for example
`--agents claude:Ada:opus,codex:Linus:gpt-6.1-sol --worker codex:Worker:gpt-6.1-terra`.
Model access depends on your provider account. Selecting CLI default leaves the model argument
unset, preserving the CLI's own choice. The separate Claude call that suggests discussion titles
still uses its CLI default.

## Start from the macOS Dock

`~/Applications/Agent Room.app` is the small AppleScript launcher. Drag it from Finder into
the Dock, then click it to start a room in `/Users/fausto/Software/agent-room` and open the
discussion screen, without a terminal. Quit on the screen ends the room and the launcher.
Opening the launcher again while it is running does not start a second room.

The launcher checks for `node`, `claude` and `codex` using a login shell plus the standard
Homebrew and `~/.local/bin` locations. Output goes to `~/Library/Logs/agent-room.log`
(replaced on each launch); conversation transcripts go in each discussion's `transcripts/`. If the room
cannot run, the launcher shows an alert with the end of the log.

To build or replace the launcher, after quitting it:

```sh
mkdir -p "$HOME/Applications"
osacompile -o "$HOME/Applications/Agent Room.app" scripts/dock-launcher.applescript
```

The project path is intentionally fixed in `scripts/dock-launcher.applescript`; update it if
the checkout moves. The launcher runs `node src/cli.mjs --open`, the same entry point as
`npm start`, with `--open` forcing the browser to open when there is no terminal.

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
  turn is in the transcript. **Auto-summarize** (on by default; the checkbox on the screen, or
  `/autosummary [on|off]`) runs it after every round in which an agent spoke and none failed,
  covering what was said since the last summary. It costs up to three more turns per agent.
- `src/cli.mjs` is a small shell that never reloads: arguments, the input loop, `/reload`, `/quit`.
- `src/ui.mjs` is everything else: building the room, the display, the commands, and the
  transcript (each session is saved as markdown in its discussion's `transcripts/`), the
  discussions and "New room in folder…". In the terminal, `/docs` lists the room's documents
  (discussions, and `proposal/` if any): move with ↑/↓, and Enter opens one alone in the browser.
- `src/docs.mjs` is the viewer and the discussion screen: a local-only web server (127.0.0.1,
  port 5566, or any free port if that one is taken)
  that renders Markdown with [marked](https://marked.js.org), the project's one dependency.
  Images show inline, plain links to images get a preview, and an open document is checked every
  2 seconds and reloaded when an agent edits it. The screen (`/__room`) does everything the
  terminal does: the chat with who is thinking and each round's end line (passes hidden), a
  message box (with `@name`, `/docs`, `/summary`, `/usage`, `/reload`, `/quit`), Summarize,
  Usage, Reload and Quit buttons, a divider to drag between chat and document, and Documents to
  pick the file on the right at any time, even mid-round. A screen
  opened later catches up on the whole chat. Only the room's own page can send it input.
  A header at the top shows the room's full root path, its active discussion, its agents and its worker, and the
  subscription quotas as gauges (5h and week, per provider, with when each resets; yellow under 30% left, red under 10%), refreshed every minute and after
  each turn. Transcripts, next to
  Documents, lists the rooms saved in `--log-dir` before discussions (newest first, with each
  room's first message) and shows one on the right, read-only; a discussion's own transcripts are
  under Documents, and the current one follows along as it grows. Send to agents, on
  a past transcript, sends a normal message asking the agents to read it in full (by its path),
  as background: the old sessions are not resumed.
- **The worker** (the screen's Worker tab, next to Discussion): one more agent, outside the round,
  that carries out the instructions you send from that tab. It sees only those (not the
  discussion), runs them one at a time alongside the discussion, and follows
  `README-for-worker-agents.md`. It is a claude session with the same tools plus `Bash`,
  pre-approved, so it can edit files and run commands anywhere, with 30 minutes per instruction.
  Its turns go in the transcript and count in `/usage`. From the terminal (`npm run terminal`)
  there is no worker input.
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
  disk, and only their instructions keep them to the discussion's folder unless you ask otherwise.
  This matters more in a room opened on another folder (Notes, Documents…). Claude:
  the file tools (`Read`/`Grep`/`Glob`/`Edit`/`Write` pre-approved for any path), web search
  and fetch, sub-agents, skills, and the look-and-click part of Claude in Chrome (to see
  rendered pages); no Bash; your claude.ai connectors (Gmail, Calendar, Drive) left out. Codex: `sandbox_mode="danger-full-access"`
  (no sandbox: any file, any command, network) and live web search.
- **No streaming.** A reply appears when the agent finishes.
- **Two providers**: `claude` and `codex`. A failed turn is reported and ends the round.
