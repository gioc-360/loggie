// The launch waits for setup, and every way to give Loggie its yes or key starts the look for workspaces at once
// (docs/teammate-ready/spec.md B2). Read from main.js, since main has no unit tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertWired, handlerIn, mainText } from './helpers/main-files.js';

const main = await mainText();
const handler = (name) => handlerIn(main, name);

test('one look for workspaces at a time for every caller', () => {
  assert.match(main, /discovering \|\|= discoverAndSay\(\)/);
  assert.match(main.slice(main.indexOf('function startDiscovery')), /discoverOnce\(\)/);
});

test('the yes and a saved key start the look now, not at the next hourly tick', () => {
  assert.match(handler('hikyaku:cloud-yes-answer'), /discoverSoon\(\)/);
  assert.match(handler('hikyaku:save-key'), /discoverSoon\(\)/);
});

// 2026-10-28: an install from before setup runs its background while its one setup is open (backgroundRuns).
test('the background starts only when setup is done or the install is from before setup; setup opens when not done', () => {
  assert.match(main, /const setup = await setupNow\(\);\n\s*if \(setup\.background\) startAfterSetup\(\);\n\s*if \(!setup\.done\) await expandPanel\(\);/);
  assert.match(main, /return \{ done: isSetupDone\(raw\), background: backgroundRuns\(raw, \{ existing: existing \|\| Boolean\(raw\.signName \|\| raw\.mailApp \|\| raw\.cloudYes\) \}\) \};/);
  const ready = main.slice(main.indexOf('app.whenReady()'));
  for (const start of ['startMeetingWatch()', 'startDiscovery()', 'startRefreshing()', 'startRanking()', 'learnIntros()']) {
    assert.ok(!ready.slice(0, ready.indexOf('startAfterSetup();')).includes(start), `${start} runs before setup is done`);
  }
});

// first-run-polish B5.1 (S4, K8): one speech download at a time, the Calls switch starts it, and recording waits on
// speech only where the app always downloads it.
test('a second speech start joins the run in flight; the switch starts it; recording keeps the old gate', () => {
  const start = main.slice(main.indexOf('function startSpeechDownload'), main.indexOf('async function attemptLoop'));
  assert.match(start, /speechRun \|\|= attemptLoop\(\)\.finally\(\(\) => \{ speechRun = null; \}\)/);
  assert.match(main, /const speechGate = isPackaged\(\) \|\| process\.env\.HIKYAKU_SPEECH_DOWNLOAD === '1';/);
  assert.match(main, /speechReady: speechGate \? speechIsReady : undefined,/);
  assert.match(main, /if \(await speechWantedNow\(\)\) startSpeechDownload\(\)/);
  assert.doesNotMatch(main, /\bspeechWanted\b/, 'the old const is gone');
  assert.match(handler('hikyaku:setup-save'), /if \(input\.speechModels === true\) startSpeechDownload\(\)/);
  assert.match(handler('hikyaku:setup-status'), /python: transcriberRuntime\(\)\.python/);
});

// first-run-polish B5.4 (S13): the call notes card is asked for from the screen hook, once per run through askCloudYes,
// only while the AI yes is there and callsAsked is not true; the answer saves calls or only callsAsked.
test('the hook asks for the calls yes once, only when callsAsked is not true; the answer writes through grantCalls or laterCalls', () => {
  assert.match(main, /path === 'calls' \? 'calls'/, 'askCloudYes knows the calls group');
  assert.match(main, /if \(!group \|\| askedYes\.has\(group\)\) return;\n\s*askedYes\.add\(group\);/);
  const ask = main.slice(main.indexOf('async function askCallsYes'), main.indexOf('async function startEntryEventTail'));
  assert.match(ask, /if \(yesState\(raw\)\.ai && raw\.cloudYes\?\.callsAsked !== true\) askCloudYes\('calls'\);/);
  assert.doesNotMatch(ask, /emitSetup/, 'only through askCloudYes');
  assert.match(main, /autoDecideOnScreen\(\{ options: async \(\) => \(\{ \.\.\.\(await decideGateOptionsOf\(\)\)\.options, standing: await standingYes\(\), askCalls: /);
  const standing = main.slice(main.indexOf('async function standingYes'), main.indexOf('async function askCallsYes'));
  for (const part of ['callsYes: settings.cloudYes?.calls === true', 'callsAt: settings.cloudYes?.callsAt || null', 'process.env.NEBIUS_API_KEY', 'keyStatus()', 'usageToday(home)', 'cloudDailyLimitUsd']) assert.ok(standing.includes(part), part);
  assert.match(handler('hikyaku:cloud-yes-answer'), /input\.group === 'calls'\) await inSettings\(\(\) => \(input\.answer === 'yes' \? grantCalls\(hikyakuDirectory\(\)\) : laterCalls\(hikyakuDirectory\(\)\)\)\)/);
  // fileNotesOnly is fileCall alone: no names check, no web errands.
  const notesOnly = main.slice(main.indexOf('const fileNotesOnly'), main.indexOf('\n', main.indexOf('const fileNotesOnly')));
  assert.match(notesOnly, /fileCall\(/);
  assert.doesNotMatch(notesOnly, /startNameCheck|startErrands/);
});

// Gio's five marks (first-run-polish B2.1a): the sources stay as he gave them, pinned by sha256; the copies the
// renderer loads are resized so the longer side is at most 64 px.
const MARKS = {
  'apple-mail.png': '2d4dd797f955b637787f16f4000451b98a7181582096c451e5f23ee631d5e878',
  'gmail.png': '2c1d72342b4b650d4cfc6990365171bf48ff5a272a6d4ebbdab3fdcdaa024b37',
  'messages.png': '0c744a9c98c0fd6196ebc8995ca54aa42de6511d9174cff8438074ab39dcf7a3',
  'outlook.png': '06f0a2b74757a5c967c6ae99d0adc2a46ec1cbac5798d5bcf499b49b3d08d54c',
  'whatsapp.png': '1533a10561cfd6d7dde0717c9290d0e9c71db55a0fa611f0a6bc554357b35136',
};

test('Gio’s marks are kept unmodified and copied at most 64 px on the longer side', async () => {
  const { createHash } = await import('node:crypto');
  for (const [file, sha] of Object.entries(MARKS)) {
    const source = await readFile(new URL(`../docs/first-run-polish/marks/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), sha, `${file} source hash`);
    const copy = await readFile(new URL(`../desktop/renderer/marks/${file}`, import.meta.url));
    assert.equal(copy.subarray(1, 4).toString('latin1'), 'PNG', `${file} copy is a PNG`);
    assert.equal(copy.subarray(12, 16).toString('latin1'), 'IHDR', `${file} copy has its header first`);
    const width = copy.readUInt32BE(16);
    const height = copy.readUInt32BE(20);
    assert.ok(width > 0 && height > 0 && Math.max(width, height) <= 64, `${file} copy is ${width} x ${height}`);
  }
});

// The setup page's app marks (first-run-polish B2.2): one channel, wired main, preload and panel.
const CHANNELS = [['hikyaku:app-icon', 'appIcon']];

test('every setup marks channel has a main handler, a preload method and a panel wrapper', async () => {
  await assertWired(CHANNELS);
});
