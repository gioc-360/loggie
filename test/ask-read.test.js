// The ask box's graded sentence set (loggie-ask-box increment 1). Made-up people only. Bar from the eval contract:
// at least 36 of 40 read right (action, who, app, words), and no message-type sentence read as another action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAsk } from '../src/hikyaku/ask.js';

const names = ['Lena Ortiz', 'Jamie Park', 'Yuki Sato', 'Acme team', 'Tailgate crew', 'Mom', 'Gideon Hale', 'Dana'];

// [sentence, expected]: only the fields given are graded.
const GRADED = [
  ['text lena when is the tail gate??', { action: 'message', who: ['lena'], app: null, words: 'When is the tail gate??' }],
  ["Text Lena I'm 10 late", { action: 'message', who: ['Lena'], words: "I'm 10 late" }],
  ['text lena ortiz running late', { action: 'message', who: ['lena ortiz'], words: 'Running late' }],
  ['Tell the Acme team on WhatsApp the deck comes tonight', { action: 'message', who: ['Acme team'], app: 'whatsapp', words: 'The deck comes tonight' }],
  ['whatsapp gideon thanks for the call today', { action: 'message', who: ['gideon'], app: 'whatsapp', words: 'Thanks for the call today' }],
  ['tell jamie that the deck is ready', { action: 'message', who: ['jamie'], words: 'The deck is ready' }],
  ['ask yuki if she still needs the notes', { action: 'message', who: ['yuki'], words: 'If she still needs the notes' }],
  ['message mom: landed safe', { action: 'message', who: ['mom'], words: 'Landed safe' }],
  ['imessage dana see you at 7', { action: 'message', who: ['dana'], app: 'messages', words: 'See you at 7' }],
  ['let lena know I found her keys', { action: 'message', who: ['lena'], words: 'I found her keys' }],
  ['let the tailgate crew know parking is lot B', { action: 'message', who: ['tailgate crew'], words: 'Parking is lot B' }],
  ['send lena a text saying on my way', { action: 'message', who: ['lena'], words: 'On my way' }],
  ['send a whatsapp to the acme team saying call moved to 3', { action: 'message', who: ['acme team'], app: 'whatsapp', words: 'Call moved to 3' }],
  ['text the tailgate crew in imessage bring chairs', { action: 'message', who: ['tailgate crew'], app: 'messages', words: 'Bring chairs' }],
  ['ping jamie about the deck', { action: 'message', who: ['jamie'], words: 'About the deck' }],
  ['can you text lena happy birthday!', { action: 'message', who: ['lena'], words: 'Happy birthday!' }],
  ['please tell mom I will call tonight', { action: 'message', who: ['mom'], words: 'I will call tonight' }],
  ['text lena and jamie the tailgate starts at noon', { action: 'message', who: ['lena', 'jamie'], words: 'The tailgate starts at noon' }],
  ['tell lena, jamie and yuki the deck is in the drive', { action: 'message', who: ['lena', 'jamie', 'yuki'], words: 'The deck is in the drive' }],
  ['text lena and the acme team I am out today', { action: 'message', who: ['lena', 'acme team'], words: 'I am out today' }],
  ['text lena and then go to bed', { action: 'message', who: ['lena'], words: 'And then go to bed' }],
  ['text the soccer group game is cancelled', { action: 'message', who: ['soccer group'], words: 'Game is cancelled' }],
  ['reply to jamie saying thursday works', { action: 'reply', who: ['jamie'], words: 'Thursday works' }],
  ['Reply to Jamie: Thursday works, send the deck after', { action: 'reply', who: ['Jamie'], words: 'Thursday works, send the deck after' }],
  ['respond to gideon on whatsapp that I can do friday', { action: 'reply', who: ['gideon'], app: 'whatsapp', words: 'I can do friday' }],
  ['email jamie that the offer call works', { action: 'reply', who: ['jamie'], app: 'outlook', words: 'The offer call works' }],
  ['write back to yuki thanks, will review tonight', { action: 'reply', who: ['yuki'], words: 'Thanks, will review tonight' }],
  ['what did gideon say', { action: 'said', who: ['gideon'] }],
  ['what did the acme team say about the deck', { action: 'said', who: ['acme team'] }],
  ['did jamie reply', { action: 'said', who: ['jamie'] }],
  ['anything new from lena?', { action: 'said', who: ['lena'] }],
  ['catch me up on the tailgate crew', { action: 'said', who: ['tailgate crew'] }],
  ['what has yuki sent', { action: 'said', who: ['yuki'] }],
  ['move my 3pm with jamie to friday', { action: 'move', who: ['jamie'], app: 'outlook', when: 'friday' }],
  ['push the acme call to friday 2pm', { action: 'move', who: [], meeting: 'acme call', when: 'friday 2pm' }],
  ['reschedule my meeting with lena to tomorrow at 4', { action: 'move', who: ['lena'], when: 'tomorrow at 4' }],
  ['invite lena and yuki 2pm tomorrow', { action: 'invite' }],
  ['open resume in finder', { action: 'open' }],
  ['push my thing with the bank people to friday', { action: 'move', who: [], when: 'friday' }],
  ['what should I do about the tailgate', { action: 'unknown' }],
];

test('the graded set: at least 36 of 40 read right, no message read as another action', () => {
  assert.equal(GRADED.length, 40);
  const misses = [];
  for (const [sentence, expected] of GRADED) {
    const got = readAsk(sentence, { names });
    const wrong = Object.entries(expected).filter(([key, value]) => JSON.stringify(key === 'who' ? got.who.map((w) => w.toLowerCase()) : got[key]) !== JSON.stringify(key === 'who' ? value.map((w) => w.toLowerCase()) : value));
    if (wrong.length) misses.push(`${sentence}\n   want ${JSON.stringify(expected)}\n   got  ${JSON.stringify({ action: got.action, who: got.who, app: got.app, words: got.words, meeting: got.meeting, when: got.when })}`);
  }
  const messageAsOther = GRADED.filter(([sentence, expected]) => expected.action === 'message' && readAsk(sentence, { names }).action !== 'message');
  assert.equal(messageAsOther.length, 0, `messages read as another action:\n${messageAsOther.map(([s]) => s).join('\n')}`);
  if (misses.length) console.log(`${misses.length} of 40 read wrong:\n${misses.join('\n')}`);
  assert.ok(misses.length <= 4, `${misses.length} of 40 read wrong (bar: at most 4):\n${misses.join('\n')}`);
});

test('without a known name the first word is the name, never a guess past it', () => {
  const got = readAsk('text zara see you soon');
  assert.deepEqual([got.action, got.who, got.words], ['message', ['zara'], 'See you soon']);
});

test('an empty or unreadable sentence is unknown, and an invite keeps its own reader', () => {
  assert.equal(readAsk('').action, 'unknown');
  assert.equal(readAsk('hmm').action, 'unknown');
  assert.equal(readAsk('schedule a meeting with lena friday 3pm').action, 'invite');
});

test('a colon ends the name: a two or three word name before it is one person, lowercase words before it stay words', () => {
  // A move from a text writes "email <name>: <ask>" (chat-email.js); 2026-10-17 the app read "Lucky Star" as "Lucky".
  assert.deepEqual(readAsk('email Lucky Star: ask about the bar tab').who, ['Lucky Star']);
  assert.equal(readAsk('email Lucky Star: ask about the bar tab').words, 'Ask about the bar tab');
  assert.deepEqual(readAsk('email Professor Smith: ask about the extension').who, ['Professor Smith']);
  assert.deepEqual(readAsk('text Ana Lopez: running late').who, ['Ana Lopez']);
  assert.deepEqual(readAsk('email KHouse: ask about the bar tab').who, ['KHouse']);
  assert.deepEqual(readAsk('email lena about the deadline: friday works').who, ['lena']);
  assert.deepEqual(readAsk('email jamie: thursday works').who, ['jamie']);
});
