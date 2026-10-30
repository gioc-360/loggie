// Exercise real window lifecycle code with fake Electron windows and an isolated state file.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FAKES = {
  electron: `import { EventEmitter } from 'node:events';
    export const app = new EventEmitter(); app.focus = () => {}; app.dock = { setIcon(path) { app.icon = path; } };
    export class BrowserWindow extends EventEmitter {
      static instances = []; static failNextLoad = false;
      constructor(options) { super(); this.options = options; this.bounds = options; this.visible = false; this.focused = false; this.minimized = false; this.full = false; this.destroyed = false; this.spaces = []; this.sent = []; this.draft = '';
        this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (...args) => this.sent.push(args); BrowserWindow.instances.push(this); }
      async loadFile(path) { await new Promise(r => setTimeout(r, 10)); if (BrowserWindow.failNextLoad) { BrowserWindow.failNextLoad = false; throw new Error('load failed'); } this.loaded = path; }
      isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focused; } isMinimized() { return this.minimized; } isFullScreen() { return this.full; }
      getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; this.emit('resize'); }
      show() { this.visible = true; } focus() { this.focused = true; } hide() { this.visible = false; this.focused = false; }
      minimize() { this.minimized = true; this.focused = false; }
      restore() { this.minimized = false; setImmediate(() => this.emit('restore')); }
      setFullScreen(on) { this.full = on; setImmediate(() => this.emit(on ? 'enter-full-screen' : 'leave-full-screen')); }
      setVisibleOnAllWorkspaces(...args) { this.spaces.push(args); }
      destroy() { this.destroyed = true; this.emit('closed'); }
      close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    }
    export const screen = { workArea: { x: 1440, y: 25, width: 1440, height: 875 }, getCursorScreenPoint: () => ({ x: 1800, y: 100 }), getDisplayNearestPoint: () => ({ workArea: screen.workArea }) };
    export const Menu = { buildFromTemplate: template => ({ template }), setApplicationMenu(menu) { this.applicationMenu = menu; } };
    export const nativeImage = { createFromPath: path => ({ path, setTemplateImage(on) { this.template = on; } }) };
    export class Tray extends EventEmitter { constructor(image) { super(); this.image = image; } setToolTip(tip) { this.tip = tip; } popUpContextMenu(menu) { this.menu = menu; } }`,
  './main-state.js': 'export const rendererPath = name => name; export const preloadPath = () => ""; export const statePath = () => process.env.LOGGIE_TEST_STATE_FILE; export const projectDirectory = "/test/loggie"; export const shortcut = "CommandOrControl+Shift+L";',
  './main-background.js': 'export const liveMeetingEvents = new Map();',
};
const HOOKS = `const FAKES = ${JSON.stringify(FAKES)};
export async function resolve(specifier, context, next) {
  if (specifier in FAKES && (specifier === 'electron' || String(context.parentURL || '').endsWith('/desktop/main-windows.js'))) {
    return { url: 'data:text/javascript,' + encodeURIComponent(FAKES[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`;

test('summoning, hiding and reopening keep one assistant alive without a floating window', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'loggie-window-state-'));
  process.env.LOGGIE_TEST_STATE_FILE = join(dir, 'window-state.json');
  await writeFile(process.env.LOGGIE_TEST_STATE_FILE, JSON.stringify({ companion: { x: 40, y: 60 }, panelWidth: 900, panelHeight: 650 }));
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);
  const windows = await import('../desktop/main-windows.js');
  const { app, BrowserWindow, Menu, screen } = await import('electron');
  try {
    await t.test('legacy mascot position is ignored while saved panel dimensions survive', async () => {
      windows.saveWindowState();
      await new Promise(done => setTimeout(done, 300));
      assert.deepEqual(JSON.parse(await readFile(process.env.LOGGIE_TEST_STATE_FILE, 'utf8')), { panelWidth: 900, panelHeight: 650 });
    });
    await t.test('simultaneous summons wait for one fully loaded, initially hidden window', async () => {
      const [a, b] = await Promise.all([windows.createPanelWindow(), windows.createPanelWindow()]);
      assert.equal(a, b); assert.equal(BrowserWindow.instances.length, 1); assert.equal(a.loaded, 'panel.html');
      assert.equal(a.isVisible(), false); assert.equal(a.options.alwaysOnTop, false); assert.equal(a.options.transparent, false);
      assert.equal(a.options.webPreferences.sandbox, true);
    });
    await t.test('rapid shortcut presses open once and focus the input on the pointer display', async () => {
      await Promise.all([windows.togglePanel(), windows.togglePanel(), windows.togglePanel()]);
      const win = windows.panelWindow;
      assert.equal(BrowserWindow.instances.length, 1); assert(win.isVisible() && win.isFocused());
      assert.deepEqual(win.getBounds(), { x: 1710, y: 138, width: 900, height: 650 });
      assert.deepEqual(win.sent.at(-1), ['loggie:focus-composer']);
    });
    await t.test('overlapping Dock and menu opens share one focus operation', async () => {
      const win = windows.panelWindow;
      await windows.hideLoggie();
      const before = win.sent.length;
      await Promise.all([windows.expandPanel(), windows.expandPanel(), windows.openLoggie()]);
      assert.equal(win.sent.length, before + 1); assert(win.isVisible() && win.isFocused());
    });
    await t.test('focused summon hides; the next summon preserves the draft and renderer', async () => {
      const win = windows.panelWindow; win.draft = 'unfinished note';
      await windows.togglePanel(); assert.equal(win.isVisible(), false); assert.equal(win.isDestroyed(), false);
      await windows.togglePanel(); assert.equal(win.isVisible(), true); assert.equal(win.draft, 'unfinished note');
      assert.equal(BrowserWindow.instances.length, 1);
    });
    await t.test('a visible window behind another app is focused rather than hidden', async () => {
      const win = windows.panelWindow; win.focused = false;
      await windows.togglePanel(); assert(win.isVisible() && win.isFocused());
    });
    await t.test('a minimized window restores on a single summon', async () => {
      const win = windows.panelWindow; win.minimize();
      await windows.togglePanel(); assert(!win.isMinimized()); assert(win.isVisible() && win.isFocused());
    });
    await t.test('closing hides without destroying; fullscreen exits safely before hiding', async () => {
      const win = windows.panelWindow; win.close(); await windows.hideLoggie();
      assert(!win.isVisible() && !win.isDestroyed());
      await windows.expandPanel(); win.setFullScreen(true);
      await windows.hideLoggie(); assert(!win.isFullScreen() && !win.isVisible() && !win.isDestroyed());
    });
    await t.test('summoning moves to a negative-coordinate display and stays within its work area', async () => {
      screen.workArea = { x: -1280, y: 0, width: 1280, height: 720 };
      await windows.expandPanel();
      assert.deepEqual(windows.panelWindow.getBounds(), { x: -1090, y: 35, width: 900, height: 650 });
      if (process.platform === 'darwin') assert.deepEqual(windows.panelWindow.spaces.slice(-2).map(call => call[0]), [true, false]);
    });
    await t.test('a second launch focuses an already visible assistant instead of toggling it away', async () => {
      app.emit('second-instance'); await new Promise(done => setTimeout(done, 20));
      assert(windows.panelWindow.isVisible() && windows.panelWindow.isFocused());
    });
    await t.test('tray uses a template L; left click opens and right click exposes Hide and Quit', async () => {
      windows.createTray(); const tray = windows.tray;
      assert(tray.image.template); assert.match(tray.image.path, /branding\/loggie-tray\.png$/);
      tray.emit('click'); await new Promise(done => setTimeout(done, 20)); assert(windows.panelWindow.isVisible());
      tray.emit('right-click'); assert.deepEqual(tray.menu.template.filter(item => item.label).map(item => item.label), ['Open Loggie', 'Hide Loggie', 'Quit Loggie']);
      await tray.menu.template[1].click(); assert(!windows.panelWindow.isVisible());
    });
    await t.test('Dock branding and Command-W use the same hide-and-reopen lifecycle', async () => {
      if (process.platform !== 'darwin') return;
      windows.configureAppIdentity(); assert.match(app.icon, /branding\/loggie-app\.png$/);
      const close = Menu.applicationMenu.template.find(item => item.label === 'Window').submenu.find(item => item.accelerator === 'Command+W');
      await windows.expandPanel(); await close.click(); assert(!windows.panelWindow.isVisible());
      await windows.openLoggie(); assert(windows.panelWindow.isVisible());
    });
    await t.test('a failed renderer load is destroyed and can be retried', async () => {
      windows.panelWindow.destroy(); BrowserWindow.failNextLoad = true;
      await assert.rejects(windows.createPanelWindow(), /load failed/);
      assert.equal(windows.panelWindow, null);
      const win = await windows.createPanelWindow(); assert.equal(win.loaded, 'panel.html');
    });
    await t.test('Quit permits the actual window to close', () => {
      const win = windows.panelWindow; windows.setQuitting(); win.close(); assert(win.isDestroyed());
    });
  } finally {
    clearTimeout(windows.saveTimer);
    await rm(dir, { recursive: true, force: true });
  }
});
