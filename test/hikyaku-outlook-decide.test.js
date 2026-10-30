// The Outlook helper's decisions, replayed offline. Each case is a copy of the accessibility tree (recorded from
// the real Outlook and redacted, or built to the same shape) run through the compiled helper's `decide`: the same
// functions a live reply uses, with no Outlook and no Accessibility permission. One case per past failure.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { redactionProblems } from '../scripts/outlook-eval/check-redaction.mjs';
import { keepRow, keepStructure, redact } from '../scripts/outlook-eval/redact.mjs';

const run = promisify(execFile);
const SOURCE = new URL('../src/hikyaku/native/outlook.swift', import.meta.url);
const canBuild = existsSync('/usr/bin/swiftc');
const skip = !canBuild && 'needs Xcode command line tools (swiftc)';
const NOW = '2026-10-05T15:00:00Z';

let helperPath = null;
async function helper() {
  if (helperPath) return helperPath;
  const source = await readFile(SOURCE);
  const path = join(tmpdir(), `hikyaku-outlook-test-${createHash('sha1').update(source).digest('hex').slice(0, 12)}`);
  if (!existsSync(path)) await run('/usr/bin/swiftc', ['-O', SOURCE.pathname, '-o', path], { timeout: 300000 });
  helperPath = path;
  return path;
}
let scratch = null;
async function decide(c) {
  scratch ||= await mkdtemp(join(tmpdir(), 'hikyaku-decide-'));
  const file = join(scratch, `${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(c));
  const { stdout } = await run(await helper(), ['decide', '--case', file, '--now', NOW]);
  return JSON.parse(stdout);
}

// --- trees built to the shape recorded on 2026-10-04 (identifiers and roles as Outlook reports them)
const n = (role, props = {}, children = []) => ({ role, id: '', title: '', desc: '', value: '', settable: false, focused: false, enabled: true, ...props, children });
function withPaths(node, path = []) { node.path = path; node.children.forEach((child, i) => withPaths(child, [...path, i])); return node; }
const snap = (root, extra = {}) => ({ root: withPaths(root), ...extra });
const find = (node, id) => node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean);

const header = ({ from, to, stamp, buttons = true }) => n('AXGroup', {}, [
  n('AXGroup', {}, [n('AXStaticText', { id: 'messageHeaderFromContent', value: from }), n('AXStaticText', { id: 'messageHeaderRecipientsContent', value: to })]),
  n('AXStaticText', { id: 'messageHeaderTimeStampContent', value: stamp }),
  ...(buttons ? [n('AXButton', { id: 'messageHeaderContextualControlsReplyButton', desc: 'Reply' }), n('AXButton', { id: 'messageHeaderContextualControlsReplyAllButton', desc: 'Reply all' })] : []),
]);
const pane = (...headers) => n('AXGroup', { desc: 'Reading Pane' }, headers.flatMap((h) => [h, n('AXTextArea', { value: 'Earlier message text.' })]));
const token = (text) => n('AXStaticText', { value: text });
function compose({ to = ['Other Person, other@eval.test, Available'], cc = null, subject = 'Re: Budget', body = '\n\nFrom: Other Person <other@eval.test>\nSent: Friday\nSubject: Budget\n\nCan you send the numbers?', extra = [] } = {}) {
  return n('AXGroup', {}, [
    n('AXGroup', { desc: 'Editor' }, [n('AXScrollArea', {}, [n('AXWebArea', {}, [n('AXTextArea', { value: body, settable: true, focused: true })])])]),
    n('AXScrollArea', {}, [n('AXTextField', { id: 'toTextField', desc: 'To Recipients', value: '￼', settable: true }, to.map(token))]),
    ...(cc ? [n('AXScrollArea', {}, [n('AXTextField', { id: 'ccTextField', desc: 'Cc Recipients', value: '￼', settable: true }, cc.map(token))])] : [n('AXButton', { id: 'ccShowButton', desc: 'Show Cc' })]),
    n('AXTextField', { id: 'subjectTextField', desc: 'Subject', value: subject, settable: true }),
    ...extra,
  ]);
}
const expect = (extra = {}) => ({ sender: 'other@eval.test', me: ['self@eval.test'], to: ['other@eval.test'], subject: 'Re: Budget', date: '2026-09-30T20:00:00Z', ...extra });
const toPathOf = (root) => find(withPaths(root), 'toTextField').path;

test('failure 3: the newest message is the user\'s own note to the person, so Reply all is pressed on it', { skip }, async () => {
  const p = pane(
    header({ from: 'Self Person <self@eval.test>', to: 'Other Person <other@eval.test>', stamp: 'Sunday, October 4, 2026 at 09:31' }),
    header({ from: 'Other Person <other@eval.test>', to: 'Self Person <self@eval.test>', stamp: 'Wednesday, September 30, 2026 at 22:47' }));
  const out = await decide({ expect: expect(), panes: [snap(p)] });
  assert.equal(out.chosen.own, true); assert.equal(out.chosen.button, 'reply-all');
  assert.deepEqual(out.chosen.path, find(withPaths(p), 'messageHeaderContextualControlsReplyAllButton').path, 'the Reply all of the own message, not of the person\'s');
  assert.deepEqual(out.headers[0].map((h) => h.ok), [true, true]);
  // Without the user's address the own note is just someone else's message: it is refused, the person's is chosen.
  const blind = await decide({ expect: expect({ me: [] }), panes: [snap(p)] });
  assert.equal(blind.chosen.own, false); assert.equal(blind.chosen.button, 'reply'); assert.equal(blind.headers[0][0].reason, 'sender');
});

test('the user\'s own note to someone else is never replied on', { skip }, async () => {
  const p = pane(header({ from: 'Self Person <self@eval.test>', to: 'Third Person <third@eval.test>', stamp: 'Today at 09:00' }),
    header({ from: 'Other Person <other@eval.test>', to: 'Self Person <self@eval.test>', stamp: 'Yesterday at 18:00' }));
  const out = await decide({ expect: expect(), panes: [snap(p)] });
  assert.equal(out.headers[0][0].reason, 'own-not-to-person'); assert.equal(out.chosen.own, false);
});

test('a header without its own box never borrows the date and buttons of the message above it', { skip }, async () => {
  // The person's sender line sits in a box with no date or buttons; climbing further reaches the box that also holds
  // the user's header. Borrowing that date once flipped Reply and Reply all between runs (2026-10-05).
  const p = n('AXGroup', {}, [
    header({ from: 'Self Person <self@eval.test>', to: 'Other Person <other@eval.test>', stamp: 'Sunday, October 4, 2026 at 09:31' }),
    n('AXGroup', {}, [n('AXGroup', {}, [n('AXStaticText', { id: 'messageHeaderFromContent', value: 'Other Person <other@eval.test>' })])]),
  ]);
  const out = await decide({ expect: expect(), panes: [snap(p)] });
  assert.deepEqual(out.headers[0].map((h) => [h.ok, h.reason]), [[true, ''], [false, 'no-header']]);
});

test('a message older than the email being answered cannot vouch for it; the newest pane wins across rows', { skip }, async () => {
  const old = pane(header({ from: 'Other Person <other@eval.test>', to: 'self@eval.test', stamp: 'Monday, September 21, 2026 at 10:00' }));
  const right = pane(header({ from: 'Other Person <other@eval.test>', to: 'self@eval.test', stamp: 'Wednesday, September 30, 2026 at 22:47' }));
  const newer = pane(header({ from: 'Other Person <other@eval.test>', to: 'self@eval.test', stamp: 'Today at 09:57' }));
  const out = await decide({ expect: expect(), panes: [snap(old), snap(right), snap(newer)] });
  assert.equal(out.headers[0][0].reason, 'date'); assert.equal(out.chosen.pane, 2, '"Today" is read against the run\'s own clock');
  assert.equal((await decide({ expect: expect(), panes: [snap(right), snap(structuredClone(right))] })).chosen.pane, 0, 'a tie keeps the first row');
});

test('rows: conversation rows are expanded, never opened; drafts and suggestions are skipped; Deleted Items only as a last copy', { skip }, async () => {
  const rows = ['  Expanded,  3 messages,  Budget,  Folder: Inbox,', '  Other Person, Budget,  9/30/26, Folder: Inbox,', '  Self Person, Re: Budget,  22:09, Folder: Drafts,',
    'budget, Search suggestion', '  Self Person, Re: Budget, 10/4/26, Folder: Deleted Items,', '  Someone, Lunch, Folder: Inbox,'];
  const out = await decide({ expect: expect(), rows });
  assert.deepEqual(out.candidates, [1]); assert.deepEqual(out.conversations, [0]);
  assert.deepEqual((await decide({ expect: expect(), rows: [rows[4], rows[2]] })).candidates, [0], 'a thread that only survives in Deleted Items still threads');
  assert.equal((await decide({ expect: expect(), rows: [' Unread,  Other Person, Budget, 9/30/26, Folder: Inbox,'] })).row_keys[0], 'other person, budget, 9/30/26, folder: inbox,', 'unread is not part of a row\'s identity');
});

test('failure 2026-10-12: a subject inside a longer subject is another thread, never a candidate', { skip }, async () => {
  const leg = 'Re: Request to attend remotely next week (travel) | Sam Student';
  const rows = [
    '  Expanded,  2 messages,  Tech class | Request to attend remotely next week (travel) | Sam Student,     10/6/26, Folder: Inbox,',
    "  Mia Classmate, Re: Tech class | Request to attend remotely next week (travel) | Sam Student,   10/6/26, Folder: Inbox,   Hi Sam, I'm sorry",
    '  Sam Student, Tech class | Request to attend remotely next week (travel) | Sam Student,   10/4/26, Folder: Sent,   Hi Professor',
    '  Dana Prof, Re: Request to attend remotely next week (travel) | Sam Student,   10/6/26, Folder: Inbox,   I am very sorry',
    '    2 messages, Dana Prof, Sam Student, Request to attend remotely next week (travel) | Sam Student,     10/6/26, Folder: Inbox,',
  ];
  const out = await decide({ expect: { ...expect(), subject: leg }, rows });
  assert.deepEqual(out.candidates, [3]);
  assert.deepEqual(out.conversations, [4]);
  assert.deepEqual((await decide({ expect: { ...expect(), subject: leg }, rows: rows.slice(0, 3) })).candidates, [], 'with only the longer subject listed, the helper searches');
});

test('failure 2: the body is the editable text area; read-only earlier messages and the advanced-search box are not', { skip }, async () => {
  const root = n('AXGroup', {}, [
    n('AXTextArea', { value: 'Try advanced search', settable: true }),
    n('AXTextArea', { value: 'Short read-only earlier message', settable: false }),
    compose(),
  ]);
  const out = await decide({ expect: expect(), composePre: snap(root, { toPath: toPathOf(root) }) });
  assert.deepEqual(out.body_path, [2, 0, 0, 0, 0]); assert.deepEqual(out.findings, []);
});

test('failure 3b: a reply addressed to the user is stopped, even when the person is named in the quoted history', { skip }, async () => {
  // The old check searched the whole reply and found the person in the quoted "From:" line (2026-10-05).
  const root = compose({ to: ['Self Person, self@eval.test, Available'] });
  const out = await decide({ expect: expect(), composePre: snap(root, { toPath: toPathOf(root) }) });
  assert.deepEqual(out.findings, ['reply-wrong-recipient', 'reply-includes-you']);
  assert.deepEqual(out.audit_pre.to_tokens, ['self person, self@eval.test, available']);
});

test('a forwarded email is answered to the forwarder; a forward window is stopped', { skip }, async () => {
  const quoted = '\n\nFrom: Forwarder <other@eval.test>\nSubject: Fw: Budget\n\nFrom: Third Person <third@eval.test>\nSubject: Budget';
  const ok = compose({ subject: 'Re: Fw: Budget', body: quoted });
  assert.deepEqual((await decide({ expect: expect({ subject: 'Re: Fw: Budget' }), composePre: snap(ok, { toPath: toPathOf(ok) }) })).findings, []);
  const fwd = compose({ subject: 'Fw: Budget', body: quoted });
  assert.deepEqual((await decide({ expect: expect(), composePre: snap(fwd, { toPath: toPathOf(fwd) }) })).findings, ['audit-forward-not-reply']);
  const wrong = compose({ subject: 'Re: Lunch' });
  assert.deepEqual((await decide({ expect: expect(), composePre: snap(wrong, { toPath: toPathOf(wrong) }) })).findings, ['audit-subject-mismatch']);
});

test('S8: a draft already open is never read as the new reply', { skip }, async () => {
  const stray = n('AXScrollArea', {}, [n('AXTextField', { id: 'toTextField', desc: 'To Recipients', settable: true }, [token('Self Person, self@eval.test')])]);
  const root = withPaths(n('AXGroup', {}, [stray, compose()]));
  const out = await decide({ expect: expect(), composePre: snap(root, { toPath: [1, 1, 0] }) });
  assert.deepEqual(out.findings, [], 'the To field the run opened is the one read');
  assert.deepEqual((await decide({ expect: expect(), composePre: snap(root) })).findings.slice(0, 1), ['reply-wrong-recipient'], 'without the opened field\'s path, the first one is read, and it is wrong');
});

test('Cc: a missing Cc and an unexpected recipient are reported, not stopped', { skip }, async () => {
  const missing = compose();
  const a = await decide({ expect: expect({ cc: ['ta@eval.test'] }), composePre: snap(missing, { toPath: toPathOf(missing) }) });
  assert.deepEqual(a.findings, ['audit-cc-missing']); assert.match(a.finding_messages[0], /Add ta@eval\.test on Cc/);
  const present = compose({ cc: ['TA, ta@eval.test'] });
  assert.deepEqual((await decide({ expect: expect({ cc: ['ta@eval.test'] }), composePre: snap(present, { toPath: toPathOf(present) }) })).findings, []);
  const extra = compose({ to: ['Other Person, other@eval.test', 'Stranger, stranger@eval.test'] });
  assert.deepEqual((await decide({ expect: expect(), composePre: snap(extra, { toPath: toPathOf(extra) }) })).findings, ['audit-extra-recipient']);
  // The sender's own mailbox with a "+tag" (a recruiting system's tracking address) is not someone else.
  const tagged = compose({ to: ['Other Person, other@eval.test', 'Other Person, other+m791189086572@eval.test'] });
  assert.deepEqual((await decide({ expect: expect(), composePre: snap(tagged, { toPath: toPathOf(tagged) }) })).findings, []);
});

test('after the paste: draft on top and once, one signature, one closing line', { skip }, async () => {
  const signature = 'Self Person\nMBA Candidate';
  const quote = '\nFrom: Other Person <other@eval.test>\nSent: Friday\n\nCan you send the numbers?';
  const before = `\n\n${signature}\n${quote}`;
  const draft = 'Hi Other,\n\nHere are the numbers.\n\nBest regards,';
  const check = async (after, extra = {}) => {
    const pre = compose({ body: before }), post = compose({ body: after });
    return decide({ expect: expect({ draft: 'Hi Other,', ...extra }), composePre: snap(pre, { toPath: toPathOf(pre) }), composePost: snap(post, { toPath: toPathOf(post) }) });
  };
  const clean = await check(`${draft}\n\n${signature}\n${quote}`);
  assert.deepEqual(clean.findings, []); assert.equal(clean.audit_post.draft_count, 1); assert.equal(clean.audit_post.signature_count, 1);
  assert.deepEqual((await check(`\n\n${signature}\n${draft}\n${quote}`)).findings, ['audit-body-not-first']);
  assert.deepEqual((await check(`${draft}\n${draft}\n\n${signature}\n${quote}`)).findings, ['audit-double-draft', 'audit-double-sign-off']);
  assert.deepEqual((await check(`${draft}\n\n${signature}\n\n${signature}\n${quote}`)).findings, ['audit-double-signature']);
  const signOffSignature = 'Best regards,\nSelf Person';
  const pre = compose({ body: `\n\n${signOffSignature}\n${quote}` }), post = compose({ body: `${draft}\n\n${signOffSignature}\n${quote}` });
  const doubled = await decide({ expect: expect({ draft: 'Hi Other,' }), composePre: snap(pre, { toPath: toPathOf(pre) }), composePost: snap(post, { toPath: toPathOf(post) }) });
  assert.deepEqual(doubled.findings, ['audit-double-sign-off'], 'the draft\'s sign-off and the signature\'s, the 2026-10-04 new-message case');
  assert.equal((await check(`Hi Other,\nThe quoted Best regards, below is not ours.\n${quote}\nBest regards,`)).audit_post.sign_off_count, 0, 'closing lines in the quote are not counted');
  // A reply with no closing at all: Outlook adds no signature to replies, and the draft's closing had been cut.
  const bare = compose({ body: `\n${quote}` }), cut = compose({ body: `Hi Other,\n\nHere are the numbers.\n${quote}` });
  const noClose = await decide({ expect: expect({ draft: 'Hi Other,' }), composePre: snap(bare, { toPath: toPathOf(bare) }), composePost: snap(cut, { toPath: toPathOf(cut) }) });
  assert.deepEqual(noClose.findings, ['audit-no-sign-off']);
  const named = compose({ body: `Hi Other,\n\nHere are the numbers.\n\nThank you,\nSelf\n${quote}` });
  assert.deepEqual((await decide({ expect: expect({ draft: 'Hi Other,' }), composePre: snap(bare, { toPath: toPathOf(bare) }), composePost: snap(named, { toPath: toPathOf(named) }) })).findings, [], 'a thanks closing counts');
});

test('recorded: the real reply window (2026-10-04, redacted) reads as addressed to the person, with the editable body', { skip }, async () => {
  const c = JSON.parse(await readFile(new URL('./fixtures/outlook/recorded-reply-compose.json', import.meta.url), 'utf8'));
  const out = await decide(c);
  assert.deepEqual(out.audit_pre.to_tokens, ['other person, other@eval.test, offline']);
  assert.deepEqual(out.audit_pre.cc_tokens, []); assert.equal(out.audit_pre.subject_ok, true);
  assert.deepEqual(out.body_path, c.composePre.bodyPath); assert.deepEqual(out.findings, []);
  assert.deepEqual(out.candidates.length, 3, 'only the thread\'s single messages in Deleted Items; its drafts and conversation rows are skipped');
  // The same window with the user on the To line, the failure seen live on 2026-10-05.
  const bad = structuredClone(c);
  const to = find(bad.composePre.root, 'toTextField'); to.children[0].value = 'Self Person, self@eval.test, Available';
  assert.deepEqual((await decide(bad)).findings, ['reply-wrong-recipient', 'reply-includes-you']);
});

test('recorded: the real panes of failure 3 (2026-10-04, redacted) give Reply all on the user\'s 09:31 note, every time', { skip }, async () => {
  // The thread's two rows as Outlook showed them: the user's 09:31 reply to the person, and the person's 9/30 email.
  // The newest across rows is the user's own note to the person, so it is answered with Reply all (Gio, 2026-10-03).
  const c = JSON.parse(await readFile(new URL('./fixtures/outlook/recorded-own-newest-pane.json', import.meta.url), 'utf8'));
  for (let i = 0; i < 3; i += 1) {
    const out = await decide(c);
    assert.deepEqual(out.headers.map((pane) => pane.map((h) => [h.own, h.ok])), [[[true, true]], [[false, true]]]);
    assert.equal(out.chosen.pane, 0); assert.equal(out.chosen.button, 'reply-all'); assert.match(out.chosen.stamp, /09:31/);
  }
  const blind = await decide({ ...c, expect: { ...c.expect, me: [] } });
  assert.equal(blind.chosen.pane, 1, 'without the user\'s address, the person\'s own email is the one replied on');
});

test('decide needs no Outlook and no permission, and refuses a broken case', { skip }, async () => {
  scratch ||= await mkdtemp(join(tmpdir(), 'hikyaku-decide-'));
  await writeFile(join(scratch, 'bad.json'), '{"expect": 3}');
  const { stdout } = await run(await helper(), ['decide', '--case', join(scratch, 'bad.json')]);
  assert.equal(JSON.parse(stdout).status, 'bad-case');
});

test('redaction keeps structure and drops words; the check catches what slipped through', () => {
  assert.equal(keepStructure('Hi Sam,\nThe secret plan.\n\nFrom: Sam <sam@school.example.com>\nWe meet at 5.'), 'Hi Sam,\n[redacted line]\n\nFrom: Sam <sam@school.example.com>\n[redacted line]');
  assert.equal(keepRow('  Sam, Budget,  9/30/26, Folder: Inbox,   Has files,    Can you send the numbers by Friday'), '  Sam, Budget,  9/30/26, Folder: Inbox,   Has files,');
  const out = redact({ expect: { sender: 'sam@school.example.com' }, rows: ['Sam Real, Budget, Folder: Inbox, preview', 'Lunch, Folder: Inbox,'],
    composePre: { root: { role: 'AXGroup', path: [], children: [{ role: 'AXRow', path: [0], desc: 'Dentist reminder', children: [] }, { role: 'AXStaticText', path: [1], value: 'Sam Real, sam@school.example.com', children: [] }] } } },
  { 'sam@school.example.com': 'other@eval.test', 'Sam Real': 'Other Person' }, 'Budget');
  assert.deepEqual(out.rows, ['Other Person, Budget, Folder: Inbox,', '[other email]']);
  assert.equal(out.composePre.root.children[0].desc, '[other email]'); assert.equal(out.composePre.root.children[1].value, 'Other Person, other@eval.test');
  assert.deepEqual(redactionProblems(JSON.stringify(out), ['Sam Real']), []);
  assert.deepEqual(redactionProblems('{"v": "Sam Real <sam@school.example.com>"}', ['Sam Real']), ['real address: sam@school.example.com', 'private word: Sam Real']);
});
