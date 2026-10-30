// Teammates' mail fixes 2 and 5 (2026-10-28): one question, two tiles (Outlook, Apple Mail), with the line that mail is
// read through Apple Mail; a "gmail" saved before still loads, as Apple Mail; and the Gmail sign-in is gone, with every
// door to it. Source scans and fakes only.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EMAIL_LINE, EMAIL_QUESTION, MAIL_APP_TILES, macRows, SETUP_ASKS } from '../desktop/renderer/setup-model.js';
import { validateSetupAsk, validateSetupSave } from '../desktop/ipc-validation.js';
import { MAIL_APPS, resolveSettings } from '../src/hikyaku/draft.js';
import { setupStatus } from '../src/hikyaku/setup-status.js';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const gone = (path) => access(new URL(`../${path}`, import.meta.url)).then(() => false, () => true);

test('the Email step asks one question with two tiles, and says the mail is read through Apple Mail', async () => {
  assert.equal(EMAIL_QUESTION, 'Where do you write email?');
  assert.match(EMAIL_LINE, /^Loggie reads your mail through Apple Mail/);
  assert.deepEqual(MAIL_APP_TILES.map(([id]) => id), ['outlook', 'apple-mail']);
  const setup = await source('desktop/renderer/setup.js');
  assert.match(setup, /head\(card, EMAIL_QUESTION, EMAIL_LINE\)/);
  assert.match(setup, /for \(const \[id, label\] of MAIL_APP_TILES\)/);
  assert.doesNotMatch(setup, /gmail/i, 'no Gmail tile, mark or sign-in on the setup page');
  const change = macRows({ mailApp: 'apple-mail', mail: { accounts: 1 }, permissions: {}, installed: { outlook: true } }).find((row) => row.key === 'mailApp').change;
  assert.deepEqual(change.choices.map((choice) => choice.id), ['outlook', 'apple-mail'], 'Settings offers the same two');
});

test('a saved "gmail" still loads, as Apple Mail: drafts open in Mail, and setup does not ask again', async () => {
  const settings = await resolveSettings({ mailApp: 'gmail' }, { appExists: async () => true, fullName: async () => '' });
  assert.equal(settings.mailApp, 'apple-mail');
  assert.equal(settings.chosen.includes('mailApp'), false, 'what was saved is read, not guessed');
  const home = await mkdtemp(join(tmpdir(), 'loggie-gmail-'));
  try {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'gmail', setup: { done: true } }));
    const status = await setupStatus({ home, part: null, model: { STEPS: ['welcome'], isSetupDone: (raw) => raw?.setup?.done === true }, readImpl: readFile,
      existsImpl: async () => false, execImpl: async () => ({ stdout: '' }), execFileImpl: (file, args, options, done) => (done || options)(new Error('none')),
      mailImpl: async () => [], permissionsImpl: async () => ({}), speechImpl: async () => ({ wanted: false, ready: false }) });
    assert.deepEqual([status.mailApp, status.done], ['apple-mail', true]);
  } finally { await rm(home, { recursive: true, force: true }); }
  assert.deepEqual(Object.keys(MAIL_APPS), ['outlook', 'apple-mail']);
  assert.throws(() => validateSetupSave({ mailApp: 'gmail' }), /not one Loggie offers/);
});

test('the Gmail sign-in is gone: no client, no doors, no Settings section, no setup ask', async () => {
  for (const path of ['src/integrations/gmail/client.js', 'src/integrations/gmail/oauth.js', 'src/integrations/gmail/service.js', 'src/integrations/gmail/config.js',
    'src/integrations/gmail/query-parser.js', 'src/hikyaku/gmail-draft.js', 'src/security/credential-store.js']) assert.ok(await gone(path), `${path} is gone`);
  assert.equal(SETUP_ASKS.includes('gmail'), false);
  assert.throws(() => validateSetupAsk('gmail'));
  for (const path of ['desktop/preload.cjs', 'desktop/main-ipc-app.js', 'desktop/main-ipc-setup.js', 'desktop/main-state.js', 'desktop/main.js', 'desktop/main-helpers.js',
    'desktop/main-catch-up.js', 'desktop/main-background.js', 'desktop/main-ask.js', 'desktop/renderer/panel.js', 'desktop/renderer/panel.html']) {
    const text = await source(path);
    assert.doesNotMatch(text, /gmail:(status|connect|cancel-connect|disconnect)|gmailService|gmailClient|connectGmail|accountSection|google-oauth/, `${path} has no Gmail sign-in`);
  }
  assert.doesNotMatch(await source('.env.example'), /Gmail|google-oauth/);
  assert.doesNotMatch(await source('README.md'), /OAuth|gmail\.readonly|Gmail setup/);
});
