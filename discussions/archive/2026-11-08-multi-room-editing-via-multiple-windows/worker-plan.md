# Worker plan: one server, several rooms (2026-11-08, not implemented yet)

Read: `src/cli.mjs`, `src/ui.mjs`, `src/docs.mjs`, `src/agents.mjs`, `src/replicate.mjs` (its
routes and the peer setup), `scripts/dock-launcher.applescript` and the tests that touch addresses.
Nothing has been run or changed yet.

## Plan

1. **A hub in `cli.mjs`.** It holds the rooms (a Map keyed by the folder's real path), the one HTTP
   server, and the loaded `ui` module. Each room is a `ctx` as today, with **its own line queue and
   its own `for await` loop**, so a round in one room never waits for another. `addRoom(folder)`
   (used at launch and by New room in folder…) builds a ctx, runs `ui.load` and `ui.start`, and
   starts the room's loop. `--no-screen` stays a single terminal room.
2. **Every address names its room**: `/r/<id>/…`, where `<id>` = the folder's name plus 6 hex
   characters of a hash of its real path (e.g. `/r/agent-room-3f9a1c/__room`). The id stays the
   same across a Restart, so open pages reconnect to their own room. Under that prefix everything is
   as today, routed to that room's `ctx.docs.handle(req, res, ctx.cwd, ctx.screen)`: the page,
   `__events`, `__say`, `__work`, `__show`, `__files`, `__mtime`, `__settings`, documents and
   transcripts, received snapshots. The page code switches to **relative** URLs (`fetch('__say')`,
   `EventSource('__events')`, the iframe's document address), so a window can only reach its own room.
   An unknown id returns 404.
3. **Server-level addresses** (no prefix): `/__health` (the server's pid and start time, plus its
   rooms), `/__rooms` (Switch room…: this server's rooms with folder, discussion and pages open,
   read from the Map, no `lsof` scan), `/__newroom`, `/__shutdown`, and `/__room`, which redirects
   to the first room (so the Dock app and the banner keep `http://127.0.0.1:5566/__room`).
4. **New room in folder…** picks the folder (osascript, as now). If a room already has that folder,
   it returns that room's address; otherwise it adds a room in this process (saved defaults, or the
   room's agents if none are saved, as now) and returns the new address.
5. **Quit room** (`/quit` in a room) ends only that room, after its round in progress (as now): its
   pages get `ended`, its quota timer stops, it leaves the Map. A worker instruction still running
   in it is stopped (see point 2 of the incompatibilities). **Shutdown server** (a new two-click button, POST
   `/__shutdown`, used by the Dock app's Quit) quits every room the same way, then exits.
   When the last room quits, the server exits too (otherwise the Dock app would be left with an
   empty server and no page).
6. **Reload** (from any room, or `--dev`) imports the code once and applies it to every room
   between that room's rounds. **Restart** (from any room) waits for every room's round, then starts
   one new process on the same port, with every room and each room's discussion re-opened (paused
   ones stay paused, as now). Startup without Restart still opens only the `--cwd` room.
7. **Module-level state moves into the room**: the terminal "thinking" ticker (`ui.mjs` line 736)
   goes into ctx.
8. **Dock app**: it still starts or reuses the server on 5566 and opens `/__room`. Quit sends
   `/__shutdown`. The last log line becomes "Server ended."; after the edit the app has to be
   recompiled with the README's command.

## Replication (`--node` / `--peer`): a practical limitation, not new machinery

Each room's stored data is already kept apart: everything is in `<root>/.agent-room/`. What doesn't
work for each room is the peer setup. `--peer charon=http://ADDRESS:5566` names a *server*, and
pairing finds "the" room by fetching `<url>/replica/status`. To replicate every room, each room would
need its own peer address (the matching room on charon, whose folder and id differ), plus a way to
configure and choose it on pairing. That is substantial new machinery.
**Proposed:** replication runs only for the launch room (`--cwd`, which is agent-room itself from
the Dock app). Its peer endpoint stays at `/replica/*`, unchanged, so charon pairs and sends as
today. Rooms added with New room in folder… don't replicate, and their Peers panel says so.

## Concrete incompatibilities and points to confirm

1. **Two rooms in one Git repository share one worker worktree** (`<repo>.worker`, branch
   `worker/main`). This happens with rooms in two folders of the same repository. Proposed: the
   second room's worker is disabled, with the reason shown in its Worker tab.
2. **Quit room while a worker instruction runs.** Today `/quit` exits the process without stopping
   the worker's CLI. In one shared server, a quit room must not leave its worker running. Proposed:
   Quit room kills that room's running agent and worker CLI processes. This is a small option in
   `agents.mjs` `run()` that tracks the child processes per room. It is new behaviour.
3. **New room in folder… on a folder whose room is already open in another window**: the
   instruction says "open that room instead", but that duplicates a window, which the rest of the
   instruction avoids. Proposed: if it has a page open, don't open a window; say it is already open
   elsewhere.
4. **Restart now brings back several rooms.** That needs a way to pass them to the new process.
   Proposed: an internal `--restore '<json>'` flag (rooms and their discussions), used only by
   Restart. `--agents`/`--worker` from the launch still apply to the launch room only; the other
   rooms use the saved defaults (as New room does today).
5. **The terminal log is shared.** Lines from several rooms interleave in one terminal or Dock log,
   with no room label. I won't change that unless asked.
6. **Tests that encode the old one-room-per-process contract** and would have to change (your
   approval needed, per CLAUDE.md):
   - `test/ui.test.mjs`: the two `restartArgs` tests (lines 298–303 and 789–792), and "room
     discovery finds independent listeners" (697–717), which tests the `lsof` port scan.
   - `test/docs.test.mjs`: `EventSource('\/__events')` (line 100) becomes the relative
     `EventSource('__events')`. `/__rooms` (339–352) lists rooms by id and address instead of port.
   - `test/screen.test.mjs`: the four tests that read the banner's `http://127.0.0.1:<port>/__room`
     and then POST to `<base>__say` need the room's `/r/<id>/` address. The banner will print both
     lines.
   - New tests: two rooms in one process are isolated (events, files, `__say`), a round in one
     doesn't block the other, New room on an existing folder returns the existing room, and Quit
     room leaves the other room running.

## Files that would change (estimate)

| File | Change |
|---|---|
| `src/cli.mjs` | the hub: rooms Map, a loop per room, addRoom, reload/restart/shutdown for all (~+70 lines) |
| `src/ui.mjs` | the server and its room routing, newRoom in-process, listRooms from the hub, restart args for all rooms, quit one room, ticker in ctx, USAGE |
| `src/docs.mjs` | relative URLs in the page, `page()`'s links taking the room's base, Switch room by id, the Quit room and Shutdown server buttons, the server-level endpoints |
| `src/agents.mjs` | `run()` tracks child processes (a few lines) |
| `src/replicate.mjs` | none expected |
| `scripts/dock-launcher.applescript` | Quit → `/__shutdown`, "Server ended." |
| `README.md` | the addresses, Quit room / Shutdown server, the replication limitation |
| tests | as listed in point 6 above |

## Implemented (2026-11-08, on worker/main, not committed)

Confirmed with the User's adjustments: rooms keyed by the folder's real path; Restart keeps each
room's current agents and worker; the server routes every request to its room and serves files
only from inside that room's folder (real-path check, so neither `../` nor a symbolic link escapes);
log lines labelled `[<folder name>]`; Quit room stops the room's running programs first and reports
what it couldn't stop cleanly; replication only for the launch room (others' Peers panel says why);
a second room in the same Git repository gets no worker.

Deviations and details worth reviewing:
- A room started without cli.mjs's hub (as `test/replication-ui.test.mjs` does) is also served at
  `/` as before (`hub.single`); cli.mjs never uses that path. This kept that test unchanged.
- The banner prints `Discussion screen: http://127.0.0.1:<port>/__room` (the server, which the
  Dock app reads) and a labelled `Room screen: …/r/<id>/__room` per room.
- Restart passes the first room as `--cwd` (with `--node/--peer` only if it is the launch room)
  and the others as repeatable `--room '<json>'`.
- The final log line is "Server ended." (UI mode); the Dock app checks it. The app must be
  recompiled; an old build's Quit posts `/__say` at the server root, which now answers 404.
- Not tested: New room in folder… (needs the macOS folder chooser), a real browser session, the
  Dock app, replication with charon.

## Follow-ups (2026-11-08)
- Removed the root compatibility path (`hub.single`); `test/replication-ui.test.mjs` now gives each
  node a hub with the room as its launch room and reaches it at `/r/<id>/` (peers at the server).
- Quit room (and Shutdown, Restart) waits at most `QUIT_GRACE_MS` = 30 s for the round in progress
  and lines queued before it, then stops the room's agent programs; no new one starts. Restart and
  Shutdown now start as they arrive instead of waiting behind the sending room's round.
- Shutdown has one address, `POST /__shutdown` (button, Dock app); typing `/shutdown` does the same.
- Restart with two rooms run for real (test + Chrome): both rooms, agents, worker and discussions
  come back, open pages reconnect.

## Further follow-ups (2026-11-08, uncommitted)
- addRoom refuses creation once hub.ending is set; newRoom checks before opening the chooser,
  and addRoom checks again after it returns. Shutdown also waits for a room already initializing
  before ending it, so it cannot miss that room's programs.
- Provider programs run in their own process groups. Cleanup sends SIGTERM to the group, waits
  up to five seconds, escalates to SIGKILL, and checks for another second, reporting unverifiable
  groups. Groups remain tracked when a provider exits with children still running. Provider timeout
  kills its group too.
- Practical limitation: a command deliberately creating another session/process group escapes
  this mechanism. Stronger guarantees need OS supervision; not built without approval.
- The server checks all rooms for ctx.busy or screen.working before Restart/Shutdown. Unconfirmed
  typed commands and POST /__shutdown return HTTP 409 listing busy rooms and warning that workers
  may stop immediately, leaving partial changes. Pages use a native browser confirm dialog and
  retry only on confirmation. Idle operations proceed as before.
- Dock implementation deliberately pending the requested advance report: simplest option is to
  capture the 409 warning, show an AppleScript Cancel / Shutdown dialog, and resend with
  ?confirmed=yes only after confirmation. No dependency/helper needed. Current launcher quits
  itself on the refusal; the busy server remains alive. No launcher edits in this follow-up.
- Tests added: creation guard after a delayed choice for both ending kinds; all busy rooms in the
  warning; actual HTTP refusal of typed Restart/Shutdown and Dock shutdown while a worker runs;
  real Quit kills a fake provider and its child command; shared cleanup kills child commands even
  after their provider exits.
- Final npm test: 114 tests, 114 pass, 0 fail, 0 cancelled/skipped/todo; 12597.305687 ms.
  git diff --check also passed. No browser, Dock app, or real-provider/manual checks this round.
- First full run exposed a docs test callback returning a number; only string return values now
  count as warnings. A new cleanup test initially lacked the docs stub; fixed its fixture.

## Dock confirmation implemented (2026-11-08, uncommitted)
- scripts/dock-launcher.applescript preserves the shutdown response body/status. HTTP 409 opens
  a native Cancel / Shutdown alert showing the server warning. Cancel/Escape returns without
  continuing quit; Shutdown retries POST /__shutdown?confirmed=yes. Other HTTP/transport errors
  show an alert and keep the launcher running. No dependency added.
- README now describes the implemented confirmation.
- Compiled successfully with osacompile -s into .worker-notes/dock-confirmation/AgentRoom.app.
  AppleScript status/warning parsing check passed. git diff --check passed.
- npm test: 114 tests, 114 passed, 0 failed/cancelled/skipped/todo; 13728.651874 ms.
- Did not launch the compiled app or interact with the native dialog; installed app untouched.
