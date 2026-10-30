// Pause and resume (loggie-pause-attach I1): pauseAnswer runs `call.py pause|resume`, waited for, only for the call
// recording now; the listing carries paused, pausedAt and pausedSeconds from current.json; the card's clock holds while
// paused and skips paused minutes. Made up: no recorder, temp homes only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { listCalls } from '../src/hikyaku/call-list.js';
import { validateMeetingPause } from '../desktop/ipc-validation.js';
import { recordedSeconds } from '../desktop/renderer/recording-controls.js';

const CALL = '2026-10-28-1330-nba-6820-negotiations';

async function setup(state, answer = { code: 0, stdout: '{"paused": true, "paused_s": 0}\n', stderr: '' }) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-pause-'));
  await mkdir(join(home, 'calls', CALL), { recursive: true });
  await writeFile(join(home, 'calls', CALL, 'event.json'), JSON.stringify({ title: 'NBA 6820 Negotiations', recorded_at: '2026-10-28T13:30:00-04:00' }));
  await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ pid: 4242, dir: join(home, 'calls', CALL), started: 1793208600, ...state }));
  const runs = [];
  const watch = createMeetingWatch({
    home, listEvents: async () => [], log: () => {}, transcriber: () => '/fake/transcriber/spike', loggieDirectory: '/fake/loggie',
    runner: async (command, args, options) => { runs.push({ command, args, options }); return answer; },
  });
  return { home, runs, watch };
}

test('pauseAnswer runs call.py pause in the transcriber and returns the state it printed', async () => {
  const { runs, watch } = await setup({});
  assert.deepEqual(await watch.pauseAnswer(CALL, 'pause'), { call: CALL, paused: true, pausedSeconds: 0 });
  assert.deepEqual([runs[0].command, runs[0].args, runs[0].options.cwd, runs[0].options.env.LOGGIE_DIR], ['python3', ['call.py', 'pause'], '/fake/transcriber/spike', '/fake/loggie']);
  assert.ok(runs[0].options.timeout <= 10000, 'waited for, with a short timeout');
});

test('pauseAnswer refuses a call that is not recording and a bad answer, and says what call.py said on a failure', async () => {
  const { watch, runs } = await setup({}, { code: 1, stdout: '', stderr: 'The recorder is not running. Stop writes up what it recorded.\n' });
  await assert.rejects(watch.pauseAnswer('other-call', 'pause'), /not recording/);
  await assert.rejects(watch.pauseAnswer(CALL, 'stop'), /pause or resume/);
  assert.equal(runs.length, 0);
  await assert.rejects(watch.pauseAnswer(CALL, 'resume'), /recorder is not running/);
});

test('validateMeetingPause takes a call id and pause or resume only', () => {
  assert.deepEqual(validateMeetingPause(CALL, 'resume'), { call: CALL, answer: 'resume' });
  assert.throws(() => validateMeetingPause('../x', 'pause'), /not a call/);
  assert.throws(() => validateMeetingPause(CALL, 'stop'), /pause or resume/);
});

test('the listing carries the pause: paused, pausedAt and the closed pauses in seconds', async () => {
  const { home } = await setup({ paused_at: 1793209200, paused_s: 95.5 });
  const [row] = await listCalls({ home });
  assert.equal(row.state, 'recording');
  assert.deepEqual([row.paused, row.pausedAt, row.pausedSeconds], [true, new Date(1793209200 * 1000).toISOString(), 95.5]);
  const { home: running } = await setup({});
  const [live] = await listCalls({ home: running });
  assert.deepEqual([live.paused, live.pausedAt, live.pausedSeconds], [false, null, 0]);
});

test('recordedSeconds skips closed pauses and holds during the open one', () => {
  const since = '2026-10-28T13:30:00.000Z';
  const at = (min) => Date.parse(since) + min * 60000;
  assert.equal(recordedSeconds({ since }, at(10)), 600);
  assert.equal(recordedSeconds({ since, pausedSeconds: 120 }, at(10)), 480);
  const open = { since, paused: true, pausedAt: new Date(at(8)).toISOString(), pausedSeconds: 60 };
  assert.equal(recordedSeconds(open, at(9)), 420);
  assert.equal(recordedSeconds(open, at(30)), 420, 'held while paused');
});
