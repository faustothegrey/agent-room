# Bugs

## Decided (User, 2026-11-12)
- This discussion is the bugs discussion. It stays open alongside other work, and its own
  worker prepares the fixes in its worktree for you to review and merge.
- Try it by hand first. Note what gets in the way before building anything.

## Bugs
### 1. Brainstorming Claude has no shell (reported 2026-11-13)
- What you saw: Claude says "it has no shell".
- Finding (tested, by reading the code): this is on purpose, not a bug. `src/agents.mjs:15-24`
  gives brainstorming Claude only file, web, sub-agent and Chrome tools. Bash is added only for
  a Claude worker (`shell: true`, line 149). README line 673 documents this. Codex, by contrast,
  runs with no sandbox, so it already has a shell.
- Options (Claude): give it all of Bash, give it only some commands, or leave it as it is.
- Caveat (Codex; Claude, from memory, not checked): rules that allow only some commands are
  fragile. Treat them as a convenience, not a safeguard. In practice the choice is full Bash
  (like Codex) or no change.
- Decided (User, 2026-11-13): full Bash, like Codex.
- State: merged (`6b67799`, 2026-11-13). Tested live: brainstorming Claude ran `git log` with Bash.

<!-- One entry per bug: what you saw (steps, screenshot in drawings/), its state
     (reported / sent to worker / fix ready / merged), and the worker instruction while unsent.
     Proposed by Claude; change it freely once real bugs arrive. -->

## Friction noticed while using it
None yet.

## Open questions for the User
- Should it fix only the bugs you report, or also look for bugs itself?
- Is it enough to report a bug when the round ends, or do you need to report one while an agent is mid-turn?
