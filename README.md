# agent-room

agent-room is a collaboration platform for a human and several AI agents. You and the agents
discuss and revise ideas around shared documents and drawings, with the conversation and its
subject visible together, and a separate worker agent carries out your instructions in its own
Git worktree. It is domain-agnostic: a room is any folder, holding any kind of work. Agents run
through your installed Claude Code, Codex and Antigravity (`agy`) CLIs, using their existing authentication and
subscriptions.

The project stays deliberately small: ten source modules and four dependencies: `marked`, and for
the Terminal pane `@lydell/node-pty`, `ws` and `ghostty-web`. How it works (the two harnesses,
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
(hover for how many); click it to open **Peers…**. **Current discussion** (green): on the left, the selected
discussion's or brainstorm's title (**New brainstorm** before a brainstorm's first message), or **No discussion started**, with its state under it (who is thinking, or your
turn); **Actions ▾** holds **Summarize**, **New discussion**, **New brainstorm**, **Turn into a discussion** (when a
brainstorm is shown), **Close** (**Close with pending work** when the worker branch has unmerged commits or uncommitted edits; **Close brainstorm** for a brainstorm), **Close and Merge** (or **Catch up with `<branch>`**, when the discussion's branch has commits not in the room's current branch), and **Close and Discard** (when discarding would lose commits not in the room's current branch, tracked edits, or untracked files); on the right, every open discussion whose worker is working is listed, one per line,
as `<title> · Worker is working` (the shown discussion included). **Monitoring** (amber): the monitor panel, with the subscription usage gauges
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
only with Check now. Leftover checks continue at their usual interval; opening the tab does not run
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

- **Discussion:** send messages to the brainstorming agents. Enter sends; Shift+Enter adds
  a line. Start with `@name` to address one agent. Agents take turns in the configured order,
  stopping when everyone passes consecutively, a turn fails, or the lap cap is reached (10 laps in a
  discussion, 20 in a brainstorm; one lap is each selected agent speaking once).
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
- **Discussions**, **Brainstorms**, **Explorer** and **Document** (right pane, four tabs):
  - In **Brainstorms**, the room's brainstorms, each by its title, in your order (drag the ⠿ handle,
    or **Move up** / **Move down**; kept in this browser per room, apart from the Discussions order;
    new ones go on top). **Resume** (**Go to** for one open in another window's context), and in
    **Actions**: **Close**, **Turn into a discussion**, **Start fresh**, **Delete** (two clicks; it removes
    the folder, transcripts and drawings included, and the checkpoint: uncommitted files are lost for
    good; disabled while the brainstorm is open). No Archive or Defer. Clicking a title shows its
    files in Explorer, as for a discussion.
  - In **Discussions**, browse discussions (the active one first), check their state, and manage them (Resume, Go to, Archive, Defer, and actions menu). Archived and deferred discussions are kept in their own sections; received discussions from peers show **Peek files** and **View chat** buttons. Rows show state and actions only, no inline files. A row whose worker branch has work not yet in main says so in amber under its state, such as **⚠ Worker: 2 commits not merged into main · uncommitted changes**; `worker/main`, or a branch whose discussion isn't in the active list, gets such a line above the list. A row with nothing pending says **no changes** in its state. These come from the Worker tab's checks, made again after each worker task and whenever the Discussions or Worker tab is clicked.
  - In **Explorer**, view one tree at a time, chosen with the bar `[ Discussion | Room checkout | Worker copy ]` (Worker copy is coming soon). Under the bar, a line shows the folder and branch. **Discussion** shows the active (or peeked) discussion's files. **Room checkout** shows the room's root checkout, excluding hidden and gitignored files (non-discussion files in `discussions/`, such as `discussions/README.md`, remain reachable). Code, config, and other text files open as plain text in Document; supported images and PDFs stay viewable; files that cannot be displayed are greyed out ("can't be shown here").
  - **Peek**: clicking another discussion's name in Discussions shows its files in Explorer without switching discussions. An orange banner ("Looking at <name> · Back to current") and an orange dot on the Explorer tab indicate the peek; Document's path line names the peeked discussion.
  - In **Document**, view the chosen file with its path. Each tab keeps its place when you switch; Document is disabled until a file is chosen. The chosen document stays selected when agents edit other files, and open documents check for changes every two seconds. Drag the divider to resize the panes. Browsing is available during agent turns and does not notify the agents.
  - **Tables and pointing.** A ```` ```csv ```` block in a Markdown document shows as a table with
    column letters and row numbers (```` ```csv runs ```` names it `runs`). A cell starting with `=` is a
    formula: cell references, `+ - * /`, and `SUM`, `AVERAGE`, `MIN` or `MAX` over a range (`=SUM(B2:B8)`);
    errors show as `#REF`, `#CYCLE`, `#DIV/0` or `#VALUE`. Click a cell to point at it: a chip appears by
    the message box, and your next message ends with one `[pointing at: …]` line naming the cell, its value,
    its row and column labels and its formula (✕ on a chip drops it; commands never carry it). A
    `[[D4]]` or `[[runs!D4]]` in the chat highlights that cell in the shown document while you hover it.
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
- **Terminal** (below Explorer/Document, collapsed): a shell on this computer, in the room's
  folder, shown with [ghostty-web](https://github.com/coder/ghostty-web). Opening it starts a
  fresh shell; collapsing it, reloading the page or stopping the server ends it. It appears only
  in pages opened on this computer (`127.0.0.1` or `localhost`); see **Access and limits**.
- **Notes** (in the same place, collapsed; only one of Notes and Terminal is open, so opening
  Notes ends the shell): your own free-text notes for this room's folder. **New**, a list of
  notes (title and last-saved date), and an editor with **Save** and **Remove**; a note's first
  line is its title. A note is saved only by **Save**; **Remove** asks inside the pane first.
  Unsaved changes are never dropped without asking: the pane asks before another note, New,
  collapsing it, opening the Terminal or switching room in this window; leaving or reloading the
  page gets the browser's leave-page warning, and the automatic refresh after a code change keeps
  them. Notes are Markdown files in `~/.local/share/agent-room/notes/<hash of the room folder>/`,
  one per note, named by time and random letters (never the title): never in the room's folder,
  never replicated, and the agents are not told about them. Like the Terminal, only in pages opened on this
  computer.
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
with no Resume button.

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

**Archive and deferred.** Each local discussion row in **Discussions** has **Archive** and **Defer**
buttons (or `/move <folder-name> archive|deferred`), which move the whole discussion, documents and
transcripts, into `discussions/archive/` or `discussions/deferred/`; **Make active**
(`/move archive/<folder-name> active`) moves it back. `archive/` and `deferred/` are created when
first needed, and always listed at the bottom of **Discussions**, after the active discussions.
Archive and Defer require a closed discussion, with the reason in a tooltip. Make active leaves it
closed until Resume. New discussion names also skip names already
taken in `archive/` and `deferred/`.

**Sessions.** The word has two meanings here. A **provider session** is one continuous
conversation with an agent's or the worker's CLI (Claude Code, Codex): what was said, read and
replied in it, as the provider keeps it (it may compact older turns). The provider stores it on
this machine (Claude Code under `~/.claude/projects/`, Codex in its own folder); agent-room keeps
only its ID, in the discussion's checkpoint (below). Resume of a paused discussion hands the same
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
discussion, the one what you type goes to, and the task's report still goes back to its own. One window shows one of them; Discussions marks the others "open". **Resume** shows an open one as
it is, during a round too: its agents carry on, nothing is restarted. An open discussion that hasn't started (no message
yet) has **Go to** instead, which only shows it. **New discussion** and **New brainstorm** open the new
one beside the one in use, which stays open (in place, when the one in use hasn't started). Resume
and Start fresh open any other discussion or brainstorm beside the open ones; several brainstorms
can be open at once. **Close** (in **Actions ▾** and each row's menu in **Discussions**, or `/close`) is labelled **Close with pending work** when the discussion's worker branch has commits not in main or uncommitted edits, and also works on a paused
discussion's row. When the discussion has a worker worktree or branch that is already merged (no commits outside the room's current branch) and clean (no tracked edits, no untracked files and no Git operation in progress), plain **Close** cleans up the worktree and branch automatically under the room-wide lock (`git worktree remove --force`, `git branch -d`, clearing the lane's hold and saved worker session) and appends `Worker worktree and branch removed (already merged).` to `closing-statement.md`. This cleanup treats every gitignored file in a merged worker worktree (including `.worker-notes/` and `node_modules/`) as transient and removes it with the worktree. If cleanup fails partway or another merge/discard holds the lock, the discussion still closes and reports what was and wasn't removed in the room and in the closing statement. Otherwise, **Close with pending work** keeps the worker branch and worktree exactly as they are (branch, commits, uncommitted, untracked and ignored files) for rework later. It refuses new worker instructions and waits for its queued and running tasks;
while waiting the row says **closing, waiting for worker** and offers **Cancel close**. Tasks queued behind an unresolved-edits hold can never start, so Close refuses at once and names them instead of waiting. A one-off
agent with the provider and model set in that discussion's **Worker · provider & model** panel
(not the discussion agents, nor the worker's own session) then reads the discussion's notes and
transcripts and writes a closing statement pointing to `pending-instructions.md` (the system messages name its provider and model, when it starts and when the discussion is closed); when the branch has pending work, agent-room appends `Worker work pending on <node or host>: \`worker/<name>\`, N commits not in main, uncommitted edits: yes/no, worktree \`<path>\`.` to `closing-statement.md`. agent-room writes the one
current `closing-statement.md`, ends the sessions and marks the discussion closed. Unresolved worker
edits do not prevent Close: the worktree's queue hold stays as it is, and resuming the discussion later finds the edits still there. **Close and Merge** (beside Close in **Actions ▾** and each row's menu in **Discussions**, shown when the discussion's branch has commits not in the room's current branch) merges `worker/<name>` into the room's current branch, cleans up its worktree and branch, and closes after two clicks: it is greyed out with the reason in its tooltip while the worktree has uncommitted edits or is mid-merge/rebase/revert, a worker task is running or queued, the room is on a detached HEAD, mid-operation or has tracked edits outside `discussions/`, the merge preview is not clean, or the worker has not recorded a passing `Tested:` line for the current tips. When the room's branch has moved ahead of `worker/<name>`, it offers **Catch up with `<branch>`** instead, sending the worker a catch-up task and stopping so you can review the report before clicking **Close and Merge** again. The first click names the target (`Merge worker/<name> into <branch>`), lists the commits to merge and the untracked/ignored files cleanup will delete, shows an informational notice of any other discussions in a round, running/queued worker tasks, or other branches with unmerged commits (omitted when nothing else is active and no other branches have unmerged commits; never blocks the merge or invalidates the second click), and snapshots the state; the second click re-checks everything, runs `git merge --no-ff` under a room-wide lock shared with **Close and Discard** so only one merge or discard runs at a time across the room (a second request refuses immediately, naming the operation in progress; on conflict, the merge is aborted and everything stays open), removes the worktree (`git worktree remove --force`), deletes the branch (`git branch -d`), clears the lane's hold and saved worker session, and closes with `Worker work merged into \`<branch>\` as \`<merge commit>\`.` in `closing-statement.md`. **Close and Discard** (beside Close in **Actions ▾** and each row's menu in **Discussions**, shown only when discarding would lose commits not in the room's current branch, tracked edits, or untracked files) closes the discussion and deletes its worker worktree and branch after two clicks (sharing the same room-wide lock with **Close and Merge**): it refuses while a worker task for the discussion is running or queued, or while its worktree is mid-merge, mid-rebase or mid-revert; the first click lists commits not in main, tracked edits, untracked files, and ignored files summarised by top-level folder and snapshots them; the second click re-checks the snapshot (asking again if anything changed), saves any unmerged commits to a unique `refs/discarded/<name>/<YYYYMMDD-HHMMSS>` ref (commits only, not uncommitted or ignored files), removes the worktree (`git worktree remove --force`), deletes `worker/<name>` (`git branch -D`), clears the lane's hold and saved worker session, and closes the discussion with a `Worker work discarded: …` line in `closing-statement.md`. If any step fails partway, it stops, leaves the discussion open, and reports what was and wasn't done. If Close fails or is cancelled, the discussion stays open or paused and
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

**New brainstorm** (in the header's **Actions ▾** menu, or `/brainstorm`) starts a conversation with
the same agents, turns and `PASS` rules. Its first message gets a title from Claude and a folder,
as a discussion's does, but under `brainstorms/` at the root: `brainstorms/<date>-<title>/`, holding
`transcripts/`, `drawings/` if the agents draw, and `files/` if you attach files. A name is never one already taken in
`discussions/` (`archive/` and `deferred/` included), nor a discussion's one taken in `brainstorms/`.
It saves checkpoints like a discussion (below), under the key `brainstorms/<name>` and with no worker
part, so Resume (`/resume brainstorms/<name>`), Close and Restart work as for discussions. The agents
are told it is a brainstorm: they write nothing except drawings in its `drawings/`, may read the
project, and propose turning it into a discussion when something else tangible is wanted. A
brainstorm sends no work: while one is shown, the Worker tab says "Turn this brainstorm into a
discussion to send work." and refuses instructions; there is no auto dev or automatic
summary (manual **Summarize** works), and the lap cap is 20. Brainstorms are not replicated to
peers. Typing in a room with no discussion still starts a discussion.

**Turn into a discussion** (in **Brainstorms** or **Actions ▾**, two clicks; `/convert
brainstorms/<name>`) moves `brainstorms/<name>/` to `discussions/<name>/`, never over an existing
folder (checked as it moves: then nothing moves), and its checkpoint to the discussion's key. The
agents keep their sessions: each is told once, in its next prompt, the new folder and that the
discussion rules apply from then on (an open one carries on at once; a closed one, at its Resume).
The worker starts fresh at the discussion's first task. **Start fresh** on a brainstorm (`/fresh
brainstorms/<name>`) starts new agent sessions briefed from its latest summary (marked when it
wasn't agreed) or, with none, pointed at its `transcripts/` to read first, as the source that a
summary may leave details out of. **Delete** (`/delete brainstorms/<name>`) refuses an open brainstorm.

**Every discussion saves itself.** After every round (with or without its summary), every
`/summary` and every worker task, and when its session ends (Close, New discussion, Quit room,
Restart), agent-room saves the discussion's checkpoint on this machine: the provider session IDs
of its agents and its worker, its chat and unread-message positions, its own entries in the Worker
tab, its provider/model choices and usage totals. The discussion part is as of the end of its
latest round. Checkpoints are private local files under `~/.local/state/agent-room/paused/`,
separated by root folder; they are not replicated to peers. Close removes the saved provider IDs;
the closed flag is persisted separately. Discussions from before this flag, and open discussions
left behind by a restart, are paused. Discussions rows show current, open/paused, not started,
paused or closed, as appropriate; archived and deferred rows also show closed when applicable.

**Resume** (on a discussion's row in **Discussions** or on its page, or `/resume <folder-name>`), for
any discussion not on screen, works between rounds:
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

**Start fresh** (in a row's **Actions ▾**, or on the discussion's page; two clicks; `/fresh
<folder-name>`) discards the saved sessions and chat: new agent and worker sessions start from the
closing statement (or pending handoff if there is no statement) and notes, briefed with the checkpoint's latest summary, marked when it wasn't agreed (none
without a checkpoint). Until the fresh session's first round, a small checkpoint holds only that
summary, so a Restart or Resume in between still briefs with it. Old conversations are not replayed.

`/pause`, `/reopen`, `/continue` and `/autosummary` are no longer commands: they answer with a
hint instead of reaching the agents.

Looking at another discussion does not switch the one in use (marked "in use" in the list); only Resume and Start fresh do. Display-title
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

The **Providers** tab (beside Discussion and Worker) holds the defaults for new discussions, the
members and the worker together, and is shown first when a new discussion opens (**Go to the
discussion** returns to the chat). Before the discussion starts, its changes apply to it too; after,
they change only the defaults (for new discussions in this room and every other), never the running
agents or worker. Below the settings, the Provider health section is folded until opened; the whole
tab scrolls as one column. The two tabs' own panels below work as before.

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
**Agreed**, **Not agreed**, **Next step** and **Later**, leaving out empty sections, with at most
eight points under Agreed and Not agreed. **Next step** holds exactly one action for you: `Answer:`
a question, `Send to the Worker: "…"` with the instruction word for word (or, for a long one,
`Send to the Worker:` alone on its line followed by the instruction as a `>` block quote), or
`Do:` an action of your own; **Later** lists the remaining actions in order. An instruction for the worker is kept until
you say it was sent, replaced or withdrawn. In a discussion, under Later it is referred to by
name, with its full text in the discussion's `pending-instructions.md`; in a brainstorm, where
agents write no notes, this applies to discussions only (see below). The format and what the code reads from it are
in [the summary contract](docs/architecture.md#summary-contract). The drafter rotates between summaries. Writing
or revising counts as accepting that version; every other agent must pass on it for agreement.
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
there is a deliberate retry. The run pauses, with its reason above the message box, on `WAIT FOR
USER`, an unagreed summary, a failed discussion turn, a message you type in either tab (a running
worker still reports, but nothing more is sent), or when the cycle limit is reached (failed attempts count;
the last report is still reviewed). When paused, the next agreed instruction is shown with **Restart
auto dev**, which starts a new run. A summary can put `Steps left: N` immediately before its Outcome line to set the limit from the plan, including the step being sent; the limit rises only when the count rises (to cycles used + N + 2, at most 15); otherwise it stays or falls, so fix rounds use up its slack. This is a guardrail, not a cost cap: a corrected count can grant more cycles. While paused, any summary asks for `Outcome: FINISH`
or `WAIT FOR USER` instead, and sends nothing. An agreed `FINISH`, running or paused, ends the run:
review and merge the discussion's branch (`worker/<name>`) yourself, as ever. An instruction that can't be read reliably from Next step (two of them, no
closing quotation mark…) is never sent, and the page says why. Reload keeps a run, its cycle count, a failure pause and its retry buttons,
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
| `/resume <folder-name>` | Show an open discussion, continue a paused checkpoint, or reopen a closed discussion with fresh sessions from its closing statement. `archive/…` or `deferred/…` is made active first; `brainstorms/<folder-name>` resumes a brainstorm. |
| `/fresh <folder-name>` | Start fresh: new sessions there, from its closing statement or pending handoff, notes and its checkpoint's latest summary; the saved sessions and chat are discarded. `brainstorms/<folder-name>`: from its latest summary or its transcripts. |
| `/new` | On the screen, open a new discussion beside this one (which stays open). In the terminal, end this session; your next message starts a new discussion. Its worker tasks finish in its own worker session; the new discussion's worker starts fresh. |
| `/close` | Close the discussion shown; `/close <folder-name>` also closes a paused one. Waits for its worker, writes a closing statement (appending a pending-work line if the branch has unmerged commits or uncommitted edits), and keeps the worker branch and worktree intact (refuses immediately if tasks are queued behind an unresolved-edits hold). |
| `/brainstorm` | Start a brainstorm (on the screen beside this one; in the terminal, ending this session). Its first message names it in `brainstorms/`. |
| `/convert brainstorms/<folder-name>` | Turn into a discussion: the folder moves to `discussions/`, the agents keep their sessions and are told. |
| `/delete brainstorms/<folder-name>` | Delete a closed brainstorm's folder and checkpoint, for good. |
| `/rollback <folder-name>` | Queue Archive with rollback as a worker task; review its report before archiving. |
| `/archive-rollback <folder-name>` | Explicitly confirm archive after a successful rollback report (switch away first). |
| `/move <folder-name> active\|archive\|deferred` | Move a closed discussion into `archive/` or `deferred/`, or move it back to active without reopening it. |
| `/summary` | Request an agreed summary. |
| `/autodev` | Start (or restart) auto dev from the latest agreed summary's worker instruction. |
| `/usage` | Show session tokens and subscription quotas. |
| `/reload` | Reload source modules and both agent rulebooks; retain conversation and provider sessions. |
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

Received-only discussions appear under **Received from peers · read-only** in **Discussions**, with the peer name, **Peek files** and **View chat**. Mixed discussions keep one local row with **Peek files** and **View chat** for the peer version. **View chat** opens that peer's conversation read-only,
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
    `Tested: <branch commit> with main <main commit>: tests passed|failed` line (recorded only
    if Git agrees: the branch commit is on the branch, it contains the main commit, which is
    main's), and whether either branch has moved since. This is the worker's report: agent-room
    doesn't run the tests itself;
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
  test`, if it has them), report their real output and end with its `Tested:` line. A clash is
  not forced: the worker reports it and that discussion's queue holds for its recovery. An
  unfinished merge or revert holds that queue even if `git status` otherwise shows no edits. The existing
  strictly-behind fast-forward remains; agent-room does not perform a normal merge or revert itself.
- **Merging a branch into main** (via **Close and Merge** in **Actions ▾** or the **Discussions**
  row menu, or by hand in the room):
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
  agent-room reports commits without that label. Each instruction in the Worker tab shows its
  origin, and its reply goes back to that discussion's transcript.
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
when supplied and JSON requests. The **Terminal** pane is for this computer only: its token
and WebSocket requests are refused unless they come from a loopback address, name the server
as `localhost`, `127.0.0.1` or `[::1]`, and (for the WebSocket) carry a matching Origin and the
server's random token, as in ghostty-web's demo server. It runs with your account's rights, like
the agents; any program on this computer that sends those headers can reach it. The **Notes**
pane's requests get the same loopback, Host and Origin checks (without a token), and its changes
must be JSON. There is no remote stop,
automatic recovery after a crash (Resume each discussion from its checkpoint), streaming reply
display, or live app preview. Discussion-to-worker relay exists only as auto dev
(above), started from the screen; merging the worker's branches stays manual.

## Working on the project

Read [AGENT.md](AGENT.md) for contribution rules and [docs/architecture.md](docs/architecture.md)
for the design. The two agent rulebooks apply only to agents
started by the room in their respective roles; they are not instructions for someone editing
agent-room's source.

| Source | Responsibility |
|---|---|
| `src/cli.mjs` | Arguments, the server's rooms, each room's context and input queue, Reload, Restart, Quit room and Shutdown. |
| `src/agents.mjs` | CLI processes, the record of programs and its leftovers, session resumption, model arguments, title generation and usage parsing. |
| `src/instructions.mjs` | The prompt catalog: every instruction sent to the discussion agents, the worker, the closing-statement agent and the title-generation call; the one source the runtime and the Instructions tab both read. |
| `src/room.mjs` | Discussion turns, unseen messages, passes and summary agreement. |
| `src/ui.mjs` | Room setup, persistent defaults, commands, discussions, worker queue, logging and launch integration. |
| `src/docs.mjs` | Local HTTP server handlers, document rendering, browser UI and live events. |
| `src/host-shell.mjs` | The Terminal pane's shell: token endpoint, WebSocket, host-only checks and shell lifetime. |
| `src/notes.mjs` | The Notes pane's storage and endpoints: list, read, create, save and remove, with the Terminal's host-only checks. |
| `src/replicate.mjs` | Separate discussion Git storage, pairing, background transfer and immutable received snapshots. |
| `src/usage.mjs` | Token accounting, optional quota-meter data and the providers' login status. |

Run `npm test` for the fast suite, `npm run test:slow` for the slow suite, or `npm run test:all` for both. Tests exercise provider arguments with fake runners, round logic, HTTP endpoints,
settings persistence across CLI restarts, and screen/terminal coordination; they do not establish
live provider access or browser appearance.

Edits outside `cli.mjs`, `host-shell.mjs` and `notes.mjs` can be loaded with Reload; both rulebooks are reread too. A failed load
leaves the previous code running. `cli.mjs`, `host-shell.mjs` and `notes.mjs` changes require Restart. Browser assets are embedded
in `docs.mjs`; after a Reload, open pages refresh by themselves when they changed.

**Dev mode** (`--dev`, part of `npm start` and so of the Dock app) reloads by itself whenever a
module in `src/` or a rulebook is saved, as if you had pressed Reload: the conversation continues,
and the page refreshes only when its own code changed. Saving `cli.mjs` shows a reminder to
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
and `replicate.mjs` under `--node` — so the whole set comes in fresh together. The runtime path
never uses a static import for these, because a static import of a local module stays cached and a
reload would silently miss it.

Two modules are excluded by that rule and need Restart like `cli.mjs`: `host-shell.mjs` and
`notes.mjs`, the Terminal and Notes panes. They are statically imported by `docs.mjs` without a
version tag, so a reloaded `docs.mjs` still resolves them to their cached instances: the tag
applies only to the module it is written on, never to that module's own static imports.

What must survive a reload is not in a module at all: it lives in each room's `ctx`, owned by
`cli.mjs`, so it is untouched by which module version is current — the conversation state (the
transcript and seen-message positions), the provider sessions, the transcript file path, the
viewer server and its clients, the worker queue and worktree, and the usage totals. `load()` builds
a fresh room on top of the existing `ctx` and returns only the parts that can change; `cli.mjs`
merges them back with `Object.assign`. A load that fails throws before anything is merged, so the
previous code keeps running and the rooms report the error.

The agent rulebooks are not modules. They are `.md` files (`rulebooks/brainstorming.md` and
`rulebooks/worker.md`) reread from disk with `readFileSync` on every load, so an edit is picked up
by the same Reload with no cache-busting.

The prompt templates in `instructions.mjs` need the same freshness, but the turn logic in
`room.mjs` and `agents.mjs` calls them through a static default import. The two are bridged by a
default-parameter pattern: `createRoom(agents, state, instr = defaultInstructions)` and
`claudeTitle(..., instr = defaultInstructions)` take the instructions as an argument. `ui.mjs`
loads the version-tagged copy (`const instr = await import('./instructions.mjs?v=…')`) and passes
it in, so the prompts reload with everything else, while the static import serves only as the
fallback for the Instructions tab when no room has loaded a copy yet.

Reload itself is a message through the input queue. `/reload` (and dev mode's watcher) imports the
new `ui.mjs` once, swaps it into `cli.mjs`'s `ui`, and pushes `{ reload }` into every room's
queue. Each room applies it between its own rounds, never mid-turn: a room busy in a discussion
finishes the round with the code it started with, and only the next round uses the new code. The
browser page is part of the reloaded code (its assets are embedded in `docs.mjs`), so an open page
refreshes by itself when the page's own code changed, keeping what was typed.

Dev mode (`--dev`, part of `npm start`) wraps this in a watcher: `fs.watch` on `src/` for `.mjs`
files and on `../rulebooks/` for `.md` files, debounced 300 ms so an editor's burst of save events
collapses into one reload. A save to `cli.mjs` is not reloaded — the room prints "Restart to apply
it" — because the one file the watcher cannot swap is itself.

For unfinished decisions, historical designs and deferred research, start at
[the discussions index](discussions/README.md).
