import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'one-offs';
}

// A workspace's Core project, made once under work/<slug> if it has none yet. Every path that files work under a
// workspace uses this, so one name never gets two folders (cleanup audit bug 4: an inline slug gave fa_os-build).
export async function projectFor(core, name, { workRoot, summary, sub = '' }) {
  const project = (await core.listProjects()).find((item) => item.name.toLowerCase() === String(name).toLowerCase());
  const directoryPath = project?.directoryPath || join(workRoot, slug(name));
  await mkdir(join(directoryPath, sub), { recursive: true });
  // A test core may return the project without its folder; the folder is always the one made here.
  return { ...(project || await core.createProject({ name, directoryPath, summary })), directoryPath };
}

// The user's calendar day on this Mac, "YYYY-MM-DD". Never the UTC date: after about 8 pm in New York that is tomorrow.
export const localDay = (date = new Date()) => date.toLocaleDateString('en-CA');

// "Oct 16" said on `today` as a date: this year, or next year when the month is more than six months back (a step in
// December naming "Jan 5" means next January). `month` is 1-12.
export const isoFromMonthDay = (month, day, today) => {
  const [year, now] = String(today).split('-').map(Number);
  return `${month < now - 6 ? year + 1 : year}-${String(month).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
};

// A .jsonl log's entries; a torn or half-written line (a crash mid-append) is skipped, as every reader did but two.
export const jsonLines = (text) => String(text || '').split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

// The first name in a From line: "Smith, John" <j@x> -> "John", Ana Ruiz <a@x> -> "Ana"; an address alone gives ''.
export function firstNameOfFrom(from) {
  const text = String(from || '').trim();
  const angle = text.indexOf('<');
  let name = (angle >= 0 ? text.slice(0, angle) : text).replace(/["']/g, '').trim();
  if (!name || name.includes('@')) return '';
  if (name.includes(',')) name = name.slice(name.indexOf(',') + 1).trim();
  return name.split(/\s+/)[0] || '';
}

// A move's or step's key in a source id or a result file ("callstep:<call>:<slugOf(title)>", errands.json steps).
export const slugOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'move';

// Text with the people's own names taken out, so a workstream word inside a name ("Dana Pharmco") is not read as the
// topic (the Pharmco case comp). `people` are display names or addresses; an address like dana.pharmco@ gives the name
// "dana pharmco". Only names of two words or more are removed, so a one-word sender never blanks a subject. Lowercase.
export function withoutNames(text, people = []) {
  const names = people.flatMap((person) => {
    const raw = String(person || '').toLowerCase();
    const address = (raw.match(/[^\s<>"]+@[^\s<>"]+/) || [])[0] || '';
    const name = raw.replace(/<[^>]*>/g, '').replace(address, '').replace(/["']/g, '').trim();
    return [name, address.split('@')[0].replace(/[._-]+/g, ' ').trim()];
  }).filter((name) => name.length >= 3 && name.includes(' '));
  return names.reduce((rest, name) => rest.split(name).join(' '), String(text || '').toLowerCase());
}
