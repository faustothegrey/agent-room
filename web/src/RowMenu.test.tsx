import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const a = '2026-11-01-live', b = '2026-11-02-closed', idea = '2026-11-03-idea';
const paths = [`discussions/${a}/notes.md`, `discussions/${b}/notes.md`, `brainstorms/${idea}/notes.md`];
const room = { folder: '/room', active: `discussions/${a}`, discussion: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [], closedDiscussions: [b], checkpoints: [], open: [], autoDev: { status: null } };
const fetchMock = vi.fn();
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
const setup = () => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], input: true, peek: null, doc: null }); };
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files: paths, unviewable: [], branch: null } : [] })); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('refreshes once on opening, keeps the menu open on workerinfo, and closes when another menu opens', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(1));
  Source.current.send({ type: 'workerinfo', info: { lines: [], pending: [] } });
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(1);
  await user.click(screen.getByLabelText('Board actions for Live'));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(2));
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
});

it('offers closed board Resume, read-only Peek files, and Peek chat through the existing routes', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  await user.click(screen.getByRole('button', { name: 'Peek files' }));
  expect(await screen.findByLabelText('Peeked board files')).toBeTruthy(); expect(says()).toEqual([]);
  await user.click(screen.getByLabelText('Board actions for closed')); await user.click(screen.getByRole('button', { name: 'Peek chat & files' }));
  await waitFor(() => expect(says()).toContain('/peek ' + b));
  await user.click(screen.getByLabelText('Board actions for closed')); await user.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(says()).toContain('/resume ' + b));
});

it('sends Close only when selected and disables Close on a closed brainstorm', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for Live'));
  await user.click(within(screen.getByLabelText('Board actions for Live').parentElement!).getByRole('button', { name: 'Close' })); await waitFor(() => expect(says()).toEqual(['/close ' + a]));
  await user.click(screen.getByLabelText('Board actions for idea'));
  expect((within(screen.getByLabelText('Board actions for idea').parentElement!).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect(says()).toEqual(['/close ' + a]);
});
