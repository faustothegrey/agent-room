import { test as nodeTest } from 'node:test';
import { readFileSync } from 'node:fs';

const readList = (name) => new Set(readFileSync(new URL(`../${name}.txt`, import.meta.url), 'utf8').split('\n').filter(Boolean));
const fast = readList('fast');
const slow = readList('slow');
const suite = process.env.AGENT_ROOM_TEST_SUITE || 'fast';

export function test(name, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const selected = suite === 'all' || (suite === 'slow' ? slow.has(name) : !slow.has(name) || fast.has(name));
  return nodeTest(name, { ...options, skip: options.skip || !selected }, fn);
}
