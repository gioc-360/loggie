// Increment 16 (spec-c.md): the offer card, the end ask, the one-decision card and the Notification all come from one
// event through desktop/renderer/meeting-cards.js. No DOM and no Electron: the Notification constructor is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFor, applyEvent, decisionCards, NAMES_LINE, notifyEvent, runAction, surfaceFor } from '../desktop/renderer/meeting-cards.js';

const OFFER_ID = '20261008-093000-ab12';
const offered = {
  type: 'meeting.offered', text: 'A meeting is starting. Transcribe it?',
  data: { offer_id: OFFER_ID, source: 'calendar', key: 'k1', title: 'Weekly sync', start: '2026-10-08T15:30:00.000Z', end: '2026-10-08T16:00:00.000Z', people: 3, names: ['Ana', 'Ben'], emails: [], place: 'Room 4', link_kind: null, reason: 'people', expires: '2026-10-08T16:00:00.000Z' },
};
const answered = { type: 'meeting.answered', data: { offer_id: OFFER_ID, answer: 'dismiss', call: null } };
const endAsked = { type: 'meeting.end_asked', text: 'Done? Write it up.', data: { call: '2026-10-08_weekly-sync', reason: 'mic_released', since: '2026-10-08T16:00:00.000Z', asked_before: 0 } };
const endAnswered = { type: 'meeting.end_answered', data: { call: '2026-10-08_weekly-sync', answer: 'keep' } };
const RUN = '20261008-101500-cd34';
const send = { run: RUN, what: 'call-notes', status: 'pending', title: 'Weekly sync' };

const fakeApi = () => {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => async (...args) => { calls.push([name, ...args]); return { ok: true, data: {} }; } });
  return { api, calls };
};

test('the offer card comes from one meeting.offered event: title, time, people, place', () => {
  const card = surfaceFor(offered);
  assert.equal(card.kind, 'offer');
  assert.equal(card.heading, 'Transcribe this meeting?');
  assert.equal(card.title, 'Weekly sync');
  assert.match(card.when, /\d{1,2}:\d{2}\s?[AP]M/);
  assert.equal(card.people, 'with 3 people');
  assert.equal(card.place, 'Room 4');
  assert.deepEqual(card.buttons.map((b) => b.label), ['Transcribe', 'Not this one']);
});

test('the app label stands in for a missing place, and one person reads "with 1 person"', () => {
  const card = surfaceFor({ ...offered, data: { ...offered.data, place: null, link_kind: 'zoom', people: 1 } });
  assert.equal(card.place, 'Zoom');
  assert.equal(card.people, 'with 1 person');
});

test('the end ask card comes from one meeting.end_asked event', () => {
  const card = surfaceFor(endAsked);
  assert.equal(card.kind, 'end');
  assert.equal(card.heading, 'Done? Write it up.');
  assert.deepEqual(card.buttons.map((b) => b.label), ['Write it up', 'Keep going']);
});

const heard = (heard_s, behind_s, call = endAsked.data.call) => ({ type: 'meeting.heard', text: 'Loggie is listening', data: { call, heard_s, read_s: heard_s - behind_s, behind_s, pieces: 100 } });

test('the end ask card shows how much was heard, from the latest meeting.heard of the same call', () => {
  assert.equal(surfaceFor(endAsked).note, undefined, 'no heard event, no line');
  assert.equal(surfaceFor(endAsked, { [endAsked.data.call]: heard(3120, 12).data }).note, 'Heard so far: 52 min. Ready in seconds.');
  assert.equal(surfaceFor(endAsked, { [endAsked.data.call]: heard(3120, 30).data }).note, 'Heard so far: 52 min. Ready in seconds.', '30 s behind is not yet catching up');
  assert.equal(surfaceFor(endAsked, { [endAsked.data.call]: heard(3120, 47.4).data }).note, 'Catching up: about 47 s behind.');
  assert.equal(surfaceFor(endAsked, { 'another-call': heard(3120, 2, 'another-call').data }).note, undefined);
});

test('a meeting.heard updates the end card already on screen, and one before the card is remembered by the panel', () => {
  let cards = applyEvent([], endAsked);
  cards = applyEvent(cards, heard(600, 4));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].note, 'Heard so far: 10 min. Ready in seconds.');
  cards = applyEvent(cards, heard(660, 45));
  assert.equal(cards[0].note, 'Catching up: about 45 s behind.');
  assert.deepEqual(applyEvent([], heard(600, 4)), [], 'no end card, no card');
  assert.equal(applyEvent([], endAsked, { [endAsked.data.call]: heard(2700, 0).data })[0].note, 'Heard so far: 45 min. Ready in seconds.');
  assert.equal(notifyEvent(heard(600, 4), { Notification: class {}, isCollapsed: () => true, expand() {} }), false, 'a heard line never makes a Notification');
});

test('the one-decision card is one question with two buttons, for a pending call-notes send only', () => {
  const cards = decisionCards([send, { ...send, run: '20261008-101600-cd35', what: 'next-move' }, { ...send, run: '20261008-101700-cd36', status: 'declined' }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].heading, 'Summarize with cloud AI?');
  assert.deepEqual(cards[0].buttons.map((b) => b.label), ['Yes', 'No, keep it here']);
  assert.equal(cards[0].review, null, 'the panel has no review of the outbound text yet, so no link');
});

test('two or more calls are one card naming each; Yes answers only the calls left on, Keep all here answers all', () => {
  const runs = ['20261008-101500-cd34', '20261008-101600-cd35', '20261008-101700-cd36'];
  const sends = runs.map((run, i) => ({ ...send, run, title: `Call ${i + 1}` }));
  const [card] = decisionCards(sends);
  assert.equal(decisionCards(sends).length, 1);
  assert.equal(card.heading, 'Summarize with cloud AI?');
  assert.equal(card.title, '3 calls are ready');
  assert.deepEqual(card.calls.map((c) => [c.title, c.on]), [['Call 1', true], ['Call 2', true], ['Call 3', true]]);
  assert.deepEqual(card.buttons.map((b) => b.label), ['Yes for all', 'Keep all here']);
  const [yes, keep] = decisionCards(sends, new Set([runs[1]]))[0].buttons;
  assert.equal(yes.label, 'Yes for 2');
  assert.deepEqual(yes.actions.map((a) => a.args), [[runs[0], 'yes'], [runs[2], 'yes']]);
  assert.deepEqual(keep.actions.map((a) => a.args), runs.map((run) => [run, 'no']));
  const none = decisionCards(sends, new Set(runs))[0].buttons[0];
  assert.equal(none.disabled, true);
  assert.deepEqual(none.actions, []);
});

test('a class send says classmates stay on this Mac in place of the names line; a bundle takes its largest count', () => {
  const CLASS = "Classmates' names stay on this Mac: the AI reads them as Student 1 to 7, and your notes show the names.";
  assert.equal(decisionCards([{ ...send, classmates: 7 }])[0].body, CLASS);
  assert.equal(decisionCards([send])[0].body, NAMES_LINE, 'a call with no classmates keeps the names line');
  assert.equal(decisionCards([{ ...send, classmates: 0 }])[0].body, NAMES_LINE);
  assert.equal(decisionCards([{ ...send, classmates: 1 }])[0].body, "Classmates' names stay on this Mac: the AI reads them as Student 1, and your notes show the names.");
  const bundle = decisionCards([{ ...send, classmates: 4 }, { ...send, run: '20261008-101600-cd35' }, { ...send, run: '20261008-101700-cd36', classmates: 7 }])[0];
  assert.equal(bundle.kind, 'decide-bundle');
  assert.equal(bundle.body, CLASS);
  assert.equal(decisionCards([send, { ...send, run: '20261008-101600-cd35' }])[0].body, NAMES_LINE);
});

test('buttons map to the right IPC with the right arguments', async () => {
  const { api, calls } = fakeApi();
  const [yes, no] = decisionCards([send])[0].buttons;
  const [record, dismiss] = surfaceFor(offered).buttons;
  const [stop, keep] = surfaceFor(endAsked).buttons;
  for (const button of [record, dismiss, stop, keep, yes, no]) await runAction(api, button.action);
  assert.deepEqual(calls, [
    ['meetingAnswer', OFFER_ID, 'record'], ['meetingAnswer', OFFER_ID, 'dismiss'],
    ['meetingEnd', '2026-10-08_weekly-sync', 'stop'], ['meetingEnd', '2026-10-08_weekly-sync', 'keep'],
    ['decide', RUN, 'yes'], ['decide', RUN, 'no'],
  ]);
  assert.deepEqual(actionFor('send', RUN, 'nebius', true), { method: 'send', args: [RUN, 'nebius', true] });
});

test('a card leaves on its answer event, and the same event twice makes one card', () => {
  let cards = applyEvent([], offered);
  cards = applyEvent(cards, offered);
  cards = applyEvent(cards, endAsked);
  assert.deepEqual(cards.map((c) => c.kind), ['offer', 'end']);
  cards = applyEvent(cards, answered);
  assert.deepEqual(cards.map((c) => c.kind), ['end']);
  cards = applyEvent(cards, { ...answered, data: { ...answered.data, offer_id: 'other' } });
  assert.equal(cards.length, 1, 'an answer for another offer leaves this card alone');
  cards = applyEvent(cards, endAnswered);
  assert.deepEqual(cards, []);
  assert.deepEqual(applyEvent([], { type: 'step.started', data: {} }), []);
});

function harness({ collapsed }) {
  const made = [];
  class FakeNotification {
    constructor(options) { this.options = options; this.shown = 0; made.push(this); }
    on(name, listener) { this[name] = listener; }
    show() { this.shown += 1; }
  }
  const expanded = [];
  return { made, expanded, notify: (event) => notifyEvent(event, { Notification: FakeNotification, isCollapsed: () => collapsed, expand: () => expanded.push('expand') }) };
}

test('a Notification is made only when the panel is collapsed, and clicking it expands the panel', () => {
  const open = harness({ collapsed: false });
  assert.equal(open.notify(offered), false);
  assert.equal(open.made.length, 0);
  const closed = harness({ collapsed: true });
  assert.equal(closed.notify(offered), true);
  assert.equal(closed.made.length, 1);
  assert.equal(closed.made[0].shown, 1);
  closed.made[0].click();
  assert.deepEqual(closed.expanded, ['expand']);
  assert.equal(closed.notify({ type: 'step.started', data: {} }), false, 'only the offer and the end ask notify');
  assert.equal(closed.made.length, 1);
});

test('the Notification and the card come from the same event', () => {
  const closed = harness({ collapsed: true });
  closed.notify(offered);
  closed.notify(endAsked);
  const [offer, end] = closed.made.map((n) => n.options);
  assert.equal(offer.title, surfaceFor(offered).heading);
  assert.equal(offer.body, `${surfaceFor(offered).title}, ${surfaceFor(offered).people}`);
  assert.equal(offer.body, 'Weekly sync, with 3 people');
  assert.equal(end.title, surfaceFor(endAsked).heading);
  assert.equal(end.actions, undefined, 'no Notification actions: the dev app is unsigned');
});

test('no text on any card or Notification names a model or uses an em dash', () => {
  const closed = harness({ collapsed: true });
  closed.notify(offered);
  closed.notify(endAsked);
  const texts = [
    JSON.stringify(surfaceFor(offered)), JSON.stringify(surfaceFor(endAsked)), JSON.stringify(decisionCards([send])),
    ...closed.made.map((n) => JSON.stringify(n.options)),
  ].join('\n');
  assert.doesNotMatch(texts, /nemotron|nvidia|gemma|claude|gpt|gemini|llama|model|nebius/i);
  assert.doesNotMatch(texts, /—/);
});
