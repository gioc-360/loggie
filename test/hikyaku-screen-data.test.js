// Screen increment 1: the card data behind the Workstreams screen (news, price estimate, window end, asks) and the
// answer to an ask. Temp folders and made-up workstreams and people only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeItem, readChanges } from '../src/hikyaku/changes.js';
import { answerAsk, asksFor, estimateUsd, newsFor, readAnswered, readUsageRows, windowEnd } from '../src/hikyaku/screen-data.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';

const tmp = () => mkdtemp(join(tmpdir(), 'screen-data-'));
const NOW = new Date('2026-10-10T12:00:00Z');
const item = (fields) => makeItem({ source: 'outlook', at: '2026-10-09T10:00:00Z', title: 'Hello', who: [], ref: 'r1', thread: 't', workstream: null, how: 'none', candidates: [], ...fields });
const jsonl = (rows) => rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n';

async function home({ workstreams = [{ name: 'Acme Bank', kind: 'company', domains: ['acme.example'], words: [] }, { name: 'Harbor hackathon', kind: 'competition', domains: [], words: ['harbor'] }], changes = [] } = {}) {
  const dir = await tmp();
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify(workstreams));
  if (changes.length) await writeFile(join(dir, 'changes.jsonl'), jsonl(changes));
  return dir;
}

// --- newsFor

test('newsFor lists unseen routed items newest first, at most the limit, with only id, source, title and at', () => {
  const items = [
    item({ ref: 'a', at: '2026-10-01T00:00:00Z', workstream: 'Acme Bank', how: 'domain' }),
    item({ ref: 'b', at: '2026-10-05T00:00:00Z', workstream: 'Acme Bank', how: 'domain', title: 'Offer call' }),
    item({ ref: 'c', at: '2026-10-03T00:00:00Z', workstream: 'Acme Bank', how: 'domain' }),
    item({ ref: 'd', at: '2026-10-06T00:00:00Z', workstream: 'Harbor hackathon', how: 'word' }),
    item({ ref: 'e', at: '2026-10-07T00:00:00Z', candidates: ['Acme Bank'] }),
  ];
  const state = { 'Acme Bank': { seen: ['outlook:c'] } };
  assert.deepEqual(newsFor(items, state, 'Acme Bank'), [
    { id: 'outlook:b', source: 'outlook', title: 'Offer call', at: '2026-10-05T00:00:00.000Z' },
    { id: 'outlook:a', source: 'outlook', title: 'Hello', at: '2026-10-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(newsFor(items, state, 'Acme Bank', 1).map((n) => n.id), ['outlook:b']);
  assert.deepEqual(newsFor(items, state, 'Acme Bank', 1.9).map((n) => n.id), ['outlook:b']);
  assert.deepEqual(newsFor(items, state, 'Acme Bank', -2), []);
  assert.deepEqual(newsFor(items, {}, 'Nobody'), []);
});

test('newsFor keeps the later log line first when two items share a time', () => {
  const items = [
    item({ ref: 'first', workstream: 'Acme Bank', how: 'domain' }),
    item({ ref: 'second', workstream: 'Acme Bank', how: 'domain' }),
  ];
  assert.deepEqual(newsFor(items, {}, 'Acme Bank').map((n) => n.id), ['outlook:second', 'outlook:first']);
});

// --- estimateUsd and readUsageRows

test('estimateUsd is 0 for a workstream that does not use the cloud, undefined cloud included', () => {
  const rows = [{ path: 'mail', usd: 0.5 }];
  assert.equal(estimateUsd(rows, { cloud: 'off' }), 0);
  assert.equal(estimateUsd(rows, { cloud: 'claude' }), 0);
  assert.equal(estimateUsd(rows, {}), 0);
});

test('estimateUsd is the mean of the last ten priced mail rows, rounded to 4 decimals', () => {
  const rows = [
    { path: 'mail', usd: 100 }, // the 11th from the end: left out
    ...Array.from({ length: 9 }, () => ({ path: 'mail', usd: 0.001 })),
    { path: 'rank', usd: 50 },
    { path: 'mail', usd: null },
    { path: 'mail', usd: '0.4' },
    { path: 'mail', usd: Number.NaN },
    { path: 'mail', usd: 0.00234 },
  ];
  assert.equal(estimateUsd(rows, { cloud: 'nebius' }), Math.round(((9 * 0.001 + 0.00234) / 10) * 1e4) / 1e4);
  assert.equal(estimateUsd(rows, { cloud: 'nebius' }), 0.0011);
});

test('estimateUsd with no priced mail rows returns null', () => {
  assert.equal(estimateUsd([], { cloud: 'nebius' }), null);
  assert.equal(estimateUsd([{ path: 'rank', usd: 0.2 }, { path: 'mail', usd: null }], { cloud: 'nebius' }), null);
});

test('readUsageRows reads nebius-usage.jsonl in file order, skips bad lines, and a missing file is empty', async () => {
  const dir = await tmp();
  assert.deepEqual(await readUsageRows(dir), []);
  await writeFile(join(dir, 'nebius-usage.jsonl'), jsonl([{ path: 'mail', usd: 0.1 }, 'not json', 'null', { path: 'rank', usd: 0.2 }]));
  assert.deepEqual(await readUsageRows(dir), [{ path: 'mail', usd: 0.1 }, { path: 'rank', usd: 0.2 }]);
});

// --- windowEnd

test('windowEnd is the latest of the milestones and the due date, as a date', () => {
  assert.equal(windowEnd({ milestones: [{ at: '2026-10-20T15:00:00.000Z' }, { at: '2026-10-14T09:00:00.000Z' }], priority: { due: '2026-10-18' } }), '2026-10-20');
  assert.equal(windowEnd({ milestones: [{ at: '2026-10-12T09:00:00.000Z' }], priority: { due: '2026-11-02' } }), '2026-11-02');
  assert.equal(windowEnd({ milestones: [], priority: { due: '2026-10-11' } }), '2026-10-11');
});

test('windowEnd ignores unparseable milestones and a missing array, counts past dates, and is null with nothing', () => {
  assert.equal(windowEnd({ milestones: [{ at: 'soon' }, { at: '2026-09-01T00:00:00.000Z' }], priority: null }), '2026-09-01');
  assert.equal(windowEnd({ priority: { due: '2026-10-12' } }), '2026-10-12');
  assert.equal(windowEnd({ milestones: [{ at: 'soon' }], priority: { due: null } }), null);
  assert.equal(windowEnd({ priority: null }), null);
});

// --- readAnswered

test('readAnswered reads ids from asked.jsonl, skips a bad line, counts a No, and a missing file is empty', async () => {
  const dir = await tmp();
  assert.deepEqual([...await readAnswered(dir)], []);
  await writeFile(join(dir, 'asked.jsonl'), jsonl([{ id: 'outlook:a', answer: 'Acme Bank' }, '{broken', { answer: 'x' }, { id: 42 }, { id: 'whatsapp:b', answer: null }]));
  assert.deepEqual([...await readAnswered(dir)].sort(), ['outlook:a', 'whatsapp:b']);
});

test('readAnswered throws a read error other than a missing file', async () => {
  const dir = await tmp();
  await mkdir(join(dir, 'asked.jsonl'));
  await assert.rejects(readAnswered(dir));
});

// --- asksFor

test('asksFor lists unsure items naming this workstream, not answered, newest first, at most the limit', () => {
  const who = [{ name: 'Ana', address: 'ana@bank.example' }];
  const items = [
    item({ ref: 'old', thread: 'old', at: '2026-10-01T00:00:00Z', candidates: ['Acme Bank', 'Harbor hackathon'], who }),
    item({ ref: 'new', thread: 'new', at: '2026-10-08T00:00:00Z', candidates: ['Acme Bank'], title: 'Coffee?' }),
    item({ ref: 'mid', thread: 'mid', at: '2026-10-04T00:00:00Z', candidates: ['Acme Bank'] }),
    item({ ref: 'done', thread: 'done', at: '2026-10-09T00:00:00Z', candidates: ['Acme Bank'] }),
    item({ ref: 'other', thread: 'other', at: '2026-10-09T00:00:00Z', candidates: ['Harbor hackathon'] }),
    item({ ref: 'routed', thread: 'routed', at: '2026-10-09T00:00:00Z', workstream: 'Acme Bank', how: 'domain' }),
    item({ ref: 'extra', thread: 'extra', at: '2026-09-01T00:00:00Z', candidates: ['Acme Bank'] }),
  ];
  const answered = new Set(['outlook:done']);
  assert.deepEqual(asksFor(items, answered, 'Acme Bank').map((a) => a.id), ['outlook:new', 'outlook:mid', 'outlook:old']);
  assert.deepEqual(asksFor(items, answered, 'Acme Bank', 10).map((a) => a.id), ['outlook:new', 'outlook:mid', 'outlook:old', 'outlook:extra']);
  assert.deepEqual(asksFor(items, answered, 'Acme Bank', 3).at(-1), { id: 'outlook:old', source: 'outlook', title: 'Hello', at: '2026-10-01T00:00:00.000Z', who });
  assert.deepEqual(asksFor(items, answered, 'Nobody'), []);
});

test('asksFor asks once per conversation: its newest unsure item, never one already answered, with the quote', () => {
  const items = [
    item({ source: 'messages', ref: 'c1@1', thread: 'c1', at: '2026-10-08T00:00:00Z', candidates: ['Acme Bank'], quote: 'your interview is Friday?' }),
    item({ source: 'messages', ref: 'c1@2', thread: 'c1', at: '2026-10-09T00:00:00Z', candidates: ['Acme Bank'], quote: 'Hit me up Sunday evening' }),
    item({ source: 'messages', ref: 'c2@1', thread: 'c2', at: '2026-10-07T00:00:00Z', candidates: ['Acme Bank'] }),
    item({ source: 'messages', ref: 'c2@2', thread: 'c2', at: '2026-10-09T00:00:00Z', candidates: ['Acme Bank'] }),
  ];
  const asks = asksFor(items, new Set(['messages:c2@1']), 'Acme Bank');
  assert.deepEqual(asks.map((a) => a.id), ['messages:c1@2']);
  assert.equal(asks[0].quote, 'Hit me up Sunday evening');
});

// Codex review, round 2 (2026-10-23): a chat suggested for one workspace, then for another on newer words, made two
// Today questions, one per workspace, because the newest per chat was picked after the workspace filter.
test('codex r2 3: one chat with suggestions for two workspaces is asked once, in the newest one only', () => {
  const items = [
    item({ source: 'messages', ref: 'c1@1', thread: 'c1', at: '2026-10-08T00:00:00Z', candidates: ['Acme Bank'], quote: 'your interview' }),
    item({ source: 'messages', ref: 'c1@2', thread: 'c1', at: '2026-10-09T00:00:00Z', candidates: ['Harbor hackathon'], quote: 'the harbor challenge' }),
  ];
  assert.deepEqual(asksFor(items, new Set(), 'Acme Bank'), []);
  assert.deepEqual(asksFor(items, new Set(), 'Harbor hackathon').map((a) => a.id), ['messages:c1@2']);
});

// --- answerAsk

test('a No is written to asked.jsonl, saves no one, logs no copy, and is never asked again', async () => {
  const ask = item({ ref: 'q1', candidates: ['Acme Bank'], who: [{ name: 'Ana', address: 'ana@bank.example' }] });
  const dir = await home({ changes: [ask] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: null, now: NOW }), { saved: 0, logged: 0 });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'asked.jsonl'), 'utf8')), { at: NOW.toISOString(), id: ask.id, answer: null });
  assert.equal((await readChanges(dir)).length, 1);
  assert.equal((await readWorkstreams(dir)).find((w) => w.name === 'Acme Bank').people, undefined);
  assert.deepEqual(asksFor(await readChanges(dir), await readAnswered(dir), 'Acme Bank'), []);
});

test('a Yes on a 1:1 WhatsApp item saves the handle and logs one routed copy', async () => {
  const ask = item({ source: 'whatsapp', ref: 'chat-9@2026-10-09T10:00:00.000Z', thread: 'chat-9', title: 'Lena', who: [{ name: 'Lena', handle: '+1 (555) 010-2030' }], candidates: ['Acme Bank', 'Harbor hackathon'] });
  const dir = await home({ changes: [ask] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Harbor hackathon', now: NOW }), { saved: 1, logged: 1 });
  assert.deepEqual((await readWorkstreams(dir)).find((w) => w.name === 'Harbor hackathon').people, [{ name: 'Lena', handle: '+1 (555) 010-2030' }]);
  const log = await readChanges(dir);
  assert.equal(log.length, 2);
  const copy = log[1];
  assert.deepEqual(copy, makeItem(copy));
  assert.equal(copy.id, 'whatsapp:chat-9@2026-10-09T10:00:00.000Z#asked');
  assert.equal(copy.workstream, 'Harbor hackathon');
  assert.equal(copy.how, 'asked');
  assert.equal(copy.thread, 'chat-9');
  assert.deepEqual(copy.candidates, []);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'asked.jsonl'), 'utf8')), { at: NOW.toISOString(), id: ask.id, answer: 'Harbor hackathon' });
  // The question is closed for every candidate.
  const answered = await readAnswered(dir);
  assert.deepEqual(asksFor(log, answered, 'Acme Bank'), []);
});

test('a Yes on a group chat saves no one but still logs the routed copy', async () => {
  const ask = item({ source: 'messages', ref: 'grp', who: [{ name: 'A', handle: '+15550001' }, { name: 'B', handle: '+15550002' }], candidates: ['Acme Bank'] });
  const noHandle = item({ source: 'messages', ref: 'solo', who: [{ name: 'C', address: 'c@x.example' }], candidates: ['Acme Bank'] });
  const dir = await home({ changes: [ask, noHandle] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 1 });
  assert.deepEqual(await answerAsk({ home: dir, item: noHandle, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 1 });
  assert.equal((await readWorkstreams(dir)).find((w) => w.name === 'Acme Bank').people, undefined);
});

test('a Yes on an email saves the first address in who, lowercased, with its name', async () => {
  const ask = item({ ref: 'mail-1', who: [{ name: 'No Address' }, { name: 'Ana Ruiz', address: 'Ana@Bank.example' }, { name: 'Bo', address: 'bo@bank.example' }], candidates: ['Acme Bank'] });
  const dir = await home({ changes: [ask] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Acme Bank', now: NOW }), { saved: 1, logged: 1 });
  assert.deepEqual((await readWorkstreams(dir)).find((w) => w.name === 'Acme Bank').people, [{ name: 'Ana Ruiz', address: 'ana@bank.example' }]);
});

test('a Yes for a workstream that is not among the candidates is allowed', async () => {
  const ask = item({ ref: 'mail-2', who: [{ name: 'Ana', address: 'ana@bank.example' }], candidates: ['Harbor hackathon'] });
  const dir = await home({ changes: [ask] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Acme Bank', now: NOW }), { saved: 1, logged: 1 });
});

test('saving the same person twice adds no duplicate, by address or by handle digits', async () => {
  const workstreams = [{ name: 'Acme Bank', kind: 'company', domains: [], words: [], people: [{ name: 'Ana', address: 'ana@bank.example' }, { name: 'Lena', handle: '+15550102030' }] }];
  const mail = item({ ref: 'm', who: [{ name: 'Ana R', address: 'ANA@bank.example' }], candidates: ['Acme Bank'] });
  const chat = item({ source: 'whatsapp', ref: 'c', who: [{ name: 'Lena', handle: '+1 555 010 2030' }], candidates: ['Acme Bank'] });
  const dir = await home({ workstreams, changes: [mail, chat] });
  assert.deepEqual(await answerAsk({ home: dir, item: mail, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 1 });
  assert.deepEqual(await answerAsk({ home: dir, item: chat, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 1 });
  assert.deepEqual((await readWorkstreams(dir)).find((w) => w.name === 'Acme Bank').people, workstreams[0].people);
});

test('answering the same Yes twice saves the person once and logs the copy once', async () => {
  const ask = item({ ref: 'twice', who: [{ name: 'Ana', address: 'ana@bank.example' }], candidates: ['Acme Bank'] });
  const dir = await home({ changes: [ask] });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Acme Bank', now: NOW }), { saved: 1, logged: 1 });
  assert.deepEqual(await answerAsk({ home: dir, item: ask, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 0 });
  assert.equal((await readWorkstreams(dir)).find((w) => w.name === 'Acme Bank').people.length, 1);
  assert.equal((await readChanges(dir)).length, 2);
});

test('a handle with no digits is matched lowercased', async () => {
  const workstreams = [{ name: 'Acme Bank', kind: 'company', domains: [], words: [], people: [{ name: 'Kai', handle: 'Kai.Apple' }] }];
  const chat = item({ source: 'messages', ref: 'k', who: [{ name: 'Kai', handle: 'kai.apple' }], candidates: ['Acme Bank'] });
  const dir = await home({ workstreams, changes: [chat] });
  assert.deepEqual(await answerAsk({ home: dir, item: chat, workstream: 'Acme Bank', now: NOW }), { saved: 0, logged: 1 });
});

test('answerAsk with an unknown or unnamed workstream throws and writes nothing', async () => {
  const ask = item({ ref: 'q', who: [{ name: 'Ana', address: 'ana@bank.example' }], candidates: ['Acme Bank'] });
  const workstreams = [{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }, { name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true }];
  const dir = await home({ workstreams, changes: [ask] });
  const before = await readFile(join(dir, 'workstreams.json'), 'utf8');
  await assert.rejects(answerAsk({ home: dir, item: ask, workstream: 'Nope', now: NOW }), { message: 'No workspace named "Nope".' });
  await assert.rejects(answerAsk({ home: dir, item: ask, workstream: 'Inbox', now: NOW }), { message: 'No workspace named "Inbox".' });
  assert.equal(await readFile(join(dir, 'workstreams.json'), 'utf8'), before);
  assert.equal((await readChanges(dir)).length, 1);
  await assert.rejects(readFile(join(dir, 'asked.jsonl')), { code: 'ENOENT' });
});

test('a failure before the asked.jsonl line leaves the question open', async () => {
  const ask = item({ ref: 'q', who: [{ name: 'Ana', address: 'ana@bank.example' }], candidates: ['Acme Bank'] });
  const dir = await home({ changes: [ask] });
  // The change log cannot be appended to (a folder in its place), so the routed copy fails after the person is saved.
  const blocked = await tmp();
  await writeFile(join(blocked, 'workstreams.json'), await readFile(join(dir, 'workstreams.json'), 'utf8'));
  await mkdir(join(blocked, 'changes.jsonl'));
  await assert.rejects(answerAsk({ home: blocked, item: ask, workstream: 'Acme Bank', now: NOW }));
  assert.deepEqual([...await readAnswered(blocked)], []);
});
