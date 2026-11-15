# Summary template change

Changed `SUMMARY_FORMAT` in the worker worktree's `src/room.mjs`: Next step gives
exactly one User action, labelled Answer, Send to the Worker or Do. Later lists the
remaining actions in order with their prerequisites. Pending worker instructions
are quoted verbatim for Next step and named under Later, with their full text in
the discussion's `pending-instructions.md`, until confirmed sent, replaced or withdrawn.
The eight-point limit applies to Agreed and Not agreed together.

Updated `test/room.test.mjs` to check every requirement for both the summary drafter
and reviewer, including absence of the two old headings.

Validation: `npm test` exited 0: 102 passed, 0 failed, 0 skipped.
`git diff --check` exited 0. Live provider summaries and browser appearance were
not checked. No commit or merge was made. README was left outside this task's scope.
