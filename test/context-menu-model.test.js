// What each right-click menu holds (loggie right-click, 2026-10-28; desktop/renderer/context-menu-model.js), and the
// static rule that keeps it honest: every item runs a function a visible control also runs (0 menu-only actions).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CALL_BUSY, MAX_NAMES, MENU_ITEMS, menuFor } from '../desktop/renderer/context-menu-model.js';

const GUESSED = { id: 'c1', title: 'Coffee chat with Yuki', state: 'done', workstream: null, guess: 'Hotel Hackathon', evidence: 'said “hackathon” 4 times' };
const NAMES = ['Hotel Hackathon', 'Bank Offer', 'Pharma Case'];
const ids = (items) => items.map((item) => item.id);

test('a recording\'s menu: what Loggie knows first, then Add to workspace, Share, Open, Copy, Rename, Delete', () => {
  const items = menuFor('recording', { call: GUESSED, names: NAMES });
  assert.deepEqual(ids(items), ['guess', 'file', 'share', 'open', 'copy', 'rename', 'trash']);
  assert.deepEqual(items[0], { id: 'guess', enabled: true, value: 'Hotel Hackathon', line: 'said “hackathon” 4 times' });
  assert.deepEqual(items[1].submenu, [{ value: 'Hotel Hackathon', on: false, guess: true }, { value: 'Bank Offer', on: false }, { value: 'Pharma Case', on: false }, { value: null, on: false }]);
  assert.ok(items.slice(1).every((item) => item.enabled), 'a done call can do everything');
});

test('the first line says where it is when there is no guess to press', () => {
  const filed = menuFor('recording', { call: { ...GUESSED, workstream: 'Bank Offer', guess: null }, names: ['Bank Offer', 'Pharma Case'] });
  assert.deepEqual(filed[0], { id: 'guess', enabled: false, value: 'Bank Offer', on: true });
  assert.deepEqual(filed[1].submenu, [{ value: 'Bank Offer', on: true }, { value: 'Pharma Case', on: false }, { value: null, on: false }]);
  const nows = menuFor('recording', { call: { ...GUESSED, guess: null, noWorkspace: true }, names: NAMES });
  assert.deepEqual([nows[0], nows[1].submenu.at(-1)], [{ id: 'guess', enabled: false, value: null, on: true }, { value: null, on: true }]);
  // A guess nothing backs is no guess (the chip's rule, call-list.js evidenceFor).
  const bare = menuFor('recording', { call: { ...GUESSED, evidence: '' }, names: NAMES });
  assert.deepEqual(bare[0], { id: 'guess', enabled: false, value: null, on: false });
  assert.equal(bare[1].submenu[0].guess, undefined);
});

test('Add to workspace never offers a new workspace and holds at most 40 names, No workspace last', () => {
  const many = Array.from({ length: 50 }, (_, i) => `Workspace ${i + 1}`);
  const { submenu } = menuFor('recording', { call: GUESSED, names: ['new', ...many] })[1];
  assert.equal(submenu.filter((entry) => entry.value !== null).length, MAX_NAMES);
  assert.equal(submenu.at(-1).value, null);
  assert.ok(!submenu.some((entry) => /new workspace/i.test(String(entry.value))));
});

test('Delete waits while anything still owns the call, and says why', () => {
  for (const [state, reason] of Object.entries(CALL_BUSY)) {
    const trash = menuFor('recording', { call: { ...GUESSED, state }, names: NAMES }).at(-1);
    assert.deepEqual(trash, { id: 'trash', enabled: false, line: `not now: ${reason}` }, state);
  }
  assert.deepEqual(Object.keys(CALL_BUSY), ['recording', 'transcribing', 'writing', 'waiting']);
  for (const state of ['done', 'empty', 'failed']) assert.deepEqual(menuFor('recording', { call: { ...GUESSED, state }, names: NAMES }).at(-1), { id: 'trash', enabled: true }, state);
  const live = menuFor('recording', { call: { ...GUESSED, state: 'recording' }, names: NAMES });
  assert.deepEqual(live.filter((item) => !item.enabled).map((item) => item.id), ['guess', 'file', 'share', 'copy', 'trash']);
});

test('a text field or selected text gets the Mac\'s Cut, Copy, Paste and Select All, as it can', () => {
  assert.deepEqual(menuFor('text', { editable: true, selected: true }), [{ id: 'cut', enabled: true }, { id: 'copy', enabled: true }, { id: 'paste', enabled: true }, { id: 'selectAll', enabled: true }]);
  assert.deepEqual(menuFor('text', { editable: true, selected: false }).map((item) => item.enabled), [false, false, true, true]);
  assert.deepEqual(menuFor('text', { editable: false, selected: true }).map((item) => item.enabled), [false, true, false, true]);
});

const CARD = { name: 'Hotel Hackathon', goal: 'Win or place', unread: 3, asOf: '2026-10-26T12:00:00Z', priority: { rank: 2, stake: 'normal' } };
test('a workspace row\'s menu: Catch up now with what is new first, then Open, the stakes, Park, Edit name, Retire', () => {
  const items = menuFor('workspace', { card: CARD, fresh: '3 new since Oct 26' });
  assert.deepEqual(ids(items), ['catch-up', 'open', 'more', 'less', 'park', 'rename', 'retire']);
  assert.deepEqual(items[0], { id: 'catch-up', enabled: true, line: '3 new since Oct 26' });
  assert.ok(items.every((item) => item.enabled));
  assert.deepEqual(items.slice(2, 5).map((item) => item.on), [false, false, false]);
  const marked = menuFor('workspace', { card: { ...CARD, stake: 'more', priority: { parked: true, parkedUntil: '2026-11-02' } }, fresh: 'Up to date' });
  assert.deepEqual(marked.slice(2, 5).map((item) => item.on), [true, false, true]);
});

test('what a workspace cannot do is greyed with why: a quiet one is read with the rest, the Inbox is not his to rename', () => {
  const quiet = menuFor('workspace', { card: { ...CARD, quiet: true }, fresh: 'Just keep me posted' })[0];
  assert.deepEqual(quiet, { id: 'catch-up', enabled: false, line: 'Just keep me posted: read with the rest' });
  const inbox = menuFor('workspace', { card: { name: 'Inbox', inbox: true }, fresh: '' });
  assert.deepEqual(inbox.filter((item) => !item.enabled).map((item) => [item.id, item.line]), [['rename', 'not one of your workspaces'], ['retire', 'not one of your workspaces']]);
  const found = menuFor('workspace', { card: { ...CARD, newFound: true }, fresh: '' });
  assert.deepEqual(found.find((item) => item.id === 'retire'), { id: 'retire', enabled: false, line: 'Keep or Dismiss it on its page first' });
});

const MOVE = { id: 'task_c', title: 'Email Lucky Star: ask about the bar tab', kind: 'email', app: 'outlook', to: 'Sam', call: null };
test('a move\'s menu: Draft it with Loggie and where it lands first, then Done, New date, Drop it, its call', () => {
  const items = menuFor('move', { move: MOVE, toSend: true, appName: 'Outlook' });
  assert.deepEqual(ids(items), ['draft', 'done', 'date', 'drop', 'call']);
  assert.deepEqual(items[0], { id: 'draft', enabled: true, line: 'in Outlook, to Sam · unsent, you press Send' });
  assert.deepEqual(items.at(-1), { id: 'call', enabled: false, line: 'it did not come from a call' });
  const fromCall = menuFor('move', { move: { ...MOVE, call: { title: 'Weekly sync with Lena', folder: '2026-10-09-1300-weekly-sync' } }, toSend: true, appName: 'Outlook' });
  assert.deepEqual(fromCall.at(-1), { id: 'call', enabled: true, line: 'Weekly sync with Lena' });
});

test('a To do move has nothing to draft, and a text this Mac cannot send says so', () => {
  assert.deepEqual(menuFor('move', { move: { ...MOVE, kind: 'task' }, toSend: false, appName: 'Outlook' })[0], { id: 'draft', enabled: false, line: 'nothing to send for this one' });
  assert.deepEqual(menuFor('move', { move: { ...MOVE, app: 'messages', sendable: false }, toSend: true, appName: 'Messages' })[0], { id: 'draft', enabled: false, line: 'text it from your iPhone: this Mac cannot send SMS or RCS' });
  assert.ok(menuFor('move', { move: MOVE, toSend: false }).slice(1, 4).every((item) => item.enabled));
});

test('every menu is a known kind, its ids from MENU_ITEMS, at most 7 items', () => {
  for (const [kind, list] of Object.entries(MENU_ITEMS)) {
    assert.ok(list.length <= 7, kind);
    assert.equal(new Set(list).size, list.length, kind);
  }
  assert.throws(() => menuFor('finder', {}), /No menu/);
});

// 0 menu-only actions: each id of a page's menu table calls the function named here, and that function is also called
// by a visible control on the same page, outside the table. Rename's visible twin is the title itself: renameCall puts
// the caret in the node titleField draws, whose own focus and Enter do the renaming.
const TWINS = {
  'desktop/renderer/meetings.js': { table: 'RECORDING_MENU', kind: 'recording', fns: { guess: 'fileUnder', file: 'fileUnder', share: 'shareCall', open: 'showCall', copy: 'copyNotes', rename: 'renameCall', trash: 'trashCall' } },
  'desktop/renderer/workspaces.js': { table: 'WORKSPACE_MENU', kind: 'workspace', fns: { 'catch-up': 'refreshThis', open: 'open', more: 'tapStake', less: 'tapStake', park: 'showPark', rename: 'showEdit', retire: 'retire' } },
  'desktop/renderer/workspaces.js#move': { table: 'MOVE_MENU', kind: 'move', fns: { draft: 'lineBox', done: 'closeMove', date: 'dateBox', drop: 'closeMove', call: 'openCall' } },
};
const blockOf = (source, name) => {
  const at = source.indexOf(`const ${name} = {`);
  assert.ok(at >= 0, `${name} table`);
  return source.slice(at, source.indexOf('\n  };', at) + 5);
};
test('0 menu-only actions: every menu item calls what a visible control calls', async () => {
  for (const [file, { table, kind, fns }] of Object.entries(TWINS)) {
    const source = await readFile(new URL(`../${file.replace(/#.*$/, '')}`, import.meta.url), 'utf8');
    const block = blockOf(source, table);
    const rest = source.replace(block, '').replace(/(?:async )?function \w+\(/g, '');
    assert.deepEqual(Object.keys(fns), [...MENU_ITEMS[kind]], `${table} covers every ${kind} item`);
    for (const [id, fn] of Object.entries(fns)) {
      assert.match(block, new RegExp(`\\n\\s*'?${id}'?: [^\\n]*\\b${fn}\\(`), `${table}.${id} calls ${fn}`);
      if (fn === 'renameCall') { assert.match(source, /function renameCall[\s\S]{0,400}\.mt-title/); assert.match(source, /'mt-title is-editable'/); continue; }
      assert.match(rest, new RegExp(`\\b${fn}\\(`), `${fn} has a visible control in ${file}`);
    }
  }
});
