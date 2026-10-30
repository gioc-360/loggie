import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
export function createFolderAccess({ file, dialog, window, defaults = ['Documents', 'Desktop', 'Downloads'].map(name => join(homedir(), name)) }) {
  let roots = [];
  return {
    async load() { try { roots = JSON.parse(await readFile(file, 'utf8')).roots.filter(x => typeof x === 'string'); } catch { roots = []; } },
    roots: () => [...roots],
    async status() { return Promise.all(roots.map(async path => { try { await readdir(path); return { path, accessible: true }; } catch { return { path, accessible: false }; } })); },
    async allowDefaults() {
      roots = [...new Set([...roots, ...defaults])];
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ roots }));
      // Reading each protected location triggers its native macOS consent dialog when undecided.
      return this.status();
    },
    async choose() {
      const result = await dialog.showOpenDialog(window(), { title: 'Choose folders Loggie can search', message: 'Choose your project folder, Documents, or another folder. macOS may ask you to allow access.', properties: ['openDirectory', 'multiSelections'] });
      if (!result.canceled) { roots = [...new Set([...roots, ...result.filePaths])]; await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ roots })); }
      return this.status();
    },
  };
}
