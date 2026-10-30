// What the Workstreams screen shows on each card besides the summary (docs/archive/workstreams-screen/proposal.md): what is
// new since the last read, what a re-read is likely to cost, when the card's window ends, and the questions the
// router could not settle on its own (asks). Pure, except the readers and answerAsk, which writes the user's answer.
//
// <home>/asked.jsonl keeps every answer, Yes (a workstream name) or No (null), so a question is asked once. A Yes also
// teaches the router: the person is saved on the workstream and a routed copy of the item continues its thread there.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendChanges, readChanges } from './changes.js';
import { unseenFor } from './refresh.js';
import { USAGE_FILE } from './usage.js';
import { readWorkstreams, saveWorkstreamFields } from './workstreams.js';

export const ASKED_FILE = 'asked.jsonl';
const CHAT_SOURCES = new Set(['messages', 'whatsapp']);
const ESTIMATE_ROWS = 10;

const cap = (limit) => Math.max(0, Math.floor(limit));
const time = (at) => Date.parse(at) || 0;
// Newest first; on a tie the later log line comes first.
const newestFirst = (items) => items.map((item, index) => ({ item, index }))
  .sort((a, b) => time(b.item.at) - time(a.item.at) || b.index - a.index).map(({ item }) => item);

async function jsonLines(file) {
  const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { continue; }
  }
  return rows;
}

// What the change log routed here that the summary has not folded in yet.
export function newsFor(items, state, name, limit = 5) {
  return newestFirst(unseenFor(items, state, name)).slice(0, cap(limit))
    .map(({ id, source, title, at }) => ({ id, source, title, at }));
}

export async function readUsageRows(home) {
  return (await jsonLines(join(home, USAGE_FILE))).filter((row) => row && typeof row === 'object');
}

// A re-read's likely price: the mean of the last ten priced catch-ups (path "mail"). Free when it does not use the
// cloud; null when there is nothing to go on yet.
export function estimateUsd(usageRows, workstream) {
  if (workstream?.cloud !== 'nebius') return 0;
  const priced = usageRows.filter((row) => row?.path === 'mail' && typeof row.usd === 'number' && Number.isFinite(row.usd)).slice(-ESTIMATE_ROWS);
  if (!priced.length) return null;
  const mean = priced.reduce((sum, row) => sum + row.usd, 0) / priced.length;
  return Math.round(mean * 1e4) / 1e4;
}

// The last dated thing on the card: a milestone or the next move's due date, as "YYYY-MM-DD".
export function windowEnd(card) {
  const dates = (Array.isArray(card?.milestones) ? card.milestones : [])
    .map((milestone) => milestone?.at).filter((at) => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
    .map((at) => at.slice(0, 10));
  const due = card?.priority?.due;
  if (typeof due === 'string' && !Number.isNaN(Date.parse(due))) dates.push(due.slice(0, 10));
  return dates.length ? dates.sort().at(-1) : null;
}

export async function readAnswered(home) {
  return new Set((await jsonLines(join(home, ASKED_FILE))).filter((row) => typeof row?.id === 'string').map((row) => row.id));
}

// The router's open questions for this workstream: unsure items that name it as a candidate, not yet answered.
// One ask per conversation: a chat that keeps talking makes a new unsure item each check, so only its newest is asked,
// and a conversation already answered (yes or no) is not asked again. The newest is picked across every workspace,
// then kept only where it names this one (Codex review, 2026-10-23: a chat suggested for one workspace, then for
// another on newer words, was asked on Today twice, once per workspace).
export function asksFor(items, answered, name, limit = 3) {
  const threadOf = (item) => `${item.source}:${item.thread || item.ref}`;
  const done = new Set(items.filter((item) => answered.has(item.id)).map(threadOf));
  const open = items.filter((item) => item.workstream === null && (item.candidates || []).length && !answered.has(item.id) && !done.has(threadOf(item)));
  const seen = new Set();
  const newest = newestFirst(open).filter((item) => !seen.has(threadOf(item)) && seen.add(threadOf(item))).filter((item) => item.candidates.includes(name));
  return newest.slice(0, cap(limit)).map(({ id, source, title, at, who, quote }) => ({ id, source, title, at, who, ...(quote ? { quote } : {}) }));
}

const handleKey = (handle) => handle.replace(/\D/g, '') || handle.toLowerCase();
function personFrom(item) {
  const who = Array.isArray(item.who) ? item.who : [];
  if (CHAT_SOURCES.has(item.source)) return who.length === 1 && who[0]?.handle ? { name: who[0].name || '', handle: who[0].handle } : null;
  const first = who.find((person) => person?.address);
  return first ? { name: first.name || '', address: first.address.toLowerCase() } : null;
}
function samePerson(a, b) {
  if (a.address && b.address) return a.address.toLowerCase() === b.address.toLowerCase();
  if (a.handle && b.handle) return handleKey(a.handle) === handleKey(b.handle);
  return false;
}

// The user's answer to one ask. `workstream` is a named workstream (Yes, it belongs there) or null (No). The asked.jsonl
// line is written last, so a failure before it leaves the question open.
// File here (loggie-workspaces-integration F4): a routed thread moves to another workspace, the whole thread. Each of
// its lines gets a copy filed under the target (how 'asked', as an answer is), whose ref ends "#moved": readChanges
// then drops the moved lines, so the old workspace stops counting them, and the router's thread map follows the newest
// line, so later messages in the thread file under the target. (2026-10-26: the Hospitality Hackathon chat, 54
// messages, sat under Karaoke since one word on Oct 21, with no way out; only unsure items could be answered.)
export async function moveThread({ home, itemId, workstream }) {
  const target = (await readWorkstreams(home)).find((w) => w.name === workstream && !w.inbox && !w.chats && !w.folder);
  if (!target) throw new Error(`No workspace named "${workstream}".`);
  const items = await readChanges(home);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) throw new Error('That message is no longer in the list.');
  if (item.workstream === target.name) return { moved: 0, from: item.workstream, to: target.name };
  const lines = items.filter((entry) => entry.workstream === item.workstream && entry.source === item.source && (item.thread ? entry.thread === item.thread : entry.id === item.id));
  const copies = lines.map((entry) => ({ ...entry, ref: `${entry.ref}#moved`, workstream: target.name, how: 'asked', candidates: [] }));
  const written = await appendChanges(home, copies);
  return { moved: written.length, from: item.workstream, to: target.name };
}

export async function answerAsk({ home, item, workstream, now = new Date() }) {
  let target = null;
  if (workstream !== null) {
    const named = (await readWorkstreams(home)).filter((w) => !w.inbox && !w.chats && !w.folder);
    target = named.find((w) => w.name === workstream);
    if (!target) throw new Error(`No workspace named "${workstream}".`);
  }
  let saved = 0;
  let logged = 0;
  if (target) {
    const person = personFrom(item);
    const people = target.people || [];
    if (person && !people.some((known) => samePerson(known, person))) {
      const after = await saveWorkstreamFields(home, target.name, { people: [...people, person] });
      saved = Math.max(0, (after?.people?.length || 0) - people.length);
    }
    logged = (await appendChanges(home, [{ ...item, ref: `${item.ref}#asked`, workstream: target.name, how: 'asked', candidates: [] }])).length;
  }
  await appendFile(join(home, ASKED_FILE), `${JSON.stringify({ at: now.toISOString(), id: item.id, answer: target ? target.name : null })}\n`);
  return { saved, logged };
}
