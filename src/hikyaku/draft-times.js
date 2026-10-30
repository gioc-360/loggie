// A draft never states a time or date Loggie did not read (loggie-intros fix 2, 2026-10-20). The real case: "email
// rowena of my availability friday"; her email asked for "a couple of time slots that work for you on Friday";
// nothing read the calendar, and the cloud AI wrote "I am available Friday after 2pm", which was false.
//
//   guardTimes(draft, { thread, typed, calendar }) -> { text, removed: [string], note }
//     Every clock time or time range ("2pm", "2:30", "2-4pm", "after 2", "noon") and every specific date ("Oct 24",
//     "10/24", "the 24th") in the draft that is not in the thread text, the user's own typed words, or the calendar
//     data the draft was given comes out of its sentence, and the sentence gets PLACEHOLDER for the user to fill. A
//     day name stays ("Friday"), unless it only dated a time that came out and Loggie never read it. `note` is what
//     the ask's outcome says when anything came out, else ''. Code only: nothing is sent, nothing is asked again.
//   timesInDraft = the placeholder test the move path uses after the draft is written.
export const PLACEHOLDER = '[your times]';
export const NO_CALENDAR_NOTE = 'Loggie did not check your calendar for times; add them before sending.';
export const CALENDAR_NOTE = 'Loggie took out a time that is not in the thread or your calendar; add yours before sending.';
export const timesInDraft = (text) => String(text || '').includes(PLACEHOLDER);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?(?![a-z])\\.?';
// The end mark after "p.m." stays in the text: it may also end the sentence.
const MER = '(?:\\s*(?:a\\.?\\s?m|p\\.?\\s?m)\\b)';
const ATOM = `(?:\\d{1,2}(?::[0-5]\\d)?(?!\\d)(?:${MER}|\\s*o'?clock\\b)?|noon\\b|midday\\b|midnight\\b)`;
const TZ = '(?:\\s*\\(?(?:[ECMP][SD]?T|GMT|UTC)\\)?(?![a-z]))?';
const PREP = "(?:(?:any ?time |anytime |any time |starting )?(?:at|after|before|around|by|from|between|until|till|starting)\\s+)";
const TIME = new RegExp(`(?<![\\w:/.$'-])(${PREP})?(${ATOM}(?:\\s*(?:-|–|to|and|until|till|or)\\s*${ATOM})?)${TZ}`, 'gi');
const DATE = new RegExp([
  `(?<![\\w/])${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`,
  `(?<![\\w/])\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?![a-z])(?:,?\\s+\\d{4})?`,
  '(?<![\\w/.-])\\d{4}-\\d{2}-\\d{2}\\b',
  '(?<![\\w/.:$-])\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?(?![\\w/])',
  '\\bthe\\s+\\d{1,2}(?:st|nd|rd|th)\\b',
].join('|'), 'gi');
// A bare number after "at" or "by" is a time only when no unit follows it: "after 2 days" is not a time.
const UNIT = /^\s*(?:%|percent\b|min\b|mins\b|minutes?\b|hours?\b|hrs?\b|days?\b|weeks?\b|months?\b|years?\b|people\b|persons?\b|pages?\b|items?\b|more\b|of\b|times\b|slides?\b|x\b|\d)/i;
const STRONG = /[ap]\.?\s?m\b|:|o'?clock|noon|midday|midnight/i;

// The minutes of the day an atom can mean: "2pm" is 14:00 only; a bare "2" or "2:30" is morning or afternoon.
function minutesOf(atom, meridiem = null) {
  const text = atom.toLowerCase();
  if (/noon|midday/.test(text)) return [720];
  if (/midnight/.test(text)) return [0];
  const [, h, m = '0'] = text.match(/(\d{1,2})(?::(\d{2}))?/) || [];
  const hour = Number(h), minute = Number(m);
  if (!Number.isInteger(hour) || hour > 24 || minute > 59) return [];
  const mer = (text.match(/([ap])\.?\s?m/) || [])[1] || meridiem;
  if (mer === 'p') return hour > 12 ? [] : [((hour % 12) + 12) * 60 + minute];
  if (mer === 'a') return hour > 12 ? [] : [(hour % 12) * 60 + minute];
  if (hour === 0 || hour > 12) return [(hour % 24) * 60 + minute];
  return [hour * 60 + minute, ((hour % 12) + 12) * 60 + minute];
}
const atomsOf = (range) => range.split(/\s*(?:-|–|\bto\b|\band\b|\buntil\b|\btill\b|\bor\b)\s*/i).filter(Boolean);

// The clock times in a text: each match with the minutes every endpoint can mean. `loose` (the user's own words) also
// counts a bare hour ("friday 2") as a time; read text needs "pm", a colon, or a word like "at" before it.
export function timesIn(text, { loose = false } = {}) {
  const found = [];
  for (const match of String(text || '').matchAll(TIME)) {
    const [whole, prep = '', range] = match;
    const strong = STRONG.test(range);
    if (!strong && !loose && !prep) continue;
    if (!strong && UNIT.test(text.slice(match.index + whole.length))) continue;
    const atoms = atomsOf(range);
    const meridiem = (range.match(/([ap])\.?\s?m\b\.?\s*$/i) || [])[1]?.toLowerCase() || null;
    const ends = atoms.map((atom) => minutesOf(atom, meridiem));
    if (ends.some((list) => !list.length)) continue;
    found.push({ start: match.index, end: match.index + whole.length, text: whole, ends });
  }
  return found;
}

// The dates in a text as "M-D" (month 1 to 12) or "*-D" ("the 24th").
function datesIn(text) {
  const found = [];
  for (const match of String(text || '').matchAll(DATE)) {
    const whole = match[0];
    const lower = whole.toLowerCase();
    let value = null;
    const iso = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const slash = lower.match(/^(\d{1,2})\/(\d{1,2})/);
    const named = lower.match(/[a-z]{3,}/);
    const dayNumber = Number((lower.match(/\d{1,2}(?=(?:st|nd|rd|th)?\b(?!\d))/) || [])[0]);
    if (iso) value = `${Number(iso[2])}-${Number(iso[3])}`;
    else if (slash) value = Number(slash[1]) <= 12 && Number(slash[2]) <= 31 ? `${Number(slash[1])}-${Number(slash[2])}` : null;
    else if (/^the\s/.test(lower)) value = dayNumber <= 31 ? `*-${dayNumber}` : null;
    else if (named) {
      const month = MONTHS.findIndex((name) => named[0].startsWith(name)) + 1;
      value = month && dayNumber >= 1 && dayNumber <= 31 ? `${month}-${dayNumber}` : null;
    }
    if (value) found.push({ start: match.index, end: match.index + whole.length, text: whole, value });
  }
  return found;
}

// An ISO stamp's time is UTC and nobody wrote it ("## Rowena <...> · 2026-10-20T14:29:10.000Z"): only its day counts.
const dayOnly = (text) => String(text || '').replace(/(\d{4}-\d{2}-\d{2})T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, '$1');

// What Loggie read: the thread and the calendar (strict), the user's own words (loose), and calendar events given as
// data ({ start, end }, local time on this Mac).
function readSet({ thread = '', typed = '', calendar = null }) {
  const minutes = new Set(), dates = new Set(), days = new Set();
  const typedText = (Array.isArray(typed) ? typed : [typed]).filter(Boolean).join('\n');
  const calendarText = typeof calendar === 'string' ? calendar : '';
  const events = Array.isArray(calendar) ? calendar : [];
  const strict = dayOnly(`${thread}\n${calendarText}`);
  for (const [text, loose] of [[strict, false], [typedText, true]]) {
    for (const time of timesIn(text, { loose })) for (const end of time.ends) for (const value of end) minutes.add(value);
    for (const date of datesIn(text)) dates.add(date.value);
    for (const name of text.toLowerCase().matchAll(new RegExp(`\\b${WEEKDAY}`, 'g'))) days.add(name[0].slice(0, 3));
    // the user's own bare numbers ("3 works") are hours they said
    if (loose) for (const n of text.matchAll(/(?<![\d:/.$-])\b(\d{1,2})\b(?![\d:/])/g)) for (const value of minutesOf(n[1])) minutes.add(value);
  }
  for (const event of events) {
    for (const at of [event.start, event.end]) {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) continue;
      minutes.add(when.getHours() * 60 + when.getMinutes());
      dates.add(`${when.getMonth() + 1}-${when.getDate()}`);
      days.add(when.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase().slice(0, 3));
    }
  }
  return { minutes, dates, days, calendarGiven: Boolean(calendarText.trim() || events.length) };
}

const dateRead = (value, dates) => dates.has(value) || (value.startsWith('*-') ? [...dates].some((d) => d.endsWith(value.slice(1))) : dates.has(`*-${value.split('-')[1]}`));

export function guardTimes(draft, { thread = '', typed = '', calendar = null } = {}) {
  const text = String(draft ?? '');
  const read = readSet({ thread, typed, calendar });
  let spans = [];
  for (const time of timesIn(text)) {
    if (time.ends.every((list) => list.some((value) => read.minutes.has(value)))) continue;
    spans.push({ start: time.start, end: time.end });
  }
  for (const date of datesIn(text)) if (!dateRead(date.value, read.dates)) spans.push({ start: date.start, end: date.end });
  if (!spans.length) return { text, removed: [], note: '' };
  spans.sort((a, b) => a.start - b.start);
  // A day name right before what came out goes with it only when Loggie never read that day ("Thursday at 3pm").
  for (const span of spans) {
    const before = text.slice(0, span.start).match(new RegExp(`(?:\\bon\\s+)?\\b(${WEEKDAY}),?\\s+$`, 'i'));
    if (before && !read.days.has(before[1].toLowerCase().slice(0, 3))) span.start -= before[0].length;
  }
  // Spans joined only by a comma, "or", "and" or a space are one gap to fill: "at 2pm, 3pm or 4pm".
  const merged = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && (span.start <= last.end || /^[\s,;/]*(?:(?:or|and|&|to|-|–)\s*)?[\s,]*$/i.test(text.slice(last.end, span.start)))) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  let out = '';
  let at = 0;
  for (const span of merged) {
    out += text.slice(at, span.start) + PLACEHOLDER;
    at = span.end;
  }
  out += text.slice(at);
  out = out.replace(/\]\.(?= [a-z])/g, ']').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;!?])/g, '$1').replace(new RegExp(`(${PLACEHOLDER.replace(/[[\]]/g, '\\$&')})(?:\\s*\\1)+`, 'g'), '$1');
  return { text: out, removed: merged.map((span) => text.slice(span.start, span.end).trim()), note: read.calendarGiven ? CALENDAR_NOTE : NO_CALENDAR_NOTE };
}
