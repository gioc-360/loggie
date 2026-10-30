import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OUTLOOK_FLOOR_MS, openDraft } from '../src/hikyaku/draft.js';
import { REASONS, outlookReply } from '../src/hikyaku/outlook.js';
import { openedOutcome } from '../src/hikyaku/headless.js';

const DETAIL = 'Draft copied. Paste it in the reply (Cmd+V).';
const REPLY_BODY = 'Hi Sam,\n\nThursday works.\n\nBest regards,\nLena';

async function task() {
  const folder = await mkdtemp(join(tmpdir(), 'hikyaku-floor-'));
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-floor-home-'));
  await writeFile(join(folder, 'DRAFT.md'), 'Hi Sam,\n\nThursday works.\n\nBest regards,');
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: 'sam@example.com', subject: 'Re: Budget', account: 'me@school.example.com',
    original: { from: 'Sam@Example.com', date: '2026-10-01T02:46:48.000Z', subject: 'Budget' } }));
  await writeFile(join(home, 'settings.json'), '{"mailApp": "outlook", "signName": "Lena"}');
  return { folder, home };
}
function fakes() {
  const copied = [], spawned = [];
  return { copied, spawned, clipboardImpl: async (text) => { copied.push(text); },
    spawnImpl: (...call) => { spawned.push(call); return { unref() {} }; } };
}

test('the floor waits at most sixty seconds by default (C4b: a long thread verified in 34 s on a live Mac; the wait is hidden)', () => { assert.equal(OUTLOOK_FLOOR_MS, 60000); });

// C4b: the limit is also the helper's own exec timeout, so a slow reply is killed and never lands after the floor.
test('the Outlook helper is given the floor limit as its exec timeout', async () => {
  const seen = [];
  const execImpl = async (command, args, options) => { seen.push({ command, options }); return { stdout: '{"status":"dry-run"}' }; };
  await outlookReply({ original: { from: 'a@example.com', subject: 'S' }, dryRun: true, execImpl, helper: '/bin/fake-outlook', timeoutMs: 1234 });
  assert.equal(seen.find((call) => call.command === '/bin/fake-outlook').options.timeout, 1234);
  const plain = [];
  await outlookReply({ original: { from: 'a@example.com', subject: 'S' }, dryRun: true, execImpl: async (command, args, options) => { plain.push({ command, options }); return { stdout: '{"status":"dry-run"}' }; }, helper: '/bin/fake-outlook' });
  assert.equal(plain.find((call) => call.command === '/bin/fake-outlook').options.timeout, 60000, 'callers without a limit keep the old 60 s');
});

for (const status of ['no-match', 'reply-includes-you', 'audit-forward-not-reply', 'error', 'something-new']) {
  test(`a reply that cannot be placed (${status}) copies the draft and brings Outlook forward, nothing else`, async () => {
    const { folder, home } = await task();
    const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
    const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: async () => ({ status, detail: 'boom', pasted: false }) });
    assert.deepEqual(copied, [REPLY_BODY], 'the reply body reaches the clipboard exactly');
    assert.deepEqual(spawned.map(([command, args]) => [command, args]), [['open', ['-a', 'Microsoft Outlook']]], 'Outlook is opened with open -a and nothing else');
    assert.deepEqual([result.opened, result.mode, result.to, result.detail, result.status], ['outlook', 'clipboard', 'sam@example.com', DETAIL, status]);
    assert.equal(result.reason, REASONS[status] && status !== 'error' ? REASONS[status] : `${REASONS.error} boom`);
    const line = JSON.parse((await readFile(join(folder, 'ATTEMPTS.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(line.mode, 'clipboard');
  });
}

// Outlook running with its window closed was the usual state when Do it failed (2026-10-10, live): it is opened the
// way the Dock does and the reply is tried once more before the floor.
for (const status of ['no-window', 'no-outlook']) {
  test(`${status}: Outlook is opened and the reply tried once more; a second miss takes the floor`, async () => {
    const { folder, home } = await task();
    const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
    const answers = [{ status }, { status: 'replied', pasted: true, detail: 'The reply is open in Outlook with the draft in it.' }];
    const tries = [];
    const placed = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, reopenWaitMs: 0, replyImpl: async () => { tries.push(1); return answers.shift(); } });
    assert.equal(tries.length, 2);
    assert.deepEqual(spawned.map(([command, args]) => [command, args]), [['open', ['-a', 'Microsoft Outlook']]]);
    assert.deepEqual([placed.mode, copied.length], ['reply', 0]);

    const again = await task();
    const second = fakes();
    const missed = await openDraft({ taskDirectory: again.folder, home: again.home, spawnImpl: second.spawnImpl, clipboardImpl: second.clipboardImpl, reopenWaitMs: 0, replyImpl: async () => ({ status }) });
    assert.equal(missed.mode, 'clipboard');
    assert.equal(second.spawned.length, 2, 'once to reopen, once for the floor');
  });
}

test('the plain reason comes from REASONS', async () => {
  const { folder, home } = await task();
  const { clipboardImpl, spawnImpl } = fakes();
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: async () => ({ status: 'no-match' }) });
  assert.equal(result.reason, REASONS['no-match']);
  assert.equal(result.status, 'no-match');
});

test('not-trusted opens Accessibility settings and also takes the floor', async () => {
  const { folder, home } = await task();
  const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: async () => ({ status: 'not-trusted' }) });
  assert.deepEqual(spawned.map(([command, args]) => [command, args[0]]), [['open', 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility'], ['open', '-a']]);
  assert.equal(copied.length, 1);
  assert.deepEqual([result.mode, result.detail, result.reason], ['clipboard', DETAIL, REASONS['not-trusted']]);
});

test('an Outlook reply that never answers takes the floor at the limit', async () => {
  const { folder, home } = await task();
  const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
  const started = Date.now();
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, floorMs: 40, replyImpl: () => new Promise(() => {}) });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual([result.opened, result.mode, result.detail, result.status], ['outlook', 'clipboard', DETAIL, 'timeout']);
  assert.match(result.reason, /too long/);
  assert.deepEqual(copied, [REPLY_BODY]);
  assert.deepEqual(spawned.map(([command, args]) => [command, args]), [['open', ['-a', 'Microsoft Outlook']]]);
});

test('success statuses are unchanged and touch neither the clipboard nor Outlook', async () => {
  for (const reply of [{ status: 'replied', pasted: true, detail: 'ok' }, { status: 'reply-open-draft-on-clipboard', detail: 'ok' }, { status: 'x', pasted: true, detail: 'ok' }]) {
    const { folder, home } = await task();
    const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
    const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: async () => reply });
    assert.equal(result.mode, 'reply');
    assert.deepEqual([copied.length, spawned.length], [0, 0]);
  }
});

test('a dry run takes no floor action and says what it would do', async () => {
  const { folder, home } = await task();
  const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, dryRun: true, replyImpl: async () => ({ status: 'no-match' }) });
  assert.equal(result.mode, 'dry-run');
  assert.match(result.detail, /Would copy the draft to the clipboard and bring Outlook forward/);
  assert.deepEqual([copied.length, spawned.length], [0, 0]);
});

test('the person\'s own choice to open a new message still works', async () => {
  const { folder, home } = await task();
  const { copied, spawned, clipboardImpl, spawnImpl } = fakes();
  const result = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, allowNew: true, replyImpl: async () => ({ status: 'no-match' }) });
  assert.equal(result.mode, 'new-message');
  assert.equal(copied.length, 0);
  assert.equal(spawned.length, 1);
});

test('the clipboard mode shows exactly the detail line on the card', () => {
  // kind clipboard: the next Do it places the reply again (do-it.js); the card still shows exactly the detail line.
  assert.deepEqual(openedOutcome({ opened: 'outlook', mode: 'clipboard', detail: DETAIL, reason: 'x' }), { phase: 'in-mail-app', kind: 'clipboard', detail: DETAIL });
});

test('the floor code runs no AppleScript and creates no message', async () => {
  const source = (await readFile(new URL('../src/hikyaku/draft.js', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /osascript|tell application|make new|keystroke/i);
});

// 2026-10-10: a stale kept draft was opened as a reply; Do it then rewrote it, and the guard must let the new draft
// open while saying where the old copy sits. The same draft opened twice is still refused.
test('a draft written after the last opened reply opens, and names the older copy; the same draft is refused', async () => {
  const { folder, home } = await task();
  const { clipboardImpl, spawnImpl } = fakes();
  const replied = async () => ({ status: 'replied', pasted: true, detail: 'The reply is open in Outlook with the draft in it.' });
  await writeFile(join(folder, 'ATTEMPTS.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - 3600 * 1000).toISOString(), mode: 'reply', opened: 'outlook' })}\n`);
  const fresh = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: replied });
  assert.equal(fresh.mode, 'reply');
  assert.match(fresh.detail, /An older draft from .* may still be in Outlook's Drafts; delete that one\./);
  const twice = await openDraft({ taskDirectory: folder, home, spawnImpl, clipboardImpl, replyImpl: replied });
  assert.equal(twice.mode, 'already-open');
});
