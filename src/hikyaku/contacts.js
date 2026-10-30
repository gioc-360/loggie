// Names for the people in chats, from the Mac's Contacts (loggie-do-it-context cycle 2, TC2 2026-10-11: "Also look up
// names"). A text from someone not on iMessage reaches Loggie as a bare number (+13235550141), so the router's ask
// read "+13235550141 · Bank Offer?" and the card titled the chat with digits. Contacts already holds the name.
//
// Read-only, through /usr/bin/sqlite3 on each Contacts source's AddressBook-v22.abcddb (the same Full Disk Access
// that reads Messages' chat.db; no Contacts prompt). Nothing leaves the Mac here. A source that cannot be read is
// skipped, so a missing or locked database means fewer names, never a failed read.
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const CONTACTS_ROOT = join(homedir(), 'Library', 'Application Support', 'AddressBook');
const DB = 'AddressBook-v22.abcddb';
const NAME = "trim(ifnull(r.ZFIRSTNAME, '') || ' ' || ifnull(r.ZLASTNAME, ''))";
const QUERY = `SELECT p.ZFULLNUMBER AS key, ${NAME} AS name, r.ZORGANIZATION AS org FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
UNION ALL SELECT e.ZADDRESS AS key, ${NAME} AS name, r.ZORGANIZATION AS org FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER;`;

// One key per phone number or address: the last 10 digits of a number (so +1 (323) 555-0141, 3235550141 and
// +13235550141 meet), a lowercased address. Short codes and anything under 7 digits have no key.
export function contactKey(value) {
  const text = String(value || '').trim();
  if (text.includes('@')) return text.toLowerCase();
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

// sqlite3 -json rows to a Map of key -> name. A person with no first or last name takes the company's name.
// The names that came only from a company field are kept on the map as `companies`, so peopleOf can leave them out.
export function contactMap(rows) {
  const names = new Map();
  const people = new Set();
  const companies = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = contactKey(row?.key);
    const person = String(row?.name || '').trim();
    const name = person || String(row?.org || '').trim();
    if (key && name && !names.has(key)) names.set(key, name);
    if (name) (person ? people : companies).add(name);
  }
  names.companies = new Set([...companies].filter((name) => !people.has(name)));
  return names;
}

// The Contacts names that are people. A company card is not one, and neither is a card that reads like an office
// ("Hpu Business Office", saved as a first name), so their words never stop a web search as if they were a person's
// (loggie-errand replay, 2026-10-15: "business" blocked a banking errand; Gio, TC3: "Office cards aren't people").
export const OFFICE_WORDS = Object.freeze(['office', 'desk', 'team', 'support', 'admissions', 'department', 'dept', 'center', 'centre', 'services', 'reception', 'registrar', 'helpdesk', 'hotline']);
const officeLike = (name) => String(name).toLowerCase().split(/[^a-z]+/).some((word) => OFFICE_WORDS.includes(word));
export function peopleOf(names) {
  const companies = names?.companies instanceof Set ? names.companies : new Set();
  return [...new Set(names instanceof Map ? names.values() : [])].filter((name) => !companies.has(name) && !officeLike(name));
}

export async function readContacts({ root = CONTACTS_ROOT, execImpl = run } = {}) {
  const sources = await readdir(join(root, 'Sources')).catch(() => []);
  const files = [join(root, DB), ...sources.map((source) => join(root, 'Sources', source, DB))];
  const rows = [];
  for (const file of files) {
    try {
      const { stdout } = await execImpl('/usr/bin/sqlite3', ['-readonly', '-json', file, QUERY], { maxBuffer: 32 * 1024 * 1024, timeout: 15000 });
      if (stdout.trim()) rows.push(...JSON.parse(stdout));
    } catch { /* a source that cannot be read gives no names */ }
  }
  return contactMap(rows);
}

// Contacts change rarely; one read serves ten minutes of checks.
let cached = null;
export async function contactNames({ now = Date.now(), maxAgeMs = 10 * 60 * 1000, ...options } = {}) {
  if (!cached || now - cached.at > maxAgeMs) cached = { at: now, names: await readContacts(options) };
  return cached.names;
}

// The chat reader's result with names filled in: a participant with no name gets the Contacts name for its handle, and
// a 1:1 chat titled with its own handle (or nothing) takes that name. Names the chat app already gave are kept.
export function nameChats(result, names) {
  if (!(names instanceof Map) || !names.size) return result;
  const nameOf = (handle) => names.get(contactKey(handle)) || null;
  const out = {};
  for (const [app, answer] of Object.entries(result || {})) {
    out[app] = !answer?.chats ? answer : {
      ...answer,
      chats: answer.chats.map((chat) => {
        const participants = (chat.participants || []).map((person) => (person.name ? person : { ...person, name: nameOf(person.handle) }));
        const only = !chat.isGroup && participants.length === 1 ? participants[0] : null;
        const titleIsHandle = !chat.title || chat.title === 'chat' || (only && contactKey(chat.title) && contactKey(chat.title) === contactKey(only.handle));
        return { ...chat, participants, title: only?.name && titleIsHandle ? only.name : chat.title };
      }),
    };
  }
  return out;
}
