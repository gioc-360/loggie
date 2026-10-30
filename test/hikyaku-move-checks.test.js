// Next moves pass honest checks, and every failure keeps its evidence on the Mac (2026-10-08, after the first real
// sends): the raw reply and the verdict go to REPLY.json in the run folder for every send; a quote is matched on its
// words, not its typography; a move needs a title; a draft names no clock time that is not in the thread or the free
// times offered; em dashes in drafts become commas or periods; an inline "[address kept on this Mac]" is not a kept
// sentence; an invite needs free times, and a calendar that cannot be read says so. Made-up fixtures, fake transport,
// temp homes: no network, no keychain, no model server, no calendar.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { approveSend, runsRoot } from '../src/hikyaku/send-gate.js';
import { createTokenFactory } from '../src/hikyaku/nebius.js';
import * as nextMove from '../src/hikyaku/next-move.js';
import { DRAFTS, GOOD, orchard, orchardRequest, SUPER, tf, TRANSCRIBER } from './helpers/orchard.js';

const { buildRequest, cardMove, checkMove, MOVE_RULES, parseOutbound, readMove, readSlots, runNextMove } = nextMove;

const TODAY = new Date('2026-10-06T12:00:00Z');

// Thread A, screened: an inline address placeholder inside a sentence, so no sentence kept (thread B, in the helper,
// holds one).
const OUT_A = '# Re: Orchard tour\n\n_Screened on this Mac by local-test: 0 of 4 sentences kept back (code 0, model 0, unchecked 0); see HELD.json._\n\n## Pell Varro · 2026-10-01T10:00:00Z\n\nThe orchard tour is set for the morning, gates open at 9:30 AM.\n\n## Quill Ashe · 2026-10-03T14:00:00Z\n\nCould you send the “cider list” to [address kept on this Mac] before the tour? Let me know which day works for a planning call.\n';

async function setup() {
  const h = await orchard('hikyaku-move-checks-', OUT_A);
  const send = await h.prepare();
  return { ...h, send, runDirectory: join(runsRoot(h.dir), send.run) };
}

async function press(h, body, { post = null, eventsImpl = async () => [] } = {}) {
  const client = post ? { post } : createTokenFactory({ keyImpl: async () => 'fake-key', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) });
  return approveSend({ home: h.dir, run: h.send.run, provider: 'nebius', checks: { nebius: async () => true }, transcriber: TRANSCRIBER,
    nextMove: (input) => runNextMove({ ...input, client, core: h.core, me: 'Pell Varro', eventsImpl, now: () => TODAY }) });
}
const readReply = async (h) => JSON.parse(await readFile(join(h.runDirectory, 'REPLY.json'), 'utf8'));

// A request built directly, for checkMove alone.
const SLOTS = [{ id: 1, start: '2026-10-07T14:00:00.000Z', minutes: 30, label: 'Wed, Oct 7, 10:00 AM EDT' }, { id: 2, start: '2026-10-08T18:00:00.000Z', minutes: 30, label: 'Thu, Oct 8, 2:00 PM EDT' }];
const request = (slots = SLOTS) => orchardRequest(OUT_A, { slots });
const check = (move, slots) => checkMove({ content: JSON.stringify(move), finish_reason: 'stop', model: SUPER }, request(slots), { me: 'Pell Varro' });

test('the raw reply and the verdict are kept in REPLY.json on the Mac, for a failed send and a passed one', async () => {
  const failed = await setup();
  const bad = { ...GOOD, quote: 'Please send the plum list by Monday.' };
  const result = await press(failed, tf(JSON.stringify(bad)));
  assert.equal(result.ok, false);
  const kept = await readReply(failed);
  assert.equal(kept.reply.content, JSON.stringify(bad), 'the raw content, as it came back');
  assert.equal(kept.reply.model, SUPER); assert.equal(kept.reply.finish_reason, 'stop');
  assert.equal(kept.verdict.ok, false); assert.match(kept.verdict.reason, /quote is not in/);
  assert.equal(kept.run, failed.send.run); assert.match(kept.request_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(kept).includes('fake-key'), 'the key is never kept');

  const passed = await setup();
  assert.equal((await press(passed, tf(JSON.stringify(GOOD)))).ok, true);
  const ok = await readReply(passed);
  assert.equal(ok.verdict.ok, true); assert.match(ok.verdict.move_id, /^task_1#1$/);

  // No answer at all: the error is kept, with no reply.
  const down = await setup();
  await press(down, null, { post: async () => { throw new Error('The cloud AI could not be reached (TypeError). Nothing was written.'); } });
  const none = await readReply(down);
  assert.equal(none.reply, null); assert.equal(none.verdict.ok, false); assert.match(none.verdict.reason, /could not be reached/);
});

test('a quote matches on its words: case, spaces, curly or straight quotes, dashes and end punctuation do not matter; changed words do', async () => {
  for (const quote of ['let me know which day works for a planning call', 'Let me know  which day\nworks for a planning call!', 'Could you send the "cider list"', "could you send the ‘cider list’"]) {
    const result = check({ ...GOOD, quote });
    assert.equal(result.ok, true, `${quote}: ${result.reason}`);
  }
  assert.equal(check({ ...GOOD, why: ['f1', 'The orchard tour is set for the morning, gates open at 9:30 AM'] }).ok, true, 'a why quote without its final period');
  assert.equal(check({ ...GOOD, why: ['The orchard tour is set for the morning — gates open at 9:30 AM.'] }).ok, true, 'a dash where the thread has a comma');
  for (const quote of ['Let me know which day works for a planning meeting.', 'Let me know what day works for a planning call.', 'know which day ... planning call', 'which day works for a plan']) {
    const result = check({ ...GOOD, quote });
    assert.equal(result.ok, false, `${quote} changed the words`); assert.match(result.reason, /quote is not in/);
  }
  assert.match(check({ ...GOOD, why: ['Pell said the tour moved to Friday.'] }).reason, /not in what was sent/);
  // A fact's own text, or "f1: <its text>", is that fact, not a quote.
  const asText = check({ ...GOOD, why: ['f1: Quill Ashe wrote last in "Re: Orchard tour", so it is your move.'] });
  assert.equal(asText.ok, true, asText.reason); assert.equal(asText.move.why[0].id, 'f1');
});

test('an empty quote falls back to the first checked quote in why[]; a code fact alone also grounds it; with neither, it is refused (real sends, 2026-10-08)', async () => {
  const fromWhy = check({ ...GOOD, quote: '', why: ['f1', 'Let me know which day works for a planning call.'] });
  assert.equal(fromWhy.ok, true, fromWhy.reason);
  assert.equal(fromWhy.move.quote, 'Let me know which day works for a planning call.');
  const factOnly = check({ ...GOOD, quote: '', why: ['f1'] });
  assert.equal(factOnly.ok, true, `a code fact grounds the move: ${factOnly.reason}`); assert.ok(!factOnly.move.quote);
  const nothing = check({ ...GOOD, quote: '', why: [] });
  assert.equal(nothing.ok, false); assert.match(nothing.reason, /no quote from the thread|reason/);
  assert.match(check({ ...GOOD, quote: '', why: ['Pell said the tour moved to Friday.'] }).reason, /not in what was sent/, 'a made-up reason still fails first');
});

test('a move needs a title', async () => {
  for (const title of [null, undefined, '', '   ', 42]) {
    const result = check({ ...GOOD, title });
    assert.equal(result.ok, false, `title ${JSON.stringify(title)}`); assert.match(result.reason, /title/);
  }
  const titled = check(GOOD);
  assert.equal(titled.ok, true, titled.reason); assert.equal(titled.move.title, GOOD.title);
  assert.equal(cardMove({ move_id: 'm#1', ...titled.move }).title, GOOD.title, 'the card gets the title');
});

test('a draft that names a clock time not in the thread or the free times offered is refused', async () => {
  const invented = check({ ...GOOD, kind: 'invite', slots: [1], drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill,\n\nDoes Friday 2:30 to 3:00 PM ET work for the call?\n\nPell'] });
  assert.equal(invented.ok, false); assert.match(invented.reason, /time \(3:00 PM\)/); assert.match(invented.reason, /not in that thread or the free times offered/);
  assert.equal(check({ ...GOOD, drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill, how about 4pm tomorrow? Pell'] }).ok, false, 'a reply that proposes a time of its own');
  // An offered time (and its end), and a time the thread itself names, are fine.
  const offered = check({ ...GOOD, kind: 'invite', slots: [1, 2], drafts: ['Hi Quill, would Wed, Oct 7 at 10:00 AM work? Pell', 'Hi Quill, Thursday 2:00 to 2:30 PM is open. Pell', 'Hi Quill, either 10 am Wednesday or 2 pm Thursday. Pell'] });
  assert.equal(offered.ok, true, offered.reason);
  assert.equal(check({ ...GOOD, drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill, see you when the gates open at 9:30. Pell'] }).ok, true, 'the thread says 9:30 AM');
});

test('em dashes in drafts become a comma or a period, and the verdict counts them', async () => {
  const dashed = check({ ...GOOD, drafts: ['Hi Quill — the cider list is on its way.\n\nPell', 'Hi Quill,\n\nThe list is ready—sending it now. Which day works for you —\n\nPell', DRAFTS[2]] });
  assert.equal(dashed.ok, true, dashed.reason);
  assert.equal(dashed.move.drafts[0], 'Hi Quill, the cider list is on its way.\n\nPell');
  assert.equal(dashed.move.drafts[1], 'Hi Quill,\n\nThe list is ready, sending it now. Which day works for you.\n\nPell');
  assert.ok(dashed.move.drafts.every((draft) => !/[—―]/.test(draft)));
  assert.equal(dashed.edits.em_dashes, 3);
});

test('an inline "[address kept on this Mac]" is not a kept sentence: no false hit when nothing was kept, a real one still fails', async () => {
  const inline = check({ ...GOOD, quote: 'Could you send the “cider list” to [address kept on this Mac] before the tour?' });
  assert.equal(inline.ok, true, inline.reason);
  const held = check({ ...GOOD, thread_id: 'thread-b', quote: 'The barn paint is drying. [health kept on this Mac] We can talk' });
  assert.equal(held.ok, false); assert.match(held.reason, /runs over a line kept on this Mac/);
  assert.equal(check({ ...GOOD, quote: '[address kept on this Mac]' }).ok, false, 'a placeholder alone is not a quote');
});

test('an invite needs free times: without them it is not allowed, and a calendar that cannot be read says so', async () => {
  const none = check({ ...GOOD, kind: 'invite', slots: [1] }, []);
  assert.equal(none.ok, false); assert.match(none.reason, /no free times were offered/);
  assert.match(request([]).messages[1].content, /Free times offered: none, so the move cannot be an invite/);
  const unreadable = await readSlots({ eventsImpl: async () => { throw new Error('hikyaku cannot read your calendars yet.'); }, from: TODAY });
  assert.deepEqual(unreadable.slots, []); assert.equal(unreadable.calendar, 'unreadable'); assert.match(unreadable.reason, /cannot read your calendars/);
  assert.equal((await readSlots({ eventsImpl: null, from: TODAY })).calendar, 'none');
  const read = await readSlots({ eventsImpl: async () => [], from: TODAY });
  assert.equal(read.calendar, 'read'); assert.ok(read.slots.length > 0);
  // Through the send: the result and REPLY.json say the calendar was not read.
  const h = await setup();
  const result = await press(h, tf(JSON.stringify({ ...GOOD, kind: 'invite', slots: [1] })), { eventsImpl: async () => { throw new Error('hikyaku cannot read your calendars yet.'); } });
  assert.equal(result.ok, false); assert.match(result.reason, /no free times were offered/);
  const kept = await readReply(h);
  assert.equal(kept.calendar.status, 'unreadable'); assert.equal(kept.calendar.slots_offered, 0);
  assert.equal(await stat(join(h.workstreamDirectory, 'task_1', 'MOVE.json')).catch(() => null), null);
});

test('the rules tell the model how to copy, when an invite is allowed, and what a draft may not say', () => {
  assert.match(MOVE_RULES, /character for character/);
  assert.match(MOVE_RULES, /"title"/);
  assert.match(MOVE_RULES, /invite: only when free times are offered/);
  assert.match(MOVE_RULES, /never states a time, a date or a place/);
  assert.match(MOVE_RULES, /em dash/);
  assert.ok(!/—/.test(MOVE_RULES.replace('(—)', '')), 'the rules themselves use no em dash');
});

test('the passed move keeps its title on MOVE.json', async () => {
  const h = await setup();
  assert.equal((await press(h, tf(JSON.stringify(GOOD)))).ok, true);
  assert.equal((await readMove(join(h.workstreamDirectory, 'task_1'))).title, GOOD.title);
});

// --- the user and the day (increment 9: spec section 2 B17, FA audit 9.1). Made-up names; today is 2026-10-08.
const TODAY9 = new Date('2026-10-08T12:00:00Z');
const OUT_C = '# Readouts\n\n_Screened on this Mac by local-test: 0 of 3 sentences kept back (code 0, model 0, unchecked 0); see HELD.json._\n\n## Tomas Reed · 2026-10-05T10:00:00Z\n\nCould you send the notes from the readouts? Oct 9 works for me, anytime 12:30pm-3:30pm. The first round was on Oct 7.\n';
const request9 = (slots = []) => buildRequest({ stream: { stream_id: 'readouts', name: 'Readouts', goal: null, people: ['Tomas Reed'] },
  threads: [{ thread_id: 'thread-c', ...parseOutbound(OUT_C) }],
  facts: [{ id: 'f1', kind: 'whose_move', thread_id: 'thread-c', value: 'yours', text: 'Tomas Reed wrote last in "Readouts", so it is your move.' }], slots, me: 'Pell', today: TODAY9 });
const BASE9 = { thread_id: 'thread-c', title: 'Get the notes ready', kind: 'prep', why: ['f1'], drafts: [], slots: [], steps: ['Collect the notes'], quote: 'Could you send the notes from the readouts?' };
const check9 = (move, slots) => checkMove({ content: JSON.stringify({ ...BASE9, ...move }), finish_reason: 'stop', model: SUPER }, request9(slots), { me: 'Pell Varro', today: TODAY9 });

test('the request says who the user is and what day it is', () => {
  const lines = request9().messages[1].content.split('\n');
  assert.equal(lines[2], 'The user is Pell.');
  assert.equal(lines[3], 'Today is 2026-10-08, Thursday.');
  assert.match(lines[4], /^Workstream: Readouts$/);
  assert.match(buildRequest({ stream: { name: 'S', goal: null, people: [] }, threads: [], facts: [], slots: [], today: TODAY9 }).messages[1].content, /\nThe user is you\.\nToday is 2026-10-08, Thursday\.\n/);
});

test('the rules say the move is the user\'s own and never prepares for a day already past', () => {
  assert.match(MOVE_RULES, /The move is the user's own next action\. Never a move for someone else/);
  assert.match(MOVE_RULES, /a title or step never names the user/);
  assert.match(MOVE_RULES, /A title or step never prepares for a day before today; when the thread's date has passed, the move is a follow-up, wait, or read\./);
  assert.ok(!/—/.test(MOVE_RULES.replace('(—)', '')));
});

test('dateTexts finds dates in the forms a person writes, and leaves a weekday alone', () => {
  const found = (text) => nextMove.dateTexts(text, { today: TODAY9 }).map((item) => `${item.text}=${item.date}`);
  assert.deepEqual(found('Oct 7 and Oct. 8'), ['Oct 7=2026-10-07', 'Oct. 8=2026-10-08']);
  assert.deepEqual(found('on October 7, 2025'), ['October 7, 2025=2025-10-07']);
  assert.deepEqual(found('Wednesday, Oct 7'), ['Wednesday, Oct 7=2026-10-07']);
  assert.deepEqual(found('by 10/7 or 2026-10-09'), ['10/7=2026-10-07', '2026-10-09=2026-10-09']);
  assert.deepEqual(found('See you Friday, have a good Tuesday, 3 of 40 people'), []);
});

test('a prep whose step names a day before today is refused', () => {
  const stale = check9({ title: 'Send Tomas the call link for the Oct 7 readouts', steps: ['Make a call link for Wednesday, Oct 7, 2026, at 5:30 PM EDT'] });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /^The move is about Oct 7, which is already past\. Nothing was written\.$/);
  const step = check9({ steps: ['Make a call link for Wednesday, Oct 7, 2026, at 5:30 PM EDT'] });
  assert.match(step.reason, /^The move is about Wednesday, Oct 7, 2026, which is already past\./);
  assert.equal(check9({ steps: ['Be ready by Oct 7'] }).ok, false);
  assert.equal(check9({ steps: ['Confirm the 10/7 slot at 3 PM'] }).ok, false, 'a past date paired with a clock time');
});

test('a follow-up about a past day passes: from, after, since, about and of are not forward-looking', () => {
  for (const title of ['Send Tomas the notes from the Oct 7 readouts', 'Write up what we decided after Oct 7', 'Ask Tomas about Oct 7']) {
    const result = check9({ title });
    assert.equal(result.ok, true, `${title}: ${result.reason}`);
  }
});

test('a prep that names days from today on passes', () => {
  const result = check9({ title: 'Confirm registration for the case competition', steps: ['Register by Oct 23', 'Pick the team by Oct 26', 'Plan for Oct 8'] });
  assert.equal(result.ok, true, result.reason);
});

test('a title that names the user is refused', () => {
  for (const move of [{ title: 'Update Pell on the test results', steps: ['Run the setup commands'] }, { steps: ['Tell Pell, then wait'] }]) {
    const result = check9(move);
    assert.equal(result.ok, false);
    assert.match(result.reason, /^The move names you \(Pell\), so it reads as someone else's move\. Nothing was written\.$/);
  }
  assert.equal(check9({ title: 'Update Pellegrino on the test results' }).ok, true, 'a longer word is not the name');
});

test('a reply may name a date and time that the thread names', () => {
  const drafts = ['Hi Tomas,\n\nOct 9 works, say 12:30pm. Notes come then.\n\nPell', 'Hi Tomas,\n\nI can do Oct 9 between 12:30pm-3:30pm.\n\nPell', 'Hi Tomas,\n\nLet us meet Oct 9, 3:30pm.\n\nPell'];
  const result = check9({ kind: 'reply', title: 'Tell Tomas Oct 9 works', drafts, steps: [] });
  assert.equal(result.ok, true, result.reason);
});

test('an invite draft names only the weekday and date of a picked slot, or one the thread names', () => {
  const slots = [{ id: 1, start: '2026-10-14T16:00:00.000Z', minutes: 30, label: 'Wed, Oct 14, 12:00 PM EDT' }];
  const invite = (drafts) => check9({ kind: 'invite', title: 'Offer Tomas a time', slots: [1], drafts, steps: [] }, slots);
  const wrong = invite(['Hi Tomas,\n\nFriday 2:00-2:30 PM ET?\n\nPell', 'Hi Tomas,\n\nWed, Oct 14, 12:00 PM EDT works.\n\nPell', 'Hi Tomas,\n\nWed, Oct 14, 12:00 PM EDT.\n\nPell']);
  assert.equal(wrong.ok, false); assert.match(wrong.reason, /^A draft names /);
  const day = invite(['Hi Tomas,\n\nFriday works.\n\nPell', 'Hi Tomas,\n\nWed, Oct 14, 12:00 PM EDT.\n\nPell', 'Hi Tomas,\n\nWed, Oct 14, 12:00 PM EDT.\n\nPell']);
  assert.equal(day.ok, false); assert.match(day.reason, /Friday, which is not one of the free times offered\. Nothing was written\.$/);
  const date = invite(['Hi Tomas,\n\nOct 20 at 12:00 PM?\n\nPell', 'Hi Tomas,\n\nWednesday at 12:00 PM.\n\nPell', 'Hi Tomas,\n\nWed 12:00 PM.\n\nPell']);
  assert.equal(date.ok, false); assert.match(date.reason, /Oct 20/);
  const good = invite(['Hi Tomas,\n\nWed, Oct 14, 12:00 PM EDT works for me.\n\nPell', 'Hi Tomas,\n\nWednesday at 12:00 PM?\n\nPell', 'Hi Tomas,\n\nOr Oct 9 at 12:30pm, as you said.\n\nPell']);
  assert.equal(good.ok, true, good.reason);
});

// --- increment 9b: relative days, a meeting already booked, a reason that wraps a quote. Made-up names.
test('a title or step with a relative day is refused; a weekday alone and drafts are fine', () => {
  const title = check9({ title: 'Send the call link to Tomas for tomorrow\'s session' });
  assert.equal(title.ok, false);
  assert.equal(title.reason, 'The move says "tomorrow" instead of a date. Nothing was written.');
  const step = check9({ steps: ['Send the notes early next week'] });
  assert.equal(step.ok, false); assert.match(step.reason, /^The move says "next week" instead of a date\./);
  for (const word of ['today', 'tonight', 'yesterday', 'this Friday', 'next Monday', 'this week', 'last week']) {
    assert.equal(check9({ steps: [`Do it ${word}`] }).ok, false, word);
  }
  assert.equal(check9({ title: 'Send Tomas the notes by Friday' }).ok, true, 'a weekday alone stays allowed');
  const reply = check9({ kind: 'reply', title: 'Tell Tomas Oct 9 works', steps: [], drafts: ['Hi Tomas,\n\nI can send them tomorrow.\n\nPell', 'Hi Tomas,\n\nTomorrow works. Oct 9 it is.\n\nPell', 'Hi Tomas,\n\nSee you tomorrow.\n\nPell'] });
  assert.equal(reply.ok, true, reply.reason);
  assert.match(MOVE_RULES, /In a title or step, write the date \(Oct 9\), never a relative day like tomorrow\./);
});

const EVENTS9 = [
  { title: 'Secret private title', start: '2026-10-09T17:00:00Z', end: '2026-10-09T17:25:00Z', attendees: ['ada@example.org'], attendeeNames: ['Quill, Ada'] },
  { title: 'Other', start: '2026-10-10T17:00:00Z', end: '2026-10-10T17:30:00Z', attendees: ['zed@example.org'], attendeeNames: ['Zed Moss'] },
  { title: 'Too far', start: '2026-12-10T17:00:00Z', end: '2026-12-10T17:30:00Z', attendees: ['ada@example.org'], attendeeNames: ['Ada Quill'] },
];
test('a meeting already on the calendar with a person in the stream becomes a fact, with no title and no email', () => {
  const threads = [{ thread_id: 'thread-q', subject: 'Chat', turns: [{ who: 'Ada Quill', at: '2026-10-07T10:00:00Z', text: 'Does Friday work?' }] }];
  const booked = nextMove.bookedMeetings({ events: EVENTS9, people: ['Ada Quill'], today: TODAY9 });
  assert.deepEqual(booked, ['A meeting with Ada Quill is already on your calendar: Friday, Oct 9, 1:00 PM.']);
  const facts = nextMove.streamFacts({ threads, me: 'Pell', today: TODAY9, booked });
  assert.equal(facts.at(-1).id, `f${facts.length}`); assert.equal(facts.at(-1).text, booked[0]);
  assert.deepEqual(nextMove.bookedMeetings({ events: EVENTS9, people: ['Tomas Reed'], today: TODAY9 }), []);
  const built = buildRequest({ stream: { name: 'S', goal: null, people: ['Ada Quill'] }, threads, facts, slots: [], today: TODAY9 }).body;
  assert.ok(!built.includes('Secret private title') && !built.includes('ada@example.org'));
  assert.match(MOVE_RULES, /When a fact says a meeting is already on the calendar, do not offer new times; the move is prep or wait\./);
});

// The real M&T invite (2026-10-08) named the person only by address (a first initial, last name and digit), no display name, and one event can sit on two
// calendars. An address whose letters are first+last, initial+last or last+first matches; the same start is said once.
test('a booked meeting matches an attendee known only by address, and the same meeting is said once', () => {
  const events = [
    { title: 'x', start: '2026-10-09T17:00:00Z', attendees: ['aquill1@example.org'], attendeeNames: [] },
    { title: 'x', start: '2026-10-09T17:00:00Z', attendees: ['aquill1@example.org'], attendeeNames: [] },
    { title: 'y', start: '2026-10-10T17:00:00Z', attendees: ['quill.ada@example.org'], attendeeNames: [] },
    { title: 'z', start: '2026-10-11T17:00:00Z', attendees: ['aq@example.org'], attendeeNames: [] },
  ];
  assert.deepEqual(nextMove.bookedMeetings({ events, people: ['Quill, Ada'], today: TODAY9 }), [
    'A meeting with Quill, Ada is already on your calendar: Friday, Oct 9, 1:00 PM.',
    'A meeting with Quill, Ada is already on your calendar: Saturday, Oct 10, 1:00 PM.',
  ]);
});

test('a reason that wraps a quote is checked on the quoted part only', () => {
  const wrapped = (why) => check({ ...GOOD, why: [why] });
  const ok = wrapped('Quill Ashe asked: "Let me know which day works for a planning call."');
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(wrapped('Quill Ashe asked: “Let me know which day works for a planning call.”').ok, true, 'curly quotes');
  const bad = wrapped('Quill Ashe asked: "Let me know which day suits the planning call."');
  assert.equal(bad.ok, false); assert.match(bad.reason, /not in what was sent/);
  assert.equal(wrapped('Quill Ashe asked for a day').ok, false, 'no quoted part: checked whole');
  const noQuote = check({ ...GOOD, quote: '', why: ['Quill Ashe asked: "Let me know which day works for a planning call."'] });
  assert.equal(noQuote.ok, true, `an empty quote falls back to the quoted part, not the lead-in: ${noQuote.reason}`);
  const over = check({ ...GOOD, thread_id: 'thread-b', why: ['Rook said: "The barn paint is drying. [health kept on this Mac] We can talk"'] });
  assert.equal(over.ok, false); assert.match(over.reason, /repeats a line kept on this Mac/);
});

// --- 9c: a content refusal is asked once more with its reason; a transport refusal is not.
const PAST = { ...GOOD, title: 'Send the cider list to Quill for Oct 3 tour', why: ['f1'] };
const sequence = (...bodies) => { const sent = []; return { sent, post: async (text) => { sent.push(JSON.parse(text)); const body = bodies[sent.length - 1]; return createTokenFactory({ keyImpl: async () => 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) }).post(text); } }; };

test('a refused first answer is asked once more with the reason and the first answer, and no new data', async () => {
  const h = await setup();
  const fake = sequence(tf(JSON.stringify(PAST)), tf(JSON.stringify(GOOD)));
  const result = await press(h, null, { post: fake.post });
  assert.equal(result.ok, true);
  assert.equal(fake.sent.length, 2);
  const [first, second] = fake.sent.map((body) => body.messages);
  assert.deepEqual(second.slice(0, 2), first);
  assert.equal(second.length, 4);
  assert.equal(second[2].role, 'assistant'); assert.equal(second[2].content, JSON.stringify(PAST));
  assert.equal(second[3].role, 'user');
  assert.match(second[3].content, /That move was refused: The move is about Oct 3, which is already past\. Pick a different move that follows the rules\. Answer with the JSON only\./);
  assert.ok(!second[3].content.includes('Nothing was written'));
  const kept = await readReply(h);
  assert.equal(kept.attempts.length, 2);
  assert.equal(kept.attempts[0].verdict.ok, false); assert.equal(kept.attempts[1].verdict.ok, true);
  assert.equal(kept.reply.content, JSON.stringify(GOOD)); assert.equal(kept.verdict.ok, true);
  const events = (await readFile(join(h.runDirectory, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const sent = events.filter((e) => e.type === 'outbound.sent'), returned = events.filter((e) => e.type === 'outbound.returned');
  assert.deepEqual(sent.map((e) => e.data.attempt), [1, 2]); assert.deepEqual(returned.map((e) => e.data.attempt), [1, 2]);
});

test('two refusals fail with the second reason after exactly two requests', async () => {
  const h = await setup();
  const fake = sequence(tf(JSON.stringify(PAST)), tf(JSON.stringify({ ...GOOD, quote: 'Please send the plum list by Monday.' })), tf(JSON.stringify(GOOD)));
  const result = await press(h, null, { post: fake.post });
  assert.equal(result.ok, false); assert.match(result.reason, /quote is not in/);
  assert.equal(fake.sent.length, 2);
  const kept = await readReply(h);
  assert.equal(kept.attempts.length, 2); assert.match(kept.verdict.reason, /quote is not in/); assert.match(kept.attempts[0].verdict.reason, /already past/);
});

test('a cut-off first answer is not asked again', async () => {
  const h = await setup();
  const fake = sequence(tf('{"kind":', { finish: 'length' }), tf(JSON.stringify(GOOD)));
  const result = await press(h, null, { post: fake.post });
  assert.equal(result.ok, false); assert.match(result.reason, /cut off/);
  assert.equal(fake.sent.length, 1);
  assert.equal((await readReply(h)).attempts.length, 1);
  assert.equal(check({ ...GOOD, kind: 'nope' }).retry, true);
  assert.equal(checkMove({ content: '', finish_reason: 'stop', model: SUPER }, request()).retry, false);
  assert.equal(checkMove({ content: '{}', finish_reason: 'stop', model: 'other/model' }, request()).retry, false);
});

test('a first answer that repeats a kept line is not echoed back: no retry', async () => {
  const h = await setup();
  const fake = sequence(tf(JSON.stringify({ ...GOOD, drafts: [DRAFTS[0], DRAFTS[1], 'Hi Quill,\n\n[health kept on this Mac] Pell'] })), tf(JSON.stringify(GOOD)));
  const result = await press(h, null, { post: fake.post });
  assert.equal(result.ok, false); assert.match(result.reason, /kept on this Mac|repeats a line/);
  assert.equal(fake.sent.length, 1);
  assert.equal((await readReply(h)).attempts.length, 1);
});

// Real runs 2026-10-08: a read move "Follow up on Oct 7 readout action items" was refused as past, and an invite was
// offered while a code fact said the meeting was already booked.
test('a read or wait move may name a past day, and an invite is refused when the meeting is already booked', () => {
  const read = check9({ kind: 'read', title: 'Follow up on Oct 7 readout action items', steps: [] });
  assert.equal(read.ok, true, read.reason);
  assert.equal(check9({ kind: 'prep', title: 'Follow up on Oct 7 readout action items' }).ok, false, 'a prep still is');
  const slots = [{ id: 1, start: '2026-10-14T16:00:00Z', minutes: 30, label: 'Wed, Oct 14, 12:00 PM EDT' }];
  const booked = buildRequest({ stream: { stream_id: 'readouts', name: 'Readouts', goal: null, people: ['Tomas Reed'] },
    threads: [{ thread_id: 'thread-c', ...parseOutbound(OUT_C) }],
    facts: [{ id: 'f1', kind: 'whose_move', thread_id: 'thread-c', value: 'yours', text: 'Tomas Reed wrote last in "Readouts", so it is your move.' },
      { id: 'f2', kind: 'booked', text: 'A meeting with Tomas Reed is already on your calendar: Friday, Oct 9, 1:00 PM.' }], slots, me: 'Pell', today: TODAY9 });
  const invite = checkMove({ content: JSON.stringify({ ...BASE9, kind: 'invite', steps: [], slots: [1], drafts: ['Does Wed, Oct 14 at 12:00 PM work?', 'Could we meet Wed, Oct 14 at 12:00 PM?', 'Is Wed, Oct 14 at 12:00 PM good?'] }), finish_reason: 'stop', model: SUPER }, booked, { me: 'Pell Varro', today: TODAY9 });
  assert.equal(invite.ok, false);
  assert.match(invite.reason, /already on your calendar, so the move is prep or wait, not an invite/);
});
