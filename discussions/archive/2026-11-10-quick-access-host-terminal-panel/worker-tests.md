# Terminal pane: automated tests, and Quit room (worker, 2026-11-10)

On top of `049ec6f`. The commit ID is in the worker's reply. The only change is the new file
`test/host-shell.test.mjs`. `src/` is unchanged, the existing tests are unchanged, and no
dependency was added (the tests use `node:test`, and `ws`, which is already a dependency).
`npm test`: **159 tests, 159 pass** (153 before + 6 new).

## The new tests
A test can't connect from a LAN address. So the address, Host and Origin cases call
`handleShell` and `handleUpgrade` directly, with fake requests: a socket with any remote address,
and any headers. The token and shell cases use a real server on 127.0.0.1 with the `ws` client.

1. **A non-loopback address is refused, even with a forged Host, Origin and the real token.**
   - Addresses `192.168.1.20`, `10.0.0.5`, `::ffff:192.168.1.20`, `fe80::1`, each with Host
     `127.0.0.1:5566`, Origin `http://127.0.0.1:5566` and the real token.
   - Token: 403 "not from this computer", and 403 with Host `localhost`.
   - WebSocket: 403.
   - The same requests from `127.0.0.1` and `::1` get the token, so the address is what was
     refused.
2. **A Host other than localhost, 127.0.0.1 or ::1 is refused.**
   - `localhost`, `127.0.0.1`, `[::1]`, `LOCALHOST` and no port: 200.
   - `rebind.example`, `192.168.1.20`, `localhost.evil.example`, `127.0.0.2`, `mac.local`: 403 on
     the token and on the WebSocket (with a matching Origin and the token).
   - Malformed (empty, leading space, port 99999, port `x`, `[::1`, `user@…`, no Host header):
     400.
3. **The WebSocket needs an Origin matching Host.**
   - No Origin: 403.
   - `http://evil.example`, `http://localhost:5566` (other name), `http://127.0.0.1:8080` (other
     port), `http://127.0.0.1` (default port): 403 on the WebSocket and on the token.
   - Unparsable Origins (`null`, a path, `file://`, not a URL): 400.
   - The token endpoint with no Origin: 200 (as in the demo). With a matching Origin: 200.
     POST: 405.
4. **A missing or wrong token gets 401 on the WebSocket:** no `token`, empty, `wrong`, the real
   token with its last character changed, and the real token plus one character.
5. **A shell that fails to start is reported, and the server keeps answering.**
   - The real server is given a working folder node-pty refuses (`{}`), so `pty.spawn()` throws
     `cwd must be a string`.
   - The WebSocket client receives "The shell did not start: …cwd must be a string…", then the
     close.
   - A token request afterwards still gets 200.
   - 10 s timeout.
6. **With the token and a matching Origin, the WebSocket runs a shell.** With `SHELL=/bin/sh`,
   `echo shell-$((6*7))` comes back as `shell-42`. Closing the socket ends it. 10 s timeout.

**Checked that they would catch a regression.** I broke `src/host-shell.mjs` three times,
temporarily, and restored it from a saved copy each time:
- With the loopback check removed, test 1 fails.
- With the token comparison removed, test 4 fails.
- With the try/catch around `pty.spawn()` removed, test 5 fails. On the first try it **hung
  instead of failing**, because the socket never closed. The real-server tests now have a 10 s
  timeout, and with it the check fails in about 60 ms.
- That first try was stopped by my 120 s command limit, which left the broken file in the
  worktree. I found it in the next turn: the saved copy matched `HEAD` and the diff showed the
  broken line. I restored it. `src/` now matches the commit.

## Quit room with a shell open
Tested by hand-driven browser (headless Chromium, fresh profiles), macOS, test server on port
5802, with a `sleep <marker>` in each shell.

- **Two rooms, a shell open in each, Quit room a:**
  - Room a logged "Room ended". The server kept running for room b.
  - **Room a's shell and its `sleep` kept running.** Room a's pane stayed connected
    (WebSocket open) and still showed its prompt.
  - Room b's shell was unaffected and still worked.
  - Room a's shell only ended when its browser page was closed.
- **One room, a shell open, Quit room:** "Room ended", "Server ended". The shell and its `sleep`
  ended, and the pane showed "Connection closed…". Nothing was left.

So **Quit room leaves that room's shell running while other rooms keep the server up.** I didn't
change this: the instruction asked for a report, and fixing it changes Quit room's behaviour. A
likely fix: Quit room closes the WebSockets of that room's panes, as Restart now does for all of
them. That needs the shells tracked per room.

## Fixed: Quit room's shells (later commit)
- **The fix (`src/ui.mjs`):**
  - `upgrade()` records each Terminal pane's socket on its room (`ctx.upgraded`).
  - `stopRoom()` (which every room end goes through: Quit room, a closed discussion, Restart,
    Shutdown) destroys them first, and their shells end.
  - Other rooms' sockets are untouched.
- **New test** in `test/host-shell.test.mjs`:
  - It runs the real server with two rooms and a fake `claude`, opens a pane WebSocket to each,
    and posts `/quit` to room alpha.
  - Checked: alpha's socket closes and its shell process is gone; beta's socket stays open, its
    shell still answers, and closing beta's pane ends its shell.
  - With the fix removed, it fails ("room alpha's pane socket closes").
- `npm test`: 160 of 160.
- **By hand** (headless Chromium, two rooms, `sleep` in each shell), Quit room a:
  - room a's shell and `sleep` ended (`[terminal] shell ended`), and its pane showed "Connection
    closed…";
  - room b's shell kept running and still worked.
- Restart and Shutdown, rerun: unchanged (no shell left; after Restart, reopening gives a fresh
  shell).
