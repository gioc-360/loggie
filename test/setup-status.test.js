// teammate-ready B4: the reads the setup page and the doctor share. Every reader is faked: no keychain, no Apple
// Mail, no macOS prompt. Files live in temp folders; names are made up.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { keyStatus, saveCloudKey } from '../src/hikyaku/cloud-key.js';
import {
  NATIVE_HELPERS, fileVaultState, firstNameOf, helperState, hostAppOf, keyState, mailState, pythonState, readRawSettings, saveSetup, setupStatus, speechWantedOf, xcodeState, yesState,
} from '../src/hikyaku/setup-status.js';

const KEY = 'made-up-key-0123456789';
const tempHome = () => mkdtemp(join(tmpdir(), 'setup-status-'));
// A keychain that holds only the items named in `saved` ("service/account"); records every call.
function keychain(saved = []) {
  const calls = [];
  const execFileImpl = (command, args, options, done) => {
    calls.push({ command, args });
    const item = `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
    if (args[0] === 'add-generic-password') { saved.push(item); done(null, '', ''); return; }
    done(saved.includes(item) ? null : new Error('not found'), '', '');
  };
  return { calls, execFileImpl };
}
const MODEL = {
  STEPS: Object.freeze(['welcome', 'email', 'calendar', 'disk', 'apps', 'voice', 'keys', 'calls', 'ready']),
  isSetupDone: (raw) => raw?.setup?.done === true,
};
const ALL_YES = { discover: true, triage: true, style: true, rank: true };

test('readRawSettings: the file as written; missing is {}; not a JSON object is an error', async () => {
  const home = await tempHome();
  try {
    assert.deepEqual(await readRawSettings(home), {});
    await writeFile(join(home, 'settings.json'), '{ "signName": "Alex" }');
    assert.deepEqual(await readRawSettings(home), { signName: 'Alex' }, 'no mailApp or agent guessed');
    for (const text of ['{ broken', '[1, 2]', '"text"', 'null']) {
      await writeFile(join(home, 'settings.json'), text);
      await assert.rejects(readRawSettings(home), { message: 'settings.json could not be read.' });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('keyState asks whether each key exists, never for its value; NEBIUS_API_KEY counts as the Nebius key', async () => {
  const none = keychain();
  assert.deepEqual(await keyState({ execFileImpl: none.execFileImpl, env: {} }), { nebius: false, tavily: false });
  const both = keychain(['nebius-token-factory/hikyaku', 'tavily/hikyaku']);
  assert.deepEqual(await keyState({ execFileImpl: both.execFileImpl, env: {} }), { nebius: true, tavily: true });
  for (const { args } of [...none.calls, ...both.calls]) {
    assert.equal(args[0], 'find-generic-password');
    assert.equal(args.includes('-w') || args.includes('-g'), false, 'never the secret');
  }
  assert.deepEqual(await keyState({ execFileImpl: keychain(['tavily/hikyaku']).execFileImpl, env: { NEBIUS_API_KEY: KEY } }), { nebius: true, tavily: true });
});

test('cloud-key takes { keychain }: the Tavily key is saved and looked up under its own item, the Nebius one by default', async () => {
  const saved = [];
  const store = keychain(saved);
  const logs = [];
  assert.deepEqual(await saveCloudKey(KEY, { keychain: { service: 'tavily', account: 'hikyaku' }, execFileImpl: store.execFileImpl, log: (line) => logs.push(line) }), { saved: true });
  assert.deepEqual(saved, ['tavily/hikyaku']);
  assert.deepEqual(await keyStatus({ keychain: { service: 'tavily', account: 'hikyaku' }, execFileImpl: store.execFileImpl }), { saved: true });
  assert.deepEqual(await keyStatus({ execFileImpl: store.execFileImpl }), { saved: false }, 'the Nebius item is still the default');
  assert.equal(logs.some((line) => line.includes(KEY)), false, 'the key is never logged');
});

test('yesState: the AI yes needs all four paths; the chats yes is chatsCloud nebius', () => {
  assert.deepEqual(yesState({}), { ai: false, chats: false });
  assert.deepEqual(yesState({ cloudYes: { discover: true, triage: true, style: true } }), { ai: false, chats: false });
  assert.deepEqual(yesState({ cloudYes: ALL_YES, chatsCloud: 'nebius' }), { ai: true, chats: true });
});

test('mailState counts accounts that are read, keeps the list, and names a Full Disk refusal', async () => {
  const list = [
    { address: 'sam@school.example', kind: 'exchange', inbox: 12, sent: 3, skipped: null },
    { address: '', kind: 'icloud', inbox: 1, sent: 0, skipped: 'icloud' },
    { address: 'new@mail.example', kind: 'google', inbox: null, sent: null, skipped: null },
  ];
  let asked;
  const read = await mailState({ skip: ['old@mail.example'], mailImpl: async (options) => { asked = options; return list; } });
  assert.deepEqual(asked, { skip: ['old@mail.example'] });
  assert.deepEqual(read, { accounts: 1, addresses: ['sam@school.example'], kinds: [{ kind: 'exchange', accounts: 1, newest: null, read: true }, { kind: 'google', accounts: 1, newest: null, read: true }, { kind: 'icloud', accounts: 1, newest: null, read: false }], list, error: null });
  const locked = await mailState({ mailImpl: async () => { throw Object.assign(new Error('denied'), { pane: 'full-disk-access' }); } });
  assert.deepEqual(locked, { accounts: 0, addresses: [], kinds: [], list: [], error: 'full-disk' });
  assert.equal((await mailState({ mailImpl: async () => { throw new Error('no Mail store'); } })).error, 'no Mail store');
});

test('fileVaultState and xcodeState read fdesetup and xcode-select, and an error is unknown or not ok', async () => {
  const says = (stdout) => async () => ({ stdout, stderr: '' });
  const fails = async () => { throw new Error('not found'); };
  assert.equal(await fileVaultState({ execImpl: says('FileVault is On.\n') }), 'on');
  assert.equal(await fileVaultState({ execImpl: says('FileVault is Off.\n') }), 'off');
  assert.equal(await fileVaultState({ execImpl: says('something else') }), 'unknown');
  assert.equal(await fileVaultState({ execImpl: fails }), 'unknown');
  assert.deepEqual(await xcodeState({ execImpl: says('/Library/Developer/CommandLineTools\n') }), { ok: true, path: '/Library/Developer/CommandLineTools' });
  assert.deepEqual(await xcodeState({ execImpl: fails }), { ok: false, path: null });
});

test('helperState counts the seven helpers, outlook-move among them, and says whether the voice helper is built', async () => {
  assert.equal(NATIVE_HELPERS.length, 7);
  assert.ok(NATIVE_HELPERS.includes('hikyaku-outlook-move'));
  const built = ['/bin/hikyaku-calendar', '/bin/hikyaku-mic', '/bin/hikyaku-outlook-move'];
  assert.deepEqual(await helperState({ root: '/bin', existsImpl: async (path) => built.includes(path) }), { voice: 'missing', native: 3 });
  assert.deepEqual(await helperState({ root: '/bin', existsImpl: async () => true }), { voice: 'built', native: 7 });
});

test('hostAppOf names the app macOS lists; firstNameOf takes the first word of the full name', () => {
  assert.equal(hostAppOf({ packaged: true, env: { TERM_PROGRAM: 'Apple_Terminal' } }), 'Loggie');
  assert.deepEqual(['Apple_Terminal', 'iTerm.app', 'vscode', 'WarpTerminal'].map((TERM_PROGRAM) => hostAppOf({ packaged: false, env: { TERM_PROGRAM } })), ['Terminal', 'iTerm', 'Visual Studio Code', 'Warp']);
  assert.equal(hostAppOf({ packaged: false, env: {} }), 'the app you started Loggie from');
  assert.equal(firstNameOf('  Alex Example\n'), 'Alex');
  assert.equal(firstNameOf('A'.repeat(50)), 'A'.repeat(40));
  assert.equal(firstNameOf(''), '');
  assert.equal(firstNameOf(undefined), '');
});

function readers(home, extra = {}) {
  return {
    home, userHome: '/fake/user', env: { TERM_PROGRAM: 'iTerm.app' }, packaged: false, model: MODEL,
    existsImpl: async (path) => ['/Applications/WhatsApp.app', '/fake/bin/loggie-voice'].includes(path),
    execImpl: async (file) => {
      if (file === 'id') return { stdout: 'Alex Example\n' };
      if (file === 'fdesetup') return { stdout: 'FileVault is On.' };
      throw new Error('not found');
    },
    execFileImpl: keychain(['tavily/hikyaku']).execFileImpl,
    mailImpl: async () => [{ address: 'alex@mail.example', kind: 'google', inbox: 4, sent: 1, skipped: null }],
    helperRoot: '/fake/bin',
    permissionsImpl: async () => ({ calendar: 'granted', fullDisk: 'denied', microphone: 'not-a-state' }),
    speechImpl: async () => ({ wanted: true, ready: false }),
    ...extra,
  };
}

test('setupStatus gives the whole SetupStatus, and part "permissions" only the permissions and mail', async () => {
  const home = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'apple-mail', chats: ['messages'], cloudYes: ALL_YES, setup: { step: 'keys', startedAt: '2026-10-18T10:00:00.000Z', voice: 'granted', automation: 'denied' } }));
    const status = await setupStatus(readers(home));
    assert.deepEqual(status, {
      done: false, step: 'keys', startedAt: '2026-10-18T10:00:00.000Z', readyAt: null, signName: '', suggestedName: 'Alex',
      mailApp: 'apple-mail', chats: true, installed: { outlook: false, whatsapp: true }, hostApp: 'iTerm',
      permissions: { calendar: 'granted', fullDisk: 'denied', microphone: 'unknown', screen: 'unknown', accessibility: 'unknown', automation: 'denied' },
      mail: { accounts: 1, addresses: ['alex@mail.example'], kinds: [{ kind: 'google', accounts: 1, newest: null, read: true }], error: null }, keys: { nebius: false, tavily: true }, yes: { ai: true, chats: false },
      voice: { answer: 'granted', helper: 'built' }, helpers: { native: 0, of: 7 },
      speech: { wanted: true, ready: false, always: false, chosen: null, bytes: 1460555318 }, python: { ok: true, numpy: false, packaged: false }, fileVault: 'on',
      firstRun: true, found: null,
    });
    assert.deepEqual(Object.keys(await setupStatus({ ...readers(home), part: 'permissions' })), ['permissions', 'mail']);

    // A yes and no setup key is not done since 2026-10-28 (setup opens once); a step that is not one of the nine is null.
    await writeFile(join(home, 'settings.json'), JSON.stringify({ cloudYes: ALL_YES, mailApp: 'telegram', setup: undefined }));
    const his = await setupStatus(readers(home));
    assert.deepEqual([his.done, his.step, his.mailApp, 'gmail' in his], [false, null, null, false]);
    await writeFile(join(home, 'settings.json'), JSON.stringify({ setup: { step: 'nowhere' } }));
    assert.equal((await setupStatus(readers(home))).step, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// first-run-polish B5.1 (S1, S1b): the speech switch and the Python that call notes need.
test('speechWantedOf: packaged, the env or a saved true; false and absent never download', () => {
  assert.equal(speechWantedOf({ packaged: true, env: {}, raw: {} }), true);
  assert.equal(speechWantedOf({ packaged: false, env: { HIKYAKU_SPEECH_DOWNLOAD: '1' }, raw: {} }), true);
  assert.equal(speechWantedOf({ packaged: false, env: {}, raw: { speechModels: true } }), true);
  assert.equal(speechWantedOf({ packaged: false, env: {}, raw: { speechModels: false } }), false);
  assert.equal(speechWantedOf({ packaged: false, env: {}, raw: {} }), false);
  assert.equal(speechWantedOf({ packaged: false, env: { HIKYAKU_SPEECH_DOWNLOAD: '0' }, raw: { speechModels: 'true' } }), false, 'only a boolean true counts');
});

test('pythonState: numpy imports, no python3 at all, or a python3 without numpy', async () => {
  const seen = [];
  assert.deepEqual(await pythonState({ execImpl: async (file, args) => { seen.push([file, args]); return { stdout: '' }; } }), { ok: true, numpy: true });
  assert.deepEqual(seen, [['python3', ['-c', 'import numpy']]], 'no -I: numpy from pip install --user counts');
  assert.deepEqual(await pythonState({ execImpl: async () => { throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }); } }), { ok: false, numpy: false });
  assert.deepEqual(await pythonState({ execImpl: async () => { throw Object.assign(new Error('ModuleNotFoundError'), { code: 1 }); } }), { ok: true, numpy: false });
  const bundled = [];
  await pythonState({ execImpl: async (file) => { bundled.push(file); return {}; }, python: '/Applications/Loggie.app/Contents/Resources/python/bin/python3' });
  assert.deepEqual(bundled, ['/Applications/Loggie.app/Contents/Resources/python/bin/python3']);
});

test('setupStatus: a python3 that times out is ok without numpy; a saved switch is chosen; packaged is always', async () => {
  const home = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ speechModels: false }));
    const hang = readers(home, { execImpl: async (file, args) => {
      if (file === 'python3' && args[0] === '-c') throw Object.assign(new Error('Command failed: python3 -c import numpy'), { killed: true, signal: 'SIGTERM', code: null });
      if (file === 'id') return { stdout: 'Alex Example\n' };
      throw new Error('not found');
    } });
    const status = await setupStatus(hang);
    assert.deepEqual(status.python, { ok: true, numpy: false, packaged: false });
    assert.deepEqual([status.speech.chosen, status.speech.always, status.speech.bytes], [false, false, 1460555318]);
    const packaged = await setupStatus({ ...readers(home), packaged: true });
    assert.deepEqual([packaged.speech.always, packaged.python.packaged], [true, true]);
    const env = await setupStatus({ ...readers(home), env: { HIKYAKU_SPEECH_DOWNLOAD: '1' } });
    assert.equal(env.speech.always, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('saveSetup keeps speechModels at the top level, as a boolean', async () => {
  const home = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook' }));
    await saveSetup(home, { speechModels: true, step: 'ready' });
    const on = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual([on.speechModels, on.setup.step, on.mailApp, 'speechModels' in on.setup], [true, 'ready', 'outlook', false]);
    await saveSetup(home, { speechModels: false });
    assert.equal(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')).speechModels, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('saveSetup writes only the setup keys: other keys survive, startedAt is kept, done takes only true', async () => {
  const home = join(await tempHome(), 'hikyaku');
  try {
    const first = await saveSetup(home, { signName: '  Alex   Example ', step: 'welcome' }, { now: new Date('2026-10-18T10:00:00Z') });
    assert.deepEqual(first, { setup: { step: 'welcome' }, signName: 'Alex Example', mailApp: null, chats: [] });
    await writeFile(join(home, 'settings.json'), JSON.stringify({ ...JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')), cloudYes: ALL_YES, chatsCloud: 'nebius', skipAccounts: ['old@mail.example'] }));
    await saveSetup(home, { step: 'email', mailApp: 'outlook', chats: true }, { now: new Date('2026-10-18T10:00:05Z'), whatsapp: true });
    await saveSetup(home, { step: 'calendar' }, { now: new Date('2026-10-18T10:00:09Z') });
    await saveSetup(home, { voice: 'granted', automation: 'unknown', chats: false }, { now: new Date('2026-10-18T10:00:20Z') });
    await assert.rejects(saveSetup(home, { done: false }), /not one Loggie offers/);
    const done = await saveSetup(home, { done: true }, { now: new Date('2026-10-18T10:00:41Z') });
    const text = await readFile(join(home, 'settings.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    const raw = JSON.parse(text);
    assert.deepEqual(raw.cloudYes, ALL_YES);
    assert.deepEqual([raw.chatsCloud, raw.skipAccounts, raw.mailApp, raw.chats], ['nebius', ['old@mail.example'], 'outlook', []]);
    assert.deepEqual(raw.setup, { step: 'ready', startedAt: '2026-10-18T10:00:05.000Z', voice: 'granted', automation: 'unknown', readyAt: '2026-10-18T10:00:41.000Z', done: true, doneAt: '2026-10-18T10:00:41.000Z' });
    assert.deepEqual(done.setup, raw.setup);
    await saveSetup(home, { signName: '' });
    assert.equal('signName' in JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')), false, "'' deletes the name");
  } finally { await rm(join(home, '..'), { recursive: true, force: true }); }
});

// F8 (first-run-polish B4.1): a first Done opens the Found step; doneAt is written once; Keep or Later saves found.
test('a first Done saves found pending and doneAt once; a later Done keeps both; found takes later', async () => {
  const home = join(await tempHome(), 'hikyaku');
  try {
    const first = await saveSetup(home, { done: true }, { first: true, now: new Date('2026-10-18T11:00:00Z') });
    assert.deepEqual([first.setup.found, first.setup.doneAt], ['pending', '2026-10-18T11:00:00.000Z']);
    const again = await saveSetup(home, { done: true }, { first: true, now: new Date('2026-10-18T12:00:00Z') });
    assert.deepEqual([again.setup.found, again.setup.doneAt], ['pending', '2026-10-18T11:00:00.000Z'], 'the first doneAt and the found state stay');
    assert.equal((await saveSetup(home, { found: 'later' })).setup.found, 'later');
    assert.equal((await saveSetup(home, { done: true }, { first: true })).setup.found, 'later', 'a later Done never reopens the step');
    const other = join(await tempHome(), 'hikyaku');
    const notFirst = await saveSetup(other, { done: true }, { first: false });
    assert.equal('found' in notFirst.setup, false, 'a Mac with workstreams.json gets no Found step');
    await assert.rejects(saveSetup(other, { found: 'yes' }), /not one Loggie offers/);
    await rm(join(other, '..'), { recursive: true, force: true });
  } finally { await rm(join(home, '..'), { recursive: true, force: true }); }
});

// loggie-diagnostics, 2026-10-22: the chats switch in Settings saved through saveSetup, which wrote an empty setup
// record. A Settings save still writes none; since 2026-10-28 an install with no record opens setup once anyway, and its
// background keeps running (backgroundRuns).
test('a Settings save on an install that skipped setup writes no setup record; its first step save marks it existing', async () => {
  const { backgroundRuns, isSetupDone } = await import('../desktop/renderer/setup-model.js');
  const home = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ cloudYes: { discover: true } }));
    await saveSetup(home, { chats: true }, { whatsapp: true });
    const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual(raw.chats, ['messages', 'whatsapp']);
    assert.equal('setup' in raw, false, 'no setup record');
    assert.deepEqual([isSetupDone(raw, { existing: true }), backgroundRuns(raw, { existing: true })], [false, true], 'setup opens once, the background runs');
    await saveSetup(home, { step: 'email' });
    const after = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual(after.setup, { step: 'email', startedAt: after.setup.startedAt, existing: true }, 'a setup step writes it, marked existing');
    assert.deepEqual([isSetupDone(after), backgroundRuns(after)], [false, true]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Codex review, 2026-10-23 (finding 4): Turn on in Settings records what macOS answered (Apple Mail control, voice
// typing). On an install that skipped setup, the answer is kept and its background keeps running; setup still opens.
test('an answer recorded from Settings on an install that skipped setup reads back, and only a Done marks it done', async () => {
  const { backgroundRuns, isSetupDone } = await import('../desktop/renderer/setup-model.js');
  const home = await tempHome();
  const fresh = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ cloudYes: { discover: true } }));
    await saveSetup(home, { automation: 'granted' });
    await saveSetup(home, { voice: 'granted' });
    const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual([isSetupDone(raw), backgroundRuns(raw), raw.setup.existing], [false, true, true]);
    assert.deepEqual([raw.setup.automation, raw.setup.voice], ['granted', 'granted']);
    await saveSetup(home, { done: true });
    assert.equal(isSetupDone(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))), true, 'Done marks it done');
    // A fresh Mac in the middle of setup (a record with a step, not done) stays in the middle, its background waiting.
    await writeFile(join(fresh, 'settings.json'), JSON.stringify({ setup: { step: 'apps' } }));
    await saveSetup(fresh, { automation: 'granted', signName: 'Alex' });
    const mid = JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8'));
    assert.deepEqual([isSetupDone(mid), backgroundRuns(mid, { existing: true }), 'existing' in mid.setup], [false, false, false]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
  }
});

// 2026-10-28 (Gio): Jess used Loggie before onboarding existed. Her settings have a name, a mail app, chats and the
// yes, and she has workstreams.json, but no setup record: setup opens once, on Welcome, with what is known filled in.
test('setupStatus on an install from before setup: not done, opens on Welcome, prefilled; a done setup stays done', async () => {
  const { firstStep } = await import('../desktop/renderer/setup-model.js');
  const home = await tempHome();
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ signName: 'Jess', mailApp: 'outlook', chats: ['messages'], cloudYes: ALL_YES }));
    await writeFile(join(home, 'workstreams.json'), '[]');
    const has = async (path) => path === join(home, 'workstreams.json') || path === '/Applications/WhatsApp.app';
    const jess = await setupStatus({ ...readers(home), model: null, existsImpl: has });
    assert.deepEqual([jess.done, jess.step, jess.signName, jess.mailApp, jess.chats, jess.yes.ai, jess.firstRun], [false, null, 'Jess', 'outlook', true, true, false]);
    assert.equal(firstStep(jess), 'welcome');
    await writeFile(join(home, 'settings.json'), JSON.stringify({ signName: 'Gio', mailApp: 'outlook', setup: { step: 'ready', done: true, found: 'done' } }));
    const gio = await setupStatus({ ...readers(home), model: null, existsImpl: has });
    assert.deepEqual([gio.done, firstStep(gio)], [true, null]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
