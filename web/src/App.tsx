/// <reference types="vite/client" />
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './layout.css';
import type { FileDetailsResponse, FilesResponse, HighlightMessage, MessageView, Peek, PointMessage, Room, SayRequest, ScreenEvent, ShowRequest, WorkerInfo, WorkerInfoRequest } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void; navigate?: (url: string) => void };
type StatusLine = { text: string; error: boolean };
type Failure = { agent: string; error: string; time: string; earlier: number };
type Layout = { stacked: boolean; sideClosed: boolean; left: number | null; top: number | null };
type OrderKind = 'discussions' | 'brainstorms';
const orderKey = (folder: string, kind: OrderKind) => `agent-room.${kind === 'discussions' ? 'discussion' : 'brainstorm'}-order:${folder}`;
function readOrder(folder: string, kind: OrderKind): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(orderKey(folder, kind)) || '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
}
function orderedNames(found: string[], saved: string[]): string[] {
  const here = new Set(found), kept = [...new Set(saved)].filter((name) => here.has(name)), known = new Set(kept);
  return [...found.filter((name) => !known.has(name)), ...kept];
}
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

const navigatePage = (url: string) => window.location.assign(url);
export function App({ version, refresh, navigate = navigatePage }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [workerInfo, setWorkerInfo] = useState<WorkerInfo | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);
  const [yourTurn, setYourTurn] = useState(false);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [filePeek, setFilePeek] = useState<{ path: string; name: string; title: string; readonly: boolean } | null>(null);
  const peekRef = useRef<Peek | null>(null);
  const roomRef = useRef<Room | null>(null);
  const liveMessages = useRef<MessageView[]>([]);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const knownFilesRef = useRef<string[]>([]);
  const fileLoad = useRef<Promise<FilesResponse> | null>(null);
  const preservePeekDoc = useRef(false);
  const [fileDetails, setFileDetails] = useState<FileDetailsResponse | null>(null);
  const [boardsClosed, setBoardsClosed] = useState(() => { try { return localStorage.getItem('agent-room:list-collapsed') === '1'; } catch { return false; } });
  const [armedCreation, setArmedCreation] = useState<Record<string, boolean>>({});
  const creationTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const timer of Object.values(creationTimers.current)) clearTimeout(timer); }, []);
  const [armedActions, setArmedActions] = useState<Record<string, boolean>>({});
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [pendingArchives, setPendingArchives] = useState<Set<string>>(() => new Set());
  const pendingArchivesRef = useRef(pendingArchives); pendingArchivesRef.current = pendingArchives;
  const rowMenuRef = useRef<string | null>(null); rowMenuRef.current = rowMenu;
  const actionTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const actionsMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (event.target instanceof Node && !actionsMenu.current?.contains(event.target) && actionsMenu.current) actionsMenu.current.open = false; if (event.target instanceof Element && !event.target.closest('.row-menu')) setRowMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (actionsMenu.current) actionsMenu.current.open = false; setRowMenu(null); } };
    document.addEventListener('click', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', escape); for (const timer of Object.values(actionTimers.current)) clearTimeout(timer); };
  }, []);
  const [boardSections, setBoardSections] = useState(() => new Set(['discussions', 'research', 'brainstorms']));
  const [orderRevision, setOrderRevision] = useState(0);
  const [dragged, setDragged] = useState<{ kind: OrderKind; name: string; names: string[] } | null>(null);
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
  const post = async (path: '__say' | '__show' | '__workerinfo', body: SayRequest | ShowRequest | WorkerInfoRequest) => {
    const state = busyState.current; state.posting++; updateBusy();
    try {
      return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': client.current }, body: JSON.stringify(body) });
    } finally { state.posting--; updateBusy(); }
  };
  const refreshWorker = () => { void post('__workerinfo', {}).catch(() => {}); };
  useEffect(() => {
    let last = -Infinity;
    const refresh = () => { if (document.visibilityState === 'hidden' || Date.now() - last < 5000) return; last = Date.now(); refreshWorker(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
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
  const boardCommand = async (text: string) => {
    try { const response = await post('__say', { text }); if (!response.ok) addStatus(await response.text(), true); }
    catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
  };
  const archiveBoard = async (path: string, ref: string) => {
    if (ended || pendingArchives.has(path)) return;
    setPendingArchives((previous) => new Set(previous).add(path));
    try {
      const response = await post('__say', { text: '/move ' + ref + ' archive' });
      if (response.ok) return;
      addStatus(await response.text(), true);
    } catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
    setPendingArchives((previous) => { const next = new Set(previous); next.delete(path); return next; });
    void loadDetails();
  };
  const createBoard = (command: string) => {
    if (!room?.multi && room?.started && !armedCreation[command]) {
      setArmedCreation((previous) => ({ ...previous, [command]: true }));
      creationTimers.current[command] = setTimeout(() => { setArmedCreation((previous) => ({ ...previous, [command]: false })); delete creationTimers.current[command]; }, 4000);
      return;
    }
    void boardCommand(command);
  };
  const runAction = (key: string, command: string, confirm: boolean) => {
    if (confirm && !armedActions[key]) {
      setArmedActions((previous) => ({ ...previous, [key]: true }));
      actionTimers.current[key] = setTimeout(() => { setArmedActions((previous) => ({ ...previous, [key]: false })); delete actionTimers.current[key]; }, 4000);
      return;
    }
    if (actionsMenu.current) actionsMenu.current.open = false;
    void boardCommand(command);
  };
  const saveOrder = (kind: OrderKind, names: string[]) => {
    const folder = roomRef.current?.folder;
    if (!folder) return;
    try { localStorage.setItem(orderKey(folder, kind), JSON.stringify(names)); } catch {}
    setOrderRevision((revision) => revision + 1);
  };
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      const folder = roomRef.current?.folder;
      if (folder && (event.key === orderKey(folder, 'discussions') || event.key === orderKey(folder, 'brainstorms'))) setOrderRevision((revision) => revision + 1);
    };
    window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed);
  }, []);
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
        setWorkerInfo(event.workerInfo ?? null);
        viewing.current = event.viewing;
        setViewLayout(event.viewing && typeof event.viewing === 'object' ? event.viewing as { name?: string; discussion?: string } : null);
        roomRef.current = event.room; peekRef.current = event.peek ?? null;
        setRoom(event.room); setPeek(event.peek ?? null); setInput(event.input);
        if (event.peek) { setFilePeek(null); setExplorerMode('discussion'); void loadDetails(); }
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
        if (event.error && pendingArchivesRef.current.size) { setPendingArchives(new Set()); void loadDetails(); }
      } else if (event.type === 'busy') {
        state.command = event.on; updateBusy();
      } else if (event.type === 'workerinfo') {
        setWorkerInfo(event.info);
      } else if (event.type === 'doc') {
        docRef.current = event.file; setDoc(event.file); setSubtab(event.file ? 'document' : 'explorer'); if (event.file) openDocument();
      } else if (event.type === 'room') {
        const changed = roomRef.current && roomRef.current.active !== event.room.active;
        if (changed && peekRef.current) {
          peekRef.current = null; setPeek(null); setMessages([]); liveMessages.current = []; offerEpoch.current++; setOffers([]);
        }
        if (changed) setFilePeek(null);
        roomRef.current = event.room; setRoom(event.room); if (event.room.folder) void loadDetails();
      } else if (event.type === 'files') {
        setSubtab('explorer'); void loadDetails();
      } else if (event.type === 'moved') {
        setPendingArchives((previous) => { const next = new Set(previous); next.delete(event.from); return next; });
        const folder = roomRef.current?.folder, name = event.from?.split('/').at(-1);
        if (folder && name) {
          const kind: OrderKind = event.from.startsWith('brainstorms/') ? 'brainstorms' : 'discussions';
          saveOrder(kind, readOrder(folder, kind).filter((item) => item !== name));
        }
        void loadDetails();
      } else if (event.type === 'goto') {
        navigate(event.url.replace(/__room(?=([?#]|$))/, '__next'));
      } else if (event.type === 'ended') {
        setEnded(true); addStatus('This room has ended. You can close this window.'); events.close();
      } else if (event.type === 'restarting') {
        setEnded(true); state.command = true; updateBusy(); addStatus('Restarting the server: this page reloads when the new one answers.'); events.close();
      }
    };
    return () => { events.close(); clearTimeout(state.show); clearTimeout(state.fail); state.show = undefined; state.fail = undefined; };
  }, [version, refresh, navigate]);

  const title = displayTitle(peek?.name ?? room?.active?.split('/').at(-1), peek?.title ?? room?.discussion) || 'agent-room';
  const turnVisible = !!room?.started && yourTurn && !thinking && !peek && room.autoDev?.status !== 'running';
  const base = filePeek?.path ?? peek?.path ?? room?.active ?? null;
  const rootMode = explorerMode === 'root' || !base;
  const treeFiles = rootMode ? (fileDetails?.files ?? []).filter((file) => !inBoard(file)) : (fileDetails?.files ?? []).filter((file) => file.startsWith(base + '/')).map((file) => file.slice(base!.length + 1));
  const namesUnder = (prefix: string) => [...new Set((fileDetails?.files ?? []).filter((f) => f.startsWith(prefix + '/')).map((f) => f.slice(prefix.length + 1).split('/')).filter((parts) => parts.length > 1 && /^\d{4}-\d{2}-\d{2}-/.test(parts[0])).map((parts) => parts[0]))].sort((a, b) => b.localeCompare(a));
  const boardTitle = (name: string, path: string, brainstorm: boolean) => displayTitle(name, room?.open?.find((entry) => entry.active === path)?.title ?? (room?.active === path ? room.discussion : undefined) ?? room?.checkpoints?.find((entry) => entry.name === (brainstorm ? 'brainstorms/' + name : name))?.title);
  const boardRow = (name: string, path: string, brainstorm: boolean, archived = false, ordering?: { kind: OrderKind; names: string[] }) => {
    const current = room?.active === path, open = room?.open?.find((entry) => entry.active === path && !entry.current);
    const entry = room?.open?.find((item) => item.active === path);
    const closed = brainstorm ? !current && !open : !!room?.closedDiscussions?.includes(name);
    const kind = brainstorm ? 'brainstorm' : room?.workbenches?.includes(name) ? 'workbench' : room?.researches?.includes(name) ? 'research' : 'discussion';
    const label = boardTitle(name, path, brainstorm);
    const work = workerInfo?.pending?.find((item) => item.lane === name);
    const isResearch = kind === 'research', isDiscussion = !brainstorm && !isResearch;
    const closing = brainstorm ? null : room?.closingDiscussions?.[name];
    const workerBusy = isDiscussion && !!(entry?.working || entry?.workerBusy || room?.busyWorkers?.includes(name));
    const conflicts = isDiscussion ? work?.conflicts ?? [] : [];
    const state = entry?.ongoing || entry?.working || closing || workerBusy ? 'ongoing' : closed ? 'closed' : conflicts.length ? 'waiting for input' : entry ? !entry.started ? 'not started' : entry.waitingForInput ? 'waiting for input' : entry.readyForAutoDev ? 'ready for auto dev' : entry.workReady && !entry.workbench && !entry.brainstorm ? 'work ready' : 'idle' : current && !room?.started ? 'not started' : 'idle';
    const merge = workerInfo?.mergeable?.[name];
    const suffix = state === 'work ready' && isDiscussion && merge ? merge.canMerge ? ' · mergeable' : merge.catchUp ? ' · needs catch-up' : ' · merge blocked' : '';
    const conflictText = conflicts.length ? 'Worker conflict: ' + conflicts.join(', ') : '';
    const tooltip = state === 'waiting for input' ? conflictText || entry?.waitingReason : suffix === ' · merge blocked' ? merge?.disabledReason : undefined;
    const closingText = closing ? closing === 'waiting' ? ' · closing · waiting for worker' : ' · closing · writing statement' : '';
    const changed = isDiscussion && !archived ? workerInfo?.merged?.includes(name) ? ' · merged' : workerInfo?.pending && !work ? ' · no changes' : '' : '';
    const pendingText = work ? [work.ahead && `${work.ahead} ${work.ahead === 1 ? 'commit' : 'commits'} not merged into main`, work.dirty && 'uncommitted changes'].filter(Boolean).join(' · ') : '';
    const stats = room?.researchStats?.[name];
    const count = Number.isSafeInteger(stats?.laps) && stats!.laps >= 0 ? stats!.laps : 0;
    const date = (value?: string | null) => { if (!value) return '—'; const d = new Date(value); return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    const ref = brainstorm ? path : archived ? path.slice('discussions/'.length) : name;
    const action = () => {
      if (current) { if (peekRef.current) void backToCurrent(); else setFilePeek(null); return; }
      if (closed || brainstorm) { setExplorerMode('discussion'); setSubtab('explorer'); void boardCommand('/peek ' + ref); }
      else if (!archived && input && !viewing.current) void boardCommand('/resume ' + ref);
      else { setFilePeek({ path, name, title: label, readonly: archived }); setExplorerMode('discussion'); setSubtab('explorer'); }
    };
    const content = <>{kind === 'workbench' ? '🔧 ' : kind === 'research' ? '🔬 ' : ''}{label}</>;
    const archivedState = archived ? (path.includes('/archive/') ? 'archived' : 'deferred') + (brainstorm ? ' brainstorm' : isResearch ? ' research' : '') + (!brainstorm && closed ? ' · closed' : '') + closingText + (isDiscussion && workerInfo?.merged?.includes(name) ? ' · merged' : '') : null;
    const index = ordering?.names.indexOf(name) ?? -1;
    const reorder = (from: string, to: number) => { if (!ordering) return; const next = ordering.names.filter((item) => item !== from); next.splice(Math.max(0, Math.min(to, next.length)), 0, from); saveOrder(ordering.kind, next); };
    return <div className="board-row" key={path} onDragOver={(event) => { if (dragged && ordering?.kind === dragged.kind) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={(event) => { if (!dragged || !ordering || dragged.kind !== ordering.kind || dragged.name === name) return; event.preventDefault(); const remaining = dragged.names.filter((item) => item !== dragged.name); const bounds = event.currentTarget.getBoundingClientRect(); const target = remaining.indexOf(name); if (target < 0) return; remaining.splice(target + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0), 0, dragged.name); saveOrder(dragged.kind, remaining); setDragged(null); }}>
      {ordering && ordering.names.length > 1 && <span draggable title="Drag to reorder" aria-label={`Drag ${label} to reorder`} onDragStart={(event) => { setDragged({ kind: ordering.kind, name, names: ordering.names }); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragEnd={() => setDragged(null)}>⠿</span>}
      {open ? <a className={'entry ' + kind} title={path} href={open.url.replace(/__room(?=([?#]|$))/, '__next')}>{content}</a> : <button type="button" className={'entry ' + kind} title={path} aria-current={current ? 'true' : undefined} onClick={action}>{content}</button>}
      <div className="local-label" title={tooltip || undefined}>{archivedState ?? (state + suffix + (isDiscussion && entry?.working ? ' · worker working' : '') + closingText + changed)}</div>
      {isDiscussion && !archived && work && <div className="worker-pending">⚠ Worker: {pendingText}</div>}
      {!!conflictText && !workerBusy && <div className="worker-conflict">⚠ {conflictText}</div>}
      {isResearch && <div className="local-label"><span className={count > 30 ? 'research-laps-high' : undefined}>Laps: {stats?.priorUnknown ? '≥' : ''}{count}</span> · Last: {date(stats?.lastRun)} · Next: {date(stats?.nextRun)}</div>}
      {!!(room && input && !viewing.current) && <details className="row-menu" open={rowMenu === path} onToggle={(event) => { const isOpen = event.currentTarget.open; if (isOpen && rowMenuRef.current !== path) { if (actionsMenu.current) actionsMenu.current.open = false; rowMenuRef.current = path; setRowMenu(path); refreshWorker(); } else if (!isOpen && rowMenuRef.current === path) { rowMenuRef.current = null; setRowMenu(null); } }}>
        <summary aria-label={`Board actions for ${label}`} title="Actions">⋯</summary><div className="row-menu-items" hidden={rowMenu !== path}>
          {current && peek && <button type="button" title={`Return to this ${isResearch ? 'research board' : kind}: leave the peek.`} onClick={() => { setRowMenu(null); void backToCurrent(); }}>Back to this {isResearch ? 'research board' : kind}</button>}
          {!current && <>
            {open && !open.started ? <a href={open.url.replace(/__room(?=([?#]|$))/, '__next')} title={`Show this open ${kind}: it has not started yet`}>Go to</a> : <button type="button" title={archived ? `${closed ? 'Resume' : 'Continue'}: makes it active first` : closed ? 'Resume this board' : 'Continue this board'} onClick={() => { setRowMenu(null); if (open) navigate(open.url.replace(/__room(?=([?#]|$))/, '__next')); else void boardCommand('/resume ' + ref); }}>{open && brainstorm ? 'Go to' : closed ? 'Resume' : 'Continue'}</button>}
            <button type="button" title={`Show this ${isResearch ? 'research board’s' : brainstorm ? 'brainstorm’s' : 'discussion’s'} files in Explorer without switching`} onClick={() => { setRowMenu(null); setFilePeek({ path, name, title: label, readonly: archived || closed }); setExplorerMode('discussion'); setSubtab('explorer'); openDocument(); }}>Peek files</button>
            {closed && !isResearch && <button type="button" title="Look at this closed board read-only: its conversation and files, without reopening it." onClick={() => { setRowMenu(null); setExplorerMode('discussion'); setSubtab('explorer'); void boardCommand('/peek ' + ref); }}>Peek chat &amp; files</button>}
          </>}
          {!archived && (!closed || brainstorm) && <button type="button" disabled={brainstorm && !(current || open)} title={brainstorm && !(current || open) ? 'It is not open' : undefined} onClick={() => { setRowMenu(null); void boardCommand('/close ' + ref); }}>{!brainstorm && !isResearch && workerInfo?.pending?.some((item) => item.lane === name) ? 'Close with pending work' : 'Close'}</button>}
          {archived ? <>
            <button type="button" onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' active'); }}>Make active</button>
            {path.includes('/archive/') ? <button type="button" disabled={!brainstorm && !closed} title={!brainstorm && !closed ? `Close the ${isResearch ? 'research board' : 'discussion'} before moving it into deferred/.` : undefined} onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' deferred'); }}>Defer</button> : <button type="button" disabled={(!brainstorm && !closed) || pendingArchives.has(path)} aria-busy={pendingArchives.has(path)} title={!brainstorm && !closed ? `Close the ${isResearch ? 'research board' : 'discussion'} before moving it into archive/.` : undefined} onClick={() => void archiveBoard(path, ref)}>Archive</button>}
          </> : <>
            <button type="button" disabled={current || !closed || pendingArchives.has(path)} aria-busy={pendingArchives.has(path)} title={!closed ? `Close the ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'discussion'} before moving it into archive/.` : current && !brainstorm ? `The ${isResearch ? 'research board' : 'discussion'} in use cannot be moved` : `Move the whole ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'discussion'} into archive/`} onClick={() => void archiveBoard(path, ref)}>Archive</button>
            <button type="button" disabled={current || !closed} title={!closed ? `Close the ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'discussion'} before moving it into deferred/.` : current && !brainstorm ? `The ${isResearch ? 'research board' : 'discussion'} in use cannot be moved` : `Move the whole ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'discussion'} into deferred/`} onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' deferred'); }}>Defer</button>
          </>}
          {ordering && <><button type="button" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => { setRowMenu(null); reorder(name, index - 1); }}>Move up</button><button type="button" aria-label={`Move ${label} down`} disabled={index === ordering.names.length - 1} onClick={() => { setRowMenu(null); reorder(name, index + 1); }}>Move down</button></>}
        </div>
      </details>}
    </div>;
  };
  const discussions = namesUnder('discussions'), brainstorms = namesUnder('brainstorms');
  const research = discussions.filter((name) => room?.researches?.includes(name));
  const foundDiscussions = discussions.filter((name) => !room?.researches?.includes(name));
  const folder = room?.folder;
  const activeDiscussions = dragged?.kind === 'discussions' ? dragged.names : folder ? orderedNames(foundDiscussions, readOrder(folder, 'discussions')) : foundDiscussions;
  const orderedBrainstorms = dragged?.kind === 'brainstorms' ? dragged.names : folder ? orderedNames(brainstorms, readOrder(folder, 'brainstorms')) : brainstorms;
  useEffect(() => {
    if (!folder || !fileDetails || dragged) return;
    for (const [kind, found] of [['discussions', foundDiscussions], ['brainstorms', brainstorms]] as [OrderKind, string[]][]) {
      const next = orderedNames(found, readOrder(folder, kind));
      try { if (localStorage.getItem(orderKey(folder, kind)) !== JSON.stringify(next)) localStorage.setItem(orderKey(folder, kind), JSON.stringify(next)); } catch {}
    }
  }, [folder, fileDetails, room?.researches, orderRevision, dragged]);
  const canOrder = !!(room && input && !viewing.current && folder);
  const unstarted = (room?.open ?? []).filter((entry) => !entry.current && !entry.active);
  const openUnstarted = (researchBoard: boolean) => unstarted.filter((entry) => !!entry.research === researchBoard).map((entry) => {
    const state = entry.ongoing || entry.working ? 'ongoing' : !entry.started ? 'not started' : entry.waitingForInput ? 'waiting for input' : entry.readyForAutoDev ? 'ready for auto dev' : entry.workReady && !entry.workbench && !entry.brainstorm ? 'work ready' : 'idle';
    return <div className="board-row" key={entry.url}><a href={entry.url.replace(/__room(?=([?#]|$))/, '__next')}>{entry.workbench ? '🔧 ' : entry.research ? '🔬 ' : ''}{entry.title}</a><div className="local-label" title={state === 'waiting for input' ? entry.waitingReason || undefined : undefined}>{state}{entry.working && !researchBoard ? ' · worker working' : ''}</div>{researchBoard && <div className="local-label">Laps: 0 · Last: — · Next: —</div>}</div>;
  });
  const inactive = ['archive', 'deferred'].flatMap((section) => ['discussions', 'brainstorms'].flatMap((kind) => namesUnder(`${kind}/${section}`).map((name) => ({ name, path: `${kind}/${section}/${name}`, brainstorm: kind === 'brainstorms' }))));
  const sectionToggle = (key: string, open: boolean) => setBoardSections((previous) => { if (previous.has(key) === open) return previous; const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next; });
  const canAct = !!(room && input && !peek && !viewLayout);
  const canSummary = !!(room && !peek && !viewLayout && !room.workbench);
  const canClose = !!(canAct && room?.multi && (room.active || room.brainstorm || room.workbench || room.research || (room.open?.length ?? 0) > 1));
  const lane = !room?.brainstorm && !room?.research && room?.active?.startsWith('discussions/') ? room.active.slice('discussions/'.length) : null;
  const closeLabel = room?.brainstorm ? 'Close brainstorm' : room?.research ? 'Close' : lane && workerInfo?.pending?.some((item) => item.lane === lane) ? 'Close with pending work' : 'Close';
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
    {(canSummary || canAct) && <details ref={actionsMenu} className="actions-menu" onToggle={(event) => { if (event.currentTarget.open) { setRowMenu(null); refreshWorker(); } }}>
      <summary aria-label="Discussion actions" title="Actions">Actions</summary>
      <div>
        {canSummary && <button type="button" onClick={() => runAction('summary', '/summary', false)}>Summarize</button>}
        {canAct && <button type="button" title="Open a research board: investigate one question with no worker, saved in discussions/ with a .research marker." onClick={() => runAction('research', '/research', !room?.multi && !!room?.started)}>{armedActions.research ? 'Click again: this session ends and the chat clears' : 'New research'}</button>}
        {canAct && room?.active && (room.brainstorm || room.research) && <button type="button" title={room.research ? 'Keep the folder and start fresh discussion sessions; linked recurring tasks are turned off.' : 'Move this brainstorm to discussions/: its agents keep their sessions and are told the new folder.'} onClick={() => runAction('convert', '/convert ' + room.active, true)}>{armedActions.convert ? room.research ? 'Click again: research sessions end and scheduled tasks turn off' : 'Click again: it moves to discussions/' : 'Turn into a discussion'}</button>}
        {canAct && room?.active && room.brainstorm && <button type="button" title="Move it to discussions/ with a .research marker: the same agents start fresh sessions with the research rulebook, briefed from its transcripts and latest summary." onClick={() => runAction('convert-research', '/convert ' + room.active + ' research', true)}>{armedActions['convert-research'] ? 'Click again: it moves to discussions/ as a research board' : 'Turn into research'}</button>}
        {canClose && <button type="button" title="Close this discussion: its agents stop; the other open discussions stay. Its checkpoint is kept: Resume it from Discussions." onClick={() => runAction('close', '/close', !!room?.started)}>{armedActions.close ? 'Click again: this discussion closes (its agents stop)' : closeLabel}</button>}
      </div>
    </details>}
    {!!(room && input && !peek && !viewLayout && room.multi && !room.active && (room.brainstorm || room.workbench || room.research || (room.open?.length ?? 0) > 1)) && <button type="button" title="Discard this new board and return to the board you came from" onClick={() => void boardCommand('/cancel')}>Cancel</button>}
    <div className={'next-workspace' + (boardsClosed ? ' boards-closed' : '')}>
    <aside className="next-boards" aria-label="Boards">
      <div><b hidden={boardsClosed}>Boards</b> <button type="button" aria-label={boardsClosed ? 'Expand boards list' : 'Collapse boards list'} aria-expanded={!boardsClosed} onClick={() => { const next = !boardsClosed; setBoardsClosed(next); if (!next) refreshWorker(); try { localStorage.setItem('agent-room:list-collapsed', next ? '1' : '0'); } catch {} }}>{boardsClosed ? '»' : '«'}</button></div>
      {!boardsClosed && <div className="boards-list">
        {!!(room && input && !peek && !viewLayout) && <div className="boards-new">
          {!!(room.active || room.brainstorm || room.workbench || room.research) && <button type="button" title={room.multi ? 'Open a new discussion beside this one, which stays open (click it in Boards to show it again).' : 'End this session: the chat clears and your next message starts a new discussion. Its worker tasks finish in its own worker session; the new one gets a fresh worker session.'} onClick={() => createBoard('/new')}>{armedCreation['/new'] ? 'Click again: this session ends and the chat clears' : '+ New discussion'}</button>}
          <button type="button" title={room.multi ? 'A conversation with the same agents, beside the open discussions and brainstorms, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a discussion for that.' : 'A conversation with the same agents, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a discussion for that. It ends this session.'} onClick={() => createBoard('/brainstorm')}>{armedCreation['/brainstorm'] ? 'Click again: this session ends and the chat clears' : '+ New brainstorm'}</button>
          <button type="button" title="Open a research board: investigate one question with no worker, saved in discussions/ with a .research marker." onClick={() => createBoard('/research')}>{armedCreation['/research'] ? 'Click again: this session ends and the chat clears' : '+ New research'}</button>
        </div>}
        <details open={boardSections.has('discussions')} onToggle={(e) => sectionToggle('discussions', e.currentTarget.open)}><summary>Discussions ({activeDiscussions.length + unstarted.filter((entry) => !entry.research).length})</summary>{openUnstarted(false)}{workerInfo?.pending?.filter((item) => !activeDiscussions.includes(item.lane ?? '')).map((item) => <div className="worker-pending" key={item.branch}>⚠ {item.branch}: {[item.ahead && `${item.ahead} ${item.ahead === 1 ? 'commit' : 'commits'} not merged into main`, item.dirty && 'uncommitted changes'].filter(Boolean).join(' · ')}</div>)}{activeDiscussions.map((name) => boardRow(name, 'discussions/' + name, false, false, canOrder ? { kind: 'discussions', names: activeDiscussions } : undefined))}</details>
        <details open={boardSections.has('research')} onToggle={(e) => sectionToggle('research', e.currentTarget.open)}><summary>Research ({research.length + unstarted.filter((entry) => entry.research).length})</summary>{openUnstarted(true)}{research.map((name) => boardRow(name, 'discussions/' + name, false))}</details>
        <details open={boardSections.has('brainstorms')} onToggle={(e) => sectionToggle('brainstorms', e.currentTarget.open)}><summary>Brainstorms ({orderedBrainstorms.length})</summary>{orderedBrainstorms.map((name) => boardRow(name, 'brainstorms/' + name, true, false, canOrder ? { kind: 'brainstorms', names: orderedBrainstorms } : undefined))}</details>
        <details open={boardSections.has('archived-deferred')} onToggle={(e) => sectionToggle('archived-deferred', e.currentTarget.open)}><summary>Archived · Deferred ({inactive.length})</summary>{inactive.map(({ name, path, brainstorm }) => boardRow(name, path, brainstorm, true))}</details>
      </div>}
    </aside>
    <div ref={panel} className={'next-layout' + (layout.stacked ? ' stacked' : '') + (layout.sideClosed ? ' closed' : '')} style={{ '--left': layout.left ? layout.left + 'px' : '55%', '--top': layout.top ? layout.top + 'px' : '55%' } as React.CSSProperties}>
    <div ref={conversation} className="next-conversation">
    {layout.sideClosed && <button type="button" title="Open side pane" onClick={() => applyLayout({ ...layoutRef.current, sideClosed: false }, true, 'side-closed')}>Open side pane</button>}
    {peek && <p>peeking at {displayTitle(peek.name, peek.title)} · read-only</p>}
    {!!(room && !room.active && !peek && !viewLayout && !room.workbench) && <p>{room.brainstorm ? 'Your first message names this brainstorm and saves it here.' : room.research ? 'Your first message names this research board and saves it here.' : 'Your first message starts a new discussion.'}</p>}
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
      <div><button type="button" aria-label={peek || filePeek ? 'Explorer tab' : undefined} data-peeking={peek || filePeek ? 'true' : undefined} aria-pressed={subtab === 'explorer'} onClick={() => void reveal()}>Explorer</button> <button type="button" disabled={!doc} aria-pressed={subtab === 'document'} onClick={() => { openDocument(); setSubtab('document'); }}>Document</button></div>
      <section ref={explorer} aria-label={peek || filePeek ? 'Peeked board files' : 'Explorer files'} hidden={subtab !== 'explorer'}>
        {(peek || filePeek) && <p>Looking at <b>{displayTitle((peek || filePeek)!.name, (peek || filePeek)!.title)}</b> <button type="button" onClick={() => { if (peek) void backToCurrent(); else setFilePeek(null); }}>Back to current</button></p>}
        <div><button type="button" disabled={!base} aria-pressed={!rootMode} onClick={() => setExplorerMode('discussion')}>Discussion</button> <button type="button" aria-pressed={rootMode} onClick={() => setExplorerMode('root')}>Room checkout</button> <button type="button" disabled title="Coming soon">Worker copy</button></div>
        <p>{rootMode ? `${room?.folder?.replace(/\/+$/, '').split('/').at(-1) || 'agent-room'}/ · ${fileDetails?.branch || 'main'}` : `${base}/`}</p>
        <FileTree files={treeFiles} prefix={rootMode ? '' : base!} doc={doc} unviewable={fileDetails?.unviewable ?? []} expanded={expanded} toggle={(path, open) => setExpanded((previous) => { const next = new Set(previous); if (open) next.add(path); else next.delete(path); return next; })} choose={(file) => { if ((peek || filePeek?.readonly) && !rootMode) { docRef.current = file; setDoc(file); setSubtab('document'); openDocument(); } else void showFile(file); }} />
      </section>
      {doc && <section className="next-document" aria-label="Document" hidden={subtab !== 'document'}><p>Selected file: {doc}</p><iframe ref={frame} title="Document viewer" src={doc.split('/').map(encodeURIComponent).join('/')} /></section>}
    </div>
    </div>
    </div>
  </main>;
}
