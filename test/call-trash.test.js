// Delete recording (loggie right-click, 2026-10-28; Gio: "yes, to the macOS Trash"): refused while the call records,
// transcribes, writes its notes or waits for the yes; else, after his yes, taken off its workspace first, then its
// folder handed to the Trash (shell.trashItem in the app, a recorder here). Never rm. Temp folders, made-up calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TRASH_REFUSED, trashCall } from '../src/hikyaku/call-trash.js';

const ID = '2026-10-05-1400-coffee-chat-with-sam';
async function setup({ state = 'done' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'loggie-trash-'));
  const folder = join(home, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam', start: '2026-10-05T18:00:00Z', workstream: 'Acme Bank' }));
  if (state !== 'transcribing' && state !== 'empty') await writeFile(join(folder, 'transcript.md'), '# Coffee chat with Sam\n\n[00:05] Sam: hello\n');
  if (state === 'transcribing') await writeFile(join(folder, 'stop.log'), 'transcribing\n');
  if (state === 'recording') await writeFile(join(home, 'calls', 'current.json'), JSON.stringify({ dir: folder, started: 1760000000 }));
  if (state === 'waiting' || state === 'writing') {
    await mkdir(join(home, 'runs', '20261005-190000-abcd'), { recursive: true });
    await writeFile(join(home, 'runs', '20261005-190000-abcd', 'send.json'), JSON.stringify({ folder, what: 'call-notes', status: state === 'waiting' ? 'pending' : 'sending', created: '2026-10-05T19:00:00Z' }));
  }
  return { home, folder };
}
function recorder() {
  const order = [];
  return {
    order,
    confirm: async ({ title }) => { order.push(['confirm', title]); return true; },
    refile: async ({ id, workstream }) => { order.push(['refile', id, workstream]); return { from: 'Acme Bank', to: null, none: true, retired: ['task_1'] }; },
    trash: async (path) => { order.push(['trash', path]); },
  };
}

test('Delete waits while anything still owns the call: recording, transcribing, writing, waiting for the yes', async () => {
  for (const state of ['recording', 'transcribing', 'writing', 'waiting']) {
    const { home, folder } = await setup({ state });
    const fake = recorder();
    const result = await trashCall({ home, id: ID, core: null, ...fake });
    assert.deepEqual(result, { trashed: false, refused: true, reason: TRASH_REFUSED[state] }, state);
    assert.deepEqual(fake.order, [], `${state}: no confirm, no refile, no trash`);
    assert.ok(await stat(folder), `${state}: the folder is still there`);
  }
});

test('a done call: his yes, then off its workspace (No workspace, moves set aside), then the folder to the Trash', async () => {
  const { home, folder } = await setup();
  const fake = recorder();
  const result = await trashCall({ home, id: ID, core: null, workstreams: [{ name: 'Acme Bank' }], ...fake });
  assert.deepEqual(fake.order, [['confirm', 'Coffee chat with Sam'], ['refile', ID, null], ['trash', folder]]);
  assert.deepEqual(result, { trashed: true, title: 'Coffee chat with Sam', from: 'Acme Bank', setAside: 1 });
});

test('Cancel in the confirm changes nothing; an empty call may go; a bad id never reaches the Trash', async () => {
  const { home } = await setup();
  const fake = recorder();
  fake.confirm = async () => false;
  assert.deepEqual(await trashCall({ home, id: ID, core: null, ...fake }), { trashed: false, cancelled: true });
  assert.deepEqual(fake.order, []);
  const empty = await setup({ state: 'empty' });
  const again = recorder();
  assert.equal((await trashCall({ home: empty.home, id: ID, core: null, ...again })).trashed, true);
  await assert.rejects(trashCall({ home, id: '../..', core: null, ...recorder() }), /Invalid call/);
  await assert.rejects(trashCall({ home, id: '2026-01-01-0000-gone', core: null, ...recorder() }), /not on this Mac/);
});

test('the real refile runs before the Trash: the call is in No workspace when its folder goes', async () => {
  const { home, folder } = await setup();
  const { storeCore } = await import('./helpers/fake-core.js');
  let seen = null;
  const result = await trashCall({ home, id: ID, core: storeCore({ brief: 'stub' }), workstreams: [{ name: 'Acme Bank' }], confirm: async () => true,
    trash: async (path) => { seen = JSON.parse(await readFile(join(path, 'event.json'), 'utf8')); } });
  assert.equal(result.trashed, true);
  assert.equal(seen.filed.none, true);
  assert.equal(seen.filed.workstream, null);
  assert.ok(await stat(folder), 'the recorder trash moved nothing; the real one is shell.trashItem');
});

test('the delete module never removes a file itself', async () => {
  const source = await readFile(new URL('../src/hikyaku/call-trash.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bunlink\b|\brmSync\b|\brm\(|\brmdir\b|from 'node:fs|fetch\(|https?:/);
  const main = await readFile(new URL('../desktop/main-ipc-menu.js', import.meta.url), 'utf8');
  assert.match(main, /shell\.trashItem\(/);
});
