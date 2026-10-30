// Reads the user's mail through Apple Mail: every account in it (Microsoft, Google, other IMAP), spec W10.
// School mail often has two sides: Gmail (which Loggie reads) and Microsoft (where Outlook sends from).
// Without this, a reply sent from Outlook is invisible and the card still says it is the user's move.
// Read-only, and only the accounts whose address is the user's. It never reads another account,
// and it fails loud: "could not read" is an error, never an empty list.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SENT_FOLDER = /^(sent items|sent messages|sent mail|sent)$/i;
const INBOX_FOLDER = /^inbox$/i;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

const fullDisk = () => Object.assign(new Error('hikyaku cannot read Apple Mail. The Full Disk Access settings are open: switch on the app running Loggie, then restart it.'), { pane: 'full-disk-access' });
const refused = (error) => ['EPERM', 'EACCES'].includes(error?.code);

// "unable to open" is not always Full Disk Access (2026-10-28, teammates' mail fix 4): a store that is not there, or a
// file sqlite cannot open for another reason, read as "switch on Full Disk Access" and sent people to the wrong pane.
// So the file is looked at: macOS refusing it is Full Disk Access, a missing one says so, else what sqlite said.
export async function sqliteJson(file, sql, { execImpl = run, statImpl = stat } = {}) {
  try {
    const { stdout } = await execImpl('/usr/bin/sqlite3', ['-readonly', '-json', `file:${file}?mode=ro`, sql], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (error) {
    const said = `${error.stderr || ''} ${error.message}`;
    if (/authorization denied|not permitted/i.test(said)) throw fullDisk();
    if (/unable to open/i.test(said)) {
      const why = await statImpl(file).then(() => null, (problem) => problem);
      if (refused(why)) throw fullDisk();
      if (why?.code === 'ENOENT') {
        const what = file.endsWith('Envelope Index') ? 'mail store' : 'account list';
        throw Object.assign(new Error(`Apple Mail has no ${what} at ${file} yet. Open Mail once, add your account and let it finish syncing.`), { missing: file });
      }
      throw new Error(`Apple Mail's ${file} could not be opened: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
    throw error;
  }
}

// Apple Mail's store folder (2026-10-28, fix 4): the newest V<n> under ~/Library/Mail that has an Envelope Index, the
// rule permissions.js reads Full Disk Access with. The readers hard-coded V10, so on a Mac whose Mail writes V9 or V11
// setup said "granted" and nothing was read. A folder that cannot be listed (no Mail yet, or Full Disk off) falls back
// to V10 with version null, and the open of its index then says what failed.
export async function mailStore({ home = homedir(), readdirImpl = readdir, statImpl = stat } = {}) {
  const base = join(home, 'Library', 'Mail');
  const names = await readdirImpl(base).catch(() => []);
  for (const version of names.filter((name) => /^V\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
    const index = join(base, version, 'MailData', 'Envelope Index');
    if (await statImpl(index).then(() => true, () => false)) return { version, root: join(base, version), index };
  }
  return { version: null, root: join(base, 'V10'), index: join(base, 'V10', 'MailData', 'Envelope Index') };
}

// The Microsoft (Exchange) addresses this Mac has in Internet Accounts, read-only. The morning pick reads Sent with
// the first one when settings.json names no address of the user's (gather.js).
export async function exchangeAddresses({ home = homedir(), query = sqliteJson } = {}) {
  const rows = await query(join(home, 'Library', 'Accounts', 'Accounts4.sqlite'), `
    select distinct lower(a.ZUSERNAME) as address from ZACCOUNT a join ZACCOUNTTYPE t on t.Z_PK = a.ZACCOUNTTYPE
    where t.ZIDENTIFIER = 'com.apple.account.Exchange' and a.ZUSERNAME like '%@%'`);
  return rows.map((row) => row.address);
}

// Every Apple Mail account with mail, read-only (spec W10). A mail account is an Exchange or IMAP account; a Google
// account in Internet Accounts is a parent whose IMAP child has no username, so the child takes the parent's address.
// iCloud (an IMAP child of an Apple ID) is never given the Apple ID as its address: it is listed with no address and
// skipped (2026-10-17: 1 sent message in 30 days on Gio's Mac). Mailbox urls carry the child's id.
const ACCOUNT_SQL = `
    select a.ZIDENTIFIER as id, t.ZIDENTIFIER as type, coalesce(pt.ZIDENTIFIER, '') as parent,
      lower(case when coalesce(pt.ZIDENTIFIER, '') = 'com.apple.account.AppleAccount' then ''
        when a.ZUSERNAME like '%@%' then a.ZUSERNAME when p.ZUSERNAME like '%@%' then p.ZUSERNAME else '' end) as address
    from ZACCOUNT a
    join ZACCOUNTTYPE t on t.Z_PK = a.ZACCOUNTTYPE
    left join ZACCOUNT p on p.Z_PK = a.ZPARENTACCOUNT
    left join ZACCOUNTTYPE pt on pt.Z_PK = p.ZACCOUNTTYPE
    where t.ZIDENTIFIER in ('com.apple.account.Exchange', 'com.apple.account.IMAP')`;
const kindOf = (row) => (row.type === 'com.apple.account.Exchange' ? 'exchange' : row.parent === 'com.apple.account.Google' ? 'google' : row.parent === 'com.apple.account.AppleAccount' ? 'icloud' : 'imap');

// -> [{ address, ids, kind }], Exchange first, then in the order Internet Accounts lists them. iCloud has address ''.
export async function mailAccounts({ home = homedir(), query = sqliteJson } = {}) {
  const rows = await query(join(home, 'Library', 'Accounts', 'Accounts4.sqlite'), ACCOUNT_SQL);
  const byKey = new Map();
  for (const row of rows) {
    const kind = kindOf(row);
    const key = row.address ? `${kind}:${row.address}` : `${kind}:${row.id}`;
    const seen = byKey.get(key) || { address: row.address || '', ids: [], kind };
    seen.ids.push(row.id);
    byKey.set(key, seen);
  }
  return [...byKey.values()].sort((a, b) => (a.kind === 'exchange' ? 0 : 1) - (b.kind === 'exchange' ? 0 : 1));
}

// Every address the user reads mail at in Apple Mail, Exchange first (ownAddresses in the app starts here).
export async function mailAddresses(options = {}) {
  return [...new Set((await mailAccounts(options)).map((account) => account.address).filter(Boolean))];
}

const asList = (address) => [...new Set((Array.isArray(address) ? address : [address]).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))];
const inList = (list) => list.map(quote).join(', ');
// Gmail keeps every message in All Mail; its INBOX and Sent Mail are labels on those rows (2026-10-17, the labels table).
const inBoxes = (ids) => `(m.mailbox in (${ids}) or m.ROWID in (select l.message_id from labels l where l.mailbox_id in (${ids})))`;

// The user's accounts in Apple Mail and the folders whose names match, read-only. Every reader starts here. `address`
// is one address or a list; an address with no account is ignored when another has one.
async function mailboxesFor({ address, home, query, folder, what, store = mailStore }) {
  const wanted = asList(address);
  if (!wanted.length) throw new Error(`hikyaku needs your email address before it can look for ${what}.`);
  const accounts = (await query(join(home, 'Library', 'Accounts', 'Accounts4.sqlite'), `${ACCOUNT_SQL}
      and coalesce(pt.ZIDENTIFIER, '') != 'com.apple.account.AppleAccount'
      and lower(case when a.ZUSERNAME like '%@%' then a.ZUSERNAME else coalesce(p.ZUSERNAME, '') end) in (${inList(wanted)})`))
    // The account's place in the user's list decides which copy of a repeated message is kept: Exchange first.
    .map((row) => ({ ...row, rank: (row.type === 'com.apple.account.Exchange' ? 0 : 1000) + Math.max(0, wanted.indexOf(row.address)) }))
    .sort((a, b) => a.rank - b.rank);
  if (!accounts.length) throw Object.assign(new Error(`This Mac has no mail account in Apple Mail for ${wanted.join(' or ')}. Internet Accounts is open: add that account and turn on Mail, so hikyaku can see ${what}.`), { pane: 'internet-accounts' });
  const { index, root: mailRoot } = await store({ home });
  const all = await query(index, 'select ROWID as id, url from mailboxes');
  const accountOf = (url) => accounts.find(({ id }) => String(url).includes(`://${id}/`)) || null;
  const owner = new Map(all.map((box) => [Number(box.id), accountOf(box.url)]));
  const boxes = all.filter((box) => owner.get(Number(box.id)) && folder.test(decodeURIComponent(box.url.split('/').pop() || '')));
  return { accounts, index, boxes, owner, mailRoot };
}

// For the doctor (spec W13): every account with its Inbox and Sent counts over `days`, headers only, read only.
// -> [{ address, kind, inbox, sent, newest, skipped }]; `skipped` says why an account is not read ('icloud',
// 'settings'). `newest` is the newest mail in its Inbox, ISO, any age, or null (2026-10-28, fix 1: the setup page shows
// it before Continue, so an account added but never synced reads as such, not as working).
export async function accountCounts({ home = homedir(), query = sqliteJson, days = 30, now = Date.now(), skip = [], store = mailStore } = {}) {
  const accounts = await mailAccounts({ home, query });
  const { index } = await store({ home });
  const boxes = await query(index, 'select ROWID as id, url from mailboxes');
  const since = Math.floor(now / 1000) - days * 86400;
  const skipped = new Set(skip.map((item) => String(item).toLowerCase()));
  const boxesOf = (account, folder) => boxes.filter((box) => account.ids.some((id) => String(box.url).includes(`://${id}/`)) && folder.test(decodeURIComponent(String(box.url).split('/').pop() || ''))).map((box) => Number(box.id));
  const count = async (account, folder, date) => {
    const ids = boxesOf(account, folder);
    if (!ids.length) return null;
    const [row] = await query(index, `select count(*) as n from messages m where ${inBoxes(ids.join(','))} and m.deleted = 0 and m.${date} >= ${since}`);
    return Number(row?.n) || 0;
  };
  const newest = async (account) => {
    const ids = boxesOf(account, INBOX_FOLDER);
    if (!ids.length) return null;
    const [row] = await query(index, `select max(m.date_received) as at from messages m where ${inBoxes(ids.join(','))} and m.deleted = 0`);
    return Number(row?.at) > 0 ? new Date(Number(row.at) * 1000).toISOString() : null;
  };
  return Promise.all(accounts.map(async (account) => {
    const why = !account.address ? 'icloud' : skipped.has(account.address) ? 'settings' : null;
    return { address: account.address, kind: account.kind, inbox: await count(account, INBOX_FOLDER, 'date_received'), sent: await count(account, SENT_FOLDER, 'date_sent'),
      newest: why ? null : await newest(account), skipped: why };
  }));
}

// The email a reply answers, in the user's Apple Mail Inbox (spec W11): by its Envelope Index row when the task kept it
// (`apple-mail-<rowid>`), else by sender, subject and a received time within 2 minutes. -> { rowId, accountId, mailbox,
// header } where `mailbox` is the Inbox's path in its account ("Inbox", "INBOX") and `header` the Message-ID without
// brackets; null when there is no such email. Read only.
export async function findInboxMessage({ address, from = '', subject = '', date = null, rowId = null, home = homedir(), query = sqliteJson }) {
  const { index, boxes, owner } = await mailboxesFor({ address, home, query, folder: INBOX_FOLDER, what: 'the email to answer' });
  if (!boxes.length) return null;
  const ids = boxes.map((box) => Number(box.id)).join(',');
  const at = Math.floor(Date.parse(date || '') / 1000);
  let where;
  if (Number(rowId) > 0) where = `m.ROWID = ${Number(rowId)}`;
  else if (from && Number.isFinite(at)) where = `lower(a.address) = ${quote(String(from).toLowerCase())} and m.date_received between ${at - 120} and ${at + 120}`;
  else return null;
  const rows = await query(index, `
    select m.ROWID as id, m.mailbox as mailbox, coalesce(m.subject_prefix, '') || coalesce(s.subject, '') as subject, g.message_id_header as header,
      (select l.mailbox_id from labels l where l.message_id = m.ROWID and l.mailbox_id in (${ids}) limit 1) as label
    from messages m
    left join subjects s on s.ROWID = m.subject
    left join addresses a on a.ROWID = m.sender
    left join message_global_data g on g.ROWID = m.global_message_id
    where ${where} and ${inBoxes(ids)} and m.deleted = 0
    order by m.date_received desc`);
  const row = rows.find((item) => !subject || baseSubject(item.subject) === baseSubject(subject));
  if (!row) return null;
  const boxId = boxes.some((box) => Number(box.id) === Number(row.mailbox)) ? Number(row.mailbox) : Number(row.label);
  const box = boxes.find((item) => Number(item.id) === boxId);
  const account = owner.get(boxId);
  if (!box || !account) return null;
  const marker = `://${account.id}/`;
  return { rowId: Number(row.id), accountId: account.id, mailbox: decodeURIComponent(box.url.slice(box.url.indexOf(marker) + marker.length)),
    header: String(row.header || '').replace(/^<|>$/g, '') };
}

// One message seen twice (two accounts, or two folders of one) shares global_message_id, Apple Mail's stand-in for the
// Message-ID header (2026-10-17: 1288 Cornell repeats in 30 days). The first copy in account order is kept.
function once(rows, owner) {
  const rank = (row) => owner.get(Number(row.mailbox))?.rank ?? 1e6;
  const kept = new Map();
  for (const row of rows) {
    const key = row.gid ? `g${row.gid}` : `r${row.id}`;
    const seen = kept.get(key);
    if (!seen || rank(row) < rank(seen)) kept.set(key, row);
  }
  return [...kept.values()];
}

export async function readSentMail({ address, days = 30, home = homedir(), query = sqliteJson, now = Date.now() }) {
  const { accounts, index, boxes, owner, mailRoot } = await mailboxesFor({ address, home, query, folder: SENT_FOLDER, what: 'what you send' });
  if (!boxes.length) throw new Error('Apple Mail has your mail account but no Sent folder yet. Open Mail and let it finish syncing.');

  const since = Math.floor(now / 1000) - days * 86400;
  const rows = once(await query(index, `
    select m.ROWID as id, m.mailbox as mailbox, m.global_message_id as gid, coalesce(m.subject_prefix, '') || coalesce(s.subject, '') as subject, m.date_sent as sent, su.summary as summary, m.conversation_id as conversation,
      (select group_concat(a.address, ',') from recipients r join addresses a on a.ROWID = r.address where r.message = m.ROWID) as recipients,
      (select group_concat(a.address, ',') from recipients r join addresses a on a.ROWID = r.address where r.message = m.ROWID and r.type = 1) as copied
    from messages m
    left join subjects s on s.ROWID = m.subject
    left join summaries su on su.ROWID = m.summary
    where ${inBoxes(boxes.map((box) => Number(box.id)).join(','))} and m.deleted = 0 and m.date_sent >= ${since}
    order by m.date_sent`), owner).sort((a, b) => Number(a.sent) - Number(b.sent));
  return Promise.all(rows.map(async (row) => {
    const account = owner.get(Number(row.mailbox)) || accounts[0];
    return {
      id: `apple-mail-${row.id}`,
      conversation: row.conversation ? String(row.conversation) : null,
      subject: row.subject || '',
      timestamp: new Date(Number(row.sent) * 1000).toISOString(),
      // The account it was sent from: with several accounts, the user's own message is from this address (spec W10).
      from: account.address || asList(address)[0],
      to: String(row.recipients || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
      // To only: who the email was written to, not who was copied. Apple Mail's index lists every recipient (type 0)
      // and the copied ones again (type 1), so To is the first list less the second (2026-10-17, checked on real mail).
      primary: ((copied) => String(row.recipients || '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => item && !copied.has(item)))(new Set(String(row.copied || '').split(',').map((item) => item.trim().toLowerCase()))),
      // The index can list a message minutes before it has its text; the message file on disk already has it.
      body: row.summary || await readEmlxBody(mailRoot, row.id, [account.id, ...accounts.map(({ id }) => id).filter((id) => id !== account.id)], readMessageFile).catch(() => ''),
    };
  }));
}

// What people sent to the user, in every account read. That mail may never reach Gmail, so without this a reply that
// came in through Outlook is invisible: 2026-10-06 a "Friday 1 pm" answer lived only there, and the workstream's
// Gmail thread had stopped two weeks earlier. Same accounts, same rules as readSentMail: read-only, the Inbox only.
// `keep` sees each message's headers (from, to, cc, subject) before any file is opened; only kept ones are read.
// `afterRow` (the change check's cursor, sources.js) keeps only rows Mail stored after that one, whatever their date,
// and never a second copy of a message Mail had already stored by then (the copies share global_message_id).
export async function readInboxMail({ address, days = 30, home = homedir(), query = sqliteJson, now = Date.now(), keep = () => true, bodies = true, read = null, afterRow = null }) {
  const { accounts, index, boxes, owner, mailRoot } = await mailboxesFor({ address, home, query, folder: INBOX_FOLDER, what: 'mail sent to you' });
  if (!boxes.length) throw new Error('Apple Mail has your mail account but no Inbox yet. Open Mail and let it finish syncing.');
  const since = Math.floor(now / 1000) - days * 86400;
  const stored = Number.isInteger(afterRow) ? ` and m.ROWID > ${afterRow} and not exists (select 1 from messages o where o.global_message_id = m.global_message_id and o.ROWID <= ${afterRow})` : '';
  const rows = once(await query(index, `
    select m.ROWID as id, m.mailbox as mailbox, m.global_message_id as gid, coalesce(m.subject_prefix, '') || coalesce(s.subject, '') as subject, m.date_received as received, m.conversation_id as conversation,
      su.summary as summary, a.address as sender, a.comment as name,
      (select group_concat(x.address, ',') from recipients r join addresses x on x.ROWID = r.address where r.message = m.ROWID and r.type = 0) as recipients,
      (select group_concat(x.address, ',') from recipients r join addresses x on x.ROWID = r.address where r.message = m.ROWID and r.type = 1) as copied
    from messages m
    left join subjects s on s.ROWID = m.subject
    left join summaries su on su.ROWID = m.summary
    left join addresses a on a.ROWID = m.sender
    where ${inBoxes(boxes.map((box) => Number(box.id)).join(','))} and m.deleted = 0 and m.date_received >= ${since}${stored}
    order by m.date_received`), owner).sort((a, b) => Number(a.received) - Number(b.received));
  const list = (value) => String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const messages = rows.map((row) => {
    const sender = String(row.sender || '').toLowerCase();
    return {
      id: `apple-mail-${row.id}`,
      rowId: row.id,
      account: (owner.get(Number(row.mailbox)) || accounts[0]).id,
      conversation: row.conversation ? String(row.conversation) : null,
      from: row.name ? `${row.name} <${sender}>` : sender,
      to: list(row.recipients).join(', '),
      cc: list(row.copied).join(', '),
      subject: row.subject || '',
      timestamp: new Date(Number(row.received) * 1000).toISOString(),
      summary: row.summary || '',
      source: 'outlook',
    };
  }).filter((message) => keep(message));
  // One walk of the folders of the accounts that hold kept messages finds every message file, instead of one walk per
  // message (a Gmail account in Mail can hold 80,000 files; only its account is walked when one of its messages is kept).
  const files = bodies && messages.length && !read ? await messageFiles(mailRoot, accounts.map(({ id }) => id).filter((id) => messages.some((message) => message.account === id))) : new Map();
  const readOne = read || (async (rowId) => { const path = files.get(String(rowId)); return path ? (await import('node:fs/promises')).readFile(path) : null; });
  return Promise.all(messages.map(async ({ rowId, summary, account, ...message }) => {
    // The message file first: the index summary is a preview, and THREAD.md needs what the person wrote, quotes cut.
    const body = bodies ? cutQuoted(await readOne(rowId).then((bytes) => (bytes ? emlxText(bytes) : '')).catch(() => '') || summary) : summary;
    return { ...message, body, snippet: body.slice(0, 200) };
  }));
}

// The people on the user's mail who never wrote to them: whoever the user sent to (Sent), and whoever else was on
// To or Cc of mail they got (Inbox). 2026-10-12 "email <ta>" found no one: the user had written to a professor
// and his TA had answered with him on Cc, but only senders were read. Headers only, no message file is opened.
// -> [{ address, name, at, sent: true | false, size }] one row per message and person; `name` is the name as that
// message wrote it ('' when it had none), `size` how many people the message had on To and Cc.
export async function readMailPeople({ address, days = 60, home = homedir(), query = sqliteJson, now = Date.now() }) {
  const since = Math.floor(now / 1000) - days * 86400;
  const read = async (folder, sent) => {
    const { index, boxes } = await mailboxesFor({ address, home, query, folder, what: 'who you write with' });
    if (!boxes.length) return [];
    const date = sent ? 'date_sent' : 'date_received';
    const rows = await query(index, `
      select a.address as address, coalesce(a.comment, '') as name, m.${date} as at, m.global_message_id as gid, m.ROWID as id,
        (select count(*) from recipients x where x.message = m.ROWID) as size
      from messages m
      join recipients r on r.message = m.ROWID
      join addresses a on a.ROWID = r.address
      where ${inBoxes(boxes.map((box) => Number(box.id)).join(','))} and m.deleted = 0 and m.${date} >= ${since}`);
    // A message in two accounts names each person once.
    const seen = new Set();
    return rows.filter((row) => { if (!row.gid) return true; const key = `${row.gid}|${String(row.address || '').toLowerCase()}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .map((row) => ({ address: String(row.address || '').trim().toLowerCase(), name: String(row.name || '').trim(), at: new Date(Number(row.at) * 1000).toISOString(), sent, size: Number(row.size) || 0 }));
  };
  const [sent, inbox] = await Promise.all([read(SENT_FOLDER, true), read(INBOX_FOLDER, false)]);
  return [...sent, ...inbox];
}

// Every <ROWID>.emlx under the accounts' folders, by ROWID, in one walk.
export async function messageFiles(mailRoot, accountIds) {
  const { readdir } = await import('node:fs/promises');
  const found = new Map();
  const walk = async (directory, depth) => {
    if (depth > 8) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      const match = entry.isFile() && /^(\d+)(?:\.partial)?\.emlx$/.exec(entry.name);
      if (match && !found.has(match[1])) found.set(match[1], path);
      if (entry.isDirectory() && (entry.name.endsWith('.mbox') || /^(Data|Messages|[0-9]+|[0-9A-F-]{36})$/.test(entry.name))) await walk(path, depth + 1);
    }
  };
  for (const id of accountIds) await walk(join(mailRoot, id), 0);
  return found;
}

// Only what this message added: the quoted history below it is already in the thread (or in the person's head).
// Outlook for Mac quotes with "From: ... / Date: ..." (2026-10-17: a K-House reply carried the whole booking thread).
export function cutQuoted(body = '') {
  return String(body).replace(/\r/g, '')
    .split(/\n(?:\s*\*?From:\*?\s[^\n]*\n\s*\*?(?:Sent|Date):|On [^\n]{6,120}wrote:|-{2,}\s*Original Message\s*-{2,}|_{10,})/i)[0]
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Apple Mail stores each message as <ROWID>.emlx: a byte count line, then the raw message. Found under the
// account's folders (Data/<digits>/Messages/), read-only, and only the plain text part is returned.
async function readMessageFile(mailRoot, accountIds, rowId) {
  const { readdir, readFile } = await import('node:fs/promises');
  const names = new Set([`${rowId}.emlx`, `${rowId}.partial.emlx`]);
  const walk = async (directory, depth) => {
    if (depth > 8) return null;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isFile() && names.has(entry.name)) return path;
      if (entry.isDirectory() && (entry.name.endsWith('.mbox') || /^(Data|Messages|[0-9]+|[0-9A-F-]{36})$/.test(entry.name))) {
        const found = await walk(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  for (const id of accountIds) {
    const file = await walk(join(mailRoot, id), 0);
    if (file) return readFile(file);
  }
  return null;
}

export async function readEmlxBody(mailRoot, rowId, accountIds, read = readMessageFile) {
  const bytes = await read(mailRoot, accountIds, rowId);
  return bytes ? emlxText(bytes) : '';
}

// An .emlx file is a byte-count line, the raw message, then Apple's own plist; only the message is read.
function emlxText(bytes) {
  const text = bytes.toString('latin1');
  const newline = text.indexOf('\n');
  const length = Number(text.slice(0, newline));
  return plainText(Buffer.from(text.slice(newline + 1, newline + 1 + (length || undefined)), 'latin1'));
}

// The text/plain part of a raw message, decoded (quoted-printable or base64, UTF-8).
export function plainText(raw) {
  const text = raw.toString('latin1');
  const split = (block) => { const at = block.search(/\r?\n\r?\n/); return at < 0 ? [block, ''] : [block.slice(0, at), block.slice(at).replace(/^\r?\n\r?\n/, '')]; };
  const header = (head, name) => (head.replace(/\r?\n[ \t]+/g, ' ').match(new RegExp(`^${name}:\\s*([^\\r\\n]*)`, 'im')) || [])[1] || '';
  const decode = (head, body) => {
    const encoding = header(head, 'Content-Transfer-Encoding').toLowerCase();
    let bytes;
    if (encoding.includes('base64')) bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (encoding.includes('quoted-printable')) bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    else bytes = Buffer.from(body, 'latin1');
    return bytes.toString('utf8').replace(/\r\n/g, '\n').trim();
  };
  // A message with no plain-text part (Workday and payroll mail is HTML only) gives its HTML part as text.
  let html = null;
  const find = (block) => {
    const [head, body] = split(block);
    const type = header(head, 'Content-Type').toLowerCase();
    const boundary = (header(head, 'Content-Type').match(/boundary="?([^";]+)"?/i) || [])[1];
    if (type.startsWith('multipart/') && boundary) {
      for (const part of body.split(`--${boundary}`).slice(1)) {
        if (part.startsWith('--')) break;
        const found = find(part.replace(/^\r?\n/, ''));
        if (found !== null) return found;
      }
      return null;
    }
    if (type.startsWith('text/html') && html === null) html = htmlText(decode(head, body));
    return !type || type.startsWith('text/plain') ? decode(head, body) : null;
  };
  return find(text) || html || '';
}

function htmlText(markup) {
  const entities = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', rarr: '→', mdash: '-', ndash: '-' };
  return markup.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (whole, name) => (name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : entities[name.toLowerCase()] ?? whole))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

// A subject without its Re:/Fwd: prefixes, for matching one thread's messages. A missing subject is '' (the copy in
// apple-mail-entry.js had the String(); the two copies it replaced did not).
export const baseSubject = (subject = '') => String(subject ?? '').replace(/^\s*((re|fw|fwd|aw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const addresses = (value = '') => (String(value).match(/[\w.+-]+@[\w.-]+/g) || []).map((item) => item.toLowerCase());
// The user's addresses, one or a list (spec W10b): `mine(who)` says whether an address is one of them, `first` is the
// one a message with no account of its own is written as from.
export function ownSet(ownAddress) {
  const list = asList(ownAddress);
  const set = new Set(list);
  return { list, first: list[0] || '', mine: (who) => set.has(String(who || '').toLowerCase()) };
}

// Adds each sent message to the thread it answers: same subject once Re:/Fwd: are stripped, and sent to
// someone already in the thread. Gmail's own copy wins if it is there, so nothing is counted twice.
export function mergeSent(threads, sent, ownAddress) {
  const own = ownSet(ownAddress);
  let added = 0;
  for (const message of sent) {
    const thread = threads.find((item) => baseSubject(item.subject) === baseSubject(message.subject)
      && (item.messages || []).some((existing) => [...addresses(existing.from), ...addresses(existing.to), ...addresses(existing.cc)].some((who) => !own.mine(who) && message.to.includes(who))));
    if (!thread) continue;
    const messages = thread.messages || [];
    const sameMinute = (existing) => addresses(existing.from).some(own.mine) && (existing.timestamp || '').slice(0, 16) === message.timestamp.slice(0, 16);
    if (messages.some((existing) => existing.id === message.id || sameMinute(existing))) continue;
    messages.push({ id: message.id, from: message.from || own.first, to: message.to.join(', '), cc: '', subject: message.subject, timestamp: message.timestamp, body: message.body, snippet: message.body, source: 'outlook' });
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    thread.messages = messages;
    thread.latestTimestamp = messages.at(-1).timestamp;
    added += 1;
  }
  return added;
}

// Puts what people sent to the user's Outlook address into the workstream's threads. A message joins the Gmail
// thread it answers (same subject once Re:/Fwd: are stripped, from someone already in it). One that answers nothing
// Gmail has, and `belongs` to the workstream, starts a thread of its own, one per Apple Mail conversation, with the
// user's Outlook-sent messages from that conversation. Core has no "outlook" source, so those threads are 'manual'
// with an "outlook:" id, as custom workstreams are. One message seen in both mailboxes (same sender, same subject,
// within 3 minutes) is counted once.
export function mergeInbox(threads, inbox, ownAddress, { belongs = () => false, sent = [] } = {}) {
  const own = ownSet(ownAddress);
  const near = (a, b) => Math.abs(Date.parse(a || 0) - Date.parse(b || 0)) < 3 * 60000;
  const seen = (message) => threads.some((thread) => (thread.messages || []).some((existing) => existing.id === message.id
    || (addresses(existing.from)[0] === addresses(message.from)[0] && near(existing.timestamp, message.timestamp)
      && baseSubject(existing.subject || thread.subject) === baseSubject(message.subject))));
  const result = { joined: 0, started: 0 };
  const started = new Map();
  for (const message of inbox) {
    const sender = addresses(message.from)[0];
    if (!sender || own.mine(sender) || seen(message)) continue;
    const thread = threads.find((item) => !String(item.id || '').startsWith('outlook:') && baseSubject(item.subject) === baseSubject(message.subject)
      && (item.messages || []).some((existing) => [...addresses(existing.from), ...addresses(existing.to), ...addresses(existing.cc)].includes(sender)));
    if (thread) {
      thread.messages = [...(thread.messages || []), message].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      thread.latestTimestamp = thread.messages.at(-1).timestamp;
      result.joined += 1;
      continue;
    }
    if (!belongs(message)) continue;
    const key = `outlook:${message.conversation || message.id}`;
    let fresh = started.get(key) || threads.find((item) => item.id === key);
    if (!fresh) {
      fresh = { id: key, sourceType: 'manual', subject: message.subject, messages: [] };
      threads.push(fresh);
      started.set(key, fresh);
      result.started += 1;
    }
    fresh.messages.push(message);
  }
  for (const thread of started.values()) {
    const conversation = thread.id.slice('outlook:'.length);
    const people = new Set(thread.messages.flatMap((message) => addresses(message.from)));
    for (const message of sent) {
      const inConversation = message.conversation ? message.conversation === conversation
        : baseSubject(message.subject) === baseSubject(thread.subject) && message.to.some((who) => people.has(who));
      if (!inConversation || thread.messages.some((existing) => existing.id === message.id)) continue;
      thread.messages.push({ id: message.id, from: message.from || own.first, to: message.to.join(', '), cc: '', subject: message.subject, timestamp: message.timestamp, body: cutQuoted(message.body), snippet: cutQuoted(message.body).slice(0, 200), source: 'outlook' });
    }
    thread.messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    thread.latestTimestamp = thread.messages.at(-1).timestamp;
  }
  return result;
}

// The inbox already holds most of what the user sent from Outlook: people quote it when they reply.
// Two quote styles: Gmail ("On <date> Sam Doe <sam@...> wrote:" then "> " lines) and
// Outlook ("From: ... / Sent: <date> / To: ... / Subject: ..." then the text). A quote only proves
// the message was sent before the reply that quotes it, so it can fix history, not who moves next.
const GMAIL_QUOTE = /On ([^\n]{6,60}?\d{4}(?:,?\s+(?:at\s+)?\d{1,2}:\d{2}(?:\s*[AP]M)?)?)[,\s]+([^<\n]{0,80}?)\s*<([^>\s]+@[^>\s]+)>\s+wrote:\s*\n((?:>[^\n]*\n?)+)/g;
const OUTLOOK_QUOTE = /(?:^|\n)\s*From:\s*([^\n]+)\n\s*Sent:\s*([^\n]+)\n(?:\s*To:[^\n]*\n)?(?:\s*Cc:[^\n]*\n)?\s*Subject:\s*([^\n]*)\n([\s\S]*?)(?=\n\s*From:\s|\n\s*On [^\n]*wrote:|$)/g;

function parseQuoteDate(text, fallback) {
  const cleaned = text.replace(/^[A-Za-z]+,\s*/, '').replace(/\s+at\s+/, ' ').replace(/ /g, ' ').trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export function quotedOwnMessages(message, ownAddress, ownNames = []) {
  const own = ownSet(ownAddress);
  const names = ownNames.map((name) => name.toLowerCase()).filter((name) => name.length > 3);
  const isOwn = (who) => addresses(who).some(own.mine) || names.some((name) => who.toLowerCase().includes(name));
  const body = String(message.body || '').replace(/\r/g, '');
  const before = message.timestamp ? new Date(Date.parse(message.timestamp) - 1000).toISOString() : null;
  const found = [];
  for (const match of body.matchAll(GMAIL_QUOTE)) {
    if (!isOwn(`${match[2]} <${match[3]}>`)) continue;
    const text = match[4].split('\n').filter((line) => /^>(?!>)/.test(line)).map((line) => line.replace(/^>\s?/, '')).join('\n').trim();
    found.push({ timestamp: parseQuoteDate(match[1], before), body: text.slice(0, 2000) });
  }
  for (const match of body.matchAll(OUTLOOK_QUOTE)) {
    if (!isOwn(match[1])) continue;
    // Mail flattened from HTML can lose the line break before the next quoted header, so cut there too.
    const text = match[4].split(/\s+From:\s|\s+On [^\n]{6,80}? wrote:/)[0].trim();
    found.push({ timestamp: parseQuoteDate(match[2], before), subject: match[3].trim(), body: text.slice(0, 2000) });
  }
  return found.filter((item) => item.timestamp && item.body);
}

// Puts quoted copies of the user's Outlook messages back into their threads, labelled as recovered from a quote.
export function mergeQuoted(threads, ownAddress) {
  const own = ownSet(ownAddress);
  const mineIn = (who) => addresses(who).some(own.mine);
  // The names the user signs with, as their own messages show them; Outlook quotes say "From: Last, First".
  const namesIn = (messages) => [...new Set(messages.filter((m) => mineIn(m.from)).map((m) => m.from.replace(/<[^>]*>/, '').replace(/"/g, '').trim()).filter(Boolean))];
  const allNames = namesIn(threads.flatMap((thread) => thread.messages || []));
  const withReversed = (names) => [...new Set(names.flatMap((name) => { const parts = name.split(/\s+/); return parts.length === 2 && !name.includes(',') ? [name, `${parts[1]}, ${parts[0]}`] : [name]; }))];
  let added = 0;
  for (const thread of threads) {
    const messages = thread.messages || [];
    const ownNames = withReversed(namesIn(messages).length ? namesIn(messages) : allNames);
    for (const message of [...messages]) {
      if (mineIn(message.from)) continue;
      for (const quoted of quotedOwnMessages(message, ownAddress, ownNames)) {
        const start = quoted.body.replace(/\s+/g, ' ').slice(0, 60);
        const known = messages.some((m) => mineIn(m.from) && (
          Math.abs(Date.parse(m.timestamp || 0) - Date.parse(quoted.timestamp)) < 3 * 60000
          || String(m.body || m.snippet || '').replace(/\s+/g, ' ').includes(start)));
        if (known) continue;
        messages.push({ id: `quoted-${message.id || ''}-${quoted.timestamp}`, from: own.first, to: message.from, cc: '', subject: quoted.subject || thread.subject, timestamp: quoted.timestamp, body: quoted.body, snippet: quoted.body.slice(0, 200), source: 'quoted' });
        added += 1;
      }
    }
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    thread.messages = messages;
    if (messages.length) thread.latestTimestamp = messages.at(-1).timestamp;
  }
  return added;
}

// "Accepted: Coffee chat" from someone means the user sent them an invite, wherever it was sent from.
export function calendarResponses(threads, ownAddress) {
  const own = ownSet(ownAddress);
  return threads.flatMap((thread) => (thread.messages || []).map((message) => {
    const match = /^(accepted|declined|tentatively accepted|tentative):\s*(.+)$/i.exec(String(message.subject || thread.subject || '').trim());
    if (!match || addresses(message.from).some(own.mine)) return null;
    return { who: addresses(message.from)[0] || message.from, name: message.from.replace(/<[^>]*>/, '').replace(/"/g, '').trim(), response: match[1].toLowerCase(), title: match[2].trim(), timestamp: message.timestamp };
  }).filter(Boolean));
}

// One call for the app: inbox quotes always, Apple Mail when it is set up. Never throws for a missing
// Apple Mail account; it says so instead, and that sentence is shown on the cards it affects.
// With `belongs` (a workstream catch-up), the Outlook inbox is read too and merged (mergeInbox); without it,
// nothing from the inbox is opened.
// `days` (optional) widens both reads: with Outlook as the only source (no Gmail threads), a catch-up reads 120 days.
export async function recoverSentMail(threads, ownAddress, { readSent = readSentMail, readInbox = readInboxMail, belongs = null, openPane, days = null } = {}) {
  const quoted = mergeQuoted(threads, ownAddress);
  const window = days ? { days } : {};
  let sent = [];
  let outcome;
  try {
    sent = await readSent({ address: ownAddress, ...window });
    outcome = { quoted, appleMail: 0, seesOutlook: true, note: null };
  } catch (error) {
    // The fix is a switch only the user can flip, so its window opens for them (rate-limited in openPane).
    if (error.pane) await (openPane || (await import('./settings-panes.js')).openPane)(error.pane).catch(() => {});
    outcome = { quoted, appleMail: 0, seesOutlook: false, note: error.message };
  }
  if (belongs) {
    try {
      const subjects = new Set(threads.map((thread) => baseSubject(thread.subject)));
      const inbox = await readInbox({ address: ownAddress, ...window, keep: (message) => subjects.has(baseSubject(message.subject)) || belongs(message) });
      outcome.inbox = mergeInbox(threads, inbox, ownAddress, { belongs, sent });
    } catch (error) {
      outcome.inbox = null;
      outcome.inboxNote = `Mail sent to you could not be read: ${error.message}`;
    }
  }
  outcome.appleMail = mergeSent(threads, sent, ownAddress);
  return outcome;
}
