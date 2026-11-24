import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('dev rebuild and Reload notify the new page after publishing the build', { timeout: 30000 }, async () => {
  const { cpSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'next-rebuild-'));
  for (const name of ['src', 'rulebooks', 'web']) cpSync(join(source, name), join(root, name), { recursive: true, filter: (p) => !p.includes('/web/dist') });
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  const cli = spawn(process.execPath, [join(root, 'src/cli.mjs'), '--cwd', root, '--port', '0', '--dev'], { env: { ...process.env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', reader;
  cli.stdout.on('data', (d) => { output += d; }); cli.stderr.on('data', (d) => { output += d; });
  const until = async (fn) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((ok) => setTimeout(ok, 50)); }
    throw new Error('Timed out: ' + output);
  };
  try {
    const origin = await until(() => output.match(/Discussion screen: (http:\/\/[^/]+)/)?.[1]);
    await until(async () => (await fetch(origin + '/__next')).ok);
    const health = await (await fetch(origin + '/__health')).json();
    const room = `/r/${health.rooms[0].id}/`;
    const oldHtml = await (await fetch(origin + room + '__next')).text();
    const oldAsset = new URL(oldHtml.match(/src="([^"]+)"/)[1], origin + room + '__next');
    const events = await fetch(origin + room + '__next/events');
    reader = events.body.getReader();
    const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().slice(6));
    const initial = await next();
    const page = join(root, 'web/src/main.tsx');
    const { readFileSync } = await import('node:fs');
    const original = readFileSync(page, 'utf8');
    writeFileSync(page, 'invalid !!! syntax');
    await until(() => output.includes('Web build failed;'));
    assert.equal((await fetch(oldAsset)).status, 200);
    writeFileSync(page, original.replace('The new room page is being built.', 'The new room page has changed.'));
    const rebuilt = await next();
    assert.ok(rebuilt.version); assert.notEqual(rebuilt.version, initial.version);
    assert.equal((await fetch(oldAsset)).status, 404);
    const post = await fetch(origin + room + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '/reload' }) });
    assert.equal(post.status, 204);
    assert.equal((await next()).version, rebuilt.version);
    assert.equal((await fetch(origin + room + '__room')).status, 200);
  } finally {
    await reader?.cancel(); cli.kill('SIGTERM');
    await new Promise((ok) => cli.exitCode !== null ? ok() : cli.once('exit', ok));
    rmSync(root, { recursive: true, force: true });
  }
});
