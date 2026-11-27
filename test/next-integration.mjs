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
  const cli = spawn(process.execPath, [join(root, 'src/cli.mjs'), '--cwd', root, '--port', '0', '--dev'], { env: { ...process.env, HOME: root, AGENT_ROOM_NO_STARTUP_CHECKS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const oldHtml = await (await fetch(origin + room + '__room')).text();
    const oldAsset = new URL(oldHtml.match(/src="([^"]+)"/)[1], origin + room + '__room');
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
    const oldPageVersion = '66c0b857b36e'; // legacy page's version before the switch
    assert.notEqual(initial.page, oldPageVersion); // an already-open legacy page refreshes on reloaded
    const page = join(root, 'web/src/App.tsx');
    const { readFileSync } = await import('node:fs');
    const original = readFileSync(page, 'utf8');
    writeFileSync(page, 'invalid !!! syntax');
    await until(() => output.includes('Web build failed;'));
    assert.equal((await fetch(oldAsset)).status, 200);
    writeFileSync(page, original.replace('Conversation', 'Updated conversation'));
    const rebuilt = await untilEvent('web-version');
    assert.ok(rebuilt.webVersion); assert.notEqual(rebuilt.webVersion, initial.webVersion);
    const legacyRefresh = await untilEvent('reloaded');
    assert.notEqual(legacyRefresh.page, oldPageVersion); assert.equal(legacyRefresh.webVersion, rebuilt.webVersion);
    assert.notEqual(await (await fetch(origin + room + '__room')).text(), oldHtml);
    await reader.cancel();
    reader = (await fetch(origin + room + '__events')).body.getReader(); buffer = '';
    const reconnected = await untilEvent('reset');
    assert.equal(reconnected.webVersion, rebuilt.webVersion); assert.equal(reconnected.page, initial.page);
    assert.equal((await fetch(oldAsset)).status, 404);
    const post = await fetch(origin + room + '__say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '/reload' }) });
    assert.equal(post.status, 204);
    const reload = await untilEvent('reloaded');
    assert.equal(reload.webVersion, rebuilt.webVersion); assert.equal(reload.page, initial.page);
    assert.notEqual(reload.page, oldPageVersion);
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
  const cli = spawn(process.execPath, [join(root, 'src/cli.mjs'), '--cwd', root, '--port', '0'], { env: { ...process.env, HOME: root, AGENT_ROOM_NO_STARTUP_CHECKS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    assert.notEqual(await (await fetch(origin + room + '__room')).text(), before);
  } finally {
    cli.kill('SIGTERM'); await new Promise((ok) => cli.exitCode !== null ? ok() : cli.once('exit', ok));
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct start builds a missing or stale page and survives a failed build', { timeout: 60000 }, async () => {
  const { cpSync, existsSync, readFileSync, statSync, utimesSync, readdirSync, mkdirSync } = await import('node:fs');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const source = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'next-direct-'));
  for (const name of ['src', 'rulebooks', 'web']) cpSync(join(source, name), join(root, name), { recursive: true, filter: (p) => !p.includes('/web/dist') });
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  const run = async (missing = false) => {
    const cli = spawn(process.execPath, [join(root, 'src/cli.mjs'), '--cwd', root, '--port', '0'], { env: { ...process.env, HOME: root, AGENT_ROOM_NO_STARTUP_CHECKS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    cli.stdout.on('data', (d) => { output += d; }); cli.stderr.on('data', (d) => { output += d; });
    try {
      const end = Date.now() + 20000;
      while (!output.match(/Discussion screen: (http:\/\/[^/]+)/)) {
        if (cli.exitCode !== null || Date.now() > end) throw new Error(output);
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const origin = output.match(/Discussion screen: (http:\/\/[^/]+)/)[1];
      assert.equal((await fetch(origin + '/__room')).status, missing ? 404 : 200);
      if (missing) { const page = await fetch(origin + '/__next'); assert.equal(page.status, 404); assert.match(await page.text(), /Web build missing/); }
      return output;
    } finally {
      cli.kill('SIGTERM');
      await new Promise((ok) => cli.exitCode !== null ? ok() : cli.once('exit', ok));
    }
  };
  try {
    assert.match(await run(), /Web build complete/);
    const index = join(root, 'web/dist/index.html'); assert.ok(existsSync(index));
    assert.doesNotMatch(await run(), /Web build complete/);
    const app = join(root, 'web/src/App.tsx'), original = readFileSync(app, 'utf8');
    const future = new Date(statSync(index).mtimeMs + 2000); utimesSync(app, future, future);
    assert.match(await run(), /Web build complete/);
    writeFileSync(app, 'invalid !!! syntax'); utimesSync(app, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    assert.match(await run(), /Web build failed/); assert.ok(existsSync(index));
    writeFileSync(app, original);
    rmSync(join(root, 'web/dist'), { recursive: true, force: true });
    rmSync(join(root, 'node_modules')); mkdirSync(join(root, 'node_modules'));
    for (const name of readdirSync(join(source, 'node_modules'))) if (name !== 'vite') symlinkSync(join(source, 'node_modules', name), join(root, 'node_modules', name));
    assert.match(await run(true), /Web build failed/); assert.equal(existsSync(index), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
