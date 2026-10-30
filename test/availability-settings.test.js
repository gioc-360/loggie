// "Your free times" in Settings (loggie-availability I3, docs/availability/spec.md 1.3, gate 3.1): the patch check, the
// rules and their defaults, and the save into settings.json in a temp folder: only the row's key is written, cloudYes
// and every other key are kept, a file that cannot be read is never written over, and an end before the start is
// refused. The meetingHours key the save writes is the one next-move.js already reads. The two channels are wired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availabilitySettings, availabilityView, saveAvailability } from '../src/hikyaku/availability.js';
import { validateAvailabilityPatch } from '../desktop/ipc-validation.js';
import { offeredSlots } from '../src/hikyaku/next-move.js';

const ZONE = 'America/New_York';
const DEFAULTS = { startHour: 9, endHour: 17, timeZone: ZONE, minMinutes: 30, daysAhead: 5, selfBlocks: true };
const home = async (settings) => {
  const folder = await mkdtemp(join(tmpdir(), 'availability-settings-'));
  if (settings !== undefined) await writeFile(join(folder, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return folder;
};
const fileOf = async (folder) => readFile(join(folder, 'settings.json'), 'utf8');
const NOT_OFFERED = { message: 'That is not a setting Loggie offers.' };

test('3.1 validateAvailabilityPatch: every value a row offers passes, each one it does not is refused', () => {
  const valid = {
    startHour: [6, 7, 8, 9, 10, 11, 12], endHour: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], timeZone: [null, 'UTC', 'Europe/London', ZONE],
    minMinutes: [15, 30, 45, 60, 90], daysAhead: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], selfBlocks: [true, false],
  };
  for (const [key, values] of Object.entries(valid)) for (const value of values) assert.deepEqual(validateAvailabilityPatch({ [key]: value }), { [key]: value }, `${key} ${value}`);
  assert.deepEqual(validateAvailabilityPatch({ startHour: 8, endHour: 18 }), { startHour: 8, endHour: 18 });
  const invalid = [
    { startHour: 5 }, { startHour: 13 }, { startHour: 8.5 }, { startHour: '8' }, { endHour: 11 }, { endHour: 23 }, { endHour: 24 },
    { timeZone: 'Mars/Base' }, { timeZone: '' }, { timeZone: 5 }, { minMinutes: 20 }, { minMinutes: 120 }, { minMinutes: '30' },
    { daysAhead: 0 }, { daysAhead: 11 }, { daysAhead: 2.5 }, { selfBlocks: 'yes' }, { selfBlocks: 1 }, { selfBlocks: null },
    { cloudYes: {} }, { startHour: 8, mailApp: 'outlook' }, {}, null, 'startHour', [8], Object.create(null),
  ];
  for (const patch of invalid) assert.throws(() => validateAvailabilityPatch(patch), NOT_OFFERED, JSON.stringify(patch));
});

test('3.1 availabilitySettings: defaults, each invalid value taking its default alone, a hand-edited 5 or 24 read as the default', () => {
  assert.deepEqual(availabilitySettings({}, { macZone: ZONE }), DEFAULTS);
  assert.deepEqual(availabilitySettings({ meetingHours: { startHour: 5, endHour: 24 } }, { macZone: ZONE }), DEFAULTS);
  assert.deepEqual(availabilitySettings({ meetingHours: { startHour: 8, timeZone: 'Europe/London' }, availability: { minMinutes: 60, daysAhead: 99, selfBlocks: false } }, { macZone: ZONE }),
    { ...DEFAULTS, startHour: 8, timeZone: 'Europe/London', minMinutes: 60, selfBlocks: false });
  assert.deepEqual(availabilitySettings({ meetingHours: { startHour: 12, endHour: 12 } }, { macZone: ZONE }), { ...DEFAULTS, startHour: 12, endHour: 17 }, 'end not after start takes 17');
  const view = availabilityView({ cloudYes: { box: true }, meetingHours: { startHour: 5, endHour: 18 } }, { macZone: ZONE });
  assert.deepEqual(view.stored, { endHour: 18 }, 'stored holds only the valid stored values');
  assert.deepEqual(view.resolved, { ...DEFAULTS, endHour: 18 });
  assert.equal(view.macZone, ZONE);
  assert.ok(view.zones.includes('Europe/London') && view.zones.includes(ZONE));
});

test('3.1 saveAvailability writes only the row\'s key; cloudYes and every other key are kept', async () => {
  const folder = await home({ cloudYes: { box: true, found: true }, mailApp: 'outlook', signName: 'Gio' });
  const view = await saveAvailability(folder, { minMinutes: 60 }, { macZone: ZONE });
  assert.equal(view.resolved.minMinutes, 60);
  const text = await fileOf(folder);
  assert.ok(text.endsWith('}\n') && text.includes('\n  "cloudYes"'), 'two spaces and a trailing newline');
  assert.deepEqual(JSON.parse(text), { cloudYes: { box: true, found: true }, mailApp: 'outlook', signName: 'Gio', availability: { minMinutes: 60 } });
  await saveAvailability(folder, { startHour: 8 }, { macZone: ZONE });
  await saveAvailability(folder, { timeZone: 'Europe/London' }, { macZone: ZONE });
  await saveAvailability(folder, { selfBlocks: false }, { macZone: ZONE });
  assert.deepEqual(JSON.parse(await fileOf(folder)), { cloudYes: { box: true, found: true }, mailApp: 'outlook', signName: 'Gio', availability: { minMinutes: 60, selfBlocks: false }, meetingHours: { startHour: 8, timeZone: 'Europe/London' } });
  // "This Mac" (null) deletes the field; a group left empty deletes the key.
  const back = await saveAvailability(folder, { timeZone: null }, { macZone: ZONE });
  assert.deepEqual(JSON.parse(await fileOf(folder)).meetingHours, { startHour: 8 });
  assert.equal(back.resolved.timeZone, ZONE);
  const only = await home({ cloudYes: { box: true }, meetingHours: { timeZone: 'UTC' } });
  await saveAvailability(only, { timeZone: null }, { macZone: ZONE });
  assert.deepEqual(JSON.parse(await fileOf(only)), { cloudYes: { box: true } });
  // A missing file starts from {}.
  const fresh = await home();
  await saveAvailability(fresh, { daysAhead: 3 }, { macZone: ZONE });
  assert.deepEqual(JSON.parse(await fileOf(fresh)), { availability: { daysAhead: 3 } });
});

test('3.1 an end not after the start is refused and nothing is written', async () => {
  const start = { cloudYes: { box: true }, meetingHours: { startHour: 12 } };
  const folder = await home(start);
  const before = await fileOf(folder);
  await assert.rejects(saveAvailability(folder, { endHour: 12 }, { macZone: ZONE }), { message: 'The end of your hours must be after the start.' });
  const other = await home({ cloudYes: { box: true }, meetingHours: { endHour: 12 } });
  await assert.rejects(saveAvailability(other, { startHour: 12 }, { macZone: ZONE }), { message: 'The end of your hours must be after the start.' });
  assert.equal(await fileOf(folder), before);
  // Against the default end (17): a start of 12 is fine.
  const plain = await home({});
  await saveAvailability(plain, { startHour: 12 }, { macZone: ZONE });
  assert.deepEqual(JSON.parse(await fileOf(plain)), { meetingHours: { startHour: 12 } });
});

test('3.1 an empty, unparsable or non-object settings.json is refused and left as it was (cloudYes is never lost)', async () => {
  for (const text of ['', '{"cloudYes": {"box": tr', '[1, 2]', 'null']) {
    const folder = await home(text);
    let writes = 0;
    await assert.rejects(saveAvailability(folder, { minMinutes: 60 }, { macZone: ZONE, writeImpl: async () => { writes += 1; } }), { message: 'settings.json could not be read.' }, JSON.stringify(text));
    assert.equal(writes, 0);
    assert.equal(await fileOf(folder), text);
  }
  const unreadable = await home({});
  await assert.rejects(saveAvailability(unreadable, { minMinutes: 60 }, { macZone: ZONE, readImpl: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }), { message: 'settings.json could not be read.' });
});

test('3.1 the hours row sets the meetingHours next-move.js reads: startHour 8 offers an 8:00 start', () => {
  const from = new Date('2026-10-26T11:00:00Z'); // Mon 7:00 EDT
  const local = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const eight = offeredSlots({ events: [], settings: { meetingHours: { startHour: 8 } }, from });
  assert.ok(eight.some((slot) => local(slot.start) === '08:00'), eight.map((slot) => slot.label).join(' | '));
  const nine = offeredSlots({ events: [], settings: {}, from });
  assert.ok(!nine.some((slot) => local(slot.start) < '09:00'), 'no meetingHours key: as today');
});

test('3.1 the two channels: handler in main-ask.js, method in preload.cjs, wrapper in panel.js', async () => {
  const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const [main, preload, panel] = await Promise.all([source('desktop/main-ask.js'), source('desktop/preload.cjs'), source('desktop/renderer/panel.js')]);
  assert.match(main, /handleSecure\('hikyaku:availability-settings', async \(\) => availabilityView\(await readRawSettings\(hikyakuDirectory\(\)\)\)\)/);
  assert.match(main, /handleSecure\('hikyaku:set-availability', \(patch\) => inSettings\(\(\) => saveAvailability\(hikyakuDirectory\(\), validateAvailabilityPatch\(patch\)\)\)\)/);
  assert.ok(preload.includes("availabilitySettings: () => ipcRenderer.invoke('hikyaku:availability-settings'),"));
  assert.ok(preload.includes("setAvailability: (patch) => ipcRenderer.invoke('hikyaku:set-availability', patch),"));
  assert.ok(panel.includes('availabilitySettings: async () => unwrap(await hikyaku().availabilitySettings()),'));
  assert.ok(panel.includes('setAvailability: async (patch) => unwrap(await hikyaku().setAvailability(patch)),'));
});
