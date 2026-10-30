// One move per thing (loggie-workspaces-integration F5): titles from his M&T card, one move per thread before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keyWords, sameThing } from '../src/hikyaku/workstreams.js';

test('the same interview from three threads is one thing; different things stay apart', () => {
  const prep = { title: 'Prepare for your M&T Bank EA tech interview', due: '2026-10-27' };
  assert.equal(sameThing({ title: 'Prepare for your interview with M&T Bank Corporation', due: '2026-10-27' }, prep), true, '3 shared key words');
  assert.equal(sameThing({ title: 'Prepare for the interview with David Calloway', due: '2026-10-27T15:00' }, prep), true, '2 key words and the same day');
  assert.equal(sameThing({ title: 'Prepare for the interview with David Calloway', due: '2026-10-28' }, prep), false, '2 key words, another day');
  assert.equal(sameThing({ title: 'Send interview details and prep notes to Harshita', due: '2026-10-26' }, prep), false);
  assert.equal(sameThing({ title: 'Prepare for your chat with Rowena Patel', due: '2026-10-23' }, prep), false);
  assert.deepEqual([...keyWords('Meet Lena for the mock interview')].sort(), ['interview', 'lena', 'meet', 'mock']);
});
