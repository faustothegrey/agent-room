# Stage 2 implementation

Intermediate version after Stage 1, on worker/main. No merge into main.

## Changes

- `src/ui.mjs`: completed labelled commits and their changed files are collected after worker tasks. `runRound` adds one combined `agent-room` message before a discussion round, including Worker-report rounds, for other origins' commits not previously reported to that discussion. The message enters agent context, chat and transcript. A per-discussion set in the shared workshop prevents repeats, including when switching away and back; Reload retains it. Viewing alone adds no message and starts no agents. Restart begins with fresh in-memory notice state (no replay of historical work).
- `moveDiscussion` is asynchronous so Defer can inspect `main..worker/main`. Any matching `[origin]` commit refuses Defer with its IDs. A normal merge clears that guard; squash detection is not included. Existing move/leftover guards remain.
- Before the provider's task starts, `runWork` atomically writes `agent-room-task.json` in the worktree's absolute private Git directory, outside both indexes. It contains version, room root, origin, complete task text and starting commit. Recovery never replaces it. A brainstorm additionally has an in-memory identity so a newly created brainstorm cannot inherit a lost one's edits.
- Startup and dispatch validate that record and its starting commit. Existing discussion folders retain ownership even before their context is restored; missing or invalid records/origins hold as unknown. `src/cli.mjs` rechecks after reopening each restored context so the origin is notified and its recovery can run. A lost brainstorm remains unknown after Restart.
- The existing two-second hold check also runs with no queued tasks: once edits are committed or otherwise cleaned, it deletes the record and releases the hold. Commits completed by hand during recovery can also enter the notice list.
- README documents the notices, Defer guard and private ownership record. No worker rulebook change was needed for Stage 2.

## Validation

- Added four tests to `test/ui.test.mjs`; no existing test or test contract changed.
- Tests cover combined notices, no notification on viewing, no repeated IDs, agent context/chat/transcript delivery, Worker-report round delivery, Defer refusal and acceptance after normal merge, owner recovery using recreated shared queue state, missing/malformed/invalid records and absent origins, preservation of the original record during recovery, cleanup, brainstorm identity and no folder creation, and cleaning by hand with no further task.
- Final `npm test`: 141 tests, 141 passed, 0 failed/cancelled/skipped, 32915.357053 ms. `git diff --check` clean.
- Earlier targeted runs exposed test setup errors (queued brainstorm startup and rewriting identical tracked contents); corrected only the new tests. The earlier full suite run also passed (140 tests, before adding the final cleanup coverage).

## Not checked / remaining stages

No browser trial, real provider/worker, actual process Restart/Quit/crash, or real peer trial. Restart ownership tests recreate workshop state in-process; the startup/reopen integration is implemented but not exercised with a new process. OS-level unreadable-record permissions were not exercised; read failures take the same unknown-owner path as invalid JSON. The record is context for recovery, not proof that all edits belong to its origin.

No merging main into worker/main and no rollback. Those remain Stage 3. No new module, dependency, config system or process was added.
