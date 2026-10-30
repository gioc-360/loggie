// The introductions replay, its pure half (loggie-intros I2, docs/intros/spec.md 1.8): given what the reads found, it
// says for every email from a workspace's domain whether the live log filed it and, when not, why; for every
// introduction, where it went and what move it makes; and, with the move-check, whether the code-made move binds the
// introduced address and never the introducer. Exit 1 only for something wrong in the code (a domain email the router
// sends elsewhere, a wrong binding), never for the plain facts of time (mail from before a workspace was found).
//
//   replayReport({ routed, logged, runs, workstreams, intros, adversarial }, { days, ms, show, domain })
//     -> { lines, summary, exit }
//   moveCheck(thread, intro, { own }) -> { bound, introducerDropped }
//   adversarialCheck(threads, { own, movable }) -> { names, emails, bound, wrong }
// No reads and no writes here; scripts/intros/replay.mjs does the reads.
import { checkActions, introActions, isKept, isNamed, isOwn } from './workstreams.js';
import { screenText } from './cloud-screen.js';
import { ownText } from './voice.js';

const DAY_MS = 86400000;
const REASONS = ['in log', 'logged elsewhere', 'logged unsure', 'routed elsewhere', 'unsure', 'before the workspace', 'not in window', 'stored late', 'not looked yet'];
const WRONG_REASONS = new Set(['routed elsewhere', 'unsure']);
const RUN = /\p{Lu}[\p{L}'’.-]*(?:[ \t]+\p{Lu}[\p{L}'’.-]*){0,2}/gu;

const low = (value) => String(value || '').toLowerCase();
const domainOf = (address) => low(address).split('@')[1] || '';
const atDomain = (address, d) => low(address).endsWith(`@${d}`) || low(address).endsWith(`.${d}`);
const day = (iso) => (Number.isNaN(Date.parse(iso)) ? '?' : new Date(iso).toLocaleDateString('en-CA'));
// The 1.4 name rule: the whole name folded, or one word that is one of the name's words.
const squash = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = (text) => String(text || '').split(/\s+/).map(squash).filter(Boolean);
export const nameMatches = (name, to) => Boolean(squash(to)) && (squash(name) === squash(to) || (words(to).length === 1 && words(name).includes(words(to)[0])));

// The screened text of one email and its sentences (split on . ! ? and line ends), as the model would see them.
const screened = (message) => screenText(ownText(message?.body || '').replace(/<mailto:[^>]*>/gi, '')).text;
const sentences = (text) => text.split(/(?<=[.!?])\s+|\n+/).map((piece) => piece.trim()).filter(Boolean);
const sentenceWith = (text, run) => sentences(text).find((piece) => piece.includes(run)) || '';
const headerName = (from) => {
  const name = String(from || '').split('<')[0].trim().replace(/^["']+|["']+$/g, '').trim();
  return name.includes('@') ? '' : name;
};

// The email moves a recorded answer leaves on one thread: the model's (checkActions) plus the code's (introActions).
function emailMoves(answer, thread, own, intros) {
  const kept = checkActions(answer, [thread], own).actions.filter((action) => action.kind === 'email');
  return [...kept, ...introActions([thread], intros)];
}
const boundTo = (moves, to) => {
  const matches = moves.filter((action) => nameMatches(action.email?.to, to));
  return matches.length === 1 ? matches[0].email.address || null : null;
};
const answerFor = (to, quote) => ({ actions: [{ kind: 'email', to, ask: '', thread: 1, quote, title: 'x', steps: [] }] });

// One body introduction on its own thread: an answer naming her must bind her address; one naming the introducer
// must bind nothing, and no move may carry the introducer's address.
export function moveCheck(thread, intro, { own = [] } = {}) {
  const message = (thread?.messages || []).find((item) => item.id === intro.message);
  const text = screened(message);
  const intros = new Map([[thread.id, [intro]]]);
  const bound = boundTo(emailMoves(answerFor(intro.name, sentenceWith(text, intro.name)), thread, own, intros), intro.name);
  const sender = headerName(message?.from);
  const moves = emailMoves(answerFor(sender, sentenceWith(text, sender)), thread, own, intros);
  const introducerDropped = !(sender && boundTo(moves, sender)) && !moves.some((action) => low(action.email?.address) === low(intro.by));
  return { bound, introducerDropped };
}

// Every capitalised run of 1 to 3 words in every candidate email of a thread the user wrote in, each as an answer
// naming it, with the thread's own movable map: a binding to any address but the one of the Intro the run names is wrong.
export function adversarialCheck(threads, { own = [], movable = new Map(), isCandidate = () => true } = {}) {
  const tally = { names: 0, emails: 0, bound: 0, wrong: 0 };
  for (const thread of threads || []) {
    const messages = thread.messages || [];
    const ownIn = (message) => isOwn(message, own);
    if (!messages.some(ownIn)) continue;
    const intros = new Map([[thread.id, movable.get(thread.id) || []]]);
    for (const message of messages) {
      if (ownIn(message) || !isCandidate(message)) continue;
      tally.emails += 1;
      const text = screened(message);
      const runs = [...new Set(text.match(RUN) || [])];
      if (!runs.length) continue;
      // One recorded answer holding every run; each run is judged on its own actions plus the code's.
      const answer = { actions: runs.map((run) => answerFor(run, sentenceWith(text, run)).actions[0]) };
      const kept = checkActions(answer, [thread], own).actions.filter((action) => action.kind === 'email');
      const code = introActions([thread], intros);
      for (const run of runs) {
        tally.names += 1;
        const moves = [...kept.filter((action) => action.email.to === run.slice(0, 60)), ...code];
        const matches = moves.filter((action) => nameMatches(action.email?.to, run));
        if (matches.length !== 1) continue;
        tally.bound += 1;
        const expected = intros.get(thread.id).filter((intro) => nameMatches(intro.name, run));
        if (expected.length !== 1 || low(matches[0].email.address) !== expected[0].address) tally.wrong += 1;
      }
    }
  }
  return tally;
}

// The reason a workspace-domain email is or is not in the live log, the first that applies (spec 1.8).
function reasonFor(item, workspace, { logged, runs }) {
  const was = logged.get(`outlook:${item.ref}`);
  if (was) return was.workstream === workspace.name ? 'in log' : was.workstream ? 'logged elsewhere' : 'logged unsure';
  if (item.workstream !== workspace.name) return item.workstream ? 'routed elsewhere' : 'unsure';
  const at = Date.parse(item.at);
  if (workspace.found?.at && at < Date.parse(workspace.found.at)) return 'before the workspace';
  const first = Math.min(...runs.map((run) => run.at));
  if (Number.isFinite(first) && at < first - 7 * DAY_MS) return 'not in window';
  if (runs.some((run) => run.outlookOk && run.at > at)) return 'stored late';
  return 'not looked yet';
}

const moveOf = (row) => {
  if (row.intro.shape === 'to') return 'reply (existing)';
  if (!row.workspace) return 'none (no workspace)';
  if (!row.kept) return 'none (not kept)';
  if (row.written) return `none (written ${day(row.written)})`;
  return 'email';
};

export function replayReport({ routed = [], logged = [], runs = [], workstreams = [], intros = [], adversarial = null } = {}, { days = 60, ms = 0, show = false, domain = null } = {}) {
  const named = workstreams.filter(isNamed);
  const log = new Map(logged.map((item) => [item.id, item]));
  const lines = [`replay: Apple Mail only (Gmail-API workspaces are not read), ${days} days, ${routed.length} emails, ${routed.filter((item) => item.workstream).length} filed, ${ms} ms`];
  const only = domain ? low(domain).replace(/^@/, '') : null;
  let exit = 0;
  const byDomain = new Map();
  for (const item of [...routed].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const sender = low(item.who?.[0]?.address);
    if (!sender) continue;
    const homes = named.map((w) => ({ w, d: (w.domains || []).map(low).find((d) => d && atDomain(sender, d)) })).filter((hit) => hit.d);
    if (!homes.length) continue;
    const d = homes[0].d;
    if (only && d !== only && !atDomain(sender, only)) continue;
    const entry = byDomain.get(d) || { domain: d, workspaces: [...new Set(homes.map((hit) => hit.w.name))], seen: 0, filed: 0, absent: 0, reasons: {} };
    byDomain.set(d, entry);
    entry.seen += 1;
    const shared = homes.length > 1;
    const workspace = homes[0].w;
    const reason = shared ? 'shared domain' : reasonFor(item, workspace, { logged: log, runs });
    if (!shared && item.workstream === workspace.name) entry.filed += 1;
    if (reason !== 'in log') entry.absent += 1;
    entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
    const wrong = !shared && WRONG_REASONS.has(reason);
    if (wrong) exit = 1;
    const who = show ? `${sender} "${String(item.title || '').slice(0, 50)}"` : `@${domainOf(sender)}`;
    lines.push(`${wrong ? 'WRONG ' : ''}file ${day(item.at)} ${who} -> ${shared ? homes.map((hit) => hit.w.name).join(' + ') : workspace.name} ${item.how || 'none'} log: ${log.has(`outlook:${item.ref}`) ? 'yes' : 'no '} ${reason.padEnd(20)} kept: ${isKept(workspace) ? 'yes' : 'no'}`);
  }
  const summary = [...byDomain.values()];
  for (const entry of summary) {
    const absent = Object.entries(entry.reasons).filter(([reason]) => reason !== 'in log')
      .sort(([a], [b]) => REASONS.indexOf(a) - REASONS.indexOf(b)).map(([reason, count]) => `${count} ${reason}`);
    lines.push(entry.workspaces.length > 1
      ? `${entry.domain}: ${entry.seen} seen, shared by ${entry.workspaces.join(' + ')} (out of the exit)`
      : `${entry.domain}: ${entry.seen} seen, ${entry.filed} filed to ${entry.workspaces[0]}, ${entry.absent} absent from the live log${absent.length ? ` (${absent.join(', ')})` : ''}`);
  }
  for (const row of intros) {
    const { intro } = row;
    if (only && !atDomain(intro.by, only) && !atDomain(intro.address, only)) continue;
    const by = show ? intro.by : `@${domainOf(intro.by)}`;
    const to = show ? `${intro.name} ${intro.address}` : `@${domainOf(intro.address)}`;
    lines.push(`intro ${day(intro.at)} ${intro.shape} by ${by} -> ${to} workspace: ${row.workspace || 'none'} kept: ${row.kept ? 'yes' : 'no'} written: ${row.written ? day(row.written) : 'no'} move: ${moveOf(row)} ask: ${row.ask?.status || 'none'} ${row.ask?.holds ? 'holds' : 'misses'}`);
    if (!row.check) continue;
    const right = row.check.bound === intro.address;
    const shown = row.check.bound ? (show ? row.check.bound : `@${domainOf(row.check.bound)}`) : 'nothing';
    if (!right || !row.check.introducerDropped) exit = 1;
    lines.push(`${right && row.check.introducerDropped ? '  ' : 'WRONG '}move-check: bound ${shown}${right ? '' : ' (not the introduced address)'}; introducer ${row.check.introducerDropped ? 'dropped' : 'BOUND'}`);
  }
  if (adversarial) {
    if (adversarial.wrong > 0) exit = 1;
    lines.push(`${adversarial.wrong > 0 ? 'WRONG ' : ''}move-check: ${adversarial.names} names tried on ${adversarial.emails} emails, ${adversarial.bound} bound, ${adversarial.wrong} wrong`);
  }
  return { lines, summary, exit };
}
