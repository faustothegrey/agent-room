# Room citizenship rules

Started 2026-11-07 from `discussions/2026-11-06-teleporting-agent-room-sessions-to-background/`
(12:28 session; see that discussion's transcripts for what was said). Created by Claude at the
User's request, without making it the active discussion.

## The User's proposal (2026-11-07)
Turn `README-for-brainstorming-agents.md` into a project-specific construct, possibly a
**skill**, that explains to every agent in the room (discussion agents, the worker, future
roles) how to behave, with basic citizenship rules. It needn't be maintained by the worker:
any agent the User authorizes can change it.

## Decided (by the User)
- This topic gets its own discussion (this one), 2026-11-07.

## Proposed (by agents)
- **Shared rules plus role sections** (Claude, Codex): one set of common rules for every role,
  and a short section per role that says clearly what that role may do (for example, discussion
  agents write notes; the worker implements). Sharing rules must not blur those boundaries
  (Codex).
- **Order of work** (Codex, Claude agreed): first agree on the shared content and on who may
  edit it; only then choose how agents receive it.
- **Editing authority** (Claude): discussion agents can already edit root files when the User
  asks, so drafting these rules doesn't need the worker. Changing *how* the harness delivers
  them (`src/ui.mjs:123–124`, `src/room.mjs:33`) is code, and would be worker work.

## Facts so far
- The harness reads both rulebooks from the repository root and sends them as system
  instructions: `src/ui.mjs:123–124` (read in the code by Claude).
- Whether a skill can be reliably required for both Claude and Codex agents: **untested**.
  Claude first said a skill is only loaded when the agent decides to open it; Codex corrected
  that a harness can explicitly require reading it. Codex's skill mechanism: assumed / from
  memory, not checked.

## Open questions for the User
- What is the main aim: shared rules, who may edit them, or the skill mechanism itself? If the
  skill, what should it make possible that a harness-supplied Markdown file doesn't?
- Which roles exist now and later (discussion agent, worker, others)?

## Related, pending in the source discussion
- Summaries restate worker instructions (proposed, awaiting the User's approval as a task after
  A2): it adds a line to the handoff convention in `README-for-brainstorming-agents.md`, so it
  touches the same rulebook.
