import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AgentEnabledRequest, AgentSettings, Room, SettingsReply, SettingsSaveRequest, SettingsSaveReply } from '../../src/contract';

// The Discussion and Worker tabs' settings panels, as on /__room (agentRow, memberPlan,
// renderMembers, selectedSettings and the serialized settingsSave queue). Settings stay outside
// the conversation; saving never changes an active CLI session.
type Provider = AgentSettings['provider'];
type Models = SettingsReply['models'];
export type Row = { provider: Provider; name: string; model: string; custom: boolean; active: boolean; automatic: boolean };
export const selectedSettings = (data: SettingsReply) => data.started ? data.launchDefaults ?? data.defaults ?? data.settings : data.settings;
const memberPanelAgents = (data: SettingsReply) => { const current = data.settings.agents; return current.length < 2 || current.length > 3 ? current : selectedSettings(data).agents; };
const display = (p: string) => p[0].toUpperCase() + p.slice(1);
export const toRow = (a: AgentSettings, models: Models, active = true, automatic = false): Row => ({ provider: a.provider, name: a.name, model: a.model, custom: !!a.model && !models[a.provider]?.some((m) => m.id === a.model), active, automatic });
// Member editor state: automatic names and the two-member minimum, one rule for every change.
export function memberPlan(agents: AgentSettings[], worker: AgentSettings, models: Models, currentWorker = worker) {
  const providers: Provider[] = ['claude', 'codex', 'agy'];
  const rows: Row[] = agents.map((a) => toRow(a, models, true, new RegExp('^' + display(a.provider) + '[0-9]*$', 'i').test(a.name)));
  function freeName(provider: Provider, skip: Row | null) {
    const base = display(provider), used = new Set([worker.name, currentWorker.name, ...rows.filter((r) => r !== skip).map((r) => r.name)].map((n) => n.toLowerCase()));
    const duplicate = rows.some((r) => r !== skip && r.provider === provider);
    let n = duplicate ? 2 : 0, name = n ? base + n : base;
    while (used.has(name.toLowerCase())) { n = n ? n + 1 : 2; name = base + n; }
    return name;
  }
  while (rows.length < 3) {
    const provider = providers.find((p) => !rows.some((r) => r.provider === p)) || 'claude';
    rows.push({ provider, name: freeName(provider, null), model: '', custom: false, active: false, automatic: true });
  }
  return {
    rows,
    setProvider(i: number, provider: Provider) { const row = rows[i]; row.provider = provider; row.model = ''; row.custom = false; if (row.automatic) row.name = freeName(provider, row); },
    setName(i: number, name: string) { rows[i].name = name; rows[i].automatic = false; },
    toggle(i: number, checked: boolean) { if (!checked && rows[i].active && rows.filter((r) => r.active).length <= 2) return false; rows[i].active = checked; return true; },
    locked(i: number) { return rows[i].active && rows.filter((r) => r.active).length <= 2; },
  };
}
type Plan = ReturnType<typeof memberPlan>;
export const incomplete = (r: Row) => r.active && r.custom && !r.model.trim();
export const choice = (r: Row): AgentSettings => ({ name: r.name.trim(), provider: r.provider, model: r.custom ? r.model.trim() : r.model });
// One provider / name / model row (agentRow); a member row also has its On box.
export function AgentRow({ row, models, title, member, locked, disabled, change, commit }: { row: Row; models: Models; title: string; member: boolean; locked: boolean; disabled: boolean; change: (edit: Partial<Row> | 'provider' | 'toggle', value?: string | boolean) => void; commit: () => void }) {
  const label = (text: string) => member ? text : title + ' ' + text;
  const typed = useRef('');
  return <div className={'agent-row' + (member ? ' member-row' : '')} data-provider={row.provider} data-active={member ? String(row.active) : undefined}>
    {member && <label className="member-toggle">On<input type="checkbox" aria-label={title + ' On'} checked={row.active} disabled={locked} onChange={(e) => change('toggle', e.target.checked)} /></label>}
    <label>{label('provider')}<select aria-label={title + ' provider'} value={row.provider} disabled={disabled} onChange={(e) => change('provider', e.target.value)}>
      <option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Agy</option></select></label>
    <label>{label('name')}<input aria-label={title + ' name'} className={row.automatic && member ? 'auto-name' : undefined} value={row.name} required={!member || row.active} disabled={disabled}
      onFocus={(e) => { typed.current = e.target.value; }} onChange={(e) => change({ name: e.target.value })} onBlur={(e) => { if (e.target.value !== typed.current) commit(); }} /></label>
    <label>{label('model')}<select aria-label={title + ' model'} value={row.custom ? '__custom' : row.model} disabled={disabled} onChange={(e) => change(e.target.value === '__custom' ? { custom: true, model: '' } : { custom: false, model: e.target.value })}>
      <option value="">CLI default</option>{(models[row.provider] ?? []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}<option value="__custom">Custom…</option></select></label>
    <label hidden={!row.custom}>{label('custom model ID')}<input aria-label={title + ' custom model ID'} placeholder="Model ID" value={row.custom ? row.model : ''} disabled={disabled}
      onFocus={(e) => { typed.current = e.target.value; }} onChange={(e) => change({ model: e.target.value })} onBlur={(e) => { if (e.target.value !== typed.current) commit(); }} /></label>
  </div>;
}
type Post = (path: '__settings' | '__agent-enabled', body: SettingsSaveRequest | AgentEnabledRequest) => Promise<Response>;
export function SettingsPanel({ scope, room, post, queue, openSignal }: { scope: 'talk' | 'work'; room: Room | null; post: Post; queue: MutableRefObject<Promise<unknown>>; openSignal?: MutableRefObject<boolean> }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<{ models: Models; rows: Row[]; plan: Plan | null; members: boolean; hint: string; note: string | null; workerName: string } | null>(null);
  const [result, setResult] = useState('');
  const [, bump] = useState(0);
  const details = useRef<HTMLDetailsElement>(null);
  const load = async () => {
    setResult(''); setPanel(null);
    try {
      await queue.current;
      const res = await fetch('__settings'); if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as SettingsReply, selected = { ...selectedSettings(data) };
      if (scope === 'talk' && data.started && room?.members) {
        setPanel({ models: data.models, members: true, plan: null, workerName: data.settings.worker.name, note: null,
          rows: room.members.map((m) => ({ provider: m.provider, name: m.name, model: m.model, custom: !!m.model && !data.models[m.provider]?.some((x) => x.id === m.model), active: m.enabled, automatic: false })),
          hint: 'This discussion’s members. Untick one to leave it out of this discussion from its next round; tick it to bring it back. Their provider and model stay as they started: choose those for a new discussion before its first message.' });
        return;
      }
      const hint = scope === 'work' ? (data.started ? 'Changes apply to this discussion only' : 'Changes apply to this discussion, and the default for new ones') + ', starting with the next instruction. A running instruction finishes with its current settings. Switching provider carries the Worker conversation into a fresh session.'
        : data.started ? 'Changes save automatically for future rooms. Active sessions keep their settings.' : 'Changes save automatically and apply to this room before any agent starts.';
      const agents = scope === 'talk' ? memberPanelAgents(data) : [data.settings.worker];
      if (scope === 'talk' && agents.length >= 2 && agents.length <= 3) {
        const plan = memberPlan(agents, selected.worker, data.models, data.settings.worker);
        setPanel({ models: data.models, rows: plan.rows, plan, members: false, hint, note: 'At least two members. To swap one, tick the new row first, then untick the old one.', workerName: data.settings.worker.name });
      } else setPanel({ models: data.models, rows: agents.map((a) => toRow(a, data.models)), plan: null, members: false, hint, workerName: data.settings.worker.name,
        note: scope === 'talk' ? 'This discussion has ' + agents.length + ' agents, set outside this panel; members can be chosen here only for 2 or 3.' : null });
    } catch (err) { setResult('Could not load settings: ' + (err instanceof Error ? err.message : String(err))); }
  };
  // A new discussion or brainstorm (or a page on one) opens the members panel: its members are chosen first.
  useEffect(() => {
    const fresh = !!openSignal?.current; if (openSignal) openSignal.current = false;
    if (scope === 'talk' && fresh && details.current && !details.current.open) { details.current.open = true; setOpen(true); void load(); }
    else if (scope === 'talk' && open && panel?.members) { if (room?.fresh) void load(); else setPanel((p) => p && room?.members ? { ...p, rows: room.members.map((m, i) => ({ ...p.rows[i], active: m.enabled })) } : p); }
  }, [room]);
  const save = () => {
    if (!panel || panel.members) return;
    if (panel.rows.some(incomplete)) { setResult('Enter a custom model ID to save this choice.'); return; }
    const choices = panel.rows.filter((r) => r.active).map(choice);
    setResult('Saving…');
    // Serialize saves from both tabs so a quick second change cannot overwrite a newer choice.
    queue.current = queue.current.then(async () => {
      const latest = await fetch('__settings'); if (!latest.ok) throw new Error(await latest.text());
      const latestData = await latest.json() as SettingsReply, settings: SettingsSaveRequest = { ...selectedSettings(latestData), scope };
      if (scope === 'talk' && choices.some((a) => a.name.toLowerCase() === latestData.settings.worker.name.toLowerCase())) throw new Error('Each member and the worker need a different name.');
      if (scope === 'talk') settings.agents = choices; else settings.worker = choices[0];
      const res = await post('__settings', settings); if (!res.ok) throw new Error(await res.text());
      const saved = await res.json() as SettingsSaveReply;
      setResult(scope === 'work' && saved.workerApplied ? 'Saved. Applies to the next worker instruction.' : saved.applied ? 'Saved.' : 'Saved for future rooms. This room keeps its settings.');
    }).catch((err: unknown) => { setResult('Could not save: ' + (err instanceof Error ? err.message : String(err))); });
  };
  const change = (i: number) => (edit: Partial<Row> | 'provider' | 'toggle', value?: string | boolean) => {
    if (!panel) return;
    const row = panel.rows[i];
    if (panel.members) {
      if (edit !== 'toggle') return;
      const enabled = !!value; row.active = enabled; setResult(''); bump((n) => n + 1);
      post('__agent-enabled', { name: row.name, enabled, member: true }).then(async (res) => { if (!res.ok) throw new Error(await res.text()); })
        .catch((err: unknown) => { row.active = !enabled; bump((n) => n + 1); setResult('Could not change ' + row.name + ': ' + (err instanceof Error ? err.message : String(err))); });
      return;
    }
    if (edit === 'provider') { if (panel.plan) panel.plan.setProvider(i, value as Provider); else Object.assign(row, { provider: value as Provider, model: '', custom: false }); }
    else if (edit === 'toggle') { if (panel.plan && !panel.plan.toggle(i, !!value)) { bump((n) => n + 1); return; } }
    else if (edit.name !== undefined && panel.plan) panel.plan.setName(i, edit.name);
    else Object.assign(row, edit);
    bump((n) => n + 1);
    // As the form's change event: selects and boxes save at once, text fields when left.
    if (edit === 'provider' || edit === 'toggle' || 'custom' in edit) save();
  };
  const sessions = scope === 'talk' ? room?.cliSessions?.agents ?? [] : room?.cliSessions?.worker ? [room.cliSessions.worker] : [];
  const models = scope === 'talk' ? (room?.members ?? []).filter((m) => m.enabled && m.modelLabel).map((m) => m.modelLabel) : room?.workerModel ? [room.workerModel] : [];
  const membersOn = panel?.rows.filter((r) => r.active).length ?? 0;
  return <details ref={details} className="agent-settings" onToggle={(e) => { const isOpen = e.currentTarget.open; setOpen(isOpen); if (isOpen) void load(); }}>
    <summary>{scope === 'talk' ? 'Discussion members' : 'Worker'} · <span>{models.length ? models.join(', ') : 'provider & model'}</span></summary>
    {open && <form aria-label={scope === 'talk' ? 'Discussion members' : 'Worker settings'} onSubmit={(e) => { e.preventDefault(); save(); }}>
      {panel && <p className="settings-hint">{panel.hint}</p>}
      {panel?.rows.map((row, i) => <AgentRow key={i} row={row} models={panel.models} title={scope === 'talk' ? 'Agent ' + (i + 1) : 'Worker'} member={!!panel.plan || panel.members}
        locked={panel.members ? row.active && membersOn <= 1 : !!panel.plan?.locked(i)} disabled={panel.members} change={change(i)} commit={save} />)}
      <div className="settings-hint">{sessions.map((s) => <div key={s.name}>{s.name + ' (' + s.provider + ') session ID: ' + (s.id ?? 'available after its first completed turn')}</div>)}</div>
      {panel?.note && (panel.plan ? panel.rows.some((_, i) => panel.plan!.locked(i)) : true) && <p className="settings-hint member-note">{panel.note}</p>}
      <p className="settings-hint">CLI default uses the provider’s settings. Custom model IDs require account access.</p>
      <p className="settings-status" role="status">{result}</p>
    </form>}
  </details>;
}
// Agents that failed or were disabled in this discussion, each with Disable or Enable (showFailedAgents).
export function FailedAgents({ agents, post, status }: { agents: Room['failedAgents'] | undefined; post: Post; status: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!agents?.length) return null;
  return <div className="failed-agents" role="status" aria-label="Failed agents">{agents.map((agent) => <div key={agent.name}>
    <span>{agent.name + (agent.disabled ? ' is disabled. ' : ' failed. ')}</span>
    <button type="button" disabled={busy === agent.name} onClick={async () => {
      setBusy(agent.name);
      try { const res = await post('__agent-enabled', { name: agent.name, enabled: agent.disabled }); if (!res.ok) throw new Error(await res.text()); }
      catch (err) { status(err instanceof Error ? err.message : String(err)); }
      setBusy(null);
    }}>{agent.disabled ? 'Enable' : 'Disable'}</button>
  </div>)}</div>;
}
