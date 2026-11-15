# Stage 0 plan: New discussion button (worker's implementation notes)

Authorized by the User on 2026-11-07. Spec: [ui-design.md](ui-design.md) section I, including
"Answers to the worker's questions". No new module, no port change. Baseline: commit `9febb88`
(the `--dev` work, committed first as asked).

## Server (`src/ui.mjs`)
- **`/new`** (queued like every command, so it waits for a running round and its summary).
  - Nothing to end (no discussion picked, nothing said): a note, nothing changes.
  - Otherwise the discussion session ends **as Re-open ends it today**: a "session ended" line in
    the old transcript, which is then closed; the chat clears; the discussion agents get fresh
    sessions. The header shows "No discussion started". No folder is created: the next message
    names and creates it, as today.
  - **The worker is not touched:** no waiting for its queue, no reset, its log stays and gets a
    marker line ("New discussion: … is no longer the active one"). A task already running keeps
    its target: its reply goes into the transcript that was open when it started.
  - The worker's next instruction gets the new folder once it exists (today's rule). Before
    that, it's told that no discussion is active now, without naming a folder for notes.
- The session-ending block of `reopenDiscussion` moves into a shared helper. Re-open keeps
  exactly its current worker behaviour (waits, resets, clears the log).
- **Back link:** after New or Re-open, the header carries the previous discussion (`back`),
  until the next message opens a discussion. A failed folder creation keeps it.

## Page (`src/docs.mjs`)
- **New discussion** button at the top of the Discussions pane, when there is something to end.
  Two clicks when the session has started (Re-open's existing confirmation, `docs.mjs:480`).
- **Re-open** button on every row of the *Active* list, with the same two-click rule. The list
  keeps its newest-first order.
- Header: **← back to "<title>"** under the discussion name; it sends `/reopen <name>`. It only
  appears when nothing has been said yet, so no confirmation is needed (as for Re-open today).
- The Worker tab shows the marker as a status line.

## Tests (`test/ui.test.mjs`)
New while idle (no-op) and after a round; no folder created; old transcript kept and closed;
fresh discussion sessions; worker not reset or awaited, late reply goes to the old transcript,
its log is kept and marked; next message creates the titled discussion and clears the back link;
a failed folder creation keeps it; the worker's next instruction gets the new folder.
README and `/help` text updated.

## Fix (2026-11-07, found by Codex)
Worker task running → New discussion → Archive the previous one → the reply's transcript write
threw ENOENT: reply lost, Worker tab stuck busy. Now `ctx.workingIn` holds the running task's
discussion folder and `/move` refuses it until the task ends; a failed transcript write still shows
the reply plus an error line in the Worker tab, and the busy state is cleared in `finally`.
