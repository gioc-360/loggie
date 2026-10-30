import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHeadless } from '../src/hikyaku/headless.js';
import { recordingCore } from './helpers/fake-core.js';

// The cloud gate (docs/hikyaku-security.md, rule 7): the cloud AI reads a workstream only after the user approved
// that workstream, and only what the approval allows. Every test here is one row of the proposal's
// eval contract (~/hikyaku/proposal-cloud-gate-a.md, E1-E7). Made-up people and example addresses only.

const ME = 'ana@school.example.com';
const SAM = 'sam@example.com';
const STRANGER = 'stranger@elsewhere.example.com';

const fakeCore = () => recordingCore();

// A spawn spy: records every launch, and the fake run writes a draft, prints its one nebius line and exits cleanly.
function spy() {
  const launches = [];
  const spawnImpl = (bin, args, options) => {
    launches.push({ bin, args, options });
    const child = new EventEmitter();
    child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    setImmediate(async () => {
      await writeFile(join(options.cwd, 'task_1', 'DRAFT.md'), 'Hi Sam,\n\nSure.\n\nBest regards,');
      child.stdout.emit('data', `${JSON.stringify({ type: 'nebius', ok: true, text: 'Wrote DRAFT.md.', error: null })}\n`);
      child.emit('close', 0);
    });
    return child;
  };
  return { launches, spawnImpl };
}

// A hikyaku home with one workstream folder ("acme"), one task in it, and voice files.
async function home({ workstreams = [{ name: 'Acme', kind: 'company', domains: ['example.com'], words: [] }], settings = { mailApp: 'gmail', ownAddresses: [ME] }, voice = {}, thread = `# Deck\n\n## Sam Doe <${SAM}> · 2026-10-05T12:00:00.000Z\nTo: ${ME}\n\nCan you send the deck?\n` } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-cloud-'));
  const directoryPath = join(root, 'work', 'acme');
  await mkdir(join(directoryPath, 'task_1'), { recursive: true });
  await mkdir(join(root, 'voice'), { recursive: true });
  if (workstreams) await writeFile(join(root, 'workstreams.json'), typeof workstreams === 'string' ? workstreams : JSON.stringify(workstreams));
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(directoryPath, 'CONTEXT.md'), '# Acme\n\nWaiting on the deck.\n');
  await writeFile(join(directoryPath, 'task_1', 'THREAD.md'), thread);
  await writeFile(join(directoryPath, 'task_1', 'BRIEF.md'), '# Send the deck\n');
  await writeFile(join(directoryPath, 'task_1', 'REPLY.json'), JSON.stringify({ to: SAM, subject: 'Re: Deck', account: ME }));
  for (const [name, text] of Object.entries({ 'intros.md': '# How you introduce yourself\n', 'recent.md': '# How you write now\n', ...voice })) await writeFile(join(root, 'voice', name), text);
  return { root, directoryPath, voiceDirectory: join(root, 'voice') };
}

// Nothing here may open a mail app: the draft "opens" into a stub.
const run = async (h, { calendarText = null, ...rest } = {}) => {
  const core = fakeCore(); const s = spy();
  const started = await startHeadless({ core, task: { id: 'task_1', status: 'briefed' }, directoryPath: h.directoryPath, voiceDirectory: h.voiceDirectory, home: h.root, spawnImpl: s.spawnImpl, calendarText,
    openDraftImpl: async () => ({ opened: 'gmail', mode: 'reply', detail: 'stub' }), ...rest });
  const state = await started.done;
  return { core, launches: s.launches, state, started };
};
const exists = (path) => stat(path).then(() => true, () => false);

test('E1: a workstream with no cloud field means no spawn, no CALENDAR.md, and a needs-you that says how to approve', async () => {
  const h = await home();
  let calendarAsked = false;
  const { launches, state, core, started } = await run(h, { calendarText: async () => { calendarAsked = true; return 'calendar'; } });
  assert.equal(launches.length, 0, 'the run was launched');
  assert.equal(calendarAsked, false, 'the calendar was read before the gate');
  assert.equal(await exists(join(h.directoryPath, 'task_1', 'CALENDAR.md')), false);
  assert.equal(started.started, false);
  assert.deepEqual([state.phase, state.kind], ['needs-you', 'cloud-off']);
  assert.match(state.question, /"Acme" is not approved for the cloud AI\. Approve it to let the cloud AI read this workspace\./);
  assert.ok(!core.calls.some(([name]) => name === 'createSession'), 'no session was created');
  // Core forbids briefed -> blocked: the task stays briefed so the next Do it, after the approval, runs; the
  // question reaches the card through do-it.js (test/hikyaku-do-it.test.js), not through a refused transition.
  assert.ok(!core.calls.some(([name, , status]) => name === 'transitionTask' && status === 'blocked'), 'no transition Core would refuse');
  const written = JSON.parse(await readFile(join(h.directoryPath, 'task_1', 'STATE.json'), 'utf8'));
  assert.equal(written.kind, 'cloud-off');
});

test('E2: a workstream approved for agy, claude or codex is refused as off, and nothing spawns', async () => {
  for (const old of ['agy', 'claude', 'codex']) {
    const h = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: old }] });
    const { launches, state } = await run(h);
    assert.equal(launches.length, 0, old);
    assert.deepEqual([state.phase, state.kind], ['needs-you', 'cloud-off'], old);
    assert.match(state.question, /"Acme" is not approved for the cloud AI\./, old);
  }
  const h = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }] });
  assert.equal((await run(h)).launches.length, 1, 'an approval for the cloud AI runs');
});

test('E3: workstreams.json broken, missing, or without this workstream: refused, never a default', async () => {
  for (const [label, workstreams] of [['broken', '{ not json'], ['missing', null], ['other workstream only', [{ name: 'Globex', kind: 'company', domains: [], words: [], cloud: 'nebius' }]], ['bad value', [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'yes' }]]]) {
    const h = await home({ workstreams });
    const { launches, state } = await run(h);
    assert.equal(launches.length, 0, label);
    assert.deepEqual([state.phase, state.kind], ['needs-you', 'cloud-off'], label);
  }
});

test('E4: the cloud calendar keeps free slots and busy blocks, never a title, a name or a stranger', async () => {
  const { calendarForCloud } = await import('../src/hikyaku/cloud.js');
  const events = [
    { id: 'e1', title: 'Cornell Health appt', start: '2026-10-07T19:00:00.000Z', end: '2026-10-07T22:00:00.000Z', allDay: false, calendar: 'Personal', account: 'iCloud', writable: true, attendees: ['nurse@clinic.example.org'], attendeeNames: ['Nurse Kim'], location: 'Room 4' },
    { id: 'e2', title: 'Deck review with Sam', start: '2026-10-08T14:00:00.000Z', end: '2026-10-08T15:00:00.000Z', allDay: false, calendar: 'Work', account: 'Exchange', writable: true, attendees: [SAM], attendeeNames: ['Sam Doe'], location: '' },
    { id: 'e3', title: 'DUE: case write-up (NBA 6540)', start: '2026-10-09T04:00:00.000Z', end: '2026-10-10T04:00:00.000Z', allDay: true, calendar: 'School', account: 'Exchange', writable: true, attendees: [], attendeeNames: [], location: '' },
  ];
  const text = calendarForCloud({ meetingHours: { startHour: 9, endHour: 17, timeZone: 'America/New_York' } }, { events, allowed: new Set([ME, SAM]), from: new Date('2026-10-06T12:00:00.000Z'), days: 7 });
  assert.match(text, /Offer these:/);
  assert.match(text, /^Wed, Oct 7 3:00 PM-6:00 PM {2}busy$/m, 'a busy block with nothing else');
  assert.doesNotMatch(text, /Cornell Health|nurse@|Nurse Kim|Room 4|Personal|iCloud|e1|NBA 6540|case write-up/);
  assert.match(text, /^Thu, Oct 8 10:00 AM-11:00 AM {2}Deck review with Sam {2}\[with sam@example\.com\]$/m, 'an event whose people are all in the approved threads keeps its title');
  assert.doesNotMatch(text, /Calendars read|Read-only feeds|All-day items|id=/);
});

test('E5: a stranger in this workstream\'s own recent edits blocks the run and privacy-stop names the file; another workstream\'s edits never reach the agent', async () => {
  const h = await home();
  await writeFile(join(h.root, 'workstreams.json'), JSON.stringify([{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }]));
  const delta = (task, to) => JSON.stringify({ at: '2026-10-04T12:00:00.000Z', task, to, subject: 'Injury', sentAt: '2026-10-04T12:00:00.000Z', editRatio: 0.4, draft: 'I hurt my knee', sent: `I hurt my knee, cc ${to}` });
  // An edit from another workstream (task_9 is not in this folder) names a stranger: it stays out of this run's voice.
  await writeFile(join(h.root, 'deltas.jsonl'), `${delta('task_9', STRANGER)}\n`);
  const other = await run(h);
  assert.equal(other.launches.length, 1, 'another workstream\'s edits are not in reach');
  const perWorkstream = await readFile(join(h.voiceDirectory, 'by-workstream', 'acme', 'recent.md'), 'utf8');
  assert.doesNotMatch(perWorkstream, /stranger@|knee/, 'the per-workstream recent.md holds nothing from elsewhere');
  assert.match(other.launches[0].args.join(' '), /by-workstream\/acme/, 'the agent reads the per-workstream voice folder');
  // The same edit on this workstream's own task reaches the agent, so the stranger in it stops the run.
  await writeFile(join(h.root, 'deltas.jsonl'), `${delta('task_1', STRANGER)}\n`);
  const { launches, state } = await run(h);
  assert.equal(launches.length, 0, 'the run was launched with a stranger in reach');
  assert.deepEqual([state.phase, state.kind], ['needs-you', 'privacy-stop']);
  assert.match(state.question, /recent\.md \(1 address\)/);
  assert.doesNotMatch(state.question, /stranger@/, 'the address itself is not repeated into the question');
  assert.equal(await exists(join(h.directoryPath, 'task_1', 'CALENDAR.md')), false, 'nothing was written');
  // The same workstream's own people are allowed: a thread address and the user's own never trip it.
  await writeFile(join(h.root, 'deltas.jsonl'), `${delta('task_1', SAM)}\n`);
  const ok = await run(h);
  assert.equal(ok.launches.length, 1);
  // An old CALENDAR.md from before the gate (titles, attendees) never blocks: the gate rewrites it before the agent reads it.
  await writeFile(join(h.root, 'deltas.jsonl'), '');
  await writeFile(join(h.directoryPath, 'task_1', 'CALENDAR.md'), `Wed  Workday  [Exchange · with ${STRANGER}]\n`);
  const stale = await run(h, { calendarText: async () => 'fresh calendar' });
  assert.equal(stale.launches.length, 1, 'an old calendar file is not a stranger');
  assert.equal(await readFile(join(stale.launches[0].options.cwd, 'task_1', 'CALENDAR.md'), 'utf8'), 'fresh calendar', 'the room holds the fresh calendar');
  // The person a move is addressed to (REPLY.json) is allowed even with no THREAD.md: a custom workstream has none.
  const custom = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }], thread: '' });
  await writeFile(join(custom.directoryPath, 'task_1', 'REPLY.json'), JSON.stringify({ to: 'prof@school.example.com', cc: 'ta@school.example.com', subject: 'Remote for a week', account: ME }));
  await writeFile(join(custom.directoryPath, 'task_1', 'BRIEF.md'), '# Tell prof@school.example.com and ta@school.example.com\n');
  assert.equal((await run(custom)).launches.length, 1, 'recipients are this workstream\'s people');
  await writeFile(join(custom.directoryPath, 'task_1', 'SYLLABUS.txt'), 'Course assistants: ca-one@school.example.com, ca-two@school.example.com\n');
  await writeFile(join(custom.directoryPath, 'task_1', 'REPLY.json'), JSON.stringify({ to: 'prof@school.example.com', account: ME, original: { from: 'prof@school.example.com', messageId: '<CA+abc123@mail.gmail.example.com>' } }));
  assert.equal((await run(custom)).launches.length, 1, 'the syllabus names course staff; a message id is not a person');
  await writeFile(join(custom.directoryPath, 'task_1', 'DRAFT.md'), `Hi, cc ${STRANGER}\n`);
  assert.equal((await run(custom)).state.kind, 'privacy-stop', 'what the agent wrote is still checked');
  // A phone number no thread of this workstream carries is a stranger too (chats name people by number); rules.md
  // is the user's own and is copied as it is, so a number written there is in reach.
  await writeFile(join(h.voiceDirectory, 'rules.md'), '# Your rules\n\n- call +1 555 010 0199 back\n');
  const phone = await run(h);
  assert.deepEqual([phone.launches.length, phone.state.kind], [0, 'privacy-stop']);
  assert.match(phone.state.question, /rules\.md \(1 phone number\)/);
});

test('E6: every cloud path goes through the gate: the request is made only after it, and nothing else spawns a drafter', async () => {
  const headless = await readFile(new URL('../src/hikyaku/headless.js', import.meta.url), 'utf8');
  assert.match(headless, /gateImpl = cloudGate/, 'the gate is the default, not an option a caller must remember');
  const gateAt = headless.indexOf('await gateImpl(');
  assert.ok(gateAt > 0, 'startHeadless calls the gate');
  assert.ok(gateAt < headless.indexOf("'CALENDAR.md'"), 'the gate runs before CALENDAR.md is written');
  assert.ok(gateAt < headless.indexOf("spawn('nebius'"), 'the gate runs before the request');
  assert.doesNotMatch(headless, /node:child_process/, 'headless.js starts no process');
  const { readdir } = await import('node:fs/promises');
  const sources = [];
  for (const dir of ['../src/hikyaku', '../desktop', '../bin']) {
    for (const name of await readdir(new URL(dir, import.meta.url))) if (name.endsWith('.js')) sources.push([`${dir}/${name}`, await readFile(new URL(`${dir}/${name}`, import.meta.url), 'utf8')]);
  }
  const launchers = sources.filter(([file, text]) => /agent(?:Args|Binary)\(/.test(text.replace(/\/\/.*$/gm, ''))).map(([file]) => file);
  assert.deepEqual(launchers.sort(), [], 'a new launcher outside startHeadless would bypass the gate');
  assert.doesNotMatch(sources.find(([file]) => file.endsWith('doctor.js'))[1].replace(/\/\/.*$/gm, ''), /spawn|execFile\(path|agent(?:Args|Binary)/, 'the doctor starts nothing');
});

test('E7: a permitted run writes SENT.json: agent, time, every readable file with bytes and sha256, and the exact prompt', async () => {
  const { createHash } = await import('node:crypto');
  const h = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }] });
  const { launches, state } = await run(h, { calendarText: async () => 'calendar text' });
  assert.equal(launches.length, 1);
  assert.equal(state.phase, 'in-mail-app');
  const sent = JSON.parse(await readFile(join(h.directoryPath, 'task_1', 'SENT.json'), 'utf8'));
  assert.equal(sent.agent, 'nebius');
  assert.match(sent.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(sent.workstream, 'Acme');
  const paths = sent.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ['CONTEXT.md', 'task_1/BRIEF.md', 'task_1/CALENDAR.md', 'task_1/THREAD.md', 'voice/intros.md', 'voice/recent.md'].sort(), 'the room: this move\'s files and this workstream\'s voice, nothing else (REPLY.json is hikyaku\'s, not the agent\'s)');
  assert.equal(launches[0].options.cwd, join(h.root, 'work', '.runs', 'task_1'), 'the run reads the room, not the workstream folder');
  const thread = sent.files.find((file) => file.path === 'task_1/THREAD.md');
  const bytes = await readFile(join(h.directoryPath, 'task_1', 'THREAD.md'));
  assert.deepEqual([thread.bytes, thread.sha256], [bytes.length, createHash('sha256').update(bytes).digest('hex')]);
  assert.equal(sent.prompt, launches[0].args.at(-1), 'the prompt as sent');
  assert.ok(sent.files.every((file) => !file.path.startsWith('/')), 'paths are relative to the workstream, never absolute');
});

test('setting an approval: loggie cloud <workstream> <nebius|off> writes the field and lists it; Chats lives in settings.json', async () => {
  const { listCloud, setCloud } = await import('../src/hikyaku/cloud.js');
  const h = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [] }, { name: 'Globex', kind: 'company', domains: [], words: [] }], settings: { mailApp: 'gmail', chats: ['messages'] } });
  assert.deepEqual((await listCloud(h.root)).map((item) => [item.name, item.cloud]), [['Acme', 'off'], ['Globex', 'off'], ['Chats', 'off']]);
  await setCloud(h.root, 'Acme', 'nebius');
  await setCloud(h.root, 'Chats', 'nebius');
  assert.deepEqual((await listCloud(h.root)).map((item) => [item.name, item.cloud]), [['Acme', 'nebius'], ['Globex', 'off'], ['Chats', 'nebius']]);
  assert.equal(JSON.parse(await readFile(join(h.root, 'workstreams.json'), 'utf8'))[0].cloud, 'nebius');
  assert.equal(JSON.parse(await readFile(join(h.root, 'settings.json'), 'utf8')).chatsCloud, 'nebius');
  await setCloud(h.root, 'Acme', 'off');
  assert.equal('cloud' in JSON.parse(await readFile(join(h.root, 'workstreams.json'), 'utf8'))[0], false, 'off removes the field');
  await assert.rejects(setCloud(h.root, 'Nope', 'nebius'), /No workspace named "Nope"/);
  for (const value of ['claude', 'agy', 'codex', 'gpt']) {
    await assert.rejects(setCloud(h.root, 'Acme', value), new RegExp(`The approval must be nebius or off, not "${value}"\\.`), value);
    await assert.rejects(setCloud(h.root, 'Chats', value), /must be nebius or off/, value);
  }
  assert.equal('cloud' in JSON.parse(await readFile(join(h.root, 'workstreams.json'), 'utf8'))[0], false, 'a refused value writes nothing');
  assert.equal(JSON.parse(await readFile(join(h.root, 'settings.json'), 'utf8')).chatsCloud, 'nebius');
});

test('E10, the room: a run sees only its own move; other tasks, old logs and old events in the folder are out of reach, and what the agent writes comes back', async () => {
  const h = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }] });
  // Another move in the same workstream names a stranger, and this task has an old event and an attempt log with one.
  await mkdir(join(h.directoryPath, 'task_2'));
  await writeFile(join(h.directoryPath, 'task_2', 'THREAD.md'), `# Other\n\n## Pat <${STRANGER}> · 2026-10-05T12:00:00.000Z\n\nhello\n`);
  await writeFile(join(h.directoryPath, 'task_1', 'EVENT.json'), JSON.stringify({ title: 'Readout', attendees: [STRANGER] }));
  await writeFile(join(h.directoryPath, 'task_1', 'ATTEMPTS.jsonl'), `${JSON.stringify({ mode: 'event', detail: `with ${STRANGER}` })}\n`);
  await writeFile(join(h.directoryPath, 'task_1', 'NOTES.md'), 'The user says: Friday works.\n');
  // Old, as they would be: written by an earlier run, not this one.
  const { utimes } = await import('node:fs/promises');
  const yesterday = new Date(Date.now() - 86400000);
  for (const name of ['EVENT.json', 'ATTEMPTS.jsonl']) await utimes(join(h.directoryPath, 'task_1', name), yesterday, yesterday);
  const { launches, state } = await run(h, { calendarText: async () => 'cal' });
  assert.equal(launches.length, 1, 'nothing outside the move can stop it');
  assert.equal(state.phase, 'in-mail-app');
  const room = launches[0].options.cwd;
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(join(room, 'task_1'))).sort(), ['BRIEF.md', 'CALENDAR.md', 'DRAFT.md', 'NOTES.md', 'THREAD.md'], 'the room holds the brief, the thread, the notes, the calendar, and the draft the agent wrote');
  assert.deepEqual(await readdir(room), ['CONTEXT.md', 'task_1'], 'no other task is in the room');
  assert.match(await readFile(join(room, 'CONTEXT.md'), 'utf8'), /Waiting on the deck/, 'an email move gets the workstream summary');
  assert.equal(await readFile(join(h.directoryPath, 'task_1', 'DRAFT.md'), 'utf8'), 'Hi Sam,\n\nSure.\n\nBest regards,', 'the draft came back to the task folder');
  const sent = JSON.parse(await readFile(join(h.directoryPath, 'task_1', 'SENT.json'), 'utf8'));
  assert.ok(!sent.files.some((file) => /task_2|EVENT|ATTEMPTS/.test(file.path)), 'the receipt lists the room only');
  // A chat move: the Chats workstream is every chat, so its CONTEXT.md is replaced by one line and the summary never goes.
  const chat = await home({ workstreams: [], settings: { mailApp: 'gmail', chats: ['messages'], chatsCloud: 'nebius' } });
  const chatsDirectory = join(chat.root, 'work', 'chats');
  await mkdir(join(chatsDirectory, 'task_1'), { recursive: true });
  await writeFile(join(chatsDirectory, 'CONTEXT.md'), '# Chats\n\nFourteen chats, +1 555 010 0101 and +1 555 010 0102 wait on you.\n');
  await writeFile(join(chatsDirectory, 'task_1', 'THREAD.md'), '# +15550100\n\n## +15550100 · 2026-10-05T14:00:00.000Z\n\ncan you add the budget slide?\n');
  await writeFile(join(chatsDirectory, 'task_1', 'BRIEF.md'), '# Reply about the budget slide\n');
  await writeFile(join(chatsDirectory, 'task_1', 'REPLY.json'), JSON.stringify({ app: 'messages', chatId: '12', address: '+15550100', to: '+15550100', isGroup: false }));
  const core = fakeCore(); const s = spy();
  const started = await startHeadless({ core, task: { id: 'task_1', status: 'briefed', sourceType: 'messages' }, directoryPath: chatsDirectory, voiceDirectory: chat.voiceDirectory, home: chat.root, spawnImpl: s.spawnImpl, openDraftImpl: async () => ({ opened: 'messages', mode: 'chat', detail: 'stub' }) });
  await started.done;
  assert.equal(s.launches.length, 1, 'the other chats\' numbers in CONTEXT.md never reach the gate or the run');
  const context = await readFile(join(s.launches[0].options.cwd, 'CONTEXT.md'), 'utf8');
  assert.match(context, /This move is one chat/); assert.doesNotMatch(context, /555/);
  // A question the run writes in the room reaches the task folder, so the answer flow finds it.
  const asking = await home({ workstreams: [{ name: 'Acme', kind: 'company', domains: [], words: [], cloud: 'nebius' }] });
  const ask = spy();
  ask.spawnImpl = (bin, args, options) => { const child = spy().spawnImpl(bin, args, options); setImmediate(() => writeFile(join(options.cwd, 'task_1', 'NEEDS.md'), 'Which Friday?')); return child; };
  const q = await startHeadless({ core: fakeCore(), task: { id: 'task_1', status: 'briefed' }, directoryPath: asking.directoryPath, voiceDirectory: asking.voiceDirectory, home: asking.root, spawnImpl: ask.spawnImpl, openDraftImpl: async () => ({ mode: 'reply' }) });
  const qs = await q.done;
  assert.deepEqual([qs.phase, qs.kind], ['needs-you', 'question']);
  assert.equal(await readFile(join(asking.directoryPath, 'task_1', 'NEEDS.md'), 'utf8'), 'Which Friday?');
});

test('a run that writes nothing new never brings the old draft back as fresh; a changed or new file does come back', async () => {
  const { buildRoom, collectRoom, roomFor } = await import('../src/hikyaku/cloud.js');
  const { mkdtemp, mkdir: makeDir, readFile: read, stat: statOf, utimes, writeFile: write } = await import('node:fs/promises');
  const { tmpdir: temp } = await import('node:os');
  const root = await mkdtemp(join(temp(), 'hikyaku-room-'));
  const directoryPath = join(root, 'work', 'acme');
  await makeDir(join(directoryPath, 'task_1'), { recursive: true });
  await write(join(directoryPath, 'task_1', 'DRAFT.md'), 'Hi Sam,\n\nOld draft.\n');
  const old = new Date(Date.now() - 3600000);
  await utimes(join(directoryPath, 'task_1', 'DRAFT.md'), old, old);
  await buildRoom({ directoryPath, taskId: 'task_1' });
  assert.deepEqual(await collectRoom({ directoryPath, taskId: 'task_1' }), [], 'nothing changed, nothing comes back');
  assert.ok((await statOf(join(directoryPath, 'task_1', 'DRAFT.md'))).mtimeMs < Date.now() - 60000, 'the old draft keeps its old time, so it is not read as written this run');
  const roomTask = join(roomFor(directoryPath, 'task_1'), 'task_1');
  await write(join(roomTask, 'NEEDS.md'), 'Which Thursday?');
  await write(join(roomTask, 'DRAFT.md'), 'Hi Sam,\n\nNew draft.\n');
  assert.deepEqual((await collectRoom({ directoryPath, taskId: 'task_1' })).sort(), ['DRAFT.md', 'NEEDS.md']);
  assert.equal(await read(join(directoryPath, 'task_1', 'DRAFT.md'), 'utf8'), 'Hi Sam,\n\nNew draft.\n');
});

test('a workstream outside hikyaku\'s work folder never gets a voice copy written into the voice folder', async () => {
  const { voiceForWorkstream } = await import('../src/hikyaku/cloud.js');
  const { mkdtemp, mkdir: makeDir, readdir: list, writeFile: write } = await import('node:fs/promises');
  const { tmpdir: temp } = await import('node:os');
  const home = await mkdtemp(join(temp(), 'hikyaku-voicehome-'));
  const shared = join(home, 'voice');
  await makeDir(shared, { recursive: true }); await write(join(shared, 'rules.md'), 'rule');
  const elsewhere = await mkdtemp(join(temp(), 'hikyaku-headless-'));
  assert.equal(await voiceForWorkstream({ home, directoryPath: elsewhere, shared }), shared);
  assert.deepEqual(await list(shared), ['rules.md'], 'nothing written for a folder outside work/');
  const inside = join(home, 'work', 'acme');
  await makeDir(inside, { recursive: true });
  assert.equal(await voiceForWorkstream({ home, directoryPath: inside, shared }), join(shared, 'by-workstream', 'acme'));
});
