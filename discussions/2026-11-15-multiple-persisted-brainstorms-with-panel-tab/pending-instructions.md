# Pending worker instructions

## Catch up persisted brainstorms with main (draft, not sent)

Catch up: merge the current `main` into your branch (it has 9 new commits, including the Members
panel, collapsed Worker lanes and the merge preview). A trial merge reports conflicts in
`README.md`, `src/docs.mjs`, `src/ui.mjs` and `test/ui.test.mjs`: resolve them keeping both
sides' behavior, and don't weaken any test from either side. Then:
1. Add a test in `test/docs.test.mjs` for the Brainstorms tab: its rows and actions, and its own
   order key (`agent-room.brainstorm-order:<folder>`), separate from the Discussions order.
2. Run `npm test` to green and commit on your branch.
3. Report which providers' session resume you actually tested for Turn into a discussion and
   Restart, and which you didn't.
