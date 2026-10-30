import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MAIN_FILES } from './helpers/main-files.js';

// The cloud app once failed to start on a named import its module did not export (2026-10-08: testCloudKey from
// cloud-key.js). No other test loads the main process, so every named import from src/ is checked here, in desktop/main.js
// and every module split out of it (debt-cleanup 6.6).
test('every named import the main process takes from src/ exists in that module', async () => {
  const missing = [];
  let found = 0;
  for (const file of MAIN_FILES) {
    const main = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const imports = [...main.matchAll(/^import\s*\{([^}]+)\}\s*from\s*'(\.\.\/src\/[^']+)';/gm)];
    found += imports.length;
    for (const [, names, path] of imports) {
      const module = await import(new URL(path, new URL(`../${file}`, import.meta.url)));
      for (const name of names.split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!(name in module)) missing.push(`${name} from ${path} (${file})`);
      }
    }
  }
  assert.ok(found > 10, 'the main process imports were found');
  assert.deepEqual(missing, []);
});
