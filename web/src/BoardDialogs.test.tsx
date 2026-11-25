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
const name = '2026-11-01-live';
const room = { folder: '/room', active: `discussions/${name}`, discussion: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [], closedDiscussions: [], checkpoints: [], closingDiscussions: {}, open: [], autoDev: { status: null } };
const mergePreview = { name, branch: `worker/${name}`, targetBranch: 'main', title: `Merge worker/${name} into main`, path: '/fixture', commits: [{ hash: 'abc123', subject: 'change' }], untracked: ['local.txt'], activeNotice: 'Other branches may need catch-up.', snapshot: 's1' };
const discardPreview = { name, branch: `worker/${name}`, path: '/fixture', worktreeExists: true, branchExists: true, commits: [{ hash: 'abc123', subject: 'change' }], tracked: [{ status: 'M', path: 'file' }], untracked: ['new.txt'], ignored: [{ label: 'cache/' }], snapshot: 'd1' };
const fetchMock = vi.fn();
const respond = (data: unknown, ok = true) => ({ ok, text: async () => String(data), json: async () => data });
const setup = (extra: object = {}, info: object = { lines: [], mergeable: { [name]: { canMerge: true, catchUp: false, targetBranch: 'main' } }, discardable: [name] }) => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages: [], input: true, peek: null, doc: null, workerInfo: info }); };
const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(init.body));
const openActions = async () => userEvent.setup().click(screen.getByLabelText('Discussion actions'));
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({})); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows merge and discard only when available and gives blocked reason', async () => {
  setup({}, { lines: [], mergeable: { [name]: { canMerge: false, catchUp: false, disabledReason: 'Dirty worktree', targetBranch: 'main' } }, discardable: [name] });
  await openActions(); const disabled = screen.getByRole('button', { name: 'Close and Merge' }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true); expect(disabled.title).toBe('Dirty worktree'); expect(screen.getByRole('button', { name: 'Close and Discard' })).toBeTruthy();
  Source.current.send({ type: 'workerinfo', info: { lines: [], mergeable: {}, discardable: [] } });
  expect(screen.queryByRole('button', { name: 'Close and Merge' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Close and Discard' })).toBeNull();
});

it('previews a merge, rechecks the snapshot and requires another confirmation when it changes', async () => {
  setup(); fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '__merge') { const body = JSON.parse(String(init?.body)); return respond(!body.snapshot ? { preview: mergePreview } : body.snapshot === 's1' ? { changed: true, preview: { ...mergePreview, snapshot: 's2', commits: [{ hash: 'def456', subject: 'new change' }] } } : { ok: true }); }
    return url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({});
  });
  const user = userEvent.setup(); await openActions(); await user.click(screen.getByRole('button', { name: 'Close and Merge' }));
  let dialog = await screen.findByRole('dialog'); expect(within(dialog).getByText('abc123 change')).toBeTruthy();
  expect(within(dialog).getByText(/local.txt/)).toBeTruthy(); expect(within(dialog).getByText('Other branches may need catch-up.')).toBeTruthy(); expect(calls('__merge')).toEqual([{ name }]);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm ' + mergePreview.title }));
  dialog = await screen.findByRole('dialog'); expect(within(dialog).getByText(/changed since your first click/)).toBeTruthy(); expect(within(dialog).getByText('def456 new change')).toBeTruthy();
  expect(calls('__merge')).toEqual([{ name }, { name, snapshot: 's1' }]);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm ' + mergePreview.title }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(calls('__merge')[2]).toEqual({ name, snapshot: 's2' });
});

it('previews discard from a row and rechecks all changed contents before confirmation', async () => {
  setup(); fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '__discard') { const body = JSON.parse(String(init?.body)); return respond(!body.snapshot ? { preview: discardPreview } : body.snapshot === 'd1' ? { changed: true, preview: { ...discardPreview, snapshot: 'd2', untracked: ['later.txt'] } } : { ok: true }); }
    return url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({});
  });
  const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for Live')); await user.click(within(screen.getByLabelText('Board actions for Live').parentElement!).getByRole('button', { name: 'Close and Discard' }));
  let dialog = await screen.findByRole('dialog'); for (const text of ['abc123 change', 'M file', 'new.txt', 'cache/']) expect(within(dialog).getByText(text)).toBeTruthy();
  expect(within(dialog).getByText(/refs\/discarded/)).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Confirm Close and Discard' })); dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/changed since your first click/)).toBeTruthy(); expect(within(dialog).getByText('later.txt')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Confirm Close and Discard' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(calls('__discard')).toEqual([{ name }, { name, snapshot: 'd1' }, { name, snapshot: 'd2' }]);
});

it('queues catch-up directly without a preview or confirmation', async () => {
  setup({}, { lines: [], mergeable: { [name]: { canMerge: false, catchUp: true, targetBranch: 'main' } } });
  fetchMock.mockImplementation(async (url: string) => url === '__catchup' ? respond({ ok: true, targetBranch: 'main' }) : respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }));
  const user = userEvent.setup(); await openActions(); await user.click(screen.getByRole('button', { name: 'Catch up with main' }));
  await waitFor(() => expect(calls('__catchup')).toEqual([{ name }]));
  expect(calls('__merge')).toHaveLength(0); expect(screen.queryByRole('dialog')).toBeNull();
  expect(await screen.findByText(/Queued catch-up with main/)).toBeTruthy();
});

it('shows refusal and partial failure text and refreshes worker info for each failed action', async () => {
  setup(); let fail = '__merge';
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === fail) { if (url === '__discard' && !JSON.parse(String(init?.body)).snapshot) return respond({ preview: discardPreview }); return respond('Stopped. Done: saved ref. Not done: worktree.', false); }
    return url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({});
  });
  const user = userEvent.setup(); await openActions(); const baseline = calls('__workerinfo').length;
  await user.click(screen.getByRole('button', { name: 'Close and Merge' })); expect(await screen.findByText('Stopped. Done: saved ref. Not done: worktree.')).toBeTruthy();
  await waitFor(() => expect(calls('__workerinfo').length).toBe(baseline + 1));
  fail = '__discard'; await openActions(); await user.click(screen.getByRole('button', { name: 'Close and Discard' })); const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm Close and Discard' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Stopped. Done: saved ref. Not done: worktree.');
  await waitFor(() => expect(calls('__workerinfo').length).toBeGreaterThanOrEqual(baseline + 3));
});

it('cancels waiting Close and reports refusal without modifying a checkout', async () => {
  setup({ closingDiscussions: { [name]: 'waiting' } }); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Cancel close' })); expect(calls('__cancelclose')).toEqual([{ name }]);
  fetchMock.mockImplementation(async (url: string) => url === '__cancelclose' ? respond('Close is no longer waiting for the worker.', false) : respond({}));
  await user.click(screen.getByRole('button', { name: 'Cancel close' })); expect(await screen.findByText('Close is no longer waiting for the worker.')).toBeTruthy();
});

it.each(['__merge', '__discard'] as const)('refreshes worker info when %s preview is refused', async (failed) => {
  setup(); fetchMock.mockImplementation(async (url: string) => url === failed ? respond('Preview refused', false) : url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({}));
  const user = userEvent.setup(); await openActions(); const before = calls('__workerinfo').length;
  await user.click(screen.getByRole('button', { name: failed === '__merge' ? 'Close and Merge' : 'Close and Discard' }));
  expect(await screen.findByText('Preview refused')).toBeTruthy(); await waitFor(() => expect(calls('__workerinfo').length).toBe(before + 1));
});

it('keeps a failed merge confirmation open and refreshes worker information', async () => {
  setup(); fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === '__merge' ? JSON.parse(String(init?.body)).snapshot ? respond('Merge stopped after partial work', false) : respond({ preview: mergePreview }) : url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({}));
  const user = userEvent.setup(); await openActions(); const before = calls('__workerinfo').length;
  await user.click(screen.getByRole('button', { name: 'Close and Merge' })); const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('s1')).toBeTruthy(); expect(within(dialog).getByText('Worktree: /fixture')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Confirm ' + mergePreview.title }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Merge stopped after partial work');
  await waitFor(() => expect(calls('__workerinfo').length).toBe(before + 1));
});

it('refreshes worker information when direct catch-up is refused', async () => {
  setup({}, { lines: [], mergeable: { [name]: { canMerge: false, catchUp: true, targetBranch: 'main' } } });
  fetchMock.mockImplementation(async (url: string) => url === '__catchup' ? respond('Catch up refused', false) : url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({}));
  const user = userEvent.setup(); await openActions(); const before = calls('__workerinfo').length;
  await user.click(screen.getByRole('button', { name: 'Catch up with main' }));
  expect(await screen.findByText('Catch up refused')).toBeTruthy(); expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(calls('__workerinfo').length).toBe(before + 1));
});

it('cancels a preview without confirming the operation', async () => {
  setup(); fetchMock.mockImplementation(async (url: string) => url === '__discard' ? respond({ preview: discardPreview }) : url === '__files?detail=1' ? respond({ files: [`discussions/${name}/notes.md`], unviewable: [], branch: null }) : respond({}));
  const user = userEvent.setup(); await openActions(); await user.click(screen.getByRole('button', { name: 'Close and Discard' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(calls('__discard')).toEqual([{ name }]); expect(screen.queryByRole('dialog')).toBeNull();
});
