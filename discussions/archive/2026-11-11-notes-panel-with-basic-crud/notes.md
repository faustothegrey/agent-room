# Notes panel with basic CRUD

## Decided (by the User)
- One set of notes per room. Agents don't need to read them; the User turns notes into discussions when wanted.
- A foldable pane in the Terminal's place; only one of Notes and Terminal is open at a time. Opening Notes ends a running Terminal shell: accepted.
- Notes appear only in pages opened on this computer, for now.
- Saved only on Save; Remove asks for confirmation (inside the pane).
- Warn before discarding unsaved changes.
- The new module `src/notes.mjs` is accepted (2026-11-11).

## Built (worker, on `worker/main`, not yet merged)
- `8dd6077` Notes pane (`src/notes.mjs` new, `src/docs.mjs`, `README.md`, `test/notes.test.mjs`). Storage: `~/.local/share/agent-room/notes/<sha256 of room folder>/`, one `.md` file per note named by time + random letters.
- `fd4dd78` Save/read answers tied to the editing session; tooltip wording corrected.
- `ebee0c1` Remove answers tied to the editing session.
- Worker reports: `npm test` 170/170; delayed-answer cases tried in Chrome.

## Known limit (User decided, 2026-11-11: document, don't fix)
- Text typed into a note between confirming Remove and the server's answer is lost when the removal succeeds. The window is the local server's response time (assumed milliseconds; unmeasured).

## Not checked
- The browser's leave-page warning; the page opened as `localhost` or `[::1]`; Notes hidden on another device; a failed Remove answering in a later session.
- "one server, two rooms: … Quit room ends only one" failed once during the parser-fix run (`ab7fb6e`), then passed; cause unconfirmed.

## Status
- 2026-11-11: the User merged, tested the basic workflow and approved it. The "Not checked" cases above were not reported on individually.
