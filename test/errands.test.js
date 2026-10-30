import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runErrands, runErrandsSafe } from '../src/hikyaku/look-outside.js';

// One saved call with the user's own steps (owner "Yuki"), as the cloud summary writes them, and a stub for every
// outside call: no test reaches the network.
const ID = '2026-10-09-1258-acme-chat';
const PAGE = 'Registration for the 2026 hackathon is open now. Teams of up to four sign up on the 2026 page before October 20, and each team submits one video under three minutes.';

async function callHome(steps, { event = { title: 'Acme chat', names: 'Lena Park', me: 'Yuki', workstream: 'Acme Bank' }, transcript = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-errands-'));
  const folder = join(root, 'calls', ID);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify(event));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', provider: 'nebius', checks: [] }]));
  await writeFile(join(folder, 'summary-nebius.md'), `# Acme chat\n\n## Background\n- Talked about the hackathon [01:00]\n\n## Next Steps\n${steps.map((s) => `- ${s}`).join('\n')}\n`);
  await writeFile(join(folder, 'transcript.md'), transcript);
  return { root, folder, file: join(folder, 'errands.json') };
}
const readErrands = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exists = (path) => stat(path).then(() => true, () => false);

// A fake Nemotron: the sort marks every line by `kinds` (default lookup) with a query from `queries` (default one with no
// person in it); the judge answers from passage 1 with a quote that is on the page.
function fakes({ kinds = [], queries = [], anchors = [], plan = null, onSort = null } = {}) {
  const calls = { search: [], extract: [], ask: [], options: [] };
  return {
    calls,
    search: async (query, options) => { calls.search.push(query); calls.options.push(options); return [{ title: 'Hackathon 2026', url: 'https://example.com/2026', content: 'Registration is open.' }]; },
    extract: async (urls, query) => { calls.extract.push({ urls, query }); return [{ url: 'https://example.com/2026', content: PAGE }]; },
    ask: async (prompt) => {
      calls.ask.push(prompt);
      if (prompt.startsWith('From one recorded work call')) return JSON.stringify(plan || { orgs: [], questions: [] });
      if (prompt.startsWith('Each numbered line')) {
        if (onSort) await onSort();
        const count = [...prompt.matchAll(/^\d+\. /gm)].length;
        return JSON.stringify(Array.from({ length: count }, (_, i) => ({ n: i + 1, kind: kinds[i] || 'lookup', anchor: anchors[i] || '', query: queries[i] || `hackathon rules page ${i + 1}` })));
      }
      return JSON.stringify({ verdict: 'answered', answer: 'The 2026 page is the one to use.', source: 1, quote: 'Teams of up to four sign up on the 2026 page before October 20' });
    },
  };
}

test('writes checking then done', async () => {
  const { root, file } = await callHome(['Confirm the hackathon sign-up link is the 2026 one (Yuki) [02:00]', 'Write the pitch (Yuki)', 'Send Lena the deck (Lena)']);
  const seen = [];
  const f = fakes({ kinds: ['confirm', 'none'], onSort: async () => seen.push((await readErrands(file)).status) });
  const out = await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  assert.deepEqual(seen, ['checking'], 'the sort is asked while errands.json says checking');
  const saved = await readErrands(file);
  assert.equal(saved.status, 'done');
  assert.deepEqual(out, saved);
  assert.equal(saved.v, 1);
  assert.equal(saved.note, null);
  assert.deepEqual(Object.keys(saved.steps), ['confirm-the-hackathon-sign-up-link-is-the-2026-one', 'write-the-pitch'], 'only the user\'s own steps');
  const confirm = saved.steps['confirm-the-hackathon-sign-up-link-is-the-2026-one'];
  assert.equal(confirm.step, 'Confirm the hackathon sign-up link is the 2026 one');
  assert.equal(confirm.verdict, 'answered');
  assert.deepEqual(confirm.source, { title: 'Hackathon 2026', url: 'https://example.com/2026' });
  assert.equal(confirm.credits, 2);
  assert.deepEqual(saved.steps['write-the-pitch'], { step: 'Write the pitch', kind: 'none', query: '', verdict: 'skipped', answer: null, quote: null, source: null, why: 'not a web errand', credits: 0 });
  assert.equal(saved.credits, 2);
  assert.match(f.calls.ask[0], /in the workstream "Acme Bank"/);
  const usage = (await readFile(join(root, 'tavily-usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(usage.map((row) => [row.path, row.kind, row.credits]), [['errands', 'search', 1], ['errands', 'extract', 1]]);
});

test('no consent writes done with note', async () => {
  const { root, file } = await callHome(['Find the official rules page (me)']);
  const f = fakes();
  const out = await runErrands({ home: root, id: ID, ask: null, search: f.search, extract: f.extract });
  assert.deepEqual(await readErrands(file), out);
  assert.equal(out.status, 'done');
  assert.equal(out.note, 'no yes for the cloud on this call');
  assert.deepEqual(out.steps, {});
  assert.equal(f.calls.search.length, 0, 'nothing goes to Tavily without the yes');
  assert.equal(await exists(join(root, 'tavily-usage.jsonl')), false);
});

test('no steps of the user writes done with note', async () => {
  const { root } = await callHome(['Send the deck (Lena)']);
  const f = fakes();
  const out = await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  assert.equal(out.note, 'no steps of yours');
  assert.equal(out.status, 'done');
  assert.equal(f.calls.ask.length, 1, 'no sort call, but the call is still read for questions and news');
  assert.match(f.calls.ask[0], /^From one recorded work call/);
});

test('done is not run again', async () => {
  const { root, file } = await callHome(['Find the official rules page (me)']);
  const first = fakes();
  await runErrands({ home: root, id: ID, ask: first.ask, search: first.search, extract: first.extract });
  const before = await readFile(file, 'utf8');
  const again = fakes();
  assert.equal(await runErrands({ home: root, id: ID, ask: again.ask, search: again.search, extract: again.extract }), null);
  assert.equal(again.calls.ask.length + again.calls.search.length, 0);
  assert.equal(await readFile(file, 'utf8'), before, 'errands.json untouched');
  // A run still checking less than 10 minutes ago is left alone; an older one is taken as dead and run again.
  await writeFile(file, JSON.stringify({ v: 1, status: 'checking', at: new Date(Date.now() - 60 * 1000).toISOString(), note: null, credits: 0, steps: {} }));
  assert.equal(await runErrands({ home: root, id: ID, ask: again.ask, search: again.search, extract: again.extract }), null);
  await writeFile(file, JSON.stringify({ v: 1, status: 'checking', at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), note: null, credits: 0, steps: {} }));
  assert.equal((await runErrands({ home: root, id: ID, ask: again.ask, search: again.search, extract: again.extract })).status, 'done');
});

test('second start of the same id returns null', async () => {
  const { root } = await callHome(['Find the official rules page (me)']);
  let release, sorting;
  const gate = new Promise((resolve) => { release = resolve; });
  // Waits for the first run to reach its sort, not for a fixed 20 ms (cleanup audit bug 22: flaky under load).
  const reached = new Promise((resolve) => { sorting = resolve; });
  const f = fakes({ onSort: () => { sorting(); return gate; } });
  const first = runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract });
  await reached;
  assert.equal(f.calls.ask.length, 1, 'the first run is waiting on its sort');
  assert.equal(await runErrandsSafe({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract }), null);
  release();
  assert.equal((await first).status, 'done');
  assert.equal(f.calls.ask.filter((prompt) => prompt.startsWith('Each numbered line')).length, 1, 'one sort only');
});

test('failure is written, not thrown', async () => {
  const { root, file } = await callHome(['Find the official rules page (me)']);
  const f = fakes();
  const ask = async (prompt) => { if (prompt.startsWith('Each numbered line')) throw 'boom'; return f.ask(prompt); }; // eslint-disable-line no-throw-literal
  assert.equal(await runErrandsSafe({ home: root, id: ID, ask, search: f.search, extract: f.extract }), null);
  const saved = await readErrands(file);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.note, 'boom');
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.steps, {});
  assert.equal(saved.credits, 0);
  assert.ok(Date.parse(saved.at) > 0);
  // A folder that cannot be written fails quietly too: nothing is thrown into the yes.
  assert.equal(await runErrandsSafe({ home: join(root, 'nowhere'), id: ID, ask, search: f.search, extract: f.extract }), null);
});

test('invalid id writes nothing', async () => {
  const { root, file } = await callHome(['Find the official rules page (me)']);
  const f = fakes();
  for (const id of ['../escape', '', 'a/b', '.']) assert.equal(await runErrandsSafe({ home: root, id, ask: f.ask, search: f.search, extract: f.extract }), null);
  assert.equal(f.calls.ask.length, 0);
  assert.equal(await exists(file), false);
  assert.equal(await exists(join(root, 'calls', 'errands.json')), false);
  assert.equal(await exists(join(root, 'errands.json')), false);
});

test('same step twice', async () => {
  const { root, file } = await callHome(['Find the official rules page (me)', 'Find the official rules page. (me)']);
  const f = fakes();
  await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract });
  assert.equal(f.calls.search.length, 1, 'the second step with the same key is not searched');
  const saved = await readErrands(file);
  assert.deepEqual(Object.keys(saved.steps), ['find-the-official-rules-page']);
  assert.equal(saved.steps['find-the-official-rules-page'].verdict, 'answered', 'the first step keeps its answer');
});

test('caps', async () => {
  const steps = ['Find the rules page (me)', 'Look up the venue page (me)', 'Confirm the deadline (me)', 'Research judging criteria (me)', 'Find the prize list (me)', 'Look up the Lena Park bio (me)'];
  const { root, file } = await callHome(steps);
  // The first line's query names a person on the call: skipped without using a slot, so lines 2 to 4 are searched.
  const f = fakes({ queries: ['Lena Park hackathon rules'] });
  await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract });
  assert.equal(f.calls.search.length, 3, '5 web errands with a clean query: exactly 3 searched');
  assert.ok(f.calls.extract.length <= 3);
  assert.ok(f.calls.search.every((query) => !/lena|park/i.test(query)), 'no person reached Tavily');
  const saved = await readErrands(file);
  const by = Object.values(saved.steps).map((s) => [s.step, s.verdict, s.why]);
  assert.deepEqual(by, [
    ['Find the rules page', 'skipped', 'names a person'],
    ['Look up the venue page', 'answered', null],
    ['Confirm the deadline', 'answered', null],
    ['Research judging criteria', 'answered', null],
    ['Find the prize list', 'skipped', 'over the 3-errand cap'],
    ['Look up the Lena Park bio', 'skipped', 'over the 3-errand cap'],
  ]);
  const person = saved.steps['find-the-rules-page'];
  assert.equal(person.query, 'Lena Park hackathon rules', 'a skipped step keeps the sort\'s query');
  assert.equal(person.kind, 'lookup');
  assert.equal(person.credits, 0);
  assert.equal(saved.credits, 6);
});

test('unreadable sort reply skips every step with a note', async () => {
  const { root, file } = await callHome(['Find the rules page (me)', 'Look up the venue page (me)']);
  const f = fakes();
  const ask = async (prompt) => (prompt.startsWith('Each numbered line') ? 'I could not do that.' : f.ask(prompt));
  await runErrands({ home: root, id: ID, ask, search: f.search, extract: f.extract });
  const saved = await readErrands(file);
  assert.equal(saved.status, 'done');
  assert.equal(saved.note, 'unreadable sort reply');
  assert.ok(Object.values(saved.steps).every((s) => s.verdict === 'skipped' && s.why === 'not a web errand'));
  assert.equal(f.calls.search.length, 0);
});

test('a speaker in the transcript is a person too', async () => {
  const { root, file } = await callHome(['Find the rules page (me)'], { transcript: '[00:10] Speaker 2 (Taisu): hi\n' });
  const f = fakes({ queries: ['Taisu hackathon rules'] });
  await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, contacts: ['Ana Ortiz'] });
  assert.equal(f.calls.search.length, 0);
  assert.equal((await readErrands(file)).steps['find-the-rules-page'].why, 'names a person');
});

test('the search carries the call\'s anchor, and the step says which', async () => {
  const { root, file } = await callHome(['Research business banking partnerships (Yuki)', 'Find the hackathon rules page (Yuki)']);
  const f = fakes({ kinds: ['research', 'lookup'], anchors: ['Acme Bank', 'Globex'], queries: ['business banking partnerships', 'hackathon rules page'] });
  await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  assert.match(f.calls.ask[0], /titled "Acme chat" in the workstream "Acme Bank"/);
  assert.deepEqual(f.calls.search, ['Acme Bank business banking partnerships', 'hackathon rules page'], 'Globex is not in the title or workstream');
  const steps = Object.values((await readErrands(file)).steps);
  assert.deepEqual(steps.map((s) => [s.query, s.anchor]), [['Acme Bank business banking partnerships', 'Acme Bank'], ['hackathon rules page', null]]);
});

test('the call is read once for its open questions and its organizations, searched the way Tavily\'s docs advise', async () => {
  const { root, folder, file } = await callHome(['Write the pitch (Yuki)'], { event: { title: 'Acme chat', names: 'Lena Park', me: 'Yuki', workstream: 'Acme Bank' } });
  await writeFile(join(folder, 'outbound.md'), '[01:00] Them: I am not sure what the Acme Bank loyalty fee is. Globex came up too, and what Loggie costs.');
  const plan = {
    orgs: [{ name: 'Loggie', site: '' }, { name: 'Acme Bank', site: 'acme.example' }, { name: 'Initech', site: '' }, { name: 'Lena Park', site: '' }, { name: 'Globex', site: 'not a domain' }],
    questions: [
      { question: 'What is the Acme Bank loyalty fee?', anchor: 'Acme Bank', queries: ['loyalty fee 2026', 'Acme Bank loyalty program fee'] },
      { question: 'What does Lena earn?', anchor: 'Lena', queries: ['Lena salary'] },
      { question: 'What is the best bank?', anchor: '', queries: ['best bank'] },
      { question: 'How many franchised rooms?', anchor: '1.35M rooms', queries: ['franchised rooms 1.35M'] },
      { question: 'What does the loyalty fee cost?', anchor: 'loyalty fee', queries: ['loyalty fee cost'] },
      { question: 'What does the Loggie app cost?', anchor: 'Loggie', queries: ['Loggie app price'] },
    ],
  };
  const f = fakes({ kinds: ['none'], plan });
  const out = await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  const planPromptSent = f.calls.ask.find((p) => p.startsWith('From one recorded work call'));
  assert.match(planPromptSent, /Acme Bank loyalty fee/, 'the screened transcript (outbound.md) is read');
  assert.deepEqual(out.questions.map((q) => [q.question, q.queries, q.verdict]), [['What is the Acme Bank loyalty fee?', ['Acme Bank loyalty fee 2026', 'Acme Bank loyalty program fee'], 'answered']],
    'a person, no anchor, a figure or a lowercase phrase is never searched; each query carries the anchor');
  assert.deepEqual(out.news.map((n) => [n.org, n.site, n.verdict]), [['Acme Bank', 'acme.example', 'answered'], ['Globex', null, 'answered']],
    'Loggie is the app itself; Initech was never said in the call; Lena Park is a person; a bad site is dropped');
  assert.deepEqual(f.calls.search, ['Acme Bank', 'Globex', 'Acme Bank loyalty fee 2026', 'Acme Bank loyalty program fee'], 'news first, then the question');
  assert.deepEqual(f.calls.options[0], { topic: 'news', time_range: 'month', max_results: 5, include_domains: ['acme.example'], include_domains_mode: 'prefer' });
  assert.deepEqual(f.calls.options[1], { topic: 'news', time_range: 'month', max_results: 5 });
  assert.deepEqual(f.calls.options[2], { search_depth: 'advanced', max_results: 5 });
  assert.equal(out.questions[0].credits, 5, 'two advanced searches and one extract');
  assert.equal(out.credits, 5 + 2 + 2);
  assert.deepEqual(Object.keys(await readErrands(file)).sort(), ['at', 'credits', 'news', 'note', 'questions', 'status', 'steps', 'v']);
});

test('a call never spends more than the credit cap', async () => {
  const { root } = await callHome(['Research a b c (Yuki)', 'Research d e f (Yuki)', 'Research g h i (Yuki)']);
  const plan = { orgs: [{ name: 'Acme Bank', site: '' }], questions: [1, 2, 3].map((n) => ({ question: `Acme Bank question ${n}?`, anchor: 'Acme Bank', queries: [`Acme Bank fee ${n}`, `Acme Bank rule ${n}`] })) };
  const f = fakes({ kinds: ['research', 'research', 'research'], plan });
  const out = await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  assert.ok(out.credits <= 24, `spent ${out.credits}`);
  assert.equal(out.credits, 3 * 3 + 2 + 2 * 5, 'three research steps (3 each), the news (2), two questions (5 each); 21 + 5 > 24 skips the third');
  assert.deepEqual(out.questions.map((q) => q.why), [null, null, 'over the credit cap']);
  assert.equal(out.news[0].verdict, 'answered');
});

test('an interview: the plan reads the pair its notes came from, never the older outbound.md, and the title goes by first name', async () => {
  // loggie-interview-privacy (Codex review, 2026-10-26): the first outbound.md of the mock interview was screened before
  // the trim and still named everyone in full; the notes came from outbound-2.md.
  const { root, folder } = await callHome(['Write the pitch (Yuki)'], { event: { title: 'Lena Park mock interview', names: 'Lena Park', me: 'Yuki', workstream: 'Acme Bank' } });
  await writeFile(join(folder, 'outbound.md'), '[01:00] Them: Lena Park here, the Acme Bank loyalty fee is unclear.');
  await writeFile(join(folder, 'outbound-2.md'), '[01:00] Them: Lena here, the Acme Bank loyalty fee is unclear.');
  await writeFile(join(folder, 'held-2.json'), JSON.stringify({ trimmed: { Lena: { name: 'Lena Park', forms: ['Lena Park', 'Park'], rule: 'invitee' } } }));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', provider: 'nebius', checks: [], privacy: { outbound: 'outbound-2.md', held_file: 'held-2.json' } }]));
  const f = fakes({ kinds: ['none'], plan: { orgs: [], questions: [] } });
  await runErrands({ home: root, id: ID, ask: f.ask, search: f.search, extract: f.extract, me: 'Yuki' });
  assert.ok(f.calls.ask.length >= 1);
  for (const prompt of f.calls.ask) assert.ok(!/Park/.test(prompt), prompt.slice(0, 300));
  assert.match(f.calls.ask.find((p) => p.startsWith('From one recorded work call')), /Lena here, the Acme Bank loyalty fee/);
});
