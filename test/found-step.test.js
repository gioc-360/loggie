// The Found step (first-run-polish B4): what the look found, Keep and Dismiss in one locked write, and the rule at its
// heart (D1): a found workspace's mail is read only after Keep, and only for kept cards. Temp homes, made-up names, no
// Electron; main.js is read as text where it has no unit to call.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discover, NO_MAIL_SOURCE, SKIP_NO_KEY, SKIP_NO_YES } from '../src/hikyaku/discover.js';
import { approveFound, foundCardFields, foundCatchUp, foundRows, foundState, keepFound, MAX_ROWS, needCatchUp, needsReadYes, rowOf, zeroOf } from '../src/hikyaku/found.js';
import { firstNameOfFrom } from '../src/hikyaku/util.js';
import { cardList, dismissedNames, goalsFor, readWorkstreams, saveGoal, saveWorkstreamFields, updateWorkstreams } from '../src/hikyaku/workstreams.js';
import { setCloud } from '../src/hikyaku/cloud.js';
import { consentFor, grantCloudYes } from '../src/hikyaku/cloud-screen.js';
import { confirmGoal } from '../src/hikyaku/priorities.js';
import { countsLine, evidenceLine, keepLabel, progressFraction, progressLine, todayRowText, zeroCopy } from '../desktop/renderer/found-model.js';
import { mainText } from './helpers/main-files.js';

const DONE_AT = '2026-10-18T10:00:00.000Z';
const found = (at, extra = {}) => ({ quote: 'You have been elected treasurer of the Robotics Club.', subject: 'Club officers', from: 'Lee <lee@robotics.example>', date: '2026-10-09T15:00:00Z', at, threads: 3, yours: 2, ...extra });
const entry = (name, extra = {}) => ({ name, kind: 'other', domains: [], words: [name.split(' ')[0].toLowerCase()], ...extra });
const temp = () => mkdtemp(join(tmpdir(), 'loggie-found-'));
const write = (home, file, value) => writeFile(join(home, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const read = async (home, file) => JSON.parse(await readFile(join(home, file), 'utf8'));
const settings = (setup) => ({ setup: { done: true, step: 'ready', ...setup } });
const at = (minutes) => new Date(Date.parse(DONE_AT) + minutes * 60000).toISOString();

test('F1 foundRows: found, unkept, not dismissed, at or after Done, in file order, at most 20; a row holds no address', () => {
  const list = [
    entry('Before Done', { found: found(at(-5)) }),
    entry('Robotics Club Treasurer', { found: found(at(1), { quoteFrom: '"Smith, Dana" <dana@robotics.example>' }) }),
    entry('Kept Already', { found: found(at(2)), confirmed: at(3) }),
    entry('Dismissed Already', { found: found(at(2)), dismissed: at(3) }),
    entry('Bank Offer'),
    entry('Teaching Assistant ECON 1110', { found: { quote: '', subject: 'TA hours', from: '', date: '2026-10-12T15:00:00Z', at: at(1), fromSent: 4, threads: 0, yours: 4 }, label: 'TA 1110' }),
    ...Array.from({ length: 25 }, (_, i) => entry(`Many ${i}`, { found: found(at(10)) })),
  ];
  const rows = foundRows(list, { since: DONE_AT });
  assert.equal(rows.length, MAX_ROWS);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.name), ['Robotics Club Treasurer', 'Teaching Assistant ECON 1110', 'Many 0']);
  assert.deepEqual(rows[0], { name: 'Robotics Club Treasurer', label: null, quote: 'You have been elected treasurer of the Robotics Club.', subject: 'Club officers', sender: 'Dana', date: '2026-10-09T15:00:00Z', fromSent: 0, threads: 3, yours: 2 },
    'the sender is the quote\'s own, not the thread\'s last');
  assert.deepEqual([rows[1].label, rows[1].fromSent, rows[1].sender], ['TA 1110', 4, '']);
  assert.ok(!JSON.stringify(rows).includes('@'), 'no address leaves through a row');
  assert.equal(rowOf(entry('Old', { found: { quote: 'q', from: 'Ana Ruiz <a@x.example>', at: at(1) } })).sender, 'Ana', 'a card from before B4 falls back to from');
  assert.equal(firstNameOfFrom('"Smith, John" <j@x.example>'), 'John');
  assert.equal(firstNameOfFrom('Ana Ruiz <a@x.example>'), 'Ana');
  assert.equal(firstNameOfFrom('a@x.example'), '');
  assert.equal(firstNameOfFrom('"a@x.example" <a@x.example>'), '');
  assert.equal(firstNameOfFrom(''), '');
});

test('F2 zeroOf reads a flat runs line: each skip, another skip, a failure, a completed look', () => {
  assert.deepEqual(zeroOf({ at: DONE_AT, discover: true, skipped: NO_MAIL_SOURCE }), { reason: 'no-mail' });
  assert.deepEqual(zeroOf({ discover: true, skipped: SKIP_NO_YES }), { reason: 'no-yes' });
  assert.deepEqual(zeroOf({ discover: true, skipped: SKIP_NO_KEY }), { reason: 'no-key' });
  assert.deepEqual(zeroOf({ discover: true, skipped: 'Gmail is not connected' }), { reason: 'failed', message: 'Gmail is not connected' });
  assert.deepEqual(zeroOf({ discover: true, failed: 'x' }), { reason: 'failed', message: 'x' });
  assert.deepEqual(zeroOf({ discover: true, read: 1204, added: [], skipped: [{ name: 'X', why: 'proposed before' }] }), { reason: 'none', read: 1204 });
});

test('F3 foundState: running is searching; rows are found; a runs line after Done only is zero; else idle', async () => {
  const home = await temp();
  try {
    assert.equal((await foundState({ home })).phase, 'idle', 'no Done: idle');
    await write(home, 'settings.json', settings({ doneAt: DONE_AT }));
    assert.equal((await foundState({ home })).phase, 'idle', 'no look yet');
    await write(home, 'runs.jsonl', `${JSON.stringify({ at: at(-1), discover: true, skipped: SKIP_NO_KEY })}\n`);
    assert.equal((await foundState({ home })).phase, 'idle', 'a line before Done is not this look');
    const progress = { read: 280, total: 2214, naming: false };
    assert.deepEqual(await foundState({ home, running: true, progress }), { phase: 'searching', progress, rows: [], zero: null });
    await write(home, 'runs.jsonl', [{ at: at(1), discover: true, skipped: SKIP_NO_KEY }, { at: at(2), discover: true, dryRun: true, read: 9 }, 'not json'].map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
    assert.deepEqual(await foundState({ home }), { phase: 'zero', progress: null, rows: [], zero: { reason: 'no-key' } }, 'the last real look, a dry run and a bad line skipped');
    await write(home, 'workstreams.json', [entry('Robotics Club Treasurer', { found: found(at(1)) })]);
    const state = await foundState({ home });
    assert.deepEqual([state.phase, state.rows.map((row) => row.name)], ['found', ['Robotics Club Treasurer']]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F4 keepFound writes confirmed and dismissed at one time, saves the end, and a repeat changes nothing', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [entry('A', { found: found(at(1)) }), entry('B', { found: found(at(1)) }), entry('C', { found: found(at(1)) }), entry('Bank Offer')]);
    const saved = [];
    const saveSetupImpl = async (patch) => { saved.push(patch); };
    const now = new Date('2026-10-18T11:00:00Z');
    assert.deepEqual(await keepFound({ home, keep: ['A', 'C'], dismiss: ['B'], end: 'done', now, saveSetupImpl }), { kept: 2, dismissed: 1 });
    const list = await read(home, 'workstreams.json');
    assert.deepEqual(list.map((w) => [w.name, w.confirmed || null, w.dismissed || null]), [['A', now.toISOString(), null], ['B', null, now.toISOString()], ['C', now.toISOString(), null], ['Bank Offer', null, null]]);
    assert.deepEqual(saved, [{ found: 'done' }]);
    const before = await readFile(join(home, 'workstreams.json'), 'utf8');
    assert.deepEqual(await keepFound({ home, keep: ['A', 'C'], dismiss: ['B'], end: 'later', now: new Date(), saveSetupImpl }), { kept: 0, dismissed: 0 });
    assert.equal(await readFile(join(home, 'workstreams.json'), 'utf8'), before, 'the same call again writes nothing');
    assert.deepEqual(saved, [{ found: 'done' }, { found: 'later' }], 'Later still saves its end');
    await keepFound({ home, keep: [], dismiss: [], end: null, now, saveSetupImpl });
    assert.equal(saved.length, 2, 'the Workspaces band saves no end');
    // The default writes setup.found through saveSetup.
    await write(home, 'settings.json', settings({ doneAt: DONE_AT, found: 'pending' }));
    await keepFound({ home, keep: [], dismiss: [], end: 'done', now });
    assert.equal((await read(home, 'settings.json')).setup.found, 'done');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F5 keepFound skips an unknown name and one dismissed elsewhere, and still writes the others', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [entry('A', { found: found(at(1)) }), entry('Gone', { found: found(at(1)), dismissed: at(2) }), entry('Named')]);
    assert.deepEqual(await keepFound({ home, keep: ['A', 'Gone', 'Nobody', 'Named'], dismiss: [], end: null, now: new Date(at(5)) }), { kept: 1, dismissed: 0 });
    const list = await read(home, 'workstreams.json');
    assert.equal(list.find((w) => w.name === 'A').confirmed, at(5));
    assert.equal(list.find((w) => w.name === 'Gone').confirmed, undefined);
    assert.equal(list.find((w) => w.name === 'Named').confirmed, undefined, 'only a found card can be kept');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F5b a card the Found step dismissed leaves every list and is remembered as dismissed', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [entry('A', { found: found(at(1)) }), entry('B', { found: found(at(1)) })]);
    await keepFound({ home, keep: ['A'], dismiss: ['B'], end: null, now: new Date(at(5)) });
    assert.deepEqual((await readWorkstreams(home)).map((w) => [w.name, w.confirmed]), [['A', at(5)]]);
    assert.deepEqual(await dismissedNames(home), ['B']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F6 needCatchUp names kept cards with no state only; after Later nothing waits to be read (D1)', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [
      entry('Kept', { found: found(at(1)), confirmed: at(2) }),
      entry('Unkept', { found: found(at(1)) }),
      entry('Dismissed', { found: found(at(1)), confirmed: at(2), dismissed: at(3) }),
      entry('Read', { found: found(at(1)), confirmed: at(2) }),
      entry('Named', { confirmed: at(2) }),
    ]);
    await write(home, 'catchup-state.json', { Read: { seen: [] } });
    assert.deepEqual(await needCatchUp({ home }), ['Kept']);
    const later = await temp();
    await write(later, 'workstreams.json', [entry('A', { found: found(at(1)) }), entry('B', { found: found(at(1)) })]);
    await keepFound({ home: later, keep: [], dismiss: ['B'], end: 'later', now: new Date(at(5)), saveSetupImpl: async () => {} });
    assert.deepEqual(await needCatchUp({ home: later }), [], 'Later reads nothing: neither the dismissed card nor the unanswered one');
    await rm(later, { recursive: true, force: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F7 found-model: the evidence, counts, foot button, progress, zero copy and Today row', () => {
  const quote = { quote: 'You have been elected treasurer of the Robotics Club.', sender: 'Dana', date: '2026-10-09T15:00:00Z', subject: 'Club officers', fromSent: 0 };
  assert.equal(evidenceLine(quote), '“You have been elected treasurer of the Robotics Club.” · Dana, Oct 9 · Club officers');
  assert.equal(evidenceLine({ ...quote, sender: '', date: null, subject: '' }), '“You have been elected treasurer of the Robotics Club.”');
  assert.equal(evidenceLine({ ...quote, sender: '' }), '“You have been elected treasurer of the Robotics Club.”, Oct 9 · Club officers');
  const long = 'x'.repeat(130);
  assert.equal(evidenceLine({ quote: long }), `“${'x'.repeat(119)}…”`);
  assert.equal(evidenceLine({ quote: 'x'.repeat(120) }), `“${'x'.repeat(120)}”`);
  assert.equal(evidenceLine({ fromSent: 1, date: '2026-10-12T15:00:00Z', subject: 'TA hours' }), 'You wrote 1 email about this, last Oct 12 · TA hours');
  assert.equal(evidenceLine({ fromSent: 7, date: null, subject: '' }), 'You wrote 7 emails about this');
  assert.equal(evidenceLine({ subject: 'Only a subject' }), 'Only a subject');
  assert.equal(evidenceLine({}), '');
  assert.deepEqual([countsLine({ threads: 0, yours: 4 }), countsLine({ threads: 1, yours: 0 }), countsLine({ threads: 3, yours: 2 })], ['', '1 thread', '3 threads · 2 from you']);
  assert.deepEqual([keepLabel(1, 1), keepLabel(0, 1), keepLabel(2, 2), keepLabel(1, 2), keepLabel(0, 2), keepLabel(3, 5)],
    ['Keep it and continue', 'Continue without it', 'Keep all 2 and continue', 'Keep 1 of 2 and continue', 'Continue without them', 'Keep 3 of 5 and continue']);
  assert.deepEqual([progressLine(null), progressLine({ read: 3, total: 3, naming: true }), progressLine({ read: 0, total: 0, naming: false }), progressLine({ read: 280, total: 2214, naming: false })],
    ['Starting the look…', 'Naming what it found…', 'Reading what you wrote…', 'Read 280 of 2,214 email threads']);
  assert.deepEqual([progressFraction(null), progressFraction({ naming: true }), progressFraction({ read: 0, total: 0 }), progressFraction({ read: 280, total: 2214 })], [0, 1, 0, 280 / 2214]);
  assert.deepEqual(zeroCopy({ reason: 'no-mail' }), { line: 'Apple Mail has no mail account, so there was nothing to read. In Internet Accounts, add Microsoft Exchange (Outlook, school and work mail) or Google, then open Mail once.',
    button: { label: 'Add an account', act: 'ask' }, links: [{ label: 'Look again', act: 'look' }, { label: 'Continue', act: 'continue' }] });
  assert.deepEqual(zeroCopy({ reason: 'no-yes' }), { line: 'Loggie reads your mail only after your yes.', button: { label: 'Yes', act: 'yes' }, links: [{ label: 'Continue', act: 'continue' }] });
  assert.deepEqual(zeroCopy({ reason: 'no-key' }), { line: 'Loggie needs your Nebius key to read your mail.', button: { label: 'Add key', act: 'key' }, links: [{ label: 'Continue', act: 'continue' }] });
  assert.deepEqual(zeroCopy({ reason: 'none', read: 0 }), { line: 'No work in your mail looked new and yours. Loggie looks again every hour.', button: { label: 'Continue', act: 'continue' }, links: [] });
  assert.equal(zeroCopy({ reason: 'none', read: 1 }).line, 'No work in your mail looked new and yours. Read 1 email thread. Loggie looks again every hour.');
  assert.equal(zeroCopy({ reason: 'none', read: 1204 }).line, 'No work in your mail looked new and yours. Read 1204 email threads. Loggie looks again every hour.');
  assert.deepEqual(zeroCopy({ reason: 'failed', message: 'Mail timed out.' }), { line: 'The look stopped: Mail timed out.', button: { label: 'Look again', act: 'look' }, links: [{ label: 'Continue', act: 'continue' }] });
  assert.deepEqual([todayRowText(1), todayRowText(8)], ['Loggie found 1 workspace. Keep it if it is yours.', 'Loggie found 8 workspaces. Keep what is yours.']);
  const strings = JSON.stringify([zeroCopy({ reason: 'no-mail' }), zeroCopy({ reason: 'none', read: 2 }), todayRowText(2), keepLabel(1, 2), progressLine(null)]);
  assert.ok(!strings.includes('\u2014'), 'no em dash in the step\'s words');
});

// F9: main.js read as text, since main has no unit tests. No look reads a found card's mail (D1); no reply waits on a
// first read; lookRunning is false before the look's done line; the setup save answers with the saved setup.
test('F9 main: no look catches up; no handler awaits a first read; lookRunning ends before done; setup-save returns saved', async () => {
  const main = await mainText();
  const fn = (name) => { const start = main.indexOf(`async function ${name}(`); assert.ok(start > 0, name); return main.slice(start, main.indexOf('\n}\n', start)); };
  assert.ok(!main.includes('catchUpAfterLook'));
  for (const name of ['discoverWorkstreams', 'discoverAndSay']) assert.doesNotMatch(fn(name), /catchUpOn|catchUpFound/, `${name} reads no found card's mail`);
  const handlers = main.split("handleSecure('").slice(1).map((body) => body.slice(0, body.indexOf('\n  handleSecure(') >= 0 ? body.indexOf('\n  handleSecure(') : body.length));
  assert.ok(handlers.length > 50);
  for (const body of handlers) assert.doesNotMatch(body, /await catchUpFound/, `no reply waits on a first read: ${body.slice(0, 40)}`);
  const say = fn('discoverAndSay');
  const dones = [...say.matchAll(/sayDiscover\([^;]*, true\)/g)];
  assert.equal(dones.length, 2, 'a done line for a look that ended and one that stopped');
  for (const done of dones) {
    const before = say.slice(0, done.index);
    assert.ok(before.lastIndexOf('lookRunning = false') > Math.max(before.lastIndexOf('try {'), before.lastIndexOf('catch (error) {')), 'lookRunning = false comes first');
  }
  assert.match(say.split('\n')[1], /^\s*lookRunning = true; discoverProgress = null;/, 'the first statement');
  const save = main.slice(main.indexOf("handleSecure('hikyaku:setup-save'"), main.indexOf("\n  handleSecure(", main.indexOf("handleSecure('hikyaku:setup-save'") + 1));
  assert.match(save, /return saved;\n  \}\);\n/, "it ends with return saved;");
  // Every found card the refresh would read first is dropped (refresh.js firstReadsOut).
  assert.match(fn('refreshChanged'), /firstReadsOut\(changedWorkstreams\(/);
  // Any read of a found card nobody kept refuses, whatever asked for it.
  assert.match(fn('catchUpOn'), /if \(isNewFound\(found, /);
});

test('F11 the lock: a Keep and a look writing together both land; without it one is lost', async () => {
  const home = await temp();
  try {
    const start = [{ name: 'A', kind: 'other', domains: [], words: [], found: { quote: 'q', at: '2026-10-18T10:00:00.000Z' } }];
    await write(home, 'workstreams.json', start);
    const slowRead = async (path, encoding) => { await new Promise((resolve) => setTimeout(resolve, 20)); return readFile(path, encoding); };
    const complete = async (prompt) => (prompt.startsWith('<sent>') ? '{"name": "Robotics Club", "kind": "club", "words": ["robotics"]}' : '{"found": []}');
    const sent = [{ conversation: 'c1', subject: 'Robotics build night', primary: ['lee@robotics.example'], timestamp: '2026-10-10T10:00:00Z' },
      { conversation: 'c1', subject: 'Re: Robotics build night', primary: ['lee@robotics.example'], timestamp: '2026-10-12T10:00:00Z' }];
    await Promise.all([
      keepFound({ home, keep: ['A'], dismiss: [], end: null, now: new Date('2026-10-18T11:00:00Z'), readImpl: slowRead }),
      discover({ threads: [], workstreams: [], home, complete, ownAddress: 'sam@school.example', first: true, sent, update: (mutate) => updateWorkstreams(home, mutate, { readImpl: slowRead }) }),
    ]);
    const list = await read(home, 'workstreams.json');
    assert.equal(list.find((w) => w.name === 'A').confirmed, '2026-10-18T11:00:00.000Z');
    assert.ok(list.some((w) => w.name === 'Robotics Club'), 'the look\'s new card is there too');

    // The same two changes as plain read, wait, write: one is lost, so the test above can fail.
    await write(home, 'workstreams.json', start);
    const plain = async (change) => { const now = JSON.parse(await slowRead(join(home, 'workstreams.json'), 'utf8')); change(now); await writeFile(join(home, 'workstreams.json'), JSON.stringify(now)); };
    await Promise.all([plain((now) => { now[0].confirmed = 'x'; }), plain((now) => { now.push({ name: 'Robotics Club' }); })]);
    // Two writes at once can also interleave into a file that no longer parses: that loses both.
    const raced = await read(home, 'workstreams.json').catch(() => null);
    assert.ok(!(raced?.[0]?.confirmed && raced.some((w) => w.name === 'Robotics Club')), 'without the lock one change is lost');

    // A mutate that throws writes nothing, and the next update still runs.
    await write(home, 'workstreams.json', start);
    await assert.rejects(updateWorkstreams(home, () => { throw new Error('refused'); }), /refused/);
    assert.equal(await updateWorkstreams(home, (now) => { now.push({ name: 'B' }); return { list: now, result: 'ran' }; }), 'ran');
    assert.deepEqual((await read(home, 'workstreams.json')).map((w) => w.name), ['A', 'B']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('B6.4 the last four writers land together', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', ['A', 'B', 'C', 'D'].map((name) => ({ name, kind: 'job', domains: [], words: [] })));
    await Promise.all([setCloud(home, 'A', 'nebius'), saveGoal(home, 'B', goalsFor('job')[0]), confirmGoal(home, 'C', 'Land the offer'), saveWorkstreamFields(home, 'D', { stake: 'more' })]);
    const list = await read(home, 'workstreams.json');
    const of = (name) => list.find((w) => w.name === name);
    assert.equal(of('A').cloud, 'nebius');
    assert.equal(of('B').goal, goalsFor('job')[0]);
    assert.equal(of('C').goalText, 'Land the offer');
    assert.equal(of('D').stake, 'more');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// F12: a guard, not a proof. In the locked set, a function that names workstreams.json never writes a file itself.
test('F12 the locked writers write workstreams.json only through updateWorkstreams', async () => {
  const functionsOf = (text) => text.split(/\n(?=(?:export )?(?:async )?function )/).filter((chunk) => /^(?:export )?(?:async )?function /.test(chunk));
  const nameOf = (chunk) => /function (\w+)/.exec(chunk)[1];
  for (const file of ['discover.js', 'goal-shape.js', 'entry.js', 'found.js', 'cloud.js', 'priorities.js', 'send-gate.js']) {
    const text = await readFile(new URL(`../src/hikyaku/${file}`, import.meta.url), 'utf8');
    for (const chunk of functionsOf(text).filter((c) => c.includes("'workstreams.json'"))) assert.doesNotMatch(chunk, /writeFile\(/, `${file} ${nameOf(chunk)}`);
  }
  const workstreams = await readFile(new URL('../src/hikyaku/workstreams.js', import.meta.url), 'utf8');
  const writers = functionsOf(workstreams).filter((c) => c.includes("'workstreams.json'") && /writeFile\(|writeImpl\(/.test(c)).map(nameOf);
  assert.deepEqual(writers, ['updateWorkstreams']);
});

test('F15 the card: a found card nobody kept or read is new, whatever setup.found says; read or dismissed, it is not', async () => {
  const card = entry('Robotics Club Treasurer', { found: found(at(1)) });
  assert.deepEqual(foundCardFields(card, {}), { confirmed: null, newFound: true, foundRow: rowOf(card) });
  assert.deepEqual(foundCardFields(card, { 'Robotics Club Treasurer': { seen: [] } }), { confirmed: null, newFound: false, foundRow: null }, 'an install from before this build: read already');
  assert.deepEqual(foundCardFields({ ...card, confirmed: at(2) }, {}), { confirmed: at(2), newFound: false, foundRow: null });
  assert.equal(foundCardFields(entry('Bank Offer'), {}).newFound, false);
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [card, entry('Gone', { found: found(at(1)), dismissed: at(2) })]);
    const cards = cardList({ workstreams: await readWorkstreams(home), hidden: await dismissedNames(home) });
    assert.deepEqual(cards.map((w) => [w.name, foundCardFields(w, {}).newFound]), [['Robotics Club Treasurer', true]], 'a dismissed found card makes no card');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F16 a first read that fails is said, the next is still read, and the failed card still waits', async () => {
  const home = await temp();
  try {
    await write(home, 'workstreams.json', [entry('First', { found: found(at(1)), confirmed: at(2) }), entry('Second', { found: found(at(1)), confirmed: at(2) })]);
    const tried = [];
    const said = [];
    const catchUpOn = async (name) => {
      tried.push(name);
      if (name === 'First') throw new Error('Mail timed out.');
      await write(home, 'catchup-state.json', { [name]: { seen: [] } });
    };
    const catchUpFound = foundCatchUp({ catchUpOn, onRead: (name) => said.push(`read ${name}`), onError: (name, error) => said.push(`${name}: ${error.message}`) });
    await catchUpFound(await needCatchUp({ home }));
    assert.deepEqual(tried, ['First', 'Second']);
    assert.deepEqual(said, ['First: Mail timed out.', 'read Second']);
    assert.deepEqual(await needCatchUp({ home }), ['First'], 'read at the next launch');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// F17 (loggie-intros live fix, 2026-10-21): an install whose yes predates `found` kept a found card discover wrote with
// no approval, so its first read got needsYes and nothing filled it. Its page asks the yes; after the yes the card gets
// the approval a card found under the yes has, and its first read can run.
test('F17 a kept found card with no approval and no found yes asks the read yes; after the yes it is approved and waits for its read', async () => {
  const old = { cloudYes: { discover: true, triage: true, style: true, rank: true } };
  const kept = entry('Bank Outreach', { found: found(at(1)), confirmed: at(2) });
  assert.equal(needsReadYes(kept, old), true);
  assert.equal(needsReadYes({ ...kept, cloud: 'nebius' }, old), false, 'approved already');
  assert.equal(needsReadYes(kept, { cloudYes: { ...old.cloudYes, found: true } }), true, 'kept after the found yes, never approved: it still asks (2026-10-26)');
  assert.equal(needsReadYes(entry('Bank Outreach', { found: found(at(1)) }), old), false, 'not kept: the New band asks Keep first');
  assert.equal(needsReadYes({ ...kept, dismissed: at(3) }, old), false);
  assert.equal(needsReadYes(entry('Bank Offer'), old), false, 'a named workspace is not a found one');
  const home = await temp();
  try {
    await write(home, 'settings.json', old);
    await write(home, 'workstreams.json', [kept, entry('Robotics Club Treasurer', { found: found(at(1)) })]);
    const before = await readFile(join(home, 'workstreams.json'), 'utf8');
    await assert.rejects(approveFound({ home, name: 'Bank Outreach' }), /only after your yes/);
    assert.equal(await readFile(join(home, 'workstreams.json'), 'utf8'), before, 'no yes: nothing written');
    await grantCloudYes(home);
    assert.equal((await read(home, 'settings.json')).cloudYes.found, true);
    await assert.rejects(approveFound({ home, name: 'Robotics Club Treasurer' }), /not a workspace you kept/, 'a card nobody kept is never approved');
    assert.deepEqual(await approveFound({ home, name: 'Bank Outreach' }), { name: 'Bank Outreach', cloud: 'nebius', approved: ['Bank Outreach'] });
    const list = await read(home, 'workstreams.json');
    assert.deepEqual(list.map((w) => [w.name, w.cloud ?? null]), [['Bank Outreach', 'nebius'], ['Robotics Club Treasurer', null]]);
    assert.ok(consentFor('mail', { workstream: list[0] }), 'its mail read now has its approval');
    assert.deepEqual(await needCatchUp({ home }), ['Bank Outreach'], 'its first read still waits, for catchUpFound');
    assert.deepEqual(await approveFound({ home, name: 'Bank Outreach' }), { name: 'Bank Outreach', cloud: 'nebius', approved: [] });
  } finally { await rm(home, { recursive: true, force: true }); }
});

// F19: the yes covers found workspaces, so Yes on one kept card approves every kept found card without an approval,
// and each gets its first read, newest kept first, one at a time. Unkept and dismissed cards are untouched.
test('F19 Yes on one kept card approves every kept found card with no approval and reads each, newest first; unkept and dismissed untouched', async () => {
  const home = await temp();
  try {
    await write(home, 'settings.json', { cloudYes: { discover: true, triage: true, style: true, rank: true, found: true } });
    const unkept = entry('Robotics Club Treasurer', { found: found(at(1)) });
    const gone = entry('Gone', { found: found(at(1)), confirmed: at(2), dismissed: at(3) });
    const named = entry('Bank Offer');
    await write(home, 'workstreams.json', [entry('Older Kept', { found: found(at(1)), confirmed: at(2) }), unkept, gone, named, entry('Newer Kept', { found: found(at(1)), confirmed: at(4) })]);
    assert.deepEqual(await approveFound({ home, name: 'Older Kept' }), { name: 'Older Kept', cloud: 'nebius', approved: ['Newer Kept', 'Older Kept'] });
    const list = await read(home, 'workstreams.json');
    assert.deepEqual(list.map((w) => [w.name, w.cloud ?? null]), [['Older Kept', 'nebius'], ['Robotics Club Treasurer', null], ['Gone', null], ['Bank Offer', null], ['Newer Kept', 'nebius']]);
    assert.deepEqual(list[1], unkept);
    assert.deepEqual(list[2], gone);
    assert.deepEqual(list[3], named);
    const tried = [];
    let running = 0;
    const catchUpFound = foundCatchUp({ catchUpOn: async (name) => { running += 1; assert.equal(running, 1, 'one at a time'); tried.push(name); await new Promise((r) => setTimeout(r, 5)); running -= 1; } });
    await catchUpFound(await needCatchUp({ home, newest: true }));
    assert.deepEqual(tried, ['Newer Kept', 'Older Kept'], 'both read, newest kept first; the unkept and dismissed never');
    assert.deepEqual(await needCatchUp({ home }), ['Older Kept', 'Newer Kept'], 'file order without newest');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('F18 main: the found-read door approves, then starts the first read without waiting on it', async () => {
  const setup = await readFile(new URL('../desktop/main-ipc-setup.js', import.meta.url), 'utf8');
  const body = setup.slice(setup.indexOf("handleSecure('hikyaku:found-read'"), setup.indexOf('\n  });', setup.indexOf("handleSecure('hikyaku:found-read'")));
  assert.ok(body.length > 40);
  assert.ok(body.indexOf('await approveFound(') < body.indexOf('needCatchUp({ home, newest: true }).then(catchUpFound)'), 'approval first, then the reads, newest first');
  assert.doesNotMatch(body, /await catchUpFound|await needCatchUp/);
  const cards = await readFile(new URL('../desktop/main-ipc-workspaces.js', import.meta.url), 'utf8');
  assert.match(cards, /readYes: needsReadYes\(workstream, settingsNow\)/);
});
