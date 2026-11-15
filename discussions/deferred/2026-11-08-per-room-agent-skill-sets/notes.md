# Per-room agent skill sets

Started 2026-11-08 from `discussions/2026-11-08-redesigning-a-messy-project-ui/`.
Created by Claude at the User's request, to be opened later; not the active discussion.

## The User's proposal (2026-11-08)
Each agent, by provider type (Claude, Codex) and by role (discussion agent, worker, others),
should maintain and evolve a skill set that fine-tunes its work within that room. "Work" in the
general sense: discussion, code work, or anything else the room does.

## Decided (by the User)
- This topic gets its own discussion (this one), to be opened later.

## Proposed (by agents)
- (Codex) Tell reusable skills apart from standing room rules and ordinary discussion notes, so
  skills don't become one more growing instruction file every agent must read.
- (Codex) Start from a concrete example before choosing storage or a curator: a technique that
  proved useful (say, reviewing a drawing), and how it becomes a skill, which provider and role
  gets it, and when it is loaded.

## Open questions for the User
- Where do the skills live: in the room (versioned with it, visible to the User) or in each
  provider's own per-project skill folder?
- Who may change a skill: the agent by itself, or only as a proposal the User approves?
- One skill set per provider *and* role (Claude-worker, Codex-discussion, …), or shared skills plus
  short per-provider/per-role parts?
- What prompts a skill to evolve: a User correction, a summary, a failed turn, a periodic review?
- Do skills replicate to peers (charon) with the room, or stay per machine?
- Running costs: skills add text to every turn. Is there a size budget? (Costs: unmeasured.)

## Related
- `discussions/2026-11-08-new-agent-types/notes.md`: the proposed Reflection and Improvement
  agents could be the ones that curate these skills.
- `discussions/2026-11-07-room-citizenship-rules/notes.md`: shared rules for every role plus one
  section per role, a similar shared-plus-specific structure.
- Root rulebooks `README-for-brainstorming-agents.md` and `README-for-worker-agents.md`: today's
  per-role instructions, the same for every room.
