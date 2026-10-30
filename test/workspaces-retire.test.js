// Retire a workspace (loggie-workspaces-integration): it leaves every list but keeps its history and can come back.
// Made-up workspaces only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dismissedNames, readWorkstreams, retiredWorkstreams, retireWorkstream, unretireWorkstream } from '../src/hikyaku/workstreams.js';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'retire-'));
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([
    { name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true },
    { name: 'Bank Offer', kind: 'job', domains: ['bank.example'], words: ['offer'] },
    { name: 'Karaoke Night', kind: 'other', domains: [], words: ['karaoke'] },
  ]));
  return root;
}

test('a retired workspace leaves every list, stays on file, and Bring back returns it', async () => {
  const root = await home();
  const done = await retireWorkstream(root, 'Karaoke Night', { now: new Date('2026-10-26T12:00:00Z') });
  assert.equal(done.retired, '2026-10-26T12:00:00.000Z');
  assert.deepEqual((await readWorkstreams(root)).map((item) => item.name), ['Inbox', 'Bank Offer'], 'routing, pickers and Today read this list');
  assert.deepEqual(await retiredWorkstreams(root), [{ name: 'Karaoke Night', label: null, retired: '2026-10-26T12:00:00.000Z' }]);
  assert.deepEqual(await dismissedNames(root), ['Karaoke Night'], 'its moves do not come back as a folder card');
  const onFile = JSON.parse(await readFile(join(root, 'workstreams.json'), 'utf8'));
  assert.deepEqual(onFile.find((item) => item.name === 'Karaoke Night').words, ['karaoke'], 'nothing about it is lost');
  await unretireWorkstream(root, 'Karaoke Night');
  assert.deepEqual((await readWorkstreams(root)).map((item) => item.name), ['Inbox', 'Bank Offer', 'Karaoke Night']);
  assert.deepEqual(await retiredWorkstreams(root), []);
});

test('only a live workspace can retire, and the Inbox never does', async () => {
  const root = await home();
  await assert.rejects(retireWorkstream(root, 'Nope'), /No workspace named/);
  await assert.rejects(retireWorkstream(root, 'Inbox'), /cannot be retired/);
  await retireWorkstream(root, 'Bank Offer');
  await assert.rejects(retireWorkstream(root, 'Bank Offer'), /No workspace named/);
  await assert.rejects(unretireWorkstream(root, 'Karaoke Night'), /No retired workspace/);
});
