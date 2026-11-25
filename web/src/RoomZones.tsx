import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CodeInfo, Gauge, HealthReply, Monitor, QuotaAt } from '../../src/contract';

// The page header's Room and Monitoring zones, as on /__room: the room menu (Quit room), the
// server menu (Reload, Restart, Shutdown server) with its state from the heartbeat, and the quota
// gauges with each provider's health. Quit, Restart and Shutdown each take a second click.
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
function ProviderName({ monitor, provider, display = provider, health = true }: { monitor: Monitor; provider: string; display?: string; health?: boolean }) {
  const h = health ? providerHealth(monitor, provider) : null;
  if (!health) return <b>{display}</b>;
  return <b tabIndex={0}>{display}{h?.level && <span className={'alert' + (h.level === 'red' ? ' red' : '')}>⚠</span>}
    {h && <Tip>{h.lines.map((line, i) => <span key={i} className={line.cls}>{line.text}{line.code && <code>{line.code}</code>}</span>)}</Tip>}</b>;
}
function QuotaUpdated({ at }: { at: QuotaAt | null | undefined }) {
  const checked = at?.checked ? new Date(at.checked) : null;
  // The meter reports local time as "YYYY-MM-DD HH:MM:SS"; a day other than today is shown too.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(at?.measured ?? '');
  const today = new Date().toLocaleDateString('sv');
  const text = m ? 'on\n' + (m[1] === today ? '' : m[1] + ' ') + m[2] : checked ? 'checked ' + hhmm(checked) : '';
  const title = (at?.measured ? 'Measured by the quota meter at ' + at.measured + '. ' : '') + (checked ? 'The room last asked the meter at ' + hhmm(checked) + ' (every minute, and after each turn).' : '');
  return <span className="updated" title={title}>{text}</span>;
}
// The quota gauges, as showQuota does: one bar per window (5h, week) for each provider, yellow
// under 30% left and red under 10%; providers with no gauges appear only with a health problem.
export function Gauges({ gauges, at, monitor }: { gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined; monitor: Monitor }) {
  const bare = (shown: Set<string>) => Object.keys(monitor).filter((p) => !shown.has(p) && providerHealth(monitor, p)?.level)
    .map((p) => <span className="quota" key={'bare ' + p}><ProviderName monitor={monitor} provider={p} /></span>);
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
    body = <><QuotaUpdated at={at} />{groups.map(({ provider, group, items }) => <span className="quota" key={provider + ' ' + group}>
      <ProviderName monitor={monitor} provider={provider} display={group ?? provider} health={group !== 'argon'} />
      {group !== 'argon' && monitor[provider]?.running != null && <span className="running">{monitor[provider].running} running</span>}
      {items.map((g) => {
        const left = 100 - g.used;
        return <span key={g.label} tabIndex={0} className={'gauge' + (left < 10 ? ' high' : left < 30 ? ' warn' : '')} style={g.label === '5h' ? { gridRow: '1' } : g.label === 'week' ? { gridRow: '2' } : undefined}>
          <span>{g.label === 'week' ? 'wk' : g.label}</span><span className="bar"><i style={{ width: Math.min(100, Math.max(0, g.used)) + '%' }} /></span><span>{g.used}%</span>
          <Tip>{g.label === '5h' && g.resets && <strong>Resets at {g.resets}</strong>}<span>{provider + (group ? ' ' + group : '') + ' ' + g.label + ': ' + g.used + '% used' + (g.label !== '5h' && g.resets ? ', at ' + g.resets : '')}</span></Tip>
        </span>;
      })}
    </span>)}{bare(new Set(gauges.map((g) => g.provider)))}</>;
  }
  return <span className="gauges" aria-label="Subscription usage">{body}</span>;
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
type Server = { state: 'up' | 'down' | null; text: string; title: string; beat: number };
type Props = {
  roomName: string; code: CodeInfo | null | undefined; gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined; monitor: Monitor;
  ended: boolean; restarting: boolean; command: (text: string) => void; shutdown: () => void; serverChanged: () => void;
};
export function RoomZones({ roomName, code, gauges, at, monitor, ended, restarting, command, shutdown, serverChanged }: Props) {
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
  const [server, setServer] = useState<Server>({ state: null, text: 'Connecting to the server…', title: '', beat: 0 });
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
      setServer((s) => ({ state: 'up', beat: s.beat + 1,
        text: 'Server up' + (startedAt ? ' ' + upFor(startedAt) : '') + ' · port ' + location.port,
        title: 'Process ' + h.pid + (startedAt ? ', started ' + new Date(startedAt).toLocaleString() : '') }));
    };
    void beat(); const timer = setInterval(() => void beat(), 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  const v = version(code);
  return <div className="next-zones">
    <div className="room-zone" aria-label="Room">
      <details className="menu" ref={roomMenu} onToggle={(e) => { if (e.currentTarget.open && serverMenu.current) serverMenu.current.open = false; }}>
        <summary><b>{roomName}</b></summary>
        <div className="menu-items"><button type="button" className="danger" title="End this room only: its agents and worker stop. The server's other rooms keep running." onClick={() => twice('quit', () => command('/quit'))}>{armed.quit ? 'Click again to quit this room' : 'Quit room'}</button></div>
      </details>
      <span className="server-head">
        <details className="menu" ref={serverMenu} onToggle={(e) => { if (e.currentTarget.open && roomMenu.current) roomMenu.current.open = false; }}>
          <summary><span className="server" data-state={server.state ?? undefined} title={server.title}><i key={server.beat} className={server.state === 'up' ? 'beat on' : 'beat'} aria-hidden="true" />Server</span></summary>
          <div className="menu-items">
            <button type="button" onClick={() => { closeMenus(); command('/reload'); }}>Reload</button>
            <button type="button" title="Start a new server on this address, with every room, each in its discussion in use, from its handoff. The chats clear." onClick={() => twice('restart', () => command('/restart'))}>{armed.restart ? 'Click again: the chat clears' : 'Restart'}</button>
            <hr aria-hidden="true" />
            <button type="button" className="danger" title="End every room on this server, then the server." onClick={() => twice('shutdown', shutdown)}>{armed.shutdown ? 'Click again: every room ends' : 'Shutdown server'}</button>
          </div>
        </details>
        <span className="hover-detail" role="tooltip" aria-label="Server state"><span>{server.text}</span><span title={v.title}>{v.text}</span></span>
      </span>
    </div>
    <div className="server-zone" aria-label="Monitoring"><Gauges gauges={gauges} at={at} monitor={monitor} /></div>
  </div>;
}
