import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NO_WORKSPACE, refileCall } from '../src/hikyaku/refile.js';
import { readRetired } from '../src/hikyaku/retire.js';
import { validateFileCall } from '../desktop/ipc-validation.js';
import { storeCore } from './helpers/fake-core.js';

const ID = '2026-10-05-1400-coffee-chat-with-sam';
const WORKSTREAMS = [{ name: 'Acme Bank' }, { name: 'Hotel Hackathon' }];

const fakeCore = () => storeCore({ brief: 'stub' });

async function setup({ workstream = 'Acme Bank', notes = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-refile-'));
  const folder = join(home, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam', start: '2026-10-05T18:00:00Z', me: 'Lena', with: 'Sam', workstream }));
  if (notes) {
    await writeFile(join(folder, 'notes.md'), '# Coffee chat with Sam\n\n## About\n- Sam runs analytics\n');
    await writeFile(join(folder, 'checks.json'), JSON.stringify([{ next_step: 'send Sam the deck', owner: 'Lena', quote: 'send the deck', not_sure: [] }]));
  }
  return { home, folder, core: fakeCore() };
}

test('moving a filed call retires its moves on the old card as moved, files them on the new one, and relabels the call', async () => {
  const { home, folder, core } = await setup();
  const { fileCall } = await import('../src/hikyaku/calls.js');
  await fileCall({ folder, core, workRoot: join(home, 'work'), workstreams: WORKSTREAMS });
  assert.equal(core.tasks.length, 1);
  const dry = await refileCall({ home, core, id: ID, workstream: 'Hotel Hackathon', workstreams: WORKSTREAMS, dryRun: true });
  assert.deepEqual([dry.from, dry.to, dry.retire.length, dry.files], ['Acme Bank', 'Hotel Hackathon', 1, true]);
  assert.equal(core.tasks.length, 1, 'a dry run changes nothing');
  const out = await refileCall({ home, core, id: ID, workstream: 'hotel hackathon', workstreams: WORKSTREAMS, now: new Date('2026-10-12T01:00:00Z') });
  assert.deepEqual([out.from, out.to, out.retired, out.created], ['Acme Bank', 'Hotel Hackathon', ['task_1'], ['task_2']]);
  const retired = await readRetired(home);
  assert.deepEqual([retired.task_1.why, retired.task_1.proof, retired.task_1.workstream], ['moved', 'Hotel Hackathon', 'Acme Bank']);
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  assert.equal(event.filed.workstream, 'Hotel Hackathon');
  assert.equal(event.relabeled, true);
  assert.ok((await readdir(folder)).some((name) => name.startsWith('event.json.before-refile-')));
  assert.equal(core.tasks[1].projectId, core.projects.find((p) => p.name === 'Hotel Hackathon').id);
  // the same pick again changes nothing; moving back files it again on the first card
  assert.equal((await refileCall({ home, core, id: ID, workstream: 'Hotel Hackathon', workstreams: WORKSTREAMS })).unchanged, true);
  const back = await refileCall({ home, core, id: ID, workstream: 'Acme Bank', workstreams: WORKSTREAMS });
  assert.deepEqual([back.retired, back.created.length], [['task_2'], 1]);
});

test('an unplaced call with no notes yet only gets its workstream; an unknown name is refused', async () => {
  const { home, folder, core } = await setup({ workstream: 'none', notes: false });
  const out = await refileCall({ home, core, id: ID, workstream: 'Acme Bank', workstreams: WORKSTREAMS });
  assert.deepEqual([out.from, out.to, out.retired, out.created], [null, 'Acme Bank', [], []]);
  assert.equal(JSON.parse(await readFile(join(folder, 'event.json'), 'utf8')).filed.workstream, 'Acme Bank');
  await assert.rejects(refileCall({ home, core, id: ID, workstream: 'Nope', workstreams: WORKSTREAMS }), /No workspace named/);
  await assert.rejects(refileCall({ home, core, id: '../x', workstream: 'Acme Bank', workstreams: WORKSTREAMS }), /Invalid call/);
  assert.throws(() => validateFileCall(ID, ''), /Pick one/);
  assert.deepEqual(validateFileCall(ID, ' Acme Bank '), { id: ID, workstream: 'Acme Bank' });
});

test('"No workspace" takes a call off a wrong card, keeps it out on purpose, and a pick puts it back', async () => {
  // Gio, 2026-10-26: "a way to un pick wrong workstreams if its a one time recording thing... or a wrong workstream".
  const { home, folder, core } = await setup();
  const { fileCall } = await import('../src/hikyaku/calls.js');
  const { listCalls } = await import('../src/hikyaku/call-list.js');
  const log = await fileCall({ folder, core, workRoot: join(home, 'work'), workstreams: WORKSTREAMS });
  assert.deepEqual(validateFileCall(ID, null), { id: ID, workstream: null });
  const out = await refileCall({ home, core, id: ID, workstream: null, workstreams: WORKSTREAMS, now: new Date('2026-10-26T20:00:00Z') });
  assert.deepEqual([out.from, out.to, out.none, out.retired, out.created], ['Acme Bank', null, true, ['task_1'], []]);
  const retired = await readRetired(home);
  assert.deepEqual([retired.task_1.why, retired.task_1.proof], ['moved', NO_WORKSPACE], 'its move is set aside, with Undo on the card');
  await assert.rejects(readFile(log.notesFile, 'utf8'), 'the notes copy leaves the old card');
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  assert.deepEqual([event.workstream, event.filed.workstream, event.filed.none, event.relabeled], ['none', null, true, true]);
  const row = (await listCalls({ home })).find((call) => call.id === ID);
  assert.deepEqual([row.workstream, row.noWorkspace, row.guess], [null, true, null], 'not to file, and no guess');
  assert.equal((await refileCall({ home, core, id: ID, workstream: null, workstreams: WORKSTREAMS })).unchanged, true, 'already in none');
  const back = await refileCall({ home, core, id: ID, workstream: 'Hotel Hackathon', workstreams: WORKSTREAMS });
  assert.deepEqual([back.from, back.to, back.created.length], [null, 'Hotel Hackathon', 1]);
  const after = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  assert.deepEqual([after.filed.workstream, after.filed.none], ['Hotel Hackathon', undefined], 'a pick ends "No workspace"');
});

test('a one-time recording that was never filed goes to "No workspace" with nothing to retire', async () => {
  const { home, folder, core } = await setup({ workstream: 'none', notes: false });
  const out = await refileCall({ home, core, id: ID, workstream: null, workstreams: WORKSTREAMS });
  assert.deepEqual([out.from, out.none, out.retired], [null, true, []]);
  assert.equal(JSON.parse(await readFile(join(folder, 'event.json'), 'utf8')).filed.none, true);
});
