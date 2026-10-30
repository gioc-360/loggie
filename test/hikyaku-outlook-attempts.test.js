import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXPECTED, openDraft, replyExpectation, replyText } from '../src/hikyaku/draft.js';
import { outlookReply } from '../src/hikyaku/outlook.js';
import { metrics, readAttemptLines, report } from '../scripts/outlook-eval/metrics.mjs';

async function task({ reply = {}, settings = null } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'hikyaku-attempt-'));
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-home-'));
  await writeFile(join(folder, 'DRAFT.md'), 'Hi Sam,\n\nThursday works.\n\nBest regards,');
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: 'sam@example.com', subject: 'Re: Budget', account: 'me@school.example.com',
    original: { from: 'Sam@Example.com', date: '2026-10-01T02:46:48.000Z', subject: 'Budget' }, ...reply }));
  if (settings) await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook', ...settings }));
  else await writeFile(join(home, 'settings.json'), '{"mailApp": "outlook"}');
  return { folder, home };
}
const spawnImpl = () => ({ unref() {} });
const lastAttempt = async (folder) => JSON.parse((await readFile(join(folder, 'ATTEMPTS.jsonl'), 'utf8')).trim().split('\n').at(-1));

test('the expectation comes from the task alone: the person, every address of the user, To, Cc, the draft\'s first line', () => {
  const e = replyExpectation({ reply: { to: 'Sam <sam@example.com>', cc: 'ta@example.com; prof@example.com', subject: 'Re: Budget', account: 'me@gmail.example.com', scenario: 'S3' },
    original: { from: 'Sam@Example.com', date: '2026-10-01T02:46:48.000Z' }, body: '\n\nHi Sam,\nThursday works.', ownAddresses: ['me@school.example.com', 'ME@gmail.example.com'] });
  assert.deepEqual(e, { sender: 'sam@example.com', me: ['me@gmail.example.com', 'me@school.example.com'], to: ['sam@example.com'], cc: ['ta@example.com', 'prof@example.com'],
    subject: 'Re: Budget', date: '2026-10-01T02:46:48.000Z', draft: 'Hi Sam,', scenario: 'S3' });
});

test('a live reply gets the expectation file, its own snapshot folder, and logs what the helper saw', async () => {
  const { folder, home } = await task({ reply: { scenario: 'S1' }, settings: { ownAddresses: ['me@gmail.example.com'] } });
  let seen = null;
  const replyImpl = async (input) => {
    seen = { ...input, expected: JSON.parse(await readFile(input.expectFile, 'utf8')) };
    return { status: 'replied', detail: 'Reply opened.', pasted: true, findings: [], how: 'press', helperSha: 'abc123', steps_ms: { search: 900 },
      candidates_total: 2, candidates_checked: 2, candidates_verified: 1, candidates_rejected: [{ reason: 'date' }],
      replied_on: { from: 'from: sam, sam@example.com', own: false, day: '2026-09-30' }, audit: { to_tokens: ['sam, sam@example.com'], to_fields_before: 0, to_fields_after: 1 } };
  };
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, replyImpl });
  assert.equal(result.mode, 'reply');
  assert.equal(seen.expectFile, join(folder, EXPECTED));
  assert.deepEqual(seen.expected.me, ['me@school.example.com', 'me@gmail.example.com'], 'settings ownAddresses join the triage account');
  assert.equal(seen.expected.draft, 'Hi Sam,');
  assert.match(seen.snapshotDir, new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/outlook-runs/hikyaku-attempt-[^/]+/2\\d{3}-`), 'snapshots stay in hikyaku\'s own folder');
  const line = await lastAttempt(folder);
  assert.deepEqual([line.scenario, line.helperSha, line.how, line.candidates_verified, line.replied_on.day, line.audit.to_fields_after], ['S1', 'abc123', 'press', 1, '2026-09-30', 1]);
  assert.ok(Number.isInteger(line.ms) && line.at);
});

test('a reply opened with findings counts as opened and names every finding; a stop finding opens nothing else', async () => {
  const { folder, home } = await task();
  const flagged = await openDraft({ taskDirectory: folder, home, spawnImpl, replyImpl: async () => ({ status: 'audit-double-sign-off', pasted: true, helperSha: 'abc',
    findings: ['audit-double-sign-off', 'audit-cc-missing'], finding_messages: ['The reply has 2 closing lines; delete one.', 'Add ta@example.com on Cc yourself.'] }) });
  assert.equal(flagged.mode, 'reply');
  assert.match(flagged.detail, /Check before sending: The reply has 2 closing lines; delete one\. Add ta@example\.com on Cc yourself\./);
  assert.deepEqual((await lastAttempt(folder)).findings, ['audit-double-sign-off', 'audit-cc-missing']);
  const opened = [];
  const stopped = await openDraft({ taskDirectory: folder, home, again: true, clipboardImpl: async () => {}, spawnImpl: (...a) => { opened.push(a); return { unref() {} }; },
    replyImpl: async () => ({ status: 'reply-includes-you', pasted: false, helperSha: 'abc', findings: ['reply-includes-you'] }) });
  assert.equal(stopped.mode, 'clipboard'); assert.match(stopped.reason, /addressed to you.*Close that reply/); assert.deepEqual(opened.map(([command, args]) => [command, args]), [['open', ['-a', 'Microsoft Outlook']]]);
  assert.deepEqual((await lastAttempt(folder)).findings, ['reply-includes-you']);
});

test('snapshot folders are kept to the newest ten per task', async () => {
  const { folder, home } = await task();
  const runs = join(home, 'outlook-runs', folder.split('/').at(-1));
  await mkdir(runs, { recursive: true });
  for (let i = 0; i < 12; i += 1) await mkdir(join(runs, `2026-10-0${Math.floor(i / 10)}T0${i % 10}-00-00-000Z`));
  await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl: async () => {}, replyImpl: async () => ({ status: 'no-match' }) });
  assert.equal((await readdir(runs)).length, 9, 'nine old ones remain; the run makes the tenth');
});

test('the helper is given the expectation and the snapshot folder, and its version goes into the result', async () => {
  let args = null;
  const execImpl = async (file, a) => { if (file === '/usr/bin/defaults') return { stdout: '16.1\n' }; args = a; return { stdout: '{"status":"replied","findings":[]}\n' }; };
  const result = await outlookReply({ original: { from: 'sam@example.com', subject: 'Budget' }, body: 'Hi', helper: '/h', execImpl, writeBody: async () => '/tmp/b', expectFile: '/t/e.json', snapshotDir: '/s/run' });
  assert.deepEqual(args.slice(args.indexOf('--expect'), args.indexOf('--expect') + 2), ['--expect', '/t/e.json']);
  assert.deepEqual(args.slice(args.indexOf('--snapshot-dir'), args.indexOf('--snapshot-dir') + 2), ['--snapshot-dir', '/s/run']);
  assert.match(result.helperSha, /^[0-9a-f]{12}$/); assert.equal(result.outlookVersion, '16.1');
});

test('metrics: silent-wrong counts a "replied" run with findings, and fails the script; runs before the audit are not judged', async () => {
  const lines = [
    { status: 'replied', mode: 'reply', ms: 9000 },                                                                              // before the audit
    { status: 'replied', mode: 'reply', ms: 12000, helperSha: 'a', findings: [], pasted: true, audit: { to_fields_before: 0, to_fields_after: 1, windows_before: 1, windows_after: 1 } },
    { status: 'audit-double-sign-off', mode: 'reply', ms: 15000, helperSha: 'a', findings: ['audit-double-sign-off'], pasted: true },
    { status: 'reply-includes-you', mode: 'not-found', ms: 14000, helperSha: 'a', findings: ['reply-includes-you'], pasted: false, audit: { to_fields_before: 0, to_fields_after: 1 } },
    { status: 'no-match', mode: 'not-found', ms: 30000, helperSha: 'a', findings: [] },
    { status: 'replied', mode: 'reply', ms: 50000, helperSha: 'a', findings: [], pasted: true, audit: { to_fields_before: 0, to_fields_after: 2 } },
    { mode: 'event', opened: 'outlook' }, { status: 'dry-run', mode: 'dry-run' },
  ];
  const m = metrics(lines);
  assert.deepEqual([m.runs, m.unaudited, m.audited, m.silentWrong, m.placedClean, m.placedWithFindings, m.stopped, m.stoppedHonestly, m.wrongRecipientStopped, m.strayWindows],
    [6, 1, 5, 0, 2, 1, 2, 2, 1, 1]);
  assert.deepEqual([m.p50ms, m.p95ms], [15000, 50000]);
  assert.equal(metrics([...lines, { status: 'replied', helperSha: 'a', findings: ['audit-extra-window'], at: 'T' }]).silentWrong, 1);
  assert.match(report(m), /│ silent-wrong {15}│ {8}0 │ 0, ever/);
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-metrics-'));
  await mkdir(join(dir, 'p', 'task_1'), { recursive: true });
  await writeFile(join(dir, 'p', 'task_1', 'ATTEMPTS.jsonl'), `${JSON.stringify(lines[1])}\nnot json\n`);
  assert.equal((await readAttemptLines([dir])).length, 1, 'a torn line is skipped, not fatal');
});

test('an Outlook reply keeps its closing line and gets the user\'s name; new messages still drop it when the signature has one', async () => {
  assert.equal(replyText('Hi Sam,\n\nThursday works.\n\nBest regards,', 'Lee'), 'Hi Sam,\n\nThursday works.\n\nBest regards,\nLee');
  assert.equal(replyText('Hi Sam,\n\nThursday works.\n\nThank you,\nLee', 'Lee'), 'Hi Sam,\n\nThursday works.\n\nThank you,\nLee', 'a name already there comes out once');
  assert.equal(replyText('Hi Sam,\nThursday works.', 'Lee'), 'Hi Sam,\nThursday works.', 'no closing line, no name added');
  assert.equal(replyText('Hi Sam,\n\nBest regards,', ''), 'Hi Sam,\n\nBest regards,');
  const { folder, home } = await task({ settings: { signOffInSignature: true, signName: 'Lee' } });
  let pasted = null;
  await openDraft({ taskDirectory: folder, home, spawnImpl, replyImpl: async (input) => { pasted = input.body; return { status: 'replied', pasted: true, findings: [] }; } });
  assert.equal(pasted, 'Hi Sam,\n\nThursday works.\n\nBest regards,\nLee');
});
