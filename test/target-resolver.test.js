import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTarget } from '../src/commands/target-resolver.js';

test('finds folders by human name and ranks an exact match first', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-discovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'AI Terminal Tool'));
  await writeFile(join(root, 'AI Terminal Notes.txt'), 'notes');
  const results = await resolveTarget({ target: 'AI Terminal Tool', roots: [root] });
  assert.equal(results[0].path, join(root, 'AI Terminal Tool'));
  assert.equal(results[0].score, 100);
});

test('ignores stale known projects', async () => {
  const results = await resolveTarget({ target: 'Missing', projects: [{ name: 'Missing', directoryPath: '/definitely/not/here' }], roots: [] });
  assert.deepEqual(results, []);
});

// A search folder named outright is that folder (Amritha, bdc7fc3, brought back 2026-10-12).
test('a search folder named outright resolves to the folder itself', async () => {
  const base = await mkdtemp(join(tmpdir(), 'loggie-root-'));
  const root = join(base, 'Projects');
  await mkdir(join(root, 'inside'), { recursive: true });
  try {
    const found = await resolveTarget({ target: 'projects', roots: [root] });
    assert.equal(found[0].path, root);
    assert.equal(found[0].source, 'search-root');
  } finally { await rm(base, { recursive: true, force: true }); }
});
