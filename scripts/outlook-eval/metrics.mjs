// Counts over every Outlook reply attempt on this Mac, read-only.
//   node scripts/outlook-eval/metrics.mjs [DIR ...]   (default: hikyaku's work folder)
// Reads each ATTEMPTS.jsonl under the folders. Exits 1 when silent-wrong is above 0: a run that reported "replied"
// while a finding said something was wrong. The helper makes that impossible by construction; this checks it held.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WORK = join(homedir(), 'Library', 'Application Support', 'Loggie', 'hikyaku', 'work');
const WRONG_RECIPIENT = new Set(['reply-wrong-recipient', 'reply-includes-you']);

export async function attemptFiles(dir) {
  const found = [];
  const walk = async (path, depth) => {
    if (depth > 6) return;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(path, entry.name), depth + 1);
      else if (entry.name === 'ATTEMPTS.jsonl') found.push(join(path, entry.name));
    }
  };
  await walk(dir, 0);
  return found;
}

export async function readAttemptLines(dirs) {
  const lines = [];
  for (const dir of dirs) {
    for (const file of await attemptFiles(dir)) {
      for (const text of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
        try { lines.push({ ...JSON.parse(text), file }); } catch { /* a torn line is skipped */ }
      }
    }
  }
  return lines;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

// Only runs where the Outlook helper ran: not dry runs, calendar events or other mail apps. Runs from before the
// audit existed (no helperSha) are counted apart: they cannot show a silent wrong reply, which is why it was built.
export function metrics(lines) {
  const runs = lines.filter((line) => line.status && line.status !== 'dry-run' && line.mode !== 'dry-run' && line.mode !== 'event' && line.status !== 'decided');
  const audited = runs.filter((line) => line.helperSha);
  const delta = (line, a, b) => (line.audit && Number.isInteger(line.audit[a]) && Number.isInteger(line.audit[b]) ? line.audit[b] - line.audit[a] : 0);
  const silentWrong = audited.filter((line) => line.status === 'replied' && line.findings?.length);
  const clean = audited.filter((line) => line.status === 'replied' && !line.findings?.length);
  const flagged = audited.filter((line) => line.pasted === true && line.findings?.length);
  const stopped = audited.filter((line) => line.pasted !== true && line.status !== 'replied' && line.status !== 'reply-open-draft-on-clipboard');
  const ms = audited.map((line) => line.ms).filter(Number.isFinite);
  return {
    runs: runs.length, unaudited: runs.length - audited.length, audited: audited.length,
    silentWrong: silentWrong.length,
    wrongRecipientStopped: audited.filter((line) => WRONG_RECIPIENT.has(line.status)).length,
    placedClean: clean.length, placedWithFindings: flagged.length,
    clipboard: audited.filter((line) => line.status === 'reply-open-draft-on-clipboard').length,
    stopped: stopped.length,
    stoppedHonestly: stopped.filter((line) => delta(line, 'to_fields_before', 'to_fields_after') <= 1).length,
    strayWindows: audited.filter((line) => delta(line, 'to_fields_before', 'to_fields_after') > 1 || delta(line, 'windows_before', 'windows_after') > 1).length,
    p50ms: percentile(ms, 50), p95ms: percentile(ms, 95),
    findings: Object.entries(audited.flatMap((line) => line.findings || []).reduce((counts, code) => ({ ...counts, [code]: (counts[code] || 0) + 1 }), {})),
    silentWrongLines: silentWrong.map((line) => `${line.file} ${line.at}`),
  };
}

export function report(m) {
  const row = (label, value, target = '') => `│ ${label.padEnd(26)} │ ${String(value ?? '-').padStart(8)} │ ${target.padEnd(10)} │`;
  const rule = (l, m2, r) => `${l}${'─'.repeat(28)}${m2}${'─'.repeat(10)}${m2}${'─'.repeat(12)}${r}`;
  return [
    rule('┌', '┬', '┐'), row('Metric', 'Count', 'Target'), rule('├', '┼', '┤'),
    row('runs (helper ran)', m.runs), row('  before the audit', m.unaudited, 'not judged'), row('  audited', m.audited),
    row('silent-wrong', m.silentWrong, '0, ever'), row('wrong recipient, stopped', m.wrongRecipientStopped, 'report'),
    row('placed, clean', m.placedClean, 'report'), row('placed, with findings', m.placedWithFindings, 'report'),
    row('draft left on clipboard', m.clipboard, 'report'), row('stopped', m.stopped, 'report'),
    row('  stopped honestly', m.stoppedHonestly, '= stopped'), row('stray windows', m.strayWindows, '0'),
    row('time p50 (ms)', m.p50ms, '< 20000'), row('time p95 (ms)', m.p95ms, '< 45000'), rule('└', '┴', '┘'),
    ...(m.findings.length ? [`findings: ${m.findings.map(([code, n]) => `${code} ${n}`).join(', ')}`] : []),
    ...m.silentWrongLines.map((line) => `SILENT WRONG: ${line}`),
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [WORK];
  const m = metrics(await readAttemptLines(dirs));
  console.log(report(m));
  process.exit(m.silentWrong > 0 ? 1 : 0);
}
