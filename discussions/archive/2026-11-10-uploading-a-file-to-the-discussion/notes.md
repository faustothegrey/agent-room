# Uploading a file to the discussion

## Current state (tested by reading code, 2026-11-10)
- No upload, file picker, drag-and-drop or paste handling in agent-room's UI (`README.md`, `src/` searched).
- Workaround today: copy the file into the discussion folder by hand and name it in a message.

## Decided (by the User, 2026-11-10)
- Any file type is allowed.
- Files are stored in `files/` inside the discussion.
- Files are attached to text messages (no upload-triggered turn).
- Simplest possible first version: a file button only; 25 MB cap accepted ("OK").
- Duplicate names are renamed automatically.
- No file upload in brainstorms for now.
- Built by the Worker (d7491a7 on `worker/main`). Accepted: Attach works only after a discussion's
  first message; 250 MB total per message; no attachments on `/command`; attachment-only messages.
- Remaining: the User's merge or Reload, then a live upload trial.

Draft Worker instruction: `pending-instructions.md`.

## Proposed (by agents)
- **Attach to next message, not auto-turn** (Codex; Claude agrees). Choosing a file shows it beside the
  composer; the User sends it with an instruction. Several files can be attached before sending.
- **Pending attachment is removable** before sending (Codex).
- **Send only after the file is saved**; on failure keep message and attachment in the composer and
  show the error, so no message ever names a missing file (Codex).
- **First version: a file button only**; drag-and-drop and screenshot paste later if needed (Codex).
- **Store in `files/` inside the discussion**, next to `drawings/`, so it is the one copy and moves
  with the discussion on archive/defer (Claude).
- **The sent message records the saved path** (e.g. `files/sketch.png`), so the transcript and later
  sessions can find it (Claude).
- **Scope: discussions only**; brainstorm uploads left open (Codex; Claude suggested "no uploads in
  brainstorms" for now).

## Open questions for the User
1. ~~File types~~ — decided: any.
2. ~~Storage place~~ — decided: `files/`.
3. Size limit? What happens when a file with the same name exists (rename, replace, ask)?
4. Brainstorms: no uploads, temporary folder, or link to an existing project file?
5. Is a file button enough for the first version, or do you need paste (e.g. screenshots) too?

## Unresolved disagreements
- None so far.
