import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callStepsFor, excerpt, lastOtherSender, latestFor, moveKindOf, movesFor, readThreads, threadMessages, waitingOnFor } from '../src/hikyaku/screen-depth.js';

const THREAD = `# Introductions

## Ana Recruiter <ana@bank.example> · 2026-10-08T15:00:00.000Z
To: Me <me@uni.example>

Happy to set up a chat. Could you send two times that work next week?

## me@uni.example · 2026-10-08T16:00:00.000Z
To: Ana Recruiter <ana@bank.example>

Thanks Ana, Tuesday or Wednesday afternoon works.

Links in this email (hikyaku never opens them):
- calendar -> example.com
`;

test('moves: open ones in order, without running, blocked, done or snoozed; reply moves marked waiting', () => {
  const tasks = [
    { id: 'a', title: 'Reply to Ana', status: 'open', sourceId: 't1:reply', dueAt: '2026-10-15T00:00:00Z' },
    { id: 'b', title: 'Prep', status: 'running' },
    { id: 'c', title: 'Done one', status: 'done' },
    { id: 'd', title: 'Snoozed', status: 'open' },
    { id: 'e', title: 'Apply', status: 'waiting', sourceId: 't2:apply' },
  ];
  assert.deepEqual(movesFor(tasks, new Set(['d'])), [
    { id: 'a', title: 'Reply to Ana', due: '2026-10-15', waiting: true, kind: 'reply' },
    { id: 'e', title: 'Apply', due: null, waiting: false, kind: 'apply' },
  ]);
  assert.deepEqual(['t:reply', 't:prep', 't:email:rowena-patel', 't:move', 'call:c#1', 'callstep:c:x', 'owed:c:x', 'manual-1', undefined].map(moveKindOf),
    ['reply', 'prep', 'email', 'move', 'call', 'call', 'owed', null, null]);
  assert.equal(movesFor(Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: 'x', status: 'open' }))).length, 5);
});

test('a THREAD.md parses into messages without To lines or the links list', () => {
  const messages = threadMessages(THREAD);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { name: 'Ana Recruiter', address: 'ana@bank.example', at: '2026-10-08T15:00:00.000Z', body: 'Happy to set up a chat. Could you send two times that work next week?' });
  assert.equal(messages[1].address, 'me@uni.example');
  assert.doesNotMatch(messages[1].body, /Links in this email|calendar ->/);
  assert.equal(threadMessages('## "Kim J." <a@b.example> · 2026-10-06T10:00:00Z\n\nHi')[0].name, 'Kim J.');
});

test('who a move waits on is the newest sender who is not the user', () => {
  assert.equal(lastOtherSender(THREAD, ['ME@uni.example']), 'Ana Recruiter');
  assert.deepEqual(waitingOnFor([{ id: 'a', waiting: true }, { id: 'b', waiting: false }, { id: 'c', waiting: true }], (id) => (id === 'b' ? '' : THREAD), ['me@uni.example']), ['Ana Recruiter']);
});

test('an excerpt collapses spaces and cuts at a word', () => {
  assert.equal(excerpt('one  two\nthree'), 'one two three');
  assert.equal(excerpt('alpha beta gamma delta', 12), 'alpha beta…');
});

test('latest: newest email items matched to their thread by subject, one per subject, the newest message not the user', () => {
  const items = [
    { source: 'outlook', title: 'RE: Introductions', at: '2026-10-08T16:00:00.000Z', who: [{ name: '', address: 'ana@bank.example' }] },
    { source: 'gmail', title: 'Introductions', at: '2026-10-08T15:00:00.000Z', who: [] },
    { source: 'call', title: 'Chat', at: '2026-10-09T15:00:00.000Z', who: [] },
    { source: 'gmail', title: 'Scheduling', at: '2026-10-07T15:00:00.000Z', who: [{ name: 'HR', address: 'hr@bank.example' }] },
  ];
  const out = latestFor({ items, threads: [{ subject: 'Introductions', markdown: THREAD }], own: ['me@uni.example'] });
  assert.equal(out.length, 2);
  assert.equal(out[0].who, 'Ana Recruiter');
  assert.match(out[0].excerpt, /^Happy to set up a chat/);
  assert.deepEqual(out[1], { source: 'gmail', title: 'Scheduling', at: '2026-10-07T15:00:00.000Z', who: 'HR', excerpt: null });
});

test('readers: threads under a folder; the newest routed call gives its next steps; no call gives null', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-depth-'));
  await mkdir(join(home, 'work', 'bank', 't1'), { recursive: true });
  await writeFile(join(home, 'work', 'bank', 't1', 'THREAD.md'), THREAD);
  const threads = await readThreads(join(home, 'work', 'bank'));
  assert.equal(threads[0].subject, 'Introductions');
  await mkdir(join(home, 'calls', '2026-10-09-1258-chat'), { recursive: true });
  await writeFile(join(home, 'calls', '2026-10-09-1258-chat', 'summary-nebius.md'), '# Chat\n\nFor your goal: get the offer\n\n## Next steps\n- Send a thank-you note (Gio)\n- Book the next chat\n');
  const steps = await callStepsFor({ home, items: [{ source: 'call', thread: '2026-10-09-1258-chat', title: 'Chat', at: '2026-10-09T17:00:00.000Z' }] });
  assert.equal(steps.title, 'Chat');
  assert.ok(steps.lines.some((l) => /thank-you/.test(l)));
  assert.equal(await callStepsFor({ home, items: [] }), null);
  assert.deepEqual(await readThreads(null), []);
});

// loggie-class-notes I3 (spec 1.6): a class's notes keep "Student N" on disk; the wide card shows the names from the
// map of the pair the notes were made from, as callDetail does. Made-up people only.
test('a class call\'s next steps on the wide card read with the names; the file keeps the labels', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-depth-class-'));
  const folder = join(home, 'calls', '2026-10-06-0905-strt-5010');
  await mkdir(folder, { recursive: true });
  const notes = '# STRT 5010\n\nFor your goal: learn pricing\n\n## Next steps\n- Send Student 2 the pricing slides (Gio) [12:04]\n- Ask Students 1 and 3 for the case data\n- Book a room for Student 9\n';
  await writeFile(join(folder, 'summary-nebius.md'), notes);
  await writeFile(join(folder, 'held.json'), JSON.stringify({ counts: { sent: 9, held: 0, masked: { labels: 3, mentions: 5 } }, names: {
    'Student 1': { name: 'Wren Halvorsen', forms: ['Wren Halvorsen', 'Wren'], unclear: false, likely: null, rule: 'invitee', at: 0 },
    'Student 2': { name: 'Odile', forms: ['Odile'], unclear: true, likely: null, rule: 'unclear-name', at: 4 },
    'Student 3': { name: 'Tamsin', forms: ['Tamsin'], unclear: false, likely: null, rule: 'addressed', at: 7 },
  } }));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ provider: 'nebius', output: 'summary-nebius.md', checks: [], privacy: { held_file: 'held.json', classmates: 3 } }]));
  const steps = await callStepsFor({ home, items: [{ source: 'call', thread: '2026-10-06-0905-strt-5010', title: 'STRT 5010', at: '2026-10-06T13:05:00.000Z' }] });
  assert.deepEqual(steps.lines, ['For your goal: learn pricing', 'Send Odile the pricing slides (Gio)', 'Ask Wren Halvorsen and Tamsin for the case data', 'Book a room for Student 9']);
  assert.match(await readFile(join(folder, 'summary-nebius.md'), 'utf8'), /Send Student 2 the pricing slides/, 'the notes file keeps the labels');
});
