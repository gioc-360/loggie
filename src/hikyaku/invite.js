// The next meeting, from the last one. A recorded call's checked summary (byo.py, filed the same way calls.js reads it)
// becomes the body of an Outlook invite to the same people, at the time the user names, in a free room Outlook itself
// reports. The body is built by code from the summary, word for word: no model writes it. Loggie opens Outlook's own
// new-event window (calendar.js link), then the invite helper (native/outlook-event.swift) sets the end time, pastes
// the body, picks the room and stops. The user reads the invite and presses Send; Loggie never sends.
//   loggie invite <call-folder> --start 2026-10-14T17:30 --end 18:20 [--room Breazzano] [--floors 23] [--title "..."]
import { execFile, spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fromSummary } from './calls.js';
import { outlookEventLink } from './calendar.js';
import { helperPath } from './native-helper.js';

const run = promisify(execFile);
const SOURCE = fileURLToPath(new URL('./native/outlook-event.swift', import.meta.url));
const HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-outlook-event');

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The summary's sections and bullets, with the reader's marks turned into plain words: the minute stamps go (they point
// into a transcript the invitees do not have) and "(not sure)" becomes "(to check)", so a bullet the code could not
// match to the transcript still says so in the email. "Next Steps" becomes the action items, last.
export function summarySections(markdown) {
  const sections = [];
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) { sections.push({ heading: heading[1].trim(), bullets: [] }); continue; }
    const bullet = line.match(/^\s*-\s+(.+)/);
    if (bullet && sections.length) {
      sections.at(-1).bullets.push(bullet[1].replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '').replace(/\s*\(not sure\)/gi, ' (to check)').replace(/\s*\(unclear\)/gi, '(?)').replace(/\*\*/g, '').trim());
    }
  }
  const next = sections.filter((section) => /^next steps?$/i.test(section.heading));
  const notes = sections.filter((section) => !/^next steps?$/i.test(section.heading) && section.bullets.length);
  return { notes, actions: next.flatMap((section) => section.bullets) };
}

const dayName = (date, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(date);

export function inviteBody({ summary, event, signName = '', timeZone = 'America/New_York' }) {
  const { notes, actions } = summarySections(summary);
  const when = event.start ? dayName(new Date(event.start), timeZone) : 'our last meeting';
  const html = [
    '<div>Hi all,</div><br>',
    `<div>Here is our next meeting. Notes and action items from ${escape(when)} are below.</div><br>`,
    '<div><b>Action items</b></div>',
    actions.length ? `<ul>${actions.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '<div>No action items were said on the call.</div><br>',
    ...notes.flatMap((section) => [`<div><b>${escape(section.heading)}</b></div>`, `<ul>${section.bullets.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`]),
    signName ? `<div>${escape(signName)}</div>` : '',
  ].join('');
  return { html, actions, notes };
}

// "2026-10-14T17:30" read as the user's wall clock. Outlook's end-time menu speaks "HH:MM" in the same clock.
export function parseWhen(start, end) {
  const startMatch = String(start || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  const endMatch = String(end || '').match(/^(\d{2}):(\d{2})$/);
  if (!startMatch || !endMatch) throw new Error('Usage: --start YYYY-MM-DDTHH:MM --end HH:MM (24-hour, your own time)');
  const [, y, mo, d, h, mi] = startMatch.map(Number);
  const startDate = new Date(y, mo - 1, d, h, mi);
  const minutes = Number(endMatch[1]) * 60 + Number(endMatch[2]) - (h * 60 + mi);
  if (minutes < 15 || minutes > 240) throw new Error(`The meeting would run ${minutes} minutes; the end must be 15 minutes to 4 hours after the start, the same day.`);
  return { start: startDate, end: `${endMatch[1]}:${endMatch[2]}`, minutes };
}

// LOGGIE_INVITE_PACE=slow: the same steps, with pauses a screen recording can follow (demo takes only).
export async function invite({ folder, start, end, title = '', room = '', floors = '', pace = process.env.LOGGIE_INVITE_PACE === 'slow' ? 'slow' : '', signName = '', spawnImpl = spawn, execImpl = run, helper = null, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const when = parseWhen(start, end);
  const read = (file) => readFile(join(folder, file), 'utf8');
  const event = JSON.parse(await read('event.json'));
  const attendees = (event.emails || []).filter(Boolean);
  if (!attendees.length) throw new Error('This call has no invitee addresses in event.json, so there is no one to invite.');
  const { notes: summary, notesFrom } = await fromSummary(read);
  const subject = title || `${String(event.title || 'Meeting').split(':')[0].trim()}: next meeting`;
  const body = inviteBody({ summary, event, signName });
  const bodyFile = join(folder, 'invite-body.html');
  await writeFile(bodyFile, body.html);

  const child = spawnImpl('open', [outlookEventLink({ title: subject, start: when.start, attendees })], { detached: true, stdio: 'ignore' });
  child.unref?.();
  await wait(1500);
  const binary = helper || await helperPath({ name: 'outlook-event', source: SOURCE, devHelper: HELPER });
  const helperArgs = ['fill', '--subject', subject, '--end', when.end, '--body-file', bodyFile, '--teams', 'off',
    ...(room ? ['--room-query', room] : []), ...(floors ? ['--floors', floors] : []), ...(pace ? ['--pace', pace] : [])];
  const { stdout } = await execImpl(binary, helperArgs, { timeout: 90000 }).catch((error) => ({ stdout: error.stdout || JSON.stringify({ status: 'helper_failed', detail: error.message }) }));
  const result = JSON.parse(String(stdout).trim().split('\n').at(-1));
  // invite.json marks the call as done, so the panel stops asking about it. Only a filled invite writes it.
  if (result.status === 'ready') {
    await writeFile(join(folder, INVITE_FILE), `${JSON.stringify({ status: 'filled', created: new Date().toISOString(), subject, start, end, room: result.room_picked || '', people: attendees.length }, null, 2)}\n`);
  }
  return { subject, attendees, notesFrom, actions: body.actions, ...result };
}

// --- The panel's "Set up the next meeting?" card (a stand-in until the panel's real design, 2026-10-08).
export const INVITE_FILE = 'invite.json';
// Outlook here shortens meetings by 5 minutes: from 17:30 its end-time menu offers 17:55, 18:20, 18:50 (seen 2026-10-08),
// so the default length is its "about 1 hour", 50 minutes.
export const DEFAULT_MINUTES = 50;
export const CALL_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]{1,120}$/;

const pad = (n) => String(n).padStart(2, '0');
const dateOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// The fields, filled before the user looks (Don't Start from Zero): the same weekday a week after the call, at the call's
// own start time, 50 minutes. The building and floors are the ones used last time, or empty the first time.
export function inviteDefaults(event, place = {}, { now = new Date() } = {}) {
  const held = event.start ? new Date(event.start) : null;
  let start = held && !Number.isNaN(held.getTime()) ? new Date(held.getTime() + 7 * 86400000) : new Date(now.getTime() + 86400000);
  while (start < now) start = new Date(start.getTime() + 7 * 86400000);
  const end = new Date(start.getTime() + DEFAULT_MINUTES * 60000);
  return { date: dateOf(start), start: timeOf(start), end: timeOf(end), room: place.room || '', floors: place.floors || '' };
}

// The newest call of the last `days` that has a checked cloud summary, someone to invite and no invite.json yet.
export async function nextMeetingCandidate({ callsHome, place = {}, now = new Date(), days = 7 }) {
  const names = (await readdir(callsHome).catch(() => [])).filter((name) => CALL_NAME.test(name)).sort().reverse();
  for (const name of names) {
    const [y, m, d] = name.split('-').map(Number);
    if ((now - new Date(y, m - 1, d)) / 86400000 > days) break;
    const read = (file) => readFile(join(callsHome, name, file), 'utf8');
    if (await read(INVITE_FILE).then(() => true, () => false)) continue;
    const event = await read('event.json').then(JSON.parse, () => null);
    const people = (event?.emails || []).filter(Boolean).length;
    if (!people) continue;
    if (!(await fromSummary(read).then(() => true, () => false))) continue;
    return { call: name, title: event.title || name, people, ...inviteDefaults(event, place, { now }) };
  }
  return null;
}

// "Not now": the card does not come back for that call.
export async function skipNextMeeting({ callsHome, call }) {
  if (!CALL_NAME.test(call)) throw new Error('That is not a recorded call.');
  await writeFile(join(callsHome, call, INVITE_FILE), `${JSON.stringify({ status: 'skipped', created: new Date().toISOString() }, null, 2)}\n`);
  return { skipped: call };
}

// The building and floors are remembered for next time, merged into settings.json read raw (readSettings adds defaults).
export async function rememberPlace(home, { room = '', floors = '' }) {
  const file = join(home, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(file, 'utf8')); } catch { settings = {}; }
  settings.invitePlace = { room, floors };
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings.invitePlace;
}

// What the card sends, checked by code: a date, two 24-hour times, a building of plain words, floors as digits.
// "2, 3" and "2 or 3" both become "23".
export function validateInviteFields(call, fields = {}) {
  if (typeof call !== 'string' || !CALL_NAME.test(call)) throw new Error('That is not a recorded call.');
  const date = String(fields.date || ''), start = String(fields.start || ''), end = String(fields.end || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a date.');
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) throw new Error('Pick a start and an end time.');
  const room = String(fields.room || '').trim();
  if (room.length > 60 || /[^\p{L}\p{N} &'.-]/u.test(room)) throw new Error('Write the building as plain words, like Breazzano.');
  const floors = [...new Set(String(fields.floors || '').replace(/[^0-9]/g, ''))].join('');
  if (floors.length > 9) throw new Error('List up to nine floors.');
  parseWhen(`${date}T${start}`, end);
  return { call, date, start, end, room, floors };
}
