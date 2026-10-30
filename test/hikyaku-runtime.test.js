// The packaged app (cloud-first C7, plan 4.1): when Loggie runs from its DMG, every transcriber call uses the Python and
// the transcriber folder inside the app, ffmpeg comes from the app, and nothing needs a developer's Mac. In dev nothing
// changes. Everything is faked: no Python is started, no app is packaged, no network.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { screenCall } from '../src/hikyaku/entry.js';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { screenThread } from '../src/hikyaku/screen-thread.js';
import { transcriberRuntime } from '../src/hikyaku/send-gate.js';
import { NAMES_A_MODEL } from '../src/hikyaku/events.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RES = '/Applications/Loggie.app/Contents/Resources';
const DEV = { env: {}, packaged: false, resourcesPath: undefined };
const APP = { env: {}, packaged: true, resourcesPath: RES };

test('in dev the runtime is python3 and the transcriber folder from the env, the settings or ~/hikyaku', () => {
  assert.deepEqual(transcriberRuntime({}, { ...DEV, env: { HIKYAKU_TRANSCRIBER: '/dev/spike' } }), { python: 'python3', dir: '/dev/spike', env: {} });
  assert.equal(transcriberRuntime({ transcriber: '/set/spike' }, DEV).dir, '/set/spike');
  assert.equal(transcriberRuntime({}, DEV).dir, join(dirname(fileURLToPath(import.meta.url)), '..', 'transcriber', 'spike'), 'a checkout runs the transcriber inside the repo');
});

test('packaged, the runtime is the Python and the transcriber folder inside the app, with the app ffmpeg and no bytecode writes', () => {
  const runtime = transcriberRuntime({ transcriber: '/set/spike' }, { ...APP, env: { HIKYAKU_TRANSCRIBER: '/dev/spike' } });
  assert.deepEqual(runtime, { python: `${RES}/python/bin/python3`, dir: `${RES}/transcriber`, env: { HIKYAKU_FFMPEG: `${RES}/bin/ffmpeg`, PYTHONDONTWRITEBYTECODE: '1' } });
});

// --- every spawn takes the runtime's python
test('screenThread and screenCall run the python they are given, in the folder they are given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-runtime-'));
  const seen = [];
  const runner = async (command, args, options) => {
    seen.push({ command, args, cwd: options?.cwd });
    if (args[0]?.endsWith('privacy.py')) {
      const thread = args.includes('--thread');
      const out = thread ? args[args.indexOf('--out') + 1] : args[1];
      await writeFile(join(out, thread ? 'OUTBOUND.md' : 'outbound.md'), '# s\n');
      await writeFile(join(out, thread ? 'HELD.json' : 'held.json'), JSON.stringify({ counts: { sentences: 1, sent: 1, held: 0 } }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const python = `${RES}/python/bin/python3`;
  const transcriber = `${RES}/transcriber`;
  await screenThread({ threadId: 't1', md: '# s\n', workstreamDirectory: dir, transcriber, python, runner });
  const call = join(dir, 'call');
  await mkdir(call);
  await writeFile(join(call, 'transcript.md'), 'x');
  await screenCall({ folder: call, transcriber, python, runner });
  assert.deepEqual(seen.map((s) => s.command), [python, python]);
  assert.ok(seen.every((s) => s.cwd === transcriber));
  assert.equal(seen[0].args[0], `${transcriber}/privacy.py`);
});

test('the meeting watch starts and stops a recording with the given python in the given folder', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-runtime-watch-'));
  const runs = [];
  const detached = [];
  const python = `${RES}/python/bin/python3`;
  const T0 = Date.parse('2026-10-01T14:00:00Z');
  const event = { id: 'e1', title: 'Chat with Sam', start: new Date(T0).toISOString(), end: new Date(T0 + 3600000).toISOString(), allDay: false, calendar: 'Calendar',
    account: 'me@example.org', writable: true, attendees: ['sam@example.org'], attendeeNames: ['Sam Example'], recurring: false, location: '', myStatus: 'accepted' };   // his invite (meeting.js isMine)
  const watch = createMeetingWatch({
    home, listEvents: async () => [event], now: () => new Date(T0), log: () => {}, python, transcriber: async () => `${RES}/transcriber`, loggieDirectory: '/fake',
    runner: async (command, args, options) => { runs.push({ command, args, options }); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', 'c1')}\n`, stderr: '' }; },
    detach: (command, args, options) => detached.push({ command, args, options }),
  });
  const decision = await watch.poll();
  await watch.answer(decision.offer ? watch.state.live.offer_id : null, 'record');
  assert.equal(runs[0].command, python);
  assert.equal(runs[0].options.cwd, `${RES}/transcriber`);
  await mkdir(join(home, 'calls', 'c1'), { recursive: true });
  await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', 'c1'), started: T0 / 1000 }));
  await watch.endAnswer('c1', 'stop');
  assert.equal(detached[0].command, python);
  assert.deepEqual(detached[0].args, ['call.py', 'stop']);
});

test('no source file under src or desktop starts the bare python3 outside a default', async () => {
  const { readdir } = await import('node:fs/promises');
  const hits = [];
  for (const folder of ['src/hikyaku', 'desktop']) {
    for (const name of await readdir(join(ROOT, folder))) {
      if (!name.endsWith('.js') || name === 'doctor.js') continue;
      const text = await readFile(join(ROOT, folder, name), 'utf8');
      for (const [index, line] of text.split('\n').entries()) if (/runner\(\s*'python3'|detach\(\s*'python3'|spawn\(\s*'python3'/.test(line)) hits.push(`${folder}/${name}:${index + 1}`);
    }
  }
  assert.deepEqual(hits, []);
});

// --- the electron-builder config
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

test('the build config names the app, the arm64 dmg, the hardened runtime and the three resource folders', () => {
  const build = pkg.build;
  assert.equal(pkg.main, 'desktop/main.js');
  assert.equal(build.appId, 'com.loggie.desktop');
  assert.equal(build.productName, 'Loggie');
  assert.deepEqual(build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(build.mac.hardenedRuntime, true);
  assert.equal(build.mac.entitlements, 'desktop/entitlements.mac.plist');
  assert.equal(build.mac.entitlementsInherit, 'desktop/entitlements.mac.plist');
  assert.equal(build.mac.identity, null, 'unsigned until Jess signs (docs/release-signing.md)');
  assert.equal(build.artifactName, 'Loggie-${version}-${arch}.${ext}');
  const from = Object.fromEntries(build.extraResources.map((item) => [item.to, item.from]));
  assert.deepEqual(from, { bin: 'dist-native/bin', transcriber: 'build-cache/transcriber', python: 'build-cache/python' });
});

test('an unsigned build is sealed ad hoc after packing, and a real identity skips that', async () => {
  assert.equal(pkg.build.afterPack, 'scripts/after-pack.cjs');
  const { default: afterPack } = await import('../scripts/after-pack.cjs');
  // a build with an identity or on another platform runs no codesign (execFileSync would throw on this fake path)
  await afterPack({ electronPlatformName: 'darwin', packager: { platformSpecificBuildOptions: { identity: 'Developer ID Application: Example (ABCDE12345)' } } });
  await afterPack({ electronPlatformName: 'linux', packager: { platformSpecificBuildOptions: { identity: null } } });
});

test('the usage strings are plain words, name no model, and cover the microphone, the calendar and Automation', () => {
  const info = pkg.build.mac.extendInfo;
  for (const key of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSCalendarsFullAccessUsageDescription', 'NSCalendarsUsageDescription', 'NSAppleEventsUsageDescription']) {
    assert.equal(typeof info[key], 'string', key);
    assert.ok(info[key].length > 20, `${key} says why`);
    assert.ok(!NAMES_A_MODEL.test(info[key]), `${key} names no model`);
    assert.ok(!info[key].includes('\u2014'), `${key} has no em dash`);
  }
});

test('dist:mac builds the helpers, stages the transcriber and recorder, bundles Python and ffmpeg, then packages', () => {
  const steps = pkg.scripts['dist:mac'].split('&&').map((step) => step.trim());
  assert.deepEqual(steps, ['npm run build:native', 'bash scripts/stage-transcriber.sh', 'bash scripts/bundle-python.sh', 'bash scripts/bundle-ffmpeg.sh', 'electron-builder --mac --arm64']);
});

test('the downloads are pinned by sha256, checked, and never committed', async () => {
  for (const script of ['bundle-python.sh', 'bundle-ffmpeg.sh']) {
    const text = await readFile(join(ROOT, 'scripts', script), 'utf8');
    assert.match(text, /[0-9a-f]{64}/, `${script} pins a sha256`);
    assert.match(text, /shasum -a 256/, `${script} checks it`);
  }
  const ignore = (await readFile(join(ROOT, '.gitignore'), 'utf8')).split('\n');
  for (const entry of ['dist/', 'build-cache/']) assert.ok(ignore.includes(entry), `${entry} is ignored`);
});

test('stage-transcriber.sh copies code, prompts and a freshly built recorder, and leaves out audio, fixtures, tests and caches', async (t) => {
  if (spawnSync('which', ['swiftc']).status !== 0) return t.skip('no swiftc on this Mac');
  const work = await mkdtemp(join(tmpdir(), 'hikyaku-stage-'));
  const spike = join(work, 'spike');
  for (const [name, text] of [['call.py', 'x'], ['privacy.py', 'x'], ['test_privacy.py', 'x'], ['recorder.swift', '@main struct Recorder { static func main() { print("recorder") } }\n'], ['prompts/summary.txt', 'x'], ['fixtures/case.json', '{}'], ['t1/me.caf', 'x'], ['asr/them.txt', 'x'],
    ['diar/label.py', 'x'], ['__pycache__/call.pyc', 'x'], ['rec.log', 'x'], ['recorder', 'old binary'], ['a.wav', 'x'], ['wordlist_eval.py', 'x']]) {
    await mkdir(dirname(join(spike, name)), { recursive: true });
    await writeFile(join(spike, name), text);
  }
  const out = join(work, 'out');
  const run = spawnSync('bash', [join(ROOT, 'scripts', 'stage-transcriber.sh')], { env: { ...process.env, HIKYAKU_TRANSCRIBER: spike, STAGE_DIR: out }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { readdir } = await import('node:fs/promises');
  const listing = (await readdir(out, { recursive: true })).sort();
  assert.deepEqual(listing, ['call.py', 'privacy.py', 'prompts', 'prompts/summary.txt', 'recorder']);
  assert.equal(spawnSync(join(out, 'recorder'), [], { encoding: 'utf8' }).stdout.trim(), 'recorder', 'the recorder was built from recorder.swift, not copied');
});
