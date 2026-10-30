// `loggie doctor` for hikyaku: checks every outside system `npm run desktop` depends on before Loggie writes drafts,
// so a missing piece shows up as one line with its fix instead of a card that never finishes. Each check gets
// a short timeout and never changes anything: no permission prompts, no model calls, no mail opened. The reads are
// setup-status.js's, the same ones the setup page shows, so the two never disagree. Before the first open (no hikyaku
// folder yet) every Mac check still runs; only the checks of hikyaku's own files wait (teammate-ready C7).
import { execFile } from 'node:child_process';
import { access, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { HIKYAKU_HOME, MAIL_APPS, resolveSettings } from './draft.js';
import { accountCounts, mailStore } from './sent-mail.js';
import { NATIVE_HELPERS, fileVaultState, helperState, hostAppOf, keyState, mailState, pythonState, xcodeState, yesState } from './setup-status.js';

const OUTLOOK_APP = '/Applications/Microsoft Outlook.app';

const run = promisify(execFile);
const TIMEOUT_MS = 3000;
const GB = 1024 ** 3;
import { CHAT_APPS, chatWindowFor } from './chats.js';

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);

async function readJson(path, readImpl) {
  let text;
  try { text = await readImpl(path, 'utf8'); } catch { return { missing: true }; }
  try { return { value: JSON.parse(text) }; } catch (error) { return { error: error.message }; }
}

// The hikyaku folder the app uses: LOGGIE_DATA_DIRECTORY/hikyaku when that is set (main.js:83), else the usual one.
export const doctorHome = (env = process.env) => (env.LOGGIE_DATA_DIRECTORY ? join(env.LOGGIE_DATA_DIRECTORY, 'hikyaku') : HIKYAKU_HOME);

export async function hikyakuChecks({
  env = process.env,
  home = doctorHome(env),
  readImpl = readFile,
  existsImpl = exists,
  execImpl = (file, args) => run(file, args, { timeout: TIMEOUT_MS, encoding: 'utf8' }),
  // Opens a file for reading and closes it: what tells Full Disk Access apart from a file that merely exists.
  openImpl = (path) => open(path, 'r').then((handle) => handle.close()),
  memoryGB = totalmem() / GB,
  userHome = homedir(),
  // Every Apple Mail account with its counts (sent-mail.js accountCounts); headers only, nothing opened or changed.
  mailImpl = (options) => accountCounts({ home: userHome, ...options }),
  // Whether the Nebius and Tavily keys are in the keychain (setup-status.js keyState); never the keys.
  keysImpl = () => keyState({ env }),
  // The prebuilt helpers in dist-native/bin (setup-status.js helperState).
  helpersImpl = () => helperState(),
  // Whether python3 imports numpy, which recorded calls need for their notes (setup-status.js pythonState, B5.2).
  pythonImpl = () => pythonState({ execImpl }),
  // Apple Mail's store folder (sent-mail.js mailStore): the newest V<n> with an Envelope Index.
  storeImpl = (options) => mailStore(options),
} = {}) {
  const checks = [];
  const add = (name, ok, detail, fix = '', warn = false) => checks.push({ name, ok, detail, fix, ...(warn ? { warn } : {}) });

  const configured = await existsImpl(home);
  if (!configured) add('Loggie', true, 'not set up on this Mac yet: npm run desktop opens the setup page');

  const settingsFile = configured ? await readJson(join(home, 'settings.json'), readImpl) : { missing: true };
  const raw = settingsFile.value && typeof settingsFile.value === 'object' && !Array.isArray(settingsFile.value) ? settingsFile.value : {};
  const settings = await resolveSettings(raw, { appExists: existsImpl, fullName: async () => String((await execImpl('id', ['-F']))?.stdout || '') });
  const auto = (key) => (settings.chosen.includes(key) ? ' (chosen for this Mac)' : '');
  if (configured) {
    if (settingsFile.error) add('settings.json', false, `cannot be read: ${settingsFile.error}`, `fix the JSON in ${join(home, 'settings.json')}; until then hikyaku silently uses the defaults`);
    else add('settings.json', true, `${settingsFile.missing ? 'not there, defaults fit this Mac' : 'readable'}: mail ${settings.mailApp}${auto('mailApp')}`);

    const workstreams = await readJson(join(home, 'workstreams.json'), readImpl);
    // No file yet is the first run, not a fault: Loggie looks a month back for workspaces and writes it (W3, W8).
    if (workstreams.missing) add('workstreams.json', true, 'none yet: everything in your inbox is one workspace, "Inbox", and Loggie looks through the last 30 days of your mail for workspaces after setup is done');
    else if (workstreams.error) add('workstreams.json', false, `cannot be read: ${workstreams.error}`, `fix the JSON in ${join(home, 'workstreams.json')}`);
    else if (!Array.isArray(workstreams.value) || !workstreams.value.length) add('workstreams.json', false, 'has no workspaces yet', 'Loggie finds them from your mail after setup', true);
    else add('workstreams.json', true, `${workstreams.value.length} workstream(s)`);
  }

  // Where mail comes from (workspaces-outlook W8, W13): every account in Apple Mail, one line each; without any account
  // here, no workspace can be found.
  const mail = await mailState({ userHome, skip: settings.skipAccounts || [], mailImpl });
  if (!mail.error) {
    add('mail', mail.accounts > 0, mail.accounts ? `${mail.accounts} account(s) in Apple Mail read: ${mail.addresses.join(', ')}` : 'no mail account in Apple Mail, so Loggie finds no workspaces',
      mail.accounts ? '' : 'System Settings > Internet Accounts: add your account as Microsoft Exchange (Outlook, school, work) or Google (Gmail), turn on Mail, then open Mail once');
    for (const account of mail.list) {
      const name = `mail ${account.address || 'iCloud'}`;
      if (account.skipped === 'icloud') add(name, true, 'iCloud: not read (its address is not known from Internet Accounts)');
      else if (account.skipped === 'settings') add(name, true, `${account.kind}: not read, settings.json "skipAccounts" leaves it out`);
      else if (account.inbox === null && account.sent === null) add(name, false, `${account.kind}: no Inbox or Sent folder yet`, 'open Mail and let it finish syncing', true);
      else add(name, true, `${account.kind}: Inbox ${account.inbox ?? 'none'}, Sent ${account.sent ?? 'none yet'} in 30 days`);
    }
  } else {
    const disk = mail.error === 'full-disk';
    add('mail', false, disk ? 'Apple Mail cannot be read: Full Disk Access is off for this app' : `Apple Mail could not be read: ${mail.error}`,
      disk ? 'System Settings > Privacy & Security > Full Disk Access: switch on the app you run Loggie from' : 'open Mail once and add your account in System Settings > Internet Accounts');
  }

  // What a teammate pastes back when her mail does not arrive (2026-10-28, teammates' mail fix 6): which Mail store this
  // Mac writes (the readers open the newest V<n>), which Outlook is installed and whether it is the new one (Loggie
  // never reads Outlook; its drafts helper drives the new one), and which app needs Full Disk Access here. Versions and
  // one open of the store's index, nothing more.
  const store = await storeImpl({ home: userHome });
  const disk = await openImpl(store.index).then(() => 'on', (error) => (['EPERM', 'EACCES'].includes(error?.code) ? 'off' : 'unknown'));
  const host = hostAppOf({ packaged: false, env });
  if (store.version) add('Mail store', true, `${store.version} (~/Library/Mail/${store.version}/MailData/Envelope Index)`);
  else add('Mail store', false, disk === 'off' ? `cannot be listed: Full Disk Access is off for ${host}` : 'none under ~/Library/Mail: Apple Mail has not been opened on this Mac', disk === 'off' ? '' : 'open Mail once and let it finish syncing', true);
  if (await existsImpl(OUTLOOK_APP)) {
    const read = (args) => execImpl('defaults', ['read', ...args]).then(({ stdout }) => String(stdout).trim(), () => '');
    const version = await read([`${OUTLOOK_APP}/Contents/Info`, 'CFBundleShortVersionString']);
    const fresh = await read(['com.microsoft.Outlook', 'IsRunningNewOutlook']);
    const which = fresh === '1' ? 'the new Outlook' : fresh === '0' ? 'legacy Outlook' : 'new or legacy not recorded yet';
    add('Outlook', true, `${version || 'version unknown'}, ${which}`);
  } else add('Outlook', true, 'not installed');
  if (disk === 'on') add('Full Disk Access', true, `on for ${host}`);
  else add('Full Disk Access', false, disk === 'off' ? `off for ${host}` : `not known for ${host} (no Mail store to open)`, `System Settings > Privacy & Security > Full Disk Access: switch on ${host}`, disk !== 'off');

  const mailApp = settings.mailApp;
  if (!(mailApp in MAIL_APPS)) add('mail app', false, `"${mailApp}" is not one hikyaku knows`, 'set "mailApp" to outlook or apple-mail in settings.json');
  else {
    const app = `/Applications/${MAIL_APPS[mailApp]}.app`;
    const found = mailApp === 'apple-mail' ? await existsImpl('/System/Applications/Mail.app') : await existsImpl(app);
    add('mail app', found, found ? MAIL_APPS[mailApp] : `${MAIL_APPS[mailApp]} is not in /Applications`, found ? '' : `install it, or set "mailApp" in settings.json`);
  }

  const xcode = await xcodeState({ execImpl });
  if (xcode.ok) add('Xcode tools', true, `${xcode.path} (builds the calendar and Outlook helpers)`);
  else add('Xcode tools', false, 'missing, so the calendar and Outlook helpers cannot be built', 'run: xcode-select --install');

  // Chats (Messages, WhatsApp): off until settings.json names them. On: Messages' database must open (Full Disk
  // Access), WhatsApp must be installed with a store, and the window hikyaku reads back is said out loud.
  const chatApps = Array.isArray(settings.chats) ? settings.chats : [];
  const badApps = chatApps.filter((app) => !CHAT_APPS.includes(app));
  if (badApps.length) add('chats', false, `settings.json "chats" names ${badApps.map((app) => `"${app}"`).join(', ')}`, `use only ${CHAT_APPS.join(' and ')}`);
  // Off is a warning, not a pass (loggie-diagnostics: "off" with a check mark hid why "message leah" found no one).
  else if (!chatApps.length) add('chats', false, 'off: Loggie reads no texts, so it cannot find anyone to text', 'turn chats on in Settings, under Your Mac', true);
  else {
    if (chatApps.includes('messages')) {
      try { await openImpl(join(userHome, 'Library', 'Messages', 'chat.db')); add('Messages', true, 'chat database readable (Full Disk Access is on)'); }
      catch (error) {
        add('Messages', false, error.code === 'ENOENT' ? 'has no chat database on this Mac' : 'chat database cannot be opened: Full Disk Access is off for this app',
          error.code === 'ENOENT' ? 'open Messages once and sign in' : 'System Settings > Privacy & Security > Full Disk Access: switch on the app you run Loggie from');
      }
    }
    if (chatApps.includes('whatsapp')) {
      const installed = await existsImpl('/Applications/WhatsApp.app');
      const store = installed && await existsImpl(join(userHome, 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite'));
      add('WhatsApp', Boolean(store), !installed ? 'not in /Applications' : store ? 'installed, chats stored on this Mac' : 'installed, but no chats stored yet', !installed ? 'install WhatsApp Desktop and sign in, or take whatsapp out of "chats"' : store ? '' : 'open WhatsApp once so it syncs your chats');
    }
    add('chat window', true, chatWindowFor(memoryGB, { chatDays: settings.chatDays ?? null }).reason);
    // A group waits on the user when someone names them; without the name only questions and @-mentions count.
    if (!String(settings.signName || '').trim()) add('your name', false, 'settings.json "signName" is empty and this Mac\'s account has no name, so drafts end with no name and a group chat that names you is not seen as waiting on you', 'set "signName" to your first name in settings.json', true);
  }

  if (['outlook', 'apple-mail'].includes(mailApp) || chatApps.length) {
    const needs = [mailApp === 'outlook' ? 'open replies in Outlook' : mailApp === 'apple-mail' ? 'paste replies in Mail' : '', chatApps.length ? 'put drafts in chat windows' : ''].filter(Boolean).join(' and ');
    try {
      const { stdout } = await execImpl('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted()"]);
      const trusted = stdout.trim() === 'true';
      add('Accessibility', trusted, trusted ? `this terminal may ${needs}` : `this terminal may not control other apps yet, so it cannot ${needs}`, trusted ? '' : 'System Settings > Privacy & Security > Accessibility: switch on the terminal you start Loggie from');
    } catch {
      add('Accessibility', false, 'could not be checked', 'System Settings > Privacy & Security > Accessibility: switch on your terminal');
    }
  }

  // A reply placed in Apple Mail needs macOS to let Loggie control Mail; the doctor never asks, it reads the last try
  // (apple-mail-reply.js writes apple-mail-reply.json).
  if (mailApp === 'apple-mail') {
    const last = configured ? await readJson(join(home, 'apple-mail-reply.json'), readImpl) : { missing: true };
    if (last.value?.status === 'not-trusted') add('Mail replies', false, 'macOS has not let Loggie control Mail, so replies open as a clipboard paste', 'System Settings > Privacy & Security > Automation: under the app you run Loggie from, switch on Mail');
    else add('Mail replies', true, last.value?.status ? `last reply: ${last.value.status} (${String(last.value.at || '').slice(0, 10)})` : 'no reply placed in Mail yet; the first one asks macOS to let Loggie control Mail');
  }

  // Mail text sits in hikyaku's folder in the clear; FileVault is what protects it at rest (docs/hikyaku-security.md, rule 6).
  const vault = await fileVaultState({ execImpl });
  if (vault === 'unknown') add('FileVault', false, 'could not be checked', 'System Settings > Privacy & Security > FileVault: make sure it is on', true);
  else add('FileVault', vault === 'on', vault === 'on' ? 'on: stored mail text is encrypted at rest' : 'off: stored mail text is readable by anyone with the disk', vault === 'on' ? '' : 'System Settings > Privacy & Security > FileVault: turn it on');

  // What the setup page turns on: each missing one is a note (!), never a failure, so a fresh clone exits 0.
  const keys = await keysImpl();
  const keyNote = 'paste it on the setup page (Keys) or in Settings, Cloud analysis';
  if (keys.nebius) add('cloud key', true, env.NEBIUS_API_KEY ? 'Nebius key set in NEBIUS_API_KEY' : 'Nebius key saved in the keychain');
  else add('cloud key', false, 'no Nebius key yet, so Loggie cannot write notes or replies', keyNote, true);
  if (keys.tavily) add('Tavily key', true, 'saved');
  else add('Tavily key', false, 'no Tavily key yet, so names from calls are not checked on the web', keyNote, true);
  if (yesState(raw).ai) add('cloud yes', true, 'yes for sorting mail, finding workspaces, ordering them and learning how you write');
  else add('cloud yes', false, 'no yes yet, so Loggie finds no workspaces', 'press Yes on the setup page (Keys) or on the card on Today', true);
  const helpers = await helpersImpl();
  const all = NATIVE_HELPERS.length;
  if (helpers.native === all) add('helpers', true, `${all} of ${all} built`);
  else add('helpers', false, `${helpers.native} of ${all} built; the rest build on first use into ~/Library/Application Support/Loggie/bin`, 'run: npm run build:native', true);
  if (helpers.voice === 'built') add('voice helper', true, 'built (voice typing)');
  else add('voice helper', false, 'not built yet, so voice typing cannot start', 'run: npm run build:voice', true);
  // Not a file check, so it prints before the first open too; never a failure (the doctor runs from source only).
  const python = await pythonImpl();
  if (python.numpy) add('python', true, 'python3 with numpy (call notes)');
  else if (python.ok) add('python', false, 'python3 has no numpy, so recorded calls get no notes', 'run: python3 -m pip install numpy', true);
  else add('python', false, 'no python3, so recorded calls get no notes', 'run: xcode-select --install', true);

  if (configured) {
    const intros = await existsImpl(join(home, 'voice', 'intros.md'));
    if (intros) add('voice', true, 'voice/intros.md found');
    else add('voice', false, 'no voice/intros.md yet, so drafts start in a generic voice', 'nothing waits on it; Loggie builds it from your sent mail in Apple Mail the next time it starts', true);
  }

  return { configured, checks };
}

export const failures = ({ checks }) => checks.filter((check) => !check.ok && !check.warn).length;

export function formatChecks({ configured, checks }) {
  const lines = [];
  for (const check of checks) {
    lines.push(`${check.ok ? '✓' : check.warn ? '!' : '✗'} ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) lines.push(`    ${check.warn ? 'note' : 'fix'}: ${check.fix}`);
  }
  const failed = failures({ checks });
  if (failed) lines.push(`${failed} thing(s) to fix before Loggie can write drafts.`);
  else if (configured) lines.push('Ready: Loggie can write drafts on this Mac.');
  return lines.join('\n');
}
