# Discussions and document browsing: remaining decisions

Status: documentation reviewed against the code on 2026-11-02. Cleanup approved by the User.
This list preserves unfinished decisions and deferred ideas; cleanup does not authorize implementation.
The original discussions and folder-opening proposals are preserved in
[archive/discussions.md](archive/discussions.md) and
[archive/document-folders.md](archive/document-folders.md).

## Current baseline

The [project README](../README.md#discussions-and-saved-files) describes the implemented room,
discussion creation, continuation, handoffs, file browsing and independent new-room behavior.
The basic feature is built; the archived proposals' “not implemented” labels are historical.
Current agent provider/model settings and automatic persistence are also documented there.

## Approved but unfinished

- **Editable discussion titles.** The User approved overriding the automatically generated
  title. Editing must change only its displayed title, keep the folder fixed, and prevent
  automatic naming from replacing a User-edited title. There is no title-editing operation
  or persisted display-title metadata yet.

## Decision that needs reconciliation

- **Returning to another discussion with its agent context.** The original discussions
  design says returning within an open room retains each discussion's agent context, and
  switching waits for replies to finish. The later folder-opening design says **one discussion,
  one room**. Today, Continue is allowed only before the first message; there is no in-room
  switching among started discussions. Preserve both historical statements until the User
  clarifies whether switching remains wanted. Do not infer approval to implement it.

## Deferred by the User

- **Better document browsing:** expandable folders, a filename filter, and an optional
  recently-changed order were proposed by the agents. General explorer improvements remain
  deferred. The User subsequently requested grouping archived and deferred proposal files;
  those two folder entries are implemented and do not imply a general expandable tree.
- **Discuss this document:** a button that sends the viewed file's path to the agents.
  Selecting a document alone must continue to affect only the view.
- **Migrating older records:** possibly group the old proposals and transcripts into one
  historical discussion after checking paths and references. This cleanup organizes
  `proposal/` only; it does not migrate session transcripts into a discussion.

## Boundaries to retain

- Notes, drawings and session transcripts belong in the active discussion; the work itself
  stays in the root. Moving a discussion note into authoritative project documentation is
  an explicit User-directed action.
- New sessions start fresh from the handoff and may read notes and transcripts; they do not
  automatically replay the old provider sessions.
- Two rooms continuing the same discussion have no collision guard, deliberately for now.
- A project-specific room file remains a possible later idea. The subsequently approved
  shared provider/model defaults at `~/.config/agent-room/defaults.json` serve a different
  purpose and do not settle that idea.
