// The availability check's pure half (loggie-availability I2, spec gate 2.2): checkReport on made-up records and
// events. A range over an event that blocks is WRONG (exit 1); touching edges are clean; a marker, an all-day item, an
// uninvited read-only feed, or an uninvited event with "Events with no one invited" off are notes (exit 0); fewer
// records than --min is exit 3. And the source scan: the script and its pure half can only read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkReport, overlaps, whyNotBlocking } from '../src/hikyaku/availability-check.js';

const ZONE = 'America/New_York';
const ev = (start, end, extra = {}) => ({ start, end, allDay: false, writable: true, attendees: [], calendar: 'Calendar', account: 'Exchange', title: 'Secret title', ...extra });
const record = (ranges, extra = {}) => ({ kind: 'ask', at: '2026-10-20T16:21:00.000Z', read: 'read', reason: null, window: { timeZone: ZONE }, rules: { selfBlocks: true, minMinutes: 30 },
  days: [{ day: '2026-10-23', ranges: ranges.map(([start, end]) => ({ start, end })) }], ...extra });
// Fri Oct 23, 9 to 11:15am and 12:30 to 1pm ET.
const F1 = record([['2026-10-23T13:00:00.000Z', '2026-10-23T15:15:00.000Z'], ['2026-10-23T16:30:00.000Z', '2026-10-23T17:00:00.000Z']]);

test('2.2 a range over an event that blocks is WRONG, exit 1', () => {
  const out = checkReport({ records: [F1], events: [ev('2026-10-23T14:00:00Z', '2026-10-23T14:30:00Z')] });
  assert.deepEqual(out.lines, ['ask 2026-10-20 2 ranges WRONG', 'judged: 1, wrong: 1, notes: 0']);
  assert.deepEqual([out.judged, out.wrong, out.notes, out.exit], [1, 1, 0, 1]);
  // Inside the rounding margin counts too: an event ending 9:05 starts nothing new, it overlaps 9:00.
  assert.equal(checkReport({ records: [F1], events: [ev('2026-10-23T12:30:00Z', '2026-10-23T13:05:00Z')] }).exit, 1);
});

test('2.2 touching edges are clean', () => {
  const out = checkReport({ records: [F1], events: [ev('2026-10-23T15:15:00Z', '2026-10-23T16:30:00Z'), ev('2026-10-23T17:00:00Z', '2026-10-23T19:00:00Z'), ev('2026-10-23T12:00:00Z', '2026-10-23T13:00:00Z')] });
  assert.deepEqual(out.lines, ['ask 2026-10-20 2 ranges ok', 'judged: 1, wrong: 0, notes: 0']);
  assert.equal(out.exit, 0);
  assert.equal(overlaps({ start: '2026-10-23T13:00:00Z', end: '2026-10-23T15:15:00Z' }, { start: '2026-10-23T15:15:00Z', end: '2026-10-23T16:00:00Z' }), false);
});

test('2.2 a marker, an all-day item, an uninvited read-only feed and an uninvited event with selfBlocks off are notes, exit 0', () => {
  const marker = ev('2026-10-23T11:00:00Z', '2026-10-23T22:00:00Z', { calendar: 'MBA I' });
  const allDay = ev('2026-10-23T04:00:00Z', '2026-10-24T04:00:00Z', { allDay: true });
  const feed = ev('2026-10-23T14:00:00Z', '2026-10-23T15:00:00Z', { writable: false, calendar: 'School feed' });
  assert.deepEqual([whyNotBlocking(marker), whyNotBlocking(allDay), whyNotBlocking(feed)], ['marker', 'all-day', 'feed']);
  const out = checkReport({ records: [F1], events: [marker, allDay, feed] });
  assert.deepEqual(out.lines, ['ask 2026-10-20 2 ranges note', 'judged: 1, wrong: 0, notes: 5']);
  assert.equal(out.exit, 0);
  const own = ev('2026-10-23T14:00:00Z', '2026-10-23T15:00:00Z');
  assert.equal(checkReport({ records: [F1], events: [own] }).exit, 1, 'selfBlocks on: an uninvited block of the user\'s own blocks');
  const off = checkReport({ records: [{ ...F1, rules: { selfBlocks: false, minMinutes: 30 } }], events: [own] });
  assert.deepEqual([off.wrong, off.notes, off.exit], [0, 1, 0]);
  const invited = ev('2026-10-23T14:00:00Z', '2026-10-23T15:00:00Z', { attendees: ['person@example.com'] });
  assert.equal(checkReport({ records: [{ ...F1, rules: { selfBlocks: false } }], events: [invited] }).exit, 1, 'someone invited always blocks');
});

test('2.2 fewer records than --min is exit 3; a WRONG beats it; a record not read is listed and not judged', () => {
  assert.equal(checkReport({ records: [F1], events: [], min: 10 }).exit, 3);
  assert.equal(checkReport({ records: [], events: [], min: 1 }).exit, 3);
  assert.equal(checkReport({ records: [F1], events: [ev('2026-10-23T14:00:00Z', '2026-10-23T14:30:00Z')], min: 10 }).exit, 1);
  const unread = { kind: 'replay', at: '2026-09-01T14:00:00.000Z', domain: 'school.example', read: 'unreadable', reason: 'no calendar access', window: { timeZone: ZONE }, days: [] };
  const full = { ...record([]), kind: 'replay', domain: 'bank.example', days: [] };
  const out = checkReport({ records: [unread, full], events: [], min: 1 });
  assert.deepEqual(out.lines, ['replay 2026-09-01 @school.example not read (no calendar access)', 'replay 2026-10-20 @bank.example 0 ranges ok', 'judged: 1, wrong: 0, notes: 0']);
  assert.equal(out.exit, 0);
});

test('2.2 --show prints the ranges and the overlapping times, never a title, calendar, account or attendee', () => {
  const out = checkReport({ records: [F1], events: [ev('2026-10-23T14:00:00Z', '2026-10-23T14:30:00Z', { attendees: ['person@example.com'] })], show: true });
  assert.deepEqual(out.lines, ['ask 2026-10-20 2 ranges WRONG', '  Fri Oct 23: 9 to 11:15am, 12:30 to 1pm ET', '  WRONG: 9:00 AM to 11:15 AM overlaps an event 10:00 AM to 10:30 AM', 'judged: 1, wrong: 1, notes: 0']);
  const text = out.lines.join('\n');
  for (const word of ['Secret title', 'Exchange', 'Calendar', 'person@example.com']) assert.ok(!text.includes(word), word);
});

test('2.2 source scan: the check and its pure half only read', async () => {
  for (const file of ['scripts/availability/check.mjs', 'src/hikyaku/availability-check.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, names, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(node:fs(?:\/promises)?)'/g)) {
      for (const name of names.split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) assert.ok(['readFile', 'readdir', 'stat'].includes(name), `${file} imports ${name} from ${from}`);
    }
    assert.doesNotMatch(source, /from\s*'node:fs'\s*;?\s*$|import\s+\*\s+as\s+\w+\s+from\s+'node:fs/m, `${file} imports all of node:fs`);
    assert.doesNotMatch(source, /child_process/, `${file} imports child_process`);
    assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rmdir|rm|rename|copyFile|cp|unlink|createWriteStream)(?:Sync)?\s*\(/, `${file} calls a write`);
  }
  // The script calls the helper it finds already built, so a stale or missing one is never rebuilt (a build writes).
  const script = await readFile(new URL('../scripts/availability/check.mjs', import.meta.url), 'utf8');
  for (const call of script.match(/\b(?:listEvents|calendarStatus)\(\{[^)]*\}\)/g)) assert.match(call, /helper/, call);
});
