import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactKey, contactMap, nameChats, peopleOf, readContacts } from '../src/hikyaku/contacts.js';

test('contactKey: every spelling of a number meets on its last 10 digits; short codes have no key', () => {
  assert.equal(contactKey('+1 (323) 555-0141'), '3235550141');
  assert.equal(contactKey('+13235550141'), '3235550141');
  assert.equal(contactKey('3235550141'), '3235550141');
  assert.equal(contactKey('Jamie@Bank.Example'), 'jamie@bank.example');
  assert.equal(contactKey('94067'), '');
  assert.equal(contactKey(''), '');
});

test('contactMap: first name wins, a company stands in for a person with no name, blanks are dropped', () => {
  const names = contactMap([
    { key: '+1 (323) 555-0141', name: 'Jonah', org: null },
    { key: '+13235550141', name: 'Someone Else', org: null },
    { key: 'desk@acme.example', name: '', org: 'Acme Bank' },
    { key: '+16075550100', name: '', org: '' },
  ]);
  assert.equal(names.get('3235550141'), 'Jonah');
  assert.equal(names.get('desk@acme.example'), 'Acme Bank');
  assert.equal(names.has('6075550100'), false);
});

test('readContacts: reads every source, and a source that fails gives no names instead of an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contacts-'));
  await mkdir(join(root, 'Sources', 'A'), { recursive: true });
  await mkdir(join(root, 'Sources', 'B'), { recursive: true });
  const seen = [];
  const execImpl = async (binary, args) => {
    seen.push(args[2]);
    if (args[2].includes(join('Sources', 'B'))) return { stdout: JSON.stringify([{ key: '+13235550141', name: 'Jonah', org: null }]) };
    throw new Error('no such table');
  };
  const names = await readContacts({ root, execImpl });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((file) => file.endsWith('AddressBook-v22.abcddb')));
  assert.equal(names.get('3235550141'), 'Jonah');
});

test('nameChats: a bare-number chat takes the Contacts name; names the app gave and group titles stay', () => {
  const names = new Map([['3235550141', 'Jonah'], ['6075550100', 'Ivy']]);
  const result = { messages: { status: 'ok', chats: [
    { id: '1', title: '+13235550141', isGroup: false, participants: [{ handle: '+13235550141', name: null }], messages: [] },
    { id: '2', title: 'Hotel team', isGroup: true, participants: [{ handle: '+16075550100', name: null }, { handle: '+16075550199', name: null }], messages: [] },
    { id: '3', title: 'Ana', isGroup: false, participants: [{ handle: '+16075550100', name: 'Ana' }], messages: [] },
  ] }, whatsapp: { status: 'off', chats: [] } };
  const out = nameChats(result, names);
  assert.equal(out.messages.chats[0].title, 'Jonah');
  assert.equal(out.messages.chats[0].participants[0].name, 'Jonah');
  assert.equal(out.messages.chats[1].title, 'Hotel team');
  assert.equal(out.messages.chats[1].participants[0].name, 'Ivy');
  assert.equal(out.messages.chats[1].participants[1].name, null);
  assert.equal(out.messages.chats[2].title, 'Ana');
  assert.equal(out.messages.chats[2].participants[0].name, 'Ana');
  assert.deepEqual(out.whatsapp, result.whatsapp);
  assert.equal(nameChats(result, new Map()), result);
});

test('peopleOf: a company card is not a person, so its words never stop a web search', () => {
  const names = contactMap([
    { key: '+16075550199', name: '', org: 'HPU Business Office' },
    { key: 'lena@acme.example', name: 'Lena Park', org: 'Acme Bank' },
    { key: '+16075550123', name: 'Acme Bank', org: '' },
    { key: 'desk@acme.example', name: '', org: 'Acme Bank' },
  ]);
  assert.deepEqual(peopleOf(names), ['Lena Park', 'Acme Bank']);
  const typed = new Map([['a', 'Hpu Business Office'], ['b', 'IT Help Desk'], ['c', 'Lena Teamster'], ['d', 'Will Officer'], ['e', 'Career Center']]);
  assert.deepEqual(peopleOf(typed), ['Lena Teamster', 'Will Officer'], 'office words count only as whole words');
  assert.deepEqual(peopleOf(new Map([['k', 'Jonah Hill']])), ['Jonah Hill']);
  assert.deepEqual(peopleOf(null), []);
});
