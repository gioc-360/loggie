// The Notes & Meetings tab's data: every recorded call with its state, and one call opened with its summary, next steps,
// transcript and the user's own typed notes (loggie-meetings-tab, spec b I2). Read-only: nothing here writes.
//
// The summary shown is the one the user sees elsewhere: the output file of the newest run in summary-runs.json that is
// not empty (byo.py claims an empty summary-<provider>-N.md before it writes, so the newest file by time can be blank).
// Older local calls have only notes.md + checks.json; those are read the same way, without minutes.

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname as dirOf, join } from 'node:path';
import { unmask } from './class-names.js';
import { listPages, newestPageAt } from './call-pages.js';
import { cleanSaid } from './clean-said.js';
import { marked, readMarks } from './note-marks.js';

const exists = (path) => stat(path).then(() => true, () => false);
const readText = (path) => readFile(path, 'utf8').catch(() => '');
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const first = (name = '') => String(name).trim().toLowerCase().split(/\s+/)[0] || '';
const norm = (text = '') => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const CALL_ID = /^[\w-]{1,120}$/;
export const NOTES_FILE = 'my-notes.md';

// "[04:42]", "[1:02:03]", "[170:25]", "[04:42, 05:10]", "[00:00–59:14]" -> seconds of the first time; "[??:??]" -> null.
export function parseStamp(stamp) {
  const match = /(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(String(stamp || ''));
  if (!match) return null;
  const [, a, b, c] = match;
  return c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
}

// The model sometimes writes a line saying it found nothing ("No explicit next step recorded", "No explicit decisions
// were stated"). It is not a point, so it is not shown.
export const isFiller = (text) => /^no (explicit |clear )?(next steps?|decisions?|action items?)\b/i.test(String(text).trim());

// A reason worded for a person, from byo.py's check reasons or notes.py's not_sure list.
export function plainWhy(reason = '') {
  const text = String(reason).trim();
  if (!text) return 'Words not found in the call';
  if (/quote not found|no quote/i.test(text)) return 'Quote not found in the call';
  if (/not said within|near that minute|stamp/i.test(text)) return 'Words not found near that minute';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// One bullet of either format: "text (Owner) [mm:ss] (not sure)" (byo.py) or "**text** (Owner)  _not sure: why_" (notes.py).
export function parseBullet(raw) {
  let text = String(raw).replace(/^\s*[-*]\s+/, '').trim();
  let unsure = false;
  let why = '';
  const tail = /\s*_not sure:\s*([^_]*)_\s*$/i.exec(text);
  if (tail) { unsure = true; why = tail[1].trim(); text = text.slice(0, tail.index).trim(); }
  if (/\(not sure\)\s*$/i.test(text)) { unsure = true; text = text.replace(/\s*\(not sure\)\s*$/i, '').trim(); }
  // A bullet can end in more than one stamp ("[07:21, 08:13] [??:??]"): all are taken off, and the minute is the last
  // one that has a time (the checker appends its own after the model's).
  let at = null;
  for (let stamp; (stamp = /\s*\[([^\]]*\d{1,3}:\d{2}[^\]]*|\?\?:\?\?)\]\s*$/.exec(text));) {
    if (at === null) at = parseStamp(stamp[1]);
    text = text.slice(0, stamp.index).trim();
    if (/\(not sure\)\s*$/i.test(text)) { unsure = true; text = text.replace(/\s*\(not sure\)\s*$/i, '').trim(); }
  }
  // The quote a checked point rests on (byo.py writes it before the minute: 'text "four to eight words" [mm:ss]') is
  // the record's, not the reader's: the minute already opens that moment. Only a quote of 4 words or more comes off,
  // so a point that ends on a quoted name ("target the 8 GB normies") keeps it.
  for (let quote; text.length && (quote = /\s*(?:\/\s*)?["“]([^"“”]+)["”]\s*$/.exec(text)) && quote[1].trim().split(/\s+/).length >= 4 && quote.index > 0;) text = text.slice(0, quote.index).trim();
  let owner = null;
  const who = /\s*\(([^()]{1,40}(?:\([^()]*\))?)\)\s*$/.exec(text);
  if (who && !/^(unclear|to check)$/i.test(who[1].trim())) { owner = who[1].trim(); text = text.slice(0, who.index).trim(); }
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').trim();
  return { text, owner, at, unsure, why };
}

// "Speaker 3 (Taisu)" -> "Taisu"; "Me (Gio)" -> "Me (Gio)" stays mine; anything else as written.
export const ownerName = (owner) => { const inner = /\(([^()]+)\)\s*$/.exec(owner || ''); return inner && !/^me\b/i.test(owner) ? inner[1].trim() : (owner || ''); };
// Same rule as calls.js ownSteps: owner "Me", or the user's own first name.
export const isMine = (owner, me) => first(owner) === 'me' || Boolean(first(me) && first(owner) === first(me));

// Markdown summary -> sections of lines and the Next steps. Headings "## X"; bullets "- " at any depth; quotes and the
// italic model lines are skipped.
export function parseSummary(markdown, { me = '', checks = [] } = {}) {
  const reasons = new Map(checks.map((check) => [norm(check.text || check.bullet || check.next_step), check]));
  const sections = [];
  const steps = [];
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1].replace(/\s*\(not sure\)\s*$/i, '').trim();
      current = /^next steps?$/i.test(name) ? { steps: true } : { heading: name, lines: [] };
      if (!current.steps) sections.push(current);
      continue;
    }
    if (!current || !/^\s*[-*]\s+/.test(line)) continue;
    const bullet = parseBullet(line);
    if (!bullet.text || isFiller(bullet.text)) continue;
    if (/^\s{2,}[-*]\s/.test(line)) bullet.detail = true;   // a nested point: drawn indented, draft and final alike
    const check = reasons.get(norm(bullet.text));
    if (check && check.backed === false) bullet.unsure = true;
    if (bullet.unsure) bullet.why = plainWhy(bullet.why || check?.why || check?.reasons?.[0] || check?.not_sure?.[0]);
    if (current.steps) steps.push({ ...bullet, who: ownerName(bullet.owner), mine: isMine(bullet.owner, me) });
    // Only a next step has an owner: a point's closing parenthesis is its own words ("invite flow (type "invite")").
    else current.lines.push(bullet.owner ? { ...bullet, text: `${bullet.text} (${bullet.owner})`, owner: null } : bullet);
  }
  return { sections: sections.filter((section) => section.lines.length), steps };
}

// The notes while the AI writes them (byo.py summary-live.md, 2026-10-12): the model's draft before the checks. Only
// whole lines show, so the page fills a line or two at a time and never shows half a word; the quote each bullet
// cites (and any HTML comment) is cut, leaving the text and its minute.
export const LIVE_SUMMARY = 'summary-live.md';
export function parseDraft(markdown, { me = '' } = {}) {
  const text = String(markdown || '');
  const whole = text.slice(0, text.lastIndexOf('\n') + 1).replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');
  const lines = whole.split('\n').map((line) => {
    const cited = /^(\s*[-*]\s+.*?)\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\][\s\S]*$/.exec(line);
    return cited ? `${cited[1]} [${cited[2]}]` : line;
  });
  return parseSummary(lines.join('\n'), { me });
}

// "[mm:ss] Who: text" lines of transcript-timed.txt.
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^\[([\d:]+)\]\s*([^:]{1,60}):\s?(.*)$/.exec(line);
    if (match) out.push({ at: parseStamp(match[1]), who: match[2].trim(), text: match[3] });
  }
  return out;
}

// The newest non-empty cloud summary of a call folder: { file, dir, text, checks, at } or null. The call folder's own
// summary-runs.json first. A call re-read later (v2-check, v3-nvidia, ...) may hold its only summaries in those
// folders: then the newest Nebius one there, never a Claude test run (hikyaku summaries are NVIDIA models only). The
// transcript shown is the one in the same folder, so the minutes match.
async function newestRun(dir, providers = null) {
  const runs = await readJson(join(dir, 'summary-runs.json'));
  const usable = (Array.isArray(runs) ? runs : []).filter((run) => run?.output && (!providers || providers.includes(run.provider)));
  for (const run of usable.slice().reverse()) {
    const text = await readText(join(dir, run.output));
    // A class's notes keep "Student N" on disk (loggie-class-notes); `names` is the map of the pair they were made from,
    // for callDetail to put the names back on screen. Everything that reads summaryOf's text keeps the labels.
    const held = run.privacy?.held_file && /^held(?:-\d+)?\.json$/.test(run.privacy.held_file) ? await readJson(join(dir, run.privacy.held_file)) : null;
    // A trimmed call (an interview) carries its first-name map as `trimmed`: nothing to restore, but the name check reads it.
    // `outbound`: the screened copy these notes were written from (the call's newest pair then), for a later reader that
    // sends the call's words on (look-outside.js): never outbound.md by name, which can be an older, untrimmed screen.
    const outbound = /^outbound(?:-\d+)?\.md$/.test(String(run.privacy?.outbound || run.sent || '')) ? (run.privacy?.outbound || run.sent) : null;
    if (text.trim()) return { file: join(dir, run.output), dir, text, checks: Array.isArray(run.checks) ? run.checks : [], at: run.created || null, names: held?.names || null, trimmed: held?.trimmed || null, outbound,
      // The spellings the user's words proved for this pair (spelling.py), shown on the page as made on their own.
      spelled: held?.spelled && typeof held.spelled === 'object' ? held.spelled : null };
  }
  return null;
}
export async function summaryOf(folder) {
  const own = await newestRun(folder);
  if (own) return own;
  const notes = await readText(join(folder, 'notes.md'));
  if (notes.trim()) {
    const checks = (await readJson(join(folder, 'checks.json'))) || [];
    return { file: join(folder, 'notes.md'), dir: folder, text: notes, checks: checks.map((c) => ({ ...c, text: c.bullet || c.next_step })), at: null };
  }
  const versions = (await readdir(folder, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && /^v\d/.test(d.name));
  const found = (await Promise.all(versions.map((d) => newestRun(join(folder, d.name), ['nebius'])))).filter(Boolean);
  return found.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0] || null;
}

// Folder name "2026-10-09-1258-title" -> its local start time.
function startFromFolder(id) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/.exec(id);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])).toISOString() : null;
}

async function minutesOf(folder, event) {
  const header = (await readText(join(folder, 'transcript.md'))).split('\n').slice(0, 4).join(' ');
  const fromHeader = /(\d+) min\./.exec(header);
  if (fromHeader) return Number(fromHeader[1]);
  const span = Date.parse(event.end) - Date.parse(event.start);
  if (span > 0) return Math.round(span / 60000);
  const live = await readJson(join(folder, 'live', 'state.json'));
  const heard = Math.max(0, ...Object.values(live?.sides || {}).map((side) => Number(side?.heard_s) || 0));
  return heard ? Math.round(heard / 60) : null;
}

function peopleOf(event) {
  if (Array.isArray(event.emails) && event.emails.length) return event.emails.length + 1;
  const names = String(event.names || '').split(/,|\band\b/).map((n) => n.trim()).filter(Boolean);
  return names.length ? names.length + 1 : null;
}

// The newest send per call folder name, from runs/*/send.json (the send gate's record of the cloud summary's yes).
async function sendsByCall(home) {
  const byCall = new Map();
  const runs = await readdir(join(home, 'runs')).catch(() => []);
  for (const run of runs) {
    const send = await readJson(join(home, 'runs', run, 'send.json'));
    if (!send?.folder || send.what === 'next-move') continue;
    const id = basename(send.folder);
    const prior = byCall.get(id);
    if (!prior || String(send.created || '') > String(prior.created || '')) byCall.set(id, { ...send, run: send.run || run });
  }
  return byCall;
}

// Loggie's guessed workstream for a call no workstream holds: the router's newest unsure item for it.
async function guesses(home) {
  const out = new Map();
  for (const line of (await readText(join(home, 'changes.jsonl'))).split('\n')) {
    if (!line.startsWith('{"id":"call:')) continue;
    try {
      const item = JSON.parse(line);
      if (item.source === 'call' && !item.workstream && item.candidates?.length) out.set(item.thread, { workstream: item.candidates[0], itemId: item.id });
    } catch { /* a torn line is skipped */ }
  }
  return out;
}

const STATE_OF_SEND = { pending: 'waiting', sending: 'writing', failed: 'failed' };

// Poka-yoke (loggie-meetings-focus cycle 2): what backs a guess, in plain words, or '' when nothing does, and then the
// guess is not shown as one (2026-10-24: "M&T Bank Outreach" on a hackathon call; its only clue was the title "Meeting
// 3:25 PM"). A person on the call who is one of the workspace's people, else its name or a word of it said 3 or more
// times in the call. Read only for a call that has a guess.
export const SAID_ENOUGH = 3;
const wordCount = (text, word) => (String(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu')) || []).length;
export async function evidenceFor({ folder, event, guess, workstreams = [] }) {
  const card = workstreams.find((item) => item?.name === guess);
  if (!card) return '';
  const emails = (event?.emails || []).map((address) => String(address).toLowerCase());
  const person = (card.people || []).find((one) => one.address && emails.includes(String(one.address).toLowerCase()));
  if (person) return `${person.name || person.address} is on it`;
  const said = await readText(join(folder, 'transcript.md'));
  const counted = [card.name, ...(card.words || [])].filter((word) => String(word).trim().length >= 3)
    .map((word) => [word, wordCount(said, word)]).sort((a, b) => b[1] - a[1])[0];
  return counted && counted[1] >= SAID_ENOUGH ? `said “${counted[0]}” ${counted[1]} times` : '';
}

export function workstreamOf(event) {
  const name = event?.filed?.workstream || event?.workstream || '';
  return name && name !== 'none' ? name : null;
}

async function rowFor({ home, id, current, sends, guessed, workstreams = [] }) {
  const folder = join(home, 'calls', id);
  const event = await readJson(join(folder, 'event.json'));
  if (!event) return null;
  const hasTranscript = await exists(join(folder, 'transcript.md')) || await exists(join(folder, 'notes.md'));
  const send = sends.get(id);
  const stopLog = !hasTranscript ? await readFile(join(folder, 'stop.log'), 'utf8').catch(() => '') : '';
  const speechMissing = /missing NVIDIA model|nemo-speech.*(?:No such file|not found)/i.test(stopLog);
  let state = 'done';
  if (current.includes(id)) state = 'recording';
  else if (speechMissing) state = 'failed';
  else if (!hasTranscript && await exists(join(folder, 'stop.log'))) state = 'transcribing';
  else if (send && STATE_OF_SEND[send.status]) state = STATE_OF_SEND[send.status];
  else if (!hasTranscript) state = 'empty';
  const workstream = workstreamOf(event);
  // In no workspace on purpose (refile.js "No workspace"): not to file, and Loggie guesses nothing for it.
  const noWorkspace = !workstream && Boolean(event.filed?.none);
  const guess = workstream || noWorkspace ? null : guessed.get(id) || null;
  const names = await readJson(join(folder, 'name-checks.json'));
  const evidence = guess ? await evidenceFor({ folder, event, guess: guess.workstream, workstreams }) : '';
  return {
    // The call's time is the press (recorded_at, call.py start, 2026-10-27), not the start of the event it was named after.
    // A call from before recorded_at has the press in its folder name (2026-10-28): 7 of 36 showed a block's start, 12 to 74 min off.
    id, title: event.title || id, ...(event.title_by_hand ? { titleByHand: true } : {}), start: event.recorded_at || startFromFolder(id) || event.start, eventId: event.id || null, minutes: await minutesOf(folder, event), names: names?.status || null,
    people: peopleOf(event), workstream, ...(noWorkspace ? { noWorkspace: true } : {}), guess: guess?.workstream || null, guessItem: guess?.itemId || null, evidence,
    // Filed under a workspace he retired (loggie-workspaces-integration): the chip keeps the name, muted, and says so.
    ...(workstream && workstreams.some((item) => item?.retired && String(item.name).toLowerCase() === workstream.toLowerCase()) ? { retired: true } : {}),
    // The pages tucked into it (loggie-pause-attach), by name: the fusen tab's count and the call page's list.
    pages: await listPages(folder),
    state, run: ['waiting', 'writing', 'failed'].includes(state) ? send?.run || null : null, reason: state === 'failed' ? (speechMissing ? 'Your recording is saved. The local NVIDIA speech models are missing, so transcription could not start. Install the speech components, then retry transcription.' : send?.reason || null) : null,
  };
}

// Every call, newest first. A folder with no event.json is not a call and is skipped.
export async function listCalls({ home }) {
  const ids = (await readdir(join(home, 'calls'), { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && CALL_ID.test(d.name)).map((d) => d.name);
  const recording = await readJson(join(home, 'calls', 'current.json'));
  // Record both (2026-10-28): the one recording feeds its own folder and the second meeting's (`also`); both record.
  const also = [].concat(recording?.also || []).filter((dir) => typeof dir === 'string' && dir).map((dir) => basename(dir));
  const current = recording?.dir ? [basename(String(recording.dir)), ...also] : [];
  const since = Number(recording?.started) ? new Date(Number(recording.started) * 1000).toISOString() : null;
  // Paused (loggie-pause-attach): current.json's paused_at and paused_s, so the card's clock holds and skips paused minutes.
  const pausedAt = Number(recording?.paused_at) ? new Date(Number(recording.paused_at) * 1000).toISOString() : null;
  const paused = { paused: Boolean(pausedAt), pausedAt, pausedSeconds: Number(recording?.paused_s) || 0 };
  const [sends, guessed, workstreams] = await Promise.all([sendsByCall(home), guesses(home), readJson(join(home, 'workstreams.json'))]);
  const rows = (await Promise.all(ids.map((id) => rowFor({ home, id, current, sends, guessed, workstreams: Array.isArray(workstreams) ? workstreams : [] })))).filter(Boolean)
    .map((row) => (row.state === 'recording' ? { ...row, since: since || row.start, ...paused } : row));
  return rows.sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
}

// The turns to show: transcript.md (one paragraph per turn, with the (unclear) marks the name check reads) when it has
// turns, else transcript-timed.txt (one line per sentence, no marks).
async function transcriptOf(dir, folder) {
  for (const file of [join(dir, 'transcript.md'), join(folder, 'transcript.md'), join(dir, 'transcript-timed.txt'), join(folder, 'transcript-timed.txt')]) {
    const turns = parseTranscript(await readText(file));
    if (turns.length) return { turns, file };
  }
  // While the call records, and while stop writes the full transcript, the live reader's lines (live.py
  // write_readable, every piece of about 30 s) are the transcript there is.
  const live = parseTranscript(await readText(join(folder, 'live', 'transcript-live.md')));
  return { turns: live, file: null, live: live.length > 0 };
}

// The line said in the call that shares the most of a point's words, found on the Mac with no model: what the popup
// shows when no explanation came back. Words of 3 letters or more, the "(unclear)" marks ignored; null under 2 shared.
export function closestSaid(text, turns) {
  const wordsOf = (value) => new Set(norm(plainText(value)).split(' ').filter((word) => word.length > 2));
  const want = wordsOf(text);
  let best = null, score = 1;
  for (const turn of turns) {
    const have = wordsOf(turn.text);
    const shared = [...want].filter((word) => have.has(word)).length;
    if (shared > score) { best = turn; score = shared; }
  }
  if (!best) return null;
  const said = cleanSaid(best.text);
  return { text: said.length > 160 ? `${said.slice(0, 157).trim()}…` : said, at: best.at };
}

// Is a next step a message to someone? (2026-10-12: the Notes page offers "Draft it" only on those; Gio, "do we need
// the write it?": most steps are work, and a draft box on "finish the UI test" does nothing.) Read from the step's own
// words, since a move has no recipient until it is first drafted. A message verb that always means writing to someone
// (email, invite, text, reply, follow up, thank, ping, introduce) counts on its own; one that often does not (ask, tell,
// remind, update, share, send) counts only with a capitalized name after it or after "to"/"with". Returns { to } (the
// name, or null) or null.
const ALWAYS = /\b(e-?mail|invite|text|message|reply(?: to)?|respond(?: to)?|follow(?:[- ]up)? (?:up )?with|follow up|thank|ping|introduce|intro|dm|whatsapp)\b/i;
const WITH_NAME = /\b(ask|tell|remind|update|share|send|loop in|cc|write to|let)\b/i;
const NAME = /^(?:[A-Z][\w'’-]+)(?:\s+[A-Z][\w'’-]+)?/;
const NOT_A_NAME = /^(?:The|A|An|All|Everyone|Them|Us|Our|My|Your|Each|Every|Both|Team|UI|API|PM|AI|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
function nameAfter(text, at) {
  const rest = text.slice(at).replace(/^[\s,:]+/, '');
  const m = NAME.exec(rest);
  return m && !NOT_A_NAME.test(m[0]) ? m[0].replace(/['’]s$/, '') : null;
}
export function messageOf(text) {
  const said = String(text || '');
  const toWith = /\b(?:to|with)\s+(?=[A-Z])/.exec(said);
  const named = toWith ? nameAfter(said, toWith.index + toWith[0].length) : null;
  const always = ALWAYS.exec(said);
  if (always) return { to: nameAfter(said, always.index + always[0].length) || named };
  const weak = WITH_NAME.exec(said);
  if (weak) { const to = nameAfter(said, weak.index + weak[0].length) || named; return to ? { to } : null; }
  return null;
}

// Search every call's transcript (the rail's search box, 2026-10-12, Gio: "transcripts should be searchable"). A line
// matches when it holds every word typed, in any order, ignoring case and the "(unclear)" marks; a call matches when its
// title, workstream or notes hold every word, or any of its lines does. Returns [{ id, count, hits: [{ index, at, who,
// text }] }] with at most `perCall` hits each, `index` being the line's place on the call's transcript page.
export const searchWords = (query) => [...new Set(String(query || '').toLowerCase().split(/\s+/).filter((word) => word.length > 1 || /\d/.test(word)))].slice(0, 8);
const plainText = (text) => String(text || '').replace(/\s+\(unclear\)/g, '');
export async function searchCalls({ home, query, perCall = 3 }) {
  const words = searchWords(query);
  if (!words.length) return [];
  const has = (text) => { const hay = plainText(text).toLowerCase(); return words.every((word) => hay.includes(word)); };
  const out = [];
  for (const call of await listCalls({ home })) {
    const folder = join(home, 'calls', call.id);
    const summary = await summaryOf(folder);
    const turns = (await transcriptOf(summary?.dir || folder, folder)).turns;
    const hits = [];
    turns.forEach((turn, index) => { if (has(turn.text)) hits.push({ index, at: turn.at, who: turn.who, text: cleanSaid(turn.text) }); });
    const named = has([call.title, call.workstream, call.guess, summary?.text, await readText(join(folder, NOTES_FILE))].filter(Boolean).join(' '));
    if (hits.length || named) out.push({ id: call.id, count: hits.length, hits: hits.slice(0, perCall) });
  }
  return out;
}

// The file a call's transcript page shows, for an edit (transcript-edit.js): the same one transcriptOf picks.
export async function transcriptFileOf({ home, id }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  const summary = await summaryOf(folder);
  return (await transcriptOf(summary?.dir || folder, folder)).file;
}

// One call opened. tasks: Core's task list, to tie each of the user's next steps to the move it became (I7); retired:
// retired.json, so a step already done or dropped says so.
// The live transcript alone, for the page's fast look while a call records (proposal-live-stream.md): one small file,
// no list, no summary. The stream keeps live/transcript-live.md about a second behind the voices; null when the call has
// a finished transcript or no live one.
export async function liveTranscript({ home, id }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  if (await exists(join(folder, 'transcript.md'))) return null;
  const turns = parseTranscript(await readText(join(folder, 'live', 'transcript-live.md')));
  return { id, transcript: turns.map((turn) => ({ ...turn, text: cleanSaid(turn.text), raw: turn.text })) };
}

// The name check's record with the spellings made on their own (loggie-auto-spelling) as `auto`: { heard: { to, rule,
// source } }, less any the user kept as heard with ✕. The page draws them as written, each saying where it came from.
export function withSpelled(check, spelled) {
  const auto = Object.fromEntries(Object.entries(spelled || {}).filter(([heard, fix]) => fix?.to && !check?.kept?.[heard]));
  if (!Object.keys(auto).length) return check;
  return { ...(check || { v: 1, status: 'done', words: {}, accepted: {}, kept: {}, added: {} }), auto };
}

// Who Them was, when them.py was not sure at Stop (or two people carry the first name said): the label now, up to three
// names to pick from, and the invite's name when it was the only evidence. Null once decided alone or picked by hand.
export function themAsk(event = {}) {
  const found = event.them_found;
  const choices = Array.isArray(found?.choices) ? found.choices.filter((name) => typeof name === 'string' && name.trim()).slice(0, 3) : [];
  if (!found || event.them_by_hand || (found.decided && !choices.length)) return null;
  return { label: event.them_label || 'Them', choices, invite: found.invite || null };
}

export async function callDetail({ home, id, tasks = [], retired = {} }) {
  if (!CALL_ID.test(String(id))) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  const row = (await listCalls({ home })).find((call) => call.id === id);
  if (!row) throw new Error('That call is not on this Mac.');
  const event = (await readJson(join(folder, 'event.json'))) || {};
  const stored = await summaryOf(folder);
  // A class: the names back in, on this Mac only, on every text the page shows (both sides of every match).
  const restore = (text) => unmask(text, stored?.names);
  const summary = stored && { ...stored, text: restore(stored.text), checks: stored.checks.map((check) => ({ ...check, text: restore(check.text), ...(check.line ? { line: restore(check.line) } : {}) })) };
  const { sections, steps } = parseSummary(summary?.text || '', { me: event.me || '', checks: summary?.checks || [] });
  const ours = tasks.filter((task) => String(task.sourceId || '').startsWith(`call:${id}#`) || String(task.sourceId || '').startsWith(`callstep:${id}:`));
  // A step finds its move by title; the notes the call was filed from can word it differently from the summary shown,
  // so failing that, the open move sharing the most words (at least half of the step's) that no other step took.
  const STOP = new Set(['the', 'and', 'for', 'with', 'one', 'are', 'was', 'that', 'this', 'from', 'into', 'about', 'your', 'our']);
  const wordsOf = (text) => new Set(norm(text).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
  const taken = new Set();
  const moveFor = (text) => {
    const exact = ours.find((task) => !taken.has(task.id) && norm(task.title) === norm(text));
    if (exact) { taken.add(exact.id); return exact; }
    const want = wordsOf(text);
    let best = null, score = 0;
    for (const task of ours) {
      if (taken.has(task.id)) continue;
      const have = wordsOf(task.title);
      const shared = [...want].filter((w) => have.has(w)).length;
      if (shared > score) { best = task; score = shared; }
    }
    if (!best || score < Math.max(2, Math.ceil(want.size / 2))) return null;
    taken.add(best.id);
    return best;
  };
  const notesAt = (await stat(join(folder, NOTES_FILE)).catch(() => null))?.mtimeMs || 0;
  const pagesAt = await newestPageAt(folder);
  const summaryFileAt = summary ? (await stat(summary.file).catch(() => null))?.mtimeMs || 0 : 0;
  const said = await transcriptOf(summary?.dir || folder, folder);
  const transcriptAt = said.file && /transcript\.md$/.test(said.file) ? (await stat(said.file).catch(() => null))?.mtimeMs || 0 : 0;
  // The draft file exists from the moment the AI is asked until the checked notes are written (byo.py).
  const liveFile = [join(summary?.dir || folder, LIVE_SUMMARY), join(folder, LIVE_SUMMARY)];
  const drafting = row.state === 'writing' && (await exists(liveFile[0]) || await exists(liveFile[1]));
  const draft = drafting ? restore(await readText(liveFile[0]) || await readText(liveFile[1])) : null;
  // The points the checks could not confirm, each with the AI's explanation (byo.py explain_unsure) and your answer
  // to it (note-marks.js): the page draws them as a link to that explanation.
  const explainFile = summary ? summary.file.replace(/\.md$/, '-explain.json') : null;
  const explainedStored = explainFile ? await readJson(explainFile) : null;
  const explained = explainedStored && { ...explainedStored, lines: (explainedStored.lines || []).map((item) => ({ ...item, text: restore(item.text), context: restore(item.context), instead: restore(item.instead),
    said: (item.said || []).map((x) => ({ ...x, text: restore(x.text) })) })) };
  // Keyed by the point as the page shows it: a point's text in the checks can still carry the quote the AI wrote inline.
  const keyOf = (text) => norm(plainText(text));
  const shown = (text) => { const bullet = parseBullet(`- ${text}`); return keyOf(bullet.owner ? `${bullet.text} (${bullet.owner})` : bullet.text); };
  const reads = new Map((explained?.lines || []).map((item) => [shown(item.text), item]));
  const marks = await readMarks(folder);
  const turns = (await transcriptOf(summary?.dir || folder, folder)).turns;
  // Where each point came from: the AI's context and the sentences said, checked (byo.py explain_points); until those
  // arrive, the line the checker matched it to (summary-runs.json checks), or for a point not confirmed, the closest
  // line said. Everything here is read on the Mac.
  const matched = new Map((summary?.checks || []).filter((check) => check.line).map((check) => [shown(check.text), check.line]));
  const saidOf = (raw) => { const m = /^\[([\d:]+)\]\s*([^:]{1,60}):\s?(.*)$/.exec(String(raw || '')); return m ? { text: cleanSaid(m[3]).slice(0, 280), who: /^me$/i.test(m[2].trim()) ? 'You' : m[2].trim(), at: parseStamp(m[1]) } : null; };
  const withSource = (line) => {
    const item = reads.get(keyOf(line.text));
    const said = item?.said?.length ? item.said.map((x) => ({ text: cleanSaid(x.text), who: x.who, at: parseStamp(x.at) })) : [saidOf(matched.get(keyOf(line.text)))].filter(Boolean);
    const near = !said.length && line.unsure ? closestSaid(line.text, turns) : null;
    const source = { context: item?.context || '', holds: item?.holds || '', instead: item?.instead || '', said, near: near ? { text: near.text, who: 'Closest', at: near.at } : null };
    // Confidently wrong (2026-10-12): a point shows the words the speech readers heard, without their "(unclear)" marks.
    const shownLine = line.unsure ? marked({ ...line, source }, marks) : { ...line, source };
    return { ...shownLine, text: plainText(shownLine.text) };
  };
  return {
    ...row,
    summarized: Boolean(summary), summaryAt: summary?.at || null,
    // Summarize again only changes anything when the notes are newer than the summary (byo.py reuses a saved answer
    // for an unchanged request), so the panel offers it only then.
    notesNewer: Boolean(notesAt && (!summary || notesAt > summaryFileAt)),
    // A page tucked in after the notes were written (loggie-pages-anytime): Summarize again adds it.
    pagesNewer: Boolean(summary && pagesAt > summaryFileAt),
    // Explanations are still coming while the run that wrote these notes is going (byo.py asks after the notes).
    explaining: row.state === 'writing' && !drafting && Boolean(summary) && !explained,
    // Notes written before explanations existed: the page asks for them on the first click (send-gate.js explainCall).
    explained: Boolean(explained),
    sections: sections.map((section) => ({ ...section, lines: section.lines.map(withSource) })),
    steps: steps.map(withSource).map((step) => {
      const task = step.mine ? moveFor(step.original || step.text) : null;
      const gone = task ? retired[task.id] : null;
      return { ...step, moveId: task?.id || null, closed: gone?.why || (task?.status === 'done' ? 'done' : null), message: step.mine ? messageOf(step.text) : null };
    }),
    // Edited lines (transcript-edit.js) are newer than the notes until the call is summarized again.
    transcriptNewer: Boolean(summary && transcriptAt > summaryFileAt && await exists(join(dirOf(said.file), 'transcript.before-edit.md'))),
    // Each turn cleaned for reading (clean-said.js), and as said in `raw`, for "Exact words" and the name check's marks.
    transcript: said.turns.map((turn) => ({ ...turn, text: cleanSaid(turn.text), raw: turn.text })),
    transcriptLive: Boolean(said.live),
    // Only transcript.md is what the notes are written from, so only it can be edited.
    transcriptEditable: Boolean(transcriptAt) && !['recording', 'transcribing', 'writing'].includes(row.state),
    // The notes while the AI writes them, a line or two at a time.
    draft: draft === null ? null : parseDraft(draft, { me: event.me || '' }),
    notes: await readText(join(folder, NOTES_FILE)),
    them: themAsk(event),
    // The name check (name-check.js): each (unclear) word's state, and what the user accepted or kept.
    nameCheck: withSpelled(await readJson(join(folder, 'name-checks.json')), stored?.spelled),
  };
}
