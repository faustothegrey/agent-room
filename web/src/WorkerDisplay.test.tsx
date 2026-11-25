import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const room = { discussion: 'Live', active: 'discussions/live', started: true, brainstorm: false, research: false, workbench: false };
const worker = [{ speaker: 'Worker', html: '<p>Saved <strong>report</strong></p>', error: false }, { note: 'Prior note' }];
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows reset and live worker reports, marks news until Worker is opened, and keeps Discussion separate', async () => {
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [{ speaker: 'Ada', html: '<p>Discussion text</p>' }], worker, input: true });
  Source.current.send({ type: 'work', message: { speaker: 'Worker', html: '<p>Live report</p>', error: false } });
  const user = userEvent.setup(); expect(screen.getByRole('tab', { name: 'Worker · new' })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Worker · new' })); expect(screen.getByText('report').tagName).toBe('STRONG');
  expect(screen.getByText('Live report')).toBeTruthy(); expect(screen.getByText('Worker · Prior note')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Instruction to the worker' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Worker' }).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByRole('tab', { name: 'Discussion' })); expect(screen.getByText('Discussion text')).toBeTruthy();
});
it('shows Worker only for a workbench and Discussion only for research', () => {
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room: { ...room, workbench: true }, messages: [], worker, input: true });
  expect(screen.getByRole('tab', { name: 'Worker' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('tab', { name: 'Discussion' })).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, research: true } }); expect(screen.getByRole('tab', { name: 'Discussion' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('tab', { name: 'Worker' })).toBeNull();
});

it('sends text-only work on Enter, preserves Shift+Enter and clears text when a send fails', async () => {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url === '__work' ? { ok: false, text: async () => 'Worker unavailable' } : { ok: true, json: async () => [] });
  vi.stubGlobal('fetch', fetchMock); render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, workbench: true, active: null }, messages: [], worker: [], input: true, workInput: true });
  const user = userEvent.setup(), box = screen.getByRole('textbox', { name: 'Instruction to the worker' }) as HTMLTextAreaElement;
  expect(box.placeholder).toContain('First instruction');
  await user.type(box, 'First{Shift>}{Enter}{/Shift}instruction'); expect(box.value).toBe('First\ninstruction');
  await user.type(box, '{Enter}'); expect(box.value).toBe('');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Worker unavailable'));
  const call = fetchMock.mock.calls.find(([url]) => url === '__work');
  expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ text: 'First\ninstruction' });
});

it('hides input without workInput and disables it for read-only and disabled workers', async () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, workbench: true }, messages: [], worker: [], input: true, workInput: false });
  expect(screen.queryByRole('textbox', { name: 'Instruction to the worker' })).toBeNull();
  Source.current.send({ type: 'reset', room: { ...room, workbench: true }, messages: [], worker: [], input: true, workInput: true, workerInfo: { disabled: true, lines: ['Worker disabled'] } });
  expect((screen.getByRole('textbox', { name: 'Instruction to the worker' }) as HTMLTextAreaElement).disabled).toBe(true);
});

it('shows a workbench Peek read-only and the worker busy hint', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, input: true, workInput: true, messages: [], worker, working: 'Worker', peek: { kind: 'workbench', name: 'old', title: 'Old', path: 'discussions/old', messages: [] } });
  expect(screen.queryByRole('tab', { name: 'Discussion' })).toBeNull();
  expect(screen.getByText('The worker is busy: what you send now waits for it to finish.')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Instruction to the worker' }) as HTMLTextAreaElement).disabled).toBe(true);
  Source.current.send({ type: 'working', name: null }); expect(screen.queryByText('The worker is busy: what you send now waits for it to finish.')).toBeNull();
});
