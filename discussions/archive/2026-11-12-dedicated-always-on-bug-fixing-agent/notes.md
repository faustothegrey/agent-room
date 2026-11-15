# A dedicated bug-fixing agent

## Decided (User, 2026-11-12)
- No new special agent. Bugs in agent-room go to a **dedicated bugs discussion**, a normal
  discussion kept open alongside other work, whose own worker investigates and prepares fixes
  in its worktree for review and merge.

## Proposed (Claude, Codex)
- Use it by hand for a while before building anything. Note what gets in the way, for example:
  copying a bug's context (screenshot, steps), waiting for the round to end before reporting,
  merging the fix branch while other work goes on.
- "Always available" means a session ready to receive requests, not one running continuously.

## Open questions for the User
- Does it act only on bugs you report, or also look for bugs itself?
- Do you need to report a bug during an agent's turn, or is sending it when the round ends enough?

## Caveats (assumed, from the README)
- Fixes change the server the room runs in: some apply with Reload, others need Restart.
- Its worker tasks count toward the limit of two worker tasks running at once.
