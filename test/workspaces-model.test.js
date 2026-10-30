// The Workspaces list (desktop/renderer/workspaces-model.js) on made-up cards: order, the words on each row.
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshLine, listRows, newsLines, retiredWhy, voiceLine } from '../desktop/renderer/workspaces-model.js';
import { CARDS } from '../desktop/renderer/preview/fixture-cards.js';

test('the user\'s workspaces first by next due date, undated after in ranking order, Inbox, Chats and folders last', () => {
  const cards = [...structuredClone(CARDS), { name: 'Inbox', inbox: true, moves: [], active: [] }, { name: 'Chats', chats: true, moves: [], active: [] }];
  cards.unshift(cards.splice(cards.findIndex((c) => c.name === 'Pharma Case'), 1)[0]);
  assert.deepEqual(listRows(cards, '2026-10-10').map((row) => row.name), ['Bank Offer', 'Hotel Hackathon', 'Pharma Case', 'App Project', 'Class A', 'Class B', 'Inbox', 'Chats']);
});

test('a row says its goal, its next due day or park, how much is to send and what is new', () => {
  const card = structuredClone(CARDS[0]);
  const row = listRows([card], '2026-10-10')[0];
  assert.deepEqual([row.label, row.goal, row.when, row.toSend, row.fresh], ['Bank Offer', 'Get an Executive Associate offer', 'by Oct 15', 4, '2 new since Oct 8']);
  card.label = 'Bank, the offer';
  card.priority = { ...card.priority, parked: true, parkedUntil: '2026-10-20' };
  assert.deepEqual([listRows([card], '2026-10-10')[0].label, listRows([card], '2026-10-10')[0].when], ['Bank, the offer', 'Parked until Oct 20']);
  assert.equal(listRows([{ name: 'Inbox', inbox: true }])[0].named, false);
});

test('the words: fresh, news folded by thread, voice, why a move was retired', () => {
  assert.equal(freshLine({ quiet: true, unread: 0 }), 'Just keep me posted');
  assert.equal(freshLine({ asOf: '2026-10-08T10:00:00Z', unread: 0 }), 'Up to date as of Oct 8');
  assert.deepEqual(newsLines([{ source: 'outlook', title: 'RE: Dinner', at: '2026-10-09T00:00:00Z' }, { source: 'gmail', title: 'Dinner', at: '2026-10-08T00:00:00Z' }]).map((n) => [n.title, n.count]), [['Dinner', 2]]);
  assert.equal(voiceLine({ median: 52, sends: 9, here: 3 }), 'About 52 words · median of your 3 sends here');
  assert.equal(voiceLine(null), null);
  // loggie-reply-yes: no length yet, no line ("0 sends so far" was all it ever showed).
  assert.equal(voiceLine({ median: null, sends: 0, here: 0 }), null);
  assert.equal(voiceLine({ median: null, sends: 2, here: 2 }), null);
  assert.equal(retiredWhy({ why: 'past', proof: '2026-10-05' }), 'date passed (Oct 5)');
});

// The goal line from evidence (loggie-workspaces-integration F2): the next calendar date, his own confirmed words when
// there are some, and never a kind label.
test('the goal line is the next date on its calendar, his own words when confirmed, else blank', async () => {
  const { goalLine, nextLine } = await import('../desktop/renderer/workspaces-model.js');
  const now = new Date('2026-10-26T12:00:00-04:00');
  const card = { goal: 'Get an offer', milestones: [{ title: 'Video Meeting with Bank', at: '2026-10-27T15:00:00-04:00' }, { title: 'Old chat', at: '2026-10-23T14:00:00-04:00' }] };
  assert.equal(nextLine(card, now), 'Next: Video Meeting with Bank · Tue Oct 27 · 3 PM');
  assert.equal(goalLine({ goal: 'Get an offer', milestones: [] }, now), '', 'a label never shows');
  assert.equal(goalLine({ ...card, goalText: 'Land the EA role', goalConfirmed: true }, now), 'Land the EA role');
  assert.equal(goalLine({ ...card, goalText: 'A draft', goalConfirmed: false }, now), 'Next: Video Meeting with Bank · Tue Oct 27 · 3 PM', 'an unconfirmed draft does not take the line');
});
