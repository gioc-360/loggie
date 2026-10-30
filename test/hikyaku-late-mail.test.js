// Mail and chats a store keeps late (2026-10-19): Apple Mail stored Exchange mail received 20:09 to 23:10 UTC in one
// batch after 23:10, so refreshes at 21:10, 21:20 and 21:36 saw none of it, and every later refresh's date cutoff was
// already past 21:00. "Updated Position" (received 21:00:19, ROWID 296300) was never filed. The change check now
// reads by what the store has added since it last looked (its ROWID), not by date. Made-up people, real shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SUGGEST_MAX, chatItems, checkChanges, outlookItems } from '../src/hikyaku/sources.js';
import { appendChanges, readLooked, writeLooked } from '../src/hikyaku/changes.js';
import { readInboxMail, sqliteJson } from '../src/hikyaku/sent-mail.js';

const run = promisify(execFile);
const home = () => mkdtemp(join(tmpdir(), 'loggie-late-'));
const ME = 'me@cornell.example';
const WORKSTREAMS = [
  { name: 'M&T Bank Outreach', kind: 'company', goal: '', domains: ['bank.example'], words: [], cloud: false },
  { name: 'Loggie', kind: 'project', goal: '', domains: ['loggie.dev'], words: ['loggie'], cloud: false },
  { name: 'Inbox', kind: 'inbox', goal: '', domains: [], words: [], cloud: false, inbox: true },
];
const DAY = 86400000;

// Apple Mail's Inbox as readInboxMail answers it: rows in the order Mail stored them, read `days` back from the
// clock, and only past `afterRow` when the reader is given one.
function fakeInbox(clock) {
  const stored = [];
  const asked = [];
  const readInbox = async (options) => {
    asked.push(options);
    return stored.filter((m) => Date.parse(m.timestamp) >= clock.now - options.days * DAY && (options.afterRow == null || m.row > options.afterRow))
      .map(({ row, ...m }) => ({ id: `apple-mail-${row}`, conversation: null, to: ME, cc: '', body: 'SECRET-BODY', snippet: '', source: 'outlook', ...m }));
  };
  return { stored, asked, readInbox };
}
const mail = (row, timestamp, from, subject) => ({ row, timestamp, from, subject });
async function look(dir, clock, inbox, now) {
  clock.now = Date.parse(now);
  return checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], readInbox: inbox.readInbox, now: clock.now });
}
const ids = (result, source = 'outlook') => result.items.filter((item) => item.source === source).map((item) => item.id);

test('late mail: a message Mail stores after a refresh, dated before that refresh, is filed on the next one', async () => {
  const dir = await home();
  const clock = { now: 0 };
  const inbox = fakeInbox(clock);
  inbox.stored.push(mail(296200, '2026-10-19T15:00:00.000Z', 'news@school.example', 'Campus news'));
  const first = await look(dir, clock, inbox, '2026-10-19T21:10:27.000Z');
  assert.deepEqual(ids(first), [], 'nothing from the batch is stored yet');
  // After 23:10 Mail stores the whole batch at once, the 21:00 message among it.
  inbox.stored.push(mail(296277, '2026-10-19T20:09:00.000Z', 'news@school.example', 'Library hours'),
    mail(296300, '2026-10-19T21:00:19.000Z', 'Jo Vega <jvega@bank.example>', 'Updated Position'),
    mail(296303, '2026-10-19T23:10:00.000Z', 'ana@bank.example', 'Schedule'));
  const second = await look(dir, clock, inbox, '2026-10-19T23:20:00.000Z');
  assert.deepEqual(ids(second), ['outlook:apple-mail-296300', 'outlook:apple-mail-296303']);
  assert.equal(second.items[0].workstream, 'M&T Bank Outreach'); assert.equal(second.items[0].how, 'domain');
  assert.equal((await readLooked(dir)).outlookRow, 296303);
  const third = await look(dir, clock, inbox, '2026-10-19T23:30:00.000Z');
  assert.deepEqual(third.items, []);
  assert.deepEqual(inbox.asked.at(-1), { address: [ME], days: 14, bodies: false, afterRow: 296303 });
});

test('late mail: a message already in changes.jsonl is skipped before it is routed or counted', async () => {
  const dir = await home();
  await writeLooked(dir, 'outlook', '2026-10-19T23:00:00.000Z');
  await writeLooked(dir, 'outlookRow', 100);
  await appendChanges(dir, [{ source: 'outlook', at: '2026-10-19T22:00:00Z', ref: 'apple-mail-150', title: 'Updated Position', thread: 'updated position', who: [], workstream: 'M&T Bank Outreach', how: 'domain' }]);
  const clock = { now: 0 };
  const inbox = fakeInbox(clock);
  inbox.stored.push(mail(150, '2026-10-19T22:00:00.000Z', 'jvega@bank.example', 'Updated Position'), mail(160, '2026-10-19T22:30:00.000Z', 'ana@bank.example', 'Schedule'));
  const result = await look(dir, clock, inbox, '2026-10-19T23:20:00.000Z');
  assert.deepEqual(ids(result), ['outlook:apple-mail-160']);
  assert.equal(result.counts.outlook.seen, 1);
  const direct = await outlookItems({ readInbox: inbox.readInbox, address: ME, afterRow: 100, logged: new Set(['outlook:apple-mail-150']), now: clock.now });
  assert.deepEqual(direct.items.map((item) => item.ref), ['apple-mail-160']);
  assert.equal(direct.row, 160);
});

test('late mail: the upgrade backfill reads three days once, files what was missed once, and never twice', async () => {
  const dir = await home();
  await writeLooked(dir, 'outlook', '2026-10-19T21:36:40.863Z');
  await appendChanges(dir, [{ source: 'outlook', at: '2026-10-19T23:10:00Z', ref: 'apple-mail-296303', title: 'Schedule', thread: 'schedule', who: [], workstream: 'M&T Bank Outreach', how: 'domain' }]);
  const clock = { now: 0 };
  const inbox = fakeInbox(clock);
  inbox.stored.push(mail(295000, '2026-10-15T09:00:00.000Z', 'old@bank.example', 'Older than the backfill'),
    mail(296300, '2026-10-19T21:00:19.000Z', 'Jo Vega <jvega@bank.example>', 'Updated Position'),
    mail(296303, '2026-10-19T23:10:00.000Z', 'ana@bank.example', 'Schedule'));
  const first = await look(dir, clock, inbox, '2026-10-20T13:00:00.000Z');
  assert.deepEqual(inbox.asked[0], { address: [ME], days: 4, bodies: false }, 'three days back, by date, with no cursor yet');
  assert.deepEqual(ids(first), ['outlook:apple-mail-296300']);
  assert.equal(first.items[0].workstream, 'M&T Bank Outreach');
  assert.equal((await readLooked(dir)).outlookRow, 296303);
  const second = await look(dir, clock, inbox, '2026-10-20T13:10:00.000Z');
  assert.deepEqual(second.items, [], 'the backfill does not run again');
  assert.equal(inbox.asked[1].afterRow, 296303);
  inbox.stored.push(mail(296400, '2026-10-20T13:05:00.000Z', 'ana@bank.example', 'Next step'));
  assert.deepEqual(ids(await look(dir, clock, inbox, '2026-10-20T13:20:00.000Z')), ['outlook:apple-mail-296400']);
});

test('late mail: a first run reads seven days by date and starts the cursor at the newest row it read', async () => {
  const dir = await home();
  const clock = { now: 0 };
  const inbox = fakeInbox(clock);
  inbox.stored.push(mail(40, '2026-10-12T10:00:00.000Z', 'ana@bank.example', 'Too old'), mail(41, '2026-10-18T10:00:00.000Z', 'ana@bank.example', 'Hello'));
  const result = await look(dir, clock, inbox, '2026-10-20T12:00:00.000Z');
  assert.deepEqual(inbox.asked[0], { address: [ME], days: 8, bodies: false });
  assert.deepEqual(ids(result), ['outlook:apple-mail-41']);
  assert.equal((await readLooked(dir)).outlookRow, 41);
});

test('late mail: the 14-day bound keeps a re-indexed old message with a new ROWID out', async () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  const rows = [mail(600, '2026-09-30T12:00:00.000Z', 'old@bank.example', 'Re-indexed'), mail(601, '2026-10-07T12:00:00.000Z', 'ana@bank.example', 'Thirteen days old')];
  let asked;
  // A reader that ignores `days`: the bound holds in outlookItems itself.
  const readInbox = async (options) => { asked = options; return rows.map(({ row, ...m }) => ({ id: `apple-mail-${row}`, to: ME, cc: '', source: 'outlook', ...m })); };
  const { items, row } = await outlookItems({ readInbox, address: ME, afterRow: 500, now });
  assert.deepEqual(asked, { address: ME, days: 14, bodies: false, afterRow: 500 });
  assert.deepEqual(items.map((item) => item.ref), ['apple-mail-601']);
  assert.equal(row, 601, 'the cursor still moves past the row it left out');
});

test('late mail: readInboxMail with afterRow keeps rows Mail stored later, whatever their date, never a second copy of one it had', async () => {
  const dir = await home();
  const folder = join(dir, 'Library', 'Mail', 'V10', 'MailData');
  await mkdir(folder, { recursive: true });
  const day = Math.floor(Date.parse('2026-10-19T00:00:00Z') / 1000);
  await run('/usr/bin/sqlite3', [join(folder, 'Envelope Index'), `
    create table mailboxes (ROWID integer primary key, url text);
    create table messages (ROWID integer primary key autoincrement, mailbox integer, global_message_id integer, subject_prefix text, subject integer, summary integer, sender integer, date_received integer, conversation_id integer, deleted integer default 0);
    create table subjects (ROWID integer primary key, subject text);
    create table summaries (ROWID integer primary key, summary text);
    create table addresses (ROWID integer primary key, address text, comment text);
    create table recipients (message integer, address integer, type integer);
    create table labels (message_id integer, mailbox_id integer);
    insert into mailboxes values (8, 'ews://EX-1/Inbox'), (9, 'imap://GM-1/INBOX');
    insert into subjects values (1, 'Seen'), (2, 'Updated Position');
    insert into addresses values (1, 'jvega@bank.example', 'Jo Vega'), (2, '${ME}', '');
    insert into messages (ROWID, mailbox, global_message_id, subject, sender, date_received, conversation_id) values
      (9, 8, 3, 1, 1, ${day + 3600}, 1), (10, 8, 1, 1, 1, ${day + 7200}, 1), (11, 9, 1, 1, 1, ${day + 7200}, 1), (12, 8, 2, 2, 1, ${day + 600}, 2);
    insert into recipients values (12, 2, 0);`]);
  const query = async (file, sql) => (file.endsWith('Accounts4.sqlite') ? [{ id: 'EX-1', address: ME, type: 'com.apple.account.Exchange' }, { id: 'GM-1', address: ME, type: 'com.apple.account.Google' }] : sqliteJson(file, sql));
  const now = Date.parse('2026-10-20T00:00:00Z');
  const all = await readInboxMail({ address: ME, home: dir, query, now, days: 3, bodies: false });
  assert.deepEqual(all.map((m) => m.id), ['apple-mail-12', 'apple-mail-9', 'apple-mail-10']);
  const later = await readInboxMail({ address: ME, home: dir, query, now, days: 3, bodies: false, afterRow: 10 });
  assert.deepEqual(later.map((m) => [m.id, m.subject, m.from]), [['apple-mail-12', 'Updated Position', 'Jo Vega <jvega@bank.example>']],
    'row 12, dated before rows 9 and 10, is new; row 11 is a second copy of row 10 and is not');
});

test('late mail: a reader that throws leaves both cursors where they were', async () => {
  const dir = await home();
  await writeLooked(dir, 'outlook', '2026-10-19T23:00:00.000Z');
  await writeLooked(dir, 'outlookRow', 100);
  await writeLooked(dir, 'messagesRow', { messages: 7 });
  const boom = async () => { throw new Error('reader down'); };
  const { errors } = await checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], readInbox: boom, readChats: boom, now: Date.parse('2026-10-19T23:20:00.000Z') });
  assert.deepEqual(errors.map((e) => e.source), ['outlook', 'messages']);
  const looked = await readLooked(dir);
  assert.equal(looked.outlookRow, 100); assert.deepEqual(looked.messagesRow, { messages: 7 }); assert.equal(looked.outlook, '2026-10-19T23:00:00.000Z');
});

test('late mail: one refresh sends at most SUGGEST_MAX unrouted items to suggest, newest first', async () => {
  const dir = await home();
  const clock = { now: 0 };
  const inbox = fakeInbox(clock);
  for (let i = 0; i < 40; i += 1) inbox.stored.push(mail(1000 + i, new Date(Date.parse('2026-10-19T00:00:00Z') + i * 60000).toISOString(), `p${i}@nowhere.example`, `Note ${i}`));
  const sent = [];
  clock.now = Date.parse('2026-10-20T12:00:00.000Z');
  await checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], readInbox: inbox.readInbox, now: clock.now, suggest: async (items) => { sent.push(...items); return { placed: [] }; } });
  assert.equal(SUGGEST_MAX, 30);
  assert.equal(sent.length, 30);
  assert.deepEqual(sent.map((item) => item.ref), Array.from({ length: 30 }, (_, i) => `apple-mail-${1039 - i}`));
});

// Messages and WhatsApp keep texts late too (Gio's Mac, 14 days to 2026-10-20: 87 incoming Messages rows and 74
// WhatsApp rows stored over an hour after their date; SMS relayed from the phone up to 5 days late).
function fakeChats() {
  const apps = { messages: [], whatsapp: [] };
  const asked = [];
  const readChats = async (options) => {
    asked.push(options);
    return Object.fromEntries(Object.entries(apps).map(([app, chats]) => [app, { status: 'ok', chats: chats.map((chat) => ({ app, isGroup: false, ...chat })) }]));
  };
  return { apps, asked, readChats };
}
const chat = (id, name, messages) => ({ id, title: '', participants: [{ handle: `+1555${id}`, name }], messages });
const text = (id, timestamp, words, fromMe = false) => ({ id: String(id), fromMe, from: fromMe ? '' : 'them', timestamp, text: words });

test('late chats: a text the phone syncs after a refresh, dated before it, is filed on the next one, per app', async () => {
  const dir = await home();
  const chats = fakeChats();
  const check = (now) => checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], readChats: chats.readChats, now: Date.parse(now) });
  chats.apps.messages.push(chat('1', 'Sam', [text(42500, '2026-10-19T20:00:00.000Z', 'the loggie demo')]));
  chats.apps.whatsapp.push(chat('7', 'Kai', [text(900, '2026-10-19T20:05:00.000Z', 'hi')]));
  const first = await check('2026-10-19T21:10:00.000Z');
  assert.deepEqual(ids(first, 'messages'), ['messages:1@2026-10-19T20:00:00.000Z']);
  assert.deepEqual((await readLooked(dir)).messagesRow, { messages: 42500, whatsapp: 900 });
  chats.apps.messages.push(chat('2', 'Lee', [text(42517, '2026-10-19T19:30:00.000Z', 'is loggie ready?')]));
  chats.apps.whatsapp[0].messages.push(text(901, '2026-10-19T20:30:00.000Z', 'loggie tomorrow?'));
  const second = await check('2026-10-19T21:20:00.000Z');
  assert.deepEqual(second.items.map((item) => [item.id, item.workstream]), [
    ['messages:2@2026-10-19T19:30:00.000Z', 'Loggie'], ['whatsapp:7@2026-10-19T20:30:00.000Z', 'Loggie']]);
  assert.deepEqual(chats.asked.at(-1), { days: 14, maxChats: 80, maxMessages: 40 });
  assert.deepEqual((await readLooked(dir)).messagesRow, { messages: 42517, whatsapp: 901 });
  assert.deepEqual((await check('2026-10-19T21:30:00.000Z')).items, []);
});

test('late chats: an app with a cursor reads by row; one without reads by date; one that fails keeps its cursor', async () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  const result = { messages: { status: 'ok', chats: [chat('1', 'Sam', [text(10, '2026-10-19T08:00:00.000Z', 'late'), text(11, '2026-10-01T08:00:00.000Z', 'reindexed')])] },
    whatsapp: { status: 'ok', chats: [{ app: 'whatsapp', ...chat('7', 'Kai', [text(3, '2026-10-19T08:00:00.000Z', 'before the watermark'), text(4, '2026-10-20T11:00:00.000Z', 'new')]) }] } };
  const read = await chatItems({ readChats: async () => result, since: '2026-10-20T10:00:00.000Z', afterRows: { messages: 9 }, now });
  assert.deepEqual(read.items.map((item) => item.ref), ['1@2026-10-19T08:00:00.000Z', '7@2026-10-20T11:00:00.000Z']);
  assert.deepEqual(read.rows, { messages: 11, whatsapp: 4 });
  const down = await chatItems({ readChats: async () => ({ ...result, whatsapp: { status: 'error', chats: [] } }), since: '2026-10-20T10:00:00.000Z', afterRows: { messages: 9, whatsapp: 2 }, now });
  assert.equal(down.ok, false);
  assert.deepEqual(down.rows, { messages: 11 }, 'whatsapp read nothing, so its cursor is not moved');
});
