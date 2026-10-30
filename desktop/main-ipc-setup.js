// The setup page doors: permissions, the cloud yeses, the keys, the Found step and the app icons.
// Moved out of main.js in debt-cleanup 6.6.
import { app, shell, systemPreferences } from 'electron';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCloudKey, validateCloudYesAnswer, validateSetupAnswer, validateSetupAsk, validateSetupPart, validateSetupSave, validateAppIcon, validateFoundKeep } from './ipc-validation.js';
import { calendarStatus, listEvents } from '../src/hikyaku/calendar.js';
import { isSetupDone, nextMeeting, STEPS } from './renderer/setup-model.js';
import { saveSetup, setupStatus } from '../src/hikyaku/setup-status.js';
import { grantCalls, grantCloudYes, laterCalls } from '../src/hikyaku/cloud-screen.js';
import { approveFound, foundState, keepFound, needCatchUp } from '../src/hikyaku/found.js';
import { paneUrl } from '../src/hikyaku/permissions.js';
import { keyStatus, saveCloudKey } from '../src/hikyaku/cloud-key.js';
import { testCloudKey } from '../src/hikyaku/nebius.js';
import { transcriberRuntime } from '../src/hikyaku/send-gate.js';
import { PANES } from '../src/hikyaku/settings-panes.js';
import { createTavily, KEYCHAIN as TAVILY_KEYCHAIN, testTavilyKey } from '../src/hikyaku/tavily.js';
import { folderAccess, voiceInput, hikyakuDirectory, calendarState, emitSetup, readPermissionStatus, appIcon, inSettings, automationAnswer, handleSecure, logUiAct, setCalendarState, screenName } from './main-state.js';
import { rankAll, rankSoon, catchUpFound } from './main-catch-up.js';
import { discoverProgress, lookRunning, discoverOnce, discoverSoon, startSpeechDownload, voiceHelperPath, startAfterSetup } from './main-background.js';
import { forgetWhoIndex } from './main-ask.js';

export function registerSetupIpc() {
  // Setup cards (permissions.js, renderer/setup-cards.js). "Open Settings" opens the pane main.js works out from the
  // permission; both answers close the card with an event. The cloud yes writes settings only on Yes.
  handleSecure('hikyaku:setup-answer', async (permission, answer) => {
    const input = validateSetupAnswer(permission, answer);
    if (input.answer === 'open') await shell.openExternal(paneUrl(input.permission));
    await emitSetup({ type: 'setup.answered', data: input });
    return input;
  });
  handleSecure('hikyaku:cloud-yes-answer', async (group, answer) => {
    const input = validateCloudYesAnswer(group, answer);
    // The call notes card (first-run-polish B5.4): either answer is saved, so it never shows again.
    if (input.group === 'calls') await inSettings(() => (input.answer === 'yes' ? grantCalls(hikyakuDirectory()) : laterCalls(hikyakuDirectory())));
    else if (input.answer === 'yes') {
      if (input.group === 'ai') {
        await grantCloudYes(hikyakuDirectory());
        // The order was by date while the yes was missing; with it, the cards are ordered now rather than tomorrow.
        rankAll().catch((error) => console.error(`hikyaku rank failed: ${error.message}`));
        // And the look for workspaces runs now instead of at the next hourly tick.
        discoverSoon();
      }
      else await (await import('../src/hikyaku/cloud.js')).setCloud(hikyakuDirectory(), 'Chats', 'nebius');
    }
    await emitSetup({ type: 'setup.cloud_answered', data: input });
    return input;
  });
  // The cloud AI key (cloud-key.js): Save writes the keychain and answers { saved: true }, never the key; Test key makes
  // its one request only when pressed.
  handleSecure('hikyaku:save-key', async (key) => {
    const saved = await saveCloudKey(validateCloudKey(key));
    discoverSoon();
    return saved;
  });
  handleSecure('hikyaku:key-status', () => keyStatus());
  handleSecure('hikyaku:test-key', () => testCloudKey());
  // The nine-step setup page (docs/teammate-ready/spec.md B5.2). Its status is setup-status.js's, with the calendar read
  // by the helper's status (never a prompt) until a calendar read has answered.
  handleSecure('hikyaku:setup-status', async (part) => {
    const input = validateSetupPart(part);
    const permissions = { ...await readPermissionStatus(), calendar: calendarState !== 'unknown' ? calendarState : await calendarStatus() };
    return setupStatus({ home: hikyakuDirectory(), part: input, model: { STEPS, isSetupDone }, permissionsImpl: async () => permissions, python: transcriberRuntime().python });
  });
  // One write at a time to settings.json. Done starts the background (spec B2), the look for workspaces, and, with Full
  // Disk Access, the default search folders.
  handleSecure('hikyaku:setup-save', async (patch) => {
    const input = validateSetupSave(patch);
    const whatsapp = Boolean(await stat('/Applications/WhatsApp.app').catch(() => null));
    // A Done on a Mac with no workstreams.json yet opens the Found step (first-run-polish B4.1), read at the press.
    const first = !(await stat(join(hikyakuDirectory(), 'workstreams.json')).catch(() => null));
    const saved = await inSettings(() => saveSetup(hikyakuDirectory(), input, { whatsapp, first }));
    if ('chats' in input) forgetWhoIndex();
    // The Calls step's switch (first-run-polish B5.1): on starts the speech download now; a relaunch starts it again.
    if (input.speechModels === true) startSpeechDownload().catch((error) => console.error(`hikyaku speech: ${error.message}`));
    if (input.done) {
      startAfterSetup();
      discoverSoon();
      if ((await readPermissionStatus()).fullDisk === 'granted') folderAccess.allowDefaults().catch((error) => console.error(`hikyaku setup folders: ${error.message}`));
    }
    return saved;
  });
  // What a step asks for. Each one shows macOS's own question or opens its pane, only when the step's button is pressed.
  handleSecure('hikyaku:setup-ask', async (what) => {
    const ask = validateSetupAsk(what);
    if (ask === 'calendar') {
      try {
        const events = await listEvents({ from: new Date(), days: 7 });
        setCalendarState('granted');
        return { status: 'granted', next: nextMeeting(events, Date.now()) };
      } catch (error) {
        if (!/cannot read your calendars/.test(error.message)) throw error;
        setCalendarState('denied');
        return { status: 'denied' };
      }
    }
    if (ask === 'fullDisk' || ask === 'screen') { await shell.openExternal(paneUrl(ask)); return { opened: true }; }
    if (ask === 'mailAccounts') { await shell.openExternal(PANES['internet-accounts']); return { opened: true }; }
    if (ask === 'automation') {
      // macOS has no way to ask first: the first Apple event shows "Loggie wants to control ..." and waits for the answer.
      const mail = await automationAnswer('Mail');
      const systemEvents = await automationAnswer('System Events');
      const status = mail === 'granted' && systemEvents === 'granted' ? 'granted' : mail === 'denied' || systemEvents === 'denied' ? 'denied' : 'unknown';
      return { status, mail, systemEvents };
    }
    if (ask === 'accessibility') return { status: systemPreferences.isTrustedAccessibilityClient(true) ? 'granted' : 'denied' };
    if (ask === 'microphone') {
      if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
      return { status: (await readPermissionStatus()).microphone };
    }
    if (ask === 'speech') {
      if (!(await stat(voiceHelperPath()).catch(() => null))) return { status: 'missing' };
      // The answer comes on loggie:voice (voice-input.js), as the helper reports it.
      return voiceInput.start({ authorizeOnly: true });
    }
    throw new Error('That setup step is not one Loggie offers.');
  });
  // The Tavily key, as the Nebius one above: saved to its own keychain item, the reply never holding it.
  handleSecure('hikyaku:save-tavily-key', (key) => saveCloudKey(validateCloudKey(key), { keychain: TAVILY_KEYCHAIN }));
  handleSecure('hikyaku:test-tavily-key', () => {
    const home = hikyakuDirectory();
    return testTavilyKey({ search: createTavily({ home, max: 1 }), home });
  });
  // Quit & Reopen after Screen audio (spec C13): answer first, then relaunch. before-quit stops the timers and voice.
  handleSecure('hikyaku:relaunch', () => {
    setTimeout(() => { app.relaunch(); app.quit(); }, 200);
    return { relaunching: true };
  });
  // The Found step (first-run-polish B4.5): what the look found, a look now (one at a time), and Keep or Later. Keep
  // writes first; only then are the kept cards read, in the background (D1).
  handleSecure('hikyaku:found-status', () => foundState({ home: hikyakuDirectory(), running: lookRunning, progress: discoverProgress }));
  handleSecure('hikyaku:found-look', () => {
    discoverOnce().catch(() => {});
    return { started: true };
  });
  handleSecure('hikyaku:found-keep', async (choice) => {
    const input = validateFoundKeep(choice);
    const home = hikyakuDirectory();
    const { kept, dismissed } = await keepFound({ home, keep: input.keep, dismiss: input.dismiss, end: input.end, now: new Date(), saveSetupImpl: (patch) => inSettings(() => saveSetup(home, patch)) });
    logUiAct({ act: 'found-keep', kept, dismissed, end: input.end });
    needCatchUp({ home }).then(catchUpFound).catch((error) => console.error(`hikyaku found: ${error.message}`));
    rankSoon();
    return { kept, dismissed };
  });
  // The read yes on a kept found card (loggie-intros live fix): after cloudYesAnswer('ai', 'yes'), every kept found
  // card with no approval gets one, and their first reads run newest first, one at a time, in the background.
  handleSecure('hikyaku:found-read', async (name) => {
    const home = hikyakuDirectory();
    const result = await approveFound({ home, name: screenName(name) });
    logUiAct({ act: 'found-read', approved: result.approved.length });
    needCatchUp({ home, newest: true }).then(catchUpFound).catch((error) => console.error(`hikyaku found: ${error.message}`));
    return result;
  });
  // The setup page's marks (first-run-polish B2.2): the installed app's own icon, read once per run.
  handleSecure('hikyaku:app-icon', (app) => appIcon(validateAppIcon(app)));
}
