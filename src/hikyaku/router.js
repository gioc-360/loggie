// The router (docs/workstream-integration/proposal.md): which workstream one new item belongs to, by code, with the
// evidence that says so. Nothing is guessed. When the evidence is weak or split, the item stays unsure and carries
// its candidates, so a later prompt can ask the user once.
//
// Evidence, strongest first (spike 2026-10-10 on real mail, chats and calendar; session.md "Spikes"):
//   filed    a recorded call already filed to a workstream (calls.js, byo.py) keeps that filing
//   thread   the item continues a thread, chat or event already routed (changes.jsonl), or one listed by the caller
//   domain   a sender or recipient at one of the workstream's domains
//   word     the workstream's name or one of its words in the title or text, not counting the people's own names
//   person   someone the user confirmed belongs here (workstream.people: an address or a chat handle)
// A domain or word that points at two workstreams is narrowed by the other signals; if it stays split, it is unsure.
// A correspondent learned from the workstream's own threads is only a suggestion: on real mail a professor from one
// thread pulled her other mail in, so a learned person alone never routes.
// Big lists (over 8 recipients, or a group chat over 12) and machine senders never count as a person.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slug, withoutNames } from './util.js';
import { baseSubject } from './sent-mail.js';

export const BIG_EMAIL = 8;
export const BIG_CHAT = 12;
export const MACHINE = /no-?reply|notifications?@|mailer|bounce|donotreply|newsletter@|news@|info@|calendar-?notification|@[\w.-]*12twenty\.com$/i;

const low = (value) => String(value || '').toLowerCase();
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordHit(text, word) {
  const w = low(word).trim();
  if (w.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${escape(w)}([^a-z0-9]|$)`).test(text);
}

function domainHit(addresses, domain) {
  const d = low(domain).trim();
  return Boolean(d) && addresses.some((address) => address.endsWith(`@${d}`) || address.endsWith(`.${d}`));
}

// The people each workstream's own threads show the user writing to or hearing from: only threads the user wrote in,
// never a machine sender, never a recipient list over BIG_EMAIL. Reads <home>/work/<slug>/**/THREAD.md.
export async function learnPeople({ home, workstreams, ownAddresses = [] }) {
  const own = new Set(ownAddresses.map(low));
  const learned = new Map();
  for (const workstream of workstreams) {
    const keep = new Map();
    for (const thread of await threadFiles(join(home, 'work', slug(workstream.name)))) {
      const heads = [...thread.matchAll(/^## (?:(.*?) <)?([^\s<>@]+@[^\s<>]+?)>? · /gm)].map((m) => ({ name: (m[1] || '').trim(), address: low(m[2]) }));
      if (!heads.some((head) => own.has(head.address))) continue;
      const recipients = [...thread.matchAll(/^(?:To|Cc): (.*)$/gm)].flatMap((m) => [...m[1].matchAll(/(?:([^,<]+?)\s*)?<?([^\s,<>@]+@[^\s,<>]+?)>?(?=,|$)/g)]
        .map((x) => ({ name: (x[1] || '').replace(/^,\s*/, '').trim(), address: low(x[2]) })));
      for (const person of [...heads, ...(recipients.length <= BIG_EMAIL ? recipients : [])]) {
        if (own.has(person.address) || MACHINE.test(person.address)) continue;
        if (!keep.has(person.address) || (!keep.get(person.address).name && person.name)) keep.set(person.address, person);
      }
    }
    learned.set(workstream.name, [...keep.values()]);
  }
  return learned;
}

async function threadFiles(dir) {
  const out = [];
  async function walk(path, depth) {
    if (depth > 3) return;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.name === 'THREAD.md') out.push(await readFile(next, 'utf8').catch(() => ''));
    }
  }
  await walk(dir, 0);
  return out;
}

// Threads each workstream already holds, by subject (the first line of each THREAD.md), so an Outlook reply on one
// continues it, but only when one of that thread's people (never the user, never a machine sender) is on the reply too: on real mail a generic subject
// ("Thank You For Applying!") would otherwise pull any company's mail in. A subject two workstreams share is dropped.
export async function learnThreads({ home, workstreams, ownAddresses = [] }) {
  const own = new Set(ownAddresses.map(low));
  const owner = new Map();
  for (const workstream of workstreams) {
    for (const thread of await threadFiles(join(home, 'work', slug(workstream.name)))) {
      const subject = baseSubject((thread.match(/^# (.*)$/m) || [])[1] || '');
      if (!subject) continue;
      const key = `outlook:${subject}`;
      const addresses = new Set([...thread.matchAll(/[^\s<>(),:]+@[^\s<>(),:]+\.[a-z]{2,}/gi)].map((m) => low(m[0])).filter((address) => !own.has(address) && !MACHINE.test(address)));
      const prior = owner.get(key);
      if (prior === null) continue;
      if (prior && prior.workstream !== workstream.name) { owner.set(key, null); continue; }
      owner.set(key, { workstream: workstream.name, addresses: new Set([...(prior?.addresses || []), ...addresses]) });
    }
  }
  return new Map([...owner].filter(([, value]) => value));
}

// Thread continuity: `seed` (learnThreads) plus the log's newest routed item per thread key. A log entry is the
// source's own thread id, so it needs no people check.
export function threadMap(items, seed = new Map()) {
  const map = new Map(seed);
  for (const item of [...items].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (item.workstream && item.thread) map.set(`${item.source}:${item.thread}`, { workstream: item.workstream, addresses: null });
  }
  return map;
}

// item: { source, title, text?, who: [{ name, address?, handle? }], thread?, filed?, recipients?, big? }
// context: { workstreams, learned: Map(name -> people), threads: Map(source:thread -> name) }
// Returns { workstream, how, candidates }.
export function route(item, { workstreams, learned = new Map(), threads = new Map() }) {
  const named = workstreams.filter((workstream) => !workstream.inbox && !workstream.chats && !workstream.folder);
  const names = new Set(named.map((workstream) => workstream.name));
  const sure = (workstream, how) => ({ workstream, how, candidates: [] });
  const unsure = (candidates) => ({ workstream: null, how: 'none', candidates: [...new Set(candidates)] });

  if (item.filed && names.has(item.filed)) return sure(item.filed, 'filed');
  const who = item.who || [];
  const addresses = who.map((person) => low(person.address)).filter(Boolean);
  const continued = item.thread ? threads.get(`${item.source}:${item.thread}`) : null;
  if (continued && names.has(continued.workstream) && (!continued.addresses || addresses.some((address) => continued.addresses.has(address)))) return sure(continued.workstream, 'thread');

  const handles = who.map((person) => low(person.handle)).filter(Boolean);
  const big = item.big ?? (item.source === 'messages' || item.source === 'whatsapp' ? who.length > BIG_CHAT : (item.recipients ?? addresses.length) > BIG_EMAIL);
  // A word inside a person's own name is not a topic: Dana Pharmco writing about a job is not the Pharmco case comp.
  const text = withoutNames(`${item.title || ''}\n${item.text || ''}`, who.flatMap((person) => [person.name, person.address]));

  const domain = named.filter((workstream) => (workstream.domains || []).some((d) => domainHit(addresses, d))).map((w) => w.name);
  const word = named.filter((workstream) => [workstream.name, ...(workstream.words || [])].some((w) => wordHit(text, w))).map((w) => w.name);
  const confirmed = big ? [] : named.filter((workstream) => (workstream.people || []).some((person) =>
    (person.address && addresses.includes(low(person.address))) || (person.handle && handles.includes(low(person.handle))))).map((w) => w.name);
  const suggested = big ? [] : named.filter((workstream) => (learned.get(workstream.name) || []).some((person) =>
    addresses.includes(person.address) && !MACHINE.test(person.address))).map((w) => w.name);

  const rules = [...new Set([...domain, ...word])];
  if (rules.length === 1) return sure(rules[0], domain.includes(rules[0]) ? 'domain' : 'word');
  if (rules.length > 1) {
    const narrowed = rules.filter((name) => confirmed.includes(name) || suggested.includes(name) || (domain.includes(name) && word.includes(name)));
    if (narrowed.length === 1) return sure(narrowed[0], domain.includes(narrowed[0]) ? 'domain' : 'word');
    return unsure(rules);
  }
  if (confirmed.length === 1) return sure(confirmed[0], 'person');
  if (confirmed.length > 1) return unsure(confirmed);
  return unsure(suggested);
}
