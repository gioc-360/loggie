import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnPeople, learnThreads, route, threadMap } from '../src/hikyaku/router.js';

const W = [
  { name: 'Bank Offer', kind: 'company', domains: ['bank.example'], words: ['Bank Offer'], people: [{ name: 'Ana Recruiter', address: 'ana@bank.example' }] },
  { name: 'Hotel Hackathon', kind: 'competition', domains: ['hotel.example'], words: ['Hackathon'], people: [{ name: 'Ivy Teammate', handle: '+16075550100' }] },
  { name: 'App Project', kind: 'other', domains: [], words: ['App Project'] },
  { name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true },
];
const ctx = (extra = {}) => ({ workstreams: W, learned: new Map(), threads: new Map(), ...extra });

test('a filed call keeps its filing, before any other evidence', () => {
  assert.deepEqual(route({ source: 'call', title: 'Hackathon sync', filed: 'Bank Offer', who: [] }, ctx()), { workstream: 'Bank Offer', how: 'filed', candidates: [] });
});

test('a continued thread routes where the thread already is', () => {
  const threads = threadMap([{ source: 'outlook', thread: 'oct 24 class conflict', workstream: 'Hotel Hackathon', at: '2026-10-03T00:00:00Z' }]);
  assert.equal(route({ source: 'outlook', thread: 'oct 24 class conflict', title: 'Re: class conflict', who: [{ address: 'prof@uni.example' }] }, ctx({ threads })).workstream, 'Hotel Hackathon');
});

test('a domain routes; the workstream name counts as a word', () => {
  assert.deepEqual(route({ source: 'outlook', title: 'Scheduling a video interview', who: [{ address: 'hr@bank.example' }] }, ctx()), { workstream: 'Bank Offer', how: 'domain', candidates: [] });
  assert.equal(route({ source: 'messages', title: 'Hotel Hackathon', who: [{ handle: '+1999' }] }, ctx()).how, 'word');
});

test("a word inside a person's name does not route; the same word in the subject still does", () => {
  const ws = [{ name: 'Pharmco case comp', kind: 'competition', domains: ['pharmco.example'], words: ['Pharmco'] }];
  const who = [{ name: 'Dana Pharmco', address: 'dana@gmail.example' }];
  assert.equal(route({ source: 'gmail', title: 'Intro: new to Ithaca', text: 'Best regards,\n*Dana Pharmco*', who }, { workstreams: ws }).workstream, null);
  assert.equal(route({ source: 'gmail', title: 'Pharmco case question', text: 'Dana Pharmco', who }, { workstreams: ws }).workstream, 'Pharmco case comp');
  assert.equal(route({ source: 'gmail', title: 'Re: Intro', text: 'Thanks!\n*Dana Pharmco*', who: [{ name: '', address: 'dana.pharmco@gmail.example' }] }, { workstreams: ws }).workstream, null);
});

test('a short word only matches as a whole word', () => {
  const ws = [{ name: 'A&B Bank', kind: 'company', domains: [], words: ['A&B'] }];
  assert.equal(route({ source: 'outlook', title: 'Notes from A&B chat', who: [] }, { workstreams: ws }).workstream, 'A&B Bank');
  assert.equal(route({ source: 'outlook', title: 'Notes from SA&Bco', who: [] }, { workstreams: ws }).workstream, null);
});

test('two rules split is narrowed by a person, else stays unsure with both', () => {
  const item = { source: 'outlook', title: 'Hackathon and App Project', who: [{ address: 'ana@bank.example' }] };
  const split = route({ ...item, who: [{ address: 'x@else.example' }] }, ctx());
  assert.deepEqual(split, { workstream: null, how: 'none', candidates: ['Hotel Hackathon', 'App Project'] });
  const learned = new Map([['App Project', [{ name: 'Jo', address: 'jo@else.example' }]]]);
  assert.equal(route({ ...item, who: [{ address: 'jo@else.example' }] }, ctx({ learned })).workstream, 'App Project');
});

test('a confirmed person routes; a chat handle counts', () => {
  assert.deepEqual(route({ source: 'whatsapp', title: '', who: [{ name: 'Ivy', handle: '+16075550100' }] }, ctx()), { workstream: 'Hotel Hackathon', how: 'person', candidates: [] });
  assert.equal(route({ source: 'calendar', title: 'Coffee', who: [{ address: 'ANA@bank.example' }] }, ctx()).how, 'domain');
});

test('a learned correspondent alone is only a suggestion', () => {
  const learned = new Map([['Hotel Hackathon', [{ name: 'Prof K', address: 'prof@uni.example' }]]]);
  assert.deepEqual(route({ source: 'outlook', title: 'Request to attend remotely', who: [{ address: 'prof@uni.example' }] }, ctx({ learned })),
    { workstream: null, how: 'none', candidates: ['Hotel Hackathon'] });
});

test('big lists and big group chats never count a person', () => {
  const crowd = Array.from({ length: 9 }, (_, i) => ({ address: `p${i}@else.example` }));
  const learned = new Map([['App Project', [{ name: 'P0', address: 'p0@else.example' }]]]);
  assert.deepEqual(route({ source: 'outlook', title: 'Weekly update', who: crowd }, ctx({ learned })).candidates, []);
  const group = [{ name: 'Ivy', handle: '+16075550100' }, ...Array.from({ length: 13 }, (_, i) => ({ handle: `+1${i}` }))];
  assert.equal(route({ source: 'whatsapp', title: 'Class of 2027', who: group }, ctx()).workstream, null);
});

test('nothing matches: unsure with no candidates', () => {
  assert.deepEqual(route({ source: 'calendar', title: 'dinner', who: [] }, ctx()), { workstream: null, how: 'none', candidates: [] });
});

test('people are learned only from threads the user wrote in, without machines or big lists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-router-'));
  const dir = join(home, 'work', 'bank-offer', 'task_1');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'THREAD.md'), '# Intro\n\n## Ana Recruiter <ana@bank.example> · 2026-10-01T10:00:00Z\nTo: Me <me@uni.example>, Bo Partner <bo@bank.example>\n\nhi\n\n## me@uni.example · 2026-10-01T11:00:00Z\nTo: Ana Recruiter <ana@bank.example>\n\nthanks\n');
  const dir2 = join(home, 'work', 'bank-offer', 'task_2');
  await mkdir(dir2, { recursive: true });
  await writeFile(join(dir2, 'THREAD.md'), '# Reminder\n\n## Career Center <notifications@careers.example> · 2026-10-01T10:00:00Z\nTo: Me <me@uni.example>\n\nreminder\n');
  const learned = await learnPeople({ home, workstreams: [W[0]], ownAddresses: ['ME@uni.example'] });
  assert.deepEqual(learned.get('Bank Offer').map((p) => p.address).sort(), ['ana@bank.example', 'bo@bank.example']);
});

test('a reply on a thread a workstream already holds continues it; a shared subject proves nothing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-router-'));
  for (const [ws, task, subject] of [['bank-offer', 't1', 'Oct 24 class conflict'], ['bank-offer', 't2', 'Weekly sync'], ['app-project', 't3', 'Weekly sync']]) {
    await mkdir(join(home, 'work', ws, task), { recursive: true });
    await writeFile(join(home, 'work', ws, task, 'THREAD.md'), `# ${subject}\n\n## a@b.example · 2026-10-01T10:00:00Z\n\nx\n`);
  }
  const seed = await learnThreads({ home, workstreams: [W[0], W[2]], ownAddresses: ['me@uni.example'] });
  const threads = threadMap([], seed);
  assert.equal(route({ source: 'outlook', thread: 'oct 24 class conflict', title: 'Re: Oct 24 class conflict', who: [{ address: 'a@b.example' }] }, ctx({ threads })).how, 'thread');
  assert.equal(route({ source: 'outlook', thread: 'oct 24 class conflict', title: 'Re: Oct 24 class conflict', who: [{ address: 'stranger@c.example' }, { address: 'me@uni.example' }] }, ctx({ threads })).workstream, null);
  assert.equal(route({ source: 'outlook', thread: 'weekly sync', title: 'Re: Weekly sync', who: [] }, ctx({ threads })).workstream, null);
});
