// An edited line of a call's transcript (the Transcript page, 2026-10-12, Gio: "make sure transcript page is
// editable"). The user's words replace what the speech reader heard in that one turn of transcript.md, the file the
// notes are written from; its minute and speaker stay. The first edit keeps the original as transcript.before-edit.md.
// Nothing is sent: the next Summarize again screens the edited transcript on the Mac first, like any other.

import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { transcriptFileOf } from './call-list.js';

const TURN = /^(\[[\d:]+\]\s*[^:]{1,60}:)\s?(.*)$/;
export const ORIGINAL = 'transcript.before-edit.md';

export function cleanLine(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('A line needs words. Nothing was changed.');
  if (clean.length > 5000) throw new Error('A line is at most 5000 characters. Nothing was changed.');
  return clean;
}

// Turn `index` (0-based, in the order the page shows them) gets `text`. Returns { changed, index, text }.
export async function editLine({ home, id, index, text }) {
  if (!Number.isInteger(index) || index < 0) throw new Error('That line is not in this transcript.');
  const clean = cleanLine(text);
  const file = await transcriptFileOf({ home, id });
  if (!file || !/transcript\.md$/.test(file)) throw new Error('This call has no transcript to edit yet.');
  const lines = (await readFile(file, 'utf8')).split('\n');
  let seen = -1;
  const at = lines.findIndex((line) => TURN.test(line) && ++seen === index);
  if (at < 0) throw new Error('That line is not in this transcript.');
  const [, head, old] = TURN.exec(lines[at]);
  if (old.trim() === clean) return { changed: false, index, text: clean };
  const original = join(dirname(file), ORIGINAL);
  if (!(await stat(original).catch(() => null))) await copyFile(file, original);
  lines[at] = `${head} ${clean}`;
  await writeFile(file, lines.join('\n'));
  return { changed: true, index, text: clean };
}
