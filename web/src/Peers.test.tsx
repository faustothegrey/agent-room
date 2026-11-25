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
const room = { folder: '/Users/me/my-room', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, multi: true, brainstorm: false, research: false, workbench: false, open: [], checkpoints: [], researches: [], closedDiscussions: [], closingDiscussions: {}, rollbacks: [] };
const line = { discussion: 'd1', node: 'mini', commit: 'c1', round: 3, name: '2026-11-20-shared-plan', title: 'Shared plan', receivedAt: '2026-11-25T08:00:00Z', local: null };
const replica = { node: 'studio', addresses: ['192.168.1.5:8080'], roomId: 'r1', project: { commit: 'abc', dirty: true }, own: { '2026-11-25-live': { discussion: 'd9', round: 2, sent: {} } }, received: [line],
  peers: [{ name: 'mini', address: '192.168.1.6:8080', reachable: true, since: null, activity: 'Ada is thinking', project: { commit: 'def', dirty: false }, paired: true, mismatch: false, error: null },
    { name: 'air', address: '192.168.1.7:8080', reachable: false, since: '2026-11-25T07:00:00Z', activity: null, project: null, paired: false, mismatch: false, error: 'timeout' }] };
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fail = (status: number, text: string) => ({ ok: false, status, json: async () => ({}), text: async () => text });
let answer: (url: string, body: Record<string, unknown> | null) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '__health' ? new Promise(() => {}) : answer(url, init?.body ? JSON.parse(String(init.body)) : null));
const bodies = (path: string) => fetchMock.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(String(init?.body)));
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, messages: [{ speaker: 'Ada', html: '<p>Local talk</p>' }], worker: [], input: true, workInput: true, replica, replicaOff: null, newRoom: true, ...extra });
const log = () => screen.getByRole('log', { name: 'System messages' });
beforeEach(() => { localStorage.clear(); answer = () => ok([]); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('switches room from a chooser of this server rooms, in this tab or a new window', async () => {
  const rooms = [{ id: 'a', path: '/r/a/__room', root: '/Users/me/my-room', discussion: 'discussions/live', pages: 1, current: true },
    { id: 'b', path: '/r/b/__room', root: '/Users/me/other', discussion: null, pages: 0, current: false },
    { id: 'c', path: '/r/c/__room', root: '/Users/me/busy', discussion: 'discussions/x', pages: 2, current: false }];
  answer = (url) => url === '__rooms' ? ok(rooms) : ok([]);
  const navigate = vi.fn(), open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<App version="one" refresh={() => {}} navigate={navigate} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  const chooser = await screen.findByRole('combobox', { name: 'Running rooms' });
  const groups = [...chooser.querySelectorAll('optgroup')];
  expect(groups.map((g) => g.label)).toEqual(['Switch this tab to', 'Open in new window']);
  const options = [...groups[0].querySelectorAll('option')];
  expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
    ['/Users/me/my-room · discussions/live · 1 page open (current)', true],
    ['/Users/me/other · No discussion started · 0 pages open', false],
    ['/Users/me/busy · discussions/x · 2 pages open (open in another window)', true]]);
  fireEvent.change(chooser, { target: { value: 'window:/r/b/__room' } });
  expect(open).toHaveBeenCalledWith(new URL('/r/b/__next', location.href).href, '_blank', expect.stringMatching(/^width=/));
  expect(within(log()).getByText(/The browser blocked the new window; open .*\/r\/b\/__next yourself\./).className).toBe('status error');
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Running rooms' }), { target: { value: 'tab:/r/b/__room' } });
  expect(navigate).toHaveBeenCalledWith(new URL('/r/b/__next', location.href).href);
  answer = (url) => url === '__rooms' ? ok([rooms[0]]) : ok([]);
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  expect(await within(log()).findByText('No other rooms are open on this server: Open room in folder… adds one.')).toBeTruthy();
  answer = (url) => url === '__rooms' ? fail(409, 'Room discovery is unavailable.') : ok([]);
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  expect(await within(log()).findByText('✗ Switch room: Room discovery is unavailable.')).toBeTruthy();
});

it('opens a room in a folder: asks before creating one, says when it is already open, and reports errors', async () => {
  const win = { document: { body: { textContent: '' } }, close: vi.fn(), location: { href: '' } };
  vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
  let step: Record<string, unknown> = { confirm: true, folder: '/Users/me/new', token: 't1' };
  answer = (url, body) => url === '__newroom' ? (body?.token && !body.cancel ? ok({ url: '/r/n/__room', folder: '/Users/me/new' }) : ok(step)) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open room in folder…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Create a room in /Users/me/new?' });
  await user.click(within(dialog).getByRole('button', { name: 'Create room' }));
  await waitFor(() => expect(win.location.href).toBe(new URL('/r/n/__next', location.href).href));
  expect(bodies('__newroom')).toEqual([{}, { token: 't1' }]);
  expect(within(log()).getByText('Opened a new room in /Users/me/new. This room keeps running.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Open room in folder…' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Create a room in /Users/me/new?' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(bodies('__newroom').at(-1)).toEqual({ token: 't1', cancel: true }));
  step = { url: '/r/o/__room', folder: '/Users/me/old', existing: true, open: true };
  await user.click(screen.getByRole('button', { name: 'Open room in folder…' }));
  expect(await screen.findByRole('dialog', { name: 'The room in /Users/me/old is already open in another window.' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'OK' }));
  answer = (url) => url === '__newroom' ? fail(409, "This room can't open another one.") : ok([]);
  await user.click(screen.getByRole('button', { name: 'Open room in folder…' }));
  expect(await within(log()).findByText("✗ Open room: This room can't open another one.")).toBeTruthy();
  reset({ newRoom: false }); expect(screen.queryByRole('button', { name: 'Open room in folder…' })).toBeNull();
});

it('shows peers with reachability and pairs after confirming both folders; warns when peers are unreachable', async () => {
  answer = (url, body) => url === '__pair' ? (body?.confirm ? ok({}) : ok({ local: { node: 'studio', root: '/Users/me/my-room', roomId: 'r1' }, peer: { node: 'air', root: '/Users/air/room' } })) : ok([]);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const warning = screen.getByRole('button', { name: '1 peer unreachable' }); expect(warning.textContent).toBe('⚠');
  await user.click(warning);
  const dialog = await screen.findByRole('dialog', { name: 'Peers' });
  const rows = [...dialog.querySelectorAll('.peer-row')];
  expect(rows[0].textContent).toBe('● mini · 192.168.1.6:8080 · Ada is thinking · paired · project def');
  expect(rows[1].textContent).toMatch(/^● air · 192\.168\.1\.7:8080 · unreachable since .+ · not pairedPair with air… · project version unavailable$/);
  expect(rows[1].getAttribute('title')).toBe('timeout');
  await user.click(within(dialog).getByRole('button', { name: 'Pair with air…' }));
  await waitFor(() => expect(bodies('__pair')).toEqual([{ peer: 'air' }, { peer: 'air', confirm: true }]));
  expect(confirm).toHaveBeenCalledWith('Pair these room folders?\nstudio: /Users/me/my-room\nair: /Users/air/room');
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Peers' })).toBeNull();
  reset({ replica: null, replicaOff: 'Replication is off: start the room with --node.' });
  expect(screen.queryByRole('button', { name: /peers? unreachable/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Peers…' }));
  expect(within(await screen.findByRole('dialog', { name: 'Peers' })).getByText('Replication is off: start the room with --node.')).toBeTruthy();
});

it('shows the room folder and replica line beside the room menu', () => {
  render(<App version="one" refresh={() => {}} />); reset();
  expect(screen.getByLabelText('Room details').textContent).toBe("/Users/me/my-room" + "studio 192.168.1.5:8080 · studio's line, round 2 · agents run on studio · Project abc + uncommitted");
});

it('lists received lines, peeks at their files and views a peer chat read-only until Back', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const viewed = { ...line, messages: [{ speaker: 'Bo', html: '<p>Peer talk</p>' }, { speaker: 'Cy', html: '<p>pass</p>', pass: true }] };
  let renew = ok({ viewing: true });
  answer = (url, body) => url.startsWith('__rfiles') ? ok(['notes.md', 'drawings/a.svg']) : url === '__view' ? (body?.renew ? renew : body?.back ? ok({ viewing: null }) : ok({ viewing: viewed })) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ replica: { ...replica, own: {} } }); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const section = screen.getByText('Received from peers (1)').closest('details')!;
  expect(section.open).toBe(false); await user.click(within(section).getByText('Received from peers (1)'));
  await user.click(within(section).getByRole('button', { name: 'Shared plan' }));
  const files = screen.getByLabelText('Peeked board files');
  expect(within(files).getByText('Shared plan')).toBeTruthy();
  await user.click(await within(files).findByRole('button', { name: 'notes.md' }));
  expect(fetchMock).toHaveBeenCalledWith('__rfiles?d=d1&n=mini&c=c1');
  expect(screen.getByTitle('Document viewer').getAttribute('src')).toBe('__received/d1/mini/c1/notes.md');
  await user.click(screen.getByRole('button', { name: 'Explorer tab' }));
  await user.click(within(files).getByRole('button', { name: 'Back to current' }));
  expect(screen.getByLabelText('Explorer files')).toBeTruthy();

  await user.click(within(section).getByLabelText('Board actions for Shared plan'));
  await user.click(within(section).getByRole('button', { name: 'View chat' }));
  await waitFor(() => expect(screen.getByText('Peer talk')).toBeTruthy());
  expect(bodies('__view')).toEqual([{ discussion: 'd1', node: 'mini' }]);
  expect(screen.queryByText('Local talk')).toBeNull(); expect(screen.queryByText('pass')).toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Shared plan');
  const banner = screen.getByRole('status', { name: 'Viewing a peer' });
  expect(banner.textContent).toMatch(/^mini's line, round 3, received .+\. Read-only\.Local studio: discussion idle · worker idle$/);
  expect(screen.queryByRole('textbox', { name: 'Message to the agents' })).toBeNull();
  Source.current.send({ type: 'message', message: { speaker: 'Ada', html: '<p>Live while away</p>' } });
  expect(screen.queryByText('Live while away')).toBeNull();
  expect(screen.getByLabelText('Room details').textContent).toMatch(/\[Viewing mini's line, round 3, received .+ · read-only\] · mini: Ada is thinking/);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(bodies('__view').at(-1)).toEqual({ renew: true });
  renew = fail(400, 'View expired. Select the line again.');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(banner.textContent).toContain('View expired. Select the received line again.');
  Source.current.send({ type: 'replica', replica: { ...replica, own: { other: { discussion: 'd1', round: 1, sent: {} } }, received: [{ ...line, commit: 'c2', round: 4 }] } });
  expect(within(banner).getByRole('button', { name: 'View newer received round 4' })).toBeTruthy();
  await user.click(within(banner).getByRole('button', { name: "Back to studio's line" }));
  await waitFor(() => expect(screen.getByText('Live while away')).toBeTruthy());
  expect(bodies('__view').at(-1)).toEqual({ back: true }); expect(screen.getByText('Local talk')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message to the agents' })).toBeTruthy();
});

it('reports a refused View chat and keeps the local chat', async () => {
  answer = (url) => url === '__view' ? fail(409, "This room doesn't replicate (start it with --node).") : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ replica: { ...replica, own: {} } }); const user = userEvent.setup();
  const section = screen.getByText('Received from peers (1)').closest('details')!; await user.click(within(section).getByText('Received from peers (1)'));
  await user.click(within(section).getByLabelText('Board actions for Shared plan'));
  await user.click(within(section).getByRole('button', { name: 'View chat' }));
  expect(await within(log()).findByText("This room doesn't replicate (start it with --node).")).toBeTruthy();
  expect(screen.getByText('Local talk')).toBeTruthy();
});

it('hides received lines that are this node own discussions', async () => {
  answer = (url) => url.startsWith('__files') ? ok({ files: ['discussions/2026-11-25-live/notes.md'], unviewable: [] }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ replica: { ...replica, received: [{ ...line, discussion: 'd9' }, { ...line, discussion: 'd2', local: 'mine' }, { ...line, discussion: 'd3' }] } });
  await screen.findByLabelText('Board actions for Live');
  expect(screen.getByText('Received from peers (1)')).toBeTruthy(); // only d3: d9 is this node's own line, d2 is a local discussion
});

it('keeps one menu open at a time across the header, Actions and the row menus', async () => {
  answer = (url) => url.startsWith('__files') ? ok({ files: ['discussions/2026-11-25-live/notes.md'], unviewable: [] }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const roomMenu = screen.getByText('my-room').closest('details')!, serverMenu = screen.getByText('Server').closest('details')!;
  await user.click(screen.getByText('my-room')); expect(roomMenu.open).toBe(true);
  await user.click(screen.getByText('Server')); await waitFor(() => expect(roomMenu.open).toBe(false)); expect(serverMenu.open).toBe(true);
  const actions = screen.getByLabelText('Discussion actions').closest('details')!;
  await user.click(screen.getByLabelText('Discussion actions')); await waitFor(() => expect(serverMenu.open).toBe(false)); expect(actions.open).toBe(true);
  await user.click(await screen.findByLabelText('Board actions for Live'));
  await waitFor(() => expect(actions.open).toBe(false));
  const rowMenu = screen.getByLabelText('Board actions for Live').closest('details')!; expect(rowMenu.open).toBe(true);
  await user.click(screen.getByText('my-room')); await waitFor(() => expect(rowMenu.open).toBe(false)); expect(roomMenu.open).toBe(true);
});
