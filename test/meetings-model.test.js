import assert from 'node:assert/strict';
import test from 'node:test';
import { busy, colorFor, groupByDay, lineIndexAt, matches, metaLine, minutesLabel, PALETTE, pickerNames } from '../desktop/renderer/meetings-model.js';

test('minutes read as people say them', () => {
  assert.equal(minutesLabel(28), '28 min');
  assert.equal(minutesLabel(60), '1 h');
  assert.equal(minutesLabel(170), '2 h 50 min');
  assert.equal(minutesLabel(null), '');
});

test('the rail line says what a moving call is doing, else its time and length', () => {
  assert.equal(metaLine({ state: 'waiting' }), 'Waiting for your yes');
  assert.equal(metaLine({ state: 'recording' }), 'Recording');
  assert.match(metaLine({ state: 'done', start: '2026-10-09T17:00:00Z', minutes: 33 }), /^\d{1,2}:\d{2} [AP]M · 33 min$/);
});

test('calls group under their day in the order given', () => {
  const groups = groupByDay([{ id: 'a', start: '2026-10-09T15:00:00Z' }, { id: 'b', start: '2026-10-09T13:00:00Z' }, { id: 'c', start: '2026-10-07T13:00:00Z' }]);
  assert.deepEqual(groups.map((g) => g.calls.map((c) => c.id)), [['a', 'b'], ['c']]);
});

test('search needs every word, in the title, workstream or loaded summary', () => {
  const call = { title: 'Weekly sync', workstream: 'Acme Bank' };
  assert.ok(matches(call, 'weekly acme'));
  assert.ok(!matches(call, 'weekly roadmap'));
  assert.ok(matches(call, 'roadmap', { sections: [{ heading: 'Role', lines: [{ text: 'Owns the roadmap' }] }], steps: [] }));
});

test('a workstream always gets the same dot color from the palette', () => {
  assert.equal(colorFor('Acme Bank'), colorFor('Acme Bank'));
  assert.ok(PALETTE.includes(colorFor('Hotel')));
});

test('a time lands on the first line said at or after it, else the last', () => {
  const t = [{ at: 10 }, { at: 70 }, { at: 200 }];
  assert.equal(lineIndexAt(t, 70), 1);
  assert.equal(lineIndexAt(t, 71), 2);
  assert.equal(lineIndexAt(t, 999), 2);
  assert.equal(lineIndexAt([], 5), -1);
});

test('the picker leaves out folders, Chats and the inbox, and puts the guess first', () => {
  const cards = [{ name: 'Acme Bank' }, { name: 'Chats' }, { name: 'Inbox' }, { name: 'Notes', folder: '/x' }, { name: 'Hotel' }];
  assert.deepEqual(pickerNames(cards, 'Hotel'), ['Hotel', 'Acme Bank']);
});

test('the tab polls only while a call is moving', () => {
  assert.ok(busy([{ state: 'done' }, { state: 'writing' }]));
  assert.ok(!busy([{ state: 'done' }, { state: 'waiting' }]));
});
