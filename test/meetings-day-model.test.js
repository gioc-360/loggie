// The Day view's decisions (loggie-meetings-focus): the one card, the week dots, the hidden line. Made-up meetings only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cardFor, dayRows, hiddenLine, mondayOf, weekDots, whenLine } from '../desktop/renderer/meetings-day-model.js';

const at = (day, time) => new Date(`2026-10-${day}T${time}:00`).toISOString();
const now = new Date(at(28, '10:35'));
const item = (title, start, sort = 'people', extra = {}) => ({ id: title, title, start, sort, call: null, ...extra });
const ITEMS = [
  item('Macro block', at(28, '10:00'), 'block'), item('NBA 6030', at(28, '10:10'), 'class'),
  item('Coffee chat', at(28, '11:00')), item('Office hours', at(28, '13:00')), item('AI Ops', at(28, '16:00')),
  item('Mock interview', at(26, '10:30')), item('Loggie check', at(27, '13:30')), item('Interview', at(27, '15:00')), item('CWG', at(27, '16:45')),
  item('Thursday chat', at(29, '09:00')),
];

test('the card: recording first, then a call that just ended, then the next meeting with people, else none', () => {
  assert.equal(cardFor({ items: ITEMS, calls: [{ id: 'c', state: 'recording' }], now }).mode, 'recording');
  const ended = { id: 'e', state: 'waiting', start: at(28, '09:30'), minutes: 50, workstream: null };
  assert.deepEqual([cardFor({ items: ITEMS, calls: [ended], now }).mode, cardFor({ items: ITEMS, calls: [ended], now }).minutes], ['ended', 50]);
  const filedAndDone = { ...ended, state: 'done', workstream: 'Loggie' };
  const next = cardFor({ items: ITEMS, calls: [filedAndDone], now });
  assert.deepEqual([next.mode, next.item.title, next.inMinutes], ['next', 'Coffee chat', 25], 'a summarized, filed call gives the card back');
  const old = { ...ended, start: at(28, '08:00'), minutes: 20, state: 'done' };
  assert.equal(cardFor({ items: ITEMS, calls: [old], now }).mode, 'ended', 'an unfiled call holds the card past an hour (andon)');
  assert.equal(cardFor({ items: ITEMS, calls: [old], now, left: new Set(['e']) }).mode, 'next', 'Leave it gives the card back');
  assert.equal(cardFor({ items: ITEMS, calls: [{ ...old, noWorkspace: true }], now }).mode, 'next', 'a summarized call in "No workspace" gives the card back');
  assert.equal(cardFor({ items: ITEMS, calls: [old], now: new Date(at(28, '10:52')) }).mode, 'next', 'a meeting 8 min away takes the card');
  assert.equal(cardFor({ items: ITEMS, calls: [{ ...old, start: at(27, '16:00') }], now }).mode, 'next', 'only a call that ended today holds it');
  const classNext = cardFor({ items: [item('Block', at(28, '10:40'), 'block'), item('Strategy', at(28, '13:25'), 'class')], now });
  assert.equal(classNext.item.title, 'Strategy', 'a class can be the card, a block never');
  const late = cardFor({ items: ITEMS, now: new Date(at(28, '17:00')) });
  assert.deepEqual([late.mode, late.tomorrow?.title], ['none', 'Thursday chat']);
  assert.equal(cardFor({ items: [item('Started', at(28, '10:28'))], now }).item.title, 'Started', 'a meeting that began 7 min ago is still next');
  assert.equal(cardFor({ items: [item('Recorded', at(28, '11:00'), 'people', { call: 'x' })], now }).mode, 'none', 'a meeting already recorded is not next');
});

test('rows of one day in time order; dots count meetings and classes', () => {
  assert.deepEqual(dayRows(ITEMS, '2026-10-28').map((row) => row.title), ['Macro block', 'NBA 6030', 'Coffee chat', 'Office hours', 'AI Ops']);
  assert.deepEqual(weekDots(ITEMS, mondayOf(now)).map((day) => day.mark), ['●', '●●●', '●●●●', '●', '', '', ''], 'a class counts, a block does not');
  assert.equal(weekDots(Array.from({ length: 6 }, (_, i) => item(`m${i}`, at(28, '09:00'))), mondayOf(now))[2].mark, '6');
});

test('when lines and the hidden line carry their units', () => {
  assert.deepEqual([whenLine(25), whenLine(0), whenLine(90), whenLine(60)], ['in 25 min', 'now', 'in 1 h 30 min', 'in 1 h']);
  const hidden = [{ day: '2026-10-28', why: 'school feed' }, { day: '2026-10-28', why: 'school feed' }, { day: '2026-10-28', why: 'duplicate' }, { day: '2026-10-28', why: '88 people' }, { day: '2026-10-27', why: 'duplicate' }];
  assert.equal(hiddenLine(hidden, '2026-10-28'), 'Hidden: 2 school items, 1 duplicate, 1 mass invite');
  assert.equal(hiddenLine(hidden, '2026-10-30'), '');
});

// --- Only his meetings fill the card (2026-10-27, week-events.js `mine`): a club night on the school's shared calendar
// starts with his interview and is listed first by title; the card is the interview.
test('1B a meeting on a calendar that is not his is a row, never the card', () => {
  const before = new Date(at(27, '14:50'));
  const items = [item('Club night', at(27, '15:00'), 'people', { mine: false }), item('Video Meeting with Example Bank', at(27, '15:00'), 'people', { mine: true }),
    item("Let's Talk in Sage Hall", at(27, '14:30'), 'block', { mine: false })];
  assert.equal(cardFor({ items, now: before }).item.title, 'Video Meeting with Example Bank');
  assert.equal(weekDots(items, mondayOf(before)).find((dot) => dot.day === '2026-10-27').count, 1, 'and only his count as dots');
});
