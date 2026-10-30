// The main process since the split (debt-cleanup 6.6): desktop/main.js and every desktop/main-*.js beside it. Read off
// the folder, not pasted, so a new main module joins every scan the day it lands instead of hiding from them.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const DESKTOP = new URL('../../desktop/', import.meta.url);
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

export const MAIN_FILES = ['desktop/main.js', ...readdirSync(DESKTOP).filter((name) => /^main-.+\.js$/.test(name)).sort().map((name) => `desktop/${name}`)];

// Every main module's text, joined in MAIN_FILES order.
export const mainText = async () => (await Promise.all(MAIN_FILES.map(read))).join('\n');

// One handleSecure block of the joined text: from its name to the next handleSecure.
export const handlerIn = (main, name) => { const at = main.indexOf(`handleSecure('${name}'`); assert.ok(at > 0, name); return main.slice(at, main.indexOf('\n  handleSecure(', at + 1)); };

// Each [channel, method] is wired end to end: a handleSecure in main, a preload method that invokes it and, unless
// panel is false, a panel.js wrapper. A missing hop is a dead button the click check, on its stand-in bridge, cannot see.
export async function assertWired(channels, { panel = true } = {}) {
  const [main, preload, page] = await Promise.all([mainText(), read('desktop/preload.cjs'), panel && read('desktop/renderer/panel.js')]);
  for (const [channel, method] of channels) {
    assert.ok(main.includes(`handleSecure('${channel}'`), `${channel} handler in main.js`);
    assert.match(preload, new RegExp(`\\b${method}: \\([^)]*\\) => ipcRenderer\\.invoke\\('${channel}'`), `${method} in preload.cjs`);
    if (panel) assert.match(page, new RegExp(`\\b${method}: async \\([^)]*\\) => unwrap\\(await hikyaku\\(\\)\\.${method}\\(`), `${method} wrapper in panel.js`);
  }
}
