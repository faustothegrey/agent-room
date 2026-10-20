// Provider adapters. Each agent is { name, provider, turn(prompt) -> Promise<string> }.
// One CLI process per turn; the provider's own session id carries memory between turns.
// That id lives in `session`, a plain object owned by the caller, so it survives a code reload.
// `instructions` (the brainstorming rulebook) go in as system-level instructions on every turn.
// Agents get full filesystem access (the owner's call): claude can read and write any path but has
// no shell; codex runs with no sandbox. Keeping to proposal/ is left to their instructions.
// Set on every turn (not just the first).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Claude: the file, web and sub-agent built-ins (no Bash), plus the
// look-and-click subset of Claude in Chrome (no JavaScript, forms, uploads or batches). The
// claude.ai connectors (Gmail, Calendar, Drive, Docs) are left out: --strict-mcp-config drops them.
const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch'];
const CHROME_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'computer', 'read_page',
  'get_page_text', 'find', 'read_console_messages', 'read_network_requests', 'resize_window'].map((t) => `mcp__claude-in-chrome__${t}`);
// Headless claude refuses anything that would need a permission prompt, so these are pre-approved.
// The plain tool names allow any path. The read tools are listed too: inside the working directory
// they need no approval, but outside it they do.
const CLAUDE_ALLOWED = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task', 'Skill', 'ToolSearch', ...CHROME_TOOLS];

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

export function createClaudeAgent({ name, model, cwd, timeoutMs, instructions, runner = run, session = {} }) {
  session.id ??= randomUUID();
  const agent = {
    name,
    provider: 'claude',
    lastUsage: null,
    async turn(prompt) {
      agent.lastUsage = null;
      const args = ['-p', '--output-format', 'json'];
      args.push(session.started ? '--resume' : '--session-id', session.id);
      if (model) args.push('--model', model);
      if (instructions) args.push('--append-system-prompt', instructions);
      args.push('--chrome', '--strict-mcp-config', '--allowedTools', ...CLAUDE_ALLOWED);
      // --tools is variadic, so it must come last: the prompt goes on stdin.
      args.push('--tools', ...CLAUDE_TOOLS);
      const out = await runner('claude', args, { input: prompt, cwd, timeoutMs });
      const result = JSON.parse(out);
      if (result.is_error) throw new Error(`claude: ${result.result || 'turn failed'}`);
      session.started = true;
      agent.lastUsage = claudeUsage(result);
      return String(result.result ?? '').trim();
    },
  };
  return agent;
}

// Every adapter reports a turn's usage as { input, cached, output, cost? }: input counts all prompt
// tokens (cached ones included), cost is claude's API-price equivalent in USD, not a subscription bill.
function claudeUsage({ usage: u, total_cost_usd: cost }) {
  if (!u) return null;
  const cached = u.cache_read_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
  return { input, cached, output: u.output_tokens ?? 0, ...(typeof cost === 'number' && { cost }) };
}

export function createCodexAgent({ name, model, cwd, timeoutMs, instructions, runner = run, session = {} }) {
  const agent = {
    name,
    provider: 'codex',
    lastUsage: null,
    async turn(prompt) {
      agent.lastUsage = null;
      // `exec resume` has no -s flag, so the sandbox is set through -c on every call: none at all
      // (any file, any command, network). Web search is live rather than cached.
      const args = session.threadId ? ['exec', 'resume'] : ['exec'];
      args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="danger-full-access"', '-c', 'web_search="live"');
      if (model) args.push('-m', model);
      // -c takes TOML; a JSON string is a valid TOML basic string.
      if (instructions) args.push('-c', `developer_instructions=${JSON.stringify(instructions)}`);
      if (session.threadId) args.push(session.threadId);
      args.push('-');
      const out = await runner('codex', args, { input: prompt, cwd, timeoutMs });
      const { threadId: id, text, usage } = parseCodexEvents(out);
      if (id) session.threadId = id;
      agent.lastUsage = usage;
      return text;
    },
  };
  return agent;
}

// Codex --json prints one event per line. The reply is the last agent_message; the usage is in
// turn.completed (its input_tokens already include the cached ones).
export function parseCodexEvents(stdout) {
  let threadId = null;
  let text = '';
  let usage = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'thread.started') threadId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    if (event.type === 'turn.failed') throw new Error(`codex: ${event.error?.message || 'turn failed'}`);
    if (event.type === 'turn.completed' && event.usage) {
      const u = event.usage;
      usage = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0 };
    }
  }
  return { threadId, text: text.trim(), usage };
}

const FACTORIES = { claude: createClaudeAgent, codex: createCodexAgent };

export function createAgent(provider, options) {
  const factory = FACTORIES[provider];
  if (!factory) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(FACTORIES).join(', ')}`);
  return factory(options);
}
