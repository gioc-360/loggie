// A sentence code cannot read (loggie-ask-box increment 8): asked first, then only the sentence goes to the cloud AI,
// whose pick is checked by code and shown as "Did you mean" before anything runs. The real runner and the real
// checks; the cloud AI is a fake. Made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { cloudPrompt, parsePick, rewrite } from '../src/hikyaku/ask-cloud.js';

const SENTENCE = 'yo can u let bruno n arlo know im running like 10 min behind';

test('the prompt carries only the sentence and the action list', () => {
  const prompt = cloudPrompt(SENTENCE);
  assert.match(prompt, /running like 10 min behind/);
  assert.match(prompt, /- message:.*- reply:.*- said:.*- invite:.*- move:/s);
});

test('a pick is checked: known action, names that are in the sentence, words for a message; else nothing', () => {
  const good = parsePick('{"action": "message", "who": ["bruno", "arlo"], "words": "I\'m running about 10 minutes behind", "app": null}', SENTENCE);
  assert.deepEqual([good.action, good.who, good.words], ['message', ['bruno', 'arlo'], "I'm running about 10 minutes behind"]);
  assert.equal(parsePick('{"action": "message", "who": ["Bruno Vance"], "words": "late"}', SENTENCE), null, 'a surname not in the sentence is invented');
  assert.equal(parsePick('{"action": "launch", "who": ["bruno"]}', SENTENCE), null);
  assert.equal(parsePick('{"action": "message", "who": ["bruno"], "words": ""}', SENTENCE), null);
  assert.equal(parsePick('sure! here you go', SENTENCE), null);
  assert.equal(parsePick('{"action": "message", "who": ["marisol"], "words": "hi"}', 'tell marisl hi').who[0], 'marisol', 'a one-letter slip on a long name passes');
});

test('the pick becomes a sentence the code readers take', () => {
  assert.equal(rewrite({ action: 'message', who: ['bruno', 'arlo'], words: 'Running 10 late', app: null }), 'text bruno and arlo Running 10 late');
  assert.equal(rewrite({ action: 'reply', who: ['jamie'], words: 'Thursday works' }), 'reply to jamie: Thursday works');
  assert.equal(rewrite({ action: 'invite', who: ['marisol'], when: 'tomorrow 5:30pm', kind: 'call', place: '' }), 'invite marisol tomorrow 5:30pm for a call');
  assert.equal(rewrite({ action: 'said', who: ['gideon'] }), 'what did gideon say');
});

async function setup({ consent = false, answer = '{"action": "message", "who": ["bruno", "arlo"], "words": "Running about 10 minutes behind"}' } = {}) {
  const seen = { prompts: [], once: [], always: 0, opened: 0 };
  const asker = createAsker({
    home: await mkdtemp(join(tmpdir(), 'ask-cloud-')), loadIndex: async () => [],
    openChat: async () => { seen.opened++; return {}; },
    think: { consent: async () => consent, allowAlways: async () => { seen.always++; }, complete: async (prompt, { once }) => { seen.prompts.push(prompt); seen.once.push(once); return answer; } },
  });
  return { asker, seen };
}

test('no yes: a question, and the sentence goes nowhere', async () => {
  const { asker, seen } = await setup();
  const result = await asker.run(SENTENCE).done;
  assert.deepEqual([result.outcome, result.status, result.yesFor], ['question', 'needs-yes', 'sentence']);
  assert.equal(seen.prompts.length, 0);
});

test('"this time": one cloud read, then Did you mean with the rewritten sentence; nothing runs or opens', async () => {
  const { asker, seen } = await setup();
  const result = await asker.run(SENTENCE, { cloud: 'once' }).done;
  assert.deepEqual([result.outcome, result.status, result.path], ['question', 'did-you-mean', 'cloud']);
  assert.equal(result.rewrite, 'text bruno and arlo Running about 10 minutes behind');
  assert.deepEqual(seen.once, [true]);
  assert.equal(seen.opened, 0);
});

test('"always" saves the yes once; a saved yes asks nothing; a bad pick says to rephrase', async () => {
  const always = await setup();
  await always.asker.run(SENTENCE, { cloud: 'always' }).done;
  assert.equal(always.seen.always, 1);
  const saved = await setup({ consent: true });
  assert.equal((await saved.asker.run(SENTENCE).done).status, 'did-you-mean');
  const bad = await setup({ consent: true, answer: '{"action": "message", "who": ["Zed"], "words": "hi"}' });
  const result = await bad.asker.run(SENTENCE).done;
  assert.equal(result.outcome, 'failed');
  assert.match(result.lines[0], /Try starting with "text"/);
});
