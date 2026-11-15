# Restyle the room header and move the Server indicator

Drawing: [drawings/header.svg](drawings/header.svg) (today above, proposed below).

## Decided (User)
- The room zone's title shows the last part of the room's root path (its folder name) in place of the fixed text "agent-room".
- The full path moves out of the header into the room title's tooltip.
- The "server gauge" is the "● Server" indicator with its menu. It moves from the right (monitoring) zone into the room zone, together with the amber ⚠ peer warning.
- "Server" text is blue, like the room zone's border. The ⚠ stays amber and sits to the right of "Server" (today it is below).

## Proposed (agents)
- **Claude:** in the tooltip, the full path is the first line (monospace), above the existing replication line. The tooltip then shows on hover even without replication (Agy noted this; intended).
- **Codex, Agy:** Server's hover details (connection text, version) move with it.
- **Codex:** the right zone's accessibility label becomes "Monitoring" (it isn't visible).
- **Agy:** the first quota gauge loses its left divider, which today separates it from "● Server".
- **Claude:** "Server" stays red when the server is down, as today (assumed: the User spoke only of its normal colour).

## Implementation
- Merged into `main` (User, 2026-11-13): commits `116ee90`, `ad9c1b4` (Server blue `light-dark(#3d5fc4, #5a7bd8)`), `ca7bfec` and `3298c7e` (room zone horizontal padding).
- Tested: 215/215 on `116ee90` (Claude); 215/215 on `ad9c1b4` (Worker's report). Not checked: the rendered header in a browser.