// The screen says workspace (debt-cleanup 6.5): no string literal a page draws or main throws says workstream. File
// names, channels and event names keep the code's word (D1); KEEP holds main's three log words, which no page shows.
// Main is every MAIN_FILES entry since the split (debt-cleanup 6.6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { MAIN_FILES } from './helpers/main-files.js';

const LIT = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const WORD = /(^|[^\w.:\-/<])[Ww]orkstreams?(?=[\s,.!?;:)”…]|$)/;
const NAMES = /workstreams?\.json|workstream\.(?:started|filed|offer)|hikyaku:[a-z-]+/g;
const KEEP = new Set(["'needs a yes to use the cloud AI for this workstream'", "'mail outside your workstreams'", "'your workstreams to put them in order'"]);

test('no page or main message says workstream', async () => {
  const pages = (await readdir(new URL('../desktop/renderer/', import.meta.url))).filter((f) => f.endsWith('.js')).map((f) => `desktop/renderer/${f}`);
  const found = [];
  const kept = new Set();
  for (const file of [...pages, ...MAIN_FILES, 'desktop/ipc-validation.js']) {
    const lines = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const literal of line.match(LIT) || []) {
        if (KEEP.has(literal)) { kept.add(literal); continue; }
        const words = literal.slice(1, -1).replace(/\$\{[^}]*\}/g, ' ').replace(NAMES, ' ');
        if (WORD.test(words)) found.push(`${file}:${i + 1} ${literal}`);
      }
    });
  }
  assert.deepEqual(found, []);
  assert.equal(kept.size, KEEP.size, 'the scan read main: its three log words are there');
});
