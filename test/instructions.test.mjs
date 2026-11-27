import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as i from '../src/instructions.mjs';

const wording = JSON.parse(readFileSync(new URL('./fixtures/instruction-wording.json', import.meta.url)));

test('prompt builders fill the displayed templates and retain their wording', () => {
  const agents = [{ name: 'A' }, { name: 'B' }], place = { cwd: '/tree', path: '/tree', branch: 'worker/x' };
  const cases = [];
  const add = (key, actual, template, values = {}, suffix = '') => cases.push([key, actual, i.fill(template, values) + suffix]);
  const introValues = { name: 'A', participants: 'A, B', order: 'A, then B' };
  add('intro', i.intro(agents[0], agents), i.INTRO, introValues);
  const feasibility = { kind: 'Feasibility', effort: 'Feasibility', output: 'Feasibility' };
  add('researchIntro', i.intro(agents[0], agents, true), i.RESEARCH_INTRO, { ...introValues, ...feasibility });
  add('researchIntroFeasibility', i.intro(agents[0], agents, { deep: false, theoretical: false }), i.RESEARCH_INTRO, { ...introValues, ...feasibility });
  add('researchIntroDeep', i.intro(agents[0], agents, { deep: true }), i.RESEARCH_INTRO, { ...introValues, kind: 'Deep', effort: 'Deep', output: 'Feasibility' });
  add('researchIntroTheoretical', i.intro(agents[0], agents, { theoretical: true }), i.RESEARCH_INTRO, { ...introValues, kind: 'Theoretical', effort: 'Feasibility', output: 'Theoretical' });
  add('researchIntroDeepTheoretical', i.intro(agents[0], agents, { deep: true, theoretical: true }), i.RESEARCH_INTRO, { ...introValues, kind: 'Deep · Theoretical', effort: 'Deep', output: 'Theoretical' });
  for (const [brainstorm, kind] of [[true, 'Brainstorm'], [false, 'Discussion']]) {
    const tail = brainstorm ? 'Quote its latest version word for word when it is the Next step.' : "Quote its latest version word for word when it is the Next step; under Later refer to it by name,\nwith its full text kept in the discussion's pending-instructions.md.";
    add(`summary${kind}`, i.summaryFormat(brainstorm), i.SUMMARY_FORMAT, { 'next-step-tail': tail });
    for (const extra of [undefined, 'Extra {name}']) {
      const values = { author: 'A', 'next-step-tail': tail, extra: extra ? `\n${extra}` : '' };
      add(`draft${kind}${extra ? 'Extra' : ''}`, i.draftTask(brainstorm, extra), i.SUMMARY_DRAFT, values);
      add(`review${kind}${extra ? 'Extra' : ''}`, i.reviewTask('A', brainstorm, extra), i.SUMMARY_REVIEW, values);
    }
  }
  for (const reports of ['', 'Report']) add(reports ? 'closingReports' : 'closing', i.closingTask({ dir: '/dir', workerReports: reports }), i.CLOSING_TASK, { dir: '/dir', 'worker-reports': reports ? `Recent worker reports:\n${reports}\n\n` : '' });
  add('brief', i.workerBrief({ dir: '/dir' }, {}, place), i.WORKER_BRIEF, { dir: '/dir', cwd: '/tree' }, '\n\n');
  add('brainstorm', i.workerBrief(null, { brainstorm: true }, place), i.WORKER_BRAINSTORM, {}, '\n\n');
  add('noDiscussion', i.workerBrief(null, { briefed: '/old' }, place), i.WORKER_NO_DISCUSSION, { dir: '/old' }, '\n\n');
  const location = { cwd: '/tree', branch: 'worker/x', root: '/root', notes: '/tree/.worker-notes' };
  add('location', i.workerLocation({}, place, { cwd: '/root' }, '.worker-notes'), i.WORKER_LOCATION, location, '\n\n');
  add('moved', i.workerLocation({ tree: '/old' }, place, { cwd: '/root' }, '.worker-notes'), `${i.WORKER_MOVED} ${i.WORKER_LOCATION}`, { ...location, old: '/old' }, '\n\n');
  add('commit', i.workerCommit({}, 'x', place), i.WORKER_COMMIT, { label: 'x', branch: 'worker/x' }, '\n\n');
  add('workbench', i.workerWorkbench(true), i.WORKER_WORKBENCH, {}, '\n\n');
  for (const before of [undefined, '123456789']) add(before ? 'leftover' : 'leftoverNoBefore', i.workerLeftover({ task: 'Fix', before }, 'x', place), i.WORKER_LEFTOVER, { label: 'x', task: 'Fix', before: before ? ' (worker/x was at 1234567 when it started)' : '' }, '\n\n');
  add('merge', i.workerMerge(true, false, place, 'x'), i.WORKER_MERGE, { branch: 'worker/x', label: 'x' }, '\n\n');
  add('rollback', i.workerMerge(true, true, place, 'x'), i.WORKER_ROLLBACK_MERGE, { branch: 'worker/x' }, '\n\n');
  for (const stopped of [false, true]) add(stopped ? 'stopped' : 'interrupted', i.workerInterrupted([{ task: 'Fix', stopped }]), stopped ? i.WORKER_STOPPED : i.WORKER_INTERRUPTED, { task: 'Fix' }, '\n\n');
  add('history', i.workerHistory('History', 'Instruction'), i.WORKER_HISTORY, { history: 'History', instruction: 'Instruction' });
  add('title', i.titlePrompt('Message {name}'), i.TITLE_PROMPT, { message: 'Message {name}' });
  for (const [key, actual, filled] of cases) {
    assert.equal(actual, filled, `${key}: displayed template`);
    assert.equal(actual, wording[key], `${key}: original wording`);
  }
  assert.deepEqual(cases.map(([key]) => key).sort(), Object.keys(wording).sort());
});
