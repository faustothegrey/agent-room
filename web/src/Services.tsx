import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { DiagnosticCheck, InstructionSet, PromptTestRequest, ProviderHealthReply, ScheduleData, ScheduleRequest, ScheduleTask, SettingsReply, SettingsSaveRequest, SettingsSaveReply } from '../../src/contract';
import { AgentRow, choice, incomplete, memberPlan, selectedSettings, toRow, type Row } from './Settings';

// The Schedule, Instructions and Providers services, as on /__room (renderSchedule,
// renderInstructions, renderProviders and loadHealth).
const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const longDate = (iso: string) => { const d = new Date(iso); return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + hhmm(d); };
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export function formatScheduleRun(task: ScheduleTask): { text: string; cls: string } {
  if (task.running) return { text: 'Running now…', cls: 'warn' };
  const r = task.lastRun;
  if (!r) return { text: 'Last run: never', cls: '' };
  const at = r.at ? longDate(r.at) : '';
  if (r.status === 'ran') return { text: 'Last run: ' + at + ' · ran', cls: 'ok' };
  if (r.status === 'skipped') return { text: 'Last run: ' + at + ' · skipped' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'warn' };
  if (r.status === 'stopped') return { text: 'Last run: ' + at + ' · stopped by the quota guard' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'warn' };
  return { text: 'Last run: ' + at + ' · failed' + (r.reason ? ' (' + r.reason + ')' : ''), cls: 'err' };
}
type SchedulePost = (path: '__schedule', body: ScheduleRequest) => Promise<Response>;
// The Schedule page: quota floor, research tasks, and last-run results. reload changes when the
// room sends a schedule event while it is shown.
export function SchedulePanel({ open, reload, post }: { open: boolean; reload: number; post: SchedulePost }) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [floor, setFloor] = useState('50');
  const blank = { kind: 'research' as ScheduleTask['kind'], title: '', date: '', time: '03:00', prompt: '', enabled: true, deep: false, theoretical: false };
  const [form, setForm] = useState(blank);
  const show = (next: ScheduleData, text = '', isError = false) => { setData(next); setError(''); setNotice({ text, error: isError }); setFloor(String(next.quotaFloor ?? 50)); };
  useEffect(() => {
    if (!open) return;
    fetch('__schedule').then(async (res) => { if (!res.ok) throw new Error(await res.text()); show(await res.json() as ScheduleData); })
      .catch((err: unknown) => setError("Couldn't load the schedule: " + message(err)));
  }, [open, reload]);
  const editing = editingId ? data?.tasks.find((t) => t.id === editingId) ?? null : null;
  useEffect(() => { if (editingId && data && !editing) setEditingId(null); }, [data]);
  useEffect(() => { setForm(editing ? { kind: editing.kind, title: editing.title || '', date: editing.date || '', time: editing.time, prompt: editing.prompt, enabled: !!editing.enabled, deep: !!editing.researchKind?.deep, theoretical: !!editing.researchKind?.theoretical } : blank); }, [editingId]);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  const mutate = async (payload: ScheduleRequest, ok: string) => {
    try { const res = await post('__schedule', payload); if (!res.ok) throw new Error(await res.text()); show(await res.json() as ScheduleData, ok); }
    catch (err) { setNotice({ text: message(err), error: true }); }
  };
  if (error) return <div className="schedule-pane">{error}</div>;
  if (!data) return <div className="schedule-pane" />;
  const research = form.kind === 'research';
  // Once a task has created its board, the board's saved kind wins: its toggles can't change it.
  const kindLocked = !!editing?.board;
  const kindText = (task: ScheduleTask) => [task.researchKind?.deep && 'Deep', task.researchKind?.theoretical && 'Theoretical'].filter(Boolean).join(' · ');
  return <div className="schedule-pane">
    <section className="sched-section"><h3>Quota guard</h3>
      <div className="sched-floor-row"><label>Minimum quota remaining (% for all providers): <input type="number" min="0" max="100" step="1" value={floor} onChange={(e) => setFloor(e.target.value)} /></label>
        <button type="button" onClick={() => void mutate({ action: 'floor', quotaFloor: Number(floor) }, 'Quota floor saved (' + floor + '%).')}>Save floor</button></div>
      <p className="settings-hint">Checked before each scheduled run and before each lap across every agent’s 5-hour and weekly windows. Missing or stale meter readings skip or stop the run. Runs happen only while agent-room is open (no catch-up).</p>
    </section>
    <section className="sched-section"><h3>Scheduled tasks ({data.tasks.length})</h3>
      {!data.tasks.length && <p className="settings-hint">No scheduled tasks for this room yet.</p>}
      {data.tasks.map((task) => { const run = formatScheduleRun(task); return <div className="sched-card" key={task.id} data-enabled={task.enabled ? 'true' : 'false'}>
        <div className="sched-head">
          <input type="checkbox" hidden={task.kind === 'research'} checked={!!task.enabled} aria-label={'Enable scheduled task for ' + (task.title || 'research')} onChange={(e) => void mutate({ action: 'toggle', id: task.id, enabled: e.target.checked }, e.target.checked ? 'Task enabled.' : 'Task disabled.')} />
          <span className="sched-time">{task.kind === 'research' ? task.date + ' ' + task.time : task.time + ' daily'}</span>
          <span className="sched-disc">{(task.title || 'Untitled research') + (task.board ? ' · ' + task.board : '')}</span>
          {kindText(task) && <span className="research-kind-badge" title="Research kind its board is created with">{kindText(task)}</span>}
          <span className="sched-actions"><button type="button" onClick={() => setEditingId(task.id)}>Edit</button>
            <button type="button" className="danger" onClick={() => { if (armed === task.id) { setArmed(null); if (editingId === task.id) setEditingId(null); void mutate({ action: 'delete', id: task.id }, 'Task deleted.'); } else setArmed(task.id); }}>{armed === task.id ? 'Confirm delete' : 'Delete'}</button></span>
        </div>
        <div className="sched-prompt">{task.prompt}</div>
        <div className={'sched-last' + (run.cls ? ' ' + run.cls : '')}>{run.text}</div>
      </div>; })}
    </section>
    <section className="sched-section"><h3>{editing ? 'Edit scheduled task' : 'Add scheduled task'}</h3>
      <form className="sched-form" aria-label={editing ? 'Edit scheduled task' : 'Add scheduled task'} onSubmit={(e) => {
        e.preventDefault();
        const fields = research ? { kind: 'research' as const, title: form.title, date: form.date, time: form.time, prompt: form.prompt } : { kind: 'recurring' as const, title: form.title, time: form.time, prompt: form.prompt, enabled: form.enabled };
        const researchKind = { deep: form.deep, theoretical: form.theoretical };
        const payload: ScheduleRequest = editing ? { action: 'edit', id: editing.id, researchKind, ...fields } : { action: 'add', researchKind, ...fields };
        setEditingId(null); void mutate(payload, editing ? 'Task updated.' : 'Task added.');
      }}>
        <label>Task type<select value={form.kind} disabled={!!editing} onChange={(e) => setForm({ ...form, kind: e.target.value as ScheduleTask['kind'] })}><option value="research">One-shot research</option><option value="recurring">Daily research</option></select></label>
        <div className="sched-form-row">
          <label className="grow">Research title (optional)<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label hidden={!research}>Date (local)<input type="date" required={research} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
          <label>{research ? 'Time (local)' : 'Daily time (local)'}<input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
        </div>
        <label>Saved prompt (posted as Scheduler)<textarea rows={4} required placeholder="Write the prompt the Scheduler should post to the research board…" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} /></label>
        <div className="sched-form-row research-kind" role="group" aria-label="Research kind">{(['deep', 'theoretical'] as const).map((key) => <button type="button" key={key} aria-pressed={form[key]} disabled={kindLocked} title={key === 'deep' ? 'Deep: question the premises, search the web, up to 30 laps per run (otherwise 6)' : 'Theoretical: end with what was understood, instead of a feasibility scorecard and verdict'} onClick={() => setForm({ ...form, [key]: !form[key] })}>{key === 'deep' ? 'Deep' : 'Theoretical'}</button>)}
          <span className="settings-hint">{kindLocked ? 'Its board ' + editing!.board + ' already exists: its kind was saved when it was created and can’t be changed here.' : 'The kind its research board is created with: neither on is Feasibility.'}</span></div>
        <label className="inline" hidden={research}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label>
        <div className="sched-form-buttons"><button type="submit">{editing ? 'Save changes' : 'Add task'}</button>{editing && <button type="button" onClick={() => setEditingId(null)}>Cancel</button>}</div>
      </form>
      <p className="settings-status" role="status" style={notice.error ? { color: 'light-dark(#b91c1c, #fca5a5)' } : undefined}>{notice.text}</p>
    </section>
  </div>;
}
// The Instructions page: the prompt catalog, fetched once and shown as expandable pieces (read-only).
export function InstructionsPanel({ open }: { open: boolean }) {
  const [sets, setSets] = useState<InstructionSet[] | null>(null), [error, setError] = useState('');
  const loaded = useRef(false);
  useEffect(() => {
    if (!open || loaded.current) return; loaded.current = true;
    fetch('__instructions').then(async (res) => { if (!res.ok) throw new Error(await res.text()); setSets(await res.json() as InstructionSet[]); })
      .catch((err: unknown) => setError("Couldn't load the instructions: " + message(err)));
  }, [open]);
  return <div className="instructions-pane">{error || sets?.map((set) => <div className="ins-set" key={set.type}><h3>{set.type}</h3>
    {set.pieces.map((piece) => <details className="ins-piece" key={piece.id}><summary><b>{piece.id}</b><span className="when">{piece.when}</span></summary>
      <div className="ins-intent">{piece.intent}</div><pre className="ins-content">{piece.content}</pre></details>)}</div>)}</div>;
}
type ProvidersPost = (path: '__settings' | '__provider-health' | '__prompt-test', body: SettingsSaveRequest | PromptTestRequest | Record<string, never>) => Promise<Response>;
// Provider health · all rooms on this server: what the server knows of each provider's CLI, login,
// model list, prompt tests, operations, sessions, running and leftover programs and the quota meter.
function Health({ open, post }: { open: boolean; post: ProvidersPost }) {
  const [data, setData] = useState<ProviderHealthReply | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Record<string, string>>({}), [tests, setTests] = useState<Record<string, string>>({}), [testing, setTesting] = useState<Record<string, boolean>>({});
  const load = async (check = false) => {
    setBusy(true);
    try { const res = check ? await post('__provider-health', {}) : await fetch('__provider-health'); if (!res.ok) throw new Error(await res.text()); setData(await res.json() as ProviderHealthReply); setError(''); setTesting({}); }
    catch (err) { setError('Could not load provider health: ' + message(err)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open) void load(); }, [open]);
  const when = (t: string | null | undefined) => t ? longDate(t) : 'not yet';
  const err = (e: { at?: string; message?: string } | null | undefined) => e && e.message ? ' · latest error ' + when(e.at) + ': ' + e.message : '';
  const lines: ReactNode[] = [];
  const line = (text: string) => lines.push(<p key={lines.length}>{text}</p>);
  const heading = (text: string) => lines.push(<h4 className="health-heading" key={lines.length}>{text}</h4>);
  // A Check now diagnostic: never checked, found / nothing found with its time, or couldn't check
  // (with the error, and the previous result with its own time).
  const diag = <T,>(label: string, c: DiagnosticCheck<T> | undefined, show: (r: T) => [boolean, string]) => {
    let base: string | null = null;
    if (c?.checked) { const [found, text] = show(c.result as T); base = (found ? 'found' : 'nothing found') + (text ? ': ' + text : '') + ' · checked ' + when(c.checked); }
    const failed = c?.error && (!c.checked || c.error.at >= c.checked);
    line(label + ': ' + (failed ? "couldn't check: " + c!.error!.message + ' (' + when(c!.error!.at) + ')' + (base ? ' · previous result: ' + base : '') : base ?? 'never checked'));
  };
  const table = (headings: string[], rows: string[][]) => lines.push(<table key={lines.length}><thead><tr>{headings.map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>);
  if (data) {
    heading('Providers');
    for (const provider of ['claude', 'codex', 'agy']) {
      const cli = data.cli[provider], login = data.login[provider], cliError = data.errors.cli[provider] as { path?: string; at?: string; message?: string } | null | undefined;
      line(provider.toUpperCase() + ' · CLI: ' + (cli ? cli.path + ' · ' + cli.version + ' · last success ' + when(cli.checked) : cliError?.path ? 'found at ' + cliError.path + ', version unavailable' : 'not checked successfully') + err(cliError));
      const perm = data.permissions?.[provider];
      if (perm) line('Permission mode: ' + perm.state + (perm.problems.length ? ' (' + perm.problems.join('; ') + ')' : '') + ' · launch: ' + perm.launch
        + ' · ' + (perm.config ? perm.config.file + (perm.config.error ? ': unreadable' : perm.config.found ? ': read' : ': not found, no local override') : 'config not read')
        + (perm.mode ? ' · mode ' + perm.mode : '') + (provider === 'claude' ? ' · live: ' + (perm.live ? perm.live.mode + ' (Test prompt, ' + when(perm.live.at) + ')' : 'no Test prompt yet') : '')
        + ' · checked ' + when(perm.checked));
      else line('Permission mode: not checked yet (Check now)');
      line('Login: ' + (provider === 'agy' ? 'not monitored' : login ? login.state + (login.expiresAt ? ' · ends ' + when(login.expiresAt) : '') + ' · last success ' + when(login.checked) : 'not checked successfully') + err(data.errors.login[provider]) + (provider === 'agy' ? '' : data.scheduledProviders.includes(provider) ? ' · next scheduled check ' + when(data.nextLogin) : ' · not on the 10-minute schedule (Check now only)'));
    }
    heading('Launch environment');
    line("As this server's own environment shows it, from Check now. Variable names only, never their values; a set variable is a possible override, not proof it was used.");
    const launch = data.diagnostics?.launch;
    for (const provider of ['claude', 'codex', 'agy']) {
      const l = launch?.[provider], P = provider.toUpperCase();
      diag(P + ' · executables on PATH', l?.executables, (r) => [r.length > 0, r.map((x, i) => i ? x : x + ' (agent-room runs this one)').join(', ')]);
      diag(P + ' · config folder', l?.configFolder, (r) => [r.exists, r.path + (r.exists ? '' : ' (not present)')]);
      diag(P + ' · auth and config variables set', l?.env, (r) => [r.length > 0, r.join(', ')]);
      if (provider === 'agy') line(P + ' · auth mode: not monitored');
      else diag(P + ' · auth mode (' + (provider === 'claude' ? 'claude auth status --json' : 'codex login status') + ')', l?.authMode, (r) => [r !== 'unknown', r]);
    }
    heading('Model lists');
    const sources: Record<string, string> = { claude: "agent-room's fixed list in modelChoices", codex: 'models_cache.json', agy: 'agy models' };
    for (const provider of ['claude', 'codex', 'agy']) {
      const c = data.catalogs[provider];
      line(provider.toUpperCase() + ' model list · ' + sources[provider] + ' · ' + (c.loaded ? 'loaded' : c.checked ? 'unavailable' : 'not read yet') + ' · ' + c.models.length + ' models' + (c.checked ? ' · last attempt ' + when(c.checked) : '') + err(c.error));
    }
    line("Claude's list is agent-room's own; being in that list proves little about availability.");
    heading('Configured models');
    for (const group of data.configured) { line('Room ' + group.room + ' · ' + (group.discussion || 'no sprint started')); for (const a of group.agents) line(a.role + ' ' + a.name + ' · ' + a.provider + ' · ' + (a.model || 'CLI default') + ' · ' + a.alignment); }
    if (data.defaults) { line('Saved defaults'); for (const a of data.defaults) line(a.role + ' ' + a.name + ' · ' + a.provider + ' · ' + (a.model || 'CLI default') + ' · ' + a.alignment); }
    else line('Saved defaults: none available');
    heading('Prompt tests');
    line('Prompt tests use quota and prove only that the model answered at that moment.');
    for (const provider of ['claude', 'codex', 'agy']) {
      const choices = [...new Set(data.configured.flatMap((g) => g.agents.filter((a) => a.provider === provider && a.model).map((a) => a.model)))];
      lines.push(<p key={lines.length}><label>{provider.toUpperCase()} model: <select value={models[provider] ?? ''} onChange={(e) => setModels({ ...models, [provider]: e.target.value })}>{['', ...choices].map((m) => <option key={m} value={m}>{m || 'CLI default'}</option>)}</select></label>{' '}
        <button type="button" disabled={testing[provider] || data.promptRunning.includes(provider)} onClick={async () => {
          setTesting({ ...testing, [provider]: true }); setTests({ ...tests, [provider]: ' Running…' });
          try { const res = await post('__prompt-test', { provider, model: models[provider] ?? '' }); if (!res.ok) throw new Error(await res.text()); await load(); setTests((t) => ({ ...t, [provider]: '' })); }
          catch (e) { setTests((t) => ({ ...t, [provider]: ' Could not run test: ' + message(e) })); setTesting((t) => ({ ...t, [provider]: false })); }
        }}>Test prompt (uses quota)</button><span>{tests[provider]}</span></p>);
      for (const r of data.promptResults.filter((item) => item.provider === provider)) line(provider.toUpperCase() + ' · ' + (r.model || 'CLI default') + ' · ' + when(r.at) + ' · ' + (r.durationMs / 1000).toFixed(1) + ' s · ' + r.outcome + ' · reply: ' + (r.reply || '(none)') + (r.error ? ' · error: ' + r.error : ''));
    }
    heading('Operations');
    line('Operations · provider and model used now');
    for (const group of data.configured) {
      line('Room ' + group.room + ' · ' + (group.discussion || 'no sprint started'));
      const members = group.agents.filter((a) => a.role === 'member'), worker = group.agents.find((a) => a.role === 'worker');
      const model = (a: { model: string } | undefined) => a?.model || 'CLI default';
      const rows = members.map((a) => ['Discussion turn · ' + a.name + (a.enabled ? '' : ' (disabled)'), a.provider, model(a)]);
      rows.push(...members.filter((a) => a.enabled).map((a) => ['Summary · ' + a.name, a.provider, model(a)]));
      rows.push(['Worker tasks · ' + worker?.name, worker?.provider ?? '', model(worker)], ['Closing statement · new session', worker?.provider ?? '', model(worker)], ['Board title', 'Claude', 'CLI default'],
        ['Login check · claude auth status', 'Claude', 'not applicable'], ['Login check · codex login status', 'Codex', 'not applicable'], ['Login check', 'Agy', 'not monitored'], ['Quota meter', 'quota meter', 'not applicable']);
      table(['Operation', 'Provider', 'Model'], rows);
    }
    heading('Sessions');
    line('Sessions are memory between turns, not running programs. This list covers only sessions known to agent-room.');
    for (const group of data.sessions) {
      line('Room ' + group.room + ' · ' + (group.discussion || 'no sprint started'));
      table(['Agent', 'Provider', 'Session ID', 'Last turn', 'Latest error'], group.agents.map((a) => [a.role + ' ' + a.name, a.provider, a.id || 'none yet',
        a.lastTurn ? when(a.lastTurn.ended) + ' · ' + a.lastTurn.outcome : 'none yet', a.lastTurn?.error ? when(a.lastTurn.error.at) + ' · ' + a.lastTurn.error.message : 'none']));
    }
    heading('Programs agent-room started');
    line('Leftovers: last success ' + when(data.leftoversChecked) + err(data.errors.leftovers) + ' · next scheduled check ' + when(data.nextLeftovers));
    const age = (started?: string | null) => started ? Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 60000)) + ' min' : 'unknown';
    for (const [label, programs] of [['Running', data.running], ['Leftover', data.leftovers]] as const) {
      if (!programs.length) line(label + ': none in last available results');
      for (const p of programs) line(label + ': PID ' + p.pid + ' · ' + p.provider + ' · ' + p.agent + ' · room ' + p.room + ' · age ' + age(p.started) + (p.unverified ? ' · unverified' : ''));
    }
    heading('CLI processes visible to this server');
    line('Every running claude, codex and agy process ps shows, from Check now. Owner: agent-room for a recorded program or its process group; external for one with a terminal (agent-room starts CLIs without one); unknown otherwise. Working folders and command lines are not shown.');
    const procs = data.diagnostics?.processes;
    diag('CLI processes', procs, (r) => [r.length > 0, r.length ? r.length + (r.length === 1 ? ' process' : ' processes') : '']);
    if (procs?.result?.length) table(['PID', 'Provider', 'Elapsed', 'Owner', 'Evidence'], procs.result.map((x) => [String(x.pid), x.provider, x.elapsed, x.owner, x.evidence]));
    heading('Quota meter');
    for (const q of data.quota) line('Quota meter · room ' + q.room + ': ' + (q.reachable === null ? 'not checked' : q.reachable ? 'reachable' : 'not reachable') + ' · readings ' + (q.providers ? Object.entries(q.providers).map(([p, t]) => p + ': ' + (t || 'unknown')).join(', ') : (q.measured || 'unknown')) + ' · checked ' + when(q.checked));
  }
  return <><button type="button" id="health-check" disabled={busy} onClick={() => void load(true)}>Check now</button><div id="provider-health" role="status" aria-label="Provider health">{error || lines}</div></>;
}
// The Providers page: the defaults for new discussions, members and worker together, saved to the
// shared defaults file (every room); before this discussion starts they apply to it too.
export function ProvidersPanel({ open, healthOpen, setHealthOpen, warning, post, queue, done }: { open: boolean; healthOpen: boolean; setHealthOpen: (open: boolean) => void; warning: boolean; post: ProvidersPost; queue: MutableRefObject<Promise<unknown>>; done: () => void }) {
  const [panel, setPanel] = useState<{ models: SettingsReply['models']; agents: Row[]; worker: Row; plan: ReturnType<typeof memberPlan> | null; started: boolean } | null>(null);
  const [status, setStatus] = useState(''), [, bump] = useState(0);
  const health = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!open) return;
    setStatus(''); setPanel(null);
    (async () => {
      try {
        await queue.current;
        const res = await fetch('__settings'); if (!res.ok) throw new Error(await res.text());
        const data = await res.json() as SettingsReply, sel = selectedSettings(data);
        const plan = sel.agents.length >= 2 && sel.agents.length <= 3 ? memberPlan(sel.agents, sel.worker, data.models) : null;
        setPanel({ models: data.models, agents: plan ? plan.rows : sel.agents.map((a) => toRow(a, data.models)), worker: toRow(sel.worker, data.models), plan, started: data.started });
      } catch (err) { setStatus('Could not load settings: ' + message(err)); }
    })();
  }, [open]);
  useEffect(() => { if (open && healthOpen && health.current) { health.current.open = true; health.current.scrollIntoView?.({ block: 'start' }); } }, [open, healthOpen]);
  const save = () => {
    if (!panel) return;
    if ([...panel.agents, panel.worker].some(incomplete)) { setStatus('Enter a custom model ID to save this choice.'); return; }
    const value: SettingsSaveRequest = { agents: panel.agents.filter((r) => r.active).map(choice), worker: choice(panel.worker), scope: 'defaults' };
    setStatus('Saving…');
    queue.current = queue.current.then(async () => {
      const res = await post('__settings', value); if (!res.ok) throw new Error(await res.text());
      setStatus((await res.json() as SettingsSaveReply).applied ? 'Saved: the defaults, and this board.' : 'Saved as the defaults for new boards.');
    }).catch((err: unknown) => setStatus('Could not save: ' + message(err)));
  };
  const change = (row: Row, i: number | null) => (edit: Partial<Row> | 'provider' | 'toggle', value?: string | boolean) => {
    if (!panel) return;
    const plan = i === null ? null : panel.plan;
    if (edit === 'provider') { if (plan) plan.setProvider(i!, value as Row['provider']); else Object.assign(row, { provider: value, model: '', custom: false }); }
    else if (edit === 'toggle') { if (plan && !plan.toggle(i!, !!value)) { bump((n) => n + 1); return; } }
    else if (edit.name !== undefined && plan) plan.setName(i!, edit.name);
    else Object.assign(row, edit);
    bump((n) => n + 1);
    if (edit === 'provider' || edit === 'toggle' || 'custom' in edit) save();
  };
  return <div className="providers">
    <form className="providers-panel" id="providers-form" aria-label="Default providers" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {panel && <p className="settings-hint">{panel.started ? 'Defaults for new boards, in this room and every other. This board has started: it keeps its agents and worker (change those in its own tabs).' : 'Defaults for new boards, in this room and every other. This board hasn’t started, so they apply to it too.'}</p>}
      <h3 className="providers-heading">Discussion members</h3>
      {panel?.agents.map((row, i) => <AgentRow key={i} row={row} models={panel.models} title={'Agent ' + (i + 1)} member={!!panel.plan} locked={!!panel.plan?.locked(i)} disabled={false} change={change(row, i)} commit={save} />)}
      {panel?.plan && panel.agents.some((_, i) => panel.plan!.locked(i)) && <p className="settings-hint member-note">At least two members. To swap one, tick the new row first, then untick the old one.</p>}
      <h3 className="providers-heading">Worker</h3>
      {panel && <AgentRow row={panel.worker} models={panel.models} title="Worker" member={false} locked={false} disabled={false} change={change(panel.worker, null)} commit={save} />}
      <p className="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access. Changes save automatically.</p>
      <p className="settings-status" role="status">{status}</p>
      <button type="button" onClick={done}>Go to the discussion</button>
    </form>
    <details ref={health} id="health-details" className="providers-panel" onToggle={(e) => setHealthOpen(e.currentTarget.open)}>
      <summary>Provider health · all rooms on this server {warning && <span id="health-warning">⚠</span>}</summary>
      <Health open={open && healthOpen} post={post} />
    </details>
  </div>;
}
