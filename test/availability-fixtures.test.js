// The fixture set (loggie-availability I2, docs/availability/spec.md section 3, gate 2.1): F1 to F14, written in the
// spec by hand before the code, each an ask, a made-up calendar and the answer: the cue, the window, the read, the
// words, the fill and the note. The answers are the spec's and are never changed to fit the code. Made-up events only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { availabilityAsked, availabilityFor, availabilityReport, availabilitySettings, fillTimes, readWindow, strayTimes } from '../src/hikyaku/availability.js';
import { blocksTime } from '../src/hikyaku/calendar.js';

const DIR = new URL('./fixtures/availability/', import.meta.url);
const names = (await readdir(DIR)).filter((name) => /^F\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
const fixtures = await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(name, DIR), 'utf8'))));

// What the ask box does with one fixture, from the cue to the filled draft, with the calendar reader faked.
async function run(f) {
  const asked = availabilityAsked({ typed: f.typed, line: f.line, email: f.email });
  let readerCalls = 0;
  if (!asked) return { asked, window: null, read: null, text: '', how: null, note: '', body: f.draft, readerCalls, availability: null };
  const settings = availabilitySettings(f.settings, { macZone: f.macZone });
  const now = new Date(f.now);
  const window = readWindow({ typed: f.typed, email: f.email, emailAt: f.emailAt, now, settings });
  const eventsImpl = async () => { readerCalls += 1; if (f.throws) throw new Error(f.throws); return f.events; };
  const read = await availabilityFor({ window, settings, eventsImpl, statusImpl: async () => f.status, now });
  const fill = fillTimes(f.draft, read, {});
  const stray = read.read === 'read' && read.days.length ? strayTimes(fill.text, read.days, { skip: fill.block, timeZone: window.timeZone }) : { text: fill.text, removed: [] };
  const report = availabilityReport({ asked, availability: read, how: fill.how, stray });
  return { asked, window, read: read.read, text: read.text, how: fill.how, note: report.note, body: stray.text, readerCalls, availability: read, settings };
}

test('2.1 the set holds F1 to F14', () => {
  assert.deepEqual(fixtures.map((f) => f.id), Array.from({ length: 14 }, (_, i) => `F${i + 1}`));
});

for (const f of fixtures) {
  test(`2.1 fixture ${f.id}: ${f.typed}`, async () => {
    const out = await run(f);
    const want = f.expect;
    assert.equal(out.asked, want.asked, 'asked');
    if (want.window === null) assert.equal(out.window, null, 'window');
    else {
      assert.deepEqual([out.window.days, out.window.startMinute, out.window.endMinute, out.window.minutes], [want.window.days, want.window.startMinute, want.window.endMinute, want.window.minutes], 'window');
      if (want.window.from) assert.equal(out.window.from.days, want.window.from.days, 'window from.days');
    }
    assert.equal(out.read, want.read, 'read');
    assert.equal(out.text, want.text, 'text');
    assert.equal(out.how, want.how, 'how');
    assert.equal(out.note, want.note, 'note');
    assert.equal(out.body, want.body, 'body');
    assert.equal(out.readerCalls, want.readerCalls, 'readerCalls');
    // The falsifier: no offered range overlaps an event that blocks ([a, b) and [s, e) overlap when s < b and e > a).
    const blocking = (f.events || []).filter(blocksTime).filter((e) => !out.settings || out.settings.selfBlocks || e.attendees.length);
    for (const day of out.availability?.days || []) for (const r of day.ranges) {
      for (const e of blocking) assert.ok(!(Date.parse(e.start) < Date.parse(r.end) && Date.parse(e.end) > Date.parse(r.start)), `${r.start} to ${r.end} overlaps ${e.start}`);
    }
  });
}
