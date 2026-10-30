// An email reply from the ask box (loggie-ask-box increment 5): "reply to jamie: thursday works" when Jamie last wrote
// by email. Code finds Jamie's newest email in Outlook (read through Apple Mail, sent-mail.js) and writes the task
// files the Outlook reply helper already reads (THREAD.md, REPLY.json, DRAFT.md; draft.js placeDraft). The words of
// the reply are either the user's own, as typed, or written by the cloud AI from the user's line, and the cloud AI
// sees the email only after the user's yes. Nothing is sent: the reply opens in Outlook and the user presses Send.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonReply } from './model.js';
import { NEBIUS_ULTRA } from './nebius.js';
import { guardTimes } from './draft-times.js';
import { TIMES_RULE, availabilityReport, fillTimes, lineSkip, strayTimes } from './availability.js';

const capFirst = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

// The person's newest email in `mail` (readInboxMail rows, with bodies), or null.
export function newestFrom(mail, email) {
  const address = String(email || '').toLowerCase();
  const own = (mail || []).filter((message) => String(message.from || '').toLowerCase().includes(`<${address}>`) || String(message.from || '').toLowerCase() === address);
  return own.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0] || null;
}

const nameOf = (from) => (String(from).match(/^\s*"?([^"<]*?)"?\s*</) || [])[1]?.trim() || '';

// THREAD.md in the shape draft.js reads back: "# subject", then "## Name <address> · ISO" and the body per message.
// `history` is the rest of the thread, both sides (the person's earlier emails and the user's own sent ones), oldest
// to newest with the answered email last. 2026-10-17: with the answered email alone the cloud AI saw "We will send it
// shortly." and nothing of the booking it was about.
export function threadFor(message, email, { history = [], own = '', ownName = '' } = {}) {
  const name = nameOf(message.from) || email;
  const rest = (history || []).filter((item) => item && item.id !== message.id && String(item.timestamp) <= String(message.timestamp))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const block = (item) => {
    const mine = item.fromMe || (own && String(item.from || '').toLowerCase().includes(own.toLowerCase()));
    const header = mine ? `${ownName || 'You'} <${own || 'you'}>` : `${nameOf(item.from) || email} <${email}>`;
    return `## ${header} · ${item.timestamp}\n\n${String(item.body || item.snippet || '').trim()}\n`;
  };
  return [`# ${message.subject || '(no subject)'}\n`, ...rest.map(block), `## ${name} <${email}> · ${message.timestamp}\n\n${String(message.body || message.snippet || '').trim()}\n`].join('\n');
}

export function replyFor(message, email, account) {
  const subject = String(message.subject || '');
  return { to: email, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(), account: account || '',
    original: { from: email, date: message.timestamp, subject, messageId: null,
      // The Envelope Index row, so a reply in Apple Mail opens on this exact email (apple-mail-reply.js).
      ...(/^apple-mail-\d+$/.test(String(message.id || '')) ? { rowId: Number(String(message.id).slice('apple-mail-'.length)) } : {}) } };
}

// The words as typed, signed: "Thursday works" -> "Thursday works.\n\nGio" (a reply in Outlook gets no signature).
export function typedBody(words, signName = '') {
  const text = capFirst(String(words || '').trim());
  const ended = /[.!?]$/.test(text) ? text : `${text}.`;
  return signName ? `${ended}\n\n${signName}` : ended;
}

// The model the box writes emails with. Nemotron 3 Super turned "can i get 2 more days" into "I can get 2 more days",
// called a recruiter "Professor" and read "3 works" as "three items"; Ultra got all of them right at the same speed
// (5 made-up cases, median 650 ms against 800 ms; about $0.0005 a draft) (2026-10-12).
export const DRAFT_MODEL = NEBIUS_ULTRA;

// The line is a note, the email is what goes out. Two failures set the first rules (2026-10-12): "sending my
// assignment 2" came back as "Got it." (the line dropped), and after "say everything it says" the line came back as
// typed, no greeting, lowercase fragments. A third set the rest (2026-10-17): "Can we set up a $500 bar tab for our
// Oct 22 karaoke event?" came back as "Hi K-HOUSE Karaoke, I am asking if we can set up...", because the old rule
// made every point an "I am..." sentence and the model had none of the user's own emails to greet like. No phrase is
// banned: the user's real reply to that venue was "I'd like to inquire if we can set up a $500 bar tab" (formal with a
// business), so the user's own emails set the register, not a rule. The draft starts the email; the user adds the rest.
const FINISH = [
  'The user typed a quick note of what to say. Turn it into the email they would send, written the way they write.',
  'Keep the note\'s own words and sentence shape. A question stays a question ("can i get 2 more days" becomes "Can I get 2 more days?", never "I can get..."). Finish what is unfinished into a full sentence, adding only the small words it needs: "sending my assignment" becomes "I am sending you my assignment", "yes sunday 2pm library" becomes "Yes, Sunday at 2pm at the library works." Fix capitals and punctuation.',
  'Keep every point and fact of the note, numbers exactly. Never answer with only an acknowledgment.',
  'The note often answers the email\'s questions: read it against them ("3 works" after "are we meeting at 3?" means 3 o\'clock works).',
  'The thread is there to understand the note, not to repeat it. Add no reasons, context, facts, dates, promises, apologies or questions the note does not give, even ones the thread holds. One short thanks is fine when the email offered help.',
];
// The greeting: the user's own when code has their emails to this person, else the defaults. Code picks the one rule:
// worded as "theirs, or else the defaults" the model greeted a professor "Hi Rosa" with no email to copy (2026-10-17).
export function greetingRule(examples = [], { word = 'Hi' } = {}) {
  return (examples || []).some((item) => String(item.body || '').trim())
    ? 'Greet the way the user greets this person in their own emails shown below: the same greeting word and their first name only (never a last name), or no name if they used none.'
    : `Greet with "${word} <first name>,": the way the user greets people, and the person's first name only, never a last name and never the way the sender addressed the user. A professor or teacher (their signature or title says Professor, Lecturer or Dr., or they write about the user's class, assignment, extension or grade): "Professor <last name>,". A company, venue or office writing as itself (no person's name in its From line): "${word},".`;
}
// The user's greeting word from their own sent mail to anyone ("Hi" for Gio): the most common opening word, "Hi" when
// none reads (loggie-reply-yes: "its how i write so, loggie should know"; the draft had copied the sender's "Hello Gio
// Albert," back as "Hello Kaitlyn Cartwright,").
const GREETING = /^\s*(hi|hey|hello|dear|good (?:morning|afternoon|evening))\b/i;
export function greetingWord(sent = []) {
  const counts = new Map();
  for (const item of sent || []) {
    const first = String(item?.body || '').split('\n').find((line) => line.trim()) || '';
    const match = GREETING.exec(first);
    if (match) { const key = match[1].toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1); }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? top.replace(/^./, (c) => c.toUpperCase()) : 'Hi';
}
// A greeting that names the person in full ("Hello Kaitlyn Cartwright,") keeps the first name only. Code, after the
// model: a rule in the prompt is a request, this is a guarantee. "Professor <last name>" and "Dear Dr." are left alone.
// `word`: the user's own greeting word, put in place of a casual one the model chose ("Hello" -> "Hi"), only when the
// user has no emails to this person to copy from (the caller passes it then).
export function firstNameGreeting(body = '', fullName = '', { word = null } = {}) {
  let name = String(fullName || '').replace(/[<(].*$/, '').replace(/"/g, '').trim();
  // Outlook's "Last, First" reads first name first.
  if (/^[^,]+,\s*\S/.test(name)) name = name.replace(/^([^,]+),\s*(.+)$/, '$2 $1');
  const parts = name.split(/\s+/).filter(Boolean);
  const lines = String(body).split('\n');
  const index = lines.findIndex((line) => line.trim());
  if (index < 0 || /professor|dr\./i.test(lines[index])) return body;
  if (word) lines[index] = lines[index].replace(/^(\s*)(?:hi|hey|hello)\b/i, `$1${word}`);
  if (parts.length < 2) return lines.join('\n');
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(\\s*\\p{L}+(?: \\p{L}+)?\\s+)${escape(parts[0])}(?:\\s+\\p{L}+\\.?)*?\\s+${escape(parts.at(-1))}\\b`, 'iu');
  lines[index] = lines[index].replace(pattern, `$1${parts[0]}`);
  return lines.join('\n');
}
// The user's own emails to this person, newest first: how they greet and sound, never what to say.
export function examplesBlock(examples = []) {
  const bodies = (examples || []).map((item) => String(item.body || '').trim()).filter(Boolean).slice(0, 3);
  if (!bodies.length) return '';
  return `How the user writes to this person (their own emails, newest first; copy the greeting and the tone, never the content):\n${bodies.map((body) => `---\n${body.slice(0, 600)}`).join('\n')}\n---`;
}
// The prompt the cloud AI writes the reply from: the thread, the user's note, how the user writes to this person, the
// user's rules. JSON back. `times` (an availability ask, availability.js): one more rule, TIMES_RULE, after the FINISH
// rules; the model writes [your times] and code fills it. Nothing of the calendar is in the prompt.
export function replyPrompt({ thread, line, rules = '', signName = '', examples = [], times = false, word = 'Hi' }) {
  return [
    'Write the body of an email reply for the user. Plain text, no subject line, no quoted email.',
    `The user's note: "${line}"`,
    FINISH[0], greetingRule(examples, { word }), ...FINISH.slice(1), ...(times ? [TIMES_RULE] : []),
    signName ? `End with "Best," and the name ${signName} on the next line.` : 'End with "Best,".',
    examplesBlock(examples),
    rules ? `The user's writing rules:\n${rules.slice(0, 1500)}` : '',
    `The thread being answered, oldest first; the reply answers the last email:\n${thread.slice(-6000)}`,
    'Answer with JSON only: {"body": "<the reply>"}',
  ].filter(Boolean).join('\n\n');
}

// A new email, no thread: the note and the user's rules only (nothing of anyone's mail goes to the cloud).
// `group`: the names of everyone it goes to, when that is more than one person (one email to all of them, 2026-10-21):
// one greeting for all, since one person's emails would set the wrong one.
export function newEmailPrompt({ line, rules = '', signName = '', examples = [], times = false, group = [], word = 'Hi' }) {
  const greeting = group.length > 1 ? `It goes to ${group.join(', ')} together. Greet them together ("Hi all," or "Hi everyone,"), never one of them by name.` : greetingRule(examples, { word });
  return [
    'Write a short new email for the user: a subject line and a plain-text body.',
    `The user's note: "${line}"`,
    FINISH[0], greeting, ...FINISH.slice(1), ...(times ? [TIMES_RULE] : []),
    signName ? `End with a short sign-off and the name ${signName}.` : 'End with a short sign-off.',
    examplesBlock(examples),
    rules ? `The user's writing rules:\n${rules.slice(0, 1500)}` : '',
    'Answer with JSON only: {"subject": "<under 8 words>", "body": "<the email>"}',
  ].filter(Boolean).join('\n\n');
}

// Does the draft still say the line? Every number in the line, and at least half of its other words (plural and -ing
// forms count), must be in the body. Small words do not count. A draft that fails is not used: the line goes as typed.
// `skip`: words left out of the check (an availability draft names no day or time: the block carries them).
const SMALL = new Set(`a an the and or but so to of in on at by for with from as is am are was were be been it its i
me my we our you your he she they them his her their this that these those will would can could do does did have has
had just also please thanks thank hi hello hey dear ok okay yes no not im ive id`.split(/\s+/));
const root = (w) => w.replace(/(ies|es|s|ing|ed)$/, '') || w;
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export function keepsLine(line, body, { skip = [] } = {}) {
  const said = String(body || '').toLowerCase();
  const skipped = new Set(skip);
  const words = (String(line || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !SMALL.has(w) && !skipped.has(w));
  const numbers = words.filter((w) => /\d/.test(w));
  // A number may come back as its word: "2 more days" -> "two more days".
  const spelled = (n) => NUMBER_WORDS[Number(n)];
  const rest = [...new Set(words.filter((w) => !/\d/.test(w)).map(root))].filter((w) => w.length >= 2);
  if (numbers.some((n) => !new RegExp(`(^|[^\\p{N}])${n}($|[^\\p{N}])`, 'u').test(said) && !(spelled(n) && new RegExp(`\\b${spelled(n)}\\b`).test(said)))) return false;
  // A misspelled note word counts when the draft has it spelled right (loggie-reply-yes: "availble", "lookng" and
  // "intervew" made a corrected draft look like it dropped the note, so the note went as typed, typos and all): one
  // letter off for words of 4, two for 5 and longer. Numbers above stay exact.
  const bodyWords = [...new Set(said.match(/[\p{L}]+/gu) || [])].flatMap((b) => [b, root(b)]);
  const near = (w) => w.length >= 4 && bodyWords.some((b) => Math.abs(b.length - w.length) <= (w.length >= 5 ? 2 : 1) && editDistance(w, b) <= (w.length >= 5 ? 2 : 1));
  const found = rest.filter((w) => said.includes(w) || near(w)).length;
  return rest.length === 0 ? said.trim().length > 0 : found * 2 >= rest.length;
}

// Letters added, dropped, changed or swapped with the next one (Damerau, restricted): "tusday" to "tuesday" is 1.
export function editDistance(a = '', b = '') {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// A subject from the line when the cloud AI did not write one: its first words, capitalized, no end mark.
export const typedSubject = (line) => capFirst(String(line || '').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '').split(/\s+/).slice(0, 8).join(' '));

// The reply body from the cloud AI's answer, or null when it is empty, too long, or not JSON.
export function parseReplyBody(raw) {
  try {
    const body = String(parseJsonReply(raw)?.body || '').trim();
    return body && body.length <= 2500 ? body : null;
  } catch { return null; }
}

// Writes the task folder and the draft. `message` null is a new email (no thread). `cloud` is 'words' (as typed,
// nothing leaves the Mac) or 'ai' (complete is the cloud AI, already behind the user's yes). A cloud draft that drops
// the line (keepsLine) is not used. Returns { taskDirectory, body, subject, how, times }; how is 'ai', 'words',
// 'words-after-ai-failed' or 'words-after-ai-dropped-line'. `times` (draft-times.js guardTimes): a clock time or date
// the draft states that is not in the thread, the user's typed words (`typed`, the whole sentence, and the line) or
// `calendar` (the calendar data the draft was given, none from the ask box today) comes out for "[your times]";
// `times.note` then says so in the ask's outcome.
// An availability ask (`asked` 'typed' | 'thread', availability.js): the prompt gets TIMES_RULE, the read of the
// calendar (`availability`, a promise the caller started before the model call; it never rejects) is awaited after the
// guard, and fillTimes writes the free ranges where the draft says [your times]; strayTimes then takes out any time
// outside them. The guard never runs after the fill. Returns `availability: { record, did }` too.
export async function prepareEmailReply({ taskDirectory, message, email, account, line, typed = '', cloud, complete = null, signName = '', voiceDirectory = null, history = [], examples = [], calendar = null, asked = null, availability = null, group = [], word = 'Hi' }) {
  await mkdir(taskDirectory, { recursive: true });
  const thread = message ? threadFor(message, email, { history, own: account, ownName: signName }) : '';
  if (message) await writeFile(join(taskDirectory, 'THREAD.md'), thread);
  const reply = message ? replyFor(message, email, account) : { to: email, subject: '', account: account || '', fresh: true };
  let body = null, subject = '', how = 'words';
  if (cloud === 'ai' && complete) {
    const rules = voiceDirectory ? await readFile(join(voiceDirectory, 'rules.md'), 'utf8').catch(() => '') : '';
    const times = Boolean(asked);
    const raw = await complete(message ? replyPrompt({ thread, line, rules, signName, examples, times, word }) : newEmailPrompt({ line, rules, signName, examples, times, group, word })).catch(() => null);
    body = parseReplyBody(raw);
    if (body && message && !group.length) body = firstNameGreeting(body, String(message.from || '').replace(/<.*$/, '').replace(/^"|"$/g, '').trim(), { word: examples.length ? null : word });
    if (!message && body) { try { subject = String(parseJsonReply(raw)?.subject || '').trim().slice(0, 120); } catch { subject = ''; } }
    how = !body ? 'words-after-ai-failed' : keepsLine(line, body, asked ? { skip: lineSkip(line) } : {}) ? 'ai' : 'words-after-ai-dropped-line';
    if (how !== 'ai') { body = null; subject = ''; }
  }
  if (!body) body = typedBody(line, signName);
  const times = guardTimes(body, { thread, typed: [typed, line], calendar });
  body = times.text;
  let report = null;
  if (asked) {
    const read = availability ? await availability : null;
    const fill = fillTimes(body, read, { signName });
    const stray = read?.read === 'read' && read.days.length ? strayTimes(fill.text, read.days, { skip: fill.block, timeZone: read.window.timeZone, keep: [thread, typed, line] }) : { text: fill.text, removed: [] };
    body = stray.text;
    report = availabilityReport({ asked, availability: read, how: fill.how, guard: times, stray });
  }
  if (!message) {
    reply.subject = subject || typedSubject(line);
    await writeFile(join(taskDirectory, 'SUBJECT.txt'), `${reply.subject}\n`);
  }
  await writeFile(join(taskDirectory, 'REPLY.json'), JSON.stringify(reply, null, 2));
  await writeFile(join(taskDirectory, 'DRAFT.md'), `${body}\n`);
  return { taskDirectory, body, subject: reply.subject, how, times: { removed: times.removed, note: report ? report.note : times.note },
    ...(report ? { availability: { record: report.record, did: report.did } } : {}) };
}
