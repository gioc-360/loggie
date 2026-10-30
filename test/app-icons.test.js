// The setup page's app icons (desktop/app-icons.js, first-run-polish B2.2): macOS's generic app icon counts as no icon,
// so Gio's bundled mark draws instead. Every icon here is a fake: a few bytes standing in for a PNG.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_PATHS, createAppIcons } from '../desktop/app-icons.js';

const image = (bytes) => ({ isEmpty: () => bytes === '', toPNG: () => Buffer.from(bytes), toDataURL: () => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` });
const PROBE = { app: '/tmp/probe/Generic.app', missing: '/tmp/probe/Missing.app' };

function fakeMac({ icons, installed = Object.keys(APP_PATHS), probeFails = false }) {
  const calls = [];
  let removed = 0;
  const byPath = { [PROBE.app]: 'generic-app', [PROBE.missing]: 'generic-document', ...Object.fromEntries(Object.entries(icons).map(([id, bytes]) => [APP_PATHS[id], bytes])) };
  const appIcon = createAppIcons({
    getFileIcon: async (path, options) => {
      calls.push(path);
      assert.deepEqual(options, { size: 'normal' });
      if (byPath[path] instanceof Error) throw byPath[path];
      return image(byPath[path] ?? '');
    },
    stat: async (path) => { if (!installed.some((id) => APP_PATHS[id] === path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    makeProbe: async () => { if (probeFails) throw new Error('no temp folder'); return { ...PROBE, remove: async () => { removed += 1; } }; },
  });
  return { appIcon, calls, removed: () => removed };
}

test('an icon equal to the generic app icon is no icon; a different one is drawn', async () => {
  const mac = fakeMac({ icons: { outlook: 'generic-app', calendar: 'generic-document', 'apple-mail': 'real-mail' } });
  assert.deepEqual(await mac.appIcon('outlook'), { app: 'outlook', installed: true, icon: null });
  assert.deepEqual(await mac.appIcon('calendar'), { app: 'calendar', installed: true, icon: null });
  assert.deepEqual(await mac.appIcon('apple-mail'), { app: 'apple-mail', installed: true, icon: image('real-mail').toDataURL() });
  assert.equal(mac.removed(), 1, 'the probe folder is deleted after its one read');
  assert.equal(mac.calls.filter((path) => path === PROBE.app).length, 1, 'the generic icon is read once');
});

test('a missing app, an empty icon and a failed read: not installed, or installed with no icon', async () => {
  const mac = fakeMac({ icons: { 'system-settings': '', messages: new Error('icon read failed') }, installed: ['system-settings', 'messages'] });
  assert.deepEqual(await mac.appIcon('whatsapp'), { app: 'whatsapp', installed: false, icon: null });
  assert.deepEqual(await mac.appIcon('system-settings'), { app: 'system-settings', installed: true, icon: null });
  assert.deepEqual(await mac.appIcon('messages'), { app: 'messages', installed: true, icon: null });
});

test('each icon is read once per run, and with no probe a real icon still draws', async () => {
  const mac = fakeMac({ icons: { outlook: 'real-outlook' }, probeFails: true });
  const first = mac.appIcon('outlook');
  assert.equal(mac.appIcon('outlook'), first, 'the same promise from the cache');
  assert.deepEqual(await first, { app: 'outlook', installed: true, icon: image('real-outlook').toDataURL() });
  assert.equal(mac.calls.filter((path) => path === APP_PATHS.outlook).length, 1);
});
