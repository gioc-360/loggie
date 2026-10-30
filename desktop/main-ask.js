// The ask box: its who index, its email and invite sources, its runner and its IPC.
// Moved out of main.js in debt-cleanup 6.6.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAssistantService } from './assistant-service.js';
import { validateAskText, validateAskChoices, validateAskId, validateAskCloud, validateAvailabilityPatch } from './ipc-validation.js';
import { boxActRow, createAsker } from '../src/hikyaku/ask-run.js';
import { askAvailability, availabilityView, saveAvailability } from '../src/hikyaku/availability.js';
import { readRawSettings } from '../src/hikyaku/setup-status.js';
import { buildWhoIndex, whoPeople } from '../src/hikyaku/ask-who.js';
import { threadsFrom } from '../src/hikyaku/ask-thread.js';
import { DRAFT_MODEL, greetingWord } from '../src/hikyaku/ask-reply.js';
import { chatMessages, mailMessages } from '../src/hikyaku/ask-said.js';
import { discardMove, moveInOutlook } from '../src/hikyaku/ask-move.js';
import { listEvents } from '../src/hikyaku/calendar.js';
import { loadPeople } from '../src/hikyaku/people.js';
import { loadPlaces, placesFrom } from '../src/hikyaku/places.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { cutQuoted, readInboxMail, readMailPeople, readSentMail } from '../src/hikyaku/sent-mail.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { clearOwnDraft, openChatDraft } from '../src/hikyaku/chats.js';
import { openPane } from '../src/hikyaku/settings-panes.js';
import { commandService, hikyakuDirectory, handleSecure, inSettings } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { ownAddresses, hikyakuOpenDraft } from './main-helpers.js';
import { chatApps, readChatsNamed } from './main-catch-up.js';

// The ask box's runner and its who index (people and chats Loggie can reach), rebuilt at most every 10 minutes.
export let whoIndex = { at: 0, entries: null, building: null };
// The chats switch changed (Settings, Your Mac): the next ask builds the index again, so a person found only in
// Messages is findable at once instead of after the 10-minute cache.
export function forgetWhoIndex() { whoIndex = { at: 0, entries: null, building: null }; }
export async function loadWhoIndex({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  if (whoIndex.entries && Date.now() - whoIndex.at < maxAgeMs) return whoIndex.entries;
  if (!whoIndex.building) {
    whoIndex.building = (async () => {
      const own = await ownAddresses();
      const { apps } = await chatApps().catch(() => ({ apps: [] }));
      const [chats, inbox, mail, people] = await Promise.all([
        apps.length ? readChatsNamed({ apps, days: 365, maxChats: 600, maxMessages: 1 }).catch(() => ({})) : {},
        own[0] ? readInboxMail({ address: own, days: 60, bodies: false }).catch(() => []) : [],
        own[0] ? readMailPeople({ address: own, days: 60 }).catch(() => []) : [],
        loadPeople({ home: hikyakuDirectory() }).catch(() => []),
      ]);
      // The kept workspaces' people come first (ask-who.js whoPeople, D1): a person saved from an introduction is
      // reachable by name before any thread with them is saved.
      const workstreams = await readWorkstreams(hikyakuDirectory()).catch(() => []);
      whoIndex = { at: Date.now(), entries: buildWhoIndex({ chats, inbox, mail, people: whoPeople({ workstreams, threadPeople: people }), own }), building: null };
      return whoIndex.entries;
    })().catch((error) => { whoIndex.building = null; throw error; });
  }
  return whoIndex.building;
}
// The ask box's email reply (ask-reply.js): Outlook mail read through Apple Mail, the box's own cloud yes
// (settings.cloudYes.box), the cloud AI behind it, and the same draft opener every move uses (set when the handlers are
// registered, below).
// The reply's yes (loggie-reply-yes): replies always allowed (cloudYes.box, the same yes the ask box gives), and the
// one offer to skip the question, shown after a "Just this one" reply landed (cloudYes.boxOffered: never again).
const settingsFile = () => join(hikyakuDirectory(), 'settings.json');
export async function replyYes() {
  const raw = JSON.parse(await readFile(settingsFile(), 'utf8').catch(() => '{}'));
  return { always: raw.cloudYes?.box === true, offered: raw.cloudYes?.boxOffered === true };
}
export async function setReplyYes(what) {
  if (!['always', 'offered'].includes(what)) throw new Error('The reply yes is always or offered.');
  const raw = JSON.parse(await readFile(settingsFile(), 'utf8').catch(() => '{}'));
  raw.cloudYes = { ...(raw.cloudYes || {}), ...(what === 'always' ? { box: true } : {}), boxOffered: true };
  await writeFile(settingsFile(), `${JSON.stringify(raw, null, 2)}\n`);
  return replyYes();
}

const greetingCache = { at: 0, word: null };
export let askOpenDraft = null;

export const askEmail = {
  // The person's threads, 60 days, with bodies (ask-thread.js): the ask answers the one its words point at.
  threads: async (address) => {
    const own = await ownAddresses();
    if (!own[0]) return [];
    const mail = await readInboxMail({ address: own, days: 60, keep: (message) => String(message.from || '').toLowerCase().includes(String(address).toLowerCase()) });
    return threadsFrom(mail, address, own);
  },
  // The user's own emails to the person, 60 days, quotes cut (ask-run.js): their side of the thread and how they write.
  sent: async (address) => {
    const own = await ownAddresses();
    if (!own[0]) return [];
    const person = String(address).toLowerCase();
    // Written to them (To), not only copied: an email to someone else with them on Cc greets someone else.
    return (await readSentMail({ address: own, days: 60 })).filter((message) => (message.primary || message.to).includes(person))
      .map((message) => ({ ...message, body: cutQuoted(message.body) }));
  },
  // How the user greets people, from 60 days of their own sent mail ("Hi" for most), read at most once an hour.
  greeting: async () => {
    if (greetingCache.word && Date.now() - greetingCache.at < 60 * 60 * 1000) return greetingCache.word;
    const own = await ownAddresses();
    const word = own[0] ? greetingWord((await readSentMail({ address: own, days: 60 })).map((message) => ({ body: cutQuoted(message.body) }))) : 'Hi';
    Object.assign(greetingCache, { at: Date.now(), word });
    return word;
  },
  consent: async () => (await readSettings(hikyakuDirectory())).cloudYes?.box === true,
  allowAlways: () => setReplyYes('always'),
  // Called only after the user's yes for this reply (once or always); the text is screened like every cloud path.
  complete: async (prompt, { once = false } = {}) => {
    const settings = await readSettings(hikyakuDirectory());
    const complete = thinkWith({ settings, maxTokens: 700, consent: consentFor('box', { settings, once }), what: 'an email to reply to', path: 'box', model: DRAFT_MODEL });
    return complete ? complete(prompt) : null;
  },
  settings: async () => {
    const settings = await readSettings(hikyakuDirectory());
    return { signName: settings.signName || '', account: (await ownAddresses())[0] || '', voiceDirectory: join(hikyakuDirectory(), 'voice'), mailApp: settings.mailApp || 'outlook' };
  },
  openDraft: (options) => {
    if (!askOpenDraft) throw new Error('Loggie is still starting. Try again in a moment.');
    return askOpenDraft(options);
  },
  // An availability ask (availability.js): the calendar helper's list and status, read only, and the rules.
  ...askAvailability({ home: hikyakuDirectory }),
};
// Everyone an invite can name: saved-thread people first (they carry counts), then every Outlook sender in the who index
// not already there, with when they last wrote (two addresses under one name: the one used most, then the newest).
export async function invitePeople() {
  const people = await loadPeople({ home: hikyakuDirectory() });
  const known = new Set(people.map((person) => person.address));
  for (const entry of await loadWhoIndex()) if (entry.app === 'outlook' && entry.email && !known.has(entry.email)) { known.add(entry.email); people.push({ name: entry.name, address: entry.email, count: 0, last: entry.last || '' }); }
  return people;
}
// Places the user has used before (places.js): the locations on their calendar in the last 60 days and next 30,
// and the places typed into invites Loggie filled. Kept ten minutes; the calendar read needs the Calendar permission
// and is simply empty without it.
export let placesCache = { at: 0, list: [] };
export async function invitePlaces() {
  if (Date.now() - placesCache.at < 10 * 60 * 1000) return placesCache.list;
  const from = new Date(Date.now() - 60 * 86400000);
  const events = await listEvents({ from, days: 90 }).catch(() => []);
  const list = [...new Set([...(await loadPlaces({ home: hikyakuDirectory() })), ...placesFrom(Array.isArray(events) ? events : [])])];
  placesCache = { at: Date.now(), list };
  return list;
}
// Questions answered from the calendar (assistant-service.js, Amritha's): made on first use. Its cloud call reads the yes
// for "assistant": this one question, or always.
export let assistantService = null;
export function assistantOf() {
  assistantService ||= createAssistantService({
    listEvents: (options) => listEvents(options),
    completeForRequest: async ({ once = false } = {}) => {
      const settings = await readSettings(hikyakuDirectory());
      return thinkWith({ settings, maxTokens: 1800, consent: consentFor('assistant', { settings, once }), what: 'email and calendar answers', path: 'assistant' });
    },
  });
  return assistantService;
}
export const askDraftMs = new Map();
export const asker = createAsker({
  home: () => hikyakuDirectory(),
  loadIndex: () => loadWhoIndex(),
  // No chat app on in Settings: the index holds no chats, so "no one called X" would blame the name (ask-run CHATS_OFF).
  chatsOff: async () => (await chatApps()).apps.length === 0,
  invite: { people: () => invitePeople(), places: () => invitePlaces() },
  email: askEmail,
  think: {
    consent: async () => (await readSettings(hikyakuDirectory())).cloudYes?.ask === true,
    allowAlways: async () => {
      const file = join(hikyakuDirectory(), 'settings.json');
      const raw = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
      raw.cloudYes = { ...(raw.cloudYes || {}), ask: true };
      await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    },
    complete: async (prompt, { once = false } = {}) => {
      const settings = await readSettings(hikyakuDirectory());
      const complete = thinkWith({ settings, maxTokens: 300, consent: consentFor('ask', { settings, once }), what: 'a sentence you typed', path: 'ask' });
      return complete ? complete(prompt) : null;
    },
  },
  assistant: {
    consent: async () => (await readSettings(hikyakuDirectory())).cloudYes?.assistant === true,
    allowAlways: async () => {
      const file = join(hikyakuDirectory(), 'settings.json');
      const raw = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
      raw.cloudYes = { ...(raw.cloudYes || {}), assistant: true };
      await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
    },
    ask: (text, options) => assistantOf().ask(text, options),
  },
  calendar: {
    list: () => listEvents({ from: new Date(new Date().setHours(0, 0, 0, 0)), days: 22 }),
    move: (options) => moveInOutlook(options),
    discard: (options) => discardMove(options),
  },
  clearChat: (options) => clearOwnDraft(options),
  // "what did X say": that one chat, or that sender's newest mail, read on this Mac.
  readLatest: async (entry) => {
    if (entry.app === 'outlook') {
      const own = await ownAddresses();
      if (!own[0]) return [];
      return mailMessages(await readInboxMail({ address: own, days: 60, bodies: false, keep: (message) => String(message.from || '').toLowerCase().includes(entry.email) }), entry.email);
    }
    const read = await readChatsNamed({ apps: [entry.app], days: 3650, maxChats: 1, maxMessages: 6, chat: `${entry.app}:${entry.chatId}` });
    if (read[entry.app]?.status !== 'ok') throw new Error(read[entry.app]?.detail || read[entry.app]?.status || 'not readable');
    return chatMessages(read[entry.app].chats[0]);
  },
  openChat: (args) => openChatDraft({ ...args, openSettingsImpl: () => openPane('accessibility', { home: hikyakuDirectory() }) }),
  emit: (kind, data) => {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send(`ask:${kind}`, data);
    if (kind === 'draft') askDraftMs.set(data.askId, data.ms);
    // One ui-acts row per ask, never the words or the names: the falsifier counts placed drafts and wrong chats. An
    // email adds how its thread was picked (thread), whether the cloud draft kept the line (drafted) and how soon the
    // card showed it (draftMs) (loggie-ask-thread falsifier: the card by 2.0 s, no draft without the line).
    // An availability ask adds `times` (ask-run.js boxActRow).
    if (kind === 'done') {
      appendFile(join(hikyakuDirectory(), 'ui-acts.jsonl'), `${JSON.stringify(boxActRow(data, { draftMs: askDraftMs.get(data.askId) ?? null, at: new Date().toISOString() }))}\n`).catch(() => {});
      askDraftMs.delete(data.askId);
    }
  },
});

export function registerAsk() {
  askOpenDraft = (options) => hikyakuOpenDraft(options);
  // The ask box (loggie-ask-box): a preview while typing, a run that answers at once with its id and then speaks
  // through ask:step / ask:done, and Stop. Invites and file opens still go through command:execute.
  handleSecure('ask:preview', (text) => asker.preview(validateAskText(text)));
  handleSecure('ask:run', (text, choices, cloud) => { const { askId } = asker.run(validateAskText(text), { choices: validateAskChoices(choices), cloud: validateAskCloud(cloud) }); return { askId }; });
  handleSecure('ask:stop', (askId) => asker.stop(validateAskId(askId)));
  handleSecure('ask:undo', (askId) => asker.undo(validateAskId(askId)));
  // A held draft's time (status 'needs-time'): it fills the gap and opens the draft (ask-run.js fill).
  handleSecure('ask:fill', (askId, time) => asker.fill(validateAskId(askId), validateAskText(time)));
  // A draft that did not open (Outlook on the Calendar): the same draft, opened again (ask-run.js again).
  handleSecure('ask:again', (askId) => asker.again(validateAskId(askId)));
  handleSecure('command:execute', (text) => commandService.execute(text));
  handleSecure('command:open-resolved', (selection) => commandService.openResolved(selection));
  // "Your free times" on the Settings page (loggie-availability I3): the five rows read, and one row's change saved
  // into settings.json (meetingHours, availability) after the rest of the file was read; writes go one at a time.
  handleSecure('hikyaku:availability-settings', async () => availabilityView(await readRawSettings(hikyakuDirectory())));
  handleSecure('hikyaku:set-availability', (patch) => inSettings(() => saveAvailability(hikyakuDirectory(), validateAvailabilityPatch(patch))));
}
