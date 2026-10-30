// A calendar event, or a mic signal, becomes the event call.py start takes as its third argument (spec-c.md B14).
// Pure: no calendar, no clock of its own. Emails are never dropped, because call.py files the call by them (B16);
// names are capped, because they become the voice hint and the lexicon.
import { flipName } from './ask-who.js';

export const MAX_NAMED = 8;

export function callEvent(event, { now = new Date(), maxNamed = MAX_NAMED } = {}) {
  if (event.source === 'mic') return { title: event.title || 'Zoom call', start: new Date(now).toISOString(), emails: [], names: '', attendees: '', source: 'mic' };
  // Exchange stores "Cartwright, Kaitlyn": dropping the comma made "Cartwright Kaitlyn", a first name nobody says (2026-10-27).
  const names = (event.attendeeNames || []).slice(0, maxNamed).map((name) => flipName(String(name)).replace(/,/g, '')).join(', ');
  return {
    title: event.title, start: event.start, end: event.end, id: event.id, emails: [...(event.attendees || [])], names, attendees: names,
    location: event.location || '', source: 'calendar',
  };
}

// --- B11: a calendar event becomes a meeting candidate, and the same event on several calendars folds into one.
// A join link is any zoom.us URL (FA audit 9.2), a Teams meetup-join or teams.live.com link, or a Google Meet link.
export const LINK = /zoom\.us\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com|meet\.google\.com\//i;
// Teams invites in this calendar carry the marker in location and no URL (B12 row 3).
export const TEAMS_MARKER = /microsoft teams meeting/i;
// A course code in the title, as `loggie record arm` reads it: a class, which arm records on purpose.
export const COURSE = /\b[A-Z]{2,4}\s?\d{4}\b/;
export const OFFER_BEFORE_S = 120;        // the offer opens this long before the start, and closes at the end
export const MAX_MEETING_MINUTES = 240;   // longer than this with no link is a block, not a meeting
export const MAX_OFFER_PEOPLE = 30;       // more than this with no place is a mailing-list reminder

// --- His calendar (meetings-granola-proposal.md c 1.4, 2026-10-27). The 2:58 PM press of Oct 27 recorded the school's
// "Let's Talk in Sage Hall" block (MBA I, writable, nobody on it) over his M&T interview two minutes later: writable
// cannot tell his calendar from the school's. An event is his when he is on it (he organized it, or he is invited and
// has not declined), or when nobody is on it and its calendar is one he records from. settings.json "recordCalendars"
// is that list of calendar ids; absent, each account's main calendar: one titled "Calendar" or with the account's own
// name or address. Not the store's default for new events: on his Mac that is iCloud "Work", which he keeps off.
export const MY_REPLIES = new Set(['accepted', 'tentative', 'pending']);
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The owner's names (settings signName, the Mac's full name), set at launch: a Google calendar is often titled after
// its owner ("Jess Lu" on account "Google", 2026-10-28), which none of the rules below catch.
let OWNER = [];
export function setCalendarOwner(names = []) {
  OWNER = [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
}
// Titled after him: exactly one of his names, or two words starting with his first name ("Jess Lu" for "Jess").
const ownerTitled = (title) => {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const firsts = new Set(OWNER.map((name) => name.split(' ')[0]));
  return OWNER.includes(words.join(' ')) || (words.length === 2 && firsts.has(words[0]));
};
// calendar: { title, account, type, writable }, as the helper's `calendars` lists it.
export function isMainCalendar(calendar) {
  const title = String(calendar?.title || '');
  if (calendar?.writable === false || ['subscription', 'birthday'].includes(calendar?.type)) return false;
  return title === 'Calendar' || title === String(calendar?.account || '') || ADDRESS.test(title) || ownerTitled(title);
}
export const recordCalendarsOf = (calendars = []) => calendars.filter(isMainCalendar).map((calendar) => calendar.id);
// The saved list, or null when none was saved (or it is not a list of ids): then the default rule decides.
export const recordCalendarsSaved = (settings) => (Array.isArray(settings?.recordCalendars) ? settings.recordCalendars.filter((id) => typeof id === 'string') : null);
const calendarOf = (event) => ({ id: event.calendarId, title: event.calendar, account: event.account, type: event.calendarType, writable: event.writable });
export function onRecordList(event, recordCalendars = null) {
  if (Array.isArray(recordCalendars)) return recordCalendars.includes(event?.calendarId);
  return isMainCalendar(calendarOf(event || {}));
}
export function isMine(event, { recordCalendars = null } = {}) {
  if (!event) return false;
  if (event.organizerIsMe === true || MY_REPLIES.has(event.myStatus)) return true;
  return !(event.attendees || []).length && onRecordList(event, recordCalendars);
}

// The candidate keeps the calendar event it came from, so the click can hand call.py the full event (B14).
export function candidateOf(event, { recordCalendars = null } = {}) {
  const location = String(event.location || '').trim();
  const parts = location.split(/\s+/).filter(Boolean);
  const link = parts.find((part) => LINK.test(part)) || null;
  const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
  return {
    key: `${event.title}|${event.start}`, title: event.title, start: event.start, end: event.end, minutes: Number.isFinite(minutes) ? minutes : 0,
    people: (event.attendees || []).length, names: [...(event.attendeeNames || [])], emails: [...(event.attendees || [])],
    link, teams: TEAMS_MARKER.test(location), place: parts.filter((part) => part !== link).join(' ') || null,
    course: COURSE.test(String(event.title || '')), allDay: Boolean(event.allDay), mine: isMine(event, { recordCalendars }), event,
  };
}

// One candidate per key: his copy (isMine, 2026-10-27), then the most attendees, then the one with a link (FA audit
// 9.3), so the names derive() files by are never lost to a calendar copy without them.
export function candidates(events, { recordCalendars = null } = {}) {
  const best = new Map();
  const better = (a, b) => (a.mine !== b.mine ? a.mine : a.people !== b.people ? a.people > b.people : Boolean(a.link && !b.link));
  for (const event of events) {
    const candidate = candidateOf(event, { recordCalendars });
    const kept = best.get(candidate.key);
    if (!kept || better(candidate, kept)) best.set(candidate.key, candidate);
  }
  return [...best.values()];
}

// --- B12: is this a meeting, and which one to offer now. Pure: `now` is given, never read.
export function isMeeting(candidate) {
  if (candidate.allDay) return false;
  if (candidate.link || candidate.teams) return true;
  return candidate.people >= 1 && candidate.minutes <= MAX_MEETING_MINUTES && !(candidate.people > MAX_OFFER_PEOPLE && !candidate.place);
}

export function linkKind(candidate) {
  if (candidate.link) return /zoom\.us\//i.test(candidate.link) ? 'zoom' : /meet\.google\.com\//i.test(candidate.link) ? 'meet' : 'teams';
  return candidate.teams ? 'marker' : null;
}

// Rules in order, the first that applies wins: recording, the live offer until its meeting ends, the best candidate of
// his in its window (link first, then more people, then the earlier start), an app holding the mic (B13), else none.
// A shared or subscribed calendar's event is never offered (2026-10-27): its row on the Day view still has Record.
export function offerDecision({ candidates: list = [], now, recording = null, dismissed = new Set(), live = null, micApps = [] }) {
  const at = new Date(now).getTime();
  if (recording) return { offer: null, reason: 'recording' };
  if (live && (live.end === null || at < Date.parse(live.end))) return { offer: live, reason: 'live' };
  const open = list
    .filter((candidate) => !dismissed.has(candidate.key) && candidate.mine && isMeeting(candidate) && Date.parse(candidate.start) - OFFER_BEFORE_S * 1000 <= at && at < Date.parse(candidate.end))
    .sort((a, b) => (b.link ? 1 : 0) - (a.link ? 1 : 0) || b.people - a.people || Date.parse(a.start) - Date.parse(b.start));
  if (open.length) {
    const [c] = open;
    const reason = c.link ? 'link' : c.teams ? 'teams' : 'people';
    return { offer: { source: 'calendar', key: c.key, title: c.title, start: c.start, end: c.end, people: c.people, names: [...c.names], emails: [...c.emails], place: c.place, link_kind: linkKind(c), reason }, reason };
  }
  const [app] = micApps.filter((candidate) => !dismissed.has(`mic|${candidate.bundle}`));
  if (app) {
    return { offer: { source: 'mic', key: `mic|${app.bundle}`, title: `${app.label} call`, start: new Date(at).toISOString(), end: null, people: 0, names: [], emails: [], place: null, link_kind: null, reason: 'mic' }, reason: 'mic' };
  }
  return { offer: null, reason: 'none' };
}

// --- One pick rule for a Record press with no event of its own (the top row's "Meeting 2:58 PM", 2026-10-27): his
// events only (isMine: a block with nobody on it counts only on a calendar he records from), not all day, at most
// LONG_BLOCK_S long, in the offer's window (OFFER_BEFORE_S before the start to the end). Then a join link or the Teams
// marker first, then the one whose app holds the mic, then the nearest start, then more people. None: null, and the
// press records a mic call with the typed title. Browsers count only for a Google Meet link.
const BROWSERS = new Set(['Chrome', 'Safari', 'Firefox', 'Edge', 'Arc', 'Brave']);
export function onMic(candidate, micApps = []) {
  const kind = linkKind(candidate);
  return micApps.some(({ label }) => (label === 'Zoom' && kind === 'zoom') || (label === 'Teams' && (kind === 'teams' || kind === 'marker')) || (BROWSERS.has(label) && kind === 'meet'));
}
export function pickNow(list = [], now, micApps = []) {
  const at = new Date(now).getTime();
  const near = (c) => Math.abs(Date.parse(c.start) - at);
  return list
    .filter((c) => c.event && c.mine && !c.allDay && Date.parse(c.end) - Date.parse(c.start) <= LONG_BLOCK_S * 1000
      && Date.parse(c.start) - OFFER_BEFORE_S * 1000 <= at && at < Date.parse(c.end))
    .sort((a, b) => (b.link || b.teams ? 1 : 0) - (a.link || a.teams ? 1 : 0) || (onMic(b, micApps) ? 1 : 0) - (onMic(a, micApps) ? 1 : 0)
      || near(a) - near(b) || b.people - a.people)[0] || null;
}

// --- B15: has the meeting ended. Pure: `now` is given, never read; it only asks, it never stops anything (M4).
// The numbers are estimates from priority-30b-e.md M4 ("mic free 2 min", "event ends + 10"); tune them, do not drop them.
export const END_TEXT = 'Done? Write it up.';
export const MIC_RELEASE_S = 120;   // a meeting app seen during this recording has let go of the mic this long
export const EVENT_END_S = 600;     // a calendar call is past its event's end this long, and no meeting app holds the mic
export const REASK_S = 1800;        // an ask repeats no sooner than this after the last ("keep going")
// Gio, 2026-10-10 (TC2 "As proposed"): the end is never waited on forever. A meeting app holding the mic used to hold the
// ask back past the event's end for good, and a recording with no known end (not started from the offer, or the app
// restarted) waited for good: the Oct 9 7:12 PM call never asked. Now the event end + 600 s asks even with an app on the
// mic, and with no end known the ask comes 3600 s in, then every REASK_S.
export const UNKNOWN_END_S = 3600;
export const LONG_BLOCK_S = 4 * 3600;   // an "event" longer than this is a block (a 37-hour expo), not a meeting: its end is no end

// recording: { call, startedAt, source: "calendar" | "mic" | null, event: { start, end } | null, seen: [bundle, ...] } or null. `seen` is
// every meeting app that held the mic during this recording. apps: B13's { held, released } with `since`. asked: ISO
// of the last ask for this call, or null.
export function endDecision({ recording, now, apps = { held: [], released: [] }, asked = null }) {
  const at = new Date(now).getTime();
  if (!recording) return { ask: false, reason: 'not_recording' };
  if (asked && at - Date.parse(asked) < REASK_S * 1000) return { ask: false, reason: 'asked_lately' };
  const ev = recording.event;
  const block = ev?.start && ev?.end && Date.parse(ev.end) - Date.parse(ev.start) > LONG_BLOCK_S * 1000;
  const end = ev?.end && !block ? Date.parse(ev.end) : NaN;
  if (at >= end + EVENT_END_S * 1000) return { ask: true, reason: 'event_ended', since: new Date(end).toISOString() };
  const started = recording.startedAt ? Date.parse(recording.startedAt) : NaN;
  if (Number.isNaN(end) && at >= started + UNKNOWN_END_S * 1000) return { ask: true, reason: 'no_end_known', since: new Date(started).toISOString() };
  if (apps.held.length) return { ask: false, reason: 'mic_held' };
  const gone = apps.released.filter((app) => recording.seen.includes(app.bundle) && at - Date.parse(app.since) >= MIC_RELEASE_S * 1000)
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since)).at(-1);
  if (gone) return { ask: true, reason: 'mic_released', since: gone.since };
  return { ask: false, reason: 'waiting' };
}
