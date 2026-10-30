import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repliesFirst, vote, onDay, catchUpGoal, caughtUpFor, goalOf, checkPicks, confirmGoal, datePicks, inRankOrder, listOrder, pickPrompt, quoteStates, rankByDate, rankInput, rankWorkstreams, recordFirstAct, whyDatesHold } from '../src/hikyaku/priorities.js';
import { nextMilestone, readWorkstreams } from '../src/hikyaku/workstreams.js';

// Made-up workstreams, people and companies only.
const NOW = new Date('2026-10-09T13:00:00Z');
const tmp = () => mkdtemp(join(tmpdir(), 'priorities-'));
const WORKSTREAMS = [
  { name: 'Acme Bank', kind: 'company', goal: 'Get an offer' },
  { name: 'Harbor hackathon', kind: 'competition', goal: 'Win or place', goalText: 'Place in the Harbor hackathon on October 23-25', goalConfirmed: true },
  { name: 'Course Assistant MKTG 5030', kind: 'other', goal: 'Just keep me posted' },
];
const SAVED = {
  'Acme Bank': { summary: 'Lena from Acme Bank asked for a call. The final application deadline is Nov 11, 2026. Write to lena@acmebank.example or call 607-555-0142.', at: '2026-10-08T16:53:00Z' },
  'Harbor hackathon': { summary: 'The Harbor hackathon runs October 23-25, 2026 and the team needs a deck.', at: '2026-10-06T13:00:00Z' },
};
const PROJECTS = new Map([['acme bank', 'p1'], ['harbor hackathon', 'p2']]);
const TASKS = [
  { id: 't1', projectId: 'p1', title: 'Reply to Lena with two times', status: 'waiting', priority: 50, dueAt: '2026-10-10' },
  { id: 't2', projectId: 'p1', title: 'Old reply', status: 'done', completedAt: '2026-10-05T10:00:00Z' },
  { id: 't3', projectId: 'p1', title: 'Older reply', status: 'done', completedAt: '2026-09-01T10:00:00Z' },
  { id: 't4', projectId: 'p2', title: 'Draft the deck outline', status: 'waiting', priority: 40, dueAt: null },
];
const streams = () => rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS, now: NOW });

test('the rank input is built by code and screened: no address or phone leaves, open moves and the last 14 days counted', () => {
  const [acme, harbor, ca] = streams();
  assert.equal(acme.goalSource, 'none', 'a kind label is never offered as a goal (F2)');
  assert.equal(harbor.goalSource, 'confirmed');
  assert.equal(harbor.goal, 'Place in the Harbor hackathon on October 23-25');
  assert.deepEqual(acme.open, [{ id: 't1', title: 'Reply to Lena with two times', due: '2026-10-10', added: null, onDay: null, waiting: false }]);
  assert.equal(acme.done14, 1, 'a task finished 35 days ago does not count');
  assert.equal(acme.summaryDays, 0);
  assert.equal(harbor.summaryDays, 3);
  assert.equal(ca.summary, '');
  assert.equal(ca.quiet, true);
  const prompt = pickPrompt(streams(), '2026-10-09');
  assert.ok(!prompt.includes('lena@acmebank.example') && !prompt.includes('607-555-0142'), 'the address and phone are cut before the prompt');
  assert.match(prompt, /kept on this Mac/);
  assert.match(prompt, /written 3 days ago/);
  assert.match(prompt, /goal \(set by the user\): Place in the Harbor hackathon/);
  assert.ok(!prompt.includes('Course Assistant MKTG 5030'), '"Just keep me posted" is never picked from, so it is not sent');
  assert.match(prompt, /\n- \[1\.1\] Reply to Lena with two times \(due 2026-10-10\)/);
  assert.ok(!prompt.includes('t1'), 'task ids stay on the Mac');
});

test('a date counts only when the quote states it', () => {
  assert.ok(quoteStates('The Harbor hackathon runs October 23-25, 2026', '2026-10-23'));
  assert.ok(quoteStates('The Harbor hackathon runs October 23-25, 2026', '2026-10-25'));
  assert.ok(quoteStates('The final application deadline is Nov 11, 2026.', '2026-11-11'));
  assert.ok(quoteStates('due 10/23 at noon', '2026-10-23'));
  assert.ok(quoteStates('due 2026-10-23', '2026-10-23'));
  assert.ok(!quoteStates('The Harbor hackathon runs October 23-25, 2026', '2026-10-09'), 'the 2026-10-09 spike: a date the quote does not carry');
  assert.ok(!quoteStates('Nov 11, 2026', '2026-11-01'));
  assert.ok(!quoteStates('anything', null));
});

test('date order: nearest due first, quiet last among equals, then most finished lately', () => {
  const s = [
    { n: 1, name: 'A', open: [], done14: 0, quiet: false },
    { n: 2, name: 'B', open: [{ due: '2026-10-20' }], done14: 0, quiet: false },
    { n: 3, name: 'C', open: [], done14: 0, quiet: true },
    { n: 4, name: 'D', open: [], done14: 3, quiet: false },
  ];
  assert.deepEqual(rankByDate(s, '2026-10-10').map((item) => item.name), ['B', 'D', 'A', 'C']);
  assert.deepEqual(rankByDate(s, '2026-10-21').map((item) => item.name), ['D', 'A', 'B', 'C'], 'a date already passed puts nothing first');
});

test('cards follow the rank; a card made since keeps its place after the ranked ones', () => {
  const cards = [{ name: 'New one' }, { name: 'Acme Bank' }, { name: 'Harbor hackathon' }, { name: 'Another new' }];
  const priorities = { ranked: [{ name: 'Harbor hackathon', rank: 1 }, { name: 'acme bank', rank: 2 }] };
  assert.deepEqual(inRankOrder(cards, priorities).map((card) => card.name), ['Harbor hackathon', 'Acme Bank', 'New one', 'Another new']);
  assert.deepEqual(inRankOrder(cards, null).map((card) => card.name), cards.map((card) => card.name));
});

test('the user accepts or rewrites a goal on the card; the edit is logged, an empty text clears it', async () => {
  const home = await tmp();
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', goal: 'Get an offer', domains: [], words: ['Acme'], goalText: 'Get an Acme Bank offer by Nov 11', goalConfirmed: false }]));
  assert.deepEqual(await confirmGoal(home, 'Acme Bank', 'Get an Acme Bank offer by Nov 11'), { name: 'Acme Bank', goal: 'Get an Acme Bank offer by Nov 11', edited: false });
  assert.equal((await readWorkstreams(home))[0].goalConfirmed, true);
  assert.equal((await confirmGoal(home, 'Acme Bank', 'Get the Community Banking role')).edited, true);
  await confirmGoal(home, 'Acme Bank', '  ');
  assert.equal((await readWorkstreams(home))[0].goalText, undefined);
  const edits = (await readFile(join(home, 'goal-edits.jsonl'), 'utf8')).trim().split('\n').map((row) => JSON.parse(row));
  assert.deepEqual(edits.map((row) => [row.edited, row.cleared]), [[false, false], [true, false], [true, true]]);
  await assert.rejects(confirmGoal(home, 'Nobody', 'x'), /not in workstreams.json/);
});

test('the first workstream acted on each day is logged once, with the rank it had', async () => {
  const home = await tmp();
  const priorities = { at: '2026-10-09T12:00:00Z', source: 'ai', ranked: [{ name: 'Harbor hackathon', rank: 1 }, { name: 'Acme Bank', rank: 2 }] };
  const first = await recordFirstAct(home, 'Acme Bank', { now: () => NOW, priorities });
  assert.deepEqual([first.first, first.rank, first.source], ['Acme Bank', 2, 'ai']);
  assert.equal(await recordFirstAct(home, 'Harbor hackathon', { now: () => NOW, priorities }), null);
  const next = await recordFirstAct(home, 'Harbor hackathon', { now: () => new Date('2026-10-10T14:00:00Z'), priorities });
  assert.equal(next.rank, 1);
  assert.equal((await readFile(join(home, 'priorities-acts.jsonl'), 'utf8')).trim().split('\n').length, 2);
});

test('a quiet workstream stays quiet whatever was drafted; otherwise the goal in the user\'s terms leads', () => {
  assert.equal(catchUpGoal({ goal: 'Just keep me posted', goalText: 'Do the course assistant work' }), 'Just keep me posted');
  assert.equal(catchUpGoal({ goal: 'Get an offer', goalText: 'Get an Acme Bank offer by Nov 11' }), 'Get an Acme Bank offer by Nov 11');
  assert.equal(catchUpGoal({ goal: null }, 'Get it done'), null, 'no label: the catch-up is told none');
  assert.equal(catchUpGoal({ goal: 'Get it done' }, 'Get it done', [{ title: 'Interview', at: '2099-01-02T15:00:00Z' }]), 'next: Interview on 2099-01-02', 'the next date on its calendar');
});

test('an open move past its date is shown as passed, one move to a line', () => {
  const prompt = pickPrompt(streams(), '2026-10-11');
  assert.match(prompt, /\n- \[1\.1\] Reply to Lena with two times \(was due 2026-10-10, passed\)/);
  assert.match(prompt, /goal \(none known\): none/);
});

test('a why line names only days the workstream holds; "today" and "tomorrow" must be when a move is due', () => {
  const s = { summary: 'The Harbor hackathon runs October 23-25, 2026.', open: [{ title: 'Send the follow-up', due: '2026-10-15' }, { title: 'Confirm the room', due: '2026-10-10' }] };
  assert.ok(!whyDatesHold('Urgent follow-up due tomorrow (Oct 15); recruiter is waiting.', s, '2026-10-10'), 'the 2026-10-10 run, just after midnight');
  assert.ok(whyDatesHold('Follow-up due Oct 15; the room is due today.', s, '2026-10-10'));
  assert.ok(whyDatesHold('The hackathon is Oct 23–25.', s, '2026-10-10'), 'a date its own text states');
  assert.ok(!whyDatesHold('The deck is due Oct 19.', s, '2026-10-10'), 'a date nothing holds');
  assert.ok(!whyDatesHold('The deck is due 10/19.', s, '2026-10-10'));
  assert.ok(whyDatesHold('Due tomorrow.', s, '2026-10-14'));
  assert.ok(whyDatesHold('People are waiting on a reply.', s, '2026-10-10'), 'no day named, nothing to check');
});


// One thing first (cycle 15). Made-up names only.
test('a pick holds only when its move is an open move there; at most three, never the same move twice', () => {
  const s = streams();
  const raw = { picks: [
    { move: '1.1', why: 'Lena is waiting on times.', quote: 'Reply to Lena with two times (due 2026-10-10)' },
    { move: '1.1', why: 'again', quote: 'Reply to Lena with two times' },
    { move: '1.4', why: 'no such move', quote: 'Reply to Lena with two times' },
    { move: '3.1', why: 'quiet stream', quote: 'none at all here' },
    { move: 'Acme', why: 'not a number', quote: 'x' },
    { move: '2.1', why: 'The deck comes before the event.', quote: 'The Harbor hackathon runs October 23-25, 2026' },
  ] };
  const { picks, dropped } = checkPicks(raw, s, '2026-10-09');
  assert.deepEqual(picks.map((p) => [p.name, p.taskId, p.move, p.due]), [['Acme Bank', 't1', 'Reply to Lena with two times', '2026-10-10'], ['Harbor hackathon', 't4', 'Draft the deck outline', null]]);
  assert.equal(picks[0].quote, 'Reply to Lena with two times', 'the due tag is checked without its brackets');
  assert.equal(picks[1].why, 'The deck comes before the event.');
  assert.equal(picks[0].summaryDays, 0);
  assert.equal(dropped.filter((d) => d.what === 'pick').length, 4);
  const many = { picks: [{ move: '1.1' }, { move: '2.1' }, { move: '1.1' }, { move: '2.1' }] };
  assert.ok(checkPicks(many, s, '2026-10-09').picks.length <= 3);
});

test('a pick keeps its move but drops a why whose quote is not there, is too long, or names a day it does not hold', () => {
  const s = streams();
  const raw = { picks: [
    { move: '2.1', why: 'Because.', quote: 'The final application deadline is Nov 11, 2026.' },
    { move: '1.1', why: Array(30).fill('word').join(' '), quote: 'Reply to Lena with two times' },
  ] };
  const { picks, dropped } = checkPicks(raw, s, '2026-10-09');
  assert.deepEqual(picks.map((p) => [p.name, p.why, p.quote]), [['Harbor hackathon', null, null], ['Acme Bank', null, 'Reply to Lena with two times']]);
  assert.ok(dropped.some((d) => d.name === 'Harbor hackathon' && /not in this workstream/.test(d.why)), "Acme's quote is not Harbor's");
  const day = checkPicks({ picks: [{ move: '1.1', why: 'Lena needs times today.', quote: 'Reply to Lena with two times' }] }, s, '2026-10-09');
  assert.equal(day.picks[0].why, null, 'the move is due 2026-10-10, not today');
  assert.equal(checkPicks({ picks: [{ move: '1.1', why: 'Lena needs times tomorrow.', quote: 'Reply to Lena with two times' }] }, s, '2026-10-09').picks[0].why, 'Lena needs times tomorrow.');
});

test('the list is ordered by code: nearest due ahead first, idle last, no AI', () => {
  const list = listOrder(streams(), '2026-10-09');
  assert.deepEqual(list.map((item) => [item.name, item.rank, item.due]), [['Acme Bank', 1, '2026-10-10'], ['Harbor hackathon', 2, null], ['Course Assistant MKTG 5030', 3, null]]);
  assert.ok(list.every((item) => !('why' in item)), 'no why line on a list card');
});

test('no yes, a failed call, prose or picks that are not moves: the nearest-due moves, said plainly', async () => {
  const home = await tmp();
  const none = await rankWorkstreams({ streams: streams(), complete: null, home, today: '2026-10-09', now: () => NOW });
  assert.equal(none.source, 'date');
  assert.match(none.note, /needs your yes/);
  assert.deepEqual(none.picks.map((p) => p.taskId), ['t1'], 'the only open move with a date ahead');
  const failed = await rankWorkstreams({ streams: streams(), complete: async () => { throw new Error('The cloud AI answered with an error (HTTP 503).'); }, home, today: '2026-10-09', now: () => NOW });
  assert.match(failed.note, /could not pick \(The cloud AI answered with an error \(HTTP 503\)/);
  const prose = await rankWorkstreams({ streams: streams(), complete: async () => 'Acme matters most.', home, today: '2026-10-09', now: () => NOW });
  assert.equal(prose.source, 'date');
  const wrong = await rankWorkstreams({ streams: streams(), complete: async () => '{"picks": [{"move": "9.9"}]}', home, today: '2026-10-09', now: () => NOW });
  assert.equal(wrong.source, 'date');
  assert.match(wrong.note, /none of the cloud AI's picks/);
  assert.equal(wrong.dropped.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'priorities.json'), 'utf8')), wrong);
  assert.deepEqual(datePicks(streams(), '2026-10-11'), [], 'nothing due ahead: no pick');
});

test('a good answer is written with its picks, the list, the source and the seconds it took', async () => {
  const home = await tmp();
  let asked = '';
  const complete = async (prompt) => { asked = prompt; return JSON.stringify({ picks: [{ move: '2.1', why: 'The deck comes first.', quote: 'Draft the deck outline' }, { move: '1.1', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' }] }); };
  const result = await rankWorkstreams({ streams: streams(), complete, home, today: '2026-10-09', now: () => NOW });
  assert.equal(result.source, 'ai');
  assert.equal(typeof result.seconds, 'number');
  assert.deepEqual(result.picks.map((p) => p.name), ['Harbor hackathon', 'Acme Bank']);
  assert.deepEqual(result.ranked.map((item) => item.name), ['Acme Bank', 'Harbor hackathon', 'Course Assistant MKTG 5030'], 'the list stays in date order whatever the AI picked');
  assert.match(asked, /Today is 2026-10-09/);
});

test('idle workstreams (no goal, nothing due ahead, nothing finished lately) go last in the list and are never picked', () => {
  const workstreams = [...WORKSTREAMS, { name: 'Old one-off' }, { name: 'Fresh one-off' }, { name: 'Busy one-off' }];
  const projects = new Map([...PROJECTS, ['old one-off', 'p3'], ['fresh one-off', 'p4'], ['busy one-off', 'p5']]);
  const tasks = [...TASKS,
    { id: 't5', projectId: 'p3', title: 'Reply to the old invite', status: 'waiting', dueAt: '2026-10-01' },
    { id: 't6', projectId: 'p3', title: 'Undated note', status: 'waiting', dueAt: null },
    { id: 't7', projectId: 'p4', title: 'RSVP to the dinner', status: 'waiting', dueAt: '2026-10-09' },
    { id: 't8', projectId: 'p5', title: 'Old ask', status: 'waiting', dueAt: '2026-10-01' },
    { id: 't9', projectId: 'p5', title: 'Answered', status: 'done', completedAt: '2026-10-07T10:00:00Z' }];
  const s = rankInput({ workstreams, saved: SAVED, projects, tasks, now: NOW });
  assert.deepEqual(s.map((x) => x.idle), [false, false, false, true, false, false], 'a label goal, a quiet goal, a move due today and a finish this week each keep a card out');
  assert.deepEqual(listOrder(s, '2026-10-09').slice(-1).map((item) => [item.name, item.rank, item.idle]), [['Old one-off', 6, true]]);
  assert.equal(checkPicks({ picks: [{ move: '4.1' }] }, s, '2026-10-09').picks.length, 0);
  assert.ok(!pickPrompt(s, '2026-10-09').includes('Old one-off'));
});

// Cycle 17: calls, habits, new moves and replaced moves. Made-up names only.
const CALLS = new Map([
  ['acme bank', [{ call: '2026-10-09-1300-lena-chat', kind: 'call', at: '2026-10-09T17:00:00.000Z', title: 'Lena Park: Acme chat', category: 'one-on-one',
    lines: ['Ask the recruiter on Oct 16 about other analyst roles'], summarized: true, written: 'no', emails: ['lena@acmebank.example'] }]],
  ['harbor hackathon', [{ call: '2026-10-09-1900-harbor-sync', kind: 'call', at: '2026-10-09T23:00:00.000Z', title: 'Harbor sync', category: 'chat',
    lines: ['Build the pitch video first; the deck waits until the demo works'], summarized: true, written: 'unknown', emails: [] }]],
]);
const HABITS = ['After an interview or coffee chat, I send a thank-you note within a day.'];
const TASKS17 = TASKS.map((task) => (task.id === 't4' ? { ...task, createdAt: '2026-10-08T10:00:00Z' } : task));
const streams17 = (events = CALLS, replaced = new Map()) => rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS17, now: NOW, events, replaced });

test('the prompt restates the habits and lists each workstream\'s calls with whether the user wrote since; no address leaves', () => {
  const prompt = pickPrompt(streams17(), '2026-10-09', HABITS);
  assert.match(prompt, /<habits>[\s\S]*- After an interview or coffee chat, I send a thank-you note within a day\.[\s\S]*<\/habits>/);
  assert.match(prompt, /- \[E1\.1\] call 2026-10-09 "Lena Park: Acme chat" \(one-on-one\); the user has not written to them since\n    Ask the recruiter/);
  assert.match(prompt, /- \[2\.1\] Draft the deck outline \(added 2026-10-08\)/);
  assert.ok(!prompt.includes('lena@acmebank.example'));
});

test('one new move from a habit stands when Sent shows nothing since the call; a second new move, a made-up habit or a written-since call does not', () => {
  const s = streams17();
  const raw = { picks: [
    { new: 'Send Lena a thank-you note', call: 'E1.1', habit: 'After an interview or coffee chat, I send a thank-you note within a day.', why: 'Owed since the Oct 9 chat.', quote: 'x' },
    { new: 'Another new one', call: 'E2.1', habit: null, why: 'y', quote: 'Build the pitch video first; the deck waits until the demo works' },
    { move: '1.1', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' },
  ] };
  const { picks, dropped } = checkPicks(raw, s, '2026-10-09', HABITS);
  assert.deepEqual(picks.map((p) => [p.name, p.move, p.isNew ?? false, p.call ?? null]), [['Acme Bank', 'Reply to Lena with two times', false, null], ['Acme Bank', 'Send Lena a thank-you note', true, '2026-10-09-1300-lena-chat']], 'the owed move has its own slot after the listed picks');
  assert.equal(picks[1].habit, HABITS[0]);
  const slot = checkPicks({ picks: [{ move: '1.1', why: 'x', quote: 'Reply to Lena with two times' }], owed: raw.picks[0] }, s, '2026-10-09', HABITS);
  assert.equal(slot.picks.filter((p) => p.isNew).length, 1);
  const made = checkPicks({ picks: [{ new: 'Send Lena flowers', call: 'E1.1', habit: 'I always send flowers.', quote: 'x' }] }, s, '2026-10-09', HABITS);
  assert.equal(made.picks.length, 0);
  assert.match(made.dropped[0].why, /not one of the user's lines/);
  const wrote = new Map([...CALLS].map(([k, v]) => [k, v.map((e) => ({ ...e, written: 'yes' }))]));
  assert.equal(checkPicks({ picks: [raw.picks[0]] }, streams17(wrote), '2026-10-09', HABITS).picks.length, 0, 'the note is already in Sent');
  const unread = new Map([...CALLS].map(([k, v]) => [k, v.map((e) => ({ ...e, written: 'unknown' }))]));
  assert.equal(checkPicks({ picks: [raw.picks[0]] }, streams17(unread), '2026-10-09', HABITS).picks.length, 0, 'Sent unreadable: not known, so not owed');
  const step = checkPicks({ picks: [{ new: 'Ask the recruiter about other analyst roles', call: 'E1.1', habit: null, quote: 'Ask the recruiter on Oct 16 about other analyst roles' }] }, s, '2026-10-09', HABITS);
  assert.equal(step.picks[0].quote, 'Ask the recruiter on Oct 16 about other analyst roles', 'a next step of the call stands on its own line');
  assert.ok(dropped.length === 0 || dropped.every((d) => d.what !== 'pick'));
});

test('a later call in the same workstream can replace a move, on a line of that call; the move leaves the picks and is never deleted', () => {
  const s = streams17();
  const raw = {
    replaced: [{ move: '2.1', call: 'E2.1', quote: 'the deck waits until the demo works' }, { move: '1.1', call: 'E2.1', quote: 'the deck waits until the demo works' }, { move: '2.1', call: 'E2.1', quote: 'made up words here' }],
    picks: [{ move: '2.1', why: 'Deck first.', quote: 'Draft the deck outline' }, { move: '1.1', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' }],
  };
  const { picks, replaced, dropped } = checkPicks(raw, s, '2026-10-09', HABITS);
  assert.deepEqual(replaced.map((r) => [r.taskId, r.by, r.validUntil]), [['t4', '2026-10-09-1900-harbor-sync', '2026-10-09T23:00:00.000Z']]);
  assert.deepEqual(picks.map((p) => p.taskId), ['t1'], 'the replaced deck move is not picked');
  assert.equal(dropped.filter((d) => d.what === 'replaced').length, 2, 'a call from another workstream, and words the call does not have');
  assert.deepEqual(streams17(CALLS, new Map([['t4', {}]]))[1].open, [], 'a recorded replacement keeps the move off the list until undone');
});

test('a move that happens on a later day is not picked before it; "by" a day is a due date, not this', () => {
  assert.equal(onDay('Ask the HR rep on Oct 16 about other roles', '2026-10-10'), '2026-10-16');
  assert.equal(onDay('Submit the deck by Oct 18', '2026-10-10'), null);
  assert.equal(onDay('Meet Lena on January 5', '2026-10-10'), '2027-01-05');
  const tasks = [...TASKS, { id: 't10', projectId: 'p1', title: 'Ask the recruiter on Oct 16 about other roles', status: 'waiting', priority: 60, dueAt: '2026-10-16' }];
  const s = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks, now: NOW });
  assert.match(pickPrompt(s, '2026-10-09'), /- \(later: happens on 2026-10-16, not a pick before then\) Ask the recruiter on Oct 16 about other roles/);
  const { picks, dropped } = checkPicks({ picks: [{ move: '1.1', why: 'x', quote: 'Ask the recruiter on Oct 16 about other roles' }] }, s, '2026-10-09');
  assert.equal(picks.length, 0);
  assert.match(dropped[0].why, /happens on 2026-10-16/);
  assert.equal(checkPicks({ picks: [{ move: '1.1', why: 'x', quote: 'Ask the recruiter on Oct 16 about other roles' }] }, s, '2026-10-16').picks.length, 1, 'on the day it is pickable');
});

test('at most two picks from one workstream, so a move due today elsewhere keeps a slot', () => {
  const tasks = [...TASKS, { id: 't11', projectId: 'p1', title: 'Prepare the platform story', status: 'waiting', priority: 50 }, { id: 't12', projectId: 'p1', title: 'Map the growth pillar', status: 'waiting', priority: 50 }];
  const s = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks, now: NOW });
  const raw = { picks: [1, 2, 3].map((m) => ({ move: `1.${m}`, why: 'x', quote: 'none' })).concat([{ move: '2.1', why: 'x', quote: 'none' }]) };
  const { picks, dropped } = checkPicks(raw, s, '2026-10-09');
  assert.deepEqual(picks.map((p) => p.name), ['Acme Bank', 'Acme Bank', 'Harbor hackathon']);
  assert.ok(dropped.some((d) => /already 2 picks/.test(d.why)));
  assert.match(pickPrompt(s, '2026-10-09'), /at most 2 from any one workstream/);
});

test('a newer team call that never mentions a move puts it on "still on?"; a one-on-one never does', () => {
  const team = new Map([['harbor hackathon', [{ call: 'sync', kind: 'call', at: '2026-10-09T23:00:00.000Z', title: 'Harbor sync', category: 'team', lines: ['Build the pitch video first'], summarized: true, written: 'unknown', emails: [] }]]]);
  const s = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS17, now: NOW, events: team });
  assert.deepEqual(s[1].open[0].stillOn, { call: 'sync', at: '2026-10-09' });
  assert.match(pickPrompt(s, '2026-10-09'), /- \(still on\? the team call of 2026-10-09 does not mention it; not a pick\) Draft the deck outline/);
  assert.equal(checkPicks({ picks: [{ move: '2.1', why: 'x', quote: 'Draft the deck outline' }] }, s, '2026-10-09').picks.length, 0);
  const named = new Map([['harbor hackathon', [{ ...team.get('harbor hackathon')[0], lines: ['Finish the deck outline before the video'] }]]]);
  assert.equal(rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS17, now: NOW, events: named })[1].open[0].stillOn, undefined, 'the call carries it forward');
  const due = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS17.map((task) => (task.id === 't4' ? { ...task, dueAt: '2026-10-18' } : task)), now: NOW, events: team });
  assert.equal(due[1].open[0].stillOn, undefined, 'a deadline still ahead is never stale');
  const oneOnOne = new Map([['harbor hackathon', [{ ...team.get('harbor hackathon')[0], category: 'one-on-one' }]]]);
  assert.equal(rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS17, now: NOW, events: oneOnOne })[1].open[0].stillOn, undefined);
});

test('a move or call number is read with or without the brackets the prompt shows; what it points at is still checked', () => {
  const s = streams17();
  const { picks } = checkPicks({ picks: [{ move: '[1.1]', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' }, { move: '[9.9]' }],
    owed: { new: 'Ask the recruiter about other analyst roles', call: '[E1.1]', habit: null, quote: 'Ask the recruiter on Oct 16 about other analyst roles' } }, s, '2026-10-09', HABITS);
  assert.deepEqual(picks.map((p) => p.move), ['Reply to Lena with two times', 'Ask the recruiter about other analyst roles']);
});

test('three answers are kept where most agree: a pick, the owed move and a replacement each need 2 of 3', () => {
  const s = streams17();
  const a = { picks: [{ move: '1.1', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' }, { move: '2.1', why: 'x', quote: 'none' }],
    owed: { new: 'Send Lena a thank-you note', call: 'E1.1', habit: HABITS[0], quote: 'x' }, replaced: [] };
  const b = { picks: [{ move: '1.1', why: 'Lena is waiting.', quote: 'Reply to Lena with two times' }], owed: null, replaced: [{ move: '2.1', call: 'E2.1', quote: 'the deck waits until the demo works' }] };
  const c = { picks: [{ move: '2.1', why: 'x', quote: 'none' }, { move: '1.1', why: 'x', quote: 'none' }], owed: { ...a.owed, new: 'Thank Lena for her time' }, replaced: [] };
  const checked = [a, b, c].map((raw) => checkPicks(raw, s, '2026-10-09', HABITS));
  const { picks, replaced } = vote(checked);
  assert.deepEqual(picks.map((p) => [p.taskId, p.isNew ?? false]), [['t1', false], ['t4', false], [null, true]], 't1 in 3 of 3, t4 in 2 of 3, the thank-you proposed twice (same call and habit)');
  assert.equal(picks[0].why, 'Lena is waiting.', 'a voted pick keeps a why line one answer had');
  assert.deepEqual(replaced, [], 'a replacement in 1 of 3 is not kept');
});

test('replies first: while the habit line is there, a move someone waits on takes the place of that workstream\'s last prep pick', () => {
  const tasks = [...TASKS17, { id: 't20', projectId: 'p1', title: 'Prepare the platform story', status: 'waiting', priority: 50 }, { id: 't21', projectId: 'p1', title: 'Answer Lena about the role', status: 'waiting', priority: 40, sourceId: 'mail-1:reply' }];
  const s = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks, now: NOW });
  const picks = checkPicks({ picks: [{ move: '2.1', why: 'x', quote: 'none' }, { move: '1.2', why: 'x', quote: 'none' }] }, s, '2026-10-09').picks;
  assert.equal(s[0].open.find((m) => m.id === 't21').waiting, true);
  const habit = ['When someone is waiting on my reply, replying comes before preparing.'];
  const ruled = repliesFirst(picks, s, '2026-10-09', habit);
  assert.ok(ruled.some((p) => p.taskId === 't21' && p.rule === 'replies first'));
  assert.ok(ruled.some((p) => p.taskId === 't20'), 'with room in the workstream the prep pick stays beside the reply');
  assert.deepEqual(ruled.filter((p) => p.name === 'Harbor hackathon').map((p) => p.taskId), ['t4'], 'other workstreams untouched');
  assert.deepEqual(repliesFirst(picks, s, '2026-10-09', []), picks, 'no habit line, no rule');
});

test('an owed move whose title names a day other than its call\'s is dropped', () => {
  const s = streams17();
  const bad = checkPicks({ picks: [], owed: { new: 'Thank Lena for the chat on Oct 5', call: 'E1.1', habit: HABITS[0], quote: 'x' } }, s, '2026-10-09', HABITS);
  assert.equal(bad.picks.length, 0);
  assert.match(bad.dropped[0].why, /names a day other than the call's \(2026-10-09\)/);
  assert.equal(checkPicks({ picks: [], owed: { new: 'Thank Lena for the chat on Oct 9', call: 'E1.1', habit: HABITS[0], quote: 'x' } }, s, '2026-10-09', HABITS).picks.length, 1);
});

test('replies first swaps once per workstream and never a pick due today', () => {
  const tasks = [...TASKS17, { id: 't21', projectId: 'p2', title: 'Answer Iris about themes', status: 'waiting', priority: 40, sourceId: 'mail-2:reply' }];
  const s = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: tasks.map((t) => (t.id === 't4' ? { ...t, dueAt: '2026-10-09' } : t)), now: NOW });
  const picks = checkPicks({ picks: [{ move: '2.1', why: 'x', quote: 'none' }] }, s, '2026-10-09').picks;
  const habit = ['When someone is waiting on my reply, replying comes before preparing.'];
  assert.deepEqual(repliesFirst(picks, s, '2026-10-09', habit).map((p) => p.taskId), ['t4'], 'its only pick is due today, not prep, so the habit does not apply there');
});

test('replies first adds the reply beside the workstream\'s one pick when there is room, and the lowest pick elsewhere not due today steps out', () => {
  const tasks = [...TASKS17, { id: 't20', projectId: 'p1', title: 'Prepare the platform story', status: 'waiting', priority: 50 }, { id: 't21', projectId: 'p1', title: 'Answer Lena about the role', status: 'waiting', priority: 40, sourceId: 'mail-1:reply' }];
  const ws = [...WORKSTREAMS, { name: 'Side project', kind: 'other', goal: 'Get it done' }];
  const projects = new Map([...PROJECTS, ['side project', 'p9']]);
  const all = [...tasks.map((t) => (t.id === 't4' ? { ...t, dueAt: '2026-10-09' } : t)), { id: 't30', projectId: 'p9', title: 'Build the next feature', status: 'waiting', priority: 50 }];
  const s = rankInput({ workstreams: ws, saved: SAVED, projects, tasks: all, now: NOW });
  const acme = s[0].open.findIndex((m) => m.id === 't20') + 1;
  const picks = checkPicks({ picks: [{ move: '4.1', why: 'x', quote: 'none' }, { move: `1.${acme}`, why: 'x', quote: 'none' }, { move: '2.1', why: 'x', quote: 'none' }] }, s, '2026-10-09').picks;
  const ruled = repliesFirst(picks, s, '2026-10-09', ['When someone is waiting on my reply, replying comes before preparing.']);
  assert.deepEqual(ruled.map((p) => p.taskId), ['t20', 't21', 't4'], 'the side project steps out; the prep and the reply stay, and the deck due today keeps its place');
});

test('First today shows the picks still open and not set aside today; Not this is logged, and the first act knows if it was a pick', async () => {
  const { firstToday, recordNotThis } = await import('../src/hikyaku/priorities.js');
  const home = await tmp();
  const priorities = { at: '2026-10-09T12:00:00Z', source: 'ai', picks: [{ name: 'Acme Bank', taskId: 't1', move: 'Reply to Lena' }, { name: 'Harbor hackathon', taskId: 't4', move: 'Draft the deck outline' }, { name: 'Acme Bank', taskId: 't9', move: 'Done already' }] };
  await writeFile(join(home, 'priorities.json'), JSON.stringify(priorities));
  const now = () => NOW;
  assert.deepEqual((await firstToday(home, { openIds: new Set(['t1', 't4']), now })).picks.map((p) => p.taskId), ['t1', 't4'], 'a finished task leaves the card');
  await recordNotThis(home, { taskId: 't1', name: 'Acme Bank', move: 'Reply to Lena' }, { now });
  assert.deepEqual((await firstToday(home, { openIds: new Set(['t1', 't4']), now })).picks.map((p) => p.taskId), ['t4']);
  assert.deepEqual((await firstToday(home, { openIds: new Set(['t1', 't4']), now: () => new Date('2026-10-10T14:00:00Z') })).picks.map((p) => p.taskId), ['t1', 't4'], 'Not this lasts the day');
  const first = await recordFirstAct(home, 'Harbor hackathon', { now, priorities: { ...priorities, ranked: [] } });
  assert.equal(first.picked, true);
  assert.deepEqual(first.picks, ['Acme Bank', 'Harbor hackathon', 'Acme Bank']);
});

test('the goal the ranking reads comes from evidence: confirmed words, a draft, the next calendar date, else none (F2)', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  assert.deepEqual(goalOf({ goal: 'Get an offer' }, [{ title: 'Video Meeting', at: '2099-10-27T19:00:00Z' }, { title: 'Past', at: '2026-10-20T10:00:00Z' }]).goalSource, 'calendar');   // a date always ahead: goalOf reads the real clock
  assert.deepEqual(goalOf({ goal: 'Get an offer' }, []), { goal: null, goalSource: 'none' });
  assert.equal(goalOf({ goal: 'Get an offer', goalText: 'Land the EA role', goalConfirmed: true }, [{ title: 'x', at: '2099-01-01T00:00:00Z' }]).goalSource, 'confirmed');
  assert.equal(nextMilestone([{ title: 'Started 30 min ago', at: '2026-10-26T11:30:00Z' }, { title: 'Later', at: '2026-10-27T10:00:00Z' }], now).title, 'Started 30 min ago', 'an hour of grace');
  assert.equal(nextMilestone([{ title: 'Yesterday', at: '2026-10-25T10:00:00Z' }], now), null);
});

test('a date the user set on a move (due-dates.json) is the date the ranking sees, over the catch-up date', () => {
  const [acme, harbor] = rankInput({ workstreams: WORKSTREAMS, saved: SAVED, projects: PROJECTS, tasks: TASKS, now: NOW, dueDates: { t1: '2026-10-20', t4: '2026-10-12' } });
  assert.equal(acme.open.find((move) => move.id === 't1').due, '2026-10-20');
  assert.equal(harbor.open.find((move) => move.id === 't4').due, '2026-10-12');
  // A move with no catch-up date but a date of the user's still counts as ahead, so its workspace is not idle.
  const quiet = rankInput({ workstreams: [{ name: 'Harbor hackathon', kind: 'other' }], saved: {}, projects: PROJECTS, tasks: [TASKS[3]], now: NOW, dueDates: { t4: '2026-10-12' } });
  assert.equal(quiet[0].idle, false);
});

test('a workspace whose goal is its next calendar item reads caught up after its catch-up, so Draft all quietly includes it', () => {
  const milestones = [{ title: 'Mock interview', at: '2099-10-12T21:00:00Z' }];
  const workstream = { name: 'Acme Bank', kind: 'company' };
  const state = { goal: catchUpGoal(workstream, 'Get an offer', milestones), milestones };
  assert.equal(caughtUpFor(state, workstream, 'Get an offer'), true);
  assert.equal(caughtUpFor(null, workstream, 'Get an offer'), false);
  assert.equal(caughtUpFor({ goal: 'an older goal', milestones }, workstream, 'Get an offer'), false);
});
