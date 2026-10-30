// An availability ask end to end (loggie-availability I1, spec test 1.7): the real runner, the real task files and
// draft.js openDraft; only Outlook (the reply helper), the cloud AI and the calendar helper are fakes. Fixture F1's
// events, made-up people. The model answers what Nemotron really wrote on 2026-10-20 ("I am available Friday after
// 2pm"), which was false; the draft must hold the calendar's ranges instead, and the model must see none of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxActRow, createAsker } from '../src/hikyaku/ask-run.js';
import { openDraft } from '../src/hikyaku/draft.js';
import { threadsFrom } from '../src/hikyaku/ask-thread.js';
import { availabilitySettings } from '../src/hikyaku/availability.js';
import { F1_EVENTS } from './helpers/f1-events.js';

const NOW = Date.parse('2026-10-20T16:21:00Z');
const F1_TEXT = 'Fri Oct 23: 9 to 11:15am, 12:30 to 1pm ET';
const entries = [{ name: 'Rowena Patel', kind: 'person', app: 'outlook', email: 'rpatel5@bank.example', last: '2026-10-20T14:29:10.000Z' }];
const rowena = {
  id: 'apple-mail-296413', from: 'Patel, Rowena <rpatel5@bank.example>', to: 'me@school.example', cc: '', subject: 'RE: EA Applicant',
  timestamp: '2026-10-20T14:29:10.000Z', body: 'Hi Gio,\n\nThank you so much for reaching out! I am glad to chat and can you share a couple of time slots that work for you on Friday.\n\nBest,\n\nRowena Patel',
};

async function setup({ complete = async () => JSON.stringify({ body: 'Hi Rowena,\n\nI am available Friday after 2pm.\n\nBest,\nGio' }), events = async () => F1_EVENTS, message = rowena } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'availability-ask-'));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ mailApp: 'outlook', signName: 'Gio' }));
  const seen = { prompts: [], reads: [], helper: [], events: [] };
  const asker = createAsker({
    home, now: () => NOW, loadIndex: async () => entries, openChat: async () => ({}), emit: (kind, data) => seen.events.push([kind, data]),
    email: {
      threads: async (address) => threadsFrom([message], address, ['me@school.example']),
      consent: async () => true, allowAlways: async () => {},
      complete: async (prompt) => { seen.prompts.push(prompt); return complete(prompt); },
      settings: async () => ({ signName: 'Gio', account: 'me@school.example' }),
      openDraft: ({ taskDirectory }) => openDraft({ taskDirectory, home, spawnImpl: () => ({ unref() {} }), replyImpl: async (input) => { seen.helper.push(input); return { status: 'replied', detail: 'Reply opened.', pasted: true, findings: [] }; }, clipboardImpl: async () => {} }),
      events: async (options) => { seen.reads.push(options); return events(options); },
      status: async () => 'granted',
      availability: async () => availabilitySettings({}, { macZone: 'America/New_York' }),
    },
  });
  return { home, asker, seen };
}

test('1.7 the Rowena ask: DRAFT.md holds F1\'s ranges, the model saw none, ASK.json keeps the record, the did lines say what was read', async () => {
  const { home, asker, seen } = await setup();
  const result = await asker.run('email rewena of my availability on friday', { cloud: 'once' }).done;
  assert.equal(result.outcome, 'placed');
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.equal(draft, `Hi Rowena,\n\nI am available Friday.\n\n${F1_TEXT}\n\nBest,\nGio\n`);
  assert.doesNotMatch(draft, /2\s*pm/);
  assert.equal(seen.reads.length, 1);
  assert.equal(seen.prompts.length, 1);
  assert.ok(!seen.prompts[0].includes('11:15') && !seen.prompts[0].includes('12:30'), 'the model\'s prompt holds no free time');
  assert.match(seen.prompts[0], /exactly \[your times\]/);
  assert.equal(seen.helper[0].body.trim(), draft.trim(), 'Outlook gets the filled draft');

  const saved = JSON.parse(await readFile(join(home, 'asks', result.askId, 'ASK.json'), 'utf8'));
  const record = saved.results[0].availability;
  assert.deepEqual(Object.keys(record), ['asked', 'read', 'reason', 'window', 'rules', 'days', 'how', 'stray', 'ms']);
  assert.equal(record.asked, 'typed');
  assert.equal(record.read, 'read');
  assert.equal(record.reason, null);
  assert.deepEqual(record.window.days, ['2026-10-23']);
  assert.deepEqual(record.rules, { selfBlocks: true, minMinutes: 30 });
  assert.deepEqual(record.days, [{ day: '2026-10-23', ranges: [{ start: '2026-10-23T13:00:00.000Z', end: '2026-10-23T15:15:00.000Z' }, { start: '2026-10-23T16:30:00.000Z', end: '2026-10-23T17:00:00.000Z' }] }]);
  assert.equal(record.how, 'inline');
  assert.equal(record.stray, 0);
  assert.equal(typeof record.ms, 'number');
  const text = JSON.stringify(saved);
  for (const word of ['Strategy class', 'Coffee chat', 'Exchange', 'iCloud', 'person@example.com']) assert.ok(!text.includes(word), `ASK.json never holds "${word}"`);

  assert.ok(result.did.includes('Took out "after 2pm": not from your calendar; your real times are in the draft'), result.did.join(' | '));
  assert.ok(result.did.includes('Read your calendar on this Mac for Fri Oct 23 (9am to 5pm ET, 30 min or longer): 2 open times written into the draft'), result.did.join(' | '));
  assert.ok(!result.lines.some((line) => /did not check your calendar|not in the thread or your calendar/.test(line)), 'no guard note when the times are filled');
  const row = boxActRow(result, { draftMs: 5, at: '2026-10-20T16:21:01.000Z' });
  assert.equal(row.times, 'filled');
  const card = seen.events.find(([kind]) => kind === 'draft')[1];
  assert.equal(card.body, draft.trim(), 'the card shows the filled draft');
});

test('1.7 F9: a calendar that cannot be read keeps [your times] and says why', async () => {
  const { home, asker } = await setup({ events: async () => { throw new Error('hikyaku cannot read your calendars. Allow it in System Settings > Privacy & Security > Calendars.'); } });
  const result = await asker.run('email rewena of my availability on friday', { cloud: 'once' }).done;
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.equal(draft, 'Hi Rowena,\n\nI am available Friday [your times].\n\nBest,\nGio\n');
  // loggie-reply-yes: a draft with the gap is held before the mail app; the box asks for the time, then fills it.
  assert.deepEqual([result.outcome, result.status, result.results[0].outcome], ['question', 'needs-time', 'held']);
  assert.equal(result.lines[0], 'Rowena asked about a time and Loggie could not tell which. Which time works?');
  const note = 'Loggie could not read your calendar (no calendar access); [your times] is left for you.';
  assert.ok(result.lines.includes(note), result.lines.join(' | '));
  assert.equal(result.results[0].note, note);
  assert.equal(result.results[0].availability.read, 'unreadable');
  assert.equal(result.results[0].availability.reason, 'no calendar access');
  assert.equal(boxActRow(result).times, 'unreadable');
});

test('1.7 a model that throws: the typed words are filled the same way', async () => {
  const { home, asker } = await setup({ complete: async () => { throw new Error('The cloud AI could not be reached (TimeoutError). Nothing was written.'); } });
  const result = await asker.run('email rewena of my availability on friday', { cloud: 'once' }).done;
  assert.equal(result.results[0].drafted, 'words-after-ai-failed');
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.equal(draft, `Of my availability on friday.\n\n${F1_TEXT}\n\nGio\n`);
  assert.equal(result.results[0].availability.how, 'inserted');
});

test('1.7 an ask that is not about times never reads the calendar (F12)', async () => {
  const message = { ...rowena, body: 'Can you send the deck before the meeting?' };
  const { asker, seen } = await setup({ message, complete: async () => JSON.stringify({ body: 'Hi Rowena,\n\nThanks, I will send it by 5pm.\n\nBest,\nGio' }) });
  const result = await asker.run("reply to rowena: thanks, I'll send it by 5pm", { cloud: 'once' }).done;
  assert.equal(result.outcome, 'placed');
  assert.equal(seen.reads.length, 0);
  assert.equal(result.results[0].availability, undefined);
  assert.equal(boxActRow(result).times, undefined);
  assert.doesNotMatch(seen.prompts[0], /exactly \[your times\]/);
});

test('1.7 F2: the answered email asks for times, so a plain reply gets them too', async () => {
  const { home, asker } = await setup({ complete: async () => JSON.stringify({ body: 'Hi Rowena,\n\nSure, here you go:\n[your times]\n\nBest,\nGio' }) });
  const result = await asker.run('reply to rowena: sure, here you go', { cloud: 'once' }).done;
  assert.equal(result.results[0].availability.asked, 'thread');
  assert.equal(result.results[0].availability.window.from.days, 'thread');
  assert.equal(await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8'), `Hi Rowena,\n\nSure, here you go:\n${F1_TEXT}\n\nBest,\nGio\n`);
  assert.equal(result.results[0].availability.how, 'line');
});

// TC3: a time the user typed is the window's. The model, told to write no time, leaves "after 2pm" out; the line check
// skips the typed clock words, so the cloud draft is used (not the typed words), and code fills only what is free
// inside the typed hours.
const PROMPTED = async () => JSON.stringify({ body: 'Hi Rowena,\n\nHere are the times that work for me:\n[your times]\n\nBest,\nGio' });
const NO_HOLD = F1_EVENTS.filter((e) => e.title !== 'Hold for prep');

test('TC3 "friday after 2pm": the cloud draft is kept and holds only the free ranges from 2pm', async () => {
  const { home, asker } = await setup({ complete: PROMPTED, events: async () => NO_HOLD });
  const result = await asker.run('email rewena my availability friday after 2pm', { cloud: 'once' }).done;
  assert.equal(result.results[0].drafted, 'ai');
  const record = result.results[0].availability;
  assert.deepEqual([record.window.startMinute, record.window.endMinute, record.window.from.hours], [840, 1020, 'typed']);
  assert.deepEqual(record.days, [{ day: '2026-10-23', ranges: [{ start: '2026-10-23T18:00:00.000Z', end: '2026-10-23T19:15:00.000Z' }] }]);
  assert.equal(await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8'), 'Hi Rowena,\n\nHere are the times that work for me:\nFri Oct 23: 2 to 3:15pm ET\n\nBest,\nGio\n');
  assert.ok(result.did.includes('Read your calendar on this Mac for Fri Oct 23 (2 to 5pm ET, 30 min or longer): 1 open time written into the draft'), result.did.join(' | '));
});

test('TC3 "friday after 2pm" fully booked: the note, [your times] kept, no range', async () => {
  const { home, asker } = await setup({ complete: PROMPTED });
  const result = await asker.run('email rewena my availability friday after 2pm', { cloud: 'once' }).done;
  assert.equal(result.results[0].drafted, 'ai');
  assert.equal(await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8'), 'Hi Rowena,\n\nHere are the times that work for me:\n[your times]\n\nBest,\nGio\n');
  assert.equal(result.status, 'needs-time', 'held, never pasted with the gap');
  const note = 'Your calendar has no open 30 minutes on Fri Oct 23 from 2 to 5pm ET; [your times] is left for you.';
  assert.equal(result.results[0].note, note);
  assert.ok(result.lines.includes(note), result.lines.join(' | '));
  assert.equal(boxActRow(result).times, 'none-free');
});

test('TC3 a draft naming a time outside the typed and free ones loses it; the typed "after 2pm" inside a range stays', async () => {
  const complete = async () => JSON.stringify({ body: 'Hi Rowena,\n\nI am free after 2pm, or at 4pm:\n[your times]\n\nBest,\nGio' });
  const { home, asker } = await setup({ complete, events: async () => NO_HOLD });
  const result = await asker.run('email rewena my availability friday after 2pm', { cloud: 'once' }).done;
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.doesNotMatch(draft, /4\s*pm/);
  assert.match(draft, /after 2pm/);
  assert.match(draft, /\nFri Oct 23: 2 to 3:15pm ET\n/);
});

test('TC3 "tuesday before noon" in words mode: the typed words, filled with the morning only', async () => {
  const { home, asker } = await setup();
  const result = await asker.run('email rewena my availability tuesday before noon', { cloud: 'words' }).done;
  const draft = await readFile(join(home, 'asks', result.askId, 'DRAFT.md'), 'utf8');
  assert.match(draft, /Tue Oct 27: 9am to 12pm ET/);
  assert.equal(result.results[0].availability.window.endMinute, 720);
});
