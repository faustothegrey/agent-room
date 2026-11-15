# Stage A plan: worker isolation (worker's implementation notes, for review)

Status: **draft for the User's review, 2026-11-07**, updated the same day with the discussion
group's feedback (fast-forward, live switch, dependencies). No code yet. Spec: [proposal.md](proposal.md)
"The local worker", [implementation-plan.md](implementation-plan.md) "Prerequisite: isolated local
worker", [ui-design.md](ui-design.md) section H, [rollout.md](rollout.md) stage A.

## Decided by the User (2026-11-07)
1. **Workflow:** the worker works on its own branch; the User reviews and merges it into the room,
   then presses Reload. Nothing merges automatically.
2. **Notes:** the worker's notes and plans stay in the **room's** discussion folder (as now), the
   one exception to "the worker works only in its worktree". They are visible in the Discussions
   pane and will be replicated with the discussion later.
3. **Place and name:** a sibling folder `<repo>.worker/` (for agent-room:
   `/Users/fausto/Software/agent-room.worker/`), on the branch `worker/main`.

## What changes
- **The worker's working directory** becomes the worktree instead of the room's root. If the room
  is a subfolder of its repository, the same subfolder inside the worktree.
- **Created lazily**, at the first worker instruction, so opening a room still writes nothing:
  - `worker/main` doesn't exist: `git worktree add -b worker/main <path> HEAD`, recording that
    HEAD as the base.
  - the branch exists but has no worktree: `git worktree add <path> worker/main` (reattach).
  - the worktree already exists on `worker/main`: reuse it (after Restart or Reload; nothing is
    stored by agent-room, it's read back from `git worktree list --porcelain`).
  - `<path>` exists but isn't that worktree: **refuse**, touching nothing, with an explanation in
    the Worker tab.
- **Never** run in the room: no checkout, reset, stash, commit, merge or index change. Git runs
  with argument arrays (`execFile`), no shell. **Nothing is ever deleted** (worktree or branch).
- **Worker disabled** when the root isn't in a Git repository, or the repository has no commit
  yet: the Worker tab's input is disabled with "Worker requires a source Git repository for its
  isolated worktree." Discussions work as before.
- **The worker's brief** (with its first instruction, and again whenever it changes) says: its
  working directory is the worktree on `worker/main`; the room's root is the User's and is not to
  be edited; notes go in the room's discussion folder; commit on `worker/main` only when asked.
  `README-for-worker-agents.md` is updated to match.

## What the Worker tab shows (ui-design.md section H)
A line above the log: `Worktree ../agent-room.worker · branch worker/main · based on 2ca9506`,
plus when true:
- "The room has uncommitted changes: the worker doesn't see them."
- "worker/main has N commits not in the room: review and merge them when ready."
- Before the first instruction: "The worker's worktree will be created at … from 2ca9506."

## Keeping the worker up to date (agreed by the User and the discussion group, 2026-11-07)
Before each instruction, **only** if the worktree is clean and `worker/main` is strictly behind
the room's HEAD (an ancestor of it), fast-forward the worktree to it (`git merge --ff-only`, in the
worktree only). Otherwise leave it untouched and say why in the Worker tab (dirty, has unmerged
commits, or diverged). Never reset, merge or rebase.

## Trying the worker's version live (agreed by the User and the discussion group, 2026-11-07)
Problem: under isolation the running room never sees the worker's edits until they're merged, and
the User wants to keep trying changes live before merging.

**Checked by the worker, 2026-11-07** (a temporary copy of HEAD in `/tmp`, `npm ci`, a scratch
room on port 5578; the repository wasn't touched): `node <copy>/src/cli.mjs --cwd <room> --dev`
served the scratch room; saving a file in the copy's `src/` reloaded it ("Reloaded the code…");
`/restart` started the new process from the copy's `cli.mjs` again, with `--dev` kept. Not checked:
a real Git worktree, the real room, and model turns on that code.

- **For agent-room development only:** when the room's own code is the project in the worktree. A
  switch in the Worker tab, **Run this room on the worker's version**, restarts the room from the
  worktree's `cli.mjs` with the same room, port and flags.
- **Before switching:** wait until both the discussion and the worker are idle. Say that the
  agents restart with fresh sessions from the handoff (the chat clears; the transcript is kept).
- **Dependencies:** `npm ci` in the worktree (no symlinked `node_modules`), rerun when
  `package.json` or the lockfile changed since the last install. If it fails, nothing switches and
  the error is shown.
- **The header** shows the actual code path and branch it runs from (read from Git at start-up,
  never assumed to be `main`).
- **The way back** is a documented terminal command that starts the stable version again, shown
  next to the switch and in the README, for example
  `cd /Users/fausto/Software/agent-room && npm start -- --port 5566` after stopping the room. When the
  worker's version works, the switch offers **Back to the room's version** too (a Restart from the
  room's `cli.mjs`). No automatic recovery (proposed by Claude, withdrawn).

## Not in stage A
No merge button, no per-task branches, no worktree for discussion agents, no replication, no
preview window on another port (deferred). Re-open, New discussion, ports, and the discussion
agents' working directory are unchanged.

## Code and tests
- In `src/ui.mjs` (no new module): about 60–90 lines for the Git helpers, worktree setup and the
  tab's line, plus roughly 40–60 for the switch (`npm ci`, Restart from another `cli.mjs`); `src/docs.mjs` for the tab line and the disabled state; the worker rulebook; README
  ("Worker" and "Access and limits": a worktree isolates working copies, not permissions).
- Tests on temporary Git repositories with a fake worker (no model calls): non-Git root and
  empty repository disabled; clean root creates worktree and branch at HEAD; dirty root left
  byte-for-byte unchanged (files, index, branch) and the tab says so; restart reuses the worktree;
  existing branch reattached; a foreign folder at the path refused; worker turns run with the
  worktree as `cwd`; fast-forward only when clean and behind; nothing deleted. The switch: refused
  while busy; `npm ci` failure switches nothing; Restart arguments point at the chosen `cli.mjs`;
  the header's code path and branch.
- Not checkable by tests: real CLIs inside the worktree, a real switch on the live room, and the
  look of the tab line and header in Chrome.

## Note for this repository
Once stage A is live, this worker (me) edits `/Users/fausto/Software/agent-room.worker/`, not the
room you're running. Changes reach the room when you merge `worker/main`, or earlier, to try
them, through **Run this room on the worker's version**.

## Implementation notes (worker, 2026-11-07, not committed)
- Built as planned in `src/ui.mjs` ("The worker's worktree" section), `src/docs.mjs` (header
  `code:` line, Worker tab line, switch, way-back command, disabled input), `src/agents.mjs` (a
  working directory read at each turn), both READMEs, and tests (94 pass).
- ~~Deviation: `package-lock.json` is gitignored~~ — **wrong, corrected 2026-11-07:** it has been
  tracked since `ff56d21`; the worker misread an `ls` line as a `.gitignore` entry. The switch
  now always uses `npm ci` (rerun when `package.json` or `package-lock.json` changed).
- `src/ui.mjs` grew by about 190 lines, more than the 100–150 estimated.
- Re-open now also re-sends the worktree brief (its reset gives the worker a fresh session).
- Checked end to end on a throwaway clone with its own worktree (no model calls): switch, `npm
  install`, Restart from the worktree, header, dev reload of a worktree edit, way back, disabled
  state without Git. Not checked: a real worker turn in a worktree, the real repository.

## Stage A finish (worker, 2026-11-07)
- **Task-context race fixed:** `runWork` reads the task's discussion and transcript once, before
  its first `await`, and uses them for the briefing, the transcript and the `/move` lock. A New
  discussion during worktree preparation used to brief the worker about no discussion while the
  lock and transcript still pointed at the old one. Regression test fails without the fix.
- **Scratch notes:** `.worker-notes/<task>/` in the worktree; in `.gitignore`, and added once to
  the repository's local `info/exclude` so it is ignored in any project. The briefing and the
  worker rulebook say: never commit them, delete them only when the User says "stage accepted".
- `npm ci` only, as decided. 96 tests pass.
