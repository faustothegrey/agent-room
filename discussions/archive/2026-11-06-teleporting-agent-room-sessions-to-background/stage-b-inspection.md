# Stage B: human inspection record

Prepared by Claude, 2026-11-07. A blank review aid, not test evidence or acceptance. Use it with
[the specification](stage-b-spec.md) and the worker's future `stage-b-report.md`.

## Worker evidence
- Branch and commit (or tree ID if uncommitted): pending
- Node and Git versions: pending
- `npm test` real output: pending
- B0 coverage preserved (which checks map to which tests): pending
- Code size: lines added per file; `src/replicate.mjs` alone: unmeasured
- Round time and bytes on the Mac: unmeasured. charon: unmeasured

## Human review (two-root demonstration on the Mac)
- [ ] Without `--node`/`--peer`, the room looks and behaves as before.
- [ ] Startup prints the addresses and peers (panel G).
- [ ] **Pair with …** shows both folders; a wrong room is refused and nothing is replaced.
- [ ] A round on node 1 shows "Round N saved · sent to …" (panel F).
- [ ] Node 2's Discussions pane lists node 1's line with "received …" (panel B).
- [ ] **View** opens it read-only: no message box, no agents start (panels A2, C).
- [ ] A transcript arrives (it's ignored by the project's `.gitignore`).
- [ ] A deleted drawing disappears on node 2.
- [ ] Receiver stopped, a round run, receiver restarted: the round arrives later; node 1 never waited.
- [ ] A taken port with `--peer` stops with a clear error.
- [ ] The project's own Git state (HEAD, `git status`) is unchanged by replication.
- [ ] `prototype/` is gone and `src/replicate.mjs` reads in one sitting.
- [ ] "Not checked" list read: charon, real LAN, B0's untested crash points.

## User decisions
- Storage location `<root>/.agent-room/`: accepted, 2026-11-07
- Snapshot keep rule (latest + open in View): accepted, 2026-11-07
- Stage B accepted / changes requested: pending
- Merge into `main`: pending (standard merge)
- Stage C authorization: not granted by this record
