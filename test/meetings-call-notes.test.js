import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_NOTES, prepareCall, saveCallNotes, summarizeCall } from '../src/hikyaku/call-notes.js';
import { validateCallNotes } from '../desktop/ipc-validation.js';

const ID = '2026-10-09-1300-weekly-sync';
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-notes-'));
  await mkdir(join(root, 'calls', ID), { recursive: true });
  return root;
}
const send = async (root, run, created, status = 'pending', id = ID) => {
  await mkdir(join(root, 'runs', run), { recursive: true });
  await writeFile(join(root, 'runs', run, 'send.json'), JSON.stringify({ v: 1, run, what: 'call-notes', status, created, folder: join(root, 'calls', id), outbound: [], sha256: [] }));
};
const statusOf = async (root, run) => JSON.parse(await readFile(join(root, 'runs', run, 'send.json'), 'utf8')).status;

test('typed notes are written to my-notes.md in the call folder, and only there', async () => {
  const root = await home();
  assert.deepEqual(await saveCallNotes({ home: root, id: ID, text: 'deck by friday' }), { saved: true, chars: 14 });
  assert.equal(await readFile(join(root, 'calls', ID, 'my-notes.md'), 'utf8'), 'deck by friday');
  await assert.rejects(saveCallNotes({ home: root, id: '../x', text: 'a' }), /Invalid call/);
  await assert.rejects(saveCallNotes({ home: root, id: ID, text: 'x'.repeat(MAX_NOTES + 1) }), /at most/);
  assert.throws(() => validateCallNotes(ID, 5), /at most/);
  assert.deepEqual(validateCallNotes(ID, ''), { id: ID, text: '' });
});

test('screening again with the notes runs call.py prepare, and the older pending send for that call is superseded', async () => {
  const root = await home();
  await send(root, '20261009-180000-aaaa', '2026-10-09T18:00:00Z');
  await send(root, '20261009-180000-bbbb', '2026-10-09T18:00:00Z', 'pending', '2026-10-08-0900-other');
  const ran = [];
  const runner = async (command, args, options) => { ran.push({ command, args, cwd: options.cwd, home: options.env.LOGGIE_HIKYAKU_HOME }); await send(root, '20261009-190000-cccc', '2026-10-09T19:00:00Z'); return { code: 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await prepareCall({ home: root, id: ID, transcriber: '/fake/spike', runner }), { run: '20261009-190000-cccc' });
  // The run lands in this profile, not the default one (cleanup audit bug 9).
  assert.deepEqual(ran, [{ command: 'python3', args: ['call.py', 'prepare', join(root, 'calls', ID)], cwd: '/fake/spike', home: root }]);
  assert.equal(await statusOf(root, '20261009-180000-aaaa'), 'superseded');
  assert.equal(await statusOf(root, '20261009-190000-cccc'), 'pending');
  assert.equal(await statusOf(root, '20261009-180000-bbbb'), 'pending', 'another call keeps its question');
  await assert.rejects(prepareCall({ home: root, id: ID, transcriber: '/fake', runner: async () => ({ code: 1, stdout: '', stderr: 'privacy screen stopped' }) }), /privacy screen stopped/);
});

test('Summarize again prepares a fresh send: the AI is asked again, not answered from the saved copy', async () => {
  const root = await home();
  const envs = [];
  const runner = async (command, args, options) => { envs.push(options.env.LOGGIE_FRESH); await send(root, '20261009-200000-dddd', '2026-10-09T20:00:00Z'); return { code: 0, stdout: '', stderr: '' }; };
  await prepareCall({ home: root, id: ID, transcriber: '/fake/spike', runner, fresh: true });
  await prepareCall({ home: root, id: ID, transcriber: '/fake/spike', runner });
  assert.deepEqual(envs, ['1', process.env.LOGGIE_FRESH]);
});

// loggie-one-click-summarize: Summarize is one press. A waiting call (the 2026-10-22 class) answers its own send; a call
// with none, or with notes typed after its send, is screened fresh first; either way the yes follows.
test('Summarize answers the waiting send, or screens fresh when there is none or the notes are newer', async () => {
  const root = await home();
  const said = [], prepared = [];
  const summarize = async (options) => { said.push(options.run); return { ok: true, run: options.run }; };
  const prepare = async (options) => { prepared.push(options.fresh); return { run: '20261023-090000-ffff' }; };
  await send(root, '20261022-160716-a77a', '2026-10-22T16:07:17-04:00');
  assert.deepEqual(await summarizeCall({ home: root, id: ID, transcriber: '/fake', prepare, summarize }), { ok: true, run: '20261022-160716-a77a' });
  assert.deepEqual(prepared, [], 'a waiting send is answered as it is');
  const notes = join(root, 'calls', ID, 'my-notes.md');
  await writeFile(notes, 'late note');
  await utimes(notes, new Date('2026-10-22T21:00:00Z'), new Date('2026-10-22T21:00:00Z'));
  await summarizeCall({ home: root, id: ID, transcriber: '/fake', prepare, summarize });
  assert.deepEqual(prepared, [true], 'notes typed after the send: screened again, fresh');
  const other = await home();
  await summarizeCall({ home: other, id: ID, transcriber: '/fake', prepare, summarize });
  assert.deepEqual(said, ['20261022-160716-a77a', '20261023-090000-ffff', '20261023-090000-ffff']);
  await assert.rejects(summarizeCall({ home: other, id: ID, transcriber: '/fake', prepare: async () => ({ run: null }), summarize }), /could not be screened/);
  await assert.rejects(summarizeCall({ home: other, id: '../x', prepare, summarize }), /Invalid call/);
});

test('the call being recorded is renamed in place, and event.json is backed up first', async () => {
  const { renameCall } = await import('../src/hikyaku/call-notes.js');
  const { readdir } = await import('node:fs/promises');
  const root = await home();
  await writeFile(join(root, 'calls', ID, 'event.json'), JSON.stringify({ title: 'Meeting 1:00 PM', source: 'mic' }));
  await writeFile(join(root, 'calls', 'current.json'), JSON.stringify({ dir: join(root, 'calls', ID) }));
  assert.deepEqual(await renameCall({ home: root, id: ID, title: '  Weekly   sync ' }), { id: ID, title: 'Weekly sync' });
  assert.equal(JSON.parse(await readFile(join(root, 'calls', ID, 'event.json'), 'utf8')).title, 'Weekly sync');
  assert.ok((await readdir(join(root, 'calls', ID))).some((name) => name.startsWith('event.json.before-rename-')));
  await assert.rejects(renameCall({ home: root, id: ID, title: '' }), /1 to 80/);
});

// meetings-granola-proposal c 2A (2026-10-27): a done call is renamed too; the title is his from then on.
test('a done call is renamed: event.json, the title lines of the transcript and notes, the waiting send; the folder stays', async () => {
  const { renameCall } = await import('../src/hikyaku/call-notes.js');
  const { pendingSends } = await import('../src/hikyaku/send-gate.js');
  const { readdir } = await import('node:fs/promises');
  const root = await home();
  const folder = join(root, 'calls', ID);
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: "Let's Talk in Sage Hall", start: '2026-10-09T17:00:00Z', me: 'Gio', filed: { title: 'x', was: null } }));
  await writeFile(join(folder, 'transcript.md'), "# Let's Talk in Sage Hall\n\nFriday, October 9, 2026, 13:00, 30 min. Me (Gio) and Them.\n\n[00:01] Me: Hi.\n");
  await writeFile(join(folder, 'summary-nebius.md'), "# Let's Talk in Sage Hall\n\n## Them's role\n- Runs strategy [00:01]\n");
  await writeFile(join(folder, 'notes.md'), "# Let's Talk in Sage Hall\n");
  await mkdir(join(folder, 'v2-check'));
  await writeFile(join(folder, 'v2-check', 'transcript.md'), "# Let's Talk in Sage Hall\n\n[00:01] Me: Hi.\n");
  await send(root, '20261009-180000-aaaa', '2026-10-09T18:00:00-04:00');
  const before = await readdir(join(root, 'calls'));
  assert.deepEqual(await renameCall({ home: root, id: ID, title: 'Interview with Northwind' }), { id: ID, title: 'Interview with Northwind' });
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  assert.equal(event.title, 'Interview with Northwind');
  assert.equal(event.title_by_hand, true);
  assert.equal(event.filed.was, "Let's Talk in Sage Hall");
  for (const file of ['transcript.md', 'summary-nebius.md', 'notes.md', join('v2-check', 'transcript.md')]) {
    assert.match(await readFile(join(folder, file), 'utf8'), /^# Interview with Northwind\n/, file);
  }
  assert.match(await readFile(join(folder, 'summary-nebius.md'), 'utf8'), /## Them's role/, 'only the first line');
  assert.deepEqual(await readdir(join(root, 'calls')), before, 'the folder name is the call id: never renamed');
  assert.equal((await pendingSends(root))[0].title, 'Interview with Northwind', 'the waiting question names it as it is now');
});

test('the choices under the title are meetings within 30 minutes of the press, never a block, nearest first', async () => {
  const { callTimeOf, nearbyMeetings } = await import('../src/hikyaku/call-notes.js');
  const at = callTimeOf('2026-10-27-1458-let-s-talk-in-sage-hall', { start: '2026-10-27T18:30:00Z' });
  assert.equal(new Date(at).getHours() * 100 + new Date(at).getMinutes(), 1458, 'the press, not the block');
  assert.equal(callTimeOf('x', { recorded_at: '2026-10-27T18:58:07Z' }), Date.parse('2026-10-27T18:58:07Z'));
  const local = (hhmm) => new Date(2026, 9, 27, Math.floor(hhmm / 100), hhmm % 100).toISOString();
  const sage = { id: 'sage', title: "Let's Talk in Sage Hall", start: local(1430), end: local(1600), attendees: [], location: 'Sage Hall' };
  const mt = { id: 'mt', title: 'Video Meeting with Northwind', start: local(1500), end: local(1530), attendees: ['kc@northwind.example'], attendeeNames: ['Cartwright, Kaitlyn'], location: 'Microsoft Teams Meeting' };
  const copy = { ...mt, id: 'mt-google', location: '' };
  const late = { ...mt, id: 'late', title: 'Office hours', start: local(1545), end: local(1615) };
  const near = { ...mt, id: 'near', title: 'Coffee with Lena', start: local(1450), end: local(1520) };
  assert.deepEqual(nearbyMeetings([sage, mt, copy, late, near], { at, title: sage.title }),
    [{ id: 'mt', start: mt.start, title: mt.title, people: 1 }, { id: 'near', start: near.start, title: near.title, people: 1 }]);
  assert.deepEqual(nearbyMeetings([mt], { at, title: mt.title }), [], 'never the call\'s own title');
});

test('a nearby meeting picked under the title becomes the call event, and Them is decided again on its invite', async () => {
  const { renameCall, nameThem } = await import('../src/hikyaku/call-notes.js');
  const root = await home();
  const folder = join(root, 'calls', ID);
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: "Let's Talk in Sage Hall", start: '2026-10-09T16:30:00Z', me: 'Gio', category: 'chat', with: 'the other person', workstream: 'Bank' }));
  const ran = [];
  const runner = async (cmd, args, options) => { ran.push([cmd, args, options.cwd]); return { code: 0, stdout: '', stderr: '' }; };
  const meeting = { id: 'ev-mt', title: 'Video Meeting with Northwind', start: '2026-10-09T17:00:00Z', end: '2026-10-09T17:30:00Z',
    attendees: ['kc@northwind.example'], attendeeNames: ['Cartwright, Kaitlyn'], location: 'Microsoft Teams Meeting' };
  const result = await renameCall({ home: root, id: ID, title: 'ignored', meeting, transcriber: '/t', runner });
  assert.deepEqual(result, { id: ID, title: 'Video Meeting with Northwind', them: 'decided again' });
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  assert.deepEqual([event.title, event.start, event.end, event.id, event.emails, event.names, event.with, event.location, event.workstream, event.category],
    ['Video Meeting with Northwind', '2026-10-09T17:00:00Z', '2026-10-09T17:30:00Z', 'ev-mt', ['kc@northwind.example'], 'Kaitlyn Cartwright', 'Kaitlyn Cartwright', 'Microsoft Teams Meeting', 'Bank', undefined]);
  assert.deepEqual(ran, [['python3', ['them.py', 'again', folder], '/t']]);
  // His pick of who Them was goes to them.py pick, on this Mac.
  assert.deepEqual(await nameThem({ home: root, id: ID, name: ' David  Calloway ', transcriber: '/t', runner }), { id: ID, them: 'David Calloway' });
  assert.deepEqual(ran.at(-1), ['python3', ['them.py', 'pick', folder, 'David Calloway'], '/t']);
  await assert.rejects(nameThem({ home: root, id: ID, name: 'Them', transcriber: '/t', runner }), /1 to 80/);
  await assert.rejects(nameThem({ home: root, id: ID, name: 'X', transcriber: '/t', runner: async () => ({ code: 1, stderr: 'no event.json' }) }), /no event\.json/);
});

test('a new workstream from the picker is appended once; a clash or Chats is refused', async () => {
  const { addWorkstream } = await import('../src/hikyaku/entry.js');
  const root = await home();
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', kind: 'company', domains: [], words: [] }]));
  assert.deepEqual(await addWorkstream({ home: root, name: ' Side   Project ' }), { name: 'Side Project', kind: 'other', domains: [], words: [] });
  const list = JSON.parse(await readFile(join(root, 'workstreams.json'), 'utf8'));
  assert.deepEqual(list.map((w) => w.name), ['Acme Bank', 'Side Project']);
  await assert.rejects(addWorkstream({ home: root, name: 'acme bank' }), /There is already a workspace named/);
  await assert.rejects(addWorkstream({ home: root, name: 'Chats' }), /There is already a workspace named/);
  await assert.rejects(addWorkstream({ home: root, name: '' }), /Give the new workspace a name/);
});

test('a workspace from a meeting keeps its people and three record keys, and nothing else (first-run-polish B3.3)', async () => {
  const { addWorkstream } = await import('../src/hikyaku/entry.js');
  const root = await home();
  const madeFrom = { event: 'E1@2026-10-13T13:00:00.000Z', at: '2026-10-18T12:00:00.000Z' };
  const entry = await addWorkstream({ home: root, name: 'Case Team', domains: ['bank.example'], words: ['Case'],
    people: [{ name: 'Ana', address: 'Ana@Bank.example' }, { name: 'Nobody', address: 'not an address' }],
    extra: { madeFrom, confirmed: madeFrom.at, cloud: 'nebius', found: { threads: 3 }, dismissed: true } });
  const expected = { name: 'Case Team', kind: 'other', domains: ['bank.example'], words: ['Case'], people: [{ name: 'Ana', address: 'ana@bank.example' }], madeFrom, confirmed: madeFrom.at, cloud: 'nebius' };
  assert.deepEqual(entry, expected);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'workstreams.json'), 'utf8')).at(-1), expected);
  // A cloud other than Nebius is never written (R2).
  const other = await addWorkstream({ home: root, name: 'Side Thing', extra: { cloud: 'claude' } });
  assert.equal('cloud' in other, false);
  await assert.rejects(addWorkstream({ home: root, name: 'case team' }), /There is already a workspace named "Case Team"/);
});
