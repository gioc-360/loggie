// What runs on its own: the look for workspaces, the refresh timer, the event tails, the meeting watch, speech.
// Moved out of main.js in debt-cleanup 6.6.
import { app, Notification, systemPreferences } from 'electron';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listEvents } from '../src/hikyaku/calendar.js';
import { answeredKey, notifyEvent, surfaceFor } from './renderer/meeting-cards.js';
import { backgroundRuns, isSetupDone } from './renderer/setup-model.js';
import { readRawSettings, speechWantedOf, yesState } from '../src/hikyaku/setup-status.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { usageToday } from '../src/hikyaku/usage.js';
import { emitEvent } from '../src/hikyaku/events.js';
import { launchNeeds } from '../src/hikyaku/permissions.js';
import { keyStatus } from '../src/hikyaku/cloud-key.js';
import { newRunId, runsRoot, transcriberRuntime } from '../src/hikyaku/send-gate.js';
import { isPackaged } from '../src/hikyaku/native-helper.js';
import { mergeInbox, readInboxMail, readSentMail } from '../src/hikyaku/sent-mail.js';
import { DISCOVER_DAYS, SKIP_NO_KEY, SKIP_NO_YES, discover, discoverLine } from '../src/hikyaku/discover.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { recordCalendarsSaved } from '../src/hikyaku/meeting.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { desktopDirectory, projectDirectory, coreClient, hikyakuDirectory, setupGuard, withWorkstreams, askCloudYes, setCalendarState } from './main-state.js';
import { panelWindow, expandPanel } from './main-windows.js';
import { FIRST_DISCOVER_DAYS, mailSource, decideGateOptionsOf } from './main-helpers.js';
import { chatApps, runRefresh, learnIntros, checkSent, learnTexting, startRanking, resumeFoundCatchUp, sayChanged } from './main-catch-up.js';

export let coreEventTimer;

export let entryEventTimer;
export let sentCheckTimer;
export let meetingWatch;
export let lastCoreEventSequence = 0;

// New workstreams from mail no card covers (discover.js): the last week of every Apple Mail inbox. A card it adds is
// not read here: its mail is read only after the person keeps it (first-run-polish D1).
// Every look writes exactly one runs.jsonl line, a skip, a failure (anything that throws) or the look itself.
export async function discoverWorkstreams({ dryRun = false, onProgress = () => {} } = {}) {
  // Every look leaves a line, a skip included (workspaces-outlook W3): it used to return before writing anything, so a
  // Mac without Gmail never found a workspace and nothing said why.
  const skip = async (why) => {
    await appendFile(join(hikyakuDirectory(), 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), discover: true, dryRun, skipped: why })}\n`).catch(() => {});
    return { skipped: why };
  };
  try {
    const source = await mailSource();
    if (source.kind === 'none') return skip(source.why);
    const settings = await readSettings(hikyakuDirectory());
    const complete = thinkWith({ settings, maxTokens: 900, consent: consentFor('discover', { settings }), what: 'mail outside your workstreams', path: 'discover', onNeedYes: askCloudYes });
    if (!complete) return skip(SKIP_NO_YES);
    // A missing key would fail only after the 30-day read, in the first batch, and only to the console (spec C15).
    if (!process.env.NEBIUS_API_KEY && !(await keyStatus().catch(() => ({ saved: false }))).saved) return skip(SKIP_NO_KEY);
    const first = !(await stat(join(hikyakuDirectory(), 'workstreams.json')).catch(() => null));
    const days = first ? FIRST_DISCOVER_DAYS : DISCOVER_DAYS;
    // Apple Mail's Inbox is the whole read (2026-10-28, no Gmail sign-in).
    const threads = [];
    const outlook = await readInboxMail({ address: source.own, days }).catch((error) => { console.error(`hikyaku discover: Apple Mail inbox not read: ${error.message}`); return []; });
    // Domains the user has written to (Outlook's Sent copy, and their own messages in what was read): mail from them can
    // make a card; mail from strangers cannot (discover.js knownSender). The Sent copy also gives an Outlook-only thread
    // the user's side (mergeInbox `sent`).
    const sent = await readSentMail({ address: source.own, days: 60 }).catch(() => []);
    mergeInbox(threads, outlook, source.own, { belongs: () => true, sent });
    const knownDomains = [...new Set([...sent.flatMap((message) => message.to),
      ...threads.flatMap((thread) => (thread.messages || []).filter((message) => source.own.some((own) => String(message.from || '').toLowerCase().includes(own))).flatMap((message) => `${message.to || ''},${message.cc || ''}`.split(',')))]
      .map((address) => (String(address).toLowerCase().match(/@([\w.-]+)/) || [])[1]).filter(Boolean))];
    const log = await discover({ threads, workstreams: await readWorkstreams(hikyakuDirectory()), complete, home: hikyakuDirectory(),
      ownAddress: source.own, ownNames: [settings.signName].filter(Boolean), knownDomains, dryRun, first, onProgress, update: withWorkstreams,
      // The setup yes covers reading the mail of the cards it finds once they are kept (cloud-screen.js grantCloudYes).
      cloud: settings.cloudYes?.found === true ? 'nebius' : null,
      // A first run starts from the threads the user wrote in over the same window (discover.js sentSeeds).
      sent: first ? sent.filter((message) => Date.parse(message.timestamp) >= Date.now() - days * 86400000) : [] });
    await appendFile(join(hikyakuDirectory(), 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), discover: true, dryRun, source: source.kind, days, ...log })}\n`);
    return log;
  } catch (error) {
    await appendFile(join(hikyakuDirectory(), 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), discover: true, failed: error.message })}\n`).catch(() => {});
    throw error;
  }
}

export async function warmOutlookHelpers() {
  const started = Date.now();
  try {
    await (await import('../src/hikyaku/outlook.js')).ensureOutlookHelper();
    await (await import('../src/hikyaku/ask-move.js')).ensureMoveHelper();
    console.log(`outlook helpers ready in ${Date.now() - started} ms`);
  } catch (error) { console.error(`outlook helpers: ${error.message}`); }
}
// One look at a time for every caller (spec C15): the hourly tick, a Yes, a saved key and setup's Done all share it.
// Each look tells the panel when it starts and what it found or why it waits (the Workspaces status line).
export let discovering = null;
export let discoverTimer = null;
// The look in flight, for the Found step (first-run-polish B4.2): whether one runs, how far it is, and when the last
// one ended. lookRunning is false before the look's done line is sent, so the step never stays on searching.
export let discoverProgress = null;
export let lookRunning = false;
export let lookEndedAt = 0;
export function sayDiscover(text, done = false, data = null) {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:moved', { taskId: null, phase: 'discover', text, done, ...(data ? { data } : {}) });
}
export async function discoverAndSay() {
  lookRunning = true; discoverProgress = null;
  const first = !(await stat(join(hikyakuDirectory(), 'workstreams.json')).catch(() => null));
  const days = first ? FIRST_DISCOVER_DAYS : DISCOVER_DAYS;
  const startText = first ? `Looking through the last ${days} days of your mail for workspaces…` : "Looking at this week's mail for new workspaces…";
  sayDiscover(startText);
  try {
    const log = await discoverWorkstreams({ onProgress: (data) => { discoverProgress = data; sayDiscover(startText, false, data); } });
    lookRunning = false; lookEndedAt = Date.now();
    sayDiscover(discoverLine({ log, days }), true);
    return log;
  } catch (error) {
    lookRunning = false; lookEndedAt = Date.now();
    sayDiscover(`The look for workspaces stopped: ${error.message}`, true);
    throw error;
  }
}
export function discoverOnce() {
  discovering ||= discoverAndSay().finally(() => { discovering = null; });
  return discovering;
}
// A look a few seconds from now, once the background has started (before setup is done, Done starts it instead). A
// look that ended under 5 s ago (the Found step's own) is not run again.
export function discoverSoon(delayMs = 2000) {
  if (!startedAfterSetup) return;
  clearTimeout(discoverTimer);
  discoverTimer = setTimeout(() => { if (Date.now() - lookEndedAt >= 5000) discoverOnce().catch(() => {}); }, delayMs);
  discoverTimer.unref?.();
}
export function startDiscovery() {
  const tick = () => discoverOnce().then((log) => log?.added && console.log(`hikyaku discover: ${JSON.stringify({ uncovered: log.uncovered, fresh: log.fresh, added: log.added.map((item) => item.name) })}`))
    .catch((error) => console.error(`hikyaku discover failed: ${error.message}`));
  setTimeout(tick, 90000).unref?.();
  setInterval(tick, 60 * 60 * 1000).unref?.();
}

// The change check and refresh on their own: two minutes after launch, then every ten. One at a time: a tick while a
// refresh still runs does nothing. Timer runs are `auto` (refresh.js refreshPlan: once a day per workstream).
// One refresh at a time for every caller: a tick while one runs does nothing; the user's own refresh, or the launch
// hook, waits for the run in progress and gets its result, so two runs never write the same files together.
export let refreshing = null;

export function refreshOnce(options) {
  // Every run ends with the change signal, the timer's too: a run that only added a question (a suggested home for a
  // chat) changed Today, and only Workspaces' Refresh redrew it (Codex review, 2026-10-23).
  refreshing ||= runRefresh(options).finally(() => { refreshing = null; sayChanged(); });
  return refreshing;
}
export function startRefreshing() {
  const tick = async () => {
    if (refreshing) return;
    try { await refreshOnce({ auto: true }); } catch (error) { console.error(`hikyaku refresh failed: ${error.message}`); }
  };
  setTimeout(tick, 120000).unref?.();
  setInterval(tick, 10 * 60 * 1000).unref?.();
}

export function startSentChecks() {
  const tick = () => checkSent().catch((error) => console.error(`hikyaku sent check failed: ${error.message}`));
  setTimeout(tick, 15000).unref?.();
  sentCheckTimer = setInterval(tick, 10 * 60 * 1000);
  sentCheckTimer.unref?.();
}

export function startCoreEventPolling() {
  const poll = async () => {
    try {
      const events = await coreClient.listEvents(lastCoreEventSequence);
      if (events.length) {
        lastCoreEventSequence = events.at(-1).sequence;
        if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('core:events', events);
      }
    } catch (error) {
      console.error(`Could not read Loggie core events: ${error.message}`);
    }
  };
  poll();
  coreEventTimer = setInterval(poll, 500);
  coreEventTimer.unref?.();
}

// The entry's events (src/hikyaku/events.js, spec section 2): every new line of a run's events.jsonl, written by Loggie
// or by call.py and byo.py, goes to the panel on hikyaku:entry, the same way core:events does. Old runs are not
// replayed; the panel reads one run whole with entryEvents(runId).
// An offer or an end ask (renderer/meeting-cards.js) is kept until its answer, and a Notification says it when the panel
// is collapsed; clicking it expands the panel. Nothing here answers for the user: only the card's buttons do.
export const liveMeetingEvents = new Map();
export function surfaceMeetingEvent(event) {
  const card = surfaceFor(event);
  if (card) liveMeetingEvents.set(card.key, event);
  const closed = answeredKey(event);
  if (closed) liveMeetingEvents.delete(closed);
  notifyEvent(event, { Notification, isCollapsed: () => !panelWindow?.isVisible(), expand: () => expandPanel().catch((error) => console.error(`hikyaku panel: ${error.message}`)) });
}

// The standing yes for call notes (first-run-polish B5.4), read when a call's screen finishes: the flag and when it was
// given, a saved key, and today's cloud limit (as runRefresh computes it). Any one false leaves the call's card.
export async function standingYes() {
  const home = hikyakuDirectory();
  const settings = await readRawSettings(home).catch(() => ({}));
  const limitUsd = Number(settings.cloudDailyLimitUsd) > 0 ? Number(settings.cloudDailyLimitUsd) : 3;
  return {
    callsYes: settings.cloudYes?.calls === true,
    callsAt: settings.cloudYes?.callsAt || null,
    keySaved: Boolean(process.env.NEBIUS_API_KEY) || (await keyStatus().catch(() => ({ saved: false }))).saved,
    overBudget: (await usageToday(home)).usd >= limitUsd,
  };
}
// An install whose yes came before call notes wrote themselves: the Today card asks once (askCloudYes's once-per-run
// set), only while the AI yes is there and the question was never answered (callsAsked).
export async function askCallsYes() {
  const raw = await readRawSettings(hikyakuDirectory()).catch(() => ({}));
  if (yesState(raw).ai && raw.cloudYes?.callsAsked !== true) askCloudYes('calls');
}

export async function startEntryEventTail() {
  const { createEventTail } = await import('../src/hikyaku/events.js');
  // A call whose workstream already has a cloud yes skips the card: when its screen finishes, the summary request goes
  // out (send-gate.js autoDecide). Any other call gets the card, as before.
  // The setup yes covers call notes too (first-run-polish B5.4): `standing` says whether it is there and may spend now.
  const { autoDecideOnScreen } = await import('../src/hikyaku/send-gate.js');
  const autoDecideHook = autoDecideOnScreen({ options: async () => ({ ...(await decideGateOptionsOf()).options, standing: await standingYes(), askCalls: () => { askCallsYes().catch((error) => console.error(`hikyaku setup: ${error.message}`)); } }) });
  const tail = createEventTail({ home: hikyakuDirectory(), onEvent: (event) => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:entry', event);
    surfaceMeetingEvent(event);
    autoDecideHook(event);
  } });
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try { await tail.poll(); } catch (error) { console.error(`Could not read hikyaku run events: ${error.message}`); } finally { busy = false; }
  };
  await poll();
  entryEventTimer = setInterval(poll, 500);
  entryEventTimer.unref?.();
}

// The meeting watch (src/hikyaku/meeting-watch.js, spec-c.md increment 12): the calendar every 60 s, a meeting.offered
// event when a meeting starts (it reaches the panel through the tail above), and the answer on hikyaku:meeting-answer.
// It never records on its own. HIKYAKU_MEETINGS=0 keeps it off, the way HIKYAKU_DISCOVER=0 does for discovery.
export async function prepareManualRecording() {
  if (!meetingWatch) await startMeetingWatch({ watch: false });
  if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
}

export async function startMeetingWatch({ watch = true } = {}) {
  const { createMeetingWatch } = await import('../src/hikyaku/meeting-watch.js');
  const { listEvents } = await import('../src/hikyaku/calendar.js');
  const { micOwners } = await import('../src/hikyaku/mic.js');
  const { execRunner } = await import('../src/hikyaku/screen-thread.js');
  const readCalendar = async (options) => {
    try { const events = await listEvents(options); setCalendarState('granted'); return events; } catch (error) {
      if (/cannot read your calendars/.test(error.message)) setCalendarState('denied');
      throw error;
    }
  };
  meetingWatch = createMeetingWatch({
    home: hikyakuDirectory(), listEvents: readCalendar, micOwners, permissions: setupGuard, runner: execRunner, loggieDirectory: projectDirectory,
    transcriber: async () => transcriberRuntime(await readSettings(hikyakuDirectory())).dir, python: transcriberRuntime().python,
    // Recording waits on speech only where the app always downloads it (K8): a clone's switch never blocks a recording.
    speechReady: speechGate ? speechIsReady : undefined,
    // The calendars he records from (Settings, 2026-10-27); none saved is each account's main calendar (meeting.js).
    recordCalendars: async () => recordCalendarsSaved(await readSettings(hikyakuDirectory())),
    onOffer: (offer) => console.log(`hikyaku meeting: offered ${offer.offer_id} (${offer.reason}, ${offer.people} people)`),
  });
  if (!watch) return;
  meetingWatch.start();
  // What the app asks for as it opens: Calendar (macOS asks on the first read above) and Full Disk (every mail read).
  setTimeout(async () => {
    for (const action of launchNeeds()) await setupGuard.check(action, { once: true });
  }, 5000).unref?.();
}

// Speech in the background (src/hikyaku/speech-download.js, plan 4.1): a packaged Loggie fetches the speech engine and the
// two speech files on first launch, resumably, one panel card showing how far it is. A failed or dropped download says
// paused and is tried again every minute. A Loggie run from source downloads only when HIKYAKU_SPEECH_DOWNLOAD=1 or the
// setup's Calls switch saved speechModels true (first-run-polish B5.1); a meeting offer waits on it only where the app
// always downloads it (speechGate).
export const speechGate = isPackaged() || process.env.HIKYAKU_SPEECH_DOWNLOAD === '1';
export const speechWantedNow = async () => speechWantedOf({ packaged: isPackaged(), env: process.env, raw: await readRawSettings(hikyakuDirectory()).catch(() => ({})) });
export let speechTimer;
// One run at a time: a launch with speechModels saved and the Calls save in the same process join the run in flight.
export let speechRun = null;
export async function speechIsReady() {
  const { readManifest, speechStatus } = await import('../src/hikyaku/speech-download.js');
  return (await speechStatus({ manifest: await readManifest() })).ready;
}
export function startSpeechDownload() {
  speechRun ||= attemptLoop().finally(() => { speechRun = null; });
  return speechRun;
}
// Today's attempt, as a loop: a failure waits a minute and tries again, inside the same run, until the files are whole.
export async function attemptLoop() {
  const { downloadSpeech, readManifest } = await import('../src/hikyaku/speech-download.js');
  const manifest = await readManifest();
  const run = newRunId();
  const emit = (event) => emitEvent(join(runsRoot(hikyakuDirectory()), run), event);
  for (;;) {
    try { await downloadSpeech({ manifest, emit }); return; } catch (error) {
      console.error(`hikyaku speech: ${error.message} Trying again in a minute.`);
      await new Promise((resolve) => { speechTimer = setTimeout(resolve, 60000); speechTimer.unref?.(); });
    }
  }
}

// What runs in the background once setup is done (spec B2): at launch when it is, else when setup's Done is pressed.
export let startedAfterSetup = false;
export const voiceHelperPath = () => (app.isPackaged ? join(process.resourcesPath, 'bin', 'loggie-voice') : join(desktopDirectory, '..', 'dist-native', 'bin', 'loggie-voice'));
// The launch's two answers (2026-10-28): whether setup opens (not done), and whether the background runs (done, or an
// install from before setup, which keeps running while its one setup is open: it already has workspaces).
export async function setupNow() {
  const raw = JSON.parse(await readFile(join(hikyakuDirectory(), 'settings.json'), 'utf8').catch(() => '{}') || '{}');
  const existing = Boolean(await stat(join(hikyakuDirectory(), 'workstreams.json')).catch(() => null));
  return { done: isSetupDone(raw), background: backgroundRuns(raw, { existing: existing || Boolean(raw.signName || raw.mailApp || raw.cloudYes) }) };
}
export function startAfterSetup() {
  if (startedAfterSetup) return;
  startedAfterSetup = true;
  if (process.env.HIKYAKU_MEETINGS !== '0') startMeetingWatch().catch((error) => console.error(`hikyaku meeting watch: ${error.message}`));
  if (process.env.HIKYAKU_DISCOVER !== '0') startDiscovery();
  if (process.env.HIKYAKU_REFRESH !== '0') startRefreshing();
  if (process.env.HIKYAKU_RANK !== '0') startRanking();
  // A quit during a kept card's first read: it is read 30 s after launch (first-run-polish B4.3).
  setTimeout(() => resumeFoundCatchUp().catch((error) => console.error(`hikyaku found: ${error.message}`)), 30000).unref?.();
  (async () => {
    // A new user has no voice file yet: build it once from their sent mail, in the background.
    const noVoiceYet = !(await stat(join(hikyakuDirectory(), 'voice', 'intros.md')).catch(() => null));
    // Apple Mail's Sent: learnIntros reads it, and skips quietly with no mail account.
    if (process.env.HIKYAKU_LEARN_INTROS_ON_START === '1' || noVoiceYet) {
      learnIntros()
        .then(({ scanned, intros, pattern }) => console.log(`hikyaku intros: ${JSON.stringify({ scanned, intros, pattern })}`))
        .catch((error) => console.error(`hikyaku intros failed: ${error.message}`));
    }
    // Chats on and no texting voice yet: build it once from the user's own chat messages, in the background.
    chatApps().then(async ({ apps }) => {
      if (!apps.length || (await stat(join(hikyakuDirectory(), 'voice', 'texting.md')).catch(() => null))) return;
      const log = await learnTexting();
      console.log(`hikyaku texting voice: ${JSON.stringify(log)}`);
    }).catch((error) => console.error(`hikyaku texting voice failed: ${error.message}`));
  })().catch((error) => console.error(`hikyaku start: ${error.message}`));
}
