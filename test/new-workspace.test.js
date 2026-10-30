// New workspace (loggie-new-workspace): the name's words, the look through mail, chats and calls, the people found.
// Made-up people and addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keptPeople, lookFor, personKey, seedFrom, seedWords, wordsIn } from '../src/hikyaku/new-workspace.js';

const OWN = ['me@school.example'];
const INBOX = [
  { from: 'Dana Wu <dana@hotel.example>', subject: 'Hotel hackathon: data drop tonight', to: OWN },
  { from: 'Dana Wu <dana@hotel.example>', subject: 'Re: Hotel hackathon: rubric', to: OWN },
  { from: 'news@hotel.example', subject: 'Hackathon newsletter', to: OWN },
  { from: 'noreply@events.example', subject: 'Your hackathon ticket', to: OWN },
  { from: 'Sam Lee <sam@school.example>', subject: 'Lunch?', to: OWN },
];
const SENT = [
  { subject: 'Team for the case', body: 'Are you in for the hackathon this weekend?', to: ['kim@school.example'], primary: ['kim@school.example'] },
  { subject: 'Hello', body: 'Nothing about it', to: ['sam@school.example'], primary: ['sam@school.example'] },
];
const CHATS = { messages: { chats: [
  { app: 'messages', id: '1', title: 'Hackathon squad', participants: [{ handle: '+15550001', name: 'Kim Ito' }, { handle: '+15550002', name: null }], messages: [] },
  { app: 'messages', id: '2', title: 'Karaoke', participants: [{ handle: '+15550003', name: 'Lee' }], messages: [{ text: 'see you at 8' }] },
] } };
const CALLS = [{ id: 'c1', title: 'Hackathon kickoff', workstream: null, state: 'done' }, { id: 'c2', title: 'Hackathon prep', workstream: 'Other', state: 'done' }, { id: 'c3', title: 'Strategy', state: 'done' }];

test('the words are the name\'s own, or the whole name when it is short', () => {
  assert.deepEqual(seedWords('Hotel hackathon'), ['Hotel', 'hackathon']);
  assert.deepEqual(seedWords('M&T'), ['M&T']);
  assert.deepEqual(seedWords('  '), []);
  assert.deepEqual(seedWords('Japan Club'), ['Japan Club'], 'a kind word is never followed alone');
  assert.ok(wordsIn("Dana's hackathon notes", ['hackathon']));
  assert.ok(!wordsIn('hackathonia', ['hackathon']));
});

test('the look counts mail, chats and calls with the words, and finds who is in them, mailers and the user left out', () => {
  const seed = seedFrom({ words: ['hackathon'], inbox: INBOX, sent: SENT, chats: CHATS, calls: CALLS, own: OWN });
  assert.equal(seed.mail, 5, 'four inbox subjects with the word (a mailer\'s too) plus one sent body');
  assert.equal(seed.chats, 1);
  assert.equal(seed.calls, 2);
  assert.deepEqual(seed.unfiledCalls, ['c1'], 'a call already filed elsewhere stays where it is');
  assert.deepEqual(seed.people.map((person) => [person.name, personKey(person), person.count]),
    [['Dana Wu', 'dana@hotel.example', 2], ['', '+15550002', 1], ['Kim Ito', '+15550001', 1], ['', 'kim@school.example', 1]]);
});

test('a reader that fails is named and the others still count', async () => {
  const seed = await lookFor('Hotel hackathon', { own: OWN, readInbox: async ({ keep }) => INBOX.filter(keep), readSent: async () => { throw new Error('no Sent folder'); },
    readChats: async () => CHATS, listCalls: async () => CALLS });
  assert.equal(seed.mail, 4);
  assert.deepEqual(seed.notes, ['Sent mail could not be read: no Sent folder']);
  await assert.rejects(lookFor(' ', { own: OWN }), /Give the new workspace a name/);
});

test('only people the look found can be kept, by their key', () => {
  const seed = seedFrom({ words: ['hackathon'], inbox: INBOX, chats: CHATS, own: OWN });
  assert.deepEqual(keptPeople(seed.people, ['dana@hotel.example', '+15550001', 'evil@example.com']),
    [{ name: 'Dana Wu', address: 'dana@hotel.example' }, { name: 'Kim Ito', handle: '+15550001' }]);
});

test('the user, role addresses and rooms are never people to follow', () => {
  const chats = { whatsapp: { self: [], chats: [{ app: 'whatsapp', id: '9', title: 'Hackathon team', participants: [{ handle: '111@lid', name: 'Ana' }, { handle: '222@lid', name: 'Ana Lee' }], messages: [] }] },
    messages: { self: ['me@school.example'], chats: [{ app: 'messages', id: '8', title: 'hackathon', participants: [{ handle: 'me@school.example', name: null }, { handle: '+15550009', name: 'Bo' }], messages: [] }] } };
  const inbox = [{ from: 'Devpost <support@devpost.example>', subject: 'hackathon' }, { from: 'Room 214 <breakout-214@school.example>', subject: 'hackathon' }, { from: 'Hall (Breakout) 214 <hall-214@school.example>', subject: 'hackathon' }];
  const seed = seedFrom({ words: ['hackathon'], inbox, chats, own: OWN, ownNames: ['Ana'] });
  assert.deepEqual(seed.people.map(personKey).sort(), ['+15550009', '222@lid']);
});

test('Look finds the recordings that say the word, not only the ones titled with it', async () => {
  const calls = [{ id: 'a', title: 'Help Me Hilton Presentation Prep', state: 'done' }, { id: 'b', title: 'Slow Service Solution Dashboard', state: 'done' }, { id: 'c', title: 'Lunch', state: 'done' }];
  const said = { Hilton: [{ id: 'b', count: 9 }, { id: 'c', count: 1 }], hackathon: [] };
  const seed = await lookFor('Hilton hackathon', { own: OWN, listCalls: async () => calls, searchSaid: async (word) => said[word] || [] });
  assert.deepEqual(seed.unfiledCalls, ['a', 'b'], 'said 9 times files it; said once does not');
});
