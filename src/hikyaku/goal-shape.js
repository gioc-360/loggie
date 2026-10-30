// A drafted goal that is really a task becomes a move (docs/workstream-integration/proposal.md). An older ranking
// drafted goals in the user's terms, and one came back as a thing to do once: "Resolve the October 24 class conflict
// with the professor ...". A goal is an outcome the workstream works toward; a step with a day is a move. Code
// decides by shape, no model: the text starts with an action verb and names a day. Only drafts are touched; a goal
// the user confirmed or wrote is never changed. The draft's words survive as the move's title, and the line in
// goal-edits.jsonl says what happened, so nothing is lost.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slug } from './util.js';
import { GOAL_EDITS_FILE } from './priorities.js';
import { updateWorkstreams } from './workstreams.js';

export const ACTION_VERBS = Object.freeze(['resolve', 'confirm', 'send', 'email', 'reply', 'schedule', 'book', 'submit', 'register', 'follow',
  'prepare', 'prep', 'finish', 'ask', 'call', 'fix', 'update', 'attend', 'sign', 'pay', 'complete', 'reschedule', 'cancel', 'arrange', 'review']);
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DAY = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}/\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\\b`, 'i');

export function taskShaped(text) {
  const words = String(text || '').trim().toLowerCase().split(/\s+/);
  return ACTION_VERBS.includes(words[0]?.replace(/[^a-z]/g, '')) && DAY.test(String(text));
}

// Demotes every task-shaped draft. A workstream with no project yet keeps its draft (the move would have nowhere to
// live) and is reported as skipped. Returns { demoted: [{ name, text, taskId }], skipped: [{ name, why }] }.
// The drafts are read and the moves made outside the workstreams.json lock; only the final change goes through `update`
// (workstreams.js updateWorkstreams, first-run-polish B4.3a), on the file as it is then: a draft is cleared only where
// its goalText is still the one demoted, so a goal confirmed or rewritten meanwhile is kept.
export async function demoteTaskGoals({ home, core, update = (mutate) => updateWorkstreams(home, mutate) }) {
  const file = join(home, 'workstreams.json');
  // No workstreams.json is the first run on a new Mac (workspaces-outlook W8): nothing to demote, not an error.
  const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return '[]'; throw error; });
  const list = JSON.parse(text);
  const drafts = list.filter((item) => item && typeof item.goalText === 'string' && item.goalText.trim() && item.goalConfirmed !== true && taskShaped(item.goalText));
  const result = { demoted: [], skipped: [] };
  if (!drafts.length) return result;
  const projects = await core.listProjects();
  const existing = new Set((await core.listTasks()).map((task) => `${task.sourceType}:${task.sourceId}`));
  for (const item of drafts) {
    const project = projects.find((entry) => entry.name.toLowerCase() === item.name.trim().toLowerCase());
    if (!project) { result.skipped.push({ name: item.name, why: 'no project for this workstream yet' }); continue; }
    const text = item.goalText.trim();
    const sourceId = `goal:${slug(item.name)}:${slug(text)}`;
    let taskId = null;
    if (!existing.has(`manual:${sourceId}`)) {
      const task = await core.createTask({ projectId: project.id, title: text, description: `${text}\n\nThis was drafted as the goal for ${item.name}; it is a step, so it became a move.`,
        sourceType: 'manual', sourceId, priority: 50 });
      taskId = task.id;
    }
    result.demoted.push({ name: item.name, text, taskId });
  }
  if (result.demoted.length) {
    await update((fresh) => {
      const now = fresh || [];
      for (const { name, text } of result.demoted) {
        const item = now.find((entry) => entry?.name === name);
        if (!item || typeof item.goalText !== 'string' || item.goalText.trim() !== text) continue;
        delete item.goalText; delete item.goalQuote; delete item.goalConfirmed;
      }
      return { list: now };
    });
    const at = new Date().toISOString();
    await appendFile(join(home, GOAL_EDITS_FILE), result.demoted.map(({ name, text }) => `${JSON.stringify({ at, name, demoted: true, text })}\n`).join(''));
  }
  return result;
}
