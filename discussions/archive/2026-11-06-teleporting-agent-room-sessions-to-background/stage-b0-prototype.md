# Stage B0: replication prototype (task specification for the worker)

Status: **draft by Claude, 2026-11-07, for the User's review**. It isn't authorized until the
User sends the instruction at the end of this file. Based on the User's decision on Q1
([before-b-questions.md](before-b-questions.md)): build the Git bundle prototype first, then
judge from the actual code where replication should live. Drawing:
[drawings/b0-prototype.svg](drawings/b0-prototype.svg).

## Why a prototype first
Stage B copies each discussion's history between the Mac and charon using Git bundles
([implementation-plan.md](implementation-plan.md), "Replication protocol and prototype").
Whether bundles work well for this, how big the code becomes, and how big and slow the
transfers are have never been measured. B0 answers those questions **before** anything is
added to the room itself.

## What the worker builds
A **stand-alone prototype** on its own branch `worker/main`, in a new folder `prototype/replication/`.
It doesn't touch agent-room's existing source (`src/`, tests, READMEs) and the running room
doesn't load it.

1. **Two temporary "nodes"** on one machine (temporary folders, removed at the end). Each one has a
   discussion folder and its own **separate Git storage**, kept apart from the project's own Git
   repository.
2. **Round commits:** a script makes a few fake rounds on node 1 (edit a note, add a drawing,
   delete a file, append to a transcript), one commit per round. There are no model calls.
3. **Transfer over HTTP:** node 1 sends to node 2 through a minimal local HTTP endpoint (Node's
   built-in `http`): first a **full** bundle, then **incremental** bundles based on the
   last commit node 2 has acknowledged.
4. **Receiving safely:** node 2 saves the bundle to a temporary place first. Then it checks it
   (prerequisites, allowed files only: no symlinks, submodules, absolute paths or `..`), imports
   it under a separate "received" ref, writes a complete **read-only snapshot folder**, and only
   then switches its "current received" pointer to it. Finally it acknowledges the exact commit.
5. **Failure cases**, each shown by a test or a scripted run:
   - an interrupted transfer;
   - a corrupted bundle;
   - a duplicate send;
   - a missing base (the receiver lacks the base commit, so it falls back to a full transfer);
   - a rewritten history, which is refused;
   - a restart in the middle of receiving.
   In every case, the previous snapshot stays readable.

**Limits:** no new npm dependency. Git runs with argument arrays, never through a shell, and
never runs hooks or filters from received data. No changes to the room, its ports, its UI or
its sessions. No LAN, no pairing, no `--node`/`--peer` (that's stage B proper).

## Evidence required for inspection (Codex review, 2026-11-07)
- Identify the tested worker commit, Node/Git versions and exact rerun command. Keep the
  fixtures and executable checks in the prototype so another person can reproduce the result.
- Use fixed test room/discussion/node identities and a minimal round metadata schema; validate
  these before publication. Reject a bundle for the wrong identity or invalid schema. This is
  validation of the prototype protocol, not production pairing.
- Compare every published snapshot's file paths and bytes with the offered commit, including
  transcript append, drawing addition and deletion. Check that an earlier selected snapshot
  remains unchanged after a later publication.
- Exercise a lost acknowledgement followed by a retry. It must acknowledge the same published
  commit without creating another round or damaging the snapshot.
- For restart checks, identify the interruption points: after import, during materialization,
  and after publication but before acknowledgement. On restart, the published pointer must
  resolve to a complete old or new snapshot, never a partial directory. Interrupted staging
  data must not become visible. Report any untested interruption point explicitly.
- Report rejected-input checks for symlinks, submodules, unsafe paths and wrong identity/schema.
  Log expected and actual outcomes, rather than just printing “passed”.
- Explain which production concerns remain deferred, including pairing, scheduling, bounded
  retry policy and LAN behaviour. B0 does not establish production readiness.

## What the worker reports
A report at `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/stage-b0-report.md`,
written for the User, in plain language:
- **Does it work?** Each step and failure case: passed or failed, with the real output.
- **Measurements:** the size of the first full transfer and of a typical incremental one, the
  transfer time (on the Mac; charon is unmeasured), and the number of lines of prototype code.
- **The Git commands used**, listed once.
- **A recommendation** for the file boundary in stage B: a new `src/replicate.mjs`, or inside
  existing files, with reasons. **This stays a recommendation: the User decides (Q1).**
- **What wasn't checked** (for example: the Pi, a real LAN, real rounds).
- How to run the prototype again with a single command.

`npm test` must still pass in the worktree, with the real output included.

## How the User inspects it afterwards
1. Read `stage-b0-report.md`: the four questions above, each answered.
2. Run the prototype with the single command from the report and compare the output.
3. Look at the code size and the recommended file boundary, then decide Q1's second half.
4. Decide whether the prototype is merged, kept on the branch only, or discarded. **Nothing is
   merged automatically.**
5. Only then authorize stage B proper, with a separate instruction.

## Instruction for the Worker (draft, not sent)
> Build stage B0, the replication prototype, as specified in
> `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/stage-b0-prototype.md`.
> It relies on `implementation-plan.md` (section "Replication protocol and prototype") and
> `rollout.md` in the same folder, which are approved. Only this task is authorized: don't
> change agent-room's existing source files, and don't start stage B. First check these
> documents against the current source and list any contradictions before writing code. Write
> your report in `stage-b0-report.md` in that folder.
