import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { helperPath } from '../src/hikyaku/native-helper.js';
import { checkEvent, eventCommand, eventIcs, formatEvents, formatFree, freeSlots, googleEventLink, listEvents, openEvent, outlookEventLink, removeEvent, suggestTimes, wallTime, zonedTime } from '../src/hikyaku/calendar.js';

test('an event needs a title, a start with its time zone, real email addresses and a sane length', () => {
  const event = checkEvent({ title: ' Feedback chat ', start: '2026-10-02T13:00:00-04:00', attendees: ['dana@example.edu', 'jo@example.edu'] });
  assert.equal(event.title, 'Feedback chat');
  assert.equal(event.start.toISOString(), '2026-10-02T17:00:00.000Z');
  assert.equal(event.minutes, 30);
  assert.throws(() => checkEvent({ start: '2026-10-02T13:00:00-04:00' }), /needs a title/);
  assert.throws(() => checkEvent({ title: 'x', start: 'tomorrow at 1' }), /start time/);
  assert.throws(() => checkEvent({ title: 'x', start: '2026-10-02T13:00:00' }), /time zone/, 'no zone means Outlook guesses one');
  assert.throws(() => checkEvent({ title: 'x', start: '2026-10-02T13:00:00-04:00', attendees: ['Dana Brook'] }), /not email addresses: Dana Brook/);
  assert.throws(() => checkEvent({ title: 'x', start: '2026-10-02T13:00:00-04:00', minutes: 2 }), /minutes/);
});

test('the Outlook start is wall-clock time in the user\'s zone, never UTC (New Outlook ignores the offset)', () => {
  const start = new Date('2026-10-14T17:30:00-04:00');
  assert.equal(wallTime(start, 'America/New_York'), '2026-10-14T17:30:00');
  assert.equal(wallTime(start, 'Asia/Tokyo'), '2026-10-15T06:30:00');
});

test('opens Outlook\'s own new-event window with the title, people and start filled in, never sends', async () => {
  const link = outlookEventLink(checkEvent({ title: 'Chat: Gio & Jess', start: '2026-10-02T13:00:00-04:00', attendees: ['a@b.com', 'c@d.edu'] }), { timeZone: 'America/New_York' });
  assert.equal(link, 'ms-outlook://events/new?title=Chat%3A%20Gio%20%26%20Jess&start=2026-10-02T13%3A00%3A00&attendees=a%40b.com,c%40d.edu');

  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-event-'));
  const calls = [];
  const spawnImpl = (command, args) => { calls.push([command, ...args]); return { unref() {} }; };
  await assert.rejects(openEvent({ taskDirectory: dir, home: dir, spawnImpl }), /No EVENT.json/);
  await writeFile(join(dir, 'EVENT.json'), JSON.stringify({ title: 'Chat', start: '2026-10-02T13:00:00-04:00', attendees: ['a@b.com'] }));
  await openEvent({ taskDirectory: dir, home: dir, spawnImpl });
  assert.deepEqual(calls, [['open', 'ms-outlook://events/new?title=Chat&start=2026-10-02T13%3A00%3A00&attendees=a%40b.com']]);
});

test('the calendar app is a setting: Google Calendar and Apple Calendar get the event too, end time included', async () => {
  const event = checkEvent({ title: 'Chat; Gio, Jess', start: '2026-10-02T13:00:00-04:00', attendees: ['a@b.com', 'c@d.edu'], minutes: 45 });
  assert.equal(googleEventLink(event), 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Chat%3B+Gio%2C+Jess&dates=20261002T170000Z%2F20261002T174500Z&add=a%40b.com%2Cc%40d.edu');
  const ics = eventIcs(event, { uid: 'u1', now: new Date('2026-10-01T00:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nDTSTART:20261002T170000Z\r\nDTEND:20261002T174500Z\r\n/);
  assert.match(ics, /\r\nSUMMARY:Chat\\; Gio\\, Jess\r\n/, 'commas and semicolons are escaped');
  assert.match(ics, /\r\nDESCRIPTION:Invite: a@b.com\\, c@d.edu\r\n/, 'people ride in the notes, not as attendees, so Calendar opens it as the user\'s own event');
  assert.doesNotMatch(ics, /ATTENDEE/);

  assert.deepEqual(eventCommand({ calendarApp: 'outlook', event }), ['open', [outlookEventLink(event)]]);
  assert.deepEqual(eventCommand({ calendarApp: 'google-calendar', event }), ['open', [googleEventLink(event)]]);
  assert.deepEqual(eventCommand({ calendarApp: 'apple-calendar', event, icsPath: '/t/EVENT.ics' }), ['open', ['-a', 'Calendar', '/t/EVENT.ics']]);
  assert.throws(() => eventCommand({ calendarApp: 'sundial', event }), /Unknown calendar app "sundial"/);

  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-event-'));
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-home-'));
  const calls = [];
  const spawnImpl = (command, args) => { calls.push([command, ...args]); return { unref() {} }; };
  await writeFile(join(dir, 'EVENT.json'), JSON.stringify({ title: 'Chat', start: '2026-10-02T13:00:00-04:00', attendees: ['a@b.com'] }));
  assert.equal((await openEvent({ taskDirectory: dir, home, spawnImpl })).opened, 'outlook', 'Outlook when nothing is set');
  await writeFile(join(home, 'settings.json'), '{"mailApp": "outlook", "calendarApp": "apple-calendar"}');
  assert.equal((await openEvent({ taskDirectory: dir, home, spawnImpl })).opened, 'apple-calendar', 'drafts and invites switch separately');
  assert.deepEqual(calls[1], ['open', '-a', 'Calendar', join(dir, 'EVENT.ics')]);
  assert.match(await readFile(join(dir, 'EVENT.ics'), 'utf8'), /SUMMARY:Chat/);
});

test('reads and removes through the native helper, and passes its refusals through word for word', async () => {
  const seen = [];
  const execImpl = async (binary, args) => {
    seen.push(args);
    if (args[0] === 'remove') { const error = new Error('exit 5'); error.stderr = '"Karaoke" has other people on it. Cancel it in Outlook so they are told.\n'; throw error; }
    return { stdout: JSON.stringify([{ id: 'E1', title: 'LBO work', start: '2026-10-02T13:00:00Z', end: '2026-10-02T16:00:00Z', allDay: false, calendar: 'Work', attendees: [] }]) };
  };
  const events = await listEvents({ from: new Date('2026-10-02T04:00:00.250Z'), days: 1, execImpl, helper: '/bin/helper' });
  assert.deepEqual(seen[0], ['list', '2026-10-02T04:00:00Z', '2026-10-03T04:00:00Z'], 'whole seconds, which EventKit can parse');
  assert.equal(formatEvents(events, { timeZone: 'America/New_York' }), 'Fri, Oct 2 9:00 AM-12:00 PM  LBO work  [Work]  id=E1');
  await assert.rejects(removeEvent('E9', { execImpl, helper: '/bin/helper' }), /has other people on it/);
  await assert.rejects(removeEvent('', { execImpl, helper: '/bin/helper' }), /Usage/);
  assert.equal(formatEvents([]), 'Nothing on your calendars in that window.');
});

test('the helper is rebuilt only when its source is newer than the binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-helper-'));
  const source = join(dir, 'calendar.swift');
  const helper = join(dir, 'bin', 'hikyaku-calendar');
  await writeFile(source, '// swift');
  const builds = [];
  const execImpl = async (command, args) => { builds.push(command); await writeFile(args.at(-1), 'binary'); return { stdout: '' }; };
  await helperPath({ name: 'calendar', source, devHelper: helper, roots: [], packaged: false, execImpl });
  await helperPath({ name: 'calendar', source, devHelper: helper, roots: [], packaged: false, execImpl });
  assert.equal(builds.length, 1);
  const later = new Date(Date.now() + 60000);
  await utimes(source, later, later);
  await helperPath({ name: 'calendar', source, devHelper: helper, roots: [], packaged: false, execImpl });
  assert.equal(builds.length, 2);
  await assert.rejects(helperPath({ name: 'calendar', source, devHelper: join(dir, 'bin', 'other'), roots: [], packaged: false, execImpl: async () => { const e = new Error('x'); e.stderr = 'xcrun: error: no developer tools'; throw e; } }), /command line tools/);
});

test('free times are worked out by script: weekdays 9-5 Eastern, minus every timed event, all-day ignored', () => {
  assert.equal(zonedTime(2026, 10, 30, 9, 0, 'America/New_York').toISOString(), '2026-10-30T13:00:00.000Z', 'daylight time');
  assert.equal(zonedTime(2026, 11, 2, 9, 0, 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z', 'after clocks go back');
  const ev = (start, end, extra = {}) => ({ title: 'x', start, end, allDay: false, calendar: 'School', attendees: [], ...extra });
  const events = [
    ev('2026-10-05T13:00:00Z', '2026-10-05T14:30:00Z'),
    ev('2026-10-05T16:00:00Z', '2026-10-05T20:30:00Z'),
    ev('2026-10-05T20:45:00Z', '2026-10-05T21:00:00Z'),
    ev('2026-10-06T13:00:00Z', '2026-10-06T21:00:00Z', { calendar: 'Home' }),
    ev('2026-10-06T04:00:00Z', '2026-10-07T04:00:00Z', { allDay: true, title: 'Fall break' }),
    ev('2026-10-07T14:00:00Z', '2026-10-07T15:00:00Z'),
    ev('2026-10-07T14:30:00Z', '2026-10-07T16:00:00Z'),
    ev('2026-10-08T13:00:00Z', '2026-10-08T21:00:00Z', { calendar: 'School feed', writable: false, title: 'Career expo' }),
  ];
  const days = freeSlots(events, { from: new Date('2026-10-05T12:00:00Z'), days: 4 });
  const iso = (d) => d.toISOString().slice(11, 16);
  assert.deepEqual(days.map(({ day, windows }) => [day, windows.map((w) => `${iso(w.start)}-${iso(w.end)}`)]), [
    ['Mon 10/5', ['14:30-16:00']],
    ['Wed 10/7', ['13:00-14:00', '16:00-21:00']],
    ['Thu 10/8', ['13:00-21:00']],
  ], 'a 15-minute gap is too short; a fully booked Tuesday drops; overlapping events merge; a read-only feed does not block');
  assert.deepEqual(suggestTimes(days).map((d) => d.toISOString()), ['2026-10-05T14:30:00.000Z', '2026-10-07T13:00:00.000Z', '2026-10-08T13:00:00.000Z']);
  const odd = [{ windows: [{ start: new Date('2026-10-05T16:55:00Z'), end: new Date('2026-10-05T19:00:00Z') }] }, { windows: [{ start: new Date('2026-10-08T16:55:00Z'), end: new Date('2026-10-08T17:25:00Z') }] }];
  assert.deepEqual(suggestTimes(odd).map((d) => d.toISOString().slice(11, 16)), ['17:00', '16:55'], '12:55 becomes 1:00 when the meeting still fits, else stays exact');
  assert.deepEqual(freeSlots([], { from: new Date('2026-10-09T13:10:00Z'), days: 4 }).map((d) => d.day), ['Fri 10/9', 'Mon 10/12'], 'weekends skipped');
  assert.equal(freeSlots([], { from: new Date('2026-10-09T13:10:00Z'), days: 1 })[0].windows[0].start.toISOString(), '2026-10-09T13:30:00.000Z', 'never offers a time already past');
  const text = formatFree(days, events);
  assert.match(text, /Offer these:\n  Monday, Oct 5, 10:30 AM EDT/);
  const twice = formatFree([], [ev('2026-10-05T04:00:00Z', '2026-10-06T04:00:00Z', { allDay: true, title: 'DUE: case' }), ev('2026-10-05T04:00:00Z', '2026-10-06T04:00:00Z', { allDay: true, title: 'DUE: case', calendar: 'Calendar', account: 'Exchange' })]);
  assert.equal(twice.match(/DUE: case/g).length, 1, 'a deadline on two calendars is named once');
  assert.match(twice, /Calendars read: Calendar \(Exchange\), School\./, 'Outlook is named by its account');
  assert.match(text, /Calendars read: Home, School\. A meeting on a calendar not in this list is invisible here/);
  assert.match(text, /Read-only feeds, not counted as busy unless you're invited: School feed/);
  assert.equal(freeSlots([ev('2026-10-09T13:00:00Z', '2026-10-09T21:00:00Z', { writable: false, attendees: ['a@b.com'] })], { from: new Date('2026-10-09T12:00:00Z'), days: 1 }).length, 0, 'invited on a read-only calendar still blocks');
  assert.match(text, /All-day items \(not counted as busy\): Fall break/);
});

test('an invite may carry a short note into the event body; an offered time is used only when the calendar shows it free', async () => {
  const event = checkEvent({ title: 'Chat', start: '2026-10-09T13:00:00-04:00', attendees: ['sam@example.com'], note: `  Looking forward to it.${' x'.repeat(400)}` });
  assert.equal(event.note.length, 500);
  assert.match(outlookEventLink({ ...event, note: 'Looking forward to it.' }), /&body=Looking%20forward%20to%20it\.$/);
  assert.match(googleEventLink({ ...event, note: 'See you then.' }), /details=See\+you\+then\./);
  assert.equal(checkEvent({ title: 'Chat', start: '2026-10-09T13:00:00-04:00', attendees: [] }).note, '');
  const { headlessPrompt } = await import('../src/hikyaku/headless.js');
  assert.match(headlessPrompt('task_1'), /a time the person offered in the thread when CALENDAR\.md shows it free \(if it is busy there, ask in NEEDS\.md instead\)/);
});
