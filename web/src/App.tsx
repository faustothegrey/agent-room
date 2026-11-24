import { useEffect, useRef, useState } from 'react';
import type { MessageView, Room, SayRequest, ScreenEvent } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void };
type StatusLine = { text: string; error: boolean };
type Failure = { agent: string; error: string; time: string; earlier: number };
const ATTACH_LIMIT = 25 * 1024 * 1024, ATTACH_TOTAL = 250 * 1024 * 1024;
const sizeText = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const base64 = (file: File) => new Promise<string>((ok, fail) => {
  const reader = new FileReader();
  reader.onload = () => { const value = String(reader.result); ok(value.slice(value.indexOf(',') + 1)); };
  reader.onerror = () => fail(reader.error || new Error(`could not read ${file.name}`));
  reader.readAsDataURL(file);
});

export function App({ version, refresh }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);
  const [yourTurn, setYourTurn] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<'on' | 'failed' | null>(null);
  const [input, setInput] = useState(false);
  const [ended, setEnded] = useState(false);
  const [text, setText] = useState(() => { try { const saved = sessionStorage.getItem('next-composer-draft') ?? ''; sessionStorage.removeItem('next-composer-draft'); return saved; } catch { return ''; } });
  const draft = useRef(text); draft.current = text;
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const client = useRef(globalThis.crypto.randomUUID?.() ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  const busyState = useRef({ command: false, posting: 0, ended: 0, show: undefined as ReturnType<typeof setTimeout> | undefined, fail: undefined as ReturnType<typeof setTimeout> | undefined });

  const updateBusy = () => {
    const state = busyState.current, on = state.command || state.posting > 0;
    if (on) {
      if (!state.show) state.show = setTimeout(() => { state.show = undefined; if (!state.fail && (state.command || state.posting > 0)) setBusy('on'); }, 300);
    } else {
      state.ended = Date.now(); clearTimeout(state.show); state.show = undefined;
      if (!state.fail) setBusy(null);
    }
  };
  const addStatus = (text: string, error = false) => {
    if (!text) return;
    setStatus((lines) => [...lines, { text, error }].slice(-2));
    const state = busyState.current;
    if (error && (state.command || state.posting > 0 || Date.now() - state.ended <= 1500)) {
      setBusy('failed'); clearTimeout(state.fail);
      state.fail = setTimeout(() => { state.fail = undefined; setBusy(state.command || state.posting > 0 ? 'on' : null); }, 1500);
    }
  };
  const post = async (body: SayRequest) => {
    const state = busyState.current; state.posting++; updateBusy();
    try {
      return await fetch('__say', { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': client.current }, body: JSON.stringify(body) });
    } finally { state.posting--; updateBusy(); }
  };
  const send = async () => {
    const value = text.trim();
    if (sending || ended || (!value && !files.length) || (peeking && (!value.startsWith('/') || files.length > 0))) return;
    const fail = (reason: string) => addStatus(`✗ ${reason} Nothing was sent.`, true);
    if (value === '/docs' && !files.length) { addStatus('Explorer is not available on this page yet.', true); return; }
    if (files.length && value.startsWith('/')) return fail('Attachments go with a message, not a command.');
    const tooBig = files.find((file) => file.size > ATTACH_LIMIT);
    if (tooBig) return fail(`${tooBig.name} is over 25 MB.`);
    if (files.reduce((total, file) => total + file.size, 0) > ATTACH_TOTAL) return fail('Over 250 MB at once: attach fewer files per message.');
    setSending(true);
    try {
      const body: SayRequest = { text: value };
      if (files.length) body.files = await Promise.all(files.map(async (file) => ({ name: file.name, data: await base64(file) })));
      let response = await post(body);
      if (response.status === 409 && !files.length && (value === '/restart' || value === '/shutdown')) {
        if (!window.confirm(await response.text())) return;
        response = await post({ text: value, confirmed: true });
      }
      if (!response.ok) { const error = await response.text(); addStatus(files.length ? `✗ ${error}` : error, true); return; }
      setText((current) => current === text ? '' : current); setFiles([]);
    } catch (error) {
      fail(`Couldn't send${files.length ? ' the attachments' : ' the message'}: ${error instanceof Error ? error.message : String(error)}.`);
    } finally { setSending(false); }
  };

  useEffect(() => {
    const state = busyState.current;
    const pin = (agent: string, error: string) => {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      setFailure((previous) => ({ agent, error, time, earlier: previous ? previous.earlier + 1 : 0 }));
    };
    const events = new EventSource('__events');
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data) as ScreenEvent;
      if ('webVersion' in event && event.webVersion && version && event.webVersion !== version) {
        try { sessionStorage.setItem('next-composer-draft', draft.current); } catch {}
        refresh(); return;
      }
      if (event.type === 'reset') {
        setRoom(event.room); setPeeking(!!event.peek); setInput(event.input);
        setMessages(event.messages.filter((m) => !m.pass && !m.hidden));
        setThinking(event.thinking ?? null); setYourTurn(!event.thinking);
        if (event.status) addStatus(event.status);
        state.command = !!event.busy; updateBusy();
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
        state.command = event.on; updateBusy();
      } else if (event.type === 'room') {
        setRoom(event.room);
      } else if (event.type === 'ended') {
        setEnded(true); addStatus('This room has ended. You can close this window.'); events.close();
      } else if (event.type === 'restarting') {
        setEnded(true); state.command = true; updateBusy(); addStatus('Restarting the server: this page reloads when the new one answers.'); events.close();
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
    {input && <div className="composer">
      <textarea aria-label="Message to the agents" value={text} disabled={ended} onChange={(event) => setText(event.target.value)}
        placeholder="Message to the agents… (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown"
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div><button type="button" title="Attach files to your next message: saved into the files/ folder when you send it (25 MB at most each)" disabled={sending || ended || !room?.active} onClick={() => fileInput.current?.click()}>📎 Attach</button>
        <input ref={fileInput} type="file" aria-label="Attach files" multiple hidden onChange={(event) => { const chosen = Array.from(event.target.files ?? []); setFiles((previous) => [...previous, ...chosen]); event.target.value = ''; }} />
        {files.map((file, index) => <span key={index}>{file.name} · {sizeText(file.size)} <button type="button" title="Remove this attachment" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((previous) => previous.filter((_, i) => i !== index))}>✕</button></span>)}
        {sending && files.length > 0 && <span>Saving the attachments…</span>}
      </div>
    </div>}
  </main>;
}
