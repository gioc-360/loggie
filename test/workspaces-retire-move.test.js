// Retire with "Move them to…" (cleanup audit bugs 2 and 4): the moves land in the target's one folder, and a date the
// user set on a move goes with it. Made-up workspaces only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { moveOpenMoves } from '../src/hikyaku/retire.js';
import { storeCore } from './helpers/fake-core.js';

const fakeCore = () => ({ ...storeCore({ projectId: (n) => `p${n}`, taskId: (n) => `t${n + 9}`, status: null }), getLatestBrief: async () => null });

test('moved moves keep the date the user set and land in the folder util.slug names', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-move-'));
  await writeFile(join(home, 'due-dates.json'), JSON.stringify({ t1: '2026-11-02' }));
  const core = fakeCore();
  const moves = [{ id: 't1', title: 'Send the deck', priority: 3, dueAt: '2026-10-28' }, { id: 't2', title: 'Book the room', dueAt: null }];
  await moveOpenMoves({ core, home, from: 'Old Club', to: 'FA_OS build', moves });
  assert.equal(core.projects[0].directoryPath, join(home, 'work', 'fa-os-build'));
  const [deck, room] = core.tasks;
  assert.equal(deck.dueAt, '2026-11-02', 'the date the user set, not the catch-up date');
  assert.equal(room.dueAt, undefined);
  const dates = JSON.parse(await readFile(join(home, 'due-dates.json'), 'utf8'));
  assert.equal(dates[deck.id], '2026-11-02', 'the card of the copy shows the same date');
  const retired = JSON.parse(await readFile(join(home, 'retired.json'), 'utf8'));
  assert.deepEqual(Object.keys(retired).sort(), ['t1', 't2']);
});
