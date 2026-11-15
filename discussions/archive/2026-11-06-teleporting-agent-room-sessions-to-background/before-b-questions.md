# The three questions before stage B, explained (Claude, 2026-11-07)

Status: explanation only. Nothing here is decided. Code references were read on 2026-11-07, not tested.

## 1. May replication use a new module?

**What stage B must do:** copy each discussion's rounds (messages, notes, drawings) from the Mac
to charon and back. The plan does this with Git: each discussion's history is packed into a
"bundle" file, sent over the existing HTTP connection between the two rooms, checked, and
unpacked on the other side (`implementation-plan.md`, around line 134).

**Why it's a question:** `CLAUDE.md` says to ask the owner before adding a module. That code
(packing, sending, checking, refusing bad files, keeping both versions when they diverge) is
several hundred lines (assumed, unmeasured). Putting it inside the existing files would make them
much harder to read.

**The choices and what they mean in practice:**
- **Yes, a new file (e.g. `src/replicate.mjs`):** replication is readable on its own and easy
  to remove. The project grows by one file.
- **No, fit it into existing files:** no new file, but `ui.mjs` and `docs.mjs` grow and mix two
  jobs.
- **Either way**, the plan first builds a small **prototype** to check that Git bundles work for
  this, before writing the final design. You could approve only the prototype for now.

## 2. When the port is taken, stop with an error or move to another port?

**What happens today** (`src/ui.mjs:915–921`): if port 5566 is busy, the room says "Port 5566 is
in use; using a free port instead" and starts on a random port.

**Why it matters for B:** charon is told to reach the Mac at `http://<mac-ip>:5566`. If the Mac's
room silently moved to, say, port 61234, charon would keep knocking on 5566. Nothing would
arrive, and nothing would say why.

```
  today:      charon ──► Mac:5566 (old process, or nobody)    room actually on :61234  ✗ silent
  proposed:   Mac room refuses to start: "Port 5566 is in use by another process"  ✓ visible
```

**The choices:**
- **Stop with a clear error, only when `--peer` is used:** peers can always find the room. You'd
  have to close the other process yourself. Without `--peer` nothing changes.
- **Keep moving:** nothing changes, but replication can fail without a visible reason.

This changes existing behaviour, which is why it needs your decision.

## 3. How does the worker's branch catch up before each new task?

**The setup:** the worker works on its own branch `worker/main`, in its own folder. You merge its
work into `main`. Meanwhile `main` also gets other commits (yours, other sessions'). Before the
next task, the worker should start from the latest `main`.

**What the code already does** (`catchUp`, `src/ui.mjs:762–766`): before each instruction it
moves `worker/main` forward to `main`, **only if** the worker has no commits of its own that are
missing from `main`, and no unsaved changes. Otherwise it leaves everything as it is. It never
resets, merges or deletes.

```
  Case A: you merged the worker's branch normally
     main:        ──●──●──W──●──●        (W = worker's commits, now in main)
     worker/main: ──●──●──W               → catches up automatically ✓

  Case B: you squashed or copied its work instead (new commits, different IDs)
     main:        ──●──●──W'──●
     worker/main: ──●──●──W               → W counts as "not in main": stuck ✗

  Case C: the worker left unsaved changes in its folder → stuck ✗
```

**The open question:** what should happen in Cases B and C?
- **Report and wait (as today):** the worker starts from an old version. Someone has to notice
  the report and fix it by hand.
- **Always merge normally:** you keep merging with a merge commit or fast-forward, so Case B
  never happens. Nothing new to build, but you have to keep to the habit.
- **Ask you before resetting:** when the worker's leftover commits are already in `main` in
  another form, the room offers "Reset the worker's branch to main?" and acts only if you
  confirm. Small new code, and a reset after confirmation.

None of these is chosen yet.

## Decided by the User (2026-11-07)
- **Q1:** the proposal is accepted. The Git bundle prototype comes first, and the file boundary
  is judged from the actual code.
- **Q2:** the proposal is accepted. In peer mode, an occupied port stops the room with a clear
  error. Without `--peer`, nothing changes.
- **Q1, second half (the User, 2026-11-07, taking the agents' joint advice after B0):** a new
  `src/replicate.mjs` is allowed. The B0 prototype is committed on `worker/main` but isn't
  merged as is. Stage B turns it into `src/replicate.mjs` plus normal tests with equivalent
  coverage (not necessarily the same 85 checks), and removes `prototype/` in the same work.
- **Q3:** still open. The User said they bring the worker's work into `main` with a
  standard merge, unless there's a reason to do otherwise. In that case the existing cautious
  rule updates the branch on its own. Awaiting the User's confirmation that this closes Q3.

## Proposed by the agents
- **Q1 (Codex, Claude agrees):** approve the prototype first; judge the file boundary from the
  actual code. "Module" here means a separate source file, not a dependency or a service.
- **Q2 (Codex, Claude agrees):** in peer mode, stop with a clear error. Another process might
  even answer on the expected port.
- **Q3 (Codex):** keep updates conservative: advance when safe, otherwise explain what blocked
  it and leave the work intact; no automatic resets. **Claude agrees on the default**, but notes
  that if the User usually squashes or copies the worker's work, it will block before every task.
  Question for the User: how has the worker's work been brought into `main` so far?
