import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileCall, ownSteps } from '../src/hikyaku/calls.js';
import { storeCore } from './helpers/fake-core.js';

const fakeCore = () => storeCore({ brief: 'id' });

async function callFolder() {
  const folder = join(await mkdtemp(join(tmpdir(), 'hikyaku-call-')), '2026-10-05-1400-coffee-chat-with-sam');
  await mkdir(folder);
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam Lee', start: '2026-10-05T18:00:00Z', emails: ['sam@example.com'], names: 'Sam Lee', me: 'Lena', with: 'Sam Lee', category: 'one-on-one', workstream: 'Acme Bank' }));
  await writeFile(join(folder, 'notes.md'), '# Coffee chat with Sam Lee\n\n## About Sam\n- Sam runs analytics at Acme (Sam)\n');
  await writeFile(join(folder, 'checks.json'), JSON.stringify([
    { bullet: 'Sam runs analytics at Acme', who: 'Sam', quote: 'I run the analytics team at Acme', not_sure: [] },
    { next_step: 'send Sam the deck', owner: 'Lena Park', quote: "I'll send the deck tonight", not_sure: [] },
    { next_step: 'introduce Lena to Dana', owner: 'Sam', quote: "I'll introduce you to Dana", not_sure: [] },
    { next_step: 'apply to the analytics role', owner: 'Me', quote: 'you should apply', not_sure: ['quote not found in transcript'] },
    { next_step: 'follow up with Dana about the role', owner: 'Lena', quote: 'Dana is the person to ask', not_sure: [] },
  ]));
  return folder;
}
const WORKSTREAMS = [{ name: 'Acme Bank', kind: 'company', domains: ['example.com'], words: [] }, { name: 'Classes', kind: 'class', domains: [], words: [] }];

test('only the user\'s own next steps become tasks, by "Me" or their first name', () => {
  const checks = [{ next_step: 'a', owner: 'Lena Park' }, { next_step: 'b', owner: 'Me' }, { next_step: 'c', owner: 'Sam' }, { bullet: 'x' }];
  assert.deepEqual(ownSteps(checks, 'Lena').map((step) => step.next_step), ['a', 'b']);
});

test('a call is filed on its workstream: notes in calls/, one ready task folder per own next step', async () => {
  const folder = await callFolder(); const core = fakeCore(); const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  const log = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.equal(log.workstream, 'Acme Bank'); assert.equal(log.created.length, 3); assert.equal(log.others, 1);
  assert.match(await readFile(log.notesFile, 'utf8'), /^# Call: Coffee chat with Sam Lee\n\n2026-10-05 · with Sam Lee · one-on-one/);
  const [send, apply] = core.tasks;
  assert.equal(send.title, 'Send Sam the deck'); assert.equal(send.sourceType, 'manual'); assert.equal(send.sourceId, 'call:2026-10-05-1400-coffee-chat-with-sam#1');
  assert.ok(apply.priority < send.priority, 'a not-sure step ranks lower');
  const taskFolder = join(core.projects[0].directoryPath, send.id);
  assert.match(await readFile(join(taskFolder, 'BRIEF.md'), 'utf8'), /> I'll send the deck tonight/);
  assert.match(await readFile(join(taskFolder, 'CALL.md'), 'utf8'), /Sam runs analytics at Acme/);
  assert.match(await readFile(join(taskFolder, 'THREAD.md'), 'utf8'), /No thread: this step comes from a call/);
  assert.equal(JSON.parse(await readFile(join(taskFolder, 'REPLY.json'), 'utf8')).to, 'sam@example.com');
  const dana = core.tasks.find((task) => task.title.startsWith('Follow up with Dana'));
  assert.equal(JSON.parse(await readFile(join(core.projects[0].directoryPath, dana.id, 'REPLY.json'), 'utf8')).to, '', 'a step about someone else never gets the call partner as recipient');
  assert.match(await readFile(join(core.projects[0].directoryPath, apply.id, 'BRIEF.md'), 'utf8'), /## Check\n- Not sure: quote not found in transcript/);
});

test('filing the same call twice adds nothing twice', async () => {
  const folder = await callFolder(); const core = fakeCore(); const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  const again = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.equal(again.created.length, 0); assert.equal(again.already, 3); assert.equal(core.tasks.length, 3); assert.equal(core.projects.length, 1);
});

test('Summarize again: the same step under a new number is not filed twice', async () => {
  const folder = await callFolder(); const core = fakeCore(); const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  // the new run puts a new step first, so every earlier step moves down one number
  await writeFile(join(folder, 'checks.json'), JSON.stringify([
    { next_step: 'book the analytics coffee with Dana', owner: 'Lena', quote: "I'll introduce you to Dana", not_sure: [] },
    { next_step: 'send Sam the deck', owner: 'Lena Park', quote: "I'll send the deck tonight", not_sure: [] },
    { next_step: 'apply to the analytics role', owner: 'Me', quote: 'you should apply', not_sure: [] },
  ]));
  const again = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.deepEqual(again.created.map((task) => task.title), ['Book the analytics coffee with Dana']);
  assert.equal(core.tasks.filter((task) => task.title === 'Send Sam the deck').length, 1);
});

test('a dry run writes nothing, and an unknown workstream says which ones exist', async () => {
  const folder = await callFolder(); const core = fakeCore();
  const plan = await fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true });
  assert.equal(plan.steps.length, 3); assert.equal(core.tasks.length, 0);
  await assert.rejects(fileCall({ folder, core, workRoot: '/nowhere', workstreams: WORKSTREAMS, workstream: 'Northwind' }), /--workstream and one of: Acme Bank, Classes/);
  const chosen = await fileCall({ folder, core, workRoot: await mkdtemp(join(tmpdir(), 'w-')), workstreams: WORKSTREAMS, workstream: 'classes' });
  assert.equal(chosen.workstream, 'Classes');
});

// Local notes off (frontier "nebius"): no notes.md, only what byo.py wrote. The run record's shape is byo.py's.
async function cloudFolder({ withNotes = false } = {}) {
  const folder = await callFolder();
  await rm(join(folder, 'notes.md')); await rm(join(folder, 'checks.json'));
  const step = (text, owner, quote, reasons = []) => ({ section: 'Next Steps', text, owner, quote, backed: true, reasons });
  await writeFile(join(folder, 'summary-claude.md'), '# Coffee chat with Sam Lee\n\n## Old\n- an older summary [00:01]\n');
  await writeFile(join(folder, 'summary-nebius.md'), '# Coffee chat with Sam Lee\n\n_summary by nvidia/nemotron-3-super-120b-a12b, on Nebius Token Factory; hikyaku checked it._\n\n## About Sam\n- Runs analytics at Acme [00:08]\n\n## Next Steps\n- Send Sam the deck (Lena) [00:20]\n');
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([
    { provider: 'claude', output: 'summary-claude.md', checks: [step('an older step', 'Lena', 'older words')] },
    { provider: 'nebius', output: 'summary-nebius.md', checks: [
      { section: 'About Sam', text: 'Runs analytics at Acme', owner: null, quote: 'I run the analytics team at Acme', backed: true, reasons: [] },
      step('Send Sam the deck', 'Lena', "I'll send you the deck tonight"),
      step('Introduce Lena to Dana', 'Sam Lee', "I'll introduce you to Dana"),
      step('Email Priya the notes', 'Lena', 'email the notes', ['never said: Priya']),
    ] },
  ]));
  if (withNotes) await writeFile(join(folder, 'notes.md'), '# Coffee chat with Sam Lee\n\n## Local\n- from the local notes\n');
  return folder;
}

test('with local notes off, a call is filed from the newest cloud summary and its checked next steps', async () => {
  const folder = await cloudFolder(); const core = fakeCore(); const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  const log = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.equal(log.notesFrom, 'summary-nebius.md'); assert.equal(log.workstream, 'Acme Bank'); assert.equal(log.others, 1);
  assert.deepEqual(core.tasks.map((task) => task.title), ['Send Sam the deck', 'Email Priya the notes']);
  const [deck, priya] = core.tasks;
  assert.ok(priya.priority < deck.priority, 'a step with a name never said ranks lower');
  const notes = await readFile(log.notesFile, 'utf8');
  assert.match(notes, /^# Call: Coffee chat with Sam Lee\n/); assert.match(notes, /Runs analytics at Acme/); assert.doesNotMatch(notes, /older summary/);
  const taskFolder = join(core.projects[0].directoryPath, deck.id);
  assert.match(await readFile(join(taskFolder, 'BRIEF.md'), 'utf8'), /> I'll send you the deck tonight/);
  assert.match(await readFile(join(core.projects[0].directoryPath, priya.id, 'BRIEF.md'), 'utf8'), /## Check\n- Not sure: never said: Priya/);
  const again = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.equal(again.created.length, 0); assert.equal(again.already, 2);
});

test('notes.md still wins when local notes ran, and a folder with neither says what to run', async () => {
  const folder = await cloudFolder({ withNotes: true });
  const plan = await fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true });
  assert.equal(plan.notesFrom, 'notes.md'); assert.equal(plan.steps.length, 0, 'no checks.json: no steps, as before');
  const old = await callFolder();
  assert.equal((await fileCall({ folder: old, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true })).notesFrom, 'notes.md');
  const empty = await callFolder(); await rm(join(empty, 'notes.md'));
  await assert.rejects(fileCall({ folder: empty, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true }), /No notes.md and no cloud summary.*--with nebius/);
});

test('a transcript-only call is filed with no summary, a link to the transcript, and no tasks', async () => {
  const folder = await callFolder();
  await rm(join(folder, 'notes.md'));
  await rm(join(folder, 'checks.json'));
  await writeFile(join(folder, 'transcript.md'), '[00:02] Me: Hi Sam.\n');
  const core = fakeCore();
  const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  const log = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS, transcriptOnly: true });
  assert.equal(log.workstream, 'Acme Bank');
  assert.deepEqual(log.created, []);
  assert.equal(core.tasks.length, 0);
  const card = await readFile(log.notesFile, 'utf8');
  assert.match(card, /no summary/i);
  assert.ok(card.includes(join(folder, 'transcript.md')));
  assert.ok(!card.includes('\u2014'));
  await assert.rejects(fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS, workstream: 'Northwind', transcriptOnly: true }), /No workstream/);
});

test('a re-filed call files under its filing, as the morning ranking does; "none" never names a workstream', async () => {
  const folder = await callFolder();
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  await writeFile(join(folder, 'event.json'), JSON.stringify({ ...event, workstream: 'Acme Bank', filed: { workstream: 'Classes', at: '2026-10-06T12:00:00Z' } }));
  const plan = await fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true });
  assert.equal(plan.workstream, 'Classes');
  await writeFile(join(folder, 'event.json'), JSON.stringify({ ...event, workstream: 'none' }));
  await assert.rejects(fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true }), /No workstream for this call \("none"\)/);
});

// loggie-class-notes I3: a class's notes keep "Student N" on disk; a step naming one is not filed as a task (the
// drafter would read the label), it stays in the notes and is counted. Made-up people only.
test('a class step naming a classmate label is left out of the filed tasks and counted as classmateSteps', async () => {
  const folder = join(await mkdtemp(join(tmpdir(), 'hikyaku-class-call-')), '2026-10-06-0905-strt-5010');
  await mkdir(folder);
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'STRT 5010 Strategy', start: '2026-10-06T13:05:00Z', me: 'Lena', category: 'class', workstream: 'Classes' }));
  const notes = '# STRT 5010 Strategy\n\n## Next Steps\n- Send Student 2 the pricing slides (Lena)\n';
  await writeFile(join(folder, 'notes.md'), notes);
  await writeFile(join(folder, 'checks.json'), JSON.stringify([
    { next_step: 'send Student 2 the pricing slides', owner: 'Lena', quote: "I'll send them over", not_sure: [] },
    { next_step: 'read the Porter chapter', owner: 'Me', quote: 'ask students 3 and 4 about it', not_sure: [] },
    { next_step: 'draft the case memo', owner: 'Lena', quote: "I'll start the memo tonight", not_sure: [] },
    { next_step: 'share the deck', owner: 'Student 1', quote: "I'll share the deck", not_sure: [] },
  ]));
  const core = fakeCore(); const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  const log = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.deepEqual(core.tasks.map((task) => task.title), ['Draft the case memo']);
  assert.equal(core.tasks[0].sourceId, 'call:2026-10-06-0905-strt-5010#3', 'a filed step keeps its own number');
  assert.equal(log.classmateSteps, 2); assert.equal(log.others, 1); assert.equal(log.created.length, 1);
  assert.match(await readFile(log.notesFile, 'utf8'), /Send Student 2 the pricing slides/, 'the step stays in the notes');
  const plan = await fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true });
  assert.deepEqual([plan.steps.length, plan.classmateSteps], [1, 2]);
  const again = await fileCall({ folder, core, workRoot, workstreams: WORKSTREAMS });
  assert.deepEqual([again.created.length, again.already, again.classmateSteps], [0, 1, 2]);
  // not a class: the same words are filed, and the result has no classmateSteps
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Coffee chat', start: '2026-10-06T13:05:00Z', me: 'Lena', category: 'one-on-one', workstream: 'Classes' }));
  const other = await fileCall({ folder, core: null, workRoot: '/nowhere', workstreams: WORKSTREAMS, dryRun: true });
  assert.equal(other.steps.length, 3); assert.ok(!('classmateSteps' in other));
});

test('a Claude summary alone never files steps: only a Nebius summary stands in for notes, as the Notes tab reads them', async () => {
  const folder = await callFolder();
  await rm(join(folder, 'notes.md')); await rm(join(folder, 'checks.json'));
  await writeFile(join(folder, 'summary-claude.md'), '# Coffee chat with Sam Lee\n\n## Next Steps\n- Send Sam the deck (Lena) [00:20]\n');
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ provider: 'claude', output: 'summary-claude.md', checks: [{ section: 'Next Steps', text: 'Send Sam the deck', owner: 'Lena', quote: 'deck', backed: true, reasons: [] }] }]));
  const core = fakeCore();
  await assert.rejects(fileCall({ folder, core, workRoot: await mkdtemp(join(tmpdir(), 'w-')), workstreams: WORKSTREAMS }), /No notes\.md and no cloud summary/);
  assert.equal(core.tasks.length, 0);
});
