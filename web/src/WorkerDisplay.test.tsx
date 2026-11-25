import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
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
  expect(screen.getByText('Live report')).toBeTruthy(); expect(screen.getByText('Prior note')).toBeTruthy();
  expect(screen.getByText('Worker input is not available on this page yet.')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Worker' }).getAttribute('aria-selected')).toBe('true');
  await user.click(screen.getByRole('tab', { name: 'Discussion' })); expect(screen.getByText('Discussion text')).toBeTruthy();
});
it('shows Worker only for a workbench and Discussion only for research', () => {
  render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room: { ...room, workbench: true }, messages: [], worker, input: true });
  expect(screen.getByRole('tab', { name: 'Worker' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('tab', { name: 'Discussion' })).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, research: true } }); expect(screen.getByRole('tab', { name: 'Discussion' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('tab', { name: 'Worker' })).toBeNull();
});
