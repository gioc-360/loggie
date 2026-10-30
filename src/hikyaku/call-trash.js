// Delete recording (loggie right-click, 2026-10-28; Gio: "yes, to the macOS Trash"). Only a call nothing still owns: not
// while it records, transcribes, writes its notes or waits for the yes to summarize (call-list.js states, which read
// current.json, stop.log and the pending send). Then his yes in the Mac's own confirm, then off its workspace as "No
// workspace" does (refile.js: its moves there set aside with Undo, the card's copy gone), and only then the folder to
// the Trash, notes, audio and transcript together, recoverable from Finder. `trash` is shell.trashItem; this file never
// removes anything itself.
import { join } from 'node:path';
import { CALL_ID, listCalls } from './call-list.js';
import { refileCall } from './refile.js';

// The same words the menu greys Delete with (renderer/context-menu-model.js CALL_BUSY).
export const TRASH_REFUSED = Object.freeze({ recording: 'it is still recording', transcribing: 'its transcript is still being written', writing: 'its notes are still being written', waiting: 'it is waiting for your yes to summarize' });

async function stateOf(home, id) {
  const row = (await listCalls({ home })).find((call) => call.id === id);
  if (!row) throw new Error('That recording is not on this Mac.');
  return row;
}

export async function trashCall({ home, id, core, workstreams = [], confirm, trash, refile = refileCall }) {
  if (typeof id !== 'string' || !CALL_ID.test(id)) throw new Error('Invalid call.');
  const row = await stateOf(home, id);
  if (TRASH_REFUSED[row.state]) return { trashed: false, refused: true, reason: TRASH_REFUSED[row.state] };
  if (!(await confirm({ title: row.title }))) return { trashed: false, cancelled: true };
  // A recording could have started on it while the confirm was open.
  const now = await stateOf(home, id);
  if (TRASH_REFUSED[now.state]) return { trashed: false, refused: true, reason: TRASH_REFUSED[now.state] };
  const off = await refile({ home, core, id, workstream: null, workstreams });
  await trash(join(home, 'calls', id));
  return { trashed: true, title: row.title, from: off?.from || null, setAside: Array.isArray(off?.retired) ? off.retired.length : 0 };
}
