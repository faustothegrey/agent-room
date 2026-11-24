import { useEffect, useRef, useState } from 'react';
import type { MessageView, Room, ScreenEvent } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void };
type StatusLine = { text: string; error: boolean };
type Failure = { agent: string; error: string; time: string; earlier: number };

export function App({ version, refresh }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);
  const [yourTurn, setYourTurn] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<'on' | 'failed' | null>(null);
  const busyState = useRef({ command: false, ended: 0, show: undefined as ReturnType<typeof setTimeout> | undefined, fail: undefined as ReturnType<typeof setTimeout> | undefined });

  useEffect(() => {
    const state = busyState.current;
    const updateBusy = (on: boolean) => {
      state.command = on;
      if (on) {
        if (!state.show) state.show = setTimeout(() => { state.show = undefined; if (!state.fail && state.command) setBusy('on'); }, 300);
      } else {
        state.ended = Date.now(); clearTimeout(state.show); state.show = undefined;
        if (!state.fail) setBusy(null);
      }
    };
    const addStatus = (text: string, error = false) => {
      if (!text) return;
      setStatus((lines) => [...lines, { text, error }].slice(-2));
      if (error && (state.command || Date.now() - state.ended <= 1500)) {
        setBusy('failed'); clearTimeout(state.fail);
        state.fail = setTimeout(() => { state.fail = undefined; setBusy(state.command ? 'on' : null); }, 1500);
      }
    };
    const pin = (agent: string, error: string) => {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      setFailure((previous) => ({ agent, error, time, earlier: previous ? previous.earlier + 1 : 0 }));
    };
    const events = new EventSource('__events');
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data) as ScreenEvent;
      if ('webVersion' in event && event.webVersion && version && event.webVersion !== version) {
        refresh(); return;
      }
      if (event.type === 'reset') {
        setRoom(event.room); setPeeking(!!event.peek);
        setMessages(event.messages.filter((m) => !m.pass && !m.hidden));
        setThinking(event.thinking ?? null); setYourTurn(!event.thinking);
        if (event.status) addStatus(event.status);
        updateBusy(!!event.busy);
      } else if (event.type === 'message') {
        if (event.message.speaker === 'User') setYourTurn(false);
        if (event.message.error) pin(event.message.speaker, event.message.errorText ?? '');
        if (!event.message.pass && !event.message.hidden) setMessages((previous) => [...previous, event.message]);
      } else if (event.type === 'agent-failure') {
        pin(event.agent, event.error);
      } else if (event.type === 'thinking') {
        setThinking(event.name); if (event.name) setYourTurn(false);
      } else if (event.type === 'turn') {
        setThinking(null); setYourTurn(true); addStatus(event.text);
      } else if (event.type === 'note') {
        addStatus(event.text, !!event.error);
      } else if (event.type === 'busy') {
        updateBusy(event.on);
      } else if (event.type === 'room') {
        setRoom(event.room);
      } else if (event.type === 'ended') {
        addStatus('This room has ended. You can close this window.'); events.close();
      } else if (event.type === 'restarting') {
        updateBusy(true); addStatus('Restarting the server: this page reloads when the new one answers.'); events.close();
      }
    };
    return () => { events.close(); clearTimeout(state.show); clearTimeout(state.fail); state.show = undefined; state.fail = undefined; };
  }, [version, refresh]);

  const name = room?.active?.split('/').at(-1);
  const saved = room?.discussion?.trim();
  const title = saved && saved !== name ? saved : (name ?? '').replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/, '').replace(/-/g, ' ') || 'agent-room';
  const turnVisible = !!room?.started && yourTurn && !thinking && !peeking && room.autoDev?.status !== 'running';
  return <main>
    <h1>{title}</h1>
    {turnVisible && <p aria-label="Turn status">your turn</p>}
    <section aria-label="Activity" aria-live="polite">
      {failure && <div><span title={failure.error}>✗ {failure.agent} failed {failure.time}: {failure.error.split(/\r?\n/)[0]}{failure.earlier ? ` (+${failure.earlier} earlier)` : ''}</span> <button type="button" title="Dismiss" aria-label="Dismiss pinned error" onClick={() => setFailure(null)}>✕</button></div>}
      {status.map((line, index) => <p key={index} className={line.error ? 'status error' : 'status'} title={line.text}>{line.text}</p>)}
    </section>
    {busy && <div aria-label="Busy" data-state={busy}>{busy === 'on' ? 'Working…' : 'Action failed'}</div>}
    <section aria-label="Conversation">{messages.map((message, index) => <article key={index} className={'msg' + (message.error ? ' error' : '') + (message.outcome ? ' summary' + (message.outcome === 'agreed' ? '' : ' not-agreed') : '')}>
      <strong>{message.speaker}{message.error ? ' — failed' : ''}{message.meta ? ` · ${String(message.meta)}` : ''}</strong><div dangerouslySetInnerHTML={{ __html: message.html }} />
    </article>)}</section>
    {thinking && <p>{thinking} is thinking…</p>}
  </main>;
}
