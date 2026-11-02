# Proposal: start agent-room from a Dock icon

> **Historical archive — 2026-11-02.** The launcher and --open are implemented; the approval request below is historical. Earlier status labels and next steps below describe the original discussion, not current work. See [the discussions index](../README.md).

**Status:** proposed, awaiting the User's approval.
**Prepared by:** Claude, with Codex, 2026-10-21.

## Decided (by the User, 2026-10-21)
- The Electron app is deferred (`electron-app.md`).
- What's needed: one click on an icon starts agent-room and shows its screen, without opening a
  terminal and typing `npm start`.
- The icon always starts the room in the agent-room folder, for now.
- A second click while a room is running may do nothing, if that keeps it simpler.

## Proposed (Claude and Codex)
- A tiny macOS app made with Script Editor or Automator (part of macOS, no new dependency). It
  runs the same command as `npm start`, in the same folder, and writes the log to a file.
- A small code change: today the screen opens only when started from a terminal
  (`src/ui.mjs:70`, documented in the comment at line 55). From an icon, nothing would appear.
  Add an option (e.g. `--open`) that opens the screen anyway.
- If startup fails, show a macOS alert with the error, not just a log line.
- Stopping: the screen's Quit already ends the room; no terminal needed.

## Uncertain (untested)
- **Finding `node`, `claude`, `codex`:** Dock-launched apps don't get the terminal's settings.
  `zsh -lc` reads login settings (`.zprofile`) but not `.zshrc` (Codex). Must be tested from a
  real icon launch.
- **Clicking twice:** a running script app may simply come to the front instead of starting a
  second room. Untested; the implementer should check it doesn't start a second room.

## Open questions for the User
1. Approve this proposal for implementation (outside this room)?

## Not included
Electron, a folder chooser, an address file, auto-start at login.
