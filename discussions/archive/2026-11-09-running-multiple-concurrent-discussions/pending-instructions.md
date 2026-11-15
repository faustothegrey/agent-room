# Pending worker instructions

None pending.

## Sent: Note the Start fresh usage limit in the README (drafted by Claude, 2026-11-12; sent by auto dev; `d9e6e3f`)

> The User accepted (2026-11-12) as a known limit that, after Start fresh, a worker task still
> running from the old session isn't counted in any discussion's totals. Say so in the README,
> where Start fresh is described, in one or two sentences, and nothing else. Commit on your
> branch with this discussion's label; no test run is needed for a README-only change.

## Withdrawn (the User accepted the limit instead): Keep an old session's usage after Start fresh (drafted by Claude with Codex's point, 2026-11-12)

> After Start fresh, a worker task still running from the old session loses its token usage:
> it reaches neither the old nor the new totals. Keep that usage with the old session, without
> restoring that session and without touching the new checkpoint (for example, in the old
> session's transcript, where its report already goes), and say where the User can see it.
> Test it: Start fresh while the old task runs; its usage appears there, and the new totals and
> checkpoint are unchanged. Commit on your branch with this discussion's label, run `npm test`
> once, report its real output, and end with the `Tested:` line.

## Sent: Fix two gaps in slice 1c (drafted by Claude from Codex's review, 2026-11-12; sent by auto dev; `0bdd64d`)

> Codex's review of `ae83a60` found a blocker: when an old task leaves uncommitted edits after
> the room has switched discussion, the hold is recorded with the currently active discussion's
> label instead of the discussion that sent the task, so A's edits can be attributed to B. Fix
> it so a hold always names the task's own discussion and worktree, and test it: A's task leaves
> edits after switching to B; the hold names A, only A's instructions may resolve it, B's
> queue isn't held, and B's worker never receives a recovery instruction for A's worktree just
> because both tasks came from the same terminal context: the check must use the discussion's
> identity, not its displayed label or the context. Also add a kept-aside worker's token usage to its own discussion's totals
> (and its checkpoint), with a test. Look for other places that use the active discussion where
> the task's own discussion is meant, and list them. Commit on your branch with this
> discussion's label, run `npm test` once, report its real output, and end with the `Tested:`
> line.

## Sent: Build slice 1c (drafted by Claude with Codex's safeguard, 2026-11-12; sent by auto dev; `ae83a60`)

> Build slice 1c of `parallel-worker-plan.md`: the worker session belongs to its discussion
> everywhere, the terminal (`--no-screen`) included. In the terminal, `/new`, Resume and Start
> fresh no longer wait for the worker tasks of the discussion in use: those tasks finish in that
> discussion's own lane and session, their reports go to its transcript and checkpoint, and the
> discussion switched to gets its own worker session (its saved one, or a fresh one). A
> brainstorm's worker session is never carried into a discussion. This replaces
> `terminal-worker-sessions-plan.md`. Add a test that, in the terminal, starts a worker task,
> switches with `/new` before it ends, sends a task in the new discussion, then resumes the
> first: each report reaches its own discussion, and each discussion continues its own worker
> session. Add a second test for Start fresh on the same discussion while its old worker task
> still runs: when that task ends, its report and checkpoint update must not overwrite the new
> worker session or make the discussion resume the old one; say where the old task's report
> goes. The User approved rewriting existing tests whose expected behaviour changes: list
> each one and why. Update the README. Keep the task well under 30 minutes: run `npm test`
> once, report its real output, and end with the `Tested:` line.

## Sent: Same PID-file fix in `test/ui.test.mjs` (approved by the User; sent by auto dev on 2026-11-12, `fc0ca68`)

> Apply the fix from `4090bdc` to the test around `test/ui.test.mjs:1614` and `1624`: its fake
> `claude` writes its ID to a temporary file and renames it into place, and the test asserts the
> file exists and the ID is positive, with a clear message. Change nothing else. Commit on your
> branch with this discussion's label, run `npm test` twice, report the real output of each run,
> and end with the `Tested:` line.

## Sent by the User by hand (2026-11-12, from two discussions): the 1b live trial (drafted by Claude)

Send the same text from this discussion's Worker tab and, right after, from another open
discussion's Worker tab:

> Live trial of parallel workers, changing nothing: run `date`, `pwd` and
> `git branch --show-current`, then `sleep 90`, then `date` again. Report the four results
> exactly as printed, and whether your session remembers any earlier task.

None pending.

## Sent: Refuse every reload from 1a's workshop (drafted by Claude with Codex's conditions, 2026-11-12; sent by auto dev, cycle 2; `7b1dda5`)

> Codex's review found another reload case: with three open discussions, after the first
> converts the workshop, the other two still share 1a's single working-directory setting, so
> two tasks sent to them before their own reloads could run at once in the wrong worktree.
> Instead of handling each case, replace the conversion: a Reload (including `--dev`'s automatic
> one) that finds a workshop built by 1a's code is always refused, in every room, with the
> message "This update changes the worker's queues: Restart to apply it (Reload can't)."
> The refusal must happen before any shared workshop state changes, and the same applies when
> a discussion is opened beside the others in that folder: a new context must not attach 1b's
> code to the old workshop. Remove the conversion and the shim from `d0d42ae` and `c53de25`
> if they are no longer needed, keeping their tests' cases as refusal tests through the real
> reload path (idle, busy, held, failed inspection, two and three open discussions, and opening
> a new discussion): after a refused reload, every existing context and its worker tasks stay on
> 1a's code and work as before. Also check that a fresh start then loads 1b normally. Commit on your branch with this discussion's label, run `npm test`
> once, report the real output, and end with the `Tested:` line.

None other pending.

## Sent: Test the reload race with several open discussions (drafted by Claude from Codex's review, 2026-11-12; sent by auto dev; race reproduced and fixed in `c53de25`)

> Codex's review suspects a race in `d0d42ae`: discussions in one folder share the workshop,
> but Reload switches their contexts to the new code one at a time; converting the workshop for
> the first context removes the old `tasks` field while another context may still run 1a's code
> and receive a worker instruction. Write a test with two open discussions in one folder that
> goes through the real reload path and sends a worker instruction to the second one between
> the two switches. Report whether the race happens, with the real output. Fix it only if it
> does and the fix is small; otherwise report and stop. Commit any test or fix on your branch
> with this discussion's label, run `npm test` once, and end with the `Tested:` line.

## Sent: Reload from the old workshop to 1b's lanes (drafted by Claude from Codex's review, 2026-11-12; sent by auto dev, cycle 4; `d0d42ae`)

> Codex's review found a risk in slice 1b: Reload (and, if it applies, the automatic reload
> when source files change in `--dev` mode, possibly when the User merges into main: check
> whether a merge triggers it) keeps the old in-memory workshop
> while loading the new scheduler, which starts with an empty `lanes` map; the old workshop's
> running and queued tasks don't seem to be carried over. Reproduce it with a test: an old-style
> workshop with a running task and a queued one, then a reload into 1b's code. Then either carry
> them over safely, or make the reload refuse (or wait) with a clear message until the worker is
> idle, whichever is smaller. Also check that an old workshop with no running task converts
> cleanly when it is idle, when it holds a worktree for uncommitted edits, and when a worktree
> inspection failed: a hold must never be lost, so no task starts over unresolved edits. Commit on
> your branch with this discussion's label, run `npm test` once, report the real output, and end
> with the `Tested:` line.

## Sent: 1b test runs and timing (drafted by Claude, 2026-11-12; sent by auto dev, cycle 3; four runs passed)

> Without changing code or tests: run `npm test` on main (`fc0ca68`, in a throwaway clone or
> worktree) and on your branch (`76a88f5`) back to back, alternating, two runs each, so four
> runs in all. Record `uptime`'s load averages just before each run. Report a table with commit,
> result (tests, pass, fail), time and load for each run, and the real failure output if any
> run fails. If the four runs would take more than 20 minutes in all, stop after two (one each)
> and report. Also say what you meant by having "reduced" the race in `test/screen.test.mjs`:
> your three commits don't change that file, so name the change and its commit, or correct the
> statement. End with the `Tested:` line for your branch.

## Sent: Resume slice 1b after the timeout (drafted by Claude, 2026-11-12; sent by auto dev, cycle 2; 1b complete at `76a88f5`)

> Your slice 1b task stopped at the 30-minute timeout. Your worktree is clean, with three
> commits after `fc0ca68` (`710439c`, `81f697c`, `76a88f5`). Say what each contains, what you
> were doing when the timeout came (if you know), and which parts of the 1b instruction are
> done and which are missing. Then, in steps that each stay well under 30 minutes: finish and
> commit whatever is missing, run `npm test` once, report its real output with the `Tested:`
> line, and stop. Leave the second run and the timing of main against your branch for a
> following task. Don't discard anything without asking.

## Sent: Build slice 1b (drafted by Claude with Codex's point, 2026-11-12; sent by auto dev on 2026-11-12; timed out after 30 minutes)

> Build slice 1b of `parallel-worker-plan.md`: each discussion's lane gets its own queue and its
> own hold for leftover edits, and different lanes run at the same time, up to one constant
> limit for the folder, `PARALLEL_WORKERS = 2` (the User's decision). A task waiting for a free
> place says so in its Worker tab. Keep within a lane one task at a time, in order; keep the
> brainstorm lane on `worker/main`; keep every 1a guardrail working per lane. Add a test that
> really overlaps two discussions' worker tasks and checks that their queues, holds, worker
> sessions and worktrees stay separate while both run, that a hold in one doesn't stop the
> other, and that a third task waits for a free place. The User requires (2026-11-12) being
> able to switch discussion while one waits for its worker task, with one discussion clearly
> active per window, the target of what is typed there (as the current model does; add no new
> mechanism for it): add a test that starts a worker task
> in one discussion, switches to another before it finishes, sends a message there, and checks
> that the message and the worker's later report each reach their own discussion; say whether
> anything today blocks such a switch. The User approved rewriting existing
> tests whose expected behaviour changes: list each one and why. Update the README. Run
> `npm test` at least twice, report the real output of each run, and end with the `Tested:`
> line. Also measure the suite's time on main and on your branch back to back, noting the
> machine's load for each run (for example `uptime`'s load averages).

None other pending. The instructions below were sent; kept for reference only.

## Sent: Fix the empty PID-file reads in the tests (drafted by Claude, 2026-11-12; approved by the User; sent by auto dev on 2026-11-12, `4090bdc`)

> Fix the test fault found in `child-process-test.md`, changing tests only. In
> `test/rooms.test.mjs`, "stopping a room kills provider child commands even after the provider
> exits": make the test's fake provider write the PID to a temporary file and rename it into
> place, so a reader never sees an empty or partly written ID (such as `12` while `123` is being
> written); then keep reading until the file exists and assert `child > 0` with a clear message.
> Also check the two similar reads around lines 157 and 416; fix them the same way only if they
> can read an empty or partly written file, and say why for each. Don't change agent-room's code. Commit on your branch with this discussion's label, run
> `npm test` at least twice, report the real output of each run, and end with the `Tested:`
> line.

## Sent: Child-process test investigation, also the live trial of 1a (drafted by Claude, 2026-11-12; sent by auto dev on 2026-11-12, no commit)

> Investigate, without changing code or tests: "stopping a room kills provider child commands
> even after the provider exits" (`test/rooms.test.mjs`, around line 403) failed once in a
> full `npm test` run (`AssertionError: Missing expected exception`: the child looked alive
> just after the room stopped) and passed alone six times. Find the cause: check your guess
> that the test can read the child's process-ID file before it is written (an ID of 0, and a
> check on process 0 always succeeds), and also whether a child can really outlive its room
> for a moment. Reproduce under load if you can, and report the real output. Propose a fix,
> saying whether it changes the test (that needs the User's approval) or agent-room's code.
> Write your findings in this discussion's folder as `child-process-test.md`. Also report: the
> worktree and branch this task ran in, and whether your worker session continued from
> earlier tasks (what you remember of slice 1a's instruction).

The two below were sent by auto dev on 2026-11-12 (`bc43f52` and `bf64c4e`); kept
for reference only.

## Sent: Two approved test changes (drafted by Claude, 2026-11-12; approved by the User: "Authorized")

> The User approved (2026-11-12) both test changes you proposed. 1. In `test/rooms.test.mjs`
> (around line 119), replace `betaDone < 2500 && alphaDone >= 3000` with
> `betaDone < alphaDone && alphaDone >= 3000`, keeping the assertion message accurate. 2. In
> `test/ui.test.mjs`, "leftover edits hold the shared queue …": replace the fixed 300 ms wait
> with `until` waiting for the hold to appear. Change nothing else. Commit both on `worker/main`
> with this discussion's label, run `npm test` at least twice, and report the real output of
> each run.

"Build slice 1a" below was sent by auto dev on 2026-11-12 (`bf64c4e`, 183/183 per
the worker); kept here for reference only.

## Sent: Build slice 1a (drafted by Claude with Codex's points, 2026-11-12)

> Build slice 1a of `parallel-worker-plan.md`. The User approved (2026-11-12) building 1a, then
> 1b, then 1c, each merged and tried before the next, and rewriting the existing tests whose
> expected behaviour changes. First, if you can, update Git on this machine to 2.38 or newer
> (the User allowed it); report the method and the version, or why you couldn't. Slice 1a: a
> worktree `<repo>.workers/<name>/` and branch `worker/<name>` per discussion, still with the
> folder's one shared queue; a brainstorm, or a task before a discussion's first message, keeps
> `<repo>.worker/` on `worker/main`. Migration: preserve existing `worker/main` commits not in
> main (never drop or rewrite them), refuse to migrate while `<repo>.worker/` has uncommitted
> edits, and let a discussion's saved worker session continue, briefed that its worktree path
> changed. Guardrails (the User asked for as many as possible): the Worker tab shows, per
> branch, whether it contains current main, naming the exact main and branch commits it was
> last tested on, and rechecks them when shown; after merging main into its branch, the worker
> runs `npm test` and reports the real output; if Git is 2.38 or newer, an advisory merge
> preview (`git merge-tree --write-tree`) says "clean" or which files would conflict; it changes
> no branch, worktree or index, but writes unreferenced Git objects (left for Git's own cleanup;
> say so in the README),
> marked as advice that can go stale and that doesn't prove the combined code works; with an
> older Git it is not shown. In the README, describe `git reset --merge` only as what worked in
> one tested case after a failed `git merge --abort`, not as always safe. Don't change the time
> limit in `test/rooms.test.mjs:119` yet: explain what it protects and propose a justified
> change for the User's approval. List each existing test you rewrite and why. Run `npm test`,
> report its real output, and commit on your branch with the discussion label.

Sent earlier (none other pending): sent by auto dev on 2026-11-12 (cycle 2): "Revise
`parallel-worker-plan.md`, without changing agent-room's code. 1. Check whether a Codex…" (the
four checks). Earlier on 2026-11-12, sent by auto dev: "Plan, without changing code. The User
wants fully parallel discussion management (2026-11-12)…" (plan in `parallel-worker-plan.md`)
and "Plan, without changing code. The User's aim (2026-11-12) is fully parallel discussion
management…" (plan in `terminal-worker-sessions-plan.md`). Sent by auto dev on 2026-11-11: "Fix
the recovery gaps of part (b)" (ca70cf9) and "Build part (b) of continue-by-default" (52bebe6).
Sent: "Build part (a) of continue-by-default" (2026-11-10; 3b0c60d). Sent by auto dev on
2026-11-10 and 2026-11-09: the plans, stages and fixes listed in `notes.md`.
