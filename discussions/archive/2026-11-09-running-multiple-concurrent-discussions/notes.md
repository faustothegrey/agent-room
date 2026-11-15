# Running several discussions at the same time

Drawing: `drawings/parallel-discussions.svg`

**Closed (User, 2026-11-11), reopened 2026-11-12:** continue-by-default merged and tried live
(see below). Reopened for the parallel worker, now merged and tried live (slices 1a–1c, main at
`d9e6e3f`). Nothing pending for the worker. Known limits and untested paths are listed below.

## Continue by default (2026-11-10, reopened by the User)
Decided by the User: every discussion saves itself after each round; Pause/Resume and the
Auto-summarize toggle go; Resume continues, Start fresh deletes the old save, Go to for
brainstorms. Plan approved (User, 2026-11-10: "I approve the plan"):
`continue-by-default-plan.md`, its "Decided in the reviews" list. Built in two commits, (a) then
(b); merge only after (b).
Built on worker/main: `3b0c60d` (a), `52bebe6` (b), `ca70cf9` (recovery gaps); `npm test` 167/167
per the worker, not rerun by the agents. Limitation accepted (User, 2026-11-11: "I accept the
limitation, please have that documented"): worker tasks sent from a brainstorm, or before a new
discussion's first message, are not recorded for recovery; documented in the worker's README
(lines 237–239 at `ca70cf9`). Next: the User merges, Restarts (not Reload), and tries Resume,
Start fresh and Go to. Shared worker session in terminal mode: dropped on 2026-11-11, then
superseded by the User's aim (2026-11-12): "fully parallel discussion management", which
implies "fully distinct session for each discussion". Draft worker instruction (a plan only) in
`pending-instructions.md`.
Parallel worker (`parallel-worker-plan.md`), decided by the User (2026-11-12): go ahead, "a crucial
one and I'm willing to take risks", with "as many guardrails as possible"; "at most two session
in parallel"; the User can update Git on this machine if useful. Approved (User, 2026-11-12:
"Both approved. And let the worker update git if it can"): slices 1a → 1b → 1c, each merged and
tried before the next; rewriting existing tests whose expected behaviour changes; the worker may
update Git.
Slice 1a merged (`bf64c4e`, test changes `bc43f52`; README Sessions `ef16b12`). Live trial
(2026-11-12), per the worker's report: its first task here ran in
`agent-room.workers/2026-11-09-running-multiple-concurrent-discussions/` on its own branch, from
`ef16b12`, got the "worktree has changed" notice and remembered slice 1a's instruction (session
continued). Not yet seen: the Worker tab's merge-status lines (need a commit on the branch).
Child-process test failure: likely cause found by the worker (`child-process-test.md`): the test
can read the PID file while still empty (ID 0), which matches the error. The failure itself was
not reproduced (60 runs under load), so a real child-process race is unlikely but not ruled out. Fix is a test change,
approved and merged (`4090bdc`, main at `4090bdc`, checked by Claude). Worker tab checked in
Chrome by Claude: worktree, "1 commit not in the room", "contains current main", "Last tested
(the worker's report) … Still current", merge preview "clean" all shown. Second PID-file fix
merged (`fc0ca68`). Slice 1b built on `worker/2026-11-09-running-multiple-concurrent-discussions`
(`710439c` … `7b1dda5`; 188/188 per the worker; reviewed by Codex, no blocker). Reload from 1a's
workshop is refused (Restart applies it), after Codex found two reload races (one reproduced).
Merge route agreed: worker idle, Shutdown server, `git merge --ff-only`, start again.
1b merged (`7b1dda5`) and tried live (2026-11-12), reports pasted by the User: this discussion's
task ran 17:35:38–17:37:08 in its own worktree and branch, session remembering 1a/1b; the
`2026-11-12-header-ui-tweaks` task ran 17:35:52–17:37:22 in its own, fresh session. Overlap 76 s:
two tasks at once, separate worktrees, sessions and labels. Seen: the Worker tab shows every
discussion's reports; this discussion's trial task cost $22.20 (921k input tokens); the cause is
not established (assumed: its long worker session; the count may sum several model calls).
Not investigated, by the User's choice (2026-11-12): if costs look odd again, start with the
recorded usage and the providers' logs. No worker-only Start fresh control is confirmed.
Next: slice 1c (User, 2026-11-12).
Slice 1c on the branch (`ae83a60`, owner fix `0bdd64d`; 193/193 per the worker). Accepted as a
known limit (User, 2026-11-12): after Start fresh, a worker task still running from the old
session isn't counted in any discussion's totals. README note `d9e6e3f`. Codex reviewed 1c, no
blocker; ran the 5 targeted terminal tests: 5 passed. Untested: 1c's terminal switching with
real providers (the User doesn't use the terminal). 1c merged by the shutdown route (main at
`d9e6e3f`, checked by Claude, 2026-11-12). Browser check passed (User, 2026-11-12): a 60 s task
sent here, and the User resumed another discussion while it ran ("yep, I did that"); the
report came back here, labelled with
this discussion, and the worker remembered 1c, `ae83a60` and `0bdd64d` (session continued).
Parallel-worker work (slices 1a, 1b, 1c) complete.
Required by the User (2026-11-12): switching discussion while one waits for its worker task;
mid-round switching not required but not disallowed; "one discussion 'active' at a time", so a
typed message clearly targets it. Answered (User): "One active discussion per window if it the current model allows for it. Don't
want to introduce too much complexity though".

**Live trial (2026-11-11), tested:** merged (`ca70cf9` on main). The first Restart after the merge
gave both agents fresh sessions: no checkpoint had been saved before it yet (assumed: the new code
loaded after the last round). The second Restart restored the 08:01 checkpoint. Claude and Codex
both remembered the previous turns without reading transcripts, and got only the restore notice,
no new first message. The discussion in use has no Resume button, by design. Still untested:
a crash, Start fresh, Go to on a brainstorm. Start fresh on an old discussion with no checkpoint
was tried, which tests nothing; a real test needs one with saved sessions (User, 2026-11-11: may
not do it now).
Go to on a brainstorm, tested by the User (2026-11-11): the brainstorm stayed open beside this
discussion, the explorer offered Go to, and after it the brainstorm's chat was still shown and
its agents remembered their exchange. Switching back here (Resume) only showed this discussion, still open: no restore
notice, by design (`src/ui.mjs:778-779`).
Crash, tested (2026-11-11): the server was killed with `kill -9` after a round ended, then started
again and this discussion resumed. Restore notice shown (checkpoint 08:39, the last agreed
summary included); Claude and Codex both remembered the exchange (the crash plan, the PID)
from their own sessions, without reading the transcript.
Start fresh, tested (2026-11-11) on `2026-11-10-quick-access-host-terminal-panel`: its files and
transcripts stayed; both of its fresh agents got a new "This session continues the discussion"
first message with the latest summary, and neither remembered a detail of the old chat that the
summary lacked (what Codex said about `read -s`).
**Untested, by the User's choice** (2026-11-11: document it as untested and move on): that a Restart after Start fresh resumes the fresh sessions, not the old ones.

## Closed (User, 2026-11-09: "All has been merged. I think this discussion is finished")
main is at `cb96a68` (checked by Claude): Stages 1–3 and the inspection fix are merged. No
worker instructions pending. Untested until real use: the page in a browser, real agents,
a real Restart or crash, rollback with a real worker; one possibly flaky shutdown test.

## Status (2026-11-09, later): all three stages built on worker/main
Stage 2 `9698144`, Stage 3 `51ed9c8`, inspection-failure fix `cb96a68` (worker: `npm test`
148/148; Codex reviewed Stages 2–3 and ran 147/147 before the fix). One existing test
(child-process shutdown) failed once and passed on rerun: possibly flaky. Next: the User
merges and Restarts. Browser, real agents and a real Restart/crash remain untested.

## Earlier status: Stage 1 built; continuing with Stages 2 and 3
(User: "I'd like to press on with the other stages"; an earlier "discussion over" was taken too
far by the agents, see the transcript.)
Stage 1 built on `worker/main` as `1d8caf8` and `25d4fa4` (worker reports `npm test` 137/137;
not rerun by the agents). The User accepts it without a live trial and has the worker merge it
into main, asking for fixes as problems appear. Details: `worker-plan.md`,
`implementation-stage-1.md`.
**Not verified:** the page in a browser (New discussion, Go to, Close, origin labels, Restart),
real agents, a real worker's commits. After merging, Restart rather than Reload (assumed).
**Not built yet:** Stage 2 (owner record across Restart, Defer guard for
unmerged commits, notice before each round); Stage 3 (merging main into `worker/main`,
rollback). The decisions for them are below.
No worker instructions pending.

## The User's goal (User, 2026-11-09)
While the User talks in discussion A, the worker works for discussion B. After A's summary, the
User opens B from Explorer, checks the worker's work, lets it continue, and returns to A exactly
where it was (same Claude and Codex sessions, same chat).
"The highest grade of parallelism possible, if the model doesn't get overly complicated."

## Decided
- One shared worker for the first version (User, 2026-11-09: "shared worker is a good first
  cut. We can always improve later"). Several workers: possible later.
- The worker commits every completed task, in every room (single-discussion ones too), with
  the discussion's name in the commit message and the commit ID in its report. Merging
  `worker/main` stays the User's. (User, 2026-11-09: "yep, that seems reasonable")
- If a task stops with uncommitted changes (failure, timeout, crash, question), the worker queue
  pauses until the originating discussion resolves them. Discussions keep talking; only worker
  tasks wait. (User, 2026-11-09: "I guess that for this model that is the safest choice")
  Recovery details as proposed by Claude and Codex, accepted with it:
  - agent-room (not the worker) checks for leftover changes after each task, and again just
    before starting the next one. (A simple Git check is assumed to suffice.)
  - The originating discussion may still send a recovery task (finish or repair) through.
  - The queue resumes when the worker's folder is clean: recovery committed, the User discarded,
    or the User committed. Discarding needs the User's explicit action, never the agents'.

- Before each round in a discussion, agent-room adds one combined line naming the work other
  discussions finished since its previous round: which discussion, which commits, which files.
  It shows in the chat and transcript; just looking at a discussion adds nothing and starts no
  agents. It helps agents choose what to reread; it doesn't guarantee their earlier conclusions.
  (User, 2026-11-09: "yes, I guess that would be useful"; proposed by Claude, timing by Codex)

## How it works today (README.md, read by Claude; not run)
- One discussion "in use" per room. New discussion, Re-open and Resume give the agents fresh
  sessions unless the discussion was Paused first; Pause waits for the round to finish.
- Pause, Resume and New discussion end auto dev.
- Worker reports go to the discussion in use only.
- The worker commits on `worker/main` only when asked (`README-for-worker-agents.md:18-19, 27-28`),
  and writes notes in "the active discussion's folder" (lines 29–30).

## Proposed (agents; not decided)
1. Every open discussion keeps running on its own: its own agents, chat and auto dev. Its agents
   review worker reports in the background. (Claude, Codex)
2. Explorer marks a discussion that needs the User (WAIT FOR USER, FINISH, paused run). (Claude)
3. **One worker, one shared queue, one checkout, one branch.** Each task says which discussion it
   came from; its report goes back there. Several workers stay out for now: they would need
   separate checkouts and branches, and more merging. (Claude, Codex)
4. **One worker session per discussion** inside that single worker, so each continues its own
   history. (Claude; Codex agrees)
5. The worker checks the current files before acting and reports a conflict with another
   discussion's work instead of choosing silently. (Codex) Whether it notices reliably: assumed.
6. (Now Decided, in its revised form: the notice comes before the next round, not on return.)
8. (Now Decided, see below.)
9. **Archive with rollback** (User's wish, 2026-11-09): archive a discussion that proved
   unfeasible and undo all its changes. Proposed (Claude): revert its labelled commits
   (`[B] …`) with `git revert`, newest first; stop and report if later work from another
   discussion depends on them. Scope still open (see questions).
   Correction (Codex, accepted by Claude): a revert can apply cleanly and still break another
   discussion's work (A uses a function B added). So for a first version, rollback is a worker
   task: "prepare a rollback of B, identify effects on other discussions, and report what can
   safely be undone"; the User reviews it before the discussion is archived. One action may start
   it; what can't be promised is automatic, conflict-free completion. (Codex, correcting
   "no one-click undo")

## Decided (continued)
- A discussion with unresolved worker edits can't be archived or deferred; switching away is
  allowed. (User, 2026-11-09: "if the discussion isn't resolved it should[n't] be archive nor
  deferred. I can't defer discussion with code changes anyway, because that is not deferring.")
- Defer is also blocked for any discussion that has commits on `worker/main` not yet merged
  into main. (User, 2026-11-09: "Defer should be blocked for any commits on worker main, as
  long as they are not merged.")
- Rollback: the User would like **full** rollback, merged commits included, if it isn't too
  costly (User, 2026-11-09: "It is not too costly, full rollback would be a great feature";
  read by Claude as conditional). The plan assesses that cost.
- After the plan (User, 2026-11-09): (1) the User merges `worker/main` with a normal merge,
  "unless there is some substantial gain not to do so"; (3) for full rollback "the worker does
  all the work, if possible", including bringing main into `worker/main` when needed (an
  exception to "agent-room never merges", for rollback); (4) Quit room closes everything:
  every open discussion in that folder.
- Recovery of leftover edits (User, 2026-11-09: "this recovery flow is fine to me"): no Discard
  button. In B, the User asks the worker to finish, or to abandon the attempt; to abandon, the
  worker lists the edits it would remove, the User explicitly approves, and it removes only
  those. Unclear ownership is reported, never a reset of the shared folder. Rollback: the worker
  syncs and commits on `worker/main`; the User keeps the final merge into main. The rule that
  agent-room's own code never resets/merges (`README.md:437`) doesn't forbid these explicitly
  requested worker tasks; the worker rulebook should say so.
- On the revised worker-plan.md (User, 2026-11-09: "I approve all the recommendations above. A
  new discussion can simply end an open brainstorm"): approved the test contract changes needed
  for New discussion to keep the previous discussion open; the owner record (kept across
  recovery attempts; not proof of ownership); the worker merging main into `worker/main` when
  main has commits it lacks and the folder is clean, pausing the queue on a clash; squash
  outside the first version; a separate Close discussion; one Worker tab with origin labels; one
  window switching between discussions; Archive/Defer of open discussions not shown, when the
  other guards allow; rulebook updates as part of the implementation. Brainstorms keep sending
  worker tasks (the plan must say how they are labelled and recovered without a folder); New
  discussion ends an open brainstorm.
- Stage 1 test contracts (User, 2026-11-09: "yes I approve"): the two tests "after a restart the
  worktree is reused…" and "worker/main catches up with the room only when strictly behind…"
  change their dirty step to assert the queue holds with the edits intact, then commit them and
  assert the held instruction runs; their other assertions stay.
7. Worker notes go in the folder of the discussion that sent the task. (Claude)

## Limits (agreed by Claude and Codex)
- Separate sessions reduce mixed-up instructions, but don't remove them: shared files carry
  decisions from other discussions.
- B's agents may review while the worker already works on A's task: they should review B's
  result as reported, and reread current files before proposing more work. (Codex)
- A commit per task identifies a result; it does not make it undoable on its own, since later
  work may depend on it. (Codex, correcting Claude)

## Open questions for the User
- Send "Plan for several open discussions" (pending-instructions.md) to the worker?

## Costs
Two discussions running rounds at once: roughly double agent usage while both are busy.
Unmeasured.
