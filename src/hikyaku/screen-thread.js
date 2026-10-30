// Screens one email thread on the Mac before any of it can cross (spec-entry-b.md B4, increment b#2/b#3a). The thread's
// THREAD.md is written to <workstream folder>/.outbound/<thread id>/ and the transcriber's screen runs there:
//   <python> <transcriber>/privacy.py --thread <THREAD.md> --out <that folder>
// It writes OUTBOUND.md + HELD.json (a new pair each run: OUTBOUND-2.md, HELD-2.json). Footers, quoted replies,
// addresses, links and attachment lists are left out; each sentence goes only on a code-clean AND an explicit "not
// sensitive" from the local model. No local model means no screen, and no screen means nothing can be sent: the
// screen's refusal is thrown, never worked around. HELD.json never leaves the Mac.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const THREAD_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

// The one way the gate runs a command: (command, args, options) -> { code, stdout, stderr }. Never rejects on a
// non-zero exit, so a refusal (exit 2) and a failure (exit 1) read the same way to every caller; tests pass a fake.
export function execRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') });
    });
  });
}

// The newest OUTBOUND/HELD pair in a folder (the highest suffix), as privacy.py's free_pair numbers them.
export async function latestThreadPair(folder) {
  let best = null;
  for (const name of await readdir(folder).catch(() => [])) {
    const match = /^OUTBOUND(?:-(\d+))?\.md$/.exec(name);
    if (!match) continue;
    const n = Number(match[1] || 1);
    if (!best || n > best.n) best = { n, outbound: join(folder, name), held: join(folder, n > 1 ? `HELD-${n}.json` : 'HELD.json') };
  }
  return best;
}

export async function screenThread({ threadId, md, workstreamDirectory, transcriber, python = 'python3', me = null, runner = execRunner }) {
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId) || threadId.includes('..')) throw new Error(`Not a thread id hikyaku can use as a folder: "${threadId}".`);
  const folder = join(workstreamDirectory, '.outbound', threadId);
  await mkdir(folder, { recursive: true });
  const threadFile = join(folder, 'THREAD.md');
  await writeFile(threadFile, md);
  const result = await runner(python, [join(transcriber, 'privacy.py'), '--thread', threadFile, '--out', folder, ...(me ? ['--me', me] : [])], { cwd: transcriber });
  if (result.code !== 0) {
    const why = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || `exit ${result.code}`;
    throw new Error(`The privacy screen did not run for thread ${threadId} (${why}). Nothing can be sent until it does.`);
  }
  const pair = await latestThreadPair(folder);
  if (!pair) throw new Error(`The privacy screen did not run for thread ${threadId} (no OUTBOUND.md was written). Nothing can be sent until it does.`);
  const record = JSON.parse(await readFile(pair.held, 'utf8'));
  return { thread_id: threadId, outbound: pair.outbound, held: pair.held, counts: record.counts, seconds: record.seconds ?? null };
}
