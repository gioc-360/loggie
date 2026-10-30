import test from 'node:test';
import assert from 'node:assert/strict';
import { changedWorkstreams, firstReadsOut, refreshPlan } from '../src/hikyaku/refresh.js';
import { QUIET_GOAL } from '../src/hikyaku/workstreams.js';

const TODAY = '2026-10-10';
const NOW = Date.parse('2026-10-10T15:00:00Z');
const item = (id, workstream) => ({ id, source: 'outlook', at: '2026-10-10T10:00:00.000Z', title: id, thread: id, workstream, how: 'domain', candidates: [], who: [], ref: id });
const W = [
  { name: 'Bank Offer', goal: 'Get the offer', cloud: 'nebius', domains: [], words: [] },
  { name: 'Quiet', goal: 'Just keep me posted', cloud: 'off', domains: [], words: [] },
  { name: 'Local', goal: 'Ship it', cloud: 'off', domains: [], words: [] },
  { name: 'Quiet Cloud', goal: 'Just keep me posted', cloud: 'nebius', domains: [], words: [] },
];
const changed = W.map((w) => ({ name: w.name, items: [item(`${w.name}-1`, w.name)] }));
const plan = (fields) => refreshPlan({ changed, state: {}, workstreams: W, today: TODAY, auto: false, overBudget: false, now: NOW, ...fields });
const brief = (entries) => entries.map(({ name, action, reason }) => [name, action, reason]);

test('the quiet goal matched here is the one workstreams.js names', () => {
  assert.equal(QUIET_GOAL, 'Just keep me posted');
});

test('a manual run under budget reads every changed workstream, in order, with its items', () => {
  const result = plan({});
  assert.deepEqual(brief(result), W.map((w) => [w.name, 'read', '']));
  assert.deepEqual(result.map((entry) => entry.items), changed.map((entry) => entry.items));
});

test('the plan follows changedWorkstreams output order', () => {
  const items = [item('b', 'Local'), item('a', 'Bank Offer')];
  const fromLog = changedWorkstreams({ items, state: {}, workstreams: W, today: TODAY });
  assert.deepEqual(refreshPlan({ changed: fromLog, state: {}, workstreams: W, today: TODAY }).map((e) => e.name), ['Bank Offer', 'Local']);
});

test('an auto run skips a workstream already refreshed automatically today, and reads it again tomorrow', () => {
  const state = { 'Bank Offer': { autoReads: { day: TODAY, count: 1, last: new Date(NOW - 20 * 60000).toISOString() } }, Local: { autoReads: { day: '2026-10-09', count: 6, last: '2026-10-09T23:00:00Z' } } };
  assert.deepEqual(brief(plan({ auto: true, state })).filter(([name]) => name !== 'Quiet' && name !== 'Quiet Cloud'),
    [['Bank Offer', 'skip', 'read within the last hour'], ['Local', 'read', '']]);
  assert.equal(plan({ auto: true, state, today: '2026-10-11' })[0].action, 'read');
});

test('an auto run skips a just-keep-me-posted workstream', () => {
  const quiet = plan({ auto: true }).find((e) => e.name === 'Quiet');
  assert.deepEqual([quiet.action, quiet.reason], ['skip', 'just keep me posted']);
});

test('order: an auto run on a quiet workstream read within the hour reports that first', () => {
  const state = { Quiet: { autoReads: { day: TODAY, count: 1, last: new Date(NOW - 60000).toISOString() } }, 'Quiet Cloud': { autoReads: { day: TODAY, count: 1, last: new Date(NOW - 60000).toISOString() } } };
  const result = plan({ auto: true, overBudget: true, state });
  assert.equal(result.find((e) => e.name === 'Quiet').reason, 'read within the last hour');
  assert.equal(result.find((e) => e.name === 'Quiet Cloud').reason, 'read within the last hour');
});

test('order: quiet comes before the budget for an auto run', () => {
  assert.equal(plan({ auto: true, overBudget: true }).find((e) => e.name === 'Quiet Cloud').reason, 'just keep me posted');
});

test('a manual run ignores autoDay and the quiet goal', () => {
  const state = Object.fromEntries(W.map((w) => [w.name, { autoDay: TODAY }]));
  assert.deepEqual(brief(plan({ auto: false, state })), W.map((w) => [w.name, 'read', '']));
});

test('over budget skips only the cloud workstreams, manual or auto', () => {
  assert.deepEqual(brief(plan({ overBudget: true })), [
    ['Bank Offer', 'skip', "over today's cloud limit"], ['Quiet', 'read', ''], ['Local', 'read', ''], ['Quiet Cloud', 'skip', "over today's cloud limit"]]);
  const auto = plan({ auto: true, overBudget: true });
  assert.deepEqual(brief(auto).filter(([, action]) => action === 'read'), [['Local', 'read', '']]);
  assert.equal(auto[0].reason, "over today's cloud limit");
});

test('a changed name missing from workstreams is read (no goal, no cloud to hold it back)', () => {
  const result = refreshPlan({ changed: [{ name: 'Gone', items: [] }], state: {}, workstreams: W, today: TODAY, auto: true, overBudget: true });
  assert.deepEqual(brief(result), [['Gone', 'read', '']]);
});

// F13 (first-run-polish B4.3, D1): the refresh never makes a found card's first read, kept or not.
test('firstReadsOut drops a found card with no catch-up state, kept or not, and keeps it once it has one', () => {
  const found = { quote: 'You have been elected treasurer.', at: '2026-10-18T10:00:00.000Z' };
  const workstreams = [
    { name: 'Robotics Club', found, domains: [], words: ['robotics'] },
    { name: 'TA ECON 1110', found, confirmed: '2026-10-18T11:00:00.000Z', domains: [], words: ['ECON 1110'] },
    { name: 'Bank Offer', domains: ['bank.example'], words: [] },
    { name: 'Case Team', confirmed: '2026-10-18T09:00:00.000Z', madeFrom: { event: 'ev1' }, domains: [], words: [] },
  ];
  const changed = workstreams.map((w) => ({ name: w.name, items: [item(`${w.name}-1`, w.name)] }));
  assert.deepEqual(firstReadsOut(changed, { workstreams, state: {} }).map((entry) => entry.name), ['Bank Offer', 'Case Team'],
    'an unkept and a kept found card wait for the Found step; a named and a meeting-made card refresh');
  const state = { 'TA ECON 1110': { seen: [] }, 'Robotics Club': { seen: [] } };
  assert.deepEqual(firstReadsOut(changed, { workstreams, state }).map((entry) => entry.name), ['Robotics Club', 'TA ECON 1110', 'Bank Offer', 'Case Team'], 'read once, they refresh as any other');
});

// Within the hour, at most 6 a day (loggie-workspaces-integration, Gio 10-26): an hour after the last read the timer
// reads again; after 6 reads today it waits for tomorrow.
test('the timer re-reads a changed workspace an hour after its last read, at most 6 times a day', () => {
  const at = (minutesAgo, count) => ({ 'Bank Offer': { autoReads: { day: TODAY, count, last: new Date(NOW - minutesAgo * 60000).toISOString() } } });
  const one = (state) => brief(refreshPlan({ changed: changed.slice(0, 1), state, workstreams: W, today: TODAY, auto: true, now: NOW }))[0];
  assert.deepEqual(one(at(30, 2)), ['Bank Offer', 'skip', 'read within the last hour']);
  assert.deepEqual(one(at(61, 2)), ['Bank Offer', 'read', '']);
  assert.deepEqual(one(at(120, 6)), ['Bank Offer', 'skip', '6 reads today already']);
  assert.deepEqual(one({}), ['Bank Offer', 'read', '']);
});
