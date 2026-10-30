// Teammates' mail fixes 1 and 3 (2026-10-28): the Disk step shows, per kind of account, how many and the newest mail
// before Continue; with none, the plain steps; the skip says what it costs. Fakes only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { accountCounts } from '../src/hikyaku/sent-mail.js';
import { mailState } from '../src/hikyaku/setup-status.js';
import { mailCheckLines, NO_MAIL_STEPS, readyRows, SKIP_NO_MAIL } from '../desktop/renderer/setup-model.js';

const ACCOUNTS = [
  { id: 'EX-1', type: 'com.apple.account.Exchange', parent: '', address: 'sam@school.edu' },
  { id: 'GM-1', type: 'com.apple.account.IMAP', parent: 'com.apple.account.Google', address: 'sam.doe@gmail.com' },
  { id: 'IC-1', type: 'com.apple.account.IMAP', parent: 'com.apple.account.AppleAccount', address: '' },
];
const BOXES = [{ id: 1, url: 'ews://EX-1/Inbox' }, { id: 2, url: 'ews://EX-1/Sent%20Items' }, { id: 11, url: 'imap://GM-1/INBOX' }, { id: 30, url: 'imap://IC-1/INBOX' }];

test('accountCounts gives each account the newest mail in its Inbox, headers only', async () => {
  const sqls = [];
  const query = async (file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) return ACCOUNTS;
    if (sql.includes('from mailboxes')) return BOXES;
    sqls.push(sql);
    if (sql.includes('max(m.date_received)')) return [{ at: sql.includes('(1)') ? 1793000000 : null }];
    return [{ n: 3 }];
  };
  const list = await accountCounts({ home: '/h', query, store: async () => ({ index: '/h/Envelope Index' }) });
  assert.deepEqual(list.map((account) => [account.kind, account.newest]), [['exchange', new Date(1793000000 * 1000).toISOString()], ['google', null], ['icloud', null]]);
  for (const sql of sqls) assert.doesNotMatch(sql, /summary|subject|address/, 'counts and dates only, never what the mail says');
});

test('mailState sums the kinds: Exchange, Google, iCloud, each with its count and newest mail; skipped accounts leave', async () => {
  const list = [
    { address: 'sam@school.edu', kind: 'exchange', inbox: 4, sent: 2, newest: '2026-10-27T15:00:00.000Z', skipped: null },
    { address: 'sam.doe@gmail.com', kind: 'google', inbox: 9, sent: 1, newest: '2026-10-26T09:00:00.000Z', skipped: null },
    { address: 'sam@nyu.edu', kind: 'google', inbox: 1, sent: 0, newest: '2026-10-27T08:00:00.000Z', skipped: null },
    { address: 'old@mail.example', kind: 'imap', inbox: 1, sent: 1, newest: '2026-01-01T00:00:00.000Z', skipped: 'settings' },
    { address: '', kind: 'icloud', inbox: null, sent: null, newest: null, skipped: 'icloud' },
  ];
  const mail = await mailState({ mailImpl: async () => list });
  assert.equal(mail.accounts, 3);
  assert.deepEqual(mail.kinds, [
    { kind: 'exchange', accounts: 1, newest: '2026-10-27T15:00:00.000Z', read: true },
    { kind: 'google', accounts: 2, newest: '2026-10-27T08:00:00.000Z', read: true },
    { kind: 'icloud', accounts: 1, newest: null, read: false },
  ]);
  assert.deepEqual((await mailState({ mailImpl: async () => { throw new Error('x'); } })).kinds, []);
});

test('the live lines: one per kind, with the newest mail as today, yesterday or a date; an unsynced account says open Mail', () => {
  const now = new Date(2026, 9, 27, 18, 0);
  const lines = mailCheckLines({ kinds: [
    { kind: 'exchange', accounts: 1, newest: new Date(2026, 9, 27, 9, 0).toISOString(), read: true },
    { kind: 'google', accounts: 2, newest: new Date(2026, 9, 26, 9, 0).toISOString(), read: true },
    { kind: 'imap', accounts: 1, newest: new Date(2026, 9, 20, 9, 0).toISOString(), read: true },
    { kind: 'icloud', accounts: 1, newest: null, read: false },
  ] }, now);
  assert.deepEqual(lines.map((line) => line.text), [
    'Microsoft Exchange: 1 account, newest mail today',
    'Google: 2 accounts, newest mail yesterday',
    'Other mail: 1 account, newest mail Oct 20',
    'iCloud: 1 account, not read by Loggie',
  ]);
  assert.equal(mailCheckLines({ kinds: [{ kind: 'exchange', accounts: 1, newest: null, read: true }] }, now)[0].text, 'Microsoft Exchange: 1 account, no mail yet: open Mail once and let it sync');
  assert.deepEqual(mailCheckLines({ accounts: 0, kinds: [] }), []);
});

test('with no account: the steps name Internet Accounts, Microsoft Exchange or Google, Mail on, Mail opened once', () => {
  const steps = NO_MAIL_STEPS.join(' ');
  assert.match(steps, /System Settings > Internet Accounts/);
  assert.match(steps, /Microsoft Exchange for Outlook/);
  assert.match(steps, /Google for Gmail/);
  assert.match(steps, /Turn on Mail/);
  assert.match(steps, /Open Mail once/);
});

test('the skip says what it costs, on the Disk step and on Ready', async () => {
  assert.equal(SKIP_NO_MAIL, 'Skip for now: no workspaces until your mail is in Apple Mail');
  const setup = await readFile(new URL('../desktop/renderer/setup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(setup, /Continue without mail/);
  assert.match(setup, /big\(SKIP_NO_MAIL,/);
  const mail = readyRows({ mail: { accounts: 0 } }).find((row) => row.key === 'mail');
  assert.equal(mail.note, 'No workspaces until your mail is in Apple Mail.');
  assert.equal(readyRows({ mail: { accounts: 2 } }).find((row) => row.key === 'mail').note, null);
});
