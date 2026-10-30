import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// These tests are about the run, not the cloud gate (test/hikyaku-cloud-gate.test.js): the gate approves.
const APPROVED = async () => ({ ok: true, allowed: new Set(), workstream: 'test', files: [] });
import { headlessPrompt, outcomeOf, stepChecks } from '../src/hikyaku/headless.js';
import { parseYourStep, promiseQuestion, quoteFound, unbackedPromises, userWordsIn, yourStepQuestion } from '../src/hikyaku/steps.js';

const SYLLABUS = 'MODE OF INSTRUCTION\nIf you believe you qualify for medical accommodation, please reach out to Student Disability Services. We are happy to offer\nattendance by Zoom as an option for those who qualify.';
const BRIEF = "# Tell the professor\n\n## What happened, in the user's words\n> I hurt my leg playing basketball and cannot walk. I miss next week.\n\n## Steps\n1. ...";
const run = { ok: true, denied: [], text: '' };

test('a step only the user can take becomes a question with the syllabus quote, checked against the syllabus', () => {
  const step = parseYourStep('Step: Contact Student Disability Services\nWhy: Zoom is only for students who qualify through them\nQuote: "We are happy to offer attendance by Zoom as an option for those who qualify."');
  assert.equal(step.step, 'Contact Student Disability Services');
  assert.ok(quoteFound(step.quote, [SYLLABUS]));
  const question = yourStepQuestion(step, true);
  assert.match(question, /^Before this email, a step only you can take: Contact Student Disability Services\./);
  assert.match(question, /"done".*"not yet".*"skip"/);
  assert.doesNotMatch(question, /could not find/);
  assert.match(question, /for those who qualify\." Answer/);
  assert.equal(quoteFound('Zoom recordings are always posted', [SYLLABUS]), false);
  assert.match(yourStepQuestion({ ...step, quote: 'Zoom recordings are always posted' }, false), /could not find these exact words/);
});

test('promises the user never made are caught; ordinary sentences are not', () => {
  const userWords = userWordsIn(BRIEF);
  assert.equal(userWords, 'I hurt my leg playing basketball and cannot walk. I miss next week.');
  const draft = 'Hi Professor,\n\nPer the syllabus, I am contacting Student Disability Services regarding medical accommodation. I am writing to request permission to attend via Zoom. I will catch up on the readings. If I miss more classes, I will coordinate with SDS for formal accommodations.\n\nBest regards,';
  const found = unbackedPromises(draft, { userWords });
  assert.deepEqual(found, ['Per the syllabus, I am contacting Student Disability Services regarding medical accommodation.', 'If I miss more classes, I will coordinate with SDS for formal accommodations.']);
  assert.match(promiseQuestion(found), /commits you to something you never said/);
});

test('a promise is fine when the user said it, or already answered a question quoting it', () => {
  const sentence = 'I have contacted Student Disability Services about an accommodation.';
  assert.deepEqual(unbackedPromises(sentence, { userWords: 'I contacted Student Disability Services yesterday about an accommodation.' }), []);
  assert.deepEqual(unbackedPromises(sentence, { notes: `Question: The draft says "${sentence}" ...\nAnswer: keep` }), []);
  assert.equal(unbackedPromises(sentence).length, 1);
});

test('your-step comes before drafting, and a draft with a promise stops before it opens', () => {
  assert.deepEqual(outcomeOf({ run, yourStep: 'Before this email...', drafted: true }), { phase: 'needs-you', kind: 'your-step', question: 'Before this email...' });
  assert.deepEqual(outcomeOf({ run, promise: 'The draft says...', drafted: true }), { phase: 'needs-you', kind: 'promise', question: 'The draft says...' });
  assert.deepEqual(outcomeOf({ run, drafted: true }), { action: 'open-draft' });
  assert.deepEqual(outcomeOf({ run, promise: 'The draft says...', drafted: false, finished: 'Handled.' }), { phase: 'nothing-to-do', detail: 'Handled.' });
});

test('the task folder is checked: the step quote against SYLLABUS.txt, the draft against the brief and notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-steps-'));
  await writeFile(join(dir, 'SYLLABUS.txt'), SYLLABUS);
  await writeFile(join(dir, 'BRIEF.md'), BRIEF);
  await writeFile(join(dir, 'YOUR-STEP.md'), 'Step: Contact Student Disability Services\nWhy: Zoom needs it\nQuote: please reach out to Student Disability Services');
  await writeFile(join(dir, 'DRAFT.md'), 'I am contacting Student Disability Services this week.');
  const checks = await stepChecks(dir, { stepWritten: true, drafted: true });
  assert.match(checks.yourStep, /The source says: "please reach out to Student Disability Services"\./);
  assert.match(checks.promise, /"I am contacting Student Disability Services this week\."/);
  assert.deepEqual(await stepChecks(dir, {}), { yourStep: '', promise: '' });
});

test('the agent is told to write YOUR-STEP.md and never to claim what the user has not said', () => {
  const prompt = headlessPrompt('task_1');
  assert.match(prompt, /task_1\/YOUR-STEP\.md: .*"Step: \.\.\.", "Why: \.\.\.", "Quote: \.\.\."/);
  assert.match(prompt, /Never write that the user did, is doing or will do something they have not said/);
});

test('a reply that cannot be placed on its email stops and asks; the answer opens the kept draft without a new run', async () => {
  const { mkdtemp: temp, writeFile: write } = await import('node:fs/promises');
  const { answerTask, notFound, readState, writeState } = await import('../src/hikyaku/headless.js');
  const dir = await temp(join(tmpdir(), 'hikyaku-notfound-'));
  await (await import('node:fs/promises')).mkdir(join(dir, 'task_1'));
  const asked = notFound({ reason: 'Outlook search found no email with this subject.' });
  assert.deepEqual([asked.phase, asked.kind], ['needs-you', 'reply-not-found']);
  assert.match(asked.question, /Answer "again" to look for the email again, or "new" to open it as a new message/);
  await writeState(join(dir, 'task_1'), { ...asked, agent: 'claude', session: 's1' });
  const opened = [];
  const openDraftImpl = async (options) => { opened.push(options); return options.allowNew ? { mode: 'new-message', opened: 'outlook' } : { mode: 'not-found', reason: 'Still not found.' }; };
  const again = await (await answerTask({ gateImpl: APPROVED,  core: {}, task: { id: 'task_1' }, directoryPath: dir, answer: 'again', openDraftImpl })).done;
  assert.equal(again.kind, 'reply-not-found'); assert.match(again.question, /Still not found/);
  const asNew = await (await answerTask({ gateImpl: APPROVED,  core: {}, task: { id: 'task_1' }, directoryPath: dir, answer: 'new', openDraftImpl })).done;
  assert.equal(asNew.phase, 'in-mail-app');
  assert.deepEqual(opened.map((o) => [o.again, o.allowNew]), [[true, false], [true, true]], 'no agent run; only the kept draft is opened');
  assert.equal((await readState(join(dir, 'task_1'))).phase, 'in-mail-app');
  void write;
});
