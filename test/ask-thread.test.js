// Which thread an email ask answers (loggie-ask-thread): the Cc rule, the words rule, calendar answers folded into
// their thread, and no thread at all. Made-up people; the 2026-10-12 case is rebuilt with made-up names and the same shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { threadsFrom, pickThread, threadKey, lineWords, cleanSubject } from '../src/hikyaku/ask-thread.js';

const me = 'me@school.example';
const prof = 'Dana Reyes <dr1@school.example>';
const mail = [
  { id: 'apple-mail-3', from: prof, to: 'sam@school.example', cc: me, subject: 'Re: Presentation date - conflict on Nov 19', timestamp: '2026-10-11T22:07:05.000Z',
    body: 'Hello Gentlemen, Nothing to worry about. I will assign your presentation on one of the dates that you propose. Dana Reyes, Strategy' },
  { id: 'apple-mail-2', from: prof, to: me, cc: '', subject: 'Re: Request to attend remotely next week (travel)', timestamp: '2026-10-06T07:06:44.000Z',
    body: 'I am very sorry to hear that. I will keep the notes from our class for you. If you need some extra time with our assignment, please let me know. Dana Reyes, Strategy' },
  { id: 'apple-mail-1', from: prof, to: me, cc: '', subject: 'Re: Macroeconomics Section 1: Assignment 1 Turn in', timestamp: '2026-09-22T05:50:10.000Z',
    body: 'Received, thank you. Dana Reyes, Strategy' },
  { id: 'apple-mail-9', from: 'Someone Else <se@school.example>', to: me, subject: 'Assignment 2 posted', timestamp: '2026-10-12T08:00:00.000Z', body: 'assignment 2' },
];

test('the thread his words point at: the Cc-only newest is passed over for the newest one sent to him', () => {
  const threads = threadsFrom(mail, 'dr1@school.example', [me]);
  assert.deepEqual(threads.map((t) => [t.id, t.ccOnly]), [['apple-mail-3', true], ['apple-mail-2', false], ['apple-mail-1', false]]);
  const pick = pickThread('sending my assignment 2.', threads);
  assert.equal(pick.thread.id, 'apple-mail-2');
  assert.equal(pick.how, 'not-cc');
  assert.deepEqual(pick.others.map((t) => t.id), ['apple-mail-3', 'apple-mail-1']);
});

test('a line with no thread words answers the default thread, never a new email', () => {
  const threads = threadsFrom(mail, 'dr1@school.example', [me]);
  for (const line of ['ok sounds good', 'No worries!', 'thanks, see you next week']) assert.equal(pickThread(line, threads).thread.id, 'apple-mail-2', line);
});

test('words in one other thread, and none in the default, move the reply there', () => {
  const threads = threadsFrom(mail, 'dr1@school.example', [me]);
  const pick = pickThread('about the presentation dates you propose', threads);
  assert.equal(pick.thread.id, 'apple-mail-3');
  assert.equal(pick.how, 'words');
  assert.ok(pick.matched.includes('presentation'));
  // A word the default also has keeps the default: the line may be about it.
  assert.equal(pickThread('the assignment and the presentation', threads).thread.id, 'apple-mail-2');
});

test('a word in every thread, the person\'s own name and greeting words never move the reply', () => {
  const threads = threadsFrom(mail, 'dr1@school.example', [me]);
  assert.equal(pickThread('Hi Professor Reyes, strategy question', threads).thread.id, 'apple-mail-2');
  assert.equal(pickThread('Dana, what time works next week?', threads).thread.id, 'apple-mail-2');
});

test('calendar answers and other languages\' Re: fold into their thread; a thread of only calendar answers is not one', () => {
  assert.equal(threadKey('Accepted: Coffee chat - Gio + Adi'), threadKey('Re: Coffee chat - Gio + Adi'));
  assert.equal(threadKey('回覆: Zoom link'), 'zoom link');
  assert.equal(cleanSubject('Re: Re: Fwd: Plan'), 'Plan');
  const threads = threadsFrom([
    { id: 'a', from: 'Adi <adi@x.example>', to: me, subject: 'Accepted: Coffee chat', timestamp: '2026-10-10T10:00:00Z', body: '' },
    { id: 'b', from: 'Adi <adi@x.example>', to: me, subject: 'Re: Coffee chat', timestamp: '2026-10-09T10:00:00Z', body: 'sage atrium works' },
    { id: 'c', from: 'Adi <adi@x.example>', to: me, subject: 'Declined: CWG meeting', timestamp: '2026-10-11T10:00:00Z', body: '' },
  ], 'adi@x.example', [me]);
  assert.deepEqual(threads.map((t) => [t.id, t.count]), [['b', 2]]);
});

test('no thread with the person: a new email, said as such', () => {
  assert.deepEqual(pickThread('hello', threadsFrom(mail, 'nobody@x.example', [me])), { thread: null, how: 'none', matched: [], others: [] });
  assert.equal(pickThread('anything', threadsFrom(mail.slice(1, 2), 'dr1@school.example', [me])).how, 'only');
});

test('line words: stop words out, numbers kept, stems shared', () => {
  assert.deepEqual(lineWords('Sending my assignment 2.'), ['assignment', '2']);
  assert.deepEqual(lineWords('the classes'), lineWords('class'));
});

// workspaces-outlook W9: a date said two ways is the same words, so it names the same thread.
test('"Oct 22" and "October 22nd" share their words; the date keeps a reply in the thread it names', async () => {
  const { lineWords, pickThread } = await import('../src/hikyaku/ask-thread.js');
  assert.deepEqual(lineWords('Oct 22'), lineWords('October 22nd'));
  assert.deepEqual(lineWords('Sept 3rd'), lineWords('september 3'));
  const at = (day) => `2026-10-${day}T12:00:00.000Z`;
  const thread = (subject, day, body) => ({ id: subject, key: subject.toLowerCase(), subject, at: at(day), ccOnly: false, target: { from: 'K-HOUSE <k@venue.com>' }, words: new Set(lineWords(`${subject} ${body}`)) });
  const threads = [thread('October 22nd | Karaoke event', '08', 'the room is booked'), thread('Room K for October 15 | Karaoke event', '03', 'Room K is $500 at the bar')];
  const pick = pickThread('ask if we can set up a $500 bar tab for our Oct 22 karaoke event', threads);
  assert.equal(pick.thread.subject, 'October 22nd | Karaoke event');
});

test('a price and one loose word never pull a reply out of the person\'s newest thread', async () => {
  const { lineWords, pickThread } = await import('../src/hikyaku/ask-thread.js');
  const thread = (subject, day, body) => ({ id: subject, key: subject.toLowerCase(), subject, at: `2026-10-${day}T12:00:00.000Z`, ccOnly: false, target: { from: 'K-HOUSE <k@venue.com>' }, words: new Set(lineWords(`${subject} ${body}`)) });
  const threads = [thread('October 22nd | Karaoke event', '08', 'see you then'), thread('Room K for October 15 | Karaoke event', '03', 'the rental will be $500; the bar & lounge upstairs is open')];
  assert.equal(pickThread('ask about $500 bar tab', threads).thread.subject, 'October 22nd | Karaoke event');
});
