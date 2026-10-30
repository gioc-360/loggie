// The Meetings week join (desktop/week-events.js): which call's notes belong to which calendar event, and the mark each
// event shows. Made-up events and calls only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRange, joinWeek, sortOf } from '../desktop/week-events.js';

const at = (day, time) => new Date(`2026-10-${day}T${time}:00`).toISOString();
const range = { from: '2026-10-12', to: '2026-10-19', now: Date.parse(at(15, '12:00')) };
// An invite he accepted (meeting.js isMine, 2026-10-27), so a call near it may join it.
const event = (id, start, extra = {}) => ({ id, title: `Event ${id}`, start, end: start, allDay: false, attendees: ['a@x.example', 'b@x.example'], myStatus: 'accepted', ...extra });
const call = (id, start, extra = {}) => ({ id, title: `Call ${id}`, start, state: 'done', workstream: null, guess: null, people: 3, ...extra });

test('a call starting with the event joins it', () => {
  const { items } = joinWeek([event('e1', at(13, '09:00'))], [call('c1', at(13, '09:00'))], range);
  assert.equal(items.length, 1);
  assert.equal(items[0].call, 'c1');
  assert.equal(items[0].people, 2);
});

test('a call he renamed shows his title on the event row it joins', () => {
  const { items } = joinWeek([event('e1', at(13, '10:00'))], [call('c1', at(13, '10:02'), { title: 'Interview with Northwind', titleByHand: true })], range);
  assert.deepEqual(items.map((item) => [item.title, item.call]), [['Interview with Northwind', 'c1']]);
  const plain = joinWeek([event('e1', at(13, '10:00'))], [call('c1', at(13, '10:02'))], range).items;
  assert.equal(plain[0].title, 'Event e1', 'a call named by the calendar keeps the event title');
});

test('14 minutes apart joins; 16 minutes apart leaves the call on its own', () => {
  const near = joinWeek([event('e1', at(13, '09:00'))], [call('c1', at(13, '09:14'))], range).items;
  assert.equal(near.length, 1);
  const far = joinWeek([event('e1', at(13, '09:00'))], [call('c1', at(13, '09:16'))], range).items;
  assert.deepEqual(far.map((item) => item.kind), ['event', 'call']);
  assert.equal(far[1].id, 'call:c1');
  assert.equal(far[1].people, 3);
});

test('two calls near one event: the nearer joins, the other stands alone', () => {
  const { items } = joinWeek([event('e1', at(13, '09:00'))], [call('far', at(13, '09:10')), call('near', at(13, '09:02'))], range);
  assert.equal(items.find((item) => item.kind === 'event').call, 'near');
  assert.equal(items.find((item) => item.kind === 'call').call, 'far');
});

test('all-day entries and read-only feeds with nobody on them are left out; a call stays on its own', () => {
  const { items } = joinWeek([event('holiday', at(13, '09:00'), { allDay: true }), event('feed', at(13, '10:00'), { writable: false, attendees: [] }), event('class', at(13, '11:00'), { writable: false })],
    [call('c1', at(13, '09:00'))], range);
  assert.deepEqual(items.map((item) => item.id), ['call:c1', 'class']);
});

test('one event seen through two calendars shows once, with its call', () => {
  const { items } = joinWeek([event('a', at(13, '09:00'), { title: 'Sync' }), event('b', at(13, '09:00'), { title: 'sync ' })], [call('c1', at(13, '09:00'))], range);
  assert.equal(items.length, 1);
  assert.equal(items[0].call, 'c1');
});

test('each mark from its case, and an event with notes is never none', () => {
  const { items } = joinWeek([
    event('filed', at(12, '09:00')), event('notes', at(12, '11:00')), event('none', at(12, '13:00')),
    event('soon', at(16, '10:00')), event('live', at(15, '11:55')), event('empty', at(12, '15:00')),
  ], [
    call('a', at(12, '09:00'), { workstream: 'Test Club' }), call('b', at(12, '11:00'), { guess: 'Test Club' }),
    call('c', at(15, '11:55'), { state: 'recording' }), call('d', at(12, '15:00'), { state: 'empty' }),
  ], range);
  const mark = Object.fromEntries(items.map((item) => [item.id, item.mark]));
  assert.deepEqual(mark, { filed: 'filed', notes: 'notes', none: 'none', soon: 'upcoming', live: 'recording', empty: 'none' });
  assert.equal(items.find((item) => item.id === 'notes').guess, 'Test Club');
  assert.equal(items.find((item) => item.id === 'filed').workstream, 'Test Club');
});

test('sorted by start, and out-of-range events and calls are left out', () => {
  const { items } = joinWeek([event('late', at(14, '15:00')), event('early', at(13, '08:00')), event('next week', at(20, '09:00'))],
    [call('c', at(13, '12:00')), call('old', at('05', '12:00'))], range);
  assert.deepEqual(items.map((item) => item.id), ['early', 'call:c', 'late']);
});

test('names of the people never reach the page', () => {
  const { items } = joinWeek([event('e1', at(13, '09:00'), { attendeeNames: ['Ana Example'] })], [], range);
  assert.doesNotMatch(JSON.stringify(items), /Ana Example|a@x\.example/);
});

test('bad dates and ranges over 31 days are refused', () => {
  assert.equal(checkRange('2026-10-12', '2026-10-19'), 7);
  assert.throws(() => checkRange('2026-10-12', '2026-11-13'), /up to 31 days/);
  assert.throws(() => checkRange('Oct 12', '2026-10-19'), /YYYY-MM-DD/);
  assert.throws(() => checkRange('2026-10-19', '2026-10-12'), /YYYY-MM-DD/);
});

// --- each meeting's workspace (docs/teammate-ready/spec.md B3)
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChanges, makeItem, readChanges } from '../src/hikyaku/changes.js';
import { answerAsk } from '../src/hikyaku/screen-data.js';
import { calendarItems } from '../src/hikyaku/sources.js';
import { answerRef, eventItem, eventKey, routeEvents } from '../desktop/week-events.js';

const SPACES = [
  { name: 'Test Club', kind: 'other', domains: ['club.example'], words: [] },
  { name: 'Bank Offer', kind: 'company', domains: ['bank.example'], words: [] },
  { name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true },
];
const meeting = (id, start, extra = {}) => ({ id, title: `Coffee ${id}`, start, end: start, allDay: false, writable: true, attendees: ['pat@nowhere.example'], attendeeNames: ['Pat Example'], ...extra });

test('eventKey and eventItem are the change check\'s own key and item for one occurrence', async () => {
  const one = meeting('e1', at(13, '09:00'), { attendees: ['Ana@Bank.example'], attendeeNames: ['Ana Example'] });
  const { items } = await calendarItems({ listEvents: async () => [one], snapshot: null, now: Date.parse(at(13, '08:00')) });
  assert.deepEqual(eventItem(one), items[0]);
  assert.equal(eventKey(one), items[0].ref);
});

test('a Yes files every occurrence of the series, even when the router would say another workspace', () => {
  const monday = meeting('series', at(12, '09:00'), { attendees: ['ana@bank.example'] });
  const tuesday = meeting('series', at(13, '09:00'), { attendees: ['ana@bank.example'] });
  const lines = [makeItem({ ...eventItem(monday), ref: `${eventKey(monday)}#asked`, workstream: 'Test Club', how: 'asked' })];
  const routes = routeEvents([monday, tuesday], { lines, workstreams: SPACES });
  for (const event of [monday, tuesday]) assert.deepEqual(routes.get(eventKey(event)), { workstream: 'Test Club', guess: null, how: 'asked', filed: true });
});

test('an attendee at a workspace\'s domain is a guess, not a filing', () => {
  const event = meeting('e2', at(13, '10:00'), { attendees: ['ana@bank.example'] });
  assert.deepEqual(routeEvents([event], { workstreams: SPACES }).get(eventKey(event)), { workstream: null, guess: 'Bank Offer', how: 'domain', filed: false });
});

test('an unsure line the change check logged gives its first candidate as the guess', () => {
  const event = meeting('e3', at(13, '11:00'));
  const lines = [makeItem({ ...eventItem(event), candidates: ['Test Club', 'Bank Offer'] })];
  assert.deepEqual(routeEvents([event], { lines, workstreams: SPACES }).get(eventKey(event)), { workstream: null, guess: 'Test Club', how: 'suggested', filed: false });
});

test('a guess or a Yes naming a workspace that is gone says nothing', () => {
  const event = meeting('e4', at(13, '12:00'));
  const lines = [makeItem({ ...eventItem(event), candidates: ['Old Project'] }), makeItem({ ...eventItem(event), ref: `${eventKey(event)}#asked`, workstream: 'Old Project', how: 'asked' })];
  assert.deepEqual(routeEvents([event], { lines, workstreams: SPACES }).get(eventKey(event)), { workstream: null, guess: null, how: null, filed: false });
});

test('Yes then Change: two answers, two lines in each file, and the week says the second', async () => {
  const home = await mkdtemp(join(tmpdir(), 'week-file-event-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify(SPACES));
  const event = meeting('e5', at(13, '13:00'));
  for (const name of ['Test Club', 'Bank Offer']) {
    const item = makeItem(eventItem(event, { ref: answerRef(await readChanges(home), event) }));
    await answerAsk({ home, item, workstream: name });
  }
  const lines = await readChanges(home);
  assert.deepEqual(lines.map((line) => line.ref), [`${eventKey(event)}#asked`, `${eventKey(event)}#2#asked`]);
  const { readFile } = await import('node:fs/promises');
  assert.equal((await readFile(join(home, 'asked.jsonl'), 'utf8')).trim().split('\n').length, 2);
  assert.equal(routeEvents([event], { lines, workstreams: SPACES }).get(eventKey(event)).workstream, 'Bank Offer');
  await assert.rejects(() => answerAsk({ home, item: makeItem(eventItem(event, { ref: answerRef(lines, event) })), workstream: 'Made Up Name' }), /No workspace named/);
  assert.equal((await readChanges(home)).length, 2, 'an unknown name writes nothing');
});

test('with routes, the week joins guesses and filings and still sends no attendee name or address', () => {
  const guessed = meeting('g', at(13, '14:00'), { attendees: ['ana@bank.example'], attendeeNames: ['Ana Example'] });
  const routes = routeEvents([guessed], { workstreams: SPACES });
  const { items } = joinWeek([guessed], [], { ...range, routes });
  assert.equal(items[0].guess, 'Bank Offer');
  assert.equal(items[0].workstream, null);
  assert.equal(items[0].filed, false);
  assert.doesNotMatch(JSON.stringify(items), /Ana Example|ana@bank\.example/);
});

test('file-event takes only a calendar id, a readable start and a workspace name', async () => {
  const { validateFileEvent } = await import('../desktop/ipc-validation.js');
  assert.deepEqual(validateFileEvent('E1', '2026-10-13T13:00:00Z', ' Test Club '), { id: 'E1', start: '2026-10-13T13:00:00Z', workstream: 'Test Club' });
  assert.throws(() => validateFileEvent('x'.repeat(301), '2026-10-13T13:00:00Z', 'Test Club'), /not a meeting on your calendar/);
  assert.throws(() => validateFileEvent('E1\nE2', '2026-10-13T13:00:00Z', 'Test Club'), /not a meeting on your calendar/);
  assert.throws(() => validateFileEvent('E1', 'next Tuesday-ish', 'Test Club'), /not a meeting on your calendar/);
  assert.throws(() => validateFileEvent('E1', '2026-10-13T13:00:00Z', '  '), /Pick one/);
});

// --- a new workspace from a meeting (first-run-polish B3.3)
import { seedFromEvent } from '../desktop/week-events.js';
import { addWorkstream } from '../src/hikyaku/entry.js';
import { route } from '../src/hikyaku/router.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';

const dellRound = { id: 'e9', title: 'Dell final round with Ana', start: '2026-10-20T15:00:00Z', attendees: ['ana@dell.example', 'bo@gmail.com', 'sam@school.example'], attendeeNames: ['Ana Diaz', 'Bo Lee', 'Sam Ito'] };

test('seedFromEvent: the people less the user, their domains less public mail and the user\'s own, and title words', () => {
  const seed = seedFromEvent(dellRound, { ownAddresses: ['Sam@School.example'], ownNames: ['Sam'] });
  assert.deepEqual(seed.people, [{ name: 'Ana Diaz', address: 'ana@dell.example' }, { name: 'Bo Lee', address: 'bo@gmail.com' }]);
  assert.deepEqual(seed.domains, ['dell.example']);
  assert.deepEqual(seed.words, ['Dell', 'final', 'round']);
  // A shorter name list cannot be paired, so no names at all.
  assert.deepEqual(seedFromEvent({ ...dellRound, attendeeNames: ['Ana Diaz'] }, { ownAddresses: ['sam@school.example'] }).people.map((p) => p.name), ['', '']);
});

test('seedFromEvent: an attendee under a subdomain of the user\'s own domain is dropped from domains', () => {
  const seed = seedFromEvent({ title: 'Lab sync', attendees: ['kim@eng.school.example', 'lu@partner.example', 'LU@partner.example'] }, { ownAddresses: ['sam@school.example'] });
  assert.deepEqual(seed.domains, ['partner.example']);
  assert.deepEqual(seed.people.map((p) => p.address), ['kim@eng.school.example', 'lu@partner.example']);
});

test('seedFromEvent: no attendees and a generic title give nothing to follow', () => {
  assert.deepEqual(seedFromEvent({ title: 'Weekly sync call', attendees: [] }, { ownAddresses: ['sam@school.example'], ownNames: ['Sam'] }), { people: [], domains: [], words: [] });
  assert.deepEqual(seedFromEvent({ title: '' }), { people: [], domains: [], words: [] });
});

test('a workspace seeded from a meeting routes its people and its domain there', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-seed-'));
  const seed = seedFromEvent(dellRound, { ownAddresses: ['sam@school.example'], ownNames: ['Sam'] });
  await addWorkstream({ home, name: 'Dell Offer', domains: seed.domains, words: seed.words, people: seed.people, extra: { confirmed: '2026-10-18T12:00:00Z' } });
  const workstreams = await readWorkstreams(home);
  const email = (address) => ({ source: 'gmail', title: 'Next steps', text: '', who: [{ name: '', address }], recipients: 1 });
  // Bo writes from public mail, which no domain covers: the confirmed-person route files it.
  assert.deepEqual([route(email('bo@gmail.com'), { workstreams }).workstream, route(email('bo@gmail.com'), { workstreams }).how], ['Dell Offer', 'person']);
  // Ana and a stranger at Dell are both caught by the domain, which the router tries first.
  assert.deepEqual([route(email('ana@dell.example'), { workstreams }).workstream, route(email('ana@dell.example'), { workstreams }).how], ['Dell Offer', 'domain']);
  assert.deepEqual([route(email('zed@dell.example'), { workstreams }).workstream, route(email('zed@dell.example'), { workstreams }).how], ['Dell Offer', 'domain']);
});

// The Day view's sort (loggie-meetings-focus), on the shapes of his week of Oct 26 (titles made up where they name people).
test('Day sort: people, class, block; feeds, mass invites, copies and all-day entries hidden and counted', () => {
  const none = { attendees: [] };
  const mon = (time) => at(13, time);
  const events = [
    event('coffee-a', mon('08:00'), { ...none, title: 'School Coffee Time', calendar: 'Feed', writable: false }),
    event('coffee-b', mon('08:00'), { ...none, title: 'School Coffee Time', calendar: 'Feed copy', writable: true }),
    event('class', mon('10:10'), { ...none, title: '[WAITLIST 4] NBA 6030-001 Strategies' }),
    event('chat-a', mon('11:00'), { title: 'Coffee Chat w/ Sam Lee', attendees: ['sam@school.example'], attendeeNames: ['Sam Lee'] }),
    event('chat-b', mon('11:00'), { title: 'Coffee Chat w/ Sam Lee', attendees: ['sam@school.example'], attendeeNames: ['Sam Lee'] }),
    event('timecard', mon('11:30'), { title: 'Submit timecard', attendees: Array.from({ length: 88 }, (_, i) => `p${i}@school.example`) }),
    event('block', mon('13:30'), { ...none, title: 'Fall B coursework block' }),
    event('club', mon('17:00'), { ...none, title: 'GPASFC Meeting' }),
    event('holiday', mon('00:00'), { ...none, title: 'Halloween', allDay: true }),
    event('hours-feed', mon('14:00'), { ...none, title: 'Office hours request', writable: false }),
    event('hours', mon('14:00'), { title: 'Office hours request', attendees: ['prof@school.example'], attendeeNames: ['Lee, Dana'] }),
    event('class-feed', mon('15:30'), { ...none, title: 'NBA 5245-001 Macro', writable: false }),
  ];
  const { items, hidden } = joinWeek(events, [call('manual', mon('19:21'), { title: 'Meeting 7:21 PM' })], range);
  assert.deepEqual(items.map((item) => [item.title, item.sort]), [
    ['[WAITLIST 4] NBA 6030-001 Strategies', 'class'], ['Coffee Chat w/ Sam Lee', 'people'], ['Fall B coursework block', 'block'],
    ['Office hours request', 'people'], ['NBA 5245-001 Macro', 'class'], ['GPASFC Meeting', 'people'], ['Meeting 7:21 PM', 'people']]);
  assert.deepEqual(items.find((item) => item.id === 'hours').who, ['Dana'], 'the copy with people shows, its name in Outlook order read right');
  assert.deepEqual(items.find((item) => item.id === 'chat-a').who, ['Sam']);
  assert.deepEqual(hidden.map((item) => item.why).sort(), ['88 people', 'all day', 'duplicate', 'duplicate', 'duplicate', 'school feed'].sort());
  assert.ok(hidden.every((item) => item.day === '2026-10-13'));
  assert.equal(sortOf({ title: 'Project work', attendees: [] }), 'block');
});

// --- His calendar in the week (meetings-granola-proposal.md c 1.4 and 1D, 2026-10-27), the Oct 27 case with made-up
// names (test/fixtures/oct27-calendar.json). The recording sat under the Sage Hall row, because a call joined the
// nearest event start on any calendar and its start was the block's 14:30.
import { readFile } from 'node:fs/promises';
const OCT27 = JSON.parse(await readFile(new URL('./fixtures/oct27-calendar.json', import.meta.url), 'utf8'));
const DAY27 = { from: '2026-10-27', to: '2026-10-28', now: Date.parse('2026-10-27T21:00:00Z') };
const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

test('1B a shared calendar\'s block never takes a call; each row says whether it is his', () => {
  // Without its subscribed twin (MBAI, read-only), which hides it as a school feed, the MBA I block shows as a row.
  const { SAGE, MT2, MT, CLUB } = OCT27;
  const typed = call('typed', minutesAfter(SAGE.start, 10));   // a top-row press at 14:40, nothing of his on
  const { items } = joinWeek([SAGE, MT2, MT, CLUB], [typed], DAY27);
  const sage = items.find((row) => row.title === SAGE.title);
  assert.equal(sage.call, null, 'the school block is not the call\'s');
  assert.ok(items.some((row) => row.id === 'call:typed'), 'the call stands alone');
  assert.deepEqual(items.filter((row) => row.kind === 'event').map((row) => [row.title, row.mine]),
    [[SAGE.title, false], [CLUB.title, false], [MT.title, true]], 'the Google copy shows, his on either copy');
});

test('1A and 1D the call joins the event he pressed Record on, by its id, even pressed late; its start is the press', () => {
  const { SAGE, MT2, MT } = OCT27;
  const pressed = call('mt', minutesAfter(MT.start, 20), { eventId: MT.id });   // pressed 20 minutes into the meeting
  const { items } = joinWeek([SAGE, MT2, MT], [pressed], DAY27);
  assert.equal(items.find((row) => row.title === MT.title).call, 'mt');
  assert.equal(items.find((row) => row.title === SAGE.title).call, null);
  assert.equal(items.length, 2, 'no stray call row');
});
