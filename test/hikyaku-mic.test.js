// The mic signal (spec-c.md increment 13, B13): the helper output reduced to meeting apps, how long an app has held the
// mic, and the helper compile rule. A fake helper and made-up bundles only: nothing here touches the microphone.
import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appSignal, IGNORE, meetingApps, MEETING_APPS, micOwners } from '../src/hikyaku/mic.js';
import { helperPath } from '../src/hikyaku/native-helper.js';

const OWNERS = { at: '2026-10-08T15:00:00Z', using_mic: [
  { bundle: 'us.zoom.xos', pid: 11 }, { bundle: 'com.apple.CoreSpeech', pid: 12 }, { bundle: '', pid: 13 }, { bundle: 'com.example.recorder', pid: 14 },
  { bundle: 'com.google.Chrome', pid: 15 }, { bundle: 'org.example.unknown', pid: 16 }, { bundle: 'us.zoom.xos', pid: 17 },
] };

test('meetingApps keeps the allow list only: no dictation, no empty bundle, no recorder pid, no unknown app', () => {
  assert.deepEqual(meetingApps(OWNERS, { ignorePids: [14] }), [{ bundle: 'us.zoom.xos', label: 'Zoom', pid: 11 }, { bundle: 'com.google.Chrome', label: 'Chrome', pid: 15 }]);
  assert.deepEqual(meetingApps({ using_mic: [{ bundle: 'us.zoom.xos', pid: 14 }] }, { ignorePids: [14] }), [], 'the recorder pid is ignored whatever its bundle');
  assert.deepEqual(meetingApps(null), []);
  assert.ok(IGNORE.has('com.apple.CoreSpeech'));
  assert.equal(MEETING_APPS['com.tinyspeck.slackmacgap'], 'Slack');
});

test('appSignal dates an app from the first poll it was seen, and a release from the first poll it was gone', () => {
  const seen = new Map();
  const zoom = [{ bundle: 'us.zoom.xos', label: 'Zoom', pid: 1 }];
  const t = (s) => new Date(Date.parse('2026-10-08T15:00:00Z') + s * 1000);
  assert.deepEqual(appSignal({ apps: zoom, now: t(0), seen }).held, [{ bundle: 'us.zoom.xos', label: 'Zoom', since: t(0).toISOString() }]);
  assert.equal(appSignal({ apps: zoom, now: t(5), seen }).held[0].since, t(0).toISOString(), 'still held: the date does not move');
  const gone = appSignal({ apps: [], now: t(10), seen });
  assert.deepEqual([gone.held, gone.released], [[], [{ bundle: 'us.zoom.xos', label: 'Zoom', since: t(10).toISOString() }]]);
  assert.equal(appSignal({ apps: [], now: t(15), seen }).released[0].since, t(10).toISOString());
  assert.equal(appSignal({ apps: zoom, now: t(20), seen }).held[0].since, t(20).toISOString(), 'holding again starts a new date');
});

test('micOwners runs the helper and parses it; a failure is a plain message', async () => {
  const calls = [];
  const execImpl = async (binary, args) => { calls.push([binary, args]); return { stdout: JSON.stringify(OWNERS) }; };
  assert.deepEqual(await micOwners({ execImpl, helper: '/bin/fake-mic' }), OWNERS);
  assert.deepEqual(calls, [['/bin/fake-mic', []]]);
  const broken = async () => { const error = new Error('exit 1'); error.stderr = 'no audio service\n'; throw error; };
  await assert.rejects(micOwners({ execImpl: broken, helper: '/bin/fake-mic' }), /no audio service/);
  await assert.rejects(micOwners({ execImpl: async () => ({ stdout: 'not json' }), helper: '/bin/fake-mic' }), /JSON/);
});

test('mic.swift is compiled only when newer than the binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-mic-'));
  const source = join(dir, 'mic.swift');
  const helper = join(dir, 'bin', 'hikyaku-mic');
  await writeFile(source, '// swift');
  const builds = [];
  const execImpl = async (command, args) => { builds.push(command); await writeFile(args.at(-1), 'binary'); return { stdout: '' }; };
  await helperPath({ name: 'mic', source, devHelper: helper, roots: [], packaged: false, execImpl });
  await helperPath({ name: 'mic', source, devHelper: helper, roots: [], packaged: false, execImpl });
  assert.equal(builds.length, 1);
  const later = new Date(Date.now() + 60000);
  await utimes(source, later, later);
  await helperPath({ name: 'mic', source, devHelper: helper, roots: [], packaged: false, execImpl });
  assert.equal(builds.length, 2);
});
