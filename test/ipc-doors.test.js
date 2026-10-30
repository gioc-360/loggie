// Every door has one handler, every handler a door, and every door a page that opens it (debt-cleanup 6.2): a door
// nothing opens is code nobody can reach. Main is every MAIN_FILES entry since the split (6.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { mainText } from './helpers/main-files.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
// No gmail namespace since the Gmail sign-in left (2026-10-28).
const NAMESPACES = new Set(['permissions', 'folders', 'voice', 'ask', 'command', 'core', 'hikyaku']);

test('preload and main name the same channels, once each', async () => {
  const preload = await read('desktop/preload.cjs');
  const main = await mainText();
  const doors = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1]).sort();
  const handlers = [...main.matchAll(/(?:handleSecure|handleTrusted|ipcMain\.(?:handle|on))\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.equal(new Set(doors).size, doors.length);
  assert.deepEqual(handlers, doors);
});

test('every preload name is used by a page outside preview/', async () => {
  const names = [...(await read('desktop/preload.cjs')).matchAll(/^\s+(\w+): /gm)].map((m) => m[1]).filter((n) => !NAMESPACES.has(n));
  const files = (await readdir(new URL('../desktop/renderer/', import.meta.url))).filter((f) => /\.(js|html)$/.test(f));
  const pages = (await Promise.all(files.map((f) => read(`desktop/renderer/${f}`)))).join('\n');
  assert.deepEqual(names.filter((n) => !new RegExp(`[.'"]${n}\\b`).test(pages)), []);
});
