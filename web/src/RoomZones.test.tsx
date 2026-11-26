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
const room = { folder: '/Users/me/projects/my-room/', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, brainstorm: false, research: false, workbench: false, open: [] as object[], code: null as object | null };
const reply = (status: number, text = '') => ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => ({}) });
const health = (pid: number) => ({ ok: true, status: 200, json: async () => ({ app: 'agent-room', pid, root: '/r', startedAt: new Date(Date.now() - 65 * 60000).toISOString(), discussion: null, pages: 1 }) });
let answer: (url: string, init?: RequestInit) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, init));
const posts = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(String(init?.body)));
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, workInput: true, ...extra });
beforeEach(() => { answer = (url) => url === '__health' ? new Promise(() => {}) : reply(204); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('names the room menu after its folder, and quits, reloads and restarts with the legacy clicks', async () => {
  render(<App version="one" refresh={() => {}} />); reset();
  const zone = screen.getByLabelText('Room'), user = userEvent.setup();
  expect(within(zone).getByText('my-room')).toBeTruthy();
  await user.click(within(zone).getByRole('button', { name: 'Quit room' })); expect(posts('__say')).toEqual([]);
  await user.click(within(zone).getByRole('button', { name: 'Click again to quit this room' }));
  expect(posts('__say')).toEqual([{ text: '/quit' }]);
  await user.click(within(zone).getByRole('button', { name: 'Reload' })); expect(posts('__say').at(-1)).toEqual({ text: '/reload' });
  answer = (url, init) => url === '__health' ? new Promise(() => {}) : JSON.parse(String(init?.body)).confirmed ? reply(204) : reply(409, 'Rooms still running: alpha (round), beta (worker instruction). Restart anyway?');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  await user.click(within(zone).getByRole('button', { name: 'Restart' }));
  await user.click(within(zone).getByRole('button', { name: 'Click again: the chat clears' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('Rooms still running: alpha (round), beta (worker instruction). Restart anyway?'));
  expect(posts('__say').at(-1)).toEqual({ text: '/restart' }); // cancelled: not sent again
  await user.click(within(zone).getByRole('button', { name: 'Restart' })); await user.click(within(zone).getByRole('button', { name: 'Click again: the chat clears' }));
  await waitFor(() => expect(posts('__say').at(-1)).toEqual({ text: '/restart', confirmed: true }));
});

it('expires an armed Quit room after three seconds', () => {
  vi.useFakeTimers(); render(<App version="one" refresh={() => {}} />); reset();
  fireEvent.click(screen.getByRole('button', { name: 'Quit room' }));
  expect(screen.getByRole('button', { name: 'Click again to quit this room' })).toBeTruthy();
  act(() => vi.advanceTimersByTime(3000)); expect(screen.getByRole('button', { name: 'Quit room' })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(0);
});

it('shuts the server down at its own address, asking again when rooms are still running', async () => {
  const urls: string[] = [];
  answer = (url) => { urls.push(url); return url === '__health' ? new Promise(() => {}) : url === '/__shutdown' ? reply(409, 'alpha is running a round. Shut down anyway?') : reply(500, 'Shutdown failed'); };
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Shutdown server' })); expect(urls).not.toContain('/__shutdown');
  await user.click(screen.getByRole('button', { name: 'Click again: every room ends' }));
  await waitFor(() => expect(urls).toContain('/__shutdown?confirmed=yes'));
  expect(confirm).toHaveBeenCalledWith('alpha is running a round. Shut down anyway?');
  const call = fetchMock.mock.calls.find(([url]) => url === '/__shutdown')!;
  expect((call[1]?.headers as Record<string, string>)['content-type']).toBe('application/json');
  expect(await within(screen.getByRole('log', { name: 'System messages' })).findByText('Shutdown failed')).toBeTruthy();
});

it('shows the heartbeat every three seconds, refreshes for a new server, and says why the server is down', async () => {
  vi.useFakeTimers(); let next: unknown = health(10); answer = (url) => url === '__health' ? (next === 'offline' ? Promise.reject(new Error('down')) : next) : reply(204);
  const refresh = vi.fn(); render(<App version="one" refresh={refresh} />);
  reset({ room: { ...room, code: { path: '/src/agent-room', branch: 'main', commit: 'abc1234', dirty: true, startedAt: '2026-11-25T08:00:00Z' } } });
  const detail = screen.getByLabelText('Server state');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(detail.textContent).toMatch(/^Server up 1h 5m · port \d*abc1234\+ · started /);
  expect(document.querySelector('.server')?.getAttribute('data-state')).toBe('up');
  expect(fetchMock).toHaveBeenCalledWith('__health', expect.objectContaining({ cache: 'no-store' }));
  next = reply(404); await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(detail.textContent).toContain('This room is not open on the server');
  expect(document.querySelector('.server')?.getAttribute('data-state')).toBe('down');
  next = 'offline'; await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(detail.textContent).toContain('Server not responding');
  Source.current.send({ type: 'restarting' }); await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(detail.textContent).toContain('Restarting the server…');
  expect(refresh).not.toHaveBeenCalled();
  next = health(11); await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([url]) => url === '__health')).toHaveLength(5);
});

it('shows the quota gauges with their windows, thresholds, tooltips and updated time', () => {
  render(<App version="one" refresh={() => {}} />);
  reset({ quota: [{ provider: 'claude', label: '5h', used: 75, resets: '13:00' }, { provider: 'claude', label: 'week', used: 95, resets: 'Mon 09:00' }, { provider: 'codex', label: '5h', used: 10, resets: null }],
    quotaAt: { measured: new Date().toLocaleDateString('sv') + ' 08:11:00', providers: { claude: new Date().toLocaleDateString('sv') + ' 08:11:00' }, checked: new Date().toISOString() }, monitor: { claude: { login: { state: 'ok', expiresAt: null }, running: 2, leftovers: [], inRoom: true } } });
  const usage = screen.getByLabelText('Subscription usage');
  expect(within(usage).getByText(/^\d+m old$/).title).toMatch(/^Reading at .* 08:11:00\. The room last checked at/);
  const gauges = usage.querySelectorAll('.gauge');
  expect([...gauges].map((g) => g.className)).toEqual(['gauge warn', 'gauge high', 'gauge']);
  expect(gauges[1].firstElementChild?.textContent).toBe('wk');
  expect((gauges[0].querySelector('.bar i') as HTMLElement).style.width).toBe('75%');
  expect(gauges[0].querySelector('[role=tooltip]')?.textContent).toBe('Resets at 13:00claude 5h: 75% used');
  expect(gauges[1].querySelector('[role=tooltip]')?.textContent).toBe('claude week: 95% used, at Mon 09:00');
  expect(within(usage).getByText('2 running')).toBeTruthy();
  Source.current.send({ type: 'quota', gauges: null, at: { measured: null, checked: new Date().toISOString() } });
  expect(usage.textContent).toMatch(/^quota meter not reachable · checked /);
});

it('warns about provider health with a red or amber mark and its problems, also without gauges', () => {
  render(<App version="one" refresh={() => {}} />);
  reset({ quota: [{ provider: 'claude', label: '5h', used: 5, resets: null }], quotaAt: null,
    monitor: { claude: { login: { state: 'out' }, running: 0, leftovers: [], inRoom: true },
      codex: { login: { state: 'ok', expiresAt: null }, running: 0, inRoom: false, leftovers: [{ pid: 42, agent: 'Bo', room: '/r/x', started: new Date().toISOString(), provider: 'codex' }, { pid: 43, agent: 'Cy', room: '/r/x', started: new Date().toISOString(), provider: 'codex', unverified: true }] } } });
  const usage = screen.getByLabelText('Subscription usage');
  const [claude, codex] = [...usage.querySelectorAll('.quota b')];
  expect(claude.querySelector('.alert')?.className).toBe('alert red');
  expect([...claude.querySelectorAll('[role=tooltip] > span')].map((l) => l.textContent)).toEqual(['Problem: logged out', 'State: logged out', '0 running now in this room']);
  expect(codex.querySelector('.alert')?.className).toBe('alert'); // a provider with no gauges appears only for its warning
  const lines = [...codex.querySelectorAll('[role=tooltip] > span')].map((l) => l.textContent);
  expect(lines[0]).toBe('Problem: 2 programs left over (alive after a crash or Restart)');
  expect(lines[2]).toBe('stop it: kill -TERM -42'); expect(lines[4]).toMatch(/Look at it: ps -g 43$/);
  Source.current.send({ type: 'monitor', monitor: { claude: { login: { state: 'ok', expiresAt: null }, running: 1, leftovers: [], inRoom: true } } });
  expect(usage.querySelector('.alert')).toBeNull(); expect(usage.textContent).not.toContain('codex');
});

it('keeps the Worker chat where it was when switching tabs', () => {
  const sizes = { scrollHeight: 800, clientHeight: 200 };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.scrollHeight : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.clientHeight : 0; });
  render(<App version="one" refresh={() => {}} />); reset({ worker: [{ speaker: 'Worker', html: '<p>old report</p>', error: false }] });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  let chat = screen.getByText('old report').closest('.chat') as HTMLElement;
  chat.scrollTop = 150; fireEvent.scroll(chat);
  fireEvent.click(screen.getByRole('tab', { name: 'Discussion' }));
  Source.current.send({ type: 'work', message: { speaker: 'Worker', html: '<p>new report</p>', error: false } });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  chat = screen.getByText('old report').closest('.chat') as HTMLElement;
  expect(chat.scrollTop).toBe(150); expect((screen.getByLabelText('Scroll to latest worker messages') as HTMLButtonElement).hidden).toBe(false);
  chat.scrollTop = 600; fireEvent.scroll(chat); // at the bottom: it follows while away
  fireEvent.click(screen.getByRole('tab', { name: 'Discussion' })); sizes.scrollHeight = 900;
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  expect((screen.getByText('old report').closest('.chat') as HTMLElement).scrollTop).toBe(900);
});
