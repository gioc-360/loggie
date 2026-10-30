// callEvent maps a calendar.js event to call.py's event shape (spec-c.md B14). Pure: no calendar, no recorder.
// Everything here is made up.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { callEvent } from '../src/hikyaku/meeting.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const people = (count) => Array.from({ length: count }, (_, index) => `p${index}@example.edu`);
const calendarEvent = (count) => ({
  id: 'ev-1', title: 'Kickoff', start: '2026-10-08T10:00:00-04:00', end: '2026-10-08T11:00:00-04:00', allDay: false, calendar: 'Work',
  attendees: people(count), attendeeNames: Array.from({ length: count }, (_, index) => `Last${index}, First${index}`), location: 'Room 4',
});

test('callEvent maps a calendar event to the call event', () => {
  const event = callEvent(calendarEvent(2));
  assert.deepEqual(event, {
    title: 'Kickoff', start: '2026-10-08T10:00:00-04:00', end: '2026-10-08T11:00:00-04:00', id: 'ev-1', emails: ['p0@example.edu', 'p1@example.edu'],
    names: 'First0 Last0, First1 Last1', attendees: 'First0 Last0, First1 Last1', location: 'Room 4', source: 'calendar',
  });
});

test('callEvent turns Exchange\'s "Last, First" into the name people say, and keeps a suffix', () => {
  const event = callEvent({ ...calendarEvent(3), attendeeNames: ['Cartwright, Kaitlyn', 'Dana Wills', 'Smith, Jr.'] });
  assert.equal(event.names, 'Kaitlyn Cartwright, Dana Wills, Smith Jr.');
});

test('callEvent keeps every email and caps the names at 8', () => {
  const event = callEvent(calendarEvent(23));
  assert.equal(event.emails.length, 23);
  assert.equal(event.names.split(', ').length, 8);
  assert.equal(event.attendees, event.names);
  assert.equal(callEvent(calendarEvent(23), { maxNamed: 3 }).names.split(', ').length, 3);
});

test('callEvent copes with a bare event (the class armed from the calendar)', () => {
  const event = callEvent({ title: 'ABC 1234', start: '2026-10-08T10:00:00-04:00', end: '2026-10-08T11:00:00-04:00' });
  assert.deepEqual([event.emails, event.names, event.attendees, event.location, event.source], [[], '', '', '', 'calendar']);
});

test('a mic offer gives a title, the time now and no people', () => {
  const now = new Date('2026-10-08T14:00:00Z');
  assert.deepEqual(callEvent({ source: 'mic', title: 'Zoom call' }, { now }), { title: 'Zoom call', start: now.toISOString(), emails: [], names: '', attendees: '', source: 'mic' });
});

test('arm passes the full event', async () => {
  const source = await readFile(join(ROOT, 'bin', 'loggie.js'), 'utf8');
  assert.match(source, /call\('start', next\.title, JSON\.stringify\(callEvent\(next\)\)\)/);
  assert.match(source, /const \{ callEvent \} = await import\('\.\.\/src\/hikyaku\/meeting\.js'\)/);
});

// --- His calendar (meetings-granola-proposal.md c 1.4 to 1.6, 2026-10-27). The Oct 27 case with made-up names
// (test/fixtures/oct27-calendar.json): the school's Sage Hall block (MBA I, writable, nobody on it) named his M&T call.
// Read through the module object, so each test fails on its own where a rule does not exist yet.
import * as meeting from '../src/hikyaku/meeting.js';
const OCT27 = JSON.parse(await readFile(join(ROOT, 'test', 'fixtures', 'oct27-calendar.json'), 'utf8'));
const { SAGE, SAGE2, MT, MT2, PREENROLL, CLUB, WORK, OWN, CALENDARS, press: PRESS } = OCT27;
const DAY_LIST = [SAGE, SAGE2, MT2, MT, PREENROLL];
const minutesAfter = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();

test('1B isMine: he is on it (any calendar), or nobody is and its calendar is one he records from', () => {
  const mine = (event, options) => meeting.isMine(event, options);
  assert.deepEqual([SAGE, SAGE2, MT, MT2, PREENROLL, CLUB, WORK, OWN].map((event) => mine(event)), [false, false, true, true, false, false, false, true],
    'SAGE, SAGE2, PREENROLL, CLUB (school calendars) and WORK (the store default, off) are not his; MT, MT2 (invited) and OWN (his main calendar) are');
  assert.equal(mine(WORK, { recordCalendars: ['cal-icloud-work'] }), true, 'Work counts once he checks it');
  assert.equal(mine(OWN, { recordCalendars: ['cal-icloud-work'] }), false, 'a saved list is the whole list');
  assert.equal(mine(MT, { recordCalendars: [] }), true, 'an invite he accepted is his on any calendar, whatever the list');
  assert.equal(mine({ ...MT, myStatus: 'declined' }), false, 'a declined invite is not');
  assert.equal(mine({ ...CLUB, organizerIsMe: true }), true, 'a meeting he organized is his, even on the shared calendar');
  assert.equal(mine({ ...MT, myStatus: 'tentative' }) && mine({ ...MT2, myStatus: 'pending' }), true);
});

test('1B the default list: each account\'s main calendar, never the store default (his is iCloud Work), a shared, subscribed or holiday calendar', () => {
  assert.deepEqual(meeting.recordCalendarsOf(CALENDARS), ['cal-exchange-main', 'cal-google-me']);
  assert.deepEqual(meeting.recordCalendarsSaved({ recordCalendars: ['cal-icloud-work'] }), ['cal-icloud-work']);
  assert.equal(meeting.recordCalendarsSaved({}), null, 'none saved: the default rule');
});

test('1B a shared calendar\'s event is never offered; his copy wins the fold', () => {
  const at = minutesAfter(PRESS, 7);   // 15:05, every meeting in its window
  assert.equal(meeting.offerDecision({ candidates: meeting.candidates([SAGE, CLUB]), now: at }).offer, null, 'the club night on MBA I has people and a place, and is still not offered');
  const offer = meeting.offerDecision({ candidates: meeting.candidates([SAGE, MT2, MT, CLUB]), now: PRESS }).offer;
  assert.equal(offer.title, MT.title);
  assert.equal(offer.link_kind, 'teams', 'the Exchange copy with the join link');
  const theirs = { ...CLUB, id: 'club-theirs', attendees: [...CLUB.attendees, 'f@club.example'] };
  const his = { ...CLUB, id: 'club-his', calendar: 'Calendar', calendarId: 'cal-exchange-main', myStatus: 'accepted' };
  assert.equal(meeting.candidates([theirs, his])[0].event.id, 'club-his', 'his copy beats a copy with more people on it');
});

test('1C one pick rule for a typed press: his events only, the link first, then the app on the mic, then the nearest start', () => {
  const pick = (events, at, mic = []) => meeting.pickNow(meeting.candidates(events), at, mic)?.event.id ?? null;
  assert.equal(pick([SAGE, SAGE2, PREENROLL], PRESS), null, 'the school block never names a call: a mic call with the typed title');
  assert.equal(pick(DAY_LIST, PRESS), 'mt-exchange', 'two minutes before the start is in the window');
  assert.equal(pick([SAGE, WORK], minutesAfter(PRESS, 7)), null, 'a block with nobody on it is refused on a calendar he does not record from');
  assert.equal(pick([SAGE, OWN], minutesAfter(PRESS, 7)), 'own-block', 'and taken on one he does');
  const zoom = { ...MT, id: 'zoom-chat', title: 'Zoom chat', start: minutesAfter(MT.start, -1), location: 'https://example.zoom.us/j/123' };
  assert.equal(pick([zoom, MT], PRESS), 'zoom-chat', 'two links: the nearest start');
  assert.equal(pick([zoom, MT], PRESS, [{ bundle: 'com.microsoft.teams2', label: 'Teams' }]), 'mt-exchange', 'Teams on the mic: the Teams one');
  const meet = { ...zoom, id: 'meet-chat', location: 'https://meet.google.com/abc-defg-hij' };
  assert.equal(pick([meet, MT], PRESS, [{ bundle: 'com.google.Chrome', label: 'Chrome' }]), 'meet-chat', 'a browser counts for a Meet link');
});

test('1B a Google calendar named after its owner ("Jess Lu" on account "Google") is a main calendar by default', () => {
  const google = [
    { id: 'g-own', title: 'Ana Ito', account: 'Google', type: 'caldav', writable: true },
    { id: 'g-family', title: 'Family', account: 'Google', type: 'caldav', writable: true },
    { id: 'g-holidays', title: 'Holidays', account: 'Google', type: 'subscription', writable: false },
  ];
  meeting.setCalendarOwner(['Ana', 'Ana Ito']);
  try {
    assert.deepEqual(meeting.recordCalendarsOf(google), ['g-own']);
    assert.equal(meeting.isMine({ calendar: 'Ana Ito', calendarId: 'g-own', account: 'Google', calendarType: 'caldav', writable: true, attendees: [] }), true);
    assert.deepEqual(meeting.recordCalendarsOf(CALENDARS), ['cal-exchange-main', 'cal-google-me'], 'his own list is unchanged');
  } finally { meeting.setCalendarOwner([]); }
  assert.deepEqual(meeting.recordCalendarsOf(google), [], 'with no owner name known, nothing is guessed');
});
