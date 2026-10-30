// Increment 6: the user's taps ("matters more" / "matters less"), park, and the taps-first order.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPicks, datePicks, listOrder, pickPrompt, rankByDate, rankByStake, rankInput, recordFirstAct, STAKE_ORDER } from '../src/hikyaku/priorities.js';
import { returnParked } from '../src/hikyaku/park.js';
import { makeItem, readChanges } from '../src/hikyaku/changes.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';

// Made-up workstreams and companies only.
const NOW = new Date('2026-10-09T13:00:00Z');
const TODAY = '2026-10-09';
const tmp = () => mkdtemp(join(tmpdir(), 'stakes-'));
const PROJECTS = new Map([['acme bank', 'p1'], ['harbor hackathon', 'p2'], ['delta labs', 'p3'], ['old one-off', 'p4']]);
const TASKS = [
  { id: 't1', projectId: 'p1', title: 'Reply to Lena with two times', status: 'waiting', priority: 50, dueAt: '2026-10-10' },
  { id: 't4', projectId: 'p2', title: 'Draft the deck outline', status: 'waiting', priority: 40, dueAt: '2026-10-20' },
  { id: 't5', projectId: 'p3', title: 'Send the Delta Labs case answers', status: 'waiting', priority: 40, dueAt: '2026-10-12' },
  { id: 't6', projectId: 'p4', title: 'Thank the panel', status: 'waiting', priority: 10, dueAt: '2026-09-01' },
];
const input = (workstreams) => rankInput({ workstreams, projects: PROJECTS, tasks: TASKS, now: NOW });
const W = {
  acme: { name: 'Acme Bank', kind: 'company', goal: 'Get an offer' },
  harbor: { name: 'Harbor hackathon', kind: 'competition', goal: 'Win or place' },
  delta: { name: 'Delta Labs', kind: 'company', goal: 'Get an offer' },
  old: { name: 'Old one-off', kind: 'other', goal: null },
};

// The list order before increment 6, copied here so "no taps, no parks" can be compared with it.
const oldListOrder = (streams, today) => {
  const nextDue = (s) => s.open.map((m) => m.due).filter((due) => due && due >= today).sort()[0] || null;
  const ranked = rankByDate(streams, today).map((s, index) => ({ name: s.name, rank: index + 1, goal: s.goal, goalSource: s.goalSource, idle: Boolean(s.idle), due: nextDue(s) }));
  return [...ranked.filter((item) => !item.idle), ...ranked.filter((item) => item.idle)].map((item, index) => ({ ...item, rank: index + 1 }));
};

test('rankInput carries the stake, whether it is parked, and the park date', () => {
  const s = input([{ ...W.acme, stake: 'more' }, { ...W.harbor, parkedUntil: '2026-10-15' }, { ...W.delta, stake: 'less', parkedUntil: TODAY }, W.old]);
  assert.deepEqual(s.map((x) => [x.stake, x.parked, x.parkedUntil]), [
    ['more', false, null],
    ['normal', true, '2026-10-15'],
    ['less', false, TODAY],
    ['normal', false, null],
  ], 'a park date of today is no longer parked');
  assert.deepEqual(STAKE_ORDER, { more: 0, normal: 1, less: 2 });
});

test('a "matters more" workstream due later outranks a normal one due sooner; "matters less" goes after normal', () => {
  const s = input([W.acme, { ...W.harbor, stake: 'more' }, { ...W.delta, stake: 'less' }]);
  assert.deepEqual(rankByDate(s, TODAY).map((x) => x.name), ['Acme Bank', 'Delta Labs', 'Harbor hackathon'], 'by date alone');
  assert.deepEqual(rankByStake(s, TODAY).map((x) => x.name), ['Harbor hackathon', 'Acme Bank', 'Delta Labs']);
  const list = listOrder(s, TODAY);
  assert.deepEqual(list.map((x) => [x.name, x.rank, x.stake, x.due]), [
    ['Harbor hackathon', 1, 'more', '2026-10-20'],
    ['Acme Bank', 2, 'normal', '2026-10-10'],
    ['Delta Labs', 3, 'less', '2026-10-12'],
  ]);
  assert.ok(list.every((x) => !('parked' in x)), 'no park fields on rows that are not parked');
});

test('within one stake the date order is kept exactly', () => {
  const s = input([{ ...W.harbor, stake: 'more' }, { ...W.delta, stake: 'more' }, { ...W.acme, stake: 'more' }]);
  assert.deepEqual(rankByStake(s, TODAY).map((x) => x.name), rankByDate(s, TODAY).map((x) => x.name));
});

test('parked rows come after the active ones and before the idle ones, soonest back first', () => {
  const s = input([{ ...W.acme, parkedUntil: '2026-10-30' }, W.old, { ...W.harbor, parkedUntil: '2026-10-12', stake: 'less' }, W.delta]);
  const list = listOrder(s, TODAY);
  assert.deepEqual(list.map((x) => [x.name, x.rank, x.parked ?? false, x.parkedUntil ?? null, x.idle]), [
    ['Delta Labs', 1, false, null, false],
    ['Harbor hackathon', 2, true, '2026-10-12', false],
    ['Acme Bank', 3, true, '2026-10-30', false],
    ['Old one-off', 4, false, null, true],
  ]);
});

test('with no stakes and nothing parked, listOrder is the date order it was before', () => {
  const s = input([W.acme, W.old, W.harbor, { ...W.delta, goal: 'Just keep me posted' }]);
  const list = listOrder(s, TODAY);
  assert.ok(list.every((x) => x.stake === 'normal'));
  assert.deepEqual(list.map(({ stake, ...row }) => row), oldListOrder(s, TODAY));
});

test('the morning pick reads the taps and leaves parked workstreams out', () => {
  const s = input([{ ...W.acme, stake: 'more' }, { ...W.harbor, stake: 'less' }, W.delta, { ...W.old, goal: 'Get an offer', parkedUntil: '2026-10-20', name: 'Parked Co' }]);
  s[3].open = [{ id: 't9', title: 'Write to the parked contact', due: '2026-10-10', added: null, onDay: null, waiting: false }];
  const prompt = pickPrompt(s, TODAY);
  const lines = prompt.split('\n');
  const after = (name) => lines[lines.indexOf(`[${s.find((x) => x.name === name).n}] ${name}`) + 2];
  assert.equal(after('Acme Bank'), 'stake: the user marked this "matters more"', 'right after the goal line');
  assert.equal(after('Harbor hackathon'), 'stake: the user marked this "matters less"');
  assert.match(after('Delta Labs'), /^summary/, 'no stake line for normal');
  assert.ok(prompt.includes('Weigh, in this order: the user\'s own stake (a workstream marked "matters more" comes before others unless another move is due today and someone is waiting on it; one marked "matters less" comes last), how much the user\'s goal is at stake, how soon the move is due, and whether someone is waiting on the user. A workstream the user keeps finishing moves in is one they care about.'));
  assert.ok(!prompt.includes('Parked Co') && !prompt.includes('parked contact'), 'a parked workstream is not offered');
  assert.ok(!datePicks(s, TODAY).some((p) => p.name === 'Parked Co'), 'nor picked by date');
  const { picks, dropped } = checkPicks({ picks: [{ move: '4.1', why: 'x', quote: 'Write to the parked contact' }] }, s, TODAY);
  assert.deepEqual(picks, []);
  assert.equal(dropped[0].what, 'pick', 'a pick from a parked workstream is dropped');
});

test('each first-act row records that the taps order was in force', async () => {
  const home = await tmp();
  const priorities = { at: '2026-10-09T12:00:00Z', source: 'ai', ranked: [{ name: 'Acme Bank', rank: 1 }] };
  const row = await recordFirstAct(home, 'Acme Bank', { now: () => NOW, priorities });
  assert.equal(row.order, 'taps');
  assert.equal(JSON.parse((await readFile(join(home, 'priorities-acts.jsonl'), 'utf8')).trim()).order, 'taps');
});

test('a park ends on its day with one change item and the date cleared; a second run adds nothing', async () => {
  const home = await tmp();
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([
    { name: 'Acme Bank', kind: 'company', parkedUntil: '2026-10-09', stake: 'more' },
    { name: 'Harbor hackathon', kind: 'competition', parkedUntil: '2026-10-08' },
    { name: 'Delta Labs', kind: 'company', parkedUntil: '2026-10-20' },
  ]));
  const before = await readWorkstreams(home);
  assert.deepEqual(await returnParked({ home, workstreams: before, today: TODAY }), ['Acme Bank', 'Harbor hackathon']);
  const log = await readChanges(home);
  assert.deepEqual(log.map((item) => [item.id, item.workstream, item.how, item.title]), [
    ['park:Acme Bank@2026-10-09', 'Acme Bank', 'asked', 'Back from park (2026-10-09)'],
    ['park:Harbor hackathon@2026-10-08', 'Harbor hackathon', 'asked', 'Back from park (2026-10-08)'],
  ]);
  assert.equal(log[0].at, new Date('2026-10-09T09:00:00').toISOString(), '9 AM on the Mac\'s clock');
  for (const item of log) assert.deepEqual(makeItem(item), item, 'what is logged passes makeItem unchanged');
  const after = await readWorkstreams(home);
  assert.deepEqual(after.map((w) => w.parkedUntil ?? null), [null, null, '2026-10-20'], 'only the returned dates are cleared');
  assert.equal(after[0].stake, 'more', 'the other fields stay');
  assert.deepEqual(await returnParked({ home, workstreams: after, today: TODAY }), [], 'the date is already cleared');
  await returnParked({ home, workstreams: before, today: TODAY });
  assert.equal((await readChanges(home)).length, 2, 'even from a stale list the ref repeats, so nothing is added');
});

test('a park return that cannot save stops the run instead of passing silently', async () => {
  const home = await tmp();
  await writeFile(join(home, 'workstreams.json'), '[]');
  await assert.rejects(returnParked({ home, workstreams: [{ name: 'Gone', parkedUntil: '2026-10-01' }], today: TODAY }), /No workspace named "Gone"/);
});
