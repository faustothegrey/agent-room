# Handoff: teleporting agent-room sessions (written 2026-11-07 by Claude)

## Delivery
- Status: **pending**
- Read by receiving session:

## Why this handoff exists
The User is restarting the Mac room with `--node Mac --peer charon=…` to start the first real
Mac + charon replication test. The restart gives the agents fresh sessions.

## Where things stand
- `main` and origin are at `b518f87` (Stage B, summary template, pending-instructions rule in
  the brainstorming rulebook, and the lan-page-uuid fix). `npm test`: 102 passed, 0 failed
  (Codex, 2026-11-07).
- lan-page-uuid: charon's page opened from the Mac stuck at "Connecting to the server…"
  because `crypto.randomUUID` is missing on plain-HTTP LAN pages. The worker fixed it in
  `b518f87` (fallback to `crypto.getRandomValues`); Codex reviewed and merged it.
  Charon's page after the pull: see the item below.
- Discussion documents and `discussions/README.md` are deliberately uncommitted: discussions
  reach charon through room replication, not origin (`rollout.md` section 3).
- Charon (`192.168.178.70`) is at `b518f87` and restarted; its page opened from the Mac now
  shows "connected to server" (User, 2026-11-07). Not yet paired. It runs:
  `npm start -- --node charon --peer Mac=http://192.168.178.112:5566`. Its startup log said
  `Peer Mac: unreachable (… "This room "... is not valid JSON)`: the Mac room answered
  "This room doesn't replicate." (`src/docs.mjs:1123`) because it was still started without
  `--node`. So the network path charon → Mac works; the error should go after the Mac restart.
  Not yet checked: charon's `git status` clean (User only reported no errors).
- Codex checked the Mac process: it has no `--node` or `--peer` arguments, consistent with
  the error above. A Mac → charon HTTP probe returned status `000` (no HTTP response), so
  that direction is **not yet verified**; investigate if it persists after restart. (Later,
  Claude loaded charon's page in the Mac's Chrome, so Mac → charon HTTP does work in the browser.)
- Mac is `192.168.178.112`. The Dock launcher can't pass peer arguments
  (`scripts/dock-launcher.applescript:40` runs `npm start -- --open`), so for this test the
  User starts the Mac room from Terminal:
  `cd ~/Software/agent-room && npm start -- --node Mac --peer charon=http://192.168.178.70:5566`.
  Adding the arguments to the launcher (and rebuilding it per README "macOS Dock launcher")
  waits until the flow is validated.
- Charon's server is run from a terminal for now; the User will make it a systemd service after
  the flow is validated (run it as the user signed in to `claude`/`codex`; set `PATH` and
  `WorkingDirectory`: from memory, untested).
- Stage C (Continue here, reconciliation, Fork) is **not authorized**.

## Unsent instructions for the worker
None.

## Next step for the new session
- **Do (User):** after the Mac restart, check the Mac's log shows `Peer charon` reachable, then
  **Pair with …** once in the Peers section, and confirm both rooms show the same project.
- Later, in order: the `rollout.md` section 4 Stage B checks (Mac round appears on charon and
  **View** is read-only; a deleted drawing disappears on charon; charon stopped → Mac round →
  charon restarted → round arrives, Mac never waited); record memory/transfer measurements or
  "unmeasured"; then charon's systemd service.
