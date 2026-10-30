// Pages before a meeting starts (loggie-pages-anytime I4): staged under the occurrence (event id + start), listed for
// the Day card, moved into the call's pages/ at Record (the occurrence nearest the press, within 12 h), " 2" on a
// clash, the staging folder removed; another occurrence or another meeting keeps its pages. Temp folders only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listStaged, moveStaged, stagePage, waitingFolder } from '../src/hikyaku/pages-waiting.js';

const EVENT = 'AAMkAGI2-made-up-event-id/with+odd=chars';
const START = '2026-10-29T17:30:00.000Z';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-waiting-'));
  const src = join(home, 'Week 9 slides.pdf');
  await writeFile(src, '%PDF made up');
  const call = join(home, 'calls', '2026-10-29-1328-nba-6820');
  await mkdir(join(call, 'pages'), { recursive: true });
  return { home, src, call };
}

test('a page waits under its occurrence, a safe folder name, and is listed for the card', async () => {
  const { home, src } = await setup();
  assert.deepEqual((await stagePage({ home, eventId: EVENT, start: START, path: src })).pages, ['Week 9 slides.pdf']);
  assert.deepEqual(await listStaged({ home, eventId: EVENT, start: START }), ['Week 9 slides.pdf']);
  assert.deepEqual(await listStaged({ home, eventId: EVENT, start: '2026-11-05T17:30:00.000Z' }), [], 'next week is another occurrence');
  assert.match(waitingFolder(home, EVENT, START), /pages-waiting\/[0-9a-f]{16}-20261029T1730$/);
  await assert.rejects(stagePage({ home, eventId: EVENT, start: 'soon', path: src }), /no start time/);
});

test('Record moves the nearest occurrence into the call, " 2" on a clash, and clears it', async () => {
  const { home, src, call } = await setup();
  await stagePage({ home, eventId: EVENT, start: START, path: src });
  await stagePage({ home, eventId: 'another-meeting', start: START, path: src });
  await writeFile(join(call, 'pages', 'Week 9 slides.pdf'), 'tucked in already');
  const pressed = Date.parse(START) - 2 * 60000;
  assert.equal(await moveStaged({ home, eventId: EVENT, now: pressed, callFolder: call }), 1);
  assert.deepEqual((await readdir(join(call, 'pages'))).sort(), ['Week 9 slides 2.pdf', 'Week 9 slides.pdf']);
  assert.deepEqual(await listStaged({ home, eventId: EVENT, start: START }), [], 'moved, not copied');
  assert.deepEqual(await listStaged({ home, eventId: 'another-meeting', start: START }), ['Week 9 slides.pdf'], 'another meeting keeps its page');
  assert.equal(await moveStaged({ home, eventId: EVENT, now: pressed, callFolder: call }), 0);
  assert.equal(await moveStaged({ home, eventId: null, now: pressed, callFolder: call }), 0);
});

test('a recording 13 h away from the occurrence takes nothing', async () => {
  const { home, src, call } = await setup();
  await stagePage({ home, eventId: EVENT, start: START, path: src });
  assert.equal(await moveStaged({ home, eventId: EVENT, now: Date.parse(START) + 13 * 3600000, callFolder: call }), 0);
  assert.deepEqual(await listStaged({ home, eventId: EVENT, start: START }), ['Week 9 slides.pdf']);
});
