// The send gate (spec-entry-b.md A7, increment b#3a): nothing leaves the Mac until the user picks an AI and presses
// Send. One gate for both kinds of send, call notes (byo.py) and next moves (next_move, increment 4: a hook here).
//
//   prepare   on the Mac only: the source is screened (a call by privacy.py, from call.py; email threads by
//             screen-thread.js) and a pending send is recorded in <home>/runs/<run>/send.json:
//             { v, run, what: "call-notes" | "next-move", status, created, source_ids[], folder, outbound[], held[],
//               sha256[] (of each outbound file, as reviewed), workstream, title, sentences_sent, sentences_kept,
//               sources (next move only: { <thread id>: "gmail" | "outlook" | null }, where each thread came from) }
//             folder is the call's version folder, or for a next move the workstream folder.
//             Nothing is sent. The review is the plain outbound file ("What would leave your Mac").
//             status: pending, sending, sent, failed, declined (the user answered No), or superseded (a newer send for the
//             same workstream replaced it).
//             A next move may carry calls that joined its workstream, and a call no workstream matched is a next move
//             with workstream null and an `offer` of a new workstream (entry.js); it cannot be sent until placed.
//   options   ai.options: Nemotron on Nebius with its real connected status; the default is nebius.
//   decide    the one question after a call (spec-c.md B18): "Summarize with cloud AI? Yes / No". One send.decided per run.
//             No: status declined, nothing runs. Yes with a remembered pick: approve at once. First Yes: the picker (ai.options).
//   approve   ai.picked: provider + remember. A provider that is not connected is refused; an outbound file that
//             changed since the review is refused; only then does the send run, once:
//               call notes  <python> byo.py <folder> --with <provider> --approved <sha256 of the reviewed outbound.md>
//               next move   the nextMove hook, next-move.js runNextMove (increment b#3b); without it, refused
//             remember stores the pick in the workstream's "cloud" field in workstreams.json (rule 7's field) and in
//             <home>/cloud-pick.json, the pick for every workstream without its own. settings.json is never written.
//
// Events go to <home>/runs/<run>/events.jsonl (spec section 2), appended by call.py (sendgate.py) and by this file
// with one seq. An event's `text` never names a model or a provider; ai.* carry provider ids and labels in `data`,
// because there the user is choosing one. The keychain item is checked for existence only: its value is never read here.
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, emitScreen, readEvents, RUN_ID } from './events.js';
import { isPackaged } from './native-helper.js';
import { execRunner, screenThread } from './screen-thread.js';
import { slug } from './util.js';
import { updateWorkstreams } from './workstreams.js';

export const PROVIDERS = Object.freeze([
  Object.freeze({ id: 'nebius', label: 'Nemotron on Nebius' }),
]);
export const KEYCHAIN = Object.freeze({ service: 'nebius-token-factory', account: 'hikyaku' });
export { RUN_ID };
const ASK_TEXT = { 'call-notes': 'Writing your call notes', 'next-move': 'Writing your next move' };
const STEPS_OF = { 'call-notes': 3, 'next-move': 2 };   // screen, ask, file | screen, ask

export const runsRoot = (home) => join(home, 'runs');
const pad = (n) => String(n).padStart(2, '0');
export function newRunId(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString('hex')}`;
}
export function runDirectoryOf(home, run) {
  if (typeof run !== 'string' || !RUN_ID.test(run)) throw new Error('That is not a send hikyaku prepared.');
  return join(runsRoot(home), run);
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } };
// Which Python runs the transcriber, in which folder, and the environment it needs. Packaged, all three are inside the
// app (resources/python, resources/transcriber, resources/bin/ffmpeg) and nothing in the settings or the environment
// can point away from them. In dev it is python3 and the folder from HIKYAKU_TRANSCRIBER, the settings or ~/hikyaku.
// The bytecode switch keeps Python from writing into the signed app.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function transcriberRuntime(settings = {}, { env = process.env, packaged = isPackaged(), resourcesPath = process.resourcesPath } = {}) {
  if (packaged) {
    return { python: join(resourcesPath, 'python', 'bin', 'python3'), dir: join(resourcesPath, 'transcriber'), env: { HIKYAKU_FFMPEG: join(resourcesPath, 'bin', 'ffmpeg'), PYTHONDONTWRITEBYTECODE: '1' } };
  }
  // The transcriber ships inside this repo (transcriber/spike, since 2026-10-09); a checkout runs it from there.
  return { python: 'python3', dir: env.HIKYAKU_TRANSCRIBER || settings.transcriber || join(REPO_ROOT, 'transcriber', 'spike'), env: {} };
}

// --- events: one emitter for every event of every step (events.js); appendEvent is its name here.
export { readEvents };
export const appendEvent = emitEvent;

// --- prepare
async function writeSend(runDirectory, send) {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, 'send.json'), `${JSON.stringify(send, null, 1)}\n`);
  return send;
}
export async function readSend(runDirectory) {
  const send = await readJson(join(runDirectory, 'send.json'));
  if (!send || typeof send !== 'object') throw new Error('No prepared send in that run. Nothing was sent.');
  return send;
}

// `reviewed`: the sha256 of each outbound file as the user already reviewed it (a call moved under a workstream,
// entry.js), kept as is so a file that changed since still fails the check on Send; otherwise each file is hashed now.
export async function prepareSend({ home, what, sourceIds, folder = null, outbound, held, counts, workstream = null, title = null, sources = null, extra = {}, run = newRunId(), reviewed = null }) {
  if (!['call-notes', 'next-move'].includes(what)) throw new Error(`Unknown send "${what}".`);
  if (reviewed && reviewed.length !== outbound.length) throw new Error('Each outbound file needs the hash it was reviewed with. Nothing was prepared.');
  const hashes = reviewed ? [...reviewed] : [];
  if (!reviewed) for (const path of outbound) hashes.push(sha256(await readFile(path)));
  const total = (key) => counts.reduce((sum, item) => sum + (item?.[key] || 0), 0);
  return writeSend(runDirectoryOf(home, run), {
    v: 1, run, what, status: 'pending', created: new Date().toISOString(), source_ids: sourceIds, folder, outbound, held, sha256: hashes,
    workstream, title, sentences_sent: total('sent'), sentences_kept: total('held'), ...(sources ? { sources } : {}), ...extra,
  });
}

// A newer prepared send replaces older ones that are still waiting (the entry run, run twice, leaves one per
// workstream). They are marked "superseded", never deleted, so what was prepared stays readable.
export async function supersedeSends({ home, keep, matches }) {
  const replaced = [];
  for (const send of await pendingSends(home)) {
    if (send.run === keep || !matches(send)) continue;
    await writeSend(runDirectoryOf(home, send.run), { ...send, status: 'superseded', superseded_by: keep });
    replaced.push(send.run);
  }
  return replaced;
}

// Email threads of one workstream: each screened on the Mac, then one pending next-move send. Throws (nothing
// pending) when any screen cannot run. A thread may say where it came from (source "gmail" or "outlook"): the
// "Open draft in" step offers Gmail only for a thread that is in Gmail.
// `calls`: calls already screened on the Mac that joined this workstream (entry.js matchCall), each
// { id: "call:<call folder name>", outbound, held }. Their outbound.md and held.json are copied into the workstream
// (.outbound/call-<name>/, spec B7: "copied into the workstream") and join the send after the threads.
const CALL_ID = /^call:([A-Za-z0-9_.-]{1,120})$/;
export async function prepareNextMove({ home, workstream, workstreamDirectory, threads, transcriber, python = 'python3', runner = execRunner, me = null, calls = [] }) {
  const run = newRunId();
  const runDirectory = runDirectoryOf(home, run);
  await appendEvent(runDirectory, { type: 'run.started', data: { source: 'inbox', title: workstream, workstream } });
  await appendEvent(runDirectory, { type: 'step.started', step: 'screen', text: 'Screening on your Mac', data: { step: 'screen', index: 1, of: STEPS_OF['next-move'] } });
  const t0 = Date.now();
  const screened = [];
  try {
    for (const [index, thread] of threads.entries()) {
      screened.push(await screenThread({ threadId: thread.id, md: thread.md, workstreamDirectory, transcriber, python, me, runner }));
      await appendEvent(runDirectory, { type: 'step.progress', step: 'screen', data: { step: 'screen', done: index + 1, total: threads.length, unit: 'threads' } });
    }
  } catch (error) {
    await appendEvent(runDirectory, { type: 'step.finished', step: 'screen', data: { step: 'screen', ok: false, seconds: (Date.now() - t0) / 1000 } });
    await appendEvent(runDirectory, { type: 'run.failed', step: 'screen', text: 'Nothing was sent', data: { step: 'screen', reason: error.message, fix: 'Start the AI on this Mac, then screen the threads again.' } });
    throw error;
  }
  const joined = [];
  for (const call of calls) {
    const name = CALL_ID.exec(String(call.id || ''))?.[1];
    if (!name || name.includes('..')) throw new Error(`Not a call hikyaku can file: "${call.id}". Nothing was prepared.`);
    const folder = join(workstreamDirectory, '.outbound', `call-${name}`);
    await mkdir(folder, { recursive: true });
    const outbound = join(folder, 'outbound.md'), held = join(folder, 'held.json');
    await copyFile(call.outbound, outbound);
    await copyFile(call.held, held);
    const record = await readJson(held);
    if (!record?.counts) throw new Error(`The screen record for ${call.id} has no counts. Screen the call again. Nothing was prepared.`);
    joined.push({ thread_id: call.id, outbound, held, counts: record.counts, seconds: record.seconds ?? null, source: 'call' });
  }
  await appendEvent(runDirectory, { type: 'step.finished', step: 'screen', data: { step: 'screen', ok: true, seconds: (Date.now() - t0) / 1000 } });
  const items = [...screened, ...joined];
  for (const item of items) {
    await emitScreen(runDirectory, { source: item.source === 'call' ? 'call' : 'thread', sourceId: item.thread_id, outbound: item.outbound, held: item.held, seconds: item.seconds });
  }
  return prepareSend({ home, what: 'next-move', sourceIds: items.map((item) => item.thread_id), folder: workstreamDirectory, outbound: items.map((item) => item.outbound),
    held: items.map((item) => item.held), counts: items.map((item) => item.counts), workstream, title: workstream, run,
    sources: Object.fromEntries([...threads.map((thread) => [thread.id, ['gmail', 'outlook'].includes(thread.source) ? thread.source : null]), ...joined.map((item) => [item.thread_id, null])]) });
}

export async function pendingSends(home) {
  const runs = (await readdir(runsRoot(home)).catch(() => [])).filter((name) => RUN_ID.test(name)).sort();
  const out = [];
  for (const run of runs) {
    const send = await readJson(join(runsRoot(home), run, 'send.json'));
    if (send && (send.status === 'pending' || send.status === 'failed')) out.push({ ...send, title: (await callTitleOf(send)) || send.title });
  }
  return out;
}

// The title a call has now: an untitled call is named after its notes are prepared, and send.json keeps the old one.
async function callTitleOf(send) {
  if (send.what !== 'call-notes' || !send.folder) return null;
  for (const folder of [send.folder, dirname(send.folder)]) {
    const event = await readJson(join(folder, 'event.json'));
    if (event) return event.title || null;
  }
  return null;
}

// --- options
// The real check. nebius: the keychain item exists (`security find-generic-password` WITHOUT -w or -g, so its value
// is never printed or read).
export function defaultChecks({ runner = execRunner } = {}) {
  return {
    nebius: async () => (await runner('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account], {})).code === 0,
  };
}
const isConnected = async (checks, id) => { try { return Boolean(checks?.[id] && await checks[id]()); } catch { return false; } };

const isProvider = (id) => PROVIDERS.some((provider) => provider.id === id);
const onlyProvider = () => (PROVIDERS.length === 1 ? PROVIDERS[0].id : null);
// The workstream's own pick (its `cloud` field): the only yes that may send without the card (autoDecide).
async function workstreamPick(home, workstream) {
  if (!workstream) return null;
  const list = await readJson(join(home, 'workstreams.json'));
  const item = (Array.isArray(list) ? list : []).find((entry) => entry && typeof entry.name === 'string' && entry.name.trim().toLowerCase() === String(workstream).trim().toLowerCase());
  return isProvider(item?.cloud) ? item.cloud : null;
}
// The workstream's own pick wins; otherwise the pick made on the first Yes (cloud-pick.json).
async function rememberedPick(home, workstream) {
  const own = await workstreamPick(home, workstream);
  if (own) return own;
  const global = await readJson(join(home, 'cloud-pick.json'));
  return isProvider(global?.provider) ? global.provider : null;
}

export async function aiOptions({ home, run, checks }) {
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  const options = [];
  for (const provider of PROVIDERS) options.push({ ...provider, connected: await isConnected(checks, provider.id) });
  await appendEvent(runDirectory, { type: 'ai.options', step: 'ask', text: 'Which AI should write it?', data: { options, default: 'nebius' } });
  return { options, default: 'nebius', send };
}

// --- connect: "Connect" on an AI that is greyed out. The request is recorded (ai.connect) and nothing else happens:
// connecting an AI from Loggie is not built, so the option stays greyed until it is connected by hand.
export async function connectRequest({ home, run, provider }) {
  const runDirectory = runDirectoryOf(home, run);
  await readSend(runDirectory);
  const known = PROVIDERS.find((item) => item.id === provider);
  if (!known) throw new Error(`Pick one of ${PROVIDERS.map((item) => item.label).join(', ')}. Nothing was changed.`);
  await appendEvent(runDirectory, { type: 'ai.connect', step: 'ask', text: 'Connecting from here is not built yet', data: { run, provider } });
  return { recorded: true, connected: false, provider, reason: `Connecting ${known.label} from Loggie is not built yet. Nothing was changed.` };
}

// --- approve
// Remember is a side errand under the lock (workstreams.js updateWorkstreams): a file that cannot be read never stops
// the Send (the dead Send of 2026-10-12, 3f0276d); the global pick is still kept, and the miss is said in the log.
// A missing file stays missing: with no entry to mark, no list is returned and nothing is written.
async function rememberPick(home, workstream, provider) {
  if (workstream) {
    const key = String(workstream).trim().toLowerCase();
    await updateWorkstreams(home, (list) => {
      const item = (Array.isArray(list) ? list : []).find((entry) => entry && typeof entry.name === 'string' && entry.name.trim().toLowerCase() === key);
      if (!item) return {};
      item.cloud = provider;
      return { list };
    }).catch((error) => console.error(`hikyaku send: the pick was not saved on "${workstream}": ${error.message}`));
  }
  await writeFile(join(home, 'cloud-pick.json'), `${JSON.stringify({ provider, at: new Date().toISOString() }, null, 1)}\n`);
}

// The workstream a send belongs to now. A call is prepared before it is filed: one put under a workstream afterwards
// (the picker on the Notes & Meetings tab, refile.js) names it in its event.json, and send.json still says "none".
async function streamOf(send) {
  const own = send.workstream && send.workstream !== 'none' ? send.workstream : null;
  if (own || send.what !== 'call-notes' || !send.folder) return own;
  for (const folder of [send.folder, dirname(send.folder)]) {
    const event = await readJson(join(folder, 'event.json'));
    const name = event?.filed?.workstream || event?.workstream || '';
    if (event) return name && name !== 'none' ? name : null;
  }
  return null;
}

const lastLine = (result) => String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || `exit ${result.code}`;

// One decision and one approval at a time per run, claimed before the first await (Codex review, 2026-10-23: a Summarize
// press and the automatic yes both read "not decided" before either wrote it, and the notes were sent twice). A run
// already claimed is refused at once, the same as one already decided or being sent.
const deciding = new Set();
const approving = new Set();
async function claimed(set, run, refusal, work) {
  if (set.has(run)) throw new Error(refusal);
  set.add(run);
  try { return await work(); } finally { set.delete(run); }
}

export async function approveSend(options) {
  runDirectoryOf(options.home, options.run);
  return claimed(approving, options.run, 'This is being sent now.', () => approveOnce(options));
}
async function approveOnce({ home, run, provider, remember = false, checks, runner = execRunner, transcriber, python = 'python3', nextMove = null, file = null }) {
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  if (send.status === 'sent') throw new Error('This was already sent. Nothing was sent again.');
  if (send.status === 'sending') throw new Error('This is being sent now.');
  if (send.status === 'superseded') throw new Error('A newer send replaced this one. Review that one instead. Nothing was sent.');
  // A call no workstream matched (entry.js): it cannot go until it has one, or the move would land on no card.
  if (send.what === 'next-move' && !send.workstream) throw new Error('This call has no workspace yet. Start the new one it offers, or put it under one of yours, then press Send. Nothing was sent.');
  const known = PROVIDERS.find((item) => item.id === provider);
  if (!known) throw new Error(`Pick one of ${PROVIDERS.map((item) => item.label).join(', ')}. Nothing was sent.`);
  if (!await isConnected(checks, provider)) throw new Error(`${known.label} is not connected. Connect it, or pick another. Nothing was sent.`);
  if (send.what === 'next-move' && typeof nextMove !== 'function') throw new Error('Next moves are not built yet; this one stays ready to send. Nothing was sent.');
  for (const [index, path] of send.outbound.entries()) {
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || sha256(bytes) !== send.sha256[index]) throw new Error('What would leave your Mac changed since you reviewed it. Review it again, then press Send. Nothing was sent.');
  }
  // Remember is a side errand: a call on no workstream (or one since removed) is still sent, and only the global pick
  // is kept. It used to throw here, and the Send button looked dead (2026-10-12).
  const stream = await streamOf(send);
  if (remember) await rememberPick(home, stream, provider);
  await appendEvent(runDirectory, { type: 'ai.picked', step: 'ask', text: 'You pressed Send', data: { run, provider, remember: Boolean(remember), stream_id: stream ? slug(stream) : null } });
  await writeSend(runDirectory, { ...send, status: 'sending', provider, approved: new Date().toISOString() });
  const of = STEPS_OF[send.what];
  await appendEvent(runDirectory, { type: 'step.started', step: 'ask', text: ASK_TEXT[send.what], data: { step: 'ask', index: 2, of } });
  const t0 = Date.now();
  let outcome;
  try {
    if (send.what === 'call-notes') {
      // HIKYAKU_RUN: byo.py appends outbound.sent, outbound.returned and check.result to this run (sendgate.emit).
      // A second outbound file is the user's typed notes (outbound-notes.md, screened with the transcript): its hash goes
      // too, so byo.py adds them to the prompt only when this yes covered them.
      // A third is the pages tucked into the call (outbound-pages.md, loggie-pause-attach), the same way.
      const notes = send.outbound.findIndex((path) => basename(String(path)) === 'outbound-notes.md');
      const pages = send.outbound.findIndex((path) => basename(String(path)) === 'outbound-pages.md');
      const result = await runner(python, [join(transcriber, 'byo.py'), send.folder, '--with', provider, '--approved', send.sha256[0], ...(notes > 0 ? ['--approved-notes', send.sha256[notes]] : []), ...(pages > 0 ? ['--approved-pages', send.sha256[pages]] : []), ...(send.fresh ? ['--fresh'] : [])], { cwd: transcriber, env: { ...process.env, HIKYAKU_RUN: runDirectory } });
      outcome = result.code === 0 ? { ok: true } : { ok: false, reason: lastLine(result) };
    } else {
      const result = await nextMove({ send, provider, home, runDirectory });
      outcome = result?.ok === false ? { ok: false, reason: result.reason || 'the next move was not written' } : { ok: true };
    }
  } catch (error) { outcome = { ok: false, reason: error.message }; }
  await appendEvent(runDirectory, { type: 'step.finished', step: 'ask', data: { step: 'ask', ok: outcome.ok, seconds: (Date.now() - t0) / 1000 } });
  if (!outcome.ok) {
    await writeSend(runDirectory, { ...send, status: 'failed', provider, reason: outcome.reason });
    await appendEvent(runDirectory, { type: 'run.failed', step: 'ask', text: 'Nothing was written', data: { step: 'ask', reason: outcome.reason, fix: 'Read the reason, then press Send again or pick another AI.' } });
    return { ok: false, run, reason: outcome.reason };
  }
  let fileError = null;
  if (send.what === 'call-notes' && typeof file === 'function') {
    await appendEvent(runDirectory, { type: 'step.started', step: 'file', text: 'Putting it on your card', data: { step: 'file', index: 3, of } });
    const t1 = Date.now();
    try { await file(send.folder); } catch (error) { fileError = error.message; }
    await appendEvent(runDirectory, { type: 'step.finished', step: 'file', data: { step: 'file', ok: !fileError, seconds: (Date.now() - t1) / 1000 } });
  }
  await writeSend(runDirectory, { ...send, status: 'sent', provider, sent: new Date().toISOString(), ...(fileError ? { file_error: fileError } : {}) });
  await appendEvent(runDirectory, { type: 'run.finished', data: { ok: true, seconds: (Date.now() - t0) / 1000, moves: send.what === 'next-move' ? 1 : 0, sentences_sent: send.sentences_sent, sentences_kept: send.sentences_kept } });
  return { ok: true, run, provider, remembered: Boolean(remember), ...(fileError ? { fileError } : {}) };
}

// --- explain later: the points a call's notes could not confirm, explained on the first click when the notes were
// written before explanations existed (byo.py explain_later). It sends only what the yes for those notes covered: the
// newest sent call-notes send's outbound hash goes as --approved, so a copy screened again since is refused.
export async function explainCall({ home, id, transcriber, python = 'python3', runner = execRunner }) {
  const runs = (await readdir(runsRoot(home)).catch(() => [])).filter((name) => RUN_ID.test(name)).sort().reverse();
  let send = null;
  for (const run of runs) {
    const item = await readJson(join(runsRoot(home), run, 'send.json'));
    if (item?.what === 'call-notes' && item.status === 'sent' && basename(String(item.folder || '')) === id) { send = item; break; }
  }
  if (!send) throw new Error('These notes were not written through Loggie\'s send, so there is nothing to explain them from.');
  const result = await runner(python, [join(transcriber, 'byo.py'), 'explain', send.folder, '--with', send.provider || 'nebius', '--approved', send.sha256[0]],
    { cwd: transcriber, env: { ...process.env } });
  if (result.code === 0) return { ok: true, id };
  const why = lastLine(result);
  if (/changed since you reviewed/.test(why)) throw new Error('This call changed since its notes were written. Summarize again to explain these lines.');
  throw new Error(why);
}

// --- decide: the one question per call. "No" is one small function (declineSend): nothing is sent, and a call with a
// workstream is filed there as a transcript with no summary (spec-c.md B18, 9.5). A call with workstream "none" is
// only declined; the workstream.offer ask (entry.js) files it later.
async function declineSend(runDirectory, send, fileTranscript) {
  await writeSend(runDirectory, { ...send, status: 'declined', declined: new Date().toISOString() });
  if (send.what === 'call-notes' && send.workstream && send.workstream !== 'none' && typeof fileTranscript === 'function') await fileTranscript(send.folder, send.workstream);
  return { ok: true, declined: true, run: send.run };
}

// `pick`: the AI an automatic yes already chose (the setup yes for call notes, B5.4), in place of the remembered one;
// `by` names that yes on the send.decided event.
export async function decideSend(options) {
  if (options.decision !== 'yes' && options.decision !== 'no') throw new Error('Answer Yes or No. Nothing was sent.');
  runDirectoryOf(options.home, options.run);
  return claimed(deciding, options.run, 'This call was already decided. Nothing was sent.', () => decideOnce(options));
}
async function decideOnce({ home, run, decision, checks, runner = execRunner, transcriber, python = 'python3', nextMove = null, file = null, fileTranscript = null, auto = false, pick = null, by = null }) {
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  const events = send.status === 'pending' ? await readEvents(runDirectory) : [];
  const decided = events.find((event) => event.type === 'send.decided');
  // A Yes whose pick never came (the panel reloaded and lost the picker) asks for the pick again, with no second
  // send.decided; before, the card's Yes answered "already decided" and the call could never be summarized.
  if (decided && decision === 'yes' && decided.data?.decision === 'yes' && !events.some((event) => event.type === 'ai.picked')) {
    const { options, default: chosen } = await aiOptions({ home, run, checks });
    return { picker: true, options, default: chosen };
  }
  if (send.status !== 'pending' || decided) throw new Error('This call was already decided. Nothing was sent.');
  // One AI (Nemotron on Nebius): a first Yes uses it, so "Which AI should write it?" shows only when it is not
  // connected yet, where it says how to connect one (cleanup 2026-10-27: a choice with one option is not a choice).
  const remembered = decision === 'yes' ? pick ?? await rememberedPick(home, await streamOf(send)) ?? onlyProvider() : null;
  const pickShown = decision === 'yes' && !(remembered && await isConnected(checks, remembered));
  await appendEvent(runDirectory, { type: 'send.decided', step: 'ask', text: 'You decided', data: { run, decision, picker_shown: pickShown, ...(auto ? { auto: true } : {}), ...(by ? { by } : {}) } });
  if (decision === 'no') return declineSend(runDirectory, send, fileTranscript);
  if (pickShown) {
    const { options, default: chosen } = await aiOptions({ home, run, checks });
    return { picker: true, options, default: chosen };
  }
  return approveSend({ home, run, provider: remembered, remember: false, checks, runner, transcriber, python, nextMove, file });
}

// Summarize, the one button on a call (loggie-one-click-summarize, 2026-10-23): the press is the yes, with the AI the
// user picked before (the workstream's, then the global pick) or Nebius, the picker's default. A run the automatic yes
// already took is not an error: the notes are writing. An AI that is not connected still returns the picker.
export async function summarizeRun({ home, run, ...options }) {
  const send = await readSend(runDirectoryOf(home, run));
  // The automatic yes may have taken the run seconds before the press (2026-10-23: decided 5 s before Gio's press, whose
  // decideSend then saw a yes with no pick yet and answered with the picker, read as "No cloud AI is connected").
  // Only a yes that went on to write: an automatic one, or one with no picker shown. A yes whose picker was shown and
  // never answered still gets the picker back from decideSend (Codex review, 2026-10-23).
  const events = await readEvents(runDirectoryOf(home, run));
  if (events.some((event) => event.type === 'send.decided' && event.data?.decision === 'yes' && (event.data.auto || event.data.picker_shown === false))) return { ok: true, run, already: true };
  const pick = await rememberedPick(home, await streamOf(send)) ?? 'nebius';
  // That picker was shown because no AI was connected (no key yet). With one connected now, this press answers the
  // waiting yes; before, it got the picker again and the call read "No cloud AI is connected" for good (Codex review,
  // 2026-10-23).
  const atPicker = events.some((event) => event.type === 'send.decided' && event.data?.decision === 'yes') && !events.some((event) => event.type === 'ai.picked');
  try {
    if (atPicker && await isConnected(options.checks, pick)) return await approveSend({ ...options, home, run, provider: pick, remember: false });
    return await decideSend({ ...options, home, run, decision: 'yes', pick });
  } catch (error) {
    if (/already decided|being sent now|already sent/.test(error.message)) return { ok: true, run, already: true };
    throw error;
  }
}

// --- autoDecide: the card is skipped only when the user already said yes. Two reasons, both for a call-notes send that
// is still pending with no send.decided yet, both through decideSend and approveSend: the same gate as a click, so the
// screen has already run and the outbound file is hash-checked.
//   1. the workstream's own `cloud` field names a connected AI (not "none", not the global pick); filed with `file`.
//   2. the setup yes covers call notes (first-run-polish B5.4): `standing` says callsYes, a saved key and today's
//      cloud limit not reached, and the send was prepared at or after callsAt, so no call from before the yes is
//      summarized again. It goes to Nebius and is filed with `fileNotesOnly`, which starts no names check and no web
//      errands: those keep their own per-call yes. Without `fileNotesOnly` it never runs.
// Anything else returns { auto: false } and the card appears as before; `askCalls` is called when the setup yes for
// call notes was the missing piece (main asks for it once). A card click after an automatic yes is refused by
// decideSend ("already decided"), so the request never runs twice. Only notes are written: nothing is sent as mail.
const callsYesCovers = (send, standing) => standing?.callsYes === true && Boolean(standing.keySaved) && !standing.overBudget
  && Date.parse(send.created) >= Date.parse(standing.callsAt);
export async function autoDecide({ home, run, checks, runner = execRunner, transcriber, python = 'python3', nextMove = null, file = null, fileNotesOnly = null, standing = null, askCalls = null }) {
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  if (send.what !== 'call-notes' || send.status !== 'pending') return { auto: false };
  if ((await readEvents(runDirectory)).some((event) => event.type === 'send.decided')) return { auto: false };
  const own = send.workstream && send.workstream !== 'none' ? await workstreamPick(home, send.workstream) : null;
  if (own && await isConnected(checks, own)) return { ...await decideSend({ home, run, decision: 'yes', checks, runner, transcriber, python, nextMove, file, auto: true }), auto: true };
  if (callsYesCovers(send, standing) && typeof fileNotesOnly === 'function' && await isConnected(checks, 'nebius')) {
    return { ...await decideSend({ home, run, decision: 'yes', checks, runner, transcriber, python, nextMove, file: fileNotesOnly, auto: true, pick: 'nebius', by: 'calls-yes' }), auto: true };
  }
  if (standing?.callsYes !== true && typeof askCalls === 'function') askCalls();
  return { auto: false };
}

// The entry tail's hook (main.js): when a run's screen step finishes ok, try autoDecide once for that run. `options`
// builds the gate options (the same as hikyaku:decide). Errors are logged, never thrown into the tail.
// The send file can land after the screen event (a 2 h 39 class screened 1,760 lines between the two, 2026-10-22: the
// yes read no send, gave up, and the call waited behind its card with the calls yes on), so a missing send is waited
// for, `tries` times `wait` ms apart, before it is logged.
export function autoDecideOnScreen({ gate = { autoDecide }, options, log = console.error, tries = 20, wait = 500, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const tried = new Set();
  return async (event) => {
    if (event?.type !== 'step.finished' || event.data?.step !== 'screen' || !event.data.ok || tried.has(event.run)) return;
    tried.add(event.run);
    for (let attempt = 1; ; attempt += 1) {
      try { await gate.autoDecide({ ...await options(), run: event.run }); return; }
      catch (error) {
        if (/^No prepared send/.test(error.message) && attempt < tries) { await sleep(wait); continue; }
        log(`hikyaku auto decide: ${error.message}`);
        return;
      }
    }
  };
}
