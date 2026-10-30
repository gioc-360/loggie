// One set of reads for the setup page and `npm run doctor` (teammate-ready B4), so the screen and the terminal say the
// same thing about this Mac. Every reader is injected for tests. Nothing here asks macOS for a permission, opens a
// pane, or reads a secret: a key is only ever asked whether it exists (cloud-key.js keyStatus).
// saveSetup is the one write: the setup keys in settings.json, every other key left as it was (B5.1).
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { keyStatus } from './cloud-key.js';
import { HIKYAKU_HOME, mailAppOf } from './draft.js';
import { isPackaged } from './native-helper.js';
import { permissionStatus } from './permissions.js';
import { accountCounts } from './sent-mail.js';
import { KEYCHAIN as TAVILY_KEYCHAIN } from './tavily.js';

const run = promisify(execFile);
const TIMEOUT_MS = 3000;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);
const execDefault = (file, args) => run(file, args, { timeout: TIMEOUT_MS, encoding: 'utf8' });

// What dist-native/bin holds after `npm run build:native`; any one missing builds on first use instead (native-helper.js).
export const NATIVE_HELPERS = Object.freeze(['hikyaku-calendar', 'hikyaku-extract', 'hikyaku-chats', 'hikyaku-outlook', 'hikyaku-outlook-event', 'hikyaku-mic', 'hikyaku-outlook-move']);
export const VOICE_HELPER = 'loggie-voice';
export const MAIL_APP_IDS = Object.freeze(['outlook', 'apple-mail']);
const STATES = ['granted', 'denied', 'unknown'];
const PERMISSION_NAMES = ['calendar', 'fullDisk', 'microphone', 'screen', 'accessibility'];
const NO_READ = 'settings.json could not be read.';

// settings.json as written, with no defaults (readSettings guesses mailApp, draft.js:138). Missing -> {}.
export async function readRawSettings(home = HIKYAKU_HOME, { readImpl = readFile } = {}) {
  let text;
  try { text = await readImpl(join(home, 'settings.json'), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(NO_READ);
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(NO_READ); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(NO_READ);
  return value;
}

// Whether each key is in the keychain: Nebius (or NEBIUS_API_KEY in the environment) and Tavily. Never the key itself.
export async function keyState({ execFileImpl = execFile, env = process.env } = {}) {
  const nebius = Boolean(env.NEBIUS_API_KEY) || (await keyStatus({ execFileImpl })).saved;
  const tavily = (await keyStatus({ execFileImpl, keychain: TAVILY_KEYCHAIN })).saved;
  return { nebius, tavily };
}

// The cloud yes: `ai` is the one Yes for sorting mail, finding workspaces, ordering them and learning the style
// (cloud-screen.js grantCloudYes sets all four); `chats` is the chats' own yes.
export function yesState(raw = {}) {
  const yes = raw?.cloudYes || {};
  return { ai: ['discover', 'triage', 'style', 'rank'].every((path) => yes[path] === true), chats: raw?.chatsCloud === 'nebius' };
}

// Apple Mail's accounts (sent-mail.js accountCounts, headers only). Counted: not skipped, with an Inbox or a Sent
// folder. A read that fails is 0 accounts with its reason: 'full-disk' when macOS refused the store, else its message.
// `kinds` (2026-10-28, fix 1) is the Disk step's live line: per kind in Internet Accounts (exchange, google, icloud,
// imap), how many accounts and the newest Inbox mail, so a teammate sees her mail arrive before Continue. An account
// settings.json leaves out is not listed; iCloud is listed but never read (sent-mail.js mailAccounts).
export const MAIL_KINDS = Object.freeze(['exchange', 'google', 'icloud', 'imap']);
export function mailKinds(list = []) {
  return MAIL_KINDS.map((kind) => {
    const of = list.filter((account) => account.kind === kind && account.skipped !== 'settings');
    const newest = of.map((account) => account.newest).filter(Boolean).sort().at(-1) || null;
    return { kind, accounts: of.length, newest, read: kind !== 'icloud' };
  }).filter((row) => row.accounts > 0);
}
export async function mailState({ userHome = homedir(), skip = [], mailImpl = (options) => accountCounts({ home: userHome, ...options }) } = {}) {
  try {
    const list = await mailImpl({ skip });
    const counted = list.filter((account) => !account.skipped && (account.inbox !== null || account.sent !== null));
    return { accounts: counted.length, addresses: counted.map((account) => account.address), kinds: mailKinds(list), list, error: null };
  } catch (error) {
    return { accounts: 0, addresses: [], kinds: [], list: [], error: error?.pane === 'full-disk-access' ? 'full-disk' : String(error?.message || error) };
  }
}

export async function fileVaultState({ execImpl = execDefault } = {}) {
  try {
    const { stdout } = await execImpl('fdesetup', ['status']);
    if (/FileVault is On/i.test(stdout)) return 'on';
    if (/FileVault is Off/i.test(stdout)) return 'off';
    return 'unknown';
  } catch { return 'unknown'; }
}

export async function xcodeState({ execImpl = execDefault } = {}) {
  try {
    const { stdout } = await execImpl('xcode-select', ['-p']);
    return { ok: true, path: String(stdout).trim() };
  } catch { return { ok: false, path: null }; }
}

// Python for call notes (first-run-polish B5.1): call.py runs python3 without -I, so numpy from `python3 -m pip install
// numpy` (the user site folder) counts. No python3 at all is not ok; one that cannot import numpy, or does not answer
// within the 3 s timeout, is ok without numpy.
export async function pythonState({ execImpl = execDefault, python = 'python3' } = {}) {
  try {
    await execImpl(python, ['-c', 'import numpy']);
    return { ok: true, numpy: true };
  } catch (error) {
    return error?.code === 'ENOENT' ? { ok: false, numpy: false } : { ok: true, numpy: false };
  }
}

// Whether this Mac downloads the NVIDIA speech models (B5.1): always when packaged or HIKYAKU_SPEECH_DOWNLOAD=1, else
// only after the Calls step's switch saved speechModels true. Absent never downloads, so an existing install is unchanged.
export const speechWantedOf = ({ packaged = false, env = {}, raw = {} } = {}) => Boolean(packaged) || env?.HIKYAKU_SPEECH_DOWNLOAD === '1' || raw?.speechModels === true;

// The prebuilt helpers in dist-native/bin (scripts/build-native.sh): the voice helper, and how many of the seven others.
export async function helperState({ root = join(PROJECT_ROOT, 'dist-native', 'bin'), existsImpl = exists } = {}) {
  const found = await Promise.all(NATIVE_HELPERS.map((name) => existsImpl(join(root, name))));
  return { voice: (await existsImpl(join(root, VOICE_HELPER))) ? 'built' : 'missing', native: found.filter(Boolean).length };
}

// The app macOS lists in Privacy & Security: Loggie itself when packaged, else the terminal it was started from.
const HOSTS = Object.freeze({ Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', vscode: 'Visual Studio Code', WarpTerminal: 'Warp' });
export const hostAppOf = ({ packaged = isPackaged(), env = process.env } = {}) => (packaged ? 'Loggie' : HOSTS[env.TERM_PROGRAM] || 'the app you started Loggie from');

// The first word of the Mac user's full name (`id -F`), at most 40 characters, or ''.
export const firstNameOf = (fullName) => String(fullName || '').trim().split(/\s+/)[0].slice(0, 40);

const stateOf = (value) => (STATES.includes(value) ? value : 'unknown');

// The setup page's whole picture (B4, SetupStatus). `part: 'permissions'` gives only { permissions, mail }, for the
// page's 1 s poll. `model` is setup-model.js ({ STEPS, isSetupDone }); main passes nothing and it is read from there.
export async function setupStatus({
  home = HIKYAKU_HOME,
  userHome = homedir(),
  env = process.env,
  packaged = isPackaged(),
  part = null,
  model = null,
  readImpl = readFile,
  existsImpl = exists,
  execImpl = execDefault,
  execFileImpl = execFile,
  mailImpl,
  helperRoot,
  // { calendar, fullDisk, microphone, screen, accessibility }; main passes readPermissionStatus plus calendarStatus.
  permissionsImpl = () => permissionStatus({ home: userHome }),
  speechImpl = null,
  // The Python call.py runs with (main passes transcriberRuntime().python: python3 from source, the bundled one packaged).
  python = 'python3',
} = {}) {
  const raw = await readRawSettings(home, { readImpl });
  const setup = raw.setup && typeof raw.setup === 'object' ? raw.setup : {};
  const read = await permissionsImpl().catch(() => ({}));
  const permissions = Object.fromEntries(PERMISSION_NAMES.map((name) => [name, stateOf(read?.[name])]));
  permissions.automation = stateOf(setup.automation);
  const { list, ...mail } = await mailState({ userHome, skip: raw.skipAccounts || [], ...(mailImpl ? { mailImpl } : {}) });
  if (part === 'permissions') return { permissions, mail };

  const { STEPS, isSetupDone } = model || await import('../../desktop/renderer/setup-model.js');
  const fullName = await execImpl('id', ['-F']).then(({ stdout }) => stdout, () => '');
  const helpers = await helperState({ existsImpl, ...(helperRoot ? { root: helperRoot } : {}) });
  const speech = await (speechImpl || (() => speechDefault({ packaged, env, raw })))().catch(() => ({ wanted: false, ready: false }));
  const bytes = await speechBytes();
  const pythonRead = await pythonState({ execImpl, python });
  return {
    done: isSetupDone(raw),
    step: STEPS.includes(setup.step) ? setup.step : null,
    startedAt: setup.startedAt || null,
    readyAt: setup.readyAt || null,
    signName: typeof raw.signName === 'string' ? raw.signName : '',
    suggestedName: firstNameOf(fullName),
    mailApp: MAIL_APP_IDS.includes(mailAppOf(raw.mailApp)) ? mailAppOf(raw.mailApp) : null,
    chats: Array.isArray(raw.chats) && raw.chats.length > 0,
    installed: { outlook: await existsImpl('/Applications/Microsoft Outlook.app'), whatsapp: await existsImpl('/Applications/WhatsApp.app') },
    hostApp: hostAppOf({ packaged, env }),
    permissions,
    mail,
    keys: await keyState({ execFileImpl, env }),
    yes: yesState(raw),
    voice: { answer: setup.voice || null, helper: helpers.voice },
    // How many of the native helpers are built (Settings, Your Mac: loggie-diagnostics).
    helpers: { native: helpers.native, of: NATIVE_HELPERS.length },
    // always: packaged or the env; chosen: the Calls step's switch as saved, null before it (B5.1).
    speech: {
      wanted: Boolean(speech?.wanted), ready: Boolean(speech?.ready), always: Boolean(packaged) || env.HIKYAKU_SPEECH_DOWNLOAD === '1',
      chosen: typeof raw.speechModels === 'boolean' ? raw.speechModels : null, bytes,
    },
    python: { ...pythonRead, packaged: Boolean(packaged) },
    fileVault: await fileVaultState({ execImpl }),
    // No workstreams.json yet: Ready's button says Find my workspaces (first-run-polish B4.7). `found` is the Found
    // step's state, saved only by a first Done (pending) and by its Keep or Later.
    firstRun: !(await existsImpl(join(home, 'workstreams.json'))),
    found: ['pending', 'done', 'later'].includes(setup.found) ? setup.found : null,
  };
}

// As main.js: speech is wanted when speechWantedOf says so, and ready when its files are all there.
async function speechDefault({ packaged, env, raw }) {
  const wanted = speechWantedOf({ packaged, env, raw });
  if (!wanted) return { wanted, ready: false };
  const { readManifest, speechStatus } = await import('./speech-download.js');
  return { wanted, ready: (await speechStatus({ manifest: await readManifest() })).ready };
}

// The whole download's size: the sum of the manifest's sizes (1,460,555,318 bytes today), 0 when it cannot be read.
async function speechBytes() {
  try {
    const { readManifest } = await import('./speech-download.js');
    return (await readManifest()).items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  } catch { return 0; }
}

// The one write (B5.1). `patch` has been checked by validateSetupSave; done takes only true. `whatsapp` says whether
// WhatsApp.app is installed, for what chats on means. `first`: Done was pressed on a Mac with no workstreams.json, so
// the Found step opens (setup.found 'pending'); `found` ('done' or 'later') comes from main only (found.js keepFound).
// doneAt is written once, so it stays the start of this setup's found cards.
export async function saveSetup(home, patch = {}, { now = new Date(), whatsapp = false, first = false, readImpl = readFile, writeImpl = writeFile } = {}) {
  if ('done' in patch && patch.done !== true) throw new Error('That setup choice is not one Loggie offers.');
  const raw = await readRawSettings(home, { readImpl });
  const at = now.toISOString();
  const setup = raw.setup && typeof raw.setup === 'object' ? { ...raw.setup } : {};
  // Read before this patch lands, so a fresh Mac's Welcome (which saves the name) never counts as an old install.
  const before = !raw.setup && (Boolean(raw.signName || raw.mailApp || raw.cloudYes) || await exists(join(home, 'workstreams.json')));
  if ('signName' in patch) {
    const name = String(patch.signName).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name) raw.signName = name; else delete raw.signName;
  }
  if ('mailApp' in patch) raw.mailApp = patch.mailApp;
  if ('chats' in patch) raw.chats = patch.chats ? (whatsapp ? ['messages', 'whatsapp'] : ['messages']) : [];
  const step = patch.done === true ? 'ready' : patch.step;
  if (step) {
    setup.step = step;
    if (step !== 'welcome') setup.startedAt ||= at;
    if (step === 'ready') setup.readyAt ||= at;
  }
  if ('voice' in patch) setup.voice = patch.voice;
  if ('automation' in patch) setup.automation = patch.automation;
  // The Calls step's speech switch (first-run-polish B5.1), top level: main reads it at launch to start the download.
  if ('speechModels' in patch) raw.speechModels = patch.speechModels === true;
  if (patch.done === true) {
    setup.done = true;
    setup.doneAt ||= at;
    if (first && !setup.found) setup.found = 'pending';
  }
  if ('found' in patch) {
    if (!['pending', 'done', 'later'].includes(patch.found)) throw new Error('That setup choice is not one Loggie offers.');
    setup.found = patch.found;
  }
  // Only a setup step writes the setup record; a save from Settings (the chats switch, loggie-diagnostics) creates none.
  const stepPatch = ['step', 'done', 'voice', 'automation', 'found'].some((key) => key in patch);
  // The first record on an install from before setup (a step of its one setup, or a macOS answer from Settings) says so,
  // so its background keeps running while setup is open (setup-model.js backgroundRuns). Only Done marks it done
  // (2026-10-28: the answer from Settings used to mark it done, and Jess never saw setup).
  if (before && stepPatch) setup.existing = true;
  if (raw.setup || stepPatch) raw.setup = setup;
  await mkdir(home, { recursive: true });
  await writeImpl(join(home, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return { setup, signName: raw.signName || '', mailApp: raw.mailApp || null, chats: raw.chats || [] };
}
