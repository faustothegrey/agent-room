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
const room = { folder: '/room', active: 'discussions/2026-11-01-live', discussion: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [], closedDiscussions: [], checkpoints: [], open: [], autoDev: { status: null } };
const fetchMock = vi.fn(), navigate = vi.fn();
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages: [], input: true, peek: null, doc: null });
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
const setup = (extra: object = {}) => { render(<App version="one" refresh={() => {}} navigate={navigate} />); reset(extra); };
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); navigate.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files: [], unviewable: [], branch: null } : [] })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('creates each supported board beside the current one and follows the goto to its React page', async () => {
  setup(); const user = userEvent.setup(), boards = screen.getByLabelText('Boards');
  for (const [label, command] of [['New discussion', '/new'], ['New brainstorm', '/brainstorm'], ['New workbench', '/workbench'], ['New research', '/research']]) {
    await user.click(within(boards).getByRole('button', { name: label }));
    await waitFor(() => expect(says()).toContain(command));
  }
  Source.current.send({ type: 'goto', url: '/r/next/__room' }); expect(navigate).toHaveBeenCalledWith('/r/next/__room');
});

it('places creation buttons in their matching collapsible sections', async () => {
  setup(); const user = userEvent.setup();
  for (const [section, labels] of [
    ['Discussions (0)', ['New discussion', 'New workbench']],
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
    [{ started: false }, 'No active discussions: your first message starts one.', 'A discussion'],
    [{ brainstorm: true }, 'Your first message names this brainstorm and saves it here.', 'An idea'],
    [{ research: true }, 'Your first message names this research board and saves it here.', 'A question'],
  ] as const) {
    reset({ active: null, multi: true, ...extra }); expect(screen.getByText(hint)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), `${message}{Enter}`);
    await waitFor(() => expect(says()).toContain(message));
  }
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
