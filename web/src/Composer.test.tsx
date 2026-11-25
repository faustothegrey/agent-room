import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent)); }
}
const room = { discussion: 'Discussion', started: true, active: 'discussions/example', autoDev: { status: null } };
const reply = (status: number, text = '') => ({ ok: status >= 200 && status < 300, status, text: async () => text });
const fetchMock = vi.fn();
const setup = (input = true, active: string | null = room.active) => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', input, room: { ...room, active }, messages: [], busy: false });
};
beforeEach(() => { sessionStorage.clear(); fetchMock.mockReset(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', (...args: unknown[]) => args[0] === '__health' ? new Promise(() => {}) : fetchMock(...args)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('sends Enter, preserves Shift+Enter and passes @names and slash commands to the room', async () => {
  fetchMock.mockResolvedValue(reply(204)); setup(); const user = userEvent.setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' });
  await user.type(box, '@Ada hello{Shift>}{Enter}{/Shift}second line{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[0][0]).toBe('__say');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: '@Ada hello\nsecond line' });
  expect(fetchMock.mock.calls[0][1].headers['content-type']).toBe('application/json');
  expect(fetchMock.mock.calls[0][1].headers['x-view-client']).toBeTruthy();
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  await user.type(box, '/usage{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: '/usage' });
});

it('hides the composer in terminal mode and disables attachments until a board starts', () => {
  setup(false); expect(screen.queryByRole('textbox', { name: 'Message to the agents' })).toBeNull();
  Source.current.send({ type: 'reset', input: true, room: { ...room, active: null }, messages: [] });
  expect((screen.getByRole('button', { name: '📎 Attach' }) as HTMLButtonElement).disabled).toBe(true);
  Source.current.send({ type: 'room', room });
  expect((screen.getByRole('button', { name: '📎 Attach' }) as HTMLButtonElement).disabled).toBe(false);
});

it('keeps text and attachments after rejection and clears them after success', async () => {
  fetchMock.mockResolvedValueOnce(reply(409, 'Nothing was sent.')).mockResolvedValueOnce(reply(204));
  setup(); const user = userEvent.setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' });
  const first = new File(['hello'], 'note.txt', { type: 'text/plain' });
  const second = new File(['bye'], 'remove.txt', { type: 'text/plain' });
  await user.upload(screen.getByLabelText('Attach files'), [first, second]);
  expect(screen.getByText(/note.txt · 1 KB/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Remove remove.txt' }));
  expect(screen.queryByText(/remove.txt ·/)).toBeNull();
  await user.type(box, 'hello{Enter}');
  await screen.findByText('✗ Nothing was sent.');
  expect((box as HTMLTextAreaElement).value).toBe('hello'); expect(screen.getByText(/note.txt · 1 KB/)).toBeTruthy();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'hello', files: [{ name: 'note.txt', data: 'aGVsbG8=' }] });
  await user.keyboard('{Enter}');
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  expect(screen.queryByText(/note.txt ·/)).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('enforces both attachment limits and disallows attachments on commands', async () => {
  setup(); const user = userEvent.setup();
  const file = new File(['x'], 'huge.txt'); Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 });
  await user.upload(screen.getByLabelText('Attach files'), file);
  const box = screen.getByRole('textbox', { name: 'Message to the agents' });
  await user.type(box, 'hello{Enter}');
  expect(screen.getByText('✗ huge.txt is over 25 MB. Nothing was sent.')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  await user.clear(box); await user.type(box, '/usage{Enter}');
  expect(screen.getByText('✗ Attachments go with a message, not a command. Nothing was sent.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Remove huge.txt' }));
  const many = Array.from({ length: 11 }, (_, i) => { const f = new File(['x'], `f${i}.txt`); Object.defineProperty(f, 'size', { value: 25 * 1024 * 1024 }); return f; });
  await user.upload(screen.getByLabelText('Attach files'), many);
  await user.clear(box); await user.type(box, 'hello{Enter}');
  expect(screen.getByText('✗ Over 250 MB at once: attach fewer files per message. Nothing was sent.')).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows request busy after a delay and marks a failed send', async () => {
  vi.useFakeTimers(); let finish!: (value: ReturnType<typeof reply>) => void;
  fetchMock.mockReturnValue(new Promise((ok) => { finish = ok; })); setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' });
  fireEvent.change(box, { target: { value: 'hello' } }); fireEvent.keyDown(box, { key: 'Enter' });
  expect(screen.queryByLabelText('Busy')).toBeNull();
  act(() => vi.advanceTimersByTime(300)); expect(screen.getByLabelText('Busy').dataset.state).toBe('on');
  await act(async () => { finish(reply(400, 'No')); await Promise.resolve(); });
  expect(screen.getByLabelText('Busy').dataset.state).toBe('failed');
  expect((box as HTMLTextAreaElement).value).toBe('hello');
  act(() => vi.advanceTimersByTime(1500)); expect(screen.queryByLabelText('Busy')).toBeNull();
});

it('asks before confirming a restart and keeps a refused command', async () => {
  fetchMock.mockResolvedValueOnce(reply(409, 'Restart?')).mockResolvedValueOnce(reply(204));
  vi.spyOn(window, 'confirm').mockReturnValue(true); setup(); const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), '/restart{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(window.confirm).toHaveBeenCalledWith('Restart?');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ text: '/restart', confirmed: true });
});

it('keeps a plain draft after a network failure and does not send an IME composition', async () => {
  fetchMock.mockRejectedValue(new Error('offline')); setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'keep this' } });
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText("✗ Couldn't send the message: offline. Nothing was sent.");
  expect(box.value).toBe('keep this');
});

it('keeps a restart command when the confirmation is cancelled', async () => {
  fetchMock.mockResolvedValue(reply(409, 'Restart?')); vi.spyOn(window, 'confirm').mockReturnValue(false);
  setup(); const user = userEvent.setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, '/restart{Enter}');
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith('Restart?'));
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(box.value).toBe('/restart');
});

it('restores a draft after a version refresh and disables input after the room ends', () => {
  const refresh = vi.fn(); const first = render(<App version="one" refresh={refresh} />);
  Source.current.send({ type: 'reset', input: true, room, messages: [] });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message to the agents' }), { target: { value: 'draft' } });
  Source.current.send({ type: 'web-version', webVersion: 'two' }); expect(refresh).toHaveBeenCalledOnce();
  first.unmount(); setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  expect(box.value).toBe('draft');
  Source.current.send({ type: 'ended' }); expect(box.disabled).toBe(true);
});

it('opens Explorer locally for the /docs command', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ files: ['discussions/example/notes.md'], unviewable: [], branch: 'main' }) });
  setup(); const user = userEvent.setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, '/docs{Enter}');
  expect(await screen.findByRole('button', { name: 'notes.md' })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('__files?detail=1');
  expect(fetchMock.mock.calls.some(([url]) => url === '__say')).toBe(false); expect(box.value).toBe('');
});

it('does not erase text entered while an earlier message is being sent', async () => {
  let finish!: (value: ReturnType<typeof reply>) => void;
  fetchMock.mockReturnValue(new Promise((ok) => { finish = ok; })); setup();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'first' } }); fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.change(box, { target: { value: 'a new draft' } });
  await act(async () => { finish(reply(204)); await Promise.resolve(); });
  expect(box.value).toBe('a new draft');
});

it('sends brainstorm attachments using the same payload as discussion attachments', async () => {
  fetchMock.mockResolvedValue(reply(204)); setup(); const user = userEvent.setup();
  Source.current.send({ type: 'room', room: { ...room, brainstorm: true, active: 'brainstorms/idea' } });
  await user.upload(screen.getByLabelText('Attach files'), new File(['idea'], 'idea.txt'));
  await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), 'note{Enter}');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: 'note', files: [{ name: 'idea.txt', data: 'aWRlYQ==' }] });
});

it('does not send normal messages or attachments while peeking but permits commands', async () => {
  fetchMock.mockResolvedValue(reply(204)); setup(); const user = userEvent.setup();
  Source.current.send({ type: 'reset', input: true, room, messages: [], peek: { name: 'closed' } });
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, 'wrong board{Enter}'); expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(0);
  await user.clear(box); await user.type(box, '/peek{Enter}');
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '__say')).toHaveLength(1));
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__say')![1].body)).toEqual({ text: '/peek' });
});
