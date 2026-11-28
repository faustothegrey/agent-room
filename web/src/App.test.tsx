import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

class FakeEvents {
  static latest: FakeEvents;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { FakeEvents.latest = this; }
  send(data: unknown) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}

beforeEach(() => vi.stubGlobal('EventSource', FakeEvents));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('room shell', () => {
  it('applies reset, live messages, thinking, turn and reconnect reset', async () => {
    const view = render(<App version="one" refresh={vi.fn()} />);
    const source = FakeEvents.latest;
    expect(source.url).toBe('__events');
    source.send({ type: 'reset', webVersion: 'one', room: { board: 'A room' }, messages: [{ speaker: 'Ada', html: '<p>Hello <em>there</em> <a href="#details">Details</a></p>' }], thinking: null });
    expect(screen.getByRole('heading', { name: 'A room' })).toBeTruthy();
    expect(screen.getByText('there').tagName).toBe('EM');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Details' }));
    expect(location.hash).toBe('#details');
    source.send({ type: 'message', message: { speaker: 'Bo', html: '<p>Live</p>' } });
    expect(screen.getByText('Live')).toBeTruthy();
    source.send({ type: 'thinking', name: 'Ada' });
    expect(screen.getByText('… Ada is thinking')).toBeTruthy();
    source.send({ type: 'turn', text: 'your turn' });
    expect(screen.queryByText('… Ada is thinking')).toBeNull();
    expect(screen.getByText('your turn')).toBeTruthy();
    source.send({ type: 'reset', webVersion: 'one', room: { board: 'A room' }, messages: [{ speaker: 'Bo', html: '<p>Live</p>' }] });
    expect(screen.queryByText('there')).toBeNull();
    expect(screen.getAllByText('Live')).toHaveLength(1);
    view.unmount(); expect(source.close).toHaveBeenCalledOnce();
  });
  it('refreshes only when the web version changes', () => {
    const refresh = vi.fn(); render(<App version="one" refresh={refresh} />);
    FakeEvents.latest.send({ type: 'reloaded', page: 'old-page', webVersion: 'one' });
    expect(refresh).not.toHaveBeenCalled();
    FakeEvents.latest.send({ type: 'web-version', webVersion: 'two' });
    expect(refresh).toHaveBeenCalledOnce();
    FakeEvents.latest.send({ type: 'reloaded', page: 'same-page', webVersion: 'two' });
    FakeEvents.latest.send({ type: 'reset', webVersion: 'two', room: null, messages: [] });
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
