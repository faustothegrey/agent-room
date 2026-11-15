# Stage 1: several open discussions (worker, 2026-11-09)

This is an intermediate version, not the finished feature. It is committed on `worker/main` (see
"Review changes") and not merged.

## Built
- **One context per open discussion** (`src/cli.mjs` `addRoom` with a `context` tag;
  `src/ui.mjs`, "Several open discussions").
  - Each context has its own agents' sessions, chat, input queue, auto dev and page.
  - Contexts of one folder share `ctx.shop`: the worker queue, the worktree, the Worker tab and
    `blockedBy`.
  - Each context has its own worker session.
- **Screen commands:**
  - New discussion opens a context beside the current one and ends an open brainstorm.
  - Re-open goes to an already open discussion, or opens it beside.
  - New brainstorm: at most one per folder.
  - Resume, as Re-open.
  - Close discussion (`/close`).
  - Quit room quits every context of the folder.
  - One window: the server sends `goto` and the page navigates.
  - Explorer shows "open" with **Go to**.
- **Shared queue (`pump`):**
  - Each task is labelled with its origin (the discussion folder name, or `brainstorm`), and its
    reply goes to its origin's transcript.
  - The commit label is told once per worker session, and unlabelled commits are reported.
- **Leftover edits:**
  - The worktree is checked after each task and again before the next.
  - When edits are left, the origin is told and its own tasks pass, with the first task's
    details.
  - Unknown edits (before a task, or at start) hold every task.
  - An origin holding edits can't be closed, archived, deferred or moved.
- **Open discussions not shown:** they can be archived or deferred between their rounds. Their
  transcript and folder paths follow, and their agents get a notice.
- **Restart** brings back each open discussion fresh from its handoff (`restartArgs`, `--room` with
  `context`).
- **Docs:** the worker rulebook, the per-task text, `README.md`, and the code comment on Git rules.
- **Terminal mode** keeps one discussion at a time: its one input can't switch between contexts.
  The approved New discussion, Re-open and brainstorm tests now mark their rooms as terminal rooms
  (`noScreen`); their assertions are unchanged.

## Room left for later stages
- **Owner record across Restart:** after a Restart the queue is blocked by an unknown owner
  (`start` → `hold(ctx, { origin: null })`). A saved record would set `blockedBy.origin` there
  instead.
- **Defer guard for unmerged commits:** `moveDiscussion` already resolves `from` and the folder's
  shop; the `git log <HEAD>..worker/main --grep "[name]"` check goes next to the leftover check.
- **Notice before each round:** `handleLine`, just before `runRound`, with the labels this stage
  adds to commits.
- **Merging main into `worker/main`, and rollback:** worker tasks. The rulebook already allows them
  when explicitly asked; no agent-room code yet.

## Review changes
- **One rule:** a room runs several discussions unless it is in terminal mode. The "no hub" case
  existed only in tests and is gone.
- **Replication:** every open discussion of a `--node` launch room replicates. It uses the launch
  room's one replica (one storage, one set of peer loops). Captures run one at a time. The holder
  can't be closed while others are open; Quit room closes all.
- **The worker's provider and model** are one setting for the folder's open discussions; each
  keeps its own worker session.
- **Held tasks** are re-checked every 2 seconds, so they start once the folder is clean.
- **The two approved tests** ("after a restart the worktree is reused…", "worker/main catches
  up…") now assert the hold, then the run after a commit.
- **New tests:**
  - `test/rooms.test.mjs`: the real server, with two open discussions, sessions kept, the report
    returning to its origin, and Quit room.
  - `test/replication-ui.test.mjs`: a second open discussion replicates.

## Known limits
- The page changes weren't checked in a browser.

## Shared worker setting follow-up (resumed)
- Interrupted attempt left only `src/ui.mjs` and `test/ui.test.mjs` modified, with no commits after `1d8caf8`. Continued those edits.
- `saveSettings` validates other open discussions for worker-name clashes before loading/applying settings or writing defaults. A clash rejects the room-wide change with the origin and conflicting name. Other workers are built before applying the change.
- Added coverage for rejection preserving worker objects, specifications, sessions and the defaults file; successful model changes still apply to both origins and retain sessions. No other test contract changed.
- `npm test`: 137 passed, 0 failed/cancelled/skipped, 22.99 seconds. `git diff --check` clean.
- Browser trial blocked: cmux socket unavailable; CUA browser access host unavailable. No fresh browser observations of New discussion, Go to, Worker labels, Restart or Close. The interrupted attempt's fake-provider server log records two topics, a worker reply and a Restart restoring both topics, but that is not a verified browser result. Stopped that leftover server on port 5588; preserved scratch files.
- Still needs an available browser for the full requested trial, and real providers/worker for native session behavior, actual edits/commits and provider/model switching. No merge into main.
