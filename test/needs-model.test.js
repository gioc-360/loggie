import test from 'node:test';
import assert from 'node:assert/strict';
import { askParts } from '../desktop/renderer/needs-model.js';

test('a failure loses its command line and keeps what to do; the named answers become options', () => {
  const q = 'The Outlook helper failed. Command failed: /Users/x/Loggie/bin/hikyaku-outlook reply --sender a@bank.example --subject RE: Offer | Gio --background The draft is kept. Answer "again" to look for the email again, or "new" to open it as a new message instead.';
  const parts = askParts(q);
  assert.equal(parts.plain, 'The Outlook helper failed. The draft is kept. Answer "again" to look for the email again, or "new" to open it as a new message instead.');
  assert.deepEqual(parts.options, ['again', 'new']);
  assert.equal(parts.hadCommand, true);
});

test('only quotes after the last "Answer" are options, so a quoted source is not a button', () => {
  const q = 'Submit your application. The source says: "Application Deadline: Nov 11". Answer "done" if you did it, "not yet" to send the email without claiming it, or "skip".';
  assert.deepEqual(askParts(q).options, ['done', 'not yet', 'skip']);
  assert.deepEqual(askParts('Which room?').options, []);
  assert.deepEqual(askParts(null), { plain: '', options: [], hadCommand: false });
});
