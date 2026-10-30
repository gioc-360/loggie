// Classmates' names back on this Mac (loggie-class-notes, docs/class-notes/spec.md 1.6). A class's notes leave and come
// back with "Student 1", "Student 2" for the classmates (transcriber/spike/privacy.py mask_classmates), and every notes
// file keeps those labels, because six readers send the notes on to a model (C1). The names come back only where the
// user reads them, from the map held.json keeps beside the held sentences. Pure; the same contract as privacy.unmask,
// held to it by one shared fixture (transcriber/spike/fixtures/class-unmask-cases.json).

// summary.py kind_of: the event's category when it has one, else a course code in the title.
export const isClass = (event = {}) => (event.category ? event.category === 'class' : /\b[A-Z]{2,4}\s?\d{4}\b/.test(String(event.title || '')));
// privacy.py trims: an interview, by its category or a whole word of its title; its people leave by first name only, and
// no word around an (unclear) one is sent anywhere (loggie-interview-privacy).
export const isTrimmed = (event = {}) => !isClass(event) && (/interview/i.test(String(event.category || '')) || /\binterviews?\b/i.test(String(event.title || '')));

// "Student N" (any case, possessive kept) -> the map's name, "(unclear)" after it when every mention was unclear;
// "Students 1 and 2", "Students 1, 2 and 3" -> the names joined the same way. A label the map lacks stays as it is.
export function unmask(text, names) {
  if (!names || typeof names !== 'object' || typeof text !== 'string') return text;
  const nameOf = (n) => {
    const entry = names[`Student ${n}`];
    return entry ? `${entry.name}${entry.unclear ? ' (unclear)' : ''}` : null;
  };
  const joined = text.replace(/\b[Ss]tudents \d+(?:, \d+)*,? and \d+\b/g, (whole) => {
    const got = (whole.match(/\d+/g) || []).map(nameOf);
    return got.every(Boolean) ? `${got.slice(0, -1).join(', ')} and ${got.at(-1)}` : whole;
  });
  return joined.replace(/\b[Ss]tudent (\d+)\b/g, (whole, n) => nameOf(n) || whole);
}

// privacy.py relabel for a trimmed call's map ({ "Jonathan": { forms: ["Jonathan Mendoza", "Mendoza"] } }): every form,
// longest first, whole word, becomes its first name. For words that leave the Mac outside the screened copy (a title).
export function trimNames(text, trimmed) {
  if (!trimmed || typeof trimmed !== 'object' || typeof text !== 'string') return text;
  const pairs = Object.entries(trimmed).flatMap(([first, entry]) => (entry?.forms || []).map((form) => [String(form), first])).sort((a, b) => b[0].length - a[0].length);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return pairs.reduce((out, [form, first]) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}'’-])${escape(form)}(?![\\p{L}\\p{N}-])`, 'gu'), first), text);
}
