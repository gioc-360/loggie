// Speech in the background (cloud-first C7, plan 4.1). The speech engine and the two speech files the transcriber reads
// (nvidia_engine.py looks for them under <root>/hf and <root>/nemo-speech) are not in the app: they download on first
// launch, so email and calendar work at once. speech-manifest.json lists each file with its url, sha256 and size,
// copied from the engine's own model index and checked against the servers' sizes and hashes.
//   - a file downloads to <dest>.part and is renamed only after its sha256 matches, so a file at its final name is whole
//   - a dropped connection leaves the .part; the next run asks for the rest with Range (a server that answers 200 to a
//     Range request restarts that file)
//   - a file that does not match its sha256 is deleted and refused; nothing half-checked is ever used
//   - setup.download events say how far all the files are together; the panel draws one card (renderer/setup-cards.js)
// A file counts as there when `provides` finds it: models are found under any snapshot revision, as nvidia_engine.py
// finds them. Fetch, extract and emit are injectable, so tests download nothing.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const DOWNLOAD_TEXT = 'Getting meeting transcription ready';
export const speechRoot = (home = homedir()) => join(home, 'Library', 'Application Support', 'Loggie', 'models', 'nvidia');

export async function readManifest(path = fileURLToPath(new URL('./speech-manifest.json', import.meta.url))) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// The file a `provides` pattern names, or null. One path segment may be "*" (the snapshot revision folder).
async function findProvided(root, pattern) {
  let found = [root];
  for (const part of pattern.split('/')) {
    const next = [];
    for (const base of found) {
      if (part !== '*') { next.push(join(base, part)); continue; }
      for (const name of await readdir(base).catch(() => [])) next.push(join(base, name));
    }
    found = next;
  }
  for (const path of found) if (await stat(path).then((info) => info.isFile(), () => false)) return path;
  return null;
}

export async function speechStatus({ root = speechRoot(), manifest } = {}) {
  const missing = [];
  for (const item of manifest.items) if (!await findProvided(root, item.provides)) missing.push(item.id);
  return { ready: missing.length === 0, missing };
}

const sha256Of = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});
const sizeOf = async (path) => (await stat(path).catch(() => null))?.size ?? 0;

export const unpack = (archive, into) => run('tar', ['xzf', archive, '-C', into]);

// One file to its final name. onBytes(n) is called as bytes arrive, counting from the start of the file.
async function fetchItem({ root, item, fetchImpl, onBytes }) {
  const final = join(root, item.dest);
  const part = `${final}.part`;
  await mkdir(dirname(final), { recursive: true });
  let have = await sizeOf(part);
  if (have > item.size) { await rm(part, { force: true }); have = 0; }
  if (have < item.size) {
    const response = await fetchImpl(item.url, { headers: have ? { Range: `bytes=${have}-` } : {} });
    if (response.status === 416) { await rm(part, { force: true }); return fetchItem({ root, item, fetchImpl, onBytes }); }
    if (!response.ok) throw new Error(`The download of ${item.id} failed (HTTP ${response.status}).`);
    if (response.status !== 206) have = 0;   // the server sent the whole file
    onBytes(have);
    const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
    try {
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        have += chunk.length;
        onBytes(have);
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  } else onBytes(have);
  if (await sha256Of(part) !== item.sha256) {
    await rm(part, { force: true });
    throw new Error(`The download of ${item.id} did not match its checksum, so it was deleted.`);
  }
  await rename(part, final);
  return final;
}

// Everything not yet on this Mac. Resolves when all of it is there and checked; rejects (after a paused event) when a
// file cannot be fetched or fails its check. A second call picks up where this one stopped.
export async function downloadSpeech({ root = speechRoot(), manifest, fetchImpl = fetch, emit, extract = unpack, everyBytes = 4 * 1024 * 1024 }) {
  const todo = [];
  for (const item of manifest.items) if (!await findProvided(root, item.provides)) todo.push(item);
  if (!todo.length) return { downloaded: [] };
  const total = todo.reduce((sum, item) => sum + item.size, 0);
  // Bytes on disk per file, counting an earlier run's .part from the first event, so progress only goes forward.
  const got = Object.fromEntries(await Promise.all(todo.map(async (item) => [item.id, Math.min(await sizeOf(join(root, `${item.dest}.part`)), item.size)])));
  const sum = () => Object.values(got).reduce((a, b) => a + b, 0);
  let announced = -Infinity;
  const say = (state, force = false) => {
    if (!force && sum() - announced < everyBytes) return Promise.resolve();
    announced = sum();
    return emit({ type: 'setup.download', text: DOWNLOAD_TEXT, data: { done_bytes: announced, total_bytes: total, state } });
  };
  let pending = Promise.resolve();
  try {
    await say('downloading', true);
    for (const item of todo) {
      await fetchItem({ root, item, fetchImpl, onBytes: (bytes) => { got[item.id] = bytes; pending = pending.then(() => say('downloading')); } });
      got[item.id] = item.size;
      await pending;
      if (item.kind === 'engine') {
        const archive = join(root, item.dest);
        await mkdir(join(root, item.extractTo), { recursive: true });
        await extract(archive, join(root, item.extractTo));
        await rm(archive, { force: true });
      }
    }
  } catch (error) {
    await pending.catch(() => {});
    await say('paused', true).catch(() => {});
    throw error;
  }
  await pending;
  await say('ready', true);
  return { downloaded: todo.map((item) => item.id) };
}
