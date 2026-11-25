import { useEffect, useRef, useState } from 'react';
import type { ShellTokenReply } from '../../src/contract';

// The Terminal service (host-shell.mjs, after ghostty-web's demo), as on /__room: opening it the
// first time fetches the token and opens a WebSocket, and the server starts a fresh shell.
// Switching service or closing the panel only hides the pane; the shell stays alive (the rail
// button's running mark). End shell, reloading the page, or stopping the server ends it. Offered
// only on pages opened on this computer (the server refuses the others anyway).
type Term = { cols: number; rows: number; loadAddon(addon: unknown): void; open(el: HTMLElement): void; write(data: string): void; focus(): void; dispose(): void;
  onData(cb: (data: string) => void): void; onResize(cb: (size: { cols: number; rows: number }) => void): void };
type Fit = { fit(): void; observeResize(): void };
export type Ghostty = { init(): Promise<void>; Terminal: new (options: object) => Term; FitAddon: new () => Fit };
// The pane's code, served by host-shell.mjs beside this room's page (replaced in tests).
export const ghostty = { load: (): Promise<Ghostty> => import(/* @vite-ignore */ new URL('__shell/ghostty-web.js', location.href).href) as Promise<Ghostty> };
type Shell = { term: Term | null; ws: WebSocket | null; fit: Fit | null; alive: boolean };
export function TerminalPane({ visible, fitKey, running }: { visible: boolean; fitKey: unknown; running: (alive: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null), shell = useRef<Shell | null>(null);
  const [alive, setAlive] = useState(false);
  const [status, setStatus] = useState('Shell in this room’s folder (this computer only)');
  const mark = (value: boolean) => { setAlive(value); running(value); };
  const close = () => {
    const s = shell.current;
    if (s) { try { s.ws?.close(); } catch {} try { s.term?.dispose(); } catch {} }
    shell.current = null; box.current?.replaceChildren();
    setStatus('Shell ended. Click Start shell for a new shell.'); mark(false);
  };
  const open = async () => {
    const el = box.current; if (!el) return;
    el.replaceChildren();
    setStatus('Shell running in this room’s folder (this computer only)');
    // Start on first open: End shell while loading cancels it, and each step below stops then.
    const s: Shell = shell.current = { term: null, ws: null, fit: null, alive: true };
    mark(true);
    let term: Term;
    try {
      const { init, Terminal, FitAddon } = await ghostty.load();
      await init();
      if (shell.current !== s) return; // ended meanwhile
      term = s.term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', cursorBlink: true });
      const fit = s.fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit(); fit.observeResize();
    } catch (err) {
      if (shell.current === s) { s.alive = false; mark(false); setStatus('No terminal: ' + (err instanceof Error ? err.message : String(err))); }
      return;
    }
    let token: string;
    try {
      const r = await fetch('__shell/token', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status + ' ' + await r.text());
      token = (await r.json() as ShellTokenReply).token;
    } catch (err) {
      if (shell.current === s) { s.alive = false; mark(false); }
      term.write('\r\nNo terminal: ' + (err instanceof Error ? err.message : String(err)) + '\r\n');
      return;
    }
    if (shell.current !== s) return; // ended meanwhile
    const params = new URLSearchParams({ token, cols: String(term.cols), rows: String(term.rows) });
    const ws = s.ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + location.pathname.replace(/[^/]*$/, '') + '__shell/ws?' + params);
    ws.onmessage = (e) => term.write(String(e.data));
    ws.onclose = () => {
      if (shell.current !== s) return;
      s.alive = false; mark(false);
      setStatus('Shell exited. Click Start shell for a new shell.');
      term.write('\r\n\x1b[31mConnection closed. Click Start shell for a new shell.\x1b[0m\r\n');
    };
    term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    term.focus();
  };
  // Opening the service starts the first shell, or refits (and focuses) the running one; a divider
  // move while it is shown refits it too.
  const shown = useRef(false);
  useEffect(() => {
    const opening = visible && !shown.current; shown.current = visible;
    if (!visible) return;
    if (opening && !shell.current) { void open(); return; }
    const s = shell.current; if (!s?.fit) return;
    requestAnimationFrame(() => { if (shell.current !== s || !s.fit) return; try { s.fit.fit(); if (opening) s.term?.focus(); } catch {} });
  }, [visible, fitKey]);
  useEffect(() => () => { const s = shell.current; shell.current = null; try { s?.ws?.close(); } catch {} try { s?.term?.dispose(); } catch {} }, []);
  return <div className="terminal-service">
    <div className="terminal-bar"><span role="status">{status}</span>
      {!alive && <button type="button" title="Start a fresh shell" onClick={() => void open()}>Start shell</button>}
      {alive && <button type="button" title="Stop the running shell" onClick={close}>End shell</button>}</div>
    <div ref={box} className="hostshell-term" aria-label="Terminal" />
  </div>;
}
