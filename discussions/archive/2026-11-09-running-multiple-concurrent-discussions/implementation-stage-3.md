# Stage 3 implementation

Started from a clean worker/main at 9698144; no interrupted edits or later commits were found.
No reset, branch recreation, merge into main or push.

## Built

- `src/ui.mjs`, `runWork`: when main has commits the worker lacks, the task asks the worker to merge main normally before its work, label any merge commit, stop on a clash and leave it for origin-specific recovery. The safe strictly-behind fast-forward remains to preserve its existing test contract; no new agent-room normal merge/revert is executed. Even if that fast-forward just caught up, main's advance is mentioned in the task. Rollback skips this automatic fast-forward so ambiguity can be assessed before files change.
- `worktreeStatus`: MERGE_HEAD, REVERT_HEAD and sequencer state count as unfinished work even with empty status output. Existing hold, private owner record, startup restoration and recovery paths apply; the Worker info also names the operation. Recovery prompts explicitly require resolving the existing operation rather than starting another over it.
- Commit-label warnings exclude history already on main at dispatch, so bringing existing main commits into the worker does not misreport them as newly authored worker commits.
- `requestRollback`, `rollbackTask`: `/rollback <discussion>` queues an ordinary task on the target origin (opens a context for it if needed, without switching the window). Paused discussions must be resumed explicitly; their saved Pause is not silently discarded. It pauses the origin's auto dev. The task requires preflight of all labelled history, including merged implementation, earlier rollbacks/reverts and dependencies, before edits. It excludes catch-up merges and already-undone work; unclear history or unsafe dependencies must be reported before changes. Then it brings in main when necessary, reverts newest first, runs npm test, commits and reports real output and limits. No automatic dependency analyser or automatic Git revert was added: that reasoning/work is explicitly the worker task.
- Rollback commits use `[origin] rollback`, `Agent-Room-Rollback-Origin: <origin>`, and `Agent-Room-Reverted: <full implementation ID>` trailers. A no-op repeated rollback must not restore removed work; it can make a labelled empty rollback commit and explain why. The prompt also requires inspecting standard revert records and ambiguous older history, not trusting trailers/labels alone.
- `rollbackReport`: the full result stays in the Worker tab/transcript and also appears as a Discussion message (without starting agents). A final `Rollback ready: <full ID>` only enables archive confirmation if HEAD is that labelled rollback commit, has the origin trailer, and has no edits or operation in progress. This validates provenance/state, not the semantic correctness of the worker's report.
- `confirmRollbackArchive`: `/archive-rollback <discussion>` is the separate explicit User confirmation. It checks worker state has not changed and the queue is idle; dispatch is held during the check/move. Existing Archive guards still apply (switch away from the target before confirming; no paused/busy/held origin). Ordinary Archive cannot bypass a pending rollback report. Main is untouched until the User merges normally.
- `src/docs.mjs`: separate **Archive with rollback** button, report disclosure, and **Confirm archive after rollback**. Queueing and confirming each take two clicks. Received-only lines do not gain a rollback control. Existing Archive action is retained.
- Rollback state/report survives Reload in the shared workshop. Restart loses its in-memory confirmation; request a fresh rollback report. Any unfinished Git work remains protected by Stage 2's private owner record. A dropped queued rollback becomes “needs review” rather than staying permanently queued.
- README and worker rulebook updated; no module, dependency, config system or process added.

## Validation

Six new tests in test/ui.test.mjs; existing test bodies/contracts unchanged:

1. Real disposable diverged Git history, with a scripted worker doing the requested merge; main unchanged and imported main commits not falsely flagged.
2. Actual merge conflict holding the other origin until recovery, retaining the original private record.
3. Clean merge/revert/sequencer marker fixtures holding dispatch and restoring their ownership after queue-state recreation.
4. Real disposable history with an implementation normally merged into main, rollback/repeated rollback, fixture npm test output, untouched main until the fixture User merge, explicit archive confirmation, and stale report rejection.
5. An ambiguous/non-rollback commit marker does not authorize archive.
6. The page's actual helper code with DOM stand-ins: two clicks to queue, report disclosure, separate two-click confirmation, in-use guard.

First full npm test run: 147 passed, 0 failed/cancelled/skipped, 50046.869827 ms.
Final full run and commit: recorded below after completion. git diff --check was clean.

## Not checked / limits

No real providers/worker, browser rendering, actual process Restart/crash with a Git operation, cross-machine replication, or deployment. Git/history tests use scripted workers and disposable repositories; marker-only clean operations are fixtures. The rollback test runs npm test in a small fixture project, not a real agent's proposed production rollback. The real worker's commit classification, semantic dependency judgement, test execution and honest completion marker still need a live trial and User review. Reverts can apply cleanly and still break dependent work; this is not an automatic conflict-free rollback guarantee. The User keeps the final merge into main. Current-discussion archive confirmation requires switching away first, retaining the existing Archive contract.

Final npm test: 147 passed, 0 failed/cancelled/skipped, 48086.025334 ms. Committed on worker/main; see commit ID in worker report. Worktree clean; not merged or pushed.
