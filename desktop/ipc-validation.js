import { SETUP_ASKS, STEPS } from './renderer/setup-model.js';
import { AVAILABILITY_VALID } from '../src/hikyaku/availability.js';
import { LINE_MAX, MENU_ITEMS } from './renderer/context-menu-model.js';

export function isTrustedRendererUrl(url) {
  return typeof url === 'string' && url.startsWith('file:') && url.includes('/desktop/renderer/');
}

export function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || !/^[\w-]{1,200}$/.test(threadId)) throw new Error('Invalid thread.');
  return threadId;
}

// A Send on the "Pick your cloud AI" step (send-gate.js): a prepared run, one of the AIs offered, and the remember box.
// Whether that AI is connected is checked by the gate itself, by code, never trusted from the screen.
export function validateSendApproval(run, provider, remember) {
  if (typeof run !== 'string' || !/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(run)) throw new Error('That is not a send hikyaku prepared.');
  if (!['nebius'].includes(provider)) throw new Error('Pick one of the AIs offered.');
  if (typeof remember !== 'boolean') throw new Error('Remember must be yes or no.');
  return { run, provider, remember };
}

// The one question after a call (send-gate.js decideSend): a prepared run and Yes or No.
export function validateDecide(run, decision) {
  if (typeof run !== 'string' || !/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(run)) throw new Error('That is not a send hikyaku prepared.');
  if (decision !== 'yes' && decision !== 'no') throw new Error('Answer Yes or No.');
  return { run, decision };
}

// A pick on a next move (pick.js, spec B10): copied n, skipped, handled elsewhere, or snooze until an ISO time. The
// draft count and the time are checked again against the Move itself.
export function validatePickChoice(choice) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('That choice is not one hikyaku offers.');
  if (choice.type === 'copied' && Number.isInteger(choice.n) && choice.n >= 1 && choice.n <= 3) return { type: 'copied', n: choice.n };
  if (choice.type === 'skipped' || choice.type === 'handled_elsewhere') return { type: choice.type };
  if (choice.type === 'snooze' && typeof choice.until === 'string' && choice.until.length <= 40) return { type: 'snooze', until: choice.until };
  throw new Error('That choice is not one hikyaku offers.');
}

// The answer to a meeting offer (meeting-watch.js, spec-c.md B14): the offer id is its run id, and record or dismiss.
// Whether that offer is still shown is checked by the watcher; only record starts a recording, and only there.
export function validateMeetingAnswer(offerId, answer) {
  if (typeof offerId !== 'string' || !/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(offerId)) throw new Error('That is not an offer Loggie made.');
  if (answer !== 'record' && answer !== 'dismiss') throw new Error('Answer record or dismiss.');
  return { offerId, answer };
}

// The answer to the end ask (meeting-watch.js, spec-c.md B15): a call folder name as send-gate.js reads one, and stop or
// keep. Whether that call is still recording is checked by the watcher; only stop ends a recording, and only there.
export function validateMeetingEnd(call, answer) {
  if (typeof call !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(call) || call.includes('..')) throw new Error('That is not a call Loggie is recording.');
  if (answer !== 'stop' && answer !== 'keep') throw new Error('Answer stop or keep.');
  return { call, answer };
}

// Pause or resume a recording (loggie-pause-attach): the call it is for and pause or resume.
export function validateMeetingPause(call, answer) {
  if (typeof call !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(call) || call.includes('..')) throw new Error('That is not a call Loggie is recording.');
  if (answer !== 'pause' && answer !== 'resume') throw new Error('Answer pause or resume.');
  return { call, answer };
}

// A cloud approval: a workstream name and nebius or off (cloud.js). Anything else is refused here.
export function validateCloudApproval(name, value) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('Workspace name is invalid.');
  if (!['nebius', 'off'].includes(value)) throw new Error('The approval must be nebius or off.');
  return { name: name.trim(), value };
}

// "Open Settings" or "Not now" on a setup card (permissions.js): one of the permissions Loggie asks for. The pane to open
// is worked out in main.js from the permission, never taken from the screen.
export function validateSetupAnswer(permission, answer) {
  if (!['calendar', 'fullDisk', 'microphone', 'screen', 'accessibility', 'automation'].includes(permission)) throw new Error('That is not a permission Loggie asks for.');
  if (answer !== 'open' && answer !== 'later') throw new Error('Answer Open Settings or Not now.');
  return { permission, answer };
}

// "Yes" or "Not now" on a cloud yes card: sorting new mail and learning your style (ai), or chats.
export function validateCloudYesAnswer(group, answer) {
  if (group !== 'ai' && group !== 'chats' && group !== 'calls') throw new Error('That is not a cloud yes Loggie asks for.');
  if (answer !== 'yes' && answer !== 'later') throw new Error('Answer Yes or Not now.');
  return { group, answer };
}

// The cloud AI key from the settings field: one line, up to 500 characters. Nothing here repeats it.
export function validateCloudKey(key) {
  if (typeof key !== 'string' || key.length > 500) throw new Error('Paste the key as one line of up to 500 characters.');
  return key;
}

// The ask box (loggie-ask-box): the sentence, the user's picks for names that matched two people, and an ask's id.
export function validateAskText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('Tell Loggie what to do in one sentence.');
  return text.trim();
}
export function validateAskChoices(choices) {
  if (choices == null) return {};
  if (typeof choices !== 'object' || Array.isArray(choices)) throw new Error('That choice is not one Loggie offered.');
  const entries = Object.entries(choices);
  if (entries.length > 8 || entries.some(([key, value]) => typeof value !== 'string' || key.length > 120 || value.length > 300)) throw new Error('That choice is not one Loggie offered.');
  return Object.fromEntries(entries);
}
export function validateAskId(askId) {
  if (typeof askId !== 'string' || !/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/.test(askId)) throw new Error('That is not an ask Loggie made.');
  return askId;
}
export function validateAskCloud(cloud) {
  if (cloud == null) return null;
  if (!['once', 'always', 'words'].includes(cloud)) throw new Error('That answer is not one Loggie offered.');
  return cloud;
}

// A call folder name under <hikyaku home>/calls (call-list.js CALL_ID): letters, digits, - and _ only, so it cannot
// leave the calls folder.
export function validateCallId(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,120}$/.test(id)) throw new Error('Invalid call.');
  return id;
}

// The title a Record press gives a call when no calendar event is happening (meeting-watch.js startManual).
export function validateRecordTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\r\n]/.test(title)) throw new Error('Invalid call title.');
  return title.trim();
}

// The calendar event a Day card or row pressed Record on (meeting-watch.js startManual, 2026-10-27): the helper's own
// event id, or null for the top row.
export function validateRecordEvent(eventId) {
  if (eventId == null) return null;
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 300 || /[\r\n]/.test(eventId)) throw new Error('Invalid calendar event.');
  return eventId;
}

// Record both (2026-10-28): the second meeting's event id, only beside a first and never the same one, or null.
export function validateRecordAlso(eventId, alsoEventId) {
  if (alsoEventId == null) return null;
  if (!eventId || typeof alsoEventId !== 'string' || !alsoEventId.trim() || alsoEventId.length > 300 || /[\r\n]/.test(alsoEventId) || alsoEventId === eventId) throw new Error('Invalid second meeting.');
  return alsoEventId;
}

// "Record from these calendars" (record-calendars.js): the calendar ids checked, at most 200, each the helper's own id.
export function validateRecordCalendars(ids) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 300 || /[\r\n]/.test(id))) {
    throw new Error('That is not a list of calendars.');
  }
  return ids;
}

// A meeting picked under a call's title (2A): null, or the id and start the choices carried, as file-event takes them.
export function validateTitleChoice(choice) {
  if (choice === null || choice === undefined) return null;
  if (typeof choice !== 'object' || Array.isArray(choice)) throw new Error('That is not a meeting on your calendar.');
  const { id, start } = validateFileEvent(choice.id, choice.start, 'x');
  return { id, start };
}

// Typed notes on a call (call-notes.js): the call folder name and at most 20,000 characters of text.
export function validateCallNotes(id, text) {
  validateCallId(id);
  if (typeof text !== 'string' || text.length > 20000) throw new Error('Notes are at most 20,000 characters.');
  return { id, text };
}

// The picker under a call (refile.js): the call folder name and a workstream name of at most 60 characters.
export function validateFileCall(id, workstream) {
  validateCallId(id);
  if (workstream === null) return { id, workstream: null };   // "No workspace" (refile.js NO_WORKSPACE)
  if (typeof workstream !== 'string' || !workstream.trim() || workstream.length > 60) throw new Error('Pick one of your workspaces.');
  return { id, workstream: workstream.trim() };
}
// Where a filing was pressed (loggie-meetings-focus cycle 2's bet): the Day card, a Day row, Recordings, or elsewhere.
export const FILE_SOURCES = ['card', 'row', 'recordings', 'call', 'workspace', 'other'];
export const fileSource = (source) => (FILE_SOURCES.includes(source) ? source : 'other');

// A meeting on the week filed under a workspace (spec B3): the calendar event id, its start, and a workspace name.
export function validateFileEvent(id, start, workstream) {
  if (typeof id !== 'string' || !id || id.length > 300 || /[\r\n]/.test(id)) throw new Error('That is not a meeting on your calendar.');
  if (typeof start !== 'string' || start.length > 40 || Number.isNaN(Date.parse(start))) throw new Error('That is not a meeting on your calendar.');
  if (typeof workstream !== 'string' || !workstream.trim() || workstream.trim().length > 200) throw new Error('Pick one of your workspaces.');
  return { id, start, workstream: workstream.trim() };
}

// A new workspace from a meeting on the week (first-run-polish B3.3): the meeting as file-event takes it, and the name
// the person typed, collapsed and trimmed, 1 to 60 characters with no line break. Nothing else comes from the page.
export function validateWorkspaceFromEvent(id, start, name) {
  validateFileEvent(id, start, 'x');
  const clean = typeof name === 'string' && !/[\r\n]/.test(name) ? name.replace(/\s+/g, ' ').trim() : '';
  if (!clean || clean.length > 60) throw new Error('A workspace name is 1 to 60 characters.');
  return { id, start, name: clean };
}

// New workspace on the Workspaces tab (loggie-new-workspace): a name of 1 to 60 characters on one line, and for Save the
// keys of the people kept from the look, at most 12 short strings.
export function validateWorkspaceName(name) {
  const clean = typeof name === 'string' && !/[\r\n]/.test(name) ? name.replace(/\s+/g, ' ').trim() : '';
  if (!clean || clean.length > 60) throw new Error('A workspace name is 1 to 60 characters.');
  return { name: clean };
}
export function validateWorkspaceNew(name, keys) {
  const { name: clean } = validateWorkspaceName(name);
  if (!Array.isArray(keys) || keys.length > 12 || keys.some((key) => typeof key !== 'string' || !key || key.length > 200)) throw new Error('Those people are not valid.');
  return { name: clean, keys: [...new Set(keys)] };
}

// One unclear word on a call (name-check.js): the call folder name and the word as heard, at most 80 characters.
export function validateNameWord(id, heard) {
  validateCallId(id);
  if (typeof heard !== 'string' || !heard.trim() || heard.length > 80) throw new Error('Invalid word.');
  return { id, heard };
}

// The nine-step setup (docs/teammate-ready/spec.md B5.1, B5.2). A save names only the setup keys settings.json keeps,
// with the values the steps offer; saveSetup (setup-status.js) does the merge. An ask names one thing a step asks
// macOS or a pane for; what to open is worked out in main.js, never taken from the screen.
const SETUP_KEYS = Object.freeze(['signName', 'mailApp', 'chats', 'step', 'done', 'voice', 'automation', 'speechModels']);
const SETUP_CHOICES = Object.freeze({
  signName: (value) => typeof value === 'string' && value.length <= 40 && !/[\r\n]/.test(value),
  mailApp: (value) => ['outlook', 'apple-mail'].includes(value),
  chats: (value) => typeof value === 'boolean',
  step: (value) => STEPS.includes(value),
  done: (value) => value === true,
  voice: (value) => ['granted', 'denied'].includes(value),
  automation: (value) => ['granted', 'denied', 'unknown'].includes(value),
  // The Calls step's speech switch (first-run-polish B5.1).
  speechModels: (value) => typeof value === 'boolean',
});
export function validateSetupSave(patch) {
  const plain = patch !== null && typeof patch === 'object' && Object.getPrototypeOf(patch) === Object.prototype;
  const keys = plain ? Object.keys(patch) : [];
  if (!keys.length || keys.some((key) => !SETUP_KEYS.includes(key) || !SETUP_CHOICES[key](patch[key]))) throw new Error('That setup choice is not one Loggie offers.');
  return Object.fromEntries(keys.map((key) => [key, key === 'signName' ? patch.signName.replace(/\s+/g, ' ').trim() : patch[key]]));
}
export function validateSetupAsk(what) {
  if (!SETUP_ASKS.includes(what)) throw new Error('That is not something setup asks for.');
  return what;
}
// The setup page draws each app's own icon: the renderer names one of these six apps; main owns the paths.
export const APP_ICON_IDS = Object.freeze(['outlook', 'apple-mail', 'calendar', 'system-settings', 'messages', 'whatsapp']);
export function validateAppIcon(app) {
  if (!APP_ICON_IDS.includes(app)) throw new Error('Loggie has no icon for that app.');
  return app;
}
// The setup page reads its whole status once, and only the permissions (and mail accounts) on its 1 s poll.
export function validateSetupPart(part) {
  if (part === undefined || part === null) return null;
  if (part !== 'permissions') throw new Error('Ask for the whole setup status or its permissions.');
  return part;
}
// The Found step's Keep, Later and the Workspaces band's Keep (first-run-polish B4.5): the names to keep and to
// dismiss, at most 20 each (the step shows at most 20 rows), and how the step ends.
const FOUND_ENDS = Object.freeze(['done', 'later', null]);
export function validateFoundKeep(choice) {
  const refuse = () => new Error('That is not a list of workspaces Loggie found.');
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.getPrototypeOf(choice) !== Object.prototype) throw refuse();
  const keys = Object.keys(choice).sort();
  if (keys.join(',') !== 'dismiss,end,keep') throw refuse();
  const names = (list) => Array.isArray(list) && list.length <= 20 && list.every((name) => typeof name === 'string' && name.length >= 1 && name.length <= 200 && !/[\r\n]/.test(name));
  if (!names(choice.keep) || !names(choice.dismiss) || !FOUND_ENDS.includes(choice.end)) throw refuse();
  if (choice.keep.some((name) => choice.dismiss.includes(name))) throw refuse();
  return { keep: [...choice.keep], dismiss: [...choice.dismiss], end: choice.end };
}

// One "Your free times" Settings row's change (loggie-availability I3): a plain object whose keys are a non-empty subset
// of the six the rows write, each value one the row offers (availability.js AVAILABILITY_VALID); timeZone null is
// "This Mac". The end-after-start rule needs the stored values, so saveAvailability checks it.
export function validateAvailabilityPatch(patch) {
  const refuse = () => { throw new Error('That is not a setting Loggie offers.'); };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.getPrototypeOf(patch) !== Object.prototype) refuse();
  const keys = Object.keys(patch);
  if (!keys.length) refuse();
  for (const key of keys) {
    if (!Object.hasOwn(AVAILABILITY_VALID, key)) refuse();
    if (!(key === 'timeZone' && patch[key] === null) && !AVAILABILITY_VALID[key](patch[key])) refuse();
  }
  return { ...patch };
}

// A right-click menu or the Share button's (loggie right-click, 2026-10-28; renderer/context-menu-model.js): a kind
// Loggie has, the thing it is on, and items named only by their ids, each with whether it can run, a check, a value (a
// workspace name) and a grey line of at most 80 characters on one line. No words cross: main writes every label
// (menu-template.js), so a page cannot put "Send to everyone" on the Mac's menu.
const MENU_KEYS = ['id', 'enabled', 'on', 'value', 'line', 'submenu'];
const SUBMENUS = Object.freeze({ recording: ['file'] });
const MENU_NAMES = 40;
// The thing a menu is on: a call folder name (validateCallId's rule), a workspace name (screenName's), a move's task
// id; a text field's menu is on nothing of Loggie's.
const isCall = (id) => typeof id === 'string' && /^[\w-]{1,120}$/.test(id);
const isName = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 200 && !/[\r\n]/.test(id);
const isMove = (id) => typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id);
const MENU_TARGETS = Object.freeze({ recording: isCall, share: isCall, workspace: isName, move: isMove, text: null });
export function validateContextMenu(menu) {
  const refuse = () => new Error('That is not a menu Loggie offers.');
  const plain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
  const oneLine = (text, max) => typeof text === 'string' && text.length >= 1 && text.length <= max && !/[\r\n]/.test(text);
  const name = (value) => value === null || oneLine(value, 60);
  const flag = (value) => value === undefined || typeof value === 'boolean';
  if (!plain(menu) || Object.keys(menu).sort().join(',') !== 'items,kind,target' || !Object.hasOwn(MENU_ITEMS, menu.kind)) throw refuse();
  const target = MENU_TARGETS[menu.kind];
  if (target ? !plain(menu.target) || Object.keys(menu.target).join() !== 'id' || !target(menu.target.id) : menu.target !== null) throw refuse();
  const ids = MENU_ITEMS[menu.kind];
  if (!Array.isArray(menu.items) || !menu.items.length || menu.items.length > ids.length || new Set(menu.items.map((item) => item?.id)).size !== menu.items.length) throw refuse();
  for (const item of menu.items) {
    if (!plain(item) || Object.keys(item).some((key) => !MENU_KEYS.includes(key)) || !ids.includes(item.id) || typeof item.enabled !== 'boolean' || !flag(item.on)) throw refuse();
    if (item.value !== undefined && !name(item.value)) throw refuse();
    if (item.line !== undefined && !oneLine(item.line, LINE_MAX)) throw refuse();
    if (item.submenu === undefined) continue;
    const entries = item.submenu;
    if (!(SUBMENUS[menu.kind] || []).includes(item.id) || !Array.isArray(entries) || entries.length > MENU_NAMES + 1) throw refuse();
    if (entries.some((entry) => !plain(entry) || Object.keys(entry).some((key) => !['value', 'on', 'guess'].includes(key)) || !name(entry.value) || !flag(entry.on) || !flag(entry.guess))) throw refuse();
    const names = entries.filter((entry) => entry.value !== null).map((entry) => entry.value);
    if (names.length > MENU_NAMES || new Set(names).size !== names.length || entries.length - names.length > 1) throw refuse();
  }
  return menu;
}
// A Share pick: the call and how, the email to the people on it or the share sheet.
export function validateShare(id, how) {
  validateCallId(id);
  if (how !== 'people' && how !== 'sheet') throw new Error('Share by email to the people on the call, or the share sheet.');
  return { id, how };
}
