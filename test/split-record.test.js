// Record both (split-recording-proposal.md item 4, 2026-10-28): when two of his meetings overlap now the Day card offers
// one recording for both; the side rule says which takes the mic (the room) and which the Mac's sound; the IPC checks
// both ids; startManual hands call.py `--also`; both calls show recording and Stop stops the one recording. Made-up
// meetings, temp homes, no recorder.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bothFor, cardFor, sideOf } from '../desktop/renderer/meetings-day-model.js';
import { joinWeek } from '../desktop/week-events.js';
import { validateRecordAlso } from '../desktop/ipc-validation.js';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { listCalls } from '../src/hikyaku/call-list.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (time) => new Date(`2026-10-29T${time}:00`).toISOString();
const item = (id, start, end, extra = {}) => ({ kind: 'event', id, title: id, start, end, sort: 'people', call: null, mine: true, place: null, link: false, ...extra });
// Thursday's shape: a case kickoff with nobody on it and no place (a block), and a class with a course code and a room.
const KICKOFF = item('Case kickoff', at('11:30'), at('12:20'), { sort: 'block' });
const MACRO = item('NBA 5245 Macro', at('11:40'), at('12:55'), { sort: 'class', place: 'Hall 223' });

test('the side rule: a course code or a room and no join link takes the mic; the rest take the Mac sound', () => {
  assert.equal(sideOf(MACRO), 'room');
  assert.equal(sideOf(item('Interview', at('11:00'), at('12:00'), { place: 'Sage 101' })), 'room', 'a room with no link is in the room');
  assert.equal(sideOf(KICKOFF), 'mac');
  assert.equal(sideOf({ ...MACRO, link: true }), 'mac', 'a class with a join link is on the Mac');
  assert.equal(sideOf(item('Chat', at('11:00'), at('12:00'))), 'mac');
});

test('Record both when two of his overlap now: Macro on the mic, the kickoff on the Mac; a tie asks', () => {
  const now = new Date(at('11:41'));
  assert.deepEqual(bothFor({ items: [KICKOFF, MACRO], now }), { room: MACRO, mac: KICKOFF });
  const card = cardFor({ items: [KICKOFF, MACRO], now });
  assert.deepEqual([card.mode, card.room?.id, card.mac?.id], ['both', MACRO.id, KICKOFF.id]);
  assert.equal(bothFor({ items: [KICKOFF, MACRO], now: new Date(at('11:32')) })?.room, MACRO, 'one starting within 10 min counts as now');
  assert.equal(bothFor({ items: [KICKOFF, MACRO], now: new Date(at('11:10')) }), null, 'neither under way yet');
  assert.equal(bothFor({ items: [KICKOFF, MACRO], now: new Date(at('12:30')) }), null, 'the kickoff ended');
  assert.equal(bothFor({ items: [MACRO], now }), null, 'one meeting: no Record both');
  assert.equal(bothFor({ items: [KICKOFF, { ...MACRO, mine: false }], now }), null, 'only his');
  assert.equal(bothFor({ items: [KICKOFF, { ...MACRO, call: 'c' }], now }), null, 'one already recorded');
  const zoom = item('Zoom chat', at('11:30'), at('12:00'));
  assert.deepEqual(bothFor({ items: [zoom, KICKOFF], now }), { tie: [zoom, KICKOFF] }, 'both on the Mac: ask which is in the room');
  assert.equal(cardFor({ items: [KICKOFF, MACRO], calls: [{ id: 'c', state: 'recording' }], now }).mode, 'recording', 'recording comes first');
  const block = item('Work block', at('11:00'), at('13:00'), { sort: 'block' });
  assert.deepEqual(bothFor({ items: [block, zoom, MACRO], now }), { room: MACRO, mac: zoom }, 'a meeting or class before a block');
});

test('each Day row carries its room and whether it has a join link (the side rule reads them)', () => {
  const event = (id, location, title = `Event ${id}`) => ({ id, title, start: at('11:40'), end: at('12:55'), allDay: false, attendees: ['a@x.example'], myStatus: 'accepted', location });
  const { items } = joinWeek([event('a', 'Hall 223', 'NBA 5245 Macro'), event('b', 'https://example.zoom.us/j/1'), event('c', 'Microsoft Teams Meeting'), event('d', '')], [], { from: '2026-10-29', to: '2026-10-30' });
  const of = (id) => items.find((row) => row.id === id);
  assert.deepEqual([of('a').place, of('a').link], ['Hall 223', false]);
  assert.deepEqual([of('b').place, of('b').link], [null, true]);
  assert.equal(of('c').link, true, 'the Teams marker is a link');
  assert.deepEqual([of('d').place, of('d').link], [null, false]);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => sideOf(of(id))), ['room', 'mac', 'mac', 'mac']);
});

test('the IPC takes a second event id only beside a first, never the same one', () => {
  assert.equal(validateRecordAlso('ev-a', null), null);
  assert.equal(validateRecordAlso('ev-a', undefined), null);
  assert.equal(validateRecordAlso('ev-a', 'ev-b'), 'ev-b');
  assert.throws(() => validateRecordAlso(null, 'ev-b'), /second meeting/);
  assert.throws(() => validateRecordAlso('ev-a', 'ev-a'), /second meeting/);
  assert.throws(() => validateRecordAlso('ev-a', 42), /second meeting/);
  assert.throws(() => validateRecordAlso('ev-a', 'a\nb'), /second meeting/);
});

test('the Record handler checks the second id and hands it to startManual; the bridge carries it', async () => {
  const main = await readFile(join(ROOT, 'desktop', 'main-ipc-meetings.js'), 'utf8');
  assert.match(main, /'hikyaku:record-start', async \(title, source = 'top', workspace = null, eventId = null, alsoEventId = null\)/);
  assert.match(main, /validateRecordAlso\(event, alsoEventId\)/);
  assert.match(main, /startManual\(validateRecordTitle\(title\), \{ [^}]*alsoEventId: also \}\)/);
  const preload = await readFile(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
  assert.match(preload, /recordStart: \(title, source, workspace, eventId, alsoEventId\) => ipcRenderer\.invoke\('hikyaku:record-start', title, source, workspace, eventId, alsoEventId\)/);
});

// The calendar both meetings come from, in the helper's shape.
const raw = (id, title, start, end, location = '') => ({ id, title, start, end, allDay: false, attendees: [], attendeeNames: [], location, calendar: 'Calendar',
  account: 'me@example.org', calendarId: 'cal-main', writable: true, organizerIsMe: true });
const RAW_KICKOFF = raw('ev-kickoff', 'Case kickoff', at('11:30'), at('12:20'));
const RAW_MACRO = raw('ev-macro', 'NBA 5245 Macro', at('11:40'), at('12:55'), 'Hall 223');
const B = '2026-10-29-1141-nba-5245-macro';
const A = '2026-10-29-1141-case-kickoff';

// call.py's real split line (2026-10-28): the room folder first, then the Mac's sound folder.
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'loggie-split-record-'));
  const runs = [];
  const detached = [];
  const watch = createMeetingWatch({
    home, listEvents: async () => [RAW_KICKOFF, RAW_MACRO], now: () => new Date(at('11:41')), log: () => {},
    runner: async (command, args, options) => { runs.push({ command, args, options }); return { code: 0, stdout: `Recording the room to ${join(home, 'calls', B)} and the Mac's sound to ${join(home, 'calls', A)}\n`, stderr: '' }; },
    detach: (command, args, options) => detached.push({ command, args, options }), transcriber: () => '/fake/transcriber/spike', loggieDirectory: '/fake/loggie',
  });
  return { home, runs, detached, watch };
}

test('startManual with a second event runs call.py start <room title> <room event> --also <Mac event>', async () => {
  const { runs, watch } = await setup();
  await watch.poll();
  const started = await watch.startManual(RAW_MACRO.title, { eventId: RAW_MACRO.id, alsoEventId: RAW_KICKOFF.id });
  assert.equal(runs.length, 1);
  const { args } = runs[0];
  assert.deepEqual([args.slice(0, 3), args[4]], [['call.py', 'start', RAW_MACRO.title], '--also']);
  assert.deepEqual([JSON.parse(args[3]).id, JSON.parse(args[3]).location], [RAW_MACRO.id, 'Hall 223']);
  assert.deepEqual([JSON.parse(args[5]).id, JSON.parse(args[5]).title, JSON.parse(args[5]).source], [RAW_KICKOFF.id, RAW_KICKOFF.title, 'calendar']);
  assert.equal(args.length, 6);
  assert.deepEqual([started.call, started.title], [B, RAW_MACRO.title]);
  assert.ok(watch.state.dismissed.has(`${RAW_KICKOFF.title}|${RAW_KICKOFF.start}`), 'neither is offered after the press');
  const single = await setup();
  await single.watch.startManual(RAW_MACRO.title, { eventId: RAW_MACRO.id });
  assert.equal(single.runs[0].args.length, 4, 'one event: no --also');
  const gone = await setup();
  await assert.rejects(gone.watch.startManual(RAW_MACRO.title, { eventId: RAW_MACRO.id, alsoEventId: 'ev-gone' }), /other meeting/);
  assert.equal(gone.runs.length, 0, 'a second meeting no calendar holds starts nothing');
});

test('while one recording holds both, both calls say recording and Stop on either stops the one recording', async () => {
  const { home, detached, watch } = await setup();
  for (const [id, title] of [[B, RAW_MACRO.title], [A, RAW_KICKOFF.title]]) {
    await mkdir(join(home, 'calls', id), { recursive: true });
    await writeFile(join(home, 'calls', id, 'event.json'), JSON.stringify({ title, recorded_at: at('11:41') }));
  }
  await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', B), also: join(home, 'calls', A), started: Date.parse(at('11:41')) / 1000 }));
  const rows = await listCalls({ home });
  assert.deepEqual(rows.map((row) => [row.id, row.state]).sort(), [[A, 'recording'], [B, 'recording']]);
  assert.ok(rows.every((row) => row.since), 'both clocks run from the press');
  await assert.rejects(watch.startManual('Another'), /already recording/);
  assert.deepEqual(await watch.endAnswer(A, 'stop'), { call: A, answer: 'stop' });
  assert.equal(detached.length, 1, 'one call.py stop for the one recording');
  assert.deepEqual([detached[0].args, detached[0].options.log], [['call.py', 'stop'], join(home, 'calls', B, 'stop.log')]);
  await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', B), also: [join(home, 'calls', A)], started: 1 }));
  assert.equal((await listCalls({ home })).find((row) => row.id === A).state, 'recording', 'also as a list reads the same');
  await assert.rejects(watch.endAnswer('other-call', 'stop'), /not recording/);
});
