import test from 'node:test';
// These tests are about the run, not the cloud gate (test/hikyaku-cloud-gate.test.js): the gate approves.
const APPROVED = async () => ({ ok: true, allowed: new Set(), workstream: 'test', files: [] });
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerTask, closeSent, currentState, headlessPrompt, openReplies, outcomeOf, startHeadless } from '../src/hikyaku/headless.js';
import { recordingCore } from './helpers/fake-core.js';

const fakeCore = () => recordingCore({ sessions: [{ id: 'session_old', status: 'running', processId: 999999 }] });

// A stand-in for the drafting run: prints its one line, may write files in the task folder, then exits.
function fakeAgent({ lines = [], stderr = '', exitCode = 0, act = async () => {} }) {
  const seen = [];
  const spawnImpl = (bin, args, options) => {
    seen.push({ bin, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(async () => {
      await act();
      for (const line of lines) child.stdout.emit('data', `${JSON.stringify(line)}\n`);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
  return { spawnImpl, seen };
}

async function taskFolder() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-headless-'));
  await mkdir(join(root, 'task_1'));
  return root;
}

// The one line nebius-draft.js prints for a run (nebiusSpawn).
const nebiusOk = (text = 'Wrote DRAFT.md.') => [{ type: 'nebius', ok: true, text, error: null }];

test('the prompt asks for one result file and no commands', () => {
  const prompt = headlessPrompt('task_1', { voiceDirectory: '/v' });
  for (const file of ['DRAFT.md', 'EVENT.json', 'NEEDS.md', 'DONE.md', 'CALENDAR.md', 'NOTES.md']) assert.ok(prompt.includes(`task_1/${file}`), file);
  assert.match(prompt, /Do not run any commands/);
  assert.match(prompt, /\/v\/recent\.md/);
});

test('what the run left behind decides what happens next', () => {
  const ok = { ok: true, text: 'Done.', denied: [], error: null };
  assert.deepEqual(outcomeOf({ run: ok, drafted: true }), { action: 'open-draft' });
  assert.equal(outcomeOf({ run: ok, drafted: true, hold: true }).phase, 'ready', 'held for open my replies');
  assert.deepEqual(outcomeOf({ run: ok, evented: true }), { action: 'open-event' });
  assert.deepEqual(outcomeOf({ run: ok, drafted: true, needs: 'Which day?' }), { phase: 'needs-you', kind: 'question', question: 'Which day?' }, 'a question beats a draft');
  assert.deepEqual(outcomeOf({ run: ok, finished: 'Already sent.' }), { phase: 'nothing-to-do', detail: 'Already sent.' });
  assert.equal(outcomeOf({ run: { ...ok, denied: ['ViewFile'] } }).kind, 'permission');
  assert.match(outcomeOf({ run: { ok: false, text: '', denied: [], error: 'unauthorized (401)' } }).question, /failed: unauthorized \(401\)/);
  assert.equal(outcomeOf({ run: { ...ok, text: 'Should I mention the Denver role?' } }).question, 'Should I mention the Denver role?', 'a run that writes nothing is asking something');
});

test('a run that writes a draft is opened by hikyaku, with the calendar read first and no terminal', async () => {
  const root = await taskFolder();
  const core = fakeCore();
  const opened = [];
  const { spawnImpl, seen } = fakeAgent({ lines: nebiusOk(), act: () => writeFile(join(root, 'task_1', 'DRAFT.md'), 'Hi Ana,\n\nFriday works.\n\nBest regards,') });
  const run = await startHeadless({ gateImpl: APPROVED,  core, task: { id: 'task_1', status: 'briefed' }, directoryPath: root, voiceDirectory: '/v', spawnImpl,
    calendarText: async () => 'Offer these: Mon 10:00 AM',
    openDraftImpl: async ({ taskDirectory }) => { opened.push(taskDirectory); return { mode: 'reply', opened: 'outlook', detail: 'Reply opened.' }; } });
  assert.equal((await currentState(join(root, 'task_1'), { alive: () => true })).phase, 'drafting');
  const state = await run.done;
  assert.deepEqual([state.phase, state.detail, state.session, state.agent], ['in-mail-app', 'Reply opened.', null, 'nebius']);
  assert.deepEqual(opened, [join(root, 'task_1')]);
  assert.equal(await readFile(join(root, 'task_1', 'CALENDAR.md'), 'utf8'), 'Offer these: Mon 10:00 AM');
  assert.equal(seen[0].options.cwd, root);
  assert.deepEqual([seen[0].bin, seen[0].args.length], ['nebius', 1], 'one request with the prompt, no CLI');
  assert.equal(core.calls.find(([name]) => name === 'createSession')[1].terminalKind, 'shell');
  assert.deepEqual(core.calls.filter(([name]) => name === 'transitionTask').map((call) => call[2]), ['running'], 'stays running until it is sent');
  assert.deepEqual(core.calls.find(([name, id]) => name === 'transitionSession' && id === 'session_old'), ['transitionSession', 'session_old', 'failed'], 'a dead old session is closed first');
  assert.match(await readFile(join(root, 'task_1', 'RUN.jsonl'), 'utf8'), /"type":"nebius"/);
});

test('a written event is opened by hikyaku and logged', async () => {
  const root = await taskFolder();
  const { spawnImpl } = fakeAgent({ lines: nebiusOk('Wrote EVENT.json.'), act: () => writeFile(join(root, 'task_1', 'EVENT.json'), '{}') });
  const state = await (await startHeadless({ gateImpl: APPROVED,  core: fakeCore(), task: { id: 'task_1', status: 'briefed' }, directoryPath: root, spawnImpl,
    openEventImpl: async () => ({ title: 'Coffee', start: new Date('2026-10-09T14:00:00Z'), attendees: ['ana@example.com'], opened: 'outlook' }) })).done;
  assert.equal(state.phase, 'event-open');
  assert.match(state.detail, /"Coffee" is open in your calendar app/);
  assert.match(await readFile(join(root, 'task_1', 'ATTEMPTS.jsonl'), 'utf8'), /"mode":"event"/);
});

test('a question blocks the task; the answer restarts the run with the answer in NOTES.md', async () => {
  const root = await taskFolder();
  const core = fakeCore();
  const asks = fakeAgent({ lines: nebiusOk('Wrote NEEDS.md.'), act: () => writeFile(join(root, 'task_1', 'NEEDS.md'), 'Which Friday works for you?\n') });
  const waiting = await (await startHeadless({ gateImpl: APPROVED,  core, task: { id: 'task_1', status: 'briefed' }, directoryPath: root, spawnImpl: asks.spawnImpl })).done;
  assert.deepEqual([waiting.phase, waiting.question, waiting.agent], ['needs-you', 'Which Friday works for you?', 'nebius']);
  assert.deepEqual(core.calls.filter(([name]) => name === 'transitionTask').at(-1).slice(2), ['blocked', 'Needs you: Which Friday works for you?']);

  const reruns = fakeAgent({ lines: nebiusOk(), act: () => writeFile(join(root, 'task_1', 'DRAFT.md'), 'Hi,\n\nOct 9.\n\nBest,') });
  const second = await answerTask({ gateImpl: APPROVED,  core, task: { id: 'task_1', status: 'blocked' }, directoryPath: root, answer: 'Oct 9', spawnImpl: reruns.spawnImpl, openDraftImpl: async () => ({ mode: 'reply', detail: 'Reply opened.' }) });
  assert.equal((await second.done).phase, 'in-mail-app');
  assert.deepEqual(reruns.seen[0].args.length, 1, 'no session in the args');
  assert.match(reruns.seen[0].args[0], /Read task_1\/BRIEF\.md/, 'the run starts over and reads the answer from the notes');
  assert.match(await readFile(join(root, 'task_1', 'NOTES.md'), 'utf8'), /Question: Which Friday works for you\?\nAnswer: Oct 9/);
  const fresh = await taskFolder();
  await assert.rejects(answerTask({ gateImpl: APPROVED,  core: fakeCore(), task: { id: 'task_1' }, directoryPath: fresh, answer: 'again' }), /not waiting on an answer/);
});

test('a run left drafting by a Loggie that quit reads as failed, not forever drafting', async () => {
  const root = await taskFolder();
  await writeFile(join(root, 'task_1', 'STATE.json'), JSON.stringify({ phase: 'drafting', pid: 999999, at: 'x' }));
  assert.equal((await currentState(join(root, 'task_1'), { alive: () => false })).phase, 'failed');
});

test('a task whose email is found sent closes: state sent, Core done, once', async () => {
  const root = await taskFolder();
  const directory = join(root, 'task_1');
  await writeFile(join(directory, 'STATE.json'), JSON.stringify({ phase: 'in-mail-app', session: 's' }));
  await writeFile(join(directory, 'DELTA.md'), '# What you changed\n\nSent 2026-10-05T12:00:00Z to lena@acmebank.com, found in Apple Mail (Outlook Sent).\nDraft 80 words, sent 82. Kept 75, added 7, removed 5. Edit ratio 0.15.\n');
  const core = { ...fakeCore(), getTask: async () => ({ id: 'task_1', status: 'running' }) };
  assert.equal((await closeSent({ core, taskDirectories: [directory, join(root, 'no-delta')] })).length, 1);
  const state = await currentState(directory);
  assert.deepEqual([state.phase, state.editRatio], ['sent', 0.15]);
  assert.deepEqual(core.calls.filter(([name]) => name === 'transitionTask').map((call) => call[2]), ['done']);
  assert.deepEqual(await closeSent({ core, taskDirectories: [directory] }), [], 'a sent task is closed once');
});

test('open my replies opens every held draft in turn and leaves the rest alone', async () => {
  const root = await taskFolder();
  const make = async (name, phase) => { await mkdir(join(root, name), { recursive: true }); await writeFile(join(root, name, 'STATE.json'), JSON.stringify({ phase })); return join(root, name); };
  const directories = [await make('task_a', 'ready'), await make('task_b', 'needs-you'), await make('task_c', 'ready')];
  const order = [];
  const open = async ({ taskDirectory }) => {
    order.push(taskDirectory.split('/').pop());
    return taskDirectory.endsWith('task_c') ? { mode: 'failed', reason: 'Outlook is not open' } : { mode: 'reply', detail: 'Reply opened.' };
  };
  assert.deepEqual((await openReplies({ taskDirectories: directories, open })).map((r) => r.mode), ['reply', 'failed']);
  assert.deepEqual(order, ['task_a', 'task_c'], 'one at a time, only the ready ones');
  assert.equal((await currentState(directories[0])).phase, 'in-mail-app');
  assert.equal((await currentState(directories[1])).phase, 'needs-you');
  assert.match((await currentState(directories[2])).question, /Outlook is not open/);
});
