// The Found step (first-run-polish B4): what the look for workspaces found since setup's Done, shown to the person to
// keep, rename or dismiss before Today, and the one write that keeps and dismisses. A found workspace's mail is read
// only after Keep, and only for kept cards (D1): nothing here reads mail; `needCatchUp` names the kept cards that wait
// for their first read, and `foundCatchUp` reads them one at a time. Every file is read through an injected reader so
// tests use temp folders; no address leaves through a row (`rowOf`).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NO_MAIL_SOURCE, SKIP_NO_KEY, SKIP_NO_YES } from './discover.js';
import { readRawSettings, saveSetup } from './setup-status.js';
import { updateWorkstreams } from './workstreams.js';
import { firstNameOfFrom, jsonLines } from './util.js';

export const MAX_ROWS = 20;

const readJson = async (readImpl, path, fallback) => {
  try { return JSON.parse(await readImpl(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
};
const readLines = async (readImpl, path) => {
  const text = await readImpl(path, 'utf8').catch((error) => { if (error?.code === 'ENOENT') return ''; throw error; });
  return jsonLines(text);
};

// One row of the Found step: the card's evidence and counts, the sender as a first name only.
export function rowOf(entry) {
  const found = entry?.found && typeof entry.found === 'object' ? entry.found : {};
  return { name: entry.name, label: entry.label || null, quote: found.quote || '', subject: found.subject || '', sender: firstNameOfFrom(found.quoteFrom || found.from),
    date: found.date || null, fromSent: Number(found.fromSent) || 0, threads: Number(found.threads) || 0, yours: Number(found.yours) || 0 };
}

// The cards still waiting for the person's answer: found since `since`, neither kept nor dismissed, in file order.
export function foundRows(list, { since } = {}) {
  const from = Date.parse(since);
  return (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry.name === 'string' && entry.found && typeof entry.found === 'object'
    && !entry.dismissed && !entry.confirmed && Date.parse(entry.found.at) >= from).map(rowOf).slice(0, MAX_ROWS);
}

// Why a look found nothing, from its runs.jsonl line. A skip line's `skipped` is a string; a completed look's line
// spreads discover's log, whose `skipped` is a list of proposals left out.
export function zeroOf(line = {}) {
  if (line.failed) return { reason: 'failed', message: String(line.failed) };
  if (typeof line.skipped === 'string') {
    if (line.skipped === NO_MAIL_SOURCE) return { reason: 'no-mail' };
    if (line.skipped === SKIP_NO_YES) return { reason: 'no-yes' };
    if (line.skipped === SKIP_NO_KEY) return { reason: 'no-key' };
    return { reason: 'failed', message: line.skipped };
  }
  return { reason: 'none', read: Number(line.read) || 0 };
}

// The step's phase: idle (no look since Done, or no Done), searching, found (rows to answer) or zero (the look ended
// with nothing to answer, and why).
export async function foundState({ home, running = false, progress = null, readImpl = readFile } = {}) {
  const raw = await readRawSettings(home, { readImpl });
  const doneAt = raw?.setup?.doneAt;
  const idle = { phase: 'idle', progress: null, rows: [], zero: null };
  if (!doneAt) return idle;
  if (running) return { phase: 'searching', progress: progress || null, rows: [], zero: null };
  const rows = foundRows(await readJson(readImpl, join(home, 'workstreams.json'), []), { since: doneAt });
  if (rows.length) return { phase: 'found', progress: null, rows, zero: null };
  const last = (await readLines(readImpl, join(home, 'runs.jsonl'))).filter((line) => line.discover === true && line.dryRun !== true).at(-1);
  if (last && Date.parse(last.at) >= Date.parse(doneAt)) return { phase: 'zero', progress: null, rows: [], zero: zeroOf(last) };
  return idle;
}

// Keep and Dismiss in one write (the workstreams.json lock). A name counts only while it is a found card neither kept
// nor dismissed; anything else is skipped, never an error. `end` 'done' or 'later' saves setup.found; null (the
// Workspaces band) saves nothing. Returns { kept, dismissed }.
export async function keepFound({ home, keep = [], dismiss = [], end = null, now = new Date(), readImpl = readFile, writeImpl = writeFile, saveSetupImpl = (patch) => saveSetup(home, patch, { now }) }) {
  const at = now.toISOString();
  const counts = await updateWorkstreams(home, (list) => {
    const pending = (name) => (list || []).find((entry) => entry?.name === name && entry.found && !entry.dismissed && !entry.confirmed);
    let kept = 0;
    let dismissed = 0;
    for (const name of keep) { const entry = pending(name); if (entry) { entry.confirmed = at; kept += 1; } }
    for (const name of dismiss) { const entry = pending(name); if (entry) { entry.dismissed = at; dismissed += 1; } }
    return kept || dismissed ? { list, result: { kept, dismissed } } : { result: { kept, dismissed } };
  }, { readImpl, writeImpl });
  if (end === 'done' || end === 'later') await saveSetupImpl({ found: end });
  return counts;
}

// A found card that was never kept and never read: it carries the Workspaces band (B4.8), and no read may reach it.
export const isNewFound = (workstream, state = {}) => Boolean(workstream?.found && !workstream.confirmed && !state?.[workstream.name]);

// What main's card object adds for a found card (B4.5).
export function foundCardFields(workstream, state = {}) {
  const newFound = isNewFound(workstream, state);
  return { confirmed: workstream?.confirmed || null, newFound, foundRow: newFound ? rowOf(workstream) : null };
}

// A kept found card whose mail nothing may read: no approval of its own, so catchUpFound gets needsYes and the
// refresh skips it every 10 min. Its Workspaces page asks the yes instead of staying silent. Whatever settings say:
// a card kept after the one found yes was never approved (2026-10-26, the andon: Karaoke and L2 sat "Not read yet"
// behind 573 silent skips in 7 days, because this rule also asked that the found yes be missing).
export const needsReadYes = (workstream) => Boolean(workstream?.found && workstream.confirmed && !workstream.dismissed
  && !workstream.retired && workstream.cloud !== 'nebius');

// After that yes: every kept found card with no approval gets the one discover gives each card it finds under
// cloudYes.found (the yes now covers found workspaces, and each is one the user kept), so their first reads
// (needCatchUp, catchUpFound) can run. `name` is the card the Yes was pressed on and must be a kept found one. Without
// the yes, or for any other name, nothing is written. `approved` is newest kept first.
export async function approveFound({ home, name, readImpl = readFile, writeImpl = writeFile }) {
  const raw = await readRawSettings(home, { readImpl });
  if (raw?.cloudYes?.found !== true) throw new Error("Loggie reads a workspace's mail only after your yes.");
  return updateWorkstreams(home, (list) => {
    const kept = (Array.isArray(list) ? list : []).filter((item) => item && typeof item.name === 'string' && item.found && item.confirmed && !item.dismissed);
    if (!kept.some((item) => item.name === name)) throw new Error(`"${name}" is not a workspace you kept.`);
    const waiting = newestKept(kept.filter((item) => item.cloud !== 'nebius'));
    for (const item of waiting) item.cloud = 'nebius';
    const result = { name, cloud: 'nebius', approved: waiting.map((item) => item.name) };
    return waiting.length ? { list, result } : { result };
  }, { readImpl, writeImpl });
}
const newestKept = (list) => [...list].sort((a, b) => (Date.parse(b.confirmed) || 0) - (Date.parse(a.confirmed) || 0));

// The kept cards still waiting for their first read: found, kept, not dismissed, no catch-up state yet, in file order.
// `newest`: newest kept first (the read yes's reads), else file order.
export async function needCatchUp({ home, newest = false, readImpl = readFile } = {}) {
  const list = await readJson(readImpl, join(home, 'workstreams.json'), []);
  const state = await readJson(readImpl, join(home, 'catchup-state.json'), {});
  return (newest ? newestKept : (x) => x)((Array.isArray(list) ? list : []).filter((entry) => entry?.found && entry.confirmed && !entry.dismissed && typeof entry.name === 'string' && !(state && entry.name in state)))
    .map((entry) => entry.name);
}

// The first reads of kept cards, one at a time on one chain, never awaited by an IPC reply. A catch-up that fails is
// said and the next goes on; the card keeps no state, so the next launch (or its own Refresh this) reads it.
export function foundCatchUp({ catchUpOn, onRead = () => {}, onError = () => {} }) {
  let chain = Promise.resolve();
  return function catchUpFound(names) {
    chain = chain.then(async () => {
      for (const name of names) {
        try { await catchUpOn(name); onRead(name); } catch (error) { onError(name, error); }
      }
    });
    return chain;
  };
}
