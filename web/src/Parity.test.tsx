import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
// Step 9a: the parity fixes found in the review.
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const room = { folder: '/room', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, multi: true, fresh: false, brainstorm: false, research: false, workbench: false, members: [], failedAgents: [], open: [] as object[], checkpoints: [], researches: [], closedDiscussions: [], closingDiscussions: {}, rollbacks: [], autoDev: { status: null } };
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
let answer: (url: string, body: Record<string, unknown> | null) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '__health' ? new Promise(() => {}) : answer(url, init?.body ? JSON.parse(String(init.body)) : null));
const bodies = (path: string) => fetchMock.mock.calls.filter(([url, init]) => url === path && init?.body).map(([, init]) => JSON.parse(String(init?.body)));
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, workInput: true, ...extra });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); answer = () => ok([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('starts another request on a second Enter while a message is on its way, without sending the same text twice', async () => {
  const pending: ((v: unknown) => void)[] = [];
  answer = (url) => url === '__say' ? new Promise((done) => pending.push(done)) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset();
  const box = screen.getByRole('textbox', { name: 'Message to the agents' }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: 'first' } }); fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.keyDown(box, { key: 'Enter' }); // the same text, still on its way: not again
  fireEvent.change(box, { target: { value: 'second' } }); fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(bodies('__say')).toEqual([{ text: 'first' }, { text: 'second' }]));
  await act(async () => { pending.forEach((done) => done(ok())); await Promise.resolve(); });
  await waitFor(() => expect(box.value).toBe(''));
});

it('keeps the room chooser open when it loses focus, until a room is chosen', async () => {
  answer = (url) => url === '__rooms' ? ok([{ id: 'a', path: '/r/a/__room', root: '/a', discussion: null, pages: 1, current: true }, { id: 'b', path: '/r/b/__room', root: '/b', discussion: null, pages: 0, current: false }]) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Switch room…' }));
  const chooser = await screen.findByRole('combobox', { name: 'Running rooms' });
  fireEvent.blur(chooser); await user.click(document.body);
  expect(screen.getByRole('combobox', { name: 'Running rooms' })).toBeTruthy();
});

it('opens the members panel after a Peek for a board that became fresh meanwhile', async () => {
  answer = (url) => url === '__settings' ? ok({ settings: { agents: [{ name: 'A', provider: 'claude', model: '' }, { name: 'B', provider: 'codex', model: '' }], worker: { name: 'W', provider: 'claude', model: '' } }, started: false, models: { claude: [], codex: [], agy: [] } }) : ok([]);
  render(<App version="one" refresh={() => {}} />);
  reset({ peek: { name: 'old', kind: 'discussion', path: 'discussions/old', title: 'Old' } });
  reset({ room: { ...room, fresh: true, active: null }, peek: { name: 'old', kind: 'discussion', path: 'discussions/old', title: 'Old' } }); // became fresh while peeking
  expect(screen.queryByRole('form', { name: 'Discussion members' })).toBeNull();
  reset({ room: { ...room, fresh: true, active: null } });
  expect(await screen.findByRole('form', { name: 'Discussion members' })).toBeTruthy();
});

it('asks about an unsaved note before a row menu’s Continue shows a board open elsewhere', async () => {
  const other = '2026-11-24-other';
  answer = (url) => url.startsWith('__files') ? ok({ files: ['discussions/2026-11-25-live/notes.md', 'discussions/' + other + '/notes.md'], unviewable: [], branch: 'main' })
    : url === '__notes' ? ok([]) : ok([]);
  const navigate = vi.fn();
  render(<App version="one" refresh={() => {}} navigate={navigate} />);
  reset({ room: { ...room, open: [{ url: '/r/x/__room?d=' + other, current: false, title: 'Other', active: 'discussions/' + other, brainstorm: false, workbench: false, research: false, started: true, working: false, workerBusy: false, ongoing: false }] } });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '📝 My notes' }));
  await user.click(await screen.findByRole('button', { name: 'New' })); await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Unsaved');
  await user.click(screen.getByRole('button', { name: 'Close services panel' }));
  await user.click(await screen.findByLabelText('Board actions for Other'));
  await user.click(within(screen.getByLabelText('Board actions for Other').parentElement!).getByRole('button', { name: 'Continue' }));
  expect(navigate).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole('alertdialog', { name: '"Unsaved" has unsaved changes.' })).getByRole('button', { name: 'Discard changes' }));
  expect(navigate).toHaveBeenCalledWith('/r/x/__next?d=' + other);
});

it('waits for a pending members save before a Providers save', async () => {
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  const agents = [{ name: 'A', provider: 'claude', model: '' }, { name: 'B', provider: 'codex', model: '' }], worker = { name: 'W', provider: 'claude', model: '' };
  const order: string[] = [];
  answer = (url, body) => {
    if (url !== '__settings') return ok([]);
    if (!body) return ok({ settings: { agents, worker }, started: false, models: { claude: [{ id: 'opus', label: 'Opus' }], codex: [], agy: [] } });
    order.push('post ' + body.scope);
    return body.scope === 'talk' ? held.then(() => { order.push('done talk'); return ok({ applied: true }); }) : ok({ applied: false });
  };
  render(<App version="one" refresh={() => {}} />); reset({ room: { ...room, started: false } }); const user = userEvent.setup();
  await user.click(screen.getByText(/^Discussion members ·/));
  const members = await screen.findByRole('form', { name: 'Discussion members' });
  await user.selectOptions(await within(members).findByLabelText('Agent 1 model'), 'opus');
  await waitFor(() => expect(order).toEqual(['post talk']));
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  await act(async () => { release(); await held; });
  const providers = await screen.findByRole('form', { name: 'Default providers' });
  await user.selectOptions(await within(providers).findByLabelText('Worker model'), 'opus');
  await waitFor(() => expect(order).toEqual(['post talk', 'done talk', 'post defaults']));
});

it('queues a Providers save behind a members save still running', async () => {
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  const agents = [{ name: 'A', provider: 'claude', model: '' }, { name: 'B', provider: 'codex', model: '' }], worker = { name: 'W', provider: 'claude', model: '' };
  const order: string[] = [];
  let loads = 0;
  answer = (url, body) => {
    if (url !== '__settings') return ok([]);
    if (!body) { loads++; return ok({ settings: { agents, worker }, started: false, models: { claude: [{ id: 'opus', label: 'Opus' }], codex: [], agy: [] } }); }
    order.push('post ' + body.scope);
    return body.scope === 'talk' ? held.then(() => { order.push('done talk'); return ok({ applied: true }); }) : ok({ applied: false });
  };
  render(<App version="one" refresh={() => {}} />); reset({ room: { ...room, started: false } }); const user = userEvent.setup();
  // Providers first (loaded before the members save starts), then a members save, then a Providers save.
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  const providers = await screen.findByRole('form', { name: 'Default providers' }); await within(providers).findByLabelText('Worker model');
  await user.click(screen.getByText(/^Discussion members ·/));
  const members = await screen.findByRole('form', { name: 'Discussion members' });
  await user.selectOptions(await within(members).findByLabelText('Agent 1 model'), 'opus');
  await waitFor(() => expect(order).toEqual(['post talk']));
  await user.selectOptions(within(providers).getByLabelText('Worker model'), 'opus');
  await new Promise((done) => setTimeout(done, 20));
  expect(order).toEqual(['post talk']); // the Providers save waits in the queue
  await act(async () => { release(); await held; });
  await waitFor(() => expect(order).toEqual(['post talk', 'done talk', 'post defaults']));
  expect(loads).toBeGreaterThan(0);
});

it('labels the shown file by its board, lists its siblings, names the browser tab, and sends an earlier transcript to the agents', async () => {
  const files = ['discussions/2026-11-25-live/notes.md', 'discussions/2026-11-25-live/plan.md', 'discussions/2026-11-25-live/bundle.zip', 'discussions/2026-11-25-live/transcripts/2026-11-20.md', 'README.md'];
  answer = (url) => url.startsWith('__files') ? ok({ files, unviewable: [], branch: 'main' }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ room: { ...room, transcript: 'discussions/2026-11-25-live/transcripts/2026-11-25.md' } }); const user = userEvent.setup();
  expect(document.title).toBe('Live · agent-room');
  Source.current.send({ type: 'doc', file: 'discussions/2026-11-25-live/notes.md' });
  const label = screen.getByTitle('discussions/2026-11-25-live/notes.md');
  expect(label.textContent).toBe('Live · notes.md'); expect(document.title).toBe('Live · notes.md · agent-room');
  expect(screen.queryByRole('button', { name: 'Send to agents' })).toBeNull();
  await user.click(label);
  const menu = await screen.findByLabelText('Other files in this folder');
  await waitFor(() => expect([...menu.querySelectorAll('button')].map((b) => [b.textContent, b.disabled, b.className])).toEqual([['bundle.zip · can\'t be shown here', true, ''], ['notes.md', false, 'shown'], ['plan.md', false, '']]));
  await user.click(within(menu).getByRole('button', { name: 'plan.md' }));
  expect(bodies('__show')).toEqual([{ file: 'discussions/2026-11-25-live/plan.md' }]);
  Source.current.send({ type: 'doc', file: 'README.md' }); expect(screen.getByTitle('README.md').textContent).toBe('Room checkout · README.md');
  Source.current.send({ type: 'doc', file: 'discussions/2026-11-25-live/transcripts/2026-11-20.md' });
  await user.click(screen.getByRole('button', { name: 'Send to agents' }));
  expect(bodies('__say')).toEqual([{ text: 'Please read this transcript of an earlier session in full, as background for our discussion: /room/discussions/2026-11-25-live/transcripts/2026-11-20.md' }]);
  Source.current.send({ type: 'doc', file: 'discussions/2026-11-25-live/transcripts/2026-11-25.md' }); // this session's own transcript
  expect(screen.queryByRole('button', { name: 'Send to agents' })).toBeNull();
});

it('keeps the Worker box draft across a version refresh, as both boxes are kept on /__room', async () => {
  const refresh = vi.fn(); const first = render(<App version="one" refresh={refresh} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /Worker/ }));
  await user.type(screen.getByRole('textbox', { name: 'Instruction to the worker' }), 'half an instruction');
  Source.current.send({ type: 'web-version', webVersion: 'two' }); expect(refresh).toHaveBeenCalled();
  first.unmount(); render(<App version="two" refresh={() => {}} />); reset();
  await user.click(screen.getByRole('tab', { name: /Worker/ }));
  expect((screen.getByRole('textbox', { name: 'Instruction to the worker' }) as HTMLTextAreaElement).value).toBe('half an instruction');
});

it('asks the room to recheck worker info when the Worker tab is shown, as /__room does', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const before = bodies('__workerinfo').length;
  await user.click(screen.getByRole('tab', { name: /Worker/ }));
  await waitFor(() => expect(bodies('__workerinfo')).toHaveLength(before + 1));
  await user.click(screen.getByRole('tab', { name: 'Discussion' })); expect(bodies('__workerinfo')).toHaveLength(before + 1); // only on showing Worker
});

it('never opens the Providers service by itself, also when a new discussion opens its members panel', async () => {
  answer = (url) => url === '__settings' ? ok({ settings: { agents: [{ name: 'A', provider: 'claude', model: '' }, { name: 'B', provider: 'codex', model: '' }], worker: { name: 'W', provider: 'claude', model: '' } }, started: false, models: { claude: [], codex: [], agy: [] } }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset();
  Source.current.send({ type: 'room', room: { ...room, fresh: true, active: null, started: false } });
  expect(await screen.findByRole('form', { name: 'Discussion members' })).toBeTruthy();
  expect(screen.getByLabelText('Services panel').hidden).toBe(true);
  expect(screen.getByRole('button', { name: '⚙ Providers' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('form', { name: 'Default providers' })).toBeNull();
});
