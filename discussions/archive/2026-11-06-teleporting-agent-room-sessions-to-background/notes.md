# Teleporting an agent-room discussion to continue in the background

## Decided (by the User)
- The User likes local CLI instances because the models get a real harness.
- "Background" means **unattended**, but only the **discussion** continues; implementation
  work is left out.
- Candidate hosts: a Raspberry Pi 4, or an old PC with 8 GB of memory that overheats badly.
- The Pi runs 64-bit ARM (aarch64) Debian 13 (Trixie), with 4 GB of memory, 2.4 GB of it free.

- One round is more than enough for the first trial.
- The long-term aim is a workflow that moves seamlessly between devices. **For now, a
  distributed or mirrored discussion is enough.**
- For now only the Mac connects to the room; more devices later.
- **Ownership rule (the User's proposal, 2026-11-06):** the node that creates a discussion
  owns it by default. Another node is ready to take over whenever the owner stops, but only
  with the User's explicit consent; after that consent, the new node becomes the owner. When
  the old owner reconnects, it follows the discussion as a secondary until the User explicitly
  changes the owner again.
- Split-brain cases are possible but rare on a LAN. **Most important: the owning node and the
  working node are clearly shown in the UI, and recorded in the discussion's metadata.**

## Trial architecture (proposed by Claude): see `drawings/trial-architecture.svg`
- Nothing new to build: the existing room, git and an SSH tunnel.
- The room server listens only on `127.0.0.1` and accepts only a `127.0.0.1`/`localhost` host
  (`src/ui.mjs:694`, `src/docs.mjs:775`). An SSH tunnel
  (`ssh -L 5566:127.0.0.1:5566 pi`) reaches it without changing that.
  *Assumed, untested:* the host check passes through the tunnel.
- Steps: (1) on the Mac, write the handoff, commit, push, and stop the local room; (2) on the
  Pi, pull and run `npm start -- --reopen <name>` inside tmux; (3) open the tunnel, send the
  bounded instruction, close the laptop; (4) one round runs on the Pi while you measure memory;
  (5) later, open the tunnel again or pull the Pi's commit.
- Three separate paths (Codex): files go Mac → git → Pi, and only when moving the discussion;
  your controls go browser → tunnel → room; agent turns go room → CLIs → providers. After the
  instruction is sent, the Mac can disconnect, and closing the browser doesn't stop the room
  (Codex, read in the source; untested end to end).
- `npm start` moves to another port if 5566 is taken, so check the port the Pi actually chose
  and open `http://127.0.0.1:5566/__room` through the tunnel (Codex).
- On the Pi, Claude agents have no Chrome tools, which doesn't matter for a discussion.

## Automating the transfer (proposed, after the manual trial)
- **A "Continue on Pi" action** (Claude, Codex): one command that scripts the steps. Order
  (Codex corrected Claude): wait for any active turn to finish, pause the local discussion, have
  the agents write the handoff, push, start the room on the Pi, confirm it has loaded the
  handoff, then show "Running on Pi". If anything fails, the local discussion stays available
  and the failure is reported. This adds SSH and git pushing to agent-room, and it only works in
  one direction.
- **Transferring automatically when the laptop sleeps** is unreliable: sleep may cut the
  network before the transfer finishes (Codex).
- **Middle option: choose where a discussion runs when you open it** (Codex): "Start on Pi"
  opens the tunnel, starts or reconnects to the Pi's room and opens its page; "Start locally"
  keeps the Mac's tools. There is no live migration, but a discussion started locally still
  needs "Continue on Pi" before you leave. This could be a second launcher next to the Dock app
  (Claude).
- **Alternative: the room always runs on the Pi** (Claude, Codex): there is nothing to
  transfer, and closing the lid needs no action. The costs: no Chrome tools for Claude agents,
  the Pi's 4 GB memory limit, and a project checkout on the Pi.

## Pi compatibility (checked by Claude, 2026-11-06)
- **Claude Code:** supports Debian 10+ on ARM64, but asks for "4 GB+ RAM" (documented:
  [setup](https://code.claude.com/docs/en/setup)). The Pi has exactly 4 GB, so it is at the
  minimum.
- **Codex CLI:** the official releases include an aarch64 Linux binary (documented:
  [openai/codex](https://github.com/openai/codex)).
- **What the room needs at once:** the room's Node server, plus one Claude process and one Codex
  process during their turns. Actual memory use is unmeasured.
- Official builds exist, but installing and running them on this Pi is **untested** (Codex
  corrected Claude).
- **Measurement proposed** (Codex): run one round with both agents active. Record the lowest
  *available* memory (not "free", since Linux uses spare RAM for caches it can reclaim), swap
  use, and whether either CLI exits or stops responding. Don't assume the other 1.6 GB can be
  freed: it may be used by services you want to keep.

## Proposed (by agents)
- **The discussion travels, not the CLI sessions** (Codex, agreed by Claude). What moves is its
  document or drawing, conversation, decisions, open questions and next task. Resuming provider
  sessions (`~/.claude/projects`, `~/.codex/sessions`) is an optional extra. *Assumed, untested:*
  resuming needs the same working-directory path.
- **Bounded background work** (Codex): "continue on my server, do X, then stop", so it can't
  run up an open-ended conversation budget.
- **One owner at a time** (Codex): only one location advances a discussion. Renaming
  `handoff.md` does **not** enforce this, because two copies can each read and rename their own
  file (Codex corrected Claude on this). For a manual trial, stop the source room first.
- **First trial by hand, no code** (Claude): on an always-on machine, write the handoff, push via
  git, then `/reopen` there with a bounded task.
- **Three checks for the trial** (Codex):
  1. The receiving agents can explain the current decision and the next task without the User
     repeating context.
  2. They can use the project's actual tools and credentials.
  3. On return, the User can quickly see their changes, remaining questions and why they stopped.

- **Stopping: reuse the existing rules** (Codex): all agents pass in a row, with 8 turns as
  the backstop. A question for the User doesn't stop the round (Codex corrected Claude): agents
  record it and keep going on points that don't depend on the answer. Suggested instruction:
  "Continue discussing this proposal. Record alternatives, disagreements and questions for me.
  Don't make decisions on my behalf. Use the normal turn limit, then stop." Agents may only
  update the discussion's notes and drawings.
- **Practical consequence** (Claude): under these rules, an unattended run is one round of at
  most 8 turns, roughly the length of one exchange here. Running longer would need several
  rounds, which means a new rule. Duration is unmeasured.
- **Possible later rule for longer runs** (Codex): when a round hits the 8-turn limit, start
  another one, within an overall budget. Stop when everyone passes, since that means no one has
  anything useful left to add. The first trial uses one ordinary round.
- **What the trial should show** (Codex): you can leave right after sending the instruction and
  come back to a useful discussion record.
- **Test the handoff locally first** (Codex), separately from checking the Pi.

## Mirrored discussion: first step (proposed, awaiting the User)
Drawing: `drawings/pi-hosted-room.svg`. It replaces `drawings/trial-architecture.svg`, whose
git transfer is no longer needed.
- **One room on the Pi, open from any device** (Codex): seeing the discussion live needs no file
  sync, because every browser connects to the same room. A Pi → Mac file copy is optional,
  for reading while offline.
- A Pi copy of a discussion hosted on the Mac could be used to restart it later; it just can't
  continue by itself (Codex corrected Claude).
- **Reaching the room from each device** (Claude): today this needs an SSH tunnel per device,
  which is easy on the Mac and awkward on a phone. Letting the room accept connections from more
  than `127.0.0.1`, for example over a private network such as Tailscale, would change a
  deliberate security limit (README, "Access and limits"). That is a decision for the User.
- Correction (Codex): a private network doesn't require that change. You can use it to reach
  the Pi over SSH and tunnel as before. Opening the room directly in a phone's browser is a
  separate step: it needs a protected way to expose the room and support for its host checks,
  not just a different listening address. First test: a Mac → Pi tunnel, with no changes to
  agent-room.

## Step 2, running the CLIs remotely: Rex (suggested by the User)
Read by Claude on 2026-11-06 (documented: [CLI](https://www.superlogical.com/rex/docs/automate/cli),
[remote access](https://www.superlogical.com/rex/docs/linux/remote-access.md),
[Linux install](https://www.superlogical.com/rex/docs/linux/installation.md),
[server API](https://www.superlogical.com/rex/docs/automate/server-api.md)):
- **What it is:** a terminal multiplexer with a server that keeps sessions running "whether or
  not anything is looking at it", plus Mac and iOS app clients. It's like tmux with remote
  hosts.
- **Platforms:** the Linux server is in testing (no stable release yet). It ships for x86-64
  and ARM64 Debian/Ubuntu and needs glibc 2.26+. The Pi is probably fine but untested.
- **Remote:** by default it uses local Unix sockets only. Remote access goes through Tailscale,
  a VPN or an SSH-forwarded socket. Access is decided only by how you connect, and a connection
  "can do anything that server can". Proper authentication is planned.
- **Fit for agent-room** (Claude): agent-room starts CLI processes and reads their output and
  exit codes. Rex works with terminal *screens* (`rex send` types into one, `rex capture` reads
  one). Its documented API has no "start a process and stream its output" call. As a way to run
  the CLIs remotely it looks like a mismatch; plain `ssh mac claude …` gives a real output
  stream. It does look useful for the *viewing* side: it could replace tmux, and its iOS app
  could cover the "more devices later" step.
- Not documented: price, licence, whether it is open source.
- **Correction** (Codex): `rex run --wait -- COMMAND` starts a program, also on a remote server
  with `-S`, and returns its exit status. So Rex does more than drive screens.
- **Checked by Claude** ([CLI reference](https://www.superlogical.com/rex/docs/reference/cli.md)):
  the command runs "in a new terminal block". The docs say nothing about passing its
  stdout/stderr back to the caller, and the documented way to read it is `rex capture` (screen
  plus scrollback). Exit status: yes; exact output: not documented. A workaround (writing the
  output to a file on the remote machine) would still need SSH or sync to fetch it.
- **Two possible uses** (Codex): (a) run the whole agent-room inside a Rex session on the Pi
  instead of tmux, which fits the current proposal; (b) launch individual remote agents
  through Rex, which needs an experiment covering input, exact output, exit status,
  cancellation and reconnection. Neither moves a running process between machines.

## The User's idea: an agent-room server on every node (2026-11-06)
- **The User:** each node in the cluster runs its own server; the servers synchronize the
  discussion between them, and may run CLIs on other hosts through Rex.
- **Claude's view:** this works if each discussion has **exactly one owner node** at a time.
  The owner runs the turns and writes the files; the other nodes keep read-only copies and
  forward your messages to the owner. "Teleporting" a discussion then means handing over its
  ownership. Several nodes writing the same discussion at once would need consensus algorithms,
  which is far too big for agent-room. The hard case is an owner that vanishes mid-round: either
  wait until it returns (safe), or use a time-limited ownership claim and reject the old owner's
  late writes (automatic, but more machinery). The Pi-hosted room is the first stage of this
  design. Drawing: `drawings/cluster-one-owner-per-discussion.svg`, render unchecked.
- **Three separate jobs** (Codex): *replication* (send finished messages and file changes to
  the other nodes), *ownership* (which node may advance a discussion), *execution* (where a CLI
  runs, possibly through Rex). Rex covers only execution.
- **Correction** (Codex): a time limit alone isn't safe. The old owner must actually be
  unable to publish its changes. Claude adds: that means every node refuses changes stamped
  with an old ownership number, so a node that wakes up still believing it owns the discussion
  is ignored.
- **Small first version** (Codex, agreed by Claude): servers sync automatically, and ownership
  changes only between rounds, explicitly. The receiving node confirms it has the latest
  copy before the old one gives up ownership. If either node disappears during the handover,
  the discussion pauses rather than guessing.
- **Correction** (Codex): ownership numbers reject stale changes, but they don't decide who may
  hand out the next number. If the nodes lose contact, each could promote itself. Taking over
  from an owner that disappeared needs a trusted authority, or a recovery step that makes sure
  the old owner can't keep publishing.
- **First version, in three behaviours** (Codex): read copies locally; continue after a
  confirmed transfer; pause if the owner disappears without transferring.
- **A possible authority** (Claude, proposal): with just Mac + Pi, the always-on Pi could be the
  authority that hands out ownership numbers. "The Mac vanished, so the Pi takes over" then
  becomes possible; "the Pi vanished, so the Mac takes over" stays a pause. It's lopsided, but
  it matches the closed-laptop case.
- **Condition** (Codex): the Pi must *approve each change*, not just hand out numbers. While cut
  off, the Mac's results (messages and file edits) are only provisional; the Pi accepts them
  only if that turn still belongs to the Mac. So the Mac can run agents, but it can't advance
  the authoritative discussion while the Pi is unreachable. This is a later option (Claude,
  Codex).

- **What the User's ownership rule means** (Claude): your consent is the trusted authority,
  which settles who may hand out the next ownership number. One case remains. The other node
  can't tell "stopped" from "unreachable", so an old owner that is only cut off may keep
  running a round. When it reconnects, it must learn it's now secondary *before* publishing,
  and whatever it did after the takeover is not part of the discussion.
- **Consent prompt** (Codex): show "Mac is unreachable" and "Latest copied message: …", so
  you approve knowing how recent the copy is, without claiming the Mac has stopped. The
  takeover starts from the latest complete copy.
- **Orphaned turns** (Codex's proposal): each ownership period is a separate history. The
  reconnected old owner keeps its divergent work separately for review and never merges it
  automatically. (One possible answer to the open question below; the decision is the User's.)

- **Showing the owner** (Claude, proposal):
  - Metadata: one small file in the discussion's folder, for example `owner.json` containing
    `{ "owner": "pi", "since": "2026-11-06T14:32", "number": 2, "agentsRunOn": "pi" }`. It is
    copied with the discussion, so every node sees the same record. Today discussions have no
    metadata file; their status comes from the folder they're in.
  - UI: on the owner, the header shows "Owner: this node (Pi) · agents run on Pi". On a
    secondary, it shows "Following Pi · read-only · last copy 14:32", with the message box
    disabled and a "Take over here" button. The Discussions pane's existing status badges
    could add an owner badge.
  - **Refined** (Codex, agreed by Claude): show three things: *viewing on* (this browser's
    server), *owner* (copied metadata), and *where each agent runs* (per agent, so no single
    `agentsRunOn` field; this is a live observation, not stored). On a secondary, show "Last
    synchronized …", and show execution as "unknown" when it can't be checked. Copied metadata
    reaches nodes *eventually*: when the owner can't be reached, show "Owner: Pi · connection
    lost", never "owner ended". Rare conflicts are reported for manual resolution.
  - **Messages typed on a secondary** (Codex, supported by Claude): forward them to the owner,
    with the box labelled "Send to Pi". A message counts as sent only after the owner
    acknowledges it. If the owner is unreachable, the text stays as a local draft (no silent
    queue), and taking over is offered separately. Where you view or type never changes the
    owner. The ownership rule also works with read-only secondaries; the choice is the User's.
  - Mock of the three header states: `drawings/owner-header-mock.svg` (render unchecked).

## Passive secondaries and detecting divergence (after the User's message, 2026-11-06)
- The User pictures secondaries as **purely passive**. They want divergent work to be
  **detected deterministically**; how to reconcile it can be investigated later. They expect
  divergence to be rare, or the architecture becomes unmanageable.
- **Use case for typing on a secondary** (Claude): only convenience, so you can reply from
  whichever node's page is open. A passive secondary with an **"Open on Pi"** link to the
  owner's page covers that need, with no forwarding.
- **Deterministic detection** (Claude, proposal):
  - Every turn the owner publishes is stamped `(ownership number, turn number)`, e.g. `2:41`.
  - The takeover record states where the new owner started: "ownership 3 starts after `2:41`".
  - When the old owner reconnects, it compares: if it holds any entry with ownership number 2
    after `2:41` (e.g. `2:42`, `2:43`), that work diverged, and exactly those turns are the
    divergent ones. If it doesn't, there is no divergence. Comparing numbers involves no
    guessing.
  - To cover file edits too, each turn also stores a fingerprint (hash) of the discussion folder
    after that turn. This works only if, as decided, nothing but the owner's turns edits the
    files.

- **Correction** (Codex, accepted by Claude): turn numbering misses an interrupted turn that
  had already edited files without publishing, as well as manual edits. Instead, compare
  against the **takeover snapshot**: the last copied turn plus a manifest of every file's path
  and content hash. When the old owner reconnects, and before anything is replaced, flag any
  extra turns and any changed, added or deleted files, and keep that copy for later. Compare
  with the snapshot, not with the new owner's current files, which are expected to differ.
  Until the old owner has reconnected and been checked, its status is "former owner not
  checked".
- Count divergences separately from ordinary takeovers, to test the "rare" expectation.

## Unresolved disagreements
- None at the moment.

## Open questions for the User
- If the old owner kept going while it was cut off, what happens to those turns when it
  reconnects: discard them silently, or show them to you separately so you can copy anything
  useful?
- When a device is unavailable, should the other device be able to open its local copy and
  *continue* the discussion, or only read it? (This decides how much coordination is needed.)

## Fully automatic synchronization (the User's request, 2026-11-06)
- The User wants fully automatic synchronization: apart from the agents' internal state, a
  discussion is just files. Checked by Claude: the transcript is appended to its file after
  every message (`src/ui.mjs:147`). Whose turn it is lives only in the running process.
- **Two separate needs** (Codex): automatic *synchronization* (files arrive on their own) and
  automatic *continuation* (the Pi knows when it may speak). The first doesn't provide the
  second, and an "owner" file can't stop a disconnected Mac from continuing on its old copy.
- "Synchronized" must mean *received by the other machine*, not just saved locally (Codex).

## Resolved between agents: one room, on the Pi (awaiting the User)
- Claude proposed that the room that received your last message owns the discussion. Codex
  corrected this: a Mac waking from sleep could carry on in its old process, so there would be
  two competing writers. Claude withdrew the proposal.
- **Current proposal** (Codex, simplified by Claude): one room process, always on the Pi. It
  runs each agent's CLI either on the Pi or on the Mac over SSH (`ssh mac claude …`). With a
  single room there is never a second writer, and syncing is only needed for files edited on
  the Mac.
- **Still to test** (Codex): how fresh agents on the Pi pick up an interrupted discussion,
  and what happens to a Mac CLI's file edits and late output when the connection breaks.
  Claude adds: a CLI run on the Mac edits the Mac's copy of the files, so those edits
  must reach the Pi before the Pi's agents read them.
- **Narrowed further** (Codex, agreed by Claude): a dropped Mac CLI could keep editing while
  its replacement runs on the Pi, so there would still be two file writers. For discussions,
  run **both CLIs on the Pi** and make the Pi the only writer. The Mac keeps an automatically
  synced copy for reading, in one direction only (Syncthing has "send only" and "receive only"
  folders; from memory, untested). Using the Mac's CLIs is a later extension.

## Side item (2026-11-07): browser wording in the brainstorming rulebook
Codex can inspect rendered images and has its own browser tool in this session, so
`README-for-brainstorming-agents.md` is too narrow in tying browser access to Claude. The
sentence "agents without a browser read HTML and Markdown as text only" is still accurate.
Proposed provider-neutral wording (Codex): "Use the browser or rendering tools available in your
session. State whether you inspected source text, a rendered image, or the live page; don't
claim visual verification without inspecting the rendering." This is a separate documentation
change, not part of this proposal. Nothing has been edited.

## Moved from proposal.md on 2026-11-07: the exclusive-ownership design (superseded)
On 2026-11-07 the User chose the git **branch model** (one branch per discussion per node;
Continue here fast-forwards or flags reconciliation). It supersedes:
- **Exclusive ownership:** one owner per discussion, takeover only with consent, former owner
  becomes secondary; ownership record with generations; "one active discussion on the
  network". Under the branch model each node writes only its own branch, so no handover
  protocol is needed.
- **Handover workflows:** connected transfer with acknowledgements, "Transfer incomplete;
  checking Pi's state", takeover from an unreachable owner, durable transfer states.
- **Divergence inspection against a takeover snapshot**, the one-time notice with
  "Discard and follow <owner>", and node-local preserved copies. Divergence is now
  simply two branches with unique commits ("Reconciliation required").
- **Passive secondaries** as a rule for whole nodes. Now *viewing another node's branch* is
  read-only, while each node's own branch is fully usable.
- Earlier open decisions on starting discussions only on the owner, divergent-copy location
  and handover boundary.
- The first UI mock (`drawings/ui-states.svg`, ownership version) and
  `drawings/cluster-one-owner-per-discussion.svg` describe that superseded design.

## Moved from proposal.md on 2026-11-06 (superseded; history only)
*Decision numbers in this section refer to the proposal's numbering at that time, not to the
current list in `proposal.md`.*
Claude consolidated `proposal.md` at Codex's request, so the worker gets one consistent
specification. These parts were superseded by the User's decisions 9–16:
- **Transport options** (Syncthing / rsync over SSH / built into agent-room), Claude's
  preference for rsync over SSH, and Codex's corrections (tools only transport files; Syncthing
  could carry finished snapshots; SSH host names don't choose peers). Superseded by decision 9:
  agent-room servers talk through a small protocol of their own. The guarantees (complete
  snapshots, deletions, preserve before overwriting) moved into the proposal.
- **LAN security alternatives:** a shared secret plus a UI login, or `127.0.0.1` with SSH
  tunnels; Codex and Claude recommended protecting both the UI and the peer protocol.
  Superseded by decisions 13–14: direct access by IP, no authorization, trusted LAN.
- **"Authorize browser" step** (Claude, named by Codex): superseded by decision 14. If
  authorization is added later, keep it separate from "Continue here".
- **Opt-in LAN listening** (Claude), as its own explicit setting separate from peer addresses
  (Codex). Superseded by decision 15: `npm start` binds to `0.0.0.0`.
- **Forwarding messages from secondaries:** dropped by decision 6 (secondaries are passive).
- **`owner.json` with a simple ownership number:** refined in `implementation-plan.md`
  (Codex) into an ownership record with generation IDs and ancestry, because equal numbers
  with different histories must be reported as a conflict.
