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
    const oldRoom = await (await fetch(origin + room + '__room')).text();
    assert.equal((await fetch(origin + room + '__next/events')).status, 404);
    const events = await fetch(origin + room + '__events');
    reader = events.body.getReader();
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('stream ended'); buffer += new TextDecoder().decode(chunk.value); }
      const end = buffer.indexOf('\n\n'), part = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return JSON.parse(part.slice(6));
    };
    const untilEvent = async (type) => { for (;;) { const event = await next(); if (event.type === type) return event; } };
    const initial = await untilEvent('reset');
    const page = join(root, 'web/src/App.tsx');
    const { readFileSync } = await import('node:fs');
    const original = readFileSync(page, 'utf8');
    writeFileSync(page, 'invalid !!! syntax');
    await until(() => output.includes('Web build failed;'));
    assert.equal((await fetch(oldAsset)).status, 200);
    writeFileSync(page, original.replace('Conversation', 'Updated conversation'));
    const rebuilt = await untilEvent('web-version');
    assert.ok(rebuilt.webVersion); assert.notEqual(rebuilt.webVersion, initial.webVersion);
    assert.equal(await (await fetch(origin + room + '__room')).text(), oldRoom);
    await reader.cancel();
    reader = (await fetch(origin + room + '__events')).body.getReader(); buffer = '';
    const reconnected = await untilEvent('reset');
    assert.equal(reconnected.webVersion, rebuilt.webVersion); assert.equal(reconnected.page, initial.page);
    assert.equal((await fetch(oldAsset)).status, 404);
    const post = await fetch(origin + room + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '/reload' }) });
    assert.equal(post.status, 204);
    const reload = await untilEvent('reloaded');
    assert.equal(reload.webVersion, rebuilt.webVersion); assert.equal(reload.page, initial.page);
    assert.equal((await fetch(origin + room + '__room')).status, 200);
  } finally {
    await reader?.cancel(); cli.kill('SIGTERM');
    await new Promise((ok) => cli.exitCode !== null ? ok() : cli.once('exit', ok));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Reload loads each extracted document module again', { timeout: 30000 }, async () => {
  const { cpSync, readFileSync } = await import('node:fs');
  const { spawn, execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'docs-reload-'));
  for (const name of ['src', 'rulebooks', 'web']) cpSync(join(source, name), join(root, name), { recursive: true, filter: (p) => !p.includes('/web/dist') });
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(root, 'src/cli.mjs'), '--build-web'], { cwd: root });
  const cli = spawn(process.execPath, [join(root, 'src/cli.mjs'), '--cwd', root, '--port', '0'], { env: { ...process.env, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  cli.stdout.on('data', (d) => { output += d; }); cli.stderr.on('data', (d) => { output += d; });
  const until = async (fn) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((ok) => setTimeout(ok, 50)); }
    throw new Error('Timed out: ' + output);
  };
  try {
    const origin = await until(() => output.match(/Discussion screen: (http:\/\/[^/]+)/)?.[1]);
    const room = `/r/${(await (await fetch(origin + '/__health')).json()).rooms[0].id}/`;
    const before = await (await fetch(origin + room + '__room')).text();
    const change = (file, from, to) => {
      const path = join(root, 'src', file), text = readFileSync(path, 'utf8');
      assert.ok(text.includes(from), file); writeFileSync(path, text.replace(from, to));
    };
    change('docs-files.mjs', 'export function roomBranch(dir) {', "export function roomBranch(dir) { return 'reload-files';");
    change('docs-routes.mjs', "send(405, 'text/plain', 'Use GET.')", "send(405, 'text/plain', 'reload-routes')");
    change('docs-next.mjs', '<meta name="agent-room-next-version"', '<meta name="reload-next" content="yes"><meta name="agent-room-next-version"');
    change('docs-http.mjs', '`Not found: ${rel}`', '`reload-http: ${rel}`');
    change('screen-events.mjs', 'input: !!screen.say,', 'input: false,');
    const command = await fetch(origin + room + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '/reload' }) });
    assert.equal(command.status, 204);
    await until(async () => (await (await fetch(origin + room + '__files?detail=1')).json()).branch === 'reload-files');
    assert.equal(await (await fetch(origin + room + '__rooms', { method: 'POST' })).text(), 'reload-routes');
    assert.match(await (await fetch(origin + room + '__next')).text(), /reload-next/);
    assert.equal(await (await fetch(origin + room + 'missing-file')).text(), 'reload-http: missing-file');
    const response = await fetch(origin + room + '__events');
    const reader = response.body.getReader();
    const reset = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim().slice(6));
    assert.equal(reset.input, false); await reader.cancel();
    assert.equal(await (await fetch(origin + room + '__room')).text(), before);
  } finally {
    cli.kill('SIGTERM'); await new Promise((ok) => cli.exitCode !== null ? ok() : cli.once('exit', ok));
    rmSync(root, { recursive: true, force: true });
  }
});
