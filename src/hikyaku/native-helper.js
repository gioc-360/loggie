// Where a native Swift helper lives. A packaged Loggie ships every helper prebuilt (scripts/build-native.sh) and never
// calls swiftc; a developer checkout uses dist-native/bin when it is fresh, else builds the helper once, and again
// whenever its source changes.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Electron sets resourcesPath in dev too; defaultApp is set only when it runs from source.
export const isPackaged = () => Boolean(process.resourcesPath) && !process.defaultApp;

function defaultRoots() {
  return [process.resourcesPath ? join(process.resourcesPath, 'bin') : null, join(PROJECT_ROOT, 'dist-native', 'bin')].filter(Boolean);
}

async function prebuilt(file) {
  try {
    accessSync(file, constants.X_OK);
    return await stat(file);
  } catch {
    return null;
  }
}

export async function helperPath({ name, source, devHelper, roots = defaultRoots(), execImpl = run, packaged = isPackaged() }) {
  const binary = `hikyaku-${name}`;
  const sourceStat = await stat(source).catch(() => null);
  for (const root of roots) {
    const file = join(root, binary);
    const found = await prebuilt(file);
    if (found && (packaged || !sourceStat || found.mtimeMs >= sourceStat.mtimeMs)) return file;
  }
  if (packaged) throw new Error(`Loggie is missing its ${name} helper. Reinstall Loggie.`);

  const built = await stat(devHelper).catch(() => null);
  const written = sourceStat || await stat(source);
  if (built && built.mtimeMs >= written.mtimeMs) return devHelper;
  // One build per helper at a time: the launch warm-up and an ask that starts during it share the same swiftc run
  // (7.6 s for outlook.swift, measured 2026-10-12; that wait once sat inside an email ask).
  if (!building.has(devHelper)) {
    building.set(devHelper, (async () => {
      await mkdir(dirname(devHelper), { recursive: true });
      try {
        await execImpl('/usr/bin/swiftc', ['-O', source, '-o', devHelper]);
      } catch (error) {
        throw new Error(`hikyaku could not build its ${name} helper (needs Xcode command line tools): ${String(error.stderr || error.message).split('\n')[0]}`);
      }
      return devHelper;
    })().finally(() => building.delete(devHelper)));
  }
  return building.get(devHelper);
}
const building = new Map();

// Run a helper and read its answer: the last stdout line is its JSON result; a helper that fails or crashes answers
// { status: 'error', detail } with its first error line, never a throw (ask-move.js, chats.js).
export async function helperAnswer(execImpl, binary, args, options) {
  try {
    const { stdout } = await execImpl(binary, args, options);
    return JSON.parse(String(stdout).trim().split('\n').at(-1));
  } catch (error) {
    return { status: 'error', detail: String(error.stderr || error.message).trim().split('\n')[0] };
  }
}
