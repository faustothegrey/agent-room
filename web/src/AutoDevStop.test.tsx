import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
class Source {
  static current: Source; onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; } close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const auto = { status: null, cycle: 0, max: 5, reason: null, waiting: false, offer: null };
const room = { discussion: 'Live', active: 'discussions/live', started: true, brainstorm: false, research: false, workbench: false, autoDev: auto, workerStop: null };
const summary = { speaker: 'Ada', html: '<p>Next step: do it</p><p>Outcome: agreed</p>', outcome: 'agreed', error: false, pass: false };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, text: async () => '', json: async () => [] }));
const setup = (extra: object = {}, messages: object[] = []) => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room: { ...room, ...extra }, messages, worker: [], input: true, workInput: true }); };
beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows running, paused, and finished auto dev on both tabs and restarts from its offer', async () => {
  setup({ autoDev: { ...auto, status: 'running', cycle: 2, waiting: true } });
  const user = userEvent.setup(); expect(screen.getByText('Auto dev running · cycle 2 of 5 · worker is working')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement).placeholder).toContain('sending a message pauses it');
  await user.click(screen.getByRole('tab', { name: 'Worker' })); expect(screen.getByText('Auto dev running · cycle 2 of 5 · worker is working')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, autoDev: { ...auto, status: 'running', cycle: 2 } } }); expect(screen.getByText('Auto dev running · cycle 2 of 5 · discussion is reviewing')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, autoDev: { ...auto, status: 'paused', reason: 'waiting', offer: { text: 'Do the work' } } } });
  expect(screen.getByText('Auto dev paused · waiting')).toBeTruthy(); await user.click(screen.getByRole('tab', { name: 'Discussion' }));
  expect(screen.getByText('Do the work')).toBeTruthy(); await user.click(screen.getByRole('button', { name: 'Restart auto dev (5 more)' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(String(init?.body)).text === '/autodev')).toBe(true));
  Source.current.send({ type: 'room', room: { ...room, autoDev: { ...auto, status: 'paused', reason: 'failed', offer: { error: 'missing quotes' } } } }); expect(screen.getByText('The latest agreed instruction can’t be sent: missing quotes.')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, autoDev: { ...auto, status: 'finished' } } }); expect(screen.getByText('Auto dev finished · review and merge its worker branch')).toBeTruthy();
});

it('puts the Start offer in the latest agreed summary and sends the command', async () => {
  setup({ autoDev: { ...auto, offer: { text: 'Do it' } } }, [summary, summary]);
  const summaries = screen.getAllByText('Outcome: agreed'); const second = summaries[1].parentElement!;
  const button = within(second).getByRole('button', { name: 'Start auto dev' });
  expect(second.textContent?.indexOf('Start auto dev')).toBeLessThan(second.textContent!.indexOf('Outcome: agreed'));
  await userEvent.setup().click(button); await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__say' && JSON.parse(String(init?.body)).text === '/autodev')).toBe(true));
});

it('requires two clicks to stop, respects after/now states, and hides controls while peeking', async () => {
  setup({ workerStop: { after: false, now: false } }); const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: 'Worker' }));
  await user.click(screen.getByRole('button', { name: 'Stop after this task' })); expect(fetchMock.mock.calls.filter(([url]) => url === '__stopworker')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Click again: stop after this task; queued instructions are cancelled' }));
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '__stopworker')![1]?.body))).toEqual({ mode: 'after' });
  Source.current.send({ type: 'room', room: { ...room, workerStop: { after: true, now: false } } });
  expect((screen.getByRole('button', { name: /stop after this task/i }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Stop now' })); await user.click(screen.getByRole('button', { name: 'Click again: stop now; partial edits may be left' }));
  expect(JSON.parse(String(fetchMock.mock.calls.filter(([url]) => url === '__stopworker')[1][1]?.body))).toEqual({ mode: 'now' });
  Source.current.send({ type: 'reset', room: { ...room, workerStop: { after: false, now: false } }, messages: [], worker: [], input: true, workInput: true, peek: { name: 'old', kind: 'discussion', path: 'discussions/old', title: 'Old' } });
  expect(screen.queryByRole('button', { name: 'Stop now' })).toBeNull();
});

it('shows an unsendable offer beside the summary and hides auto dev in read-only mode', () => {
  setup({ autoDev: { ...auto, offer: { error: 'missing quotes' } } }, [summary]);
  expect(screen.getByText('Auto dev can’t send this instruction: missing quotes.')).toBeTruthy();
  Source.current.send({ type: 'reset', room: { ...room, autoDev: { ...auto, status: 'running', cycle: 1 } }, messages: [summary], worker: [], input: true, workInput: true, peek: { name: 'old', kind: 'discussion', path: 'discussions/old', title: 'Old' } });
  expect(screen.queryByText(/Auto dev running/)).toBeNull();
});
