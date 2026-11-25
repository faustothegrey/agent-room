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
const room = { discussion: 'Live', active: 'discussions/live', started: true, brainstorm: false, research: false, workbench: false, retryId: 'retry-1' };
const message = (id: string, html = '<p>Failed report</p>') => ({ speaker: 'Worker report', html, error: true, retryId: id });
const models = { claude: [{ id: 'sonnet', label: 'Sonnet' }], codex: [{ id: 'codex-one', label: 'Codex One' }], agy: [] };
const settings = { settings: { agents: [], worker: { name: 'Worker', provider: 'claude', model: 'sonnet' } }, started: true, launchDefaults: { agents: [{ name: 'Latest', provider: 'codex', model: '' }], worker: { name: 'Previous', provider: 'agy', model: '' } }, models };
const fetchMock = vi.fn();
const reply = (value: unknown, ok = true) => ({ ok, text: async () => String(value), json: async () => value });
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => url === '__settings' ? reply(settings) : reply([])); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const setup = () => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, input: true, workInput: true, messages: [], worker: [message('older', '<p>Old failure</p>'), message('retry-1')] }); };

it('offers retry only on the current report, posts its id, and enables again after refusal', async () => {
  setup(); const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: 'Worker' }));
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  fetchMock.mockImplementation(async (url: string) => url === '__retry' ? reply('Retry refused', false) : reply([]));
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(within(screen.getByRole('log', { name: 'System messages' })).getByText('Worker · Retry refused').className).toBe('status error'));
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__retry')![1].body)).toEqual({ id: 'retry-1' });
  expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
  Source.current.send({ type: 'room', room: { ...room, retryId: null } }); expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('chooses provider and model, validates custom ID and submits with freshly read settings', async () => {
  setup(); const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: 'Worker' })); await user.click(screen.getByRole('button', { name: 'Retry with…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Retry with…' });
  expect((within(dialog).getByLabelText('Worker name') as HTMLInputElement).readOnly).toBe(true);
  await user.selectOptions(within(dialog).getByLabelText('Worker provider'), 'codex');
  await user.selectOptions(within(dialog).getByLabelText('Worker model'), '__custom');
  await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
  expect(within(dialog).getByRole('alert').textContent).toBe('Enter a custom model ID.');
  await user.type(within(dialog).getByLabelText('Worker custom model ID'), 'my-model');
  fetchMock.mockImplementation(async (url: string) => url === '__settings' ? reply({ ...settings, launchDefaults: { ...settings.launchDefaults, revision: 'latest' } }) : reply([]));
  await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Retry with…' })).toBeNull());
  expect(fetchMock.mock.calls.filter(([url]) => url === '__settings')).toHaveLength(2);
  expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url === '__retry')![1].body)).toEqual({ id: 'retry-1', settings: { ...settings.launchDefaults, revision: 'latest', worker: { name: 'Worker', provider: 'codex', model: 'my-model' }, scope: 'work' } });
});

it('keeps retry-with failures in the dialog and reports settings-load errors as Worker errors', async () => {
  setup(); const user = userEvent.setup(); await user.click(screen.getByRole('tab', { name: 'Worker' }));
  fetchMock.mockImplementation(async (url: string) => url === '__settings' ? reply('Settings unavailable', false) : reply([]));
  await user.click(screen.getByRole('button', { name: 'Retry with…' })); await waitFor(() => expect(within(screen.getByRole('log', { name: 'System messages' })).getByText('Worker · Settings unavailable').className).toBe('status error'));
  fetchMock.mockImplementation(async (url: string) => url === '__settings' ? reply(settings) : url === '__retry' ? reply('Retry refused', false) : reply([]));
  await user.click(screen.getByRole('button', { name: 'Retry with…' })); const dialog = await screen.findByRole('dialog', { name: 'Retry with…' });
  await user.click(within(dialog).getByRole('button', { name: 'Retry' })); expect((await within(dialog).findByRole('alert')).textContent).toBe('Retry refused');
});
