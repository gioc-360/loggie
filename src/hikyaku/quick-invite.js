// One sentence to a filled invite, in seconds: "invite Marisol and Jess 2pm Maplewood". Code reads the sentence (no
// model: the same answer every time, nothing leaves the Mac, so it runs the same in the cloud and the verified mode),
// the people index turns names into addresses, and Outlook's own window is filled by the invite helper
// (native/outlook-event.swift) or Google Calendar's own page is opened. It stops before Send, always.
//
// What the sentence may say, in any order after the people:
//   a time        2pm, 2:30 pm, 14:00, noon             (optional: without one, Loggie finds one)
//   a day         today, tomorrow, monday, next friday, oct 14, 10/14   (default: today if the time is still ahead, else tomorrow)
//   a length      for 30 min, for 1.5 hours, for an hour             (default: an hour; Outlook's nearest offered end)
//   a place       at Maplewood, or what is left after the people and the time
//   a room        room in Breazzano [floor 2 or 3]                  (a bookable room from Outlook's own list)
//   a repeat      daily, weekly, every monday, monthly, yearly; every other week, every 3 weeks, every tuesday and
//                 thursday; until dec 4 (or 12/4), for 6 weeks, 6 times, forever
//   notes         with notes                                         (the last call with them: summary and action items)
//   a subject     about "Q3 plan", or "Q3 plan" in quotes
//   google        on google                                          (Google Calendar's page instead of Outlook)
//   this week / next week                                            (where to look when no time or day is said)
// Every Outlook invite is checked for everyone on it (Outlook's own free/busy, through Cornell's Exchange). When the
// time asked is taken, or none was asked, the first time free for everyone in the hours searched (weekdays 9:00-20:00;
// weekends when settings.json "findWeekends" is true) is filled and two more are listed. Candidates come from the
// user's own calendar first, so only times the user has free are tried in Outlook.
// Times run in four second-scale pieces measured 2026-10-09: the window opens in about 0.7 s, the end time takes
// 0.6-0.8 s, a typed place about 2 s, a repeat about 1.5 s.
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { freeSlots, googleEventLink, isMarker, listEvents, outlookEventLink } from './calendar.js';
import { fromSummary } from './calls.js';
import { HIKYAKU_HOME, readSettings } from './draft.js';
import { inviteBody } from './invite.js';
import { helperPath } from './native-helper.js';
import { loadPeople, resolvePerson } from './people.js';
import { PATTERNS, readWords } from './wordmap.js';
import { rememberPlace } from './places.js';

const run = promisify(execFile);
const SOURCE = fileURLToPath(new URL('./native/outlook-event.swift', import.meta.url));
const HELPER = join(HIKYAKU_HOME, '..', 'bin', 'hikyaku-outlook-event');
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');
// An hour, not invite.js's 50: the ask box also makes Google Calendar invites, where Outlook's 5-minute trim does not
// apply; the call card's follow-up is Outlook only (cleanup audit bug 17, checked 2026-10-27).
export const DEFAULT_MINUTES = 60;
export const FIND_HOURS = { startHour: 9, endHour: 20 };

// Pull one phrase out of the sentence: returns [match or null, the sentence without it].
function take(text, pattern) {
  const found = text.match(pattern);
  return found ? [found, (text.slice(0, found.index) + ' ' + text.slice(found.index + found[0].length)).replace(/\s+/g, ' ').trim()] : [null, text];
}
const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// A list or team address ("NEXT GEN-TEAM", "MBA Class of 2027") has no first name: its first word is an ordinary word,
// and "about loggie next steps" read "next" as that team (live run 2026-10-12). Its whole name still matches.
const GROUP = /(?:^|[^a-z])(?:team|teams|group|list|listserv|staff|club|committee|council|board|office|department|dept|program|admissions|support|newsletter|news|noreply|no-reply|society|association|cohort|class|all)(?:[^a-z]|$)/;

// Who a word can be (wordmap.js's isName). In the middle of a sentence a word must be someone's whole name or first
// name; right after "invite", "and", "with" or a comma it may also be the start of a name or a one-letter slip.
export function nameIn(people) {
  return (text, { loose = false } = {}) => {
    const q = fold(text);
    if (!q) return false;
    if (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(q)) return true;
    if (loose) return resolvePerson(text, people).status !== 'none';
    if (q.includes(' ') && resolvePerson(text, people).slip) return true;
    return people.some((p) => { const name = fold(p.name); return name === q || (name.split(/\s+/)[0] === q && !GROUP.test(name)) || (q.includes(' ') && name.startsWith(`${q} `)); });
  };
}

// One person for a name. Two addresses under one name are one person (a work and a personal address): the one used
// most is picked and the others ride along as `alternates`, so the box can offer them. Two different people who both
// answer to the name are a question, never a guess.
export function personFor(typed, people) {
  const result = resolvePerson(typed, people);
  if (result.status === 'one') return result.person;
  if (result.status === 'many') {
    const names = new Set(result.candidates.map((c) => fold(c.name)));
    if (names.size === 1) {
      const all = people.filter((p) => fold(p.name) === [...names][0]);
      const ranked = [...all].sort((a, b) => (b.count || 0) - (a.count || 0) || String(b.last || '').localeCompare(String(a.last || '')));
      return { ...ranked[0], alternates: ranked.slice(1).map((p) => p.address) };
    }
    throw new Error(`More than one person answers to "${typed}": ${result.candidates.map((c) => `${c.name} <${c.address}>`).join(', ')}. Say the full name.`);
  }
  throw new Error(`No one called "${typed}" is in your mail. Say the full name or the address.`);
}

// The sentence as fields. The word map (wordmap.js) says which words are the people, the time, the place, the subject
// and the kind of meeting, in any order; the values are read out of those words here. Throws a plain-English Error for
// anything it cannot read; never guesses a person. `plan.words` carries every word's role for the box, and
// `plan.leftOut` the words nobody asked for, which the invite does not use.
export function readSentence(sentence, { people = [], now = new Date(), places = [] } = {}) {
  const map = readWords(sentence, { action: 'invite', isName: nameIn(people), places });
  let text = ` ${map.when} `.replace(/\s+/g, ' ');
  let found;
  const plan = { calendar: map.app === 'google' ? 'google' : 'outlook', people: [], minutes: DEFAULT_MINUTES, place: map.where, room: null, repeat: '', notes: map.notes, title: map.quote || map.about, words: map.words, leftOut: [] };
  if (map.kind && !/^(?:meeting|meetup)$/.test(map.kind)) plan.kind = map.kind;
  // A custom repeat first: how often, on which weekdays, and when it ends.
  [found, text] = take(text, PATTERNS.repeatDays);
  if (!found) [found, text] = take(text, PATTERNS.repeatDay);
  if (found) {
    plan.repeat = 'weekly';
    plan.on = found[1].toLowerCase().split(/, ?| and | ?& ?| ?\/ ?/).map((d) => d.slice(0, 3));
  }
  [found, text] = take(text, PATTERNS.everyOther);
  if (found) { plan.repeat = found[1] ? { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[found[1].toLowerCase()] : 'weekly'; plan.every = 2; }
  [found, text] = take(text, PATTERNS.everyN);
  if (found) { plan.repeat = { d: 'daily', w: 'weekly', m: 'monthly', y: 'yearly' }[found[2][0].toLowerCase()]; plan.every = Number(found[1]); }
  [found, text] = take(text, PATTERNS.daily); if (found) plan.repeat = 'daily';
  [found, text] = take(text, PATTERNS.weekly); if (found) plan.repeat = 'weekly';
  [found, text] = take(text, PATTERNS.monthly); if (found) plan.repeat = 'monthly';
  [found, text] = take(text, PATTERNS.yearly); if (found) plan.repeat = 'yearly';
  [found, text] = take(text, PATTERNS.until);
  if (found) {
    const month = found[1] ? MONTHS.indexOf(found[1].toLowerCase()) : Number(found[3]) - 1;
    let until = new Date(now.getFullYear(), month, Number(found[2] || found[4]));
    if (until < new Date(now.getFullYear(), now.getMonth(), now.getDate())) until = new Date(now.getFullYear() + 1, month, until.getDate());
    plan.until = `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}`;
  }
  [found, text] = take(text, PATTERNS.times);
  if (found) plan.times = Number(found[1] || found[2]);
  [found, text] = take(text, PATTERNS.forever); if (found) plan.noEnd = true;
  if ((plan.until || plan.times || plan.noEnd) && !plan.repeat) plan.repeat = 'weekly';
  [found, text] = take(text, PATTERNS.length);
  if (!found) [found, text] = take(text, PATTERNS.lengthBare);
  if (found) plan.minutes = found[1] ? (/half/i.test(found[1]) ? 30 : 60) : Math.round(Number(found[2]) * (/^h/i.test(found[3]) ? 60 : 1));
  // where to look: "this week" (to Friday), "next week" (Monday to Friday), else five days from the day said or today
  plan.lookDays = 5;
  let weekStart = null;
  [found, text] = take(text, PATTERNS.week);
  if (found) {
    if (/next/i.test(found[1])) weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((8 - now.getDay()) % 7 || 7));
    else plan.lookDays = Math.max(1, 6 - now.getDay());
  }
  if (map.room) {
    const room = map.room.match(PATTERNS.room);
    if (room) plan.room = { query: room[1], floors: [room[2], room[3]].filter(Boolean).join('') };
  }
  // the time
  // "1730" (24-hour, four digits), "530pm", "5:30pm", "17:30", "noon". A colon time from 1:00 to 7:59 with no am/pm
  // is afternoon: nobody books 5:30 in the morning by saying "5:30" (2026-10-11). "at 5" alone is 5 PM by the same
  // rule, and "at 9" is 9 AM.
  [found, text] = take(text, PATTERNS.time);
  let hour = null, minute = null;
  if (found) {
    if (/noon|midday/i.test(found[1])) [hour, minute] = [12, 0];
    else if (found[2]) { hour = Number(found[2]) % 12 + (/^p/i.test(found[4]) ? 12 : 0); minute = Number(found[3] || 0); }
    else if (found[5]) { [hour, minute] = [Number(found[5]), Number(found[6])]; if (hour >= 1 && hour <= 7) hour += 12; }
    else [hour, minute] = [Number(found[7]), Number(found[8])];
    if (hour > 23 || minute > 59) throw new Error(`"${found[0].trim()}" is not a time.`);
  } else {
    [found, text] = take(text, PATTERNS.hour);
    if (found) { hour = Number(found[1]); minute = 0; if (hour >= 1 && hour <= 7) hour += 12; }
  }
  plan.timeGiven = hour !== null;
  // the day
  let day = weekStart;
  if (!day) [found, text] = take(text, PATTERNS.today); else found = null;
  let dayGiven = Boolean(found);
  if (found) day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (/^(?:today|tonight)$/i.test(found[1]) ? 0 : 1));
  if (!day) {
    [found, text] = take(text, /\b(?:on )?(next )?(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b/i);
    if (found) {
      const want = DAYS.findIndex((d) => d.startsWith(found[2].toLowerCase().slice(0, 3)));
      let ahead = (want - now.getDay() + 7) % 7;
      if (found[1] && ahead === 0) ahead = 7;
      day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
      dayGiven = true;
      if (ahead === 0 && plan.timeGiven && new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute) <= now) day.setDate(day.getDate() + 7);
    }
  }
  if (!day) {
    [found, text] = take(text, PATTERNS.date);
    if (found) {
      const month = found[1] ? MONTHS.indexOf(found[1].toLowerCase()) : Number(found[3]) - 1;
      const date = Number(found[2] || found[4]);
      day = new Date(now.getFullYear(), month, date);
      dayGiven = true;
      if (day < new Date(now.getFullYear(), now.getMonth(), now.getDate())) day.setFullYear(day.getFullYear() + 1);
    }
  }
  if (!day) {
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (plan.timeGiven && new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute) <= now) day.setDate(day.getDate() + 1);
    // "every tuesday and thursday 4pm": the first meeting is the next of those days
    if (plan.on?.length) while (!plan.on.includes(DAYS[day.getDay()].slice(0, 3))) day.setDate(day.getDate() + 1);
  }
  plan.day = day;
  // "invite tomas today": find a time today, not the next free slot of the week.
  if (dayGiven && !plan.timeGiven && !weekStart) plan.lookDays = 1;
  if (plan.timeGiven) setStart(plan, new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute));
  else { plan.start = null; plan.end = null; }
  // A word nobody asked for right where a person would go ("and Priscilla") is a person Loggie does not know; any
  // other is left out and said so (the box underlines it before Enter).
  map.words.forEach((w, i) => {
    if (w.role !== 'unused') return;
    const prev = map.words.slice(0, i).reverse().find((x) => !/^[.,;:!?]+$/.test(x.text));
    const word = w.text.replace(/[.,;:!?]+$/, '');
    if (!prev || prev.role === 'action' || /^(?:and|&|\+|,|with|plus)$/i.test(prev.text)) throw new Error(`No one called "${word}" is in your mail. Say the full name or the address.`);
    plan.leftOut.push(word);
  });
  // the people, in the order said
  for (const typed of map.who) {
    const person = personFor(typed, people);
    if (!plan.people.some((p) => p.address === person.address)) plan.people.push(person);
  }
  if (!plan.people.length) {
    if (plan.leftOut.length) throw new Error(`No one called "${plan.leftOut[0]}" is in your mail. Say the full name or the address.`);
    throw new Error('Say who to invite, by name or address.');
  }
  const kind = plan.kind ? ({ '1:1': '1:1', 'one on one': '1:1', 'catch-up': 'Catch-up', catchup: 'Catch-up', 'check-in': 'Check-in', checkin: 'Check-in', 'phone call': 'Call', 'video call': 'Call', 'zoom call': 'Zoom call', 'teams call': 'Teams call' }[plan.kind] || plan.kind[0].toUpperCase() + plan.kind.slice(1)) : 'Meeting';
  if (!plan.title) plan.title = `${kind} with ${plan.people.map((p) => p.name.split(' ')[0]).join(', ')}`;
  return plan;
}

// The start, and the end the length gives it. Throws past midnight.
export function setStart(plan, start) {
  const endAt = new Date(start.getTime() + plan.minutes * 60000);
  if (endAt.getDate() !== start.getDate()) throw new Error('The meeting would run past midnight.');
  plan.start = start;
  plan.end = `${pad(endAt.getHours())}:${pad(endAt.getMinutes())}`;
  return plan;
}

// Times to try, in order: half-hour starts the user's own calendar has free for the whole meeting, in the hours
// searched, from the asked time (or now) over plan.lookDays days. The asked time itself is not repeated.
// A marker (calendar.js isMarker: over 8 hours, no one invited) never blocks. Outlook still judges every time tried
// for the user too, so a marker that does matter is caught there.

export function candidateStarts(plan, events, { now = new Date(), weekends = false, limit = 12 } = {}) {
  events = events.filter((event) => !isMarker(event));
  const from = new Date(Math.max(now.getTime(), (plan.start || plan.day || now).getTime()));
  const days = Math.ceil(((plan.day || now).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000) + plan.lookDays;
  const half = 30 * 60000;
  const out = [];
  for (const { windows } of freeSlots(events, { from, days, minutes: plan.minutes, weekends, ...FIND_HOURS, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })) {
    for (const { start, end } of windows) {
      for (let t = Math.ceil(start.getTime() / half) * half; t + plan.minutes * 60000 <= end.getTime(); t += half) {
        if (plan.start && t === plan.start.getTime()) continue;
        out.push(new Date(t));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// The same repeat as an RFC 5545 rule, for Google's link: FREQ, INTERVAL, BYDAY, then UNTIL or COUNT.
export function rrule(plan) {
  const parts = [`FREQ=${plan.repeat.toUpperCase()}`];
  if (plan.every > 1) parts.push(`INTERVAL=${plan.every}`);
  if (plan.on?.length) parts.push(`BYDAY=${plan.on.map((d) => d.slice(0, 2).toUpperCase()).join(',')}`);
  if (plan.until) parts.push(`UNTIL=${plan.until.replace(/-/g, '')}T235959Z`);
  else if (plan.times) parts.push(`COUNT=${plan.times}`);
  return parts.join(';');
}

// The newest recorded call with any of these people that has a checked summary: its notes become the body.
async function notesFor(people, { callsHome = join(HIKYAKU_HOME, 'calls') } = {}) {
  const want = new Set(people.map((p) => p.address));
  const names = (await readdir(callsHome).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}-\d{4}-/.test(n)).sort().reverse();
  for (const name of names) {
    const folder = join(callsHome, name);
    const read = (file) => readFile(join(folder, file), 'utf8');
    const event = await read('event.json').then(JSON.parse).catch(() => null);
    if (!event || !(event.emails || []).some((address) => want.has(String(address).toLowerCase()))) continue;
    const { notes } = await fromSummary(read).catch(() => ({ notes: '' }));
    if (notes) return { folder: name, html: inviteBody({ summary: notes, event }).html };
  }
  return null;
}

// Fill it. Returns what the helper read back, plus the plan and the seconds it took. Never sends.
export async function quickInvite(plan, { spawnImpl = spawn, execImpl = run, helper = null, clock = Date.now, near = '', eventsImpl = null, now = new Date(), settings = null } = {}) {
  const t0 = clock();
  let tries = [];
  if (plan.calendar === 'outlook' || !plan.timeGiven) {
    const options = settings || await readSettings().catch(() => ({}));
    const from = plan.start || plan.day || now;
    const events = await (eventsImpl || listEvents)({ from: new Date(from.getFullYear(), from.getMonth(), from.getDate()), days: plan.lookDays + 7 }).catch(() => []);
    tries = candidateStarts(plan, events, { now, weekends: Boolean(options.findWeekends) });
    if (!plan.timeGiven) {
      if (!tries.length) throw new Error('Your calendar has no free time in the hours searched. Say a time.');
      setStart(plan, tries.shift());
    }
  }
  const attendees = plan.people.map((p) => p.address);
  let notes = null;
  if (plan.notes) {
    notes = await notesFor(plan.people);
    if (!notes) throw new Error('No recorded call with them has checked notes to put in the body.');
  }
  if (plan.calendar === 'google') {
    const link = new URL(googleEventLink({ title: plan.title, start: plan.start, minutes: plan.minutes, attendees, note: notes ? notes.html.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim() : '' }));
    if (plan.place || plan.room) link.searchParams.set('location', plan.place || plan.room.query);
    if (plan.repeat) link.searchParams.set('recur', `RRULE:${rrule(plan)}`);
    spawnImpl('open', [String(link)], { detached: true, stdio: 'ignore' }).unref?.();
    return { status: 'ready', detail: 'Google Calendar is open with the event filled. Press Save there.', plan, notesFrom: notes?.folder || null, seconds: (clock() - t0) / 1000 };
  }
  spawnImpl('open', [outlookEventLink({ title: plan.title, start: plan.start, attendees })], { detached: true, stdio: 'ignore' }).unref?.();
  const binary = helper || await helperPath({ name: 'outlook-event', source: SOURCE, devHelper: HELPER });
  const args = ['fill', '--subject', plan.title, '--end', plan.end, '--nearest'];
  // Two more times are listed when no time was said; when the asked time is taken they come with the search anyway.
  if (tries.length) args.push('--try', tries.map(stamp).join(','), '--want', '3', ...(!plan.timeGiven ? ['--extras'] : []));
  if (plan.place || plan.room) args.push('--teams', 'off');
  if (plan.repeat) {
    args.push('--repeat', plan.repeat);
    if (plan.every > 1) args.push('--every', String(plan.every));
    if (plan.on?.length) args.push('--on', plan.on.join(','));
    if (plan.until) args.push('--until', plan.until);
    else if (plan.times) args.push('--times', String(plan.times));
    else if (plan.noEnd) args.push('--no-end');
  }
  if (plan.room) args.push('--room-query', plan.room.query, ...(plan.room.floors ? ['--floors', plan.room.floors] : []));
  else if (plan.place) args.push('--location', plan.place, ...(near ? ['--near', near] : []));
  if (notes) {
    const bodyFile = join(tmpdir(), `loggie-invite-${process.pid}.html`);
    await writeFile(bodyFile, notes.html);
    args.push('--body-file', bodyFile);
  }
  const { stdout } = await execImpl(binary, args, { timeout: 30000 }).catch((error) => ({ stdout: error.stdout || JSON.stringify({ status: 'helper_failed', detail: error.message }) }));
  const result = JSON.parse(String(stdout).trim().split('\n').at(-1));
  if (result.time_found && result.time_found !== stamp(plan.start)) {
    const [d, t] = result.time_found.split(' ');
    const [y, mo, da] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
    setStart(plan, new Date(y, mo - 1, da, h, mi));
  }
  return { ...result, plan, notesFrom: notes?.folder || null, seconds: (clock() - t0) / 1000 };
}

// The lines the command prints: what was filled, read back from Outlook, and what is left for the user.
export function describe(result) {
  const { plan } = result;
  const when = plan.start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [
    `Invite: ${plan.title}`,
    `To: ${plan.people.map((p) => `${p.name} <${p.address}>`).join(', ')}`,
    `When: ${when}, to ${result.end_set || plan.end}${result.end_set && result.end_set !== plan.end ? ` (Outlook's nearest end to ${plan.end})` : ''}`,
  ];
  if (result.time_found && !result.time_asked_free) lines.push(plan.timeGiven ? 'The time you asked was taken for someone; this is the first time free for everyone.' : 'The first time free for everyone.');
  if (result.also_free?.length) lines.push(`Also free for everyone: ${result.also_free.map((s) => new Date(s.replace(' ', 'T')).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })).join(', ')}`);
  if (result.location || plan.place) lines.push(`Where: ${result.location || plan.place}${result.location_kept_as_typed ? ' (as typed: Outlook found no match)' : ''}`);
  if (result.room_picked) lines.push(`Room: ${result.room_picked}`);
  if (plan.repeat) lines.push(`Repeats: ${result.repeat_rule || plan.repeat}${plan.until ? ` Ends ${plan.until}.` : plan.times ? ` Ends after ${plan.times} times.` : ''}`);
  if (result.notesFrom) lines.push(`Body: notes from ${result.notesFrom}`);
  for (const p of plan.people) if (p.alternates?.length) lines.push(`${p.name}: used ${p.address} (also ${p.alternates.join(', ')})`);
  if (plan.leftOut?.length) lines.push(`Left out: ${plan.leftOut.join(', ')}`);
  lines.push(result.status === 'ready' ? `${result.detail} (${result.seconds.toFixed(1)} s)` : `Stopped: ${result.detail}`);
  return lines;
}

// `places` are the places the user has used before (places.js); a place typed into a filled invite joins them.
export async function inviteFromSentence(sentence, options = {}) {
  const people = options.people || await loadPeople(options);
  const plan = readSentence(sentence, { people, now: options.now, places: options.places || [] });
  const result = await quickInvite(plan, options);
  if (plan.place && result.status === 'ready' && !options.dontRemember) await rememberPlace(plan.place, options.home ? { home: options.home } : {});
  return result;
}
