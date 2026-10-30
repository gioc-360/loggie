// One reusable assistant window, summoned by the shortcut, Dock or menu bar; hiding keeps its work alive.
import { app, BrowserWindow, Menu, nativeImage, screen, Tray } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { panelBounds } from './window-geometry.js';
import { projectDirectory, rendererPath, preloadPath, statePath, shortcut } from './main-state.js';
import { liveMeetingEvents } from './main-background.js';

export let panelWindow;
export let tray;
export let isQuitting = false;
export let saveTimer;
export let panelWidth = null;
export let panelHeight = null;
let sizeReady;
let panelReady;
let showing;
let toggling;
let hiding;

async function readPanelSize() {
  if (!sizeReady) sizeReady = readSavedState().then(saved => {
    if (panelWidth === null && Number(saved.panelWidth) > 0) panelWidth = Number(saved.panelWidth);
    if (panelHeight === null && Number(saved.panelHeight) > 0) panelHeight = Number(saved.panelHeight);
  });
  await sizeReady;
}

export async function readSavedState() {
  try { return JSON.parse(await readFile(statePath(), 'utf8')) || {}; }
  catch { return {}; }
}

export function saveWindowState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await readPanelSize();
    try {
      await writeFile(statePath(), `${JSON.stringify({ panelWidth, panelHeight }, null, 2)}\n`, 'utf8');
    } catch (error) { console.error(`Could not save Loggie's window size: ${error.message}`); }
  }, 200);
}

export function commonWebPreferences() {
  return { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

export function lockDownRenderer(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
}

export function displayForAssistant() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

export function createPanelWindow() {
  if (panelReady) return panelReady;
  if (panelWindow && !panelWindow.isDestroyed()) return Promise.resolve(panelWindow);
  // Share the entire load when several entry points summon at once.
  panelReady = (async () => {
    await readPanelSize();
    const assistant = new BrowserWindow({
      ...panelBounds(displayForAssistant().workArea, panelWidth, panelHeight),
      alwaysOnTop: false, backgroundColor: '#f7f8f4', closable: true, frame: false,
      fullscreenable: true, maximizable: false, minWidth: 340, minimizable: true,
      resizable: true, show: false, skipTaskbar: false, title: 'Loggie', transparent: false,
      webPreferences: commonWebPreferences(),
    });
    panelWindow = assistant;
    lockDownRenderer(assistant);
    assistant.on('close', event => {
      if (!isQuitting) { event.preventDefault(); hideLoggie().catch(reportWindowError); }
    });
    assistant.on('closed', () => { if (panelWindow === assistant) panelWindow = null; });
    assistant.on('resize', () => {
      if (!assistant.isVisible() || assistant.isMinimized() || assistant.isFullScreen()) return;
      const { width, height } = assistant.getBounds();
      if (width === panelWidth && height === panelHeight) return;
      panelWidth = width;
      panelHeight = height;
      if (!process.env.LOGGIE_PANEL_WIDTH) saveWindowState();
    });
    try {
      await assistant.loadFile(rendererPath('panel.html'));
      for (const event of liveMeetingEvents.values()) assistant.webContents.send('hikyaku:entry', event);
      return assistant;
    } catch (error) {
      assistant.destroy();
      throw error;
    }
  })().finally(() => { panelReady = null; });
  return panelReady;
}

export function expandPanel() {
  if (showing) return showing;
  showing = (async () => {
    if (hiding) await hiding;
    const assistant = await createPanelWindow();
    if (assistant.isMinimized()) {
      await new Promise(resolve => { assistant.once('restore', resolve); assistant.restore(); });
    }
    if (!assistant.isFullScreen()) assistant.setBounds(panelBounds(displayForAssistant().workArea, panelWidth, panelHeight));
    // Bring the ordinary window onto the active Space without making it always on top.
    if (process.platform === 'darwin' && !assistant.isFullScreen()) {
      assistant.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    }
    assistant.show();
    if (process.platform === 'darwin' && !assistant.isFullScreen()) {
      assistant.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    assistant.focus();
    assistant.webContents.send('loggie:focus-composer');
  })().finally(() => { showing = null; });
  return showing;
}

export function hideLoggie() {
  if (hiding) return hiding;
  hiding = (async () => {
    const assistant = panelWindow;
    if (!assistant || assistant.isDestroyed()) return;
    if (assistant.isFullScreen()) {
      await new Promise(resolve => { assistant.once('leave-full-screen', resolve); assistant.setFullScreen(false); });
    }
    assistant.hide();
  })().finally(() => { hiding = null; });
  return hiding;
}

export function togglePanelFullScreen() {
  if (!panelWindow || panelWindow.isDestroyed()) return false;
  const fullScreen = !panelWindow.isFullScreen();
  panelWindow.setFullScreen(fullScreen);
  return fullScreen;
}

export function togglePanel() {
  if (toggling) return toggling;
  toggling = (async () => {
    if (panelWindow?.isVisible() && panelWindow.isFocused() && !panelWindow.isMinimized()) await hideLoggie();
    else await expandPanel();
  })().finally(() => { toggling = null; });
  return toggling;
}

function reportWindowError(error) { console.error(`Could not show or hide Loggie: ${error.message}`); }
export function openLoggie() { return expandPanel().catch(reportWindowError); }
app.on('second-instance', openLoggie);

export function configureAppIdentity() {
  if (process.platform !== 'darwin') return;
  app.dock.setIcon(join(projectDirectory, 'assets', 'branding', 'loggie-app.png'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { label: 'Hide Loggie', accelerator: 'Command+H', click: () => hideLoggie().catch(reportWindowError) },
      { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'Window', submenu: [
      { label: 'Close Window', accelerator: 'Command+W', click: () => hideLoggie().catch(reportWindowError) },
      { role: 'minimize' }, { role: 'togglefullscreen' },
    ] },
  ]));
}

export function createTrayImage() {
  const image = nativeImage.createFromPath(join(projectDirectory, 'assets', 'branding', 'loggie-tray.png'));
  image.setTemplateImage(true);
  return image;
}

export function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip('Loggie — ⇧⌘L');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Loggie', accelerator: shortcut, click: openLoggie },
    { label: 'Hide Loggie', click: () => hideLoggie().catch(reportWindowError) },
    { type: 'separator' },
    { label: 'Quit Loggie', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
  tray.on('click', openLoggie);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
}

export function setQuitting() { isQuitting = true; }
export function setPanelWidth(px) { panelWidth = px; }
