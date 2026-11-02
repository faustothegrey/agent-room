# agent-room's discussions

This repository is the agent-room room itself. Each discussion is a dated folder holding its
documents, its drawings and its session transcripts (`transcripts/`). Until 2 November 2026 the
documents lived in `proposal/` (split into `archive/` and `deferred/`) and the room logs in a
separate `transcripts/` folder; each was then moved into the discussion it belongs to. Seven
empty logs (a room opened and closed without a message) were deleted.

For current product behavior, setup and commands, read [the project README](../README.md).
Discussion and worker instructions live in the two root rulebooks. These folders hold
remaining decisions, historical designs and deferred research; they are not the product manual.

**Remaining decisions:** [Discussions and document browsing](2026-11-02-discussions-and-folders/discussions.md).
This is the short list of unfinished or deferred items, not authorization to implement them.

## The discussions

- **[2026-10-18-first-rooms](2026-10-18-first-rooms/)** — the first rooms, trying agent-room
  out. Transcripts only.
- **[2026-10-20-educational-app-tooling](2026-10-20-educational-app-tooling/)** — tooling for
  building educational maths and science apps. *Deferred research:*
  [Educational app tooling](2026-10-20-educational-app-tooling/edu-app-tooling.md) (background),
  [Visual harness](2026-10-20-educational-app-tooling/agent-room-visual-harness.md) (main
  preview-and-reference design, with drawings 1–3 in `drawings/`),
  [Crit and Vibeyard](2026-10-20-educational-app-tooling/crit-vibeyard.md) (preview-tool research),
  [Core and UI](2026-10-20-educational-app-tooling/core-and-ui.md) (architecture; remote attachment
  and unattended sessions remain possibilities, the web UI now exists). *Historical:* the
  [October 20 handoff](2026-10-20-educational-app-tooling/handoff-read-20261020-000000.md).
- **[2026-10-20-discussion-ide](2026-10-20-discussion-ide/)** — chat and document side by side.
  *Historical:* [Discussion IDE](2026-10-20-discussion-ide/discussion-ide.md) (implemented basic
  layout), [Documentation refocus](2026-10-20-discussion-ide/agent-room-refocus.md) (completed work
  order), the [October 21 handoff](2026-10-20-discussion-ide/handoff-read-20261021-090759.md), and
  drawings 4–5 in `drawings/`.
- **[2026-10-21-electron-app](2026-10-21-electron-app/)** — a desktop app or a Dock icon.
  *Historical:* [Electron app](2026-10-21-electron-app/electron-app.md) (deferred in favor of the
  Dock launcher), [Dock launcher](2026-10-21-electron-app/dock-launcher.md) (implemented).
- **[2026-11-02-discussions-and-folders](2026-11-02-discussions-and-folders/)** — discussions as
  folders, and opening rooms in other folders. *Current:* the
  [remaining decisions](2026-11-02-discussions-and-folders/discussions.md). *Historical:* the
  [original discussions design](2026-11-02-discussions-and-folders/discussions-original.md) and the
  [original folder-opening design](2026-11-02-discussions-and-folders/document-folders.md), both
  mostly implemented, and drawing 6 in `drawings/`.

Historical documents keep their original decisions and context beneath a status notice;
archiving does not revoke earlier User decisions. Drawing labels describe the design at the time.
Contradictions and unfinished decisions remain explicit in the remaining-decisions list rather
than being silently resolved.
