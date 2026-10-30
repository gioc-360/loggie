// loggie-intros I2 (docs/intros/spec.md 1.8, gate 2.1): the replay's pure half on made-up inputs. Every reason gets its
// line, a shared domain stays out of the exit, each WRONG case exits 1, a clean run exits 0; the move-check binds the
// introduced address and never the introducer; and the replay's two files can only read (the source scan).
process.env.TZ = 'America/New_York';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { adversarialCheck, moveCheck, replayReport } from '../src/hikyaku/intro-replay.js';
import { introsIn, movable } from '../src/hikyaku/introduced.js';

const BANK = { name: 'Bank', kind: 'company', domains: ['bank.example'], words: [], found: { at: '2026-10-10T00:00:00Z' }, confirmed: '2026-10-10T01:00:00Z' };
const FOUND = { name: 'Fund', kind: 'company', domains: ['fund.example'], words: [], found: { at: '2026-10-10T00:00:00Z' } };
const SHARED = { name: 'Bank Club', kind: 'other', domains: ['bank.example'], words: [] };
const item = (ref, at, from, workstream = 'Bank', how = 'domain') => ({ ref, at, who: [{ name: '', address: from }], workstream, how, candidates: [], title: 'Hello' });
const logItem = (ref, workstream) => ({ id: `outlook:${ref}`, source: 'outlook', ref, workstream, how: workstream ? 'domain' : 'none', candidates: [] });
const runs = [{ at: Date.parse('2026-10-12T12:00:00Z'), outlookOk: true }, { at: Date.parse('2026-10-15T12:00:00Z'), outlookOk: true }];

test('2.1 one line per reason, in the precedence of 1.8, and the domain summary', () => {
  const routed = [
    item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example'),                       // in log
    item('apple-mail-2', '2026-10-12T09:01:00Z', 'b@bank.example'),                       // logged elsewhere
    item('apple-mail-3', '2026-10-12T09:02:00Z', 'c@bank.example'),                       // logged unsure
    item('apple-mail-4', '2026-10-01T09:00:00Z', 'd@bank.example'),                       // before the workspace
    item('apple-mail-5', '2026-10-14T09:00:00Z', 'e@mail.bank.example'),                  // stored late (a subdomain)
    item('apple-mail-6', '2026-10-19T09:00:00Z', 'f@bank.example'),                       // not looked yet
    item('apple-mail-7', '2026-10-12T09:00:00Z', 'g@other.example', null, 'none'),         // not a workspace domain
  ];
  const logged = [logItem('apple-mail-1', 'Bank'), logItem('apple-mail-2', 'Other'), logItem('apple-mail-3', null)];
  const { lines, summary, exit } = replayReport({ routed, logged, runs, workstreams: [{ ...BANK, found: { at: '2026-10-05T00:00:00Z' } }] }, { days: 60, ms: 5 });
  assert.equal(exit, 0);
  assert.equal(lines[0], 'replay: Apple Mail only (Gmail-API workspaces are not read), 60 days, 7 emails, 6 filed, 5 ms');
  const reasons = lines.filter((line) => line.startsWith('file ')).map((line) => line.match(/log: (?:yes|no ) (.+?)\s+kept:/)[1]);
  assert.deepEqual(reasons, ['before the workspace', 'in log', 'logged elsewhere', 'logged unsure', 'stored late', 'not looked yet']);
  assert.ok(lines.every((line) => !line.includes('g@other') && !line.includes('a@bank')), 'domains only without --show');
  assert.deepEqual(summary, [{ domain: 'bank.example', workspaces: ['Bank'], seen: 6, filed: 6, absent: 5, reasons: { 'before the workspace': 1, 'in log': 1, 'logged elsewhere': 1, 'logged unsure': 1, 'stored late': 1, 'not looked yet': 1 } }]);
  assert.ok(lines.includes('bank.example: 6 seen, 6 filed to Bank, 5 absent from the live log (1 logged elsewhere, 1 logged unsure, 1 before the workspace, 1 stored late, 1 not looked yet)'));
});

test('2.1 "not in window" is mail older than a week before the first refresh; a run that failed Outlook stores nothing late', () => {
  const routed = [item('apple-mail-8', '2026-09-01T09:00:00Z', 'a@bank.example'), item('apple-mail-9', '2026-10-13T09:00:00Z', 'b@bank.example')];
  const { lines } = replayReport({ routed, logged: [], runs: [{ at: Date.parse('2026-10-12T12:00:00Z'), outlookOk: true }, { at: Date.parse('2026-10-15T12:00:00Z'), outlookOk: false }], workstreams: [{ ...BANK, found: null }] });
  assert.deepEqual(lines.filter((line) => line.startsWith('file ')).map((line) => line.match(/log: no  (.+?)\s+kept:/)[1]), ['not in window', 'not looked yet']);
});

test('2.1 a domain two workspaces share is listed and stays out of the exit', () => {
  const { lines, summary, exit } = replayReport({ routed: [item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example', null, 'none')], runs, workstreams: [BANK, SHARED] });
  assert.equal(exit, 0);
  assert.equal(summary[0].reasons['shared domain'], 1);
  assert.ok(lines.some((line) => /^file .* shared domain/.test(line)));
  assert.ok(lines.includes('bank.example: 1 seen, shared by Bank + Bank Club (out of the exit)'));
});

test('2.1 each WRONG case exits 1: routed elsewhere, unsure, a wrong binding, the introducer bound, an adversarial binding', () => {
  const wrong = (input) => replayReport({ runs, workstreams: [BANK, FOUND], ...input });
  for (const routed of [[item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example', 'Fund')], [item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example', null, 'none')]]) {
    const { lines, exit } = wrong({ routed });
    assert.equal(exit, 1);
    assert.match(lines.find((line) => line.includes('@bank.example')), /^WRONG file /);
  }
  const intro = { name: 'Dana Okafor', address: 'dana@bank.example', shape: 'body', by: 'jreyes@bank.example', at: '2026-10-16T20:55:10.000Z', thread: 'outlook:41', message: 'apple-mail-2' };
  const row = (check) => ({ intro, workspace: 'Bank', kept: true, written: null, ask: { status: 'one', holds: true }, check });
  const bad = wrong({ intros: [row({ bound: 'someone@bank.example', introducerDropped: true })] });
  assert.equal(bad.exit, 1);
  assert.ok(bad.lines.includes('WRONG move-check: bound @bank.example (not the introduced address); introducer dropped'));
  const none = wrong({ intros: [row({ bound: null, introducerDropped: true })] });
  assert.equal(none.exit, 1, 'binding nothing is wrong too');
  const introducer = wrong({ intros: [row({ bound: intro.address, introducerDropped: false })] });
  assert.equal(introducer.exit, 1);
  assert.ok(introducer.lines.includes('WRONG move-check: bound @bank.example; introducer BOUND'));
  const adversarial = wrong({ adversarial: { names: 40, emails: 3, bound: 2, wrong: 1 } });
  assert.equal(adversarial.exit, 1);
  assert.ok(adversarial.lines.includes('WRONG move-check: 40 names tried on 3 emails, 2 bound, 1 wrong'));
});

test('2.1 a clean run exits 0, and --domain limits the exit and the lines to that domain', () => {
  const intro = { name: 'Dana Okafor', address: 'dana@bank.example', shape: 'body', by: 'jreyes@bank.example', at: '2026-10-16T20:55:10.000Z', thread: 'outlook:41', message: 'apple-mail-2' };
  const to = { ...intro, name: 'Lena Park', address: 'lena@fund.example', shape: 'to', by: 'sam@fund.example' };
  const clean = replayReport({ routed: [item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example')], logged: [logItem('apple-mail-1', 'Bank')], runs, workstreams: [BANK, FOUND],
    intros: [{ intro, workspace: 'Bank', kept: true, written: '2026-10-20T14:17:00Z', ask: { status: 'many', holds: true }, check: { bound: intro.address, introducerDropped: true } },
      { intro: to, workspace: 'Fund', kept: false, written: null, ask: { status: 'one', holds: true }, check: null }],
    adversarial: { names: 12, emails: 2, bound: 1, wrong: 0 } }, { show: false });
  assert.equal(clean.exit, 0);
  assert.ok(clean.lines.includes('intro 2026-10-16 body by @bank.example -> @bank.example workspace: Bank kept: yes written: 2026-10-20 move: none (written 2026-10-20) ask: many holds'));
  assert.ok(clean.lines.includes('  move-check: bound @bank.example; introducer dropped'));
  assert.ok(clean.lines.includes('intro 2026-10-16 to by @fund.example -> @fund.example workspace: Fund kept: no written: no move: reply (existing) ask: one holds'));
  assert.ok(clean.lines.includes('move-check: 12 names tried on 2 emails, 1 bound, 0 wrong'));
  const moves = (fields) => replayReport({ intros: [{ intro, workspace: 'Bank', kept: true, written: null, ask: { status: 'one', holds: true }, check: null, ...fields }] }).lines[1].match(/move: (.+?) ask:/)[1];
  assert.deepEqual([moves({ workspace: null }), moves({ kept: false }), moves({}), moves({ ask: { status: 'none', holds: false } })], ['none (no workspace)', 'none (not kept)', 'email', 'email']);
  const shown = replayReport({ intros: [{ intro, workspace: 'Bank', kept: true, written: null, ask: { status: 'one', holds: true }, check: { bound: intro.address, introducerDropped: true } }] }, { show: true }).lines;
  assert.ok(shown.includes('intro 2026-10-16 body by jreyes@bank.example -> Dana Okafor dana@bank.example workspace: Bank kept: yes written: no move: email ask: one holds'));
  assert.ok(shown.includes('  move-check: bound dana@bank.example; introducer dropped'));
  const limited = replayReport({ routed: [item('apple-mail-1', '2026-10-12T09:00:00Z', 'a@bank.example', 'Fund'), item('apple-mail-2', '2026-10-12T09:00:00Z', 'b@fund.example', 'Fund')], logged: [logItem('apple-mail-2', 'Fund')], runs, workstreams: [BANK, FOUND] }, { domain: 'fund.example' });
  assert.equal(limited.exit, 0, 'the wrong bank.example line is outside --domain fund.example');
  assert.ok(limited.lines.every((line) => !line.includes('bank.example')));
});

// A made-up thread in the Oct 16 shape, as the replay builds it from Inbox and Sent rows.
const ME = 'gio@school.example';
const DANA = 'dana.okafor@bank.example';
const thread = { id: 'outlook:41', sourceType: 'manual', subject: 'RE: Thank you', messages: [
  { id: 'apple-mail-1', from: ME, to: 'jreyes@bank.example', cc: '', subject: 'Thank you', timestamp: '2026-10-14T15:00:00Z', body: 'Thank you for Monday.' },
  { id: 'apple-mail-2', from: 'Reyes, Jordan <jreyes@bank.example>', to: ME, cc: '', subject: 'RE: Thank you', timestamp: '2026-10-16T20:55:10Z',
    body: `Hi Gio! Have you connected before with Dana Okafor: ${DANA}<mailto:${DANA}> She's on our data team. Marcus Bell is out this week.\n\nBest,\nJordan` }] };
const [intro] = introsIn([thread], { own: [ME], writtenTo: new Set(['jreyes@bank.example']) });

test('2.1 the move-check binds the introduced address and drops the introducer, a "Last, First" name too', () => {
  assert.deepEqual(moveCheck(thread, intro, { own: [ME] }), { bound: DANA, introducerDropped: true });
  const plain = { ...thread, messages: [thread.messages[0], { ...thread.messages[1], from: 'Jordan Reyes <jreyes@bank.example>' }] };
  assert.deepEqual(moveCheck(plain, intro, { own: [ME] }), { bound: DANA, introducerDropped: true });
});

test('2.1 the adversarial check tries every capitalised run and binds only the introduced person, 0 wrong', () => {
  const tally = adversarialCheck([thread], { own: [ME], movable: movable([intro], []) });
  assert.equal(tally.emails, 1);
  assert.ok(tally.names >= 5, `runs tried: ${tally.names}`);
  assert.equal(tally.wrong, 0);
  assert.equal(tally.bound, 1, 'only "Dana Okafor" binds; "Jordan" and "Marcus Bell" bind nothing');
  assert.deepEqual(adversarialCheck([thread], { own: [ME], movable: new Map() }), { ...tally, bound: 0 }, 'no movable intro: nothing binds');
  assert.equal(adversarialCheck([{ ...thread, messages: [thread.messages[1]] }], { own: [ME], movable: movable([intro], []) }).emails, 0, 'a thread the user never wrote in is not read');
});

test('2.1 source scan: the replay and its pure half only read', async () => {
  for (const file of ['scripts/intros/replay.mjs', 'src/hikyaku/intro-replay.js']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, names, from] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(node:fs(?:\/promises)?)'/g)) {
      for (const name of names.split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) assert.ok(['readFile', 'readdir', 'stat'].includes(name), `${file} imports ${name} from ${from}`);
    }
    assert.doesNotMatch(source, /from\s*'node:fs'\s*;?\s*$|import\s+\*\s+as\s+\w+\s+from\s+'node:fs/m, `${file} imports all of node:fs`);
    assert.doesNotMatch(source, /child_process/, `${file} imports child_process`);
    assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rmdir|rm|rename|copyFile|cp|unlink|createWriteStream)(?:Sync)?\s*\(/, `${file} calls a write`);
  }
});
