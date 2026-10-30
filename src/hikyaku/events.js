// The event contract (spec-entry-b.md section 2, increment b#6): the one place an event is made, checked and read.
// Every event is one JSON line in <home>/runs/<run>/events.jsonl, append only:
//   { v, run, seq, at, type, step, text, data }
// emitEvent builds the envelope, numbers seq from the lines already there (so Python's sendgate.emit and this file
// share one numbering), checks the event against the contract and only then appends it. An event that breaks the
// contract is refused loudly, never written: a text that names a model, an unknown type, a step outside the list, a
// missing data field, or a provider field outside the events where the user is choosing an AI.
// checkEvents is the same check over a whole file (a real run or the fixture Jess designs against). Event text never
// names a model, a model maker or a provider; ai.options, ai.picked, ai.connect and outbound.sent carry provider ids
// and labels in `data`, because there the user is choosing one or the log needs it. Events never leave the Mac.
import { appendFile, mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { jsonLines } from './util.js';

export const CONTRACT = 1;
export const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
export const NAMES_A_MODEL = /nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm/i;
export const STEPS = Object.freeze(['read', 'screen', 'ask', 'check', 'file', 'move', 'pick']);
const ENVELOPE = ['v', 'run', 'seq', 'at', 'type', 'step', 'text', 'data'];

// The bubble texts (the `text` of step.started), fixed so the design can rely on them.
export const BUBBLES = Object.freeze({
  read: Object.freeze(['Reading your call', 'Reading your inbox']),
  screen: Object.freeze(['Screening on your Mac']),
  ask: Object.freeze(['Writing your call notes', 'Writing your next move']),
  check: Object.freeze(['Checking every line against the source']),
  file: Object.freeze(['Putting it on your card']),
});

// The plain reason a sentence stayed on the Mac, by category (privacy.py CATEGORIES plus the two hold states), and
// the reason for a line the user chose to keep (line.hold, layer "user").
export const KEPT_REASONS = Object.freeze({
  health: 'a health detail',
  money: 'personal money',
  identity: 'an ID number',
  grades: 'grades or scores',
  'third-party': "someone else's private matter",
  confidential: 'asked to keep it quiet',
  injection: 'text that tried to steer the screen',
  unchecked: 'the check could not finish, so it stayed',
  unsure: 'the check was unsure, so it stayed',
});
export const USER_HOLD = Object.freeze({ layer: 'user', rule: 'line.hold', reason: 'you chose to keep it' });
const OTHER_REASON = 'the screen kept it';
export const keptReason = (row) => (row?.layer === USER_HOLD.layer ? USER_HOLD.reason : KEPT_REASONS[row?.category] || OTHER_REASON);

// Each type and the data fields it must carry (more may follow). The spec's types, then the mock's flow events.
export const TYPES = Object.freeze({
  'run.started': ['source', 'title', 'workstream'],
  'step.started': ['step', 'index', 'of'],
  'step.progress': ['step', 'done', 'total', 'unit'],
  'step.finished': ['step', 'ok', 'seconds'],
  'screen.line': ['source', 'source_id', 'i', 'turn', 'time', 'speaker', 'text', 'status', 'category', 'layer', 'rule', 'reason'],
  'screen.summary': ['source', 'source_id', 'counts', 'outbound_file', 'held_file', 'seconds'],
  'outbound.sent': ['what', 'source_ids', 'sentences_sent', 'sentences_kept', 'chars', 'bytes', 'sha256', 'receipt', 'destination', 'provider_id'],
  'outbound.returned': ['what', 'ok', 'seconds', 'finish_reason', 'tokens'],
  'check.result': ['bullets', 'verified', 'not_sure', 'dropped', 'next_steps_kept', 'deadlines_dropped'],
  'move.ready': ['move_id', 'stream_id', 'task_id', 'thread_id', 'kind', 'why', 'drafts_count', 'slots'],
  'move.failed': ['step', 'reason', 'fix'],
  'run.failed': ['step', 'reason', 'fix'],
  'pick.recorded': ['move_id', 'choice', 'at', 'sent_seen', 'edit_ratio'],
  'run.finished': ['ok', 'seconds', 'moves', 'sentences_sent', 'sentences_kept'],
  'ai.options': ['options', 'default'],
  'ai.picked': ['run', 'provider', 'remember', 'stream_id'],
  'ai.connect': ['run', 'provider'],
  // The one question after a call (spec-c.md B18): no provider field here; ai.picked carries the AI if the answer is Yes.
  'send.decided': ['run', 'decision', 'picker_shown'],
  'mail.apps': ['move_id', 'apps', 'default'],
  'draft.open': ['move_id', 'draft', 'app'],
  'line.hold': ['run', 'moved_to', 'source_id', 'i', 'category'],
  'workstream.offer': ['run', 'source_id', 'new_workstream', 'existing'],
  'workstream.started': ['run', 'moved_to', 'source_id', 'workstream', 'stream_id', 'created', 'replaced'],
  'workstream.filed': ['run', 'moved_to', 'source_id', 'workstream', 'stream_id', 'created', 'replaced'],
  // A meeting starting (spec-c.md B12, meeting-watch.js): the title lives in data, never in text, so "LBO Model Review" passes.
  'meeting.offered': ['offer_id', 'source', 'key', 'title', 'start', 'end', 'people', 'names', 'emails', 'place', 'link_kind', 'reason', 'expires'],
  'meeting.answered': ['offer_id', 'answer', 'call'],
  // The meeting may be over (spec-c.md B15): a fixed text, and the user's stop or keep. Nothing stops on its own.
  'meeting.end_asked': ['call', 'reason', 'since', 'asked_before'],
  'meeting.end_answered': ['call', 'answer'],
  // The live reader still listening (transcriber live.py): at most one per 30 s, seconds only, never a word of the call.
  'meeting.heard': ['call', 'heard_s', 'read_s', 'behind_s', 'pieces'],
  // Setup (cloud-first C6, permissions.js): a permission an action needs and the user has refused, the user's answer to
  // that card, the cloud yes for mail sorting (group ai) or chats, and its answer. Text is the plain why, never an AI.
  'setup.need': ['permission', 'why', 'pane'],
  'setup.answered': ['permission', 'answer'],
  'setup.cloud_yes': ['group'],
  'setup.cloud_answered': ['group', 'answer'],
  // The speech download (speech-download.js, C7): bytes so far of all the files, and its state (downloading, paused, ready).
  'setup.download': ['done_bytes', 'total_bytes'],
});
// Fields that name an AI: only where the user is choosing one (ai.*) and in the log of what crossed (outbound.sent).
const PROVIDER_FIELDS = ['provider', 'provider_id', 'options'];
const MAY_NAME_PROVIDER = new Set(['ai.options', 'ai.picked', 'ai.connect', 'outbound.sent']);

// --- the check, one event at a time; checkEvents adds what only a whole run can show (seq without gaps)
export function checkEvent(event) {
  const problems = [];
  const bad = (why) => problems.push(`${event?.type || 'event'} #${event?.seq ?? '?'}: ${why}`);
  if (!event || typeof event !== 'object' || Array.isArray(event)) return ['not an event object'];
  const keys = Object.keys(event).sort();
  if (keys.join() !== [...ENVELOPE].sort().join()) bad(`envelope fields are ${keys.join(', ')}, not ${ENVELOPE.join(', ')}`);
  if (event.v !== CONTRACT) bad(`v is ${event.v}, not ${CONTRACT}`);
  if (typeof event.run !== 'string' || !RUN_ID.test(event.run)) bad(`run "${event.run}" is not YYYYMMDD-HHMMSS-<4 hex>`);
  if (!Number.isInteger(event.seq) || event.seq < 1) bad('seq is not 1 or more');
  if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) bad('at is not an ISO time');
  const required = TYPES[event.type];
  if (!required) bad(`unknown type "${event.type}"`);
  if (event.step !== null && !STEPS.includes(event.step)) bad(`step "${event.step}" is not one of ${STEPS.join(', ')}`);
  if (event.text !== null && typeof event.text !== 'string') bad('text is not a string or null');
  if (typeof event.text === 'string' && NAMES_A_MODEL.test(event.text)) bad(`text names a model or a provider: "${event.text}"`);
  if (event.type === 'step.started' && BUBBLES[event.step] && !BUBBLES[event.step].includes(event.text)) bad(`the ${event.step} bubble is "${event.text}", not one of the fixed texts`);
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) { bad('data is not an object'); return problems; }
  for (const key of required || []) if (!(key in data)) bad(`data has no ${key}`);
  if (!MAY_NAME_PROVIDER.has(event.type)) for (const key of PROVIDER_FIELDS) if (key in data) bad(`data.${key} names an AI outside ai.* and outbound.sent`);
  if ('model' in data) bad('data.model: no event carries a model id');
  if (event.type === 'screen.line') {
    if (!['call', 'thread'].includes(data.source)) bad(`source "${data.source}" is not call or thread`);
    if (data.status === 'kept') {
      if (!data.category || typeof data.reason !== 'string' || !data.reason) bad('a kept line needs its category and a plain reason');
    } else if (data.status === 'sent') {
      if ([data.category, data.layer, data.rule, data.reason].some((value) => value !== null)) bad('a sent line has no category, layer, rule or reason');
    } else bad(`status "${data.status}" is not sent or kept`);
  }
  return problems;
}

// A whole file or several runs' events, in file order: each event, and seq 1, 2, 3 ... per run with no gaps.
export function checkEvents(events) {
  const problems = [];
  const next = new Map();
  for (const event of events) {
    problems.push(...checkEvent(event));
    const want = next.get(event?.run) ?? 1;
    if (event?.seq !== want) problems.push(`${event?.type} in run ${event?.run}: seq ${event?.seq}, expected ${want} (a gap or a repeat)`);
    next.set(event?.run, (event?.seq ?? want) + 1);
  }
  return { ok: problems.length === 0, problems };
}

export const parseEvents = (text) => jsonLines(text);
export async function readEvents(runDirectory) {
  return parseEvents(await readFile(join(runDirectory, 'events.jsonl'), 'utf8').catch(() => ''));
}

// --- the emitter. One queue per run folder, so two appends from this process never take the same seq.
const queues = new Map();
export function emitEvent(runDirectory, { type, step = null, text = null, data = {} }) {
  const work = async () => {
    await mkdir(runDirectory, { recursive: true });
    const seq = (await readEvents(runDirectory)).length + 1;
    const event = { v: CONTRACT, run: basename(runDirectory), seq, at: new Date().toISOString(), type, step, text, data };
    const problems = checkEvent(event);
    if (problems.length) throw new Error(`Event not written, it breaks the event contract: ${problems.join('; ')}`);
    await appendFile(join(runDirectory, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    return event;
  };
  const result = (queues.get(runDirectory) || Promise.resolve()).then(work, work);
  const settled = result.catch(() => {});
  queues.set(runDirectory, settled);
  settled.then(() => { if (queues.get(runDirectory) === settled) queues.delete(runDirectory); });
  return result;
}

// --- "What would leave your Mac": one screen.line per sentence, then screen.summary, for one screened source.
// Built from the screen record's lines[] (privacy.py lines_of: every sentence with its fate). A record written before
// lines[] existed has only held[]: its kept sentences still become kept lines (cut footers and quoted replies, i null,
// are not sentences and are counted in the summary instead), so a kept line is never missing from the view.
export function screenLines({ source, sourceId, record }) {
  const rows = Array.isArray(record?.lines) ? record.lines
    : (record?.held || []).filter((row) => row && Number.isInteger(row.i)).map((row) => ({ ...row, status: 'kept', turn: row.turn ?? null }));
  return rows.map((row) => {
    const kept = row.status === 'kept';
    return { source, source_id: sourceId, i: row.i, turn: row.turn ?? null, time: row.time ?? null, speaker: row.speaker ?? null, text: row.text,
      status: kept ? 'kept' : 'sent', category: kept ? row.category || 'unsure' : null, layer: kept ? row.layer ?? null : null, rule: kept ? row.rule ?? null : null,
      reason: kept ? keptReason(row) : null };
  });
}

// How many classmates a class's screen wrote as Student N (privacy.screen counts.masked.labels), else 0; and the
// screen.summary line with its classmates clause, the same words as sendgate.py summary_text (loggie-class-notes I3).
export const classmatesOf = (counts) => {
  const labels = counts?.masked?.labels;
  return Number.isInteger(labels) && labels > 0 ? labels : 0;
};
// A trimmed call (an interview, loggie-interview-privacy): how many people left by first name only (counts.trimmed.people).
export const trimmedOf = (counts) => {
  const people = counts?.trimmed?.people;
  return Number.isInteger(people) && people > 0 ? people : 0;
};
export function summaryText(counts) {
  const text = `${counts.sent} sentences cleared, ${counts.held} kept on this Mac`;
  const people = trimmedOf(counts);
  if (people) return `${text}, ${people} ${people === 1 ? 'person' : 'people'} by first name only`;
  const n = classmatesOf(counts);
  if (n === 1) return `${text}, 1 classmate written as Student 1`;
  return n ? `${text}, ${n} classmates written as Student 1 to ${n}` : text;
}

export async function emitScreen(runDirectory, { source, sourceId, outbound, held, seconds = null }) {
  const record = JSON.parse(await readFile(held, 'utf8'));
  if (!record?.counts) throw new Error(`The screen record for ${sourceId} has no counts. Screen it again. Nothing was prepared.`);
  const lines = screenLines({ source, sourceId, record });
  for (const line of lines) {
    await emitEvent(runDirectory, { type: 'screen.line', step: 'screen', text: line.status === 'kept' ? `Kept on this Mac: ${line.reason}` : null, data: line });
  }
  return emitEvent(runDirectory, { type: 'screen.summary', step: 'screen', text: summaryText(record.counts),
    data: { source, source_id: sourceId, counts: record.counts, outbound_file: outbound, held_file: held, seconds: seconds ?? record.seconds ?? null, lines: lines.length } });
}

// --- the desktop's tail: new lines of every run's events.jsonl, in order, for IPC hikyaku:entry. The first poll
// only notes where each file ends, so opening Loggie does not replay old runs; a run folder that appears later is
// read from its first line. A line still being written (no newline yet) waits for the next poll.
export function createEventTail({ home, onEvent }) {
  const offsets = new Map();
  let primed = false;
  async function poll() {
    const root = join(home, 'runs');
    const runs = (await readdir(root).catch(() => [])).filter((name) => RUN_ID.test(name)).sort();
    for (const run of runs) {
      const file = join(root, run, 'events.jsonl');
      const size = (await stat(file).catch(() => null))?.size ?? null;
      if (size === null) continue;
      if (!primed) { offsets.set(file, size); continue; }
      const from = offsets.get(file) ?? 0;
      if (size <= from) continue;
      const handle = await open(file, 'r');
      let chunk;
      try { const buffer = Buffer.alloc(size - from); await handle.read(buffer, 0, buffer.length, from); chunk = buffer; } finally { await handle.close(); }
      const end = chunk.lastIndexOf(0x0a);
      if (end < 0) continue;
      offsets.set(file, from + end + 1);
      for (const event of parseEvents(chunk.subarray(0, end + 1).toString('utf8'))) onEvent(event);
    }
    primed = true;
  }
  return { poll };
}
