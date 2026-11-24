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
const room = { discussion: 'Live', active: 'discussions/live', started: true };
const peek = { name: 'closed', title: 'Closed', path: 'discussions/closed', kind: 'discussion' };
const fetchMock = vi.fn();
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', input: true, room, messages: [], doc: null, peek: null, ...extra });
const frame = () => screen.getByTitle('Document viewer') as HTMLIFrameElement;
beforeEach(() => {
  fetchMock.mockReset(); localStorage.clear();
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '1', json: async () => url.includes('detail=1') ? { files: ['discussions/closed/other file.svg'], unviewable: [] } : ['discussions/live/notes.md'] }));
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('opens reset and doc selections in the room-relative viewer and removes it when cleared', () => {
  render(<App version="one" refresh={() => {}} />);
  reset({ doc: 'discussions/live/a #1.md' });
  expect(frame().getAttribute('src')).toBe('discussions/live/a%20%231.md');
  Source.current.send({ type: 'doc', file: 'drawings/chart.svg' });
  expect(frame().getAttribute('src')).toBe('drawings/chart.svg');
  Source.current.send({ type: 'doc', file: null });
  expect(screen.queryByTitle('Document viewer')).toBeNull();
});

it('opens a mentioned file after the show event and a Peek file without changing the room document', async () => {
  render(<App version="one" refresh={() => {}} />); reset();
  Source.current.send({ type: 'message', message: { speaker: 'Ada', html: '<p>notes.md</p>' } });
  await userEvent.setup().click(await screen.findByRole('button', { name: '📄 Show notes.md' }));
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__show')![1].body)).toEqual({ file: 'discussions/live/notes.md' });
  Source.current.send({ type: 'doc', file: 'discussions/live/notes.md' });
  expect(frame().getAttribute('src')).toBe('discussions/live/notes.md');
  reset({ peek, doc: null });
  const files = screen.getByLabelText('Peeked board files');
  await userEvent.setup().click(await within(files).findByRole('button', { name: 'other file.svg' }));
  expect(frame().getAttribute('src')).toBe('discussions/closed/other%20file.svg');
  expect(fetchMock.mock.calls.filter(([url]) => url === '__show')).toHaveLength(1);
});

it('polls non-Markdown documents every two seconds and reloads only on a changed available stamp', async () => {
  vi.useFakeTimers();
  let time = '1'; fetchMock.mockImplementation(async () => ({ text: async () => time }));
  render(<App version="one" refresh={() => {}} />); reset({ doc: 'drawing.svg' });
  const reload = vi.fn(); Object.defineProperty(frame(), 'contentWindow', { value: { location: { reload } }, configurable: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledWith('__mtime?f=drawing.svg', { cache: 'no-store' }); expect(reload).not.toHaveBeenCalled();
  time = 'false'; await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(reload).not.toHaveBeenCalled();
  time = '2'; await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(reload).toHaveBeenCalledOnce();
  Source.current.send({ type: 'doc', file: 'notes.md' }); fetchMock.mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(fetchMock).not.toHaveBeenCalled();
  Source.current.send({ type: 'doc', file: '__received/a/b/c/file.svg' });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(fetchMock).not.toHaveBeenCalled();
  reset({ doc: 'drawing.svg', viewing: {} });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(fetchMock).not.toHaveBeenCalled();
});

it('ignores an obsolete mtime response after changing documents', async () => {
  vi.useFakeTimers(); let resolve!: (value: { text: () => Promise<string> }) => void;
  fetchMock.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<App version="one" refresh={() => {}} />); reset({ doc: 'old.svg' });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  Source.current.send({ type: 'doc', file: 'new.svg' });
  const reload = vi.fn(); Object.defineProperty(frame(), 'contentWindow', { value: { location: { reload } }, configurable: true });
  await act(async () => { resolve({ text: async () => '2' }); });
  expect(reload).not.toHaveBeenCalled();
});
