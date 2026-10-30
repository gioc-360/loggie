// The change check (docs/workstream-integration/proposal.md, AGENTS.md SPEC increment 3): read each connected source
// since Loggie last looked (looked.json), turn what is new into change items, route them, append them to
// changes.jsonl, then move each source's watermark. A source that fails keeps its old watermark, so the next check
// reads the same window again; the log is keyed by id, so a re-read adds nothing twice.
// Apple Mail, Messages and WhatsApp store things late (2026-10-19: Exchange mail received 20:09 to 23:10 UTC was
// stored in one batch after 23:10, and a 21:00 offer email was never filed), so those three are read by what the
// store added since the last look (its ROWID, looked.outlookRow and looked.messagesRow), not by date.
//
// Readers are passed in (gmail, readInbox, readChats, listEvents) so tests use fakes; nothing here opens an app,
// reads a body into the log, or calls a model. Message text is used only to route and is never stored.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendChanges, makeItem, readChanges, readLooked, writeLooked } from './changes.js';
import { learnPeople, learnThreads, route, threadMap } from './router.js';
import { baseSubject } from './sent-mail.js';
import { MAX_SUGGEST, sortable } from './suggest.js';
import { workstreamQuery } from './workstreams.js';

export const DAY_MS = 86400000;
export const FIRST_LOOK_MS = 7 * DAY_MS;
// The oldest a late-stored message can be and still be filed: a store that re-indexes old mail gives it new rows.
export const LATE_DAYS = 14;
// The first look after rows replaced dates re-reads three days: what a date cutoff passed over is filed then, once.
export const BACKFILL_MS = 3 * DAY_MS;
// The most unrouted items one refresh sends to the cloud `suggest` step.
export const SUGGEST_MAX = 30;
const ORDER = ['gmail', 'outlook', 'messages', 'whatsapp', 'calendar', 'call'];
const CALL_FOLDER = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/;

const low = (value) => String(value || '').toLowerCase();
const named = (workstreams) => workstreams.filter((w) => !w.inbox && !w.chats && !w.folder);
const daysSince = (since, now) => Math.ceil((now - Date.parse(since)) / DAY_MS) + 1;
const addressesIn = (value) => (String(value || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map(low);
const mailRow = (id) => Number(String(id).match(/^apple-mail-(\d+)$/)?.[1]) || 0;
const chatRow = (id) => (/^\d+$/.test(String(id)) ? Number(id) : 0);

// Where a refresh starts reading a store that keeps things late. With a cursor, after it (outlookItems, chatItems).
// Without one, by date: seven days on a first run, three when Loggie had looked before by date (the backfill).
const lateSince = (watermark, now) => new Date(now - (watermark ? BACKFILL_MS : FIRST_LOOK_MS)).toISOString();
export const outlookWindow = (looked, now) => ({ since: lateSince(looked.outlook, now), afterRow: Number.isInteger(looked.outlookRow) ? looked.outlookRow : null });
export const chatWindow = (looked, now) => ({ since: lateSince(looked.messages, now), afterRows: looked.messagesRow || {} });

// from (with its name, if written "Name <addr>"), then to, then cc; deduped, the user's own addresses dropped.
function people(message, own) {
  const fromName = (String(message?.from || '').match(/^\s*"?([^"<]*?)"?\s*</) || [])[1]?.trim() || '';
  const fromAddresses = addressesIn(message?.from);
  const seen = new Set();
  const who = [];
  for (const [address, name] of [...fromAddresses.map((a, i) => [a, i === 0 ? fromName : '']), ...addressesIn(message?.to).map((a) => [a, '']), ...addressesIn(message?.cc).map((a) => [a, ''])]) {
    if (own.has(address) || seen.has(address)) continue;
    seen.add(address);
    who.push({ name, address });
  }
  return who;
}

export async function gmailItems({ gmail, workstreams, since = {}, ownAddresses = [], now }) {
  const own = new Set(ownAddresses.map(low));
  const firstLook = new Date(now - FIRST_LOOK_MS).toISOString();
  const nowISO = new Date(now).toISOString();
  const errors = [];
  const found = new Map();   // threadId -> [workstream]
  const failed = new Set();  // workstream names kept out of looked
  for (const w of named(workstreams)) {
    const query = `${workstreamQuery(w)} after:${Math.floor(Date.parse(since[w.name] ?? firstLook) / 1000)}`;
    let hits;
    try { hits = await gmail.findMessages(query, { limit: 20 }); } catch (error) {
      errors.push({ source: 'gmail', message: `${w.name}: ${error.message}` });
      failed.add(w.name);
      continue;
    }
    for (const threadId of new Set((hits || []).map((hit) => hit.threadId))) found.set(threadId, [...(found.get(threadId) || []), w]);
  }
  const items = [];
  for (const [threadId, finders] of found) {
    let thread;
    try { thread = await (gmail.getThreadHeaders ? gmail.getThreadHeaders(threadId) : gmail.getThread(threadId)); } catch (error) {
      errors.push({ source: 'gmail', message: `thread ${threadId}: ${error.message}` });
      for (const w of finders) failed.add(w.name);
      continue;
    }
    const newest = (thread.messages || []).at(-1);
    const who = people(newest, own);
    const base = { source: 'gmail', at: thread.latestTimestamp, title: thread.subject, ref: newest?.id, thread: thread.id, who };
    if (finders.length > 1) { items.push({ ...base, workstream: null, how: 'none', candidates: finders.map((w) => w.name) }); continue; }
    const [w] = finders;
    const domains = (w.domains || []).map(low).filter(Boolean);
    const domainHit = who.some(({ address }) => domains.some((d) => address.endsWith(`@${d}`) || address.endsWith(`.${d}`)));
    items.push({ ...base, workstream: w.name, how: domainHit ? 'domain' : 'word' });
  }
  const looked = Object.fromEntries(named(workstreams).filter((w) => !failed.has(w.name)).map((w) => [w.name, nowISO]));
  return { items, looked, errors };
}

// ownAddresses defaults to the one Outlook address; checkChanges passes all of the user's addresses so a Gmail
// address cc'd on Outlook mail is not counted as a correspondent.
// With `afterRow` (the newest Apple Mail ROWID the last look read), a message is new when Mail stored it after that
// row, whatever its date, back to LATE_DAYS; without it, when its date is after `since`. A message whose id is in
// `logged` (changes.jsonl) is skipped. -> { items, row: the newest ROWID read, else afterRow, else null }.
export async function outlookItems({ readInbox, address, since, afterRow = null, logged = new Set(), now, ownAddresses = address ? [address].flat() : [] }) {
  const own = new Set(ownAddresses.map(low));
  const byRow = Number.isInteger(afterRow);
  const cutoff = byRow ? now - LATE_DAYS * DAY_MS : Date.parse(since);
  const mail = (await readInbox(byRow ? { address, days: LATE_DAYS, bodies: false, afterRow } : { address, days: daysSince(since, now), bodies: false })) || [];
  const newest = Math.max(byRow ? afterRow : 0, ...mail.map((message) => mailRow(message.id)));
  const fresh = (message) => (byRow ? mailRow(message.id) > afterRow && Date.parse(message.timestamp) >= cutoff : Date.parse(message.timestamp) > cutoff);
  const items = mail.filter((message) => fresh(message) && !logged.has(`outlook:${message.id}`)).map((message) => ({
    source: 'outlook', at: message.timestamp, title: message.subject, ref: message.id, thread: baseSubject(message.subject || ''),
    who: people(message, own),
    recipients: new Set([...addressesIn(message.to), ...addressesIn(message.cc)].filter((a) => !own.has(a))).size,
  }));
  return { items, row: newest > 0 ? newest : null };
}

// Per app, the same rule as outlookItems: with its cursor in `afterRows` (the newest chat.db or WhatsApp row the last
// look read, the message's `id`), a message is new when the app stored it after that row, back to LATE_DAYS; without
// one, when its date is after `since`. -> { items, errors, ok, rows: { <app>: newest row read } for each app that read,
// chats: every chat with a message in the past week, as { source, title, thread, who, lines, at: its newest } }.
// `lines` (items and chats) are the texts of the past week and the new ones, oldest first: what the cloud sort reads
// (suggest.js newestWords), never stored. The router still reads only `text`, the new messages. A chat in `pending`
// (looked.chatPending: one a sort owes an answer) is read back LATE_DAYS, not a week, so a late row is not lost.
export async function chatItems({ readChats, since, afterRows = {}, logged = new Set(), now, pending = {} }) {
  const cutoff = Date.parse(since);
  const oldest = now - LATE_DAYS * DAY_MS;
  const byRow = Object.values(afterRows).some(Number.isInteger);
  // 40 messages, not 5: a burst of texts hides its point in the first one (2026-10-11: "an interview with a bank
  // recruiter next Friday" was message 1 of 25, and the last 5 alone named no workstream).
  // At least the past week, whatever the cursor: the sort's newest words and the re-sort read a week (Codex review,
  // 2026-10-23: a date cursor alone read 4 days, so a chat from 5 days ago was never re-sorted).
  const weekAgo = now - FIRST_LOOK_MS;
  const owed = Object.keys(pending).length > 0;
  const result = await readChats({ days: Math.max(byRow || owed ? LATE_DAYS : 0, daysSince(since, now), daysSince(new Date(weekAgo).toISOString(), now)), maxChats: 80, maxMessages: 40 });
  const items = [];
  const errors = [];
  const rows = {};
  const chats = [];
  let ok = true;
  for (const [app, answer] of Object.entries(result || {})) {
    if (answer?.status !== 'ok') {
      errors.push({ source: app, message: `${app}: ${answer?.detail || answer?.status}` });
      ok = false;
      continue;
    }
    const after = Number.isInteger(afterRows[app]) ? afterRows[app] : null;
    const fresh = (m) => (after !== null ? chatRow(m.id) > after && Date.parse(m.timestamp) >= oldest : Date.parse(m.timestamp) > cutoff);
    let newestRow = after ?? 0;
    for (const chat of answer.chats || []) {
      for (const m of chat.messages || []) newestRow = Math.max(newestRow, chatRow(m.id));
      const participants = chat.participants || [];
      const source = chat.app || app;
      const title = chat.title?.trim() || participants.map((p) => p.name || p.handle).join(', ');
      const who = participants.map((p) => ({ name: p.name || '', handle: p.handle }));
      const back = Object.hasOwn(pending, `${source}:${chat.id}`) ? oldest - 1 : weekAgo;
      const week = (chat.messages || []).filter((m) => fresh(m) || Date.parse(m.timestamp) > back);
      const lines = week.map((m) => m.text);
      // The newest time among `lines`: the newest message is always in what the sort reads, so this is what it saw.
      const linesAt = week.length ? new Date(Math.max(...week.map((m) => Date.parse(m.timestamp)))).toISOString() : null;
      if (week.length) chats.push({ source, title, thread: chat.id, who, lines, at: linesAt });
      const newer = (chat.messages || []).filter(fresh);
      if (!newer.length) continue;
      const newest = Math.max(...newer.map((m) => Date.parse(m.timestamp)));
      const ref = `${chat.id}@${new Date(newest).toISOString()}`;
      if (logged.has(`${source}:${ref}`)) continue;
      items.push({
        source, at: new Date(newest).toISOString(), title, ref, thread: chat.id, who,
        text: newer.map((m) => m.text).join(' '), lines, linesAt,
      });
    }
    if (newestRow > 0) rows[app] = newestRow;
  }
  return { items, errors, ok, rows, chats };
}

// The calendar has no "since": each check compares the window with the last snapshot of it. An event whose start
// cannot be parsed has no key and is left out (it could not make a valid item either).
export async function calendarItems({ listEvents, snapshot, now }) {
  const events = await listEvents({ from: new Date(now - DAY_MS), days: 46 });
  const before = snapshot?.events || {};
  const kept = new Map();
  const twins = new Set();
  for (const event of events || []) {
    if (event.writable === false && !(Array.isArray(event.attendees) && event.attendees.length)) continue;
    if (Number.isNaN(Date.parse(event.start))) continue;
    const start = new Date(event.start).toISOString();
    if (twins.has(`${event.title}\u0000${start}`)) continue;
    twins.add(`${event.title}\u0000${start}`);
    kept.set(`${event.id}@${start}`, event);
  }
  const items = [];
  for (const [key, event] of kept) {
    if (snapshot && Object.hasOwn(before, key) && before[key] === event.title) continue;
    const attendees = event.attendees || [];
    items.push({
      source: 'calendar', at: event.start, title: event.title, ref: key, thread: event.id, recipients: attendees.length,
      who: attendees.map((a, i) => ({ name: event.attendeeNames?.[i] || '', address: low(a) })),
    });
  }
  return { items, snapshot: { at: new Date(now).toISOString(), events: Object.fromEntries([...kept].map(([key, event]) => [key, event.title])) } };
}

export async function callItems({ home, since }) {
  const cutoff = Date.parse(since);
  const entries = await readdir(join(home, 'calls')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const items = [];
  const errors = [];
  for (const folder of entries.sort()) {
    const parts = folder.match(CALL_FOLDER);
    if (!parts) continue;
    let event;
    try {
      const raw = await readFile(join(home, 'calls', folder, 'event.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (raw === null) continue;
      event = JSON.parse(raw);
    } catch (error) {
      errors.push({ source: 'call', message: `${folder}: ${error.message}` });
      continue;
    }
    const [, y, m, d, hh, mm] = parts.map(Number);
    const at = Number.isNaN(Date.parse(event.start)) ? new Date(y, m - 1, d, hh, mm).getTime() : Date.parse(event.start);
    const filedAt = Date.parse(event.filed?.at);
    if (!(at > cutoff || filedAt > cutoff)) continue;
    const filedTo = event.filed?.workstream || (event.workstream && event.workstream !== 'none' ? event.workstream : null);
    const names = (event.names || '').split(', ');
    items.push({
      source: 'call', at: new Date(at).toISOString(), title: event.title || folder, ref: `${folder}@${filedTo || 'none'}`,
      thread: folder, filed: filedTo, who: (event.emails || []).map((a, i) => ({ name: names[i] || '', address: a })),
    });
  }
  return { items, errors };
}

const blank = () => ({ seen: 0, routed: 0, unsure: 0, kept: 0, skipped: false });

export async function checkChanges({ home, workstreams, ownAddresses = [], gmail = null, readInbox = null, readChats = null, listEvents = null, suggest = null, now = Date.now() }) {
  const started = Date.now();
  const nowISO = new Date(now).toISOString();
  const firstLook = new Date(now - FIRST_LOOK_MS).toISOString();
  const own = ownAddresses.map(low);
  const looked = await readLooked(home);
  const learned = await learnPeople({ home, workstreams, ownAddresses: own });
  const changes = await readChanges(home);
  const logged = new Set(changes.map((item) => item.id));
  const threads = threadMap(changes, await learnThreads({ home, workstreams, ownAddresses: own }));

  const counts = Object.fromEntries(ORDER.map((source) => [source, blank()]));
  const errors = [];
  const address = own[0];
  const runs = {
    gmail: gmail && gmailItems({ gmail, workstreams, since: looked.gmail || {}, ownAddresses: own, now }),
    // Every account in Apple Mail, not only the first (spec W10b).
    outlook: readInbox && address && outlookItems({ readInbox, address: own, ownAddresses: own, ...outlookWindow(looked, now), logged, now }),
    messages: readChats && chatItems({ readChats, ...chatWindow(looked, now), logged, now, pending: looked.chatPending || {} }),
    calendar: listEvents && calendarItems({ listEvents, snapshot: looked.calendar, now }),
    call: callItems({ home, since: looked.call || firstLook }),
  };
  if (!gmail) counts.gmail.skipped = true;
  if (!readInbox || !address) counts.outlook.skipped = true;
  if (!readChats) counts.messages.skipped = counts.whatsapp.skipped = true;
  if (!listEvents) counts.calendar.skipped = true;

  const names = Object.keys(runs);
  const settled = await Promise.allSettled(names.map((name) => runs[name] || null));
  const done = {};
  names.forEach((name, i) => {
    if (!runs[name]) return;
    if (settled[i].status === 'rejected') errors.push({ source: name, message: settled[i].reason?.message || String(settled[i].reason) });
    else { done[name] = settled[i].value; errors.push(...(settled[i].value.errors || [])); }
  });

  const buckets = Object.fromEntries(ORDER.map((source) => [source, []]));
  const nowhere = [];
  const invalid = new Map();
  for (const [name, result] of Object.entries(done)) {
    for (const raw of result.items) {
      const source = ORDER.includes(raw.source) ? raw.source : name;
      counts[source].seen += 1;
      let item;
      const routed = raw.source === 'gmail' ? raw : { ...raw, ...route(raw, { workstreams, learned, threads }) };
      try { item = makeItem(routed); } catch (error) {
        invalid.set(source, { n: (invalid.get(source)?.n || 0) + 1, first: invalid.get(source)?.first || error.message });
        continue;
      }
      if (item.workstream) counts[source].routed += 1;
      else if (item.candidates.length) counts[source].unsure += 1;
      else { nowhere.push(routed); continue; }
      buckets[source].push(item);
    }
  }
  // What the router placed nowhere goes to `suggest` (suggest.js): a home it names comes back unsure, with that one
  // candidate and the words that show it, for the user's one tap. Nothing is filed on its word.
  // At most SUGGEST_MAX per run, newest first (the late-mail backfill once had 187); the rest stay unsorted, unqueued.
  // A chat the sort answered is remembered in looked.chatSorted ("<source>:<chat id>" -> { at: the newest message in
  // the words it read, home: its answer or null }): a message dated at or before `at` is not sent again, a newer one
  // is, with the chat's newest words. 2026-10-23: a null answer was written nowhere, so a chat answered null on a cut
  // window was never asked again.
  const sorted = { ...(looked.chatSorted || {}) };
  const pending = looked.chatPending || {};
  const chatKey = (item) => `${item.source}:${item.thread}`;
  const isChat = (item) => item.source === 'messages' || item.source === 'whatsapp';
  const sortedAlready = (item) => isChat(item) && sorted[chatKey(item)] && Date.parse(item.at) <= Date.parse(sorted[chatKey(item)].at);
  const batches = [];
  const asked = [...nowhere].filter((item) => !sortedAlready(item)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, SUGGEST_MAX);
  if (suggest && asked.length) batches.push({ items: asked, resort: false });
  // Once after this upgrade (looked.chatResorted): every chat with words in the past week that no workspace ever had
  // (no routed or unsure line in the log, no remembered home) and that brought nothing new this run is sorted once
  // more on its newest words, MAX_SUGGEST a call. This is what files Renée's 10-21 interview-prep ask.
  const resorting = Boolean(suggest && !looked.chatResorted && done.messages?.ok);
  const resort = [];
  if (resorting) {
    const homed = new Set([...changes.filter((item) => item.workstream || (item.candidates || []).length).map(chatKey),
      ...Object.entries(sorted).filter(([, memo]) => memo.home).map(([key]) => key)]);
    const fresh = new Set(done.messages.items.map(chatKey));
    for (const chat of done.messages.chats || []) {
      // The week is the migration's reach; a chat a sort still owes an answer is retried as far back as LATE_DAYS.
      const reach = Object.hasOwn(pending, chatKey(chat)) ? LATE_DAYS * DAY_MS : FIRST_LOOK_MS;
      if (Date.parse(chat.at) <= now - reach || homed.has(chatKey(chat)) || fresh.has(chatKey(chat)) || sortedAlready(chat)) continue;
      const raw = { ...chat, ref: `${chat.thread}@${chat.at}`, text: chat.lines.join(' ') };
      const routed = { ...raw, ...route(raw, { workstreams, learned, threads }) };
      // One the router can place now waits for its next words, which the router files as usual.
      if (!routed.workstream && !routed.candidates.length) resort.push(routed);
    }
    for (let i = 0; i < resort.length; i += MAX_SUGGEST) batches.push({ items: resort.slice(i, i + MAX_SUGGEST), resort: true });
  }
  // Every chat this run should have had sorted: the new ones placed nowhere and the re-sort's. One the sort did not
  // answer (a failed call, no yes or no budget, a broken reply, past the caps) keeps the re-sort pending, so the next
  // run sorts it from its newest words instead of dropping it once the cursor moves (Codex review, 2026-10-23).
  // Its key is kept in looked.chatPending until it is answered: a late row dated 10 days back, whose sort failed,
  // was past the cursor and outside the week the next run, so it was never sorted and the re-sort was marked done
  // (Codex review, round 2, 2026-10-23).
  const answeredKeys = new Set();
  const due = new Map([...nowhere.filter((item) => isChat(item) && !sortedAlready(item)), ...resort].filter(sortable).map((item) => [chatKey(item), item]));
  for (const batch of batches) {
    const result = await suggest(batch.items).catch((error) => ({ placed: [], errors: [{ source: 'messages', message: `suggesting a workstream: ${error.message}` }] }));
    errors.push(...(result.errors || []));
    const homes = new Map();
    for (const raw of result.placed || []) {
      homes.set(`${raw.source}:${raw.ref}`, raw.candidates[0]);
      let item;
      try { item = makeItem(raw); } catch { continue; }
      counts[item.source].unsure += 1;
      counts[item.source].suggested = (counts[item.source].suggested || 0) + 1;
      buckets[item.source].push(item);
    }
    for (const item of (result.answered || []).filter(isChat)) {
      sorted[chatKey(item)] = { at: new Date(item.linesAt || item.at).toISOString(), home: homes.get(`${item.source}:${item.ref}`) || null };
      due.delete(chatKey(item));
      answeredKeys.add(chatKey(item));
    }
  }
  for (const [source, { n, first }] of invalid) errors.push({ source, message: `${n} invalid items: ${first}` });

  const items = await appendChanges(home, ORDER.flatMap((source) => buckets[source]));
  for (const item of items) counts[item.source].kept += 1;

  if (done.gmail && Object.keys(done.gmail.looked).length) await writeLooked(home, 'gmail', { ...(looked.gmail || {}), ...done.gmail.looked });
  if (done.outlook) await writeLooked(home, 'outlook', nowISO);
  if (done.outlook && done.outlook.row !== null) await writeLooked(home, 'outlookRow', done.outlook.row);
  if (done.messages?.ok) await writeLooked(home, 'messages', nowISO);
  if (done.messages && Object.keys(done.messages.rows).length) await writeLooked(home, 'messagesRow', { ...(looked.messagesRow || {}), ...done.messages.rows });
  if (done.calendar) await writeLooked(home, 'calendar', done.calendar.snapshot);
  if (done.call && !done.call.errors.length) await writeLooked(home, 'call', nowISO);
  // Answers older than the farthest a late-stored chat is read back (LATE_DAYS) can never gate a resend; they go.
  const remembered = Object.fromEntries(Object.entries(sorted).filter(([, memo]) => Date.parse(memo.at) >= now - LATE_DAYS * DAY_MS));
  if (JSON.stringify(remembered) !== JSON.stringify(looked.chatSorted || {})) await writeLooked(home, 'chatSorted', remembered);
  // A full scan (the re-sort ran on a good read) saw every owed chat it could read; otherwise the old debts carry.
  const owed = { ...(resorting ? {} : pending), ...Object.fromEntries([...due].map(([key, item]) => [key, item.at])) };
  const stillOwed = Object.fromEntries(Object.entries(owed).filter(([key, at]) => !answeredKeys.has(key) && Date.parse(at) >= now - LATE_DAYS * DAY_MS));
  if (JSON.stringify(stillOwed) !== JSON.stringify(pending)) await writeLooked(home, 'chatPending', stillOwed);
  if (due.size && looked.chatResorted) await writeLooked(home, 'chatResorted', null);
  else if (!due.size && resorting) await writeLooked(home, 'chatResorted', nowISO);

  return { items, counts, errors, ms: Date.now() - started };
}
