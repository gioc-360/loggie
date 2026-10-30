import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { check } from '../scripts/outlook-eval/check.mjs';
import { liveLines, streaks } from '../scripts/outlook-eval/gate.mjs';
import { makeTasks } from '../scripts/outlook-eval/make-tasks.mjs';
import { runScenario } from '../scripts/outlook-eval/run.mjs';
import { judge, scenarios } from '../scripts/outlook-eval/scenarios.mjs';

const A = { other: 'other@example.com', self: 'self@school.example.com', third: 'third@example.com', otherB: 'third@example.com' };
const byId = (id) => scenarios(A).find((s) => s.id === id);
const good = (extra = {}) => ({ at: '2026-10-05T12:00:00Z', mode: 'reply', status: 'replied', helperSha: 'abc', pasted: true, findings: [], candidates_checked: 2, candidates_verified: 1, candidates_total: 2,
  replied_on: { from: 'from: other, other@example.com', own: false }, audit: { to_tokens: ['other, other@example.com, available'], cc_tokens: [], own_in_recipients: false, to_fields_before: 0, to_fields_after: 1, draft_count: 1, signature_count: 1 }, ...extra });

test('make-tasks writes one task per scenario and the setup sheet, outside the repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-eval-'));
  const out = await makeTasks({ ...A, root, now: new Date('2026-10-05T12:00:00Z') });
  assert.deepEqual(out.scenarios, ['S1', 'S2', 'S3', 'S3b', 'S4a', 'S4b', 'S5', 'S6', 'S7', 'S8']);
  assert.ok((await readdir(root)).includes('task_S7'));
  const s7 = JSON.parse(await readFile(join(root, 'task_S7', 'REPLY.json'), 'utf8'));
  assert.deepEqual([s7.scenario, s7.subject, s7.original.subject, s7.original.date], ['S7', 'Re: Fwd: HKEVAL S7 forwarded note', 'Fwd: HKEVAL S7 forwarded note', '2026-10-05T12:00:00.000Z']);
  assert.equal(JSON.parse(await readFile(join(root, 'task_S3b', 'REPLY.json'), 'utf8')).cc, 'third@example.com');
  assert.match(await readFile(join(root, 'task_S1', 'DRAFT.md'), 'utf8'), /^hkeval S1 setup\n/);
  const sheet = await readFile(join(root, 'SETUP.md'), 'utf8');
  assert.match(sheet, /## S2: second reply, the newest message is your own\n- From other@example\.com to self@school\.example\.com: subject "HKEVAL S2 newest is mine"\.\n- In Outlook, reply to it/);
  assert.match(sheet, /## S6: a long thread \(more than 8 messages\) \(optional\)/);
  assert.doesNotMatch(sheet, /hk-eval/, 'no hyphen in a subject: Outlook search reads it as "not"');
});

test('judge: a clean reply passes; each way a reply can be wrong is named', () => {
  assert.deepEqual(judge(byId('S1'), good(), A), []);
  const toMe = judge(byId('S1'), good({ status: 'reply-includes-you', pasted: false, findings: ['reply-includes-you'], audit: { ...good().audit, to_tokens: ['self, self@school.example.com'], own_in_recipients: true } }), A);
  assert.ok(toMe.some((p) => /To is \[self/.test(p)) && toMe.some((p) => /own address/.test(p)) && toMe.some((p) => /status is reply-includes-you/.test(p)));
  assert.match(judge(byId('S1'), good({ audit: { ...good().audit, to_fields_after: 2 } }), A).join(), /2 reply windows opened/);
  assert.match(judge(byId('S1'), good({ helperSha: undefined }), A).join(), /old helper/);
  assert.match(judge(byId('S3'), good({ audit: { ...good().audit, cc_tokens: ['third, third@example.com'] } }), A).join(), /Cc is \[third/, 'S3 is Reply, not Reply all');
});

test('judge: S2 wants Reply all on your own newer note; S4 must verify exactly one sender; S7 answers the forwarder', () => {
  assert.match(judge(byId('S2'), good(), A).join(), /expected your own newer note/);
  assert.deepEqual(judge(byId('S2'), good({ replied_on: { from: 'from: self', own: true } }), A), []);
  assert.match(judge(byId('S4b'), good(), A).join(), /expected only third@example\.com/);
  assert.deepEqual(judge(byId('S4a'), good({ candidates_verified: 2 }), A), [], 'one conversation: both rows may show the right sender');
  assert.match(judge(byId('S4a'), good({ candidates_total: 1 }), A).join(), /expected both same-subject emails/);
  assert.match(judge(byId('S7'), good({ audit: { ...good().audit, to_tokens: ['third, third@example.com'] } }), A).join(), /original author, not the forwarder/);
});

test('judge: S5 must stop with nothing opened; S3b passes only by failing as planned; S8 needs a reply open first; S6 needs more than 8 rows', () => {
  assert.deepEqual(judge(byId('S5'), { mode: 'not-found', status: 'no-match', helperSha: 'abc' }, A), []);
  assert.match(judge(byId('S5'), good(), A).join(), /mode is reply/);
  assert.deepEqual(judge(byId('S3b'), good({ status: 'audit-cc-missing', findings: ['audit-cc-missing'] }), A), []);
  assert.match(judge(byId('S3b'), good(), A).join(), /expected the draft pasted with audit-cc-missing/);
  assert.match(judge(byId('S8'), good(), A).join(), /no reply was open before the run/);
  assert.deepEqual(judge(byId('S8'), good({ audit: { ...good().audit, to_fields_before: 1, to_fields_after: 2 } }), A), []);
  assert.match(judge(byId('S6'), good({ candidates_total: 8 }), A).join(), /needs more than 8 messages/);
});

test('check records each verdict; streaks count trailing passes on one helper version, and a failure or a new version resets them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-eval-'));
  await makeTasks({ ...A, root });
  await appendFile(join(root, 'task_S1', 'ATTEMPTS.jsonl'), `${JSON.stringify(good())}\n`);
  assert.equal((await check('S1', { root })).pass, true);
  await appendFile(join(root, 'task_S1', 'ATTEMPTS.jsonl'), `${JSON.stringify(good({ status: 'reply-wrong-recipient', findings: ['reply-wrong-recipient'] }))}\n`);
  const failed = await check('S1', { root });
  assert.equal(failed.pass, false);
  const checks = (await readFile(join(root, 'CHECKS.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(checks.map((c) => [c.scenario, c.pass, c.helperSha]), [['S1', true, 'abc'], ['S1', false, 'abc']]);
  const history = [...checks, { scenario: 'S1', pass: true, helperSha: 'abc' }, { scenario: 'S1', pass: true, helperSha: 'abc' }, { scenario: 'S2', pass: true, helperSha: 'old' }];
  assert.deepEqual(streaks(history, 'abc'), { S1: 2 });
  const lines = liveLines(history, 'abc', scenarios(A));
  assert.deepEqual(lines.find((l) => l.name.startsWith('live S1 ')), { name: 'live S1 first reply', ok: false, detail: '2 of 3 in a row' });
  assert.equal(lines.find((l) => l.name.startsWith('live S2 ')).ok, false, 'a pass on another helper version does not count');
  assert.equal(lines.some((l) => l.name.startsWith('live S6 ')), false, 'the optional long thread is required only once it has been run');
});

test('run: a fresh draft id per run, Loggie opens it with --again, and S8 must refuse a second copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-eval-'));
  await makeTasks({ ...A, root });
  const calls = [];
  const execImpl = async (_node, args, options) => {
    calls.push(args.slice(1));
    const task = join(options.cwd, args[2]);
    if (args.includes('--again')) {
      const draft = await readFile(join(task, 'DRAFT.md'), 'utf8');
      await appendFile(join(task, 'ATTEMPTS.jsonl'), `${JSON.stringify(good({ draft: draft.split('\n')[0], audit: { ...good().audit, to_fields_before: 1, to_fields_after: 2 } }))}\n`);
      return { stdout: 'Opened as a reply in Outlook.' };
    }
    return { stdout: 'Opened as a new message.' };   // not refused: the duplicate guard failed
  };
  const s1 = await runScenario('S1', { root, execImpl, now: new Date('2026-10-05T12:34:56Z') });
  assert.equal(s1.verdict.pass, true); assert.deepEqual(calls[0], ['draft', 'task_S1', '--again']);
  assert.match(await readFile(join(root, 'task_S1', 'DRAFT.md'), 'utf8'), /^hkeval S1 20261005T123456\n/);
  const s8 = await runScenario('S8', { root, execImpl });
  assert.equal(s8.verdict.pass, false); assert.match(s8.verdict.problems.join(), /second run without --again was not refused/);
  assert.equal(JSON.parse((await readFile(join(root, 'CHECKS.jsonl'), 'utf8')).trim().split('\n').at(-1)).pass, false, 'the recorded verdict carries the S8 failure too');
});
