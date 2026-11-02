# Proposals

For current product behavior, setup and commands, read [the project README](../README.md).
Discussion and worker instructions live in the two root rulebooks. This directory holds
remaining decisions, historical designs and deferred research; it is not the product manual.

- **Remaining decisions:** [Discussions and document browsing](discussions.md). This is the
  short list of unfinished or deferred items, not authorization to implement them.
- **Historical archive:** `archive/`. Completed proposals, consumed handoffs, and
  superseded designs retain their original decisions and context beneath a status notice.
- **Deferred research:** `deferred/`. Possible future work, separate from current
  implementation. External tool descriptions have not been revalidated during cleanup.

## Historical archive

- [Documentation refocus](archive/agent-room-refocus.md) — completed work order.
- [Discussion IDE](archive/discussion-ide.md) — implemented basic layout and historical UI decisions.
- [Dock launcher](archive/dock-launcher.md) — implemented.
- [Electron app](archive/electron-app.md) — deferred in favor of the Dock launcher.
- [Original discussions design](archive/discussions.md) — mostly implemented; remaining items are listed above.
- [Original folder-opening design](archive/document-folders.md) — mostly implemented; remaining items are listed above.
- [October 20 handoff](archive/handoff-read-20261020-000000.md) and
  [October 21 handoff](archive/handoff-read-20261021-090759.md) — consumed session records.
- Historical drawings: [earlier IDE sketch](archive/drawings/4-discussion-ide.svg),
  [simplified IDE](archive/drawings/5-ide-hypothesis.svg),
  [new-room flow](archive/drawings/6-new-room.svg). Labels describe the design at the time.

## Deferred research

- [Visual harness](deferred/agent-room-visual-harness.md) — main preview-and-reference proposal,
  with its three drawings in `deferred/drawings/`.
- [Crit and Vibeyard](deferred/crit-vibeyard.md) — supporting preview-tool research.
- [Educational app tooling](deferred/edu-app-tooling.md) — broader background and overlapping research.
- [Core and UI](deferred/core-and-ui.md) — historical architecture discussion; remote attachment
  and unattended sessions remain unimplemented possibilities. The web UI now exists.

In the browser Documents list, archived and deferred files are grouped behind their folder
entries rather than mixed into the main proposal list.

The archive preserves earlier User decisions; archiving does not revoke them. Contradictions
and unfinished decisions remain explicit in the current proposal rather than being silently resolved.
