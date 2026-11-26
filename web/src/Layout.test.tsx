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
const folder = '/room';
const room = { folder, active: 'discussions/alpha', started: true };
const key = (board: string, root = folder) => 'agent-room:board-layout:' + JSON.stringify([root, board]);
const initial = { stacked: false, sideClosed: false, left: 500, top: 300 };
const reference = { speaker: 'Ada', html: '<span class="ref" data-ref="D4">D4</span>' };
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, input: true, messages: [reference], doc: 'notes.md', peek: null, ...extra });
const layout = () => document.querySelector('.next-layout') as HTMLDivElement;
const state = (board: string) => JSON.parse(localStorage.getItem(key(board))!);
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ json: async () => url.includes('detail=1') ? { files: [], unviewable: [] } : [] }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses shared defaults, copies new boards, isolates rooms and follows board names through archive and conversion', () => {
  localStorage.setItem('agent-room:left', '500'); localStorage.setItem('agent-room:top', '300');
  render(<App version="one" refresh={() => {}} />); reset();
  expect(state('alpha')).toEqual(initial);
  fireEvent.click(screen.getByTitle('Stack conversation above side pane'));
  expect(state('alpha').stacked).toBe(true);
  Source.current.send({ type: 'room', room: { ...room, active: 'brainstorms/beta' } });
  expect(state('beta').stacked).toBe(true);
  fireEvent.click(screen.getByTitle('Place conversation and side pane side by side'));
  Source.current.send({ type: 'room', room: { ...room, active: 'discussions/beta' } });
  expect(layout().classList.contains('stacked')).toBe(false);
  Source.current.send({ type: 'room', room: { ...room, folder: '/other', active: 'discussions/alpha' } });
  expect(JSON.parse(localStorage.getItem(key('alpha', '/other'))!).stacked).toBe(false);
  Source.current.send({ type: 'room', room }); expect(layout().classList.contains('stacked')).toBe(true);
});

it('keeps Peek and peer-view changes temporary and restores the active board', () => {
  localStorage.setItem(key('alpha'), JSON.stringify(initial));
  localStorage.setItem(key('old'), JSON.stringify({ stacked: true, sideClosed: false, left: 400, top: 200 }));
  render(<App version="one" refresh={() => {}} />); reset();
  const peek = { name: 'old', title: 'Old', path: 'discussions/archive/old' };
  reset({ peek }); expect(layout().classList.contains('stacked')).toBe(true);
  fireEvent.click(screen.getByTitle('Close side pane'));
  expect(state('old').sideClosed).toBe(false); expect(state('alpha')).toEqual(initial);
  reset(); expect(layout().classList.contains('stacked')).toBe(false); expect(layout().classList.contains('closed')).toBe(false);
  reset({ viewing: { name: 'old' } }); expect(layout().classList.contains('stacked')).toBe(true);
  fireEvent.click(screen.getByTitle('Place conversation and side pane side by side'));
  expect(state('old').stacked).toBe(true);
  reset(); expect(layout().classList.contains('stacked')).toBe(false);
});

it('keeps unnamed board layout until naming it, and reopens the viewer on a reference click', () => {
  render(<App version="one" refresh={() => {}} />); reset({ room: { ...room, active: null } });
  fireEvent.click(screen.getByTitle('Stack conversation above side pane'));
  fireEvent.click(screen.getByTitle('Close side pane'));
  fireEvent.click(screen.getByTitle('Open side pane'));
  expect(layout().classList.contains('closed')).toBe(false);
  fireEvent.click(screen.getByTitle('Close side pane'));
  Source.current.send({ type: 'room', room: { ...room, active: 'discussions/fresh' } });
  expect(state('fresh').stacked).toBe(true); expect(state('fresh').sideClosed).toBe(true);
  const frame = screen.getByTitle('Document viewer') as HTMLIFrameElement;
  const send = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.click(screen.getByText('D4'));
  expect(layout().classList.contains('closed')).toBe(false);
  expect(send).toHaveBeenCalledWith({ type: 'agent-room:highlight', ref: 'D4', on: true }, location.origin);
  expect(state('fresh').sideClosed).toBe(false);
});

it('resizes with keyboard and pointer and saves the selected orientation', () => {
  render(<App version="one" refresh={() => {}} />); reset();
  const p = layout(); p.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700 } as DOMRect);
  const conv = document.querySelector('.next-conversation') as HTMLDivElement;
  conv.getBoundingClientRect = () => ({ width: 500, height: 300 } as DOMRect);
  const split = screen.getByRole('separator', { name: 'Resize conversation and side pane' });
  fireEvent.keyDown(split, { key: 'ArrowRight' }); expect(state('alpha').left).toBe(524);
  fireEvent.click(screen.getByTitle('Stack conversation above side pane'));
  fireEvent.keyDown(split, { key: 'ArrowDown' }); expect(state('alpha').top).toBe(324);
  Object.assign(split, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  const pointer = (type: string, y: number) => { const event = new MouseEvent(type, { bubbles: true, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); fireEvent(split, event); };
  pointer('pointerdown', 350); pointer('pointermove', 390);
  expect(state('alpha').top).toBe(324);
  pointer('pointerup', 410); expect(state('alpha').top).toBe(407);
});

function drag(split: HTMLElement, points: [number, number][]) {
  Object.assign(split, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
  points.forEach(([x, y], index) => {
    const type = index === 0 ? 'pointerdown' : index === points.length - 1 ? 'pointerup' : 'pointermove';
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 }); fireEvent(split, event);
  });
}

it('resizes and snap-collapses Boards, restoring its pre-drag width on reopening', () => {
  render(<App version="one" refresh={() => {}} />); reset();
  const boards = screen.getByLabelText('Boards');
  boards.getBoundingClientRect = () => ({ left: 62, width: 240 } as DOMRect);
  let split = screen.getByRole('separator', { name: 'Resize Boards list' });
  drag(split, [[305, 0], [365, 0]]);
  expect(localStorage.getItem('agent-room:list-width')).toBe('300');
  split = screen.getByRole('separator', { name: 'Resize Boards list' });
  drag(split, [[365, 0], [220, 0], [120, 0]]);
  expect(localStorage.getItem('agent-room:list-width')).toBe('300');
  expect(localStorage.getItem('agent-room:list-collapsed')).toBe('1');
  fireEvent.click(screen.getByTitle('Expand boards list'));
  expect((document.querySelector('.app') as HTMLElement).style.getPropertyValue('--list')).toBe('300px');
});

it.each([false, true])('snap-collapses the side pane and restores its pre-drag size (stacked: %s)', (stacked) => {
  localStorage.setItem(key('alpha'), JSON.stringify({ ...initial, stacked }));
  render(<App version="one" refresh={() => {}} />); reset();
  layout().getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 700 } as DOMRect);
  const split = screen.getByRole('separator', { name: 'Resize conversation and side pane' });
  drag(split, stacked ? [[0, 303], [0, 500], [0, 650]] : [[503, 0], [700, 0], [950, 0]]);
  expect(state('alpha')).toEqual({ ...initial, stacked, sideClosed: true });
  fireEvent.click(screen.getByTitle('Open side pane'));
  expect(state('alpha')).toEqual({ ...initial, stacked });
});
