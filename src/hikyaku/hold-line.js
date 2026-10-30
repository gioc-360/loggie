// "Keep another line on this Mac" (mock e screen 5, line.hold; spec-entry-b.md increment b#6). The user taps one
// sentence of "What would leave your Mac" that the screen cleared, and it stays home: the pending send is prepared again
// without it. All on the Mac, nothing is sent, nothing is screened again:
//   1. the send must still be waiting (pending, or failed and ready to retry) and every outbound file must still hash to
//      what was reviewed, else the hold is refused and nothing is written
//   2. the sentence is the screen record's line i (lines[], privacy.py lines_of) with status "sent"; its words are
//      replaced in the outbound file by the screen's own marker, "[<category> kept on this Mac]"
//   3. a NEW pair is written beside the old one (outbound-2.md + held-2.json, or OUTBOUND-2.md + HELD-2.json), the old
//      pair is kept as it was: the line is kept, layer "user", rule "line.hold", it joins held[] (so the next-move gate
//      also stops it) and the counts move one from sent to held
//   4. a new pending send carries the new pair (its hash taken now) and the other sources as reviewed; the old send is
//      marked superseded, never deleted
//   5. events: line.hold in both runs; the new run gets run.started and every screen.line again, so the view redraws
// A call's notes are written from the newest pair in the call folder (byo.py), which is the new one, and the Send
// approval is that pair's hash, so the line cannot slip back in.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { emitScreen, readEvents, USER_HOLD } from './events.js';
import { appendEvent, newRunId, prepareSend, readSend, runDirectoryOf, sha256, supersedeSends } from './send-gate.js';

export const HOLD_CATEGORIES = Object.freeze(['health', 'money', 'identity', 'grades', 'third-party', 'confidential']);
const DEFAULT_CATEGORY = 'confidential';   // "asked to keep it quiet": the user asked
const PAIR = /^(outbound|OUTBOUND)(?:-(\d+))?\.md$/;

// The next free pair beside an outbound file, numbered the way privacy.py free_pair numbers them.
async function nextPair(outboundPath) {
  const folder = dirname(outboundPath);
  const match = PAIR.exec(basename(outboundPath));
  if (!match) throw new Error(`${basename(outboundPath)} is not a screened outbound file. Nothing was changed.`);
  const [out, held] = match[1] === 'OUTBOUND' ? ['OUTBOUND', 'HELD'] : ['outbound', 'held'];
  const taken = (await readdir(folder)).map((name) => new RegExp(`^(?:${out}|${held})(?:-(\\d+))?\\.(?:md|json)$`).exec(name)).filter(Boolean).map((hit) => Number(hit[1] || 1));
  const n = Math.max(1, ...taken) + 1;
  return { outbound: join(folder, `${out}-${n}.md`), held: join(folder, `${held}-${n}.json`) };
}

function heldRecord(record, line, category) {
  const next = structuredClone(record);
  const row = next.lines.find((item) => item.i === line.i);
  Object.assign(row, { status: 'kept', category, layer: USER_HOLD.layer, rule: USER_HOLD.rule });
  next.held = [...(next.held || []), { i: row.i, time: row.time ?? null, speaker: row.speaker ?? null, category, layer: USER_HOLD.layer, rule: USER_HOLD.rule, text: row.text }];
  const counts = next.counts;
  counts.sent -= 1;
  counts.held += 1;
  counts.layer = { ...(counts.layer || {}), [USER_HOLD.layer]: (counts.layer?.[USER_HOLD.layer] || 0) + 1 };
  counts.category = { ...(counts.category || {}), [category]: (counts.category?.[category] || 0) + 1 };
  const turns = new Map();
  for (const item of next.lines) turns.set(item.turn, (turns.get(item.turn) ?? true) && item.status === 'kept');
  if ('turns_fully_held' in counts) counts.turns_fully_held = [...turns.values()].filter(Boolean).length;
  return next;
}

export async function holdLine({ home, run, sourceId, i, category = null }) {
  if (!Number.isInteger(i) || i < 0) throw new Error('Pick one sentence to keep. Nothing was changed.');
  if (category !== null && !HOLD_CATEGORIES.includes(category)) throw new Error(`Pick one of ${HOLD_CATEGORIES.join(', ')}, or none. Nothing was changed.`);
  const runDirectory = runDirectoryOf(home, run);
  const send = await readSend(runDirectory);
  if (send.status === 'sent') throw new Error('This was already sent. A line can be kept back only before Send. Nothing was changed.');
  if (send.status === 'sending') throw new Error('This is being sent now. Nothing was changed.');
  if (send.status === 'superseded') throw new Error('A newer send replaced this one. Keep the line there instead. Nothing was changed.');
  const index = send.source_ids.indexOf(sourceId);
  if (index < 0) throw new Error(`"${String(sourceId).slice(0, 120)}" is not in this send. Nothing was changed.`);
  // 1. what was reviewed is still what would leave.
  for (const [k, path] of send.outbound.entries()) {
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || sha256(bytes) !== send.sha256[k]) throw new Error('What would leave your Mac changed since you reviewed it. Review it again. Nothing was changed.');
  }
  // 2. the sentence.
  const record = JSON.parse(await readFile(send.held[index], 'utf8').catch(() => 'null'));
  if (!record?.counts || !Array.isArray(record.lines)) throw new Error('This screen record has no sentence list, so one line cannot be kept. Screen it again. Nothing was changed.');
  const line = record.lines.find((item) => item.i === i);
  if (!line) throw new Error(`There is no sentence ${i} in ${sourceId}. Nothing was changed.`);
  if (line.status === 'kept') throw new Error('That sentence is already kept on this Mac. Nothing was changed.');
  const kept = category || DEFAULT_CATEGORY;
  const text = await readFile(send.outbound[index], 'utf8');
  if (!line.text || !text.includes(line.text)) throw new Error('That sentence is not in what would leave your Mac as written. Screen it again. Nothing was changed.');
  // 3. the new pair; every place the words stand goes (more kept, never less).
  const pair = await nextPair(send.outbound[index]);
  await writeFile(pair.outbound, text.split(line.text).join(`[${kept} kept on this Mac]`));
  await writeFile(pair.held, `${JSON.stringify(heldRecord(record, line, kept), null, 1)}\n`);

  // 4. the new pending send.
  const outbound = send.outbound.map((path, k) => (k === index ? pair.outbound : path));
  const held = send.held.map((path, k) => (k === index ? pair.held : path));
  const counts = [];
  for (const path of held) counts.push(JSON.parse(await readFile(path, 'utf8')).counts);
  const fresh = sha256(await readFile(pair.outbound));
  const reviewed = send.sha256.map((hash, k) => (k === index ? fresh : hash));
  const next = newRunId();
  const nextDirectory = runDirectoryOf(home, next);
  const started = (await readEvents(runDirectory)).find((event) => event.type === 'run.started')?.data
    || { source: send.source_ids.some((id) => id.startsWith('call:')) ? 'call' : 'inbox', title: send.title || send.workstream || 'Send', workstream: send.workstream };
  await appendEvent(nextDirectory, { type: 'run.started', data: started });
  for (const [k, id] of send.source_ids.entries()) {
    await emitScreen(nextDirectory, { source: id.startsWith('call:') ? 'call' : 'thread', sourceId: id, outbound: outbound[k], held: held[k] });
  }
  // A call still waiting for a workstream keeps its offer (entry.js).
  const prepared = await prepareSend({ home, what: send.what, sourceIds: send.source_ids, folder: send.folder, outbound, held, counts, workstream: send.workstream, title: send.title,
    sources: send.sources || null, extra: { ...(send.offer ? { offer: send.offer } : {}), ...(send.classmates ? { classmates: send.classmates } : {}) }, run: next, reviewed });   // a class keeps its yes card line (loggie-class-notes)
  const replaced = await supersedeSends({ home, keep: next, matches: (item) => item.run === send.run });

  // 5. line.hold, in the old run (where it was tapped) and the new one (where the view goes on).
  const data = { run: send.run, moved_to: next, source_id: sourceId, i, category: kept };
  const said = 'Kept that line on this Mac; nothing was sent';
  await appendEvent(runDirectory, { type: 'line.hold', step: 'screen', text: said, data });
  await appendEvent(nextDirectory, { type: 'line.hold', step: 'screen', text: said, data });
  return { ok: true, run: next, replaced, send: prepared, sentences_sent: prepared.sentences_sent, sentences_kept: prepared.sentences_kept };
}
