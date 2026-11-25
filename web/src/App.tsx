/// <reference types="vite/client" />
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './layout.css';
import type { FileDetailsResponse, FilesResponse, HighlightMessage, MessageView, Peek, PointMessage, Room, SayRequest, ScreenEvent, ShowRequest } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void };
type StatusLine = { text: string; error: boolean };
type Failure = { agent: string; error: string; time: string; earlier: number };
type Layout = { stacked: boolean; sideClosed: boolean; left: number | null; top: number | null };
const layoutKey = (folder: string, board: string) => 'agent-room:board-layout:' + JSON.stringify([folder, board]);
const boardName = (path: string | null | undefined) => path?.replace(/\/+$/, '').split('/').at(-1) || null;
function initialLayout(): Layout {
  try { return { stacked: localStorage.getItem('agent-room:split-orient') === 'stacked', sideClosed: localStorage.getItem('agent-room:side-closed') === '1', left: Number(localStorage.getItem('agent-room:left')) || null, top: Number(localStorage.getItem('agent-room:top')) || null }; }
  catch { return { stacked: false, sideClosed: false, left: null, top: null }; }
}
function readLayout(folder: string, board: string): Layout | null {
  try {
    const value = JSON.parse(localStorage.getItem(layoutKey(folder, board)) || 'null');
    if (!value || typeof value !== 'object') return null;
    const size = (v: unknown) => typeof v === 'number' && v > 0 ? Math.round(v) : null;
    return { stacked: !!value.stacked, sideClosed: !!value.sideClosed, left: size(value.left), top: size(value.top) };
  } catch { return null; }
}
const ATTACH_LIMIT = 25 * 1024 * 1024, ATTACH_TOTAL = 250 * 1024 * 1024;
const sizeText = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const base64 = (file: File) => new Promise<string>((ok, fail) => {
  const reader = new FileReader();
  reader.onload = () => { const value = String(reader.result); ok(value.slice(value.indexOf(',') + 1)); };
  reader.onerror = () => fail(reader.error || new Error(`could not read ${file.name}`));
  reader.readAsDataURL(file);
});

// Match the legacy page's file linking rules without modifying existing links or preformatted code.
function linkFiles(html: string, files: string[], active: string | null) {
  const container = document.createElement('div'); container.innerHTML = html;
  const nodes: Text[] = [], found: string[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('a, pre, .who') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parts = (node.textContent ?? '').split(/([\w~+-][\w~+./-]*\.[A-Za-z0-9]{1,6})/);
    if (parts.length < 2) continue;
    const fragment = document.createDocumentFragment(); let changed = false;
    parts.forEach((part, index) => {
      const word = part.replace(/^\.\//, '');
      const file = index % 2 ? (files.includes(word) ? word : active && files.includes(`${active}/${word}`) ? `${active}/${word}` : null) : null;
      if (!file) { fragment.append(part); return; }
      const link = document.createElement('a'); link.href = '#'; link.className = 'mention'; link.textContent = part;
      link.title = `Show ${file} in Document`; link.dataset.file = file; fragment.append(link);
      if (!found.includes(file)) found.push(file); changed = true;
    });
    if (changed) node.replaceWith(fragment);
  }
  return { html: container.innerHTML, found };
}
const displayTitle = (name: string | undefined, title: string | undefined) => {
  const saved = typeof title === 'string' ? title.trim() : '';
  return saved && saved !== name ? saved : (name ?? '').replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/, '').replace(/-/g, ' ');
};
const binary = /\.(icns|ico|bmp|tiff?|heic|avif|zip|tar|gz|tgz|bz2|xz|7z|rar|zst|dmg|pkg|iso|bin|exe|dll|so|dylib|a|o|wasm|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|m4a|aac|mp4|mov|webm|avi|mkv|sqlite3?|db|pyc|class|jar)$/i;
const inBoard = (file: string) => { const p = file.split('/'); return (p[0] === 'discussions' || p[0] === 'brainstorms') && (/^\d{4}-\d{2}-\d{2}-/.test(p[1] || '') || p[1] === 'archive' || p[1] === 'deferred'); };
function FileTree({ files, prefix, doc, unviewable, expanded, toggle, choose }: { files: string[]; prefix: string; doc: string | null; unviewable: string[]; expanded: Set<string>; toggle: (path: string, open: boolean) => void; choose: (path: string) => void }) {
  const folders = [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort();
  const entries = files.filter((f) => !f.includes('/')).sort();
  const buttons = entries.map((name) => {
    const file = prefix ? `${prefix}/${name}` : name, disabled = unviewable.includes(file) || binary.test(file);
    return <button key={file} className={'entry file' + (disabled ? ' unviewable' : file === doc ? ' shown' : '')} aria-current={!disabled && file === doc ? 'true' : undefined} disabled={disabled} title={disabled ? "can't be shown here" : undefined} onClick={() => choose(file)}>{name}{disabled ? " · can't be shown here" : ''}</button>;
  });
  return <>{folders.map((folder) => { const path = prefix ? `${prefix}/${folder}` : folder; return <details key={path} open={expanded.has(path)} onToggle={(event) => toggle(path, event.currentTarget.open)}><summary>{folder}/</summary><FileTree files={files.filter((f) => f.startsWith(folder + '/')).map((f) => f.slice(folder.length + 1))} prefix={path} doc={doc} unviewable={unviewable} expanded={expanded} toggle={toggle} choose={choose} /></details>; })}{entries.length > 10 ? <div className="file-columns">{buttons}</div> : buttons}{!folders.length && !entries.length && <span>No files yet.</span>}</>;
}

export function App({ version, refresh }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);
  const [yourTurn, setYourTurn] = useState(false);
  const [peek, setPeek] = useState<Peek | null>(null);
  const peekRef = useRef<Peek | null>(null);
  const roomRef = useRef<Room | null>(null);
  const liveMessages = useRef<MessageView[]>([]);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const knownFilesRef = useRef<string[]>([]);
  const fileLoad = useRef<Promise<FilesResponse> | null>(null);
  const preservePeekDoc = useRef(false);
  const [fileDetails, setFileDetails] = useState<FileDetailsResponse | null>(null);
  const [subtab, setSubtab] = useState<'explorer' | 'document'>('explorer');
  const [explorerMode, setExplorerMode] = useState<'discussion' | 'root'>('discussion');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const explorer = useRef<HTMLElement>(null);
  const [offers, setOffers] = useState<string[]>([]);
  const [doc, setDoc] = useState<string | null>(null);
  const docRef = useRef<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [pointed, setPointed] = useState<Pick<PointMessage, 'label' | 'text'>[]>([]);
  const viewing = useRef<unknown>(null);
  const [viewLayout, setViewLayout] = useState<{ name?: string; discussion?: string } | null>(null);
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const layoutContext = useRef<{ id: string; readonly: boolean; folder: string; board: string | null } | null>(null);
  const beforeReadOnly = useRef<Layout | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const applyLayout = (next: Layout, save = true, key?: string) => {
    layoutRef.current = next; setLayout(next);
    const context = layoutContext.current;
    if (!save || context?.readonly) return;
    try {
      if (key) localStorage.setItem('agent-room:' + key, key === 'split-orient' ? (next.stacked ? 'stacked' : 'side') : key === 'side-closed' ? (next.sideClosed ? '1' : '0') : String(key === 'left' ? next.left : next.top));
      if (context?.folder && context.board) localStorage.setItem(layoutKey(context.folder, context.board), JSON.stringify(next));
    } catch {}
  };
  useLayoutEffect(() => {
    const folder = room?.folder;
    if (!folder) return;
    const readonly = !!peek || !!viewLayout;
    const board = boardName(viewLayout ? viewLayout.name || viewLayout.discussion : peek ? peek.path || peek.name : room?.active);
    const id = JSON.stringify([readonly, folder, board || '']);
    const previous = layoutContext.current;
    if (previous?.id === id) return;
    if (readonly && !previous?.readonly) beforeReadOnly.current = { ...layoutRef.current };
    layoutContext.current = { id, readonly, folder, board };
    const saved = board ? readLayout(folder, board) : null;
    if (readonly) { if (saved) applyLayout(saved, false); return; }
    if (previous?.readonly) {
      const restore = saved || beforeReadOnly.current;
      beforeReadOnly.current = null;
      if (restore) applyLayout(restore, false);
      if (board && !saved) applyLayout(layoutRef.current);
    } else if (board) {
      if (saved) applyLayout(saved, false); else applyLayout(layoutRef.current);
    }
  }, [room?.folder, room?.active, peek, viewLayout]);
  const openDocument = () => { if (layoutRef.current.sideClosed) applyLayout({ ...layoutRef.current, sideClosed: false }, true, 'side-closed'); };
  const resize = (position: number, stacked: boolean, save: boolean) => {
    const bounds = panel.current?.getBoundingClientRect();
    if (!bounds) return;
    const available = (stacked ? bounds.height - (divider.current?.offsetHeight || 7) : bounds.width - (divider.current?.offsetWidth || 7));
    const minimum = stacked ? 140 : available > 0 && available < 520 ? Math.max(120, Math.floor(available / 2)) : 260;
    const size = Math.round(Math.max(minimum, Math.min(Math.max(minimum, available - minimum), position)));
    const next = { ...layoutRef.current, [stacked ? 'top' : 'left']: size };
    applyLayout(next, save, stacked ? 'top' : 'left');
  };
  const offerEpoch = useRef(0);
  const [follow, setFollow] = useState(() => { try { return localStorage.getItem('agent-room.followMentions') === '1'; } catch { return false; } });
  const followRef = useRef(follow); followRef.current = follow;
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
  const post = async (path: '__say' | '__show', body: SayRequest | ShowRequest) => {
    const state = busyState.current; state.posting++; updateBusy();
    try {
      return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': client.current }, body: JSON.stringify(body) });
    } finally { state.posting--; updateBusy(); }
  };
  const send = async () => {
    let prepared = text;
    if (pointed.length && !text.trim().startsWith('/')) {
      prepared = text.trimEnd() + (text.trim() ? '\n' : '') + '[pointing at: ' + pointed.map((point) => point.text).join('; ') + ']';
      setPointed([]);
      // The legacy composer consumes the line immediately without attachments;
      // with attachments it remains editable until the request succeeds.
      setText(files.length ? prepared : '');
    }
    const value = prepared.trim();
    if (sending || ended || (!value && !files.length) || (peek && (!value.startsWith('/') || files.length > 0))) return;
    const fail = (reason: string) => addStatus(`✗ ${reason} Nothing was sent.`, true);
    if (value === '/docs' && !files.length) { setSubtab('explorer'); openDocument(); void loadDetails(); setText(''); return; }
    if (files.length && value.startsWith('/')) return fail('Attachments go with a message, not a command.');
    const tooBig = files.find((file) => file.size > ATTACH_LIMIT);
    if (tooBig) return fail(`${tooBig.name} is over 25 MB.`);
    if (files.reduce((total, file) => total + file.size, 0) > ATTACH_TOTAL) return fail('Over 250 MB at once: attach fewer files per message.');
    setSending(true);
    try {
      const body: SayRequest = { text: value };
      if (files.length) body.files = await Promise.all(files.map(async (file) => ({ name: file.name, data: await base64(file) })));
      let response = await post('__say', body);
      if (response.status === 409 && !files.length && (value === '/restart' || value === '/shutdown')) {
        if (!window.confirm(await response.text())) return;
        response = await post('__say', { text: value, confirmed: true });
      }
      if (!response.ok) { const error = await response.text(); addStatus(files.length ? `✗ ${error}` : error, true); return; }
      setText((current) => current === text || current === prepared ? '' : current); setFiles([]);
    } catch (error) {
      fail(`Couldn't send${files.length ? ' the attachments' : ' the message'}: ${error instanceof Error ? error.message : String(error)}.`);
    } finally { setSending(false); }
  };

  useEffect(() => {
    const point = (event: MessageEvent<unknown>) => {
      if (event.origin !== location.origin || !frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as Partial<PointMessage> | null;
      if (data?.type !== 'agent-room:point' || typeof data.label !== 'string' || typeof data.text !== 'string') return;
      const label = data.label, text = data.text;
      setPointed((previous) => [...previous.filter((item) => item.label !== label), { label: label.slice(0, 80), text: text.slice(0, 300) }]);
    };
    const reference = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const ref = target.closest<HTMLElement>('.ref[data-ref]');
      if (!ref || !frame.current?.contentWindow) return;
      if (event.type === 'click') { openDocument(); setSubtab('document'); }
      const message: HighlightMessage = { type: 'agent-room:highlight', ref: ref.dataset.ref ?? '', on: event.type !== 'mouseout' };
      frame.current.contentWindow.postMessage(message, location.origin);
    };
    window.addEventListener('message', point);
    document.addEventListener('mouseover', reference); document.addEventListener('mouseout', reference); document.addEventListener('click', reference);
    return () => {
      window.removeEventListener('message', point);
      document.removeEventListener('mouseover', reference); document.removeEventListener('mouseout', reference); document.removeEventListener('click', reference);
    };
  }, []);

  const showFile = async (file: string) => {
    setOffers([]); offerEpoch.current++;
    try { await post('__show', { file }); } catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
  };
  const loadFiles = (): Promise<FilesResponse> => {
    if (fileLoad.current) return fileLoad.current;
    fileLoad.current = (async () => {
      try {
        const value: unknown = await (await fetch('__files')).json();
        const next = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        knownFilesRef.current = next; setKnownFiles(next); return next;
      } catch { return knownFilesRef.current; }
      finally { fileLoad.current = null; }
    })();
    return fileLoad.current;
  };
  const loadDetails = async () => {
    try {
      const response = await fetch('__files?detail=1');
      if (!response.ok) return;
      const raw: FileDetailsResponse | string[] = await response.json();
      const value = Array.isArray(raw) ? { files: raw, unviewable: [], branch: null } : raw;
      if (Array.isArray(value?.files)) setFileDetails(value);
    } catch {}
  };
  const backToCurrent = async () => {
    preservePeekDoc.current = true;
    try {
      const response = await post('__say', { text: '/peek' });
      if (!response.ok) { preservePeekDoc.current = false; addStatus(await response.text(), true); return; }
      // Reset normally arrives first; retain the live transcript if the HTTP reply wins the race.
      if (peekRef.current) { peekRef.current = null; setPeek(null); setMessages(liveMessages.current); }
    } catch (error) { preservePeekDoc.current = false; addStatus(error instanceof Error ? error.message : String(error), true); }
  };

  useEffect(() => {
    let stamp: { file: string; time: string } | null = null;
    let mounted = true;
    const timer = setInterval(async () => {
      const shown = docRef.current;
      if (!shown || viewing.current || shown.startsWith('__received/') || /\.md$/i.test(shown)) return;
      let time: string;
      try { time = await (await fetch('__mtime?f=' + encodeURIComponent(shown), { cache: 'no-store' })).text(); } catch { return; }
      if (!mounted || shown !== docRef.current || time === 'false') return;
      if (stamp?.file === shown && stamp.time !== time) frame.current?.contentWindow?.location.reload();
      stamp = { file: shown, time };
    }, 2000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

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
        viewing.current = event.viewing;
        setViewLayout(event.viewing && typeof event.viewing === 'object' ? event.viewing as { name?: string; discussion?: string } : null);
        roomRef.current = event.room; peekRef.current = event.peek ?? null;
        setRoom(event.room); setPeek(event.peek ?? null); setInput(event.input);
        if (event.peek) { setExplorerMode('discussion'); void loadDetails(); }
        else if (event.room?.folder) void loadDetails();
        if (!preservePeekDoc.current || event.peek) { docRef.current = event.doc ?? null; setDoc(event.doc ?? null); setSubtab(event.doc ? 'document' : 'explorer'); }
        if (!event.peek) preservePeekDoc.current = false;
        offerEpoch.current++; setOffers([]);
        const visible = event.messages.filter((m) => !m.pass && !m.hidden);
        setMessages(visible);
        if (!event.peek) { liveMessages.current = visible; if (visible.length) void loadFiles(); }
        setThinking(event.thinking ?? null); setYourTurn(!event.thinking);
        if (event.status) addStatus(event.status);
        state.command = !!event.busy; updateBusy();
      } else if (event.type === 'message') {
        if (event.message.speaker === 'User') { setYourTurn(false); offerEpoch.current++; setOffers([]); }
        if (event.message.error) pin(event.message.speaker, event.message.errorText ?? '');
        if (!event.message.pass && !event.message.hidden) {
          const message = event.message;
          liveMessages.current = [...liveMessages.current, message];
          if (!peekRef.current) {
            setMessages(liveMessages.current);
            const eligible = message.speaker !== 'User' && message.speaker !== 'Relayed from discussion' && !message.error;
            const epoch = ++offerEpoch.current, active = roomRef.current?.active ?? null;
            void loadFiles().then((paths) => {
              if (!eligible || epoch !== offerEpoch.current || peekRef.current) return;
              const found = linkFiles(message.html, paths, active).found.filter((file) => file !== docRef.current).slice(0, 3);
              if (found.length && followRef.current) void showFile(found[0]);
              else if (found.length) setOffers(found);
            });
          }
        }
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
      } else if (event.type === 'doc') {
        docRef.current = event.file; setDoc(event.file); setSubtab(event.file ? 'document' : 'explorer'); if (event.file) openDocument();
      } else if (event.type === 'room') {
        const changed = roomRef.current && roomRef.current.active !== event.room.active;
        if (changed && peekRef.current) {
          peekRef.current = null; setPeek(null); setMessages([]); liveMessages.current = []; offerEpoch.current++; setOffers([]);
        }
        roomRef.current = event.room; setRoom(event.room); if (event.room.folder) void loadDetails();
      } else if (event.type === 'files') {
        setSubtab('explorer'); void loadDetails();
      } else if (event.type === 'ended') {
        setEnded(true); addStatus('This room has ended. You can close this window.'); events.close();
      } else if (event.type === 'restarting') {
        setEnded(true); state.command = true; updateBusy(); addStatus('Restarting the server: this page reloads when the new one answers.'); events.close();
      }
    };
    return () => { events.close(); clearTimeout(state.show); clearTimeout(state.fail); state.show = undefined; state.fail = undefined; };
  }, [version, refresh]);

  const title = displayTitle(peek?.name ?? room?.active?.split('/').at(-1), peek?.title ?? room?.discussion) || 'agent-room';
  const turnVisible = !!room?.started && yourTurn && !thinking && !peek && room.autoDev?.status !== 'running';
  const base = peek?.path ?? room?.active ?? null;
  const rootMode = explorerMode === 'root' || !base;
  const treeFiles = rootMode ? (fileDetails?.files ?? []).filter((file) => !inBoard(file)) : (fileDetails?.files ?? []).filter((file) => file.startsWith(base + '/')).map((file) => file.slice(base!.length + 1));
  const reveal = async () => {
    openDocument(); setSubtab('explorer');
    const file = docRef.current, prefix = rootMode ? '' : base;
    if (file && !file.startsWith('__received/') && !viewing.current && (rootMode ? !inBoard(file) : !!prefix && file.startsWith(prefix + '/'))) {
      const parts = file.split('/'); setExpanded((previous) => { const next = new Set(previous); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/')); return next; });
    }
    await loadDetails();
    requestAnimationFrame(() => explorer.current?.querySelector<HTMLElement>('.shown')?.scrollIntoView?.({ block: 'center' }));
  };
  return <main>
    <h1>{title}</h1>
    <div ref={panel} className={'next-layout' + (layout.stacked ? ' stacked' : '') + (layout.sideClosed ? ' closed' : '')} style={{ '--left': layout.left ? layout.left + 'px' : '55%', '--top': layout.top ? layout.top + 'px' : '55%' } as React.CSSProperties}>
    <div ref={conversation} className="next-conversation">
    {layout.sideClosed && <button type="button" title="Open side pane" onClick={() => applyLayout({ ...layoutRef.current, sideClosed: false }, true, 'side-closed')}>Open side pane</button>}
    {peek && <p>peeking at {displayTitle(peek.name, peek.title)} · read-only</p>}
    {turnVisible && <p aria-label="Turn status">your turn</p>}
    <section aria-label="Activity" aria-live="polite">
      {failure && <div><span title={failure.error}>✗ {failure.agent} failed {failure.time}: {failure.error.split(/\r?\n/)[0]}{failure.earlier ? ` (+${failure.earlier} earlier)` : ''}</span> <button type="button" title="Dismiss" aria-label="Dismiss pinned error" onClick={() => setFailure(null)}>✕</button></div>}
      {status.map((line, index) => <p key={index} className={line.error ? 'status error' : 'status'} title={line.text}>{line.text}</p>)}
    </section>
    {busy && <div aria-label="Busy" data-state={busy}>{busy === 'on' ? 'Working…' : 'Action failed'}</div>}
    <section aria-label="Conversation">{messages.map((message, index) => <article key={index} className={'msg' + (message.error ? ' error' : '') + (message.outcome ? ' summary' + (message.outcome === 'agreed' ? '' : ' not-agreed') : '')}>
      <strong>{message.speaker}{message.error ? ' — failed' : ''}{message.meta ? ` · ${String(message.meta)}` : ''}</strong><div onClick={(event) => { const target = (event.target as Element).closest<HTMLAnchorElement>('a.mention'); if (target?.dataset.file) { event.preventDefault(); void showFile(target.dataset.file); } }} dangerouslySetInnerHTML={{ __html: peek ? message.html : linkFiles(message.html, knownFiles, room?.active ?? null).html }} />
    </article>)}</section>
    {thinking && <p>… {thinking} is thinking</p>}
    {offers.length > 0 && <div aria-label="File mentions">{offers.map((file) => <button type="button" key={file} title={`Show ${file} in Document`} onClick={() => void showFile(file)}>📄 Show {file.split('/').at(-1)}</button>)} <button type="button" title="Dismiss" aria-label="Dismiss file mentions" onClick={() => { offerEpoch.current++; setOffers([]); }}>✕</button></div>}
    <label><input type="checkbox" checked={follow} onChange={(event) => { const checked = event.target.checked; setFollow(checked); try { localStorage.setItem('agent-room.followMentions', checked ? '1' : '0'); } catch {} }} /> Follow mentions</label>
    {input && <div className="composer">
      <textarea aria-label="Message to the agents" value={text} disabled={ended} onChange={(event) => setText(event.target.value)}
        placeholder={peek ? 'Peeking read-only — click Back to return to the active discussion.' : 'Message to the agents… (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown'}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div><button type="button" title="Attach files to your next message: saved into the files/ folder when you send it (25 MB at most each)" disabled={sending || ended || !!peek || !room?.active} onClick={() => fileInput.current?.click()}>📎 Attach</button>
        <input ref={fileInput} type="file" aria-label="Attach files" multiple hidden onChange={(event) => { const chosen = Array.from(event.target.files ?? []); setFiles((previous) => [...previous, ...chosen]); event.target.value = ''; }} />
        {files.map((file, index) => <span key={index}>{file.name} · {sizeText(file.size)} <button type="button" title="Remove this attachment" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((previous) => previous.filter((_, i) => i !== index))}>✕</button></span>)}
        {pointed.map((point, index) => <span className="chip" title={point.text} key={index}>{point.label} <button type="button" title="Stop pointing at this" aria-label={`Stop pointing at ${point.label}`} onClick={() => setPointed((previous) => previous.filter((_, i) => i !== index))}>✕</button></span>)}
        {sending && files.length > 0 && <span>Saving the attachments…</span>}
      </div>
    </div>}
    </div>
    <div ref={divider} role="separator" tabIndex={0} aria-label="Resize conversation and side pane" aria-orientation={layout.stacked ? 'horizontal' : 'vertical'} className="next-divider"
      onKeyDown={(event) => {
        const stacked = layoutRef.current.stacked;
        if (!(stacked ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']).includes(event.key)) return;
        event.preventDefault(); const rect = conversation.current?.getBoundingClientRect();
        const size = stacked ? rect?.height : rect?.width;
        resize((size || (stacked ? layoutRef.current.top : layoutRef.current.left) || 0) + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -24 : 24), stacked, true);
      }}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = panel.current?.getBoundingClientRect(); if (bounds) resize((layoutRef.current.stacked ? event.clientY - bounds.top : event.clientX - bounds.left) - 3, layoutRef.current.stacked, false); }}
      onPointerCancel={(event) => { const bounds = panel.current?.getBoundingClientRect(); if (bounds) resize((layoutRef.current.stacked ? event.clientY - bounds.top : event.clientX - bounds.left) - 3, layoutRef.current.stacked, true); }}
      onPointerUp={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = panel.current?.getBoundingClientRect(); if (bounds) resize((layoutRef.current.stacked ? event.clientY - bounds.top : event.clientX - bounds.left) - 3, layoutRef.current.stacked, true); event.currentTarget.releasePointerCapture(event.pointerId); }} />
    <div className="next-side" hidden={layout.sideClosed}>
      <div><button type="button" title={layout.stacked ? 'Place conversation and side pane side by side' : 'Stack conversation above side pane'} onClick={() => applyLayout({ ...layoutRef.current, stacked: !layoutRef.current.stacked }, true, 'split-orient')}>{layout.stacked ? '⇆' : '⇅'}</button> <button type="button" title="Close side pane" onClick={() => applyLayout({ ...layoutRef.current, sideClosed: true }, true, 'side-closed')}>✕</button></div>
      <div><button type="button" aria-label={peek ? 'Explorer tab' : undefined} data-peeking={peek ? 'true' : undefined} aria-pressed={subtab === 'explorer'} onClick={() => void reveal()}>Explorer</button> <button type="button" disabled={!doc} aria-pressed={subtab === 'document'} onClick={() => { openDocument(); setSubtab('document'); }}>Document</button></div>
      <section ref={explorer} aria-label={peek ? 'Peeked board files' : 'Explorer files'} hidden={subtab !== 'explorer'}>
        {peek && <p>Looking at <b>{displayTitle(peek.name, peek.title)}</b> <button type="button" onClick={() => void backToCurrent()}>Back to current</button></p>}
        <div><button type="button" disabled={!base} aria-pressed={!rootMode} onClick={() => setExplorerMode('discussion')}>Discussion</button> <button type="button" aria-pressed={rootMode} onClick={() => setExplorerMode('root')}>Room checkout</button> <button type="button" disabled title="Coming soon">Worker copy</button></div>
        <p>{rootMode ? `${room?.folder?.replace(/\/+$/, '').split('/').at(-1) || 'agent-room'}/ · ${fileDetails?.branch || 'main'}` : `${base}/`}</p>
        <FileTree files={treeFiles} prefix={rootMode ? '' : base!} doc={doc} unviewable={fileDetails?.unviewable ?? []} expanded={expanded} toggle={(path, open) => setExpanded((previous) => { const next = new Set(previous); if (open) next.add(path); else next.delete(path); return next; })} choose={(file) => { if (peek && !rootMode) { docRef.current = file; setDoc(file); setSubtab('document'); openDocument(); } else void showFile(file); }} />
      </section>
      {doc && <section className="next-document" aria-label="Document" hidden={subtab !== 'document'}><p>Selected file: {doc}</p><iframe ref={frame} title="Document viewer" src={doc.split('/').map(encodeURIComponent).join('/')} /></section>}
    </div>
    </div>
  </main>;
}
