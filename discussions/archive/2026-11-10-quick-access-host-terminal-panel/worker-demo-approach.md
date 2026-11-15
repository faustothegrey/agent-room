# Terminal pane after ghostty-web's demo server: implementation and tests (worker, 2026-11-10)

This replaces the shell code of `f8bddb0` and `cc6bdd5`. The `--unsafe-shell-test` flag and its
127.0.0.1-only listening are removed: `src/cli.mjs` is back to `d233274`, and `src/ui.mjs`
listens on `0.0.0.0` as before. The commit ID is in the worker's reply.

## What the demo does (read from its code)
Source: `coder/ghostty-web`, `demo/bin/demo.js` and `demo/bin/auth.js`, `main` branch (latest
commit touching `demo/bin`: 2026-06-26). Its package declares `@lydell/node-pty ^1.0.1`,
`ws ^8.18.0` and `ghostty-web`.

**Token endpoint, `GET /api/token`:**
1. Method must be GET, else **405** `Method Not Allowed` (with `Allow: GET`).
2. **Host header**, parsed strictly (`parseHostHeader`), else **400**:
   - `[ipv6]:port` or `name:port`;
   - no surrounding whitespace;
   - port 1–65535;
   - hostname a valid IP or DNS name (labels 1–63 characters, no leading or trailing `-`, no
     `/ \ @`).
3. **Its hostname must be allowed**, else **403**: `localhost`, `127.0.0.1` or `::1`.
   - `GHOSTTY_ALLOWED_HOSTS` can add more, and so does the bind address when it isn't a
     wildcard (`0.0.0.0`, `::`, `*`).
   - **The Host port is not checked.**
4. **Origin is optional.**
   - If present it must parse: `http:` or `https:`, no user or password, path `/`, no query or
     hash, a valid host. Else **400**.
   - Its hostname and port must equal the Host header's, with 80/443 as defaults. Else **403**.
5. Reply `{"token": …}` with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
   Refusals are plain text with `nosniff`.

**WebSocket, `/ws?token=…&cols=…&rows=…` (HTTP upgrade):**
1. The URL must parse, else **400**. Another path: the socket is destroyed.
2. The same **Host** checks as above (400 or 403).
3. **Origin is required**: missing gives **403**. It must parse (400) and match Host (403).
4. **`token` query parameter** must equal the per-run token, compared with `timingSafeEqual`
   after a length check. Else **401** `Unauthorized`.
5. Refusals are written as a raw HTTP response on the socket, then the socket is destroyed.

**The rest:**
- Token: `randomBytes(32)` in base64url, once per process.
- No check of the remote address: the demo listens on 127.0.0.1 by default (`HOST` env).
- Shell: `pty.spawn($SHELL or /bin/bash, [], {name:'xterm-256color', cols, rows, cwd: homedir(),
  env: {...process.env, TERM, COLORTERM:'truecolor'}})`.
- Shell output goes to the socket. A shell exiting sends "Shell exited (code: n)" and closes the
  socket.
- Messages starting with `{` that parse as `{type:'resize'}` resize the shell; anything else is
  input.
- Socket close kills the shell. SIGINT kills all shells and exits.
- A welcome banner is sent.
- The page reconnects 2 s after a close.
- The `ws` server uses default options.
- The page uses `fetch('/api/token', {cache:'no-store'})` and
  `new WebSocket(ws://<host>/ws?cols&rows&token)`.

## What agent-room does now
- `src/host-shell.mjs`: the checks, `GET __shell/token`, `GET __shell/ghostty-web.js`, and the
  WebSocket at `__shell/ws` (with `ws`, `noServer`).
- `src/ui.mjs`: a replaceable `hub.upgrade`, set like `hub.route`, so it follows Reload. It
  sends `/r/<room>/…` upgrades to that room's `docs.handleUpgrade`; any other upgrade has its
  socket destroyed.
- `src/docs.mjs`: the pane "▸ Terminal (this computer only)" below Explorer/Document, its page
  script, and the route lines.
- `package.json`: `@lydell/node-pty ^1.1.0` (what the demo's `^1.0.1` resolves to; npm's
  `latest` tag is a beta, 1.2.0-beta.18, which I didn't use), `ws ^8.22.2`, and `ghostty-web
  ^0.4.0` (already there).
- `README.md`: the pane, and its limit under "Access and limits".
- The existing tests are unchanged.

## Differences from the demo

| # | Difference | Reason | Test result |
|---|---|---|---|
| 1 | **Added: every token, library and WebSocket request must come from a loopback address** (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), else 403 `Forbidden: not from this computer` | agent-room listens on 0.0.0.0, so Host and Origin are just headers a LAN device can forge | peer84 → Mac, and Mac → peer84 (Linux server), forged `Host: 127.0.0.1:5801` + matching Origin + the **real token**: 403 on token and WebSocket |
| 2 | Allowed Host names: only `localhost`, `127.0.0.1`, `::1`. No `GHOSTTY_ALLOWED_HOSTS`, no bind-address addition | host only; a 0.0.0.0 bind adds nothing in the demo either | Host `rebind.example`, `rebind.test` and the Mac's LAN IP: 403 `Host not allowed` |
| 3 | Host parsing shortened to one regex plus checks (IPv6 in brackets, name `[a-z0-9.-]`, port 1–65535), not the demo's label-by-label check | smaller; any name not exactly one of the three allowed is refused anyway, so only the 400-vs-403 status could differ for odd names | `127.0.0.1:99999`: 400; allowed and forbidden names as above. Odd-name 400/403 cases: untested |
| 4 | Paths under the room: `/r/<room>/__shell/token` and `/r/<room>/__shell/ws` | agent-room serves several rooms, each under `/r/<id>/` | used by every test |
| 5 | **The library is served host-only too**: `__shell/ghostty-web.js` gets the same loopback, Host and Origin checks as the token | host only. The demo serves its `dist/` and wasm openly; here it is one file straight from `node_modules`, no build step | peer84: 403; `rebind.test`: 403 (the page's pane can't load) |
| 6 | The WebAssembly isn't served separately | ghostty-web 0.4.0's `dist/ghostty-web.js` already contains `ghostty-vt.wasm` as a data URI | the pane works with only that file served |
| 7 | Shell starts in **the room's folder**, not the home folder | it belongs to the room | `pwd` showed the room folder (macOS and Linux) |
| 8 | `cols`/`rows` (query and resize message) clamped to 2–1000 integers | a bad value must not throw in agent-room's server | resize 104→81 and 80→100 worked; bad values: untested |
| 9 | **The server stopping ends shells** on SIGINT **and SIGTERM**, and on `exit` (e.g. Shutdown's `process.exit`); then the default signal action runs. The demo handles SIGINT only, with its own `process.exit(0)` | agent-room already has its own ending; this must not change it | INT, TERM and KILL: no shell left, on macOS and Linux. Shutdown from the page: untested |
| 10 | No welcome banner | the pane label says what it is | n/a |
| 11 | **No automatic reconnect.** A closed socket shows "Connection closed. Collapse and open the pane for a new shell." | each opening must start a fresh shell, and closing must end it | reloads and collapse as below |
| 12 | The pane appears only when the page's own address is `127.0.0.1`, `localhost` or `[::1]` | a LAN page could never use it. This is cosmetic: the server checks are the protection | on `rebind.test` the pane was hidden |
| 13 | The token lives in a module that `/reload` doesn't re-import, so it stays the same for the whole process, like the demo's per-run token | | Reload with an open shell: untested |
| 14 | Upgrades are routed per room through `hub.upgrade`; a non-shell upgrade has its socket destroyed (the demo destroys non-`/ws` upgrades too) | several rooms; Reload | upgrade to `__events`: connection closed (curl `000`) |

Everything else follows the demo:
- the token format and timing-safe comparison;
- Origin optional for the token and required for the WebSocket;
- 400/401/403/405 statuses;
- the `nosniff` and `no-store` headers;
- the raw HTTP refusal on the socket;
- the resize message format;
- socket close kills the shell, and shell exit closes the socket.

## Tests run
**Systems:**
- **macOS** 26.6.2, Intel x64, Node 24.14.1, zsh. The test instance was a throwaway room on
  port 5801, listening on `*:5801` (all addresses, as normal), with a fake `claude`. The browser
  was Playwright's `chrome-headless-shell` 1228 with a fresh profile and no other pages,
  driven over DevTools. Screenshots are kept in the worker's notes.
- **Linux**: peer84, Ubuntu 22.04.5 x86_64, Node 24.15.0, bash. The room server ran in a temp
  folder (deleted afterwards), listening on `0.0.0.0:5801`, with a Node client using `ws` and the
  page's Origin instead of a browser.
- **Untested:** Linux arm64 (peer70 has no Node), a desktop browser, Safari, Firefox, Windows.

**Install of `@lydell/node-pty` 1.1.0:**
- **macOS x64:** ready-built package `@lydell/node-pty-darwin-x64`. No compiling. `spawn-helper`
  and `pty.node` were installed executable (`-rwxr-xr-x`), so **no permission fix**; the first
  spawn worked. (The earlier plain `node-pty` 1.1.0 needed `chmod +x spawn-helper`.)
- **Linux x64:** ready-built `@lydell/node-pty-linux-x64` (`pty.node`, no `spawn-helper`). **No
  compiling, no permission fix**; the first spawn worked. peer84's own npm 5.5.1 crashes on
  Node 24, so npm 10.9.10 was used from the temp folder.
- npm also removed the old `--no-save` `node-pty` from `node_modules`.

**Terminal, macOS, in the page:**
- **A command and its output:** `echo "hello from $(whoami) in $(pwd)"` printed
  `hello from fausto in /tmp/ar-term.…/demo`.
- **Colours:** 16-colour, 256-colour, truecolour and `ls -G` rendered.
- **Ctrl-C:** interrupted `sleep 30`; `$?` = 130.
- **Resizing:** narrowing the window took 104→81 columns, and `stty size` agreed.
- **vim:** `vim -u NONE -c "syntax on"`: typed text, syntax colours, a redraw when narrower, and
  `:q!` back to the prompt.
- **top:** drew after about 2 s (macOS `top`'s first sample); `q` returned to the prompt.

**Terminal, Linux (client):**
- The command output was `hello from root in /tmp/ar-term-test/room`.
- Colour escapes passed through.
- Sizes 24×80 → 30×100 after a resize message.
- Ctrl-C gave 130.
- `vi` (vim.tiny) drew and quit; `top` drew and `q` quit.
- Rendering in a browser on Linux is untested.

**Leftover shells:**
- macOS, three reloads: 0 shells before each reopening, 1 after.
- macOS, collapse: 0. Reopen: 1. Browser closed: 0.
- A curl WebSocket that hung up: its shell ended.
- Linux: 0 after the client closed.
- **Server stop with a shell running `sleep`:**

  | Server stopped by | macOS | Linux |
  |---|---|---|
  | Ctrl-C (SIGINT) | nothing left | nothing left |
  | SIGTERM | nothing left | nothing left |
  | SIGKILL (force-kill) | nothing left | nothing left |

**Refusals:** the status and reason returned, also logged by the server as `[terminal] refused …`.

| Request | Result |
|---|---|
| **LAN device** peer84 → Mac: room page | 200; no token in it |
| token, plain / forged `Host: 127.0.0.1:5801` + matching Origin / forged `Host: localhost:5801`, no Origin | 403 `not from this computer` |
| WebSocket with the real token, forged Host + matching Origin / own Host + Origin | 403 `not from this computer` |
| library, forged Host | 403 `not from this computer` |
| **LAN device** Mac → peer84 (Linux server): token and WebSocket (real token), forged Host + Origin | 403 `not from this computer` |
| **Another website on the host** (`http://localhost:<other port>`, in Chromium): `fetch` token | the browser blocked it (no CORS); the server refused it, `403 Origin does not match Host` |
| same, `fetch` token with `no-cors` | **the server sent the token** (no Origin on a no-cors GET; the demo also allows a missing Origin on the token request). The page got an opaque response and can't read it |
| same, WebSocket without a token / with the real token | the browser failed to connect; the server refused it, `403 Origin does not match Host` |
| **DNS rebinding** (`rebind.test` → 127.0.0.1, room loaded through it): token / WebSocket with the real token / library | 403 `Host not allowed`; the pane stayed hidden |
| curl from the host: token with Host `rebind.example` / the Mac's LAN IP | 403 `Host not allowed` |
| token, malformed Host `127.0.0.1:99999` | 400 |
| token, Origin `http://evil.example` / `http://localhost:8080` | 403 `Origin does not match Host` |
| token, Origin `null` | 400 `Bad Request: Origin` |
| token, POST | 405 |
| token, **no Origin** | 200 (as the demo) |
| WebSocket, **no Origin** | 403 `no Origin` |
| WebSocket, Origin `evil.example` | 403 `Origin does not match Host` |
| WebSocket, Host `rebind.example` + matching Origin | 403 `Host not allowed` |
| WebSocket, **no token** / **wrong token** / token one character off | 401 `Unauthorized` |
| WebSocket, valid | 101, shell started |

## Limits I see
- **Any program on this computer** can fetch the token and open a shell: loopback says "this
  computer", not "this page" or "this person". That includes another OS user on a shared
  computer. The token endpoint and the loopback check don't change that; the demo has the same
  property.
- A no-cors token request from another website is answered with the token, as an opaque
  response the page can't read. It relies on the browser keeping that response unreadable,
  including process isolation against side channels; I didn't test beyond what is above.
- **Untested:**
  - IPv6 `[::1]` access;
  - the server's Reload, Restart or Shutdown with a shell open;
  - several rooms on one server;
  - HTTPS (agent-room serves HTTP only).
