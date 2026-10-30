// Verify the one global shortcut and its fallback notice without reserving the user's live shortcut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSummonShortcut } from '../desktop/app-shortcuts.js';

test('registers only the existing summon shortcut and dispatches it to the shared window action', async () => {
  const registrations = []; let toggles = 0;
  const registered = registerSummonShortcut({
    shortcut: 'CommandOrControl+Shift+L',
    globalShortcut: { register: (...args) => { registrations.push(args); return true; } },
    togglePanel: async () => { toggles++; }, dialog: { showMessageBox: () => assert.fail('unexpected notice') },
  });
  assert.equal(registered, true); assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], 'CommandOrControl+Shift+L');
  registrations[0][1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(toggles, 1);
});

test('shortcut conflict explains the Dock and menu bar fallback', () => {
  const notices = [];
  assert.equal(registerSummonShortcut({ shortcut: 'CommandOrControl+Shift+L', platform: 'darwin',
    globalShortcut: { register: () => false }, togglePanel: () => assert.fail('must not toggle'),
    dialog: { showMessageBox: async options => { notices.push(options); } },
  }), false);
  assert.equal(notices.length, 1); assert.match(notices[0].message, /⌘⇧L/);
  assert.match(notices[0].detail, /Dock or menu bar/);
});
