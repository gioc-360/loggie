import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// These tests are about the run, not the cloud gate (test/hikyaku-cloud-gate.test.js): the gate approves.
const APPROVED = async () => ({ ok: true, allowed: new Set(), workstream: 'test', files: [] });
import { openDraft } from '../src/hikyaku/draft.js';
import { freshnessOf, threadMessages } from '../src/hikyaku/freshness.js';
import { answerTask, openReplies, stale } from '../src/hikyaku/headless.js';

// The incident of 2026-10-05, with made-up people. The task answers the person's older email in one thread
// (THREAD.md already holds the user's own two later messages); the person then replied in a different thread, with a
// different subject, after the user's newest email to her went out from Outlook as a new message. Since 2026-10-28
// (no Gmail sign-in) the check reads Apple Mail's Inbox and Sent, the readInbox and readSent fakes below.
const PERSON = 'Sam Doe <sam@example.com>', ME = 'ana@school.example.com';
const OLD_THREAD = ['# Connect to the calendar', '',
  `## ${PERSON} · 2026-10-01T02:46:48.000Z`, `To: ${ME}`, '', 'Could you write up the calendar steps?', '',
  `## Ana Lee <${ME}> · 2026-10-04T13:31:00.000Z`, `To: ${PERSON}`, '', 'Sure, tomorrow.', '',
  `## Ana Lee <${ME}> · 2026-10-05T02:05:00.000Z`, `To: ${PERSON}`, '', 'Here are the steps.', ''].join('\n');
const ORIGINAL = { from: 'sam@example.com', date: '2026-10-01T02:46:48.000Z', subject: 'Connect to the calendar', messageId: '<a1@example.com>' };
const NEW_FROM_PERSON = { id: 'apple-mail-4', from: PERSON, to: ME, subject: 'Re: Project updates', timestamp: '2026-10-05T02:14:45.000Z', body: 'Got it, one question on step 2.' };

// An Apple Mail stand-in: what its Inbox and Sent hold, and every reply it was asked to place.
function fakeMail({ inbox = [], sent = [] } = {}) {
  const placed = [];
  return { placed,
    readInbox: async () => inbox,
    readSent: async () => sent,
    appleMailImpl: async (reply) => { placed.push(reply); return { status: 'replied' }; },
    clipboardImpl: async () => {} };
}

async function task({ thread = OLD_THREAD, settings = {} } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'hikyaku-fresh-'));
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-home-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'apple-mail', signName: 'Ana', ...settings }));
  await writeFile(join(folder, 'DRAFT.md'), 'Hi Sam,\n\nHere they are.\n\nBest regards,');
  await writeFile(join(folder, 'THREAD.md'), thread);
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: 'sam@example.com', subject: 'Re: Connect to the calendar', account: ME, original: ORIGINAL }));
  return { folder, home };
}
const nothingOpens = (opened) => (cmd, args) => { opened.push([cmd, ...args]); return { unref() {} }; };
const lastAttempt = async (folder) => JSON.parse((await readFile(join(folder, 'ATTEMPTS.jsonl'), 'utf8')).trim().split('\n').at(-1));

test('THREAD.md headers give who wrote and when', () => {
  assert.deepEqual(threadMessages(OLD_THREAD).map((m) => [m.from, m.date]), [['sam@example.com', '2026-10-01T02:46:48.000Z'], [ME, '2026-10-04T13:31:00.000Z'], [ME, '2026-10-05T02:05:00.000Z']]);
  assert.equal(threadMessages(OLD_THREAD)[0].name, 'Sam Doe');
});

test('the incident: the person replied later in another thread, so the reply is stale, nothing opens, and the reason names that thread', async () => {
  const { folder, home } = await task();
  const opened = [];
  const mail = fakeMail({ inbox: [NEW_FROM_PERSON] });
  const result = await openDraft({ taskDirectory: folder, home, ...mail, spawnImpl: nothingOpens(opened) });
  assert.deepEqual([result.opened, result.mode, result.freshness], ['none', 'stale', 'checked']);
  assert.match(result.reason, /^Sam Doe wrote again after the email this draft answers: "Re: Project updates", Oct [45] \(to your Outlook address\)\. The draft may be out of date, so nothing was opened\.$/);
  assert.deepEqual([result.newer.source, result.newer.date], ['outlook-inbox', '2026-10-05T02:14:45.000Z']);
  assert.equal(opened.length, 0, 'nothing opened');
  assert.equal(mail.placed.length, 0, 'no reply placed');
  const log = await lastAttempt(folder);
  assert.deepEqual([log.mode, log.freshness, log.newer.subject], ['stale', 'checked', 'Re: Project updates']);
  // A stale stop is not an opened draft: asking again still runs the check instead of saying "already open".
  assert.equal((await openDraft({ taskDirectory: folder, home, ...mail, spawnImpl: nothingOpens(opened) })).mode, 'stale');
});

test("the user's own newer email to the person, in another thread, makes the reply stale too", async () => {
  const { folder, home } = await task();
  const mine = { id: 'apple-mail-5', from: ME, subject: 'Project updates', timestamp: '2026-10-05T03:00:00.000Z', to: ['sam@example.com'], body: 'One more thing.' };
  const mail = fakeMail({ sent: [mine] });
  const result = await openDraft({ taskDirectory: folder, home, ...mail, spawnImpl: nothingOpens([]) });
  assert.equal(result.mode, 'stale');
  assert.match(result.reason, /^You wrote to Sam Doe after the email this draft answers: "Project updates", Oct [45]/);
  assert.equal(mail.placed.length, 0);
});

test('when the newest mail with the person is already in THREAD.md the reply is clear and goes into its thread, marked checked', async () => {
  const { folder, home } = await task();
  const opened = [];
  // Apple Mail's copy of the user's 02:05 message carries seconds the thread does not; the same minute is the same message.
  const mail = fakeMail({ inbox: [{ id: 'apple-mail-1', from: PERSON, subject: 'Connect to the calendar', timestamp: '2026-10-01T02:46:48.000Z' }],
    sent: [{ id: 'apple-mail-3', from: ME, subject: 'Re: Connect to the calendar', timestamp: '2026-10-05T02:05:41.000Z', to: ['sam@example.com'], body: 'Here are the steps.' }] });
  const result = await openDraft({ taskDirectory: folder, home, ...mail, spawnImpl: nothingOpens(opened) });
  assert.deepEqual([result.mode, result.freshness, result.status], ['reply', 'checked', 'replied']);
  assert.equal(mail.placed.length, 1);
  assert.equal((await lastAttempt(folder)).freshness, 'checked');
});

test('with no source to read (a terminal run) nothing is blocked, and the attempt line says unchecked', async () => {
  const { folder, home } = await task();
  const { appleMailImpl, clipboardImpl, placed } = fakeMail();
  const result = await openDraft({ taskDirectory: folder, home, appleMailImpl, clipboardImpl, spawnImpl: nothingOpens([]) });
  assert.deepEqual([result.mode, result.freshness], ['reply', 'unchecked'], 'the guard did not block');
  assert.equal(placed.length, 1);
  assert.equal((await lastAttempt(folder)).freshness, 'unchecked');
  const direct = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME] });
  assert.deepEqual([direct.freshness, direct.newer], ['unchecked', null]);
});

test('the explicit override opens the stale reply; the attempt line still records what was checked', async () => {
  const { folder, home } = await task();
  const mail = fakeMail({ inbox: [NEW_FROM_PERSON] });
  const result = await openDraft({ taskDirectory: folder, home, ...mail, spawnImpl: nothingOpens([]), staleOk: true });
  assert.deepEqual([result.mode, result.freshness], ['reply', 'checked']);
  assert.equal(mail.placed.length, 1);
});

test("mail the user sent from Outlook counts: a newer message to the person is stale, a copy of one the thread has is not", async () => {
  const sentLater = [{ id: 'apple-mail-1', subject: 'Loggie updates', timestamp: '2026-10-05T02:30:12.000Z', to: ['sam@example.com'], body: 'New thread from Outlook.' }];
  const result = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async ({ address, days }) => { assert.deepEqual(address, [ME], 'every address of the user, as a list (W10b)'); assert.ok(days >= 1 && days <= 30); return sentLater; } });
  assert.equal(result.freshness, 'checked');
  assert.match(result.newer.reason, /^You wrote to Sam Doe after the email this draft answers: "Loggie updates", Oct [45] \(sent from Outlook\)\./);
  const copy = [{ id: 'apple-mail-2', subject: 'Re: Connect to the calendar', timestamp: '2026-10-05T02:05:37.000Z', to: ['sam@example.com'], body: 'Here are the steps.' }];
  assert.equal((await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => copy })).newer, null);
  const toSomeoneElse = [{ id: 'apple-mail-3', subject: 'Other', timestamp: '2026-10-06T02:05:37.000Z', to: ['kim@example.com'], body: 'x' }];
  assert.equal((await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => toSomeoneElse })).newer, null);
  // W9: an email that only copied the person (an invoice forwarded to the team, the person on Cc) is not stale.
  const copiedOnly = [{ id: 'apple-mail-4', subject: 'FW: Invoice', timestamp: '2026-10-06T02:05:37.000Z', to: ['team@example.com', 'sam@example.com'], primary: ['team@example.com'], body: 'fyi' }];
  assert.equal((await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => copiedOnly })).newer, null);
  // A source that cannot be read is named, never a reason to block, and never a reason to call the thread fresh.
  const broken = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => { throw new Error('no Sent folder'); } });
  assert.deepEqual([broken.freshness, broken.newer, broken.notes], ['unchecked', null, ['Sent mail could not be checked: no Sent folder']]);
});

test('on screen a stale reply is a needs-you of kind reply-stale; only "open anyway" opens it, with the override said out loud', async () => {
  const question = stale({ reason: 'Sam Doe wrote again after the email this draft answers: "Re: Project updates", Oct 5. The draft may be out of date, so nothing was opened.' });
  assert.deepEqual([question.phase, question.kind], ['needs-you', 'reply-stale']);
  assert.match(question.question, /"Re: Project updates".*Answer "open anyway".*catch up/s);

  const root = await mkdtemp(join(tmpdir(), 'hikyaku-stale-'));
  await mkdir(join(root, 'task_1'));
  const taskDirectory = join(root, 'task_1');
  await writeFile(join(taskDirectory, 'STATE.json'), JSON.stringify({ phase: 'ready', session: 's' }));
  const calls = [];
  const openDraftImpl = async (options) => { calls.push(options); return options.staleOk ? { mode: 'reply', detail: 'Reply opened.' } : { mode: 'stale', reason: 'Sam Doe wrote again after the email this draft answers: "Re: Project updates", Oct 5. The draft may be out of date, so nothing was opened.' }; };
  const [entry] = await openReplies({ taskDirectories: [taskDirectory], open: openDraftImpl });
  assert.equal(entry.mode, 'stale');
  let state = JSON.parse(await readFile(join(taskDirectory, 'STATE.json'), 'utf8'));
  assert.deepEqual([state.phase, state.kind], ['needs-you', 'reply-stale']);

  const core = { transitionTask: async () => ({}) };
  state = await (await answerTask({ gateImpl: APPROVED,  core, task: { id: 'task_1' }, directoryPath: root, answer: 'hmm, maybe', openDraftImpl })).done;
  assert.deepEqual([state.phase, state.kind], ['needs-you', 'reply-stale']); assert.match(state.question, /Catch up on this workspace again/);
  assert.equal(calls.length, 1, 'an answer that is not "open anyway" opens nothing');

  state = await (await answerTask({ gateImpl: APPROVED,  core, task: { id: 'task_1' }, directoryPath: root, answer: 'Open anyway', openDraftImpl })).done;
  assert.equal(state.phase, 'in-mail-app');
  assert.deepEqual(calls.at(-1), { taskDirectory, again: true, staleOk: true });
});


// 2026-10-21 live check: "Accepted: Gio and Rowena chat M&T" stopped a draft to Rowena as if she had written again.
test('a calendar reply from the person after the thread is not a newer message: the draft is clear', async () => {
  const accepted = { from: PERSON, to: ME, subject: 'Accepted: Ana and Sam chat', timestamp: '2026-10-06T10:00:00.000Z', primary: [ME] };
  const readInbox = async () => [accepted];
  const result = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readInbox, now: () => new Date('2026-10-07T00:00:00Z') });
  assert.equal(result.newer, null);
  const reply = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readInbox: async () => [{ ...accepted, subject: 'Re: Connect to the calendar' }], now: () => new Date('2026-10-07T00:00:00Z') });
  assert.equal(reply.newer?.direction, 'from-person', 'a real reply still counts');
});

test('a meeting invite the user sent the person is not a newer message: the draft is clear', async () => {
  // 2026-10-23: the Zoom invite for a coffee chat ("Gio and Rowena chat M&T", sent from Outlook) stopped the thank-you
  // for that chat. An invite carries no words the draft could repeat or contradict.
  const invite = (body) => [{ id: 'apple-mail-5', subject: 'Ana and Sam chat', timestamp: '2026-10-06T10:00:00.000Z', to: ['sam@example.com'], primary: ['sam@example.com'], body }];
  const now = () => new Date('2026-10-07T00:00:00Z');
  for (const body of ['Ana Lee is inviting you to a scheduled Zoom meeting.\n\nJoin Zoom Meeting\nhttps://example.zoom.us/j/1',
    '________________\nMicrosoft Teams meeting\nJoin on your computer, mobile app or room device\nClick here to join the meeting',
    'Join with Google Meet\nmeet.google.com/abc-defg-hij']) {
    assert.equal((await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => invite(body), now })).newer, null, body.slice(0, 40));
  }
  const words = await freshnessOf({ thread: OLD_THREAD, original: ORIGINAL, me: [ME], readSent: async () => invite('Here is the Zoom link we talked about, and the deck.'), now });
  assert.equal(words.newer?.direction, 'to-person', 'an email that only mentions Zoom still counts');
});
