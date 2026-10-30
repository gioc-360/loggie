// The word map's edges found on real data (loggie-ask-wordmap). Made-up names that copy the shape of what was found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSentence } from '../src/hikyaku/quick-invite.js';
import { readAsk } from '../src/hikyaku/ask.js';
import { readWords, tokenize } from '../src/hikyaku/wordmap.js';

const NOW = new Date(2026, 9, 12, 9, 0);
// an inbox holds businesses whose names are places ("Birchwood Apartments Leasing") beside people
const PEOPLE = [
  { name: 'Nina Patel', address: 'nina@example.edu', count: 3 },
  { name: 'Birchwood Apartments Leasing', address: 'leasing@example.com', count: 0 },
  { name: 'Flex + Birchwood', address: 'rent@example.org', count: 0 },
];

test('the word after "at" is the place, even when a sender shares its name', () => {
  const plan = readSentence('tomorrow 1730 invite nina about the rules at birchwood', { people: PEOPLE, now: NOW });
  assert.deepEqual(plan.people.map((p) => p.name), ['Nina Patel']);
  assert.equal(plan.place, 'birchwood');
  assert.equal(plan.title, 'the rules');
});

test('two names join only through and, & or a comma: a chat named like a word does not swallow the message', () => {
  const names = ['Taro Kim', 'Running club', 'Lena Ortiz'];
  const got = readAsk('text taro running late', { names });
  assert.deepEqual([got.who, got.words], [['taro'], 'Running late']);
  const order = readAsk('running late, text taro', { names });
  assert.deepEqual([order.who, order.words], [['taro'], 'Running late']);
});

test('each word keeps its place in the sentence, even when a mistyped key word ("schdule") is fixed before reading', () => {
  const sentence = 'schdule lunch w nina tmrw noon';
  const map = readWords(sentence, { action: 'invite', isName: (t) => t === 'nina' });
  assert.deepEqual(map.words.map((w) => sentence.slice(w.start, w.end)), tokenize(sentence).map((w) => w.text));
  assert.deepEqual(map.words.map((w) => w.role), ['action', 'kind', 'mark', 'who', 'when', 'when']);
});
