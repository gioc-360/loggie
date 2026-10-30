// The Meetings week (docs/prototype-port/spec.md, hikyaku:events): the calendar's events for a range of days joined to
// the calls Loggie recorded, so each event says whether it has notes and where they are filed; and every meeting's
// workspace, the one the user said yes to or the router's guess (docs/teammate-ready/spec.md B3). Pure, so node tests
// it on made-up events; main.js does the reading. The page gets how many people are on a meeting and, for the Day
// card, the first names of at most two of them (loggie-meetings-focus: "Coffee chat · Michael"); never an address.
import { titleWords } from '../src/hikyaku/discover.js';
import { PUBLIC_MAIL } from '../src/hikyaku/entry.js';
import { isMine, LINK, TEAMS_MARKER } from '../src/hikyaku/meeting.js';
import { route } from '../src/hikyaku/router.js';

export const JOIN_MINUTES = 15;
// The Day view's sort (loggie-meetings-focus, his week of Oct 26: 82 items, 7 with people). One kind per event:
// people (someone else is on it, or a club meeting by its title), class (a course code), block (his own time, no one
// else on it). Hidden, and counted: a school feed (any copy on a read-only calendar with nobody on it), a mass invite
// (more than MASS people: the 88-person timecard reminder), a second copy of one event, and all-day entries.
export const MASS = 12;
const COURSE = /\b[A-Z]{2,4} ?\d{4}\b/;
// "GPASFC Meeting", "CLC Weekly Meeting": a club's meeting on his calendar with no invitees is still a meeting.
const CLUB = /\bmeeting\b|\b[A-Z]{2,}\b/;
export function sortOf(event) {
  const people = (event.attendees || []).length;
  if (people > MASS) return 'hidden';
  if (COURSE.test(event.title || '')) return 'class';
  if (people) return 'people';
  return CLUB.test(event.title || '') ? 'people' : 'block';
}
// "Sam Lee" -> Sam; "Lee, Sam" (Outlook's order) -> Sam; an address -> its first part.
const firstName = (value) => {
  const plain = String(value || '').replace(/<[^>]*>/, '').replace(/@.*/, '').trim();
  const given = plain.includes(',') ? plain.split(',')[1] : plain;
  return given.trim().split(/[\s.]+/)[0] || '';
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The room and whether a join link is there, for Record both's side rule (meetings-day-model.js sideOf, 2026-10-28):
// a room with no link is the room he sits in. "Zoom (Canvas)" names no room.
function placeOf(location) {
  const parts = String(location || '').trim().split(/\s+/).filter(Boolean);
  const link = parts.some((part) => LINK.test(part)) || TEAMS_MARKER.test(location || '') || /\bzoom\b/i.test(location || '');
  return { place: link ? null : parts.join(' ') || null, link };
}

// from and to are YYYY-MM-DD, to after from, at most 31 days apart. Returns the number of days to read.
export function checkRange(from, to) {
  const start = DAY.test(String(from)) ? Date.parse(`${from}T12:00:00Z`) : NaN;
  const end = DAY.test(String(to)) ? Date.parse(`${to}T12:00:00Z`) : NaN;
  const days = Math.round((end - start) / 86400000);
  if (!Number.isFinite(days) || days < 1 || days > 31) throw new Error('Dates must be YYYY-MM-DD, up to 31 days.');
  return days;
}

// The key and item the change check makes for one occurrence (sources.js calendarItems), so a Yes here and a line
// the change check logged name the same meeting.
export const eventKey = (event) => `${event.id}@${new Date(event.start).toISOString()}`;
export function eventItem(event, { ref } = {}) {
  const attendees = event.attendees || [];
  return {
    source: 'calendar', at: event.start, title: event.title || '', ref: ref || eventKey(event), thread: event.id, recipients: attendees.length,
    who: attendees.map((address, index) => ({ name: event.attendeeNames?.[index] || '', address: String(address || '').toLowerCase() })),
  };
}
// A new workspace seeded only from one meeting (first-run-polish B3.3): its people less the user's own addresses, their
// domains less public mail and the user's own organization (entry.js startWorkstream's rule), and words from its title.
// A name pairs with its address only when calendar.swift kept a name for every attendee; a shorter list cannot pair.
export function seedFromEvent(event, { ownAddresses = [], ownNames = [] } = {}) {
  const own = ownAddresses.map((address) => String(address || '').trim().toLowerCase()).filter((address) => address.includes('@'));
  const ownDomains = own.map((address) => address.split('@').pop());
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  const names = Array.isArray(event?.attendeeNames) && event.attendeeNames.length === attendees.length ? event.attendeeNames : null;
  const people = [];
  attendees.forEach((raw, index) => {
    const address = String(raw || '').trim().toLowerCase();
    if (!address.includes('@') || own.includes(address) || people.some((person) => person.address === address)) return;
    people.push({ name: names ? String(names[index] || '').trim() : '', address });
  });
  const domains = [...new Set(people.map((person) => person.address.split('@').pop()))]
    .filter((domain) => domain && !PUBLIC_MAIL.has(domain) && !ownDomains.some((mine) => domain === mine || domain.endsWith(`.${mine}`)));
  const words = titleWords(event?.title || '', { ownNames: [...ownNames, ...own.map((address) => address.split('@')[0])].filter(Boolean) });
  return { people, domains, words };
}

const askedFor = (line, event) => line?.source === 'calendar' && line.how === 'asked' && line.thread === event.id;
// Each answer on one meeting gets its own ref (key, key#2, ...), so a Change after a Yes is a new line, never a
// duplicate the log would drop (spec C8).
export function answerRef(lines, event) {
  const key = eventKey(event);
  const n = (lines || []).filter((line) => askedFor(line, event) && String(line.ref || '').startsWith(key)).length;
  return n === 0 ? key : `${key}#${n + 1}`;
}

// Each meeting's workspace, first match wins: the user's own Yes (it files the series: one id for every occurrence),
// the router now (domains and people as they are today), the change check's logged guess, the router's first
// candidate. Only names of workspaces that still exist come back.
export function routeEvents(events, { lines = [], workstreams = [], learned = new Map(), threads = new Map() } = {}) {
  const names = new Set(workstreams.filter((w) => !w.inbox && !w.chats && !w.folder).map((w) => w.name));
  const out = new Map();
  for (const event of events || []) {
    if (!event || event.allDay || Number.isNaN(Date.parse(event.start))) continue;
    const key = eventKey(event);
    const asked = (lines || []).filter((line) => askedFor(line, event) && names.has(line.workstream)).at(-1);
    if (asked) { out.set(key, { workstream: asked.workstream, guess: null, how: 'asked', filed: true }); continue; }
    const routed = route(eventItem(event), { workstreams, learned, threads });
    if (routed.workstream && names.has(routed.workstream)) { out.set(key, { workstream: null, guess: routed.workstream, how: routed.how, filed: false }); continue; }
    const logged = (lines || []).filter((line) => line?.source === 'calendar' && line.ref === key && !line.workstream && names.has(line.candidates?.[0])).at(-1);
    const guess = logged?.candidates[0] || (names.has(routed.candidates?.[0]) ? routed.candidates[0] : null);
    out.set(key, { workstream: null, guess, how: guess ? 'suggested' : null, filed: false });
  }
  return out;
}

function markOf(call, start, now) {
  if (call?.state === 'recording') return 'recording';
  if (call?.workstream) return 'filed';
  if (call && !['empty', 'failed'].includes(call.state)) return 'notes';
  if (!call && Date.parse(start) > now) return 'upcoming';
  return 'none';
}

// events: listEvents rows; calls: listCalls rows. A call joins the event he pressed Record on (its id, kept in event.json,
// while the call starts between that event's start less JOIN_MINUTES and its end), else the not-all-day event of his
// (meeting.js isMine, `recordCalendars` from Settings) whose start is nearest its own, within JOIN_MINUTES either way;
// the nearer pair wins; a call in the range with no event stands alone. A call's start is the press (call-list.js reads
// recorded_at first), and a shared calendar's block never takes it (2026-10-27: the M&T interview sat under Sage Hall).
// Each event row says whether it is his (`mine`, any copy of it): only his fill the Day card (meetings-day-model.js).
export function joinWeek(events = [], calls = [], { from, to, now = Date.now(), calendar = 'granted', routes = new Map(), recordCalendars = null } = {}) {
  const low = new Date(`${from}T00:00:00`).getTime();
  const high = new Date(`${to}T00:00:00`).getTime();
  const inRange = (start) => { const at = Date.parse(start); return at >= low && at < high; };
  // Meetings only: an all-day entry (a holiday, a deadline) and a read-only calendar's event with nobody on it (a class
  // feed) are not calls; one event seen through two calendars or accounts shows once (as sources.js calendarItems).
  const seen = new Set();
  const keyOf = (event) => `${String(event.title || '').trim().toLowerCase()}@${Date.parse(event.start)}`;
  // A feed is an event some calendar holds read-only with nobody on it, when no copy of it has anyone on it and it is
  // not a class: the school's copy and his subscribed twin are both the feed (Oct 26: "Coffee Time" on MBAI and MBA I),
  // but office hours with a professor and a class he takes stay, though a read-only copy of each exists too.
  const withPeople = new Set((events || []).filter((event) => event && (event.attendees || []).length).map(keyOf));
  const feeds = new Set((events || []).filter((event) => event && event.writable === false && !(event.attendees || []).length && !COURSE.test(event.title || '')).map(keyOf).filter((key) => !withPeople.has(key)));
  const mineKeys = new Set((events || []).filter((event) => event && isMine(event, { recordCalendars })).map(keyOf));
  // The copy he pressed may not be the copy shown (the Google copy shows, the Exchange copy with the link records).
  const keyOfId = new Map((events || []).filter((event) => event?.id).map((event) => [`${event.id}@${Date.parse(event.start)}`, keyOf(event)]));
  const pressedKeys = (id) => new Set([...keyOfId].filter(([key]) => key.startsWith(`${id}@`)).map(([, key]) => key));
  const hidden = [];
  const hide = (event, why) => { if (event && inRange(event.start)) hidden.push({ day: dayOf(event.start), why, title: event.title || '', start: event.start }); };
  const shown = (events || []).filter((event) => {
    if (!event || !inRange(event.start)) return false;
    if (event.allDay) { hide(event, 'all day'); return false; }
    const key = keyOf(event);
    if (seen.has(key)) { hide(event, 'duplicate'); return false; }
    // The copy that shows is one with people on it, when there is one (it carries the names and the count).
    if (withPeople.has(key) && !(event.attendees || []).length) { hide(event, 'duplicate'); return false; }
    seen.add(key);
    if (feeds.has(key)) { hide(event, 'school feed'); return false; }
    if (sortOf(event) === 'hidden') { hide(event, `${(event.attendees || []).length} people`); return false; }
    return true;
  });
  const near = (calls || []).filter((call) => call?.start && inRange(call.start));
  const pairs = [];
  for (const [e, event] of shown.entries()) {
    for (const [c, call] of near.entries()) {
      const at = Date.parse(call.start);
      const gap = Math.abs(Date.parse(event.start) - at);
      const pressed = call.eventId && pressedKeys(call.eventId).has(keyOf(event)) && at >= Date.parse(event.start) - JOIN_MINUTES * 60000 && at < Date.parse(event.end || event.start);
      if (pressed) pairs.push({ e, c, gap: -1 });
      else if (gap <= JOIN_MINUTES * 60000 && mineKeys.has(keyOf(event))) pairs.push({ e, c, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);
  const callOf = new Map();
  const taken = new Set();
  for (const pair of pairs) {
    if (callOf.has(pair.e) || taken.has(pair.c)) continue;
    callOf.set(pair.e, near[pair.c]);
    taken.add(pair.c);
  }
  const at = Number(now instanceof Date ? now.getTime() : now);
  const item = (kind, id, title, start, end, allDay, people, call, routed = null, event = null, mine = true) => {
    const fromCall = call ? { workstream: call.workstream || null, guess: call.guess || routed?.guess || null, filed: Boolean(call.workstream), how: call.workstream ? 'filed' : (routed?.guess ? routed.how : null) } : null;
    const fromRoute = { workstream: routed?.filed ? routed.workstream : null, guess: routed?.guess || null, filed: Boolean(routed?.filed), how: routed?.how || null };
    return {
      kind, id, title, start, end: end || null, allDay: Boolean(allDay), people, call: call?.id || null, state: call?.state || null, mine,
      sort: event ? sortOf(event) : 'people', ...placeOf(event?.location),
      who: event ? (event.attendeeNames || []).map(firstName).filter(Boolean).slice(0, 2) : [],
      ...(fromCall || fromRoute), mark: markOf(call, start, at),
    };
  };
  const items = [
    // A call he renamed shows his title on its row (call-notes.js renameCall, 2026-10-27).
    ...shown.map((event, e) => item('event', event.id, (callOf.get(e)?.titleByHand && callOf.get(e).title) || event.title || 'Untitled event', event.start, event.end, event.allDay, (event.attendees || []).length, callOf.get(e), routes.get(eventKey(event)), event, mineKeys.has(keyOf(event)))),
    ...near.filter((call, c) => !taken.has(c)).map((call) => item('call', `call:${call.id}`, call.title || call.id, call.start, null, false, Number(call.people) || 0, call)),
  ];
  items.sort((a, b) => (Date.parse(a.start) - Date.parse(b.start)) || a.title.localeCompare(b.title));
  return { calendar, items, hidden };
}
// A local YYYY-MM-DD, the day an event starts on this Mac.
function dayOf(start) {
  const at = new Date(start);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}
