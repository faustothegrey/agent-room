# Implementation notes: brainstorming mode (worker, 2026-11-09)

Uncommitted on `worker/main`, in `/Users/fausto/Software/agent-room.worker`.

## How it works
- One flag, `ctx.state.brainstorm`. It lives in the conversation state that already survives
  Reload, so the brainstorm's messages and its mode survive a Reload and a page refresh. Restart
  passes no brainstorm, so Restart and Quit lose it.
- `/brainstorm` (Actions ▾ → **New brainstorm**, two clicks once a session has started) ends the
  discussion session in use, or the current brainstorm, as `/new` does. It sets the flag and the
  agents' first-prompt briefing ("This is a brainstorm, not a discussion: …write no files; you
  may read the project…").
- With the flag set, a message never opens a discussion, and the transcript writer keeps nothing
  (not even in memory for a later transcript).
- `/new` and `/reopen` end the brainstorm. Resume replaces it too (see the follow-up below).
- Summary prompt in a brainstorm: the same format, but the sentence about `pending-instructions.md`
  becomes "Quote its latest version word for word when it is the Next step."
- Page: the header title reads **Brainstorm**; Pause is hidden; New discussion is offered;
  Explorer shows "A brainstorm is in progress: nothing of it is saved. New discussion or Re-open
  ends it."

## Files
`src/ui.mjs`, `src/room.mjs`, `src/docs.mjs`, `README.md`, `README-for-brainstorming-agents.md`,
`test/ui.test.mjs` (4 tests), `test/room.test.mjs` (1 test).

## Follow-up: Resume during a brainstorm
- `/resume` and Explorer's Resume buttons replace a brainstorm with the paused discussion. The
  saved Pause is checked and loaded first; a missing or invalid one leaves the brainstorm and its
  messages untouched, with the error.
- When the brainstorm has messages, the Resume buttons (Paused on this machine, and the paused
  discussion's page) take two clicks: "Click again: the brainstorm will be discarded".
- During a real discussion, Resume still refuses with the old wording.
