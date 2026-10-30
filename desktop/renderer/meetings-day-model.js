// The Day view's decisions (loggie-meetings-focus): one day's rows, the week strip's dots, the one card, and the line
// that counts what was hidden. Pure, so node tests it; meetings-day.js draws it. Items are hikyaku:events rows
// (desktop/week-events.js joinWeek: sort people | class | block), calls are hikyaku:calls rows.

const DAY_MS = 86400000;
// The card yields an unfiled call to a meeting or class starting this soon (cycle 2: "Until filed or next meeting").
export const YIELD_MINUTES = 10;
export const NEXT_GRACE_MINUTES = 10;

export const isoDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const dayOf = (start) => isoDay(new Date(start));
export function mondayOf(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  return new Date(day.getTime() - ((day.getDay() + 6) % 7) * DAY_MS);
}
export const weekDays = (monday) => Array.from({ length: 7 }, (_, index) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, 12));

// One day's rows in time order.
export const dayRows = (items, day) => items.filter((item) => dayOf(item.start) === day).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

// What the card can show: a meeting with people, or a class (he records classes: Strategy, Macro). A block shows as a
// band and is recorded from its row (TC3, Gio 2026-10-25: "sometimes you block it but wanna record that block ... keep
// it simple": every row has Record, the sort only sets how loud a row looks). Only his (2026-10-27, week-events.js
// `mine`): a club night on the school's shared calendar is a row with Record, never the card.
export const isCardable = (item) => item.mine !== false && (item.sort === 'people' || item.sort === 'class');

// The week strip: per day, how many meetings and classes. 0 to 4 shows as dots, more as a digit.
export function weekDots(items, monday) {
  return weekDays(monday).map((date) => {
    const day = isoDay(date);
    const count = items.filter((item) => isCardable(item) && dayOf(item.start) === day).length;
    return { day, count, mark: count > 4 ? String(count) : '●'.repeat(count) };
  });
}

// Record both (split-recording-proposal.md, 2026-10-28): Thursday's case kickoff on Zoom runs 40 min into Macro, and
// one recording can hold both, the room on the mic and the Zoom on the Mac's sound. The side rule: a course code or a
// room, and no join link, is the room he sits in; anything else is the Mac's sound.
export const sideOf = (item) => ((item.sort === 'class' || item.place) && !item.link ? 'room' : 'mac');
// Two of his, not recorded, under way or starting within YIELD_MINUTES, that overlap each other: { room, mac }, or
// { tie: [a, b] } when the rule cannot tell (the card asks which one is in the room), else null. Meetings and classes
// come before blocks (a kickoff with nobody on it is a block), then the earlier start.
export function bothFor({ items = [], now = new Date() } = {}) {
  const at = now.getTime();
  const end = (item) => Date.parse(item.end || item.start);
  const open = items.filter((item) => item.mine !== false && !item.call && dayOf(item.start) === isoDay(now) && Date.parse(item.start) <= at + YIELD_MINUTES * 60000 && end(item) > at)
    .sort((a, b) => (a.sort === 'block') - (b.sort === 'block') || Date.parse(a.start) - Date.parse(b.start));
  const first = open[0];
  const second = first && open.slice(1).find((item) => Date.parse(item.start) < end(first) && Date.parse(first.start) < end(item));
  if (!second) return null;
  if (sideOf(first) === sideOf(second)) return { tie: [first, second] };
  return sideOf(first) === 'room' ? { room: first, mac: second } : { room: second, mac: first };
}

// The one card, first match wins (scope § 6, cycle 2's andon): a call recording now; two of his at once (Record both); the newest call that ended today
// and is not both summarized and filed, held until it is (no time limit), unless he pressed Leave it (`left`) or a
// meeting or class starts within YIELD_MINUTES; the next meeting or class today that started at most
// NEXT_GRACE_MINUTES ago and is not recorded yet; else nothing left today, with tomorrow's first one.
export function cardFor({ items = [], calls = [], now = new Date(), left = new Set() } = {}) {
  const at = now.getTime();
  const live = calls.find((call) => call.state === 'recording');
  if (live) return { mode: 'recording', call: live };
  const both = bothFor({ items, now });
  if (both) return { mode: 'both', ...both };
  const today = isoDay(now);
  const people = items.filter((item) => isCardable(item) && !item.call).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const next = people.find((item) => dayOf(item.start) === today && Date.parse(item.start) >= at - NEXT_GRACE_MINUTES * 60000);
  const soon = next && Date.parse(next.start) - at <= YIELD_MINUTES * 60000;
  const ended = calls.filter((call) => call.start && dayOf(call.start) === today && ['done', 'waiting', 'writing', 'transcribing'].includes(call.state) && !left.has(call.id))
    .map((call) => ({ call, end: Date.parse(call.start) + (Number(call.minutes) || 0) * 60000 }))
    .filter(({ call, end }) => at >= end && !(call.state === 'done' && (call.workstream || call.noWorkspace)))
    .sort((a, b) => b.end - a.end)[0];
  if (ended && !soon) return { mode: 'ended', call: ended.call, minutes: Number(ended.call.minutes) || 0 };
  if (next) return { mode: 'next', item: next, inMinutes: Math.round((Date.parse(next.start) - at) / 60000) };
  const tomorrow = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12));
  return { mode: 'none', tomorrow: people.find((item) => dayOf(item.start) === tomorrow) || null };
}

// "in 25 min", "now", "in 1 h 30 min", or the clock time when it is 3 h or more away.
export function whenLine(inMinutes, start) {
  if (inMinutes <= 0) return 'now';
  if (inMinutes < 60) return `in ${inMinutes} min`;
  if (inMinutes < 180) return `in ${Math.floor(inMinutes / 60)} h${inMinutes % 60 ? ` ${inMinutes % 60} min` : ''}`;
  return new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "Hidden: 2 school items, 7 duplicates" for one day, or '' when nothing was hidden.
const HIDDEN_WORDS = [['school feed', 'school item', 'school items'], ['duplicate', 'duplicate', 'duplicates'], ['all day', 'all-day item', 'all-day items']];
export function hiddenLine(hidden = [], day) {
  const mine = hidden.filter((item) => item.day === day);
  if (!mine.length) return '';
  const parts = HIDDEN_WORDS.map(([why, one, many]) => { const n = mine.filter((item) => item.why === why).length; return n ? `${n} ${n === 1 ? one : many}` : ''; });
  const mass = mine.filter((item) => / people$/.test(item.why)).length;
  if (mass) parts.push(`${mass} ${mass === 1 ? 'mass invite' : 'mass invites'}`);
  return `Hidden: ${parts.filter(Boolean).join(', ')}`;
}

// The preview under New workspace… (first-run-polish B3.3), from hikyaku:event-seed's counts, domains and words: what
// mail the new workspace will follow, never an address.
const andList = (items, last) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`);
export function seedLine(seed) {
  const people = Number(seed?.people) || 0;
  const domains = (Array.isArray(seed?.domains) ? seed.domains : []).slice(0, 3);
  const words = (Array.isArray(seed?.words) ? seed.words : []).slice(0, 3).map((word) => `“${word}”`);
  const from = people ? `Mail from ${people} ${people === 1 ? 'person' : 'people'}${domains.length ? ` at ${andList(domains, 'and')}` : ''}` : '';
  const says = words.length ? `mail that says ${andList(words, 'or')}` : '';
  if (from && says) return `${from}, and ${says}.`;
  if (from) return `${from}.`;
  if (says) return `M${says.slice(1)}.`;
  return 'Only this meeting and its repeats will file here.';
}
