# Multiple persisted brainstorms, with their own right-pane tab

## Request (User, 2026-11-15)
"More than one brainstorm, and have them persisted. The title will generate automatically by an
agent, as for discussions, and they will have a dedicated right panel tab, as for the discussions
tab today."

## Current behavior (from README.md:249-258, not tested)
- One brainstorm per room; New brainstorm discards it. Kept only in server memory: survives
  refresh/Reload, lost on Restart or Quit. No title, folder, transcript, notes, handoff, checkpoint.
- The 2026-11-09 design said brainstorms "do not need persistence per se"
  (`discussions/archive/2026-11-09-adding-a-lightweight-brainstorming-mode/notes.md:9`). This request reverses that.

## Decided (User)
- Several brainstorms, persisted, auto-titled by an agent, with a dedicated right-pane tab.
- Stored in the project, in a `brainstorms/` folder (portability matters later). Local-only storage rejected.
- Brainstorming agents produce nothing tangible beyond the conversation; when asked or inclined to
  produce something, they propose turning the brainstorm into a discussion (all agents supported it).
- The Worker is not available during a brainstorm (User, 2026-11-15).
- On conversion to a discussion, agents keep their sessions if possible (User, 2026-11-15).
- Brainstorms tab actions: Resume / Go to, Close, Turn into a discussion, Delete; no Archive or
  Defer (User, 2026-11-15; first three proposed by agents). Also Start fresh in the tab's row
  menu, and Turn into a discussion in the header's Actions ▾ menu (agents proposed, User approved).
- Several brainstorms can be open side by side, like discussions (User, 2026-11-15).
- Restart brings open brainstorms back from their checkpoints, like discussions (User, 2026-11-15).
- The Brainstorms tab shares the Discussions tab's row layout and drag-and-drop sorting, from the
  same code, with its own order key (User, 2026-11-15).
- Delete rules, as proposed below (User, 2026-11-15): two-click confirmation always warning that
  uncommitted transcripts and drawings are lost for good; only a closed brainstorm, checked in the
  tab and again by the delete operation itself (Codex).
- Drawings are the one exception to "conversation only", if not too complex (User, 2026-11-15).
- Fresh start when a brainstorm's sessions can't resume: brief from the latest summary (marked if
  not agreed); with none, point agents to its saved transcripts to read first, saying they are the
  source and any summary of them may omit details (User, 2026-11-15).

## Proposed
- **Claude:** Store each in `brainstorms/<date>-<title>/` at the room root (sibling of `discussions/`),
  holding only `transcripts/` and a checkpoint, no notes/drawings/handoff. Agents still write no files.
  What still separates a brainstorm from a discussion: no notes or handoff, no Attach, no auto dev,
  no auto-summary, 20-lap cap (see `discussions/2026-11-15-remove-brainstorm-summary-and-relax-round-caps/`).
- **Codex:** Follow the discussion split (`README.md:262-265`): transcripts in the project folder
  (portable), checkpoints in local state (`~/.local/state/agent-room/paused/`). Supports the User's
  boundary ("a brainstorm's output is the conversation; when an idea needs an artifact, agents
  propose a discussion") and interprets it as ruling out Worker tasks during a brainstorm too. Notes
  that if promotion preserves provider sessions, agents need a way to receive their new discussion
  instructions and folder path.
- **Agy:** Strongly supports the User's rule: it makes a brainstorm strictly *read-only exploration*
  (only `brainstorms/<date>-<title>/transcripts/` + local checkpoint; no `notes.md`, `drawings/`, or
  Worker tasks), and promotion to a discussion is the single gate that unlocks creating artifacts
  (notes, drawings, Attach, Worker). On Codex's question: when `brainstorms/<name>/` moves to
  `discussions/<name>/`, agent-room can record an `[agent-room]` message in the transcript (or a
  one-time per-agent notice like `state.restored` in `src/room.mjs:84`) giving the new
  `discussions/<name>/` path and unlocking discussion rules, while keeping the same provider sessions.
- **Claude (on Start fresh):** Brainstorms still have manual **Summarize** (`README.md:411`), so
  Start fresh can brief new sessions from the latest summary (not-agreed ones marked), or let the
  User choose transcript excerpts when there is no summary.

- **Claude (drawings, cost read in the code, not measured):** agents write only
  `brainstorms/<name>/drawings/`; the folder exists anyway, and drawings move with it on
  conversion. Main cost: Explorer/Document must show a brainstorm's folder as they do a
  discussion's (`src/docs.mjs`), plus one rulebook line.
- **Agy (Explorer/Document check in `src/docs.mjs:103-139, 1463`):** `inDiscussion()` and
  `docFiles()` only need to include `brainstorms/` alongside `discussions/`, and Explorer already
  reads `room.active` (`src/docs.mjs:1463`), so showing a brainstorm's `drawings/` and
  `transcripts/` in Explorer and Document is small and shared with the new tab.
- **Conversion (Claude, Codex, Agy; code checked, cost unmeasured):** All three lean toward moving
  `brainstorms/<name>/` to `discussions/<name>/` and keeping the existing provider sessions (with a
  conversion notice via `state.restored` in `src/room.mjs:84` and a rulebook line), rather than
  starting fresh sessions. In `src/ui.mjs:205, 570-577` and `src/agents.mjs:36`, discussion and
  brainstorm agents always run with `cwd = ctx.cwd` (the room's root) and the same system rulebook,
  so provider session storage (`~/.claude/projects/...`, Codex, Agy) is keyed to the room root and
  unaffected by moving `brainstorms/<name>/` to `discussions/<name>/`.

- **Checkpoints & Restart (Claude, Codex, Agy; `src/ui.mjs:527-535, 616, 653-830`):** Keep existing
  discussion checkpoint keys as `name` (`sha256(name).json` in `src/ui.mjs:616`) for backward
  compatibility, and key brainstorm checkpoints as `brainstorms/<name>`. Also have
  `createDiscussionFolder` (`src/ui.mjs:527`) check both `discussions/` and `brainstorms/` so a
  new folder name never collides when converting a brainstorm to a discussion.

- **Delete (Claude, Codex, Agy; `src/docs.mjs:1133, 1288`):**
  - Use the existing two-click `confirmed()` button helper (`src/docs.mjs:1133`, used by Start
    fresh, Rollback, Quit) rather than a browser dialog, always warning that `brainstorms/<name>/`
    (transcripts, drawings) and its checkpoint are removed and any uncommitted files are permanently
    lost.
  - Disable **Delete** while the brainstorm is open (`isCurrent || openHere`, matching how Archive
    is disabled in `src/docs.mjs:1288`, with tooltip "Close this brainstorm before deleting it"),
    which also prevents racing with an in-progress round.
  - The delete operation itself also refuses an open brainstorm, so a stale or direct request
    can't remove files in use (Codex).

- **Tab layout & drag-and-drop sorting (Claude, Agy; `src/docs.mjs:1191-1355`):**
  - `src/docs.mjs:1193-1223` stores the order in `localStorage` per room (`agent-room.discussion-order:<folder>`), automatically placing any newly arrived name at the top and dropping names that left (`orderDiscussions`, line 1205).
  - Giving **Brainstorms** its own key (`agent-room.brainstorm-order:<folder>`) and sharing the row/drag-and-drop helper (`⠿` handle + `Move up` / `Move down` in the row menu) means a brainstorm converted to a discussion automatically drops from **Brainstorms** and appears at the top of **Discussions** (matching how unarchived discussions behave, `src/docs.mjs:1218`).

## Status
- Implemented by the Worker and merged into `main` as `38823e0` (2026-11-15); 242 tests pass (run by Claude on the branch).
- Not yet tried: a real provider session resuming after Turn into a discussion and after Restart (tests used scripted replies).
