// Introductions (loggie-intros, docs/intros/spec.md 1.1-1.2): an email from someone the user wrote to that names a new
// person and gives their address ("have you connected before with Dana Okafor: dana@bank.example"). Code only, on this
// Mac: no model reads the address, and none is needed to find it. The pair is saved to the workspace's people, and a
// pair the user has not written to since becomes a move (workstreams.js catchUp, the code-made move: spike S-C showed
// Nemotron never proposed it from the screened prompt, 0 of 3 runs).
//
//   introducedIn(message, { own, writtenTo, few, names }) -> Pair[]   Pair = { name, address, shape: 'body' | 'to', by, at }
//   introsIn(threads, { own, writtenTo, few, names }) -> Intro[]       Intro = Pair & { thread, message }
//   movable(intros, sent) -> Map<thread id, Intro[]>
// The introducer is someone in `writtenTo`, the Sent `to` addresses only: a person saved from an introduction never
// introduces anyone until the user writes to them. Two shapes: the body names someone and gives their address, or
// (I3) the email is an introduction with one other person on To or Cc ("Introduction: Gio <> Lena Park"). A To pair
// is saved but never a move: the move is the reply to that very email. `names` gives a bare To or Cc address its name
// (readMailPeople, address -> newest name); "Last, First" names are flipped (ask-who.js flipName, D7).
import { FEW, flipName } from './ask-who.js';
import { MACHINE } from './router.js';
import { ownText } from './voice.js';
import { isOwn } from './workstreams.js';

const HEADER = /[^\s<>,;"]+@[^\s<>,;"]+/g;
const IN_BODY = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const SERVICES = ['zoom.us', 'zoomcrc.com', 'calendar.google.com', 'docs.google.com', 'safelinks.protection.outlook.com', 'teams.microsoft.com',
  'linkedin.com', 'eventbrite.com', 'joinhandshake.com', '12twenty.com', 'instructure.com'];
// 1 to 3 capitalised words on the address's own line, then a separator ("Dana Okafor: ", "Ana Ruiz <", "Marcus Bell, ").
const NAME_BEFORE = /((?:\p{Lu}[\p{L}'’.-]+)(?:[ \t]+\p{Lu}[\p{L}'’.-]+){0,2})[ \t]*(?:[:(<\[,-]|[ \t])[ \t]*$/u;
const NOT_A_NAME = new Set(['email', 'e-mail', 'mail', 'pm', 'am', 'to', 'cc', 'from', 'hi', 'hello', 'dear', 'phone', 'tel', 'contact', 'at', 'or', 'and']);
const INTRODUCES = /\bintroduc/i;
const CUE = /\b(?:introduc\w*|connect\w*|reach(?:ing)? out|contact|meet|talk(?:ing)? (?:to|with)|speak(?:ing)? (?:to|with)|chat with|touch base|loop\w* in|put you in touch)\b/i;

const headerAddresses = (value) => (String(value || '').match(HEADER) || []).map((address) => address.toLowerCase());
const isService = (domain) => SERVICES.some((service) => domain === service || domain.endsWith(`.${service}`));

// The name each "Name <address>" in a To or Cc header gives, flipped: whatever sits between the address before it and
// its "<", so a bare address earlier in the list never joins the name. One comma at most ("Romero, Elizabeth").
function headerNames(...values) {
  const out = new Map();
  for (const value of values) {
    const text = String(value || '');
    let from = 0;
    for (const found of text.matchAll(/<([^<>\s@]+@[^<>\s]+)>/g)) {
      const name = text.slice(from, found.index).replace(/^[\s\S]*[^\s<>,;"]+@[^\s<>,;"]+/, '').replace(/^[\s,;"]+|[\s"]+$/g, '').trim();
      from = found.index + found[0].length;
      const address = found[1].toLowerCase();
      if (name && !name.includes('@') && (name.match(/,/g) || []).length <= 1 && !out.has(address)) out.set(address, flipName(name));
    }
  }
  return out;
}

export function introducedIn(message, { own = [], writtenTo = new Set(), few = FEW, names = new Map() } = {}) {
  const time = Date.parse(message?.timestamp);
  if (Number.isNaN(time)) return [];
  const at = new Date(time).toISOString();
  const mine = new Set(own.map((address) => String(address).toLowerCase()));
  const sender = headerAddresses(message.from)[0];
  if (!sender || mine.has(sender) || MACHINE.test(sender) || !writtenTo.has(sender)) return [];
  const recipients = new Set([...headerAddresses(message.to), ...headerAddresses(message.cc)]);
  if (recipients.size > few) return [];
  const headers = new Set([sender, ...recipients]);
  const text = ownText(message.body || '').replace(/<mailto:[^>]*>/gi, '');
  const pairs = new Map();
  for (const found of text.matchAll(IN_BODY)) {
    const address = found[0].replace(/[.,;:]+$/, '').toLowerCase();
    const [local, domain] = address.split('@');
    if (pairs.has(address) || headers.has(address) || mine.has(address) || MACHINE.test(address) || !/^\p{L}/u.test(local) || isService(domain)) continue;
    const name = NAME_BEFORE.exec(text.slice(Math.max(0, found.index - 60), found.index))?.[1];
    if (!name || NOT_A_NAME.has(name.split(/[ \t]+/)[0].toLowerCase())) continue;
    if (!CUE.test(text.slice(Math.max(0, found.index - 200), found.index))) continue;
    pairs.set(address, { name, address, shape: 'body', by: sender, at });
  }
  // More than one is a list (a club's roster of mentors), not an introduction.
  const found = pairs.size === 1 ? [...pairs.values()] : [];
  // The To shape: an email that introduces, to the user and exactly one other person.
  const others = [...recipients].filter((address) => !mine.has(address) && address !== sender && !MACHINE.test(address));
  if (others.length === 1 && INTRODUCES.test(`${message.subject || ''}\n${text.slice(0, 600)}`)) {
    const [address] = others;
    const name = headerNames(message.to, message.cc).get(address) || flipName(String(names.get(address) || '').trim());
    if (name && !name.includes('@')) found.push({ name, address, shape: 'to', by: sender, at });
  }
  return found;
}

// Every introduction in threads the user wrote in, one per address (the earliest).
export function introsIn(threads, { own = [], writtenTo = new Set(), few = FEW, names = new Map() } = {}) {
  const byAddress = new Map();
  for (const thread of threads || []) {
    const messages = thread?.messages || [];
    if (!messages.some((message) => isOwn(message, own))) continue;
    for (const message of messages) {
      if (isOwn(message, own)) continue;
      for (const pair of introducedIn(message, { own, writtenTo, few, names })) {
        const had = byAddress.get(pair.address);
        if (!had || pair.at < had.at) byAddress.set(pair.address, { ...pair, thread: thread.id, message: message.id });
      }
    }
  }
  return [...byAddress.values()];
}

// The introductions that still make a move: written in the body, and the user has not emailed that address since.
export function movable(intros, sent = []) {
  const out = new Map();
  for (const intro of intros || []) {
    if (intro.shape !== 'body') continue;
    const written = (sent || []).some((row) => (row.to || []).map((address) => String(address).toLowerCase()).includes(intro.address) && Date.parse(row.timestamp) > Date.parse(intro.at));
    if (written) continue;
    out.set(intro.thread, [...(out.get(intro.thread) || []), intro]);
  }
  return out;
}

// readMailPeople rows -> address -> the newest name a message gave it (the `names` of introducedIn's To shape).
export function mailNames(rows = []) {
  const out = new Map();
  const at = new Map();
  for (const row of rows || []) {
    const address = String(row?.address || '').toLowerCase();
    const name = String(row?.name || '').trim();
    if (!address || !name || (at.has(address) && String(row.at || '') <= at.get(address))) continue;
    out.set(address, name);
    at.set(address, String(row.at || ''));
  }
  return out;
}
