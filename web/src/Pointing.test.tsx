import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const post = vi.fn();
const point = { type: 'agent-room:point', label: '↳ runs!D4', text: 'table cell runs!D4 = 5' };
function setup() {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { active: 'discussions/live', started: true }, input: true, messages: [{ speaker: 'Ada', html: '<p>See <span class="ref" data-ref="runs!D4">runs!D4</span></p>' }], doc: 'notes.md', peek: null });
  return screen.getByTitle('Document viewer') as HTMLIFrameElement;
}
function sendPoint(frame: HTMLIFrameElement, data: unknown = point, origin = location.origin, source: MessageEventSource | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent('message', { data, origin, source })));
}
beforeEach(() => {
  post.mockReset(); post.mockImplementation(async (url: string) => url === '__files' ? { ok: true, json: async () => [] } : { ok: true, text: async () => '' });
  vi.stubGlobal('fetch', post); vi.stubGlobal('EventSource', Source);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('requires both the viewer origin and the iframe source and validates points', () => {
  const frame = setup();
  sendPoint(frame, point, 'https://evil.example');
  expect(screen.queryByTitle(point.text)).toBeNull();
  sendPoint(frame, point, location.origin, window);
  expect(screen.queryByTitle(point.text)).toBeNull();
  sendPoint(frame, { ...point, text: 12 });
  expect(screen.queryByTitle(point.text)).toBeNull();
  sendPoint(frame); sendPoint(frame);
  expect(screen.getAllByTitle(point.text)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Stop pointing at ↳ runs!D4' }));
  expect(screen.queryByTitle(point.text)).toBeNull();
});

it('leaves points on commands and consumes them into a normal message even if the send fails', async () => {
  const frame = setup(); const user = userEvent.setup(); sendPoint(frame);
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, '/summary{Enter}');
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '__say')).toBe(true));
  expect(screen.getByTitle(point.text)).toBeTruthy();
  post.mockImplementation(async () => ({ ok: false, text: async () => 'failed' }));
  await user.type(box, 'Why?  {Enter}');
  await waitFor(() => expect(post.mock.calls.filter(([url]) => url === '__say')).toHaveLength(2));
  const body = JSON.parse(post.mock.calls.filter(([url]) => url === '__say')[1][1].body);
  expect(body.text).toBe('Why?\n[pointing at: table cell runs!D4 = 5]');
  expect(screen.queryByTitle(point.text)).toBeNull(); expect(box.value).toBe('');
});

it('keeps the pointing line with attachments on failure and clears it after a successful retry', async () => {
  const frame = setup(); const user = userEvent.setup(); sendPoint(frame);
  post.mockImplementation(async (url: string) => url === '__files' ? { ok: true, json: async () => [] } : { ok: false, text: async () => 'failed' });
  await user.upload(screen.getByLabelText('Attach files'), new File(['data'], 'file.txt', { type: 'text/plain' }));
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  await user.type(box, 'Look{Enter}');
  await screen.findByText('✗ failed');
  expect(box.value).toBe('Look\n[pointing at: table cell runs!D4 = 5]');
  expect(screen.queryByTitle(point.text)).toBeNull(); expect(screen.getByText(/file.txt ·/)).toBeTruthy();
  post.mockImplementation(async () => ({ ok: true, text: async () => '' }));
  await user.type(box, '{Enter}');
  await waitFor(() => expect(box.value).toBe(''));
  const calls = post.mock.calls.filter(([url]) => url === '__say');
  expect(JSON.parse(calls[1][1].body).text).toBe('Look\n[pointing at: table cell runs!D4 = 5]');
  expect(screen.queryByText(/file.txt ·/)).toBeNull();
});

it('sends highlights on reference hover, exit and click to the viewer origin', () => {
  const frame = setup(); const send = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ref = screen.getByText('runs!D4');
  fireEvent.mouseOver(ref); fireEvent.mouseOut(ref); fireEvent.click(ref);
  expect(send.mock.calls).toEqual([
    [{ type: 'agent-room:highlight', ref: 'runs!D4', on: true }, location.origin],
    [{ type: 'agent-room:highlight', ref: 'runs!D4', on: false }, location.origin],
    [{ type: 'agent-room:highlight', ref: 'runs!D4', on: true }, location.origin],
  ]);
});

it('sends multiple points in order, truncates their fields, and consumes them on success', async () => {
  const frame = setup(); const user = userEvent.setup();
  sendPoint(frame, { type: 'agent-room:point', label: 'x'.repeat(100), text: 'y'.repeat(320) });
  sendPoint(frame, { type: 'agent-room:point', label: 'diagram', text: 'box A' });
  expect(screen.getByTitle('y'.repeat(300)).textContent).toContain('x'.repeat(80));
  await user.type(screen.getByRole('textbox', { name: 'Message to the agents' }), '{Enter}');
  await waitFor(() => expect(post.mock.calls.filter(([url]) => url === '__say')).toHaveLength(1));
  const body = JSON.parse(post.mock.calls.find(([url]) => url === '__say')![1].body);
  expect(body.text).toBe(`[pointing at: ${'y'.repeat(300)}; box A]`);
  expect(screen.queryByTitle('y'.repeat(300))).toBeNull(); expect(screen.queryByTitle('box A')).toBeNull();
});
