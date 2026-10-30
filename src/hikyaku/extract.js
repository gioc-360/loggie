// Reads the text of PDF and Word attachments, safely (docs/hikyaku-security.md, step 4). Each file is downloaded,
// given a safe name, and read by a small Swift helper (native/extract.swift, Apple's PDFKit and AppKit) inside a
// macOS sandbox that allows no network, reads only that one file and writes only one text file, under a time limit.
// The raw file is deleted after reading. The text is kept outside the task folders, where the drafting agent cannot
// read it; the sensitive-file screen (sensitive.js) decides what may go to the agent, as a capped excerpt (excerpt.js).
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperPath } from './native-helper.js';

export const EXTRACT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'native', 'extract.swift');
export const EXTRACT_HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-extract');
const MB = 1024 * 1024;

// "../../.zshrc" -> "01-.._.._.zshrc" never escapes the folder; only letters, digits, dot, dash and underscore.
export function safeName(index, name = 'file') {
  return `${String(index + 1).padStart(2, '0')}-${String(name).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'file'}`;
}

// Contents are denied, not file details: walking to the helper's own path needs the details of each folder above it
// (denying those crashed Apple's frameworks), while reading a file or listing a folder stays blocked (tested live).
export function sandboxProfile({ input, output, helper, home = homedir() }) {
  const q = (path) => JSON.stringify(path);
  return `(version 1)
(allow default)
(deny network*)
(deny file-write* (require-not (require-any (literal ${q(output)}) (subpath "/private/var/folders") (subpath "/dev"))))
(deny file-read-data (require-all (subpath ${q(home)}) (require-not (require-any (literal ${q(input)}) (literal ${q(helper)})))))
`;
}

const run = (file, args, { timeoutMs }) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MB }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout), stderr: String(stderr) }));
});

export async function extractText({ input, output, kind, helper, profilePath, timeoutMs = 20000, runImpl = run, home = homedir() }) {
  await writeFile(profilePath, sandboxProfile({ input, output, helper, home }));
  const { error, stdout } = await runImpl('/usr/bin/sandbox-exec', ['-f', profilePath, helper, input, output, kind], { timeoutMs });
  if (error?.killed || error?.signal === 'SIGKILL') return { status: 'unreadable', detail: `stopped after ${timeoutMs / 1000} s` };
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) || '';
  try { return JSON.parse(line); } catch { return { status: 'unreadable', detail: 'the reader gave no answer' }; }
}

// Word files are zip archives. Their own index says how big they unpack, so a zip bomb (tiny on disk, hundreds of MB
// inside) is refused before anything unpacks it. A test file of 400 KB unpacked to 400 MB and took 6.8 s in the reader.
export function zipUnpackedBytes(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) return null;
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16), total = 0;
  if (offset + size > buffer.length) return null;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    total += buffer.readUInt32LE(offset + 24);
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return total;
}

// files: described attachments (attachments.js) with messageId and attachmentId. Returns them with `read` filled in.
export async function readAttachments({ files, taskId, extractedRoot, fetchBytes, helper, maxBytes = 20 * MB, extract = extractText }) {
  const directory = join(extractedRoot, taskId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const out = [];
  for (const [index, file] of files.entries()) {
    if (!file.readable || !file.attachmentId || !file.messageId) { out.push({ ...file, read: null }); continue; }
    const name = safeName(index, file.name);
    const raw = join(directory, `${name}.raw`), text = join(directory, `${name}.txt`);
    let result;
    try {
      const bytes = await fetchBytes(file.messageId, file.attachmentId);
      const unpacked = file.kind === 'word' && bytes.subarray(0, 2).toString() === 'PK' ? zipUnpackedBytes(bytes) : 0;
      if (bytes.length > maxBytes) result = { status: 'unreadable', detail: 'too large to read (over 20 MB)' };
      else if (unpacked === null || unpacked > 50 * MB) result = { status: 'unreadable', detail: unpacked === null ? 'a damaged Word file: not read' : `it unpacks to ${Math.round(unpacked / MB)} MB inside: not read (a possible zip bomb)` };
      else {
        await writeFile(raw, bytes, { mode: 0o600 });
        result = await extract({ input: raw, output: text, kind: file.kind, helper, profilePath: join(directory, `${name}.sb`) });
      }
    } catch (error) {
      result = { status: 'unreadable', detail: `could not download it: ${error.message}`.slice(0, 200) };
    } finally {
      await rm(raw, { force: true }); await rm(join(directory, `${name}.sb`), { force: true });
    }
    const chars = ['ok', 'partial'].includes(result.status) ? ((await stat(text).catch(() => null)) ? (await readFile(text, 'utf8')).length : 0) : 0;
    // `saved` is the text file's name under hikyaku/extracted/<task>/ (never its full path), for the screen to find it.
    out.push({ ...file, read: { status: result.status, detail: result.detail, chars, saved: `${name}.txt` } });
  }
  return out;
}

export const ensureExtractHelper = (options = {}) => helperPath({ name: 'extract', source: EXTRACT_SOURCE, devHelper: EXTRACT_HELPER, ...options });
