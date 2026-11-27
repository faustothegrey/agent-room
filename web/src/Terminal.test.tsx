import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { ghostty, type Ghostty } from './Terminal';
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
// A fake WebSocket and ghostty-web: nothing here starts a shell.
class Socket {
  static OPEN = 1; static all: Socket[] = [];
  readyState = 1; sent: string[] = []; closed = false;
  onmessage: ((e: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { Socket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}
const terms: { written: string[]; disposed: boolean; data?: (d: string) => void; resize?: (s: { cols: number; rows: number }) => void; focus: ReturnType<typeof vi.fn<() => void>> }[] = [];
const fits: { fit: ReturnType<typeof vi.fn<() => void>> }[] = [];
const fake: Ghostty = {
  init: async () => {},
  Terminal: class { cols = 80; rows = 24; t = { written: [] as string[], disposed: false, focus: vi.fn() } as (typeof terms)[number];
    constructor() { terms.push(this.t); } loadAddon() {} open(el: HTMLElement) { el.append(Object.assign(document.createElement('canvas'), { className: 'fake-term' })); }
    write(d: string) { this.t.written.push(d); } focus() { this.t.focus(); } dispose() { this.t.disposed = true; }
    onData(cb: (d: string) => void) { this.t.data = cb; } onResize(cb: (s: { cols: number; rows: number }) => void) { this.t.resize = cb; } } as unknown as Ghostty['Terminal'],
  FitAddon: class { f = { fit: vi.fn() }; constructor() { fits.push(this.f); } fit() { this.f.fit(); } observeResize() {} } as unknown as Ghostty['FitAddon'],
};
const room = { folder: '/room', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, open: [], members: [], failedAgents: [] };
let token: () => unknown;
const fetchMock = vi.fn(async (url: string) => url === '__health' ? new Promise(() => {}) : url === '__shell/token' ? token() : { ok: true, status: 200, json: async () => [], text: async () => '' });
const terminalButton = () => screen.getByRole('button', { name: '⌨ Terminal' });
const status = () => within(screen.getByLabelText('Services panel')).getAllByRole('status').at(-1)!;
beforeEach(() => {
  localStorage.clear(); terms.length = 0; fits.length = 0; Socket.all = []; fetchMock.mockClear();
  token = () => ({ ok: true, status: 200, json: async () => ({ token: 'tok' }), text: async () => '' });
  vi.spyOn(ghostty, 'load').mockResolvedValue(fake);
  vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('starts a shell on first open with the token, relays keys and resizes, and keeps it while hidden', async () => {
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true }); const user = userEvent.setup();
  await user.click(terminalButton());
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledWith('__shell/token', { cache: 'no-store' });
  expect(Socket.all[0].url).toBe('ws://' + location.host + location.pathname.replace(/[^/]*$/, '') + '__shell/ws?token=tok&cols=80&rows=24');
  expect(status().textContent).toBe('Shell running in this room’s folder (this computer only)');
  expect(terminalButton().className).toBe('ctrl-btn running');
  expect(screen.getByLabelText('Terminal').querySelector('.fake-term')).toBeTruthy();
  act(() => Socket.all[0].onmessage?.({ data: '$ ' })); expect(terms[0].written).toEqual(['$ ']);
  terms[0].data?.('ls\r'); terms[0].resize?.({ cols: 100, rows: 30 });
  expect(Socket.all[0].sent).toEqual(['ls\r', JSON.stringify({ type: 'resize', cols: 100, rows: 30 })]);
  await user.click(screen.getByRole('button', { name: 'Close services panel' }));
  expect(Socket.all[0].closed).toBe(false); expect(terminalButton().className).toBe('ctrl-btn running');
  const fitted = fits[0].fit.mock.calls.length;
  await user.click(terminalButton());
  expect(Socket.all).toHaveLength(1); expect(fits[0].fit.mock.calls.length).toBe(fitted + 1); expect(terms[0].focus).toHaveBeenCalled(); // refit, not a new shell
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize conversation and side pane' }), { key: 'ArrowRight' });
  expect(fits[0].fit.mock.calls.length).toBe(fitted + 2); // a divider move refits it
});

it('ends the shell, shows the closed socket, and starts a fresh one', async () => {
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true }); const user = userEvent.setup();
  await user.click(terminalButton()); await waitFor(() => expect(Socket.all).toHaveLength(1));
  act(() => Socket.all[0].onclose?.());
  expect(status().textContent).toBe('Shell exited. Click Start shell for a new shell.');
  expect(terms[0].written.at(-1)).toBe('\r\n\x1b[31mConnection closed. Click Start shell for a new shell.\x1b[0m\r\n');
  expect(terminalButton().className).toBe('ctrl-btn');
  await user.click(screen.getByRole('button', { name: 'Start shell' })); await waitFor(() => expect(Socket.all).toHaveLength(2));
  await user.click(screen.getByRole('button', { name: 'End shell' }));
  expect(Socket.all[1].closed).toBe(true); expect(terms[1].disposed).toBe(true);
  expect(status().textContent).toBe('Shell ended. Click Start shell for a new shell.');
  act(() => Socket.all[1].onclose?.()); expect(status().textContent).toBe('Shell ended. Click Start shell for a new shell.'); // an ended shell's late close changes nothing
  expect(screen.getByLabelText('Terminal').childElementCount).toBe(0);
});

it('reports a refused token in the pane and opens no socket', async () => {
  token = () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'Refused: only from this computer.' });
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true }); const user = userEvent.setup();
  await user.click(terminalButton());
  await waitFor(() => expect(terms[0]?.written).toEqual(['\r\nNo terminal: 403 Refused: only from this computer.\r\n']));
  expect(Socket.all).toHaveLength(0); expect(screen.getByRole('button', { name: 'Start shell' })).toBeTruthy();
});

it('cancels a shell ended while it is still loading', async () => {
  let release!: () => void; vi.mocked(ghostty.load).mockReturnValue(new Promise((done) => { release = () => done(fake); }));
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true }); const user = userEvent.setup();
  await user.click(terminalButton()); await user.click(screen.getByRole('button', { name: 'End shell' }));
  await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
  expect(terms).toHaveLength(0); expect(Socket.all).toHaveLength(0); expect(fetchMock).not.toHaveBeenCalledWith('__shell/token', expect.anything());
});

it('offers the Terminal only on a page opened on this computer, and My notes on the LAN too', () => {
  vi.stubGlobal('location', new URL('http://192.168.1.5:8080/r/a/__next'));
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true });
  expect(screen.queryByRole('button', { name: '⌨ Terminal' })).toBeNull(); expect(screen.getByRole('button', { name: '📝 My notes' })).toBeTruthy();
  expect(ghostty.load).not.toHaveBeenCalled();
});
