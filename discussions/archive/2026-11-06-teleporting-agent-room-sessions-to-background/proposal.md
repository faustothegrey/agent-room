# Proposal: discussions replicated across nodes as git branches

Status: **approved by the User on 2026-11-07** (written by Claude and Codex).
It is the single current specification. Read it with [ui-design.md](ui-design.md) (screens)
and [implementation-plan.md](implementation-plan.md) (how a worker builds it). History, dropped
alternatives (including the earlier exclusive-ownership design) and sources are in
[notes.md](notes.md).

## Goal
A discussion can continue unattended on an always-on machine (the Pi), and the User can carry
it to another machine and continue there. Each machine keeps its own line of the discussion,
replicated to the others with git. Only *discussions* are in scope; implementation work and
project source are not replicated. Agents keep using the real CLIs, always on the machine where
the discussion is continued.

## Decided by the User
1. Background means **unattended discussion**, not implementation work.
2. For now a **mirrored** discussion is enough; seamless movement between devices is the
   long-term aim.
3. Nodes for now: the **Mac** and a **Raspberry Pi 4** (aarch64, Debian 13, 4 GB). The browser
   runs on the Mac; more devices later.
4. The first live trial is **one ordinary round**.
5. The owning node and where agents run are **clearly shown in the UI and recorded in the
   discussion's metadata**. Under the branch model the UI distinguishes the viewing server,
   the selected line's publishing node, and actual execution location; exclusive ownership
   no longer applies. This translation is an agent proposal implementing the earlier decision.
6. Servers talk through **a small protocol of their own**; each server is configured with its
   peers' **network addresses**.
7. The User opens **a node's IP address directly**, with no SSH tunnel and **no
   authorization**: the LAN is trusted, and agent-room is used only on the User's own LAN for
   now.
8. **`npm start` binds to `0.0.0.0`.**
9. **The worker is not distributed.** Only discussions are.
10. **Explicit room pairing** across nodes; each node keeps its **own copy of the project
    source**.
11. **Git replication**, in git storage separate from the project's own.
12. **One branch per discussion per node.**
13. **Commit once per round**, right after the summary, and send it to the other nodes.
14. **Continue here** brings the other node's line into this node's branch **unless there is
    divergent work**; reconciling divergent work is **manual for now** (agent-assisted later).

15. (2026-11-07) **Accept this line as reconciled** is included.
16. **Setup:** `--node <name>` and repeatable `--peer <name>=http://<ip>:<port>`, plus a
    one-time pairing step.
17. **The Worker tab stays**, provided the worker works in **its own git worktree and branch**
    of the project.
18. **Fork from here** is in the first version.
19. **Projects without a git repository: the worker is disabled**, with an explanation.
    Distributed discussions still work there.

**Note on decision 17 (Claude):** that is not today's behaviour. Neither the README nor `src/`
mentions worktrees, so today the worker edits the room's folder directly. Giving it its own
worktree and branch is a change to the worker. It also means the worker no longer touches the
room's `discussions/`, so round commits wouldn't need to wait for it. Settled: it is a
separate prerequisite stage (stage A in [rollout.md](rollout.md)).

**Node names:** "Pi" in this document is the example name for the Raspberry Pi, whose real host
name is **charon**. With `--node`, the name shown in the UI is whatever is given there (rollout
uses `charon`).

## Concepts
- **Node:** one machine running agent-room, with a short name (`Mac`, `Pi`) shown in the UI.
- **Room:** a project folder (agent-room's root). The same room on two nodes is **paired**
  explicitly with a stable **room ID**. The paths may differ, for example
  `/Users/fausto/Software/agent-room` and `/home/pi/projects/agent-room`.
- **Discussion line:** the branch `<node>/<discussion>` in the room's discussion repository.
  A node writes **only its own** branches; it receives the other nodes' branches read-only.
- **Round commit:** one commit per round, holding the discussion folder (notes, drawings,
  transcripts) plus the conversation state a fresh node needs to rebuild the room.

## How it works
Drawing: [drawings/branch-model.svg](drawings/branch-model.svg) (render checked by Claude in Chrome, 2026-11-07).

**1. Ordinary work on one node.** You talk in the Mac's room as today. When the round ends (all
agents passed or 8 turns), and after the summary if Auto-summarize is on, the Mac commits the
discussion to `mac/<discussion>`. That commit is made even when the round failed or Auto-summarize
is off; a failed or interrupted round is marked as such in the commit. The Mac then sends the
new commits to its peers. A peer that can't be reached gets them later, and the conversation
never waits for it. The UI shows which peers have received the latest round.

**2. Viewing another node's line.** On the Pi, the Discussions pane lists the discussion with one
line per node: "Mac · round 12 · received 14:32". **View** opens that state read-only, with no
agents running. "Received" means the latest state that arrived, not necessarily the Mac's
current state; the Mac's live activity ("running a round", "idle", "unreachable") is shown
separately.

**3. Continue here.** On the Pi, **Continue here from Mac's last received round** compares
`pi/<discussion>` with `mac/<discussion>`:

| Case | Git fact | What happens |
|---|---|---|
| Pi has no branch yet, or Pi is **behind** | `pi/<d>` is an ancestor of `mac/<d>` | **Fast-forward** `pi/<d>` to Mac's commit, open it, and let your next message start fresh local CLI sessions. |
| Pi **already contains** Mac's commit | `mac/<d>` is an ancestor of `pi/<d>` | Keep Pi's line as it is; never rewind it. Open it. |
| **Both** have their own new rounds | neither is an ancestor | **Reconciliation required:** nothing is changed, both lines are kept and shown side by side. You reconcile by hand for now. |

Automatic updates are **only fast-forwards**. Git's text merge is never used on discussions,
even when it reports no conflict: two conversations interleaved line by line would describe a
discussion that never happened.

**Before switching:** if the Pi's discussion folder has edits that aren't committed (for example,
a round interrupted by a restart), they're first committed to `pi/<d>` as an **interrupted
round**. This turns them into ordinary history: the comparison above then shows any divergence,
and nothing is lost.

First wait for the active local discussion/summary to finish; the isolated worker may continue
independently. Don't
checkpoint files while their writers are still running. Label manual-edit checkpoints accurately
rather than calling every dirty folder an interrupted round. Recompute the comparison after
checkpointing and show a changed result before confirmation. The selected received commit is
pinned, so a newer incoming round cannot silently change what Continue here means.

Continuing on the Pi does **not** stop the Mac. If the Mac is still running a round, both lines
may advance, and the next Continue here will report it. The panel says so plainly before you
confirm. Stopping another node remotely is later work.

**4. Fork from here (included in the first version).** This starts a **new discussion**, with a new ID and a record
of where it came from, from any point of any line. It's for deliberately exploring an
alternative; it isn't needed to handle divergence.

**5. Reconciliation (manual, for now).** "Reconciliation required" shows both lines from their
common round onward. For now you decide by hand. You can continue one line, which keeps the
other in history, or ask the agents in that line to read the other line's rounds and write a
combined round. Agent-assisted reconciliation becomes a feature later.

A combined textual round does not itself join the two Git ancestries. This version provides
read-only access to both histories and local continuation, not an automatic merge-commit policy.
If histories have no common ancestor, show that explicitly.

## Project context
Discussion replication doesn't copy the project. For a code discussion, the node continuing it
needs its own checkout. The header shows an advisory **Project context** for each node: the
commit, plus whether there are uncommitted changes (ignoring discussion files and replication
storage), or "Version unavailable" without git. It never blocks a discussion, and matching
commits don't guarantee matching tools or dependencies.

## The local worker
The Worker tab stays, with execution in its own source Git worktree and branch. Its queue,
execution and provider session remain local. Implement isolation as a separately testable
prerequisite in the same plan; preserve room edits and unfinished worker work, show the worker
path/branch/base, and never merge or delete worker changes automatically. Worker notes stay
visible locally but are not captured from its worktree into discussion replication. Therefore
isolated worker execution does not delay room discussion snapshots. Worktrees isolate working
copies, not filesystem permissions.

For source projects without a Git repository, disable worker execution with an explanation.
Distributed discussions still work using their separate Git storage.

## Network
The server listens on `0.0.0.0` and prints usable addresses, such as
`http://192.168.1.20:5566/__room`. Requests through the node's IP are accepted, and the existing
same-origin protection against unrelated websites stays. Any device on the LAN can view a node
and continue discussions there, which is accepted under decision 7. The README's "Access and
limits" section must say so.

## Accepted ancestry reconciliation
After manually reviewing or combining divergent content, the User may explicitly choose
**Accept this line as reconciled**. Confirm: "Keep Mac's current discussion files. Record Pi's
selected round as accounted for." Show and pin both commit IDs. After local writers finish and
work is checkpointed, record a two-parent commit retaining the local tree unchanged (Git ours
strategy), without a text merge. Preserve both histories and publish the local result.

This does not claim agents checked or incorporated the other line. Only the pinned remote
commit is acknowledged; newer remote rounds can still diverge. A combined textual summary
alone does not join ancestry. No further User decisions remain in this draft; prototype and
implementation details still need validation.

## Build in slices
First implement and test local worker isolation, including disabling it for non-Git projects.

1. **Slice 1, replication only:** LAN binding, node/peer flags, room pairing, round commits on
   each publishing node, sending them to peers (git bundles through agent-room's connection are the
   first candidate to prototype), and **View** on the other node. Tests: an interrupted
   transfer leaves the previous state intact; deletions arrive; nothing touches the project's
   own git state.
   Each node writes its own lines; received lines are read-only. This replaces the former
   fixed-source slice. No network-wide single-active-discussion enforcement remains: nodes
   can continue independently, each through its own local discussion queue.
2. **Measure the code it added** against agent-room's "read in one sitting" goal.
3. **Slice 2, Continue here:** the three cases, interrupted-round commits, fresh local sessions
   from a received state, Reconciliation required, live activity of the other nodes.
4. Include Fork from here and Accept this line as reconciled in slice 2 of the first version.

## Pi pre-check (no code changes)
Install agent-room and both CLIs on the Pi and sign in. Run one ordinary round there; until the
`0.0.0.0` change exists, reach it with `ssh -L 5566:127.0.0.1:5566 pi`. Measure the lowest
*available* memory, swap use, and whether either CLI exits or stops responding. Claude Code's
docs ask for 4 GB+ RAM, and the Pi has exactly 4 GB.

## Later, not part of this proposal
- Agent-assisted reconciliation; stopping another node's round remotely.
- Running CLIs on another node (SSH, Rex).
- Phones and other devices; authorization; use outside the home LAN.
- Longer unattended runs (several rounds within a budget).
- Replicating project source.

## Untested or assumed
- Both CLIs run on this Pi and fit in its memory.
- Git bundles over agent-room's connection; separate discussion git storage beside a project
  that may itself use git; per-discussion branches checked out into each discussion's folder.
  All of this is design only.
- That a fresh session can continue well from a round commit (transcript plus notes); its token
  cost is unmeasured.
