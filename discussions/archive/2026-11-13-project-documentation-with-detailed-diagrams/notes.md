# Project documentation with detailed diagrams

## Decided (by the User)
- Documentation of the main branch lives in one place, `docs/` on main. Discussion agents may
  change, delete and add documentation there, commit and push included. (User, 2026-11-13)
- Produce accurate documentation of agent-room: a high-level overview plus separate, more
  detailed diagrams. (User, 2026-11-13)

## Starting point (tested: read on 2026-11-13)
Existing docs: `README.md` (usage), `docs/architecture.md` (design) and three SVGs in
`docs/diagrams/` (`c4-context`, `c4-containers`, `discussion-round-sequence`, dated 2026-11-11).

Drift already found against `src/`:
1. **Nine modules, not eight.** `src/notes.mjs` (Notes pane, stored under
   `~/.local/share/agent-room/notes/<hash>`, this computer only) is missing from the
   architecture table, the containers diagram and the README's "eight source modules".
2. **Third provider missing.** `agents.mjs` has `agy` (Antigravity) alongside `claude` and
   `codex` (`FACTORIES`, `createAgyAgent`); architecture.md and the diagrams show only two, and
   "How the room harness steers the CLIs" doesn't describe agy's flags or how it gets
   instructions (in the prompt, when changed).
3. **Claude discussion agents now get `Bash` too.** `docs/architecture.md` (line 132) and
   `c4-containers.svg` (line 76) state "No Bash for Claude discussion agents". In `src/agents.mjs`
   (lines 17, 23, 148–150) and `README.md` (line 681), `CLAUDE_TOOLS` and `CLAUDE_ALLOWED` include
   `Bash` for discussion agents and workers alike.
4. **Per-discussion worker worktrees and queues, not one shared worktree.** `docs/architecture.md`
   (lines 20, 139) and `c4-containers.svg` (line 91) only show `<repo>.worker/` (`worker/main`).
   `src/ui.mjs` and `README.md` (lines 217–250, 562–586) now give each discussion its own worktree
   `<repo>.workers/<folder-name>/` on branch `worker/<folder-name>`, its own worker session and
   queue (up to `PARALLEL_WORKERS = 2` tasks running concurrently in a folder), keeping
   `<repo>.worker/` (`worker/main`) for brainstorms, pre-title tasks and legacy commits.
5. **Local state additions.** `src/agents.mjs` writes `~/.local/state/agent-room/programs/<pid>.json`
   to track running CLI process groups and detect leftovers after a crash or Restart; this is
   missing from `docs/architecture.md` and `c4-containers.svg`.

## Diagrams in `docs/diagrams/`
- `docs/diagrams/agent-turn-providers.svg` (Agy, moved to `docs/diagrams/`): compares
  `createClaudeAgent`, `createCodexAgent` and `createAgyAgent` in `src/agents.mjs`, plus `run()`,
  `claudeTitle()` and `<pid>.json` tracking. Rendered and inspected.
- `docs/diagrams/summary-procedure.svg` (Claude, moved to `docs/diagrams/`): `summary()` in
  `src/room.mjs`: drafter rotation, agreement at n − 1 passes, the empty / failed / not agreed
  outcomes, the 3 × n turn limit, and what `ui.mjs` parses afterwards.
- `docs/diagrams/worker-and-auto-dev.svg` (Claude): one instruction through queue, lane worktree,
  worker turn, reply and the User's merge; auto dev's start checks, relay, decide() and every
  pause reason.
- `docs/diagrams/storage-map.svg` (Agy, moved to `docs/diagrams/`): maps all four storage zones
  (`<root>/`, worker Git worktrees and `<git-dir>/agent-room-task.json`, local machine state under
  `~/.config` and `~/.local`, and `<root>/.agent-room/` replication storage) and which module or
  agent reads/writes each path. Rendered and inspected.
- `docs/diagrams/discussion-lifecycle.svg` (Agy): covers unstarted contexts (`/new`), brainstorms
  (`/brainstorm`), open discussions and checkpoints, Resume with full checkpoint (`loadCheckpoint`,
  `reattachWorker`, `reportWork`), Start fresh (`/fresh` and the `handoff.md` convention), and
  moving discussions (`archive/`, `deferred/`, Defer guard, and `/rollback` → `/archive-rollback`).
  Rendered and inspected.
- `docs/diagrams/replication.svg` (Codex): capture, background transfer, validation, publication and
  acknowledgements in `src/replicate.mjs`.
- `docs/diagrams/discussion-round-sequence.svg` (Codex, updated): adds `PASS.` handling,
  addressed-agent selection, unknown-name rejection, worker-report routing and updated date.

## Proposed (Claude): diagram set
Overview level (fix in place): context, containers.
Detailed, one per drawing in `drawings/`:
1. Discussion round (exists; re-check).
2. Summary procedure: drafter rotation, agreement, failure paths.
3. Worker: instruction → queue → worktree → merge; auto dev outcome loop.
4. Agent turn: how `agents.mjs` builds one CLI call per provider (flags, session, instructions).
5. Storage map: every file/folder agent-room reads or writes, and who.
6. Discussion lifecycle: new / brainstorm / checkpoint / resume / start fresh / archive / defer.
7. Replication between servers (optional).

## Open questions for the User
- Which detailed diagrams matter most to you?

## Done
- Commit 803b0ec on main, pushed (Claude, 2026-11-13): `docs/architecture.md` corrected (five drift
  points, new sections: worker and auto dev, lifecycle and storage, replication), all nine diagrams
  in `docs/diagrams/` linked from it, README module count fixed. `npm test`: 215 passed, 0 failed.
