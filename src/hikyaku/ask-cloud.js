// A sentence code cannot read, read by the cloud AI (loggie-ask-box increment 8), only after the user's yes. The AI
// sees the sentence and the list of Loggie's actions, nothing else: no names, no messages. It answers with one pick;
// code checks every name in the pick appears in the sentence (the AI may not invent a person), turns the pick into a
// sentence code can read, and the user confirms it ("Did you mean ...") before anything runs. The AI never runs or
// writes an action itself.
import { parseJsonReply } from './model.js';
import { fold } from './ask.js';
import { oneEdit } from './people.js';

export const CLOUD_ACTIONS = Object.freeze(['message', 'reply', 'said', 'invite', 'move']);

export function cloudPrompt(sentence) {
  return [
    'You read one sentence a person typed into their Mac assistant and pick which action they want. You only pick; you never act.',
    'Actions:',
    '- message: send a text in Messages or WhatsApp. Fields: who (names as written), words (the message itself, in first person, as they would send it), app ("messages", "whatsapp" or null).',
    '- reply: answer the last message or email from one person. Fields: who (one name), words (what the reply should say).',
    '- said: show what someone wrote lately. Fields: who.',
    '- invite: a calendar invite. Fields: who, when (day and time as written, e.g. "tomorrow 5:30pm"), place (only if they named one), kind (call, coffee, lunch, meeting...).',
    '- move: move an existing meeting. Fields: who (if named), meeting (words that name it), when (the new day and time).',
    '- none: none of these fits.',
    'Rules: copy names exactly as they appear in the sentence; never add a name that is not in it. Keep the person\'s own words where you can. Correct obvious typos in times and days only.',
    `Sentence: "${String(sentence).slice(0, 400)}"`,
    'Answer with JSON only: {"action": "...", "who": ["..."], "words": "...", "app": null, "when": "", "place": "", "kind": "", "meeting": ""}',
  ].join('\n');
}

// A name from the AI counts only when each of its words is in the sentence (or one letter off a word of 5+ letters).
function inSentence(name, sentence) {
  const words = fold(sentence).split(' ');
  return fold(name).split(' ').filter(Boolean).every((part) => words.includes(part)
    || (part.length >= 5 && words.some((word) => oneEdit(word, part))));
}

// The AI's answer, checked. Returns { action, who, words, app, when, place, kind, meeting } or null.
export function parsePick(raw, sentence) {
  let pick;
  try { pick = parseJsonReply(raw); } catch { return null; }
  if (!pick || !CLOUD_ACTIONS.includes(pick.action)) return null;
  const clean = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const who = (Array.isArray(pick.who) ? pick.who : pick.who ? [pick.who] : []).map((name) => clean(name, 60)).filter(Boolean).slice(0, 8);
  if (who.some((name) => !inSentence(name, sentence))) return null;
  const out = { action: pick.action, who, words: clean(pick.words), app: ['messages', 'whatsapp'].includes(pick.app) ? pick.app : null,
    when: clean(pick.when, 60), place: clean(pick.place, 80), kind: clean(pick.kind, 30), meeting: clean(pick.meeting, 80) };
  if (['message', 'reply', 'said', 'invite'].includes(out.action) && !who.length) return null;
  if (['message', 'reply'].includes(out.action) && !out.words) return null;
  if (out.action === 'move' && !out.when) return null;
  return out;
}

const list = (who) => (who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who.at(-1)}` : who[0] || '');

// The pick as a sentence the code readers take: what "Did you mean" shows, and what runs on Yes.
export function rewrite(pick) {
  const app = pick.app === 'whatsapp' ? ' on whatsapp' : pick.app === 'messages' ? ' on imessage' : '';
  if (pick.action === 'message') return `text ${list(pick.who)}${app} ${pick.words}`;
  if (pick.action === 'reply') return `reply to ${pick.who[0]}: ${pick.words}`;
  if (pick.action === 'said') return `what did ${list(pick.who)} say`;
  if (pick.action === 'invite') return ['invite', list(pick.who), pick.when, pick.kind ? `for a ${pick.kind}` : '', pick.place ? `at ${pick.place}` : ''].filter(Boolean).join(' ');
  if (pick.action === 'move') return `move ${pick.meeting || 'my meeting'}${pick.who.length ? ` with ${list(pick.who)}` : ''} to ${pick.when}`;
  return '';
}
