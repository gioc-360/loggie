// The Workspaces list, pure (docs/prototype-port/spec.md, Workspaces list and detail): which workspaces show, in what
// order, and the words on each row. No DOM, so node tests it on made-up cards. Every field comes from
// hikyaku.workstreams(); nothing here is new data.
import { dayLabel, isNamed, moveGroup, READY } from './today-model.js';

export const SOURCE_WORD = { gmail: 'Email', outlook: 'Email', messages: 'Message', whatsapp: 'WhatsApp', calendar: 'Calendar', call: 'Call', park: 'Back from park' };
export const stakeOf = (card) => card.stake ?? card.priority?.stake ?? 'normal';
const changed = (card) => Number(card.unread) > 0 && !card.current;

// How fresh one card is, in words: what is new, or since when it has been current.
export function freshLine(card) {
  // The andon (loggie-workspaces-integration): a card that cannot be read says why, not "138 new" forever.
  if (card.readYes) return 'Not read yet · needs your yes';
  if (card.quiet) return Number(card.unread) > 0 ? `${card.unread} new · just keep me posted` : 'Just keep me posted';
  if (changed(card)) return `${card.unread} new${card.asOf ? ` since ${dayLabel(card.asOf)}` : ''}`;
  return card.asOf ? `Up to date as of ${dayLabel(card.asOf)}` : 'Not read yet';
}

// The goal line from evidence (loggie-workspaces-integration F2): the next dated item filed here, from its calendar,
// an hour of grace after it starts. Never a kind label; blank when nothing is ahead.
export function nextLine(card, now = new Date()) {
  const next = (Array.isArray(card?.milestones) ? card.milestones : []).filter((item) => item?.title && Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) >= now.getTime() - 3600000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!next) return '';
  const at = new Date(next.at);
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return `Next: ${next.title} · ${day} · ${time}`;
}
// What a row and the card say the workspace is for: his own confirmed words, else the next date; never a label.
export const goalLine = (card, now = new Date()) => (card?.goalText && card.goalConfirmed ? card.goalText : nextLine(card, now));

// The rows, in order: the user's workspaces by next due date (undated after, then the ranking's order), then Inbox,
// Chats and folders of open moves. Parked ones say so instead of a date.
export function listRows(cards = [], today = '') {
  const due = (card) => card.priority?.due || null;
  const parkedUntil = (card) => (card.priority?.parked && card.priority?.parkedUntil) || (card.parkedUntil && (!today || card.parkedUntil > today) ? card.parkedUntil : null);
  const rank = (card) => (Number.isFinite(card.priority?.rank) ? card.priority.rank : Infinity);
  const sorted = [...(cards || [])].map((card, index) => ({ card, index })).sort((a, b) => {
    const named = Number(isNamed(b.card)) - Number(isNamed(a.card));
    if (named) return named;
    const da = due(a.card), db = due(b.card);
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (Boolean(da) !== Boolean(db)) return da ? -1 : 1;
    return rank(a.card) - rank(b.card) || a.index - b.index;
  });
  return sorted.map(({ card }) => {
    // To send: the moves that make a draft (moveGroup) and the drafts ready to open; a To do move is not counted.
    const toSend = (card.moves || []).filter((move) => moveGroup(move) === 'send').length + (card.active || []).filter((item) => READY.includes(item.phase)).length;
    const parked = parkedUntil(card);
    return {
      name: card.name, label: card.label || card.name, goal: goalLine(card),
      when: parked ? `Parked until ${dayLabel(parked)}` : due(card) ? `by ${dayLabel(due(card))}` : '',
      toSend, fresh: freshLine(card), changed: changed(card), named: isNamed(card), stake: stakeOf(card), newFound: card.newFound === true,
    };
  });
}

// What is new, one line per thread: replies to the same subject fold into one with a count.
export function newsLines(news = []) {
  const subject = (title) => String(title || '').replace(/^\s*((re|fwd?|fw|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase();
  const groups = new Map();
  for (const n of [...news].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))) {
    const key = `${n.source === 'outlook' ? 'gmail' : n.source}|${subject(n.title) || n.title}`; // both read as Email
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { ...n, title: String(n.title || '').replace(/^\s*((re|fwd?|fw|aw|sv)\s*:\s*)+/i, '').trim() || n.title, count: 1 });
  }
  return [...groups.values()];
}

// How you write here: the length every draft in this workspace is aimed at (delta.js voiceFor). Nothing until there is
// a length to show: "0 sends so far" was all Gio ever saw there (loggie-reply-yes, "kind of annoying to see").
export function voiceLine(voice) {
  if (!voice?.median) return null;
  return voice.here >= 3 ? `About ${voice.median} words · median of your ${voice.here} sends here`
    : `About ${voice.median} words · your usual email, from ${voice.sends} sends (${voice.here} here so far)`;
}

// Why a move was retired (retire.js), in a few words.
export function retiredWhy(r) {
  const day = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value)) ? dayLabel(value) : value);
  const words = { duplicate: () => r.proof, past: () => `date passed (${day(r.proof)})`, done: () => `✓ ${day(r.proof)}`,
    dropped: () => `✕ ${day(r.proof)}`, overdue: () => `late since ${day(r.proof)}`, moved: () => `moved to ${r.proof}` }[r.why];
  return words ? words() : `done: “${r.proof}”`;
}
