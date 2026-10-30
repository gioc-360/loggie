// Retiring stale moves (retire.js): the model names, code checks, a blind second look confirms, retired.json records,
// Undo restores. Fakes only: a scripted `complete`, temp homes, made-up moves.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkRetire, notRetired, overdue, pastEvent, readRetired, retireByUser, retirePastDates, retireStale, unretire } from '../src/hikyaku/retire.js';

const SUMMARY = 'Gio has a video interview with the HR lead on October 16 for the analyst program. The team chose a navy slide template.';
const TODAY = '2026-10-11';
const task = (id, title, extra = {}) => ({ id, title, status: 'waiting', createdAt: '2026-10-08T12:00:00Z', ...extra });
const MOVES = [
  task('t1', 'Ask Dana for an interview slot'),
  task('t2', 'Finalize slide template: navy, appendix'),
  task('t3', 'Finalize slide template in navy'),
  task('t4', 'Attend the Cider Fest on Oct 2'),
  task('t5', 'Submit the application', { dueAt: '2026-10-20' }),
];
const moves = MOVES.map((t, i) => ({ n: i + 1, id: t.id, title: t.title, due: t.dueAt ? t.dueAt.slice(0, 10) : null, made: '2026-10-08' }));

test('code checks every named move: a settled proof must be in the summary, a duplicate must point at an open move, a past date must be past', () => {
  const raw = { retire: [
    { move: 1, why: 'settled', proof: 'video interview with the HR lead on October 16' },
    { move: 3, why: 'duplicate', same_as: 2 },
    { move: 4, why: 'past', proof: 'Oct 2' },
    { move: 5, why: 'past', proof: 'Oct 20' },
    { move: 2, why: 'settled', proof: 'a sentence that is not in the summary at all' },
    { move: 9, why: 'settled', proof: 'video interview with the HR lead' },
    { move: 2, why: 'forgotten', proof: 'x' },
  ] };
  const out = checkRetire(raw, { moves, summary: SUMMARY, today: TODAY });
  assert.deepEqual(out.map((item) => [item.taskId, item.why]), [['t1', 'settled'], ['t3', 'duplicate'], ['t4', 'past']]);
  assert.equal(out[1].proof, 'same as "Finalize slide template: navy, appendix"');
});

test('only moves the blind second look says yes to are retired; busy moves are never offered; Undo restores', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-'));
  const asked = [];
  const complete = async (prompt) => {
    asked.push(prompt);
    if (prompt.startsWith('<summary')) return JSON.stringify({ retire: [{ move: 1, why: 'settled', proof: 'video interview with the HR lead on October 16' }, { move: 2, why: 'duplicate', same_as: 1 }] });
    return JSON.stringify({ answers: [{ n: 1, yes: true }, { n: 2, yes: false }] });
  };
  const tasks = [task('t1', 'Ask Dana for an interview slot'), task('t3', 'Finalize slide template in navy'), task('t9', 'Busy one')];
  const result = await retireStale({ home, name: 'Acme Bank', summary: SUMMARY, tasks, complete, today: TODAY, stateOf: async (t) => (t.id === 't9' ? { phase: 'in-mail-app' } : null) });
  assert.equal(result.offered, 2, 'a move open in the mail app is never offered');
  assert.ok(!asked[0].includes('Busy one'));
  assert.ok(!asked[1].includes('"yes"') || asked[1].includes('Question'), 'the second look shows the proof, not the first verdict');
  assert.deepEqual(result.retired.map((item) => item.taskId), ['t1']);
  const retired = await readRetired(home);
  assert.equal(retired.t1.why, 'settled');
  assert.deepEqual(tasks.filter(notRetired(retired)).map((t) => t.id), ['t3', 't9']);
  assert.deepEqual(await unretire(home, 't1'), { ok: true, title: 'Ask Dana for an interview slot' });
  assert.deepEqual(await readRetired(home), {});
});

test('a dry run names but records nothing; no summary or no yes means no request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-'));
  let calls = 0;
  const complete = async (prompt) => { calls += 1; return prompt.startsWith('<summary') ? '{"retire":[{"move":1,"why":"past","proof":"Oct 2"}]}' : '{"answers":[{"n":1,"yes":true}]}'; };
  const dry = await retireStale({ home, name: 'X', summary: SUMMARY, tasks: [task('t4', 'Attend the Cider Fest on Oct 2')], complete, today: TODAY, dryRun: true });
  assert.equal(dry.retired.length, 1);
  assert.equal(await readFile(join(home, 'retired.json'), 'utf8').catch(() => 'none'), 'none');
  assert.equal((await retireStale({ home, name: 'X', summary: null, tasks: [task('t4', 'x')], complete, today: TODAY })).retired.length, 0);
  assert.equal((await retireStale({ home, name: 'X', summary: SUMMARY, tasks: [task('t4', 'x')], complete: null, today: TODAY })).retired.length, 0);
  assert.equal(calls, 2);
});

test('the code-only pass retires events whose date is over, never a deadline, never a busy move', async () => {
  assert.equal(pastEvent(task('a', 'Attend the Cider Fest on Oct 2'), { today: TODAY }), '2026-10-02');
  assert.equal(pastEvent(task('b', 'Confirm proctoring availability for October 9th exam sessions'), { today: TODAY }), '2026-10-09');
  assert.equal(pastEvent(task('c', 'Dinner with Sam on Oct 10'), { today: TODAY }), null, 'yesterday is not more than a day past');
  assert.equal(pastEvent(task('d', 'Submit the application by Oct 3'), { today: TODAY }), null, 'deadline words');
  assert.equal(pastEvent(task('e', 'Attend the Oct 2 mixer', { dueAt: '2026-10-02' }), { today: TODAY }), '2026-10-02', 'catch-up stores the event day as due');
  assert.equal(pastEvent(task('i', 'Attend the Oct 2 mixer', { dueAt: '2026-10-20' }), { today: TODAY }), null, 'a due date still ahead keeps it');
  assert.equal(pastEvent(task('f', 'Plan the Oct 2 and Oct 30 sessions'), { today: TODAY }), null, 'one date still ahead');
  assert.equal(pastEvent(task('g', 'Reply to Sam'), { today: TODAY }), null);
  assert.equal(pastEvent(task('j', 'Reply to Mira with the themes', { dueAt: '2026-10-07' }), { today: TODAY }), null, 'an overdue reply stays');
  const home = await mkdtemp(join(tmpdir(), 'retire-'));
  const core = { listProjects: async () => [{ id: 'p1', name: 'One-offs', directoryPath: '/x' }], listTasks: async () => [
    { ...task('a', 'Attend the Cider Fest on Oct 2'), projectId: 'p1' }, { ...task('h', 'Garland making on Oct 2'), projectId: 'p1' }, { ...task('d', 'Submit the application by Oct 3'), projectId: 'p1' }] };
  const out = await retirePastDates({ home, core, today: TODAY, stateOf: async (project, t) => (t.id === 'h' ? { phase: 'needs-you' } : null) });
  assert.deepEqual(out.map((item) => item.taskId), ['a']);
  assert.equal((await readRetired(home)).a.workstream, 'One-offs');
});

test('overdue: more than 3 days past its date (the user\'s new date first) retires as overdue; deadlines and busy moves stay', async () => {
  assert.equal(overdue(task('j', 'Reply to Mira with the themes', { dueAt: '2026-10-07' }), { today: TODAY }), '2026-10-07');
  assert.equal(overdue(task('k', 'Reply to Mira', { dueAt: '2026-10-08' }), { today: TODAY }), null, 'exactly 3 days is still asked on the row');
  assert.equal(overdue(task('l', 'Submit the form', { dueAt: '2026-10-01' }), { today: TODAY }), null, 'a missed deadline stays seen');
  assert.equal(overdue(task('m', 'Reply to Mira', { dueAt: '2026-10-01' }), { today: TODAY, due: '2026-10-12' }), null, 'his new date wins');
  assert.equal(overdue(task('n', 'Reply to Mira'), { today: TODAY }), null, 'no date, nothing to be late for');
  const home = await mkdtemp(join(tmpdir(), 'retire-'));
  const core = { listProjects: async () => [{ id: 'p1', name: 'Chats', directoryPath: '/x' }], listTasks: async () => [
    { ...task('j', 'Reply to Mira with the themes', { dueAt: '2026-10-07' }), projectId: 'p1' },
    { ...task('m', 'Reply to Sam', { dueAt: '2026-10-01' }), projectId: 'p1' },
    { ...task('o', 'Reply to Ivy', { dueAt: '2026-10-02' }), projectId: 'p1' }] };
  const out = await retirePastDates({ home, core, today: TODAY, dueDates: { m: '2026-10-12' }, stateOf: async (project, t) => (t.id === 'o' ? { phase: 'drafting' } : null) });
  assert.deepEqual(out.map((item) => [item.taskId, item.why, item.proof]), [['j', 'overdue', '2026-10-07']]);
});

test('retireByUser: done and dropped go to Retired with Undo; nothing else is accepted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-'));
  await retireByUser(home, { taskId: 't1', title: 'Reply to Sam', workstream: 'Chats', why: 'done', now: new Date('2026-10-11T18:00:00Z') });
  await retireByUser(home, { taskId: 't2', title: 'Reply to Ivy', workstream: 'Chats', why: 'dropped' });
  const retired = await readRetired(home);
  assert.deepEqual([retired.t1.why, retired.t1.proof, retired.t2.why], ['done', '2026-10-11', 'dropped']);
  assert.deepEqual(await unretire(home, 't1'), { ok: true, title: 'Reply to Sam' });
  await assert.rejects(retireByUser(home, { taskId: 't3', title: 'x', workstream: 'Chats', why: 'past' }), /done or dropped/);
});
