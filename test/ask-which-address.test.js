// "Which Rowena?" shows each one's address (loggie-intros fix 1, 2026-10-20): Gio could not tell which Rowena was
// at the bank, because the choices showed only names. The real runner and resolver, made-up people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker, choiceLabel } from '../src/hikyaku/ask-run.js';
import { askMove } from '../src/hikyaku/do-it.js';

// Same name, two addresses: the twins question. Two names that both answer "rowena": the many question.
const twins = [
  { name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rpatel5@bank.example', last: '2026-10-20T14:29:10Z' },
  { name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rp824@school.example', last: '2026-10-02T10:00:00Z' },
];
const many = [
  { name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rpatel5@bank.example', last: '2026-10-20T14:29:10Z' },
  { name: 'Rowena Shah', kind: 'person', app: 'outlook', email: 'rshah@school.example', last: '2026-10-02T10:00:00Z' },
  { name: 'Rowena Shah', kind: 'person', app: 'messages', chatId: '7', address: '+13235550111', last: '2026-10-01T10:00:00Z' },
];
const home = await mkdtemp(join(tmpdir(), 'which-'));
const asker = (entries) => createAsker({ home, loadIndex: async () => entries, openChat: async () => ({ opened: 'none', mode: 'failed' }), email: { threads: async () => [], consent: async () => true, settings: async () => ({}) } });

test('choiceLabel: the name and the address; a chat its handle; a group the name alone', () => {
  assert.equal(choiceLabel(twins[0]), 'Rowena Patel <rpatel5@bank.example>');
  assert.equal(choiceLabel(many[2]), 'Rowena Shah <+13235550111>');
  assert.equal(choiceLabel({ name: 'Hackathon Team', kind: 'group', app: 'whatsapp', chatId: '9', address: null }), 'Hackathon Team');
});

for (const [shape, entries] of [['twins (one name, two addresses)', twins], ['many (two names)', many]]) {
  test(`which Rowena, ${shape}: the preview's line and every choice hold the address`, async () => {
    const preview = await asker(entries).preview('email rowena about friday');
    assert.equal(preview.status, 'which');
    const item = preview.who.find((who) => who.status === 'many');
    for (const candidate of item.candidates) {
      assert.ok(candidate.address, JSON.stringify(candidate));
      assert.equal(candidate.label, `${candidate.name} <${candidate.address}>`);
      assert.ok(preview.line.includes(candidate.label), preview.line);
    }
    assert.ok(preview.line.includes('Rowena Patel <rpatel5@bank.example>'), preview.line);
  });
}

test('the run asks back with the addresses, and a move stopped on it (Needs you) says them too', async () => {
  const box = asker(twins);
  const done = await box.run('email rowena about friday').done;
  assert.equal(done.outcome, 'question');
  assert.match(done.lines[0], /Rowena Patel <rpatel5@bank\.example>.*Rowena Patel <rp824@school\.example>/);
  assert.deepEqual(done.who[0].candidates.map((c) => c.label), ['Rowena Patel <rpatel5@bank.example>', 'Rowena Patel <rp824@school.example>']);
  await mkdir(join(home, 'task'), { recursive: true });
  const state = await askMove({ taskDirectory: join(home, 'task'), home, reply: { ask: { line: 'email rowena about friday', to: 'Rowena Patel' } }, ask: async (text) => box.run(text).done });
  assert.equal(state.phase, 'needs-you');
  assert.match(state.question, /rpatel5@bank\.example/);
  assert.match(state.question, /rp824@school\.example/);
});
