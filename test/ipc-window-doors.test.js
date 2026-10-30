// Every door into the main process checks the window that knocked, the window doors too (cleanup audit bug 20).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('no main-process module registers a bare ipcMain.handle outside main-state.js', async () => {
  const dir = new URL('../desktop/', import.meta.url);
  const bare = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.js') && file !== 'main-state.js')) {
    for (const match of (await readFile(new URL(name, dir), 'utf8')).matchAll(/ipcMain\.handle\('([^']+)'/g)) bare.push(`${name}: ${match[1]}`);
  }
  assert.deepEqual(bare, []);
});
