// A start switch is on only when set to 1 (cleanup audit bug 6: HIKYAKU_REFRESH_ON_START=0 turned the refresh on).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('every on/off start switch in main.js is on only at 1', async () => {
  const source = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8');
  const bare = [...source.matchAll(/if \(process\.env\.(HIKYAKU_REFRESH_ON_START|HIKYAKU_RUN_ON_START|LOGGIE_OPEN_WORKSPACE|LOGGIE_DESKTOP_SMOKE_TEST)\)/g)].map((match) => match[1]);
  assert.deepEqual(bare, []);
  assert.match(source, /process\.env\.HIKYAKU_REFRESH_ON_START === '1'/);
});
