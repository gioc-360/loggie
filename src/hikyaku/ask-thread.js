// Which of a person's email threads an ask answers (loggie-ask-thread, 2026-10-12). "email <professor> sending
// my assignment 2" used to answer her newest email, a thread sent to someone else with the user only on Cc, and the
// user meant an earlier thread where she had offered extra time on the assignment. Pure: the caller reads the mail (sent-mail.js readInboxMail).
//
// The rule, from a replay of the user's own sent replies (docs/ask-box/thread.md): most real replies carry no words
// that name a thread ("No worries!"), and those answer the newest one, so the newest thread stays the default, except
// a thread where the user was only on Cc. A different thread wins only when the line has words that are in it and in
// few of the person's other threads, and none of them are in the default. New email is never a guess: the user picks
// it in the box (or the person has no thread at all).

// "Re:", "Fwd:", the other languages' prefixes, and calendar answers: "Accepted: Coffee chat" belongs to "Coffee chat".
const PREFIX = /^\s*((re|fw|fwd|aw|sv|vs|antw|回覆|回复|答复|转发|accepted|declined|tentative|canceled|cancelled|updated invitation|invitation)\s*[:：]\s*)+/i;
const CALENDAR = /^\s*(accepted|declined|tentative|canceled|cancelled|updated invitation|invitation)\s*[:：]/i;
export const threadKey = (subject = '') => String(subject).replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
// The subject as the user would say it: no "Re: Re:".
export const cleanSubject = (subject = '') => String(subject).replace(PREFIX, '').replace(/\s+/g, ' ').trim();

// Words that say nothing about which thread: common English, greetings and titles, courtesies, sign-offs, time words, the
// verbs of sending itself. The replay found each kind pulling a reply into the wrong thread ("professor", "next",
// "where", "first", "sign").
const STOP = new Set(`the and for you your with that this have has are was were will would can could just about from
what when where which who whom whose why how then them they their there here our ours out not but all any get got its
it's i'm i'll i've i'd you're we're let's thanks thank best hi hey hello dear please know sure okay yes also some more
most very much one two did does done been being into over under than too via per new send sending sent email mail
reply like make made take want need see look let way well still even back again first last next before after while
during since until today tomorrow yesterday week weeks day days time times morning afternoon evening night soon now
later meet meeting call chat talk work working think thought going good great regards cheers kind sincerely warm
professor prof doctor mr mrs ms team everyone all both each other such only own same should may might must shall
these those because only just really worry worries sorry apologize sound sounds fine perfect awesome cool noted received`.split(/\s+/));
// A date said either way is one word: "Oct 22" and "October 22nd" share "oct" and "22" (2026-10-17: "$500" pulled a
// K-House reply into an older thread because "Oct 22" never matched "October 22nd").
const MONTHS = { january: 'jan', february: 'feb', march: 'mar', april: 'apr', june: 'jun', july: 'jul', august: 'aug',
  september: 'sep', sept: 'sep', october: 'oct', november: 'nov', december: 'dec' };
// Plural and -ing/-ed off, the same way for every form: "classes" and "class", "sending" and "send".
const stem = (word) => {
  if (MONTHS[word]) return MONTHS[word];
  const ordinal = /^(\d{1,2})(st|nd|rd|th)$/.exec(word);
  if (ordinal) return String(Number(ordinal[1]));
  if (/\d/.test(word)) return word;
  if (/sses$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word) && word.length > 3) word = word.slice(0, -1);
  if (/ing$/.test(word) && word.length > 5) return word.slice(0, -3);
  if (/ed$/.test(word) && word.length > 4) return word.slice(0, -2);
  return word;
};
// A line's words that could name a thread: lowercase, three letters or more (or with a digit), stemmed, unique.
export function lineWords(text = '') {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words.filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)).map(stem))];
}

const addressOf = (from = '') => (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value : String(value || '').split(',')).map((a) => a.trim().toLowerCase()).filter(Boolean);

// The person's threads, newest first: { id, key, subject, at, ccOnly, count, target, messages, words }. `target` is the newest
// email from the person in the thread (a calendar answer is never one); `id` is that email's id, which the box sends
// back when the user picks the thread. `own` are the user's addresses, for the Cc rule.
export function threadsFrom(mail, address, own = []) {
  const person = String(address || '').toLowerCase();
  const mine = new Set(own.map((a) => String(a).toLowerCase()));
  const groups = new Map();
  for (const message of mail || []) {
    if (addressOf(message.from) !== person) continue;
    const key = threadKey(message.subject);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  const threads = [];
  for (const [key, messages] of groups) {
    messages.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    const target = messages.find((m) => !CALENDAR.test(m.subject || ''));
    if (!target) continue;
    const to = listOf(target.to), cc = listOf(target.cc);
    threads.push({
      id: target.id, key, subject: cleanSubject(target.subject) || '(no subject)', at: target.timestamp, count: messages.length,
      // Sent to someone else, the user only copied: answering it is rarely what "email <person>" means.
      ccOnly: cc.some((a) => mine.has(a)) && !to.some((a) => mine.has(a)),
      target,
      // Every email from the person in the thread, newest first: the reply's history (ask-reply.js threadFor).
      messages,
      words: new Set(lineWords(messages.map((m) => `${m.subject || ''} ${m.body || m.snippet || ''}`).join(' '))),
    });
  }
  return threads.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// { thread, how, matched, others }. `how`: 'only' (one thread), 'newest', 'not-cc' (the newest was Cc-only, so the
// newest one sent to the user), 'words' (the line's words point at another thread), 'none' (no thread: a new email).
// `others` are the rest, newest first, for the box's chooser.
export const SWITCH_SCORE = 1;
export function pickThread(line, threads) {
  if (!threads?.length) return { thread: null, how: 'none', matched: [], others: [] };
  const fallback = threads.find((t) => !t.ccOnly) || threads[0];
  // The person's own name names the person, not a thread (it sits in quotes and signatures).
  const name = new Set(lineWords(String(threads[0].target?.from || '').replace(/<[^>]*>/, '')));
  const words = lineWords(line).filter((w) => !name.has(w));
  const spread = (w) => threads.filter((t) => t.words.has(w)).length;
  // A word in every thread names none of them.
  // A bare number never moves a reply on its own: "$500" in a bar-tab line matched a room price in an older thread
  // (2026-10-17). Numbers still count once a word does, and a date's day counts with its month ("Oct 22").
  const scored = threads.map((t) => {
    const hits = words.filter((w) => t.words.has(w) && spread(w) < threads.length);
    const lettered = hits.filter((w) => /\p{L}/u.test(w));
    return { t, hits, score: lettered.length ? hits.reduce((sum, w) => sum + 1 / spread(w), 0) : 0, lettered: lettered.length };
  });
  const own = scored.find((s) => s.t === fallback);
  const best = [...scored].sort((a, b) => b.score - a.score || String(b.t.at).localeCompare(String(a.t.at)))[0];
  // Leaving the newest thread takes two of the line's words (numbers not counted): one word ("bar" in "bar & lounge")
  // is too often a coincidence in an older thread with the same person.
  const switched = best.t !== fallback && best.score >= SWITCH_SCORE && best.lettered >= 2 && own.hits.length === 0;
  const thread = switched ? best.t : fallback;
  const how = threads.length === 1 ? 'only' : switched ? 'words' : thread === threads[0] ? 'newest' : 'not-cc';
  const matched = (switched ? best : own).hits;
  return { thread, how, matched, others: threads.filter((t) => t !== thread) };
}

// What the box shows and sends back: no bodies, no Sets.
export const threadBrief = (t) => (t ? { id: t.id, subject: t.subject, at: t.at, ccOnly: t.ccOnly, count: t.count } : null);
