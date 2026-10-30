// The ask box's runner (loggie-ask-box increment 3, [CORE]): the right reply object reaches the chat placer for a
// 1:1, a group and WhatsApp; two matches and no words are questions; Stop stops; nothing is ever sent. Made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';

const entries = [
  { name: 'Lena Ortiz', kind: 'person', app: 'messages', chatId: '1', address: '+13235550141', isGroup: false, last: '2026-10-11T10:00:00Z' },
  { name: 'Lena Brooks', kind: 'person', app: 'messages', chatId: '5', address: '+13235550177', isGroup: false, last: '' },
  { name: 'Tailgate crew', kind: 'group', app: 'messages', chatId: '2', address: null, isGroup: true, last: '' },
  { name: 'Acme team 🚀', kind: 'group', app: 'whatsapp', chatId: '11', address: null, isGroup: true, last: '' },
  { name: 'Gideon Hale', kind: 'person', app: 'whatsapp', chatId: '10', address: null, isGroup: false, last: '' },
  { name: 'Jamie Park', kind: 'person', app: 'outlook', email: 'jamie@acmebank.example', last: '' },
];

async function setup({ place = () => ({ opened: 'messages', mode: 'chat', status: 'drafted', detail: 'in the box' }) } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ask-'));
  const calls = [], events = [];
  const asker = createAsker({ home, loadIndex: async () => entries, openChat: async (args) => { calls.push(args); return place(args); }, emit: (kind, data) => events.push([kind, data]) });
  return { home, calls, events, asker };
}

test('Gio\'s sentence shape: one Lena by her full name lands her 1:1 chat with the words as typed', async () => {
  const { calls, events, asker, home } = await setup();
  const { done } = asker.run('text lena ortiz when is the tail gate??');
  const result = await done;
  assert.equal(result.outcome, 'placed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reply, { app: 'messages', chatId: '1', address: '+13235550141', to: 'Lena Ortiz', isGroup: false });
  assert.equal(calls[0].body, 'When is the tail gate??');
  assert.deepEqual(events.filter(([kind]) => kind === 'step').map(([, s]) => `${s.step}/${s.of}`), ['1/2', '2/2']);
  assert.equal(events.at(-1)[0], 'done');
  assert.match(result.lines[0], /Ready in Messages: Lena Ortiz\. You send it there\./);
  const saved = JSON.parse(await readFile(join(home, 'asks', result.askId, 'ASK.json'), 'utf8'));
  assert.equal(saved.outcome, 'placed');
});

test('a WhatsApp group goes to the placer as a group with its exact title', async () => {
  const { calls, asker } = await setup({ place: () => ({ opened: 'whatsapp', mode: 'chat', status: 'drafted' }) });
  const result = await asker.run('tell the acme team on whatsapp the deck comes tonight').done;
  assert.equal(result.outcome, 'placed');
  assert.deepEqual(calls[0].reply, { app: 'whatsapp', chatId: '11', address: null, to: 'Acme team 🚀', isGroup: true });
});

test('two Lenas are a question with both as choices, and nothing is placed; the choice then runs', async () => {
  const { calls, asker } = await setup();
  const asked = await asker.run('text lena running late').done;
  assert.equal(asked.outcome, 'question');
  assert.equal(calls.length, 0);
  assert.deepEqual(asked.who[0].candidates.map((c) => c.name).sort(), ['Lena Brooks', 'Lena Ortiz']);
  const chosen = await asker.run('text lena running late', { choices: { lena: asked.who[0].candidates.find((c) => c.name === 'Lena Brooks').key } }).done;
  assert.equal(chosen.outcome, 'placed');
  assert.equal(calls[0].reply.to, 'Lena Brooks');
});

test('no words is a question; an unknown name says where it looked; outlook-only people are not texted', async () => {
  const { calls, asker } = await setup();
  assert.equal((await asker.run('text lena ortiz').done).outcome, 'question');
  const none = await asker.run('text zara see you soon').done;
  assert.equal(none.outcome, 'question');
  assert.match(none.lines[0], /No one called "zara" in Messages or WhatsApp/);
  assert.equal((await asker.run('text jamie hi').done).outcome, 'question');
  assert.equal(calls.length, 0);
});

test('one sentence to two people places each on its own; a group chat in Messages falls to the clipboard and says so', async () => {
  const { calls, asker } = await setup({ place: ({ reply }) => (reply.isGroup ? { opened: 'clipboard', mode: 'clipboard', detail: 'Messages: the app did not switch to that chat. The draft is on the clipboard.' } : { opened: 'messages', mode: 'chat', status: 'drafted' }) });
  const result = await asker.run('text lena ortiz and the tailgate crew bring chairs').done;
  assert.equal(calls.length, 2);
  assert.equal(result.outcome, 'partly');
  assert.match(result.lines[1], /clipboard/);
});

test('Stop between steps stops the rest, and invites and file opens stay with their own path', async () => {
  let asker, current;
  const setupDone = await setup({ place: () => { asker.stop(current); return { opened: 'messages', mode: 'chat', status: 'drafted' }; } });
  asker = setupDone.asker;
  const started = asker.run('text lena ortiz and gideon see you there');
  current = started.askId;
  const result = await started.done;
  assert.equal(result.outcome, 'stopped');
  assert.equal(setupDone.calls.length, 1);
  assert.equal((await asker.run('invite lena 2pm tomorrow').done).outcome, 'other');
  assert.equal((await asker.run('open resume').done).outcome, 'other');
});

test('the preview line names who and where before anything runs', async () => {
  const { asker, calls } = await setup();
  const preview = await asker.preview('text lena ortiz when is the tail gate??');
  assert.equal(preview.status, 'ready');
  assert.equal(preview.line, 'Message Lena Ortiz · Messages');
  assert.equal((await asker.preview('text lena hi')).status, 'which');
  // An invite is previewed by the word map (loggie-ask-wordmap): its action, each word's role, and a question when
  // no invite people are known; it still runs through command-service, never this runner.
  const invite = await asker.preview('invite lena 2pm');
  assert.equal(invite.action, 'invite');
  assert.deepEqual(invite.marks.map((w) => w.role), ['action', 'unused', 'when']);
  assert.equal(invite.status, 'question');
  assert.equal(calls.length, 0);
});

test('with the real chat opener the words reach a link, the read-back file is written, and nothing is sent', async () => {
  const { openChatDraft } = await import('../src/hikyaku/chats.js');
  const home = await mkdtemp(join(tmpdir(), 'ask-real-'));
  const opened = [];
  const asker = createAsker({
    home, loadIndex: async () => entries,
    openChat: (args) => openChatDraft({ ...args,
      spawnImpl: (command, argv) => { opened.push(argv[0]); return { unref() {}, on() {} }; },
      composerImpl: async ({ expectFile }) => ({ status: 'found', matched: (await readFile(expectFile, 'utf8')) === 'When is the tail gate??' }),
    }),
  });
  const result = await asker.run('text lena ortiz when is the tail gate??').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result.results));
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^sms:\+13235550141&body=When%20is%20the%20tail%20gate%3F%3F$/);
});

test('several people get one message: Messages opens one link to all their handles; "separately" keeps one each', async () => {
  const people = [
    { name: 'Bruno Vance', kind: 'person', app: 'messages', chatId: '20', address: '+13235550120', isGroup: false, last: '' },
    { name: 'Arlo Smith', kind: 'person', app: 'messages', chatId: '21', address: 'arlo@example.com', isGroup: false, last: '' },
    { name: 'Bruno & Arlo', kind: 'group', app: 'messages', chatId: '22', address: null, isGroup: true, last: '', members: [{ name: 'Bruno Vance', handle: '+13235550120' }, { name: 'Arlo Smith', handle: 'arlo@example.com' }] },
    { name: 'Yuki Sato', kind: 'person', app: 'whatsapp', chatId: '30', address: null, isGroup: false, last: '' },
    { name: 'Dana Wu', kind: 'person', app: 'whatsapp', chatId: '31', address: null, isGroup: false, last: '' },
    { name: 'Case team', kind: 'group', app: 'whatsapp', chatId: '32', address: null, isGroup: true, last: '', members: [{ name: '', handle: 'me' }, { name: 'Yuki Sato', handle: 'y' }, { name: 'Dana Wu', handle: 'd' }] },
    { name: 'Lena Ortiz', kind: 'person', app: 'whatsapp', chatId: '33', address: null, isGroup: false, last: '' },
  ];
  const home = await mkdtemp(join(tmpdir(), 'ask-group-'));
  const calls = [];
  const asker = createAsker({ home, loadIndex: async () => people, openChat: async ({ reply, body }) => { calls.push({ reply, body }); return { opened: reply.app, mode: 'chat', status: 'drafted' }; } });
  const one = await asker.run('text bruno and arlo basketball?!').done;
  assert.equal(one.outcome, 'placed');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].reply.address, ['+13235550120', 'arlo@example.com']);
  assert.equal(calls[0].body, 'Basketball?!');
  assert.equal(one.results[0].kind, 'group');
  const wa = await asker.run('whatsapp yuki and dana we meet at 10').done;
  assert.equal(wa.outcome, 'placed');
  assert.deepEqual(calls[1].reply, { app: 'whatsapp', chatId: '32', address: null, to: 'Case team', isGroup: true });
  const apart = await asker.run('text bruno and arlo separately basketball?!').done;
  assert.equal(apart.results.length, 2);
  assert.equal(calls.length, 4);
  // No WhatsApp group with exactly Yuki and Lena: each gets their own draft, and What I did says why.
  const split = await asker.run('whatsapp yuki and lena see you').done;
  assert.equal(split.results.length, 2);
  assert.ok(split.did.some((line) => /not possible \(WhatsApp has no group with exactly them/.test(line)));
});

test('Undo clears a chat draft only through the guarded clear, and a second Undo has nothing left', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-undo-'));
  const cleared = [];
  const asker = createAsker({ home, loadIndex: async () => entries,
    openChat: async () => ({ opened: 'messages', mode: 'chat', status: 'drafted' }),
    clearChat: async ({ app, text, folder }) => { cleared.push({ app, text, folder: Boolean(folder) }); return { status: 'cleared' }; } });
  const result = await asker.run('text lena ortiz running late').done;
  assert.equal(result.undoable, true);
  const undone = await asker.undo(result.askId);
  assert.deepEqual(cleared, [{ app: 'messages', text: 'Running late', folder: true }]);
  assert.match(undone.lines[0], /Cleared the draft in Messages/);
  assert.match((await asker.undo(result.askId)).lines[0], /Nothing from this ask is left to undo/);
});

test('Undo on a box the user changed leaves it; the real clear passes the words to the helper as the expected text', async () => {
  const { clearOwnDraft } = await import('../src/hikyaku/chats.js');
  const folder = await mkdtemp(join(tmpdir(), 'ask-undo-real-'));
  let seen = null;
  const out = await clearOwnDraft({ app: 'messages', text: 'Running late', folder, helper: '/bin/fake',
    execImpl: async (binary, args) => { seen = { args, expected: await readFile(args[args.indexOf('--expect-file') + 1], 'utf8') }; return { stdout: '{"status": "not-ours"}' }; } });
  assert.equal(out.status, 'not-ours');
  assert.deepEqual(seen.args.slice(0, 3), ['composer-clear', '--app', 'messages']);
  assert.equal(seen.expected, 'Running late');
});

// 2026-10-22: "message leah nakaima" said "No one called ..." while Messages and WhatsApp were off in Settings, so
// nothing was searched. With the chats off, the line says so instead of blaming the name.
test('with Messages and WhatsApp off, a text to someone unknown says the chats are off, not that no one has the name', async () => {
  const { CHATS_OFF } = await import('../src/hikyaku/ask-run.js');
  const home = await mkdtemp(join(tmpdir(), 'ask-chats-off-'));
  const make = (off) => createAsker({ home, loadIndex: async () => [], openChat: async () => ({ opened: 'none' }), chatsOff: async () => off });
  assert.equal((await make(true).preview('message leah nakaima on what time')).line, CHATS_OFF);
  assert.match((await make(false).preview('message leah nakaima on what time')).line, /^No one called "leah/, 'chats on and still nobody: the old line');
  const done = await make(true).run('message leah nakaima on what time').done;
  assert.equal(done.lines[0], CHATS_OFF);
});
