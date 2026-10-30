// Reply on a To do move (FA build loggie-availability; Gio, 2026-10-21, on a prepare move over a recruiter's scheduling
// email: "how come it doesnt allow me to reply though?"). The rule (today-model.js canReplyTo) on moves read from real
// task folders by moveDetail, and the press (do-it.js replyToMove) on a fake Core and a fake ask box. Made-up people.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canReplyTo, firstNameOf, moveGroup, replyTip } from '../desktop/renderer/today-model.js';
import { emailFromOf, moveDetail } from '../src/hikyaku/move-card.js';
import { replyToMove } from '../src/hikyaku/do-it.js';

const RECRUITER = 'kwright2@careers.bank.example';
const SCHEDULING = `# Attempt to schedule: Video Interview\n\n## Kara Wright <${RECRUITER}> · 2026-10-20T14:02:00.000Z\nTo: me@school.example\n\nHi, I am reaching out to schedule your video interview. Please reply with times that work for you.\n`;

async function folder(home, id, files) {
  const dir = join(home, id);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
}

// A move as the workspace page gets it: movesFor's fields plus moveDetail's (main-ipc-workspaces.js).
const moveFrom = async (dir, fields) => ({ id: 'task_x', due: null, waiting: false, ...fields, ...(await moveDetail(dir, { own: ['me@school.example'] })) });

test('canReplyTo: a To do move from a person\'s email gets Reply; one with no email, or a no-reply sender, does not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'move-reply-'));
  const reply = { to: RECRUITER, subject: 'Re: Attempt to schedule: Video Interview', account: 'me@school.example', original: { from: RECRUITER, date: '2026-10-20T14:02:00.000Z', subject: 'Attempt to schedule: Video Interview', messageId: null, rowId: 4242 } };
  const interview = await moveFrom(await folder(home, 'a', { 'REPLY.json': reply, 'THREAD.md': SCHEDULING }),
    { title: 'Prepare for the interview with Dana Lee on Tuesday, October 27 at 3PM EST', kind: 'prep' });
  assert.equal(moveGroup(interview), 'do');
  assert.deepEqual(interview.from, { name: 'Kara Wright', address: RECRUITER, machine: false });
  assert.equal(canReplyTo(interview), true);
  assert.equal(replyTip(interview), 'Reply to Kara in Outlook');

  // A prepare move from a call step: no email in its folder, so no Reply.
  const fromCall = await moveFrom(await folder(home, 'b', { 'REPLY.json': { to: '', subject: '' }, 'THREAD.md': '# Prepare two stories\n\nNo thread: this step comes from a call.\n' }),
    { title: 'Prepare two stories for the team round', kind: 'prep' });
  assert.equal(fromCall.from, null);
  assert.equal(canReplyTo(fromCall), false);
  assert.equal(canReplyTo({ title: 'Prepare for the round', kind: 'prep', app: 'outlook' }), false);

  // A no-reply sender (router.js MACHINE): nobody reads the answer.
  const noReply = await moveFrom(await folder(home, 'c', { 'REPLY.json': { ...reply, to: 'no-reply@careers.bank.example' }, 'THREAD.md': SCHEDULING.replace(RECRUITER, 'no-reply@careers.bank.example') }),
    { title: 'Prepare for the assessment on Friday', kind: 'prep' });
  assert.equal(noReply.from.machine, true);
  assert.equal(canReplyTo(noReply), false);

  // A To send move drafts with Draft it; a chat, an SMS the Mac cannot send, and an ask-box line get no Reply either.
  assert.equal(canReplyTo({ ...interview, kind: 'reply', title: 'Reply to Kara with times' }), false);
  assert.equal(canReplyTo({ ...interview, app: 'messages' }), false);
  assert.equal(canReplyTo({ ...interview, sendable: false }), false);
  assert.equal(emailFromOf({ app: 'whatsapp', to: 'Kara', chatId: '3' }, SCHEDULING), null);
  assert.equal(emailFromOf({ ask: { line: `email Kara: hi`, to: 'Kara' } }, SCHEDULING), null);
  // The thread must hold a message from the reply target: a call's follow-up REPLY.json names an address, not an email.
  assert.equal(emailFromOf({ to: 'lena@bank.example', subject: 'Following up' }, SCHEDULING), null);
});

test('firstNameOf: "Last, First" and "First Last" are both the first name; no name is the address', () => {
  assert.equal(firstNameOf({ name: 'Wright, Kara', address: RECRUITER }), 'Kara');
  assert.equal(firstNameOf({ name: 'Kara Wright', address: RECRUITER }), 'Kara');
  assert.equal(firstNameOf({ name: '', address: RECRUITER }), RECRUITER);
});

function fakeCore(directoryPath) {
  return {
    getTask: async (id) => ({ id, projectId: 'p1', status: 'waiting', title: 'Prepare for the interview' }),
    getProject: async () => ({ id: 'p1', directoryPath }),
    // The move stays To do: a Reply never moves the task.
    transitionTask: async () => { throw new Error('a Reply must not move the task'); },
  };
}

test('replyToMove: the press drafts a reply to that email through the ask box, bound to the address and its thread; the move is not touched', async () => {
  const home = await mkdtemp(join(tmpdir(), 'move-reply-run-'));
  await folder(home, 'task_k', { 'REPLY.json': { to: RECRUITER, subject: 'Re: Attempt to schedule', account: 'me@school.example', original: { from: RECRUITER, rowId: 4242 } }, 'THREAD.md': SCHEDULING });
  const asked = [];
  const ask = async (text, options) => {
    asked.push([text, options]);
    return { outcome: 'placed', status: undefined, did: ['Answering "Attempt to schedule: Video Interview", Oct 20: their newest email', 'Opened the reply in Outlook, unsent'],
      lines: ['Ready in Outlook: Kara Wright. You send it there.'], results: [{ outcome: 'placed', to: 'Kara Wright', app: 'outlook' }] };
  };
  const result = await replyToMove({ core: fakeCore(home), taskId: 'task_k', ask, line: 'happy to, here is my availability next week' });
  assert.deepEqual(asked, [[`email ${RECRUITER}: happy to, here is my availability next week`, { choices: { [RECRUITER]: `outlook:${RECRUITER}`, '@thread': 'apple-mail-4242' }, cloud: null, origin: 'row' }]]);
  assert.equal(result.phase, 'in-mail-app');
  assert.match(result.text, /^Answering "Attempt to schedule: Video Interview", Oct 20: their newest email\. Ready in Outlook: Kara Wright\. You send it there\.$/);

  // No line yet: the box asks for one, and nothing runs.
  assert.equal((await replyToMove({ core: fakeCore(home), taskId: 'task_k', ask, line: '  ' })).phase, 'needs-you');
  // The cloud yes not given: the row asks it (reply-row.js), in the one name the app uses, never "Nemotron".
  const needsYes = await replyToMove({ core: fakeCore(home), taskId: 'task_k', ask: async () => ({ outcome: 'question', status: 'needs-yes', lines: ['To write it, Loggie\'s cloud AI would read the one email from Kara Wright you are answering, and your line. Nothing else leaves this Mac.'] }), line: 'thanks' });
  assert.equal(needsYes.phase, 'needs-you');
  assert.equal(needsYes.kind, 'cloud-yes');
  assert.equal(needsYes.text, 'Loggie\'s cloud AI reads Kara Wright\'s one email and your note to write this. Nothing else leaves this Mac.');
  assert.doesNotMatch(needsYes.text, /Nemotron/);
  assert.equal(asked.length, 1);
});

test('replyToMove: a no-reply sender or a move with no email is refused before the ask box runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'move-reply-refuse-'));
  await folder(home, 'task_n', { 'REPLY.json': { to: 'noreply@careers.bank.example', subject: 'Re: Your assessment' }, 'THREAD.md': SCHEDULING.replace(RECRUITER, 'noreply@careers.bank.example') });
  await folder(home, 'task_c', { 'REPLY.json': { to: '', subject: '' }, 'THREAD.md': '# Prepare\n\nNo thread: this step comes from a call.\n' });
  const ask = async () => { throw new Error('the ask box must not run'); };
  const machine = await replyToMove({ core: fakeCore(home), taskId: 'task_n', ask, line: 'thanks' });
  assert.deepEqual([machine.phase, machine.text], ['failed', 'noreply@careers.bank.example is an automated address; nobody reads replies there.']);
  assert.equal((await replyToMove({ core: fakeCore(home), taskId: 'task_c', ask, line: 'thanks' })).text, 'This move has no email to reply to.');
});
