import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import { updateTimings } from './helpers/run-tests.mjs';

test('fast test timings count only consecutive completed passes and move after three', () => {
  const slow = ['alreadySlow'];
  const timings = { stale: [1200], alreadySlow: [1200] };
  const messages = [];
  const event = (type, duration, extra = {}) => ({ type, data: { name: 'example', details: { duration_ms: duration }, ...extra } });
  const run = (...events) => updateTimings(events, slow, timings, (message) => messages.push(message));
  run(event('test:pass', 1100));
  run(event('test:fail', 2000), event('test:pass', 2000, { skip: true }));
  assert.deepEqual(timings, { example: [1100] });
  run(event('test:pass', 1000));
  assert.deepEqual(timings, {});
  run(event('test:pass', 1100), event('test:pass', 1200), event('test:pass', 1300));
  assert.deepEqual(slow, ['alreadySlow', 'example']);
  assert.deepEqual(timings, {});
  assert.match(messages.join('\n'), /working copy/);
  assert.match(messages.join('\n'), /1100\.0 ms, 1200\.0 ms, 1300\.0 ms/);
  run(event('test:pass', 50), event('test:pass', 2000));
  assert.deepEqual(slow, ['alreadySlow', 'example']);
  assert.deepEqual(timings, {});
});
