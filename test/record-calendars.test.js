// "Record from these calendars" on Settings (src/hikyaku/record-calendars.js, 2026-10-27): the checkhouse per calendar,
// the main ones on by default (Work off, per Gio), and a save that touches only its own key. Made-up calendars in the
// shapes of his Mac (test/fixtures/oct27-calendar.json), temp homes only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as ipc from '../desktop/ipc-validation.js';

const { CALENDARS } = JSON.parse(await readFile(new URL('./fixtures/oct27-calendar.json', import.meta.url), 'utf8'));
const records = () => import('../src/hikyaku/record-calendars.js');

test('1B the list opens on each account\'s main calendar; a saved list is shown as saved', async () => {
  const { recordCalendarsView } = await records();
  const fresh = recordCalendarsView(CALENDARS, {});
  assert.equal(fresh.saved, false);
  assert.deepEqual(fresh.calendars.filter((calendar) => calendar.on).map((calendar) => `${calendar.account} ${calendar.title}`), ['Exchange Calendar', 'me@school.example me@school.example']);
  assert.equal(fresh.calendars.length, CALENDARS.length, 'one row per calendar');
  assert.deepEqual(Object.keys(fresh.calendars[0]), ['id', 'title', 'account', 'type', 'on']);
  const mine = recordCalendarsView(CALENDARS, { recordCalendars: ['cal-icloud-work'] });
  assert.deepEqual([mine.saved, mine.calendars.filter((calendar) => calendar.on).map((calendar) => calendar.id)], [true, ['cal-icloud-work']]);
});

test('1B saving writes recordCalendars and keeps every other key; a settings file that cannot be read is refused', async () => {
  const { saveRecordCalendars } = await records();
  const home = await mkdtemp(join(tmpdir(), 'loggie-record-calendars-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'apple-mail', cloudYes: { found: true } }));
  await saveRecordCalendars(home, ['cal-exchange-main', 'cal-icloud-work', 'cal-exchange-main']);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')), { mailApp: 'apple-mail', cloudYes: { found: true }, recordCalendars: ['cal-exchange-main', 'cal-icloud-work'] });
  await writeFile(join(home, 'settings.json'), '{ not json');
  await assert.rejects(saveRecordCalendars(home, []));
  assert.equal(await readFile(join(home, 'settings.json'), 'utf8'), '{ not json', 'nothing written');
});

test('1A and 1B the IPC inputs are checked: an event id or none, a list of calendar ids', () => {
  assert.equal(ipc.validateRecordEvent(null), null);
  assert.equal(ipc.validateRecordEvent('mt-exchange'), 'mt-exchange');
  assert.throws(() => ipc.validateRecordEvent('a\nb'), /Invalid calendar event/);
  assert.throws(() => ipc.validateRecordEvent(42), /Invalid calendar event/);
  assert.deepEqual(ipc.validateRecordCalendars(['cal-a', 'cal-b']), ['cal-a', 'cal-b']);
  assert.throws(() => ipc.validateRecordCalendars('cal-a'), /not a list of calendars/);
  assert.throws(() => ipc.validateRecordCalendars(['']), /not a list of calendars/);
});
