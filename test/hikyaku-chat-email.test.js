// workspaces-outlook W5, on this Mac: a text asking the user to email someone else becomes an email move, by code.
// No model reads the chat (Gio, 2026-10-17). Fakes only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emailAskOf, emailAsksIn, makeEmailMoves } from '../src/hikyaku/chat-email.js';

test('a request aimed at the user, with a contact verb and a name, is found; anything else is not', () => {
  assert.deepEqual(emailAskOf('Can you email K-House and ask if we can set up a $500 bar tab for Thursday?'), { to: 'K-House', ask: 'ask if we can set up a $500 bar tab for Thursday' });
  assert.deepEqual(emailAskOf('could you reach out to Rhonda about the split payment'), { to: 'Rhonda', ask: 'ask about the split payment' });
  assert.deepEqual(emailAskOf('pls check with K-House on catering'), { to: 'K-House', ask: 'ask about catering' });
  assert.equal(emailAskOf('please ask Professor Smith about the extension').to, 'Professor Smith');
  assert.deepEqual(emailAskOf('Hey man! Did you get a chance to put together the budget for food and also ask KHouse about $500 bar tab?'), { to: 'KHouse', ask: 'ask about $500 bar tab' }, 'a nudge is a request (Liam, 2026-10-17)');
  for (const text of ['tell Rhonda thanks', 'I will email K-House myself', 'Can you ask Thursday if it works', 'lmk what K-House says', 'can u email danielle re the invoice']) {
    assert.equal(emailAskOf(text), null, text);
  }
});

const NOW = Date.parse('2026-10-17T15:00:00Z');
const read = { messages: { status: 'ok', chats: [{
  id: 'messages:liam', app: 'messages', title: 'Liam', address: '+16075550100', isGroup: false,
  participants: [{ handle: '+16075550100', name: 'Liam' }],
  messages: [
    { fromMe: false, from: '+16075550100', timestamp: '2026-10-17T12:14:00Z', text: 'Can you email K-House and ask if we can set up a $500 bar tab for Thursday?' },
    { fromMe: true, from: '', timestamp: '2026-10-17T12:20:00Z', text: 'yes will do' },
    { fromMe: true, from: '', timestamp: '2026-10-17T12:21:00Z', text: 'Can you email Rhonda about it too? (to myself)' },
    { fromMe: false, from: '+16075550100', timestamp: '2026-10-01T12:00:00Z', text: 'Could you email Danielle about the old thing?' },
  ],
}] } };

test('only someone else\'s recent words count, one per chat and person', () => {
  const asks = emailAsksIn(read, { now: NOW, days: 3 });
  assert.deepEqual(asks.map((item) => [item.to, item.line, item.message.from]), [['K-House', 'email K-House: ask if we can set up a $500 bar tab for Thursday', 'Liam']]);
});

test('a request is short, and in a group it is said to someone: a post to everyone or pasted text makes no move', () => {
  const group = (text, extra = {}) => ({ messages: { status: 'ok', chats: [{ id: 'messages:club', app: 'messages', title: 'Club', isGroup: true,
    participants: [{ handle: '+16075550101', name: 'Sam' }, { handle: '+16075550102', name: 'Ana' }],
    messages: [{ fromMe: false, from: '+16075550101', timestamp: '2026-10-17T12:00:00Z', text }], ...extra }] } });
  const found = (r) => emailAsksIn(r, { now: NOW }).map((item) => item.to);
  assert.deepEqual(found(group('And for the bar tab, did you ask Lucky Star about setting that up?')), ['Lucky Star'], '"did you" in a group is said to the user');
  assert.deepEqual(found(group('Hey all, please try to get in touch with Lucky Star, we have no info on this.')), [], '"please" in a group is said to everyone');
  assert.deepEqual(found(group(`Can you email Lucky Star about the 15th? ${'More details follow. '.repeat(10)}`)), [], 'a long message is a post, not a request');
  assert.deepEqual(found({ messages: { status: 'ok', chats: [{ ...read.messages.chats[0], messages: [{ fromMe: false, from: '+16075550100', timestamp: '2026-10-17T12:00:00Z', text: 'pls check with Lucky Star on catering' }] }] } }), ['Lucky Star'], '"pls" one to one still counts');
});

test('a request the user already answered as done in the chat makes no move', () => {
  const done = structuredClone(read);
  done.messages.chats[0].messages.splice(1, 0, { fromMe: true, from: '', timestamp: '2026-10-17T12:44:00Z', text: 'Just sent khouse email, will call monday' });
  assert.deepEqual(emailAsksIn(done, { now: NOW, days: 3 }), []);
});

test('each request becomes one move in the Chats card, with the ask line and the chat it came from', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'chat-email-'));
  const tasks = [], projects = [], briefs = [];
  const core = {
    listTasks: async () => tasks, listProjects: async () => projects,
    createProject: async (project) => { const made = { id: `p${projects.length + 1}`, ...project }; projects.push(made); return made; },
    createTask: async (task) => { const made = { id: `task_${tasks.length + 1}`, status: 'waiting', ...task }; tasks.push(made); return made; },
    createBrief: async (id, brief) => { briefs.push([id, brief]); return { id: 'b1' }; },
  };
  const asks = emailAsksIn(read, { now: NOW });
  const made = await makeEmailMoves({ core, asks, workRoot, projectName: 'Chats' });
  assert.deepEqual(made.map((item) => item.line), ['email K-House: ask if we can set up a $500 bar tab for Thursday']);
  assert.deepEqual([tasks[0].sourceType, tasks[0].sourceId, projects[0].name], ['messages', 'messages:liam:email:k-house', 'Chats']);
  const reply = JSON.parse(await readFile(join(projects[0].directoryPath, tasks[0].id, 'REPLY.json'), 'utf8'));
  assert.equal(reply.ask.line, 'email K-House: ask if we can set up a $500 bar tab for Thursday');
  assert.equal(reply.fromChat.chatId, 'messages:liam');
  assert.match(briefs[0][1].constraints[0], /Never send email/);
  assert.deepEqual(await makeEmailMoves({ core, asks, workRoot, projectName: 'Chats' }), [], 'the 10-minute check makes it once');
});
