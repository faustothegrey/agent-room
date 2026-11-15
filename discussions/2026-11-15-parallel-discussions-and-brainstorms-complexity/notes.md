# Parallel discussions and brainstorms: complexity

## Asked by the User
Make discussions and brainstorms fully parallel: switch from one to another even during a round.
Discuss complexity first.

## Decided (User, 2026-11-15)
- Only step 1 now (Resume goes straight to an already-open discussion, asking before leaving an
  unsaved note). Everything else is deferred: step 2, notes prompts on Go to and automatic
  switches, round-running markers in Discussions.

## Findings (Claude, Codex, Agy — from reading the code, not tested)
- Already parallel underneath: each open discussion (and the one brainstorm) is its own context
  with its own agents, input queue and round loop (`src/cli.mjs` `addRoom`, `runRoom`;
  `src/ui.mjs` "Several open discussions"). A round in one never waits for another's.
- Returning mid-round already works: connecting to `__events` sends `resetEvent(screen)`, which
  includes `screen.thinking` (`src/docs.mjs:2606`, `2188`).
- What blocks switching is the *command path*: Discussions' **Resume** sends `/resume <name>` into
  the shown context's input queue (`src/docs.mjs:1367`), which waits for its round to end, even
  when the target is already open and only needs showing (`openHere.url`).
  **Go to** (not-started discussions, the brainstorm) already navigates directly (`location.href = o.url`) and works mid-round.
- Same for New discussion, New brainstorm, Resume of a closed one: queued behind the round.
- Brainstorm couplings (`src/ui.mjs:1173`, `1192`):
  - Only one brainstorm per folder is kept (`newBrainstormBeside` resets an existing brainstorm via `brain.say('/brainstorm')`, which would also wait behind a running brainstorm round).
  - `newDiscussionBeside` closes any open brainstorm (and refuses if a brainstorm worker task is running or holds uncommitted edits).

## Proposed (Claude, Codex, Agy): steps by complexity
1. **Switch between already-open discussions mid-round (Tiny):** in `src/docs.mjs:1365`, when `openHere` is present, navigate directly to `openHere.url` instead of sending `/resume <name>`.
2. **Open closed discussions / start new ones mid-round (Small–Medium):** handle `/new`, `/brainstorm`, and `/resume` (when opening beside) on arrival instead of waiting in `ctx.input`, with a per-discussion lock so double-clicks don't open two contexts for the same discussion.
3. **Brainstorm lifecycle: already decided elsewhere.** The User has decided several brainstorms
   open side by side, persisted, with no Worker
   (`discussions/2026-11-15-multiple-persisted-brainstorms-with-panel-tab/notes.md`, draft
   instruction in its `pending-instructions.md`, not sent). That removes the one-brainstorm rule,
   the reset via `brain.say('/brainstorm')` and the worker-lane concern. Not re-decided here.
   - **Proposed (Claude): order.** Step 1 can go now (it touches only the Resume button). Step 2
     after the brainstorms instruction lands, since both change `newBrainstormBeside` and
     `newDiscussionBeside` in `src/ui.mjs`.

## Deferred (User, 2026-11-15)
- Step 2; asking before Go to and automatic switches drop an unsaved note; showing which open
  discussions have a round running. Cost of parallel rounds stays unmeasured.

## Unsaved notes when switching (checked in the code by Claude, not tested)
- Agy: wrap the new direct navigation in `notesGuard` (`src/docs.mjs:2305`).
- Claude: Go to (`src/docs.mjs:1267`, `1362`) and the server's `goto` event (`src/docs.mjs:2228`,
  sent by Resume, New discussion, Close) all navigate without `notesGuard` today, so an unsaved
  note can already be lost. Fixing Go to too changes current behaviour: the User's call.
