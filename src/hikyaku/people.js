// Who "Jess" is, without searching: every "Name <address>" pair Loggie has already read in a saved thread (the
// THREAD.md headers under work/), counted. A name resolves only when one person answers to it. Two people who both
// answer to "Jess" is a question for the user, never a guess (2026-10-09: an invite matched Jess to an address by
// her position in a calendar list, and was right by luck). Reading all 117 threads took about 100 ms, so there is
// no cache to go stale.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from './draft.js';

const PAIR = /(\p{Lu}[\p{L}'’.-]*(?: \p{Lu}[\p{L}'’.-]*){1,3}) <([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/gu;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const fold = (text) => String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Every person in the threads: { address, name (the name written most often beside it), count }, most-seen first.
export function peopleIn(texts) {
  const byAddress = new Map();
  for (const text of texts) {
    for (const [, name, address] of String(text).matchAll(PAIR)) {
      const key = address.toLowerCase();
      const person = byAddress.get(key) || { address: key, names: new Map(), count: 0 };
      person.names.set(name, (person.names.get(name) || 0) + 1);
      person.count += 1;
      byAddress.set(key, person);
    }
  }
  return [...byAddress.values()]
    .map(({ address, names, count }) => ({ address, name: [...names.entries()].sort((a, b) => b[1] - a[1])[0][0], count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export async function loadPeople({ home = HIKYAKU_HOME } = {}) {
  const root = join(home, 'work');
  const files = (await readdir(root, { recursive: true }).catch(() => [])).filter((file) => file.endsWith('THREAD.md'));
  const texts = await Promise.all(files.map((file) => readFile(join(root, file), 'utf8').catch(() => '')));
  return peopleIn(texts);
}

// One spoken name to one person. A whole name beats a first or last name, which beats the start of a name ("Amri").
// Returns { status: 'one', person } | { status: 'many', candidates } | { status: 'none' }. An address is itself.
export function resolvePerson(query, people) {
  const q = fold(query);
  if (EMAIL.test(q)) return { status: 'one', person: people.find((p) => p.address === q) || { address: q, name: query.trim(), count: 0 } };
  if (!q) return { status: 'none' };
  const tiers = [
    (p) => fold(p.name) === q,
    (p) => fold(p.name).split(/\s+/).includes(q),
    (p) => q.length >= 3 && fold(p.name).split(/\s+/).some((part) => part.startsWith(q)),
  ];
  for (const match of tiers) {
    const found = people.filter(match);
    if (found.length === 1) return { status: 'one', person: found[0] };
    if (found.length > 1) return { status: 'many', candidates: found.slice(0, 5) };
  }
  // A whole name with one word a letter off ("jamei chen").
  if (q.includes(' ')) {
    const typed = q.split(/\s+/);
    const close = people.filter((p) => { const parts = fold(p.name).split(/\s+/); return parts.length === typed.length && parts.filter((part, i) => part !== typed[i]).length === 1 && parts.every((part, i) => part === typed[i] || (typed[i].length >= 4 && oneEdit(part, typed[i]))); });
    if (close.length === 1) return { status: 'one', person: close[0], slip: true };
  }
  // A one-letter slip ("marisl" for Marisol) on a name of five or more letters, when only one person fits.
  if (q.length >= 4 && !q.includes(' ')) {
    const close = people.filter((p) => fold(p.name).split(/\s+/).some((part) => part.length >= 5 && oneEdit(part, q)));
    if (close.length === 1) return { status: 'one', person: close[0], slip: true };
    if (close.length > 1) return { status: 'many', candidates: close.slice(0, 5) };
  }
  return { status: 'none' };
}

// True when a and b differ by one letter added, dropped or changed, or two letters side by side swapped ("jaime").
export function oneEdit(a, b) {
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
