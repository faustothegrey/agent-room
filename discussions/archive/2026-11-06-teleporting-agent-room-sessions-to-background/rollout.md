# Rollout: from implementation to the first real Mac + charon test

Status: **approved by the User on 2026-11-07** (written by Claude, reviewed by Codex). It puts
in order what the User, Codex and Claude agreed. What gets built is specified in
[proposal.md](proposal.md), [ui-design.md](ui-design.md) and
[implementation-plan.md](implementation-plan.md); this document only covers *when* and *how*
it gets deployed and tested. `charon` is the Raspberry Pi's host name.

## 1. Before handing over to the worker
- [x] The User approved the four documents on 2026-11-07.
- [ ] The User's instruction to the worker gives: the paths of the three documents plus this
      one, the statement that they are approved, and **exactly one authorized stage** (below).
      The worker doesn't see this conversation.
- [ ] The worker's first task: check the documents against the current source and list any
      contradictions before writing code.

## 2. Stages (one authorization each)

| Stage | Built | Done when |
|---|---|---|
| **0. New discussion button** | The button and the way back to earlier discussions ([ui-design.md](ui-design.md), section I). It's local only and independent of distribution. | `npm test` green; checked in the browser. |
| **A. Worker isolation** | The worker gets its own worktree and branch; it's disabled without git. | `npm test` green; tests for clean and dirty roots, restart, no automatic merge or deletion. |
| **A2. Server version in the header, and removal of the dropped switch** (decided by the User, 2026-11-07: before B, as one task) | **1. Version:** the header shows the commit the server started from and its start time, e.g. "4cb41bd · started 12:28", plus a `+` if the checkout had uncommitted changes. After a Reload it adds "· reloaded 12:41 (commit, `+`)". Commit and dirty status are captured at startup and at each Reload, never read live. The hover shows the full date, the checkout path, and a note that these are checkout snapshots: after a Reload the process may run a mix of startup and reloaded files. **2. Removal:** remove `/code worker|room`, its Worker-tab button, its way-back command, and their help, README text and the tests specific to them. Keep worker isolation (its own worktree and branch, `npm test` run there) and its tests, and the ordinary Restart tests. Restart always restarts the room from its own folder (`ctx.restartFrom` then no longer needed). | `npm test` green; in the browser: the version is shown after a Restart and after a Reload, and the switch is gone. |
| **B0. Replication prototype** (instruction sent by the User, 2026-11-07; built and reported by the worker) | A stand-alone Git bundle prototype on `worker/main`, in `prototype/replication/`, with no change to the room's source: [stage-b0-prototype.md](stage-b0-prototype.md). | Report `stage-b0-report.md` gives results, sizes, time, code size and a file-boundary recommendation; `npm test` green; the User decides the file boundary (Q1). |
| **B. Slice 1** (prerequisites: see "Before B" below; spec: [stage-b-spec.md](stage-b-spec.md); instruction sent by the User, 2026-11-07; **accepted by the User, 2026-11-07**, after the panels A–C follow-up; committed on `worker/main` as `3810bd7` (checked by Codex); `main` merged into `worker/main` as `36c195b` without conflicts, plain `npm test` 102/102; **merged into `main` by the User (fast-forward), plain `npm test` 102/102**, 2026-11-07) | LAN binding, `--node`/`--peer`, pairing, round commits, sending to peers, **View**. | `npm test` green; a **two-root local demonstration** (two servers, two temporary roots on one machine); code size measured and reviewed. |
| **C. Slice 2** | **Continue here** (three cases), interrupted-round saving, **Accept this line as reconciled**, **Fork from here**. | `npm test` green; the two-root demonstration covers all three cases. |

**Still to specify before the later stages (raised by the worker, 2026-11-07):**
- *Before A:* where the worktree lives, how the branch is named, and what "base" means when the
  room has uncommitted edits.
- *Stage A, try live before merging (approved by the User, 2026-11-07):* the worker proposed
  `/Users/fausto/Software/agent-room.worker/` on branch `worker/main`. First test that
  `node <worktree>/src/cli.mjs --cwd <room root> --dev` runs the worker's code on the real room.
  Then add a switch in the Worker tab, for agent-room development only:
  - **Run this room on the worker's version** / **Back to the room's version**. The header shows
    the actual code path and branch, without assuming `main`.
  - Switching waits until both the discussion and the worker are idle, and says the agents
    restart with fresh sessions.
  - The way back is a documented terminal command that restarts the stable version, shown next to
    the switch and in the README. There's no automatic recovery.
  - Dependencies: a separate `npm ci` in the worktree (no symlink), run again when
    `package.json` or the lockfile changes. If installing fails, nothing switches.
  - Before each instruction, fast-forward `worker/main` only if the worktree and index are clean
    and its branch is an ancestor of the room's HEAD. Otherwise leave it and explain why. Never
    reset, merge or rebase.
  - The preview window on another port is deferred.
- *Stage A decisions (the User, 2026-11-07, after review):* **track `package-lock.json`**, so
  the worktree can run `npm ci`. **Worker notes are transient:** they don't belong in the
  project's committed code, and they go once the build is complete.
- *Stage A finish (approved by the User, 2026-11-07):* see `drawings/worker-simple.svg`.
  Scratch notes go in a gitignored `.worker-notes/` in the worker's worktree, one subfolder per
  task. They are never committed (the worker is told so too) and are deleted by the worker
  after the User says "stage accepted"; its code and branch stay. There's no Worker notes view
  and no automatic cleanup. The existing stage plans stay here as history. `package-lock.json`
  is tracked. Fix the task-context race first.
- *Simplified workflow (the User, 2026-11-07, after stage A was built; replaces the live switch
  above):* the worker works in its own worktree and branch and runs `npm test` there. Its work
  is **reviewed but not run live**. The User merges it into the main checkout and tests it in
  the normal room. Restart always restarts the normal room's version. The "Run this room on the
  worker's version / Back" switch (`/code worker|room`) and its way-back command are dropped.
  "Implemented on the worker branch" stays distinct from "merged and tested in the room"
  (Codex). **Unresolved detail:** how `worker/main` is brought up to date before a new task.
  Removing the switch from the code is not yet authorized.
- *Stage A accepted by the User, 2026-11-07.*
- *Reported 2026-11-07:* Restart doesn't work, and the UI looks unchanged since before stage A.
  Checked by Codex (shell): the room on port 5566 is PID 1120. It runs this checkout's
  `src/cli.mjs` from this checkout and started at 12:10:09, after stage A's commit (12:08:36),
  without `--no-screen`. The Dock log has no restart outcome. Read by Claude: the stage A switch
  only appears once the worker's worktree exists (`src/ui.mjs:798`), and the worktree isn't
  created until the worker's first instruction (`src/ui.mjs:690`); it doesn't exist yet. That
  may explain the unchanged UI (untested). **The cause of the Restart failure is unknown.**
- *Update, 2026-11-07 (12:28 session):* Restart **worked**. The User saw the discussion panel
  clear; Codex checked that port 5566 passed from PID 1120 to PID 4596 (started 12:28:28, from
  this checkout, at stage A's commit `4cb41bd`). The unchanged UI is probably the missing
  worktree explained above (untested). The process showed no version, hence stage A2.
- *Before B: prerequisites (the User, 2026-11-07: stage B isn't authorized until each is
  resolved by the User; to be thought about later):*
  1. **New replication module?** Replication very likely needs one, which is the User's call
     under CLAUDE.md. The plan's git-bundle and storage prototype comes before any final design.
  2. **Taken port in peer mode:** stop with a clear error instead of silently moving to another
     port (`src/ui.mjs:909–921` since A2; the worker corrected the old `697–701`)? This changes
     existing behaviour.
  3. **Updating `worker/main`:** how it is brought up to date before each new task.

  *Decided by the User, 2026-11-07 (explained in [before-b-questions.md](before-b-questions.md)):*
  **1** accepted: prototype first, file boundary judged from the actual code. **2** accepted: in
  peer mode, an occupied port stops the room with a clear error. **3** still open.
  *After B0 (the User, 2026-11-07, taking the agents' joint advice):* the new `src/replicate.mjs`
  is allowed. B0 is committed on `worker/main`, not merged as is. Stage B ports it into
  `src/replicate.mjs` plus tests with equivalent coverage, and removes `prototype/`. Stage B
  still needs its own instruction. **B0 accepted by the User, 2026-11-07.** The User said the
  instruction to commit the prototype had been sent. The worker's reply to the later cleanup
  instruction, however, says `prototype/replication/` is **still uncommitted** on `worker/main`
  (and B0 had no `.worker-notes/` folder, so nothing to clean up). The User then clarified that
  the commit instruction had **not** been sent after all. It was then sent: the worker committed
  the prototype on `worker/main` as `5153ce1` (four files only, on top of `44bf6b1`), and
  `HEAD:prototype/replication` matches the tested tree `5c21a520…`. Not merged.
- *Authorized by the User (2026-11-07), a separate task after A2:* **summaries restate worker
  instructions.** In `SUMMARY_FORMAT` (`src/room.mjs:11–15`), add an optional last section,
  **Instructions for the Worker**: it quotes the latest version of each instruction for the
  worker proposed in the discussion, word for word, labelled "sending unconfirmed". Later
  summaries repeat it until the User says it was sent, replaced or withdrawn. It doesn't count
  toward the 8-point limit, and it's left out when there is none. Add one line to the handoff
  convention in `README-for-brainstorming-agents.md`: a handoff carries any unconfirmed worker
  instruction. Done when `npm test` is green and a summary in the room shows the section.
  Instruction for the worker: *"Build the 'summaries restate worker instructions' task as
  specified in `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/rollout.md`
  (section 2). Only this task is authorized."*
- *Authorized by the User (2026-11-07):* **remove the dropped switch.** Merged into stage A2
  (table above) by the User's decision the same day.
- *Stage A2 and the summaries task accepted by the User, 2026-11-07,* after checking in the
  browser: the version shown after Restart and after Reload ("· reloaded …"), the UI changes,
  and the **Instructions for the Worker** section in a real summary. The User confirmed that
  both the summaries-task instruction and the scratch-notes cleanup ("Stage A2 and the summaries
  task are accepted. Delete their .worker-notes/ folders.") were sent to the worker.

- *Decided by the User, 2026-11-07: how agents present what the User must do.* Every summary and
  reply that asks something of the User ends with **Next step**: exactly one action, labelled
  **Answer**, **Send to the Worker** (the instruction quoted in full; the User asked for this
  wording instead of "Send") or **Do**. Further actions go under
  **Later**, one short line each with what they wait for. Unsent worker instructions are kept
  word for word in [pending-instructions.md](pending-instructions.md) and named under Later.
  Making this the permanent summary template is the pending "summary-template" task.
- *Stated by the User, 2026-11-07:* the uncommitted worker-switching changes in the main checkout
  (`README.md`, `src/docs.mjs`, `src/ui.mjs`, `test/ui.test.mjs`) were authorized by the User and
  made by another worker, to unblock the workflow. They are committed separately before stage B
  is merged.

The worker reports its real `npm test` output and lists what it did *not* check (Pi, LAN,
browser look). The User reviews each stage before authorizing the next.

## 3. Deploying a stage to charon (after B, and again after C)
1. On the Mac: `git status` first, because other sessions also commit in this checkout. Commit,
   then push to origin. This deploys **agent-room's code only**; discussion histories travel
   through agent-room's own replication, not through origin.
2. On charon (first time only): Node, git, `claude` and `codex` installed and **signed in**; a
   checkout of the room's project (for agent-room itself: this repository).
3. On charon: inspect local changes before `git pull`; do not overwrite them. Install the
   revision's dependencies (`npm ci` when a lockfile is present), then start the room, for example
   `npm start -- --node charon --peer Mac=http://<mac-ip>:5566`, inside tmux so it survives
   logout.
4. On the Mac: restart with `--node Mac --peer charon=http://<charon-ip>:5566` (saved in the
   Dock launcher).
5. Pair the rooms once (**Pair with …** in the Peers section), and confirm both folders are
   the same project.
6. If charon can't reach the Mac, check the **macOS firewall** first: listening on `0.0.0.0`
   may make macOS block or ask about incoming connections to `node`.

## 4. Tests on the real nodes
**After stage B (replication):**
- [ ] A Mac round appears on charon (Discussions pane: "Mac · round N · received …"), and
      **View** shows it read-only.
- [ ] A deleted drawing disappears on charon too.
- [ ] Stopping charon, running a Mac round, and restarting charon: the round arrives later,
      and the Mac never waited.

**After stage C (the real workflow):**
- [ ] Mac round → received on charon → **View** → **Continue here** on charon → close the
      laptop → one unattended round on charon → reopen the Mac → charon's round received → **Continue
      here** on the Mac (fast-forward).
- [ ] Using **disposable discussions** only: both nodes add rounds → "Reconciliation required"
      → **Accept this line as reconciled**; and **Fork from here**.

**Measure during the first charon round:** the lowest *available* memory (`free -h` or
`vmstat 5`), swap use, whether either CLI exits or stops responding, the transfer size and
time, and the token use reported for the fresh sessions. Record anything not measured as
"unmeasured".

## 5. If something goes wrong
- A failed transfer must leave the previous received state readable; no work is deleted.
- Before rollback, stop both servers and preserve discussion files, separate discussion Git
  storage, and unfinished worker worktrees. Check source status; do not force checkout or reset.
  Use the previous application revision in a clean checkout where necessary and install its
  matching dependencies. Start without `--peer` only after checking the old version understands
  the saved files. No backward-compatible storage format has been tested: if incompatible,
  keep the preserved copy read-only rather than asking the old version to modify it.
- Report problems in this discussion, marking each result as tested, measured or assumed.
