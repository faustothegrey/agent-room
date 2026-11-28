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
const live = '2026-11-01-live', closed = '2026-11-02-closed', idea = '2026-11-03-idea', research = '2026-11-04-study', archived = '2026-10-01-old';
const files = [`discussions/${live}/notes.md`, `discussions/${closed}/notes.md`, `brainstorms/${idea}/notes.md`, `discussions/${research}/notes.md`, `discussions/archive/${archived}/notes.md`];
const room = { folder: '/room', active: `discussions/${live}`, board: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [research], closedBoards: [closed, research, archived], checkpoints: [], open: [], rollbacks: [], autoDev: { status: null } };
const fetchMock = vi.fn();
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
const menu = (name: string) => screen.getByLabelText(`Board actions for ${name}`).parentElement!;
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages: [], input: true, peek: null, doc: null });
const setup = (extra: object = {}) => { render(<App version="one" refresh={() => {}} />); reset(extra); };
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files, unviewable: [], branch: null } : [] })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('requires confirmation for Start fresh and sends the correct discussion and brainstorm references', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  await user.click(within(menu('closed')).getByRole('button', { name: 'Start fresh' })); expect(says()).toEqual([]);
  await user.click(within(menu('closed')).getByRole('button', { name: 'Click again: its saved sessions and chat are discarded; it starts from its handoff' }));
  await waitFor(() => expect(says()).toEqual(['/fresh ' + closed]));
  await user.click(screen.getByLabelText('Board actions for idea')); await user.click(within(menu('idea')).getByRole('button', { name: 'Start fresh' }));
  await user.click(within(menu('idea')).getByRole('button', { name: 'Click again: its saved sessions and chat are discarded' }));
  await waitFor(() => expect(says()).toContain('/fresh brainstorms/' + idea));
});

it('confirms Delete, refuses deletion of an open board, and uses board-kind references', async () => {
  setup({ open: [{ active: `brainstorms/${idea}`, current: false, title: 'idea', url: '/r/other/__room', started: true }] });
  const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for idea'));
  const disabled = within(menu('idea')).getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true); expect(disabled.title).toBe('Close this brainstorm before deleting it');
  Source.current.send({ type: 'room', room });
  await user.click(within(menu('idea')).getByRole('button', { name: 'Delete' })); expect(says()).toEqual([]);
  await user.click(within(menu('idea')).getByRole('button', { name: 'Click again: its folder (transcripts, drawings) and checkpoint are removed; uncommitted files are lost for good' }));
  await waitFor(() => expect(says()).toContain('/delete brainstorms/' + idea));
  await user.click(screen.getByLabelText('Board actions for study')); await user.click(within(menu('study')).getByRole('button', { name: 'Delete' }));
  await user.click(within(menu('study')).getByRole('button', { name: 'Click again: its folder and checkpoint are removed; uncommitted files are lost for good' }));
  await waitFor(() => expect(says()).toContain('/delete ' + research));
});

it('requires separate confirmations for both brainstorm conversions and research conversion', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for idea'));
  await user.click(within(menu('idea')).getByRole('button', { name: 'Turn into a sprint' })); expect(says()).toEqual([]);
  await user.click(within(menu('idea')).getByRole('button', { name: 'Click again: it moves to discussions/' }));
  await waitFor(() => expect(says()).toContain('/convert brainstorms/' + idea));
  await user.click(screen.getByLabelText('Board actions for idea')); await user.click(within(menu('idea')).getByRole('button', { name: 'Turn into research' }));
  await user.click(within(menu('idea')).getByRole('button', { name: 'Click again: it moves to discussions/ as a research board' }));
  await waitFor(() => expect(says()).toContain('/convert brainstorms/' + idea + ' research'));
  await user.click(screen.getByLabelText('Board actions for study')); await user.click(within(menu('study')).getByRole('button', { name: 'Turn into a sprint' }));
  await user.click(within(menu('study')).getByRole('button', { name: 'Click again: research sessions end and scheduled tasks turn off' }));
  await waitFor(() => expect(says()).toContain('/convert discussions/' + research));
});

it('queues rollback separately, shows its report, and requires ready, closed and two clicks to archive', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  await user.click(within(menu('closed')).getByRole('button', { name: 'Archive with rollback' })); expect(says()).toEqual([]);
  await user.click(within(menu('closed')).getByRole('button', { name: 'Click again: queue rollback of this sprint’s implementation' }));
  await waitFor(() => expect(says()).toContain('/rollback ' + closed));
  Source.current.send({ type: 'room', room: { ...room, rollbacks: [{ name: closed, status: 'running', report: 'In progress' }] } });
  expect((within(menu('closed')).getByRole('button', { name: 'Rollback running' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Rollback report · running')).toBeTruthy(); expect(within(menu('closed')).queryByRole('button', { name: 'Confirm archive after rollback' })).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, rollbacks: [{ name: closed, status: 'ready', report: 'Reviewed report' }] } });
  await user.click(within(menu('closed')).getByRole('button', { name: 'Confirm archive after rollback' }));
  expect(says()).not.toContain('/archive-rollback ' + closed);
  await user.click(within(menu('closed')).getByRole('button', { name: 'Click again: I reviewed the rollback report; archive' }));
  await waitFor(() => expect(says()).toContain('/archive-rollback ' + closed));
  Source.current.send({ type: 'room', room: { ...room, closedBoards: [], rollbacks: [{ name: closed, status: 'ready', report: 'Reviewed report' }] } });
  expect((within(menu('closed')).getByRole('button', { name: 'Confirm archive after rollback' }) as HTMLButtonElement).disabled).toBe(true);
});

it('uses legacy resume and Peek tooltips and expires row confirmations', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  expect(within(menu('closed')).getByRole('button', { name: 'Resume' }).title).toBe('Reopen from its closing statement (or pending handoff) with new agent and worker sessions.');
  expect(within(menu('closed')).getByRole('button', { name: 'Peek chat & files' }).title).toBe('Look at this closed sprint read-only: its conversation and files, without reopening it.');
  vi.useFakeTimers(); fireEvent.click(within(menu('closed')).getByRole('button', { name: 'Start fresh' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(within(menu('closed')).getByRole('button', { name: 'Start fresh' })).toBeTruthy(); expect(says()).toEqual([]);
});

it('uses archived rollback references and does not permit confirming archive for an active board', async () => {
  setup({ closedBoards: [live, closed, research, archived], rollbacks: [{ name: live, status: 'ready', report: 'Active report' }, { name: archived, status: 'ready', report: 'Archived report' }] });
  const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for Live'));
  expect((within(menu('Live')).getByRole('button', { name: 'Confirm archive after rollback' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByText('Archived · Deferred (1)')); await user.click(screen.getByLabelText('Board actions for old'));
  await user.click(within(menu('old')).getByRole('button', { name: 'Archive with rollback' }));
  await user.click(within(menu('old')).getByRole('button', { name: 'Click again: queue rollback of this sprint’s implementation' }));
  await waitFor(() => expect(says()).toContain('/rollback archive/' + archived));
});
