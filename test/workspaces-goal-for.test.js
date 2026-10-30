// What a workspace is for (loggie-workspaces-integration F2): shown only with a quote code finds word for word in what
// the model read. Made-up mail only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { catchUpPrompt, checkFor } from '../src/hikyaku/workstreams.js';

const SEEN = '[1] Applicant | Sam Lee\n- USER, 2026-10-20: My goal is to join the Technology Executive Associate program next summer.';

test('a "for" stays only when its quote is in what the model read, and its phrase is 3 to 8 words', () => {
  assert.deepEqual(checkFor({ phrase: 'the Technology Executive Associate program', quote: 'My goal is to join the Technology Executive Associate program next summer.' }, SEEN),
    { phrase: 'the Technology Executive Associate program', quote: 'My goal is to join the Technology Executive Associate program next summer.' });
  assert.equal(checkFor({ phrase: 'land an offer at the bank', quote: 'I want an offer from the bank.' }, SEEN), null, 'a quote not in the threads is dropped');
  assert.equal(checkFor({ phrase: 'offer', quote: 'My goal is to join the Technology Executive Associate program' }, SEEN), null, 'too short a phrase');
  assert.equal(checkFor(null, SEEN), null);
});

test('the catch-up asks for "for" the way Gio approved, null when no sentence says it', () => {
  const prompt = catchUpPrompt({ name: 'Bank Offer', goal: null, digests: [SEEN], profile: '', today: '2026-10-26' });
  assert.match(prompt, /- for: what this workstream is for, 3 to 8 words, in the user's own terms, and the exact sentence from the threads above that says it/);
  assert.match(prompt, /null when no sentence says it/);
  assert.match(prompt, /"for": null\}/);
});
