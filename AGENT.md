# Working on agent-room

This project replaced AgentTalk on 2026-10-18 because AgentTalk collapsed under its own
infrastructure. **The scope is a basic multi-agent conversation. Keep it small enough to read
in one sitting.** Before adding a module, a dependency, a config system or a process, ask the
owner whether the problem actually needs it.

1. **Report real output.** Never say something passed without running it and reading the result.
2. **Small diffs.** Change only what the task needs.
3. **Tests are contracts.** Don't weaken or rewrite a test to make it pass; ask first.
4. **Ask before changing behaviour** that the owner relies on, including fixing a bug you found.
5. **Done** means it works as asked, `npm test` is green, and you said honestly what you didn't check.
