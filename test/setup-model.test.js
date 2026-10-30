// The setup's pure rules (desktop/renderer/setup-model.js, docs/teammate-ready/spec.md B2 and B5). Made-up settings only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundRuns, isSetupDone, STEPS } from '../desktop/renderer/setup-model.js';

test('nine steps in the mock-up\'s order', () => {
  assert.deepEqual(STEPS, ['welcome', 'email', 'calendar', 'disk', 'apps', 'voice', 'keys', 'calls', 'ready']);
});

test('a fresh Mac is not done: setup opens', () => {
  assert.equal(isSetupDone({}), false);
  assert.equal(isSetupDone(null), false);
});

// 2026-10-28 (Gio): setup opens once on an install from before setup existed. Jess had Loggie before onboarding: her
// settings had a name, a mail app and workspaces but no setup record, and the old rule read that as done.
test('an install from before setup existed is not done, so setup opens once (Jess); a setup that said done is done (Gio)', () => {
  const jess = { signName: 'Jess', mailApp: 'outlook', chats: ['messages'], cloudYes: { discover: true, triage: true, style: true, rank: true } };
  assert.equal(isSetupDone(jess, { existing: true }), false, 'a name, a mail app and workstreams.json, no setup record');
  assert.equal(isSetupDone(jess), false);
  const gio = { signName: 'Gio', mailApp: 'outlook', setup: { step: 'ready', done: true, doneAt: '2026-10-18T10:00:41.000Z', found: 'done' } };
  assert.equal(isSetupDone(gio, { existing: true }), true);
  assert.equal(isSetupDone({ setup: { done: true } }), true);
});

test('a setup left halfway is not done, even on a Mac with a yes', () => {
  assert.equal(isSetupDone({ setup: { step: 'keys' }, cloudYes: { discover: true } }, { existing: true }), false);
});

// The background keeps running on such an install while it walks setup: it already has workspaces. A fresh Mac's
// background still waits for Done (spec C3), even after its first step saved a name.
test('the background runs when setup is done, and on an install from before setup, with or without its record', () => {
  assert.equal(backgroundRuns({ setup: { done: true } }), true, 'Gio');
  assert.equal(backgroundRuns({ signName: 'Jess', mailApp: 'outlook' }, { existing: true }), true, 'Jess, setup not opened yet');
  assert.equal(backgroundRuns({ signName: 'Jess', setup: { step: 'keys', existing: true } }, { existing: true }), true, 'Jess, halfway');
  assert.equal(backgroundRuns({}), false, 'a fresh Mac');
  assert.equal(backgroundRuns({ signName: 'Alex', setup: { step: 'email' } }, { existing: true }), false, 'a fresh Mac past Welcome');
  assert.equal(backgroundRuns(null), false);
});

// --- the rest of the rules (spec B5.3), tests 4 to 21
import { accountsLine, appsAsks, backStep, firstStep, LABELS, nextMeeting, nextMeetingLine, nextStep, pills, pillsDetour, readyHeading, readyRows, skipped, speechSwitchOn } from '../desktop/renderer/setup-model.js';

const fresh = (extra = {}) => ({ done: false, step: null, signName: 'Alex', mailApp: 'outlook', chats: false, permissions: {}, mail: { accounts: 0 }, keys: {}, yes: {}, voice: { answer: null, helper: 'built' }, gmail: { configured: false, connected: false }, speech: { wanted: false }, fileVault: 'on', ...extra });
const on = (...names) => Object.fromEntries(names.map((name) => [name, 'granted']));
const walk = (status) => { const seen = ['welcome']; while (seen.at(-1) !== 'ready') seen.push(nextStep(seen.at(-1), status)); return seen; };

test('labels follow the steps', () => assert.deepEqual(STEPS.map((step) => LABELS[step]), ['Welcome', 'Email', 'Calendar', 'Disk', 'Apps', 'Voice', 'Keys', 'Calls', 'Ready']));

test('the Apps step asks per mail app, and chats add Accessibility once', () => {
  assert.deepEqual(appsAsks({ mailApp: 'outlook' }), ['accessibility']);
  assert.deepEqual(appsAsks({ mailApp: 'apple-mail' }), ['automation', 'accessibility']);
  assert.deepEqual(appsAsks({ mailApp: 'gmail' }), []);
  assert.deepEqual(appsAsks({ mailApp: 'gmail', chats: true }), ['accessibility']);
  assert.deepEqual(appsAsks({ mailApp: 'outlook', chats: true }), ['accessibility']);
});

test('a fresh Mac visits all nine steps', () => assert.deepEqual(walk(fresh()), STEPS));

test('an Outlook Mac with its switches on and no keys sees Welcome, Email, Voice, Keys, Ready', () => {
  assert.deepEqual(walk(fresh({ permissions: on('calendar', 'fullDisk', 'accessibility', 'microphone', 'screen'), mail: { accounts: 2 } })), ['welcome', 'email', 'voice', 'keys', 'ready']);
});

test('Apple Mail keeps Apps while Mail control is unknown; Outlook with Accessibility on skips it', () => {
  assert.ok(!skipped(fresh({ mailApp: 'apple-mail', permissions: on('accessibility') })).has('apps'));
  assert.ok(skipped(fresh({ mailApp: 'outlook', permissions: on('accessibility') })).has('apps'));
});

test('Full Disk on with no mail account keeps the Disk step', () => {
  assert.ok(!skipped(fresh({ permissions: on('fullDisk'), mail: { accounts: 0 } })).has('disk'));
  assert.ok(skipped(fresh({ permissions: on('fullDisk'), mail: { accounts: 1 } })).has('disk'));
});

test('Keys is skipped only with both keys and the yes, and the chats yes when texts are on', () => {
  assert.ok(!skipped(fresh({ keys: { nebius: true, tavily: true } })).has('keys'));
  assert.ok(skipped(fresh({ keys: { nebius: true, tavily: true }, yes: { ai: true } })).has('keys'));
  assert.ok(!skipped(fresh({ chats: true, keys: { nebius: true, tavily: true }, yes: { ai: true } })).has('keys'));
});

test('setup opens where it was left, past anything turned on since; done opens nothing', () => {
  assert.equal(firstStep(fresh({ step: 'ready' })), 'ready');
  assert.equal(firstStep(fresh({ step: 'calls', permissions: on('microphone', 'screen') })), 'ready');
  assert.equal(firstStep(fresh({ step: 'moon' })), 'welcome');
  assert.equal(firstStep(fresh({ done: true, step: 'keys' })), null);
});

// Back (2026-10-28): the step shown before, so nothing is stuck. A step shown this run comes back even when what it
// asks for is on by now (it shows as granted); one never shown and not needed is passed over; Welcome is always there.
test('Back goes to the step before that was shown or is needed, down to Welcome, which has none', () => {
  const all = fresh({ permissions: on('calendar', 'fullDisk', 'accessibility', 'microphone', 'screen'), mail: { accounts: 2 } });
  assert.equal(backStep('welcome', all), null);
  assert.equal(backStep('email', all), 'welcome');
  assert.equal(backStep('voice', all), 'email', 'calendar, disk and apps were never shown and are on');
  assert.equal(backStep('voice', all, ['welcome', 'email', 'calendar', 'disk', 'apps']), 'apps', 'shown this run, so it comes back');
  assert.equal(backStep('ready', fresh()), 'calls');
  assert.throws(() => backStep('moon', fresh()), /Unknown setup step "moon"/);
  const seen = ['ready'];
  while (backStep(seen.at(-1), all)) seen.push(backStep(seen.at(-1), all));
  assert.deepEqual(seen, ['ready', 'keys', 'voice', 'email', 'welcome'], 'from the last step back to the first');
});

test('Ready stays Ready and an unknown step throws', () => {
  assert.equal(nextStep('ready', fresh()), 'ready');
  assert.throws(() => nextStep('moon', fresh()), /Unknown setup step "moon"/);
});

test('the pills say what is done, now and still to do', () => {
  const states = pills('keys').map((pill) => pill.state);
  assert.deepEqual([states.filter((s) => s === 'done').length, states.filter((s) => s === 'now').length, states.filter((s) => s === 'todo').length], [6, 1, 2]);
  assert.ok(pills('ready').every((pill) => pill.state === 'done'));
});

const allOn = (extra = {}) => fresh({ permissions: on('calendar', 'fullDisk', 'accessibility', 'microphone', 'screen'), mail: { accounts: 2 }, keys: { nebius: true, tavily: true }, yes: { ai: true }, voice: { answer: 'granted', helper: 'built' }, startedAt: '2026-10-18T10:00:00.000Z', readyAt: '2026-10-18T10:00:41.000Z', ...extra });

test('everything on: All set, with the time it took and the name', () => {
  const rows = readyRows(allOn());
  assert.ok(rows.every((row) => row.state === 'on' || row.state === 'note'), JSON.stringify(rows.filter((row) => row.state !== 'on')));
  assert.equal(readyHeading(allOn(), rows), 'All set in 0:41, Alex');
});

test('Calendar off and no Tavily key: two rows off with their buttons, and Nearly set', () => {
  const status = allOn({ permissions: on('fullDisk', 'accessibility', 'microphone', 'screen'), keys: { nebius: true, tavily: false } });
  const rows = readyRows(status);
  const off = rows.filter((row) => row.state === 'off');
  assert.deepEqual(off.map((row) => [row.key, row.button]), [['calendar', { label: 'Turn on', ask: 'calendar' }], ['tavily', { label: 'Add key', go: 'keys' }]]);
  assert.match(readyHeading(status, rows), /^Nearly set in 0:41, Alex$/);
});

test('the screen opened in Settings waits for the reopen', () => {
  const row = readyRows(allOn({ permissions: on('calendar', 'fullDisk', 'accessibility', 'microphone') }), { screenOpened: true }).find((item) => item.key === 'screen');
  assert.deepEqual([row.state, row.button], ['after-reopen', { label: 'Reopen now', relaunch: true }]);
});

test('voice typing with no helper says how to build it', () => {
  const row = readyRows(allOn({ voice: { answer: null, helper: 'missing' } })).find((item) => item.key === 'voice');
  assert.equal(row.note, 'Run npm run build:voice once, then press Turn on.');
});

// first-run-polish B5.2 (S2, S3, S3b): the speech switch, the speech row from the download events, the python row.
const SPEECH = { wanted: true, ready: false, always: false, chosen: true, bytes: 1460555318 };
const NUMPY = { ok: true, numpy: true, packaged: false };
const rowOf = (status, key, options) => readyRows(status, options).find((row) => row.key === key);

test('the speech switch starts on and keeps a saved answer; Calls waits for it on a Mac with both call grants', () => {
  assert.equal(speechSwitchOn({ speech: { chosen: null } }), true);
  assert.equal(speechSwitchOn({ speech: { chosen: true } }), true);
  assert.equal(speechSwitchOn({ speech: { chosen: false } }), false);
  assert.equal(speechSwitchOn({}), true);
  const both = (speech) => fresh({ permissions: on('microphone', 'screen'), speech });
  assert.equal(skipped(both({ wanted: false, always: false, chosen: null })).has('calls'), false, 'unanswered: Calls shows');
  for (const speech of [{ chosen: true, always: false }, { chosen: false, always: false }, { chosen: null, always: true }]) {
    assert.equal(skipped(both(speech)).has('calls'), true, JSON.stringify(speech));
  }
  assert.equal(skipped(fresh({ permissions: on('microphone'), speech: { chosen: true, always: false } })).has('calls'), false, 'a missing grant still shows Calls');
  assert.equal(firstStep({ ...both({ wanted: false, always: false, chosen: null }), step: 'calls' }), 'calls', 'a relaunch on Calls before the switch is answered stays on Calls');
});

test('the speech and python rows show only when the models are wanted, after screen and before FileVault', () => {
  const plain = readyRows(allOn());
  assert.ok(!plain.some((row) => row.key === 'speech' || row.key === 'python'));
  assert.ok(plain.every((row) => row.fill === null), 'every row carries fill, null outside the speech row');
  const keys = readyRows(allOn({ speech: SPEECH, python: NUMPY })).map((row) => row.key);
  assert.deepEqual(keys.slice(-6), ['yes', 'mic', 'screen', 'speech', 'python', 'fileVault']);
});

test('the speech row: starting, downloading with its bar, paused keeps the bar, ready is On', () => {
  const status = allOn({ speech: SPEECH, python: NUMPY });
  const pick = (row) => [row.state, row.label, row.fill];
  assert.deepEqual(pick(rowOf(status, 'speech')), ['note', 'NVIDIA speech on this Mac · starting', 0]);
  const going = { done_bytes: 412e6, total_bytes: 1460555318, state: 'downloading' };
  assert.deepEqual(pick(rowOf(status, 'speech', { download: going })), ['note', 'NVIDIA speech on this Mac · 412 of 1,461 MB', 412e6 / 1460555318]);
  assert.deepEqual(pick(rowOf(status, 'speech', { download: { ...going, total_bytes: 0 } })), ['note', 'NVIDIA speech on this Mac · 412 of 0 MB', 0]);
  assert.deepEqual(pick(rowOf(status, 'speech', { download: { ...going, state: 'paused' } })), ['note', 'NVIDIA speech on this Mac · Paused, trying again in a minute', 412e6 / 1460555318]);
  assert.deepEqual(pick(rowOf(status, 'speech', { download: { ...going, done_bytes: 1460555318, state: 'ready' } })), ['on', 'NVIDIA speech on this Mac', null]);
  assert.deepEqual(pick(rowOf(allOn({ speech: { ...SPEECH, ready: true }, python: NUMPY }), 'speech')), ['on', 'NVIDIA speech on this Mac', null]);
  assert.equal(rowOf(status, 'speech').button, null);
});

test('the python row: on with numpy, else the one fix that fits, packaged first', () => {
  const python = (value) => rowOf(allOn({ speech: SPEECH, python: value }), 'python');
  assert.deepEqual([python(NUMPY).state, python(NUMPY).label, python(NUMPY).note, python(NUMPY).button], ['on', 'Python with numpy: call notes', null, null]);
  assert.deepEqual([python({ ok: true, numpy: false, packaged: true }).state, python({ ok: true, numpy: false, packaged: true }).note], ['off', 'Reinstall Loggie: its own Python is missing numpy.']);
  assert.equal(python({ ok: false, numpy: false, packaged: true }).note, 'Reinstall Loggie: its own Python is missing numpy.', 'packaged wins');
  assert.equal(python({ ok: false, numpy: false, packaged: false }).note, 'Run in Terminal: xcode-select --install');
  assert.equal(python({ ok: true, numpy: false, packaged: false }).note, 'Run in Terminal: python3 -m pip install numpy');
  const off = allOn({ speech: { ...SPEECH, ready: true }, python: { ok: true, numpy: false, packaged: false } });
  assert.match(readyHeading(off, readyRows(off)), /^Nearly set/, 'python off counts as off');
});

test('Ready labels: an all-on Outlook Mac with texts on and WhatsApp says each row in a few words, in order', () => {
  const rows = readyRows(allOn({ chats: true, yes: { ai: true, chats: true }, installed: { outlook: true, whatsapp: true } }));
  assert.deepEqual(rows.map((row) => [row.key, row.label]), [
    ['calendar', 'Calendar: meetings and record offers'],
    ['fullDisk', 'Full Disk Access: mail, texts, contacts, files'],
    ['mail', '2 accounts in Apple Mail'],
    ['mailApp', 'Outlook: drafts in their thread'],
    ['chats', 'Messages and WhatsApp: chat drafts'],
    ['voice', 'Voice typing: the ask bar’s mic'],
    ['nebius', 'Nebius key: notes and replies'],
    ['tavily', 'Tavily key: facts and names'],
    ['yes', 'Cloud AI: finds workspaces, sorts mail, writes call notes'],
    ['mic', 'Microphone: your side of calls'],
    ['screen', 'Screen audio: their side'],
    ['fileVault', 'FileVault: stored mail encrypted'],
  ]);
  assert.equal(readyRows(allOn({ chats: true, installed: { whatsapp: false } })).find((row) => row.key === 'chats').label, 'Messages: chat drafts');
  assert.deepEqual(['apple-mail', 'outlook'].map((mailApp) => readyRows(allOn({ mailApp })).find((row) => row.key === 'mailApp').label),
    ['Apple Mail: drafts in their thread', 'Outlook: drafts in their thread']);
});

test('the next meeting skips all-day, past and empty read-only feeds, and reads as a line', () => {
  const now = Date.parse('2026-10-18T09:00:00');
  const events = [
    { title: 'Holiday', start: '2026-10-18T00:00:00', allDay: true },
    { title: 'Earlier', start: '2026-10-18T08:00:00' },
    { title: 'Class feed', start: '2026-10-18T09:30:00', writable: false, attendees: [] },
    { title: 'Sync', start: '2026-10-18T14:00:00', attendees: ['a@x.example'] },
  ];
  const next = nextMeeting(events, now);
  assert.deepEqual(next, { title: 'Sync', start: '2026-10-18T14:00:00' });
  assert.equal(nextMeetingLine(next, new Date(now)), 'Next: 2:00 PM, Sync');
  assert.equal(nextMeetingLine({ title: 'Sync', start: '2026-10-20T14:00:00' }, new Date(now)), 'Next: Tue 2:00 PM, Sync');
  assert.equal(nextMeetingLine(null), 'No meetings in the next 7 days.');
});

test('the accounts line counts Apple Mail accounts', () => {
  assert.deepEqual([0, 1, 2].map((accounts) => accountsLine({ accounts })), ['No mail account in Apple Mail yet', '1 account in Apple Mail', '2 accounts in Apple Mail']);
});

// A key added from Ready or the Found step (first-run-polish B4.7): that step is now, every other pill done.
test('a detour step is the one now pill among done pills', () => {
  const states = pillsDetour('keys').map((pill) => [pill.id, pill.state]);
  assert.equal(states.length, 9);
  assert.deepEqual(states.filter(([, state]) => state !== 'done'), [['keys', 'now']]);
});

// loggie-diagnostics: Settings' Your Mac rows, the same checks as Ready on any install.
test('macRows: the mail app row offers Change with the two apps, the current one marked, a missing Outlook greyed', async () => {
  const { macRows } = await import('../desktop/renderer/setup-model.js');
  const mail = (status) => macRows({ mail: { accounts: 1 }, permissions: {}, keys: {}, yes: {}, voice: {}, ...status }).find((row) => row.key === 'mailApp');
  assert.deepEqual(mail({ mailApp: 'apple-mail', installed: { outlook: true } }).change, { current: 'apple-mail', choices: [
    { id: 'outlook', label: 'Outlook', installed: true }, { id: 'apple-mail', label: 'Apple Mail', installed: true }] });
  assert.equal(mail({ mailApp: 'apple-mail', installed: { outlook: false } }).change.choices[0].installed, false);
  assert.equal(mail({ mailApp: null, installed: { outlook: false } }).change.current, 'apple-mail', 'no Outlook: Apple Mail, as draft.js reads it');
  assert.equal(mail({ mailApp: null, installed: { outlook: true } }).change.current, 'outlook', 'no saved app: the one Loggie uses');
  const { readyRows } = await import('../desktop/renderer/setup-model.js');
  assert.equal('change' in readyRows({ mailApp: 'outlook', permissions: {} }).find((row) => row.key === 'mailApp'), false, 'setup keeps its own chooser');
});

test('macRows: chats get a switch row on an install that skipped setup, and the texts\' cloud yes is optional', async () => {
  const { macRows, macSummary } = await import('../desktop/renderer/setup-model.js');
  const base = { mailApp: 'outlook', mail: { accounts: 4 }, permissions: { calendar: 'granted', fullDisk: 'granted', accessibility: 'granted', microphone: 'granted', screen: 'granted' },
    keys: { nebius: true, tavily: true }, yes: { ai: true, chats: false }, voice: { answer: 'granted' }, fileVault: 'on', installed: { whatsapp: true }, helpers: { native: 7, of: 7 } };
  const off = macRows({ ...base, chats: false });
  const chats = off.find((row) => row.key === 'chats');
  assert.deepEqual([chats.state, chats.toggle, chats.label], ['off', false, 'Messages and WhatsApp: read and draft texts on this Mac']);
  assert.equal(off.find((row) => row.key === 'yes').state, 'on', 'the cloud yes covers the AI only');
  assert.equal(off.some((row) => row.key === 'textsCloud'), false);
  assert.equal(off.findIndex((row) => row.key === 'chats'), off.findIndex((row) => row.key === 'mailApp') + 1, 'chats sit under the mail app');
  assert.equal(macSummary(off), '1 thing is off: Messages and WhatsApp. Loggie cannot find anyone to text.');
  const on = macRows({ ...base, chats: true });
  assert.deepEqual([on.find((row) => row.key === 'chats').state, on.find((row) => row.key === 'chats').toggle], ['on', true]);
  assert.deepEqual([on.find((row) => row.key === 'textsCloud').state, on.find((row) => row.key === 'textsCloud').button], ['optional', { label: 'Yes', yes: 'chats' }]);
  assert.equal(macSummary(on), 'Everything Loggie uses is on.', 'an optional row never makes it say something is off');
  const noTyping = macRows({ ...base, chats: true, permissions: { ...base.permissions, accessibility: 'denied' } }).find((row) => row.key === 'chats');
  assert.deepEqual([noTyping.state, noTyping.button], ['off', { label: 'Turn on', ask: 'accessibility' }]);
  // The real Settings, 2026-10-22: no mail app saved, no voice answer recorded.
  const skipped = macRows({ ...base, mailApp: null, installed: { outlook: true, whatsapp: true }, voice: { answer: null, helper: 'built' }, chats: false });
  const keys = skipped.map((row) => row.key);
  assert.equal(skipped.find((row) => row.key === 'mailApp').label, 'Outlook: drafts in their thread', 'the mail app Loggie uses has a row');
  assert.equal(keys.indexOf('chats'), keys.indexOf('mailApp') + 1, 'chats right under mail');
  assert.deepEqual([skipped.find((row) => row.key === 'voice').state, skipped.find((row) => row.key === 'voice').button], ['note', { label: 'Turn on', ask: 'speech' }], 'no answer recorded: not checked, never Off');
  assert.equal(macSummary(skipped), '1 thing is off: Messages and WhatsApp. Loggie cannot find anyone to text.');
  const someHelpers = macRows({ ...base, chats: true, helpers: { native: 5, of: 7 } }).find((row) => row.key === 'helpers');
  assert.equal(someHelpers.state, 'note', 'a helper builds on first use: a note, not off');
});
