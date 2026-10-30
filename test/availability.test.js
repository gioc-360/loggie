// Free times in an email (loggie-availability I1, docs/availability/spec.md tests 1.1 to 1.5): the cue, the window,
// the read on made-up calendars (fixtures F1, F3, F8, F9, F11, F14 of the spec, written there by hand before the
// code), the words, and the fill. Made-up people and events only; the expected answers are the spec's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityAsked, availabilityFor, availabilityReport, availabilitySettings, daysLabel, fillTimes, formatAvailability, hoursLabel, lineSkip, readWindow, REASONS, strayTimes, zoneLabel } from '../src/hikyaku/availability.js';
import { keepsLine } from '../src/hikyaku/ask-reply.js';
import { blocksTime, isMarker } from '../src/hikyaku/calendar.js';
import { ownText } from '../src/hikyaku/voice.js';
import { both, ev, F1_EVENTS } from './helpers/f1-events.js';

const ZONE = 'America/New_York';
const defaults = availabilitySettings({}, { macZone: ZONE });
const NOW = new Date('2026-10-20T16:21:00Z');

test('1.1 availabilityAsked: the spec table, as typed and as the email', () => {
  const rows = [
    ['email rowena my availability friday', 'typed', null],
    ['can you share a couple of time slots that work for you on Friday', 'typed', 'thread'],
    ['What times work for you next week?', 'typed', 'thread'],
    ['when are you free this week for 15 minutes', 'typed', 'thread'],
    ['send jamie some times thursday afternoon', 'typed', 'thread'],
    ['Let me know your availability', 'typed', 'thread'],
    ['Rooms have limited availability this week', 'typed', null],
    ['feel free to reach out', null, null],
    ['I will send it by 5pm', null, null],
    ['reply to jamie: thursday works', null, null],
    ['thanks for your time', null, null],
    ['the slides are free to download', null, null],
    ['what time is the deadline', null, null],
  ];
  for (const [sentence, typed, email] of rows) {
    assert.equal(availabilityAsked({ typed: sentence, line: sentence, email: '' }), typed, `as typed: ${sentence}`);
    assert.equal(availabilityAsked({ typed: 'reply to jamie: thanks', line: 'thanks', email: sentence }), email, `as the email: ${sentence}`);
  }
});

test('1.1 only the answered email counts: "time slots" in an older message and not in the last gives null', () => {
  const thread = [
    { body: 'Hi, can you share a couple of time slots for a call?' },
    { body: 'Thanks, the deck looks good.\n\nOn Tue, Oct 20, 2026 at 10:29 AM Sam wrote:\n> can you share a couple of time slots' },
  ];
  assert.equal(availabilityAsked({ typed: 'reply to sam: thanks', line: 'thanks', email: ownText(thread.at(-1).body) }), null);
  assert.equal(availabilityAsked({ typed: 'reply to sam: thanks', line: 'thanks', email: ownText(thread[0].body) }), 'thread');
});

test('1.2 readWindow: rows a to w of the spec', () => {
  const w = (typed, { now = NOW, email = '', emailAt = null } = {}) => readWindow({ typed, email, emailAt, now, settings: defaults });
  const days = (typed, options) => w(typed, options).days;
  const hours = (typed) => { const x = w(typed); return [x.startMinute, x.endMinute]; };
  const a = w('email rewena of my availability on friday');
  assert.deepEqual([a.days, a.startMinute, a.endMinute, a.minutes, a.from.days], [['2026-10-23'], 540, 1020, 30, 'typed'], 'a');
  assert.deepEqual(days('my availability friday', { now: new Date('2026-10-23T22:00:00Z') }), ['2026-10-30'], 'b: hours over');
  assert.deepEqual(days('my availability friday', { now: new Date('2026-10-23T13:00:00Z') }), ['2026-10-23'], 'c: 10:00 + 30 fits');
  const d = w('friday afternoon');
  assert.deepEqual([d.days, d.startMinute, d.endMinute, d.from.hours], [['2026-10-23'], 720, 1020, 'typed'], 'd');
  assert.deepEqual(hours('friday morning'), [540, 720], 'e');
  assert.deepEqual(hours('friday evening'), [1020, 1200], 'f');
  assert.deepEqual(hours('friday after 2pm'), [840, 1020], 'g');
  assert.deepEqual(hours('friday after 2'), [840, 1020], 'g bare');
  assert.deepEqual(hours('friday before 11'), [540, 660], 'h');
  assert.deepEqual(hours('friday between 10 and 2'), [600, 840], 'i');
  assert.deepEqual(hours('friday after 6pm'), [1080, 1200], 'j');
  for (const typed of ['friday afternoon', 'friday morning', 'friday after 2pm', 'friday between 10 and 2']) assert.deepEqual(days(typed), ['2026-10-23'], typed);
  assert.deepEqual(days('next week'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'], 'k');
  assert.deepEqual(days('this week', { now: new Date('2026-10-21T16:00:00Z') }), ['2026-10-21', '2026-10-22', '2026-10-23'], 'l');
  const m = w('this week', { now: new Date('2026-10-23T22:00:00Z') });
  assert.deepEqual([m.days, m.from.days], [['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'], 'settings'], 'm');
  assert.deepEqual(days('thursday or friday'), ['2026-10-22', '2026-10-23'], 'n');
  assert.deepEqual(days('oct 23'), ['2026-10-23'], 'o');
  assert.deepEqual(days('10/23'), ['2026-10-23'], 'o slash');
  assert.deepEqual(days('saturday'), ['2026-10-24'], 'p');
  assert.deepEqual(days('next friday'), ['2026-10-23'], 'q: next moves only the same weekday');
  assert.deepEqual(['friday for 15 minutes', 'an hour', 'half an hour', 'an hour and a half'].map((typed) => w(typed).minutes), [15, 60, 30, 60], 'r');
  const email = 'Hi Gio, can you share a couple of time slots that work for you on Friday? Best, Rowena';
  const s = w('reply to rowena: sure', { email, emailAt: '2026-10-20T14:29:00Z' });
  assert.deepEqual([s.days, s.from.days, s.stale], [['2026-10-23'], 'thread', false], 's');
  const t = w('reply to rowena: sure', { email, emailAt: '2026-10-20T14:29:00Z', now: new Date('2026-10-26T13:00:00Z') });
  assert.deepEqual([t.days, t.stale], [['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'], true], 't: stale');
  assert.deepEqual(days('email kim my availability'), ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'], 'u');
  assert.deepEqual(days('my availability friday', { email: 'Monday works?', emailAt: '2026-10-20T14:29:00Z' }), ['2026-10-23'], 'v: typed beats the email');
  const x = w('my availability oct 1');
  assert.deepEqual([x.days, x.from.days], [['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'], 'settings'], 'w: past 60 days');
});

test('1.2 readWindow never throws: non-strings and a bad emailAt give the Settings window', () => {
  const settingsWindow = readWindow({ typed: '', email: '', emailAt: null, now: NOW, settings: defaults });
  for (const input of [{ typed: 42, email: { x: 1 }, emailAt: 'not a date' }, { typed: null, email: undefined, emailAt: 12 }, {}]) {
    const out = readWindow({ ...input, now: NOW, settings: defaults });
    assert.deepEqual(out, settingsWindow);
  }
  assert.deepEqual([settingsWindow.startMinute, settingsWindow.endMinute, settingsWindow.minutes, settingsWindow.timeZone, settingsWindow.notice], [540, 1020, 30, ZONE, 60]);
  assert.deepEqual(settingsWindow.from, { days: 'settings', hours: 'settings', minutes: 'settings' });
});

// ---- 1.3 the read, on the spec's fixtures ----
const DRAFT = 'Hi,\n\n[your times]\n\nBest,';
const FIXTURES = {
  F1: { now: '2026-10-20T16:21:00Z', typed: 'email rewena of my availability on friday', line: 'Of my availability on friday', events: F1_EVENTS,
    expect: { asked: 'typed', days: ['2026-10-23'], read: 'read', how: 'line', readerCalls: 1, text: 'Fri Oct 23: 9 to 11:15am, 12:30 to 1pm ET' } },
  F3: { now: '2026-10-15T12:00:00Z', typed: 'email sam my availability friday', line: 'My availability friday',
    events: [ev('2026-10-16T11:00:00Z', '2026-10-16T22:00:00Z', { calendar: 'MBA I' }), ev('2026-10-16T13:00:00Z', '2026-10-16T13:45:00Z'),
      ev('2026-10-16T15:00:00Z', '2026-10-16T16:00:00Z', { calendar: 'MBA I' }), ev('2026-10-16T16:00:00Z', '2026-10-16T17:00:00Z', { calendar: 'MBA I' }),
      ev('2026-10-16T17:00:00Z', '2026-10-16T19:00:00Z'), ev('2026-10-16T18:00:00Z', '2026-10-16T18:30:00Z', { attendees: ['person@example.com'] }),
      ev('2026-10-16T19:15:00Z', '2026-10-16T20:45:00Z'), ev('2026-10-16T21:00:00Z', '2026-10-16T21:30:00Z')],
    expect: { days: ['2026-10-16'], text: 'Fri Oct 16: 9:45 to 11am ET' } },
  F8: { now: '2026-10-20T16:21:00Z', typed: 'email kim my availability thursday', line: 'My availability thursday',
    events: [ev('2026-10-22T12:00:00Z', '2026-10-22T22:00:00Z', { attendees: ['person@example.com'] })],
    expect: { days: ['2026-10-22'], read: 'read', text: '', how: 'left', body: DRAFT, note: 'Your calendar has no open 30 minutes on Thu Oct 22 from 9am to 5pm ET; [your times] is left for you.' } },
  F11: { now: '2026-10-30T13:00:00Z', typed: 'email kim my availability monday', line: 'My availability monday', events: [ev('2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z')],
    expect: { days: ['2026-11-02'], text: 'Mon Nov 2: 9am to 12pm, 1 to 5pm ET' } },
  F14: { now: '2026-10-20T16:21:00Z', settings: { availability: { selfBlocks: false } }, typed: 'email rewena of my availability on friday', line: 'Of my availability on friday', events: F1_EVENTS,
    expect: { text: 'Fri Oct 23: 9am to 4:30pm ET' } },
};
FIXTURES.F9 = { ...FIXTURES.F8, events: null, throws: 'hikyaku cannot read your calendars. Allow it in System Settings > Privacy & Security > Calendars.',
  expect: { read: 'unreadable', text: '', how: 'left', body: DRAFT, readerCalls: 1, note: 'Loggie could not read your calendar (no calendar access); [your times] is left for you.' } };

async function runFixture(f) {
  const draft = f.draft ?? DRAFT;
  const asked = availabilityAsked({ typed: f.typed, line: f.line, email: f.email ?? '' });
  const settings = availabilitySettings(f.settings ?? {}, { macZone: 'America/New_York' });
  const now = new Date(f.now);
  let readerCalls = 0;
  const eventsImpl = async () => { readerCalls += 1; if (f.throws) throw new Error(f.throws); return f.events; };
  const window = readWindow({ typed: f.typed, email: f.email ?? '', emailAt: f.emailAt ?? null, now, settings });
  const read = await availabilityFor({ window, settings, eventsImpl, statusImpl: async () => f.status ?? 'granted', now });
  const fill = fillTimes(draft, read, {});
  const stray = read.read === 'read' && read.days.length ? strayTimes(fill.text, read.days, { skip: fill.block, timeZone: window.timeZone }) : { text: fill.text, removed: [] };
  const report = availabilityReport({ asked, availability: read, how: fill.how, stray });
  return { asked, window, read: read.read, text: read.text, how: fill.how, body: stray.text, note: report.note, readerCalls, availability: read };
}

for (const [id, f] of Object.entries(FIXTURES)) {
  test(`1.3 availabilityFor on fixture ${id}`, async () => {
    const out = await runFixture(f);
    const want = { asked: 'typed', read: 'read', how: 'line', note: '', readerCalls: 1, ...f.expect };
    const draft = f.draft ?? DRAFT;
    if (!('body' in f.expect)) want.body = draft.replace(/^\[your times\]$/m, want.text);
    assert.equal(out.asked, want.asked, 'asked');
    if (want.days) assert.deepEqual(out.window.days, want.days, 'days');
    assert.deepEqual([out.window.startMinute, out.window.endMinute, out.window.minutes], [540, 1020, 30], 'window');
    assert.equal(out.read, want.read, 'read');
    assert.equal(out.text, want.text, 'text');
    assert.equal(out.how, want.how, 'how');
    assert.equal(out.body, want.body, 'body');
    assert.equal(out.note, want.note, 'note');
    assert.equal(out.readerCalls, want.readerCalls, 'readerCalls');
    // 0 overlaps: no range touches a blocking event ([a, b) and [s, e) overlap when s < b and e > a).
    const rules = availabilitySettings(f.settings ?? {}, { macZone: ZONE });
    const blocking = (f.events || []).filter(blocksTime).filter((e) => rules.selfBlocks || e.attendees.length);
    for (const day of out.availability.days) for (const r of day.ranges) {
      for (const e of blocking) assert.ok(!(Date.parse(e.start) < Date.parse(r.end) && Date.parse(e.end) > Date.parse(r.start)), `${r.start}-${r.end} overlaps ${e.start}`);
    }
  });
}

// TC3 (2026-10-21, "Yes, and handle typed times"): a time the user typed sets the window's hours, and code fills the
// free ranges inside it. "after 2pm" runs to the Settings end hour (spec 1.2). Made-up events: F1, and F1 with its
// 1 to 3 PM hold gone, so Friday has an open hour after 2.
const F1_NO_HOLD = F1_EVENTS.filter((e) => e.title !== 'Hold for prep');
const local = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const typedTime = (typed, events, now = '2026-10-20T16:21:00Z') => runFixture({ now, typed, line: typed.replace(/^email \w+ /, ''), events });
const noOverlap = (out, events) => {
  for (const day of out.availability.days) for (const r of day.ranges) {
    for (const e of events.filter(blocksTime)) assert.ok(!(Date.parse(e.start) < Date.parse(r.end) && Date.parse(e.end) > Date.parse(r.start)), `${r.start}-${r.end} overlaps ${e.start}`);
  }
};

test('TC3 "friday after 2pm": only ranges starting at or after 2pm, and free', async () => {
  const out = await typedTime('email rewena my availability friday after 2pm', F1_NO_HOLD);
  assert.deepEqual([out.window.days, out.window.startMinute, out.window.endMinute, out.window.from.hours], [['2026-10-23'], 840, 1020, 'typed']);
  assert.equal(out.text, 'Fri Oct 23: 2 to 3:15pm ET');
  assert.equal(out.body, 'Hi,\n\nFri Oct 23: 2 to 3:15pm ET\n\nBest,');
  for (const day of out.availability.days) for (const r of day.ranges) assert.ok(local(r.start) >= '14:00', `${r.start} starts before 2pm`);
  noOverlap(out, F1_NO_HOLD);
  const short = await typedTime('email rewena my availability friday after 2pm for 15 minutes', F1_EVENTS);
  assert.equal(short.text, 'Fri Oct 23: 3 to 3:15pm ET', 'F1 after 2pm has one open 15 minutes, 3 to 3:15');
  noOverlap(short, F1_EVENTS);
});

test('TC3 "before noon", "tuesday before noon" and "this week mornings" fill the ranges inside the typed hours', async () => {
  const friday = await typedTime('email rewena my availability friday before noon', F1_EVENTS);
  assert.deepEqual([friday.window.startMinute, friday.window.endMinute], [540, 720]);
  assert.equal(friday.text, 'Fri Oct 23: 9 to 11:15am ET');
  noOverlap(friday, F1_EVENTS);
  const tuesday = await typedTime('email kim my availability tuesday before noon', F1_EVENTS);
  assert.deepEqual([tuesday.window.days, tuesday.window.startMinute, tuesday.window.endMinute], [['2026-10-27'], 540, 720]);
  assert.equal(tuesday.text, 'Tue Oct 27: 9am to 12pm ET');
  // Wed 12:00 EDT: this morning is over, so the mornings are Thursday's and Friday's.
  const mornings = await typedTime('email kim my availability this week mornings', F1_EVENTS, '2026-10-21T16:00:00Z');
  assert.deepEqual([mornings.window.days, mornings.window.startMinute, mornings.window.endMinute, mornings.window.from.hours], [['2026-10-22', '2026-10-23'], 540, 720, 'typed']);
  assert.equal(mornings.text, 'Thu Oct 22: 9am to 12pm\nFri Oct 23: 9 to 11:15am ET');
  noOverlap(mornings, F1_EVENTS);
});

test('TC3 a typed time that is fully booked gives the note and keeps [your times], never a range outside it', async () => {
  const out = await typedTime('email rewena my availability friday after 2pm', F1_EVENTS);
  assert.deepEqual([out.read, out.text, out.how, out.body], ['read', '', 'left', DRAFT]);
  assert.equal(out.note, 'Your calendar has no open 30 minutes on Fri Oct 23 from 2 to 5pm ET; [your times] is left for you.');
});

test('TC3 lineSkip leaves the typed clock words out of keepsLine; the guard still judges every time in the draft', async () => {
  const draft = 'Hi Rowena,\n\nHere are the times that work for me:\n[your times]\n\nBest,\nGio';
  for (const line of ['My availability friday after 2pm', 'My availability tuesday before noon', 'My availability this week mornings', 'My availability friday between 10 and 2', 'My availability friday 2 to 4pm']) {
    assert.equal(keepsLine(line, draft), false, `without skip: ${line}`);
    assert.equal(keepsLine(line, draft, { skip: lineSkip(line) }), true, `with skip: ${line}`);
  }
  assert.deepEqual(lineSkip('My availability friday after 2pm, about the deck'), ['availability', 'friday', 'after', '2pm']);
  // The words skipped are only the check's: a time the draft names outside the filled ranges still comes out.
  const out = await typedTime('email rewena my availability friday after 2pm', F1_NO_HOLD);
  const stray = strayTimes('I am free after 2pm, or at 4pm.\n\nFri Oct 23: 2 to 3:15pm ET', out.availability.days, { skip: [2, 2], timeZone: ZONE });
  assert.equal(stray.text, 'I am free after 2pm, or [your times].\n\nFri Oct 23: 2 to 3:15pm ET');
  assert.deepEqual(stray.removed, ['at 4pm']);
});

test('1.8 a named day that is full gets its note; a full day of "next week" or of Settings days does not (F7)', async () => {
  const thursdayFull = [ev('2026-10-22T12:00:00Z', '2026-10-22T22:00:00Z', { attendees: ['person@example.com'] }), ...F1_EVENTS];
  const named = await runFixture({ now: '2026-10-20T16:21:00Z', typed: 'email kim my availability thursday or friday', line: 'My availability thursday or friday', events: thursdayFull });
  assert.equal(named.window.named, true);
  assert.equal(named.note, 'Thu Oct 22 has no open 30 minutes; the other days are in the draft.');
  const week = await runFixture({ now: '2026-10-20T16:21:00Z', typed: 'email kim my availability this week', line: 'My availability this week', events: thursdayFull });
  assert.equal(week.window.named, false);
  assert.equal(week.note, '');
});

test('1.3 status denied lists nothing; a reader that never answers gives the 5 s reason; [] gives empty', async () => {
  const window = readWindow({ typed: 'my availability friday', now: NOW, settings: defaults });
  let calls = 0;
  const denied = await availabilityFor({ window, settings: defaults, eventsImpl: async () => { calls += 1; return F1_EVENTS; }, statusImpl: async () => 'denied', now: NOW });
  assert.deepEqual([denied.read, denied.reason, denied.days, denied.text, calls], ['unreadable', REASONS.access, [], '', 0]);
  const unknown = await availabilityFor({ window, settings: defaults, eventsImpl: async () => { calls += 1; return F1_EVENTS; }, statusImpl: async () => 'unknown', now: NOW });
  assert.deepEqual([unknown.read, calls], ['unreadable', 0], 'unknown never reads (no access dialog mid-ask)');
  const hung = await availabilityFor({ window, settings: defaults, eventsImpl: () => new Promise(() => {}), statusImpl: async () => 'granted', now: NOW, timeoutMs: 50 });
  assert.deepEqual([hung.read, hung.reason, hung.text], ['unreadable', 'the calendar did not answer in 5 seconds', '']);
  const empty = await availabilityFor({ window, settings: defaults, eventsImpl: async () => [], statusImpl: async () => 'granted', now: NOW });
  assert.deepEqual([empty.read, empty.reason, empty.days], ['empty', 'no events on your calendars for these days or the week before', []]);
  const missing = await availabilityFor({ window, settings: defaults, eventsImpl: async () => { throw new Error('Loggie is missing its calendar helper at /x/y'); }, statusImpl: async () => 'granted', now: NOW });
  assert.equal(missing.reason, 'the calendar helper is missing');
  const other = await availabilityFor({ window, settings: defaults, eventsImpl: async () => { throw new Error('EventKit said something about gc@example.edu'); }, statusImpl: async () => 'granted', now: NOW });
  assert.equal(other.reason, 'the calendar helper failed', 'the helper\'s own words never reach the reason');
});

test('1.3 the read asks once for the week before through the last day, from midnight in the zone', async () => {
  const window = readWindow({ typed: 'thursday or friday', now: NOW, settings: defaults });
  const asked = [];
  await availabilityFor({ window, settings: defaults, eventsImpl: async (options) => { asked.push(options); return F1_EVENTS; }, statusImpl: async () => 'granted', now: NOW });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].from.toISOString(), '2026-10-15T04:00:00.000Z');
  assert.equal(asked[0].days, 9);
});

test('1.3 the marker rule (D1): an 8 h uninvited event blocks, an 8 h 1 min one does not; someone invited always blocks', async () => {
  const eight = ev('2026-10-23T13:00:00Z', '2026-10-23T21:00:00Z');
  const longer = ev('2026-10-23T13:00:00Z', '2026-10-23T21:01:00Z');
  assert.deepEqual([isMarker(eight), blocksTime(eight), isMarker(longer), blocksTime(longer)], [false, true, true, false]);
  assert.equal(blocksTime({ ...longer, attendees: ['person@example.com'] }), true);
  const window = readWindow({ typed: 'friday', now: NOW, settings: defaults });
  const run = (events) => availabilityFor({ window, settings: defaults, eventsImpl: async () => events, statusImpl: async () => 'granted', now: NOW });
  assert.deepEqual((await run([eight])).days, []);
  assert.equal((await run([longer])).text, 'Fri Oct 23: 9am to 5pm ET');
});

test('1.3 Sun Nov 1 to Mon Nov 2 (clocks go back) gives each day once', async () => {
  const window = { ...readWindow({ typed: '', now: NOW, settings: defaults }), days: ['2026-11-01', '2026-11-02'] };
  const read = await availabilityFor({ window, settings: defaults, eventsImpl: async () => [ev('2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z')], statusImpl: async () => 'granted', now: NOW });
  assert.deepEqual(read.days.map((d) => d.day), ['2026-11-01', '2026-11-02']);
  assert.equal(read.text, 'Sun Nov 1: 9am to 5pm\nMon Nov 2: 9am to 12pm, 1 to 5pm ET');
});

test('1.3 today: an hour\'s notice, on the quarter hour', async () => {
  const window = readWindow({ typed: 'today', now: NOW, settings: defaults });
  const read = await availabilityFor({ window, settings: defaults, eventsImpl: async () => [ev('2026-10-13T13:00:00Z', '2026-10-13T14:00:00Z')], statusImpl: async () => 'granted', now: NOW });
  assert.equal(read.text, 'Tue Oct 20: 1:30 to 5pm ET', '12:21 + 60 min is 1:21, up to 1:30');
});

// ---- 1.4 the words ----
const day = (key, ...ranges) => ({ day: key, ranges: ranges.map(([start, end]) => ({ start, end })) });
test('1.4 formatAvailability: rounding, the am/pm rule, whole hours, noon, the zone once on the last line', () => {
  assert.equal(formatAvailability([day('2026-10-23', ['2026-10-23T13:05:00Z', '2026-10-23T15:20:00Z'])], { timeZone: ZONE }), 'Fri Oct 23: 9:15 to 11:15am ET');
  assert.equal(formatAvailability([day('2026-10-23', ['2026-10-23T15:30:00Z', '2026-10-23T17:00:00Z'], ['2026-10-23T16:00:00Z', '2026-10-23T17:30:00Z'], ['2026-10-23T13:00:00Z', '2026-10-23T21:00:00Z'])], { timeZone: ZONE }),
    'Fri Oct 23: 11:30am to 1pm, 12 to 1:30pm, 9am to 5pm ET');
  assert.equal(formatAvailability([day('2026-10-23', ['2026-10-23T13:00:00Z', '2026-10-23T14:00:00Z']), day('2026-10-26', ['2026-10-26T16:00:00Z', '2026-10-26T18:00:00Z'])], { timeZone: ZONE }),
    'Fri Oct 23: 9 to 10am\nMon Oct 26: 12 to 2pm ET', 'noon is 12pm; the zone only on the last line');
  assert.equal(formatAvailability([day('2026-12-04', ['2026-12-04T14:00:00Z', '2026-12-04T15:00:00Z'])], { timeZone: ZONE }), 'Fri Dec 4: 9 to 10am ET', 'ET after the clocks change too');
  assert.equal(formatAvailability([day('2026-10-23', ['2026-10-23T08:00:00Z', '2026-10-23T09:00:00Z'])], { timeZone: 'Europe/London' }), 'Fri Oct 23: 9 to 10am GMT+1');
  assert.equal(formatAvailability([], { timeZone: ZONE }), '');
  assert.deepEqual([zoneLabel(ZONE, new Date('2026-10-23T12:00:00Z')), zoneLabel(ZONE, new Date('2026-12-04T12:00:00Z')), zoneLabel('Europe/London', new Date('2026-10-23T12:00:00Z')), zoneLabel('UTC')], ['ET', 'ET', 'GMT+1', 'UTC']);
});

test('1.4 daysLabel for 1, 2 and 5 days; hoursLabel', () => {
  assert.equal(daysLabel(['2026-10-23']), 'Fri Oct 23');
  assert.equal(daysLabel(['2026-10-22', '2026-10-23']), 'Thu Oct 22 and Fri Oct 23');
  assert.equal(daysLabel(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']), 'Mon Oct 26 to Fri Oct 30');
  assert.equal(hoursLabel(540, 1020, ZONE, new Date('2026-10-23T12:00:00Z')), '9am to 5pm ET');
  assert.equal(hoursLabel(840, 1020, ZONE, new Date('2026-10-23T12:00:00Z')), '2 to 5pm ET');
});

// ---- 1.5 the fill ----
const F1_TEXT = 'Fri Oct 23: 9 to 11:15am, 12:30 to 1pm ET';
const filled = { read: 'read', days: [day('2026-10-23', ['2026-10-23T13:00:00.000Z', '2026-10-23T15:15:00.000Z'], ['2026-10-23T16:30:00.000Z', '2026-10-23T17:00:00.000Z'])], text: F1_TEXT, window: { timeZone: ZONE } };
const unread = { read: 'unreadable', reason: REASONS.access, days: [], text: '' };

test('1.5 fillTimes: line, inline, inserted before the sign-off or the name, left, and a placeholder put in', () => {
  assert.deepEqual(fillTimes('Hi Sam,\n\nThese work for me:\n[your times]\n\nBest,\nGio', filled), { text: `Hi Sam,\n\nThese work for me:\n${F1_TEXT}\n\nBest,\nGio`, how: 'line', block: [3, 3] });
  assert.equal(fillTimes('Hi,\n\n[your times].\n\nBest,', filled).text, `Hi,\n\n${F1_TEXT}\n\nBest,`);
  assert.equal(fillTimes('Hi,\n\n  [your times]:  \n\nBest,', filled).how, 'line');
  const inline = fillTimes('Hi Rowena,\n\nI am available on Friday [your times].\n\nBest,\nGio', filled);
  assert.deepEqual(inline, { text: `Hi Rowena,\n\nI am available on Friday.\n\n${F1_TEXT}\n\nBest,\nGio`, how: 'inline', block: [4, 4] });
  assert.deepEqual(fillTimes('Hi Rowena,\n\nI am available on Friday.\n\nBest,\nGio', filled), { text: `Hi Rowena,\n\nI am available on Friday.\n\n${F1_TEXT}\n\nBest,\nGio`, how: 'inserted', block: [4, 4] });
  assert.equal(fillTimes('Of my availability on friday.\n\nGio', filled, { signName: 'Gio' }).text, `Of my availability on friday.\n\n${F1_TEXT}\n\nGio`);
  assert.equal(fillTimes('Hi,\n\nHere you go.', filled).text, `Hi,\n\nHere you go.\n\n${F1_TEXT}`);
  assert.deepEqual(fillTimes('Hi,\n\n[your times]\n\nBest,', unread), { text: 'Hi,\n\n[your times]\n\nBest,', how: 'left', block: null });
  assert.equal(fillTimes('Hi,\n\nI am free.\n\nBest,', unread).text, 'Hi,\n\nI am free.\n\n[your times]\n\nBest,', 'inserted PLACEHOLDER when none is there');
  assert.equal(fillTimes('Hi,\n\nI am free.\n\nBest,', unread).how, 'inserted');
  const two = fillTimes('Hi,\n\n[your times]\n\nOr [your times] next week.\n\nBest,', filled);
  assert.equal(two.text, `Hi,\n\n${F1_TEXT}\n\nOr [your times] next week.\n\nBest,`, 'a second placeholder stays');
  const multi = { ...filled, text: 'Thu Oct 22: 9 to 10am\nFri Oct 23: 9 to 11:15am ET' };
  assert.deepEqual(fillTimes('Hi,\n\n[your times]\n\nBest,', multi).block, [2, 3]);
});

test('1.5 strayTimes: a time outside the free ranges becomes [your times]; the block\'s own lines are never touched', () => {
  const body = `Hi,\n\n2pm works for me.\n\n${F1_TEXT}\n\nBest,`;
  const out = strayTimes(body, filled.days, { skip: [4, 4], timeZone: ZONE });
  assert.deepEqual(out, { text: `Hi,\n\n[your times] works for me.\n\n${F1_TEXT}\n\nBest,`, removed: ['2pm'] });
  const kept = strayTimes(`Hi,\n\nAnything after 10am is fine.\n\n${F1_TEXT}`, filled.days, { skip: [4, 4], timeZone: ZONE });
  assert.deepEqual(kept.removed, [], 'a time inside a range stays');
  const range = strayTimes(`Hi,\n\nI can do 10:30 to 1pm or 3pm.\n\n${F1_TEXT}`, filled.days, { skip: [4, 4], timeZone: ZONE });
  assert.equal(range.text.split('\n')[2], 'I can do [your times].', 'a range across a busy gap and its neighbour go together');
  const untouched = strayTimes(F1_TEXT, filled.days, { skip: [0, 0], timeZone: ZONE });
  assert.equal(untouched.text, F1_TEXT);
  assert.equal(strayTimes('2pm\n4pm works', filled.days, { skip: [0, 0], timeZone: ZONE }).text, '2pm\n[your times] works', 'a line inside the skip is left as it is');
});
