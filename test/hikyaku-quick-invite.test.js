import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPeople, peopleIn, resolvePerson } from '../src/hikyaku/people.js';
import { candidateStarts, describe, quickInvite, readSentence, rrule } from '../src/hikyaku/quick-invite.js';

// Made-up people, written the way THREAD.md headers carry them.
const THREADS = [
  '## Nina Patel <nina.patel@example.edu> · 2026-10-01\nTo: Jules Moreno <jm123@example.edu>, Alex Moreno <alex@example.edu>\n',
  '## Jules Moreno <jm123@example.edu> · 2026-10-02\nTo: Nina Patel <nina.patel@example.edu>\n',
  '## Sam Lee <sam.lee@northwind.example> · 2026-10-03\nTo: Sam Park <sam.park@northwind.example>\n',
];
const PEOPLE = peopleIn(THREADS);
// Friday 2026-10-09, 10:00 local.
const NOW = new Date(2026, 9, 9, 10, 0);

test('the people index pairs each address with the name written beside it, most-seen first', () => {
  assert.deepEqual(PEOPLE.slice(0, 2).map((p) => [p.name, p.address, p.count]), [['Jules Moreno', 'jm123@example.edu', 2], ['Nina Patel', 'nina.patel@example.edu', 2]]);
});

test('a name resolves only when one person answers to it', () => {
  assert.equal(resolvePerson('Nina', PEOPLE).person.address, 'nina.patel@example.edu');
  assert.equal(resolvePerson('jules moreno', PEOPLE).person.address, 'jm123@example.edu');
  assert.equal(resolvePerson('Nin', PEOPLE).person.address, 'nina.patel@example.edu');   // the start of a name
  assert.equal(resolvePerson('Sam', PEOPLE).status, 'many');                            // two Sams: a question, never a guess
  assert.equal(resolvePerson('Moreno', PEOPLE).status, 'many');
  assert.equal(resolvePerson('Priscilla', PEOPLE).status, 'none');
  assert.equal(resolvePerson('dana@example.edu', PEOPLE).person.address, 'dana@example.edu');
});

test('loadPeople reads every THREAD.md under work/', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-people-'));
  await mkdir(join(home, 'work', 'a', 'b'), { recursive: true });
  await writeFile(join(home, 'work', 'a', 'b', 'THREAD.md'), THREADS[0]);
  await writeFile(join(home, 'work', 'a', 'notes.md'), 'Ignored Person <ignored@example.edu>');
  const people = await loadPeople({ home });
  assert.deepEqual(people.map((p) => p.address).sort(), ['alex@example.edu', 'jm123@example.edu', 'nina.patel@example.edu']);
});

test('the example sentence: two people, a time, and what is left is the place', () => {
  const plan = readSentence('invite Nina and Jules 2pm Maplewood', { people: PEOPLE, now: NOW });
  assert.deepEqual(plan.people.map((p) => p.address), ['nina.patel@example.edu', 'jm123@example.edu']);
  assert.equal(plan.start.getTime(), new Date(2026, 9, 9, 14, 0).getTime());
  assert.equal(plan.end, '15:00');
  assert.equal(plan.place, 'Maplewood');
  assert.equal(plan.calendar, 'outlook');
  assert.equal(plan.title, 'Meeting with Nina, Jules');
});

test('the way it was first asked reads the same', () => {
  const plan = readSentence('send nina patel and jules moreno an outlook invite for 2pm location maple wood', { people: PEOPLE, now: NOW });
  assert.deepEqual(plan.people.map((p) => p.name), ['Nina Patel', 'Jules Moreno']);
  assert.equal(plan.place, 'maple wood');
  assert.equal(plan.start.getHours(), 14);
});

test('days, lengths, repeats, rooms, notes, subjects and google', () => {
  const a = readSentence('Nina tomorrow 9:30am for 30 min at Sage Hall weekly "Q3 plan"', { people: PEOPLE, now: NOW });
  assert.equal(a.start.getTime(), new Date(2026, 9, 10, 9, 30).getTime());
  assert.equal(a.end, '10:00'); assert.equal(a.place, 'Sage Hall'); assert.equal(a.repeat, 'weekly'); assert.equal(a.title, 'Q3 plan');
  const b = readSentence('Jules next monday 14:00 for 1.5 hours room in Breazzano floor 2 or 3 with notes', { people: PEOPLE, now: NOW });
  assert.equal(b.start.getTime(), new Date(2026, 9, 12, 14, 0).getTime());
  assert.equal(b.end, '15:30'); assert.deepEqual(b.room, { query: 'Breazzano', floors: '23' }); assert.equal(b.notes, true); assert.equal(b.place, '');
  const c = readSentence('Nina oct 14 noon on google every month about budget review', { people: PEOPLE, now: NOW });
  assert.equal(c.calendar, 'google'); assert.equal(c.start.getTime(), new Date(2026, 9, 14, 12, 0).getTime()); assert.equal(c.repeat, 'monthly'); assert.equal(c.title, 'budget review');
  const d = readSentence('Nina friday 8am', { people: PEOPLE, now: NOW });   // this Friday's 8am has passed: next Friday
  assert.equal(d.start.getTime(), new Date(2026, 9, 16, 8, 0).getTime());
  const e = readSentence('Nina 9am', { people: PEOPLE, now: NOW });         // today's 9am has passed: tomorrow
  assert.equal(e.start.getTime(), new Date(2026, 9, 10, 9, 0).getTime());
});

test('a room with no time: "room in Sage next week" keeps the week and the one-word building', () => {
  const plan = readSentence('Nina and Jules room in Sage next week', { people: PEOPLE, now: NOW });
  assert.deepEqual(plan.room, { query: 'Sage', floors: '' });
  assert.equal(plan.place, ''); assert.equal(plan.timeGiven, false);
  assert.equal(plan.day.getTime(), new Date(2026, 9, 12).getTime());   // next Monday
});

test('custom repeats: how often, which weekdays, and the end', () => {
  const a = readSentence('Nina 4pm every other week until dec 4', { people: PEOPLE, now: NOW });
  assert.equal(a.repeat, 'weekly'); assert.equal(a.every, 2); assert.equal(a.until, '2026-12-04');
  const b = readSentence('Nina every tuesday and thursday 4pm for 6 weeks at Sage Hall', { people: PEOPLE, now: NOW });
  assert.deepEqual(b.on, ['tue', 'thu']); assert.equal(b.times, 6); assert.equal(b.place, 'Sage Hall');
  assert.equal(b.start.getTime(), new Date(2026, 9, 13, 16, 0).getTime());   // the first Tuesday after Friday
  const c = readSentence('Nina monday 9am every 3 weeks 10 times', { people: PEOPLE, now: NOW });
  assert.equal(c.every, 3); assert.equal(c.times, 10); assert.equal(c.start.getDay(), 1);
  const d = readSentence('Nina 2pm every month forever', { people: PEOPLE, now: NOW });
  assert.equal(d.repeat, 'monthly'); assert.equal(d.noEnd, true);
  assert.equal(rrule(a), 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261204T235959Z');
  assert.equal(rrule(b), 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6');
});

test('a custom repeat reaches the helper as its own flags', async () => {
  const ran = [];
  const plan = readSentence('Nina every tuesday and thursday 4pm for 6 weeks', { people: PEOPLE, now: NOW });
  await quickInvite(plan, { spawnImpl: () => ({ unref() {} }), helper: '/x/h', now: NOW, settings: {}, eventsImpl: async () => [],
    execImpl: async (bin, args) => { ran.push(args); return { stdout: JSON.stringify({ status: 'ready', detail: 'ok' }) }; } });
  const at = ran[0].indexOf('--repeat');
  assert.deepEqual(ran[0].slice(at, at + 6), ['--repeat', 'weekly', '--on', 'tue,thu', '--times', '6']);
});

test('what it cannot read is a plain question, never a guess', () => {
  assert.throws(() => readSentence('Sam 2pm Maplewood', { people: PEOPLE, now: NOW }), /More than one person answers to "Sam": Sam Lee/);
  assert.throws(() => readSentence('Nina and Priscilla 2pm', { people: PEOPLE, now: NOW }), /No one called "Priscilla"/);
  assert.throws(() => readSentence('2pm Maplewood', { people: PEOPLE, now: NOW }), /No one called "Maplewood"|Say who/);
  assert.throws(() => readSentence('Nina 11pm for 2 hours', { people: PEOPLE, now: NOW }), /past midnight/);
});

test('Outlook: the link carries people and start, the helper gets end, place, repeat; nothing sends', async () => {
  const opened = [], ran = [];
  const plan = readSentence('Nina and Jules 2pm Maplewood weekly', { people: PEOPLE, now: NOW });
  const result = await quickInvite(plan, {
    spawnImpl: (cmd, args) => { opened.push(args[0]); return { unref() {} }; },
    execImpl: async (bin, args) => { ran.push(args); return { stdout: JSON.stringify({ status: 'ready', detail: 'The invite is filled in Outlook and waiting for you. Nothing was sent.', end_set: '14:50', location: 'Maplewood', repeat_rule: 'Occurs every Friday' }) }; },
    helper: '/x/hikyaku-outlook-event', clock: (() => { let t = 0; return () => (t += 1500); })(), now: NOW, settings: {},
    eventsImpl: async () => [ev(14, 15), ev(15, 20)],   // the user is busy from 2 pm to 8 pm: no other time to try that day
  });
  assert.match(opened[0], /^ms-outlook:\/\/events\/new\?title=Meeting%20with%20Nina%2C%20Jules&start=2026-10-09T14%3A00%3A00&attendees=nina\.patel%40example\.edu,jm123%40example\.edu$/);
  const tryAt = ran[0].indexOf('--try');
  assert.deepEqual(ran[0].slice(0, tryAt), ['fill', '--subject', 'Meeting with Nina, Jules', '--end', '15:00', '--nearest']);
  assert.match(ran[0][tryAt + 1], /^2026-10-12 09:00,2026-10-12 09:30,/);   // the next weekday's free times; this Friday is busy
  assert.deepEqual(ran[0].slice(tryAt + 2), ['--want', '3', '--teams', 'off', '--repeat', 'weekly', '--location', 'Maplewood']);
  assert.ok(!ran[0].includes('send') && !ran[0].includes('--send'));
  assert.equal(result.status, 'ready');
  const lines = describe(result);
  assert.match(lines[2], /to 14:50 \(Outlook's nearest end to 15:00\)/);
  assert.match(lines.at(-1), /Nothing was sent\. \(1\.5 s\)/);
});

// A writable event on Friday 2026-10-09 (or another day) from h1 to h2, local time.
function ev(h1, h2, day = 9) { return { start: new Date(2026, 9, day, h1, 0).toISOString(), end: new Date(2026, 9, day, h2, 0).toISOString(), allDay: false, writable: true }; }

test('candidate times: the user\'s free half hours, weekdays 9-20, weekends only when asked', () => {
  const plan = readSentence('Nina friday 4pm', { people: PEOPLE, now: NOW });
  const busy = [ev(16, 17), ev(18, 20)];   // busy 4-5 pm and 6-8 pm on Friday
  const starts = candidateStarts(plan, busy, { now: NOW }).map((d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
  assert.deepEqual(starts.slice(0, 3), ['9 17:00', '12 9:00', '12 9:30']);   // 5-6 pm Friday, then Monday from 9; no weekend
  const withWeekends = candidateStarts(plan, busy, { now: NOW, weekends: true }).map((d) => d.getDate());
  assert.equal(withWeekends[1], 10);                                          // Saturday
});

test('a long event with no one invited (a break, a deadline banner) does not hide the day', () => {
  const plan = readSentence('Nina monday 4pm', { people: PEOPLE, now: NOW });
  const brk = { start: new Date(2026, 9, 10, 8, 0).toISOString(), end: new Date(2026, 9, 13, 23, 55).toISOString(), allDay: false, writable: true };
  const meeting = { ...ev(16, 18, 12), attendees: [{ email: 'x@example.edu' }] };   // a real meeting with people still blocks
  const starts = candidateStarts(plan, [brk, meeting], { now: NOW }).map((d) => `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
  assert.deepEqual(starts.slice(0, 2), ['12 18:00', '12 18:30']);
});

test('no time said: the first free time is filled, and the helper is told what else to try', async () => {
  const ran = [];
  const plan = readSentence('Nina and Jules at Maplewood this week', { people: PEOPLE, now: NOW });
  assert.equal(plan.timeGiven, false); assert.equal(plan.place, 'Maplewood'); assert.equal(plan.lookDays, 1);
  const result = await quickInvite(plan, { spawnImpl: () => ({ unref() {} }), helper: '/x/h', now: NOW, settings: {},
    eventsImpl: async () => [ev(10, 12)],
    execImpl: async (bin, args) => { ran.push(args); return { stdout: JSON.stringify({ status: 'ready', detail: 'filled', time_found: '2026-10-09 12:00', time_asked_free: true, also_free: [] }) }; } });
  assert.equal(plan.start.getTime(), new Date(2026, 9, 9, 12, 0).getTime());   // 10:00 is now's half hour but busy until noon
  assert.match(ran[0][ran[0].indexOf('--try') + 1], /^2026-10-09 12:30,2026-10-09 13:00/);
  assert.equal(result.status, 'ready');
});

test('the asked time taken: the found time replaces it and two more are listed', async () => {
  const plan = readSentence('Nina monday 10am', { people: PEOPLE, now: NOW });
  const result = await quickInvite(plan, { spawnImpl: () => ({ unref() {} }), helper: '/x/h', now: NOW, settings: {}, eventsImpl: async () => [],
    execImpl: async () => ({ stdout: JSON.stringify({ status: 'ready', detail: 'The invite is filled in Outlook and waiting for you. Nothing was sent.', time_found: '2026-10-12 11:30', time_asked_free: false, also_free: ['2026-10-12 12:00', '2026-10-12 12:30'], end_set: '12:20' }) }) });
  assert.equal(plan.start.getTime(), new Date(2026, 9, 12, 11, 30).getTime());
  const lines = describe(result).join('\n');
  assert.match(lines, /taken for someone; this is the first time free for everyone/);
  assert.match(lines, /Also free for everyone: Mon 12:00 PM, Mon 12:30 PM/);
});

test('Google: one link with people, place and repeat; no helper runs', async () => {
  const opened = [];
  const plan = readSentence('Nina 2pm at Maplewood weekly on google', { people: PEOPLE, now: NOW });
  const result = await quickInvite(plan, { spawnImpl: (cmd, args) => { opened.push(args[0]); return { unref() {} }; }, execImpl: () => { throw new Error('no helper for Google'); }, now: NOW, settings: {}, eventsImpl: async () => { throw new Error('Google with a time reads no calendar'); } });
  const url = new URL(opened[0]);
  assert.equal(url.host, 'calendar.google.com');
  assert.equal(url.searchParams.get('add'), 'nina.patel@example.edu');
  assert.equal(url.searchParams.get('location'), 'Maplewood');
  assert.equal(url.searchParams.get('recur'), 'RRULE:FREQ=WEEKLY');
  assert.equal(result.status, 'ready');
});

// Gio's live invites, 2026-10-11 (loggie-ask-box): "1730" was not a time, so it and "for a call" and "outlook" became
// the location, and "today" with no time booked the next free slot of the week. Made-up addresses.
test('live misreads: 24-hour times, the kind of meeting, the app word, a day with no time, a one-letter name slip', () => {
  const people = [{ name: 'Marisol Okafor', address: 'ap@example.edu', count: 3 }, { name: 'Tomas Ruiz', address: 'tp@example.edu', count: 2 }, { name: 'Jess Lu', address: 'jl@example.edu', count: 2 }];
  const now = new Date(2026, 9, 11, 12, 0);
  const at = (plan) => plan.start && `${plan.start.getDate()} ${plan.start.getHours()}:${String(plan.start.getMinutes()).padStart(2, '0')}`;
  const a = readSentence('invite marisol and tomas for a call outlook', { people, now });
  assert.deepEqual([a.people.length, a.place, a.title], [2, '', 'Call with Marisol, Tomas']);
  const b = readSentence('invite tomas 1730 today', { people, now });
  assert.deepEqual([at(b), b.place, b.title], ['11 17:30', '', 'Meeting with Tomas']);
  const c = readSentence('invite marisl for a call 1730 today', { people, now });
  assert.deepEqual([c.people[0].name, at(c), c.place, c.title], ['Marisol Okafor', '11 17:30', '', 'Call with Marisol']);
  assert.equal(at(readSentence('invite marisol 5:30 today', { people, now })), '11 17:30');
  assert.equal(at(readSentence('invite marisol 530pm tomorrow', { people, now })), '12 17:30');
  const d = readSentence('invite tomas today', { people, now });
  assert.deepEqual([d.start, d.lookDays], [null, 1]);
  const e = readSentence('Marisol and Jess 2pm Maplewood', { people, now });
  assert.deepEqual([e.place, at(e)], ['Maplewood', '11 14:00']);
  const f = readSentence('invite marisol tomorrow for coffee at Gimme Coffee', { people, now });
  assert.deepEqual([f.place, f.title], ['Gimme Coffee', 'Coffee with Marisol']);
});

// Live 2026-10-12: "NEXT GEN·TEAM" (a team address in the inbox) answered to "next", so "about loggie next steps" put
// the team on the invite and left "steps" out. A team or list has no first name; its whole name still reaches it.
test('a team address never answers to its first word, only to its whole name', () => {
  const people = [...PEOPLE, { name: 'NEXT GEN·TEAM', address: 'hello@team.example', count: 0 }];
  const now = new Date('2026-10-12T12:00:00-04:00');
  const plan = readSentence('invite nina 1900 about loggie next steps', { people, now });
  assert.deepEqual(plan.people.map((p) => p.address), ['nina.patel@example.edu']);
  assert.equal(plan.title, 'loggie next steps');
  assert.deepEqual(plan.leftOut, []);
  const whole = readSentence('invite nina and next gen·team about loggie', { people, now });
  assert.ok(whole.people.some((p) => p.address === 'hello@team.example'));
});
