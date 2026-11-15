# Redesigning a messy project UI

Subject: agent-room's own room page (`src/docs.mjs`), as seen at `http://127.0.0.1:5566/__room` on 2026-11-08.

## Decided (by the User)
- Information density and the overall layout stay as they are; only reorganize.
- Operations on the current discussion sit next to its title in the header.
- Room-related things get their own space in the header; monitoring info gets its own place.

- 2026-11-08: the User approved `drawings/header-zones-v2.svg` (incl. Summarize/Auto-summarize in
  the header and no button row under the message box). Draft Worker instruction in
  `pending-instructions.md`, not sent.
- Token/quota information stays exactly as it is now; it must not be reduced.
- Room and server operations are rare and can be hidden until needed. The header in v1 was too tall.

- 2026-11-08 (after the merge): room and server details shown only on hover; keep the coloured
  borders around header sections; discussion actions in a drop-down menu, Auto-summarize stays
  visible, discussion status under the title.

## Drawing
- `drawings/header-zones-v3.svg` (Claude): proposal for the above, ~58 px high.
  - Proposed (Codex, Claude agrees): the status line uses only states the app already has (paused,
    an agent working, "your turn", no discussion started); hover details also show on keyboard
    focus; menus open on click.
  - **Decided (User):** discussion details always visible; room folder path stays visible;
    "← back to …" is unnecessary (Re-open in the Discussions panel covers it), so it goes.
    Touch devices: not answered; assumed not needed (keyboard focus still shows details).
  - (Superseded) "← back to …" placement: Codex: inside Actions, as you asked for discussion actions.
    Claude: keep it visible, because it appears only right after New discussion/Re-open, when it is
    needed, and is easy to miss in a menu.
  - Open for the User: does the folder path stay visible? Is the room used on touch devices?
- `drawings/header-zones-v2.svg` (Claude, current): header two lines high (~64 px vs ~137 px today).
  Room actions behind "agent-room ▾", server actions behind "Server up … ▾"; quota gauges
  unchanged; discussion actions visible beside the title.
- `drawings/header-zones-v1.svg` (Claude): header in three zones, Room / Current discussion /
  Server & monitoring. Open: does Summarize leave the message box? Does New discussion move up?
  Do server actions (Reload, Restart, Shutdown) share the monitoring zone?
- Updated after Codex: Usage moved beside the quota gauges; the replication state ("Mac's line,
  no saved round") moved into Room; New discussion separated from the current discussion's
  operations; server actions kept as a labelled row in monitoring (Codex: no fourth zone).

## Status (2026-11-08, end of session)
Merged into main by the User: header v3 (with "read-only" status), right-pane Explorer/Document
subtabs with Peers… in the Room menu, auto-refresh of every shown document, the amber peer ⚠ icon,
and the matching README lines. No Worker instructions pending. Known unchecked: real "Pair"
dialog, PDF scroll on refresh, light theme with the ⚠ icon. Possible follow-up: Summarize looks
active while paused.

## Status update (2026-11-08, later)
Also merged: Explorer v2 (row actions, ⓘ node details, "Received from peers" section, labelled
local/received versions) and compact gauges ("wk", "at …", monitoring zone 127 px narrower).
The User also made some small tweaks directly with the Worker; they are not described here.
Also committed: one reset-time style for both providers ("at 9 Nov 01:59", always with the date,
24-hour clock), in the gauges, tooltips and the /usage report (User kept "at" everywhere). Summarize looking active while
paused: left out for now by the User (maybe a later tweak).

## Explorer refinement (started 2026-11-08, after the live review)
- **Decided (User):** local discussions clearly distinguished from remote (received) ones; each
  discussion shows Re-open, Archive, Defer directly; remove the extra step (▶ → node line
  "Mac (this node) · …" → separate page), moving the node info to a hover symbol.
- Observed (Claude, 5566): ▶ shows only node lines; clicking one opens a page with the three
  buttons and the files. A received-only discussion (charon-to-mac-connectivity-test) looks like a
  local one except it has no Re-open, and offers View on its charon line.
- Drawing: `drawings/explorer-v2.svg` (Claude). Open: badge for a local discussion that also has
  a peer line; a separate "Received from peers" section vs. a marker in the same list.

## Right pane (started 2026-11-08, after the header)
- **Decided (User):** separate the discussion explorer (with its files) from the document viewer,
  as two subtabs; there's no need to see both at once.
- Observed (Claude, live page on 5566): the pane already shows *either* the list *or* a document,
  switched by a lone "Discussions" button next to the document's path. The list also holds
  "This room's own documents", archive/deferred and **Peers** (not a document).
- Drawing: `drawings/right-pane-v1.svg` (Claude).
- **Decided (User):** Peers moves to a panel opened from the Room menu; the explorer's "ACTIVE"
  label becomes "DISCUSSIONS"; the discussion in use is always listed first.
- Proposed (Codex, Claude agrees): each tab keeps its place (open document and scroll, explorer
  position); start on Explorer, Document disabled until a file is chosen.
- Not answered: Peers in the same change or separately. Claude's draft does both together.

## Observations (Claude, tested: screenshot of the live page, 2026-11-08)
1. **The header mixes four scopes** in one block: the server (uptime, port, node, Shutdown), the room
   (folder path, Switch room…, Open room in folder…), the discussion (title, Pause), and the
   provider quotas (Claude/Codex gauges).
2. **The status line is jargon**: "Mac's line, no saved round · agents run on Mac · Project 01e1118".
3. **Rare, risky buttons sit beside everyday ones**: Restart, Quit room and Shutdown server are in the
   same row as Summarize and Usage, under the message box.
4. **The right pane is mostly empty** until a document is chosen; "Discussions" is a lone button.
5. The version line (`01e1118 · started 16:56`) is developer information shown permanently.

## Proposed (Claude)
- Sort every control by **scope** (server / room / discussion / document) and by **frequency**
  (every message / sometimes / rarely), then give each group one place. Rare server actions go into
  one menu; the header keeps only "where am I" (room, discussion) and quotas.

## Proposed (Codex)
- The screen should answer three questions at a glance: **Where am I?** (room, discussion),
  **What's happening?** (who is working, paused, anything needing attention), **What are we
  discussing?** (the document beside the chat).
- The Worker can keep running across discussions, so its activity should stay visible even when
  its tab is closed.
- Compare two sketches: (A) a quieter version of today's layout, secondary controls in menus;
  (B) the same with a collapsible sidebar for rooms, discussions and files. Codex prefers
  sketching A first, since a permanent sidebar takes space from the chat and drawing.
  (Claude agrees A first.)

## Open questions for the User
- What feels messiest to you: too much to read, not finding things, or clicking the wrong thing?
- Which controls do you use every session, and which almost never?
- Is the page also used on other devices (phone/tablet on the LAN)?
