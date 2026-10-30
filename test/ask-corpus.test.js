// The ask box against every Gemini Flash round (loggie-ask-wordmap). Each round in test/fixtures/ask-corpus/ is a
// file of sentences Flash wrote, each with the answer the code must reach (scripts/ask-corpus/prompt.md, graded by
// scripts/ask-corpus/grade.mjs). The bar is every sentence of every round. Where Flash's own answer was wrong,
// corrections.json says what changed and why; the round file stays as Flash wrote it, except that four names from
// the builder's private list in the first prompt were swapped for made-up ones by a one-time script kept outside the
// repo (letter for letter, so a typo stays a typo). The prompt now names made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { grade, rounds } from '../scripts/ask-corpus/grade.mjs';

for (const { round, rows } of rounds()) {
  test(`Gemini round "${round}": every sentence reads right (${rows.length})`, async () => {
    const misses = [];
    for (const row of rows) {
      const wrong = await grade(row);
      if (wrong.length) misses.push(`${row.id} ${JSON.stringify(row.sentence)}\n     ${wrong.join('\n     ')}`);
    }
    assert.equal(misses.length, 0, `${misses.length} of ${rows.length} read wrong:\n${misses.join('\n')}`);
  });
}
