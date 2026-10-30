// The doors on a next move: pick, Do it, Draft all, answers and drafts.
// Moved out of main.js in debt-cleanup 6.6.
import { clipboard } from 'electron';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { validateAskId, validatePickChoice, validateThreadId } from './ipc-validation.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { readPriorities } from '../src/hikyaku/priorities.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { openReplies, startHeadless } from '../src/hikyaku/headless.js';
import { answerMove, doIt, replyOutcome, replyToMove } from '../src/hikyaku/do-it.js';
import { slug } from '../src/hikyaku/util.js';
import { retireByUser, unretire } from '../src/hikyaku/retire.js';
import { macCanSend, readChatServices, setDueDate } from '../src/hikyaku/move-card.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { CHATS_WORKSTREAM } from '../src/hikyaku/chats.js';
import { coreClient, hikyakuDirectory, askCloudYes, handleSecure, logUiAct } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { hikyakuOpenDraft } from './main-helpers.js';
import { actedOn, sayChanged } from './main-catch-up.js';
import { asker, loadWhoIndex, replyYes, setReplyYes } from './main-ask.js';
import { entryKey } from '../src/hikyaku/ask-run.js';

export function registerMovesIpc() {
  // A next move's task folder, from its Core task id.
  async function moveTaskDirectory(taskId) {
    const task = await coreClient.getTask(validateThreadId(taskId));
    const project = task?.projectId ? await coreClient.getProject(task.projectId) : null;
    if (!project?.directoryPath) throw new Error('This task has no folder yet.');
    return join(project.directoryPath, task.id);
  }
  // pick (B10): one click on the move, a Signal. "Open draft in" (mock e screen 4): mail.apps, then draft.open through
  // the same open-draft paths as every other draft. Loggie never sends mail.
  // Skipped and handled elsewhere close the task through Core's legal steps; snooze hides it until its time.
  handleSecure('hikyaku:pick', async (taskId, choice) => (actedOn({ taskId }), await import('../src/hikyaku/pick.js')).pickMove({ home: hikyakuDirectory(), taskDirectory: await moveTaskDirectory(taskId),
    choice: validatePickChoice(choice), core: coreClient, clipboardImpl: async (text) => clipboard.writeText(text) }));
  handleSecure('hikyaku:unretire', async (taskId) => { const result = await unretire(hikyakuDirectory(), validateThreadId(taskId)); sayChanged(); return result; });
  // The card's hover icons (loggie-do-it-context): done and drop retire the move with Undo; a new date (or null to clear
  // it) replaces the catch-up's date. Each is logged with the other card acts, and sends the change signal: Done on a call
  // page left the move on Today until Workspaces' Refresh (Codex review, 2026-10-23).
  handleSecure('hikyaku:move-mark', async (taskId, why) => {
    const task = await coreClient.getTask(validateThreadId(taskId));
    const project = await coreClient.getProject(task.projectId).catch(() => null);
    const result = await retireByUser(hikyakuDirectory(), { taskId: task.id, title: task.title, workstream: project?.name || '', why });
    logUiAct({ act: `move-${why}`, taskId: task.id });
    sayChanged();
    return result;
  });
  handleSecure('hikyaku:move-date', async (taskId, date) => {
    const result = await setDueDate(hikyakuDirectory(), validateThreadId(taskId), date);
    logUiAct({ act: 'move-date', taskId, date });
    sayChanged();
    return result;
  });
  handleSecure('hikyaku:not-this', async (taskId) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('Not this needs a task.');
    const { readPriorities, recordNotThis } = await import('../src/hikyaku/priorities.js');
    const pick = (await readPriorities(hikyakuDirectory()))?.picks?.find((item) => item.taskId === taskId);
    if (!pick) throw new Error('That move is not one of today\'s picks.');
    await recordNotThis(hikyakuDirectory(), { taskId, name: pick.name, move: pick.move });
    return { taskId };
  });
  // Approves a fresh move's brief and makes it briefed; the same step for Do it and Draft all.
  async function briefedTask(taskId) {
    let task = await coreClient.getTask(validateThreadId(taskId));
    if (task.status === 'waiting') {
      // Core answers 404 when a task has no approved brief yet; that is the normal case for a fresh move.
      const approved = await coreClient.getApprovedBrief(task.id).catch((error) => { if (error.status === 404) return null; throw error; });
      if (!approved) {
        const draft = await coreClient.getLatestBrief(task.id);
        if (draft?.status !== 'draft') throw new Error('This move has no brief yet.');
        await coreClient.approveBrief(draft.id);
      }
      task = await coreClient.transitionTask(task.id, 'briefed', 'Approved with Do it in Loggie');
    }
    if (task.status !== 'briefed') throw new Error('This move is already in progress.');
    return { task, project: await coreClient.getProject(task.projectId) };
  }
  // A move drafted on Nebius (do-it.js) goes through the same screen as the workstream's mail catch-up, under the same
  // yes: the workstream approved for nebius. Null without it; the cloud gate has refused by then anyway.
  async function draftCompleteFor(settings, directoryPath) {
    const folder = basename(directoryPath);
    // The Chats card is not in workstreams.json; its yes is settings.chatsCloud. Without this every Chats move was
    // refused with "this workstream has no yes for the cloud AI" although chats were approved (2026-10-11).
    if (folder === slug(CHATS_WORKSTREAM.name)) return thinkWith({ settings, maxTokens: 3000, consent: consentFor('chats', { settings }), what: 'your chats', path: 'do-it', onNeedYes: askCloudYes });
    const found = (await readWorkstreams(hikyakuDirectory())).find((item) => item && typeof item.name === 'string' && slug(item.name) === folder) || null;
    return thinkWith({ settings, maxTokens: 3000, consent: consentFor('mail', { workstream: found }), what: `the "${found?.name || folder}" mail`, path: 'do-it', onNeedYes: askCloudYes });
  }
  // How a draft run is set up: the cloud AI drafts, under the workspace's own yes. No window opens.
  async function runOptions() {
    const settings = await readSettings(hikyakuDirectory());
    const voiceDirectory = join(hikyakuDirectory(), 'voice');
    // A cloud run sees the calendar through the gate (free times, untitled busy blocks): cloud.js cloudCalendarText.
    return { voiceDirectory, home: hikyakuDirectory(), calendarText: async ({ allowed } = {}) => (await import('../src/hikyaku/cloud.js')).cloudCalendarText(settings, { allowed }),
      openDraftImpl: hikyakuOpenDraft, draftComplete: (directoryPath) => draftCompleteFor(settings, directoryPath),
      // An email move from a chat runs its one line through the ask box (do-it.js askMove, workspaces-outlook W5). An
      // intro move's choice key is its bound address: the ask box gets it only when the who index holds that address
      // (reloaded once, the index can be 10 minutes old), else the card asks for a refresh. Never a guess by name.
      ask: async (text, { cloud = null, choices = {}, origin = null } = {}) => {
        // '@thread' is the email to answer (a To do move's Reply, do-it.js replyToMove), not a person: nothing to look up.
        for (const [who, key] of Object.entries(choices).filter(([name]) => !name.startsWith('@'))) {
          const holds = (entries) => entries.some((entry) => entryKey(entry) === key);
          if (!holds(await loadWhoIndex()) && !holds(await loadWhoIndex({ maxAgeMs: 0 }))) return { outcome: 'failed', lines: [`${who}'s address is not in Loggie yet. Refresh the workspace`] };
        }
        return asker.run(text, { cloud, choices, origin }).done;
      },
      // A held draft's time (ask-run.js fill): the answer to an email move that stopped on "Which time works?".
      fill: (askId, time) => asker.fill(askId, time) };
  }
  // A queued Do it or answer that finished: the card that pressed it updates (panel onMoved), and the outcome is logged.
  const movedOn = (act) => (outcome) => {
    logUiAct({ act: `${act}-done`, taskId: outcome.taskId, phase: outcome.phase, kind: outcome.kind || null });
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:moved', outcome);
  };
  handleSecure('hikyaku:do-it', async (taskId, agent, line = null) => {
    if (line !== null && (typeof line !== 'string' || line.length > 1000)) throw new Error('What to say must be text, under 1,000 characters.');
    actedOn({ taskId });
    // A text this Mac cannot send (SMS or RCS, move-card.js) is not drafted into a box that never sends.
    {
      const { task, project } = await (async () => { const t = await coreClient.getTask(validateThreadId(taskId)); return { task: t, project: await coreClient.getProject(t.projectId) }; })();
      const reply = JSON.parse(await readFile(join(project.directoryPath, task.id, 'REPLY.json'), 'utf8').catch(() => 'null'));
      if (!macCanSend(reply, await readChatServices())) return { started: false, phase: 'phone-only', kind: null, text: 'Text this one from your iPhone: this Mac cannot send SMS or RCS.' };
    }
    // The run is invisible; the press answers with what happened (do-it.js), in words the card shows, within 30 s.
    const result = await doIt({ core: coreClient, taskId: validateThreadId(taskId), home: hikyakuDirectory(), options: await runOptions(), onDone: movedOn('do-it'), line: line?.trim() || null });
    logUiAct({ act: 'do-it', taskId, phase: result.phase, kind: result.kind || null, line: Boolean(line?.trim()) });
    return result;
  });
  // Reply on a To do move (today-model.js canReplyTo): the email it came from, answered through the ask box's email
  // reply, unsent; the move stays To do (do-it.js replyToMove).
  handleSecure('hikyaku:reply-to', async (taskId, line = null, cloud = null) => {
    if (line !== null && (typeof line !== 'string' || line.length > 1000)) throw new Error('What to say must be text, under 1,000 characters.');
    if (cloud !== null && !['once', 'always', 'words'].includes(cloud)) throw new Error('The yes must be once, always or words.');
    actedOn({ taskId });
    const result = await replyToMove({ core: coreClient, taskId: validateThreadId(taskId), ask: (await runOptions()).ask, line: line?.trim() || null, cloud });
    logUiAct({ act: 'reply-to', taskId, phase: result.phase, kind: result.kind || null, line: Boolean(line?.trim()) });
    return result;
  });
  // A Reply held for a time (ask-run.js fill, loggie-reply-yes): the user's time goes in by code, then it opens, unsent.
  handleSecure('hikyaku:reply-fill', async (taskId, askId, time) => {
    if (typeof time !== 'string' || !time.trim() || time.length > 120) throw new Error('The time must be text, under 120 characters.');
    actedOn({ taskId: validateThreadId(taskId) });
    const result = replyOutcome(await asker.fill(validateAskId(askId), time));
    logUiAct({ act: 'reply-fill', taskId, phase: result.phase, kind: result.kind || null });
    return result;
  });
  // A Reply that did not open (Outlook on the Calendar): the same draft, opened again; nothing is written twice.
  handleSecure('hikyaku:reply-again', async (taskId, askId) => {
    actedOn({ taskId: validateThreadId(taskId) });
    const result = replyOutcome(await asker.again(validateAskId(askId)));
    logUiAct({ act: 'reply-again', taskId, phase: result.phase, kind: result.kind || null });
    return result;
  });
  // The reply's yes, read before the row asks (always: no question), and set from the row's offer.
  handleSecure('hikyaku:reply-yes', () => replyYes());
  handleSecure('hikyaku:reply-yes-set', (what) => setReplyYes(what));
  // Draft all: every listed next move is drafted quietly and held (phase "ready") for Open my replies.
  handleSecure('hikyaku:draft-all', async (taskIds) => {
    if (!Array.isArray(taskIds) || taskIds.length > 20) throw new Error('Task list is invalid.');
    const options = await runOptions();
    const started = [];
    for (const taskId of taskIds) {
      try {
        const { task, project } = await briefedTask(taskId);
        // An email move from a chat is written by the ask box when Do it is pressed, never by the chat drafter (W5).
        if (JSON.parse(await readFile(join(project.directoryPath, task.id, 'REPLY.json'), 'utf8').catch(() => 'null'))?.ask) continue;
        const run = await startHeadless({ core: coreClient, task, directoryPath: project.directoryPath, ...options, hold: true });
        run.done.catch((error) => console.error(`hikyaku run for ${task.id} failed to finish: ${error.message}`));
        started.push(task.id);
      } catch (error) { console.error(`hikyaku draft-all skipped ${taskId}: ${error.message}`); }
    }
    return { started };
  });
  handleSecure('hikyaku:open-replies', async () => {
    const projects = new Map((await coreClient.listProjects()).map((project) => [project.id, project.directoryPath]));
    const taskDirectories = (await coreClient.listTasks()).filter((task) => task.status !== 'done' && projects.get(task.projectId))
      .map((task) => join(projects.get(task.projectId), task.id));
    return openReplies({ taskDirectories, open: hikyakuOpenDraft });
  });
  handleSecure('hikyaku:answer', async (taskId, answer) => {
    const result = await answerMove({ core: coreClient, taskId: validateThreadId(taskId), answer, home: hikyakuDirectory(), options: await runOptions(), onDone: movedOn('answer') });
    logUiAct({ act: 'answer', taskId, phase: result.phase, kind: result.kind || null });
    return result;
  });
  handleSecure('hikyaku:open-draft', async (taskId, options) => {
    const task = await coreClient.getTask(validateThreadId(taskId));
    const project = task?.projectId ? await coreClient.getProject(task.projectId) : null;
    if (!project?.directoryPath) throw new Error('This task has no folder yet.');
    return hikyakuOpenDraft({ taskDirectory: join(project.directoryPath, task.id), again: options?.again === true, staleOk: options?.staleOk === true });
  });
}
