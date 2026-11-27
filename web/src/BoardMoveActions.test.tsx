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
const live = '2026-11-01-live', closed = '2026-11-02-closed', old = '2026-10-01-old', idea = '2026-10-02-idea';
const files = [`discussions/${live}/notes.md`, `discussions/${closed}/notes.md`, `discussions/archive/${old}/notes.md`, `brainstorms/deferred/${idea}/notes.md`];
const room = { folder: '/room', active: `discussions/${live}`, discussion: 'Live', started: true, multi: true, brainstorm: false, research: false, workbench: false, workbenches: [], researches: [], closedDiscussions: [closed, old], checkpoints: [], open: [], autoDev: { status: null } };
const fetchMock = vi.fn();
const says = () => fetchMock.mock.calls.filter(([url]) => url === '__say').map(([, init]) => JSON.parse(init.body).text);
const setup = () => { render(<App version="one" refresh={() => {}} />); Source.current.send({ type: 'reset', room, messages: [], input: true, peek: null, doc: null }); };
const menu = (name: string) => screen.getByLabelText(`Board actions for ${name}`).parentElement!;
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); fetchMock.mockImplementation(async (url: string) => ({ ok: true, text: async () => '', json: async () => url.includes('detail=1') ? { files, unviewable: [], branch: null } : [] })); vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('EventSource', Source); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('only enables Archive and Defer for closed non-current boards', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for Live'));
  expect((within(menu('Live')).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(menu('Live')).getByRole('button', { name: 'Defer' }).title).toBe('Close the sprint before moving it into deferred/.');
  await user.click(screen.getByLabelText('Board actions for closed'));
  expect((within(menu('closed')).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(within(menu('closed')).getByRole('button', { name: 'Defer' }));
  await waitFor(() => expect(says()).toEqual(['/move ' + closed + ' deferred']));
});

it('keeps an accepted archive pending until moved or an error and never sends twice while pending', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  await user.click(within(menu('closed')).getByRole('button', { name: 'Archive' }));
  const archive = within(menu('closed')).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
  expect(archive.disabled).toBe(true); expect(archive.getAttribute('aria-busy')).toBe('true');
  await user.click(archive); expect(says()).toEqual(['/move ' + closed + ' archive']);
  Source.current.send({ type: 'note', error: true, text: 'Cannot archive' });
  await waitFor(() => expect(archive.disabled).toBe(false));
  await user.click(archive); expect(says()).toHaveLength(2);
  Source.current.send({ type: 'moved', from: `discussions/${closed}`, to: `discussions/archive/${closed}` });
  await waitFor(() => expect(archive.disabled).toBe(false));
});

it('offers Make active and the other section for archived and deferred boards', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByText('Archived · Deferred (2)'));
  await user.click(screen.getByLabelText('Board actions for old')); await user.click(within(menu('old')).getByRole('button', { name: 'Make active' }));
  await waitFor(() => expect(says()).toContain('/move archive/' + old + ' active'));
  await user.click(screen.getByLabelText('Board actions for old')); await user.click(within(menu('old')).getByRole('button', { name: 'Defer' }));
  await waitFor(() => expect(says()).toContain('/move archive/' + old + ' deferred'));
  await user.click(screen.getByLabelText('Board actions for idea')); await user.click(within(menu('idea')).getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(says()).toContain('/move brainstorms/deferred/' + idea + ' archive'));
});

it('clears the pending archive on an HTTP refusal', async () => {
  setup(); const user = userEvent.setup(); await user.click(await screen.findByLabelText('Board actions for closed'));
  fetchMock.mockImplementation(async (url: string) => url === '__say' ? { ok: false, text: async () => 'Refused' } : { ok: true, json: async () => ({ files, unviewable: [], branch: null }) });
  await user.click(within(menu('closed')).getByRole('button', { name: 'Archive' }));
  expect(await screen.findByText('Refused')).toBeTruthy();
  await waitFor(() => expect((within(menu('closed')).getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(false));
});
