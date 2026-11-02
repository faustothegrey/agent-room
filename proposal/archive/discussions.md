# Discussions: keeping a topic's documents and transcripts together

> **Historical archive — 2026-11-02.** The basic feature is implemented. Remaining decisions are tracked in [the current discussion proposal](../discussions.md). Earlier status labels and next steps below describe the original discussion, not current work. See [the proposal index](../README.md).

Status: design approved by the User (2026-11-02), not implemented. Started 2026-11-02. Follows `document-folders.md` (new room in another
folder). Nothing here is implemented.

## Decided (by the User, 2026-11-02)
- **What a room is:** a place on your disk where there is some work you want to discuss with
  your agents. The room's folder is its **root**.
- The root holds **the work itself** (code, educational material, other artifacts). The room's
  own records go in a required **discussions folder** inside it.
- A **discussion** groups a topic's notes, drawings and session transcripts in one folder. It
  can span several sessions (one session = one run of the room). The word "bundle" is dropped.
- Each discussion has a **name generated automatically, which the User can override**.
- **Folder names stay fixed** for now: renaming a discussion doesn't move its folder.
- **The UI shows only the discussions** for now, not the rest of the root.
- A configuration file ("room file") is **possible later**, not now.
- **The list shows all the room's discussions**; you open one to see its documents. The
  **active discussion's name is shown beside the root path**. (User approved Codex's proposal.)
- **Looking is not switching:** opening another discussion's documents only changes what you
  see; the conversation and agents stay in the active discussion. "Continue this discussion" is
  a separate, explicit action. (Proposed by Claude, agreed by Codex.)
- **What agents remember:** while the room stays open, going back to a discussion keeps its
  agents' context; after closing and reopening the room, agents start fresh from the handoff.
  (Proposed by Codex, agreed by Claude.)
- **Naming:** an agent suggests a short title from the User's first message; until then the
  room shows "New discussion — date, time". The folder is named once, as date + first title,
  and never moves; later edits change only the displayed title. Automatic naming never
  replaces a title the User has edited. (Proposed by Codex, agreed by Claude.)
  Exception: if title generation fails, the folder is named with only the date and time
  (User, 2026-11-02; details in `document-folders.md`).

## Shape (example)
```
<root>/                          ← the work: src/, test/, …
  discussions/
    2026-11-02-organising-discussions/
      discussions.md
      drawings/
      transcripts/
        session-2026-11-02-1014.md
```

## Also decided (User approved these agent proposals together, 2026-11-02)
- **One active discussion per room**, chosen when opening it: "New discussion" or
  "Continue discussion" (Codex, Claude).
- **Starting fresh** (after a restart, see Decided) doesn't replay old transcripts. The first
  agent reads the discussion's `handoff.md` if there is one. If there isn't, the agents are told
  so, and can still read the discussion's notes and transcripts (Claude, Codex).
- **Links:** documents in a discussion refer to each other by relative path (`drawings/x.svg`),
  and to other discussions or root files by full path from the root (Claude, Codex).
- **Project documents live in the root.** A discussion's own notes stay in its folder. Moving a
  proposal into the root is an explicit action, so there is one authoritative copy (Codex).
- **Existing records:** left untouched in the first version (Codex, Claude). Later, today's
  `proposal/` and `transcripts/` could become one discussion for older work (e.g.
  `discussions/before-2026-11/`), after checking references and the paths agent-room expects.
- **Switching waits** for agents' replies to finish (Codex).

## Consequences to keep in mind (from reading the code and docs, not tested)
- `README-for-brainstorming-agents.md` says agents write in `proposal/` and use
  `proposal/handoff.md`. Those rules would point at the active discussion's folder instead.
- `document-folders.md` proposed that a new room's list show the whole chosen folder. The
  User's decision above (show only discussions) replaces that for now.

## Open questions for the User
- None at the moment. Costs of keeping agent context vs starting fresh are unmeasured.

## Unresolved disagreements
- None open. Resolved 2026-11-02: Codex first proposed that opening a discussion switches to
  it; Codex withdrew this in favour of keeping looking and switching separate.
