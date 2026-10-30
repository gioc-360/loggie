// The thread picker against the user's own replies (loggie-ask-thread falsifier). Read-only: Apple Mail's copy of the
// Outlook account. For every reply the user sent ("Re:") to one person who had 2+ threads with them by then, the line
// is the reply's first sentence and the truth is the thread it went to. Prints counts; --show prints each case (on
// this Mac only: the cases are real subjects). Exit 1 when typed lines land under 80% or under the newest-email rule.
import { readInboxMail, readSentMail, cutQuoted, exchangeAddresses } from '../../src/hikyaku/sent-mail.js';
import { threadsFrom, pickThread, threadKey } from '../../src/hikyaku/ask-thread.js';

const show = process.argv.includes('--show');
const days = 90;
const own = await exchangeAddresses();
if (!own[0]) { console.log('No Outlook account in Apple Mail.'); process.exit(2); }
const started = Date.now();
const [inbox, sent] = await Promise.all([readInboxMail({ address: own[0], days }), readSentMail({ address: own[0], days })]);
console.log(`read ${inbox.length} inbox + ${sent.length} sent emails in ${Date.now() - started} ms`);
// Pasted links, forwarded headers and images are not lines anyone types into the box.
const typed = (line) => line.length >= 3 && !/^\[|^https?:|^microsoft teams|from: /i.test(line);
const tally = { all: [0, 0, 0], typed: [0, 0, 0] };
for (const reply of sent) {
  if (!/^\s*re\s*:/i.test(reply.subject)) continue;
  const to = reply.to.filter((a) => !own.includes(a));
  if (to.length !== 1) continue;
  const threads = threadsFrom(inbox.filter((m) => m.timestamp < reply.timestamp), to[0], own);
  if (threads.length < 2) continue;
  const truth = threadKey(reply.subject);
  if (!threads.some((t) => t.key === truth)) continue;
  const line = cutQuoted(reply.body || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].slice(0, 160);
  const pick = pickThread(line, threads);
  const ok = pick.thread?.key === truth, newestOk = threads[0].key === truth;
  for (const set of typed(line) ? ['all', 'typed'] : ['all']) { tally[set][0] += 1; tally[set][1] += ok; tally[set][2] += newestOk; }
  if (show) console.log(`${ok ? 'ok  ' : 'MISS'} ${newestOk ? '        ' : '(newest✗)'} ${pick.how.padEnd(6)} ${line.slice(0, 60).padEnd(60)} [${pick.matched.join(",")}] → ${pick.thread?.key.slice(0, 40)}${ok ? '' : `  (was ${truth.slice(0, 40)})`}`);
}
const pct = ([n, ok]) => (n ? Math.round((100 * ok) / n) : 0);
for (const set of ['all', 'typed']) console.log(`${set.padEnd(5)} picker ${tally[set][1]}/${tally[set][0]} (${pct(tally[set])}%)   newest-email rule ${tally[set][2]}/${tally[set][0]}`);
const pass = tally.typed[0] > 0 && pct(tally.typed) >= 80 && tally.typed[1] >= tally.typed[2];
console.log(pass ? 'PASS: typed lines >= 80% and never under the newest-email rule' : 'FAIL: typed lines under 80% or under the newest-email rule');
process.exit(pass ? 0 : 1);
