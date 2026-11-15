# Stage B: replication, slice 1 (task specification for the worker)

Status: **draft by Claude, 2026-11-07, for the User's review**. It isn't authorized until the
User sends the instruction at the end of this file. Drawing:
[drawings/stage-b.svg](drawings/stage-b.svg). Inspection record:
[stage-b-inspection.md](stage-b-inspection.md).

This file doesn't repeat the approved design. It says **which parts** of it stage B builds, adds
the decisions made since, and lists what B0 taught us. Approved sources:
[proposal.md](proposal.md) ("Build in slices", slice 1), [ui-design.md](ui-design.md) (panels A,
B, C, F, G), [implementation-plan.md](implementation-plan.md) ("Slice 1" and the sections it
relies on), [rollout.md](rollout.md) (stage B row).

## Decided by the User since the design was approved
1. **New file `src/replicate.mjs` is allowed** (Q1, 2026-11-07). The rest stays as small hooks in
   `ui.mjs`, `cli.mjs` and `docs.mjs`.
2. **Port the B0 prototype** (`worker/main`, commit `5153ce1`) into `src/replicate.mjs`, turn its
   checks into ordinary tests under `test/` with **equivalent coverage** (not necessarily the same
   85 checks), and **remove `prototype/`** in the same work.
3. **Taken port with `--peer`:** stop with a clear error naming the port, instead of moving to a
   random one (Q2). Without `--peer`, today's fallback is unchanged (`src/ui.mjs:909–921`).
4. The User merges the worker's branch with a **standard merge** (Q3). Nothing merges
   automatically.

## What stage B builds (slice 1: replication and View, no Continue here)
- **Flags:** `--node <name>` and repeatable `--peer <name>=http://<ip>:<port>`. Without
  `--node`/`--peer`, replication is disabled and `src/replicate.mjs` is not loaded. The
  approved network binding change below still applies.
- **Network:** `npm start` binds `0.0.0.0`, prints usable addresses (panel G), and keeps the
  same-origin protection. README "Access and limits" is updated (proposal, "Network").
- **Pairing:** the **Pair with …** action in a Peers section (panel G). It shows both room folders
  and refuses on a room-ID mismatch, replacing nothing.
- **Round commits:** at the end of each round (after the summary, if any), one commit on this
  node's line in the separate discussion storage, including failed and interrupted rounds,
  with the round metadata the implementation plan lists ("Round commit contents"). Capture it
  even though slice 1 doesn't restore it yet.
- **Sending:** to each paired peer, in the background, with bounded retry. An unreachable peer
  never makes the conversation wait (panel F status lines).
- **Receiving and View:** received lines appear in the Discussions pane (panel B) and open
  read-only (panels A2 and C). **Continue here** is hidden until slice 2.

## Learned from B0, to apply in stage B
- **Transcripts must replicate.** The project's `.gitignore` ignores `transcripts/`. Build
  commits from the folder's bytes the way B0 does (plumbing, no ignore or filter rules), and
  test that a transcript arrives.
- **Peer endpoint:** there's no peer HTTP endpoint today. Stage B adds it (B0's `POST /replica/*`).
- **Snapshot disk growth:** each received round is a full copy (~600 KiB for this discussion).
  **Rule (proposed by Claude, accepted by the User 2026-11-07):** keep the latest published snapshot of each
  line plus any snapshot currently open in View, and delete older snapshot folders (their
  commits stay in Git, so history remains available). An open View must pin its snapshot
  across all browser clients and concurrent publication; cleanup must not invalidate its
  document or image requests. Document when a pin is released and how abandoned clients
  are handled. The rule is decided; how pins work is the worker's to design and report.
- **Storage location (accepted by the User, 2026-11-07):** `<room root>/.agent-room/`
  holding the separate Git storage, snapshots and the room/node IDs, kept out of the project's
  Git with `.git/info/exclude` the way `.worker-notes/` is, and excluded from the header's `+`.
- **Performance:** a round took ~0.5 s on the Mac and started `git` 26–46 times.
  The claim that process startup dominates is an assumption, not a profiling result. Use
  `cat-file --batch` where it's simple. Measure again; charon is unmeasured.
- **Git version:** the Mac has Git 2.33. Use only commands it supports, and print the Git version
  at startup in peer mode so charon's is visible.
- **Round metadata** lives in the reserved `.agent-room-round.json` at the tree root (B0's
  choice), unless the worker finds a reason against it.
- **B0's untested crash points** (listed in `stage-b0-report.md`) stay listed as untested unless
  stage B tests them.

## Not in stage B
Continue here, Accept this line as reconciled, Fork from here (slice 2, stage C). No remote stop,
no source replication, no distributed worker, no authorization, no new npm dependency.

## Done when
- `npm test` is green in the worker's worktree, real output included; B0's coverage is preserved.
- A **two-root local demonstration** on the Mac: two servers, two temporary roots, two ports,
  paired. A round on one appears on the other and opens read-only in View. A deleted drawing
  disappears. Stopping the receiver, running a round, and restarting it: the round arrives later.
  A taken port with `--peer` gives the clear error.
- **Screenshots** of panels A, B, C, F and G in Chrome, from the demonstration.
- **Code size** measured: lines added per file, and `src/replicate.mjs` on its own.
- **Storage growth** measured over repeated rounds, on both nodes, kept separate: the Git
  storage on disk and the snapshot folders (Codex, 2026-11-07). B0 measured only transfer sizes.
- The worker's report `stage-b-report.md` in this folder: what was built, deviations and why,
  the real outputs, measurements, and **what wasn't checked** (charon, a real LAN).
- Nothing committed unless the User asks; nothing merged.

## Instruction for the Worker (draft, not sent)
> Build stage B, replication slice 1, as specified in
> `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/stage-b-spec.md`, which
> lists the approved documents it relies on. Only this stage is authorized: no Continue here,
> reconciliation or Fork. First check the documents against the current source (including the B0
> commit `5153ce1` on `worker/main`) and list any contradictions before writing code. The
> storage location and the snapshot rule in the spec are accepted by the User. Write your report
> in `stage-b-report.md` in that folder.
