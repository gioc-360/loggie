import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFound, discover, knownSender, mergeFound, uncovered } from '../src/hikyaku/discover.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';

// The incident of 2026-10-06 with made-up people: a course-assistant hire came as three emails, none matching a card.
const ME = 'ana@school.example.com';
const mail = (id, from, subject, body, timestamp) => ({ id, subject, latestTimestamp: timestamp, messages: [{ id: `${id}m`, from, to: ME, subject, timestamp, body }] });
const TRAINING = mail('t1', 'Ops <ops1@school.example.com>', 'CA Canvas Training', "You have been asked to CA for Professor Kato & Lund's MGMT 5090 course. Before hiring, you are required to complete training.", '2026-10-05T20:28:00Z');
const WORKDAY = mail('t2', 'school@myworkday.com', 'A Task Awaits You: Student Appointment Letter - Start Additional Job: Ana Lee', 'Business Process: Review Documents for Start Additional Job: Ana Lee', '2026-10-06T13:31:00Z');
const LETTER = mail('t3', 'Payroll <payroll@school.example.com>', 'Timecard procedures', 'You have been hired to work with Ken Kato as a Course Assistant effective 2026-10-07. Your Start Additional Job is in Workday.', '2026-10-06T13:31:40Z');
const NEWS = mail('t4', 'news@school.example.com', 'This week on campus', 'Concerts, talks and a food truck.', '2026-10-06T09:00:00Z');
const BANK = mail('t5', 'Lena <lena@acmebank.com>', 'Coffee chat', 'Friday works.', '2026-10-06T10:00:00Z');
const WORKSTREAMS = [{ name: 'Acme Bank', kind: 'company', domains: ['acmebank.com'], words: [] }, { name: 'Inbox', inbox: true, domains: [], words: [] }];
const POOL = [TRAINING, WORKDAY, LETTER, NEWS];

test('only mail no named card covers is read; the Inbox card is not a name', () => {
  assert.deepEqual(uncovered([...POOL, BANK], WORKSTREAMS).map((t) => t.id), ['t1', 't2', 't3', 't4']);
});

test('a proposal stands only where the mail backs it: the quote, each term, no generic or own-name terms', () => {
  const raw = { found: [
    { name: 'MGMT 5090 course assistant', kind: 'class', threads: [1, 2, 3], terms: ['MGMT 5090', 'Kato', 'Start Additional Job', 'Workday', 'Ana Lee', 'Lund'], quote: 'You have been hired to work with Ken Kato as a Course Assistant effective 2026-10-07.' },
    { name: 'Campus events', kind: 'other', threads: [4], terms: ['food truck'], quote: 'Come to the big gala on Friday.' },
    { name: 'Made up', kind: 'other', threads: [9], terms: ['x'], quote: 'nothing here at all' },
  ] };
  const [ca, ...rest] = checkFound(raw, POOL, POOL, { ownNames: ['Ana Lee', 'ana'] });
  assert.equal(rest.length, 0, 'an invented quote or thread number drops the proposal');
  assert.deepEqual(ca.terms, ['MGMT 5090', 'Kato', 'Start Additional Job', 'Lund'], 'Workday is generic; the user\'s own name is never a term');
  const notToYou = { found: [{ name: 'Class review', kind: 'class', threads: [4], terms: ['Concerts', 'Oct 6'], quote: 'Concerts, talks and a food truck.' }] };
  assert.deepEqual(checkFound(notToYou, POOL, POOL), [], 'a quote that does not speak to the user is not a new role');
  const dated = { found: [{ name: 'Class', kind: 'class', threads: [3], terms: ['Oct 6', '2026-10-07'], quote: 'You have been hired to work with Ken Kato as a Course Assistant effective 2026-10-07.' }] };
  assert.deepEqual(checkFound(dated, POOL, POOL), [], 'dates are never search terms');
  assert.deepEqual(ca.threads.map((t) => t.id), ['t1', 't2', 't3'], 'each thread kept carries a term, so the card finds it again');
  assert.equal(ca.evidence.subject, 'Timecard procedures');
});

test('a card comes only from someone the user deals with: their own school, or a domain they have written to', () => {
  assert.equal(knownSender('Ops <ops1@school.example.com>', ME), true);
  assert.equal(knownSender('payroll@hr.school.example.com', ME), true, 'a subdomain of the user\'s own');
  assert.equal(knownSender('Recruiting <jobs@careers.example.org>', ME), false, 'a stranger\'s job ad never makes a card');
  assert.equal(knownSender('Lena <lena@acmebank.com>', ME, ['acmebank.com']), true);
  const ad = mail('t9', 'Recruiting <jobs@careers.example.org>', 'Roles for you', 'You have been selected for our talent community.', '2026-10-06T11:00:00Z');
  const raw = { found: [{ name: 'Studio jobs', kind: 'company', threads: [1], terms: ['talent community'], quote: 'You have been selected for our talent community.' }] };
  assert.deepEqual(checkFound(raw, [ad], [ad], { ownAddress: ME, knownDomains: [] }), []);
  assert.equal(checkFound(raw, [ad], [ad], { ownAddress: ME, knownDomains: ['example.org'] }).length, 1);
});

test('two proposals sharing a term become one card', () => {
  const a = { name: 'MGMT 5090 CA', terms: ['MGMT 5090'], threads: [TRAINING] };
  const b = { name: 'Course assistant job', terms: ['Kato', 'mgmt 5090'], threads: [LETTER] };
  const [one, ...none] = mergeFound([a, b]);
  assert.equal(none.length, 0);
  assert.deepEqual([one.name, one.terms, one.threads.length], ['MGMT 5090 CA', ['MGMT 5090', 'Kato'], 2]);
});

test('the whole step adds the card with its evidence, never proposes it twice, and re-reads only changed threads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: ['acmebank.com'], words: [] }]));
  const prompts = [];
  const complete = async (prompt) => { prompts.push(prompt); if (prompt.startsWith('<sentence>')) return '{"new": true}'; return JSON.stringify({ found: [{ name: 'MGMT 5090 course assistant', kind: 'class', threads: [2, 3, 4], terms: ['MGMT 5090', 'Kato'], quote: 'You have been asked to CA for Professor Kato & Lund\'s MGMT 5090 course.' }] }); };
  const threads = [NEWS, LETTER, WORKDAY, TRAINING, BANK];
  const workstreams = await readWorkstreams(home);
  const dry = await discover({ threads, workstreams, complete, home, ownAddress: ME, dryRun: true });
  assert.deepEqual(dry.added.map((a) => a.name), ['MGMT 5090 course assistant']);
  assert.equal((await readWorkstreams(home)).length, 1, 'a dry run writes nothing');
  assert.match(prompts[0], /current workstreams: "Acme Bank"/);
  assert.doesNotMatch(prompts[0], /Coffee chat/, 'mail a card covers never goes to the model');

  const log = await discover({ threads, workstreams, complete, home, ownAddress: ME, now: () => new Date('2026-10-06T14:00:00Z') });
  assert.equal(log.added.length, 1);
  const card = (await readWorkstreams(home)).at(-1);
  assert.deepEqual([card.name, card.kind, card.words, card.goal], ['MGMT 5090 course assistant', 'class', ['MGMT 5090', 'Kato'], null], 'the goal is left for the user to pick');
  assert.equal(card.found.subject, 'CA Canvas Training');
  assert.equal(card.found.at, '2026-10-06T14:00:00.000Z');

  // Next hour: nothing changed, so nothing is read again. Then the user deletes the card: it is not proposed again.
  const calls = prompts.length;
  assert.equal((await discover({ threads, workstreams: await readWorkstreams(home), complete, home, ownAddress: ME })).batches, 0);
  assert.equal(prompts.length, calls);
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: ['acmebank.com'], words: [] }]));
  const changed = [{ ...LETTER, latestTimestamp: '2026-10-07T09:00:00Z' }, WORKDAY, TRAINING];
  const letterOnly = async (prompt) => prompt.startsWith('<sentence>') ? '{"new": true}' : JSON.stringify({ found: [{ name: 'Course assistant job', kind: 'other', threads: [1], terms: ['Kato'], quote: 'You have been hired to work with Ken Kato as a Course Assistant effective 2026-10-07.' }] });
  const again = await discover({ threads: changed, workstreams: await readWorkstreams(home), complete: letterOnly, home, ownAddress: ME });
  assert.deepEqual([again.batches, again.added.length, again.skipped[0]?.why], [1, 0, 'proposed before']);
  assert.ok(JSON.parse(await readFile(join(home, 'discovered.json'), 'utf8'))[0].threads.includes('t1'));
});

test('the quote alone must convince the model again, or the card is not made', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  const complete = async (prompt) => prompt.startsWith('<sentence>') ? '{"new": false}'
    : JSON.stringify({ found: [{ name: 'MGMT 5090 CA', kind: 'class', threads: [1], terms: ['MGMT 5090'], quote: "You have been asked to CA for Professor Kato & Lund's MGMT 5090 course." }] });
  const log = await discover({ threads: [TRAINING], workstreams: [], complete, home, ownAddress: ME, dryRun: true });
  assert.deepEqual([log.proposed, log.added.length, log.skipped[0].why], [1, 0, 'the quote alone does not say it is new']);
});

test('the card is named from the quote alone, not the subject line', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  const complete = async (prompt) => /Words that identify it/.test(prompt) ? '{"name": "Course Assistant MGMT 5090"}' : prompt.startsWith('<sentence>') ? '{"new": true}'
    : JSON.stringify({ found: [{ name: 'CA Canvas Training', kind: 'class', threads: [1], terms: ['MGMT 5090'], quote: "You have been asked to CA for Professor Kato & Lund's MGMT 5090 course." }] });
  const log = await discover({ threads: [TRAINING], workstreams: [], complete, home, ownAddress: ME, dryRun: true });
  assert.deepEqual(log.added.map((item) => item.name), ['Course Assistant MGMT 5090']);
});

test('a reply the model cannot be read from fails loud, and nothing is marked as read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  await assert.rejects(discover({ threads: POOL, workstreams: [], complete: async () => 'no json', home }), /could not read the new mail/);
  await assert.rejects(readFile(join(home, 'discover-looked.json'), 'utf8'));
});

test('one batch the model answers in a broken shape is skipped and kept unread; the rest of the run goes on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  let calls = 0;
  const complete = async (prompt) => {
    if (/Words that identify it/.test(prompt)) return '{"name": "Course Assistant MGMT 5090"}';
    if (prompt.startsWith('<sentence>')) return '{"new": true}';
    calls += 1;
    // The first batch: "terms" without its brackets, as Super wrote on 2026-10-17.
    if (calls === 1) return '{"found": [{"name": "x", "terms": "a", "b"}]}';
    return JSON.stringify({ found: [{ name: 'CA Canvas Training', kind: 'class', threads: [1], terms: ['MGMT 5090'], quote: "You have been asked to CA for Professor Kato & Lund's MGMT 5090 course." }] });
  };
  const threads = [...POOL, TRAINING];
  const log = await discover({ threads, workstreams: [], complete, home, ownAddress: ME, batchSize: POOL.length, dryRun: true });
  assert.equal(log.unreadBatches, 1);
  assert.deepEqual(log.added.map((item) => item.name), ['Course Assistant MGMT 5090'], 'the next batch still finds its workstream');
});

// A first run (Gio, 2026-10-17): the threads the user wrote in most become cards, named by the model, checked by code.
test('the first run starts from the threads the user wrote in; one organization is one card; words come from the subjects', async () => {
  const { sentSeeds, checkSeed } = await import('../src/hikyaku/discover.js');
  const sent = (conversation, subject, to, timestamp) => ({ conversation, subject, to: [to], primary: [to], timestamp });
  const seeds = sentSeeds([
    sent('c1', 'Room K inquiry | Karaoke event', 'khouse@gmail.com', '2026-10-06T10:00:00Z'), sent('c1', 'RE: Room K inquiry | Karaoke event', 'khouse@gmail.com', '2026-10-07T10:00:00Z'),
    sent('c1', 'RE: Room K inquiry | Karaoke event', 'khouse@gmail.com', '2026-10-17T10:00:00Z'),
    sent('c2', 'Introductions: Gio & Liz (M&T EA)', 'liz@bank.example', '2026-10-16T10:00:00Z'), sent('c3', 'EA follow-up', 'hr@bank.example', '2026-10-11T10:00:00Z'),
    sent('c4', 'Quick question', 'friend@school.edu', '2026-10-01T10:00:00Z'),
  ], 'gio@school.edu');
  assert.deepEqual(seeds.map((seed) => [seed.sends, seed.domains]), [[3, []], [2, ['bank.example']]], 'one-off emails are not work; bank.example joins two threads; gmail.com names no one');
  assert.deepEqual(checkSeed({ name: 'Japan Club Karaoke', kind: 'club', words: ['karaoke', 'Cornell', 'Gio'] }, seeds[0], { ownNames: ['Gio'] }), { name: 'Japan Club Karaoke', kind: 'other', terms: ['karaoke'], domains: [] });
  assert.equal(checkSeed({ name: 'Japan Club', words: ['cornell'] }, seeds[0]), null, 'nothing to find its mail by');
  assert.deepEqual(checkSeed({ name: 'M&T Interview', kind: 'company', words: ['Gio Caballero'] }, seeds[1], { ownNames: ['Gio Caballero'] }).domains, ['bank.example'], 'the domain alone finds its mail');

  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-'));
  const complete = async (prompt) => (prompt.startsWith('<sent>') ? '{"name": "Japan Club Karaoke", "kind": "club", "words": ["karaoke"]}' : '{"found": []}');
  const log = await discover({ threads: [], workstreams: [], complete, home, ownAddress: 'gio@school.edu', first: true, sent: [
    sent('c1', 'Room K inquiry | Karaoke event', 'khouse@gmail.com', '2026-10-06T10:00:00Z'), sent('c1', 'RE: Room K inquiry', 'khouse@gmail.com', '2026-10-07T10:00:00Z')] });
  assert.deepEqual(log.added.map((item) => [item.name, item.terms]), [['Japan Club Karaoke', ['karaoke']]]);
  const saved = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'));
  assert.equal(saved[0].found.fromSent, 2);
  assert.equal(saved[0].cloud, undefined, 'no yes for found workspaces: the card waits for its own');

  // The setup yes covers found workspaces' mail (settings.cloudYes.found): each new card is written approved.
  const yesHome = await mkdtemp(join(tmpdir(), 'hikyaku-discover-yes-'));
  await discover({ threads: [], workstreams: [], complete, home: yesHome, ownAddress: 'gio@school.edu', first: true, cloud: 'nebius', sent: [
    sent('c1', 'Room K inquiry | Karaoke event', 'khouse@gmail.com', '2026-10-06T10:00:00Z'), sent('c1', 'RE: Room K inquiry', 'khouse@gmail.com', '2026-10-07T10:00:00Z')] });
  const approved = JSON.parse(await readFile(join(yesHome, 'workstreams.json'), 'utf8'));
  assert.equal(approved[0].cloud, 'nebius');
  const { consentFor } = await import('../src/hikyaku/cloud-screen.js');
  assert.ok(consentFor('mail', { workstream: approved[0] }), 'its catch-up has the mail yes');
  const later = await discover({ threads: [], workstreams: saved, complete, home, ownAddress: 'gio@school.edu', sent: [] });
  assert.equal(later.added.length, 0, 'later runs never seed from sent mail');
});

// Edit and Dismiss on a card (Gio, 2026-10-17): a found workspace is edited or dismissed, never added by hand.
test('Dismiss takes a workspace off every list for good; Edit changes only the name the card shows', async () => {
  const { dismissWorkstream, dismissedNames, readWorkstreams, saveWorkstreamFields, cardList } = await import('../src/hikyaku/workstreams.js');
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-dismiss-'));
  const complete = async (prompt) => (prompt.startsWith('<sent>') ? '{"name": "Japan Club Karaoke", "kind": "other", "words": ["karaoke"]}' : '{"found": []}');
  const sent = [{ conversation: 'c1', subject: 'Karaoke night', to: ['k@venue.com'], primary: ['k@venue.com'], timestamp: '2026-10-06T10:00:00Z' }, { conversation: 'c1', subject: 'RE: Karaoke night', to: ['k@venue.com'], primary: ['k@venue.com'], timestamp: '2026-10-07T10:00:00Z' }];
  await discover({ threads: [], workstreams: [], complete, home, ownAddress: 'gio@school.edu', first: true, sent });
  const edited = await saveWorkstreamFields(home, 'Japan Club Karaoke', { label: 'JJC Karaoke Oct 22' });
  assert.deepEqual([edited.name, edited.label], ['Japan Club Karaoke', 'JJC Karaoke Oct 22'], 'its mail is still found by its own name');
  await dismissWorkstream(home, 'Japan Club Karaoke');
  assert.deepEqual(await readWorkstreams(home), [], 'gone from every list');
  const cards = cardList({ workstreams: [], projects: [{ id: 'p1', name: 'Japan Club Karaoke' }], tasks: [{ projectId: 'p1', status: 'waiting' }], hidden: await dismissedNames(home) });
  assert.deepEqual(cards, [], 'its open moves do not bring it back as a folder card');
  const again = await discover({ threads: [], workstreams: await readWorkstreams(home), complete, home, ownAddress: 'gio@school.edu', first: true, sent });
  assert.equal(again.added.length, 0, 'never found again');
});

// The Found step's bar and counts (first-run-polish B4.2, B4.1): the look says how far it is, and each card it writes
// carries how many threads it holds, how many of their emails are the user's, and who wrote the quote.
test('onProgress says 0, each batch end, then naming; a found card carries threads, yours and the quote sender', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-progress-'));
  const answer = mail('t6', `Ana <${ME}>`, 'Re: CA Canvas Training', 'Thanks, I will do the training.', '2026-10-06T15:00:00Z').messages[0];
  const training = { ...TRAINING, latestTimestamp: '2026-10-06T15:00:00Z', messages: [...TRAINING.messages, answer] };
  const complete = async (prompt) => (prompt.startsWith('<sentence>') ? '{"new": true}' : prompt.includes('[1] CA Canvas Training')
    ? JSON.stringify({ found: [{ name: 'MGMT 5090 CA', kind: 'class', threads: [1], terms: ['MGMT 5090'], quote: "You have been asked to CA for Professor Kato & Lund's MGMT 5090 course." }] }) : '{"found": []}');
  const seen = [];
  await discover({ threads: [training, WORKDAY, NEWS], workstreams: [], complete, home, ownAddress: ME, batchSize: 2, onProgress: (data) => seen.push(data), now: () => new Date('2026-10-06T16:00:00Z') });
  assert.deepEqual(seen, [{ read: 0, total: 3, naming: false }, { read: 2, total: 3, naming: false }, { read: 3, total: 3, naming: false }, { read: 3, total: 3, naming: true }]);
  const [card] = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'));
  assert.equal(card.found.threads, 1);
  assert.equal(card.found.yours, 1, 'one email in its thread is the user\'s');
  assert.equal(card.found.quoteFrom, 'Ops <ops1@school.example.com>', 'the quote is credited to the message that holds it');
  assert.equal(card.found.from, `Ana <${ME}>`, 'from stays the thread\'s last sender');

  const empty = [];
  await discover({ threads: [], workstreams: [], complete, home: await mkdtemp(join(tmpdir(), 'hikyaku-discover-none-')), ownAddress: ME, onProgress: (data) => empty.push(data) });
  assert.deepEqual(empty, [{ read: 0, total: 0, naming: false }, { read: 0, total: 0, naming: true }], 'with no fresh thread the first call is the only batch call');
});

test('a seed card carries fromSent and yours from the sends, threads 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-discover-seed-'));
  const complete = async (prompt) => (prompt.startsWith('<sent>') ? '{"name": "Robotics Club", "kind": "other", "words": ["robotics"]}' : '{"found": []}');
  const sent = [1, 2, 3].map((n) => ({ conversation: 'c1', subject: n === 1 ? 'Robotics build night' : 'Re: Robotics build night', primary: ['lee@robotics.example'], timestamp: `2026-10-1${n}T10:00:00Z` }));
  await discover({ threads: [], workstreams: [], complete, home, ownAddress: 'sam@school.example', first: true, sent });
  const [card] = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'));
  assert.deepEqual([card.found.fromSent, card.found.yours, card.found.threads, card.found.from], [3, 3, 0, '']);
});
