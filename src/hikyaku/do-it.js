// Do it, from any card: one press, one visible outcome. The move is drafted by the cloud AI (Nemotron on Nebius) once
// its workspace is approved, and the press returns what happened in words the card shows: the draft open in the mail
// app, the question Loggie stopped on, or why it could not run. Without the approval the card asks for it once.
//
// A refusal that never reached the screen, or a task stopped by an earlier run that threw "already in progress" into
// a status line, left a press that changed nothing on screen: the failure this file exists to prevent.
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CHATS_NAME, setCloud } from './cloud.js';
import { CLOUD_PROVIDER } from './cloud-screen.js';
import { openDraft } from './draft.js';
import { answerTask, currentState, openedOutcome, startHeadless, writeState } from './headless.js';
import { slug } from './util.js';
import { newestSummary } from './gather.js';
import { callLinesFor, callSummaryFor, emailFromOf } from './move-card.js';

const readJson = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);
// The press waits only long enough to catch an answer that needs no work (a refusal, a question shown again). The rest
// is queued: the draft and the Outlook reply finish in the background (22-34 s on a long thread, measured 2026-10-10)
// and `onDone` reports the outcome to the card. Gio at TC3: "its ok to wait if the waiting is hidden and user can just
// click and just queue it in the background".
export const WAIT_MS = 1500;
export const QUEUED = 'Queued. Loggie is drafting it and will open the reply in Outlook. Keep working; this card updates when it lands.';

// What the card says for a state (docs/hikyaku-states.md).
export function outcomeText(state) {
  if (!state) return 'Nothing happened. Try again?';
  return {
    drafting: 'Loggie is drafting this. It opens in your mail app when it is ready.',
    ready: 'Drafted. It opens with your other replies.',
    sent: 'Sent.',
  }[state.phase] || state.question || state.detail || state.phase;
}

const asked = (state) => ({ started: false, phase: state.phase, kind: state.kind || null, text: outcomeText(state) });

// A refused gate says how to approve it, as a named answer the card turns into a button.
function cloudOffState(state) {
  const name = String(state.question || '').match(/^"([^"]+)"/)?.[1] || 'This workspace';
  return { ...state, question: `"${name}" is not approved for the cloud AI yet, so nothing was read or sent. Answer "approve" to let the cloud AI read this workspace and draft its moves.` };
}

// The outcome now, or null while it is still running; either way onDone hears the final one once.
async function settle(run, waitMs, onDone = null, shape = (state) => state) {
  const finished = run.done.catch((error) => ({ phase: 'failed', question: `${error.message}. Try again?` }));
  if (onDone) finished.then(async (state) => onDone(await shape(state))).catch((error) => console.error(`Do it outcome not reported: ${error.message}`));
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try { return await Promise.race([finished, late]); }
  finally { clearTimeout(timer); }
}

export const KEPT_DRAFT_MS = 24 * 60 * 60 * 1000;
export async function keptDraftFresh(taskDirectory, { now = Date.now() } = {}) {
  const time = async (file) => (await stat(join(taskDirectory, file)).catch(() => null))?.mtimeMs || 0;
  const drafted = await time('DRAFT.md');
  if (!drafted || now - drafted > KEPT_DRAFT_MS) return false;
  return (await time('THREAD.md')) <= drafted && (await time('NOTES.md')) <= drafted;
}

const report = (state, started = false) => ({ started, phase: state.phase, kind: state.kind || null, text: outcomeText(state) });
const queued = () => ({ started: true, phase: 'queued', kind: null, text: QUEUED });

// A move made from a call step (gather.js createStepTasks, sourceId "callstep:<call>:<step>") has no brief, so Do it
// answered with the core's "Resource was not found." (2026-10-11, a "map the company's pillar to examples" step). Its brief is
// written now from the step and the call summary lines it rests on, with the summary as CALL.md, so the draft has
// the call to work from. A step that is a task rather than an email ends in DONE.md or YOUR-STEP.md, as for any call step.
export async function briefFromCall({ core, task, project, home }) {
  const found = await callSummaryFor(home, task.sourceId, newestSummary);
  const lines = found ? callLinesFor(found.summary, task.title, 3) : [];
  const folder = join(project.directoryPath, task.id);
  await mkdir(folder, { recursive: true });
  const quoted = lines.map((line) => `- ${line.text}${line.section ? ` (${line.section}${line.time ? `, ${line.time}` : ''})` : ''}`);
  const where = found ? `the call "${found.title}"${found.at ? ` on ${found.at}` : ''}` : 'a call';
  await writeFile(join(folder, 'BRIEF.md'), [`# ${task.title}`, '', `Workstream: **${project.name}**. Your step from ${where}; CALL.md next to this file has the call's notes.`, '',
    '## Quoted from the call', ...(quoted.length ? quoted : ['_No words quoted._']), '',
    '## Done when', '- DRAFT.md holds an email the user can send as is, or DONE.md says why nothing needs writing, or YOUR-STEP.md names the step only the user can take.', '',
    '## Rules', '- Never send email. Write drafts only; the user sends them.', '- Facts come from CALL.md and this brief only.', ''].join('\n'));
  if (found) await writeFile(join(folder, 'CALL.md'), found.summary);
  await writeFile(join(folder, 'THREAD.md'), `# ${task.title}\n\nNo thread: this step comes from a call. Everything needed is in BRIEF.md and CALL.md.\n`, { flag: 'wx' }).catch(() => {});
  await writeFile(join(folder, 'REPLY.json'), JSON.stringify({ to: '', subject: '' }, null, 2), { flag: 'wx' }).catch(() => {});
  return core.createBrief(task.id, {
    objective: task.title,
    context: `Your step from ${where}.\nQuoted from the call:\n${lines.length ? lines.map((line) => `"${line.text}"`).join('\n') : 'No words quoted.'}`,
    constraints: ['Never send email. Write drafts only; the user sends them.'],
    suggestedSteps: ['Read CALL.md for what the call covered', 'Do the step, or write the email it needs'],
    completionCriteria: ['DRAFT.md holds an email the user can send as is, or DONE.md says why nothing needs writing.'],
    assumptions: [],
  });
}

// Runs a fresh draft: approves a fresh move's brief (waiting -> briefed), resets a stopped one (blocked -> waiting
// -> briefed), then starts the run.
async function freshRun({ core, task, project, home, options, startImpl, waitMs, onDone }) {
  if (task.status === 'blocked') task = await core.transitionTask(task.id, 'waiting', 'Do it again in Loggie');
  if (task.status === 'waiting') {
    const approved = await core.getApprovedBrief(task.id).catch((error) => { if (error.status === 404) return null; throw error; });
    if (!approved) {
      const draft = await core.getLatestBrief(task.id).catch((error) => { if (error.status === 404) return null; throw error; })
        || await briefFromCall({ core, task, project, home });
      if (draft?.status !== 'draft') return { started: false, phase: 'failed', text: 'This move has no brief yet, so there is nothing to draft from. Refresh the workspace, then Do it again.' };
      await core.approveBrief(draft.id);
    }
    task = await core.transitionTask(task.id, 'briefed', 'Approved with Do it in Loggie');
  }
  const run = await startImpl({ core, task, directoryPath: project.directoryPath, ...options, home });
  const shape = async (state) => (state?.kind === 'cloud-off' ? writeState(join(project.directoryPath, task.id), cloudOffState(state)) : state);
  const state = await settle(run, waitMs, onDone && ((final) => onDone({ taskId: task.id, ...report(final, run.started) })), shape);
  return state ? report(await shape(state), run.started) : queued();
}

// The user's line for the draft (loggie-do-it-context TC2: "click a button, write a bit of context, click another
// button"), saved in NOTES.md where the draft prompt puts what the user said last and above everything else. A line
// always writes a fresh draft: a kept one was written without it.
export async function saveLine(taskDirectory, line, { now = new Date() } = {}) {
  await appendFile(join(taskDirectory, 'NOTES.md'), `\n\n## What to say, ${now.toISOString().slice(0, 16)}\n${line.trim()}\nThe draft says this, in the user's own words where they fit. It is the point of the message.\n`);
}

// An email move from a chat (workspaces-outlook W5): REPLY.json holds one ask-box line ("email K-House: ask if ..."),
// not a reply target. Do it runs the line through the ask box (options.ask, the app's asker: thread pick, voice, the
// mail app, unsent), then keeps that draft as the move's own (REPLY.json, DRAFT.md, THREAD.md), so the card opens it
// again and closes when it is sent, like any email move. The chat it came from stays in REPLY.json `fromChat`.
// The task moves as a drafted one does (freshRun): approved and briefed, then running while its email is open, blocked
// on a question. Without that it stayed "waiting": a sent email never closed it (closeSent closes briefed, running or
// blocked) and its question never reached Needs you (Fable's audit of W5, 2026-10-17).
async function toRunning({ core, task, project, home }) {
  if (task.status === 'blocked') task = await core.transitionTask(task.id, 'waiting', 'Do it again in Loggie');
  if (task.status === 'waiting') {
    const approved = await core.getApprovedBrief(task.id).catch((error) => { if (error.status === 404) return null; throw error; });
    if (!approved) {
      const draft = await core.getLatestBrief(task.id).catch((error) => { if (error.status === 404) return null; throw error; })
        || await briefFromCall({ core, task, project, home });
      if (draft?.status === 'draft') await core.approveBrief(draft.id);
    }
    task = await core.transitionTask(task.id, 'briefed', 'Approved with Do it in Loggie');
  }
  if (task.status === 'briefed') task = await core.transitionTask(task.id, 'running', 'Written by the ask box in Loggie');
  return task;
}

export async function askMove({ core = null, task = null, project = null, taskDirectory, home, reply, ask, fill = null, line = null, cloud = null, time = null, heldAskId = null }) {
  const stop = async (question, extra = {}) => {
    const state = await writeState(taskDirectory, { phase: 'needs-you', kind: 'ask-move', at: new Date().toISOString(), question, ...extra });
    if (core && task?.status === 'running') await core.transitionTask(task.id, 'blocked', question.slice(0, 500)).catch(() => {});
    return state;
  };
  if (core && task) task = await toRunning({ core, task, project, home });
  // An introduction's move (loggie-intros 1.6) has nothing to ask yet: the user says what to write, and the ask box gets
  // the bound address as a choice key, so it never resolves the name to someone else with it.
  const intro = reply.ask.from === 'intro';
  if (intro && !line) return stop(`Type what to say to ${reply.ask.to} in the line box, then Draft it.`);
  if (!ask) return stop(`Open the ask box and send: "${reply.ask.line}"`);
  const text = line ? `email ${reply.ask.to}: ${line}` : reply.ask.line;
  // origin 'move': the move's own card asks and answers (answerMove); the ask box draws nothing for this run.
  const options = { ...(cloud ? { cloud } : {}), ...(intro ? { choices: { [reply.ask.to]: `outlook:${reply.ask.address}` } } : {}), origin: 'move' };
  // A draft held for a time (loggie-reply-yes): the answer is the time, which goes in by code (ask-run.js fill).
  const done = time && heldAskId && fill ? await fill(heldAskId, time).catch((error) => ({ outcome: 'failed', lines: [error.message] }))
    : await ask(text, options).catch((error) => ({ outcome: 'failed', lines: [error.message] }));
  const result = done?.results?.[0];
  const folder = done?.askId ? join(home, 'asks', done.askId) : null;
  if (folder && result && ['placed', 'clipboard'].includes(result.outcome)) {
    const target = JSON.parse(await readFile(join(folder, 'REPLY.json'), 'utf8'));
    await writeFile(join(taskDirectory, 'REPLY.json'), `${JSON.stringify({ ...target, ask: reply.ask, fromChat: reply.fromChat || null }, null, 2)}\n`);
    // The thread first: a draft older than its thread reads as stale (keptDraftFresh).
    for (const name of ['THREAD.md', 'DRAFT.md']) {
      const body = await readFile(join(folder, name), 'utf8').catch(() => null);
      if (body !== null) await writeFile(join(taskDirectory, name), body);
    }
    const where = result.app === 'apple-mail' ? 'Mail' : 'Outlook';
    return writeState(taskDirectory, { phase: 'in-mail-app', ...(result.outcome === 'clipboard' ? { kind: 'clipboard' } : {}), at: new Date().toISOString(),
      // A time the draft could not back up came out for "[your times]": the card says so (draft-times.js).
      detail: `${result.outcome === 'placed' ? `The email to ${result.to} is open in ${where}, unsent.${done.did?.length ? ` ${done.did.filter((item) => typeof item === 'string').slice(0, 2).join('. ')}.` : ''}` : result.detail || 'The draft is on the clipboard.'}${result.note ? ` ${result.note}` : ''}` });
  }
  // The cloud AI writes it only after a yes (the ask box's own, cloudYes.box): the card asks for it, and "yes" or
  // "always" answers it (answerMove), never a loop of Do it presses.
  if (done?.status === 'needs-yes') return stop(`${(done.lines || []).join(' ')} Answer "yes" to write this one, or "always".`, { needsYes: true });
  // Nothing with a gap is pasted: the card asks for the time, and the answer fills the held draft.
  if (done?.status === 'needs-time') return stop(`${done.lines?.[0] || 'Which time works?'} Answer with the time, e.g. "3 PM EST".`, { needsTime: true, askId: done.askId });
  // Any other question the ask box asks back (which K-House, no one by that name): the answer is what to ask.
  // Each line ends a sentence: the ask box's lines often have no end mark ("No one called ... in Messages or WhatsApp").
  const end = (line) => (/[.!?"]$/.test(line.trim()) ? line.trim() : `${line.trim()}.`);
  const said = (done?.lines || []).filter((line) => String(line).trim()).map(end).join(' ') || result?.detail || 'The ask box could not write it.';
  return stop(`${said} Answer with what to ask, or send it from the ask box: "${text}"`);
}

export async function doIt({ core, taskId, home, options = {}, startImpl = startHeadless, openDraftImpl = options.openDraftImpl || openDraft, waitMs = WAIT_MS, onDone = null, line = null, cloud = null, time = null, heldAskId = null }) {
  const task = await core.getTask(taskId);
  const project = await core.getProject(task.projectId);
  const taskDirectory = join(project.directoryPath, task.id);
  const state = await currentState(taskDirectory);
  if (task.status === 'done') return { started: false, phase: 'done', text: 'This move is already done.' };
  if (state?.phase === 'drafting') return asked(state);
  const reply = JSON.parse(await readFile(join(taskDirectory, 'REPLY.json'), 'utf8').catch(() => 'null'));
  // Not drafted yet, a line from the user, or a draft gone stale: the ask box writes it. Never the chat drafter: the
  // task's source is the chat, and a fresh run would draft a text back to the chat (W5).
  if (reply?.ask?.line) {
    // Placed already: say where it is, never a second draft of the same email (a new ask folder cannot see the first).
    // A line from the user writes it again on purpose; a clipboard one is placed again below.
    if (reply.to && !line && !cloud && state?.phase === 'in-mail-app' && state.kind !== 'clipboard') return asked(state);
    if (!reply.to || line || cloud || time || state?.phase !== 'in-mail-app') return report(await askMove({ core, task, project, taskDirectory, home, reply, ask: options.ask, fill: options.fill, line, cloud, time, heldAskId }));
  }
  if (line) {
    await mkdir(taskDirectory, { recursive: true });
    await saveLine(taskDirectory, line);
    return freshRun({ core, task, project, home, options, startImpl, waitMs, onDone });
  }
  // A reply whose email was not found, or that only reached the clipboard, keeps its draft: Do it places it again, no
  // new run, no new cost, while the draft is fresh. A day-old draft, or one older than the thread or the user's notes,
  // is written again (about $0.002): on 2026-10-10 a kept 10-08 draft asked a recruiter for an interview Gio already had.
  if (['reply-not-found', 'clipboard'].includes(state?.kind) && await keptDraftFresh(taskDirectory)) {
    const done = openDraftImpl({ taskDirectory, again: true })
      .catch((error) => ({ opened: 'none', mode: 'failed', reason: error.message }))
      .then((result) => writeState(taskDirectory, { ...(result.mode === 'failed' ? { phase: 'failed', question: `The draft could not be opened: ${result.reason}. Try again?` } : openedOutcome(result)), agent: state.agent, at: new Date().toISOString(), pid: null, session: state.session || null }));
    const next = await settle({ done }, waitMs, onDone && ((final) => onDone({ taskId: task.id, ...report(final) })));
    return next ? asked(next) : queued();
  }
  // A question only the user can answer stays asked: Do it shows it again, the answer buttons carry on.
  if (state?.phase === 'needs-you' && ['question', 'your-step', 'promise', 'reply-stale', 'permission'].includes(state.kind)) return asked(state);
  // Drafted and open, or held for Open my replies: say where it is, unless the draft has gone stale since (the user's
  // notes or the thread are newer, or it is a day old), when Do it writes it again.
  if (['in-mail-app', 'event-open', 'ready'].includes(state?.phase) && task.status !== 'waiting' && task.status !== 'briefed'
    && (state.phase === 'event-open' || await keptDraftFresh(taskDirectory))) return asked(state);
  if (reply?.ask?.line) return report(await askMove({ core, task, project, taskDirectory, home, reply, ask: options.ask }));
  return freshRun({ core, task, project, home, options, startImpl, waitMs, onDone });
}

// Reply from a To do move (FA build loggie-availability; Gio on a prepare move over a recruiter's scheduling email,
// 2026-10-21: "how come it doesnt allow me to reply though?"). The email the move came from is answered through the
// ask box's email reply (options.ask: that thread, the availability fill, the time guard, the mail app, unsent), with
// the sender's address bound as the choice key so it never resolves to someone else by name. The move itself is not
// touched: it stays To do, and sending the reply does not close it (the draft lives in its own asks/ folder).
const endLine = (text) => (/[.!?"]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);
export async function replyToMove({ core, taskId, ask = null, line = null, cloud = null }) {
  const task = await core.getTask(taskId);
  const project = await core.getProject(task.projectId);
  const taskDirectory = join(project.directoryPath, task.id);
  const reply = JSON.parse(await readFile(join(taskDirectory, 'REPLY.json'), 'utf8').catch(() => 'null'));
  const from = emailFromOf(reply, await readFile(join(taskDirectory, 'THREAD.md'), 'utf8').catch(() => ''));
  const failed = (text) => ({ started: false, phase: 'failed', kind: null, text });
  if (!from) return failed('This move has no email to reply to.');
  if (from.machine) return failed(`${from.address} is an automated address; nobody reads replies there.`);
  const who = from.name || from.address;
  const said = String(line || '').trim();
  if (!said) return { started: false, phase: 'needs-you', kind: 'reply-line', text: `Type what to say to ${who} in the line box, then press Enter.` };
  if (!ask) return failed('Email replies are not set up in this copy of Loggie.');
  // The email the move answers, when its row is known (draft.js replyTarget: the Envelope Index row), is the thread;
  // else the ask box's own pick, the newest thread with them.
  const choices = { [from.address]: `outlook:${from.address}`, ...(Number.isInteger(reply.original?.rowId) ? { '@thread': `apple-mail-${reply.original.rowId}` } : {}) };
  const done = await ask(`email ${from.address}: ${said}`, { choices, cloud, origin: 'row' }).catch((error) => ({ outcome: 'failed', lines: [error.message] }));
  if (done?.status === 'needs-yes') return { started: false, phase: 'needs-you', kind: 'cloud-yes', text: `Loggie's cloud AI reads ${who}'s one email and your note to write this. Nothing else leaves this Mac.` };
  return replyOutcome(done);
}

// What a Reply's run (or the fill of its held draft) says on the row: open in the mail app, held for a time
// (kind 'reply-time', with the askId fill() needs; loggie-reply-yes: nothing with a gap is pasted), or why not.
export function replyOutcome(done) {
  const lines = (done?.lines || []).filter((item) => String(item).trim()).map(endLine);
  if (done?.status === 'needs-time') return { started: false, phase: 'needs-you', kind: 'reply-time', askId: done.askId, text: String(done.lines?.[0] || 'Which time works?') };
  const answering = (done?.did || []).find((item) => typeof item === 'string' && item.startsWith('Answering '));
  const result = done?.results?.[0];
  // On the clipboard: the draft did not open; `why` is the helper's reason without the name in front ("Outlook is showing
  // the Calendar... Open Mail in Outlook, then try again."), and askId lets the row open the same draft again.
  if (result && result.outcome === 'clipboard') {
    const why = String(result.detail || '').replace(/^The Outlook helper failed\.\s*/, '').trim();
    return { started: true, phase: 'in-mail-app', kind: 'clipboard', askId: done.askId, why, text: [answering ? endLine(answering) : null, ...lines].filter(Boolean).join(' ') };
  }
  // Placed: plus what the helper read back to fix before Send (`check`), and whether the user's note went as typed
  // because the cloud AI's draft left its point out (`typed`): the row says both, never just "ready".
  if (result && result.outcome === 'placed') {
    return { started: true, phase: 'in-mail-app', kind: null, text: [answering ? endLine(answering) : null, ...lines].filter(Boolean).join(' '),
      ...(result.check ? { check: result.check } : {}), ...(/^words-after-ai/.test(result.drafted || '') ? { typed: true } : {}) };
  }
  return { started: false, phase: 'failed', kind: null, text: lines.join(' ') || result?.detail || 'The reply could not be written.' };
}

// The answer to a stopped move. "approve" on a refused gate approves the workstream for the cloud AI and runs; every
// other answer goes to answerTask as before (NOTES.md, then a run or the kept draft).
export async function answerMove({ core, taskId, answer, home, options = {}, startImpl = startHeadless, answerImpl = answerTask, waitMs = WAIT_MS, onDone = null }) {
  const task = await core.getTask(taskId);
  const project = await core.getProject(task.projectId);
  const state = await currentState(join(project.directoryPath, task.id));
  // An email move from a chat that stopped on a question (W5): the answer is what to ask, run through the ask box.
  if (state?.kind === 'ask-move') {
    const said = String(answer || '').trim();
    const yes = state.needsYes && /^(yes|always)\b/i.exec(said);
    if (state.needsTime && state.askId && said) return doIt({ core, taskId, home, options, startImpl, waitMs, onDone, time: said, heldAskId: state.askId });
    return doIt({ core, taskId, home, options, startImpl, waitMs, onDone, ...(yes ? { cloud: yes[1].toLowerCase() === 'always' ? 'always' : 'once' } : { line: said || null }) });
  }
  if (state?.kind === 'cloud-off' && /^\s*approve\b/i.test(String(answer))) {
    const list = (await readJson(join(home, 'workstreams.json'))) || [];
    const folder = basename(project.directoryPath);
    const name = folder === slug(CHATS_NAME) ? CHATS_NAME : list.find((item) => item && slug(item.name || '') === folder)?.name;
    if (!name) return { started: false, phase: 'failed', text: `No workspace owns the folder "${folder}", so nothing was approved.` };
    await setCloud(home, name.trim(), CLOUD_PROVIDER);
    return freshRun({ core, task, project, home, options, startImpl, waitMs, onDone });
  }
  if (state?.kind === 'cloud-off') return freshRun({ core, task, project, home, options, startImpl, waitMs, onDone });
  const run = await answerImpl({ core, task, directoryPath: project.directoryPath, answer, ...options, home });
  const next = await settle(run, waitMs, onDone && ((final) => onDone({ taskId: task.id, ...report(final, run.started) })));
  return next ? report(next, run.started) : queued();
}
