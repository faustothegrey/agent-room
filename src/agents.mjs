// Provider adapters. Each agent is { name, provider, turn(prompt) -> Promise<string> }.
// One CLI process per turn; the provider's own session id carries memory between turns.
// That id lives in `session`, a plain object owned by the caller, so it survives a code reload.
// `instructions` (the brainstorming rulebook) go in as system-level instructions on every turn.
// Agents get full filesystem access (the owner's call): claude can read and write any path but has
// no shell; codex runs with no sandbox. Keeping to the active discussion's folder is left to their instructions.
// Access settings apply on every turn. The worker (ui.mjs) can use either provider;
// a Claude worker is created with `shell: true` to add pre-approved Bash.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
// An agent's working directory: a path, or a function giving it at each turn (the worker's worktree,
// which exists only from its first instruction on).
const at = (cwd) => (typeof cwd === 'function' ? cwd() : cwd);

// Run a command with `input` on stdin; resolve with stdout, reject on non-zero exit or timeout.
// `procs` (a Set, optional) holds the process while it runs, so its room can stop it (Quit room).
// `record` ({ agent, room, dir? }, optional) writes the program in the record of programs (below)
// until its process group ends.
export function run(command, args, { input = '', cwd, timeoutMs = DEFAULT_TIMEOUT_MS, procs, record } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.provider = command;
    if (record && proc.pid) recordProgram({ pid: proc.pid, started: new Date().toISOString(), provider: command, agent: record.agent, room: record.room, server: SERVER }, record.dir);
    const forget = () => { if (record && proc.pid) forgetProgram(proc.pid, record.dir); };
    procs?.add(proc);
    // Keep the group tracked even if the provider exits before its commands.
    proc.stopGroup = (signal) => { try { process.kill(-proc.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    proc.groupAlive = () => { try { process.kill(-proc.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
    proc.on('close', () => { if (!proc.groupAlive()) { procs?.delete(proc); forget(); } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.stopGroup('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); procs?.delete(proc); forget(); reject(err); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (code === null) reject(new Error(`${command} was stopped (${signal})`));
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
    });
    proc.stdin.end(input);
  });
}

// The record of agent-room's programs on this computer, so that those still alive after a crash or a
// Restart (leftovers) can be found: one small file per program, <pid>.json, so that several servers
// never write the same file. Known limit: a crash between the spawn and the write leaves that
// program unrecorded, so unseen.
// The server that started a program (this process): its PID and start time, so that the programs
// of another agent-room server still running are not taken for leftovers.
const SERVER = { pid: process.pid, started: new Date(Date.now() - process.uptime() * 1000).toISOString() };
export const programsDirectory = () => join(homedir(), '.local', 'state', 'agent-room', 'programs');
export function recordProgram(entry, dir = programsDirectory()) {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${entry.pid}.json`), JSON.stringify(entry) + '\n'); } catch {}
}
export function forgetProgram(pid, dir = programsDirectory()) {
  try { unlinkSync(join(dir, `${pid}.json`)); } catch {}
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
// A process's group and leader, and when the leader started (ms, from ps; null if unknown).
export async function probeProcess(pid) {
  const group = alive(-pid), leader = alive(pid);
  const startedAt = !leader ? null : await new Promise((done) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)],
    { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 }, (err, out) => done(err ? null : Date.parse(out.trim()) || null)));
  return { group, leader, startedAt };
}
// ps gives the start to the second; the record is written just after the spawn.
const SAME_START_MS = 5000;
// The recorded programs left over: not in `tracked` (the pids in this server's rooms' procs), their
// process group still alive, and the server that started them gone (its PID not alive, or alive with
// another start time: reused). While the leader is alive it must have the recorded start time
// (otherwise its number was reused and the entry is dropped); a group alive after its leader ended
// is a possible leftover, `unverified`, as is one whose server's start can't be read. Entries whose
// group is gone are dropped.
const sameStart = (ms, iso) => Math.abs(ms - Date.parse(iso)) <= SAME_START_MS;
// 'running', 'gone' or 'unknown' (alive, start unreadable). A record without a server (written
// before servers were recorded) counts as gone.
async function serverState(server, probe) {
  if (!server?.pid) return 'gone';
  const s = await probe(server.pid);
  if (!s.leader) return 'gone';
  if (s.startedAt === null) return 'unknown';
  return sameStart(s.startedAt, server.started) ? 'running' : 'gone';
}
export async function findLeftovers(tracked, { dir = programsDirectory(), probe = probeProcess } = {}) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch {}
  const found = [];
  for (const name of names) {
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { entry = null; }
    const pid = Number(name.slice(0, -5));
    if (entry?.pid !== pid) { forgetProgram(pid, dir); continue; } // unreadable
    const p = await probe(pid);
    if (!p.group) { forgetProgram(pid, dir); continue; }
    if (tracked.has(pid)) continue;
    const server = await serverState(entry.server, probe);
    if (server === 'running') continue; // another server's program, still in its hands
    if (p.leader && p.startedAt !== null) {
      if (!sameStart(p.startedAt, entry.started)) { forgetProgram(pid, dir); continue; }
      found.push({ ...entry, unverified: server === 'unknown' });
    } else found.push({ ...entry, unverified: true });
  }
  return found;
}

export function createClaudeAgent({ name, model, cwd, timeoutMs, instructions, shell = false, runner = run, session = {} }) {
  session.id ??= randomUUID();
  const agent = {
    name,
    provider: 'claude',
    lastUsage: null,
    // A fresh CLI session from the next turn on (Resume or Start fresh elsewhere); `session` is kept, emptied.
    reset() { session.id = randomUUID(); session.started = false; },
    async turn(prompt) {
      agent.lastUsage = null;
      const args = ['-p', '--output-format', 'json'];
      args.push(session.started ? '--resume' : '--session-id', session.id);
      if (model) args.push('--model', model);
      if (instructions) args.push('--append-system-prompt', instructions);
      const bash = shell ? ['Bash'] : [];
      args.push('--chrome', '--strict-mcp-config', '--allowedTools', ...CLAUDE_ALLOWED, ...bash);
      // --tools is variadic, so it must come last: the prompt goes on stdin.
      args.push('--tools', ...CLAUDE_TOOLS, ...bash);
      const out = await runner('claude', args, { input: prompt, cwd: at(cwd), timeoutMs, agent: name });
      const result = JSON.parse(out);
      if (result.is_error) throw new Error(`claude: ${result.result || 'turn failed'}`);
      session.started = true;
      agent.lastUsage = claudeUsage(result);
      return String(result.result ?? '').trim();
    },
  };
  return agent;
}

// A short title for a new discussion, from the User's first message: one claude call with no tools
// at all (so it can't write anything) and no saved session. Resolves to { title, usage }.
export async function claudeTitle(message, { runner = run, cwd, timeoutMs = TITLE_TIMEOUT_MS } = {}) {
  const prompt = [
    'Suggest a short title, at most 6 words, for a discussion that starts with the message below.',
    'Reply with the title only, with no quotes and no full stop.', '', 'Message:', message,
  ].join('\n');
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
  const result = JSON.parse(await runner('claude', args, { input: prompt, cwd, timeoutMs, agent: 'title' }));
  if (result.is_error) throw new Error(`claude: ${result.result || 'title failed'}`);
  const title = String(result.result ?? '').split('\n')[0].replace(/^["'*\s]+|["'*.\s]+$/g, '').slice(0, 80);
  if (!title) throw new Error('claude gave an empty title');
  return { title, usage: claudeUsage(result) };
}
// One measured title took 4.5s (2026-11-02); past this the date-and-time name is used instead.
const TITLE_TIMEOUT_MS = 30 * 1000;

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
    reset() { delete session.threadId; },
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
      const out = await runner('codex', args, { input: prompt, cwd: at(cwd), timeoutMs, agent: name });
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
