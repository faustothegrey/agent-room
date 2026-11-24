# Working on agent-room

**The goal: agent-room helps a human and multiple AI agents discuss and revise
ideas around a shared document or drawing, keeping the conversation and its subject visible
together. Keep it small enough to read in one sitting.** Before adding a module, a dependency, a
config system or a process, ask the owner whether the problem actually needs it.

The owner (and User in agent-room) is Fausto; agents may address Fausto by name.

Current setup, behavior and the source map are in `README.md`. Remaining decisions and
historical material are in `discussions/` (start at `discussions/README.md`).

**Discussion and brainstorm agents** (the agents agent-room starts in a room) follow
`rulebooks/citizenship.md`, `rulebooks/group-chat.md` and `rulebooks/discussing.md`, joined in
that order and sent to them as system instructions by the harness; **research board agents**
receive `rulebooks/citizenship.md`, `rulebooks/group-chat.md` and `rulebooks/researching.md`.
They are **not** your rulebook: if you are working on agent-room's code, edit those files like any
other source and follow these instructions instead. The separate worker receives
`rulebooks/citizenship.md` followed by `rulebooks/worker.md`; those rulebooks are also source, not
your rulebook.

1. **Report real output.** Never say something passed without running it and reading the result.
2. **Small diffs.** Change only what the task needs.
3. **Tests are contracts.** Don't weaken or rewrite a test to make it pass; ask first.
4. **Ask before changing behaviour** that the owner relies on, including fixing a bug you found.
5. **Done** means it works as asked, `npm test` (the fast suite) is green, and you said honestly what you didn't check.
6. **Fast and slow tests.** `npm test` runs the fast suite (every test not in `test/slow.txt`): run it whenever you run a test suite, and before merging. `npm run test:slow` and `npm run test:all` run only when the User asks. The suite itself moves any test not in `test/slow.txt` that passes in more than 1 s three runs in a row to `test/slow.txt`. Don't edit `test/slow.txt` or `test/.timings.json` by hand: just run the suite you need.
