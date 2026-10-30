// What the morning pick reads besides open moves (docs/goal-priorities/proposal-inputs.md, cycle 17). All of it is
// code reading files that are already on this Mac; nothing here calls the cloud.
//   events:  each workstream's calls in the last 14 days, with the words the cloud already wrote about them (the newest
//            summary in the call folder) and whether the user has written to the people since (Outlook's Sent, read
//            only). A call with no summary says so and carries no words.
//   habits:  habits.md, the user's own lines ("After an interview or coffee chat, I send a thank-you note within a
//            day."). The model reads them every morning, because a stated preference is dropped within a few turns
//            unless it is restated (PrefEval, ICLR 2025); code never turns one into a rule.
//   replaced: replaced.jsonl, the open moves a newer event made stale. A row is never deleted: Undo appends a row
//            that cancels it, so what was believed and when stays readable (Zep/Graphiti valid_at/invalid_at).
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { screenText } from './cloud-screen.js';
import { isoFromMonthDay, jsonLines, projectFor, slugOf } from './util.js';

export const HABITS_FILE = 'habits.md';
export const REPLACED_FILE = 'replaced.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_LINES = 8;
const MAX_LINE_CHARS = 220;

const line = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// The habit lines: every "- " bullet in habits.md. No file is no habits, never an error.
export async function readHabits(home) {
  const text = await readFile(join(home, HABITS_FILE), 'utf8').catch(() => '');
  return text.split('\n').filter((row) => /^\s*-\s+\S/.test(row)).map((row) => line(row.replace(/^\s*-\s+/, '')));
}

// The newest summary the cloud wrote for a call: the summary-runs.json output, else the newest summary-*.md in the
// call folder or a version folder under it. Returns null when there is none.
export async function newestSummary(folder) {
  const candidates = [];
  const runs = JSON.parse(await readFile(join(folder, 'summary-runs.json'), 'utf8').catch(() => '[]'));
  for (const run of runs) if (run.output) candidates.push(join(folder, run.output));
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /^summary-.+\.md$/.test(entry.name)) candidates.push(join(folder, entry.name));
    if (entry.isDirectory() && /^v\d/.test(entry.name)) {
      for (const name of await readdir(join(folder, entry.name)).catch(() => [])) if (/^summary-.+\.md$/.test(name)) candidates.push(join(folder, entry.name, name));
    }
  }
  const dated = (await Promise.all([...new Set(candidates)].map(async (file) => ({ file, at: (await stat(file).catch(() => null))?.mtimeMs ?? -1 }))))
    .filter((item) => item.at >= 0).sort((a, b) => b.at - a.at);
  return dated[0] ? readFile(dated[0].file, 'utf8') : null;
}

// The lines of a summary the pick may quote: its goal line and its Next Steps, screened like every cloud input.
export function eventLines(summary) {
  if (!summary) return [];
  const rows = summary.split('\n');
  const goal = rows.find((row) => /^For your goal:/i.test(row));
  const at = rows.findIndex((row) => /^##\s+next steps?/i.test(row));
  const steps = at < 0 ? [] : rows.slice(at + 1).filter((row) => /^\s*-\s+\S/.test(row)).map((row) => row.replace(/^\s*-\s+/, ''));
  return [goal, ...steps].filter(Boolean).slice(0, MAX_EVENT_LINES)
    .map((row) => line(screenText(row.replace(/\s*\[\d{1,2}:\d{2}\]/g, '').replace(/\s*\((?:not sure|unclear)\)/g, '')).text).slice(0, MAX_LINE_CHARS));
}

// Whether the user has written to anyone on the call since it ended: 'yes', 'no', or 'unknown' when there is no
// address to look for or Sent could not be read. `sent` is readSentMail's list, or null when it failed.
export function sentSince(event, sent) {
  const people = (event.emails || []).map((address) => String(address).toLowerCase());
  if (!people.length || !Array.isArray(sent)) return 'unknown';
  const end = Date.parse(event.end || event.start || '');
  if (!Number.isFinite(end)) return 'unknown';
  return sent.some((message) => Date.parse(message.timestamp) > end && message.to.some((to) => people.includes(to))) ? 'yes' : 'no';
}

// Each workstream's calls in the last `days`, newest first, as the pick sees them. `sent` as in sentSince.
export async function recentEvents({ callsHome, now = new Date(), days = 14, sent = null }) {
  const byStream = new Map();
  for (const name of await readdir(callsHome).catch(() => [])) {
    const folder = join(callsHome, name);
    const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8').catch(() => 'null'));
    const stream = event?.filed?.workstream || event?.workstream;
    const at = Date.parse(event?.start || '');
    if (!stream || !Number.isFinite(at) || now - at > days * DAY_MS || at > now) continue;
    const lines = eventLines(await newestSummary(folder));
    const item = { call: name, kind: 'call', at: new Date(at).toISOString(), title: line(screenText(event.title || name).text), category: event.category || 'call',
      lines, summarized: lines.length > 0, written: sentSince(event, sent), emails: event.emails || [] };
    const key = stream.toLowerCase();
    byStream.set(key, [...(byStream.get(key) || []), item]);
  }
  for (const list of byStream.values()) list.sort((a, b) => b.at.localeCompare(a.at));
  return byStream;
}

// Open moves a newer event replaced and the user has not undone.
export async function readReplaced(home) {
  const rows = jsonLines(await readFile(join(home, REPLACED_FILE), 'utf8').catch(() => ''));
  const active = new Map();
  for (const row of rows) {
    if (row.undo) active.delete(row.taskId);
    else active.set(row.taskId, row);
  }
  return active;
}

export async function recordReplaced(home, rows, { now = () => new Date() } = {}) {
  const active = await readReplaced(home);
  const fresh = rows.filter((row) => !active.has(row.taskId));
  for (const row of fresh) await appendFile(join(home, REPLACED_FILE), `${JSON.stringify({ ...row, validUntil: row.validUntil || now().toISOString(), recordedAt: now().toISOString() })}\n`);
  return fresh;
}

export async function undoReplaced(home, taskId, { now = () => new Date() } = {}) {
  await appendFile(join(home, REPLACED_FILE), `${JSON.stringify({ taskId, undo: true, recordedAt: now().toISOString() })}\n`);
}

// The first habits.md, from the user's own words at the cycle 15 checkpoint, written only when there is none.
export async function seedHabits(home, lines) {
  const file = join(home, HABITS_FILE);
  if (await stat(file).catch(() => null)) return false;
  await writeFile(file, ['# My habits', '', 'Loggie reads these every morning. One habit to a line; edit freely.', '', ...lines.map((item) => `- ${item}`), ''].join('\n'));
  return true;
}

// The one new move the pick proposed, as a task Do it can work on: a brief, the call's lines and, when the call had
// exactly one other person, who the note goes to. Idempotent by source id; returns the task id.
export async function createOwedTask({ core, workRoot, pick, event, ownAddress = '' }) {
  const sourceId = `owed:${pick.call}:${slugOf(pick.move)}`;
  const existing = (await core.listTasks()).find((task) => task.sourceType === 'manual' && task.sourceId === sourceId);
  if (existing) return existing.id;
  const project = await projectFor(core, pick.name, { workRoot, summary: 'Workstream from email and calls.' });
  const { directoryPath } = project;
  const why = pick.habit ? `Your habit: "${pick.habit}"` : `From the call: "${pick.quote}"`;
  const task = await core.createTask({ projectId: project.id, title: pick.move, description: `${pick.move}\n\nOwed after the call "${event.title}" (${event.at.slice(0, 10)}). ${why}`,
    sourceType: 'manual', sourceId, priority: 45 });
  await core.createBrief(task.id, {
    objective: pick.move,
    context: `After the call "${event.title}" on ${event.at.slice(0, 10)}. ${why}`,
    constraints: ['Never send email. Write drafts only; the user sends them.'],
    suggestedSteps: ['Read CALL.md for what the call covered', 'Write the email'],
    completionCriteria: ['DRAFT.md holds an email the user can send as is, or DONE.md says why nothing needs writing.'],
    assumptions: [],
  });
  const folder = join(directoryPath, task.id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'BRIEF.md'), [`# ${pick.move}`, '', `Workstream: **${pick.name}**. Owed after the call "${event.title}" (${event.at.slice(0, 10)}).`, '', why, '',
    '## Rules', '- Never send email. Write drafts only; the user sends them.', '- Facts come from CALL.md and this brief only.', ''].join('\n'));
  await writeFile(join(folder, 'CALL.md'), [`# Call: ${event.title}`, '', ...event.lines.map((text) => `- ${text}`), ''].join('\n'));
  await writeFile(join(folder, 'THREAD.md'), `# ${pick.move}\n\nNo thread: this is a new email the user starts. Everything needed is in BRIEF.md and CALL.md.\n`);
  const to = (event.emails || []).length === 1 ? event.emails[0] : '';
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to, subject: '', account: ownAddress }, null, 2));
  return task.id;
}

// The steps a call's notes give the user by name ("Prepare the Dell AI platform story for team interviews (Gio)").
// The summary already says whose step it is, so turning it into a move is bookkeeping, not judgment. 2026-10-10: four
// of Gio's steps from the Liz call never reached his list, because filing looked for an owner field the cloud
// summary does not have. A date the step states ("on Oct 16") becomes its due date.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function stepDue(text, today) {
  const match = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?!\d)/i.exec(String(text || ''));
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  return isoFromMonthDay(month, match[2], today);
}

// The titles of the lines that are the user's own steps, owner mark removed. The errand run reads the same steps.
export function ownTitles(lines, me) {
  const mark = new RegExp(`\\s*\\((?:${String(me || 'me').split(/\s+/)[0]}|me)\\)\\s*$`, 'i');
  const titles = [];
  for (const text of lines) {
    if (/^For your goal:/i.test(text) || !mark.test(text)) continue;
    titles.push(text.replace(mark, '').trim());
  }
  return titles;
}

export function ownCallSteps(events, me, today) {
  const steps = [];
  for (const [stream, list] of events) {
    for (const event of list) {
      for (const title of ownTitles(event.lines, me)) {
        steps.push({ stream, call: event.call, title, due: stepDue(title, today), sourceId: `callstep:${event.call}:${slugOf(title)}` });
      }
    }
  }
  return steps;
}

// The steps as tasks, once each (by source id), in their workstream's project. Returns the ids created.
export async function createStepTasks({ core, steps }) {
  if (!steps.length) return [];
  const existing = new Set((await core.listTasks()).map((task) => `${task.sourceType}:${task.sourceId}`));
  const projects = await core.listProjects();
  const created = [];
  for (const step of steps) {
    const project = projects.find((item) => item.name.toLowerCase() === step.stream);
    if (!project || existing.has(`manual:${step.sourceId}`)) continue;
    const task = await core.createTask({ projectId: project.id, title: step.title, description: `${step.title}\n\nYour step from the call ${step.call}.`,
      sourceType: 'manual', sourceId: step.sourceId, priority: 50, ...(step.due ? { dueAt: step.due } : {}) });
    created.push(task.id);
  }
  return created;
}

// A habit the user confirmed, added as one line. The file before the change is kept beside it with the time, so a bad
// edit can be undone (Letta's memory blocks: the last write wins and nothing else remembers the old one).
export async function addHabit(home, text, { now = () => new Date() } = {}) {
  const file = join(home, HABITS_FILE);
  const before = await readFile(file, 'utf8').catch(() => '# My habits\n\n');
  const habit = line(text);
  if ((await readHabits(home)).some((item) => item.toLowerCase() === habit.toLowerCase())) return false;
  await writeFile(`${file}.${now().toISOString().replace(/[:.]/g, '-')}`, before);
  await writeFile(file, `${before.replace(/\n*$/, '\n')}- ${habit}\n`);
  return true;
}
