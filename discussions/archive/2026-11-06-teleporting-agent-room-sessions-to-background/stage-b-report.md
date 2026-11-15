# Stage B (replication, slice 1): worker's report

Status: **implemented and locally validated; awaiting User review** (worker, 2026-11-07).
**Follow-up test status:** plain `npm test` has one settings-dependent test failure, reproduced
against main's source with the same old test fixture. Main's current test has an uncommitted
explicit-worker fixture fix. See section 8 for the comparison; no existing test was changed here.

Section 0 was written by the interrupted worker before its code changes. Resumed from its
uncommitted work on `worker/main`, based on `5153ce1`; nothing committed or merged.

## 0. Documents checked against the current source (before writing code)

Read: `stage-b-spec.md`, `proposal.md` (slice 1), `ui-design.md` (A, B, C, F, G),
`implementation-plan.md` (slice 1 and the sections it relies on), `rollout.md` (stage B row),
`stage-b-inspection.md`, `drawings/stage-b.svg`, `stage-b0-report.md`. Source: `worker/main` at
`5153ce1` (B0 prototype on top of `44bf6b1` = the room's `main`).

Contradictions and gaps, each with what I'll do (none changes an approved decision; tell me if
one should):

1. **The worker *does* write into the discussion folder.** The plan says "the isolated local
   worker is not a writer of this directory and need not delay capture". But today the worker
   writes its plans and notes into the active discussion's folder (its rulebook says so), and
   its log entries are appended to the session transcript (`src/ui.mjs:837–838`). So a round
   capture can run while the worker is writing there. **What I'll do:** capture doesn't wait for
   the worker, as decided. Instead it checks each file's size and modification time before and
   after reading it, and retries (up to 3 times) when something changed. If it still changes, the
   round shows "Could not save round: …" and nothing is marked sent. This is the plan's "detect
   changed files during capture and retry or report failure". Worker entries stay in the readable
   Markdown transcript. They are **not** in the structured conversation, so they can never come
   back as instructions or a queue.
2. **Same-origin protection rejects direct-IP access.** `fromOwnPage` (`src/docs.mjs:847–852`)
   accepts only `Host: 127.0.0.1|localhost`. Opening `http://192.168.x.y:5566/__room` would show
   the page but refuse every message. **What I'll do:** also accept this machine's own IPv4
   addresses as Host, and still require Origin = `http://<Host>` and JSON. A DNS-rebinding page
   still arrives with a foreign Host name and is refused. The same Host check guards the new
   `/replica/*` peer endpoints.
3. **"npm start binds 0.0.0.0" vs. other launches.** The proposal names `npm start`. But the room
   has one listening call for every launch (`npm start`, `node src/cli.mjs`, the Dock app's
   `npm start -- --open`, and New room in folder). **What I'll do:** bind `0.0.0.0` for every launch,
   with no new flag. The banner keeps its `http://127.0.0.1:<port>/__room` line (the tests and
   the Dock app rely on it) and adds the LAN address.
4. **On macOS, a taken port isn't always detected (measured).** Node sets `SO_REUSEADDR`, so on
   this Mac a server on `0.0.0.0:P` binds successfully even while another process holds
   `127.0.0.1:P`, and the reverse also works. `127.0.0.1` then still reaches the *old* process.
   Without a check, a new room on 0.0.0.0 would "start" on 5566 while the browser and the Dock
   app keep talking to the old one. **What I'll do:** before listening, try to connect to
   `127.0.0.1:<port>`. If something answers, the port counts as taken: with `--peer`, stop with
   the clear error (Q2); without `--peer`, today's fallback to a free port.
5. **The plan's "fake CLI runners" can't drive the real CLI.** There's no fake provider option.
   **What I'll do:** the automated tests drive two in-process rooms with fake agents and a real
   HTTP server each. For the two-server demonstration I put a small fake `claude` script first in
   the `PATH` of the demo servers only. That needs no change to `src/` and costs no tokens.
6. **What is a "round" for numbering?** The design shows "round 14" and one commit per round. A
   manual `/summary` also changes the transcript but isn't a round. **What I'll do:** one commit at
   the end of each round (after its automatic summary), and one after a manual `/summary`. The
   round metadata has `round` = the commit's number in that line (1, 2, …) plus `kind:
   "round" | "summary"`. B0's rule "round number must increase" is kept.
7. **Discussion IDs don't exist yet.** The plan needs a stable discussion ID independent of the
   folder name. **What I'll do:** generate one at the first capture and keep the folder-name → ID
   map in `.agent-room/discussions.json`. Folder names never change (archive/deferred moves keep
   the name), so the map holds. **Consequence for stage C:** agent-room's own discussions are also
   in the project's Git, so charon can have the same folder from `git pull` but would give it a
   different ID. Received lines are grouped under a local discussion only when the IDs match.
   This can't happen in slice 1 and matters only for Continue here.
8. **Node names have capitals** ("Mac"), but B0's identity pattern was lowercase. **What I'll
   do:** node names allow letters, digits, `-` and `_`. Two peers whose names differ only in case
   are refused, because Git refs would collide on macOS's disk.
9. **Round metadata holds the conversation now.** B0's 4 KB metadata limit is far too small,
   because View must render the received conversation (the plan's "ordered conversation entries").
   **What I'll do:** the limit is the per-file limit (16 MiB). Provider session IDs, usage and
   worker entries stay out.
10. **Stale line references** in the spec are fine. `src/ui.mjs:909–921` is still the port
    fallback.
11. **`npm test` and the prototype.** As decided, B0's checks become `test/replicate.test.mjs`
    (part of `npm test`), and `prototype/` is removed.

The User's accepted choices are taken as given: storage in `<root>/.agent-room/`, kept out of Git
through the repository's `info/exclude` (it is not under `discussions/`, so the header's `+`
would otherwise count it); keep the latest snapshot of each line plus the one open in View.

## Resumed inspection (2026-11-07)

The interrupted attempt left uncommitted edits in cli/ui/docs and a new replicate module, but
no tests or browser replication controls. B0 still exists at HEAD. The initial inspection above
was preserved. Additional gaps found during resumption: the discussion-ID map needed archive
paths normalized to the folder basename; a shared View pin could be invalidated by another
browser; summary failure needed a failed round outcome; recovery tried to scan upload files as
folders. These are completion defects in the unfinished slice, not additional stage scope.
View will use one renewable lease per browser, released on Back or after two minutes without a
30-second renewal. A reload/closed browser abandons its old lease; no automatic latest-round jump.


## 1. Built

- `src/replicate.mjs`: B0's Git bundle protocol, separate bare repository, explicit pairing,
  persisted node/room/discussion identities, capture, background per-peer sends with capped
  backoff, recovery, immutable snapshots and reference-counted pins. Concurrent bootstrap
  pairings cannot overwrite an established room ID. Acknowledgement-file updates are serialized.
- `src/ui.mjs`: round/summary capture hooks, peer lifecycle and status, pairing previews showing
  both roots, per-browser View leases, snapshot file lookup, LAN addresses and occupied-port rule.
- `src/cli.mjs`: node/peer flags, restart preservation, startup errors and awaited Reload setup.
- `src/docs.mjs`: LAN-aware same-origin checks, peer routes, received files, Peers and received-line
  controls, read-only conversation and artifact View. Local agents/worker keep running when a
  browser selects View. Nothing replays a received message into an agent or a worker queue.
- README describes the LAN access, launch flags, pairing, View, storage and snapshot leases.
- Tests port B0 scenarios into the ordinary suite and add UI/storage/pairing contracts.
  `prototype/` is removed. No dependency, Continue here, reconciliation, Fork, source replication,
  remote stop or distributed worker was added.

Round trees include discussion files, ignored transcripts and `.agent-room-round.json`, with
conversation order, passes, summary outcomes, failure/completion, agent order/provider/model
settings and identity. Provider sessions, credentials, local usage, peer observations and worker
queues are not structured replicated state. Worker log entries already in Markdown remain readable
history. Local worker scratch files are not copied.

One manual summary is also a saved commit, labelled `kind: summary`; the line counter advances for
it. A failed automatic summary marks its encompassing round failed. Interrupted metadata is
preserved by the protocol. Hard process death cannot capture edits that have not reached disk;
there is no new graceful cancellation or recovery of a killed live invocation in this slice.

Storage is `<root>/.agent-room/`, excluded through the project's local `info/exclude` and explicitly
excluded from the header's dirty check. Plumbing bypasses ignore/filter rules and the source index.
Files are checked for changes during capture, including changes to the file list. A capture error
is reported and does not mark a round sent.

## 2. Snapshot pins and bounds

Each browser gets a separate random client ID and opens one pinned snapshot through `/__view`.
Pin acquisition and publication/cleanup for that line are serialized. Counts allow several
browsers to pin the same commit independently. A newer receive keeps the latest snapshot plus
all pinned snapshots. Back releases that browser's pin; changing View releases its previous one.

The browser renews every 30 seconds. A client silent for two minutes is treated as abandoned;
its pin is released and cleanup runs. Reloading or closing a tab abandons its old lease, which
therefore lasts at most two minutes. After expiration the UI says to select the line again.
Pins are in memory: server restart releases them and the existing PID heartbeat reloads pages.
Suspended/disconnected tabs must reselect View. Images and document requests use the selected
commit's immutable path, so normal publication and another browser's Back cannot invalidate them.
The two-browser retention/release behavior is tested; expiration timing itself was not clock-tested.

Limits: 64 MiB incoming bundle, 5,000 entries, 16 MiB per file (including round metadata),
256 MiB total expanded tree, 4 KiB request JSON/offer metadata and 64 KiB peer JSON responses.
Uploads and outgoing requests have timeouts. Incoming modes/paths, case and normalization
collisions, identity, schema, ancestry and exact acknowledged commit are checked. Blob reads use
`cat-file --batch` rather than one process per file. Retry delay is capped at five minutes;
unreachable peers never block the next local discussion after capture.

## 3. Real test output

Final command, from the worker worktree:

```sh
HOME="$PWD/.worker-notes/stage-b/test-home" npm test
```

The empty home isolates tests from this Mac's saved agent defaults. The first ordinary invocation
found an existing test's assumption that the default worker is Claude incompatible with the
User's saved Codex default. No existing test or personal default was changed to resolve that.
An early inline-browser syntax failure and receive-recovery failure were implementation defects
and were fixed before the final run.

Final output:

```text
ℹ tests 101
ℹ suites 0
ℹ pass 101
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17463.056252
```

Full output: [stage-b-test-output.txt](stage-b-test-output.txt).
`git diff --check` also exited 0 with no output.

B0 coverage mapping:

| Checks | Ordinary tests |
|---|---|
| Full/incremental transfer, exact file bytes, deletion, transcript append, read-only modes and interrupted metadata | `test/replicate.test.mjs`, scenario 1 |
| Duplicate offers/bundles, lost acknowledgement, missing-base full fallback | scenarios 2, 5, 6 |
| Cut upload, corrupt pack/checksum, previous publication unchanged | scenarios 3, 4 |
| Abrupt receiving-process death at five stages and restart cleanup/ref recovery | scenario 7, `test/helpers/replication-crash.mjs` |
| Unsafe types/paths, identity/schema/size errors, rewritten history | scenarios 8, 9 |
| Source repository HEAD/status unchanged | scenario 10 plus project-storage integration test |
| Pair preview/mismatch/races, transcript hook, failures and failed auto-summary, independent pins, deletion/cleanup and read-only input | `test/replication-ui.test.mjs` |
| Persistent node identity, archive-independent discussion ID, ignored transcript capture, unchanged source index and disabled replication without flags | project-storage integration test |

The B0 scenario test prints **85 passed, 0 failed**. It pins historical snapshots so its old
byte-for-byte immutability checks remain meaningful under the accepted cleanup rule; a separate
UI integration test verifies that unpinned old snapshots are actually deleted. The B0 report's
old 86-check count included its optional real-folder measurement check; a fresh real-folder
measurement is recorded separately below. The adapter uses production Git/HTTP functions, not a
second implementation. Existing tests were not weakened or rewritten.

## 4. Two-process Mac demonstration and Chrome

Node `v24.14.1`, Git `2.33.0`. Two disposable roots under the ignored
`.worker-notes/stage-b/demo2/`, ports 16471 and 16472, nodes Mac and Pi. Two actual CLI server
processes, with a fake `claude` executable first in their PATH; no provider tokens spent.

Pairing preview returned both roots; pairing succeeded. Seven ordinary rounds reached Pi. A
round-2 drawing was absent after its round-3 deletion. Pi was stopped; round 7 saved locally in
864 ms and reported it would send later. After Pi restarted, it received round 7 without a new
message. Starting another peer-mode server on 16471 stopped with:

```text
✗ Port 16471 is in use. With --peer this room must listen on its configured port, where its peers reach it: stop whatever uses 16471, or choose another --port (and tell the peers).
```

Full log: [stage-b-demo-output.txt](stage-b-demo-output.txt).
The demo records a regenerated bundle's size against the same acknowledged base, rather than
packet capture. Timing there includes the fake provider and local round work. Actual protocol
transfer sizes/time are measured independently in section 5.

Chrome inspection confirmed View shows Mac's round 7 and its transcript without a message box,
and the sender shows round 7 saved and sent. The earlier browser-access interruption was resolved.
Screenshots:

- [Panels B and G: received line and peers](stage-b-panels-b-g.png)
- [Panels A and C: read-only conversation and received transcript](stage-b-panels-a-c.png)
- [Panel F: saved and sent status](stage-b-panel-f.png)

The screenshots use the same disposable servers, not the normal room on port 5566. Both normal
room code and the User's working copy were left alone. The demo processes were stopped after
inspection; scratch fixtures remain until stage acceptance.

## 5. Measurements

A separate run copied the current discussion (including screenshots): **32 files, 1,242,394
bytes**. It used production capture/send/receive through HTTP; the source discussion was only
read. Each later round appended about 3.8 KiB of repeatable text. These compress well, so these
numbers are not a prediction for arbitrary conversation or image edits.

| Round | Bundle bytes | Capture + send ms | Send ms | Git processes | Mac Git KiB | Mac snapshots KiB | Pi Git KiB | Pi snapshots KiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 (full) | 515172 | 449 | 291 | 16 | 756 | 0 | 588 | 1280 |
| 2 | 585 | 310 | 222 | 20 | 772 | 0 | 596 | 1284 |
| 3 | 573 | 310 | 227 | 20 | 788 | 0 | 604 | 1288 |
| 4 | 516 | 294 | 218 | 20 | 804 | 0 | 612 | 1292 |
| 5 | 517 | 325 | 234 | 20 | 820 | 0 | 620 | 1296 |
| 6 | 518 | 338 | 237 | 20 | 836 | 0 | 628 | 1300 |

Disk figures are allocated KiB from `du -sk`, separating each Git store from snapshot folders.
The sender doesn't materialize its own snapshots. Receiver snapshot growth reflects the latest
file growing, not six retained copies. Git retains every round. No GC/repacking measurement was
made. The protocol scenario test also measures actual transfers on its smaller generated fixture;
see its full output. Process-startup dominance remains unprofiled.

Full measurement output: [stage-b-measurement-output.txt](stage-b-measurement-output.txt).

## 6. Code size

Relative to B0 commit `5153ce1`, physical lines added/deleted (updated after the follow-up):

| File | Added | Deleted |
|---|---:|---:|
| `src/replicate.mjs` (new, whole file) | 652 | 0 |
| `src/ui.mjs` | 194 | 15 |
| `src/docs.mjs` | 196 | 17 |
| `src/cli.mjs` | 13 | 2 |
| `README.md` | 37 | 3 |
| `test/replicate.test.mjs` | 355 | 0 |
| `test/replication-ui.test.mjs` | 117 | 0 |
| `test/helpers/replication.mjs` | 39 | 0 |
| `test/helpers/replication-crash.mjs` | 13 | 0 |
| Four old `prototype/replication/` files | 0 | 775 |

The new replication module is 652 lines including comments/blank lines. Source grew by a net
1,021 lines. It is within B0's 500–700-line estimate for the replication module, but the hooks/UI
also add substantial code; this is the explicit size review point in the rollout.

## 7. Not checked / limits

- charon, a real LAN/firewall, another physical machine, Pi memory/swap, IPv6, Windows.
- Real provider calls, authentication or continuation quality. The demo uses fake CLI output.
- Crashes between pointer rename and ref update, during pointer-temp writing, inside Git fetch,
  sender-side crashes, power loss, disk full. These B0 gaps remain untested. No directory fsync
  durability claim is made. A killed active invocation has no new recovery checkpoint.
- Three-node concurrent sending, both directions at once, a sender restart with a pending send,
  or a long-running soak. Receiver restart/retry and concurrent pairing identities were checked.
- Exact abandoned-browser timer behavior and client/server restart during an old pinned View.
- Very large real data. Limits exist; bundle-size refusal is tested. File/expanded-total limits
  and Unicode-normalization collision handling were not exercised with large/on-disk fixtures.
- Source project matching is advisory; peer status also reports its observed project commit/dirty
  flag (or version unavailable). It never asserts that tools or dependencies match.

No commit or merge performed. Stage C is not started. Scratch notes/fixtures remain in
`.worker-notes/stage-b/` pending the User's stage acceptance.


## 8. Stage B follow-up: plain tests and panels A–C

### Plain test comparison, before changing code

Both runs used the inherited `HOME=/Users/fausto`; neither changed HOME or personal settings.
Both modules report `/Users/fausto/.config/agent-room/defaults.json`, with worker provider Codex.
The main checkout is not the same source tree as the worker: main has uncommitted worker-setting
changes and an uncommitted test-fixture correction. Those files were read, not edited or copied
into this branch.

| Run | Result |
|---|---|
| Worker, plain `npm test`, before follow-up edits | 101 tests: 100 pass, 1 fail |
| Main, plain `npm test`, same environment | 98 tests: 98 pass, 0 fail |
| Worker's unchanged failing test against main's current `ui.mjs`, same environment | Same assertion fails |

Exact worker failure:

```text
test at test/ui.test.mjs:32:1
✖ the worker is a separate claude agent with its own session, kept across reloads
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  actual:   [ 'Worker', 'codex' ]
  expected: [ 'Worker', 'claude' ]
  operator: 'deepStrictEqual'
  at test/ui.test.mjs:35:10
```

The assertion is:

```js
assert.deepEqual([ctx.worker.name, ctx.worker.provider], ['Worker', 'claude']);
```

The worker's fixture is still `const ctx = freshCtx();`, which does not specify a worker.
Main's current, uncommitted version explicitly sets:

```js
const ctx = { ...freshCtx(), workerSpec: 'claude:Worker' };
```

To separate the source behavior from the fixture difference, I saved a scratch copy of the
worker's test file, changed only its `ui.mjs` import to main's absolute module URL, and ran:

```sh
node --test --test-name-pattern='the worker is a separate claude agent' \
  .worker-notes/stage-b/main-code-old-test.test.mjs
```

It failed with exactly the same actual/expected provider values. Thus both implementations honor
Codex in the same saved settings when no explicit worker is supplied. The passing main result is
explained by its explicit fixture, not by a stage B regression. The worker's `test/ui.test.mjs`
has no diff from B0 HEAD. No existing assertion, test fixture, saved setting or provider-default
behavior was changed in this follow-up, as requested for a failure not caused by stage B.

Evidence:

- [Worker initial plain run](stage-b-followup-initial-plain-tests.txt)
- [Main plain run, 98/98](stage-b-followup-main-tests.txt)
- [Old fixture against main's current source](stage-b-followup-main-code-old-test.txt)

### Corrected UI

`src/docs.mjs` now implements:

- **A:** header second line contains server status, local node/address, selected line and round,
  advisory Project context, and the separate peer live-activity observation. View says
  `Viewing Pi's line, round 1, received … · read-only`; the discussion title also follows the
  selected View, instead of continuing to say No discussion started.
- **B:** each discussion expands into its node lines. A local row identifies this node, round
  and sent/pending peers; a received row identifies node, round, receipt time and observed
  activity, with a View button. Received-only discussions have only received rows. Grouping is
  by discussion ID; it does not merge unrelated discussions with the same folder name. Expanded
  rows stay expanded during status refresh. Peers, including reachability dots and pairing
  state, are at the bottom of the Discussions pane, not above the conversation.
- **C:** the message box is replaced by a bottom read-only bar naming node, round and receipt
  time. It keeps Usage, Restart and Quit, and hides agent settings, auto-summary, Summarize,
  Reload and Send to agents. Back is `Back to Mac's line`, and is absent when that discussion has
  no local line. No Continue button is present. Local discussion/worker activity is shown
  separately. Newly received rounds get a separate View-newer control; they do not replace the
  pinned selection. Local status events no longer append into the pinned conversation.

`src/ui.mjs` also publishes Project context after startup has measured it, so a node with no
configured peers does not remain incorrectly labelled Version unavailable. The integration test
now asserts startup's screen Project context equals the measured context. README labels were
updated to match. The replication protocol and stage C behavior were not changed.

### Chrome evidence, full bottom visible

The follow-up reused disposable roots and fake CLI agents. For the two-lines-under-one-discussion
case, a local Pi line sharing the test discussion ID was deliberately prepared as a fixture
before launching the servers; it was not produced by a Continue operation. The application has
no Continue implementation. The received-only check used the earlier disposable Pi root, which
has a received Mac line and no local discussion line.

- [A1 and B: own header and expanded Mac/Pi rows](stage-b-followup-panels-a1-b.png)
- [A2 and C: View with artifact and full bottom bar, including Back to Mac's line](stage-b-followup-view-bottom.png)
- [A2 and C with no local line: full bottom, no Back button](stage-b-followup-view-no-local.png)

The bottom controls were visibly inspected in Chrome: no message box, Summarize, auto-summary
or agent settings in View; Usage, Restart and Quit remain. The screenshot with an artifact also
shows the selected conversation and immutable document path. Existing screenshots in section 4
are retained as earlier evidence and are superseded by these for panels A–C. The demo processes
were stopped after inspection. Scratch data remains pending stage acceptance.

### Final follow-up validation

Plain `npm test` (HOME unchanged) exited **1**:

```text
ℹ tests 101
ℹ pass 100
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14605.991558
```

The only failure remains `test/ui.test.mjs:35`, actual Codex versus expected Claude, as established
above. Full output: [final plain run](stage-b-followup-plain-tests.txt).

Separately, the full suite with the already documented isolated test home exited **0**:

```text
ℹ tests 101
ℹ pass 101
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13954.251289
```

Full output: [isolated run](stage-b-followup-isolated-tests.txt). This is additional verification,
not a claim that plain npm test is green. The embedded browser script syntax check is included
in the ordinary docs tests. `git diff --check` exited 0 with no output.

Not checked in this follow-up: real providers, charon, a real LAN, small-screen/mobile layouts,
active local worker rendering during a remote View, and the new-round control's browser
interaction. The earlier section 7 limitations still apply. Nothing committed or merged.
