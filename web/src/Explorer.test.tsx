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
const room = { folder: '/room', active: 'discussions/2026-11-20-live', board: 'Live', started: true };
const closed = { path: 'discussions/archive/2026-10-01-old', name: '2026-10-01-old', title: 'Old' };
const files = ['README.md', 'discussions/README.md', 'discussions/2026-11-20-live/notes.md', 'discussions/2026-11-20-live/drawings/a.svg', 'discussions/2026-11-20-live/archive.zip', 'discussions/archive/2026-10-01-old/folder/old.md', ...Array.from({ length: 11 }, (_, n) => `src/file${n}.js`)];
const fetchMock = vi.fn();
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, messages: [], input: true, peek: null, doc: null, ...extra });
beforeEach(() => {
  localStorage.clear(); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => url === '__files?detail=1' ? { ok: true, json: async () => ({ files, unviewable: ['discussions/2026-11-20-live/archive.zip'], branch: 'main' }) } : { ok: true, text: async () => '', json: async () => files });
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows a nested discussion tree, disables unavailable files, and opens files via __show', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const notes = await screen.findByRole('button', { name: 'notes.md' });
  expect((screen.getByRole('button', { name: "archive.zip · can't be shown here" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByText('drawings/')); expect(screen.getByRole('button', { name: 'a.svg' })).toBeTruthy();
  await user.click(notes); expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__show')![1].body)).toEqual({ file: 'discussions/2026-11-20-live/notes.md' });
  Source.current.send({ type: 'doc', file: 'discussions/2026-11-20-live/notes.md' });
  expect(screen.getByTitle('Document viewer').getAttribute('src')).toBe('discussions/2026-11-20-live/notes.md');
  await user.click(screen.getByRole('button', { name: 'Explorer' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'notes.md' }).getAttribute('aria-current')).toBe('true'));
  expect(screen.getByRole('button', { name: 'Document' }).getAttribute('aria-pressed')).toBe('false');
});

it('shows room checkout without dated boards and lays out long file levels in columns', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await screen.findByRole('button', { name: 'notes.md' }); await user.click(screen.getByRole('button', { name: 'Room checkout' }));
  expect(screen.getByText('room/ · main')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'README.md' })).toHaveLength(2);
  await user.click(screen.getByText('discussions/')); expect(within(screen.getByLabelText('Explorer files')).getAllByRole('button', { name: 'README.md' })).toHaveLength(2);
  expect(screen.queryByText('2026-11-20-live/')).toBeNull(); expect(screen.queryByText('archive/')).toBeNull();
  await user.click(screen.getByText('src/')); expect(screen.getByRole('button', { name: 'file0.js' }).parentElement?.className).toBe('file-columns');
});

it('reveals a nested shown file, keeps the document iframe, and switches tabs', async () => {
  render(<App version="one" refresh={() => {}} />); reset({ doc: 'discussions/2026-11-20-live/drawings/a.svg' }); const user = userEvent.setup();
  const frame = screen.getByTitle('Document viewer');
  await user.click(screen.getByRole('button', { name: 'Explorer' }));
  expect((await screen.findByRole('button', { name: 'a.svg' })).getAttribute('aria-current')).toBe('true');
  expect((screen.getByText('drawings/').parentElement as HTMLDetailsElement).open).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Document' })); expect(screen.getByTitle('Document viewer')).toBe(frame);
});

it('opens Peek tree files locally and returns without re-entering Peek', async () => {
  render(<App version="one" refresh={() => {}} />); reset({ peek: closed }); const user = userEvent.setup();
  const board = screen.getByLabelText('Peeked board files'); await user.click(await within(board).findByText('folder/'));
  await user.click(within(board).getByRole('button', { name: 'old.md' }));
  expect(screen.getByTitle('Document viewer').getAttribute('src')).toBe('discussions/archive/2026-10-01-old/folder/old.md');
  expect(fetchMock.mock.calls.filter(([url]) => url === '__show')).toHaveLength(0);
  await user.click(screen.getByLabelText('Explorer tab')); await user.click(within(board).getByRole('button', { name: 'Back to current' }));
  await waitFor(() => expect(screen.queryByLabelText('Explorer tab')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Explorer' })); expect(screen.queryByLabelText('Explorer tab')).toBeNull();
});

 it('omits an absent checkout branch', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '__files?detail=1' ? { ok: true, json: async () => ({ files, unviewable: [], branch: null }) } : { ok: true, text: async () => '', json: async () => files });
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await screen.findByRole('button', { name: 'notes.md' }); await user.click(screen.getByRole('button', { name: 'Room checkout' }));
  expect(screen.getByText('room/')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Room checkout' }).getAttribute('title')).toBeNull();
 });
