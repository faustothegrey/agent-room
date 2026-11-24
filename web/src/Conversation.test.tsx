import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class Source {
  static current: Source;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(event: object) { act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent)); }
}
const room = { discussion: 'Discussion', started: true, autoDev: { status: null } };
const message = (speaker: string, html: string, fields: object = {}) => ({ speaker, html, error: false, pass: false, ...fields });
beforeEach(() => vi.stubGlobal('EventSource', Source));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders live and snapshot messages, hides passes and summary drafts, and keeps summary labels', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, thinking: null, messages: [
    message('A', '<p>secret pass</p>', { pass: true }),
    message('A', '<p>secret draft</p>', { hidden: true }),
    message('Summary — agreed, by A', '<p>Decision <em>yes</em></p>', { outcome: 'agreed' }),
    message('Summary — not agreed: the last version, by B', '<p>Last version</p>', { outcome: 'not-agreed' }),
    message('A', '<p>quota error</p>', { error: true, errorText: 'quota error' }),
  ] });
  expect(screen.queryByText('secret pass')).toBeNull(); expect(screen.queryByText('secret draft')).toBeNull();
  expect(screen.getByText('Summary — agreed, by A')).toBeTruthy();
  expect(screen.getByText('Summary — not agreed: the last version, by B').closest('article')?.className).toContain('not-agreed');
  expect(screen.getByText('yes').tagName).toBe('EM');
  expect(screen.getByText('A — failed')).toBeTruthy();
  expect(screen.queryByLabelText('Dismiss pinned error')).toBeNull();
  Source.current.send({ type: 'message', message: message('B', '<p>live</p>') });
  Source.current.send({ type: 'message', message: message('B', '<p>live hidden</p>', { hidden: true }) });
  Source.current.send({ type: 'message', message: message('B', '<p>live pass</p>', { pass: true }) });
  expect(screen.getByText('live')).toBeTruthy(); expect(screen.queryByText('live hidden')).toBeNull(); expect(screen.queryByText('live pass')).toBeNull();
});

it('pins live errors until dismissed, counts earlier errors, and retains the complete error', async () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [] });
  Source.current.send({ type: 'message', message: message('Ada', '<p>bad</p>', { error: true, errorText: 'first\nfull detail' }) });
  expect(screen.getByTitle(/first\s+full detail/).textContent).toMatch(/Ada failed .*: first$/);
  Source.current.send({ type: 'agent-failure', agent: 'Bo', error: 'second\nmore' });
  expect(screen.getByTitle(/second\s+more/).textContent).toMatch(/Bo failed .*: second \(\+1 earlier\)$/);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss pinned error' }));
  expect(screen.queryByLabelText('Dismiss pinned error')).toBeNull();
  Source.current.send({ type: 'agent-failure', agent: 'Ada', error: 'again' });
  expect(screen.getByTitle('again').textContent).not.toContain('earlier');
});

it('tracks thinking, your turn, user speech, auto dev and the last two status lines', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], thinking: 'Ada', status: 'round starting' });
  expect(screen.getByText('Ada is thinking…')).toBeTruthy();
  expect(screen.queryByLabelText('Turn status')).toBeNull();
  Source.current.send({ type: 'thinking', name: null });
  Source.current.send({ type: 'turn', text: 'your turn · all passed' });
  expect(screen.getByLabelText('Turn status').textContent).toBe('your turn');
  Source.current.send({ type: 'message', message: message('User', '<p>next</p>') });
  expect(screen.queryByLabelText('Turn status')).toBeNull();
  Source.current.send({ type: 'note', text: 'second', error: false });
  Source.current.send({ type: 'note', text: 'third', error: true });
  expect(screen.queryByText('round starting')).toBeNull();
  expect(screen.queryByText('your turn · all passed')).toBeNull();
  expect(screen.getByText('second')).toBeTruthy(); expect(screen.getByText('third').className).toContain('error');
  Source.current.send({ type: 'room', room: { ...room, autoDev: { status: 'running' } } });
  Source.current.send({ type: 'turn', text: 'your turn · agent done' });
  expect(screen.queryByLabelText('Turn status')).toBeNull();
});

it('shows a delayed busy indicator from reset and events and briefly marks errors', () => {
  vi.useFakeTimers();
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room, messages: [], busy: true });
  expect(screen.queryByLabelText('Busy')).toBeNull();
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByLabelText('Busy').dataset.state).toBe('on');
  Source.current.send({ type: 'note', text: 'failed', error: true });
  expect(screen.getByLabelText('Busy').dataset.state).toBe('failed');
  Source.current.send({ type: 'busy', on: false });
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.queryByLabelText('Busy')).toBeNull();
  Source.current.send({ type: 'busy', on: true });
  act(() => vi.advanceTimersByTime(299)); expect(screen.queryByLabelText('Busy')).toBeNull();
  Source.current.send({ type: 'busy', on: false });
  act(() => vi.advanceTimersByTime(1)); expect(screen.queryByLabelText('Busy')).toBeNull();
});

it('reports room end and restart on the status line', () => {
  const first = render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'ended' });
  expect(screen.getByText('This room has ended. You can close this window.')).toBeTruthy();
  first.unmount();
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'restarting' });
  expect(screen.getByText('Restarting the server: this page reloads when the new one answers.')).toBeTruthy();
});

it('uses the legacy display title when the stored title is a dated folder name', () => {
  render(<App version="one" refresh={() => {}} />);
  Source.current.send({ type: 'reset', room: { ...room, active: 'discussions/2026-11-23-a-subject', discussion: '2026-11-23-a-subject' }, messages: [] });
  expect(screen.getByRole('heading', { name: 'a subject' })).toBeTruthy();
});
