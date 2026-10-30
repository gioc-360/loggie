// Pages for a meeting that has not started (loggie-pages-anytime): there is no call folder until Record (call.py start
// makes it at the press), so a page tucked into the Day card's next meeting waits in <hikyaku>/pages-waiting/<key>/pages/,
// one folder per occurrence (the event id, hashed so it is a safe name, and its start), and main moves it into the
// call's pages/ the moment Record returns the call. A page that never meets a recording stays there (no sweep).
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { addPage, listPages } from './call-pages.js';

const MATCH_MS = 12 * 3600000;   // a recording takes the pages of its meeting's occurrence within 12 h of the press
const idPart = (eventId) => createHash('sha256').update(String(eventId)).digest('hex').slice(0, 16);
const stamp = (start) => new Date(start).toISOString().replace(/[-:]/g, '').slice(0, 13);   // 20261028T1330
export const waitingFolder = (home, eventId, start) => join(home, 'pages-waiting', `${idPart(eventId)}-${stamp(start)}`);

export async function stagePage({ home, eventId, start, path }) {
  if (!Number.isFinite(Date.parse(start))) throw new Error('That meeting has no start time.');
  return addPage({ folder: waitingFolder(home, eventId, start), path });
}

export const listStaged = ({ home, eventId, start }) => listPages(waitingFolder(home, eventId, start));

// Moves the pages staged for `eventId` (the occurrence nearest `now`, within 12 h) into `callFolder`/pages/, " 2" on
// a clash, and removes the staging folder. Returns how many moved.
export async function moveStaged({ home, eventId, now = Date.now(), callFolder }) {
  if (!eventId) return 0;
  const prefix = `${idPart(eventId)}-`;
  const root = join(home, 'pages-waiting');
  const near = (await readdir(root).catch(() => []))
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(name);
      return { name, at: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN };
    })
    .filter((d) => Math.abs(d.at - now) <= MATCH_MS)
    .sort((a, b) => Math.abs(a.at - now) - Math.abs(b.at - now))[0];
  if (!near) return 0;
  const from = join(root, near.name);
  const names = await listPages(from);
  const dir = join(callFolder, 'pages');
  await mkdir(dir, { recursive: true });
  const taken = new Set(await readdir(dir).catch(() => []));
  for (const name of names) {
    const kind = extname(name), stem = basename(name, kind);
    let to = name;
    for (let n = 2; taken.has(to); n += 1) to = `${stem} ${n}${kind}`;
    taken.add(to);
    await rename(join(from, 'pages', name), join(dir, to));
  }
  await rm(from, { recursive: true, force: true });
  return names.length;
}
