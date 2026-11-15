# Charon pairing shows the Mac unreachable (completed 2026-11-07)

## Problem
After pairing (started from the Mac), charon showed the Mac as "paired" but "unreachable".

## What was learned (tested in this session, from the code)
- Pairing requests travel only from the asking side (the Mac) to the other (charon); both sides
  record the pairing, but charon's ability to reach the Mac is not tested by pairing
  (`src/replicate.mjs:545-565`).
- Charon reaches the Mac at the URL in its own `--peer Mac=…`; if the peer answers with another
  node name, it is reported unreachable (`src/replicate.mjs:602`).
- `curl http://127.0.0.1:…` on charon reaches charon itself (`"node":"charon"`), not the Mac.
- agent-room listens on `0.0.0.0` (`src/ui.mjs:967`), so "listening only locally" is not a cause.

## Outcome (reported by the User)
- Charon now shows the Mac connected and receives this discussion's rounds.
- A round from charon was sent, and the Mac lists charon's discussion under received lines.
- **The cause of the original problem is unknown.** Any recurrence gets its own discussion.

## Likely explanation (Claude, from the code, not tested)
The side that accepts a pairing (charon) saves it but doesn't restart its own check of the asking
peer: `acceptPairing` calls `r.changed()` but not `kick()` (`src/replicate.mjs:531-544`), while
`pair()` on the asking side does (`:563`). If charon's check had failed earlier (e.g. the Mac's
room wasn't running yet), its retry delay doubles up to 5 minutes (`:589`), so "unreachable" can
stay on screen for up to 5 minutes after a successful pairing, then clear by itself, which matches
"fixed without knowing why". Unconfirmed; would need a test pairing to check.

## Decided (by the User)
- Show why a peer is unreachable in the Peers panel: continued in
  `discussions/2026-11-07-peers-panel-unreachable-reason/`.
- Close this discussion as completed.

## Not adopted
- A warning for `--peer` URLs on `localhost`/`127.0.0.1` (Claude): Codex pointed out that two
  rooms on one machine or a local tunnel use them legitimately.
