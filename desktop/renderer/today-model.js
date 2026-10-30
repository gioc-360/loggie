// Today's list, pure (docs/prototype-port/spec-b.md): the morning's picks (firstToday) matched to the workstream
// cards they belong to, in pick order, with the words and the one button each shows; the drafts ready to open; the
// "?" rows. No DOM, so node tests it on made-up cards. Nothing here is new data: every field comes from calls the app
// already makes (hikyaku.firstToday, hikyaku.workstreams, panel.js queueItems).

export const APP_NAMES = { outlook: 'Outlook', gmail: 'Gmail', 'apple-mail': 'Apple Mail', messages: 'Messages', whatsapp: 'WhatsApp' };
export const BUSY = { drafting: 'Loggie is preparing drafts…', 'event-open': 'Invite open in your calendar', 'nothing-to-do': 'Nothing to do', sent: 'Sent ✓' };
export const READY = ['ready', 'in-mail-app'];
export const ASKING = ['needs-you', 'failed'];

export const dayLabel = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// A move's date belongs on its date tag, not in its title (Gio, 2026-10-23: "time should be designed to be tagged on the
// date not just full text"; titles read "...on Tuesday, October 27 at 3PM EST" and "...on 2026-10-27" beside an Oct 27
// tag). A date phrase that names the move's own day is taken out of the title; a time said with it goes on the tag.
// A phrase naming another day stays: it is not the tag's. Relative words (today, tomorrow) go only when the move has a
// date. Returns { title, time } with time like "3 PM" or null.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?';
const WEEKDAY = '(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?';
const TIME = '(?:\\s*(?:at|@)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)(?:\\s*(?:est|edt|et|pst|pdt|pt|cst|cdt|ct))?))?';
export function titleAndTime(title, due) {
  let text = String(title || '');
  if (!due) return { title: text, time: null };
  const [year, month, day] = String(due).slice(0, 10).split('-').map(Number);
  let time = null;
  const take = (match, t) => { if (t && !time) time = t.replace(/\s+/g, ' ').replace(/\b(am|pm)\b/i, (m) => m.toUpperCase()).replace(/(\d)(AM|PM)/, '$1 $2').replace(/\s*(est|edt|et|pst|pdt|pt|cst|cdt|ct)$/i, ''); return ''; };
  const iso = new RegExp(`\\s*(?:on|by|due)?\\s*${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${TIME}`, 'i');
  text = text.replace(iso, take);
  const named = new RegExp(`\\s*(?:on|by|due)?\\s*${WEEKDAY}${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+${year})?${TIME}`, 'gi');
  text = text.replace(named, (match, mon, d, t) => {
    const index = MONTHS.findIndex((name) => name.startsWith(mon.toLowerCase().replace('.', '').slice(0, 3)));
    return index + 1 === month && Number(d) === day ? take(match, t) : match;
  });
  text = text.replace(new RegExp(`\\s*(?:\\b(?:today|tomorrow|tonight)\\b)${TIME}`, 'i'), take);
  text = text.replace(new RegExp(`\\s*(?:at|@)\\s*(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)(?:\\s*(?:est|edt|et|pst|pdt|pt|cst|cdt|ct))?)(?=\\s*$)`, 'i'), (m, t) => (time ? m : take(m, t)));
  // the brackets a date stood in go with it: "by Wednesday (Wed Nov 4)" read "by Wednesday ()" (2026-10-29)
  text = text.replace(/\s*\(\s*\)/g, '');
  text = text.replace(/\s+([,.;:])/g, '$1').replace(/[\s,]+$/, '').replace(/\s{2,}/g, ' ').trim();
  return { title: text || String(title || ''), time };
}
// Inbox, Chats and a folder of open moves are not the user's workspaces (card-fields.js).
export const isNamed = (card) => Boolean(card) && !card.inbox && !card.chats && !card.folder;
const same = (a, b) => String(a || '').replace(/\W+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\W+/g, ' ').trim().toLowerCase();

// The card, move and active task a pick points at, by its task id; by the workstream's name when no list holds it.
export function matchPick(pick, cards = []) {
  const id = pick?.taskId;
  const byMove = cards.find((card) => (card.moves || []).some((move) => move.id === id));
  const byActive = byMove ? null : cards.find((card) => (card.active || []).some((item) => item.id === id));
  const card = byMove || byActive || cards.find((item) => item.name === pick?.name) || null;
  return {
    pick, card,
    move: (card?.moves || []).find((move) => move.id === id) || null,
    active: (card?.active || []).find((item) => item.id === id) || null,
  };
}

// The question Loggie stopped on for this pick, or null: a blocked task sits in active[], never in moves[].
export const questionFor = (entry) => (entry?.active && ASKING.includes(entry.active.phase) ? entry.active : null);

// What Today shows: { state, entries, ready, rows }. State, first match wins: 'date' (picks by due date), 'normal',
// 'nothing' (no picks, a named workspace exists), 'first-run' (no picks, no named workspace yet).
export function todayItems({ picks = [], source = null, cards = [], rows = [] } = {}) {
  const seen = new Set();
  const entries = [];
  // A pick whose move was marked Done or dropped (the card's retired list) leaves at once: the cards reload before the
  // saved picks do, and the gap showed a Done move on Today (Codex review, 2026-10-23). A pick with no move on its card
  // yet stays (it gets Draft it).
  const gone = new Set((cards || []).flatMap((card) => (card.retired || []).map((item) => item.id)));
  for (const pick of picks || []) {
    if (!pick?.taskId || seen.has(pick.taskId) || gone.has(pick.taskId)) continue;
    seen.add(pick.taskId);
    entries.push(matchPick(pick, cards || []));
  }
  const asked = new Set(entries.filter(questionFor).map((entry) => `ask:${entry.pick.taskId}`));
  const ready = (cards || []).flatMap((card) => (card.active || []).filter((item) => READY.includes(item.phase) && !seen.has(item.id)).map((active) => ({ card, active })))
    .sort((a, b) => String(b.active.at || '').localeCompare(String(a.active.at || '')));
  const state = entries.length ? (source === 'date' ? 'date' : 'normal') : (cards || []).some(isNamed) ? 'nothing' : 'first-run';
  return { state, entries, ready, rows: (rows || []).filter((row) => !String(row.key).startsWith('pick:') && !asked.has(row.key)) };
}

// To send or To do, the one rule for a move's heading and its buttons (Gio, 2026-10-21, on "Prepare for your chat with
// Sam Lee tomorrow" under To send with a mail button: "what do we want the users to do?"). To send: the move
// makes a draft, an email or a chat reply, so Draft it places it in the app. To do: everything else (prepare, attend,
// submit, read, decide), which only the user can do: Done, New date, Drop it, never Draft it. The kind the source id
// carries decides (screen-depth.js moveKindOf); a move with no telling kind (a call step, a move written after Send, a
// pick with no move) goes by its first word.
export const SEND_KINDS = Object.freeze(['reply', 'email', 'owed']);
export const DO_KINDS = Object.freeze(['prep', 'apply', 'deadline', 'event']);
const WRITES = /^(↩\s*)?(reply|respond|answer|e-?mail|write|send|text|message|ask|follow up|reach out|forward|share|thank|introduce|offer a time)\b/i;
export function moveGroup(move) {
  if (SEND_KINDS.includes(move?.kind)) return 'send';
  if (DO_KINDS.includes(move?.kind)) return 'do';
  return WRITES.test(String(move?.title || '').trim()) ? 'send' : 'do';
}

// Reply on a To do move, the second rule beside moveGroup (Gio, 2026-10-21, on "Prepare for the interview with ... on
// Tuesday" under To do with the recruiter's scheduling email shown under it: "how come it doesnt allow me to reply
// though?"). The move stays To do; Reply answers the email it came from. Only when that email is from a person
// (move-card.js emailFromOf: no chat, no ask line, no call step; machine is the router's no-reply rule) and the mail
// app can send in that thread. A To send move has Draft it instead.
export const MAIL_APPS = Object.freeze(['outlook', 'apple-mail']);
export function canReplyTo(move) {
  const from = move?.from;
  return Boolean(move && moveGroup(move) === 'do' && from?.address && !from.machine && move.sendable !== false && MAIL_APPS.includes(move.app));
}
// "Cartwright, Kaitlyn" and "Kaitlyn Cartwright" are both Kaitlyn; no name, the address.
export function firstNameOf(from) {
  const name = String(from?.name || '').trim();
  if (!name) return from?.address || 'them';
  return (name.includes(',') ? name.split(',')[1] : name).trim().split(/\s+/)[0] || name;
}
export const replyTip = (move) => `Reply to ${firstNameOf(move.from)} in ${APP_NAMES[move.app] || 'your mail app'}`;

const dueOf = (entry) => entry.move?.due || entry.pick?.due || null;
// The title without its own date (titleAndTime): the date and time read on the line's tag, not in the words.
export const titleOf = (entry) => (entry.move ? `${entry.move.waiting ? '↩ ' : ''}${titleAndTime(entry.move.title, dueOf(entry)).title}` : titleAndTime(entry.pick.move || entry.active?.title || '', dueOf(entry)).title);

export function whyOf(pick) {
  const parts = [pick?.why, pick?.rule === 'replies first' ? 'Replies first.' : null].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export function metaOf(entry, { source = null, today = '' } = {}) {
  const due = entry.move?.due || entry.pick.due || null;
  const name = entry.card ? entry.card.label || entry.card.name : entry.pick.name;
  // A pick the morning ranking made from a call step or the user's own habit says so (old pickCard's tags).
  const from = entry.pick.isNew ? (entry.pick.habit ? 'from your habit' : 'from the call') : null;
  const time = due ? titleAndTime(entry.move?.title || entry.pick.move || '', due).time : null;
  const text = [name, due ? (time ? `${dayLabel(due)} · ${time}` : dayLabel(due)) : null, from, source === 'date' ? 'by date' : null].filter(Boolean).join(' · ');
  return { text, late: Boolean(due && today && String(due).slice(0, 10) < today) };
}

// Where the pick came from, in someone's own words: the pick's quote (unless it only repeats the title), else the last
// thing they said, else the first line of the call it came from.
export function quoteOf(entry) {
  const folder = entry.move?.call?.folder || null;
  if (entry.pick.quote && !same(entry.pick.quote, titleOf(entry).replace(/^↩ /, '')) && !same(entry.pick.quote, entry.pick.move)) return { text: entry.pick.quote, who: null, when: null, folder };
  const said = [...(entry.move?.said || [])].reverse().find((line) => line.who === 'them');
  if (said?.text) return { text: said.text, who: said.name || null, when: said.at ? dayLabel(said.at) : null, folder };
  const line = entry.move?.call?.lines?.[0];
  if (line?.text) return { text: line.text, who: entry.move.call.title || null, when: line.time || null, folder };
  if (entry.pick.habit) return { text: entry.pick.habit, who: 'Your habit', when: null, folder };
  return null;
}

// The card's one button, first match wins.
export function buttonOf(entry) {
  if (questionFor(entry)) return { kind: 'answer', label: '' };
  const active = entry.active;
  if (active && READY.includes(active.phase)) return { kind: 'open', label: active.phase === 'in-mail-app' ? 'Open again' : 'Open' };
  if (active) return { kind: 'busy', label: BUSY[active.phase] || active.phase };
  // A To do move (moveGroup) has nothing to draft: the card keeps Done and New date only.
  if (moveGroup(entry.move || { title: entry.pick?.move }) === 'do') return { kind: 'todo', label: '' };
  if (entry.move?.sendable === false) return { kind: 'phone', label: 'Text from your iPhone' };
  if (entry.move) return { kind: 'app', label: `Draft it in ${APP_NAMES[entry.move.app] || 'your mail app'}` };
  return { kind: 'do-it', label: 'Draft it' };
}
