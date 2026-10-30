// The draft-eval scorecard (docs/replies/spec-a.md R4): per-draft checks that do not depend on wording, because the
// offline answer key is what the user sent after editing an older draft, so any new paraphrase would score as
// "changed". Pure functions; draft-eval.mjs reads the files and prints. Counts, never percentages: 8 cases is a gate.
import { draftText } from '../src/hikyaku/delta.js';
import { contentWords, unbackedPromises, userWordsIn } from '../src/hikyaku/steps.js';

export const SET_A = Object.freeze(['eae0f54d', '36ba3bc7', '67f13558', '9de72d58', 'bc034cc5', 'caeb0712', '98201dc6', 'e75b4c5c']);
export const SET_R = Object.freeze(['94e60753']);
const SIGN_OFF = /^(best regards|best|kind regards|regards|thanks|thank you|cheers|sincerely|warmly|warm regards)[,!.]?$/i;

const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
export const bodyWords = (text) => draftText(text).split(/\s+/).filter(Boolean).length;
export const startsCapital = (text) => /^[^A-Za-z]*[A-Z]/.test(lines(text)[0] || '');
export const greetingWord = (text) => (lines(text)[0] || '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '';
export function signOff(text) {
  const found = lines(text).reverse().find((line) => SIGN_OFF.test(line));
  return found ? found.toLowerCase().replace(/[,!.]$/, '') : null;
}
export function coverage(sent, draft) {
  const want = new Set(contentWords(sent));
  if (!want.size) return null;
  const have = new Set(contentWords(draft));
  return [...want].filter((word) => have.has(word)).length / want.size;
}
export const staleIntro = (text) => /incoming|first[- ]year/i.test(String(text || ''));
export const hasEmDash = (text) => /—/.test(String(text || ''));
const median = (values) => {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

// One row per draft: { task, file, draft, sent, brief, notes }. Returns the counts for set A plus the R case.
export function scorecard(rows) {
  const a = rows.filter((row) => SET_A.includes(row.task));
  const drafts = a.filter((row) => row.file === 'DRAFT.md' && row.draft);
  const ratios = drafts.map((row) => bodyWords(row.draft) / bodyWords(row.sent));
  const covered = drafts.map((row) => coverage(row.sent, row.draft));
  return {
    cases: a.length,
    c1Shape: a.filter((row) => !String(row.file).startsWith('error')).length,
    c2Drafts: drafts.length,
    c3LengthMedian: median(ratios),
    c3Outside: ratios.filter((ratio) => ratio > 1.5 || ratio < 0.5).length,
    c4Capital: drafts.filter((row) => startsCapital(row.draft)).length,
    c5Greeting: drafts.filter((row) => greetingWord(row.draft) === greetingWord(row.sent)).length,
    c6SignOff: drafts.filter((row) => signOff(row.draft) === signOff(row.sent)).length,
    c7CoverageMedian: median(covered),
    c8Promises: drafts.reduce((sum, row) => sum + unbackedPromises(row.draft, { userWords: userWordsIn(row.brief || ''), notes: row.notes || '' }).length, 0),
    c9StaleIntro: drafts.filter((row) => staleIntro(row.draft)).length,
    c10EmDash: drafts.filter((row) => hasEmDash(row.draft)).length,
    reasked: a.filter((row) => row.reasked).length,
    regression: rows.filter((row) => SET_R.includes(row.task)).map((row) => ({ task: row.task, file: row.file })),
  };
}
