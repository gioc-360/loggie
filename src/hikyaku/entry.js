// The entry run (spec-entry-b.md increment 5 and section 6): one run joins a call and a week of mail into workstreams
// and prepares their next-move sends, ready for approval. Nothing is sent; every send waits for the user's Send in
// the send gate (send-gate.js approveSend). In order, all on the Mac:
//   1. read the inbox  the mail in the window (--since), from an inbox.json or read-only from Apple Mail (apple-mail-entry.js), is grouped by workstream the way workstreams.json defines
//                      them (matchWorkstream) and caught up per workstream with the LOCAL model (workstreams.js catchUp),
//                      which writes the open moves as Core tasks with THREAD.md in each task folder
//   2. read the calls  each call folder's event.json is matched to a workstream by its invitees' domains, the
//                      workstream's words in the title, or the workstream the call names (matchCall)
//   3. screen          each call is screened (privacy.py, or a pair still newer than its transcript); then every
//                      workstream with an open move gets its threads screened (screen-thread.js) and ONE pending
//                      next-move send, its matched calls joined (prepareWorkstreamMove). A call no workstream matched
//                      gets a pending send that says so and offers a new workstream, as the mock's "New workstream?"
//                      card does; the gate refuses it until it is placed: "Start it" (startWorkstream) or "Put it
//                      under" one of the user's (fileUnder). Either one moves the call into a workstream's pending
//                      send and sends nothing
// A newer pending send replaces the older one for the same workstream (marked superseded), so a run made twice leaves
// one per workstream. The run's own events (run.started, step.*, run.finished) go to <home>/runs/<run>/events.jsonl;
// each prepared send keeps its own run folder, which the send gate continues on Send. Event text never names a model.
//
// The guard (section 6): the run writes into its home, its Core folder and the call folders. It refuses any of them
// inside the real Loggie folder unless the caller says `real` (the CLI's --real), because the user runs it on his own
// data himself, deliberately, and never by a default.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readAppleMail } from './apple-mail-entry.js';
import { emitScreen } from './events.js';
import { execRunner } from './screen-thread.js';
import { titleWords } from './discover.js';
import { appendEvent, newRunId, pendingSends, prepareNextMove, prepareSend, readSend, runDirectoryOf, runsRoot, sha256, supersedeSends } from './send-gate.js';
import { localDay, slug } from './util.js';
import { catchUp, GOALS_BY_KIND, goalsFor, INBOX, matchWorkstream, readWorkstreams, updateWorkstreams, workstreamFields } from './workstreams.js';

export const REAL_LOGGIE = join(homedir(), 'Library', 'Application Support', 'Loggie');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// The local catch-up's task kinds (workstreams.js KINDS) plus a move bound by next-move.js; a call's own steps
// (sourceId "call:<call>#n") are not threads and are left out.
const THREAD_TASK = /^(.+):(reply|prep|apply|deadline|event|move)$/;

// --- the guard
const inside = (path, root) => { const p = resolve(path), r = resolve(root); return p === r || p.startsWith(`${r}${sep}`); };
export function guardDataRoots({ home, coreDirectory, calls = [], real = false, realRoot = REAL_LOGGIE }) {
  if (real) return { real: true };
  const roots = [['home', home], ['Core folder', coreDirectory], ...calls.map((call) => ['call folder', call])].filter(([, path]) => path);
  const hit = roots.find(([, path]) => inside(path, realRoot));
  if (hit) {
    throw new Error(`The ${hit[0]} ${resolve(hit[1])} is inside the real Loggie folder (${resolve(realRoot)}). The entry run writes there only when you `
      + 'pass --real, to run it on your own data on purpose. Nothing was read or written.');
  }
  return { real: false };
}

// --- calls
export function matchCall(event, workstreams, { ownAddress = '' } = {}) {
  const named = workstreams.filter((item) => item && item.name && !item.inbox && !item.chats && !item.folder);
  const chosen = String(event?.workstream || '').trim().toLowerCase();
  if (chosen && chosen !== 'none') {
    const found = named.find((item) => item.name.toLowerCase() === chosen);
    if (found) return found;
  }
  if ((event?.workstream_candidates || []).length > 1) return null;
  const own = String(ownAddress).toLowerCase();
  const emails = (event?.emails || []).map((email) => String(email).toLowerCase()).filter((email) => email && email !== own);
  const domains = emails.map((email) => email.split('@').pop());
  const title = String(event?.title || '').toLowerCase();
  // The same rule as call.py workstream_of: workstream words as whole words in each name and each email local part
  // (the title keeps the substring rule), else a domain or a subdomain of it. Words beat domains; a tie matches nothing.
  const people = [...String(event?.names || '').split(', '), ...emails.map((email) => email.split('@')[0].split(/[._-]/).join(' '))].map((text) => text.toLowerCase());
  const wholeWord = (word, text) => new RegExp(`(?<![a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(text);
  const wordHits = named.filter((item) => (item.words || []).some((word) => word && (title.includes(word.toLowerCase()) || people.some((text) => wholeWord(word.toLowerCase(), text)))));
  if (wordHits.length) return wordHits.length === 1 ? wordHits[0] : null;
  const domainHits = named.filter((item) => (item.domains || []).some((domain) => domains.some((d) => d === domain.toLowerCase() || d.endsWith(`.${domain.toLowerCase()}`))));
  return domainHits.length === 1 ? domainHits[0] : null;
}

// The call's folder name: the version folder's parent when the transcript sits in vN*/, else the folder (sendgate.py).
export const callName = (folder) => { const name = basename(resolve(folder)); return /^v\d/.test(name) ? basename(dirname(resolve(folder))) : name; };

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }

async function latestCallPair(folder) {
  let best = null;
  for (const name of await readdir(folder).catch(() => [])) {
    const match = /^outbound(?:-(\d+))?\.md$/.exec(name);
    if (!match) continue;
    const n = Number(match[1] || 1);
    if (!best || n > best.n) best = { n, outbound: join(folder, name), held: join(folder, n > 1 ? `held-${n}.json` : 'held.json') };
  }
  return best;
}

// One call, screened on the Mac: a pair newer than transcript.md is reused (sendgate.py fresh_pair), else privacy.py
// runs on the folder. A screen that cannot run throws: no screen, nothing prepared.
export async function screenCall({ folder, transcriber, python = 'python3', runner = execRunner }) {
  const mtime = async (path) => (await stat(path).catch(() => null))?.mtimeMs ?? null;
  const transcript = await mtime(join(folder, 'transcript.md'));
  if (transcript === null) throw new Error(`No transcript.md in ${folder}. Give the call's version folder. Nothing was prepared.`);
  let pair = await latestCallPair(folder);
  if (!pair || (await mtime(pair.outbound)) < transcript || (await mtime(pair.held)) === null) {
    const result = await runner(python, [join(transcriber, 'privacy.py'), folder], { cwd: transcriber });
    if (result.code !== 0) {
      const why = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).at(-1) || `exit ${result.code}`;
      throw new Error(`The privacy screen did not run for the call ${callName(folder)} (${why}). Nothing can be sent until it does.`);
    }
    pair = await latestCallPair(folder);
  }
  const record = pair ? await readJson(pair.held) : null;
  if (!record?.counts) throw new Error(`The privacy screen did not run for the call ${callName(folder)} (no outbound.md and held.json). Nothing can be sent until it does.`);
  return { outbound: pair.outbound, held: pair.held, counts: record.counts, seconds: record.seconds ?? null };
}

// --- one workstream: its open moves' threads, screened, and one pending next-move send with its calls joined.
export async function prepareWorkstreamMove({ home, core, workstream, transcriber, python = 'python3', runner = execRunner, me = null, calls = [], workRoot = join(home, 'work') }) {
  const project = (await core.listProjects()).find((item) => item.name.toLowerCase() === workstream.toLowerCase()) || null;
  const workstreamDirectory = project?.directoryPath || join(workRoot, slug(workstream));
  const threads = [];
  if (project) {
    const seen = new Set();
    for (const task of (await core.listTasks()).filter((item) => item.projectId === project.id && item.status !== 'done')) {
      const id = THREAD_TASK.exec(String(task.sourceId || ''))?.[1];
      if (!id || id.startsWith('call:') || seen.has(id)) continue;
      const md = await readFile(join(workstreamDirectory, task.id, 'THREAD.md'), 'utf8').catch(() => null);
      if (!md) continue;
      seen.add(id);
      threads.push({ id, md, source: task.sourceType === 'gmail' ? 'gmail' : null });
    }
  }
  if (!threads.length && !calls.length) return null;
  const send = await prepareNextMove({ home, workstream, workstreamDirectory, threads, transcriber, python, runner, me, calls });
  await supersedeSends({ home, keep: send.run, matches: (item) => item.what === 'next-move' && String(item.workstream || '').toLowerCase() === workstream.toLowerCase() });
  return send;
}

// The user's workstreams for "Put it under", the call's own candidates first (a tie in call.py derive, spec-c.md B16).
export function offerExisting(workstreams, candidates = []) {
  const names = workstreams.filter((item) => item && item.name && !item.inbox && !item.chats && !item.folder).map((item) => item.name);
  const first = candidates.filter((name) => names.includes(name));
  return [...first, ...names.filter((name) => !first.includes(name))];
}

// A call no workstream matched: a pending send that says so, with a new workstream on offer (mock e, "New workstream?").
async function offerWorkstream({ home, call, workstreams, ownAddress }) {
  const own = String(ownAddress).toLowerCase();
  const domains = [...new Set((call.event.emails || []).map((email) => String(email).toLowerCase()).filter((email) => email && email !== own).map((email) => email.split('@').pop()))];
  const title = String(call.event.title || call.name);
  const offer = { new_workstream: { name: title, kind: 'other', goal: null, domains, words: [] }, existing: offerExisting(workstreams, call.event.workstream_candidates || []) };
  const run = newRunId();
  const runDirectory = join(runsRoot(home), run);
  await appendEvent(runDirectory, { type: 'run.started', data: { source: 'call', title, workstream: null } });
  await emitScreen(runDirectory, { source: 'call', sourceId: call.id, outbound: call.outbound, held: call.held, seconds: call.seconds });
  const send = await prepareSend({ home, what: 'next-move', sourceIds: [call.id], folder: null, outbound: [call.outbound], held: [call.held], counts: [call.counts], workstream: null,
    title: `No workspace: ${title}`, sources: { [call.id]: null }, extra: { offer }, run });
  await supersedeSends({ home, keep: run, matches: (item) => item.what === 'next-move' && !item.workstream && item.source_ids?.length === 1 && item.source_ids[0] === call.id });
  return send;
}

// --- placing a call no workstream matched (mock e, "New workstream?": "Start it" / "Put it under <one of yours>").
// The call's pending send moves under a workstream: a new pending send for that workstream carries the items of the
// one already waiting there (with the hashes they were reviewed with) and then the call, whose screened pair is copied
// into the workstream's .outbound/call-<name>/ as prepareNextMove does. The older send and the offer are marked
// superseded (the replace-older rule). Nothing runs, nothing is screened again, nothing is sent: the user still
// reviews it and presses Send. A refusal writes nothing.
const NAME_MAX = 60;
// Mail providers everyone uses: a domain like these names nobody, and as a workstream domain it would take in all mail.
export const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com']);
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function waitingOffer(home, run) {
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  const name = /^call:(.+)$/.exec(String(send.source_ids?.[0] || ''))?.[1];
  if (send.what !== 'next-move' || send.workstream || !send.offer || send.status !== 'pending' || send.source_ids.length !== 1 || !name) {
    throw new Error('That is not a call waiting for a workspace. Nothing was changed.');
  }
  // The screened call as the user reviewed it; a file changed since is refused here, before anything is written.
  const bytes = await readFile(send.outbound[0]).catch(() => null);
  if (!bytes || sha256(bytes) !== send.sha256[0]) throw new Error('What would leave your Mac changed since you reviewed it. Run the entry again to screen the call again. Nothing was changed.');
  const heldBytes = await readFile(send.held[0]).catch(() => null);
  const record = heldBytes ? JSON.parse(heldBytes.toString('utf8')) : null;
  if (!record?.counts) throw new Error(`The screen record for ${send.source_ids[0]} has no counts. Run the entry again. Nothing was changed.`);
  return { send, runDirectory, name, bytes, heldBytes, counts: record.counts };
}

async function workstreamDirectoryOf({ home, core, workstream, waiting }) {
  const project = core ? (await core.listProjects()).find((item) => sameName(item.name, workstream)) : null;
  return project?.directoryPath || waiting?.folder || join(home, 'work', slug(workstream));
}

async function placeCall({ home, core, offer, workstream, eventType, text, created }) {
  const { send, runDirectory, name, bytes, heldBytes, counts } = offer;
  const callId = send.source_ids[0];
  const waiting = (await pendingSends(home)).filter((item) => item.what === 'next-move' && sameName(item.workstream, workstream)).at(-1) || null;
  const workstreamDirectory = await workstreamDirectoryOf({ home, core, workstream, waiting });
  const items = [];
  if (waiting) {
    for (const [index, id] of waiting.source_ids.entries()) {
      if (id === callId) continue;
      const record = JSON.parse(await readFile(waiting.held[index], 'utf8').catch(() => 'null'));
      if (!record?.counts) throw new Error(`The screen record for ${id} has no counts. Run the entry again. Nothing was sent.`);
      items.push({ id, outbound: waiting.outbound[index], held: waiting.held[index], sha: waiting.sha256[index], counts: record.counts, source: waiting.sources?.[id] ?? null });
    }
  }
  const folder = join(workstreamDirectory, '.outbound', `call-${name}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'outbound.md'), bytes);
  await writeFile(join(folder, 'held.json'), heldBytes);
  items.push({ id: callId, outbound: join(folder, 'outbound.md'), held: join(folder, 'held.json'), sha: send.sha256[0], counts, source: null });

  const run = newRunId();
  const newDirectory = runDirectoryOf(home, run);
  await appendEvent(newDirectory, { type: 'run.started', data: { source: 'call', title: workstream, workstream } });
  for (const item of items) {
    await emitScreen(newDirectory, { source: item.id.startsWith('call:') ? 'call' : 'thread', sourceId: item.id, outbound: item.outbound, held: item.held });
  }
  const placed = await prepareSend({ home, what: 'next-move', sourceIds: items.map((item) => item.id), folder: workstreamDirectory, outbound: items.map((item) => item.outbound),
    held: items.map((item) => item.held), counts: items.map((item) => item.counts), workstream, title: workstream, run, reviewed: items.map((item) => item.sha),
    sources: Object.fromEntries(items.map((item) => [item.id, item.source])) });
  const replaced = await supersedeSends({ home, keep: run, matches: (item) => item.run === send.run || (item.what === 'next-move' && sameName(item.workstream, workstream)) });
  const data = { run: send.run, moved_to: run, source_id: callId, workstream, stream_id: slug(workstream), created, replaced };
  await appendEvent(runDirectory, { type: eventType, step: 'file', text, data });
  await appendEvent(newDirectory, { type: eventType, step: 'file', text, data });
  return { ok: true, run, workstream, replaced, send: placed };
}

// A new workstream appended to workstreams.json: the name checked (not empty, at most NAME_MAX, no clash with one that
// exists or Chats). Used by "Start it" below and by a meeting's "New workspace…" on the week (first-run-polish B3.3),
// which also gives the meeting's people (kept only as valid addresses or handles, workstreamFields) and three record
// keys: madeFrom, confirmed, and cloud only as 'nebius'. Any other extra key is dropped.
const EXTRA_KEYS = ['madeFrom', 'confirmed', 'cloud'];
export async function addWorkstream({ home, name, kind = 'other', goal = null, domains = [], words = [], people = [], extra = {} }) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Give the new workspace a name. Nothing was changed.');
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length > NAME_MAX) throw new Error(`Keep the name to ${NAME_MAX} characters. Nothing was changed.`);
  // One write under the workstreams.json lock (first-run-polish B4.3a), so a look or the Found step writing at the same
  // moment never loses this card. No file yet means the one implicit Inbox card (workstreams.js INBOX); it is written
  // out so it stays.
  const entry = await updateWorkstreams(home, (found) => {
    const list = found === null ? [{ name: INBOX.name, kind: INBOX.kind, domains: [], words: [], inbox: true }] : found;
    if (!Array.isArray(list)) throw new Error('workstreams.json is not a list, so nothing can be added. Nothing was changed.');
    const taken = [...list.map((item) => item?.name), 'Chats'].filter((item) => typeof item === 'string');
    const clash = taken.find((item) => slug(item) === slug(clean) || sameName(item, clean));
    if (clash) throw new Error(`There is already a workspace named "${clash}". Pick another name, or file the meeting under it. Nothing was changed.`);
    const kept = Object.fromEntries(EXTRA_KEYS.filter((key) => key in (extra || {}) && (key !== 'cloud' || extra.cloud === 'nebius')).map((key) => [key, extra[key]]));
    const made = { name: clean, kind: GOALS_BY_KIND[kind] ? kind : 'other', ...(goal ? { goal } : {}), domains, words, ...workstreamFields({ people }), ...kept };
    list.push(made);
    return { list, result: made };
  });
  return entry;
}

// "Start it": a new workstream named by the user, with the offer's kind, invitee domains (never the user's own domain
// or a public mail provider) and words from the call title (discover.js titleWords). No cloud approval is set: that
// stays the user's own step (cloud.js). The goal is optional and, when given, one of the kind's choices.
export async function startWorkstream({ home, run, name, goal = null, core = null, ownAddress = '', ownAddresses = [], ownNames = [] }) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Give the new workspace a name. Nothing was changed.');
  const clean = name.replace(/\s+/g, ' ').trim();
  if (clean.length > NAME_MAX) throw new Error(`Keep the name to ${NAME_MAX} characters. Nothing was changed.`);
  const offer = await waitingOffer(home, run);
  const proposed = offer.send.offer.new_workstream || {};
  const kind = GOALS_BY_KIND[proposed.kind] ? proposed.kind : 'other';
  if (goal !== null && goal !== undefined && !goalsFor(kind).includes(goal)) throw new Error(`That goal is not one of the choices: ${goalsFor(kind).join(', ')}. Nothing was changed.`);
  const addresses = [ownAddress, ...(Array.isArray(ownAddresses) ? ownAddresses : [])].map((item) => String(item || '').toLowerCase()).filter((item) => item.includes('@'));
  const ownDomains = addresses.map((item) => item.split('@').pop());
  const domains = (proposed.domains || []).map((domain) => String(domain).toLowerCase())
    .filter((domain) => domain && !PUBLIC_MAIL.has(domain) && !ownDomains.some((own) => domain === own || domain.endsWith(`.${own}`)));
  const own = [...ownNames, ...addresses.map((item) => item.split('@')[0])].filter(Boolean);
  const entry = await addWorkstream({ home, name: clean, kind, goal, domains, words: titleWords(proposed.name || '', { ownNames: own }) });
  return { ...(await placeCall({ home, core, offer, workstream: clean, eventType: 'workstream.started', text: 'Started a new workstream for this call', created: true })), entry };
}

// "Put it under <one of yours>": the call joins a workstream already named in workstreams.json. The file is not written.
export async function fileUnder({ home, run, stream, core = null }) {
  if (typeof stream !== 'string' || !stream.trim()) throw new Error('Pick the workspace to put the call under. Nothing was changed.');
  const offer = await waitingOffer(home, run);
  const named = (await readWorkstreams(home)).filter((item) => !item.inbox && !item.chats);
  const found = named.find((item) => sameName(item.name, stream));
  if (!found) throw new Error(`No workspace named "${stream.trim()}". Pick one of: ${named.map((item) => item.name).join(', ') || 'none yet'}. Nothing was changed.`);
  return placeCall({ home, core, offer, workstream: found.name, eventType: 'workstream.filed', text: 'Put this call under one of your workstreams', created: false });
}

const threadTime = (thread) => thread.latestTimestamp || thread.messages?.at(-1)?.timestamp || '';

// --- the run
// `appleMail` (true, or readAppleMail's options such as { home }) reads the window from Apple Mail when no `mail` is given.
// `thinkFor(workstream)` gives each catch-up its `complete`, or null when that workstream may not be read (no yes for the
// cloud yet, cloud-screen.js thinkWith): its catch-up is then left out, as when it has no mail in the window.
export async function entryRun({ home, core, since, mail = null, appleMail = null, readAppleMailImpl = readAppleMail, calls = [], complete = null, thinkFor = () => complete, transcriber, python = 'python3', runner = execRunner, me = null, ownAddress = '', profile = '',
  today = localDay(), catchUpImpl = catchUp }) {
  if (typeof since !== 'string' || !DAY.test(since)) throw new Error('Give the start of the window as --since YYYY-MM-DD.');
  const run = newRunId();
  const runDirectory = join(runsRoot(home), run);
  const workRoot = join(home, 'work');
  const t0 = Date.now();
  const of = calls.length ? 3 : 2;
  const workstreams = (await readWorkstreams(home)).filter((item) => !item.chats);
  await appendEvent(runDirectory, { type: 'run.started', data: { source: mail || appleMail ? 'inbox' : 'call', title: `Since ${since}`, workstream: null } });
  let step = 'read', stepStart = Date.now();
  const started = async (name, text, index) => { step = name; stepStart = Date.now(); await appendEvent(runDirectory, { type: 'step.started', step: name, text, data: { step: name, index, of } }); };
  const finished = (ok) => appendEvent(runDirectory, { type: 'step.finished', step, data: { step, ok, seconds: (Date.now() - stepStart) / 1000 } });
  const catchUps = [], joined = [], sends = [];
  let threads = mail, sentMail = null, appleMailCounts = null;
  try {
    // 1. the inbox, in the window. Without mail (no file given) the moves already on the cards are used as they are.
    await started('read', 'Reading your inbox', 1);
    if (!threads && appleMail) {
      // Inbox and Sent were both read, so catch-up need not warn that a reply may be in Outlook unseen.
      const read = await readAppleMailImpl({ since, ownAddress, ...(appleMail === true ? {} : appleMail) });
      threads = read.threads;
      appleMailCounts = read.counts;
      sentMail = { seesOutlook: true, note: null };
    }
    if (threads) {
      const window = threads.filter((thread) => threadTime(thread) >= since);
      const groups = new Map();
      for (const thread of window) {
        const name = matchWorkstream(thread, workstreams);
        if (name) groups.set(name, [...(groups.get(name) || []), thread]);
      }
      let done = 0;
      for (const workstream of workstreams.filter((item) => groups.has(item.name))) {
        const think = thinkFor(workstream);
        if (!think) continue;
        const log = await catchUpImpl({ workstream: { ...workstream, goal: workstream.goal || goalsFor(workstream.kind)[0] }, threads: groups.get(workstream.name), complete: think, core, workRoot, ownAddress, profile, today, ...(sentMail ? { sentMail } : {}) });
        catchUps.push({ workstream: workstream.name, threads: log.threads, written: log.written, already: log.already });
        await appendEvent(runDirectory, { type: 'step.progress', step: 'read', data: { step: 'read', done: (done += 1), total: groups.size, unit: 'workstreams' } });
      }
    }
    await finished(true);

    // 2. the calls: which workstream each one joins.
    if (calls.length) {
      await started('read', 'Reading your call', 2);
      for (const folder of calls) {
        const event = (await readJson(join(folder, 'event.json'))) || (await readJson(join(dirname(resolve(folder)), 'event.json')));
        if (!event) throw new Error(`No event.json for the call in ${folder}. Nothing was prepared.`);
        const name = callName(folder);
        joined.push({ folder, name, id: `call:${name}`, event, workstream: event.filed?.none ? null : matchCall(event, workstreams, { ownAddress })?.name || null, noWorkspace: Boolean(event.filed?.none) });
      }
      await finished(true);
    }

    // 3. screen and prepare: calls first, then one send per workstream with an open move, then the offers.
    await started('screen', 'Screening on your Mac', of);
    for (const call of joined) Object.assign(call, await screenCall({ folder: call.folder, transcriber, python, runner }));
    const named = workstreams.filter((item) => !item.folder);
    let done = 0;
    for (const workstream of named) {
      const mine = joined.filter((call) => call.workstream === workstream.name).map(({ id, outbound, held }) => ({ id, outbound, held }));
      const send = await prepareWorkstreamMove({ home, core, workstream: workstream.name, transcriber, python, runner, me, calls: mine, workRoot });
      if (send) sends.push(send);
      await appendEvent(runDirectory, { type: 'step.progress', step: 'screen', data: { step: 'screen', done: (done += 1), total: named.length, unit: 'workstreams' } });
    }
    for (const call of joined.filter((item) => !item.workstream && !item.noWorkspace)) {
      const send = await offerWorkstream({ home, call, workstreams, ownAddress });
      sends.push(send);
      await appendEvent(runDirectory, { type: 'workstream.offer', step: 'file', text: 'No workstream fits this call yet', data: { run: send.run, source_id: call.id, ...send.offer } });
    }
    await finished(true);
  } catch (error) {
    await finished(false);
    await appendEvent(runDirectory, { type: 'run.failed', step, text: 'Nothing was sent', data: { step, reason: error.message, fix: error.fix || (step === 'screen' ? 'Start the AI on this Mac, then run it again.' : 'Read the reason, then run it again.') } });
    throw error;
  }
  const total = (key) => sends.reduce((sum, send) => sum + (send[key] || 0), 0);
  await appendEvent(runDirectory, { type: 'run.finished', data: { ok: true, seconds: (Date.now() - t0) / 1000, moves: 0, sends: sends.length, sentences_sent: total('sentences_sent'), sentences_kept: total('sentences_kept') } });
  const waiting = new Set((await pendingSends(home)).map((send) => send.run));
  return { run, runDirectory, appleMail: appleMailCounts, catchUps, calls: joined.map(({ id, workstream }) => ({ id, workstream })), sends: sends.filter((send) => waiting.has(send.run)) };
}
