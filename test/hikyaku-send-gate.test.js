// The send gate (spec-entry-b.md A7, increment b#3a): nothing leaves the Mac until the user picks an AI and presses
// Send. A send is prepared on the Mac first (screened, recorded as pending in <home>/runs/<run>/send.json); ai.options
// reports which AIs are really connected; only an approve with a connected provider runs the send. Every runner,
// keychain check and readiness check here is a fake: no network, no keychain value, no model server.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { aiOptions, appendEvent, approveSend, autoDecide, autoDecideOnScreen, decideSend, summarizeRun, defaultChecks, pendingSends, prepareNextMove, prepareSend, readEvents, runsRoot } from '../src/hikyaku/send-gate.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { fileCall } from '../src/hikyaku/calls.js';
import { screenThread } from '../src/hikyaku/screen-thread.js';

const NAMES_A_MODEL = /nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm/i;
const TRANSCRIBER = '/fake/transcriber/spike';
const THREAD = '# Re: Project kickoff\n\n## Dana Reyes · 2026-10-06T14:00:00Z\nTo: me@example.com\n\nCan you send the outline by Friday?\n';
const COUNTS = { sentences: 5, sent: 4, held: 1, turns: 2, turns_fully_held: 0, layer: { code: 1, model: 0, unchecked: 0 }, category: { health: 1 } };

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-send-gate-'));
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }, { name: 'Classes', kind: 'class', domains: [], words: [], cloud: 'claude' }], null, 2));
  return dir;
}

// A fake privacy.py --thread: writes an OUTBOUND.md + HELD.json pair into --out, the way the real CLI does.
function fakeScreenRunner(calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    const out = args[args.indexOf('--out') + 1];
    await writeFile(join(out, 'OUTBOUND.md'), '# Re: Project kickoff\n\n## Dana Reyes · 2026-10-06T14:00:00Z\n\nCan you send the outline by Friday?\n');
    await writeFile(join(out, 'HELD.json'), JSON.stringify({ source: 'thread', counts: COUNTS, held: [] }));
    return { code: 0, stdout: 'OUTBOUND.md: 4 of 5 sentences go out', stderr: '' };
  };
}

async function callSend(dir) {
  // A call folder whose screen already ran, and its pending send (what call.py finish() leaves behind).
  const folder = join(dir, 'calls', '2026-10-05-1400-coffee-chat', 'v1');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'outbound.md'), '[00:02] Me: Hi Sam, thanks for making time today.\n');
  await writeFile(join(folder, 'held.json'), JSON.stringify({ counts: COUNTS }));
  const send = await prepareSend({ home: dir, what: 'call-notes', sourceIds: ['call:2026-10-05-1400-coffee-chat'], folder, outbound: [join(folder, 'outbound.md')],
    held: [join(folder, 'held.json')], counts: [COUNTS], workstream: 'Acme Bank', title: 'Coffee chat with Sam' });
  return { folder, send };
}

const connected = (nebius, claude) => ({ nebius: async () => nebius, claude: async () => claude });
function recordingRunner() {
  const calls = [];
  const runner = async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: '', stderr: '' }; };
  return { calls, runner };
}
const allEvents = async (dir) => (await Promise.all((await readdir(runsRoot(dir))).map((run) => readEvents(join(runsRoot(dir), run))))).flat();

test('a prepared send is pending and nothing runs until approve', async () => {
  const dir = await home();
  const screens = [], { calls, runner } = recordingRunner();
  const workstreamDirectory = join(dir, 'work', 'acme-bank');
  const send = await prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory, threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: fakeScreenRunner(screens) });
  assert.equal(screens.length, 1);
  assert.deepEqual(screens[0].args, [join(TRANSCRIBER, 'privacy.py'), '--thread', join(workstreamDirectory, '.outbound', 'thread-1', 'THREAD.md'), '--out', join(workstreamDirectory, '.outbound', 'thread-1')]);
  assert.equal(await readFile(join(workstreamDirectory, '.outbound', 'thread-1', 'THREAD.md'), 'utf8'), THREAD);
  const saved = JSON.parse(await readFile(join(runsRoot(dir), send.run, 'send.json'), 'utf8'));
  assert.equal(saved.status, 'pending'); assert.equal(saved.what, 'next-move'); assert.deepEqual(saved.source_ids, ['thread-1']);
  assert.deepEqual(saved.outbound, [join(workstreamDirectory, '.outbound', 'thread-1', 'OUTBOUND.md')]);
  assert.equal(saved.sentences_sent, 4); assert.equal(saved.sentences_kept, 1); assert.equal(saved.workstream, 'Acme Bank');
  assert.deepEqual((await pendingSends(dir)).map((item) => item.run), [send.run]);
  const types = (await readEvents(join(runsRoot(dir), send.run))).map((event) => event.type);
  assert.deepEqual(types, ['run.started', 'step.started', 'step.progress', 'step.finished', 'screen.summary']);
  assert.equal(calls.length, 0, 'preparing sent nothing');
});

test('a screen that cannot run prepares nothing', async () => {
  const dir = await home();
  const down = async () => ({ code: 1, stdout: '', stderr: 'privacy screen refused to run: no server; nothing written' });
  await assert.rejects(screenThread({ threadId: 'thread-1', md: THREAD, workstreamDirectory: join(dir, 'work', 'acme-bank'), transcriber: TRANSCRIBER, runner: down }), /privacy screen did not run/);
  await assert.rejects(prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory: join(dir, 'work', 'acme-bank'), threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: down }), /privacy screen did not run/);
  assert.deepEqual(await pendingSends(dir), []);
  await assert.rejects(screenThread({ threadId: '../escape', md: THREAD, workstreamDirectory: dir, transcriber: TRANSCRIBER, runner: down }), /thread id/);
});

test('ai.options reports connected status from the checks, and the default is nebius', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  let asked = 0;
  const checks = { nebius: async () => { asked += 1; return true; } };
  const options = await aiOptions({ home: dir, run: send.run, checks });
  assert.deepEqual(options.options.map(({ id, connected: on }) => [id, on]), [['nebius', true]]);
  assert.equal(asked, 1);
  assert.equal(options.default, 'nebius');
  assert.deepEqual((await aiOptions({ home: dir, run: send.run, checks: { nebius: async () => false } })).options.map((option) => option.connected), [false]);
  // An older build's pick for another AI, on the workstream or in cloud-pick.json, is no provider now.
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [], cloud: 'claude' }]));
  await writeFile(join(dir, 'cloud-pick.json'), JSON.stringify({ provider: 'claude' }));
  assert.equal((await aiOptions({ home: dir, run: send.run, checks: connected(true, true) })).default, 'nebius', 'an old pick is ignored');
  const event = (await readEvents(join(runsRoot(dir), send.run))).find((item) => item.type === 'ai.options');
  assert.equal(event.data.options.length, 1); assert.equal(event.data.default, 'nebius');
});

test('the default checks look for the keychain item without reading it', async () => {
  const seen = [];
  const execFileImpl = async (file, args) => { seen.push([file, ...args]); return { code: 0, stdout: 'keychain: "/x"\nattributes: ...', stderr: '' }; };
  const checks = defaultChecks({ runner: execFileImpl, transcriber: TRANSCRIBER });
  assert.equal(await checks.nebius(), true);
  assert.deepEqual(seen[0], ['security', 'find-generic-password', '-s', 'nebius-token-factory', '-a', 'hikyaku']);
  assert.ok(!seen[0].includes('-w') && !seen[0].includes('-g'), 'the key value is never asked for');
  const missing = defaultChecks({ runner: async () => ({ code: 44, stdout: '', stderr: 'could not be found' }), transcriber: TRANSCRIBER });
  assert.equal(await missing.nebius(), false);
  assert.deepEqual(Object.keys(checks), ['nebius'], 'Nebius is the only AI checked');
  assert.equal(seen.length, 1, 'one keychain look, nothing else run');
});

test('a provider that is not connected is refused and nothing is sent', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  for (const provider of ['claude', 'chatgpt', 'gemini', 'gpt']) {
    await assert.rejects(approveSend({ home: dir, run: send.run, provider, remember: true, checks: connected(true, false), runner, transcriber: TRANSCRIBER }), /not connected|Pick one of/);
  }
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(runsRoot(dir), send.run, 'send.json'), 'utf8')).status, 'pending');
  assert.equal((await readEvents(join(runsRoot(dir), send.run))).filter((event) => event.type === 'ai.picked').length, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'workstreams.json'), 'utf8'))[0].cloud, undefined, 'a refused pick is never remembered');
});

test('approve runs the send with the picked provider and the approval of what was reviewed; remember stores the pick per workstream', async () => {
  const dir = await home();
  const { folder, send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const filed = [];
  const result = await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file: async (where) => { filed.push(where); } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [join(TRANSCRIBER, 'byo.py'), folder, '--with', 'nebius', '--approved', send.sha256[0]]);
  assert.deepEqual(filed, [folder]);
  const list = JSON.parse(await readFile(join(dir, 'workstreams.json'), 'utf8'));
  assert.equal(list.find((item) => item.name === 'Acme Bank').cloud, 'nebius');
  assert.equal(list.find((item) => item.name === 'Classes').cloud, 'claude', 'other workstreams are untouched');
  assert.equal(JSON.parse(await readFile(join(runsRoot(dir), send.run, 'send.json'), 'utf8')).status, 'sent');
  const picked = (await readEvents(join(runsRoot(dir), send.run))).find((event) => event.type === 'ai.picked');
  assert.deepEqual(picked.data, { run: send.run, provider: 'nebius', remember: true, stream_id: 'acme-bank' });
  await assert.rejects(approveSend({ home: dir, run: send.run, provider: 'nebius', remember: false, checks: connected(true, true), runner, transcriber: TRANSCRIBER }), /already sent/);
  assert.equal(calls.length, 1, 'a send goes once');
});

test('remember false leaves the workstream as it was', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const before = await readFile(join(dir, 'workstreams.json'), 'utf8');
  const { calls, runner } = recordingRunner();
  await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: false, checks: connected(true, false), runner, transcriber: TRANSCRIBER });
  assert.equal(calls[0].args[3], 'nebius');
  assert.equal(await readFile(join(dir, 'workstreams.json'), 'utf8'), before);
});

test('remember on a workstreams.json that cannot be read still sends and keeps the global pick (the dead Send of 2026-10-12)', async () => {
  const cases = {
    corrupt: async (dir) => writeFile(join(dir, 'workstreams.json'), '{not json'),
    folder: async (dir) => { await rm(join(dir, 'workstreams.json')); await mkdir(join(dir, 'workstreams.json')); },
    missing: async (dir) => rm(join(dir, 'workstreams.json')),
  };
  for (const [name, replace] of Object.entries(cases)) {
    const dir = await home();
    const { send } = await callSend(dir);
    await replace(dir);
    const { calls, runner } = recordingRunner();
    const result = await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file: async () => {} });
    assert.equal(result.ok, true, name);
    assert.equal(calls.length, 1, name);
    assert.equal(JSON.parse(await readFile(join(dir, 'cloud-pick.json'), 'utf8')).provider, 'nebius', name);
    if (name === 'corrupt') assert.equal(await readFile(join(dir, 'workstreams.json'), 'utf8'), '{not json');
    if (name === 'missing') assert.equal(existsSync(join(dir, 'workstreams.json')), false, 'no file is created');
  }
});

test('an outbound that changed after the review is refused, and a refused or failed send says so', async () => {
  const dir = await home();
  const { folder, send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  await writeFile(join(folder, 'outbound.md'), '[00:02] Me: something new\n');
  await assert.rejects(approveSend({ home: dir, run: send.run, provider: 'nebius', remember: false, checks: connected(true, true), runner, transcriber: TRANSCRIBER }), /changed since you reviewed/);
  assert.equal(calls.length, 0);
  const other = await home();
  const second = await callSend(other);
  const refused = await approveSend({ home: other, run: second.send.run, provider: 'nebius', remember: false, checks: connected(true, true), transcriber: TRANSCRIBER,
    runner: async () => ({ code: 2, stdout: '', stderr: 'refused: the reply came from x' }) });
  assert.equal(refused.ok, false);
  assert.equal(JSON.parse(await readFile(join(runsRoot(other), second.send.run, 'send.json'), 'utf8')).status, 'failed');
  const events = await readEvents(join(runsRoot(other), second.send.run));
  assert.equal(events.at(-1).type, 'run.failed'); assert.equal(events.at(-1).data.step, 'ask');
});

test('a next move goes through the same gate, and only through its hook', async () => {
  const dir = await home();
  const send = await prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory: join(dir, 'work', 'acme-bank'), threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: fakeScreenRunner() });
  const { calls, runner } = recordingRunner();
  await assert.rejects(approveSend({ home: dir, run: send.run, provider: 'nebius', remember: false, checks: connected(true, true), runner, transcriber: TRANSCRIBER }), /not built yet/);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(runsRoot(dir), send.run, 'send.json'), 'utf8')).status, 'pending');
  const asked = [];
  await assert.rejects(approveSend({ home: dir, run: send.run, provider: 'chatgpt', remember: false, checks: connected(true, true), runner, transcriber: TRANSCRIBER, nextMove: async (input) => { asked.push(input); } }), /not connected|Pick one of/);
  const result = await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: false, checks: connected(true, true), runner, transcriber: TRANSCRIBER, nextMove: async (input) => { asked.push(input); return { ok: true }; } });
  assert.equal(result.ok, true); assert.equal(asked.length, 1);
  assert.equal(asked[0].provider, 'nebius'); assert.deepEqual(asked[0].send.source_ids, ['thread-1']);
});

test('no event text names a model, and seq has no gaps', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const { runner } = recordingRunner();
  await aiOptions({ home: dir, run: send.run, checks: connected(true, true) });
  await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file: async () => {} });
  await prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory: join(dir, 'work', 'acme-bank'), threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: fakeScreenRunner() });
  const events = await allEvents(dir);
  assert.ok(events.length >= 10);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'data', 'run', 'seq', 'step', 'text', 'type', 'v']);
    assert.ok(!(event.text && NAMES_A_MODEL.test(event.text)), `event text names a model: ${event.text}`);
  }
  for (const run of await readdir(runsRoot(dir))) {
    const seqs = (await readEvents(join(runsRoot(dir), run))).map((event) => event.seq);
    assert.deepEqual(seqs, seqs.map((_, index) => index + 1));
  }
});

// --- increment 15: one decision per call (spec-c.md B18). Gio: "summarize using cloud ai or no".
const exists = (path) => readFile(path).then(() => true, () => false);
const decidedOf = async (dir, run) => (await readEvents(join(runsRoot(dir), run))).filter((event) => event.type === 'send.decided');
const statusOf = async (dir, run) => JSON.parse(await readFile(join(runsRoot(dir), run, 'send.json'), 'utf8')).status;

test('one decision per call', async () => {
  const dir = await home();
  const filed = [];
  const file = async (where) => { filed.push(where); };

  // No: declined, nothing runs, nothing is filed, and a second decide is refused.
  const no = await callSend(dir);
  const trap = recordingRunner();
  const declined = await decideSend({ home: dir, run: no.send.run, decision: 'no', checks: connected(true, true), runner: trap.runner, transcriber: TRANSCRIBER, file });
  assert.equal(declined.declined, true);
  assert.equal(trap.calls.length, 0);
  assert.deepEqual(filed, []);
  assert.equal(await statusOf(dir, no.send.run), 'declined');
  assert.deepEqual((await decidedOf(dir, no.send.run)).map((event) => event.data), [{ run: no.send.run, decision: 'no', picker_shown: false }]);
  assert.equal((await decidedOf(dir, no.send.run))[0].text, 'You decided');
  assert.deepEqual((await pendingSends(dir)).map((send) => send.run), [], 'pendingSends ignores declined');
  await assert.rejects(decideSend({ home: dir, run: no.send.run, decision: 'yes', checks: connected(true, true), runner: trap.runner, transcriber: TRANSCRIBER, file }), /already decided/);
  assert.equal(trap.calls.length, 0);

  // First Yes with Nemotron on Nebius connected: the one AI writes it at once, no "Which AI" card (cleanup 2026-10-27).
  const direct = await callSend(dir);
  const run0 = recordingRunner();
  const sent = await decideSend({ home: dir, run: direct.send.run, decision: 'yes', checks: connected(true, true), runner: run0.runner, transcriber: TRANSCRIBER, file });
  assert.equal(sent.ok, true);
  assert.equal(run0.calls[0].args[3], 'nebius');
  assert.ok(!(await readEvents(join(runsRoot(dir), direct.send.run))).some((event) => event.type === 'ai.options'));
  assert.deepEqual((await decidedOf(dir, direct.send.run)).map((event) => event.data.picker_shown), [false]);

  // First Yes with no AI connected yet: the picker (ai.options), nothing runs; the pick with remember lands in cloud-pick.json.
  const first = await callSend(dir);
  const run1 = recordingRunner();
  const shown = await decideSend({ home: dir, run: first.send.run, decision: 'yes', checks: connected(false, true), runner: run1.runner, transcriber: TRANSCRIBER, file });
  assert.equal(shown.picker, true);
  assert.equal(shown.default, 'nebius');
  assert.deepEqual(shown.options.map((option) => option.id), ['nebius']);
  assert.equal(run1.calls.length, 0, 'nothing is sent until a pick');
  assert.equal(await statusOf(dir, first.send.run), 'pending');
  assert.deepEqual((await decidedOf(dir, first.send.run)).map((event) => event.data), [{ run: first.send.run, decision: 'yes', picker_shown: true }]);
  // A second Yes before any pick (the panel reloaded and lost the picker) shows the picker again; still one decision.
  const reshown = await decideSend({ home: dir, run: first.send.run, decision: 'yes', checks: connected(false, true), runner: run1.runner, transcriber: TRANSCRIBER, file });
  assert.equal(reshown.picker, true);
  assert.equal(run1.calls.length, 0, 'asking again sends nothing');
  await assert.rejects(decideSend({ home: dir, run: first.send.run, decision: 'no', checks: connected(true, true), runner: run1.runner, transcriber: TRANSCRIBER, file }), /already decided/);
  assert.equal((await decidedOf(dir, first.send.run)).length, 1, 'exactly one send.decided');
  await approveSend({ home: dir, run: first.send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner: run1.runner, transcriber: TRANSCRIBER, file });
  const pick = JSON.parse(await readFile(join(dir, 'cloud-pick.json'), 'utf8'));
  assert.equal(pick.provider, 'nebius');
  assert.ok(!Number.isNaN(Date.parse(pick.at)));
  assert.equal(await exists(join(dir, 'settings.json')), false, 'settings.json is never written');

  // Yes with a remembered pick (no workstream cloud of its own): approveSend runs with no ai.options.
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }]));
  const again = await callSend(dir);
  const run2 = recordingRunner();
  const result = await decideSend({ home: dir, run: again.send.run, decision: 'yes', checks: connected(true, true), runner: run2.runner, transcriber: TRANSCRIBER, file });
  assert.equal(result.ok, true);
  assert.equal(run2.calls.length, 1);
  assert.equal(run2.calls[0].args[3], 'nebius');
  const types = (await readEvents(join(runsRoot(dir), again.send.run))).map((event) => event.type);
  assert.ok(!types.includes('ai.options'));
  assert.ok(types.indexOf('send.decided') < types.indexOf('ai.picked'));
  assert.deepEqual((await decidedOf(dir, again.send.run)).map((event) => event.data.picker_shown), [false]);
  assert.equal(await exists(join(dir, 'settings.json')), false);

  // A remembered pick that is not connected right now shows the picker instead of failing.
  const off = await callSend(dir);
  const run3 = recordingRunner();
  const offered = await decideSend({ home: dir, run: off.send.run, decision: 'yes', checks: connected(false, true), runner: run3.runner, transcriber: TRANSCRIBER, file });
  assert.equal(offered.picker, true);
  assert.equal(run3.calls.length, 0);
  assert.deepEqual((await decidedOf(dir, off.send.run)).map((event) => event.data.picker_shown), [true]);

  // Anything but yes or no is refused before an event is written.
  const odd = await callSend(dir);
  await assert.rejects(decideSend({ home: dir, run: odd.send.run, decision: 'maybe', checks: connected(true, true), runner: run3.runner, transcriber: TRANSCRIBER }), /Yes or No/);
  assert.equal((await decidedOf(dir, odd.send.run)).length, 0);
});

test('a remembered nebius pick shows on the card', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner: recordingRunner().runner, transcriber: TRANSCRIBER });
  const card = (await readWorkstreams(dir)).find((item) => item.name === 'Acme Bank');
  assert.equal(card.cloud, 'nebius');
});

test('No files the call as a transcript with no summary, and sends nothing', async () => {
  const dir = await home();
  const { folder, send } = await callSend(dir);
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam', start: '2026-10-05T18:00:00Z', me: 'Lena', with: 'Sam', category: 'one-on-one', workstream: 'Acme Bank' }));
  await writeFile(join(folder, 'transcript.md'), '[00:02] Me: Hi Sam.\n');
  const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-work-'));
  const tasks = [];
  const core = { listProjects: async () => [], listTasks: async () => [], createProject: async (input) => ({ id: 'project_1', ...input }), createTask: async (input) => { tasks.push(input); return { id: 'task_1' }; } };
  const filed = [];
  const fileTranscript = async (where, workstream) => { filed.push(await fileCall({ folder: where, core, workRoot, workstreams: await readWorkstreams(dir), workstream, transcriptOnly: true })); };
  const trap = recordingRunner();
  const result = await decideSend({ home: dir, run: send.run, decision: 'no', checks: connected(true, true), runner: trap.runner, transcriber: TRANSCRIBER, fileTranscript });
  assert.equal(result.declined, true);
  assert.equal(trap.calls.length, 0);
  assert.equal(await statusOf(dir, send.run), 'declined');
  assert.equal(filed.length, 1);
  const card = await readFile(filed[0].notesFile, 'utf8');
  assert.match(card, /no summary/i);
  assert.ok(card.includes(join(folder, 'transcript.md')));
  assert.deepEqual(tasks, []);
  assert.equal((await decidedOf(dir, send.run)).length, 1);
});

test('No on a call with no workstream is declined and files nothing', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const none = JSON.parse(await readFile(join(runsRoot(dir), send.run, 'send.json'), 'utf8'));
  await writeFile(join(runsRoot(dir), send.run, 'send.json'), JSON.stringify({ ...none, workstream: 'none' }));
  const filed = [];
  const result = await decideSend({ home: dir, run: send.run, decision: 'no', checks: connected(true, true), transcriber: TRANSCRIBER, fileTranscript: async (...a) => { filed.push(a); } });
  assert.equal(result.declined, true);
  assert.deepEqual(filed, []);
  assert.equal(await statusOf(dir, send.run), 'declined');
  assert.equal((await decidedOf(dir, send.run)).length, 1);
});

// --- increment L6: a remembered yes sends the summary request without the card (spec-live-transcription.md B26)
const rememberedHome = async (cloud = 'nebius') => {
  const dir = await home();
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [], cloud }]));
  return dir;
};
const setWorkstream = async (dir, run, workstream) => {
  const path = join(runsRoot(dir), run, 'send.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), workstream }));
};

test('autoDecide: a remembered, connected yes decides once, with auto true, and runs byo.py with --approved', async () => {
  const dir = await rememberedHome();
  const { send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const result = await autoDecide({ home: dir, run: send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.equal(result.auto, true);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], join(TRANSCRIBER, 'byo.py'));
  assert.deepEqual(calls[0].args.slice(2), ['--with', 'nebius', '--approved', send.sha256[0]]);
  const decided = await decidedOf(dir, send.run);
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0].data, { run: send.run, decision: 'yes', picker_shown: false, auto: true });
  assert.equal(await statusOf(dir, send.run), 'sent');
  // A later card click is refused and the runner is not called twice.
  await assert.rejects(decideSend({ home: dir, run: send.run, decision: 'yes', checks: connected(true, true), runner, transcriber: TRANSCRIBER }), /already decided/);
  assert.equal(calls.length, 1);
  // Asking again changes nothing.
  assert.deepEqual(await autoDecide({ home: dir, run: send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER }), { auto: false });
  assert.equal(calls.length, 1);
  assert.equal((await decidedOf(dir, send.run)).length, 1);
});

test('autoDecide never sends without a remembered, connected yes for this workstream', async () => {
  const cases = [
    ['no remembered pick', async () => { const dir = await rememberedHome(); await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }])); return dir; }, connected(true, true)],
    ['a disconnected pick', () => rememberedHome('nebius'), connected(false, true)],
    ['workstream none', async () => rememberedHome(), connected(true, true), 'none'],
    ['a global pick only', async () => { const dir = await home(); await writeFile(join(dir, 'cloud-pick.json'), JSON.stringify({ provider: 'nebius', at: new Date().toISOString() })); return dir; }, connected(true, true)],
  ];
  for (const [name, make, checks, workstream] of cases) {
    const dir = await make();
    const { send } = await callSend(dir);
    if (workstream) await setWorkstream(dir, send.run, workstream);
    const { calls, runner } = recordingRunner();
    assert.deepEqual(await autoDecide({ home: dir, run: send.run, checks, runner, transcriber: TRANSCRIBER }), { auto: false }, name);
    assert.equal(calls.length, 0, name);
    assert.equal((await decidedOf(dir, send.run)).length, 0, `${name}: no send.decided`);
    assert.equal(await statusOf(dir, send.run), 'pending', name);
  }
});

test('autoDecide leaves a next-move send and a send that is not pending alone', async () => {
  const dir = await rememberedHome();
  const { calls, runner } = recordingRunner();
  const move = await prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory: join(dir, 'work', 'acme-bank'), threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: fakeScreenRunner() });
  assert.deepEqual(await autoDecide({ home: dir, run: move.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER, nextMove: async () => ({ ok: true }) }), { auto: false });
  const declined = await callSend(dir);
  await decideSend({ home: dir, run: declined.send.run, decision: 'no', checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.deepEqual(await autoDecide({ home: dir, run: declined.send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER }), { auto: false });
  assert.equal(calls.length, 0);
  assert.equal((await allEvents(dir)).some((event) => event.type === 'send.decided' && event.data.auto), false);
});

test('a manual yes carries no auto field, and the event with auto passes the contract', async () => {
  const dir = await rememberedHome();
  const { send } = await callSend(dir);
  await decideSend({ home: dir, run: send.run, decision: 'yes', checks: connected(true, true), runner: recordingRunner().runner, transcriber: TRANSCRIBER });
  assert.equal('auto' in (await decidedOf(dir, send.run))[0].data, false);
});

test('the screen hook calls autoDecide once per run, only when the screen finished ok, and never throws', async () => {
  const seen = [], logged = [];
  const gate = { autoDecide: async (options) => { seen.push(options); if (options.run === 'boom') throw new Error('broken'); return { auto: true }; } };
  const hook = autoDecideOnScreen({ gate, options: async () => ({ home: '/h', checks: 'c' }), log: (message) => logged.push(message) });
  const screen = (run, ok, step = 'screen', type = 'step.finished') => ({ run, type, step, data: { step, ok } });
  await hook(screen('a', true));
  await hook(screen('a', true));
  await hook(screen('b', false));
  await hook(screen('c', true, 'ask'));
  await hook(screen('d', true, 'screen', 'step.started'));
  assert.deepEqual(seen, [{ home: '/h', checks: 'c', run: 'a' }]);
  await hook(screen('boom', true));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /broken/);
});

// loggie-one-click-summarize: on the 2026-10-22 class the screen event came 0.8 s before send.json; the yes read no send,
// gave up, and the call waited with the calls yes on. A missing send is waited for; any other error is logged at once.
test('the screen hook waits for a send that is not written yet, then decides; other errors are not retried', async () => {
  const logged = [], slept = [];
  let reads = 0;
  const gate = { autoDecide: async ({ run }) => { reads += 1; if (run === 'late' && reads < 3) throw new Error('No prepared send in that run. Nothing was sent.'); if (run === 'bad') throw new Error('broken'); return { auto: true }; } };
  const hook = autoDecideOnScreen({ gate, options: async () => ({}), log: (m) => logged.push(m), sleep: async (ms) => { slept.push(ms); } });
  await hook({ run: 'late', type: 'step.finished', step: 'screen', data: { step: 'screen', ok: true } });
  assert.equal(reads, 3); assert.deepEqual(slept, [500, 500]); assert.deepEqual(logged, []);
  reads = 0; slept.length = 0;
  await hook({ run: 'bad', type: 'step.finished', step: 'screen', data: { step: 'screen', ok: true } });
  assert.equal(reads, 1); assert.deepEqual(slept, []); assert.match(logged[0], /broken/);
  const never = autoDecideOnScreen({ gate: { autoDecide: async () => { throw new Error('No prepared send in that run. Nothing was sent.'); } }, options: async () => ({}), log: (m) => logged.push(m), tries: 3, sleep: async () => {} });
  await never({ run: 'gone', type: 'step.finished', step: 'screen', data: { step: 'screen', ok: true } });
  assert.match(logged.at(-1), /No prepared send/);
});

test('Summarize is the yes: with nothing remembered it goes to Nebius; a run already decided is not an error', async () => {
  const dir = await home();
  await writeFile(join(dir, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }]));
  const { send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const result = await summarizeRun({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER });
  assert.equal(result.provider, 'nebius');
  assert.equal((await decidedOf(dir, send.run)).length, 1);
  assert.equal(calls.length, 1, 'the summary ran once');
  assert.deepEqual(await summarizeRun({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER }), { ok: true, run: send.run, already: true });
  assert.equal(calls.length, 1, 'a second press sends nothing');
  const racing = await callSend(dir);
  await appendEvent(join(runsRoot(dir), racing.send.run), { type: 'send.decided', step: 'ask', text: 'You decided', data: { run: racing.send.run, decision: 'yes', picker_shown: false, auto: true } });
  assert.deepEqual(await summarizeRun({ home: dir, run: racing.send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER }), { ok: true, run: racing.send.run, already: true }, 'the automatic yes is writing: no picker');
  const waitingPick = await callSend(dir);
  await appendEvent(join(runsRoot(dir), waitingPick.send.run), { type: 'send.decided', step: 'ask', text: 'You decided', data: { run: waitingPick.send.run, decision: 'yes', picker_shown: true } });
  // Changed with Codex review finding 3 (2026-10-23): a yes left at its picker is answered by the press once an AI is
  // connected; with none connected it still gets the picker back.
  assert.equal((await summarizeRun({ home: dir, run: waitingPick.send.run, checks: connected(false, false), runner, transcriber: TRANSCRIBER })).picker, true, 'a yes left at its picker, still no AI: the picker back');
  assert.equal(calls.length, 1);
  assert.equal((await summarizeRun({ home: dir, run: waitingPick.send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER })).ok, true, 'a yes left at its picker, Nebius connected now: the press writes it');
  assert.equal(calls.length, 2);
  const none = await home();
  const other = await callSend(none);
  assert.equal((await summarizeRun({ home: none, run: other.send.run, checks: connected(false, false), runner, transcriber: TRANSCRIBER })).picker, true, 'no AI connected: the picker, nothing sent');
  assert.equal(calls.length, 2);
});

// first-run-polish B5.4 (S10, S11): the setup yes covers call notes. Only a send prepared at or after callsAt, with a
// saved key and today's limit not reached, is decided on its own; it goes to Nebius through approveSend and is filed
// with fileNotesOnly, never with `file` (which would start the names check and the web errands).
const STANDING = { callsYes: true, callsAt: '2026-01-01T00:00:00.000Z', keySaved: true, overBudget: false };
function filers() {
  const used = { file: [], notesOnly: [] };
  return { used, file: async (folder) => { used.file.push(folder); }, fileNotesOnly: async (folder) => { used.notesOnly.push(folder); } };
}

test('autoDecide: the setup yes for call notes decides a new call yes, on Nebius, filed with notes only', async () => {
  const dir = await home();
  const { send, folder } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const { used, file, fileNotesOnly } = filers();
  const asked = [];
  const result = await autoDecide({ home: dir, run: send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING, askCalls: () => asked.push(1) });
  assert.deepEqual([result.auto, result.ok, result.provider], [true, true, 'nebius']);
  assert.equal(calls.length, 1, 'one byo.py run');
  assert.deepEqual(calls[0].args.slice(1, 4), [folder, '--with', 'nebius']);
  const decided = await decidedOf(dir, send.run);
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0].data, { run: send.run, decision: 'yes', picker_shown: false, auto: true, by: 'calls-yes' });
  assert.deepEqual(used, { file: [], notesOnly: [folder] }, 'S11: filed with fileNotesOnly; file (names and errands) never runs');
  assert.equal(await statusOf(dir, send.run), 'sent');
  assert.deepEqual(asked, [], 'no ask when the yes is there');
  assert.equal((await allEvents(dir)).find((event) => event.type === 'ai.picked').data.provider, 'nebius');
  // A card click after it is refused as already decided, and nothing runs twice.
  await assert.rejects(decideSend({ home: dir, run: send.run, decision: 'yes', checks: connected(true, true), runner, transcriber: TRANSCRIBER, file }), /already decided/);
  assert.deepEqual(await autoDecide({ home: dir, run: send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING }), { auto: false });
  assert.equal(calls.length, 1);
  // A call on no workstream is covered too: the calls path needs none.
  const loose = await callSend(dir);
  await setWorkstream(dir, loose.send.run, 'none');
  assert.equal((await autoDecide({ home: dir, run: loose.send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING })).auto, true);
  assert.deepEqual(used.file, []);
});

test('autoDecide: without the flag, a key, budget left, a send newer than callsAt, Nebius connected or fileNotesOnly, the call waits for its card', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  const cases = [
    ['callsYes false', { ...STANDING, callsYes: false }],
    ['no standing at all', null],
    ['keySaved false', { ...STANDING, keySaved: false }],
    ['overBudget true', { ...STANDING, overBudget: true }],
    ['created before callsAt', { ...STANDING, callsAt: future }],
    ['no callsAt', { ...STANDING, callsAt: null }],
    ['Nebius not connected', STANDING, connected(false, true)],
    ['no fileNotesOnly', STANDING, connected(true, true), true],
  ];
  for (const [name, standing, checks = connected(true, true), noNotesOnly = false] of cases) {
    const dir = await home();
    const { send } = await callSend(dir);
    const { calls, runner } = recordingRunner();
    const { used, file, fileNotesOnly } = filers();
    const asked = [];
    const result = await autoDecide({ home: dir, run: send.run, checks, runner, transcriber: TRANSCRIBER, file, ...(noNotesOnly ? {} : { fileNotesOnly }), standing, askCalls: () => asked.push(name) });
    assert.deepEqual(result, { auto: false }, name);
    assert.equal(calls.length, 0, `${name}: nothing ran`);
    assert.equal((await decidedOf(dir, send.run)).length, 0, `${name}: no send.decided`);
    assert.equal(await statusOf(dir, send.run), 'pending', name);
    assert.deepEqual(used, { file: [], notesOnly: [] }, name);
    assert.equal(asked.length, standing?.callsYes === true ? 0 : 1, `${name}: the calls yes is asked for only when it is the missing piece`);
  }
});

test('autoDecide: the workstream pick still decides first and still files with file; a next move is never on the calls path', async () => {
  const dir = await rememberedHome('nebius');
  const { send, folder } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const { used, file, fileNotesOnly } = filers();
  const result = await autoDecide({ home: dir, run: send.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING });
  assert.equal(result.auto, true);
  assert.deepEqual(used, { file: [folder], notesOnly: [] });
  assert.equal('by' in (await decidedOf(dir, send.run))[0].data, false);
  const move = await prepareNextMove({ home: dir, workstream: 'Acme Bank', workstreamDirectory: join(dir, 'work', 'acme-bank'), threads: [{ id: 'thread-1', md: THREAD }], transcriber: TRANSCRIBER, runner: fakeScreenRunner() });
  assert.deepEqual(await autoDecide({ home: dir, run: move.run, checks: connected(true, true), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING, nextMove: async () => ({ ok: true }) }), { auto: false });
  assert.equal(calls.length, 1);
});

// Live 2026-10-12: a call prepared on workstream "none", then filed under Loggie from the Notes & Meetings tab. The
// picker's buttons send with remember=true, and remembering threw on "none", so the button did nothing for hours.
test('a pick with remember on a call with no workstream still sends, and a call filed later remembers on its new workstream', async () => {
  const dir = await home();
  const { folder, send } = await callSend(dir);
  await setWorkstream(dir, send.run, 'none');
  const { calls, runner } = recordingRunner();
  const result = await approveSend({ home: dir, run: send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 1, 'the summary request ran');
  assert.equal(JSON.parse(await readFile(join(dir, 'cloud-pick.json'), 'utf8')).provider, 'nebius');
  assert.equal((await readWorkstreams(dir)).some((item) => item.cloud === 'nebius'), false, 'no workstream is touched');

  const filed = await callSend(dir);
  await setWorkstream(dir, filed.send.run, 'none');
  await writeFile(join(dirname(filed.folder), 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam', workstream: 'none', filed: { workstream: 'Acme Bank', at: new Date().toISOString() }, relabeled: true }));
  const second = await approveSend({ home: dir, run: filed.send.run, provider: 'nebius', remember: true, checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.equal(second.ok, true, second.reason);
  assert.equal((await readWorkstreams(dir)).find((item) => item.name === 'Acme Bank').cloud, 'nebius');
  const picked = (await readEvents(join(runsRoot(dir), filed.send.run))).find((event) => event.type === 'ai.picked');
  assert.equal(picked.data.stream_id, 'acme-bank');
});

// Summarize again (2026-10-12): a send prepared with fresh asks the AI again (byo.py --fresh); others do not.
test('a fresh send runs byo.py with --fresh, and a plain one without it', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const path = join(runsRoot(dir), send.run, 'send.json');
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), fresh: true }));
  const { calls, runner } = recordingRunner();
  await approveSend({ home: dir, run: send.run, provider: 'nebius', checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.ok(calls[0].args.includes('--fresh'));
  const plain = await callSend(dir);
  await approveSend({ home: dir, run: plain.send.run, provider: 'nebius', checks: connected(true, true), runner, transcriber: TRANSCRIBER });
  assert.ok(!calls[1].args.includes('--fresh'));
});

// Codex review, 2026-10-23 (finding 1): a Summarize press and the automatic yes both read "no decision yet" before
// either wrote one, so both approved the same run and the call notes were sent twice. Either order, one send.
test('Summarize pressed while the automatic yes takes the run sends once, in either order', async () => {
  for (const autoFirst of [false, true]) {
    const dir = await home();
    const { send } = await callSend(dir);
    const { calls, runner } = recordingRunner();
    const { file, fileNotesOnly } = filers();
    const press = () => summarizeRun({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER });
    const auto = () => autoDecide({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER, file, fileNotesOnly, standing: STANDING });
    const [first, second] = autoFirst ? [auto, press] : [press, auto];
    const results = await Promise.allSettled([first(), second()]);
    assert.equal(calls.length, 1, `autoFirst ${autoFirst}: the notes were sent once`);
    assert.equal((await decidedOf(dir, send.run)).length, 1, `autoFirst ${autoFirst}: one send.decided`);
    assert.equal(results[autoFirst ? 1 : 0].status, 'fulfilled', `autoFirst ${autoFirst}: the press is not an error`);
    assert.equal(await statusOf(dir, send.run), 'sent');
  }
});

// Codex review, 2026-10-23 (finding 3): Summarize with no key leaves a yes at its picker; once the key is added, the
// next press is that yes answered, not the picker again ("No cloud AI is connected" for good).
test('Summarize after adding the missing key writes the waiting call, once', async () => {
  const dir = await home();
  const { send } = await callSend(dir);
  const { calls, runner } = recordingRunner();
  const noKey = await summarizeRun({ home: dir, run: send.run, checks: connected(false, false), runner, transcriber: TRANSCRIBER });
  assert.equal(noKey.picker, true, 'no key: the picker, nothing sent');
  assert.equal(calls.length, 0);
  const keyed = await summarizeRun({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER });
  assert.equal(keyed.ok, true, keyed.reason);
  assert.equal(keyed.provider, 'nebius');
  assert.equal(calls.length, 1, 'the notes were written');
  assert.equal((await decidedOf(dir, send.run)).length, 1, 'still one send.decided');
  assert.deepEqual(await summarizeRun({ home: dir, run: send.run, checks: connected(true, false), runner, transcriber: TRANSCRIBER }), { ok: true, run: send.run, already: true });
  assert.equal(calls.length, 1, 'a press after that sends nothing');
});

test('a waiting call shows the title the call has now, not the one it had when its notes were prepared', async () => {
  // Cleanup audit bug 25: an untitled call named afterwards kept "Untitled call, 2:00 PM" on its yes card.
  const dir = await home();
  const { folder } = await callSend(dir);
  await writeFile(join(dirname(folder), 'event.json'), JSON.stringify({ title: 'Coffee chat with Sam Lee' }));
  const [send] = await pendingSends(dir);
  assert.equal(send.title, 'Coffee chat with Sam Lee');
  await rm(join(dirname(folder), 'event.json'));
  assert.equal((await pendingSends(dir))[0].title, 'Coffee chat with Sam', 'no event.json: the prepared title');
});
