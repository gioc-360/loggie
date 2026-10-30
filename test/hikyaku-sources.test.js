import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calendarItems, callItems, chatItems, checkChanges, gmailItems, outlookItems } from '../src/hikyaku/sources.js';
import { appendChanges, makeItem, readLooked, writeLooked } from '../src/hikyaku/changes.js';
import { workstreamQuery } from '../src/hikyaku/workstreams.js';

const home = () => mkdtemp(join(tmpdir(), 'loggie-sources-'));
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const NOW_ISO = '2026-10-10T12:00:00.000Z';
const WEEK_AGO = '2026-10-03T12:00:00.000Z';
const ME = 'me@cornell.example';
const WORKSTREAMS = [
  { name: 'Bank Offer', kind: 'company', goal: '', domains: ['bank.example'], words: [], cloud: false },
  { name: 'Loggie', kind: 'project', goal: '', domains: ['loggie.dev'], words: ['loggie'], cloud: false },
  { name: 'Inbox', kind: 'inbox', goal: '', domains: [], words: [], cloud: false, inbox: true },
];

// Gmail: each workstream's query finds the threads listed for it.
function fakeGmail({ hits = {}, threads = {}, failFind = [], failThread = [] } = {}) {
  const calls = { find: [], get: [] };
  return {
    calls,
    async findMessages(query, options) {
      calls.find.push({ query, options });
      const name = Object.keys(hits).find((key) => query.startsWith(workstreamQuery(WORKSTREAMS.find((w) => w.name === key))));
      if (failFind.includes(name)) throw new Error('quota exceeded');
      return (hits[name] || []).map((threadId, i) => ({ id: `${threadId}-m${i}`, threadId }));
    },
    async getThread(threadId) {
      calls.get.push(threadId);
      if (failThread.includes(threadId)) throw new Error('thread gone');
      return threads[threadId];
    },
  };
}
const gThread = (id, subject, from, to, cc = '') => ({ id, subject, latestTimestamp: '2026-10-09T15:00:00.000Z',
  messages: [{ id: `${id}-old`, from: 'old@else.example', to: ME, cc: '', timestamp: '2026-10-08T10:00:00.000Z' },
    { id: `${id}-new`, from, to, cc, timestamp: '2026-10-09T15:00:00.000Z' }] });

const outlookMail = [
  { id: 'apple-mail-1', conversation: 'c1', from: 'Ana Ruiz <Ana@Bank.example>', to: `${ME}, team@bank.example`, cc: 'boss@bank.example', subject: 'RE: Introductions', timestamp: '2026-10-09T15:00:00.000Z', body: 'SECRET-BODY-456', snippet: 'SECRET-BODY-456', source: 'outlook' },
  { id: 'apple-mail-0', conversation: 'c0', from: 'old@bank.example', to: ME, cc: '', subject: 'Old', timestamp: '2026-10-01T09:00:00.000Z', body: 'old', snippet: 'old', source: 'outlook' },
  { id: 'apple-mail-2', conversation: 'c2', from: 'promo@shop.example', to: ME, cc: '', subject: 'Sale today', timestamp: '2026-10-09T16:00:00.000Z', body: 'SECRET-BODY-456', snippet: '', source: 'outlook' },
];
const chatResult = (whatsapp = { status: 'ok', chats: [] }) => ({
  messages: { status: 'ok', chats: [
    { app: 'messages', id: 'chat-1', title: '', isGroup: false, participants: [{ handle: '+15550001', name: 'Sam' }],
      messages: [{ fromMe: false, from: '+15550001', timestamp: '2026-10-02T10:00:00.000Z', text: 'old' },
        { fromMe: true, from: 'me', timestamp: '2026-10-09T10:00:00.000Z', text: 'about loggie SECRET-BODY-123' },
        { fromMe: false, from: '+15550001', timestamp: '2026-10-09T11:00:00.000Z', text: 'sure' }] },
    { app: 'messages', id: 'chat-2', title: 'Old group', isGroup: true, participants: [{ handle: 'a', name: null }],
      messages: [{ fromMe: false, from: 'a', timestamp: '2026-10-01T10:00:00.000Z', text: 'loggie' }] },
  ] },
  whatsapp,
});
const calendarEvents = [
  { id: 'ev-1', title: 'Bank Offer call', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T15:00:00.000Z', writable: true, attendees: ['Ana@Bank.example'], attendeeNames: ['Ana Ruiz'] },
  { id: 'ev-1b', title: 'Bank Offer call', start: '2026-10-12T14:00:00.000Z', writable: true, attendees: [] },
  { id: 'holiday', title: 'Columbus Day', start: '2026-10-12T00:00:00.000Z', writable: false, attendees: [] },
  { id: 'ev-2', title: 'Dentist', start: '2026-10-13T09:00:00.000Z', writable: true },
  { id: 'ev-3', title: 'Invite from bank', start: '2026-10-14T09:00:00.000Z', writable: false, attendees: ['x@bank.example'] },
];
async function addCall(dir, folder, event) {
  await mkdir(join(dir, 'calls', folder), { recursive: true });
  await writeFile(join(dir, 'calls', folder, 'event.json'), typeof event === 'string' ? event : JSON.stringify(event));
}

test('gmail: one query per named workstream since its watermark, one item per thread, a thread two found is unsure', async () => {
  const gmail = fakeGmail({
    hits: { 'Bank Offer': ['t1', 't3', 't1'], Loggie: ['t2', 't3'] },
    threads: {
      t1: gThread('t1', 'Offer letter', 'Ana Ruiz <Ana@Bank.example>', `${ME}, Bo <bo@hr.bank.example>`, 'me@CORNELL.example'),
      t2: gThread('t2', 'Loggie demo', 'Jess <jess@gmail.example>', ME),
      t3: gThread('t3', 'Loggie for the bank', 'ana@bank.example', ME),
    },
  });
  const since = { Loggie: '2026-10-09T00:00:00.000Z' };
  const { items, looked, errors } = await gmailItems({ gmail, workstreams: WORKSTREAMS, since, ownAddresses: [ME.toUpperCase()], now: NOW });
  assert.deepEqual(errors, []);
  assert.deepEqual(gmail.calls.find.map((c) => c.query), [
    `${workstreamQuery(WORKSTREAMS[0])} after:${Date.parse(WEEK_AGO) / 1000}`,
    `${workstreamQuery(WORKSTREAMS[1])} after:${Date.parse(since.Loggie) / 1000}`,
  ]);
  assert.deepEqual(gmail.calls.find[0].options, { limit: 20 });
  assert.deepEqual(gmail.calls.get, ['t1', 't3', 't2'], 'each thread is fetched once');
  const [t1, t3, t2] = items;
  assert.deepEqual(t1, { source: 'gmail', at: '2026-10-09T15:00:00.000Z', title: 'Offer letter', ref: 't1-new', thread: 't1',
    who: [{ name: 'Ana Ruiz', address: 'ana@bank.example' }, { name: '', address: 'bo@hr.bank.example' }], workstream: 'Bank Offer', how: 'domain' });
  assert.equal(t2.workstream, 'Loggie'); assert.equal(t2.how, 'word');
  assert.equal(t3.workstream, null); assert.equal(t3.how, 'none'); assert.deepEqual(t3.candidates, ['Bank Offer', 'Loggie']);
  assert.deepEqual(looked, { 'Bank Offer': NOW_ISO, Loggie: NOW_ISO });
});

test('gmail: a failed search or thread keeps those workstreams out of looked and says which', async () => {
  const gmail = fakeGmail({ hits: { 'Bank Offer': ['t1'], Loggie: ['t2'] }, failFind: ['Loggie'], failThread: ['t1'], threads: {} });
  const { items, looked, errors } = await gmailItems({ gmail, workstreams: WORKSTREAMS, since: {}, ownAddresses: [ME], now: NOW });
  assert.deepEqual(items, []);
  assert.deepEqual(looked, {});
  assert.deepEqual(errors, [{ source: 'gmail', message: 'Loggie: quota exceeded' }, { source: 'gmail', message: 'thread t1: thread gone' }]);
});

test('gmail: prefers the headers-only fetch when the client has it, else the full thread', async () => {
  const threads = { t1: gThread('t1', 'Offer letter', 'Ana Ruiz <ana@bank.example>', ME) };
  const full = fakeGmail({ hits: { 'Bank Offer': ['t1'] }, threads });
  const headersOnly = { ...full, heads: [], async getThreadHeaders(threadId) { this.heads.push(threadId); return threads[threadId]; } };
  const viaHeaders = await gmailItems({ gmail: headersOnly, workstreams: WORKSTREAMS, since: {}, ownAddresses: [ME], now: NOW });
  assert.deepEqual(headersOnly.heads, ['t1']);
  assert.deepEqual(full.calls.get, [], 'getThread is not called when getThreadHeaders exists');
  const viaFull = await gmailItems({ gmail: fakeGmail({ hits: { 'Bank Offer': ['t1'] }, threads }), workstreams: WORKSTREAMS, since: {}, ownAddresses: [ME], now: NOW });
  assert.deepEqual(viaHeaders.items, viaFull.items);
  assert.equal(viaHeaders.items[0].title, 'Offer letter');
});

test('outlook: reads whole days since the watermark, keeps only newer mail, never the body', async () => {
  let asked;
  const readInbox = async (options) => { asked = options; return outlookMail; };
  const { items } = await outlookItems({ readInbox, address: ME, since: '2026-10-08T12:00:00.000Z', now: NOW });
  assert.deepEqual(asked, { address: ME, days: 3, bodies: false });
  assert.deepEqual(items.map((item) => item.ref), ['apple-mail-1', 'apple-mail-2']);
  assert.deepEqual(items[0], { source: 'outlook', at: '2026-10-09T15:00:00.000Z', title: 'RE: Introductions', ref: 'apple-mail-1', thread: 'introductions',
    who: [{ name: 'Ana Ruiz', address: 'ana@bank.example' }, { name: '', address: 'team@bank.example' }, { name: '', address: 'boss@bank.example' }], recipients: 2 });
  assert.ok(!JSON.stringify(items).includes('SECRET-BODY'));
});

test('chats: newer messages from anyone make one item per chat; an app not ok is an error', async () => {
  let asked;
  const readChats = async (options) => { asked = options; return chatResult({ status: 'denied', detail: 'Full Disk Access is off', chats: [] }); };
  const { items, errors, ok } = await chatItems({ readChats, since: '2026-10-08T12:00:00.000Z', now: NOW });
  // 2026-10-23 (Codex review): the read always covers the past week (8 days), not only since the last look (3).
  assert.deepEqual(asked, { days: 8, maxChats: 80, maxMessages: 40 });
  assert.equal(ok, false);
  assert.deepEqual(errors, [{ source: 'whatsapp', message: 'whatsapp: Full Disk Access is off' }]);
  assert.deepEqual(items, [{ source: 'messages', at: '2026-10-09T11:00:00.000Z', title: 'Sam', ref: 'chat-1@2026-10-09T11:00:00.000Z', thread: 'chat-1',
    who: [{ name: 'Sam', handle: '+15550001' }], text: 'about loggie SECRET-BODY-123 sure',
    // 2026-10-23: the past week's texts, for the cloud sort's newest words; 'old' (10-02) is past the week.
    lines: ['about loggie SECRET-BODY-123', 'sure'], linesAt: '2026-10-09T11:00:00.000Z' }]);
  const fine = await chatItems({ readChats: async () => chatResult(), since: '2026-10-08T12:00:00.000Z', now: NOW });
  assert.equal(fine.ok, true); assert.deepEqual(fine.errors, []);
});

test('calendar: keeps events with people or the user\'s own, drops twins, and changes are what the snapshot lacks', async () => {
  let asked;
  const listEvents = async (options) => { asked = options; return calendarEvents; };
  const first = await calendarItems({ listEvents, snapshot: undefined, now: NOW });
  assert.deepEqual(asked, { from: new Date(NOW - 86400000), days: 46 });
  const keys = ['ev-1@2026-10-12T14:00:00.000Z', 'ev-2@2026-10-13T09:00:00.000Z', 'ev-3@2026-10-14T09:00:00.000Z'];
  assert.deepEqual(first.items.map((item) => item.ref), keys);
  assert.deepEqual(first.items[0], { source: 'calendar', at: '2026-10-12T14:00:00.000Z', title: 'Bank Offer call', ref: keys[0], thread: 'ev-1', recipients: 1,
    who: [{ name: 'Ana Ruiz', address: 'ana@bank.example' }] });
  assert.deepEqual(first.snapshot, { at: NOW_ISO, events: { [keys[0]]: 'Bank Offer call', [keys[1]]: 'Dentist', [keys[2]]: 'Invite from bank' } });
  const snapshot = { at: WEEK_AGO, events: { [keys[0]]: 'Bank Offer call', [keys[1]]: 'Dentist (old title)', 'gone@2026-10-11T00:00:00.000Z': 'Deleted' } };
  const next = await calendarItems({ listEvents, snapshot, now: NOW });
  assert.deepEqual(next.items.map((item) => item.ref), [keys[1], keys[2]], 'a renamed and a new event change; an unchanged one and a deleted one do not');
  assert.ok(!('gone@2026-10-11T00:00:00.000Z' in next.snapshot.events));
});

test('calls: new or re-filed calls since the watermark, filed workstream first, folder time when no start', async () => {
  const dir = await home();
  assert.deepEqual(await callItems({ home: dir, since: WEEK_AGO }), { items: [], errors: [] }, 'no calls folder is no calls');
  await addCall(dir, '2026-10-09-1400-coffee-with-ana', { title: 'Coffee with Ana', start: '2026-10-09T18:00:00Z', workstream: 'Loggie', filed: { workstream: 'Bank Offer', at: '2026-10-09T19:00:00Z' }, emails: ['Ana@Bank.example', 'bo@bank.example'], names: 'Ana Ruiz, Bo Lee', attendees: 'Ana Ruiz' });
  await addCall(dir, '2026-10-08-0930-standup', { workstream: 'none' });
  await addCall(dir, '2026-09-01-1000-old-refiled', { start: '2026-09-01T14:00:00Z', workstream: 'none', filed: { workstream: 'Loggie', at: '2026-10-09T08:00:00Z' } });
  await addCall(dir, '2026-09-02-1000-old', { start: '2026-09-02T14:00:00Z', workstream: 'Loggie' });
  await addCall(dir, '2026-10-09-1500-broken', '{ not json');
  await mkdir(join(dir, 'calls', '2026-10-09-1600-no-event'));
  await mkdir(join(dir, 'calls', 'scratch'));
  const { items, errors } = await callItems({ home: dir, since: WEEK_AGO });
  assert.equal(errors.length, 1); assert.equal(errors[0].source, 'call'); assert.match(errors[0].message, /^2026-10-09-1500-broken: /);
  assert.deepEqual(items.map((item) => item.ref), ['2026-09-01-1000-old-refiled@Loggie', '2026-10-08-0930-standup@none', '2026-10-09-1400-coffee-with-ana@Bank Offer']);
  assert.deepEqual(items[2], { source: 'call', at: '2026-10-09T18:00:00.000Z', title: 'Coffee with Ana', ref: '2026-10-09-1400-coffee-with-ana@Bank Offer',
    thread: '2026-10-09-1400-coffee-with-ana', filed: 'Bank Offer', who: [{ name: 'Ana Ruiz', address: 'Ana@Bank.example' }, { name: 'Bo Lee', address: 'bo@bank.example' }] });
  assert.equal(items[1].at, new Date(2026, 9, 8, 9, 30).toISOString()); assert.equal(items[1].title, '2026-10-08-0930-standup'); assert.equal(items[1].filed, null);
});

// Every reader connected, first run: one routed item per source that has evidence, noise dropped.
async function everything(dir, overrides = {}, { calls = true } = {}) {
  if (calls) await addCall(dir, '2026-10-09-1400-coffee-with-ana', { title: 'Coffee with Ana', start: '2026-10-09T18:00:00Z', workstream: 'Bank Offer', emails: ['ana@bank.example'], names: 'Ana Ruiz' });
  if (calls) await addCall(dir, '2026-10-09-1700-nobody', { title: 'Random', start: '2026-10-09T21:00:00Z', workstream: 'none' });
  return {
    home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME.toUpperCase()], now: NOW,
    gmail: fakeGmail({ hits: { 'Bank Offer': ['t1'] }, threads: { t1: gThread('t1', 'Offer letter', 'Ana <ana@bank.example>', ME) } }),
    readInbox: async () => outlookMail,
    readChats: async () => chatResult(),
    listEvents: async () => calendarEvents,
    ...overrides,
  };
}

test('checkChanges: routes every source, appends in source order, drops items with no evidence, advances every watermark', async () => {
  const dir = await home();
  const { items, counts, errors, ms } = await checkChanges(await everything(dir));
  assert.deepEqual(errors, []);
  assert.equal(typeof ms, 'number');
  assert.deepEqual(items.map((item) => [item.id, item.workstream, item.how]), [
    ['gmail:t1-new', 'Bank Offer', 'domain'],
    ['outlook:apple-mail-1', 'Bank Offer', 'domain'],
    ['messages:chat-1@2026-10-09T11:00:00.000Z', 'Loggie', 'word'],
    ['calendar:ev-1@2026-10-12T14:00:00.000Z', 'Bank Offer', 'domain'],
    ['calendar:ev-3@2026-10-14T09:00:00.000Z', 'Bank Offer', 'domain'],
    ['call:2026-10-09-1400-coffee-with-ana@Bank Offer', 'Bank Offer', 'filed'],
  ]);
  assert.deepEqual(counts, {
    gmail: { seen: 1, routed: 1, unsure: 0, kept: 1, skipped: false },
    outlook: { seen: 2, routed: 1, unsure: 0, kept: 1, skipped: false },
    messages: { seen: 1, routed: 1, unsure: 0, kept: 1, skipped: false },
    whatsapp: { seen: 0, routed: 0, unsure: 0, kept: 0, skipped: false },
    calendar: { seen: 3, routed: 2, unsure: 0, kept: 2, skipped: false },
    call: { seen: 2, routed: 1, unsure: 0, kept: 1, skipped: false },
  });
  const looked = await readLooked(dir);
  assert.deepEqual(looked.gmail, { 'Bank Offer': NOW_ISO, Loggie: NOW_ISO });
  assert.equal(looked.outlook, NOW_ISO); assert.equal(looked.messages, NOW_ISO); assert.equal(looked.call, NOW_ISO);
  assert.equal(looked.calendar.at, NOW_ISO); assert.equal(Object.keys(looked.calendar.events).length, 3);
  const again = await checkChanges(await everything(dir));
  assert.deepEqual(again.items, [], 'a second look adds nothing twice');
});

test('checkChanges: appended lines pass makeItem and hold no message text', async () => {
  const dir = await home();
  await checkChanges(await everything(dir));
  const lines = (await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n');
  assert.ok(lines.length >= 6);
  for (const line of lines) {
    const stored = JSON.parse(line);
    assert.ok(!('text' in stored)); assert.ok(!('recipients' in stored)); assert.ok(!('filed' in stored));
    assert.deepEqual(makeItem(stored), stored);
  }
  const raw = lines.join('\n');
  assert.ok(!raw.includes('SECRET-BODY-123')); assert.ok(!raw.includes('SECRET-BODY-456'));
});

test('checkChanges: an unsure item keeps its candidates; a thread already in the log routes by thread', async () => {
  const dir = await home();
  await appendChanges(dir, [{ source: 'outlook', at: '2026-10-01T10:00:00Z', ref: 'apple-mail-old', title: 'Sale today', thread: 'sale today', who: [], workstream: 'Loggie', how: 'word' }]);
  const gmail = fakeGmail({ hits: { 'Bank Offer': ['t3'], Loggie: ['t3'] }, threads: { t3: gThread('t3', 'Loggie for the bank', 'ana@bank.example', ME) } });
  const { items, counts } = await checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], now: NOW, gmail, readInbox: async () => outlookMail });
  assert.deepEqual(items.map((item) => [item.id, item.workstream, item.how, item.candidates]), [
    ['gmail:t3-new', null, 'none', ['Bank Offer', 'Loggie']],
    ['outlook:apple-mail-1', 'Bank Offer', 'domain', []],
    ['outlook:apple-mail-2', 'Loggie', 'thread', []],
  ]);
  assert.equal(counts.gmail.unsure, 1);
});

test('checkChanges: a null reader is skipped without error, and outlook with no address is skipped', async () => {
  const dir = await home();
  const { items, counts, errors } = await checkChanges({ home: dir, workstreams: WORKSTREAMS, readInbox: async () => outlookMail, now: NOW });
  assert.deepEqual(errors, []); assert.deepEqual(items, []);
  for (const source of ['gmail', 'outlook', 'messages', 'whatsapp', 'calendar']) assert.equal(counts[source].skipped, true, source);
  assert.equal(counts.call.skipped, false);
  assert.deepEqual(Object.keys(await readLooked(dir)), ['call']);
});

test('checkChanges: an item that cannot be made is dropped with one error for its source', async () => {
  const dir = await home();
  const gmail = fakeGmail({ hits: { 'Bank Offer': ['t1', 'empty1', 'empty2'] }, threads: {
    t1: gThread('t1', 'Offer letter', 'ana@bank.example', ME),
    empty1: { id: 'empty1', subject: 'x', latestTimestamp: '2026-10-09T15:00:00Z', messages: [] },
    empty2: { id: 'empty2', subject: 'y', latestTimestamp: '2026-10-09T15:00:00Z', messages: [] } } });
  const { items, errors, counts } = await checkChanges({ home: dir, workstreams: WORKSTREAMS, ownAddresses: [ME], now: NOW, gmail });
  assert.deepEqual(items.map((item) => item.id), ['gmail:t1-new']);
  assert.deepEqual(errors, [{ source: 'gmail', message: '2 invalid items: A change item needs its source id.' }]);
  assert.equal(counts.gmail.seen, 3);
});

// One failure per source: its watermark stays, it says so, and the other sources still append.
const OLD = { gmail: { 'Bank Offer': WEEK_AGO, Loggie: WEEK_AGO }, outlook: WEEK_AGO, messages: WEEK_AGO, calendar: { at: WEEK_AGO, events: {} }, call: WEEK_AGO };
async function failing(overrides, setup = async () => {}, options = {}) {
  const dir = await home();
  for (const [source, value] of Object.entries(OLD)) await writeLooked(dir, source, value);
  const args = await everything(dir, overrides, options);
  await setup(dir);
  const result = await checkChanges(args);
  return { ...result, looked: await readLooked(dir), sources: new Set(result.items.map((item) => item.source)) };
}
const boom = async () => { throw new Error('reader down'); };

test('failure: gmail search throws for every workstream', async () => {
  const { looked, errors, sources } = await failing({ gmail: { findMessages: boom, getThread: boom } });
  assert.deepEqual(looked.gmail, OLD.gmail);
  assert.deepEqual(errors.map((e) => e.message), ['Bank Offer: reader down', 'Loggie: reader down']);
  assert.deepEqual([...sources], ['outlook', 'messages', 'calendar', 'call']);
  assert.equal(looked.outlook, NOW_ISO);
});

test('failure: outlook reader throws', async () => {
  const { looked, errors, sources } = await failing({ readInbox: boom });
  assert.equal(looked.outlook, WEEK_AGO);
  assert.deepEqual(errors, [{ source: 'outlook', message: 'reader down' }]);
  assert.deepEqual([...sources], ['gmail', 'messages', 'calendar', 'call']);
});

test('failure: chat reader throws, or one chat app errors, and the messages watermark stays', async () => {
  const whole = await failing({ readChats: boom });
  assert.equal(whole.looked.messages, WEEK_AGO);
  assert.deepEqual(whole.errors, [{ source: 'messages', message: 'reader down' }]);
  assert.deepEqual([...whole.sources], ['gmail', 'outlook', 'calendar', 'call']);
  const one = await failing({ readChats: async () => chatResult({ status: 'error', chats: [] }) });
  assert.equal(one.looked.messages, WEEK_AGO);
  assert.deepEqual(one.errors, [{ source: 'whatsapp', message: 'whatsapp: error' }]);
  assert.ok(one.sources.has('messages'), 'the app that read still appends');
});

test('failure: calendar reader throws', async () => {
  const { looked, errors, sources } = await failing({ listEvents: boom });
  assert.deepEqual(looked.calendar, OLD.calendar);
  assert.deepEqual(errors, [{ source: 'calendar', message: 'reader down' }]);
  assert.deepEqual([...sources], ['gmail', 'outlook', 'messages', 'call']);
});

test('failure: the calls folder cannot be read, or one call is malformed', async () => {
  const broken = await failing({}, (dir) => writeFile(join(dir, 'calls'), 'not a folder'), { calls: false });
  assert.equal(broken.looked.call, WEEK_AGO);
  assert.equal(broken.errors.length, 1); assert.equal(broken.errors[0].source, 'call'); assert.match(broken.errors[0].message, /ENOTDIR/);
  assert.deepEqual([...broken.sources], ['gmail', 'outlook', 'messages', 'calendar']);
  const malformed = await failing({}, (dir) => addCall(dir, '2026-10-09-1500-broken', '{ not json'));
  assert.equal(malformed.looked.call, WEEK_AGO);
  assert.deepEqual(malformed.errors.map((e) => e.source), ['call']); assert.match(malformed.errors[0].message, /^2026-10-09-1500-broken: /);
  assert.ok(malformed.sources.has('call'), 'the readable calls still append');
});
