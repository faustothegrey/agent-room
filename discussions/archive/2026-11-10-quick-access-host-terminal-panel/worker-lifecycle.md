# Terminal pane: Reload, Restart, Shutdown, two rooms, failure cases (worker, 2026-11-10)

On top of `bf79144`. The commit ID is in the worker's reply.

**Setup:**
- macOS 26.6.2 (Intel x64), Node 24.14.1, zsh.
- A test server on port 5802 with two rooms (`a`, and `b` added with `--room`), each its own Git
  folder in `/tmp`, with a fake `claude`.
- Pages ran in Playwright's `chrome-headless-shell` 1228, each with its own fresh profile,
  driven over DevTools.
- Each shell ran `sleep <unique number> &`, so a leftover shell is found by that number in any
  process, even after Restart.
- Every run ended with no server, no marker process and port 5802 free.
- Linux was not used for these tests.

## README
`src/host-shell.mjs` was added to the source map: "The Terminal pane's shell: token endpoint,
WebSocket, host-only checks and shell lifetime."

## Results

| Case | Before any fix | After the fixes |
|---|---|---|
| **Reload** (Server ▸ Reload) with a shell open | The shell keeps running and the pane stays connected. The page doesn't reload (its code is unchanged), and typing still works. Both rooms log "Reloaded the code…" | unchanged |
| **Restart** (two clicks) with a shell open | **Restart never finished.** After 9 s the rooms had logged "Room ended", but the old server was still running, and so were the shell and its `sleep`, with the pane still connected. The cause: Restart calls `closeAllConnections()` and waits for `server.close()`, but a WebSocket's socket leaves the server's own connection list, so the close waits for the pane forever | "Restarting: a new process takes over the server." The old shell and its `sleep` ended; a new server took over. The page reloaded itself, with the pane collapsed. Reopening it started a fresh shell from the new server |
| **Shutdown** (two clicks) with a shell open | "Server ended."; no server, shell or `sleep` left. The pane showed "Connection closed. Collapse and open the pane for a new shell." | unchanged |
| **Two rooms on one server**, a shell in each | Each pane's shell had its own pid and was in its own folder (checked with `lsof` cwd: `…/a` and `…/b`). Text typed in a showed in a and not in b. Collapsing a left b working, with 1 shell under the server | unchanged |
| **`SHELL=/nonexistent/shell`** | `pty.spawn()` doesn't throw for this on macOS (nor for a missing cwd, a NUL in the path or a NUL in the environment; all checked directly). The child exits with 1. The pane showed "Shell exited (code: 1)" and "Connection closed…"; the server kept running | unchanged |
| **`pty.spawn()` throwing**, forced by removing execute permission from `@lydell/node-pty-darwin-x64/spawn-helper` (restored afterwards) | **agent-room crashed**: `Error: posix_spawnp failed.` was uncaught, the whole server ended (no `/__health` answer), and the pane only showed "Connection closed…" | The pane shows "The shell did not start: posix_spawnp failed." and "Connection closed…". The server logs `[terminal] the shell did not start: …` and keeps running (`/__health` 200) |
| **Collapse while loading** | 1) Collapsing right after opening, on the first load: **the collapse became a second opening**; the pane stayed open with a running shell. 2) Collapsing 20 ms after opening, module cached: worked, no shell. 3) Collapsing during a slow module download (DevTools throttling: 800 ms latency, 200 kB/s, no cache): **pane open, 1 shell**. 4) Collapsing during the token fetch (1.5 s latency): **pane open, 1 shell**. The cause: the page only counted the pane as open after the module loaded, so a click before then opened it again | All four: the pane is collapsed and 0 shells. A final reload: 0 shells |

## What changed, and why
Changes were made only where a test above showed a crash or a leftover shell. No crossed shell
was found.
1. **`src/host-shell.mjs`, the crash.** Importing `@lydell/node-pty` and `pty.spawn()` are now
   inside one try/catch. The error is sent to the pane, the socket is closed, and the error is
   logged. If the pane's socket already closed while the shell was starting, the new shell is
   killed at once.
2. **`src/ui.mjs`, Restart.** The server keeps the upgraded (WebSocket) sockets in
   `hub.upgraded`, and Restart destroys them before `server.close()`. Their `close` handler
   then kills the shells.
3. **`src/docs.mjs`, collapsing while loading.** The pane counts as open from the first click
   (`hostShell` is set before the module is imported). A click while it loads collapses it, and
   each loading step (module and init, token, WebSocket) stops if it was collapsed meanwhile.

`npm test`: 153 of 153 pass. The existing tests were not changed.

## Not tested
- Quit room with a shell open.
- Reload while a page's code changed (then the page reloads itself, which closes the socket;
  not run).
- Restart and these failure cases on Linux.
- Closing the WebSocket itself (rather than the pane) while loading. The socket doesn't exist
  until the token is in; the server-side check in change 1 covers a socket closing while the
  shell starts, but I didn't make that timing happen in a test.
