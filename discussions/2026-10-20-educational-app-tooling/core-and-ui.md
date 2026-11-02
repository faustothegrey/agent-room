# One codebase: conversation core, terminal, and a future UI

> **Deferred research — 2026-11-02.** Kept for possible future work, not the current implementation plan. Product descriptions and external research below are historical and have not been rechecked. See [the discussions index](../README.md) for current work.

> Outside the current implementation cycle (2026-10-20); see `../2026-10-20-discussion-ide/discussion-ide.md`.

Discussion of 2026-10-20 between the User, Claude and Codex. Nothing built, tested or measured.
Follows `agent-room-visual-harness.md` (live preview) and `crit-vibeyard.md` (tool research).

Sign-off (agents, not a User decision): Claude, 2026-10-20 · Codex, 2026-10-20

## What the User wants (stated 2026-10-20)
- Launch sessions in the background, even unattended, and **attach remotely**.
- Keep the smoothness of local development, e.g. a proper terminal window.
- Avoid extra complexity: "it has stung me before".

## User's direction (2026-10-20, stated as "maybe… thoughts?", so not yet final)
- Keep **everything in one codebase**, with the source well separated between the
  **core terminal** (the core) and the **UI** part. This replaced the User's earlier idea
  of a separate project built on top of agent-room.

## Evidence
- **Vibeyard** (documented, not installed): a desktop app (Electron) with real terminals
  (each session its own PTY; uses `@xterm/xterm` and `node-pty`). The README documents peer-to-peer
  session sharing with teammates (read-only or read-write, PIN). Background or unattended
  running and attaching from a plain browser are not documented; that doesn't prove
  they're absent (Codex correcting Claude). Terminal smoothness needs hands-on testing.
  Sources: [README](https://github.com/elirantutia/vibeyard/blob/main/README.md),
  [package.json](https://github.com/elirantutia/vibeyard/blob/main/package.json).
- **agent-room today** (read from the code, not run):
  - `src/room.mjs` (round loop) imports nothing and reports through callbacks; `src/agents.mjs`
    runs the agent CLIs. Neither draws anything. `src/ui.mjs` is the terminal screen,
    `src/docs.mjs` the proposal viewer (local-only).
  - The whole conversation lives in memory in one process (`ctx.state`, `ctx.sessions` in
    `src/cli.mjs`). No handling for the terminal closing: most likely the room ends with it
    (assumed). The Markdown transcript is saved but never read back.

## Proposed by agents
```
core:     room.mjs + agents.mjs     turns, messages, agents. No screens, no browser.
screens:  ui.mjs (terminal)  +  a future web UI (preview, remote)
alive:    something keeps the running room alive while no screen is attached
```
- **Boundary** (Codex, softening Claude's "no changes to room.mjs"): the core knows about
  turns, messages and agents; it knows nothing about browser connections, page layout or
  terminal drawing. A UI may reveal a missing core operation; adding one is allowed, but
  follow the project rules: ask before changing relied-on behaviour or adding a module,
  dependency, config system or process.
- **The terminal stays a complete way to use agent-room**, with or without the web UI (Codex).
- **Staying alive is its own job** (Codex): separating the code doesn't provide it. Closing
  a screen must leave the room running; reconnecting must show the current state, including
  a question waiting for the User, without starting another room.
- **Zero-change baseline first** (Claude): run unchanged agent-room inside tmux and reach it
  over SSH (from memory, untested). Compare anything we build against this baseline.
- **Restart recovery is out of the first step** (Codex): saving and reloading room state
  is a separate capability, and wouldn't restore an agent command that was running.
- **No plugin framework or general UI abstraction** (both).

## Acceptance check (proposed)
Start in the normal terminal → disconnect → reconnect remotely → return locally to the
**same** room, including any question waiting for the User. Then check ordinary terminal use
still works without the web UI. Preview integration comes only after this works.

## Open questions for the User
1. Is the one-codebase split your decision now, or still being considered?
2. When remote, do you need to **see the preview**, or is following the conversation enough?
3. Does "remote" mean another laptop, your phone, or any browser?

## Unresolved disagreements
None about the proposed architecture. Claude and Codex previously interpreted the earlier
live-preview decision differently; that distinction does not change this joint proposal.
The User's final choice remains open as recorded above.
