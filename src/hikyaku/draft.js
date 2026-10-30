// Opens a finished reply draft in the user's mail app. It only opens a compose window; the user presses send.
// In Outlook it opens a real reply on the original email when it can verify which one (outlook.js).

import { execFile, spawn } from 'node:child_process';
import { access, appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { jsonLines } from './util.js';

export const HIKYAKU_HOME = join(homedir(), 'Library', 'Application Support', 'Loggie', 'hikyaku');
export const MAIL_APPS = { outlook: 'Microsoft Outlook', 'apple-mail': 'Mail' };
// Two separate choices: where drafts open (mailApp) and where new events open (calendarApp). "chats" names the chat
// apps hikyaku reads and drafts for (messages, whatsapp); off until the user turns it on. "chatDays" overrides the window.
export const DEFAULT_SETTINGS = { mailApp: 'outlook', calendarApp: 'outlook', chats: [] };

export function addressOf(value = '') {
  const match = String(value).match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/);
  return match ? match[0] : '';
}

// `ownAddress` is one address or a list (spec W10b); the reply goes out from the one the email was sent to.
export function replyTarget(thread, ownAddress = '') {
  const own = (Array.isArray(ownAddress) ? ownAddress : [ownAddress]).map((item) => String(item || '').toLowerCase()).filter(Boolean);
  const messages = thread.messages || [];
  const fromOther = [...messages].reverse().find((message) => !own.includes(addressOf(message.from).toLowerCase()));
  const to = addressOf(fromOther?.from || messages.at(-1)?.to || '');
  const subject = /^re:/i.test(thread.subject || '') ? thread.subject : `Re: ${thread.subject || ''}`.trim();
  const reached = own.find((item) => `${fromOther?.to || ''},${fromOther?.cc || ''}`.toLowerCase().includes(item));
  const target = { to, subject, account: Array.isArray(ownAddress) ? reached || own[0] || '' : ownAddress };
  // The email being answered, so the mail app can open a real reply on it instead of a new message.
  if (fromOther) {
    const row = /^apple-mail-(\d+)$/.exec(String(fromOther.id || ''));
    target.original = { from: addressOf(fromOther.from).toLowerCase(), date: fromOther.timestamp || null,
      subject: fromOther.subject || thread.subject || '', messageId: fromOther.messageId || null,
      // The Envelope Index row, so a reply in Apple Mail opens on this exact email (apple-mail-reply.js).
      ...(row ? { rowId: Number(row[1]) } : {}) };
  }
  return target;
}

export function replyFromThreadFile(markdown = '') {
  const subject = (markdown.match(/^# (.+)$/m) || [])[1] || '';
  const senders = [...markdown.matchAll(/^## (.+?) · /gm)].map((match) => match[1]);
  return { to: addressOf(senders.at(-1) || ''), subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim(), account: '' };
}

// Older tasks saved REPLY.json without the original email; THREAD.md still has its sender and date.
export function originalFromThreadFile(markdown = '', to = '') {
  const subject = (markdown.match(/^# (.+)$/m) || [])[1] || '';
  const headers = [...markdown.matchAll(/^## (.+?) · (\S+)\s*$/gm)].map((match) => ({ from: addressOf(match[1]).toLowerCase(), date: match[2] }));
  const hit = [...headers].reverse().find((header) => header.from && (!to || header.from === to.toLowerCase()));
  return hit ? { from: hit.from, date: hit.date, subject, messageId: null } : null;
}

// Outlook adds the user's signature to every new message, so a draft that carries its own shows two.
// Cut what follows the last sign-off line when it looks like a signature: a few short lines.
const SIGN_OFF = /^(best( regards)?|kind regards|regards|all the best|best wishes|thanks( so much)?|thank you( so much)?|many thanks|cheers|sincerely|warmly|warm regards)[,!.]?$/i;

export function withoutSignature(body = '') {
  const lines = String(body).trimEnd().split('\n');
  const at = lines.findLastIndex((line) => SIGN_OFF.test(line.trim()));
  if (at < 0) return String(body).trim();
  const after = lines.slice(at + 1).filter((line) => line.trim());
  if (after.length > 12 || after.some((line) => line.length > 120)) return String(body).trim();
  return lines.slice(0, at + 1).join('\n').trim();
}

// When the user's mail signature already starts with a sign-off ("Best regards,\nGio ..."), a draft that ends
// with one too shows it twice (seen 2026-10-04 on a new Outlook message). settings.json "signOffInSignature":
// true drops the draft's own closing sign-off line; a closing "Thank you," stays.
const CLOSING_SIGN_OFF = /^(best( regards)?|kind regards|regards|all the best|best wishes|cheers|sincerely|warmly|warm regards)[,!.]?$/i;
export function withoutSignOff(body = '') {
  const lines = withoutSignature(body).split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length && CLOSING_SIGN_OFF.test(lines.at(-1).trim())) lines.pop();
  return lines.join('\n').trimEnd();
}

// What the Outlook reply must look like, from the task alone, never from Outlook: the person, the user's own
// addresses (REPLY.json's account plus settings.json "ownAddresses": Outlook may hold a school address while triage
// reads a Gmail one), To, Cc, the subject and the draft's first line. Saved beside the draft as .reply-expected.json,
// so the helper audits against it and an eval check reads the same file afterwards.
export const EXPECTED = '.reply-expected.json';
export function replyExpectation({ reply = {}, original = {}, body = '', ownAddresses = [] } = {}) {
  const list = (value) => (Array.isArray(value) ? value : String(value || '').split(/[,;]/)).map((item) => addressOf(item).toLowerCase()).filter(Boolean);
  return {
    sender: String(original.from || '').toLowerCase(),
    me: [...new Set(list([reply.account || '', ...list(ownAddresses)]))],
    to: list(reply.to), cc: list(reply.cc), subject: reply.subject || '', date: original.date || null,
    draft: String(body).split('\n').find((line) => line.trim())?.trim() || '', scenario: reply.scenario || null,
  };
}

// The fields of a helper result that go into the attempt log (docs/hikyaku-outlook-eval.md, "Metrics").
const ATTEMPT_FIELDS = ['helperSha', 'how', 'steps_ms', 'candidates_total', 'candidates_checked', 'candidates_verified', 'candidates_rejected', 'replied_on', 'audit', 'findings', 'pasted'];
function attemptFields(result = {}, scenario = null) {
  const out = scenario ? { scenario } : {};
  for (const key of ATTEMPT_FIELDS) if (result[key] !== undefined) out[key] = result[key];
  return out;
}

// Each live reply saves the copies of Outlook's tree it decided on, in hikyaku's own folder (they hold mail text),
// newest ten per task, so a wrong reply can be replayed with `hikyaku-outlook decide`.
const KEEP_RUNS = 10;
async function snapshotDirectory(home, taskDirectory, now = new Date()) {
  const parent = join(home, 'outlook-runs', basename(taskDirectory));
  await mkdir(parent, { recursive: true });
  const old = (await readdir(parent).catch(() => [])).sort();
  for (const name of old.slice(0, Math.max(0, old.length - KEEP_RUNS + 1))) await rm(join(parent, name), { recursive: true, force: true });
  return join(parent, now.toISOString().replace(/[:.]/g, '-'));
}

// The body pasted into an Outlook reply: the draft down to its closing line, then the user's name if it is set and
// not already there.
export function replyText(draft = '', name = '') {
  const body = withoutSignature(draft);
  const last = body.split('\n').at(-1).trim();
  if (!name || !SIGN_OFF.test(last)) return body;
  return `${body}\n${name}`;
}

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);

// A mailApp "gmail" saved before 2026-10-28 (teammates' mail fix 2: Gmail is no longer a choice) reads as Apple Mail.
// That is the safer of the two: Loggie reads Gmail only through Apple Mail, so the email is there and Mail's own Reply
// opens on it, unsent; asking again would reopen setup on an install that works, and Outlook may not hold that account.
export const mailAppOf = (value) => (value === 'gmail' ? 'apple-mail' : value);

// Defaults that fit the Mac they run on, not one person's: Outlook only when it is installed, else Apple Mail. A value
// written in settings.json always wins. `chosen` names what was picked. A stored "agent" key passes through unread.
// The Mac account's full name ("Gio Caballero"), read once per run; '' when it cannot be read. LOGGIE_FULL_NAME stands
// in for it (tests, so a check never depends on whose Mac runs it).
let macName = null;
export const macFullName = () => (process.env.LOGGIE_FULL_NAME !== undefined ? Promise.resolve(process.env.LOGGIE_FULL_NAME)
  : (macName ??= new Promise((resolve) => execFile('id', ['-F'], (error, stdout) => resolve(error ? '' : String(stdout).trim())))));

// The name under a draft's sign-off: settings.json "signName", else the first name of the Mac account, the same name
// setup suggests (setup-status.js suggestedName). loggie-reply-yes: with it empty, replies ended "Best," with no name.
export async function resolveSettings(parsed = {}, { appExists = exists, fullName = macFullName } = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  const chosen = [];
  if (!String(parsed?.signName || '').trim()) {
    const first = String(await fullName().catch(() => '')).trim().split(/\s+/)[0].slice(0, 40);
    settings.signName = first;
    if (first) chosen.push('signName');
  }
  if (!parsed?.mailApp) { settings.mailApp = (await appExists('/Applications/Microsoft Outlook.app')) ? 'outlook' : 'apple-mail'; chosen.push('mailApp'); }
  else settings.mailApp = mailAppOf(parsed.mailApp);
  if (!parsed?.calendarApp) { settings.calendarApp = settings.mailApp === 'outlook' ? 'outlook' : 'google-calendar'; chosen.push('calendarApp'); }
  return { ...settings, chosen };
}

export async function readSettings(home = HIKYAKU_HOME, options = {}) {
  let parsed = {};
  try { parsed = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')); } catch { parsed = {}; }
  return resolveSettings(parsed, options);
}

export function composeCommand({ mailApp, to, cc = '', subject, body, account }) {
  if (!(mailApp in MAIL_APPS)) throw new Error(`Unknown mail app "${mailApp}". Use outlook or apple-mail.`);
  const ccPart = cc ? `cc=${encodeURIComponent(cc)}&` : '';
  // Several addresses (one email to all, ask-run.js) are joined by a plain comma, each encoded alone (RFC 6068).
  const url = `mailto:${String(to).split(/[,;]\s*/).filter(Boolean).map(encodeURIComponent).join(',')}?${ccPart}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return ['open', ['-a', MAIL_APPS[mailApp], url]];
}

// Outlook gets a real reply on the original email when the helper can find and verify it; otherwise, and for
// the other mail apps, a new message, with the reason it was not a reply.
// One JSON line per run in the task folder, so a failed or doubled draft can be read back instead of guessed at.
const EMAIL_ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const ATTEMPTS = 'ATTEMPTS.jsonl';

export async function readAttempts(taskDirectory) {
  const text = await readFile(join(taskDirectory, ATTEMPTS), 'utf8').catch(() => '');
  return jsonLines(text);
}

// Opens the draft once per email. A second run would leave a second draft beside the first in Outlook's Drafts,
// so it stops and says where the first one is, unless the user asks again on purpose.
export async function openDraft({ again = false, now = () => new Date(), ...options }) {
  const { taskDirectory, dryRun = false } = options;
  const started = now();
  let earlierNote = '';
  if (!dryRun && !again) {
    const earlier = (await readAttempts(taskDirectory)).filter((attempt) => ['reply', 'new-message', 'chat'].includes(attempt.mode)).at(-1);
    // Only this same draft counts as already open. A draft written after that attempt (Do it rewrote a stale one) is a
    // new draft and opens; the card says where the older copy still sits.
    // Whole milliseconds: mtimeMs carries a fraction and the attempt's ISO time does not, so a draft written in the same
    // millisecond as the attempt read as newer (the floor test failed about 1 run in 3).
    const draftedAt = Math.floor((await stat(join(taskDirectory, 'DRAFT.md')).catch(() => null))?.mtimeMs || 0);
    if (earlier && earlier.mode !== 'chat' && draftedAt > Date.parse(earlier.at)) {
      earlierNote = ` An older draft from ${earlier.at.slice(0, 16).replace('T', ' ')} may still be in ${earlier.opened === 'outlook' ? 'Outlook' : earlier.opened}'s Drafts; delete that one.`;
    } else if (earlier) {
      // A chat draft sits in the message box, not in a Drafts folder: placing it twice would double the text.
      if (earlier.mode === 'chat') return { opened: earlier.opened, mode: 'already-open', to: earlier.to || '', detail: `This draft was already put in the ${earlier.opened} chat's message box at ${earlier.at}. To put it there again, clear the box and ask again.` };
      const where = earlier.mode === 'reply' ? `as a reply in ${earlier.opened === 'outlook' ? 'Outlook' : earlier.opened}` : `as a new message in ${earlier.opened}`;
      return { opened: earlier.opened, mode: 'already-open', to: earlier.to || '', detail: `This draft was already opened ${where} at ${earlier.at}. It is in Drafts there. To open a fresh copy, delete that one and ask again.` };
    }
  }
  let result;
  try { result = await openDraftOnce(options); if (earlierNote && result.detail) result = { ...result, detail: `${result.detail}${earlierNote}` }; }
  catch (error) { result = { mode: 'failed', reason: error.message }; throw error; }
  finally {
    if (!dryRun) {
      const line = { at: started.toISOString(), ms: now() - started, ...result };
      await appendFile(join(taskDirectory, ATTEMPTS), `${JSON.stringify(line)}\n`).catch(() => {});
    }
  }
  return result;
}

// The task's thread, who the reply goes to and the email it answers (REPLY.json first, THREAD.md for older tasks).
export async function taskReply(taskDirectory) {
  const thread = await readFile(join(taskDirectory, 'THREAD.md'), 'utf8').catch(() => '');
  const reply = JSON.parse(await readFile(join(taskDirectory, 'REPLY.json'), 'utf8').catch(() => 'null')) || replyFromThreadFile(thread);
  return { thread, reply, original: reply.original || originalFromThreadFile(thread, reply.to) };
}

// Before anything opens, the newest mail with the person is checked against the task's thread (freshness.js). Twice
// (2026-10-04, 2026-10-05) a draft answered an email the person had already written past, because the task's thread
// was not the newest correspondence and nothing checked. A newer message stops the run with mode "stale"; the user's
// explicit staleOk opens it anyway. The app passes `readSent` and `readInbox` (the user's Outlook mail, sent
// and received, read through Apple Mail); without any source to read (the CLI has neither) nothing is blocked, and the attempt line says
// freshness: "unchecked".
async function openDraftOnce({ staleOk = false, readSent = null, readInbox = null, ...options }) {
  const { taskDirectory, home = HIKYAKU_HOME } = options;
  const { thread, reply, original } = await taskReply(taskDirectory);
  // A chat task (REPLY.json names the app) goes into the chat's message box, never a mail app (chats.js). The draft
  // is the message as written: no signature or sign-off handling, which is email's.
  if (reply.app === 'messages' || reply.app === 'whatsapp') {
    const { openChatDraft } = await import('./chats.js');
    const body = await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8').catch(() => '');
    const { spawnImpl, dryRun, chat = {} } = options;
    return openChatDraft({ taskDirectory, thread, reply, body, staleOk, dryRun, spawnImpl, ...chat });
  }
  let freshness = 'unchecked';
  if (original?.from) {
    const { freshnessOf } = await import('./freshness.js');
    const settings = await readSettings(home);
    const fresh = await freshnessOf({ thread, original, me: [reply.account || '', ...(settings.ownAddresses || [])], readSent, readInbox });
    freshness = fresh.freshness;
    if (fresh.newer && !staleOk) {
      const { reason, ...newer } = fresh.newer;
      return { opened: 'none', mode: 'stale', to: reply.to || '', reason, freshness, newer };
    }
  }
  const result = await placeDraft(options);
  return { ...result, freshness };
}

// The longest placeDraft waits for the Outlook reply before it takes the clipboard floor. C4b measures the real timing
// of the helper on a live Mac and may lower this.
// C4b, the most a reply may take before the draft goes to the clipboard instead. 20 s from 2026-10-08 (search 7.6 s
// cold, 3.8 s warm) was too short for a long thread: the verify step took 21.5 s and 34.2 s on a 6-candidate thread
// (2026-10-10). The wait is hidden now (Do it queues; the helper verifies in the background and Outlook comes forward
// only for Reply and the paste), so it may be longer.
export const OUTLOOK_FLOOR_MS = 60000;
// One Outlook reply at a time: two helpers selecting rows in the same window would judge each other's emails.
let outlookTurn = Promise.resolve();
export function inOutlookTurn(work) {
  const turn = outlookTurn.then(work, work);
  outlookTurn = turn.catch(() => {});
  return turn;
}
export const FLOOR_DETAIL = 'Draft copied. Paste it in the reply (Cmd+V).';

// The reply, or { status: 'timeout' } when it has not finished within `limit` ms.
async function withinLimit(promise, limit) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), limit); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

// `mailApp` opens this one draft in that app instead of settings.json's (the "Open draft in" pick on a next move,
// pick.js); the paths are the same ones, the setting is left as it is.
async function placeDraft({ taskDirectory, home = HIKYAKU_HOME, spawnImpl = spawn, replyImpl, appleMailImpl = null, dryRun = false, allowNew = false, mailApp = null, clipboardImpl = null, floorMs = OUTLOOK_FLOOR_MS, reopenWaitMs = 2000 }) {
  if (mailApp !== null && !(mailApp in MAIL_APPS)) throw new Error(`Unknown mail app "${mailApp}". Use outlook or apple-mail.`);
  const settingsRead = await readSettings(home);
  const settingsFirst = mailApp ? { ...settingsRead, mailApp } : settingsRead;
  const text = await readFile(join(taskDirectory, 'DRAFT.md'), 'utf8').catch(() => '');
  const body = settingsFirst.signOffInSignature ? withoutSignOff(text) : withoutSignature(text);
  // A reply in Outlook gets no signature (measured 2026-10-05),
  // so a reply keeps the draft's closing line, with the user's name under it from settings.json "signName".
  // signOffInSignature is about new messages only.
  const replyBody = replyText(text, settingsFirst.signName);
  if (!body) throw new Error(`No draft yet: write the email body to ${join(taskDirectory, 'DRAFT.md')} first.`);
  const { thread, reply, original } = await taskReply(taskDirectory);
  // A new email (no original to reply to) may carry the agent's own subject line.
  const subjectLine = (await readFile(join(taskDirectory, 'SUBJECT.txt'), 'utf8').catch(() => '')).trim().split('\n')[0];
  if (!original?.from && subjectLine) reply.subject = subjectLine.slice(0, 200);
  // Course assistants or a TA the agent found in the syllabus (CC.txt). Code keeps only addresses whose name part
  // appears in SYLLABUS.txt, so a model can propose a Cc but never invent one.
  const proposed = (await readFile(join(taskDirectory, 'CC.txt'), 'utf8').catch(() => '')).split(/[\s,;]+/).filter((item) => EMAIL_ADDRESS.test(item));
  if (proposed.length) {
    const syllabus = (await readFile(join(taskDirectory, 'SYLLABUS.txt'), 'utf8').catch(() => '')).toLowerCase();
    const verified = proposed.filter((address) => syllabus.includes(address.split('@')[0].toLowerCase()));
    reply.cc = [...new Set([...String(reply.cc || '').split(/[,;]\s*/).filter(Boolean), ...verified])].join(', ');
  }
  const settings = settingsFirst;
  let reason = '', replyStatus = {};
  if (settings.mailApp === 'outlook' && original?.from) {
    const outlook = await import('./outlook.js');
    const bodyFile = join(taskDirectory, '.reply-body.txt');
    const writeBody = async (text) => { await writeFile(bodyFile, text); return bodyFile; };
    const expectFile = join(taskDirectory, EXPECTED);
    await writeFile(expectFile, `${JSON.stringify(replyExpectation({ reply, original, body: replyBody, ownAddresses: settings.ownAddresses }), null, 2)}\n`);
    const snapshotDir = dryRun ? null : await snapshotDirectory(home, taskDirectory);
    const attempt = () => inOutlookTurn(() => withinLimit((replyImpl || outlook.outlookReply)({ original, body: replyBody, me: reply.account || '', dryRun, writeBody, expectFile, snapshotDir, timeoutMs: floorMs, inline: settings.replyWindow === 'inline' }), floorMs));
    let result = await attempt();
    // Outlook running with its window closed (or not running) is the usual state between uses, not a failure: open
    // it the way the Dock does, which brings a window back in under a second (measured 2026-10-10), and try once more.
    if (!dryRun && ['no-window', 'no-outlook'].includes(result.status)) {
      spawnImpl('open', ['-a', MAIL_APPS.outlook], { detached: true, stdio: 'ignore' }).unref?.();
      await new Promise((resolve) => setTimeout(resolve, reopenWaitMs));
      result = await attempt();
    }
    await rm(bodyFile, { force: true });
    const seen = attemptFields(result, reply.scenario || null);
    // Opened: the draft is in the reply (or on the clipboard for the user to paste). A reply with findings is
    // opened too, and every finding is named: the user fixes it before pressing Send.
    if (result.status === 'replied' || result.status === 'reply-open-draft-on-clipboard' || result.pasted === true || result.status === 'dry-run') {
      const detail = result.finding_messages?.length ? `The reply is open in Outlook with the draft in it. Check before sending: ${result.finding_messages.join(' ')}` : result.detail;
      return { opened: 'outlook', mode: result.status === 'dry-run' ? 'dry-run' : 'reply', to: reply.to || '', detail, status: result.status, outlookVersion: result.outlookVersion, ...seen };
    }
    if (result.status === 'not-trusted') outlook.openAccessibilitySettings(spawnImpl);
    // An error must say what failed: the generic line alone once hid the cause of a failed live run.
    replyStatus = { status: result.status, outlookVersion: result.outlookVersion, ...seen };
    reason = result.status === 'error' || !outlook.REASONS[result.status]
      ? `${outlook.REASONS.error} ${result.detail || result.status || ''}`.trim()
      : outlook.REASONS[result.status];
    // A reply that could not be placed on its email never turns into a new, unthreaded message on its own: the user
    // decides (Gio, 2026-10-05: "it opened in a non thread. this is wrong"). allowNew is that decision. Without it the
    // floor keeps the draft: it is on the clipboard and Outlook is in front, for the user to paste into the reply.
    if (!allowNew) {
      if (dryRun) return { opened: 'outlook', mode: 'dry-run', to: reply.to || '', detail: `Would copy the draft to the clipboard and bring Outlook forward. ${reason}` };
      await (clipboardImpl || (await import('./pick.js')).pbcopy)(replyBody);
      const child = spawnImpl('open', ['-a', MAIL_APPS.outlook], { detached: true, stdio: 'ignore' });
      child.unref?.();
      return { opened: 'outlook', mode: 'clipboard', to: reply.to || '', detail: FLOOR_DETAIL, reason, ...replyStatus };
    }
    if (dryRun) return { opened: 'outlook', mode: 'dry-run', to: reply.to || '', detail: reason };
  } else if (settings.mailApp === 'apple-mail' && original?.from) {
    // Apple Mail: Mail's own Reply on the email, the draft pasted at its top, read back; never sent (apple-mail-reply.js, W11).
    const { appleMailReply, APPLE_MAIL_REASONS } = await import('./apple-mail-reply.js');
    const copy = clipboardImpl || (await import('./pick.js')).pbcopy;
    const result = await (appleMailImpl || appleMailReply)({ original, body: replyBody, own: [reply.account || '', ...(settings.ownAddresses || [])], dryRun, copy });
    if (!dryRun) await writeFile(join(home, 'apple-mail-reply.json'), `${JSON.stringify({ status: result.status, at: new Date().toISOString() })}\n`).catch(() => {});
    if (result.status === 'dry-run') return { opened: 'apple-mail', mode: 'dry-run', to: reply.to || '', detail: result.detail };
    if (result.status === 'replied') {
      return { opened: 'apple-mail', mode: 'reply', to: reply.to || '', status: 'replied',
        detail: `The reply is open in Mail, in the email's thread, with the draft in it. Nothing was sent.${result.finding ? ` Check before sending: ${result.finding}` : ''}` };
    }
    if (result.status === 'reply-open-draft-on-clipboard') {
      await copy(replyBody);
      return { opened: 'apple-mail', mode: 'clipboard', to: reply.to || '', status: result.status, detail: `The reply is open in Mail. ${FLOOR_DETAIL}` };
    }
    if (result.status === 'not-trusted') await (await import('./settings-panes.js')).openPane(result.pane || 'automation', { home }).catch(() => {});
    replyStatus = { status: result.status };
    reason = result.status === 'error' ? `${APPLE_MAIL_REASONS.error} ${result.detail || ''}`.trim()
      : result.status === 'not-trusted' && result.pane === 'accessibility' ? APPLE_MAIL_REASONS['not-trusted-paste'] : APPLE_MAIL_REASONS[result.status] || APPLE_MAIL_REASONS.error;
    // As with Outlook: a reply that could not be placed never turns into a new, unthreaded message on its own.
    if (!allowNew) {
      await copy(replyBody);
      const child = spawnImpl('open', ['-a', MAIL_APPS['apple-mail']], { detached: true, stdio: 'ignore' });
      child.unref?.();
      return { opened: 'apple-mail', mode: 'clipboard', to: reply.to || '', detail: FLOOR_DETAIL, reason, ...replyStatus };
    }
  } else if (settings.mailApp === 'outlook' && !reply.fresh) {
    // A new email the user picked in the ask box (REPLY.json fresh) is the plan, not a fallback: no reason to give.
    reason = 'This task does not record which email it answers, so it opens as a new message.';
  }
  const [command, args] = composeCommand({ mailApp: settings.mailApp, to: reply.to || '', cc: reply.cc || '', subject: reply.subject || '', body, account: reply.account || '' });
  if (dryRun) return { opened: settings.mailApp, mode: 'dry-run', to: reply.to || '', detail: `Would open a new message in ${settings.mailApp}. ${reason}`.trim() };
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { opened: settings.mailApp, mode: 'new-message', to: reply.to || '', ...(reason ? { reason } : {}), ...replyStatus };
}
