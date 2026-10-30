// The word map (loggie-ask-wordmap, mock https://claude.ai/artifact/Qj9k6p9QVpDDf6hCKPBUiR). One sentence from the ask
// box becomes its words, each with the role it plays, read in any order: a name is a name wherever it sits, a time
// looks like a time, and the small words say what comes next ("at" a time or a place, "for" a length, the kind of
// meeting or the subject, "on" a day, the app or the subject, "about" the subject, "saying" the message). Code only,
// no model: the same answer every time, and nothing leaves the Mac.
//
//   readWords(sentence, { isName, places, action }) -> {
//     action: 'invite' | 'message' | 'reply' | null, app: 'outlook' | 'google' | 'messages' | 'whatsapp' | null,
//     words: [{ text, start, end, role, group?, for? }],   // role: one of ROLES; `group` numbers the people in order
//     who: [text as typed], when: text, where: text, about: text, quote: text, kind: text, room: text, notes: bool,
//     unused: [text] }
//   isName(text, { loose }) -> true when `text` is someone the user knows. `loose` also allows the start of a name and
//     a one-letter slip, which only a word right after a name signal ("invite", "and", "with", "to", a comma) gets:
//     "lunch" is never read as "Lynch" in the middle of a sentence.
//
// The invite reader (quick-invite.js) reads its values out of these parts with the same PATTERNS, so what the box
// underlines is what the invite gets. Texts and replies keep ask.js's reader; markAsk() puts its answer back on the
// words so the box underlines that answer.

export const ROLES = Object.freeze(['action', 'who', 'when', 'where', 'about', 'kind', 'room', 'notes', 'message', 'app', 'mark', 'filler', 'unused']);
const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---- the patterns, shared with quick-invite.js ----
export const DAY = '(?:sun|mon|tue|tues|wed|weds|wednes|thu|thur|thurs|fri|sat|satur)(?:day)?s?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
export const PATTERNS = Object.freeze({
  google: /\b(?:(?:on|in|via|through|using) )?google(?: cal(?:endar)?)?\b|\bgcal\b/i,
  quote: /"([^"]{1,120})"|“([^”]{1,120})”/,
  notes: /\bwith (?:the )?(?:call )?notes(?: from (?:the )?last (?:call|meeting))?\b/i,
  outlook: /\b(?:(?:in|on|via|through|using) )?outlook(?: calendar)?\b/i,
  kind: /\b(?:(?:for|to|into) )?(?:(?:a|an|quick|short|our|my|the|weekly|daily) )*(phone call|video call|zoom call|teams call|coffee chat|call|zoom|coffee|lunch|breakfast|dinner|drinks|chat|sync|catch-?up|check-?in|1:1|one on one|meeting|meetup)\b/i,
  repeatDays: new RegExp(`\\b(?:every|on) (${DAY}(?:(?:, ?| and | ?& ?| ?\\/ ?)${DAY})+)\\b`, 'i'),
  repeatDay: new RegExp(`\\bevery (${DAY})\\b`, 'i'),
  everyOther: /\b(?:every other (day|week|month|year)|bi-?weekly|fortnightly)\b/i,
  everyN: /\bevery (\d{1,2}) (days?|weeks?|months?|years?)\b/i,
  daily: /\b(?:every ?day|daily)\b/i,
  weekly: /\b(?:every ?week|weekly)\b/i,
  monthly: /\b(?:every ?month|monthly)\b/i,
  yearly: /\b(?:every ?year|yearly|annually)\b/i,
  until: /\b(?:until|through|till|thru) (?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})|(\d{1,2})\/(\d{1,2}))\b/i,
  times: /\b(?:for (\d{1,2}) (?:weeks|days|months|occurrences|sessions|meetings)|(\d{1,2}) times)\b/i,
  forever: /\b(?:forever|with no end|no end date)\b/i,
  length: /\bfor (?:(an?|half an?|one) (?:hour|hr)|(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?))\b/i,
  // "a 30 min sync", "2 hours", "half an hour" without "for" (never "in 2 hours")
  lengthBare: /(?<!\bin )\b(?:(half an?|an?|one) (?:hour|hr)|(\d+(?:\.\d+)?)[\s-]?(h|hrs?|hours?|m|mins?|minutes?))\b(?!\s*(?:ago|late|early|before|after))/i,
  partOfDay: /\b(?:(?:in the |this )?(?:morning|afternoon|evening)|tonight|night|eod|end of day|lunchtime|after lunch|before lunch)\b/i,
  week: /\b(this|next) week\b/i,
  room: /\b(?:book )?(?:a )?room (?:in |at )?([A-Z][\w'-]*(?: (?!(?:floors?|next|this|on|at|for|with|today|tomorrow|weekly|daily|monthly)\b)[A-Z][\w'-]*)?)(?: (?:on )?floors? (\d)(?: (?:or|and|,) ?(\d))?)?/,
  // "1730", "530pm", "5:30pm", "17:30", "noon"; "at 5" is in `hour`
  time: /\b(?:(?:at|@|by|around) )?(noon|midday|(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)|([01]?\d|2[0-3]):([0-5]\d)|([01]\d|2[0-3])([0-5]\d)(?:\s*h(?:rs?)?)?)(?![\w:])/i,
  hour: /(?:\b(?:at|by|around)|@) ?(1[0-2]|[1-9])(?![\w:./])/i,
  today: /\b(today|tonight|tomorrow|tmrw|tmr|tomorow|tommorow|tommorrow|2morrow)\b/i,
  weekday: new RegExp(`\\b(?:on )?(next |this )?(${DAY})\\b`, 'i'),
  date: new RegExp(`\\b(?:on )?(?:(${MONTH}) (\\d{1,2})(?:st|nd|rd|th)?|(1[0-2]|0?[1-9])[\\/-]([12]\\d|3[01]|0?[1-9]))\\b(?![:\\d]|\\s*(?:am|pm))`, 'i'),
});

// ---- words ----
// Words people mistype that the reader keys on, fixed before reading when one letter is off ("schdule", "meetin",
// "calender", "tommorow"). A word that is someone's name is never "fixed".
const VOCAB = ['schedule', 'invite', 'meeting', 'calendar', 'tomorrow', 'message', 'whatsapp', 'imessage', 'regarding', 'minutes', 'saying', 'breakfast', 'dinner', 'coffee', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'about'];
function oneOff(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c === b[i] ? -1 : i)).filter((i) => i >= 0);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
  }
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// The sentence with mistyped key words fixed, word for word (the count of words never changes, so each word keeps
// its place for the box).
export function corrected(sentence, isName = () => false) {
  const text = String(sentence || '');
  let out = text;
  for (const w of tokenize(text).reverse()) {
    if (!/^[a-z]{5,}$/.test(w.n) || VOCAB.includes(w.n) || FILLER.has(w.n) || isName(w.n, { loose: false })) continue;
    const fix = VOCAB.find((v) => oneOff(v, w.n));
    if (fix) out = out.slice(0, w.start) + fix + out.slice(w.start + w.n.length);
  }
  return out;
}
// One word per run of letters (an address, "1:1", "don't" stay whole), each run of punctuation on its own.
export function tokenize(sentence) {
  const text = String(sentence || '');
  const words = [];
  const re = /"[^"]*"?|“[^”]*”?|[^\s,;!?"“”]+|[,;!?]+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    let n = fold(raw).replace(/^[(\[]+/, '').replace(/[)\].]+$/, '');
    const colon = /[^:\d]:$/.test(n) || n === ':';
    if (colon) n = n.replace(/:+$/, '');
    words.push({ text: raw, n, bare: n.replace(/['’]s$/, ''), start: m.index, end: m.index + raw.length, colon, role: null });
  }
  return words;
}

export const FILLER = new Set(['a', 'an', 'the', 'please', 'pls', 'plz', 'can', 'could', 'would', 'will', 'you', 'u', 'loggie', 'hey', 'hi', 'ok', 'okay', 'so', 'um', 'uh',
  'and', 'to', 'for', 'with', 'up', 'set', 'me', 'us', 'my', 'our', 'just', 'quick', 'quickly', 'also', 'then', 'go', 'ahead', 'new', 'into', 'i', "i'd", "i'll", 'im', "i'm",
  'want', 'wanna', 'need', 'let', "let's", 'lets', 'like', 'send', 'make', 'create', 'put', 'add', 'get', 'them', 'him', 'her', 'both', 'all', 'of', 'together',
  'invite', 'invites', 'invitation', 'event', 'calendar', 'it', 'something', 'some', 'time', 'thx', 'thanks', 'ty', 'rn', 'asap', 'real', 'actually',
  'maybe', 'probably', 'kindly', 'should', 'do', 'have', 'has', 'is', 'are', 'be', 'on', 'at', 'in', 'about', 're', 'regarding', 'by', 'or', 'yo', 'sure',
  'schedule', 'book', 'meet', 'setup', 'sched', 'inv', 'w', 'w/', 'out', 'outlook', 'there', 'here', 'k', 'gonna', 'gotta', 'one', 'we', 'lets', 'go', 'shall',
  'need', 'needs', 'quick', 'pencil', 'block', 'grab', 'hop', 'arrange', 'organize', 'plan', 'invite', 'cal', 'meeting', 'invites', 'call']);
const JOIN = new Set(['and', '&', '+', ',', 'plus', 'with', 'n', '/', 'w', 'w/']);
const PUNCT = /^[.,;:!?]+$/;
const SIGNAL = /^(?:about|re|regarding|subject|at|in|@|for|on|with|by|to)$/;

const ACTIONS = {
  invite: ['invite', 'outlook'], invites: ['invite', 'outlook'], inv: ['invite', 'outlook'], schedule: ['invite', 'outlook'], sched: ['invite', 'outlook'],
  book: ['invite', 'outlook'], meet: ['invite', 'outlook'], setup: ['invite', 'outlook'], invitation: ['invite', 'outlook'],
  text: ['message', null], txt: ['message', null], message: ['message', null], msg: ['message', null], imessage: ['message', 'messages'], sms: ['message', 'messages'],
  dm: ['message', null], tell: ['message', null], ask: ['message', null], ping: ['message', null], remind: ['message', null], shoot: ['message', null],
  whatsapp: ['message', 'whatsapp'], wa: ['message', 'whatsapp'], whatsap: ['message', 'whatsapp'],
  email: ['reply', 'outlook'], mail: ['reply', 'outlook'], 'e-mail': ['reply', 'outlook'], reply: ['reply', null], respond: ['reply', null],
};
// These double as ordinary words, so they act only as the first real word or right before a name.
const SOFT_ACTIONS = /^(?:message|msg|text|txt|mail|meet|book|schedule|sched|tell|ask|ping|remind|shoot|dm|reply|respond)$/;

// Every match of a pattern over the parts of the sentence not yet claimed; `each` may veto one by returning false.
function claimAll(text, words, pattern, role, each = () => {}) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].length) { re.lastIndex++; continue; }
    const covered = words.filter((w) => !(w.end <= m.index || w.start >= m.index + m[0].length));
    if (covered.some((w) => w.role && w.role !== 'action')) { re.lastIndex = m.index + 1; continue; }
    if (each(m, covered) === false) continue;
    for (const w of covered) if (!w.role) w.role = role;
  }
}
const TIME_WORD = /^(?:noon|midday|\d{1,2}(?::\d{2})?(?:am|pm|a|p)|\d{1,2}:\d{2}|[01]\d[0-5]\d|2[0-3][0-5]\d)$/;
const DAY_WORD = new RegExp(`^(?:${DAY}|today|tonight|tomorrow|tmrw|tmr|tomorow|tommorow|tommorrow)$`);

// The people: the longest run of up to three words that is someone the user knows, anywhere in the sentence.
function findPeople(words, isName) {
  const people = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.role || PUNCT.test(w.n)) continue;
    const prev = words.slice(0, i).reverse().find((x) => !PUNCT.test(x.n) || x.n === ',');
    // the word after "at" / "in" / "@" is a place, even when an inbox sender shares its name (a leasing office named
    // after the place, live run 2026-10-12)
    if (prev && /^(?:at|in|@)$/.test(prev.n) && !/@/.test(w.n)) continue;
    const after = words[i + 1], after2 = words[i + 2];
    const loose = !prev || prev.role === 'action' || prev.role === 'who' || JOIN.has(prev.n) || prev.n === 'to' || prev.n === ',' || prev.n === 'invite'
      || (after && JOIN.has(after.n) && after2 && isName(after2.bare, { loose: false }));
    let span = 0;
    for (let k = Math.min(3, words.length - i); k >= 1 && !span; k--) {
      const run = words.slice(i, i + k);
      if (run.some((x) => x.role || PUNCT.test(x.n)) || run.slice(0, -1).some((x) => /[.,;:!?]$/.test(x.text))) continue;
      const text = run.map((x, j) => (j === k - 1 ? x.bare : x.n)).join(' ').replace(/[,.:;!?]+$/, '');
      if (k === 1 && (FILLER.has(text) || text.length < 3) && !isName(text, { loose: false })) continue;
      if (isName(text, { loose: loose && k === 1 })) span = k;
    }
    if (!span) continue;
    const typed = words.slice(i, i + span).map((x) => x.text).join(' ').replace(/[,.:;!?]+$/, '').replace(/['’]s$/, '');
    for (let k = 0; k < span; k++) { words[i + k].role = 'who'; words[i + k].group = people.length; }
    people.push(typed);
    // the word that joined this person to the sentence ("and", "with", "to", ",")
    const before = words[i - 1];
    if (before && (!before.role || before.role === 'filler') && (JOIN.has(before.n) || before.n === 'to')) { before.role = 'mark'; before.for = 'who'; }
    i += span - 1;
  }
  return people;
}

// The run of free words starting at i, up to the next word with a role, a signal word, or punctuation.
function runFrom(words, i, stopAt) {
  const run = [];
  for (let j = i; j < words.length; j++) {
    const w = words[j];
    if (w.role || /^[,;!?]+$/.test(w.n) || stopAt.test(w.n)) break;
    run.push(j);
    if (/[.,;!?]$/.test(w.text)) break;   // "maplewood," ends the place
  }
  while (run.length && /^(?:and|the|a|an|&|\+|or|with|to|please|pls)$/.test(words[run[run.length - 1]].n)) run.pop();
  return run;
}
const textOf = (sentence, words, run) => (run.length ? sentence.slice(words[run[0]].start, words[run[run.length - 1]].end).replace(/^["“]|["”]$/g, '').replace(/[.,;:!?]+$/, '').trim() : '');

// ---- the invite: every part, in any order ----
function readInvite(sentence, words, { isName, places }) {
  const out = { who: [], when: '', where: '', about: '', quote: '', kind: '', room: '', notes: false, app: 'outlook', unused: [] };
  const all = (pattern, role, each) => claimAll(sentence, words, pattern, role, each);
  all(PATTERNS.google, 'app', () => { out.app = 'google'; });
  all(PATTERNS.quote, 'about', (m) => { out.quote = out.quote || (m[1] || m[2]).trim(); });
  all(PATTERNS.notes, 'notes', () => { out.notes = true; });
  all(PATTERNS.outlook, 'app');
  // The subject said with "about": it runs to the next part (a day, a time, a length, a person, the verb). Its own
  // small words stay in it: "about feedback on the draft", "about sync issues in production", "about opening an office
  // at Statler" when the meeting's place was already said. "at"/"in" end it only before a place: one the user has
  // used, or a Capitalized one, when no place came earlier.
  const knownPlaces = (places || []).map((p) => fold(p).split(/\s+/));
  const placeAt = (j) => words[j] && (knownPlaces.some((parts) => parts.every((part, k) => words[j + k]?.bare.replace(/[.,;:!?]+$/, '') === part)) || /^\p{Lu}/u.test(words[j].text));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.role || !/^(?:about|regarding|subject|re)$/.test(w.n)) continue;
    const placeBefore = words.slice(0, i).some((x, k) => /^(?:at|in|@)$/.test(x.n) && words[k + 1] && !TIME_WORD.test(words[k + 1].n) && !/^\d/.test(words[k + 1].n));
    const run = [];
    for (let j = i + 1; j < words.length; j++) {
      const x = words[j], next = words[j + 1], prev = words[j - 1];
      if (x.role || /^[,;!?]+$/.test(x.n) || /^(?:every|by|until|till)$/.test(x.n)) break;
      // "at" starts the place unless one was already said; "in" only before a place ("sync issues in production")
      if (/^(?:at|in|@)$/.test(x.n) && (!next || TIME_WORD.test(next.n) || /^\d{1,2}$/.test(next.n) || (!placeBefore && (x.n !== 'in' || placeAt(j + 1))))) break;
      if (x.n === 'on' && next && (DAY_WORD.test(next.n) || /^(?:next|this|google|whatsapp|outlook)$/.test(next.n) || /^\d{1,2}[\/-]\d/.test(next.n) || new RegExp(`^${MONTH}$`).test(next.n))) break;
      if (x.n === 'with' && next && (isName(next.bare, { loose: true }) || /^(?:notes|the notes)$/.test(next.n))) break;
      if (x.n === 'for' && next && (/^\d/.test(next.n) || /^(?:an?|half|one)$/.test(next.n) && /^(?:hour|hr|half)$/.test(words[j + 2]?.n || ''))) break;
      // a time ends the subject unless it names a thing in it ("about the 3pm press release")
      const inside = prev && /^(?:the|a|an|our|my|your|their)$/.test(prev.n) && next && /^[a-z]/.test(next.n) && !SIGNAL.test(next.n) && !TIME_WORD.test(next.n) && !DAY_WORD.test(next.n);
      if ((TIME_WORD.test(x.n) || /^\d{1,2}$/.test(x.n) && /^(?:am|pm)$/.test(next?.n || '')) && !inside) break;
      // a day ends the subject unless it is part of it ("about the friday launch")
      if (DAY_WORD.test(x.n) && !inside && !(next && !next.role && /^[a-z]/.test(next.n) && !TIME_WORD.test(next.n) && !SIGNAL.test(next.n) && !JOIN.has(next.n) && !DAY_WORD.test(next.n))) break;
      if (/^(?:next|this)$/.test(x.n) && next && (DAY_WORD.test(next.n) || next.n === 'week')) break;
      if (/^(?:invite|schedule|book|meet|please|pls)$/.test(x.n)) break;
      if (/^(?:call|lunch|coffee|dinner|breakfast|sync|chat|meeting|catch-?up|check-?in|1:1)$/.test(x.n) && (!next && run.length === 0 || next && /^(?:invite|schedule|book|meet|with|for|at|on|in)$/.test(next.n) || next && (TIME_WORD.test(next.n) || DAY_WORD.test(next.n)))) break;
      if (isName(x.bare, { loose: false }) && !/['’]s$/.test(x.n) && run.length) break;
      run.push(j);
      if (/[.;!?]$/.test(x.text)) break;
    }
    while (run.length && /^(?:and|the|a|an|&|\+|or|with|to|for)$/.test(words[run[run.length - 1]].n)) run.pop();
    if (!run.length) continue;
    w.role = 'mark'; w.for = 'about';
    for (const j of run) words[j].role = 'about';
    const value = textOf(sentence, words, run);
    out.about = out.about ? `${out.about}, ${value}` : value;
  }
  all(PATTERNS.kind, 'kind', (m) => { if (out.kind) return false; out.kind = m[1].toLowerCase(); });
  for (const key of ['repeatDays', 'repeatDay', 'everyOther', 'everyN', 'daily', 'weekly', 'monthly', 'yearly', 'until', 'times', 'forever', 'length', 'lengthBare', 'week', 'partOfDay']) all(PATTERNS[key], 'when');
  all(PATTERNS.room, 'room');
  all(PATTERNS.time, 'when');
  all(PATTERNS.hour, 'when');
  all(PATTERNS.today, 'when');
  all(PATTERNS.weekday, 'when');
  all(PATTERNS.date, 'when');
  out.who = findPeople(words, isName);
  // "at"/"in"/"@" and the words after it: the place; "for"/"on" and the words after it: the subject
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.role) continue;
    let role = null;
    if (/^(?:at|in|@|location|where)$/.test(w.n)) role = 'where';
    else if (/^(?:for|on)$/.test(w.n)) role = 'about';
    // "invite marisol to Elm Hall": "to" before a word that is no one is where the meeting is
    else if (w.n === 'to' && words[i + 1] && !words[i + 1].role && !FILLER.has(words[i + 1].n)) role = 'where';
    if (!role) continue;
    const run = runFrom(words, i + 1, /^(?:about|re|regarding|at|in|@|for|on|with|by|to|invite|schedule|book|meet|setup|please|pls)$/);
    if (!run.length || run.every((j) => FILLER.has(words[j].n))) continue;
    w.role = 'mark'; w.for = role;
    for (const j of run) words[j].role = role;
    const value = textOf(sentence, words, run);
    if (role === 'where') out.where = out.where ? `${out.where} ${value}` : value;
    else out.about = out.about ? `${out.about}, ${value}` : value;
  }
  // What is left: a place the user has used before, a Capitalized run right after the people or the time
  // ("Nina 2pm Maplewood"), small words, or a word nobody asked for.
  const known = (places || []).map((p) => fold(p).split(/\s+/)).sort((a, b) => b.length - a.length);
  for (let i = 0; i < words.length; i++) {
    if (words[i].role) continue;
    const hit = known.find((parts) => parts.every((part, k) => words[i + k] && !words[i + k].role && words[i + k].bare.replace(/[.,;:!?]+$/, '') === part));
    if (!hit) continue;
    const run = hit.map((_, k) => i + k);
    for (const j of run) words[j].role = 'where';
    if (!out.where) out.where = textOf(sentence, words, run);
    i += hit.length - 1;
  }
  for (let i = 1; i < words.length; i++) {
    if (words[i].role || out.where || !/^\p{Lu}/u.test(words[i].text) || FILLER.has(words[i].n)) continue;
    const prev = words.slice(0, i).reverse().find((w) => !PUNCT.test(w.n));
    if (!prev || !['who', 'when', 'kind'].includes(prev.role)) continue;
    const run = [];
    for (let j = i; j < words.length && !words[j].role && /^\p{Lu}/u.test(words[j].text) && !FILLER.has(words[j].n); j++) run.push(j);
    for (const j of run) words[j].role = 'where';
    out.where = textOf(sentence, words, run);
  }
  for (const w of words) {
    if (w.role) continue;
    if (FILLER.has(w.n) || PUNCT.test(w.n)) { w.role = 'filler'; continue; }
    w.role = 'unused'; out.unused.push(w.text.replace(/[.,;:!?]+$/, ''));
  }
  out.when = words.filter((w) => w.role === 'when').map((w) => w.text.replace(/[,;!?]+$/, '')).join(' ');
  out.room = words.filter((w) => w.role === 'room').map((w) => w.text).join(' ');
  return out;
}

// ---- which action ----
// The first word that names an action. A word that is also an ordinary word ("text", "message", "tell") counts only
// as the first real word or right before a name.
function findAction(words, isName) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let n = w.n, extra = 0;
    if (n === 'set' && /^up$/.test(words[i + 1]?.n || '')) { n = 'setup'; extra = 1; }
    if (n === 'whats' && words[i + 1]?.n === 'app') { n = 'whatsapp'; extra = 1; }
    if (n === 'i' && words[i + 1]?.n === 'message') { n = 'imessage'; extra = 1; }
    const action = ACTIONS[n];
    if (!action) continue;
    const first = words.slice(0, i).every((x) => FILLER.has(x.n) || PUNCT.test(x.n));
    const next = words[i + 1 + extra];
    const beforeName = next && (isName(next.bare, { loose: false }) || /^(?:the|to)$/.test(next.n));
    if (SOFT_ACTIONS.test(n) && !first && !beforeName) continue;
    for (let k = 0; k <= extra; k++) words[i + k].role = 'action';
    return { action: action[0], app: action[1], at: i };
  }
  return null;
}

// The action a sentence names, by the same rule the box uses ({ action, app } or null). No guess from a time or a kind.
export function actionOf(sentence, isName = () => false) {
  const found = findAction(tokenize(corrected(sentence, isName)), isName);
  return found && { action: found.action, app: found.app };
}

// ---- a text or a reply, in any order ----
// "running late, text lena", "lena and jamie, the deck is ready, text them", "the report is done email marisol".
// ask.js's verb-first reader runs first; this one takes the sentences it cannot. Returns null when no message verb
// sits next to a name.
const HARD_MESSAGE = /^(?:email|e-mail|mail|whatsapp|whatsap|wa|imessage|sms|text|txt|msg|dm)$/;
const MESSAGE_APP = /\b(?:on|in|via|over|through|by|using)\s+(?:whats\s?app|wa|i\s?message|imessage|messages|sms|outlook|e-?mail|mail)\b/i;
export function readMessage(sentence, { isName = () => false } = {}) {
  const text = String(sentence || '');
  const words = tokenize(text);
  const real = (i) => words[i] && !PUNCT.test(words[i].n);
  const nextReal = (i) => { let j = i + 1; while (words[j] && (PUNCT.test(words[j].n))) j++; return j; };
  const prevReal = (i) => { let j = i - 1; while (j >= 0 && PUNCT.test(words[j].n)) j--; return j; };
  // the app phrase first, so "on whatsapp" is never the verb
  const app = text.match(MESSAGE_APP);
  if (app) for (const w of words) if (w.end > app.index && w.start < app.index + app[0].length) w.role = 'app';
  // the people: runs of names joined by and / & / , / +
  const groups = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].role || !real(i)) continue;
    let span = 0;
    for (let k = Math.min(3, words.length - i); k >= 1 && !span; k--) {
      const run = words.slice(i, i + k);
      if (run.some((x) => x.role || PUNCT.test(x.n)) || run.slice(0, -1).some((x) => /[.,;:!?]$/.test(x.text))) continue;
      const name = run.map((x, j) => (j === k - 1 ? x.bare : x.n)).join(' ').replace(/[,.:;!?]+$/, '');
      if (k === 1 && (FILLER.has(name) || name.length < 3) && !isName(name, { loose: false })) continue;
      const prev = words[prevReal(i)];
      if (isName(name, { loose: k === 1 && (!prev || ACTIONS[prev.n] || JOIN.has(prev.n) || prev.n === 'to' || /^[,;:]$/.test(words[i - 1]?.n || '') || /[,;:]$/.test(prev.text)) })) span = k;
    }
    if (!span) continue;
    const typed = words.slice(i, i + span).map((x) => x.text).join(' ').replace(/[,.:;!?]+$/, '').replace(/['’]s$/, '');
    const last = groups[groups.length - 1];
    const between = last ? words.slice(last.end + 1, i) : [];
    // names join one group only through "and", "&", "+" or a comma: in "text taro running late", "running" starts the
    // message even when a chat is named "Running club" (live run 2026-10-12)
    const closed = last && /[:.;!?]$/.test(words[last.end].text);
    if (last && !closed && between.length && between.some((x) => JOIN.has(x.n) || x.n === ',') && between.every((x) => JOIN.has(x.n) || x.n === ',' || x.n === 'the')) { last.names.push({ typed, at: i, span }); last.end = i + span - 1; }
    else groups.push({ start: i, end: i + span - 1, names: [{ typed, at: i, span }] });
    i += span - 1;
  }
  if (!groups.length) return null;
  // the verb: a message word next to a group of names, or one that can only be a verb
  let verb = -1, group = null;
  for (let i = 0; i < words.length && verb < 0; i++) {
    const w = words[i];
    if (w.role) continue;
    let n = w.n;
    if (n === 'whats' && words[i + 1]?.n === 'app') n = 'whatsapp';
    if (!ACTIONS[n] || ACTIONS[n][0] === 'invite') continue;
    const after = groups.find((g) => { let j = nextReal(i); while (words[j] && /^(?:to|the)$/.test(words[j].n)) j = nextReal(j); return g.start === j; });
    const before = groups.find((g) => { let j = prevReal(i); while (j >= 0 && /^(?:please|pls|and|then|now|them|him|her)$/.test(words[j].n)) j = prevReal(j); return g.end === j; });
    const rest = words.slice(i + 1).filter((x) => !PUNCT.test(x.n));
    const last = !rest.length || rest.every((x) => /^(?:them|him|her|both|back|everyone|all|please|pls|now|asap|rn)$/.test(x.n));
    if (after || before || last || (HARD_MESSAGE.test(n) && /^(?:that|saying|:)$/.test(words[nextReal(i)]?.n || ''))) { verb = i; group = after || before || groups[0]; }
  }
  if (verb < 0) return null;
  const vn = words[verb].n === 'whats' ? 'whatsapp' : words[verb].n;
  words[verb].role = 'action';
  if (words[verb].n === 'whats') words[verb + 1].role = 'action';
  for (const g of [group]) for (let i = g.start; i <= g.end; i++) words[i].role = words[i].role || (g.names.some((x) => i >= x.at && i < x.at + x.span) ? 'who' : 'mark');
  // a pronoun right after the verb points back at the names ("lena and jamie: text them")
  const pron = nextReal(verb);
  if (words[pron] && /^(?:them|him|her|both|back|everyone|all)$/.test(words[pron].n) && !words[pron].role) words[pron].role = 'filler';
  // the message: every free word, in order; a "saying" / "that" / ":" right before it is a marker
  const free = words.map((w, i) => (!w.role ? i : -1)).filter((i) => i >= 0);
  const pieces = [];
  for (const i of free) { const p = pieces[pieces.length - 1]; if (p && p[p.length - 1] === i - 1) p.push(i); else pieces.push([i]); }
  const LEAD_WORDS = /^(?:hey|hi|ok|okay|so|loggie|can|could|would|you|u|please|pls|plz|go|ahead|um|yo|quickly)$/;
  const MARKER = /^(?:that|saying|say|says|tell|ask)$/;
  const parts = pieces.map((p) => {
    // a piece of nothing but "hey can you" / "please" is the request to Loggie, not the message
    if (p.every((i) => LEAD_WORDS.test(words[i].n) || PUNCT.test(words[i].n))) { for (const i of p) words[i].role = 'filler'; return []; }
    // "saying", "that", ":" right after the verb or the names marks where the message starts
    const before = words[p[0] - 1];
    while (p.length > 1 && before && ['action', 'who', 'mark', 'app'].includes(before.role) && (PUNCT.test(words[p[0]].n) || MARKER.test(words[p[0]].n) && !(words[p[0]].n === 'that' && /^(?:is|was|works|sounds|looks)$/.test(words[p[1]]?.n || '')) || /^(?:to|and)$/.test(words[p[0]].n) && MARKER.test(words[p[1]]?.n || '') || /^(?:them|him|her)$/.test(words[p[0]].n) && p.length > 1 && MARKER.test(words[p[0] - 1]?.n || ''))) { words[p[0]].role = MARKER.test(words[p[0]].n) ? 'mark' : 'filler'; p.shift(); }
    while (p.length && PUNCT.test(words[p[p.length - 1]].n) && !/[!?]/.test(words[p[p.length - 1]].n)) { words[p[p.length - 1]].role = 'filler'; p.pop(); }
    return p;
  }).filter((p) => p.length);
  for (const p of parts) for (const i of p) words[i].role = 'message';
  const body = parts.map((p) => text.slice(words[p[0]].start, words[p[p.length - 1]].end)).join(' ').replace(/^[,;:\s-]+|[,;:\s-]+$/g, '').trim();
  const appName = app ? (/whats|wa\b/i.test(app[0]) ? 'whatsapp' : /message|sms/i.test(app[0]) ? 'messages' : 'outlook') : ACTIONS[vn][1];
  return { action: ACTIONS[vn][0], app: appName || null, who: group.names.map((x) => x.typed), words: body, roles: words.map(publicWord) };
}

export function readWords(sentence, { isName = () => false, places = [], action: forced = null } = {}) {
  const typed = tokenize(sentence);
  const text = corrected(sentence, isName);
  const words = tokenize(text);
  const publicWord = (w, i) => publicOf({ ...w, text: typed[i]?.text ?? w.text, start: typed[i]?.start ?? w.start, end: typed[i]?.end ?? w.end });
  const found = findAction(words, isName);
  let action = forced || found?.action || null;
  // no verb, but the kind of event or a time with a person: an invite ("lunch with lena friday")
  if (!action && (PATTERNS.kind.test(text) || PATTERNS.time.test(text) || PATTERNS.today.test(text))) action = 'invite';
  if (action === 'invite') {
    const out = readInvite(text, words, { isName, places });
    return { action, ...out, words: words.map(publicWord) };
  }
  return { action, app: found?.app || null, words: words.map(publicWord), who: [], when: '', where: '', about: '', quote: '', kind: '', room: '', notes: false, unused: [] };
}
const publicOf = (w) => ({ text: w.text, start: w.start, end: w.end, role: w.role || 'filler', ...(w.group !== undefined ? { group: w.group } : {}), ...(w.for ? { for: w.for } : {}) });
const publicWord = publicOf;

// A text, a reply, "what did X say" or a move, read by ask.js: its answer put back on the words, so the box
// underlines what will run. `ask` is readAsk's result.
export function markAsk(sentence, ask) {
  const text = String(sentence || '');
  const words = tokenize(text);
  const lower = fold(text);
  const claim = (start, end, role) => { for (const w of words) if (!w.role && w.end > start && w.start < end) w.role = role; };
  if (ask.words) {
    // the message: where its words sit in the sentence (the reader capitalized the first letter)
    const body = fold(ask.words).replace(/^["“'‘]+|["”'’]+$/g, '');
    const i = lower.lastIndexOf(body);
    if (i >= 0) claim(i, i + body.length, 'message');
  }
  let cursor = 0;
  (ask.who || []).forEach((who, group) => {
    const i = lower.indexOf(fold(who), cursor);
    if (i < 0) return;
    for (const w of words) if (!w.role && w.start >= i && w.start < i + who.length) { w.role = 'who'; w.group = group; }
    cursor = i + who.length;
  });
  if (ask.app) {
    const m = text.match(/\b(?:on|in|via|over|through|by|using)\s+(?:whats\s?app|wa|i\s?message|imessage|messages|sms|outlook|e-?mail|mail)\b/i);
    if (m) claim(m.index, m.index + m[0].length, 'app');
  }
  if (ask.when) { const i = lower.lastIndexOf(fold(ask.when)); if (i >= 0) claim(i, i + ask.when.length, 'when'); }
  const verb = words.find((w) => !w.role && (ACTIONS[w.n] || /^(?:let|send|what|did|move|push|reschedule|shift|bump|change|anything|catch|write|answer|follow|respond|reply)$/.test(w.n)));
  if (verb) verb.role = 'action';
  for (const w of words) {
    if (w.role) continue;
    if (w.n === 'know' && words.some((x) => x.n === 'let' && x.role === 'action')) { w.role = 'action'; continue; }
    const i = words.indexOf(w);
    if (JOIN.has(w.n) && words[i - 1]?.role === 'who' && words.slice(i + 1).find((x) => !PUNCT.test(x.n))?.role === 'who') { w.role = 'mark'; w.for = 'who'; continue; }
    if (/^(?:saying|say|that)$/.test(w.n) || w.colon || w.n === ':') { w.role = 'mark'; w.for = 'message'; continue; }
    w.role = 'filler';
  }
  return words.map(publicWord);
}
