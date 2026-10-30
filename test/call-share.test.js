// Share a call's notes (loggie right-click, 2026-10-28): what leaves is the notes as written to disk, to the people on
// the call minus his own addresses, through his mail app unsent or the Mac's share sheet. Made-up class call: the notes
// keep "Student 2", the names map, the transcript and his typed notes never reach the body. Fakes for the compose
// window and the sheet: nothing opens on this Mac.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { shareCall, shareInfo, shareText } from '../src/hikyaku/call-share.js';

const ID = '2026-10-21-1000-nba-5245-macro';
const SAID = 'we should hedge the whole book now';
const NOTES = [
  '## Case discussion',
  `- Student 2 argued the bank should hedge "${SAID}" [03:12]`,
  '- The class agreed on a two-step plan [05:40]',
  '',
  '## Next steps',
  '- Read chapter 4 before Tuesday (Me) [40:10]',
  '- Send the slides to the group (Student 2) [41:00]',
  '',
].join('\n');

async function setup({ emails = ['Gio@Cornell.example', 'prof@school.example', 'priya@school.example', 'PROF@school.example'], notes = NOTES } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'loggie-share-'));
  const folder = join(home, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'NBA 5245 Macro', start: '2026-10-21T14:00:00Z', emails, names: 'Prof Ash, Priya Raman' }));
  await writeFile(join(folder, 'transcript.md'), `# NBA 5245 Macro\n\n[03:10] Priya Raman: ${SAID}.\n`);
  await writeFile(join(folder, 'my-notes.md'), 'TYPED NOTE about Priya\n');
  if (notes) {
    await writeFile(join(folder, 'summary-nebius-1.md'), notes);
    await writeFile(join(folder, 'held.json'), JSON.stringify({ names: { 'Student 2': { name: 'Priya Raman', forms: ['Priya Raman', 'Priya'] } } }));
    await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius-1.md', provider: 'nebius', created: '2026-10-21T15:00:00Z', checks: [], privacy: { held_file: 'held.json' } }]));
  }
  return { home, folder };
}
const SETTINGS = { mailApp: 'outlook', signName: 'Gio' };
const OWN = ['gio@cornell.example'];
const leaks = (text) => [SAID, 'Priya', 'TYPED NOTE', '[03:12]'].filter((bad) => text.includes(bad));

test('the people are the call\'s addresses minus his own, once each; the page gets only the count', async () => {
  const { home } = await setup();
  const info = await shareInfo({ home, id: ID, own: OWN });
  assert.deepEqual(info.people, ['prof@school.example', 'priya@school.example']);
  assert.equal(info.notes, true);
  assert.equal(info.title, 'NBA 5245 Macro');
});

test('the share body is the notes as written: Student N stays, no transcript line, no name from the map, no typed notes', async () => {
  const body = shareText({ title: 'NBA 5245 Macro', notes: NOTES, signName: 'Gio' });
  assert.match(body, /Student 2 argued the bank should hedge/);
  assert.match(body, /Send the slides to the group \(Student 2\)/);
  assert.match(body, /Read chapter 4 before Tuesday \(Gio\)/);
  assert.match(body, /\n\nGio$/);
  assert.deepEqual(leaks(body), []);
});

test('Send notes to the people opens one unsent compose window in his mail app, To the others, nothing else', async () => {
  const { home } = await setup();
  const opened = [];
  const result = await shareCall({ home, id: ID, how: 'people', own: OWN, settings: SETTINGS, compose: async (command, args) => { opened.push([command, args]); }, sheet: async () => assert.fail('no sheet') });
  assert.equal(opened.length, 1);
  const [command, [flag, app, url]] = opened[0];
  assert.deepEqual([command, flag, app], ['open', '-a', 'Microsoft Outlook']);
  const mail = new URL(url);
  assert.equal(mail.protocol, 'mailto:');
  assert.deepEqual(decodeURIComponent(mail.pathname).split(','), ['prof@school.example', 'priya@school.example']);
  assert.equal(mail.searchParams.get('subject'), 'Notes: NBA 5245 Macro');
  const body = mail.searchParams.get('body');
  assert.match(body, /Student 2 argued/);
  assert.deepEqual(leaks(body), []);
  assert.deepEqual(result, { how: 'people', people: 2, line: 'Open in Outlook, unsent: 2 people. You send it there.' });
});

test('Share sheet gets the same screened text and a copy of it as a file outside the call folder', async () => {
  const { home, folder } = await setup();
  const tmp = await mkdtemp(join(tmpdir(), 'loggie-share-tmp-'));
  const shared = [];
  const result = await shareCall({ home, id: ID, how: 'sheet', own: OWN, settings: SETTINGS, tmp, compose: async () => assert.fail('no compose'), sheet: async (item) => { shared.push(item); } });
  assert.equal(shared.length, 1);
  const [{ texts, filePaths }] = shared;
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^Notes: NBA 5245 Macro\n\n/);
  assert.deepEqual(leaks(texts[0]), []);
  assert.equal(filePaths.length, 1);
  assert.ok(filePaths[0].startsWith(tmp) && !filePaths[0].startsWith(folder), filePaths[0]);
  assert.match(filePaths[0], /NBA 5245 Macro\.md$/);
  assert.equal(await readFile(filePaths[0], 'utf8'), `${texts[0]}\n`);
  assert.equal(result.how, 'sheet');
});

test('no addresses: the email is refused, the sheet still works; no notes: both are refused', async () => {
  const { home } = await setup({ emails: ['gio@cornell.example'] });
  assert.equal((await shareInfo({ home, id: ID, own: OWN })).people.length, 0);
  await assert.rejects(shareCall({ home, id: ID, how: 'people', own: OWN, settings: SETTINGS, compose: async () => assert.fail('no compose'), sheet: async () => {} }), /No addresses on this call/);
  const bare = await setup({ notes: null });
  assert.equal((await shareInfo({ home: bare.home, id: ID, own: OWN })).notes, false);
  for (const how of ['people', 'sheet']) await assert.rejects(shareCall({ home: bare.home, id: ID, how, own: OWN, settings: SETTINGS, compose: async () => assert.fail('no compose'), sheet: async () => assert.fail('no sheet') }), /no notes yet/);
  await assert.rejects(shareInfo({ home, id: '../secret', own: OWN }), /Invalid call/);
});

test('the share module reads; it never removes, uploads or sends', async () => {
  const source = await readFile(new URL('../src/hikyaku/call-share.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bunlink\b|\brmSync\b|\brm\(|\brmdir\b|\bfetch\(|https?:|child_process|\bexec(File)?\(/);
});
