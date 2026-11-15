# The intermittent failure of "stopping a room kills provider child commands …" (worker, 2026-11-12)

The test is `test/rooms.test.mjs`, around line 403. It failed once in a full `npm test` run with
`AssertionError [ERR_ASSERTION]: Missing expected exception.` (214 ms), and passed alone six times.
This was an investigation only: no code or test changed. My scratch scripts are in my worktree's
`.worker-notes/child-test/`.

## Conclusion

**The cause is in the test, not in agent-room.** The test can read the child's process-ID file
when it exists but is still empty.

- `Number('')` is 0.
- `process.kill(0, 0)` signals the test's own process group, so it never throws.
- `assert.throws` then fails with exactly the message seen.

A child outliving its room, even for a moment, is not what happened here. agent-room's
`stopPrograms` doesn't declare a group gone while any member of it still exists, not even a zombie
(a process that has exited but not yet been reaped).

## The test, in short

1. A provider is started with `run` (its own process group).
2. The provider spawns a child and writes the child's PID with
   `require('node:fs').writeFileSync(pidFile, String(child.pid))`.
3. The test polls `existsSync(pidFile)` every 20 ms, then reads it once:
   `const child = Number(readFileSync(pidFile, 'utf8'))`.
4. `stopRoom(ctx)`, then `assert.throws(() => process.kill(child, 0))`.

It does all this twice: with the provider still running, and with the provider already exited.

## Evidence

### 1. The file can exist while still empty

`writeFileSync` creates the file first and writes into it afterwards. Between the two, another
process sees an empty file.

`emptyfile.mjs`: a node process writes its PID as the test's provider does, while the parent waits
for the file and reads it:

| Polling | Load | Trials | Empty reads |
|---|---|---|---|
| tight loop | none | 300 | 40 |
| tight loop | 16 busy-loops on 8 cores | 300 | 60 |
| every 20 ms, as the test does | none | 300 | **0** |
| every 20 ms, as the test does | 16 busy-loops on 8 cores | 600 | **6** |

Real output of the two 20 ms runs:

```
test: 300 trials, 0 read an empty file (Number('') = 0), 300 read the PID
--- under load (16 busy-loops)
test: 600 trials, 6 read an empty file (Number('') = 0), 594 read the PID
```

So at the test's own polling rate, an empty read happens only when the machine is loaded, about 1%
of reads here. The test reads twice per run. A full `npm test` runs its test files in parallel
processes, so the machine is loaded then. Alone, it isn't. That fits "failed once in a full run,
passed alone six times".

### 2. An empty read produces exactly the failure seen

```
$ node -e "… const child = Number(''); assert.throws(() => process.kill(child, 0)) …"
AssertionError [ERR_ASSERTION]: Missing expected exception.
process.kill(0, 0): no exception (it signals our own process group)
```

### 3. A child doesn't outlive its room, even for a moment

- **`stopPrograms` waits for the whole group.** It sends SIGTERM to each program's process group,
  then waits until `groupAlive()` (`kill(-group, 0)`) stops succeeding. After 5 s it sends SIGKILL
  and waits 1 s more, then reports any survivors. The failing test took 214 ms in all, so neither
  limit was reached: `stopPrograms` really did see the group gone.
- **A zombie still counts.** I made a group holding only a zombie: its leader had exited but
  wasn't reaped (`zombie.py`). The real output:

  ```
  ps stat: Z
  kill(pid, 0): ok
  kill(-group, 0): EPERM
  after reaping: kill(pid, 0): ESRCH  kill(-group, 0): ESRCH
  ```

  On macOS, a group whose only member is a zombie answers `EPERM`, not `ESRCH`. `groupAlive` counts
  anything except `ESRCH` as alive, so `stopPrograms` keeps waiting until the zombie is reaped. When
  the group is gone, the child's PID is gone too. So the window "group gone, child PID still
  present" doesn't arise for a child in the group.
- **The test's own steps, instrumented** (`probe.mjs`: the same steps, recording what the PID file
  held and the child's `ps` state after `stopRoom`):
  - 80 of 80 passed without load;
  - 120 of 120 passed under 16 busy-loops;
  - the child was gone every time.
- **One real limit, not this test's case.** A process that leaves its group (`setsid`, or a detached
  daemon a provider's tool starts) is not stopped by `stopPrograms`, by design: the group is the
  unit. The test's child stays in the group.
- **PID reuse** within those few milliseconds is not plausible as the cause.

### 4. Reproducing the failure itself: not achieved

I ran the unchanged test 60 times on its own, under 16 busy-loops: 60 passed, 0 failed. With about 1%
of reads empty and the file usually already written by the time the 20 ms poll lands, the failure is
rare. I reproduced its mechanism (sections 1 and 2), not the failure in the real test.

## Proposed fix: a change to the test (needs your approval)

agent-room's code needs no change. In the test, read the PID only once the file holds one, and fail
loudly on a bad read, so the check can no longer pass or fail by accident:

```js
let child = 0;
for (let i = 0; i < 100 && !(child > 0); i++) {
  await new Promise((r) => setTimeout(r, 20));
  child = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
}
assert.ok(child > 0, `the child's PID was never written (read ${child})`);
```

An alternative is to have the provider write the file in one step (a temporary file, then
`renameSync` to `pidFile`), so the file never exists empty. That changes the fixture script inside
the test; the version above changes only the test's reading. I'd add `assert.ok(child > 0)` either
way. Without it, `process.kill(0, 0)` can't tell "the room left the child alive" from "the test
read nothing".

Other tests use the same pattern of waiting for a PID file. `test/rooms.test.mjs` around lines 157
and 416 each wait for `existsSync` before reading it. I haven't checked whether their reads have the
same weakness; worth a look if you approve the change.

## Where this ran

- **Worktree:** `/Users/fausto/Software/agent-room.workers/2026-11-09-running-multiple-concurrent-discussions`.
- **Branch:** `worker/2026-11-09-running-multiple-concurrent-discussions`.
- This is the discussion's own lane from slice 1a, created from main at `ef16b12` ("README: explain
  sessions"), which includes `bf64c4e` and `bc43f52`.
- It had no `node_modules`, so I ran `npm ci` first: 5 packages, 0.8 s. The plan foresaw this.
- I left `/Users/fausto/Software/agent-room.worker` alone.
