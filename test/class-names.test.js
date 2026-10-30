// Class notes on this Mac (loggie-class-notes, docs/class-notes/spec.md 1.6 and 1.7): the app puts the classmates'
// names back where the user reads them, agrees with the Python unmask on one shared fixture, and the name check sends no
// word of a class anywhere. Made-up people, temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isClass, unmask } from '../src/hikyaku/class-names.js';
import { callDetail, summaryOf } from '../src/hikyaku/call-list.js';
import { checkNames } from '../src/hikyaku/name-check.js';

const CASES = JSON.parse(await readFile(new URL('../transcriber/spike/fixtures/class-unmask-cases.json', import.meta.url), 'utf8'));

test('unmask agrees with privacy.unmask on every shared case', () => {
  for (const c of CASES.cases) assert.equal(unmask(c.text, CASES.names), c.want, c.text);
  assert.equal(unmask('Student 1 spoke.', null), 'Student 1 spoke.', 'no map: labels stay');
});

test('isClass reads the event the way summary.py kind_of does', () => {
  assert.equal(isClass({ title: 'NBA 6123 Imagined Strategy' }), true);
  assert.equal(isClass({ category: 'class', title: 'Seminar' }), true);
  assert.equal(isClass({ category: 'team', title: 'NBA 6123 sync' }), false, 'a category wins over a course code');
  assert.equal(isClass({ title: 'Coffee chat' }), false);
});

const ID = '2026-10-21-1000-nba-6123-imagined-strategy';
async function classHome() {
  const home = await mkdtemp(join(tmpdir(), 'class-names-'));
  const folder = join(home, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'NBA 6123 Imagined Strategy', category: 'class', me: 'Gio', start: '2026-10-21T14:00:00Z', end: '2026-10-21T14:30:00Z' }));
  await writeFile(join(folder, 'transcript.md'), '# NBA 6123 Imagined Strategy\n\n[00:10] Me: Yes, Marnie. What do you think about the Rexon case?\n\n[00:40] Them: Quillan (unclear), what would you do?\n');
  await writeFile(join(folder, 'held.json'), JSON.stringify({ names: CASES.names }));
  await writeFile(join(folder, 'summary-nebius.md'), '# NBA 6123 Imagined Strategy\n\n## Discussion\n- Student 3 asked about the Rexon case [00:10]\n- Student 2 raised the plant [00:40]\n');
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', provider: 'nebius', created: '2026-10-21T15:00:00-04:00', privacy: { held_file: 'held.json' },
    checks: [{ section: 'Discussion', text: 'Student 3 asked about the Rexon case', backed: true, line: '[00:10] Me: Yes, Student 3. What do you think about the Rexon case?' }] }]));
  return { home, folder };
}

test('the Meetings tab shows the names; the notes on disk and summaryOf keep the labels', async () => {
  const { home, folder } = await classHome();
  const stored = await summaryOf(folder);
  assert.match(stored.text, /Student 3 asked/, 'summaryOf keeps labels for every reader that sends the notes on');
  assert.deepEqual(stored.names, CASES.names);
  const detail = await callDetail({ home, id: ID });
  const shown = JSON.stringify(detail.sections);
  assert.match(shown, /Marnie asked about the Rexon case/);
  assert.match(shown, /Quillan raised the plant/, "the page shows a point without its (unclear) mark, as for any call");
  assert.doesNotMatch(shown, /Student [123]\b/, 'no label the map holds is left on screen');
  assert.match(await readFile(join(folder, 'summary-nebius.md'), 'utf8'), /Student 3/, 'the file still holds the label');
});

test('the name check on a class asks the cloud AI nothing and searches nothing', async () => {
  const { home } = await classHome();
  let asked = 0, searched = 0;
  const record = await checkNames({ home, id: ID, ask: async () => { asked += 1; return '[]'; }, search: async () => { searched += 1; return []; } });
  assert.equal(asked, 0);
  assert.equal(searched, 0);
  assert.equal(record.note, "A class: classmates' names stay on this Mac, so no word was sent.");
});
