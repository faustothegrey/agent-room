# Working on agent-room

This project replaced AgentTalk on 2026-10-18 because AgentTalk collapsed under its own
infrastructure. **The goal: agent-room helps a human and multiple AI agents discuss and revise
ideas around a shared document or drawing, keeping the conversation and its subject visible
together. Keep it small enough to read in one sitting.** Before adding a module, a dependency, a
config system or a process, ask the owner whether the problem actually needs it.

**Brainstorming agents** (the agents agent-room starts in a room) follow
`README-for-brainstorming-agents.md`: it is their main reference, sent to them as system
instructions by the harness. It is **not** your rulebook: if you are working on agent-room's
code, edit that file like any other source and follow these instructions instead.

1. **Report real output.** Never say something passed without running it and reading the result.
2. **Small diffs.** Change only what the task needs.
3. **Tests are contracts.** Don't weaken or rewrite a test to make it pass; ask first.
4. **Ask before changing behaviour** that the owner relies on, including fixing a bug you found.
5. **Done** means it works as asked, `npm test` is green, and you said honestly what you didn't check.
