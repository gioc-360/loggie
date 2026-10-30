// Today's list (desktop/renderer/today-model.js, spec-b T2) on made-up cards: picks matched by task id, one button
// each, the four states, the words. The cards are the preview's fixtures (made up, no real person).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buttonOf, matchPick, metaOf, moveGroup, questionFor, quoteOf, todayItems, whyOf } from '../desktop/renderer/today-model.js';
import { CARDS } from '../desktop/renderer/preview/fixture-cards.js';

const cards = () => structuredClone(CARDS);
const pick = (taskId, extra = {}) => ({ taskId, name: 'Bank Offer', move: `move ${taskId}`, due: null, why: null, quote: null, ...extra });

test('a pick finds its move by task id, and a move from a text drafts with its line box', () => {
  const entry = matchPick(pick('task_c'), cards());
  assert.equal(entry.card.name, 'Bank Offer');
  assert.equal(entry.move.askLine, 'ask about the bar tab');
  assert.deepEqual(buttonOf(entry), { kind: 'app', label: 'Draft it in Outlook' });
});

test('a pick with no move and no active task is found by its workstream and gets Draft it, unless its words are a To do', () => {
  const entry = matchPick(pick('task_gone', { move: 'Ask about the start date' }), cards());
  assert.deepEqual([entry.card.name, entry.move, entry.active], ['Bank Offer', null, null]);
  assert.deepEqual(buttonOf(entry), { kind: 'do-it', label: 'Draft it' });
  assert.deepEqual(buttonOf(matchPick(pick('task_gone', { move: 'Prepare for your chat with Sam Lee tomorrow' }), cards())), { kind: 'todo', label: '' });
});

// Gio, 2026-10-21, on the M&T Bank Outreach card: a prepare move sat under To send with a mail button.
test('To send or To do: one rule for the heading and the button (moveGroup)', () => {
  const prep = { id: 'task_x', title: 'Prepare for your chat with Sam Lee tomorrow', kind: 'prep', app: 'outlook' };
  const intro = { id: 'task_y', title: 'Email Sam Lee (introduced by Ana, Oct 20)', kind: 'email', app: 'outlook' };
  const reply = { id: 'task_z', title: 'Confirm Thursday at 3 with Ana', kind: 'reply', app: 'outlook', waiting: true };
  assert.deepEqual([prep, intro, reply].map(moveGroup), ['do', 'send', 'send']);
  // With no kind (a call step, a move written after Send), the first word decides.
  assert.deepEqual(['Prepare for your chat with Sam Lee tomorrow', 'Email Sam Lee', 'Send Ana the deck', '↩ Reply to Ana', 'Attend the info session', 'Submit the application', 'Read the case', 'Decide on the offer']
    .map((title) => moveGroup({ title, kind: 'call' })), ['do', 'send', 'send', 'send', 'do', 'do', 'do', 'do']);
  // The kind wins over the words: a reply that starts "Confirm" is still To send, a prep that starts "Send" is To do.
  assert.equal(moveGroup({ title: 'Send in the form', kind: 'apply' }), 'do');
  // Today: no Draft it on a To do move, Done and New date stay (move-view.js draws them for any move).
  const list = cards();
  list[0].moves = [prep, intro, reply];
  assert.deepEqual(buttonOf(matchPick(pick('task_x'), list)), { kind: 'todo', label: '' });
  assert.deepEqual(buttonOf(matchPick(pick('task_y'), list)), { kind: 'app', label: 'Draft it in Outlook' });
  assert.deepEqual(buttonOf(matchPick(pick('task_z'), list)), { kind: 'app', label: 'Draft it in Outlook' });
});

test('a question on a pick shows in its card, and its "?" row leaves the list', () => {
  const list = cards();
  list[0].active = [{ id: 'task_q1', title: 'Follow up with the recruiter', phase: 'needs-you', question: 'Answer "again".' }];
  list[1].active = [{ id: 'task_q2', title: 'Confirm the build day plan', phase: 'needs-you', question: '?' }];
  const rows = [{ key: 'pick:task_q1' }, { key: 'ask:task_q1' }, { key: 'ask:task_q2' }, { key: 'home:x' }, { key: 'calls' }];
  const today = todayItems({ picks: [pick('task_q1'), pick('task_c')], source: 'ai', cards: list, rows });
  assert.equal(questionFor(today.entries[0]).id, 'task_q1');
  assert.equal(buttonOf(today.entries[0]).kind, 'answer');
  assert.deepEqual(today.rows.map((row) => row.key), ['ask:task_q2', 'home:x', 'calls']);
});

test('drafts ready to open: Open or Open again, newest first, never a pick\'s own', () => {
  const list = cards();
  list[0].active = [{ id: 'task_r1', title: 'One', phase: 'ready', at: '2026-10-09T00:00:00Z' }, { id: 'task_r2', title: 'Two', phase: 'in-mail-app', at: '2026-10-10T00:00:00Z' }, { id: 'task_p', title: 'Pick', phase: 'ready', at: '2026-10-11T00:00:00Z' }];
  assert.deepEqual(buttonOf(matchPick(pick('task_r1'), list)), { kind: 'open', label: 'Open' });
  assert.deepEqual(buttonOf(matchPick(pick('task_r2'), list)), { kind: 'open', label: 'Open again' });
  assert.deepEqual(todayItems({ picks: [pick('task_p')], cards: list }).ready.map((item) => item.active.id), ['task_r2', 'task_r1']);
});

test('a draft being written says so, a text this Mac cannot send says to use the iPhone, WhatsApp names its app', () => {
  const list = cards();
  list[0].active = [{ id: 'task_d', title: 'D', phase: 'drafting' }];
  assert.deepEqual(buttonOf(matchPick(pick('task_d'), list)), { kind: 'busy', label: 'Loggie is preparing drafts…' });
  assert.deepEqual(buttonOf(matchPick(pick('task_b'), list)), { kind: 'phone', label: 'Text from your iPhone' });
  list[0].moves[0].app = 'whatsapp';
  assert.equal(buttonOf(matchPick(pick('task_a'), list)).label, 'Draft it in WhatsApp');
});

test('the four states: first run, nothing first, by date, normal', () => {
  const fresh = [{ name: 'Inbox', inbox: true, moves: [], active: [] }, { name: 'Chats', chats: true, moves: [], active: [] }];
  assert.equal(todayItems({ picks: [], cards: fresh }).state, 'first-run');
  assert.equal(todayItems({ picks: [], cards: cards() }).state, 'nothing');
  assert.equal(todayItems({ picks: [pick('task_a')], source: 'date', cards: cards() }).state, 'date');
  assert.equal(todayItems({ picks: [pick('task_a')], source: 'ai', cards: cards() }).state, 'normal');
});

test('the meta line: the card\'s own name, the due day, "by date", and late in red', () => {
  const list = cards();
  list[0].label = 'Bank, the offer';
  assert.deepEqual(metaOf(matchPick(pick('task_a'), list), { today: '2026-10-10' }), { text: 'Bank, the offer · Oct 15', late: false });
  assert.equal(metaOf(matchPick(pick('task_a'), cards()), { source: 'date' }).text, 'Bank Offer · Oct 15 · by date');
  assert.equal(metaOf(matchPick(pick('task_b'), cards()), { today: '2026-10-10' }).late, true);
});

test('the quote: never the title again; else their last words; else the call\'s first line', () => {
  const echo = matchPick(pick('task_a', { quote: 'Follow up with the recruiter, on interview status!' }), cards());
  assert.deepEqual(quoteOf(echo), { text: 'Thanks for sending! I just sent the recruiter an email.', who: 'Ana Recruiter', when: 'Oct 5', folder: null });
  const call = quoteOf(matchPick(pick('task_b'), cards()));
  assert.equal(call.text, 'P0 = fix by end of day; target: 3 days');
  assert.equal(call.folder, '2026-10-09-1300-weekly-sync');
});

test('one entry per task id, and the why joins "Replies first."', () => {
  assert.equal(todayItems({ picks: [pick('task_a'), pick('task_a')], cards: cards() }).entries.length, 1);
  assert.equal(whyOf({ why: 'She asked twice.', rule: 'replies first' }), 'She asked twice. Replies first.');
  assert.equal(whyOf({ why: '', rule: null }), null);
});

// 2026-10-21: New date opened over the line box got the typed words as its value and threw.
test('a date box only takes a typed value that is a date', async () => {
  const { isDay } = await import('../desktop/renderer/move-view.js');
  assert.equal(isDay('2026-10-23'), true);
  assert.equal(isDay('meet on friday'), false);
  assert.equal(isDay(null), false);
});

// Dates on the tag, not in the words (Gio, 2026-10-23): a date naming the move's own day leaves the title, its time joins the tag.
test('titleAndTime takes the move own date out of the title and keeps its time for the tag', async () => {
  const { titleAndTime } = await import('../desktop/renderer/today-model.js');
  assert.deepEqual(titleAndTime('Prepare for the interview with Dana Reyes on Tuesday, October 27 at 3PM EST', '2026-10-27'), { title: 'Prepare for the interview with Dana Reyes', time: '3 PM' });
  assert.deepEqual(titleAndTime('Attend your video meeting with Acme Bank on 2026-10-27', '2026-10-27'), { title: 'Attend your video meeting with Acme Bank', time: null });
  assert.equal(titleAndTime('Prepare for your chat with Sam Lee tomorrow', '2026-10-23').title, 'Prepare for your chat with Sam Lee');
  assert.equal(titleAndTime('Submit memo by Oct 27', '2026-10-27').title, 'Submit memo');
  assert.equal(titleAndTime('Deliver competitor benchmarks by Wednesday (Wed Nov 4)', '2026-11-04').title, 'Deliver competitor benchmarks by Wednesday');
  assert.equal(titleAndTime('Prepare for run-through next Thursday (Thu Nov 5) at 4', '2026-11-05').title, 'Prepare for run-through next Thursday at 4');
  assert.equal(titleAndTime('Call Dana on Oct 30', '2026-10-27').title, 'Call Dana on Oct 30', 'another day is not the tag\'s');
  assert.equal(titleAndTime('Send the deck tomorrow', null).title, 'Send the deck tomorrow', 'no date: the words stay');
  assert.equal(titleAndTime('Send notes to Jamie', '2026-10-26').title, 'Send notes to Jamie');
});
