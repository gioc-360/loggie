// Search Spotlight plus the accessible filesystem, without a list of user-selected folders.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
const run = promisify(execFile);
const fold = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export async function searchMacFiles({ target, extensions = [], home, extraRoots = [], roots = [home, '/'], timeoutMs = 15000, maxResults = 1000, execImpl = run, fs = { access, readdir, realpath, stat }, now = Date.now }) {
  const deadline = now() + timeoutMs;
  const matches = new Map(), related = new Map(), visited = new Set(), blocked = new Set();
  let limited = false, indexUnavailable = false;
  const wanted = fold(target);
  const words = [...new Set(target.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter(word => word.length > 2);
  async function inspect(path, source, info = null) {
    const name = basename(path), candidate = fold(name);
    const exact = candidate.includes(wanted);
    const stemWords = name.slice(0, name.length - extname(name).length).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const shared = words.filter(word => stemWords.includes(word)).length;
    if (!candidate || !wanted || (!exact && !(words.length > 1 && shared))) return;
    try {
      info ||= await fs.stat(path);
      if (extensions.length && (!info.isFile() || !extensions.includes(extname(name).toLowerCase()))) return;
      await fs.access(path, constants.R_OK);
      const bucket = exact ? matches : related;
      if (bucket.size >= maxResults && !bucket.has(path)) { limited = true; return; }
      bucket.set(path, { path, name, kind: info.isDirectory() ? 'directory' : 'file', score: exact ? (candidate === wanted ? 100 : candidate.startsWith(wanted) ? 80 : 60) : 40 * shared / words.length, source });
    } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) blocked.add(path); }
  }
  // Pass a predicate as an argument, never execute the user's text in a shell.
  const escaped = target.replace(/[\\"*?]/g, char => '\\' + char);
  try {
    const predicate = [`kMDItemFSName == "*${escaped}*"cd`, ...(words.length > 1 ? words.map(word => `kMDItemFSName == "*${word}*"cd`) : [])].join(' || ');
    const { stdout } = await execImpl('/usr/bin/mdfind', ['-0', predicate], { timeout: Math.min(4000, timeoutMs), maxBuffer: 8 * 1024 * 1024 });
    for (const path of stdout.split('\0').filter(Boolean)) {
      if (now() >= deadline) { limited = true; break; }
      await inspect(path, 'spotlight');
    }
  } catch { indexUnavailable = true; }
  const queue = [...new Set([...roots, ...extraRoots].filter(Boolean))];
  // Resolve directory identities to avoid symlink loops and macOS's duplicate Data volume paths.
  async function directory(path) {
    try {
      const canonical = await fs.realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const entries = await fs.readdir(canonical, { withFileTypes: true });
      await inspect(canonical, 'filesystem', await fs.stat(canonical));
      for (const entry of entries) {
        if (now() >= deadline) { limited = true; return; }
        const child = join(canonical, entry.name);
        let info;
        if (entry.isSymbolicLink()) {
          try { info = await fs.stat(child); } catch { continue; }
        }
        await inspect(child, 'filesystem', info);
        if (entry.isDirectory() || info?.isDirectory()) queue.push(child);
      }
    } catch (error) { if (['EACCES', 'EPERM'].includes(error.code)) blocked.add(path); }
  }
  while (queue.length && now() < deadline && matches.size < maxResults) {
    await Promise.all(queue.splice(0, 8).map(directory));
  }
  if (queue.length) limited = true;
  return { candidates: [...(matches.size ? matches : related).values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)), related: !matches.size && related.size > 0, blocked: [...blocked], limited, indexUnavailable };
}
