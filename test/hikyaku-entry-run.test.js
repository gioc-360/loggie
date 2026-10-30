// The entry run (spec-entry-b.md increment 5, section 6): one run joins a call and a week of mail into workstreams and
// prepares their next-move sends, ready for approval. Nothing is sent. Everything here is made up: the mail is a
// fixture, the catch-up's local model is a fake `complete`, the privacy screen is a fake runner, Core is the real
// domain in memory (so every status change goes through the real transition rules), and fetch is a trap. No network,
// no keychain, no model server, no mail app, and never the real Loggie folder: the CLI test runs with HOME set to a
// temporary folder, so even the "real" folder it guards is a made-up one.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCoreDatabase } from '../src/core/database.js';
import * as entry from '../src/hikyaku/entry.js';
import { entryRun, guardDataRoots, matchCall } from '../src/hikyaku/entry.js';
import { approveSend, pendingSends, readEvents, runsRoot } from '../src/hikyaku/send-gate.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { cardTop, pickMove, snoozedUntil } from '../src/hikyaku/pick.js';
import { filesUnder } from './helpers/files.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NAMES_A_MODEL = /nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm/i;
const TRANSCRIBER = '/fake/transcriber/spike';
const TODAY = '2026-10-06';
const SINCE = '2026-09-29';
const HELD_LINE = 'I have a knee scan at the clinic on Thursday morning.';
const CALL_HELD = 'My rent went up again this month.';

// --- made-up mail, in the Gmail Thread shape catch-up reads (spec B3)
const message = (id, threadId, from, to, timestamp, body) => ({ id, threadId, messageId: `<${id}@example>`, from, to, cc: '', subject: '', timestamp, body, snippet: body.slice(0, 60), labels: [], attachments: [], rawLinks: [] });
const thread = (id, subject, messages) => ({ id, historyId: '1', subject, snippet: '', latestTimestamp: messages.at(-1).timestamp, participants: [], messages: messages.map((item) => ({ ...item, subject })) });
const MAIL = [
  thread('t-acme-1', 'Outline for the kickoff', [
    message('m1', 't-acme-1', 'Lena Park <lena@example.com>', 'dana@acme.example', '2026-10-01T10:00:00Z', 'Happy to help with the kickoff.'),
    message('m2', 't-acme-1', 'Dana Reyes <dana@acme.example>', 'lena@example.com', '2026-10-03T14:00:00Z', `Can you send the outline by Friday? ${HELD_LINE} Let me know which day works.`),
  ]),
  // Before the window: never read.
  thread('t-acme-old', 'Last spring', [message('m3', 't-acme-old', 'Dana Reyes <dana@acme.example>', 'lena@example.com', '2026-04-01T09:00:00Z', 'Can you send the old deck again?')]),
  thread('t-river-1', 'Grant draft', [message('m4', 't-river-1', 'Omar Haddad <omar@riverside.example>', 'lena@example.com', '2026-10-04T09:00:00Z', 'Could you review the grant budget section this week?')]),
  // Book Club's only thread is old, so Book Club has no open move and gets no send.
  thread('t-books-old', 'September pick', [message('m5', 't-books-old', 'Ines Mora <ines@books.example>', 'lena@example.com', '2026-08-20T09:00:00Z', 'What did you think of the September pick?')]),
];
const WORKSTREAMS = [
  { name: 'Acme Bank', kind: 'company', goal: 'Get an offer', domains: ['acme.example'], words: [] },
  { name: 'Riverside Lab', kind: 'other', goal: 'Get it done', domains: ['riverside.example'], words: ['grant'] },
  { name: 'Book Club', kind: 'other', goal: 'Get it done', domains: ['books.example'], words: [] },
];

// The catch-up's local model, faked: one reply move on thread 1 of whatever workstream it is asked about.
const QUOTES = { 'Acme Bank': 'Can you send the outline by Friday?', 'Riverside Lab': 'Could you review the grant budget section this week?' };
function fakeLocal(prompts = []) {
  return async (prompt) => {
    prompts.push(prompt);
    const name = /<threads workstream="([^"]+)">/.exec(prompt)[1];
    return JSON.stringify({ summary: `${name} is moving.`, promised: [], open: [], actions: [{ title: `Answer the ${name} thread`, kind: 'reply', thread: 1, due: null, quote: QUOTES[name] || '', steps: [] }] });
  };
}

// The privacy screen, faked the way the real CLI writes: a thread (--thread THREAD.md --out DIR) gets OUTBOUND.md +
// HELD.json with addresses and To: lines gone and the clinic line kept; a call folder gets outbound.md + held.json.
function fakeScreen(calls = []) {
  return async (command, args) => {
    calls.push({ command, args });
    if (!String(args[0]).endsWith('privacy.py')) throw new Error(`only the screen may run here, not ${args[0]}`);
    if (args[1] === '--thread') {
      const md = await readFile(args[2], 'utf8');
      const out = args[args.indexOf('--out') + 1];
      const kept = md.includes(HELD_LINE) ? 1 : 0;
      const text = md.split('\n').filter((line) => !line.startsWith('To:')).map((line) => line.replace(/ <[^>]+>/g, '').replace(HELD_LINE, '[health kept on this Mac]')).join('\n');
      await writeFile(join(out, 'OUTBOUND.md'), text.replace(/\n/, '\n\n_Screened on this Mac by local-test: see HELD.json._\n'));
      await writeFile(join(out, 'HELD.json'), JSON.stringify({ source: 'thread', counts: { sentences: 4, sent: 4 - kept, held: kept, turns: 2, turns_fully_held: 0, layer: { code: 0, model: kept, unchecked: 0 }, category: kept ? { health: 1 } : {} },
        held: kept ? [{ i: 2, time: '2026-10-03T14:00:00Z', speaker: 'Dana Reyes', category: 'health', layer: 'model', rule: null, text: HELD_LINE }] : [] }));
      return { code: 0, stdout: '', stderr: '' };
    }
    const folder = args[1];
    const transcript = await readFile(join(folder, 'transcript.md'), 'utf8');
    await writeFile(join(folder, 'outbound.md'), transcript.replace(CALL_HELD, '[money kept on this Mac]'));
    await writeFile(join(folder, 'held.json'), JSON.stringify({ counts: { sentences: 3, sent: 2, held: 1, turns: 2, turns_fully_held: 0, layer: { code: 1, model: 0, unchecked: 0 }, category: { money: 1 } },
      held: [{ i: 1, time: '00:10', speaker: 'Lena', category: 'money', layer: 'code', rule: 'rent', text: CALL_HELD }] }));
    return { code: 0, stdout: '', stderr: '' };
  };
}

// The real Core domain, in memory, behind the client's async shape (src/core/client.js).
function memoryCore() {
  const db = createCoreDatabase();
  const notFound = (value) => { if (!value) throw Object.assign(new Error('Brief was not found.'), { status: 404 }); return value; };
  return {
    db,
    listProjects: async () => db.listProjects(), getProject: async (id) => db.getProject(id), createProject: async (input) => db.createProject(input),
    listTasks: async (filters) => db.listTasks(filters), getTask: async (id) => db.getTask(id), createTask: async (input) => db.createTask(input),
    createBrief: async (id, input) => db.createBrief(id, input), approveBrief: async (id) => db.approveBrief(id),
    getApprovedBrief: async (id) => notFound(db.getApprovedBriefForTask(id)), getLatestBrief: async (id) => notFound(db.getLatestBriefForTask(id)),
    transitionTask: async (id, to, reason) => db.transitionTask(id, to, reason),
  };
}

async function callFolder(root, name, event) {
  const folder = join(root, 'calls', name, 'v1');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify(event));
  await writeFile(join(folder, 'transcript.md'), `# ${event.title}\n\n[00:02] Lena: Thanks for making time today.\n\n[00:10] Lena: ${CALL_HELD} Anyway, the outline is nearly done.\n`);
  return folder;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-entry-'));
  const home = join(root, 'hikyaku');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'workstreams.json'), JSON.stringify(WORKSTREAMS, null, 2));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ frontier: 'nebius', signName: 'Lena Park' }));
  const matched = await callFolder(root, '2026-10-05-1000-acme-sync', { title: 'Acme sync', start: '2026-10-05T10:00:00-04:00', emails: ['dana@acme.example'], names: 'Dana Reyes', me: 'Lena', workstream: 'none' });
  const unmatched = await callFolder(root, '2026-10-05-1500-coffee-with-priya', { title: 'Coffee with Priya', start: '2026-10-05T15:00:00-04:00', emails: ['priya@elsewhere.example'], names: 'Priya Shah', me: 'Lena', workstream: 'none' });
  return { root, home, core: memoryCore(), matched, unmatched };
}

// One entry run with every fake in place, and fetch trapped for its whole length.
async function run(h, { calls = [h.matched, h.unmatched], screens = [], prompts = [] } = {}) {
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('no network in the entry run'); };
  try {
    const result = await entryRun({ home: h.home, core: h.core, since: SINCE, mail: MAIL, calls, complete: fakeLocal(prompts), transcriber: TRANSCRIBER, runner: fakeScreen(screens),
      me: 'Lena Park', ownAddress: 'lena@example.com', today: TODAY });
    return { result, fetches };
  } finally { globalThis.fetch = realFetch; }
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('catch-up prepares one pending next-move send per workstream with an open move, and sends nothing', async () => {
  const h = await setup();
  const screens = [], prompts = [];
  const { result, fetches } = await run(h, { calls: [], screens, prompts });
  assert.equal(fetches.length, 0, 'nothing reached the network');
  assert.ok(screens.every((item) => item.args[0].endsWith('privacy.py')), 'only the screen ran; no send command');
  assert.equal(prompts.length, 2, 'the catch-up read the two workstreams with mail in the window, not Book Club');
  assert.ok(!prompts.join('\n').includes('old deck'), 'mail before --since is not read');

  const sends = (await pendingSends(h.home)).filter((send) => send.what === 'next-move');
  assert.deepEqual(sends.map((send) => send.workstream).sort(), ['Acme Bank', 'Riverside Lab']);
  assert.deepEqual(result.sends.map((send) => send.run).sort(), sends.map((send) => send.run).sort());
  for (const send of sends) {
    assert.equal(send.status, 'pending');
    for (const [index, path] of send.outbound.entries()) assert.equal(sha(await readFile(path)), send.sha256[index], 'the review hash is the file on disk');
  }
  const acme = sends.find((send) => send.workstream === 'Acme Bank');
  assert.deepEqual(acme.source_ids, ['t-acme-1']);
  assert.equal(acme.sentences_kept, 1, 'the clinic line is counted as kept');
  const outbound = await readFile(acme.outbound[0], 'utf8');
  assert.ok(!outbound.includes(HELD_LINE) && !outbound.includes('@'), 'the screened file holds no kept line and no address');

  // Nothing went: no receipt, no move, no send marked sent, anywhere under the home.
  const files = await filesUnder(h.home);
  assert.ok(!files.some((file) => /SENT\.json$|MOVE\.json$/.test(file)), files.filter((file) => /SENT|MOVE/.test(file)).join(', '));

  // The run's own events: started, steps, finished; no text names a model.
  const events = await readEvents(join(runsRoot(h.home), result.run));
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'run.started'); assert.equal(types.at(-1), 'run.finished');
  for (const type of ['step.started', 'step.progress', 'step.finished']) assert.ok(types.includes(type), type);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).data.sends, 2); assert.equal(events.at(-1).data.ok, true);
  for (const send of sends) for (const event of await readEvents(join(runsRoot(h.home), send.run))) {
    if (event.text) assert.doesNotMatch(event.text, NAMES_A_MODEL, `${event.type}: ${event.text}`);
  }
  for (const event of events) if (event.text) assert.doesNotMatch(event.text, NAMES_A_MODEL, `${event.type}: ${event.text}`);

  // A second run replaces the first one's pending sends: still one per workstream.
  await run(h, { calls: [] });
  const again = (await pendingSends(h.home)).filter((send) => send.what === 'next-move');
  assert.deepEqual(again.map((send) => send.workstream).sort(), ['Acme Bank', 'Riverside Lab']);
});

test('a call joins the workstream its invitees match, and its screened lines join that next-move send', async () => {
  const h = await setup();
  assert.equal(matchCall({ title: 'Acme sync', emails: ['dana@acme.example'], workstream: 'none' }, WORKSTREAMS)?.name, 'Acme Bank');
  assert.equal(matchCall({ title: 'Grant check-in', emails: [], workstream: 'none' }, WORKSTREAMS)?.name, 'Riverside Lab', 'a workstream word in the title');
  assert.equal(matchCall({ title: 'Anything', emails: [], workstream: 'Book Club' }, WORKSTREAMS)?.name, 'Book Club', 'a workstream named on the call wins');
  assert.equal(matchCall({ title: 'Coffee', emails: ['lena@example.com', 'priya@elsewhere.example'], workstream: 'none' }, WORKSTREAMS, { ownAddress: 'lena@example.com' }), null);

  await run(h, { calls: [h.matched] });
  const acme = (await pendingSends(h.home)).find((send) => send.workstream === 'Acme Bank');
  assert.deepEqual(acme.source_ids, ['t-acme-1', 'call:2026-10-05-1000-acme-sync']);
  const callOut = acme.outbound[1];
  assert.ok(callOut.startsWith(join(h.home, 'work', 'acme-bank')), 'the call outbound is copied into the workstream');
  const text = await readFile(callOut, 'utf8');
  assert.ok(text.includes('the outline is nearly done') && !text.includes(CALL_HELD), 'screened call lines, without the kept one');
  assert.equal(acme.sentences_kept, 2, 'one kept line from the thread, one from the call');
  assert.equal(acme.sentences_sent, 3 + 2);
  assert.equal(acme.sources['call:2026-10-05-1000-acme-sync'], null, 'a call has no mailbox');
  assert.ok(acme.held.some((path) => path.endsWith('held.json')), 'the call held file is listed for the gate, never sent');
  const riverside = (await pendingSends(h.home)).find((send) => send.workstream === 'Riverside Lab');
  assert.ok(!riverside.source_ids.some((id) => id.startsWith('call:')), 'the call joins only its own workstream');
});

test('a call no workstream matches gets a pending send that says so and offers a new workstream', async () => {
  const h = await setup();
  const { result, fetches } = await run(h, { calls: [h.unmatched] });
  assert.equal(fetches.length, 0);
  const none = (await pendingSends(h.home)).filter((send) => send.what === 'next-move' && !send.workstream);
  assert.equal(none.length, 1);
  const [send] = none;
  assert.deepEqual(send.source_ids, ['call:2026-10-05-1500-coffee-with-priya']);
  assert.equal(send.status, 'pending');
  assert.match(send.title, /no workspace/i);
  assert.equal(send.offer.new_workstream.name, 'Coffee with Priya');
  assert.deepEqual(send.offer.new_workstream.domains, ['elsewhere.example']);
  assert.deepEqual(send.offer.existing, ['Acme Bank', 'Riverside Lab', 'Book Club']);
  assert.ok(result.sends.some((item) => item.run === send.run));
  // It cannot be sent until it has a workstream: the gate refuses, and nothing changes.
  await assert.rejects(approveSend({ home: h.home, run: send.run, provider: 'nebius', checks: { nebius: async () => true }, transcriber: TRANSCRIBER, nextMove: async () => { throw new Error('must not run'); } }), /no workspace/i);
  assert.equal(JSON.parse(await readFile(join(runsRoot(h.home), send.run, 'send.json'), 'utf8')).status, 'pending');
  const offer = (await readEvents(join(runsRoot(h.home), result.run))).find((event) => event.type === 'workstream.offer');
  assert.ok(offer, 'the run tells the card a new workstream is on offer');
  assert.doesNotMatch(offer.text, NAMES_A_MODEL);
});

test('the entry run refuses the real Loggie folder unless --real is passed', async () => {
  const realRoot = '/Users/someone/Library/Application Support/Loggie';
  const refuse = (roots) => assert.throws(() => guardDataRoots({ ...roots, realRoot }), /real Loggie/);
  refuse({ home: `${realRoot}/hikyaku`, coreDirectory: '/tmp/x/core' });
  refuse({ home: '/tmp/x/hikyaku', coreDirectory: `${realRoot}/core` });
  refuse({ home: '/tmp/x/hikyaku', coreDirectory: '/tmp/x/core', calls: [`${realRoot}/hikyaku/calls/a/v1`] });
  refuse({ home: `${realRoot}/hikyaku/../hikyaku`, coreDirectory: '/tmp/x/core' });
  assert.doesNotThrow(() => guardDataRoots({ home: `${realRoot}-entry/runs/r/hikyaku`, coreDirectory: `${realRoot}-entry/runs/r/core`, realRoot }), 'the sibling run folder is not the real one');
  assert.doesNotThrow(() => guardDataRoots({ home: `${realRoot}/hikyaku`, coreDirectory: `${realRoot}/core`, real: true, realRoot }));

  // The command itself, with HOME pointed at a made-up folder so its "real" folder is made up too.
  const fakeHome = await mkdtemp(join(tmpdir(), 'hikyaku-entry-home-'));
  const env = { PATH: process.env.PATH, HOME: fakeHome, LOGGIE_TUI: '1', HIKYAKU_TRANSCRIBER: '/nonexistent', HIKYAKU_MODEL_URL: 'http://127.0.0.1:9/' };
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'loggie.js'), 'entry', 'run', ...args], { env, encoding: 'utf8', timeout: 30000 });
  const plain = cli(['--since', SINCE]);
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  assert.match(plain.stderr, /real Loggie/);
  assert.match(plain.stderr, /--real/);
  const viaCore = cli(['--since', SINCE, '--home', join(fakeHome, 'entry', 'hikyaku'), '--core', join(fakeHome, 'Library', 'Application Support', 'Loggie', 'core')]);
  assert.equal(viaCore.status, 2, viaCore.stdout + viaCore.stderr);
  assert.deepEqual(await readdir(fakeHome), [], 'a refusal writes nothing');
  const noSince = cli(['--home', join(fakeHome, 'entry', 'hikyaku')]);
  assert.equal(noSince.status, 2);
  assert.match(noSince.stderr, /--since/);
});

test('skipped and handled elsewhere close the task through legal steps; snooze hides the move until its time', async () => {
  const h = await setup();
  await run(h, { calls: [] });
  const projects = await h.core.listProjects();
  const tasks = await h.core.listTasks();
  assert.equal(tasks.length, 2);
  const folderOf = (task) => join(projects.find((project) => project.id === task.projectId).directoryPath, task.id);
  const writeMove = async (task, kind = 'read') => writeFile(join(folderOf(task), 'MOVE.json'), JSON.stringify({ move_id: `${task.id}#1`, task_id: task.id, kind, why: [], drafts: [], slots: [], steps: [], quote: '' }));
  const [first, second] = tasks;
  await writeMove(first); await writeMove(second);
  assert.equal(first.status, 'waiting');

  const now = () => new Date(`${TODAY}T12:00:00Z`);
  const skipped = await pickMove({ home: h.home, taskDirectory: folderOf(first), choice: { type: 'skipped' }, core: h.core, now });
  assert.equal(skipped.choice.type, 'skipped');
  assert.equal((await h.core.getTask(first.id)).status, 'done');
  const path = (id) => h.core.db.listEvents({ after: 0 }).filter((event) => event.type === 'task.status_changed' && event.entityId === id).map((event) => `${event.payload.from}>${event.payload.to}`);
  assert.deepEqual(path(first.id), ['waiting>briefed', 'briefed>running', 'running>done']);

  // Handled elsewhere on a task already in progress: only the steps still needed.
  await h.core.createBrief(second.id, { objective: 'x', context: 'y' }).then((brief) => h.core.approveBrief(brief.id));
  await h.core.transitionTask(second.id, 'briefed', 'test'); await h.core.transitionTask(second.id, 'running', 'test');
  await pickMove({ home: h.home, taskDirectory: folderOf(second), choice: { type: 'handled_elsewhere' }, core: h.core, now });
  assert.equal((await h.core.getTask(second.id)).status, 'done');
  assert.deepEqual(path(second.id), ['waiting>briefed', 'briefed>running', 'running>done']);
  const signals = (await readFile(join(folderOf(second), 'SIGNALS.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(signals.at(-1).choice.type, 'handled_elsewhere');

  // Snooze: a third move, hidden on the card until its time, then back.
  const [project] = projects;
  const third = await h.core.createTask({ projectId: project.id, title: 'Third', description: 'Third move', sourceType: 'gmail', sourceId: 't-x:reply' });
  const fourth = await h.core.createTask({ projectId: project.id, title: 'Fourth', description: 'Fourth move', sourceType: 'gmail', sourceId: 't-y:reply' });
  for (const task of [third, fourth]) { await mkdir(folderOf(task), { recursive: true }); await writeMove(task, 'wait'); }
  const until = `${TODAY}T18:00:00.000Z`;
  await pickMove({ home: h.home, taskDirectory: folderOf(third), choice: { type: 'snooze', until }, core: h.core, now });
  assert.equal((await h.core.getTask(third.id)).status, 'waiting', 'snooze leaves the task open');
  assert.equal(await snoozedUntil(folderOf(third), now()), until);
  const card = (at) => cardTop({ tasks: [third, fourth], directory: project.directoryPath, now: new Date(at) });
  const before = await card(`${TODAY}T17:59:00Z`);
  assert.equal(before.top.id, fourth.id, 'the snoozed move is hidden; the next one shows');
  assert.equal(before.snoozed, 1);
  const after = await card(`${TODAY}T18:01:00Z`);
  assert.equal(after.top.id, third.id, 'after its time the move is back');
  assert.equal(after.snoozed, 0);
  assert.equal(await snoozedUntil(folderOf(third), new Date(`${TODAY}T18:01:00Z`)), null);
  // A new move on the same task is not hidden by the old move's snooze.
  await writeFile(join(folderOf(third), 'MOVE.json'), JSON.stringify({ move_id: `${third.id}#2`, task_id: third.id, kind: 'wait', why: [], drafts: [], slots: [], steps: [], quote: '' }));
  assert.equal(await snoozedUntil(folderOf(third), now()), null);
});

// --- "New workstream?" (mock e screen 3): a call no workstream matched is started as a new workstream or put under one
// of the user's, and its pending send becomes sendable. Neither action sends anything.
const COFFEE = 'call:2026-10-05-1500-coffee-with-priya';
const readSendOf = async (h, run) => JSON.parse(await readFile(join(runsRoot(h.home), run, 'send.json'), 'utf8'));
const offerOf = async (h) => (await pendingSends(h.home)).find((send) => send.what === 'next-move' && !send.workstream);
const notConnected = { nebius: async () => false };
// With every AI off, the gate goes as far as the connection check: a refusal there means the workstream check passed.
const gateReason = async (h, run) => {
  try { await approveSend({ home: h.home, run, provider: 'nebius', checks: notConnected, transcriber: TRANSCRIBER, nextMove: async () => { throw new Error('must not run'); } }); }
  catch (error) { return error.message; }
  return 'the gate did not refuse';
};
async function trapped(fn) {
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('no network'); };
  try { return { value: await fn(), fetches }; } finally { globalThis.fetch = realFetch; }
}
async function nothingWent(h) {
  const files = await filesUnder(h.home);
  assert.ok(!files.some((file) => /SENT\.json$|MOVE\.json$/.test(file)), files.filter((file) => /SENT|MOVE/.test(file)).join(', '));
  for (const send of await pendingSends(h.home)) assert.notEqual(send.status, 'sent');
}

test('Start it: the call becomes a new workstream in workstreams.json and its send becomes sendable; nothing is sent', async () => {
  const h = await setup();
  await run(h, { calls: [h.unmatched] });
  const offer = await offerOf(h);
  assert.match(await gateReason(h, offer.run), /no workspace/i, 'before: the gate refuses it');
  const screens = [];
  const { value: started, fetches } = await trapped(() => entry.startWorkstream({ home: h.home, run: offer.run, name: '  Priya intros ', goal: 'Get it done', core: h.core,
    ownAddress: 'lena@example.com', ownNames: ['Lena Park'], runner: async (...args) => { screens.push(args); throw new Error('nothing runs'); } }));
  assert.equal(fetches.length, 0); assert.equal(screens.length, 0, 'no command ran');
  await nothingWent(h);

  // A valid workstream: the shape workstreams.json carries, words from the call title, no cloud approval.
  const list = JSON.parse(await readFile(join(h.home, 'workstreams.json'), 'utf8'));
  assert.equal(list.length, WORKSTREAMS.length + 1);
  const added = list.at(-1);
  assert.deepEqual(Object.keys(added).sort(), ['domains', 'goal', 'kind', 'name', 'words']);
  assert.equal(added.name, 'Priya intros'); assert.equal(added.kind, 'other'); assert.equal(added.goal, 'Get it done');
  assert.deepEqual(added.domains, ['elsewhere.example']);
  assert.deepEqual(added.words, ['Priya'], 'title words: not "with", not "Coffee"');
  assert.ok(!('cloud' in added), 'starting a workstream approves no cloud');
  const read = (await readWorkstreams(h.home)).find((item) => item.name === 'Priya intros');
  assert.equal(read.cloud, 'off'); assert.equal(read.goal, 'Get it done');
  assert.equal(matchCall({ title: 'Coffee with Priya', emails: ['priya@elsewhere.example'], workstream: 'none' }, await readWorkstreams(h.home))?.name, 'Priya intros', 'the next such call matches it');

  // The send moved under it: the offer is superseded, a pending send with the workstream takes its place.
  assert.equal((await readSendOf(h, offer.run)).status, 'superseded');
  assert.equal((await readSendOf(h, offer.run)).superseded_by, started.run);
  const send = await readSendOf(h, started.run);
  assert.equal(send.status, 'pending'); assert.equal(send.workstream, 'Priya intros'); assert.equal(send.what, 'next-move');
  assert.deepEqual(send.source_ids, [COFFEE]); assert.ok(!send.offer);
  assert.ok(send.outbound[0].startsWith(join(h.home, 'work', 'priya-intros', '.outbound')), send.outbound[0]);
  assert.equal(sha(await readFile(send.outbound[0])), offer.sha256[0], 'the reviewed bytes, unchanged');
  assert.deepEqual(send.sha256, offer.sha256);
  assert.equal(send.sentences_sent, offer.sentences_sent); assert.equal(send.sentences_kept, offer.sentences_kept);
  assert.deepEqual((await pendingSends(h.home)).filter((item) => !item.workstream), [], 'no call is left without a workstream');

  // Events: the offer's run says it was placed; no text names a model.
  const placed = (await readEvents(join(runsRoot(h.home), offer.run))).find((event) => event.type === 'workstream.started');
  assert.ok(placed); assert.equal(placed.data.workstream, 'Priya intros'); assert.equal(placed.data.moved_to, started.run); assert.equal(placed.data.source_id, COFFEE);
  for (const dir of [offer.run, started.run]) for (const event of await readEvents(join(runsRoot(h.home), dir))) if (event.text) assert.doesNotMatch(event.text, NAMES_A_MODEL);

  // Sendable now: the gate no longer refuses for "no workstream", and on Send it reaches the next-move step with the call.
  assert.doesNotMatch(await gateReason(h, started.run), /no workspace/i);
  let seen = null;
  const sent = await approveSend({ home: h.home, run: started.run, provider: 'nebius', checks: { nebius: async () => true }, transcriber: TRANSCRIBER,
    nextMove: async ({ send: item }) => { seen = item; return { ok: true }; } });
  assert.equal(sent.ok, true); assert.equal(seen.workstream, 'Priya intros');
  assert.ok(!(await readFile(seen.outbound[0], 'utf8')).includes(CALL_HELD));
});

test('Put it under: the call joins an existing workstream and replaces its older send; workstreams.json is untouched', async () => {
  const h = await setup();
  await run(h, { calls: [h.unmatched] });
  const before = await readFile(join(h.home, 'workstreams.json'), 'utf8');
  const offer = await offerOf(h);
  const acmeOld = (await pendingSends(h.home)).find((send) => send.workstream === 'Acme Bank');
  const { value: filed, fetches } = await trapped(() => entry.fileUnder({ home: h.home, run: offer.run, stream: 'acme bank', core: h.core }));
  assert.equal(fetches.length, 0);
  await nothingWent(h);
  assert.equal(await readFile(join(h.home, 'workstreams.json'), 'utf8'), before);

  const acme = (await pendingSends(h.home)).filter((send) => send.workstream === 'Acme Bank');
  assert.equal(acme.length, 1, 'one send per workstream');
  assert.equal(acme[0].run, filed.run);
  assert.deepEqual(acme[0].source_ids, ['t-acme-1', COFFEE]);
  assert.equal(acme[0].sha256[0], acmeOld.sha256[0], 'the thread keeps the hash it was reviewed with');
  assert.equal(acme[0].sha256[1], offer.sha256[0]);
  assert.equal(acme[0].sentences_sent, acmeOld.sentences_sent + offer.sentences_sent);
  assert.equal(acme[0].sentences_kept, acmeOld.sentences_kept + offer.sentences_kept);
  assert.equal(acme[0].sources['t-acme-1'], acmeOld.sources['t-acme-1']); assert.equal(acme[0].sources[COFFEE], null);
  assert.equal(acme[0].folder, acmeOld.folder);
  assert.ok(acme[0].outbound[1].startsWith(join(acmeOld.folder, '.outbound')));
  const old = await readSendOf(h, acmeOld.run);
  assert.equal(old.status, 'superseded'); assert.equal(old.superseded_by, filed.run);
  assert.equal((await readSendOf(h, offer.run)).status, 'superseded');
  const placed = (await readEvents(join(runsRoot(h.home), offer.run))).find((event) => event.type === 'workstream.filed');
  assert.ok(placed); assert.equal(placed.data.workstream, 'Acme Bank'); assert.doesNotMatch(placed.text, NAMES_A_MODEL);
  assert.doesNotMatch(await gateReason(h, filed.run), /no workspace/i);

  // A workstream with no send waiting gets one with the call alone.
  const h2 = await setup();
  await run(h2, { calls: [h2.unmatched] });
  const book = await entry.fileUnder({ home: h2.home, run: (await offerOf(h2)).run, stream: 'Book Club', core: h2.core });
  const send = await readSendOf(h2, book.run);
  assert.deepEqual(send.source_ids, [COFFEE]); assert.equal(send.workstream, 'Book Club');
  assert.equal(send.folder, join(h2.home, 'work', 'book-club'));
});

test('empty, duplicate and unknown names are refused, and so is anything but an unplaced call; a refusal changes nothing', async () => {
  const h = await setup();
  await run(h, { calls: [h.unmatched] });
  const offer = await offerOf(h);
  const acme = (await pendingSends(h.home)).find((send) => send.workstream === 'Acme Bank');
  const snapshot = async () => JSON.stringify([await readFile(join(h.home, 'workstreams.json'), 'utf8'), await pendingSends(h.home), (await filesUnder(h.home)).sort()]);
  const was = await snapshot();
  const start = (input) => entry.startWorkstream({ home: h.home, run: offer.run, core: h.core, ...input });
  await assert.rejects(start({ name: '' }), /name/i);
  await assert.rejects(start({ name: '   ' }), /name/i);
  await assert.rejects(start({ name: 42 }), /name/i);
  await assert.rejects(start({ name: 'acme bank' }), /already/i, 'case does not make a new name');
  await assert.rejects(start({ name: 'Acme-Bank' }), /already/i, 'nor does punctuation: one folder per workstream');
  await assert.rejects(start({ name: 'Chats' }), /already|taken/i);
  await assert.rejects(start({ name: 'Priya', goal: 'Win or place' }), /goal/i);
  await assert.rejects(entry.fileUnder({ home: h.home, run: offer.run, stream: 'Nobody' }), /No workspace named/);
  await assert.rejects(entry.fileUnder({ home: h.home, run: offer.run, stream: '' }), /workspace/i);
  await assert.rejects(entry.startWorkstream({ home: h.home, run: acme.run, name: 'Other' }), /not a call waiting for a workspace/i);
  await assert.rejects(entry.fileUnder({ home: h.home, run: acme.run, stream: 'Book Club' }), /not a call waiting for a workspace/i);
  await assert.rejects(entry.startWorkstream({ home: h.home, run: '../../etc', name: 'Other' }), /not a send/i);
  assert.equal(await snapshot(), was, 'nothing was written by a refusal');

  // A placed call cannot be placed twice; a screened file changed since review is refused before anything is written.
  await entry.fileUnder({ home: h.home, run: offer.run, stream: 'Book Club' });
  await assert.rejects(entry.startWorkstream({ home: h.home, run: offer.run, name: 'Again' }), /not a call waiting for a workspace/i);
  const h2 = await setup();
  await run(h2, { calls: [h2.unmatched] });
  const offer2 = await offerOf(h2);
  await writeFile(offer2.outbound[0], 'changed after review');
  const list2 = await readFile(join(h2.home, 'workstreams.json'), 'utf8');
  await assert.rejects(entry.startWorkstream({ home: h2.home, run: offer2.run, name: 'Priya' }), /changed since you reviewed it/);
  assert.equal(await readFile(join(h2.home, 'workstreams.json'), 'utf8'), list2);
});

test('the CLI and IPC carry both actions; the CLI sends nothing', async () => {
  const h = await setup();
  await run(h, { calls: [h.unmatched] });
  const offer = await offerOf(h);
  const fakeHome = await mkdtemp(join(tmpdir(), 'hikyaku-place-home-'));
  const env = { PATH: process.env.PATH, HOME: fakeHome, LOGGIE_TUI: '1', HIKYAKU_TRANSCRIBER: '/nonexistent', HIKYAKU_MODEL_URL: 'http://127.0.0.1:9/' };
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'loggie.js'), 'workstream', ...args], { env, encoding: 'utf8', timeout: 30000 });
  const dup = cli(['start', offer.run, '--name', 'Book Club', '--home', h.home]);
  assert.equal(dup.status, 2, dup.stdout + dup.stderr); assert.match(dup.stderr, /already/);
  const empty = cli(['start', offer.run, '--name', ' ', '--home', h.home]);
  assert.equal(empty.status, 2, empty.stdout + empty.stderr);
  const ok = cli(['start', offer.run, '--name', 'Priya intros', '--goal', 'Get it done', '--address', 'lena@example.com', '--home', h.home]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Nothing was sent/);
  assert.equal((await readWorkstreams(h.home)).find((item) => item.name === 'Priya intros')?.goal, 'Get it done');
  assert.deepEqual(await readdir(fakeHome), [], 'the real folder of this made-up HOME was never touched');
  const placed = (await pendingSends(h.home)).find((send) => send.workstream === 'Priya intros');
  assert.ok(placed && placed.status === 'pending');

  const h2 = await setup();
  await run(h2, { calls: [h2.unmatched] });
  const filed = cli(['file', (await offerOf(h2)).run, '--into', 'Riverside Lab', '--home', h2.home]);
  assert.equal(filed.status, 0, filed.stdout + filed.stderr);
  assert.match(filed.stdout, /Nothing was sent/);
  assert.deepEqual((await pendingSends(h2.home)).find((send) => send.workstream === 'Riverside Lab').source_ids, ['t-river-1', COFFEE]);
  await nothingWent(h); await nothingWent(h2);

});

test('Start it never takes the user\'s own domain or a public mail provider as a workstream domain', async () => {
  const h = await setup();
  const folder = await callFolder(h.root, '2026-10-06-0900-lena-and-jess', { title: 'Lena + Jess on the Harbor app', start: '2026-10-06T09:00:00-04:00', emails: ['lena@example.com', 'jess@gmail.com', 'kim@mail.example.com'], names: 'Jess, Kim', me: 'Lena', workstream: 'none' });
  await run(h, { calls: [folder] });
  const started = await entry.startWorkstream({ home: h.home, run: (await offerOf(h)).run, name: 'Harbor app', ownAddress: 'lena@example.com', ownNames: ['Lena Park'] });
  assert.deepEqual(started.entry.domains, [], 'gmail.com names nobody; mail.example.com is the user\'s own organization');
  assert.deepEqual(started.entry.words, ['Jess', 'Harbor'], 'never the user\'s own name');
});

// The kickoff-shaped replay of call.py's test_call_derive.py (spec-c.md B16): the same rule and precedence in both.
const KICKOFF_WORKSTREAMS = [
  { name: 'Strategy Lab', kind: 'other', goal: 'Get it done', domains: ['example.edu'], words: ['Okafor', 'Lindqvist'] },
  { name: 'Intro Finance', kind: 'other', goal: 'Get it done', domains: ['example.edu'], words: ['ledger'] },
  { name: 'Book Club', kind: 'other', goal: 'Get it done', domains: ['books.example'], words: ['novel'] },
];
const KICKOFF_EMAILS = [...Array.from({ length: 21 }, (_, index) => `p${index}.smith@example.edu`), 'mo.okafor@example.edu', 'lindqvist_j@example.edu'];

test('matchCall files the kickoff by names and local parts, and a shared domain alone files nothing', () => {
  const kickoff = { title: 'Kickoff', emails: KICKOFF_EMAILS, names: 'Ana Smith, Mo Okafor, Jonas Lindqvist', workstream: 'none' };
  assert.equal(matchCall(kickoff, KICKOFF_WORKSTREAMS)?.name, 'Strategy Lab');
  assert.equal(matchCall({ ...kickoff, names: '' }, KICKOFF_WORKSTREAMS)?.name, 'Strategy Lab', 'local parts alone');
  assert.equal(matchCall({ ...kickoff, emails: ['x@example.edu'] }, KICKOFF_WORKSTREAMS)?.name, 'Strategy Lab', 'names alone');
  assert.equal(matchCall({ title: 'Kickoff', emails: ['ana@example.edu'], names: 'Ana Smith', workstream: 'none' }, KICKOFF_WORKSTREAMS), null, 'two workstreams list the domain: a tie asks');
  assert.equal(matchCall({ title: 'Ledger review', emails: ['ana@example.edu'], workstream: 'none' }, KICKOFF_WORKSTREAMS)?.name, 'Intro Finance', 'a title word beats a shared domain');
  assert.equal(matchCall({ ...kickoff, title: 'Ledger kickoff' }, KICKOFF_WORKSTREAMS), null, 'two word hits tie');
  assert.equal(matchCall({ title: 'Hi', emails: ['sleepy@elsewhere.example'], names: 'Sam Okaforsson', workstream: 'none' }, KICKOFF_WORKSTREAMS), null, 'whole words only');
  assert.equal(matchCall({ title: 'Hi', emails: ['a@books.example'], workstream: 'none' }, KICKOFF_WORKSTREAMS)?.name, 'Book Club', 'a domain only one workstream lists');
  assert.equal(matchCall({ ...kickoff, workstream: 'none', workstream_candidates: ['Strategy Lab', 'Intro Finance'] }, KICKOFF_WORKSTREAMS), null, 'candidates written by call.py mean the question is asked');
});
