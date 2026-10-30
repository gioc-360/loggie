// The user's answer to a next move (spec-entry-b.md B10, A8; mock e screen 4). Two things, both on the Mac:
//   pick       one click on the card: copied draft n, skipped, handled elsewhere, or snooze until a time. Each is a
//              Signal { move_id, choice, at, sent_seen: null, edit_ratio: null } appended to <task>/SIGNALS.jsonl,
//              and pick.recorded in the Move's run. Skipped and handled elsewhere close the Core task through the
//              domain's legal steps; snooze keeps it open and hides the move on the card until its time.
//   open in    "Open draft in" a mail app. mail.apps lists Outlook and Apple Mail with their connected status from
//              code: connected when the app is on this Mac (the doctor's own check); Gmail left with its sign-in
//              (2026-10-28). An app that is not connected is refused. The draft opens through the EXISTING open-draft
//              paths (draft.js: Outlook and Apple Mail reply in the thread); the clipboard is the fallback when no app
//              is connected. Opening counts as a pick (copied n). Loggie never sends mail: the user presses Send there.
import { spawn } from 'node:child_process';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { openDraft, taskReply } from './draft.js';
import { readMove } from './next-move.js';
import { appendEvent, runsRoot } from './send-gate.js';

export const MAIL_APP_LIST = Object.freeze([
  Object.freeze({ id: 'outlook', label: 'Outlook', path: '/Applications/Microsoft Outlook.app' }),
  Object.freeze({ id: 'apple-mail', label: 'Apple Mail', path: '/System/Applications/Mail.app' }),
]);
const exists = (path) => access(path).then(() => true, () => false);

// The default clipboard: pbcopy, the text on its stdin. The desktop app passes Electron's clipboard instead.
export function pbcopy(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('The draft could not be copied.'))));
    child.stdin.end(text);
  });
}

async function moveOf(taskDirectory) {
  const move = await readMove(taskDirectory);
  if (!move?.move_id) throw new Error('This task has no next move yet.');
  return move;
}
const runOf = (home, move) => join(runsRoot(home), move.run?.run_id || 'none');

async function recordSignal({ home, taskDirectory, move, choice, now }) {
  const signal = { move_id: move.move_id, choice, at: now().toISOString(), sent_seen: null, edit_ratio: null };
  await appendFile(join(taskDirectory, 'SIGNALS.jsonl'), `${JSON.stringify(signal)}\n`);
  if (move.run?.run_id) await appendEvent(runOf(home, move), { type: 'pick.recorded', step: 'pick', text: 'Saved your choice', data: signal });
  return signal;
}

function checkChoice(choice, move, now) {
  const bad = (why) => new Error(`That choice is not one hikyaku offers (${why}).`);
  if (!choice || typeof choice !== 'object') throw bad('no choice');
  if (choice.type === 'copied') {
    if (!Number.isInteger(choice.n) || choice.n < 1 || choice.n > move.drafts.length) throw bad(move.drafts.length ? `draft 1 to ${move.drafts.length}` : 'this move has no drafts');
    return { type: 'copied', n: choice.n };
  }
  if (choice.type === 'skipped' || choice.type === 'handled_elsewhere') return { type: choice.type };
  if (choice.type === 'snooze') {
    const until = Date.parse(choice.until);
    if (typeof choice.until !== 'string' || Number.isNaN(until) || until <= now().getTime()) throw bad('snooze needs a time in the future');
    return { type: 'snooze', until: new Date(until).toISOString() };
  }
  throw bad(`"${String(choice.type).slice(0, 40)}"`);
}

// The Core task a skipped or handled-elsewhere move closes, by the domain's own rules (src/core/domain.js): waiting
// may only go to briefed (with an approved brief), briefed to running, and running to done. So a waiting task walks
// waiting -> briefed -> running -> done, approving its latest draft brief first (or a one-line brief when it has
// none), the same approval step Do it uses (main.js briefedTask). Each step is a real transition with its reason.
const CLOSE_REASON = { skipped: 'Skipped on the card', handled_elsewhere: 'Handled elsewhere' };
export async function closeTask({ core, taskId, reason }) {
  let task = await core.getTask(taskId);
  if (!task) throw new Error('This move has no task to close.');
  if (task.status === 'waiting') {
    const quiet404 = (error) => { if (error?.status === 404) return null; throw error; };
    const approved = await core.getApprovedBrief(task.id).catch(quiet404);
    if (!approved) {
      const latest = await core.getLatestBrief(task.id).catch(quiet404);
      const brief = latest?.status === 'draft' ? latest : await core.createBrief(task.id, { objective: task.title, context: `${reason}. Nothing to draft.` });
      await core.approveBrief(brief.id);
    }
    task = await core.transitionTask(task.id, 'briefed', reason);
  }
  if (task.status === 'briefed') task = await core.transitionTask(task.id, 'running', reason);
  if (task.status === 'running' || task.status === 'blocked') task = await core.transitionTask(task.id, 'done', reason);
  return task;
}

// pick(move_id, choice) -> Signal. copied: draft n to the clipboard and to DRAFT.md (so the open-draft path reads it).
// skipped and handled_elsewhere close the Core task (closeTask) when `core` is given; snooze leaves it open and the
// card hides the move until its time (snoozedUntil, cardTop).
export async function pickMove({ home, taskDirectory, choice, core = null, clipboardImpl = pbcopy, now = () => new Date() }) {
  const move = await moveOf(taskDirectory);
  const checked = checkChoice(choice, move, now);
  if (checked.type === 'copied') {
    const text = move.drafts[checked.n - 1];
    await writeFile(join(taskDirectory, 'DRAFT.md'), text);
    await clipboardImpl(text);
  }
  if (core && CLOSE_REASON[checked.type]) await closeTask({ core, taskId: move.task_id || basename(taskDirectory), reason: CLOSE_REASON[checked.type] });
  return recordSignal({ home, taskDirectory, move, choice: checked, now });
}

// When the card's current move is snoozed: the newest Signal for THIS move_id is a snooze whose time has not come.
// A new move on the same task (a new move_id) is not hidden by an old move's snooze.
export async function snoozedUntil(taskDirectory, now = new Date()) {
  const move = await readMove(taskDirectory).catch(() => null);
  if (!move?.move_id) return null;
  const text = await readFile(join(taskDirectory, 'SIGNALS.jsonl'), 'utf8').catch(() => '');
  const mine = text.split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((signal) => signal?.move_id === move.move_id);
  const last = mine.at(-1);
  if (last?.choice?.type !== 'snooze') return null;
  return Date.parse(last.choice.until) > new Date(now).getTime() ? last.choice.until : null;
}

// The card's top move: the first of `tasks` (already in card order) whose move is not snoozed.
export async function cardTop({ tasks, directory, now = new Date() }) {
  let snoozed = 0, top = null;
  for (const task of tasks) {
    if (directory && await snoozedUntil(join(directory, task.id), now)) { snoozed += 1; continue; }
    top ||= task;
  }
  return { top, snoozed };
}

// mail.apps: which apps can take this draft, by code. `emit` false computes without an event (openMoveDraft).
export async function mailApps({ home, taskDirectory, settings = {}, appExists = exists, emit = true }) {
  const move = await moveOf(taskDirectory);
  const original = Boolean((await taskReply(taskDirectory)).original?.from);
  const apps = [];
  for (const app of MAIL_APP_LIST) {
    const on = Boolean(await appExists(app.path));
    apps.push({ id: app.id, label: app.label, connected: on, threaded: original, ...(on ? {} : { why: `${app.label} is not on this Mac` }) });
  }
  const chosen = apps.find((app) => app.id === settings.mailApp && app.connected) || apps.find((app) => app.connected);
  const result = { apps, default: chosen ? chosen.id : 'clipboard' };
  if (emit && move.run?.run_id) await appendEvent(runOf(home, move), { type: 'mail.apps', step: 'pick', text: 'Where should the draft open?', data: { move_id: move.move_id, ...result } });
  return result;
}

// draft.open: draft n of the Move, in the picked app (or the default), through the existing open-draft path.
export async function openMoveDraft({ home, taskDirectory, n, app = null, settings = {}, appExists = exists, openDraftImpl = openDraft, clipboardImpl = pbcopy, now = () => new Date() }) {
  const move = await moveOf(taskDirectory);
  if (!move.drafts?.length) throw new Error('This move has no draft to open.');
  if (!Number.isInteger(n) || n < 1 || n > move.drafts.length) throw new Error(`Pick draft 1 to ${move.drafts.length}.`);
  const { apps, default: fallback } = await mailApps({ home, taskDirectory, settings, appExists, emit: false });
  const target = app || fallback;
  if (target !== 'clipboard') {
    const known = apps.find((item) => item.id === target);
    if (!known) throw new Error('Pick Outlook or Apple Mail. Nothing was opened.');
    if (!known.connected) throw new Error(`${known.label} is not connected (${known.why}). Pick another, or copy the draft. Nothing was opened.`);
  }
  const text = move.drafts[n - 1];
  await writeFile(join(taskDirectory, 'DRAFT.md'), text);
  if (move.run?.run_id) await appendEvent(runOf(home, move), { type: 'draft.open', step: 'pick', text: 'Opening your draft; you send it yourself', data: { move_id: move.move_id, draft: n, app: target } });
  const result = target === 'clipboard' ? (await clipboardImpl(text), { opened: 'clipboard', mode: 'clipboard' }) : await openDraftImpl({ taskDirectory, home, mailApp: target });
  const signal = await recordSignal({ home, taskDirectory, move, choice: { type: 'copied', n, app: target }, now });
  return { app: target, result, signal };
}
