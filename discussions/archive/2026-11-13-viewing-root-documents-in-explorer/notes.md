# Viewing root documents in Explorer

## Decided (by the User)
- Open this discussion, solve it, then return to
  `discussions/2026-11-13-project-documentation-with-detailed-diagrams/`, which stays paused
  meanwhile and is picked up with Resume. (User, 2026-11-13)
- Explorer shows the room root and one discussion at a time, not a list of sibling discussions
  (the root and a discussion may live in different workspaces). The User wants to be able to see
  the files of any discussion, current or not. (User, 2026-11-13)
- This discussion is linked to `discussions/2026-11-11-viewing-worker-output-before-merge/`
  (seeing root documents as they are on the worker's branch). (User, 2026-11-13)
- Option B: Explorer's Root section gets a switch, "Room checkout" | "This discussion's worker"
  (now the three-choice bar in `drawings/three-tabs.svg`). (User, 2026-11-13)
- Switching copies keeps the open root file at the same path, or shows "not in this copy";
  discussion files don't change. (User, 2026-11-13)
- Explorer lists all non-hidden, non-gitignored root files; code and config files show as plain
  text; binary files are listed greyed out and can't be opened. (User, 2026-11-13)
- The design in `drawings/three-tabs.svg` and `drawings/peek.svg` is accepted (peek ends only
  on Back to current or switching discussions), with one correction: Explorer shows one
  workspace at a time, with a toggle, to leave more room for browsing. (User, 2026-11-13)
- The toggle is one bar of three choices at the top of Explorer:
  `[ Discussion | Room checkout | Worker copy ]`. (User, 2026-11-13)
- Explorer's activity line (`#activity`, `src/docs.mjs:463`) is removed; the current
  discussion's agent and worker activity shows in the header, under its name (`#disc-status`).
  (User, 2026-11-13)
- The header's discussion section splits in two: left as today (the shown discussion, its
  Actions and status); right, every open discussion whose worker is working, the shown one
  included, as "<name> · Worker is working" (from `room.open`, `src/ui.mjs:1077`). Agents
  discussing in other discussions can be added later. (User, 2026-11-13)
- **View** on a received discussion stays the whole-window read-only mode (header and chat show
  the peer's conversation); a separate, clearly labelled action peeks at its files only.
  (User, 2026-11-13)

- Drawings `three-tabs.svg` and `peek.svg` fully approved; work goes to the worker in two
  slices: Slice 1 (tabs, header, room files, peek), then Slice 2 (Worker copy). Slice 1 was sent
  and done. (User, 2026-11-13)
- Slice 1 merged into main (`ce3d1ea`); the User checked the panels on screen and closes this
  discussion. Slice 2 (Worker copy) and the unmeasured gitignore-check cost move to
  `discussions/2026-11-11-viewing-worker-output-before-merge/`. (User, 2026-11-13)

## The problem
Documents in the room's root, such as `docs/architecture.md`, `docs/diagrams/*.svg` and
`README.md`, can't easily be seen from the room's screen, although they are sometimes the
important ones.

## Evidence (tested: read in src/ on 2026-11-13)
- Explorer lists only `discussions/`: `ctx.screen.sections = ['discussions']` (`src/ui.mjs:286`);
  `/__files` lists only those sections (`docFiles()` in `src/docs.mjs:75`).
- The file server itself would allow any non-hidden file inside the root (`inside()` in
  `src/docs.mjs:60`), so the limit is in what Explorer offers, not in what can be served.
  Assumed, not tested: opening a root file by its URL works today.
- In `src/docs.mjs:2137-2138`, `.md` files are rendered with `marked`, and `.png`, `.jpg`, `.jpeg`,
  `.gif`, `.webp`, `.svg`, `.pdf`, `.html`, `.txt`, and `.json` have MIME types in `TYPES` (`src/docs.mjs:20-24`).
  Any other extension (such as `.mjs` or `.yml`) is served as `application/octet-stream`, which triggers
  a browser download rather than showing in the Document `<iframe>`.
- `listFiles()` (`src/docs.mjs:42-53`) walks all non-hidden directories recursively without skipping
  `node_modules/` or gitignored paths.
- **Worker worktrees per discussion (`src/ui.mjs:2108-2164`):**
  - Each discussion `<name>` has its own worker lane: worktree `<repo>.workers/<name>/` on branch `worker/<name>` (`place.cwd` is the room root's path inside that worktree).
  - The shared `<repo>.worker/` on branch `worker/main` is used for brainstorms, tasks before a discussion's first message, or legacy commits before per-discussion lanes (such as `docs/architecture.md` on `worker/main`).
  - `existingLanes(ctx)` (`src/ui.mjs:2151-2164`) already discovers both `worker/main` and all `<repo>.workers/<name>/` worktrees that exist on disk.
  - A discussion's own notes and drawings always live in `<roomRoot>/discussions/<name>/` (never in the worker worktree, per `src/ui.mjs:2109-2110`).

## Proposed (by agents)
- **User's direction (under discussion):** Split the right pane into **Discussions** (discussion state and actions), **Explorer** (files of the current discussion and room root), and **Document**.
- **Claude:** Filter ignored/hidden folders (e.g. `node_modules/`) and show root folders collapsed; optionally let Explorer's Root section switch between `main` and the worker's worktree.
- **Codex:** Keep `discussions/README.md` reachable; show the workspace name alongside the root; keep the current discussion's files coming from `<roomRoot>/discussions/<name>/` while root files come from the selected workspace; clarify how worker workspaces are chosen when multiple discussions/lanes exist.
- **Agy:** Serve unknown text/code extensions as `text/plain; charset=utf-8` (or filter Explorer to documents) so clicking a root file never triggers a surprise browser download; if Explorer's Root section offers a workspace selector, populate it from the room checkout plus `existingLanes(ctx)` (e.g. `main (room)`, this discussion's `worker/<name>` if it exists, and `worker/main` if it exists).
