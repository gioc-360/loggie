// A draft never states a time or date Loggie did not read (loggie-intros fix 2, 2026-10-20). The real case: "email
// rowena of my availability friday"; Rowena had asked for "a couple of time slots that work for you on Friday";
// nothing read the calendar; the cloud AI wrote "I am available Friday after 2pm", which was false. Made-up addresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEmailReply } from '../src/hikyaku/ask-reply.js';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { threadsFrom } from '../src/hikyaku/ask-thread.js';

const rowena = {
  id: 'apple-mail-296413', from: 'Patel, Rowena <rpatel5@bank.example>', to: 'me@school.example', cc: '',
  subject: "RE: EA Applicant | Gio Caballero Cornell MBA '27", timestamp: '2026-10-20T14:29:10.000Z',
  body: 'Hi Gio,\n\nThank you so much for reaching out! I am glad to chat and can you share a couple of time slots that work for you on Friday.\n\nBest,\n\nRowena Patel',
};
const answer = (body) => async () => JSON.stringify({ body });

async function draft(body, { line = 'Of my availability friday', typed = 'email rowena of my availability friday', calendar = null, message = rowena } = {}) {
  const taskDirectory = await mkdtemp(join(tmpdir(), 'draft-times-'));
  const prepared = await prepareEmailReply({ taskDirectory, message, email: 'rpatel5@bank.example', account: 'me@school.example', line, typed, cloud: 'ai', complete: answer(body), calendar });
  return { ...prepared, file: await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8') };
}

test('the Rowena case: "after 2pm" with no calendar read becomes [your times], Friday kept', async () => {
  const out = await draft('Hi Rowena,\n\nI am available Friday after 2pm.\n\nBest,');
  assert.doesNotMatch(out.body, /2\s*pm/i);
  assert.match(out.body, /I am available Friday \[your times\]\./);
  assert.match(out.file, /\[your times\]/);
  assert.equal(out.times?.note, 'Loggie did not check your calendar for times; add them before sending.');
});

test('a time quoted in the thread is kept', async () => {
  const message = { ...rowena, body: 'Hi Gio, would Friday at 2:30 pm work for a call?' };
  const out = await draft('Hi Rowena,\n\nFriday at 2:30 pm works for me.\n\nBest,', { line: 'yes that works', typed: 'email rowena yes that works', message });
  assert.match(out.body, /Friday at 2:30 pm works/);
  assert.doesNotMatch(out.body, /\[your times\]/);
  assert.equal(out.times?.note || '', '');
});

test('a time the user typed is kept', async () => {
  const out = await draft('Hi Rowena,\n\nI am free Friday from 2 to 4pm.\n\nBest,', { line: 'free friday 2-4pm', typed: 'email rowena free friday 2-4pm' });
  assert.match(out.body, /from 2 to 4pm/);
  assert.doesNotMatch(out.body, /\[your times\]/);
});

test('a time from calendar data passed in is kept', async () => {
  const calendar = [{ title: 'Free', start: new Date(2026, 9, 23, 14, 0).toISOString(), end: new Date(2026, 9, 23, 15, 0).toISOString() }];
  const out = await draft('Hi Rowena,\n\nI am available Friday at 2pm.\n\nBest,', { calendar });
  assert.match(out.body, /Friday at 2pm/);
  assert.doesNotMatch(out.body, /\[your times\]/);
});

test('the ask box run: a draft holding [your times] is held, never pasted; the typed time fills it and it opens (loggie-reply-yes)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'draft-times-run-'));
  const entries = [{ name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rpatel5@bank.example', last: rowena.timestamp }];
  const events = [];
  const asker = createAsker({
    home, loadIndex: async () => entries, openChat: async () => ({ opened: 'none', mode: 'failed' }), emit: (kind, data) => events.push([kind, data]),
    email: {
      threads: async (address) => threadsFrom([rowena], address, ['me@school.example']),
      consent: async () => true, allowAlways: async () => {},
      complete: answer('Hi Rowena,\n\nI am available Friday after 2pm.\n\nBest,'),
      openDraft: async ({ taskDirectory }) => { opened.push(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8')); return { opened: 'outlook', mode: 'reply', detail: '' }; },
      settings: async () => ({ signName: '', account: 'me@school.example' }),
    },
  });
  const opened = [];
  const { done } = asker.run('email rowena of my availability friday');
  const result = await done;
  assert.deepEqual([result.outcome, result.status], ['question', 'needs-time']);
  assert.equal(opened.length, 0, 'nothing reaches Outlook while the draft has a gap');
  assert.match(result.results[0].body, /Friday \[your times\]/);
  assert.ok(result.lines.includes('Loggie did not check your calendar for times; add them before sending.'), result.lines.join(' | '));
  const drafted = events.find(([kind]) => kind === 'draft')?.[1];
  assert.match(drafted.body, /\[your times\]/);
  assert.doesNotMatch(drafted.body, /2pm/);
  // The typed time goes where the gap was ("at" after a word), and only then does the draft open.
  const filled = await asker.fill(result.askId, '2pm');
  assert.equal(filled.outcome, 'placed');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /I am available Friday at 2pm\./);
  assert.doesNotMatch(opened[0], /\[your times\]/);
  assert.equal((await asker.fill(result.askId, '3pm')).outcome, 'failed', 'a filled draft is not filled twice');
});

test('fill: a time with its own word keeps it, and a draft no run held is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'draft-times-fill-'));
  const entries = [{ name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rpatel5@bank.example', last: rowena.timestamp }];
  const opened = [];
  const asker = createAsker({
    home, loadIndex: async () => entries, openChat: async () => ({ opened: 'none', mode: 'failed' }),
    email: {
      threads: async (address) => threadsFrom([rowena], address, ['me@school.example']),
      consent: async () => true, allowAlways: async () => {},
      complete: answer('Hi Rowena,\n\nI am available Friday at 2pm.\n\nBest,'),
      openDraft: async ({ taskDirectory }) => { opened.push(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8')); return { opened: 'outlook', mode: 'reply', detail: '' }; },
      settings: async () => ({ signName: '', account: 'me@school.example' }),
    },
  });
  const result = await asker.run('email rowena of my availability friday').done;
  assert.equal((await asker.fill(result.askId, 'after 2pm')).outcome, 'placed');
  assert.match(opened[0], /I am available Friday after 2pm\./);
  assert.equal((await asker.fill('2026-10-21-nothere', '2pm')).outcome, 'failed');
});

test('the guard leaves numbers that are not times alone, and takes out a date and an unread day with its time', async () => {
  const { guardTimes } = await import('../src/hikyaku/draft-times.js');
  const plain = 'Can I get 2 more days? The $500 bar tab is for 20-30 people. Call me at +1 555 010 2596. We met in 2026 for 3 hours.';
  assert.deepEqual(guardTimes(plain, { thread: '', typed: 'can i get 2 more days' }), { text: plain, removed: [], note: '' });
  const out = guardTimes('Hi,\n\nHow about Thursday, Oct 24 at 3:30 pm or 4pm? I can also do Friday morning.\n\nBest,', { thread: 'Can we meet this week?', typed: 'email jamie ask to meet friday' });
  assert.equal(out.text, 'Hi,\n\nHow about [your times]? I can also do Friday morning.\n\nBest,');
  assert.deepEqual(out.removed, ['Thursday, Oct 24 at 3:30 pm or 4pm']);
  // read in the thread: the day and the date stay
  assert.equal(guardTimes('See you Oct 24 at 10am.', { thread: 'Does Oct 24 at 10:00 AM work?' }).text, 'See you Oct 24 at 10am.');
});

test('a move draft (Draft it on Nebius): a time in CALENDAR.md is kept, one from nowhere becomes [your times]', async () => {
  const { guardDraftTimes } = await import('../src/hikyaku/nebius-draft.js');
  const roomTask = await mkdtemp(join(tmpdir(), 'draft-times-room-'));
  await writeFile(join(roomTask, 'THREAD.md'), '# Coffee chat\n\n## Rowena <r@bank.example> · 2026-10-20T14:29:10.000Z\n\nCan you share a couple of time slots that work for you on Friday?\n');
  await writeFile(join(roomTask, 'BRIEF.md'), 'Offer Friday at 4pm.');
  const answer = { ok: true, file: 'DRAFT.md', content: 'Hi Rowena,\n\nFriday at 2:00 PM works, or after 4pm.\n\nBest,', subject: '', skipSteps: [] };
  const bare = await guardDraftTimes(roomTask, answer);
  assert.equal(bare.answer.content, 'Hi Rowena,\n\nFriday [your times] works, or [your times].\n\nBest,');
  assert.equal(bare.note, 'Loggie did not check your calendar for times; add them before sending.');
  await writeFile(join(roomTask, 'CALENDAR.md'), '# Calendar, next 7 days\n\nOpen for 30 minutes, weekdays 9:00 AM-5:00 PM (America/New_York):\n  Fri 10/23: 1:00 PM-3:00 PM\n\nOffer these:\n  Friday, Oct 23, 2:00 PM EDT\n');
  const withCalendar = await guardDraftTimes(roomTask, answer);
  assert.equal(withCalendar.answer.content, 'Hi Rowena,\n\nFriday at 2:00 PM works, or [your times].\n\nBest,');
  assert.match(withCalendar.note, /not in the thread or your calendar/);
});

test('Draft it through the ask box (do-it.js askMove): the move says the calendar was not checked', async () => {
  const { askMove } = await import('../src/hikyaku/do-it.js');
  const { mkdir } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'draft-times-move-'));
  const taskDirectory = join(home, 'task');
  await mkdir(join(home, 'asks', '2026-10-20-abcdef12'), { recursive: true });
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(home, 'asks', '2026-10-20-abcdef12', 'REPLY.json'), JSON.stringify({ to: 'rpatel5@bank.example', subject: 'Re: Coffee chat' }));
  await writeFile(join(home, 'asks', '2026-10-20-abcdef12', 'DRAFT.md'), 'Hi Rowena,\n\nI am available Friday [your times].\n');
  const note = 'Loggie did not check your calendar for times; add them before sending.';
  const ask = async () => ({ askId: '2026-10-20-abcdef12', outcome: 'placed', lines: [note], did: [], results: [{ to: 'Rowena Patel', app: 'outlook', outcome: 'placed', note }] });
  const state = await askMove({ taskDirectory, home, reply: { ask: { line: 'email rowena of my availability friday', to: 'Rowena Patel' } }, ask });
  assert.equal(state.phase, 'in-mail-app');
  assert.ok(state.detail.endsWith(note), state.detail);
});
