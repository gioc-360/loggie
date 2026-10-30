// The event contract (spec-entry-b.md section 2, increment b#6): every step of the entry flow emits the events Jess's
// screens render, from one emitter (src/hikyaku/events.js), with one checker that a real run and the hand-written
// fixture (demo/entry/fixtures/events-example.jsonl) both pass. "What would leave your Mac" is one screen.line per
// sentence from the screen record's lines[]: every kept sentence is a kept line with its plain reason, and no sent line
// carries a kept sentence. line.hold keeps one more sentence on the Mac by preparing the send again without it, and
// sends nothing. Everything here is made up: the screen is a fake runner, the cloud is a fake client, Core is in
// memory, the mail app and the clipboard are stubs. No network, no keychain, no model server, temp folders only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkEvents, createEventTail, emitEvent, emitScreen, KEPT_REASONS, NAMES_A_MODEL, parseEvents, readEvents, summaryText, TYPES } from '../src/hikyaku/events.js';
import { holdLine } from '../src/hikyaku/hold-line.js';
import { aiOptions, approveSend, connectRequest, decideSend, pendingSends, prepareNextMove, prepareSend, runsRoot } from '../src/hikyaku/send-gate.js';
import { runNextMove } from '../src/hikyaku/next-move.js';
import { mailApps, openMoveDraft, pickMove } from '../src/hikyaku/pick.js';
import { validateDecide } from '../desktop/ipc-validation.js';
import { offerExisting } from '../src/hikyaku/entry.js';
import { storeCore } from './helpers/fake-core.js';
import { mainText } from './helpers/main-files.js';
import { filesUnder } from './helpers/files.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'demo', 'entry', 'fixtures', 'events-example.jsonl');
const TRANSCRIBER = '/fake/transcriber/spike';
const PROVIDER_NAMES = /nebius|claude|chatgpt|gemini|nemotron|token factory/i;
const md5 = (text) => createHash('md5').update(text).digest('hex');

// --- a made-up thread and call, screened by a fake screen that writes the real record shape (privacy.py lines_of)
const KEPT_THREAD = 'I have a knee scan at the clinic on Thursday morning.';
const LATER = 'Let me know which day works for a call.';
const THREAD = `# Re: Project kickoff\n\n## Lena Park <lena@example.com> · 2026-10-01T10:00:00Z\nTo: dana@example.org\n\nHappy to help with the kickoff.\n\n## Dana Reyes <dana@example.org> · 2026-10-03T14:00:00Z\nTo: lena@example.com\n\nCan you send the outline by Friday? ${KEPT_THREAD} ${LATER}\n\nDana Reyes | Acme\n`;
const OUTBOUND = `# Re: Project kickoff\n\n_Screened on this Mac by local-test: 1 of 5 sentences kept back; see HELD.json._\n\n## Lena Park · 2026-10-01T10:00:00Z\n\nHappy to help with the kickoff.\n\n## Dana Reyes · 2026-10-03T14:00:00Z\n\nCan you send the outline by Friday? [health kept on this Mac] ${LATER}\n`;
const row = (i, turn, time, speaker, text, kept = null) => ({ i, turn, time, speaker, status: kept ? 'kept' : 'sent', category: kept?.category ?? null, layer: kept?.layer ?? null, rule: kept?.rule ?? null, text });
const THREAD_LINES = [
  row(0, 0, '2026-10-01T10:00:00Z', 'Subject', 'Re: Project kickoff'),
  row(1, 1, '2026-10-01T10:00:00Z', 'Lena Park', 'Happy to help with the kickoff.'),
  row(2, 2, '2026-10-03T14:00:00Z', 'Dana Reyes', 'Can you send the outline by Friday?'),
  row(3, 2, '2026-10-03T14:00:00Z', 'Dana Reyes', KEPT_THREAD, { category: 'health', layer: 'model', rule: 'model' }),
  row(4, 2, '2026-10-03T14:00:00Z', 'Dana Reyes', LATER),
];
const HELD = {
  source: 'thread', model: 'local-test', counts: { sentences: 5, sent: 4, held: 1, turns: 3, turns_fully_held: 0, layer: { code: 0, model: 1, unchecked: 0 }, category: { health: 1 }, removed: { footer: 1, quoted: 0 } },
  held: [{ i: 3, time: '2026-10-03T14:00:00Z', speaker: 'Dana Reyes', category: 'health', layer: 'model', rule: 'model', text: KEPT_THREAD },
    { i: null, time: '2026-10-03T14:00:00Z', speaker: 'Dana Reyes', category: 'confidential', layer: 'code', rule: 'footer', text: 'Dana Reyes | Acme' }],
  lines: THREAD_LINES,
};
const KEPT_MONEY = 'My rent went up again this month.';
const KEPT_UNCHECKED = 'We could ask the board on Monday.';
const CALL_LINES = [
  row(0, 0, '00:02', 'Me', 'Thanks for making time today.'),
  row(1, 0, '00:02', 'Me', KEPT_MONEY, { category: 'money', layer: 'code', rule: 'rent' }),
  row(2, 1, '00:40', 'Dana Reyes', 'The outline is nearly done.'),
  row(3, 1, '00:40', 'Dana Reyes', KEPT_UNCHECKED, { category: 'unchecked', layer: 'unchecked', rule: 'timeout' }),
];
const CALL_HELD = { counts: { sentences: 4, sent: 2, held: 2, turns: 2, turns_fully_held: 0, layer: { code: 1, model: 0, unchecked: 1 }, category: { money: 1, unchecked: 1 } },
  held: CALL_LINES.filter((line) => line.status === 'kept').map(({ status, turn, ...line }) => line), lines: CALL_LINES };
const CALL_OUTBOUND = '[00:02] Me: Thanks for making time today. [money kept on this Mac]\n\n[00:40] Dana Reyes: The outline is nearly done. [unchecked kept on this Mac]\n';

function screenRunner(calls = []) {
  return async (command, args) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1];
    await writeFile(join(out, 'OUTBOUND.md'), OUTBOUND);
    await writeFile(join(out, 'HELD.json'), JSON.stringify(HELD));
    return { code: 0, stdout: '', stderr: '' };
  };
}

const fakeCore = () => storeCore({ projectId: (n) => `proj_${n}`, finders: true });

const DRAFTS = [
  'Hi Dana,\n\nThanks for the note. Friday works for the outline. Wednesday is good for a call.\n\nBest,\nLena',
  'Hi Dana,\n\nFriday is fine for the outline. Thursday afternoon is open for a call.\n\nBest,\nLena',
  'Hi Dana,\n\nThanks. The outline will be with you by Friday, and any weekday works for a call.\n\nBest,\nLena',
];
const MOVE = { thread_id: 'thread-1', title: 'Answer Dana about the outline', kind: 'reply', why: ['f1'], drafts: DRAFTS, slots: [], steps: [], quote: 'Can you send the outline by Friday?' };
function fakeClient(bodies = []) {
  return { post: async (body) => { bodies.push(body); return { content: JSON.stringify(MOVE), finish_reason: 'stop', model: 'nvidia/test-only', usage: { prompt_tokens: 10, completion_tokens: 5 }, seconds: 0.1 }; } };
}
const connected = { nebius: async () => true };

async function prepared() {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', goal: 'Get an offer', domains: [], words: [] }], null, 2));
  const callFolder = join(home, 'calls', '2026-10-05-1400-kickoff', 'v1');
  await mkdir(callFolder, { recursive: true });
  await writeFile(join(callFolder, 'outbound.md'), CALL_OUTBOUND);
  await writeFile(join(callFolder, 'held.json'), JSON.stringify(CALL_HELD));
  const workstreamDirectory = join(home, 'work', 'acme-bank');
  const screens = [];
  const send = await prepareNextMove({ home, workstream: 'Acme Bank', workstreamDirectory, transcriber: TRANSCRIBER, runner: screenRunner(screens),
    threads: [{ id: 'thread-1', md: THREAD, source: 'gmail' }],
    calls: [{ id: 'call:2026-10-05-1400-kickoff', outbound: join(callFolder, 'outbound.md'), held: join(callFolder, 'held.json') }] });
  return { home, send, workstreamDirectory, screens, runDirectory: join(runsRoot(home), send.run) };
}

const allEvents = async (home) => {
  const out = [];
  for (const run of (await readdir(runsRoot(home))).sort()) out.push(...await readEvents(join(runsRoot(home), run)));
  return out;
};
// The contract's own rule, asserted on its own as well as through checkEvents.
function assertTextRule(events) {
  for (const event of events) if (event.text) assert.doesNotMatch(event.text, NAMES_A_MODEL, `${event.type}: ${event.text}`);
  for (const event of events) {
    if (['ai.options', 'ai.picked', 'ai.connect', 'outbound.sent'].includes(event.type) || event.type === 'screen.line') continue;
    for (const key of ['provider', 'provider_id', 'options', 'model']) assert.ok(!(key in event.data), `${event.type} carries data.${key}`);
  }
}

test('every kept sentence of every screen record is a kept screen.line, and no sent line carries a kept sentence', async () => {
  const h = await prepared();
  const events = await readEvents(h.runDirectory);
  const { ok, problems } = checkEvents(events);
  assert.ok(ok, problems.join('\n'));
  const lines = events.filter((event) => event.type === 'screen.line').map((event) => event.data);
  for (const [sourceId, record] of [['thread-1', HELD], ['call:2026-10-05-1400-kickoff', CALL_HELD]]) {
    const mine = lines.filter((line) => line.source_id === sourceId);
    assert.equal(mine.length, record.lines.length, `one screen.line per sentence of ${sourceId}`);
    assert.deepEqual(mine.map((line) => line.i), record.lines.map((line) => line.i));
    for (const kept of record.lines.filter((line) => line.status === 'kept')) {
      const shown = mine.find((line) => line.i === kept.i);
      assert.equal(shown.status, 'kept', `${sourceId} #${kept.i} is shown as kept`);
      assert.equal(shown.text, kept.text);
      assert.equal(shown.reason, KEPT_REASONS[kept.category], 'the plain reason of the spec table');
    }
    for (const held of record.held.filter((item) => Number.isInteger(item.i))) assert.equal(mine.find((line) => line.i === held.i)?.status, 'kept', `held[] #${held.i} is a kept line`);
  }
  const keptTexts = [...HELD.held, ...CALL_HELD.held].map((item) => item.text);
  for (const line of lines.filter((item) => item.status === 'sent')) {
    for (const text of keptTexts) assert.ok(!line.text.includes(text), `a sent line carries a kept sentence: ${line.text}`);
    assert.deepEqual([line.category, line.layer, line.rule, line.reason], [null, null, null, null]);
  }
  // The summary follows the last line of its source; the cut footer is counted there, not shown as a sentence.
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['run.started', 'step.started', 'step.progress', 'step.finished',
    ...THREAD_LINES.map(() => 'screen.line'), 'screen.summary', ...CALL_LINES.map(() => 'screen.line'), 'screen.summary']);
  const summary = events.find((event) => event.type === 'screen.summary').data;
  assert.deepEqual(summary.counts, HELD.counts); assert.equal(summary.lines, 5);
  assert.ok(!lines.some((line) => line.text === 'Dana Reyes | Acme'));
  assertTextRule(events);
});

test('one full flow, prepare to pick, passes the checker: seq without gaps, no text names a model, an AI is named only where it is chosen', async () => {
  const h = await prepared();
  const core = fakeCore();
  const bodies = [];
  await aiOptions({ home: h.home, run: h.send.run, checks: connected });
  const asked = await connectRequest({ home: h.home, run: h.send.run, provider: 'nebius' });
  assert.deepEqual([asked.recorded, asked.connected], [true, false]);
  await assert.rejects(connectRequest({ home: h.home, run: h.send.run, provider: 'nobody' }), /Pick one of/);
  const held = await holdLine({ home: h.home, run: h.send.run, sourceId: 'thread-1', i: 4 });
  await aiOptions({ home: h.home, run: held.run, checks: connected });
  const result = await approveSend({ home: h.home, run: held.run, provider: 'nebius', remember: true, checks: connected, transcriber: TRANSCRIBER,
    runner: async () => { throw new Error('no command runs for a next move'); },
    nextMove: (input) => runNextMove({ ...input, client: fakeClient(bodies), core, me: 'Lena Park', eventsImpl: async () => [], now: () => new Date('2026-10-06T12:00:00Z') }) });
  assert.equal(result.ok, true, result.reason);
  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0].includes(LATER) && !bodies[0].includes(KEPT_THREAD) && !bodies[0].includes(KEPT_MONEY), 'the request carries no kept sentence');
  const project = (await core.listProjects())[0];
  const taskDirectory = join(project.directoryPath, (await core.listTasks())[0].id);
  await mailApps({ home: h.home, taskDirectory, settings: {}, appExists: async () => true });
  await openMoveDraft({ home: h.home, taskDirectory, n: 2, app: 'outlook', settings: {}, appExists: async () => true, openDraftImpl: async () => ({}), clipboardImpl: async () => {} });
  await pickMove({ home: h.home, taskDirectory, choice: { type: 'skipped' } });

  const events = await allEvents(h.home);
  const { ok, problems } = checkEvents(events);
  assert.ok(ok, problems.join('\n'));
  assertTextRule(events);
  const types = new Set(events.map((event) => event.type));
  for (const type of ['run.started', 'step.started', 'step.progress', 'step.finished', 'screen.line', 'screen.summary', 'ai.options', 'ai.connect', 'line.hold', 'ai.picked',
    'outbound.sent', 'outbound.returned', 'move.ready', 'run.finished', 'mail.apps', 'draft.open', 'pick.recorded']) assert.ok(types.has(type), `emits ${type}`);
  for (const event of events) {
    if (['ai.options', 'ai.picked', 'ai.connect', 'outbound.sent'].includes(event.type)) continue;
    const { text, ...data } = event.type === 'screen.line' ? event.data : { ...event.data, text: null };
    assert.doesNotMatch(JSON.stringify(data), PROVIDER_NAMES, `${event.type} names an AI in its data`);
  }
  // The bubbles are the fixed strings.
  const bubbles = events.filter((event) => event.type === 'step.started').map((event) => event.text);
  assert.deepEqual([...new Set(bubbles)].sort(), ['Screening on your Mac', 'Writing your next move']);
});

test('line.hold prepares the send again without that sentence, and sends nothing', async () => {
  const h = await prepared();
  const oldSend = h.send;
  const before = await readFile(oldSend.outbound[0], 'utf8');
  const result = await holdLine({ home: h.home, run: oldSend.run, sourceId: 'thread-1', i: 4, category: 'confidential' });
  // nothing was sent, nothing ran: no receipt, no move, no send marked sent, no second screen.
  assert.equal(h.screens.length, 1, 'nothing was screened again');
  const files = await filesUnder(h.home);
  assert.ok(!files.some((file) => /SENT\.json$|MOVE\.json$/.test(file)), 'no receipt and no move');
  // the old send is superseded and kept as it was; the new one is pending with the line kept.
  const sends = await pendingSends(h.home);
  assert.deepEqual(sends.map((send) => send.run), [result.run]);
  assert.equal(JSON.parse(await readFile(join(runsRoot(h.home), oldSend.run, 'send.json'), 'utf8')).status, 'superseded');
  assert.equal(md5(await readFile(oldSend.outbound[0], 'utf8')), md5(before), 'the reviewed pair is never rewritten');
  const next = sends[0];
  assert.equal(next.sentences_sent, oldSend.sentences_sent - 1); assert.equal(next.sentences_kept, oldSend.sentences_kept + 1);
  assert.ok(next.outbound[0].endsWith('OUTBOUND-2.md') && next.held[0].endsWith('HELD-2.json'));
  assert.equal(next.outbound[1], oldSend.outbound[1], 'the call is carried as reviewed');
  assert.equal(next.sha256[1], oldSend.sha256[1]);
  const text = await readFile(next.outbound[0], 'utf8');
  assert.ok(!text.includes(LATER) && text.includes('[confidential kept on this Mac]'), text);
  assert.equal(next.sha256[0], createHash('sha256').update(text).digest('hex'), 'the new file is what Send will check');
  const record = JSON.parse(await readFile(next.held[0], 'utf8'));
  assert.deepEqual(record.lines.find((line) => line.i === 4), { ...THREAD_LINES[4], status: 'kept', category: 'confidential', layer: 'user', rule: 'line.hold' });
  assert.ok(record.held.some((item) => item.i === 4 && item.text === LATER), 'the next-move gate reads it as held');
  assert.equal(record.counts.layer.user, 1);
  // the events: line.hold in both runs; the new run shows the line kept, with the user's reason.
  for (const run of [oldSend.run, result.run]) {
    const hold = (await readEvents(join(runsRoot(h.home), run))).filter((event) => event.type === 'line.hold');
    assert.equal(hold.length, 1); assert.deepEqual(hold[0].data, { run: oldSend.run, moved_to: result.run, source_id: 'thread-1', i: 4, category: 'confidential' });
  }
  const shown = (await readEvents(join(runsRoot(h.home), result.run))).filter((event) => event.type === 'screen.line' && event.data.source_id === 'thread-1' && event.data.i === 4);
  assert.equal(shown.length, 1); assert.equal(shown[0].data.status, 'kept'); assert.equal(shown[0].data.reason, 'you chose to keep it');
  assert.ok(checkEvents(await allEvents(h.home)).ok);
  // refusals write nothing: the old send, a line already kept, a sentence that is not there, a bad category.
  const count = (await filesUnder(h.home)).length;
  await assert.rejects(holdLine({ home: h.home, run: oldSend.run, sourceId: 'thread-1', i: 2 }), /newer send replaced/);
  await assert.rejects(holdLine({ home: h.home, run: result.run, sourceId: 'thread-1', i: 3 }), /already kept/);
  await assert.rejects(holdLine({ home: h.home, run: result.run, sourceId: 'thread-1', i: 40 }), /no sentence 40/);
  await assert.rejects(holdLine({ home: h.home, run: result.run, sourceId: 'thread-9', i: 1 }), /not in this send/);
  await assert.rejects(holdLine({ home: h.home, run: result.run, sourceId: 'thread-1', i: 1, category: 'gossip' }), /Pick one of/);
  assert.equal((await filesUnder(h.home)).length, count);
  // a file changed since the review: refused, nothing written.
  await writeFile(next.outbound[1], 'something new\n');
  await assert.rejects(holdLine({ home: h.home, run: result.run, sourceId: 'thread-1', i: 1 }), /changed since you reviewed/);
  assert.equal((await filesUnder(h.home)).length, count);
});

test('the fixture Jess designs against passes the same checker and covers the screens 3 to 6 events', async () => {
  const events = parseEvents(await readFile(FIXTURE, 'utf8'));
  const { ok, problems } = checkEvents(events);
  assert.ok(ok, problems.join('\n'));
  assertTextRule(events);
  const types = new Set(events.map((event) => event.type));
  const flow = Object.keys(TYPES).filter((type) => !type.startsWith('workstream.') && !type.startsWith('meeting.') && !type.startsWith('setup.') && type !== 'send.decided' && type !== 'move.failed');
  for (const type of flow) assert.ok(types.has(type), `the fixture shows ${type}`);
  for (const type of types) assert.ok(TYPES[type], `the fixture has only built types (${type})`);
  // one call, its kept lines, and the line the user kept: the hold moves the view to the next run.
  const hold = events.find((event) => event.type === 'line.hold');
  const kept = events.filter((event) => event.run === hold.data.moved_to && event.type === 'screen.line' && event.data.i === hold.data.i);
  assert.equal(kept.length, 1); assert.equal(kept[0].data.status, 'kept'); assert.equal(kept[0].data.reason, 'you chose to keep it');
  for (const line of events.filter((event) => event.type === 'screen.line' && event.data.status === 'kept')) assert.ok(line.data.reason, 'every kept line has its reason');
});

test('the checker and the emitter refuse an event that breaks the contract, and a refused event writes nothing', async () => {
  const good = parseEvents(await readFile(FIXTURE, 'utf8')).filter((event) => event.run === '20261012-140210-a1b2');
  const broken = (change) => checkEvents(change(structuredClone(good))).problems.join('\n');
  assert.match(broken((events) => events.filter((event) => event.seq !== 3)), /expected 3/);
  assert.match(broken((events) => { events[1].text = 'Asking Nemotron'; return events; }), /names a model/);
  assert.match(broken((events) => { events[1].text = 'Reading everything'; return events; }), /fixed texts/);
  assert.match(broken((events) => { events[0].data.provider = 'nebius'; return events; }), /names an AI/);
  assert.match(broken((events) => { events[0].type = 'goals.drafted'; return events; }), /unknown type/);
  assert.match(broken((events) => { const line = events.find((event) => event.type === 'screen.line' && event.data.status === 'kept'); line.data.reason = null; return events; }), /plain reason/);
  assert.match(broken((events) => { const line = events.find((event) => event.type === 'screen.line' && event.data.status === 'sent'); line.data.category = 'health'; return events; }), /sent line has no/);
  assert.match(broken((events) => { delete events[0].data.workstream; return events; }), /no workstream/);

  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  const runDirectory = join(runsRoot(home), '20261008-120000-abcd');
  await assert.rejects(emitEvent(runDirectory, { type: 'step.started', step: 'ask', text: 'Writing with the model', data: { step: 'ask', index: 1, of: 1 } }), /event contract/);
  await assert.rejects(emitEvent(runDirectory, { type: 'run.started', data: {} }), /no source/);
  assert.deepEqual(await readEvents(runDirectory), []);
  // two appends at once from this process never share a seq
  await Promise.all([1, 2, 3, 4, 5].map((n) => emitEvent(runDirectory, { type: 'step.progress', step: 'screen', data: { step: 'screen', done: n, total: 5, unit: 'batches' } })));
  assert.deepEqual((await readEvents(runDirectory)).map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test('the desktop tail forwards each new line once, from any run, and never replays old runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  const old = join(runsRoot(home), '20261008-110000-0001');
  await emitEvent(old, { type: 'run.started', data: { source: 'call', title: 'Old', workstream: null } });
  const seen = [];
  const tail = createEventTail({ home, onEvent: (event) => seen.push(`${event.run}#${event.seq}`) });
  await tail.poll();
  assert.deepEqual(seen, [], 'old runs are not replayed');
  await emitEvent(old, { type: 'run.finished', data: { ok: true, seconds: 1, moves: 0, sentences_sent: 0, sentences_kept: 0 } });
  const fresh = join(runsRoot(home), '20261008-120000-0002');
  await emitEvent(fresh, { type: 'run.started', data: { source: 'inbox', title: 'New', workstream: null } });
  // a line still being written waits for its newline
  await appendFile(join(fresh, 'events.jsonl'), '{"v":1,"run":"20261008-120000-0002","se');
  await tail.poll();
  assert.deepEqual(seen, ['20261008-110000-0001#2', '20261008-120000-0002#1']);
  await tail.poll();
  assert.equal(seen.length, 2, 'each line once');

  // The renderer side: preload exposes onEntry; main.js forwards on hikyaku:entry.
  const preload = await readFile(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
  const main = await mainText();
  assert.match(preload, /onEntry: \(listener\)/); assert.match(preload, /ipcRenderer\.on\('hikyaku:entry'/);
  assert.match(main, /webContents\.send\('hikyaku:entry', event\)/);
});

// --- increment 12: the meeting events join the contract; a title with a model word lives in data, never in text
test('meeting.offered and meeting.answered pass the contract with the title in data, and are refused with it in text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  const runDirectory = join(runsRoot(home), '20261008-170000-ab12');
  const offer = { offer_id: '20261008-170000-ab12', source: 'calendar', key: 'LBO Model Review|2026-10-08T17:00:00-04:00', title: 'LBO Model Review', start: '2026-10-08T17:00:00-04:00', end: '2026-10-08T17:45:00-04:00',
    people: 3, names: ['Person0 Example'], emails: ['person0@example.org'], place: 'Microsoft Teams Meeting', link_kind: 'marker', reason: 'teams', expires: '2026-10-08T17:45:00-04:00' };
  const offered = await emitEvent(runDirectory, { type: 'meeting.offered', text: 'A meeting is starting. Transcribe it?', data: offer });
  assert.equal(offered.data.title, 'LBO Model Review');
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.offered', text: 'LBO Model Review is starting. Transcribe it?', data: offer }), /names a model/);
  const { expires, ...short } = offer;
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.offered', text: 'A meeting is starting. Transcribe it?', data: short }), /no expires/);
  await emitEvent(runDirectory, { type: 'meeting.answered', data: { offer_id: offer.offer_id, answer: 'record', call: '2026-10-08-1700-lbo-model-review' } });
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.answered', data: { offer_id: offer.offer_id, answer: 'dismiss' } }), /no call/);
  const events = await readEvents(runDirectory);
  assert.deepEqual(events.map((event) => [event.type, event.seq]), [['meeting.offered', 1], ['meeting.answered', 2]]);
  assert.ok(checkEvents(events).ok);
  assertTextRule(events);
});

// B16: the "New workstream?" offer lists the call's own candidates (a tie in call.py derive) before the rest.
test('workstream.offer lists the call\'s workstream candidates first in existing[]', () => {
  const workstreams = [{ name: 'Acme Bank' }, { name: 'Inbox', inbox: true }, { name: 'Riverside Lab' }, { name: 'Book Club' }, { name: 'Chats', chats: true }, { name: 'Notes', folder: 'x' }];
  assert.deepEqual(offerExisting(workstreams), ['Acme Bank', 'Riverside Lab', 'Book Club']);
  assert.deepEqual(offerExisting(workstreams, ['Book Club', 'Riverside Lab']), ['Book Club', 'Riverside Lab', 'Acme Bank']);
  assert.deepEqual(offerExisting(workstreams, ['Gone', 'Inbox', 'Acme Bank']), ['Acme Bank', 'Riverside Lab', 'Book Club'], 'a candidate that is not one of the user\'s workstreams is not listed');
});

// --- increment 14: the end ask and its answer join the contract
test('meeting.end_asked and meeting.end_answered pass the contract; a missing field is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  const runDirectory = join(runsRoot(home), '20261008-180000-cd34');
  const call = '2026-10-08-1700-lbo-model-review';
  await emitEvent(runDirectory, { type: 'meeting.end_asked', text: 'Done? Write it up.', data: { call, reason: 'event_ended', since: '2026-10-08T17:45:00-04:00', asked_before: 0 } });
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.end_asked', text: 'Done? Write it up.', data: { call, reason: 'event_ended', since: '2026-10-08T17:45:00-04:00' } }), /no asked_before/);
  await emitEvent(runDirectory, { type: 'meeting.end_answered', data: { call, answer: 'keep' } });
  const events = await readEvents(runDirectory);
  assert.deepEqual(events.map((event) => event.type), ['meeting.end_asked', 'meeting.end_answered']);
  assert.ok(checkEvents(events).ok);
  assertTextRule(events);
});

// --- live transcription L7: meeting.heard, the reader's "still listening" line
test('meeting.heard passes the contract with its fixed text; a model name or a missing field is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  const runDirectory = join(runsRoot(home), '20261008-190000-ef56');
  const data = { call: '2026-10-08-1700-lbo-model-review', heard_s: 3120, read_s: 3100, behind_s: 20, pieces: 104 };
  await emitEvent(runDirectory, { type: 'run.started', data: { source: 'call', title: 'LBO Model Review', workstream: null } });
  await emitEvent(runDirectory, { type: 'meeting.heard', text: 'Loggie is listening', data });
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.heard', text: 'Parakeet is listening', data }), /names a model/);
  const { pieces, ...short } = data;
  await assert.rejects(emitEvent(runDirectory, { type: 'meeting.heard', text: 'Loggie is listening', data: short }), /no pieces/);
  const events = await readEvents(runDirectory);
  assert.deepEqual(events.map((event) => event.type), ['run.started', 'meeting.heard']);
  assert.ok(checkEvents(events).ok);
  assert.deepEqual(TYPES['meeting.heard'], ['call', 'heard_s', 'read_s', 'behind_s', 'pieces']);
  assertTextRule(events);
});

// --- increment 15: send.decided joins the contract; it carries no provider and one lands per run
test('send.decided passes the contract on a Yes run and a No run, once each, and refuses a provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-entry-events-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [], cloud: 'nebius' }]));
  const quiet = async () => ({ code: 0, stdout: '', stderr: '' });
  const call = async () => {
    const folder = join(home, 'calls', 'coffee-chat', 'v1');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'outbound.md'), '[00:02] Me: Hi Sam, thanks for making time today.\n');
    await writeFile(join(folder, 'held.json'), JSON.stringify({ counts: { sent: 1, held: 0 } }));
    return (await prepareSend({ home, what: 'call-notes', sourceIds: ['call:coffee-chat'], folder, outbound: [join(folder, 'outbound.md')], held: [join(folder, 'held.json')], counts: [{ sent: 1, held: 0 }], workstream: 'Acme Bank', title: 'Coffee chat' })).run;
  };
  const yes = await call();
  await decideSend({ home, run: yes, decision: 'yes', checks: { nebius: async () => true }, runner: quiet, transcriber: TRANSCRIBER });
  const no = await call();
  await decideSend({ home, run: no, decision: 'no', checks: {}, runner: quiet, transcriber: TRANSCRIBER });
  for (const run of [yes, no]) {
    const events = await readEvents(join(runsRoot(home), run));
    assert.equal(events.filter((event) => event.type === 'send.decided').length, 1);
    assert.ok(checkEvents(events).ok, checkEvents(events).problems.join('\n'));
    assertTextRule(events);
  }
  await assert.rejects(emitEvent(join(runsRoot(home), no), { type: 'send.decided', step: 'ask', text: 'You decided', data: { run: no, decision: 'no', picker_shown: false, provider: 'claude' } }), /names an AI/);
  await assert.rejects(emitEvent(join(runsRoot(home), no), { type: 'send.decided', step: 'ask', text: 'You decided', data: { run: no, decision: 'no' } }), /no picker_shown/);
  assert.deepEqual(validateDecide('20261008-120000-0002', 'yes'), { run: '20261008-120000-0002', decision: 'yes' });
  assert.throws(() => validateDecide('../x', 'yes'), /not a send/);
  assert.throws(() => validateDecide('20261008-120000-0002', 'maybe'), /Yes or No/);
});

// --- a class (loggie-class-notes I3, spec 1.8 and gate 3.1): classmates left as Student N, made-up people only.
const CLASS_LINES = [
  row(0, 0, '00:05', 'Me', 'Good morning everyone.'),
  row(1, 1, '00:20', 'Student 1', 'I think Student 3 had the best point on pricing.'),
  row(2, 1, '00:20', 'Student 1', 'My visa interview is next week.', { category: 'identity', layer: 'code', rule: 'visa' }),
  row(3, 2, '01:10', 'Me', 'Thanks, Student 2, that helps.'),
];
const CLASS_NAMES = {
  'Student 1': { name: 'Wren Halvorsen', forms: ['Wren Halvorsen', 'Wren'], unclear: false, likely: null, rule: 'invitee', at: 0 },
  'Student 2': { name: 'Odile', forms: ['Odile'], unclear: false, likely: null, rule: 'addressed', at: 3 },
  'Student 3': { name: 'Tamsin', forms: ['Tamsin'], unclear: false, likely: null, rule: 'addressed', at: 1 },
};
const CLASS_HELD = { counts: { sentences: 4, sent: 3, held: 1, turns: 3, turns_fully_held: 0, layer: { code: 1 }, category: { identity: 1 }, masked: { labels: 3, mentions: 4 } },
  held: CLASS_LINES.filter((line) => line.status === 'kept').map(({ status, turn, ...line }) => line), lines: CLASS_LINES, names: CLASS_NAMES };
const CLASS_OUTBOUND = '[00:05] Me: Good morning everyone.\n\n[00:20] Student 1: I think Student 3 had the best point on pricing. [identity kept on this Mac]\n\n[01:10] Me: Thanks, Student 2, that helps.\n';

test('the screen line says how many classmates left as Student N, only for a class (emitScreen, the same words as sendgate.py)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-class-screen-'));
  const folder = join(home, 'calls', '2026-10-06-0905-strt5010', 'v1');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'outbound.md'), CLASS_OUTBOUND);
  await writeFile(join(folder, 'held.json'), JSON.stringify(CLASS_HELD));
  await writeFile(join(folder, 'held-plain.json'), JSON.stringify(CALL_HELD));
  const run = join(runsRoot(home), '20261006-100000-c1a5');
  const said = await emitScreen(run, { source: 'call', sourceId: 'call:2026-10-06-0905-strt5010', outbound: join(folder, 'outbound.md'), held: join(folder, 'held.json') });
  assert.equal(said.text, '3 sentences cleared, 1 kept on this Mac, 3 classmates written as Student 1 to 3');
  const plain = await emitScreen(run, { source: 'call', sourceId: 'call:2026-10-05-1400-kickoff', outbound: join(folder, 'outbound.md'), held: join(folder, 'held-plain.json') });
  assert.equal(plain.text, '2 sentences cleared, 2 kept on this Mac', 'a call with no labels reads as before');
  assert.equal(summaryText({ sent: 585, held: 2, masked: { labels: 7, mentions: 31 } }), '585 sentences cleared, 2 kept on this Mac, 7 classmates written as Student 1 to 7');
  assert.equal(summaryText({ sent: 9, held: 0, masked: { labels: 0, mentions: 0 } }), '9 sentences cleared, 0 kept on this Mac');
  assert.equal(summaryText({ sent: 9, held: 0, masked: { labels: 1, mentions: 2 } }), '9 sentences cleared, 0 kept on this Mac, 1 classmate written as Student 1');
  // loggie-interview-privacy: the same words as sendgate.py summary_text for a trimmed call.
  assert.equal(summaryText({ sent: 723, held: 5, trimmed: { people: 4, mentions: 13 } }), '723 sentences cleared, 5 kept on this Mac, 4 people by first name only');
  assert.equal(summaryText({ sent: 9, held: 0, trimmed: { people: 1, mentions: 1 } }), '9 sentences cleared, 0 kept on this Mac, 1 person by first name only');
  assert.equal(summaryText({ sent: 9, held: 0, trimmed: { people: 0, mentions: 0 } }), '9 sentences cleared, 0 kept on this Mac');
  assert.ok(checkEvents(await readEvents(run)).ok);
});

test('Keep this line on a class: the masked sentence is found, kept, and the new held file keeps the names map', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-class-hold-'));
  const folder = join(home, 'calls', '2026-10-06-0905-strt5010', 'v1');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'outbound.md'), CLASS_OUTBOUND);
  await writeFile(join(folder, 'held.json'), JSON.stringify(CLASS_HELD));
  const send = await prepareSend({ home, what: 'call-notes', sourceIds: ['call:2026-10-06-0905-strt5010'], folder, outbound: [join(folder, 'outbound.md')], held: [join(folder, 'held.json')],
    counts: [CLASS_HELD.counts], title: 'STRT 5010', extra: { classmates: 3 } });
  const result = await holdLine({ home, run: send.run, sourceId: 'call:2026-10-06-0905-strt5010', i: 1 });
  const [next] = await pendingSends(home);
  assert.equal(next.run, result.run);
  assert.equal(next.classmates, 3, 'the re-prepared send keeps its classmates, so the yes card keeps the class line');
  assert.ok(next.held[0].endsWith('held-2.json') && next.outbound[0].endsWith('outbound-2.md'));
  const text = await readFile(next.outbound[0], 'utf8');
  assert.ok(!text.includes('Student 3 had the best point') && text.includes('[confidential kept on this Mac]'), text);
  const record = JSON.parse(await readFile(next.held[0], 'utf8'));
  assert.deepEqual(record.names, CLASS_NAMES, 'the rewritten held file carries the call\'s map');
  assert.deepEqual(record.counts.masked, CLASS_HELD.counts.masked);
  assert.equal(record.lines.find((line) => line.i === 1).status, 'kept');
  for (const name of ['Wren', 'Halvorsen', 'Odile', 'Tamsin']) assert.ok(!text.includes(name), `${name} is not in what would leave`);
});
