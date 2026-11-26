import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { NoteEntry, NoteRequest, NoteSaved } from '../../src/contract';

// The My notes service (notes.mjs), as on /__room: the User's notes for this room's folder, on
// this computer only. A note is saved only by Save. Closing or switching services only hides the
// panel, keeping unsaved edits; they are never dropped without asking: inside the panel before
// another note or New, before switching board or room (guard), the browser's leave-page warning
// otherwise, and a refresh after a code change keeps them (draft).
export type NotesApi = { dirty: () => boolean; draft: () => NoteDraft | null; guard: (act: () => void, cancel?: () => void) => void };
export type NoteDraft = { id: string | null; base: string; text: string };
export const NOTES_DRAFT_KEY = 'next-notes-draft';
type Ask = { text: string; buttons: [string, (() => void)?][] };
type Post = (path: '__notes/new' | '__notes/save' | '__notes/remove', body: NoteRequest) => Promise<Response>;
// Derive the same color wherever a tag appears, without storing a separate palette.
const tagColor = (tag: string) => {
  let hash = 0;
  for (const char of tag) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return { backgroundColor: `hsl(${hash % 360} 75% 50% / 25%)` };
};
const titleOf = (text: string) => text.split('\n')[0].replace(/^\s*#+\s*/, '').trim() || 'Untitled';
export function Notes({ open, show, post, api, kept }: { open: boolean; show: () => void; post: Post; api: MutableRefObject<NotesApi | null>; kept: NoteDraft | null }) {
  const [list, setList] = useState<NoteEntry[]>([]);
  const [editor, setEditor] = useState<{ id: string | null; base: string; editing: boolean }>({ id: null, base: '', editing: false });
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });
  const [ask, setAsk] = useState<Ask | null>(null);
  const [saving, setSaving] = useState(false);
  const session = useRef(0), box = useRef<HTMLTextAreaElement>(null), askButtons = useRef<HTMLSpanElement>(null);
  // The latest editor state for callbacks started earlier (guard, save and read answers).
  const live = useRef({ editor, text }); live.current = { editor, text };
  const dirty = () => live.current.editor.editing && live.current.text !== live.current.editor.base;
  const notesAsk = (q: Ask) => setAsk(q);
  useEffect(() => { if (ask) (askButtons.current?.lastElementChild as HTMLElement | null)?.focus(); }, [ask]); // the safe choice: Keep editing, Cancel
  const edit = (id: string | null, value: string, base = value) => { session.current++; setEditor({ id, base, editing: true }); setText(value); live.current = { editor: { id, base, editing: true }, text: value }; };
  const clear = () => { session.current++; setEditor({ id: null, base: '', editing: false }); setText(''); setAsk(null); setStatus({ text: '' }); };
  const loadNotes = async () => {
    const r = await fetch('__notes', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status + ' ' + await r.text());
    // A server still running the previous version does not include tags until it restarts.
    const value = (await r.json() as NoteEntry[]).map((n) => ({ ...n, tags: n.tags ?? [] })); setList(value);
    setFilter((tag) => tag && value.some((n) => n.tags.includes(tag)) ? tag : null); return value;
  };
  // Runs act now, or once the User agrees to discard the unsaved changes (cancel: if they don't).
  const guard = (act: () => void, cancel?: () => void) => {
    if (!dirty()) { act(); return; }
    show();
    notesAsk({ text: '"' + titleOf(live.current.text) + '" has unsaved changes.', buttons: [
      ['Discard changes', () => { setText(live.current.editor.base); live.current.text = live.current.editor.base; act(); }],
      ['Keep editing', () => { cancel?.(); box.current?.focus(); }]] });
  };
  api.current = { dirty, guard, draft: () => dirty() ? { id: live.current.editor.id, base: live.current.editor.base, text: live.current.text } : null };
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', leave); return () => removeEventListener('beforeunload', leave);
  }, []);
  // Opening the service lists the notes; a draft kept across a refresh comes back in the editor.
  const restored = useRef(false);
  useEffect(() => {
    if (!open) return;
    const draft = !restored.current ? kept : null; restored.current = true;
    if (draft) edit(draft.id, draft.text, draft.base);
    loadNotes().then((found) => {
      if (!draft) return;
      if (draft.id && !found.some((n) => n.id === draft.id)) { edit(null, draft.text, ''); setStatus({ text: 'Kept your unsaved text; its note was removed meanwhile, so Save makes it a new note.' }); return; }
      setStatus({ text: 'Kept your unsaved changes from before the page refreshed.' });
    }, (err: unknown) => setStatus({ text: '✗ Notes: ' + (err instanceof Error ? err.message : String(err)), error: true }));
  }, [open]);
  const readNote = async (id: string) => {
    const mine = ++session.current; // a later click on another note wins, whichever answer comes first
    try {
      const r = await fetch('__notes/read?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) throw new Error(await r.text());
      const n = await r.json() as NoteEntry & { text: string };
      if (session.current !== mine) { loadNotes().catch(() => {}); return; }
      edit(n.id, n.text); setStatus({ text: '' });
    } catch (err) { if (session.current === mine) setStatus({ text: '✗ ' + (err instanceof Error ? err.message : String(err)), error: true }); loadNotes().catch(() => {}); }
  };
  const save = async () => {
    const value = live.current.text, id = live.current.editor.id, mine = session.current, title = titleOf(value);
    const current = () => session.current === mine; // still the editing session this save started in
    setSaving(true);
    try {
      const r = await post(id ? '__notes/save' : '__notes/new', id ? { id, text: value } : { text: value });
      if (!current() && (r.ok || r.status === 404)) { loadNotes().catch(() => {}); return; }
      if (r.status === 404) { edit(null, live.current.text, ''); setStatus({ text: '✗ That note was removed elsewhere: Save again keeps this text as a new note.', error: true }); return; }
      if (!r.ok) throw new Error(await r.text());
      const n = await r.json() as NoteSaved;
      session.current++; setEditor({ id: n.id, base: value, editing: true }); live.current.editor = { id: n.id, base: value, editing: true };
      setStatus({ text: 'Saved ' + new Date(n.savedAt).toLocaleTimeString() + '.' });
      await loadNotes();
    } catch (err) { setStatus({ text: '✗ ' + (current() ? 'Not saved: ' : '"' + title + '" was not saved: ') + (err instanceof Error ? err.message : String(err)), error: true }); }
    finally { setSaving(false); }
  };
  const remove = () => {
    const { id } = live.current.editor;
    if (!id) { notesAsk({ text: 'Discard this new note? It was never saved.', buttons: [['Discard', clear], ['Cancel']] }); return; }
    const mine = session.current, title = titleOf(live.current.text);
    const current = () => session.current === mine;
    notesAsk({ text: 'Remove "' + title + '"? Its file is deleted from this computer.', buttons: [['Remove', async () => {
      try {
        const r = await post('__notes/remove', { id });
        if (!r.ok && r.status !== 404) throw new Error(await r.text());
        if (current()) { clear(); setStatus({ text: 'Removed.' }); }
        // A later session: its text stays; if it shows the removed note, it becomes an unsaved new one.
        else if (live.current.editor.id === id) { edit(null, live.current.text, ''); setStatus({ text: '✗ That note was removed elsewhere: Save again keeps this text as a new note.', error: true }); }
      } catch (err) { setStatus({ text: '✗ ' + (current() ? 'Not removed: ' : '"' + title + '" was not removed: ') + (err instanceof Error ? err.message : String(err)), error: true }); }
      loadNotes().catch(() => {});
    }], ['Cancel']] });
  };
  const tags = [...new Set(list.flatMap((n) => n.tags))].sort();
  const visible = filter ? list.filter((n) => n.tags.includes(filter)) : list;
  return <div id="notes-body" className="notes-body">
    <div id="notes-side" className="notes-side">
      <button type="button" id="notes-new" title="Start a new note: the first line is its title" onClick={() => guard(() => { edit(null, ''); setStatus({ text: 'A new note: the first line is its title. Nothing is saved until Save.' }); box.current?.focus(); })}>New</button>
      {tags.length > 0 && <div id="notes-filters" aria-label="Filter notes by tag">{tags.map((tag) => <button type="button" key={tag} style={tagColor(tag)} aria-pressed={filter === tag} onClick={() => setFilter(filter === tag ? null : tag)}>#{tag}</button>)}</div>}
      <div id="notes-list" aria-label="Notes">{visible.length ? visible.map((n) => <button type="button" key={n.id} className={'note' + (n.id === editor.id ? ' on' : '')} title={n.title}
        onClick={() => { if (n.id !== live.current.editor.id) guard(() => void readNote(n.id)); }}>{n.title}<span className="when">Saved {new Date(n.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>{n.tags.length > 0 && <span className="note-tags">{n.tags.map((tag) => <span className="note-tag" key={tag} style={tagColor(tag)}>#{tag}</span>)}</span>}</button>)
        : <span className="hint">No notes yet.</span>}</div>
    </div>
    <div id="notes-main" className="notes-main">
      {ask && <div id="notes-ask" role="alertdialog" aria-label={ask.text}><span id="notes-ask-text">{ask.text}</span> <span id="notes-ask-buttons" ref={askButtons}>{ask.buttons.map(([label, act]) => <button type="button" key={label} onClick={() => { setAsk(null); act?.(); }}>{label}</button>)}</span></div>}
      <textarea ref={box} className="box" id="notes-text" aria-label="Note" placeholder="Choose a note, or New. The first line is the note's title." disabled={!editor.editing} value={text} onChange={(e) => setText(e.target.value)} />
      <div id="notes-bar"><button type="button" disabled={!editor.editing || saving} title="Save this note (nothing is saved until you press Save)" onClick={() => void save()}>Save</button>
        <button type="button" disabled={!editor.editing} onClick={remove}>{editor.id || !editor.editing ? 'Remove' : 'Discard'}</button>
        <span id="notes-status" role="status" className={status.error ? 'error' : undefined}>{status.text}</span></div>
    </div>
  </div>;
}
