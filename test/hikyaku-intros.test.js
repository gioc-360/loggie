// loggie-intros I1 (docs/intros/spec.md 1.1, 1.2, 1.6): an introduction in an email body is found by code, saved to
// the workspace's people, and its address never reaches a model prompt, a title or a brief. Made-up people only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { introducedIn, introsIn, movable } from '../src/hikyaku/introduced.js';
import { addPeople, catchUp, catchUpPrompt, digest, readWorkstreams } from '../src/hikyaku/workstreams.js';
import { screenText } from '../src/hikyaku/cloud-screen.js';
import { doIt } from '../src/hikyaku/do-it.js';
import { storeCore } from './helpers/fake-core.js';

const ME = 'gio@school.example';
const own = [ME];
const JORDAN = 'Haidon, Jordan <jreyes@bank.example>';
const DANA = 'dana.okafor@bank.example';
// The Oct 16 shape: a contact the user wrote to answers with someone else's name and address, and Outlook's mailto copy.
const OCT16 = `Hi Gio! I'm awaiting my contact from the tech space to get back to me but have you connected before with Dana Okafor: ${DANA}<mailto:${DANA}> She's a Cornell Alum on our data team and very approachable.\n\nBest,\nJordan`;
const intro = (fields = {}) => ({ id: 'm2', from: JORDAN, to: `Gio Tanaka <${ME}>`, cc: '', subject: 'RE: Thank you', timestamp: '2026-10-16T20:55:10Z', body: OCT16, ...fields });
const writtenTo = new Set(['jreyes@bank.example']);
const thread = (messages, id = 'outlook:41') => ({ id, sourceType: 'manual', subject: 'RE: Thank you', latestTimestamp: messages.at(-1).timestamp, messages });
const mine = { id: 'm1', from: `Gio Tanaka <${ME}>`, to: JORDAN, cc: '', subject: 'Thank you', timestamp: '2026-10-14T15:00:00Z', body: 'Thank you for Monday. Anyone on the tech side I could learn from?' };

test('1.1a the Oct 16 shape gives one body pair: her name, her address, who introduced her and when', () => {
  assert.deepEqual(introducedIn(intro(), { own, writtenTo }), [{ name: 'Dana Okafor', address: DANA, shape: 'body', by: 'jreyes@bank.example', at: '2026-10-16T20:55:10.000Z' }]);
});

test('1.1b-g a signature, a roster, a machine, a stranger, a crowd and "Email:" give no pair', () => {
  const signature = 'Thanks for the note, see you Friday.\n\nBest,\nJordan Reyes\nManaging Director\nAssistant: Kim Lee, kim.lee@bank.example';
  assert.deepEqual(introducedIn(intro({ body: signature }), { own, writtenTo }), [], 'b: a signature with no cue');
  const roster = 'Please reach out to any of our mentors:\nAna Ruiz <ana.ruiz@co.example>\nMarcus Bell <mbell@co.example>\nPriya Shah <pshah@co.example>';
  assert.deepEqual(introducedIn(intro({ body: roster }), { own, writtenTo }), [], 'c: a roster of 3 is a list');
  assert.deepEqual(introducedIn(intro({ from: 'Bank <noreply@bank.example>' }), { own, writtenTo: new Set(['noreply@bank.example']) }), [], 'd: a MACHINE sender');
  assert.deepEqual(introducedIn(intro(), { own, writtenTo: new Set(['someone@else.example']) }), [], 'e: a sender the user never wrote to');
  const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@class.example`).join(', ');
  assert.deepEqual(introducedIn(intro({ to: eleven }), { own, writtenTo }), [], 'f: 11 recipients');
  assert.deepEqual(introducedIn(intro({ body: `You should connect with her directly. Email: ${DANA}` }), { own, writtenTo }), [], 'g: "Email:" is not a name');
});

test('1.1i a timestamp that does not parse gives no pair', () => {
  assert.deepEqual(introducedIn(intro({ timestamp: 'Thursday' }), { own, writtenTo }), []);
});

test('introsIn reads only threads the user wrote in, one Intro per address, the earliest; movable drops a pair written to since', () => {
  assert.deepEqual(introsIn([thread([intro()])], { own, writtenTo }), [], 'no USER message in the thread');
  const again = { ...intro(), id: 'm3', timestamp: '2026-10-18T10:00:00Z' };
  const found = introsIn([thread([mine, intro(), again])], { own, writtenTo });
  assert.equal(found.length, 1);
  assert.deepEqual({ thread: found[0].thread, message: found[0].message, at: found[0].at }, { thread: 'outlook:41', message: 'm2', at: '2026-10-16T20:55:10.000Z' });
  assert.deepEqual([...movable(found, []).keys()], ['outlook:41']);
  assert.deepEqual([...movable(found, [{ to: [DANA], timestamp: '2026-10-15T09:00:00Z' }]).keys()], ['outlook:41'], 'an email before the introduction does not count');
  assert.equal(movable(found, [{ to: [DANA.toUpperCase()], timestamp: '2026-10-20T14:17:00Z' }]).size, 0, 'written to after it: saved, no move');
});

test('1.1h a person saved from an introduction introduces no one until a Sent row reaches them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'intros-h-'));
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Bank', kind: 'company', domains: ['bank.example'], words: [] }]));
  await addPeople(home, 'Bank', [{ name: 'Dana Okafor', address: DANA }]);
  assert.deepEqual((await readWorkstreams(home))[0].people, [{ name: 'Dana Okafor', address: DANA }]);
  // Dana writes back introducing Marcus. writtenTo is the user's Sent `to` only, as the catch-up builds it.
  const fromDana = { id: 'm5', from: `Dana Okafor <${DANA}>`, to: ME, cc: '', subject: 'Re: Hello', timestamp: '2026-10-19T12:00:00Z', body: 'Great to hear from you. You should talk to Marcus Bell, mbell@bank.example, he ran the program.' };
  const sent = [{ to: ['jreyes@bank.example'], timestamp: '2026-10-14T15:00:00Z' }];
  const writtenFrom = (rows) => new Set(rows.flatMap((row) => row.to));
  const threads = [thread([{ ...mine, to: DANA }, fromDana], 'outlook:77')];
  assert.deepEqual(introsIn(threads, { own, writtenTo: writtenFrom(sent) }), [], 'saved in people, never written to: not an introducer');
  const pairs = introsIn(threads, { own, writtenTo: writtenFrom([...sent, { to: [DANA], timestamp: '2026-10-18T09:00:00Z' }]) });
  assert.deepEqual(pairs.map((pair) => [pair.name, pair.address, pair.by]), [['Marcus Bell', 'mbell@bank.example', DANA]]);
});

test('1.2 the screened catch-up prompt holds her name and the marker, never her address', () => {
  const prompt = screenText(catchUpPrompt({ name: 'Bank', goal: 'Get an offer', digests: [digest(thread([mine, intro()]), 1, own)], profile: '', today: '2026-10-20' })).text;
  assert.match(prompt, /Dana Okafor/);
  assert.match(prompt, /\[address kept on this Mac\]/);
  assert.ok(!prompt.includes(DANA) && !prompt.includes('jreyes@bank.example'), 'no address reaches the model');
});

const fakeCore = () => storeCore({ projectId: () => 'p1', brief: 'draft' });

test('1.2 the intro move\'s title, Core brief, BRIEF.md, ask line and Draft it text hold no "@"', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'intros-work-'));
  const core = fakeCore();
  const t = thread([mine, intro()]);
  const complete = async () => JSON.stringify({ summary: 'Jordan is waiting on a tech contact.', promised: [], open: [], actions: [] });
  await catchUp({ workstream: { name: 'Bank', kind: 'company', goal: 'Get an offer', domains: ['bank.example'], words: [] }, threads: [t], complete, core, workRoot, ownAddress: own, today: '2026-10-20',
    intros: movable(introsIn([t], { own, writtenTo }), []) });
  assert.equal(core.tasks.length, 1);
  const [task] = core.tasks;
  const folder = join(core.projects[0].directoryPath, task.id);
  const reply = JSON.parse(await readFile(join(folder, 'REPLY.json'), 'utf8'));
  for (const [what, text] of [['title', task.title], ['description', task.description], ['Core brief', JSON.stringify(core.briefs[0])], ['BRIEF.md', await readFile(join(folder, 'BRIEF.md'), 'utf8')], ['ask.line', reply.ask.line]]) {
    assert.ok(!text.includes('@'), `${what} holds an address: ${text}`);
  }
  // Draft it with a line: the text the ask box gets names her; her address goes only as the choice key.
  const said = [];
  const memory = { getTask: async () => ({ ...task }), getProject: async () => ({ id: 'p1', directoryPath: core.projects[0].directoryPath }), getApprovedBrief: async () => ({ id: 'brief_1' }),
    transitionTask: async (id, to) => { task.status = to; return { ...task }; } };
  await doIt({ core: memory, taskId: task.id, home: workRoot, line: 'ask if she has 20 minutes next week', options: { ask: async (text, options) => { said.push({ text, options }); return { outcome: 'failed', lines: ['stopped here'] }; } } });
  assert.equal(said.length, 1);
  assert.ok(!said[0].text.includes('@'), said[0].text);
  assert.deepEqual(said[0].options.choices, { 'Dana Okafor': `outlook:${DANA}` });
});

test('1.6 addPeople merges by address, keeps the line\'s other fields and the person already there, and refuses an unknown workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'intros-add-'));
  const line = { name: 'Bank', kind: 'company', domains: ['bank.example'], words: [], stake: 'more', cloud: 'nebius', people: [{ name: 'D. Okafor', address: DANA.toUpperCase() }] };
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([line]));
  const first = await addPeople(home, 'Bank', [{ name: 'Dana Okafor', address: DANA }, { name: 'Marcus Bell', address: 'mbell@bank.example' }, { name: 'No Address' }]);
  assert.deepEqual(first, { added: 1 });
  const saved = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'))[0];
  assert.deepEqual(saved.people, [{ name: 'Marcus Bell', address: 'mbell@bank.example' }, { name: 'D. Okafor', address: DANA }], 'new first, the one already there left as it was');
  assert.deepEqual({ stake: saved.stake, cloud: saved.cloud, domains: saved.domains }, { stake: 'more', cloud: 'nebius', domains: ['bank.example'] });
  assert.deepEqual(await addPeople(home, 'Bank', [{ name: 'Marcus Bell', address: 'MBELL@bank.example' }]), { added: 0 });
  await assert.rejects(addPeople(home, 'Nope', [{ name: 'A', address: 'a@b.example' }]), /No workspace named "Nope"\./);
});

test('I3 the To shape: one other person on an introducing email, named by the header ("Last, First" flipped) or by `names`', () => {
  const to = { id: 'm9', from: JORDAN, to: `${ME}, Lu, Jess <jess.lu@studio.example>`, cc: '', subject: 'Jess Lu introduction', timestamp: '2026-08-26T14:00:00Z', body: 'Jess, meet Gio.' };
  assert.deepEqual(introducedIn(to, { own, writtenTo }), [{ name: 'Jess Lu', address: 'jess.lu@studio.example', shape: 'to', by: 'jreyes@bank.example', at: '2026-08-26T14:00:00.000Z' }], 'a bare address before it never joins the name');
  const bare = { ...to, to: ME, cc: 'jess.lu@studio.example' };
  assert.deepEqual(introducedIn(bare, { own, writtenTo }), [], 'no name anywhere: none');
  assert.equal(introducedIn(bare, { own, writtenTo, names: new Map([['jess.lu@studio.example', 'Lu, Jess']]) })[0].name, 'Jess Lu');
  assert.deepEqual(introducedIn({ ...to, subject: 'Deck', body: 'See attached.' }, { own, writtenTo }), [], 'no "introduc" in the subject or the first 600 characters');
  assert.deepEqual(introducedIn({ ...to, cc: 'Kim Lee <klee@studio.example>' }, { own, writtenTo }), [], 'two other people: none');
});
