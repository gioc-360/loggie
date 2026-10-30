// The ask box's runner (loggie-ask-box). A sentence read by ask.js and a name resolved by ask-who.js become one
// action that ends in the user's own app, unsent, with one step at a time on the box's status line.
//
//   createAsker({ home (a path, or a function that returns one), loadIndex, openChat, emit, now }) -> { preview(text), run(text, { choices }), stop(askId) }
//     preview(text) -> { action, status: 'ready' | 'which' | 'none' | 'needs-words' | 'unknown' | 'other', line,
//                        who: [{ text, status, name, app, kind, key, candidates: [{ name, app, kind, key }] }], words }
//     run(text, { choices: { [whoText]: key, '@thread': threadId | 'new' }, cloud, origin }) -> { askId } now; then emit('step', { askId,
//       step, of, label }) per step, emit('draft', { askId, to, app, thread, subject, body, how }) once an email draft
//       is written (before Outlook places it; ms = since the run began), and emit('done', { askId, outcome, action, lines, did, results, ms }) once.
//       outcome: 'placed' (every message is in its box, read back), 'partly' (some placed, some not), 'clipboard',
//                'question' (a name matched two, a name matched no one, or no words), 'stopped', 'failed', 'other'
//                (not an action this runner owns: invites and file opens stay with command-service).
// Nothing here sends: openChatDraft only fills a message box (chats.js), and a chat it cannot fill gets the clipboard.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fold, readAsk } from './ask.js';
import { resolveWho, indexNames } from './ask-who.js';
import { APP_NAMES } from './chats.js';
import { prepareEmailReply } from './ask-reply.js';
import { pickThread, threadBrief, threadKey, cleanSubject } from './ask-thread.js';
import { cloudPrompt, parsePick, rewrite } from './ask-cloud.js';
import { findMeeting, readWhen } from './ask-move.js';
import { markAsk, readWords } from './wordmap.js';
import { nameIn, readSentence } from './quick-invite.js';
import { guardTimes, PLACEHOLDER, timesIn, timesInDraft } from './draft-times.js';
import { availabilityAsked, availabilityFor, availabilitySettings, readWindow, THREAD_CUE, timesWord } from './availability.js';
import { ownText } from './voice.js';

const APP_LABEL = { ...APP_NAMES, outlook: 'Outlook' };
// The mail app an email opens in (settings.json mailApp; workspaces-outlook W12): Outlook or Apple Mail.
const MAIL_LABEL = { outlook: 'Outlook', 'apple-mail': 'Mail' };
export const entryKey = (entry) => `${entry.app}:${entry.chatId || entry.email || entry.name}`;
// A "which one?" choice shows the address beside the name: two Rowena Patels, one at the bank and one at school, were
// two identical buttons (loggie-intros fix 1, 2026-10-20). The email, else the chat's handle; a group has none.
const addressOf = (entry) => String(entry?.email || (entry?.kind === 'group' ? '' : entry?.address) || '');
export const choiceLabel = (entry) => (addressOf(entry) ? `${entry.name} <${addressOf(entry)}>` : entry.name);
const brief = (entry) => entry && { name: entry.name, app: entry.app, kind: entry.kind, key: entryKey(entry), last: entry.last || '', address: addressOf(entry), label: choiceLabel(entry) };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no recent message');
export const OWNED = Object.freeze(['message', 'reply', 'said', 'move']);
const VERB = { message: 'Message', reply: 'Reply to' };
const PLACED_MODES = ['reply', 'new-message', 'already-open'];
// What the helper read back in the reply window for the user to fix before Send (draft.js: "Check before sending:
// ..."). The sentence about focus is about the user's own window, not the email, and is left out. Until 2026-10-22
// these notes went only to ATTEMPTS.jsonl: the row said "ready to send" over a reply with no sign-off.
export const checkOf = (opened = {}) => String((/Check before sending: ([\s\S]*)$/.exec(String(opened.detail || '')) || [])[1] || '')
  .split(/(?<=\.)\s+/).filter((sentence) => sentence.trim() && !/^Focus stayed/.test(sentence)).join(' ').trim();
// A chat draft is the user's own words; the time guard (draft-times.js) still runs on it, so every draft the box
// places passes the same rule. It keeps whatever the sentence typed.
const chatBody = (ask) => guardTimes(ask.words, { typed: [ask.original, ask.words] }).text;
// Several people who all have an email address are one new email to all of them ("email rhonda, danielle, noah about
// the invoice", 2026-10-21, stopped at "one person at a time"). It is never a reply in one person's thread: that
// thread's other people would get it, and the ones named but not on it would not.
const allByEmail = (who) => who.length > 1 && who.every((item) => item.pick?.app === 'outlook' && item.pick.email);
const MANY_VIEW = { id: null, subject: '', at: null, how: 'many', why: 'one new email to all of them', matched: [], others: [] };

// Each name in the sentence, resolved; a choice the user made ("which Lena?") wins over the resolver.
function resolveAll(ask, entries, choices = {}) {
  return ask.who.map((text) => {
    const chosen = choices[text] && entries.find((entry) => entryKey(entry) === choices[text]);
    if (chosen) return { text, status: 'one', pick: chosen };
    return { text, ...resolveWho(text, entries, { app: ask.app, action: ask.action }) };
  });
}

// The plain line under the box while typing, from the reading alone.
export const CHATS_OFF = 'Loggie is not reading Messages or WhatsApp yet, so it cannot find who to text. Turn chats on in Settings, under "Set up Loggie on this Mac", then ask again.';
export function previewLine(ask, who) {
  if (ask.action === 'unknown') return { status: 'unknown', line: '' };
  if (!OWNED.includes(ask.action)) return { status: 'other', line: '' };
  // A move names people only to find the meeting among its attendees (ask-move.js), not to reach them.
  if (ask.action === 'move') {
    if (!ask.when) return { status: 'needs-words', line: 'Move it to when?' };
    return { status: 'ready', line: `Move ${ask.meeting || 'the meeting'} to ${ask.when} · Outlook` };
  }
  const many = who.find((item) => item.status === 'many');
  if (many) return { status: 'which', line: many.twins
    ? `${many.candidates.length} ${many.candidates[0].app === 'outlook' ? 'people' : 'chats'} are called ${many.candidates[0].name} in ${APP_LABEL[many.candidates[0].app]}. Which one? ${many.candidates.map((c) => `${choiceLabel(c)}, last message ${day(c.last)}`).join(' or ')}`
    : `Which ${many.text}? ${many.candidates.map(choiceLabel).join(' or ')}` };
  const none = who.find((item) => item.status === 'none');
  if (none) {
    const where = none.reason === 'app' ? `in ${APP_LABEL[ask.app] || ask.app}` : ['reply', 'said'].includes(ask.action) ? 'in your mail, Messages or WhatsApp' : 'in Messages or WhatsApp';
    return { status: 'none', line: `No one called "${none.text}" ${where}` };
  }
  if (ask.action === 'said') {
    const apps = (item) => [...new Set((item.picks || [item.pick]).map((entry) => APP_LABEL[entry.app]))].join(', ');
    return { status: 'ready', line: `See what ${who.map((item) => `${item.pick.name} (${apps(item)})`).join(' and ')} said` };
  }
  if (ask.action === 'reply' && who.length > 1 && !allByEmail(who)) return { status: 'none', line: 'A reply in a chat goes to one person at a time. Name one, say "email" to write them all one email, or "text" to message several.' };
  const to = who.map((item) => `${item.pick.name} · ${APP_LABEL[item.pick.app]}`).join(', ');
  if (!ask.words) return { status: 'needs-words', line: `${VERB[ask.action]} ${to}: what should it say?` };
  const how = who.length < 2 ? '' : ask.action === 'reply' ? ' (one email to all)' : ask.separate ? ' (a draft for each)' : ' (one group message)';
  return { status: 'ready', line: `${VERB[ask.action]} ${to}${how}` };
}

// When an invite will be, in the box's words: "Tue, Oct 13, 5:30 PM to 6:30 PM", "Tue, Oct 13, first free time",
// "First time free for everyone", and how it repeats.
export function whenLabel(plan) {
  const repeat = plan.repeat ? ` · repeats ${plan.every > 1 ? `every ${plan.every} ` : ''}${plan.on?.length ? `on ${plan.on.join(', ')}` : plan.repeat}${plan.until ? ` until ${plan.until}` : plan.times ? `, ${plan.times} times` : ''}` : '';
  const length = plan.minutes !== 60 ? ` · ${plan.minutes >= 60 ? `${plan.minutes / 60} h` : `${plan.minutes} min`}` : '';
  if (plan.start) {
    const [h, m] = plan.end.split(':').map(Number);
    const end = new Date(plan.start); end.setHours(h, m);
    return `${plan.start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} to ${end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${repeat}`;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const said = plan.lookDays === 1 || (plan.day && plan.day.getTime() !== today.getTime());
  return `${said ? `${plan.day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, first free time` : 'First time free for everyone'}${length}${repeat}`;
}

// `email` is what an email reply needs from the app (all injected, so tests run the real code with fakes):
//   threads(address) -> the person's email threads, newest first (ask-thread.js threadsFrom, with bodies); the
//   ask picks one (pickThread) or takes the user's pick, choices['@thread']; consent() -> true when the user said
//   "always" for the box's cloud AI; allowAlways() saves that; complete(prompt) -> the cloud AI's answer;
//   openDraft({ taskDirectory }) -> draft.js openDraft's result; settings() -> { signName, account, voiceDirectory };
//   sent(address) (optional) -> the user's own emails to that person, 60 days, quotes cut: [{ id, subject, timestamp,
//   body }]. They give the reply its history (the user's side of the thread) and the way the user writes to them.
// `readLatest(entry)` -> the newest messages in that chat or from that email sender, oldest first:
//   [{ from, fromMe, text, at }]; code only, nothing leaves the Mac.
// `think` reads a sentence code could not: consent() -> the saved "always" for sentences; allowAlways(); complete(prompt,
//   { once }) -> the cloud AI's answer. Only the sentence goes, after the user's yes (ask-cloud.js).
// `calendar` moves a meeting: list() -> upcoming events (calendar.js shape); move({ title, from, to }) -> the Outlook
//   helper's result ({ status: 'moved' | ..., detail, after }); discard({ title }) undoes a move left unsent.
// `clearChat({ app, text, folder })` undoes a chat draft: clears the box only if it still holds exactly `text`.
// `invite` lets the box show an invite as it is typed: people() -> the invite reader's people ({ name, address, count,
//   last }), places() -> places the user has used (optional). Invites still run through command-service.
// A question about the user's own mail or calendar ("what's on my calendar Thursday?", "summarize Sarah's emails this
// week"): asked as a question, it goes to the assistant (desktop/assistant-service.js) rather than to the cloud reading
// of a sentence, which only picks one of the box's actions. Anything else code cannot read goes to that reading as before.
// The ui-acts `box` row for one finished ask: counts and words about what happened, never the words or names. An email
// adds how its thread was picked, whether the cloud draft kept the line and how soon the card showed it; an
// availability ask adds what happened to its times (filled, none-free, unreadable, empty).
export function boxActRow(data, { draftMs = null, at = new Date().toISOString() } = {}) {
  const results = data.results || [];
  const mailed = results.find((r) => r.thread);
  const record = results.find((r) => r.availability)?.availability;
  return { at, act: 'box', name: null, action: data.action, outcome: data.outcome, path: data.path || 'code', placed: results.filter((r) => r.outcome === 'placed').length, to: results.length, apps: [...new Set(results.map((r) => r.app))], ms: data.ms,
    ...(mailed ? { thread: mailed.thread.how, drafted: mailed.drafted, draftMs } : {}), ...(record ? { times: timesWord(record) } : {}), from: 'main' };
}

export const QUESTION = /\?\s*$|^(?:what|what's|whats|when|where|who|whom|which|how|why|did|do|does|is|are|was|were|has|have|had|any|am i|summari[sz]e|recap|catch me up|prepare me|prep me|brief me|tell me about)\b/i;

export function createAsker({ home, loadIndex, openChat, chatsOff = async () => false, email = null, readLatest = null, think = null, calendar = null, clearChat = null, invite = null, assistant = null, emit = () => {}, now = () => Date.now() }) {
  const live = new Map();
  // What each ask placed, for Undo: { askId: [{ kind: 'chat', app, text } | { kind: 'move', title } | { kind: 'reply' }] }.
  const placedBy = new Map();
  // Drafts held before the mail app because they still say PLACEHOLDER (loggie-reply-yes): { askId: { taskDirectory,
  // to, mailApp, kind } }, until fill() puts the user's time in and opens it.
  const heldBy = new Map();
  // Every email draft a run wrote, so a draft that did not open (Outlook on the Calendar, a helper stop) opens again
  // as it is, with again(askId), never a second draft.
  const draftsBy = new Map();
  // Who started each run, when it was not the ask box (run's `origin`); every event of that run carries it.
  const origins = new Map();
  const tell = (kind, data) => {
    const origin = origins.get(data.askId);
    if (kind === 'done') origins.delete(data.askId);
    emit(kind, origin ? { ...data, origin } : data);
  };
  const homeOf = () => (typeof home === 'function' ? home() : home);

  // A person's threads, kept a minute: the box previews on every pause in typing, and the run that follows reuses
  // the read it already showed (about 0.1 s for one person's 60 days).
  const threadCache = new Map();
  async function threadsOf(address) {
    const hit = threadCache.get(address);
    if (hit && now() - hit.at < 60000) return hit.threads;
    const threads = await email.threads(address);
    threadCache.set(address, { at: now(), threads });
    return threads;
  }
  // The thread an email ask answers: the user's pick from the box ('new' = a new email), else pickThread's.
  async function threadFor(entry, line, choices = {}) {
    const threads = await threadsOf(entry.email);
    const chosen = choices['@thread'];
    if (chosen === 'new') return { thread: null, how: 'chosen-new', matched: [], others: threads };
    const picked = chosen && threads.find((t) => t.id === chosen);
    if (picked) return { thread: picked, how: 'chosen', matched: [], others: threads.filter((t) => t !== picked) };
    return pickThread(line, threads);
  }
  // Said in the card and in "What I did": why this thread.
  const WHY = {
    only: 'your only thread with them', newest: 'their newest email', 'not-cc': 'their newest email to you (a newer one only copied you)',
    words: 'your words are in it', chosen: 'you picked it', many: MANY_VIEW.why, none: 'no email with them in 60 days, so a new email', 'chosen-new': 'you picked a new email',
  };
  const threadView = (pick) => ({ ...threadBrief(pick.thread), how: pick.how, why: WHY[pick.how] || '', matched: pick.matched, others: pick.others.map(threadBrief) });

  async function read(text, choices) {
    const entries = await loadIndex();
    const ask = readAsk(text, { names: indexNames(entries) });
    return { ask, entries, who: resolveAll(ask, entries, choices) };
  }

  // The invite reader's people, kept for half a minute: the box asks on every pause in typing.
  let peopleCache = { at: 0, list: [], places: [] };
  async function invitePeople() {
    if (!invite) return { list: [], places: [] };
    if (now() - peopleCache.at > 30000) peopleCache = { at: now(), list: await invite.people().catch(() => []), places: invite.places ? await invite.places().catch(() => []) : [] };
    return peopleCache;
  }

  // An invite as the box shows it while typing: every word's role (marks), and the slots the invite will get. A
  // sentence the reader cannot finish ("Sam" is two people, no one named) is a question with the marks still drawn.
  async function invitePreview(text) {
    const { list, places } = await invitePeople();
    try {
      const plan = readSentence(text, { people: list, now: new Date(now()), places });
      return {
        action: 'invite', status: 'ready', line: '', app: plan.calendar, marks: plan.words,
        invite: {
          who: plan.people.map((p) => ({ name: p.name, address: p.address, alternates: p.alternates || [] })),
          when: whenLabel(plan), timeGiven: plan.timeGiven, where: plan.place || plan.room?.query || '', room: Boolean(plan.room),
          title: plan.title, titleSaid: plan.words.some((w) => w.role === 'about'), leftOut: plan.leftOut, repeat: plan.repeat || '',
        },
        who: [],
      };
    } catch (error) {
      const map = readWords(text, { action: 'invite', isName: nameIn(list), places });
      return {
        action: 'invite', status: 'question', line: error.message, app: map.app === 'google' ? 'google' : 'outlook', marks: map.words,
        invite: { who: [], when: '', timeGiven: false, where: map.where, title: map.quote || map.about, titleSaid: Boolean(map.quote || map.about), leftOut: map.unused, repeat: '' },
        who: [],
      };
    }
  }

  // "No one called X" is only true when the chats were read. With Messages and WhatsApp off in Settings the index
  // holds no chats at all (2026-10-22: "message leah nakaima" said no one, and she is in Contacts), so the line says
  // why instead of blaming the name.
  async function lineFor(ask, who) {
    const said = previewLine(ask, who);
    const unread = said.status === 'none' && who.some((item) => item.status === 'none') && ask.action !== 'reply' && await chatsOff().catch(() => false);
    return unread ? { status: 'none', line: CHATS_OFF } : said;
  }
  async function preview(text) {
    const { ask, who } = await read(text);
    if (ask.action === 'invite') return invitePreview(text);
    const { status, line } = await lineFor(ask, who);
    // An email ask shows the thread it will answer before Enter, so the user can switch it in the box.
    const many = status === 'ready' && ask.action === 'reply' && allByEmail(who);
    const pick = !many && status === 'ready' && ask.action === 'reply' && who[0]?.pick?.app === 'outlook' && email?.threads
      ? await threadFor(who[0].pick, ask.words).catch(() => null) : null;
    return {
      ...(many ? { thread: MANY_VIEW } : pick ? { thread: threadView(pick) } : {}),
      action: ask.action, status, line, words: ask.words, app: ask.app, separate: Boolean(ask.separate), marks: markAsk(text, ask),
      who: who.map((item) => ({ text: item.text, status: item.status, ...(item.pick ? brief(item.pick) : {}), subject: item.pick?.subject || '', candidates: (item.candidates || []).map(brief), twins: Boolean(item.twins) })),
    };
  }

  // Several people in one message are one conversation: the group chat with exactly them. Messages opens it from
  // their handles in one link (Messages files it under the existing group, or starts one); WhatsApp needs a group
  // that already holds exactly them. Returns the target, or { why } when they cannot share one chat.
  function groupTarget(who, entries, app) {
    if (who.some((item) => item.pick.kind === 'group')) return { why: 'one of them is already a group' };
    const people = who.map((item) => item.picks || [item.pick]);
    const inApp = (name) => people.map((list) => list.find((entry) => entry.app === name));
    const names = who.map((item) => item.pick.name);
    const messages = inApp('messages');
    if ((!app || app === 'messages') && messages.every((entry) => entry?.address)) {
      return { app: 'messages', reply: { app: 'messages', address: messages.map((entry) => entry.address), to: names.join(', '), isGroup: false }, label: names.join(', ') };
    }
    if (!app || app === 'whatsapp') {
      const firsts = new Set(names.map((name) => fold(name).split(' ')[0]));
      const group = entries.find((entry) => entry.app === 'whatsapp' && entry.kind === 'group' && entry.members?.length === firsts.size + 1
        && [...firsts].every((first) => entry.members.some((member) => fold(member.name).split(' ')[0] === first)));
      if (group) return { app: 'whatsapp', reply: { app: 'whatsapp', chatId: group.chatId, address: null, to: group.name, isGroup: true }, label: group.name };
    }
    return { why: app === 'whatsapp' ? 'WhatsApp has no group with exactly them, and Loggie cannot start one' : 'not all of them have a Messages chat Loggie can open' };
  }

  async function together({ askId, ask, who, entries, did, step }) {
    step(1, 2, 'Finding a chat with all of them');
    const target = groupTarget(who, entries, ask.app);
    if (target.why) {
      did.push(`One message to all of them was not possible (${target.why}), so each gets their own draft`);
      return message({ askId, ask, who, did, step });
    }
    did.push(`One message to ${target.label} in ${APP_LABEL[target.app]}`);
    if (live.get(askId)?.stopped) return [];
    step(2, 2, `Typing your message to ${target.label}`);
    const taskDirectory = join(homeOf(), 'asks', askId);
    let attempt;
    try { await mkdir(taskDirectory, { recursive: true }); attempt = await openChat({ taskDirectory, thread: '', reply: target.reply, body: chatBody(ask) }); }
    catch (error) { attempt = { opened: 'none', mode: 'failed', detail: `Loggie could not check the chat (${error.code || error.message}). Look in ${APP_LABEL[target.app]}: the words may already be in the box.` }; }
    const placed = attempt.mode === 'chat' && attempt.status === 'drafted';
    did.push(placed ? `Typed it into the chat with ${target.label} in ${APP_LABEL[target.app]}, unsent` : attempt.detail || 'Nothing was opened');
    return [{ to: target.label, app: target.app, kind: 'group', outcome: placed ? 'placed' : attempt.mode === 'clipboard' ? 'clipboard' : 'failed', detail: attempt.detail || '', ...(placed ? { undo: { kind: 'chat', app: target.app, text: ask.words } } : {}) }];
  }

  async function message({ askId, ask, who, did, step }) {
    const results = [];
    const total = who.length * 2;
    let index = 0;
    for (const item of who) {
      if (live.get(askId)?.stopped) break;
      const entry = item.pick;
      step(++index, total, `Finding your chat with ${entry.name}`);
      did.push(`Matched "${item.text}" to ${entry.name} in ${APP_LABEL[entry.app]}${entry.kind === 'group' ? ' (group)' : ''}`);
      if (live.get(askId)?.stopped) break;
      step(++index, total, `Typing your message to ${entry.name}`);
      const taskDirectory = join(homeOf(), 'asks', askId);
      const reply = { app: entry.app, chatId: entry.chatId, address: entry.address, to: entry.name, isGroup: entry.isGroup };
      let attempt;
      // openChatDraft keeps the words in a file in this folder while it reads the chat box back (2026-10-11: the
      // folder did not exist, so the read-back threw after Messages had already opened with the words).
      try { await mkdir(taskDirectory, { recursive: true }); attempt = await openChat({ taskDirectory, thread: '', reply, body: chatBody(ask) }); }
      catch (error) { attempt = { opened: 'none', mode: 'failed', detail: `Loggie could not check the chat (${error.code || error.message}). Look in ${APP_LABEL[entry.app]}: the words may already be in the box.` }; }
      const placed = attempt.mode === 'chat' && attempt.status === 'drafted';
      did.push(placed ? `Typed it into ${entry.name}'s chat in ${APP_LABEL[entry.app]}, unsent` : attempt.detail || 'Nothing was opened');
      results.push({ to: entry.name, app: entry.app, kind: entry.kind, outcome: placed ? 'placed' : attempt.mode === 'clipboard' ? 'clipboard' : 'failed', detail: attempt.detail || '', ...(placed ? { undo: { kind: 'chat', app: entry.app, text: ask.words } } : {}) });
    }
    return results;
  }

  // An email: the thread the words point at (or the user's pick, or a new email), the draft written (the user's
  // words, or the cloud AI from the line after the user's yes), shown in the card at once, then opened in Outlook
  // unsent. Several people (allByEmail) get one new email, To all of them.
  async function replyByEmail({ askId, ask, items, did, step, cloud, choices, started }) {
    const entry = items[0].pick;
    const group = items.length > 1 ? items.map((item) => item.pick) : [];
    const names = items.map((item) => item.pick.name).join(', ');
    const mode = cloud === 'words' ? 'words' : 'ai';
    const total = mode === 'ai' ? 3 : 2;
    step(1, total, group.length ? `Starting one email to ${names}` : `Finding the thread with ${entry.name}`);
    const pick = group.length ? { thread: null, how: 'many', matched: [], others: [] } : await threadFor(entry, ask.words, choices);
    const message = pick.thread?.target || null;
    did.push(message ? `Answering "${pick.thread.subject}", ${day(pick.thread.at)}: ${WHY[pick.how]}` : `A new email to ${names}: ${WHY[pick.how]}`);
    if (live.get(askId)?.stopped) return [];
    const { signName = '', account = '', voiceDirectory = null, mailApp = 'outlook' } = await email.settings();
    const mailLabel = MAIL_LABEL[mailApp] || 'Outlook';
    if (mode === 'ai') step(2, total, message ? 'Writing the reply' : 'Writing the email');
    const taskDirectory = join(homeOf(), 'asks', askId);
    // The user's side: their sent emails to this person, read only when the cloud AI writes (code alone never needs them).
    const sent = mode === 'ai' && email.sent && !group.length ? await email.sent(entry.email).catch(() => []) : [];
    const newestFirst = [...sent].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    // An availability ask (availability.js): the calendar read starts now and runs while the cloud AI writes; the
    // times go into the draft after the model answers. Only when the app gave the calendar readers.
    const answered = ownText(message?.body || '');
    const asked = typeof email.events === 'function' ? availabilityAsked({ typed: ask.original || '', line: ask.words, email: answered }) : null;
    let reading = null;
    if (asked) {
      const rules = email.availability ? await email.availability().catch(() => availabilitySettings({})) : availabilitySettings({});
      const window = readWindow({ typed: ask.original || '', email: answered, emailAt: message?.timestamp || null, now: new Date(now()), settings: rules });
      reading = availabilityFor({ window, settings: rules, eventsImpl: email.events, statusImpl: email.status || (async () => 'unknown'), now: new Date(now()) });
    }
    const history = message ? [...(pick.thread.messages || []), ...sent.filter((item) => threadKey(item.subject) === pick.thread.key).map((item) => ({ ...item, fromMe: true }))] : [];
    // How the user greets people, from their own sent mail (main-ask.js greeting): "Hi", never the sender's form.
    const word = mode === 'ai' && email.greeting ? await email.greeting().catch(() => 'Hi') : 'Hi';
    const prepared = await prepareEmailReply({ word, taskDirectory, message, email: group.length ? group.map((person) => person.email).join(', ') : entry.email, group: group.map((person) => person.name), account, line: ask.words, typed: ask.original || '', cloud: mode, complete: mode === 'ai' ? (prompt) => email.complete(prompt, { once: cloud === 'once' }) : null, signName, voiceDirectory, history, examples: newestFirst, asked, availability: reading });
    did.push({
      ai: message ? 'The cloud AI wrote the reply from your line (it saw this one email and your line)' : 'The cloud AI wrote the email from your line (it saw only your line)',
      words: 'Used your words as typed; nothing went to the cloud',
      'words-after-ai-failed': 'The cloud AI did not answer, so your words were used as typed',
      'words-after-ai-dropped-line': 'The cloud AI\'s draft left out what your line says, so your words were used as typed',
    }[prepared.how]);
    // A time or date the draft stated that Loggie never read came out for "[your times]" (draft-times.js); an
    // availability ask says what it read and wrote instead (availability.js availabilityReport).
    if (prepared.availability) did.push(...prepared.availability.did);
    else if (prepared.times?.note) did.push(`Took out ${prepared.times.removed.map((text) => `"${text}"`).join(', ')}: ${prepared.times.note}`);
    // The card shows the draft now; the mail app takes its time behind it.
    tell('draft', { askId, to: names, app: mailApp, thread: threadView(pick), subject: prepared.subject, body: prepared.body, how: prepared.how, ms: now() - started });
    if (live.get(askId)?.stopped) return [];
    // A draft never reaches the mail app with a gap in it (loggie-reply-yes): one that still says PLACEHOLDER is held
    // here, and fill() puts the user's time in by code, then opens it. Nothing is pasted until then.
    if (timesInDraft(prepared.body)) {
      const kind = message ? 'reply' : 'new email';
      heldBy.set(askId, { taskDirectory, to: names, mailApp, kind, message: Boolean(message) });
      const first = String(entry.name || '').split(/\s+/)[0] || 'They';
      const asked = message && (THREAD_CUE.test(answered) || timesIn(answered).length > 0 || /\b(available|availability|time|when)\b/i.test(answered));
      did.push(`Held before ${mailLabel}: the draft still needs a time`);
      return [{ to: names, app: mailApp, kind: 'person', outcome: 'held', detail: asked ? `${first} asked about a time and Loggie could not tell which. Which time works?` : 'The draft needs a time Loggie could not find. Which time works?', body: prepared.body, thread: threadView(pick), drafted: prepared.how,
        ...(prepared.times?.note ? { note: prepared.times.note } : {}), ...(prepared.availability ? { availability: prepared.availability.record } : {}) }];
    }
    step(total, total, `Opening it in ${mailLabel}`);
    draftsBy.set(askId, { taskDirectory, to: names, mailApp, kind: message ? 'reply' : 'new email' });
    let opened;
    try {
      opened = await email.openDraft({ taskDirectory });
      // The freshness guard (draft.js) stops a reply when the person wrote later in any thread. This ask weighed every
      // thread with them, so a later email in one of those is a thread it passed over on purpose (a Cc-only one, or
      // one the words did not name): go ahead, and say so. Mail it never weighed (the user's own sent mail, a thread
      // newer than its read) still stops it. (2026-10-12: a professor's Cc-only email stopped the reply the user meant.)
      const weighed = new Set([pick.thread, ...pick.others].filter(Boolean).map((t) => t.key));
      if (message && opened.mode === 'stale' && opened.newer?.direction === 'from-person' && weighed.has(threadKey(opened.newer.subject))) {
        did.push(`${entry.name} wrote later in "${cleanSubject(opened.newer.subject)}", a thread this ask weighed and passed over, so it went ahead`);
        opened = await email.openDraft({ taskDirectory, staleOk: true });
      }
    } catch (error) { opened = { opened: 'none', mode: 'failed', reason: error.message }; }
    const placed = opened.opened !== 'none' && PLACED_MODES.includes(opened.mode);
    const kind = message ? 'reply' : 'new email';
    const placedIn = MAIL_LABEL[opened.opened] || mailLabel;
    did.push(placed ? `Opened the ${kind} in ${placedIn}, unsent` : opened.reason || opened.detail || 'Nothing was opened');
    return [{ to: names, app: opened.opened in MAIL_LABEL ? opened.opened : mailApp, kind: 'person', outcome: placed ? 'placed' : opened.mode === 'clipboard' ? 'clipboard' : 'failed', detail: opened.reason || opened.detail || '', body: prepared.body, thread: threadView(pick), drafted: prepared.how,
      ...(placed && checkOf(opened) ? { check: checkOf(opened) } : {}), ...(prepared.times?.note ? { note: prepared.times.note } : {}), ...(prepared.availability ? { availability: prepared.availability.record } : {}), ...(placed ? { undo: { kind: 'reply', app: placedIn } } : {}) }];
  }

  // "what did gideon say": the newest messages from each place the person writes, read by code, shown in the card.
  async function saidBy({ askId, who, did, step }) {
    const places = who.flatMap((item) => (item.picks || [item.pick]).filter((entry) => entry.kind === item.pick.kind));
    const results = [];
    let n = 0;
    for (const entry of places) {
      if (live.get(askId)?.stopped) break;
      step(++n, places.length, entry.app === 'outlook' ? `Reading ${entry.name}'s email` : `Reading your ${APP_LABEL[entry.app]} chat with ${entry.name}`);
      let messages = [];
      try { messages = readLatest ? await readLatest(entry) : []; }
      catch (error) { did.push(`${APP_LABEL[entry.app]} could not be read: ${error.message}`); }
      did.push(`Read ${messages.length} recent message${messages.length === 1 ? '' : 's'} in ${APP_LABEL[entry.app]} (${entry.name})`);
      if (messages.length) results.push({ to: entry.name, app: entry.app, kind: entry.kind, outcome: 'answered', messages: messages.slice(-3) });
    }
    return results;
  }

  // "move my 3pm with jamie to friday": the meeting from the calendar (two that fit are a question), the new day and
  // start, then Outlook's own event window moves it and stops before Send.
  async function moveMeeting({ askId, ask, choices, did, step }) {
    step(1, 2, 'Finding the meeting');
    const events = await calendar.list();
    const chosen = choices.meeting && events.find((event) => event.id === choices.meeting);
    const found = chosen ? { status: 'one', event: chosen } : findMeeting(events, { who: ask.who, meeting: ask.meeting, now: new Date(now()) });
    const label = (event) => `${event.title} · ${new Date(event.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    if (found.status === 'none') return { question: `No upcoming meeting matches "${ask.meeting}". Say its title, or who it is with.` };
    if (found.status === 'many') return { question: 'Which meeting?', who: [{ text: 'meeting', status: 'many', candidates: found.candidates.map((event) => ({ name: label(event), app: 'outlook', kind: 'meeting', key: event.id, last: event.start })) }] };
    const event = found.event;
    const target = readWhen(ask.when, { now: new Date(now()), event });
    if (!target.start) return { question: `Move "${event.title}" to what time?` };
    if (target.start.getMinutes() % 30) return { question: `Outlook starts meetings on the hour or half hour. Move "${event.title}" to ${target.start.getHours()}:00 or ${target.start.getHours()}:30?` };
    did.push(`Found "${label(event)}" on your calendar`);
    if (live.get(askId)?.stopped) return { results: [] };
    step(2, 2, `Moving it in Outlook to ${target.start.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
    const moved = await calendar.move({ title: event.title, from: new Date(event.start), to: target.start });
    did.push(moved.status === 'moved' ? `Moved it in its Outlook window (${moved.after || ''}), unsent` : moved.detail || moved.status);
    return { results: [{ to: event.title, app: 'outlook', kind: 'meeting', outcome: moved.status === 'moved' ? 'placed' : 'failed', detail: moved.detail || '', ...(moved.status === 'moved' ? { undo: { kind: 'move', title: event.title } } : {}) }] };
  }

  async function execute(askId, text, choices, cloud) {
    const started = now();
    const did = [];
    const step = (n, of, label) => tell('step', { askId, step: n, of, label });
    const finish = async (fields) => {
      const undos = (fields.results || []).map((r) => r.undo).filter(Boolean);
      if (undos.length) placedBy.set(askId, undos);
      const done = { askId, did, ms: now() - started, ...fields, undoable: undos.some((u) => u.kind !== 'reply') };
      live.delete(askId);
      await mkdir(join(homeOf(), 'asks', askId), { recursive: true }).catch(() => {});
      await writeFile(join(homeOf(), 'asks', askId, 'ASK.json'), JSON.stringify({ at: new Date(started).toISOString(), text, ...done }, null, 2)).catch(() => {});
      tell('done', done);
      return done;
    };
    try {
      const { ask, who, entries } = await read(text, choices);
      // A question code cannot turn into an action: the assistant answers it from the user's mail and calendar, after a
      // yes for this question or for all of them (cloud-screen.js consentFor 'assistant'). It never sends, deletes or
      // creates anything; the answer comes back with the emails and events it used.
      if (ask.action === 'unknown' && assistant && QUESTION.test(text.trim())) {
        if (!cloud && !(await assistant.consent())) {
          return finish({ outcome: 'question', action: 'question', status: 'needs-yes', yesFor: 'question', lines: ['Loggie answers this from your email and calendar: the emails and events that match go to the cloud AI, screened on this Mac first. Nothing is sent, deleted or created.'] });
        }
        if (cloud === 'always') await assistant.allowAlways();
        step(1, 1, 'Reading your email and calendar');
        let answer;
        try { answer = await assistant.ask(text, { once: cloud === 'once' }); } catch (error) { answer = { status: 'failed', message: error.message }; }
        if (answer.status === 'answered') return finish({ outcome: 'answered', action: 'question', path: 'cloud', lines: [answer.message], sources: answer.sources || [] });
        if (answer.status === 'clarify') return finish({ outcome: 'question', action: 'question', status: 'clarify', path: 'cloud', lines: [answer.message] });
        return finish({ outcome: 'failed', action: 'question', path: 'cloud', lines: [answer.message || 'The answer did not come back. Nothing was changed.'] });
      }
      // Code could not read it: with the user's yes, the cloud AI reads only this sentence and picks an action, and
      // the user confirms the reading before anything runs.
      if (ask.action === 'unknown' && think) {
        if (!cloud && !(await think.consent())) {
          return finish({ outcome: 'question', action: 'unknown', status: 'needs-yes', yesFor: 'sentence', lines: ['Loggie\'s code could not read this. Send only this sentence to the cloud AI to read it? Your messages and mail stay on this Mac.'] });
        }
        if (cloud === 'always') await think.allowAlways();
        step(1, 1, 'Reading your sentence');
        const raw = await think.complete(cloudPrompt(text), { once: cloud === 'once' }).catch((error) => { did.push(`The cloud AI did not answer: ${error.message}`); return null; });
        const pick = raw && parsePick(raw, text);
        if (!pick) return finish({ outcome: 'failed', action: 'unknown', path: 'cloud', lines: ['Even the cloud AI could not tell what to do. Try starting with "text", "reply to", "what did", or "invite".'] });
        const reading = rewrite(pick);
        did.push(`The cloud AI read it as: ${reading}`);
        return finish({ outcome: 'question', action: pick.action, status: 'did-you-mean', path: 'cloud', rewrite: reading, lines: [reading] });
      }
      if (!OWNED.includes(ask.action)) return finish({ outcome: 'other', action: ask.action, lines: [] });
      if (ask.action === 'move' && ask.when) {
        if (!calendar) return finish({ outcome: 'failed', action: 'move', lines: ['Moving meetings is not set up in this copy of Loggie.'] });
        const moved = await moveMeeting({ askId, ask, choices, did, step });
        if (moved.question) return finish({ outcome: 'question', action: 'move', status: moved.who ? 'which' : 'none', lines: [moved.question], who: moved.who || [] });
        const ok = moved.results[0]?.outcome === 'placed';
        return finish({ outcome: live.get(askId)?.stopped && !moved.results.length ? 'stopped' : ok ? 'placed' : 'failed', action: 'move', results: moved.results,
          lines: moved.results.map((r) => (r.outcome === 'placed' ? `Moved in Outlook: ${r.to}. Press Send there to tell everyone.` : `${r.to}: ${r.detail}`)), words: '' });
      }
      const { status, line } = await lineFor(ask, who);
      if (status !== 'ready') {
        return finish({ outcome: 'question', action: ask.action, status, lines: [line], who: who.map((item) => ({ text: item.text, status: item.status, candidates: (item.candidates || []).map(brief), twins: Boolean(item.twins) })) });
      }
      if (ask.action === 'said') {
        const results = await saidBy({ askId, who, did, step });
        const stopped = live.get(askId)?.stopped || false;
        const newest = results.flatMap((r) => r.messages).map((m) => m.at).sort().at(-1);
        // Newest place first: where they last wrote is what the user asked.
        results.sort((a, b) => String(b.messages.at(-1)?.at).localeCompare(String(a.messages.at(-1)?.at)));
        return finish({ outcome: stopped ? 'stopped' : results.length ? 'answered' : 'failed', action: 'said', results,
          lines: results.length ? [`Last from ${who.map((item) => item.pick.name).join(' and ')}: ${day(newest)}`] : [`Nothing from ${who.map((item) => item.pick.name).join(' and ')} in the last while.`] });
      }
      const byEmail = ask.action === 'reply' && (who.length === 1 ? who[0].pick.app === 'outlook' : allByEmail(who));
      if (byEmail && !email) return finish({ outcome: 'failed', action: ask.action, lines: ['Email replies are not set up in this copy of Loggie.'] });
      if (byEmail && !cloud && !(await email.consent())) {
        return finish({ outcome: 'question', action: ask.action, status: 'needs-yes', lines: [who.length > 1 ? `To write it, Loggie's cloud AI would read your line and the names it goes to. Nothing else leaves this Mac.` : `To write it, Loggie's cloud AI would read the one email from ${who[0].pick.name} you are answering, and your line. Nothing else leaves this Mac.`], to: who.map((item) => item.pick.name).join(', ') });
      }
      if (byEmail && cloud === 'always') await email.allowAlways();
      const results = byEmail ? await replyByEmail({ askId, ask, items: who, did, step, cloud, choices, started })
        : who.length > 1 && !ask.separate ? await together({ askId, ask, who, entries, did, step })
        : await message({ askId, ask, who, did, step });
      const stopped = live.get(askId)?.stopped || false;
      const held = results.find((r) => r.outcome === 'held');
      if (held && !stopped) return finish({ outcome: 'question', action: ask.action, status: 'needs-time', lines: [held.detail, ...(held.note ? [held.note] : [])], results, to: held.to, words: held.body, path: byEmail && cloud !== 'words' ? 'cloud' : 'code' });
      const placed = results.filter((r) => r.outcome === 'placed');
      // One group message or one email to all stands for everyone; separate drafts count one each.
      const expected = byEmail || (results.length === 1 && results[0].kind === 'group' && who.length > 1) ? 1 : who.length;
      const outcome = stopped && results.length < expected ? 'stopped'
        : placed.length === results.length ? 'placed' : placed.length ? 'partly'
        : results.every((r) => r.outcome === 'clipboard') ? 'clipboard' : 'failed';
      const lines = results.map((r) => (r.outcome === 'placed' ? `Ready in ${APP_LABEL[r.app] || MAIL_LABEL[r.app] || r.app}: ${r.to}. You send it there.` : `${r.to}: ${r.detail}`));
      const words = byEmail ? results[0]?.body || ask.words : ask.words;
      for (const note of new Set(results.map((r) => r.note).filter(Boolean))) lines.push(note);
      if (stopped) lines.push('Stopped. Nothing after that step ran.');
      return finish({ outcome, action: ask.action, lines, results, words, path: byEmail && cloud !== 'words' ? 'cloud' : 'code' });
    } catch (error) {
      return finish({ outcome: 'failed', action: 'unknown', lines: [error.message] });
    }
  }

  // `origin` 'row': a Reply pressed on a To do move (do-it.js replyToMove), whose own row shows the yes, the progress
  // and the outcome. Every event of that run carries it, so the ask box never draws a card for a run it did not start.
  function run(text, { choices = {}, cloud = null, origin = null } = {}) {
    const askId = `${new Date(now()).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    live.set(askId, { stopped: false });
    if (origin) origins.set(askId, origin);
    const done = execute(askId, String(text || '').trim(), choices, cloud);
    return { askId, done };
  }

  // The user's time for a held draft (status 'needs-time'): it goes where the draft says PLACEHOLDER, by code, and the
  // draft opens in the mail app, unsent. "3 PM EST" after a word reads "at 3 PM EST"; a time with its own word stays.
  async function fill(askId, time) {
    const held = heldBy.get(askId);
    const said = String(time || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!held) return { askId, outcome: 'failed', action: 'reply', lines: ['This draft is no longer waiting. Press Reply again.'], did: [], results: [] };
    if (!said) return { askId, outcome: 'question', action: 'reply', status: 'needs-time', lines: ['Type the time the reply should say.'], did: [], results: [] };
    const file = join(held.taskDirectory, 'DRAFT.md');
    const draft = await readFile(file, 'utf8');
    const spoken = (before) => (/^\d/.test(said) && /[\p{L}\p{N},]\s*$/u.test(before) && !/\b(?:at|on|from|around|by|after|before|between|until|till|about)\s*$/i.test(before) ? `at ${said}` : said);
    const body = draft.split(PLACEHOLDER).reduce((out, part, index) => (index === 0 ? part : `${out}${spoken(out)}${part}`), '');
    await writeFile(file, body);
    heldBy.delete(askId);
    draftsBy.set(askId, held);
    return openKept(askId, held, body, `Put "${said}" in the draft`);
  }

  // A draft this run already wrote, opened again as it is (the user fixed what stopped it: Mail on screen in Outlook).
  async function again(askId) {
    const kept = draftsBy.get(askId);
    if (!kept) return { askId, outcome: 'failed', action: 'reply', lines: ['This draft is gone. Press Reply again.'], did: [], results: [] };
    const body = await readFile(join(kept.taskDirectory, 'DRAFT.md'), 'utf8').catch(() => '');
    return openKept(askId, kept, body, 'Opened the same draft again');
  }

  // The thread was weighed when the draft was written, so a later email in it does not stop this open (staleOk).
  async function openKept(askId, kept, body, first) {
    let opened;
    try { opened = await email.openDraft({ taskDirectory: kept.taskDirectory, staleOk: true }); } catch (error) { opened = { opened: 'none', mode: 'failed', reason: error.message }; }
    const placed = opened.opened !== 'none' && PLACED_MODES.includes(opened.mode);
    const placedIn = MAIL_LABEL[opened.opened] || MAIL_LABEL[kept.mailApp] || 'Outlook';
    const outcome = placed ? 'placed' : opened.mode === 'clipboard' ? 'clipboard' : 'failed';
    const line = placed ? `Ready in ${placedIn}: ${kept.to}. You send it there.` : `${kept.to}: ${opened.reason || opened.detail || 'Nothing was opened'}`;
    return { askId, outcome, action: 'reply', lines: [line], did: [first, placed ? `Opened the ${kept.kind} in ${placedIn}, unsent` : opened.reason || 'Nothing was opened'],
      results: [{ to: kept.to, app: opened.opened in MAIL_LABEL ? opened.opened : kept.mailApp, kind: 'person', outcome, detail: opened.reason || opened.detail || '', body,
        ...(placed && checkOf(opened) ? { check: checkOf(opened) } : {}), ...(placed ? { undo: { kind: 'reply', app: placedIn } } : {}) }], words: body };
  }

  // Undo what an ask placed: a chat box is cleared only if it still holds Loggie's words; a moved meeting's window is
  // closed with Discard Changes; an email reply is the user's to discard in Outlook (its window is not mapped yet).
  async function undo(askId) {
    const undos = placedBy.get(askId) || [];
    if (!undos.length) return { lines: ['Nothing from this ask is left to undo.'] };
    const lines = [];
    for (const item of undos) {
      if (item.kind === 'chat' && clearChat) {
        const folder = join(homeOf(), 'asks', askId);
        await mkdir(folder, { recursive: true });
        const out = await clearChat({ app: item.app, text: item.text, folder }).catch((error) => ({ status: 'error', detail: error.message }));
        lines.push(out.status === 'cleared' ? `Cleared the draft in ${APP_LABEL[item.app]}.` : out.status === 'not-ours' ? `${APP_LABEL[item.app]}'s box holds other text now, so Loggie left it.` : `${APP_LABEL[item.app]}: ${out.detail || out.status}`);
      } else if (item.kind === 'move' && calendar?.discard) {
        const out = await calendar.discard({ title: item.title });
        lines.push(out.status === 'discarded' ? `"${item.title}" is back where it was.` : out.detail || out.status);
      } else if (item.kind === 'reply') lines.push(`The reply is open in ${item.app || 'Outlook'}: press ${item.app === 'Mail' ? 'Delete' : 'Discard'} there to drop it.`);
    }
    placedBy.delete(askId);
    return { lines };
  }

  function stop(askId) {
    const run = live.get(askId);
    if (run) run.stopped = true;
    return Boolean(run);
  }

  return { preview, run, stop, undo, fill, again };
}
