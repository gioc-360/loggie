// A helper's Swift source path is a real file path, so a checkout under a folder with a space still builds it
// (cleanup audit bug 16: new URL(...).pathname kept "%20").
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

test('no module builds a file path from a URL pathname', async () => {
  const dir = new URL('../src/hikyaku/', import.meta.url);
  const bad = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.js'))) {
    if (/new URL\([^)]*import\.meta\.url\)\.pathname/.test(await readFile(new URL(name, dir), 'utf8'))) bad.push(name);
  }
  assert.deepEqual(bad, []);
});
