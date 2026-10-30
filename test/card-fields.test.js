// A workstream card's fields come from one place (desktop/card-fields.js), and main.js builds every card with it.
// 2026-10-17: the preview's made-up cards had label and stake, the real cards did not, so a rename saved but never
// showed and Inbox showed Edit and Dismiss. Made-up workstreams only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cardFields } from '../desktop/card-fields.js';
import { mainText } from './helpers/main-files.js';

test('a card carries its label, what kind of card it is, its stake and its park', () => {
  const ranked = { rank: 2, due: '2026-10-22', idle: false, stake: 'more', parked: true, parkedUntil: '2026-10-25' };
  const fields = cardFields({ name: 'JJC', label: 'JJC Karaoke Oct 22', stake: 'more', parkedUntil: '2026-10-25' }, ranked, { source: 'cloud', note: null, at: '2026-10-17T12:00:00Z' });
  assert.equal(fields.label, 'JJC Karaoke Oct 22');
  assert.deepEqual([fields.inbox, fields.chats, fields.folder, fields.stake], [false, false, false, 'more']);
  assert.deepEqual(fields.priority, { rank: 2, due: '2026-10-22', idle: false, stake: 'more', parked: true, parkedUntil: '2026-10-25', source: 'cloud', note: null, at: '2026-10-17T12:00:00Z' });
  assert.deepEqual([cardFields({ name: 'Inbox', inbox: true }).inbox, cardFields({ name: 'Chats', chats: true }).chats, cardFields({ name: 'p', folder: true }).folder], [true, true, true]);
  assert.deepEqual([cardFields({ name: 'X' }).label, cardFields({ name: 'X' }).priority, cardFields({ name: 'X' }).stake], [null, null, 'normal']);
});

test('main.js builds every workstream card with cardFields, and sets none of its fields a second time', async () => {
  const main = await mainText();
  const handler = main.slice(main.indexOf("handleSecure('hikyaku:workstreams'"), main.indexOf("handleSecure('hikyaku:workstreams'") + 9000);
  const card = handler.slice(handler.indexOf('const card = {'), handler.indexOf('};', handler.indexOf('const card = {')));
  assert.match(card, /\.\.\.cardFields\(workstream, ranked, priorities\)/);
  for (const key of ['label', 'inbox', 'chats', 'folder', 'stake', 'priority']) assert.doesNotMatch(card, new RegExp(`\\b${key}:`), `${key} is set only in card-fields.js`);
});
