// The Today round's wiring (docs/prototype-port/spec-b.md): a press reaches the app only if three files agree, the view's
// api wrapper in panel.js, the preload method and main.js's handler. 2026-10-17: runway.js called openDraft,
// renameWorkstream and dismissWorkstream, panel.js never passed them, and the preview's own bridge hid it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertWired } from './helpers/main-files.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every api method workspaces.js calls has a wrapper in panel.js\'s drawWorkspaces', async () => {
  const view = await read('desktop/renderer/workspaces.js');
  const panel = await read('desktop/renderer/panel.js');
  const block = panel.slice(panel.indexOf('createWorkspacesView({'), panel.indexOf('onChanged:', panel.indexOf('createWorkspacesView({')));
  const names = [...new Set([...view.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]))].sort();
  assert.ok(names.includes('renameWorkstream') && names.includes('uiAct'), 'the scan finds api.uiAct?.( too');
  for (const name of names) assert.match(block, new RegExp(`\\b${name}: async`), `drawWorkspaces passes ${name}`);
});

test('Today\'s calls are wired end to end: preload method, main handler', async () => {
  await assertWired([['hikyaku:do-it', 'doIt'], ['hikyaku:reply-to', 'replyTo'], ['hikyaku:move-mark', 'markMove'], ['hikyaku:move-date', 'moveDate'], ['hikyaku:not-this', 'notThis'],
    ['hikyaku:open-draft', 'openDraft'], ['hikyaku:answer', 'answer'], ['hikyaku:draft-all', 'draftAll'], ['hikyaku:open-replies', 'openReplies'],
    ['hikyaku:first-today', 'firstToday'], ['hikyaku:rename-workstream', 'renameWorkstream'], ['hikyaku:dismiss-workstream', 'dismissWorkstream']], { panel: false });
});

test('every api method today.js calls has a wrapper in panel.js\'s Today view', async () => {
  const today = await read('desktop/renderer/today.js');
  const panel = await read('desktop/renderer/panel.js');
  const block = panel.slice(panel.indexOf('createTodayView({'), panel.indexOf('outcomes:', panel.indexOf('createTodayView({')));
  const names = [...new Set([...today.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]))];
  assert.deepEqual(names.sort(), ['doIt', 'markMove', 'moveDate', 'notThis', 'openDraft', 'uiAct']);
  for (const name of names) assert.match(block, new RegExp(`\\b${name}: async`), `the Today view gets ${name}`);
});

// loggie-reply-yes: a Reply on a To do move runs through the one shared reply row (reply-row.js) on both tabs, so the
// yes is asked on the row and never in the ask box.
test('the reply row is wired end to end: panel.js wrappers, preload methods, main handlers, both views', async () => {
  const row = await read('desktop/renderer/reply-row.js');
  const panel = await read('desktop/renderer/panel.js');
  const block = panel.slice(panel.indexOf('createReplies({'), panel.indexOf('onChange:', panel.indexOf('createReplies({')));
  const names = [...new Set([...row.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(names, ['replyAgain', 'replyFill', 'replyTo', 'replyYes', 'setReplyYes']);
  for (const name of names) assert.match(block, new RegExp(`\\b${name}: async`), `createReplies gets ${name}`);
  await assertWired([['hikyaku:reply-to', 'replyTo'], ['hikyaku:reply-yes', 'replyYes'], ['hikyaku:reply-yes-set', 'setReplyYes'], ['hikyaku:reply-fill', 'replyFill'], ['hikyaku:reply-again', 'replyAgain']], { panel: false });
  assert.match(panel, /createTodayView\(\{[\s\S]*?\breplies,/, 'Today gets the shared replies');
  assert.match(panel, /createWorkspacesView\(\{[\s\S]*?\breplies,/, 'Workspaces gets the shared replies');
  for (const file of ['desktop/renderer/today.js', 'desktop/renderer/workspaces.js']) assert.doesNotMatch(await read(file), /api\.replyTo/, `${file} replies only through reply-row.js`);
});

test('the page: Today and Workspaces tabs, the runway on Workspaces, the new styles last, no HTML strings', async () => {
  const html = await read('desktop/renderer/panel.html');
  for (const part of ['data-page="today"', 'data-view="today"', 'data-view="workspaces"']) assert.ok(html.includes(part), part);
  assert.ok(!html.includes('data-page="tasks"'));
  assert.ok(html.indexOf('id="workstreamSection"') > html.indexOf('data-page="workspaces"'));
  const sheets = [...html.matchAll(/href="([\w-]+\.css)"/g)].map((match) => match[1]);
  assert.deepEqual(sheets.slice(-3), ['tokens.css', 'today.css', 'setup.css']);
  for (const file of ['desktop/renderer/today.js', 'desktop/renderer/move-view.js']) {
    const code = await read(file);
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|style="/, file);
  }
});
