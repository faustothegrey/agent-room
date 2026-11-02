# Proposal: agent-room as an Electron app

> **Historical archive — 2026-11-02.** Deferred in favor of the implemented Dock launcher; this is not an active implementation request. Earlier status labels and next steps below describe the original discussion, not current work. See [the proposal index](../README.md).

**Status:** proposed, awaiting the User's approval.
**Prepared by:** Codex, 2026-10-21, following discussion with the User.

## Purpose

Make agent-room a desktop app that opens directly into its existing discussion screen:
conversation on the left, an optional shared Markdown document or SVG drawing on the right.
Keep the app small enough to read in one sitting.

## Decided and requested

- The existing product goal remains: help a human and multiple AI agents discuss and revise
  ideas around a shared document or drawing, keeping the conversation and its subject visible
  together.
- The User requested a proposal for converting agent-room to Electron. Implementation,
  dependencies and behavior changes have not yet been approved.

## Proposed first version

- A macOS app for the owner's own use, launched from Finder or the Dock.
- Keep the existing chat, document selection, live document updates, usage display and agent
  turn-taking. Keep agent CLI subscriptions and existing authentication.
- Choose the project working directory in the app. Use its `proposal/` directory for shared
  documents. Make the transcript destination visible and writable outside the app bundle.
- Show clear errors when Claude or Codex cannot be found or launched.
- Keep agents headless: no embedded terminals in this conversion.
- No automatic updates, Windows/Linux packaging, new workspace system or new UI framework in
  the first version.

These are Codex's recommendations, not User decisions.

## Architecture

**Proposed, Codex; supported by Claude:** keep the existing HTTP server and load its
local discussion screen in an Electron window for the first desktop version. This preserves
browser access for inspecting agent-room's own UI and reuses the existing viewer and transport.
The User has not approved this recommendation or selected Electron over a simpler Dock launcher.

```text
Electron window or browser
  chat + composer                 document pane
          |                            |
          +------- existing HTTP ------+
                          |
Existing server and room
  room loop · provider adapters · proposal files · transcript · usage
                          |
                 installed Claude / Codex CLIs
```

Keep the current two-second document-change check and existing HTTP POSTs and server-sent
events initially. Electron still needs desktop startup, folder selection, CLI discovery and
shutdown handling. Keep the renderer without direct Node.js access and context isolation enabled;
displayed agent messages and proposal content must not gain access to privileged app operations.

**Possible later, not planned:** replace HTTP with a narrow preload API and IPC events if an
observed need justifies the additional work. That would also require preserving relative document
resources and deciding whether browser access should remain available.

### Reuse and expected changes

| Current source | Expected treatment |
|---|---|
| `src/agents.mjs` | Reuse adapters; handle locating CLI executables in a desktop launch environment |
| `src/room.mjs` | Reuse turn-taking and conversation state |
| `src/usage.mjs` | Reuse usage accounting and optional external quota-meter request |
| `src/ui.mjs` | Connect desktop startup and shutdown to the existing room lifecycle |
| `src/docs.mjs` | Reuse the existing rendering, HTTP transport and file serving |
| `src/cli.mjs` | Retain if terminal mode is kept; Electron needs its own startup entry point |

Removing our embedded server does not remove the optional HTTP request to the separate local
quota meter. Quotas remain best-effort when that service is unavailable.

Electron and packaging tooling add dependencies. The project requires the owner's agreement
before adding modules, dependencies, configuration systems or processes; approval of a concrete
minimal implementation scope is needed before implementation.

## Why no embedded terminals

Agent-room currently starts a CLI per turn, resumes its saved provider session and consumes a
structured final answer and usage. That supports the shared conversation and automatic turn
coordination directly.

Vibeyard's inspected source uses Electron, `node-pty` for persistent interactive processes and
`xterm.js` for terminal display, connected through IPC. That is useful for direct CLI interaction,
but introduces keyboard, resizing, process-lifecycle and output-handling responsibilities.
Replacing our structured adapters with terminal output would also require a reliable way to
identify completed replies and usage. It is a separate product change, unnecessary for a desktop
window around the discussion room.

Source inspected, not run: [Vibeyard process manager](https://github.com/elirantutia/vibeyard/blob/main/src/main/pty-manager.ts),
[terminal pane](https://github.com/elirantutia/vibeyard/blob/main/src/renderer/components/terminal-pane.ts),
[IPC handlers](https://github.com/elirantutia/vibeyard/blob/main/src/main/ipc-handlers.ts).

## Tradeoffs

- A desktop window provides one entry point and native folder selection, while adding Electron
  runtime, packaging and release maintenance. Resource use is unmeasured.
- Keeping HTTP preserves browser inspection and avoids adapting the viewer transport. It also
  keeps the existing local listening port.
- A possible later IPC conversion would require adapting document resources; retaining browser
  mode alongside it would mean maintaining two transports. No such conversion is proposed now.
- Finder launches need explicit CLI discovery and project-path handling; the current terminal
  environment cannot be assumed.
- Window closure, Quit and interrupted agent turns need an explicit policy. Provider session
  resumption is not the same as recovering a running process after an app crash.

## Effort estimate

Engineering estimates from reading the current code; no Electron prototype has been built.
Assumes macOS only, existing CLIs already installed and authenticated, and no UI redesign.

| Deliverable | Estimated effort |
|---|---:|
| Proof of concept showing the current screen in Electron, potentially retaining HTTP | 0.5–1 working day |
| Usable personal macOS app retaining the existing server | 2–4 working days total |
| Usable personal macOS app using IPC and no embedded server | 3–5 working days total |
| Signing, notarization and distribution preparation | Add 1–3 working days, assuming credentials are available |

The IPC version has a larger allowance than the initial wrapper estimate because document
resources and the communication layer must be adapted. CLI discovery, document isolation and
shutdown behavior are the main uncertainties. These ranges are not measured completion times.

Electron documents packaging and signing as separate distribution work:
[packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging),
[code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Verification before calling it done

- Run `npm test`; preserve existing test contracts. Ask before changing tests tied to an
  approved behavior change, including HTTP-specific contracts if the server is removed.
- Launch the packaged app from Finder, not only a development terminal.
- Run real Claude and Codex turns; check turn order, passes, addressed messages, failures,
  transcripts and usage.
- Pick Markdown and SVG files, check relative images and links, and verify live edits while
  agents are talking. Check that displayed content cannot invoke privileged app operations.
- Check missing CLI errors, project paths with spaces, folder cancellation and quota-meter
  unavailability.
- Check Quit and window closure during an agent turn, including child-process cleanup.
- Verify the approved Reload behavior and terminal/browser modes, if retained.

Baseline observed on 2026-10-21: `npm test` passed 46/46 before this proposal. No packaged app,
Electron prototype or live provider interaction has been checked for this conversion.

## Decisions needed before implementation

1. **Platform and audience:** accept macOS for personal use as the first version?
2. **Existing modes:** retain terminal mode? Retain browser mode? Proposed: keep terminal mode and browser mode,
   and add an Electron wrapper around the existing server. A Dock launcher remains a smaller
   alternative, pending the User’s explanation of what they want to improve.
3. **Startup:** choose the working directory each launch, or remember the last chosen folder?
   Proposed: remember it and offer a folder choice before starting a new room.
4. **Close behavior:** what should closing the last window do during a turn? Proposed: ask before
   ending an active room, then stop its agents and flush the transcript. No background room in
   this first version.
5. **Reload:** keep development hot reload, or replace it with restarting the app? Proposed:
   preserve `/reload` where practical in development; agree on packaged-app behavior before
   implementation. A desktop conversion alone does not authorize dropping it.

## Not included

Embedded terminals, multi-project rooms, background sessions, automatic updates, provider
installation/login management, live application previews and DiagramTalk integration.
