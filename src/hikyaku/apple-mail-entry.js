// The entry run's mail, read straight from Apple Mail on this Mac: school mail (Microsoft 365) reaches Apple Mail, and
// the CLI has no Gmail credentials, so without this the entry run reads mail only from an inbox.json file.
// Every account's Inbox and Sent folder in the window (--since), so a thread the user answered last reads as theirs
// (fromMe), the same own-message test catch-up uses (workstreams.js isOwn). Grouped into threads by Message-ID,
// In-Reply-To and References; a message with none of those (phone apps drop them) joins a thread with the same subject,
// Re:/Fwd: stripped, and someone else in common. The result is the thread shape inbox.json uses (spec-entry-b.md B3),
// so the entry run reads it exactly as it reads inbox.json.
//
// Read-only: the Envelope Index is opened with sqlite3 -readonly and a mode=ro URI (sent-mail.js sqliteJson), the
// message files are only read, and nothing is written under ~/Library/Mail. Fails loud: no store, no access (Full Disk
// Access) or no mail in the window is an error that names the one fix, never an empty list.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { extractRawLinks } from './links.js';
import { baseSubject, cutQuoted, messageFiles, plainText, sqliteJson } from './sent-mail.js';

const INBOX_FOLDER = /^inbox$/i;
const SENT_FOLDER = /^(sent items|sent messages|sent mail|sent)$/i;
const IDS = /<[^<>\s]+>/g;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);
const noAccess = () => fail('hikyaku cannot read Apple Mail: Full Disk Access is off for the app running this command. Switch it on in System Settings, Privacy & Security, '
  + 'Full Disk Access, restart that app, then run it again. Nothing was read.', { pane: 'full-disk-access', fix: 'Switch on Full Disk Access for the app running Loggie, then run it again.' });
const noStore = (root) => fail(`Apple Mail has no mail on this Mac (no Envelope Index under ${root}). Open Mail, add your account and let it finish syncing, then run it again. Nothing was read.`,
  { fix: 'Open Mail and let it finish syncing, then run it again.' });
const denied = (error) => ['EPERM', 'EACCES'].includes(error?.code);

// The newest Apple Mail store (V10, V11, ...) that has an Envelope Index.
async function findStore(home) {
  const root = join(home, 'Library', 'Mail');
  let names;
  try { names = await readdir(root); } catch (error) {
    if (denied(error)) throw noAccess();
    if (error.code === 'ENOENT') throw noStore(root);
    throw error;
  }
  for (const version of names.filter((name) => /^V\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
    const index = join(root, version, 'MailData', 'Envelope Index');
    const found = await stat(index).then(() => true, (error) => { if (denied(error)) throw noAccess(); return false; });
    if (found) return { mailRoot: join(root, version), index };
  }
  throw noStore(root);
}

// --- one message file: a byte-count line, the raw message, then Apple's plist.
function rawMessage(bytes) {
  const text = bytes.toString('latin1');
  const newline = text.indexOf('\n');
  const length = Number(text.slice(0, newline));
  return Buffer.from(text.slice(newline + 1, newline + 1 + (length || undefined)), 'latin1');
}

// Encoded words (=?utf-8?B?...?= and =?...?Q?...?=) in a header, decoded.
export function decodeHeader(value = '') {
  return String(value).replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, kind, text) => {
    const bytes = kind.toLowerCase() === 'b' ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    return bytes.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
  }).trim();
}

function headersOf(raw) {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = Buffer.from(end < 0 ? text : text.slice(0, end), 'latin1').toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match && !(match[1].toLowerCase() in headers)) headers[match[1].toLowerCase()] = match[2];
  }
  return headers;
}

const addressOf = (value = '') => (String(value).match(/[\w.+-]+@[\w.-]+/) || [''])[0].toLowerCase();
const addressesOf = (value = '') => (String(value).match(/[\w.+-]+@[\w.-]+/g) || []).map((item) => item.toLowerCase());
const shortHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

// --- threads: Message-ID, In-Reply-To and References first; then subject and someone in common for a message that has
// neither In-Reply-To nor References. Pure, so it is tested on its own.
export function threadMessages(messages, ownAddresses = []) {
  const own = new Set(ownAddresses.map((item) => String(item).toLowerCase()));
  const parent = new Map();
  const find = (key) => { let at = key; while (parent.has(at) && parent.get(at) !== at) at = parent.get(at); return at; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  for (const message of messages) {
    parent.set(message.key, find(message.key));
    for (const ref of [...message.references, ...message.inReplyTo]) union(message.key, ref);
  }
  const people = (message) => new Set([...addressesOf(message.from), ...addressesOf(message.to), ...addressesOf(message.cc)].filter((who) => !own.has(who)));
  for (const message of messages.filter((item) => !item.references.length && !item.inReplyTo.length)) {
    const subject = baseSubject(message.subject);
    if (!subject) continue;
    const mine = people(message);
    for (const other of messages) {
      if (other === message || baseSubject(other.subject) !== subject) continue;
      if ([...people(other)].some((who) => mine.has(who))) union(other.key, message.key);
    }
  }
  const groups = new Map();
  for (const message of messages) groups.set(find(message.key), [...(groups.get(find(message.key)) || []), message]);
  const threads = [...groups.values()].map((group) => {
    const sorted = group.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    const id = `apple-mail-${shortHash(sorted[0].key)}`;
    const list = sorted.map(({ key, references, inReplyTo, ...message }) => ({ ...message, threadId: id }));
    const latest = list.at(-1);
    return { id, historyId: null, sourceType: 'manual', subject: latest.subject || '(no subject)', snippet: latest.snippet, latestTimestamp: latest.timestamp,
      participants: [...new Set(list.flatMap((message) => [message.from, message.to]).filter(Boolean))], messages: list };
  });
  return threads.sort((a, b) => a.latestTimestamp.localeCompare(b.latestTimestamp) || a.id.localeCompare(b.id));
}

// --- the window, read: { threads, counts }. `query` is sent-mail.js sqliteJson (sqlite3 -readonly, mode=ro).
export async function readAppleMail({ since, home = homedir(), ownAddress = '', query = sqliteJson }) {
  if (typeof since !== 'string' || !DAY.test(since)) throw new Error('Give the start of the window as --since YYYY-MM-DD.');
  const { mailRoot, index } = await findStore(home);
  const ask = async (sql) => {
    try { return await query(index, sql); } catch (error) {
      if (error.pane === 'full-disk-access' || denied(error)) throw noAccess();
      throw error;
    }
  };
  const boxes = (await ask('select ROWID as id, url from mailboxes')).map((box) => ({ ...box, folder: decodeURIComponent(String(box.url).split('/').pop() || '') }));
  const inbox = boxes.filter((box) => INBOX_FOLDER.test(box.folder)).map((box) => Number(box.id));
  const sent = boxes.filter((box) => SENT_FOLDER.test(box.folder)).map((box) => Number(box.id));
  if (!inbox.length && !sent.length) throw fail('Apple Mail has no Inbox or Sent folder yet. Open Mail and let it finish syncing, then run it again. Nothing was read.', { fix: 'Open Mail and let it finish syncing, then run it again.' });
  const accounts = [...new Set(boxes.filter((box) => inbox.includes(Number(box.id)) || sent.includes(Number(box.id))).map((box) => /^[a-z]+:\/\/([^/]+)\//i.exec(box.url)?.[1]).filter(Boolean))];
  const start = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000);
  const list = (ids) => ids.join(',') || 'null';
  // Gmail keeps every message in All Mail; its INBOX and Sent Mail are labels on those rows (workspaces-outlook W10).
  const inFolder = (ids) => `(m.mailbox in (${list(ids)}) or exists (select 1 from labels l where l.message_id = m.ROWID and l.mailbox_id in (${list(ids)})))`;
  const rows = await ask(`
    select m.ROWID as id, m.mailbox as mailbox, ${inFolder(sent)} as isSent, coalesce(m.subject_prefix, '') || coalesce(s.subject, '') as subject, m.date_sent as sent, m.date_received as received,
      su.summary as summary, a.address as sender, a.comment as name,
      (select group_concat(x.address, ', ') from recipients r join addresses x on x.ROWID = r.address where r.message = m.ROWID and r.type = 0) as recipients,
      (select group_concat(x.address, ', ') from recipients r join addresses x on x.ROWID = r.address where r.message = m.ROWID and r.type = 1) as copied
    from messages m
    left join subjects s on s.ROWID = m.subject
    left join summaries su on su.ROWID = m.summary
    left join addresses a on a.ROWID = m.sender
    where m.deleted = 0 and ((${inFolder(inbox)} and m.date_received >= ${start}) or (${inFolder(sent)} and m.date_sent >= ${start}))
    order by m.ROWID`);
  if (!rows.length) throw fail(`Apple Mail has no Inbox or Sent mail since ${since}. If that is wrong, open Mail and let it finish syncing, then run it again. Nothing was prepared.`, { fix: 'Open Mail and let it finish syncing, then run it again.' });

  const files = await messageFiles(mailRoot, accounts);
  const isSent = (row) => sent.includes(Number(row.mailbox)) || Number(row.isSent) === 1;
  const owners = new Set([ownAddress, ...rows.filter(isSent).map((row) => row.sender)].map((item) => String(item || '').toLowerCase()).filter(Boolean));
  let missing = 0;
  const byKey = new Map();
  for (const row of rows) {
    const box = isSent(row) ? 'sent' : 'inbox';
    const path = files.get(String(row.id));
    const raw = path ? await readFile(path).then(rawMessage).catch((error) => { if (denied(error)) throw noAccess(); return null; }) : null;
    if (!raw) missing += 1;
    const headers = raw ? headersOf(raw) : {};
    const sender = String(row.sender || '').toLowerCase();
    const from = decodeHeader(headers.from || '') || (row.name ? `${row.name} <${sender}>` : sender);
    const body = cutQuoted((raw ? plainText(raw) : '') || row.summary || '');
    const messageId = (String(headers['message-id'] || '').match(IDS) || [null])[0];
    const message = {
      key: messageId || `<apple-mail-${row.id}>`,
      references: String(headers.references || '').match(IDS) || [],
      inReplyTo: String(headers['in-reply-to'] || '').match(IDS) || [],
      id: `apple-mail-${row.id}`,
      threadId: null,
      messageId,
      from,
      to: decodeHeader(headers.to || '') || String(row.recipients || ''),
      cc: decodeHeader(headers.cc || '') || String(row.copied || ''),
      subject: decodeHeader(headers.subject || '') || row.subject || '',
      timestamp: new Date(Number(box === 'sent' ? row.sent : row.received) * 1000).toISOString(),
      body,
      snippet: body.slice(0, 200),
      labels: [box === 'sent' ? 'SENT' : 'INBOX'],
      attachments: [],
      rawLinks: extractRawLinks('', body),
      fromMe: box === 'sent' || owners.has(addressOf(from)),
      source: 'apple-mail',
    };
    // One message in both folders (sent to oneself) is kept once, as sent.
    const seen = byKey.get(message.key);
    if (!seen || (box === 'sent' && !seen.labels.includes('SENT'))) byKey.set(message.key, message);
  }
  const messages = [...byKey.values()];
  const threads = threadMessages(messages, [...owners]);
  const days = messages.map((message) => message.timestamp.slice(0, 10)).sort();
  return {
    threads,
    counts: { inbox: messages.filter((message) => message.labels.includes('INBOX')).length, sent: messages.filter((message) => message.labels.includes('SENT')).length,
      threads: threads.length, missing, first: days[0], last: days.at(-1) },
  };
}
