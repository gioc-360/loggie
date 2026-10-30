import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendChanges, makeItem, readChanges, readLooked, writeLooked } from '../src/hikyaku/changes.js';
import { readWorkstreams, saveWorkstreamFields } from '../src/hikyaku/workstreams.js';

const home = () => mkdtemp(join(tmpdir(), 'loggie-changes-'));
const email = { source: 'outlook', at: '2026-10-09T15:00:00Z', ref: 'msg-1', title: 'RE: Introductions', who: [{ name: 'Ana', address: 'Ana@Example.com' }], workstream: 'Bank Offer', how: 'domain' };

test('a change item keeps its shape and id', () => {
  const item = makeItem(email);
  assert.equal(item.id, 'outlook:msg-1');
  assert.equal(item.at, '2026-10-09T15:00:00.000Z');
  assert.deepEqual(item.who, [{ name: 'Ana', address: 'ana@example.com' }]);
  assert.deepEqual(item.candidates, []);
});

test('a change item refuses an unknown source, a missing time and a route with no evidence', () => {
  assert.throws(() => makeItem({ ...email, source: 'slack' }), /Unknown change source/);
  assert.throws(() => makeItem({ ...email, at: 'yesterday' }), /time it happened/);
  assert.throws(() => makeItem({ ...email, how: 'none' }), /evidence that routed it/);
  assert.throws(() => makeItem({ ...email, ref: '' }), /source id/);
});

test('an unsure item has no workstream, how none, and keeps its candidates', () => {
  const item = makeItem({ ...email, workstream: null, how: 'person', candidates: ['Loggie', 'Hospitality hackathon', 'Loggie'] });
  assert.equal(item.workstream, null);
  assert.equal(item.how, 'none');
  assert.deepEqual(item.candidates, ['Loggie', 'Hospitality hackathon']);
});

test('the log appends once per id and filters by time and workstream', async () => {
  const dir = await home();
  assert.equal((await appendChanges(dir, [email, email])).length, 1);
  assert.equal((await appendChanges(dir, [email, { ...email, ref: 'msg-2', at: '2026-10-10T09:00:00Z' }])).length, 1);
  assert.equal((await readChanges(dir)).length, 2);
  assert.deepEqual((await readChanges(dir, { since: '2026-10-09T15:00:00Z' })).map((item) => item.ref), ['msg-2']);
  assert.equal((await readChanges(dir, { workstream: 'Pharma Case' })).length, 0);
});

test('watermarks merge per source and a broken file fails loud', async () => {
  const dir = await home();
  assert.deepEqual(await readLooked(dir), {});
  await writeLooked(dir, 'outlook', '2026-10-10T12:00:00.000Z');
  await writeLooked(dir, 'gmail', { 'Bank Offer': '2026-10-10T12:00:00.000Z' });
  assert.deepEqual(Object.keys(await readLooked(dir)), ['outlook', 'gmail']);
  await assert.rejects(writeLooked(dir, 'slack', 'x'), /Unknown change source/);
  await writeFile(join(dir, 'looked.json'), '{not json');
  await assert.rejects(readLooked(dir), /could not read when it last looked/);
});

test('workstreams keep valid people, stake and park, and drop invalid ones', async () => {
  const dir = await home();
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([
    { name: 'Bank Offer', kind: 'company', domains: ['bank.example'], words: [], people: [{ name: 'Ana', address: 'ANA@bank.example' }, { name: 'Ivy', handle: '+16075550100' }, { name: 'no route' }, 'x'], stake: 'more', parkedUntil: '2026-10-20' },
    { name: 'Pharma Case', kind: 'competition', domains: [], words: [], stake: 'urgent', parkedUntil: 'next week' },
  ]));
  const [mt, other] = await readWorkstreams(dir);
  assert.deepEqual(mt.people, [{ name: 'Ana', address: 'ana@bank.example' }, { name: 'Ivy', handle: '+16075550100' }]);
  assert.equal(mt.stake, 'more');
  assert.equal(mt.parkedUntil, '2026-10-20');
  assert.equal('stake' in other, false);
  assert.equal('parkedUntil' in other, false);
  assert.equal('people' in other, false);
});

test('saving fields changes only those fields, clears with null and refuses bad values', async () => {
  const dir = await home();
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Pharma Case', kind: 'competition', domains: ['pharma.example'], words: ['Pharma'], goal: 'Win or place', cloud: 'off' }]));
  const saved = await saveWorkstreamFields(dir, 'Pharma Case', { parkedUntil: '2026-10-20', stake: 'less' });
  assert.equal(saved.parkedUntil, '2026-10-20');
  assert.equal(saved.stake, 'less');
  await saveWorkstreamFields(dir, 'Pharma Case', { stake: null });
  const raw = JSON.parse(await readFile(join(dir, 'workstreams.json'), 'utf8'))[0];
  assert.equal('stake' in raw, false);
  assert.deepEqual(raw.domains, ['pharma.example']);
  await assert.rejects(saveWorkstreamFields(dir, 'Pharma Case', { stake: 'urgent' }), /stake is not valid/);
  await assert.rejects(saveWorkstreamFields(dir, 'Nope', { stake: 'more' }), /No workspace named/);
});

// Codex review, 2026-10-23: writeLooked wrote looked.json in place, so a write cut halfway left JSON readLooked
// refuses and every refresh after it threw. It now writes a temporary file and renames it over looked.json; a
// read-only looked.json shows the difference, since only a rename can replace it.
test('writeLooked: replaces looked.json whole, by rename, and leaves no temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loggie-looked-'));
  await writeLooked(dir, 'messages', '2026-10-23T10:00:00.000Z');
  await chmod(join(dir, 'looked.json'), 0o444);
  await writeLooked(dir, 'call', '2026-10-23T11:00:00.000Z');
  assert.deepEqual(await readLooked(dir), { messages: '2026-10-23T10:00:00.000Z', call: '2026-10-23T11:00:00.000Z' });
  assert.deepEqual(await readdir(dir), ['looked.json']);
});

// Codex review, round 2 (2026-10-23): two writes at once shared one temporary file, so one threw ENOENT and its value
// was lost.
test('codex r2 4: two writeLooked calls at once both land', async () => {
  const dir = await home();
  await Promise.all([writeLooked(dir, 'messages', '2026-10-23T10:00:00.000Z'), writeLooked(dir, 'chatResorted', '2026-10-23T10:00:00.000Z')]);
  const looked = await readLooked(dir);
  assert.equal(looked.messages, '2026-10-23T10:00:00.000Z');
  assert.equal(looked.chatResorted, '2026-10-23T10:00:00.000Z');
});
