import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveSettings } from '../src/hikyaku/draft.js';
import { INBOX, matchWorkstream, readWorkstreams, saveGoal, workstreamQuery } from '../src/hikyaku/workstreams.js';

test('defaults fit the Mac: Outlook only when installed, else Apple Mail; settings always win', async () => {
  const noName = async () => '';
  const none = await resolveSettings({}, { appExists: async () => false, fullName: noName });
  assert.deepEqual([none.mailApp, none.calendarApp, none.agent], ['apple-mail', 'google-calendar', undefined]);
  assert.deepEqual(none.chosen, ['mailApp', 'calendarApp']);
  const outlook = await resolveSettings({}, { appExists: async () => true, fullName: noName });
  assert.deepEqual([outlook.mailApp, outlook.calendarApp], ['outlook', 'outlook']);
  const written = await resolveSettings({ mailApp: 'apple-mail', agent: 'codex' }, { appExists: async () => true, fullName: noName });
  assert.deepEqual([written.mailApp, written.agent], ['apple-mail', 'codex'], 'a stored agent key passes through unread');
  assert.deepEqual(written.chosen, ['calendarApp']);
  // loggie-reply-yes: no signName, so the Mac account's first name signs drafts; a written one always wins.
  const named = await resolveSettings({}, { appExists: async () => true, fullName: async () => 'Gio Caballero' });
  assert.equal(named.signName, 'Gio');
  assert.ok(named.chosen.includes('signName'));
  const own = await resolveSettings({ signName: 'G' }, { appExists: async () => true, fullName: async () => 'Gio Caballero' });
  assert.deepEqual([own.signName, own.chosen.includes('signName')], ['G', false]);
});

test('with no workstreams.json the whole inbox is one workstream, and picking its goal writes the file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-new-'));
  const list = await readWorkstreams(home);
  assert.deepEqual(list.map((item) => item.name), ['Inbox']); assert.equal(list[0].inbox, true);
  assert.equal(workstreamQuery(list[0]), 'in:inbox newer_than:14d');
  assert.equal(matchWorkstream({ subject: 'anything', messages: [{ from: 'a@b.com', body: 'hi' }] }, list), 'Inbox');
  await saveGoal(home, 'Inbox', 'Get it done');
  const saved = JSON.parse(await readFile(join(home, 'workstreams.json'), 'utf8'));
  assert.deepEqual(saved, [{ name: 'Inbox', kind: 'other', domains: [], words: [], inbox: true, goal: 'Get it done' }]);
  assert.equal((await readWorkstreams(home))[0].goal, 'Get it done');
});

test('named workstreams match first; Inbox only catches what nothing else does; a broken file shows nothing, not Inbox', async () => {
  const list = [{ name: 'Acme', kind: 'company', domains: ['example.com'], words: [] }, { ...INBOX }];
  assert.equal(matchWorkstream({ messages: [{ from: 'sam@example.com', body: '' }] }, list), 'Acme');
  assert.equal(matchWorkstream({ messages: [{ from: 'x@example.org', body: '' }] }, list), 'Inbox');
  const pharmco = [{ name: 'Pharmco case comp', kind: 'competition', domains: [], words: ['Pharmco'] }, { ...INBOX }];
  assert.equal(matchWorkstream({ subject: 'Intro', messages: [{ from: 'Dana Pharmco <dana.pharmco@gmail.example>', body: 'Best,\n*Dana Pharmco*' }] }, pharmco), 'Inbox');
  assert.equal(matchWorkstream({ subject: 'Pharmco case packet', messages: [{ from: 'Dana Pharmco <dana.pharmco@gmail.example>', body: '' }] }, pharmco), 'Pharmco case comp');
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-broken-'));
  await writeFile(join(home, 'workstreams.json'), '[{ not json');
  assert.deepEqual(await readWorkstreams(home), []);
});
