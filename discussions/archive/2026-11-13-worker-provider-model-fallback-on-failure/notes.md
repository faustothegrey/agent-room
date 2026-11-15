# Worker: change provider/model when the agent fails

## Decided (by the User)
- The worker should be able to change provider/model if the agent fails.
- Two buttons on a failed instruction: **Retry** (same provider/model) and **Retry with…** (pick another).
- If possible, when a retry succeeds, auto dev **resumes automatically**.
- Retry goes ahead of instructions queued after the failure; no Retry buttons for Quit/Restart/crash interruptions; no extra confirmation when other work ran before the retry (the worker is briefed and inspects the worktree and Git state).
- Retry buttons only on the discussion's latest failed instruction; a Reload keeps the failure pause and its buttons.
- A provider/model picked with "Retry with…" **sticks** for later instructions.
- The failure shows in the chat, no agent turn starts on its own, and the User's next message reaches the agents with it (confirmed).
- In auto dev, a worker failure **pauses** auto dev, as long as control returns to the discussion so the User can discuss what to do next there.

## Today (read from the code, not tested)
- A failed worker turn (CLI exit ≠ 0, 30-min timeout, quota/rate limit, auth) becomes an error entry in the Worker tab; the instruction is **not retried** (`src/ui.mjs`, worker task loop, `catch (err) → entry.error`).
- In auto dev, a failed attempt is reported back as "The worker's attempt failed: …".
- Manual switch already exists: changing **model** keeps the session; changing **provider** starts a fresh session given the previous Worker-tab conversation (README, "provider & model").
- A failed turn can leave uncommitted edits; the next task in that lane is then a "recovery" task.

## Proposed (Claude)
- Trigger only on failures that another model can plausibly fix: quota/rate limit, CLI crash, model unavailable. Not on the 30-min timeout or on a reply the User dislikes.
- Retry the **same instruction** once with the next entry of a fallback list, telling the new session the earlier attempt failed and to check the worktree first.
- Show the switch as a line in the Worker tab ("Codex hit its quota: retrying with Claude Sonnet").

## Proposed (Codex, Claude agrees)
- Start with a **"Retry with…"** action on a failed instruction instead of automatic switching: the User picks the provider/model, so no error message has to be classified correctly.
- The retry carries the original instruction and the failure text, and inspects the worktree first under the existing lane recovery rules. A failed attempt may also have made commits or left a merge/revert in progress, not only uncommitted edits.

- Default proposed by both: the chosen provider/model **stays** for later instructions (a quota limit usually lasts hours); the User can switch back in the Worker panel.
- Code cost: **unmeasured**. To check: in auto dev, the retry's result must go back to the discussion as the same instruction's outcome (not a new manual task, not reported twice); and how retries fit the lane's queue and worktree rules.

## How auto dev handles a failure today (read from `src/ui.mjs`, not tested)
- A failed relayed instruction does **not** pause auto dev. Its error goes back to the discussion as a "Worker report" round ("The worker's attempt failed: …"); the agents discuss it and agree a summary, which may send a new instruction, finish, or pause (WAIT FOR USER).
- Clicking anything that sends the worker an instruction pauses a running auto dev ("you sent the Worker an instruction").
- So, as it stands, a Retry would race with the agents' discussion of the failure.

## Proposed (Claude): auto dev with Retry
- When a relayed instruction fails, auto dev **pauses at once** ("the worker failed: Retry or Retry with…") instead of sending the failure to the discussion.
- Retry succeeds → its result goes to the discussion as that instruction's report, and auto dev resumes (same cycle, not a new one).
- Retry fails → still paused, buttons shown again.
- (Codex, Claude agrees) Resume only from *this* failure pause: if the run was restarted or ended while the retry ran (Restart auto dev, an agreed FINISH, Resume, Close…), a successful retry reports its result but does not resume. (Auto dev has no Pause or Stop button today, checked in `src/ui.mjs`.)
- The failure shows in the chat; no agent round starts on its own. The User's next message reaches the agents with the failure, so they can discuss it.
- (Codex, Claude agrees) Retry and Retry with… stay available during that discussion; discussing doesn't commit the User to retrying or moving on.
- (Claude, Codex agrees) Messages typed *during the failure pause* don't cancel it: a later successful retry still resumes auto dev. Only restarting auto dev without retrying, or the run ending, ends the failure pause.
- This changes current behaviour (failures no longer reach the agents automatically): needs the User's OK.

## Fit with queue, worktree and auto dev (Claude, read from `src/ui.mjs`, not tested)
- **Queue:** each discussion's worker tasks run one at a time, first in first out (`queueWork`, `pumpLane`). A retry queued like a new task runs *after* any instructions the User queued since the failure. In auto dev only one is in flight, so this only matters for manual queues.
- **Worktree:** if the failed attempt left uncommitted edits, the lane holds, but the same discussion's next task still runs and gets the existing "recovery" briefing (finish and commit, or list edits and ask before removing). So a retry is naturally that recovery task: no new worktree rule needed.
- **Retry with…:** the same change as the Worker panel's provider/model (model change keeps the session; provider change starts a fresh one with the Worker-tab history), then the retry is queued. It sticks, as decided.
- **Auto dev:** the retry must be queued as part of the run (so its result comes back through `reportBack`, at the same cycle), not as a manual instruction (which would pause auto dev as "you sent the Worker an instruction").
- **Not covered:** instructions stopped by Quit/Restart/crash are already reported as "interrupted" on Resume; whether they also get Retry buttons is open. Whether the failure pause and its buttons survive a Reload or Resume: unchecked.
- Code cost: still unmeasured.

## Proposed: retry order and interruptions
- (Codex, Claude agrees) A retry goes **ahead** of instructions queued after the failure: it continues the earlier one, and later work may depend on it.
- (Codex, Claude agrees) No Retry buttons for instructions interrupted by Quit/Restart/crash in the first version: their work may have finished before the result was lost, so they need a separate recovery decision.

- (Claude and Codex) **Later tasks already ran before Retry is clicked:** no extra confirmation (clicking Retry is already deliberate). The retry's briefing names the work done since the failure, and the worker inspects the current worktree and Git state (uncommitted edits, merge/revert in progress) before proceeding.

## Open questions for the User
- None. The worker instruction in `pending-instructions.md` is ready to send.
