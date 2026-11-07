# Stage B0: replication prototype

Stand-alone. The room never loads these files, and `npm test` doesn't run them. The
specification is `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/stage-b0-prototype.md`,
and the results are in `stage-b0-report.md` next to it.

```sh
node prototype/replication/run.mjs                     # every check; exit code 0 only if all pass
node prototype/replication/run.mjs --measure <folder>  # also time a copy of a real discussion folder
node prototype/replication/run.mjs --keep              # keep the temporary nodes for inspection
```

Needs Node ≥ 20 and `git` on the PATH. No npm dependency. All work happens in a new temporary
folder, which is removed at the end. The folder given to `--measure` is only copied, never written.

- `replica.mjs`: the protocol. A node's own Git storage, round capture, bundles, the HTTP
  endpoint (`POST /offer`, `POST /bundle`), checks, read-only snapshots, the published pointer,
  and restart recovery.
- `run.mjs`: the scenarios and their checks, each printed with its expected and actual values.
  It also holds the generated fixtures.
- `crash-child.mjs`: receives one bundle in a separate process and exits abruptly at a chosen
  point, for the restart checks.
