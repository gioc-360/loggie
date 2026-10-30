// workspaces-outlook W11: a reply in Apple Mail opens on the email it answers, in its thread, and is never sent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPLE_MAIL_REASONS, READ_BACK, SCRIPT, appleMailReply } from '../src/hikyaku/apple-mail-reply.js';
import { findInboxMessage } from '../src/hikyaku/sent-mail.js';
import { openDraft } from '../src/hikyaku/draft.js';

test('the Mail script has no send command, checks the To line before pasting, and pastes only with that reply in front', () => {
  assert.doesNotMatch(SCRIPT, /\bsend\b/i, 'no send, in any form');
  assert.doesNotMatch(READ_BACK, /\bsend\b|keystroke|click/i, 'the read back only reads');
  assert.ok(SCRIPT.indexOf('reply-wrong-recipient') < SCRIPT.indexOf('keystroke'), 'the To line is checked before the paste');
  assert.ok(SCRIPT.indexOf('frontName is not replySubject') < SCRIPT.indexOf('keystroke'), 'Mail and this reply are in front before the paste');
  assert.doesNotMatch(SCRIPT, /set content|make new paragraph/, 'writing content wipes the quoted email (2026-10-17)');
  assert.match(SCRIPT, /whose id is rowId/);
  assert.match(SCRIPT, /whose message id is headerId/);
});

const LOCATED = { rowId: 4012, accountId: 'GM-2', mailbox: 'INBOX', header: 'abc@mail.gmail.com' };
const ORIGINAL = { from: 'Amy@X.com', subject: 'Dinner', date: '2026-10-16T10:00:00.000Z', rowId: 4012 };
const copied = [];
const copy = async (text) => { copied.push(text); };

test('finds the email, copies the draft, runs one script with its account, Inbox, row and Message-ID, and reads the draft back', async () => {
  const runs = [];
  const finds = [];
  const reads = [];
  const result = await appleMailReply({ original: ORIGINAL, body: 'Hi Amy,\n\nFriday works.', own: ['sam@school.edu'], copy,
    accounts: async () => ['sam.doe@gmail.com'], find: async (args) => { finds.push(args); return LOCATED; },
    run: async (args) => { runs.push(args); return { stdout: 'pasted\n', stderr: '' }; },
    readBack: async (subject) => { reads.push(subject); return { stdout: 'Hi Amy,\nFriday works.\nOn Oct 16, 2026, Amy <amy@x.com> wrote:' }; } });
  assert.deepEqual(result, { status: 'replied' });
  assert.equal(copied.at(-1), 'Hi Amy,\n\nFriday works.', 'the draft is on the clipboard before the paste');
  assert.deepEqual(finds[0].address, ['sam@school.edu', 'sam.doe@gmail.com'], 'every account, so the email is found where it arrived');
  assert.equal(finds[0].rowId, 4012);
  assert.deepEqual(runs[0], ['GM-2', 'INBOX', '4012', 'abc@mail.gmail.com', 'amy@x.com']);
  assert.deepEqual(reads, ['Re: Dinner']);
  const unread = await appleMailReply({ original: ORIGINAL, body: 'Hi Amy', own: [], copy, accounts: async () => [], find: async () => LOCATED,
    run: async () => ({ stdout: 'pasted', stderr: '' }), readBack: async () => ({ stdout: 'On Oct 16 Amy wrote:' }) });
  assert.equal(unread.status, 'reply-open-draft-on-clipboard', 'a paste that cannot be read back is said as a clipboard paste');
  const typed = await appleMailReply({ original: ORIGINAL, body: 'Hi Amy,\n\nFriday works.', own: [], copy, accounts: async () => [], find: async () => LOCATED,
    run: async () => ({ stdout: 'pasted', stderr: '' }), readBack: async () => ({ stdout: 'comHi Amy,\nFriday works.' }) });
  assert.equal(typed.status, 'replied');
  assert.match(typed.finding, /\("com"\)\. Delete it before sending\./, 'typing that reached Mail is named, not hidden');
});

test('each way it can fail has its own status, and a dry run or a missing email runs no script', async () => {
  const base = { original: ORIGINAL, body: 'Hi', own: ['sam@school.edu'], copy, accounts: async () => [], find: async () => LOCATED };
  const never = async () => { throw new Error('no script should run'); };
  assert.equal((await appleMailReply({ ...base, find: async () => null, run: never })).status, 'no-match');
  assert.equal((await appleMailReply({ ...base, dryRun: true, run: never })).status, 'dry-run');
  assert.deepEqual(await appleMailReply({ ...base, run: async () => ({ error: new Error('x'), stdout: '', stderr: 'execution error: Not authorized to send Apple events to Mail. (-1743)' }) }), { status: 'not-trusted', pane: 'automation' });
  assert.deepEqual(await appleMailReply({ ...base, run: async () => ({ error: new Error('x'), stdout: '', stderr: 'System Events got an error: osascript is not allowed to send keystrokes. (1002)' }) }), { status: 'not-trusted', pane: 'accessibility' });
  assert.equal((await appleMailReply({ ...base, run: async () => ({ error: Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), stdout: '', stderr: '' }) })).status, 'timeout');
  assert.equal((await appleMailReply({ ...base, run: async () => ({ stdout: 'reply-wrong-recipient', stderr: '' }) })).status, 'reply-wrong-recipient');
  assert.deepEqual(await appleMailReply({ ...base, run: async () => ({ error: new Error('x'), stdout: '', stderr: 'Mail got an error: boom\nmore' }) }), { status: 'error', detail: 'Mail got an error: boom' });
  for (const status of ['no-match', 'reply-wrong-recipient', 'not-trusted', 'timeout', 'error']) assert.ok(APPLE_MAIL_REASONS[status], status);
});

test('the email is found by its row, in the Inbox or through a Gmail Inbox label, with the Message-ID unbracketed', async () => {
  const query = async (file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) return [{ id: 'GM-2', type: 'com.apple.account.IMAP', parent: 'com.apple.account.Google', address: 'sam.doe@gmail.com' }];
    if (sql.includes('from mailboxes')) return [{ id: 20, url: 'imap://GM-2/%5BGmail%5D/All%20Mail' }, { id: 21, url: 'imap://GM-2/INBOX' }];
    assert.match(sql, /m\.ROWID = 4012/);
    return [{ id: 4012, mailbox: 20, subject: 'Re: Dinner', header: '<abc@mail.gmail.com>', label: 21 }];
  };
  assert.deepEqual(await findInboxMessage({ address: ['sam.doe@gmail.com'], rowId: 4012, subject: 'Dinner', home: '/h', query }), LOCATED);
  const bySender = async (file, sql) => (sql.includes('m.ROWID =') ? assert.fail('no row given') : sql.includes("lower(a.address) = 'amy@x.com'") ? [] : query(file, sql));
  assert.equal(await findInboxMessage({ address: ['sam.doe@gmail.com'], from: 'Amy@x.com', date: ORIGINAL.date, home: '/h', query: bySender }), null);
});

async function task() {
  const folder = await mkdtemp(join(tmpdir(), 'hikyaku-mailapp-'));
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-home-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'apple-mail', signName: 'Sam' }));
  await writeFile(join(folder, 'DRAFT.md'), 'Hi Amy,\n\nFriday works.\n\nBest,');
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: 'amy@x.com', subject: 'Re: Dinner', account: 'sam@school.edu', original: ORIGINAL }));
  return { folder, home };
}

test('Do it with Apple Mail opens the threaded reply and records the try; a reply it cannot place is a clipboard paste, never a new email', async () => {
  const { folder, home } = await task();
  const opened = [];
  const spawnImpl = (cmd, args) => { opened.push([cmd, ...args]); return { unref() {} }; };
  const copied = [];
  const clipboardImpl = async (text) => { copied.push(text); };
  const seen = [];
  const replied = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, appleMailImpl: async (args) => { seen.push(args); return { status: 'replied' }; } });
  assert.deepEqual([replied.opened, replied.mode], ['apple-mail', 'reply']);
  assert.equal(seen[0].original.rowId, 4012);
  assert.match(seen[0].body, /^Hi Amy,\n\nFriday works\.\n\nBest,\nSam/);
  assert.equal(JSON.parse(await readFile(join(home, 'apple-mail-reply.json'), 'utf8')).status, 'replied');
  assert.equal(opened.length, 0, 'nothing else opened');

  const missed = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, again: true, appleMailImpl: async () => ({ status: 'no-match' }) });
  assert.deepEqual([missed.opened, missed.mode], ['apple-mail', 'clipboard']);
  assert.equal(missed.reason, APPLE_MAIL_REASONS['no-match']);
  assert.deepEqual(opened, [['open', '-a', 'Mail']], 'Mail in front, no mailto');
  assert.equal(copied.length, 1);
});
