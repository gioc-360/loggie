// B7, NVIDIA models only (docs/b7-nvidia-only/spec.md): the migration contract. Every value an older build stored
// still reads, and none of them lets a model other than Nemotron on Nebius draft. An old approval for claude, codex or
// agy reads as off and asks once; "approve" writes nebius. Nothing stored is rewritten on read. Made-up people, temp
// folders, a fake Token Factory behind the real screen, the real gate and the real runner; no network, no mail app.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { answerMove, doIt } from '../src/hikyaku/do-it.js';
import { listCloud, roomFor, setCloud } from '../src/hikyaku/cloud.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { validateCloudApproval } from '../desktop/ipc-validation.js';
import { createCoreDatabase } from '../src/core/database.js';
import { autoDecide, decideSend, prepareSend, readEvents, runsRoot } from '../src/hikyaku/send-gate.js';
import { taskCore } from './helpers/fake-core.js';

const TASK = 'task_1';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRAFT = JSON.stringify({ file: 'DRAFT.md', content: 'Hi Dana,\n\nAny news on my application?\n\nBest regards,', subject: '' });
const OFF_QUESTION = (name) => `"${name}" is not approved for the cloud AI yet, so nothing was read or sent. Answer "approve" to let the cloud AI read this workspace and draft its moves.`;
const exists = (path) => stat(path).then(() => true, () => false);

const memoryCore = (status, directoryPath) => taskCore({ id: TASK, projectId: 'p1', status, title: 'Follow up with Dana' }, { directoryPath });

// A hikyaku home with one workspace folder (or the Chats folder), one task in it, and a voice folder.
async function world({ cloud, settings = { mailApp: 'outlook' }, chats = false, status = 'waiting', state = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-b7-'));
  const directoryPath = join(home, 'work', chats ? 'chats' : 'acme-bank');
  const taskDirectory = join(directoryPath, TASK);
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', ...(cloud ? { cloud } : {}) }]));
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(directoryPath, 'CONTEXT.md'), '# Acme Bank\nRecruiting with Acme Bank.\n');
  await writeFile(join(taskDirectory, 'BRIEF.md'), '# Follow up with Dana\n');
  await writeFile(join(taskDirectory, 'THREAD.md'), 'From: Dana\nI sent the recruiter an email.\n');
  if (chats) await writeFile(join(taskDirectory, 'REPLY.json'), JSON.stringify({ app: 'messages', chatId: '12', to: 'Dana', isGroup: false }));
  if (state) await writeFile(join(taskDirectory, 'STATE.json'), JSON.stringify(state));
  const voice = join(home, 'voice');
  await mkdir(voice, { recursive: true });
  await writeFile(join(voice, 'rules.md'), 'Keep it short.\n');
  return { home, directoryPath, taskDirectory, voice, core: memoryCore(status, directoryPath) };
}

// The options desktop/main-ipc-moves.js runOptions hands Do it, with the screened complete on a fake Token Factory.
// `draftComplete` counts its calls: one per run the gate let through.
function options(w, { content = DRAFT } = {}) {
  const sent = [];
  const calendar = [];
  const opened = [];
  const nebiusClient = { post: async (body, { path }) => { sent.push({ body, path }); return { content, finish_reason: 'stop', model: 'nvidia/x', usage: {}, seconds: 0.1, copies: 1 }; } };
  const complete = thinkWith({ settings: { thinker: 'cloud' }, maxTokens: 3000, consent: consentFor('mail', { workstream: { name: 'Acme Bank', cloud: 'nebius' } }), what: 'the Acme Bank mail', path: 'do-it', nebiusClient, log: () => {} });
  const counted = { calls: 0 };
  return {
    sent, calendar, opened, counted,
    options: {
      voiceDirectory: w.voice, home: w.home,
      calendarText: async () => { calendar.push(1); return 'Offer these: Mon 10:00 AM'; },
      openDraftImpl: async ({ taskDirectory }) => { opened.push(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8')); return { opened: 'outlook', mode: 'reply', detail: 'The reply is open in Outlook with the draft in it.' }; },
      draftComplete: async () => { counted.calls += 1; return complete; },
    },
  };
}

test('M1: whatever settings.json says about "agent" or "agentModel", the cloud AI drafts a nebius workspace and settings.json is untouched', async () => {
  for (const agent of ['claude', 'codex', 'agy', undefined, 'gpt-9']) {
    const settings = { mailApp: 'outlook', ...(agent ? { agent, agentModel: 'some-model' } : {}) };
    const w = await world({ cloud: 'nebius', settings });
    const before = await readFile(join(w.home, 'settings.json'));
    const run = options(w);
    const result = await doIt({ core: w.core, taskId: TASK, home: w.home, options: run.options });
    assert.equal(result.phase, 'in-mail-app', String(agent));
    assert.equal(run.opened.length, 1, 'the draft opened, unsent');
    assert.equal(run.counted.calls, 1, 'draftComplete is called once');
    assert.equal(run.sent.length, 1, 'one request to Nebius');
    assert.equal(JSON.parse(await readFile(join(w.taskDirectory, 'STATE.json'), 'utf8')).agent, 'nebius');
    assert.deepEqual(await readFile(join(w.home, 'settings.json')), before, 'settings.json bytes unchanged');
  }
});

test('M2: a workspace approved for claude, codex or agy reads as off: asked once, nothing read; "approve" writes nebius and drafts', async () => {
  for (const old of ['claude', 'codex', 'agy']) {
    const w = await world({ cloud: old });
    const before = await readFile(join(w.home, 'workstreams.json'));
    const run = options(w);
    const refused = await doIt({ core: w.core, taskId: TASK, home: w.home, options: run.options });
    assert.deepEqual([refused.started, refused.phase, refused.kind, refused.text], [false, 'needs-you', 'cloud-off', OFF_QUESTION('Acme Bank')], old);
    assert.equal(JSON.parse(await readFile(join(w.taskDirectory, 'STATE.json'), 'utf8')).question, OFF_QUESTION('Acme Bank'));
    assert.deepEqual([run.counted.calls, run.sent.length, run.calendar.length], [0, 0, 0], 'no draftComplete call, no request, no calendar read');
    assert.equal(await exists(roomFor(w.directoryPath, TASK)), false, 'no room was built');
    assert.equal(await exists(join(w.taskDirectory, 'CALENDAR.md')), false, 'no CALENDAR.md');
    assert.deepEqual(await readFile(join(w.home, 'workstreams.json')), before, 'workstreams.json bytes unchanged');
    assert.equal((await readWorkstreams(w.home))[0].cloud, 'off', 'the card says off, so its checkhouse is unticked');

    const approved = await answerMove({ core: w.core, taskId: TASK, answer: 'approve', home: w.home, options: run.options });
    assert.equal(approved.phase, 'in-mail-app', old);
    assert.equal(JSON.parse(await readFile(join(w.home, 'workstreams.json'), 'utf8'))[0].cloud, 'nebius');
    assert.deepEqual([run.counted.calls, run.sent.length, run.opened.length], [1, 1, 1]);
  }
  // The Workspaces checkhouse: the card maps every value but nebius to off, and the toggle is never disabled for one.
  const card = await readFile(join(ROOT, 'desktop', 'main-ipc-workspaces.js'), 'utf8');
  assert.match(card, /cloud: \(workstream\.chats \? \(await readSettings\(hikyakuDirectory\(\)\)\)\.chatsCloud : workstream\.cloud\) === 'nebius' \? 'nebius' : 'off',/);
  const panel = await readFile(join(ROOT, 'desktop', 'renderer', 'panel.js'), 'utf8');
  const toggle = panel.slice(panel.indexOf('function cloudToggle('), panel.indexOf('function cloudToggle(') + 900);
  assert.match(toggle, /box\.checked = workstream\.cloud === 'nebius';/);
  assert.doesNotMatch(toggle.split('addEventListener')[0], /box\.disabled/, 'enabled for an off card');
});

test('M3: Chats approved for claude, codex or agy reads as off; "approve" writes chatsCloud nebius and drafts', async () => {
  for (const old of ['claude', 'codex', 'agy']) {
    const settings = { mailApp: 'outlook', chats: ['messages'], chatsCloud: old };
    const w = await world({ chats: true, settings });
    const before = await readFile(join(w.home, 'settings.json'));
    const run = options(w, { content: JSON.stringify({ file: 'DRAFT.md', content: 'Sure, adding it now.', subject: '' }) });
    run.options.openDraftImpl = async () => ({ opened: 'messages', mode: 'chat', detail: 'In the Messages box, unsent.' });
    const refused = await doIt({ core: w.core, taskId: TASK, home: w.home, options: run.options });
    assert.deepEqual([refused.phase, refused.kind, refused.text], ['needs-you', 'cloud-off', OFF_QUESTION('Chats')], old);
    assert.deepEqual([run.counted.calls, run.sent.length, run.calendar.length], [0, 0, 0]);
    assert.equal(await exists(join(w.taskDirectory, 'CALENDAR.md')), false);
    assert.deepEqual(await readFile(join(w.home, 'settings.json')), before, 'settings.json bytes unchanged');
    assert.equal(consentFor('chats', { settings }), null);

    const approved = await answerMove({ core: w.core, taskId: TASK, answer: 'approve', home: w.home, options: run.options });
    assert.equal(approved.phase, 'in-mail-app', old);
    const after = JSON.parse(await readFile(join(w.home, 'settings.json'), 'utf8'));
    assert.deepEqual(after, { ...settings, chatsCloud: 'nebius' }, 'only chatsCloud changed');
    assert.deepEqual([run.counted.calls, run.sent.length], [1, 1]);
  }
});

test('M4: an old value can no longer be set, by code, the CLI or the IPC, and every reader shows it as off', async () => {
  const w = await world({ cloud: 'claude' });
  for (const value of ['claude', 'codex', 'agy']) {
    await assert.rejects(setCloud(w.home, 'Acme Bank', value), { message: `The approval must be nebius or off, not "${value}".` });
    assert.throws(() => validateCloudApproval('Acme Bank', value), { message: 'The approval must be nebius or off.' });
  }
  for (const value of ['claude', 'codex', 'agy']) {
    await writeFile(join(w.home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', cloud: value }]));
    await writeFile(join(w.home, 'settings.json'), JSON.stringify({ chats: ['messages'], chatsCloud: value }));
    assert.deepEqual((await listCloud(w.home)).map((item) => item.cloud), ['off', 'off'], value);
    const [workstream] = await readWorkstreams(w.home);
    assert.equal(workstream.cloud, 'off', value);
    assert.equal(consentFor('mail', { workstream: { name: 'Acme Bank', cloud: value } }), null);
  }
  // The CLI, on a scratch home (HOME points the hikyaku folder there): exit 1 and the same words; the list says off.
  const userHome = await mkdtemp(join(tmpdir(), 'hikyaku-b7-cli-'));
  const hikyaku = join(userHome, 'Library', 'Application Support', 'Loggie', 'hikyaku');
  await mkdir(hikyaku, { recursive: true });
  await writeFile(join(hikyaku, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', cloud: 'claude' }]));
  const before = await readFile(join(hikyaku, 'workstreams.json'));
  const cli = (args) => new Promise((resolve) => execFile(process.execPath, [join(ROOT, 'bin', 'loggie.js'), ...args], { env: { ...process.env, HOME: userHome } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const set = await cli(['cloud', 'Acme Bank', 'claude']);
  assert.equal(set.code, 1);
  assert.match(set.stderr, /The approval must be nebius or off, not "claude"\./);
  const list = await cli(['cloud']);
  assert.match(list.stdout, /✗ Acme Bank: off \(local AI only\)/);
  assert.match(list.stdout, /Set one: loggie cloud "<workstream>" nebius\|off/);
  assert.deepEqual(await readFile(join(hikyaku, 'workstreams.json')), before, 'nothing written');
});

test('M5: a move stopped under claude with a session reruns on Nebius: no session in any prompt, the answer in NOTES.md, a new receipt', async () => {
  const SESSION = 'sess-s1-claude';
  const w = await world({ cloud: 'nebius', status: 'blocked', state: { phase: 'needs-you', kind: 'question', question: 'Which Friday works?', agent: 'claude', session: SESSION } });
  await writeFile(join(w.taskDirectory, 'SENT.json'), JSON.stringify({ agent: 'claude', prompt: `old run ${SESSION}` }));
  const oldTask = join(w.directoryPath, 'task_0');
  await mkdir(oldTask);
  await writeFile(join(oldTask, 'SENT.json'), JSON.stringify({ agent: 'claude', workstream: 'Acme Bank', prompt: 'an old claude run' }));
  const oldReceipt = await readFile(join(oldTask, 'SENT.json'));
  const run = options(w);
  const result = await answerMove({ core: w.core, taskId: TASK, answer: 'Friday the 9th', home: w.home, options: run.options });
  assert.equal(result.phase, 'in-mail-app');
  assert.equal(run.sent.length, 1);
  assert.ok(!run.sent[0].body.includes(SESSION), 'the old session is in no prompt');
  assert.match(await readFile(join(w.taskDirectory, 'NOTES.md'), 'utf8'), /Question: Which Friday works\?\nAnswer: Friday the 9th/);
  assert.match(run.sent[0].body, /Friday the 9th/, 'the answer reaches the draft through NOTES.md');
  const state = JSON.parse(await readFile(join(w.taskDirectory, 'STATE.json'), 'utf8'));
  assert.deepEqual([state.agent, state.session], ['nebius', null]);
  const receipt = JSON.parse(await readFile(join(w.taskDirectory, 'SENT.json'), 'utf8'));
  assert.equal(receipt.agent, 'nebius');
  assert.ok(!receipt.prompt.includes(SESSION));
  assert.deepEqual(await readFile(join(oldTask, 'SENT.json')), oldReceipt, 'old receipts are untouched');
});

test('M6: a call-notes send under an old claude pick (the workspace or cloud-pick.json) never goes to Claude: no card skipped, the Yes goes to Nebius', async () => {
  const COUNTS = { sentences: 2, sent: 2, held: 0 };
  async function callSend(home) {
    const folder = join(home, 'calls', '2026-10-05-1400-coffee-chat', 'v1');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'outbound.md'), '[00:02] Me: Hi Sam, thanks for making time today.\n');
    await writeFile(join(folder, 'held.json'), JSON.stringify({ counts: COUNTS }));
    return prepareSend({ home, what: 'call-notes', sourceIds: ['call:2026-10-05-1400-coffee-chat'], folder, outbound: [join(folder, 'outbound.md')],
      held: [join(folder, 'held.json')], counts: [COUNTS], workstream: 'Acme Bank', title: 'Coffee chat with Sam' });
  }
  const recording = () => { const calls = []; return { calls, runner: async (command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } }; };
  // The checks an older build had: a claude check that says yes. It is no provider now, so it is never asked.
  const checks = { nebius: async () => true, claude: async () => true };
  const TRANSCRIBER = '/fake/transcriber';
  for (const where of ['workspace', 'cloud-pick']) {
    const home = await mkdtemp(join(tmpdir(), 'hikyaku-b7-send-'));
    await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', ...(where === 'workspace' ? { cloud: 'claude' } : {}) }]));
    if (where === 'cloud-pick') await writeFile(join(home, 'cloud-pick.json'), JSON.stringify({ provider: 'claude' }));
    const stored = [await readFile(join(home, 'workstreams.json'))];
    // No standing yes: autoDecide skips nothing; the card shows, nothing runs.
    const send = await callSend(home);
    const quiet = recording();
    assert.deepEqual(await autoDecide({ home, run: send.run, checks, runner: quiet.runner, transcriber: TRANSCRIBER, file: async () => {} }), { auto: false }, where);
    assert.equal(quiet.calls.length, 0);
    assert.ok(!(await readEvents(join(runsRoot(home), send.run))).some((event) => event.type === 'send.decided'));
    // The card's Yes: the old claude pick is no provider, so the one AI writes it, Nemotron on Nebius, never Claude
    // (cleanup 2026-10-27: no "Which AI" card while Nebius is connected).
    const shown = await decideSend({ home, run: send.run, decision: 'yes', checks, runner: quiet.runner, transcriber: TRANSCRIBER });
    assert.equal(shown.ok, true, where);
    assert.equal(quiet.calls.length, 1);
    assert.equal(quiet.calls[0][quiet.calls[0].indexOf('--with') + 1], 'nebius', where);
    // The setup's calls yes still sends on its own, and only to Nebius (fileNotesOnly).
    const later = await callSend(home);
    const yes = recording();
    const standing = { callsYes: true, keySaved: true, overBudget: false, callsAt: new Date(Date.now() - 60000).toISOString() };
    const auto = await autoDecide({ home, run: later.run, checks, runner: yes.runner, transcriber: TRANSCRIBER, standing, fileNotesOnly: async () => {} });
    assert.equal(auto.auto, true);
    assert.equal(yes.calls.length, 1);
    assert.equal(yes.calls[0][yes.calls[0].indexOf('--with') + 1], 'nebius');
    assert.deepEqual(await readFile(join(home, 'workstreams.json')), stored[0], 'workstreams.json bytes unchanged');
    if (where === 'cloud-pick') assert.equal(JSON.parse(await readFile(join(home, 'cloud-pick.json'), 'utf8')).provider, 'claude', 'cloud-pick.json is never rewritten on read');
  }
});

test('M7: Core rows an older build wrote as claude or antigravity are kept; a new run is a shell session', async () => {
  const w = await world({ cloud: 'nebius' });
  const db = createCoreDatabase();
  const project = db.createProject({ name: 'Acme Bank', directoryPath: w.directoryPath });
  const task = db.createTask({ projectId: project.id, title: 'Follow up with Dana', description: 'Ask about the application.' });
  db.approveBrief(db.createBrief(task.id, { objective: 'Follow up', context: 'Recruiting.', completionCriteria: ['A draft'] }).id);
  db.transitionTask(task.id, 'briefed');
  for (const terminalKind of ['claude', 'antigravity']) {
    const old = db.createSession({ taskId: task.id, workingDirectory: w.directoryPath, terminalKind });
    db.transitionSession(old.id, 'running');
    db.transitionSession(old.id, 'completed');
  }
  const core = {
    getTask: async (id) => db.getTask(id), getProject: async (id) => db.getProject(id), getApprovedBrief: async (id) => db.getApprovedBriefForTask(id),
    getLatestBrief: async (id) => db.getLatestBriefForTask(id), approveBrief: async (id) => db.approveBrief(id), transitionTask: async (id, to, reason) => db.transitionTask(id, to, reason),
    listSessions: async (filter) => db.listSessions(filter), createSession: async (input) => db.createSession(input), transitionSession: async (id, to) => db.transitionSession(id, to),
    createWriteUp: async (id, input) => db.createWriteUp(id, input),
  };
  // The runner reads the task folder by the Core task id.
  await mkdir(join(w.directoryPath, task.id), { recursive: true });
  for (const name of ['BRIEF.md', 'THREAD.md']) await writeFile(join(w.directoryPath, task.id, name), await readFile(join(w.taskDirectory, name)));
  const run = options(w);
  const result = await doIt({ core, taskId: task.id, home: w.home, options: run.options });
  assert.equal(result.phase, 'in-mail-app');
  const kinds = db.listSessions({ taskId: task.id }).map((session) => session.terminalKind).sort();
  assert.deepEqual(kinds, ['antigravity', 'claude', 'shell']);
  db.close();
});
