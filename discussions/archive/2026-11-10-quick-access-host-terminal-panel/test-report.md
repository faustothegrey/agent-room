# Host shell pane: throwaway test report (worker, 2026-11-10)

The test code is on `worker/main` (commit in the worker's reply). It is **off** unless the server is
started with `AGENT_ROOM_HOST_SHELL=script` or `AGENT_ROOM_HOST_SHELL=node-pty`. With the variable
unset, `__shell/…` answers 404 and the pane never appears (checked). It is not meant to be merged
as is.

- `src/host-shell.mjs` (new): pseudo-terminal (two backends), the endpoints and the checks.
- `src/docs.mjs`: one route line, the pane's markup, CSS and page script (marked THROWAWAY TEST).
- `package.json`: `ghostty-web@^0.4.0`. `node-pty` was installed with `--no-save`, so it is not in
  `package.json`.

## Systems tested
- **macOS 26.6.2**, Intel (x64), Node 24.14.1, login shell zsh (the User's own config). This was
  the full test: the room server, the page in headless Chromium (Playwright's
  `chrome-headless-shell` 1228) driven over DevTools, and screenshots.
- **Linux: Ubuntu 22.04.5**, x86_64 (peer84), Node 24.15.0, bash, util-linux `script` 2.37.2. The
  room server ran there, with a Node client standing in for the page (no browser on Linux). The
  work was in `/tmp` only and was deleted afterwards. peer84's own npm (5.5.1) crashes on Node 24,
  so a current npm (10.9.10) was copied into the temp folder.
- **Debian 13 (peer70)**: only checked that util-linux `script` is 2.41. It has no Node, so
  nothing was run there.
- **Untested:** a Linux desktop browser, headed Chrome, Safari or Firefox; Apple Silicon; other
  BSDs; Windows.

## Display: ghostty-web 0.4.0
- Served with **no build step**. The page loads it with
  `import('./__shell/ghostty-web.js')`, and the server reads the file straight from
  `node_modules/ghostty-web/dist/`.
- **The WebAssembly file is inside that JS file** as a base64 data URI (`ghostty-vt.wasm`,
  423 KB), so no separate wasm address is needed. A tiny `__vite-browser-external-….js` helper is
  served too, but only file-protocol loading would use it.
- The JS file is 682 KB uncompressed.
- The API is xterm.js-like: `init()`, `Terminal`, `FitAddon` (`fit()`, `observeResize()`),
  `onData`, `onResize`, `write`.
- Rendered fine in headless Chromium. No page errors were logged in any run.

## Pseudo-terminal: `script` vs `node-pty`

| | `script` (system command) | `node-pty` 1.1.0 |
|---|---|---|
| npm dependency | none | native module |
| Install on macOS x64 | n/a | ready-built binary. **But its `spawn-helper` is installed without execute permission**: the first spawn fails with `posix_spawnp failed` until `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` |
| Install on Linux x86_64 | n/a | no ready-built Linux binary: **compiles** (make, g++, python3), ~23 s on peer84 |
| Start, macOS | Node's own pipes don't work: `script: tcgetattr/ioctl: Operation not supported on socket`. Works with `cat` piping into it | works |
| Start, Linux | works (`script -q -f -c '<shell> -l' /dev/null`, fed through `cat` too) | works |
| Initial size | 0×0 (both systems); set from outside with `stty -f` (macOS) / `stty -F` (Linux) on the shell's terminal, found with `ps` | given at spawn |
| Resize | the same stty call (the kernel sends SIGWINCH): works on both | `resize()`: works on both |
| Server killed with `kill -9` | macOS: nothing left. **Linux: `script`, the shell and its program keep running** | nothing left on either |
| Stop on Linux | **a TERM of `script`'s process group leaves `script` and the shell running**; a SIGHUP to the shell's own session ends both (the test code does that) | `kill('SIGHUP')` |

## Connection: server-sent events + POST
- Output is one **streamed POST response in server-sent-event format** (`data: <JSON string>`),
  read with `fetch` in the page.
- Input, resize and start are JSON POSTs. Input goes one request at a time: what is typed while
  one is in flight goes in the next.
- Why POST rather than `EventSource`: a POST lets the output stream require the same
  Origin/JSON checks as the other endpoints.
- **Typing latency**, measured in the page from sending a keystroke to its echo arriving. This
  includes zsh redrawing its line. 150 keystrokes 100 ms apart, per backend, on the Mac:
  - node-pty: median **10.8 ms**, p90 17.7, p99 20.9, max 25.6
  - script: median **11.3 ms**, p90 17.8, p99 39.2, max 60.1
- Linux, measured by the Node client on the same machine (no browser), with bash: median
  **3.9 ms**, p90 4.2, in both modes.
- That is fast enough, so **no alternative connection (e.g. WebSocket) was built or tested.**
- One earlier node-pty run had a single 2.5 s outlier, which I didn't reproduce in the
  150-keystroke runs. Its cause was not found.

## Interactive checks (macOS, in the page; both backends unless noted)
- **Colours:** 16-colour, 256-colour and truecolour, plus `ls -G`, render correctly (screenshot).
- **Ctrl-C:** interrupts `sleep 30`; `$?` = 130.
- **Resize:** narrowing the window refitted the terminal from 104 to 81 columns, and `stty size`
  inside the shell agreed. vim redrew when the window was widened again.
- **vim** (`vim -u NONE -c "syntax on"`, script backend): editing works, syntax colours show, and
  `:q!` returns to a working prompt. Under node-pty, vim opened and drew; I didn't repeat the
  screenshot there. vim with the User's own `.vimrc` is untested.
- **top:** draws and `q` returns to the prompt. On this Mac `top` takes about 2–2.3 s to draw its
  first screen (with either backend).
- **Linux** (client, both backends): sizes 24×80 → 30×100 after a resize; colour escapes pass
  through; Ctrl-C gives 130; `vi` (vim.tiny) draws and quits; `top` draws and `q` quits. Rendering
  in a Linux browser is untested.

## Lifetime
- **Opening the pane** starts a fresh shell, in the room's folder, with `$SHELL -l`,
  `TERM=xterm-256color` and `COLORTERM=truecolor`.
- **Collapsing the pane** aborts the output stream, and the server ends the shell when the stream
  closes.
- **Reloading the page or closing the browser** closes the stream the same way.
- **Checked on the Mac, both backends:**
  - After three reloads (each reopening the pane), still only one shell was under the server.
  - After collapsing, nothing was under the server; reopening started one fresh shell.
  - After closing the browser, nothing was left.
- **Checked on Linux, both backends:** nothing was left after the client closed its stream.
- **A shell whose output is never opened** within 10 s is ended (two shells started with curl:
  both gone).
- **Server stop**, with a shell open and running `sleep`:

  | Server stopped by | macOS script | macOS node-pty | Linux script | Linux node-pty |
  |---|---|---|---|---|
  | Ctrl-C (SIGINT) | ended | ended | ended | ended |
  | SIGTERM | ended | ended | ended | ended |
  | SIGKILL | ended | ended | **left running** | ended |

  INT and TERM are handled in host-shell.mjs: it ends the shells, then re-raises the signal so
  the default exit still happens.
- **Untested:** the server's Reload or Restart with a shell open (host-shell.mjs is imported
  without the reload version suffix, so its shell list should survive a Reload); Shutdown from the
  page (it goes through `process.exit`, which the exit hook covers, but I didn't run it); several
  rooms on one server.

## Protection
Every shell request (start, output, input, resize) must pass all of these:
1. **From the host itself:** the TCP peer address is loopback (`127.0.0.1`, `::1`,
   `::ffff:127.0.0.1`).
2. **Host header** is `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, with this server's
   own port. This blocks DNS rebinding.
3. **POST, with an Origin header that exactly equals `http://<Host>`.** A missing Origin is
   refused.
4. **`content-type: application/json`.** Cross-site forms and no-cors fetches can't send that
   without a CORS preflight, and the preflight is refused.
5. **Token:** after start, a random 32-byte token and a shell id, returned only in start's
   response, are required.

The token is never in the page HTML. The page is a static constant, identical for every client,
and the token lives only in the page script's memory. The library file needs checks 1 and 2 only.

**The token alone is not the protection; checks 1–4 are.** Start is open to any client on the host
that sends the right headers. The token only stops other pages and programs on the host from
driving a shell that someone else started.

**Requests and how each was refused** (HTTP 403 and the reason, as returned and logged):

| Request | Result |
|---|---|
| From this Mac with curl: valid start | 200 `{id, token, mode}` |
| no Origin | `no Origin` |
| Origin `http://evil.example` | `another Origin` |
| Origin `null` | `another Origin` |
| Origin `http://localhost:8080` | `another Origin` |
| Host `rebind.example:<port>` | `unexpected Host` |
| Host = this Mac's LAN address | `unexpected Host` (by design: open the room on 127.0.0.1 to use the shell) |
| Host `127.0.0.1:1` (wrong port) | `unexpected Host` |
| `text/plain` body | `not JSON` |
| form body | `not JSON` |
| GET | `not a POST` |
| OPTIONS preflight | `not a POST` |
| input, no token | `unknown shell or wrong token` |
| input, wrong token | `unknown shell or wrong token` |
| output, wrong token | `unknown shell or wrong token` |
| input, right token, no Origin | `no Origin` |
| output, right token, Host `rebind.example` | `unexpected Host` |
| library, Host `rebind.example` | `unexpected Host` |
| **From another device (peer84 → this Mac)** | |
| room page | 200, byte-identical to the host's; no 64-hex token in it |
| start, plain | `not from this machine` |
| start, forged `Host: 127.0.0.1` and matching Origin | `not from this machine` |
| start, no Origin | `not from this machine` |
| input, using a **real live token** (copied from the host), forged headers | `not from this machine`; the command it carried (`touch /tmp/ar-pwned`) did not run |
| output, using a real live token, forged headers | `not from this machine` |
| library | `not from this machine` |
| **This Mac → the Linux server on peer84** | |
| start, forged Host and Origin | `not from this machine` |
| start, its own Host and Origin | `not from this machine` |
| **Another website open on the host** (a page on `http://localhost:<other port>`, in Chromium) | |
| JSON POST start (CORS) | the browser sent the preflight; the server refused it (`not a POST`); the browser blocked the request |
| no-cors `text/plain` POST start | reached the server: `another Origin` |
| form POST start (`text/plain` enctype) | reached the server: `another Origin` |
| GET library, no-cors | **served** (200), but the page sees only an opaque response; it is the public library file |
| GET library, CORS | served, but the browser blocked reading it (no CORS header) |
| **DNS rebinding** (Chromium told `rebind.test` = 127.0.0.1, room loaded as `http://rebind.test:<port>/…`) | |
| the room page | loads; the pane stays hidden, because the page only shows it on 127.0.0.1 or localhost |
| forcing the pane open | the library import is refused: `unexpected Host` |
| same-origin JSON POST start | `unexpected Host` |

**Limits I see, not tested further:**
- A **different OS user on the same machine** (or any local program) passes checks 1–4 and
  can start a shell as the User. Loopback says "this machine", not "this person".
- A browser extension with access to `127.0.0.1` can drive the page.
- IPv6 `[::1]` access was not exercised.

## Not changed
`README.md` and the existing tests are unchanged. `npm test`: 153 of 153 pass.

Screenshots (macOS, script backend): [pane](drawings/host-shell-pane.png),
[colours](drawings/host-shell-colours.png), [vim](drawings/host-shell-vim.png), [top](drawings/host-shell-top.png).
