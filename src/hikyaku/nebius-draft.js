// Do it on Nebius: the workstream is approved for nebius, so its move is drafted by one Token Factory request instead
// of an agent CLI. It reads exactly the room the cloud gate built for this move (cloud.js buildRoom: CONTEXT.md and the
// task's ROOM_INPUTS) and the workstream's voice files, gets back one JSON object naming the one result file, and
// writes that file into the room, where an agent would have written it. From there the run is the same as any other
// (headless.js): collectRoom brings the file back, outcomeOf decides, the draft opens in the mail app, nothing is sent.
//
// It is started through the same spawn seam as a CLI (nebiusSpawn returns a stand-in child process) so the state,
// Core session, receipt and outcome code stay one path. The stand-in prints one JSON line that parseNebiusRun reads.
//
// The request goes through the screen like every raw-mail path (cloud-screen.js thinkWith, built in desktop/main.js
// under the workstream's own nebius approval): addresses, links and held sentences are cut on this Mac before it leaves.
// This file never makes a cloud client; it is handed `complete(prompt) -> text`.
import { EventEmitter } from 'node:events';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ROOM_INPUTS, ROOM_OUTPUTS } from './cloud.js';
import { draftText } from './delta.js';
import { noEmDash } from './next-move.js';
import { guardTimes } from './draft-times.js';

export const VOICE_FILES = Object.freeze(['rules.md', 'recent.md', 'intros.md', 'texting.md']);
// An email draft reads how the user writes email; a chat draft reads how they text. texting.md in an email prompt made
// Super write "hi liz ... best, gio" (2 of 8 drafts in the offline test, 2026-10-16; docs/replies/spec-a.md R1).
export const EMAIL_VOICE = Object.freeze(['rules.md', 'recent.md', 'intros.md']);
export const CHAT_VOICE = Object.freeze(['rules.md', 'recent.md', 'texting.md']);
// A draft over this many times the user's usual length is asked once to cut itself (R3). Code never cuts words.
export const REASK_OVER = 1.2;
const RESULT_FILES = Object.freeze(['DRAFT.md', 'EVENT.json', 'NEEDS.md', 'YOUR-STEP.md', 'DONE.md']);

const ANSWER_SHAPE = `The files are below, each under a line "===== <path> =====", instead of in a folder; the voice files are under voice/. Do not ask to open anything else. Answer with one JSON object only, no other text: {"skip_steps": [<the numbers of the brief's Steps that NOTES.md makes pointless or already done; [] when there are no notes or none>], "file": "DRAFT.md" | "EVENT.json" | "NEEDS.md" | "YOUR-STEP.md" | "DONE.md", "content": "<that file's full text, which never carries out a skipped step; for EVENT.json the JSON object written as a string>", "subject": "<the subject line, only for a new email with no thread; else empty>"}`;

// The prompt: the run's own instructions (headlessPrompt), then the room's files and the voice as the data.
// Whether the person this move writes to already knows the user (loggie-do-it-context TC2: "the previous replies would
// have intro still when the recruiter already knows me"). Known when the move's own thread, or any other thread in the
// same workstream, has a message from them or one the user sent them, or the move came from a call. Read from files.
export async function knownContact(taskDirectory) {
  if (!taskDirectory) return null;
  const read = (path) => readFile(path, 'utf8').catch(() => '');
  let reply = null;
  try { reply = JSON.parse(await read(join(taskDirectory, 'REPLY.json')) || 'null'); } catch { reply = null; }
  const to = String(reply?.to || reply?.address || '').trim();
  if (await read(join(taskDirectory, 'CALL.md'))) return { to, why: 'you met on a call' };
  if (!to) return null;
  const key = to.toLowerCase();
  const own = await read(join(taskDirectory, 'THREAD.md'));
  const other = await readdir(dirname(taskDirectory)).catch(() => []);
  const threads = [own, ...await Promise.all(other.filter((name) => name !== basename(taskDirectory)).map((name) => read(join(dirname(taskDirectory), name, 'THREAD.md'))))];
  const count = threads.reduce((sum, text) => sum + text.split('\n').filter((line) => /^## /.test(line) && line.toLowerCase().includes(key)).length
    + text.split('\n').filter((line) => /^To: /.test(line) && line.toLowerCase().includes(key)).length, 0);
  return count ? { to, why: `${count} earlier message${count === 1 ? '' : 's'} between you` } : null;
}

export async function draftPrompt({ prompt, room, taskId, voiceDirectory, known = null, chat = false }) {
  const read = (path) => readFile(path, 'utf8').catch(() => '');
  const files = [];
  const context = await read(join(room, 'CONTEXT.md'));
  if (context) files.push(['CONTEXT.md', context]);
  // What the user told Loggie comes first and is labelled as fact: on 2026-10-10 the notes said "I already have an
  // interview this coming Friday" and the draft still asked for one, copying the old draft that sat in the room. The
  // old draft is left out: a rewrite starts from the thread and the notes, not from what it replaces.
  const notes = await read(join(room, taskId, 'NOTES.md'));
  for (const name of ROOM_INPUTS.filter((file) => !['NOTES.md', 'DRAFT.md'].includes(file))) {
    const text = await read(join(room, taskId, name));
    if (text) files.push([`${taskId}/${name}`, text]);
  }
  const calendar = await read(join(room, taskId, 'CALENDAR.md'));
  if (calendar) files.push([`${taskId}/CALENDAR.md`, calendar]);
  // How the user introduces themself is left out for someone who knows them: it is 11,000 characters of "My name is
  // Gio, and I'm..." examples, and drafts copied it into replies to a recruiter mid-thread (2026-10-11).
  for (const name of (chat ? CHAT_VOICE : EMAIL_VOICE).filter((file) => !(known && file === 'intros.md'))) {
    const text = await read(join(voiceDirectory, name));
    if (text) files.push([`voice/${name}`, text]);
  }
  // The notes go last, closest to the answer: placed first (2026-10-10) they were still outweighed by the brief's own
  // step "request an interview slot" and 11,000 characters of voice examples.
  if (known) files.push([`${taskId}/KNOWN.md (a fact checked by code)`, `${known.to || 'This person'} already knows the user: ${known.why}. Do not introduce the user, their school or their program, and do not say how they found each other. Write as the next message in a conversation that is already going.`]);
  if (notes) files.push([`${taskId}/NOTES.md (what the user told Loggie: facts that win over the brief, the thread and any earlier draft; leave out any step of the brief these make pointless, and never ask for something these say already happened. If these say the person asked the user for something, that ask is the move, even when the brief's own steps are finished)`, notes]);
  const instructions = `${String(prompt).split(voiceDirectory).join('voice')}\n\n${ANSWER_SHAPE}`;
  const data = files.map(([path, text]) => `===== ${path} =====\n${text}`).join('\n\n');
  return { text: `${instructions}\n\n${data}`, files: files.map(([path]) => path) };
}

// One draft, with at most one re-ask (R3): when the body runs over REASK_OVER times the user's usual length, the same
// prompt is sent once more with the count and the target, and the shorter valid draft is kept. The first answer is
// never lost: a bad or failed second answer keeps it. Chat drafts are never re-asked (texting.md has its own lengths).
export const bodyWords = (text) => draftText(text).split(/\s+/).filter(Boolean).length;
export async function draftOnce({ complete, text, chat = false, length = null }) {
  let answer = parseDraftAnswer(await complete(text));
  // An answer out of shape (Super once named SUBJECT.txt as its file: 1 of 8 drafts with a rules.md line, 3 of 27 at
  // temperature 1) is asked again once, and that is the one extra call: no length re-ask follows a retry.
  if (!answer.ok) {
    let retry;
    try {
      retry = parseDraftAnswer(await complete(`${text}\n\nYour last answer was not in the agreed shape (${answer.error}). Answer again with one JSON object only; "file" is exactly one of ${RESULT_FILES.join(', ')}, and a new email's subject goes in "subject".`));
    } catch { retry = null; }
    return { answer: retry?.ok ? retry : answer, reasked: false, retried: true };
  }
  const target = Number(length?.median) || 0;
  if (!answer.ok || answer.file !== 'DRAFT.md' || chat || target <= 0) return { answer, reasked: false };
  const words = bodyWords(answer.content);
  if (words <= REASK_OVER * target) return { answer, reasked: false, words };
  let second;
  try {
    second = parseDraftAnswer(await complete(`${text}\n\nYour draft was ${words} words. Cut it to ${target} words: keep every fact and the ask; drop offers to help more, repeated thanks and filler. Answer in the same JSON shape.`));
  } catch { second = null; }
  const shorter = second?.ok && second.file === 'DRAFT.md' && bodyWords(second.content) < words;
  return { answer: shorter ? second : answer, reasked: true, words: [words, shorter ? bodyWords(second.content) : words], target };
}

export async function readLength(voiceDirectory) {
  try {
    const length = JSON.parse(await readFile(join(voiceDirectory, 'length.json'), 'utf8'));
    return Number(length?.median) > 0 ? length : null;
  } catch { return null; }
}

// The answer becomes the one file it names, in the room. Anything else is a failed run with the reason in words.
// The first whole JSON object in the text, by matching braces outside strings: the model sometimes adds stray closing
// brackets after a valid object (live 2026-10-10: `{...}"}]}`).
export function firstObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseDraftAnswer(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let answer;
  const object = firstObject(text);
  // A model sometimes writes real line breaks inside a JSON string (Ultra, 2026-10-10); they are escaped and tried again.
  const escaped = (raw) => raw.replace(/"(?:[^"\\]|\\.)*"/gs, (str) => str.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
  try { answer = object ? JSON.parse(object) : null; } catch { try { answer = JSON.parse(escaped(object)); } catch { answer = null; } }
  if (!answer || typeof answer !== 'object') return { ok: false, error: 'the cloud AI did not answer in the agreed shape' };
  if (!RESULT_FILES.includes(answer?.file)) return { ok: false, error: `the cloud AI named no result file (${String(answer?.file || 'none').slice(0, 40)})` };
  const body = typeof answer.content === 'string' ? answer.content.trim() : answer.content && typeof answer.content === 'object' ? JSON.stringify(answer.content) : '';
  if (!body) return { ok: false, error: `the cloud AI wrote an empty ${answer.file}` };
  if (answer.file === 'EVENT.json') { try { JSON.parse(body); } catch { return { ok: false, error: 'the cloud AI wrote an event that is not JSON' }; } }
  // Em dashes become commas or periods, the same repair next moves get (next-move.js): Gio never writes them.
  const skipSteps = Array.isArray(answer.skip_steps) ? [...new Set(answer.skip_steps.filter((n) => Number.isInteger(n) && n > 0))] : [];
  return { ok: true, file: answer.file, content: answer.file === 'DRAFT.md' ? noEmDash(body).text : body, subject: typeof answer.subject === 'string' ? answer.subject.trim() : '', skipSteps };
}

// The steps the user's notes overrule leave the move (cycle 3, Gio 2026-10-10: "Fix the stale steps now"): the model
// only names step numbers; code removes exactly those numbered lines under "## Steps" in the task's BRIEF.md, renumbers
// the rest, and keeps the old brief beside it. Nothing happens without notes, or for a number the brief does not have.
export async function dropStaleSteps(taskDirectory, skipSteps, { now = new Date() } = {}) {
  const notes = (await readFile(join(taskDirectory, 'NOTES.md'), 'utf8').catch(() => '')).trim();
  if (!notes || !skipSteps?.length) return [];
  const brief = await readFile(join(taskDirectory, 'BRIEF.md'), 'utf8').catch(() => '');
  const lines = brief.split('\n');
  const start = lines.findIndex((line) => /^##\s+Steps\s*$/.test(line));
  if (start < 0) return [];
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const steps = lines.slice(start + 1, end).filter((line) => /^\d+\.\s/.test(line));
  const dropped = steps.filter((line) => skipSteps.includes(Number(line.match(/^(\d+)\./)[1])));
  if (!dropped.length || dropped.length === steps.length) return [];
  const kept = steps.filter((line) => !dropped.includes(line)).map((line, i) => line.replace(/^\d+\./, `${i + 1}.`));
  const body = [...kept, '', `(Left out because of your notes, ${now.toISOString().slice(0, 10)}: ${dropped.map((line) => line.replace(/^\d+\.\s*/, '')).join('; ')})`, ''];
  await writeFile(join(taskDirectory, `BRIEF.md.before-notes-${now.toISOString().replace(/[:.]/g, '-')}`), brief);
  await writeFile(join(taskDirectory, 'BRIEF.md'), [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n'));
  return dropped;
}

// The time guard on a move's draft (draft-times.js, loggie-intros fix 2): a clock time or date the draft states must be
// in what Loggie read for this move (the thread, the call, the syllabus, the attachments list), the user's own words
// (NOTES.md: their line and answers) or CALENDAR.md; anything else comes out for "[your times]". The brief and the
// context are the model's own summaries, not what was read, so they back up nothing.
const READ_FILES = Object.freeze(['THREAD.md', 'CALL.md', 'SYLLABUS.txt', 'ATTACHMENTS.json', 'SUBJECT.txt', 'CC.txt']);
export async function guardDraftTimes(roomTask, answer) {
  if (answer.file !== 'DRAFT.md') return { answer, note: '' };
  const read = (name) => readFile(join(roomTask, name), 'utf8').catch(() => '');
  const thread = (await Promise.all(READ_FILES.map(read))).join('\n');
  const times = guardTimes(answer.content, { thread, typed: await read('NOTES.md'), calendar: await read('CALENDAR.md') });
  return { answer: times.note ? { ...answer, content: times.text } : answer, note: times.note };
}

export async function writeDraftAnswer(roomTask, answer) {
  if (!ROOM_OUTPUTS.includes(answer.file)) throw new Error(`${answer.file} is not a result file`);
  await writeFile(join(roomTask, answer.file), `${answer.content}\n`);
  if (answer.file === 'DRAFT.md' && answer.subject) await writeFile(join(roomTask, 'SUBJECT.txt'), `${answer.subject}\n`);
}

// A spawnImpl for startHeadless: runs the request in this process and behaves like a child that printed one line
// ({"type": "nebius", ok, text, error}) and exited 0, or 1 when the request or the answer failed. `complete` is null
// when the workstream has no nebius yes; the cloud gate refuses before that, so this only says so if it ever happens.
export function nebiusSpawn({ complete, voiceDirectory, taskId, taskDirectory = null, chat = false } = {}) {
  return (_command, args, { cwd }) => {
    const child = new EventEmitter();
    child.pid = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(async () => {
      let line;
      try {
        if (typeof complete !== 'function') throw new Error('this workstream has no yes for the cloud AI, so nothing was sent');
        const { text } = await draftPrompt({ prompt: args.at(-1), room: cwd, taskId, voiceDirectory, known: await knownContact(taskDirectory), chat });
        const { answer, reasked, words, target } = await draftOnce({ complete, text, chat, length: chat ? null : await readLength(voiceDirectory) });
        if (!answer.ok) throw new Error(answer.error);
        const guarded = await guardDraftTimes(join(cwd, taskId), answer);
        await writeDraftAnswer(join(cwd, taskId), guarded.answer);
        const dropped = taskDirectory ? await dropStaleSteps(taskDirectory, answer.skipSteps) : [];
        const shortened = reasked ? ` Re-asked once: ${words[0]} then ${words[1]} words (target ${target}).` : '';
        line = { type: 'nebius', ok: true, text: `Wrote ${answer.file}.${dropped.length ? ` Left out of the move: ${dropped.join('; ')}` : ''}${shortened}${guarded.note ? ` ${guarded.note}` : ''}`, error: null };
      } catch (error) {
        line = { type: 'nebius', ok: false, text: '', error: error.message };
      }
      child.stdout.emit('data', `${JSON.stringify(line)}\n`);
      child.emit('close', line.ok ? 0 : 1);
    });
    return child;
  };
}

function lastLine(text) {
  return String(text || '').trim().split('\n').filter((line) => line.trim()).at(-1)?.slice(0, 300) || null;
}

// The run's one line, read back in the shape headless.js acts on: did it finish, its last words, and why it failed.
// There is no session to resume and nothing is ever refused mid-run, so sessionId is null and denied is empty.
export function parseNebiusRun(stdout, stderr = '') {
  const line = String(stdout).split('\n').filter(Boolean).map((text) => { try { return JSON.parse(text); } catch { return null; } })
    .filter((event) => event?.type === 'nebius').at(-1);
  return { sessionId: null, ok: Boolean(line?.ok), text: String(line?.text || ''), denied: [], error: line ? line.error || null : lastLine(stderr) || 'the cloud AI run stopped without an answer' };
}
