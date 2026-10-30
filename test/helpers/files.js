// Folder walks the tests share.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Every file under root, at any depth; a missing root is no files.
export async function filesUnder(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path)); else out.push(path);
  }
  return out;
}

// Every .js, .cjs and .mjs file under directory; a missing directory throws, so a scan never passes on nothing.
export async function sourcesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourcesUnder(path));
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}
