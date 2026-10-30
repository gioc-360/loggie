// Do it, end to end on fakes: Core in memory, the real cloud gate on a made-up workstream, the real headless runner
// with a fake Token Factory behind nebius-draft.js, and a stand-in for the mail app. No network, no Outlook.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { answerMove, doIt } from '../src/hikyaku/do-it.js';
import { startHeadless } from '../src/hikyaku/headless.js';
import { draftPrompt, parseDraftAnswer, parseNebiusRun } from '../src/hikyaku/nebius-draft.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { taskCore } from './helpers/fake-core.js';

const TASK = 'task_1';

const memoryCore = (status = 'waiting') => taskCore({ id: TASK, projectId: 'p1', status, title: 'Follow up with Dana on interview status' });

async function world({ cloud = 'nebius', status = 'waiting', state = null, draft = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-do-it-'));
  const directoryPath = join(home, 'work', 'acme-bank');
  const taskDirectory = join(directoryPath, TASK);
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(join(home, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', ...(cloud ? { cloud } : {}) }]));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ frontier: 'nebius', mailApp: 'outlook' }));
  await writeFile(join(directoryPath, 'CONTEXT.md'), '# Acme Bank\nRecruiting with Acme Bank.\n');
  await writeFile(join(taskDirectory, 'BRIEF.md'), '# Follow up with Dana on interview status\n');
  await writeFile(join(taskDirectory, 'THREAD.md'), 'From: Dana\nI just sent the recruiter an email. Write to dana@acme.example if anything changes.\n');
  if (state) await writeFile(join(taskDirectory, 'STATE.json'), JSON.stringify(state));
  if (draft) await writeFile(join(taskDirectory, 'DRAFT.md'), draft);
  const voice = join(home, 'voice');
  await mkdir(voice, { recursive: true });
  await writeFile(join(voice, 'rules.md'), 'Keep it short.\n');
  const core = memoryCore(status);
  core.directoryPath = directoryPath;
  return { home, directoryPath, taskDirectory, voice, core };
}

// The screened path main.js builds (cloud-screen.js thinkWith under the workstream's yes), on a fake Token Factory.
function fakeFactory(content) {
  const sent = [];
  const nebiusClient = { post: async (body, { path }) => { sent.push({ body: JSON.parse(body), path }); return { content: typeof content === 'function' ? content() : content, finish_reason: 'stop', model: 'nvidia/x', usage: {}, seconds: 0.1, copies: 1 }; } };
  const complete = thinkWith({ settings: { thinker: 'cloud' }, maxTokens: 3000, consent: consentFor('mail', { workstream: { name: 'Acme Bank', cloud: 'nebius' } }), what: 'the Acme Bank mail', path: 'do-it', nebiusClient, log: () => {} });
  return { sent, complete };
}

// The real runner, with the fake factory, the test's voice folder and a mail-app stand-in. No spawnImpl: the default
// nebiusSpawn path runs, on the complete draftComplete hands it.
function runner({ voice, client, opened }) {
  return (args) => startHeadless({ ...args, voiceImpl: async () => voice, draftComplete: async () => client.complete,
    openDraftImpl: async ({ taskDirectory }) => { opened.push(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8')); return { opened: 'outlook', mode: 'reply', to: 'dana@acme.example', detail: 'The reply is open in Outlook with the draft in it.' }; } });
}

const DRAFT = JSON.stringify({ file: 'DRAFT.md', content: 'Hi Dana,\n\nThanks for reaching out to the recruiter. Any news on my application?\n\nBest regards,', subject: '' });

test('a workstream approved for nebius drafts on Nebius and the draft opens: the press says so', async () => {
  const w = await world();
  const client = fakeFactory(DRAFT);
  const opened = [];
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl: runner({ voice: w.voice, client, opened }) });
  assert.equal(result.phase, 'in-mail-app');
  assert.match(result.text, /open in Outlook/);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /Any news on my application/);
  assert.equal(client.sent.length, 1, 'one request per Do it');
  assert.equal(client.sent[0].path, 'do-it', 'the ledger names Do it');
  const sentText = JSON.stringify(client.sent[0].body);
  assert.match(sentText, /I just sent the recruiter an email/, 'the thread is read');
  assert.match(sentText, /Keep it short/, 'the voice rules are read');
  assert.ok(!sentText.includes('dana@acme.example'), 'the screen cut the address on this Mac');
  assert.match(sentText, /\[address kept on this Mac\]/);
  const state = JSON.parse(await readFile(join(w.taskDirectory, 'STATE.json'), 'utf8'));
  assert.equal(state.agent, 'nebius');
});

test('a workstream with no approval is refused out loud, with an approve answer; approving drafts it', async () => {
  const w = await world({ cloud: null });
  const client = fakeFactory(DRAFT);
  const opened = [];
  const startImpl = runner({ voice: w.voice, client, opened });
  const refused = await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl });
  assert.equal(refused.started, false, 'never "started" when nothing ran');
  assert.equal(refused.kind, 'cloud-off');
  assert.match(refused.text, /Answer "approve"/);
  assert.equal(client.sent.length, 0, 'nothing was read or sent');
  assert.equal(w.core.task.status, 'briefed', 'a briefed task is never pushed into a state Core forbids');
  const approved = await answerMove({ core: w.core, taskId: TASK, answer: 'approve', home: w.home, startImpl });
  assert.equal(approved.phase, 'in-mail-app');
  assert.equal(JSON.parse(await readFile(join(w.home, 'workstreams.json'), 'utf8'))[0].cloud, 'nebius');
  assert.equal(client.sent.length, 1);
});

test('a move stuck on "email not found" reopens its kept draft: no new run, no new cost', async () => {
  const w = await world({ status: 'blocked', state: { phase: 'needs-you', kind: 'reply-not-found', question: 'The Outlook helper failed.', agent: 'claude' }, draft: 'Hi Dana, kept draft.' });
  const client = fakeFactory(DRAFT);
  const looked = [];
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl: runner({ voice: w.voice, client, opened: [] }),
    openDraftImpl: async (options) => { looked.push(options); return { opened: 'outlook', mode: 'reply', to: 'dana@acme.example', detail: 'The reply is open in Outlook with the draft in it.' }; } });
  assert.equal(result.phase, 'in-mail-app');
  assert.equal(looked.length, 1);
  assert.equal(looked[0].again, true);
  assert.equal(client.sent.length, 0);
});

test('a failed run starts again from blocked, and an open question is shown again, never rerun', async () => {
  const failed = await world({ status: 'blocked', state: { phase: 'failed', question: 'The drafting run failed. Try again?' } });
  const client = fakeFactory(DRAFT);
  const result = await doIt({ core: failed.core, taskId: TASK, home: failed.home, startImpl: runner({ voice: failed.voice, client, opened: [] }) });
  assert.equal(result.phase, 'in-mail-app');
  assert.deepEqual(failed.core.calls.map((call) => call[1]).slice(0, 3), ['waiting', 'briefed', 'running']);

  const asked = await world({ status: 'blocked', state: { phase: 'needs-you', kind: 'question', question: 'Which day suits you?' } });
  const quiet = fakeFactory(DRAFT);
  const again = await doIt({ core: asked.core, taskId: TASK, home: asked.home, startImpl: runner({ voice: asked.voice, client: quiet, opened: [] }) });
  assert.equal(again.text, 'Which day suits you?');
  assert.equal(quiet.sent.length, 0);
});

test('a bad answer from the cloud AI is a failed run with the reason in words', async () => {
  const w = await world();
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl: runner({ voice: w.voice, client: fakeFactory('Sure! Here is a draft.'), opened: [] }) });
  assert.equal(result.phase, 'failed');
  assert.match(result.text, /agreed shape/);
});

test('nebius-draft reads only the room and the voice, and parses each result file', async () => {
  const w = await world();
  const { files, text } = await draftPrompt({ prompt: `Read ${TASK}/BRIEF.md. Voice in ${w.voice}/rules.md`, room: w.directoryPath, taskId: TASK, voiceDirectory: w.voice });
  assert.deepEqual(files, ['CONTEXT.md', `${TASK}/BRIEF.md`, `${TASK}/THREAD.md`, 'voice/rules.md']);
  assert.equal(parseDraftAnswer('{\n  "file": "DRAFT.md",\n  "content": "Hi Dana,\n\nSee you Friday.\n\nBest,"\n}').content, 'Hi Dana,\n\nSee you Friday.\n\nBest,', 'raw line breaks inside the string');
  assert.ok(!text.includes(w.voice), 'the Mac\'s own paths never cross');
  assert.equal(parseDraftAnswer('```json\n{"file":"DONE.md","content":"Already handled."}\n```').file, 'DONE.md');
  assert.equal(parseDraftAnswer('{"file":"EVENT.json","content":{"title":"Chat"}}').ok, true);
  assert.equal(parseDraftAnswer('{"file": "DRAFT.md", "content": "Hi {Dana}, \\"quoted\\"\\n\\nBest,"}]}').content, 'Hi {Dana}, "quoted"\n\nBest,', 'stray brackets after a whole object (live 2026-10-10)');
  assert.equal(parseDraftAnswer('{"file":"EVENT.json","content":"not json"}').ok, false);
  assert.equal(parseDraftAnswer('{"file":"../x","content":"y"}').ok, false);
  assert.ok(!parseDraftAnswer('{"file":"DRAFT.md","content":"I wanted to follow up\u2014I have an interview."}').content.includes('\u2014'), 'no em dash in a draft');
  assert.deepEqual(parseNebiusRun('{"type":"nebius","ok":false,"text":"","error":"boom"}\n'), { sessionId: null, ok: false, text: '', denied: [], error: 'boom' });
});

test('a slow reply is queued: the press returns at once and the outcome arrives later, once', async () => {
  const w = await world({ status: 'blocked', state: { phase: 'needs-you', kind: 'reply-not-found', question: 'The Outlook helper failed.', agent: 'claude' }, draft: 'Hi Dana, kept draft.' });
  let finish;
  const later = new Promise((resolve) => { finish = resolve; });
  const heard = [];
  const t0 = Date.now();
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, waitMs: 50, onDone: (outcome) => heard.push(outcome),
    openDraftImpl: () => later });
  assert.equal(result.phase, 'queued');
  assert.match(result.text, /Keep working/);
  assert.ok(Date.now() - t0 < 1000, 'the press does not wait for Outlook');
  finish({ opened: 'outlook', mode: 'reply', to: 'dana@acme.example', detail: 'The reply is open in Outlook with the draft in it.' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(heard.length, 1);
  assert.deepEqual([heard[0].taskId, heard[0].phase], [TASK, 'in-mail-app']);
  assert.equal(JSON.parse(await readFile(join(w.taskDirectory, 'STATE.json'), 'utf8')).phase, 'in-mail-app');
});

test('a reply that only reached the clipboard is placed again by the next Do it', async () => {
  const w = await world({ status: 'blocked', state: { phase: 'in-mail-app', kind: 'clipboard', detail: 'Draft copied. Paste it in the reply (Cmd+V).' }, draft: 'Hi Dana, kept draft.' });
  const looked = [];
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, openDraftImpl: async (options) => { looked.push(options.again); return { opened: 'outlook', mode: 'reply', to: 'dana@acme.example', detail: 'The reply is open in Outlook with the draft in it.' }; } });
  assert.deepEqual([result.phase, result.kind, looked], ['in-mail-app', null, [true]]);
});

test('a kept draft is reused only while it is fresh: a day old, or older than the notes, is written again', async () => {
  const stuck = { phase: 'needs-you', kind: 'reply-not-found', question: 'The Outlook helper failed.', agent: 'claude' };
  const old = await world({ status: 'blocked', state: stuck, draft: 'Hi Dana, any news on my application?' });
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await utimes(join(old.taskDirectory, 'DRAFT.md'), twoDaysAgo, twoDaysAgo);
  await utimes(join(old.taskDirectory, 'THREAD.md'), twoDaysAgo, twoDaysAgo);
  const client = fakeFactory(DRAFT);
  const reopened = [];
  const result = await doIt({ core: old.core, taskId: TASK, home: old.home, startImpl: runner({ voice: old.voice, client, opened: reopened }), openDraftImpl: async () => { throw new Error('the stale draft was reused'); } });
  assert.equal(result.phase, 'in-mail-app');
  assert.equal(client.sent.length, 1, 'a fresh draft was written');

  const noted = await world({ status: 'blocked', state: stuck, draft: 'Hi Dana, any news?' });
  const before = new Date(Date.now() - 60 * 1000);
  await utimes(join(noted.taskDirectory, 'DRAFT.md'), before, before);
  await utimes(join(noted.taskDirectory, 'THREAD.md'), before, before);
  await writeFile(join(noted.taskDirectory, 'NOTES.md'), 'I already have an interview this coming Friday.\n');
  const second = fakeFactory(DRAFT);
  await doIt({ core: noted.core, taskId: TASK, home: noted.home, startImpl: runner({ voice: noted.voice, client: second, opened: [] }), openDraftImpl: async () => { throw new Error('the draft older than the notes was reused'); } });
  assert.equal(second.sent.length, 1);
  assert.match(JSON.stringify(second.sent[0].body), /interview this coming Friday/, 'the notes reach the draft');
});

test('a draft already open is shown as open, until the user adds notes after it: then Do it writes it again', async () => {
  const open = { phase: 'in-mail-app', detail: 'The reply is open in Outlook with the draft in it.' };
  const w = await world({ status: 'running', state: open, draft: 'Hi Dana, any news?' });
  const quiet = fakeFactory(DRAFT);
  assert.match((await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl: runner({ voice: w.voice, client: quiet, opened: [] }) })).text, /open in Outlook/);
  assert.equal(quiet.sent.length, 0);
  const later = new Date(Date.now() + 1000);
  await writeFile(join(w.taskDirectory, 'NOTES.md'), 'I already have an interview this coming Friday.\n');
  await utimes(join(w.taskDirectory, 'NOTES.md'), later, later);
  const client = fakeFactory(DRAFT);
  const result = await doIt({ core: w.core, taskId: TASK, home: w.home, startImpl: runner({ voice: w.voice, client, opened: [] }) });
  assert.equal(client.sent.length, 1);
  assert.equal(result.phase, 'in-mail-app');
});

test('steps the notes overrule leave the move: code drops only numbered steps that exist, renumbers, keeps a backup', async () => {
  const { dropStaleSteps } = await import('../src/hikyaku/nebius-draft.js');
  const w = await world();
  const brief = '# Follow up with Dana\n\n## Steps\n1. Thank Dana and ask about the application\n2. Request an on-site or Zoom interview slot\n3. Offer times\n\n## Done when\n- A reply.\n';
  await writeFile(join(w.taskDirectory, 'BRIEF.md'), brief);
  assert.deepEqual(await dropStaleSteps(w.taskDirectory, [2]), [], 'no notes, nothing dropped');
  await writeFile(join(w.taskDirectory, 'NOTES.md'), 'I already have an interview this coming Friday.\n');
  assert.deepEqual(await dropStaleSteps(w.taskDirectory, [9]), [], 'a step the brief does not have');
  const dropped = await dropStaleSteps(w.taskDirectory, [2], { now: new Date('2026-10-10T23:40:00Z') });
  assert.deepEqual(dropped, ['2. Request an on-site or Zoom interview slot']);
  const after = await readFile(join(w.taskDirectory, 'BRIEF.md'), 'utf8');
  assert.match(after, /1\. Thank Dana and ask about the application\n2\. Offer times\n/);
  assert.match(after, /Left out because of your notes, 2026-10-10: Request an on-site or Zoom interview slot/);
  assert.match(after, /## Done when\n- A reply\./);
  assert.equal(await readFile(join(w.taskDirectory, 'BRIEF.md.before-notes-2026-10-10T23-40-00-000Z'), 'utf8'), brief);
  assert.equal(parseDraftAnswer('{"skip_steps":[2,"x",2],"file":"DRAFT.md","content":"Hi"}').skipSteps.join(), '2');
});
