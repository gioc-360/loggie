// Steps only the user can take, and promises the user never made.
// A syllabus can say a request depends on the user first (Zoom only for those who qualify through Student
// Disability Services). The agent writes that step to YOUR-STEP.md instead of claiming it in the draft; code checks
// its quote against the source and asks the user before drafting. And after any draft, code looks for sentences
// that commit the user to contacting, registering or submitting something they never said (2 of 5 drafts did on
// 2026-10-04, despite the brief's rule). Both become the existing needs-you state: no new phase.

const norm = (text = '') => String(text).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function parseYourStep(text = '') {
  const field = (name) => (String(text).match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im'))?.[1] || '').trim();
  const step = field('Step') || String(text).trim().split('\n')[0].trim();
  return step ? { step, why: field('Why'), quote: field('Quote').replace(/^["“]|["”]$/g, '') } : null;
}

export function quoteFound(quote, sources) {
  const needle = norm(quote);
  return needle.split(' ').length >= 3 && sources.some((source) => norm(source).includes(needle));
}

export function yourStepQuestion({ step, why, quote }, found) {
  return [
    `Before this email, a step only you can take: ${step.replace(/\.$/, '')}.`,
    why ? `Why: ${why.replace(/\.$/, '')}.` : '',
    quote ? `The source says: "${quote}"${found ? (/[.?!]$/.test(quote) ? '' : '.') : ' (hikyaku could not find these exact words in the task files; check before relying on it).'}` : 'hikyaku gave no quote for this; check it before relying on it.',
    'Answer "done" if you did it, "not yet" to send the email without claiming it, or "skip".',
  ].filter(Boolean).join(' ');
}

// First-person commitments to act toward someone else, or claims of having done so.
const ACT = '(?:contact\\w*|reach(?:ing)? out|reached out|coordinat\\w*|regist\\w*|appl(?:y|ied|ying)|fil(?:e|ed|ing)|consult\\w*|speak(?:ing)?|spoke(?:n)?|talk\\w*|notif\\w*|inform\\w*|follow(?:ed|ing)? up|get(?:ting)? in touch|got in touch|submit\\w*|arrang\\w*|request\\w*)';
const PROMISE = new RegExp(`\\bI(?:'ll| will| shall| am going to|'m going to| plan to| intend to| am| have|'ve|'m)\\s+(?:also\\s+|already\\s+|now\\s+)?(?:be\\s+)?${ACT}\\b`, 'i');
const STOP = new Set(['will', 'with', 'that', 'this', 'have', 'from', 'your', 'about', 'they', 'them', 'their', 'would', 'could', 'should', 'also', 'already', 'been', 'being', 'into', 'more', 'than', 'then', 'when', 'what', 'which', 'there', 'here', 'regarding']);
export const contentWords = (text) => norm(text).split(' ').filter((word) => word.length > 3 && !STOP.has(word));

// Sentences in the draft that promise an action the user's own words do not back. Backed means most of the
// sentence's content words appear in what the user wrote, or the user already answered a question quoting it.
export function unbackedPromises(draft = '', { userWords = '', notes = '' } = {}) {
  const sentences = String(draft).split(/\n+/).flatMap((line) => line.split(/(?<=[.?!])\s+/)).map((sentence) => sentence.trim()).filter(Boolean);
  const said = new Set(contentWords(`${userWords} ${notes}`));
  const asked = norm(notes);
  return sentences.filter((sentence) => {
    if (!PROMISE.test(sentence)) return false;
    if (asked.includes(norm(sentence))) return false;
    const words = contentWords(sentence);
    return !words.length || words.filter((word) => said.has(word)).length / words.length < 0.6;
  });
}

export function promiseQuestion(sentences) {
  const quoted = sentences.slice(0, 3).map((sentence) => `"${sentence}"`).join(' and ');
  return `The draft says ${quoted}, which commits you to something you never said. Answer "keep" if it is true, or tell hikyaku what to say instead.`;
}

// The user's own words in a brief: the quoted "What happened, in the user's words" block, if the brief has one.
export function userWordsIn(brief = '') {
  const block = String(brief).split(/^## /m).find((section) => /^What happened, in the user's words/i.test(section));
  return block ? block.split('\n').slice(1).map((line) => line.replace(/^>\s?/, '')).join(' ').trim() : '';
}
