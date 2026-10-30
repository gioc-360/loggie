import assert from 'node:assert/strict';
import test from 'node:test';
import { collectIntros, firstNameFrom, introFrom, introQuery } from '../src/hikyaku/voice.js';

const sent = (body, from = 'Lena Park <lena@school.edu>') => ({ id: body.slice(0, 8), from, to: 'jamie@example.com', timestamp: '2026-09-20T00:00:00Z', subject: 'Hello', body });

test('the first name comes from the user\'s own sent mail, not from anyone else\'s', () => {
  const threads = [{ messages: [sent('a'), sent('b', '"Lena Park" <lena@school.edu>'), sent('c', 'Jamie Ito <jamie@example.com>')] }];
  assert.equal(firstNameFrom(threads, 'lena@school.edu'), 'Lena');
  assert.equal(firstNameFrom([{ messages: [sent('d', 'lena@school.edu')] }], 'lena@school.edu'), '');
  // A "Last, First" display name gives the first name, as the Found step reads it (cleanup audit bug 14).
  assert.equal(firstNameFrom([{ messages: [sent('e', '"Park, Lena" <lena@school.edu>')] }], 'lena@school.edu'), 'Lena');
});

test('an intro is found by the user\'s own name, so the cues work for anyone, not one person', () => {
  const body = 'Hi Jamie,\n\nI\'m Lena and I work on the product team at Acme. Would you have 20 minutes this week?\n\nBest,\nLena';
  assert.match(introFrom(body, 'Lena'), /^Hi Jamie,\n\nI'm Lena and I work/);
  assert.equal(introFrom(body, ''), null);
  assert.match(introQuery('Lena'), /"I'm Lena" OR "I am Lena" OR "this is Lena"/);
  assert.doesNotMatch(introQuery(''), /I'm/);
});

test('a signature never makes a short reply count as an intro', () => {
  const reply = 'Yes, that works.\n\nBest regards,\nLena Park\nMBA Candidate, Class of 2027\nSchool of Management\nlena@school.edu';
  assert.equal(introFrom(reply, 'Lena'), null);
  assert.equal(introFrom('Lena Park\nMBA Candidate, Class of 2027\nSchool of Management\nMobile: +1 555 010 0000\nlena@school.edu\nschool.edu | LinkedIn', 'Lena'), null);
  const intros = collectIntros([{ messages: [sent(reply)] }], 'lena@school.edu');
  assert.equal(intros.length, 0);
});

test('the intro keeps the user\'s words and drops the signature under them', () => {
  const body = 'Hi Jamie,\n\nMy name is Lena, a second-year MBA. I saw your talk on supply chains and would love to hear more.\n\nBest regards,\nLena Park\nMBA Candidate, Class of 2027';
  const intro = introFrom(body, 'Lena');
  assert.match(intro, /My name is Lena/);
  assert.doesNotMatch(intro, /Class of 2027/);
});

test('voice/rules.md is read before anything else when drafting', async () => {
  const { headlessPrompt } = await import('../src/hikyaku/headless.js');
  const prompt = headlessPrompt('task_1', { voiceDirectory: '/v' });
  assert.ok(prompt.indexOf('/v/rules.md') < prompt.indexOf('/v/recent.md') && prompt.indexOf('/v/recent.md') < prompt.indexOf('/v/intros.md'), 'rules first, then recent edits, then intros');
  assert.match(prompt, /never repeat what the user already said there \(thanks, an apology, an introduction\)/);
});
