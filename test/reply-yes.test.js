// loggie-reply-yes (docs/reply-yes/session.md): the M&T reply of 2026-10-21, on made-up names. The recruiter proposed
// one time; the user's note said yes. The draft confirms that time: no free ranges, no "[your times]", signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsker } from '../src/hikyaku/ask-run.js';
import { threadsFrom } from '../src/hikyaku/ask-thread.js';
import { availabilityAsked, proposesTime, strayTimes } from '../src/hikyaku/availability.js';
import { editDistance, firstNameGreeting, greetingRule, greetingWord, keepsLine, prepareEmailReply } from '../src/hikyaku/ask-reply.js';
import { replyOutcome } from '../src/hikyaku/do-it.js';

const kara = {
  id: 'apple-mail-512', from: 'Kara Wright <kwright2@careers.bank.example>', to: 'me@school.example', cc: '',
  subject: 'Attempt to schedule interview with Example Bank', timestamp: '2026-10-21T15:34:00.000Z',
  body: 'Hello Gio,\n\nCongratulations on a successful interview for the Associate Program.\n\nWe would like to schedule a video interview with Dana Lee to discuss your skills in greater detail.\n\nAre you available on Tuesday, 10/27 at 3PM EST?\n\nI look forward to hearing from you soon!\n\nKara Wright',
};
const NOTE = 'Yes im available to meet with Dana on Tuesday Oct 27 EST and am looking forward to the interview';

function setup({ body, signName = 'Gio' }) {
  return mkdtemp(join(tmpdir(), 'reply-yes-')).then((home) => {
    const seen = { reads: 0, prompts: [], opened: [] };
    const asker = createAsker({
      home, loadIndex: async () => [{ name: 'Kara Wright', kind: 'person', app: 'outlook', email: 'kwright2@careers.bank.example', last: kara.timestamp }],
      openChat: async () => ({ opened: 'none', mode: 'failed' }),
      email: {
        threads: async (address) => threadsFrom([kara], address, ['me@school.example']),
        consent: async () => true, allowAlways: async () => {},
        complete: async (prompt) => { seen.prompts.push(prompt); return JSON.stringify({ body }); },
        events: async () => { seen.reads += 1; return []; }, status: async () => 'authorized',
        openDraft: async ({ taskDirectory }) => { seen.opened.push(await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8')); return { opened: 'outlook', mode: 'reply', detail: '' }; },
        settings: async () => ({ signName, account: 'me@school.example' }),
      },
    });
    return { home, asker, seen };
  });
}

test('a set time in the email is confirmed: no calendar read, no free ranges, the 3 PM kept, signed with the name', async () => {
  const { asker, seen } = await setup({ body: 'Hi Kara,\n\nThank you for your email. Yes, I am available on Tuesday, October 27 at 3 PM EST. Looking forward to the interview.\n\nBest,\nGio' });
  const result = await asker.run(`email kwright2@careers.bank.example: ${NOTE}`, { cloud: 'once', choices: { 'kwright2@careers.bank.example': 'outlook:kwright2@careers.bank.example' } }).done;
  assert.equal(result.outcome, 'placed');
  assert.equal(seen.reads, 0, 'the calendar is not read for a time the sender set');
  assert.doesNotMatch(seen.prompts[0], /exactly \[your times\]/, 'the model is not told to leave a gap');
  assert.match(seen.prompts[0], /End with "Best," and the name Gio/);
  assert.equal(seen.opened.length, 1);
  assert.match(seen.opened[0], /available on Tuesday, October 27 at 3 PM EST\./);
  assert.doesNotMatch(seen.opened[0], /\[your times\]|4 to 4:45|ET\n/);
  assert.match(seen.opened[0], /Best,\nGio\n$/);
});

test('the cue: a proposed time is confirmed unless the user asks to offer others', () => {
  assert.equal(proposesTime(kara.body), true);
  assert.equal(availabilityAsked({ line: NOTE, email: kara.body }), null);
  assert.equal(availabilityAsked({ line: 'that time does not work, send other times', email: kara.body }), 'typed');
  assert.equal(availabilityAsked({ line: "can't do 3, what else works", email: kara.body }), 'typed');
  // No time named: still a request for times (the Rowena case, loggie-intros).
  assert.equal(proposesTime('Could you share a couple of time slots that work for you on Friday?'), false);
  assert.equal(availabilityAsked({ line: 'sure', email: 'Could you share a couple of time slots that work for you on Friday?' }), 'thread');
});

test('strayTimes keeps a time the thread or the user named, and still takes out one nobody did', () => {
  const days = [{ day: '2026-10-27', ranges: [{ start: '2026-10-27T20:00:00.000Z', end: '2026-10-27T20:45:00.000Z' }] }];
  const out = strayTimes('Yes, 3 PM works. Or 6pm.', days, { timeZone: 'America/New_York', keep: [kara.body] });
  assert.match(out.text, /3 PM works/);
  assert.doesNotMatch(out.text, /6pm/);
  assert.deepEqual(out.removed, ['6pm']);
});

// "its how i write so, loggie should know": the greeting is the user's word and the person's first name.

test('the greeting: the user\'s own word and the first name, never the sender\'s "Hello Gio Albert" mirrored back', async () => {
  assert.equal(greetingWord([{ body: 'Hi Liz,\nthanks' }, { body: 'Hi team,' }, { body: 'Hello all' }, { body: 'Thanks!' }]), 'Hi');
  assert.equal(greetingWord([]), 'Hi');
  assert.match(greetingRule([], { word: 'Hi' }), /"Hi <first name>,"[\s\S]*never a last name and never the way the sender addressed the user/);
  assert.doesNotMatch(greetingRule([], { word: 'Hi' }), /Follow how the earlier emails address each other/);
  assert.equal(firstNameGreeting('Hello Kara Wright,\n\nYes.', 'Kara Wright', { word: 'Hi' }), 'Hi Kara,\n\nYes.');
  assert.equal(firstNameGreeting('Hello Ana Ruiz,', 'Ruiz, Ana', { word: 'Hi' }), 'Hi Ana,');
  assert.equal(firstNameGreeting('Hello Kara Wright,', 'Kara Wright'), 'Hello Kara,', 'with emails to copy, the word stays theirs; the last name still goes');
  assert.equal(firstNameGreeting('Dear Professor Lee,', 'Dana Lee', { word: 'Hi' }), 'Dear Professor Lee,');
  // Through the real reply path: no emails to this person, so the user's word and her first name.
  const taskDirectory = await mkdtemp(join(tmpdir(), 'reply-yes-greet-'));
  const prepared = await prepareEmailReply({ taskDirectory, message: kara, email: 'kwright2@careers.bank.example', account: 'me@school.example', line: NOTE, cloud: 'ai', signName: 'Gio', word: 'Hi',
    complete: async (prompt) => { assert.match(prompt, /"Hi <first name>,"/); return JSON.stringify({ body: 'Hello Kara Wright,\n\nYes, I am available on Tuesday, October 27 at 3 PM EST. Looking forward to the interview.\n\nBest,\nGio' }); } });
  assert.match(prepared.body, /^Hi Kara,\n/);
});

test('a draft that did not open says why and opens again as it is: no second draft', async () => {
  const outcomes = ['clipboard', 'reply'];
  const opens = [];
  const home = await mkdtemp(join(tmpdir(), 'reply-yes-again-'));
  const asker = createAsker({
    home, loadIndex: async () => [{ name: 'Kara Wright', kind: 'person', app: 'outlook', email: 'kwright2@careers.bank.example', last: kara.timestamp }],
    openChat: async () => ({ opened: 'none', mode: 'failed' }),
    email: {
      threads: async (address) => threadsFrom([kara], address, ['me@school.example']),
      consent: async () => true, allowAlways: async () => {}, greeting: async () => 'Hi',
      complete: async () => JSON.stringify({ body: 'Hi Kara,\n\nYes, 3 PM works.\n\nBest,\nGio' }),
      openDraft: async (options) => { opens.push(options); const mode = outcomes.shift(); return mode === 'clipboard' ? { opened: 'outlook', mode: 'clipboard', reason: 'The Outlook helper failed. Outlook is showing the Calendar, and background mode never types. Open Mail in Outlook, then try again.' } : { opened: 'outlook', mode: 'reply', detail: '' }; },
      settings: async () => ({ signName: 'Gio', account: 'me@school.example' }),
    },
  });
  const first = await asker.run(`email kwright2@careers.bank.example: ${NOTE}`, { cloud: 'once', choices: { 'kwright2@careers.bank.example': 'outlook:kwright2@careers.bank.example' } }).done;
  const row = replyOutcome(first);
  assert.deepEqual([row.phase, row.kind, row.askId], ['in-mail-app', 'clipboard', first.askId]);
  assert.equal(row.why, 'Outlook is showing the Calendar, and background mode never types. Open Mail in Outlook, then try again.');
  const second = replyOutcome(await asker.again(first.askId));
  assert.deepEqual([second.phase, second.kind], ['in-mail-app', null]);
  assert.equal(opens.length, 2);
  assert.equal(opens[1].taskDirectory, opens[0].taskDirectory, 'the same draft folder, not a new draft');
  assert.equal(opens[1].staleOk, true, 'the thread was weighed when it was written');
  assert.equal((await asker.again('2026-10-21-unknown1')).outcome, 'failed');
});

// "so if i use mispelling and such it would correct?": a draft that spells the note's words right still keeps the note,
// so it is used, not thrown away for the note as typed. A missing point or a different number still fails.
test('a misspelled note keeps its corrected draft; a dropped point or a changed number does not', () => {
  const body = 'Hi Kaitlyn,\n\nYes, I am available Tuesday, Oct 27 at 3pm EST. Looking forward to the interview.\n\nBest,\nGio';
  for (const note of ['yes im availble tuesday oct 27 at 3pm, lookng forward to the intervew', 'yes im availble tusday oct 27 at 3pm, lookng foward to the intervew', 'yes avalable tusday 27 3pm lokin foward intervw']) assert.equal(keepsLine(note, body), true, note);
  assert.equal(keepsLine('can we move it to thursday instead, my manager needs the slot', body), false);
  assert.equal(keepsLine('yes available oct 28 at 3pm', body), false, 'numbers stay exact');
  assert.deepEqual([editDistance('tusday', 'tuesday'), editDistance('foward', 'forward'), editDistance('teh', 'the'), editDistance('lokin', 'looking')], [1, 1, 1, 2]);
});

// 2026-10-22: the helper's read-back ("Check before sending: ...") and the as-typed fallback reach the row; before,
// the row said "ready to send" over a typo'd note with no sign-off (10-21 22:43).
test('a placed reply carries what to check before Send and whether the note went as typed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reply-yes-check-'));
  const asker = createAsker({
    home, loadIndex: async () => [{ name: 'Kara Wright', kind: 'person', app: 'outlook', email: 'kwright2@careers.bank.example', last: kara.timestamp }],
    openChat: async () => ({ opened: 'none', mode: 'failed' }),
    email: {
      threads: async (address) => threadsFrom([kara], address, ['me@school.example']),
      consent: async () => true, allowAlways: async () => {}, greeting: async () => 'Hi',
      complete: async () => JSON.stringify({ body: 'Hi Kara,\n\nThanks for reaching out.\n\nBest,\nGio' }),
      openDraft: async () => ({ opened: 'outlook', mode: 'reply', detail: 'The reply is open in Outlook with the draft in it. Check before sending: The reply ends with no closing line and no signature; add one. Focus stayed in Outlook instead of going back to where you were.' }),
      settings: async () => ({ signName: 'Gio', account: 'me@school.example' }),
    },
  });
  const done = await asker.run('email kwright2@careers.bank.example: yes tuesday 3pm works for the video interview', { cloud: 'once', choices: { 'kwright2@careers.bank.example': 'outlook:kwright2@careers.bank.example' } }).done;
  assert.equal(done.results[0].check, 'The reply ends with no closing line and no signature; add one.', 'the focus sentence is about the user\'s window, not the email');
  assert.equal(done.results[0].drafted, 'words-after-ai-dropped-line');
  const row = replyOutcome(done);
  assert.deepEqual([row.phase, row.check, row.typed], ['in-mail-app', 'The reply ends with no closing line and no signature; add one.', true]);
});
