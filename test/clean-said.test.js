// The transcript as read (clean-said.js): filler and repeats out, words never added or swapped. Lines from real calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanSaid } from '../src/hikyaku/clean-said.js';

test('filler sounds, stutters and repeated phrases come out; the words said stay in order', () => {
  assert.equal(cleanSaid('So um I spoke to Jules last night because she can\'t make it today. Right. She\'s away. Um. But I was just saying I I went to the rules of the hackathon.'),
    'So I spoke to Jules last night because she can\'t make it today. Right. She\'s away. But I was just saying I went to the rules of the hackathon.');
  assert.equal(cleanSaid('So like here\'s the um oh okay okay okay okay so if if we do Loggie plus um pay search'), 'So like here\'s the oh okay so if we do Loggie plus pay search');
  assert.equal(cleanSaid('Yeah, we should we should do it'), 'Yeah, we should do it');
  assert.equal(cleanSaid('uh, the license, uh, the stuff like that.'), 'The license, the stuff like that.');
  assert.equal(cleanSaid('the API from Nibius (unclear). Yes.'), 'The API from Nibius. Yes.');
  assert.equal(cleanSaid('Hmm. Mm-hmm. Uh-huh, that works.'), 'Mm-hmm. Uh-huh, that works.', 'an answer (mm-hmm, uh-huh) is a word, not a filler');
  assert.equal(cleanSaid('I mean, you know, it\'s like 60%'), 'I mean, you know, it\'s like 60%');
});

test('every word left was said, in the order said', () => {
  const said = 'Um so uh I I think we we are at at 60%. Uh. It\'s definitely not not 40.';
  const words = (text) => text.toLowerCase().replace(/[^a-z0-9%' ]/g, ' ').split(/\s+/).filter(Boolean);
  const left = words(cleanSaid(said));
  let i = 0;
  for (const word of words(said)) if (word === left[i]) i++;
  assert.equal(i, left.length, 'the cleaned words are a subsequence of the words said');
});
