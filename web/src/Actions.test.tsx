import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const fetchMock = vi.fn();
const reset = (extra: object = {}, event: object = {}) => Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages: [], input: true, peek: null, doc: null, ...event });
const setup = (extra: object = {}) => { render(<App version="one" refresh={() => {}} />); reset(extra); };
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files: [], unviewable: [], branch: null } : [] })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('refreshes worker information on opening Actions and sends Summarize and New research', async () => {
  setup(); const user = userEvent.setup(); await user.click(screen.getByLabelText('Discussion actions'));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: 'Summarize' })); await waitFor(() => expect(says()).toContain('/summary'));
  await user.click(screen.getByLabelText('Discussion actions')); await user.click(screen.getByRole('button', { name: 'New research' }));
  await waitFor(() => expect(says()).toContain('/research'));
  await user.click(screen.getByLabelText('Discussion actions')); await user.click(screen.getByRole('button', { name: 'New workbench' }));
  await waitFor(() => expect(says()).toContain('/workbench'));
});

it('requires two clicks to convert a brainstorm to a discussion or research', async () => {
  setup({ active: 'brainstorms/2026-11-01-idea', brainstorm: true }); const user = userEvent.setup();
  await user.click(screen.getByLabelText('Discussion actions')); await user.click(screen.getByRole('button', { name: 'Turn into a discussion' }));
  expect(says()).toEqual([]); await user.click(screen.getByRole('button', { name: 'Click again: it moves to discussions/' }));
  await waitFor(() => expect(says()).toEqual(['/convert brainstorms/2026-11-01-idea']));
  await user.click(screen.getByLabelText('Discussion actions')); await user.click(screen.getByRole('button', { name: 'Turn into research' }));
  expect(says()).toHaveLength(1); await user.click(screen.getByRole('button', { name: 'Click again: it moves to discussions/ as a research board' }));
  await waitFor(() => expect(says()).toContain('/convert brainstorms/2026-11-01-idea research'));
});

it('shows pending-work Close and confirms before sending the existing command', async () => {
  setup(); Source.current.send({ type: 'workerinfo', info: { lines: [], pending: [{ lane: '2026-11-01-live', branch: 'worker/live', ahead: 1, dirty: false, conflicts: [] }] } });
  const user = userEvent.setup(); await user.click(screen.getByLabelText('Discussion actions'));
  await user.click(screen.getByRole('button', { name: 'Close with pending work' })); expect(says()).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Click again: this discussion closes (its agents stop)' }));
  await waitFor(() => expect(says()).toEqual(['/close']));
});

it('uses research-specific conversion warning, hides actions in read-only views, and expires confirmation', async () => {
  setup({ research: true }); const user = userEvent.setup(); await user.click(screen.getByLabelText('Discussion actions'));
  vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Turn into a discussion' }));
  expect(screen.getByRole('button', { name: 'Click again: research sessions end and scheduled tasks turn off' })).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(screen.getByRole('button', { name: 'Turn into a discussion' })).toBeTruthy();
  vi.useRealTimers(); reset({}, { peek: { name: 'old', title: 'Old', path: 'discussions/old' } });
  expect(screen.queryByLabelText('Discussion actions')).toBeNull();
});

it('shows the failure from a refused command without sending a second destructive request', async () => {
  setup(); fetchMock.mockImplementation(async (url: string) => url === '__say' ? { ok: false, text: async () => 'Refused' } : { ok: true, json: async () => ({ files: [], unviewable: [], branch: null }) });
  const user = userEvent.setup(); await user.click(screen.getByLabelText('Discussion actions')); await user.click(screen.getByRole('button', { name: 'Summarize' }));
  expect(await screen.findByText('Refused')).toBeTruthy(); expect(says()).toEqual(['/summary']);
});
