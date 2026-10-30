import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createVoiceInput } from '../desktop/voice-input.js';
test('voice lifecycle starts one helper, forwards transcripts, and stops through stdin', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const updates = []; let count = 0;
  const voice = createVoiceInput({ helper: '/voice', emit: x => updates.push(x), spawnImpl: () => { count++; return child; } });
  voice.start(); assert.throws(() => voice.start(), /already/); assert.equal(count, 1);
  child.stdout.write('{"status":"listening"}\n{"text":"open my project"}\n');
  assert.equal(updates[1].text, 'open my project');
  let stop; child.stdin.on('data', data => stop = data.toString()); voice.stop(); assert.equal(stop, 'stop\n');
  child.emit('exit', 0); assert.equal(updates.at(-1).status, 'stopped');
});
test('missing bundled helper reports an actionable error', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const updates = []; const voice = createVoiceInput({ helper: '/missing', emit: x => updates.push(x), spawnImpl: () => child });
  voice.start(); child.emit('error', new Error('ENOENT')); assert.match(updates[0].error, /updated Loggie build/);
});

test('onboarding requests permissions without starting dictation', () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let args; const updates = [];
  const voice = createVoiceInput({ helper: '/voice', emit: data => updates.push(data), spawnImpl: (_path, flags) => { args = flags; return child; } });
  voice.start({ authorizeOnly: true }); assert.deepEqual(args, ['--authorize']);
  child.stdout.write('{"status":"permissions-granted"}\n'); child.emit('exit', 0);
  assert.equal(updates[0].status, 'permissions-granted'); assert.equal(updates[1].status, 'permissions-complete');
});
