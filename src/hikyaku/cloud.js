// The cloud gate (docs/hikyaku-security.md, rule 7). The cloud AI (Nemotron on Nebius) sees a workstream only after
// the user approved it, and only what the approval allows. Three checks, all in code, before anything is sent or written:
//   G1 approval: workstreams.json "cloud" field per workstream, "nebius" or off (missing, or any other value, such as
//      one a build before B7 wrote); the Chats workstream keeps its approval in settings.json "chatsCloud". Fail closed
//      on any doubt.
//   G2 calendar: free times and untitled busy blocks only (calendarForCloud); an event keeps its title only when
//      everyone on it is already in the approved workstream's threads.
//   G3 exit check: every text file the agent could read (the workstream folder and the voice folder) is read for
//      email addresses and phone numbers; any one outside the allowed set stops the run and names the file. A stop,
//      never a scrubber: nothing is rewritten.
// A permitted run leaves SENT.json beside the draft: the agent, the time, every readable file with its size and hash,
// and the exact prompt. What left the Mac is a file, not a memory.
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { basename, join, relative } from 'node:path';
import { CLOUD_PROVIDER } from './cloud-screen.js';
import { jsonLines, slug } from './util.js';
import { freeSlots, formatFree, listEvents } from './calendar.js';
import { lengthFor, recentEdits, recentMarkdown, writeLength } from './delta.js';
import { updateWorkstreams } from './workstreams.js';

export const CHATS_NAME = 'Chats';
export const CLOUD_APPROVALS = Object.freeze([CLOUD_PROVIDER]);
export const CLOUD_VALUES = Object.freeze([...CLOUD_APPROVALS, 'off']);
const EMAIL = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
// A phone number: 7 to 15 digits with the usual separators, not a date or a long id. Compared on digits only.
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{5,18}\d(?![\w.])/g;
const TEXT_FILES = /\.(md|txt|json|jsonl|csv|html|eml|ics)$/i;

const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } };
export const digitsOf = (value) => String(value).replace(/\D/g, '');
const asPhone = (raw) => { const digits = digitsOf(raw); return digits.length >= 7 && digits.length <= 15 ? digits : null; };
// Dates and timestamps (2026-10-04, 2026-10-04T12:00:00.000Z, 10/04/2026) are not phone numbers.
const DATES = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?|\d{1,2}\/\d{1,2}\/\d{2,4}/g;
const phonesIn = (text) => (String(text).replace(DATES, ' ').match(PHONE) || []).map(asPhone).filter(Boolean);
// Every address and phone number in a text, by the same rules as the exit check (next-move.js scans its request).
export const identifiersIn = (text) => ({ addresses: [...new Set((String(text).match(EMAIL) || []).map((item) => item.toLowerCase()))], phones: [...new Set(phonesIn(text))] });

// --- G1. The approval, read fresh every time; nothing is cached, nothing defaults to on.
export async function cloudApproval({ home, directoryPath }) {
  const folder = basename(directoryPath || '');
  const refuse = (workstream, reason, question) => ({ ok: false, workstream, reason, question });
  if (folder === slug(CHATS_NAME)) {
    const settings = await readJson(join(home, 'settings.json'));
    const approved = settings && typeof settings === 'object' ? settings.chatsCloud : undefined;
    if (!CLOUD_APPROVALS.includes(approved)) return refuse(CHATS_NAME, 'off', `"${CHATS_NAME}" is not approved for the cloud AI. Approve it to let the cloud AI read this workspace.`);
    return { ok: true, workstream: CHATS_NAME };
  }
  const list = await readJson(join(home, 'workstreams.json'));
  if (!Array.isArray(list)) return refuse(folder, 'unreadable', `No readable workstreams.json names this workstream, so the cloud AI may not read it. Approve "${folder}" to let the cloud AI read it.`);
  const item = list.find((entry) => entry && typeof entry.name === 'string' && slug(entry.name) === folder);
  if (!item) return refuse(folder, 'unknown', `No workstream in workstreams.json owns the folder "${folder}", so the cloud AI may not read it.`);
  const name = item.name.trim();
  if (!CLOUD_APPROVALS.includes(item.cloud)) return refuse(name, 'off', `"${name}" is not approved for the cloud AI. Approve it to let the cloud AI read this workspace.`);
  return { ok: true, workstream: name };
}

// --- the allowed set: the user's own addresses (settings, REPLY.json accounts, the voice file's account) and every
// address or number in any THREAD.md of the approved workstream. Lowercased addresses; digits for numbers.
export async function allowedIdentifiers({ home, directoryPath }) {
  const allowed = new Set();
  const addAll = (text) => {
    for (const match of String(text).match(EMAIL) || []) allowed.add(match.toLowerCase());
    for (const digits of phonesIn(text)) allowed.add(digits);
  };
  const settings = await readJson(join(home, 'settings.json'));
  for (const address of settings?.ownAddresses || []) addAll(address);
  const intros = await readJson(join(home, 'voice', 'intros.json'));
  if (intros?.account) addAll(intros.account);
  // The workstream's own people: everyone in its threads, in the briefs hikyaku wrote from them, in the syllabus the
  // user put there, and in REPLY.json (the recipients, and message ids that only look like addresses). A custom
  // workstream (an injury note to professors) has no THREAD.md, so without BRIEF.md and SYLLABUS.txt its own course
  // staff would read as strangers (measured live 2026-10-05). What the agent writes (DRAFT.md, NOTES.md) is never a
  // source of allowed people.
  for (const file of await textFiles(directoryPath)) {
    if (['THREAD.md', 'BRIEF.md', 'SYLLABUS.txt', 'REPLY.json', 'CALL.md'].includes(basename(file))) addAll(await readFile(file, 'utf8').catch(() => ''));
  }
  return allowed;
}

async function textFiles(root) {
  const out = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await walk(path); }
      else if (entry.isFile() && TEXT_FILES.test(entry.name)) out.push(path);
    }
  }
  await walk(root);
  return out.sort();
}

// --- G3. Every file the agent could read, read here first. Returns the files that hold a stranger, with counts only.
export async function exitCheck({ directoryPath, voiceDirectory, allowed }) {
  const hits = [];
  const files = [...await textFiles(directoryPath), ...(voiceDirectory ? await textFiles(voiceDirectory) : [])];
  for (const file of files) {
    // CALENDAR.md is hikyaku's own, rewritten from allowed parts after this check and before the agent reads it (an
    // old one holds titles and attendees from before the gate, measured live 2026-10-05); RUN.jsonl and SENT.json are
    // hikyaku's logs of the run itself.
    if (['SENT.json', 'RUN.jsonl', 'CALENDAR.md'].includes(basename(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    const addresses = new Set((text.match(EMAIL) || []).map((item) => item.toLowerCase()).filter((item) => !allowed.has(item)));
    const phones = new Set(phonesIn(text).filter((digits) => !allowed.has(digits)));
    if (addresses.size || phones.size) hits.push({ file, addresses: addresses.size, phones: phones.size });
  }
  return { ok: hits.length === 0, hits, files };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function privacyQuestion(hits, { directoryPath, voiceDirectory }) {
  const where = (file) => (voiceDirectory && file.startsWith(voiceDirectory) ? `voice/${relative(voiceDirectory, file)}` : relative(directoryPath, file));
  const named = hits.map((hit) => `${where(hit.file)} (${[hit.addresses ? plural(hit.addresses, 'address') : '', hit.phones ? plural(hit.phones, 'phone number') : ''].filter(Boolean).join(', ')})`);
  return `Before sending anything to the cloud, hikyaku found people who are not in this workstream's threads in ${named.join('; ')}. Nothing was sent. Move or edit those files, or approve differently, then Do it again.`;
}

// --- G2. The calendar a cloud agent may see.
export function calendarForCloud(settings = {}, { events, allowed = new Set(), from = new Date(), days = 7 } = {}) {
  const hours = { startHour: 9, endHour: 17, timeZone: 'America/New_York', ...settings.meetingHours };
  const { timeZone } = hours;
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  const timed = events.filter((event) => !event.allDay);
  const free = formatFree(freeSlots(events, { from, days, minutes: 30, ...hours }), [], { minutes: 30, ...hours })
    .split('\n').filter((line) => !/^Calendars read:|^Read-only feeds|^All-day items/.test(line)).join('\n').trimEnd();
  const busy = timed.sort((a, b) => String(a.start).localeCompare(String(b.start))).map((event) => {
    const when = `${day.format(new Date(event.start))} ${time.format(new Date(event.start))}-${time.format(new Date(event.end))}`;
    const people = (event.attendees || []).map((address) => String(address).toLowerCase());
    const known = people.length > 0 && people.every((address) => allowed.has(address));
    return known ? `${when}  ${event.title}  [with ${people.join(', ')}]` : `${when}  busy`;
  });
  return `# Calendar, next ${days} days\n\n${free}\n\n## Busy\n\n${busy.join('\n') || 'Nothing on your calendars in that window.'}\n`;
}

// The app's calendar text for a cloud run: the live calendar, through G2.
export async function cloudCalendarText(settings = {}, { allowed, days = 7 } = {}) {
  const events = await listEvents({ days });
  return calendarForCloud(settings, { events, allowed, days });
}

// --- the receipt.
export async function writeSent({ taskDirectory, directoryPath, voiceDirectory, agent, workstream, prompt, files, room = null, extra = {}, now = () => new Date() }) {
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(file).catch(() => null);
    if (!bytes) continue;
    const path = voiceDirectory && file.startsWith(voiceDirectory) ? `voice/${relative(voiceDirectory, file)}` : relative(room || directoryPath, file);
    entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const receipt = { agent, workstream, at: now().toISOString(), files: entries, prompt, ...extra };
  await writeFile(join(taskDirectory, 'SENT.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

// --- the room: what a cloud run can see, built by hikyaku for this one move and nothing else. The agent's working
// folder is not the workstream folder (every task, old logs, old events, a summary naming everyone) but a staging
// folder holding this move's own files: the brief, the thread, the notes, the syllabus, the call notes, the
// screened attachment excerpts, its own earlier draft, and a fresh calendar. Email moves get the workstream's
// CONTEXT.md (the user's decision, 2026-10-05); a chat move gets one line instead, because the Chats workstream is
// every chat and the promise is that one chat goes (docs/hikyaku-security.md). The agent's results are copied
// back to the real task folder after the run. The user moves nothing by hand.
export const ROOM_INPUTS = Object.freeze(['BRIEF.md', 'THREAD.md', 'NOTES.md', 'SYLLABUS.txt', 'CALL.md', 'ATTACHMENTS.json', 'DRAFT.md', 'SUBJECT.txt', 'CC.txt']);
export const ROOM_OUTPUTS = Object.freeze(['DRAFT.md', 'SUBJECT.txt', 'CC.txt', 'EVENT.json', 'NEEDS.md', 'YOUR-STEP.md', 'DONE.md']);
export const roomFor = (directoryPath, taskId) => join(dirname(directoryPath), '.runs', taskId);
export async function buildRoom({ directoryPath, taskId, chat = false }) {
  const taskDirectory = join(directoryPath, taskId);
  const room = roomFor(directoryPath, taskId);
  const roomTask = join(room, taskId);
  await rm(room, { recursive: true, force: true });
  await mkdir(roomTask, { recursive: true });
  const context = chat ? `# Chats\n\nThis move is one chat. The user's other chats are not shared with this run.\n`
    : await readFile(join(directoryPath, 'CONTEXT.md'), 'utf8').catch(() => '');
  if (context) await writeFile(join(room, 'CONTEXT.md'), context);
  for (const name of ROOM_INPUTS) await copyFile(join(taskDirectory, name), join(roomTask, name)).catch(() => {});
  if ((await stat(join(taskDirectory, 'ATTACHMENTS')).catch(() => null))?.isDirectory()) await cp(join(taskDirectory, 'ATTACHMENTS'), join(roomTask, 'ATTACHMENTS'), { recursive: true });
  return { room, roomTask };
}
// After the run: what the agent wrote comes back to the real task folder; the room is left for the next resume.
// Only what the agent changed comes back. The room starts with the last draft in it, and copying an unchanged draft
// back would give it a fresh time, so a run that wrote nothing (or failed) would open the old draft as if new.
export async function collectRoom({ directoryPath, taskId }) {
  const roomTask = join(roomFor(directoryPath, taskId), taskId);
  const back = [];
  for (const name of ROOM_OUTPUTS) {
    const from = join(roomTask, name), to = join(directoryPath, taskId, name);
    const written = await readFile(from).catch(() => null);
    if (!written) continue;
    const before = await readFile(to).catch(() => null);
    if (before && before.equals(written)) continue;
    await writeFile(to, written);
    back.push(name);
  }
  return back;
}

// --- the whole gate, as startHeadless runs it: the approval, then the room, then the exit check over the room and
// the voice folder. Either { ok: true, allowed, workstream, files, room } or a needs-you state.
export async function cloudGate({ home, directoryPath, voiceDirectory, taskId = null, chat = false }) {
  const approval = await cloudApproval({ home, directoryPath });
  if (!approval.ok) return { ok: false, phase: 'needs-you', kind: 'cloud-off', question: approval.question, workstream: approval.workstream };
  const allowed = await allowedIdentifiers({ home, directoryPath });
  const built = taskId ? await buildRoom({ directoryPath, taskId, chat }) : null;
  const scan = built ? built.room : directoryPath;
  const check = await exitCheck({ directoryPath: scan, voiceDirectory, allowed });
  if (!check.ok) return { ok: false, phase: 'needs-you', kind: 'privacy-stop', question: privacyQuestion(check.hits, { directoryPath: scan, voiceDirectory }), workstream: approval.workstream, hits: check.hits.length };
  return { ok: true, allowed, workstream: approval.workstream, files: check.files, room: built?.room || null };
}

// --- setting and listing approvals (CLI `loggie cloud`, IPC hikyaku:set-cloud).
export async function listCloud(home) {
  const list = (await readJson(join(home, 'workstreams.json'))) || [];
  const settings = (await readJson(join(home, 'settings.json'))) || {};
  const out = (Array.isArray(list) ? list : []).filter((item) => item && typeof item.name === 'string').map((item) => ({ name: item.name.trim(), cloud: CLOUD_APPROVALS.includes(item.cloud) ? item.cloud : 'off' }));
  if (Array.isArray(settings.chats) && settings.chats.length) out.push({ name: CHATS_NAME, cloud: CLOUD_APPROVALS.includes(settings.chatsCloud) ? settings.chatsCloud : 'off' });
  return out;
}

export async function setCloud(home, name, value) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Name the workspace to approve.');
  if (!CLOUD_VALUES.includes(value)) throw new Error(`The approval must be nebius or off, not "${value}".`);
  if (name.trim() === CHATS_NAME) {
    const file = join(home, 'settings.json');
    const settings = (await readJson(file)) || {};
    if (value === 'off') delete settings.chatsCloud; else settings.chatsCloud = value;
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    return { name: CHATS_NAME, cloud: value };
  }
  // Under the lock (workstreams.js updateWorkstreams): missing, corrupt and unreadable all say MISSING, as before.
  const MISSING = 'workstreams.json is missing or not readable, so nothing can be approved yet.';
  return updateWorkstreams(home, (list) => {
    if (!Array.isArray(list)) throw new Error(MISSING);
    const item = list.find((entry) => entry && typeof entry.name === 'string' && entry.name.trim() === name.trim());
    if (!item) throw new Error(`No workspace named "${name.trim()}". Approvals are per workspace in workstreams.json (Chats by its name).`);
    if (value === 'off') delete item.cloud; else item.cloud = value;
    return { list, result: { name: item.name.trim(), cloud: value } };
  }).catch((error) => { throw error.code || error.message === 'workstreams.json could not be read.' ? new Error(MISSING) : error; });
}

// --- the voice a cloud run reads: one folder per workstream. The shared voice folder holds recent.md, built from
// the user's edits across every workstream (a professor's injury note beside a recruiter's thank-you), and that is
// what tripped the exit check on every real workstream the first time (2026-10-05). So each run gets
// <voice>/by-workstream/<folder>/: rules.md, intros.md and texting.md as they are (the user's own words, no third
// party), and a recent.md built only from this workstream's own sent drafts. Nothing in the shared folder is changed.
export const SHARED_VOICE_FILES = Object.freeze(['rules.md', 'intros.md', 'texting.md']);
export async function voiceForWorkstream({ home, directoryPath, shared }) {
  if (!shared || !(await stat(shared).catch(() => null))?.isDirectory()) return shared;
  // Only a workstream inside hikyaku's own work folder gets a voice copy. A run started on a folder elsewhere (a test,
  // a scratch task) once wrote 90 copies into the user's real voice folder (2026-10-06).
  if (!relative(join(home, 'work'), directoryPath) || relative(join(home, 'work'), directoryPath).startsWith('..')) return shared;
  const folder = basename(directoryPath);
  const target = join(shared, 'by-workstream', folder);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const name of SHARED_VOICE_FILES) await copyFile(join(shared, name), join(target, name)).catch(() => {});
  const tasks = new Set((await readdir(directoryPath).catch(() => [])).filter((name) => name.startsWith('task_')));
  const raw = await readFile(join(home, 'deltas.jsonl'), 'utf8').catch(() => '');
  const all = jsonLines(raw);
  const entries = all.filter((entry) => tasks.has(entry.task));
  // The length is this workstream's when it has enough sends, else all of the user's (delta.js lengthFor).
  const length = lengthFor(all, { taskIds: tasks });
  await writeFile(join(target, 'recent.md'), recentMarkdown(recentEdits(entries), { length }));
  await writeLength(target, length);
  return target;
}
