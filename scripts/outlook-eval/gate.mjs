// The release gate for any change to the Outlook reply path (outlook.swift, outlook.js, draft.js replyTarget and
// openDraft, headless.js open-draft wiring). Exit 1 on any failed line.
//   node scripts/outlook-eval/gate.mjs            offline checks, then the live streaks
//   node scripts/outlook-eval/gate.mjs --offline  offline checks only (no live Outlook on this Mac)
// 1. every test passes; the offline decide suite passes 5 runs in a row (it spawns a binary)
// 2. silent-wrong is 0 across every attempt log on this Mac
// 3. live: each scenario has its streak of consecutive passes on THIS helper version (a change resets it)
// 4. note when a recorded fixture comes from an older Outlook than the one installed
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { helperSha } from '../../src/hikyaku/outlook.js';
import { CHECKS } from './check.mjs';
import { EVAL_ROOT } from './make-tasks.mjs';
import { metrics, readAttemptLines, WORK } from './metrics.mjs';
import { scenarios } from './scenarios.mjs';

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Trailing passes per scenario, counting only verdicts on the given helper version.
export function streaks(checks, sha) {
  const out = {};
  for (const c of checks.filter((item) => item.helperSha === sha)) out[c.scenario] = c.pass ? (out[c.scenario] || 0) + 1 : 0;
  return out;
}

export function liveLines(checks, sha, list) {
  const got = streaks(checks, sha);
  const seen = new Set(checks.filter((c) => c.helperSha === sha).map((c) => c.scenario));
  return list.filter((s) => !s.optional || seen.has(s.id)).map((s) => ({ name: `live ${s.id} ${s.title}`, ok: (got[s.id] || 0) >= s.streak, detail: `${got[s.id] || 0} of ${s.streak} in a row${s.expectedFail ? ' (expected fail: passes when it fails as planned)' : ''}` }));
}

async function passes(command, args) {
  return run(command, args, { cwd: REPO, timeout: 900000, maxBuffer: 64 * 1024 * 1024 }).then(() => true, () => false);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const offline = process.argv.includes('--offline');
  const lines = [];
  lines.push({ name: 'node --test, every test', ok: await passes(process.execPath, ['--test']) });
  let five = 0;
  for (let i = 0; i < 5; i += 1) if (await passes(process.execPath, ['--test', 'test/hikyaku-outlook-decide.test.js'])) five += 1;
  lines.push({ name: 'offline decide suite, 5 runs', ok: five === 5, detail: `${five}/5` });
  const m = metrics(await readAttemptLines([WORK]));
  lines.push({ name: 'silent-wrong across every attempt log', ok: m.silentWrong === 0, detail: `${m.silentWrong} of ${m.audited} audited runs` });
  const sha = await helperSha();
  if (!offline) {
    const checks = (await readFile(join(EVAL_ROOT, CHECKS), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const a = JSON.parse(await readFile(join(EVAL_ROOT, 'ADDRESSES.json'), 'utf8').catch(() => 'null'));
    if (!a) lines.push({ name: 'live scenarios', ok: false, detail: 'not set up: run make-tasks.mjs, send the SETUP.md emails, then run.mjs per scenario' });
    else lines.push(...liveLines(checks, sha, scenarios(a)));
  }
  const installed = await run('/usr/bin/defaults', ['read', '/Applications/Microsoft Outlook.app/Contents/Info', 'CFBundleShortVersionString']).then((r) => r.stdout.trim(), () => null);
  const notes = [];
  for (const name of (await readdir(join(REPO, 'test', 'fixtures', 'outlook'))).filter((f) => f.endsWith('.json'))) {
    const recorded = JSON.parse(await readFile(join(REPO, 'test', 'fixtures', 'outlook', name), 'utf8')).recorded;
    if (installed && recorded?.outlookVersion && recorded.outlookVersion !== installed) notes.push(`${name} was recorded on Outlook ${recorded.outlookVersion}; ${installed} is installed: record it again and compare`);
  }
  const width = Math.max(...lines.map((l) => l.name.length));
  console.log(`helper ${sha}${offline ? ', offline only' : ''}`);
  for (const l of lines) console.log(`${l.ok ? 'PASS' : 'FAIL'}  ${l.name.padEnd(width)}  ${l.detail || ''}`);
  for (const n of notes) console.log(`NOTE  ${n}`);
  process.exit(lines.every((l) => l.ok) ? 0 : 1);
}
