// What two or more IPC groups share: the mail source, the send gate options, the names check, the errands and drafts.
// Moved out of main.js in debt-cleanup 6.6.
import { basename, join } from 'node:path';
import { listEvents } from '../src/hikyaku/calendar.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { contactNames, peopleOf } from '../src/hikyaku/contacts.js';
import { draftActionFor } from '../src/hikyaku/permissions.js';
import { NEBIUS_ULTRA } from '../src/hikyaku/nebius.js';
import { mailAddresses, readInboxMail, readSentMail } from '../src/hikyaku/sent-mail.js';
import { NO_MAIL_SOURCE } from '../src/hikyaku/discover.js';
import { openDraft, readSettings } from '../src/hikyaku/draft.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { openPane } from '../src/hikyaku/settings-panes.js';
import { createTavily } from '../src/hikyaku/tavily.js';
import { coreClient, hikyakuDirectory, setupGuard } from './main-state.js';

// Every address the user has in Apple Mail (Exchange first, then Google and other IMAP accounts), then
// settings.ownAddresses, less settings.skipAccounts (workspaces-outlook W10b). The readers read every one of them.
export async function ownAddresses() {
  const settings = await readSettings(hikyakuDirectory());
  const skip = new Set((settings.skipAccounts || []).map((item) => String(item).toLowerCase()));
  return [...new Set([...(await mailAddresses().catch(() => [])), ...(settings.ownAddresses || [])].map((item) => String(item).toLowerCase()))].filter((item) => item && !skip.has(item));
}
// Where mail comes from (workspaces-outlook W1, W10): every account in Apple Mail (Outlook, Google, other), which needs
// no sign-in of Loggie's own; else none, with the reason. The Gmail sign-in it once preferred is gone (2026-10-28,
// teammates' mail fix 5). `own` is every address of the user's.
// How far a catch-up reads: 120 days, what the Gmail search's newer_than:120d read before.
export const OUTLOOK_CATCHUP_DAYS = 120;
// The first look for workspaces reads a month (Gio, 2026-10-17: the work from earlier in the month too); after that a week.
export const FIRST_DISCOVER_DAYS = 30;
export async function mailSource() {
  const own = await ownAddresses();
  return own[0] ? { kind: 'apple-mail', address: own[0], own } : { kind: 'none', address: null, own: [], why: NO_MAIL_SOURCE };
}

export let decideGateOptionsOf;

// The send gate (send-gate.js, spec-entry-b.md A7): nothing leaves the Mac until the user picks an AI and presses
// Send. sends lists what is prepared, send-options says which AIs are really connected (ai.options), send runs the
// one prepared send with the picked AI (ai.picked); a call's notes are filed on its card after they come back.
export async function sendGateOptions() {
  const settings = await readSettings(hikyakuDirectory());
  const gate = await import('../src/hikyaku/send-gate.js');
  const { dir: transcriber, python } = gate.transcriberRuntime(settings);
  return { gate, settings, transcriber, python, checks: gate.defaultChecks({ transcriber, python }) };
}

// The options hikyaku:decide and the automatic yes (autoDecideOnScreen) share.
// The name check (name-check.js), after a call's summary under the same yes: the call's unclear words are fixed from the
// user's own words, then searched on the web (Tavily) when Nemotron is sure they are companies, products or places.
// In the background, so filing and the yes card are never held up; the page polls while it says "Checking names".
export async function checkNamesFor(id) {
  const home = hikyakuDirectory();
  const { runNameCheck } = await import('../src/hikyaku/name-check.js');
  const { createTavily } = await import('../src/hikyaku/tavily.js');
  const settings = await readSettings(home);
  // Through the router like every cloud call: the prompt is screened on this Mac, and the consent is the call's yes.
  const complete = thinkWith({ settings, maxTokens: 12000, consent: consentFor('names', { settings, once: true }), what: 'the names in this call', path: 'names', model: NEBIUS_ULTRA });
  const ask = async (prompt) => (complete ? complete(prompt) : '');
  const contacts = peopleOf(await contactNames().catch(() => new Map()));
  return runNameCheck({ home, id, ask, search: createTavily({ home }), workstreams: await readWorkstreams(home), contacts });
}
export const startNameCheck = (folder) => { checkNamesFor(basename(String(folder))).catch((error) => console.error(`name check: ${error.message}`)); };
// The errands (look-outside.js), after the same yes, which the yes card says covers them: the user's own next steps a
// web search can do are searched (Tavily) and answered from the pages with a quote (Nemotron Ultra). In the background,
// after filing; every failure lands in errands.json or the console, never in the yes.
export async function errandsFor(id) {
  const home = hikyakuDirectory();
  const { runErrandsSafe } = await import('../src/hikyaku/look-outside.js');
  const { createTavily, createTavilyExtract } = await import('../src/hikyaku/tavily.js');
  const settings = await readSettings(home);
  const complete = thinkWith({ settings, maxTokens: 12000, consent: consentFor('errands', { settings, once: true }), what: 'the web errands in this call', path: 'errands', model: NEBIUS_ULTRA });
  const ask = complete ? async (prompt) => String((await complete(prompt)) || '') : null;
  const contacts = peopleOf(await contactNames().catch(() => new Map()));
  return runErrandsSafe({ home, id, ask, search: createTavily({ home }), extract: createTavilyExtract(), contacts, me: settings.signName || 'me' });
}
export const startErrands = (folder) => { errandsFor(basename(String(folder))).catch((error) => console.error(`errands: ${error.message}`)); };
// A filing that made moves ranks soon, so a new step can enter First today (Codex review, 2026-10-23). main-catch-up.js
// imports this file, so it is loaded when needed.
export function filedMoves(filed) {
  if (filed?.created?.length) import('./main-catch-up.js').then(({ rankSoon }) => rankSoon()).catch((error) => console.error(`hikyaku rank after filing: ${error.message}`));
  return filed;
}
export async function decideGateOptions() {
  const { gate, transcriber, python, checks } = await sendGateOptions();
  const { fileCall } = await import('../src/hikyaku/calls.js');
  const file = async (folder) => { const filed = await fileCall({ folder, core: coreClient, workRoot: join(hikyakuDirectory(), 'work'), workstreams: await readWorkstreams(hikyakuDirectory()) }); startNameCheck(folder); startErrands(folder); return filedMoves(filed); };
  // "No": the call is still filed on its workstream, as a transcript with no summary (Gio, TC2 Q3).
  const fileTranscript = async (folder, workstream) => fileCall({ folder, core: coreClient, workRoot: join(hikyakuDirectory(), 'work'), workstreams: await readWorkstreams(hikyakuDirectory()), workstream, transcriptOnly: true });
  // The setup yes for call notes (first-run-polish B5.4): today's filing without the names check and the web errands,
  // which keep their own per-call yes. Only autoDecide's calls path passes it; every click keeps `file`.
  const fileNotesOnly = async (folder) => { const filed = await fileCall({ folder, core: coreClient, workRoot: join(hikyakuDirectory(), 'work'), workstreams: await readWorkstreams(hikyakuDirectory()) }); return filedMoves(filed); };
  return { gate, options: { home: hikyakuDirectory(), checks, transcriber, python, file, fileNotesOnly, fileTranscript, nextMove: await nextMoveHook() } };
}
decideGateOptionsOf = decideGateOptions;

// The next-move hook (next-move.js): runs only inside approveSend, after the gate. The key is read by nebius.js at
// the moment of the request; the calendar is read here and only free start times cross.
export async function nextMoveHook() {
  const settings = await readSettings(hikyakuDirectory());
  const { runNextMove } = await import('../src/hikyaku/next-move.js');
  const { createTokenFactory } = await import('../src/hikyaku/nebius.js');
  const { listEvents } = await import('../src/hikyaku/calendar.js');
  return (input) => runNextMove({ ...input, core: coreClient, client: createTokenFactory(), me: settings.signName || null, settings, eventsImpl: () => listEvents({ days: 10 }) });
}

// Every draft opens through here, with the sources the freshness guard reads (hikyaku/freshness.js): what the user
// sent and received, through Apple Mail. Only the Outlook or the Apple Mail branch places anything; this never sends.
// A chat task goes into its chat's message box instead (chats.js); when macOS blocks the window read, the Accessibility pane opens.
// Before an Outlook draft the Accessibility permission is checked, and before an Apple Mail draft the Automation one
// (which macOS only asks for itself): a refusal places nothing, says why on a card, and the draft stays on the task.
export async function hikyakuOpenDraft(options) {
  const action = draftActionFor(options.mailApp || (await readSettings(hikyakuDirectory())).mailApp);
  const need = action ? await setupGuard.check(action) : null;
  if (need) return { opened: 'none', mode: 'setup', to: '', reason: need.why };
  // The stale check reads every account in Apple Mail, not only the one the reply goes out from (W10b).
  const every = async (address) => [...new Set([...[address].flat().filter(Boolean), ...(await ownAddresses().catch(() => []))])];
  return openDraft({ ...options, home: hikyakuDirectory(),
    readSent: async (read) => readSentMail({ ...read, address: await every(read.address) }),
    readInbox: async (read) => readInboxMail({ ...read, address: await every(read.address) }),
    chat: { openSettingsImpl: () => openPane('accessibility', { home: hikyakuDirectory() }) } });
}
