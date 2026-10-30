// A contact whose name is also a filler word ("Will", "Real") is still read as the person in a message ask, as
// findPeople already reads them in an invite (cleanup audit bug 15). Made-up names only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readMessage } from '../src/hikyaku/wordmap.js';

const isName = (name) => ['will', 'real', 'dana'].includes(String(name).toLowerCase());

test('a contact named Will is the person a message goes to', () => {
  assert.deepEqual(readMessage('text Will that I am running late', { isName })?.who, ['Will']);
  assert.deepEqual(readMessage('text Dana that I am running late', { isName })?.who, ['Dana']);
  assert.equal(readMessage('text will that I am running late', { isName: () => false }), null, 'no contact named Will: still filler');
});
