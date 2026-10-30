// The introductions replay (loggie-intros I2, docs/intros/spec.md 1.8), read only: Apple Mail's Inbox over --days
// routed again as the change check would route it, against the live change log, and every introduction in a thread
// the user wrote in, with its workspace, the "written since" check, the ask box's answer and its move. Writes no file;
// prints dates, counts and domains unless --show (then names, addresses and subjects, on this Mac only).
//   node scripts/intros/replay.mjs [--days 60] [--domain <d>] [--show] [--move-check] [--home <hikyaku home>]
// Exit 0 clean, 1 when a line says WRONG, 2 when a read fails (Full Disk Access, no Mail account).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from '../../src/hikyaku/draft.js';
import { FEW, buildWhoIndex, resolveWho, whoPeople } from '../../src/hikyaku/ask-who.js';
import { readChanges } from '../../src/hikyaku/changes.js';
import { introsIn, mailNames, movable } from '../../src/hikyaku/introduced.js';
import { adversarialCheck, moveCheck, replayReport } from '../../src/hikyaku/intro-replay.js';
import { loadPeople } from '../../src/hikyaku/people.js';
import { MACHINE, learnPeople, learnThreads, route, threadMap } from '../../src/hikyaku/router.js';
import { cutQuoted, mailAddresses, readInboxMail, readMailPeople, readSentMail } from '../../src/hikyaku/sent-mail.js';
import { outlookItems } from '../../src/hikyaku/sources.js';
import { isKept, readWorkstreams } from '../../src/hikyaku/workstreams.js';

const argv = process.argv.slice(2);
const value = (flag, fallback) => { const at = argv.indexOf(flag); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const days = Number(value('--days', 60));
const domain = value('--domain', null);
const show = argv.includes('--show');
const checkMoves = argv.includes('--move-check');
const home = value('--home', process.env.LOGGIE_DATA_DIRECTORY ? join(process.env.LOGGIE_DATA_DIRECTORY, 'hikyaku') : HIKYAKU_HOME);
if (!Number.isFinite(days) || days <= 0) { console.log('replay: --days takes a number of days'); process.exit(2); }

const HEADER = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const headerAddresses = (text) => (String(text || '').match(HEADER) || []).map((address) => address.toLowerCase());

let read;
try {
  const started = Date.now();
  const now = Date.now();
  const own = (await mailAddresses()).map((address) => address.toLowerCase());
  if (!own.length) throw new Error('Apple Mail has no mail account on this Mac.');
  const sent = await readSentMail({ address: own, days: 120 });
  const writtenTo = new Set(sent.flatMap((row) => row.to || []));
  // Gates 2 and 3 on headers, before any message file is opened.
  const keep = (message) => {
    const sender = headerAddresses(message.from)[0];
    const recipients = new Set([...headerAddresses(message.to), ...headerAddresses(message.cc)]);
    return Boolean(sender) && !own.includes(sender) && !MACHINE.test(sender) && writtenTo.has(sender) && recipients.size <= FEW;
  };
  const [candidates, mail, workstreams, logged, runsText, threadPeople] = await Promise.all([
    readInboxMail({ address: own, days, keep }),
    readMailPeople({ address: own, days: 60 }),
    readWorkstreams(home),
    readChanges(home),
    readFile(join(home, 'runs.jsonl'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }),
    loadPeople({ home }),
  ]);
  // The filing read: what the change check would see by date, nothing skipped, its Inbox rows kept for the who index.
  const inbox = [];
  const readInbox = async (options) => { const rows = await readInboxMail(options); inbox.push(...rows); return rows; };
  const { items } = await outlookItems({ readInbox, address: own, ownAddresses: own, since: new Date(now - days * 86400000).toISOString(), afterRow: null, logged: new Set(), now });
  const learned = await learnPeople({ home, workstreams, ownAddresses: own });
  const threads = threadMap(logged, await learnThreads({ home, workstreams, ownAddresses: own }));
  const routed = items.map((item) => ({ ...item, ...route(item, { workstreams, learned, threads }) }));
  read = { started, own, sent, candidates, mail, workstreams, logged, runsText, threadPeople, inbox, routed };
} catch (error) {
  console.log(`replay: a read failed, nothing was checked: ${error.message}`);
  process.exit(2);
}

const { started, own, sent, candidates, mail, workstreams, logged, runsText, threadPeople, inbox, routed } = read;
const runs = runsText.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((line) => line?.refresh === true && line.counts?.outlook)
  .map((line) => ({ at: Date.parse(line.at), outlookOk: line.counts.outlook.skipped !== true && !(line.errors || []).some((error) => error.source === 'outlook') }));

// Threads as the catch-up holds them: Inbox candidates and Sent rows, one per Apple Mail conversation.
const byConversation = new Map();
const add = (key, message) => {
  const thread = byConversation.get(key) || { id: `outlook:${key}`, sourceType: 'manual', subject: message.subject, messages: [] };
  thread.messages.push(message);
  byConversation.set(key, thread);
};
for (const message of candidates) add(message.conversation || message.id, message);
for (const row of sent) add(row.conversation || row.id, { id: row.id, from: row.from, to: (row.to || []).join(', '), cc: '', subject: row.subject, timestamp: row.timestamp, body: cutQuoted(row.body || ''), source: 'outlook' });
const mailThreads = [...byConversation.values()].map((thread) => {
  thread.messages.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return { ...thread, subject: thread.messages[0].subject, latestTimestamp: thread.messages.at(-1).timestamp };
});

const intros = introsIn(mailThreads, { own, writtenTo: new Set(sent.flatMap((row) => row.to || [])), names: mailNames(mail) });
const entries = buildWhoIndex({ inbox, mail, people: [...intros.map(({ name, address }) => ({ name, address })), ...whoPeople({ workstreams, threadPeople })], own });
const byRef = new Map(routed.map((item) => [item.ref, item]));
const threadOf = new Map(mailThreads.map((thread) => [thread.id, thread]));
const rows = intros.map((intro) => {
  const workspace = byRef.get(intro.message)?.workstream || null;
  const w = workstreams.find((item) => item.name === workspace);
  const written = sent.find((row) => Date.parse(row.timestamp) > Date.parse(intro.at) && (row.to || []).includes(intro.address))?.timestamp || null;
  const answer = resolveWho(intro.name, entries, { app: 'outlook', action: 'reply' });
  const emails = [answer.pick, ...(answer.candidates || [])].filter(Boolean).map((entry) => entry.email);
  return { intro, workspace, kept: Boolean(w && isKept(w)), written, ask: { status: answer.status, holds: emails.includes(intro.address) },
    check: checkMoves && intro.shape === 'body' ? moveCheck(threadOf.get(intro.thread), intro, { own }) : null };
});
const adversarial = checkMoves ? adversarialCheck(mailThreads, { own, movable: movable(intros, sent) }) : null;

const report = replayReport({ routed, logged, runs, workstreams, intros: rows, adversarial }, { days, ms: Date.now() - started, show, domain });
for (const line of report.lines) console.log(line);
process.exit(report.exit);
