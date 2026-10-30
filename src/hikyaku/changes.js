// The change log (docs/workstream-integration/proposal.md): one line per new thing any source saw since Loggie last
// looked, and where it was routed. Every source speaks this one shape, so the router and the re-read never care
// whether an item was an email, a chat, an invite or a call.
//
//   ChangeItem { id, source, at, title, who: [{ name, address? , handle? }], ref, thread, workstream, how, candidates }
//     source      gmail | outlook | messages | whatsapp | calendar | call | park
//     at          ISO time of the item itself (the email's date, the event's start, the call's start)
//     ref         the source's own id: message id, chat id, event id, call folder
//     thread      what continues it: a Gmail thread id, an Outlook subject, a chat id, an event series; or empty
//     workstream  the one workstream it belongs to, or null when the router is not sure
//     how         thread | filed | domain | word | person | asked | none: the evidence that routed it
//     candidates  when unsure, the workstreams it might belong to; never a guess written as a route
//
// <home>/changes.jsonl is append only and keyed by id, so a source that sees the same item twice adds one line.
// <home>/looked.json is the watermark: per source, when Loggie last looked, plus the cursors of the stores that keep
// things late (outlookRow: Apple Mail's last ROWID; messagesRow: per chat app). Nothing here reads mail or calls a model.
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCES = Object.freeze(['gmail', 'outlook', 'messages', 'whatsapp', 'calendar', 'call', 'park']);
export const CURSORS = Object.freeze(['outlookRow', 'messagesRow']);
// What the cloud sort already read of each chat, the chats it still owes an answer, and the one-time re-sort's mark
// (sources.js checkChanges, 2026-10-23).
export const SORTS = Object.freeze(['chatSorted', 'chatPending', 'chatResorted']);
export const HOW = Object.freeze(['thread', 'filed', 'domain', 'word', 'person', 'asked', 'none']);

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function makeItem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('A change item must be an object.');
  if (!SOURCES.includes(raw.source)) throw new Error(`Unknown change source "${raw.source}".`);
  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  if (!at) throw new Error('A change item needs the time it happened.');
  const ref = text(raw.ref, 300);
  if (!ref) throw new Error('A change item needs its source id.');
  const workstream = text(raw.workstream, 200) || null;
  const how = workstream ? (HOW.includes(raw.how) && raw.how !== 'none' ? raw.how : null) : 'none';
  if (!how) throw new Error('A routed change item needs the evidence that routed it.');
  const who = (Array.isArray(raw.who) ? raw.who : []).map((person) => ({
    name: text(person?.name, 120),
    ...(text(person?.address, 200) ? { address: text(person.address, 200).toLowerCase() } : {}),
    ...(text(person?.handle, 120) ? { handle: text(person.handle, 120) } : {}),
  })).filter((person) => person.name || person.address || person.handle).slice(0, 50);
  const candidates = workstream ? [] : [...new Set((Array.isArray(raw.candidates) ? raw.candidates : []).map((name) => text(name, 200)).filter(Boolean))];
  // `quote`: the words a suggested home rests on (suggest.js), shown with the ask; only an unsure item carries one.
  const quote = !workstream && candidates.length ? text(raw.quote, 300) : '';
  return Object.freeze({ id: `${raw.source}:${ref}`, source: raw.source, at, title: text(raw.title, 300), who, ref, thread: text(raw.thread, 300), workstream, how, candidates, ...(quote ? { quote } : {}) });
}

// A line moved to another workspace (File here, screen-data.js moveThread) is answered by a copy whose ref ends
// "#moved": the copy is the line from then on, so the moved line leaves every reader. `all` keeps both, for the
// append's "already seen" check (a moved message seen again must not come back).
export async function readChanges(home, { since = null, workstream, all = false } = {}) {
  const raw = await readFile(join(home, 'changes.jsonl'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const cutoff = since ? Date.parse(since) : null;
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { continue; }
  }
  const moved = all ? new Set() : new Set(lines.map((item) => item.id).filter((id) => /#moved$/.test(String(id))).map((id) => String(id).replace(/#moved$/, '')));
  const items = [];
  for (const item of lines) {
    if (moved.has(item.id)) continue;
    if (cutoff !== null && Date.parse(item.at) <= cutoff) continue;
    if (workstream !== undefined && item.workstream !== workstream) continue;
    items.push(item);
  }
  return items;
}

// Appends the items not already in the log; returns the ones it wrote.
export async function appendChanges(home, items) {
  const seen = new Set((await readChanges(home, { all: true })).map((item) => item.id));
  const fresh = [];
  for (const raw of items) {
    const item = makeItem(raw);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    fresh.push(item);
  }
  if (fresh.length) await appendFile(join(home, 'changes.jsonl'), fresh.map((item) => `${JSON.stringify(item)}\n`).join(''));
  return fresh;
}

export async function readLooked(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'looked.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Loggie could not read when it last looked (looked.json): ${error.message}`);
  }
}

// Merges one source's watermark into looked.json. A watermark is an ISO time, or an object for a source that keeps
// more (Gmail per workstream, the calendar's last snapshot).
// One read-merge-write at a time per home: two at once shared the temporary file, so one threw ENOENT and its key was
// lost (Codex review, round 2, 2026-10-23).
const lookedChains = new Map();
export function writeLooked(home, source, value) {
  if (!SOURCES.includes(source) && !CURSORS.includes(source) && !SORTS.includes(source)) return Promise.reject(new Error(`Unknown change source "${source}".`));
  const file = join(home, 'looked.json');
  const run = (lookedChains.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const looked = await readLooked(home);
    looked[source] = value;
    // Whole or not at all, like call-notes.js: a write cut halfway left JSON readLooked refuses, and every refresh
    // after it threw (Codex review, 2026-10-23).
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(looked, null, 2)}\n`);
    await rename(temp, file);
    return looked;
  });
  lookedChains.set(file, run);
  run.finally(() => { if (lookedChains.get(file) === run) lookedChains.delete(file); }).catch(() => {});
  return run;
}
