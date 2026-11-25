# agent-room

agent-room is a collaboration platform for a human and several AI agents. You and the agents
discuss and revise ideas around shared documents and drawings, with the conversation and its
subject visible together, and a separate worker agent carries out your instructions in its own
Git worktree. It is domain-agnostic: a room is any folder, holding any kind of work. Agents run
through your installed Claude Code, Codex and Antigravity (`agy`) CLIs, using their existing authentication and
subscriptions.

How it works (the two harnesses,
the main loop, the core protocol, the summary contract, current restrictions) is described in
[docs/architecture.md](docs/architecture.md); this README covers how to use it.

## Start a room

Requires Node.js 20 or newer and the installed, authenticated CLI commands for the providers you use (`claude`, `codex` or `agy`).
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
own agents, worker, discussion, transcript, pages and input queue: a round in one room never
waits for another. `/__room` opens the server's first room. Every request names its room, and the
server serves each room's files only from inside its folder (no `../`, and no symbolic link leading
out of it). In the log, each room's lines start with `[<folder name>]`. The starting
terminal shows a log; interact with the room in the browser. When output is piped, the
address is printed without opening a browser unless `--open` is supplied.

For terminal input instead, use `npm run terminal`. There is no worker input in terminal
mode; `/docs` opens a document separately in the browser.

## Use the screen

The header has three zones. **Room** (blue): **`<folder name> ▾`** (the last part of the room's root
path), whose menu holds **Switch room…**, **Open room in folder…**, **Peers…** and **Quit room**;
hover or focus the room name for the full **root folder** and, when replication is on, its
replication line. Under the room name is **● Server ▾** (blue, or red when down), whose menu holds
**Reload**, **Restart** and **Shutdown server**; hover or focus **Server** for its uptime, port and
the server's version. An amber ⚠ to the right of **Server** means a replication peer is unreachable
(hover for how many); click it to open **Peers…**. **Activity** (green, always shown): system messages on the left (the latest two lines, with errors in red and the full text on hover, kept across discussion switches), and on the right every open discussion whose worker is working, one per line,
as `<title> · Worker is working` (the shown discussion included). A live discussion, summary or closing-statement agent failure stays pinned above the system messages until dismissed; newer failures replace it and count earlier undismissed failures. Reloading clears the pinned line. **Monitoring** (amber): the monitor panel, with the subscription usage gauges
and a warning per provider (below).

A thin **busy bar** on the header's bottom edge moves while an action you started on the screen is
still going on: a request of this page, or a command (Resume, Close, Summarize, Reload…) that has
been waiting or running for more than 0.3 seconds. It turns red for 1.5 seconds when the action
fails; the error is shown as before. It is not shown for agents thinking or the worker working.

The monitor panel watches agent-room's own Claude, Codex and Agy programs and Claude and Codex login, for the room
being viewed. A ⚠ right of a provider's name means a problem: **amber** when its login ends in 2
days or less, its login status is unknown (the status command failed or its output couldn't be
read; the error is shown), or one of its programs is left over; **red** when logged out or the login
has expired. No ⚠ when all is fine. Hover or focus the name for the problems, then the state: the
login (for Claude, "Claude reports login ends …", from `loginExpiresAt` in `claude auth status`; for
Codex "logged in, no expiry given", from `codex login status`) and how many of this room's
programs are running now. Login is checked once per server, at startup and every 10 minutes.

Click a provider name or its ⚠ to open **Providers** and expand its health section, which covers every room on
this server. The folded health section shows ⚠ when this room’s header reports a provider problem. It lists running and leftover programs, each room's quota meter status and its measured
and checked times, and login results with the next scheduled check. **Check now** checks all three
CLI paths and versions, logins, leftovers and quota meters together; CLI checks run only on request.
For CLI, login and leftover checks, the latest error and its time remain visible separately from the
last successful result. Agy login is not monitored. The 10-minute login schedule covers only providers used in an open room; other providers are checked
only with Check now. Leftover checks continue at their usual interval; opening Providers does not run
them. The health section also shows each provider's model list source, availability, count and latest
error. Claude's list is agent-room's fixed list, Codex's is `models_cache.json`, and Agy's comes from
`agy models`. Check now reloads all three lists, bypassing Agy's five-minute refresh limit. It compares
each open discussion member and worker, and the saved defaults, with those lists: CLI default, in
list, not in list, list not read yet or list unavailable. Claude's list is agent-room's own, so inclusion proves little
about availability. These checks do not change configured models. Per-room operation tables show
the live provider and model for discussion turns, summaries, worker tasks, closing statements,
discussion titles, login checks and the quota meter. Closing statements use a new worker-provider
session. The session tables list the provider session IDs known to agent-room and each member's and
worker's last turn, with its outcome and latest error. A session is memory between turns, not a
running program. Turn outcomes and latest errors are kept only in memory, not in a history or log. For each provider,
**Test prompt (uses quota)** sends a tiny prompt with the chosen configured model or CLI default in a
new session and temporary empty folder. It runs only on click, separately from Check now, and its
latest result per provider and model is kept in memory. The result proves only that the model answered
at that moment. Claude runs without tools or session persistence; Codex uses a read-only sandbox,
no web search and an ephemeral session; Agy uses its sandbox and does not bypass permissions.

A **leftover** is a program agent-room started that is still alive after a crash or a Restart.
Each program is written, when it starts, to `~/.local/state/agent-room/programs/<pid>.json` (PID,
start time, provider, agent name, room folder, and the PID and start time of the server that
started it), and removed when its process group ends. At startup
and every minute the server looks for entries whose program isn't one of its rooms' running
programs, whose process group is still alive, and whose server is gone (its PID isn't alive, or
is alive with another start time: reused), so another agent-room server's programs are left to it
(with, while the leader is alive, the recorded
start time; another start means the number was reused, and the entry is dropped). Its tooltip gives
the PID, agent, room folder, start time and the command to stop it, `kill -TERM -<pid>`; there is no
Stop button. A group still alive after its leader ended, or one whose server's start time can't be
read, is shown as **unverified** (a number may have been reused), with `ps -g <pid>` to look at it instead. A leftover shows in its own room's
panel, or in every room's panel when its room isn't open on this server; a provider with a leftover
shows even when no agent of the room uses it. Known limit: a crash between starting a program and
recording it leaves that program unseen.
The version is the commit
of agent-room's checkout when the server started and its start time, such as `4cb41bd · started
12:28`, with `+` when the checkout had uncommitted changes (outside `discussions/`). After a
Reload it adds `· reloaded 12:41 (commit)`, again with `+` if needed. Both are snapshots taken
then, never read live; hover for the full dates and the checkout's folder. Agent settings live inside their tabs.

The provider panels' headings name the models in use, such as **Discussion members · Claude
default, Codex default** and **Worker · Opus**: each enabled discussion agent's model and the
worker's, as their panels list them ("<provider> default" for CLI default).

- **Discussion header:** spans both the Discussion/Worker pane and the Side pane (side by side or stacked), above their tab bars. To the right of **Actions ▾**, it shows the selected board's title (**New brainstorm**, **New workbench**, **New research board**, or **No discussion started** before its first message), its tab status (who is thinking, your turn, closing phase, peeking/read-only, or worker working/idle), and, separately on both tabs, any active **auto dev** status (running cycle and phase, paused with reason, or finished). **Actions ▾** holds **Summarize**, **New workbench**, **New research**, **Turn into a discussion** (for a brainstorm or research board) and **Turn into research** (for a brainstorm), **Close** (**Close with pending work** when the worker branch has unmerged commits or uncommitted edits; **Close brainstorm** for a brainstorm), **Close and Merge** (or **Catch up with `<branch>`**, when the discussion's or workbench's branch has commits not in the room's current branch), and **Close and Discard** (when discarding would lose commits not in the room's current branch, tracked edits, or untracked files).
- **Discussion / Worker tab bar:** switches between **Discussion** and **Worker**, with **◫ Side pane** on the right when the side pane is closed. On a workbench, only the **Worker** chat is shown (no **Discussion** tab, discussion-members panel, **Summarize**, or Auto dev). On a research board, only the **Discussion** tab is shown (no **Worker** tab or Auto dev).
- **Discussion:** send messages to the brainstorming agents. Enter sends; Shift+Enter adds
  a line. Start with `@name` to address one agent. Agents take turns in the configured order,
  stopping when everyone passes consecutively, a turn fails, or the lap cap is reached (10 laps in a
  discussion, 20 in a brainstorm or research board; one lap is each selected agent speaking once).
  Passes are hidden in the chat and retained in the transcript. Replies appear when complete.
  **📎 Attach** (under the message box, in discussions and brainstorms; a new one
  allows it after its first message) adds files of any type to your next message; each waits
  there, removable with ✕. Sending saves them into the discussion's or brainstorm's `files/` folder (created if
  missing; a taken name becomes `name-2.ext`, `name-3.ext`, …, never overwritten) and appends
  their paths to the message, e.g. `Attached: files/sketch.png`, for the agents and the
  transcript. Each file can be at most 25 MB, and 250 MB together per message. If any file can't
  be saved, nothing is sent and nothing stays saved: the text and attachments stay in the box,
  with the error. Attaching alone never starts a turn; there is no drag-and-drop or paste.
- **Worker:** send implementation instructions to a separate agent. It receives only the
  instructions in this tab and remembers its earlier worker turns; it does not receive the
  Discussion chat. Supply the relevant file paths and decisions yourself. Once a discussion is
  active, its first instruction there also tells it the discussion's folder, where it writes its
  implementation notes and plans; the work itself goes in its own worktree (see
  [The worker's worktrees](#the-workers-worktrees)). A discussion's instructions run one at a time,
  in the order sent, alongside the discussion and alongside other discussions' (at most two
  worker tasks at once in a folder), with a 30-minute timeout per instruction.
  While the shown discussion's worker runs an instruction, the tab offers two stop buttons (hidden
  while the page peeks at another discussion or views a peer's, back at once on returning); each
  asks you to click it again to confirm, as Close discussion does. They act only on this
  discussion's worker: other discussions' workers and the room's agents keep running. Both cancel
  this discussion's queued instructions at once (none can start in between), listing each in the
  tab as not started, cancelled by the stop, with its full text to copy and send again, and pause
  auto dev if it is running.
  - **Stop after this task:** the running instruction finishes and is reported as usual.
  - **Stop now:** the running instruction's process group (only that task's programs) is killed
    at once. Its reply, in the Worker tab and in the chat, says what it left: uncommitted edits,
    commits whose reply was lost, or nothing in the worktree ("Stopped by the User: …"). Stopped
    while its worktree was being prepared, its worker never starts, and the result is reported
    as unknown. No Retry is offered; the discussion's next instruction tells the worker once that
    its previous one was stopped. Uncommitted edits hold the worktree for this discussion, as
    below.
- **Control bar & Services panel** (far-left vertical rail below the header, beside the **Services panel** and the board area — **Boards** list, **Discussion/Worker**, and **Side pane**): **Boards** plus five services — **Providers**, **Instructions** (the prompt catalog), **Schedule** (scheduled tasks), and on local pages (`127.0.0.1` or `localhost`) **My notes** and **Terminal**. Clicking a service opens it in the **Services panel** (one at a time, taking half the window right next to the Control bar), pushing the board area to the right half where it stays usable (with **Explorer**/**Document** left open as it is, and temporary narrower widths never overwriting saved divider or list sizes) and collapsing the **Boards** list to its thin strip. Clicking another service switches to it; clicking the open service's button again, **Boards**, or **`✕`** closes the panel and restores the **Boards** list's previous open or collapsed state. Closing or switching services only hides the panel without asking: unsaved **My notes** edits stay and a running **Terminal** shell keeps running (marked by a green dot on the **Terminal** Control bar button). Opening a service never interrupts running rounds or worker tasks, and clicking **Discussion** or **Worker** never closes the open service. Clicking a provider name or its `⚠` in the header's monitor panel also opens **Providers** here with its health section expanded.
- **Schedule** (Control bar → **Schedule**): configure one-shot and daily recurring research and a shared quota guard.
  - A **one-shot research** task has an optional title, a prompt, and a local date and time. A **daily research** task has an optional title, a prompt, a local time (`HH:MM`), and an on/off switch. If a title is omitted, the board is named from the prompt as for **+ New research**. Tasks and the quota floor are stored per room in `~/.local/state/agent-room/schedules/<sha256 of the room folder>.json`, outside the project's working tree and `git status`.
  - **Quota guard:** one **quota floor** in percent remaining (default `50%`) applies to all providers, across both their 5-hour and weekly windows. Before a run it checks the board's agents (the room's defaults for a new board); missing or stale readings or quota below the floor skip the run without creating a board. Before each later lap it checks again; a failed check stops the run and writes the reason in the board.
  - At its scheduled time, the task posts its prompt as **Scheduler** and lets the agents run until all pass. A one-shot task creates a new research board and runs again only if its date or time is edited. A daily task creates a board on its first run and reuses it thereafter: an open board keeps its live sessions, an unloaded open board resumes its saved sessions, and a closed board resumes with fresh sessions and its closing statement. A run is skipped if a round or summary is already running in that board. Research boards stay open after the run.
  - Runs happen only while agent-room is running at the scheduled time; missed runs are not caught up. A missed one-shot remains in the panel without a missed status until edited or deleted.
  - **Last run:** each task displays when it last ran and its outcome — `ran`, `skipped` (with reason), `stopped by the quota guard` (with reason), or `failed` (with error).
- **My notes** (Control bar → **My notes**, local pages only: `127.0.0.1` or `localhost`): your own free-text notes for this room's folder (separate from a discussion's `notes.md`). **New**, a list of notes (title and last-saved date), and an editor with **Save** and **Remove**; a note's first line is its title. A note is saved only by **Save**; **Remove** asks inside the panel first. Closing or switching services hides the panel without asking and keeps unsaved edits; unsaved changes are never dropped without asking: the panel opens and asks before switching notes, **New**, or switching board or room in this window; leaving or reloading the page gets the browser's leave-page warning, and the automatic refresh after a code change keeps them and reopens **My notes** in the Services panel. Notes are Markdown files in `~/.local/share/agent-room/notes/<hash of the room folder>/`, one per note, named by time and random letters (never the title): never in the room's folder, never replicated, and the agents are not told about them.
- **Terminal** (Control bar → **Terminal**, local pages only: `127.0.0.1` or `localhost`; see **Access and limits**): a shell on this computer, in the room's folder, shown with [ghostty-web](https://github.com/coder/ghostty-web). Opening it starts a fresh shell and fits it to the Services panel (and refits on window resize); switching to another service or closing the Services panel hides the terminal while keeping the shell running (shown by a green dot on the **Terminal** Control bar button). Click **End shell** inside the panel to stop it (reloading the page or stopping the server also ends it).
- **Boards** (left list panel, collapsible to a `«`/`»` strip and resizable by dragging its divider, both remembered per browser):
  - **+ New discussion**, **+ New brainstorm**, **+ New workbench** and **+ New research** sit side by side at the top of the panel (above the sections, always visible while expanded, hidden in the collapsed `»` strip). Before the first message, **Cancel** in the header closes the new board and returns to the board it was opened from (or another open board if that one has closed). In an empty room, Cancel on a new brainstorm, workbench or research board leaves the room empty.
  - Each research row shows its total recorded laps, the last round's start, and the next enabled daily run (or `—` when none is scheduled); counts above 30 are highlighted. Counts are saved in the board's `.research-stats.json` and survive restarts and moves. Older boards whose prior lap counts were not recorded show `≥` because their transcripts do not contain enough information to reconstruct every lap.
  - Sections: **Discussions** (active discussions and workbenches), **Research** (active research boards, marked with `.research` in `discussions/<date>-<title>/`, showing 🔬, with row states like a discussion and `⋯` actions **Continue** / **Resume**, **Peek files**, **Close**, **Archive**, **Defer**, **Turn into a discussion**, **Start fresh**, **Delete**, **Move up** / **Move down** — no worker actions), **Brainstorms** (active brainstorms), **Archived · Deferred** (folded by default; includes archived and deferred discussions, research boards with **Make active** and **Delete**, and brainstorms), and **Received from peers** (when replication is on).
  - Organized into collapsible sections: **Discussions** (active, open by default), **Brainstorms** (open by default), **Archived · Deferred** (folded by default with count), and **Received from peers** (folded by default with count, when peers have discussions).
  - Each row shows its display title (saved title, or the folder name without its leading date and with spaces; hover for the folder path; workbenches show 🔧), its state — the first that applies among `ongoing` (a round or summary is running, a worker task is running or queued, or it is closing), `closed`, `waiting for input` when the worker worktree has unresolved conflicts (hover the state label for `Worker conflict: <files>`), `not started` (no message sent yet), `waiting for input` (in memory only: paused auto dev — even when Restart auto dev is offered — a worker failure offering Retry, an agreed summary instruction that can't be sent, or a latest agreed summary with a non-empty Next step that isn't a usable offer, except a finished auto dev summary with `Outcome: FINISH`; hover the state label for the pause reason, failure or error; shows `idle` after a restart), `ready for auto dev` (in memory only: a usable Start auto dev offer when none of the above apply; shows `idle` after a restart), `work ready` (in memory only: auto dev finished on an agreed `Outcome: FINISH` summary and nothing has happened since except the built-in Catch up task; cleared by a new discussion message or any other worker task; shows `work ready · mergeable`, `work ready · needs catch-up`, or `work ready · merge blocked` with the reason on hover when the worker branch has unmerged commits, or omits the merge suffix when it has none; never shown on workbenches or discussions without auto dev; shows `idle` after a restart), and `idle` (the row on screen is highlighted without a separate label) — plus `· worker working`, the closing phase, `merged` or `no changes`, any amber worker warning (`⚠ Worker: 2 commits not merged into main · uncommitted changes`; `worker/main` or non-active unmerged branches appear above the active list), and a red conflict warning (`⚠ Worker conflict: <files>`) under the row (including closed discussions) whenever the worktree has unresolved conflicts and no worker task is running or queued for that discussion. Worker branch status is rechecked after each worker task, when expanding the **Boards** list panel, when clicking the **Worker** tab, when opening **Actions ▾** or a board row's **`⋯`** menu, when returning to the window (at most once every 5 seconds), and when **Close and Merge**, **Close and Discard** or **Catch up** fails. Active discussions and brainstorms each keep your drag-and-drop / **Move up** / **Move down** order per room in this browser.
  - Clicking an **active** board's row switches to it (like Go to / Continue). Clicking a **closed** discussion or **closed** brainstorm (active, archived or deferred) peeks at it read-only — **chat and files** together, without starting any agent or worker session. Archived and deferred brainstorms appear in **Archived · Deferred** labelled `archived brainstorm` or `deferred brainstorm`. Secondary row actions (**Resume** / **Continue**, **Peek files**, **Close**, **Close and Merge**, **Close and Discard**, **Archive**, **Defer**, **Make active**, **Turn into a discussion**, **Start fresh**, **Delete**, **Move up** / **Move down**, rollback, and peers' **View chat**) live in each row's **`⋯`** menu.
  - **Peek**: while peeking at a closed board, both the Discussion and Worker message boxes are disabled with a read-only notice, a **Back** button to return to the active discussion, and an explicit **Resume** button. An orange banner ("Looking at <name> · Back to current") and an orange dot on the Explorer tab also mark the peek, and Document's path line names the peeked board.
- **Side pane** (**Explorer** and **Document** — two mutually exclusive tabs, one at a time):
  - **Close, reopen, and split orientation.** Click **`✕`** in the side pane header to close the side pane so Discussion/Worker takes the full Main panel; click **◫ Side pane** in the Discussion/Worker header to reopen it to the last selected tab. Clicking a `[[D4]]` / diagram / chart reference, a file link, or a **📄 Show …** button in chat while the side pane is closed reopens it to **Document** (and highlights the reference). Click **`⇅`/`⇆`** beside **`✕`** to switch the Main panel between side-by-side and stacked (conversation above, side pane below), dragging the divider in either direction; side-pane open/closed state, orientation, and divider size are remembered per board in this browser (keyed by room and board folder name, preserved across Archive, Defer, and Turn into a discussion; a board with no saved layout yet copies the layout on screen the first time it is shown, and peeking or viewing a peer's chat shows that board's saved layout if it has one without saving changes).
  - In **Explorer**, view one tree at a time, chosen with the bar `[ Discussion | Room checkout | Worker copy ]` (Worker copy is coming soon). Under the bar, a line shows the folder and branch. **Discussion** shows the active (or peeked) discussion's files. **Room checkout** shows the room's root checkout, excluding hidden and gitignored files (non-discussion files in `discussions/`, such as `discussions/README.md`, remain reachable). Code, config, and other text files open as plain text in Document; supported images and PDFs stay viewable; files that cannot be displayed are greyed out ("can't be shown here").
  - In **Document**, view the chosen file with its path. Each tab keeps its place when you switch; Document is disabled until a file is chosen. The chosen document stays selected when agents edit other files, and open documents check for changes every two seconds. Drag the divider to resize the panes. Browsing is available during agent turns and does not notify the agents.
  - **Tables and pointing.** A ```` ```csv ```` block in a Markdown document shows as a table with
    column letters and row numbers (```` ```csv runs ```` names it `runs`). A cell starting with `=` is a
    formula: cell references, `+ - * /`, and `SUM`, `AVERAGE`, `MIN` or `MAX` over a range (`=SUM(B2:B8)`);
    errors show as `#REF`, `#CYCLE`, `#DIV/0` or `#VALUE`. Click a cell to point at it: a chip appears by
    the message box, and your next message ends with one `[pointing at: …]` line naming the cell, its value,
    its row and column labels and its formula (✕ on a chip drops it; commands never carry it). A
    `[[D4]]` or `[[runs!D4]]` in the chat highlights that cell in the shown document while you hover it, and clicking it reopens the side pane to Document if closed.
  - **Diagrams.** A ```` ```mermaid ```` block is drawn as a diagram (Mermaid, loaded only for documents
    that have one; a diagram with an error shows Mermaid's message). In a flowchart, click a box to point
    at it the same way (`[pointing at: diagram box Worker ("The worker") in …]`), and `[[Worker]]` in the
    chat highlights that box: a box's name is its id in the source (`Worker` in `Worker[The worker]`).
  - **Charts.** A ```` ```vega-lite ```` block (a Vega-Lite JSON spec; its `data` can be inline `values` or a
    `url` to a file next to the document) is drawn as an SVG chart, with Vega loaded only for documents
    that have one; a spec with an error shows the message. Click a bar or point to point at it
    (`[pointing at: chart point day: 16 Nov, runs: 42 in …]`), and `[[16 Nov]]` in the chat highlights
    every mark with a field of that value.
  - **Marking up.** A document with tables, diagrams or charts gets a small toolbar (top right): **Point**
    (clicking, as above), **Pen**, **Circle** and **Arrow** draw over the document, and each finished mark
    points at what it covers (an arrow: what its tip is on), as a chip such as "✎ circled Worker". Marks
    stay on the page until **Clear marks** or a reload, and are never saved. Esc returns to Point.
  - **Files named in the chat.** A path the room has, written in a message (`notes.md` or
    `drawings/flow.svg` for the current discussion's files, or a full path from the root), becomes a link
    that shows it in Document. When a new message from an agent or the worker names files, buttons by the
    message box offer them (**📄 Show notes.md**; ✕ dismisses, your next message clears them). With
    **Follow mentions** on (Document's bar; off by default, remembered by this browser only), the first
    file named is shown at once instead; otherwise the chosen document stays as it is.
- **Transcripts** are in each discussion's (and brainstorm's) `transcripts/` folder, under **Explorer**. On an
  earlier session's transcript, **Send to agents** asks the discussion agents to read it as
  background; it does not resume its sessions.
- **Reload:** load code and rulebook edits between discussion commands without losing the
  current conversation. Open pages refresh by themselves when the page's own code changed,
  keeping what you were typing. An update from the code before each discussion had its own worker
  queue can't be reloaded: Reload (and dev mode's) is refused in every room with "This update
  changes the worker's queues: Restart to apply it (Reload can't).", and so is opening another
  discussion in a folder meanwhile; everything goes on with the previous code until Restart.
- **Restart:** click twice to replace the server process on the same address, for changes Reload
  can't load (such as `cli.mjs`). It acts on the whole server: the new process brings back every
  room, each with its current agents and worker, and resumes each one's discussion in use from its
  latest checkpoint (below): the same agent and worker sessions and chat, as of its last round.
  Open pages reload by themselves. Reload also applies to every room, each between its own rounds.
- **Quit room:** click twice to end this room only, closing every discussion open in its folder. It waits for the round in progress (and lines
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

Files directly in `discussions/` that aren't dated folders (in this project, its index
[`discussions/README.md`](discussions/README.md)) are listed under "This room's own documents",
with no Continue or Resume button.

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
      closing-statement.md     # written on Close, for the next session
      pending-instructions.md   # unsent worker instructions, when needed
      transcripts/
        session-2026-11-02-1014.md
    archive/                   # finished discussions, moved here whole
      2026-10-21-another-topic/
    deferred/                  # postponed discussions, moved here whole
```

**Archive and deferred.** Each local discussion row's **`⋯`** menu in **Boards** has **Archive** and **Defer**
actions (or `/move <folder-name> archive|deferred`), which move the whole discussion, documents and
transcripts, into `discussions/archive/` or `discussions/deferred/`; **Make active**
(`/move archive/<folder-name> active`) moves it back. `archive/` and `deferred/` are created when
first needed, and listed in the folded **Archived · Deferred** section of **Boards**.
Archive and Defer require a closed discussion, with the reason in a tooltip. Make active leaves it
closed until Resume. New discussion names also skip names already
taken in `archive/` and `deferred/`.

**Sessions.** The word has two meanings here. A **provider session** is one continuous
conversation with an agent's or the worker's CLI (Claude Code, Codex): what was said, read and
replied in it, as the provider keeps it (it may compact older turns). The provider stores it on
this machine (Claude Code under `~/.claude/projects/`, Codex in its own folder); agent-room keeps
only its ID, in the discussion's checkpoint (below). Continue on a paused discussion hands the same
IDs back, so the conversation continues with its memory. Close drops the IDs; Resume then starts
new sessions from the closing statement. Start fresh also starts new sessions. Each discussion has its own agent sessions
and its own worker session, which works in that discussion's own worktree (see
[The worker's worktrees](#the-workers-worktrees)). Separate sessions and worktrees keep memories
and uncommitted work apart, not files: every agent and worker can still read the whole root. A
**discussion session** is the stretch of a discussion recorded in one transcript
(`transcripts/session-<date>-<time>.md`): Resume and Restart continue it; a fresh start (the first
message, Start fresh, or Resume without a checkpoint) begins a new one.

**Several open discussions** (on the screen). A folder can have
several discussions open at once, each with its own agents' sessions, chat and auto dev, and its
own worker session, worktree and queue (below): their worker tasks run at the same time, at most
two at once. You can switch discussion while one waits for its worker task: the window shows one
discussion, the one what you type goes to, and the task's report still goes back to its own. One window shows one of them; **Boards** highlights the one on screen and shows each row's state (`ongoing`, `closed`, `not started`, `waiting for input`, `ready for auto dev`, `work ready`, or `idle`). Clicking an open row (or choosing **Continue** in its **`⋯`** menu) shows an open one as
it is, during a round too: its agents carry on, nothing is restarted. An open discussion that hasn't started (no message
yet) shows **Go to** in its menu instead, which only shows it. **+ New discussion** and **+ New brainstorm** (at the top of **Boards**) open the new
one beside the one in use, which stays open (in place, when the one in use hasn't started). Continue, Resume
and Start fresh open any other discussion or brainstorm beside the open ones; several brainstorms
can be open at once. **Close** (in **Actions ▾** and each row's **`⋯`** menu in **Boards**, or `/close`) is labelled **Close with pending work** when the discussion's worker branch has commits not in main or uncommitted edits, and also works on a paused
discussion's row. When the discussion has a worker worktree or branch that is already merged (no commits outside the room's current branch) and clean (no tracked edits, no untracked files and no Git operation in progress), plain **Close** cleans up the worktree and branch automatically under the room-wide lock (`git worktree remove --force`, `git branch -d`, clearing the lane's hold and saved worker session) and appends `Worker worktree and branch removed (already merged).` to `closing-statement.md`. This cleanup treats every gitignored file in a merged worker worktree (including `.worker-notes/` and `node_modules/`) as transient and removes it with the worktree. If cleanup fails partway or another merge/discard holds the lock, the discussion still closes and reports what was and wasn't removed in the room and in the closing statement. Otherwise, **Close with pending work** keeps the worker branch and worktree exactly as they are (branch, commits, uncommitted, untracked and ignored files) for rework later. It refuses new worker instructions and waits for its queued and running tasks;
while Close runs, its row in **Boards** (in the active or archived/deferred list) and, when it is on screen, its header status show **closing · waiting for worker** while waiting for worker tasks (with **Cancel close** offered only during this waiting phase), then **closing · writing statement** until Close ends. Tasks queued behind an unresolved-edits hold can never start, so Close refuses at once and names them instead of waiting. A one-off
agent with the provider and model set in that discussion's **Worker · provider & model** panel
(not the discussion agents, nor the worker's own session) then reads the discussion's notes and
transcripts and writes a closing statement pointing to `pending-instructions.md` (the system messages name its provider and model, when it starts and when the discussion is closed; its format — non-empty, not `PASS`, and naming `pending-instructions.md` — is checked and retried once in the same session if needed, logging `Format check: …`, and Close fails if the retry is still wrong, keeping the previous statement); when the branch has pending work, agent-room appends `Worker work pending on <node or host>: \`worker/<name>\`, N commits not in main, uncommitted edits: yes/no, worktree \`<path>\`.` to `closing-statement.md`. agent-room writes the one
current `closing-statement.md`, ends the sessions and marks the discussion closed. Unresolved worker
edits do not prevent Close: the worktree's queue hold stays as it is, and resuming the discussion later finds the edits still there. **Close and Merge** (beside Close in **Actions ▾** and each row's **`⋯`** menu in **Boards**, shown when the discussion's branch has commits not in the room's current branch) merges `worker/<name>` into the room's current branch, cleans up its worktree and branch, and closes after two clicks: it is greyed out with the reason in its tooltip while the worktree has uncommitted edits or is mid-merge/rebase/revert, a worker task is running or queued, the room is on a detached HEAD, mid-operation or has tracked edits outside `discussions/`, the merge preview is not clean, or the worker has not recorded a passing `Tested:` line for the current tips. When the room's branch has moved ahead of `worker/<name>`, it offers **Catch up with `<branch>`** instead, sending the worker a catch-up task (allowing it to resolve and commit purely additive conflicts, while stopping on any other conflict) and stopping so you can review the report before clicking **Close and Merge** again. The first click names the target (`Merge worker/<name> into <branch>`), lists the commits to merge (and any untracked files in the worktree; removing the worktree also removes its gitignored files as transient, without warning about them in the dialog), shows an informational notice of any other discussions in a round, running/queued worker tasks, or other branches with unmerged commits (omitted when nothing else is active and no other branches have unmerged commits; never blocks the merge or invalidates the second click), and snapshots the state (excluding gitignored files); the second click re-checks everything, runs `git merge --no-ff` under a room-wide lock shared with **Close and Discard** so only one merge or discard runs at a time across the room (a second request refuses immediately, naming the operation in progress; on conflict, the merge is aborted and everything stays open), removes the worktree (`git worktree remove --force`), deletes the branch (`git branch -d`), clears the lane's hold and saved worker session, and closes with `Worker work merged into \`<branch>\` as \`<merge commit>\`.` in `closing-statement.md`. **Close and Discard** (beside Close in **Actions ▾** and each row's **`⋯`** menu in **Boards**, shown only when discarding would lose commits not in the room's current branch, tracked edits, or untracked files) closes the discussion and deletes its worker worktree and branch after two clicks (sharing the same room-wide lock with **Close and Merge**): it refuses while a worker task for the discussion is running or queued, or while its worktree is mid-merge, mid-rebase or mid-revert; the first click lists commits not in main, tracked edits, untracked files, and ignored files summarised by top-level folder and snapshots them; the second click re-checks the snapshot (asking again if anything changed), saves any unmerged commits to a unique `refs/discarded/<name>/<YYYYMMDD-HHMMSS>` ref (commits only, not uncommitted or ignored files), removes the worktree (`git worktree remove --force`), deletes `worker/<name>` (`git branch -D`), clears the lane's hold and saved worker session, and closes the discussion with a `Worker work discarded: …` line in `closing-statement.md`. If any step fails partway, it stops, leaves the discussion open, and reports what was and wasn't done. If Close fails or is cancelled, the discussion stays open or paused and
can be retried. **Quit room** ends the room, and Restart brings back every open discussion and
brainstorm from its checkpoint (not empty ones). Only closed discussions replicate; replication sends the closing statement (including any pending-work line) but never the worker branch or worktree. Each discussion keeps its own worker settings and
session. In the terminal one discussion is open at
a time, as described next: its one input can't switch between discussions.

**New discussion** in the terminal (`/new`) works between rounds. It ends this
room's session the way Resume does (below; its checkpoint is kept). Nothing is created yet: your
next message gets a title and creates the new discussion's folder, as in a fresh room.

**Each discussion keeps its own worker session**, in the terminal too. When a discussion's session
ends here (New discussion, Resume, Start fresh, New brainstorm), nothing waits for its worker:
its tasks still running or queued finish in that discussion's own worktree and worker session, their
reports go to its transcript, Worker-tab entries and checkpoint, and the Worker tab gets a marker
line. The discussion you switch to gets its own worker session: the one its checkpoint saved
(Resume; the very same one if its tasks are still running), or a fresh one (New discussion, Start
fresh, or a Resume from a closing statement or pending handoff). A brainstorm's worker session is never carried into a discussion,
nor a discussion's into a brainstorm. In the terminal one room still runs one worker task at a
time, so a task you send after switching starts when the earlier discussion's task has ended. Close
instead waits for the discussion's own queued and running tasks before ending its worker session.
After Start fresh, a task still running from the earlier session reports to that session's
transcript (in the same folder) and the Worker tab, not to the fresh session; it doesn't replace
the fresh session's worker in the checkpoint. Its token usage isn't counted in any discussion's
totals.

**+ New brainstorm** (at the top of **Boards**, or `/brainstorm`) starts a conversation with
the same agents, turns and `PASS` rules. Its first message gets a title from Claude and a folder,
as a discussion's does, but under `brainstorms/` at the root: `brainstorms/<date>-<title>/`, holding
`transcripts/`, `drawings/` if the agents draw, and `files/` if you attach files. A name is never one already taken in
`discussions/` (`archive/` and `deferred/` included) or in `brainstorms/archive/` and `brainstorms/deferred/`, nor a discussion's one taken in `brainstorms/` (`archive/` and `deferred/` included).
It saves checkpoints like a discussion (below), under the key `brainstorms/<name>` in every section and with no worker
part, so Resume (`/resume brainstorms/<name>`), Close and Restart work as for discussions. The agents
are told it is a brainstorm: they write nothing except drawings in its `drawings/`, may read the
project, and propose turning it into a discussion when something else tangible is wanted. A
brainstorm sends no work: while one is shown, the Worker tab says "Turn this brainstorm into a
discussion to send work." and refuses instructions; there is no auto dev or automatic
summary (manual **Summarize** works), and the lap cap is 20. Brainstorms are not replicated to
peers. Typing in a room with no discussion still starts a discussion.

**Archive and defer (brainstorms).** A closed brainstorm's **`⋯`** menu in **Boards** offers **Archive**
and **Defer** (or `/move brainstorms/<name> archive|deferred`), moving the whole folder into
`brainstorms/archive/` or `brainstorms/deferred/` (created when first needed) while keeping its
checkpoint under `brainstorms/<name>`; open brainstorms cannot be moved. Archived and deferred
brainstorms are listed in the folded **Archived · Deferred** section (labelled `archived brainstorm`
or `deferred brainstorm`); clicking one peeks read-only (chat and files), and its **`⋯`** menu offers
**Resume**, **Peek files**, **Peek chat & files**, **Make active** (`/move brainstorms/archive/<name> active`),
the other of **Archive** / **Defer**, **Start fresh**, and **Delete** (make it active first before
**Turn into a discussion**). `/resume` and `/fresh` on `brainstorms/archive/<name>` or
`brainstorms/deferred/<name>` make it active first; `/peek` peeks in place; `/delete` removes the
folder and checkpoint.

**Turn into a discussion** (in an active brainstorm row's **`⋯`** menu in **Boards** or in **Actions ▾**, two clicks; `/convert
brainstorms/<name>`) moves `brainstorms/<name>/` to `discussions/<name>/`, never over an existing
folder (checked as it moves: then nothing moves), and its checkpoint to the discussion's key. The
agents keep their sessions: each is told once, in its next prompt, the new folder and that the
discussion rules apply from then on (an open one carries on at once; a closed one, at its Resume).
The worker starts fresh at the discussion's first task. **Start fresh** on a brainstorm (`/fresh
brainstorms/<name>`) starts new agent sessions briefed from its latest summary (marked when it
wasn't agreed) or, with none, pointed at its `transcripts/` to read first, as the source that a
summary may leave details out of. **Delete** (`/delete brainstorms/<name>`, or in `archive/` / `deferred/`) refuses an open brainstorm.

**Turn a research board into a discussion** (its active Boards row’s **`⋯`** menu or **Actions ▾**, two clicks; `/convert discussions/<name>`) keeps the folder and its documents, removes `.research`, and ends the research sessions. The same agents start fresh under the discussion rulebooks, pointed to the research notes, transcripts and latest summary. It is refused while a round or summary is running. Recurring scheduled tasks linked to the board are turned off and reported. Archived or deferred research must be made active first.

**New workbench** (**+ New workbench** at the top of **Boards**, **New workbench** in **Actions ▾**, or `/workbench`) opens a worker-only board for one small fix. Its first message gets a title from Claude, creates `discussions/<date>-<title>/` with a `.workbench` marker file inside it (so closed, archived and deferred workbenches stay recognised, and show 🔧 in **Boards**), and goes straight to the worker as its first instruction, never as a discussion round. Later messages go straight to the worker. Each workbench instruction includes a short prompt paragraph asking the worker to keep the change and its commits small, say what to check on screen, and say plainly when a request is big enough to need a discussion instead. A workbench shows only the **Worker** chat (no **Discussion** tab, discussion-members panel, **Summarize**, or Auto dev). **Close**, **Close and Merge** (or **Catch up with `<branch>`**), and **Close and Discard** keep all their existing checks and worktree/branch handling, skip only the closing-statement agent, and write no `closing-statement.md`. **Resume** on a closed workbench works without `closing-statement.md` and restores its worker conversation. Workbenches are never replicated to peers.

**Every discussion saves itself.** After every round (with or without its summary), every
`/summary` and every worker task, and when its session ends (Close, New discussion, Quit room,
Restart), agent-room saves the discussion's checkpoint on this machine: the provider session IDs
of its agents and its worker, its chat and unread-message positions, its own entries in the Worker
tab, its provider/model choices and usage totals. The discussion part is as of the end of its
latest round. Checkpoints are private local files under `~/.local/state/agent-room/paused/`,
separated by root folder; they are not replicated to peers. Close removes the saved provider IDs;
the closed flag is persisted separately. Discussions from before this flag, and open discussions
left behind by a restart, are paused. **Boards** rows show `ongoing`, `closed`, `not started`,
`waiting for input`, `ready for auto dev`, `work ready` (all in memory only; `idle` after a restart) or `idle`, as appropriate; archived and deferred rows also show `closed` when applicable.

**Continue** / **Resume** (in a board row's **`⋯`** menu in **Boards**, or **Resume** in the peek banner, or `/resume <folder-name>`), for
any discussion not on screen, works between rounds. Clicking an active row switches directly; the menu action reads **Continue** for open or paused discussions and **Resume** for closed discussions (and closed brainstorms; open brainstorms show **Go to**):
- open in another discussion of this folder: it is only shown, as it is (during a round too, from its row);
- paused with a checkpoint: it continues there, with the same agent and worker sessions and its chat;
- closed: it clears the closed flag and starts new agent and worker sessions, with the closing
  statement in each agent's first prompt; if it is absent, a pending `handoff.md` is used instead;
- without one: no title is requested and your next message starts a fresh session from its
  closing statement or pending handoff and notes, in a new session transcript;
- an archived or deferred one (`/resume archive/<folder-name>`) is first moved back to the active
  discussions.

The button's tooltip says which case applies. On the screen it opens beside the open discussions;
in the terminal the session in use ends first, without waiting for its worker tasks (see above; its
checkpoint is saved; the chat clears, and the discussion agents get fresh CLI sessions; the worker
continues the resumed discussion's own session). A checkpoint that can't be used (invalid,
or a provider session missing) is kept, the room stays as it was, and the error suggests Start
fresh. Continuing a paused discussion needs the providers' original local session
storage; if a provider cannot resume its session, its turn fails without a silent fresh start.
This is native session continuation, subject to provider context compaction and changes to files,
models or rulebooks.

**What a Resume or Restart reports.** Quit room and Restart let the round in progress end first (or
fail, after 30 seconds), so it is in the checkpoint. After a crash, a round may have been cut off:
when the transcript file grew after the checkpoint, Resume says so, with the line where the part
missing from the restored chat starts, and marks the transcript. An unchanged transcript doesn't
prove nothing was lost (a provider may have recorded part of a turn that was never logged), so every
restore also tells each agent, in its next prompt only, that it was restored from the checkpoint of
that time and that any turns it remembers after that are not in the room's record. A Claude session
whose first turn never completed gets a new ID.

The checkpoint also records each worker task: when it is queued, and as soon as it starts (then
with its branch's commit at that moment). After Quit, Restart or a crash, Resume reports in the
Worker tab and, as one agent-room message, in the chat, each task that was interrupted, with what
the worktree shows now: uncommitted edits (the queue holds as usual), commits made before the reply
was lost, nothing left in the worktree, or "Result unknown: … Check the worktree" when it stopped
before its starting commit was recorded. A task still queued is reported as not started; nothing is
re-sent. The next instruction from that discussion tells the worker, once, that its previous
instruction was interrupted. A task from a discussion that has no full checkpoint yet (after Start
fresh, or a Resume from its closing statement or pending handoff, before the first message) is recorded in a small checkpoint
that holds these records; the discussion still starts from that statement or handoff. What remains
unrecorded: tasks sent before a new discussion's first message, which names and creates it (a
brainstorm sends none).

**Start fresh** (in a row's **`⋯`** menu; two clicks; `/fresh
<folder-name>`) discards the saved sessions and chat: new agent and worker sessions start from the
closing statement (or pending handoff if there is no statement) and notes, briefed with the checkpoint's latest summary, marked when it wasn't agreed (none
without a checkpoint). Until the fresh session's first round, a small checkpoint holds only that
summary, so a Restart or Resume in between still briefs with it. Old conversations are not replayed.

`/pause`, `/reopen`, `/continue` and `/autosummary` are no longer commands: they answer with a
hint instead of reaching the agents.

Peeking at a closed board (or choosing **Peek files**) does not switch the one in use; clicking an active row, **Continue**, **Resume**, or **Start fresh** does. Display-title
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
share the worker's worktrees: the room opened later there gets no worker, and its Worker tab says why.
Cancelling the chooser leaves everything as it was.

## Choose providers and models

The Discussion members and Worker provider panels show each current CLI session ID after its first
completed turn. You can copy an ID to resume that provider's session locally; using the same session
concurrently from another CLI may interfere with agent-room's conversation.

Expand **Discussion agents · provider & model** in Discussion, or **Worker · provider & model**
in Worker. The Discussion panel has three rows: tick two or three members, in the order they should
speak. Untick a member only after ticking its replacement. Names suggested from the provider remain
editable. If a discussion was launched with one or more than three agents, the panel keeps all its
existing rows and lets you edit them; use `--agents` to choose a different count.

The **Providers** service (opened from **Providers** on the far-left Control bar, in the half-window
Services panel with the **Boards** list panel collapsed) holds the defaults for new discussions, the
members and the worker together (**✕**, **Go to the discussion**, **Providers**, or **Boards** on
the Control bar closes the panel). Before the
discussion starts, its changes apply to it too; after, they change only the defaults (for new
discussions in this room and every other), never the running agents or worker. Below the settings,
the Provider health section is folded until opened; the whole page scrolls as one column. The
Discussion and Worker tabs' own panels work as before.

Defaults save automatically to `~/.config/agent-room/defaults.json`, shared across project
folders and subsequent launches, including the Dock launcher. Dropdown selections save on change;
text edits save when committed, such as by leaving the field. A custom model choice waits for
its model ID. Invalid choices show a save error and do not replace the saved defaults.

Worker provider, name and model changes apply only to this discussion or brainstorm, starting with
the next instruction, including after a failed turn. Before work starts they also become defaults
for new ones; after work starts they do not change the defaults.
A running instruction finishes with its original settings; resend a failed instruction yourself.
Changing models keeps the provider session. Changing provider or worker name starts a fresh
session supplied with the previous Worker-tab conversation and its worktree/discussion context.

Before work starts, discussion changes also apply to the current room. After you submit a discussion
message, request a summary, or send worker instructions, changes are saved for **future rooms**;
discussion agents keep their settings. Settings shown then may describe future defaults rather
than the running sessions. Each tab saves its own choices without replacing the other tab's.

If a discussion agent fails, **Disable** appears above the conversation. It excludes that agent
from later rounds and summaries in this discussion; **Enable** brings it back with its existing
session. At least one agent must remain enabled. This choice survives Reload and Resume of the
discussion, and does not change other discussions or future-room defaults.

- **Provider:** Claude, Codex or Agy, for both discussion agents and the worker.
- **Model:** Claude offers Opus, Sonnet and Haiku aliases. Codex reads the visible entries in
  its local `models_cache.json` under `CODEX_HOME` or `~/.codex`. There is no live account-model
  lookup for Codex. Agy reads its available models from `agy models`. If a catalog is unavailable,
  use CLI default or a custom model ID.
- **CLI default:** pass no model argument and let that CLI choose.
- **Custom…:** enter a model ID supported by your installed CLI and account.
- **Names:** use distinct names for the agents and worker, with letters, numbers, underscores
  or hyphens, so `@name` is unambiguous.

Explicit `--agents` and `--worker` override their respective saved defaults for that launch
without rewriting the defaults file. New discussions and brainstorms in that folder use those
launch choices until a panel change updates the corresponding default. Each open folder keeps its
own choices; another folder opened later starts from the saved defaults. The title-generation call always uses Claude's CLI default,
independently of the selected discussion and worker models.

## Summaries and usage

**Summarize**, or `/summary`, asks the discussion agents to agree a summary by points under
**Agreed**, **Disputed**, **Open**, **Next step** and **Later**, leaving out empty sections, with at most
eight points under Agreed, Disputed and Open. Disagreements go under Disputed only; Open records
what each point waits for and does not repeat the Next step question. **Next step** holds exactly one action for you: `Answer:`
a question, `Send to the Worker: "…"` with a one-line instruction word for word (a multi-line
instruction must instead follow `Send to the Worker:` alone on its line as a `>` block quote; saved
summaries in the old multi-line inline form still resume), or
`Do:` an action of your own; **Later** lists the remaining actions in order. An instruction for the worker is kept until
you say it was sent, replaced or withdrawn. In a discussion, under Later it is referred to by
name, with its full text in the discussion's `pending-instructions.md`; in a brainstorm, where
agents write no notes, this applies to discussions only (see below). The format and what the code reads from it are
in [the summary contract](docs/architecture.md#summary-contract). The drafter rotates between summaries. Writing
or revising counts as accepting that version; every other agent must pass on it for agreement.
Each draft or revision (never a reviewer's `PASS`) is checked for format before the next agent
reviews it: on problems, agent-room logs `Format check: …` and asks the same agent once for a
complete corrected summary, so only the corrected reply becomes the version the others review
(both replies and their usage stay in the transcript; if the agent answers the retry with `PASS`,
the retry counts as failed and its first reply stays the version; if the retry still fails, the
summary goes on with its problems logged).
Each agent gets at most three turns. Without agreement, the last revision is shown as
**not agreed**. Only the result appears in the chat; the exchange is retained in the transcript.
In a brainstorm, summaries work the same way, but their prompt leaves out the sentence about
`pending-instructions.md`: a worker instruction lives only in the chat (and its transcript) until the
brainstorm becomes a discussion.

**Auto-summarize** is always on in discussions (not in brainstorms, where you can still run
**Summarize** or `/summary` yourself). After a discussion round where an agent spoke and none
failed, it runs the same summary process, adding up to three turns per agent. It does not run after
a round of only passes.

**Auto dev** relays instructions between the Discussion and the Worker, so you don't copy and
paste them. When the latest agreed summary's **Next step** is `Send to the Worker: "…"`, a
**Start auto dev** button appears beside it (`/autodev`). It sends that instruction to the worker as
cycle 1 of the run’s limit (5 by default), shown in the Worker tab as **Relayed from discussion**; each instruction sent is
also announced in the Discussion ("Auto dev sent the instruction "…" to the Worker (cycle n of the limit)."),
which the agents receive and the transcript keeps. The worker's full reply comes back to the Discussion as a **Worker report** and starts a round. If the worker fails, auto dev pauses with **Retry** and **Retry with…** in the Worker tab; the failure appears in the Discussion without starting a round, and the agents receive it with your next message. You can discuss it without ending that pause. A successful retry reports at the same cycle and resumes the run, unless it was restarted or ended meanwhile; another failure leaves it paused. That round is always summarized, and the summary must end with `Outcome: SEND`, `FINISH` or
`WAIT FOR USER`; passing on it accepts its quoted instruction exactly as it stands. Only an agreed
SEND summary written after the latest report sends its instruction, once; repeating earlier text
there is a deliberate retry. The run pauses, with its reason in the discussion header, on `WAIT FOR
USER`, an unagreed summary, a failed discussion turn, a message you type in either tab (while auto
dev runs, the Discussion message box placeholder notes that sending a message pauses it; a running
worker still reports, but nothing more is sent), or when the cycle limit is reached (failed attempts count;
the last report is still reviewed). When paused, the next agreed instruction and **Restart
auto dev** (or any reason the instruction can't be sent) appear above the message box, and **Restart
auto dev** starts a new run. A summary can put `Steps left: N` immediately before its Outcome line to set the limit from the plan, including the step being sent; the limit rises only when the count rises (to cycles used + N + 2, at most 15); otherwise it stays or falls, so fix rounds use up its slack. This is a guardrail, not a cost cap: a corrected count can grant more cycles. While paused, any summary asks for `Outcome: FINISH`
or `WAIT FOR USER` instead, and sends nothing. An agreed `FINISH`, running or paused, ends the run:
review and merge the discussion's branch (`worker/<name>`) yourself, as ever. During auto dev, each summary draft or revision is also checked before review for its `Outcome:` line (`SEND`, `FINISH` or `WAIT FOR USER` while running, with an instruction for `SEND` and any `Steps left:` line a whole number above 0 just before `Outcome:`; `FINISH` or `WAIT FOR USER` while paused). An instruction that can't be read reliably from Next step (two of them, no
closing quotation mark, multi-line inline quotes in a new summary…) or a summary whose instruction or `Outcome:` failed the format check is never sent, and the page says why (a bad `Steps left:` line alone is logged and ignored). Reload keeps a run, its cycle count, a failure pause and its retry buttons,
and what was sent; a relay whose result is lost pauses the run. Resume, Start fresh, Close discussion, Restart
and Quit room end it (a resumed discussion comes back without its run); in the terminal, New
discussion and New brainstorm do too (on the screen they leave the discussion and its run open). Auto dev is for discussions only, not brainstorms.

`/usage` reports session token totals for discussion agents and the worker.
Claude's reported dollar value is an API-price equivalent, not your subscription bill.
Header gauges show **percent used**, for each provider's five-hour and weekly windows, plus
reset times, and when the meter last measured them, as `on HH:MM` (hover for when the room last asked). Yellow means under 30% remains; red means under 10% remains.

Quotas come from the optional local meter at `http://127.0.0.1:9899` (override with
`AGENT_ROOM_METER`). They refresh every minute and after turns. If the meter is unavailable,
the header and usage report say so; the room still works. For Agy, the meter’s Antigravity
model entries supply the highest used percentage in each available window. Agy login is not monitored.

Each prompt to a discussion agent (in discussions and brainstorms, summary turns included) and to
the worker starts with one line showing only that agent's own cumulative reported session usage
(turns, input with cached, output) and its own provider's cached quota windows, with percentages
labelled as used and the meter's measurement time ("none yet" when no turns have been reported,
"usage unavailable" when a worker from another discussion runs a task whose session totals aren't
loaded here, or "quota unavailable"
when there is no meter data for its provider), without adding a meter request per turn.

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
| `/resume <folder-name>` | Show an open discussion, continue a paused checkpoint, or reopen a closed discussion with fresh sessions from its closing statement. `archive/…` or `deferred/…` is made active first; `brainstorms/<folder-name>` (and `brainstorms/archive/…`, `brainstorms/deferred/…`) resumes a brainstorm (making it active first if archived or deferred). |
| `/fresh <folder-name>` | Start fresh: new sessions there, from its closing statement or pending handoff, notes and its checkpoint's latest summary; the saved sessions and chat are discarded. `brainstorms/<folder-name>` (and `brainstorms/archive/…`, `brainstorms/deferred/…`, made active first): from its latest summary or its transcripts. |
| `/new` | On the screen, open a new discussion beside this one (which stays open). In the terminal, end this session; your next message starts a new discussion. Its worker tasks finish in its own worker session; the new discussion's worker starts fresh. |
| `/close` | Close the discussion shown; `/close <folder-name>` also closes a paused one. Waits for its worker, writes a closing statement (appending a pending-work line if the branch has unmerged commits or uncommitted edits), and keeps the worker branch and worktree intact (refuses immediately if tasks are queued behind an unresolved-edits hold). |
| `/brainstorm` | Start a brainstorm (on the screen beside this one; in the terminal, ending this session). Its first message names it in `brainstorms/`. |
| `/research` | Start a research board (on the screen beside this one; in the terminal, ending this session). Its first message names it in `discussions/<date>-<title>/` with a `.research` marker; agents get `citizenship.md` + `group-chat.md` + `researching.md`, up to 20 laps, no worker, no Auto dev, no automatic summary (manual `/summary` works), and Close writes `closing-statement.md`. New research can also be scheduled in **Schedule**. |
| `/convert brainstorms/<folder-name>` | Turn into a discussion: the folder moves to `discussions/`, the agents keep their sessions and are told. |
| `/convert discussions/<folder-name>` | Turn a research board into a discussion in the same folder, with fresh agent sessions and discussion rules; linked recurring tasks are turned off. |
| `/convert brainstorms/<folder-name> research` | Turn into research: the folder moves to `discussions/` with a `.research` marker, old sessions end, and the same agents start fresh with the research rulebook, reading its `transcripts/` and latest summary. Refused while a round or summary is running. |
| `/delete <ref>` | Delete a closed brainstorm (`brainstorms/<folder-name>`, `brainstorms/archive/…`, `brainstorms/deferred/…`) or closed research board (`<folder-name>`, `archive/…`, `deferred/…`), removing its folder and checkpoint for good. |
| `/rollback <folder-name>` | Queue Archive with rollback as a worker task; review its report before archiving. |
| `/archive-rollback <folder-name>` | Explicitly confirm archive after a successful rollback report (switch away first). |
| `/move <folder-name> active\|archive\|deferred` | Move a closed discussion or closed brainstorm (`brainstorms/<folder-name>`, `brainstorms/archive/…`, `brainstorms/deferred/…`) into `archive/` or `deferred/`, or move it back to active without reopening it. |
| `/summary` | Request an agreed summary. |
| `/autodev` | Start (or restart) auto dev from the latest agreed summary's worker instruction. |
| `/usage` | Show session tokens and subscription quotas. |
| `/reload` | Reload source modules and all agent rulebooks; retain conversation and provider sessions. |
| `/restart` | Screen only: a new server process on the same port, with every room, each resuming its discussion in use from its checkpoint. |
| `/quit` | Quit room: end this room only, closing every discussion open in its folder and stopping its running agent and worker programs. |
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
`npm start -- --open` in the fixed project path `/Users/fausto/Software/agent-room`, without
replication. To replicate with charon again (reusing the saved pairing), add
`--node Mac --peer charon=http://192.168.178.70:5566` to that command in the script and rebuild the
app; rebuild it too if the checkout changes.
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

Each successful Close saves one snapshot to separate Git storage in `<root>/.agent-room/` and sends
it to paired peers. Open and paused discussions are not captured or sent; while one is reopened,
peers retain its last closed copy until its next Close. Source files and the project's Git index are
not replicated. Transcripts are included even if the project's ignore rules exclude them. A saving
error leaves discussion files in place. Sending runs in the background; unreachable peers retry
while the discussion remains closed, with a delay capped at five minutes, including after restart.

Received-only discussions appear under **Received from peers** (folded by default) in **Boards**, with the peer name, and **View chat** and **Peek files** in the row's **`⋯`** menu. Mixed discussions keep one local row with **Peek files** and **View chat** for the peer version. **View chat** opens that peer's conversation read-only,
without starting or stopping agents. **Back to <node>'s line** returns to the local conversation when that discussion has a local line.
The header keeps Restart and Quit room in its menus; ⓘ on each row shows node details on hover or keyboard focus, and Peers… is in the room's **agent-room ▾** menu.
New received rounds do not change an open View. Each browser pins its selected snapshot;
Back releases it, and closing/reloading the page releases it after two minutes without renewal.
Keep the page connected while reading: a suspended or disconnected page must select View again
when its lease expires. The latest snapshot and all open, leased Views are kept; older snapshot
folders are deleted while their commits remain in Git. There is no Continue here, reconciliation
or Fork. Replication has been tested locally; LAN and Raspberry Pi validation
remain separate deployment checks.

## The worker's worktrees

The worker never edits the room's own files. It works in a Git worktree of the room's repository,
one per discussion: `<repo>.workers/<folder-name>/` on the branch `worker/<folder-name>` (for
agent-room: `/Users/fausto/Software/agent-room.workers/<folder-name>/`). A task
sent before a discussion's first message (when it has no name yet), use `<repo>.worker/` on
`worker/main`, the one worktree every discussion shared before. Its notes still go in the room's
discussion folder. Each worktree has its own queue: a discussion's tasks run one at a time, in the
order sent, while other discussions' tasks run in theirs. At most `PARALLEL_WORKERS` = 2 tasks run
at once in a folder (each costs a provider session's tokens, and its tests load the machine); a task
that has to wait for a free place says so in the Worker tab, and starts as soon as one ends. Each
discussion's window shows its own worker working, not the others'. You review and merge each discussion's branch yourself (`git merge
worker/<folder-name>` in the room); nothing is merged automatically.

- A worktree is created at its first instruction, from the room's `HEAD`, and reused after Reload
  or Restart. An existing branch is reattached. If something else is already at that folder, the
  worker refuses to run and changes nothing. A discussion folder whose name can't be a branch name
  (a space, say) has no worktree; its Worker tab says so.
- **From one shared worktree to one per discussion.** Commits already on `worker/main` stay there:
  nothing moves, drops or rewrites them. A discussion's own worktree is not created while
  `<repo>.worker/` has uncommitted edits, nor while `worker/main` has that discussion's labelled
  commits that aren't in main: its first task then fails with the reason, and you merge
  `worker/main` (or have its edits committed) first. A discussion's saved worker session continues,
  and its first instruction in the new worktree tells it its working directory has changed.
- **The Worker tab** shows the worktree of the discussion shown, then every other branch with
  commits not in main or uncommitted edits: the folder, branch and base commit, uncommitted edits,
  commits on each side, and a Mermaid `gitGraph` of that branch's local history against the room's
  current branch (from their merge-base to both tips, showing each branch's first-parent history
  plus the merges between the two branches — including repeated merges of main into the branch —
  with other merges tagged `merge`, commit labels showing short hash and subject without a leading
  `[<label>] `, at most 15 commits per side with cut-off history marked by a `+N more commits`
  node, or a plain-text note when `gitGraph` cannot draw the history faithfully). For a branch with commits not in main it also says:
  - whether it contains main's current commit, naming it, or how many of main's commits it lacks;
  - the commits its worker last reported testing together, from its reply's last
    `Tested: <branch commit> with main <main commit>: tests passed|failed` line (plain text,
    with full 40-to-64-character hex commit IDs, as the reply's last non-empty line; recorded
    only when it passes the report format check and Git agrees: the branch commit is on the
    branch, it contains the main commit, which is main's), and whether either branch has moved
    since. The worker gives this line after a catch-up merge and after committing on a branch that
    already contains `main` (skipping it if `HEAD` or `main` changed while tests ran). If a branch
    has no recorded result (for example when its `Tested:` line was rejected or skipped), send the
    worker: "Make no changes. First run `git rev-parse HEAD` and `git rev-parse main` and note
    both IDs. Run `npm test` and report its real output. Then run both commands again: if either
    ID changed, say so and give no `Tested:` line. Otherwise end your reply with
    `Tested: <full HEAD commit ID> with main <full main commit ID>: tests passed`, or
    `tests failed` if any test failed." This is the worker's report: agent-room doesn't run the tests itself;
  - with Git 2.38 or newer, a merge preview: "clean", or the files that would conflict
    (`git merge-tree --write-tree`). It is advice only: it can go stale as soon as either branch
    moves, and a clean merge doesn't prove the combined code works. It changes no branch,
    worktree or index, but it writes Git objects that nothing refers to (the merged tree); Git's
    own cleanup (`git gc`, which also runs by itself from time to time) removes them. With an
    older Git there is no preview.

  These checks are made again after each task and whenever the Worker tab is shown.
- Before each instruction, the discussion's branch catches up with the room's `HEAD`, by
  fast-forward only, when it is strictly behind it and its worktree is clean. Otherwise it is left
  as it is, and the tab says why. agent-room's own code never resets or rebases a
  worktree or its branch, merges into the room's branch only on **Close and Merge** after you
  confirm its preview, and deletes a worktree and branch only on **Close and Merge** or **Close
  and Discard** (after you confirm) or on plain **Close** of an already-merged, clean branch
  (treating every gitignored file in that worktree as transient and removing it). The worker
  itself may do such Git actions in its worktree when you explicitly ask (a rollback's reverts,
  merging main into its branch to catch up or for rollback, or abandoning an attempt after listing
  the edits and getting your approval).
- When a clean branch still lacks commits from `main` (including diverged history), the task tells
  the worker to merge main normally before doing its work, then to run the project's tests (`npm
  test`, if it has them), report their real output and end with its `Tested:` line. Purely
  additive conflicts (both sides only adding independent lines or blocks) may be resolved and
  committed by the worker; any other clash is not forced: the worker reports it and that
  discussion's queue holds for its recovery. An
  unfinished merge or revert holds that queue even if `git status` otherwise shows no edits. The existing
  strictly-behind fast-forward remains; agent-room does not perform a normal merge or revert itself.
- **Merging a branch into main** (via **Close and Merge** in **Actions ▾** or the board's **`⋯`**
  row menu in **Boards**, or by hand in the room):
  - **Close and Merge** automates the checks below, runs `git merge --no-ff`, removes the worktree
    and branch, and closes the discussion after two clicks (or offers **Catch up with `<branch>`**
    when the room's branch has moved). When merging agent-room's own source into a running room,
    run **Reload** (or dev mode reloads it) afterwards.
  - To merge by hand instead: first check that the discussion has no worker task running or queued, that the room's `git
    status` shows no tracked edits outside `discussions/`, and that the Worker tab says the branch
    contains current main with a test report that is "Still current". If main has moved since,
    ask that discussion's worker to catch up with main first: then `git merge worker/<name>`
    can't conflict.
  - If you merge anyway and it clashes, Git prints `CONFLICT (content): Merge conflict in <file>`
    and `Automatic merge failed`, exits with 1, and `git status` marks the files `UU`; nothing is
    committed. `git merge --abort` puts the room back as it was. Then ask the discussion's worker
    to catch up with main, and merge again.
  - If `git merge --abort` itself fails (for example `fatal: There is no merge to abort
    (MERGE_HEAD missing)`), look at `git status` and `git diff` before anything else. In one case
    we tested (2026-11-12, a disposable repository), `git reset --merge` then put the conflicted
    file back and kept unrelated uncommitted edits, but that was one case, not a guarantee: for
    instance, it discards whatever you changed in the conflicted files after the merge started. Don't use `git reset --hard` while you have
    uncommitted work of your own in the room.
  - A merge without conflicts can still break the combined code (one side renames a function the
    other calls). The worker's tests on top of current main are the main defence; to check a merge
    yourself, `git merge --no-ff --no-commit worker/<name>`, run the tests, then `git commit` or
    `git merge --abort`.
- **Archive with rollback** (`/rollback <folder-name>`) queues one ordinary worker task for that
  discussion, in its own worktree and branch. It inspects all labelled implementation commits,
  including those already merged into main and older ones on `worker/main`, and earlier
  rollback/revert history, and looks for dependent work in main and in other discussions' branches; ambiguous sets or unsafe dependencies are reported
  before editing. The worker brings in main when needed, reverts the intended commits newest first,
  runs `npm test`, commits with the discussion label and rollback trailers, and reports its commit,
  real test output, dependencies on other origins and unchecked limits. It never reverts an earlier
  rollback to restore removed changes. A clean, successful report offers **Confirm archive after
  rollback** (two clicks, after switching away from that discussion), or `/archive-rollback <name>`.
  Nothing is archived automatically; existing Archive guards apply. Changed worker state requires
  a fresh report. Reload keeps the report; Restart loses this in-memory confirmation, so request a
  fresh report. The User keeps the final merge into main; no automatic conflict-free rollback is promised.
- The latest failed instruction in a discussion offers **Retry** with the current worker settings, or **Retry with…** to choose a provider and model. The chosen settings remain for later instructions. A retry runs ahead of later queued instructions and tells the worker the original instruction, failure, and commits made since, asking it to inspect the worktree and Git state first. The buttons return if the retry fails. They are not offered for interrupted instructions or brainstorms.
- The worker commits every completed task on its branch, with a message starting with its origin
  in brackets (`[<discussion folder name>]`) and the commit ID in its reply.
  agent-room reports commits without that label. After each turn, agent-room also checks the
  report's format against the task's Git state: `Tested:` (plain, full commit IDs, last non-empty
  line) is required when the task asked to catch up or the worker made a non-merge commit of its
  own, with no merge pending, `main`'s starting commit in `HEAD`, and `main` unchanged during the
  task (rollback tasks stay unchecked); `Docs:` (before any `Tested:` line) is required when the
  worker made a non-merge commit of its own. When a check fails, agent-room logs `Format check: …`, records a
  fingerprint of `HEAD`, the index, tracked working-tree files and untracked files, and asks the
  same worker session once for a complete corrected report with no new work (both replies and
  their usage stay visible in the Worker tab and transcript; if the retry changed files or `HEAD`,
  the changes are kept, the checks and `Tested:` recording re-run on the new state, and auto dev
  pauses for review; if the retry still fails, the report goes back to the discussion with its
  problems listed). Each instruction in the Worker tab shows its origin, and its reply goes back
  to that discussion's transcript.
- Before each discussion round, including one started by a worker report, a single chat and
  transcript notice lists other origins' completed labelled commits and changed files not yet
  reported to that discussion. Switching to it starts no agents and adds no notice. The record
  of notices survives Reload; Restart starts a fresh in-memory record.
- Defer refuses a discussion whose branch `worker/<name>` has commits absent from `main`'s
  history, or with `[origin]` commits on `worker/main` absent from it; a normal merge into main
  clears that guard (squash merges are outside this feature).
- **Leftover edits:** agent-room checks a worktree after each of its tasks and again before the
  next. If a task leaves uncommitted edits, that worktree's queue holds (other discussions' go on)
  and its origin is told; only that origin's own
  instructions go through (to finish and commit them, or to abandon them), with the first task's
  details. That discussion can't be archived or deferred meanwhile (Close is allowed as **Close with pending work**, leaving the edits and queue hold intact for rework later). Uncommitted edits of
  unknown origin hold that worktree's queue until it is clean (commit or remove them yourself); they
  are never given to a new task. Before starting work, agent-room saves the origin, full task text
  and starting commit in the worktree's private Git directory (never committed). Recovery keeps
  that original record until the folder is clean. After Restart it holds for that origin if it
  still exists; a missing or invalid record holds as unknown.
- Without a Git repository, or in one with no commit yet, the worker is disabled:
  "Worker requires a source Git repository for its isolated worktree." Discussions work as usual.
- The worker keeps scratch notes in `.worker-notes/<task>/` inside its worktree. Git ignores them
  (`.gitignore` here, and the repository's local `info/exclude` for any project); they are never
  committed, and the worker deletes them when you tell it "stage accepted". Plain **Close** of an
  already-merged, clean branch also removes `.worker-notes/` along with every other gitignored file
  when it removes the worktree.
- A worktree separates working copies; it is not a sandbox (see below).

## MCP service (Hermes)

`src/mcp.mjs` provides a read-only MCP service over stdio (`node src/mcp.mjs`) for local clients
such as Hermes Agent. Whenever a server opens a room, it records the room's canonical root folder
in `~/.local/state/agent-room/rooms.json` (never removing entries automatically). The service
exposes two read-only tools:

- `list_rooms`: lists saved rooms (skipping folders that no longer exist) plus rooms open on the
  running local server (its `/__health` and per-room health endpoints on `127.0.0.1`, port `5566` by default), with each room's
  running status and active discussion.
- `list_discussions(root)`: lists open dated folders in `discussions/` and `brainstorms/` (not
  `discussions/archive/` or `discussions/deferred/`) without reading file contents, and marks the
  active discussion or brainstorm when that room is running on the server.

To register it in Hermes, add an entry under `mcp_servers` in `~/.hermes/config.yaml` (set `env.AGENT_ROOM_PORT` if your server runs on a port other than `5566`):

```yaml
mcp_servers:
  agent-room:
    command: node
    args:
      - /path/to/agent-room/src/mcp.mjs
    env:
      AGENT_ROOM_PORT: "5566"
```

## Access and limits

Agents have full filesystem access. Keeping brainstorming output inside the active discussion
is an instruction, not a sandbox. The worker may edit files and run commands where you ask.

Claude discussion agents and workers get pre-approved Bash, file tools, web search/fetch,
sub-agents, skills, and the allowed look-and-click Chrome tools.
Claude uses strict MCP configuration rather than your claude.ai connectors. Codex discussion
agents and workers run without a sandbox and with live web search configured. Agy discussion agents
and workers use `--dangerously-skip-permissions`; Agy also loads its own local instructions. Its
rulebook is prefixed to the first prompt and sent again when it changes.

The server listens on `0.0.0.0`: devices on the LAN can open its printed IP address and
send instructions to local agents. This version has no authentication; use it on a trusted LAN. Browser input endpoints require the room's own origin
when supplied and JSON requests. The **Terminal** service is for this computer only: its token
and WebSocket requests are refused unless they come from a loopback address, name the server
as `localhost`, `127.0.0.1` or `[::1]`, and (for the WebSocket) carry a matching Origin and the
server's random token, as in ghostty-web's demo server. It runs with your account's rights, like
the agents; any program on this computer that sends those headers can reach it. The **My notes**
service's requests get the same loopback, Host and Origin checks (without a token), and its changes
must be JSON. There is no remote stop,
automatic recovery after a crash (Resume each discussion from its checkpoint), streaming reply
display, or live app preview. Discussion-to-worker relay exists only as auto dev
(above), started from the screen; merging the worker's branches stays manual.

## Working on the project

Read [AGENT.md](AGENT.md) for contribution rules and [docs/architecture.md](docs/architecture.md)
for the design. The agent rulebooks apply only to agents
started by the room in their respective roles; they are not instructions for someone editing
agent-room's source.

| Source | Responsibility |
|---|---|
| `src/cli.mjs` | Arguments, the server's rooms, each room's context and input queue, Reload, Restart, Quit room and Shutdown. |
| `src/agents.mjs` | CLI processes, the record of programs and its leftovers, session resumption, model arguments, title generation and usage parsing. |
| `src/instructions.mjs` | The prompt catalog: every instruction sent to the discussion agents, the worker, the closing-statement agent and the title-generation call; the one source the runtime and the Instructions page (on the Control bar) both read. |
| `src/room.mjs` | Discussion turns, unseen messages, passes and summary agreement. |
| `src/ui.mjs` | Room setup, persistent defaults, commands, discussions, worker queue, logging and launch integration. |
| `src/lanes.mjs` | Worker worktrees, Git snapshots, merge/discard/catch-up actions, worker information, test reports and branch diagrams. |
| `src/docs.mjs` | Reloadable document and screen HTTP facade. |
| `src/docs-files.mjs` | Document rendering, viewer page and room file helpers. |
| `src/docs-routes.mjs` | Room screen and input HTTP routes. |
| `src/docs-http.mjs` | Document, file and library HTTP routes and terminal picker. |
| `src/docs-next.mjs` | Room page and asset serving and build version. |
| `web/` | React and TypeScript room page, styles, component tests and Vite build configuration. |
| `src/screen-events.mjs`, `src/contract.d.ts` | Live event helpers and the page’s SSE contract. |
| `src/host-shell.mjs` | The Terminal service's shell: token endpoint, WebSocket, host-only checks and shell lifetime. |
| `src/notes.mjs` | The My notes service's storage and endpoints: list, read, create, save and remove, with the Terminal's host-only checks. |
| `src/replicate.mjs` | Separate discussion Git storage, pairing, background transfer and immutable received snapshots. |
| `src/usage.mjs` | Token accounting, optional quota-meter data and the providers' login status. |
| `src/mcp.mjs` | Read-only MCP stdio service (`list_rooms`, `list_discussions`) for local clients such as Hermes. |

Run `npm test` for the fast suite and the TypeScript check of opted-in JavaScript, `npm run test:slow` for the slow suite, or `npm run test:all` for both. Tests exercise provider arguments with fake runners, round logic, HTTP endpoints,
settings persistence across CLI restarts, and screen/terminal coordination; they do not establish
live provider access or browser appearance.

Edits outside `cli.mjs`, `host-shell.mjs` and `notes.mjs` can be loaded with Reload; all rulebooks are reread too. A failed load
leaves the previous code running. `cli.mjs`, `host-shell.mjs` and `notes.mjs` changes require Restart. The browser page is built from `web/`; after a Reload, open pages refresh when the built assets changed.

**Dev mode** (`--dev`, part of `npm start` and so of the Dock app) reloads by itself whenever a
module in `src/` or a rulebook is saved, as if you had pressed Reload: the conversation continues,
and the page refreshes only when its own code changed. Dev mode also builds the React shell in the background at startup and rebuilds it when files under `web/` change. `npm run build:web` builds it manually; direct `node src/cli.mjs` builds it before startup when the build is missing or older than the web sources. A failed build is reported and does not prevent the room from starting; without the build dependencies a missing build remains unavailable. The React page is served at `__room` in each room; `__next` redirects there, and its assets use room-relative `__next/` addresses. It shows the room title, messages, agent errors, thinking, busy and turn status from the room event stream. Its composer sends messages and attachments; recognized file mentions offer a Show request. `/peek <board>` displays closed chat and files read-only, with Back to current. Selected files open in the existing document viewer, including files chosen while peeking; non-Markdown documents refresh when their files change. Viewer points become removable composer chips, and message references highlight the shown document. The conversation and document pane can be split side by side or stacked, resized, and closed or reopened; their layout is saved per room and board, with temporary changes while peeking or viewing. Explorer shows the discussion or room checkout as a file tree, including read-only Peek files; `/docs` opens it. The Boards panel lists discussions, workbenches, research, brainstorms and archived or deferred boards, with switching and closed-board Peek. Board rows show their state, worker warnings and research details, refreshing worker information on return and panel expansion. Discussion and brainstorm ordering is saved per room and supports dragging and Move up/down. New discussion, brainstorm and research controls use the first message to name the board, with Cancel while creation is pending. Actions includes Summarize, New research, board conversion and Close with their confirmations. Board row menus provide Resume/Continue, Peek, Close, Archive, Defer, Make active and ordering; row actions include Start fresh, conversions, Delete and rollback with confirmations. Close and Merge and Close and Discard use preview and confirmation flows; Catch up queues a worker task directly. Cancel close is available while Close waits. The Worker tab shows reports and live worker updates and has a text-only composer; New workbench is available in Boards and Actions. Worker reports link and offer mentioned files; failed reports offer Retry and Retry with a provider and model choice. Auto dev shows its current phase and Start or Restart controls, and the Worker tab offers confirmed stop controls. The Worker tab shows the worker information line, with collapsible lanes, merge previews and branch diagrams. An Activity area above both tabs shows the latest two system messages (Worker notes and errors prefixed `Worker ·`), the pinned agent error and busy workers. Both chats follow new messages while scrolled to the bottom and offer a scroll-to-end button otherwise; the Worker chat keeps its place when switching tabs. The header has the room menu (Quit room) and the server menu (Reload, Restart, Shutdown server), with the same second clicks and the confirmation listing rooms still running; the server dot and its details follow the 3-second heartbeat, and the quota gauges show each provider's health warnings. The room menu also has Switch room… (this server's rooms, to switch this tab or open a new window) and Open room in folder…; Peers… lists the replication peers with Pair, an amber ⚠ beside the server dot counts unreachable peers, and hovering the room name shows its folder and replica line. Boards lists lines received from peers: Peek files browses their received files, and View chat shows a peer's chat read-only until Back. Only one header, Actions or row menu is open at a time. Room switches and new rooms open their `__room` page. The Discussion tab's members panel and the Worker tab's settings panel choose provider, name and model (including custom model IDs): before a discussion starts it has two or three members; once started it lists its members read-only with On boxes. Saves from both panels run in order, and Retry with… waits for them. Failed or disabled agents offer Disable or Enable. A services bar opens a panel beside the board, folding the Boards list until it closes (divider drags made meanwhile aren't saved). On a page opened on this computer it offers My notes: list, read, create, save and remove, asking before unsaved changes are dropped (inside the panel, before following a Boards link or switching room) and before leaving the page; a refresh after a code change keeps the unsaved note. On such a page it also offers the Terminal: opening it the first time starts a shell in the room's folder through `host-shell.mjs` (its token, then the WebSocket) in the ghostty-web pane; closing or switching the service keeps the shell running (a green mark on its button), reopening or moving the divider refits it, and End shell / Start shell end it or start a fresh one. The services bar also offers Providers (the default members and worker for new discussions in every room, saved through the same queue as the tabs' panels, and Provider health with its ⚠, Check now and prompt tests; clicking a provider name in the header gauges opens it), Instructions (the prompt catalog, read-only) and Schedule (the quota floor and scheduled research tasks, refreshed by the room's schedule event while shown). The Document bar names the shown file by its board (with its folder's other files in a ▾ menu, Send to agents on an earlier session's transcript, and Follow mentions), and the browser tab is named after it. The page uses `web/src/legacy.css` and `web/src/layout.css` for its layout: the three header zones, the services rail, the Boards panel, the discussion header with its status line (on the Worker tab the worker's state, and the closing phase), the chats and composers, and the Explorer / Document side pane. Root `/__next` redirects to the first room’s `/__room`; room-specific `__next` bookmarks redirect to that room’s `/__room`. Builds write a staging directory first and swap it into `web/dist/` only on success; a build failure is reported without stopping the existing room. During the two-rename swap, an external build can briefly leave the directory absent and a request can receive a missing-build response. Old assets are not kept: an open page can receive a 404 for an old asset after a rebuild. A separate web-version field on the room event stream refreshes it after a dev rebuild or Reload when the build changed; if that signal is missed before the page connects, reload manually. Saving `cli.mjs` shows a reminder to
Restart instead. Saving `host-shell.mjs` or `notes.mjs` also needs Restart, but the save fires a
reload that silently leaves those two modules unchanged, with no reminder. Restart keeps dev mode. Saves by anyone count, including the worker's or another
agent's edits to agent-room itself, and a `git merge` into the checkout the server runs from; a
half-finished save that doesn't load leaves the previous code running.

### How hot reload works

agent-room is split into a part that never reloads and a part that reloads wholesale. The part
that never reloads is `src/cli.mjs`: it owns the arguments, the server's rooms, each room's
context (`ctx`) and input queue, and the Reload, Restart and Quit commands; changes there need
Restart. The reloadable part is `src/ui.mjs` and the modules it loads, which Reload swaps between
rounds.

The swap works around Node's module cache. A static `import './ui.mjs'` is cached forever, so an
edited file would keep exporting its old values. Instead `cli.mjs` loads ui.mjs with a dynamic
import that carries a fresh query string, `await import('./ui.mjs?v=<millis>')`: the `?v=` makes
each load a different module to the loader. The tag is `Date.now()` at every Reload (and each
room's first load), so each reload is a fresh module. `ui.mjs`'s `load()` then imports the other
modules with the same tag — `instructions.mjs`, `agents.mjs`, `room.mjs`, `docs.mjs`, `usage.mjs`,
and `replicate.mjs` under `--node` — so the whole set comes in fresh together. `load()` also loads `lanes.mjs` with the same tag for worker worktree and Git helpers. `docs.mjs` forwards its tag to `screen-events.mjs`, `docs-files.mjs`, `docs-routes.mjs`, `docs-http.mjs` and `docs-next.mjs`, so those helpers and routes reload too. The runtime path
never uses a static import for these, because a static import of a local module stays cached and a
reload would silently miss it.

Two modules are excluded by that rule and need Restart like `cli.mjs`: `host-shell.mjs` and
`notes.mjs`, the Terminal and My notes services. They are statically imported by `docs-routes.mjs` (and the upgrade export by `docs.mjs`) without a
version tag, so a reloaded `docs.mjs` still resolves them to their cached instances: the tag
applies only to the module it is written on, never to that module's own static imports.

What must survive a reload is not in a module at all: it lives in each room's `ctx`, owned by
`cli.mjs`, so it is untouched by which module version is current — the conversation state (the
transcript and seen-message positions), the provider sessions, the transcript file path, the
viewer server and its clients, the worker queue and worktree, and the usage totals. `load()` builds
a fresh room on top of the existing `ctx` and returns only the parts that can change; `cli.mjs`
merges them back with `Object.assign`. A load that fails throws before anything is merged, so the
previous code keeps running and the rooms report the error.

The agent rulebooks are not modules. They are layered `.md` files (`rulebooks/citizenship.md`,
`rulebooks/group-chat.md` and `rulebooks/discussing.md` joined for discussion and brainstorm agents;
`rulebooks/citizenship.md`, `rulebooks/group-chat.md` and `rulebooks/researching.md` joined for
research board agents; `rulebooks/citizenship.md` and `rulebooks/worker.md` joined for the worker)
reread from disk with `readFileSync` on every load, so an edit to any layer is picked up by the
same Reload with no cache-busting.

The prompt templates in `instructions.mjs` need the same freshness, but the turn logic in
`room.mjs` and `agents.mjs` calls them through a static default import. The two are bridged by a
default-parameter pattern: `createRoom(agents, state, instr = defaultInstructions)` and
`claudeTitle(..., instr = defaultInstructions)` take the instructions as an argument. `ui.mjs`
loads the version-tagged copy (`const instr = await import('./instructions.mjs?v=…')`) and passes
it in, so the prompts reload with everything else, while the static import serves only as the
fallback for the Instructions page when no room has loaded a copy yet.

Reload itself is a message through the input queue. `/reload` (and dev mode's watcher) imports the
new `ui.mjs` once, swaps it into `cli.mjs`'s `ui`, and pushes `{ reload }` into every room's
queue. Each room applies it between its own rounds, never mid-turn: a room busy in a discussion
finishes the round with the code it started with, and only the next round uses the new code. The
browser page is built separately from `web/`; Reload compares its built-asset version and refreshes
open pages when it changes, keeping what was typed.

Dev mode (`--dev`, part of `npm start`) wraps this in a watcher: `fs.watch` on `src/` for `.mjs`
files and on `../rulebooks/` for `.md` files, debounced 300 ms so an editor's burst of save events
collapses into one reload. A save to `cli.mjs` is not reloaded — the room prints "Restart to apply
it" — because the one file the watcher cannot swap is itself.

For unfinished decisions, historical designs and deferred research, start at
[the discussions index](discussions/README.md).
