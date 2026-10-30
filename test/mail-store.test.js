// Teammates' mail fix 4 (2026-10-28): Apple Mail's store is found like permissions.js finds it, not hard-coded V10, and
// "unable to open" says what failed instead of always blaming Full Disk Access. Temp homes only; nothing real is read.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { accountCounts, readSentMail, sqliteJson } from '../src/hikyaku/sent-mail.js';

async function homeWith(...versions) {
  const home = await mkdtemp(join(tmpdir(), 'loggie-store-'));
  for (const version of versions) {
    await mkdir(join(home, 'Library', 'Mail', version, 'MailData'), { recursive: true });
    await writeFile(join(home, 'Library', 'Mail', version, 'MailData', 'Envelope Index'), '');
  }
  return home;
}
const ACCOUNT = { id: 'EX-1', type: 'com.apple.account.Exchange', parent: '', address: 'sam@school.edu' };

test('the readers open the newest store that has an Envelope Index (V11 here), not V10', async () => {
  const home = await homeWith('V10', 'V11');
  await mkdir(join(home, 'Library', 'Mail', 'V12'), { recursive: true });
  const files = [];
  const query = async (file, sql) => {
    files.push(file);
    if (file.endsWith('Accounts4.sqlite')) return [ACCOUNT];
    if (sql.includes('from mailboxes')) return [{ id: 1, url: 'ews://EX-1/Sent%20Items' }, { id: 2, url: 'ews://EX-1/Inbox' }];
    return [];
  };
  await readSentMail({ address: 'sam@school.edu', home, query });
  await accountCounts({ home, query });
  const opened = files.filter((file) => !file.endsWith('Accounts4.sqlite'));
  assert.ok(opened.length >= 2);
  for (const file of opened) assert.equal(file, join(home, 'Library', 'Mail', 'V11', 'MailData', 'Envelope Index'));
});

test('a V9 store is read on an older macOS', async () => {
  const home = await homeWith('V9');
  const files = [];
  const query = async (file, sql) => { files.push(file); return file.endsWith('Accounts4.sqlite') ? [ACCOUNT] : sql.includes('from mailboxes') ? [] : []; };
  await accountCounts({ home, query });
  assert.ok(files.some((file) => file.includes(join('Mail', 'V9', 'MailData'))));
});

const failing = (stderr) => async () => { throw Object.assign(new Error('Command failed: sqlite3'), { stderr }); };

test('"unable to open" with the file present is not reported as Full Disk Access: sqlite\'s own words are', async () => {
  const home = await homeWith('V10');
  const file = join(home, 'Library', 'Mail', 'V10', 'MailData', 'Envelope Index');
  await assert.rejects(sqliteJson(file, 'select 1', { execImpl: failing('Error: unable to open database "file:x": file is locked\n') }), (error) => {
    assert.notEqual(error.pane, 'full-disk-access');
    assert.doesNotMatch(error.message, /Full Disk Access/);
    assert.match(error.message, /could not be opened: Error: unable to open database/);
    return true;
  });
});

test('"unable to open" with no store says the store is missing, never Full Disk Access', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-store-'));
  const file = join(home, 'Library', 'Mail', 'V10', 'MailData', 'Envelope Index');
  await assert.rejects(sqliteJson(file, 'select 1', { execImpl: failing('Error: unable to open database file') }), (error) => {
    assert.notEqual(error.pane, 'full-disk-access');
    assert.match(error.message, /no mail store at .*Envelope Index yet\. Open Mail once/);
    return true;
  });
});

test('macOS refusing the file is still Full Disk Access, and "authorization denied" always is', async () => {
  const refused = async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  await assert.rejects(sqliteJson('/x/Envelope Index', 'select 1', { execImpl: failing('Error: unable to open database file'), statImpl: refused }), (error) => error.pane === 'full-disk-access');
  await assert.rejects(sqliteJson('/x/Envelope Index', 'select 1', { execImpl: failing('Error: authorization denied') }), (error) => error.pane === 'full-disk-access');
});
