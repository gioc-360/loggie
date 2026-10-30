// Runs one live eval scenario end to end: fresh draft id, open the reply through Loggie, judge it.
//   node scripts/outlook-eval/run.mjs S1
// It drives the user's real Outlook: a reply window opens (never sent). Discard it from Drafts afterwards.
// S8 also runs a second time without --again and must be refused ("already open"), leaving no second draft.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { check } from './check.mjs';
import { draftText, EVAL_ROOT } from './make-tasks.mjs';

const run = promisify(execFile);
const LOGGIE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'loggie.js');

export async function runScenario(id, { root = EVAL_ROOT, execImpl = run, now = new Date() } = {}) {
  const task = `task_${id}`;
  await writeFile(join(root, task, 'DRAFT.md'), draftText(id, now.toISOString().replace(/[-:.]/g, '').slice(0, 15)));
  const first = await execImpl(process.execPath, [LOGGIE, 'draft', task, '--again'], { cwd: root, timeout: 120000 }).then((r) => r.stdout, (e) => String(e.stdout || e.message));
  let extra = null;
  if (id === 'S8') {
    const second = await execImpl(process.execPath, [LOGGIE, 'draft', task], { cwd: root, timeout: 120000 }).then((r) => r.stdout, (e) => String(e.stdout || e.message));
    extra = /already opened/i.test(second) ? null : `a second run without --again was not refused: ${second.trim().slice(0, 200)}`;
  }
  const verdict = await check(id, { root, extra: extra ? [extra] : [] });
  return { output: first.trim(), verdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  if (!id) { console.error('usage: run.mjs S<n>'); process.exit(2); }
  const { output, verdict } = await runScenario(id);
  console.log(output);
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${id}`);
  for (const problem of verdict.problems) console.log(`  - ${problem}`);
  process.exit(verdict.pass ? 0 : 1);
}
