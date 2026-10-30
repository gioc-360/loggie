// Loggie's Electron entry: the launch (clients, the IPC, the background, the tray, the setup gate),
// the developer switches and the app events. The rest lives in the main-*.js files beside it (debt-cleanup 6.6).
import { folderAccess, voiceInput, shortcut, coreClient, hikyakuDirectory, setClients } from './main-state.js';
import { app, dialog, globalShortcut, shell } from 'electron';
import { registerSummonShortcut } from './app-shortcuts.js';
import { createVoiceInput } from './voice-input.js';
import { createFolderAccess } from './folder-access.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCoordinator } from '../src/core/runtime.js';
import { panelBounds } from './window-geometry.js';
import { createCommandService } from './command-service.js';
import { panelWindow, saveTimer, panelWidth, panelHeight, displayForAssistant, createPanelWindow, expandPanel, hideLoggie, togglePanelFullScreen, togglePanel, createTray, configureAppIdentity, openLoggie, setQuitting, setPanelWidth } from './main-windows.js';
import { coreEventTimer, entryEventTimer, sentCheckTimer, warmOutlookHelpers, refreshOnce, startSentChecks, startCoreEventPolling, startEntryEventTail, speechWantedNow, startSpeechDownload, voiceHelperPath, setupNow, startAfterSetup } from './main-background.js';
import { loadWhoIndex, invitePeople, invitePlaces, registerAsk } from './main-ask.js';
import { registerAppIpc } from './main-ipc-app.js';
import { registerWorkspacesIpc } from './main-ipc-workspaces.js';
import { registerMeetingsIpc } from './main-ipc-meetings.js';
import { registerMovesIpc } from './main-ipc-moves.js';
import { registerSetupIpc } from './main-ipc-setup.js';
import { registerMenuIpc } from './main-ipc-menu.js';

let desktopReady = false;
app.whenReady().then(async () => {
  configureAppIdentity();
  if (process.platform === 'darwin') await app.dock.show();
  setClients({ coreClient: await ensureCoordinator({
    dataDirectory: join(app.getPath('userData'), 'core'),
  }),
  });
  setClients({ folderAccess: createFolderAccess({ file: join(app.getPath('userData'), 'search-folders.json'), dialog, window: () => panelWindow }) });
  await folderAccess.load();
  // His names, so a calendar titled after him ("Jess Lu" on Google) counts as his main calendar (meeting.js, 2026-10-28).
  import('../src/hikyaku/draft.js').then(async ({ readSettings, macFullName }) => {
    const { setCalendarOwner } = await import('../src/hikyaku/meeting.js');
    const settings = await readSettings(hikyakuDirectory()).catch(() => ({}));
    setCalendarOwner([settings.signName, await macFullName().catch(() => '')]);
  }).catch((error) => console.error(`calendar owner: ${error.message}`));
  setClients({ voiceInput: createVoiceInput({ helper: voiceHelperPath(), emit: data => { if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('loggie:voice', data); } }) });
  app.on('before-quit', () => voiceInput.stop());
  setClients({ commandService: createCommandService({ coreClient, shell, folderAccess, invitePeople, invitePlaces }) });
  // No Gmail sign-in (2026-10-28, teammates' mail fix 5): every mail read is Apple Mail's store, every draft opens in
  // Outlook or Apple Mail. The sign-in needed a credentials file only Gio's clone had, and his was never connected.
  await mkdir(join(hikyakuDirectory(), 'work'), { recursive: true });
  registerAppIpc();
  registerWorkspacesIpc();
  registerMeetingsIpc();
  registerMovesIpc();
  registerSetupIpc();
  registerMenuIpc();
  registerAsk();
  startCoreEventPolling();
  startEntryEventTail().catch((error) => console.error(`hikyaku events: ${error.message}`));
  if (await speechWantedNow()) startSpeechDownload().catch((error) => console.error(`hikyaku speech: ${error.message}`));
  startSentChecks();
  // The ask box's who index, built now so the first sentence typed gets its line at once (cold, it took ~1 s and the
  // first previews were dropped as stale).
  loadWhoIndex().catch((error) => console.error(`ask box: who index not built: ${error.message}`));
  // The Outlook helpers, built now if their source changed, so no email ask or meeting move waits on the compiler.
  warmOutlookHelpers();
  if (process.env.HIKYAKU_REFRESH_ON_START === '1') {
    refreshOnce({ auto: false }).then((line) => console.log(`hikyaku refresh: ${JSON.stringify(line)}`)).catch((error) => console.error(`hikyaku refresh failed: ${error.message}`));
  }
  createTray();
  await createPanelWindow();
  // The background (calendar reads, the looks, ranking, the voice files) waits for setup, so no macOS dialog or yes
  // card lands before the step that names it (spec C3). Until then the panel opens on the setup page (C4). An install
  // from before setup runs its background while its one setup is open (2026-10-28): it already has workspaces.
  const setup = await setupNow();
  if (setup.background) startAfterSetup();
  if (!setup.done) await expandPanel();

  registerSummonShortcut({ globalShortcut, shortcut, togglePanel, dialog });
  desktopReady = true;

  if (process.env.LOGGIE_OPEN_WORKSPACE === '1') await expandPanel();
  // Developer switches: LOGGIE_OPEN_VIEW=today (or workspaces, meetings, settings) opens the panel on that tab, and
  // LOGGIE_PANEL_SHOT=<file.png> saves a picture of the panel a few seconds later, once the data has drawn.
  if (process.env.LOGGIE_OPEN_VIEW) {
    const assistant = await expandPanel().then(() => panelWindow);
    // LOGGIE_PANEL_WIDTH=<px> opens the panel that wide, to look at one width without dragging.
    if (Number(process.env.LOGGIE_PANEL_WIDTH) > 0) { setPanelWidth(Number(process.env.LOGGIE_PANEL_WIDTH)); assistant.setBounds(panelBounds(displayForAssistant().workArea, panelWidth, panelHeight)); }
    // LOGGIE_OPEN_CALL=<call folder> also opens that call on the Notes & Meetings tab.
    const detail = process.env.LOGGIE_OPEN_CALL ? { view: process.env.LOGGIE_OPEN_VIEW, call: process.env.LOGGIE_OPEN_CALL } : process.env.LOGGIE_OPEN_VIEW;
    await assistant.webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: ${JSON.stringify(detail)} }));`);
    setTimeout(async () => {
      await assistant.webContents.executeJavaScript(`document.querySelector('#workstreamSection')?.scrollIntoView({ block: 'start' });`).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 600));
      // LOGGIE_ASK_TEXT="<sentence>||<sentence>" types each sentence into the ask box (nothing runs: no Enter) and
      // saves one shot per sentence (<shot>-1.png, ...) with what the box read, to see the word map on real contacts.
      for (const [i, sentence] of (process.env.LOGGIE_ASK_TEXT || '').split('||').filter(Boolean).entries()) {
        const read = await assistant.webContents.executeJavaScript(`(async () => { const box = document.querySelector('#message'); box.focus(); box.value = ${JSON.stringify(sentence)}; box.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 2500)); return { words: [...document.querySelectorAll('#askMirror .ask-u')].map((u) => u.className.replace(/.*ask-u-/, '') + ':' + u.textContent), slots: [...document.querySelectorAll('#askUnder .ask-slot, #askUnder .ask-flag, #askUnder .ask-act')].map((n) => n.textContent) }; })()`).catch((error) => ({ error: error.message }));
        console.log(`ask box ${i + 1}: ${sentence}\n  ${JSON.stringify(read)}`);
        if (process.env.LOGGIE_PANEL_SHOT) await writeFile(process.env.LOGGIE_PANEL_SHOT.replace(/\.png$/, `-${i + 1}.png`), (await assistant.webContents.capturePage()).toPNG()).catch(() => {});
      }
      // LOGGIE_PANEL_PRESS=<expression> runs in the panel before the shot (it may return a promise): press a row's
      // buttons on real data to see a state the shot then holds (loggie-reply-yes: the reply's yes on the M&T card).
      if (process.env.LOGGIE_PANEL_PRESS) console.log(`panel press: ${JSON.stringify(await assistant.webContents.executeJavaScript(process.env.LOGGIE_PANEL_PRESS).catch((error) => error.message))}`);
      if (process.env.LOGGIE_PANEL_SHOT && !process.env.LOGGIE_ASK_TEXT) await writeFile(process.env.LOGGIE_PANEL_SHOT, (await assistant.webContents.capturePage()).toPNG()).catch((error) => console.error(`panel shot: ${error.message}`));
      // LOGGIE_PANEL_PROBE=<expression> prints what the expression gives in the panel, to read a layout the shot shows.
      if (process.env.LOGGIE_PANEL_PROBE) console.log(`panel probe: ${JSON.stringify(await assistant.webContents.executeJavaScript(process.env.LOGGIE_PANEL_PROBE).catch((error) => error.message))}`);
    }, 6000);
  }

  if (process.env.LOGGIE_DESKTOP_SMOKE_TEST === '1') {
    const assistant = await createPanelWindow();
    const bridgeReady = await assistant.webContents.executeJavaScript(
      'typeof window.loggie?.hide === "function"',
    );
    if (!bridgeReady) {
      console.error('Desktop smoke test failed: the secure renderer bridge did not load.');
      process.exitCode = 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const coreUiReady = await assistant.webContents.executeJavaScript(`Boolean(
      document.querySelector('#commandHistory') &&
      document.querySelector('#message') &&
      typeof window.loggie?.command?.execute === 'function'
    )`);
    if (!coreUiReady) {
      console.error('Desktop smoke test failed: the command-first interface did not load.');
      process.exitCode = 1;
    }
    const workspaceReady = await assistant.webContents.executeJavaScript(`(() => {
      const visible = (view) => !document.querySelector('[data-page="' + view + '"]').hidden;
      if (!visible('today') && !visible('settings')) return false;
      if (!document.querySelector('#chooseFolders') || typeof window.loggie.folders?.choose !== 'function') return false;
      if (document.querySelector('[data-view="home"]') || document.querySelector('[data-page="home"]')) return false;
      document.querySelector('[data-view="meetings"]').click();
      if (!visible('meetings') || visible('today')) return false;
      document.querySelector('[data-view="settings"]').click();
      if (!visible('settings') || visible('meetings')) return false;
      document.querySelector('[data-view="today"]').click();
      if (!visible('today') || visible('settings')) return false;
      document.querySelector('[data-view="workspaces"]').click();
      if (!visible('workspaces') || visible('today')) return false;
      document.querySelector('[data-view="today"]').click();
      return getComputedStyle(document.querySelector('.panel-shell')).gridTemplateRows.split(' ').length === 3 && document.querySelector('#composer').getBoundingClientRect().bottom <= document.querySelector('#conversation').getBoundingClientRect().top;
    })()`);
    if (!workspaceReady) {
      console.error('Desktop smoke test failed: workspace navigation did not work.');
      process.exitCode = 1;
    } else console.log('Workspace smoke check passed: secure bridge, navigation (Today first, Workspaces, Meetings, Settings in the three dots), and layout.');
    const voiceReady = await assistant.webContents.executeJavaScript(`Boolean(
      document.querySelector('#voiceButton')?.type === 'button' &&
      document.querySelector('#voiceStatus')?.getAttribute('role') === 'status' &&
      typeof window.loggie.voice?.start === 'function'
    )`);
    if (!voiceReady) { console.error('Desktop smoke test failed: voice input bridge or controls missing.'); process.exitCode = 1; }
    else console.log('Voice smoke check passed: microphone control and secure native bridge.');
    await expandPanel();
    if (assistant.isAlwaysOnTop()) {
      console.error('Desktop smoke test failed: assistant must use normal window stacking.');
      process.exitCode = 1;
    }
    const enteredFullScreen = new Promise((resolve) => assistant.once('enter-full-screen', resolve));
    togglePanelFullScreen();
    await enteredFullScreen;
    await hideLoggie();
    if (assistant.isFullScreen() || assistant.isVisible()) {
      console.error('Desktop smoke test failed: hiding fullscreen did not leave the assistant hidden.');
      process.exitCode = 1;
    }
    await expandPanel();
    assistant.minimize();
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!assistant.isMinimized()) {
      console.error('Desktop smoke test failed: assistant did not minimize.');
      process.exitCode = 1;
    }
    await expandPanel();
    if (assistant.isMinimized()) {
      console.error('Desktop smoke test failed: assistant did not restore.');
      process.exitCode = 1;
    } else console.log('Window smoke check passed: custom fullscreen, safe hide, minimize, restore.');
    setTimeout(() => app.quit(), 500);
  }
});

app.on('activate', () => { if (desktopReady) openLoggie(); });

app.on('before-quit', () => {
  setQuitting();
  clearTimeout(saveTimer);
  clearInterval(coreEventTimer);
  clearInterval(entryEventTimer);
  clearInterval(sentCheckTimer);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
