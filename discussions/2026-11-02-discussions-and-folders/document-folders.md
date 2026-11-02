# Exploring documents and opening other folders

> **Historical archive — 2026-11-02.** The basic feature is implemented. Remaining and deferred items are tracked in [the current discussion proposal](discussions.md). Earlier status labels and next steps below describe the original discussion, not current work. See [the discussions index](../README.md).

Status: mostly decided by the User (2026-11-02), not implemented; some details still proposed.
Started 2026-11-02. Builds on `../archive/2026-10-20-discussion-ide/discussion-ide.md` (first cycle: chat on the
left, the chosen document on the right). Drawing: `drawings/6-new-room.svg` (updated to reflect the decisions below).

**`discussions-original.md` takes precedence** wherever the two documents conflict (User, 2026-11-02).
In particular: a room's records go in `<root>/discussions/<name>/`, not `<root>/proposal/`, and
the list shows only the discussions, not the whole folder.

## Decided (by the User, 2026-11-02)
- A **"New room in folder…"** action (first called "Open document folder…"): the User chooses
  a directory anywhere on the filesystem.
- It opens **a new room altogether, in a new browser window**: its own conversation, with the
  agents working in the chosen folder.
- The **root directory is clearly visible** (its full path shown).
- **New rooms are exactly like this one, only with a different root directory**: same rules,
  including the writing rule (now pointing at the active discussion's folder, see
  `discussions-original.md`).
- **The current room keeps running** alongside the new one. Consequences (Claude; from how
  turns work, unmeasured): a quiet room costs nothing, since agents run only when a message
  arrives; two active rooms cost roughly double; the path at the top tells windows apart.
- **Opening a room offers "New discussion" or "Continue discussion"** (decided in
  `discussions-original.md`, which takes precedence). Either way the chat starts empty; continuing uses
  the discussion's handoff. Continuing skips the title and folder-creation steps below: the
  folder already exists, and the new session's transcript is added to it.
- **Exploring stays as it is for now**: the file list is "a bit rough", but improving it is
  deferred.
- **"Discuss this document" is deferred.**
- **Title failure fallback** (proposed by Claude, supported by Codex): if the title can't be
  generated (error or timeout), the discussion folder is named with **only the date and
  time**, an exception to "date + first title". The folder never moves; a later title changes
  only the displayed name. The timeout is still to be chosen.
- **When the discussion folder is created** (proposed by Codex, supported by Claude; approved
  by the User): opening a folder writes nothing to it. On the first message:
  1. Hold the message in memory and ask Claude for a title, with no file-writing tools.
     Claude is the default title agent for now (User, 2026-11-02); this may be relaxed later.
  2. Create `discussions/` and the discussion folder (date + first title, or the date-and-time
     fallback), and save the transcript, even if no document is ever saved.
  3. Only then give the message to the discussion agents, with the known writing path.
  The User waits for the title before the first reply; that delay and its cost are unmeasured.
- **Name clashes** (proposed by Claude, supported by Codex; approved by the User): if the
  name is taken, add `-2`, `-3`… The check happens at the moment of creating the folder,
  retrying with the next suffix if occupied.
- **If creating the folder or saving fails** (proposed by Codex; approved by the User): show
  the error and keep the message in memory. Untested. Until the first transcript is saved,
  closing the process can lose the first message; the title fallback alone cannot prevent that.
- **One discussion, one room** (User, 2026-11-02): different rooms hold different
  discussions. Two rooms continuing the same discussion is treated as a rare accident: no
  guard for now, to be revisited if it proves worth it.

## Today (code inspection, not a live test)
- Documents shows one flat alphabetical list of `proposal/` (subfolders included); opening it
  replaces the document view (`src/docs.mjs` openFiles).
- The server refuses files outside `proposal/` (`src/docs.mjs` `/__show`, `inside(dir, …)`).
- Choosing a document changes only the screen; the agents are not told (`/__show` broadcasts a
  display event, adds no message). (Codex found this; Claude confirmed.)
- The agents' working directory is fixed at start (`--cwd`).
- The header shows only the folder's last name (`basename(ctx.cwd)`, `src/ui.mjs:69`), so
  "full path shown" needs a code change. (Worker review.)
- Transcripts go to `transcripts/` under the directory the room was launched from, not under
  `--cwd` (`src/cli.mjs:16`). `discussions-original.md` puts them in the discussion's folder, so this
  needs a code change. (Worker review.)
- The server's port is fixed (5566).
- Writing rule (`README-for-brainstorming-agents.md`): agents write in `proposal/`, and
  elsewhere only when the User asks, saying exactly what they changed. **It is only an
  instruction:** Codex runs without a sandbox and Claude's tools accept any path
  (`src/agents.mjs:6`, `src/agents.mjs:19`). Nothing on disk enforces it. This matters more
  once a room can point at any folder (Notes, Documents…). (Worker review.)
- The Worker is not under that writing rule: it changes files where the User asks. It has
  a shell and tools that accept any path, so nothing limits it to the root: it can write
  anywhere on disk. In a new room the root could be Notes or
  Documents. (Worker review.)

## Proposed (agents; not decided)
- **Choosing the folder** (Claude, supported by Codex): the room's server opens the Mac's own
  "Choose folder" window, which returns the full path (assumed / from memory:
  `osascript -e 'POSIX path of (choose folder)'`; untested; macOS only). Cancelling makes
  osascript exit with an error, which must be treated as a normal cancel (worker review).
  Fallback: a folder list drawn by the room itself, starting at the home folder. Codex:
  confirm at implementation time, checking other routes (e.g. a launcher) first.
  - Why not the browser's own picker. **Documented:** `showDirectoryPicker()` lets the page
    read the chosen folder, but its handle has only `kind` and `name`, never the full path
    ([MDN FileSystemHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle));
    MDN marks it "Limited availability", experimental
    ([MDN showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)).
    The server needs the full path to start the agents there.
- **Each room has its own Worker tab** (Codex, supported by Claude): inferred from "new rooms
  are exactly like this one".
- **Each window keeps addressing its own room**, including after a refresh (Codex). Whether
  that is another port or a path such as `/room/2` is left to implementation.
- **Opening outcome** (Codex; proposed, untested): cancelling the folder chooser leaves the
  current room as it is. If the new room cannot start, show the error in the current room.
  The new room starts with an empty chat and does not inherit the other room's conversation;
  continuing an existing discussion is the explicit "Continue discussion" choice above.
- Deferred by the User, kept for reference: **"Discuss this document"** (Codex, supported by
  Claude): a button that tells the agents the full path of the file you're looking at.
  **Better exploring** (Codex): folders that open and close, a filename filter, alphabetical
  by default with "Recently changed" as an option.

## Open questions for the User
- None at the moment.

## Unresolved disagreements
- None open. Superseded: Claude's limit "browse only the starting folder"; Codex's "browse
  another folder without changing the room" (the User chose a new room); Codex's "the new room
  browses the whole chosen folder" (replaced by `discussions-original.md`: only discussions).
