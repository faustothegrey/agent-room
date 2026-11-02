# Discussions and document browsing: remaining decisions

Status: documentation reviewed against the code on 2026-11-02. Cleanup approved by the User.
This list preserves unfinished decisions and deferred ideas; cleanup does not authorize implementation.
The original discussions and folder-opening designs are preserved in
[discussions-original.md](discussions-original.md) and
[document-folders.md](document-folders.md).

## Current baseline

The [project README](../../README.md#discussions-and-saved-files) describes the implemented room,
discussion creation, re-opening, handoffs, file browsing and independent new-room behavior.
The basic feature is built; the archived designs' “not implemented” labels are historical.
Current agent provider/model settings and automatic persistence are also documented there.

## Approved but unfinished

- **Editable discussion titles.** The User approved overriding the automatically generated
  title. Editing must change only its displayed title, keep the folder fixed, and prevent
  automatic naming from replacing a User-edited title. There is no title-editing operation
  or persisted display-title metadata yet.

## Decided (by the User, 2026-11-02)

- **Re-opening a discussion.** "Re-open this discussion" is available at any time between rounds,
  not only before the first message. Re-opening starts a **fresh session** in that discussion: the
  current session's transcript ends, the discussion agents' and the worker's CLI sessions restart,
  and the agents start from the re-opened discussion's handoff. Each discussion does **not** keep
  its own agent memory across switches. This settles the earlier contradiction between "retain
  each discussion's agent context" (original design) and "one discussion, one room" (later design).
- **No more `proposal/` or separate transcripts.** Documents and transcripts all live in their
  discussion. agent-room's own earlier proposals and room logs were each moved into the
  discussion they belong to (five discussions, indexed in `discussions/README.md`); seven empty
  logs were deleted.
- **Archive and deferred hold whole discussions.** A finished discussion moves, as a bundle
  (documents and transcripts), into `discussions/archive/`; a postponed one into
  `discussions/deferred/`. Both are listed at the bottom of Discussions and created only when
  first needed. Archive / Defer / Make active buttons move them; re-opening one makes it active.
- **The worker works within the active discussion.** It is told the active discussion's folder
  and writes its implementation notes and plans there; the work itself stays in the root.

## Deferred by the User

- **Better document browsing:** expandable folders, a filename filter, and an optional
  recently-changed order were proposed by the agents. General explorer improvements remain
  deferred. Inside a discussion, each subfolder (e.g. `drawings/`, `transcripts/`) is a folder
  entry that opens to its files; that one step is all, not a general expandable tree.
- **Discuss this document:** a button that sends the viewed file's path to the agents.
  Selecting a document alone must continue to affect only the view. (Only transcripts have
  such a button, Send to agents, carried over from the former Transcripts list.)

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
