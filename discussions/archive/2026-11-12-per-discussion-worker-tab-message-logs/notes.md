# Per-discussion Worker tab messages

## Problem
The Worker tab shows one shared log for the whole folder (`src/ui.mjs:221`, `1037–1038`). Every
worker message goes to every open discussion's page, labelled `speaker · [origin]`
(`src/docs.mjs:510`). Since slices 1a–1c each discussion has its own worker
(`discussions/2026-11-09-running-multiple-concurrent-discussions/notes.md`). Saving already keeps
only the discussion's own messages (`src/ui.mjs:627`, `771`): only the display is still shared.

## Decided (by the User)
- Show each discussion's worker status separately (User, 2026-11-12). The Explorer's single worker
  status at the top is a leftover from the single-worker design and is broken.
- Room-wide warnings appear in every open discussion's Worker tab, if possible (User, 2026-11-12).
- The investigation is postponed; the implementation design below and its worker instruction
  (`pending-instructions.md`) are approved (User, 2026-11-12).

## Outcome
- Implemented by the worker in `16d5b39` and the follow-up `a1da1c3`: a task's working status no
  longer stays stuck on another discussion after the context switches. The worker reported 195
  tests passing.
- Merged into main by the User (main at `a1da1c3`). The User checked it live and reported it works
  (2026-11-12).
- Still postponed: reproducing the original Explorer status problem; showing a room-wide problem
  that is still going on to a discussion opened later.

## Proposed: per-discussion worker status (Claude, Codex)
- Today: the top line of the Explorer (`#activity`, `src/docs.mjs:766–776`) shows "Worker is
  working" only for the page's own discussion (`src/ui.mjs:2400`). Discussion rows show only
  `· in use` / `· open` (`src/docs.mjs:1048`). Not yet reproduced in the browser (assumed from the code).
- First version (Codex; Claude agrees): every open discussion's row, the current one included,
  shows `· worker working` while its worker runs, and nothing otherwise. Remove the worker part
  of the top line.
- The server adds that state to each entry of `openList` (`src/ui.mjs:1024`) and sends the list
  again when a task starts or finishes.
- Later, a separate proposal: `queued` and `held` states (they need rules for when several states
  apply at once).
- Brainstorm: it has no folder row, but the list of open discussions includes it (Codex). Its
  status goes wherever the Explorer shows that entry; to check where that is.
- Before writing the instruction, reproduce the reported problem in the running app and follow
  the status through a task's start and finish (Codex). The User doesn't need to diagnose it.

## Proposed (Claude, Codex)
- **Each discussion's Worker tab shows only its own worker's messages.** The folder may keep one
  log internally.
- **No shared message log.** Live status for each discussion goes in the Explorer (see above);
  "Work finished elsewhere" (`src/ui.mjs:1236`) reports finished changes from other discussions.
- **Filter by owner, not by label** (Codex): use `ownerOf` (`src/ui.mjs:1017`), because every
  brainstorm is labelled `brainstorm`. Use the same filter for the history a page loads and for
  live messages, including a task that finishes after its room changed identity.
- **Messages without an origin are not all room-wide** (Codex, correcting Claude): task errors
  (such as failing to save a transcript or to record a "Tested" line) belong to their task's
  discussion; a warning about one discussion's lane goes to that discussion. To do: list each
  such message and sort it as task, lane or room-wide.
- Drop the `[origin]` label from ordinary messages once each tab shows only its own discussion.
- Saved messages from older discussions carry the discussion's label and can be restored to that
  discussion. A brainstorm's messages need its own ID while it is open.
- **Room-wide warnings appear in every open discussion's Worker tab** (User's preference,
  2026-11-12, "if possible"; Claude agrees). Room-wide means it affects every discussion's worker,
  for example a problem with main or with the worker settings. A discussion opened later still
  shows a room-wide problem that is ongoing; a warning that has cleared is not replayed (Codex,
  Claude agrees). To do: find which of today's warnings describe ongoing conditions.

## Proposed implementation design (Claude)
The User has postponed the investigation (2026-11-12): reproducing the status problem and sorting
the messages without an origin. This design doesn't depend on it.

**Messages (Worker tab)**
1. Every worker log entry records its **owner** (`ownerOf`, `src/ui.mjs:1017`): a task's messages,
   from its waiting notes to its late notes, use the owner captured when it was queued (Codex); `workNote` (`1054`) uses the owner of the context it's
   called with. A room-wide entry carries `room: true` and no owner.
2. One filter, `ownerOf(c) === m.owner || m.room`, in both places: the history a page loads
   (`screen.worker`, `221`/`1037`) and live events (`toShop`, `1053`).
3. A message without an origin goes to **the discussion it was called from**, by default. Only
   messages known to be room-wide get `room: true` (the investigation reviews this later). Lane
   warnings (`1249`, `1257`) go to the lane's owner.
4. The page drops ` · [origin]` (`src/docs.mjs:510`).
5. Saved discussions: unchanged (`627`, `771` already filter by label).
6. First version: a discussion opened later doesn't show earlier room-wide warnings. Showing a
   room-wide problem that is still going on waits for the investigation.

**Status (Explorer)**
7. `openList` (`1024`) adds `working: !!c.screen.working` to each entry.
8. When a worker starts or stops (`working`, `2400`), every open discussion's page receives the
   list again, not only that discussion's own page.
9. Each open discussion's row (`docs.mjs:1048`), the current one included, shows `· worker working`;
   so do contexts without a discussion row (brainstorm, new discussion not started) on their
   existing `· open` row with Go to (`docs.mjs:1146–1150`), and the current brainstorm beside its
   "in progress" hint (Codex; checked in the code by Claude, not in the browser).
10. Remove "Worker is working" from the Explorer's top line (`docs.mjs:769`). Under the title, the
    Worker tab keeps showing its own worker's status (`docs.mjs:758`).
