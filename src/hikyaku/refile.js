// Put a call under a workstream, or move it to another (loggie-meetings-tab, spec b I5): the picker under each call on
// the Notes & Meetings tab, and `loggie refile`. Moving leaves nothing behind on the old card: the moves the call made
// there are retired as "moved to <new>" (with Undo), its notes copy there is removed, event.json names the new one
// (relabeled, so byo.py never refiles it), and when the call has notes its next steps are filed on the new card.

import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CALL_ID, summaryOf, workstreamOf } from './call-list.js';
import { fileCall } from './calls.js';
import { readRetired, retireByUser } from './retire.js';

const fromCall = (id) => (task) => [`call:${id}#`, `callstep:${id}:`, `owed:${id}:`].some((prefix) => String(task.sourceId || '').startsWith(prefix));

// `workstream: null` is "No workspace" (Gio, 2026-10-26: "there has to be a way to un pick wrong workstreams if its a one
// time recording thing... or a wrong workstream"): the call leaves its card the way a move does, and event.json says it
// belongs to none on purpose (filed.none), so it is not "to file", holds no card, takes no guess and no sweep files it.
export const NO_WORKSPACE = 'No workspace';

export async function refileCall({ home, core, id, workstream, workstreams, workRoot = join(home, 'work'), dryRun = false, now = new Date() }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  if (workstream === null) return unfileCall({ home, core, id, folder, event, dryRun, now });
  const to = workstreams.find((item) => item.name.toLowerCase() === String(workstream || '').toLowerCase());
  if (!to) throw new Error(`No workspace named "${workstream}".`);
  const from = workstreamOf(event);
  if (from && from.toLowerCase() === to.name.toLowerCase()) return { unchanged: true, from, to: to.name, retired: [], created: [], notes: false };
  const retired = await readRetired(home);
  const tasks = (await core.listTasks()).filter(fromCall(id)).filter((task) => task.status !== 'done' && !retired[task.id]);
  const projects = await core.listProjects();
  const oldProject = from ? projects.find((project) => project.name.toLowerCase() === from.toLowerCase()) : null;
  // fileCall reads the call folder's own notes (notes.md or summary-runs.json); a call with none files no steps yet.
  const hasNotes = (await summaryOf(folder))?.dir === folder;
  if (dryRun) return { dryRun: true, from, to: to.name, retire: tasks.map((task) => ({ id: task.id, title: task.title })), files: hasNotes };

  for (const task of tasks) await retireByUser(home, { taskId: task.id, title: task.title, workstream: from || '', why: 'moved', to: to.name, now });
  await copyFile(join(folder, 'event.json'), join(folder, `event.json.before-refile-${now.toISOString().replace(/[:.]/g, '-')}`));
  const { none: _none, ...filed } = event.filed || {};
  await writeFile(join(folder, 'event.json'), `${JSON.stringify({ ...event, filed: { ...filed, workstream: to.name, at: now.toISOString() }, relabeled: true }, null, 2)}\n`);
  if (oldProject?.directoryPath) await unlink(join(oldProject.directoryPath, 'calls', `${id}.md`)).catch(() => {});
  let created = [];
  if (hasNotes) {
    const log = await fileCall({ folder, core, workRoot, workstreams, workstream: to.name, retired: await readRetired(home) });
    created = log.created.map((task) => task.id);
  }
  // `notes`: the call's notes went onto the workspace's card (the Meetings result line says so, cycle 2).
  return { from, to: to.name, retired: tasks.map((task) => task.id), created, notes: hasNotes };
}

// "No workspace": its moves on the old card are retired as moved to "No workspace" (Undo brings them back), the notes
// copy there is removed, and event.json keeps no workspace on purpose. Nothing is filed anywhere; nothing is deleted.
async function unfileCall({ home, core, id, folder, event, dryRun, now }) {
  const from = workstreamOf(event);
  if (!from && event.filed?.none) return { unchanged: true, from: null, to: null, none: true, retired: [], created: [], notes: false };
  const retired = await readRetired(home);
  const tasks = (await core.listTasks()).filter(fromCall(id)).filter((task) => task.status !== 'done' && !retired[task.id]);
  if (dryRun) return { dryRun: true, from, to: null, none: true, retire: tasks.map((task) => ({ id: task.id, title: task.title })) };
  const oldProject = from ? (await core.listProjects()).find((project) => project.name.toLowerCase() === from.toLowerCase()) : null;
  for (const task of tasks) await retireByUser(home, { taskId: task.id, title: task.title, workstream: from || '', why: 'moved', to: NO_WORKSPACE, now });
  await copyFile(join(folder, 'event.json'), join(folder, `event.json.before-refile-${now.toISOString().replace(/[:.]/g, '-')}`));
  await writeFile(join(folder, 'event.json'), `${JSON.stringify({ ...event, workstream: 'none', filed: { ...(event.filed || {}), workstream: null, none: true, at: now.toISOString() }, relabeled: true }, null, 2)}\n`);
  if (oldProject?.directoryPath) await unlink(join(oldProject.directoryPath, 'calls', `${id}.md`)).catch(() => {});
  return { from, to: null, none: true, retired: tasks.map((task) => task.id), created: [], notes: false };
}
