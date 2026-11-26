import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const room = { folder: '/room', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, multi: true, brainstorm: false, research: false, workbench: false, members: [], failedAgents: [],
  open: [{ url: '/r/b/__room', current: false, title: 'Other board', active: null, brainstorm: false, workbench: false, research: false, started: false, working: false, workerBusy: false, ongoing: false }] };
const list = [{ id: '20261125-080000-aaaaaaaa', title: 'Plan', tags: ['work', 'big idea'], savedAt: '2026-11-25T08:00:00Z' }, { id: '20261125-090000-bbbbbbbb', title: 'Ideas', tags: ['work'], savedAt: '2026-11-25T09:00:00Z' }];
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
let answer: (url: string, body: Record<string, unknown> | null) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '__health' ? new Promise(() => {}) : answer(url, init?.body ? JSON.parse(String(init.body)) : null));
const bodies = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(String(init?.body)));
const reset = () => Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, workInput: true, webVersion: 'one' });
const panel = () => screen.getByLabelText('Services panel');
const note = () => screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;
const status = () => within(panel()).getAllByRole('status').at(-1)!;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock);
  answer = (url) => url === '__notes' ? ok(list) : url.startsWith('__notes/read') ? ok({ ...list.find((n) => url.endsWith(n.id))!, text: url.endsWith('aaaaaaaa') ? 'Plan\nfirst' : 'Ideas\nsecond' })
    : url === '__notes/save' || url === '__notes/new' ? ok({ id: '20261125-100000-cccccccc', savedAt: '2026-11-25T10:00:00Z' }) : url === '__notes/remove' ? ok() : ok([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const openNotes = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: '📝 My notes' })); return await within(panel()).findByRole('button', { name: /^Plan/ }); };

it('opens My notes beside the board, folding Boards until it closes, and lists, reads, saves and creates notes', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  expect(panel().hidden).toBe(true); expect(screen.getByRole('button', { name: 'Collapse boards list' })).toBeTruthy();
  await openNotes(user);
  expect(panel().hidden).toBe(false); expect(screen.getByRole('button', { name: 'Expand boards list' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '📝 My notes' }).getAttribute('aria-pressed')).toBe('true');
  expect(note().disabled).toBe(true);
  await user.click(within(panel()).getByRole('button', { name: /^Plan/ }));
  await waitFor(() => expect(note().value).toBe('Plan\nfirst'));
  await user.type(note(), ' more'); await user.click(within(panel()).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(status().textContent).toMatch(/^Saved .+\.$/));
  expect(bodies('__notes/save')).toEqual([{ id: '20261125-080000-aaaaaaaa', text: 'Plan\nfirst more' }]);
  await user.click(within(panel()).getByRole('button', { name: 'New' }));
  expect(status().textContent).toBe('A new note: the first line is its title. Nothing is saved until Save.');
  expect(within(panel()).getByRole('button', { name: 'Discard' })).toBeTruthy();
  await user.type(note(), 'Fresh'); await user.click(within(panel()).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(bodies('__notes/new')).toEqual([{ text: 'Fresh' }]));
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' }));
  expect(panel().hidden).toBe(true); expect(screen.getByRole('button', { name: 'Collapse boards list' })).toBeTruthy();
  expect(localStorage.getItem('agent-room:list-collapsed')).toBeNull(); // folding for a service is not saved
});

it('opens notes from a server started before tags were added', async () => {
  answer = ((base) => (url: string, body: Record<string, unknown> | null) => url === '__notes' ? ok(list.map(({ tags: _tags, ...n }) => n)) : base(url, body))(answer);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await openNotes(user);
  expect(within(screen.getByLabelText('Notes')).getByRole('button', { name: /^Ideas/ })).toBeTruthy();
  expect(screen.queryByLabelText('Filter notes by tag')).toBeNull();
});

it('shows tag chips and filters, toggles the filter, and clears it when its tag disappears', async () => {
  let current = list;
  answer = ((base) => (url: string, body: Record<string, unknown> | null) => url === '__notes' ? ok(current) : base(url, body))(answer);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await openNotes(user);
  const filters = within(screen.getByLabelText('Filter notes by tag'));
  const rows = within(screen.getByLabelText('Notes'));
  expect(rows.getByRole('button', { name: /^Plan/ }).textContent).toContain('#big idea');
  const workFilter = filters.getByRole('button', { name: '#work' });
  const workChips = rows.getAllByText('#work');
  expect(workFilter.style.backgroundColor).toBeTruthy();
  expect(workChips.map((chip) => chip.style.backgroundColor)).toEqual([workFilter.style.backgroundColor, workFilter.style.backgroundColor]);
  expect(filters.getByRole('button', { name: '#big idea' }).style.backgroundColor).not.toBe(workFilter.style.backgroundColor);
  await user.click(filters.getByRole('button', { name: '#big idea' }));
  expect(rows.queryByRole('button', { name: /^Ideas/ })).toBeNull();
  await user.click(filters.getByRole('button', { name: '#big idea' }));
  expect(rows.getByRole('button', { name: /^Ideas/ })).toBeTruthy();
  await user.click(filters.getByRole('button', { name: '#big idea' }));
  current = [list[1]];
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' }));
  await user.click(screen.getByRole('button', { name: '📝 My notes' }));
  await waitFor(() => expect(rows.getByRole('button', { name: /^Ideas/ })).toBeTruthy());
  expect(filters.queryByRole('button', { name: '#big idea' })).toBeNull();
});

it('asks before dropping unsaved changes inside the panel, and removes or discards notes after asking', async () => {
  answer = ((base) => (url: string, body: Record<string, unknown> | null) => url === '__notes/save' ? { ok: false, status: 404, json: async () => ({}), text: async () => '' } : base(url, body))(answer);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await openNotes(user); await user.click(within(panel()).getByRole('button', { name: /^Plan/ }));
  await waitFor(() => expect(note().value).toBe('Plan\nfirst')); await user.type(note(), '!');
  await user.click(within(panel()).getByRole('button', { name: /^Ideas/ }));
  const ask = screen.getByRole('alertdialog', { name: '"Plan" has unsaved changes.' });
  expect(document.activeElement?.textContent).toBe('Keep editing');
  await user.click(within(ask).getByRole('button', { name: 'Keep editing' })); expect(note().value).toBe('Plan\nfirst!');
  await user.click(within(panel()).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(status().textContent).toBe('✗ That note was removed elsewhere: Save again keeps this text as a new note.'));
  await user.click(within(panel()).getByRole('button', { name: /^Ideas/ }));
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(note().value).toBe('Ideas\nsecond'));
  await user.click(within(panel()).getByRole('button', { name: 'Remove' }));
  await user.click(within(screen.getByRole('alertdialog', { name: 'Remove "Ideas"? Its file is deleted from this computer.' })).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(status().textContent).toBe('Removed.'));
  expect(bodies('__notes/remove')).toEqual([{ id: '20261125-090000-bbbbbbbb' }]); expect(note().disabled).toBe(true);
  await user.click(within(panel()).getByRole('button', { name: 'New' }));
  await user.click(within(panel()).getByRole('button', { name: 'Discard' }));
  await user.click(within(screen.getByRole('alertdialog', { name: 'Discard this new note? It was never saved.' })).getByRole('button', { name: 'Discard' }));
  expect(note().disabled).toBe(true);
});

it('guards board links and room switches while a note is unsaved, and warns before leaving the page', async () => {
  answer = ((base) => (url: string, body: Record<string, unknown> | null) => url === '__rooms' ? ok([{ id: 'c', path: '/r/c/__room', root: '/c', discussion: null, pages: 0, current: false }]) : base(url, body))(answer);
  const navigate = vi.fn();
  render(<App version="one" refresh={() => {}} navigate={navigate} />); reset(); const user = userEvent.setup();
  await openNotes(user); await user.click(within(panel()).getByRole('button', { name: /^Plan/ }));
  await waitFor(() => expect(note().value).toBe('Plan\nfirst')); await user.type(note(), '!');
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' })); // closing keeps the edit
  const link = screen.getByRole('link', { name: 'Other board' }), click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  act(() => { link.dispatchEvent(click); });
  expect(click.defaultPrevented).toBe(true); expect(panel().hidden).toBe(false); expect(note().value).toBe('Plan\nfirst!');
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' })); expect(navigate).not.toHaveBeenCalled();
  const leave = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leave); expect(leave.defaultPrevented).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Running rooms' }), { target: { value: 'tab:/r/c/__room' } });
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
  expect(navigate).toHaveBeenCalledWith(new URL('/r/c/__room', location.href).href);
});

it('keeps an unsaved note across a version refresh and reopens it with its notice', async () => {
  const refresh = vi.fn(); const first = render(<App version="one" refresh={refresh} />); reset(); const user = userEvent.setup();
  await openNotes(user); await user.click(within(panel()).getByRole('button', { name: /^Plan/ }));
  await waitFor(() => expect(note().value).toBe('Plan\nfirst')); await user.type(note(), ' kept');
  Source.current.send({ type: 'web-version', webVersion: 'two' });
  expect(refresh).toHaveBeenCalled(); expect(JSON.parse(sessionStorage.getItem('next-notes-draft')!)).toEqual({ id: '20261125-080000-aaaaaaaa', base: 'Plan\nfirst', text: 'Plan\nfirst kept' });
  first.unmount();
  render(<App version="two" refresh={() => {}} />);
  expect(panel().hidden).toBe(false); expect(note().value).toBe('Plan\nfirst kept');
  await waitFor(() => expect(status().textContent).toBe('Kept your unsaved changes from before the page refreshed.'));
  expect(sessionStorage.getItem('next-notes-draft')).toBeNull();
});

it('does not save divider drags while a service is open', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const key = 'agent-room:board-layout:' + JSON.stringify(['/room', '2026-11-25-live']);
  await openNotes(user); const before = localStorage.getItem(key);
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize conversation and side pane' }), { key: 'ArrowRight' });
  expect(localStorage.getItem(key)).toBe(before);
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' }));
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize conversation and side pane' }), { key: 'ArrowRight' });
  expect(JSON.parse(localStorage.getItem(key)!).left).toBeGreaterThan(0);
});
