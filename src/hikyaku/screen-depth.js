// The detail a wide Workstreams screen adds to the focused card (docs/archive/workstreams-widths/proposal.md): its open moves,
// who is waiting on the user, what the newest messages actually said, and the newest call's next steps. Everything is
// read from files Loggie already keeps on this Mac (THREAD.md in each task folder, the call folders); nothing here
// reads mail or calls a model. Pure except the two readers at the bottom.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { baseSubject } from './sent-mail.js';
import { summaryOf } from './call-list.js';
import { unmask } from './class-names.js';
import { eventLines, newestSummary } from './gather.js';

export const MAX_MOVES = 5;
export const MAX_LATEST = 3;
export const EXCERPT_CHARS = 280;
const EMAIL = new Set(['gmail', 'outlook']);
const low = (value) => String(value || '').toLowerCase();

// Open moves in the order the card already uses, without the ones being worked on or snoozed.
// kind: what made the move, read off its source id; the screen's To send / To do rule (today-model.js moveGroup) reads it.
export function movesFor(tasks, snoozed = new Set(), limit = MAX_MOVES) {
  return tasks.filter((task) => !['done', 'running', 'blocked'].includes(task.status) && !snoozed.has(task.id)).slice(0, limit)
    .map((task) => ({ id: task.id, title: task.title, due: task.dueAt ? String(task.dueAt).slice(0, 10) : null, waiting: /:reply$/.test(String(task.sourceId || '')), kind: moveKindOf(task.sourceId) }));
}

// The kind a move's source id carries: "<thread>:<kind>" from a catch-up (workstreams.js KINDS), "<thread>:email:<who>"
// from a text or an introduction, "<thread>:move" after Send (next-move.js), "call:" / "callstep:" from a call, "owed:"
// for a note owed after a call (gather.js). Anything else: null.
export function moveKindOf(sourceId) {
  const id = String(sourceId || '');
  if (/^(call|callstep):/.test(id)) return 'call';
  if (/^owed:/.test(id)) return 'owed';
  if (/:email(:|$)/.test(id)) return 'email';
  return /:(reply|prep|apply|deadline|event|move)$/.exec(id)?.[1] || null;
}

// The messages in a THREAD.md: "## Name <address> · ISO" (or "## address · ISO") then the body, without the To/Cc
// lines and the links list hikyaku appends.
export function threadMessages(markdown) {
  const messages = [];
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    const head = /^## (?:(.*?) <)?([^\s<>@]+@[^\s<>]+?)>? · (\S+)\s*$/.exec(line) || /^## (.+?) · (\S+)\s*$/.exec(line);
    if (head) {
      current = head.length === 4 ? { name: (head[1] || '').trim().replace(/^"(.*)"$/, '$1'), address: low(head[2]), at: head[3], body: [] } : { name: head[1].trim(), address: '', at: head[2], body: [] };
      messages.push(current);
      continue;
    }
    if (!current || /^(To|Cc):/.test(line)) continue;
    if (/^Links in this (email|chat)/.test(line)) { current = null; continue; }
    current.body.push(line);
  }
  return messages.map((m) => ({ ...m, body: m.body.join('\n').trim() }));
}

export function excerpt(text, max = EXCERPT_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

const newest = (messages) => [...messages].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

// The newest sender who is not the user: who a reply move is waiting on.
export function lastOtherSender(markdown, own = []) {
  const mine = new Set(own.map(low));
  const other = newest(threadMessages(markdown)).find((m) => !(m.address && mine.has(m.address)) && m.name !== 'You');
  return other ? (other.name || other.address) : null;
}

// Names behind the waiting moves, once each, in move order. `threadOf(id)` returns that move's THREAD.md text.
export function waitingOnFor(moves, threadOf, own = []) {
  const names = [];
  for (const move of moves.filter((m) => m.waiting)) {
    const name = lastOtherSender(threadOf(move.id), own);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// What the newest routed email items said: for each (newest first), the workstream thread with the same subject and
// its newest message. An item with no thread file still shows who and when, with no excerpt. One per subject.
export function latestFor({ items, threads, own = [], limit = MAX_LATEST }) {
  const mine = new Set(own.map(low));
  const bySubject = new Map(threads.map((t) => [baseSubject(t.subject), t]));
  const seen = new Set();
  const out = [];
  for (const item of [...items].filter((i) => EMAIL.has(i.source)).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))) {
    const subject = baseSubject(item.title);
    if (!subject || seen.has(subject)) continue;
    seen.add(subject);
    const thread = bySubject.get(subject);
    const message = thread ? newest(threadMessages(thread.markdown)).find((m) => !(m.address && mine.has(m.address))) || newest(threadMessages(thread.markdown))[0] : null;
    const sender = (item.who || []).find((p) => p.address && !mine.has(low(p.address)));
    out.push({ source: item.source, title: item.title, at: message?.at || item.at, who: message ? (message.name || message.address) : (sender?.name || sender?.address || ''), excerpt: message ? excerpt(message.body) : null });
    if (out.length >= limit) break;
  }
  return out;
}

// Every THREAD.md under a workstream's folder, with its subject (the first "# " line).
export async function readThreads(directory) {
  const out = [];
  async function walk(path, depth) {
    if (depth > 3) return;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.name === 'THREAD.md') {
        const markdown = await readFile(next, 'utf8').catch(() => '');
        out.push({ path: next, subject: (markdown.match(/^# (.*)$/m) || [])[1] || '', markdown });
      }
    }
  }
  if (directory) await walk(directory, 0);
  return out;
}

// The newest routed call's next steps: { title, at, lines } or null. A class's notes keep "Student N" on disk; the
// card is read on this Mac, so the names come back from the call's map (call-list.js summaryOf, as callDetail does).
export async function callStepsFor({ home, items }) {
  const call = [...items].filter((i) => i.source === 'call').sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
  if (!call) return null;
  const folder = join(home, 'calls', call.thread);
  const names = (await summaryOf(folder).catch(() => null))?.names;
  const lines = eventLines(unmask(await newestSummary(folder).catch(() => null), names));
  return { title: call.title, at: call.at, lines, folder: call.thread };
}
