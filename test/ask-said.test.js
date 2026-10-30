// "What did X say" (loggie-ask-box increment 6): the real runner and the real message shaping, with fake readers.
// Made-up people. Nothing goes to the cloud and nothing opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { chatMessages, mailMessages } from '../src/hikyaku/ask-said.js';

const entries = [
  { name: 'Gideon Hale', kind: 'person', app: 'whatsapp', chatId: '10', address: null, isGroup: false, last: '2026-10-11T08:00:00Z' },
  { name: 'Gideon Hale', kind: 'person', app: 'outlook', email: 'jr@bank.example', last: '2026-10-09T08:00:00Z' },
  { name: 'Dana Wu', kind: 'person', app: 'messages', chatId: '3', address: '+1', isGroup: false, last: '' },
];
const chat = { title: 'Gideon Hale', participants: [{ handle: '+15550101', name: 'Gideon Hale' }], messages: [
  { fromMe: false, from: '+15550101', text: 'Can you send the deck?', timestamp: '2026-10-11T07:58:00Z' },
  { fromMe: true, from: '', text: 'Tonight', timestamp: '2026-10-11T07:59:00Z' },
  { fromMe: false, from: '+15550101', text: 'Great, thanks', timestamp: '2026-10-11T08:00:00Z' },
  { fromMe: false, from: '+15550101', text: 'old', timestamp: '2026-10-01T08:00:00Z' },
] };
const mail = [{ from: 'Gideon Hale <jr@bank.example>', subject: 'Next steps', snippet: 'Thanks for the call.\nHere is the plan', timestamp: '2026-10-09T08:00:00Z' }];

test('shaping: the newest chat messages in order with who wrote them; an email is its subject and first lines', () => {
  assert.deepEqual(chatMessages(chat).map((m) => `${m.from}: ${m.text}`), ['Gideon Hale: Can you send the deck?', 'You: Tonight', 'Gideon Hale: Great, thanks']);
  assert.deepEqual(mailMessages(mail, 'jr@bank.example')[0].text, 'Next steps: Thanks for the call. Here is the plan');
  assert.deepEqual(chatMessages(null), []);
});

test('"what did gideon say" reads WhatsApp and Outlook, newest place first, with no cloud and nothing opened', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ask-said-'));
  const read = [];
  const asker = createAsker({
    home, loadIndex: async () => entries,
    openChat: async () => { throw new Error('nothing opens for "said"'); },
    readLatest: async (entry) => { read.push(entry.app); return entry.app === 'whatsapp' ? chatMessages(chat) : mailMessages(mail, entry.email); },
  });
  const preview = await asker.preview('what did gideon say');
  assert.equal(preview.status, 'ready');
  assert.match(preview.line, /See what Gideon Hale \(WhatsApp, Outlook\) said/);
  const result = await asker.run('what did gideon say').done;
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(read.sort(), ['outlook', 'whatsapp']);
  assert.deepEqual(result.results.map((r) => r.app), ['whatsapp', 'outlook']);
  assert.equal(result.results[0].messages.at(-1).text, 'Great, thanks');
});

test('someone with nothing recent is said plainly; an unknown name says where it looked', async () => {
  const asker = createAsker({ home: await mkdtemp(join(tmpdir(), 'ask-said-')), loadIndex: async () => entries, openChat: async () => ({}), readLatest: async () => [] });
  const quiet = await asker.run('did dana reply').done;
  assert.equal(quiet.outcome, 'failed');
  assert.match(quiet.lines[0], /Nothing from Dana Wu/);
  const none = await asker.run('what did zara say').done;
  assert.match(none.lines[0], /No one called "zara" in your mail, Messages or WhatsApp/);
});
