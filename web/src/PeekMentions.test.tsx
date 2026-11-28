import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent)); }
}
const room = { board: 'Live', active: 'discussions/2026-11-23-live', started: true, autoDev: { status: null } };
const peek = { name: '2026-11-10-closed', title: 'Closed', path: 'discussions/2026-11-10-closed', ref: '2026-11-10-closed', kind: 'sprint', messages: [], doc: null };
const paths = ['README.md', 'discussions/2026-11-23-live/notes.md', 'discussions/2026-11-23-live/drawings/flow.svg', 'discussions/2026-11-10-closed/notes.md', 'discussions/2026-11-10-closed/archive.zip'];
const entry = (speaker: string, html: string, extra: object = {}) => ({ speaker, html, pass: false, hidden: false, error: false, ...extra });
const fetchMock = vi.fn();
const setup = () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', input: true, room, messages: [], doc: null, peek: null });
};
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 204, text: async () => '', json: async () => url.includes('detail=1') ? { files: paths, unviewable: [paths[4]], branch: null } : paths }));
  vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('links known root and discussion files without changing existing links or preformatted text', async () => {
  setup();
  Source.current.send({ type: 'reset', input: true, room, doc: null, peek: null, messages: [entry('A', '<p>README.md notes.md ./drawings/flow.svg discussions/2026-11-10-closed/notes.md missing.md <a href="/other">README.md</a></p><pre>notes.md</pre>')] });
  const root = await screen.findByTitle('Show README.md in Document');
  expect(root.getAttribute('title')).toBe('Show README.md in Document');
  expect(screen.getByRole('link', { name: 'notes.md' }).getAttribute('title')).toBe(`Show ${paths[1]} in Document`);
  expect(screen.getByRole('link', { name: 'drawings/flow.svg' }).getAttribute('title')).toBe(`Show ${paths[2]} in Document`);
  expect(screen.getByRole('link', { name: paths[3] }).getAttribute('title')).toBe(`Show ${paths[3]} in Document`);
  expect(screen.queryByRole('link', { name: 'missing.md' })).toBeNull();
  expect(screen.getByText('notes.md', { selector: 'pre' }).querySelector('a')).toBeNull();
  expect(screen.getAllByRole('link', { name: 'README.md' }).some((link) => link.getAttribute('href') === '/other')).toBe(true);
  await userEvent.setup().click(screen.getByRole('link', { name: 'notes.md' }));
  const show = fetchMock.mock.calls.find(([url]) => url === '__show');
  expect(JSON.parse(show![1].body)).toEqual({ file: paths[1] });
});

it('offers live file mentions, excludes the shown file, dismisses, and follows when enabled', async () => {
  setup(); Source.current.send({ type: 'doc', file: 'README.md' });
  Source.current.send({ type: 'message', message: entry('Ada', '<p>README.md notes.md ./drawings/flow.svg</p>') });
  const offers = await screen.findByLabelText('File mentions');
  expect(within(offers).queryByRole('button', { name: /README/ })).toBeNull();
  expect(within(offers).getByRole('button', { name: '📄 Show notes.md' })).toBeTruthy();
  await userEvent.setup().click(within(offers).getByRole('button', { name: '📄 Show notes.md' }));
  expect(screen.queryByLabelText('File mentions')).toBeNull();
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__show')![1].body)).toEqual({ file: paths[1] });
  await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Follow mentions' }));
  expect(localStorage.getItem('agent-room.followMentions')).toBe('1');
  Source.current.send({ type: 'message', message: entry('Ada', '<p>./drawings/flow.svg</p>') });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__show')).toHaveLength(2));
  expect(JSON.parse(fetchMock.mock.calls.filter(([url]) => url === '__show')[1][1].body)).toEqual({ file: paths[2] });
  expect(screen.queryByLabelText('File mentions')).toBeNull();
});

it('does not offer user, relayed, or error messages and lets a user dismiss an offer', async () => {
  setup();
  Source.current.send({ type: 'message', message: entry('Ada', '<p>notes.md</p>') });
  await screen.findByLabelText('File mentions');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss file mentions' }));
  expect(screen.queryByLabelText('File mentions')).toBeNull();
  for (const m of [entry('User', '<p>notes.md</p>'), entry('Relayed from discussion', '<p>notes.md</p>'), entry('A', '<p>notes.md</p>', { error: true, errorText: 'bad' })]) Source.current.send({ type: 'message', message: m });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__files').length).toBeGreaterThanOrEqual(2));
  expect(screen.queryByLabelText('File mentions')).toBeNull();
});

it('peeks at closed chat and files, keeps live messages out of view, and returns without re-entering', async () => {
  setup(); const user = userEvent.setup();
  Source.current.send({ type: 'message', message: entry('A', '<p>live before</p>') });
  await screen.findByText('live before');
  Source.current.send({ type: 'reset', input: true, room, peek, doc: paths[3], messages: [entry('B', '<p>closed chat</p>')] });
  expect(screen.getByRole('heading', { name: 'Closed' })).toBeTruthy();
  expect(screen.getByLabelText('Explorer tab').dataset.peeking).toBe('true');
  expect(screen.getByText('closed chat')).toBeTruthy(); expect(screen.queryByText('live before')).toBeNull();
  await user.click(screen.getByLabelText('Explorer tab'));
  const board = screen.getByLabelText('Peeked board files');
  const notes = await within(board).findByRole('button', { name: 'notes.md' });
  expect((within(board).getByRole('button', { name: "archive.zip · can't be shown here" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(notes); expect(screen.getByTitle(paths[3])).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url]) => url === '__show')).toHaveLength(0);
  Source.current.send({ type: 'message', message: entry('A', '<p>live during</p>') });
  expect(screen.queryByText('live during')).toBeNull();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' });
  await user.type(box, 'do not send{Enter}'); expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(0);
  await user.click(screen.getByLabelText('Explorer tab'));
  await user.click(within(board).getByRole('button', { name: 'Back to current' }));
  await waitFor(() => expect(screen.queryByLabelText('Explorer tab')).toBeNull());
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__say')![1].body)).toEqual({ text: '/peek' });
  expect(screen.getByText('live before')).toBeTruthy(); expect(screen.getByText('live during')).toBeTruthy();
  Source.current.send({ type: 'reset', input: true, room, peek: null, doc: null, messages: [entry('A', '<p>live after reset</p>')] });
  expect(screen.getByText('live after reset')).toBeTruthy();
  expect(screen.getByTitle(paths[3])).toBeTruthy();
  Source.current.send({ type: 'doc', file: paths[3] });
  expect(screen.queryByLabelText('Explorer tab')).toBeNull(); expect(screen.getByTitle(paths[3])).toBeTruthy();
});

it('clears a peek when the active discussion changes and keeps file selection outside the peek', async () => {
  setup();
  Source.current.send({ type: 'reset', input: true, room, peek, doc: paths[3], messages: [entry('B', '<p>closed chat</p>')] });
  await userEvent.setup().click(screen.getByLabelText('Explorer tab'));
  await screen.findByRole('button', { name: 'notes.md' });
  Source.current.send({ type: 'room', room: { ...room, active: 'discussions/new', board: 'New' } });
  expect(screen.queryByLabelText('Explorer tab')).toBeNull(); expect(screen.queryByText('closed chat')).toBeNull();
  Source.current.send({ type: 'doc', file: paths[3] });
  expect(screen.queryByLabelText('Explorer tab')).toBeNull(); expect(screen.getByTitle(paths[3])).toBeTruthy();
});

it('offers at most three distinct files and does not revive stale offers after the user speaks', async () => {
  setup();
  const many = ['one.md', 'two.md', 'three.md', 'four.md'];
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => many }));
  Source.current.send({ type: 'message', message: entry('Ada', '<p>one.md two.md one.md three.md four.md</p>') });
  const bar = await screen.findByLabelText('File mentions');
  expect(within(bar).getAllByRole('button')).toHaveLength(4); // three offers and dismiss
  expect(within(bar).queryByRole('button', { name: '📄 Show four.md' })).toBeNull();
  Source.current.send({ type: 'message', message: entry('User', '<p>thanks</p>') });
  expect(screen.queryByLabelText('File mentions')).toBeNull();
});

it('keeps previously loaded file matches if the next file-list request fails', async () => {
  setup(); Source.current.send({ type: 'reset', input: true, room, messages: [entry('Ada', '<p>notes.md</p>')] });
  await screen.findByRole('link', { name: 'notes.md' });
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  Source.current.send({ type: 'message', message: entry('Ada', '<p>notes.md</p>') });
  expect(await screen.findByRole('button', { name: '📄 Show notes.md' })).toBeTruthy();
});

it('shows archived and brainstorm peeks by their paths and falls back to a friendly folder title', async () => {
  setup();
  const archived = { ...peek, name: '2026-11-01-old-idea', title: '2026-11-01-old-idea', kind: 'brainstorm', path: 'brainstorms/archive/2026-11-01-old-idea' };
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ files: ['brainstorms/archive/2026-11-01-old-idea/notes.md'], unviewable: [], branch: null }) }));
  Source.current.send({ type: 'reset', input: true, room, peek: archived, doc: null, messages: [entry('B', '<p>archived</p>')] });
  expect(screen.getByRole('heading', { name: 'old idea' })).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'notes.md' })).toBeTruthy();
  expect(screen.getByText('archived')).toBeTruthy();
});

it('links Worker reports and offers live Worker mentions, including follow and user dismissal', async () => {
  setup();
  Source.current.send({ type: 'reset', input: true, room, doc: null, peek: null, messages: [], worker: [entry('Worker report', '<p>README.md</p>')] });
  const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: 'Worker' }));
  expect(await screen.findByRole('link', { name: 'README.md' })).toBeTruthy();
  Source.current.send({ type: 'work', message: entry('Worker report', '<p>notes.md</p>') });
  const offers = await screen.findByLabelText('File mentions');
  await user.click(within(offers).getByRole('button', { name: '📄 Show notes.md' }));
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__show')![1].body)).toEqual({ file: paths[1] });
  Source.current.send({ type: 'doc', file: 'README.md' }); // Follow mentions is in the Document bar, as on /__room
  await user.click(screen.getByRole('checkbox', { name: 'Follow mentions' }));
  Source.current.send({ type: 'work', message: entry('Worker report', '<p>./drawings/flow.svg</p>') });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__show')).toHaveLength(2));
  await user.click(screen.getByRole('checkbox', { name: 'Follow mentions' }));
  Source.current.send({ type: 'work', message: entry('Worker report', '<p>notes.md</p>') });
  await screen.findByLabelText('File mentions');
  Source.current.send({ type: 'work', message: entry('User', '<p>hello</p>') });
  expect(screen.queryByLabelText('File mentions')).toBeNull();
});

it('shows the Boards Back to current button (expanded and collapsed) for chat peek, file peek, and received peek', async () => {
  const replica = {
    node: 'studio', addresses: ['192.168.1.5:8080'], roomId: 'r1',
    own: {},
    received: [{ board: 'd1', node: 'mini', commit: 'c1', round: 3, receivedAt: '2026-11-25T08:00:00Z', name: '2026-11-09-shared', title: 'Shared plan', local: null }],
    peers: [],
  };
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true, status: 204, text: async () => '',
    json: async () => url.startsWith('__rfiles') ? ['notes.md']
      : url.includes('detail=1') ? { files: paths, unviewable: [], branch: null } : paths,
  }));
  setup();
  const user = userEvent.setup();
  const boards = screen.getByLabelText('Boards');
  expect(within(boards).queryByRole('button', { name: 'Back to current' })).toBeNull();

  // 1. Closed-board chat peek (expanded, then collapsed, then click to leave)
  Source.current.send({ type: 'reset', input: true, room, peek, doc: null, messages: [entry('B', '<p>closed</p>')] });
  const chatBack = within(boards).getByRole('button', { name: 'Back to current' });
  expect(chatBack.getAttribute('title')).toBe('Back to current');
  expect(chatBack.textContent).toBe('↩ Back to current');
  expect(chatBack.previousElementSibling?.id).toBe('list-head');
  await user.click(screen.getByRole('button', { name: 'Collapse boards list' }));
  const chatBackCollapsed = within(boards).getByRole('button', { name: 'Back to current' });
  expect(chatBackCollapsed.getAttribute('title')).toBe('Back to current');
  expect(chatBackCollapsed.textContent).toBe('↩');
  await user.click(chatBackCollapsed);
  await waitFor(() => expect(within(boards).queryByRole('button', { name: 'Back to current' })).toBeNull());
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__say')![1].body)).toEqual({ text: '/peek' });
  await user.click(screen.getByRole('button', { name: 'Expand boards list' }));

  // 2. File peek (Peek files from board row menu)
  const sayCountBeforeFile = fetchMock.mock.calls.filter(([url]) => url === '__say').length;
  Source.current.send({ type: 'reset', input: true, room: { ...room, closedBoards: ['2026-11-10-closed'] }, peek: null, doc: null, messages: [] });
  await within(boards).findByRole('button', { name: 'closed' });
  await user.click(within(boards).getByLabelText('Board actions for closed'));
  await user.click(within(boards).getByRole('button', { name: 'Peek files' }));
  const fileBack = within(boards).getByRole('button', { name: 'Back to current' });
  expect(fileBack.getAttribute('title')).toBe('Back to current');
  expect(fileBack.textContent).toBe('↩ Back to current');
  expect(document.getElementById('disc-header')?.classList.contains('peeking')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Collapse boards list' }));
  const fileBackCollapsed = within(boards).getByRole('button', { name: 'Back to current' });
  expect(fileBackCollapsed.textContent).toBe('↩');
  await user.click(fileBackCollapsed);
  expect(within(boards).queryByRole('button', { name: 'Back to current' })).toBeNull();
  expect(screen.queryByLabelText('Explorer tab')).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(sayCountBeforeFile);
  await user.click(screen.getByRole('button', { name: 'Expand boards list' }));

  // 3. Received peek (peer's received files)
  Source.current.send({ type: 'replica', replica });
  const peerSection = within(boards).getByText('Received from peers (1)').closest('details')!;
  await user.click(within(peerSection).getByText('Received from peers (1)'));
  await user.click(within(peerSection).getByRole('button', { name: 'Shared plan' }));
  const recvBack = within(boards).getByRole('button', { name: 'Back to current' });
  expect(recvBack.getAttribute('title')).toBe('Back to current');
  expect(recvBack.textContent).toBe('↩ Back to current');
  expect(document.getElementById('disc-header')?.classList.contains('peeking')).toBe(false);
  await user.click(screen.getByRole('button', { name: 'Collapse boards list' }));
  const recvBackCollapsed = within(boards).getByRole('button', { name: 'Back to current' });
  expect(recvBackCollapsed.textContent).toBe('↩');
  await user.click(recvBackCollapsed);
  expect(within(boards).queryByRole('button', { name: 'Back to current' })).toBeNull();
  expect(screen.getByLabelText('Explorer files')).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(sayCountBeforeFile);
});

it('tints the discussion header and shows Peeking · read-only on both Discussion and Worker tabs while peeking', async () => {
  setup();
  const user = userEvent.setup();
  const header = document.getElementById('disc-header')!;
  const status = document.getElementById('disc-status')!;
  expect(header.classList.contains('peeking')).toBe(false);

  Source.current.send({ type: 'reset', input: true, room, peek, doc: null, messages: [entry('B', '<p>closed</p>')] });
  expect(header.classList.contains('peeking')).toBe(true);
  expect(status.textContent).toBe('Peeking · read-only');

  // Switch to Worker tab: must still show Peeking · read-only, not idle or worker working
  await user.click(screen.getByRole('tab', { name: 'Worker' }));
  expect(header.classList.contains('peeking')).toBe(true);
  expect(status.textContent).toBe('Peeking · read-only');
  Source.current.send({ type: 'working', name: 'Worker' });
  expect(status.textContent).toBe('Peeking · read-only');

  // Leave peek: header tint clears and Worker tab shows worker state again
  await user.click(within(screen.getByLabelText('Boards')).getByRole('button', { name: 'Back to current' }));
  await waitFor(() => expect(header.classList.contains('peeking')).toBe(false));
  expect(status.textContent).toBe('Worker is working');
  Source.current.send({ type: 'working', name: null });
  expect(status.textContent).toBe('idle');
});
