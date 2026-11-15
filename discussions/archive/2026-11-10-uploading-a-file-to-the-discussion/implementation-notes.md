# Attachments: implementation notes (worker)

Implemented on `worker/main` (see the commit labelled `[2026-11-10-uploading-a-file-to-the-discussion]`).

- **Transport:** the page sends the files base64-encoded inside the `/__say` JSON body
  (`{ text, files: [{ name, data }] }`). This keeps the existing same-page check (JSON only, own host).
  No new endpoint, no new dependency.
- **Server (`src/docs.mjs`):** `saveAttachments` writes into `<discussion>/files/`, creating it if
  missing, using the `wx` flag so nothing is ever overwritten (`name-2.ext`, `name-3.ext`, …). Only the
  base name is kept. It is all or nothing: on any failure, the files this call saved are removed. If the room refuses the message (a
  warning), the saved files are removed too. Then `Attached: files/a.png, files/b.pdf` is appended
  to the text and handed to the room like any message.
- **Limits:** 25 MB per file (checked on the page and on the server). The page and server also cap
  one message at 250 MB in total, which is my addition: the JSON body is read into memory.
- **Choices I made (not in the instruction):**
  - The button is shown but disabled in a new discussion before its first message: its folder
    doesn't exist until then, because the title is chosen from that message.
  - Attachments with a `/command` are refused.
  - A message may be attachments only (empty text).
- **Not done:** drag-and-drop and paste (as asked). A message without attachments still clears the
  box at once, as before.
