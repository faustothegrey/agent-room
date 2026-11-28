import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(value: object) { act(() => this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)); }
}
const files = [
  'discussions/2026-11-01-current/notes.md', 'discussions/2026-11-02-closed/notes.md',
  'discussions/2026-11-03-work/notes.md', 'discussions/2026-11-04-research/notes.md',
  'discussions/2026-11-05-saved/notes.md', 'discussions/2026-11-06-open/notes.md',
  'brainstorms/2026-11-07-idea/notes.md', 'discussions/archive/2026-10-01-old/notes.md',
  'brainstorms/deferred/2026-09-01-later/notes.md', 'README.md',
];
const room = { folder: '/project', active: 'discussions/2026-11-01-current', board: 'Current title', started: true,
  workbenches: ['2026-11-03-work'], researches: ['2026-11-04-research'], closedBoards: ['2026-11-02-closed', '2026-10-01-old'],
  checkpoints: [{ name: '2026-11-02-closed', title: 'Saved title' }],
  open: [{ active: 'discussions/2026-11-06-open', current: false, title: 'Open board', url: '/r/other/__room' }], autoDev: { status: null } };
const fetchMock = vi.fn();
const setup = () => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, input: true, messages: [], peek: null, doc: null }); };
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files, unviewable: [], branch: null } : [] })); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('groups named boards by kind and shows saved titles, current board and open-room links', async () => {
  setup(); const boards = screen.getByLabelText('Boards');
  await within(boards).findByRole('button', { name: 'Current title' });
  expect(within(boards).getByRole('button', { name: 'Current title' }).getAttribute('aria-current')).toBe('true');
  expect(within(boards).getByRole('button', { name: 'Saved title' })).toBeTruthy();
  expect(within(boards).getByRole('button', { name: '🔧 work' })).toBeTruthy();
  expect(within(boards).getByRole('button', { name: '🔬 research' })).toBeTruthy();
  expect(within(boards).getByRole('button', { name: 'idea' })).toBeTruthy();
  expect(within(boards).getByRole('link', { name: 'Open board' }).getAttribute('href')).toBe('/r/other/__room');
  expect(within(boards).getByText('Archived · Deferred (2)')).toBeTruthy();
  await userEvent.setup().click(within(boards).getByText('Archived · Deferred (2)'));
  expect(within(boards).getByRole('button', { name: 'old' })).toBeTruthy();
  expect(within(boards).getByRole('button', { name: 'later' })).toBeTruthy();
});

it('peeks closed boards and resumes inactive open discussions through room commands', async () => {
  setup(); const user = userEvent.setup(), boards = screen.getByLabelText('Boards');
  await user.click(await within(boards).findByRole('button', { name: 'Saved title' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(init.body).text === '/peek 2026-11-02-closed')).toBe(true));
  await user.click(within(boards).getByRole('button', { name: 'saved' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(init.body).text === '/resume 2026-11-05-saved')).toBe(true));
  await user.click(within(boards).getByRole('button', { name: 'idea' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(init.body).text === '/peek brainstorms/2026-11-07-idea')).toBe(true));
  await user.click(within(boards).getByText('Archived · Deferred (2)'));
  await user.click(within(boards).getByRole('button', { name: 'old' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(init.body).text === '/peek archive/2026-10-01-old')).toBe(true));
});

it('collapses and restores the panel using the legacy shared preference', async () => {
  setup(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Collapse boards list' }));
  expect(localStorage.getItem('agent-room:list-collapsed')).toBe('1'); expect(screen.queryByText('Research (1)')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Expand boards list' }));
  expect(localStorage.getItem('agent-room:list-collapsed')).toBe('0'); expect(await screen.findByText('Research (1)')).toBeTruthy();
});

it('shows the closed board after its Peek reset and returns to the current board', async () => {
  setup(); const user = userEvent.setup();
  await user.click(await within(screen.getByLabelText('Boards')).findByRole('button', { name: 'Saved title' }));
  Source.current.send({ type: 'reset', room, input: true, peek: { name: '2026-11-02-closed', title: 'Saved title', path: 'discussions/2026-11-02-closed' }, doc: null, messages: [{ speaker: 'Ada', html: '<p>Old discussion</p>' }] });
  expect(screen.getByRole('heading', { name: 'Saved title' })).toBeTruthy(); expect(screen.getByText('Old discussion')).toBeTruthy();
  await user.click(within(screen.getByLabelText('Peeked board files')).getByRole('button', { name: 'Back to current' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(init.body).text === '/peek')).toBe(true));
});

it('lists unstarted boards in their own section (brainstorms under Brainstorms, not Sprints)', async () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, open: [
    ...room.open,
    { active: null, current: false, title: 'New sprint (not started)', url: '/r/s/__room', brainstorm: false, workbench: false, research: false, started: false },
    { active: null, current: false, title: 'New research board (not started)', url: '/r/r/__room', brainstorm: false, workbench: false, research: true, started: false },
    { active: null, current: false, title: 'New brainstorm (not started)', url: '/r/b/__room', brainstorm: true, workbench: false, research: false, started: false },
  ] }, input: true, messages: [], peek: null, doc: null });
  const boards = screen.getByLabelText('Boards');
  await within(boards).findByRole('button', { name: 'Current title' });
  const sprintsSection = within(boards).getByText('Sprints (6)').closest('details')!;
  const researchSection = within(boards).getByText('Research (2)').closest('details')!;
  const brainstormsSection = within(boards).getByText('Brainstorms (2)').closest('details')!;
  expect(within(sprintsSection).getByRole('link', { name: 'New sprint (not started)' }).getAttribute('href')).toBe('/r/s/__room');
  expect(within(sprintsSection).queryByRole('link', { name: 'New brainstorm (not started)' })).toBeNull();
  expect(within(researchSection).getByRole('link', { name: '🔬 New research board (not started)' }).getAttribute('href')).toBe('/r/r/__room');
  expect(within(brainstormsSection).getByRole('link', { name: 'New brainstorm (not started)' }).getAttribute('href')).toBe('/r/b/__room');
});

it('prefixes the board heading with its type icon, follows peek and return, and hides it while loading or unknown', async () => {
  render(<App version="one" refresh={() => {}} />);
  const heading = () => screen.getByRole('heading', { level: 1 });
  expect(heading().textContent).toBe('agent-room');
  expect(heading().querySelector('span')).toBeNull();

  Source.current.send({ type: 'reset', room, input: true, messages: [], peek: null, doc: null });
  expect(heading().textContent).toBe('🏃 Current title');
  expect(within(heading()).getByTitle('Sprint').textContent).toBe('🏃');
  expect(document.title).toBe('Current title · agent-room');

  Source.current.send({ type: 'reset', room, input: true, messages: [], doc: null, peek: { name: '2026-11-04-research', kind: 'research', title: 'Research topic', path: 'discussions/2026-11-04-research' } });
  expect(heading().textContent).toBe('🔬 Research topic');
  expect(within(heading()).getByTitle('Research').textContent).toBe('🔬');

  await userEvent.setup().click(within(screen.getByLabelText('Peeked board files')).getByRole('button', { name: 'Back to current' }));
  expect(heading().textContent).toBe('🏃 Current title');
  expect(within(heading()).getByTitle('Sprint').textContent).toBe('🏃');

  Source.current.send({ type: 'reset', room: { ...room, workbench: true, board: 'Fix bug' }, input: true, messages: [], peek: null, doc: null });
  expect(heading().textContent).toBe('🔧 Fix bug');
  expect(within(heading()).getByTitle('Workbench').textContent).toBe('🔧');

  Source.current.send({ type: 'reset', room: { ...room, brainstorm: true, board: 'New ideas' }, input: true, messages: [], peek: null, doc: null });
  expect(heading().textContent).toBe('💡 New ideas');
  expect(within(heading()).getByTitle('Brainstorm').textContent).toBe('💡');

  Source.current.send({ type: 'reset', room, input: true, messages: [], doc: null, peek: { name: '2026-11-02-closed', kind: 'unknown', title: 'Unknown board', path: 'discussions/2026-11-02-closed' } });
  expect(heading().textContent).toBe('Unknown board');
  expect(heading().querySelector('span')).toBeNull();
});
