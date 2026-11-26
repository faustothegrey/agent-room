import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  reset(false); expect(screen.queryByRole('button', { name: 'Capture' })).toBeNull();
  reset(true); fireEvent.click(screen.getByRole('button', { name: 'Capture' }));
  const target = document.createElement('div'); target.className = 'example'; target.setAttribute('aria-label', 'Label'); target.title = 'A title';
  target.innerHTML = 'Visible <input value="secret"><textarea>private</textarea><span contenteditable="true">hidden edit</span>';
  document.body.append(target); fireEvent.mouseMove(target); fireEvent.keyDown(document, { altKey: true, code: 'KeyP', key: 'π' }); target.remove();
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
