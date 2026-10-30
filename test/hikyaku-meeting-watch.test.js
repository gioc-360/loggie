// Loggie offers to transcribe a calendar meeting (spec-c.md increment 12: B11, B12, B14, falsifiers F3 and F4). The
// decision is a pure function on an injected clock; the watcher polls a fake calendar and writes meeting.offered and
// meeting.answered into run folders; the answer handler is the ONLY place that starts a recording, and only on the
// user's "record" (F4). Everything here is made up: no calendar, no recorder, no clock, temp homes only, people at
// example.org. The 2-week fixture mirrors the shapes of spec-c.md B12 rows 1 to 11, not the real calendar.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { callEvent, candidateOf, candidates, isMeeting, MAX_MEETING_MINUTES, MAX_OFFER_PEOPLE, OFFER_BEFORE_S, offerDecision } from '../src/hikyaku/meeting.js';
import { createMeetingWatch, OFFER_TEXT } from '../src/hikyaku/meeting-watch.js';
import { checkEvents, NAMES_A_MODEL, readEvents, RUN_ID, TYPES } from '../src/hikyaku/events.js';
import { validateMeetingAnswer } from '../desktop/ipc-validation.js';
import { mainText } from './helpers/main-files.js';
import { sourcesUnder } from './helpers/files.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIN = 60000;
const DAY = 86400000;
const T0 = Date.parse('2026-10-01T04:00:00Z');   // the 2-week window starts here
const keyOf = (event) => `${event.title}|${event.start}`;

// --- the fixture: 139 unique events in the shapes of B12 rows 1 to 11, plus poorer raw copies of the Zoom chats
let nextId = 0;
const people = (count) => Array.from({ length: count }, (_, i) => `person${i}@example.org`);
const names = (count) => Array.from({ length: count }, (_, i) => `Person${i} Example`);
// The helper's 2026-10-27 fields too (meeting.js isMine): an invite he accepted, on his main calendar by default.
function timed(title, { day, hour, minutes = 60, people: count = 0, location = '', calendar = 'Calendar', account = 'me@example.org', writable = true,
  calendarType = 'exchange', isDefault = false, organizerIsMe = false, myStatus = count ? 'accepted' : null }) {
  const start = new Date(T0 + day * DAY + hour * 60 * MIN);
  return { id: `ev-${nextId++}`, title, start: start.toISOString(), end: new Date(start.getTime() + minutes * MIN).toISOString(), allDay: false, calendar,
    account, writable, attendees: people(count), attendeeNames: names(count), recurring: false, location,
    calendarId: `cal-${account}-${calendar}`, calendarType, isDefault, organizerIsMe, myStatus };
}
function allDay(title, day) {
  const start = new Date(T0 + day * DAY);
  return { ...timed(title, { day, hour: 0 }), allDay: true, start: start.toISOString(), end: new Date(start.getTime() + DAY).toISOString() };
}
const ZOOM = (n) => `https://example.zoom.us/j/${100000 + n}`;
const KICKOFF = timed('Strategy Kickoff', { day: 0, hour: 14, minutes: 60, people: 23, location: 'Room 333' });            // row 1
const ZOOMS = [1, 2, 3, 4, 5, 6, 7].map((n) => timed(`Zoom chat ${n}`, { day: n, hour: 15, people: n, location: n === 4 ? 'https://example.zoom.us/my/room' : ZOOM(n) }));   // row 2 (one link without /j/, FA 9.2)
const LBO = timed('LBO Model Review', { day: 2, hour: 17, minutes: 45, people: 3, location: 'Microsoft Teams Meeting' });   // row 3
const READOUTS = timed('Hackathon readouts', { day: 6, hour: 13, minutes: 50, people: 4, location: 'Breakout 2' });        // row 4
const SAM = timed('Chat with Sam', { day: 1, hour: 15, people: 1 });                                                        // row 5 and row 11: same start and end as Zoom chat 1
const GROUPS = [timed('Project group', { day: 3, hour: 18, people: 7 }), timed('Planning chat', { day: 4, hour: 18, people: 9 }), SAM,
  timed('Chat with Ana', { day: 8, hour: 12, people: 1 }), timed('co work', { day: 9, hour: 10, minutes: 100, people: 1 })];   // row 5
const BORROWED = timed('ABC 1234 project meeting', { day: 5, hour: 19, people: 3, location: ZOOM(555) });                    // row 8
const MEETINGS = [KICKOFF, ...ZOOMS, LBO, READOUTS, ...GROUPS, BORROWED];                                                      // 16
const TIMECARDS = [3, 10].map((day) => timed('Submit Timecard', { day, hour: 12, minutes: 30, people: 88 }));                 // row 6
const CLASSES = [...Array.from({ length: 14 }, (_, day) => timed('ABC 1234 Lecture', { day, hour: 9, location: 'Hall 101' })), timed('ABC 1234 Lecture', { day: 0, hour: 11, location: 'Hall 101' })];   // row 7
const BLOCKS = Array.from({ length: 97 }, (_, i) => timed(`Work block ${i}`, { day: i % 14, hour: 1 + Math.floor(i / 14), minutes: 30, location: i % 5 === 0 ? 'Zoom (Canvas)' : '' }));   // row 9
const ALL_DAY = Array.from({ length: 9 }, (_, day) => allDay(`Due ${day}`, day));                                             // row 10
const UNIQUE = [...MEETINGS, ...TIMECARDS, ...CLASSES, ...BLOCKS, ...ALL_DAY];
const POORER = ZOOMS.map((event) => ({ ...event, id: `${event.id}-work`, calendar: 'Work', attendees: [], attendeeNames: [], location: '' }));   // the same chat on a second calendar
const RAW = [...UNIQUE, ...POORER];

test('the fixture has the shape F3 names', () => {
  assert.equal(UNIQUE.length, 139);
  assert.equal(new Set(UNIQUE.map(keyOf)).size, 139);
  assert.equal(MEETINGS.length, 16);
  assert.equal(UNIQUE.filter((event) => event.attendees.length).length, 18);
  assert.equal(CLASSES.length, 15); assert.equal(BLOCKS.length, 97); assert.equal(ALL_DAY.length, 9);
  assert.equal(SAM.start, ZOOMS[0].start); assert.equal(SAM.end, ZOOMS[0].end);
});

// --- a fake calendar: the events that overlap the window asked for, as listEvents returns them
const fakeCalendar = (events = RAW) => async ({ from, days }) => {
  const low = new Date(from).getTime();
  const high = low + days * DAY;
  return events.filter((event) => Date.parse(event.end) > low && Date.parse(event.start) < high);
};

async function setup({ events = RAW, runner, listEvents, micOwners } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-meeting-watch-'));
  const clock = { at: T0 };
  const offers = [];
  const logs = [];
  const runs = [];
  const watch = createMeetingWatch({
    home, listEvents: listEvents || fakeCalendar(events), now: () => new Date(clock.at), onOffer: (offer) => offers.push(offer), log: (line) => logs.push(line),
    runner: runner || (async (command, args, options) => { runs.push({ command, args, options }); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', '2026-10-01-1000-strategy-kickoff')}\n`, stderr: '' }; }),
    transcriber: () => '/fake/transcriber/spike', loggieDirectory: '/fake/loggie', micOwners,
  });
  return { home, clock, offers, logs, runs, watch };
}
async function allEvents(home) {
  const out = [];
  for (const run of (await readdir(join(home, 'runs')).catch(() => [])).sort()) out.push(...await readEvents(join(home, 'runs', run)));
  return out;
}
// started: when the fake recorder began; a recording days old would rightly be asked "Done?" (no end known, 3600 s).
const recording = async (home, on, started = T0) => {
  await mkdir(join(home, 'calls'), { recursive: true });
  if (on) await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', '2026-10-01-1000-strategy-kickoff'), started: started / 1000 }));
  else await rm(join(home, 'calls', 'current.json'), { force: true });
};

// --- B11: candidate and dedupe, pure
test('candidateOf reads the link, the Teams marker, the place and the course code out of a calendar event', () => {
  const zoom = candidateOf(ZOOMS[3]);
  assert.equal(zoom.key, keyOf(ZOOMS[3]));
  assert.equal(zoom.link, 'https://example.zoom.us/my/room', 'any zoom.us URL is a link (FA 9.2)');
  assert.equal(zoom.place, null);
  assert.deepEqual([zoom.people, zoom.names.length, zoom.emails.length, zoom.minutes, zoom.teams, zoom.course, zoom.allDay], [4, 4, 4, 60, false, false, false]);
  const lbo = candidateOf(LBO);
  assert.deepEqual([lbo.link, lbo.teams, lbo.minutes], [null, true, 45]);
  const room = candidateOf(KICKOFF);
  assert.deepEqual([room.link, room.place, room.people], [null, 'Room 333', 23]);
  const mixed = candidateOf({ ...KICKOFF, location: 'Sage 333 https://teams.microsoft.com/l/meetup-join/19:abc' });
  assert.deepEqual([mixed.link, mixed.place], ['https://teams.microsoft.com/l/meetup-join/19:abc', 'Sage 333']);
  assert.equal(candidateOf({ ...KICKOFF, location: 'Zoom (Canvas)' }).link, null, 'a placeholder without zoom.us/ is not a link');
  assert.equal(candidateOf(BORROWED).course, true);
  assert.equal(candidateOf(ALL_DAY[0]).allDay, true);
  assert.equal(candidateOf(KICKOFF).event, KICKOFF, 'the full calendar event rides along for the click (B14)');
});

test('candidates folds the same event on several calendars into the copy with the most attendees, then the one with a link (FA 9.3)', () => {
  const folded = candidates(RAW);
  assert.equal(folded.length, 139);
  const chat = folded.find((candidate) => candidate.key === keyOf(ZOOMS[0]));
  assert.deepEqual([chat.people, chat.link], [1, ZOOM(1)], 'the poorer Work copy lost');
  const a = { ...KICKOFF, attendees: people(3), attendeeNames: names(3), location: '' };
  const b = { ...KICKOFF, attendees: people(3), attendeeNames: names(3), location: ZOOM(9), calendar: 'Work' };
  assert.equal(candidates([a, b])[0].link, ZOOM(9), 'a tie on people keeps the linked copy');
  assert.equal(candidates([b, a])[0].link, ZOOM(9));
  assert.equal(candidates([{ ...a, attendees: people(5), attendeeNames: names(5) }, b])[0].people, 5, 'more people beat a link');
});

// --- B12: isMeeting and offerDecision, pure
test('isMeeting follows the rows: a link, the Teams marker, or people within the limits; never a class, a reminder or an all-day item', () => {
  const meeting = (event) => isMeeting(candidateOf(event));
  for (const event of MEETINGS) assert.ok(meeting(event), `${event.title} is a meeting`);
  for (const event of [...TIMECARDS, ...CLASSES, ...BLOCKS, ...ALL_DAY]) assert.ok(!meeting(event), `${event.title} is not`);
  const crowd = (count, location) => ({ ...KICKOFF, attendees: people(count), attendeeNames: names(count), location });
  assert.ok(meeting(crowd(MAX_OFFER_PEOPLE + 5, 'Hall 101')), 'a crowd with a place is a meeting');
  assert.ok(!meeting(crowd(MAX_OFFER_PEOPLE + 5, '')), 'a crowd with no place is a reminder');
  assert.ok(meeting(crowd(MAX_OFFER_PEOPLE, '')), 'the limit itself still passes');
  const long = timed('Offsite', { day: 0, hour: 8, minutes: MAX_MEETING_MINUTES + 30, people: 2 });
  assert.ok(!meeting(long), 'longer than the limit with no link is a block');
  assert.ok(meeting({ ...long, location: ZOOM(1) }), 'a link wins over length');
  assert.ok(meeting({ ...long, end: new Date(Date.parse(long.start) + MAX_MEETING_MINUTES * MIN).toISOString() }), 'the limit itself still passes');
});

test('offerDecision: recording wins, then the live offer, then the best candidate in its window, else none', () => {
  const now = new Date(Date.parse(ZOOMS[0].start));
  const window = candidates([ZOOMS[0], SAM, KICKOFF]);
  const base = { candidates: window, now, recording: null, dismissed: new Set(), live: null, micApps: [] };
  assert.deepEqual(offerDecision({ ...base, recording: { call: 'x', startedAt: now.toISOString() } }), { offer: null, reason: 'recording' });
  const live = { offer_id: '20261002-150000-0001', key: keyOf(SAM), end: SAM.end };
  assert.deepEqual(offerDecision({ ...base, live }), { offer: live, reason: 'live' });
  assert.equal(offerDecision({ ...base, live: { ...live, end: now.toISOString() } }).offer.key, keyOf(ZOOMS[0]), 'a live offer whose meeting ended gives way');
  const first = offerDecision(base);
  assert.equal(first.reason, 'link');
  assert.deepEqual(first.offer, { source: 'calendar', key: keyOf(ZOOMS[0]), title: 'Zoom chat 1', start: ZOOMS[0].start, end: ZOOMS[0].end, people: 1, names: names(1), emails: people(1), place: null, link_kind: 'zoom', reason: 'link' });
  assert.equal(offerDecision({ ...base, dismissed: new Set([keyOf(ZOOMS[0])]) }).offer.key, keyOf(SAM), 'a dismissed key is skipped; the overlapping chat is next');
  assert.equal(offerDecision({ ...base, dismissed: new Set([keyOf(ZOOMS[0])]) }).reason, 'people');
  assert.deepEqual(offerDecision({ ...base, dismissed: new Set([keyOf(ZOOMS[0]), keyOf(SAM)]) }), { offer: null, reason: 'none' }, 'the kickoff is on another day');
  // the window: start - 120 s inclusive, end exclusive
  const early = new Date(Date.parse(ZOOMS[0].start) - OFFER_BEFORE_S * 1000);
  assert.equal(offerDecision({ ...base, now: early }).offer?.key, keyOf(ZOOMS[0]));
  assert.equal(offerDecision({ ...base, now: new Date(early.getTime() - 1000) }).offer, null);
  assert.equal(offerDecision({ ...base, now: new Date(Date.parse(ZOOMS[0].end)) }).offer, null);
  // ordering: link, then more people, then earlier start
  const same = (title, count, location, shift = 0) => ({ ...timed(title, { day: 0, hour: 10, people: count, location }), start: new Date(T0 + 10 * 60 * MIN + shift).toISOString() });
  const at = new Date(T0 + 10 * 60 * MIN + MIN);
  assert.equal(offerDecision({ ...base, now: at, candidates: candidates([same('Big', 9, ''), same('Linked', 2, ZOOM(2))]) }).offer.title, 'Linked');
  assert.equal(offerDecision({ ...base, now: at, candidates: candidates([same('Small', 2, ''), same('Big', 9, '')]) }).offer.title, 'Big');
  assert.equal(offerDecision({ ...base, now: at, candidates: candidates([same('Later', 2, '', MIN), same('Earlier', 2, '', 0)]) }).offer.title, 'Earlier');
  // the Teams marker and link kinds
  const teams = offerDecision({ ...base, now: new Date(Date.parse(LBO.start)), candidates: candidates([LBO]) });
  assert.deepEqual([teams.reason, teams.offer.link_kind, teams.offer.title], ['teams', 'marker', 'LBO Model Review']);
  assert.equal(offerDecision({ ...base, now: at, candidates: candidates([same('Meet', 1, 'https://meet.google.com/abc-defg-hij')]) }).offer.link_kind, 'meet');
  assert.equal(offerDecision({ ...base, now: at, candidates: candidates([same('Teams', 1, 'https://teams.live.com/meet/123')]) }).offer.link_kind, 'teams');
  // the mic signal (B13, empty in this increment) comes after every calendar candidate
  const mic = offerDecision({ ...base, candidates: [], micApps: [{ bundle: 'us.zoom.xos', label: 'Zoom', pid: 1 }] });
  assert.deepEqual([mic.reason, mic.offer.source, mic.offer.title, mic.offer.start], ['mic', 'mic', 'Zoom call', now.toISOString()]);
});

// --- the watcher over the 2 weeks (F3)
test('F3: over the 2-week fixture 15 of the 16 meetings are offered once each, nothing else is, every offer expires at its end, every event passes the contract', async () => {
  const state = await setup();
  for (let at = T0; at < T0 + 14 * DAY; at += MIN) { state.clock.at = at; await state.watch.poll(); }
  const offered = state.offers.map((offer) => offer.key);
  assert.equal(new Set(offered).size, offered.length, 'no key is offered twice');
  const meetings = MEETINGS.map(keyOf);
  const hit = meetings.filter((key) => offered.includes(key));
  assert.ok(hit.length >= 15, `${hit.length} of 16 meetings offered; missed: ${meetings.filter((key) => !offered.includes(key)).join('; ')}`);
  const stray = offered.filter((key) => !meetings.includes(key));
  assert.ok(stray.length <= 1, `offers on non-meetings: ${stray.join('; ')}`);
  assert.equal(state.offers.length, 15, 'row 11: the overlapping chat is folded into the linked one');
  assert.ok(offered.includes(keyOf(ZOOMS[0])) && !offered.includes(keyOf(SAM)));
  for (const offer of state.offers) assert.match(offer.offer_id, RUN_ID);
  // one run per offer: meeting.offered, then meeting.answered expired at the end of its window
  const events = await allEvents(state.home);
  const { ok, problems } = checkEvents(events);
  assert.ok(ok, problems.join('\n'));
  const runs = [...new Set(events.map((event) => event.run))];
  assert.equal(runs.length, 15);
  for (const run of runs) {
    const own = events.filter((event) => event.run === run);
    assert.deepEqual(own.map((event) => [event.type, event.data.answer ?? null, event.data.offer_id]), [['meeting.offered', null, run], ['meeting.answered', 'expired', run]]);
    assert.equal(own[0].data.expires, own[0].data.end);
    assert.equal(own[1].data.call, null);
  }
  for (const event of events) if (event.text !== null) assert.doesNotMatch(event.text, NAMES_A_MODEL);
  const lbo = events.find((event) => event.type === 'meeting.offered' && event.data.title === 'LBO Model Review');
  assert.ok(lbo, 'a title with a model word is offered: the title lives in data, never in text');
  assert.equal(lbo.text, OFFER_TEXT);
  assert.deepEqual([lbo.data.link_kind, lbo.data.people, lbo.data.emails.length, lbo.data.reason], ['marker', 3, 3, 'teams']);
  assert.equal(state.logs.length, 0);
});

test('nothing is offered while current.json exists; the offer comes once it is gone and the window is still open', async () => {
  const { home, clock, watch, offers } = await setup();
  clock.at = Date.parse(KICKOFF.start);
  await recording(home, true, clock.at);
  for (let i = 0; i < 5; i += 1) { clock.at += MIN; assert.equal((await watch.poll()).reason, 'recording'); }
  assert.deepEqual(offers, []);
  assert.deepEqual(await allEvents(home), []);
  await recording(home, false);
  clock.at += MIN;
  assert.equal((await watch.poll()).reason, 'people');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].key, keyOf(KICKOFF));
  assert.equal((await watch.poll()).reason, 'live', 'the same offer stays, no second one');
  assert.equal(offers.length, 1);
});

test('dismiss writes meeting.answered dismiss, the key never comes back, and no recording is touched', async () => {
  const { home, clock, watch, offers, runs } = await setup();
  clock.at = Date.parse(KICKOFF.start) - OFFER_BEFORE_S * 1000;
  await watch.poll();
  assert.equal(offers.length, 1);
  const answered = await watch.answer(offers[0].offer_id, 'dismiss');
  assert.deepEqual(answered, { offer_id: offers[0].offer_id, answer: 'dismiss', call: null });
  for (let at = clock.at; at < Date.parse(KICKOFF.end) + 10 * MIN; at += MIN) { clock.at = at; await watch.poll(); }
  assert.equal(offers.length, 1, 'a dismissed key is not offered again');
  assert.equal(runs.length, 0, 'dismiss never runs anything');
  const events = await allEvents(home);
  assert.deepEqual(events.map((event) => [event.type, event.data.answer ?? null]), [['meeting.offered', null], ['meeting.answered', 'dismiss']], 'no expired event after a dismiss');
  assert.ok(checkEvents(events).ok);
  await assert.rejects(watch.answer(offers[0].offer_id, 'dismiss'), /gone/, 'an answer to an offer no longer shown is refused');
});

test('record runs call.py start with the title and the full event JSON, waits, and writes meeting.answered with the call folder', async () => {
  const { home, clock, watch, offers, runs } = await setup();
  clock.at = Date.parse(KICKOFF.start);
  await watch.poll();
  const [offer] = offers;
  const answered = await watch.answer(offer.offer_id, 'record');
  assert.deepEqual(answered, { offer_id: offer.offer_id, answer: 'record', call: '2026-10-01-1000-strategy-kickoff' });
  assert.equal(runs.length, 1);
  const [{ command, args, options }] = runs;
  assert.equal(command, 'python3');
  assert.deepEqual(args.slice(0, 3), ['call.py', 'start', 'Strategy Kickoff']);
  assert.deepEqual(JSON.parse(args[3]), callEvent(KICKOFF), 'the FULL event: every email, names capped, location, source');
  assert.equal(JSON.parse(args[3]).emails.length, 23);
  assert.equal(options.cwd, '/fake/transcriber/spike');
  assert.equal(options.env.LOGGIE_DIR, '/fake/loggie');
  assert.equal(options.env.LOGGIE_HIKYAKU_HOME, home);
  assert.equal(options.timeout, 30000);
  const events = await allEvents(home);
  assert.deepEqual(events.map((event) => [event.type, event.data.answer ?? null, event.data.call ?? null]), [['meeting.offered', null, null], ['meeting.answered', 'record', '2026-10-01-1000-strategy-kickoff']]);
  assert.ok(checkEvents(events).ok);
  // the offer is gone: a second click runs nothing; while the recording runs, nothing new is offered
  await assert.rejects(watch.answer(offer.offer_id, 'record'), /gone/);
  assert.equal(runs.length, 1);
  await recording(home, true);
  clock.at += MIN;
  assert.equal((await watch.poll()).reason, 'recording');
  assert.equal(offers.length, 1);
  await assert.rejects(watch.answer('20261001-100000-ffff', 'record'), /gone/, 'an unknown offer id runs nothing');
  await assert.rejects(watch.answer(offer.offer_id, 'maybe'), /record or dismiss/);
  assert.equal(runs.length, 1);
});

test('a start that fails writes meeting.answered with call null and returns the last line as the error', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: 'Traceback\nAlready recording: /x/calls/2026-10-01-0900-other\n' });
  const { home, clock, watch, offers } = await setup({ runner });
  clock.at = Date.parse(KICKOFF.start);
  await watch.poll();
  await assert.rejects(watch.answer(offers[0].offer_id, 'record'), /^Error: Already recording: \/x\/calls\/2026-10-01-0900-other$/);
  const events = await allEvents(home);
  assert.deepEqual(events.at(-1).data, { offer_id: offers[0].offer_id, answer: 'record', call: null });
  assert.ok(checkEvents(events).ok);
});

test('a calendar that cannot be read is logged once, offers nothing, and the watcher keeps polling', async () => {
  let fails = 0;
  const listEvents = async () => { fails += 1; throw new Error('hikyaku cannot read your calendars yet.'); };
  const { clock, watch, offers, logs } = await setup({ listEvents });
  clock.at = Date.parse(KICKOFF.start);
  for (let i = 0; i < 3; i += 1) { clock.at += MIN; assert.equal((await watch.poll()).reason, 'none'); }
  assert.equal(fails, 3);
  assert.equal(logs.length, 1, 'logged once');
  assert.match(logs[0], /cannot read your calendars/);
  assert.deepEqual(offers, []);
});

test('start polls every 60 s through the injected timer and stop clears it', async () => {
  const timers = [];
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-meeting-watch-'));
  let polls = 0;
  const watch = createMeetingWatch({ home, listEvents: async () => { polls += 1; return []; }, now: () => new Date(T0),
    setIntervalImpl: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearIntervalImpl: (timer) => { timer.cleared = true; } });
  const stop = watch.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(polls, 1, 'one poll right away');
  assert.deepEqual(timers.map((timer) => timer.ms), [60000]);
  await timers[0].fn();
  assert.equal(polls, 2);
  stop();
  assert.equal(timers[0].cleared, true);
});

test('the IPC answer is validated: an offer id that is a run id, and record or dismiss', () => {
  assert.deepEqual(validateMeetingAnswer('20261001-100000-abcd', 'record'), { offerId: '20261001-100000-abcd', answer: 'record' });
  assert.deepEqual(validateMeetingAnswer('20261001-100000-abcd', 'dismiss'), { offerId: '20261001-100000-abcd', answer: 'dismiss' });
  assert.throws(() => validateMeetingAnswer('../x', 'record'), /not an offer/);
  assert.throws(() => validateMeetingAnswer('20261001-100000-abcd', 'start'), /record or dismiss/);
  assert.throws(() => validateMeetingAnswer('20261001-100000-abcd', null), /record or dismiss/);
});

test('the contract has the two meeting types, and main.js and preload wire the watcher and the answer', async () => {
  assert.deepEqual(TYPES['meeting.offered'], ['offer_id', 'source', 'key', 'title', 'start', 'end', 'people', 'names', 'emails', 'place', 'link_kind', 'reason', 'expires']);
  assert.deepEqual(TYPES['meeting.answered'], ['offer_id', 'answer', 'call']);
  const main = await mainText();
  const preload = await readFile(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
  assert.match(main, /handleSecure\('hikyaku:meeting-answer', async \(offerId, answer\)/);
  assert.match(main, /validateMeetingAnswer\(offerId, answer\)/);
  assert.match(main, /startMeetingWatch\(\)/);
  assert.match(preload, /meetingAnswer: \(offerId, answer\) => ipcRenderer\.invoke\('hikyaku:meeting-answer', offerId, answer\)/);
  assert.doesNotMatch(main, /new Notification\(/, 'no surface in this increment (16 decides it)');
  const docs = await readFile(join(ROOT, 'docs', 'hikyaku-events.md'), 'utf8');
  assert.match(docs, /`meeting\.offered`/); assert.match(docs, /`meeting\.answered`/); assert.match(docs, /meetingAnswer\(offerId, answer\)/);
  assert.doesNotMatch(docs, /^`ask\.sent`.*`call\.record`/m, 'call.record left the proposed list');
});

// --- F4: never auto-record. The only spawn of call.py under src/ and desktop/ sits in the answer handler, after the
// record check. Comments are stripped first, so a mention in prose does not count and a spawn cannot hide in one.
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('Record from the tab: a press starts call.py with a mic event and the panel\'s title, or with the calendar event happening now', async () => {
  const { home, clock, watch, runs } = await setup({ events: [KICKOFF] });
  clock.at = Date.parse(KICKOFF.start) - 3 * 3600 * 1000;
  const bare = await watch.startManual('Meeting 7:00 AM');
  assert.equal(bare.title, 'Meeting 7:00 AM');
  assert.deepEqual(runs[0].args.slice(0, 3), ['call.py', 'start', 'Meeting 7:00 AM']);
  assert.equal(JSON.parse(runs[0].args[3]).source, 'mic');
  await recording(home, true);
  await assert.rejects(watch.startManual('Meeting 7:01 AM'), /already recording/);
  assert.equal(runs.length, 1);
  await recording(home, false);
  clock.at = Date.parse(KICKOFF.start) + 5 * MIN;
  await watch.poll();
  const offered = watch.state.live;
  const during = await watch.startManual('Meeting 10:05 AM');
  assert.equal(runs.at(-1).args[2], 'Strategy Kickoff', 'the offer on screen is answered as Transcribe');
  assert.equal(during.offer_id, offered.offer_id);
  assert.equal(watch.state.live, null);
});

test('Record with the meeting\'s workspace: it rides into the call\'s event, so the call is filed from its first second', async () => {
  const { clock, watch, runs } = await setup({ events: [KICKOFF] });
  clock.at = Date.parse(KICKOFF.start) - 3 * 3600 * 1000;
  await watch.startManual('Coffee chat with Sam', { workstream: 'Bank Offer' });
  assert.equal(JSON.parse(runs[0].args[3]).workstream, 'Bank Offer');
});

test('F4: no code path starts a recording without the user\'s record answer', async () => {
  const files = [...await sourcesUnder(join(ROOT, 'src')), ...await sourcesUnder(join(ROOT, 'desktop'))];
  const hits = [];
  for (const file of files) {
    // A recording starts or stops only through call.py start or stop; call.py prepare (screening a call again) records nothing.
    const count = (stripComments(await readFile(file, 'utf8')).match(/'call\.py', '(?:start|stop)'/g) || []).length;
    if (count) hits.push([relative(ROOT, file), count]);
  }
  assert.deepEqual(hits, [['src/hikyaku/meeting-watch.js', 3]], 'call.py is named in exactly three places: start in the answer handler, start on the Record press (startManual), stop in the end answer (hikyaku-meeting-end.test.js holds the stop side)');
  // The Record press (loggie-meetings-tab) is the user's own answer: startManual is reached only from its IPC handler.
  const main = stripComments(await mainText());
  assert.equal((main.match(/startManual\(/g) || []).length, 1, 'one caller of startManual');
  const press = main.indexOf("'hikyaku:record-start'");
  // 400: Record both's second id is checked before the start too (2026-10-28).
  assert.ok(press >= 0 && main.indexOf('startManual(', press) - press < 400, 'and it is the Record handler');
  const code = stripComments(await readFile(join(ROOT, 'src', 'hikyaku', 'meeting-watch.js'), 'utf8'));
  const from = code.indexOf('async function answerOffer');
  assert.ok(from >= 0, 'the answer handler is a named function');
  const handler = code.slice(from, code.indexOf('\n  }\n', from) + 5);
  assert.ok(handler.includes('call.py'), 'the one spawn is inside the answer handler');
  const guard = handler.indexOf("answer !== 'record'");
  assert.ok(guard >= 0 && guard < handler.indexOf('call.py'), 'the record check comes before the spawn');
  const pollFrom = code.indexOf('async function poll');
  const poll = code.slice(pollFrom, code.indexOf('\n  }\n', pollFrom));
  assert.ok(pollFrom >= 0 && !/runner\(|spawn|execFile|exec\(/.test(poll), 'the poll runs nothing');
});

// --- B13: an app holding the mic with no invite gets the same offer, after 10 s, and only an offer
const mic = (...using) => ({ at: 'now', using_mic: using.map(([bundle, pid]) => ({ bundle, pid })) });
const NO_CALENDAR = { events: [] };

test('mic: an allowed app holding the mic for 10 s is offered as "Zoom call", and record hands call.py the mic event', async () => {
  const owners = { now: mic(['us.zoom.xos', 11], ['com.apple.CoreSpeech', 12]) };
  const { home, clock, watch, offers, runs } = await setup({ ...NO_CALENDAR, micOwners: async () => owners.now });
  await watch.poll();
  clock.at += 5000; await watch.poll();
  assert.equal(offers.length, 0, 'not yet 10 s');
  clock.at += 5000; await watch.poll();
  assert.equal(offers.length, 1);
  assert.deepEqual([offers[0].source, offers[0].title, offers[0].reason, offers[0].end], ['mic', 'Zoom call', 'mic', null]);
  clock.at += 60000; await watch.poll();
  assert.equal(offers.length, 1, 'a mic offer with no end stays until answered, and is not offered twice');
  assert.equal(runs.length, 0, 'the mic path only offers');
  await watch.answer(offers[0].offer_id, 'record');
  assert.equal(runs.length, 1);
  assert.deepEqual(JSON.parse(runs[0].args[3]), callEvent({ source: 'mic', title: 'Zoom call' }, { now: new Date(clock.at) }));
  assert.ok(checkEvents(await allEvents(home)).ok);
});

test('mic: the recorder pid (current.json), dictation and an empty bundle never fire, and a recording in progress blocks the offer', async () => {
  const { home, clock, watch, offers, logs } = await setup({ ...NO_CALENDAR, micOwners: async () => mic(['com.apple.CoreSpeech', 1], ['', 5], ['us.zoom.xos', 4242]) });
  await recording(home, true);
  for (let i = 0; i < 6; i += 1) { await watch.poll(); clock.at += 5000; }
  assert.equal(offers.length, 0, 'the recorder pid and the ignored apps never fire');
  assert.deepEqual(watch.state.micApps, [], 'the recorder pid is not an app even while it holds the mic');
  assert.deepEqual(logs, []);
});

test('mic: a dismissed app is not offered while it holds the mic, and is offered again after it lets go', async () => {
  const owners = { now: mic(['com.google.Chrome', 9]) };
  const { clock, watch, offers } = await setup({ ...NO_CALENDAR, micOwners: async () => owners.now });
  await watch.poll(); clock.at += 10000; await watch.poll();
  assert.equal(offers[0].title, 'Chrome call');
  await watch.answer(offers[0].offer_id, 'dismiss');
  clock.at += 30000; await watch.poll();
  assert.equal(offers.length, 1);
  owners.now = mic();
  clock.at += 5000; await watch.poll();
  owners.now = mic(['com.google.Chrome', 9]);
  clock.at += 5000; await watch.poll(); clock.at += 10000; await watch.poll();
  assert.equal(offers.length, 2);
});

test('mic: a calendar meeting in its window wins over the mic, and a failing helper logs once and never blocks calendar offers', async () => {
  const { clock, watch, offers, logs } = await setup({ micOwners: async () => { throw new Error('no audio service'); } });
  clock.at = Date.parse(KICKOFF.start);
  await watch.poll(); clock.at += 5000; await watch.poll();
  assert.equal(offers.length, 1);
  assert.equal(offers[0].source, 'calendar');
  assert.equal(logs.filter((line) => /mic/.test(line)).length, 1, 'logged once');
  const withMic = await setup({ micOwners: async () => mic(['us.zoom.xos', 1]) });
  withMic.clock.at = Date.parse(KICKOFF.start);
  await withMic.watch.poll(); withMic.clock.at += 10000; await withMic.watch.poll();
  assert.deepEqual(withMic.offers.map((offer) => offer.source), ['calendar']);
});

test('mic: with micOwners given, start also polls every 5 s through the injected timer, without reading the calendar again', async () => {
  const timers = [];
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-meeting-watch-'));
  let calendar = 0;
  let owners = 0;
  const watch = createMeetingWatch({ home, listEvents: async () => { calendar += 1; return []; }, micOwners: async () => { owners += 1; return mic(); }, now: () => new Date(T0),
    setIntervalImpl: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearIntervalImpl: (timer) => { timer.cleared = true; } });
  const stop = watch.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(timers.map((timer) => timer.ms), [60000, 5000]);
  await timers[1].fn();
  assert.deepEqual([calendar, owners], [1, 2]);
  stop();
  assert.deepEqual(timers.map((timer) => timer.cleared), [true, true]);
});

// --- The Oct 27 case, made-up names (test/fixtures/oct27-calendar.json, meetings-granola-proposal.md c 1.6). At 14:58:07
// Record was pressed on the Day card for the Teams meeting starting at 15:00, before the 14:58:08 poll offered it; the
// school's Sage Hall block (MBA I, writable, nobody on it, running since 14:30) named the call.
const OCT27 = JSON.parse(await readFile(join(ROOT, 'test', 'fixtures', 'oct27-calendar.json'), 'utf8'));
const { SAGE, SAGE2, MT, MT2, PREENROLL, WORK, OWN } = OCT27;
const OCT27_DAY = [SAGE, SAGE2, MT2, MT, PREENROLL];

test('1A the card hands its event id: Record on the Teams meeting records it, not the block running now', async () => {
  const { clock, watch, runs } = await setup({ events: OCT27_DAY });
  clock.at = Date.parse(OCT27.press);
  // The Day view shows the Google copy (the first with people on it); the press folds to the copy with the Teams link.
  const started = await watch.startManual(MT.title, { eventId: MT2.id });
  assert.equal(runs[0].args[2], MT.title, 'the title on the card is the title he gets');
  const event = JSON.parse(runs[0].args[3]);
  assert.deepEqual([event.start, event.end, event.emails, event.source, event.id], [MT.start, MT.end, MT.attendees, 'calendar', MT.id]);
  assert.match(event.location, /teams\.microsoft\.com/);
  assert.equal(started.title, MT.title);
  assert.ok(watch.state.dismissed.has(`${MT.title}|${MT.start}`), 'its offer is not made after the press');
});

test('1A a row on the shared calendar is his pick, and an offer for another meeting goes', async () => {
  const { home, clock, watch, runs } = await setup({ events: OCT27_DAY });
  clock.at = Date.parse(OCT27.press) + 5000;
  await watch.poll();
  const offered = watch.state.live;
  assert.equal(offered.title, MT.title, 'the M&T offer is on screen');
  await watch.startManual(SAGE.title, { eventId: SAGE.id });
  assert.equal(runs.at(-1).args[2], SAGE.title, 'he pressed Record on the Sage Hall row himself');
  assert.equal(watch.state.live, null);
  const answered = (await allEvents(home)).filter((event) => event.type === 'meeting.answered').map((event) => event.data);
  assert.deepEqual(answered, [{ offer_id: offered.offer_id, answer: 'dismiss', call: null }]);
});

test('1C a typed press: a school block never names the call, his own block on his main calendar does, Work does not', async () => {
  const first = await setup({ events: [SAGE, SAGE2, PREENROLL] });
  first.clock.at = Date.parse(OCT27.press);
  await first.watch.poll();
  await first.watch.startManual('Meeting 2:58 PM');
  assert.equal(first.runs[0].args[2], 'Meeting 2:58 PM');
  assert.equal(JSON.parse(first.runs[0].args[3]).source, 'mic');
  const later = Date.parse(OCT27.press) + 7 * MIN;
  const own = await setup({ events: [SAGE, OWN] });
  own.clock.at = later;
  await own.watch.poll();
  await own.watch.startManual('Meeting 3:05 PM');
  assert.equal(own.runs[0].args[2], OWN.title);
  const work = await setup({ events: [SAGE, WORK] });
  work.clock.at = later;
  await work.watch.poll();
  await work.watch.startManual('Meeting 3:05 PM');
  assert.equal(work.runs[0].args[2], 'Meeting 3:05 PM', 'Work is off by default (Gio, version b)');
});

test('1B the watch reads his calendar list each poll: Work checked, its block names a typed press', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-meeting-watch-'));
  const runs = [];
  const watch = createMeetingWatch({ home, listEvents: fakeCalendar([SAGE, WORK]), now: () => new Date(Date.parse(OCT27.press) + 7 * MIN), recordCalendars: async () => [WORK.calendarId],
    runner: async (command, args) => { runs.push(args); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', 'x')}\n`, stderr: '' }; }, transcriber: () => '/fake' });
  await watch.poll();
  await watch.startManual('Meeting 3:05 PM');
  assert.equal(runs[0][2], WORK.title);
});
