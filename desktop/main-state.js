// What every main-*.js module shares: the first side effects, paths, the clients, the setup guards and the IPC wrapper.
// Moved out of main.js in debt-cleanup 6.6; it imports no sibling, so it runs first.
import { app, ipcMain, systemPreferences } from 'electron';
import dotenv from 'dotenv';
import { recordingPermissionGuard } from './recording-permissions.js';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createAppIcons } from './app-icons.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedRendererUrl } from './ipc-validation.js';
import { emitEvent } from '../src/hikyaku/events.js';
import { createSetupGuard, permissionStatus } from '../src/hikyaku/permissions.js';
import { newRunId, runsRoot, transcriberRuntime } from '../src/hikyaku/send-gate.js';
import { updateWorkstreams } from '../src/hikyaku/workstreams.js';

export let folderAccess;
export let voiceInput;

export const desktopDirectory = dirname(fileURLToPath(import.meta.url));
export const projectDirectory = dirname(desktopDirectory);
export const positionFileName = 'window-state.json';
export const shortcut = 'CommandOrControl+Shift+L';

dotenv.config({ path: join(projectDirectory, '.env'), quiet: true });

// Optional isolated state for local review and smoke checks.
if (process.env.LOGGIE_DATA_DIRECTORY) app.setPath('userData', process.env.LOGGIE_DATA_DIRECTORY);

export let coreClient;
export let commandService;

app.setName('Loggie');

// A packaged Loggie runs the transcriber with the Python inside the app (send-gate.js transcriberRuntime); its ffmpeg and
// bytecode switches reach call.py through the environment every spawn below already passes on.
Object.assign(process.env, transcriberRuntime().env);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

export function rendererPath(fileName) {
  return join(desktopDirectory, 'renderer', fileName);
}

export function preloadPath() {
  return join(desktopDirectory, 'preload.cjs');
}

export function statePath() {
  return join(app.getPath('userData'), positionFileName);
}

export function hikyakuDirectory() {
  return join(app.getPath('userData'), 'hikyaku');
}

// Setup (cloud-first C6): a permission is asked for when the action that needs it first runs. The guard checks the
// permission, and when macOS has refused it writes one setup.need event, which the tail below turns into a card.
// The calendar has no status call, so its state is what the last calendar read found.
export let calendarState = 'unknown';
export const emitSetup = (event) => emitEvent(join(runsRoot(hikyakuDirectory()), newRunId()), event);
export const readPermissionStatus = () => permissionStatus({ systemPreferences, calendarStatusImpl: async () => calendarState });
export const ordinarySetupGuard = createSetupGuard({ status: readPermissionStatus, emit: emitSetup });
export const setupGuard = recordingPermissionGuard(ordinarySetupGuard, readPermissionStatus, createSetupGuard, emitSetup);
// The setup page's saves, one after another, so two quick presses cannot write over each other (spec B5.1).
// The setup page's app marks (first-run-polish B2.2, desktop/app-icons.js). The generic-icon probe is an empty .app
// folder in the OS temp folder, deleted after its one read.
export async function iconProbe() {
  const dir = await mkdtemp(join(tmpdir(), 'loggie-icon-'));
  await mkdir(join(dir, 'Generic.app'));
  return { app: join(dir, 'Generic.app'), missing: join(dir, 'Missing.app'), remove: () => rm(dir, { recursive: true, force: true }) };
}
export const appIcon = createAppIcons({ getFileIcon: (path, options) => app.getFileIcon(path, options), stat, makeProbe: iconProbe });
export let settingsWrite = Promise.resolve();
// The one way main writes settings.json: each write after the last (the setup page's saves, the Found step's end).
export const inSettings = (fn) => { const run = settingsWrite.then(fn); settingsWrite = run.catch(() => {}); return run; };
// The workstreams.json lock (workstreams.js updateWorkstreams), for the writers that run in the background.
export const withWorkstreams = (mutate) => updateWorkstreams(hikyakuDirectory(), mutate);
// One Apple event to an app, to learn whether Loggie may control it: ok is granted, -1743 is a refusal, anything else
// (a timeout, an app that is not there) is unknown. 60 s, since the answer waits on the user's click.
export function automationAnswer(appName) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', `tell application "${appName}" to get name`], { timeout: 60000 }, (error, _stdout, stderr) => {
      resolve(!error ? 'granted' : /-1743/.test(`${stderr || ''} ${error.message}`) ? 'denied' : 'unknown');
    });
  });
}

// The first time sorting mail, finding workstreams, learning the style, or reading chats would run in the cloud with no
// yes, the panel is asked once per run of the app. A workstream's mail has its own switch on its card instead.
export const askedYes = new Set();
export function askCloudYes(path) {
  const group = path === 'chats' ? 'chats' : path === 'calls' ? 'calls' : ['discover', 'triage', 'style', 'rank'].includes(path) ? 'ai' : null;
  if (!group || askedYes.has(group)) return;
  askedYes.add(group);
  emitSetup({ type: 'setup.cloud_yes', data: { group } }).catch((error) => console.error(`hikyaku setup: ${error.message}`));
}

export function assertTrustedRenderer(event) {
  const source = event.senderFrame?.url || '';
  if (!isTrustedRendererUrl(source)) {
    throw new Error('Untrusted renderer request.');
  }
}

export function publicError(error) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return message.replace(/Bearer\s+[\w.-]+/gi, 'Bearer [hidden]').slice(0, 300);
}

// A window door (minimize, full screen, hide): the same trusted-window check, the handler's own return value (the
// preload reads it bare, not as { ok, data }).
export function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...arguments_) => {
    assertTrustedRenderer(event);
    return handler(...arguments_);
  });
}

export function handleSecure(channel, handler) {
  ipcMain.handle(channel, async (event, ...arguments_) => {
    try {
      assertTrustedRenderer(event);
      return { ok: true, data: await handler(...arguments_) };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  });
}

// Every Do it press and answer, with what it led to: the tasks-wiring falsifier counts presses that reached the mail app.
export const logUiAct = (row) => appendFile(join(hikyakuDirectory(), 'ui-acts.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...row, from: 'main' })}\n`)
  .catch((error) => console.error(`ui-acts.jsonl not written: ${error.message}`));

// What the user did on the Workstreams screen, one line each in ui-acts.jsonl; these are the only actions it logs.
export const UI_ACTS = ['box-read', 'sweep-start', 'sweep-step', 'sweep-done', 'peek', 'focus', 'tap', 'park', 'ask', 'fold-open', 'refresh', 'refresh-one', 'costs-on', 'costs-off', 'clash-open', 'do-it', 'open-draft', 'needs-open', 'unretire', 'call-open', 'call-jump', 'goal-yes'];
export const UI_TIERS = ['glance', 'standard', 'wide', 'full'];
export function screenName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
  return name;
}

// Everything Loggie spends on the cloud AI is the app's, including the call notes it starts (byo.py inherits this):
// the meter and the daily limit count these rows only; hand-run evals log as "dev" (usage.js runBy).
process.env.LOGGIE_RUN_BY = 'app';

// The clients main.js builds at launch and the calendar state a read found, set here so every module reads them
// live (debt-cleanup 6.6).
export function setClients(values) { ({ coreClient = coreClient, commandService = commandService, folderAccess = folderAccess, voiceInput = voiceInput } = values); }
export function setCalendarState(value) { calendarState = value; }
