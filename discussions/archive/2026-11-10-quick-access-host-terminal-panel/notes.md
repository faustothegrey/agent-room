# Quick-access host terminal panel

**Status (2026-11-10): merged by the User; discussion closed.** Final work on `worker/main`: `bf79144` (demo-based pane), `049ec6f` (lifecycle fixes), `a5f09bd` (regression tests), `42c98c1` (Quit room ends that room's shells). Still untested: Linux lifecycle cases, a real (non-headless) browser, closing a discussion with a shell open.

## Decided (by the User)
- A terminal pane **inside agent-room's own layout**, for **small ad hoc tasks**.
- Placement: a **collapsible pane just below the Explorer/Document pane**. See [drawings/decided-layout.svg](drawings/decided-layout.svg).
- **Host only**: no access from other devices on the LAN.
- **No persistence**: collapsing the pane, reloading the page or stopping the server ends the shell; opening the pane starts a fresh one.
- **Display: [ghostty-web](https://github.com/coder/ghostty-web)** (Ghostty's terminal engine in the browser, MIT, `npm install ghostty-web`, ~400 KB, no published releases yet; untested). Chosen over xterm.js, which the User found limited.

## Constraint
- agent-room's server listens on `0.0.0.0` with no authentication (documented, `README.md`, "Working on the project"). Hiding the pane is not protection: every shell endpoint (start, input, output) must refuse requests from other devices, from other websites open on the host (including DNS rebinding), and requests with no Origin header. A per-page token is a candidate, not assumed safe; a LAN device must not be able to obtain it by loading the room page.

## Implementation (under discussion)
Display decided (above). Two parts still have candidates (Claude, Codex):
1. **Pseudo-terminal on the host:** the system `script` command (no new npm dependency; assumed, untested) or `node-pty` (native module, needs compiling).
2. **Connection:** the server's existing server-sent events (`src/docs.mjs`) for output plus POST for keystrokes, or an alternative if too slow (untested).

Codex: choose none of these until a small test checks interactive programs, resizing, latency and leftover processes.

## Test results (worker, tested; details in [test-report.md](test-report.md) and [worker-step1.md](worker-step1.md))
- First attempt (`f8bddb0`, `test-report.md`) completed despite the timeout: both backends, macOS in headless Chromium, Ubuntu x86_64 with a Node client (no Linux browser).
- Both backends handled colours, Ctrl-C, resize, vim, top. `script`: no dependency, but needs platform-specific resize (`stty -f`/`-F`) and cleanup; on Linux a force-killed server leaves the shell running. `node-pty`: handles that, but on macOS needs a `chmod +x` fix and on Linux compiles.
- Streaming + POST: median ~11 ms keystroke-to-echo on the Mac; no alternative tested.
- First attempt's protection (loopback peer, Host, exact Origin, JSON, token from start response) refused LAN, cross-origin and DNS-rebinding cases tried. Not a full security review; other programs/OS users on the host can still start a shell. Pane only appears when the room is opened on 127.0.0.1/localhost.
- Step 1 (`cc6bdd5`) replaced that with a token-in-page + custom header design, untested against other websites.

## Decided (by the User, 2026-11-10): do it as the ghostty-web demo does
- Demo server (`demo/bin/demo.js`, `demo/bin/auth.js` in [coder/ghostty-web](https://github.com/coder/ghostty-web/tree/main/demo), read, not run): `@lydell/node-pty` for the shell, `ws` WebSocket at `/ws`, a random token from `GET /api/token`, Host must be `localhost`/`127.0.0.1`/`::1`, WebSocket Origin must match Host (missing Origin refused there; allowed on `/api/token`), shell killed when the socket closes.
- **Gap for agent-room (Claude, from reading the code):** the demo has no remote-address check; it is safe because it binds to `127.0.0.1` by default. agent-room listens on `0.0.0.0`, and a LAN device can forge the Host header (no browser involved), fetch the token and open the socket. Copied as is, it would expose the shell to the LAN. Proposed fix, following the User's host-only decision: add the loopback-peer check from the first test (`f8bddb0`) to both endpoints, and test the adapted design.
- New dependencies: `@lydell/node-pty`, `ws` (agent-room has one today), covered by the choice to follow the demo (Codex's reading, accepted by Claude; the User can object).

## Proposed after the tests (superseded by the decision above)
- Claude: build on the first attempt's protection; prefer `script`.
- Codex: review the first design and its lifecycle handling before choosing a backend or merging either experiment.

## Pending
- Worker test instruction: [pending-instructions.md](pending-instructions.md) (not sent).
