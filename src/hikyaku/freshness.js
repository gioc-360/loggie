// Stops a reply from being placed when the person has written again since the email the draft answers.
//
// Twice the task's THREAD.md was not the newest correspondence with the person, and nothing checked:
// 2026-10-04 a draft thanked the co-builder again because THREAD.md was an old copy missing the user's own latest
// reply; 2026-10-05 the user's latest email to her went out from Outlook as a new email (so it never reached
// Gmail), she answered in that other thread, and the draft answering her older email was saved into the old thread.
// So before anything opens, the newest mail with the person is looked up from any thread or subject, in every Apple Mail
// account both ways (what she sent, what the user sent to her). A message
// newer than THREAD.md's newest, and not already in it, makes the draft stale. Code enforces this; no prompt line.
// Read-only: nothing here can save, open or send.
import { addressOf } from './draft.js';

// Who THREAD.md names and when, from its "## Name <address> · <ISO date>" headers.
export function threadMessages(markdown = '') {
  return [...String(markdown).matchAll(/^## (.+?) · (\S+)\s*$/gm)]
    .map((match) => ({ from: addressOf(match[1]).toLowerCase(), name: match[1].replace(/<[^>]*>/, '').replace(/"/g, '').trim(), date: match[2] }))
    .filter((message) => message.from && Number.isFinite(Date.parse(message.date)));
}

const nameOf = (header = '', fallback = '') => String(header).replace(/<[^>]*>/, '').replace(/"/g, '').trim() || fallback;
// Two timestamps this close are one message seen from two mailboxes (sent-mail.js uses the same window).
const SAME_MESSAGE_MS = 3 * 60000;
// Calendar responses and invitations, as Outlook, Gmail and Apple Mail title them.
export const CALENDAR_REPLY = /^\s*(accepted|declined|tentative|tentatively accepted|canceled|cancelled|invitation|updated invitation|new event)\s*:/i;
// A meeting invite the user sent, as Zoom, Teams and Google Meet write its body. It has no words a draft could repeat or
// contradict (2026-10-23: the Zoom invite for a coffee chat stopped the thank-you for that chat).
export const MEETING_INVITE = /is inviting you to a scheduled zoom meeting|^\s*microsoft teams meeting\s*$|^\s*join with google meet\s*$/im;

// The newest message with the person that THREAD.md does not have, or null. `me` is the user's own addresses.
// `freshness` says whether any source could be read: 'checked' or 'unchecked' (the CLI reads no mail; the Mac may
// have no readable Sent folder). An unreadable source never blocks; it is named in `notes`.
export async function freshnessOf({ thread = '', original = {}, me = [], readSent = null, readInbox = null, now = () => new Date() } = {}) {
  const person = String(original.from || '').toLowerCase();
  const known = threadMessages(thread);
  const cutoff = [original.date, ...known.map((message) => message.date)].filter((date) => Number.isFinite(Date.parse(date || ''))).sort().at(-1) || null;
  if (!person || !cutoff) return { freshness: 'unchecked', newer: null, notes: ['The task does not say which email it answers.'] };
  const own = new Set(me.map((address) => addressOf(address).toLowerCase()).filter(Boolean));
  const personName = known.find((message) => message.from === person)?.name || person;
  const inThread = (candidate) => known.some((message) => message.from === candidate.from
    && Math.abs(Date.parse(message.date) - Date.parse(candidate.date)) < SAME_MESSAGE_MS);
  const found = [];
  const notes = [];
  let sources = 0;
  const consider = (candidate) => {
    if (!candidate.date || Date.parse(candidate.date) <= Date.parse(cutoff) || inThread(candidate)) return;
    // A calendar reply ("Accepted: Gio and Rowena chat M&T") is not a message the draft could be out of date with
    // (2026-10-21: it stopped the Rowena draft in the live check).
    if (CALENDAR_REPLY.test(String(candidate.subject || ''))) return;
    if (candidate.direction === 'to-person' && MEETING_INVITE.test(String(candidate.body || ''))) return;
    found.push(candidate);
  };
  // What the user sent, from any account, is in Apple Mail's copy of the Sent folders (sent-mail.js).
  // Every address of the user's: readSent and readInbox read each Apple Mail account they name (spec W10b).
  const address = [...own].filter(Boolean);
  if (readSent && address.length) {
    try {
      const days = Math.min(30, Math.max(1, Math.ceil((now().getTime() - Date.parse(cutoff)) / 86400000) + 1));
      for (const message of await readSent({ address, days })) {
        // To only (sent-mail.js `primary`): an email that only copied the person is not one written to them.
        if (!(message.primary || message.to || []).map((item) => item.toLowerCase()).includes(person)) continue;
        consider({ from: message.from || address[0], who: personName, direction: 'to-person', subject: message.subject || '', date: message.timestamp, source: 'outlook-sent', threadId: null, body: message.body || '' });
      }
      sources += 1;
    } catch (error) { notes.push(`Sent mail could not be checked: ${error.message}`); }
  }
  // What the person sent to any of the user's addresses (2026-10-06: a "Friday 1 pm" answer to the Outlook address).
  if (readInbox && address.length) {
    try {
      const days = Math.min(30, Math.max(1, Math.ceil((now().getTime() - Date.parse(cutoff)) / 86400000) + 1));
      const fromPerson = (message) => addressOf(message.from).toLowerCase() === person;
      for (const message of await readInbox({ address, days, keep: fromPerson, bodies: false })) {
        if (!fromPerson(message)) continue;
        consider({ from: person, who: nameOf(message.from, personName), direction: 'from-person', subject: message.subject || '', date: message.timestamp, source: 'outlook-inbox', threadId: null });
      }
      sources += 1;
    } catch (error) { notes.push(`Outlook inbox could not be checked: ${error.message}`); }
  }
  found.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const newer = found[0] ? (({ body, ...rest }) => rest)(found[0]) : null;
  return { freshness: sources ? 'checked' : 'unchecked', newer: newer ? { ...newer, reason: staleReason(newer) } : null, cutoff, notes };
}

// Plain words for the person: who wrote, in which thread, when, and that nothing was opened.
export function staleReason(newer) {
  const day = new Date(newer.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const subject = `"${String(newer.subject || '(no subject)').replace(/"/g, '’')}"`;
  const lead = newer.direction === 'from-person'
    ? `${newer.who} wrote again after the email this draft answers: ${subject}, ${day}${newer.source === 'outlook-inbox' ? ' (to your Outlook address)' : ''}.`
    : `You wrote to ${newer.who} after the email this draft answers: ${subject}, ${day}${newer.source === 'outlook-sent' ? ' (sent from Outlook)' : ''}.`;
  return `${lead} The draft may be out of date, so nothing was opened.`;
}
