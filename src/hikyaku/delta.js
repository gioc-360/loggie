// The delta: what the user changed between hikyaku's draft and what they actually sent.
// Sent is the truth. The size of the edit is the measure of the draft, and the edits are what the
// next draft should learn. Finds the sent copy wherever it is: Gmail, Apple Mail's Outlook Sent folder,
// or the user's words quoted in a reply (mergeQuoted / mergeSent have already put those in the thread).
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addressOf } from './draft.js';
import { ownText } from './voice.js';
import { jsonLines } from './util.js';
import { baseSubject } from './sent-mail.js';

const words = (text) => String(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
// Signatures are Outlook's, not the draft's: compare only what the user wrote above them.
const SIGNATURE = /\n\s*(best( regards)?|thanks|thank you|cheers|sincerely|warmly),?\s*\n[\s\S]*$/i;

export function draftText(markdown = '') {
  return markdown.split('\n').filter((line) => !/^\*\*(To|Subject|Cc):\*\*/i.test(line.trim())).join('\n').replace(SIGNATURE, '').trim();
}

export function sentText(body = '') {
  return ownText(body).replace(SIGNATURE, '').trim();
}

// Word-level longest-common-subsequence diff. Small inputs (an email), so the quadratic table is fine.
export function wordDiff(before, after) {
  const a = words(before), b = words(after);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    table[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].toLowerCase() === b[j].toLowerCase()) { ops.push(['=', b[j]]); i += 1; j += 1; }
    else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) { ops.push(['+', b[j]]); j += 1; }
    else { ops.push(['-', a[i]]); i += 1; }
  }
  const count = (op) => ops.filter(([kind]) => kind === op).length;
  const kept = count('='), added = count('+'), removed = count('-');
  return { ops, kept, added, removed, draftWords: a.length, sentWords: b.length, editRatio: a.length ? Number(((added + removed) / a.length).toFixed(3)) : null };
}

export function renderDiff(ops) {
  const out = [];
  for (const [kind, word] of ops) {
    const last = out.at(-1);
    if (last && last.kind === kind) last.words.push(word); else out.push({ kind, words: [word] });
  }
  return out.map(({ kind, words: run }) => (kind === '=' ? run.join(' ') : kind === '+' ? `{+${run.join(' ')}+}` : `[-${run.join(' ')}-]`)).join(' ');
}

// The sent message that answers this draft: from the user, in the reply thread, after the draft was written.
export function findSent({ reply, draftedAt, threads, ownAddress }) {
  const own = new Set((Array.isArray(ownAddress) ? ownAddress : [ownAddress]).map((item) => String(item || '').toLowerCase()));
  const to = String(reply?.to || '').toLowerCase();
  const subject = baseSubject(reply?.subject || '');
  const candidates = threads
    .filter((thread) => baseSubject(thread.subject) === subject)
    .flatMap((thread) => (thread.messages || []).map((message) => ({ message, thread })))
    .filter(({ message }) => own.has(addressOf(message.from).toLowerCase()) && (message.timestamp || '') >= draftedAt
      && (!to || String(message.to || '').toLowerCase().includes(to) || message.source === 'quoted'));
  return candidates.sort((x, y) => (x.message.timestamp || '').localeCompare(y.message.timestamp || ''))[0] || null;
}

// Records one delta per draft, once: DELTA.md in the task folder and a line in deltas.jsonl.
// A new email has no thread, and the user may rewrite its subject (seen 2026-10-04: "NBA 5110: missing class ..."
// became "Request to be remote for Oct 6 class (leg injury) | ..."), so matching by subject finds nothing. The
// fallback: the earliest message in Outlook's Sent copy to the same recipient after the draft was written.
export function findSentByRecipient({ reply, draftedAt, sentMail = [] }) {
  const to = String(reply?.to || '').toLowerCase();
  if (!to) return null;
  // A reply keeps its thread's subject, so it must still match it; only a new email may change its subject.
  const sameThread = (message) => !reply.original || baseSubject(message.subject) === baseSubject(reply.subject);
  const hit = sentMail.filter((message) => (message.to || []).some((address) => address.toLowerCase() === to) && (message.timestamp || '') >= draftedAt && sameThread(message))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
  return hit ? { message: { ...hit, source: 'outlook' } } : null;
}

export async function recordDeltas({ taskDirectories, threads, ownAddress, home, sentMail = [] }) {
  const recorded = [];
  for (const directory of taskDirectories) {
    if (await stat(join(directory, 'DELTA.md')).catch(() => null)) continue;
    const draftFile = join(directory, 'DRAFT.md');
    const drafted = await stat(draftFile).catch(() => null);
    if (!drafted) continue;
    const draftMarkdown = await readFile(draftFile, 'utf8');
    // Older drafts carry the target in their own header lines instead of REPLY.json.
    const header = (name) => (draftMarkdown.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi')) || [])[1]?.trim();
    const reply = JSON.parse(await readFile(join(directory, 'REPLY.json'), 'utf8').catch(() => '{}'));
    // A new email opens with the subject the agent wrote (SUBJECT.txt), so that is what the user saw and edited.
    const agentSubject = (await readFile(join(directory, 'SUBJECT.txt'), 'utf8').catch(() => '')).trim().split('\n')[0];
    if (agentSubject && !reply.original) reply.subject = agentSubject;
    if (!reply.to && header('To')) reply.to = addressOf(header('To'));
    if (!reply.subject && header('Subject')) reply.subject = header('Subject');
    const found = findSent({ reply, draftedAt: drafted.mtime.toISOString(), threads, ownAddress })
      || findSentByRecipient({ reply, draftedAt: drafted.mtime.toISOString(), sentMail });
    if (!found) continue;
    const draft = draftText(draftMarkdown);
    const sent = sentText(found.message.body || '');
    // Apple Mail can list a sent message before it has indexed its text. An empty sent copy would read as "you
    // cut everything" and teach the next draft nonsense (seen 2026-10-04), so the card closes and nothing is learned.
    if (!sent) {
      await writeFile(join(directory, 'DELTA.md'), `# What you changed\n\nSent ${found.message.timestamp} to ${reply.to || found.message.to}. Its text was not readable yet, so nothing was learned from it.\n`);
      continue;
    }
    const diff = wordDiff(draft, sent);
    const sentSubject = String(found.message.subject || '').trim();
    // People the user added before sending (a TA, the course assistants): the next draft should copy them too.
    const draftedTo = `${reply.to || ''},${reply.cc || ''}`.toLowerCase();
    const sentTo = Array.isArray(found.message.to) ? found.message.to : String(found.message.to || '').split(/[,;]\s*/);
    const addedRecipients = sentTo.map((item) => addressOf(item).toLowerCase()).filter((item) => item && !draftedTo.includes(item) && !(Array.isArray(ownAddress) ? ownAddress : [ownAddress]).map((own) => String(own || '').toLowerCase()).includes(item));
    const subjectChanged = Boolean(sentSubject && reply.subject && sentSubject.replace(/^\s*(re|fwd?):\s*/i, '') !== String(reply.subject).replace(/^\s*(re|fwd?):\s*/i, ''));
    const source = found.message.source === 'quoted' ? 'quoted in their reply' : found.message.source === 'outlook' ? 'Apple Mail (Outlook Sent)' : 'Gmail Sent';
    await writeFile(join(directory, 'DELTA.md'), [
      `# What you changed`, '', `Sent ${found.message.timestamp} to ${reply.to || found.message.to}, found in ${source}.`,
      `Draft ${diff.draftWords} words, sent ${diff.sentWords}. Kept ${diff.kept}, added ${diff.added}, removed ${diff.removed}. Edit ratio ${diff.editRatio}.`,
      ...(subjectChanged ? [`Subject: hikyaku wrote "${reply.subject}", you sent "${sentSubject}".`] : []),
      ...(addedRecipients.length ? [`You also sent it to: ${addedRecipients.join(', ')}.`] : []), '',
      '## Draft', '', draft, '', '## Sent', '', sent, '', '## Changes ([-removed-] {+added+})', '', renderDiff(diff.ops), '',
    ].join('\n'));
    const entry = { at: new Date().toISOString(), task: directory.split('/').pop(), to: reply.to || null, subject: reply.subject || null, sentSubject: subjectChanged ? sentSubject : null, addedRecipients, sentAt: found.message.timestamp, source, draftWords: diff.draftWords, sentWords: diff.sentWords, kept: diff.kept, added: diff.added, removed: diff.removed, editRatio: diff.editRatio, draft, sent };
    await appendFile(join(home, 'deltas.jsonl'), `${JSON.stringify(entry)}\n`);
    recorded.push(entry);
  }
  await writeRecentVoice(home);
  return recorded;
}

// Recency: how the user writes now beats how they wrote two years ago. The newest sends they actually
// changed become voice/recent.md, which the briefed agent reads before the older intros.
export function recentEdits(entries, { limit = 3 } = {}) {
  // Chat sends (entries with `app`) teach the texting voice, not this file, which is how the user writes email.
  return entries.filter((entry) => !entry.app).filter((entry) => entry.editRatio > 0 || entry.sentSubject || entry.addedRecipients?.length)
    .sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')))
    .slice(0, limit);
}

const runs = (ops, kind) => {
  const out = [];
  let current = [];
  for (const [op, word] of [...ops, ['end', '']]) {
    if (op === kind) current.push(word);
    else if (current.length) { out.push(current.join(' ')); current = []; }
  }
  return out;
};

// How long the user's emails are, counted by code from their own sends (docs/replies/spec-a.md R2). Drafts ran
// 119% of what he sent (offline test, 2026-10-16) and no voice file stated a length. One number: the median of the
// sent word counts, this workstream's when it has MIN_SENDS, else all of them, else none. Chat sends never count.
export const MIN_SENDS = 3;
export function lengthFor(entries, { taskIds = null } = {}) {
  const sent = (entries || []).filter((entry) => entry && !entry.app && typeof entry.sentWords === 'number' && entry.sentWords > 0);
  const ids = taskIds ? new Set(taskIds) : null;
  const mine = ids ? sent.filter((entry) => ids.has(entry.task)) : sent;
  const rows = mine.length >= MIN_SENDS ? mine : sent;
  if (rows.length < MIN_SENDS) return null;
  const sorted = rows.map((entry) => entry.sentWords).sort((a, b) => a - b);
  return { median: sorted[Math.floor((sorted.length - 1) / 2)], sends: rows.length };
}

// What the Workspaces tab shows under "How you write here": the target the draft is given, and how many of the
// user's email sends are in this workstream (fewer than MIN_SENDS means the target is their overall one).
export function voiceFor(entries, taskIds = []) {
  const ids = new Set(taskIds);
  const here = (entries || []).filter((entry) => entry && !entry.app && entry.sentWords > 0 && ids.has(entry.task)).length;
  const length = lengthFor(entries, { taskIds: ids });
  return length ? { median: length.median, sends: length.sends, here } : { median: null, sends: 0, here };
}

export function recentMarkdown(edits, { length = null } = {}) {
  const lines = ['# How you write now', ''];
  if (length) lines.push('## Length', `Your sent emails here: median ${length.median} words (${length.sends} sends).`, `Write the body at or under ${length.median} words unless the thread asks for more.`, '');
  if (!edits.length) {
    lines.push('No edits yet: none of hikyaku\'s drafts has been found sent with changes. Until one is, follow intros.md.', '');
    return lines.join('\n');
  }
  lines.push(`Your ${edits.length} newest sent emails that you changed from hikyaku's draft, newest first. Where this file and intros.md disagree, this file wins.`, '');
  for (const edit of edits) {
    const { ops } = wordDiff(edit.draft || '', edit.sent || '');
    const removed = runs(ops, '-'), added = runs(ops, '+');
    lines.push(`## ${String(edit.sentAt || '').slice(0, 10)} to ${edit.to || 'unknown'}: ${edit.subject || '(no subject)'}`, '');
    if (removed.length) lines.push(`You cut (do not write these again): ${removed.map((run) => `"${run}"`).join(', ')}`);
    if (added.length) lines.push(`You added: ${added.map((run) => `"${run}"`).join(', ')}`);
    if (edit.sentSubject) lines.push(`Subject: you changed "${edit.subject}" to "${edit.sentSubject}". Write subjects like yours.`);
    if (edit.addedRecipients?.length) lines.push(`You also sent it to: ${edit.addedRecipients.join(', ')}. When the same people are involved (a TA, course assistants), copy them.`);
    lines.push('', 'What you sent:', '', ...String(edit.sent || '').split('\n').map((line) => `> ${line}`), '');
  }
  return lines.join('\n');
}

export async function writeRecentVoice(home, options) {
  const raw = await readFile(join(home, 'deltas.jsonl'), 'utf8').catch(() => '');
  const entries = jsonLines(raw);
  const edits = recentEdits(entries, options);
  const length = lengthFor(entries);
  await mkdir(join(home, 'voice'), { recursive: true });
  await writeFile(join(home, 'voice', 'recent.md'), recentMarkdown(edits, { length }));
  await writeLength(join(home, 'voice'), length);
  return edits.length;
}

// length.json beside recent.md: the same number as a number, so the draft check (nebius-draft.js) and the
// Workspaces tab never parse markdown. No length -> no file.
export async function writeLength(folder, length, { now = () => new Date() } = {}) {
  const file = join(folder, 'length.json');
  if (!length) return rm(file, { force: true });
  await writeFile(file, `${JSON.stringify({ median: length.median, sends: length.sends, at: now().toISOString() })}\n`);
}

export async function taskDirectoriesUnder(workRoot) {
  const out = [];
  for (const stream of await readdir(workRoot, { withFileTypes: true }).catch(() => [])) {
    if (!stream.isDirectory()) continue;
    for (const task of await readdir(join(workRoot, stream.name), { withFileTypes: true }).catch(() => [])) {
      if (task.isDirectory() && task.name.startsWith('task_')) out.push(join(workRoot, stream.name, task.name));
    }
  }
  return out;
}
