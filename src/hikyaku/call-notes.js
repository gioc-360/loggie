// The user's own notes on a call (loggie-meetings-tab, spec b I4): what they type on the Notes & Meetings tab, kept in
// the call folder as my-notes.md. They feed the cloud summary: call.py prepare screens them on this Mac with the
// transcript (sendgate.py prepare_call -> privacy.screen_notes) and the pending send carries their hash, so the user's
// yes covers exactly the notes that were screened.

import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CALL_ID, NOTES_FILE } from './call-list.js';
import { newestPageAt } from './call-pages.js';
import { callEvent, candidates, isMeeting } from './meeting.js';
import { pendingSends, summarizeRun, supersedeSends } from './send-gate.js';
import { execRunner } from './screen-thread.js';

export const MAX_NOTES = 20000;

export async function saveCallNotes({ home, id, text }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  if (typeof text !== 'string' || text.length > MAX_NOTES) throw new Error(`Notes are at most ${MAX_NOTES} characters.`);
  const file = join(home, 'calls', id, NOTES_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
  return { saved: true, chars: text.length };
}

const lastLine = (result) => String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || `exit ${result.code}`;
const ofCall = (id) => (send) => send.what === 'call-notes' && basename(String(send.folder || '')) === id;

// Screen the call again with its notes and record a new pending send; the older pending send for the same call is
// marked superseded, so one question stays. Nothing is sent: the user still answers Yes. Returns { run }.
export async function prepareCall({ home, id, transcriber, python = 'python3', runner = execRunner, fresh = false }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  // fresh: Summarize again, which asks the AI again instead of answering from the saved copy (byo.py --fresh).
  const result = await runner(python, ['call.py', 'prepare', join(home, 'calls', id)], { cwd: transcriber, env: { ...process.env, LOGGIE_HIKYAKU_HOME: home, ...(fresh ? { LOGGIE_FRESH: '1' } : {}) } });
  if (result.code !== 0) throw new Error(lastLine(result));
  const mine = (await pendingSends(home)).filter(ofCall(id)).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const keep = mine[0]?.run || null;
  if (keep) await supersedeSends({ home, keep, matches: ofCall(id) });
  return { run: keep };
}

// Summarize, one press (loggie-one-click-summarize): the call's waiting send when there is one and the user's notes are
// not newer than it (nor a page tucked in since, loggie-pages-anytime: the send screened at Stop has no hash for it), else a fresh screen; then the yes (send-gate.js summarizeRun). Before, a waiting call hid the
// button behind its yes card, and when that card did not draw the call read "Getting it ready" for good (the
// 2026-10-22 class). `prepare` and `summarize` are seams for the tests.
export async function summarizeCall({ home, id, transcriber, python = 'python3', runner = execRunner, prepare = prepareCall, summarize = summarizeRun, ...options }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const waiting = (await pendingSends(home)).filter(ofCall(id)).filter((send) => send.status === 'pending')
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))[0];
  const notesAt = (await stat(join(home, 'calls', id, NOTES_FILE)).catch(() => null))?.mtimeMs || 0;
  const pagesAt = await newestPageAt(join(home, 'calls', id));
  const usable = waiting && Math.max(notesAt, pagesAt) <= Date.parse(waiting.created || 0) + 1000;
  const run = usable ? waiting.run : (await prepare({ home, id, transcriber, python, runner, fresh: true })).run;
  if (!run) throw new Error('The call could not be screened for its notes. Nothing was sent.');
  return summarize({ ...options, home, run, transcriber, python, runner });
}

// A new title for any call, recording or done (meetings-granola-proposal c 2A, 2026-10-27: after Stop there was no
// rename, and the 2026-10-27 interview kept a school block's name). event.json is backed up first and gets title_by_hand,
// so byo.py never names it again; the "# title" line of the transcript and the notes follows; the folder name stays (it
// is the call's id in runs/, send.json and ui-acts). `meeting`: a calendar event he picked under the title (main reads
// it): its time, invite and place become the call's, and them.py decides again who Them was on that invite.
export async function renameCall({ home, id, title, meeting = null, transcriber = null, python = 'python3', runner = execRunner }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const clean = String(meeting?.title ?? title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 80) throw new Error('A title is 1 to 80 characters.');
  const folder = join(home, 'calls', id);
  const file = join(folder, 'event.json');
  const event = JSON.parse(await readFile(file, 'utf8'));
  await copyFile(file, `${file}.before-rename-${Date.now()}`);
  const fromMeeting = meeting ? (({ title: _, ...fields }) => ({ ...fields, with: fields.names || 'the other person' }))(callEvent(meeting)) : {};
  const next = { ...event, ...fromMeeting, title: clean, title_by_hand: true, ...(event.filed ? { filed: { ...event.filed, was: event.title || null } } : {}) };
  if (meeting) delete next.category;   // derived again from the new invite (call.py derive)
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  for (const path of await titledFiles(folder)) {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text?.startsWith('# ')) await writeFile(path, text.replace(/^# [^\n]*/, `# ${clean}`));
  }
  let them = null;
  if (meeting && transcriber) {
    const result = await runner(python, ['them.py', 'again', folder], { cwd: transcriber });
    them = result.code === 0 ? 'decided again' : lastLine(result);
  }
  return { id, title: clean, ...(them ? { them } : {}) };
}

// The files whose first line is the call's title: the transcript and the notes, in the call folder and its versions.
async function titledFiles(folder) {
  const names = (dir) => readdir(dir, { withFileTypes: true }).catch(() => []);
  const own = (dir, entries) => entries.filter((d) => d.isFile() && /^(?:transcript\.md|notes\.md|summary-[\w.-]+\.md)$/.test(d.name)).map((d) => join(dir, d.name));
  const top = await names(folder);
  const versions = top.filter((d) => d.isDirectory() && /^v\d+-/.test(d.name)).map((d) => join(folder, d.name));
  return [...own(folder, top), ...(await Promise.all(versions.map(async (dir) => own(dir, await names(dir))))).flat()];
}

// When the call was recorded: call.py start's recorded_at when it writes one, else the folder's YYYY-MM-DD-HHMM (the
// press, local time), else the event's start, which for the 2026-10-27 interview was a block's 14:30.
export function callTimeOf(id, event = {}) {
  const pressed = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/.exec(String(id));
  const stamp = Date.parse(event.recorded_at || '');
  if (Number.isFinite(stamp)) return stamp;
  if (pressed) return new Date(+pressed[1], +pressed[2] - 1, +pressed[3], +pressed[4], +pressed[5]).getTime();
  return Date.parse(event.start || '') || null;
}

// The one-click choices under the title (2A): meetings starting within 30 minutes of the call (a join link, or people
// and at most 4 hours: meeting.js isMeeting), one per title and start, nearest first, at most 3, never the call's own.
// The page gets title, start, id and a count; the invite's names stay in main.
export const NEAR_MINUTES = 30;
export function nearbyMeetings(events, { at, title = '' } = {}) {
  if (!Number.isFinite(at)) return [];
  return candidates(events || []).filter((c) => isMeeting(c) && Math.abs(Date.parse(c.start) - at) <= NEAR_MINUTES * 60000 && c.title !== title)
    .sort((a, b) => Math.abs(Date.parse(a.start) - at) - Math.abs(Date.parse(b.start) - at))
    .slice(0, 3).map((c) => ({ id: c.event.id, start: c.start, title: c.title, people: c.people }));
}

// Who Them was, his click on the call page (them.py pick): the name over any detection, the transcript and the notes'
// headings relabeled, and remembered in people-names.json for the next call with that person. Names stay on this Mac.
export async function nameThem({ home, id, name, transcriber, python = 'python3', runner = execRunner }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 80 || ['me', 'them'].includes(clean.toLowerCase())) throw new Error('A name is 1 to 80 characters.');
  const result = await runner(python, ['them.py', 'pick', join(home, 'calls', id), clean], { cwd: transcriber });
  if (result.code !== 0) throw new Error(lastLine(result));
  return { id, them: clean };
}
