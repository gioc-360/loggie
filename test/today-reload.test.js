// Today redraws on every shared change, never only after Workspaces' Refresh (Gio, 2026-10-23: "I have to refresh
// Workspaces for the Today tab to update"; Codex review, 2026-10-23). Today draws the cards and a separate list of picks,
// so each change signal must reload both, and main must send a signal for every change made off Today.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { todayItems } from '../desktop/renderer/today-model.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
// The text of one function or handler, from its opening line to the next line that starts at the same indent with "}".
function body(code, start) {
  const at = code.indexOf(start);
  assert.ok(at >= 0, `found ${start}`);
  const indent = code.slice(code.lastIndexOf('\n', at) + 1, at).match(/^\s*/)[0];
  const end = code.indexOf(`\n${indent}}`, at);
  return code.slice(at, end < 0 ? undefined : end);
}

test('finding 1: every background refresh tells the panel, even one that only added questions', async () => {
  const code = await read('desktop/main-background.js');
  assert.match(body(code, 'export function refreshOnce('), /sayChanged\(/, 'refreshOnce sends the change signal when its run ends');
  const sender = body(await read('desktop/main-catch-up.js'), 'export function sayChanged(');
  assert.match(sender, /'hikyaku:moved', \{ taskId: null, phase: 'refreshed'/);
});

test('finding 2: Done, Drop, Undo and a new date from any page send one change signal', async () => {
  const code = await read('desktop/main-ipc-moves.js');
  for (const channel of ['hikyaku:move-mark', 'hikyaku:move-date', 'hikyaku:unretire']) {
    assert.match(body(code, `handleSecure('${channel}'`), /sayChanged\(\)/, `${channel} sends the change signal`);
  }
});

test('finding 3: a call filed ok reloads Today, and filing that made moves ranks soon', async () => {
  const panel = await read('desktop/renderer/panel.js');
  const entry = body(panel, 'window.loggie.hikyaku.onEntry((event) => {');
  assert.match(entry, /event\?\.type === 'step\.finished' && event\.data\?\.step === 'file' && event\.data\.ok\) reloadShared\(\)/);
  const helpers = await read('desktop/main-helpers.js');
  assert.match(body(helpers, 'export function filedMoves('), /created\?\.length[\s\S]*rankSoon\(\)/);
  for (const [file, count] of [['desktop/main-helpers.js', 2], ['desktop/main-ipc-meetings.js', 1]]) {
    const code = await read(file);
    assert.equal([...code.matchAll(/const file(NotesOnly)? = async \(folder\) => \{ const filed = await fileCall\([^\n]*filedMoves\(filed\)/g)].length, count, `${file} ranks after a filing`);
  }
  const refile = body(await read('desktop/main-ipc-meetings.js'), "handleSecure('hikyaku:file-call'");
  assert.match(refile, /filedMoves\(result\)/);
  assert.match(refile, /sayChanged\(\)/);
});

test('finding 4: one debounced reload awaits the cards and the picks, and every shared signal calls it', async () => {
  const panel = await read('desktop/renderer/panel.js');
  const reload = body(panel, 'async function reloadNow(');
  assert.match(reload, /await loadWorkstreams\(\);\s*await drawFirstToday\(\);/);
  assert.match(body(panel, 'function reloadShared('), /setTimeout\(/, 'a burst of signals causes one reload');
  assert.match(panel, /createWorkspacesView\(\{[\s\S]*?onChanged: \(\) => reloadShared\(\),/, 'Workspaces onChanged');
  const moved = body(panel, 'window.loggie.hikyaku.onMoved?.((outcome) => {');
  assert.match(moved, /outcome\?\.phase === 'refreshed'\) \{ reloadShared\(\); return; \}/, 'the refreshed signal');
  assert.match(moved, /if \(outcome\.done\) reloadShared\(\);/, 'discovery completion');
  assert.match(panel, /window\.loggie\.core\.onEvents\(\(\) => reloadShared\(\)\);/);
  assert.match(panel, /window\.loggie\.hikyaku\.onRanked\(\(\) => reloadShared\(\)\);/);
});

test('finding 4: a saved pick whose move was marked done or dropped leaves Today before the picks reload', () => {
  const cards = [{ name: 'Bank Offer', moves: [{ id: 'task_b', title: 'Send the form' }], active: [], retired: [{ id: 'task_a', title: 'Ask the recruiter', why: 'done' }] }];
  const picks = [{ taskId: 'task_a', name: 'Bank Offer', move: 'Ask the recruiter' }, { taskId: 'task_b', name: 'Bank Offer', move: 'Send the form' }, { taskId: 'task_new', name: 'Bank Offer', move: 'Ask about the start date' }];
  const { entries } = todayItems({ picks, source: 'ai', cards });
  // task_new is a pick with no move on the card yet (first-run-polish B3.1): it stays, with Draft it.
  assert.deepEqual(entries.map((entry) => entry.pick.taskId), ['task_b', 'task_new']);
});

test('finding 6: ranking passes a declared address to a new call-derived owed move', async () => {
  const rank = body(await read('desktop/main-catch-up.js'), 'export async function rankAll(');
  assert.doesNotMatch(rank, /createOwedTask\(\{[^}]*\bownAddress \}/, 'no shorthand for the undeclared ownAddress');
  assert.match(rank, /createOwedTask\(\{[^}]*ownAddress: ownAddressList\[0\] \|\| ''/);
});
