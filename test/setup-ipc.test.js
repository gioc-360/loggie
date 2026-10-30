// teammate-ready B5.1-B5.2, the engine half: what the setup page may send main, the calendar's status read (which
// never asks macOS), the Tavily key test's sentences, and the six channels wired from main to preload. Every outside
// call is faked: no helper runs, no keychain, no web. Files live in temp folders; the key is made up.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APP_ICON_IDS, validateAppIcon, validateSetupAsk, validateSetupPart, validateSetupSave } from '../desktop/ipc-validation.js';
import { SETUP_ASKS, STEPS } from '../desktop/renderer/setup-model.js';
import { calendarStatus } from '../src/hikyaku/calendar.js';
import { createTavily, tavilyKey, testTavilyKey, USAGE_FILE } from '../src/hikyaku/tavily.js';
import { assertWired, handlerIn, mainText } from './helpers/main-files.js';

const KEY = 'tvly-made-up-0123456789';
const NOT_OFFERED = 'That setup choice is not one Loggie offers.';
const tempHome = () => mkdtemp(join(tmpdir(), 'setup-ipc-'));

test('a setup save takes only the eight setup keys, with the values the steps offer', () => {
  assert.deepEqual(validateSetupSave({ signName: '  Alex   Rivera ', step: 'email' }), { signName: 'Alex Rivera', step: 'email' });
  assert.deepEqual(validateSetupSave({ signName: '' }), { signName: '' });
  for (const mailApp of ['outlook', 'apple-mail']) assert.deepEqual(validateSetupSave({ mailApp, chats: false }), { mailApp, chats: false });
  for (const step of STEPS) assert.deepEqual(validateSetupSave({ step }), { step });
  assert.deepEqual(validateSetupSave({ done: true }), { done: true });
  assert.deepEqual(validateSetupSave({ voice: 'denied', automation: 'unknown' }), { voice: 'denied', automation: 'unknown' });
  // The Calls step's speech switch (first-run-polish B5.1, S2).
  for (const speechModels of [true, false]) assert.deepEqual(validateSetupSave({ speechModels, step: 'ready' }), { speechModels, step: 'ready' });
  const bad = [
    undefined, null, 'email', ['step'], {}, { cloudYes: true }, { step: 'email', enterprise: true },
    { signName: 'A'.repeat(41) }, { signName: 'Alex\nRivera' }, { signName: 7 }, { mailApp: 'thunderbird' }, { mailApp: 'gmail' }, { chats: 'on' },
    { step: 'done' }, { done: false }, { done: 'true' }, { voice: 'unknown' }, { automation: 'maybe' },
    { speechModels: 'on' }, { speechModels: 1 }, { speechModels: null },
  ];
  for (const patch of bad) assert.throws(() => validateSetupSave(patch), { message: NOT_OFFERED }, JSON.stringify(patch));
});

test('a setup ask is one of the nine things setup asks for, and a status read is whole or permissions only', () => {
  for (const what of SETUP_ASKS) assert.equal(validateSetupAsk(what), what);
  for (const what of [undefined, null, 'camera', 'Calendar', ['calendar']]) assert.throws(() => validateSetupAsk(what), { message: 'That is not something setup asks for.' });
  assert.equal(validateSetupPart(undefined), null);
  assert.equal(validateSetupPart(null), null);
  assert.equal(validateSetupPart('permissions'), 'permissions');
  for (const part of ['mail', '', 1]) assert.throws(() => validateSetupPart(part), { message: 'Ask for the whole setup status or its permissions.' });
});

test('the calendar status is the helper\'s status word, and any failure is unknown', async () => {
  const calls = [];
  const helper = '/made/up/hikyaku-calendar';
  const answering = (stdout) => async (file, args) => { calls.push([file, ...args]); return { stdout }; };
  for (const word of ['granted', 'denied', 'unknown']) assert.equal(await calendarStatus({ helper, execImpl: answering(`{"status":"${word}"}\n`) }), word);
  assert.deepEqual(calls, [[helper, 'status'], [helper, 'status'], [helper, 'status']]);
  assert.equal(await calendarStatus({ helper, execImpl: answering('{"status":"writeOnly"}') }), 'unknown');
  assert.equal(await calendarStatus({ helper, execImpl: answering('not json') }), 'unknown');
  assert.equal(await calendarStatus({ helper, execImpl: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'the helper stopped' }); } }), 'unknown');
});

// The real createTavily, with only the keychain and the web faked.
function tavily(home, { status = 200, reach = true, key = KEY } = {}) {
  const sent = [];
  const fetchImpl = async (url, request) => {
    sent.push({ url, request });
    if (!reach) throw new TypeError('fetch failed');
    return { ok: status < 400, status, json: async () => ({ results: [{ title: 'Loggie', url: 'https://example.com' }] }) };
  };
  const keyImpl = () => tavilyKey({ execFileImpl: (_command, _args, _options, done) => (key ? done(null, `${key}\n`) : done(new Error('not found'), '')) });
  return { sent, search: createTavily({ home, keyImpl, fetchImpl, max: 1 }) };
}
const usage = (home) => readFile(join(home, USAGE_FILE), 'utf8').then((text) => text.trim().split('\n').map((line) => JSON.parse(line)), () => []);

test('Test key makes one search for "Loggie", logged as test-key, and says the key works', async () => {
  const home = await tempHome();
  try {
    const { sent, search } = tavily(home);
    assert.deepEqual(await testTavilyKey({ search, home }), { ok: true, message: 'The key works.' });
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0].request.body), { query: 'Loggie', max_results: 1 });
    assert.deepEqual((await usage(home)).map(({ path, kind, credits, ok }) => ({ path, kind, credits, ok })), [{ path: 'test-key', kind: 'search', credits: 1, ok: true }]);
    assert.ok(!(await readFile(join(home, USAGE_FILE), 'utf8')).includes(KEY));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Test key says why it did not work, in one sentence that never holds the key', async () => {
  const home = await tempHome();
  try {
    const cases = [
      [{ key: '' }, 'There is no key yet. Paste it first.', 0],
      [{ status: 401 }, 'Tavily did not accept this key.', 1],
      [{ status: 403 }, 'Tavily did not accept this key.', 1],
      [{ reach: false }, 'Loggie could not reach Tavily. Check your connection and try again.', 1],
      [{ status: 500 }, 'The test did not work. Check the key and try again.', 1],
    ];
    for (const [setup, message, requests] of cases) {
      const { sent, search } = tavily(home, setup);
      const answer = await testTavilyKey({ search, home });
      assert.deepEqual(answer, { ok: false, message }, JSON.stringify(setup));
      assert.equal(sent.length, requests, JSON.stringify(setup));
      assert.ok(!JSON.stringify(answer).includes(KEY));
    }
    // Only the requests sent are logged, each a failure that cost nothing.
    assert.deepEqual((await usage(home)).map(({ path, credits, ok }) => [path, credits, ok]), Array(4).fill(['test-key', 0, false]));
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Each setup channel has a main handler, a preload method and a setupApi wrapper in panel.js (the regexes of
// meetings-wiring.test.js). A missing hop is a dead button the click check, on its stand-in bridge, cannot see.
const CHANNELS = [
  ['hikyaku:setup-status', 'setupStatus'],
  ['hikyaku:setup-save', 'setupSave'],
  ['hikyaku:setup-ask', 'setupAsk'],
  ['hikyaku:save-tavily-key', 'saveTavilyKey'],
  ['hikyaku:test-tavily-key', 'testTavilyKey'],
  ['hikyaku:relaunch', 'relaunch'],
];
const main = await mainText();
const handler = (name) => handlerIn(main, name);

test('every setup channel has a main handler, a preload method and a panel wrapper', async () => {
  await assertWired(CHANNELS);
});

test('setup saves one at a time and Done starts the background; only an ask shows a macOS question', () => {
  assert.match(handler('hikyaku:setup-save'), /inSettings\(\(\) => saveSetup\(/);
  assert.match(handler('hikyaku:setup-save'), /startAfterSetup\(\);\s*discoverSoon\(\);/);
  assert.match(handler('hikyaku:save-tavily-key'), /keychain: TAVILY_KEYCHAIN/);
  assert.match(handler('hikyaku:relaunch'), /setTimeout\(\(\) => \{ app\.relaunch\(\); app\.quit\(\); \}, 200\)/);
  const status = handler('hikyaku:setup-status');
  assert.doesNotMatch(status, /isTrustedAccessibilityClient\(true\)|askForMediaAccess|listEvents|openExternal/);
});

test('an app icon is asked for by one of the six app ids, never a path (first-run-polish B2.2)', () => {
  const ids = ['outlook', 'apple-mail', 'calendar', 'system-settings', 'messages', 'whatsapp'];
  assert.deepEqual([...APP_ICON_IDS], ids);
  assert.ok(Object.isFrozen(APP_ICON_IDS));
  for (const id of ids) assert.equal(validateAppIcon(id), id);
  for (const bad of ['finder', '/Applications/Outlook.app', null, ['outlook']]) {
    assert.throws(() => validateAppIcon(bad), { message: 'Loggie has no icon for that app.' }, JSON.stringify(bad));
  }
});
