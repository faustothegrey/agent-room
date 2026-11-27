import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CodeInfo, Gauge, HealthReply, Monitor, NewRoomReply, NewRoomRequest, PairCheck, PairRequest, QuotaAt, Replica, RoomEntry, ViewedLine } from '../../src/contract';

// The page header's Room and Monitoring zones, as on /__room: the room menu (Quit room), the
// server machine's name, and the quota gauges with each provider's health; and, at the top of the
// left bar (serverSlot), the server menu (Reload, Restart, Shutdown server) with its state from the
// heartbeat. Quit, Restart and Shutdown each take a second click.
const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const longDate = (iso: string) => { const d = new Date(iso); return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + hhmm(d); };
const startTime = (iso: string) => { const d = new Date(iso); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ') + hhmm(d); };
type HealthLine = { text: string; code?: string; cls?: string };
// The monitor's warnings per provider (monitorView in ui.mjs): amber or red, only on a problem.
export function providerHealth(monitor: Monitor, provider: string): { level: 'amber' | 'red' | null; lines: HealthLine[] } | null {
  const m = monitor[provider];
  if (!m) return null;
  const name = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
  const problems: HealthLine[] = [], state: string[] = [];
  let level: 'amber' | 'red' | null = null;
  const problem = (text: string, red = false) => { problems.push({ text: 'Problem: ' + text, cls: 'problem' + (red ? ' red' : '') }); level = red || level === 'red' ? 'red' : 'amber'; };
  const l = m.login, ends = l?.expiresAt ? longDate(l.expiresAt) : null;
  if (!l) state.push('login not checked yet');
  else if (l.state === 'unmonitored') state.push('login not monitored');
  else if (l.state === 'out') { problem('logged out', true); state.push('logged out'); }
  else if (l.state === 'expired') { problem('login expired on ' + ends, true); state.push(name + ' reports login ended ' + ends); }
  else if (l.state === 'unknown') { problem('login status unknown: ' + l.error); state.push('login status unknown'); }
  else {
    if (l.state === 'ending') problem('login ends ' + ends + ', in 2 days or less');
    state.push(ends ? name + ' reports login ends ' + ends : 'logged in, no expiry given');
  }
  if (m.leftovers.length) {
    const n = m.leftovers.length;
    problem(n + ' program' + (n === 1 ? '' : 's') + ' left over (alive after a crash or Restart)');
    for (const o of m.leftovers) {
      problems.push({ text: 'PID ' + o.pid + ' · ' + o.agent + ' · room ' + o.room + ' · started ' + startTime(o.started) });
      problems.push(o.unverified
        ? { text: 'unverified: its leader is gone, or a start time cannot be read, so the number may have been reused. Look at it: ', code: 'ps -g ' + o.pid }
        : { text: 'stop it: ', code: 'kill -TERM -' + o.pid });
    }
  }
  state.push(m.running + ' running now in this room');
  return { level, lines: [...problems, ...state.map((text, i) => ({ text: (i ? '' : 'State: ') + text }))] };
}
const Tip = ({ children }: { children: ReactNode }) => <span className="hover-detail" role="tooltip">{children}</span>;
// A provider's name, with its ⚠ and its details on hover or focus.
// Clicking or pressing Enter/Space on the name opens Provider health (openHealth).
function ProviderName({ monitor, provider, display = provider, health = true, openHealth }: { monitor: Monitor; provider: string; display?: string; health?: boolean; openHealth?: () => void }) {
  const h = health ? providerHealth(monitor, provider) : null;
  if (!health) return <b>{display}</b>;
  return <b tabIndex={0} role="button" onClick={openHealth} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHealth?.(); } }}>{display}{h?.level && <span className={'alert' + (h.level === 'red' ? ' red' : '')}>⚠</span>}
    {h && <Tip>{h.lines.map((line, i) => <span key={i} className={line.cls}>{line.text}{line.code && <code>{line.code}</code>}</span>)}</Tip>}</b>;
}
function QuotaUpdated({ at, compact = false }: { at: QuotaAt | null | undefined; compact?: boolean }) {
  const checked = at?.checked ? new Date(at.checked) : null;
  const measured = at?.measured ? new Date(at.measured.replace(' ', 'T')) : null;
  const age = measured && !Number.isNaN(measured.getTime()) ? Math.max(0, Math.floor((Date.now() - measured.getTime()) / 60000)) : null;
  const text = age == null ? (checked ? 'checked ' + hhmm(checked) : '') : `${age}m${compact ? "" : " old"}`;
  const title = (at?.measured ? 'Reading at ' + at.measured + '. ' : '') + (checked ? 'The room last checked at ' + hhmm(checked) + '.' : '');
  return <span className="updated" title={title}>{text}</span>;
}
// The quota gauges, as showQuota does: one bar per window (5h, week) for each provider, yellow
// under 30% left and red under 10%; providers with no gauges appear only with a health problem.
export function Gauges({ gauges, at, monitor, openHealth }: { gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined; monitor: Monitor; openHealth?: () => void }) {
  const bare = (shown: Set<string>) => Object.keys(monitor).filter((p) => !shown.has(p) && providerHealth(monitor, p)?.level)
    .map((p) => <span className="quota" key={'bare ' + p}><ProviderName monitor={monitor} provider={p} openHealth={openHealth} /></span>);
  let body: ReactNode;
  if (gauges === undefined) body = bare(new Set());
  else if (gauges === null || !gauges.length) body = <>quota meter not reachable · <QuotaUpdated at={{ measured: null, checked: at?.checked ?? '' }} />{bare(new Set())}</>;
  else {
    const groups: { provider: string; group: string | null; items: Gauge[] }[] = [];
    for (const g of gauges) {
      const last = groups.at(-1);
      if (last && last.provider === g.provider && last.group === (g.group ?? null)) last.items.push(g);
      else groups.push({ provider: g.provider, group: g.group ?? null, items: [g] });
    }
    body = <>{groups.map(({ provider, group, items }) => <span className="quota" key={provider + ' ' + group}>
      <ProviderName monitor={monitor} provider={provider} display={group ?? provider} health={group !== 'argon'} openHealth={openHealth} />
      <span className="quota-meta">{group !== 'argon' && monitor[provider]?.running != null && <span title={`${monitor[provider].running} running now in this room`}>{monitor[provider].running} r</span>}{group !== 'argon' && monitor[provider]?.running != null && (at?.providers?.[provider] || at?.checked) && <span aria-hidden="true"> | </span>}<QuotaUpdated compact at={{ measured: at?.providers?.[provider] ?? null, checked: at?.checked ?? '' }} /></span>
      {items.map((g) => {
        const left = 100 - g.used;
        return <span key={g.label} tabIndex={0} className={'gauge' + (left < 10 ? ' high' : left < 30 ? ' warn' : '')} style={g.label === '5h' ? { gridRow: '1' } : g.label === 'week' ? { gridRow: '2' } : undefined}>
          <span>{g.label === 'week' ? 'wk' : g.label}</span><span className="bar"><i style={{ width: Math.min(100, Math.max(0, g.used)) + '%' }} /></span><span>{g.used}%</span>
          <Tip>{g.label === '5h' && g.resets && <strong>Resets at {g.resets}</strong>}<span>{provider + (group ? ' ' + group : '') + ' ' + g.label + ': ' + g.used + '% used' + (g.label !== '5h' && g.resets ? ', at ' + g.resets : '')}</span></Tip>
        </span>;
      })}
    </span>)}{bare(new Set(gauges.map((g) => g.provider)))}</>;
  }
  return <span id="gauges" aria-label="Subscription usage">{body}</span>;
}
// The version the server runs, as showVersion does: snapshots taken at start and at the last Reload.
function version(c: CodeInfo | null | undefined): { text: string; title: string } {
  if (!c) return { text: '', title: '' };
  const hm = (t: string) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const full = (t: string) => new Date(t).toLocaleString();
  const at = (commit: string | null, dirty: boolean) => (commit ?? 'not in Git') + (dirty ? '+' : '');
  let text = at(c.commit, c.dirty) + (c.startedAt ? ' · started ' + hm(c.startedAt) : '');
  let title = 'Started ' + (c.startedAt ? full(c.startedAt) : '') + ' at ' + at(c.commit, c.dirty);
  if (c.reloaded) {
    text += ' · reloaded ' + hm(c.reloaded.at) + ' (' + at(c.reloaded.commit, c.reloaded.dirty) + ')';
    title += '\nReloaded ' + full(c.reloaded.at) + ' at ' + at(c.reloaded.commit, c.reloaded.dirty);
  }
  title += '\nCheckout: ' + c.path + (c.branch ? ' (' + c.branch + ')' : '') +
    '\n+ means uncommitted changes (outside discussions/). These are snapshots of the checkout, taken at start and at the last Reload: after a Reload the process may run a mix of files from both.';
  return { text, title };
}
const upFor = (t: string) => { const m = Math.max(0, Math.floor((Date.now() - Date.parse(t)) / 60000)); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
type Server = { state: 'up' | 'down' | null; text: string; title: string; beat: number; host: string | null };
const receivedTime = (at: string | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
export function peerActivity(replica: Replica | null, name: string) {
  const p = replica?.peers.find((peer) => peer.name === name);
  if (!p) return 'unreachable (not configured)';
  return p.reachable === false ? 'unreachable' + (p.since ? ' since ' + receivedTime(p.since) : '') : p.activity || 'checking';
}
// The replica line beside the room menu, as updateReplicaHeader does: the room folder, then this
// node's address and line (or the line being viewed) and the project version.
function replicaLine(replica: Replica, active: string | null, viewing: ViewedLine | null, port: string) {
  const own = replica.own[active?.split('/').at(-1) ?? ''];
  const project = replica.project?.commit ? 'Project ' + replica.project.commit + (replica.project.dirty ? ' + uncommitted' : '') : 'Version unavailable';
  const line = viewing ? '[Viewing ' + viewing.node + "'s line, round " + viewing.round + ', received ' + receivedTime(viewing.receivedAt) + ' · read-only] · ' + viewing.node + ': ' + peerActivity(replica, viewing.node)
    : replica.node + "'s line" + (own ? ', round ' + own.round : ', no saved round') + ' · agents run on ' + replica.node;
  return replica.node + ' ' + (replica.addresses[0] || '127.0.0.1:' + port) + ' · ' + line + ' · ' + project;
}
type Ask = { text: string; buttons: [string, (() => unknown)?][]; done: (value: unknown) => void };
type Props = {
  children?: ReactNode; roomName: string; folder: string | null; active: string | null; replica: Replica | null; replicaOff: string | null; viewing: ViewedLine | null; newRoom: boolean; readOnly: boolean;
  post: (path: '__newroom' | '__pair', body: NewRoomRequest | PairRequest) => Promise<Response>; status: (text: string, error?: boolean) => void; navigate: (url: string) => void; code: CodeInfo | null | undefined; gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined; monitor: Monitor;
  openHealth: () => void; ended: boolean; restarting: boolean; command: (text: string) => void; shutdown: () => void; serverChanged: () => void;
  serverSlot: HTMLElement | null; // where the server menu goes: the top of the left bar
};
export function RoomZones({ children, roomName, folder, active, replica, replicaOff, viewing, newRoom, readOnly, post, status, navigate, code, gauges, at, monitor, openHealth, ended, restarting, command, shutdown, serverChanged, serverSlot }: Props) {
  // A modal question drawn in the page, as ask() does: each button's act runs inside its click (so
  // it may open a window); the promise resolves to what it returns (undefined for Escape).
  const [question, setQuestion] = useState<Ask | null>(null);
  const askDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = askDialog.current; if (question && d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); } }, [question]);
  const ask = (text: string, buttons: Ask['buttons']) => new Promise<unknown>((done) => setQuestion({ text, buttons, done }));
  const answer = (act?: () => unknown) => { const q = question; setQuestion(null); askDialog.current?.close?.(); q?.done(act ? act() : undefined); };
  // Switch room…: this server's rooms, twice (switch this tab, or open a new window). A room with
  // a page open (on any device) is disabled in both, so the chooser doesn't open it twice.
  const [rooms, setRooms] = useState<RoomEntry[] | null>(null), [switching, setSwitching] = useState(false);
  const nextUrl = (path: string) => new URL(path, location.href).href;
  const switchRoom = async () => {
    closeMenus(); setSwitching(true);
    try {
      const res = await fetch('__rooms'); if (!res.ok) throw new Error(await res.text());
      const list = await res.json() as RoomEntry[]; setRooms(list);
      if (!list.some((r) => !r.current)) status('No other rooms are open on this server: Open room in folder… adds one.');
    } catch (err) { status('✗ Switch room: ' + (err instanceof Error ? err.message : String(err)), true); }
    finally { setSwitching(false); }
  };
  const chooseRoom = (value: string) => {
    const at = value.indexOf(':'), mode = value.slice(0, at), path = value.slice(at + 1);
    if (!path) return;
    const url = nextUrl(path);
    if (mode === 'tab') { navigate(url); return; }
    // Opened during the choice, so the browser doesn't block it; this window stays on its room.
    const win = window.open(url, '_blank', 'width=' + window.outerWidth + ',height=' + window.outerHeight);
    setRooms(null);
    status(win ? 'Opened the room in a new window. This window stays on its room.' : 'The browser blocked the new window; open ' + url + ' yourself.', !win);
  };
  // Open room in folder…: the server shows the Mac's folder chooser. A folder whose room exists opens
  // it in a new window; one without a room is created only after the page has asked.
  const newWindow = () => window.open('', '_blank', 'width=' + window.outerWidth + ',height=' + window.outerHeight);
  const openRoom = async () => {
    closeMenus();
    let win = newWindow();
    if (win) win.document.body.textContent = 'Choose a folder in the window that has just opened…';
    try {
      let res = await post('__newroom', {});
      if (!res.ok) { win?.close(); status('✗ Open room: ' + await res.text(), true); return; }
      let r = await res.json() as NewRoomReply;
      if (r.cancelled) { win?.close(); return; }
      if (r.open) { win?.close(); await ask('The room in ' + r.folder + ' is already open in another window.', [['OK']]); return; }
      if (r.confirm) {
        win?.close();
        const chosen = await ask('Create a room in ' + r.folder + '?', [['Cancel'], ['Create room', () => ({ win: newWindow() })]]) as { win: Window | null } | undefined;
        if (!chosen) { post('__newroom', { token: r.token!, cancel: true }).catch(() => {}); return; }
        win = chosen.win;
        if (win) win.document.body.textContent = 'Creating the room in ' + r.folder + '…';
        res = await post('__newroom', { token: r.token! });
        if (!res.ok) { win?.close(); status('✗ Open room: ' + await res.text(), true); return; }
        r = await res.json() as NewRoomReply;
        if (r.open) { win?.close(); await ask('The room in ' + r.folder + ' is already open in another window.', [['OK']]); return; }
      }
      if (win && r.url) win.location.href = nextUrl(r.url);
      status((r.existing ? 'Opened the room already in ' : 'Opened a new room in ') + r.folder + (win ? '' : ' at ' + r.url + ' (the browser blocked the new window)') + '. This room keeps running.');
    } catch (err) { win?.close(); status('✗ Open room: ' + (err instanceof Error ? err.message : String(err)), true); }
  };
  // Peers…: the replication peers, with their reachability and Pair buttons.
  const [peersOpen, setPeersOpen] = useState(false);
  const peersDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = peersDialog.current; if (peersOpen && d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); } }, [peersOpen]);
  const pair = async (peer: string) => {
    try {
      const check = await post('__pair', { peer }); if (!check.ok) { status(await check.text(), true); return; }
      const x = await check.json() as PairCheck;
      if (!window.confirm('Pair these room folders?\n' + x.local.node + ': ' + x.local.root + '\n' + x.peer.node + ': ' + x.peer.root)) return;
      const result = await post('__pair', { peer, confirm: true }); if (!result.ok) status(await result.text(), true);
    } catch (err) { status(err instanceof Error ? err.message : String(err), true); }
  };
  const down = replica?.peers.filter((p) => p.reachable === false).length ?? 0;
  const downText = down + (down === 1 ? ' peer unreachable' : ' peers unreachable');
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const t of Object.values(timers.current)) clearTimeout(t); }, []);
  const twice = (key: string, act: () => void) => {
    if (armed[key]) { clearTimeout(timers.current[key]); setArmed((a) => ({ ...a, [key]: false })); act(); return; }
    setArmed((a) => ({ ...a, [key]: true }));
    timers.current[key] = setTimeout(() => setArmed((a) => ({ ...a, [key]: false })), 3000);
  };
  const roomMenu = useRef<HTMLDetailsElement>(null), serverMenu = useRef<HTMLDetailsElement>(null);
  const closeMenus = () => { for (const m of [roomMenu.current, serverMenu.current]) if (m) m.open = false; };
  useEffect(() => {
    const outside = (e: MouseEvent) => { if (!(e.target instanceof Element && e.target.closest('details.menu'))) closeMenus(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenus(); };
    document.addEventListener('click', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', outside); document.removeEventListener('keydown', escape); };
  }, []);
  // The heartbeat: every 3 s the page asks the server how it is. A different server answering on
  // this address (after Restart, or the Dock app starting it again) refreshes the page.
  const [server, setServer] = useState<Server>({ state: null, text: 'Connecting to the server…', title: '', beat: 0, host: null });
  const live = useRef({ ended, restarting, serverChanged, pid: null as number | null });
  live.current.ended = ended; live.current.restarting = restarting; live.current.serverChanged = serverChanged;
  useEffect(() => {
    let stopped = false;
    const beat = async () => {
      let h: HealthReply | null = null, gone = false;
      try {
        const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(2500) : undefined;
        const res = await fetch('__health', { cache: 'no-store', signal: timeout });
        if (res.status === 404) gone = true; else h = await res.json() as HealthReply;
      } catch {}
      if (stopped) return;
      const state = live.current;
      if (!h || typeof h.pid !== 'number') {
        setServer((s) => ({ ...s, state: 'down',
          text: gone ? 'This room is not open on the server' : state.restarting ? 'Restarting the server…' : state.ended ? 'Server stopped' : 'Server not responding',
          title: gone ? 'Open it again with Open room in folder… from another room.' : 'Start it again from the Dock app (or npm start): this page reloads when it answers.' }));
        return;
      }
      if (state.pid !== null && h.pid !== state.pid) { state.serverChanged(); return; }
      state.pid = h.pid;
      const startedAt = h.startedAt;
      setServer((s) => ({ state: 'up', beat: s.beat + 1, host: h.host ?? s.host,
        text: 'Server up' + (startedAt ? ' ' + upFor(startedAt) : '') + ' · port ' + location.port,
        title: 'Process ' + h.pid + (startedAt ? ', started ' + new Date(startedAt).toLocaleString() : '') }));
    };
    void beat(); const timer = setInterval(() => void beat(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const v = version(code);
  // The header's grid items, as on /__room: the Room zone, then `children` (the Activity zone), then Monitoring.
  return <>
    <div id="room-zone" className="zone" aria-label="Room"><div className="zone-line">
      <details className="menu" id="room-menu" ref={roomMenu} onToggle={(e) => { if (e.currentTarget.open && serverMenu.current) serverMenu.current.open = false; }}>
        <summary><b id="room-name">{roomName}</b></summary>
        <div className="menu-items">
          <button type="button" disabled={switching} onClick={() => void switchRoom()}>Switch room…</button>
          {newRoom && <button type="button" title="Choose a folder and open its room in a new window, creating one there if you confirm. This room keeps running." onClick={() => void openRoom()}>Open room in folder…</button>}
          {(replica || replicaOff) && <button type="button" title="Replication peers: reachability and pairing" onClick={() => { closeMenus(); setPeersOpen(true); }}>Peers…</button>}
          <hr aria-hidden="true" />
          <button type="button" className="danger" title="End this room only: its agents and worker stop. The server's other rooms keep running." onClick={() => twice('quit', () => command('/quit'))}>{armed.quit ? 'Click again to quit this room' : 'Quit room'}</button></div>
      </details>
      <span id="replica-header" className="hover-detail" role="tooltip" aria-label="Room details">{folder && <code>{folder}</code>}{replica && <span>{replicaLine(replica, active, viewing, location.port)}</span>}</span>
      </div><div id="server-box">
      {server.host && <span id="host">{server.host}</span>}
      {down > 0 && server.state !== 'down' && <button type="button" id="peer-warning" title={downText} aria-label={downText} onClick={() => setPeersOpen(true)}>⚠</button>}
      </div>
      {serverSlot && createPortal(<>
        <details className="menu" id="server-menu" ref={serverMenu} onToggle={(e) => { if (e.currentTarget.open && roomMenu.current) roomMenu.current.open = false; }}>
          <summary id="server" className="ctrl-btn server" data-state={server.state ?? undefined} title={server.title}><span className="ctrl-ico"><i id="beat" key={server.beat} className={server.state === 'up' ? 'on' : undefined} aria-hidden="true" /></span><span className="ctrl-lbl">Server</span></summary>
          <div className="menu-items">
            {!readOnly && <button type="button" onClick={() => { closeMenus(); command('/reload'); }}>Reload</button>}
            <button type="button" title="Start a new server on this address, with every room, each in its discussion in use, from its handoff. The chats clear." onClick={() => twice('restart', () => command('/restart'))}>{armed.restart ? 'Click again: the chat clears' : 'Restart'}</button>
            <hr aria-hidden="true" />
            <button type="button" className="danger" title="End every room on this server, then the server." onClick={() => twice('shutdown', shutdown)}>{armed.shutdown ? 'Click again: every room ends' : 'Shutdown server'}</button>
          </div>
        </details>
        <span id="server-details" className="hover-detail" role="tooltip" aria-label="Server state"><span id="server-text">{server.text}</span><span id="code" title={v.title}>{v.text}</span></span>
      </>, serverSlot)}
      {rooms && <select id="rooms" aria-label="Running rooms" value="" onChange={(e) => chooseRoom(e.target.value)}>
        <option value="">Choose a running room…</option>
        {([['tab', 'Switch this tab to'], ['window', 'Open in new window']] as const).map(([mode, heading]) => <optgroup key={mode} label={heading}>{rooms.map((r) => {
          const open = !r.current && (r.pages ?? 0) > 0;
          const pages = r.pages == null ? '' : ' · ' + r.pages + (r.pages === 1 ? ' page' : ' pages') + ' open';
          return <option key={r.id} value={mode + ':' + r.path} disabled={r.current || open}>{r.root + ' · ' + (r.discussion || 'No discussion started') + pages + (r.current ? ' (current)' : open ? ' (open in another window)' : '')}</option>;
        })}</optgroup>)}
      </select>}
      {question && <dialog ref={askDialog} id="ask" aria-label={question.text} onCancel={(e) => { e.preventDefault(); answer(); }}>
        <p id="ask-text">{question.text}</p><div id="ask-buttons">{question.buttons.map(([label, act], i) => <button type="button" key={label} autoFocus={i === question.buttons.length - 1} onClick={() => answer(act)}>{label}</button>)}</div>
      </dialog>}
      {peersOpen && <dialog ref={peersDialog} id="peers" aria-label="Peers" onCancel={(e) => { e.preventDefault(); setPeersOpen(false); }}>
        {(replica || replicaOff) && <h3>Peers</h3>}
        {!replica && replicaOff && <p className="status">{replicaOff}</p>}
        {replica?.peers.map((peer) => <div className="peer-row" key={peer.name} title={peer.error ?? undefined}>
          <span className={'peer-dot ' + (peer.reachable === true ? 'up' : peer.reachable === false ? 'down' : '')}>● </span>
          {peer.name + ' · ' + peer.address + ' · ' + peerActivity(replica, peer.name) + (peer.paired ? ' · paired' : ' · not paired')}
          {!peer.paired && <button type="button" onClick={() => void pair(peer.name)}>Pair with {peer.name}…</button>}
          {' · project ' + (peer.project?.commit ? peer.project.commit + (peer.project.dirty ? '+' : '') : 'version unavailable')}
        </div>)}
        <div id="peers-buttons"><button type="button" onClick={() => { peersDialog.current?.close?.(); setPeersOpen(false); }}>Close</button></div>
      </dialog>}
    </div>
    {children}
    <div id="server-zone" className="zone" aria-label="Monitoring"><div id="monitor"><Gauges gauges={gauges} at={at} monitor={monitor} openHealth={openHealth} /></div></div>
  </>;
}
