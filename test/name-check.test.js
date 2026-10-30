import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acceptName, checkNames, firstJson, keepName, knownPeople, parseMyWords, resembles, soundex, trimFollowing, undoName, unclearWords } from '../src/hikyaku/name-check.js';
import { createTavily, searchCredits } from '../src/hikyaku/tavily.js';

const ID = '2026-10-09-1258-acme-chat';
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-names-'));
  const folder = join(root, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Acme chat', names: 'Lena Park', me: 'Yuki', workstream: 'Acme Bank' }));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', provider: 'nebius', checks: [] }]));
  await writeFile(join(folder, 'summary-nebius.md'), '# Acme chat\n\n## Background\n- Yuki met Lena (unclear) about ACM (unclear) Bank and the Quoltrix (unclear) survey [01:00]\n- The offer comes through MNT (unclear) Bank [02:00]\n');
  await writeFile(join(folder, 'transcript.md'), '# Acme chat\n\nFriday, 33 min.\n_A word marked (unclear) is a name the readers heard differently._\n\n[01:00] Me: We use Quoltrix (unclear) and the Macbok (unclear) Pro for 2025 (unclear), and Stella (unclear) the dog, wow (unclear).\n\n[02:00] Me: Loggy (unclear) opens the draft, and Lockie (unclear) answers.\n');
  await writeFile(join(root, 'my-words.txt'), '# Words\nLoggie: Loggy\n');
  return root;
}
// A fake Nemotron: the sort marks Stella a person, "wow" other, ACM as M&T-like mine, the rest products; the judge spells
// from the results it was given, and once tries a spelling no result holds.
const fakeAsk = (calls) => async (prompt) => {
  calls.push(prompt);
  if (prompt.startsWith('Each line')) {
    const rows = [...prompt.matchAll(/^(\d+): "([^"]+)"/gm)].map(([, i, w]) => ({ i: Number(i), kind: w === 'Stella' ? 'person' : w === 'wow' ? 'other' : 'product', confident: true, mine: w === 'ACM' ? 'Acme' : null }));
    return `Sure.\n${JSON.stringify(rows)}`;
  }
  if (prompt.includes('"Quoltrix"')) return '{"spelling": "Qualtrics", "url": "https://www.qualtrics.com/x"}';
  if (prompt.includes('"Macbok"')) return '{"spelling": "MacBook Air", "url": "https://apple.com"}';
  return '{"spelling": null}';
};
const fakeSearch = (queries) => async (query) => {
  queries.push(query);
  if (query.startsWith('Quoltrix')) return [{ title: 'Qualtrics survey software', url: 'https://www.qualtrics.com/x', content: 'Qualtrics XM' }];
  return [{ title: 'Laptops', url: 'https://apple.com', content: 'MacBook Pro' }];
};

test('own words first, then the web; people never searched; a spelling no source holds is dropped', async () => {
  const root = await home();
  const prompts = [], queries = [];
  const out = await checkNames({ home: root, id: ID, ask: fakeAsk(prompts), search: fakeSearch(queries), workstreams: [{ name: 'Acme Bank' }, { name: 'M&T Bank' }], contacts: ['Ana Ortiz'] });
  const w = out.words;
  assert.deepEqual(w.Lena, { kind: 'person' }, 'a person on the call, known by code');
  assert.deepEqual(w.Stella, { kind: 'person' }, 'a name the model sorted out');
  assert.equal(w.Loggy.kind, 'fix'); assert.equal(w.Loggy.to, 'Loggie'); assert.equal(w.Loggy.from, 'words');
  assert.equal(w.Lockie.to, 'Loggie', 'sounds like one of your words');
  assert.equal(w.MNT.to, 'M&T', '"&" heard as "n", without the model'); assert.ok(!prompts[0].includes('"MNT"'));
  assert.equal(w.ACM.kind, 'fix'); assert.equal(w.ACM.to, 'Acme'); assert.match(w.ACM.source.label, /workstream "Acme Bank"/);
  assert.equal(w.Quoltrix.kind, 'fix'); assert.equal(w.Quoltrix.to, 'Qualtrics'); assert.equal(w.Quoltrix.source.label, 'qualtrics.com');
  assert.equal(w.Macbok.kind, 'none', 'the judge said "MacBook Air", which no result holds');
  assert.equal(w.wow.kind, 'none');
  assert.ok(!w.marked, 'a header line is not speech');
  assert.match(w['2025'].why, /number/);
  assert.deepEqual(queries, ['Quoltrix Acme Bank', 'Macbok Acme Bank'], 'only the word and the workstream go out');
  for (const q of queries) for (const name of ['lena', 'stella', 'yuki', 'park']) assert.ok(!q.toLowerCase().includes(name), `a person in "${q}"`);
  const saved = JSON.parse(await readFile(join(root, 'calls', ID, 'name-checks.json'), 'utf8'));
  assert.equal(saved.status, 'done');
  assert.equal(saved.queries.length, 2);
});

test('with no search (no key), the web words stay as heard and say why', async () => {
  const root = await home();
  const out = await checkNames({ home: root, id: ID, ask: fakeAsk([]), search: null, workstreams: [{ name: 'Acme Bank' }] });
  assert.equal(out.words.Quoltrix.kind, 'none');
  assert.equal(out.words.Loggy.kind, 'fix', 'own words still work offline');
  const failing = await checkNames({ home: root, id: ID, ask: fakeAsk([]), search: async () => { throw new Error('search is off'); }, workstreams: [{ name: 'Acme Bank' }] });
  assert.match(failing.words.Quoltrix.why, /search is off/);
});

test('✓ teaches my-words.txt, Undo takes exactly that back, ✕ keeps the heard spelling', async () => {
  const root = await home();
  await checkNames({ home: root, id: ID, ask: fakeAsk([]), search: fakeSearch([]), workstreams: [{ name: 'Acme Bank' }] });
  await acceptName({ home: root, id: ID, heard: 'Quoltrix' });
  await acceptName({ home: root, id: ID, heard: 'Loggy' });
  let words = await readFile(join(root, 'my-words.txt'), 'utf8');
  assert.match(words, /^Qualtrics: Quoltrix$/m);
  assert.match(words, /^Loggie: Loggy$/m, 'already there: unchanged');
  await undoName({ home: root, id: ID, heard: 'Quoltrix' });
  words = await readFile(join(root, 'my-words.txt'), 'utf8');
  assert.ok(!/Qualtrics/.test(words));
  await undoName({ home: root, id: ID, heard: 'Loggy' });
  assert.match(await readFile(join(root, 'my-words.txt'), 'utf8'), /^Loggie: Loggy$/m, 'Undo never removes what was there before');
  await keepName({ home: root, id: ID, heard: 'ACM' });
  const saved = JSON.parse(await readFile(join(root, 'calls', ID, 'name-checks.json'), 'utf8'));
  assert.deepEqual([saved.accepted, saved.kept], [{}, { ACM: true }], 'both accepts were undone; ✕ kept ACM');
  await assert.rejects(acceptName({ home: root, id: ID, heard: 'wow' }), /no suggestion/);
});

test('helpers: unclear words once each without marks; people from the call and Contacts; replies with words around JSON', () => {
  assert.deepEqual(unclearWords('a MNT (unclear) Bank and MNT (unclear) again; Emin\'s (unclear) slides').map((w) => w.heard), ['MNT', 'Emin']);
  assert.ok(!unclearWords('x Loki (unclear) y')[0].context.includes('(unclear)'));
  const people = knownPeople({ event: { names: 'Lena Park', emails: ['ana.ortiz@acme.example'] }, contacts: ['Sam Lee', 'Acme'], transcript: '[01:00] Speaker 3 (Taisu): hi' });
  for (const name of ['lena', 'park', 'ana', 'ortiz', 'sam', 'lee', 'taisu']) assert.ok(people.has(name), name);
  assert.ok(!people.has('acme'), 'a one-word contact may be a company');
  assert.deepEqual(firstJson('Here: [{"i": 0}] done'), [{ i: 0 }]);
  assert.ok(resembles('Helten', 'Hilton')); assert.ok(resembles('MatBook', 'MacBook')); assert.ok(!resembles('Mac', 'Loggie')); assert.ok(!resembles('UB', 'University at Buffalo'));
  assert.equal(soundex('Lockie'), soundex('Loggie')); assert.equal(soundex('Loki'), 'L200'); assert.notEqual(soundex('Logan'), soundex('Loggie'));
  assert.equal(trimFollowing('M&T Bank', 'MNT', 'about MNT Bank through'), 'M&T');
  assert.equal(trimFollowing('Qualtrics', 'Quoltrix', 'the Quoltrix survey'), 'Qualtrics');
  assert.deepEqual(parseMyWords('# c\nLoggie: Loggy, Loggi\nPlain'), [{ canonical: 'Loggie', heardAs: ['Loggy', 'Loggi'] }, { canonical: 'Plain', heardAs: [] }]);
});

test('Tavily: the key from the keychain, results trimmed', async () => {
  const sent = [];
  const search = createTavily({ keyImpl: async () => 'tvly-test', fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true, json: async () => ({ results: [{ title: 'A', url: 'https://a.example', content: 'x'.repeat(900) }] }) }; } });
  const results = await search('Quoltrix Acme Bank');
  assert.equal(results[0].content.length, 600);
  assert.equal(sent[0].init.headers.authorization, 'Bearer tvly-test');
  assert.deepEqual(JSON.parse(sent[0].init.body), { query: 'Quoltrix Acme Bank', max_results: 3 });
});

test('Tavily: search options from the docs go in the body, and advanced costs 2', async () => {
  const sent = [];
  const search = createTavily({ keyImpl: async () => 'k', fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ results: [
    { title: 'A', url: 'https://a.example', content: 'a', score: 0.81, published_date: 'Tue, 07 Oct 2026 12:00:00 GMT' }, { title: 'B', url: 'https://b.example', content: 'b' }] }) }; } });
  const results = await search('M&T Bank', { topic: 'news', time_range: 'month', include_domains: ['bank.example'], include_domains_mode: 'prefer', max_results: 5, search_depth: undefined, junk: 1 });
  assert.deepEqual(sent[0], { query: 'M&T Bank', max_results: 5, topic: 'news', time_range: 'month', include_domains: ['bank.example'], include_domains_mode: 'prefer' });
  assert.deepEqual(results.map((r) => [r.score, r.published]), [[0.81, 'Tue, 07 Oct 2026 12:00:00 GMT'], [0, null]]);
  assert.equal(searchCredits({ search_depth: 'advanced' }), 2);
  assert.equal(searchCredits({}), 1);
});

test('an interview sends no word around an unclear one: own words only, nothing sorted or searched', async () => {
  // loggie-interview-privacy: the words around come from transcript.md, where surnames and held sentences are.
  for (const event of [{ title: 'Mock interview', names: 'Lena Park', me: 'Yuki', workstream: 'Acme Bank' }, { title: 'Prep', category: 'interview', names: 'Lena Park', me: 'Yuki' }]) {
    const root = await home();
    await writeFile(join(root, 'calls', ID, 'event.json'), JSON.stringify(event));
    const prompts = [], queries = [];
    const out = await checkNames({ home: root, id: ID, ask: fakeAsk(prompts), search: fakeSearch(queries), workstreams: [{ name: 'Acme Bank' }, { name: 'M&T Bank' }] });
    assert.deepEqual(prompts, []); assert.deepEqual(queries, []);
    assert.equal(out.words.Quoltrix.kind, 'none'); assert.equal(out.words.Quoltrix.why, 'An interview: not sorted or searched');
    assert.equal(out.words.MNT.to, 'M&T', 'the own-words steps still run on the Mac');
    assert.equal(out.note, "An interview: people's full names stay on this Mac, so no word was sent.");
  }
});

test('a spelling made on its own is kept as heard with ✕, before any name check ran', async () => {
  // loggie-auto-spelling: the summary's pair says MNT was written M&T (held.json "spelled"); ✕ starts the record.
  const root = await home();
  const folder = join(root, 'calls', ID);
  await writeFile(join(folder, 'held-2.json'), JSON.stringify({ spelled: { MNT: { to: 'M&T', rule: 'ampersand', source: 'workspace "M&T Bank"' } } }));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', provider: 'nebius', checks: [], privacy: { outbound: 'outbound-2.md', held_file: 'held-2.json' } }]));
  await keepName({ home: root, id: ID, heard: 'MNT' });
  const saved = JSON.parse(await readFile(join(folder, 'name-checks.json'), 'utf8'));
  assert.deepEqual(saved.kept, { MNT: true });
  await assert.rejects(keepName({ home: root, id: ID, heard: 'Zorp' }), /not checked/, 'a word neither checked nor spelled');
});
