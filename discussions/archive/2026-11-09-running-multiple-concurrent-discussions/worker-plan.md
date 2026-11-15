# Plan: several open discussions in one room, one shared worker (worker, 2026-11-09, revised)

This is a plan only. Nothing is implemented, no test is changed, nothing is committed. It was
checked against `worker/main` at `bc04eca`, by reading the code; I ran nothing for it.

This revision applies the User's answers recorded in `notes.md` ("After the plan" and "Recovery of
leftover edits"), and three corrections: New discussion keeps the previous one open; a task's
owner is saved before it starts; and squash merges affect detection, not what rollback can
revert.

Labels used below:
- **[Decided]**: a User decision recorded in `notes.md`.
- **[Proposal]**: the agents' proposal, not decided.
- **[Recommend]**: my recommendation; not authorized.
- **[Open]**: needs the User's decision; collected in section 9.

---

## 1. What the code does today (facts the plan relies on)

- **One room = one `ctx`** (`src/cli.mjs` `addRoom`, keyed by the folder's real path). Every
  per-discussion thing lives directly on that `ctx`:
  - `discussion`, `logPath`, `pendingLog`;
  - `state` (transcript, `seen`, `summaries`, `briefing`, `brainstorm`);
  - `sessions` (the agents' provider sessions by name, and the worker's under `worker:<name>`);
  - `room` (`createRoom(agents, ctx.state)`);
  - `autoDev`, `autoDevSent`, `busy`, `paused`, `previous`, `agentsStarted`;
  - `screen` (the page's chat, thinking and status).

  `src/ui.mjs` reads these fields about 150 times (counted with grep).
- **One input queue per room** (`src/cli.mjs` `runRoom`): lines run one after another, so a
  round blocks every other line in that room. **Separate rooms already run rounds independently.**
  The test `rooms.test.mjs` "one server, two rooms: … independent rounds" covers this.
- **One worker per room:**
  - `ctx.worker` is built in `load()`; `ctx.workQueue` is a promise chain built in `queueWork`.
  - `runWork` already captures its task's own discussion and transcript (`task.discussion`,
    `task.logPath`). A task therefore keeps writing to the discussion it came from, even after a
    switch; a test covers this.
  - The worktree is `<repo>.worker` on `worker/main` (`workerPlace`, `ensureWorktree`).
  - A second room in the same Git repository gets **no worker**: `sharedWorktree` says so, and
    `rooms.test.mjs:95` asserts it.
- **Git rules today:**
  - Agent-room's own code writes only `worktree add` and a fast-forward of `worker/main`
    (`catchUp`, when strictly behind and clean). See the comment above `WORKER_BRANCH`
    (`src/ui.mjs:1181-1187`) and `README.md:435-438`: "never resets, merges, rebases or deletes".
  - The worker commits only when asked: `README-for-worker-agents.md:18-19` and `:27-28`, and the
    per-task text in `runWork` (`src/ui.mjs:1388`).
- **What survives what:**
  - Reload keeps everything in `ctx` and waits for the room's round (it is queued like a line).
  - Restart (`restartArgs`) brings each room back with `--reopen <discussion in use>`: fresh
    sessions from the handoff. Chats, unpaused sessions and queued worker tasks are lost; queued
    tasks are reported as "not started" by `stopRoom`.
  - Quit room stops the room's agent and worker programs (`stopPrograms`).
  - Pause saves one discussion's sessions and chat to `~/.local/state/agent-room/paused/`, which
    survives Quit and Restart.
- **Replication** (`saveRound`, `--node` launch room only) captures per discussion into
  `.agent-room/`. Its `update-ref` is compare-and-swap per discussion line.

## 2. Requirements, checked against the code

### Confirmed by the User [Decided]

- **One shared worker for the first version.** Today's single `ctx.worker` and `ctx.workQueue`
  fit, but must be shared by the folder's open discussions (C2).
- **The worker commits every completed task**, every room, with the discussion's name in the
  message and the commit ID in its report. The User merges.
  - This needs the rulebook and task-text changes in section 3, C3.
  - **Risk:** the worker (an agent) writes the label, so agent-room should check it.
- **The User merges `worker/main` into main with a normal merge** ("unless there is some
  substantial gain not to do so").
  - With normal merges, the commits that reached main are reachable from the room's `HEAD`.
  - So "not yet merged" is `git log <room HEAD>..worker/main` (used by the Defer block).
- **Leftover edits pause the queue** until the originating discussion resolves them.
  - Agent-room checks after each task and before the next (`worktreeStatus` already computes
    `treeDirty`).
  - The originating discussion's recovery tasks still pass.
  - The queue resumes when the folder is clean.
- **No Discard button.**
  - To abandon an attempt, the User asks the worker in that discussion. The worker lists the
    edits it would remove, waits for the User's explicit approval, and removes only those.
  - Unclear ownership is reported, never a reset of the shared folder.
  - So agent-room's code gains no destructive Git action. The worker gains an explicitly
    requested one (C3).
- **Before each round, one combined line** names what other discussions finished since this
  discussion's previous round (discussion, commits, files). It shows in the chat and transcript;
  viewing adds nothing.
- **A discussion with unresolved worker edits can't be archived or deferred**; switching away is
  allowed.
- **Defer is blocked while that discussion has commits on `worker/main` not yet merged into main.**
- **Rollback:** full rollback, merged commits included, if not too costly.
  - The worker does the work, including bringing main into `worker/main` when needed. This is an
    exception, for rollback, to "agent-room never merges".
  - The worker commits on `worker/main`; the User keeps the final merge into main.
- **Quit room closes everything:** every open discussion in that folder.
- **Worker notes go in the folder of the discussion that sent the task** (listed as item 7 under
  Decided). Already true per task: `runWork` briefs with `task.discussion.dir`.

### Agents' proposals, not decided [Proposal]

1. **Each open discussion runs on its own** (agents, chat, auto dev). Main work: section 3.
2. **"Needs you" marker in Explorer.** Small once each discussion has its own state.
3. **One queue, one checkout, one branch.** Matches today's worktree code.
4. **One worker session per discussion inside the single worker.** Small: today's worker session
   is `ctx.sessions.get('worker:<name>')`; it becomes one session object per discussion.
5. **The worker notices conflicts by itself.** Not something code can rely on.
   **[Recommend]:** give the worker the same "finished elsewhere since your last task" line as the
   agents, at the top of each task.

## 3. Smallest changes [Recommend]

### Shape: one `ctx` per open discussion, sharing a per-folder "workshop"

A `ctx` already *is* "one discussion with its own sessions, chat, input queue, auto dev, Pause and
page". Several rooms already run side by side on one server. So the smallest route is to let one
folder hold **several contexts, one per open discussion**, and move only the worker parts into an
object they share. The alternative is to split `ctx` into per-discussion sub-objects; it touches
the ~150 field reads, `handleLine`, the page protocol and most tests.

**C1. Contexts per discussion.**
- **`src/cli.mjs` `addRoom`:** key rooms by folder **and** discussion (or brainstorm), and let a
  folder have several. This is a `cli.mjs` change, so it needs a Restart once to take effect.
- **`src/ui.mjs` `roomId`:** include the discussion in the id, so each context gets its own
  `/r/<id>/` page address.
- **`listRooms`, `newRoom`, `openRoom`:** these follow.
- **Rule:** at most one context per discussion.

**C2. A shared workshop per folder (repository).**
- **What it holds** (one object, shared by reference like `ctx.programs` and `ctx.workerDir` are
  today):
  - the worker agent;
  - the worker's sessions by discussion;
  - the task list;
  - `workerDir`, `working`, `workerInfo` and `workingIn`;
  - the worker tab's log;
  - the pages to broadcast to;
  - `blockedBy`.
- **Functions:** `load` builds it only when absent, and only replaces the worker agent on Reload;
  `queueWork`, `runWork` and `refreshWorker` use it.
- **`queueWork`:**
  - Becomes: push `{ text, origin, run }` into a list and poke a runner.
  - The runner starts the first task whose origin is allowed: any task when not blocked, only
    `blockedBy`'s tasks when blocked.
  - Before starting, it checks `treeDirty` (`worktreeStatus`).
- **`runWork`:**
  - Uses the origin's worker session.
  - Saves the task's owner first (C9).
  - Afterwards checks `treeDirty` and the new commits (C3), sets `blockedBy` when dirty, and tells
    the origin and the Worker tab.
- **`sharedWorktree`:**
  - Contexts of one folder share the worker.
  - A different folder in the same repository keeps today's "No worker in this room", so
    `rooms.test.mjs:95` keeps its contract.

**C3. Commit per task, and the worker's explicitly requested Git actions.**

These lines would change so the worker does these actions instead of refusing them.

- **`README-for-worker-agents.md:18-19`**
  - Today: "Commit on `worker/main` only when asked."
  - New: "Commit every completed task on `worker/main`, with a message starting
    `[<discussion folder name>]`, and give the commit ID in your reply. Never merge into the
    User's main or push."
- **`README-for-worker-agents.md:24-26`** (the "never delete, overwrite …" bullet)
  - Add: "Git actions the User explicitly asks for are allowed in your worktree:
    - reverting commits for a rollback;
    - merging main into `worker/main` when a rollback needs it;
    - abandoning an attempt: first list exactly the edits you would remove, wait for the User's
      explicit approval, then remove only those.

    Never reset or clean the whole worktree; report edits whose owner is unclear instead."
- **`README-for-worker-agents.md:27-28`**
  - Today: "Don't commit or push unless the User asks."
  - New: "Don't push. Commit as above."
- **Task text in `runWork`** (`src/ui.mjs:1388`)
  - Today: "Commit on worker/main only when asked; the User reviews and merges it."
  - New: "Commit each completed task on worker/main as "[<name>] …" and give its commit ID; the
    User reviews and merges it into main."
  - `<name>` is the origin discussion.
- **`README.md:435-438` and the comment at `src/ui.mjs:1181-1187`**
  - Keep "agent-room's own code never resets, merges, rebases or deletes".
  - Add that the worker may do the explicitly requested actions above in its worktree, as
    recorded in `notes.md`.
- **After each task, agent-room** lists the new commits (`git rev-list <before>..worker/main`).
  It reports any commit without the origin's label, rather than trusting it.
- **No test asserts the replaced sentences:** `ui.test.mjs` checks only the start of the per-task
  text.

**C4. Report routing.**
- Already per task (`task.logPath`).
- `reportBack` calls the run's own `ctx.say`, which under C1 is the origin context.
- **[Open]:** a Worker tab shared and labelled by origin, or one per discussion. I recommend
  shared and labelled.

**C5. "Finished elsewhere since your previous round" line.**
- In `handleLine` just before `runRound`, and in `autoDevReport`.
- Keep `ctx.workSeen` (the `worker/main` tip at its previous round).
- Build one transcript entry (logged and broadcast like auto dev's dispatch notice) from
  `git log <workSeen>..worker/main --name-only`, for commits labelled with *other* discussions.
- After a Restart, take the current tip as the baseline and say nothing.

**C6. Move guards.** In `moveDiscussion`:
- Refuse Archive and Defer while the discussion owns leftover edits (`blockedBy`, or C9's saved
  owner).
- Refuse Defer while `git log <room HEAD>..worker/main --fixed-strings --grep "[<name>]"` finds
  commits.
- Add the reasons to Explorer's tooltips (`src/docs.mjs`).

**C7. Page.**
- Explorer: an open discussion's row says "open" and goes to its page; the shown one stays
  "in use"; "needs you" [Proposal 2].
- The header's room menu lists the folder's open discussions.
- **Quit room:** quits every context of the folder (Decided).
- **[Recommend]:** a separate "Close discussion" closes one.
- **[Open]:** the same window (navigate) or a window per discussion. I recommend the same window.

**C8. Replication.**
- Only the launch folder replicates.
- Its contexts must share **one** replica object (`ctx.replica`), so its `serial` chains cover
  the shared `discussions.json` written by `discussionId(s, name, true)`.

**C9. Saving which discussion owns a task before it starts** (assessed, correction 2).

*What:*
- Before the worker's turn, `runWork` writes a small record: discussion name and folder, the
  task's text, the start time and the `worker/main` tip before the task.
- Location: the worktree's private Git directory (`git rev-parse --git-path agent-room-task.json`
  in the worktree). It is per worktree, never committed, and outside the room's files.
- `runWork` deletes the record once the tree is clean after the task.

*Why:*
- After a Restart (or Quit and reopen), `refreshWorker` at start finds the tree dirty. With the
  record, it sets `blockedBy` to the owner instead of "unknown".
- The owner's discussion row then says it has leftover edits.
- Opening it lets the User ask its (fresh) worker session to finish or abandon. The recovery task
  can quote the saved text and the starting tip, so a fresh session knows what was attempted and
  which edits are its own (`git diff <tip>`).

*Cost:* small. One JSON write and delete per task, and one read at start; no new module.

*Limits:*
- A record left behind by a crash between "clean" and "delete" is trusted only when the tree is
  dirty.
- Edits made outside agent-room (the User working in the worktree) would be attributed to the
  last owner. The worker's listing step before removing anything is what protects against that.
- Queued tasks that never started are still lost on Restart, as today.

*Note:* this is new persistent state, small but real. It also contradicts the comment at
`src/ui.mjs:1184` ("agent-room stores nothing"), which would change. I'm noting it per the project's rule about
asking before adding processes or config.

## 4. Lifecycle

### 4.1 Reload, Restart, Quit

**Reload**
- Today: per room, between its own lines; everything in `ctx` is kept.
- With contexts: each context reloads after its own round. The workshop is kept, so the task
  list, worker sessions, `blockedBy` and the open discussions survive. A running worker task
  finishes on the old code.
- **[Recommend]:** no extra change.

**Restart**
- `restartArgs` passes one `--room` entry per open discussion. The JSON already allows it;
  `addRoom` must accept several per folder.
- Each comes back fresh from its handoff, as today. Paused ones stay paused.
- Queued tasks are reported "not started", as today.
- A task stopped mid-way leaves its owner recorded (C9), so the queue starts blocked by that
  owner.
- With no record and a dirty tree, the queue starts blocked as "unknown owner". The User then
  commits, or asks a worker task to list and (with approval) remove the edits.

**Quit room [Decided]**
- Closes every open discussion of the folder: stops all their agents and the worker
  (`stopRoom` on each context, then the workshop).
- A worker task stopped mid-way is covered by C9 for the next open.
- **[Recommend]:** "Close discussion" ends one context only:
  - its agents stop;
  - its queued tasks are removed (reported);
  - its running task finishes into its transcript, which `runWork` already does.

### 4.2 Pause / Resume, New discussion, Re-open, brainstorms

**Pause / Resume**
- Unchanged per context; checkpoints are per discussion name already.
- Pause waits for its own context's tasks in the shared list.
- With switching keeping sessions alive, Pause becomes mainly "survive Quit or Restart".

**New discussion (correction 1)**
- **[Recommend], following the User's correction:** New discussion **keeps the previous
  discussion open**: its sessions, chat and auto dev run continue. It opens a new context for the
  coming discussion and shows it; the next message there names and creates the folder, as today.
- This changes existing test contracts; see section 5.

**Re-open**
- **[Recommend]:** if the target is already open, go to its context (no fresh sessions).
- Otherwise open it in a new context, fresh from its handoff as today, keeping the others open.
- That matches New discussion's new default.

**Brainstorms**
- **[Recommend]:** at most one brainstorm context per folder, beside the discussions; it has no
  auto dev.
- **[Open]:**
  - Does New discussion from a brainstorm keep the brainstorm open, or end it as today?
  - May a brainstorm send worker tasks? It has no discussion label for the commit.

## 5. Tests

### Existing tests whose contract changes with New discussion keeping the previous one open

These need the User's approval. All are in `test/ui.test.mjs`.

- **"/new after a round: the session ends as with Re-open; the next message starts a new titled
  discussion"**: asserts the agents' sessions reset, the chat empties and "session ended" in the
  old transcript.
- **"/new leaves the worker alone: a running task keeps its transcript, its log stays, the next
  instruction learns the new folder"**: asserts "session ended" in the old transcript, the
  "no longer the active one" note and the "No discussion is active now" briefing.
- **"after New discussion, the previous one can't move while its worker task runs; it can once
  the task ends"**: the previous one stays open, so whether it can move at all depends on the
  move rule for open discussions.
- **"a worker task keeps the discussion it started in, even if New discussion comes while it
  prepares its worktree"**: asserts `ctx.discussion === null` after `/new` and "session ended" in
  the transcript.
- **"Pause preserves native sessions across New discussion; corrupt Resume leaves the checkpoint
  and room intact"**: asserts that `/new` after Pause gives fresh agent and worker sessions.
- **"auto dev: never in a brainstorm; New discussion ends a run; Reload keeps it, and a lost
  worker result pauses it"**: asserts that `/new` ends the run.
- **"New discussion or Re-open ends the brainstorm; the next message then starts a discussion"**:
  changes only if New discussion keeps a brainstorm open ([Open] in 4.2).
- **Re-open tests:** "/reopen after the session started: a fresh session in that discussion"
  changes if Re-open keeps the current discussion open, as recommended.

Unchanged: "/new: nothing to end before the first message; it creates nothing and changes
nothing".

### Other contracts to review

- **`ui.test.mjs` "Restart keeps the launch flags that matter …":** asserts `restartArgs` exactly;
  it changes when several open discussions are passed.
- **`screen.test.mjs` "Restart: … re-opening the discussion in use"** and **`rooms.test.mjs`
  "Restart with two rooms …":** may change for the same reason.
- **`rooms.test.mjs:95` "No worker in this room":** kept for a different folder; re-check its
  setup.
- **`docs.test.mjs` heartbeat and "running rooms can be listed":** shapes may gain a discussion
  per context.

### New tests I'd add

1. Two contexts of one folder run rounds at the same time with separate sessions, and share one
   worker queue.
2. A report goes back to its origin context, even when another is shown.
3. A dirty tree after a task blocks other discussions' tasks and lets the owner's recovery task
   through; a clean tree unblocks.
4. The owner record (C9): written before the task, removed when clean, and used after a simulated
   Restart to block by owner; "unknown owner" without it.
5. Unlabelled commits after a task are reported.
6. The "finished elsewhere" line: listed once before the next round only; viewing adds nothing.
7. Defer is refused with unmerged labelled commits and allowed once the room's `HEAD` contains
   them (normal merge); Archive and Defer are refused while the discussion owns leftover edits.
8. New discussion keeps the previous context open, with its sessions and auto dev run.
9. Re-open of an already open discussion switches without resetting it.
10. Quit room closes every context of the folder.
11. Restart passes every open discussion.
12. Each discussion gets its own worker session and briefing.

## 6. Archive with rollback (proposal 9), assessed, not settled

### 6.1 Rolling back unmerged commits

- **What it is:** an ordinary queued worker task from B (or started by Archive), labelled
  `[<B>] rollback`, committed on `worker/main`.
- **Finding B's commits:** `git log <room HEAD>..worker/main --grep "[<B>]"`.
- **Undoing them:** `git revert`, newest first.
- **Finding dependencies:**
  - **By files:** later commits by other discussions touching the same files
    (`git log --name-only`).
  - **By names:** functions or exports B added or changed, searched for in later diffs.
  - **By behaviour:** the tests on the reverted tree, before committing.
  - The worker reports what can safely be undone; the User reviews it before Archive.
- **Cost:** small. One worker instruction plus the labels (C3); no new Git code in agent-room.

### 6.2 Full rollback, including commits merged into main

**Where it's applied:** on `worker/main`, by the worker [Decided].
- **When main has commits `worker/main` lacks** (the User's own, or other merges), the worker
  first merges main into `worker/main`. That is allowed for rollback [Decided].
- **It then reverts B's commits**, which are all still on `worker/main`: the original ones are
  never removed from it.

**How it reaches main:** through the User's normal merge of `worker/main` [Decided]. With normal
merges, B's commits on main and on `worker/main` are the same commits, so the reverts undo them
on main too.

**Squash merges (correction 3):**
- After a squash, B's original commits remain on `worker/main`, so **what rollback can revert is
  unchanged**.
- What changes is **detecting what reached main**: main holds one squash commit with a different
  ID. So the Defer block (`<room HEAD>..worker/main`) would keep reporting B's commits as
  unmerged.
- Separately: if a squash ever happened, reverting the originals alone wouldn't remove the
  squashed copy from main. After the worker brings main into `worker/main`, the squash commit is
  there too and must be reverted as well, found by its message or content. Normal merges
  [Decided] avoid both issues.

**Extra cost compared with 6.1:**
- **Dependency search:** a larger search over everything after B, including the User's own
  commits on main and other discussions' merged work. The longer B has been merged, the more may
  depend on it.
- **Merge first:** merging main into `worker/main` may conflict; the worker resolves it or
  reports it.
- **Outside Git:** pushed commits (`origin`), deployed versions, data written by the running app,
  and peers that replicated discussions are not undone.
- **Review:** the merge back into main is itself a change for the User to review and test.

**Estimate:**
- **Unmerged only:** one worker task plus a report.
- **Full rollback:** the same task plus a possible main → `worker/main` merge, at cost growing
  with what was built on B since.
- "Prepare, report, then commit on approval" fits both cases. "One click, always complete" fits
  neither.

**Limits for both:**
- Dependencies sharing neither files nor names are invisible.
- Tests only catch what they cover.
- Commits that mix B's and another discussion's work can't be split by code.
- B's notes and drawings live in the room's `discussions/` folder, not in worker commits, and
  aren't touched.

## 7. What I could not determine from the code

1. **Two discussions' Claude/Codex processes running at once in one folder.** Whether providers'
   CLIs or quotas mind (probably fine, untested). Whether agents of two discussions will edit
   shared files at the same time (for example `discussions/README.md`): nothing locks files.
2. **Replication:** whether one shared replica object is enough with several contexts in the
   launch folder (C8).
3. **Labels:** whether the worker writes them reliably. Only checking after the fact can tell.
4. **Cost:** two busy discussions roughly double agent usage (unmeasured).

## 8. Harder or riskier than `notes.md` assumes

- **The queue:**
  - "A simple Git check suffices" holds for detection.
  - But letting only the owner's recovery through needs the queue rewritten from a promise chain
    into a task list.
  - Keeping the owner across Restart needs the record in C9.
- **Commit labels carry everything:** the round notice, the Defer block and rollback all depend
  on them; one mislabelled commit weakens all three silently.
- **Catching up with main:**
  - With a commit per task, `worker/main` is usually *ahead* of main, so today's fast-forward
    catch-up stops happening.
  - Ordinary tasks then work on a base that lacks the User's newer commits on main.
  - Only rollback is authorized to merge main in.
- **Two auto dev runs in two discussions** can relay tasks that build on each other's unreviewed
  work. The queue serializes tasks, not decisions.
- **Reusing the room machinery** (C1) turns the UI's "room" into "a discussion's page in a
  folder": the room menu, Switch room and Close or Quit need new wording.

## 9. Still needs the User's decision

1. **Approve the test contract changes** in section 5, caused by New discussion (and the
   recommended Re-open) keeping the previous discussion open.
2. **Brainstorms:** does New discussion keep an open brainstorm, or end it as today? May a
   brainstorm send worker tasks?
3. **Close one discussion:** a separate "Close discussion" action (recommended), given that Quit
   room now closes all of them.
4. **Worker tab:** one shared tab labelled by origin (recommended), or one per discussion.
5. **Page:** the same window navigating between discussions (recommended), or a window each.
6. **The owner record (C9):** OK to add this small persistent file in the worktree's Git
   directory?
7. **Ordinary tasks and main:** may the worker also merge main into `worker/main` before ordinary
   tasks when `worker/main` is ahead and behind, or only for rollback (as decided)?
8. **Moving an open discussion:** may an open (not shown) discussion be archived or deferred, if
   it owns no edits and no unmerged commits? Or must it be closed first?
9. **Send the revised rulebook and task text** (C3) as part of the implementation.
