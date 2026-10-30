// How one Gemini Flash sentence is graded (loggie-ask-wordmap), shared by test/ask-corpus.test.js and the report
// script. Each round in test/fixtures/ask-corpus/ is a
// file of sentences Flash wrote, each with the answer the code must reach (scripts/ask-corpus/prompt.md). The bar is
// every sentence of every round. Where Flash's own answer was wrong, corrections.json says what changed and why, and
// the round file stays exactly as Flash wrote it. Made-up people only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSentence } from '../../src/hikyaku/quick-invite.js';
import { createAsker } from '../../src/hikyaku/ask-run.js';

const HERE = new URL('../../test/fixtures/ask-corpus/', import.meta.url).pathname;
// Monday 2026-10-12, 9:00 local: "today" in the prompt Flash was given.
export const NOW = new Date(2026, 9, 12, 9, 0);
// The places the user has used before, as the app learns them from the calendar and past invites (places.js); the
// prompt gives Flash the same list.
export const PLACES = ['Maplewood', 'Birch Hall', 'Statler', 'Ashbury', 'Elm Hall', 'Collegetown Bagels'];
const NAMES = ['Lena Ortiz', 'Jamie Chen', 'Yuki Tanaka', 'Marisol Reyes', 'Tomas Berg', 'Ilona Varga', 'Sam Lee', 'Sam Patel'];
const email = (name) => `${name.toLowerCase().replace(' ', '.')}@example.com`;
// The invite reader's people: one address each, Ilona with two (work used more).
export const PEOPLE = [
  ...NAMES.map((name, i) => ({ name, address: email(name), count: 9 - i })),
  { name: 'Ilona Varga', address: 'ilona.varga@example.org', count: 1 },
];
// The ask box's who index: chats in Messages and WhatsApp, and every sender in Outlook.
const CHATS = { messages: ['Lena Ortiz', 'Jamie Chen', 'Marisol Reyes', 'Sam Lee', 'Sam Patel'], whatsapp: ['Lena Ortiz', 'Yuki Tanaka'] };
export const ENTRIES = [
  ...Object.entries(CHATS).flatMap(([app, names]) => names.map((name, i) => ({ name, kind: 'person', app, chatId: `${app}-${i}`, address: `+1555000${i}`, last: `2026-10-0${i + 1}T12:00:00Z` }))),
  ...NAMES.map((name, i) => ({ name, kind: 'person', app: 'outlook', email: email(name), last: `2026-10-0${i + 1}T09:00:00Z`, subject: 'Hello' })),
];

const norm = (text) => String(text ?? '').normalize('NFKD').toLowerCase().replace(/[“”"'‘’]/g, '').replace(/^(?:the|a|an)\s+/, '').replace(/[\s.,!?;:]+$/g, '').replace(/\s+/g, ' ').trim();
const hhmm = (d) => d && `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// The date a day answer means, by the reader's rule: a weekday is its next occurrence (today when the time is ahead).
function dateOf(day, time) {
  if (!day) return null;
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  if (day === 'today') return d;
  if (day === 'tomorrow') { d.setDate(d.getDate() + 1); return d; }
  const m = day.match(/^(\d{2})-(\d{2})$/);
  if (m) return new Date(2026, Number(m[1]) - 1, Number(m[2]));
  const want = DOW.indexOf(day.replace(/^next /, '').slice(0, 3));
  let ahead = (want - NOW.getDay() + 7) % 7;
  if (ahead === 0) {
    const [h, mi] = (time || '00:00').split(':').map(Number);
    if (day.startsWith('next') || !time || new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi) <= NOW) ahead = 7;
  }
  d.setDate(d.getDate() + ahead);
  return d;
}

const asker = createAsker({ home: '/nonexistent', loadIndex: async () => ENTRIES, openChat: async () => ({}) });

// What the code got wrong for one row, as lines ([] when right).
export async function grade(row) {
  const wrong = [];
  const want = (field, got, expected) => { if (got !== expected) wrong.push(`${field}: want ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`); };
  if (row.action === 'invite') {
    let plan;
    try { plan = readSentence(row.sentence, { people: PEOPLE, now: NOW, places: PLACES }); } catch (error) { return [`threw: ${error.message}`]; }
    want('who', [...new Set(plan.people.map((p) => p.name))].sort().join(', '), [...new Set(row.who)].sort().join(', '));
    want('app', plan.calendar, row.app === 'google' ? 'google' : 'outlook');
    want('time', plan.timeGiven ? hhmm(plan.start) : null, row.time ?? null);
    const day = dateOf(row.day, row.time);
    if (day) want('day', plan.day?.toDateString(), day.toDateString());
    if (row.minutes) want('minutes', plan.minutes, row.minutes);
    want('where', norm(plan.place || plan.room?.query || ''), norm(row.where || ''));
    if (row.about) want('about', norm(plan.title), norm(row.about));
    else if (!/ with /.test(plan.title)) wrong.push(`about: want none, got ${JSON.stringify(plan.title)}`);
    if (row.kind && !row.about && !/^meeting$/i.test(row.kind)) want('kind', norm(plan.title.split(' with ')[0]), norm({ 'catch-up': 'catch-up', '1:1': '1:1' }[row.kind] || row.kind));
    if (plan.leftOut.length) wrong.push(`left out: ${plan.leftOut.join(', ')}`);
    return wrong;
  }
  const got = await asker.preview(row.sentence);
  want('action', got.action, row.action === 'email' ? 'reply' : 'message');
  want('who', got.who.map((w) => w.name).sort().join(', '), [...row.who].sort().join(', '));
  const apps = [...new Set(got.who.map((w) => w.app))].join(',');
  want('app', apps, { text: 'messages', whatsapp: 'whatsapp', email: 'outlook' }[row.action]);
  if (row.message) {
    if (row.action === 'email') { if (!norm(got.words).includes(norm(row.message)) && norm(got.words) !== norm(row.message)) want('message', norm(got.words), norm(row.message)); }
    else want('message', norm(got.words), norm(row.message));
  }
  return wrong;
}

// Flash's answers with the corrections applied; a dropped row is gone, with its reason kept in corrections.json.
export function rounds() {
  const corrections = JSON.parse(readFileSync(join(HERE, 'corrections.json'), 'utf8'));
  return readdirSync(HERE).filter((f) => f.endsWith('.jsonl')).sort().map((file) => {
    const rows = readFileSync(join(HERE, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { round: file.replace(/\.jsonl$/, ''), rows: rows.filter((row) => !corrections[row.id]?.drop).map((row) => ({ ...row, ...(corrections[row.id]?.fix || {}) })) };
  });
}

