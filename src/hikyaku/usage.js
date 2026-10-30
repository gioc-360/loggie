// What the cloud AI costs: one line per Token Factory answer in <home>/nebius-usage.jsonl, kept or not (an answer cut
// at the token limit is billed too), and the day's total for the panel. The call notes (transcriber/spike/byo.py)
// write the same file with the same fields, so one total covers notes, ranking, finding workstreams and next moves.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const USAGE_FILE = 'nebius-usage.jsonl';
// US dollars per million tokens, [input, output], from Nebius's own catalog
// (https://tokenfactory.nebius.com/model-catalog.md, read 2026-10-09). byo.py's NEBIUS_PRICES holds the same table; a
// test keeps the two equal. A model not listed is logged with its tokens and no cost.
export const PRICES = Object.freeze({ 'nvidia/nemotron-3-super-120b-a12b': Object.freeze([0.30, 0.90]), 'nvidia/Nemotron-3-Ultra-550b-a55b': Object.freeze([1.00, 3.00]), 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': Object.freeze([0.06, 0.24]), 'nvidia/Nemotron-3_5-Lightning': Object.freeze([0.06, 0.24]) });

const count = (value) => (Number.isFinite(value) ? value : null);

export function costUsd(model, usage = {}) {
  const price = PRICES[model];
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  if (!price || input === null || output === null) return null;
  return Math.round((input * price[0] / 1e6 + output * price[1] / 1e6) * 1e6) / 1e6;
}

// Who spent it: "app" for Loggie itself and every child it starts (desktop/main.js sets LOGGIE_RUN_BY=app), "dev" for
// anything run by hand (scripts, evals, byo.py from a terminal). The panel's meter and the daily limit count the app
// only, so a test loop can neither inflate what Loggie seems to cost nor lock Loggie out of its own reads (2026-10-10:
// $4.81 of a $5.02 day was an eval re-summarizing the same calls, counted against Loggie's $3 limit).
export const runBy = (env = process.env) => (env.LOGGIE_RUN_BY === 'app' ? 'app' : 'dev');

// `cached`: answered from a saved answer (nebius.js), so nothing was sent and nothing billed; logged so the day can say
// how much was reused.
export async function recordUsage(home, { path = 'other', model = '', usage = {}, seconds = null, finishReason = null, copies = 1, cached = false, by = runBy(), now = new Date() } = {}) {
  const row = { at: now.toISOString(), path, model, in: count(usage.prompt_tokens), out: count(usage.completion_tokens), usd: cached ? 0 : costUsd(model, usage), seconds, finish_reason: finishReason, by, ...(cached ? { cached: true } : {}), ...(copies > 1 ? { copies } : {}) };
  await appendFile(join(home, USAGE_FILE), `${JSON.stringify(row)}\n`);
  return row;
}

// Today's calls, tokens and dollars spent by Loggie itself, on this Mac's calendar day, with the same totals per path;
// `dev` is what hand-run work spent beside it, and `reused` how many answers came from a saved one. A row from before
// the `by` field counts as the app's, since nothing then said otherwise.
export async function usageToday(home, { now = new Date() } = {}) {
  const day = now.toLocaleDateString('en-CA');
  const text = await readFile(join(home, USAGE_FILE), 'utf8').catch(() => '');
  const total = { day, calls: 0, in: 0, out: 0, usd: 0, byPath: {}, reused: 0, dev: { calls: 0, in: 0, out: 0, usd: 0 } };
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row?.at || new Date(row.at).toLocaleDateString('en-CA') !== day) continue;
    const add = (into) => { into.calls += 1; into.in += row.in || 0; into.out += row.out || 0; into.usd += row.usd || 0; };
    if (row.by === 'dev') { add(total.dev); continue; }
    if (row.cached) total.reused += 1;
    add(total);
    add(total.byPath[row.path] ||= { calls: 0, in: 0, out: 0, usd: 0 });
  }
  total.usd = Math.round(total.usd * 1e6) / 1e6;
  total.dev.usd = Math.round(total.dev.usd * 1e6) / 1e6;
  return total;
}

// The panel's line: "Cloud AI today: 9,120 tokens, $0.0036, 3 calls", or null before the first call of the day.
export function usageLine(total) {
  if (!total?.calls && !total?.dev?.calls) return null;
  const reused = total.reused ? `, ${total.reused} reused` : '';
  const dev = total.dev?.calls ? `; test runs $${total.dev.usd.toFixed(4)}` : '';
  return `Cloud AI today: ${(total.in + total.out).toLocaleString('en-US')} tokens, $${total.usd.toFixed(4)}, ${total.calls} call${total.calls === 1 ? '' : 's'}${reused}${dev}`;
}
