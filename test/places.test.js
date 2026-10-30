// Places the user has used before (loggie-ask-wordmap): from calendar locations and from filled invites. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaces, placeName, placesFrom, rememberPlace } from '../src/hikyaku/places.js';
import { readSentence } from '../src/hikyaku/quick-invite.js';

test('a calendar location becomes the place a person would type; links and numbers are not places', () => {
  assert.equal(placeName('Birch Hall 101, Example University'), 'Birch Hall');
  assert.equal(placeName('Birchwood Cafe; back room'), 'Birchwood Cafe');
  assert.equal(placeName('https://zoom.us/j/123'), '');
  assert.equal(placeName('Microsoft Teams Meeting'), '');
  assert.equal(placeName('+1 (555) 010-2000'), '');
  assert.deepEqual(placesFrom([{ location: 'Statler' }, { location: 'Birch Hall 101' }, { location: 'Statler, 2nd floor' }, { location: '' }]), ['Statler', 'Birch Hall']);
});

test('a place typed into a filled invite is remembered, newest first, once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-places-'));
  await rememberPlace('Birchwood Cafe', { home });
  await rememberPlace('Statler', { home });
  await rememberPlace('birchwood cafe', { home });
  assert.deepEqual(await loadPlaces({ home }), ['birchwood cafe', 'Statler']);
});

test('a bare place is the place only when it is one the user has used', () => {
  const people = [{ name: 'Nina Patel', address: 'nina@example.edu', count: 1 }];
  const now = new Date(2026, 9, 12, 9, 0);
  assert.equal(readSentence('nina fri 4pm birchwood cafe', { people, now, places: ['Birchwood Cafe'] }).place, 'birchwood cafe');
  assert.deepEqual(readSentence('nina fri 4pm birchwood cafe', { people, now, places: [] }).leftOut, ['birchwood', 'cafe']);
});
