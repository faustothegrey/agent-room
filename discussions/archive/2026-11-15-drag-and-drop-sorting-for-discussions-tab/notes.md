# Drag-and-drop order for the Discussions tab

## Decided (User)
- No automatic sorting in the Discussions tab; the User orders rows by dragging and dropping.
- The order persists in the browser's localStorage.
- A newly created discussion goes at the top.
- "Archive and deferred" is not draggable; it stays as it is.
- Each row's `Actions` menu gets "Move up" and "Move down".
- The current discussion keeps its place when resumed; only its highlighting changes.
- Rows for other open windows (brainstorm or not-started discussion) stay above the list.
- A discussion that comes back from archive or deferred goes to the top, like a new one.

## Current behaviour (read from `src/docs.mjs`)
- `discussionsIn()` (around line 1192) sorts folder names newest-first by their date prefix.
- `renderDiscussions()` (around line 1211) then moves the discussion in use to the top.

## Proposed (Claude, Codex, Agy)
- **Storage key (Claude, Codex, Agy):** save a list of discussion names per room in `localStorage`,
  keyed by the room's root (`room.folder`), because one browser can show several rooms.
  - Only reconcile/save when both `room?.folder` is known and the file list has actually loaded
    (e.g. initialize `cachedDetail.files` to `null` until `openFiles()` succeeds, since existing
    callers already use `cachedDetail?.files || []`) so an early render or failed fetch never prunes
    the saved list against an empty array (Codex, Agy).
  - Wrap `localStorage` access in `try / catch` and guard `typeof addEventListener === 'function'`
    because existing tests in `test/docs.test.mjs` execute the `src/docs.mjs` script slice inside
    Node's `new Function(...)`, where `addEventListener` is undefined and `localStorage` can throw
    `SecurityError` (Agy).
- **Display and auto-saving new discussions (Claude, Codex):** `discussionsIn(prefix)` keeps its
  newest-first sort (used by `archive` and `deferred`, and as the initial order for unsaved active
  discussions). For active `discussions`, names missing from the saved list appear at the top
  (newest-first if several arrive at once), followed by the saved order. Names no longer in
  `discussions/` (archived, deferred, deleted) are skipped and pruned. Immediately persist the
  merged order when it changes so new discussions keep their position even if the User never drags.
- **Current discussion (Claude):** no longer moved to the top; keeps its place in the User's order
  and is still labelled "current".
- **Dragging & re-renders (Claude, Codex, Agy):** native HTML5 drag-and-drop with no new dependency.
  - Show the drag handle (and `draggable`) when `canAct` is true (matching the `Actions` menu) so
    clicks on the title, `Resume`, or `Actions` menu don't conflict with dragging and read-only
    views stay read-only (Codex, Agy).
  - Avoid clobbering `discussions-pane` DOM while a drag is in progress (`renderDiscussions()` runs
    on `room`, `files`, `moved`, and `replica` events and replaces `innerHTML`) (Agy).

- **Link between pruning and question 2 (Claude):** pruning archived names means a discussion
  that comes back goes to the top. Keeping its old place would mean keeping archived names in
  the saved list.

## Worker instruction
Final text in `pending-instructions.md`, not yet sent.
