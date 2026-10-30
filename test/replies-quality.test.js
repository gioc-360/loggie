// docs/replies/spec-a.md R1-R5: email reads email voice, one length number from code, one re-ask, and a DONE after
// the user's note comes back as a question. Temp folders and fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_VOICE, EMAIL_VOICE, VOICE_FILES, draftOnce, draftPrompt, readLength } from '../src/hikyaku/nebius-draft.js';
import { MIN_SENDS, lengthFor, recentMarkdown, writeLength, writeRecentVoice } from '../src/hikyaku/delta.js';
import { voiceForWorkstream } from '../src/hikyaku/cloud.js';
import { answerTask, newestNote, outcomeOf } from '../src/hikyaku/headless.js';
import { bodyWords, coverage, greetingWord, scorecard, signOff, startsCapital } from '../scripts/draft-eval-score.mjs';
import { recordingCore } from './helpers/fake-core.js';

// The archive's nine email sends (sentWords) and their workstreams, plus two chat sends that must never count.
const SENT = [['loggie', 42], ['meniscus', 108], ['meniscus', 73], ['meniscus', 86], ['meniscus', 74], ['meniscus', 89], ['mt', 102], ['mt', 52], ['mt', 23]];
const ROWS = [...SENT.map(([stream, words], i) => ({ task: `task_${stream}_${i}`, sentWords: words })), { task: 'task_chat_1', app: 'messages', sentWords: 6 }, { task: 'task_chat_2', app: 'messages', sentWords: 8 }];

async function voiceFolder() {
  const voice = await mkdtemp(join(tmpdir(), 'replies-voice-'));
  for (const name of VOICE_FILES) await writeFile(join(voice, name), `${name} words`);
  const room = await mkdtemp(join(tmpdir(), 'replies-room-'));
  await mkdir(join(room, 'task_1'));
  await writeFile(join(room, 'task_1', 'BRIEF.md'), '# Reply');
  return { voice, room };
}

test('R1: an email prompt reads no texting.md; a chat prompt reads texting.md and no intros.md', async () => {
  const { voice, room } = await voiceFolder();
  const email = await draftPrompt({ prompt: 'Do it.', room, taskId: 'task_1', voiceDirectory: voice });
  assert.deepEqual(email.files.filter((file) => file.startsWith('voice/')), EMAIL_VOICE.map((name) => `voice/${name}`));
  assert.ok(!email.files.includes('voice/texting.md'));
  const chat = await draftPrompt({ prompt: 'Do it.', room, taskId: 'task_1', voiceDirectory: voice, chat: true });
  assert.deepEqual(chat.files.filter((file) => file.startsWith('voice/')), CHAT_VOICE.map((name) => `voice/${name}`));
  assert.ok(!chat.files.includes('voice/intros.md'));
});

test('R1: the notes label says a new ask in the notes is the move', async () => {
  const { voice, room } = await voiceFolder();
  await writeFile(join(room, 'task_1', 'NOTES.md'), 'She asked for two bullets.');
  const { text } = await draftPrompt({ prompt: 'Do it.', room, taskId: 'task_1', voiceDirectory: voice });
  assert.match(text, /that ask is the move, even when the brief's own steps are finished/);
});

test('R2: lengthFor is the median of email sends, the workstream first, all as the fallback', () => {
  assert.equal(MIN_SENDS, 3);
  assert.deepEqual(lengthFor(ROWS), { median: 74, sends: 9 });
  assert.deepEqual(lengthFor(ROWS, { taskIds: ROWS.filter((row) => row.task.includes('meniscus')).map((row) => row.task) }), { median: 86, sends: 5 });
  assert.deepEqual(lengthFor(ROWS, { taskIds: new Set(['task_loggie_0']) }), { median: 74, sends: 9 }, 'one send falls back to all');
  assert.equal(lengthFor(ROWS.slice(0, 2)), null);
  assert.equal(lengthFor(ROWS.filter((row) => row.app)), null, 'chat sends never count');
});

test('R2: the Length block sits above the edits; no length, no block', () => {
  const edit = { sentAt: '2026-10-04', to: 'a@b.c', subject: 'S', draft: 'one two', sent: 'one' };
  const text = recentMarkdown([edit], { length: { median: 74, sends: 9 } });
  assert.ok(text.indexOf('## Length') < text.indexOf('## 2026-10-04'));
  assert.match(text, /median 74 words \(9 sends\)/);
  assert.match(text, /at or under 74 words/);
  assert.doesNotMatch(recentMarkdown([edit]), /## Length/);
});

test('R2: writeRecentVoice and voiceForWorkstream write length.json; no length removes it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'replies-home-'));
  await writeFile(join(home, 'deltas.jsonl'), ROWS.map((row) => JSON.stringify(row)).join('\n'));
  await writeRecentVoice(home);
  assert.equal(JSON.parse(await readFile(join(home, 'voice', 'length.json'), 'utf8')).median, 74);
  const stream = join(home, 'work', 'meniscus');
  for (const row of ROWS.filter((r) => r.task.includes('meniscus'))) await mkdir(join(stream, row.task), { recursive: true });
  const target = await voiceForWorkstream({ home, directoryPath: stream, shared: join(home, 'voice') });
  assert.equal((await readLength(target)).median, 86);
  assert.match(await readFile(join(target, 'recent.md'), 'utf8'), /median 86 words \(5 sends\)/);
  await writeLength(target, null);
  assert.equal(await readLength(target), null);
});

const answer = (words) => JSON.stringify({ skip_steps: [], file: 'DRAFT.md', content: `Hi Ana,\n\n${Array.from({ length: words }, () => 'word').join(' ')}\n\nBest,\nGio`, subject: '' });
const fakeComplete = (...replies) => { const calls = []; return { calls, complete: async (text) => { calls.push(text); const next = replies.shift(); if (next instanceof Error) throw next; return next; } }; };

test('R3: under the target, one call', async () => {
  const fake = fakeComplete(answer(40));
  const { reasked } = await draftOnce({ complete: fake.complete, text: 'P', length: { median: 40 } });
  assert.equal(fake.calls.length, 1); assert.equal(reasked, false);
});
test('R3: over then shorter keeps the second; the re-ask names the count and the target', async () => {
  const fake = fakeComplete(answer(80), answer(45));
  const result = await draftOnce({ complete: fake.complete, text: 'P', length: { median: 40 } });
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[1], /Your draft was 82 words\. Cut it to 40 words/);
  assert.equal(bodyWords(result.answer.content), 47);
  assert.deepEqual(result.words, [82, 47]);
});
test('R3: over then longer, garbage or a throw keeps the first', async () => {
  for (const second of [answer(90), 'not json', new Error('network')]) {
    const fake = fakeComplete(answer(80), second);
    const result = await draftOnce({ complete: fake.complete, text: 'P', length: { median: 40 } });
    assert.equal(fake.calls.length, 2);
    assert.equal(bodyWords(result.answer.content), 82);
  }
});
test('R3: chat drafts and no length are never re-asked', async () => {
  for (const options of [{ chat: true, length: { median: 10 } }, { length: null }]) {
    const fake = fakeComplete(answer(80));
    await draftOnce({ complete: fake.complete, text: 'P', ...options });
    assert.equal(fake.calls.length, 1);
  }
});

const RUN = { ok: true, denied: [], text: '' };
test('R5: a DONE after a note is a question naming both answers; without notes it closes as before', () => {
  const notes = 'From Gio: the chat already happened.\n\n## Answer to hikyaku, 2026-10-01\nQuestion: x\nAnswer: She asked for two bullets on my interests.';
  const outcome = outcomeOf({ run: RUN, finished: 'The coffee chat already happened.', notes });
  assert.equal(outcome.phase, 'needs-you'); assert.equal(outcome.kind, 'nothing-to-do');
  assert.match(outcome.question, /nothing to do: The coffee chat already happened\. Your newest note says: "She asked for two bullets on my interests\."/);
  assert.match(outcome.question, /Answer "write it anyway" to draft it, or "done" to close it\./);
  assert.deepEqual(outcomeOf({ run: RUN, finished: 'Already handled.' }), { phase: 'nothing-to-do', detail: 'Already handled.' });
  assert.equal(newestNote('# Notes\nfirst\n\nQuestion: q\nAnswer: last'), 'last');
});

const fakeCore = () => recordingCore({ sessionId: 's1', approved: {} });
async function waitingTask() {
  const root = await mkdtemp(join(tmpdir(), 'replies-task-'));
  await mkdir(join(root, 'task_1'));
  await writeFile(join(root, 'task_1', 'STATE.json'), JSON.stringify({ phase: 'needs-you', kind: 'nothing-to-do', agent: 'claude', question: 'Loggie thinks there is nothing to do: It happened. Your newest note says: "two bullets". Answer "write it anyway" to draft it, or "done" to close it.' }));
  return root;
}
test('R5: "done" closes the move with no run; "write it anyway" runs again', async () => {
  const root = await waitingTask();
  const core = fakeCore();
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); setImmediate(() => child.emit('close', 0)); return child; };
  const gateImpl = async () => ({ ok: true, allowed: new Set(), workstream: 'test', files: [] });
  const closed = await (await answerTask({ core, task: { id: 'task_1' }, directoryPath: root, answer: 'done', spawnImpl, gateImpl })).done;
  assert.equal(closed.phase, 'nothing-to-do'); assert.equal(closed.detail, 'It happened');
  assert.equal(spawned, 0);
  assert.ok(core.calls.some(([name, , status]) => name === 'transitionTask' && status === 'done'));
  const again = await waitingTask();
  await (await answerTask({ core: fakeCore(), task: { id: 'task_1' }, directoryPath: again, answer: 'write it anyway', spawnImpl, gateImpl })).done;
  assert.equal(spawned, 1);
  assert.match(await readFile(join(again, 'task_1', 'NOTES.md'), 'utf8'), /Answer: write it anyway/);
});

test('R4: the scorecard checks are wording-independent', () => {
  assert.equal(startsCapital('hi liz,\n\nok'), false); assert.equal(startsCapital('Hi Liz,'), true);
  assert.equal(greetingWord('Hi Liz,'), 'hi'); assert.equal(signOff('Hi,\n\nText.\n\nBest,\nGio'), 'best');
  assert.equal(coverage('budget numbers attached quarterly', 'the budget numbers are attached'), 3 / 4);
  const card = scorecard([{ task: 'eae0f54d', file: 'DRAFT.md', draft: 'Hi Jess,\n\nThe branch is on GitHub.\n\nBest,\nGio', sent: 'Hi Jess,\n\nThe branch is now on GitHub with a guide.\n\nBest,\nGio' }]);
  assert.equal(card.c2Drafts, 1); assert.equal(card.c4Capital, 1); assert.equal(card.c5Greeting, 1); assert.equal(card.c6SignOff, 1);
});

test('R3b: an answer out of shape is asked again once; a second bad answer keeps the error; no length re-ask follows', async () => {
  const bad = JSON.stringify({ skip_steps: [], file: 'SUBJECT.txt', content: 'x' });
  const fixed = fakeComplete(bad, answer(80));
  const result = await draftOnce({ complete: fixed.complete, text: 'P', length: { median: 40 } });
  assert.equal(fixed.calls.length, 2); assert.equal(result.retried, true); assert.equal(result.answer.file, 'DRAFT.md');
  assert.match(fixed.calls[1], /not in the agreed shape/);
  const still = fakeComplete(bad, bad);
  const failed = await draftOnce({ complete: still.complete, text: 'P' });
  assert.equal(still.calls.length, 2); assert.equal(failed.answer.ok, false);
});

test('R6: the card voice is the drafting target plus this workstream\'s own send count', async () => {
  const { voiceFor } = await import('../src/hikyaku/delta.js');
  const meniscus = ROWS.filter((row) => row.task.includes('meniscus')).map((row) => row.task);
  assert.deepEqual(voiceFor(ROWS, meniscus), { median: 86, sends: 5, here: 5 });
  assert.deepEqual(voiceFor(ROWS, ['task_loggie_0']), { median: 74, sends: 9, here: 1 }, 'under 3 here: the overall target, said so');
  assert.deepEqual(voiceFor(ROWS.slice(0, 2), []), { median: null, sends: 0, here: 0 });
});
