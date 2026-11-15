# Peers panel: show why a peer is unreachable

Started from `discussions/2026-11-07-charon-pairing-shows-mac-unreachable/notes.md`.

## Decided (by the User, 2026-11-07)
- The Peers panel should show the reason a peer is unreachable, not only "unreachable since …".

## Evidence (from the code, not yet tested in the UI)
- The page renders only "unreachable since HH:MM" (`src/docs.mjs:471-475`).
- The page already receives the reason as `error` in each peer's status (`src/ui.mjs:1063-1067`);
  today it is printed only in the terminal (`src/ui.mjs:1077`).
- Example reason: `http://127.0.0.1:5566 answers as charon, not Mac` (`src/replicate.mjs:602`).

## Open questions for the User
- Should the reason also show when the peer is reachable but a send was refused (`error` is set
  then too, `src/replicate.mjs:615`)?
- **Separate from the approved display change, not authorized for the worker:** the side that
  accepts a pairing doesn't recheck the asking peer right away (`acceptPairing` calls
  `r.changed()` but not `kick()`, `src/replicate.mjs:531-544`; the asking side's `pair()` does,
  `:563`). After earlier failures its retry wait can reach 5 minutes (`:589`), so a stale
  "unreachable" can stay after a successful pairing. Found from the code (not tested); possibly
  the cause of `discussions/2026-11-07-charon-pairing-shows-mac-unreachable/` (unconfirmed).
  Should the accepting side recheck immediately?

## Draft worker instruction
Not yet sent: see `pending-instructions.md`.
