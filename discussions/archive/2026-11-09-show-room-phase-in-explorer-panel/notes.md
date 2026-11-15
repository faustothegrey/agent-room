# Show the room's state in Explorer

## Decided (User, 2026-11-09)
- "Room state" means only: **idle**, **Claude/Codex is thinking**, **worker is working**.
- Agents' turns and the worker can run at the same time; then **show both**.
- The worker part says just `Worker is working` (for now).

## Proposed (Claude, Codex)
- One status line under Explorer's title, independent of the selected left tab.
  See [drawings/explorer-status-line.svg](drawings/explorer-status-line.svg):
  - `Idle` · `Claude is thinking` · `Worker is working` · `Codex is thinking · Worker is working`
- `Idle` only when neither runs; paused / your turn / brainstorm stay header details.
- Keep "in use" on the discussion's row; don't attach worker activity to a folder (Codex).
- The page already tracks both states (`localThinking`, `localWorking` in `src/docs.mjs`);
  the peer read-only view already combines them. Assumed, not tested: no server change needed.

## Outcome (2026-11-09)
- Implemented by the worker as `2cdab4d` and merged into `main` by the User.
- Side fix, decided by the User in this discussion: a paused Auto dev run can be finished by an
  agreed summary ending in `Outcome: FINISH`, with clearer FINISH / WAIT FOR USER definitions
  (`bc04eca`, merged). See [implementation-explorer-activity.md](implementation-explorer-activity.md).
- Reviewed by Claude and Codex; tests reported by the worker (130/130), not re-run by them.
- Not checked live: paused, brainstorm and read-only View states; long thinking labels.
