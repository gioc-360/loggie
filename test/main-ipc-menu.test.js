// The native right-click menu and the Share door (loggie right-click, 2026-10-28): what a page may send (fixed ids, no
// words), the menu main builds from them with a fake Menu, the pick it answers, and the doors wired end to end.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateContextMenu, validateShare } from '../desktop/ipc-validation.js';
import { menuTemplate, popupMenu } from '../desktop/menu-template.js';
import { MENU_ITEMS, menuFor } from '../desktop/renderer/context-menu-model.js';
import { assertWired } from './helpers/main-files.js';

const CALL = '2026-10-21-1000-nba-5245-macro';
const share = (people = 2, notes = true) => ({ people, notes, app: 'outlook' });
// A fake Menu: `choose(template, close)` plays the person (a click, then the close; or the close alone, Esc).
const fakeMenu = (choose) => ({ buildFromTemplate: (template) => ({ popup: ({ callback }) => choose(template, callback) }) });
const labels = (template) => template.map((item) => (item.type === 'separator' ? '---' : item.label));

test('the Share menu is two lines: the people on this call, then the share sheet', () => {
  assert.deepEqual(MENU_ITEMS.share, ['people', 'sheet']);
  assert.deepEqual(menuFor('share').map((item) => item.id), ['people', 'sheet']);
  const template = menuTemplate({ kind: 'share', target: { id: CALL }, items: menuFor('share') }, { share: share(2), pick: () => {} });
  assert.deepEqual(labels(template), ['Send notes to the 2 people on this call', 'an email in Outlook, unsent · you press Send', 'Share sheet…', 'Mail, Messages, AirDrop, Notes, Copy']);
  assert.deepEqual(template.map((item) => item.enabled), [true, false, true, false]);
  assert.ok(template.filter((item) => item.enabled).every((item) => item.toolTip), 'every item says what happens');
  const one = menuTemplate({ kind: 'share', target: { id: CALL }, items: menuFor('share') }, { share: share(1), pick: () => {} });
  assert.equal(one[0].label, 'Send notes to the person on this call');
});

test('no addresses greys the email with its reason; no notes greys both', () => {
  const none = menuTemplate({ kind: 'share', target: { id: CALL }, items: menuFor('share') }, { share: share(0), pick: () => {} });
  assert.deepEqual([none[0].enabled, none[1].label, none[2].enabled], [false, 'no addresses on this call', true]);
  const bare = menuTemplate({ kind: 'share', target: { id: CALL }, items: menuFor('share') }, { share: share(2, false), pick: () => {} });
  assert.deepEqual([bare[0].enabled, bare[1].label, bare[2].enabled, bare[3].label], [false, 'no notes yet · Summarize first', false, 'no notes yet · Summarize first']);
});

test('the popup answers the clicked id, and no id when it closes with no pick', async () => {
  const menu = { kind: 'share', target: { id: CALL }, items: menuFor('share') };
  const picked = await popupMenu({ Menu: fakeMenu((template, close) => { template[2].click(); close(); }), menu, share: share(), delayMs: 0 });
  assert.deepEqual(picked, { id: 'sheet', value: null });
  const closed = await popupMenu({ Menu: fakeMenu((_template, close) => close()), menu, share: share(), delayMs: 0 });
  assert.deepEqual(closed, { id: null, value: null });
});

test('a page sends ids and a target, never words: anything else is refused', () => {
  const ok = { kind: 'share', target: { id: CALL }, items: menuFor('share') };
  assert.deepEqual(validateContextMenu(ok), ok);
  const bad = [
    null, [], { ...ok, kind: 'finder' }, { ...ok, items: [{ id: 'delete-everything', enabled: true }] },
    { ...ok, items: [{ id: 'people', enabled: true, label: 'Send to everyone' }] },
    { ...ok, items: [{ id: 'people', enabled: true, line: 'x'.repeat(81) }] },
    { ...ok, items: [{ id: 'people', enabled: true, line: 'two\nlines' }] },
    { ...ok, items: [{ id: 'people', enabled: 'yes' }] },
    { ...ok, items: [{ id: 'people', enabled: true }, { id: 'people', enabled: true }] },
    { ...ok, target: { id: '../secret' } }, { ...ok, target: null }, { ...ok, extra: 1 },
  ];
  for (const menu of bad) assert.throws(() => validateContextMenu(menu), /menu/i, JSON.stringify(menu));
  assert.deepEqual(validateShare(CALL, 'people'), { id: CALL, how: 'people' });
  assert.deepEqual(validateShare(CALL, 'sheet'), { id: CALL, how: 'sheet' });
  assert.throws(() => validateShare(CALL, 'upload'), /Share/);
  assert.throws(() => validateShare('../x', 'sheet'), /Invalid call/);
});

const GUESSED = { id: CALL, title: 'Coffee chat with Yuki', state: 'done', workstream: null, guess: 'Hotel Hackathon', evidence: 'said “hackathon” 4 times' };
const recording = (call = GUESSED, names = ['Hotel Hackathon', 'Bank Offer']) => ({ kind: 'recording', target: { id: CALL }, items: menuFor('recording', { call, names }) });

test('a recording\'s menu as the Mac draws it: the guess and its evidence first, Add to workspace, Share, and Delete last', () => {
  const template = menuTemplate(recording(), { share: share(3), pick: () => {} });
  assert.deepEqual(labels(template), ['Hotel Hackathon?', 'said “hackathon” 4 times · one press files it', 'Add to workspace', '---', 'Share', 'Open notes', 'Copy notes', 'Rename', '---', 'Delete recording']);
  const file = template.find((item) => item.label === 'Add to workspace');
  assert.deepEqual(file.submenu.map((item) => item.label || '---'), ['Hotel Hackathon?', 'Loggie’s guess', 'Bank Offer', '---', 'No workspace']);
  const shareItem = template.find((item) => item.label === 'Share');
  assert.deepEqual(shareItem.submenu.map((item) => item.label), ['Send notes to the 3 people on this call', 'an email in Outlook, unsent · you press Send', 'Share sheet…', 'Mail, Messages, AirDrop, Notes, Copy']);
  assert.ok(template.filter((item) => item.enabled !== false && item.type !== 'separator').every((item) => item.toolTip), 'every item says what happens');
  const filed = menuTemplate(recording({ ...GUESSED, workstream: 'Bank Offer', guess: null }, ['Bank Offer']), { share: share(), pick: () => {} });
  assert.deepEqual([filed[0].label, filed[0].enabled, filed[1].label], ['In Bank Offer', false, 'Add to workspace']);
  assert.deepEqual(filed[1].submenu.map((item) => [item.label, item.checked]), [['Bank Offer', true], [undefined, undefined], ['No workspace', false]]);
  const waiting = menuTemplate(recording({ ...GUESSED, state: 'waiting' }), { share: share(), pick: () => {} });
  assert.deepEqual(waiting.slice(-2).map((item) => [item.label, item.enabled]), [['Delete recording', false], ['not now: it is waiting for your yes to summarize', false]]);
});

test('picking Add to workspace > a name answers that name; the guess line answers the guess', async () => {
  const play = (find) => fakeMenu((template, close) => { find(template).click(); close(); });
  const named = await popupMenu({ Menu: play((t) => t.find((i) => i.label === 'Add to workspace').submenu.find((i) => i.label === 'Bank Offer')), menu: recording(), share: share(), delayMs: 0 });
  assert.deepEqual(named, { id: 'file', value: 'Bank Offer' });
  const none = await popupMenu({ Menu: play((t) => t.find((i) => i.label === 'Add to workspace').submenu.at(-1)), menu: recording(), share: share(), delayMs: 0 });
  assert.deepEqual(none, { id: 'file', value: null });
  assert.deepEqual(await popupMenu({ Menu: play((t) => t[0]), menu: recording(), share: share(), delayMs: 0 }), { id: 'guess', value: 'Hotel Hackathon' });
  assert.deepEqual(await popupMenu({ Menu: play((t) => t.find((i) => i.label === 'Share').submenu[0]), menu: recording(), share: share(), delayMs: 0 }), { id: 'share', value: 'people' });
});

test('a text field\'s menu is the Mac\'s own roles, nothing of Loggie\'s', () => {
  const template = menuTemplate({ kind: 'text', target: null, items: menuFor('text', { editable: true, selected: false }) }, { pick: () => {} });
  assert.deepEqual(template, [{ role: 'cut', enabled: false }, { role: 'copy', enabled: false }, { role: 'paste', enabled: true }, { role: 'selectAll', enabled: true }]);
});

test('a recording menu crosses with names as values only: 40 at most, one No workspace, only under Add to workspace', () => {
  assert.ok(validateContextMenu(recording()));
  assert.ok(validateContextMenu({ kind: 'text', target: null, items: menuFor('text', { editable: true, selected: true }) }));
  const names = (n) => Array.from({ length: n }, (_, i) => ({ value: `W${i}`, on: false }));
  const withSub = (submenu, id = 'file') => ({ ...recording(), items: [{ id, enabled: true, submenu }] });
  assert.ok(validateContextMenu(withSub([...names(40), { value: null, on: false }])));
  for (const menu of [withSub(names(41)), withSub([{ value: null }, { value: null }]), withSub([{ value: 'A' }, { value: 'A' }]), withSub([{ value: 'A\nB' }]), withSub([{ value: 'A', label: 'x' }]), withSub([{ value: 'A' }], 'open'),
    { kind: 'text', target: { id: CALL }, items: menuFor('text', {}) }, { ...recording(), target: { id: 'a/b' } }]) {
    assert.throws(() => validateContextMenu(menu), /menu/i, JSON.stringify(menu).slice(0, 120));
  }
});

test('a workspace row\'s menu as the Mac draws it: checks for what is on, rules between the groups', () => {
  const card = { name: 'Hotel Hackathon', stake: 'more', priority: { parked: false } };
  const menu = { kind: 'workspace', target: { id: 'Hotel Hackathon' }, items: menuFor('workspace', { card, fresh: '3 new since Oct 26' }) };
  assert.ok(validateContextMenu(menu));
  const template = menuTemplate(menu, { pick: () => {} });
  assert.deepEqual(labels(template), ['Catch up now', '3 new since Oct 26', 'Open', '---', 'Matters more', 'Matters less', 'Park until…', '---', 'Edit name', 'Retire']);
  assert.deepEqual(template.filter((item) => item.type === 'checkhouse').map((item) => [item.label, item.checked]), [['Matters more', true], ['Matters less', false], ['Park until…', false]]);
  assert.ok(template.filter((item) => item.enabled !== false && item.type !== 'separator').every((item) => item.toolTip));
  for (const id of ['', 'x'.repeat(201), 'a\nb', 7]) assert.throws(() => validateContextMenu({ ...menu, target: { id } }), /menu/i, String(id));
});

test('a move\'s menu as the Mac draws it, on a move id only', () => {
  const move = { id: 'task_c', title: 'Email Sam', kind: 'email', app: 'outlook', to: 'Sam', call: { title: 'Weekly sync with Lena', folder: '2026-10-09-1300-weekly-sync' } };
  const menu = { kind: 'move', target: { id: 'task_c' }, items: menuFor('move', { move, toSend: true, appName: 'Outlook' }) };
  assert.ok(validateContextMenu(menu));
  const template = menuTemplate(menu, { pick: () => {} });
  assert.deepEqual(labels(template), ['Draft it with Loggie', 'in Outlook, to Sam · unsent, you press Send', '---', 'Done', 'New date…', 'Drop it', '---', 'Open the call it came from', 'Weekly sync with Lena']);
  assert.ok(template.filter((item) => item.enabled !== false && item.type !== 'separator').every((item) => item.toolTip));
  for (const id of ['', 'task/../x', 'a b', 'x'.repeat(201)]) assert.throws(() => validateContextMenu({ ...menu, target: { id } }), /menu/i, id);
});

test('the menu, share and trash doors are wired main -> preload -> panel', async () => {
  await assertWired([['hikyaku:context-menu', 'contextMenu'], ['hikyaku:call-share', 'callShare'], ['hikyaku:call-trash', 'callTrash']]);
});

test('main\'s menu files never remove a file or reach the network', async () => {
  for (const file of ['desktop/main-ipc-menu.js', 'desktop/menu-template.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bunlink\b|\brmSync\b|\brm\(|\brmdir\b|\bfetch\(|https?:/, file);
  }
});
