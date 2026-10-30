// Fails when a committed Outlook fixture still carries a real address or a private word.
//   node scripts/outlook-eval/check-redaction.mjs [DIR]   (default test/fixtures/outlook)
// Allowed addresses end in eval.test or example.com. Private words (names, real domains) are listed one per line
// in a file outside the repo, so the list itself is never published:
// ~/Library/Application Support/Loggie/hikyaku/private-words.txt, or the file named by HIKYAKU_PRIVATE_WORDS.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ALLOWED = /@(eval\.test|example\.com)$/i;
export function redactionProblems(text, privateWords = []) {
  const problems = [];
  for (const address of new Set(text.match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g) || [])) if (!ALLOWED.test(address)) problems.push(`real address: ${address}`);
  const lower = text.toLowerCase();
  for (const word of privateWords) if (word && lower.includes(word.toLowerCase())) problems.push(`private word: ${word}`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'test/fixtures/outlook';
  const wordsFile = process.env.HIKYAKU_PRIVATE_WORDS || join(homedir(), 'Library', 'Application Support', 'Loggie', 'hikyaku', 'private-words.txt');
  const words = (await readFile(wordsFile, 'utf8').catch(() => '')).split('\n').map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
  if (!words.length) console.warn(`no private words at ${wordsFile}: only addresses are checked`);
  let bad = 0;
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
    const problems = redactionProblems(await readFile(join(dir, name), 'utf8'), words);
    for (const problem of problems) { console.log(`${name}: ${problem}`); bad += 1; }
  }
  console.log(bad ? `FAIL: ${bad} problem(s)` : 'ok: no real addresses or private words');
  process.exit(bad ? 1 : 0);
}
