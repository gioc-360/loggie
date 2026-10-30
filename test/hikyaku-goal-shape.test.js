import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoteTaskGoals, taskShaped } from '../src/hikyaku/goal-shape.js';
import { storeCore } from './helpers/fake-core.js';

test('a step with a day is task-shaped; an outcome is not', () => {
  assert.equal(taskShaped('Resolve the October 24 class conflict with the professor'), true);
  assert.equal(taskShaped('Submit the deck by Nov 9'), true);
  assert.equal(taskShaped('Confirm registration tomorrow'), true);
  assert.equal(taskShaped('Get an Executive Associate offer through the HR interview on Oct 16'), false);
  assert.equal(taskShaped('Win or place in the case competition'), false);
  assert.equal(taskShaped('Resolve how the team splits work'), false);
});

const fakeCore = (projects) => storeCore({ projects, status: null });

test('a task-shaped draft becomes a move once and the goal falls back to its label', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-goal-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([
    { name: 'Hotel Hackathon', kind: 'competition', goal: 'Win or place', goalText: 'Resolve the October 24 class conflict to join build day', goalQuote: 'q', goalConfirmed: false },
    { name: 'Bank Offer', kind: 'company', goalText: 'Send the thank-you note by Oct 10', goalConfirmed: true },
    { name: 'App Project', kind: 'other', goalText: 'Get the app working for the team' },
  ]));
  const core = fakeCore([{ id: 'p1', name: 'Hotel Hackathon' }, { id: 'p2', name: 'Bank Offer' }]);
  const first = await demoteTaskGoals({ home, core });
  assert.deepEqual(first.demoted.map((d) => d.name), ['Hotel Hackathon']);
  assert.equal(core.tasks.length, 1);
  assert.equal(core.tasks[0].title, 'Resolve the October 24 class conflict to join build day');
  assert.equal(core.tasks[0].projectId, 'p1');
  const saved = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'));
  assert.equal('goalText' in saved[0], false);
  assert.equal(saved[0].goal, 'Win or place');
  assert.equal(saved[1].goalText, 'Send the thank-you note by Oct 10');
  assert.equal(saved[2].goalText, 'Get the app working for the team');
  const edits = (await readFile(join(home, 'goal-edits.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(edits[0].demoted, true);
  const again = await demoteTaskGoals({ home, core });
  assert.deepEqual(again, { demoted: [], skipped: [] });
  assert.equal(core.tasks.length, 1);
});

test('a draft whose workstream has no project yet is kept and reported', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-goal-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'New Thing', kind: 'other', goalText: 'Book the room for Friday' }]));
  const result = await demoteTaskGoals({ home, core: fakeCore([]) });
  assert.deepEqual(result.skipped, [{ name: 'New Thing', why: 'no project for this workstream yet' }]);
  assert.equal(JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'))[0].goalText, 'Book the room for Friday');
});

test('no workstreams.json yet (a first run) demotes nothing and throws nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-goal-'));
  assert.deepEqual(await demoteTaskGoals({ home, core: fakeCore([]) }), { demoted: [], skipped: [] });
});
