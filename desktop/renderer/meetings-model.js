// Pure helpers for the Notes & Meetings tab (meetings.js draws; these decide). No DOM, so the tests import them.

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export const dayLabel = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? 'Undated' : DAY.format(date).replace(',', ''); };
export const timeLabel = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '' : TIME.format(date); };
export function minutesLabel(minutes) {
  if (minutes == null) return '';
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}
export const clock = (seconds) => (seconds == null ? '' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`);

// The rail's line under a title: "5:33 PM · 55 min", or what the call is doing now.
export function metaLine(call) {
  if (call.state === 'recording') return 'Recording';
  if (call.state === 'transcribing') return 'Writing the transcript';
  if (call.state === 'waiting') return 'Waiting for your yes';
  if (call.state === 'writing') return 'Writing it up';
  return [timeLabel(call.start), minutesLabel(call.minutes)].filter(Boolean).join(' · ');
}
export const headerLine = (call) => [dayLabel(call.start), timeLabel(call.start), minutesLabel(call.minutes), call.people ? `${call.people} people` : ''].filter(Boolean).join(' · ');

// Calls grouped under their day, newest first, after the search filter.
export function groupByDay(calls) {
  const groups = [];
  for (const call of calls) {
    const day = dayLabel(call.start);
    if (groups.at(-1)?.day !== day) groups.push({ day, calls: [] });
    groups.at(-1).calls.push(call);
  }
  return groups;
}

// Search: every word must appear in the title, the workstream, or (when the call is loaded) its summary text.
// The words a search looks for (the same rule as call-list.js searchWords): lowercased, one-letter words dropped
// unless they are digits, at most eight.
export const searchWords = (query) => [...new Set(String(query || '').toLowerCase().split(/\s+/).filter((word) => word.length > 1 || /\d/.test(word)))].slice(0, 8);

export function matches(call, query, detail = null) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [call.title, call.workstream, call.guess, ...(detail?.sections || []).flatMap((s) => [s.heading, ...s.lines.map((l) => l.text)]),
    ...(detail?.steps || []).map((s) => s.text)].filter(Boolean).join(' ').toLowerCase();
  return words.every((word) => hay.includes(word));
}

// A workstream's dot color: the data has none, so the name picks one of eight, the same name always the same color.
export const PALETTE = ['#c98a1b', '#43694b', '#2f6fb3', '#7d55b0', '#b04f86', '#2b8296', '#b5651d', '#5b8a3c'];
export function colorFor(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// The transcript line a time jumps to: the first said at or after it, else the last one before it.
export function lineIndexAt(transcript, seconds) {
  if (!transcript.length || seconds == null) return -1;
  const index = transcript.findIndex((line) => line.at != null && line.at >= seconds);
  return index === -1 ? transcript.length - 1 : index;
}

// The picker's names: the workstreams the cards show, without folder-only projects, Chats or the inbox, guess first.
export function pickerNames(cards, guess = null) {
  const names = (cards || []).filter((card) => !card.folder && card.name && !/^(chats|inbox)$/i.test(card.name)).map((card) => card.name);
  const unique = [...new Set(names)];
  return guess && unique.includes(guess) ? [guess, ...unique.filter((name) => name !== guess)] : unique;
}

// While any call is moving between states the tab polls; otherwise it waits for events.
export const busy = (calls) => calls.some((call) => ['recording', 'transcribing', 'writing'].includes(call.state) || call.names === 'checking');
