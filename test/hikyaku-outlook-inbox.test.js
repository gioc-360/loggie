import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { freshnessOf } from '../src/hikyaku/freshness.js';
import { cutQuoted, mergeInbox, readInboxMail, recoverSentMail } from '../src/hikyaku/sent-mail.js';
import { belongsTo, cardList, catchUp } from '../src/hikyaku/workstreams.js';

// The incident of 2026-10-06, with made-up people: the person's answer ("Friday 1 pm") reached only the user's
// Outlook address, and the workstream's Gmail thread had stopped two weeks earlier.
const ME = 'ana@school.example.com';
const BANK = { name: 'Acme Bank', kind: 'company', goal: 'Get the offer', domains: ['acmebank.com'], words: ['Acme'] };
const raw = (body) => Buffer.from(`${Buffer.byteLength(body)}\nContent-Type: text/plain\n\n${body}`, 'latin1');

test('reads the Outlook inbox only from the user\'s own Exchange account, filters on headers before opening any file, and cuts quotes', async () => {
  const query = async (file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) return [{ id: 'EX-1' }];
    if (sql.includes('from mailboxes')) return [{ id: 7, url: 'ews://EX-1/Sent%20Items' }, { id: 8, url: 'ews://EX-1/Inbox' }, { id: 9, url: 'imap://OTHER/INBOX' }];
    assert.match(sql, /m\.mailbox in \(8\)/, 'only the Exchange Inbox, never another account');
    return [
      { id: 11, subject: 'RE: Coffee chat', received: 1791295200, conversation: 501, summary: 'preview', sender: 'lena@acmebank.com', name: 'Lena Park', recipients: ME, copied: null },
      { id: 12, subject: 'Campus newsletter', received: 1791295300, conversation: 502, summary: 'news', sender: 'news@school.example.com', name: '', recipients: ME, copied: null },
    ];
  };
  const opened = [];
  const read = async (rowId) => { opened.push(rowId); return raw('Friday 1 pm works.\n\nFrom: Ana Lee <ana@school.example.com>\nSent: Monday\nSubject: Coffee chat\n\nWould Friday work?'); };
  const inbox = await readInboxMail({ address: ME, home: '/h', query, now: 1791295400 * 1000, keep: belongsTo(BANK), read });
  assert.deepEqual(opened, [11], 'the newsletter was filtered on its headers and its file never opened');
  assert.deepEqual(inbox.map((m) => [m.from, m.to, m.conversation, m.body]), [['Lena Park <lena@acmebank.com>', ME, '501', 'Friday 1 pm works.']]);
  assert.equal(cutQuoted('Yes.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Ana <ana@school.example.com> wrote:\n> hi'), 'Yes.');
  await assert.rejects(readInboxMail({ address: ME, home: '/h', query: async () => [] }), /no mail account in Apple Mail/);
});

test('an Outlook answer joins the Gmail thread it answers, or starts its own thread with the user\'s Outlook-sent side, never twice', () => {
  const gmail = { id: 't1', subject: 'Coffee chat', messages: [{ id: 'g1', from: 'Lena Park <lena@acmebank.com>', to: ME, subject: 'Coffee chat', timestamp: '2026-09-21T15:00:00.000Z', body: 'Happy to chat.' }] };
  const threads = [gmail];
  const inbox = [
    // the same message Gmail already has, seen again in the Outlook copy a minute later
    { id: 'apple-mail-1', conversation: '400', from: 'Lena Park <lena@acmebank.com>', to: ME, subject: 'Coffee chat', timestamp: '2026-09-21T15:01:00.000Z', body: 'Happy to chat.' },
    // an answer in the Gmail thread's subject, only in Outlook
    { id: 'apple-mail-2', conversation: '400', from: 'Lena Park <lena@acmebank.com>', to: ME, subject: 'RE: Coffee chat', timestamp: '2026-09-25T14:00:00.000Z', body: 'Next week is busy.' },
    // an answer to a new email the user sent from Outlook: no Gmail thread has this subject
    { id: 'apple-mail-3', conversation: '501', from: 'Lena Park <lena@acmebank.com>', to: ME, subject: 'RE: Coffee chat on Friday?', timestamp: '2026-10-05T14:16:00.000Z', body: 'Friday 1 pm works.' },
    // not this workstream's
    { id: 'apple-mail-4', conversation: '502', from: 'news@school.example.com', to: ME, subject: 'Campus newsletter', timestamp: '2026-10-05T15:00:00.000Z', body: 'news' },
  ];
  const sent = [{ id: 'apple-mail-9', conversation: '501', subject: 'Coffee chat on Friday?', timestamp: '2026-10-05T13:00:00.000Z', to: ['lena@acmebank.com'], body: 'Would Friday work?\n\nFrom: Lena Park\nSent: x\nSubject: y\n\nold' }];
  assert.deepEqual(mergeInbox(threads, inbox, ME, { belongs: belongsTo(BANK), sent }), { joined: 1, started: 1 });
  assert.deepEqual(gmail.messages.map((m) => m.id), ['g1', 'apple-mail-2']);
  const started = threads[1];
  assert.equal(started.id, 'outlook:501');
  assert.equal(started.sourceType, 'manual', 'Core has no outlook source; manual with an outlook: id, as custom workstreams do');
  assert.deepEqual(started.messages.map((m) => [m.from, m.body]), [[ME, 'Would Friday work?'], ['Lena Park <lena@acmebank.com>', 'Friday 1 pm works.']]);
  assert.equal(started.latestTimestamp, '2026-10-05T14:16:00.000Z');
  assert.deepEqual(mergeInbox(threads, inbox, ME, { belongs: belongsTo(BANK), sent }), { joined: 0, started: 0 }, 'a second run adds nothing');
  assert.equal(belongsTo({ name: 'Inbox', inbox: true, domains: [], words: [] })(inbox[2]), false);
});

test('a workstream catch-up reads the Outlook inbox; other callers never open it, and a failure is said, not hidden', async () => {
  let reads = 0;
  const readInbox = async ({ keep }) => { reads += 1; return [{ id: 'apple-mail-3', conversation: '501', from: 'lena@acmebank.com', to: ME, subject: 'Hello from Acme', timestamp: '2026-10-05T14:16:00.000Z', body: 'Hi' }].filter(keep); };
  const threads = [];
  const outcome = await recoverSentMail(threads, ME, { readSent: async () => [], readInbox, belongs: belongsTo(BANK) });
  assert.deepEqual([outcome.inbox, threads.length], [{ joined: 0, started: 1 }, 1]);
  await recoverSentMail([], ME, { readSent: async () => [], readInbox });
  assert.equal(reads, 1, 'without a workstream, nothing from the inbox is opened');
  const broken = await recoverSentMail([], ME, { readSent: async () => [], readInbox: async () => { throw new Error('no Inbox yet'); }, belongs: belongsTo(BANK) });
  assert.match(broken.inboxNote, /could not be read: no Inbox yet/);
});

test('a move from an Outlook-only thread becomes a task with its own outlook: source and a reply to the person', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-outlook-'));
  const tasks = [], projects = [];
  const core = { listProjects: async () => projects, listTasks: async () => tasks, createBrief: async () => ({}),
    createProject: async (input) => { const project = { id: 'p1', ...input }; projects.push(project); return project; },
    createTask: async (input) => { const task = { id: `task_${tasks.length + 1}`, ...input }; tasks.push(task); return task; } };
  const threads = [{ id: 'outlook:501', sourceType: 'manual', subject: 'RE: Coffee chat on Friday?', latestTimestamp: '2026-10-05T14:16:00.000Z', messages: [
    { id: 'apple-mail-3', from: 'Lena Park <lena@acmebank.com>', to: ME, subject: 'RE: Coffee chat on Friday?', timestamp: '2026-10-05T14:16:00.000Z', body: 'Friday 1 pm works. Can you send an invite?' }] }];
  const complete = async () => JSON.stringify({ summary: 'Coffee chat.', promised: [], open: [], actions: [{ title: 'Send Lena an invite for Friday 1 pm', kind: 'reply', thread: 1, due: null, quote: 'Friday 1 pm works.', steps: [] }] });
  await catchUp({ workstream: BANK, threads, complete, core, workRoot, ownAddress: ME });
  assert.deepEqual([tasks[0].sourceType, tasks[0].sourceId], ['manual', 'outlook:501:reply']);
  const reply = JSON.parse(await readFile(join(projects[0].directoryPath, tasks[0].id, 'REPLY.json'), 'utf8'));
  assert.deepEqual([reply.to, reply.original.from, reply.original.date], ['lena@acmebank.com', 'lena@acmebank.com', '2026-10-05T14:16:00.000Z']);
});

test('the person\'s newer message to the user\'s Outlook address makes a draft stale, and says where it arrived', async () => {
  const thread = ['# Coffee chat', '', `## Lena Park <lena@acmebank.com> · 2026-09-21T15:00:00.000Z`, `To: ${ME}`, '', 'Happy to chat.', ''].join('\n');
  const original = { from: 'lena@acmebank.com', date: '2026-09-21T15:00:00.000Z', subject: 'Coffee chat' };
  const readInbox = async ({ keep, bodies }) => {
    assert.equal(bodies, false, 'the guard needs dates, not message text');
    return [{ from: 'Lena Park <lena@acmebank.com>', subject: 'RE: Coffee chat on Friday?', timestamp: '2026-10-05T14:16:00.000Z' }, { from: 'kim@x.com', subject: 'x', timestamp: '2026-10-06T00:00:00.000Z' }].filter(keep);
  };
  const result = await freshnessOf({ thread, original, me: [ME], readInbox, now: () => new Date('2026-10-06T12:00:00Z') });
  assert.equal(result.freshness, 'checked');
  assert.match(result.newer.reason, /^Lena Park wrote again after the email this draft answers: "RE: Coffee chat on Friday\?", Oct 5 \(to your Outlook address\)\./);
  const broken = await freshnessOf({ thread, original, me: [ME], readInbox: async () => { throw new Error('no Inbox yet'); } });
  assert.deepEqual([broken.freshness, broken.notes], ['unchecked', ['Outlook inbox could not be checked: no Inbox yet']]);
});

test('every project with an open move gets a card; named workstreams keep theirs, done-only projects get none', () => {
  const projects = [{ id: 'p1', name: 'Acme Bank' }, { id: 'p2', name: 'One-offs' }, { id: 'p3', name: 'Knee injury' }, { id: 'p4', name: 'Chats' }];
  const tasks = [{ projectId: 'p1', status: 'waiting' }, { projectId: 'p2', status: 'running' }, { projectId: 'p2', status: 'waiting' }, { projectId: 'p3', status: 'done' }, { projectId: 'p4', status: 'waiting' }];
  const cards = cardList({ workstreams: [BANK], projects, tasks, extra: [{ name: 'Chats', kind: 'other', chats: true, domains: [], words: [] }] });
  assert.deepEqual(cards.map((card) => [card.name, Boolean(card.folder)]), [['Acme Bank', false], ['Chats', false], ['One-offs', true]]);
  assert.deepEqual(cardList({ workstreams: [], projects, tasks }).map((card) => card.name), ['Acme Bank', 'One-offs', 'Chats'], 'with chats off, open chat moves still show');
});

test('Outlook for Mac quotes with From: and Date: lines; that history is cut too', () => {
  assert.equal(cutQuoted('Following up on this.\n\nBest,\nGio\n\nFrom: Gio Caballero <me@school.example>\nDate: Tuesday, October 6, 2026 at 18:55\nTo: venue <hello@venue.example>\nSubject: Re: Room'), 'Following up on this.\n\nBest,\nGio');
  assert.equal(cutQuoted('Yes.\n\n*From: *Ana <ana@school.example>\n*Date: *Monday'), 'Yes.');
});

// workspaces-outlook W2/W4: with no Gmail there are no Gmail threads at all; the whole catch-up is the Outlook read.
test('with no Gmail threads, the catch-up builds its threads from Outlook alone, both sides, over the window it is given', async () => {
  const asked = [];
  const readInbox = async (options) => { asked.push(['inbox', options.days]); return [
    { id: 'apple-mail-21', conversation: '601', from: 'Lena Park <lena@acmebank.com>', to: ME, cc: '', subject: 'RE: Offer timeline', timestamp: '2026-09-01T10:00:00.000Z', body: 'Could you confirm by Friday?' },
  ].filter(options.keep); };
  const readSent = async (options) => { asked.push(['sent', options.days]); return [
    { id: 'apple-mail-20', conversation: '601', subject: 'Offer timeline', timestamp: '2026-08-30T10:00:00.000Z', to: ['lena@acmebank.com'], primary: ['lena@acmebank.com'], body: 'Hi Lena, when do you need my answer?' },
  ]; };
  const threads = [];
  const outcome = await recoverSentMail(threads, ME, { readSent, readInbox, belongs: belongsTo(BANK), days: 120 });
  assert.deepEqual(asked, [['sent', 120], ['inbox', 120]]);
  assert.equal(outcome.inbox.started, 1);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, 'outlook:601');
  assert.equal(threads[0].sourceType, 'manual');
  assert.deepEqual(threads[0].messages.map((m) => m.id), ['apple-mail-20', 'apple-mail-21'], 'the user\'s sent side joins by conversation, oldest first');
  // Without `days` the readers keep their own defaults (the Gmail path is unchanged).
  const plain = [];
  await recoverSentMail([], ME, { readSent: async (o) => { plain.push(o.days); return []; }, readInbox: async (o) => { plain.push(o.days); return []; }, belongs: belongsTo(BANK) });
  assert.deepEqual(plain, [undefined, undefined]);
});
