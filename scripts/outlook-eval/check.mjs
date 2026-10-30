// Judges the newest attempt of one eval scenario and records the verdict.
//   node scripts/outlook-eval/check.mjs S1 [TASK_DIR]     exit 1 on any problem
// Reads the task's last ATTEMPTS.jsonl line, judges it against the scenario (scenarios.mjs), and appends the
// verdict to CHECKS.jsonl in the eval folder, where gate.mjs counts each scenario's streak of passes.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAttempts } from '../../src/hikyaku/draft.js';
import { EVAL_ROOT } from './make-tasks.mjs';
import { judge, scenarios } from './scenarios.mjs';

export const CHECKS = 'CHECKS.jsonl';

export async function check(id, { root = EVAL_ROOT, taskDirectory = join(root, `task_${id}`), now = new Date(), extra = [] } = {}) {
  const a = JSON.parse(await readFile(join(root, 'ADDRESSES.json'), 'utf8'));
  const s = scenarios(a).find((item) => item.id === id);
  if (!s) throw new Error(`Unknown scenario ${id}.`);
  const line = (await readAttempts(taskDirectory)).at(-1);
  const problems = [...(line ? judge(s, line, a) : ['no attempt yet: run the scenario first']), ...extra];
  const verdict = { scenario: id, at: now.toISOString(), attemptAt: line?.at || null, helperSha: line?.helperSha || null, pass: problems.length === 0, expectedFail: Boolean(s.expectedFail), problems };
  await appendFile(join(root, CHECKS), `${JSON.stringify(verdict)}\n`);
  return verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, taskDirectory] = process.argv.slice(2);
  if (!id) { console.error('usage: check.mjs S<n> [TASK_DIR]'); process.exit(2); }
  const verdict = await check(id, taskDirectory ? { taskDirectory } : {});
  console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${id}${verdict.expectedFail ? ' (behaves as the expected fail)' : ''}`);
  for (const problem of verdict.problems) console.log(`  - ${problem}`);
  process.exit(verdict.pass ? 0 : 1);
}
