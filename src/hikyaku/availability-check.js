// The falsifier's count (loggie-availability I2, docs/availability/spec.md section 3, "The check"): every free range
// Loggie wrote into a draft, held against the calendar as it is now. A range that overlaps an event that blocks is
// WRONG and one is enough to kill the build; an overlap with something that never blocks (a marker, an all-day item, an
// uninvited read-only feed, or with "Events with no one invited" off an uninvited event) is a note for Gio to judge.
// Pure: scripts/availability/check.mjs does the reads. Never prints a title, a calendar, an account or an attendee.
//
//   checkReport({ records, events, min, show }) -> { lines, judged, wrong, notes, exit }
//   record = { kind: 'ask' | 'replay', at: ISO, domain?, read, reason?, days: [{ day, ranges: [{ start, end }] }],
//              rules: { selfBlocks }, window: { timeZone } }
import { blocksTime, isMarker } from './calendar.js';
import { formatAvailability } from './availability.js';

const invited = (event) => (event.attendees || []).length > 0;

// Why an event a range overlaps does not block, or null when it blocks (then the overlap is WRONG).
export function whyNotBlocking(event, { selfBlocks = true } = {}) {
  if (blocksTime(event)) return selfBlocks || invited(event) ? null : 'uninvited';
  if (event.allDay) return 'all-day';
  if (isMarker(event)) return 'marker';
  return 'feed';
}

// [a, b) and [s, e) overlap when s < b and e > a; touching edges do not.
export const overlaps = (range, event) => Date.parse(event.start) < Date.parse(range.end) && Date.parse(event.end) > Date.parse(range.start);

const dayOf = (iso, timeZone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const clockOf = (iso, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export function checkReport({ records = [], events = [], min = 1, show = false } = {}) {
  const lines = [];
  let judged = 0, wrong = 0, notes = 0;
  for (const record of records) {
    const timeZone = record.window?.timeZone || 'UTC';
    const head = `${record.kind} ${dayOf(record.at, timeZone)}${record.kind === 'replay' ? ` @${record.domain || 'unknown'}` : ''}`;
    if (record.read !== 'read') {
      lines.push(`${head} not read (${record.reason || record.read})`);
      continue;
    }
    judged += 1;
    const ranges = (record.days || []).flatMap((day) => day.ranges || []);
    const found = [];
    for (const range of ranges) {
      for (const event of events) {
        if (!overlaps(range, event)) continue;
        const why = whyNotBlocking(event, record.rules || {});
        found.push({ range, event, why });
      }
    }
    const bad = found.filter((f) => f.why === null);
    const soft = found.filter((f) => f.why !== null);
    wrong += bad.length;
    notes += soft.length;
    lines.push(`${head} ${ranges.length} range${ranges.length === 1 ? '' : 's'} ${bad.length ? 'WRONG' : soft.length ? 'note' : 'ok'}`);
    if (show) {
      for (const line of (formatAvailability(record.days || [], { timeZone }) || '(no open time)').split('\n')) lines.push(`  ${line}`);
      for (const f of found) {
        lines.push(`  ${f.why === null ? 'WRONG' : `note (${f.why})`}: ${clockOf(f.range.start, timeZone)} to ${clockOf(f.range.end, timeZone)} overlaps an event ${clockOf(f.event.start, timeZone)} to ${clockOf(f.event.end, timeZone)}`);
      }
    }
  }
  lines.push(`judged: ${judged}, wrong: ${wrong}, notes: ${notes}`);
  const exit = wrong > 0 ? 1 : judged < min ? 3 : 0;
  return { lines, judged, wrong, notes, exit };
}
