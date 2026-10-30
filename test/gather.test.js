import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { eventLines, ownCallSteps, ownTitles, readHabits, readReplaced, recentEvents, recordReplaced, seedHabits, sentSince, undoReplaced } from '../src/hikyaku/gather.js';

// Made-up people and companies only.
const tmp = () => mkdtemp(join(tmpdir(), 'gather-'));
const SUMMARY = ['# Lena chat', '', 'For your goal: Get the Acme Bank analyst offer before Nov 11', '', '## Topic', '- something [01:00]', '',
  '## Next Steps', '- Ask the recruiter on Oct 16 about other roles (Gio) [12:01] (not sure)', '- Email lena@acmebank.example the deck [20:00]', ''].join('\n');

test('a call is read as its goal line and next steps, minute marks and (not sure) cut, addresses screened', () => {
  assert.deepEqual(eventLines(SUMMARY), ['For your goal: Get the Acme Bank analyst offer before Nov 11', 'Ask the recruiter on Oct 16 about other roles (Gio)', 'Email [address kept on this Mac] the deck']);
  assert.deepEqual(eventLines(null), []);
});

test('written since the call: yes, no, or unknown when Sent could not be read or nobody has an address', () => {
  const event = { emails: ['lena@acmebank.example'], end: '2026-10-09T17:25:00Z' };
  const before = { timestamp: '2026-10-09T14:33:00Z', to: ['lena@acmebank.example'] };
  const after = { timestamp: '2026-10-09T19:00:00Z', to: ['lena@acmebank.example'] };
  assert.equal(sentSince(event, [before]), 'no', 'mail before the call does not count');
  assert.equal(sentSince(event, [before, after]), 'yes');
  assert.equal(sentSince(event, null), 'unknown');
  assert.equal(sentSince({ emails: [], end: event.end }, [after]), 'unknown');
});

test('recent calls are grouped by workstream, newest first, with the newest summary anywhere in the folder', async () => {
  const home = await tmp();
  const call = async (name, event, files = {}) => {
    await mkdir(join(home, name, 'v3'), { recursive: true });
    await writeFile(join(home, name, 'event.json'), JSON.stringify(event));
    for (const [file, text] of Object.entries(files)) await writeFile(join(home, name, file), text);
  };
  await call('a', { title: 'Lena chat', start: '2026-10-09T17:00:00Z', end: '2026-10-09T17:25:00Z', workstream: 'Acme Bank', category: 'one-on-one', emails: ['lena@acmebank.example'] }, { 'v3/summary-nebius-2.md': SUMMARY });
  await call('b', { title: 'Older', start: '2026-10-02T17:00:00Z', workstream: 'Acme Bank' });
  await call('c', { title: 'Too old', start: '2026-09-01T17:00:00Z', workstream: 'Acme Bank' });
  await call('d', { title: 'No stream', start: '2026-10-09T17:00:00Z' });
  const events = await recentEvents({ callsHome: home, now: new Date('2026-10-10T12:00:00Z'), sent: [] });
  const acme = events.get('acme bank');
  assert.deepEqual(acme.map((e) => [e.title, e.summarized, e.written]), [['Lena chat', true, 'no'], ['Older', false, 'unknown']]);
  assert.equal(events.size, 1);
});

test('a replaced move is appended with its date, never twice, and Undo cancels it without deleting the row', async () => {
  const home = await tmp();
  const now = () => new Date('2026-10-10T12:00:00Z');
  assert.equal((await recordReplaced(home, [{ taskId: 't4', by: 'b', quote: 'q', validUntil: '2026-10-09T23:00:00Z' }], { now })).length, 1);
  assert.equal((await recordReplaced(home, [{ taskId: 't4', by: 'b', quote: 'q' }], { now })).length, 0);
  assert.ok((await readReplaced(home)).has('t4'));
  await undoReplaced(home, 't4', { now });
  assert.equal((await readReplaced(home)).size, 0);
  assert.equal((await readFile(join(home, 'replaced.jsonl'), 'utf8')).trim().split('\n').length, 2, 'both rows stay');
});

test('habits are the bullet lines of habits.md; the seed is written once and never over an existing file', async () => {
  const home = await tmp();
  assert.deepEqual(await readHabits(home), []);
  assert.equal(await seedHabits(home, ['After an interview, I send a thank-you note.']), true);
  assert.equal(await seedHabits(home, ['Something else']), false);
  assert.deepEqual(await readHabits(home), ['After an interview, I send a thank-you note.']);
});

test('a confirmed habit is added as one line, once, with the file before it kept beside it', async () => {
  const { addHabit } = await import('../src/hikyaku/gather.js');
  const home = await tmp();
  await seedHabits(home, ['After an interview, I send a thank-you note.']);
  assert.equal(await addHabit(home, 'When someone is waiting on my reply, replying comes before preparing.', { now: () => new Date('2026-10-10T20:00:00Z') }), true);
  assert.equal(await addHabit(home, 'when someone is waiting on my reply, replying comes before preparing.'), false);
  assert.deepEqual(await readHabits(home), ['After an interview, I send a thank-you note.', 'When someone is waiting on my reply, replying comes before preparing.']);
  assert.match(await readFile(join(home, 'habits.md.2026-10-10T20-00-00-000Z'), 'utf8'), /thank-you note/);
});

test('ownTitles matches ownCallSteps', () => {
  const summary = '# Hilton readout\n\nFor your goal: win the hackathon\n\n## Next Steps\n- Confirm hackathon sign-up link is the 2026 one (Gio) [50:26]\n- Send the deck to the team (Lena) [12:00]\n- Research business banking + retail partnership structure (gio) (not sure) [30:39]\n- Book the room (me) [05:10]\n- Gio to write the intro\n';
  const lines = eventLines(summary);
  const titles = ownTitles(lines, 'Gio Caballero');
  assert.deepEqual(titles, ['Confirm hackathon sign-up link is the 2026 one', 'Research business banking + retail partnership structure', 'Book the room']);
  const steps = ownCallSteps(new Map([['hilton', [{ call: '2026-10-13-1400-hilton', lines }]]]), 'Gio Caballero', '2026-10-14');
  assert.deepEqual(steps.map((step) => step.title), titles);
  assert.equal(steps[0].sourceId, 'callstep:2026-10-13-1400-hilton:confirm-hackathon-sign-up-link-is-the-2026-one');
  assert.deepEqual(ownTitles(['For your goal: x (me)'], 'me'), []);
});
