import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { answerKey, createTokenFactory } from '../src/hikyaku/nebius.js';
import { costUsd, PRICES, recordUsage, runBy, usageLine, usageToday } from '../src/hikyaku/usage.js';

const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const tmp = () => mkdtemp(join(tmpdir(), 'usage-'));

test('cost at the listed price: $0.30 in and $0.90 out per million tokens; an unlisted model has no cost', () => {
  // The 2026-10-09 Liz call notes: 6,771 in, 1,580 out.
  assert.equal(costUsd(MODEL, { prompt_tokens: 6771, completion_tokens: 1580 }), 0.003453);
  assert.equal(costUsd('nvidia/other', { prompt_tokens: 1, completion_tokens: 1 }), null);
  assert.equal(costUsd(MODEL, {}), null);
});

test('the price table is the same in Loggie and in the call notes (byo.py)', async () => {
  const byo = await readFile(new URL('../transcriber/spike/byo.py', import.meta.url), 'utf8');
  const listed = Object.fromEntries([...byo.matchAll(/'([\w/.-]+)': \(([\d.]+), ([\d.]+)\)/g)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
  assert.deepEqual(listed, Object.fromEntries(Object.entries(PRICES).map(([model, price]) => [model, [...price]])));
});

test('every answer from the real service is logged with its path, even one cut at the token limit', async () => {
  const home = await tmp();
  const answer = (finish, out) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: MODEL, usage: { prompt_tokens: 1000, completion_tokens: out }, choices: [{ finish_reason: finish, message: { content: 'x' } }] }) });
  const client = createTokenFactory({ keyImpl: async () => 'k', fetchImpl: answer('length', 6000), hedgeMs: 0, usageHome: home });
  await client.post('{}', { path: 'rank' });
  await createTokenFactory({ keyImpl: async () => 'k', fetchImpl: answer('stop', 200), hedgeMs: 0, usageHome: home }).post('{}');
  const rows = (await readFile(join(home, 'nebius-usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.path, row.in, row.out, row.usd, row.finish_reason]), [['rank', 1000, 6000, 0.0057, 'length'], ['other', 1000, 200, 0.00048, 'stop']]);
});

test('a fake fetch in a test is never logged to the real folder', async () => {
  const client = createTokenFactory({ keyImpl: async () => 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"model":"m","choices":[{"message":{"content":"x"}}]}' }), hedgeMs: 0 });
  assert.equal((await client.post('{}')).content, 'x');
});

test("today's total counts only today, per path, and the panel line says it plainly", async () => {
  const home = await tmp();
  const now = new Date('2026-10-09T18:00:00');
  await recordUsage(home, { path: 'call-notes', model: MODEL, usage: { prompt_tokens: 6771, completion_tokens: 1580 }, by: 'app', now });
  await recordUsage(home, { path: 'rank', model: MODEL, usage: { prompt_tokens: 1500, completion_tokens: 600 }, by: 'app', now });
  await recordUsage(home, { path: 'rank', model: MODEL, usage: { prompt_tokens: 9, completion_tokens: 9 }, by: 'app', now: new Date('2026-10-08T12:00:00') });
  await writeFile(join(home, 'nebius-usage.jsonl'), 'not json\n', { flag: 'a' });
  const total = await usageToday(home, { now });
  assert.deepEqual([total.calls, total.in, total.out, total.usd], [2, 8271, 2180, 0.004443]);
  assert.deepEqual(total.byPath.rank, { calls: 1, in: 1500, out: 600, usd: 0.00099 });
  assert.equal(usageLine(total), 'Cloud AI today: 10,451 tokens, $0.0044, 2 calls');
  assert.equal(usageLine(await usageToday(await tmp(), { now })), null);
});

// 2026-10-10: $4.81 of a $5.02 day was an eval re-summarizing the same calls by hand, counted as Loggie's own spend
// and against its $3 limit. Hand-run work is "dev": shown beside Loggie's total, never in it.
test('hand-run spend is counted apart from Loggie\'s own, and the limit reads Loggie\'s only', async () => {
  const home = await tmp();
  const now = new Date('2026-10-10T20:00:00');
  await recordUsage(home, { path: 'mail', model: MODEL, usage: { prompt_tokens: 1000, completion_tokens: 100 }, by: 'app', now });
  await recordUsage(home, { path: 'call-notes', model: 'nvidia/Nemotron-3-Ultra-550b-a55b', usage: { prompt_tokens: 100000, completion_tokens: 20000 }, by: 'dev', now });
  await recordUsage(home, { path: 'mail', model: MODEL, usage: { prompt_tokens: 1000, completion_tokens: 100 }, by: 'app', cached: true, now });
  const total = await usageToday(home, { now });
  assert.deepEqual([total.calls, total.usd, total.reused], [2, 0.00039, 1]);
  assert.deepEqual([total.dev.calls, total.dev.usd], [1, 0.16]);
  assert.equal(usageLine(total), 'Cloud AI today: 2,200 tokens, $0.0004, 2 calls, 1 reused; test runs $0.1600');
  assert.equal(runBy({ LOGGIE_RUN_BY: 'app' }), 'app');
  assert.equal(runBy({}), 'dev', 'anything Loggie did not start is a test run');
});

test('the same request is paid once: the second is answered from the saved answer, logged at $0', async () => {
  const home = await tmp();
  let sent = 0;
  const fetchImpl = async () => { sent += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ model: MODEL, usage: { prompt_tokens: 5000, completion_tokens: 500 }, choices: [{ finish_reason: 'stop', message: { content: 'the answer' } }] }) }; };
  const client = createTokenFactory({ keyImpl: async () => 'k', fetchImpl, hedgeMs: 0, usageHome: home });
  const body = (first) => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `${first}Summarize the call.` }], max_tokens: 900, temperature: 0 });
  assert.equal((await client.post(body('Request 1a2b3c4d.\n\n'), { path: 'mail' })).content, 'the answer');
  const again = await client.post(body('Request 99ff00ee.\n\n'), { path: 'mail' });
  assert.deepEqual([again.content, again.cached, sent], ['the answer', true, 1], 'a different anti-cache line is still the same question');
  await client.post(body('Something else. '), { path: 'mail' });
  assert.equal(sent, 2, 'a different question is paid');
  await client.post(body('Request 1a2b3c4d.\n\n'), { path: 'test-key', fresh: true });
  assert.equal(sent, 3, 'fresh always asks');
  const rows = (await readFile(join(home, 'nebius-usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => [row.usd, Boolean(row.cached)]), [[0.00195, false], [0, true], [0.00195, false], [0.00195, false]]);
  assert.equal(answerKey(body('Request 1a2b3c4d.\n\n')), answerKey(body('')));
});

test('an answer cut at the token limit, or empty, is never saved: the next ask pays and may finish', async () => {
  const home = await tmp();
  let sent = 0;
  const fetchImpl = async () => { sent += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ model: MODEL, usage: { prompt_tokens: 10, completion_tokens: 900 }, choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }) }; };
  const client = createTokenFactory({ keyImpl: async () => 'k', fetchImpl, hedgeMs: 0, usageHome: home });
  await client.post('{"model":"m","messages":[{"role":"user","content":"x"}]}');
  await client.post('{"model":"m","messages":[{"role":"user","content":"x"}]}');
  assert.equal(sent, 2);
});
