// "Today" is the user's own day everywhere (cleanup audit, D23): at 9 pm in New York the UTC date is already tomorrow,
// and the chats prompt, the stale check and the catch-up used to say tomorrow while the cards said today.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { localDay } from '../src/hikyaku/util.js';

test('localDay is the calendar day on this Mac, not the UTC day', () => {
  const evening = new Date(2026, 9, 27, 21, 30); // 9:30 pm local
  assert.equal(localDay(evening), '2026-10-27');
});

test('no default "today" in src is the UTC date', async () => {
  const dir = new URL('../src/hikyaku/', import.meta.url);
  const bad = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.js'))) {
    const text = await readFile(new URL(name, dir), 'utf8');
    if (/today\s*[=:]\s*(?:new Date\(\)|now\(\))\.toISOString\(\)\.slice\(0, 10\)/.test(text)) bad.push(name);
  }
  assert.deepEqual(bad, []);
});
