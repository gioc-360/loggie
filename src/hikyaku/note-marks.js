// Your word on a point Loggie could not confirm (the click-to-learn-more popup on the Notes & Meetings tab,
// 2026-10-12). "It's right" confirms it; "Fix it" replaces its words with yours; Undo takes either back. Kept in the
// call folder as note-marks.json, keyed by the point's text, so a new summary (new words) starts fresh. The summary file
// itself is never changed: it stays the record of what the AI wrote and what the checks found.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CALL_ID } from './call-list.js';

export const MARKS_FILE = 'note-marks.json';
// The point's words without the speech readers' "(unclear)" marks, which the page no longer shows.
const key = (text) => String(text || '').replace(/\s+\(unclear\)/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function readMarks(folder) {
  try {
    const marks = JSON.parse(await readFile(join(folder, MARKS_FILE), 'utf8'));
    return { right: marks.right || {}, fixed: marks.fixed || {} };
  } catch { return { right: {}, fixed: {} }; }
}

// The marks applied to one parsed line: { text, unsure, mine } -> the line as the page shows it.
export function marked(line, marks) {
  const k = key(line.text);
  if (marks.fixed[k]) return { ...line, original: line.text, text: marks.fixed[k].text, unsure: false, fixed: true };
  if (marks.right[k]) return { ...line, unsure: false, confirmed: true };
  return line;
}

export async function markLine({ home, id, text, action, value = '' }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const k = key(text);
  if (!k || String(text).length > 2000) throw new Error('That point is not in these notes.');
  const folder = join(home, 'calls', id);
  const marks = await readMarks(folder);
  const at = new Date().toISOString();
  if (action === 'right') marks.right[k] = { at };
  else if (action === 'fix') {
    const words = String(value || '').replace(/\s+/g, ' ').trim();
    if (!words || words.length > 500) throw new Error('A point is 1 to 500 characters. Nothing was changed.');
    marks.fixed[k] = { text: words, at };
  } else if (action === 'undo') { delete marks.right[k]; delete marks.fixed[k]; }
  else throw new Error('Unknown answer.');
  await writeFile(join(folder, MARKS_FILE), `${JSON.stringify(marks, null, 1)}\n`);
  return { id, action };
}
