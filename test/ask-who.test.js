// Who a name means (loggie-ask-box increment 2). Made-up people. 'many' never picks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhoIndex, flipName, resolveWho, indexNames, whoPeople } from '../src/hikyaku/ask-who.js';

const chat = (id, title, { isGroup = false, address = null, last = '2026-10-10T12:00:00Z' } = {}) => ({ id, title, isGroup, address, participants: [], messages: [{ timestamp: last, text: 'x', fromMe: false }] });
const chats = {
  messages: { status: 'ok', chats: [
    chat(1, 'Lena Ortiz', { address: '+13235550141', last: '2026-10-11T10:00:00Z' }),
    chat(2, 'Tailgate crew', { isGroup: true, last: '2026-10-11T09:00:00Z' }),
    chat(3, '+13235550199', { address: '+13235550199' }),
    chat(4, 'Jamie Park', { address: 'jamie@example.com', last: '2026-10-01T09:00:00Z' }),
    chat(5, 'Lena Brooks', { address: '+13235550177' }),
  ] },
  whatsapp: { status: 'ok', chats: [
    chat(10, 'Gideon Hale', { last: '2026-10-11T08:00:00Z' }),
    chat(11, 'Acme team 🚀', { isGroup: true }),
    chat(12, 'Yuki Sato', {}),
  ] },
};
const inbox = [
  { from: 'Jamie Park <jamie@acmebank.example>', subject: 'Offer call notes', timestamp: '2026-10-11T07:00:00Z', conversation: 'c1' },
  { from: 'Jamie Park <jamie@acmebank.example>', subject: 'Older', timestamp: '2026-10-02T07:00:00Z', conversation: 'c0' },
  { from: 'Acme Careers <no-reply@acmebank.example>', subject: 'Apply now', timestamp: '2026-10-11T07:30:00Z' },
  { from: 'Me <me@example.edu>', subject: 'Note to self', timestamp: '2026-10-11T07:30:00Z' },
  { from: 'Dana Wu <dana@example.org>', subject: 'Notes', timestamp: '2026-10-05T07:00:00Z' },
];
const people = [{ name: 'Zara Shah', address: 'zara@example.com', count: 3 }, { name: 'Dana Wu', address: 'dana@example.org', count: 1 }];
const entries = buildWhoIndex({ chats, inbox, people, own: ['me@example.edu'] });

test('the index keeps named chats and real senders, drops bare numbers, no-reply and the user', () => {
  const names = indexNames(entries);
  for (const name of ['Lena Ortiz', 'Tailgate crew', 'Jamie Park', 'Gideon Hale', 'Acme team 🚀', 'Zara Shah', 'Dana Wu']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('+13235550199'));
  assert.ok(!entries.some((entry) => /no-reply|me@example/.test(entry.email || '')));
  assert.equal(entries.find((entry) => entry.email === 'jamie@acmebank.example').subject, 'Offer call notes');
});

const CASES = [
  // [who, options, status, expected app / name of the pick or candidates' names]
  ['lena ortiz', {}, 'one', 'messages', 'Lena Ortiz'],
  ['lena', {}, 'many', null, ['Lena Ortiz', 'Lena Brooks']],
  ['ortiz', {}, 'one', 'messages', 'Lena Ortiz'],
  ['tailgate crew', {}, 'one', 'messages', 'Tailgate crew'],
  ['the tailgate crew', {}, 'one', 'messages', 'Tailgate crew'],
  ['acme team', {}, 'one', 'whatsapp', 'Acme team 🚀'],
  ['gideon', {}, 'one', 'whatsapp', 'Gideon Hale'],
  ['gid', {}, 'one', 'whatsapp', 'Gideon Hale'],
  ['yuki', { app: 'messages' }, 'none', null, null],
  ['jamie', {}, 'one', 'messages', 'Jamie Park'],
  ['jamie', { action: 'reply' }, 'one', 'outlook', 'Jamie Park'],
  ['jamie', { action: 'reply', app: 'messages' }, 'one', 'messages', 'Jamie Park'],
  ['jamie', { action: 'said' }, 'one', 'outlook', 'Jamie Park'],
  ['zara', {}, 'none', null, null],
  ['zara', { action: 'reply' }, 'one', 'outlook', 'Zara Shah'],
  ['dana', { action: 'reply' }, 'one', 'outlook', 'Dana Wu'],
  ['zed', {}, 'none', null, null],
  ['', {}, 'none', null, null],
  ['le', {}, 'none', null, null],
  ['LENA BROOKS', {}, 'one', 'messages', 'Lena Brooks'],
];

test('one, many and none on all 20 cases; many never picks', () => {
  assert.equal(CASES.length, 20);
  for (const [who, options, status, app, name] of CASES) {
    const got = resolveWho(who, entries, options);
    assert.equal(got.status, status, `${who} ${JSON.stringify(options)}`);
    if (status === 'one') { assert.equal(got.pick.app, app, who); assert.equal(got.pick.name, name, who); }
    if (status === 'many') { assert.equal(got.pick, undefined); assert.deepEqual(got.candidates.map((c) => c.name).sort(), [...name].sort()); }
  }
});

test('two chats with the same name in one app are a question, newest first, never a pick', () => {
  const twins = [
    { name: 'Hackathon Team', kind: 'group', app: 'messages', chatId: '7', isGroup: true, last: '2026-09-30T10:00:00Z' },
    { name: 'Hackathon Team', kind: 'group', app: 'messages', chatId: '8', isGroup: true, last: '2026-10-07T10:00:00Z' },
  ];
  const got = resolveWho('the hackathon group', twins, { action: 'message' });
  assert.equal(got.status, 'many');
  assert.equal(got.pick, undefined);
  assert.deepEqual(got.candidates.map((c) => c.chatId), ['8', '7']);
});

test('a first name means the person even when a group is named after them; the whole group name still finds the group', () => {
  const list = [
    { name: 'Bruno Vance', kind: 'person', app: 'messages', chatId: '1', address: '+1', isGroup: false, last: '' },
    { name: 'Bruno & Arlo', kind: 'group', app: 'messages', chatId: '2', isGroup: true, last: '' },
  ];
  assert.equal(resolveWho('bruno', list).pick.name, 'Bruno Vance');
  assert.equal(resolveWho('bruno & arlo', list).pick.name, 'Bruno & Arlo');
});

test('a first name that is one contact\'s whole name and another\'s first name is a question, not the one-word contact', () => {
  const list = [
    { name: 'Gideon', kind: 'person', app: 'messages', chatId: '1', address: '+1', isGroup: false, last: '' },
    { name: 'Gideon Hale', kind: 'person', app: 'whatsapp', chatId: '2', isGroup: false, last: '' },
  ];
  assert.equal(resolveWho('gideon', list).status, 'many');
  assert.equal(resolveWho('gideon hale', list).pick.name, 'Gideon Hale');
});

test('a sending service is not a person to email: "KHouse" is the venue, not its invoice mailer', async () => {
  const { buildWhoIndex, resolveWho } = await import('../src/hikyaku/ask-who.js');
  const inbox = [
    { from: 'K-HOUSE Karaoke <khousekaraoke@gmail.com>', to: 'gio@school.edu', subject: 'Re: October 22nd | Karaoke event', timestamp: '2026-10-08T00:23:17Z' },
    { from: 'K-HOUSE Karaoke & Arts Hub <messenger@messaging.squareup.com>', to: 'gio@school.edu', subject: 'Payment due: Invoice #014', timestamp: '2026-10-12T00:00:00Z' },
  ];
  const result = resolveWho('KHouse', buildWhoIndex({ inbox, own: ['gio@school.edu'] }), { action: 'reply', app: 'outlook' });
  assert.equal(result.status, 'one');
  assert.equal(result.pick.email, 'khousekaraoke@gmail.com');
});

// D1 (loggie-intros 1.6, 1.7): the ask box reads the kept workspaces' people, so a person saved from an introduction
// is reachable by name before any thread with them is saved. An unconfirmed card is never read.
test('a person only in a kept workspace\'s people resolves; an unconfirmed card\'s people are not read; two first names are a question', () => {
  const workstreams = [
    { name: 'Bank', domains: [], words: [], people: [{ name: 'Priya Natarajan', address: 'PNatarajan@bank.example' }, { name: 'Chat Pal', handle: '+15550100' }] },
    { name: 'Found Co', domains: [], words: [], found: { at: '2026-10-18T05:55:00Z' }, people: [{ name: 'Rafael Ortega', address: 'rortega@found.example' }] },
    { name: 'Kept Co', domains: [], words: [], found: { at: '2026-10-18T05:55:00Z' }, confirmed: '2026-10-19T10:00:00Z', people: [{ name: 'Priya Shah', address: 'pshah@kept.example' }] },
    { name: 'Inbox', domains: [], words: [], inbox: true, people: [{ name: 'Inbox Person', address: 'ip@inbox.example' }] },
  ];
  const listed = whoPeople({ workstreams, threadPeople: [{ name: 'P. Natarajan', address: 'pnatarajan@bank.example', count: 2 }, { name: 'Zara Shah', address: 'zara@example.com', count: 3 }] });
  assert.deepEqual(listed, [{ name: 'Priya Natarajan', address: 'pnatarajan@bank.example' }, { name: 'Priya Shah', address: 'pshah@kept.example' }, { name: 'Zara Shah', address: 'zara@example.com' }]);
  const index = buildWhoIndex({ people: listed, own: ['me@example.edu'] });
  const one = resolveWho('Priya Natarajan', index, { action: 'reply' });
  assert.equal(one.status, 'one');
  assert.equal(one.pick.email, 'pnatarajan@bank.example');
  assert.equal(resolveWho('Rafael Ortega', index, { action: 'reply' }).status, 'none', 'an unconfirmed card\'s people stay out');
  const priya = resolveWho('priya', index, { action: 'reply' });
  assert.equal(priya.status, 'many');
  assert.deepEqual(priya.candidates.map((entry) => entry.email).sort(), ['pnatarajan@bank.example', 'pshah@kept.example']);
});

// D7 (loggie-intros I3, gate 3.3): Exchange stores names "Last, First", so a whole-name ask missed them.
test('3.3 flipName turns "Romero, Elizabeth" into "Elizabeth Romero"; a suffix and a plain name stay as they are', () => {
  assert.equal(flipName('Romero, Elizabeth'), 'Elizabeth Romero');
  assert.equal(flipName('Smith, Jr.'), 'Smith, Jr.');
  assert.equal(flipName('Okafor, PhD'), 'Okafor, PhD');
  assert.equal(flipName('Elizabeth'), 'Elizabeth');
  assert.equal(flipName('Lee, Kim, MBA'), 'Lee, Kim, MBA', 'two commas: unchanged');
});

test('3.3 the who index flips Exchange names: a whole-name ask finds her, and the same person under both forms is a question with both addresses', () => {
  const own = ['gio@school.example'];
  const mail = [{ address: 'eromero1@bank.example', name: 'Romero, Elizabeth', at: '2026-09-21T10:00:00Z', sent: false, size: 3 }];
  const one = resolveWho('Elizabeth Romero', buildWhoIndex({ mail, own }), { app: 'outlook', action: 'reply' });
  assert.equal(one.status, 'one');
  assert.equal(one.pick.email, 'eromero1@bank.example');
  const inbox = [{ from: 'Patel, Rowena <rpatel5@bank.example>', to: own[0], subject: 'RE: Thank you', timestamp: '2026-10-20T14:29:00Z' }];
  const twins = resolveWho('Rowena Patel', buildWhoIndex({ inbox, mail: [{ address: 'rp824@school.example', name: 'Rowena Patel', at: '2026-10-20T14:16:00Z', sent: true, size: 1 }], own }), { app: 'outlook', action: 'reply' });
  assert.equal(twins.status, 'many');
  assert.equal(twins.twins, true);
  assert.equal(twins.pick, undefined);
  assert.deepEqual(twins.candidates.map((entry) => entry.email).sort(), ['rp824@school.example', 'rpatel5@bank.example']);
});
