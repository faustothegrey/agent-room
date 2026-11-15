import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Durations are the counter: retaining them also lets the move report all three.
export function updateTimings(events, fast, slow, timings, report = console.log) {
  const initialFast = new Set(fast);
  for (const name of Object.keys(timings)) if (!initialFast.has(name)) delete timings[name];
  for (const { type, data } of events) {
    if (!initialFast.has(data.name) || type !== 'test:pass' || data.skip || data.todo) continue;
    const duration = data.details?.duration_ms;
    if (typeof duration !== 'number') continue;
    if (duration <= 1000) {
      delete timings[data.name];
    } else {
      if (!timings[data.name]) {
        timings[data.name] = [];
        report('Timing counters are local to this working copy; different worktrees do not share them.');
      }
      timings[data.name].push(duration);
      if (timings[data.name].length >= 3) {
        fast.splice(fast.indexOf(data.name), 1);
        slow.push(data.name);
        report(`Moved to slow after three runs over 1 s (${timings[data.name].map((ms) => `${ms.toFixed(1)} ms`).join(', ')}): ${data.name}`);
        delete timings[data.name];
        initialFast.delete(data.name);
      }
    }
  }
}

async function main() {
  const suite = process.argv[2];
  const directory = mkdtempSync(join(tmpdir(), 'agent-room-test-'));
  const report = join(directory, 'report.jsonl');
  const testDir = fileURLToPath(new URL('..', import.meta.url));
  const listPath = (name) => join(testDir, `${name}.txt`);
  const readList = (name) => readFileSync(listPath(name), 'utf8').split('\n').filter(Boolean);
  const fast = readList('fast');
  const slow = readList('slow');
  const timingsPath = join(testDir, '.timings.json');
  const timings = existsSync(timingsPath) ? JSON.parse(readFileSync(timingsPath, 'utf8')) : {};
  const files = (await import('node:fs')).readdirSync(testDir).filter((name) => name.endsWith('.test.mjs')).map((name) => join(testDir, name));
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', `--test-reporter-destination=stdout`, `--test-reporter=${fileURLToPath(new URL('reporter.mjs', import.meta.url))}`, `--test-reporter-destination=${report}`, ...files], {
    stdio: 'inherit', env: { ...process.env, HOME: directory, AGENT_ROOM_TEST_SUITE: suite },
  });
  try {
    const events = readFileSync(report, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const counts = new Map();
    for (const { data } of events) counts.set(data.name, (counts.get(data.name) || 0) + 1);
    for (const [name, count] of counts) if (count > 1) console.error(`Duplicate test name (${count}): ${name}`);
    for (const [label, list] of [['fast', fast], ['slow', slow]]) {
      for (const name of new Set(list)) {
        if (list.filter((entry) => entry === name).length > 1) console.error(`Duplicate ${label} list entry: ${name}`);
        if (!counts.has(name)) console.error(`Unmatched ${label} list entry: ${name}`);
      }
    }
    for (const name of new Set(fast)) if (slow.includes(name)) console.error(`On both lists: ${name}`);
    updateTimings(events, fast, slow, timings);
    for (const { type, data } of events) {
      if (data.skip || data.todo) {
        if (!fast.includes(data.name) && !slow.includes(data.name)) console.error(`New test skipped or todo; not assigned: ${data.name}`);
        continue;
      }
      const duration = data.details?.duration_ms;
      if (!fast.includes(data.name) && !slow.includes(data.name)) {
        if (type === 'test:fail') console.error(`New test failed; not assigned: ${data.name}`);
        else if (typeof duration === 'number') {
          const list = duration <= 1000 ? fast : slow;
          list.push(data.name);
          console.log(`Assigned to ${list === fast ? 'fast' : 'slow'} (${duration.toFixed(1)} ms): ${data.name}`);
        }
      }
    }
    writeFileSync(timingsPath, JSON.stringify(timings, null, 2) + '\n');
    writeFileSync(listPath('fast'), fast.join('\n') + (fast.length ? '\n' : ''));
    writeFileSync(listPath('slow'), slow.join('\n') + (slow.length ? '\n' : ''));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
