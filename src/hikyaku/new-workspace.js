// New workspace, made by the user on the Workspaces tab (loggie-new-workspace): a typed name, then a look through what
// Loggie already reads on this Mac (Apple Mail's inbox and sent mail, Messages and WhatsApp, the calls) for the name's
// words, then the people it found, each one the user can leave out, and Save. The look is read-only and sends nothing:
// it reads subjects, chat titles and lines, and call titles by code. Save writes one card (entry.js addWorkstream) with
// the name's words and the people kept; its mail is read only as any kept card's is (catchUpOn, after the cloud yes).
import { titleWords } from './discover.js';
import { addressOf } from './draft.js';
import { MACHINE } from './router.js';

export const LOOK_DAYS = 30;
export const PEOPLE_MAX = 12;

// Words that name a kind of thing, not a thing: alone, "Club" would file every club's mail under "Japan Club"
// (2026-10-23, first live look: 50 emails, most of them other clubs').
const KIND_WORDS = new Set(['club', 'clubs', 'team', 'teams', 'group', 'project', 'projects', 'case', 'competition', 'comp', 'chat', 'program', 'committee', 'council',
  'association', 'society', 'network', 'office', 'hours', 'interview', 'interviews', 'application', 'prep', 'work', 'plan', 'trip', 'party', 'night', 'weekend', 'week',
  'call', 'calls', 'meeting', 'meetings', 'session', 'workshop', 'board', 'search', 'recruiting']);

// The words a card made from `name` follows: discover.js titleWords (4+ letters, no generic or date words, never the
// user's own name). A name with a kind word in it ("Japan Club") is followed as the whole name, and so is one where no
// word survives ("M&T", "AI Ops").
export function seedWords(name, { ownNames = [] } = {}) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  const words = titleWords(clean, { ownNames });
  if (!clean) return [];
  if (!words.length || clean.split(' ').some((word) => KIND_WORDS.has(word.toLowerCase()))) return [clean];
  return words;
}
// A role address answers for a company or a room, not a person: Devpost's support@, a breakout room's calendar.
const ROLE = /^(support|help|hello|hi|team|info|contact|admin|events?|office|hr|careers|jobs|reservations?|bookings?)@|^[\w.-]*(room|breakout)[\w.-]*@/i;

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A word as a whole word, any case: "Hilton" finds "Hilton's hackathon" but not "Hiltonia".
export function wordsIn(text, words) {
  const value = String(text || '');
  return words.some((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(value));
}

const nameIn = (header = '') => String(header).replace(/<[^>]*>/, '').replace(/"/g, '').trim();

// What the look found, from what the readers returned. `inbox` and `sent` are sent-mail.js rows, `chats` the chats.js
// parse (by app), `calls` call-list.js rows. People are counted per message or chat they are in, the user and mailer
// addresses left out, most first, at most PEOPLE_MAX.
// `said`: ids of calls whose transcript says a word SAID_ENOUGH times or more (titles are topics Loggie wrote; what
// was said is the evidence: "Hilton" sat in 1 title and 14 transcripts, cycle 2 of loggie-meetings-focus).
export const SAID_ENOUGH = 3;
export function seedFrom({ words, inbox = [], sent = [], chats = {}, calls = [], own = [], ownNames = [], said = new Set() }) {
  const mine = new Set(own.map((address) => String(address).toLowerCase()));
  const myNames = new Set(ownNames.map((name) => String(name).trim().toLowerCase()).filter(Boolean));
  const person = (address) => address && !mine.has(address) && !MACHINE.test(address) && !ROLE.test(address);
  const people = new Map();
  const count = (key, person) => { const seen = people.get(key); if (seen) { seen.count += 1; if (!seen.name && person.name) seen.name = person.name; } else people.set(key, { ...person, count: 1 }); };
  const mailHits = [];
  for (const message of inbox) {
    if (!wordsIn(message.subject, words)) continue;
    mailHits.push(message);
    const address = addressOf(message.from).toLowerCase();
    if (person(address) && !/\b(breakout|room)\b/i.test(nameIn(message.from))) count(address, { name: nameIn(message.from) === address ? '' : nameIn(message.from), address });
  }
  for (const message of sent) {
    if (!wordsIn(message.subject, words) && !wordsIn(message.body, words)) continue;
    mailHits.push(message);
    for (const address of (message.primary || message.to || []).map((item) => String(item).toLowerCase())) {
      if (person(address)) count(address, { name: '', address });
    }
  }
  let chatHits = 0;
  for (const app of Object.values(chats || {})) {
    // The user in a chat: the app's own handles, or a participant under the user's own name (WhatsApp lists no self).
    const selfHandles = new Set(app?.self || []);
    for (const chat of app?.chats || []) {
      if (!wordsIn(chat.title, words) && !(chat.messages || []).some((message) => wordsIn(message.text, words))) continue;
      chatHits += 1;
      for (const one of chat.participants || []) {
        if (one.handle && !selfHandles.has(one.handle) && !myNames.has(String(one.name || '').trim().toLowerCase())) count(`${chat.app}:${one.handle}`, { name: one.name || '', handle: one.handle });
      }
    }
  }
  const callHits = calls.filter((call) => wordsIn(call.title, words) || said.has(call.id));
  return {
    words,
    mail: mailHits.length,
    chats: chatHits,
    calls: callHits.length,
    unfiledCalls: callHits.filter((call) => !call.workstream && !call.noWorkspace && call.state !== 'recording').map((call) => call.id),
    people: [...people.values()].sort((a, b) => b.count - a.count || (a.name || a.address || a.handle).localeCompare(b.name || b.address || b.handle)).slice(0, PEOPLE_MAX),
  };
}

// The look itself, every reader injected. A reader that fails is named in `notes` and counts nothing; it never stops
// the others (a Mac without chats on still finds the mail).
export async function lookFor(name, { ownNames = [], own = [], readInbox, readSent, readChats = null, listCalls = null, searchSaid = null, days = LOOK_DAYS } = {}) {
  const words = seedWords(name, { ownNames });
  if (!words.length) throw new Error('Give the new workspace a name.');
  const notes = [];
  const tryRead = async (what, read) => { try { return await read(); } catch (error) { notes.push(`${what} could not be read: ${error.message}`); return null; } };
  const [inbox, sent, chats, calls] = await Promise.all([
    own.length && readInbox ? tryRead('Mail', () => readInbox({ address: own, days, keep: (message) => wordsIn(message.subject, words), bodies: false })) : null,
    own.length && readSent ? tryRead('Sent mail', () => readSent({ address: own, days })) : null,
    readChats ? tryRead('Chats', () => readChats({ days })) : null,
    listCalls ? tryRead('Calls', () => listCalls()) : null,
  ]);
  // What was said, word by word (searchCalls needs every word in one line, so each is asked alone).
  const said = new Set();
  if (searchSaid) {
    for (const word of words) {
      const found = await tryRead('What was said', () => searchSaid(word));
      for (const hit of found || []) if ((hit.count || 0) >= SAID_ENOUGH) said.add(hit.id);
    }
  }
  return { ...seedFrom({ words, inbox: inbox || [], sent: sent || [], chats: chats || {}, calls: calls || [], own, ownNames, said }), notes };
}

// The people the user kept, as workstreams.json holds them. Only people the look returned can be kept: the renderer
// sends back keys, never addresses of its own.
export const personKey = (person) => person.address || person.handle;
export function keptPeople(found, keys) {
  const wanted = new Set(keys);
  return found.filter((person) => wanted.has(personKey(person))).map((person) => ({ name: person.name || '', ...(person.address ? { address: person.address } : { handle: person.handle }) }));
}
