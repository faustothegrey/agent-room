// Provider adapters. Each agent is { name, provider, turn(prompt) -> Promise<string> }.
// One CLI process per turn; the provider's own session id carries memory between turns.
// That id lives in `session`, a plain object owned by the caller, so it survives a code reload.
// Agents may write only in proposal/: enforced for claude (path rules, no shell), by instructions
// only for codex. Set on every turn (not just the first).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// Run a command with `input` on stdin; resolve with stdout, reject on non-zero exit or timeout.
export function run(command, args, { input = '', cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
    proc.stdin.end(input);
  });
}

export function createClaudeAgent({ name, model, cwd, timeoutMs, runner = run, session = {} }) {
  session.id ??= randomUUID();
  return {
    name,
    provider: 'claude',
    async turn(prompt) {
      const args = ['-p', '--output-format', 'json'];
      args.push(session.started ? '--resume' : '--session-id', session.id);
      if (model) args.push('--model', model);
      // Edits outside proposal/ need a permission that -p cannot grant, so they are refused.
      args.push('--allowedTools', 'Write(proposal/**)', 'Edit(proposal/**)');
      // --tools is variadic, so it must come last: the prompt goes on stdin.
      args.push('--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write');
      const out = await runner('claude', args, { input: prompt, cwd, timeoutMs });
      const result = JSON.parse(out);
      if (result.is_error) throw new Error(`claude: ${result.result || 'turn failed'}`);
      session.started = true;
      return String(result.result ?? '').trim();
    },
  };
}

export function createCodexAgent({ name, model, cwd, timeoutMs, runner = run, session = {} }) {
  return {
    name,
    provider: 'codex',
    async turn(prompt) {
      // `exec resume` has no -s flag, and the user's config.toml may grant full access,
      // so the workspace-write sandbox is forced through -c on every call. It allows writes
      // anywhere under cwd: keeping codex inside proposal/ relies on its instructions (owner's call).
      const args = session.threadId ? ['exec', 'resume'] : ['exec'];
      args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"');
      if (model) args.push('-m', model);
      if (session.threadId) args.push(session.threadId);
      args.push('-');
      const out = await runner('codex', args, { input: prompt, cwd, timeoutMs });
      const { threadId: id, text } = parseCodexEvents(out);
      if (id) session.threadId = id;
      return text;
    },
  };
}

// Codex --json prints one event per line. The reply is the last agent_message.
export function parseCodexEvents(stdout) {
  let threadId = null;
  let text = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    if (event.type === 'turn.failed') throw new Error(`codex: ${event.error?.message || 'turn failed'}`);
  }
  return { threadId, text: text.trim() };
}

const FACTORIES = { claude: createClaudeAgent, codex: createCodexAgent };

export function createAgent(provider, options) {
  const factory = FACTORIES[provider];
  if (!factory) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(FACTORIES).join(', ')}`);
  return factory(options);
}
