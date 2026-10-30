// The cards the panel shows for a meeting offer, the end ask and the one question after a call (spec-c.md increment 16,
// B12, B15, B18), and the Notification that says the same thing when the panel is collapsed. Pure: the panel draws what
// these return, main.js passes in the Notification constructor, and the tests need neither a DOM nor Electron.

import { cloudYesCard, downloadCard, HEALTH_LINE, setupCard } from './setup-cards.js';

const OFFER_HEADING = 'Transcribe this meeting?';
const END_HEADING = 'Done? Write it up.';
const DECISION_HEADING = 'Summarize with cloud AI?';
// The name check (name-check.js) and the errands (look-outside.js) run under the same yes, so the card says so.
export const NAMES_LINE = "Names Loggie is not sure of, and your steps the web can do, are checked on the web too. People's names never are.";
// A class (loggie-class-notes I3): its send says how many classmates the screen wrote as Student N (send.json
// `classmates`, sendgate.py); a class's name check sends nothing, so this line stands in for NAMES_LINE.
export const classmatesLine = (n) => `Classmates' names stay on this Mac: the AI reads them as ${n === 1 ? 'Student 1' : `Student 1 to ${n}`}, and your notes show the names.`;
const classmatesOf = (send) => (Number.isInteger(send?.classmates) && send.classmates > 0 ? send.classmates : 0);
const bodyFor = (sends) => {
  const n = Math.max(0, ...sends.map(classmatesOf));
  return n ? classmatesLine(n) : NAMES_LINE;
};
const APPS = { zoom: 'Zoom', teams: 'Teams', meet: 'Google Meet' };

// One IPC call on window.loggie.hikyaku: its name and arguments, so a button is data the tests can read.
export const actionFor = (method, ...args) => ({ method, args });
export const runAction = (api, { method, args }) => api[method](...args);

const clock = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};
const peopleLine = (count) => `with ${count} ${count === 1 ? 'person' : 'people'}`;

// meeting-watch.js DOWNLOADING_TEXT: an offer made while the speech files are still downloading carries it as a note.
const DOWNLOADING = 'Transcription is still downloading';

function offerCard({ data, text }) {
  return {
    key: `offer:${data.offer_id}`, kind: 'offer', heading: OFFER_HEADING, note: text === DOWNLOADING ? DOWNLOADING : undefined,
    title: data.title, when: clock(data.start), people: peopleLine(data.people), place: data.place || APPS[data.link_kind] || '',
    buttons: [
      { label: 'Transcribe', primary: true, action: actionFor('meetingAnswer', data.offer_id, 'record') },
      { label: 'Not this one', action: actionFor('meetingAnswer', data.offer_id, 'dismiss') },
    ],
  };
}

// The end card's line from the latest meeting.heard of the call (live.py): how much has been heard, or how far behind the reader is.
const BEHIND_AFTER_S = 30;
export function heardNote(heard) {
  if (!heard) return undefined;
  if (heard.behind_s > BEHIND_AFTER_S) return `Catching up: about ${Math.round(heard.behind_s)} s behind.`;
  const minutes = Math.round(heard.heard_s / 60);
  return `Heard so far: ${minutes < 1 ? 'under 1' : minutes} min. Ready in seconds.`;
}

function endCard({ data }, heard) {
  return {
    key: `end:${data.call}`, kind: 'end', heading: END_HEADING, note: heardNote(heard?.[data.call]),
    buttons: [
      { label: 'Write it up', primary: true, action: actionFor('meetingEnd', data.call, 'stop') },
      { label: 'Keep going', action: actionFor('meetingEnd', data.call, 'keep') },
    ],
  };
}

// The card one event makes, or null. A card leaves on the matching answer event (applyEvent). `heard` is the latest
// meeting.heard data by call, which the panel keeps: the end card shows it.
export function surfaceFor(event, heard) {
  if (event?.type === 'setup.download' && event.data.state === 'ready') return null;
  if (event?.type === 'meeting.offered') return offerCard(event);
  if (event?.type === 'setup.download') return downloadCard(event.data);
  if (event?.type === 'meeting.end_asked') return endCard(event, heard);
  if (event?.type === 'setup.need') return setupCard(event);
  if (event?.type === 'setup.cloud_yes') return cloudYesCard(event.data.group);
  return null;
}

// The key of the card an answer event closes, or null.
export function answeredKey(event) {
  if (event?.type === 'meeting.answered') return `offer:${event.data.offer_id}`;
  if (event?.type === 'meeting.end_answered') return `end:${event.data.call}`;
  if (event?.type === 'setup.answered') return `setup:${event.data.permission}`;
  if (event?.type === 'setup.cloud_answered') return `cloud-yes:${event.data.group}`;
  if (event?.type === 'setup.download' && event.data.state === 'ready') return 'setup:download';
  return null;
}

// The live cards after one more event. The same event twice is one card; an answer for another card changes nothing; a meeting.heard only changes the end card's line.
export function applyEvent(cards, event, heard) {
  if (event?.type === 'meeting.heard') return cards.map((card) => (card.key === `end:${event.data.call}` ? { ...card, note: heardNote(event.data) } : card));
  const card = surfaceFor(event, heard);
  if (card) return [...cards.filter((existing) => existing.key !== card.key), card];
  const closed = answeredKey(event);
  return closed ? cards.filter((existing) => existing.key !== closed) : cards;
}

// The question for calls whose notes are prepared and unanswered (send.json, send-gate.js pendingSends). One call is
// one card. Two or more are one card that names every call, each switchable (`off` holds the runs switched off): Yes
// answers only the calls left on, one by one, and Keep all here answers every call listed. Nothing is answered for a
// call the user switched off; it stays pending. The panel has no review of the outbound text yet, so `review` is null.
export function decisionCards(sends, off = new Set()) {
  const pending = sends.filter((send) => send.what === 'call-notes' && send.status === 'pending');
  if (pending.length > 1) {
    const calls = pending.map((send) => ({ run: send.run, title: send.title || 'A call', on: !off.has(send.run) }));
    const on = calls.filter((call) => call.on);
    return [{
      key: 'decide:bundle', kind: 'decide-bundle', heading: DECISION_HEADING, title: `${pending.length} calls are ready`, calls, review: null, note: HEALTH_LINE, body: bodyFor(pending),
      buttons: [
        { label: `Yes for ${on.length === calls.length ? 'all' : on.length}`, primary: true, disabled: !on.length, actions: on.map((call) => actionFor('decide', call.run, 'yes')) },
        { label: 'Keep all here', actions: calls.map((call) => actionFor('decide', call.run, 'no')) },
      ],
    }];
  }
  return pending.map((send) => ({
    key: `decide:${send.run}`, kind: 'decide', run: send.run, heading: DECISION_HEADING, title: send.title || '', review: null, note: HEALTH_LINE, body: bodyFor([send]),
    buttons: [
      { label: 'Yes', primary: true, action: actionFor('decide', send.run, 'yes') },
      { label: 'No, keep it here', action: actionFor('decide', send.run, 'no') },
    ],
  }));
}

// The same event as a system Notification when the panel is collapsed; clicking it expands the panel at the card.
// No Notification actions: the dev app is unsigned. Returns whether one was made.
export function notifyEvent(event, { Notification, isCollapsed, expand }) {
  const card = surfaceFor(event);
  if (!card || card.kind === 'download' || !isCollapsed()) return false;   // progress is drawn, never announced
  const body = { offer: `${card.title}, ${card.people}`, end: 'Loggie is still recording.', setup: card.why }[card.kind] || [card.body, card.note].join(' ');
  const notification = new Notification({ title: card.heading, body });
  notification.on('click', expand);
  notification.show();
  return true;
}

// "Set up the next meeting?" (invite.js nextMeetingCandidate): one form card for the newest call with a summary and no
// invite yet. The fields arrive filled (same weekday next week, same start, 50 minutes, last building); the user can
// change any of them. A stand-in for the panel's real design (2026-10-08).
const NEXT_HEADING = 'Set up the next meeting?';
export function nextMeetingCard(candidate) {
  if (!candidate) return null;
  return {
    key: `next:${candidate.call}`, kind: 'next-meeting', call: candidate.call, heading: NEXT_HEADING, title: candidate.title,
    body: `Invites the ${candidate.people} ${candidate.people === 1 ? 'person' : 'people'} from this call, with its notes and action items. Loggie fills in Outlook and finds a free room; you press Send.`,
    fields: [
      { name: 'date', label: 'Date', type: 'date', value: candidate.date },
      { name: 'start', label: 'From', type: 'time', value: candidate.start },
      { name: 'end', label: 'To', type: 'time', value: candidate.end },
      { name: 'room', label: 'Building', type: 'text', value: candidate.room, placeholder: 'Any room' },
      { name: 'floors', label: 'Floors', type: 'text', value: candidate.floors ? [...candidate.floors].join(', ') : '', placeholder: 'Any floor, or 2, 3' },
    ],
    submit: { label: 'Fill in Outlook', busy: 'Filling in Outlook…' },
    skip: { label: 'Not now', action: actionFor('skipNextMeeting', candidate.call) },
  };
}

// The line the card shows after Fill in Outlook: what is waiting in Outlook, or what stopped it in plain words.
const clock12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export function inviteResultLine(result, fields) {
  if (result?.status !== 'ready') return { ok: false, text: result?.detail || 'Outlook did not finish the invite. Nothing was sent.' };
  const room = result.room ? `, ${result.room.replace(/\s*\((?:Breakout|[^)]*)\)\s*/, ' ').trim()}` : '';
  return { ok: true, text: `Ready in Outlook: ${clock12(fields.start)} to ${clock12(fields.end)}${room}, ${result.people} people, ${result.actions} action items. Press Send in Outlook.` };
}
