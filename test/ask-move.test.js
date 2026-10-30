// "Move a meeting" (loggie-ask-box increment 9): the real runner, meeting finder, time reader and helper call; only
// the calendar list and the Outlook helper process are fakes. Made-up meetings. The helper never presses Send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { findMeeting, readWhen, moveInOutlook, dayLabel } from '../src/hikyaku/ask-move.js';

const now = new Date(2026, 9, 11, 12, 0);
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const events = [
  { id: 'e1', title: 'Offer call', start: at(13, 15), end: at(13, 15, 50), allDay: false, attendees: ['jamie@acmebank.example'], attendeeNames: ['Jamie Park'] },
  { id: 'e2', title: 'Case team sync', start: at(12, 10), end: at(12, 11), allDay: false, attendees: ['y@example.org', 'd@example.org'], attendeeNames: ['Yuki Sato', 'Dana Wu'] },
  { id: 'e3', title: 'Case team sync', start: at(14, 10), end: at(14, 11), allDay: false, attendees: ['y@example.org'], attendeeNames: ['Yuki Sato'] },
  { id: 'e6', title: 'Case team prep', start: at(15, 9), end: at(15, 10), allDay: false, attendees: [], attendeeNames: [] },
  { id: 'e4', title: 'Holiday', start: at(13, 0), end: at(14, 0), allDay: true, attendees: [], attendeeNames: [] },
  { id: 'e5', title: 'Old review', start: at(1, 9), end: at(1, 10), allDay: false, attendees: [], attendeeNames: [] },
];
const names = [{ name: 'Jamie Park', kind: 'person', app: 'messages', chatId: '1', address: '+1', isGroup: false, last: '' }, { name: 'Yuki Sato', kind: 'person', app: 'whatsapp', chatId: '2', isGroup: false, last: '' }];

test('finding: by who, by title words, by the time said; two that fit are a question; past and all-day never', () => {
  assert.equal(findMeeting(events, { who: ['jamie'], meeting: '3pm with jamie', now }).event.id, 'e1');
  assert.equal(findMeeting(events, { meeting: 'offer call', now }).event.id, 'e1');
  assert.equal(findMeeting(events, { meeting: 'case team sync', now }).event.id, 'e2', 'a weekly meeting: the next one');
  assert.equal(findMeeting(events, { meeting: 'case team', now }).status, 'many', 'two different meetings fit: ask');
  assert.equal(findMeeting(events, { meeting: 'case team sync tuesday', now }).status, 'none', 'a day said that no sync falls on finds none');
  assert.equal(findMeeting(events, { meeting: 'wednesday case team sync', now }).event.id, 'e3');
  assert.equal(findMeeting(events, { meeting: 'monday case team sync', now }).event.id, 'e2');
  assert.equal(findMeeting(events, { meeting: 'old review', now }).status, 'none');
  assert.equal(findMeeting(events, { meeting: 'holiday', now }).status, 'none');
});

test('the new time: a day keeps the start, a time keeps the day, both set both', () => {
  const offer = events[0];
  const fri = readWhen('friday', { now, event: offer }).start;
  assert.deepEqual([fri.getDate(), fri.getHours()], [16, 15]);
  const four = readWhen('4pm', { now, event: offer }).start;
  assert.deepEqual([four.getDate(), four.getHours()], [13, 16]);
  const both = readWhen('thursday 1730', { now, event: offer }).start;
  assert.deepEqual([both.getDate(), both.getHours(), both.getMinutes()], [15, 17, 30]);
});

test('the helper gets the title, the day as the calendar shows it, the new day and start; a dry run says so', async () => {
  const calls = [];
  const execImpl = async (binary, args) => { calls.push(args); return { stdout: JSON.stringify({ status: 'moved', after: '17:30 - 18:20, 50 min' }) }; };
  const out = await moveInOutlook({ title: 'Offer call', from: new Date(events[0].start), to: new Date(2026, 9, 15, 17, 30), execImpl, helper: '/bin/fake' });
  assert.equal(out.status, 'moved');
  assert.deepEqual(calls[0], ['move', '--title', 'Offer call', '--day', 'Tue, Oct 13, 2026', '--to-day', '2026-10-15', '--to-start', '17:30']);
  await moveInOutlook({ title: 'x', from: new Date(), to: new Date(), dryRun: true, execImpl, helper: '/bin/fake' });
  assert.equal(calls[1].at(-1), '--dry-run');
  assert.equal(dayLabel(new Date(2026, 9, 11)), 'Sun, Oct 11, 2026');
});

async function setup(helperAnswer = { status: 'moved', after: '17:30 - 18:20, 50 min, Everyone is available', detail: 'moved' }) {
  const helper = [];
  const asker = createAsker({
    home: await mkdtemp(join(tmpdir(), 'ask-move-')), loadIndex: async () => names, openChat: async () => ({}), now: () => now.getTime(),
    calendar: { list: async () => events, move: (options) => moveInOutlook({ ...options, helper: '/bin/fake', execImpl: async (b, args) => { helper.push(args); return { stdout: JSON.stringify(helperAnswer) }; } }) },
  });
  return { asker, helper };
}

test('"move my 3pm with jamie to thursday 1730": found, moved in Outlook, unsent', async () => {
  const { asker, helper } = await setup();
  const result = await asker.run('move my 3pm with jamie to thursday 1730').done;
  assert.equal(result.outcome, 'placed', JSON.stringify(result));
  assert.deepEqual(helper[0].slice(-4), ['--to-day', '2026-10-15', '--to-start', '17:30']);
  assert.match(result.lines[0], /Moved in Outlook: Offer call\. Press Send there/);
});

test('two meetings that fit are a question with both; the choice then moves that one', async () => {
  const { asker, helper } = await setup();
  const asked = await asker.run('move the case team thing to friday').done;
  assert.deepEqual([asked.outcome, asked.status], ['question', 'which']);
  assert.equal(asked.who[0].candidates.length, 2);
  assert.equal(helper.length, 0);
  const chosen = await asker.run('move the case team thing to friday', { choices: { meeting: 'e3' } }).done;
  assert.equal(chosen.outcome, 'placed');
  assert.deepEqual(helper[0].slice(4, 7), ['Wed, Oct 14, 2026', '--to-day', '2026-10-16']);
});

test('a quarter-hour start, a meeting that is not yours, and no match each say so plainly', async () => {
  const quarter = await (await setup()).asker.run('move the offer call to 4:15pm').done;
  assert.match(quarter.lines[0], /on the hour or half hour/);
  const notMine = await (await setup({ status: 'not-organizer', detail: 'This meeting is someone else\'s, so Outlook does not let you change its time.' })).asker.run('move the offer call to friday').done;
  assert.equal(notMine.outcome, 'failed');
  assert.match(notMine.lines[0], /someone else's/);
  const none = await (await setup()).asker.run('move my dentist thing to friday').done;
  assert.match(none.lines[0], /No upcoming meeting matches/);
});

test('Undo on a move asks the helper to discard exactly that meeting\'s change', async () => {
  const calls = [];
  const asker = createAsker({ home: await mkdtemp(join(tmpdir(), 'ask-move-undo-')), loadIndex: async () => names, openChat: async () => ({}), now: () => now.getTime(),
    calendar: { list: async () => events, move: async () => ({ status: 'moved', after: '17:30' }), discard: async ({ title }) => { calls.push(title); return { status: 'discarded' }; } } });
  const result = await asker.run('move the offer call to friday').done;
  assert.equal(result.undoable, true);
  const undone = await asker.undo(result.askId);
  assert.deepEqual(calls, ['Offer call']);
  assert.match(undone.lines[0], /back where it was/);
});
