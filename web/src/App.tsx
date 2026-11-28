/// <reference types="vite/client" />
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './legacy.css';
import './layout.css';
import { ChatList, type ChatMemory } from './ChatList';
import { WorkerInfoLine, shownWorkerInfo } from './WorkerInfoLine';
import { RoomZones } from './RoomZones';
import { FailedAgents, SettingsPanel } from './Settings';
import { TerminalPane } from './Terminal';
import { InstructionsPanel, ProvidersPanel, SchedulePanel } from './Services';
import { providerHealth } from './RoomZones';
import { Notes, NOTES_DRAFT_KEY, type NoteDraft, type NotesApi } from './Notes';
import { Office, computePassedAgents } from './Office';
import type { PromptTestRequest, ScheduleRequest, NoteRequest, AgentEnabledRequest, SettingsSaveRequest, Gauge, Monitor, NewRoomRequest, PairRequest, QuotaAt, ReceivedLine, Replica, ViewedLine, ViewReply, ViewRequest, AgentSettings, BoardActionRequest, CliSession, CatchUpReply, DiscardPreview, DiscardReply, FileDetailsResponse, FilesResponse, HighlightMessage, MergePreview, MergeReply, MessageView, Peek, PointMessage, RetryRequest, Room, SayRequest, ScreenEvent, SettingsReply, ShowRequest, StopWorkerRequest, WorkerInfo, WorkerInfoRequest, WorkerMessage, WorkRequest } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void; navigate?: (url: string) => void };
const SNAP_SIZE = 80;
function Splitter({ id, label, horizontal = false, dividerRef, onStart, onMove, onEnd, onKeyDown }: {
  id: string; label: string; horizontal?: boolean; dividerRef?: React.Ref<HTMLDivElement>;
  onStart: () => void; onMove: (x: number, y: number) => void; onEnd: (x: number, y: number) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const [dragging, setDragging] = useState(false);
  return <div ref={dividerRef} id={id} className={'next-divider' + (dragging ? ' dragging' : '')} role="separator" tabIndex={0} aria-label={label} aria-orientation={horizontal ? 'horizontal' : 'vertical'} title="Drag to resize"
    onKeyDown={onKeyDown}
    onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); onStart(); }}
    onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onMove(event.clientX, event.clientY); }}
    onPointerUp={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; onEnd(event.clientX, event.clientY); event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
    onPointerCancel={(event) => { onEnd(event.clientX, event.clientY); setDragging(false); }}><span aria-hidden="true">⋮</span></div>;
}
type StatusLine = { text: string; error: boolean };
type Failure = { agent: string; error: string; time: string; earlier: number };
type Layout = { stacked: boolean; sideClosed: boolean; left: number | null; top: number | null };
type BoardDialog = { kind: 'merge'; name: string; preview: MergePreview; changed: boolean; error?: string } | { kind: 'discard'; name: string; preview: DiscardPreview; changed: boolean; error?: string } | { kind: 'catchup'; name: string; target: string; behind: number; message: string; changed: boolean; error?: string };
type Service = 'providers' | 'instructions' | 'schedule' | 'notes' | 'terminal' | 'office';
const SERVICES: Record<Service, string> = { providers: 'Providers', instructions: 'Instructions', schedule: 'Schedule', notes: 'My notes', terminal: 'Terminal', office: 'Office' };
const BOARD_ICONS = new Map<string, { icon: string; label: string }>([
  ['sprint', { icon: '🏃', label: 'Sprint' }],
  ['workbench', { icon: '🔧', label: 'Workbench' }],
  ['research', { icon: '🔬', label: 'Research' }],
  ['brainstorm', { icon: '💡', label: 'Brainstorm' }],
]);
type OrderKind = 'sprints' | 'brainstorms';
const orderKey = (folder: string, kind: OrderKind) => `agent-room.${kind === 'sprints' ? 'discussion' : 'brainstorm'}-order:${folder}`;
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
function autoOfferHtml(html: string, offer: { text?: string; error?: string }, max: number) {
  const container = document.createElement('div'); container.innerHTML = html;
  const box = document.createElement('div'); box.className = 'autodev-offer';
  if (offer.text) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Start auto dev'; button.dataset.autoDev = 'start';
    box.append(button, document.createTextNode(`Sends this instruction as cycle 1 of up to ${max}.`));
  } else { const text = document.createElement('span'); text.textContent = `Auto dev can’t send this instruction: ${offer.error}.`; box.append(text); }
  const after = [...container.children].find((child) => /^(Later|Outcome:)/.test(child.textContent?.trim() ?? ''));
  container.insertBefore(box, after ?? null); return container.innerHTML;
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
  return <>{folders.map((folder) => { const path = prefix ? `${prefix}/${folder}` : folder; return <details key={path} className="inline-folder" open={expanded.has(path)} onToggle={(event) => toggle(path, event.currentTarget.open)}><summary>{folder}/</summary><FileTree files={files.filter((f) => f.startsWith(folder + '/')).map((f) => f.slice(folder.length + 1))} prefix={path} doc={doc} unviewable={unviewable} expanded={expanded} toggle={toggle} choose={choose} /></details>; })}{entries.length > 10 ? <div className="file-columns">{buttons}</div> : buttons}{!folders.length && !entries.length && <span>No files yet.</span>}</>;
}

function captureClues(element: Element): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const parent = walker.currentNode.parentElement;
    if (!parent || parent.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) continue;
    let visible = true;
    for (let node: Element | null = parent; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') { visible = false; break; }
    }
    if (visible) parts.push(walker.currentNode.textContent ?? '');
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const describe = (el: Element) => el.tagName.toLowerCase() + [...el.classList].map((c) => '.' + c).join('');
  const path: string[] = [];
  for (let node: Element | null = element.parentElement; node && path.length < 4; node = node.parentElement) path.push(describe(node));
  const rect = element.getBoundingClientRect();
  return `Element: ${describe(element)}\nText: ${text || '(none)'}\naria-label: ${element.getAttribute('aria-label') ?? '(none)'}\nTitle: ${element.getAttribute('title') ?? '(none)'}\nPosition: x=${Math.round(rect.x)}, y=${Math.round(rect.y)}; size: ${Math.round(rect.width)} × ${Math.round(rect.height)} px\nAncestors: ${path.join(' ← ') || '(none)'}`;
}

const navigatePage = (url: string) => window.location.assign(url);
export function App({ version, refresh, navigate = navigatePage }: Props) {
  const [capturing, setCapturing] = useState(false);
  const [captures, setCaptures] = useState<{ id: number; clue: string }[]>([]);
  const nextCaptureId = useRef(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [outline, setOutline] = useState<DOMRect | null>(null);
  const focusWorker = useRef(false);
  const [room, setRoom] = useState<Room | null>(null);
  const [workerInfo, setWorkerInfo] = useState<WorkerInfo | null>(null);
  const [boardDialog, setBoardDialog] = useState<BoardDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dialogElement = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogElement.current;
    if (!boardDialog || !dialog || dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }, [!!boardDialog]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [workerMessages, setWorkerMessages] = useState<WorkerMessage[]>([]);
  const [workInput, setWorkInput] = useState(false);
  // The Worker box's draft is kept across a refresh too, as refreshPage keeps both boxes on /__room.
  const [workText, setWorkText] = useState(() => { try { const saved = sessionStorage.getItem('next-work-draft') ?? ''; sessionStorage.removeItem('next-work-draft'); return saved; } catch { return ''; } });
  const workDraft = useRef(workText); workDraft.current = workText;
  const [workerHint, setWorkerHint] = useState(true);
  const [chatReset, setChatReset] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [stopArmed, setStopArmed] = useState<{ after: boolean; now: boolean }>({ after: false, now: false });
  const stopTimers = useRef<Partial<Record<'after' | 'now', ReturnType<typeof setTimeout>>>>({});
  useEffect(() => () => { for (const timer of Object.values(stopTimers.current)) clearTimeout(timer); }, []);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [retryDialog, setRetryDialog] = useState<{ id: string; models: SettingsReply['models']; worker: AgentSettings; custom: boolean; error: string; busy: boolean } | null>(null);
  const retryDialogElement = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const element = retryDialogElement.current; if (retryDialog && element && !element.open) { if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', ''); } }, [!!retryDialog]);
  const [tab, setTab] = useState<'discussion' | 'worker'>('discussion');
  const tabRef = useRef(tab); tabRef.current = tab;
  const [workerNews, setWorkerNews] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const [yourTurn, setYourTurn] = useState(false);
  const [passedAgents, setPassedAgents] = useState<string[]>([]);
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
  const [listWidth, setListWidth] = useState(() => { try { return Number(localStorage.getItem('agent-room:list-width')) || 240; } catch { return 240; } });
  const listPanel = useRef<HTMLElement>(null);
  const listDragStart = useRef(0);
  const [boardsClosed, setBoardsClosed] = useState(() => { try { return localStorage.getItem('agent-room:list-collapsed') === '1'; } catch { return false; } });
  // Services (openService on /__room): a panel beside the board; opening one folds the Boards list
  // (unsaved) and closing it restores the list. While one is open, divider drags aren't saved.
  // The Terminal is offered only on a page opened on this computer, as the server serves it only
  // there; My notes is offered on every page (the server serves it to the room's own addresses).
  const isLocalPage = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const [notesKept] = useState<NoteDraft | null>(() => { try { const kept = JSON.parse(sessionStorage.getItem(NOTES_DRAFT_KEY) ?? 'null') as NoteDraft | null; sessionStorage.removeItem(NOTES_DRAFT_KEY); return kept; } catch { return null; } });
  const [notesHidden] = useState(() => { try { const hidden = sessionStorage.getItem('next-notes-hidden') === '1'; sessionStorage.removeItem('next-notes-hidden'); return hidden; } catch { return false; } });
  const [service, setService] = useState<Service | null>(() => notesKept && !notesHidden ? 'notes' : null);
  const serviceRef = useRef(service); serviceRef.current = service;
  const listBeforeService = useRef<boolean | null>(notesKept && !notesHidden ? (() => { try { return localStorage.getItem('agent-room:list-collapsed') === '1'; } catch { return false; } })() : null);
  const notesApi = useRef<NotesApi | null>(null);
  const [shellAlive, setShellAlive] = useState(false);
  const [serverSlot, setServerSlot] = useState<HTMLElement | null>(null); // RoomZones puts the Server menu here
  const [healthOpen, setHealthOpen] = useState(false);
  const [scheduleReload, setScheduleReload] = useState(0);
  const openService = (name: Service | null) => {
    if (name) { if (serviceRef.current === null) { listBeforeService.current = boardsClosed; setBoardsClosed(true); } serviceRef.current = name; setService(name); return; }
    if (serviceRef.current === null) return;
    serviceRef.current = null; setService(null);
    if (listBeforeService.current !== null) { setBoardsClosed(listBeforeService.current); listBeforeService.current = null; }
  };
  useEffect(() => { if (serviceRef.current) setBoardsClosed(true); }, []); // a note kept across a refresh reopens My notes
  const keepNoteDraft = () => { try { const kept = notesApi.current?.draft(); if (kept) sessionStorage.setItem(NOTES_DRAFT_KEY, JSON.stringify(kept)); return true; } catch { return false; } };
  const [armedCreation, setArmedCreation] = useState<Record<string, boolean>>({});
  const creationTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => () => { for (const timer of Object.values(creationTimers.current)) clearTimeout(timer); }, []);
  const [armedActions, setArmedActions] = useState<Record<string, boolean>>({});
  const [armedRows, setArmedRows] = useState<Record<string, boolean>>({});
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
  const [boardSections, setBoardSections] = useState(() => new Set(['sprints', 'research', 'brainstorms']));
  const [orderRevision, setOrderRevision] = useState(0);
  const [dragged, setDragged] = useState<{ kind: OrderKind; name: string; names: string[] } | null>(null);
  const [subtab, setSubtab] = useState<'explorer' | 'document'>('explorer');
  const [explorerMode, setExplorerMode] = useState<'board' | 'root'>('board');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const explorer = useRef<HTMLElement>(null);
  const [offers, setOffers] = useState<string[]>([]);
  const [doc, setDoc] = useState<string | null>(null);
  const docRef = useRef<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [pointed, setPointed] = useState<Pick<PointMessage, 'label' | 'text'>[]>([]);
  const viewing = useRef<unknown>(null);
  const [viewLayout, setViewLayout] = useState<{ name?: string; board?: string } | null>(null);
  // Replication: the room's replica status, and the received line this browser views (View chat,
  // a leased pin renewed every 30 s) or peeks at (Peek files: its received files in Explorer).
  const [replica, setReplica] = useState<Replica | null>(null);
  const [replicaOff, setReplicaOff] = useState<string | null>(null);
  const [newRoom, setNewRoom] = useState(false);
  const [remote, setRemote] = useState<{ line: ViewedLine; expired: boolean } | null>(null);
  const remoteRef = useRef<ViewedLine | null>(null);
  const [receivedPeek, setReceivedPeek] = useState<{ board: string; node: string; commit: string; round: number; name: string; title: string | null } | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<string[]>([]);
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const layoutContext = useRef<{ id: string; readonly: boolean; folder: string; board: string | null } | null>(null);
  const beforeReadOnly = useRef<Layout | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const divider = useRef<HTMLDivElement>(null);
  const sideDragStart = useRef<Layout | null>(null);
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
    const board = boardName(viewLayout ? viewLayout.name || viewLayout.board : peek ? peek.path || peek.name : room?.active);
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
    applyLayout(next, save && serviceRef.current === null, stacked ? 'top' : 'left');
  };
  const sidePosition = (x: number, y: number) => {
    const bounds = panel.current?.getBoundingClientRect();
    return bounds ? (layoutRef.current.stacked ? y - bounds.top : x - bounds.left) - 3 : null;
  };
  const finishSideDrag = (x: number, y: number) => {
    const bounds = panel.current?.getBoundingClientRect(), position = sidePosition(x, y), start = sideDragStart.current;
    if (!bounds || position === null || !start) return;
    const stacked = start.stacked;
    const available = stacked ? bounds.height - (divider.current?.offsetHeight || 7) : bounds.width - (divider.current?.offsetWidth || 7);
    if (available - position < SNAP_SIZE) applyLayout({ ...start, sideClosed: true }, serviceRef.current === null, 'side-closed');
    else resize(position, stacked, true);
    sideDragStart.current = null;
  };
  const listPosition = (x: number) => x - (listPanel.current?.getBoundingClientRect().left ?? x) - 3;
  const resizeList = (x: number, save: boolean) => {
    const bounds = listPanel.current?.getBoundingClientRect();
    if (!bounds) return;
    const max = Math.max(160, window.innerWidth - bounds.left - 280);
    const width = Math.round(Math.max(160, Math.min(max, listPosition(x))));
    setListWidth(width);
    if (save && serviceRef.current === null) try { localStorage.setItem('agent-room:list-width', String(width)); } catch {}
  };
  const finishListDrag = (x: number) => {
    if (listPosition(x) < SNAP_SIZE) {
      setListWidth(listDragStart.current); setBoardsClosed(true);
      if (serviceRef.current === null) try { localStorage.setItem('agent-room:list-collapsed', '1'); } catch {}
    } else resizeList(x, true);
  };
  const offerEpoch = useRef(0);
  const [follow, setFollow] = useState(() => { try { return localStorage.getItem('agent-room.followMentions') === '1'; } catch { return false; } });
  const followRef = useRef(follow); followRef.current = follow;
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<'on' | 'failed' | null>(null);
  const [input, setInput] = useState(false);
  const [ended, setEnded] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [quota, setQuota] = useState<{ gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined }>({ gauges: undefined, at: null });
  const [monitor, setMonitor] = useState<Monitor>({});
  const workChatMemory = useRef<ChatMemory | null>(null);
  // Settings saves from both panels run one after another; Retry with… waits for them.
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve());
  const membersOpen = useRef(false), wasFresh = useRef(false);
  const [text, setText] = useState(() => { try { const saved = sessionStorage.getItem('next-composer-draft') ?? ''; sessionStorage.removeItem('next-composer-draft'); return saved; } catch { return ''; } });
  const draft = useRef(text); draft.current = text;
  const [files, setFiles] = useState<File[]>([]);
  // A new research board's kind, chosen with the Deep / Theoretical toggles before its first message.
  const [researchKind, setResearchKind] = useState({ deep: false, theoretical: false });
  const [sending, setSending] = useState(false);
  const inFlight = useRef(new Set<string>());
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
  // The Activity area's moving status: its last two lines; a Worker error doesn't flash the busy bar.
  const addStatus = (text: string, error = false, source?: 'Worker') => {
    if (!text) return;
    setStatus((lines) => [...lines, { text: (source ? source + ' · ' : '') + text, error }].slice(-2));
    const state = busyState.current;
    if (error && source !== 'Worker' && (state.command || state.posting > 0 || Date.now() - state.ended <= 1500)) {
      setBusy('failed'); clearTimeout(state.fail);
      state.fail = setTimeout(() => { state.fail = undefined; setBusy(state.command || state.posting > 0 ? 'on' : null); }, 1500);
    }
  };
  const post = async (path: '__schedule' | '__provider-health' | '__prompt-test' | '__notes/new' | '__notes/save' | '__notes/remove' | '__settings' | '__agent-enabled' | '__view' | '__pair' | '__newroom' | '/__shutdown' | '/__shutdown?confirmed=yes' | '__say' | '__work' | '__retry' | '__stopworker' | '__show' | '__workerinfo' | '__merge' | '__discard' | '__catchup' | '__cancelclose', body: Record<string, never> | ScheduleRequest | PromptTestRequest | NoteRequest | SettingsSaveRequest | AgentEnabledRequest | ViewRequest | PairRequest | NewRoomRequest | SayRequest | WorkRequest | RetryRequest | StopWorkerRequest | ShowRequest | WorkerInfoRequest | BoardActionRequest) => {
    const state = busyState.current; state.posting++; updateBusy();
    try {
      return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-view-client': client.current }, body: JSON.stringify(body) });
    } finally { state.posting--; updateBusy(); }
  };
  const workerError = (error: unknown) => addStatus(error instanceof Error ? error.message : String(error), true, 'Worker');
  useEffect(() => {
    const remember = (event: MouseEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; };
    document.addEventListener('mousemove', remember, true);
    return () => document.removeEventListener('mousemove', remember, true);
  }, []);
  useEffect(() => {
    if (!capturing) { setOutline(null); return; }
    let frame = 0;
    const target = () => pointer.current ? document.elementFromPoint(pointer.current.x, pointer.current.y) : null;
    const refreshOutline = () => setOutline(target()?.getBoundingClientRect() ?? null);
    const afterChange = () => { refreshOutline(); cancelAnimationFrame(frame); frame = requestAnimationFrame(refreshOutline); };
    const click = (event: MouseEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; afterChange(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCapturing(false); }
      else if (event.altKey && event.code === 'KeyP') {
        event.preventDefault(); event.stopPropagation();
        const element = target();
        if (element) {
          const clue = captureClues(element);
          setCaptures((previous) => [...previous, { id: nextCaptureId.current++, clue }]);
          focusWorker.current = true; tabRef.current = 'worker'; setTab('worker'); setWorkerNews(false);
        }
        setCapturing(false);
      }
    };
    document.addEventListener('mousemove', refreshOutline, true); document.addEventListener('click', click, true);
    document.addEventListener('scroll', afterChange, true); document.addEventListener('keydown', key, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('mousemove', refreshOutline, true); document.removeEventListener('click', click, true); document.removeEventListener('scroll', afterChange, true); document.removeEventListener('keydown', key, true); };
  }, [capturing]);
  const shownBoard = JSON.stringify([room?.folder, room?.active, room?.workbench, room?.brainstorm, room?.research, peek?.path, viewLayout?.name, viewLayout?.board]);
  const previousBoard = useRef(shownBoard);
  // The Deep / Theoretical toggles: only on a research board not created yet (before its first message).
  const choosingKind = !!(room?.research && !room.active && !peek && !viewLayout && !remote);
  useLayoutEffect(() => {
    if (previousBoard.current !== shownBoard) { setCaptures([]); setCapturing(false); setResearchKind({ deep: false, theoretical: false }); previousBoard.current = shownBoard; }
  }, [shownBoard]);
  useEffect(() => { if (focusWorker.current) { document.getElementById('wbox')?.focus(); focusWorker.current = false; } });
  const sendWork = async (value: string) => {
    const message = value.trim();
    const included = captures;
    const instruction = [...included.map((capture) => capture.clue), message].filter(Boolean).join('\n\n');
    if (!message || ended || peek || viewLayout) return;
    try { const response = await post('__work', { text: instruction }); if (!response.ok) workerError(await response.text()); else { const sent = new Set(included.map((capture) => capture.id)); setCaptures((previous) => previous.filter((capture) => !sent.has(capture.id))); } }
    catch (error) { workerError(error); }
  };
  const stopWorker = async (mode: 'after' | 'now') => {
    if (!stopArmed[mode]) {
      setStopArmed((previous) => ({ ...previous, [mode]: true }));
      stopTimers.current[mode] = setTimeout(() => { setStopArmed((previous) => ({ ...previous, [mode]: false })); delete stopTimers.current[mode]; }, 4000);
      return;
    }
    try { const response = await post('__stopworker', { mode }); if (!response.ok) throw new Error(await response.text()); }
    catch (error) { workerError(error); }
  };
  const readSettings = async (): Promise<SettingsReply> => {
    const response = await fetch('__settings'); if (!response.ok) throw new Error(await response.text());
    return await response.json() as SettingsReply;
  };
  const retry = async (id: string) => {
    setRetryBusy(id);
    try { const response = await post('__retry', { id }); if (!response.ok) throw new Error(await response.text()); }
    catch (error) { workerError(error); setRetryBusy(null); }
  };
  const chooseRetry = async (id: string) => {
    try {
      await settingsQueue.current;
      const data = await readSettings(), worker = data.settings.worker;
      const custom = !!worker.model && !data.models[worker.provider].some((model) => model.id === worker.model);
      setRetryDialog({ id, models: data.models, worker: { ...worker }, custom, error: '', busy: false });
    } catch (error) { workerError(error); }
  };
  const submitRetry = async () => {
    if (!retryDialog || retryDialog.busy) return;
    const dialog = retryDialog;
    if (dialog.custom && !dialog.worker.model.trim()) { setRetryDialog({ ...dialog, error: 'Enter a custom model ID.' }); return; }
    setRetryDialog({ ...dialog, busy: true, error: '' });
    try {
      const data = await readSettings();
      const current = data.started ? data.launchDefaults ?? data.defaults ?? data.settings : data.settings;
      const response = await post('__retry', { id: dialog.id, settings: { ...current, worker: { ...dialog.worker, name: dialog.worker.name.trim(), model: dialog.worker.model.trim() }, scope: 'work' } });
      if (!response.ok) throw new Error(await response.text());
      setRetryDialog(null);
    } catch (error) { setRetryDialog({ ...dialog, busy: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  // Shutdown server: the server's own address (as the Dock app's Quit uses), not this room's.
  const shutdownServer = async () => {
    try {
      const response = await post('/__shutdown', {});
      if (response.status === 409) {
        if (window.confirm(await response.text())) { const retry = await post('/__shutdown?confirmed=yes', {}); if (!retry.ok) addStatus(await retry.text(), true); }
      } else if (!response.ok) addStatus(await response.text(), true);
    } catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
  };
  const serverChanged = () => { try { sessionStorage.setItem('next-composer-draft', draft.current); sessionStorage.setItem('next-work-draft', workDraft.current); } catch {} keepNoteDraft(); refresh(); };
  // View chat: pins a received line for this browser and shows its chat read-only; null goes back.
  const viewRemote = async (line: ReceivedLine | ViewedLine | null) => {
    try {
      const response = await post('__view', line ? { board: line.board, node: line.node } : { back: true });
      if (!response.ok) { addStatus(await response.text(), true); return; }
      const next = (await response.json() as ViewReply).viewing;
      const shown = next && next !== true ? next : null;
      remoteRef.current = shown; viewing.current = shown;
      setRemote(shown ? { line: shown, expired: false } : null);
      setViewLayout(shown ? { name: shown.name ?? undefined, board: shown.board } : null);
      setReceivedPeek(null); setFilePeek(null); setRowMenu(null);
      docRef.current = null; setDoc(null); setSubtab('explorer');
      offerEpoch.current++; setOffers([]);
      setMessages(shown ? shown.messages.filter((m) => !m.pass && !m.hidden) : liveMessages.current);
      if (shown) setExplorerMode('board');
    } catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
  };
  useEffect(() => {
    const timer = setInterval(async () => {
      if (!remoteRef.current) return;
      try { const response = await post('__view', { renew: true }); if (!response.ok) setRemote((r) => r && { ...r, expired: true }); } catch {}
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  const received = remote ? remote.line : receivedPeek;
  useEffect(() => {
    if (!received) { setReceivedFiles([]); return; }
    let live = true;
    fetch('__rfiles?d=' + encodeURIComponent(received.board) + '&n=' + encodeURIComponent(received.node) + '&c=' + encodeURIComponent(received.commit || ''))
      .then((r) => r.json() as Promise<string[]>).then((files) => { if (live) setReceivedFiles(Array.isArray(files) ? files : []); }, () => { if (live) setReceivedFiles([]); });
    return () => { live = false; };
  }, [received?.board, received?.node, received?.commit]);
  // One menu open at a time, as on /__room: opening the room or server menu, Actions ▾ or a row ⋯ closes the others.
  useEffect(() => {
    const opened = (event: Event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLDetailsElement) || !menu.open || !menu.matches('details.menu, details.actions-menu, details.row-menu')) return;
      for (const other of document.querySelectorAll<HTMLDetailsElement>('details.menu, details.actions-menu')) if (other !== menu) other.open = false;
      if (!menu.matches('details.row-menu')) setRowMenu(null);
    };
    document.addEventListener('toggle', opened, true);
    return () => document.removeEventListener('toggle', opened, true);
  }, []);
  // Unsaved notes are never dropped without asking: switching board or room waits for the answer.
  const notesGuard = (act: () => void, cancel?: () => void) => { if (notesApi.current) notesApi.current.guard(act, cancel); else act(); };
  useEffect(() => {
    const leave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.next-boards a[href]') : null;
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || !notesApi.current?.dirty()) return;
      event.preventDefault(); const url = link.href; notesApi.current.guard(() => navigate(url));
    };
    document.addEventListener('click', leave); return () => document.removeEventListener('click', leave);
  }, [navigate]);
  // The file name's ▾ menu: the shown file's siblings (files in its folder), to switch without
  // Explorer; a received snapshot's siblings come from that snapshot.
  const [siblings, setSiblings] = useState<{ path: string; label: string; cantShow: boolean; shown: boolean; received: boolean }[] | null>(null);
  const loadSiblings = async () => {
    const shown = docRef.current; setSiblings(null); if (!shown) return;
    const isReceived = shown.startsWith('__received/'), parts = shown.split('/');
    const prefix = isReceived ? parts.slice(0, 4).join('/') + '/' : '';
    const rel = shown.slice(prefix.length), folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    let files: string[] = [], unviewable = new Set<string>();
    try {
      if (isReceived) files = await (await fetch('__rfiles?d=' + encodeURIComponent(parts[1]) + '&n=' + encodeURIComponent(parts[2]) + '&c=' + encodeURIComponent(parts[3]))).json() as string[];
      else { const raw = await (await fetch('__files?detail=1')).json() as FileDetailsResponse | string[]; files = Array.isArray(raw) ? raw : raw.files; unviewable = new Set(Array.isArray(raw) ? [] : raw.unviewable); }
    } catch {}
    const binary = /\.(icns|ico|bmp|tiff?|heic|avif|zip|tar|gz|tgz|bz2|xz|7z|rar|zst|dmg|pkg|iso|bin|exe|dll|so|dylib|a|o|wasm|woff2?|ttf|otf|eot|mp3|wav|ogg|flac|m4a|aac|mp4|mov|webm|avi|mkv|sqlite3?|db|pyc|class|jar)$/i;
    setSiblings(files.filter((f) => f.startsWith(folder) && !f.slice(folder.length).includes('/')).sort().map((f) => {
      const cantShow = !isReceived && (unviewable.has(f) || binary.test(f)) || (isReceived && binary.test(f));
      return { path: prefix + f, label: f.slice(folder.length) + (cantShow ? " · can't be shown here" : ''), cantShow, shown: prefix + f === shown, received: isReceived };
    }));
  };
  const refreshWorker = () => { void post('__workerinfo', {}).catch(() => {}); };
  const actionReply = async <T,>(path: '__merge' | '__discard' | '__catchup', body: BoardActionRequest): Promise<T> => {
    const response = await post(path, body); if (!response.ok) throw new Error(await response.text()); return await response.json() as T;
  };
  const mergeResult = (name: string, result: MergeReply, changed: boolean) => {
    if ('catchUp' in result && result.catchUp) setBoardDialog({ kind: 'catchup', name, target: result.targetBranch, behind: result.behind, message: result.message, changed });
    else if ('preview' in result) setBoardDialog({ kind: 'merge', name, preview: result.preview, changed });
    else setBoardDialog(null);
  };
  const catchUp = async (name: string) => {
    try { const result = await actionReply<CatchUpReply>('__catchup', { name }); addStatus(`Queued catch-up with ${result.targetBranch} for ${name}. Review the report, then click Close and Merge again.`); }
    catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); refreshWorker(); }
  };
  const startBoardAction = async (kind: 'merge' | 'discard', name: string) => {
    if (actionsMenu.current) actionsMenu.current.open = false; setRowMenu(null);
    if (kind === 'merge' && workerInfo?.mergeable?.[name]?.catchUp) { await catchUp(name); return; }
    try {
      if (kind === 'merge') mergeResult(name, await actionReply<MergeReply>('__merge', { name }), false);
      else { const result = await actionReply<DiscardReply>('__discard', { name }); if ('preview' in result) setBoardDialog({ kind, name, preview: result.preview, changed: false }); }
    } catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); refreshWorker(); }
  };
  const confirmBoardAction = async () => {
    const dialog = boardDialog; if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    try {
      if (dialog.kind === 'catchup') {
        setBoardDialog(null); await catchUp(dialog.name);
      } else if (dialog.kind === 'merge') {
        const result = await actionReply<MergeReply>('__merge', { name: dialog.name, snapshot: dialog.preview.snapshot });
        mergeResult(dialog.name, result, true);
      } else {
        const result = await actionReply<DiscardReply>('__discard', { name: dialog.name, snapshot: dialog.preview.snapshot });
        if ('preview' in result && result.changed) setBoardDialog({ kind: 'discard', name: dialog.name, preview: result.preview, changed: true }); else setBoardDialog(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (dialog.kind === 'catchup') { setBoardDialog(null); addStatus(message, true); }
      else setBoardDialog({ ...dialog, error: message });
      refreshWorker();
    }
    finally { setDialogBusy(false); }
  };
  const cancelClose = async (name: string) => {
    try { const response = await post('__cancelclose', { name }); if (!response.ok) throw new Error(await response.text()); }
    catch (error) { addStatus(error instanceof Error ? error.message : String(error), true); }
  };
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
    // As on /__room, a message without attachments doesn't wait for an earlier one: a second Enter
    // starts another request. The draft stays until its request succeeds, so the same text already
    // on its way isn't sent twice. A message with attachments waits for the one being saved.
    const plain = !files.length;
    if ((plain ? inFlight.current.has(value) : sending) || ended || (!value && !files.length) || (peek && (!value.startsWith('/') || files.length > 0))) return;
    const fail = (reason: string) => addStatus(`✗ ${reason} Nothing was sent.`, true);
    if (value === '/docs' && !files.length) { setSubtab('explorer'); openDocument(); void loadDetails(); setText(''); return; }
    if (files.length && value.startsWith('/')) return fail('Attachments go with a message, not a command.');
    const tooBig = files.find((file) => file.size > ATTACH_LIMIT);
    if (tooBig) return fail(`${tooBig.name} is over 25 MB.`);
    if (files.reduce((total, file) => total + file.size, 0) > ATTACH_TOTAL) return fail('Over 250 MB at once: attach fewer files per message.');
    if (plain) inFlight.current.add(value); else setSending(true);
    try {
      const body: SayRequest = { text: value };
      if (choosingKind && !value.startsWith('/')) body.researchKind = researchKind;
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
    } finally { if (plain) inFlight.current.delete(value); else setSending(false); }
  };

  useEffect(() => {
    const point = (event: MessageEvent<unknown>) => {
      if (event.origin !== location.origin || !frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as Partial<PointMessage> | null;
      if (data?.type !== 'agent-room:point' || typeof data.label !== 'string' || typeof data.text !== 'string') return;
      const label = data.label, text = data.text;
      if (data.kind === 'passage') {
        if (text.length > 4000) return;
        setPointed((previous) => [...previous.filter((item) => item.text !== text), { label: label.slice(0, 80), text }]);
        return;
      }
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
  // As the legacy send: Restart and Shutdown warn about rooms still running a round or a worker
  // instruction (409), and go ahead only once the User confirms.
  const boardCommand = async (text: string) => {
    try {
      let response = await post('__say', { text });
      if (response.status === 409 && (text === '/restart' || text === '/shutdown')) {
        if (!window.confirm(await response.text())) return;
        response = await post('__say', { text, confirmed: true });
      }
      if (!response.ok) addStatus(await response.text(), true);
    }
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
  const noteBrainstorm = useRef<string | null>(null);
  const createBoard = (command: string, noteText?: string) => {
    if (!room?.multi && room?.started && !armedCreation[command]) {
      setArmedCreation((previous) => ({ ...previous, [command]: true }));
      creationTimers.current[command] = setTimeout(() => { setArmedCreation((previous) => ({ ...previous, [command]: false })); delete creationTimers.current[command]; }, 4000);
      return;
    }
    if (noteText === undefined) { void boardCommand(command); return; }
    noteBrainstorm.current = noteText;
    void post('__say', { text: command }).then(async (response) => {
      if (!response.ok) { noteBrainstorm.current = null; addStatus(await response.text(), true); return; }
    }).catch((error) => { noteBrainstorm.current = null; addStatus(error instanceof Error ? error.message : String(error), true); });
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
  const runRowAction = (key: string, command: string, close = true) => {
    if (!armedRows[key]) {
      setArmedRows((previous) => ({ ...previous, [key]: true }));
      actionTimers.current['row:' + key] = setTimeout(() => { setArmedRows((previous) => ({ ...previous, [key]: false })); delete actionTimers.current['row:' + key]; }, 4000);
      return;
    }
    clearTimeout(actionTimers.current['row:' + key]); delete actionTimers.current['row:' + key];
    setArmedRows((previous) => ({ ...previous, [key]: false }));
    if (close) setRowMenu(null);
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
      if (folder && (event.key === orderKey(folder, 'sprints') || event.key === orderKey(folder, 'brainstorms'))) setOrderRevision((revision) => revision + 1);
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
        try { sessionStorage.setItem('next-composer-draft', draft.current); sessionStorage.setItem('next-work-draft', workDraft.current); } catch {}
        keepNoteDraft(); refresh(); return;
      }
      if ((event.type === 'reset' || event.type === 'room') && event.room?.brainstorm && !event.room.active && noteBrainstorm.current !== null) {
        setText(noteBrainstorm.current); openService(null); noteBrainstorm.current = null;
      }
      if (event.type === 'reset') {
        setWorkerInfo(event.workerInfo ?? null);
        setMonitor(event.monitor ?? {}); setQuota({ gauges: event.quota, at: event.quotaAt });
        setWorkInput(!!event.workInput); setWorking(event.working ?? null); setRetryBusy(null);
        setWorkerMessages((event.worker ?? []).filter((m) => !('note' in m))); setWorkerHint(!event.worker?.length); setChatReset((n) => n + 1);
        for (const m of event.worker ?? []) if ('note' in m) addStatus(m.note, !!m.error, 'Worker');
        // The startup checks' summary, kept by the server for pages that connect after it was sent.
        const startup = event.startup;
        if (startup) setStatus((lines) => lines.some((l) => l.text === startup) ? lines : [...lines, { text: startup, error: true }].slice(-2));
        if (event.peek ? event.peek.kind === 'workbench' : event.room?.workbench) { tabRef.current = 'worker'; setTab('worker'); setWorkerNews(false); }
        else if ((event.peek ? event.peek.kind === 'research' : event.room?.research || roomRef.current?.workbench) && tabRef.current === 'worker') { tabRef.current = 'discussion'; setTab('discussion'); }
        viewing.current = remoteRef.current ?? event.viewing;
        setViewLayout(remoteRef.current ? { name: remoteRef.current.name ?? undefined, board: remoteRef.current.board } : event.viewing && typeof event.viewing === 'object' ? event.viewing as { name?: string; board?: string } : null);
        setReplica(event.replica ?? null); setReplicaOff(event.replicaOff ?? null); setNewRoom(!!event.newRoom);
        roomRef.current = event.room; peekRef.current = event.peek ?? null;
        setRoom(event.room); setPeek(event.peek ?? null); setInput(event.input);
        if (event.peek) { setFilePeek(null); setExplorerMode('board'); void loadDetails(); }
        else if (event.room?.folder) void loadDetails();
        if (!preservePeekDoc.current || event.peek) { docRef.current = event.doc ?? null; setDoc(event.doc ?? null); setSubtab(event.doc ? 'document' : 'explorer'); }
        if (!event.peek) preservePeekDoc.current = false;
        offerEpoch.current++; setOffers([]);
        const visible = event.messages.filter((m) => !m.pass && !m.hidden);
        if (!remoteRef.current) setMessages(visible);
        setPassedAgents(computePassedAgents(event.messages));
        if (!event.peek) { liveMessages.current = visible; if (visible.length || event.worker?.length) void loadFiles(); }
        setThinking(event.thinking ?? null); setYourTurn(!event.thinking);
        if (event.status) addStatus(event.status);
        state.command = !!event.busy; updateBusy();
      } else if (event.type === 'message') {
        if (event.message.speaker === 'User') { setYourTurn(false); setPassedAgents([]); offerEpoch.current++; setOffers([]); }
        else if (event.message.speaker) {
          const who = event.message.speaker, passed = !!event.message.pass;
          setPassedAgents((previous) => passed ? (previous.includes(who) ? previous : [...previous, who]) : previous.filter((n) => n !== who));
        }
        if (event.message.error) pin(event.message.speaker, event.message.errorText ?? '');
        if (!event.message.pass && !event.message.hidden) {
          const message = event.message;
          liveMessages.current = [...liveMessages.current, message];
          if (!peekRef.current && !remoteRef.current) {
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
      } else if (event.type === 'work') {
        if ('note' in event.message) addStatus(event.message.note, !!event.message.error, 'Worker'); // a marker or an error, as on /__room
        else {
          const message = event.message;
          setWorkerMessages((previous) => [...previous, message]);
          if (message.speaker !== 'User' && tabRef.current !== 'worker') setWorkerNews(true);
          if (message.speaker === 'User') { offerEpoch.current++; setOffers([]); }
          const eligible = message.speaker !== 'User' && message.speaker !== 'Relayed from discussion' && !message.error;
          if (eligible) {
            const epoch = ++offerEpoch.current, active = roomRef.current?.active ?? null;
            void loadFiles().then((paths) => {
              if (epoch !== offerEpoch.current || peekRef.current) return;
              const found = linkFiles(message.html, paths, active).found.filter((file) => file !== docRef.current).slice(0, 3);
              if (found.length && followRef.current) void showFile(found[0]); else if (found.length) setOffers(found);
            });
          } else void loadFiles();
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
      } else if (event.type === 'working') {
        setWorking(event.name);
      } else if (event.type === 'schedule') {
        if (serviceRef.current === 'schedule') setScheduleReload((n) => n + 1); // only while it is shown
      } else if (event.type === 'replica') {
        setReplica(event.replica);
      } else if (event.type === 'quota') {
        setQuota({ gauges: event.gauges, at: event.at });
      } else if (event.type === 'monitor') {
        setMonitor(event.monitor ?? {});
      } else if (event.type === 'workerinfo') {
        setWorkerInfo(event.info);
      } else if (event.type === 'doc') {
        docRef.current = event.file; setDoc(event.file); setSubtab(event.file ? 'document' : 'explorer'); if (event.file) openDocument();
      } else if (event.type === 'room') {
        const changed = roomRef.current && roomRef.current.active !== event.room.active;
        const wasWorkbench = !!roomRef.current?.workbench;
        if (changed && peekRef.current) {
          peekRef.current = null; setPeek(null); setMessages([]); liveMessages.current = []; offerEpoch.current++; setOffers([]);
        }
        if (changed) { setFilePeek(null); setPassedAgents([]); }
        roomRef.current = event.room; setRoom(event.room); setRetryBusy(null); if (event.room.folder) void loadDetails();
        if (event.room.workbench && !peekRef.current) { tabRef.current = 'worker'; setTab('worker'); setWorkerNews(false); }
        else if ((event.room.research || wasWorkbench && !event.room.workbench) && tabRef.current === 'worker' && !peekRef.current) { tabRef.current = 'discussion'; setTab('discussion'); }
      } else if (event.type === 'files') {
        setSubtab('explorer'); void loadDetails();
      } else if (event.type === 'moved') {
        setPendingArchives((previous) => { const next = new Set(previous); next.delete(event.from); return next; });
        const folder = roomRef.current?.folder, name = event.from?.split('/').at(-1);
        if (folder && name) {
          const kind: OrderKind = event.from.startsWith('brainstorms/') ? 'brainstorms' : 'sprints';
          saveOrder(kind, readOrder(folder, kind).filter((item) => item !== name));
        }
        void loadDetails();
      } else if (event.type === 'goto') {
        if (noteBrainstorm.current !== null) {
          const kept = keepNoteDraft();
          try { sessionStorage.setItem('next-notes-hidden', '1'); sessionStorage.setItem('next-composer-draft', noteBrainstorm.current); } catch {}
          if (kept) notesApi.current?.allowLeave(); noteBrainstorm.current = null;
        }
        navigate(event.url);
      } else if (event.type === 'ended') {
        setEnded(true); addStatus('This room has ended. You can close this window.'); events.close();
      } else if (event.type === 'restarting') {
        setEnded(true); setRestarting(true); state.command = true; updateBusy(); addStatus('Restarting the server: this page reloads when the new one answers.'); events.close();
      }
    };
    return () => { events.close(); clearTimeout(state.show); clearTimeout(state.fail); state.show = undefined; state.fail = undefined; };
  }, [version, refresh, navigate]);

  const title = (remote ? displayTitle(remote.line.name ?? undefined, remote.line.title ?? undefined) : displayTitle(peek?.name ?? room?.active?.split('/').at(-1), peek?.title ?? room?.board)) || 'agent-room';
  const titleKind = title === 'agent-room' ? null : remote ? remote.line.kind ?? null : peek ? peek.kind ?? null : room ? (room.brainstorm ? 'brainstorm' : room.workbench ? 'workbench' : room.research ? 'research' : 'sprint') : null;
  const titleIcon = titleKind ? BOARD_ICONS.get(titleKind) ?? null : null;
  const receivedTime = (at: string | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'time unavailable';
  const ownLine = remote && replica ? Object.values(replica.own).find((line) => line.board === remote.line.board) : undefined;
  const newerLine = remote && replica?.received.find((line) => line.board === remote.line.board && line.node === remote.line.node && line.commit !== remote.line.commit);
  const busyWorkers = (room?.open ?? []).filter((entry) => entry.working);
  // A board that becomes fresh opens its members panel, also when that happened during a Peek (the
  // panel isn't shown then): the request waits for the panel (setRoom's fresh on /__room).
  if (room?.fresh && !wasFresh.current && !room.workbench) membersOpen.current = true;
  wasFresh.current = !!room?.fresh;
  const turnVisible = !!room?.started && yourTurn && !thinking && !peek && !remote && room.autoDev?.status !== 'running';
  const base = filePeek?.path ?? peek?.path ?? room?.active ?? null;
  const rootMode = explorerMode === 'root' || !base;
  const treeFiles = rootMode ? (fileDetails?.files ?? []).filter((file) => !inBoard(file)) : (fileDetails?.files ?? []).filter((file) => file.startsWith(base + '/')).map((file) => file.slice(base!.length + 1));
  const namesUnder = (prefix: string) => [...new Set((fileDetails?.files ?? []).filter((f) => f.startsWith(prefix + '/')).map((f) => f.slice(prefix.length + 1).split('/')).filter((parts) => parts.length > 1 && /^\d{4}-\d{2}-\d{2}-/.test(parts[0])).map((parts) => parts[0]))].sort((a, b) => b.localeCompare(a));
  // The ⚙ Providers tooltip: this board's CLI sessions at a glance (full IDs are in the settings panels).
  const sessionLabel = (s: CliSession) => `${s.name} · ${s.provider} · ${s.id ? s.id.slice(0, 8) + '…' : 'No session yet'}`;
  const sessionList = room?.cliSessions ? [...room.cliSessions.agents.map(sessionLabel), ...(room.cliSessions.worker?.id ? [sessionLabel(room.cliSessions.worker)] : [])] : [];
  const sessionLines = sessionList.length ? sessionList : null;
  const boardTitle = (name: string, path: string, brainstorm: boolean) => displayTitle(name, room?.open?.find((entry) => entry.active === path)?.title ?? (room?.active === path ? room.board : undefined) ?? room?.checkpoints?.find((entry) => entry.name === (brainstorm ? 'brainstorms/' + name : name))?.title);
  // Document's path line (docLabel): the discussion (current, peeked or received) or "Room checkout",
  // plus the file's path inside it; the browser tab is named after it, or after the board.
  const docLabel = (file: string | null) => {
    if (!file) return 'No document shown.';
    if (file.startsWith('__received/')) {
      const [, d, node, , ...rest] = file.split('/');
      const rec = replica?.received.find((l) => l.board === d && l.node === node), mine = received?.board === d ? received : null;
      return displayTitle((mine?.name || rec?.local || rec?.name || d) ?? undefined, (mine?.title || rec?.title) ?? undefined) + ' · ' + rest.join('/');
    }
    const p = file.split('/'), dated = (n: string | undefined) => /^\d{4}-\d{2}-\d{2}-/.test(n ?? '');
    if ((p[0] === 'discussions' || p[0] === 'brainstorms') && p.length >= 3 && dated(p[1])) return boardTitle(p[1], p[0] + '/' + p[1], p[0] === 'brainstorms') + ' · ' + p.slice(2).join('/');
    if ((p[0] === 'discussions' || p[0] === 'brainstorms') && p.length >= 4 && (p[1] === 'archive' || p[1] === 'deferred') && dated(p[2])) return boardTitle(p[2], p.slice(0, 3).join('/'), p[0] === 'brainstorms') + ' · ' + p.slice(3).join('/');
    return 'Room checkout · ' + file;
  };
  const tabTitle = doc ? docLabel(doc) + ' · agent-room' : title !== 'agent-room' && (remote || peek || room?.active || room?.brainstorm || room?.workbench) ? title + ' · agent-room' : 'agent-room';
  useEffect(() => { document.title = tabTitle; }, [tabTitle]);
  // Send to agents, on a transcript of an earlier session (not this one): a normal message asking
  // the agents to read it as background; its old sessions are not resumed.
  const docParts = doc ? doc.split('/') : [];
  const transcriptDoc = !!doc && docParts.length >= 3 && docParts.length <= 5 && (docParts[0] === 'discussions' || docParts[0] === 'brainstorms') && docParts.at(-2) === 'transcripts' && docParts.at(-1)!.endsWith('.md')
    && !!room && !room.workbench && doc !== room.transcript && !remote && input;
  const mergeControls = (name: string) => {
    const info = workerInfo?.mergeable?.[name], discardable = workerInfo?.discardable?.includes(name);
    const target = info?.targetBranch;
    const text = info?.catchUp ? 'Catch up with ' + target : 'Close and Merge';
    const tip = info?.catchUp ? `Ask the worker to merge ${target} into worker/${name} and run tests; nothing merges into ${target} automatically.` : info?.canMerge ? `Merge worker/${name} into ${target}, remove the worktree and branch, and close.` : info?.disabledReason || 'Cannot Close and Merge yet.';
    return <>{info && <button type="button" disabled={!info.catchUp && !info.canMerge} title={tip} onClick={() => void startBoardAction('merge', name)}>{text}</button>}{discardable && <button type="button" title="Close this sprint and discard its worker worktree and branch (asks to confirm with a list of what will be lost)." onClick={() => void startBoardAction('discard', name)}>Close and Discard</button>}</>;
  };
  const boardRow = (name: string, path: string, brainstorm: boolean, archived = false, ordering?: { kind: OrderKind; names: string[] }) => {
    const current = room?.active === path, open = room?.open?.find((entry) => entry.active === path && !entry.current);
    const entry = room?.open?.find((item) => item.active === path);
    const closed = brainstorm ? !current && !open : !!room?.closedBoards?.includes(name);
    const kind = brainstorm ? 'brainstorm' : room?.workbenches?.includes(name) ? 'workbench' : room?.researches?.includes(name) ? 'research' : 'sprint';
    const label = boardTitle(name, path, brainstorm);
    const work = workerInfo?.pending?.find((item) => item.lane === name);
    const isResearch = kind === 'research', isSprint = !brainstorm && !isResearch;
    const closing = brainstorm ? null : room?.closingBoards?.[name];
    const workerBusy = isSprint && !!(entry?.working || entry?.workerBusy || room?.busyWorkers?.includes(name));
    const conflicts = isSprint ? work?.conflicts ?? [] : [];
    const state = entry?.ongoing || entry?.working || closing || workerBusy ? 'ongoing' : closed ? 'closed' : conflicts.length ? 'waiting for input' : entry ? !entry.started ? 'not started' : entry.waitingForInput ? 'waiting for input' : entry.readyForAutoDev ? 'ready for auto dev' : entry.workReady && !entry.workbench && !entry.brainstorm ? 'work ready' : 'idle' : current && !room?.started ? 'not started' : 'idle';
    const merge = workerInfo?.mergeable?.[name];
    const suffix = state === 'work ready' && isSprint && merge ? merge.canMerge ? ' · mergeable' : merge.catchUp ? ' · needs catch-up' : ' · merge blocked' : '';
    const conflictText = conflicts.length ? 'Worker conflict: ' + conflicts.join(', ') : '';
    const tooltip = state === 'waiting for input' ? conflictText || entry?.waitingReason : suffix === ' · merge blocked' ? merge?.disabledReason : undefined;
    const closingText = closing ? closing === 'waiting' ? ' · closing · waiting for worker' : ' · closing · writing statement' : '';
    const changed = isSprint && !archived ? workerInfo?.merged?.includes(name) ? ' · merged' : workerInfo?.pending && !work ? ' · no changes' : '' : '';
    const pendingText = work ? [work.ahead && `${work.ahead} ${work.ahead === 1 ? 'commit' : 'commits'} not merged into main`, work.dirty && 'uncommitted changes'].filter(Boolean).join(' · ') : '';
    const stats = room?.researchStats?.[name];
    const count = Number.isSafeInteger(stats?.laps) && stats!.laps >= 0 ? stats!.laps : 0;
    const date = (value?: string | null) => { if (!value) return '—'; const d = new Date(value); return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    const ref = brainstorm ? path : archived ? path.slice('discussions/'.length) : name;
    const rollback = isSprint ? room?.rollbacks?.find((item) => item.name === name) : undefined;
    const rowKey = (action: string) => path + ':' + action;
    const saved = room?.checkpoints?.find((item) => item.name === (brainstorm ? 'brainstorms/' + name : name));
    const resumeTip = open ? 'Show it: its agents carry on, nothing is restarted.' : closed ? 'Reopen from its closing statement (or pending handoff) with new agent and worker sessions.' : saved?.kind === 'full' ? 'Continue where it stopped: the same agent and worker sessions, and its chat.' : saved?.kind === 'fresh' && saved.summary !== false ? 'Start from its handoff and notes, with the summary chosen at Start fresh.' : 'No saved session: start from its handoff and notes.';
    const resumeTitle = archived ? (brainstorm ? 'Resume: makes it active first' : (closed ? 'Resume' : 'Continue') + ': makes it active first') : brainstorm ? open ? 'Show this open brainstorm: its agents carry on' : saved?.kind === 'full' ? 'Continue where it stopped: the same agent sessions, and its chat.' : 'No saved session: a fresh one starts, from its latest summary or its transcripts.' : resumeTip;
    const freshTitle = brainstorm ? (archived ? 'Makes it active first. ' : '') + 'New agent sessions, briefed from its latest summary or, with none, pointed at its transcripts. Its saved sessions and chat are discarded.' : 'New agent and worker sessions, from its handoff and notes and its latest saved summary. Its saved sessions and chat are discarded.';
    const freshWarning = brainstorm ? 'Click again: its saved sessions and chat are discarded' : 'Click again: its saved sessions and chat are discarded; it starts from its handoff';
    const canDelete = brainstorm || isResearch || (archived && isSprint && closed);
    const deleteDisabled = !archived && (current || !!open || (isResearch && !closed)) || archived && isResearch && !closed;
    const deleteTitle = brainstorm ? deleteDisabled ? 'Close this brainstorm before deleting it' : 'Delete its folder (transcripts, drawings) and its checkpoint' : isResearch && deleteDisabled ? 'Close this research board before deleting it' : 'Delete its folder and checkpoint';
    const deleteWarning = brainstorm ? 'Click again: its folder (transcripts, drawings) and checkpoint are removed; uncommitted files are lost for good' : isResearch ? 'Click again: its folder and checkpoint are removed; uncommitted files are lost for good' : `Delete this ${kind} from this room? Previous Git commits and copies already received by peers may still contain it.`;
    const action = () => {
      if (current) { if (peekRef.current) void backToCurrent(); else setFilePeek(null); return; }
      if (closed || brainstorm) { setExplorerMode('board'); setSubtab('explorer'); void boardCommand('/peek ' + ref); }
      else if (!archived && input && !viewing.current) void boardCommand('/resume ' + ref);
      else { setFilePeek({ path, name, title: label, readonly: archived }); setExplorerMode('board'); setSubtab('explorer'); }
    };
    const kindBadge = isResearch ? [stats?.deep && 'Deep', stats?.theoretical && 'Theoretical'].filter(Boolean).join(' · ') : '';
    const content = <>{kind === 'workbench' ? '🔧 ' : kind === 'research' ? '🔬 ' : ''}{label}</>;
    const archivedState = archived ? (path.includes('/archive/') ? 'archived' : 'deferred') + (brainstorm ? ' brainstorm' : isResearch ? ' research' : '') + (!brainstorm && closed ? ' · closed' : '') + closingText + (isSprint && workerInfo?.merged?.includes(name) ? ' · merged' : '') : null;
    const index = ordering?.names.indexOf(name) ?? -1;
    const reorder = (from: string, to: number) => { if (!ordering) return; const next = ordering.names.filter((item) => item !== from); next.splice(Math.max(0, Math.min(to, next.length)), 0, from); saveOrder(ordering.kind, next); };
    return <div className={'board-row row discussion-row' + (current ? ' in-use' : '') + (peek?.path === path || filePeek?.path === path ? ' peeking' : '')} key={path} onDragOver={(event) => { if (dragged && ordering?.kind === dragged.kind) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={(event) => { if (!dragged || !ordering || dragged.kind !== ordering.kind || dragged.name === name) return; event.preventDefault(); const remaining = dragged.names.filter((item) => item !== dragged.name); const bounds = event.currentTarget.getBoundingClientRect(); const target = remaining.indexOf(name); if (target < 0) return; remaining.splice(target + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0), 0, dragged.name); saveOrder(dragged.kind, remaining); setDragged(null); }}>
      {ordering && ordering.names.length > 1 && <span className="drag-handle" draggable title="Drag to reorder" aria-label={`Drag ${label} to reorder`} onDragStart={(event) => { setDragged({ kind: ordering.kind, name, names: ordering.names }); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); }} onDragEnd={() => setDragged(null)}>⠿</span>}
      <div className="discussion-block">
      {open ? <a className={'entry ' + kind} title={path} href={open.url}>{content}</a> : <button type="button" className={'entry ' + kind} title={path} aria-current={current ? 'true' : undefined} onClick={action}>{content}</button>}
      <div className="local-label" title={tooltip || undefined}>{archivedState ?? (state + suffix + (isSprint && entry?.working ? ' · worker working' : '') + closingText + changed)}</div>
      {isSprint && !archived && work && <div className="worker-pending">⚠ Worker: {pendingText}</div>}
      {!!conflictText && !workerBusy && <div className="worker-conflict">⚠ {conflictText}</div>}
      {isResearch && <div className="local-label">{kindBadge && <><span className="research-kind-badge" title="Research kind, chosen when the board was created">{kindBadge}</span> </>}<span className={count > 30 ? 'research-laps-high' : undefined}>Laps: {stats?.priorUnknown ? '≥' : ''}{count}</span> · Last: {date(stats?.lastRun)} · Next: {date(stats?.nextRun)}</div>}
      {!!(room && input && !viewing.current && isSprint && closing === 'waiting') && <button type="button" onClick={() => void cancelClose(name)}>Cancel close</button>}
      {!!(room && input && !viewing.current && rollback?.report) && <details><summary>Rollback report · {rollback.status}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{rollback.report}</pre></details>}
      </div>
      {!!(room && input && !viewing.current) && <details className="menu row-menu" open={rowMenu === path} onToggle={(event) => { const isOpen = event.currentTarget.open; if (isOpen && rowMenuRef.current !== path) { if (actionsMenu.current) actionsMenu.current.open = false; rowMenuRef.current = path; setRowMenu(path); refreshWorker(); } else if (!isOpen && rowMenuRef.current === path) { rowMenuRef.current = null; setRowMenu(null); } }}>
        <summary aria-label={`Board actions for ${label}`} title="Actions">⋯</summary><div className="row-menu-items menu-items" hidden={rowMenu !== path}>
          {current && peek && <button type="button" title={`Return to this ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'sprint'}: leave the peek.`} onClick={() => { setRowMenu(null); void backToCurrent(); }}>Back to this {isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'sprint'}</button>}
          {!current && <>
            {open && !open.started && !brainstorm ? <a href={open.url} title={`Show this open ${isResearch ? 'research board' : 'sprint'}: it has not started yet`}>Go to</a> : <button type="button" title={resumeTitle} onClick={() => { setRowMenu(null); if (open) { const url = open.url; notesGuard(() => navigate(url)); } else void boardCommand('/resume ' + ref); }}>{open && brainstorm ? 'Go to' : closed ? 'Resume' : 'Continue'}</button>}
            {!(open && !open.started && !brainstorm) && <button type="button" title={`Show this ${isResearch ? 'research board’s' : brainstorm ? 'brainstorm’s' : 'sprint’s'} files in Explorer without ${archived ? 'moving it' : 'switching'}`} onClick={() => { setRowMenu(null); setFilePeek({ path, name, title: label, readonly: archived || closed }); setExplorerMode('board'); setSubtab('explorer'); openDocument(); }}>Peek files</button>}
            {closed && !isResearch && (!brainstorm || archived) && <button type="button" title={`Look at this closed ${brainstorm ? 'brainstorm' : 'sprint'} read-only: its conversation and files, without reopening it.`} onClick={() => { setRowMenu(null); setExplorerMode('board'); setSubtab('explorer'); void boardCommand('/peek ' + ref); }}>Peek chat &amp; files</button>}
          </>}
          {(!closed || brainstorm && !archived) && <button type="button" disabled={brainstorm && !(current || open)} title={brainstorm ? current || open ? 'Close it: its agents stop; its checkpoint is kept' : 'It is not open' : undefined} onClick={() => { setRowMenu(null); void boardCommand('/close ' + ref); }}>{!brainstorm && !isResearch && workerInfo?.pending?.some((item) => item.lane === name) ? 'Close with pending work' : 'Close'}</button>}
          {!archived && isSprint && !closed && mergeControls(name)}
          {archived ? <>
            <button type="button" onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' active'); }}>Make active</button>
            {path.includes('/archive/') ? <button type="button" disabled={!brainstorm && !closed} title={!brainstorm && !closed ? `Close the ${isResearch ? 'research board' : 'sprint'} before moving it into deferred/.` : undefined} onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' deferred'); }}>Defer</button> : <button type="button" disabled={(!brainstorm && !closed) || pendingArchives.has(path)} aria-busy={pendingArchives.has(path)} title={!brainstorm && !closed ? `Close the ${isResearch ? 'research board' : 'sprint'} before moving it into archive/.` : undefined} onClick={() => void archiveBoard(path, ref)}>Archive</button>}
          </> : <>
            <button type="button" disabled={current || !closed || pendingArchives.has(path)} aria-busy={pendingArchives.has(path)} title={!closed ? `Close ${brainstorm ? 'this brainstorm' : 'the ' + (isResearch ? 'research board' : 'sprint')} before moving it into archive/.` : current && !brainstorm ? `The ${isResearch ? 'research board' : 'sprint'} in use cannot be moved` : `Move the whole ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'sprint'} into archive/`} onClick={() => void archiveBoard(path, ref)}>Archive</button>
            <button type="button" disabled={current || !closed} title={!closed ? `Close ${brainstorm ? 'this brainstorm' : 'the ' + (isResearch ? 'research board' : 'sprint')} before moving it into deferred/.` : current && !brainstorm ? `The ${isResearch ? 'research board' : 'sprint'} in use cannot be moved` : `Move the whole ${isResearch ? 'research board' : brainstorm ? 'brainstorm' : 'sprint'} into deferred/`} onClick={() => { setRowMenu(null); void boardCommand('/move ' + ref + ' deferred'); }}>Defer</button>
          </>}
          {!archived && (brainstorm || isResearch) && <button type="button" title={isResearch ? 'Keep the folder and start fresh sprint sessions; linked recurring tasks are turned off.' : 'Move it to discussions/: its agents keep their sessions and are told the new folder; the worker can then be sent work.'} onClick={() => runRowAction(rowKey('convert'), '/convert ' + path)}>{armedRows[rowKey('convert')] ? isResearch ? 'Click again: research sessions end and scheduled tasks turn off' : 'Click again: it moves to discussions/' : 'Turn into a sprint'}</button>}
          {!archived && brainstorm && <button type="button" title="Move it to discussions/ with a .research marker: the same agents start fresh sessions with the research rulebook, briefed from its transcripts and latest summary." onClick={() => runRowAction(rowKey('convert-research'), '/convert ' + path + ' research')}>{armedRows[rowKey('convert-research')] ? 'Click again: it moves to discussions/ as a research board' : 'Turn into research'}</button>}
          {(brainstorm || archived || !(current && !room.started)) && <button type="button" title={freshTitle} onClick={() => runRowAction(rowKey('fresh'), '/fresh ' + ref)}>{armedRows[rowKey('fresh')] ? freshWarning : 'Start fresh'}</button>}
          {canDelete && <button type="button" disabled={deleteDisabled} title={deleteTitle} onClick={() => runRowAction(rowKey('delete'), '/delete ' + ref)}>{armedRows[rowKey('delete')] ? deleteWarning : 'Delete'}</button>}
          {isSprint && <><button type="button" disabled={!!rollback && ['queued', 'running'].includes(rollback.status)} title="Queue a worker rollback, including merged commits. Review its report before separately confirming archive; main stays yours to merge." onClick={() => runRowAction(rowKey('rollback'), '/rollback ' + ref, false)}>{armedRows[rowKey('rollback')] ? 'Click again: queue rollback of this sprint’s implementation' : rollback && ['queued', 'running'].includes(rollback.status) ? 'Rollback ' + rollback.status : 'Archive with rollback'}</button>
            {rollback?.status === 'ready' && <button type="button" disabled={current || !closed} title={!closed ? 'Close the sprint before archiving it.' : current ? 'Switch to another sprint before confirming archive' : 'Review the rollback report first. Archive the sprint; merging its worker branch into main stays manual.'} onClick={() => runRowAction(rowKey('archive-rollback'), '/archive-rollback ' + ref, false)}>{armedRows[rowKey('archive-rollback')] ? 'Click again: I reviewed the rollback report; archive' : 'Confirm archive after rollback'}</button>}</>}
          {ordering && <><button type="button" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => { setRowMenu(null); reorder(name, index - 1); }}>Move up</button><button type="button" aria-label={`Move ${label} down`} disabled={index === ordering.names.length - 1} onClick={() => { setRowMenu(null); reorder(name, index + 1); }}>Move down</button></>}
        </div>
      </details>}
    </div>;
  };
  const boards = namesUnder('discussions'), brainstorms = namesUnder('brainstorms');
  const research = boards.filter((name) => room?.researches?.includes(name));
  const foundSprints = boards.filter((name) => !room?.researches?.includes(name));
  const folder = room?.folder;
  const activeSprints = dragged?.kind === 'sprints' ? dragged.names : folder ? orderedNames(foundSprints, readOrder(folder, 'sprints')) : foundSprints;
  const orderedBrainstorms = dragged?.kind === 'brainstorms' ? dragged.names : folder ? orderedNames(brainstorms, readOrder(folder, 'brainstorms')) : brainstorms;
  useEffect(() => {
    if (!folder || !fileDetails || dragged) return;
    for (const [kind, found] of [['sprints', foundSprints], ['brainstorms', brainstorms]] as [OrderKind, string[]][]) {
      const next = orderedNames(found, readOrder(folder, kind));
      try { if (localStorage.getItem(orderKey(folder, kind)) !== JSON.stringify(next)) localStorage.setItem(orderKey(folder, kind), JSON.stringify(next)); } catch {}
    }
  }, [folder, fileDetails, room?.researches, orderRevision, dragged]);
  const canOrder = !!(room && input && !viewing.current && folder);
  const unstarted = (room?.open ?? []).filter((entry) => !entry.current && !entry.active);
  const unstartedOf = (section: 'sprints' | 'research' | 'brainstorms') => unstarted.filter((entry) =>
    section === 'research' ? !!entry.research : section === 'brainstorms' ? !!entry.brainstorm : !entry.research && !entry.brainstorm);
  const openUnstarted = (section: 'sprints' | 'research' | 'brainstorms') => unstartedOf(section).map((entry) => {
    const state = entry.ongoing || entry.working ? 'ongoing' : !entry.started ? 'not started' : entry.waitingForInput ? 'waiting for input' : entry.readyForAutoDev ? 'ready for auto dev' : entry.workReady && !entry.workbench && !entry.brainstorm ? 'work ready' : 'idle';
    return <div className="board-row row discussion-row" key={entry.url}><a href={entry.url}>{entry.workbench ? '🔧 ' : entry.research ? '🔬 ' : ''}{entry.title}</a><div className="local-label" title={state === 'waiting for input' ? entry.waitingReason || undefined : undefined}>{state}{entry.working && section === 'sprints' ? ' · worker working' : ''}</div>{section === 'research' && <div className="local-label">Laps: 0 · Last: — · Next: —</div>}</div>;
  });
  const remoteOnly = replica ? replica.received.filter((line) => !line.local && !foundSprints.some((name) => replica.own[name]?.board === line.board)) : [];
  // The sections' hints, as renderBoards writes them on /__room (the first message's effect, or how to add one).
  const canAddBoards = !!(room && input && !ended && !peek && !viewLayout); // canAct, defined further down
  const workerNow = room?.open?.find((entry) => entry.current)?.working ? ' · worker working' : '';
  const sprintsHint = room?.brainstorm && canAddBoards ? ''
    : !activeSprints.length && !unstartedOf('sprints').length && !replica?.received.some((line) => !line.local) ? (room?.started ? '' : 'No active sprints: your first message starts one.') + workerNow
    : room && !room.started && canAddBoards ? 'Your first message starts a new sprint, or click a board to switch or peek.' + workerNow : '';
  const researchHint = room?.research && !room.active && canAddBoards ? 'Your first message names this research board and saves it here.' : !research.length && !unstartedOf('research').length ? 'No research boards yet: use the 🔬 icon in the header to start one.' : '';
  const brainstormsHint = room?.brainstorm && !room.active && canAddBoards ? 'Your first message names this brainstorm and saves it here.' : !orderedBrainstorms.length && !unstartedOf('brainstorms').length ? 'No brainstorms yet: use the 💡 icon in the header to start one.' : '';
  const inactive = ['archive', 'deferred'].flatMap((section) => ['discussions', 'brainstorms'].flatMap((kind) => namesUnder(`${kind}/${section}`).map((name) => ({ name, path: `${kind}/${section}/${name}`, brainstorm: kind === 'brainstorms' }))));
  const sectionToggle = (key: string, open: boolean) => setBoardSections((previous) => { if (previous.has(key) === open) return previous; const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next; });
  const canAct = !!(room && input && !peek && !viewLayout);
  const autoDev = canAct && !room?.workbench ? room?.autoDev : null;
  const summaryIndex = messages.findLastIndex((message) => message.outcome === 'agreed');
  const canSummary = !!(room && !peek && !viewLayout && !room.workbench);
  const canClose = !!(canAct && room?.multi && (room.active || room.brainstorm || room.workbench || room.research || (room.open?.length ?? 0) > 1));
  // The status line under the title, for the selected tab (talkStatus on /__room): the closing
  // phase, a closed-board peek, the worker's state on the Worker tab, a peer view, who is thinking, or your turn.
  const peeking = !!(peek || filePeek || (receivedPeek && !remote));
  const leavePeek = () => {
    if (receivedPeek && !remote) setReceivedPeek(null);
    else if (peek) void backToCurrent();
    else setFilePeek(null);
  };
  const closingNow = !peek && !remote && room && !room.brainstorm && room.active?.startsWith('discussions/') ? room.closingBoards?.[room.active.slice('discussions/'.length)] ?? null : null;
  const waitingForFirstMessage = !!(room && !peek && !remote && !viewLayout && !room.active && !thinking);
  const discussionKind = room?.brainstorm ? 'brainstorm' : room?.research ? 'research board' : 'sprint';
  const discStatus = closingNow === 'waiting' ? 'closing · waiting for worker' : closingNow === 'writing' ? 'closing · writing statement'
    : peek ? 'Peeking · read-only'
    : waitingForFirstMessage ? `New · waiting for first ${room.workbench ? 'instruction' : 'message'}`
    : tab === 'worker' ? (working ? working + ' is working' : 'idle') : !room ? ''
    : remote || viewLayout ? 'read-only' : thinking ? thinking + ' is thinking' : room.autoDev?.status === 'running' ? '' : turnVisible ? 'your turn' : '';
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
  return <main className={'app' + (boardsClosed ? ' list-collapsed' : '') + (service ? ' service-open' : '')} style={{ '--list': listWidth + 'px' } as React.CSSProperties}>
    {capturing && outline && <div aria-hidden="true" className="capture-outline" style={{ left: outline.left, top: outline.top, width: outline.width, height: outline.height }} />}
    <header id="header">
    <RoomZones openHealth={() => { setHealthOpen(true); openService('providers'); }} folder={room?.folder ?? null} active={room?.active ?? null} replica={replica} replicaOff={replicaOff} viewing={remote?.line ?? null} newRoom={newRoom} readOnly={!!peek || !!viewLayout}
      post={(path, body) => post(path, body)} status={(text, error) => addStatus(text, error)} navigate={(url) => notesGuard(() => navigate(url))}
      roomName={room?.folder?.replace(/[/]+$/, '').split('/').pop() || room?.folder || 'agent-room'} code={room?.code} gauges={quota.gauges} at={quota.at} monitor={monitor}
      ended={ended} restarting={restarting} command={(text) => void boardCommand(text)} shutdown={() => void shutdownServer()} serverChanged={serverChanged} serverSlot={serverSlot}>
    <div id="disc-zone" className="zone disc-zone" aria-label="Activity">
      <section id="system-messages" aria-label="System messages" role="log" aria-live="polite" aria-relevant="additions">
        {failure && <div id="pinned-error" className="pinned-error"><span title={failure.error}>✗ {failure.agent} failed {failure.time}: {failure.error.split(/\r?\n/)[0]}{failure.earlier ? ` (+${failure.earlier} earlier)` : ''}</span> <button type="button" title="Dismiss" aria-label="Dismiss pinned error" onClick={() => setFailure(null)}>✕</button></div>}
        {status.map((line, index) => <p key={index} className={line.error ? 'status error' : 'status'} title={line.text}>{line.text}</p>)}
      </section>
      {busyWorkers.length > 0 && <div id="disc-workers" className="disc-workers" aria-live="polite">{busyWorkers.map((entry) => <span key={entry.url}><span className="busy-dot">● </span>{displayTitle(entry.active?.split('/').at(-1), entry.title)} · Worker is working</span>)}</div>}
    </div>
    </RoomZones>
    {busy && <div id="busy" aria-label="Busy" data-state={busy}><span hidden>{busy === 'on' ? 'Working…' : 'Action failed'}</span></div>}
    </header>
    {boardDialog && <dialog ref={dialogElement} aria-label={boardDialog.kind === 'merge' ? boardDialog.preview.title : boardDialog.kind === 'discard' ? `Close and Discard ${boardDialog.name}?` : `Catch up with ${boardDialog.target}?`} className="board-dialog discard-dialog" onCancel={(event) => { event.preventDefault(); if (!dialogBusy) setBoardDialog(null); }}>
      <h3>{boardDialog.kind === 'merge' ? boardDialog.preview.title : boardDialog.kind === 'discard' ? `Close and Discard ${boardDialog.name}?` : `Catch up with ${boardDialog.target}?`}</h3>
      {boardDialog.changed && <p className="discard-warn">{boardDialog.kind === 'merge' ? 'The room branch or worktree changed since your first click. Review the updated preview below and confirm again.' : boardDialog.kind === 'discard' ? 'The worktree or branch changed since your first click. Review the updated list below and confirm again.' : 'The target or readiness changed. Review the updated information and confirm again.'}</p>}
      {boardDialog.kind === 'catchup' ? <p>{boardDialog.message}</p> : boardDialog.kind === 'merge' ? <>
        <p>Worktree: {boardDialog.preview.path}</p>
        <p>After merging, the worktree and branch will be removed and the sprint closed.</p>
        {!!boardDialog.preview.untracked?.length && <p>Untracked files in the worktree will be deleted for good: {boardDialog.preview.untracked.join(', ')}</p>}
        {boardDialog.preview.activeNotice && <p>{boardDialog.preview.activeNotice}</p>}
        <h4>Commits to merge ({boardDialog.preview.commits.length})</h4>{boardDialog.preview.commits.length ? <ul>{boardDialog.preview.commits.map((commit, index) => <li key={index}>{commit.hash} {commit.subject}</li>)}</ul> : <p>None.</p>}
      </> : <>
        <p>Branch: {boardDialog.preview.branch} · Worktree: {boardDialog.preview.path}</p>
        <p>{boardDialog.preview.commits.length ? `Commits will be saved to a recovery ref under refs/discarded/${boardDialog.name}/… (commits only; uncommitted, untracked and ignored files are deleted for good).` : 'Nothing committed to save; the worktree and branch will be removed and all uncommitted, untracked and ignored files deleted for good.'}</p>
        {([['Commits not in main', boardDialog.preview.commits.map((c) => c.hash + ' ' + c.subject)], ['Tracked edits', boardDialog.preview.tracked.map((item) => item.status + ' ' + item.path)], ['Untracked files', boardDialog.preview.untracked], ['Ignored files (by top-level folder)', boardDialog.preview.ignored.map((item) => item.label)]] as [string, string[]][]).map(([heading, items]) => <section key={heading}><h4>{heading} ({items.length})</h4>{items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>None.</p>}</section>)}
      </>}
      {boardDialog.kind !== 'catchup' && <details><summary>Snapshot</summary><code>{boardDialog.preview.snapshot}</code></details>}
      {boardDialog.error && <p role="alert">{boardDialog.error}</p>}
      <button type="button" disabled={dialogBusy} onClick={() => setBoardDialog(null)}>Cancel</button> <button type="button" disabled={dialogBusy} onClick={() => void confirmBoardAction()}>{boardDialog.kind === 'merge' ? 'Confirm ' + boardDialog.preview.title : boardDialog.kind === 'discard' ? 'Confirm Close and Discard' : 'Catch up with ' + boardDialog.target}</button>
    </dialog>}
    <nav id="control-bar" aria-label="Services">
      <div id="server-head" ref={setServerSlot} />
      <button type="button" className="ctrl-btn" id="ctrl-boards" aria-pressed={service === null} title="Boards and conversation" onClick={() => { if (service) openService(null); else if (boardsClosed) { setBoardsClosed(false); refreshWorker(); try { localStorage.setItem('agent-room:list-collapsed', '0'); } catch {} } }}><span className="ctrl-ico">💬</span> <span className="ctrl-lbl">Boards</span></button>
      <div className="ctrl-tip-wrap">
        <button type="button" className="ctrl-btn" aria-pressed={service === 'providers'} title={sessionLines ? undefined : 'Default providers and models for new boards, and provider health'} aria-describedby={sessionLines ? 'providers-tip' : undefined} onClick={() => openService(service === 'providers' ? null : 'providers')}><span className="ctrl-ico">⚙</span> <span className="ctrl-lbl">Providers</span></button>
        {sessionLines && <div id="providers-tip" className="ctrl-tip" role="tooltip"><strong>This room's sessions</strong>{sessionLines.map((line, i) => <div key={i}>{line}</div>)}</div>}
      </div>
      <button type="button" className="ctrl-btn" aria-pressed={service === 'instructions'} title="The prompts and rulebooks sent to each agent, and when" onClick={() => openService(service === 'instructions' ? null : 'instructions')}><span className="ctrl-ico">📜</span> <span className="ctrl-lbl">Instructions</span></button>
      <button type="button" className="ctrl-btn" aria-pressed={service === 'schedule'} title="Scheduled tasks and quota guard" onClick={() => openService(service === 'schedule' ? null : 'schedule')}><span className="ctrl-ico">⏰</span> <span className="ctrl-lbl">Schedule</span></button>
      <button type="button" className="ctrl-btn" aria-pressed={service === 'notes'} title="Your own notes for this room's folder, stored on the agent-room computer (not in the folder, not sent to peers); usable from the room's own addresses, the LAN ones too. The agents are not told about them; the files are outside the room's folder." onClick={() => openService(service === 'notes' ? null : 'notes')}><span className="ctrl-ico">📝</span> <span className="ctrl-lbl">My notes</span></button>
      {isLocalPage && <button type="button" id="ctrl-terminal" className={'ctrl-btn' + (shellAlive ? ' running' : '')} aria-pressed={service === 'terminal'} title="A shell on this computer, in the room's folder. Only from this computer, not from other devices." onClick={() => openService(service === 'terminal' ? null : 'terminal')}><span className="ctrl-ico">⌨</span> <span className="ctrl-lbl">Terminal</span></button>}
      <button type="button" id="ctrl-office" className="ctrl-btn" aria-pressed={service === 'office'} title="Playful pixel-art office showing this board's agents and worker" onClick={() => openService(service === 'office' ? null : 'office')}><span className="ctrl-ico">🏢</span> <span className="ctrl-lbl">Office</span></button>
    </nav>
    <section id="services-panel" aria-label="Services panel" hidden={!service}>
      <div id="services-bar"><span id="services-title">{service ? SERVICES[service] : ''}</span><button type="button" className="pane-ctrl" title="Close services panel" aria-label="Close services panel" onClick={() => openService(null)}>✕</button></div>
      {service === 'providers' && <div className="view" id="providers"><ProvidersPanel open healthOpen={healthOpen} setHealthOpen={setHealthOpen} warning={Object.keys(monitor).some((p) => providerHealth(monitor, p)?.level)} post={(path, body) => post(path, body)} queue={settingsQueue} done={() => openService(null)} /></div>}
      <div className="view" id="instructions" hidden={service !== 'instructions'}><InstructionsPanel open={service === 'instructions'} /></div>
      <div className="view" id="schedule" hidden={service !== 'schedule'}><SchedulePanel open={service === 'schedule'} reload={scheduleReload} post={(path, body) => post(path, body)} /></div>
      <div className="view" id="notes" hidden={service !== 'notes'}><Notes open={service === 'notes'} show={() => openService('notes')} api={notesApi} kept={notesKept} brainstorm={(value) => createBoard('/brainstorm', value)} brainstormDisabled={canAddBoards ? '' : ended ? 'This room has ended.' : peek ? 'Leave the peek to create a brainstorm.' : viewLayout ? 'This view is read-only.' : 'A brainstorm cannot be created here.'} armed={!!armedCreation['/brainstorm']} post={(path, body) => post(path, body)} /></div>
      {isLocalPage && <div className="view" id="terminal" hidden={service !== 'terminal'}><TerminalPane visible={service === 'terminal'} fitKey={layout} running={setShellAlive} /></div>}
      <div className="view" id="office" hidden={service !== 'office'}><Office boardTitle={title} agents={room?.agents ?? room?.members?.map((m) => m.name) ?? []} workerName={room?.worker || 'Worker'} thinking={thinking} working={working} passedAgents={passedAgents} failedAgents={(room?.failedAgents ?? []).map((f) => f.name)} roundEnded={yourTurn} workbench={peek ? peek.kind === 'workbench' : !!room?.workbench} /></div>
    </section>
    <aside ref={listPanel} id="list-panel" className="next-boards" aria-label="Boards">
      <div id="list-head">{!boardsClosed && <span id="list-title">Boards</span>}<button type="button" id="list-toggle" title={boardsClosed ? 'Expand boards list' : 'Collapse boards list'} aria-label={boardsClosed ? 'Expand boards list' : 'Collapse boards list'} aria-expanded={!boardsClosed} onClick={() => { const next = !boardsClosed; setBoardsClosed(next); if (!next) refreshWorker(); if (serviceRef.current === null) { try { localStorage.setItem('agent-room:list-collapsed', next ? '1' : '0'); } catch {} } }}>{boardsClosed ? '»' : '«'}</button></div>
      {peeking && <button type="button" id="boards-peek-back" title="Back to current" aria-label="Back to current" onClick={leavePeek}>{boardsClosed ? '↩' : '↩ Back to current'}</button>}
      {!boardsClosed && <>
        <div id="list-pane"><div id="board-list">
        <details className="list-section" open={boardSections.has('sprints')} onToggle={(e) => sectionToggle('sprints', e.currentTarget.open)}><summary><span className="boards-header"><span>Sprints ({activeSprints.length + unstartedOf('sprints').length})</span>{room && canAddBoards && <span className="boards-new">{!!(room.active || room.brainstorm || room.workbench || room.research) && <button type="button" title={room.multi ? 'Open a new sprint beside this one, which stays open (click it in Boards to show it again).' : 'End this session: the chat clears and your next message starts a new sprint. Its worker tasks finish in its own worker session; the new one gets a fresh worker session.'} aria-label="New sprint" className={armedCreation['/new'] ? 'armed' : undefined} onClick={(e) => { e.preventDefault(); e.stopPropagation(); createBoard('/new'); }}>+🏃</button>}<button type="button" title="Open a workbench: a special kind of sprint with only the worker (no agents), for one small fix. Your first message names it and goes straight to the worker." aria-label="New workbench" className={armedCreation['/workbench'] ? 'armed' : undefined} onClick={(e) => { e.preventDefault(); e.stopPropagation(); createBoard('/workbench'); }}>+🔧</button></span>}</span>{(armedCreation['/new'] || armedCreation['/workbench']) && <span className="boards-creation-warning">Click again: this session ends and the chat clears</span>}</summary>{openUnstarted('sprints')}{workerInfo?.pending?.filter((item) => !activeSprints.includes(item.lane ?? '')).map((item) => <div className="worker-pending" key={item.branch}>⚠ {item.branch}: {[item.ahead && `${item.ahead} ${item.ahead === 1 ? 'commit' : 'commits'} not merged into main`, item.dirty && 'uncommitted changes'].filter(Boolean).join(' · ')}</div>)}{activeSprints.map((name) => boardRow(name, 'discussions/' + name, false, false, canOrder ? { kind: 'sprints', names: activeSprints } : undefined))}{sprintsHint && <span className="hint">{sprintsHint}</span>}</details>
        <details className="list-section" open={boardSections.has('research')} onToggle={(e) => sectionToggle('research', e.currentTarget.open)}><summary><span className="boards-header"><span>Research ({research.length + unstartedOf('research').length})</span>{room && canAddBoards && <span className="boards-new"><button type="button" title="Open a research board: investigate one question with no worker, saved in discussions/ with a .research marker." aria-label="New research" className={armedCreation['/research'] ? 'armed' : undefined} onClick={(e) => { e.preventDefault(); e.stopPropagation(); createBoard('/research'); }}>+🔬</button></span>}</span>{(armedCreation['/research']) && <span className="boards-creation-warning">Click again: this session ends and the chat clears</span>}</summary>{openUnstarted('research')}{research.map((name) => boardRow(name, 'discussions/' + name, false))}{researchHint && <span className="hint">{researchHint}</span>}</details>
        <details className="list-section" open={boardSections.has('brainstorms')} onToggle={(e) => sectionToggle('brainstorms', e.currentTarget.open)}><summary><span className="boards-header"><span>Brainstorms ({orderedBrainstorms.length + unstartedOf('brainstorms').length})</span>{room && canAddBoards && <span className="boards-new"><button type="button" title={room.multi ? 'A conversation with the same agents, beside the open sprints and brainstorms, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a sprint for that.' : 'A conversation with the same agents, saved in brainstorms/: its first message names it. It sends no work to the worker; turn it into a sprint for that. It ends this session.'} aria-label="New brainstorm" className={armedCreation['/brainstorm'] ? 'armed' : undefined} onClick={(e) => { e.preventDefault(); e.stopPropagation(); createBoard('/brainstorm'); }}>+💡</button></span>}</span>{(armedCreation['/brainstorm']) && <span className="boards-creation-warning">Click again: this session ends and the chat clears</span>}</summary>{openUnstarted('brainstorms')}{orderedBrainstorms.map((name) => boardRow(name, 'brainstorms/' + name, true, false, canOrder ? { kind: 'brainstorms', names: orderedBrainstorms } : undefined))}{brainstormsHint && <span className="hint">{brainstormsHint}</span>}</details>
        <details className="list-section" open={boardSections.has('archived-deferred')} onToggle={(e) => sectionToggle('archived-deferred', e.currentTarget.open)}><summary>Archived · Deferred ({inactive.length})</summary>{inactive.map(({ name, path, brainstorm }) => boardRow(name, path, brainstorm, true))}</details>
        {remoteOnly.length > 0 && <details className="list-section" open={boardSections.has('peers')} onToggle={(e) => sectionToggle('peers', e.currentTarget.open)}><summary>Received from peers ({remoteOnly.length})</summary>{remoteOnly.map((line) => {
          const folderName = line.name || line.local || line.board, label = displayTitle(folderName, line.title ?? undefined), key = 'peer:' + line.board + ':' + line.node;
          const peekReceived = () => { setRowMenu(null); setFilePeek(null); setReceivedPeek({ board: line.board, node: line.node, commit: line.commit, round: line.round, name: folderName, title: line.title ?? null }); setExplorerMode('board'); setSubtab('explorer'); openDocument(); };
          return <div key={key} className={'board-row row discussion-row' + (receivedPeek?.board === line.board ? ' peeking' : '')}>
            <button type="button" title={line.local ? 'discussions/' + line.local : /^\d{4}-\d{2}-\d{2}-/.test(folderName) ? 'discussions/' + folderName : folderName} onClick={peekReceived}>{label}</button>
            <div className="local-label">{line.node} · round {line.round}</div>
            <details className="menu row-menu" open={rowMenu === key} onToggle={(event) => { const isOpen = event.currentTarget.open; if (isOpen && rowMenuRef.current !== key) { rowMenuRef.current = key; setRowMenu(key); } else if (!isOpen && rowMenuRef.current === key) { rowMenuRef.current = null; setRowMenu(null); } }}>
              <summary aria-label={`Board actions for ${label}`} title="Actions">⋯</summary><div className="row-menu-items menu-items" hidden={rowMenu !== key}>
                <button type="button" title="View this peer’s sprint in full, read-only" onClick={() => { setRowMenu(null); void viewRemote(line); }}>View chat</button>
                <button type="button" title="Peek at this received sprint’s files in Explorer" onClick={peekReceived}>Peek files</button>
              </div>
            </details>
          </div>;
        })}</details>}
        </div></div>
      </>}
    </aside>
    {!boardsClosed && <Splitter id="list-split" label="Resize Boards list" onStart={() => { listDragStart.current = listWidth; }} onMove={(x) => resizeList(x, false)} onEnd={(x) => finishListDrag(x)} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const left = listPanel.current?.getBoundingClientRect().left ?? 0; resizeList(left + listWidth + (event.key === 'ArrowLeft' ? -24 : 24) + 3, true); }} />}
    <div ref={panel} id="main-panel" className={'next-layout' + (layout.stacked ? ' stacked' : '') + (layout.sideClosed ? ' closed side-closed' : '')} style={{ '--left': layout.left ? layout.left + 'px' : '55%', '--top': layout.top ? layout.top + 'px' : '55%' } as React.CSSProperties}>
    <div id="disc-header" className={peek ? 'peeking' : waitingForFirstMessage ? 'new-board' : undefined} aria-label="Current discussion">
    {(canSummary || canAct) && <details ref={actionsMenu} id="actions-menu" className="menu actions-menu" onToggle={(event) => { if (event.currentTarget.open) { setRowMenu(null); refreshWorker(); } }}>
      <summary aria-label="Discussion actions" title="Actions">Actions</summary>
      <div className="menu-items">
        {canSummary && <button type="button" onClick={() => runAction('summary', '/summary', false)}>Summarize</button>}
        {canAct && <button type="button" title="Open a workbench: a special kind of sprint with only the worker (no agents), for one small fix. Your first message names it and goes straight to the worker." onClick={() => runAction('workbench', '/workbench', !room?.multi && !!room?.started)}>{armedActions.workbench ? 'Click again: this session ends and the chat clears' : 'New workbench'}</button>}
        {canAct && <button type="button" title="Open a research board: investigate one question with no worker, saved in discussions/ with a .research marker." onClick={() => runAction('research', '/research', !room?.multi && !!room?.started)}>{armedActions.research ? 'Click again: this session ends and the chat clears' : 'New research'}</button>}
        {canAct && room?.active && (room.brainstorm || room.research) && <button type="button" title={room.research ? 'Keep the folder and start fresh sprint sessions; linked recurring tasks are turned off.' : 'Move this brainstorm to discussions/: its agents keep their sessions and are told the new folder.'} onClick={() => runAction('convert', '/convert ' + room.active, true)}>{armedActions.convert ? room.research ? 'Click again: research sessions end and scheduled tasks turn off' : 'Click again: it moves to discussions/' : 'Turn into a sprint'}</button>}
        {canAct && room?.active && room.brainstorm && <button type="button" title="Move it to discussions/ with a .research marker: the same agents start fresh sessions with the research rulebook, briefed from its transcripts and latest summary." onClick={() => runAction('convert-research', '/convert ' + room.active + ' research', true)}>{armedActions['convert-research'] ? 'Click again: it moves to discussions/ as a research board' : 'Turn into research'}</button>}
        {canClose && <button type="button" title={`Close this ${room?.brainstorm ? 'brainstorm' : room?.workbench ? 'workbench' : room?.research ? 'research board' : 'sprint'}: its agents stop; the other open boards stay. Its checkpoint is kept: Resume it from ${room?.brainstorm ? 'Brainstorms' : room?.research ? 'Research' : 'Sprints'}.`} onClick={() => runAction('close', '/close', !!room?.started)}>{armedActions.close ? `Click again: this ${room?.brainstorm ? 'brainstorm' : room?.workbench ? 'workbench' : room?.research ? 'research board' : 'sprint'} closes (its agents stop)` : closeLabel}</button>}
        {canClose && lane && !room?.closedBoards?.includes(lane) && mergeControls(lane)}
      </div>
    </details>}
    <div id="disc-info"><h1 id="disc" data-active={!peek && !remote && room?.active ? 'true' : 'false'}>{titleIcon && <><span title={titleIcon.label} aria-hidden="true">{titleIcon.icon}</span>{' '}</>}{title}</h1>
      <span id="disc-status" aria-live="polite">{discStatus === 'your turn' ? <span aria-label="Turn status">your turn</span> : discStatus}</span>
    {autoDev?.status === 'running' && <span id="disc-autodev">Auto dev running · cycle {autoDev.cycle} of {autoDev.max} · {autoDev.waiting ? 'worker is working' : 'discussion is reviewing'}</span>}
    {autoDev?.status === 'paused' && <span id="disc-autodev" className="paused">Auto dev paused · {autoDev.reason}</span>}
    {autoDev?.status === 'finished' && <span id="disc-autodev">Auto dev finished · review and merge its worker branch</span>}
    </div>
    {!!(room && input && !peek && !viewLayout && room.multi && !room.active && (room.brainstorm || room.workbench || room.research || (room.open?.length ?? 0) > 1)) && <button type="button" id="cancel-creation" title="Discard this new board and return to the board you came from" onClick={() => void boardCommand('/cancel')}>Cancel</button>}
    </div>
    <div ref={conversation} id="left" className="next-conversation">
    <div id="tabs" role="tablist" aria-label="Conversation tabs">
      {!(peek ? peek.kind === 'workbench' : room?.workbench) && <button type="button" role="tab" id="tab-talk" className={'tab' + (tab === 'discussion' ? ' on' : '')} aria-selected={tab === 'discussion'} onClick={() => { tabRef.current = 'discussion'; setTab('discussion'); }}>Discussion</button>}
      {!(peek ? peek.kind === 'research' : room?.research) && <button type="button" role="tab" id="tab-work" className={'tab' + (tab === 'worker' ? ' on' : '') + (workerNews ? ' news' : '')} aria-label={workerNews ? 'Worker · new' : 'Worker'} aria-selected={tab === 'worker'} onClick={() => { tabRef.current = 'worker'; setTab('worker'); setWorkerNews(false); refreshWorker(); }}>Worker{working ? ' …' : ''}</button>}
      <span id="tab-controls">{layout.sideClosed && <button type="button" className="pane-ctrl" title="Open side pane" aria-label="Open side pane" onClick={() => applyLayout({ ...layoutRef.current, sideClosed: false }, true, 'side-closed')}>◫ Side pane</button>}</span>
    </div>
    {tab === 'worker' && <section className="view next-pane" id="work" aria-label="Worker conversation">
      <SettingsPanel scope="work" room={room} post={(path, body) => post(path, body)} queue={settingsQueue} />
      <WorkerInfoLine info={shownWorkerInfo(workerInfo, !!room?.brainstorm, !!peek || !!viewLayout)} />
      <ChatList id="wchat" endLabel="Scroll to latest worker messages" resetKey={chatReset} memory={workChatMemory}>
      {workerHint && <p className="status">{room?.workbench ? 'Send your first instruction to name and start this workbench.' : 'Give the worker instructions here. It works alongside the discussion and sees only what you send it.'}</p>}
      {workerMessages.map((message, index) => 'note' in message ? null : <article key={index} className={'msg' + (message.speaker === 'User' || message.speaker === 'Relayed from discussion' ? ' user' : '') + (message.speaker === 'Worker report' ? ' report' : '') + (message.error ? ' error' : '')}>
        <strong>{message.speaker}{message.error ? ' — failed' : ''}{message.meta ? ` · ${String(message.meta)}` : ''}</strong>
        <div onClick={(event) => { const target = (event.target as Element).closest<HTMLAnchorElement>('a.mention'); if (target?.dataset.file) { event.preventDefault(); void showFile(target.dataset.file); } }} dangerouslySetInnerHTML={{ __html: linkFiles(message.html, knownFiles, room?.active ?? null).html }} />
        {message.retryId && message.retryId === room?.retryId && index === workerMessages.findIndex((item) => !('note' in item) && item.retryId === room?.retryId) && <div><button type="button" disabled={retryBusy === message.retryId} onClick={() => void retry(message.retryId!)}>Retry</button> <button type="button" disabled={retryBusy === message.retryId} onClick={() => void chooseRetry(message.retryId!)}>Retry with…</button></div>}
      </article>)}
      </ChatList>
      <div className="composer" id="wcomposer">
      {offers.length > 0 && <div className="mention-offer" aria-label="File mentions">{offers.map((file) => <button type="button" key={file} title={`Show ${file} in Document`} onClick={() => void showFile(file)}>📄 Show {file.split('/').at(-1)}</button>)} <button type="button" title="Dismiss" aria-label="Dismiss file mentions" onClick={() => { offerEpoch.current++; setOffers([]); }}>✕</button></div>}
      {working && <p className="hint" id="whint">The worker is busy: what you send now waits for it to finish.</p>}
      {remote && <div className="remote-view" id="work-remote-view"><p>Read-only: viewing {remote.line.node}'s line.</p>{ownLine && <button type="button" onClick={() => void viewRemote(null)}>Back to {replica?.node}'s line</button>}</div>}
      {input && !peek && !viewLayout && room?.workerStop && !room.workerStop.now && <div className="tools" id="wstop">
        <button type="button" disabled={room.workerStop.after} title="The running instruction finishes and is reported as usual; this sprint's queued instructions are cancelled, and auto dev pauses" onClick={() => void stopWorker('after')}>{stopArmed.after ? 'Click again: stop after this task; queued instructions are cancelled' : 'Stop after this task'}</button>{' '}
        <button type="button" title="The running instruction's programs are stopped at once; this sprint's queued instructions are cancelled, auto dev pauses, and what it left in the worktree is reported" onClick={() => void stopWorker('now')}>{stopArmed.now ? 'Click again: stop now; partial edits may be left' : 'Stop now'}</button>
      </div>}
      {workInput && room?.ownCheckout && !room.brainstorm && !room.research && !peek && !viewLayout && <div className="capture-tools"><button type="button" disabled={ended || !!workerInfo?.disabled} aria-pressed={capturing} onClick={() => setCapturing((active) => !active)}>{capturing ? 'Cancel capture' : 'Capture UI live'}</button>{capturing && <span> Point at an element and press Alt+P; Esc cancels.</span>}</div>}
      {captures.map((capture, index) => <div className="capture-chip" key={capture.id}><details><summary>Captured element {index + 1}</summary><pre>{capture.clue}</pre></details><button type="button" aria-label={`Remove captured element ${index + 1}`} onClick={() => setCaptures((previous) => previous.filter((item) => item.id !== capture.id))}>✕</button></div>)}
      {workInput && <textarea className="box" id="wbox" aria-label="Instruction to the worker" value={workText} disabled={ended || !!peek || !!viewLayout || !!room?.brainstorm || !!workerInfo?.disabled} placeholder={peek ? 'Peeking read-only — click Back to return to the active board.' : viewLayout ? 'Read-only: viewing a peer’s sprint.' : room?.brainstorm ? 'Turn this brainstorm into a sprint to send work.' : workerInfo?.disabled ? workerInfo.lines[0] : room?.workbench && !room.active ? 'First instruction to the worker… (names this workbench and starts it)' : 'Instruction to the worker… (Enter sends, Shift+Enter for a new line). It sees only what you send here; it can edit files and run commands.'} onChange={(event) => setWorkText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); const value = workText; setWorkText(''); void sendWork(value); } }} />}
      </div>
    </section>}
    {retryDialog && <dialog ref={retryDialogElement} aria-label="Retry with…" onCancel={() => setRetryDialog(null)}><form onSubmit={(event) => { event.preventDefault(); void submitRetry(); }}>
      <h3>Retry with…</h3>
      <label>Worker provider<select value={retryDialog.worker.provider} onChange={(event) => setRetryDialog({ ...retryDialog, worker: { ...retryDialog.worker, provider: event.target.value as AgentSettings['provider'], model: '' }, custom: false })}><option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Agy</option></select></label>
      <label>Worker name<input readOnly value={retryDialog.worker.name} /></label>
      <label>Worker model<select value={retryDialog.custom ? '__custom' : retryDialog.worker.model} onChange={(event) => setRetryDialog({ ...retryDialog, custom: event.target.value === '__custom', worker: { ...retryDialog.worker, model: event.target.value === '__custom' ? '' : event.target.value } })}><option value="">CLI default</option>{retryDialog.models[retryDialog.worker.provider].map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}<option value="__custom">Custom…</option></select></label>
      {retryDialog.custom && <label>Worker custom model ID<input placeholder="Model ID" value={retryDialog.worker.model} onChange={(event) => setRetryDialog({ ...retryDialog, worker: { ...retryDialog.worker, model: event.target.value } })} /></label>}
      <button type="button" onClick={() => setRetryDialog(null)}>Cancel</button> <button type="submit" disabled={retryDialog.busy}>Retry</button>{retryDialog.error && <p role="alert">{retryDialog.error}</p>}
    </form></dialog>}
    <div className="view next-pane" id="talk" hidden={tab !== 'discussion'}>
    {remote && <div className="remote-view" id="remote-view" role="status" aria-label="Viewing a peer">
      <p>{remote.expired ? 'View expired. Select the received line again.' : remote.line.node + "'s line, round " + remote.line.round + ', received ' + receivedTime(remote.line.receivedAt) + '. Read-only.'}</p>
      <p className="local-activity">Local {replica?.node}: {thinking ? thinking + ' is thinking' : 'discussion idle'} · {working ? 'Worker ' + working + ' is working' : 'worker idle'}</p>
      {ownLine && <button type="button" onClick={() => void viewRemote(null)}>Back to {replica?.node}'s line</button>}
      {newerLine && <button type="button" onClick={() => void viewRemote(newerLine)}>View newer received round {newerLine.round}</button>}
    </div>}
    {!peek && !viewLayout && !room?.workbench && <SettingsPanel scope="talk" room={room} post={(path, body) => post(path, body)} queue={settingsQueue} openSignal={membersOpen} />}
    <FailedAgents agents={room?.failedAgents} post={(path, body) => post(path, body)} status={(text) => addStatus(text, true)} />
    <ChatList id="chat" endLabel="Scroll to latest discussion messages" resetKey={chatReset}>
    {waitingForFirstMessage && !room.workbench && messages.length === 0 && <p className="status">Describe what you want to work on. Sending your first message starts this {discussionKind} and gives it a title.</p>}
    <section aria-label="Conversation">{messages.map((message, index) => <article key={index} className={'msg' + (message.error ? ' error' : '') + (message.outcome ? ' summary' + (message.outcome === 'agreed' ? '' : ' not-agreed') : '')}>
      <strong>{message.speaker}{message.error ? ' — failed' : ''}{message.meta ? ` · ${String(message.meta)}` : ''}</strong><div onClick={(event) => { const element = event.target as Element; const target = element.closest<HTMLAnchorElement>('a.mention'); if (target?.dataset.file) { event.preventDefault(); void showFile(target.dataset.file); } if (element.closest('[data-auto-dev="start"]')) void boardCommand('/autodev'); }} dangerouslySetInnerHTML={{ __html: (() => { const html = peek ? message.html : linkFiles(message.html, knownFiles, room?.active ?? null).html; return autoDev && autoDev.status !== 'running' && autoDev.status !== 'paused' && autoDev.offer && index === summaryIndex ? autoOfferHtml(html, autoDev.offer, autoDev.max) : html; })() }} />
    </article>)}</section>
    {thinking && !remote && <p className="status">… {thinking} is thinking</p>}
    </ChatList>
    <div className="composer" id="composer">
    {tab === 'discussion' && offers.length > 0 && <div className="mention-offer" aria-label="File mentions">{offers.map((file) => <button type="button" key={file} title={`Show ${file} in Document`} onClick={() => void showFile(file)}>📄 Show {file.split('/').at(-1)}</button>)} <button type="button" title="Dismiss" aria-label="Dismiss file mentions" onClick={() => { offerEpoch.current++; setOffers([]); }}>✕</button></div>}
    {autoDev?.status === 'paused' && autoDev.offer?.text && <div id="autodev" className="paused" role="status"><p>Next agreed instruction:</p><p>{autoDev.offer.text}</p><p><button type="button" onClick={() => void boardCommand('/autodev')}>Restart auto dev ({autoDev.max} more)</button> Restarting grants another {autoDev.max} worker cycles.</p></div>}
    {autoDev?.status === 'paused' && autoDev.offer?.error && <div id="autodev" className="paused" role="status">The latest agreed instruction can’t be sent: {autoDev.offer.error}.</div>}
    {input && <>
      {!remote && <textarea className="box" id="box" aria-label="Message to the agents" value={text} disabled={ended} onChange={(event) => setText(event.target.value)}
        placeholder={peek ? 'Peeking read-only — click Back to return to the active board.' : waitingForFirstMessage ? `Write your first message… (starts this ${discussionKind} and gives it a title)` : autoDev?.status === 'running' ? 'Auto dev is running — sending a message pauses it. (Enter sends, Shift+Enter for a new line)' : 'Message to the agents… (Enter sends, Shift+Enter for a new line). @name for one agent; /docs, /summary, /usage, /reload, /quit, /shutdown'}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />}
      <div id="attach-row" hidden={!!remote}>{choosingKind && <div className="research-kind" role="group" aria-label="Research kind" title="Chosen once, with the first message: neither on is a Feasibility check">{(['deep', 'theoretical'] as const).map((key) => <button type="button" key={key} aria-pressed={researchKind[key]} disabled={ended} title={key === 'deep' ? 'Deep: question the premises, search the web, up to 30 laps per message (otherwise 6)' : 'Theoretical: end with what was understood, instead of a feasibility scorecard and verdict'} onClick={() => setResearchKind((kind) => ({ ...kind, [key]: !kind[key] }))}>{key === 'deep' ? 'Deep' : 'Theoretical'}</button>)}</div>}<button type="button" id="attach" title="Attach files to your next message: saved into the files/ folder when you send it (25 MB at most each)" disabled={sending || ended || !!peek || !room?.active} onClick={() => fileInput.current?.click()}>📎 Attach</button>
        <input ref={fileInput} type="file" aria-label="Attach files" multiple hidden onChange={(event) => { const chosen = Array.from(event.target.files ?? []); setFiles((previous) => [...previous, ...chosen]); event.target.value = ''; }} />
        {files.map((file, index) => <span className="chip" key={index}>{file.name} · {sizeText(file.size)} <button type="button" title="Remove this attachment" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((previous) => previous.filter((_, i) => i !== index))}>✕</button></span>)}
        {pointed.map((point, index) => <span className="chip" title={point.text} key={index}>{point.label} <button type="button" title="Stop pointing at this" aria-label={`Stop pointing at ${point.label}`} onClick={() => setPointed((previous) => previous.filter((_, i) => i !== index))}>✕</button></span>)}
        {sending && files.length > 0 && <span>Saving the attachments…</span>}
      </div>
    </>}
    </div>
    </div>
    </div>
    <Splitter dividerRef={divider} id="split" label="Resize conversation and side pane" horizontal={layout.stacked}
      onStart={() => { sideDragStart.current = { ...layoutRef.current }; }}
      onMove={(x, y) => { const position = sidePosition(x, y); if (position !== null) resize(position, layoutRef.current.stacked, false); }}
      onEnd={finishSideDrag}
      onKeyDown={(event) => {
        const stacked = layoutRef.current.stacked;
        if (!(stacked ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']).includes(event.key)) return;
        event.preventDefault(); const rect = conversation.current?.getBoundingClientRect();
        const size = stacked ? rect?.height : rect?.width;
        resize((size || (stacked ? layoutRef.current.top : layoutRef.current.left) || 0) + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -24 : 24), stacked, true);
      }} />
    <div id="right" className="next-side" hidden={layout.sideClosed}>
      <div id="subtabs"><button type="button" id="tab-explorer" className={'tab' + (subtab === 'explorer' ? ' on' : '') + (peek || filePeek || receivedPeek ? ' peeking' : '')} aria-label={peek || filePeek || receivedPeek ? 'Explorer tab' : undefined} data-peeking={peek || filePeek || receivedPeek ? 'true' : undefined} aria-pressed={subtab === 'explorer'} onClick={() => void reveal()}>Explorer</button><button type="button" id="tab-document" className={'tab' + (subtab === 'document' ? ' on' : '')} disabled={!doc} title={doc ? undefined : 'Choose a file in Explorer'} aria-pressed={subtab === 'document'} onClick={() => { openDocument(); setSubtab('document'); }}>Document</button>
        <span id="side-controls"><button type="button" className="pane-ctrl" title={layout.stacked ? 'Place conversation and side pane side by side' : 'Stack conversation above side pane'} onClick={() => applyLayout({ ...layoutRef.current, stacked: !layoutRef.current.stacked }, true, 'split-orient')}>{layout.stacked ? '⇆' : '⇅'}</button><button type="button" className="pane-ctrl" title="Close side pane" onClick={() => applyLayout({ ...layoutRef.current, sideClosed: true }, true, 'side-closed')}>✕</button></span></div>
      <div className="view" id="explorer" hidden={subtab !== 'explorer'}><div id="pane">
      <section ref={explorer} id="files" aria-label={peek || filePeek || received ? 'Peeked board files' : 'Explorer files'} hidden={subtab !== 'explorer'}>
        {receivedPeek && !remote && <p className="peek-banner">Looking at <b>{displayTitle(receivedPeek.name, receivedPeek.title ?? undefined)}</b> <button type="button" onClick={leavePeek}>Back to current</button></p>}
        {!receivedPeek && (peek || filePeek) && <p className="peek-banner">Looking at <b>{displayTitle((peek || filePeek)!.name, (peek || filePeek)!.title)}</b> <button type="button" onClick={leavePeek}>Back to current</button></p>}
        <div className="explorer-bar"><button type="button" className={(received ? explorerMode !== 'root' : !rootMode) ? 'on' : undefined} disabled={!base && !received} aria-pressed={received ? explorerMode !== 'root' : !rootMode} onClick={() => setExplorerMode('board')}>Board</button><button type="button" className={(received ? explorerMode === 'root' : rootMode) ? 'on' : undefined} aria-pressed={received ? explorerMode === 'root' : rootMode} onClick={() => setExplorerMode('root')}>Room checkout</button><button type="button" disabled title="Coming soon">Worker copy</button></div>
        <p className="explorer-sub">{received && explorerMode !== 'root' ? `${received.node} · round ${received.round}` : rootMode ? `${room?.folder?.replace(/\/+$/, '').split('/').at(-1) || 'agent-room'}/${fileDetails?.branch ? ` · ${fileDetails.branch}` : ''}` : `${base}/`}</p>
        {received && explorerMode !== 'root' ? <>
          {remote && <p>{remote.line.node} · round {remote.line.round} · received files</p>}
          <FileTree files={receivedFiles} prefix="" doc={doc?.startsWith('__received/') ? doc.split('/').slice(4).join('/') : null} unviewable={[]} expanded={expanded} toggle={(path, open) => setExpanded((previous) => { const next = new Set(previous); if (open) next.add(path); else next.delete(path); return next; })}
            choose={(file) => { const full = '__received/' + received.board + '/' + received.node + '/' + received.commit + '/' + file; docRef.current = full; setDoc(full); setSubtab('document'); openDocument(); }} />
        </> : <FileTree files={treeFiles} prefix={rootMode ? '' : base!} doc={doc} unviewable={fileDetails?.unviewable ?? []} expanded={expanded} toggle={(path, open) => setExpanded((previous) => { const next = new Set(previous); if (open) next.add(path); else next.delete(path); return next; })} choose={(file) => { if ((peek || filePeek?.readonly) && !rootMode) { docRef.current = file; setDoc(file); setSubtab('document'); openDocument(); } else void showFile(file); }} />}
      </section>
      </div></div>
      {doc && <section className="view next-document" id="document" aria-label="Document" hidden={subtab !== 'document'}><div className="doc-bar" id="bar"><details className="menu doc-menu" id="doc-menu" onToggle={(e) => { if (e.currentTarget.open) void loadSiblings(); }}><summary title="Other files in this folder"><span className="doc-current" id="current" title={doc}>{docLabel(doc)}</span></summary>
          <div className="menu-items" id="siblings" aria-label="Other files in this folder">{siblings === null ? null : siblings.length ? siblings.map((f) => <button type="button" key={f.path} className={f.shown ? 'shown' : undefined} disabled={f.cantShow} title={f.cantShow ? "can't be shown here" : undefined}
            onClick={(e) => { (e.currentTarget.closest('details') as HTMLDetailsElement).open = false; if (f.cantShow || f.shown) return; if (f.received) { docRef.current = f.path; setDoc(f.path); } else void showFile(f.path); }}>{f.label}</button>) : 'No other files here.'}</div></details>
          {transcriptDoc && <button type="button" id="feed" title="Ask the agents to read this transcript in full" onClick={() => { tabRef.current = 'discussion'; setTab('discussion'); const root = room!.folder.endsWith('/') ? room!.folder : room!.folder + '/'; void boardCommand('Please read this transcript of an earlier session in full, as background for our discussion: ' + root + doc); }}>Send to agents</button>}
          <label className="follow-label" id="follow-label" title="When an agent or the worker names a file in a new message, show it here at once (this browser only)"><input type="checkbox" checked={follow} onChange={(event) => { const checked = event.target.checked; setFollow(checked); try { localStorage.setItem('agent-room.followMentions', checked ? '1' : '0'); } catch {} }} /> Follow mentions</label>
        </div><div id="docpane"><iframe ref={frame} id="doc" title="Document viewer" src={doc.split('/').map(encodeURIComponent).join('/')} /></div></section>}
    </div>
    </div>
  </main>;
}
