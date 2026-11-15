# One server, several rooms

Drawing: `drawings/one-server-many-rooms.svg`

## Closed (User, 2026-11-08: "formally close this discussion with some notes on the things that have been deferred")
Shipped on main as 875b35e and 01e1118. Tested live: several rooms in one server, each in its
own window; Open room in folder… (create, cancel, already open, reopen); rounds in different
rooms run independently; Restart brings rooms back in their discussions; Quit room ends only
that room. Details: `handoff-read-20261108-170000.md` and `handoff-read-20261108-180000.md`.
The open questions further down were answered there; the sections below this one are the
design history.

**Deferred: untested, to try when convenient** (Claude and Codex judged them non-blocking):
- Dock Quit → **Cancel** during a busy round: should keep every room running.
  Dock Quit → **Shutdown**: should end every room and the server. Easiest to try the next time
  you quit anyway. The Dock app was rebuilt from main (01e1118) on 2026-11-08.
- In-page **Restart → Cancel** while a room is busy (skipped by the User).

**Deferred: wording, not sent to the worker:** the waiting text "Choose a folder in the window
that has just opened…" appears in that same window, which is confusing; e.g. "Choose a folder in
the Mac's folder dialog…".

**Optional cleanup:** the test folders `/Users/fausto/Analisi/RoomTest-3a` and
`/Users/fausto/Analisi/CanaryRoom`, once their rooms have ended.

No worker instructions pending.

## Decided (by the User, 2026-11-08)
- One server instance serves several rooms (not several servers behind one address).
- "Quit room" and "Shutdown server" are distinct actions.
- Approved the worker's plan (worker-plan.md) with the adjustments in pending-instructions.md
  "Confirm the one-server plan": Quit room stops its agents and worker; replication only for
  the launch room; the listed one-room-per-process tests may change.
- Earlier, still standing: several rooms side by side, each in its own window; the chooser doesn't
  offer a room already open in another window; pages on any device count (provisional).

## How the code holds a room today (read by Claude in `src/`, 2026-11-08; not run)
- `src/cli.mjs` builds **one `ctx`** (lines 39–50): the root folder (`cwd`), agent sessions,
  the transcript, and **one input queue**; `/quit` and `/restart` end the whole process.
- `src/ui.mjs` `load()` (143–174) builds that ctx's agents, worker and screen state;
  `start()` (618–645) starts the quota timer and the HTTP server (`viewerUrl`, line 1084).
- `src/docs.mjs` routes by fixed paths (`/__room`, `/__health`, `/__say`, `/__events`, …,
  lines 1084–1203); any other path is **a file under the room's root**. The page calls these
  paths absolutely (e.g. line 852 `fetch('/__rooms')`).
- `ui.mjs` keeps some module-level state (e.g. the thinking `ticker`, line 736): one per process.
- `newRoom()` (560–587) spawns a separate process on a free port; `listRooms()` (533–548)
  finds rooms by scanning ports with `lsof`.
- Replication (`--node`, `--peer`) is set up per process for one root (`replicate.mjs` line 100).

## What would have to change (Proposed, Claude; size unmeasured)
1. **A ctx per room** in one process, kept in a map keyed by folder; each with its own input
   queue so rounds in different rooms don't wait for each other.
2. **Addresses carry the room**: every page request (screen, events, files, actions) says which
   room it is for; files are served from that room's folder.
3. **New room in folder…** adds a room to this server, or opens the existing room for that
   folder. Switch room… lists the server's rooms directly (no port scan).
4. **Quit room**: ends that room's agents and session; others continue.
   **Shutdown server**: ends all rooms. Restart and Reload act on the whole server.
5. Module-level state in `ui.mjs` moved into each room's ctx.

## Open questions for the User
- Replication between Mac and charon (`--node`, `--peer`): every room, only the first, or out of
  scope for now?
- After Shutdown server, should the next start bring back the rooms that were running?
- Restart: restarts every room (each re-opening its discussion from its handoff). Acceptable?
- The Dock app: keep it starting/reusing the one server on 5566?

## Not in this room's scope
Implementation is the worker's. Next: a worker instruction drafted here, reviewed by Codex,
sent by the User.
