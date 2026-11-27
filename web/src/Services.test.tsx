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
const room = { folder: '/room', discussion: 'Live', active: 'discussions/2026-11-25-live', started: true, open: [], members: [], failedAgents: [] };
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const fail = (text: string) => ({ ok: false, status: 400, json: async () => ({}), text: async () => text });
const tasks = [
  { id: 't1', kind: 'research', title: 'Market scan', board: 'discussions/2026-11-20-scan', date: '2026-12-01', time: '04:00', prompt: 'Scan the market', enabled: true, lastRun: null },
  { id: 't2', kind: 'recurring', title: '', time: '03:00', prompt: 'Daily check', enabled: false, lastRun: { at: '2026-11-25T03:00:00Z', status: 'skipped', reason: 'quota 20%' } },
  { id: 't3', kind: 'recurring', title: 'Busy', time: '05:00', prompt: 'Now', enabled: true, running: true }];
const schedule = { quotaFloor: 50, tasks };
let answer: (url: string, body: Record<string, unknown> | null) => unknown;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '__health' ? new Promise(() => {}) : answer(url, init?.body ? JSON.parse(String(init.body)) : null));
const bodies = (path: string) => fetchMock.mock.calls.filter(([url, init]) => url === path && init?.body).map(([, init]) => JSON.parse(String(init?.body)));
const gets = (path: string) => fetchMock.mock.calls.filter(([url, init]) => url === path && !init?.body).length;
const reset = (extra: object = {}) => Source.current.send({ type: 'reset', room, messages: [], worker: [], input: true, ...extra });
const panel = () => screen.getByLabelText('Services panel');
beforeEach(() => { localStorage.clear(); fetchMock.mockClear(); vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', fetchMock); answer = (url) => url === '__schedule' ? ok(schedule) : ok([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the schedule: quota floor, tasks with their last runs, and refreshes on a schedule event only while open', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  Source.current.send({ type: 'schedule' }); expect(gets('__schedule')).toBe(0);
  await user.click(screen.getByRole('button', { name: '⏰ Schedule' }));
  expect(await within(panel()).findByText('Scheduled tasks (3)')).toBeTruthy();
  expect((within(panel()).getByLabelText(/Minimum quota remaining/) as HTMLInputElement).value).toBe('50');
  const cards = [...panel().querySelectorAll('.sched-card')];
  expect(cards.map((c) => c.querySelector('.sched-time')?.textContent)).toEqual(['2026-12-01 04:00', '03:00 daily', '05:00 daily']);
  expect(cards.map((c) => c.querySelector('.sched-disc')?.textContent)).toEqual(['Market scan · discussions/2026-11-20-scan', 'Untitled research', 'Busy']);
  expect(cards.map((c) => [c.querySelector('.sched-last')?.className, c.querySelector('.sched-last')?.textContent?.replace(/: .* · /, ': … · ')]))
    .toEqual([['sched-last', 'Last run: never'], ['sched-last warn', 'Last run: … · skipped (quota 20%)'], ['sched-last warn', 'Running now…']]);
  expect((cards[0].querySelector('input[type=checkbox]') as HTMLInputElement).hidden).toBe(true);
  Source.current.send({ type: 'schedule' }); await waitFor(() => expect(gets('__schedule')).toBe(2));
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' }));
  Source.current.send({ type: 'schedule' }); expect(gets('__schedule')).toBe(2);
});

it('saves the floor, toggles, deletes after two clicks, and adds and edits tasks with their messages', async () => {
  answer = (url, body) => url === '__schedule' ? (body?.action === 'toggle' ? fail('Task not found.') : ok(schedule)) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '⏰ Schedule' })); await within(panel()).findByText('Scheduled tasks (3)');
  const status = () => within(panel()).getAllByRole('status').find((el) => el.className === 'settings-status')!;
  const floor = within(panel()).getByLabelText(/Minimum quota remaining/); await user.clear(floor); await user.type(floor, '40');
  await user.click(within(panel()).getByRole('button', { name: 'Save floor' }));
  await waitFor(() => expect(status().textContent).toBe('Quota floor saved (40%).'));
  await user.click(within(panel()).getByRole('checkbox', { name: 'Enable scheduled task for research' }));
  await waitFor(() => expect(status().textContent).toBe('Task not found.')); expect(status().style.color).not.toBe('');
  const del = within(panel()).getAllByRole('button', { name: 'Delete' })[0];
  await user.click(del); expect(bodies('__schedule').some((b) => b.action === 'delete')).toBe(false);
  await user.click(within(panel()).getByRole('button', { name: 'Confirm delete' }));
  await waitFor(() => expect(status().textContent).toBe('Task deleted.'));
  const add = within(panel()).getByRole('form', { name: 'Add scheduled task' });
  await user.type(within(add).getByLabelText('Research title (optional)'), 'New scan');
  await user.type(within(add).getByLabelText('Date (local)'), '2026-12-24');
  await user.type(within(add).getByLabelText('Saved prompt (posted as Scheduler)'), 'Look again');
  expect(within(add).getByLabelText('Enabled').closest('label')!.hidden).toBe(true);
  await user.click(within(add).getByRole('button', { name: 'Add task' }));
  await waitFor(() => expect(status().textContent).toBe('Task added.'));
  await user.click(within(panel()).getAllByRole('button', { name: 'Edit' })[1]);
  const edit = within(panel()).getByRole('form', { name: 'Edit scheduled task' });
  expect((within(edit).getByLabelText('Task type') as HTMLSelectElement).disabled).toBe(true);
  expect((within(edit).getByLabelText('Daily time (local)') as HTMLInputElement).value).toBe('03:00');
  await user.click(within(edit).getByLabelText('Enabled'));
  await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(status().textContent).toBe('Task updated.'));
  expect(bodies('__schedule')).toEqual([{ action: 'floor', quotaFloor: 40 }, { action: 'toggle', id: 't2', enabled: true }, { action: 'delete', id: 't1' },
    { action: 'add', kind: 'research', title: 'New scan', date: '2026-12-24', time: '03:00', prompt: 'Look again' },
    { action: 'edit', id: 't2', kind: 'recurring', title: '', time: '03:00', prompt: 'Daily check', enabled: true }]);
});

it('reports a schedule that cannot load', async () => {
  answer = (url) => url === '__schedule' ? fail('Schedule is unavailable in this room.') : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '⏰ Schedule' }));
  expect(await within(panel()).findByText("Couldn't load the schedule: Schedule is unavailable in this room.")).toBeTruthy();
});

it('shows the prompt catalog read-only, loaded once', async () => {
  answer = (url) => url === '__instructions' ? ok([{ type: 'Discussion agents', pieces: [{ id: 'citizenship.md', intent: 'Shared rules', when: 'at start', content: '# Rules' }] }]) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '📜 Instructions' }));
  expect(await within(panel()).findByRole('heading', { name: 'Discussion agents' })).toBeTruthy();
  expect(within(panel()).getByText('citizenship.md').closest('summary')?.textContent).toBe('citizenship.mdat start');
  expect(within(panel()).getByText('# Rules').tagName).toBe('PRE'); expect(panel().querySelector('.instructions-pane')!.querySelector('textarea, input')).toBeNull();
  await user.click(within(panel()).getByRole('button', { name: 'Close services panel' }));
  await user.click(screen.getByRole('button', { name: '📜 Instructions' })); expect(gets('__instructions')).toBe(1);
  cleanup(); answer = (url) => url === '__instructions' ? fail('boom') : ok([]);
  render(<App version="one" refresh={() => {}} />); reset();
  await user.click(screen.getByRole('button', { name: '📜 Instructions' }));
  expect(await within(panel()).findByText("Couldn't load the instructions: boom")).toBeTruthy();
});

const models = { claude: [{ id: 'opus', label: 'Opus' }], codex: [], agy: [] };
const worker = { name: 'Worker', provider: 'claude', model: '' };
const agents = [{ name: 'Claude', provider: 'claude', model: '' }, { name: 'Codex', provider: 'codex', model: '' }];
const health = { cli: { claude: { path: '/bin/claude', version: '2.0', checked: '2026-11-25T08:00:00Z' }, codex: null, agy: null },
  login: { claude: { state: 'ok', checked: '2026-11-25T08:00:00Z' }, codex: null, agy: null }, errors: { cli: { codex: { path: '/bin/codex' } }, login: {}, leftovers: null },
  scheduledProviders: ['claude'], nextLogin: '2026-11-25T08:10:00Z', catalogs: { claude: { loaded: true, checked: null, models: [1, 2] }, codex: { loaded: false, checked: '2026-11-25T08:00:00Z', models: [] }, agy: { loaded: false, checked: null, models: [] } },
  configured: [{ room: '/room', discussion: 'live', agents: [{ role: 'member', name: 'Claude', provider: 'claude', model: 'opus', alignment: 'as saved', enabled: true }, { role: 'worker', name: 'Worker', provider: 'claude', model: '', alignment: 'as saved' }] }],
  defaults: null, promptRunning: [], promptResults: [{ provider: 'claude', model: 'opus', at: '2026-11-25T08:05:00Z', durationMs: 2400, outcome: 'answered', reply: 'OK' }],
  sessions: [{ room: '/room', discussion: 'live', agents: [{ role: 'member', name: 'Claude', provider: 'claude', id: 's1', lastTurn: null }] }],
  leftoversChecked: null, nextLeftovers: null, running: [], leftovers: [], quota: [{ room: '/room', reachable: true, measured: '2026-11-25 08:00', checked: null }] };

it('shows each provider\'s permission mode, or that it was not checked yet', async () => {
  const permissions = { claude: { launch: '--allowedTools Bash', state: 'problem', mode: 'plan', problems: ['permission mode plan: tools never run'], checked: '2026-11-25T08:00:00Z',
    config: { file: '/h/.claude/settings.json', found: true }, live: { mode: 'plan', at: '2026-11-25T08:01:00Z' } },
  codex: { launch: 'sandbox_mode="danger-full-access"', state: 'ok', mode: null, problems: [], checked: '2026-11-25T08:00:00Z', config: { file: '/h/.codex/config.toml', found: false }, live: null } };
  answer = (url) => url === '__provider-health' ? ok({ ...health, permissions }) : url === '__settings' ? ok({ settings: { agents, worker }, started: false, models }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  await user.click(within(panel()).getByText(/^Provider health · all rooms on this server/));
  const report = await within(panel()).findByRole('status', { name: 'Provider health' });
  await waitFor(() => expect(report.textContent).toContain('Permission mode: problem (permission mode plan: tools never run) · launch: --allowedTools Bash · /h/.claude/settings.json: read · mode plan · live: plan (Test prompt, '));
  expect(report.textContent).toContain('Permission mode: ok · launch: sandbox_mode="danger-full-access" · /h/.codex/config.toml: not found, no local override');
  expect(report.textContent).toContain('Permission mode: not checked yet (Check now)');
});

it('saves the default providers through the shared queue, with the legacy texts', async () => {
  answer = (url, body) => url === '__settings' ? (body ? ok({ applied: false }) : ok({ settings: { agents, worker }, defaults: { agents, worker }, started: true, models })) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  const form = await within(panel()).findByRole('form', { name: 'Default providers' });
  expect(await within(form).findByText(/^Defaults for new discussions, in this room and every other\. This discussion has started/)).toBeTruthy();
  await user.selectOptions(within(form).getByLabelText('Worker model'), 'opus');
  await waitFor(() => expect(within(form).getByRole('status').textContent).toBe('Saved as the defaults for new discussions.'));
  expect(bodies('__settings')).toEqual([{ agents, worker: { ...worker, model: 'opus' }, scope: 'defaults' }]);
  await user.selectOptions(within(form).getByLabelText('Agent 1 model'), 'Custom…');
  expect(within(form).getByRole('status').textContent).toBe('Enter a custom model ID to save this choice.');
  await user.click(within(form).getByRole('button', { name: 'Go to the discussion' })); expect(screen.queryByRole('form', { name: 'Default providers' })).toBeNull();
});

it('shows provider health, checks now, runs a prompt test, and opens from a provider name in the header', async () => {
  answer = (url, body) => url === '__provider-health' ? ok(health) : url === '__prompt-test' ? (body?.provider === 'codex' ? fail('busy') : ok()) : url === '__settings' ? ok({ settings: { agents, worker }, started: false, models }) : ok([]);
  render(<App version="one" refresh={() => {}} />);
  reset({ quota: [{ provider: 'claude', label: '5h', used: 10, resets: null }], quotaAt: null, monitor: { claude: { login: { state: 'out' }, running: 0, leftovers: [], inRoom: true } } });
  const user = userEvent.setup();
  await user.click(within(screen.getByLabelText('Subscription usage')).getByRole('button', { name: /^claude/ }));
  const report = await within(panel()).findByRole('status', { name: 'Provider health' });
  await waitFor(() => expect(report.textContent).toContain('CLAUDE · CLI: /bin/claude · 2.0 · last success'));
  expect(within(panel()).getByText('⚠')).toBeTruthy(); expect(report.textContent).toContain('CODEX · CLI: found at /bin/codex, version unavailable');
  expect(report.textContent).toContain('CODEX model list · models_cache.json · unavailable · 0 models');
  expect(report.textContent).toContain('CLAUDE · opus · '); expect(report.textContent).toContain(' · 2.4 s · answered · reply: OK');
  expect(within(report).getAllByRole('table')[0].textContent).toContain('Summary · Claude');
  await user.click(within(panel()).getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '__provider-health' && init?.method === 'POST')).toBe(true));
  const [claudeTest, codexTest] = within(report).getAllByRole('button', { name: 'Test prompt (uses quota)' });
  await user.selectOptions(within(report).getAllByRole('combobox')[0], 'opus'); await user.click(claudeTest);
  await waitFor(() => expect(bodies('__prompt-test')).toEqual([{ provider: 'claude', model: 'opus' }]));
  await user.click(codexTest);
  expect(await within(report).findByText(/Could not run test: busy/)).toBeTruthy();
  cleanup(); answer = (url) => url === '__provider-health' ? fail('Provider health is unavailable.') : ok({ settings: { agents, worker }, started: false, models });
  render(<App version="one" refresh={() => {}} />); reset();
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  await user.click(within(panel()).getByText(/^Provider health · all rooms on this server/));
  expect(await within(panel()).findByText('Could not load provider health: Provider health is unavailable.')).toBeTruthy();
});

it('describes ⚙ Providers with this board\'s CLI sessions, following room updates, or its usual text without them', async () => {
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  const button = () => screen.getByRole('button', { name: '⚙ Providers' });
  expect(button().getAttribute('title')).toBe('Default providers and models for new discussions, and provider health');
  expect(document.getElementById('providers-tip')).toBeNull();
  const cliSessions = { agents: [{ name: 'Claude', provider: 'claude', id: null }, { name: 'Codex', provider: 'codex', id: null }], worker: { name: 'Worker', provider: 'claude', id: null } };
  Source.current.send({ type: 'room', room: { ...room, cliSessions } });
  const lines = () => [...document.getElementById('providers-tip')!.children].map((el) => el.textContent);
  expect(lines()).toEqual(["This room's sessions", 'Claude · claude · No session yet', 'Codex · codex · No session yet']);
  expect(button().getAttribute('title')).toBeNull(); expect(button().getAttribute('aria-describedby')).toBe('providers-tip');
  Source.current.send({ type: 'room', room: { ...room, cliSessions: { ...cliSessions, agents: [{ ...cliSessions.agents[0], id: '0123456789abcdef' }, cliSessions.agents[1]], worker: { ...cliSessions.worker, id: 'fedcba9876543210' } } } });
  expect(lines()).toEqual(["This room's sessions", 'Claude · claude · 01234567…', 'Codex · codex · No session yet', 'Worker · claude · fedcba98…']);
  expect(document.getElementById('providers-tip')!.textContent).not.toContain('0123456789abcdef');
  await user.click(button()); expect(button().getAttribute('aria-pressed')).toBe('true');
  Source.current.send({ type: 'room', room: { ...room, cliSessions: null } });
  expect(document.getElementById('providers-tip')).toBeNull(); expect(button().getAttribute('title')).toContain('Default providers');
});

it('groups provider health under headings and shows Check now diagnostics: never checked, found, nothing found, and a failed rerun with the previous result', async () => {
  const at = '2026-11-27T10:00:00Z', later = '2026-11-27T11:00:00Z';
  const never = { executables: {}, configFolder: {}, env: {}, authMode: {} };
  const diagnostics = { processes: { result: [{ pid: 101, provider: 'claude', elapsed: '01:02', owner: 'agent-room', evidence: 'recorded program' }, { pid: 202, provider: 'codex', elapsed: '00:05', owner: 'external', evidence: 'has a terminal; agent-room starts CLIs without one' }], checked: at, error: { message: 'ps: denied', at: later } },
    launch: { claude: { executables: { result: ['/a/claude', '/b/claude'], checked: at }, configFolder: { result: { path: '/h/.claude', exists: true }, checked: at }, env: { result: ['ANTHROPIC_API_KEY'], checked: at }, authMode: { result: 'claude.ai (firstParty)', checked: at } },
      codex: { executables: { result: [], checked: at }, configFolder: { result: { path: '/h/.codex', exists: false }, checked: at }, env: { result: [], checked: at }, authMode: { error: { message: 'login status not read', at } } }, agy: never } };
  answer = (url, body) => url === '__provider-health' ? ok({ ...health, diagnostics: body ? diagnostics : null }) : url === '__settings' ? ok({ settings: { agents, worker }, started: false, models }) : ok([]);
  render(<App version="one" refresh={() => {}} />); reset(); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '⚙ Providers' }));
  await user.click(within(panel()).getByText(/^Provider health · all rooms on this server/));
  const report = await within(panel()).findByRole('status', { name: 'Provider health' });
  await waitFor(() => expect(report.textContent).toContain('CLAUDE · executables on PATH: never checked'));
  expect([...report.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Providers', 'Launch environment', 'Model lists', 'Configured models', 'Prompt tests', 'Operations', 'Sessions', 'Programs agent-room started', 'CLI processes visible to this server', 'Quota meter']);
  expect(report.textContent).toContain('CLI processes: never checked'); expect(report.textContent).toContain('AGY · auth mode: not monitored');
  await user.click(within(panel()).getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(report.textContent).toContain('CLAUDE · executables on PATH: found: /a/claude (agent-room runs this one), /b/claude · checked '));
  const text = report.textContent!;
  expect(text).toContain('CLAUDE · config folder: found: /h/.claude · checked ');
  expect(text).toContain('CLAUDE · auth and config variables set: found: ANTHROPIC_API_KEY · checked ');
  expect(text).toContain('CLAUDE · auth mode (claude auth status --json): found: claude.ai (firstParty) · checked ');
  expect(text).toContain('CODEX · executables on PATH: nothing found · checked ');
  expect(text).toContain('CODEX · config folder: nothing found: /h/.codex (not present) · checked ');
  expect(text).toContain("CODEX · auth mode (codex login status): couldn't check: login status not read (");
  expect(text).toContain('AGY · config folder: never checked');
  expect(text).toMatch(/CLI processes: couldn't check: ps: denied \(.*\) · previous result: found: 2 processes · checked /);
  const rows = [...report.querySelectorAll('table')].at(-1)!.querySelectorAll('tr');
  expect([...rows].map((r) => [...r.children].map((c) => c.textContent))).toEqual([['PID', 'Provider', 'Elapsed', 'Owner', 'Evidence'], ['101', 'claude', '01:02', 'agent-room', 'recorded program'], ['202', 'codex', '00:05', 'external', 'has a terminal; agent-room starts CLIs without one']]);
});
