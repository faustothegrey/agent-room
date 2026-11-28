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
const room = { folder: '/room', active: 'discussions/2026-11-01-live', board: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [], closedBoards: [], checkpoints: [], open: [], autoDev: { status: null } };
const fetchMock = vi.fn(), navigate = vi.fn();
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages: [], input: true, peek: null, doc: null });
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
const setup = (extra: object = {}) => { render(<App version="one" refresh={() => {}} navigate={navigate} />); reset(extra); };
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); navigate.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files: [], unviewable: [], branch: null } : [] })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('creates each supported board beside the current one and follows the goto to its React page', async () => {
  setup(); const user = userEvent.setup(), boards = screen.getByLabelText('Boards');
  for (const [label, command] of [['New sprint', '/new'], ['New brainstorm', '/brainstorm'], ['New workbench', '/workbench'], ['New research', '/research']]) {
    await user.click(within(boards).getByRole('button', { name: label }));
    await waitFor(() => expect(says()).toContain(command));
  }
  Source.current.send({ type: 'goto', url: '/r/next/__room' }); expect(navigate).toHaveBeenCalledWith('/r/next/__room');
});

it('places creation buttons in their matching collapsible sections', async () => {
  setup(); const user = userEvent.setup();
  for (const [section, labels] of [
    ['Sprints (0)', ['New sprint', 'New workbench']],
    ['Research (0)', ['New research']],
    ['Brainstorms (0)', ['New brainstorm']],
  ] as const) {
    const summary = screen.getByText(section), details = summary.closest('details')!;
    for (const label of labels) expect(within(details).getByRole('button', { name: label })).toBeTruthy();
    await user.click(summary);
    await waitFor(() => expect(details.open).toBe(false));
    for (const label of labels) {
      const button = within(details).getByRole('button', { name: label });
      await user.click(button);
      expect(details.open).toBe(false);
    }
  }
});

it('requires a second click in a started single-session room and lets the warning expire', async () => {
  setup({ multi: false }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'New brainstorm' }));
  const button = screen.getByRole('button', { name: 'New brainstorm' });
  const details = button.closest('details')!;
  expect(says()).toEqual([]); expect(button.classList.contains('armed')).toBe(true);
  await user.click(within(details).getByText('Brainstorms (0)'));
  expect(details.open).toBe(false);
  expect(within(details).getByText('Click again: this session ends and the chat clears')).toBeTruthy();
  await user.click(button);
  expect(details.open).toBe(false);
  await waitFor(() => expect(says()).toEqual(['/brainstorm']));
  vi.useFakeTimers(); fireEvent.click(within(screen.getByLabelText('Boards')).getByRole('button', { name: 'New research' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(within(screen.getByLabelText('Boards')).getByRole('button', { name: 'New research' }).classList.contains('armed')).toBe(false);
  expect(within(screen.getByText('Research (0)').closest('details')!).queryByText('Click again: this session ends and the chat clears')).toBeNull(); expect(says()).toEqual(['/brainstorm']);
});

it('sends the first message to name an unnamed discussion, brainstorm or research board', async () => {
  setup({ active: null, multi: true });
  const user = userEvent.setup();
  for (const [extra, hint, message] of [
    [{ started: false }, 'No active sprints: your first message starts one.', 'A discussion'],
    [{ brainstorm: true }, 'Your first message names this brainstorm and saves it here.', 'An idea'],
    [{ research: true }, 'Your first message names this research board and saves it here.', 'A question'],
  ] as const) {
    reset({ active: null, multi: true, ...extra }); expect(screen.getByText(hint)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), `${message}{Enter}`);
    await waitFor(() => expect(says()).toContain(message));
  }
});

it.each([
  { kind: 'sprint', board: 'New sprint', started: false },
  { kind: 'brainstorm', board: 'New brainstorm', brainstorm: true },
  { kind: 'research board', board: 'New research board', research: true },
])('highlights a new $kind and explains the first message', ({ kind, ...extra }) => {
  setup({ active: null, ...extra });
  expect(document.getElementById('disc-header')?.classList.contains('new-board')).toBe(true);
  expect(screen.getByRole('heading', { name: extra.board })).toBeTruthy();
  expect(document.getElementById('disc-status')?.textContent).toBe('New · waiting for first message');
  expect(screen.getByText(`Describe what you want to work on. Sending your first message starts this ${kind} and gives it a title.`)).toBeTruthy();
  expect(screen.getByPlaceholderText(`Write your first message… (starts this ${kind} and gives it a title)`)).toBeTruthy();
});

it('highlights a new workbench in the Worker tab', () => {
  setup({ active: null, board: 'New workbench', workbench: true });
  expect(document.getElementById('disc-header')?.classList.contains('new-board')).toBe(true);
  expect(screen.getByRole('heading', { name: 'New workbench' })).toBeTruthy();
  expect(document.getElementById('disc-status')?.textContent).toBe('New · waiting for first instruction');
  expect(screen.getByText('Send your first instruction to name and start this workbench.')).toBeTruthy();
});

it('clears the new board cues while naming, after starting, and on reopening', () => {
  setup({ active: null, board: 'New sprint', started: false });
  const expectNoNewCues = () => {
    expect(document.getElementById('disc-header')?.classList.contains('new-board')).toBe(false);
    expect(screen.queryByText('New · waiting for first message')).toBeNull();
    expect(screen.queryByText(/Describe what you want to work on/)).toBeNull();
    expect(screen.queryByPlaceholderText(/^Write your first message/)).toBeNull();
  };
  const label = "Claude (choosing the sprint's title)";
  Source.current.send({ type: 'thinking', name: label });
  expect(document.getElementById('disc-status')?.textContent).toBe(label + ' is thinking');
  expectNoNewCues();

  // If creation failed before the folder existed, the room is still unnamed.
  Source.current.send({ type: 'thinking', name: null });
  expect(screen.getByText('New · waiting for first message')).toBeTruthy();

  reset();
  expectNoNewCues();
  reset({ started: false });
  expectNoNewCues();
});

it('offers Cancel only for an unnamed multi-room creation and sends /cancel', async () => {
  setup({ active: null, brainstorm: true }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Cancel' })); await waitFor(() => expect(says()).toContain('/cancel'));
  Source.current.send({ type: 'goto', url: '/r/origin/__room' }); expect(navigate).toHaveBeenCalledWith('/r/origin/__room');
  reset(); expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  reset({ active: null, research: true, multi: false }); expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});

it('hides creation while peeking or in terminal mode and shows a failed request', async () => {
  setup(); const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string) => url === '__say' ? { ok: false, text: async () => 'Cannot start now' } : { ok: true, json: async () => ({ files: [], unviewable: [], branch: null }) });
  await user.click(within(screen.getByLabelText('Boards')).getByRole('button', { name: 'New research' })); expect(await screen.findByText('Cannot start now')).toBeTruthy();
  Source.current.send({ type: 'reset', room, input: true, doc: null, messages: [], peek: { name: 'old', title: 'Old', path: 'discussions/old' } });
  expect(within(screen.getByLabelText('Boards')).queryByRole('button', { name: 'New research' })).toBeNull();
  Source.current.send({ type: 'reset', room, input: false, doc: null, messages: [], peek: null });
  expect(screen.queryByRole('button', { name: 'New brainstorm' })).toBeNull();
});

const sayBodies = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body));
const kindGroup = () => screen.queryByRole('group', { name: 'Research kind' });

it('sends each Deep / Theoretical combination with a new research board’s first message', async () => {
  setup({ active: null, multi: true, research: true }); const user = userEvent.setup();
  for (const [deep, theoretical] of [[false, false], [true, false], [false, true], [true, true]]) {
    reset({ active: null, multi: true, research: true, folder: `/room-${deep}-${theoretical}` }); // a new unstarted board each time
    const group = kindGroup()!;
    for (const [name, on] of [['Deep', deep], ['Theoretical', theoretical]] as const) {
      const button = within(group).getByRole('button', { name });
      expect(button.getAttribute('aria-pressed')).toBe('false');
      if (on) await user.click(button);
      expect(button.getAttribute('aria-pressed')).toBe(String(on));
    }
    const text = `Quest ${deep} ${theoretical}`;
    await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), `${text}{Enter}`);
    await waitFor(() => expect(sayBodies().find((body) => body.text === text)).toEqual({ text, researchKind: { deep, theoretical } }));
  }
});

it('keeps the text and both toggles when the first Send fails, and sends no kind with a command', async () => {
  setup({ active: null, multi: true, research: true }); const user = userEvent.setup();
  fetchMock.mockImplementation(async (url: string, init?: { body: string }) => url === '__say' && JSON.parse(init!.body).text === 'Quest'
    ? { ok: false, status: 409, text: async () => 'Refused.', json: async () => ({}) }
    : { ok: true, text: async () => '', json: async () => [] });
  const group = kindGroup()!;
  await user.click(within(group).getByRole('button', { name: 'Deep' }));
  await user.click(within(group).getByRole('button', { name: 'Theoretical' }));
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, 'Quest{Enter}');
  await waitFor(() => expect(sayBodies()).toEqual([{ text: 'Quest', researchKind: { deep: true, theoretical: true } }]));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); }); // the refusal is handled
  expect(box.value).toBe('Quest');
  for (const name of ['Deep', 'Theoretical']) expect(within(kindGroup()!).getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
  await user.clear(box); await user.type(box, '/summary{Enter}');
  await waitFor(() => expect(sayBodies().at(-1)).toEqual({ text: '/summary' }));
});

it('shows the kind toggles only on an unstarted research board', () => {
  setup({ active: null, multi: true, research: true }); expect(kindGroup()).toBeTruthy();
  for (const extra of [
    { active: 'discussions/2026-11-01-quest', research: true }, // started research board
    { active: null, research: false, started: false }, // new discussion
    { active: null, research: false, brainstorm: true }, // new brainstorm
    { active: null, research: false, workbench: true }, // new workbench
    { active: 'discussions/2026-11-01-live' }, // started discussion
  ]) { reset({ multi: true, ...extra }); expect(kindGroup()).toBeNull(); }
});
