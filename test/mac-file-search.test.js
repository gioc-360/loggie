import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchMacFiles } from '../src/commands/mac-file-search.js';
const noIndex = async () => ({ stdout: '' });

test('automatically scans arbitrary, hidden and mounted roots, including symlinks without looping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-wide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), drive = join(root, 'Volumes', 'Team');
  for (const folder of [join(home, 'marketing'), join(home, '.archive'), join(drive, 'reports')]) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'CLV.xlsx'), '');
    await writeFile(join(folder, 'CLV.pdf'), '');
  }
  await symlink(home, join(home, 'loop'));
  const result = await searchMacFiles({ target: 'CLV', extensions: ['.xlsx'], home, roots: [home, join(root, 'Volumes')], execImpl: noIndex });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.limited, false);
  assert.ok(result.candidates.some(c => c.path.includes('/Team/reports/')));
});

test('Spotlight paths are access-checked and permission denial does not stop other matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const good = join(root, 'CLV.xlsx'), denied = join(root, 'private-CLV.xlsx');
  await writeFile(good, ''); await writeFile(denied, '');
  const actual = await import('node:fs/promises');
  let invocation;
  const result = await searchMacFiles({ target: 'CLV', roots: [], execImpl: async (...args) => { invocation = args; return { stdout: `${good}\0${denied}\0` }; },
    fs: { ...actual, access: async path => { if (path === denied) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return actual.access(path); } } });
  assert.equal(invocation[0], '/usr/bin/mdfind');
  assert.deepEqual(result.candidates.map(c => c.path), [good]);
  assert.deepEqual(result.blocked, [denied]);
});

test('unavailable index falls back to traversal and deadline is reported as partial', async () => {
  let time = 0;
  const result = await searchMacFiles({ target: 'CLV', roots: ['/fake'], timeoutMs: 1, now: () => time++, execImpl: async () => { throw new Error('index offline'); } });
  assert.equal(result.indexUnavailable, true);
  assert.equal(result.limited, true);
});

test('descriptive searches offer partial word matches only when no full filename matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-related-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const partial = join(root, 'tesla.xlsx'), full = join(root, 'tesla scoring.xlsx');
  await writeFile(partial, '');
  const options = { target: 'tesla scoring', extensions: ['.xlsx'], roots: [root], execImpl: noIndex };
  const fallback = await searchMacFiles(options);
  assert.equal(fallback.related, true);
  assert.deepEqual(fallback.candidates.map(c => c.name), ['tesla.xlsx']);
  await writeFile(full, '');
  const exact = await searchMacFiles(options);
  assert.equal(exact.related, false);
  assert.deepEqual(exact.candidates.map(c => c.name), ['tesla scoring.xlsx']);
});
