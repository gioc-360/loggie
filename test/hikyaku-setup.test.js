// Setup a normie can get through (cloud-first C6, plan sections 4.2, 4.4 and 7): each permission is asked when the
// action that needs it first runs, the cloud yes comes as a card with the health sentence, and the cloud key has an
// in-app place. Everything is faked: no macOS permission, no keychain, no network, temp homes only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { readEvents, TYPES } from '../src/hikyaku/events.js';
import { draftActionFor, launchNeeds, needFor, paneUrl, permissionStatus, createSetupGuard } from '../src/hikyaku/permissions.js';
import { grantCloudYes } from '../src/hikyaku/cloud-screen.js';
import { keyStatus, saveCloudKey } from '../src/hikyaku/cloud-key.js';
import { KEYCHAIN, testCloudKey } from '../src/hikyaku/nebius.js';
import { cloudYesCard, HEALTH_LINE, setupCard } from '../desktop/renderer/setup-cards.js';
import { applyEvent, decisionCards } from '../desktop/renderer/meeting-cards.js';
import { validateCloudKey, validateCloudYesAnswer, validateSetupAnswer } from '../desktop/ipc-validation.js';
import { mainText } from './helpers/main-files.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = () => mkdtemp(join(tmpdir(), 'hikyaku-setup-'));
const GRANTED = { calendar: 'granted', fullDisk: 'granted', microphone: 'granted', screen: 'granted', accessibility: 'granted' };

// --- permissionStatus
const prefs = ({ microphone = 'granted', screen = 'granted', trusted = true } = {}) => ({
  getMediaAccessStatus: (kind) => ({ microphone, screen })[kind],
  isTrustedAccessibilityClient: (prompt) => { assert.equal(prompt, false, 'the status check never prompts'); return trusted; },
});
const mailFs = ({ listError = null, openError = null } = {}) => ({
  readdir: async () => { if (listError) throw Object.assign(new Error('x'), { code: listError }); return ['V10', 'V9', 'Other']; },
  open: async (path) => { if (openError) throw Object.assign(new Error('x'), { code: openError }); return { path, close: async () => {} }; },
});

test('permissionStatus reads each permission and maps it to granted, denied or unknown', async () => {
  const all = await permissionStatus({ systemPreferences: prefs(), fsImpl: mailFs(), calendarStatusImpl: async () => 'granted', home: '/h' });
  assert.deepEqual(all, GRANTED);
  const denied = await permissionStatus({ systemPreferences: prefs({ microphone: 'denied', screen: 'restricted', trusted: false }), fsImpl: mailFs({ openError: 'EPERM' }), calendarStatusImpl: async () => 'denied', home: '/h' });
  assert.deepEqual(denied, { calendar: 'denied', fullDisk: 'denied', microphone: 'denied', screen: 'denied', accessibility: 'denied' });
  const unknown = await permissionStatus({ systemPreferences: prefs({ microphone: 'not-determined', screen: 'unknown' }), fsImpl: mailFs({ listError: 'ENOENT', openError: 'ENOENT' }), home: '/h' });
  assert.deepEqual([unknown.microphone, unknown.screen, unknown.fullDisk, unknown.calendar], ['unknown', 'unknown', 'unknown', 'unknown']);
});

test('Full Disk is tried on the newest Envelope Index, read-only, and a folder macOS will not list is denied', async () => {
  const opened = [];
  const fsImpl = { readdir: async () => ['V9', 'V10'], open: async (path, flags) => { opened.push([path, flags]); return { close: async () => {} }; } };
  assert.equal((await permissionStatus({ systemPreferences: prefs(), fsImpl, home: '/h' })).fullDisk, 'granted');
  assert.deepEqual(opened, [['/h/Library/Mail/V10/MailData/Envelope Index', 'r']]);
  assert.equal((await permissionStatus({ systemPreferences: prefs(), fsImpl: mailFs({ listError: 'EACCES' }), home: '/h' })).fullDisk, 'denied');
});

// A Mac with no Apple Mail store yet: Messages' chat.db answers whether Full Disk Access is on (spec C11).
test('with no Mail store, Full Disk is read from chat.db: opens is granted, refused is denied, missing is unknown', async () => {
  const noMail = (chat) => ({
    readdir: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    open: async (path, flags) => { assert.equal(path, '/h/Library/Messages/chat.db'); assert.equal(flags, 'r'); if (chat) throw Object.assign(new Error('x'), { code: chat }); return { close: async () => {} }; },
  });
  assert.equal((await permissionStatus({ systemPreferences: prefs(), fsImpl: noMail(null), home: '/h' })).fullDisk, 'granted');
  assert.equal((await permissionStatus({ systemPreferences: prefs(), fsImpl: noMail('EPERM'), home: '/h' })).fullDisk, 'denied');
  assert.equal((await permissionStatus({ systemPreferences: prefs(), fsImpl: noMail('ENOENT'), home: '/h' })).fullDisk, 'unknown');
});

test('a status that throws is unknown, never a crash', async () => {
  const broken = { getMediaAccessStatus: () => { throw new Error('no'); }, isTrustedAccessibilityClient: () => { throw new Error('no'); } };
  const status = await permissionStatus({ systemPreferences: broken, fsImpl: mailFs(), calendarStatusImpl: async () => { throw new Error('no'); }, home: '/h' });
  assert.deepEqual([status.microphone, status.screen, status.accessibility, status.calendar], ['unknown', 'unknown', 'unknown', 'unknown']);
});

// --- needFor and paneUrl
test('needFor maps every action to its permissions and a one-sentence plain why', () => {
  assert.deepEqual(needFor('calendar-offer').permissions, ['calendar']);
  assert.deepEqual(needFor('apple-mail-read').permissions, ['fullDisk']);
  assert.deepEqual(needFor('record').permissions, ['microphone', 'screen']);
  assert.equal(needFor('record').why, 'Loggie needs the microphone and screen audio to record both sides of this meeting.');
  assert.deepEqual(needFor('outlook-draft').permissions, ['accessibility']);
  assert.deepEqual(needFor('apple-mail-draft').permissions, ['automation']);
  assert.match(needFor('apple-mail-draft').why, /macOS will ask the first time/);
  for (const action of ['calendar-offer', 'apple-mail-read', 'record', 'outlook-draft', 'apple-mail-draft']) {
    const { why } = needFor(action);
    assert.ok(!/[—–]/.test(why) && !/nemotron|nebius|claude|model/i.test(why), `${action}: plain words`);
    assert.equal(why.split(/(?<=[.!?])\s+/).length, action === 'apple-mail-draft' ? 2 : 1, `${action}: one sentence (the Mail line adds the macOS note)`);
  }
  assert.throws(() => needFor('fly'), /no action named/);
});

test('paneUrl gives the exact System Settings pane for every permission', () => {
  const base = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_';
  assert.equal(paneUrl('calendar'), `${base}Calendars`);
  assert.equal(paneUrl('fullDisk'), `${base}AllFiles`);
  assert.equal(paneUrl('microphone'), `${base}Microphone`);
  assert.equal(paneUrl('screen'), `${base}ScreenCapture`);
  assert.equal(paneUrl('accessibility'), `${base}Accessibility`);
  assert.equal(paneUrl('automation'), `${base}Automation`);
  assert.throws(() => paneUrl('camera'), /no permission named/);
});

test('draftActionFor names the permission action of the mail app a draft opens in', () => {
  assert.equal(draftActionFor('outlook'), 'outlook-draft');
  assert.equal(draftActionFor('apple-mail'), 'apple-mail-draft');
  assert.equal(draftActionFor('gmail'), null);
});

// --- launch asks for Calendar and Full Disk, whatever the mail app: every mail read goes through Apple Mail's store
test('launch asks for Calendar and Full Disk for every mail app, and nothing else', () => {
  assert.deepEqual(launchNeeds(), ['calendar-offer', 'apple-mail-read']);
  const all = launchNeeds().flatMap((action) => needFor(action).permissions);
  assert.deepEqual(all, ['calendar', 'fullDisk']);
  for (const never of ['microphone', 'screen', 'accessibility', 'automation']) assert.ok(!all.includes(never), `${never} is never asked at launch`);
});

// --- the guard: a missing permission emits setup.need and the action does not run
function guardWith(status) {
  const events = [];
  const guard = createSetupGuard({ status: async () => ({ ...GRANTED, ...status }), emit: async (event) => { events.push(event); } });
  return { guard, events };
}

test('a denied permission emits one setup.need with the permission, the why and the pane, and blocks', async () => {
  const { guard, events } = guardWith({ accessibility: 'denied' });
  const need = await guard.check('outlook-draft');
  assert.deepEqual(need, { permission: 'accessibility', why: needFor('outlook-draft').why, pane: paneUrl('accessibility') });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'setup.need');
  assert.deepEqual(events[0].data, need);
});

test('granted and unknown do not block; an action with no API check (Apple Mail draft) never blocks', async () => {
  assert.equal(await guardWith({}).guard.check('record'), null);
  assert.equal(await guardWith({ microphone: 'unknown', screen: 'unknown' }).guard.check('record'), null);
  assert.equal(await guardWith({}).guard.check('apple-mail-draft'), null);
});

test('a polled check says it once; a user action says it every time', async () => {
  const { guard, events } = guardWith({ calendar: 'denied' });
  assert.ok(await guard.check('calendar-offer', { once: true }));
  assert.ok(await guard.check('calendar-offer', { once: true }), 'still blocked');
  assert.equal(events.length, 1, 'but not announced again');
  await guard.check('calendar-offer');
  assert.equal(events.length, 2);
});

async function watchWith(status) {
  const home = await tempHome();
  const runs = [];
  const guard = createSetupGuard({ status: async () => ({ ...GRANTED, ...status }), emit: async (event) => { const { emitEvent } = await import('../src/hikyaku/events.js'); await emitEvent(join(home, 'runs', '20261008-090000-0001'), event); } });
  const start = new Date('2026-10-08T14:00:00Z');
  const event = { id: 'e1', title: 'Weekly sync', start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), allDay: false, calendar: 'Calendar',
    account: 'me@example.org', writable: true, attendees: ['a@example.org', 'b@example.org', 'c@example.org'], attendeeNames: ['A', 'B', 'C'], recurring: false, location: 'https://example.zoom.us/j/123456', myStatus: 'accepted' };   // his invite (meeting.js isMine)
  const offers = [];
  const watch = createMeetingWatch({ home, listEvents: async () => [event], now: () => new Date(start.getTime() + 60000), onOffer: (offer) => offers.push(offer), log: () => {},
    runner: async (command, args) => { runs.push([command, args]); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', '2026-10-08-1000-weekly-sync')}\n`, stderr: '' }; },
    transcriber: () => '/fake/transcriber/spike', loggieDirectory: '/fake/loggie', permissions: guard });
  await watch.poll();
  return { home, runs, watch, offers };
}

test('record with the microphone denied: setup.need is emitted and call.py never starts; the offer stays for a second try', async () => {
  const { home, runs, watch, offers } = await watchWith({ microphone: 'denied' });
  assert.equal(offers.length, 1);
  const answered = await watch.answer(offers[0].offer_id, 'record');
  assert.equal(answered.call, null);
  assert.equal(answered.blocked, 'microphone');
  assert.deepEqual(runs, [], 'the fake runner never saw call.py start');
  const written = (await Promise.all((await readdir(join(home, 'runs'))).map((run) => readEvents(join(home, 'runs', run))))).flat();
  const need = written.find((event) => event.type === 'setup.need');
  assert.equal(need.data.permission, 'microphone');
  assert.equal(need.data.why, 'Loggie needs the microphone and screen audio to record both sides of this meeting.');
  assert.ok(!written.some((event) => event.type === 'meeting.answered'), 'the offer was not answered, so it can be tried again');
});

test('record with the screen denied is blocked on the screen, and with everything granted it starts the recording', async () => {
  const blocked = await watchWith({ screen: 'denied' });
  assert.equal((await blocked.watch.answer(blocked.offers[0].offer_id, 'record')).blocked, 'screen');
  assert.deepEqual(blocked.runs, []);
  const open = await watchWith({});
  const result = await open.watch.answer(open.offers[0].offer_id, 'record');
  assert.equal(result.call, '2026-10-08-1000-weekly-sync');
  assert.equal(open.runs.length, 1);
  assert.equal(open.runs[0][1][0], 'call.py');
});

test('a calendar that macOS refused gives no offer and one setup.need', async () => {
  const home = await tempHome();
  const events = [];
  const guard = createSetupGuard({ status: async () => ({ ...GRANTED, calendar: 'denied' }), emit: async (event) => { events.push(event); } });
  let read = 0;
  const watch = createMeetingWatch({ home, listEvents: async () => { read += 1; return []; }, now: () => new Date('2026-10-08T14:00:00Z'), log: () => {}, permissions: guard });
  await watch.poll(); await watch.poll();
  assert.equal(read, 0, 'the calendar is not read while it is denied');
  assert.equal(events.filter((event) => event.type === 'setup.need').length, 1);
});

// --- the cards
test('a setup.need event becomes a card with Open Settings and Not now, and its answer takes it away', () => {
  const need = { type: 'setup.need', text: needFor('record').why, data: { permission: 'microphone', why: needFor('record').why, pane: paneUrl('microphone') } };
  const card = setupCard(need);
  assert.equal(card.kind, 'setup');
  assert.equal(card.why, needFor('record').why);
  assert.deepEqual(card.buttons.map((button) => button.label), ['Open Settings', 'Not now']);
  assert.deepEqual(card.buttons.map((button) => button.action), [{ method: 'setupAnswer', args: ['microphone', 'open'] }, { method: 'setupAnswer', args: ['microphone', 'later'] }]);
  const shown = applyEvent([], need);
  assert.equal(shown.length, 1);
  assert.deepEqual(applyEvent(shown, { type: 'setup.need', text: need.text, data: need.data }).length, 1, 'the same need twice is one card');
  assert.deepEqual(applyEvent(shown, { type: 'setup.answered', data: { permission: 'microphone', answer: 'later' } }), []);
});

test('the cloud yes card carries the health sentence exactly, and Yes and Not now', () => {
  assert.equal(HEALTH_LINE, 'Health lines are not checked on this Mac.');
  const card = cloudYesCard('ai');
  const text = [card.heading, card.body, card.note].join(' ');
  assert.equal(text, 'Let Loggie send screened mail and call transcripts to Nemotron, to find your workspaces, sort new mail, write your call notes and learn how you write? Only text screened on this Mac leaves it. Health lines are not checked on this Mac.');
  assert.deepEqual(card.buttons.map((button) => button.label), ['Yes', 'Not now']);
  assert.deepEqual(card.buttons[0].action, { method: 'cloudYesAnswer', args: ['ai', 'yes'] });
  const chats = cloudYesCard('chats');
  assert.ok([chats.heading, chats.body, chats.note].join(' ').includes(HEALTH_LINE));
  assert.match(chats.heading, /chats/);
  // first-run-polish B5.4 (S13): the call notes card, once, for an install whose yes came before them.
  const calls = cloudYesCard('calls');
  assert.equal(calls.heading, 'Write call notes on their own after each call?');
  assert.deepEqual([calls.body, calls.note], ['Only text screened on this Mac leaves it.', HEALTH_LINE]);
  assert.deepEqual(calls.buttons.map((button) => [button.label, button.action]), [['Yes', { method: 'cloudYesAnswer', args: ['calls', 'yes'] }], ['Not now', { method: 'cloudYesAnswer', args: ['calls', 'later'] }]]);
  assert.deepEqual(validateCloudYesAnswer('calls', 'yes'), { group: 'calls', answer: 'yes' });
  assert.deepEqual(validateCloudYesAnswer('calls', 'later'), { group: 'calls', answer: 'later' });
  assert.throws(() => validateCloudYesAnswer('names', 'yes'), /not a cloud yes/);
  const shown = applyEvent([], { type: 'setup.cloud_yes', data: { group: 'ai' } });
  assert.equal(shown[0].kind, 'cloud-yes');
  assert.deepEqual(applyEvent(shown, { type: 'setup.cloud_answered', data: { group: 'ai', answer: 'yes' } }), []);
});

test('the one-decision card carries the health sentence as a small line', () => {
  const [card] = decisionCards([{ run: '20261008-101500-cd34', what: 'call-notes', status: 'pending', title: 'Weekly sync' }]);
  assert.equal(card.heading, 'Summarize with cloud AI?');
  assert.equal(card.note, HEALTH_LINE);
});

test('Yes writes cloudYes for discover, triage, style and rank and changes nothing else in settings', async () => {
  const home = await tempHome();
  const before = { mailApp: 'apple-mail', signName: 'Sam', chats: ['messages'], thinker: 'cloud', cloudYes: { other: true } };
  await writeFile(join(home, 'settings.json'), JSON.stringify(before));
  const now = new Date('2026-10-18T09:00:00.000Z');
  await grantCloudYes(home, { now });
  const after = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  // first-run-polish B5.4: the same Yes covers call notes, from now on.
  const calls = { calls: true, callsAt: '2026-10-18T09:00:00.000Z' };
  assert.deepEqual(after, { ...before, cloudYes: { other: true, discover: true, triage: true, style: true, rank: true, found: true, ...calls } });
  const fresh = await tempHome();
  await grantCloudYes(fresh, { now });
  assert.deepEqual(JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8')), { cloudYes: { discover: true, triage: true, style: true, rank: true, found: true, ...calls } });
});

// --- the key
const KEY = 'sk-test-0123456789abcdef-NOT-A-REAL-KEY';

test('Save stores the key in the keychain with security -U -s -a -w, under the service and account nebius.js reads', async () => {
  const calls = [];
  const logs = [];
  const execFileImpl = (command, args, options, done) => { calls.push([command, args]); done(null, '', ''); };
  const result = await saveCloudKey(KEY, { execFileImpl, log: (line) => logs.push(line) });
  assert.deepEqual(result, { saved: true });
  assert.deepEqual(calls, [['security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w', KEY]]]);
  assert.ok(!JSON.stringify(result).includes(KEY), 'the key is not echoed back');
  assert.ok(!logs.join('\n').includes(KEY), 'the key is in no log line');
});

test('a failed Save says a plain error without the key, even when security echoes the command', async () => {
  const logs = [];
  const execFileImpl = (command, args, options, done) => done(Object.assign(new Error(`failed: ${args.join(' ')}`), { stderr: `bad ${KEY}` }), '', `bad ${KEY}`);
  await assert.rejects(saveCloudKey(KEY, { execFileImpl, log: (line) => logs.push(line) }), (error) => {
    assert.ok(!error.message.includes(KEY));
    assert.match(error.message, /keychain/);
    return true;
  });
  assert.ok(!logs.join('\n').includes(KEY));
  await assert.rejects(saveCloudKey('   ', { execFileImpl }), /Paste the key/);
  await assert.rejects(saveCloudKey('two words', { execFileImpl }), /one line/);
});

test('the key reaches no log, no event and no IPC reply: the whole Save path is scanned', async () => {
  const home = await tempHome();
  const logs = [];
  const sink = [];
  const execFileImpl = (command, args, options, done) => done(null, '', '');
  const originalError = console.error; const originalLog = console.log;
  console.error = (...a) => sink.push(a.join(' ')); console.log = (...a) => sink.push(a.join(' '));
  try {
    const reply = await saveCloudKey(validateCloudKey(KEY), { execFileImpl, log: (line) => logs.push(line) });
    sink.push(JSON.stringify(reply));
  } finally { console.error = originalError; console.log = originalLog; }
  const events = (await readdir(join(home, 'runs')).catch(() => [])).length;
  assert.equal(events, 0);
  assert.ok(![...logs, ...sink].join('\n').includes(KEY));
  assert.throws(() => validateCloudKey(42), /key/);
  assert.throws(() => validateCloudKey('x'.repeat(600)), /key/);
});

test('keyStatus asks the keychain whether a key exists without asking for its value', async () => {
  const calls = [];
  const exists = await keyStatus({ execFileImpl: (command, args, options, done) => { calls.push(args); done(null, 'keychain: "x"', ''); } });
  assert.deepEqual(exists, { saved: true });
  assert.ok(!calls[0].includes('-w') && !calls[0].includes('-g'));
  assert.deepEqual(await keyStatus({ execFileImpl: (command, args, options, done) => done(new Error('not found'), '', '') }), { saved: false });
});

test('Test key makes one tiny request only when asked, and says plainly what happened', async () => {
  const posts = [];
  const client = { post: async (body) => { posts.push(body); return { content: 'ok', finish_reason: 'stop' }; } };
  assert.equal(posts.length, 0, 'saving or opening the section made no request');
  assert.deepEqual(await testCloudKey({ client }), { ok: true, message: 'The key works.' });
  assert.equal(posts.length, 1);
  assert.ok(JSON.parse(posts[0]).max_tokens <= 8, 'a tiny request');
  const refused = await testCloudKey({ client: { post: async () => { throw new Error('The cloud AI answered with an error (HTTP 401). Nothing was written.'); } } });
  assert.deepEqual(refused, { ok: false, message: 'The cloud AI did not accept this key.' });
  const missing = await testCloudKey({ client: { post: async () => { throw new Error('No cloud key in the keychain (service "x", account "y"). Add it there.'); } } });
  assert.match(missing.message, /Save a key first/);
  const down = await testCloudKey({ client: { post: async () => { throw new Error('The cloud AI could not be reached (TypeError). Nothing was written.'); } } });
  assert.match(down.message, /could not reach/);
});

// --- wiring
test('main.js, preload and the panel are wired to the cards, the answers and the key section', async () => {
  const main = await mainText();
  const preload = await readFile(join(ROOT, 'desktop', 'preload.cjs'), 'utf8');
  const html = await readFile(join(ROOT, 'desktop', 'renderer', 'panel.html'), 'utf8');
  const panel = await readFile(join(ROOT, 'desktop', 'renderer', 'panel.js'), 'utf8');
  for (const channel of ['hikyaku:setup-answer', 'hikyaku:cloud-yes-answer', 'hikyaku:save-key', 'hikyaku:test-key', 'hikyaku:key-status']) {
    assert.ok(main.includes(`handleSecure('${channel}'`), `${channel} is handled`);
    assert.ok(preload.includes(`'${channel}'`), `${channel} is in the preload`);
  }
  assert.match(main, /shell\.openExternal\(paneUrl\(/, 'Open Settings opens the pane main.js derives, not one the renderer sends');
  assert.match(main, /createSetupGuard\(/);
  assert.match(main, /permissions: setupGuard/, 'the meeting watch gets the guard');
  assert.match(html, /<input[^>]*id="cloudKey"[^>]*type="password"|<input[^>]*type="password"[^>]*id="cloudKey"/);
  assert.match(html, /Cloud analysis/);
  assert.match(panel, /cloudKey\.value = ''/, 'the field clears after Save');
  assert.match(panel, /Use the cloud AI for this workspace/);
});

test('the setup events are in the contract', () => {
  assert.deepEqual(TYPES['setup.need'], ['permission', 'why', 'pane']);
  assert.deepEqual(TYPES['setup.answered'], ['permission', 'answer']);
  assert.deepEqual(TYPES['setup.cloud_yes'], ['group']);
  assert.deepEqual(TYPES['setup.cloud_answered'], ['group', 'answer']);
  assert.deepEqual(validateSetupAnswer('microphone', 'later'), { permission: 'microphone', answer: 'later' });
  assert.throws(() => validateSetupAnswer('camera', 'open'), /permission/);
});
