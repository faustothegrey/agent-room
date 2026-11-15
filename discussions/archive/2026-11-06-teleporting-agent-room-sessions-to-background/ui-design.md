# UI design: discussion lines across nodes (branch model)

Status: **approved by the User on 2026-11-07** (written by Claude and Codex).
It implements [proposal.md](proposal.md). It builds on today's layout, which Claude looked at
in Chrome on 2026-11-06: a header at the top left, the conversation on the left, the
Discussions pane on the right, and the message box with buttons at the bottom.

Mock: [drawings/ui-states.svg](drawings/ui-states.svg) (panels A–G). Concept:
[drawings/branch-model.svg](drawings/branch-model.svg). Both renders were checked by Claude in the room's document pane (Chrome, 2026-11-07): the text is legible, nothing overlaps, and they match this document. The
earlier ownership version of this design is described in [notes.md](notes.md).

## Words used on screen
- **Node:** a machine (Mac, Pi). **Line:** one node's branch of a discussion ("Pi's line").
- **Round:** from your message until all agents pass, the turn cap is reached, or a turn
  fails, followed by the summary when applicable. One commit each.
- **Received:** the latest state that arrived from another node, which may be behind that
  node's live state.

## A. Header, second line
Today: `● Server up 9h 29m · port 5566`. Proposed:

| State | Second line |
|---|---|
| A1 your own line | `● Server up … · Mac 192.168.1.12:5566 · Mac's line, round 14 · agents run on Mac · Project 788e37d + uncommitted` |
| A2 viewing another line | `● … · Mac 192.168.1.12:5566 · [Viewing Pi's line, round 12, received 14:32 · read-only] · Pi: running a round` |

- "agents run on Mac" is checked live.
- "Project …" is the advisory Project context, or "Version unavailable" without git.
- Another node's live activity is one of *running a round*, *idle* or *unreachable since …*.
  It's shown separately from what was received.

## B. Discussions pane: one row per line
The discussion's row expands to show each node's line:

```
💬 2026-11-06-teleporting-agent-room…
   ● Mac (this node) · round 14 · sent to Pi ✓
   ● Pi · round 12 · received 14:32 · Pi idle      [View]  [Continue here…]
```

- Clicking your own line opens it as today.
- A discussion that exists only on another node shows only that node's line.
- **Peers** section at the bottom: each node's name, address, a reachable/unreachable dot, and
  the room pairing state ("paired", or **Pair with Pi…** when not yet paired; see G).

## C. Bottom bar while viewing another node's line
The message box is replaced by a read-only bar:
"Pi's line, round 12, received 14:32. Read-only." with the buttons
**Continue here from this round…** and **Back to Mac's line**.

Summarize and agent controls are hidden while viewing. Usage, Restart and Quit stay.

Viewing does not stop a running local round or worker. Keep local execution visible separately.
Hide Back to Mac's line when no local line exists. Pin the viewed commit; identify newly received
rounds separately rather than silently changing the selected snapshot.

## D. "Continue here…" panel (in-page, never a browser dialog)
The panel computes the case before you confirm and says it in plain words:

Wait for local writers before checkpointing. If preserving dirty work changes the predicted
case, show the new case before confirmation. The source commit remains pinned throughout.

| Case | Panel text | Button |
|---|---|---|
| Mac is behind, or has no line yet | "Mac's line will move forward to Pi's round 12, and you continue here." | **Continue here** |
| Mac already contains it | "Mac's line already includes Pi's round 12. You continue Mac's line (round 14)." | **Continue here** |
| Both have new rounds | "Reconciliation required: Mac and Pi each have rounds the other doesn't. Nothing will be changed." | **Show both lines** (goes to E) |

The panel always adds:
- If Mac's folder has uncommitted edits: "Mac's unsaved changes will first be saved as an
  interrupted round."
- The other node's live activity, for example: "Pi is running a round right now. It will keep
  going independently; continuing here doesn't stop it."
- The Project context of both nodes, if they differ.

## E. Reconciliation required
This view shows the two lines side by side from their last common round: each line's rounds,
with their summaries, and which notes and drawings each line changed. The options never
discard anything:
- **Continue Mac's own line:** the other line stays in history.
- **Accept this line as reconciled…:** an in-page confirmation pins both commits and states:
  "Keep Mac's current discussion files. Record Pi's selected round as accounted for."
  Confirm / Cancel. Confirmation creates an ancestry-only merge with the local tree unchanged;
  it never claims content was reviewed automatically. Newer Pi rounds are not acknowledged.
- **Fork from Pi's line…:** starts a new discussion from Pi's round, with a new ID and origin metadata.
- A hint: "To combine them, ask the agents in Mac's line to read Pi's rounds and write a
  combined round." That step is manual for now.

The row in the Discussions pane keeps a small **needs reconciliation** badge until a later
Continue here finds no divergence.

If there is no common ancestor, say so. A manually combined round does not itself merge Git
ancestry; no automatic merge/ref update is implied by the hint above.

## F. End of a round: commit and send
These status lines appear in the conversation, like today's end-of-round line:
- `Round 14 saved · sent to Pi ✓`
- `Round 14 saved · Pi unreachable, will send when it's back`
- `Round 14 saved as interrupted (error: …)` for a failed round
- `Could not save round: …` if capture or Git commit fails; never mark that round sent.
  The isolated worker does not delay room discussion snapshots.

## G. Setup: startup output and pairing
Startup output:
```
agent-room on Pi, listening on 0.0.0.0:5566
  open:  http://192.168.1.20:5566/__room
  peers: Mac 192.168.1.12:5566 (reachable, paired)
```
**Pair with Mac…** (in the Peers section) shows both nodes' room folders and asks you to
confirm that they are the same project. On a room-ID mismatch it refuses with an explanation,
and nothing is replaced.

## H. Local worker
Show its worktree path, source branch and base commit. Worker execution and notes stay local;
replication does not capture its worktree. In non-Git projects disable execution and explain:
"Worker requires a source Git repository for its isolated worktree." Discussion remains usable.

## I. New discussion button, and getting back to earlier ones (requested by the User, 2026-11-07)
**Today** (README, "Discussions"): a new discussion starts only with the first message of a
room. Going back uses **Re-open this discussion** or `/reopen`. There is no button to start a
new one.

**Approved by the User (2026-11-07):**
- A **New discussion** button at the top of the Discussions pane, plus `/new` as the command.
  It works between rounds. It ends this room's current session the same way Re-open does today:
  the transcript is kept and closed, the chat clears (a second click confirms), and the
  discussion agents get fresh sessions. The worker is not affected.
- Your next message gets a title, as today, creates the new discussion folder, and makes it the
  **active** discussion on this node. Under replication it becomes this node's line
  `<node>/<new-discussion>`.
- **Getting back:** the earlier discussion stays at the top of the Discussions pane's *Active*
  list, with a **Re-open** button directly on its row (today you open its page first). After
  switching, the header shows a link, **← back to "<previous title>"**, until the next round
  starts. Re-opening an earlier discussion asks for confirmation like New discussion does.
- **Stage:** this is local behaviour, useful without any distribution, so it's proposed as
  stage 0 in [rollout.md](rollout.md), before worker isolation.

**Answers to the worker's questions (approved by the User, 2026-11-07):**
- *List position:* keep today's newest-first sorting (`src/docs.mjs:448`), with no pinning.
  Getting back uses the **← back to "…"** header link plus a **Re-open** button on every row,
  reusing Re-open's existing two-click confirmation (`src/docs.mjs:480`). This replaces the
  "stays at the top" wording above.
- *Worker after New discussion:* no reset. A task already running keeps its original target.
  The next instruction gets the new discussion's folder explicitly, once that folder exists. The
  worker's log stays visible and its provider session is kept, and the switch is marked in the
  log. Before the folder exists, no discussion folder is given for new notes. The worker still
  has its project working directory and its earlier task context.
- *Baseline:* the User approved committing the existing `--dev` work first, so stage 0 starts
  from a clean checkout. The worker must not stash or commit it on its own initiative.

## Approved setup
The User approved the node/peer flags, explicit pairing, isolated local worker, Fork from here
and Accept this line as reconciled. On 2026-11-07 the User approved section I (New discussion) and
building it first, as stage 0.
