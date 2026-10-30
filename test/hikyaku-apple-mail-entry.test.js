// The entry run reads a window of mail straight from Apple Mail (src/hikyaku/apple-mail-entry.js), read-only, as
// threads in the inbox.json shape (spec-entry-b.md B3). Everything here is made up: a tiny Envelope Index and a few
// .emlx files written into a temporary folder that stands in for the home folder. The real ~/Library/Mail is never
// opened, no model runs (catch-up is a spy), nothing is screened, and the CLI tests run with HOME set to the made-up
// folder, so even the CLI's own home-folder lookups land there.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readAppleMail } from '../src/hikyaku/apple-mail-entry.js';
import { entryRun } from '../src/hikyaku/entry.js';
import { sqliteJson } from '../src/hikyaku/sent-mail.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SINCE = '2026-10-01';
const ACCOUNT = 'AAAAAAAA-1111-2222-3333-444444444444';
const STORE = 'BBBBBBBB-5555-6666-7777-888888888888';
const ME = 'lena@school.example';
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

// --- the made-up store. Mailboxes: Inbox, Sent Items, Deleted Items (never read).
const BOXES = [[1, `ews://${ACCOUNT}/Inbox`, 'Inbox.mbox'], [2, `ews://${ACCOUNT}/Sent%20Items`, 'Sent Items.mbox'], [3, `ews://${ACCOUNT}/Deleted%20Items`, 'Deleted Items.mbox']];
const MESSAGES = [
  { row: 101, box: 1, date: '2026-10-02T10:00:00Z', from: ['Dana Reyes', 'dana@acme.example'], to: [ME], subject: 'Outline for the kickoff', id: '<a1@acme.example>',
    body: 'Can you send the outline by Friday?' },
  // Lena's answer, in Sent Items: it carries In-Reply-To and References, so it joins Dana's thread by header.
  { row: 102, box: 2, date: '2026-10-03T09:00:00Z', from: ['Lena Park', ME], to: ['dana@acme.example'], subject: 'RE: Outline for the kickoff', id: '<s1@school.example>',
    inReplyTo: '<a1@acme.example>', references: '<a1@acme.example>', body: 'Yes, sending it Thursday.\n\nOn Thu, Oct 2, 2026 at 10:00 AM Dana Reyes <dana@acme.example> wrote:\n> Can you send the outline by Friday?' },
  // Quoted-printable body and an encoded subject.
  { row: 103, box: 1, date: '2026-10-04T09:00:00Z', from: ['Omar Haddad', 'omar@riverside.example'], to: [ME], subject: '=?utf-8?B?R3JhbnQgZHJhZnQ=?=', plainSubject: 'Grant draft', id: '<g1@riverside.example>',
    qp: true, body: 'Could you review the grant budget section this week? It=E2=80=99s short.' },
  // Omar again, from a phone app that dropped the reply headers: joined by subject and the same person.
  { row: 104, box: 1, date: '2026-10-05T08:00:00Z', from: ['Omar Haddad', 'omar@riverside.example'], to: [ME], subject: 'Re: Grant draft', id: '<g2@riverside.example>',
    body: 'Also the timeline page, if you have a minute.' },
  // Same subject, a different person, no headers linking it: a thread of its own.
  { row: 105, box: 1, date: '2026-10-05T12:00:00Z', from: ['Ines Mora', 'ines@books.example'], to: [ME], subject: 'Re: Grant draft', id: '<i1@books.example>',
    body: 'Is the grant draft the one we talked about at book club?' },
  // Before the window, in the trash, and deleted: never read.
  { row: 106, box: 1, date: '2026-09-01T09:00:00Z', from: ['Dana Reyes', 'dana@acme.example'], to: [ME], subject: 'Last spring', id: '<old@acme.example>', body: 'The old deck.' },
  { row: 107, box: 3, date: '2026-10-04T09:00:00Z', from: ['Promo', 'deals@shop.example'], to: [ME], subject: 'Sale', id: '<sale@shop.example>', body: 'Half off.' },
  { row: 108, box: 1, date: '2026-10-04T10:00:00Z', from: ['Dana Reyes', 'dana@acme.example'], to: [ME], subject: 'Deleted one', id: '<del@acme.example>', body: 'Gone.', deleted: 1 },
  // In Sent Items with no message file on disk yet: read from the index alone.
  { row: 109, box: 2, date: '2026-10-04T15:00:00Z', from: ['Lena Park', ME], to: ['priya@elsewhere.example'], subject: 'Lunch on Friday?', id: null, body: 'Are you free for lunch on Friday?', noFile: true },
];

const sq = (value) => (value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`);

function emlx(message) {
  const lines = [
    `From: ${message.from[0]} <${message.from[1]}>`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date(message.date).toUTCString()}`,
    ...(message.id ? [`Message-ID: ${message.id}`] : []),
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references ? [`References:\n ${message.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    `Content-Transfer-Encoding: ${message.qp ? 'quoted-printable' : '7bit'}`,
    '',
    message.body,
    '',
  ];
  const raw = lines.join('\n');
  return `${Buffer.byteLength(raw)}\n${raw}<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>0</integer></dict></plist>\n`;
}

async function fixtureStore() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-apple-mail-'));
  const mail = join(root, 'Library', 'Mail', 'V10');
  await mkdir(join(mail, 'MailData'), { recursive: true });
  const addresses = new Map();
  const addressId = (address, comment = '') => { if (!addresses.has(address)) addresses.set(address, { id: addresses.size + 1, comment }); return addresses.get(address).id; };
  const sql = [
    'create table mailboxes (ROWID integer primary key, url text);',
    // Apple Mail's own table: Gmail's INBOX and Sent Mail are rows here on All Mail messages (workspaces-outlook W10).
    'create table labels (message_id integer, mailbox_id integer);',
    'create table subjects (ROWID integer primary key, subject text);',
    'create table summaries (ROWID integer primary key, summary text);',
    'create table addresses (ROWID integer primary key, address text, comment text);',
    'create table recipients (ROWID integer primary key, message integer, address integer, type integer, position integer);',
    'create table messages (ROWID integer primary key, message_id integer, sender integer, subject_prefix text, subject integer, summary integer, date_sent integer, date_received integer, mailbox integer, deleted integer default 0, conversation_id integer);',
    ...BOXES.map(([id, url]) => `insert into mailboxes values (${id}, ${sq(url)});`),
  ];
  for (const message of MESSAGES) {
    const sender = addressId(message.from[1], message.from[0]);
    const subject = message.plainSubject || message.subject;
    const prefix = /^(re|fw|fwd):\s*/i.exec(subject)?.[0] || '';
    sql.push(`insert into subjects values (${message.row}, ${sq(subject.slice(prefix.length))});`);
    sql.push(`insert into summaries values (${message.row}, ${sq(message.body.split('\n')[0])});`);
    sql.push(`insert into messages values (${message.row}, ${message.row}, ${sender}, ${sq(prefix)}, ${message.row}, ${message.row}, ${at(message.date)}, ${at(message.date) + 30}, ${message.box}, ${message.deleted || 0}, ${message.row});`);
    for (const [index, to] of message.to.entries()) sql.push(`insert into recipients (message, address, type, position) values (${message.row}, ${addressId(to)}, 0, ${index});`);
  }
  for (const [address, { id, comment }] of addresses) sql.push(`insert into addresses values (${id}, ${sq(address)}, ${sq(comment)});`);
  execFileSync('/usr/bin/sqlite3', [join(mail, 'MailData', 'Envelope Index')], { input: sql.join('\n') });
  for (const message of MESSAGES.filter((item) => !item.noFile)) {
    const folder = join(mail, ACCOUNT, BOXES.find(([id]) => id === message.box)[2], STORE, 'Data', '1', 'Messages');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${message.row}.emlx`), emlx(message));
  }
  return { root, mailFolder: join(root, 'Library', 'Mail') };
}

// path -> sha256 of every file under a folder, so a run that wrote, added or removed anything shows up.
async function snapshot(folder) {
  const out = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[path.slice(folder.length)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  };
  await walk(folder);
  return out;
}

// Every file and folder under the store made read-only for the length of `fn`, then given back for cleanup.
async function readOnly(folder, fn) {
  const modes = new Map();
  const walk = async (path) => {
    const info = await stat(path);
    modes.set(path, info.mode & 0o777);
    if (info.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
  };
  await walk(folder);
  const paths = [...modes.keys()];
  for (const path of paths.reverse()) await chmod(path, modes.get(path) & 0o555);
  try { return await fn(); } finally { for (const path of paths.reverse()) await chmod(path, modes.get(path)); }
}

const B3_THREAD = ['id', 'historyId', 'subject', 'snippet', 'latestTimestamp', 'participants', 'messages'];
const B3_MESSAGE = ['id', 'threadId', 'messageId', 'from', 'to', 'cc', 'subject', 'timestamp', 'body', 'snippet', 'labels', 'attachments', 'rawLinks'];
const bySubject = (threads, subject) => threads.filter((thread) => thread.subject.replace(/^re:\s*/i, '') === subject);

test('Apple Mail is read as threads: Inbox and Sent both, joined by headers, then by subject and the same people', async () => {
  const store = await fixtureStore();
  const { threads, counts } = await readAppleMail({ since: SINCE, home: store.root, ownAddress: ME });
  assert.equal(threads.length, 4, 'Dana, Omar, Ines and the lunch note: four threads');
  assert.deepEqual(counts, { inbox: 4, sent: 2, threads: 4, missing: 1, first: '2026-10-02', last: '2026-10-05' });

  const [acme] = bySubject(threads, 'Outline for the kickoff');
  assert.deepEqual(acme.messages.map((item) => item.messageId), ['<a1@acme.example>', '<s1@school.example>'], 'the Sent reply joins by In-Reply-To');
  assert.equal(acme.messages.at(-1).fromMe, true, 'Lena wrote last, so it is not her move');
  assert.deepEqual(acme.messages.at(-1).labels, ['SENT']);
  assert.equal(acme.messages.at(-1).body, 'Yes, sending it Thursday.', 'the quoted history under a reply is cut');
  assert.equal(acme.messages[0].fromMe, false);
  assert.equal(acme.latestTimestamp, acme.messages.at(-1).timestamp);

  const grant = bySubject(threads, 'Grant draft');
  assert.equal(grant.length, 2, 'same subject, different people: two threads');
  const omar = grant.find((thread) => thread.messages.length === 2);
  assert.ok(omar, 'Omar\'s reply without headers joins his first message by subject and person');
  assert.equal(omar.messages[0].subject, 'Grant draft', 'the encoded subject is decoded');
  assert.equal(omar.messages[0].body, 'Could you review the grant budget section this week? It’s short.', 'quoted-printable is decoded as UTF-8');

  const lunch = threads.find((thread) => thread.subject === 'Lunch on Friday?');
  assert.equal(lunch.messages[0].fromMe, true, 'a Sent message with no file on disk still counts, from the index');
  assert.equal(lunch.messages[0].to, 'priya@elsewhere.example');
  assert.equal(lunch.messages[0].body, 'Are you free for lunch on Friday?');

  const all = JSON.stringify(threads);
  for (const never of ['Last spring', 'Half off', 'Gone.']) assert.ok(!all.includes(never), `${never}: before the window, in the trash or deleted, never read`);
  await rm(store.root, { recursive: true, force: true });
});

test('the threads are the inbox.json shape the entry run accepts, and the run catches up on them', async () => {
  const store = await fixtureStore();
  const { threads } = await readAppleMail({ since: SINCE, home: store.root, ownAddress: ME });
  assert.deepEqual(JSON.parse(JSON.stringify(threads)), threads, 'plain JSON, the same as a file');
  for (const thread of threads) {
    for (const key of B3_THREAD) assert.ok(key in thread, `thread has ${key}`);
    assert.match(thread.id, /^[A-Za-z0-9_.:-]{1,120}$/, 'the id can name a screen folder (screen-thread.js)');
    assert.ok(Array.isArray(thread.participants) && thread.messages.length);
    for (const message of thread.messages) {
      for (const key of B3_MESSAGE) assert.ok(key in message, `message has ${key}`);
      assert.equal(message.threadId, thread.id);
      assert.ok(!Number.isNaN(Date.parse(message.timestamp)), 'ISO timestamp');
      for (const key of ['labels', 'attachments', 'rawLinks']) assert.ok(Array.isArray(message[key]));
    }
  }

  const home = join(store.root, 'hikyaku');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([
    { name: 'Acme Bank', kind: 'company', goal: 'Get an offer', domains: ['acme.example'], words: [] },
    { name: 'Riverside Lab', kind: 'other', goal: 'Get it done', domains: ['riverside.example'], words: [] },
  ]));
  const seen = [];
  const catchUpImpl = async ({ workstream, threads: given, sentMail }) => { seen.push({ name: workstream.name, given, sentMail }); return { threads: given.length, written: 0, already: 0 }; };
  const core = { listProjects: async () => [], listTasks: async () => [] };
  const result = await entryRun({ home, core, since: SINCE, appleMail: { home: store.root }, ownAddress: ME, complete: async () => { throw new Error('no model here'); }, transcriber: '/fake', catchUpImpl });
  assert.deepEqual(seen.map((item) => [item.name, item.given.map((thread) => thread.subject.replace(/^re:\s*/i, ''))]), [['Acme Bank', ['Outline for the kickoff']], ['Riverside Lab', ['Grant draft']]]);
  assert.ok(seen.every((item) => item.sentMail?.seesOutlook === true), 'Sent was read, so catch-up does not warn about unseen Outlook replies');
  assert.deepEqual(result.catchUps.map((item) => item.workstream), ['Acme Bank', 'Riverside Lab']);
  await rm(store.root, { recursive: true, force: true });
});

test('the index is opened read-only and nothing under the mail folder is written', async () => {
  const store = await fixtureStore();
  const before = await snapshot(store.mailFolder);
  const calls = [];
  const run = promisify(execFile);
  const query = (file, sql) => sqliteJson(file, sql, { execImpl: (command, args, options) => { calls.push(args); return run(command, args, options); } });
  const { threads } = await readOnly(store.mailFolder, () => readAppleMail({ since: SINCE, home: store.root, ownAddress: ME, query }));
  assert.equal(threads.length, 4, 'it reads a store it cannot write to');
  assert.ok(calls.length >= 1);
  for (const args of calls) {
    assert.ok(args.includes('-readonly'), 'sqlite3 -readonly');
    assert.match(args.find((arg) => arg.startsWith('file:')), /\?mode=ro$/, 'a read-only URI');
  }
  assert.deepEqual(await snapshot(store.mailFolder), before, 'no file changed, added or removed (no -journal, -wal or -shm)');
  await rm(store.root, { recursive: true, force: true });
});

test('no Apple Mail store, or no access to it, fails loud with the one fix', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'hikyaku-apple-mail-none-'));
  await assert.rejects(readAppleMail({ since: SINCE, home: empty }), (error) => /Apple Mail/.test(error.message) && /Open Mail/.test(error.message) && /Nothing was read/.test(error.message));

  const store = await fixtureStore();
  await chmod(store.mailFolder, 0o000);
  try {
    await assert.rejects(readAppleMail({ since: SINCE, home: store.root }), (error) => /Full Disk Access/.test(error.message) && error.pane === 'full-disk-access');
  } finally { await chmod(store.mailFolder, 0o755); }

  // A window with no mail in it is not an empty run either.
  await assert.rejects(readAppleMail({ since: '2026-12-01', home: store.root }), /no Inbox or Sent mail since 2026-12-01/);

  // The CLI: exit non-zero, the fix on stderr, and no run folder written.
  const home = join(empty, 'hikyaku');
  const cli = spawnSync(process.execPath, [join(ROOT, 'bin', 'loggie.js'), 'entry', 'run', '--since', SINCE, '--apple-mail', '--home', home], { env: { ...process.env, HOME: empty }, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /Open Mail/);
  await assert.rejects(stat(home), { code: 'ENOENT' }, 'nothing was written');
  await rm(empty, { recursive: true, force: true });
  await rm(store.root, { recursive: true, force: true });
});

test('loggie entry run --apple-mail --count-only prints counts only and writes nothing', async () => {
  const store = await fixtureStore();
  const before = await snapshot(store.root);
  const home = join(store.root, 'hikyaku');
  const cli = spawnSync(process.execPath, [join(ROOT, 'bin', 'loggie.js'), 'entry', 'run', '--since', SINCE, '--apple-mail', '--count-only', '--home', home, '--address', ME],
    { env: { ...process.env, HOME: store.root }, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /6 messages \(4 inbox, 2 sent\) in 4 threads, 2026-10-02 to 2026-10-05/);
  for (const never of ['Outline', 'Grant', 'Dana', 'Omar', 'acme', 'Lunch', 'Friday']) assert.ok(!cli.stdout.includes(never), `${never}: no subject, name or body is printed`);
  assert.deepEqual(await snapshot(store.root), before, 'nothing written anywhere, no home and no Core folder');
  await rm(store.root, { recursive: true, force: true });
});
