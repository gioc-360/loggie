// hikyaku's calendar: read and remove through macOS Calendar, add through the new-event window of the
// calendar app the user picked (settings.json calendarApp: outlook, google-calendar or apple-calendar).
// Adding only ever opens that window; the user stays the one who presses Send (and adds Zoom). Removing
// refuses meetings with other people on them: those are cancelled in the user's calendar app, so the
// attendees are told.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HIKYAKU_HOME, readSettings } from './draft.js';
import { helperPath } from './native-helper.js';

const run = promisify(execFile);
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'native', 'calendar.swift');
const HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-calendar');
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export const ensureHelper = (options = {}) => helperPath({ name: 'calendar', source: SOURCE, devHelper: HELPER, ...options });

async function helperCall(args, { execImpl = run, helper } = {}) {
  const binary = helper || await ensureHelper({ execImpl });
  try {
    const { stdout } = await execImpl(binary, args, { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const message = String(error.stderr || error.message).trim();
    // No calendar access is a switch only the user can flip: open that pane for them.
    if (/cannot read your calendars/.test(message)) {
      await (await import('./settings-panes.js')).openPane('calendars').catch(() => {});
      throw new Error('hikyaku cannot read your calendars yet. The Calendars settings are open: switch on the app running Loggie, then try again.');
    }
    throw new Error(message);
  }
}

export async function listEvents({ from = new Date(), days = 7, ...options } = {}) {
  const start = new Date(from);
  const end = new Date(start.getTime() + days * 86400000);
  // EventKit's ISO parser takes whole seconds only.
  const whole = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return helperCall(['list', whole(start), whole(end)], options);
}

// Every calendar this Mac syncs, for "Record from these calendars" (record-calendars.js, 2026-10-27):
// [{ id, title, account, type: local | caldav | exchange | subscription | birthday, writable, isDefault }].
export const listCalendars = (options = {}) => helperCall(['calendars'], options);

// Whether Loggie may read the calendar (the setup page, teammate-ready B5.2): the helper's `status`, which reads the
// answer macOS already has and never asks. granted, denied or unknown (not asked yet); any failure is unknown.
export async function calendarStatus(options = {}) {
  try {
    const { status } = await helperCall(['status'], options);
    return ['granted', 'denied', 'unknown'].includes(status) ? status : 'unknown';
  } catch { return 'unknown'; }
}

export async function removeEvent(id, options = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Usage: loggie calendar remove <event-id>   (ids come from loggie calendar)');
  return helperCall(['remove', id], options);
}

// What a person reads: one line per event, in their own time zone.
export function formatEvents(events, { timeZone } = {}) {
  if (!events.length) return 'Nothing on your calendars in that window.';
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  return events.map((event) => {
    const when = event.allDay ? `${day.format(new Date(event.start))}, all day` : `${day.format(new Date(event.start))} ${time.format(new Date(event.start))}-${time.format(new Date(event.end))}`;
    const people = event.attendees.length ? ` · with ${event.attendees.join(', ')}` : '';
    return `${when}  ${event.title}  [${event.calendar}${people}]  id=${event.id}`;
  }).join('\n');
}

// EVENT.json, written by the briefed agent and shown to the user before anything opens:
// { "title": "...", "start": "2026-10-02T13:00:00-04:00", "attendees": ["a@b.com"], "minutes": 30 }
export function checkEvent(raw) {
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new Error('EVENT.json needs a title.');
  const start = new Date(raw.start);
  // Date() alone accepts phrases like "tomorrow at 1"; only an ISO time with its zone is unambiguous.
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(String(raw.start || ''));
  if (!iso || Number.isNaN(start.getTime())) throw new Error('EVENT.json needs a start time with its time zone, like 2026-10-02T13:00:00-04:00.');
  const attendees = Array.isArray(raw.attendees) ? raw.attendees.map((item) => String(item).trim()) : [];
  const bad = attendees.filter((item) => !EMAIL.test(item));
  if (bad.length) throw new Error(`These are not email addresses: ${bad.join(', ')}`);
  const minutes = raw.minutes === undefined ? 30 : Number(raw.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) throw new Error('EVENT.json minutes must be a whole number from 5 to 480.');
  // An optional short note for the invite body ("Looking forward to it"), capped; the user still reads and sends it.
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : '';
  return { title: title.slice(0, 255), start, attendees, minutes, note };
}

// The wall-clock time in one zone, with no offset: "2026-10-14T17:30:00".
export function wallTime(date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// Outlook's link fills title, people and start. It does not take an end time: Outlook uses its own
// default length, so the caller must tell the user what to check. New Outlook reads the start as wall-clock time and
// ignores any offset: a UTC "...Z" start opened four hours late in New York (found 2026-10-08), so the start is sent
// as the user's own wall-clock time. New Outlook also ignores body=; the invite helper pastes the body instead.
export function outlookEventLink({ title, start, attendees, note = '' }, { timeZone } = {}) {
  const query = [
    `title=${encodeURIComponent(title)}`,
    `start=${encodeURIComponent(wallTime(start, timeZone))}`,
    ...(attendees.length ? [`attendees=${attendees.map(encodeURIComponent).join(',')}`] : []),
    ...(note ? [`body=${encodeURIComponent(note)}`] : []),
  ].join('&');
  return `ms-outlook://events/new?${query}`;
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Google's link takes the end time too, and adds the people as guests; the user presses Save there.
export function googleEventLink({ title, start, minutes, attendees, note = '' }) {
  const parameters = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${stamp(start)}/${stamp(new Date(start.getTime() + minutes * 60000))}` });
  if (attendees.length) parameters.set('add', attendees.join(','));
  if (note) parameters.set('details', note);
  return `https://calendar.google.com/calendar/render?${parameters}`;
}

// Apple Calendar has no new-event link, so it gets an .ics file to open. The people go in the notes, not as
// ATTENDEE lines: an imported event with attendees reads as an invitation the user received, not one to send.
export function eventIcs({ title, start, minutes, attendees }, { uid = randomUUID(), now = new Date() } = {}) {
  const text = (value) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Loggie//hikyaku//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + minutes * 60000))}`,
    `SUMMARY:${text(title)}`,
    ...(attendees.length ? [`DESCRIPTION:${text(`Invite: ${attendees.join(', ')}`)}`] : []),
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

export const CALENDAR_APPS = ['outlook', 'google-calendar', 'apple-calendar'];

export function eventCommand({ calendarApp, event, icsPath }) {
  if (calendarApp === 'outlook') return ['open', [outlookEventLink(event)]];
  if (calendarApp === 'google-calendar') return ['open', [googleEventLink(event)]];
  if (calendarApp === 'apple-calendar') return ['open', ['-a', 'Calendar', icsPath]];
  throw new Error(`Unknown calendar app "${calendarApp}". Use ${CALENDAR_APPS.join(', ')}.`);
}

export async function openEvent({ taskDirectory, home = HIKYAKU_HOME, spawnImpl = spawn }) {
  const raw = JSON.parse(await readFile(join(taskDirectory, 'EVENT.json'), 'utf8').catch(() => {
    throw new Error('No EVENT.json in this task folder yet. Write the event first and show it to the user.');
  }));
  const event = checkEvent(raw);
  const { calendarApp } = await readSettings(home);
  const icsPath = join(taskDirectory, 'EVENT.ics');
  const [command, args] = eventCommand({ calendarApp, event, icsPath });
  if (calendarApp === 'apple-calendar') await writeFile(icsPath, eventIcs(event));
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { ...event, opened: calendarApp };
}

// Free times to offer in a "can we meet" reply. Worked out here, not by the model: weekdays inside the
// user's meeting hours, minus the timed events that are the user's own: anything on a calendar they can
// write to, and anything they are invited to. Read-only feeds (a school's events calendar, Birthdays) list
// what is on offer, not what the user committed to, so they do not block; they are named in the output.
// All-day events do not block either (they are usually reminders or deadlines), and are named too.
// A timed event longer than 8 hours with no one invited is a marker, not a meeting: "FALL BREAK: NO CLASSES" runs
// Saturday to Tuesday 23:55 on the school calendar, "DEADLINE EXTENDED" 13:00-23:55 (seen 2026-10-09), and Cornell
// Homecoming Weekend 7 AM to 6 PM on Exchange; counting them as busy hid whole days. The rule lived only in the invite
// path (quick-invite.js) until loggie-availability D1 moved it here, for every path that reads free time.
export const MARKER_MS = 8 * 3600000;
export const isMarker = (event) => !(event.attendees || []).length && new Date(event.end) - new Date(event.start) > MARKER_MS;
export const blocksTime = (event) => !event.allDay && !isMarker(event) && (event.writable !== false || (event.attendees || []).length > 0);
const offsetMinutes = (date, timeZone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return (Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60000;
};

// The instant that reads as year-month-day hour:minute on a wall clock in timeZone.
export function zonedTime(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60000);
  return new Date(guess - offsetMinutes(first, timeZone) * 60000);
}

export function freeSlots(events, { from = new Date(), days = 7, minutes = 30, startHour = 9, endHour = 17, timeZone = 'America/New_York', weekends = false } = {}) {
  const busy = events.filter(blocksTime)
    .map((event) => [new Date(event.start).getTime(), new Date(event.end).getTime()])
    .sort((a, b) => a[0] - b[0]);
  const step = 30 * 60000;
  const now = Math.ceil(new Date(from).getTime() / step) * step;
  const dayParts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });
  const out = [];
  for (let offset = 0; offset < days; offset += 1) {
    const parts = Object.fromEntries(dayParts.formatToParts(new Date(new Date(from).getTime() + offset * 86400000)).map((part) => [part.type, part.value]));
    if (!weekends && (parts.weekday === 'Sat' || parts.weekday === 'Sun')) continue;
    let cursor = Math.max(zonedTime(+parts.year, +parts.month, +parts.day, startHour, 0, timeZone).getTime(), now);
    const close = zonedTime(+parts.year, +parts.month, +parts.day, endHour, 0, timeZone).getTime();
    const windows = [];
    for (const [start, end] of busy) {
      if (end <= cursor || start >= close) continue;
      if (start - cursor >= minutes * 60000) windows.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (close - cursor >= minutes * 60000) windows.push([cursor, close]);
    if (windows.length) out.push({ day: `${parts.weekday} ${parts.month}/${parts.day}`, windows: windows.map(([start, end]) => ({ start: new Date(start), end: new Date(end) })) });
  }
  return out;
}

// One suggestion per day, on the first three days with room: the earliest start that fits, moved to the
// next :00 or :30 when the window still holds the meeting from there (people offer 1:00, not 12:55).
export function suggestTimes(days, { count = 3, minutes = 30 } = {}) {
  const half = 30 * 60000;
  return days.slice(0, count).map(({ windows }) => {
    const fits = windows.find(({ start, end }) => Math.ceil(start.getTime() / half) * half + minutes * 60000 <= end.getTime());
    return fits ? new Date(Math.ceil(fits.start.getTime() / half) * half) : windows[0].start;
  });
}

export function formatFree(days, events, { minutes = 30, startHour = 9, endHour = 17, timeZone = 'America/New_York' } = {}) {
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  const when = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
  const label = (event) => (event.account && event.account !== event.calendar ? `${event.calendar} (${event.account})` : event.calendar);
  const calendars = [...new Set(events.filter((event) => event.writable !== false).map(label))].sort();
  const feeds = [...new Set(events.filter((event) => event.writable === false).map(label))].sort();
  const allDay = [...new Set(events.filter((event) => event.allDay).map((event) => event.title))];
  const hour = (h) => time.format(zonedTime(2026, 1, 5, h, 0, timeZone));
  const lines = [`Open for ${minutes} minutes, weekdays ${hour(startHour)}-${hour(endHour)} (${timeZone}):`];
  if (!days.length) lines.push('  none in this window');
  for (const { day, windows } of days) lines.push(`  ${day}: ${windows.map(({ start, end }) => `${time.format(start)}-${time.format(end)}`).join(', ')}`);
  const picks = suggestTimes(days, { minutes });
  if (picks.length) lines.push('', 'Offer these:', ...picks.map((start) => `  ${when.format(start)}`));
  lines.push('', `Calendars read: ${calendars.join(', ') || 'none had events'}. A meeting on a calendar not in this list is invisible here, so check Outlook before you send.`);
  if (feeds.length) lines.push(`Read-only feeds, not counted as busy unless you're invited: ${feeds.join(', ')}`);
  if (allDay.length) lines.push(`All-day items (not counted as busy): ${allDay.join(', ')}`);
  return lines.join('\n');
}
