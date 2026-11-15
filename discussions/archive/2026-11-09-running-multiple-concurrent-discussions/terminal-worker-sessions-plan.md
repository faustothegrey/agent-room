# Plan: `/new` in the terminal gives the new discussion a fresh worker session

Status: superseded (2026-11-12) by slice 1c of [parallel-worker-plan.md](parallel-worker-plan.md), commit `ae83a60`: switching no longer waits, and each discussion keeps its own worker session. Kept as history.
2026-11-07 ("the worker carries on") for terminal `/new` only. On the screen, `/new` already opens a
separate context with its own worker session; that part does not change.

## Today

- `newDiscussion` (`src/ui.mjs`, about line 886) calls `endSession`, which resets the discussion
  agents only, and adds a marker line to the Worker tab. The worker object, its session, its log and
  its briefing state (`workerBriefed`, `workerTree`, `workerLabel`) all carry on.
- So the old discussion's checkpoint holds the worker session ID as it was at `/new`. The new
  discussion keeps using that same provider session. Resuming the old discussion later then
  continues a session that has had the new discussion's worker turns too.
- Resume and Start fresh in the terminal already work the way the User wants: `leaveSession` waits
  for this context's worker queue (`await ctx.workQueue`), ends the session (which saves the
  checkpoint, worker session included), calls `worker.reset()`, clears the Worker tab and the
  briefing state. The resumed discussion's own worker session then comes from its checkpoint
  (`loadCheckpoint` replaces `ctx.sessions` as a whole).

## Proposal

Have terminal `/new` go through `leaveSession`, as Resume does:

```js
function newDiscussion(ctx) {          // becomes async
  …same early return when nothing has started…
  await leaveSession(ctx, 'starting a new discussion');   // instead of endSession + marker
  switchTo(ctx, null);
  note(ctx, …);
}
```

What happens then:

1. **Running and queued worker tasks.** `/new` waits until every task this discussion has queued
   has finished. That covers the one running and any queued behind it, as Resume does now. Until
   then they run in the old discussion's session, with its briefing, label and transcript, and each
   task's `saveCheckpoint` writes to the old discussion, which is still the one in use. Nothing is
   dropped or moved to the new discussion. Terminal input waits too: lines typed meanwhile are
   buffered and run afterwards, as during a round. `/quit` still works as it does today.
2. **Then the old discussion's checkpoint is saved**, by `endSession`, with the worker session as
   it is after its last task.
3. **Then the worker is reset.** Claude gets a new session ID; Codex drops its thread ID. The
   Worker tab clears, and `workerBriefed`, `workerTree` and `workerLabel` are cleared, so the new
   discussion's first instruction is briefed from scratch (folder, worktree, label), as in a fresh
   room. Before the new folder exists, the worker is told nothing about a discussion, the same as in
   a fresh room. Today's "No discussion is active now: … is no longer the active discussion's
   folder" line would no longer be sent after `/new`, because the fresh session never knew the old
   folder.
4. **Going back.** `/resume <old>` loads the old checkpoint, worker session included, so the old
   discussion continues its own worker session and gets its own Worker tab entries back (already
   the case). When you leave the new discussion, its checkpoint keeps its worker session in the
   same way.

Why wait rather than reset at once: `reset()` changes the session object in place. A Claude turn
still running would then set `started = true` on the *new* session ID once it ends, and the next
turn would `--resume` a session that doesn't exist. Tasks still queued would also run in the new
session with the old discussion's records. Not waiting would mean binding a session to each task
when it is queued, which is a larger change for no real gain in the terminal.

How much this matters in practice: in `--no-screen` mode the page only watches. A terminal worker
task can only come from `/rollback`; auto dev needs the screen. So the wait at `/new` is rare, but
when it happens it can last up to the 30-minute timeout for each task.

### Points for the User to decide

- **A note while waiting.** I propose that `leaveSession` print "Waiting for N worker task(s) from
  <name> to finish first…" when any are pending. It is one line, and Resume and Start fresh would
  print it too. Otherwise the terminal just looks stuck.
- **Unresolved worker edits.** If the last task left uncommitted edits, the queue holds them for
  that origin. After `/new`, the next task would be told to resolve them under the *new* label, in a
  fresh session. I propose that `/new` refuse in that case, with the message the screen's Close
  already uses (`workerHold`): "ask the worker to finish and commit them, or to abandon them". Resume
  has the same gap today; I'd leave it alone unless you want it fixed too.
- **A queue that never settles.** If the queue stops because the worktree can't be inspected,
  `ctx.workQueue` never resolves, and `/new` would hang as Resume can today. I'd leave this out of
  scope and mention it in the README only if you want.
- **`/new` from a brainstorm.** `leaveSession` resets the worker only when a discussion is in use
  (`ctx.logPath`). So after a brainstorm, the new discussion would still continue the brainstorm's
  worker session, which has no checkpoint. For "every discussion has its own worker session" I
  propose resetting the worker in that case as well. That is one more condition in `newDiscussion`.
  Resume from a brainstorm has the same gap and would stay as it is.

## Files

- `src/ui.mjs`: `newDiscussion` (made async, calls `leaveSession`, no marker), and its comment.
  Possibly `leaveSession`, for the waiting note, and the brainstorm reset. The `endSession` comment
  ("New discussion doesn't") changes too. The `handleLine` dispatch already awaits the return.
  About 10–20 lines.
- `src/docs.mjs`: the terminal tooltip of **New discussion** ("… The worker carries on.", line 409)
  becomes "… The worker starts a fresh session; this discussion keeps its own." The comments at
  lines 528 and 793 change too.
- `README.md`: the "New discussion in the terminal" paragraph, the `/new` row in the commands table
  ("The worker carries on."), and the line in "Every discussion saves itself" if needed.
- `README-for-worker-agents.md`: no change needed ("Your own CLI session remembers earlier worker
  instructions" still holds).

## Tests (`test/ui.test.mjs`)

These tests state today's contract and would have to change. Under the project rules I need your
approval before changing them:

- "/new after a round: …": `resets` becomes `['A', 'B', 'W']`.
- "/new leaves the worker alone: …" (about line 444): asserts that `/new` returns while the worker
  is busy, that `reset` isn't called, the marker note, that the log stays, and the "No discussion is
  active now" briefing. I'd rewrite it as "/new waits for the worker's tasks, then gives it a fresh
  session". The running task still ends in the old transcript, the old checkpoint holds the old
  worker session ID, and the new discussion's first instruction is fully briefed.
- "after New discussion, the previous one can't move while its worker task runs" (about line 482)
  and "a worker task keeps the discussion it started in, even if New discussion comes while it
  prepares its worktree" (about line 719): both send `/new` while a task runs and act before the
  task ends. With waiting, `/new` no longer returns early, so the `/move` lock they test can't
  arise after terminal `/new` any more. I'd move that lock check to a Resume case or remove it, as
  you prefer.
- "auto dev: … New discussion ends a run …" (about line 1219): `/new` is sent while the worker
  waits on a gate, so with waiting it would deadlock. The gate must be released before `/new`, or
  `/new` not awaited.

New tests:

- `/new`, a worker task, then `/resume <old>`: the old discussion's worker session ID (Claude) or
  thread ID (Codex) comes back; the new discussion's session is a different one, and is saved in
  its own checkpoint.
- If adopted: `/new` refuses with unresolved worker edits, the waiting note appears, and the
  worker is reset after a brainstorm.

## Size

Small: about 10–20 lines in `src/ui.mjs`, one tooltip, two README paragraphs, about 5 tests
changed and 1–3 added. Most of the work is in the tests whose contract changes.
