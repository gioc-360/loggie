// loggie-intros I1 (docs/intros/spec.md 1.3-1.5, with the code-made move: spike S-C, 2026-10-20, Nemotron proposed
// the email in 0 of 3 runs, so code makes it). A movable introduction becomes one "Email <name>" move whose REPLY.json
// holds the bound address; Draft it asks for a line first, then hands the ask box that address as a choice key.
// Fakes and temp folders only; made-up people.
// The title's day is the email's on this Mac's clock: pinned to one zone so the test reads the same everywhere.
process.env.TZ = 'America/New_York';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { introsIn, movable } from '../src/hikyaku/introduced.js';
import { catchUp, introTitle } from '../src/hikyaku/workstreams.js';
import { moveDetail } from '../src/hikyaku/move-card.js';
import { doIt } from '../src/hikyaku/do-it.js';
import { currentState } from '../src/hikyaku/headless.js';
import { storeCore, taskCore } from './helpers/fake-core.js';

const ME = 'gio@school.example';
const own = [ME];
const DANA = 'dana.okafor@bank.example';
const BANK = { name: 'Bank', kind: 'company', goal: 'Get an offer', domains: ['bank.example'], words: [] };
const mine = { id: 'm1', from: `Gio Tanaka <${ME}>`, to: 'Jordan Reyes <jreyes@bank.example>', cc: '', subject: 'Thank you', timestamp: '2026-10-14T15:00:00Z', body: 'Thank you for Monday.' };
const intro = { id: 'm2', from: 'Jordan Reyes <jreyes@bank.example>', to: ME, cc: '', subject: 'RE: Thank you', timestamp: '2026-10-16T20:55:10Z',
  body: `Hi Gio! Have you connected before with Dana Okafor: ${DANA}<mailto:${DANA}> She's on our data team.\n\nBest,\nJordan` };
const thread = { id: 'outlook:41', sourceType: 'manual', subject: 'RE: Thank you', latestTimestamp: intro.timestamp, messages: [mine, intro] };
const writtenTo = new Set(['jreyes@bank.example']);
const found = () => introsIn([thread], { own, writtenTo });

const fakeCore = () => storeCore({ projectId: () => 'p1', brief: 'draft' });
const answer = (actions = []) => async () => JSON.stringify({ summary: 'Jordan is still looking for a tech contact.', promised: [], open: [], actions });
// The model naming her anyway: on an email thread the model's email action is never kept (there is no model binding).
const modelEmail = (to) => ({ title: `Email ${to}`, kind: 'email', thread: 1, to, ask: '', quote: 'Have you connected before with Dana Okafor', steps: [] });
async function run({ actions = [], intros = movable(found(), []), core = fakeCore(), workRoot = null } = {}) {
  const root = workRoot || await mkdtemp(join(tmpdir(), 'intros-move-'));
  const log = await catchUp({ workstream: BANK, threads: [thread], complete: answer(actions), core, workRoot: root, ownAddress: own, today: '2026-10-20', intros });
  return { log, core, root };
}

const TITLE = 'Email Dana Okafor (introduced by Jordan, Oct 16)';

test('1.3 a movable introduction is one "Email Dana Okafor (introduced by Jordan, Oct 16)" move by code, whatever the model says', async () => {
  const { log, core } = await run({ actions: [modelEmail('Dana Okafor'), modelEmail('Jordan Reyes')] });
  assert.deepEqual(core.tasks.map((task) => task.title), [TITLE]);
  assert.doesNotMatch(core.tasks[0].title, /@|\b(?:she|he|her|his|him|hers)\b/i, 'no address and no pronoun in the title');
  assert.equal(log.dropped, 2, 'the model\'s email actions on an email thread drop, as before');
  assert.deepEqual(log.intros, { moves: 1 });
});

test('1.3 no move for a pair written to since, for no intros map, for the quiet goal, and never twice', async () => {
  assert.equal((await run({ intros: movable(found(), [{ to: [DANA], timestamp: '2026-10-20T14:17:00Z' }]) })).core.tasks.length, 0, 'written to after `at`');
  const none = await run({ intros: null, actions: [modelEmail('Dana Okafor')] });
  assert.equal(none.core.tasks.length, 0, 'no intros map: the email action drops as today');
  assert.equal(none.log.intros, undefined);
  const quiet = await mkdtemp(join(tmpdir(), 'intros-quiet-'));
  const core = fakeCore();
  await catchUp({ workstream: { ...BANK, goal: 'Just keep me posted' }, threads: [thread], complete: answer(), core, workRoot: quiet, ownAddress: own, today: '2026-10-20', intros: movable(found(), []) });
  assert.equal(core.tasks.length, 0, 'a workspace on "Just keep me posted" gets no moves');
  const again = await run();
  const second = await run({ core: again.core, workRoot: again.root });
  assert.equal(again.core.tasks.length, 1);
  assert.deepEqual({ already: second.log.already, moves: second.log.intros.moves }, { already: 1, moves: 0 });
});

test('1.4 the task, BRIEF.md and REPLY.json are as specced; the card shows her address and no ask line', async () => {
  const { core } = await run();
  const [task] = core.tasks;
  assert.deepEqual({ sourceType: task.sourceType, sourceId: task.sourceId }, { sourceType: 'manual', sourceId: 'outlook:41:email:dana-okafor' });
  const folder = join(core.projects[0].directoryPath, task.id);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'REPLY.json'), 'utf8')), {
    ask: { line: 'email Dana Okafor', to: 'Dana Okafor', ask: '', address: DANA, from: 'intro', by: 'jreyes@bank.example', at: '2026-10-16T20:55:10.000Z' }, fromChat: null });
  const brief = await readFile(join(folder, 'BRIEF.md'), 'utf8');
  assert.ok(brief.startsWith(`# ${TITLE}\n`));
  assert.match(brief, /> Have you connected before with Dana Okafor: \[address kept on this Mac\]/);
  assert.match(brief, /A new email to the person introduced in this thread is open in the user's mail app, unsent\./);
  assert.match(core.briefs[0].context, /Quoted from the email:\n"Have you connected before with Dana Okafor: \[address kept on this Mac\]/);
  assert.deepEqual(core.briefs[0].completionCriteria, ['A new email to the person introduced in this thread is open in the user\'s mail app, unsent.']);
  const detail = await moveDetail(folder, { own });
  assert.deepEqual({ to: detail.to, askLine: detail.askLine, app: detail.app }, { to: DANA, askLine: null, app: 'outlook' });
});

// Core in memory with its own transitions (src/core/domain.js), as the W5 tests use.
const memoryCore = (task, directoryPath) => taskCore(task, { directoryPath, brief: 'draft', sessions: false });

test('1.5 Draft it with no line asks what to say and never calls the ask box; with a line it passes the bound address as the choice key', async () => {
  const { core, root } = await run();
  const [task] = core.tasks;
  const directoryPath = core.projects[0].directoryPath;
  const folder = join(directoryPath, task.id);
  const calls = [];
  const ask = async (text, options) => { calls.push({ text, options }); return { outcome: 'failed', lines: ['Dana Okafor\'s address is not in Loggie yet. Refresh the workspace'] }; };
  const memory = memoryCore(task, directoryPath);
  const first = await doIt({ core: memory, taskId: task.id, home: root, options: { ask } });
  assert.equal(calls.length, 0, 'no line: the ask box is never called');
  const state = await currentState(folder);
  assert.deepEqual({ phase: state.phase, kind: state.kind, question: state.question }, { phase: 'needs-you', kind: 'ask-move', question: 'Type what to say to Dana Okafor in the line box, then Draft it.' });
  assert.equal(first.phase, 'needs-you');
  await doIt({ core: memory, taskId: task.id, home: root, options: { ask }, line: 'ask if she has 20 minutes next week' });
  assert.deepEqual(calls, [{ text: 'email Dana Okafor: ask if she has 20 minutes next week', options: { choices: { 'Dana Okafor': `outlook:${DANA}` }, origin: 'move' } }]);
  // The wrapper's answer when the address is not in the who index: a question on the card, nothing guessed.
  assert.match((await currentState(folder)).question, /^Dana Okafor's address is not in Loggie yet\. Refresh the workspace\./);
});

const AT = { name: 'Dana Okafor', at: '2026-10-16T20:55:10Z' };

test('TC3 a "Last, First" sender is named by the part after the comma; the day is the email\'s on this Mac', () => {
  assert.equal(introTitle(AT, '"Reyes, Jordan" <jreyes@bank.example>'), TITLE);
  assert.equal(introTitle(AT, 'Reyes, Jordan M. <jreyes@bank.example>'), TITLE);
  assert.equal(introTitle({ ...AT, at: '2026-10-17T02:30:00Z' }, 'Jordan Reyes <jreyes@bank.example>'), TITLE, '02:30Z is still Oct 16 in New York');
});

test('TC3 a sender with no name gives "introduced <Mon D>", never the address', () => {
  assert.equal(introTitle(AT, 'jreyes@bank.example'), 'Email Dana Okafor (introduced Oct 16)');
  assert.equal(introTitle(AT, '<jreyes@bank.example>'), 'Email Dana Okafor (introduced Oct 16)');
  assert.equal(introTitle(AT, ''), 'Email Dana Okafor (introduced Oct 16)');
});
