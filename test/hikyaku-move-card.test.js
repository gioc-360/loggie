import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askLineOf, callNoteFor, cleanBody, moveApp, moveDetail, notSureOf, readDueDates, saidFor, setDueDate } from '../src/hikyaku/move-card.js';

const MIME = `--_000_DS0PR04MB8723C64045941BA67AA158C3EE882DS0PR04MB8723namp_
Content-Transfer-Encoding: quoted-printable
Content-Type: text/plain; charset=us-ascii
\tcharset=us-ascii
Morning Gio,
Happy Monday. Appreciate the follow up as I was OOO that week! Your message=
 must've gotten lost. I=92m free Friday.
Best,
Lena
On Mon, Oct 5, 2026 at 8:00 AM Gio wrote:
> Hi Lena, following up`;

test('cleanBody: undoes quoted-printable, drops MIME lines, stops at the quoted history', () => {
  const body = cleanBody(MIME);
  assert.match(body, /^Morning Gio,/);
  assert.match(body, /Your message must've gotten lost\. I’m free Friday\./);
  assert.doesNotMatch(body, /Content-|charset|--_000|following up|wrote:/);
  assert.equal(cleanBody('Sounds good = see you then'), 'Sounds good = see you then');
});

test('saidFor: the last two messages, oldest first, marked mine or theirs', () => {
  const thread = `# RE: Coffee

## Me <me@school.example> · 2026-10-03T00:44:07.000Z

To: "Reed, Jamie" <jamie@bank.example>

Hi Jamie, thank you again for the chat.

## "Reed, Jamie" <jamie@bank.example> · 2026-10-05T14:16:22.000Z

To: Me <me@school.example>

Thanks for sending! I just sent the recruiter an email.

## You · 2026-10-06T10:00:00.000Z

great, thanks`;
  const said = saidFor(thread, ['me@school.example']);
  assert.deepEqual(said.map((m) => [m.who, m.name, m.text]), [['them', 'Reed, Jamie', 'Thanks for sending! I just sent the recruiter an email.'], ['me', 'You', 'great, thanks']]);
  assert.equal(saidFor(thread, ['me@school.example'], 3)[0].who, 'me');
  assert.deepEqual(saidFor(''), []);
});

test('moveApp: a chat opens in its own app, mail in the mail app from settings', () => {
  assert.equal(moveApp({ app: 'whatsapp' }), 'whatsapp');
  assert.equal(moveApp({ app: 'messages' }, 'apple-mail'), 'messages');
  assert.equal(moveApp({ to: 'a@b.example' }, 'apple-mail'), 'apple-mail');
  assert.equal(moveApp({ to: 'a@b.example' }, 'gmail'), 'apple-mail', 'a gmail saved before 2026-10-28 is Apple Mail');
  assert.equal(moveApp(null), 'outlook');
  assert.equal(moveApp({}, 'something'), 'outlook');
});

test('callNoteFor: the call title and its first step for the user', () => {
  const call = '# Call: Gio / Lena: bank chat\n- For your goal: get the offer\n- Ask HR for other roles (Gio)\n- Prep the story (Gio)';
  assert.deepEqual(callNoteFor(call), { title: 'Gio / Lena: bank chat', step: 'Ask HR for other roles (Gio)', folder: null });
  assert.equal(callNoteFor('no call here'), null);
  // fileCall's header names the call folder, so the move can open its call on the Notes & Meetings tab
  const filed = '# Call: Weekly sync\n\n2026-10-09 · with Lena · one-on-one\nRecording and transcript: /x/calls/2026-10-09-1300-weekly-sync\n\n- Send the deck (Me)';
  assert.equal(callNoteFor(filed).folder, '2026-10-09-1300-weekly-sync');
});

test('notSureOf: a call step Loggie was not sure of keeps its reason in BRIEF.md', () => {
  assert.equal(notSureOf('# Send the deck\n\n## Check\n- Not sure: quote not found in transcript\n'), 'quote not found in transcript');
  assert.equal(notSureOf('# Send the deck\n\n## Rules\n- Never send email.'), null);
});

test('moveDetail and due dates: read from the move folder; a new date is kept, cleared, and checked', async () => {
  const home = await mkdtemp(join(tmpdir(), 'move-card-'));
  const task = join(home, 'task_1');
  await mkdir(task);
  await writeFile(join(task, 'REPLY.json'), JSON.stringify({ app: 'messages', to: 'Jonah', chatId: '7' }));
  await writeFile(join(task, 'THREAD.md'), '# Jonah\n\n## Jonah · 2026-10-08T23:18:45.000Z\n\nHit me up Sunday evening\n\n## You · 2026-10-08T23:20:36.000Z\n\nsounds good!');
  const detail = await moveDetail(task);
  assert.equal(detail.app, 'messages');
  assert.equal(detail.to, 'Jonah');
  assert.deepEqual(detail.said.map((m) => m.text), ['Hit me up Sunday evening', 'sounds good!']);
  assert.equal(detail.call, null);
  assert.deepEqual(await moveDetail(join(home, 'missing')), { app: 'outlook', to: null, sendable: true, said: [], call: null, notSure: null, askLine: null, from: null, also: [] });
  assert.equal((await moveDetail(task, { services: new Map([['7', 'SMS']]) })).sendable, false);

  const asked = join(home, 'task_2');
  await mkdir(asked);
  await writeFile(join(asked, 'REPLY.json'), JSON.stringify({ ask: { line: 'email KHouse: ask about $500 bar tab', to: 'KHouse', ask: 'ask about $500 bar tab' }, fromChat: { app: 'messages', chatId: '9' } }));
  const fromText = await moveDetail(asked, { mailApp: 'outlook' });
  assert.equal(fromText.askLine, 'ask about $500 bar tab', 'the line box opens with what the text asked');
  assert.equal(fromText.app, 'outlook', 'an email move opens in the mail app, not the chat it came from');
  assert.equal(detail.askLine, null, 'a chat reply has no ask line');
  assert.equal(askLineOf({ ask: { ask: '  ' } }), null);

  await setDueDate(home, 'task_1', '2026-10-11');
  assert.deepEqual(await readDueDates(home), { task_1: '2026-10-11' });
  await setDueDate(home, 'task_1', null);
  assert.deepEqual(await readDueDates(home), {});
  await assert.rejects(setDueDate(home, 'task_1', 'Sunday'), /must look like/);
});

test('callLinesFor: a move made from a call shows the summary lines closest to its title, with section and time', async () => {
  const { callLinesFor, callSummaryFor } = await import('../src/hikyaku/move-card.js');
  const summary = `# App: what to do next
## Priority definitions and timeline [11:59]
- P0 = production issue, fix by end of day; target: 3 days, before fall break [10:46]
## Enterprise positioning [27:24]
- Get enterprise users after fall break for testing [25:08]
## Next Steps
- Build work stream (strategic) and next move (tactical) features (not sure) [16:32]`;
  assert.deepEqual(callLinesFor(summary, 'Complete all P0 items before fall break'),
    [{ section: 'Priority definitions and timeline', text: 'P0 = production issue, fix by end of day; target: 3 days, before fall break', time: '10:46' }]);
  assert.equal(callLinesFor(summary, 'Develop work streams (strategic) and next move (tactical)')[0].section, 'Next Steps');
  assert.deepEqual(callLinesFor(summary, 'Buy groceries'), []);
  assert.deepEqual(callLinesFor('', 'P0'), []);
  const home = await mkdtemp(join(tmpdir(), 'move-card-'));
  const found = await callSummaryFor(home, 'callstep:2026-10-09-1912-app:complete-p0', async (folder) => (folder.endsWith(join('calls', '2026-10-09-1912-app')) ? summary : null));
  assert.deepEqual([found.title, found.at], ['App: what to do next', '2026-10-09']);
  assert.equal(await callSummaryFor(home, 'thread-1:reply', async () => summary), null);
  assert.equal(await callSummaryFor(home, 'callstep:../etc:x', async () => summary), null);
});

test('macCanSend and readChatServices: a Messages chat on SMS or RCS is read-only here; iMessage, WhatsApp and mail send', async () => {
  const { macCanSend, readChatServices } = await import('../src/hikyaku/move-card.js');
  const services = new Map([['7', 'SMS'], ['8', 'RCS'], ['9', 'iMessage']]);
  assert.equal(macCanSend({ app: 'messages', chatId: '7' }, services), false);
  assert.equal(macCanSend({ app: 'messages', chatId: 8 }, services), false);
  assert.equal(macCanSend({ app: 'messages', chatId: '9' }, services), true);
  assert.equal(macCanSend({ app: 'whatsapp', chatId: '7' }, services), true);
  assert.equal(macCanSend({ to: 'a@b.example' }, services), true);
  assert.equal(macCanSend(null, services), true);
  assert.equal(macCanSend({ app: 'messages', chatId: '7' }), true, 'an unreadable chat list grays nothing out');
  const read = await readChatServices({ execImpl: async (bin, args) => { assert.deepEqual(args.slice(0, 2), ['-readonly', '-json']); return { stdout: JSON.stringify([{ id: 7, service: 'SMS' }, { id: 9, service: 'iMessage' }]) }; } });
  assert.deepEqual([...read], [['7', 'SMS'], ['9', 'iMessage']]);
  assert.equal((await readChatServices({ execImpl: async () => { throw new Error('locked'); } })).size, 0);
});
