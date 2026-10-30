// The Found step's channels are wired end to end (first-run-polish B4.5): each has a handler in main.js, a method in
// preload.cjs and a wrapper the panel calls. A missing hop is a dead button the click check (which talks to a
// stand-in bridge) cannot see. And Keep's input is checked before anything is written.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateFoundKeep } from '../desktop/ipc-validation.js';
import { assertWired } from './helpers/main-files.js';

const CHANNELS = [
  ['hikyaku:found-status', 'foundStatus'],
  ['hikyaku:found-look', 'foundLook'],
  ['hikyaku:found-keep', 'foundKeep'],
];

test('every Found step channel has a main handler, a preload method and a panel wrapper', async () => {
  await assertWired(CHANNELS);
  const panel = await readFile(new URL('../desktop/renderer/panel.js', import.meta.url), 'utf8');
  const setupApi = panel.slice(panel.indexOf('const setupApi = {'), panel.indexOf('const setupRoot'));
  for (const method of ['foundStatus', 'foundLook', 'foundKeep', 'renameWorkstream']) assert.match(setupApi, new RegExp(`\\b${method}: async \\(`), `setupApi.${method}`);
});

test('validateFoundKeep takes two short name lists and an end, and nothing else', () => {
  const refused = /That is not a list of workspaces Loggie found\./;
  assert.deepEqual(validateFoundKeep({ keep: [], dismiss: [], end: 'done' }), { keep: [], dismiss: [], end: 'done' });
  assert.deepEqual(validateFoundKeep({ keep: ['Robotics Club'], dismiss: ['TA'], end: null }), { keep: ['Robotics Club'], dismiss: ['TA'], end: null });
  assert.equal(validateFoundKeep({ keep: [], dismiss: ['A'], end: 'later' }).end, 'later');
  for (const bad of [
    { keep: [], dismiss: [], end: 'done', extra: 1 },
    { keep: ['A'], dismiss: ['A'], end: 'done' },
    { keep: Array.from({ length: 21 }, (_, i) => `W${i}`), dismiss: [], end: 'done' },
    { keep: ['x'.repeat(201)], dismiss: [], end: 'done' },
    { keep: [], dismiss: [], end: 'yes' },
    { keep: [], dismiss: [] },
    { keep: [''], dismiss: [], end: null },
    { keep: ['two\nlines'], dismiss: [], end: null },
    { keep: [7], dismiss: [], end: null },
    null, [], 'keep',
  ]) assert.throws(() => validateFoundKeep(bad), refused, JSON.stringify(bad));
});
