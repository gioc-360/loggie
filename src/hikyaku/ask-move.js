// "Move my 3pm with Jamie to Friday" from the ask box (loggie-ask-box increment 9). Code finds the meeting on the
// Mac's calendar (calendar.js, read-only), works out the new day and start, and the Outlook helper
// (native/outlook-move.swift) moves it in its own Outlook window and stops: the user presses Send there. Nothing here
// changes a calendar by itself, and nothing goes to the cloud.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fold } from './ask.js';
import { readSentence } from './quick-invite.js';
import { helperAnswer, helperPath } from './native-helper.js';

const run = promisify(execFile);
const SOURCE = fileURLToPath(new URL('./native/outlook-move.swift', import.meta.url));
const HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-outlook-move');
export const ensureMoveHelper = () => helperPath({ name: 'outlook-move', source: SOURCE, devHelper: HELPER });
const FILLER = new Set(['my', 'the', 'our', 'a', 'an', 'with', 'meeting', 'call', 'event', 'thing', 'appointment', 'at', 'on', 'for', 'and', 'today', 'tomorrow']);
const KIND = new Set(['meeting', 'call', 'sync', 'review', 'interview', 'lunch', 'coffee', 'chat', 'check-in', '1:1']);
const DAY_WORDS = /\b(today|tonight|tomorrow|next week|(?:next )?(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}|\d{1,2}\/\d{1,2})\b/i;
const pad = (n) => String(n).padStart(2, '0');
export const dayLabel = (date) => date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// A time said inside the meeting's words ("my 3pm", "the 1730 call"), as an hour and minute, or null.
function timeIn(text) {
  try {
    const plan = readSentence(`invite zz ${text}`, { people: [{ name: 'Zz', address: 'zz@example.invalid' }] });
    return plan.timeGiven ? { hour: plan.start.getHours(), minute: plan.start.getMinutes() } : null;
  } catch { return null; }
}

// The meeting meant: upcoming (from 2 hours ago, 21 days), not all-day; with the people named among its attendees
// when people are named; scored by title words and a time said. Returns { status: 'one' | 'many' | 'none', event, candidates }.
export function findMeeting(events, { who = [], meeting = '', now = new Date() } = {}) {
  const from = now.getTime() - 2 * 3600000, to = now.getTime() + 21 * 86400000;
  const firsts = who.map((name) => fold(name).split(' ')[0]).filter(Boolean);
  const words = fold(meeting).split(' ').filter((w) => w && !FILLER.has(w) && !firsts.includes(w) && !/^\d/.test(w) && !/^(?:am|pm)$/.test(w));
  const said = fold(meeting).split(' ');
  const hint = timeIn(meeting);
  const dayHint = meeting.match(DAY_WORDS) ? readWhen(meeting.match(DAY_WORDS)[0], { now }).day : null;
  const scored = (events || []).filter((event) => !event.allDay && Date.parse(event.start) >= from && Date.parse(event.start) <= to).map((event) => {
    const start = new Date(event.start);
    const people = [...(event.attendeeNames || []), ...(event.attendees || [])].map((name) => fold(name));
    const hasWho = firsts.every((first) => people.some((person) => person.split(/[ .@]/).includes(first)));
    const title = fold(event.title);
    const titleWords = title.split(' ');
    const wordHits = words.filter((w) => titleWords.some((t) => t.startsWith(w))).length;
    // Weaker hints: a kind word said that the title also has ("the cwg meeting"), a named person in the title
    // ("Meeting with Marisol" over other meetings she is on).
    const kindHits = said.filter((w) => KIND.has(w) && titleWords.includes(w)).length;
    const whoInTitle = firsts.filter((first) => titleWords.includes(first)).length;
    const timeHit = hint ? start.getHours() === hint.hour && start.getMinutes() === hint.minute : false;
    const dayHit = dayHint ? isoDay(start) === isoDay(dayHint) : false;
    return { event, ok: (!firsts.length || hasWho) && (!words.length || wordHits > 0 || timeHit) && (!hint || timeHit) && (!dayHint || dayHit), score: wordHits * 2 + kindHits + whoInTitle * 2 + (timeHit ? 3 : 0) + (dayHit ? 1 : 0) + (hasWho && firsts.length ? 2 : 0) };
  }).filter((item) => item.ok);
  if (!scored.length) return { status: 'none', candidates: [] };
  const best = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === best).sort((a, b) => Date.parse(a.event.start) - Date.parse(b.event.start));
  // Every fit has the same title (a weekly meeting's occurrences, 2026-10-11 real calendar: each ask matched 4): the
  // next one is meant. Different titles that fit equally are a question.
  const next = [];
  for (const item of top) if (!next.some((event) => fold(event.title) === fold(item.event.title))) next.push(item.event);
  if (next.length === 1) return { status: 'one', event: next[0], candidates: [] };
  return { status: 'many', candidates: next.slice(0, 4) };
}

// The words after "to": a day and a start. A day with no time keeps the meeting's start; a time with no day keeps its day.
export function readWhen(text, { now = new Date(), event = null } = {}) {
  const plan = readSentence(`invite zz ${text}`, { people: [{ name: 'Zz', address: 'zz@example.invalid' }], now });
  const original = event ? new Date(event.start) : null;
  const saidDay = DAY_WORDS.test(text);
  const day = saidDay ? plan.day : original ? new Date(original.getFullYear(), original.getMonth(), original.getDate()) : plan.day;
  const hour = plan.timeGiven ? plan.start.getHours() : original ? original.getHours() : null;
  const minute = plan.timeGiven ? plan.start.getMinutes() : original ? original.getMinutes() : null;
  if (hour === null) return { day, start: null };
  return { day, start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute) };
}

export async function moveInOutlook({ title, from, to, dryRun = false, execImpl = run, helper = null }) {
  const binary = helper || await ensureMoveHelper();
  const args = ['move', '--title', title, '--day', dayLabel(from), '--to-day', isoDay(to), '--to-start', `${pad(to.getHours())}:${pad(to.getMinutes())}`];
  if (dryRun) args.push('--dry-run');
  return helperAnswer(execImpl, binary, args, { timeout: 60000 });
}

export async function discardMove({ title, execImpl = run, helper = null }) {
  const binary = helper || await ensureMoveHelper();
  return helperAnswer(execImpl, binary, ['discard', '--title', title], { timeout: 30000 });
}
