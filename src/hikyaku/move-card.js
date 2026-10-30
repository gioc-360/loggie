// What a move shows on its card when opened (loggie-do-it-context, mock D chosen 2026-10-11): which app its draft
// opens in, the last two messages of its conversation, and the call it came from. Read from the files the move
// already has (REPLY.json, THREAD.md, CALL.md); no model, no network. Also the user's own date for a move
// (due-dates.json), which wins over the date the catch-up wrote.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { excerpt, threadMessages } from './screen-depth.js';
import { MACHINE } from './router.js';

export const DUE_FILE = 'due-dates.json';

// Chats this Mac can read but not send (Gio, 2026-10-11: "if it sends via rcs or sms, its just grayed out so we dont go
// through this dilemma while still being able to use messages as source of info"). A green-bubble text from the Mac
// relays through the iPhone, and on his setup it never left: four tries to an Android contact sat unsent or failed.
export const MAC_CANNOT_SEND = new Set(['SMS', 'RCS']);
export const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const run = promisify(execFile);

// Each Messages chat's service by its id (chat.db ROWID, which the chat reader reports as the chat id). Read-only;
// an unreadable database gives an empty map, and then nothing is grayed out.
export async function readChatServices({ dbPath = CHAT_DB, execImpl = run } = {}) {
  try {
    const { stdout } = await execImpl('/usr/bin/sqlite3', ['-readonly', '-json', dbPath, 'SELECT ROWID AS id, service_name AS service FROM chat;'], { maxBuffer: 16 * 1024 * 1024, timeout: 10000 });
    return new Map((stdout.trim() ? JSON.parse(stdout) : []).map((row) => [String(row.id), String(row.service || '')]));
  } catch { return new Map(); }
}

// Whether the move's draft can be sent from this Mac: false only for a Messages chat on SMS or RCS.
export function macCanSend(reply, services = new Map()) {
  return !(reply?.app === 'messages' && MAC_CANNOT_SEND.has(services.get(String(reply.chatId || ''))));
}
export const SAID_CHARS = 280;
const CHAT_APPS = new Set(['messages', 'whatsapp']);
const CP1252 = { '91': '‘', '92': '’', '93': '“', '94': '”', '96': '–', '97': '—', '85': '…', A0: ' ' };

// The app the move's draft opens in: the chat's own app, else the mail app in settings.
export function moveApp(reply, mailApp = 'outlook') {
  if (CHAT_APPS.has(reply?.app)) return reply.app;
  // A "gmail" saved before 2026-10-28 is Apple Mail, as draft.js mailAppOf reads it.
  const app = mailApp === 'gmail' ? 'apple-mail' : mailApp;
  return ['outlook', 'apple-mail'].includes(app) ? app : 'outlook';
}

// An email body as a person reads it: quoted-printable undone, MIME part lines dropped, and cut where the quoted
// history begins (the card shows what this message said, not the thread again).
export function cleanBody(text) {
  let body = String(text || '');
  if (/Content-Transfer-Encoding|=\r?\n|=[0-9A-F]{2}/.test(body)) {
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (match, hex) => CP1252[hex] ?? (Number.parseInt(hex, 16) < 128 ? String.fromCharCode(Number.parseInt(hex, 16)) : match));
  }
  const kept = [];
  for (const line of body.split('\n')) {
    if (/^\s*(On .+wrote:|From: .+|-----Original Message-----|_{10,})\s*$/.test(line) || /^\s*>/.test(line)) break;
    if (/^--_?[\w=.+-]{10,}/.test(line) || /^\s*Content-(Type|Transfer-Encoding)\s*:/i.test(line) || /^\s*charset=/i.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

// The last `limit` messages, oldest first, each marked as the user's or theirs.
export function saidFor(markdown, own = [], limit = 2) {
  const mine = new Set(own.map((address) => String(address).toLowerCase()));
  return threadMessages(markdown)
    .map((m) => ({ who: m.name === 'You' || (m.address && mine.has(m.address)) ? 'me' : 'them', name: m.name || m.address || '', at: m.at, text: excerpt(cleanBody(m.body), SAID_CHARS) }))
    .filter((m) => m.text)
    .slice(-limit);
}

// The call a move came from: its title and the first step listed for the user.
export function callNoteFor(markdown) {
  const lines = String(markdown || '').split('\n');
  const title = (lines.find((line) => /^# Call: /.test(line)) || '').replace(/^# Call: /, '').trim();
  if (!title) return null;
  const step = lines.find((line) => /^- /.test(line) && !/^- For your goal/i.test(line));
  // fileCall's header names the call folder ("Recording and transcript: <folder>"), so the move can open its call.
  const folder = (lines.find((line) => /^Recording and transcript: /.test(line)) || '').replace(/^Recording and transcript: /, '').trim().replace(/\/+$/, '').split('/').pop() || null;
  return { title, step: step ? step.replace(/^- /, '').trim() : null, folder: folder && /^[\w-]{1,120}$/.test(folder) ? folder : null };
}

// A move made from a call step Loggie was not sure of keeps the reason in BRIEF.md's "## Check" section (calls.js).
export function notSureOf(brief) {
  const lines = String(brief || '').split('\n');
  const at = lines.findIndex((line) => /^## Check\s*$/.test(line));
  if (at === -1) return null;
  const first = lines.slice(at + 1).find((line) => /^- /.test(line));
  return first ? first.replace(/^- (Not sure:\s*)?/i, '').trim() || 'Not sure' : null;
}

// The lines of a call's summary a move came from (a move made from a call step has no thread to quote): the summary
// lines that share the most words with the move's title, each with its section and time, best first. Code only.
// 2026-10-11: "Complete all P0 items before fall break" opened to "Nothing quoted", while the call summary said
// "P0 = production issue, fix by end of day even if overwork; target: 3 days, before fall break [10:46]".
const STOP = new Set(['the', 'and', 'for', 'with', 'all', 'any', 'into', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'before', 'after', 'about', 'items', 'item']);
const words = (text) => new Set(String(text || '').toLowerCase().replace(/\[\d{1,2}:\d{2}\]/g, '').match(/[a-z0-9&]+/g)?.filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)) || []);
export function callLinesFor(summary, title, limit = 2) {
  const want = words(title);
  if (!summary || !want.size) return [];
  let section = '';
  const scored = [];
  for (const row of String(summary).split('\n')) {
    const head = /^##\s+(.+?)(?:\s*\[\d{1,2}:\d{2}\])?\s*$/.exec(row);
    if (head) { section = head[1].trim(); continue; }
    if (!/^\s*-\s+\S/.test(row)) continue;
    const text = row.replace(/^\s*-\s+/, '').trim();
    const time = /\[(\d{1,2}:\d{2})\]/.exec(text)?.[1] || null;
    const have = words(text);
    const score = [...want].filter((w) => have.has(w)).length;
    if (score) scored.push({ score, section, text: excerpt(text.replace(/\s*\[\d{1,2}:\d{2}\]/g, ''), SAID_CHARS), time });
  }
  // Only the lines as close as the closest: a line sharing one word ("fall break") with a three-word match is noise.
  const best = Math.max(0, ...scored.map((item) => item.score));
  return scored.filter((item) => item.score === best).slice(0, limit).map(({ section: s, text, time }) => ({ section: s, text, time }));
}

export async function readDueDates(home) {
  const data = JSON.parse(await readFile(join(home, DUE_FILE), 'utf8').catch(() => '{}'));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

// The user's new date for a move ("YYYY-MM-DD"), or null to go back to the catch-up's date.
export async function setDueDate(home, taskId, date) {
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('A new date must look like 2026-10-14.');
  const dates = await readDueDates(home);
  if (date === null) delete dates[taskId];
  else dates[taskId] = date;
  await writeFile(join(home, DUE_FILE), `${JSON.stringify(dates, null, 2)}\n`);
  return { taskId, due: date };
}

// One move's card fields from its folder.
// `callSummary`: for a move made from a call step, { title, at, summary } of that call, so its lines can be shown.
export async function moveDetail(taskDirectory, { own = [], mailApp = 'outlook', title = '', callSummary = null, services = new Map() } = {}) {
  const read = (name) => readFile(join(taskDirectory, name), 'utf8').catch(() => '');
  const [reply, thread, call, brief, alsoText] = await Promise.all([read('REPLY.json'), read('THREAD.md'), read('CALL.md'), read('BRIEF.md'), read('ALSO.json')]);
  // Where else the same thing came up (workstreams.js sameThing, F5): "email: <subject>", "WhatsApp: <chat>".
  let also = [];
  try { also = alsoText ? JSON.parse(alsoText).filter((item) => typeof item === 'string').slice(0, 6) : []; } catch { also = []; }
  let parsed = null;
  try { parsed = reply ? JSON.parse(reply) : null; } catch { parsed = null; }
  const callNote = callNoteFor(call) || (callSummary ? { title: callSummary.title, at: callSummary.at || null, step: null, folder: callSummary.folder || null } : null);
  const lines = callSummary ? callLinesFor(callSummary.summary, title) : [];
  // An intro move (loggie-intros 1.5) has no reply target until Draft it: its row shows the introduced address.
  const to = typeof parsed?.to === 'string' ? parsed.to : parsed?.ask?.from === 'intro' && typeof parsed.ask.address === 'string' ? parsed.ask.address : null;
  return { app: moveApp(parsed, mailApp), to, sendable: macCanSend(parsed, services), said: saidFor(thread, own),
    call: callNote ? { ...callNote, folder: callNote.folder || callSummary?.folder || null, lines } : null, notSure: notSureOf(brief),
    askLine: askLineOf(parsed), from: emailFromOf(parsed, thread), also };
}

// The person whose email a move came from, for a To do move's Reply (today-model.js canReplyTo; Gio on a prepare move
// over a recruiter's scheduling email, 2026-10-21: "how come it doesnt allow me to reply though?"). Only an email the
// thread holds from the reply target: a chat, an ask-box line, an intro and a call step (no message from that address
// in THREAD.md) have none. machine: a no-reply or automated sender, by the router's rule (router.js MACHINE).
export function emailFromOf(reply, thread) {
  if (!reply || reply.ask || CHAT_APPS.has(reply.app) || typeof reply.to !== 'string' || !reply.to.includes('@')) return null;
  const address = reply.to.trim().toLowerCase();
  const message = [...threadMessages(thread)].reverse().find((m) => m.address === address);
  if (!message) return null;
  return { name: message.name && message.name.toLowerCase() !== address ? message.name : '', address, machine: MACHINE.test(address) };
}

// A move from a text asking the user to email someone (chat-email.js): what the text asked, for the card's line box to
// open with. The text holds the topic, rarely the request ("ask about $500 bar tab", "ask about setting that up"), so
// the user finishes it there before anything goes to the cloud AI (2026-10-17: with their words added, every draft was
// the right email; with the text's words alone, none was).
export function askLineOf(reply) {
  const ask = reply?.ask?.ask;
  return typeof ask === 'string' && ask.trim() ? ask.trim() : null;
}

// The call a move was made from, by its source id ("callstep:<call folder>:<step>"), with its newest summary.
export async function callSummaryFor(home, sourceId, newestSummary) {
  const folder = /^callstep:([^:]+):/.exec(String(sourceId || ''))?.[1] || /^call:([^#]+)#\d+$/.exec(String(sourceId || ''))?.[1];
  if (!folder || folder.includes('/') || folder.startsWith('.')) return null;
  const summary = await newestSummary(join(home, 'calls', folder)).catch(() => null);
  if (!summary) return null;
  const title = (String(summary).split('\n').find((row) => /^# /.test(row)) || '').replace(/^# /, '').trim() || folder;
  return { title, at: /^\d{4}-\d{2}-\d{2}/.exec(folder)?.[0] || null, summary, folder };
}
