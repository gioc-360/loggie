// Free times in an email, from the calendar on this Mac (loggie-availability I1, docs/availability/spec.md). "email
// rowena my availability friday": code sees that times are asked (availabilityAsked), reads which days and hours
// (readWindow), reads the calendar once (availabilityFor), and after the cloud AI has written the email with only
// "[your times]" in it, writes the free ranges there (fillTimes), one line per day, the zone named once. The model never
// sees a slot, a time, a day of the block or an event: the times are code, so a time the calendar forbids is never
// offered. A calendar that cannot be read keeps "[your times]" and says why; it is never read as all free.
//
//   availabilityAsked({ typed, line, email }) -> 'typed' | 'thread' | null
//   readWindow({ typed, email, emailAt, now, settings }) -> Window   (pure, never throws)
//   availabilitySettings(raw, { macZone }) -> Resolved;  availabilityView(raw, { macZone })
//   saveAvailability(home, patch, { macZone, readImpl, writeImpl }) -> view: the five Settings rows (I3)
//   availabilityFor({ window, settings, eventsImpl, statusImpl, now, timeoutMs }) -> Promise<Availability>, never rejects
//   formatAvailability(days, { timeZone }), zoneLabel, daysLabel, hoursLabel
//   fillTimes(body, availability, { signName }), strayTimes(text, days, { skip, timeZone })
//   availabilityReport(...) -> { note, did, record }: what the ask says and saves (spec 1.8, 1.9)
//   askAvailability({ home, ... }) -> the app's readers for the ask box: { events, status, availability }
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { blocksTime, calendarStatus, freeSlots, listEvents, zonedTime } from './calendar.js';
import { HIKYAKU_HOME, readSettings } from './draft.js';
import { readRawSettings } from './setup-status.js';
import { PLACEHOLDER, timesIn } from './draft-times.js';
import { DAY, PATTERNS } from './wordmap.js';

const MINUTE = 60000;
const QUARTER = 15 * MINUTE;
const NOTICE = 60;
const MAX_AHEAD = 60;
const MAX_DAYS = 10;
const macZoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---- 1.1 the cue ----
const CUE = [
  '(?:your|his|her|their) availability',
  '(?:when|what times?|which times?|what days?) (?:are|is|would|works?|work|suits?|might) (?:you|best|good|for you)',
  'times? (?:that )?(?:works?|suits?) (?:for|best)',
  'time ?slots?',
  '(?:a couple|a few|some) (?:of )?(?:times|slots|options)',
  '(?:find|share|send|suggest|propose|offer) (?:a |some |a few |your )?(?:times?|slots?)',
  'when (?:are|is) (?:you|she|he|they) free',
  '(?:am|are|is) (?:you |i )?free (?:on|this|next|tomorrow|today|for a|for an)',
  'free (?:times?|slots?)',
  'open (?:times?|slots?)',
];
export const THREAD_CUE = new RegExp(`\\b(?:${CUE.join('|')})\\b`, 'i');
export const TYPED_CUE = new RegExp(`\\b(?:${CUE.join('|')}|availability|available)\\b`, 'i');

// Only the email being answered counts, never older messages in its thread; bare "availability" only in the user's own
// words (309 stock notices in 120 days of Inbox said it).
// An email that proposes a set time ("Are you available on Tuesday, 10/27 at 3PM EST?") is answered by confirming it:
// no free ranges, unless the user's own words ask to offer other times (loggie-reply-yes: the M&T reply got "4 to
// 4:45pm" under a note that said yes to 3 PM).
export function availabilityAsked({ typed = '', line = '', email = '' } = {}) {
  const text = (value) => (typeof value === 'string' ? value : '');
  const other = OTHER_TIMES.test(text(typed)) || OTHER_TIMES.test(text(line));
  if (proposesTime(text(email))) return other ? 'typed' : null;
  if (other || TYPED_CUE.test(text(typed)) || TYPED_CUE.test(text(line))) return 'typed';
  if (THREAD_CUE.test(text(email))) return 'thread';
  return null;
}

// A set time: one or two clock times (or one range) on a named day or date, in the email being answered.
const PROPOSED_DAY = new RegExp(`\\b(?:${DAY})\\b|\\b\\d{1,2}/\\d{1,2}\\b|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}\\b|\\b(?:today|tomorrow)\\b`, 'i');
export function proposesTime(email = '') {
  const times = timesIn(String(email || ''));
  return times.length >= 1 && times.length <= 2 && PROPOSED_DAY.test(String(email || ''));
}
// The user's words asking to offer other times than the one proposed.
const OTHER_TIMES = /\b(?:other|another|different|alternative|more|a few|some)\s+(?:times?|slots?|options?|days?)\b|\b(?:my|some)\s+(?:availability|free times?)\b|\bwhen\s+i(?:'m| am)\s+free\b|\bdoesn'?t work\b|\bcan'?t (?:do|make)\b/i;

// The rule the cloud AI gets when times are asked: it leads in, and leaves the line for code.
export const TIMES_RULE = 'The user is telling this person when they are free. Loggie adds the days and times from the user\'s calendar on this Mac. Write no clock time, time range, date or day name anywhere in the email. Write one short sentence that leads into the times, then a line that holds exactly [your times] and nothing else, then the rest of the email.';

// ---- days and clocks in one zone ----
function partsOf(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return { key: `${parts.year}-${parts.month}-${parts.day}`, minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}
const dayKey = (date, timeZone) => partsOf(date, timeZone).key;
const minuteOf = (date, timeZone) => partsOf(date, timeZone).minute;
const keyDate = (key) => new Date(`${key}T12:00:00Z`);
const addDays = (key, n) => new Date(keyDate(key).getTime() + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 86400000);
const weekdayOf = (key) => keyDate(key).getUTCDay();
const isWeekday = (key) => weekdayOf(key) >= 1 && weekdayOf(key) <= 5;
const atMinute = (key, minute, timeZone) => {
  const [y, m, d] = key.split('-').map(Number);
  return zonedTime(y, m, d, Math.floor(minute / 60), minute % 60, timeZone);
};
const ceil15 = (ms) => Math.ceil(ms / QUARTER) * QUARTER;
const floor15 = (ms) => Math.floor(ms / QUARTER) * QUARTER;

// Today's hours are over when the first start Loggie may offer (an hour's notice, on a quarter hour) leaves no room.
function hoursOver(now, timeZone, endMinute, minutes) {
  const first = new Date(ceil15(now.getTime() + NOTICE * MINUTE));
  if (dayKey(first, timeZone) !== dayKey(now, timeZone)) return true;
  return minuteOf(first, timeZone) + minutes > endMinute;
}

// ---- 1.3 the rules and their defaults ----
const ZONES = () => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []);
const validZone = (zone) => typeof zone === 'string' && (zone === 'UTC' || ZONES().includes(zone));
const int = (value, lo, hi) => Number.isInteger(value) && value >= lo && value <= hi;
// Valid values are exactly what the Settings rows offer (spec 1.3); desktop/ipc-validation.js checks a patch with them.
export const AVAILABILITY_VALID = Object.freeze({
  startHour: (v) => int(v, 6, 12),
  endHour: (v) => int(v, 12, 22),
  timeZone: validZone,
  minMinutes: (v) => [15, 30, 45, 60, 90].includes(v),
  daysAhead: (v) => int(v, 1, 10),
  selfBlocks: (v) => typeof v === 'boolean',
});
const VALID = AVAILABILITY_VALID;
const HOUR_KEYS = ['startHour', 'endHour', 'timeZone'];
const RULE_KEYS = ['minMinutes', 'daysAhead', 'selfBlocks'];

function storedOf(raw) {
  const hours = raw && typeof raw.meetingHours === 'object' && raw.meetingHours ? raw.meetingHours : {};
  const rules = raw && typeof raw.availability === 'object' && raw.availability ? raw.availability : {};
  const stored = {};
  for (const key of HOUR_KEYS) if (VALID[key](hours[key])) stored[key] = hours[key];
  for (const key of RULE_KEYS) if (VALID[key](rules[key])) stored[key] = rules[key];
  return stored;
}

export function availabilitySettings(raw = {}, { macZone = macZoneNow() } = {}) {
  const stored = storedOf(raw);
  let startHour = stored.startHour ?? 9;
  let endHour = stored.endHour ?? 17;
  if (endHour <= startHour) endHour = 17;
  if (endHour <= startHour) { startHour = 9; endHour = 17; }
  return {
    startHour, endHour, timeZone: stored.timeZone ?? (validZone(macZone) ? macZone : 'UTC'),
    minMinutes: stored.minMinutes ?? 30, daysAhead: stored.daysAhead ?? 5, selfBlocks: stored.selfBlocks ?? true,
  };
}

export function availabilityView(raw = {}, { macZone = macZoneNow() } = {}) {
  return { resolved: availabilitySettings(raw, { macZone }), stored: storedOf(raw), macZone, zones: ZONES() };
}

// One Settings row changed: settings.json read as written (readRawSettings: a file that cannot be read is refused and
// nothing is written, so cloudYes and every other key are never lost), the patch's group rewritten from its valid
// stored fields plus the patch (timeZone null deletes it, an empty group deletes the key), every other key untouched.
// An end hour not after the start is refused, nothing written. `patch` is already checked (validateAvailabilityPatch).
export async function saveAvailability(home = HIKYAKU_HOME, patch = {}, { macZone = macZoneNow(), readImpl, writeImpl = writeFile } = {}) {
  const raw = await readRawSettings(home, readImpl ? { readImpl } : {});
  const stored = storedOf(raw);
  const merged = { ...stored, ...patch };
  if (('startHour' in patch || 'endHour' in patch) && (merged.endHour ?? 17) <= (merged.startHour ?? 9)) throw new Error('The end of your hours must be after the start.');
  for (const [key, fields] of [['meetingHours', HOUR_KEYS], ['availability', RULE_KEYS]]) {
    if (!fields.some((field) => field in patch)) continue;
    const group = {};
    for (const field of fields) if (merged[field] !== undefined && merged[field] !== null) group[field] = merged[field];
    if (Object.keys(group).length) raw[key] = group;
    else delete raw[key];
  }
  await writeImpl(join(home, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return availabilityView(raw, { macZone });
}

// ---- 1.2 the window ----
const CLOCK = '(noon|\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm|a\\.m\\.|p\\.m\\.))?)';
const NOT_LENGTH = '(?!\\s*(?:min|mins|minutes?|hours?|hrs?|h\\b|days?|weeks?|people|%))';
const BETWEEN = new RegExp(`\\bbetween ${CLOCK} and ${CLOCK}(?![\\w:/])${NOT_LENGTH}`, 'i');
const RANGE = new RegExp(`(?<![\\w:/.$-])${CLOCK}\\s*(?:to|-|–|until|till)\\s*${CLOCK}(?![\\w:/])${NOT_LENGTH}`, 'i');
const AFTER = new RegExp(`\\bafter ${CLOCK}(?![\\w:/])${NOT_LENGTH}`, 'i');
const BEFORE = new RegExp(`\\bbefore ${CLOCK}(?![\\w:/])${NOT_LENGTH}`, 'i');
// The three parts of day that set hours, plural too ("this week mornings"); wordmap's other partOfDay words set none.
const PART = /\b(?:in the |this )?(morning|afternoon|evening)s?\b/i;

// A clock word as minutes of the day: "2pm" 840; without am/pm 1 to 7 is afternoon, 8 to 11 morning, 12 noon.
function clock(text, meridiem = null) {
  const lower = String(text).toLowerCase().replace(/\s+/g, '');
  if (lower === 'noon') return { minute: 720, mer: 'p' };
  const match = lower.match(/^(\d{1,2})(?::(\d{2}))?(?:(a|p)\.?m\.?)?$/);
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2] || 0);
  if (minute > 59) return null;
  const mer = match[3] || meridiem;
  if (mer) return hour < 1 || hour > 12 ? null : { minute: ((hour % 12) + (mer === 'p' ? 12 : 0)) * 60 + minute, mer, said: Boolean(match[3]) };
  if (hour > 23) return null;
  if (hour >= 1 && hour <= 7) return { minute: (hour + 12) * 60 + minute, mer: 'p' };
  if (hour >= 8 && hour <= 11) return { minute: hour * 60 + minute, mer: 'a' };
  if (hour === 12) return { minute: 720 + minute, mer: 'p' };
  return { minute: hour * 60 + minute, mer: null };
}

function rangeOf(startText, endText) {
  const end = clock(endText);
  if (!end) return null;
  let start = clock(startText);
  if (!start) return null;
  // "3 to 5pm" is 15:00 to 17:00; "11 to 1pm" stays 11:00, since 11pm is not before 1pm.
  const startSaid = /[ap]\.?m/i.test(startText) || /noon/i.test(startText);
  if (!startSaid && end.said) {
    const same = clock(startText, end.mer);
    if (same && same.minute < end.minute) start = same;
  }
  return [start.minute, end.minute];
}

// The hours a text names, or null. A reading that does not run forward, or that runs past 20:00, is no reading.
function hoursIn(text, settings) {
  const startDay = settings.startHour * 60, endDay = settings.endHour * 60;
  let range = null;
  let match;
  if ((match = text.match(BETWEEN))) range = rangeOf(match[1], match[2]);
  else if ((match = text.match(RANGE))) range = rangeOf(match[1], match[2]);
  else if ((match = text.match(AFTER))) {
    const at = clock(match[1]);
    range = at && [at.minute, at.minute >= endDay ? 1200 : endDay];
  } else if ((match = text.match(BEFORE))) {
    const at = clock(match[1]);
    range = at && [startDay, at.minute];
  } else if ((match = text.match(PART))) {
    const word = match[1].toLowerCase();
    if (word === 'morning') range = [startDay, 720];
    else if (word === 'afternoon') range = [720, endDay];
    else range = [1020, 1200];
  }
  if (!range || !(range[0] < range[1]) || range[0] < 0 || range[1] > 1200) return null;
  return range;
}

function minutesIn(text) {
  const match = text.match(PATTERNS.length) || text.match(PATTERNS.lengthBare);
  if (!match) return null;
  let minutes;
  if (match[1]) minutes = /half/i.test(match[1]) ? 30 : 60;
  else {
    const number = Number(match[2]);
    if (!Number.isFinite(number)) return null;
    minutes = /^h/i.test(match[3]) ? number * 60 : number;
  }
  return Math.min(240, Math.max(15, Math.round(minutes)));
}

const WEEKDAY_INDEX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const global = (pattern) => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
const WEEKDAYS = new RegExp(`\\b(next )?(${DAY})\\b`, 'gi');

// The days a text names, the first kind found: today/tomorrow, weekday names, dates, this or next week.
function daysIn(text, { reference, typed, over }) {
  const today = [...text.matchAll(global(PATTERNS.today))];
  if (today.length) return { days: today.map((m) => (/^(today|tonight)$/i.test(m[1]) ? reference : addDays(reference, 1))) };
  const weekdays = [...text.matchAll(WEEKDAYS)];
  if (weekdays.length) {
    return { days: weekdays.map((m) => {
      const want = WEEKDAY_INDEX[m[2].slice(0, 2).toLowerCase()];
      let ahead = (want - weekdayOf(reference) + 7) % 7;
      if (ahead === 0 && (m[1] || (typed && over))) ahead = 7;
      return addDays(reference, ahead);
    }) };
  }
  const dates = [];
  for (const m of text.matchAll(global(PATTERNS.date))) {
    const month = m[1] ? MONTH_INDEX.indexOf(m[1].slice(0, 3).toLowerCase()) + 1 : Number(m[3]);
    const day = Number(m[1] ? m[2] : m[4]);
    if (!month || !day) continue;
    const year = Number(reference.slice(0, 4));
    const make = (y) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (addDays(make(year), 0) !== make(year)) continue;
    dates.push(make(year) < reference ? make(year + 1) : make(year));
  }
  if (dates.length) return { days: dates };
  const week = text.match(PATTERNS.week);
  if (week) {
    const monday = addDays(reference, -((weekdayOf(reference) + 6) % 7));
    if (week[1].toLowerCase() === 'next') return { days: [0, 1, 2, 3, 4].map((n) => addDays(monday, 7 + n)), week: true };
    const days = [];
    for (let key = reference; key <= addDays(monday, 4); key = addDays(key, 1)) if (isWeekday(key)) days.push(key);
    return { days, settingsWhenEmpty: true, week: true };
  }
  return null;
}

function settingsDays(now, settings) {
  const today = dayKey(now, settings.timeZone);
  let key = isWeekday(today) && !hoursOver(now, settings.timeZone, settings.endHour * 60, settings.minMinutes) ? today : addDays(today, 1);
  const days = [];
  for (; days.length < settings.daysAhead; key = addDays(key, 1)) if (isWeekday(key)) days.push(key);
  return days;
}

export function readWindow({ typed, email, emailAt, now, settings } = {}) {
  const rules = settings && typeof settings === 'object' && settings.timeZone ? settings : availabilitySettings({});
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const timeZone = rules.timeZone;
  const typedText = typeof typed === 'string' ? typed : '';
  const emailText = typeof email === 'string' ? email : '';
  const sent = (typeof emailAt === 'string' || emailAt instanceof Date) && !Number.isNaN(new Date(emailAt).getTime()) ? new Date(emailAt) : null;
  const today = dayKey(at, timeZone);

  const from = {};
  let hours = hoursIn(typedText, rules);
  from.hours = hours ? 'typed' : (hours = hoursIn(emailText, rules)) ? 'thread' : 'settings';
  if (!hours) hours = [rules.startHour * 60, rules.endHour * 60];
  let minutes = minutesIn(typedText);
  from.minutes = minutes ? 'typed' : (minutes = minutesIn(emailText)) ? 'thread' : 'settings';
  if (!minutes) minutes = rules.minMinutes;

  const over = hoursOver(at, timeZone, hours[1], minutes);
  const keep = (list) => [...new Set(list.filter((key) => key >= today && !(key === today && over) && dayDiff(today, key) <= MAX_AHEAD))].sort().slice(0, MAX_DAYS);
  // `named`: the words named the days (a weekday, a date, today or tomorrow), not a week; only then does a full day
  // get its own note (spec 1.8 "some named day full"; fixture F7).
  let days = null, stale = false, named = false;
  const fromTyped = daysIn(typedText, { reference: today, typed: true, over });
  if (fromTyped) {
    days = keep(fromTyped.days);
    from.days = days.length ? 'typed' : 'settings';
    named = Boolean(days.length) && !fromTyped.week;
  } else {
    const fromEmail = daysIn(emailText, { reference: sent ? dayKey(sent, timeZone) : today, typed: false, over });
    if (fromEmail) {
      days = keep(fromEmail.days);
      from.days = days.length ? 'thread' : 'settings';
      named = Boolean(days.length) && !fromEmail.week;
      stale = !days.length && !(fromEmail.settingsWhenEmpty && !fromEmail.days.length);
    } else from.days = 'settings';
  }
  if (!days || !days.length) days = settingsDays(at, rules);
  return { days, startMinute: hours[0], endMinute: hours[1], minutes, timeZone, notice: NOTICE, from, stale, named };
}

// ---- 1.4 the read ----
export const REASONS = Object.freeze({
  access: 'no calendar access',
  timeout: 'the calendar did not answer in 5 seconds',
  missing: 'the calendar helper is missing',
  failed: 'the calendar helper failed',
  empty: 'no events on your calendars for these days or the week before',
});
const TIMEOUT = Symbol('timeout');
function reasonFor(error) {
  if (error === TIMEOUT) return REASONS.timeout;
  const message = String(error?.message || error || '');
  if (/cannot read your calendars/.test(message)) return REASONS.access;
  if (/missing its calendar helper|could not build/.test(message)) return REASONS.missing;
  return REASONS.failed;
}

export async function availabilityFor({ window, settings, eventsImpl, statusImpl, now = new Date(), timeoutMs = 5000 } = {}) {
  const started = Date.now();
  const rules = { selfBlocks: settings?.selfBlocks !== false, minMinutes: settings?.minMinutes ?? window?.minutes };
  const answer = (read, reason, days = []) => ({ read, reason, window, rules, days, text: days.length ? formatAvailability(days, { timeZone: window.timeZone }) : '', ms: Date.now() - started });
  let status;
  try { status = await statusImpl(); } catch { status = 'unknown'; }
  if (status !== 'granted') return answer('unreadable', REASONS.access);
  const timeZone = window.timeZone;
  const first = window.days[0], last = window.days.at(-1);
  let events, timer = null;
  try {
    events = await Promise.race([
      Promise.resolve().then(() => eventsImpl({ from: atMinute(addDays(first, -7), 0, timeZone), days: dayDiff(first, last) + 8 })),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(TIMEOUT), timeoutMs); }),
    ]);
  } catch (error) {
    return answer('unreadable', reasonFor(error));
  } finally { clearTimeout(timer); }
  if (!Array.isArray(events)) return answer('unreadable', REASONS.failed);
  if (!events.length) return answer('empty', REASONS.empty);

  const busy = events.filter(blocksTime).filter((event) => rules.selfBlocks || (event.attendees || []).length > 0);
  const today = dayKey(now, timeZone);
  const earliest = ceil15(now.getTime() + window.notice * MINUTE);
  const startHour = Math.floor(window.startMinute / 60), endHour = Math.ceil(window.endMinute / 60);
  const days = [];
  // One day a call, from that day's opening hour: from a midnight freeSlots repeats a day when the clocks go back (D4).
  for (const key of window.days) {
    const [y, m, d] = key.split('-').map(Number);
    const slots = freeSlots(busy, { from: zonedTime(y, m, d, startHour, 0, timeZone), days: 1, minutes: window.minutes, startHour, endHour, timeZone, weekends: true });
    const lo = Math.max(atMinute(key, window.startMinute, timeZone).getTime(), key === today ? earliest : -Infinity);
    const hi = atMinute(key, window.endMinute, timeZone).getTime();
    const ranges = slots.flatMap((slot) => slot.windows)
      .map(({ start, end }) => [ceil15(Math.max(start.getTime(), lo)), floor15(Math.min(end.getTime(), hi))])
      .filter(([start, end]) => end - start >= window.minutes * MINUTE)
      .map(([start, end]) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
    if (ranges.length) days.push({ day: key, ranges });
  }
  return answer('read', null, days);
}

// ---- 1.5 the words ----
const clockLabel = (minute) => {
  const hour = Math.floor(minute / 60) % 24, mins = minute % 60;
  return { text: `${hour % 12 || 12}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`, mer: hour < 12 ? 'am' : 'pm' };
};
const minutesRange = (startMinute, endMinute) => {
  const start = clockLabel(startMinute), end = clockLabel(endMinute);
  return `${start.text}${start.mer === end.mer ? '' : start.mer} to ${end.text}${end.mer}`;
};

export function zoneLabel(timeZone, at = new Date()) {
  const name = (style) => new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value || '';
  const generic = name('shortGeneric');
  return /^[A-Z]{2,4}$/.test(generic) ? generic : name('short');
}
const dayLabel = (key) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(keyDate(key)).replace(/,/g, '');
export function daysLabel(days = []) {
  const list = [...days];
  if (list.length <= 1) return list.map(dayLabel).join('');
  if (list.length === 2) return `${dayLabel(list[0])} and ${dayLabel(list[1])}`;
  return `${dayLabel(list[0])} to ${dayLabel(list.at(-1))}`;
}
export const hoursLabel = (startMinute, endMinute, timeZone, at = new Date()) => `${minutesRange(startMinute, endMinute)} ${zoneLabel(timeZone, at)}`;

export function formatAvailability(days, { timeZone } = {}) {
  const lines = (days || []).map(({ day, ranges }) => `${dayLabel(day)}: ${ranges.map(({ start, end }) => {
    const from = new Date(ceil15(new Date(start).getTime())), to = new Date(floor15(new Date(end).getTime()));
    return minutesRange(minuteOf(from, timeZone), minuteOf(to, timeZone));
  }).join(', ')}`);
  if (!lines.length) return '';
  const lastEnd = new Date(days.at(-1).ranges.at(-1).end);
  lines[lines.length - 1] += ` ${zoneLabel(timeZone, lastEnd)}`;
  return lines.join('\n');
}

// ---- 1.7 the fill ----
const ALONE = /^\s*\[your times\]\s*[.:]?\s*$/;
const SIGN_OFF = /^(best|thanks|thank you|cheers|regards|best regards|sincerely|all the best)\b[,!.]?$/i;

// The block as its own paragraph, starting at line `index`; returns the block's first and last line.
function insertParagraph(lines, index, block) {
  const before = index > 0 && lines[index - 1].trim() ? [''] : [];
  const after = index < lines.length && lines[index].trim() ? [''] : [];
  lines.splice(index, 0, ...before, ...block, ...after);
  return [index + before.length, index + before.length + block.length - 1];
}

export function fillTimes(body, availability, { signName = '' } = {}) {
  const text = String(body ?? '');
  const filled = availability?.read === 'read' && availability.days?.length > 0;
  const block = filled ? availability.text : PLACEHOLDER;
  if (!filled && text.includes(PLACEHOLDER)) return { text, how: 'left', block: null };
  const lines = text.split('\n');
  const blockLines = block.split('\n');
  if (filled) {
    const alone = lines.findIndex((line) => ALONE.test(line));
    if (alone >= 0) {
      lines.splice(alone, 1, ...blockLines);
      return { text: lines.join('\n'), how: 'line', block: [alone, alone + blockLines.length - 1] };
    }
    const inline = lines.findIndex((line) => line.includes(PLACEHOLDER));
    if (inline >= 0) {
      const line = lines[inline];
      const at = line.indexOf(PLACEHOLDER);
      let left = line.slice(0, at), right = line.slice(at + PLACEHOLDER.length);
      if (/^[.,;!?]/.test(right)) left = left.replace(/\s+$/, '');
      else if (/\s$/.test(left)) right = right.replace(/^\s+/, '');
      const cut = `${left}${right}`.trim();
      if (!/[\p{L}\p{N}]/u.test(cut)) {
        lines.splice(inline, 1, ...blockLines);
        return { text: lines.join('\n'), how: 'line', block: [inline, inline + blockLines.length - 1] };
      }
      lines[inline] = cut;
      let end = inline;
      while (end + 1 < lines.length && lines[end + 1].trim()) end += 1;
      const at2 = insertParagraph(lines, end + 1, blockLines);
      return { text: lines.join('\n'), how: 'inline', block: at2 };
    }
  }
  let index = lines.length;
  const sign = lines.findLastIndex((line) => SIGN_OFF.test(line.trim()));
  const lastText = lines.findLastIndex((line) => line.trim());
  if (sign >= 0) index = sign;
  else if (signName && lastText >= 0 && lines[lastText].trim() === signName) index = lastText;
  else {
    while (index > 0 && !lines[index - 1].trim()) index -= 1;
  }
  const at = insertParagraph(lines, index, blockLines);
  return { text: lines.join('\n'), how: 'inserted', block: at };
}

// Any clock time left outside the block that is not inside an offered range becomes [your times], whoever wrote it.
// Body times carry no date, so a time inside any offered day's range is kept.
// `keep`: texts whose times stay wherever they appear (the thread and the user's own words: a time the sender proposed
// or the user typed is never cut, loggie-reply-yes).
export function strayTimes(text, days, { skip = null, timeZone, keep = [] } = {}) {
  const ranges = (days || []).flatMap((day) => day.ranges.map(({ start, end }) => [minuteOf(new Date(start), timeZone), minuteOf(new Date(end), timeZone)]));
  const kept = new Set(keep.flatMap((source) => timesIn(String(source || ''))).flatMap((time) => time.ends.flat()));
  const inside = (time) => ranges.some(([a, b]) => time.ends.every((list) => list.some((m) => a <= m && m <= b)))
    || (kept.size > 0 && time.ends.every((list) => list.some((m) => kept.has(m))));
  const removed = [];
  const lines = String(text ?? '').split('\n').map((line, index) => {
    if (skip && index >= skip[0] && index <= skip[1]) return line;
    const spans = timesIn(line).filter((time) => !inside(time));
    if (!spans.length) return line;
    const merged = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && (span.start <= last.end || /^[\s,;/]*(?:(?:or|and|&|to|-|–)\s*)?[\s,]*$/i.test(line.slice(last.end, span.start)))) last.end = Math.max(last.end, span.end);
      else merged.push({ start: span.start, end: span.end });
    }
    let out = '', at = 0;
    for (const span of merged) {
      removed.push(line.slice(span.start, span.end).trim());
      out += line.slice(at, span.start) + PLACEHOLDER;
      at = span.end;
    }
    out += line.slice(at);
    return out.replace(/\]\.(?= [a-z])/g, ']').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;!?])/g, '$1').replace(/(\[your times\])(?:\s*\1)+/g, '$1');
  });
  return { text: lines.join('\n'), removed };
}

// The words of the line the block carries: the cue, the days, the part of day, the clock words ("after 2pm", "before
// noon", "between 10 and 2") and the length. A draft written under TIMES_RULE names none of them, so keepsLine leaves
// them out (spec C14; TC3: a typed time is the window's, and the block carries it). Leaving a word out of keepsLine lets
// nothing through: guardTimes and strayTimes still judge every time in the draft.
export function lineSkip(line = '') {
  const text = String(line || '');
  const words = new Set();
  const add = (match) => { for (const word of String(match).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) words.add(word); };
  for (const pattern of [TYPED_CUE, PATTERNS.today, WEEKDAYS, PATTERNS.date, PATTERNS.week, PATTERNS.partOfDay, PART, BETWEEN, RANGE, AFTER, BEFORE, PATTERNS.length, PATTERNS.lengthBare]) {
    for (const match of text.matchAll(global(pattern))) add(match[0]);
  }
  return [...words];
}

// ---- 1.8, 1.9 what the ask says and saves ----
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function availabilityReport({ asked, availability, how, guard = { removed: [] }, stray = { removed: [] } }) {
  const read = availability || { read: 'unreadable', reason: REASONS.failed, window: null, days: [], ms: 0 };
  const window = read.window;
  const filled = read.read === 'read' && read.days.length > 0;
  const did = [];
  let note = '';
  const quoted = (guard.removed || []).map((text) => `"${text}"`).join(', ');
  if (filled) {
    const at = new Date(read.days[0].ranges[0].start);
    const n = read.days.reduce((sum, day) => sum + day.ranges.length, 0);
    const missing = window.days.filter((key) => !read.days.some((day) => day.day === key));
    if (window.stale) note = 'The email asked about a day that has passed; these are your next weekdays. Check them before you send.';
    else if (missing.length && window.named) note = `${daysLabel(missing)} has no open ${window.minutes} minutes; the other days are in the draft.`;
    if (quoted) did.push(`Took out ${quoted}: not from your calendar; your real times are in the draft`);
    did.push(`Read your calendar on this Mac for ${daysLabel(window.days)} (${hoursLabel(window.startMinute, window.endMinute, window.timeZone, at)}, ${window.minutes} min or longer): ${plural(n, 'open time')} written into the draft`);
    if (stray.removed?.length) did.push(`Took out ${plural(stray.removed.length, 'time')} the draft named outside your free times`);
  } else {
    note = read.read === 'read'
      ? `Your calendar has no open ${window.minutes} minutes on ${daysLabel(window.days)} from ${hoursLabel(window.startMinute, window.endMinute, window.timeZone, keyDate(window.days[0]))}; ${PLACEHOLDER} is left for you.`
      : `Loggie could not read your calendar (${read.reason}); ${PLACEHOLDER} is left for you.`;
    if (quoted) did.push(`Took out ${quoted}: ${note}`);
  }
  const record = { asked, read: read.read, reason: read.reason ?? null, window, rules: read.rules || null, days: read.days, how, stray: stray.removed?.length || 0, ms: read.ms ?? 0 };
  return { note, did, record };
}

// The ask box's word for ui-acts: what happened to the times, never a time.
export const timesWord = (record) => (record.read === 'read' ? (record.days.length ? 'filled' : 'none-free') : record.read);

// The app's readers for an availability ask: the calendar helper's list and status, and the rules from settings.json.
export function askAvailability({ home, listEventsImpl = listEvents, statusImpl = calendarStatus, readSettingsImpl = readSettings, macZone = macZoneNow() } = {}) {
  const homeOf = () => (typeof home === 'function' ? home() : home);
  return {
    events: (options) => listEventsImpl(options),
    status: () => statusImpl(),
    availability: async () => availabilitySettings(await readSettingsImpl(homeOf()), { macZone }),
  };
}
