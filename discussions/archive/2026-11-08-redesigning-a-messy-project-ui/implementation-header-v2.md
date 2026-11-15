# Header v2: implementation notes (Worker, 2026-11-08)

On `worker/main`, uncommitted, `src/docs.mjs` only, following `drawings/header-zones-v2.svg`.

- **Room:** "agent-room ▾" is a `<details>` menu: Switch room…, Open room in folder…, Quit room
  (red). Below it: the replication line, then the root path. The Switch room chooser (`#rooms`)
  appears in this zone, outside the menu.
- **Current discussion:** the title (larger) and "← back to …", then Pause/Resume, Summarize,
  Auto-summarize, and New discussion behind a dashed separator. New discussion left the
  Discussions pane; it shows under the same condition as before and keeps its two-click confirm.
- **Server and monitoring:** "● Server up … · port … ▾" menu (Reload, Restart, Shutdown server
  in red), the version line under it, the gauges unchanged, "updated" stacked above Usage.
- The button row under the message box is gone.
- Menus: one open at a time; an outside click or Escape closes them. Switch room, Open room and
  Reload close their menu; Quit, Restart and Shutdown keep it open for the second click.
- Measured at 1440 px wide: the header is ~114 px high (the drawing aimed for ~64 px), because the
  room line and the title wrap, and New discussion drops to a third line.

## Follow-up (2026-11-08)

- The title is back to its previous size (.75rem, normal weight). The server status line and
  version now sit on one line above the gauges, inside the monitoring zone.
- Header height at 1440 px, measured in a test room with a started discussion:
  - Pause visible: 94.3 px before, 92.8 px after.
  - "← back to …" visible: 108.1 px before, 92.8 px after.
- What sets the height now is the room zone (79 px: the replication line wraps onto two lines
  under the 17rem cap), not the discussion zone.
- Fixed: "← back to …" didn't wrap, so it ran into the server zone. It wraps now.

## Final checks before commit (2026-11-08)

- Paused discussion: "Resume discussion" and "· paused" show in the header. 92.8 px at 1440 px,
  nothing overlaps.
- Light theme (page's color-scheme forced to light; the Mac is in dark mode): readable, menu
  popup readable, 92.8 px, nothing overlaps.
- 1024 px (page loaded in a 1024 px iframe, because the window wouldn't resize): server and
  monitoring take their own rows under room and discussion, header 168 px. Nothing overlaps or is
  cut off, every gauge value, reset time and "updated" is visible.
- No layout changes were needed. Optional: at narrow widths, the status/version could sit beside
  the gauges instead of above them, to lower the 168 px.

## Header v3 (2026-11-08, uncommitted on worker/main)

Follows `drawings/header-zones-v3.svg`. The header is 70 px at 1440 px (131 px at 1024 px).
- Zone borders: blue for the room, green for the discussion, amber for server and monitoring.
- The replication line shows on hover or keyboard focus of "agent-room ▾". The uptime, port and
  version show on hover or keyboard focus of "● Server ▾". Neither shows while its menu is open.
- Under the title, a status line: "paused", "<name> is thinking", or "your turn". "your turn"
  appears only after the round's own "your turn" event, so it doesn't flash between two agents'
  turns. With no discussion, the title itself still reads "No discussion started".
- "Actions ▾" holds Pause/Resume, Summarize, and New discussion below a separator. New
  discussion still takes two clicks. The menu hides when all its items are hidden.
- "← back to …" is removed from the page and from README.md. The server's `room.back` state and
  its tests (`test/ui.test.mjs`) are unchanged.

### v3 follow-up checks (2026-11-08)

- README: the header description (zones and menus), Server status, New discussion, Pause and
  Resume discussion, and the View paragraph's "bottom read-only bar" now match v3.
- View of a received line: the status under the title is empty; Actions, Auto-summarize and the
  message box are hidden. Paused: "paused", with Resume discussion in Actions.
- Fixed:
  - The server details now stay open while hovered, so the version's tooltip can be reached.
  - Light theme: the "Server" label is darker amber.
  - Meter not reachable: the message, "checked" and Usage share one line.
- Keyboard: Tab moves agent-room ▾ → Actions ▾ → Auto-summarize → Server ▾, and each detail
  shows on focus. The Tab presses came from the browser extension, not a physical keyboard.

## Right pane v1 (2026-11-08, uncommitted on worker/main)

Follows `drawings/right-pane-v1.svg`.
- The Discussions button is replaced by two subtabs, Explorer and Document. Choosing a file opens it
  in Document. Each tab keeps its place: Explorer its folder and scroll, Document its file and
  scroll. The same file shown again isn't reloaded. Document is disabled until a file is open.
- In Explorer, the "ACTIVE" heading reads "DISCUSSIONS", and the discussion in use comes first.
  The list's own "Discussions" title is removed (the tab names it now).
- Peers moved to "Peers…" in the room's ▾ menu, which opens a dialog with the same content.
- Entering or leaving a View clears Document, as the old pane did.
- Checks before commit (scripted rooms, no agent turns), no fixes needed:
  - `/docs` opens Explorer at the top and keeps the open document in Document.
  - Explorer's scroll position (500 px in a 40-discussion list) survives switching tabs, and a
    redraw while Explorer or Document is in front.
  - Pair with an unpaired scripted peer works from the Peers… panel, and the panel updates.

## Every document refreshes (2026-11-08, uncommitted on worker/main)

- The room page polls the shown file's `__mtime` every two seconds and reloads the Document
  frame in place when it changes. It skips Markdown, whose page already polls itself, and
  received snapshots.
- A missing file (`__mtime` answers `false`) is skipped and retried, both in that poll and in the
  Markdown page's own poll, which used to reload into "Not found".
- Document responses carry `cache-control: no-cache`.
- Tested with scripted rooms. An SVG edited while shown refreshed at the same scroll position (1000
  px), stayed on screen while deleted for 5 s, and showed the new version once it was back.
  Markdown behaved the same at 1200 px, with one `__mtime` poll every 2 s.

## Peer warning (2026-11-08, uncommitted on worker/main)

- An amber ⚠ under "● Server" shows while any peer is unreachable (`reachable === false`, the
  same reachability Peers… shows). Its title and aria-label say "N peer(s) unreachable", and
  clicking it (or Enter after Tab) opens Peers…. The header stays at 68.6 px.
- "Server" and its details box are now wrapped together, so the box still hangs right under
  "Server" while the icon shows.
