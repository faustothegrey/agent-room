# Plan: a worker per discussion, running in parallel

Status: proposal, no code changed (worker, 2026-11-12; revised the same day with the results of the resume, parallel-test and merge experiments). The aim (User, 2026-11-12) is fully
parallel discussion management: each discussion's worker tasks can run while other discussions'
tasks run.

## Today, in short

All discussions open in a folder share one **workshop** (`shop`, `src/ui.mjs` around line 206 and
the "shared worker queue" section around line 1030):

- **One worktree and branch:** `<repo>.worker/` on `worker/main`.
- **One queue:** `shop.tasks`, with one task running at a time in `pump`.
- **One Worker tab** (`shop.log`), in which each entry is labelled with its origin.
- **Per discussion today:** only the worker *session*. The checkpoint records it, under
  `worker:<name>`.

Several rules exist only because of that sharing:

- One origin's uncommitted edits hold everyone's tasks (`blockedBy`).
- The "Work finished elsewhere" notices.
- A rollback must work around other origins' commits on the same branch.
- The Defer guard filters `worker/main` by label.

## The design

### Lanes

Each discussion gets a **lane**: its own worktree, branch, queue, worker agent and session, and
Worker log.

| | Worktree | Branch |
|---|---|---|
| Discussion `<name>` | `<repo>.workers/<name>/` | `worker/<name>` |
| Brainstorm, or a task sent before the first message | `<repo>.worker/` (as today) | `worker/main` (as today) |

- Discussion folder names are dated (`2026-…`), so a branch name can't collide with `worker/main`
  or with other `worker/…` branches such as `worker/fix-insecure-randomuuid`. The name doesn't
  change when the discussion moves to `archive/` or `deferred/`.
- A lane is created at the discussion's first worker instruction, from the room's `HEAD`, by the
  same `ensureWorktree` code (`worktree add -b`). If the branch already exists, it is reattached. If
  something else is at the path, the lane refuses and changes nothing, as today.
- A brainstorm's tasks keep using today's `worker/main`. A brainstorm has no name or checkpoint, so
  it can't own a branch that is reviewed later. Its commits keep the `[brainstorm]` label, and you
  merge `worker/main` as you do now. Only one brainstorm is open per folder, so its lane is never
  shared. A task sent before a discussion's first message also runs here.
- The lane's queue keeps today's rules: one task at a time, in the order sent. **Different lanes
  run at the same time.** A folder-wide limit caps how many tasks run at once (see Cost below):
  a task waits for a free place, with "waiting: N worker tasks are running" in its tab.
- A lane hangs off the discussion, not off the context (the browser tab). The checkpoint stores its
  session (as now). The lane stays alive until it is idle, even when its discussion is no longer in
  use, so a running task finishes in its own lane. When it finishes, the lane updates the worker
  part of its discussion's checkpoint (session, log entries, task records), even if that
  discussion has since been closed or left.
- The Worker tab shows only the open discussion's own lane: its log, its worktree line and its
  running state. The header's "Worker is working" also becomes per discussion. The worker's
  provider and model stay one setting for every lane.

### Review and merge into main

- Each discussion's work is on its own branch, so you review and merge one discussion at a time:
  `git merge worker/<name>` in the room, in any order. You can merge part of the work by merging a
  given commit. Nothing is merged automatically.
- The Worker tab, and one line in Explorer, list the branches with commits that aren't in main
  ("worker/<name>: 3 commits not in main").
- I'd also add a read-only check of whether each branch still merges cleanly with main
  (`git merge-tree --write-tree main worker/<name>`, Git ≥ 2.38): "clean" or "would conflict in
  file A, file B". It writes nothing, so it fits the rule that agent-room's code never merges.
  Optional. This machine has Git 2.33.0, so it would need a newer Git. The `--is-ancestor` check
  below works on any Git.
- **Catching up after another branch is merged**, with today's rules applied per lane:
  - If `worker/<name>` is strictly behind main and its worktree is clean, it is fast-forwarded
    before its next task.
  - Otherwise, the next task tells its worker to merge main normally first. A clash is not forced:
    the worker reports it, and only *that* lane holds until it is resolved.
  - A branch with nothing to do doesn't catch up until its next task.
  - To bring a branch up to date without other work, you send its worker "catch up with main", as
    today.
  - Running in parallel means more conflicts *between* branches. They appear when the second
    branch catches up, and are resolved in that branch's worktree by its own worker. You never get
    a conflicted main.

### Merging a branch when main has moved

Tried on 2026-11-12 in a disposable repository (`/tmp/merge-lab`, Git 2.33.0). Nothing was tried in
the room or in my worktree. The results are quoted below.

**Before you run `git merge worker/<name>` in the room:**

1. **The lane is idle.** No task from that discussion is running or queued, so the branch doesn't
   move while you merge, and the worker's last report matches the branch.
2. **The room is clean.** `git status` shows no tracked edits outside `discussions/`. Agents'
   uncommitted notes in `discussions/` are fine. In the lab:
   - A merge that conflicted in another file left an unrelated uncommitted edit and an untracked
     file untouched, before and after `--abort`.
   - An uncommitted edit in a file that the merge changes makes Git refuse to start: `error: Your
     local changes to the following files would be overwritten by merge: app.txt … Aborting`
     (exit 128). Nothing changes.
3. **The branch contains current main, and was tested there.** `git merge-base --is-ancestor main
   worker/<name>` succeeds when the branch has caught up with main's latest commit. The worker's
   report names the commit at which `npm test` passed, and that commit is `worker/<name>`'s tip.
   Then your merge can't conflict. In the lab, the branch's worker merged main into its worktree
   and resolved the conflict there. The room's `git merge --ff-only worker/x` then printed
   `Fast-forward … 1 file changed` (exit 0). If main has moved since, ask that discussion's worker
   to "catch up with main and run `npm test`" first. agent-room could show this check in the
   branch's line in the Worker tab: "contains main" or "main has N new commits: catch up first".
   That is read-only, and works on any Git.

**Recognising a conflict.** If you merge without catching up and it clashes, Git says so at once:

```
Auto-merging app.txt
CONFLICT (content): Merge conflict in app.txt
Automatic merge failed; fix conflicts and then commit the result.
```

The exit status is 1. `git status --short` marks the files `UU`, and `git diff --name-only
--diff-filter=U` lists them. Nothing is committed: main is still at its previous commit until you
commit the merge.

**Recovering.**

- `git merge --abort` puts the room back as it was before the merge. In the lab it exited 0; `git
  status` again showed only the unrelated edit and the untracked file, and main was at its previous
  commit.
- Then ask that discussion's worker to catch up with main. It resolves the conflict in its own
  worktree, runs `npm test` and commits, and you merge again (now a fast-forward, as in point 3).
  Don't resolve it by hand in the room unless you want to: the conflict involves the worker's work,
  and its worker can rerun the tests.

**If the abort fails.** `git merge --abort` refuses when Git has lost the merge's state. In the
lab I deleted `.git/MERGE_HEAD` to reproduce it: `fatal: There is no merge to abort (MERGE_HEAD
missing).` (exit 128), with the `UU` file still there.

- `git reset --merge` then recovered it (exit 0). The conflicted file went back to main's version,
  and the unrelated uncommitted edit and the untracked file were kept.
- If that fails too, stop and look before doing anything else. `git status` and `git diff` show
  what is in the room.
- Don't use `git reset --hard` or `git checkout .` while you have uncommitted work of your own in
  the room: they discard it.
- agent-room itself never runs any of these. The rule that its code never merges or resets stays.

**Changes that merge cleanly but break behaviour.** Git can't catch these. In the lab, main renamed
`total` to `sum` in `lib.js`, while the branch added `report.js`, which calls `total`.

- `git merge --no-ff --no-commit worker/z` printed "Automatic merge went well" (exit 0).
- The merged code then failed: `TypeError: require(...).total is not a function`.
- They are caught in two places:
  - Point 3 above. The branch's worker runs `npm test` *after* merging current main, so the
    combination is tested before you merge. This is the main defence, and it is why "tested on
    top of current main" is a precondition.
  - If you merge without catching up, use `git merge --no-ff --no-commit worker/<name>`, run
    `npm test` in the room, then `git commit`, or `git merge --abort` (exit 0 in the lab; main
    unchanged).
- Tests only catch what they test. A combined change that no test covers can still slip through.
  The cross-origin notice ("[x] changed lib.js on worker/x") is the warning for that: two
  discussions changing the same files is worth a look before you merge the second one.

### Today's rules that assume one worktree

| Rule | With lanes |
|---|---|
| **Leftover-edits hold** (`blockedBy`, `hold`/`release`, the owner file) | Kept, but per lane. Uncommitted edits hold only their own lane, which can always recover them. "Other discussions' tasks wait" goes away. "Edits of unknown origin" can only happen in `worker/main` or in a lane edited by hand, and hold only that lane. The owner file is already per worktree (each worktree has its own Git directory); it now always names its own lane. |
| **Close / Archive / Defer refuse a discussion with unresolved worker edits** | Kept: the edits are in its lane. |
| **Defer guard** | Refuses while `worker/<name>` has commits not in main's history (any commit, since the branch is its own). During the transition it also checks the `[name]` commits still on `worker/main`. Squash merges remain unsupported. |
| **Rollback** | The rollback task runs in its own lane and commits on `worker/<name>`. The search for its implementation commits is unchanged: `[name]` commits on main, on its own branch, and old ones on `worker/main`. Looking for dependencies on other work now also means looking at *other unmerged branches*. The task text lists the current `worker/*` branches for that. Confirm archive needs only *its own* lane to be idle and its own lane's `HEAD` to equal the reported commit, not the whole folder's queue. |
| **Cross-origin commit notices** ("Work finished elsewhere") | Kept as a warning about overlap, with the branch: "[x] abc on worker/x, not in main yet (files…)". The work can no longer appear in another discussion's worktree uninvited, so it matters less. When a branch is merged, another notice could say "main now includes [x]". Optional. |
| **Catch-up with main** (fast-forward, or a "merge main first" instruction) | Unchanged, per lane. |
| **Unfinished merge or revert holds dispatch** | Unchanged, per lane. |
| **Rooms on one server in the same repository** (`sharedWorktree`) | Kept: the first room in a repository owns all its lanes. Otherwise two rooms could both create `worker/<name>` for different folders. |
| **Several open discussions share one worker** (README) | Replaced: "each open discussion has its own worker lane". |

### Restart, Resume, Start fresh, Close, Archive

- **Restart / Quit / crash.** The queues live in memory, as today. Each lane's interrupted, running
  and queued tasks are already recorded in its discussion's checkpoint (`work`). Resume and Restart
  report them per discussion, as now, and nothing is sent again. After a Restart, each reopened
  discussion recovers its own lane from its own owner file, so holds are restored per lane. Lanes
  of discussions that aren't reopened stay on disk untouched until they are resumed.
- **Resume** brings back the discussion's worker session *and* its lane (same path and branch).
  A lane's directory never changes. Both providers can resume a session from another directory
  anyway (tested, see Migration).
- **Start fresh** gives a new worker session in the *same* lane: the work in progress belongs to
  the discussion, not to the session. The new session is told its worktree, branch and label. If
  the lane has uncommitted edits, the first task gets today's recovery text, with the original
  task's details.
- **Close / Archive / Defer** never delete a lane. agent-room's code never deletes worktrees or
  branches (the User's decision, 2026-11-07). An archived discussion's merged lane stays until you
  remove it (`git worktree remove …`, `git branch -d worker/<name>`). The Worker tab could list
  merged lanes with that command. Removing them automatically is a separate decision.

### Cost and parallel `npm test`

- **Tokens and quotas.** Two lanes running at once spend twice as fast and use up the 5-hour and
  weekly windows sooner. The Usage panel and the per-provider warnings already show this. I
  propose a folder-wide limit as a constant in `src/ui.mjs` (`PARALLEL_WORKERS = 2`), not a
  setting, so that no new config is added. You can say if you want a different number or a
  setting.
- **Disk.** Each lane is a full checkout plus its own `node_modules` (3 MB here, not in Git). The
  worker has to run `npm install` in a new lane before `npm test`. The first instruction in a lane
  says so.
- **`npm test` at the same time** in two lanes:
  - Files don't clash. Each run gets its own temporary `HOME` (`package.json`), servers listen on
    port 0, and tests use `mkdtemp` folders. Each lane also has its own working copy.
  - The CPU does. Measured on 2026-11-12, at commit `4b6dbc5`:
    - One run alone: 178 pass, about 65 s, about 1.7 cores.
    - Then three times, two runs at once, in two separate clones under `/tmp` (each with a copy of
      `node_modules`):

      | Round | Clone 1 | Clone 2 | Wall time |
      |---|---|---|---|
      | 1 | 177 pass, **1 fail** (78 s) | 177 pass, **1 fail** (78 s) | 79 s |
      | 2 | 178 pass (82 s) | 178 pass (82 s) | 83 s |
      | 3 | 178 pass (79 s) | 178 pass (79 s) | 80 s |

    - The failure, the same in both clones in round 1: `test/rooms.test.mjs:11` "one server, two
      rooms: … independent rounds …", at line 119: `AssertionError: beta 2888ms, alpha 5914ms`
      (clone 2: `beta 4357ms, alpha 7320ms`). The test checks that beta's quick round ends within
      2,500 ms while alpha's slow round runs. Under the load of two suites, beta's round took
      longer. This is a timing limit in the test, not shared state: no other test failed, and the
      next two rounds passed.
    - So two parallel runs take about 25% longer each, and this test can fail now and then. The
      worker would see a red `npm test` that isn't its own doing. The fix belongs to that test
      (a wider margin, or measuring beta against alpha), and changing a test needs your approval.
      I'd do it in Step 1a, before anything runs in parallel.
  - Other projects' test suites may not be isolated in this way. That is up to each project.

### Is `terminal-worker-sessions-plan.md` still needed?

Its *goal* is still needed: in the terminal, `/new` and Resume must leave the old discussion with
its own worker session. This design achieves it in a different way, because the session is part of
the discussion's lane:

- **`/new` doesn't wait any more.** The old lane keeps its running and queued tasks and finishes
  them in its own session. The terminal's one context moves to the new discussion, whose lane
  starts with a fresh session. That removes that plan's main cost, which was blocking terminal
  input for up to 30 minutes per task.
- **Your four preferences, under this design:**
  - **Refuse `/new` and Resume with uncommitted worker edits:** no longer needed. The edits are in
    the old discussion's own lane and block nobody else; resuming it continues them. Close,
    Archive and Defer still refuse.
  - **A fresh worker session after a brainstorm:** needed as a behaviour, but it comes for free.
    The brainstorm's lane is `worker/main`, and the new discussion gets its own lane and session.
  - **Rewriting the tests:** still needed. They are the same `/new` tests, plus the
    shared-workshop tests below.
  - **A note while waiting:** no longer needed, because nothing waits.
- So I'd **not** build the terminal plan on its own unless you want its fix sooner than this
  design. As a stopgap it is still small and correct. Its waiting `/new` would then be undone by
  Step 1c below.

## Files

- **`src/ui.mjs`** (most of the change, about 200–300 lines touched in its roughly 450-line worker
  part):
  - `workerPlace` becomes per lane (path and branch); `WORKER_BRANCH` becomes a default.
  - `ensureWorktree`, `worktreeStatus`, `catchUp` and `worktreeLines` take the branch.
  - `newShop`/`shopOf` become a folder-level registry of lanes and the parallel limit.
  - `pump`, `hold`, `release`, `leftovers`, `recordedOwner` and `recoverWorkerOwner` work per lane.
  - Also: `queueWork`/`runWork` (the briefing names the branch; the lane's own agent), `workerHold`,
    the Defer guard in `moveDiscussion`, `rollbackTask`, `confirmRollbackArchive`, `workNotice`,
    `refreshWorker`, `stopRoom`, the checkpoint's worker part (written by the lane), and
    `newDiscussion`/`leaveSession` (no waiting, no `worker.reset` on the context).
  - In `load` (line 206), the worker agent moves from the context to its lane.
- **`src/docs.mjs`**: the Worker tab shows one lane (log, worktree line, working state, the
  "waiting for a free place" line), and Explorer's "commits not in main" line. About 30–60 lines.
- **`README.md`**:
  - "The worker's worktree" is rewritten for lanes, with merging several branches.
  - Also: "Several open discussions" (sharing one worker), "New discussion in the terminal", the
    `/new` row, "Every discussion saves itself" (the lane updates its checkpoint) and the rollback
    text.
  - About 40–60 lines.
- **`README-for-worker-agents.md`**: "on the branch `worker/main`" becomes "on your discussion's
  branch, which your first instruction names". Merging main and rollback then refer to that
  branch, and a new lane needs `npm install`. About 6 lines.
- **`src/cli.mjs`**: probably only the Restart/addRoom wiring, if the lane registry must survive a
  Reload like `shop` does. A few lines.

## Tests

`test/ui.test.mjs` has 38 tests that involve the worker. Under the project rules, the changes to
existing tests need your approval first.

- **About 20 change only their expectations about paths and branches:** `.worker` →
  `.workers/<name>`, `worker/main` → `worker/<name>`. Examples: the creation, reattach, refusal,
  catch-up, scratch notes, rollback and interrupted-task tests.
- **About 8 change their contract** because the workshop is no longer shared:
  - "one shared worker queue …" (1325)
  - "leftover edits hold the shared queue for their origin …" (1361)
  - "Stage 3: a worker merge conflict holds other origins …" (1702)
  - "Stage 2: completed work is reported once …" (1540)
  - "Stage 2: Defer refuses labelled commits …" (1581)
  - "failed worktree inspection blocks …" (1880)
  - the `/new` tests at 442, 482 and 719
  - the auto dev `/new` test (1210)
- **About 8 new tests:**
  - Two discussions' tasks run at the same time; the limit holds a third.
  - Edits in one lane don't hold another.
  - `/new` in the terminal doesn't wait, and the old lane finishes and updates its checkpoint.
  - Resuming continues the discussion's own session and lane.
  - Start fresh keeps the lane.
  - A brainstorm uses `worker/main`, and the next discussion gets a fresh lane.
  - The Defer guard works per branch.
  - The rollback task lists the other `worker/*` branches.
- `test/docs.test.mjs` and `test/screen.test.mjs`: a few Worker-tab expectations.

## Size and a simpler first step

The whole design is medium to large: roughly a quarter of `src/ui.mjs`'s worker code is
rewritten, with about 30 tests touched and 8 added.

### Step 1 can be split; parallelism belongs with its second slice

Yes, Step 1 splits into three slices. Each one leaves `npm test` green and can be tried in the app
on its own.

1. **Step 1a: a worktree and branch per discussion. Nothing else changes.**
   - A discussion's task runs in `<repo>.workers/<name>/` on `worker/<name>`. A brainstorm, and a
     task sent before the first message, run in `<repo>.worker/` on `worker/main`.
   - The folder still has one shared queue, one task at a time, and the shared hold. The hold is
     stricter than it needs to be once worktrees are separate, but still correct.
   - The Defer guard and the catch-up rules are applied to the task's own branch, the briefing
     names the branch, and the worker rulebook changes.
   - Also: the "contains main" line, and widening the timing limit in `rooms.test.mjs` (with your
     approval).
   - Tests: mostly the about 20 changes of paths and branches, plus "two discussions commit on two
     branches", "a brainstorm uses `worker/main`" and the Defer guard per branch.
   - About 80–120 lines in `src/ui.mjs`. This alone gives you review and merge per discussion.
2. **Step 1b: a queue and hold per lane, two at once.**
   - `pump` schedules per lane, with the folder-wide limit.
   - `hold`/`release`/`leftovers` work per lane.
   - Also per lane: `confirmRollbackArchive`'s idle check, rollback's list of other branches, and
     the notices with the branch.
   - The about 8 tests whose contract changes, and the concurrency tests.
3. **Step 1c: the session belongs to the lane.**
   - The worker agent and session move from the context to the lane. The lane updates its
     checkpoint when it finishes a task after its discussion has been left.
   - Terminal `/new` and Resume no longer wait.
   - The `/new` tests, and "Resume continues its own session and lane". This replaces the
     terminal plan.
   - It mostly concerns the terminal, where one context changes discussion. On the screen, each
     discussion already has its own context and worker session. So it can come last.

**Should two tasks at once come with Step 1?** Yes, with Step 1b, not after it.

- 1b is where per-lane state replaces the shared `shop.running`, `shop.blockedBy`,
  `shop.workingIn` and `screen.working`.
- A leftover shared field only shows up when two tasks really overlap. Tests that run with the
  limit at 1 would never find it.
- So 1b's tests should run two lanes at once from the start, with a few fixed cases:
  - two tasks overlap;
  - one lane holds while the other runs;
  - a rollback runs in one lane while the other commits;
  - a Restart comes while both run.
- The default limit can still ship at 1 if you want to watch the cost first. The code and tests
  would already handle 2, and raising it changes one constant. I'd ship it at 2, since parallel
  running is the aim.
- 1a can't run in parallel: it keeps the shared queue on purpose, to stay small.

**Migration** (for Step 1a):

- Before switching, merge or settle today's `worker/main`. It has no commits outside main right
  now.
- Then each discussion's next task runs in its new lane, with its saved worker session. Both
  providers resume a session from another directory, as tested on 2026-11-12 in two new folders
  under `/tmp`.
- **Codex** (`codex-cli 0.163.0`):
  - A session started with `codex exec --json …` in folder A (thread
    `01a1ce95-…`) was asked to remember PELICAN-42. Its `pwd` printed `/tmp/cxr/a.KFEf`.
  - It was resumed from folder B with `codex exec resume --json … 01a1ce95-… -`. That exited 0,
    with the same thread ID.
  - Its reply: "The word was **PELICAN-42**. The current working directory is
    `/tmp/cxr/b.Sa4L`". Its own `pwd` ran in B.
- **Claude** (`Claude Code 2.1.319`): a session started with `--session-id` in A (remembering
  HERON-17) and resumed with `--resume <id>` from B replied `HERON-17` (`is_error: false`, same
  session ID). The session's file stayed in A's project folder under `~/.claude/projects/`, and
  B's project folder got none. So Claude finds a session by its ID, wherever it was started. My
  earlier statement in this plan, that Claude can't resume from another directory, was wrong.
- **So no fresh session is needed:**
  - The saved session continues, and the first task in the lane is briefed with its new
    worktree and branch. `workerTree` differs, so today's code already sends that briefing.
  - The session still remembers the old path `<repo>.worker/` from earlier turns. The briefing
    has to say plainly that it replaces it.
  - The test is a single provider version on this machine, and a future CLI version could
    change it. If the first task in the lane fails to resume, the error appears, as today, and
    Start fresh is the way out.

## Not checked

- The optional merge preview: this machine has Git 2.33.0, which lacks `git merge-tree
  --write-tree` (it needs 2.38). The preview would need a newer Git, or should be dropped.
- Three or more parallel `npm test` runs, or runs while the agents are busy. I measured two at a
  time, three times, with nothing else heavy running.
- Whether the `rooms.test.mjs` timing failure also happens with one run alone on a busy machine.
  I didn't measure it.
- Resuming across directories with other provider versions. I didn't check either of these
  either:
  - a Codex session that had already run tools in its first directory (mine had run `pwd`
    only);
  - a session with many turns.
- How the agent-room tests behave inside a real worktree under `<repo>.workers/`. The parallel
  runs were in clones under `/tmp`.
