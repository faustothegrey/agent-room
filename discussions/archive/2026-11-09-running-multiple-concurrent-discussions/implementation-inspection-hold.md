# Inspection failure follow-up after Stage 3

Started clean at 51ed9c8 on worker/main. Changed only src/ui.mjs and added one test in test/ui.test.mjs; no existing test contract changed.

- leftovers returns null for failed inspection, distinct from clean false and unfinished true. It retains the existing hold and private owner record, records a separate inspectionError in the shared workshop, and reports the actual inspection error to the holding/task origin and Worker tab (without repeating identical notices on every retry).
- recoverWorkerOwner and pump never release ownership or dispatch any task on null, including recovery from the holding origin. The existing two-second watcher retries errors, including when no tasks are queued; pump schedules it in finally so early returns cannot skip the retry. Successful inspection clears the separate error and returns to the usual hold/recovery logic.
- Rollback readiness and archive confirmation also require explicitly inspected-clean false; null cannot authorize them.
- Regression uses a damaged index in a disposable worktree while a known-origin hold exists. It verifies both queued tasks (including recovery) stay queued, the hold object and owner-record bytes remain unchanged, error reporting and retry scheduling remain, then restores the index and verifies the watcher alone runs recovery and the other task and cleans the record.

Validation:
- Targeted regression: 1 passed, 0 failed (3526.874426 ms).
- First npm test: 147 passed, 1 failed (51620.201332 ms). Existing test “one server, two rooms: separate state and files, independent rounds, Quit room ends only one” failed at test/rooms.test.mjs:175: the child-command PID still existed when the assertion expected process.kill(pid, 0) to throw. No change made to that test or process stopping.
- That test in isolation: 1 passed, 0 failed (4855.436173 ms).
- Final npm test: 148 passed, 0 failed/cancelled/skipped (51267.348929 ms). git diff --check clean.

Not checked: browser presentation, real providers/worker, real filesystem permission failures or live Restart during an inspection outage. The regression exercises an actual Git status failure with a deliberately damaged fixture index, not a real project. No merge into main or push.
