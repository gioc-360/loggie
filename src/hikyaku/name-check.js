// The name check (loggie-search-check, mock a): after the user's yes on a call, every word the two speech readers heard
// differently ("Qualtrics (unclear)") gets one of four states, which the Notes & Meetings tab draws:
//   sure    heard right: the yellow clears
//   fix     a different spelling, with where it came from: the user's own words first (workstream names, my-words.txt),
//           then the web (Tavily); the page shows it as a suggestion, nothing changes without a tap
//   none    checked and nothing found, or not searched (a common word, or not sure what it is): stays yellow
//   person  a name: never searched, stays yellow
// A person's name never goes into a search: code drops names it knows (people on the call, Contacts), Nemotron sorts the
// rest, and a word it is not sure of is not searched. A spelling is kept only if the source it came from contains it;
// a model's guess with no source is dropped. Spikes on Gio's calls, 2026-10-12: 0 of 8 people searched; the three wrong
// web answers (MNT, Loki, UB) were words his own data knew, hence the own-words step before the web.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CALL_ID, summaryOf, workstreamOf } from './call-list.js';
import { isClass, isTrimmed } from './class-names.js';

export const NAMES_FILE = 'name-checks.json';
export const WORDS_FILE = 'my-words.txt';
export const MAX_WEB = 8;          // searches per call, so a three-hour class cannot use up the credits
export const MAX_WORDS = 60;       // words sent to the sort in one request

const norm = (text = '') => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
const readText = (path) => readFile(path, 'utf8').catch(() => '');
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
export async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 1)}\n`);
  await rename(temp, path);
}

// The first JSON value in a model's reply that parses (replies can carry words before or after it).
export function firstJson(text) {
  const decoder = String(text || '');
  for (let i = 0; i < decoder.length; i += 1) {
    if (decoder[i] !== '[' && decoder[i] !== '{') continue;
    for (let j = decoder.length; j > i; j -= 1) {
      if (decoder[j - 1] !== ']' && decoder[j - 1] !== '}') continue;
      try { return JSON.parse(decoder.slice(i, j)); } catch { /* try a shorter span */ }
    }
  }
  return null;
}

// The words marked "(unclear)" in the given texts, each once, with the words around its first use (marks removed).
export function unclearWords(...texts) {
  const words = new Map();
  for (const text of texts) {
    const source = String(text || '');
    for (const match of source.matchAll(/(\S+)\s+\(unclear\)/g)) {
      const heard = match[1].replace(/^[^\w&]+|[^\w&']+$/g, '').replace(/'s$/i, '');
      if (!heard || words.has(heard)) continue;
      const context = source.slice(Math.max(0, match.index - 110), match.index + match[0].length + 80).replace(/\s*\(unclear\)/g, '').replace(/\s+/g, ' ').trim();
      words.set(heard, { heard, context });
    }
  }
  return [...words.values()];
}

// my-words.txt lines: "Canonical: heard, heard" (lexicon.py my_words), comments with #.
export function parseMyWords(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const [canonical, rest = ''] = line.split(':');
    entries.push({ canonical: canonical.trim(), heardAs: rest.split(',').map((w) => w.trim()).filter(Boolean) });
  }
  return entries;
}

// The user's own words: workstream names and my-words.txt, each with where it came from (shown as the source).
export async function readLexicon({ home, workstreams = [] }) {
  const entries = [];
  for (const w of workstreams) if (w?.name && !/^(chats|inbox)$/i.test(w.name)) entries.push({ text: w.name, label: `your workstream "${w.name}"` });
  for (const e of parseMyWords(await readText(join(home, WORDS_FILE)))) entries.push({ text: e.canonical, label: 'your words (my-words.txt)', heardAs: e.heardAs });
  return entries;
}

// Words that are people by what the Mac already knows: the people on the call and Contacts names.
export function knownPeople({ event = {}, contacts = [], transcript = '' }) {
  const out = new Set();
  const add = (text) => { for (const w of String(text || '').split(/[^A-Za-z'-]+/)) if (w.length >= 3) out.add(w.toLowerCase()); };
  add(event.names); add(event.attendees); add(event.with); add(event.me);
  for (const email of event.emails || []) add(String(email).split('@')[0].replace(/[._\d]+/g, ' '));
  for (const name of contacts) if (/\s/.test(String(name))) add(name);       // people have two names; a one-word contact may be a company
  for (const m of String(transcript).matchAll(/\(([A-Z][a-z]+)\)/g)) add(m[1]); // "Speaker 3 (Taisu)"
  return out;
}

const sortPrompt = (words, lexicon) => `Each line is a word a speech recognizer was unsure of, with the words around it from a recorded call.
For each, say what it most likely is: person (any person's or pet's name or nickname), company, product, place, or other
(a common word, a day or month, a filler, a letter). confident is true only when the words around it make it clear; when
it could be a person, say person.
mine: if the word is most likely one of these words the user already uses, the exact text from this list that should
replace the heard word (it can be part of an entry, like "M&T" from "M&T Bank"), else null.
Words the user uses: ${JSON.stringify(lexicon.map((e) => e.text))}
${words.map((w, i) => `${i}: "${w.heard}" in: ${w.context}`).join('\n')}
Reply with JSON only: [{"i": 0, "kind": "company", "confident": true, "mine": null}, ...] one object per line, in order.`;

const judgePrompt = (word, results) => `A speech recognizer heard "${word.heard}" in: ${word.context}
Search results:
${JSON.stringify(results)}
If a result clearly names what was meant, give its exact spelling as written in that result, and that result's url.
If not, spelling is null. Reply with JSON only: {"spelling": "...", "url": "..."}`;

// Soundex: words that sound alike share a code ("Lockie", "Loki", "Loggie" -> L200). Used only against the user's own
// words, where a match is still a suggestion the user taps.
export function soundex(word) {
  const letters = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = letters[0], last = code[letters[0]] || 0;
  for (const ch of letters.slice(1)) {
    const c = code[ch] || 0;
    if (c && c !== last) out += c;
    if (ch !== 'H' && ch !== 'W') last = c;
    if (out.length === 4) break;
  }
  return out.padEnd(4, '0');
}

// "M&T Bank" for the heard "MNT" in "MNT Bank": the words already after it are not repeated ("M&T").
export function trimFollowing(to, heard, context) {
  const after = String(context || '').slice(String(context || '').indexOf(heard) + heard.length).trim().split(/\s+/);
  const parts = String(to).split(/\s+/);
  for (let n = parts.length - 1; n >= 1; n -= 1) {
    if (parts.slice(n).every((p, k) => norm(p) === norm(after[k]))) return parts.slice(0, n).join(' ');
  }
  return to;
}

// How far apart two spellings are, 0 (same) to 1 (nothing shared): edits over the longer length.
export function distance(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 1;
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[y.length] / Math.max(x.length, y.length);
}
// A web spelling must still be the word that was heard, misheard: close in letters or in sound. "Helten" -> "Hilton"
// passes; "Mac" -> "Loggie" (the workstream leaking into the search) and "UB" -> "University at Buffalo" do not.
export const resembles = (heard, spelling) => distance(heard, spelling) <= 0.5 || soundex(heard) === soundex(String(spelling).split(/\s+/)[0]);

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the web'; } };

// Runs the check for one call and writes name-checks.json. ask(prompt) -> reply text (Nemotron on Token Factory);
// search(query) -> results (Tavily), or null to check against the user's own words only.
export async function checkNames({ home, id, ask, search = null, workstreams = [], contacts = [], now = () => new Date() }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  const file = join(folder, NAMES_FILE);
  const event = (await readJson(join(folder, 'event.json'))) || {};
  const summary = await summaryOf(folder);
  // transcript.md carries the (unclear) marks (transcript-timed.txt does not), one paragraph per turn.
  const transcript = (await readText(join(summary?.dir || folder, 'transcript.md'))) || (await readText(join(folder, 'transcript.md')));
  // Only spoken text: the summary's bullets and headings and the transcript's turns, never a file's own header (the
  // transcript header says "A word marked (unclear) is ...").
  const spoken = (text) => String(text || '').split('\n').filter((line) => /^\s*(\[\d|[-*]\s|##\s)/.test(line)).join('\n');
  const words = unclearWords(spoken(summary?.text), spoken(transcript));
  const prior = (await readJson(file)) || {};
  const record = { v: 1, status: 'checking', at: now().toISOString(), words: {}, queries: [], accepted: prior.accepted || {}, kept: prior.kept || {}, added: prior.added || {}, note: null };
  await writeJson(file, record);

  const workstream = workstreamOf(event);
  const lexicon = await readLexicon({ home, workstreams });
  const people = knownPeople({ event, contacts, transcript });
  // A class (loggie-class-notes 1.7): the words around an (unclear) word name classmates, so nothing is sorted by the
  // cloud AI or searched. The classmates the notes labeled are people; the rest are the user's own-words steps only.
  const inClass = isClass(event);
  if (inClass) for (const entry of Object.values(summary?.names || {})) for (const form of entry.forms || []) for (const part of String(form).split(/\s+/)) people.add(part.toLowerCase());
  const left = [];
  for (const w of words) {
    const lower = w.heard.toLowerCase();
    // A number is a figure, not a name: figures are not checked (cut 2026-10-12).
    if (/\d/.test(w.heard)) { record.words[w.heard] = { kind: 'none', why: 'A number: not checked' }; continue; }
    const heardAs = lexicon.find((e) => (e.heardAs || []).some((h) => h.toLowerCase() === lower));
    const sounds = (part) => /^[A-Za-z][A-Za-z'-]{3,}$/.test(part) && norm(part) !== norm(w.heard) && soundex(part) === soundex(w.heard);
    const alike = /^[A-Za-z]{4,}$/.test(w.heard) && lexicon.find((e) => e.text.split(/\s+/).some(sounds));
    // "&" said aloud is heard as "n" or "and" ("M&T" -> "MNT"): decided here, so it never rests on the model's sort.
    const spoken = (part) => part.includes('&') && [part.replace(/&/g, 'n'), part.replace(/&/g, 'and')].some((said) => norm(said) === norm(w.heard));
    const said = lexicon.find((e) => e.text.split(/\s+/).some(spoken));
    if (people.has(lower)) record.words[w.heard] = { kind: 'person' };
    else if (heardAs) record.words[w.heard] = { kind: 'fix', to: heardAs.text, from: 'words', source: { label: heardAs.label } };
    else if (said) record.words[w.heard] = { kind: 'fix', to: said.text.split(/\s+/).find(spoken), from: said.heardAs ? 'words' : 'workstream', source: { label: said.label } };
    else if (alike) record.words[w.heard] = { kind: 'fix', to: alike.text.split(/\s+/).find(sounds), from: alike.heardAs ? 'words' : 'workstream', source: { label: alike.label } };
    else if (lexicon.some((e) => norm(e.text) === norm(w.heard) || e.text.split(/\s+/).some((part) => norm(part) === norm(w.heard)))) record.words[w.heard] = { kind: 'sure', from: 'words' };
    else left.push(w);
  }

  // An interview (loggie-interview-privacy): the words around an (unclear) word come from transcript.md, where surnames
  // and held sentences are, so the same: only the own-words steps above.
  const trimmed = !inClass && (Boolean(summary?.trimmed) || isTrimmed(event));
  if (inClass || trimmed) {
    for (const w of left) record.words[w.heard] = { kind: 'none', why: inClass ? 'A class: not sorted or searched' : 'An interview: not sorted or searched' };
    record.note = inClass ? "A class: classmates' names stay on this Mac, so no word was sent." : "An interview: people's full names stay on this Mac, so no word was sent.";
    await writeJson(file, { ...record, status: 'done', at: now().toISOString() });
    return { ...record, status: 'done' };
  }
  // Nemotron sorts the rest; doubt means no search.
  const sortedReply = left.length ? firstJson(await ask(sortPrompt(left.slice(0, MAX_WORDS), lexicon))) : [];
  if (left.length && !Array.isArray(sortedReply)) record.note = 'The cloud AI did not sort the words, so none was searched.';
  const web = [];
  left.forEach((w, i) => {
    const row = (Array.isArray(sortedReply) ? sortedReply : []).find((r) => r?.i === i) || {};
    const mine = typeof row.mine === 'string' ? row.mine.trim() : '';
    const entry = mine && lexicon.find((e) => e.text.toLowerCase().includes(mine.toLowerCase()));
    if (row.kind === 'person') record.words[w.heard] = { kind: 'person' };
    else if (entry) record.words[w.heard] = norm(mine) === norm(w.heard) ? { kind: 'sure', from: 'words' } : { kind: 'fix', to: trimFollowing(mine, w.heard, w.context), from: entry.heardAs ? 'words' : 'workstream', source: { label: entry.label } };
    else if (!row.confident) record.words[w.heard] = { kind: 'none', why: 'Not searched: not sure what this word is' };
    else if (!['company', 'product', 'place'].includes(row.kind)) record.words[w.heard] = { kind: 'none', why: 'Not searched: a common word' };
    else if (web.length < MAX_WEB) web.push(w);
    else record.words[w.heard] = { kind: 'none', why: 'Not searched: this call reached its search limit' };
  });

  for (const w of web) {
    if (!search) { record.words[w.heard] = { kind: 'none', why: 'Not checked on the web' }; continue; }
    // The query is the word and the call's workstream: never the words around it, which can hold people's names.
    const query = [w.heard, workstream].filter(Boolean).filter((part) => !part.split(/\s+/).some((t) => people.has(t.toLowerCase()))).join(' ');
    let results;
    try {
      results = await search(query);
      record.queries.push({ query, at: now().toISOString(), results: results.length });
    } catch (error) {
      record.note = error.message;
      record.words[w.heard] = { kind: 'none', why: error.message };
      continue;
    }
    const answer = firstJson(await ask(judgePrompt(w, results))) || {};
    const spelling = String(answer.spelling || '').trim();
    const holder = spelling && results.find((r) => `${r.title} ${r.content}`.toLowerCase().includes(spelling.toLowerCase()));
    if (!holder) record.words[w.heard] = { kind: 'none', why: 'Nothing found on the web' };
    // The same word, or the same word inside a longer name ("Whisper" in "OpenAI Whisper"): heard right.
    else if (norm(spelling).includes(norm(w.heard))) record.words[w.heard] = { kind: 'sure', from: 'web' };
    else if (!resembles(w.heard, spelling)) record.words[w.heard] = { kind: 'none', why: 'Nothing found on the web' };
    else record.words[w.heard] = { kind: 'fix', to: spelling, from: 'web', source: { label: host(holder.url), url: holder.url } };
  }

  await writeJson(file, { ...record, status: 'done', at: now().toISOString() });
  return { ...record, status: 'done' };
}


// ✓ on a suggestion: the call shows the new spelling everywhere, and my-words.txt learns the heard form so the next call
// hears it right ("M&T: MNT"). What was added is kept so Undo takes back exactly that.
export async function acceptName({ home, id, heard }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const file = join(home, 'calls', id, NAMES_FILE);
  const record = await readJson(file);
  const word = record?.words?.[heard];
  if (word?.kind !== 'fix') throw new Error('That word has no suggestion.');
  const wordsFile = join(home, WORDS_FILE);
  const lines = (await readText(wordsFile)).split('\n');
  const at = lines.findIndex((line) => !line.trim().startsWith('#') && line.split(':')[0].trim() === word.to);
  let added;
  if (at === -1) {
    const end = lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length;
    lines.splice(end, 0, `${word.to}: ${heard}`);
    added = { to: word.to, newLine: true };
  } else {
    const entry = parseMyWords(lines[at])[0];
    if (entry.heardAs.some((h) => h.toLowerCase() === heard.toLowerCase())) added = { to: word.to, newLine: false, already: true };
    else { lines[at] = `${entry.canonical}: ${[...entry.heardAs, heard].join(', ')}`; added = { to: word.to, newLine: false }; }
  }
  await writeFile(wordsFile, lines.join('\n'));
  record.accepted[heard] = word.to;
  record.added[heard] = added;
  delete record.kept[heard];
  await writeJson(file, record);
  return { heard, to: word.to };
}

// ✕: the heard spelling stays and stops being yellow.
export async function keepName({ home, id, heard }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const file = join(home, 'calls', id, NAMES_FILE);
  // A spelling made on its own (spelling.py, the summary's held.json "spelled") can be kept as heard before the name
  // check ever ran on the call: the record starts here, and the next screen leaves the word as heard.
  const auto = (await summaryOf(join(home, 'calls', id)))?.spelled?.[heard];
  const record = (await readJson(file)) || (auto ? { v: 1, status: 'done', at: new Date().toISOString(), words: {}, queries: [], accepted: {}, kept: {}, added: {}, note: null } : null);
  if (!record?.words?.[heard] && !auto) throw new Error('That word was not checked.');
  record.kept = { ...(record.kept || {}), [heard]: true };
  await writeJson(file, record);
  return { heard };
}

// Undo after ✓: the suggestion is back, and my-words.txt loses what ✓ added.
export async function undoName({ home, id, heard }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const file = join(home, 'calls', id, NAMES_FILE);
  const record = await readJson(file);
  const added = record?.added?.[heard];
  if (!record?.accepted?.[heard]) return { heard, undone: false };
  if (added && !added.already) {
    const wordsFile = join(home, WORDS_FILE);
    const lines = (await readText(wordsFile)).split('\n');
    const at = lines.findIndex((line) => !line.trim().startsWith('#') && line.split(':')[0].trim() === added.to);
    if (at !== -1) {
      if (added.newLine) lines.splice(at, 1);
      else {
        const entry = parseMyWords(lines[at])[0];
        const rest = entry.heardAs.filter((h) => h.toLowerCase() !== heard.toLowerCase());
        lines[at] = rest.length ? `${entry.canonical}: ${rest.join(', ')}` : entry.canonical;
      }
      await writeFile(wordsFile, lines.join('\n'));
    }
  }
  delete record.accepted[heard];
  delete record.added[heard];
  await writeJson(file, record);
  return { heard, undone: true };
}

// The check after a call's summary, in the background: it never throws, and a failure is written so the page stops
// saying "Checking names".
export async function runNameCheck(options) {
  try { return await checkNames(options); }
  catch (error) {
    const file = join(options.home, 'calls', options.id, NAMES_FILE);
    const prior = (await readJson(file)) || {};
    await writeJson(file, { v: 1, words: {}, queries: [], accepted: {}, kept: {}, added: {}, ...prior, status: 'failed', note: error.message, at: new Date().toISOString() }).catch(() => {});
    return null;
  }
}
