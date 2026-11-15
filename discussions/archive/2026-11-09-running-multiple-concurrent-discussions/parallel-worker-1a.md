# Slice 1a built: a worktree and branch per discussion (worker, 2026-11-12)

Slice 1a of [parallel-worker-plan.md](parallel-worker-plan.md), on `worker/main`. The commit ID is
in the worker's reply.

## Git on this machine

`/usr/local/bin/git` was Git 2.33.0, from an old installer package in `/usr/local/git`. Homebrew
already had Git 2.54.0 installed, but it wasn't linked.

- **The switch:** `brew link --overwrite git`. It replaced only the old installer's symlinks in
  `/usr/local/bin` and `/usr/local/share/man`; `/usr/local/git` itself is untouched.
- **The old config:** the old Git's system config (`/usr/local/git/etc/gitconfig`) had aliases,
  `core.excludesfile`, `push.default` and includes. To keep them, I added `[include] path =
  /usr/local/git/etc/gitconfig` to Homebrew's `/usr/local/etc/gitconfig`. A copy of that file from
  before the change is in `/tmp/brew-gitconfig.before`.
- **Result:** `git --version` gives `git version 2.54.0`. `git config --get alias.s` gives
  `status`, `core.excludesfile` gives `~/.gitignore`, and `credential.helper` gives `osxkeychain`.
- **To undo:** `brew unlink git`, then recreate the old symlinks to `/usr/local/git/bin/…`.

## What changed

- **Lanes:**
  - A discussion's tasks run in `<repo>.workers/<name>/` on `worker/<name>`. The lane is created
    from the room's `HEAD` at its first task, and reattached after that.
  - A brainstorm, and any task queued before the first message, run in `<repo>.worker/` on
    `worker/main`. The lane is chosen when the task is queued.
  - Everything else is unchanged: one shared queue, one task at a time, the shared hold. The
    owner record and leftovers checks are per worktree. The hold scans every lane, and a recovery
    task runs where the edits are.
- **Migration:**
  - Commits on `worker/main` are never moved, dropped or rewritten.
  - A discussion's lane is not created while `<repo>.worker/` has uncommitted edits, or while
    `worker/main` has that discussion's labelled commits not in main. Its task then fails with the
    reason, and nothing changes.
  - Saved worker sessions continue. The first task in a new worktree is told "Your worktree has
    changed: until now you worked in …; from now on you work in …, on the branch …".
  - A folder name that can't be a branch name (a space, say) gets no worktree, with the reason.
- **Guardrails** (Worker tab: the lane of the discussion shown first, then every other lane with
  commits not in the room or uncommitted edits). For a branch with commits not in main:
  - **Contains main:** whether it contains main's current commit, naming it, or how many of main's
    commits it lacks.
  - **Last tested:** the commits its worker last reported testing. This comes from the reply's last
    `Tested: <branch commit> with main <main commit>: tests passed|failed` line. It is recorded in
    the worktree's private Git directory only if Git agrees, otherwise a ✗ note says why. The tab
    says "Still current." or "Out of date: … is now at …".
  - **Merge preview:** with Git 2.38 or newer, `git merge-tree --write-tree --name-only
    --no-messages` gives "clean" or "would conflict in …", marked as advice. It is not shown with
    an older Git.
  - **When rechecked:** after each task (the task now counts as done only after this refresh), and
    whenever the Worker tab is shown (`POST /__workerinfo`).
  - **After merging main:** the merge instruction now asks the worker to run the project's tests
    (npm test, if it has them), report their real output, and end with the `Tested:` line. The
    worker rulebook says the same.
- **Also per lane:**
  - The Defer guard: any commit on `worker/<name>` not in main, plus that discussion's labelled
    commits still on `worker/main`.
  - Rollback: it works on `worker/<name>`, also searches `worker/main` and looks at other
    `worker/*` branches for dependencies. Its archive confirmation checks its own lane.
  - The interrupted-task reports.
  - The auto dev "finished" note.
- **README:** "The worker's worktrees" is rewritten, including merging a branch into main.
  `git reset --merge` is described only as what worked in the one tested case, not as safe. The
  README also says that the preview writes Git objects nothing refers to, which Git's own cleanup
  removes. **Worker rulebook:** your own branch, its change of path, and the `Tested:` line.

## Existing tests rewritten (approved by the User, 2026-11-12)

All in `test/ui.test.mjs`. Each one now expects the discussion's own lane instead of `worker/main`:

1. "auto dev: Start relays the instruction …": the finished note names `worker/<name>`.
2. "auto dev: while paused, any agreed summary ending in Outcome: FINISH …": the same.
3. "one shared worker queue …" (renamed "… one worker session and lane each …"):
   - the commit instruction names `worker/<name>`;
   - the last task ran in `.workers/<name>`;
   - new: each discussion's commit is on its own branch.
4. "leftover edits hold the shared queue …": the recovery text says "`worker/<name>` was at …".
5. "Stage 2: Defer refuses labelled commits absent from main …": the message names
   `worker/<name>`, and the User merges `worker/<name>`.
6. "Stage 3: a diverged clean worker is instructed to merge main …": the merge instruction names
   `worker/<name>`. New: it asks for the tests and the `Tested:` line.
7. "Stage 3: clean merge, revert and sequencer states hold dispatch …": `workerPlace` is asked
   for the discussion's lane.
8. "Stage 3: rollback includes merged implementation …": the User merges `worker/<name>`.
9. "Stage 3: an ambiguous or failed rollback report …": `worker/<name>` instead of `worker/main`.

New tests:

- in `test/ui.test.mjs`:
  - "each discussion works in its own lane …";
  - "a task queued before the discussion's first message stays on worker/main …";
  - "migration: a discussion's lane waits …";
  - "the Worker tab checks each branch …", which covers the preview changing no ref, status or
    index, and runs with or without Git ≥ 2.38;
- in `test/docs.test.mjs`: "showing the Worker tab asks the room to recheck its branches …".

## `npm test`

- **Final run on this branch:** 183 tests, 183 pass, 0 fail (106.9 s).
- **The run before it:** 1 failure, in "leftover edits hold the shared queue …" (`actual: [ false,
  undefined ]`, `expected: [ false, null ]`).
  - **The same failure on main:** main itself (`4b6dbc5`, in a throwaway clone, run right after)
    fails the same assertion: 177 pass, 1 fail, 84.8 s.
  - **Cause:** that test waits a fixed 300 ms for a hold to appear, while a new task can wait up
    to the 2-second recheck to be picked up. So it fails now and then, on main too, when the
    machine is busy.
  - **The fix:** waiting with `until` instead of a fixed 300 ms would remove it. That changes the
    test, so I haven't done it.
- **Speed:** main took 84.8 s this time and this branch 106.9 s. The lanes add Git calls: the tab's
  checks after each task, and scanning every lane before a task. To reduce them, I cache the
  repository's top folder and compute each lane's lines once per refresh. Without that, the run
  took 157 s.

## Proposal for `test/rooms.test.mjs:119` (not changed)

The test "one server, two rooms: … independent rounds …" checks that a slow round in one room doesn't
hold up a round in another room on the same server.

- **How it checks:** alpha's fake agents sleep 3 s, while beta's reply at once. The test asserts
  `betaDone < 2500 && alphaDone >= 3000`.
- **What fails under load:** the 2,500 ms limit. Beta's round still spawns three fake CLI
  processes (a title and two agents), and with two test suites at once that took 2,888 and
  4,357 ms.
- **The change I propose:** `assert.ok(betaDone < alphaDone && alphaDone >= 3000, …)`.
  - If beta's round waited for alpha's, it would start only after alpha's ended, so `betaDone`
    would be greater than `alphaDone`. "Beta finished first" therefore tests exactly the claim,
    without a clock limit that a busy machine can break.
  - In the failing runs this would have passed (beta 2,888 ms vs alpha 5,914 ms, and 4,357 vs
    7,320).
  - It is slightly weaker only if beta were somehow served first by a server that still runs
    rounds one at a time. beta is posted after alpha, so that can't happen here.
- Waiting for your approval.

## Not checked

- The app in a real browser: no manual try of the Worker tab's new lines or of the recheck when
  the tab is shown. Only the endpoint and the source are tested.
- A real provider turn producing a `Tested:` line. The tests use a scripted worker.
- A real migration of this room. `worker/main` has no commits outside main now, so the first task
  of each discussion will create its lane from main.
