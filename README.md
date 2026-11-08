# agent-room

A human and several AI agents discuss and revise ideas around a shared document or drawing,
with the conversation and its subject visible together. Agents run through your installed
Claude Code and Codex CLIs, using their existing authentication and subscriptions.

The project stays deliberately small: seven source modules and one dependency, `marked`.
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

`npm start` runs in dev mode (see [Working on the project](#working-on-the-project)); the Dock
app runs it too. Without dev mode, use `node src/cli.mjs`.

The browser opens the discussion screen, normally at `http://127.0.0.1:5566/__room`.
If that port is occupied, the server uses a free one and prints its address.
One server process runs several rooms, one per folder (identified by its real path, so a symbolic
link can't open a second room there). Each room has its own address, `/r/<room>/__room`, and its
own agents, worker, discussion, transcript, pause, pages and input queue: a round in one room never
waits for another. `/__room` opens the server's first room. Every request names its room, and the
server serves each room's files only from inside its folder (no `../`, and no symbolic link leading
out of it). In the log, each room's lines start with `[<folder name>]`. The starting
terminal shows a log; interact with the room in the browser. When output is piped, the
address is printed without opening a browser unless `--open` is supplied.

For terminal input instead, use `npm run terminal`. There is no worker input in terminal
mode; `/docs` opens a document separately in the browser.

## Use the screen

The header has three zones. **Room** (blue): **agent-room ▾**, whose menu holds **Switch room…**,
**Open room in folder…**, **Peers…** and **Quit room**, above the full **root folder**; hover or focus the room
name for its replication line, when replication is on. **Current discussion** (green): the selected
discussion or **No discussion started**, with its state under it (paused, who is thinking, or your
turn); **Actions ▾** holds **Pause discussion**, **Summarize** and **New discussion**, with
**Auto-summarize** beside it. **Server and monitoring** (amber): **● Server ▾**, whose menu holds
**Reload**, **Restart** and **Shutdown server**, then the subscription usage gauges and **Usage**;
hover or focus **Server** for its uptime, port and the server's version.
An amber ⚠ under **Server** means a replication peer is unreachable (hover for how many); click it to open **Peers…**.
The version is the commit
of agent-room's checkout when the server started and its start time, such as `4cb41bd · started
12:28`, with `+` when the checkout had uncommitted changes (outside `discussions/`). After a
Reload it adds `· reloaded 12:41 (commit)`, again with `+` if needed. Both are snapshots taken
then, never read live; hover for the full dates and the checkout's folder. Agent settings live inside their tabs.

- **Discussion:** send messages to the brainstorming agents. Enter sends; Shift+Enter adds
  a line. Start with `@name` to address one agent. Agents take turns in the configured order,
  stopping when everyone passes consecutively, a turn fails, or eight agent turns are reached.
  Passes are hidden in the chat and retained in the transcript. Replies appear when complete.
- **Worker:** send implementation instructions to a separate agent. It receives only the
  instructions in this tab and remembers its earlier worker turns; it does not receive the
  Discussion chat. Supply the relevant file paths and decisions yourself. Once a discussion is
  active, its first instruction there also tells it the discussion's folder, where it writes its
  implementation notes and plans; the work itself goes in its own worktree (see
  [The worker's worktree](#the-workers-worktree)). Instructions run
  one at a time alongside the discussion, with a 30-minute timeout per instruction.
- **Explorer** and **Document** (right pane, two tabs): in **Explorer**, browse discussions (the one
  in use first), then choose a Markdown document, SVG drawing, transcript or other supported file:
  it opens in **Document**, which shows its path and the file. Each tab keeps its place when you
  switch; Document is disabled until a file is chosen. Inside a discussion, each subfolder (`drawings/`,
  `transcripts/`, …) opens to its files. The chosen document stays selected when agents edit
  other files. Open documents check for changes every two seconds. Drag the divider to resize
  the panes. Browsing is available during agent turns and does not notify the agents.
- **Transcripts** are in each discussion's `transcripts/` folder, under **Explorer**. On an
  earlier session's transcript, **Send to agents** asks the discussion agents to read it as
  background; it does not resume its sessions.
- **Reload:** load code and rulebook edits between discussion commands without losing the
  current conversation. Open pages refresh by themselves when the page's own code changed,
  keeping what you were typing.
- **Restart:** click twice to replace the server process on the same address, for changes Reload
  can't load (such as `cli.mjs`). It acts on the whole server: the new process brings back every
  room, each with its current agents and worker, and re-opens each one's discussion in use, a fresh
  session from its handoff; the chats clear, transcripts are kept, and open pages reload by
  themselves. Reload also applies to every room, each between its own rounds.
- **Quit room:** click twice to end this room only. It waits for the round in progress (and lines
  queued before it) for at most 30 seconds; then the room's agents are stopped mid-turn, so the
  round ends as failed. Its running agent and worker programs are stopped before its state goes; a
  worker stopped in the middle of an instruction, agents stopped mid-turn, or queued instructions
  not started are reported on the screen and in the log. The server's other rooms keep running;
  when the last room quits, the server ends.
  Provider programs run in separate process groups; cleanup stops their child commands too
  (SIGTERM, then SIGKILL after 5 seconds). Commands that deliberately detach into a new session
  escape this group; stopping those would require OS supervision.

- **Shutdown server:** click twice to end every room, then the server. The button, the Dock app's
  Quit and `curl` all use the server's address `POST /__shutdown` (from a room page's own host and
  origin); typing `/shutdown` in a room does the same. If any room has a discussion round or worker instruction running, Shutdown and Restart first list those rooms and require confirmation. Running workers may be stopped at once, leaving partial changes. The page asks before retrying; unconfirmed requests to the endpoint return HTTP 409 with the warning (confirmation uses `?confirmed=yes`). The Dock launcher shows the same warning in a native Cancel / Shutdown dialog; Cancel leaves both the launcher and server running. Otherwise Shutdown and Restart start at once; each
  room then ends as with Quit room, within the same 30 seconds. Reload waits behind an ongoing
  round and its automatic summary.
- **Server status:** **● Server** in the header shows whether the server is up; hover or focus it
  for how long and on which port (and its process, in the tooltip). Its dot pulses green on each
  answer and turns red when the server stops. The page asks every three seconds; it says when
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

**Archive and deferred.** A discussion's page in **Explorer** has **Archive** and **Defer**
buttons (or `/move <folder-name> archive|deferred`), which move the whole discussion, documents and
transcripts, into `discussions/archive/` or `discussions/deferred/`; **Make active**
(`/move archive/<folder-name> active`) moves it back. `archive/` and `deferred/` are created when
first needed, and always listed at the bottom of **Explorer**, after the active discussions.
The discussion in use in this room can't be moved. New discussion names also skip names already
taken in `archive/` and `deferred/`.

**New discussion** (in the header's **Actions ▾** menu, or `/new`) works between rounds. It ends this
room's session the way Re-open does (below), except for the worker: its running task, log and CLI
session carry on, and its log gets a marker line. Nothing is created yet: your next message gets
a title and creates the new discussion's folder, as in a fresh room. The worker's next instruction
then gets the new folder; until it exists, the worker is told no discussion is active.

**Pause discussion** (in the header's **Actions ▾** menu, or `/pause`) waits for the
current round, including its automatic summary, and queued worker tasks to finish. It saves the
chat, worker log, provider session IDs, unread-message positions, provider/model choices and usage
totals on this machine. Messages, summaries, worker instructions and agent-setting changes are
blocked while paused. You can then quit, restart the server or start another discussion.

Choose **Resume** under **Paused on this machine** in **Explorer**, or `/resume <folder-name>`,
to continue those same discussion and worker sessions with the saved chat. In the room you just
paused, the header's **Actions ▾** menu offers **Resume discussion** (`/resume` with no name). Pause any current
conversation before resuming another one. Starting a New discussion from a paused one starts a
fresh worker too, keeping the saved worker session untouched. **Re-open** still starts fresh;
re-opening a paused discussion asks for confirmation and discards its saved Pause.

Checkpoints are private local files under `~/.local/state/agent-room/paused/`, separated by root
folder. They are not replicated to peers. Resume needs the providers' original local session
storage; if a provider cannot resume its session, its turn fails without a silent fresh start.
This is native session continuation, subject to provider context compaction and changes to files,
models or rulebooks. It is not recovery of a turn interrupted by a crash. Once resumed, Pause again
before quitting to save the latest state. Paused discussions must be resumed before moving them
to archive or deferred.

To go back to an existing discussion, choose **Re-open** on its row in **Explorer** (or on its
page), or use `/reopen <folder-name>`. It works at any time between rounds. An archived or deferred
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

**Switch room…** lists this server's rooms, showing their root folders, active discussions and
how many room pages are open on each. Each room appears twice:
under **Switch this tab to**, which opens it in the current tab (the room you leave keeps running
with its conversation intact), and under **Open in new window**, which opens it in a new browser
window and leaves this one on its own room, so several rooms can be worked on side by side.
The current room is disabled and marked "(current)"; any other room with a page already open is
disabled and marked "(open in another window)", so the chooser doesn't open a room twice. Pages
on any device count (provisional). Opening a room's URL by hand, or two windows choosing the same
room at once, is still possible, and nothing checks when a page connects. The list refreshes each
time you click the button. Rooms of other agent-room processes (another port, another machine) are
not listed.

**Open room in folder…** opens the Mac folder chooser. If the folder already has a room on this
server, that room opens in a new browser window, unless a page already shows it: then a dialog
says it is already open in another window, and no window opens. If it has none, a dialog asks
**Create a room in …?**: **Create room** adds the room to this server and opens it in a new window,
**Cancel** creates nothing. The new room uses saved agent defaults if present, otherwise the current
room's choices. Create room can only create the room for the folder the server's own chooser just
returned (a one-time token), so a page can't name a folder. Two rooms in the same Git repository would
share one worker worktree: the room opened later there gets no worker, and its Worker tab says why.
Cancelling the chooser leaves everything as it was.

## Choose providers and models

Expand **Discussion agents · provider & model** in Discussion, or **Worker · provider & model**
in Worker. Each existing agent has a name, provider and model. Use `--agents` at launch to choose
the number and order of discussion agents; the screen edits the existing slots.

Changes save automatically to `~/.config/agent-room/defaults.json`, shared across project
folders and subsequent launches, including the Dock launcher. Dropdown selections save on change;
text edits save when committed, such as by leaving the field. A custom model choice waits for
its model ID. Invalid choices show a save error and do not replace the saved defaults.

Worker provider and model changes apply to the next instruction, including after a failed turn.
A running instruction finishes with its original settings; resend a failed instruction yourself.
Changing models keeps the provider session. Changing provider or worker name starts a fresh
session supplied with the previous Worker-tab conversation and its worktree/discussion context.

Before work starts, discussion changes also apply to the current room. After you submit a discussion
message, request a summary, or send worker instructions, changes are saved for **future rooms**;
discussion agents keep their settings. Settings shown then may describe future defaults rather
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
**Not agreed**, and **Questions for the User**, in at most eight points. When the discussion has
proposed instructions for the worker, a last section, **Instructions for the Worker**, quotes the
latest version of each word for word, marked "sending unconfirmed"; later summaries repeat it
until you say it was sent, replaced or withdrawn. The drafter rotates between summaries. Writing
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
| `/new` | End this session; your next message starts a new discussion. The worker carries on. |
| `/move <folder-name> active\|archive\|deferred` | Move a whole discussion (not the one in use) into `archive/` or `deferred/`, or back. |
| `/pause` | Save the discussion and worker sessions locally after their work finishes. |
| `/resume [folder-name]` | Continue a saved Pause, including its provider sessions and chat. |
| `/summary` | Request an agreed summary. |
| `/autosummary [on\|off]` | Toggle automatic summaries, or set them explicitly. |
| `/usage` | Show session tokens and subscription quotas. |
| `/reload` | Reload source modules and both agent rulebooks; retain conversation and provider sessions. |
| `/restart` | Screen only: a new server process on the same port, with every room, each re-opening its discussion in use. |
| `/quit` | Quit room: end this room only, stopping its running agent and worker programs. |
| `/shutdown` | Screen only: Shutdown server, ending every room (the same as `POST /__shutdown`). |

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

Drag the app into the Dock. The app serves nothing itself: the server is one agent-room process
(`node src/cli.mjs`), which is the web server and every room's conversation and agents' sessions.
If such a process already answers on port 5566 (wherever it was started, and in whatever folder),
the app opens its first room's page. Otherwise it runs
`npm start -- --open --node Mac --peer charon=http://192.168.178.70:5566` in the fixed project
path `/Users/fausto/Software/agent-room`, enabling replication with charon and reusing the saved
pairing. Edit the script and rebuild the app if the checkout or peer address changes.
Only the app reuses a running process: `npm start` in a terminal still moves to a free port when
5566 is taken.

The app then follows the process's heartbeat every three seconds. The process keeps running when
you close the browser window: clicking the Dock icon again opens its page in a new tab. Restart
keeps the app running. When the process stops (Shutdown server, or quitting its last room), the
app quits too; quitting the app from the Dock shuts the server down the same way (`POST /__shutdown`).

The script checks for `node`, `claude` and `codex` through a login shell with Homebrew and
`~/.local/bin` paths. Its log is `~/Library/Logs/agent-room.log`, replaced on each launch.
If a process the app started fails to start or ends with an error, an alert shows the log's tail. Discussion transcripts remain in their
own folders.

## Replicate discussions between nodes

Replication covers only the server's launch room (its `--cwd`, agent-room itself from the Dock
app): a `--peer` address names a whole server, not one of its rooms, so rooms added with New room
in folder… have no peer, and their Peers panel says so. Their folders get no `.agent-room/`.

Start each server with a stable node name and the other server's address, for example:

```sh
node src/cli.mjs --node Mac --peer Pi=http://192.168.1.21:5566
node src/cli.mjs --node Pi --peer Mac=http://192.168.1.20:5566
```

In **Peers…** (in the room's **agent-room ▾** menu), choose **Pair with …**, check both root folders, and confirm. A different
established room ID is refused. Node names are kept in storage and cannot be changed there.
With `--peer`, an occupied port stops startup; without peers the usual free-port fallback applies.
Without `--node` or `--peer`, no replication module or storage is loaded.

Each round (after its automatic summary), and each manual summary, saves a commit to separate
Git storage in `<root>/.agent-room/`. Source files and the project's Git index are not replicated.
Transcripts are included even if the project's ignore rules exclude them. Failed rounds are
labelled as failed. A saving error leaves discussion files in place. Sending runs in the
background; unreachable peers retry with a delay capped at five minutes, including after restart.

Received lines appear in **Explorer**, under their discussions. **View** opens their conversation and files read-only,
without starting or stopping agents. **Back to <node>'s line** returns to the local conversation when that discussion has a local line.
The header keeps Usage, and Restart and Quit room in its menus; node lines are grouped under each
discussion, and Peers… is in the room's **agent-room ▾** menu.
New received rounds do not change an open View. Each browser pins its selected snapshot;
Back releases it, and closing/reloading the page releases it after two minutes without renewal.
Keep the page connected while reading: a suspended or disconnected page must select View again
when its lease expires. The latest snapshot and all open, leased Views are kept; older snapshot
folders are deleted while their commits remain in Git. No Continue here, reconciliation or Fork
is available in this slice. Replication has been tested locally; LAN and Raspberry Pi validation
remain separate deployment checks.

## The worker's worktree

The worker never edits the room's own files. It works in its own Git worktree of the room's
repository, in the sibling folder `<repo>.worker/` (for agent-room:
`/Users/fausto/Software/agent-room.worker/`), on the branch `worker/main`. Its notes still go in
the room's discussion folder. The Worker tab shows the worktree, its branch and the commit it is
based on, and says when the room has uncommitted changes the worker can't see, or when
`worker/main` has commits that aren't in the room. You review and merge them yourself
(`git merge worker/main` in the room); nothing is merged automatically.

- The worktree is created at the worker's first instruction, from the room's `HEAD`, and reused
  after Reload or Restart. An existing `worker/main` is reattached. If something else is already at
  that folder, the worker refuses to run and changes nothing.
- Before each instruction, `worker/main` catches up with the room's `HEAD`, by fast-forward only,
  when it is strictly behind it and its worktree is clean. Otherwise it is left as it is, and the
  tab says why. agent-room never resets, merges, rebases or deletes the worktree or its branch, and
  never touches the room's own index, branch or files.
- Without a Git repository, or in one with no commit yet, the worker is disabled:
  "Worker requires a source Git repository for its isolated worktree." Discussions work as usual.
- The worker keeps scratch notes in `.worker-notes/<task>/` inside its worktree. Git ignores them
  (`.gitignore` here, and the repository's local `info/exclude` for any project); they are never
  committed, and the worker deletes them when you tell it "stage accepted".
- A worktree separates working copies; it is not a sandbox (see below).

## Access and limits

Agents have full filesystem access. Keeping brainstorming output inside the active discussion
is an instruction, not a sandbox. The worker may edit files and run commands where you ask.

Claude discussion agents get file tools, web search/fetch, sub-agents, skills, and the allowed
look-and-click Chrome tools, with no Bash. A Claude worker additionally gets pre-approved Bash.
Claude uses strict MCP configuration rather than your claude.ai connectors. Codex discussion
agents and workers run without a sandbox and with live web search configured.

The server listens on `0.0.0.0`: devices on the LAN can open its printed IP address and
send instructions to local agents. This version has no authentication; use it on a trusted LAN. Browser input endpoints require the room's own origin
when supplied and JSON requests. There is no remote stop, agent-session crash recovery,
streaming reply display, live app preview, or automatic discussion-to-worker handoff.

## Working on the project

Read [AGENT.md](AGENT.md) for contribution rules. The two agent rulebooks apply only to agents
started by the room in their respective roles; they are not instructions for someone editing
agent-room's source.

| Source | Responsibility |
|---|---|
| `src/cli.mjs` | Arguments, the server's rooms, each room's context and input queue, Reload, Restart, Quit room and Shutdown. |
| `src/agents.mjs` | CLI processes, session resumption, model arguments, title generation and usage parsing. |
| `src/room.mjs` | Discussion turns, unseen messages, passes and summary agreement. |
| `src/ui.mjs` | Room setup, persistent defaults, commands, discussions, worker queue, logging and launch integration. |
| `src/docs.mjs` | Local HTTP server handlers, document rendering, browser UI and live events. |
| `src/replicate.mjs` | Separate discussion Git storage, pairing, background transfer and immutable received snapshots. |
| `src/usage.mjs` | Token accounting and optional quota-meter data. |

Run `npm test`. Tests exercise provider arguments with fake runners, round logic, HTTP endpoints,
settings persistence across CLI restarts, and screen/terminal coordination; they do not establish
live provider access or browser appearance.

Edits outside `cli.mjs` can be loaded with Reload; both rulebooks are reread too. A failed load
leaves the previous code running. `cli.mjs` changes require Restart. Browser assets are embedded
in `docs.mjs`; after a Reload, open pages refresh by themselves when they changed.

**Dev mode** (`--dev`, part of `npm start` and so of the Dock app) reloads by itself whenever a
module in `src/` or a rulebook is saved, as if you had pressed Reload: the conversation continues,
and the page refreshes only when its own code changed. Saving `cli.mjs` shows a reminder to
Restart instead. Restart keeps dev mode. Saves by anyone count, including the worker's or another
agent's edits to agent-room itself; a half-finished save that doesn't load leaves the previous
code running.

For unfinished decisions, historical designs and deferred research, start at
[the discussions index](discussions/README.md). Archived status labels describe their original date,
not today's implementation or a fresh instruction to work.
