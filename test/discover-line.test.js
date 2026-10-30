// The status line after a look for workspaces (src/hikyaku/discover.js discoverLine, spec B2): what it found, or why
// it waits, in plain words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverLine, NO_MAIL_SOURCE, SKIP_NO_KEY, SKIP_NO_YES } from '../src/hikyaku/discover.js';

test('each skip says what the user can do about it', () => {
  assert.equal(discoverLine({ log: { skipped: NO_MAIL_SOURCE } }), NO_MAIL_SOURCE);
  assert.equal(discoverLine({ log: { skipped: SKIP_NO_YES } }), 'Workspaces wait for your yes: press Yes on the card on Today.');
  assert.equal(discoverLine({ log: { skipped: SKIP_NO_KEY } }), 'Workspaces wait for your Nebius key: paste it in Settings, Cloud analysis.');
  assert.equal(discoverLine({ log: { skipped: 'the mail could not be read.' } }), 'Workspaces wait: the mail could not be read.');
});

test('a look that ran says how many it found, and nothing when it found none', () => {
  assert.equal(discoverLine({ log: { read: 120, added: [{ name: 'Test Club' }], skipped: [] }, days: 30 }), 'Found 1 workspace in the last 30 days.');
  assert.equal(discoverLine({ log: { read: 120, added: [{ name: 'A' }, { name: 'B' }], skipped: [] }, days: 30 }), 'Found 2 workspaces in the last 30 days.');
  assert.equal(discoverLine({ log: { read: 263, added: [], skipped: [] }, days: 7 }), '', 'nothing new says nothing (2026-10-28)');
});
