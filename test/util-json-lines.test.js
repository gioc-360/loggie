// One reader for every .jsonl log (cleanup audit bug 13): a torn or half-written line is skipped, never thrown.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { jsonLines } from '../src/hikyaku/util.js';
import { parseEvents } from '../src/hikyaku/events.js';
import { writeRecentVoice } from '../src/hikyaku/delta.js';

test('jsonLines keeps whole lines and skips a torn one', () => {
  assert.deepEqual(jsonLines('{"a":1}\n{"b":\n\n{"c":3}\n'), [{ a: 1 }, { c: 3 }]);
  assert.deepEqual(jsonLines(''), []);
});

test('the events log and the voice log read past a torn line', async () => {
  assert.deepEqual(parseEvents('{"seq":1}\n{"seq":'), [{ seq: 1 }]);
  const home = await mkdtemp(join(tmpdir(), 'jsonl-'));
  await writeFile(join(home, 'deltas.jsonl'), '{"task":"t1"}\n{"task":');
  await writeRecentVoice(home, {});
});

test('a month and day said in a step become a date, rolling into next year from late in the year', async () => {
  const { stepDue } = await import('../src/hikyaku/gather.js');
  assert.equal(stepDue('Send the deck on Oct 16 (me)', '2026-10-09'), '2026-10-16');
  assert.equal(stepDue('Book the room by Jan 5', '2026-12-20'), '2027-01-05');
  assert.equal(stepDue('No date here', '2026-10-09'), null);
});
