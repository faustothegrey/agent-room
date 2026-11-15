# Monitoring agent-room's Claude and Codex programs, and their login

**Closed (User, 2026-11-12).** Done as 8b533f4, fc7c879, fcb45ed, merged and running; hover tooltips checked live. Not yet tried: copying the stop command from a real leftover's tooltip, two servers at once, a real crash.

Drawing: `drawings/monitor-panel.svg`. Worker instruction: `pending-instructions.md`.

## Decided (User)
- Monitor only the programs agent-room starts and manages, including those left over after a crash or Restart ("really very important").
- Counts and leftovers are for the room being viewed; a leftover whose room isn't open shows in every room's panel.
- In the monitor panel: no ⚠ when all is fine. On a problem, a ⚠ right of the provider's name, which stays vertically centred between its two gauge rows. Hover shows the problem, then the state (login, programs running).
- Amber: login ends in 2 days or less, or a leftover. Red: logged out or expired.
- No Stop button: the User stops leftovers from the Terminal.
- Remove the **Usage** button; "updated" becomes "on". Don't touch the Server part.
- `/usage` command: left to the agents; Claude chose to keep it.

## Facts
- One program per turn, in its own process group, listed per room in memory (`src/agents.mjs:30-37`); its input is closed at start (`:53`), so a leftover is working or stuck. (code read)
- `claude auth status` gives `loginExpiresAt` (8 Dec 2026 on this Mac); whether it renews by itself is undocumented, so it's shown as "Claude reports login ends …". (tested by Codex)
- `codex login status` says logged in, with no expiry. (tested by Codex)

## Proposed (in the draft instruction)
- Leftover record and checks: Claude, corrected by Codex (not in this server's lists; whole process group; "unverified" when the leader is gone).
- Known limit (Codex): a crash between starting a program and recording it leaves it unseen.
- Intervals (Claude): login every 10 minutes, leftovers every minute.
