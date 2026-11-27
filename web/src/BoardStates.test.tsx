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
const name = '2026-11-01-alpha', path = `discussions/${name}`;
const files = [`${path}/notes.md`, 'discussions/2026-11-02-research/notes.md'];
const room = { folder: '/project', active: path, discussion: 'Alpha', started: true, closedDiscussions: [], workbenches: [], researches: ['2026-11-02-research'], researchStats: {}, busyWorkers: [], closingDiscussions: {}, open: [{ active: path, current: true, title: 'Alpha', started: true }], autoDev: { status: null } };
const fetchMock = vi.fn();
const setup = (extra: object = {}, workerInfo: object | null = null) => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room: { ...room, ...extra }, input: true, messages: [], doc: null, workerInfo }); };
const alpha = () => screen.getByRole('button', { name: 'Alpha' }).parentElement!;
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('detail=1') ? { files, unviewable: [], branch: null } : [], text: async () => '' })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('applies state precedence, reasons and worker conflict warnings', async () => {
  const entry = room.open[0]; setup({ open: [{ ...entry, waitingForInput: true, waitingReason: 'Please decide' }] });
  await screen.findByRole('button', { name: 'Alpha' });
  expect(within(alpha()).getByText('waiting for input').getAttribute('title')).toBe('Please decide');
  Source.current.send({ type: 'workerinfo', info: { lines: [], pending: [{ lane: name, branch: 'worker/alpha', ahead: 2, dirty: true, conflicts: ['a.txt'] }] } });
  expect(within(alpha()).getByText('waiting for input').getAttribute('title')).toBe('Worker conflict: a.txt');
  expect(within(alpha()).getByText('⚠ Worker: 2 commits not merged into main · uncommitted changes')).toBeTruthy();
  expect(within(alpha()).getByText('⚠ Worker conflict: a.txt')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, open: [{ ...entry, working: true }], busyWorkers: [name] } });
  expect(within(alpha()).getByText('ongoing · worker working')).toBeTruthy(); expect(within(alpha()).queryByText('⚠ Worker conflict: a.txt')).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, open: [{ ...entry, started: false }], closedDiscussions: [name] } });
  expect(within(alpha()).getByText('closed')).toBeTruthy();
});

it('shows readiness, merge suffix, no changes, merged and closing phase', async () => {
  const entry = room.open[0]; setup({ open: [{ ...entry, readyForAutoDev: true }] });
  await screen.findByRole('button', { name: 'Alpha' }); expect(within(alpha()).getByText('ready for auto dev')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, open: [{ ...entry, workReady: true }] } });
  Source.current.send({ type: 'workerinfo', info: { lines: [], pending: [], mergeable: { [name]: { canMerge: false, catchUp: false, disabledReason: 'blocked' } } } });
  expect(within(alpha()).getByText('work ready · merge blocked · no changes').getAttribute('title')).toBe('blocked');
  Source.current.send({ type: 'workerinfo', info: { lines: [], pending: [], mergeable: { [name]: { canMerge: false, catchUp: true } }, merged: [name] } });
  expect(within(alpha()).getByText('work ready · needs catch-up · merged')).toBeTruthy();
  Source.current.send({ type: 'workerinfo', info: { lines: [], mergeable: { [name]: { canMerge: true, catchUp: false } } } });
  expect(within(alpha()).getByText('work ready · mergeable')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, open: [{ ...entry, started: false }] } }); expect(within(alpha()).getByText('not started')).toBeTruthy();
  Source.current.send({ type: 'room', room: { ...room, closingDiscussions: { [name]: 'waiting' } } }); expect(within(alpha()).getByText('ongoing · closing · waiting for worker')).toBeTruthy();
});

it('shows research lap details and refreshes worker state on expansion and throttled return', async () => {
  setup({ researchStats: { '2026-11-02-research': { laps: 31, priorUnknown: true } } });
  const research = (await screen.findByRole('button', { name: '🔬 research' })).parentElement!;
  expect(within(research).getByText('Laps: ≥31').className).toBe('research-laps-high');
  expect(within(research).getByText(/Last: — · Next: —/)).toBeTruthy();
  const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Collapse boards list' })); await user.click(screen.getByRole('button', { name: 'Expand boards list' }));
  expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(1);
  fireEvent.focus(window); fireEvent.focus(window);
  expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(2);
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 5001); fireEvent.focus(window);
  expect(fetchMock.mock.calls.filter(([url]) => url === '__workerinfo')).toHaveLength(3);
});

it('shows a research row’s kind as a badge, with none for Feasibility', async () => {
  for (const [kind, badge] of [[{}, null], [{ deep: true }, 'Deep'], [{ theoretical: true }, 'Theoretical'], [{ deep: true, theoretical: true }, 'Deep · Theoretical']] as const) {
    cleanup(); setup({ researchStats: { '2026-11-02-research': { laps: 2, ...kind } } });
    const research = (await screen.findByRole('button', { name: '🔬 research' })).parentElement!;
    expect(within(research).getByText('Laps: 2')).toBeTruthy();
    expect(research.querySelector('.research-kind-badge')?.textContent ?? null).toBe(badge);
  }
});
