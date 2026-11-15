# Pending worker instructions

## Show the unreachable reason in the Peers panel (draft by Claude, not sent)

"In the page's Peers panel, when a peer is unreachable, show the reason after the time, e.g. `unreachable since 14:02: http://127.0.0.1:5566 answers as charon, not Mac`. The reason is already in each peer's `error` field of the replica status (`src/ui.mjs:1066`); only the rendering in `src/docs.mjs` (`peerActivity`, around line 471) should change. Don't change replication behavior or the terminal log. Add or extend a test for the rendered text, run `npm test`, and report its real output."
