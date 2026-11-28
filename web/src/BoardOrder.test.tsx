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
const folder = '/room', alpha = '2026-11-01-alpha', beta = '2026-11-02-beta', idea = '2026-11-03-idea', other = '2026-11-04-other';
let paths: string[];
const room = { folder, active: `discussions/${alpha}`, board: 'Alpha', started: true, workbenches: [], researches: [], closedBoards: [], checkpoints: [], open: [], autoDev: { status: null } };
const key = (kind: string, root = folder) => `agent-room.${kind}-order:${root}`;
const setup = () => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], input: true, doc: null }); };
const rowTitles = (section: string) => [...screen.getByText(section).closest('details')!.querySelectorAll('.board-row > .discussion-block > button.entry')].map((item) => item.textContent);
beforeEach(() => { localStorage.clear(); paths = [`discussions/${alpha}/notes.md`, `discussions/${beta}/notes.md`, `brainstorms/${idea}/notes.md`, `brainstorms/${other}/notes.md`]; vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('detail=1') ? { files: paths, unviewable: [], branch: null } : paths, text: async () => '' }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reads and saves separate room-specific discussion and brainstorm orders using move controls', async () => {
  localStorage.setItem(key('discussion'), JSON.stringify([alpha, beta])); localStorage.setItem(key('brainstorm'), JSON.stringify([idea, other]));
  localStorage.setItem(key('discussion', '/other'), JSON.stringify([beta, alpha]));
  setup(); await screen.findByLabelText('Board actions for Alpha');
  expect(rowTitles('Sprints (2)')).toEqual(['Alpha', 'beta']); expect(rowTitles('Brainstorms (2)')).toEqual(['idea', 'other']);
  const user = userEvent.setup(); await user.click(screen.getByLabelText('Board actions for Alpha')); await user.click(await screen.findByRole('button', { name: 'Move Alpha down' }));
  expect(rowTitles('Sprints (2)')).toEqual(['beta', 'Alpha']); expect(JSON.parse(localStorage.getItem(key('discussion'))!)).toEqual([beta, alpha]);
  await user.click(screen.getByLabelText('Board actions for Alpha'));
  expect((screen.getByRole('button', { name: 'Move Alpha down' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Move Alpha up' }));
  expect(JSON.parse(localStorage.getItem(key('discussion'))!)).toEqual([alpha, beta]);
  await user.click(screen.getByLabelText('Board actions for idea'));
  await user.click(screen.getByRole('button', { name: 'Move idea down' }));
  expect(JSON.parse(localStorage.getItem(key('brainstorm'))!)).toEqual([other, idea]);
  expect(JSON.parse(localStorage.getItem(key('discussion', '/other'))!)).toEqual([beta, alpha]);
});

it('drags a row before or after another and maintains changes made in other tabs', async () => {
  localStorage.setItem(key('discussion'), JSON.stringify([alpha, beta])); setup();
  const handle = await screen.findByLabelText('Drag Alpha to reorder'); const target = screen.getByRole('button', { name: 'beta' }).parentElement!;
  target.getBoundingClientRect = () => ({ top: 0, height: 100 } as DOMRect);
  const data = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: () => alpha };
  const drag = (node: Element, type: string, y: number) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y }); Object.defineProperty(event, 'dataTransfer', { value: data }); fireEvent(node, event); };
  drag(handle, 'dragstart', 0); drag(target, 'dragover', 80); drag(target, 'drop', 80);
  expect(JSON.parse(localStorage.getItem(key('discussion'))!)).toEqual([beta, alpha]);
  localStorage.setItem(key('discussion'), JSON.stringify([alpha, beta])); fireEvent(window, new StorageEvent('storage', { key: key('discussion') }));
  expect(rowTitles('Sprints (2)')).toEqual(['Alpha', 'beta']);
});

it('puts newly discovered boards first and forgets removed boards without disturbing saved order', async () => {
  localStorage.setItem(key('discussion'), JSON.stringify([alpha, beta, 'gone'])); setup();
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key('discussion'))!)).toEqual([alpha, beta]));
  const fresh = '2026-11-05-fresh'; paths = [...paths, `discussions/${fresh}/notes.md`];
  Source.current.send({ type: 'files' });
  await waitFor(() => expect(JSON.parse(localStorage.getItem(key('discussion'))!)).toEqual([fresh, alpha, beta]));
  expect(within(screen.getByLabelText('Boards')).getByRole('button', { name: 'fresh' })).toBeTruthy();
});
