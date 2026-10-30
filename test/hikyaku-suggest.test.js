import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SUGGEST, newestWords, parseSuggestions, suggestHomes, suggestPrompt, unplaced } from '../src/hikyaku/suggest.js';
import { checkChanges } from '../src/hikyaku/sources.js';
import { appendChanges, readChanges, readLooked, writeLooked } from '../src/hikyaku/changes.js';
import { answerAsk, asksFor } from '../src/hikyaku/screen-data.js';
import { screenText } from '../src/hikyaku/cloud-screen.js';

const W = [
  { name: 'Bank Offer', kind: 'company', goal: 'Get the Bank Offer associate role through the Oct 16 HR interview', domains: ['bank.example'], words: ['Bank Offer'] },
  { name: 'Hotel Hackathon', kind: 'competition', goal: 'Place at the hotel hackathon', domains: [], words: ['Hackathon'] },
  { name: 'Chats', chats: true, domains: [], words: [] },
  { name: 'Inbox', inbox: true, domains: [], words: [] },
];
const jonah = { source: 'messages', at: '2026-10-08T23:18:45Z', title: 'Jonah', ref: '7@2026-10-08T23:18:45Z', thread: '7', who: [{ name: 'Jonah', handle: '+13235550141' }],
  text: "Your interview is Friday? Okay, yeah let's set up Monday. Hit me up Sunday evening so we can solidify time", workstream: null, how: 'none', candidates: [] };
const mom = { source: 'messages', at: '2026-10-09T02:00:00Z', title: 'Mom', ref: '9@x', thread: '9', who: [{ name: 'Mom', handle: '+16075550199' }], text: 'Can you call me', workstream: null, how: 'none', candidates: [] };
const promo = { source: 'outlook', at: '2026-10-09T02:00:00Z', title: 'Sale ends tonight', ref: 'p1', thread: 'p1', who: [{ name: 'Shop', address: 'no-reply@shop.example' }], text: '50% off', workstream: null, how: 'none', candidates: [] };
const peer = { source: 'outlook', at: '2026-10-09T03:00:00Z', title: 'Hackathon team?', ref: 'e1', thread: 'e1', who: [{ name: 'Ivy', address: 'ivy@school.example' }], text: 'Want to team up for the hotel challenge?', workstream: null, how: 'none', candidates: [] };

test('unplaced: only person-written items with no workstream and no candidate, newest first, capped', () => {
  const routed = { ...peer, ref: 'r', workstream: 'Hotel Hackathon', how: 'word' };
  const unsure = { ...peer, ref: 'u', candidates: ['Hotel Hackathon'] };
  const crowd = { ...mom, ref: 'g', who: Array.from({ length: 13 }, (_, i) => ({ handle: `+1607555${String(i).padStart(4, '0')}` })) };
  assert.deepEqual(unplaced([jonah, mom, promo, peer, routed, unsure, crowd]).map((i) => i.ref), ['e1', '9@x', '7@2026-10-08T23:18:45Z']);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...mom, ref: `m${i}`, at: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}T00:00:00Z` }));
  assert.equal(unplaced(many).length, MAX_SUGGEST);
});

test('suggestPrompt: names every real workstream with its goal and where it stands; never Chats or Inbox', () => {
  const prompt = suggestPrompt({ workstreams: W, items: [jonah, peer], summaries: { 'Bank Offer': 'HR interview on Oct 16.' }, today: '2026-10-11' });
  assert.match(prompt, /1\. "Bank Offer": goal "Get the Bank Offer associate role through the Oct 16 HR interview"\. Where it stands: HR interview on Oct 16\./);
  assert.match(prompt, /2\. "Hotel Hackathon"/);
  assert.doesNotMatch(prompt, /"Chats"|"Inbox"/);
  assert.match(prompt, /\[1\] Text message from Jonah, 2026-10-08: Your interview is Friday\?/);
  assert.match(prompt, /\[2\] Email from Ivy, 2026-10-09: Hackathon team\?\. Want to team up/);
  // 2026-10-23 (Renée): "friends are null" sent a friend's interview-prep help to null; null now means nothing in the
  // newest words touches a workstream.
  assert.match(prompt, /a friend helping with a workstream's goal, like prep for its interview, belongs there/);
  assert.match(prompt, /Answer null only when nothing in the newest words is about a workstream's goal, people, company or event/);
  assert.doesNotMatch(prompt, /Family, friends, social plans/);
  assert.match(prompt, /Return only JSON: \{"homes": \[\{"message": 1, "workstream": "<exact workstream name or null>"/);
});

test('newestWords: whole messages from the newest back; the newest is always whole and the oldest drop first', () => {
  const lines = ['OLDEST cake and Venmo jokes '.repeat(50), 'middle line about the weekend', 'do you have time friday? i was wondering if u could help me prep for my interview on tuesday'];
  const kept = newestWords(lines, 140);
  assert.equal(kept, `${lines[1]} ${lines[2]}`);
  assert.doesNotMatch(kept, /OLDEST/);
  const long = 'x'.repeat(2000);
  assert.equal(newestWords(['short', long], 1200), long, 'a newest message longer than the window stays whole');
  assert.equal(newestWords([]), '');
  // The prompt reads the newest words of a chat, and the quote check reads the same words.
  const chat = { ...jonah, text: 'only the new row', lines };
  const prompt = suggestPrompt({ workstreams: W, items: [chat], today: '2026-10-23' });
  assert.match(prompt, /prep for my interview on tuesday/);
  assert.doesNotMatch(prompt, /OLDEST/);
  const found = parseSuggestions(JSON.stringify({ homes: [{ message: 1, workstream: 'Bank Offer', quote: 'help me prep for my interview on tuesday' }] }), [chat], W);
  assert.equal(found.get(0)?.workstream, 'Bank Offer');
});

test('parseSuggestions: keeps a real workstream with a quote found in the message; drops invented words, names and numbers', () => {
  const items = [jonah, mom, peer];
  const raw = JSON.stringify({ homes: [
    { message: 1, workstream: 'Bank Offer', quote: '“Your interview is Friday?”' },
    { message: 2, workstream: 'Bank Offer', quote: 'Bank Offer recruiter' },
    { message: 3, workstream: 'Hotel Team', quote: 'team up for the hotel challenge' },
    { message: 4, workstream: 'Bank Offer', quote: 'x' },
    { message: 1, workstream: 'Hotel Hackathon', quote: 'Hit me up' },
  ] });
  const found = parseSuggestions(raw, items, W);
  assert.deepEqual([...found.entries()], [[0, { workstream: 'Bank Offer', quote: 'Your interview is Friday?' }]]);
  assert.equal(parseSuggestions('not json', items, W).size, 0);
  assert.equal(parseSuggestions('```json\n{"homes":[{"message":3,"workstream":"Hotel Hackathon","quote":"team up for the hotel challenge"}]}\n```', items, W).get(2).workstream, 'Hotel Hackathon');
  assert.equal(parseSuggestions(JSON.stringify({ homes: [{ message: 1, workstream: 'Chats', quote: 'Hit me up' }] }), items, W).size, 0);
});

test('suggestHomes: chats and mail go under their own yes; a missing yes or a failed call places nothing', async () => {
  const calls = [];
  const thinkFor = (kind) => (kind === 'mail' ? null : async (prompt) => { calls.push(prompt); return JSON.stringify({ homes: [{ message: 2, workstream: 'Bank Offer', quote: 'Hit me up Sunday evening' }, { message: 1, workstream: null, quote: null }] }); });
  const result = await suggestHomes({ items: [jonah, mom, peer], workstreams: W, thinkFor, today: '2026-10-11' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /Ivy/);
  assert.equal(result.asked, 3);
  assert.deepEqual(result.answered.map((i) => i.ref).sort(), [jonah.ref, mom.ref].sort(), 'answered: the chats the reply answered, not the mail with no yes');
  assert.deepEqual(result.placed.map((i) => [i.ref, i.candidates, i.quote, i.workstream]), [['7@2026-10-08T23:18:45Z', ['Bank Offer'], 'Hit me up Sunday evening', null]]);
  const failed = await suggestHomes({ items: [jonah], workstreams: W, thinkFor: () => async () => { throw new Error('timed out'); } });
  assert.deepEqual(failed.placed, []);
  assert.deepEqual(failed.answered, []);
  assert.match(failed.errors[0].message, /suggesting a workstream: timed out/);
});

test('checkChanges: a chat the router cannot place comes back as one ask with its quote; without suggest it is dropped as before', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify(W));
  const readChats = async () => ({ messages: { status: 'ok', chats: [{ app: 'messages', id: '7', title: 'Jonah', participants: [{ handle: '+13235550141', name: 'Jonah' }],
    messages: [{ id: '1', fromMe: false, from: '+13235550141', timestamp: '2026-10-08T23:18:45Z', text: "Your interview is Friday? Hit me up Sunday evening so we can solidify time" }] }] } });
  const now = Date.parse('2026-10-11T12:00:00Z');
  const plain = await checkChanges({ home, workstreams: W, readChats, now });
  assert.equal(plain.counts.messages.seen, 1);
  assert.equal(plain.items.length, 0);

  const home2 = await mkdtemp(join(tmpdir(), 'suggest-'));
  const suggest = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => async () => JSON.stringify({ homes: [{ message: 1, workstream: 'Bank Offer', quote: 'Your interview is Friday?' }] }) });
  const check = await checkChanges({ home: home2, workstreams: W, readChats, suggest, now });
  assert.equal(check.counts.messages.unsure, 1);
  assert.equal(check.counts.messages.suggested, 1);
  const stored = await readChanges(home2);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].candidates, ['Bank Offer']);
  assert.equal(stored[0].quote, 'Your interview is Friday?');
  assert.deepEqual(asksFor(stored, new Set(), 'Bank Offer').map((a) => [a.title, a.quote]), [['Jonah', 'Your interview is Friday?']]);
});

// 2026-10-23 (Renée): a chat the sort answered null was never written anywhere and never asked again.
const row = (id, at, text) => ({ id: String(id), fromMe: false, from: '+15550123', timestamp: at, text });
const oneChat = (id, title, messages) => ({ app: 'messages', id, title, isGroup: false, participants: [{ handle: `+1555000${id.charCodeAt(0)}`, name: title }], messages });
const fakeChats = (chats) => async () => ({ messages: { status: 'ok', chats: chats() } });
// The fake cloud: every prompt is kept; a chat line holding "prep for my interview" gets Bank Offer, the rest null.
function cloud() {
  const prompts = [];
  const complete = async (prompt) => {
    prompts.push(prompt);
    const lines = prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
    return JSON.stringify({ homes: lines.map((line, i) => (/prep for my interview/.test(line)
      ? { message: i + 1, workstream: 'Bank Offer', quote: 'help me prep for my interview' } : { message: i + 1, workstream: null, quote: null })) });
  };
  return { prompts, suggest: (items) => suggestHomes({ items, workstreams: W, thinkFor: () => complete, today: '2026-10-23' }) };
}

test('checkChanges: a null answer is remembered and not resent without new words; new words resend the newest words', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-memo-'));
  const { prompts, suggest } = cloud();
  const messages = [row(1, '2026-10-20T10:00:00.000Z', 'cake later? and the venmo')];
  const readChats = fakeChats(() => [oneChat('7', 'Lee', messages)]);
  await checkChanges({ home, workstreams: W, readChats, suggest, now: Date.parse('2026-10-20T12:00:00Z') });
  assert.equal(prompts.length, 1);
  assert.deepEqual((await readLooked(home)).chatSorted, { 'messages:7': { at: '2026-10-20T10:00:00.000Z', home: null } });
  assert.deepEqual(await readChanges(home), [], 'a null answer files nothing');

  // The same words read again (a watermark that did not move): nothing goes to the cloud.
  const { chatSorted, chatResorted } = await readLooked(home);
  await writeFile(join(home, 'looked.json'), JSON.stringify({ chatSorted, chatResorted }));
  const again = await checkChanges({ home, workstreams: W, readChats, suggest, now: Date.parse('2026-10-20T13:00:00Z') });
  assert.equal(again.counts.messages.seen, 1);
  assert.equal(prompts.length, 1, 'not resent without new words');

  // New words: sent again, with the chat's newest words (the older line too), and this time it has a home.
  messages.push(row(2, '2026-10-21T15:29:00.000Z', 'i was wondering if u could help me prep for my interview on tuesday'));
  const later = await checkChanges({ home, workstreams: W, readChats, suggest, now: Date.parse('2026-10-21T16:00:00Z') });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /\[1\] Text message from Lee, 2026-10-21: cake later\? and the venmo i was wondering if u could help me prep for my interview on tuesday/);
  assert.deepEqual(later.items.map((item) => [item.id, item.candidates, item.quote]), [['messages:7@2026-10-21T15:29:00.000Z', ['Bank Offer'], 'help me prep for my interview']]);
  assert.deepEqual((await readLooked(home)).chatSorted['messages:7'], { at: '2026-10-21T15:29:00.000Z', home: 'Bank Offer' });
});

test('checkChanges: once after upgrade, the past week\'s chats no workspace ever had are sorted once more; a yes files them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-resort-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify(W));
  const now = Date.parse('2026-10-23T16:00:00Z');
  // An install from before this change: its cursor is past every chat below except the one new row (101).
  await writeLooked(home, 'messages', '2026-10-23T15:00:00.000Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  await appendChanges(home, [
    { source: 'messages', at: '2026-10-21T09:00:00Z', ref: 'a@1', thread: 'a', title: 'Ana', who: [], workstream: 'Hotel Hackathon', how: 'word' },
    { source: 'messages', at: '2026-10-21T09:00:00Z', ref: 'b@1', thread: 'b', title: 'Bo', who: [], workstream: null, how: 'none', candidates: ['Bank Offer'] },
  ]);
  const chats = [
    oneChat('a', 'Ana', [row(50, '2026-10-22T09:00:00.000Z', 'see you at prep for my interview practice')]),
    oneChat('b', 'Bo', [row(51, '2026-10-22T09:00:00.000Z', 'help me prep for my interview too')]),
    oneChat('l', 'Renée', [row(52, '2026-10-21T15:00:00.000Z', 'OLD cake joke '.repeat(100)), row(53, '2026-10-21T15:29:00.000Z', 'do you have time friday? i was wondering if u could help me prep for my interview on tuesday')]),
    oneChat('d', 'Dee', [row(54, '2026-10-12T09:00:00.000Z', 'help me prep for my interview, ten days ago')]),
    oneChat('n', 'Nia', [row(101, '2026-10-23T15:30:00.000Z', 'brunch sunday?')]),
  ];
  const { prompts, suggest } = cloud();
  const check = await checkChanges({ home, workstreams: W, readChats: fakeChats(() => chats), suggest, now });
  assert.equal(prompts.length, 2, 'the run\'s new chat, then one re-sort call');
  assert.match(prompts[0], /from Nia/);
  assert.doesNotMatch(prompts[0], /Renée/);
  const resorted = prompts[1].split('\n').filter((line) => /^\[\d+\] /.test(line));
  assert.deepEqual(resorted.map((line) => line.match(/from (\S+),/)[1]), ['Renée'], 'only the past week, never a chat a workspace had');
  assert.match(resorted[0], /: do you have time friday\? i was wondering if u could help me prep for my interview on tuesday$/, 'the newest words, the old jokes cut');
  assert.deepEqual(check.items.map((item) => [item.id, item.candidates]), [['messages:l@2026-10-21T15:29:00.000Z', ['Bank Offer']]]);
  const looked = await readLooked(home);
  assert.equal(looked.chatResorted, '2026-10-23T16:00:00.000Z');
  assert.deepEqual(looked.chatSorted, { 'messages:n': { at: '2026-10-23T15:30:00.000Z', home: null }, 'messages:l': { at: '2026-10-21T15:29:00.000Z', home: 'Bank Offer' } });

  // It runs once: the next refresh with nothing new sends nothing.
  await checkChanges({ home, workstreams: W, readChats: fakeChats(() => chats), suggest, now: now + 600000 });
  assert.equal(prompts.length, 2);

  // The same path as any suggested home: one ask on Bank Offer with its words; a yes saves Renée and files her chat.
  const log = await readChanges(home);
  const [ask] = asksFor(log, new Set(), 'Bank Offer');
  assert.deepEqual([ask.title, ask.quote], ['Renée', 'help me prep for my interview']);
  const answer = await answerAsk({ home, item: log.find((item) => item.id === ask.id), workstream: 'Bank Offer' });
  assert.deepEqual(answer, { saved: 1, logged: 1 });
  chats[2].messages.push(row(102, '2026-10-23T17:00:00.000Z', 'sunday works'));
  const next = await checkChanges({ home, workstreams: JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8')), readChats: fakeChats(() => chats), suggest, now: now + 3600000 });
  assert.deepEqual(next.items.map((item) => [item.id, item.workstream]), [['messages:l@2026-10-23T17:00:00.000Z', 'Bank Offer']]);
});

test('checkChanges: the re-sort waits when the cloud call fails or chats have no yes, and runs on a later refresh', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-resort-wait-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  const readChats = fakeChats(() => [oneChat('l', 'Renée', [row(53, '2026-10-21T15:29:00.000Z', 'help me prep for my interview on tuesday')])]);
  const noYes = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => null });
  await checkChanges({ home, workstreams: W, readChats, suggest: noYes, now });
  assert.equal((await readLooked(home)).chatResorted, undefined);
  const down = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => async () => { throw new Error('timed out'); } });
  const failed = await checkChanges({ home, workstreams: W, readChats, suggest: down, now });
  assert.match(failed.errors[0].message, /timed out/);
  assert.equal((await readLooked(home)).chatResorted, undefined);
  const { prompts, suggest } = cloud();
  const ran = await checkChanges({ home, workstreams: W, readChats, suggest, now });
  assert.equal(prompts.length, 1);
  assert.equal(ran.items.length, 1);
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:00:00.000Z');
});

// Codex review of the two commits above (2026-10-23), one test per finding.
const linesOf = (prompt) => prompt.split('\n').filter((line) => /^\[\d+\] /.test(line));
const whoIn = (prompts) => prompts.flatMap(linesOf).map((line) => line.match(/from (\S+),/)[1]);

test('review 1: a new chat whose sort call failed reopens the re-sort and is sorted on the next run, not dropped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-review1-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  await writeLooked(home, 'chatResorted', '2026-10-22T16:00:00.000Z');
  const readChats = fakeChats(() => [oneChat('n', 'Nia', [row(101, '2026-10-23T15:30:00.000Z', 'can you help me prep for my interview friday')])]);
  const down = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => async () => { throw new Error('timed out'); } });
  await checkChanges({ home, workstreams: W, readChats, suggest: down, now });
  assert.equal((await readLooked(home)).chatResorted, null, 'the cursor moved past Nia, so the re-sort is pending again');
  const { prompts, suggest } = cloud();
  const next = await checkChanges({ home, workstreams: W, readChats, suggest, now: now + 600000 });
  assert.deepEqual(whoIn(prompts), ['Nia']);
  assert.deepEqual(next.items.map((item) => item.candidates), [['Bank Offer']]);
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:10:00.000Z');
});

test('review 1: past the 20 a call reads, the other new chats are sorted on the next run, and only then is the re-sort done', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-review1b-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  const chats = Array.from({ length: 25 }, (_, i) => oneChat(`c${i}`, `P${i}`, [row(101 + i, new Date(now - (i + 1) * 60000).toISOString(), `hello ${i}`)]));
  const { prompts, suggest } = cloud();
  await checkChanges({ home, workstreams: W, readChats: fakeChats(() => chats), suggest, now });
  assert.equal(linesOf(prompts[0]).length, 20);
  assert.equal((await readLooked(home)).chatResorted, undefined, 'five new chats were not read');
  await checkChanges({ home, workstreams: W, readChats: fakeChats(() => chats), suggest, now: now + 600000 });
  assert.deepEqual(whoIn(prompts.slice(1)).sort(), ['P20', 'P21', 'P22', 'P23', 'P24']);
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:10:00.000Z');
});

test('review 2: a reply that is not JSON, or leaves a message out, remembers nothing for it and keeps the re-sort pending', async () => {
  const reply = (raw) => (items) => suggestHomes({ items, workstreams: W, thinkFor: () => async () => raw });
  const broken = await suggestHomes({ items: [jonah, mom], workstreams: W, thinkFor: () => async () => 'not json' });
  assert.deepEqual(broken.answered, []);
  const home = await mkdtemp(join(tmpdir(), 'suggest-review2-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  const readChats = fakeChats(() => [oneChat('a', 'Ana', [row(50, '2026-10-22T10:00:00.000Z', 'cake?')]), oneChat('b', 'Bo', [row(51, '2026-10-22T09:00:00.000Z', 'venmo')])]);
  await checkChanges({ home, workstreams: W, readChats, suggest: reply('not json'), now });
  assert.equal((await readLooked(home)).chatSorted, undefined);
  assert.equal((await readLooked(home)).chatResorted, undefined);
  // Message 1 (Ana, the newer) answered null, message 2 left out: only Ana is remembered.
  await checkChanges({ home, workstreams: W, readChats, suggest: reply(JSON.stringify({ homes: [{ message: 1, workstream: null, quote: null }] })), now });
  assert.deepEqual(Object.keys((await readLooked(home)).chatSorted), ['messages:a']);
  assert.equal((await readLooked(home)).chatResorted, undefined);
  const { prompts, suggest } = cloud();
  await checkChanges({ home, workstreams: W, readChats, suggest, now });
  assert.deepEqual(whoIn(prompts), ['Bo']);
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:00:00.000Z');
});

test('review 3: with only a date watermark the re-sort still reads the whole past week', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-review3-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messages', '2026-10-23T15:00:00.000Z');
  const all = [oneChat('f', 'Fay', [row(40, '2026-10-18T12:00:00.000Z', 'help me prep for my interview next week')])];
  // A reader that, like the real one, returns only the days it is asked for.
  const readChats = async ({ days }) => ({ messages: { status: 'ok', chats: all.map((chat) => ({ ...chat, messages: chat.messages.filter((m) => Date.parse(m.timestamp) > now - days * 86400000) })).filter((chat) => chat.messages.length) } });
  const { prompts, suggest } = cloud();
  await checkChanges({ home, workstreams: W, readChats, suggest, now });
  assert.deepEqual(whoIn(prompts), ['Fay'], 'a chat from 5 days ago is re-sorted');
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:00:00.000Z');
});

test('review 4: the remembered time is the newest message the sort read, so an older late row does not resend', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-review4-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 10 });
  await writeLooked(home, 'chatResorted', '2026-10-22T16:00:00.000Z');
  // Row 10 (15:50) was read before; row 11, dated 14:00, is stored late beside it.
  const messages = [row(11, '2026-10-23T14:00:00.000Z', 'late one'), row(10, '2026-10-23T15:50:00.000Z', 'newest words')];
  const readChats = fakeChats(() => [oneChat('k', 'Kai', messages)]);
  const { prompts, suggest } = cloud();
  await checkChanges({ home, workstreams: W, readChats, suggest, now });
  assert.equal(prompts.length, 1);
  assert.match(linesOf(prompts[0])[0], /late one newest words$/);
  assert.deepEqual((await readLooked(home)).chatSorted, { 'messages:k': { at: '2026-10-23T15:50:00.000Z', home: null } });
  messages.splice(1, 0, row(12, '2026-10-23T15:00:00.000Z', 'later row, dated before what was read'));
  await checkChanges({ home, workstreams: W, readChats, suggest, now: now + 600000 });
  assert.equal(prompts.length, 1, 'a row dated before 15:50 is not sent again');
});

// Codex review, round 2 (2026-10-23), one test per finding.
test('codex r2 1: a quote copied from the screened words the cloud read is kept, once; a quote from the unshown chat title is not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-r2-1-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  const readChats = fakeChats(() => [oneChat('z', 'Zoe', [row(101, '2026-10-23T15:00:00.000Z', 'help me prep for my interview; email ada@example.com')])]);
  // The cloud, as thinkWith sends it: the screened prompt. Its quote is copied from what it read.
  const sent = [];
  const complete = async (prompt) => {
    const screened = screenText(prompt).text;
    sent.push(screened);
    return JSON.stringify({ homes: [{ message: 1, workstream: 'Bank Offer', quote: linesOf(screened)[0].split(': ').slice(1).join(': ') }] });
  };
  const suggest = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => complete, today: '2026-10-23' });
  for (let i = 0; i < 3; i += 1) await checkChanges({ home, workstreams: W, readChats, suggest, now: now + i * 600000 });
  assert.match(sent[0], /\[address kept on this Mac\]/);
  assert.equal(sent.length, 1, 'answered once, not resent on each refresh');
  assert.equal((await readLooked(home)).chatSorted['messages:z'].home, 'Bank Offer');
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:00:00.000Z');
  const titled = { ...mom, title: 'Bank interview practice', text: 'cake?', lines: ['cake?'] };
  assert.equal(parseSuggestions(JSON.stringify({ homes: [{ message: 1, workstream: 'Bank Offer', quote: 'Bank interview practice' }] }), [titled], W).size, 0, 'a chat title is not in what the cloud read');
});

test('codex r2 2: a late-stored chat older than the week whose sort failed is retried within 14 days, and the re-sort is not marked done', async () => {
  const home = await mkdtemp(join(tmpdir(), 'suggest-r2-2-'));
  const now = Date.parse('2026-10-23T16:00:00Z');
  await writeLooked(home, 'messagesRow', { messages: 100 });
  await writeLooked(home, 'chatResorted', '2026-10-22T16:00:00.000Z');
  const readChats = fakeChats(() => [oneChat('o', 'Oli', [row(101, '2026-10-13T12:00:00.000Z', 'can you help me prep for my interview')])]);
  const down = (items) => suggestHomes({ items, workstreams: W, thinkFor: () => async () => { throw new Error('timed out'); } });
  await checkChanges({ home, workstreams: W, readChats, suggest: down, now });
  assert.equal((await readLooked(home)).chatResorted, null);
  const { prompts, suggest } = cloud();
  const next = await checkChanges({ home, workstreams: W, readChats, suggest, now: now + 600000 });
  assert.deepEqual(whoIn(prompts), ['Oli'], 'the failed chat is sorted again');
  assert.deepEqual(next.items.map((item) => item.candidates), [['Bank Offer']]);
  assert.equal((await readLooked(home)).chatResorted, '2026-10-23T16:10:00.000Z');
  await checkChanges({ home, workstreams: W, readChats, suggest, now: now + 1200000 });
  assert.equal(prompts.length, 1, 'and only once');
});
