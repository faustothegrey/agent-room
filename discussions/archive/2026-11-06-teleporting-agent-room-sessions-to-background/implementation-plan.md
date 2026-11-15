# Implementation plan: Git discussion lines across nodes

Status: **approved by the User on 2026-11-07** (written by Codex, reviewed by Claude). This document supersedes the ownership-transfer implementation plan. Read
[proposal.md](proposal.md) and [ui-design.md](ui-design.md) alongside it. No implementation is
authorized by this document alone. New mechanisms below are proposed and untested.

## Deliverable and limits

Each paired room maintains separate Git discussion storage. Each node publishes only its own
branch for each discussion; other nodes receive that branch read-only. At the end of a round
and its optional summary, record one commit with conversation state and discussion artifacts.
Synchronization failure does not prevent local discussion. Continue here updates the local
line only when histories permit it; committed divergence requires manual reconciliation.

No exclusive owner, ownership generations, takeover, leader election or handover protocol.
No automatic merge, remote stop, remote CLI execution, source synchronization, or distributed
worker. No new package dependency or config framework. Prefer existing source modules; ask the
owner before adding a module as required by the repository instructions. Git is a required
executable for replication; the project itself need not be a Git repository.

## Approved choices

The User approved `--node <name>`, repeatable `--peer <name>=http://<ip>:<port>` and explicit
pairing; Accept this line as reconciled; Fork from here in the first version; and retaining
the local Worker tab **provided execution uses its own source worktree and branch**.

The User decided: when the source project is not a Git repository, disable Worker execution
with an explanation. Discussion replication remains supported through its separate repository.

### Prerequisite: isolated local worker

Implement and test this before replication integration. Today's worker runs in the room root;
this is a behaviour change required by the User's new condition, not existing functionality.
Create/reuse a distinct source Git worktree and worker branch without changing the room's
index, branch or uncommitted edits. Base it on an explicit recorded source commit; do not
silently copy or discard room changes. Show the worker path, branch and base in its tab so the
User knows what source it sees. No automatic merging back to the room.

Pass worktree-local paths to worker instructions, including its own discussion-note location.
Replicate only the original room's discussion directory, never the worker worktree or its
notes. Keep worker replies/notes accessible locally in the Worker tab. Restart reattaches to
unfinished work; cleanup must not delete dirty work or branches automatically. Avoid recursive
worktree placement and exclude node-local worker storage from replication/project dirtiness.
Isolation separates working copies; it is not a filesystem security sandbox.

## Source map (read 2026-11-06; worker must recheck current source)

| File | Work |
|---|---|
| `src/cli.mjs` | Node/peer options, shared persistent context, serialized local input, restart argument preservation. |
| `src/ui.mjs` | Node/room/discussion identity, round-end capture, local Git orchestration, received-state publication, continuation, worker coordination and lifecycle. |
| `src/room.mjs` | Restore structured conversation and fresh agent seen state. Preserve turn cap, pass and summary rules; add boundary support only as needed. |
| `src/docs.mjs` | Status/replication endpoints, validated peer data, snapshot-aware document reads, UI A–G and read-only received views. |
| `src/agents.mjs` | Keep local CLI invocation and session behaviour. No Rex adapter or cross-node session copying. |
| `src/usage.mjs` | Keep meter/token behaviour local; never present another node's usage as measured locally. |

Current callbacks are synchronous, conversation state is in memory, Markdown logs are not a
lossless state serialization, and the worker runs concurrently. Existing Restart creates fresh
sessions and relies on an optional handoff convention. Account for these rather than assuming
Git checkout reconstructs application state.

## Identity, repositories and refs

- Node identity is stable across restarts, separate from a changing IP address.
- Explicitly paired roots share a room ID; their absolute paths may differ. Validate room ID
  before importing a discussion. A mismatch refuses replication without replacing either ID.
  Bootstrap pairing may adopt an ID only through the explicit pairing confirmation, never by
  silently overwriting an established different ID.
- Each discussion has a stable ID independent of its title, folder name and archive location.
  Local/received lines are identified by `(room ID, discussion ID, node ID)`.
- Use separate node-local Git storage and an isolated index/worktree. Automatic Git commands
  must never stage source changes, switch the project's branch, change its remotes/index or
  reset its files. Repository layout is a prototype decision; per-discussion branches must not
  accidentally delete other discussions when checked out.
- Use a validated ref mapping for identities, not unchecked user names embedded in commands.
  Invoke Git with argument arrays, no shell interpolation. Keep local published refs and remote
  received refs separate. A peer cannot write this node's branch.
- Normal publication is append-only. Reject a received branch rewind or unrelated rewrite;
  report it for manual resolution rather than force-update. Separate refs preserve both tips.
  Retain required commits under explicit refs, not merely reflogs/unreachable objects.

## Round commit contents and boundaries

A commit tree contains the discussion artifacts, readable transcripts, and versioned structured
state: room/discussion IDs, publishing node, ordered conversation entries, round identifiers,
completion/failure state, agent order/provider/model choices, and any display state needed to
restore the conversation. Include passes and summary outcomes; exclude provider session IDs,
credentials, CLI caches, worker instructions/queues/sessions, peer observations and staging.
Worker notes in its isolated worktree are not replicated discussion artifacts.
Decide explicitly whether worker log entries in mixed transcripts remain as readable history;
never restore them as executable instructions or a worker queue.

Use Git tree/object IDs as snapshot identities and checksums; do not add a duplicate hash
manifest or a custom missing-file transfer algorithm. Validate the allowed tree scope and
schema, including file types. For the first version reject symlinks, submodules, absolute paths,
traversal and unsupported entries. Define reasonable object/body/file limits; reject a bad
snapshot without partially publishing it. Do not follow a received link into the project.

Capture once after the existing round and automatic summary finish. If summaries are off,
all agents pass, a turn fails, or summary generation fails, still capture completed history and
current discussion edits with the appropriate outcome. A successful Git commit does not turn
an interrupted discussion into a completed round. Preserve existing summary/turn-limit contracts.
No hidden LLM calls to prepare commits or handoffs.

Capture must be stable: serialize discussion-file writers during the copy/staging operation.
The isolated local worker is not a writer of this directory and need not delay capture.
Do not hold this gate for
network transfer. Prevent a later discussion round from modifying files before the completed
round is captured. An arbitrary external editor is not transactionally controlled: detect changed
files during capture and retry or report failure, not claim an atomic filesystem snapshot.
If capture/commit fails, retain all files and show a saving error; do not mark the round sent.

Run Git/network operations in bounded background work where possible. Once a local commit is
saved, the next round may proceed without waiting for peers. A paused capture may delay new
file-writing work to preserve the round boundary; distinguish that from a slow network.

### Dirty and interrupted work

Before switching the active local line, wait for its running discussion/summary to stop. The isolated local worker may continue independently. Never commit an active invocation's partial files while it continues
writing. Preserve committed state plus staged, unstaged and untracked discussion edits. Save
recoverable incomplete work to that local discussion branch as an interrupted checkpoint, then
recompute history relationships. A dirty file is not necessarily an interrupted agent round;
label an idle/manual-edit checkpoint accurately.

Crash recovery cannot save edits that never reached disk. At restart, inspect dirty discussion
work before installing another line and avoid appending a fake clean completion record. If a
stable checkpoint cannot be made, refuse the switch with an actionable error and keep the files.

## Replication protocol and prototype

Start with two temporary roots, separate discussion repositories and fake CLI runners. No real
model call is needed to choose the Git layout and transport.

Prototype Git bundles carried through the existing peer HTTP connection:
1. Status/offer identifies protocol version, room ID, discussion/node ID, offered commit and
   receiver-acknowledged base. It also reports live activity separately from received state.
2. Create an initial full bundle or an incremental bundle based on a confirmed receiver base.
   Missing prerequisites trigger an explicit full transfer or negotiation of another known base.
3. Stream to temporary storage; validate bundle prerequisites, import into a controlled temporary
   ref, validate the commit's identity/schema/tree and branch ancestry. An arbitrary peer ref name
   is not an instruction to update local refs. Do not run received hooks or project Git filters.
4. Materialize into an immutable received snapshot directory, then atomically change its published
   pointer. A directory-by-directory checkout is not atomic UI publication. Hold the old snapshot
   until the complete new one is readable.
5. Acknowledge the exact published commit. Only then show that peer as synchronized. Lost replies
   and duplicate offers are idempotent; a process restart recovers the published pointer/ref.

Commit creation, object receipt, materialization and publication are separate stages. Git's
complete object graph does not make a mutable working directory update atomic. Document views
must resolve through a selected immutable snapshot; an already open View must not quietly jump
to a later round without showing which state is selected.

If bundles are unsuitable, compare another Git transport before designing custom object transfer.
Record commands, outputs, initial/incremental payload sizes, transfer time and code size. Keep
protocol metadata small and stream payloads, especially on the 4-GB Pi. Use timeouts, bounded
retries/backoff and per-peer queues. Coalesce sends to the latest tip without losing intervening
commits. An offline peer retries later; never stall the local conversation waiting for it.

No mandatory central remote or SSH tunnel. For slice 1 use directly paired peers; do not assume
forwarding through third nodes, network discovery or global active-discussion consensus. The
branch model does not enforce the earlier network-wide one-active-discussion rule: independent
nodes may continue independently. Each server keeps its current single local discussion queue.

## View, Continue here and reconciliation (slice 2)

**View:** select a received commit and render its conversation/artifacts read-only. Selecting it
must neither start/reset agents nor stop an existing local round/worker. Distinguish the active
local discussion from the viewed remote state; show a Back to local line action when one exists.
Guard mutation endpoints as well as controls. Viewing remote transcripts must not accidentally
invoke existing Send to agents or Re-open actions against the remote state.

**Continue here:** pin the selected received commit when the panel opens. Show source node,
round, receive time, live-activity observation time and local/source Project context. Say clearly
that the source may keep running. On confirmation serialize through the local command boundary,
checkpoint local dirty work, and recompute against the pinned commit:

| Relationship | Action |
|---|---|
| No local line | Create this node's branch at the selected commit. |
| Local tip is ancestor of selected commit | Fast-forward local branch to that commit. |
| Equal tips or selected commit is ancestor of local tip | Keep local tip; explicitly show the actual local round being resumed. |
| Neither is ancestor / unrelated histories | Change neither line; show Reconciliation required. |

If checkpointing changes the predicted case, update the panel and obtain confirmation of the
new outcome instead of applying a stale preview. Never merge text automatically, reset a local
continuation, or update the publishing source's branch. A ref-only change is still a local state
change: materialize safely and restore the active context before enabling input.

Restore with fresh local CLI sessions when changing active context. Use structured conversation
and local root paths, not another machine's absolute paths or provider session identifiers.
No auto-replay of a pending User message as a new round, no automatic resume of interrupted work.
The next User submission starts the next round. Retain existing sessions when resuming the same
unchanged active line where safe. Never silently truncate context; if it cannot fit, report it
rather than inventing missing history. Context quality and token cost need live measurement.

Reconciliation is informational/manual: show both histories since the common ancestor, summaries
and artifact changes. If there is no common ancestor, state that rather than inventing one.
Continue local line leaves the other intact. Provide read-only file/transcript links with source
node and commit identity; manual prompts can direct local agents to those copies. A combined textual summary alone does not join ancestry. Implement the User-approved
**Accept this line as reconciled** action: pin the selected remote commit, checkpoint stable
local work, and confirm that the local discussion contents are retained while that exact remote
commit is recorded as accounted for. Create an explicit two-parent commit with the current
local tree (ancestry-only, equivalent to Git's ours strategy), without a textual merge. Assert
that its tree equals the local pre-action tree, advance only the local ref, and replicate it.
This does not certify semantic reconciliation. Remote commits after the pinned one remain
unacknowledged. No merge when confirmation is cancelled or writers are active. A reconciliation badge denotes the current tip comparison, not a permanent
property that never changes. The User-approved Fork creates a new discussion ID with origin node/discussion/commit metadata; copying its old folder/title verbatim is not sufficient.

## Network, lifecycle and project context

Bind npm start to the User-approved `0.0.0.0`; accept direct node-IP access while retaining
same-origin browser mutation checks. The LAN is trusted; no browser authorization or shared
secret is required in this version. Peer endpoints still validate pairing, identities, size and
schema; this is correctness validation, not authentication against malicious LAN devices.
Update README Access and limits and print usable IP URLs. IPv4 all-interface binding does not
itself promise IPv6 access.

Configured peer addresses need stable ports. In peer mode, report an occupied configured port
clearly rather than silently becoming unreachable on a random one; any change to existing port
contracts needs approval. Preserve standalone behaviour otherwise. Keep pairing/ref publication
state through Restart/Reload; never duplicate timers or peer queues on hot reload. Local Quit
and Restart affect only this server. Linux launch must tolerate unavailable macOS chooser/open
commands without losing the room. Do not alter unrelated launcher behaviour unnecessarily.

Project context is advisory commit plus source dirtiness, excluding discussion/replication
storage, or Version unavailable. Never replicate source to make checkouts match. A matching
room ID confirms intended pairing, not equal source, dependencies or tools. Local worker code
edits remain local. Clearly identify viewing server, selected branch publisher and actual local
execution node; do not reuse an exclusive-owner badge with its old meaning.

## Implementation slices and acceptance

### Stage 0: New discussion and return navigation

Implement the User-requested New discussion button before worker isolation, following section I
of ui-design.md. Proposed /new command and confirmation wording accompany it. Queue behind an
active round and summary. Retain/close the current transcript, reset discussion-agent context,
then show No discussion started until the next message creates the titled active discussion.
Do not create empty folders merely for opening or cancelling the confirmation. Preserve the
previous discussion in the pane with a direct Re-open action and a clearly labelled back link.
The back action reopens a discussion with fresh discussion sessions; it does not restore old
provider memory or silently resubmit a pending draft.

Do not reuse reopenDiscussion wholesale: it currently waits for and resets the worker too.
For New discussion, the local worker must continue against the work target it received; later
worktree isolation makes that target independent. Keep an outstanding worker task/log associated
with its originating context rather than silently assigning it to the new discussion. Scope
this stage narrowly; do not change existing Re-open worker semantics without explicit approval.

Tests: New while idle/busy, cancellation/confirmation, first-message title or folder failure,
old transcript retained, return navigation, no empty discussion on cancellation, fresh discussion
sessions and no worker cancellation/reset/retargeting. Verify the actual browser controls. After
replication exists, test that switching saves any unsent local state before changing discussion
and gives the new discussion its own ID and node line. See rollout.md for deployment stages.

### Prerequisite: worker isolation
- Disable the worker for non-Git source projects; implement the isolated worktree/branch contract above.
- Test clean and dirty source roots, existing worker work, restart, local note visibility and
  absence of automatic merge/deletion. Review this independently before replication.

### Slice 1: round commits and received views
- Implement the approved configuration and pairing. Prototype separate Git storage and bundle transfer.
- Implement LAN binding, explicit pairing, stable IDs/refs, round-end capture and retrying peer
  replication. Add UI A/B/C/F/G with Continue here hidden until implemented.
- Test two processes on separate temporary roots. Both can publish their own lines; a received
  line stays read-only. No fixed source election or ownership-transfer state machine.
- Show interruption safety, deletions, initial/incremental transfer, round outcomes and isolation
  from the project's Git state. Inspect rendered UI. Review actual code size before slice 2.

### Slice 2: Continue here
- Implement stable local checkpoints and the ancestor/equal/divergent cases above, structured
  context restoration and UI D/E. Preserve all histories, with manual content reconciliation and explicit ancestry acceptance.
- Include remote-activity freshness and explicit no-remote-stop wording. Include the approved Fork from here action with new identity and origin metadata. No remote worker or implementation workspace migration.

### Real Mac/Pi trial
- Run one ordinary round using both real CLIs on the Pi; browser on Mac via direct IP after
  LAN support exists. Check unattended stopping, received state and fresh-session continuation.
- Measure lowest available memory, swap, CLI failures/responsiveness, transfer size/time and
  reported token use. Record unmeasured costs honestly. Local fakes do not prove Pi viability.

## Required tests and completion evidence

Run the existing npm test suite before/after changes and read the results. Add meaningful cases
to relevant test suites without weakening existing contracts; ask before changing an assertion
that captures relied-on behaviour. Use fake runners for routine tests, not paid provider calls.

Slice 1 tests: pairing mismatch/ref validation; stable room/discussion identity across paths;
project index/branch/dirty-source isolation; full/incremental bundles and missing prerequisites;
interrupted/corrupted/duplicate transfers; rejected rewrites; prior received view survives process
restart and incomplete materialization; deletion/addition; offline peer/retry; all-pass, summary-off,
agent-error and summary-error round capture; capture failure; isolated worker writes never enter round commits;
read-only remote HTTP actions; direct IP and origin checks; Reload/Restart queue/timer behaviour.

Slice 2 tests: absent/equal/behind/ahead/divergent/unrelated branches; dirty/untracked edits preserved;
active round waits safely; preview invalidated by checkpoint; pinned source commit during a newer
incoming publication; correct fresh context and local paths; no provider-session migration or
pending-message replay; manual reconciliation preserves both; View never stops local execution;
ancestry acceptance keeps the exact local tree with both pinned parents; later remote rounds
remain divergent as appropriate; Fork creates independent identity without changing the source.

Visually inspect actual owner/local-line, received-view, offline, saving-error and reconciliation
states. Render both SVG references before calling them visually verified. Deliver file/change
summary, real npm test results and separate manual/browser/Pi results, with omissions explicit.

## Worker handoff

### Deployment and real-workflow checkpoint

The User's rollout is: worker implements the agreed slice(s), User pushes source to origin,
pulls on charon, then starts both updated servers. This source-code deployment is separate
from application-managed discussion replication; pushing origin does not pair rooms or sync
their separate discussion repositories.

Before rollout, require real npm test output and a list of implemented/deferred actions. Test
two separate local roots first. On Mac and charon use the same application revision, stable
node names and reachable configured ports; pair the intended room roots explicitly. Install
dependencies and verify Node/Git/CLI prerequisites on charon. Never commit credentials or
node-local Git storage. Preserve working files before changing where servers run.

Acceptance run: complete one Mac round and its summary; observe the exact commit received on
charon; View it without agents starting; after slice 2 Continue here and send a message; verify
a new charon round appears on Mac. Then exercise divergence, explicit ancestry acceptance and
Fork in disposable discussions. Briefly disconnect a peer and verify later catch-up without
local blocking. Record actual memory use and provider behaviour separately from fake tests.
Slice 1 alone cannot test Continue here, reconciliation or Fork; label it replication-only.

Supply the exact three document paths and User answers; the worker does not receive this chat.
Authorize the chosen slice explicitly. First verify source mappings and flag contradictions,
then implement that slice under repository rules. This plan contains no executed prototype,
no passing test claim and no source changes. Git replication is decided; its storage/transport
mechanics and cost remain to be established by the prototype.
