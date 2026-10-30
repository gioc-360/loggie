import assert from 'node:assert/strict';
import test from 'node:test';
import { doctorHome, failures, formatChecks, hikyakuChecks } from '../src/hikyaku/doctor.js';

const HOME = '/fake/hikyaku';

const OUTLOOK_ONLY = [{ address: 'sam@school.edu', kind: 'exchange', inbox: 120, sent: 14, skipped: null }];
const BOTH_KEYS = { nebius: true, tavily: true };
const ALL_HELPERS = { voice: 'built', native: 7 };
function mac({ files = {}, present = [], exec = {}, mail = OUTLOOK_ONLY, keys = BOTH_KEYS, helpers = ALL_HELPERS } = {}) {
  return {
    home: HOME,
    env: {},
    readImpl: async (path) => { if (path in files) return files[path]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    existsImpl: async (path) => path === HOME || present.includes(path) || path in files,
    execImpl: async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      const found = Object.entries(exec).find(([prefix]) => key.startsWith(prefix));
      if (!found || found[1] instanceof Error) throw found?.[1] || new Error('not found');
      return { stdout: found[1], stderr: '' };
    },
    // A model server on this Mac would be found here; the doctor must never ask (Gio, 2026-10-18: none on this Mac).
    fetchImpl: async () => { throw new Error('the doctor asked a local model server'); },
    memoryGB: 64, userHome: '/fake/user',
    // Never the real Apple Mail: one Outlook account, unless a test says otherwise.
    mailImpl: async () => mail,
    // Never the real keychain or the real dist-native folder.
    keysImpl: async () => keys,
    helpersImpl: async () => helpers,
    // Never the real Mail store: a V10 one whose index opens (Full Disk Access on); anything else is not there.
    storeImpl: async () => ({ version: 'V10', index: STORE_INDEX }),
    openImpl: async (path) => { if (path !== STORE_INDEX) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  };
}
const STORE_INDEX = '/fake/user/Library/Mail/V10/MailData/Envelope Index';
const MAIL_APP = '/System/Applications/Mail.app';

const READY = {
  files: {
    [`${HOME}/settings.json`]: '{ "agent": "claude", "mailApp": "outlook", "cloudYes": { "discover": true, "triage": true, "style": true, "rank": true } }',
    [`${HOME}/workstreams.json`]: '[{ "name": "Acme Bank", "kind": "company", "domains": ["acmebank.com"], "words": [] }]',
  },
  present: ['/Applications/Microsoft Outlook.app', `${HOME}/voice/intros.md`],
  exec: { 'xcode-select -p': '/Library/Developer/CommandLineTools', osascript: 'true', 'fdesetup status': 'FileVault is On.', 'python3 -c': '' },
};

test('a Mac with everything says ready, one line per outside system', async () => {
  const result = await hikyakuChecks(mac(READY));
  assert.equal(failures(result), 0);
  assert.deepEqual(result.checks.map((check) => check.name), ['settings.json', 'workstreams.json', 'mail', 'mail sam@school.edu', 'Mail store', 'Outlook', 'Full Disk Access', 'mail app', 'Xcode tools', 'chats', 'Accessibility', 'FileVault',
    'cloud key', 'Tavily key', 'cloud yes', 'helpers', 'voice helper', 'python', 'voice']);
  // loggie-diagnostics: chats off is a warning (the Mac is still ready for email), never a pass.
  assert.equal(result.checks.every((check) => check.ok || (check.name === 'chats' && check.warn)), true);
  assert.match(formatChecks(result), /Ready: Loggie can write drafts on this Mac\./);
  assert.doesNotMatch(formatChecks(result), /local model|NVIDIA model|Python|mlx|8080/, 'nothing about a model on this Mac');
});

// teammate-ready C7: before the first open there is no hikyaku folder; every Mac line still prints, the file lines wait.
test('without a hikyaku folder every Mac line prints, a missing key is a note, and nothing fails', async () => {
  const fresh = mac({ exec: { 'xcode-select -p': '/Library/Developer/CommandLineTools', 'fdesetup status': 'FileVault is On.', osascript: 'true' }, keys: { nebius: false, tavily: false }, helpers: { voice: 'missing', native: 0 } });
  // Apple Mail ships with macOS: with no Outlook the drafts open there (2026-10-28).
  const result = await hikyakuChecks({ ...fresh, existsImpl: async (path) => path === MAIL_APP });
  assert.equal(result.configured, false);
  const names = result.checks.map((check) => check.name);
  for (const name of ['Loggie', 'mail', 'Xcode tools', 'helpers', 'cloud key', 'Tavily key', 'cloud yes', 'FileVault', 'python']) assert.ok(names.includes(name), `${name} is missing`);
  for (const name of ['settings.json', 'workstreams.json', 'voice']) assert.equal(names.includes(name), false, `${name} is a file check`);
  assert.equal(failures(result), 0);
  const text = formatChecks(result);
  assert.match(text, /✓ Loggie: not set up on this Mac yet: npm run desktop opens the setup page/);
  assert.match(text, /! cloud key: no Nebius key yet, so Loggie cannot write notes or replies\n {4}note: paste it on the setup page \(Keys\) or in Settings, Cloud analysis/);
  assert.match(text, /! Tavily key: no Tavily key yet/);
  assert.doesNotMatch(text, /✗/);
});

// first-run-polish B1.3: the doctor prints only what `npm run desktop` needs; no agent, plugin or old inspector line.
test('the doctor names nothing npm run desktop does not need, and an empty workstreams.json is a note', async () => {
  const text = formatChecks(await hikyakuChecks(mac(READY)));
  for (const word of ['Antigravity', 'plugin', 'Terminal UI', 'inspector', 'AI agent', 'agent claude']) assert.equal(text.includes(word), false, `${word} is printed`);
  assert.doesNotMatch(text, /claude|codex|\bagy\b/i, 'no CLI drafter is named');
  assert.equal(text.split('\n').some((line) => line === 'hikyaku'), false, 'no hikyaku header line');
  const empty = await hikyakuChecks(mac({ ...READY, files: { ...READY.files, [`${HOME}/workstreams.json`]: '[]' } }));
  const line = empty.checks.find((check) => check.name === 'workstreams.json');
  assert.deepEqual([line.ok, line.warn, line.detail, line.fix], [false, true, 'has no workspaces yet', 'Loggie finds them from your mail after setup']);
  assert.equal(failures(empty), 0);
  assert.match(formatChecks(empty), /! workstreams\.json: has no workspaces yet\n {4}note: Loggie finds them from your mail after setup/);
});

// first-run-polish B5.2 (S5): the python line says whether recorded calls can get notes; it is a note, never a failure.
test('the python line: numpy found is ✓; no numpy and no python3 are notes with their fix', async () => {
  const ok = await hikyakuChecks(mac(READY));
  assert.match(formatChecks(ok), /✓ python: python3 with numpy \(call notes\)/);
  const noNumpy = await hikyakuChecks(mac({ ...READY, exec: { ...READY.exec, 'python3 -c': Object.assign(new Error('No module named numpy'), { code: 1 }) } }));
  assert.match(formatChecks(noNumpy), /! python: python3 has no numpy, so recorded calls get no notes\n {4}note: run: python3 -m pip install numpy/);
  assert.equal(failures(noNumpy), 0);
  const none = await hikyakuChecks(mac({ ...READY, exec: { ...READY.exec, 'python3 -c': Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }) } }));
  assert.match(formatChecks(none), /! python: no python3, so recorded calls get no notes\n {4}note: run: xcode-select --install/);
  assert.equal(failures(none), 0);
});

test('both keys saved are two ✓ lines', async () => {
  const result = await hikyakuChecks(mac(READY));
  const by = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.deepEqual([by['cloud key'].ok, by['cloud key'].detail, by['Tavily key'].ok, by['Tavily key'].detail], [true, 'Nebius key saved in the keychain', true, 'saved']);
  const env = await hikyakuChecks({ ...mac(READY), env: { NEBIUS_API_KEY: 'made-up' } });
  assert.equal(env.checks.find((check) => check.name === 'cloud key').detail, 'Nebius key set in NEBIUS_API_KEY');
  assert.doesNotMatch(formatChecks(env), /made-up/, 'the key itself never prints');
});

test('three of the four yes paths is no yes: a note to press Yes', async () => {
  const files = { ...READY.files, [`${HOME}/settings.json`]: '{ "agent": "claude", "mailApp": "outlook", "cloudYes": { "discover": true, "triage": true, "style": true } }' };
  const result = await hikyakuChecks(mac({ ...READY, files }));
  const yes = result.checks.find((check) => check.name === 'cloud yes');
  assert.deepEqual([yes.ok, yes.warn, yes.detail], [false, true, 'no yes yet, so Loggie finds no workspaces']);
  assert.match(yes.fix, /press Yes on the setup page \(Keys\) or on the card on Today/);
});

test('3 of 7 helpers built is a note that names the build command; a missing voice helper names its own', async () => {
  const result = await hikyakuChecks(mac({ ...READY, helpers: { voice: 'missing', native: 3 } }));
  const text = formatChecks(result);
  assert.match(text, /! helpers: 3 of 7 built; the rest build on first use into ~\/Library\/Application Support\/Loggie\/bin\n {4}note: run: npm run build:native/);
  assert.match(text, /! voice helper: .*\n {4}note: run: npm run build:voice/);
  assert.equal(failures(result), 0);
});

test('failures() counts no note, and the doctor follows LOGGIE_DATA_DIRECTORY', async () => {
  const checks = [{ name: 'a', ok: false, warn: true }, { name: 'b', ok: false }, { name: 'c', ok: true }];
  assert.equal(failures({ checks }), 1);
  const notes = await hikyakuChecks(mac({ ...READY, keys: { nebius: false, tavily: false }, helpers: { voice: 'missing', native: 0 } }));
  assert.ok(notes.checks.filter((check) => check.warn).length >= 4);
  assert.equal(failures(notes), 0);
  assert.equal(doctorHome({ LOGGIE_DATA_DIRECTORY: '/tmp/scratch-loggie' }), '/tmp/scratch-loggie/hikyaku');
  assert.match(doctorHome({}), /Library\/Application Support\/Loggie\/hikyaku$/);
});

test('each missing piece is its own failure with a fix, and nothing waits forever', async () => {
  const result = await hikyakuChecks(mac({ files: { [`${HOME}/settings.json`]: '{}' }, present: [MAIL_APP], exec: { osascript: 'false' } }));
  const failed = Object.fromEntries(result.checks.filter((check) => !check.ok && !check.warn).map((check) => [check.name, check]));
  // No Outlook on this Mac, so settings resolve to Apple Mail: Mail is there, and Accessibility is off for the paste.
  assert.deepEqual(Object.keys(failed).sort(), ['Accessibility', 'Xcode tools']);
  assert.equal(result.checks.find((check) => check.name === 'FileVault').warn, true, 'an unknown FileVault state is a note, not a failure');
  for (const check of Object.values(failed)) assert.ok(check.fix, `${check.name} has no fix`);
  assert.match(formatChecks(result), /2 thing\(s\) to fix before Loggie can write drafts\./);
  assert.match(result.checks.find((check) => check.name === 'workstreams.json').detail, /"Inbox"/);
});

test('a settings file that is not JSON is a failure, not a silent fall back to defaults', async () => {
  const result = await hikyakuChecks(mac({ ...READY, files: { ...READY.files, [`${HOME}/settings.json`]: '{ agent: claude' } }));
  const settings = result.checks.find((check) => check.name === 'settings.json');
  assert.equal(settings.ok, false);
  assert.match(settings.fix, /silently uses the defaults/);
});

test('a missing voice file is a note, not a failure: Do it still works', async () => {
  const result = await hikyakuChecks(mac({ ...READY, present: READY.present.filter((path) => !path.endsWith('intros.md')) }));
  const voice = result.checks.find((check) => check.name === 'voice');
  assert.equal(voice.warn, true);
  assert.equal(failures(result), 0);
  assert.match(formatChecks(result), /! voice: .*\n {4}note: /);
});

// 2026-10-28 (teammates' mail fix 2): a "gmail" saved before Gmail left the choices reads as Apple Mail, so its
// drafts open in Mail, and Accessibility is checked for the paste.
test('a saved "gmail" reads as Apple Mail: Mail is the mail app and Accessibility is checked for the paste', async () => {
  const result = await hikyakuChecks(mac({ ...READY, present: [...READY.present, MAIL_APP], files: { ...READY.files, [`${HOME}/settings.json`]: '{ "mailApp": "gmail" }' } }));
  const by = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.match(by['settings.json'].detail, /mail apple-mail$/);
  assert.deepEqual([by['mail app'].ok, by['mail app'].detail], [true, 'Mail']);
  assert.match(by.Accessibility.detail, /paste replies in Mail/);
  assert.equal(failures(result), 0);
});

test('an 8 GB Mac with no Outlook picks Apple Mail, and nothing about a model on this Mac', async () => {
  const result = await hikyakuChecks({ ...mac({ present: [MAIL_APP], exec: { 'xcode-select -p': '/Library/Developer/CommandLineTools' } }), memoryGB: 8 });
  const by = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.match(by['settings.json'].detail, /mail apple-mail \(chosen for this Mac\)$/);
  assert.doesNotMatch(by['settings.json'].detail, /agent/);
  assert.deepEqual([by['mail app'].ok, by['mail app'].detail], [true, 'Mail']);
  assert.equal(['NVIDIA model', 'Python 3.11+', 'local model'].some((name) => by[name]), false);
});

test('FileVault off is a failure with the fix, because stored mail text would be readable', async () => {
  const result = await hikyakuChecks(mac({ ...READY, exec: { ...READY.exec, 'fdesetup status': 'FileVault is Off.' } }));
  const vault = result.checks.find((check) => check.name === 'FileVault');
  assert.equal(vault.ok, false); assert.match(vault.fix, /turn it on/);
});

test('chats off is one quiet line; chats on checks Messages (Full Disk Access), WhatsApp, Accessibility, and names the window', async () => {
  const off = await hikyakuChecks(mac(READY));
  const chatsOff = off.checks.find((check) => check.name === 'chats');
  assert.match(chatsOff.detail, /^off: Loggie reads no texts/);
  assert.deepEqual([chatsOff.ok, chatsOff.warn], [false, true], 'off is a warning, not a pass (loggie-diagnostics)');
  assert.match(chatsOff.fix, /Settings, under Your Mac/);
  const on = { ...READY, files: { ...READY.files, [`${HOME}/settings.json`]: '{ "agent": "claude", "mailApp": "apple-mail", "chats": ["messages", "whatsapp"], "chatDays": 3 }' }, present: [...READY.present, MAIL_APP] };
  const denied = Object.assign(new Error('EPERM'), { code: 'EPERM' });
  const result = await hikyakuChecks({ ...mac({ ...on, present: [...on.present, '/Applications/WhatsApp.app'] }), openImpl: async () => { throw denied; } });
  const by = Object.fromEntries(result.checks.map((check) => [check.name, check]));
  assert.equal(by.Messages.ok, false); assert.match(by.Messages.detail, /Full Disk Access is off/); assert.match(by.Messages.fix, /Full Disk Access/);
  assert.equal(by.WhatsApp.ok, false); assert.match(by.WhatsApp.detail, /no chats stored yet/);
  assert.match(by['chat window'].detail, /^3 days \(settings.json chatDays\)$/);
  assert.equal(by.Accessibility.ok, true); assert.match(by.Accessibility.detail, /put drafts in chat windows/);
  const good = await hikyakuChecks({ ...mac({ ...on, present: [...on.present, '/Applications/WhatsApp.app', '/fake/user/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite'] }), openImpl: async () => {} });
  const ok = Object.fromEntries(good.checks.map((check) => [check.name, check]));
  assert.equal(ok.Messages.ok, true); assert.equal(ok.WhatsApp.ok, true); assert.equal(failures(good), 0);
  const bad = await hikyakuChecks(mac({ ...on, files: { ...on.files, [`${HOME}/settings.json`]: '{ "chats": ["telegram"] }' } }));
  assert.match(bad.checks.find((check) => check.name === 'chats').detail, /"telegram"/);
});

// workspaces-outlook W8, W13: every account in Apple Mail is named; no account at all is a failure with its fix.
test('every Apple Mail account is one line; iCloud and a left-out account say why; no account is the one failure', async () => {
  const mail = [...OUTLOOK_ONLY, { address: 'sam.doe@gmail.com', kind: 'google', inbox: 900, sent: 6, skipped: null },
    { address: '', kind: 'icloud', inbox: 0, sent: 1, skipped: 'icloud' }, { address: 'old@nyu.edu', kind: 'google', inbox: 3, sent: 0, skipped: 'settings' }];
  const result = await hikyakuChecks(mac({ ...READY, mail }));
  const line = (name) => result.checks.find((check) => check.name === name);
  assert.match(line('mail').detail, /^2 account\(s\) in Apple Mail read: sam@school\.edu, sam\.doe@gmail\.com$/);
  assert.match(line('mail sam.doe@gmail.com').detail, /^google: Inbox 900, Sent 6 in 30 days$/);
  assert.match(line('mail iCloud').detail, /not read/);
  assert.match(line('mail old@nyu.edu').detail, /skipAccounts/);
  assert.equal(failures(result), 0);

  const none = await hikyakuChecks(mac({ ...READY, mail: [] }));
  assert.equal(failures(none), 1);
  assert.match(none.checks.find((check) => check.name === 'mail').fix, /Internet Accounts/);
  const locked = await hikyakuChecks({ ...mac(READY), mailImpl: async () => { throw Object.assign(new Error('denied'), { pane: 'full-disk-access' }); } });
  assert.match(locked.checks.find((check) => check.name === 'mail').fix, /Full Disk Access/);
});

test('with replies in Apple Mail, the last try says whether Loggie may control Mail; the doctor never asks', async () => {
  const files = { ...READY.files, [`${HOME}/settings.json`]: '{ "agent": "claude", "mailApp": "apple-mail" }' };
  const fresh = await hikyakuChecks(mac({ ...READY, files }));
  assert.match(fresh.checks.find((check) => check.name === 'Mail replies').detail, /first one asks macOS/);
  const refused = await hikyakuChecks(mac({ ...READY, files: { ...files, [`${HOME}/apple-mail-reply.json`]: '{ "status": "not-trusted", "at": "2026-10-17T20:00:00Z" }' } }));
  const row = refused.checks.find((check) => check.name === 'Mail replies');
  assert.deepEqual([row.ok, /Automation/.test(row.fix)], [false, true]);
});
