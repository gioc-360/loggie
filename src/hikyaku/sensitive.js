// The sensitive-file screen (docs/hikyaku-security.md, rule 4 and step 5). It decides, on this Mac, whether the text
// of an attachment may be shown to the drafting agent. Deny by default: a file reaches the agent only when the code
// layer finds nothing AND a model on this Mac confirms it. There is no model on this Mac any more (Gio, 2026-10-18), so
// every file stays local; the code layer still names why for the files it recognizes.
//
// The code layer: file-name and text patterns for grades, health, money, identity numbers, a third person's private
// matters, "confidential", and text that tries to steer this screen. Cheap, deterministic, named reasons.
// Sensitive = grades/transcripts, health, money (bank, card, tax, aid, salary), IDs (SSN, passport, license, student
// ID numbers), anything about a third person's private matters; when unsure, it stays local (the user, 2026-10-04).

// A payment card number has a check digit (Luhn). Random digit runs pass it one time in ten, so a hit is named as
// such; ISBN-13 book numbers (978/979...) are left out, or every reading list would stay local.
export function luhnValid(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function cardNumbers(text) {
  const found = [];
  for (const match of String(text).matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (/^97[89]/.test(digits) && digits.length === 13) continue;
    if (luhnValid(digits)) found.push(digits);
  }
  return found;
}

// A table of grades by person: a header that says grade, then rows that end in a letter grade and carry a number.
export function gradeRows(text) {
  const lines = String(text).split('\n');
  const header = lines.findIndex((line) => /\b(grade|score|gpa)\b/i.test(line) && /\b(student|name|id|netid)\b/i.test(line));
  if (header < 0) return 0;
  return lines.slice(header + 1, header + 60).filter((line) => /^[A-Za-z][^\n]*\d[^\n]*\s(?:[A-D][+-]?|F)\s*$/.test(line.trimEnd())).length;
}

// Each rule: where it looks, what it looks for, the category and the reason the card shows. First hit wins.
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\b|\b\d{2,3},\d{3}\b\s*(?:USD|dollars|per year|a year|annually)/;
export const CODE_RULES = Object.freeze([
  // Text that tries to steer this screen. Checked first: whatever else the file holds, this alone keeps it local.
  { id: 'steering', where: 'text', category: 'injection', reason: 'the file tells the screen what to decide',
    test: /this (?:file|document|attachment|pdf) (?:is|was) (?:not|non)[- ]?(?:sensitive|confidential|private)|not sensitive\W{0,3}(?:send|share|forward|pass) it|ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|rules)|disregard (?:the |your |all )?(?:previous |prior )?(?:instructions|rules)|mark (?:this|it) (?:as )?(?:safe|not sensitive|public)|classify (?:this|it) as (?:safe|not sensitive|public)|["']?sensitive["']?\s*[:=]\s*false|answer (?:with )?["']?(?:false|not sensitive)|you are (?:now )?(?:an? )?(?:ai|assistant|model|screen)\b[^\n]{0,80}\b(?:must|should|will) (?:answer|say|reply|return)|send (?:this|it) to the agent/i },
  { id: 'name', where: 'name', category: 'unsure', reason: 'the file name says what it is',
    test: /transcript|grade|gpa|\bw-?2\b|\b1099|\b1040\b|\b1098|\btax|pay(?:slip|stub|check)|offer[ _-]?letter|salary|comp(?:ensation)?[ _-]?(?:package|summary|letter)|medical|diagnos|prescription|passport|\bssn\b|licen[cs]e|\bbank|statement|invoice|receipt|confidential|fafsa|financial[ _-]?aid|aid[ _-]?award|\bloan|insurance|\bclaim|\bvisa\b|\bi-?20\b|\bi-?94\b|ds-?2019|\bdob\b|birth[ _-]?cert/i },
  { id: 'transcript', where: 'text', category: 'grades', reason: 'grades or a transcript',
    test: /\btranscript\b|\bgrade report\b|\breport card\b|\bgradebook\b|\bgrade roster\b|\bgpa\b\s*(?:of|:|=|is)?\s*\d|\bgrade point average\b|\bcumulative gpa\b|\bacademic (?:probation|standing|warning)\b|\bfinal grades? (?:for|of|:)/i },
  { id: 'grade-table', where: 'text', category: 'grades', reason: 'a table of grades by person', test: (text) => gradeRows(text) >= 2 },
  { id: 'ssn', where: 'text', category: 'identity', reason: 'a Social Security number', test: /\b\d{3}-\d{2}-\d{4}\b|\bssn\b|\bsocial security (?:number|no\.?|#)/i },
  { id: 'card', where: 'text', category: 'money', reason: 'a payment card number (passes the Luhn check)', test: (text) => cardNumbers(text).length > 0 },
  { id: 'card-words', where: 'text', category: 'money', reason: 'payment card details', test: /\b(?:cvv|cvc|cvv2)\b|\bcard (?:number|no\.?)\s*[:#]|\bexpir(?:y|ation)\s*(?:date)?\s*[:#]?\s*\d{1,2}\/\d{2}/i },
  { id: 'bank', where: 'text', category: 'money', reason: 'bank account details',
    test: /\biban\b|\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}[A-Z0-9]{0,16}\b|\brouting (?:number|no\.?|#)|\baccount (?:number|no\.?|#)\s*:?\s*\d|\b(?:swift|bic)\s*(?:code)?\s*:|\bbank statement\b|\bwire (?:transfer )?instructions\b|\bsort code\b/i },
  { id: 'tax', where: 'text', category: 'money', reason: 'a tax form or tax details',
    test: /\bw-?2\b(?!\d)|\bw-?4\b(?!\d)|\b1099(?:-[A-Z]{1,4})?\b|\b(?:form|irs)\s+1040\b|\b1040\s+(?:form|tax)|\b1098-?T\b|\b1095-?[ABC]\b|\btax (?:return|form|withholding|statement|transcript)\b|\btaxable income\b|\bwage and tax\b|\bemployer identification number\b|\bein\s*[:#]/i },
  { id: 'aid', where: 'text', category: 'money', reason: 'financial aid or tuition details',
    test: /\bfinancial aid\b|\bfafsa\b|\b(?:scholarship|grant|aid) award\b|\baward letter\b|\bexpected family contribution\b|\bstudent aid index\b|\bloan (?:disbursement|servicer|balance)\b|\btuition (?:bill|statement|balance)\b|\bbursar\b|\bpell grant\b/i },
  { id: 'pay', where: 'text', category: 'money', reason: 'pay or an offer with figures',
    test: (text) => /\bpay ?(?:slip|stub)\b|\bpaycheck\b|\bearnings statement\b/i.test(text) || (/\boffer letter\b|\b(?:base|annual|starting) salary\b|\bsalary\b|\bcompensation\b|\bsigning bonus\b|\bstock options\b|\brsus?\b|\bhourly rate\b|\bequity grant\b/i.test(text) && MONEY.test(text)) },
  { id: 'id', where: 'text', category: 'identity', reason: 'an identity document or number',
    test: /\bpassport (?:number|no\.?|#)|\bpassport\s*[:#]\s*[A-Z0-9]{6,}|\bdriver'?s? licen[cs]e\b|\blicen[cs]e (?:number|no\.?|#)|\bstate id\b|\bstudent (?:id|number)\s*(?:number|no\.?)?\s*[:#]?\s*\d{5,}|\bdate of birth\b|\bdob\s*[:#]|\bvisa (?:number|no\.?)|\bi-?20\b|\bi-?94\b|\bsevis\b|\balien (?:registration )?number\b/i },
  { id: 'health', where: 'text', category: 'health', reason: 'health or medical details',
    test: /\bdiagnos(?:is|ed)\b|\bprescri(?:ption|bed)\b|\bmedical (?:record|history|leave|certificate|condition|note|excuse)\b|\bdoctor'?s note\b|\bhipaa\b|\bicd-?10\b|\bpatient (?:name|id|record|chart)\b|\bclinic visit\b|\bdosage\b|\b\d+\s?mg\b[^\n]{0,30}\b(?:daily|twice|once|every)\b|\bhospitali[sz]ed\b|\bsurgery\b|\btherapist\b|\bdisability (?:services|accommodation)\b|\baccommodation (?:letter|request)\b|\bmental health\b/i },
  { id: 'personal', where: 'text', category: 'third-party', reason: "a person's private situation",
    test: /\b(?:medical|family|personal) emergency\b|\bbereavement\b|\bpassed away\b|\bdivorc(?:e|ed|ing)\b|\bcustody\b|\b(?:immigration|visa) status\b|\bdisciplinary\b|\bpregnan(?:t|cy)\b|\bin recovery\b|\bsuspended\b|\barrest(?:ed)?\b|\blaid off\b|\bterminated\b|\b(?:difficult|hard) (?:family|personal) (?:situation|circumstances)\b|\bpersonal circumstances\b|\bhardship\b|\bfinancial difficult/i },
  { id: 'confidential', where: 'text', category: 'confidential', reason: 'marked confidential',
    test: /\bconfidential\b|\bnot for distribution\b|\bdo not (?:distribute|forward|share|circulate)\b|\bprivileged\b|\binternal (?:use )?only\b|\bunder (?:embargo|nda)\b/i },
]);

// The code layer. Returns the first rule hit, or null when nothing matched. Pattern rules read the text with its
// line breaks flattened, so "academic\nprobation" at a page's line wrap still counts; rules that need the lines
// (the grade table) read it as it is.
export function codeScreen({ name = '', text = '' }) {
  const raw = String(text), flat = raw.replace(/\s+/g, ' ');
  for (const rule of CODE_RULES) {
    const subject = rule.where === 'name' ? String(name) : typeof rule.test === 'function' ? raw : flat;
    const hit = typeof rule.test === 'function' ? rule.test(subject) : rule.test.test(subject);
    if (hit) return { rule: rule.id, category: rule.category, reason: rule.reason };
  }
  return null;
}

const closed = (reason) => ({ sensitive: true, category: 'unsure', reason, by: 'closed' });

// One file. A code hit names its reason; anything else stays local too, because nothing on this Mac can confirm it.
export async function screenFile({ name, text }) {
  const hit = codeScreen({ name, text });
  if (hit) return { sensitive: true, category: hit.category, reason: hit.reason, by: 'code', rule: hit.rule };
  return closed('kept local: no screen on this Mac can confirm a file is not private');
}
