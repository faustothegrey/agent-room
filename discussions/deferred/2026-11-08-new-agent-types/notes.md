# New agent types

Started 2026-11-08 from `discussions/2026-11-08-multi-room-editing-via-multiple-windows/`.
Created by Claude at the User's request, without making it the active discussion.

## The User's proposal (2026-11-08)
Define new agent types, two or possibly three:

1. **Reflection Agent.** Keeps track of the room it lives in and curates the room's overview and
   main purposes. It reads the transcripts, say every 20 turns of the other agents, and keeps the
   documentation up to date.
2. **Testing Agent**, especially for UI testing.
3. **Improvement Agent**, dedicated to proposing improvements. What "improvement" means will be
   defined iteratively. It might be merged with the Reflection Agent; the User hasn't decided.

## Decided (by the User)
- This topic gets its own discussion (this one), 2026-11-08.

## Proposed (by agents)
(none yet)

## Open questions for the User
- **Reflection Agent:** which documentation may it change by itself (root `README.md`, the
  discussions index, discussion notes), and which only as a proposal for the User to approve?
- **Reflection Agent:** does "every 20 turns" count turns across all discussions in the room, or
  in the current one? Does it run in the background, or take a turn in the conversation?
- **Testing Agent:** what does it test against: the worker's changes before commit, the running
  room, or both? May it click and type in pages (the brainstorming rulebook currently forbids
  that)?
- **Improvement Agent:** improvements to what: the room's subject, agent-room itself, or the way
  the discussion is run?
- Merge Improvement into Reflection, or keep them separate?
- Running costs: each new agent adds model calls. Is there a budget, or a preference for
  occasional runs over continuous ones? (Costs: unmeasured.)

## Related
- `discussions/2026-11-07-room-citizenship-rules/notes.md`: shared rules for every role, plus
  one short section per role. Its open question "Which roles exist now and later?" overlaps
  with this discussion.
- Evidence from 2026-11-08 (multi-room discussion): Codex ran a live two-room test by computer
  control with the User's explicit permission, and a restart interrupts every agent the server
  started, the worker included. Both matter for a Testing Agent.
