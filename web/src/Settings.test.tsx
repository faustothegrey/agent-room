import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
class Source {
  static current: Source;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(_url: string) { Source.current = this; }
  close() {}
  send(data: object) { act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
}
const models = { claude: [{ id: 'opus', label: 'Opus' }], codex: [{ id: 'gpt', label: 'GPT' }], agy: [] };
const worker = { name: 'Worker', provider: 'claude', model: '' };
const agents = [{ name: 'Claude', provider: 'claude', model: 'opus' }, { name: 'Codex', provider: 'codex', model: '' }];
const settings = (started = false, extra: object = {}) => ({ settings: { agents, worker, autoDev: 5 }, defaults: { agents, worker, autoDev: 7 }, launchDefaults: { agents, worker: { ...worker, name: 'Launch' }, autoDev: 9 }, started, models, ...extra });
const room = { folder: '/room', board: 'Live', active: 'discussions/2026-11-25-live', started: false, fresh: false, brainstorm: false, research: false, workbench: false, open: [], members: [], failedAgents: [],
  cliSessions: { agents: [{ name: 'Claude', provider: 'claude', id: 's-1' }, { name: 'Codex', provider: 'codex', id: null }], worker: { name: 'Worker', provider: 'claude', id: null } }, workerModel: 'Claude default' };
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fail = (text: string) => ({ ok: false, status: 400, json: async () => ({}), text: async () => text });
let answer: (url: string, body: Record<string, unknown> | null) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '__health' ? new Promise(() => {}) : answer(url, init?.body ? JSON.parse(String(init.body)) : null));
const calls = () => fetchMock.mock.calls.map(([url]) => url).filter((url) => url === '__settings' || url === '__agent-enabled' || url === '__retry');
const bodies = (path: string) => fetchMock.mock.calls.filter(([url, init]) => url === path && init?.body).map(([, init]) => JSON.parse(String(init?.body)));
const reset = (r: object = room, extra: object = {}) => Source.current.send({ type: 'reset', room: r, messages: [], worker: [], input: true, workInput: true, ...extra });
const openPanel = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => { await user.click(screen.getByText(name)); return await screen.findByRole('form', { name: name.source.includes('Worker') ? 'Worker settings' : 'Discussion members' }); };
beforeEach(() => { answer = (url) => url === '__settings' ? ok(settings()) : ok([]); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('chooses two or three members before the start, keeps two, and saves the whole settings in order', async () => {
  answer = (url, body) => url === '__settings' ? (body ? ok({ applied: true }) : ok(settings())) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const form = await openPanel(user, /^Discussion members/);
  expect(await within(form).findByText('Changes save automatically and apply to this room before any agent starts.')).toBeTruthy();
  expect((within(form).getByLabelText('Agent 3 name') as HTMLInputElement).value).toBe('Agy');
  expect((within(form).getByLabelText('Agent 1 On') as HTMLInputElement).disabled).toBe(true); // two on: each is locked
  expect(within(form).getByText('At least two members. To swap one, tick the new row first, then untick the old one.')).toBeTruthy();
  expect((within(form).getByLabelText('Agent 1 model') as HTMLSelectElement).value).toBe('opus');
  expect(within(form).getByText('Claude (claude) session ID: s-1')).toBeTruthy();
  expect(within(form).getByText('Codex (codex) session ID: available after its first completed turn')).toBeTruthy();
  await user.click(within(form).getByLabelText('Agent 3 On'));
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Saved.'));
  expect(bodies('__settings')).toEqual([{ agents: [...agents, { name: 'Agy', provider: 'agy', model: '' }], worker, autoDev: 5, scope: 'talk' }]);
  expect((within(form).getByLabelText('Agent 1 On') as HTMLInputElement).disabled).toBe(false);
  await user.selectOptions(within(form).getByLabelText('Agent 3 provider'), 'codex');
  expect((within(form).getByLabelText('Agent 3 name') as HTMLInputElement).value).toBe('Codex2'); // an automatic name follows its provider
  await waitFor(() => expect(bodies('__settings')).toHaveLength(2));
});

it('asks for a custom model ID before saving it, refuses a member named as the worker, and reports a failed save', async () => {
  answer = (url, body) => url === '__settings' ? (body ? fail('Unknown provider') : ok(settings())) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const form = await openPanel(user, /^Discussion members/); await within(form).findByLabelText('Agent 2 model');
  await user.selectOptions(within(form).getByLabelText('Agent 2 model'), 'Custom…');
  expect(within(form).getByRole('status').textContent).toBe('Enter a custom model ID to save this choice.'); expect(bodies('__settings')).toEqual([]);
  await user.type(within(form).getByLabelText('Agent 2 custom model ID'), 'gpt-x'); await user.tab();
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Could not save: Unknown provider'));
  expect((bodies('__settings')[0].agents as object[])[1]).toEqual({ name: 'Codex', provider: 'codex', model: 'gpt-x' });
  const name = within(form).getByLabelText('Agent 1 name'); await user.clear(name); await user.type(name, 'worker'); await user.tab();
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Could not save: Each member and the worker need a different name.'));
  expect(bodies('__settings')).toHaveLength(1);
});

it('serializes saves from both panels, and Retry with… waits for them', async () => {
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  answer = (url, body) => url === '__settings' ? (body ? held.then(() => ok({ applied: false })) : ok(settings(true))) : ok([]);
  render(<App version="one" refresh={() => {}} />);
  reset({ ...room, started: true, retryId: 'r1' }, { worker: [{ speaker: 'Worker report', html: '<p>failed</p>', error: true, retryId: 'r1' }] }); const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /Worker/ }));
  const form = await openPanel(user, /^Worker ·/);
  expect(await within(form).findByText(/^Changes apply to this sprint only, starting with the next instruction\./)).toBeTruthy();
  await user.selectOptions(within(form).getByLabelText('Worker model'), 'opus');
  await waitFor(() => expect(bodies('__settings')).toHaveLength(1));
  await user.selectOptions(within(form).getByLabelText('Worker provider'), 'codex');
  await user.click(screen.getByRole('button', { name: 'Retry with…' }));
  await new Promise((done) => setTimeout(done, 20));
  expect(calls()).toEqual(['__settings', '__settings', '__settings']); // open, first save's read and post; the second save and Retry with… wait
  await act(async () => { release(); await held; });
  await waitFor(() => expect(bodies('__settings')).toHaveLength(2));
  expect(bodies('__settings').map((b) => [b.worker, b.autoDev, b.scope])).toEqual([[{ ...worker, model: 'opus' }, 9, 'work'], [{ ...worker, model: '', provider: 'codex' }, 9, 'work']]);
  expect(within(form).getByRole('status').textContent).toBe('Saved for future rooms. This room keeps its settings.');
  expect(await screen.findByRole('dialog', { name: 'Retry with…' })).toBeTruthy();
  expect(calls().at(-1)).toBe('__settings');
});

it('shows a started discussion its members, read-only, with On boxes that leave one out', async () => {
  const members = [{ name: 'Claude', provider: 'claude', model: 'opus', modelLabel: 'Opus', enabled: true }, { name: 'Codex', provider: 'codex', model: '', modelLabel: 'Codex default', enabled: true }];
  answer = (url, body) => url === '__settings' ? ok(settings(true)) : url === '__agent-enabled' ? (body?.name === 'Claude' ? fail('busy') : ok()) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ ...room, started: true, members }); const user = userEvent.setup();
  expect(screen.getByText('Discussion members ·').textContent).toBe('Discussion members · Opus, Codex default');
  const form = await openPanel(user, /^Discussion members/);
  expect(await within(form).findByText(/^This board’s members\./)).toBeTruthy();
  expect((within(form).getByLabelText('Agent 1 provider') as HTMLSelectElement).disabled).toBe(true);
  expect((within(form).getByLabelText('Agent 1 name') as HTMLInputElement).disabled).toBe(true);
  await user.click(within(form).getByLabelText('Agent 2 On'));
  await waitFor(() => expect(bodies('__agent-enabled')).toEqual([{ name: 'Codex', enabled: false, member: true }]));
  expect((within(form).getByLabelText('Agent 1 On') as HTMLInputElement).disabled).toBe(true); // the last one on stays
  Source.current.send({ type: 'room', room: { ...room, started: true, members: [members[0], { ...members[1], enabled: false }] } });
  await user.click(within(form).getByLabelText('Agent 2 On'));
  await waitFor(() => expect(bodies('__agent-enabled')).toHaveLength(2));
  Source.current.send({ type: 'room', room: { ...room, started: true, members } });
  await user.click(within(form).getByLabelText('Agent 1 On'));
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Could not change Claude: busy'));
  expect((within(form).getByLabelText('Agent 1 On') as HTMLInputElement).checked).toBe(true);
  expect(bodies('__settings')).toEqual([]);
});

it('opens the members panel for a fresh discussion, and hides it while peeking and on a workbench', async () => {
  render(<App version="one" refresh={() => {}} />); reset();
  expect(screen.queryByRole('form', { name: 'Discussion members' })).toBeNull();
  Source.current.send({ type: 'room', room: { ...room, fresh: true, active: null } });
  expect(await screen.findByRole('form', { name: 'Discussion members' })).toBeTruthy();
  reset({ ...room }, { peek: { name: 'old', kind: 'sprint', path: 'discussions/old', title: 'Old' } });
  expect(screen.queryByText(/^Discussion members/)).toBeNull();
  reset({ ...room, workbench: true }); expect(screen.queryByText(/^Discussion members/)).toBeNull();
});

it('reports a settings load failure in the panel', async () => {
  answer = (url) => url === '__settings' ? fail('Settings are unavailable.') : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const form = await openPanel(user, /^Discussion members/);
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Could not load settings: Settings are unavailable.'));
});

it('offers Disable for a failed agent and Enable for a disabled one', async () => {
  answer = (url, body) => url === '__agent-enabled' ? (body?.name === 'Codex' ? fail('No such agent.') : ok()) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset({ ...room, failedAgents: [{ name: 'Claude', disabled: false }, { name: 'Codex', disabled: true }] }); const user = userEvent.setup();
  const panel = screen.getByRole('status', { name: 'Failed agents' });
  expect(panel.textContent).toBe('Claude failed. DisableCodex is disabled. Enable');
  await user.click(within(panel).getByRole('button', { name: 'Disable' }));
  await user.click(within(panel).getByRole('button', { name: 'Enable' }));
  await waitFor(() => expect(bodies('__agent-enabled')).toEqual([{ name: 'Claude', enabled: false }, { name: 'Codex', enabled: true }]));
  expect(await within(screen.getByRole('log', { name: 'System messages' })).findByText('No such agent.')).toBeTruthy();
});
