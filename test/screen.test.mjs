import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// UI mode end to end: the real CLI, driven only through the discussion screen's endpoints, the way
// the page drives it. Output is piped, so no browser opens; nothing here starts an agent.
test('UI mode: the screen is the room\'s input, its replies come back as events, Quit ends the room', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'screen-test-'));
  const cli = spawn('node', [new URL('../src/cli.mjs', import.meta.url).pathname, '--cwd', dir, '--log-dir', join(dir, 'logs')]);
  const exited = new Promise((done) => cli.on('exit', done));
  try {
    let out = '';
    const base = await new Promise((done) => cli.stdout.on('data', (d) => {
      out += d;
      // The banner may arrive in several chunks: wait for its last line.
      const m = out.match(/Discussion screen: (http:\/\/127\.0\.0\.1:\d+\/)__room/);
      if (m && out.includes('This terminal only shows a log')) done(m[1]);
    }));

    const events = (await fetch(`${base}__events`)).body.getReader();
    let buf = '';
    const next = async () => {
      while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await events.read()).value);
      const [chunk, ...rest] = buf.split('\n\n');
      buf = rest.join('\n\n');
      return JSON.parse(chunk.replace(/^data: /, ''));
    };
    const say = (text) => fetch(`${base}__say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

    const reset = await next();
    assert.equal(reset.input, true);

    assert.equal((await say('/usage')).status, 204);
    const usage = await next();
    assert.equal(usage.type, 'note');
    assert.match(usage.text, /Usage this session/);

    await say('@nobody hello'); // an unknown agent: refused before anything is sent to an agent
    const refused = await next();
    assert.deepEqual([refused.type, refused.error], ['note', true]);
    assert.match(refused.text, /Unknown agent "@nobody"/);

    await say('/docs'); // the screen opens its own file list
    assert.deepEqual(await next(), { type: 'files' });

    await say('/quit');
    assert.deepEqual(await next(), { type: 'ended' });
    assert.equal(await exited, 0);
  } finally {
    cli.kill(); // no-op once it has exited; stops a stalled run from hanging the suite
  }
});
