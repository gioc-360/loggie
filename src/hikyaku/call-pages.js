// The pages tucked into a recording (loggie-pause-attach): what the user drops on the recording card or picks from its
// fusen tab, copied into <call>/pages/ under its own name (" 2" on a clash). The transcriber reads them at stop
// (pages.py): their words join the user's own for spelling, their text goes, screened, into the notes. Only while the
// call records: a page is what the meeting runs on.
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const PAGE_KINDS = Object.freeze(['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md']);
export const PAGE_MOST_BYTES = 50 * 1024 * 1024;
export const PAGE_KINDS_TEXT = 'Loggie reads PDF, Word, PowerPoint, Excel, text or Markdown pages.';

export async function listPages(folder) {
  const names = await readdir(join(folder, 'pages')).catch(() => []);
  return names.filter((name) => PAGE_KINDS.includes(extname(name).toLowerCase())).sort();
}

// When the newest page went in (ms), 0 with none: a page newer than the notes or a waiting send is not in them yet.
export async function newestPageAt(folder) {
  const names = await listPages(folder);
  const times = await Promise.all(names.map((name) => stat(join(folder, 'pages', name)).then((info) => info.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

// Copies `path` into the call's pages/; returns the page names. Refused, with a sentence a person can act on, for a
// kind pages.py cannot read, a file over 50 MB or one that is not a file.
export async function addPage({ folder, path }) {
  const kind = extname(String(path || '')).toLowerCase();
  if (!PAGE_KINDS.includes(kind)) throw new Error(PAGE_KINDS_TEXT);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error('That page could not be found.');
  if (info.size > PAGE_MOST_BYTES) throw new Error('That page is over 50 MB.');
  const dir = join(folder, 'pages');
  await mkdir(dir, { recursive: true });
  const taken = new Set(await readdir(dir).catch(() => []));
  const stem = basename(path, extname(path));
  let name = `${stem}${kind}`;
  for (let n = 2; taken.has(name); n += 1) name = `${stem} ${n}${kind}`;
  await copyFile(path, join(dir, name));
  return { added: name, pages: await listPages(folder) };
}
