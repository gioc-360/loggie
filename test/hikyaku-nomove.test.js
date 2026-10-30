// C3 (cloud-first plan 4.3): a refused or skipped next move never vanishes. When the checks refuse a move for its
// content after the last attempt, or the answer is read or wait with nothing to draft, the task folder gets a
// NOMOVE.json { at, run, reason_code, because }, and the workstream card says "Loggie read this thread: no move yet,
// because ..." with no draft and no Do-it button. A transport failure writes nothing new. The latest of MOVE.json and
// NOMOVE.json wins. Made-up threads, fake transport, temp homes: no network, no model server.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approveSend, readEvents, runsRoot } from '../src/hikyaku/send-gate.js';
import { createTokenFactory } from '../src/hikyaku/nebius.js';
import { checkMove, noMoveOf, readCardMove, runNextMove } from '../src/hikyaku/next-move.js';
import { noMoveLine, showsDoIt } from '../desktop/renderer/no-move.js';
import { DRAFTS, GOOD, orchard, orchardRequest, SUPER, tf, TRANSCRIBER } from './helpers/orchard.js';

const TODAY = new Date('2026-10-08T12:00:00Z');
const NAMES_A_MODEL = /nemotron|parakeet|nvidia|nebius|token factory|claude|super|lightning|model|llm/i;

// Thread A, with a past date (Oct 7) for the PAST move.
const OUT_A = '# Re: Orchard tour\n\n_Screened on this Mac by local-test: 0 of 4 sentences kept back (code 0, model 0, unchecked 0); see HELD.json._\n\n## Pell Varro · 2026-10-01T10:00:00Z\n\nThe orchard tour is set for the morning, gates open at 9:30 AM.\n\n## Quill Ashe · 2026-10-03T14:00:00Z\n\nCould you send the “cider list” to [address kept on this Mac] before the tour? Let me know which day works for a planning call. The first round was on Oct 7.\n';
const PAST = { ...GOOD, kind: 'prep', drafts: [], steps: ['Be ready by Oct 7'] };

const setup = () => orchard('hikyaku-nomove-', OUT_A, { heldB: 0 });
const sequence = (...bodies) => { const sent = []; return { sent, post: async (text) => { sent.push(JSON.parse(text)); const body = bodies[Math.min(sent.length, bodies.length) - 1]; return createTokenFactory({ keyImpl: async () => 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) }).post(text); } }; };
// One press of Send on a fresh prepared send in the same home, at the given clock.
async function press(h, fake, at = TODAY) {
  const send = await h.prepare();
  const result = await approveSend({ home: h.dir, run: send.run, provider: 'nebius', checks: { nebius: async () => true }, transcriber: TRANSCRIBER,
    nextMove: (input) => runNextMove({ ...input, client: { post: fake.post }, core: h.core, me: 'Pell Varro', eventsImpl: async () => [], now: () => at }) });
  return { result, runDirectory: join(runsRoot(h.dir), send.run), run: send.run };
}
const taskDirectory = (h) => join(h.workstreamDirectory, 'task_1');
const names = async (directory) => (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('MOVE.json')).sort();
const readNoMove = async (h) => JSON.parse(await readFile(join(taskDirectory(h), 'NOMOVE.json'), 'utf8'));

// --- the mapping, one made-up case per family, through checkMove itself
const request = (slots = [], facts = []) => orchardRequest(OUT_A, { slots, facts, me: 'Pell', today: TODAY });
const SLOTS = [{ id: 1, start: '2026-10-09T14:00:00.000Z', minutes: 30, label: 'Fri, Oct 9, 10:00 AM EDT' }];
const verdict = (move, req = request()) => checkMove({ content: JSON.stringify(move), finish_reason: 'stop', model: SUPER }, req, { me: 'Pell Varro', today: TODAY });
const FAMILIES = [
  ['a past date', PAST, request(), 'past_date', 'the meeting already happened.'],
  ['a booked meeting', { ...GOOD, kind: 'invite', slots: [1] }, request(SLOTS, [{ id: 'f2', kind: 'meeting_booked', text: 'A meeting with Quill Ashe is already on your calendar: Friday, Oct 9, 1:00 PM.' }]), 'meeting_booked', 'a meeting with them is already on your calendar.'],
  ['a relative day', { ...GOOD, kind: 'prep', drafts: [], steps: ['Send the list tomorrow'] }, request(), 'relative_day', 'the thread\'s date was unclear.'],
  ['a title that names the user', { ...GOOD, kind: 'prep', drafts: [], title: 'Update Pell on the tour', steps: ['Open the list'] }, request(), 'names_you', 'the thread asks someone else, not you.'],
  ['a repeated kept line', { ...GOOD, thread_id: 'thread-b', why: ['Rook said: "The barn paint is drying. [health kept on this Mac] We can talk"'] }, request(), 'kept_line', 'the move needed something kept on this Mac.'],
  ['a time that was not offered', { ...GOOD, kind: 'invite', slots: [1], drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill,\n\nDoes Friday 2:30 PM work for the call?\n\nPell'] }, request(SLOTS), 'no_free_time', 'no free time fit what they asked.'],
  ['an invite with no free times', { ...GOOD, kind: 'invite', slots: [1] }, request([]), 'no_free_time', 'no free time fit what they asked.'],
  ['a slot that was not offered', { ...GOOD, kind: 'invite', slots: [9] }, request(SLOTS), 'no_free_time', 'no free time fit what they asked.'],
  ['anything else', { ...GOOD, kind: 'call' }, request(), 'other', 'Loggie could not find a move it could back with the thread.'],
];
for (const [name, move, req, code, because] of FAMILIES) {
  test(`the refusal for ${name} becomes ${code}`, () => {
    const checked = verdict(move, req);
    assert.equal(checked.ok, false, checked.reason);
    assert.equal(checked.retry, true);
    assert.deepEqual(noMoveOf(checked), { reason_code: code, because });
    assert.doesNotMatch(because, NAMES_A_MODEL); assert.ok(!because.includes('—'));
  });
}
test('a transport refusal has no NOMOVE reason; a passed move has none either', () => {
  for (const reply of [{ content: '{', finish_reason: 'length', model: SUPER }, { content: '', finish_reason: 'stop', model: SUPER }, { content: '{}', finish_reason: 'stop', model: 'other/model' }]) {
    const checked = checkMove(reply, request(), { me: 'Pell Varro', today: TODAY });
    assert.equal(checked.retry, false); assert.equal(noMoveOf(checked), null);
  }
  assert.equal(noMoveOf(verdict(GOOD)), null);
});

// --- the files
test('two content refusals write NOMOVE.json beside where MOVE.json would go, and the failure is still told', async () => {
  const h = await setup();
  const fake = sequence(tf(JSON.stringify(PAST)), tf(JSON.stringify(PAST)));
  const { result, runDirectory, run } = await press(h, fake);
  assert.equal(result.ok, false); assert.equal(fake.sent.length, 2);
  assert.deepEqual(await names(taskDirectory(h)), ['NOMOVE.json']);
  assert.deepEqual(await readNoMove(h), { at: TODAY.toISOString(), run, reason_code: 'past_date', because: 'the meeting already happened.' });
  assert.equal((await readEvents(runDirectory)).filter((event) => event.type === 'move.failed').length, 1);
  assert.deepEqual(await readCardMove(taskDirectory(h)), { kind: 'none', text: 'Loggie read this thread: no move yet, because the meeting already happened.' });
});
test('a refusal on the first answer that is not asked again (a kept line) still writes NOMOVE.json', async () => {
  const h = await setup();
  const fake = sequence(tf(JSON.stringify({ ...GOOD, drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill,\n\n[health kept on this Mac] Pell'] })));
  await press(h, fake);
  assert.equal(fake.sent.length, 1);
  assert.equal((await readNoMove(h)).reason_code, 'kept_line');
});
test('a transport failure writes no NOMOVE.json and binds no task', async () => {
  for (const body of [tf('{"kind":', { finish: 'length' }), tf(''), tf(JSON.stringify(GOOD), { model: 'acme/other-1' })]) {
    const h = await setup();
    const { result } = await press(h, sequence(body));
    assert.equal(result.ok, false);
    assert.deepEqual(await names(taskDirectory(h)), []);
    assert.equal(h.core.tasks.length, 0);
  }
  const h = await setup();
  const { result } = await press(h, { post: async () => { throw new Error('The network is down.'); } });
  assert.equal(result.ok, false); assert.equal(h.core.tasks.length, 0);
});
test('a read or wait answer with nothing to draft writes NOMOVE.json, not MOVE.json', async () => {
  for (const [kind, because] of [['wait', 'the next message is theirs to send.'], ['read', 'there is nothing to write, only a thread to read.']]) {
    const h = await setup();
    await press(h, sequence(tf(JSON.stringify({ ...GOOD, kind, drafts: [] }))));
    assert.deepEqual(await names(taskDirectory(h)), ['NOMOVE.json']);
    assert.deepEqual(await readCardMove(taskDirectory(h)), { kind: 'none', text: `Loggie read this thread: no move yet, because ${because}` });
  }
});
test('the latest of MOVE.json and NOMOVE.json wins, both ways', async () => {
  const h = await setup();
  const later = (minutes) => new Date(TODAY.getTime() + minutes * 60000);
  await press(h, sequence(tf(JSON.stringify(PAST))), later(0));
  assert.equal((await readCardMove(taskDirectory(h))).kind, 'none');
  await press(h, sequence(tf(JSON.stringify(GOOD))), later(1));
  assert.deepEqual(await names(taskDirectory(h)), ['MOVE.json', 'NOMOVE.json']);
  const card = await readCardMove(taskDirectory(h));
  assert.equal(card.kind, 'reply'); assert.equal(card.drafts.length, 3);
  await press(h, sequence(tf(JSON.stringify(PAST))), later(2));
  assert.equal((await readCardMove(taskDirectory(h))).kind, 'none');
  await press(h, sequence(tf(JSON.stringify(GOOD))), later(3));
  const again = await readCardMove(taskDirectory(h));
  assert.equal(again.kind, 'reply'); assert.equal(again.move_id, 'task_1#2');
  assert.equal(h.core.tasks.length, 1);
});
test('a task with neither file has no card move', async () => {
  assert.equal(await readCardMove(await mkdtemp(join(tmpdir(), 'hikyaku-nomove-empty-'))), null);
});

// --- the panel
test('the panel shows the quiet line for a none card and never a Do-it button or a draft', () => {
  const none = { kind: 'none', text: 'Loggie read this thread: no move yet, because the meeting already happened.' };
  assert.equal(noMoveLine({ move: none }), none.text);
  assert.equal(showsDoIt({ move: none }), false);
  assert.equal(noMoveLine({ move: { kind: 'reply', drafts: ['x'] } }), null);
  assert.equal(showsDoIt({ move: { kind: 'reply', drafts: ['x'] } }), true);
  assert.equal(noMoveLine({ move: null }), null); assert.equal(showsDoIt({ move: null }), true);
});
