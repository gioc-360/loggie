// The app's wiring for availability asks (loggie-availability I1, spec test 1.8): askAvailability gives the ask box the
// calendar helper's list and status and the rules from settings.json; the ui-acts row adds what happened to the
// times. main-ask.js is checked through its source (the found-wiring.test.js way): it needs Electron to load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askAvailability } from '../src/hikyaku/availability.js';
import { boxActRow } from '../src/hikyaku/ask-run.js';
import { readSettings } from '../src/hikyaku/draft.js';

test('1.8 askAvailability with fakes: the three readers, and the defaults for an empty settings.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'availability-wiring-'));
  await writeFile(join(home, 'settings.json'), '{}\n');
  const calls = [];
  const readers = askAvailability({ home: () => home, listEventsImpl: async (options) => { calls.push(options); return [{ start: 'a' }]; }, statusImpl: async () => 'granted', readSettingsImpl: readSettings, macZone: 'America/New_York' });
  assert.deepEqual(Object.keys(readers).sort(), ['availability', 'events', 'status']);
  assert.deepEqual(await readers.events({ from: new Date(0), days: 8 }), [{ start: 'a' }]);
  assert.deepEqual(calls, [{ from: new Date(0), days: 8 }]);
  assert.equal(await readers.status(), 'granted');
  assert.deepEqual(await readers.availability(), { startHour: 9, endHour: 17, timeZone: 'America/New_York', minMinutes: 30, daysAhead: 5, selfBlocks: true });
  const chosen = askAvailability({ home, readSettingsImpl: async () => ({ meetingHours: { startHour: 8, timeZone: 'Europe/London' }, availability: { minMinutes: 60, selfBlocks: false, daysAhead: 24 } }), macZone: 'America/New_York' });
  assert.deepEqual(await chosen.availability(), { startHour: 8, endHour: 17, timeZone: 'Europe/London', minMinutes: 60, daysAhead: 5, selfBlocks: false }, 'an invalid value takes its default alone');
});

test('1.8 boxActRow: today\'s fields exactly, plus times when the ask read the calendar', () => {
  const base = { askId: 'x', action: 'reply', outcome: 'placed', path: 'cloud', ms: 1200, results: [{ to: 'Sam Lee', app: 'outlook', outcome: 'placed', thread: { how: 'newest' }, drafted: 'ai' }] };
  const today = { at: '2026-10-20T16:21:01.000Z', act: 'box', name: null, action: 'reply', outcome: 'placed', path: 'cloud', placed: 1, to: 1, apps: ['outlook'], ms: 1200, thread: 'newest', drafted: 'ai', draftMs: 640, from: 'main' };
  assert.deepEqual(boxActRow(base, { draftMs: 640, at: today.at }), today);
  const record = (read, days = []) => ({ ...base, results: [{ ...base.results[0], availability: { asked: 'typed', read, days } }] });
  assert.deepEqual(boxActRow(record('read', [{ day: '2026-10-23', ranges: [{}] }]), { draftMs: 640, at: today.at }), { ...today, times: 'filled' });
  assert.equal(boxActRow(record('read')).times, 'none-free');
  assert.equal(boxActRow(record('unreadable')).times, 'unreadable');
  assert.equal(boxActRow(record('empty')).times, 'empty');
  const chat = boxActRow({ action: 'message', outcome: 'placed', ms: 3, results: [{ to: 'Lena', app: 'messages', outcome: 'placed' }] }, { at: today.at });
  assert.deepEqual(chat, { at: today.at, act: 'box', name: null, action: 'message', outcome: 'placed', path: 'code', placed: 1, to: 1, apps: ['messages'], ms: 3, from: 'main' });
  assert.ok(!JSON.stringify(boxActRow(record('read', [{ day: '2026-10-23', ranges: [{}] }]))).includes('Sam Lee'), 'never a name');
});

test('1.8 main-ask.js spreads askAvailability( into askEmail and its emit writes boxActRow(', async () => {
  const source = await readFile(new URL('../desktop/main-ask.js', import.meta.url), 'utf8');
  const askEmail = source.slice(source.indexOf('export const askEmail = {'), source.indexOf('\n};', source.indexOf('export const askEmail = {')));
  assert.match(askEmail, /\.\.\.askAvailability\(\{ home: hikyakuDirectory \}\)/);
  assert.match(source, /JSON\.stringify\(boxActRow\(data, \{ draftMs: askDraftMs\.get\(data\.askId\) \?\? null/);
  assert.doesNotMatch(source, /act: 'box', name: null/, 'the row is built in one place');
});
