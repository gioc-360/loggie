// Who the user wrote to, or saw on a small To or Cc, is someone the ask box can name (2026-10-12: "email <ta>" found
// no one though the user had written to a professor and the TA had answered with them on Cc). Made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWhoIndex, resolveWho, FEW } from '../src/hikyaku/ask-who.js';
import { readMailPeople } from '../src/hikyaku/sent-mail.js';

const ME = 'ana@school.example.com';

test('reads To and Cc from the Exchange Sent and Inbox only, headers only, with each message\'s size', async () => {
  const asked = [];
  const query = async (file, sql) => {
    if (file.endsWith('Accounts4.sqlite')) return [{ id: 'EX-1' }];
    if (sql.includes('from mailboxes')) return [{ id: 7, url: 'ews://EX-1/Sent%20Items' }, { id: 8, url: 'ews://EX-1/Inbox' }, { id: 9, url: 'imap://OTHER/INBOX' }];
    asked.push(sql);
    assert.doesNotMatch(sql, /\b9\b\)/, 'never another account');
    return /in \(7\)/.test(sql)
      ? [{ address: 'WPike@School.example.com', name: 'Wendell Pike', at: 1791295200, size: 2 }]
      : [{ address: 'wpike@school.example.com', name: 'Wendell Pike', at: 1791295300, size: 2 }];
  };
  const rows = await readMailPeople({ address: ME, home: '/h', query, now: 1791295400 * 1000 });
  assert.equal(asked.length, 2);
  assert.match(asked.find((sql) => /in \(7\)/.test(sql)), /date_sent/);
  assert.match(asked.find((sql) => /in \(8\)/.test(sql)), /date_received/);
  assert.deepEqual(rows.map((r) => [r.address, r.name, r.sent, r.size]), [['wpike@school.example.com', 'Wendell Pike', true, 2], ['wpike@school.example.com', 'Wendell Pike', false, 2]]);
  await assert.rejects(readMailPeople({ address: ME, home: '/h', query: async () => [] }), /no mail account in Apple Mail/);
});

const big = FEW + 30;
const mail = [
  // The user wrote to the professor; the TA answered the user with the professor on Cc. He never wrote back.
  { address: 'wpike@school.example.com', name: 'Wendell Pike', at: '2026-10-04T15:20:17Z', sent: true, size: 2 },
  { address: 'wpike@school.example.com', name: 'Wendell Pike', at: '2026-10-06T17:54:43Z', sent: false, size: 2 },
  { address: 'mlee@school.example.com', name: 'Mira Lee', at: '2026-10-06T17:54:43Z', sent: false, size: 2 },
  // Only ever on a class-wide email: not someone the user talks with.
  { address: 'kobi@school.example.com', name: 'Kobi Dane', at: '2026-10-05T10:00:00Z', sent: false, size: big },
  // The user wrote to a whole list: still the user's choice, so it counts.
  { address: 'club@school.example.com', name: 'Sailing Club Board', at: '2026-10-03T10:00:00Z', sent: true, size: big },
  // No name, the user, a no-reply: never names.
  { address: 'x7@school.example.com', name: '', at: '2026-10-05T10:00:00Z', sent: true, size: 1 },
  { address: ME, name: 'Ana Lee', at: '2026-10-05T10:00:00Z', sent: false, size: 2 },
  { address: 'no-reply@school.example.com', name: 'School Portal', at: '2026-10-05T10:00:00Z', sent: false, size: 1 },
];
const inbox = [{ from: 'Mira Lee <mlee@school.example.com>', subject: 'Re: Class next week', timestamp: '2026-10-06T17:54:43Z', to: ME, cc: 'wpike@school.example.com' }];
const entries = buildWhoIndex({ inbox, mail, own: [ME] });

test('"email wendell": the professor the user wrote to is found, once, with his newest date, and an email to him is new', () => {
  const found = resolveWho('wendell', entries, { action: 'reply', app: 'outlook' });
  assert.equal(found.status, 'one');
  assert.equal(found.pick.email, 'wpike@school.example.com');
  assert.equal(found.pick.last, '2026-10-06T17:54:43Z');
  assert.equal(entries.filter((e) => e.email === 'wpike@school.example.com').length, 1);
  assert.equal(found.pick.conversation, undefined, 'no thread of his to answer');
});

test('a sender stays the sender entry (with the email to answer), not a second one from To or Cc', () => {
  const mira = entries.filter((e) => e.email === 'mlee@school.example.com');
  assert.equal(mira.length, 1);
  assert.equal(mira[0].subject, 'Re: Class next week');
});

test('a class-wide To or Cc adds no one; a list the user wrote to does; no name, the user and no-reply never do', () => {
  assert.equal(resolveWho('kobi', entries, { action: 'reply' }).status, 'none');
  assert.equal(resolveWho('sailing club', entries, { action: 'reply' }).status, 'one');
  assert.ok(!entries.some((e) => ['x7@school.example.com', ME, 'no-reply@school.example.com'].includes(e.email)));
});

test('a chat message never reaches someone known only from mail', () => {
  assert.equal(resolveWho('wendell', entries, { action: 'message' }).status, 'none');
});
