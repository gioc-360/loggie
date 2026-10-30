// Who a name in the ask box means (loggie-ask-box increment 2): one person or group, in the app that fits, or a
// question. Built from what Loggie already reads on this Mac, nothing new leaves it: Messages and WhatsApp chats with
// Contacts names (chats.js + contacts.js), Outlook mail through Apple Mail (sent-mail.js): its senders, and who the
// user wrote to or saw on To and Cc (readMailPeople), and the "Name <address>" pairs in saved threads (people.js). Two
// people who both answer to a name are a question, never a guess.
//
//   buildWhoIndex({ chats, inbox, mail, people, own }) -> entries
//     { name, kind: 'person' | 'group', app: 'messages' | 'whatsapp' | 'outlook', chatId?, address?, isGroup?,
//       email?, last (ISO or ''), subject?, conversation? }
//   resolveWho(whoText, entries, { app, action }) -> { status: 'one' | 'many' | 'none', pick?, picks?, candidates? }
//   flipName(name) -> "First Last" for an Exchange "Last, First"; anything else unchanged
import { fold, slipOf } from './ask.js';
import { oneEdit } from './people.js';
import { isKept } from './workstreams.js';

const ANGLE = /^\s*"?([^"<]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/;
// A sending service, not a person: its own words in the address, or a sending subdomain (K-House's Square invoices came
// from messenger@messaging.squareup.com and made "email KHouse" a question between two K-Houses, 2026-10-17).
const NO_REPLY = /(?:^|[._-])(?:no-?reply|do-?not-?reply|notifications?|mailer|bounce|alerts?|messenger)(?:[._-]|@)|@(?:messaging|notify|notifications?|mailer|bounces?|em|email)\./i;
const isPhoneish = (text) => /^\+?[\d\s().-]{7,}$/.test(String(text || '').trim());
// On mail the user got, To and Cc count only on a message to a few people: half of their Inbox goes to 13 or more
// (class lists), and those would have put 556 names in the box where 176 people were ever in a real conversation
// (2026-10-12, 60 days). Whoever the user wrote to counts at any size.
export const FEW = 10;

// "Romero, Elizabeth" is how Exchange stores Elizabeth Romero (D7, loggie-intros I3): with it, "email Elizabeth
// Romero" found no one. Exactly one comma, and the part after it not a suffix ("Smith, Jr."): the two parts swap.
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba', 'cpa', 'esq']);
export function flipName(name) {
  const text = String(name ?? '');
  const found = text.match(/^([^,]+),\s*([^,]+)$/);
  if (!found || SUFFIXES.has(found[2].toLowerCase().replace(/\./g, '').trim())) return text;
  return `${found[2].trim()} ${found[1].trim()}`;
}

export function buildWhoIndex({ chats = {}, inbox = [], mail = [], people = [], own = [] } = {}) {
  const entries = [];
  const mine = new Set(own.map((address) => String(address).toLowerCase()));
  for (const [app, answer] of Object.entries(chats || {})) {
    for (const chat of answer?.chats || []) {
      const name = String(chat.title || '').trim();
      if (!name || isPhoneish(name)) continue;
      const last = (chat.messages || []).map((message) => message.timestamp).sort().at(-1) || '';
      const members = chat.isGroup ? (chat.participants || []).map((person) => ({ name: person.name || '', handle: person.handle })) : undefined;
      entries.push({ name, kind: chat.isGroup ? 'group' : 'person', app, chatId: String(chat.id), address: chat.address || null, isGroup: Boolean(chat.isGroup), last, ...(members ? { members } : {}) });
    }
  }
  // Mail: the newest message from each sender is where a reply goes.
  const newest = new Map();
  for (const message of inbox || []) {
    const found = String(message.from || '').match(ANGLE);
    const email = (found ? found[2] : String(message.from || '')).trim().toLowerCase();
    if (!email.includes('@') || mine.has(email) || NO_REPLY.test(email)) continue;
    const name = flipName((found?.[1] || '').trim());
    const seen = newest.get(email);
    if (!seen || String(message.timestamp) > seen.last) newest.set(email, { name: name || seen?.name || email, kind: 'person', app: 'outlook', email, last: String(message.timestamp || ''), subject: message.subject || '', conversation: message.conversation || null });
  }
  entries.push(...newest.values());
  // Who the user wrote to, or saw beside them on a small To or Cc, and never heard from: no thread to answer, so an
  // email to them is a new one (ask-run.js). The name is the newest one a message gave them.
  const seen = new Map();
  for (const row of mail || []) {
    const email = String(row.address || '').toLowerCase();
    const name = flipName(String(row.name || '').trim());
    if (!email.includes('@') || !name || isPhoneish(name) || newest.has(email) || mine.has(email) || NO_REPLY.test(email)) continue;
    if (!row.sent && row.size > FEW) continue;
    const had = seen.get(email);
    if (!had || String(row.at) > had.last) seen.set(email, { name, kind: 'person', app: 'outlook', email, last: String(row.at || '') });
  }
  entries.push(...seen.values());
  for (const person of people || []) {
    const email = String(person.address || '').toLowerCase();
    if (!email || newest.has(email) || seen.has(email) || mine.has(email)) continue;
    entries.push({ name: person.name, kind: 'person', app: 'outlook', email, last: '' });
  }
  return entries;
}

// The people the ask box knows besides mail and chats (D1, loggie-intros 1.7): every kept workspace's people with an
// address, in file order (an introduced person saved there is reachable by name), then the "Name <address>" pairs of
// saved threads (people.js) not already listed. One per address. An unconfirmed card's people are never read.
export function whoPeople({ workstreams = [], threadPeople = [] } = {}) {
  const out = [];
  const seen = new Set();
  const add = (person) => {
    const address = String(person?.address || '').toLowerCase();
    if (!address || seen.has(address)) return;
    seen.add(address);
    out.push({ name: String(person.name || ''), address });
  };
  for (const workstream of workstreams || []) if (isKept(workstream)) for (const person of workstream.people || []) add(person);
  for (const person of threadPeople || []) add(person);
  return out;
}

// The names readAsk splits sentences with: every entry's name.
export const indexNames = (entries) => [...new Set(entries.map((entry) => entry.name))];

const TIERS = [
  (name, q) => name === q,
  (name, q) => name.split(' ').join(' ').startsWith(`${q} `) && q.split(' ').length > 1,
  (name, q) => name.split(' ').includes(q),
  (name, q) => q.length >= 3 && name.split(' ').some((part) => part.startsWith(q)),
  // a one-letter slip on a long name ("marisl", "jaime"), only when nothing closer answers
  (name, q) => q.length >= 4 && !q.includes(' ') && name.split(' ').some((part) => part.length >= 5 && oneEdit(part, q)),
  (name, q) => q.includes(' ') && slipOf(name.split(' '), q.split(' ')),
];

// The one entry of a person to act on: the app the sentence named; else for a message the chat app they use
// (Messages first, as "text" means on a Mac), for a reply or anything else wherever they wrote last.
function pickFor(entries, { app, action }) {
  const inApp = app ? entries.filter((entry) => entry.app === app) : entries;
  if (!inApp.length) return null;
  const byLast = [...inApp].sort((a, b) => String(b.last).localeCompare(String(a.last)));
  if (action === 'message' && !app) return inApp.find((entry) => entry.app === 'messages') || inApp.find((entry) => entry.app === 'whatsapp') || byLast[0];
  return byLast[0];
}

export function resolveWho(whoText, entries, { app = null, action = 'message' } = {}) {
  const asked = fold(whoText).replace(/^the /, '');
  if (!asked) return { status: 'none', who: whoText };
  // "the hackathon group" is the chat named "Hackathon Team": the group word is how the user points, not the name.
  const bare = asked.replace(/ (?:group(?: chat)?|chat|gc)$/, '');
  for (const q of bare !== asked ? [asked, bare] : [asked]) {
    const found = resolveQuery(q, whoText, entries, { app, action });
    if (found.status !== 'none' || q === bare) return found;
  }
  return { status: 'none', who: whoText };
}

function resolveQuery(q, whoText, entries, { app, action }) {
  // A message goes to a chat; Outlook entries only answer replies, "said" and moves.
  // A named app narrows the search first: "whatsapp gideon" is the WhatsApp Gideon even when Messages has a
  // closer "Gideon".
  const pool = entries.filter((entry) => (app ? entry.app === app : action === 'message' ? entry.app !== 'outlook' : true));
  // A one-word name ("gideon") is not an exact match for the contact saved as just "Gideon" while a "Gideon
  // Reyes" also exists: one-word asks start at the word tier, so both are offered (2026-10-11, real data).
  for (const match of q.includes(' ') ? TIERS : TIERS.slice(2)) {
    let found = pool.filter((entry) => match(fold(entry.name), q));
    if (!found.length) continue;
    // "bruno" is Bruno, not the "Bruno & Arlo" group: a person beats a group at the same tier unless the words
    // are the group's whole name.
    if (found.some((entry) => entry.kind === 'person')) found = found.filter((entry) => entry.kind === 'person' || fold(entry.name) === q);
    // One identity is one folded name; the same person in two apps is still one.
    const identities = new Map();
    for (const entry of found) identities.set(fold(entry.name), [...(identities.get(fold(entry.name)) || []), entry]);
    if (identities.size > 1) {
      const candidates = [...identities.values()].map((group) => pickFor(group, { app, action }) || group[0]).slice(0, 5);
      return { status: 'many', who: whoText, candidates };
    }
    const all = [...identities.values()][0];
    const pick = pickFor(all, { app, action });
    if (!pick) return { status: 'none', who: whoText, reason: 'app', apps: [...new Set(all.map((entry) => entry.app))] };
    // Two chats with the same name in the same app (two "Hackathon Team" groups) are two chats: ask, newest first.
    const twins = all.filter((entry) => entry.app === pick.app && entry.kind === pick.kind);
    if (twins.length > 1) return { status: 'many', who: whoText, twins: true, candidates: twins.sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, 5) };
    return { status: 'one', who: whoText, pick, picks: all };
  }
  return { status: 'none', who: whoText };
}
