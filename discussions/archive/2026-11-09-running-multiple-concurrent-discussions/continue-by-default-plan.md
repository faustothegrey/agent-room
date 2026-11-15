# Plan: continue a discussion by default

Worker, 2026-11-10; revised twice the same day after the User's reviews. A plan only: no code
changed.
Line numbers are from `worker/main` at `42c98c1`.

## The change in one paragraph

Every open discussion saves a checkpoint by itself at the end of every round (with or without a
summary), after every `/summary`, and when a worker task is queued, starts or ends. The checkpoint
is the one Pause already writes (`src/ui.mjs:536` `pauseDiscussion`): the agents' and the worker's
provider session IDs, the chat, the `seen` positions, the transcript path, the shown document and
the worker briefing flags. One button and one command, **Resume** / `/resume <name>`, handle every
discussion that isn't on screen, except a brainstorm and a discussion that is open but not yet
started: those keep **Go to**, which only brings them into view. If a started discussion is
running in the background, Resume only brings it into view. Otherwise Resume continues from the
latest checkpoint, or starts from the handoff if there is none. An archived or deferred
discussion is made active first. Restart, and Quit room followed by Resume, go through the same
path. **Start fresh** / `/fresh <name>` discards the saved sessions and starts new agent sessions
from the handoff, the notes and the checkpoint's latest summary; that summary is kept through a
Restart before the first message (see 4). Pause, Re-open, Go to for started discussions,
`/pause`, `/reopen`, `/continue` and the Auto-summarize toggle go away. Auto-summarize is always on.
The change is complete only when the automatic saving **and** the recovery reporting ((2) and
(3) below) are both in. Merge only after the second commit (see 6).

## Pieces

- **`saveCheckpoint(ctx)`**: the snapshot code taken out of `pauseDiscussion` (`src/ui.mjs:545-560`).
  Two changes: it no longer waits for the worker queue, and it **replaces** the file atomically
  (write a temp file, then `renameSync`). Today it uses `linkSync`, which refuses to overwrite.
  The discussion part (chat, `seen`, `summaries`, session IDs) is captured only at round
  boundaries, when it is consistent. The copy, `ctx.lastRound`, is taken at round end, and every
  write is that copy plus the current worker fields (see 2). Two new fields: `logBytes` (the
  transcript file's size at the moment of that write) and `work` (see 2). Brainstorms get no
  checkpoint.
- **Called from:** the end of `runRound` (after its summary and `saveRound`, `src/ui.mjs:1616-1630`),
  the `/summary` handler (`src/ui.mjs:1469`), `queueWork`, `runWork` (start and end), `endSession`
  (before it clears anything), and `stopRoom` (worker fields only).
- **Where the files live:** the same directory as today (`~/.local/state/agent-room/paused/<root
  hash>/<name hash>.json`), same `version: 1`, new fields optional. Pauses saved today then just
  become checkpoints, with nothing to migrate.

### Resume, Start fresh, Close discussion

- **`/resume <name>`**: one function in place of `reopenDiscussion`, `reopenBeside`,
  `resumeDiscussion` and `resumeBeside` (`src/ui.mjs:567-641`, `:818-832`):
  1. Open in another context of this folder (running in the background): `goto` only, as Go to
     does today. Nothing is sent to its agents, and no session is restarted. (The page shows Go to,
     not Resume, when that context is a brainstorm or hasn't started; `/resume` still just switches.)
  2. Otherwise, with a full checkpoint: load it as `resumeDiscussion` does today. Its checks stay, and
     so does its "build before applying" order. But it **keeps the file** instead of `unlinkSync`
     (`:603`). On the screen, it opens in a context of its own, or in this one if this one is
     still empty, as Re-open does today. In terminal mode the current session ends first, after
     saving its own checkpoint.
  3. Otherwise: what Re-open does today, a fresh session from the handoff. If the file is a
     Start-fresh checkpoint (see 4), its summary goes into the briefing.
  4. A discussion in `archive/` or `deferred/` is first made active, as Re-open does today
     (`:626`), then handled as above. The button reads **Resume (makes it active)**. The separate
     **Make active** action is unchanged.
  5. A checkpoint that can't be used (invalid, or a provider session missing) leaves the file and
     the room as they were and says why, as today. The error suggests Start fresh. Resume never
     starts fresh by itself.
- **`/fresh <name>`** (Start fresh): reads the summary, replaces the full checkpoint with a
  Start-fresh checkpoint holding only that summary (see 4), then does what Re-open does today: it
  ends the current session if needed, resets the agents and the worker, and switches.
- **Close discussion** (`closeDiscussion`, `src/ui.mjs:836`): keeps the latest checkpoint. Its
  `endSession`, or its context's `stopRoom`, writes a final save; nothing deletes it. Resume brings
  the discussion back as it was.
- **Removed commands:** `/pause`, `/reopen`, `/continue` and `/autosummary`. Typed today, an
  unknown `/word` goes to the agents as a message (`handleLine`'s last line). For these four, one
  line answers instead: "/reopen is now /resume", and so on. This is cheap and avoids sending
  "/reopen x" to the agents by habit.
- **`cli.mjs`** (`src/cli.mjs:121`): sends `/resume` instead of `/reopen` for `--reopen` and the
  restored rooms. That one line is the only `cli.mjs` change. The internal flag `--reopen` and
  Restart's `--room {…, reopen}` key keep their names (decided), so a Restart from the code running
  before the merge, which passes `--reopen`, still starts. `openBeside` stops passing `reopen` to
  `addRoom`: it says `/resume <name>` to the new context. So until the next Restart, the old
  `cli.mjs` held in memory never sends the removed `/reopen`.
- **Removed state and guards:** `ctx.paused` / `ctx.pausing` and every guard that reads them
  (`saveSettings :111`, `queueWork :1792`, `handleLine :1468, :1482`, `/move :322`, rollback
  `:382, :388`, `autoDevOffer`, `startAutoDev`, the "paused" branches in
  `newDiscussion`/`newBrainstorm`, `fresh()`, `openList`), `pausedSessions` in the header, `setAuto`,
  `autoOn`, `screen.auto`. Auto dev's "your saved setting is unchanged" sentence goes too
  (`src/ui.mjs:1100`, `src/docs.mjs:587`).

### The page (`src/docs.mjs`)

- **Explorer rows (`:1006-1036`) and the discussion's own page (`:1071-1080`):** one **Resume**
  button replaces Re-open, the separate Resume, and Go to for started discussions. Its tooltip
  depends on the discussion:
  - started and running in the background: "Show it: its agents carry on, nothing is restarted";
  - with a full checkpoint: "Continue where it stopped: same agent sessions and chat";
  - with a Start-fresh checkpoint: "Starts from its handoff and notes, with the summary chosen at
    Start fresh";
  - with none: "No saved session: starts from its handoff and notes";
  - archived or deferred: the same, after "Makes it active first."
  The page learns which case applies from a `checkpoints` list in the header (name and kind,
  `full` or `fresh`), which takes the place of `pausedSessions`, and from a new `started` flag on
  each entry of the header's `open` list (`openList`, `src/ui.mjs:741`). The discussion in use shows
  no button, as today.
- **Go to stays** for an open context that is a brainstorm or hasn't started: the brainstorm and
  a "New discussion (not started)" context (`:1119-1121`), and a named discussion open in another
  context before its first message (for example right after Start fresh, or after Resume from the
  handoff there). They only come into view. Their row shows Go to instead of Resume.
- **Start fresh:** in the row's **Actions ▾** menu and in the discussion page's actions. It always
  asks for a second click ("Click again: its saved sessions and chat are discarded; it starts from
  its handoff"). It isn't offered for the discussion in use before its first message.
- **Removed:** the Pause/Resume item in the header's Actions menu, the "Paused on this machine"
  section, `resumeButton`, and the Auto-summarize checkbox (`#auto-controls`).
- Clicking a row's name still only expands it (`:854`, "Looking is not switching").

## (1) Restart and Quit room: today and after

**Today.** Restart (`restartArgs`, `src/ui.mjs:1423`) passes each open discussion that isn't
paused as `--reopen <name>` (the first room) or `--room {…, reopen, context}` (the others).
Empty contexts and brainstorms are left out. The new process runs `/reopen` for each
(`src/cli.mjs:121`), so each comes back **fresh from its handoff**. The chat, the sessions, auto dev
and the Worker tab are lost. A paused discussion is skipped and stays in "Paused on this machine".
Quit room (`stopRoom`, `src/ui.mjs:1400`) stops programs and keeps nothing. Opening that
discussion again starts fresh.

**After.** `restartArgs` doesn't change. The new process runs `/resume` for each discussion, so
each comes back with its chat and provider sessions as of its last checkpoint. The Worker tab comes
back too, but only that discussion's own entries (those whose `origin` is its label), so several
restored discussions don't duplicate each other's. Quit room writes a final save of the worker
fields. A later Resume continues from the checkpoint. What still doesn't carry over: a brainstorm,
an empty context, an auto dev run (restored as ended, as Resume does today: `autoDev: null`), and the
in-memory rollback and "already reported" records (as today, README `:486, :495`).

## (2) A worker task interrupted mid-run

**What exists today.** Before the worker's turn, `runWork` writes an owner record in the
worktree's private Git directory (`src/ui.mjs:1853-1858`). After a restart, `recoverWorkerOwner`
finds **uncommitted edits** and holds the queue for that origin. But when the worktree is clean,
`leftovers()` deletes the record (`src/ui.mjs:901-908`). So a task stopped before it wrote
anything, or one that had committed everything, leaves **no trace**. On Quit or Restart, a task the
stop kills ends with an error reply ("claude was stopped (SIGTERM)"). That reply is written to the
transcript, but only if `stopRoom`'s 3-second wait catches it. Queued tasks are dropped, reported
once and forgotten. After a crash or `kill -9`, nothing is recorded.

**Proposal: the checkpoint records the work in flight**, in `work`:
- `queueWork` adds the task to `work.queued` (its text).
- `runWork`, **as its first step**, before `refreshWorker`, the owner record or any Git command,
  moves it to `work.running = { task, at, before: null }` and saves. Once `before` (worker/main's
  commit at the start) is known (`src/ui.mjs:1851`), it saves again with it.
- When the reply has been written to the transcript, `runWork` clears `work.running` and saves.
  Exception: if the room is stopping (`ctx.stopped`) and the turn failed, it moves the task to
  `work.interrupted` instead, so a killed task isn't recorded as an ordinary failure.
- `stopRoom` moves still-queued tasks to `work.notStarted` and saves.

**On restore** (Resume, Restart, or Resume after Quit), a leftover `running` counts as
`interrupted`. For each one, agent-room checks the worktree once with the existing helpers
(`worktreeStatus`, `labelledCommits`) and reports one of these:
- **No starting commit recorded** (`before: null`): "Result unknown: [label] "task" (started 14:02)
  was interrupted before its starting point was recorded. Check the worktree." The worktree's state
  is given as found: clean, or uncommitted edits. Uncommitted edits hold the queue as edits of
  unknown origin, as today, because no owner record was written.
- **Starting commit recorded, uncommitted edits:** the existing hold for that origin applies,
  unchanged (the owner record is still there). The notice adds "interrupted by Restart/Quit".
- **Starting commit recorded, clean, labelled commits since it:** "Interrupted after committing:
  <ids, files>. Its reply was lost. Ask the worker to check whether the task is complete."
- **Starting commit recorded, clean, no commits since it:** "Interrupted: it left no commits or
  edits in the worktree. It may still have written notes elsewhere, such as the discussion's
  folder. Send it again if still wanted."
- **Not started** (from `notStarted`): listed with their text. Nothing is re-sent automatically.

**Where it shows:** a note in the Worker tab (`workNote`), and one `agent-room` message in the
discussion's chat and transcript (the same shape as `workNotice`, `src/ui.mjs:936`), so the agents
learn of it with the next round. The worker's next instruction from that discussion starts with
one line: "Your previous instruction "…" was interrupted by a Restart or Quit: check the worktree
before continuing." Then `work.interrupted` is cleared.

**Tests with a fake worker:** a turn that never returns, and the process is killed: `kill -9` in a
`cli.mjs` subprocess test, Quit in an in-process one. Then Resume and check each case:
- no starting commit (the kill comes while the worktree is being prepared): "Result unknown";
- a clean worktree;
- an edit before the kill: the hold appears, with the "interrupted" wording;
- a commit before the kill;
- a queued task that never started.

## (3) A provider session advanced after the last checkpoint

The session IDs never change between turns: Claude resumes the same `session.id`, and Codex the
same `threadId`. So a restored checkpoint always points at the provider's **current** history,
which may hold turns the restored chat doesn't.

- **What agent-room can detect:** the transcript file is longer than the checkpoint's `logBytes`.
  Something was written to it after the last save, usually a round that started and was cut off
  by Restart, Quit or a crash. On restore, agent-room then:
  - adds `_(restored from the checkpoint of <time>; the transcript had grown after it)_` to the
    transcript;
  - shows a note saying what was detected: "The transcript grew after the checkpoint of <time>.
    What was written after it is not in the restored chat; it is in the transcript file (from
    line N). The agents may remember some of it. Send your last message again if needed."
  It reports what was detected. It doesn't claim how many agents answered, or that they did.
- **What it can't detect:** an unchanged transcript doesn't prove the sessions are unchanged. A
  turn killed after the provider recorded part of it, but before its reply was logged, leaves the
  file as it was. So the agents are told on **every** restore, whatever was detected. The next
  prompt to each agent starts with: "agent-room restored this discussion from its checkpoint of
  <time>. If you remember turns after that, they are not in the room's record." The sentence
  doesn't say whether anything was lost. Rewinding isn't proposed: providers can't drop turns, and
  forking a session (`claude --fork-session`; Codex has no equivalent) would add code for each
  provider.
- **A Claude agent killed in its very first turn.** `session.started` stays false, but the CLI may
  already have created a session with that ID. `--session-id <same id>` would then fail. On
  restore, any Claude session with `started: false` gets a new ID (`reset()`). Nothing it said was
  recorded.
- **The worker ran after the discussion's last round.** Its session ID is the same object, so its
  history is simply newer. Its briefing flags (`workerBriefed`, `workerTree`, `workerLabel`) are
  saved with every worker save (see 2), so they match.

Two servers open on the same folder and discussion would overwrite each other's checkpoint: the
last save wins. Within one server that can't happen, because Resume shows the open context
instead. I'd note it in the README rather than add a lock.

## (4) How Start fresh finds the latest summary, and keeps it through a Restart

Only from the checkpoint. `/fresh` takes the last entry with `speaker: 'Summary'` in its chat,
with its `outcome` and `by`. If there is no checkpoint, or it has no summary, there is no summary:
the fresh session starts from the handoff and notes only. Transcript files are not searched.

The summary is kept on `ctx.freshSummary` until the first message, and goes into the briefing
(`briefing()`, `src/ui.mjs:510`): "Start from its handoff and its notes.md. The latest summary from
the previous session is below." When it wasn't agreed, its heading says "**not agreed**: the last
version, by B; treat its points as proposals". With no summary, the briefing just leaves that part
out.

**Through a Restart before the first message: included, because it is simple.** Instead of
deleting the checkpoint, `/fresh` replaces it, in the same file and with the same atomic write,
with a **Start-fresh checkpoint**: `{ version: 1, root, at, discussion, fresh: true, summary }`,
where `summary` is `{ text, outcome, by }` or `null`. It holds no sessions, chat or worker
fields. Then:
- Resume, including the one Restart runs through `--reopen`, sees `fresh: true` before the full
  checkpoint's checks. It starts from the handoff, as with no checkpoint, and puts that summary
  in the briefing. So a Restart, or Quit room and Resume, between Start fresh and the first message
  keeps the summary.
- The fresh session's first round end overwrites it with a full checkpoint, as with any round.
  The summary is still in the briefing the agents received, but it isn't added to the new chat.
- Start fresh again on a Start-fresh checkpoint keeps its summary (there is no newer one).
- Close discussion before the first message leaves it as it is.
- The saved sessions are gone either way: Start fresh discards them at the click, as it should.

Cost: about 15 lines in `src/ui.mjs` (writing the small file, one branch in Resume, the
`fresh` kind in the header's `checkpoints` list), one tooltip in `src/docs.mjs`, and one test
(Start fresh, Restart before the first message, check the briefing). Without it, a Restart there
silently drops the summary, so I've included it.

## (5) Tests whose contracts change

None is weakened: none loses an assertion about behaviour that stays. Some describe behaviour
being removed or renamed, as you asked. **Flagged for your approval:**

- **Renamed commands, same assertions:** the 20 `/reopen` uses in `ui.test.mjs`, `rooms.test.mjs`
  and `screen.test.mjs` become `/resume`. The tests that reopen a discussion **without** a
  checkpoint (`ui.test.mjs:179`, `:284`, `:362`; `screen.test.mjs:104`; `rooms.test.mjs:331`) still
  start fresh and keep their assertions. `rooms.test.mjs:198` and `ui.test.mjs:1260` ("Re-open of an
  open one goes there") keep their assertions under Resume: the window switches, and nothing
  restarts.
- **`ui.test.mjs:414`:** its "go back" step resumes a discussion that **will** now have a
  checkpoint. Its assertions (name, back link) still hold, but it now means "continues". Its title
  and comment will say so.
- **Pause/Resume tests replaced, not dropped** (`ui.test.mjs:836`, `:907`; `screen.test.mjs:146`):
  - The screen test's two-process proof becomes "Quit room, then Resume: the same sessions
    continue", with no `/pause`. It still checks the same Claude `--resume` ID, the Codex
    `exec resume`, the worker's session, and that no introduction or history is sent again.
  - "A corrupt or missing-session checkpoint leaves the file and the room intact" stays.
  - "The brainstorm is replaced only by a valid Pause" becomes "Resume replaces a brainstorm".
  - The two-click check moves to Start fresh.
- **Removed:** `Restart leaves a paused checkpoint for Resume` (`ui.test.mjs:1432`), since paused no
  longer exists. Also the "turned off" half of `ui.test.mjs:69`; its "no summary after a round of
  passes" half stays.
- **About 23 `/autosummary off|on` lines** (19 in `ui.test.mjs`, 2 in `rooms.test.mjs`, 1 in
  `screen.test.mjs`, 1 in `replication-ui.test.mjs`):
  - Where the fake agents only PASS, the line is just deleted, because no summary runs anyway.
  - Where they speak, a summary now follows. Their scripted answers get the summary turns, and
    assertions that count prompts or chat entries change. I'll list each one in the commit.
  - If one would need a looser assertion, I'll stop and ask. I'd rather not add a test-only
    switch: it would keep the toggle alive in code.
- **Test isolation (new, needed):** the in-process tests use the real `homedir()`
  (`ui.test.mjs:855`). Automatic checkpoints would write into your real `~/.local/state/agent-room`
  on every test round. `npm test` would set `HOME` to a temporary folder (in `package.json`'s
  script, or at the top of each in-process test file). The subprocess tests already do this.

**New tests:**
- a round writes a checkpoint, with and without a summary;
- Resume of a background discussion only switches the view (no agent call, same sessions);
- Resume continues from a checkpoint (same IDs, no introduction), and starts from the handoff
  without one;
- Restart continues (subprocess);
- Close discussion keeps the checkpoint;
- Start fresh asks twice, replaces the full checkpoint with a Start-fresh one, and briefs with an
  agreed summary, a not-agreed one, or none;
- the summary survives a Restart (subprocess) and Quit room + Resume before the first message, and
  the first round end replaces the Start-fresh checkpoint with a full one;
- the page shows Go to (not Resume) for an open brainstorm and for an open discussion not yet
  started, and Resume (makes it active) for an archived or deferred one;
- a removed command typed gets its one-line answer and reaches no agent;
- the interrupted-worker cases in (2);
- the transcript-grew notice in (3), and the agents' restore sentence with and without growth.

## (6) Rough size

| Where | Change |
|---|---|
| `src/ui.mjs` | about −150 lines (Pause, Resume, Re-open and their screen variants merged into one; the `paused` guards; the auto toggle) and +210 (the save helper and its calls; `/resume` with its cases, including making an archived or deferred discussion active; `/fresh` with the Start-fresh checkpoint; `started` in `openList`; removed-command answers; interrupted-work reporting; the transcript-grew note and the restore sentence) |
| `src/docs.mjs` | about −55 (the Pause item, the Paused section, Resume and Re-open buttons, Go to for started discussions, the toggle) and +35 (one Resume with its tooltips, Go to kept for brainstorms and unstarted discussions, Start fresh in two places, the `checkpoints` list) |
| `src/cli.mjs` | one line (`/reopen` → `/resume` at startup); the `--reopen` flag keeps its name. It takes effect at the next Restart; everything else applies with Reload. |
| `README.md`, `README-for-brainstorming-agents.md`, `README-for-worker-agents.md` | rewrite the Pause/Resume, Re-open and Auto-summarize sections (about 13 mentions of reopen, Re-open or Go to, plus the command table and the USAGE text in `ui.mjs`). "Where to start reading": a resumed session keeps its memory and gets the restore sentence; a fresh start reads the handoff and notes, plus the summary when given. The worker rulebook mentions the "interrupted" line. |
| tests | about 15 new or replacing tests, 2 removed, about 20 command renames and 23 auto-summarize edits |

Overall about +245 / −205 lines in source, in **two commits**, which you can review separately.
**Both are required for the change to be complete; neither is "done" alone:**
- (a) automatic checkpoints; Resume, Start fresh (with its Start-fresh checkpoint) and Close
  keeping the checkpoint; Go to kept only for brainstorms and unstarted discussions; and the
  removal of Pause, Re-open and the toggle;
- (b) the recovery reporting on restore: interrupted and not-started worker tasks, the
  transcript-grew notice and the agents' restore sentence.

**Merge only after (b).** Commit (a) alone would make every restore continue silently, with no
report of a worker task or round cut off by a crash, Restart or Quit. So `worker/main` with (a)
but not (b) is not ready to merge, even if `npm test` is green. I'll send them as two consecutive
worker tasks, each with its own commit and test run. The report for (a) will say "not ready to
merge: wait for (b)".

## Decided in the reviews (2026-11-10)

- One **Resume** / `/resume <name>` for every discussion not on screen. It replaces Open, Re-open,
  Go to for started discussions, `/reopen` and `/continue`. On a discussion running in the
  background it only brings it into view.
- A brainstorm, and a discussion that is open but not yet started, keep **Go to**.
- Resume on an archived or deferred discussion makes it active first; Make active is unchanged.
- Start fresh (`/fresh <name>`, Actions ▾, second click) discards the saved sessions. It uses only
  the checkpoint's latest summary, never the transcript files.
- Close discussion keeps the latest checkpoint.
- The internal `--reopen` flag keeps its name.
- The interrupted-round notice reports only what was detected. A worker task with no recorded
  starting commit is reported as "result unknown: check the worktree".
- Automatic saving and recovery reporting are both required; merge only after the second commit.

No questions are left open.
