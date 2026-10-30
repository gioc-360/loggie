import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftPrompt, knownContact } from '../src/hikyaku/nebius-draft.js';
import { saveLine } from '../src/hikyaku/do-it.js';

async function workstream() {
  const root = await mkdtemp(join(tmpdir(), 'known-'));
  const folder = join(root, 'bank-offer');
  for (const name of ['task_new', 'task_old', 'task_call', 'task_cold']) await mkdir(join(folder, name), { recursive: true });
  // A new email to Jamie, who answered the user in another thread of the same workstream.
  await writeFile(join(folder, 'task_new', 'REPLY.json'), JSON.stringify({ to: 'jamie@bank.example' }));
  await writeFile(join(folder, 'task_old', 'THREAD.md'), '# Coffee\n\n## Me <me@school.example> · 2026-10-03T00:00:00.000Z\n\nTo: "Reed, Jamie" <jamie@bank.example>\n\nThanks!\n\n## "Reed, Jamie" <jamie@bank.example> · 2026-10-05T00:00:00.000Z\n\nTo: Me <me@school.example>\n\nI just sent the recruiter an email.');
  await writeFile(join(folder, 'task_call', 'REPLY.json'), JSON.stringify({ to: 'lena@bank.example' }));
  await writeFile(join(folder, 'task_call', 'CALL.md'), '# Call: Me / Lena: bank chat\n- Send a thank-you');
  await writeFile(join(folder, 'task_cold', 'REPLY.json'), JSON.stringify({ to: 'stranger@other.example' }));
  return folder;
}

test('knownContact: someone who wrote or was written to in this workstream, or met on a call, is known; a stranger is not', async () => {
  const folder = await workstream();
  assert.deepEqual(await knownContact(join(folder, 'task_new')), { to: 'jamie@bank.example', why: '2 earlier messages between you' });
  assert.deepEqual(await knownContact(join(folder, 'task_call')), { to: 'lena@bank.example', why: 'you met on a call' });
  assert.equal(await knownContact(join(folder, 'task_cold')), null);
  assert.equal(await knownContact(null), null);
});

test('draftPrompt: for a known person the intros file is left out and the fact is stated; the user\'s line comes last', async () => {
  const folder = await workstream();
  const voice = await mkdtemp(join(tmpdir(), 'voice-'));
  await writeFile(join(voice, 'intros.md'), 'My name is Gio, and I am a first-year MBA student');
  await writeFile(join(voice, 'rules.md'), 'Short sentences.');
  const room = await mkdtemp(join(tmpdir(), 'room-'));
  await mkdir(join(room, 'task_new'));
  await saveLine(join(room, 'task_new'), 'say I can do Monday at 3', { now: new Date('2026-10-11T18:00:00Z') });
  const known = await knownContact(join(folder, 'task_new'));
  const withKnown = await draftPrompt({ prompt: 'Draft it.', room, taskId: 'task_new', voiceDirectory: voice, known });
  assert.doesNotMatch(withKnown.text, /My name is Gio/);
  assert.match(withKnown.text, /jamie@bank\.example already knows the user: 2 earlier messages between you\. Do not introduce the user/);
  assert.ok(withKnown.text.lastIndexOf('say I can do Monday at 3') > withKnown.text.indexOf('already knows the user'), 'the line is last');
  assert.match(withKnown.text, /## What to say, 2026-10-11T18:00\nsay I can do Monday at 3\nThe draft says this/);
  const stranger = await draftPrompt({ prompt: 'Draft it.', room, taskId: 'task_new', voiceDirectory: voice, known: null });
  assert.match(stranger.text, /My name is Gio/);
  assert.doesNotMatch(stranger.text, /already knows the user/);
});
