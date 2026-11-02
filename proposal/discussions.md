# Discussions and document browsing: remaining decisions

Status: documentation reviewed against the code on 2026-11-02. Cleanup approved by the User.
This list preserves unfinished decisions and deferred ideas; cleanup does not authorize implementation.
The original discussions and folder-opening proposals are preserved in
[archive/discussions.md](archive/discussions.md) and
[archive/document-folders.md](archive/document-folders.md).

## Already implemented

A room shows its full root path and active discussion. The first message gets a title from
Claude with no tools, then creates `discussions/<date>-<title>/` and its session transcript
before the discussion agents receive it. Title generation has a 30-second timeout and a
date-and-time fallback; occupied names get numeric suffixes. Opening a room creates no records.

Documents groups discussions and this project's older `proposal/` files. Viewing documents
does not switch the conversation or tell the agents what is being viewed. Before the first
message, Continue selects an existing discussion without generating a title; the fresh agents
are instructed to start from its handoff. Handoff consumption is an agent convention, not
an enforced session lock.

New room in folder… uses the Mac folder chooser and starts an independent room on its own
port. The existing room keeps running. These are code-inspection findings, not a new live
UI or provider verification. See [the project README](../README.md) for current usage.

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
  recently-changed order were proposed by the agents. Improving the explorer was deferred.
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
