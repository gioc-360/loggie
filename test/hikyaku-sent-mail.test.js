import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarResponses, mergeQuoted, mergeSent, quotedOwnMessages, readSentMail, recoverSentMail } from '../src/hikyaku/sent-mail.js';
import { checkActions } from '../src/hikyaku/workstreams.js';

const ME = 'sam@school.edu';

test('finds the user\'s own words quoted in a reply, in Gmail and Outlook styles, and nobody else\'s', () => {
  const gmail = { from: 'Lena <lena@acmebank.com>', timestamp: '2026-10-01T15:00:00.000Z', body: 'Sounds good!\n\nOn Tue, Sep 29, 2026 at 10:05 AM Gio Doe <sam@school.edu> wrote:\n> Hi Lena,\n> Would Friday Oct 9 work?\n>> older quote\n' };
  const [fromGmail] = quotedOwnMessages(gmail, ME);
  assert.equal(fromGmail.body, 'Hi Lena,\nWould Friday Oct 9 work?');
  assert.match(fromGmail.timestamp, /^2026-09-29T1[34]:05/, 'the time of day survives, not just the date');

  const outlook = { from: 'Jamie <jamie@acmebank.com>', timestamp: '2026-09-25T12:00:00.000Z', body: 'Works for me.\n\nFrom: Doe, Gio <sam@school.edu>\nSent: Wednesday, September 24, 2026 4:12 PM\nTo: Reed, Jamie <jamie@acmebank.com>\nSubject: Coffee chat\n\nHi Jamie, would Friday at 10 work?\n' };
  const [fromOutlook] = quotedOwnMessages(outlook, ME, ['Doe, Gio']);
  assert.equal(fromOutlook.body, 'Hi Jamie, would Friday at 10 work?');
  assert.match(fromOutlook.timestamp, /^2026-09-24/);
  const flattened = { ...outlook, body: outlook.body.replace('Hi Jamie, would Friday at 10 work?\n', 'Hi Jamie, would Friday at 10 work? From: Reed, Jamie <jamie@acmebank.com> Sent: Monday\n') };
  assert.equal(quotedOwnMessages(flattened, ME, ['Doe, Gio'])[0].body, 'Hi Jamie, would Friday at 10 work?');

  const someoneElse = { from: 'a@x.com', timestamp: '2026-10-01T00:00:00.000Z', body: 'On Tue, Sep 29, 2026 at 9 AM Ana <ana@x.com> wrote:\n> hi\n' };
  assert.deepEqual(quotedOwnMessages(someoneElse, ME), []);
});

test('puts quoted Outlook messages back in the thread once, and never twice when Gmail already has them', () => {
  const thread = { subject: 'Coffee chat', messages: [
    { from: 'Lena <lena@acmebank.com>', timestamp: '2026-10-01T15:00:00.000Z', body: 'Sounds good!\n\nOn Tue, Sep 29, 2026 at 10:05 AM Gio Doe <sam@school.edu> wrote:\n> Would Friday Oct 9 work?\n' },
  ] };
  assert.equal(mergeQuoted([thread], ME), 1);
  assert.equal(thread.messages[0].source, 'quoted');
  assert.equal(thread.messages.at(-1).from, 'Lena <lena@acmebank.com>', 'a quote never makes the user the last to speak');
  assert.equal(mergeQuoted([thread], ME), 0);
});

test('reads sent mail only from the user\'s own Exchange account in Apple Mail, and says why when it cannot', async () => {
  const calls = [];
  const fake = (rows) => async (file, sql) => { calls.push(file); return rows(file, sql); };
  const query = fake((file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) return [{ id: 'EX-1' }];
    if (sql.includes('from mailboxes')) return [{ id: 7, url: 'ews://EX-1/Sent%20Items' }, { id: 8, url: 'ews://EX-1/Inbox' }, { id: 9, url: 'imap://OTHER/Sent%20Messages' }];
    assert.match(sql, /m\.mailbox in \(7\)/);
    return [{ id: 1, subject: 'Re: Coffee chat', sent: 1790870000, summary: 'Following up', recipients: 'LENA@acmebank.com' }];
  });
  const [message] = await readSentMail({ address: ME, home: '/h', query, now: 1790870000 * 1000 });
  assert.deepEqual(message.to, ['lena@acmebank.com']);
  assert.equal(message.body, 'Following up');

  await assert.rejects(readSentMail({ address: ME, home: '/h', query: async () => [] }), /no mail account in Apple Mail for sam@school.edu/);
  const panes = [];
  await recoverSentMail([], ME, { readSent: () => readSentMail({ address: ME, home: '/h', query: async () => [] }), openPane: async (name) => { panes.push(name); } });
  assert.deepEqual(panes, ['internet-accounts'], 'a missing account opens Internet Accounts for the user');
  const outcome = await recoverSentMail([], ME, { readSent: async () => { throw new Error('no account'); }, openPane: async (name) => { panes.push(name); } });
  assert.equal(panes.length, 1, 'an error with no switch to flip opens nothing');
  assert.deepEqual(outcome, { quoted: 0, appleMail: 0, seesOutlook: false, note: 'no account' });
});

test('an Outlook reply ends the user\'s move, and an accepted invite marks a move as looking done', () => {
  const thread = { subject: 'Coffee chat', messages: [{ from: 'Lena <lena@acmebank.com>', to: ME, timestamp: '2026-09-28T10:00:00.000Z', body: 'Fridays work best.' }] };
  mergeSent([thread], [{ id: 'apple-mail-1', subject: 'RE: Coffee chat', timestamp: '2026-09-29T10:00:00.000Z', to: ['lena@acmebank.com'], body: 'Friday Oct 9?' }], ME);
  const reply = { actions: [{ kind: 'reply', thread: 1, title: 'Reply to Lena', quote: 'Fridays work best.' }] };
  assert.equal(checkActions(reply, [thread], ME, { seesOutlook: true }).actions.length, 0, 'the user spoke last, from Outlook');

  const jamie = { subject: 'Coffee chat', messages: [{ from: 'Jamie <jamie@acmebank.com>', to: ME, timestamp: '2026-09-25T10:00:00.000Z', body: 'Can you send a calendar invite?' }] };
  const accepted = { subject: 'Accepted: Coffee Chat Follow up', messages: [{ from: 'Jamie Reed <jamie@acmebank.com>', subject: 'Accepted: Coffee Chat Follow up', timestamp: '2026-09-26T09:00:00.000Z', body: '' }] };
  const responses = calendarResponses([jamie, accepted], ME);
  assert.equal(responses[0].response, 'accepted');
  const { actions } = checkActions({ actions: [{ kind: 'reply', thread: 1, title: 'Send Jamie an invite', quote: 'Can you send a calendar invite?' }] }, [jamie], ME, { seesOutlook: true, responses });
  assert.match(actions[0].notSure.join(' '), /Looks done: Jamie Reed accepted "Coffee Chat Follow up"/);
  assert.doesNotMatch(actions[0].notSure.join(' '), /cannot see/);
});

test('the user wrote last, but the other person asked to be contacted later: that reply stays; a made-up ask does not', () => {
  const chat = { subject: 'Jonah', chat: { app: 'messages', isGroup: false }, messages: [
    { fromMe: false, from: '+13235550141', timestamp: '2026-10-08T23:18:45.000Z', body: "Okay, yeah let's set up Monday. Hit me up Sunday evening so we can solidify time" },
    { fromMe: true, from: 'me', timestamp: '2026-10-08T23:20:36.000Z', body: 'sounds good!' },
  ] };
  const owed = { actions: [{ kind: 'reply', thread: 1, title: 'Text Jonah Sunday evening to set the Monday call', due: '2026-10-11', quote: 'Hit me up Sunday evening so we can solidify time' }] };
  assert.equal(checkActions(owed, [chat], ME).actions.length, 1);
  assert.equal(checkActions(owed, [chat], ME).actions[0].due, '2026-10-11');
  const mine = { actions: [{ kind: 'reply', thread: 1, title: 'Reply to Jonah', quote: 'sounds good!' }] };
  assert.equal(checkActions(mine, [chat], ME).actions.length, 0, 'the quote is the user\'s own words');
  const invented = { actions: [{ kind: 'reply', thread: 1, title: 'Reply to Jonah', quote: 'hit me up tomorrow' }] };
  assert.equal(checkActions(invented, [chat], ME).actions.length, 0, 'the quote is not in the chat');
});

test('a settings pane opens at most once every 6 hours', async () => {
  const { openPane } = await import('../src/hikyaku/settings-panes.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-panes-'));
  const opened = [];
  const spawnImpl = (cmd, args) => { opened.push(args[0]); return { unref() {} }; };
  let clock = 1_000_000;
  assert.equal(await openPane('internet-accounts', { home, spawnImpl, now: () => clock }), true);
  clock += 3600 * 1000;
  assert.equal(await openPane('internet-accounts', { home, spawnImpl, now: () => clock }), false);
  clock += 6 * 3600 * 1000;
  assert.equal(await openPane('internet-accounts', { home, spawnImpl, now: () => clock }), true);
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension', 'x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension']);
});

// Spec W10 (docs/workspaces-outlook/spec.md): every account in Apple Mail, Gmail's labels, one copy of a repeat.
const ACCOUNTS = [
  { id: 'EX-1', type: 'com.apple.account.Exchange', parent: '', address: 'sam@school.edu' },
  { id: 'GM-1', type: 'com.apple.account.IMAP', parent: 'com.apple.account.Google', address: 'sam@school.edu' },
  { id: 'GM-2', type: 'com.apple.account.IMAP', parent: 'com.apple.account.Google', address: 'sam.doe@gmail.com' },
  { id: 'IC-1', type: 'com.apple.account.IMAP', parent: 'com.apple.account.AppleAccount', address: '' },
];
const BOXES = [
  { id: 1, url: 'ews://EX-1/Sent%20Items' }, { id: 2, url: 'ews://EX-1/Inbox' },
  { id: 10, url: 'imap://GM-1/%5BGmail%5D/All%20Mail' }, { id: 11, url: 'imap://GM-1/INBOX' }, { id: 12, url: 'imap://GM-1/%5BGmail%5D/Sent%20Mail' },
  { id: 20, url: 'imap://GM-2/%5BGmail%5D/All%20Mail' }, { id: 21, url: 'imap://GM-2/INBOX' }, { id: 22, url: 'imap://GM-2/%5BGmail%5D/Sent%20Mail' },
  { id: 30, url: 'imap://IC-1/Sent%20Messages' },
];

test('lists every Apple Mail account: Exchange first, a Google child takes its parent\'s address, iCloud has none', async () => {
  const { mailAccounts, mailAddresses } = await import('../src/hikyaku/sent-mail.js');
  const query = async () => [ACCOUNTS[1], ACCOUNTS[3], ACCOUNTS[0], ACCOUNTS[2]];
  const accounts = await mailAccounts({ home: '/h', query });
  assert.deepEqual(accounts.map((account) => [account.kind, account.address]), [['exchange', 'sam@school.edu'], ['google', 'sam@school.edu'], ['icloud', ''], ['google', 'sam.doe@gmail.com']]);
  assert.deepEqual(await mailAddresses({ home: '/h', query }), ['sam@school.edu', 'sam.doe@gmail.com']);
});

test('reads Sent from every account named: Gmail Sent Mail by its label, a repeat once (the Exchange copy), each row from its own account', async () => {
  const sqls = [];
  const query = async (file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) {
      assert.match(sql, /!= 'com\.apple\.account\.AppleAccount'/, 'iCloud is never read under the Apple ID');
      assert.match(sql, /in \('sam@school\.edu', 'sam\.doe@gmail\.com'\)/);
      return ACCOUNTS.slice(0, 3).reverse();
    }
    if (sql.includes('from mailboxes')) return BOXES;
    sqls.push(sql);
    assert.match(sql, /m\.mailbox in \(1,12,22\) or m\.ROWID in \(select l\.message_id from labels l where l\.mailbox_id in \(1,12,22\)\)/);
    return [
      { id: 501, mailbox: 10, gid: 77, subject: 'Re: Karaoke', sent: 1790870000, summary: 'Gmail copy', recipients: 'k@venue.com' },
      { id: 401, mailbox: 1, gid: 77, subject: 'Re: Karaoke', sent: 1790870000, summary: 'Exchange copy', recipients: 'k@venue.com' },
      { id: 601, mailbox: 20, gid: 88, subject: 'Dinner', sent: 1790871000, summary: 'From Gmail', recipients: 'amy@x.com' },
    ];
  };
  const sent = await readSentMail({ address: ['sam@school.edu', 'sam.doe@gmail.com'], home: '/h', query, now: 1790872000 * 1000 });
  assert.equal(sqls.length, 1);
  assert.deepEqual(sent.map((message) => [message.id, message.from, message.body]), [['apple-mail-401', 'sam@school.edu', 'Exchange copy'], ['apple-mail-601', 'sam.doe@gmail.com', 'From Gmail']]);
});

test('a reply sent from a second account is the user\'s own: it ends their move and is never read as someone else', () => {
  const thread = { subject: 'Dinner', messages: [{ from: 'Amy <amy@x.com>', to: 'sam.doe@gmail.com', timestamp: '2026-09-28T10:00:00.000Z', body: 'Friday?' }] };
  mergeSent([thread], [{ id: 'apple-mail-601', from: 'sam.doe@gmail.com', subject: 'Re: Dinner', timestamp: '2026-09-29T10:00:00.000Z', to: ['amy@x.com'], body: 'Yes, Friday.' }], [ME, 'sam.doe@gmail.com']);
  assert.equal(thread.messages.at(-1).from, 'sam.doe@gmail.com');
  const reply = { actions: [{ kind: 'reply', thread: 1, title: 'Reply to Amy', quote: 'Friday?' }] };
  assert.equal(checkActions(reply, [thread], [ME, 'sam.doe@gmail.com'], { seesOutlook: true }).actions.length, 0, 'the user spoke last, from Gmail in Apple Mail');
  assert.equal(checkActions(reply, [thread], ME, { seesOutlook: true }).actions.length, 1, 'with one address, the other account is someone else');
});

test('an address with no account is ignored when another has one; none matching names Internet Accounts', async () => {
  const query = async (file, sql) => (file.endsWith('Accounts4.sqlite') ? (sql.includes("'sam@school.edu'") ? [ACCOUNTS[0]] : []) : sql.includes('from mailboxes') ? BOXES : []);
  assert.deepEqual(await readSentMail({ address: ['nobody@else.com', 'sam@school.edu'], home: '/h', query }), []);
  await assert.rejects(readSentMail({ address: ['nobody@else.com'], home: '/h', query }), (error) => error.pane === 'internet-accounts' && /no mail account in Apple Mail for nobody@else\.com/.test(error.message));
});
