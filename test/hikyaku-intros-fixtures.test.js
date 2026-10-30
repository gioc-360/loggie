// loggie-intros I3 (docs/intros/spec.md gate 3.1): 10 made-up introductions in the three shapes (B body, T To, N the
// name first and the introduction later) and 3 decoys, each a recorded thread set with the model's answer. A fixture
// passes when introsIn finds exactly its pairs and the moves are exactly its move: the model's actions (checkActions)
// plus the code-made intro moves (introActions on movable), as catchUp makes them. Bar: 8 of the 10, and every decoy.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { introsIn, movable } from '../src/hikyaku/introduced.js';
import { checkActions, introActions } from '../src/hikyaku/workstreams.js';

const folder = new URL('./fixtures/intros/', import.meta.url);
const fixtures = await Promise.all((await readdir(folder)).filter((file) => file.endsWith('.json')).sort()
  .map(async (file) => JSON.parse(await readFile(new URL(file, folder), 'utf8'))));

// -> null when it passes, else what differed.
function judge(fixture) {
  const writtenTo = new Set(fixture.sent.flatMap((row) => row.to));
  const intros = introsIn(fixture.threads, { own: fixture.own, writtenTo, names: new Map(Object.entries(fixture.names || {})) });
  const pairs = intros.map(({ thread, name, address, shape }) => ({ thread, name, address, shape }));
  if (JSON.stringify(pairs) !== JSON.stringify(fixture.expect.pairs)) return `pairs ${JSON.stringify(pairs)}`;
  const actions = [...checkActions(fixture.model, fixture.threads, fixture.own).actions, ...introActions(fixture.threads, movable(intros, fixture.sent))];
  const emails = actions.filter((action) => action.kind === 'email');
  const { move } = fixture.expect;
  if (move === null) return actions.length ? `${actions.length} actions, expected none` : null;
  if (move.kind === 'email') {
    const [one] = emails;
    return actions.length === 1 && one?.email.address === move.address && one.email.to === move.to && one.email.from === 'intro' ? null
      : `moves ${JSON.stringify(actions.map((action) => [action.kind, action.email?.to, action.email?.address]))}`;
  }
  const replies = actions.filter((action) => action.kind === 'reply');
  const thread = fixture.threads[move.thread - 1];
  return !emails.length && replies.length === 1 && replies[0].thread === thread ? null
    : `moves ${JSON.stringify(actions.map((action) => [action.kind, action.email?.to ?? action.thread.id]))}`;
}

test('3.1 at least 8 of the 10 fixture introductions become the right pairs and the right move', (t) => {
  const ten = fixtures.filter((fixture) => !fixture.id.startsWith('D'));
  assert.equal(ten.length, 10);
  const misses = ten.map((fixture) => [fixture.id, judge(fixture)]).filter(([, why]) => why);
  for (const [id, why] of misses) t.diagnostic(`${id} misses: ${why}`);
  t.diagnostic(`${10 - misses.length} of 10 pass`);
  assert.ok(10 - misses.length >= 8, `${10 - misses.length} of 10: ${JSON.stringify(misses)}`);
});

test('3.1 every decoy gives 0 pairs and 0 moves, though the model\'s answer names the people', () => {
  const decoys = fixtures.filter((fixture) => fixture.id.startsWith('D'));
  assert.equal(decoys.length, 3);
  for (const fixture of decoys) assert.equal(judge(fixture), null, fixture.id);
});

test('3.1 a To introduction is saved and never a move: the model\'s email naming her drops, the reply stays', () => {
  const fixture = fixtures.find((item) => item.id === 'T1');
  const intros = introsIn(fixture.threads, { own: fixture.own, writtenTo: new Set(fixture.sent.flatMap((row) => row.to)) });
  assert.equal(movable(intros, fixture.sent).size, 0);
  assert.equal(introActions(fixture.threads, movable(intros, fixture.sent)).length, 0);
});
