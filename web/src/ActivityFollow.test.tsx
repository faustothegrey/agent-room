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
const room = { discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, brainstorm: false, research: false, workbench: false, open: [] as object[] };
const msg = (speaker: string, text: string) => ({ speaker, html: `<p>${text}</p>`, error: false });
const log = () => screen.getByRole('log', { name: 'System messages' });
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as unknown as { mermaid?: unknown }).mermaid; });

it('shows worker notes and errors in System messages with the Worker prefix, keeping the last two lines', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], worker: [msg('Worker', 'Report'), { note: 'Marker' }], input: true, workInput: true });
  expect(within(log()).getByText('Worker · Marker').className).toBe('status');
  Source.current.send({ type: 'work', message: { note: 'Task failed', error: true } });
  expect(within(log()).getByText('Worker · Task failed').className).toBe('status error');
  Source.current.send({ type: 'note', text: 'Room note' });
  expect(within(log()).queryByText('Worker · Marker')).toBeNull(); expect(within(log()).getAllByRole('paragraph')).toHaveLength(2);
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  const chat = screen.getByRole('region', { name: 'Worker conversation' });
  expect(within(chat).queryByText(/Marker|Task failed/)).toBeNull(); expect(within(chat).getByText('Report')).toBeTruthy();
  expect(within(log()).getByText('Room note')).toBeTruthy(); // Activity stays visible on the Worker tab
});

it('keeps the worker hint after a reset that had only notes hidden, and shows it on an empty one', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  expect(screen.getByText(/Give the worker instructions here/)).toBeTruthy();
  Source.current.send({ type: 'work', message: msg('Worker', 'First report') });
  expect(screen.getByText(/Give the worker instructions here/)).toBeTruthy(); // as on /__room, it stays until the next reset
  Source.current.send({ type: 'reset', room, messages: [], worker: [{ note: 'Only a note' }], input: true });
  expect(screen.queryByText(/Give the worker instructions here/)).toBeNull();
});

it('reports stop and send failures as Worker errors without flashing the busy bar', async () => {
  const fetchMock = vi.fn(async (url: string) => url === '__stopworker' ? { ok: false, text: async () => 'Nothing to stop' } : url === '__work' ? { ok: false, text: async () => 'Queue full' } : { ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetchMock); render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, workerStop: { after: false, now: false } }, messages: [], worker: [], input: true, workInput: true });
  const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: /Worker/ }));
  await user.click(screen.getByRole('button', { name: 'Stop now' })); await user.click(screen.getByRole('button', { name: 'Click again: stop now; partial edits may be left' }));
  await waitFor(() => expect(within(log()).getByText('Worker · Nothing to stop').className).toBe('status error'));
  await user.type(screen.getByRole('textbox', { name: 'Instruction to the worker' }), 'Do it{Enter}');
  await waitFor(() => expect(within(log()).getByText('Worker · Queue full')).toBeTruthy());
  expect(screen.queryByText('Action failed')).toBeNull();
});

it('lists busy workers by board title in the Activity area', () => {
  render(<App version="one" refresh={() => {}} />);
  const open = [{ url: '/r/a/', active: 'discussions/2026-11-20-alpha-work', title: '2026-11-20-alpha-work', working: true }, { url: '/r/b/', active: 'discussions/2026-11-21-beta', title: 'Beta board', working: true }, { url: '/r/c/', active: 'discussions/2026-11-22-idle', title: 'Idle', working: false }];
  Source.current.send({ type: 'reset', room: { ...room, open }, messages: [], worker: [], input: true });
  const zone = screen.getByLabelText('Activity');
  expect(within(zone).getByText(/alpha work · Worker is working/)).toBeTruthy(); expect(within(zone).getByText(/Beta board · Worker is working/)).toBeTruthy();
  expect(within(zone).queryByText(/Idle/)).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, open: [] } }); expect(within(zone).queryByText(/Worker is working/)).toBeNull();
});

it('shows the worker info line: lines, disabled in red, brainstorm override and read-only peek', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, workInput: true, workerInfo: { lines: ['Worktree: /tmp/w', 'Merge preview of worker/x into main (abc123): would conflict in a.txt, b.txt.'] } });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  const info = () => screen.getByLabelText('Worker info');
  expect(within(info()).getByText('Worktree: /tmp/w').className).toBe('');
  expect(within(info()).getByText('Merge preview of worker/x into main: would conflict in 2 files')).toBeTruthy();
  expect(within(info()).getByText('would conflict in a.txt, b.txt. (abc123)')).toBeTruthy();
  Source.current.send({ type: 'workerinfo', info: { lines: ['The worker is disabled.'], disabled: true } });
  expect(within(info()).getByText('The worker is disabled.').className).toBe('error');
  Source.current.send({ type: 'room', room: { ...room, brainstorm: true } });
  expect(within(info()).getByText('Turn this brainstorm into a discussion to send work.').className).toBe('error');
  Source.current.send({ type: 'reset', room: { ...room, brainstorm: true }, messages: [], worker: [], input: true, workInput: true, workerInfo: { lines: ['Peeked worktree'] }, peek: { name: 'old', kind: 'discussion', path: 'discussions/old', title: 'Old' } });
  expect(within(info()).getByText('Peeked worktree')).toBeTruthy();
});

it('shows lanes collapsed and draws a branch diagram only when its lane opens', async () => {
  const render2 = vi.fn(async () => ({ svg: '<svg data-testid="diagram"></svg>' }));
  (window as unknown as { mermaid: unknown }).mermaid = { initialize: vi.fn(), render: render2 };
  render(<App version="one" refresh={() => {}} />);
  const lanes = [{ summary: 'worker/a · 2 commits', lines: ['Branch a line'], diagram: { graph: 'gitGraph\n commit' } }, { summary: 'worker/b · clean', lines: [], diagram: { note: 'worker/b is the room\'s current branch.' } }];
  Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, workInput: true, workerInfo: { lines: [], lanes } });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  const lane = screen.getByText('worker/a · 2 commits').closest('details')!;
  expect(lane.open).toBe(false); expect(render2).not.toHaveBeenCalled();
  expect(screen.getByText('worker/b is the room\'s current branch.')).toBeTruthy();
  lane.open = true; fireEvent(lane, new Event('toggle'));
  expect(await screen.findByTestId('diagram')).toBeTruthy(); expect(render2).toHaveBeenCalledWith(expect.stringMatching(/^wgit-/), 'gitGraph\n commit');
  Source.current.send({ type: 'workerinfo', info: { lines: [], lanes: [{ ...lanes[0], lines: ['Branch a changed'] }] } });
  expect(screen.getByText('worker/a · 2 commits').closest('details')!.open).toBe(true); // the open lane stays open
});

it('follows new messages at the bottom, offers the end button when scrolled up, and sticks again on reset', async () => {
  const sizes = { scrollHeight: 1000, clientHeight: 200 };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.scrollHeight : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.clientHeight : 0; });
  const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [msg('Ada', 'one')], worker: [], input: true });
  const chat = screen.getByText('one').closest('.chat') as HTMLElement;
  expect(chat.scrollTop).toBe(1000);
  const end = screen.getByLabelText('Scroll to latest discussion messages') as HTMLButtonElement;
  expect(end.hidden).toBe(true);
  sizes.scrollHeight = 1200; Source.current.send({ type: 'message', message: msg('Bo', 'two') });
  expect(chat.scrollTop).toBe(1200); // at the bottom: it follows
  chat.scrollTop = 100; fireEvent.scroll(chat); expect(end.hidden).toBe(false);
  sizes.scrollHeight = 1400; Source.current.send({ type: 'message', message: msg('Ada', 'three') });
  expect(chat.scrollTop).toBe(100); expect(end.hidden).toBe(false); // scrolled up: it stays
  Source.current.send({ type: 'thinking', name: 'Bo' }); expect(chat.scrollTop).toBe(100);
  fireEvent.click(end); expect(scrollTo).toHaveBeenCalledWith({ top: 1400, behavior: 'smooth' });
  fireEvent.scroll(chat); expect(end.hidden).toBe(true);
  chat.scrollTop = 0; fireEvent.scroll(chat);
  Source.current.send({ type: 'reset', room, messages: [msg('Ada', 'fresh')], worker: [], input: true });
  expect(chat.scrollTop).toBe(1400); // a reset starts at the bottom again
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

it('gives the Worker chat its own follow and end button', () => {
  const sizes = { scrollHeight: 800, clientHeight: 200 };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.scrollHeight : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat') ? sizes.clientHeight : 0; });
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], worker: [msg('Worker', 'old report')], input: true });
  fireEvent.click(screen.getByRole('tab', { name: /Worker/ }));
  const chat = screen.getByText('old report').closest('.chat') as HTMLElement;
  expect(chat.scrollTop).toBe(800);
  chat.scrollTop = 0; fireEvent.scroll(chat);
  const end = screen.getByRole('button', { name: 'Scroll to latest worker messages' }); expect(end.hidden).toBe(false);
  sizes.scrollHeight = 900; Source.current.send({ type: 'work', message: msg('Worker', 'new report') }); expect(chat.scrollTop).toBe(0);
  fireEvent.click(end); expect(chat.scrollTop).toBe(900); // without scrollTo, it jumps
});
