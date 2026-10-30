// The ask box's reader (loggie-ask-box). One sentence in the panel's box becomes one of Loggie's fixed actions, read
// by code: no model, nothing leaves the Mac, the same answer every time. A sentence code cannot read is 'unknown', and
// only then may the cloud AI pick an action for it, after the user's yes (ask-cloud.js). Nothing here sends anything.
//
//   readAsk(sentence, { names }) -> { action, who: [text], app, words, meeting, when, original }
//     action: 'message' (a chat: Messages or WhatsApp), 'reply' (answer where they last wrote, or Outlook when the
//             sentence says email), 'said' (what someone wrote lately), 'move' (an existing meeting to a new time),
//             'invite' (quick-invite.js reads it), 'open' (a file), 'unknown'
//     who:    the names as written, one per person or group ("lena", "acme team"); several for one-to-many
//     app:    'messages' | 'whatsapp' | 'outlook' | null when the sentence does not say
//     words:  what the message says, as the user wrote it (first letter capitalized), or the line a reply is drafted from
//
// `names` are the people and chats Loggie knows (the who index, ask-who.js). They tell the reader where a name ends:
// "text lena ortiz when is it" is Lena Ortiz plus the words when the index has her, and Lena plus "ortiz when is it"
// never. Without a match the first word is the name, and the who index says it is not found rather than guessing.
import { parseCommandIntent } from '../commands/intent-parser.js';
import { actionOf, readMessage, readWords } from './wordmap.js';
import { oneEdit } from './people.js';

// A sentence asked as a question: ends in "?", or opens on a question word.
const ASKING = /\?$|^(?:what|what's|whats|when|where|which|who|how|do i|did i|am i|is there|are there|any)\b/i;

export const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^\p{L}\p{N}&'’\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

const APP_WORDS = [
  [/\b(?:on|in|via|over|through|by|using)\s+(?:whats\s?app|wa)\b/i, 'whatsapp'],
  [/\b(?:on|in|via|over|through|by|using)\s+(?:i\s?message|imessage|messages|sms|text)\b/i, 'messages'],
  [/\b(?:on|in|via|over|through|by|using)\s+(?:outlook|e-?mail|mail)\b/i, 'outlook'],
  [/\bby\s+e-?mail\b/i, 'outlook'],
];
const LEAD = /^(?:(?:hey|ok|okay)\s+loggie[,\s]+|loggie[,\s]+)?(?:(?:can|could|would) you\s+|please\s+|pls\s+|go\s+)*/i;
const SAY = /^(?:[:,\-–]\s*|that\s+|saying\s+|to say\s+|and say\s+|and tell (?:them|him|her)\s+|and ask (?:them|him|her)\s+)/i;
const SMALL = new Set(['the', 'a', 'an', 'my', 'our', 'to', 'and', 'of', 'on', 'in', 'at', 'for', 'i', 'me', 'you']);
const GROUP_WORD =/^(?:the\s+)?(.+?)\s+(?:group(?:\s+chat)?|chat|gc|team|crew|squad)\b/i;

function cap(words) {
  const text = String(words || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

// The app a sentence names, and the sentence without that phrase.
export function takeApp(text) {
  for (const [pattern, app] of APP_WORDS) {
    const found = text.match(pattern);
    if (found) return { app, text: (text.slice(0, found.index) + ' ' + text.slice(found.index + found[0].length)).replace(/\s+/g, ' ').trim() };
  }
  return { app: null, text };
}

// The longest known name at the start of `text`, else the first word (or "the X group" as one name).
// Returns { who, rest } with who as written in the sentence.
function oneName(text, names) {
  const words = text.trim().split(/\s+/);
  const folded = words.map((word) => fold(word));
  let best = 0;
  for (const name of names) {
    const parts = fold(name).split(' ').filter(Boolean);
    if (!parts.length) continue;
    // The whole name, or the start of a name ("lena" for Lena Ortiz), word for word, an optional "the" in front.
    for (const offset of folded[0] === 'the' ? [1, 0] : [0]) {
      let n = 0;
      while (n < parts.length && folded[offset + n] === parts[n]) n++;
      // A match made only of small words ("the" from a contact called "The Coop") points at no one.
      const matched = parts.slice(0, n);
      if (n && offset + n > best && matched.some((part) => !SMALL.has(part))) best = offset + n;
    }
  }
  if (best) {
    // A group word right after a known name belongs to it ("acme team chat").
    let end = best;
    while (end < words.length && /^(?:group|chat|gc|team|crew|squad)$/i.test(folded[end]) && !/,$/.test(words[end - 1])) end++;
    // "lena, jamie": the comma stays with the list, not the name.
    const comma = /,$/.test(words[end - 1]) ? ', ' : '';
    return { who: words.slice(0, end).join(' ').replace(/^the\s+/i, '').replace(/,$/, ''), rest: comma + words.slice(end).join(' ') };
  }
  const group = text.match(GROUP_WORD);
  if (group && group[1].split(/\s+/).length <= 4) return { who: group[0].replace(/^the\s+/i, '').trim(), rest: text.slice(group[0].length).trim() };
  return { who: words[0] || '', rest: words.slice(1).join(' ') };
}

// One or more names at the start: "lena", "lena and jamie", "lena, jamie and yuki", "lena & the acme team".
export function takeNames(text, names = []) {
  const who = [];
  let rest = text.trim();
  for (let i = 0; i < 8 && rest; i++) {
    const found = oneName(rest, names);
    if (!found.who) break;
    who.push(found.who.replace(/[,:;]+$/, ''));
    rest = found.rest;
    const joined = rest.match(/^(?:,\s*and\s+|,\s*|and\s+|&\s+|\+\s+)/i);
    // "and" joins a second name only when a known name (or "the X group") follows; otherwise it starts the words.
    if (!joined) break;
    const after = rest.slice(joined[0].length);
    const next = oneName(after, names);
    const known = names.some((name) => fold(next.who) && fold(name).startsWith(fold(next.who))) || GROUP_WORD.test(after.slice(0, 60));
    if (!known) break;
    rest = after;
  }
  return { who, rest: rest.trim() };
}

const words = (rest) => cap(rest.replace(SAY, '').replace(SAY, ''));

// Each shape: a pattern on the sentence (app phrase already taken out) and what it means.
const SHAPES = [
  // "what did lena say", "did jamie reply", "anything from the acme team", "catch me up on lena", "last message from lena"
  { action: 'said', re: /^(?:what(?:'s| is| has| did)?\s+(?:the latest|new)?\s*(?:from|with)?\s*)(.+?)\s+(?:say|said|send|sent|write|wrote|text|texted|reply|replied|ask|asked|want|wants|need|needs)\b.*$/i, who: 1 },
  { action: 'said', re: /^did\s+(.+?)\s+(?:reply|respond|answer|write back|text back|get back|say anything|email|text|write)\b.*$/i, who: 1 },
  { action: 'said', re: /^(?:anything|any news|anything new|news|any update|any updates|updates?)\s+(?:new\s+)?(?:from|on|with)\s+(.+?)\??$/i, who: 1 },
  { action: 'said', re: /^(?:catch me up on|update me on|what'?s (?:new|up|going on) with|last (?:message|text|email) from|show me (?:what )?(.+?) (?:said|wrote))\s*(.*?)\??$/i, who: 2, alt: 1 },
  // "move my 3pm with lena to friday", "push the acme call to friday 2pm", "reschedule my meeting with jamie to tomorrow at 4"
  { action: 'move', re: /^(?:move|push|reschedule|shift|bump|change)\s+(.+?)\s+(?:to|until|till)\s+(.+?)\.?$/i, move: true },
  // "reply to lena saying ...", "respond to jamie: ...", "write back to yuki that ...", "answer lena ..."
  { action: 'reply', re: /^(?:reply|respond|write back|get back|answer|follow up)\s+(?:to\s+|with\s+)?(.+)$/i, rest: 1 },
  // "email jamie that ..." answers Jamie's last email in Outlook
  { action: 'reply', re: /^(?:e-?mail|mail)\s+(.+)$/i, rest: 1, app: 'outlook' },
  // "let lena know ...": the name sits between "let" and "know"
  { action: 'message', re: /^let\s+(.+?)\s+know\s*(.*)$/i, between: true },
  // "send lena a text saying ...", "send a message to the acme team ...", "send the acme team a whatsapp ..."
  { action: 'message', re: /^send\s+(?:a\s+)?(text|message|msg|whatsapp|imessage|dm)\s+to\s+(.+)$/i, verb: 1, rest: 2 },
  { action: 'message', re: /^send\s+(.+?)\s+(?:a|an)\s+(text|message|msg|whatsapp|imessage|dm)\b\s*(.*)$/i, sendX: true },
  // "text lena ...", "whatsapp the acme team ...", "tell jamie ...", "ask yuki ...", "ping lena ...", "message lena ..."
  { action: 'message', re: /^(text|txt|message|msg|imessage|i message|whatsapp|whats app|wa|dm|tell|ask|ping|remind|shoot)\s+(?:a (?:text|message) to\s+)?(.+)$/i, verb: 1, rest: 2 },
];
const VERB_APP = { whatsapp: 'whatsapp', 'whats app': 'whatsapp', wa: 'whatsapp', imessage: 'messages', 'i message': 'messages' };

// "separately", "each", "individually": several people get one draft each instead of one message to all of them.
const SEPARATE = /\s*\b(?:separately|individually|one by one|each(?: of them)?)\b\s*/i;

export function readAsk(sentence, { names = [] } = {}) {
  const typed = String(sentence || '').trim();
  const separate = SEPARATE.test(typed);
  const original = separate ? typed.replace(SEPARATE, ' ').replace(/\s+/g, ' ').trim() : typed;
  if (!original) return { action: 'unknown', who: [], app: null, words: '', original };
  // Invites and file opens keep their own readers (quick-invite.js, intent-parser.js).
  const legacy = parseCommandIntent(original);
  // "reschedule my meeting with lena" says "meeting with", but it moves a meeting that exists.
  const moving = /^(?:(?:can|could|would) you\s+|please\s+)*(?:move|push|reschedule|shift|bump)\b/i.test(original);
  // The first action word decides (wordmap.js): "all clear on the release schedule, email lena" is an email, and
  // "text lena did you get the invite" a text.
  const isName = namesTest(names);
  const verb = actionOf(original, isName);
  // An invite word with no verb of its own counts only when the word map reads an invite too: "let sam know we are
  // behind schedule" says schedule and is a text.
  // A question about meetings with no invite word ("what meetings do I have tomorrow?", "when is my next meeting?") asks
  // about the calendar; the assistant answers it (ask-run.js). Only "invite", "schedule", "meet", "book" or "set up" make
  // an invite of it (2026-10-12: both read as invites and never reached the assistant).
  const asking = !verb && ASKING.test(original.trim());
  if (!moving && (verb?.action === 'invite' || (!verb && !asking && legacy.type === 'invite' && !legacy.inferred && readWords(original, { isName }).action === 'invite'))) return { action: 'invite', who: [], app: 'outlook', words: '', original };
  const taken = takeApp(original.replace(LEAD, '').trim());
  const text = taken.text.replace(/\s+/g, ' ').trim();
  // A sentence whose verb-first reading names no one Loggie knows ("let me know when you arrive, wa lena", "did you
  // find the notes? lena text") is tried in any order first, and kept only when that finds someone known.
  const loose = readMessage(original, { isName });
  const known = (who) => who.length && who.every((w) => isName(w, { loose: true }));
  for (const shape of SHAPES) {
    const found = text.match(shape.re);
    if (!found) continue;
    const base = { action: shape.action, app: shape.app || taken.app, original, separate };
    if (shape.action === 'said') {
      const raw = (found[shape.who] || found[shape.alt] || '').trim();
      if (!raw) continue;
      const who = takeNames(raw, names).who;
      if (!known(who) && loose && known(loose.who)) break;
      return { ...base, who, words: '' };
    }
    if (shape.move) {
      // The meeting is everything before "to"; a "with <name>" in it names who it is with.
      const meeting = found[1].replace(/^(?:my|the|our)\s+/i, '').trim();
      const withWho = meeting.match(/\bwith\s+(.+)$/i);
      // Only a known name counts here: "my thing with the bank people" names no one, and the meeting words find it.
      const isKnown = (who) => names.some((name) => fold(name).startsWith(fold(who)));
      const who = withWho ? takeNames(withWho[1], names).who.filter(isKnown) : [];
      return { ...base, who, meeting, when: found[2].trim(), words: '', app: 'outlook' };
    }
    if (shape.between) {
      const { who } = takeNames(found[1], names);
      if (!known(who) && loose && known(loose.who)) break;
      return { ...base, who, words: words(found[2]) };
    }
    if (shape.sendX) {
      const { who } = takeNames(found[1], names);
      return { ...base, app: base.app || VERB_APP[found[2].toLowerCase()] || null, who, words: words(found[3]) };
    }
    const rest = found[shape.rest];
    const verbApp = shape.verb ? VERB_APP[found[shape.verb].toLowerCase()] : null;
    let { who, rest: said } = takeNames(rest, names);
    if (!who.length) continue;
    // A colon ends the name: "email Lucky Star: ask about the bar tab" is to Lucky Star (a move from a text writes its
    // line this way, chat-email.js), not to Lucky with "Star: ..." as the words. Capitalized words only, so "email lena
    // about the deadline: friday works" keeps its words.
    const tail = who.length === 1 ? said.match(/^((?:[\p{Lu}\p{N}&][^\s:,]*\s*){1,3}):\s*([\s\S]*)$/u) : null;
    if (tail) { who = [`${who[0]} ${tail[1].trim()}`]; said = tail[2]; }
    // The word map found more of the people ("email jamei chen and marisol ..."): its reading wins.
    if (loose && known(loose.who) && (!known(who) || loose.who.length > who.length)) break;
    const app = base.app || verbApp || null;
    return { ...base, app, who, words: words(said) };
  }
  // Not verb first: the word map reads it in any order ("running late, text lena").
  if (loose) return { action: loose.action, who: loose.who, app: loose.app, words: cap(loose.words), original, separate };
  if (legacy.type === 'open') return { action: 'open', who: [], app: null, words: '', original };
  // No verb at all, but the kind of meeting or a time beside a person: an invite ("lunch with lena friday").
  if (!moving && !asking && readWords(original, { isName }).action === 'invite') return { action: 'invite', who: [], app: 'outlook', words: '', original };
  return { action: 'unknown', who: [], app: taken.app, words: '', original };
}

// Who a word can be, for the word map: someone's whole name or first name; right after a verb, "and" or a comma, also
// the start of a name or a one-letter slip ("marisl").
// Two or more words that are a whole name with one word a letter off ("jamei chen").
export function slipOf(parts, typed) {
  if (parts.length !== typed.length) return false;
  const off = parts.filter((part, i) => part !== typed[i]);
  return off.length === 1 && parts.every((part, i) => part === typed[i] || (typed[i].length >= 4 && oneEdit(part, typed[i])));
}

export function namesTest(names = []) {
  const folded = names.map((name) => fold(name)).filter(Boolean);
  return (text, { loose = false } = {}) => {
    const q = fold(text).replace(/^the /, '');
    if (!q) return false;
    if (/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(text).trim())) return true;
    for (const name of folded) {
      const parts = name.split(' ');
      if (name === q || parts[0] === q || (q.includes(' ') && name.startsWith(`${q} `))) return true;
      if (q.includes(' ') && slipOf(parts, q.split(' '))) return true;
      if (loose && !q.includes(' ') && parts.some((part) => part === q || (q.length >= 3 && part.startsWith(q)) || (q.length >= 4 && part.length >= 5 && oneEdit(part, q)))) return true;
    }
    return false;
  };
}
