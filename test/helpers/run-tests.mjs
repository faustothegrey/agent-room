import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = process.argv[2];
const directory = mkdtempSync(join(tmpdir(), 'agent-room-test-'));
const report = join(directory, 'report.jsonl');
const testDir = fileURLToPath(new URL('..', import.meta.url));
const listPath = (name) => join(testDir, `${name}.txt`);
const readList = (name) => readFileSync(listPath(name), 'utf8').split('\n').filter(Boolean);
const fast = readList('fast');
const slow = readList('slow');
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
  for (const { type, data } of events) {
    if (data.skip || data.todo) {
      if (!fast.includes(data.name) && !slow.includes(data.name)) console.error(`New test skipped or todo; not assigned: ${data.name}`);
      continue;
    }
    const duration = data.details?.duration_ms;
    if (fast.includes(data.name) && duration > 1000) console.error(`Fast test exceeded 1 s (${duration.toFixed(1)} ms): ${data.name}`);
    if (!fast.includes(data.name) && !slow.includes(data.name)) {
      if (type === 'test:fail') console.error(`New test failed; not assigned: ${data.name}`);
      else if (typeof duration === 'number') {
        const list = duration <= 1000 ? fast : slow;
        list.push(data.name);
        console.log(`Assigned to ${list === fast ? 'fast' : 'slow'} (${duration.toFixed(1)} ms): ${data.name}`);
      }
    }
  }
  writeFileSync(listPath('fast'), fast.join('\n') + (fast.length ? '\n' : ''));
  writeFileSync(listPath('slow'), slow.join('\n') + (slow.length ? '\n' : ''));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exitCode = result.status ?? 1;
