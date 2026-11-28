import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { computePassedAgents } from './Office';

class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}

const baseRoom = {
  folder: '/room',
  board: 'Design Sprint',
  active: 'discussions/2026-11-28-design',
  started: true,
  agents: ['Claude', 'Codex', 'Agy'],
  worker: 'Worker',
  workbench: false,
  brainstorm: false,
  research: false,
  open: [],
  members: [],
  failedAgents: [] as { name: string; disabled: boolean }[],
};

const ok = (body: unknown = []) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fetchMock = vi.fn(async (url: string) => url === '__health' ? new Promise(() => {}) : ok([]));
const reset = (extra: object = {}) => Source.current.send({
  type: 'reset',
  room: baseRoom,
  messages: [],
  worker: [],
  input: true,
  thinking: null,
  working: null,
  ...extra,
});
const panel = () => screen.getByLabelText('Services panel');
const office = () => within(panel()).getByLabelText('Office');

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('opens Office from the control bar on non-local pages too and closes cleanly', async () => {
  const originalLocation = window.location;
  vi.stubGlobal('location', { ...originalLocation, hostname: '192.168.1.42' });
  render(<App version="one" refresh={() => {}} />); reset();
  const user = userEvent.setup();

  expect(screen.queryByRole('button', { name: '⌨ Terminal' })).toBeNull();
  const btn = screen.getByRole('button', { name: '🏢 Office' });
  expect(btn.getAttribute('aria-pressed')).toBe('false');
  await user.click(btn);
  expect(btn.getAttribute('aria-pressed')).toBe('true');
  expect(within(panel()).getByText('Office')).toBeTruthy();
  expect(office().querySelectorAll('.office-desk')).toHaveLength(3);

  await user.click(btn);
  expect(btn.getAttribute('aria-pressed')).toBe('false');
  expect(panel().hidden).toBe(true);
});

it('shows speaking, passed (at coffee), waiting, failed, round-ended, and worker states', async () => {
  render(<App version="one" refresh={() => {}} />);
  reset({
    thinking: 'Claude',
    working: 'Worker',
    messages: [
      { speaker: 'User', html: '<p>Start</p>', error: false, pass: false },
      { speaker: 'Codex', html: '<p>PASS</p>', error: false, pass: true },
    ],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '🏢 Office' }));

  const view = office();
  // Speaking: Claude's desk screen is lit with a "typing…" bubble.
  const claudeDesk = view.querySelector<HTMLElement>('.office-desk[data-agent="Claude"]')!;
  expect(claudeDesk.dataset.state).toBe('speaking');
  expect(claudeDesk.querySelector('.office-monitor')?.getAttribute('data-screen')).toBe('lit');
  expect(within(claudeDesk).getByText('typing…')).toBeTruthy();

  // Passed in the current round: Codex is at the coffee spot with a steaming mug.
  const codexDesk = view.querySelector<HTMLElement>('.office-desk[data-agent="Codex"]')!;
  expect(codexDesk.dataset.state).toBe('passed');
  expect(codexDesk.querySelector('.office-monitor')?.getAttribute('data-screen')).toBe('off');
  const coffeeGuest = view.querySelector<HTMLElement>('.office-coffee-guest[data-coffee-agent="Codex"]')!;
  expect(coffeeGuest).toBeTruthy();
  expect(within(coffeeGuest).getByLabelText('Codex with steaming mug')).toBeTruthy();

  // Waiting its turn: Agy is at its desk with "z z".
  const agyDesk = view.querySelector<HTMLElement>('.office-desk[data-agent="Agy"]')!;
  expect(agyDesk.dataset.state).toBe('waiting');
  expect(within(agyDesk).getByText('z z')).toBeTruthy();

  // Worker: hammering/sparks at the workbench while working is set.
  const bench = view.querySelector<HTMLElement>('.office-workbench')!;
  expect(bench.dataset.state).toBe('working');
  expect(within(bench).getByLabelText('Worker hammering')).toBeTruthy();

  // Failed agent: Agy fails -> 💥 and grey/failed screen.
  Source.current.send({ type: 'room', room: { ...baseRoom, failedAgents: [{ name: 'Agy', disabled: false }] } });
  expect(agyDesk.dataset.state).toBe('failed');
  expect(agyDesk.querySelector('.office-monitor')?.getAttribute('data-screen')).toBe('failed');
  expect(within(agyDesk).getByLabelText('Agy failed')).toBeTruthy();

  // Round ended (control back to User): everyone faces the door.
  Source.current.send({ type: 'turn', text: 'your turn · all passed' });
  expect(view.querySelector('.office-room')?.getAttribute('data-round-ended')).toBe('true');
  for (const name of ['Claude', 'Codex', 'Agy']) {
    const desk = view.querySelector<HTMLElement>(`.office-desk[data-agent="${name}"]`)!;
    expect(desk.dataset.facing).toBe('down');
  }
  expect(within(view).getByLabelText('Door').textContent).toContain('Your turn');

  // Worker becomes idle when working clears.
  Source.current.send({ type: 'working', name: null });
  expect(bench.dataset.state).toBe('idle');
  expect(within(bench).queryByLabelText('Worker hammering')).toBeNull();

  // New User message starts a fresh round: previous passes clear and a live pass moves an agent to coffee.
  Source.current.send({ type: 'message', message: { speaker: 'User', html: '<p>Next</p>', error: false, pass: false } });
  Source.current.send({ type: 'thinking', name: 'Claude' });
  expect(view.querySelectorAll('.office-coffee-guest')).toHaveLength(0);
  Source.current.send({ type: 'message', message: { speaker: 'Codex', html: '<p>PASS</p>', error: false, pass: true } });
  expect(view.querySelector('.office-coffee-guest[data-coffee-agent="Codex"]')).toBeTruthy();
  // If Codex speaks (non-pass) later in the same round, Codex leaves coffee.
  Source.current.send({ type: 'message', message: { speaker: 'Codex', html: '<p>Actually…</p>', error: false, pass: false } });
  expect(view.querySelector('.office-coffee-guest[data-coffee-agent="Codex"]')).toBeNull();
});

it('handles board switches cleanly, including an agent-less workbench board', async () => {
  render(<App version="one" refresh={() => {}} />);
  reset({
    thinking: 'Claude',
    messages: [
      { speaker: 'User', html: '<p>Hi</p>', error: false, pass: false },
      { speaker: 'Codex', html: '<p>PASS</p>', error: false, pass: true },
    ],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '🏢 Office' }));
  expect([...office().querySelectorAll<HTMLElement>('.office-desk')].map((d) => d.dataset.agent)).toEqual(['Claude', 'Codex', 'Agy']);

  // Switch to a different sprint with different participants.
  reset({
    room: {
      ...baseRoom,
      board: 'Second Sprint',
      active: 'discussions/2026-11-28-second',
      agents: ['Planner', 'Reviewer'],
    },
    thinking: 'Reviewer',
    messages: [],
  });
  expect([...office().querySelectorAll<HTMLElement>('.office-desk')].map((d) => d.dataset.agent)).toEqual(['Planner', 'Reviewer']);
  expect(office().querySelector<HTMLElement>('.office-desk[data-agent="Reviewer"]')?.dataset.state).toBe('speaking');
  expect(office().querySelectorAll('.office-coffee-guest')).toHaveLength(0);

  // Switch to a workbench board (no discussion agents): shows only the worker at the workbench.
  reset({
    room: {
      ...baseRoom,
      board: 'Quick Fix',
      active: 'discussions/2026-11-28-fix',
      workbench: true,
      agents: [],
    },
    thinking: null,
    working: 'Worker',
    messages: [],
  });
  expect(office().querySelectorAll('.office-desk')).toHaveLength(0);
  expect(office().querySelector('.office-coffee')).toBeNull();
  const bench = office().querySelector<HTMLElement>('.office-workbench')!;
  expect(bench.dataset.state).toBe('working');
  expect(within(bench).getByText('Worker')).toBeTruthy();
  expect(within(bench).getByLabelText('Worker hammering')).toBeTruthy();
});

it('computePassedAgents only considers messages after the last User message', () => {
  expect(computePassedAgents([
    { speaker: 'Codex', pass: true },
    { speaker: 'User', pass: false },
    { speaker: 'Claude', pass: true },
    { speaker: 'Agy', pass: true },
    { speaker: 'Agy', pass: false },
  ])).toEqual(['Claude']);
});
