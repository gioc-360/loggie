// What was said, cleaned for reading (2026-10-12, Gio: "the quotes show a lot of umms and uncertainty ... at this point
// it's ok to be confidently wrong"). Rules only, never a model: they delete filler sounds, stutters and repeated words
// or phrases, and the "(unclear)" marks, and never add or swap a word, so a cleaned line is the line said minus noise.
// transcript.md is never changed; the checks, the name check and "Exact words" on the Transcript page read it as it is.
// "like", "you know" and "I mean" stay: they often carry meaning, and cutting them is where rules start to change what
// someone said.

const FILLER = /(^|[\s,.;:!?(])(?:u+h*m+|u+h+|u+m+h*|e+r+m*|a+h+|h+m+|m+h*m+)(?=[\s,.;:!?)]|$)[,.;:!?]?/gi;

export function cleanSaid(text) {
  let out = String(text || '').replace(/\s+\(unclear\)/g, '');
  for (let before; before !== out;) { before = out; out = out.replace(FILLER, '$1'); }
  // a stutter or a restarted phrase: "I I", "the the the", "we should we should", "okay okay okay okay"
  for (let before; before !== out;) { before = out; out = out.replace(/\b((?:[\w'’]+\s+){0,3}[\w'’]+)(?:[\s,]+\1\b)+/gi, '$1'); }
  out = out
    .replace(/\s+([,.;:!?])/g, '$1')            // "word ," -> "word,"
    .replace(/([,;:])(?=[.!?])/g, '')            // ",." left by a cut
    .replace(/(^|[.!?]\s+)[,;:.]\s*/g, '$1')     // a sentence that was only a filler, or starts on its leftover comma
    .replace(/\s{2,}/g, ' ')
    .trim();
  // a sentence the cut left starting in lower case starts in upper case again
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
}
