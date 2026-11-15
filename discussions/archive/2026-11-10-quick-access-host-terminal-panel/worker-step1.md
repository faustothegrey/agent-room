# Worker step 1: smallest working path (2026-11-10)

## What was in the worktree before this step
- The previous attempt was **not** left unfinished. It was committed as `f8bddb0`, with its
  report in [test-report.md](test-report.md).
  - Its design: env-var switch, `script` or node-pty, its own output stream, Origin/Host/JSON
    checks.
- **Uncommitted edits:** none. **Processes:** none running.
- `node_modules/` still holds `node-pty` from that attempt. It was installed with `--no-save`: not
  in `package.json` or the lockfile, and not used by this step.
- This step **replaces** that code in a new commit. `f8bddb0` stays in the history.

## What this step does
- **Off by default.** It turns on only when agent-room is started with **`--unsafe-shell-test`**
  (`src/cli.mjs`). That flag also makes the server listen on **127.0.0.1 only**, instead of
  0.0.0.0 (`ctx.listen`, `src/ui.mjs`).
  - Startup prints `UNSAFE TEST: …`.
  - The startup banner still prints a "LAN:" address, which is wrong under this flag (not fixed).
- **Pane:** a red bar below the Explorer/Document pane, labelled **"Terminal: UNSAFE TEST ONLY,
  not for ordinary use"**. Clicking it opens and collapses a ghostty-web terminal.
- **Shell:** the user's `$SHELL -l` in the room's folder, under the system `script` command.
  - macOS: `cat | script -q /dev/null <shell> -l`.
  - Linux: `script -q -f -c '<shell> -l' /dev/null`, written but **not run in this step**.
  - `cat` is needed on macOS: `script` refuses Node's own pipes.
  - Size is set from outside with `stty -f`/`-F` on the shell's terminal.
- **Output:** over the page's **existing room event stream** (`/__events`).
  - A host page's stream gets an id (`{type:'shellstream'}`), sent only on that stream.
  - Shell output goes as `{type:'shell', data}` only to the stream that started the shell. Other
    pages never receive it.
- **Keystrokes:** POST `__shell/input`. Also `start`, `resize`, `stop`.
- **Ending:**
  - Collapsing the pane sends `stop`.
  - Reloading or closing the page closes its event stream, and the server ends that stream's
    shell.
  - When the server stops (exit, SIGINT, SIGTERM) it ends the shells. SIGKILL is not handled.
- **Checks on every `__shell/…` request, including the library:**
  - The remote address is loopback.
  - The Host header is `127.0.0.1` or `localhost`.
  - Header `X-Agent-Room-Shell` equals a random 32-byte token made at startup.
  - The token is written into the room page (a `<meta>`) only for pages requested from loopback
    with such a Host.
- **These checks are unverified. They are not claimed to protect against other websites.**
  Cross-origin and DNS-rebinding checks are for a later step.
- **Library, with no build step:**
  - The page fetches `__shell/lib` with the token header.
  - The server returns `node_modules/ghostty-web/dist/ghostty-web.js` as is.
  - The page imports it from a blob URL, so the module request also carries the header.
  - **The WebAssembly file (`ghostty-vt.wasm`, 423 KB) is inside that JS file** as a base64 data
    URI. Nothing else is served.
- **Dependencies:** `ghostty-web@^0.4.0` (in `package.json`, added in `f8bddb0`). Nothing new in
  this step.
- **Files:** `src/host-shell.mjs` (rewritten), `src/docs.mjs` (pane, page script, three hooks),
  `src/cli.mjs` (flag), `src/ui.mjs` (listen address). `README.md` and the tests are unchanged.

## What was run (macOS 26.6.2, Intel, Node 24.14.1, zsh)
**Setup:**
- A separate instance: `node src/cli.mjs --unsafe-shell-test --port 5799`, in a throwaway Git
  folder under `/tmp`, with a fake `claude` so no agents run. It was not the normal room server.
- `lsof` showed `TCP 127.0.0.1:5799 (LISTEN)`. Connecting to the Mac's LAN address on 5799 was
  refused (no connection).
- Browser: Playwright's `chrome-headless-shell` 1228, a fresh empty profile, no other pages,
  driven over DevTools.
- Afterwards the server was stopped (port free, no `script` processes), and the temp folders were
  deleted.

**Results (screenshots kept in the worker's scratch notes):**
- **The pane** showed, with the warning label, and its event stream had an id.
- **A command runs and its output shows:**
  `echo "hello from $(whoami) in $(pwd)"` printed
  `hello from fausto in /tmp/ar-step1.…/demo`.
- **Colours:** 16-colour, 256-colour and truecolour all rendered.
- **Ctrl-C:** interrupted `sleep 30`; `$?` was 130.
- **Resizing:** narrowing the window refitted the terminal from 104×16 to 81×16, and `stty size`
  inside the shell agreed (16 104 → 16 81).
- **vim:** `vim -u NONE -c "syntax on"` drew, took typed text, showed syntax colours and redrew
  after a resize. `:q!` returned to a working prompt.
- **Lifetime:**
  - Three reloads: before each reopening there were 0 shells; after opening, 1.
  - Collapse: 0 shells. Reopen: 1. Browser closed: 0.
- **No page errors** were logged.
- **Refusals (curl, from the host):**
  - The library, or `start`, with no token header or a wrong token: 403 "missing or wrong
    X-Agent-Room-Shell token".
  - `start` with the right token but `Host: evil.example`: 403 "not from the host (address or Host
    header)".
  - `start` with the right token but an unknown stream id: 409.
- **Token in the page:** present for Host `127.0.0.1` and `localhost`; absent for Host
  `evil.example`.
  - A first check said "absent" for every Host. That came from my script requesting the wrong
    address (the server's file list, not the room page). It was rechecked with the right address.

## Not done or untested in this step
- Linux.
- Requests from another device. Only a refused connection to the LAN address was checked; the
  server didn't listen there.
- Other websites, missing-Origin cases and DNS rebinding in a browser (the later step).
- `top`, latency, `kill -9` of the server.
- node-pty and other connections (not tried, as instructed).
