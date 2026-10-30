// workspaces-outlook W5: a text that asks the user to email someone else becomes an email move. The catch-up keeps it
// only when the chat names the person and asks for contact; Do it runs its one line through the ask box and keeps the
// draft as the move's own. Fakes only: no model, no mail app.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkActions } from '../src/hikyaku/workstreams.js';
import { answerMove, doIt } from '../src/hikyaku/do-it.js';
import { closeSent } from '../src/hikyaku/headless.js';

const LIAM = 'Can you email K-House and ask if we can set up a $500 bar tab for Thursday?';
const chat = { id: 'messages:chat1', subject: 'Liam', sourceType: 'messages', chat: { app: 'messages', isGroup: false }, messages: [
  { fromMe: false, from: '+16075550100', timestamp: '2026-10-17T12:14:00.000Z', body: LIAM },
] };
const action = (fields = {}) => ({ actions: [{ title: 'Email K-House about the $500 bar tab', kind: 'email', thread: 1, quote: LIAM, to: 'K-House', ask: 'ask if we can set up a $500 bar tab for Oct 22', steps: [], ...fields }] });

test('a chat that names someone and asks for contact is an email move with its person and its ask', () => {
  const { actions, dropped } = checkActions(action(), [chat], 'gio@school.edu');
  assert.equal(dropped, 0);
  assert.deepEqual(actions[0].email, { to: 'K-House', ask: 'ask if we can set up a $500 bar tab for Oct 22' });
  assert.equal(actions[0].kind, 'email');
});

test('anything looser is dropped: an email thread, a person the chat never named, the user\'s own words, no ask', () => {
  const email = { ...chat, chat: undefined, sourceType: undefined, messages: [{ ...chat.messages[0], from: 'Liam <liam@school.edu>' }] };
  assert.equal(checkActions(action(), [email], 'gio@school.edu').actions.length, 0, 'never from an email thread');
  assert.equal(checkActions(action({ to: 'Rhonda' }), [chat], 'gio@school.edu').actions.length, 0, 'the chat must name the person');
  const mine = { ...chat, messages: [{ ...chat.messages[0], fromMe: true }] };
  assert.equal(checkActions(action(), [mine], 'gio@school.edu').actions.length, 0, 'the user asking themselves is not a request');
  assert.equal(checkActions(action({ ask: '' }), [chat], 'gio@school.edu').actions.length, 0);
  for (const body of ['tell K-House thanks', 'I will message K-House myself', 'did you email K-House yet?', 'lmk what K-House says']) {
    const said = { ...chat, messages: [{ ...chat.messages[0], body }] };
    assert.equal(checkActions(action({ quote: body }), [said], 'gio@school.edu').actions.length, 0, body);
  }
  const noAsk = { ...chat, messages: [{ ...chat.messages[0], body: 'K-House was fun last year' }] };
  assert.equal(checkActions(action({ quote: 'K-House was fun last year' }), [noAsk], 'gio@school.edu').actions.length, 0, 'naming a place is not asking for contact');
});

// Core in memory, with Core's own transitions (src/core/domain.js), so a move that never leaves "waiting" fails here.
function core(directoryPath) {
  const task = { id: 'task_1', projectId: 'p1', status: 'waiting', title: 'Email K-House about the $500 bar tab', sourceType: 'messages' };
  const allowed = { waiting: ['briefed'], briefed: ['waiting', 'running'], running: ['waiting', 'blocked', 'done'], blocked: ['waiting', 'running', 'done'], done: ['waiting'] };
  const brief = { id: 'brief_1', status: 'draft' };
  return { task, getTask: async () => ({ ...task }), getProject: async () => ({ id: 'p1', directoryPath }),
    getApprovedBrief: async () => (brief.status === 'approved' ? brief : null), getLatestBrief: async () => brief, approveBrief: async () => { brief.status = 'approved'; return brief; },
    transitionTask: async (id, to) => { if (!allowed[task.status].includes(to)) throw new Error(`Core refuses ${task.status} -> ${to}`); task.status = to; return { ...task }; } };
}

async function move() {
  const home = await mkdtemp(join(tmpdir(), 'w5-home-'));
  const directoryPath = await mkdtemp(join(tmpdir(), 'w5-work-'));
  const taskDirectory = join(directoryPath, 'task_1');
  await mkdir(taskDirectory, { recursive: true });
  const fromChat = { app: 'messages', chatId: 'chat1', to: 'Liam', isGroup: false };
  await writeFile(join(taskDirectory, 'REPLY.json'), JSON.stringify({ ask: { line: 'email K-House: ask if we can set up a $500 bar tab for Oct 22', to: 'K-House', ask: 'ask if we can set up a $500 bar tab for Oct 22' }, fromChat }));
  return { home, directoryPath, taskDirectory, fromChat };
}

// The asker's finish for a placed email: its folder holds what prepareEmailReply wrote.
const placedBy = (home, lines = []) => async (text) => {
  lines.push(text);
  const folder = join(home, 'asks', 'a1');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: 'bookings@khouse.example', subject: 'Re: October 22nd', account: 'gio@school.edu', original: { from: 'bookings@khouse.example', subject: 'October 22nd' } }));
  await writeFile(join(folder, 'DRAFT.md'), 'Hi K-HOUSE,\n\nCould we set up a $500 bar tab?\n\nBest,');
  await writeFile(join(folder, 'THREAD.md'), '# October 22nd\n');
  return { askId: 'a1', outcome: 'placed', did: ['Answering "October 22nd"'], results: [{ to: 'K-HOUSE Karaoke', app: 'outlook', outcome: 'placed' }] };
};

test('Do it runs the line through the ask box, keeps the draft as the move\'s own, and closes when the email is sent', async () => {
  const { home, directoryPath, taskDirectory, fromChat } = await move();
  const lines = [];
  const never = async () => { throw new Error('the chat drafter must not run'); };
  const memory = core(directoryPath);
  const result = await doIt({ core: memory, taskId: 'task_1', home, options: { ask: placedBy(home, lines) }, startImpl: never });
  assert.deepEqual(lines, ['email K-House: ask if we can set up a $500 bar tab for Oct 22']);
  assert.equal(result.phase, 'in-mail-app');
  assert.match(result.text, /^The email to K-HOUSE Karaoke is open in Outlook, unsent\./);
  assert.equal(memory.task.status, 'running', 'a placed move is running, as a drafted one is');
  const reply = JSON.parse(await readFile(join(taskDirectory, 'REPLY.json'), 'utf8'));
  assert.equal(reply.to, 'bookings@khouse.example', 'an email move now: sent mail to K-House closes it');
  assert.deepEqual(reply.fromChat, fromChat, 'the chat it came from is kept');
  assert.match(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8'), /\$500 bar tab/);

  const again = await doIt({ core: memory, taskId: 'task_1', home, options: { ask: async () => assert.fail('never a second draft of the same email') }, startImpl: never });
  assert.equal(again.phase, 'in-mail-app');

  await writeFile(join(taskDirectory, 'DELTA.md'), 'Sent 2026-10-17 to bookings@khouse.example.\n');
  const closed = await closeSent({ core: memory, taskDirectories: [taskDirectory] });
  assert.equal(closed.length, 1);
  assert.equal(memory.task.status, 'done', 'the sent email closes the move');
});

test('without the ask box\'s cloud yes the card asks for it, and "yes" writes this one', async () => {
  const { home, directoryPath } = await move();
  const memory = core(directoryPath);
  const calls = [];
  const ask = async (text, options) => {
    calls.push([text, options]);
    if (!options.cloud) return { askId: 'a3', outcome: 'question', status: 'needs-yes', lines: ['To write it, Loggie\'s cloud AI would read the one email from K-HOUSE you are answering, and your line.'] };
    return placedBy(home)(text);
  };
  const stopped = await doIt({ core: memory, taskId: 'task_1', home, options: { ask } });
  assert.equal(stopped.phase, 'needs-you');
  assert.match(stopped.text, /Answer "yes" to write this one, or "always"\.$/);
  assert.equal(memory.task.status, 'blocked', 'the question reaches Needs you');
  const answered = await answerMove({ core: memory, taskId: 'task_1', answer: 'yes', home, options: { ask } });
  assert.deepEqual(calls.at(-1), ['email K-House: ask if we can set up a $500 bar tab for Oct 22', { cloud: 'once', origin: 'move' }], 'yes is a yes for this one, not the words "yes"');
  assert.equal(answered.phase, 'in-mail-app');
  assert.equal(memory.task.status, 'running');
});

// loggie-reply-yes: a draft the ask box held for a time is never pasted; the card asks for the time, and the answer
// fills the held draft (options.fill) instead of asking the ask box again.
test('a draft held for a time: the card asks which time, and the answer fills it and opens it', async () => {
  const { home, directoryPath } = await move();
  const memory = core(directoryPath);
  const asked = [];
  const filled = [];
  const ask = async (text, options) => { asked.push([text, options]); return { askId: 'a1', outcome: 'question', status: 'needs-time', lines: ['K-HOUSE asked about a time and Loggie could not tell which. Which time works?'] }; };
  const fill = async (askId, time) => { filled.push([askId, time]); return placedBy(home)('fill'); };
  const stopped = await doIt({ core: memory, taskId: 'task_1', home, options: { ask, fill } });
  assert.equal(stopped.phase, 'needs-you');
  assert.equal(stopped.text, 'K-HOUSE asked about a time and Loggie could not tell which. Which time works? Answer with the time, e.g. "3 PM EST".');
  const answered = await answerMove({ core: memory, taskId: 'task_1', answer: '9 PM', home, options: { ask, fill } });
  assert.deepEqual(filled, [['a1', '9 PM']]);
  assert.equal(asked.length, 1, 'the time fills the held draft; the ask box is not asked again');
  assert.equal(answered.phase, 'in-mail-app');
});

test('a question back from the ask box is the card\'s question, and its answer is what to ask', async () => {
  const { home, directoryPath } = await move();
  const memory = core(directoryPath);
  const lines = [];
  const asking = async (text) => { lines.push(text); return { askId: 'a2', outcome: 'question', status: 'none', lines: ['No one called "K-House" in your mail, Messages or WhatsApp'] }; };
  const result = await doIt({ core: memory, taskId: 'task_1', home, options: { ask: asking } });
  assert.equal(result.phase, 'needs-you');
  assert.match(result.text, /^No one called "K-House" in your mail, Messages or WhatsApp\. Answer with what to ask, or send it from the ask box: "email K-House: ask if/);
  await answerMove({ core: memory, taskId: 'task_1', answer: 'ask about catering too', home, options: { ask: asking } });
  assert.equal(lines.at(-1), 'email K-House: ask about catering too');
  const noAsker = await doIt({ core: core(directoryPath), taskId: 'task_1', home, options: {} });
  assert.match(noAsker.text, /^Open the ask box and send: "email K-House:/);
});

test('the line box finishes what the text asked: Do it with a line sends that line, never the text\'s own', async () => {
  const { home, directoryPath } = await move();
  const lines = [];
  const result = await doIt({ core: core(directoryPath), taskId: 'task_1', home, line: 'ask if we can set up a $500 bar tab for the 22nd', options: { ask: placedBy(home, lines) } });
  assert.deepEqual(lines, ['email K-House: ask if we can set up a $500 bar tab for the 22nd']);
  assert.equal(result.phase, 'in-mail-app');
});
