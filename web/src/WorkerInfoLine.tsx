import { useEffect, useState } from 'react';
import type { WorkerInfo, WorkerLane } from '../../src/contract';

// The Worker tab's line, as showWorkerInfo / setWorkerInfo do on /__room: its lines (or one
// collapsible section per lane), red when the worker is disabled or failed. A brainstorm sends no
// work, whatever the worker's own state; a read-only page (Peek, a peer's view) shows the info as is.
export const BRAINSTORM_NO_WORK = 'Turn this brainstorm into a discussion to send work.';
export function shownWorkerInfo(info: WorkerInfo | null, brainstorm: boolean, readOnly: boolean): WorkerInfo | null {
  return !readOnly && brainstorm ? { lines: [BRAINSTORM_NO_WORK], disabled: true } : info;
}

type Mermaid = { initialize(options: object): void; render(id: string, source: string): Promise<{ svg: string }> };
const win = () => window as unknown as { mermaid?: Mermaid };
let mermaidReady: Promise<Mermaid> | null = null, diagramSeq = 0;
const diagramCache = new Map<string, string>();
const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
function loadMermaid(): Promise<Mermaid> {
  const loaded = win().mermaid; if (loaded) return Promise.resolve(loaded);
  return mermaidReady ??= new Promise((done, fail) => {
    const script = document.createElement('script');
    script.src = '__lib/mermaid.js';
    script.onload = () => {
      const m = win().mermaid;
      if (!m) { mermaidReady = null; fail(new Error('Mermaid failed to load')); return; }
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark() ? 'dark' : 'default' });
      done(m);
    };
    script.onerror = () => { mermaidReady = null; fail(new Error('Could not load Mermaid')); };
    document.head.append(script);
  });
}
// A lane's branch diagram, drawn (with Mermaid, loaded once) only while its section is open.
function BranchDiagram({ graph }: { graph: string }) {
  const [shown, setShown] = useState<{ svg?: string; error?: string }>(() => ({ svg: diagramCache.get((dark() ? 'dark' : 'default') + '\n' + graph) }));
  useEffect(() => {
    const key = (dark() ? 'dark' : 'default') + '\n' + graph;
    const cached = diagramCache.get(key); if (cached) { setShown({ svg: cached }); return; }
    let live = true; setShown({});
    loadMermaid().then((m) => {
      const id = 'wgit-' + (++diagramSeq);
      return m.render(id, graph).then(({ svg }) => {
        if (diagramCache.size > 40) diagramCache.clear();
        diagramCache.set(key, svg);
        if (live) setShown({ svg });
      }, (err: unknown) => { document.getElementById('d' + id)?.remove(); throw err; });
    }).catch((err: unknown) => { if (live) setShown({ error: 'Branch diagram unavailable: ' + (err instanceof Error ? err.message : String(err)) }); });
    return () => { live = false; };
  }, [graph]);
  if (shown.error) return <div className="branch-diagram-note">{shown.error}</div>;
  if (!shown.svg) return <div className="branch-diagram">Drawing branch diagram…</div>;
  return <div className="branch-diagram" dangerouslySetInnerHTML={{ __html: shown.svg }} />;
}
// A merge preview line can name many conflicting files: shown collapsed, its outcome in the summary.
function Line({ line, error }: { line: string; error: boolean }) {
  const m = /^(Merge preview of \S+ into \S+) \((.+?)\): (.*)$/.exec(line);
  if (!m) return <div className={error ? 'error' : undefined}>{line}</div>;
  const files = /^would conflict in (.*)\.$/.exec(m[3])?.[1].split(', ');
  const outcome = m[3].startsWith('clean') ? 'clean' : files ? 'would conflict in ' + files.length + (files.length === 1 ? ' file' : ' files') : 'could not be computed';
  return <details className={error ? 'error' : undefined}><summary>{m[1]}: {outcome}</summary><div className="preview-files">{m[3]} ({m[2]})</div></details>;
}
const lineKey = (line: string, index: number) => /^Merge preview of \S+ into \S+/.exec(line)?.[0] ?? String(index);
function Lane({ lane, error }: { lane: WorkerLane; error: boolean }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{lane.summary}</summary>
    <div className="lane-lines">
      {lane.lines.map((line, index) => <Line key={lineKey(line, index)} line={line} error={error} />)}
      {lane.diagram?.note ? <div className="branch-diagram-note">{lane.diagram.note}</div> : lane.diagram?.graph && open ? <BranchDiagram graph={lane.diagram.graph} /> : null}
    </div>
  </details>;
}
export function WorkerInfoLine({ info }: { info: WorkerInfo | null }) {
  if (!info) return null;
  const error = !!(info.error || info.disabled);
  return <div className="winfo" aria-label="Worker info" aria-live="polite">
    {info.lanes
      ? info.lanes.map((lane) => <Lane key={'lane ' + lane.summary.split(' · ')[0]} lane={lane} error={error} />)
      : info.lines.map((line, index) => <Line key={lineKey(line, index)} line={line} error={error} />)}
  </div>;
}
