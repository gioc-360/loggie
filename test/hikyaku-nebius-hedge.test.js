// The backup copy in nebius.js: a second identical request only when the first is slow, the first good answer wins,
// the loser is cancelled, and `copies` says how many went. Fake fetch, short delays, no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenFactory } from '../src/hikyaku/nebius.js';

const BODY = JSON.stringify({ model: 'nvidia/nemotron-3-super-120b-a12b', messages: [{ role: 'user', content: 'x' }] });
const answer = (content) => JSON.stringify({ model: 'nvidia/nemotron-3-super-120b-a12b', choices: [{ finish_reason: 'stop', message: { content } }], usage: {} });

// Each call to fetch takes the next plan: { ms, status, content }. Aborted calls reject the way fetch does.
function fakeFetch(plans) {
  const calls = [];
  const fetchImpl = (url, options) => {
    const plan = plans[calls.length] || plans.at(-1);
    const call = { body: options.body, aborted: false };
    calls.push(call);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: (plan.status || 200) < 400, status: plan.status || 200, text: async () => answer(plan.content || 'ok') }), plan.ms);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); call.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  };
  return { fetchImpl, calls };
}
const client = (fetchImpl, hedgeMs = 60) => createTokenFactory({ keyImpl: async () => 'tf-fake-key', fetchImpl, hedgeMs });

test('a quick answer goes once', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ms: 10, content: 'first' }]);
  const out = await client(fetchImpl).post(BODY);
  assert.equal(out.content, 'first'); assert.equal(out.copies, 1); assert.equal(calls.length, 1);
});

test('a slow first copy gets a backup, the backup wins, the slow one is cancelled', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ms: 1000, content: 'slow' }, { ms: 10, content: 'backup' }]);
  const t0 = Date.now();
  const out = await client(fetchImpl).post(BODY);
  assert.equal(out.content, 'backup'); assert.equal(out.copies, 2); assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body, 'the backup is the same bytes');
  assert.ok(calls[0].aborted, 'the slow copy was cancelled');
  assert.ok(Date.now() - t0 < 500);
});

test('if the first copy answers while the backup is out, the first wins', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ms: 90, content: 'first' }, { ms: 1000, content: 'backup' }]);
  const out = await client(fetchImpl).post(BODY);
  assert.equal(out.content, 'first'); assert.equal(out.copies, 2); assert.ok(calls[1].aborted);
});

test('an HTTP error before the backup is due fails the call, with no backup', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ms: 10, status: 401 }]);
  await assert.rejects(client(fetchImpl).post(BODY), /HTTP 401/);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 1);
});

test('a slow copy that then errors still lets the backup win; both failing fails the call', async () => {
  const one = fakeFetch([{ ms: 100, status: 503 }, { ms: 80, content: 'backup' }]);
  assert.equal((await client(one.fetchImpl).post(BODY)).content, 'backup');
  const two = fakeFetch([{ ms: 100, status: 503 }, { ms: 80, status: 502 }]);
  await assert.rejects(client(two.fetchImpl).post(BODY), /HTTP 503/);
});

test('hedgeMs 0 turns the backup off', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ms: 150, content: 'only' }]);
  const out = await client(fetchImpl, 0).post(BODY);
  assert.equal(out.copies, 1); assert.equal(calls.length, 1);
});

test('no error message carries the key', async () => {
  const { fetchImpl } = fakeFetch([{ ms: 10, status: 500 }]);
  await assert.rejects(client(fetchImpl).post(BODY), (error) => !/tf-fake-key/.test(error.message));
});
