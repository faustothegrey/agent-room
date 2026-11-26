import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const room = { discussion: 'Live', active: 'discussions/live', started: true, brainstorm: false, research: false, workbench: true };
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('offers capture only in the checkout room and sends the visible clues before the message', () => {
  render(<App version="one" refresh={() => {}} />);
  const reset = (ownCheckout: boolean) => Source.current.send({ type: 'reset', room: { ...room, ownCheckout }, messages: [], worker: [], input: true, workInput: true });
  reset(false); expect(screen.queryByRole('button', { name: 'Capture UI live' })).toBeNull();
  reset(true); fireEvent.click(screen.getByRole('button', { name: 'Capture UI live' }));
  const target = document.createElement('div'); target.className = 'example'; target.setAttribute('aria-label', 'Label'); target.title = 'A title';
  target.innerHTML = 'Visible <input value="secret"><textarea>private</textarea><span contenteditable="true">hidden edit</span>';
  document.body.append(target); document.elementFromPoint = vi.fn(() => target); fireEvent.mouseMove(target); fireEvent.keyDown(document, { altKey: true, code: 'KeyP', key: 'π' }); target.remove();
  fireEvent.click(screen.getByText('Captured element 1'));
  const clues = screen.getByText(/Element: div.example/).textContent!;
  expect(clues).toContain('Text: Visible'); expect(clues).toContain('aria-label: Label'); expect(clues).toContain('Title: A title');
  expect(clues).toContain('Position:'); expect(clues).toContain('Ancestors:');
  expect(clues).not.toMatch(/secret|private|hidden edit/);
  const box = screen.getByRole('textbox', { name: 'Instruction to the worker' }); expect(document.activeElement).toBe(box);
  fireEvent.change(box, { target: { value: 'Fix it' } }); fireEvent.keyDown(box, { key: 'Enter' });
  const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '__work');
  expect(JSON.parse((call![1] as RequestInit).body as string).text).toBe(clues + '\n\nFix it');
});

function setup() {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, ownCheckout: true }, messages: [], worker: [], input: true, workInput: true });
}
function capture(target: Element) {
  document.elementFromPoint = vi.fn(() => target);
  fireEvent.click(screen.getByRole('button', { name: 'Capture UI live' }));
  fireEvent.mouseMove(target, { clientX: 20, clientY: 30 });
  fireEvent.keyDown(document, { altKey: true, code: 'KeyP', key: 'π' });
}
it('refreshes the outline on click and scroll and captures the current element under the stationary pointer', () => {
  setup(); const old = document.createElement('button'), current = document.createElement('button');
  old.textContent = 'Old'; current.textContent = 'Menu item'; document.body.append(old, current);
  const rect = (x: number) => ({ x, y: 10, left: x, top: 10, width: 50, height: 20, right: x + 50, bottom: 30, toJSON() {} } as DOMRect);
  old.getBoundingClientRect = () => rect(1); current.getBoundingClientRect = () => rect(40);
  let underPointer = old; document.elementFromPoint = vi.fn(() => underPointer);
  fireEvent.click(screen.getByRole('button', { name: 'Capture UI live' })); fireEvent.mouseMove(old, { clientX: 20, clientY: 30 });
  expect((document.querySelector('.capture-outline') as HTMLElement).style.left).toBe('1px');
  underPointer = current; fireEvent.click(old, { clientX: 20, clientY: 30 });
  expect((document.querySelector('.capture-outline') as HTMLElement).style.left).toBe('40px');
  current.getBoundingClientRect = () => rect(60); fireEvent.scroll(document);
  expect((document.querySelector('.capture-outline') as HTMLElement).style.left).toBe('60px');
  fireEvent.keyDown(document, { altKey: true, code: 'KeyP' }); fireEvent.click(screen.getByText('Captured element 1'));
  expect(screen.getByText(/Text: Menu item/).textContent).toContain('x=60'); old.remove(); current.remove();
});
it('clears captures when the shown board changes but not on a reset of the same board', () => {
  setup(); const target = document.createElement('button'); target.textContent = 'Target'; document.body.append(target); capture(target);
  Source.current.send({ type: 'reset', room: { ...room, ownCheckout: true }, messages: [], worker: [], input: true, workInput: true });
  expect(screen.getByText('Captured element 1')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, active: 'discussions/other', ownCheckout: true } });
  expect(screen.queryByText('Captured element 1')).toBeNull(); target.remove();
});
it('retains failed captures and clears only captures included in a successful send', async () => {
  let resolveWork!: (value: { ok: boolean; text: () => Promise<string> }) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url === '__work' ? new Promise((resolve) => { resolveWork = resolve; }) : Promise.resolve({ ok: true, json: async () => [] })));
  setup(); const first = document.createElement('button'), second = document.createElement('button'); first.textContent = 'First'; second.textContent = 'Second'; document.body.append(first, second);
  capture(first); const box = screen.getByRole('textbox', { name: 'Instruction to the worker' });
  const send = () => { fireEvent.change(box, { target: { value: 'Fix' } }); fireEvent.keyDown(box, { key: 'Enter' }); };
  send(); await act(async () => resolveWork({ ok: false, text: async () => 'Failed' }));
  expect(screen.getByText('Captured element 1')).toBeTruthy();
  send(); capture(second); await act(async () => resolveWork({ ok: true, text: async () => '' }));
  await waitFor(() => expect(screen.queryByText('Captured element 2')).toBeNull());
  fireEvent.click(screen.getByText('Captured element 1')); expect(screen.getByText(/Text: Second/)).toBeTruthy(); first.remove(); second.remove();
});
