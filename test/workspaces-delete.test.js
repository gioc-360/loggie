// Delete a workspace (loggie-delete-workspace, Gio 2026-10-28: "theres no way to delete workstreams"): it leaves every
// list for good, the Retired fold too, and its open-move folder never comes back as a card. Made-up workspaces only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteWorkstream, dismissedNames, readWorkstreams, retiredWorkstreams, retireWorkstream } from '../src/hikyaku/workstreams.js';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'delete-'));
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([
    { name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true },
    { name: 'Bank Offer', kind: 'job', domains: ['bank.example'], words: ['offer'] },
    { name: 'Karaoke Night', kind: 'other', domains: [], words: ['karaoke'] },
    { name: 'Old Club', kind: 'other', domains: [], words: [] },
  ]));
  return root;
}

test('a deleted workspace leaves every list, the Retired fold too, and stays on file so it is never found again', async () => {
  const root = await home();
  const done = await deleteWorkstream(root, 'Karaoke Night', { now: new Date('2026-10-28T12:00:00Z') });
  assert.equal(done.deleted, '2026-10-28T12:00:00.000Z');
  assert.deepEqual((await readWorkstreams(root)).map((item) => item.name), ['Inbox', 'Bank Offer', 'Old Club']);
  assert.ok((await dismissedNames(root)).includes('Karaoke Night'), 'its moves folder does not come back as a card');
  const onFile = JSON.parse(await readFile(join(root, 'workstreams.json'), 'utf8'));
  assert.ok(onFile.some((item) => item.name === 'Karaoke Night'), 'kept on file, marked, so discovery never offers it again');
});

test('a retired workspace can be deleted, and then it is gone from Retired too; the Inbox cannot be deleted', async () => {
  const root = await home();
  await retireWorkstream(root, 'Old Club');
  assert.deepEqual((await retiredWorkstreams(root)).map((item) => item.name), ['Old Club']);
  await deleteWorkstream(root, 'Old Club');
  assert.deepEqual(await retiredWorkstreams(root), []);
  await assert.rejects(deleteWorkstream(root, 'Inbox'), /Inbox cannot be deleted/);
  await assert.rejects(deleteWorkstream(root, 'Nobody'), /No workspace named "Nobody"/);
  await assert.rejects(deleteWorkstream(root, 'Old Club'), /No workspace named "Old Club"/, 'deleting twice is refused');
});
