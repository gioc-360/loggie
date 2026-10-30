import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingHelp } from '../desktop/renderer/recording-help.js';
import { mainText } from './helpers/main-files.js';
test('an incompatible recorder explains the build issue instead of asking for permissions', () => {
  const help = recordingHelp({ error: 'Recorder did not start: dyld: Library not loaded (built for macOS 28.0)' });
  assert.match(help.message, /different macOS version/);
  assert.equal(help.permission, undefined);
});
test('recording permission failures have the correct settings action', () => {
  assert.equal(recordingHelp({ blocked: 'screen' }).permission, 'screen');
  assert.match(recordingHelp({ blocked: 'screen' }).message, /Screen & System Audio/);
  assert.equal(recordingHelp({ blocked: 'microphone' }).permission, 'microphone');
  assert.match(recordingHelp({ blocked: 'microphone' }).message, /Electron/);
  assert.equal(recordingHelp({ blocked: 'speech' }).permission, undefined);
  assert.match(recordingHelp({ blocked: 'speech' }).message, /download/);
  assert.match(recordingHelp({ error: 'ENOENT recorder' }).message, /Reinstall/);
  assert.equal(recordingHelp({ error: 'ENOENT recorder' }).detail, 'ENOENT recorder');
});
test('manual recording initializes independently of automatic calendar polling', async () => {
  const main = await mainText();
  assert.match(main, /if \(!meetingWatch\) await startMeetingWatch\(\{ watch: false \}\)/);
  assert.match(main, /if \(!watch\) return;\s+meetingWatch.start\(\)/);
  assert.match(main, /askForMediaAccess\('microphone'\)/);
});


test('stale Electron screen denial defers to native capture without ignoring microphone denial', async () => {
  const { recordingPermissionGuard } = await import('../desktop/recording-permissions.js');
  const { createSetupGuard } = await import('../src/hikyaku/permissions.js');
  let status = { microphone: 'granted', screen: 'denied', calendar: 'denied' };
  const readStatus = async () => status;
  const emit = async () => {};
  const ordinary = createSetupGuard({ status: readStatus, emit });
  const guard = recordingPermissionGuard(ordinary, readStatus, createSetupGuard, emit);
  assert.equal(await guard.check('record'), null);
  assert.equal((await guard.check('calendar-offer')).permission, 'calendar');
  status = { ...status, microphone: 'denied' };
  assert.equal((await guard.check('record')).permission, 'microphone');
  assert.equal(recordingHelp({ error: 'User declined ScreenCaptureKit permission' }).permission, 'screen');
});
