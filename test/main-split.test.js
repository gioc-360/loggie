// desktop/main.js is an entry over eleven sibling modules (debt-cleanup 6.6): every one exists and parses, and the
// entry stays small.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MAIN_FILES } from './helpers/main-files.js';


test('every main module exists and passes node --check, and desktop/main.js is under 400 lines', async () => {
  for (const f of MAIN_FILES) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../${f}`, import.meta.url))]);
  const lines = (await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')).split('\n').length;
  assert.ok(lines < 400, `desktop/main.js is ${lines} lines`);
});
