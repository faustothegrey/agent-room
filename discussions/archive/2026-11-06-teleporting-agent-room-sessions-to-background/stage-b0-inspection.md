# Stage B0: human inspection record

Prepared by Codex, 2026-11-07. This is a blank review aid, not test evidence or acceptance.
Use alongside [the specification](stage-b0-prototype.md) and the worker's future
`stage-b0-report.md`. B0 remains a draft until the User sends its instruction.

## Worker evidence
- Tested commit / branch: pending
- Node and Git versions: pending
- Rerun command and real output: pending
- Full and incremental bundle bytes / measured transfer times: unmeasured
- Prototype source lines (counting method stated): unmeasured
- `npm test` result: not run for B0 yet

## Human review
- [ ] Rerun the prototype and compare its output with the report.
- [ ] Inspect path/content comparisons, including deletions and unchanged older snapshots.
- [ ] Inspect failure checks, lost acknowledgement and restart recovery evidence.
- [ ] Check rejected identity/schema and unsafe-tree cases.
- [ ] Review deferred concerns and limitations; Mac results do not establish Pi performance.
- [ ] Review code size and the proposed production file boundary.

## User decisions after inspection
- Prototype accepted / changes requested: pending
- New production replication file allowed: undecided
- Prototype disposition (merge / retain on branch / discard): undecided
- Stage B authorization: not granted by this record

## Independent rerun by Codex — 2026-11-07
Tested in `/Users/fausto/Software/agent-room.worker`, base HEAD `44bf6b163a`,
Node v24.14.1, Git 2.33.0. Prototype files remain uncommitted.
- `node prototype/replication/run.mjs`: exit 0; **85 passed, 0 failed**.
  The worker's 86-check run includes `--measure`; that optional block adds one
  real-folder comparison. This rerun omitted that block and did not independently
  reproduce the real-folder measurements.
- `npm test`: exit 0; **97 passed, 0 failed**, duration 5852.621689 ms.
- Prototype output confirmed project HEAD/status unchanged by its run.
- Small-fixture typical incremental transfers: 651/619/614 bytes,
  355/336/344 ms respectively. These are local Mac measurements only.
This reruns the supplied checks; it is not an independent implementation or a full
source review. User acceptance and production authorization remain pending.
