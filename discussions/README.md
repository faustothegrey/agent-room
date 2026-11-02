# agent-room's discussions

This repository is the agent-room room itself. Each discussion is a dated folder holding its
documents, its drawings and its session transcripts (`transcripts/`). Active discussions sit
directly in `discussions/`; finished ones move, whole, into `archive/`, and postponed ones into
`deferred/` (with the Archive, Defer and Make active buttons on a discussion's page). Until
2 November 2026 the documents lived in `proposal/` and the room logs in a separate `transcripts/`
folder; each was then moved into the discussion it belongs to. Seven empty logs (a room opened
and closed without a message) were deleted.

For current product behavior, setup and commands, read [the project README](../README.md).
Discussion and worker instructions live in the two root rulebooks. These folders hold
remaining decisions, historical designs and deferred research; they are not the product manual.

**Remaining decisions:** [Discussions and document browsing](2026-11-02-discussions-and-folders/discussions.md).
This is the short list of unfinished or deferred items, not authorization to implement them.

## Active

- **[2026-11-02-discussions-and-folders](2026-11-02-discussions-and-folders/)** — discussions as
  folders, and opening rooms in other folders. *Current:* the
  [remaining decisions](2026-11-02-discussions-and-folders/discussions.md). *Historical:* the
  [original discussions design](2026-11-02-discussions-and-folders/discussions-original.md) and the
  [original folder-opening design](2026-11-02-discussions-and-folders/document-folders.md), both
  mostly implemented, and drawing 6 in `drawings/`.

## Archive

- **[2026-10-21-electron-app](archive/2026-10-21-electron-app/)** — a desktop app or a Dock icon:
  [Electron app](archive/2026-10-21-electron-app/electron-app.md) (dropped in favor of the Dock
  launcher), [Dock launcher](archive/2026-10-21-electron-app/dock-launcher.md) (implemented).
- **[2026-10-20-discussion-ide](archive/2026-10-20-discussion-ide/)** — chat and document side by
  side: [Discussion IDE](archive/2026-10-20-discussion-ide/discussion-ide.md) (implemented basic
  layout), [Documentation refocus](archive/2026-10-20-discussion-ide/agent-room-refocus.md)
  (completed work order), the
  [October 21 handoff](archive/2026-10-20-discussion-ide/handoff-read-20261021-090759.md), and
  drawings 4–5 in `drawings/`.
- **[2026-10-18-first-rooms](archive/2026-10-18-first-rooms/)** — the first rooms, trying
  agent-room out. Transcripts only.

## Deferred

- **[2026-10-20-educational-app-tooling](deferred/2026-10-20-educational-app-tooling/)** — tooling
  for building educational maths and science apps:
  [Educational app tooling](deferred/2026-10-20-educational-app-tooling/edu-app-tooling.md) (background),
  [Visual harness](deferred/2026-10-20-educational-app-tooling/agent-room-visual-harness.md) (main
  preview-and-reference design, with drawings 1–3 in `drawings/`),
  [Crit and Vibeyard](deferred/2026-10-20-educational-app-tooling/crit-vibeyard.md) (preview-tool research),
  [Core and UI](deferred/2026-10-20-educational-app-tooling/core-and-ui.md) (architecture; remote
  attachment and unattended sessions remain possibilities, the web UI now exists), and the
  [October 20 handoff](deferred/2026-10-20-educational-app-tooling/handoff-read-20261020-000000.md).

Historical documents keep their original decisions and context beneath a status notice;
archiving does not revoke earlier User decisions. Drawing labels describe the design at the time.
Contradictions and unfinished decisions remain explicit in the remaining-decisions list rather
than being silently resolved.
