// When the meeting ends, Loggie asks "Done? Write it up." and never stops on its own (spec-c.md increment 14, B15, M4).
// endDecision is pure on an injected clock; the watcher remembers the offer a recording came from and writes
// meeting.end_asked; only the user's "stop" answer, through endAnswer, runs `call.py stop`, detached. Everything here is
// made up: no recorder, no mic, no clock, temp homes only, people at example.org.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { END_TEXT, endDecision, EVENT_END_S, MIC_RELEASE_S, REASK_S, UNKNOWN_END_S } from '../src/hikyaku/meeting.js';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { checkEvents, readEvents, TYPES } from '../src/hikyaku/events.js';
import { validateMeetingEnd } from '../desktop/ipc-validation.js';
import { mainText } from './helpers/main-files.js';
import { sourcesUnder } from './helpers/files.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEC = 1000;
const T0 = Date.parse('2026-10-01T18:00:00Z');
const END = T0 + 60 * 60 * SEC;
const CALL = '2026-10-01-1800-strategy-kickoff';
const iso = (ms) => new Date(ms).toISOString();

// --- the pure decision
const calendarCall = { call: CALL, startedAt: iso(T0), source: 'calendar', event: { end: iso(END) }, seen: [] };
const micCall = { call: CALL, startedAt: iso(T0), source: 'mic', event: null, seen: ['us.zoom.xos'] };
const NONE = { held: [], released: [] };
const released = (at) => ({ held: [], released: [{ bundle: 'us.zoom.xos', label: 'Zoom', since: iso(at) }] });
const held = { held: [{ bundle: 'us.zoom.xos', label: 'Zoom', since: iso(T0) }], released: [] };

test('constants: 120 s of release, 600 s after the event end, 1800 s before an ask repeats, fixed text', () => {
  assert.deepEqual([MIC_RELEASE_S, EVENT_END_S, REASK_S, END_TEXT], [120, 600, 1800, 'Done? Write it up.']);
});

test('endDecision: a meeting app that let go of the mic asks at 120 s, not before', () => {
  const at = T0 + 30 * 60 * SEC;
  assert.deepEqual(endDecision({ recording: micCall, now: iso(at + 119 * SEC), apps: released(at) }), { ask: false, reason: 'waiting' });
  assert.deepEqual(endDecision({ recording: micCall, now: iso(at + 120 * SEC), apps: released(at) }), { ask: true, reason: 'mic_released', since: iso(at) });
});

test('endDecision: an app not seen during this recording never counts as released', () => {
  const at = T0 + 30 * 60 * SEC;
  const decision = endDecision({ recording: { ...micCall, seen: [] }, now: iso(at + 600 * SEC), apps: released(at) });
  assert.equal(decision.ask, false);
});

test('endDecision: a calendar call asks at event end + 600 s, not before, and an app still on the mic no longer holds it back', () => {
  assert.equal(endDecision({ recording: calendarCall, now: iso(END + 599 * SEC), apps: NONE }).ask, false);
  assert.deepEqual(endDecision({ recording: calendarCall, now: iso(END + 600 * SEC), apps: NONE }), { ask: true, reason: 'event_ended', since: iso(END) });
  assert.deepEqual(endDecision({ recording: calendarCall, now: iso(END + 599 * SEC), apps: held }), { ask: false, reason: 'mic_held' });
  assert.deepEqual(endDecision({ recording: calendarCall, now: iso(END + 600 * SEC), apps: held }), { ask: true, reason: 'event_ended', since: iso(END) }, 'Gio, TC2 2026-10-10');
});

test('endDecision: with no end known it asks 3600 s in, mic or not; a block longer than 4 h has no end', () => {
  assert.deepEqual(endDecision({ recording: micCall, now: iso(T0 + 3599 * SEC), apps: NONE }), { ask: false, reason: 'waiting' });
  assert.deepEqual(endDecision({ recording: micCall, now: iso(T0 + 3600 * SEC), apps: held }), { ask: true, reason: 'no_end_known', since: iso(T0) });
  const expo = { ...calendarCall, event: { start: iso(T0 - 30 * 3600 * SEC), end: iso(T0 + 7 * 3600 * SEC) } };   // a 37-hour block
  assert.deepEqual(endDecision({ recording: expo, now: iso(T0 + 3600 * SEC), apps: NONE }), { ask: true, reason: 'no_end_known', since: iso(T0) });
  assert.equal(UNKNOWN_END_S, 3600);
});

test('endDecision: never when nothing is recording, and never twice inside 1800 s', () => {
  assert.deepEqual(endDecision({ recording: null, now: iso(END + 7200 * SEC), apps: NONE }), { ask: false, reason: 'not_recording' });
  const base = { recording: calendarCall, apps: NONE };
  const asked = iso(END + 600 * SEC);
  assert.deepEqual(endDecision({ ...base, now: iso(END + 600 * SEC + 1799 * SEC), asked }), { ask: false, reason: 'asked_lately' });
  assert.equal(endDecision({ ...base, now: iso(END + 600 * SEC + 1800 * SEC), asked }).ask, true);
});

// --- the watcher
const event = { id: 'ev-1', title: 'Strategy Kickoff', start: iso(T0), end: iso(END), allDay: false, calendar: 'Calendar', account: 'me@example.org', writable: true,
  attendees: ['person0@example.org', 'person1@example.org'], attendeeNames: ['Person0 Example', 'Person1 Example'], recurring: false, location: 'https://example.zoom.us/j/100001',
  calendarId: 'cal-1', calendarType: 'exchange', isDefault: false, organizerIsMe: false, myStatus: 'accepted' };   // an invite he accepted (meeting.js isMine)
const mic = (...using) => ({ at: 'now', using_mic: using.map(([bundle, pid]) => ({ bundle, pid })) });

async function setup({ events = [event] } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-meeting-end-'));
  const clock = { at: T0 - 60 * SEC };
  const owners = { now: mic() };
  const offers = [];
  const runs = [];
  const detached = [];
  const watch = createMeetingWatch({
    home, listEvents: async () => events, now: () => new Date(clock.at), onOffer: (offer) => offers.push(offer), log: () => {},
    runner: async (command, args, options) => { runs.push({ command, args, options }); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', CALL)}\n`, stderr: '' }; },
    detach: (command, args, options) => detached.push({ command, args, options }),
    transcriber: () => '/fake/transcriber/spike', loggieDirectory: '/fake/loggie', micOwners: async () => owners.now,
  });
  // the recorder is alive from the click on: current.json is call.py's, written by it, not by the watcher
  const record = async () => {
    await watch.poll();
    const result = await watch.answer(offers.at(-1).offer_id, 'record');
    await mkdir(join(home, 'calls', CALL), { recursive: true });
    await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', CALL), started: clock.at / 1000 }));
    return result;
  };
  return { home, clock, owners, offers, runs, detached, watch, record };
}
async function allEvents(home) {
  const out = [];
  for (const run of (await readdir(join(home, 'runs')).catch(() => [])).sort()) out.push(...await readEvents(join(home, 'runs', run)));
  return out;
}
const asks = async (home) => (await allEvents(home)).filter((e) => e.type === 'meeting.end_asked');

test('a calendar call asks once at event end + 600 s, again only after 1800 s, with asked_before counting', async () => {
  const { home, clock, watch, record, runs } = await setup();
  await record();
  clock.at = END + 599 * SEC; await watch.poll();
  assert.equal((await asks(home)).length, 0);
  clock.at = END + 600 * SEC; await watch.poll();
  clock.at += 60 * SEC; await watch.poll();
  clock.at += 1000 * SEC; await watch.poll();
  let list = await asks(home);
  assert.equal(list.length, 1, 'one ask, then silence inside 1800 s');
  assert.deepEqual([list[0].text, list[0].data.call, list[0].data.reason, list[0].data.since, list[0].data.asked_before], ['Done? Write it up.', CALL, 'event_ended', iso(END), 0]);
  clock.at = END + 600 * SEC + 1800 * SEC; await watch.poll();
  list = await asks(home);
  assert.equal(list.length, 2);
  assert.equal(list[1].data.asked_before, 1);
  assert.equal(runs.length, 1, 'only the start ran; asking runs nothing');
  assert.ok(checkEvents(await allEvents(home)).ok);
});

test('a meeting app seen during the recording that lets go for 120 s asks, reason mic_released', async () => {
  const { home, clock, owners, watch, record, detached } = await setup();
  owners.now = mic(['us.zoom.xos', 11]);
  await record();
  clock.at = T0 + 20 * 60 * SEC; await watch.poll();
  owners.now = mic();
  clock.at += 5 * SEC; await watch.poll();
  const letGo = clock.at;
  clock.at = letGo + 119 * SEC; await watch.poll();
  assert.equal((await asks(home)).length, 0);
  clock.at = letGo + 120 * SEC; await watch.poll();
  const [ask] = await asks(home);
  assert.deepEqual([ask.data.reason, ask.data.since], ['mic_released', iso(letGo)]);
  assert.equal(detached.length, 0, 'asking stops nothing');
});

test('a calendar call whose app still holds the mic past the event end is asked at end + 600 s anyway', async () => {
  const { home, clock, owners, watch, record } = await setup();
  owners.now = mic(['us.zoom.xos', 11]);
  await record();
  clock.at = END + 599 * SEC; await watch.poll();
  assert.equal((await asks(home)).length, 0);
  clock.at = END + 600 * SEC; await watch.poll();
  assert.deepEqual((await asks(home)).map((a) => a.data.reason), ['event_ended']);
});

test('after a restart (no offer in memory) the end saved in the call\'s event.json still asks; with none, 3600 s in', async () => {
  for (const [saved, at, reason] of [[{ start: iso(T0), end: iso(END) }, END + 600 * SEC, 'event_ended'], [{ start: iso(T0) }, T0 + 3600 * SEC, 'no_end_known']]) {
    const { home, clock, watch } = await setup({ events: [] });
    await mkdir(join(home, 'calls', CALL), { recursive: true });
    await writeFile(join(home, 'calls', CALL, 'event.json'), JSON.stringify({ title: 'Strategy Kickoff', ...saved }));
    await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', CALL), started: T0 / 1000 }));
    clock.at = at - SEC; await watch.poll();
    assert.equal((await asks(home)).length, 0);
    clock.at = at; await watch.poll();
    assert.deepEqual((await asks(home)).map((a) => a.data.reason), [reason]);
  }
});

test('nothing recording, nothing asked, even at a meeting\'s end', async () => {
  const { home, clock, watch } = await setup();
  clock.at = END + 3600 * SEC; await watch.poll();
  assert.equal((await asks(home)).length, 0);
});

test('stop spawns call.py stop detached with its log in the call folder, and writes meeting.end_answered', async () => {
  const { home, clock, watch, record, detached } = await setup();
  await record();
  clock.at = END + 600 * SEC; await watch.poll();
  const result = await watch.endAnswer(CALL, 'stop');
  assert.deepEqual(result, { call: CALL, answer: 'stop' });
  assert.equal(detached.length, 1);
  assert.deepEqual([detached[0].command, detached[0].args], ['python3', ['call.py', 'stop']]);
  assert.deepEqual([detached[0].options.cwd, detached[0].options.log, detached[0].options.env.LOGGIE_DIR], ['/fake/transcriber/spike', join(home, 'calls', CALL, 'stop.log'), '/fake/loggie']);
  const answered = (await allEvents(home)).filter((e) => e.type === 'meeting.end_answered');
  assert.deepEqual(answered.map((e) => [e.text, e.data]), [[null, { call: CALL, answer: 'stop' }]]);
  const [ask] = await asks(home);
  assert.equal(answered[0].run, ask.run, 'the answer lands in the run of the ask');
  assert.ok(checkEvents(await allEvents(home)).ok);
});

test('keep spawns nothing and writes the answer; a call that is not recording, or a bad answer, is refused', async () => {
  const { home, clock, watch, record, detached } = await setup();
  await assert.rejects(watch.endAnswer(CALL, 'stop'), /not recording/);
  await record();
  clock.at = END + 600 * SEC; await watch.poll();
  assert.deepEqual(await watch.endAnswer(CALL, 'keep'), { call: CALL, answer: 'keep' });
  assert.equal(detached.length, 0);
  await assert.rejects(watch.endAnswer('other-call', 'stop'), /not recording/);
  await assert.rejects(watch.endAnswer(CALL, 'pause'), /stop or keep/);
  assert.equal(detached.length, 0);
  assert.deepEqual((await allEvents(home)).filter((e) => e.type === 'meeting.end_answered').map((e) => e.data.answer), ['keep']);
  await rm(home, { recursive: true, force: true });
});

// --- the IPC and the contract
test('the IPC answer is validated: a call folder name, and stop or keep', () => {
  assert.deepEqual(validateMeetingEnd(CALL, 'stop'), { call: CALL, answer: 'stop' });
  assert.deepEqual(validateMeetingEnd('a.b_c-1', 'keep'), { call: 'a.b_c-1', answer: 'keep' });
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(121), null, 5]) assert.throws(() => validateMeetingEnd(bad, 'stop'), /not a call/);
  assert.throws(() => validateMeetingEnd(CALL, 'record'), /stop or keep/);
});

test('the contract, docs, main.js and preload carry the end ask and its answer', async () => {
  assert.deepEqual(TYPES['meeting.end_asked'], ['call', 'reason', 'since', 'asked_before']);
  assert.deepEqual(TYPES['meeting.end_answered'], ['call', 'answer']);
  const main = await mainText();
  const preload = await readFile(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
  const docs = await readFile(join(ROOT, 'docs', 'hikyaku-events.md'), 'utf8');
  assert.match(main, /handleSecure\('hikyaku:meeting-end', async \(call, answer\)/);
  assert.match(main, /validateMeetingEnd\(call, answer\)/);
  assert.match(preload, /meetingEnd: \(call, answer\) => ipcRenderer\.invoke\('hikyaku:meeting-end', call, answer\)/);
  assert.match(docs, /`meeting\.end_asked`/); assert.match(docs, /`meeting\.end_answered`/); assert.match(docs, /meetingEnd\(call, answer\)/);
});

// --- M4: never stop on its own. `call.py stop` is spawned in exactly one place, the stop branch of endAnswer, after
// the answer check. Comments are stripped first, so a mention in prose does not count and a spawn cannot hide in one.
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const STOP_SPAWN = /call\.py['"`]\s*,\s*['"`]stop['"`]|call\.py\s+stop/g;

test('M4: nothing stops a recording except the stop answer', async () => {
  const files = [...await sourcesUnder(join(ROOT, 'src')), ...await sourcesUnder(join(ROOT, 'desktop'))];
  const hits = [];
  for (const file of files) {
    const count = (stripComments(await readFile(file, 'utf8')).match(STOP_SPAWN) || []).length;
    if (count) hits.push([relative(ROOT, file), count]);
  }
  assert.deepEqual(hits, [['src/hikyaku/meeting-watch.js', 1]], 'call.py stop is spawned in exactly one place');
  const code = stripComments(await readFile(join(ROOT, 'src', 'hikyaku', 'meeting-watch.js'), 'utf8'));
  const from = code.indexOf('async function endAnswer');
  assert.ok(from >= 0, 'the end answer handler is a named function');
  const handler = code.slice(from, code.indexOf('\n  }\n', from) + 5);
  assert.equal((handler.match(STOP_SPAWN) || []).length, 1, 'the one spawn is inside the end answer handler');
  const guard = handler.indexOf("answer !== 'stop'");
  assert.ok(guard >= 0 && guard < handler.search(STOP_SPAWN), 'the stop check comes before the spawn');
  const pollFrom = code.indexOf('async function poll');
  const poll = code.slice(pollFrom, code.indexOf('\n  }\n', pollFrom));
  assert.ok(pollFrom >= 0 && !/runner\(|detach\(|spawn|execFile|exec\(/.test(poll), 'the poll runs nothing');
});
