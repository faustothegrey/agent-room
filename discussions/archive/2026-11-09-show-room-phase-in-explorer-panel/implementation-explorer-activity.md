# Implementation notes: Explorer activity line (worker, 2026-11-09)

Uncommitted on `worker/main`. Only `src/docs.mjs` and `README.md` changed; there's no server change.

- A line under Explorer's tabs (`#activity`, above the list) is redrawn whenever the page's
  `localThinking` or `localWorking` changes, through `updateReplicaView()`.
- It reads: `Idle`, `<Agent> is thinking`, `Worker is working`, or both joined by " · ". It shows the
  same in every left tab and in paused, "your turn" and brainstorm states.
- The dots come from CSS, so the text stays exact: a green ● before thinking, an amber ● before the
  worker and ○ before Idle.
- The "in use" label and the header are unchanged.
- Browser check: a scripted room with slow scripted agents and worker, no agent turns. It showed
  "Idle", then "Claude is thinking · Worker is working", "Codex is thinking · Worker is working"
  (Worker tab selected) and "Worker is working".
