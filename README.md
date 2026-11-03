# agent-room

A human and several AI agents discuss and revise ideas around a shared document or drawing,
with the conversation and its subject visible together. Agents run through your installed
Claude Code and Codex CLIs, using their existing authentication and subscriptions.

The project stays deliberately small: six source modules and one dependency, `marked`.
Its longer-term purpose is to help build educational maths and science software through
conversation, with running costs under control.

## Start a room

Requires Node.js 20 or newer and installed, authenticated `claude` and `codex` commands.
The default discussion uses both providers; Claude also supplies new discussion titles.
Browser opening, the folder chooser and the Dock launcher use macOS commands.

```sh
npm install
npm start
```

The browser opens the discussion screen, normally at `http://127.0.0.1:5566/__room`.
If that port is occupied, the room uses a free one and prints its address. The starting
terminal shows a log; interact with the room in the browser. When output is piped, the
address is printed without opening a browser unless `--open` is supplied.

For terminal input instead, use `npm run terminal`. There is no worker input in terminal
mode; `/docs` opens a document separately in the browser.

## Use the screen

The header shows the full **root folder**, the selected discussion or **No discussion started**,
subscription usage, and **New room in folder…**. Agent settings live inside their tabs.

- **Discussion:** send messages to the brainstorming agents. Enter sends; Shift+Enter adds
  a line. Start with `@name` to address one agent. Agents take turns in the configured order,
  stopping when everyone passes consecutively, a turn fails, or eight agent turns are reached.
  Passes are hidden in the chat and retained in the transcript. Replies appear when complete.
- **Worker:** send implementation instructions to a separate agent. It receives only the
  instructions in this tab and remembers its earlier worker turns; it does not receive the
  Discussion chat. Supply the relevant file paths and decisions yourself. Once a discussion is
  active, its first instruction there also tells it the discussion's folder, where it writes its
  implementation notes and plans; the work itself goes in the root. Instructions run
  one at a time alongside the discussion, with a 30-minute timeout per instruction.
- **Discussions** (right pane): browse discussions, then choose a Markdown document, SVG drawing, transcript
  or other supported file for the right pane. Inside a discussion, each subfolder (`drawings/`,
  `transcripts/`, …) opens to its files. The chosen document stays selected when agents edit
  other files. Open documents check for changes every two seconds. Drag the divider to resize
  the panes. Browsing is available during agent turns and does not notify the agents.
- **Transcripts** are in each discussion's `transcripts/` folder, under **Discussions**. On an
  earlier session's transcript, **Send to agents** asks the discussion agents to read it as
  background; it does not resume its sessions.
- **Reload:** load code and rulebook edits between discussion commands without losing the
  current conversation. Refresh the browser afterward for HTML/CSS/JavaScript changes.
- **Restart:** click twice to replace the server process on the same address, for changes Reload
  can't load (such as `cli.mjs`). The new process re-opens the discussion in use, a fresh session
  from its handoff; the chat clears, its transcript is kept, and open pages reload by themselves.
- **Quit:** click twice to end the room. Discussion commands, including Quit, Restart and Reload,
  wait behind an ongoing round and its automatic summary; they are not immediate cancellation.
- **Server status:** under the root folder, the header shows whether the server is up, for how
  long and on which port (hover for its process). Its dot pulses green on each answer and turns
  red when the server stops. The page asks every three seconds; it says when
  the server stops answering, and reloads when a server answers again on that address.

In this project (the agent-room room itself), its design history is five discussions, each with
its documents and its transcripts: `2026-11-02-discussions-and-folders/` is active, three are in
`archive/` and one in `deferred/`; [`discussions/README.md`](discussions/README.md) is their index.
Files directly in `discussions/` that aren't dated folders (here, just that index) are listed
under "This room's own documents", with no Re-open button.

## Discussions and saved files

The root is the folder the agents work in (`--cwd`, or the directory you launched from).
Opening a room creates no discussion records there.

Your first discussion message asks Claude for a short title, using no tools or saved session.
Only after the title attempt does agent-room create the discussion folder and transcript,
then send the message to the discussion agents with their writing path. Title generation has
30 seconds; an error or timeout uses a date-and-time folder name. Occupied names get `-2`,
`-3`, and so on. If folder or transcript creation fails, the message is shown for you to resend
and is not delivered to the agents.

```text
<root>/
  discussions/
    2026-11-02-a-topic/
      notes.md                 # written by agents when needed
      drawings/                # optional
      handoff.md               # optional, prepared for the next session
      transcripts/
        session-2026-11-02-1014.md
    archive/                   # finished discussions, moved here whole
      2026-10-21-another-topic/
    deferred/                  # postponed discussions, moved here whole
```

**Archive and deferred.** A discussion's page in **Discussions** has **Archive** and **Defer**
buttons (or `/move <folder-name> archive|deferred`), which move the whole discussion, documents and
transcripts, into `discussions/archive/` or `discussions/deferred/`; **Make active**
(`/move archive/<folder-name> active`) moves it back. `archive/` and `deferred/` are created when
first needed, and always listed at the bottom of **Discussions**, after the active discussions.
The discussion in use in this room can't be moved. New discussion names also skip names already
taken in `archive/` and `deferred/`.

To go back to an existing discussion, open it in **Discussions** and choose **Re-open this discussion**,
or use `/reopen <folder-name>`. It works at any time between rounds. An archived or deferred
discussion (`/reopen archive/<folder-name>`) is moved back to the active discussions first. No title is requested; the
next message creates a new session transcript in that discussion. If this room's session had
already started, it ends first: its transcript is kept and closed, the chat clears (the button
asks for a second click), and the discussion agents and the worker get fresh CLI sessions. The
agents are instructed to read the handoff; old conversations are not automatically replayed, and
discussions don't keep their own agent memory. Preparing and consuming handoffs is an agent convention described
in [the brainstorming rulebook](README-for-brainstorming-agents.md), not automatic app behavior.

Looking at another discussion does not switch the one in use (marked "in use" in the list); only Re-open does. Display-title
editing is not available yet; see [remaining decisions](discussions/2026-11-02-discussions-and-folders/discussions.md).

Worker turns and other log entries before the first discussion message remain in memory until
that message creates the transcript. A worker-only session therefore has no saved transcript
if the room ends before a discussion starts.

**New room in folder…** opens the Mac folder chooser and starts an independent room in a new
browser window on its own port. It uses saved agent defaults if present, otherwise the current
room's choices. The existing room stays running; quitting either room does not quit the other.
Cancelling the chooser leaves the existing room in place.

## Choose providers and models

Expand **Discussion agents · provider & model** in Discussion, or **Worker · provider & model**
in Worker. Each existing agent has a name, provider and model. Use `--agents` at launch to choose
the number and order of discussion agents; the screen edits the existing slots.

Changes save automatically to `~/.config/agent-room/defaults.json`, shared across project
folders and subsequent launches, including the Dock launcher. Dropdown selections save on change;
text edits save when committed, such as by leaving the field. A custom model choice waits for
its model ID. Invalid choices show a save error and do not replace the saved defaults.

Before work starts, changes also apply to the current room. After you submit a discussion
message, request a summary, or send worker instructions, changes are saved for **future rooms**;
active agents keep their settings. Settings shown then may describe future defaults rather
than the running sessions. Each tab saves its own choices without replacing the other tab's.

- **Provider:** Claude or Codex, for both discussion agents and the worker.
- **Model:** Claude offers Opus, Sonnet and Haiku aliases. Codex reads the visible entries in
  its local `models_cache.json` under `CODEX_HOME` or `~/.codex`. There is no live account-model
  lookup; if the catalog is unavailable, use CLI default or a custom model ID.
- **CLI default:** pass no model argument and let that CLI choose.
- **Custom…:** enter a model ID supported by your installed CLI and account.
- **Names:** use distinct names for the agents and worker, with letters, numbers, underscores
  or hyphens, so `@name` is unambiguous.

Explicit `--agents` and `--worker` override their respective saved defaults for that launch
without rewriting the defaults file. The title-generation call always uses Claude's CLI default,
independently of the selected discussion and worker models.

## Summaries and usage

**Summarize**, or `/summary`, asks the discussion agents to agree a summary under **Agreed**,
**Not agreed**, and **Questions for the User**. The drafter rotates between summaries. Writing
or revising counts as accepting that version; every other agent must pass on it for agreement.
Each agent gets at most three turns. Without agreement, the last revision is shown as
**not agreed**. Only the result appears in the chat; the exchange is retained in the transcript.

**Auto-summarize** is on by default for each room. After a round where an agent spoke and none
failed, it runs the same summary process, adding up to three turns per agent. It does not run
after a round of only passes. Toggle the checkbox or use `/autosummary on|off`; the bare command
toggles it. This setting survives Reload but is not stored as a default across launches.

**Usage**, or `/usage`, reports session token totals for discussion agents and the worker.
Claude's reported dollar value is an API-price equivalent, not your subscription bill.
Header gauges show **percent used**, for each provider's five-hour and weekly windows, plus
reset times, and when the meter last measured them (hover for when the room last asked). Yellow means under 30% remains; red means under 10% remains.

Quotas come from the optional local meter at `http://127.0.0.1:9899` (override with
`AGENT_ROOM_METER`). They refresh every minute and after turns. If the meter is unavailable,
the header and usage report say so; the room still works.

## Launch options and commands

Agent specifications use `provider[:name[:model]]`; discussion agents are comma-separated.
Without saved defaults or overrides, they are `claude,codex` and the worker is `claude:Worker`.

```sh
node src/cli.mjs --cwd ~/Software/some-project
node src/cli.mjs --agents claude:Ada:opus,codex:Linus --worker codex:Worker
node src/cli.mjs --port 6000
node src/cli.mjs --no-screen
node src/cli.mjs --open
node src/cli.mjs --help
```

`--port 0` requests any available port; the usual default is 5566.

| Command | Effect |
|---|---|
| `/docs` | Browse documents; in terminal mode, ↑/↓ selects, Enter opens, Esc leaves the picker. |
| `/reopen <folder-name>` | Re-open an existing discussion: a fresh session there, from its handoff. `archive/…` or `deferred/…` is made active first. |
| `/move <folder-name> active\|archive\|deferred` | Move a whole discussion (not the one in use) into `archive/` or `deferred/`, or back. |
| `/summary` | Request an agreed summary. |
| `/autosummary [on\|off]` | Toggle automatic summaries, or set them explicitly. |
| `/usage` | Show session tokens and subscription quotas. |
| `/reload` | Reload source modules and both agent rulebooks; retain conversation and provider sessions. |
| `/restart` | Screen only: a new server process on the same port, re-opening the discussion in use. |
| `/quit` | End this room. |

## macOS Dock launcher

Build or replace the launcher after quitting its existing instance:

```sh
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Agent Room.app" # osacompile ignores -s (stay open) when updating an app
osacompile -s -o "$HOME/Applications/Agent Room.app" scripts/dock-launcher.applescript
```

Then give it the room's icon, drawn in `scripts/icon.svg` (needs `rsvg-convert`:
`brew install librsvg`). Re-signing is required after changing the bundle:

```sh
app="$HOME/Applications/Agent Room.app"; icons="$(mktemp -d)/applet.iconset"; mkdir "$icons"
for s in 16 32 128 256 512; do
  rsvg-convert -w $s -h $s scripts/icon.svg -o "$icons/icon_${s}x${s}.png"
  rsvg-convert -w $((s*2)) -h $((s*2)) scripts/icon.svg -o "$icons/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$icons" -o "$app/Contents/Resources/applet.icns"
plutil -remove CFBundleIconName "$app/Contents/Info.plist"
codesign --force --sign - "$app"
```

Drag the app into the Dock. If an agent-room room already answers on port 5566 (wherever it was
started, and in whatever folder), the app opens that room's page. Otherwise it runs
`node src/cli.mjs --open` in the fixed project path `/Users/fausto/Software/agent-room`; edit the
script if the checkout moves. Only the app reuses a running room: `npm start` still moves to a free
port when 5566 is taken.

The app then follows the room's heartbeat every three seconds. The room keeps running when you
close its browser window: clicking the Dock icon again opens its page in a new tab. Restart keeps
the app running. When the room stops (Quit in the screen), the app quits too; quitting the app
from the Dock quits the room the same way.

The script checks for `node`, `claude` and `codex` through a login shell with Homebrew and
`~/.local/bin` paths. Its log is `~/Library/Logs/agent-room.log`, replaced on each launch.
If a room the app started fails to start or ends with an error, an alert shows the log's tail. Discussion transcripts remain in their
own folders.

## Access and limits

Agents have full filesystem access. Keeping brainstorming output inside the active discussion
is an instruction, not a sandbox. The worker may edit files and run commands where you ask.

Claude discussion agents get file tools, web search/fetch, sub-agents, skills, and the allowed
look-and-click Chrome tools, with no Bash. A Claude worker additionally gets pre-approved Bash.
Claude uses strict MCP configuration rather than your claude.ai connectors. Codex discussion
agents and workers run without a sandbox and with live web search configured.

The server listens only on `127.0.0.1`. Browser input endpoints require the room's own origin
when supplied and JSON requests. There is no remote-access interface, crash recovery,
streaming reply display, live app preview, or automatic discussion-to-worker handoff.

## Working on the project

Read [AGENT.md](AGENT.md) for contribution rules. The two agent rulebooks apply only to agents
started by the room in their respective roles; they are not instructions for someone editing
agent-room's source.

| Source | Responsibility |
|---|---|
| `src/cli.mjs` | Arguments, shared session context, input queue, Reload, Restart and Quit. |
| `src/agents.mjs` | CLI processes, session resumption, model arguments, title generation and usage parsing. |
| `src/room.mjs` | Discussion turns, unseen messages, passes and summary agreement. |
| `src/ui.mjs` | Room setup, persistent defaults, commands, discussions, worker queue, logging and launch integration. |
| `src/docs.mjs` | Local HTTP server handlers, document rendering, browser UI and live events. |
| `src/usage.mjs` | Token accounting and optional quota-meter data. |

Run `npm test`. Tests exercise provider arguments with fake runners, round logic, HTTP endpoints,
settings persistence across CLI restarts, and screen/terminal coordination; they do not establish
live provider access or browser appearance.

Edits outside `cli.mjs` can be loaded with Reload; both rulebooks are reread too. A failed load
leaves the previous code running. `cli.mjs` changes require a process restart. Browser assets
are embedded in `docs.mjs`, so reload the room and refresh the page to see their changes.

For unfinished decisions, historical designs and deferred research, start at
[the discussions index](discussions/README.md). Archived status labels describe their original date,
not today's implementation or a fresh instruction to work.
