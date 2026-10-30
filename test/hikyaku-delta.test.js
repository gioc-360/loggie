import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { draftText, findSent, recentEdits, recentMarkdown, recordDeltas, renderDiff, sentText, taskDirectoriesUnder, wordDiff, writeRecentVoice } from '../src/hikyaku/delta.js';
import { mergeQuoted } from '../src/hikyaku/sent-mail.js';

const ME = 'sam@school.edu';

test('measures what the user changed, word by word, and how much', () => {
  const diff = wordDiff('Hi Lena, would Friday work for a coffee chat?', 'Hi Lena, would Friday Oct 9 work for a quick coffee chat?');
  assert.deepEqual([diff.kept, diff.added, diff.removed, diff.draftWords], [9, 3, 0, 9]);
  assert.equal(diff.editRatio, 0.333);
  assert.equal(renderDiff(diff.ops), 'Hi Lena, would Friday {+Oct 9+} work for a {+quick+} coffee chat?');
  assert.equal(wordDiff('same words', 'same words').editRatio, 0);
});

test('compares only what the user wrote: no header lines, no signature, no quoted thread', () => {
  assert.equal(draftText('**To:** Lena <e@acmebank.com>\n**Subject:** Re: chat\n\nHi Lena,\nFriday?\n\nBest regards,\nGio Doe\nMBA Candidate'), 'Hi Lena,\nFriday?');
  assert.equal(sentText('Hi Lena,\nFriday works.\n\nBest,\nGio\n\nOn Mon, Lena wrote:\n> old'), 'Hi Lena,\nFriday works.');
});

test('finds the sent copy even when the only trace is the user\'s words quoted in the reply', async () => {
  const thread = { subject: 'Coffee chat', messages: [
    { from: 'Yuki <yuki@school.edu>', to: ME, timestamp: '2026-10-02T15:00:00.000Z', body: 'Great, see you then!\n\nOn Thu, Oct 1, 2026 at 9:15 AM Gio Doe <sam@school.edu> wrote:\n> Hi Yuki, Wednesday morning at Breazzano works.\n' },
  ] };
  mergeQuoted([thread], ME);
  const found = findSent({ reply: { to: 'yuki@school.edu', subject: 'Re: Coffee chat' }, draftedAt: '2026-10-01T04:29:00.000Z', threads: [thread], ownAddress: ME });
  assert.equal(found.message.source, 'quoted');
  assert.equal(findSent({ reply: { to: 'yuki@school.edu', subject: 'Re: Coffee chat' }, draftedAt: '2026-10-03T00:00:00.000Z', threads: [thread], ownAddress: ME }), null, 'a message older than the draft is not its sent copy');

  const home = await mkdtemp(join(tmpdir(), 'hikyaku-delta-'));
  const task = join(home, 'work', 'coffee', 'task_1');
  await mkdir(task, { recursive: true });
  await writeFile(join(task, 'DRAFT.md'), '**To:** Yuki <yuki@school.edu>\n\nHi Yuki, Wednesday morning works.\n\nBest regards,\nGio');
  await writeFile(join(task, 'REPLY.json'), JSON.stringify({ to: 'yuki@school.edu', subject: 'Re: Coffee chat' }));
  const drafted = new Date('2026-10-01T04:29:00Z'); await utimes(join(task, 'DRAFT.md'), drafted, drafted);
  const dirs = await taskDirectoriesUnder(join(home, 'work'));
  const [entry] = await recordDeltas({ taskDirectories: dirs, threads: [thread], ownAddress: ME, home });
  assert.equal(entry.source, 'quoted in their reply');
  assert.match(await readFile(join(task, 'DELTA.md'), 'utf8'), /\{\+at Breazzano\+\}/);
  assert.equal((await recordDeltas({ taskDirectories: dirs, threads: [thread], ownAddress: ME, home })).length, 0, 'recorded once');
  assert.equal((await readFile(join(home, 'deltas.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('reads the target from an older draft\'s own header when REPLY.json is missing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-delta-old-'));
  const task = join(home, 'work', 'club', 'task_2');
  await mkdir(task, { recursive: true });
  await writeFile(join(task, 'DRAFT.md'), '**To:** Ski Club <ski@example.com>\n**Subject:** Re: Trip\n\nCount me in for the trip.');
  const drafted = new Date('2026-10-01T00:00:00Z'); await utimes(join(task, 'DRAFT.md'), drafted, drafted);
  const thread = { subject: 'Trip', messages: [{ from: ME, to: 'Ski Club <ski@example.com>', timestamp: '2026-10-01T12:00:00.000Z', body: 'Count me in for the Tremblant trip.' }] };
  const [entry] = await recordDeltas({ taskDirectories: [task], threads: [thread], ownAddress: ME, home });
  assert.equal(entry.to, 'ski@example.com');
  assert.equal(entry.source, 'Gmail Sent');
  assert.equal(entry.added, 1);
});


test('the newest edits set the voice: newest first, unchanged sends skipped, at most three', async () => {
  const entry = (sentAt, draft, sent, to = 'a@b.com') => ({ sentAt, to, subject: 'Re: chat', draft, sent, editRatio: wordDiff(draft, sent).editRatio });
  const entries = [
    entry('2026-09-01T00:00:00Z', 'I hope this email finds you well. Friday works.', 'Friday works.'),
    entry('2026-10-02T00:00:00Z', 'Thursday works.', 'Thursday works.'),
    entry('2026-09-20T00:00:00Z', 'Happy to connect at your convenience.', 'Happy to connect.'),
    entry('2026-09-25T00:00:00Z', 'Great to meet you.', 'Great meeting you today.'),
    entry('2026-09-28T00:00:00Z', 'Per my last email, Monday?', 'Monday?'),
  ];
  const picked = recentEdits(entries);
  assert.deepEqual(picked.map((e) => e.sentAt.slice(0, 10)), ['2026-09-28', '2026-09-25', '2026-09-20'], 'newest first, the unchanged send skipped, the oldest dropped');
  const markdown = recentMarkdown(picked);
  assert.ok(markdown.indexOf('2026-09-28') < markdown.indexOf('2026-09-25'));
  assert.match(markdown, /You cut \(do not write these again\): "Per my last email,"/);
  assert.doesNotMatch(markdown, /finds you well/, 'an edit older than the newest three does not set the voice');
  assert.match(recentMarkdown([]), /No edits yet/);

  const home = await mkdtemp(join(tmpdir(), 'hikyaku-recent-'));
  assert.equal(await writeRecentVoice(home), 0, 'no deltas file yet is zero edits, not an error');
  assert.match(await readFile(join(home, 'voice', 'recent.md'), 'utf8'), /No edits yet/);
  await writeFile(join(home, 'deltas.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  assert.equal(await writeRecentVoice(home), 3);
  assert.match(await readFile(join(home, 'voice', 'recent.md'), 'utf8'), /^## 2026-09-28/m);
});

test('an edited new email is still learned from: matched by recipient, its subject change recorded', async () => {
  const { findSentByRecipient, recentMarkdown } = await import('../src/hikyaku/delta.js');
  const sentMail = [
    { id: 'a', subject: 'Unrelated', timestamp: '2026-10-04T10:00:00.000Z', to: ['prof@example.edu'], body: 'old' },
    { id: 'b', subject: 'Request to be remote for Oct 6 class (leg injury) | Sam Doe', timestamp: '2026-10-04T16:00:00.000Z', to: ['prof@example.edu'], body: 'Could I join remotely?' },
    { id: 'c', subject: 'Later', timestamp: '2026-10-05T16:00:00.000Z', to: ['prof@example.edu'], body: 'later' },
  ];
  const found = findSentByRecipient({ reply: { to: 'Prof@example.edu', subject: 'NBA 5110: missing class Oct 6' }, draftedAt: '2026-10-04T12:00:00.000Z', sentMail });
  assert.equal(found.message.id, 'b', 'the first send to that person after the draft, whatever its subject');
  assert.equal(findSentByRecipient({ reply: { to: 'other@example.edu' }, draftedAt: '2026-10-04T12:00:00.000Z', sentMail }), null);
  const md = recentMarkdown([{ sentAt: '2026-10-04', to: 'prof@example.edu', subject: 'NBA 5110: missing class Oct 6', sentSubject: 'Request to be remote for Oct 6 class (leg injury) | Sam Doe',
    draft: 'My name is Sam Doe, a student in your class. Could you let me know how to catch up?', sent: 'Could I join remotely?' }]);
  assert.match(md, /Subject: you changed "NBA 5110: missing class Oct 6" to "Request to be remote/);
  assert.match(md, /You cut \(do not write these again\): .*My name is Sam Doe/);
});

test('when the signature starts with a sign-off, the draft does not add a second one', async () => {
  const { withoutSignOff } = await import('../src/hikyaku/draft.js');
  assert.equal(withoutSignOff('Hi,\n\nCould I join remotely?\n\nBest regards,\n'), 'Hi,\n\nCould I join remotely?');
  assert.equal(withoutSignOff('Hi,\n\nThanks for the chat.\n\nThank you,'), 'Hi,\n\nThanks for the chat.\n\nThank you,', 'a closing thank-you stays');
});

test('a reply only matches a sent email on its own thread, and an unreadable sent copy teaches nothing', async () => {
  const { findSentByRecipient } = await import('../src/hikyaku/delta.js');
  const sentMail = [{ id: 'x', subject: 'Something else', timestamp: '2026-10-04T13:00:00.000Z', to: ['jo@example.edu'], body: 'hi' },
    { id: 'y', subject: 'RE: Connect to Gmail', timestamp: '2026-10-04T13:30:00.000Z', to: ['jo@example.edu'], body: '' }];
  const reply = { to: 'jo@example.edu', subject: 'Re: Connect to Gmail', original: { from: 'jo@example.edu' } };
  assert.equal(findSentByRecipient({ reply, draftedAt: '2026-10-04T12:00:00.000Z', sentMail }).message.id, 'y');
  assert.equal(findSentByRecipient({ reply: { ...reply, subject: 'Re: Other' }, draftedAt: '2026-10-04T12:00:00.000Z', sentMail }), null);
});
