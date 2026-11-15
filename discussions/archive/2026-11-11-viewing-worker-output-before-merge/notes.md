# Viewing worker output before merge

Started 2026-11-11 from `discussions/2026-11-11-repurposing-docs-for-agent-human-collaboration/`.
Created by Claude at the User's request; not the active discussion. Solutions are to be discussed here.

## The User's problem (2026-11-11)
The User can't easily see the documentation the worker produced until it is merged. Seen when the
worker wrote `docs/architecture.md` and `docs/diagrams/*.svg` on `worker/main` (commits `0c54a9d`,
`ec9016a`).

## Decided (by the User)
- This topic gets its own discussion (this one), 2026-11-11.
- Linked to `discussions/2026-11-13-viewing-root-documents-in-explorer/` (User, 2026-11-13).
- Slice 2 of that discussion (the **Worker copy** view) moves here, so it can close.
  (User, 2026-11-13)

## Picked up from `discussions/2026-11-13-viewing-root-documents-in-explorer/`
Slice 1 is merged (main `ce3d1ea`): Explorer has a bar `[ Discussion | Room checkout | Worker copy ]`,
with Worker copy greyed out ("Coming soon"). Design already decided there by the User (its
`notes.md`, "Decided"; drawings `three-tabs.svg` and `peek.svg`):
- **Worker copy** shows the root as it is in the shown (or peeked) discussion's own worker worktree
  (`<repo>.workers/<name>/`, `worker/<name>`), read-only; greyed when that worktree doesn't exist.
  `worker/main` (brainstorms, early tasks) is not offered.
- Switching Room checkout ⇄ Worker copy keeps the open root file at the same path, or shows
  "not in this copy"; Document's path line names the copy; a note appears if the worker changes
  or deletes the open file.
- Proposed there (Agy): serve it as a read-only `__worker/<file>` route, like `__received/`, but
  with live change checks in `/__mtime`.
- Unmeasured: Explorer's file list runs one `git check-ignore` per root file (`servable()` in
  `src/docs.mjs`); fine at agent-room's 44 root files, possibly slow in large rooms. Worker copy
  would double that listing.

This answers the first open question below in part: files as they are on the worker's branch;
a diff view is not decided.

## Facts so far (from the README, assumed until checked in code)
- Explorer and Document show the room's own folder; the server serves each room's files only from
  inside its folder (README "Start a room").
- The worker works in a separate Git worktree, `<repo>.worker/` (here
  `/Users/fausto/Software/agent-room.worker/`), on branch `worker/main`; nothing is merged
  automatically (README "The worker's worktree").
- Discussion agents can read the worktree (full filesystem access); the User, on the screen, can't.

## Proposed (by agents)
- (Codex) Frame it as reviewing worker output before merge, documents and drawings included, and
  verify what the current Explorer can access before choosing a solution.

## Open questions for the User
- What should "seeing" cover: reading files as they are on `worker/main`, the changes compared with
  main (a diff), or both?
- Only documents and drawings, or any file the worker changed?
