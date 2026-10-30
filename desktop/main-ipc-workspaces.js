// The Workspaces and Today doors: the cards, cloud yeses, refresh, stakes, goals, ranking and screen acts.
// Moved out of main.js in debt-cleanup 6.6.
import { cardFields } from './card-fields.js';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCloudApproval, validateWorkspaceName, validateWorkspaceNew } from './ipc-validation.js';
import { caughtUpFor, confirmGoal, inRankOrder, readPriorities } from '../src/hikyaku/priorities.js';
import { readChanges } from '../src/hikyaku/changes.js';
import { unseenFor } from '../src/hikyaku/refresh.js';
import { foundCardFields, needsReadYes } from '../src/hikyaku/found.js';
import { usageToday } from '../src/hikyaku/usage.js';
import { answerAsk, asksFor, estimateUsd, newsFor, readAnswered, readUsageRows, windowEnd } from '../src/hikyaku/screen-data.js';
import { callStepsFor, latestFor, movesFor, readThreads, waitingOnFor } from '../src/hikyaku/screen-depth.js';
import { newestSummary } from '../src/hikyaku/gather.js';
import { voiceFor } from '../src/hikyaku/delta.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { currentState } from '../src/hikyaku/headless.js';
import { moveOpenMoves, notRetired, readRetired, retireByUser } from '../src/hikyaku/retire.js';
import { callSummaryFor, moveDetail, readChatServices, readDueDates } from '../src/hikyaku/move-card.js';
import { cardList, deleteWorkstream, dismissedNames, dismissWorkstream, goalsFor, QUIET_GOAL, readWorkstreams, retiredWorkstreams, retireWorkstream, saveGoal, saveWorkstreamFields, unretireWorkstream } from '../src/hikyaku/workstreams.js';
import { taskLinks } from '../src/hikyaku/links.js';
import { taskAttachments } from '../src/hikyaku/attachments.js';
import { CHATS_WORKSTREAM } from '../src/hikyaku/chats.js';
import { coreClient, hikyakuDirectory, handleSecure, logUiAct, UI_ACTS, UI_TIERS, screenName } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { filedMoves, ownAddresses } from './main-helpers.js';
import { chatApps, catchUpOn, rankAll, rankSoon, actedOn, readChatsNamed, sayChanged } from './main-catch-up.js';
import { refreshOnce } from './main-background.js';

export function registerWorkspacesIpc() {
  handleSecure('hikyaku:workstreams', async () => {
    const allProjects = await coreClient.listProjects();
    const projects = new Map(allProjects.map((project) => [project.name.toLowerCase(), project.id]));
    // A retired move (retire.js) leaves every list; the card shows it with Undo instead.
    const retired = await readRetired(hikyakuDirectory());
    const tasks = (await coreClient.listTasks()).filter((task) => task.status !== 'done').filter(notRetired(retired));
    // The screen's fields (screen-data.js) read each file once; one that cannot be read shows as empty and is logged.
    const screenFail = (fallback) => (error) => { console.error(`hikyaku screen data: ${error.message}`); return fallback; };
    const saved = JSON.parse(await readFile(join(hikyakuDirectory(), 'catchup-state.json'), 'utf8').catch((error) => (error.code === 'ENOENT' ? '{}' : screenFail('{}')(error))));
    const changes = await readChanges(hikyakuDirectory()).catch(screenFail([]));
    const usageRows = await readUsageRows(hikyakuDirectory()).catch(screenFail([]));
    const answered = await readAnswered(hikyakuDirectory()).catch(screenFail(new Set()));
    // The user's sends, for "How you write here": the same number the draft is told (delta.js lengthFor).
    const sends = (await readFile(join(hikyakuDirectory(), 'deltas.jsonl'), 'utf8').catch(() => '')).split('\n').filter((line) => line.trim())
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    // The user's own addresses, for "who is waiting" and "what they said" (screen-depth.js); read once, never fetched.
    const own = await ownAddresses().catch(() => []);
    const dueDates = await readDueDates(hikyakuDirectory());
    const services = await readChatServices();
    const settingsNow = await readSettings(hikyakuDirectory());
    const mailApp = settingsNow.mailApp || 'outlook';
    const { snoozedUntil } = await import('../src/hikyaku/pick.js');
    const { apps } = await chatApps();
    const nextMoves = await import('../src/hikyaku/next-move.js');
    const { cardTop } = await import('../src/hikyaku/pick.js');
    // The Chats card exists when a chat app is switched on; it is not in workstreams.json. Projects with open moves
    // and no workstreams.json line get a card too (cardList).
    const list = cardList({ workstreams: await readWorkstreams(hikyakuDirectory()), projects: allProjects, tasks, extra: apps.length ? [{ ...CHATS_WORKSTREAM }] : [], hidden: await dismissedNames(hikyakuDirectory()) });
    const priorities = await readPriorities(hikyakuDirectory());
    const ranks = new Map((priorities?.ranked || []).map((item) => [item.name.toLowerCase(), item]));
    // The recordings filed under each workspace (loggie-workspaces-integration F3): read once for every card.
    const { listCalls } = await import('../src/hikyaku/call-list.js');
    const allCalls = await listCalls({ home: hikyakuDirectory() }).catch(screenFail([]));
    return Promise.all(inRankOrder(list, priorities).map(async (workstream) => {
      const state = saved[workstream.name] || null;
      const ranked = ranks.get(workstream.name.toLowerCase()) || null;
      const goals = goalsFor(workstream.kind);
      const goal = workstream.goal || goals[0];
      const mine = tasks.filter((task) => task.projectId === projects.get(workstream.name.toLowerCase()));
      // Moves hikyaku is working on or waiting on the user for: the state lives in each task folder (docs/hikyaku-states.md).
      const directory = (await coreClient.getProject(projects.get(workstream.name.toLowerCase())).catch(() => null))?.directoryPath;
      // A snoozed move stays hidden until its time (pick.js cardTop); the next one shows instead.
      const { top, snoozed } = await cardTop({ tasks: mine.filter((task) => task.status !== 'running' && task.status !== 'blocked'), directory });
      // A move made by code (a demoted goal, a call step) has no brief yet; that is not an error for the list.
      const brief = top ? await coreClient.getLatestBrief(top.id).catch(() => null) : null;
      const active = directory ? (await Promise.all(mine.filter((task) => task.status === 'running' || task.status === 'blocked').map(async (task) => {
        const state = await currentState(join(directory, task.id));
        return state ? { id: task.id, title: task.title, phase: state.phase, question: state.question || null, detail: state.detail || null, at: state.at } : null;
      }))).filter(Boolean) : [];
      const quote = (brief?.context || '').split('\n').find((line) => line.startsWith('"')) || null;
      const card = {
        name: workstream.name, kind: workstream.kind, goal, goals, goalChosen: Boolean(workstream.goal),
        // The goal in the user's terms (priorities.js): goalText is confirmed, or an older draft to accept or rewrite.
        goalText: workstream.goalText || null, goalConfirmed: Boolean(workstream.goalText && workstream.goalConfirmed), goalQuote: workstream.goalQuote || null,
        // label, inbox, chats, folder, stake and priority come from one place (card-fields.js).
        ...cardFields(workstream, ranked, priorities),
        cloud: (workstream.chats ? (await readSettings(hikyakuDirectory())).chatsCloud : workstream.cloud) === 'nebius' ? 'nebius' : 'off',
        retired: Object.entries(retired).filter(([, item]) => item.workstream === workstream.name).map(([id, item]) => ({ id, ...item })),
        // Set when hikyaku made this card by itself (discover.js): the quote and the email it came from.
        found: workstream.found || null,
        // A found card never kept and never read carries the Workspaces band (first-run-polish B4.5, B4.8).
        ...foundCardFields(workstream, saved),
        // A kept found card nothing may read yet: its page asks the read yes (found.js needsReadYes).
        readYes: needsReadYes(workstream, settingsNow),
        quiet: goal === QUIET_GOAL,
        // Caught up: read for this goal, and nothing the change log routed here is still unread (refresh.js).
        caughtUp: caughtUpFor(state, workstream, goal),
        // current: also nothing the change log routed here is still unread (refresh.js). The panel keeps reading
        // caughtUp until the new screen shows freshness itself, so an unread item never shows as "Reading…".
        current: Boolean(state && !unseenFor(changes, saved, workstream.name).length),
        threads: state?.found ?? null, sent: state?.sent ?? null, summary: state?.summary || null,
        asOf: state?.asOf || state?.at || null, milestones: state?.milestones || [], unread: unseenFor(changes, saved, workstream.name).length,
        // move: the next move written after Send (next-move.js, MOVE.json), without its provider or model; or { kind: 'none', text } when NOMOVE.json is newer.
        top: top ? { id: top.id, title: top.title, status: top.status, quote, notSure: (brief?.assumptions || []).filter((line) => line.startsWith('Not sure')), links: directory ? await taskLinks(join(directory, top.id)) : [], attachments: directory ? await taskAttachments(join(directory, top.id)) : [],
          move: directory ? await nextMoves.readCardMove(join(directory, top.id)) : null } : null,
        more: Math.max(0, mine.filter((task) => task.status !== 'running' && task.status !== 'blocked').length - 1 - snoozed), snoozed,
        inProgress: mine.filter((task) => task.status === 'running').length,
        active,
        voice: voiceFor(sends, directory ? (await readdir(directory).catch(() => [])).filter((name) => name.startsWith('task_')) : []),
        // Its recordings, newest first, each with how many of its next steps are open moves on this card (F3).
        recordings: allCalls.filter((call) => String(call.workstream || '').toLowerCase() === workstream.name.toLowerCase()).map((call) => ({
          id: call.id, title: call.title, start: call.start, minutes: call.minutes, state: call.state, workstream: call.workstream,
          steps: mine.filter((task) => task.status !== 'done' && String(task.sourceId || '').startsWith(`call:${call.id}#`) && !retired[task.id]).length })),
      };
      // For the Workstreams screen: what is new, a re-read's likely price (the card's own cloud), the window's last
      // date, and the router's open questions about this workstream.
      // The depth a wide screen shows (screen-depth.js): open moves, who is waiting, what was said, the call's steps.
      const snoozedIds = new Set();
      if (directory) for (const task of mine) if (await snoozedUntil(join(directory, task.id)).catch(() => null)) snoozedIds.add(task.id);
      // Each move with its app, its last two messages, the call it came from and the user's own date (move-card.js).
      const moves = await Promise.all(movesFor(mine, snoozedIds).map(async (move) => ({
        ...move, due: dueDates[move.id] || move.due, dueSet: Boolean(dueDates[move.id]),
        ...(directory ? await moveDetail(join(directory, move.id), { own, mailApp, title: move.title, services,
          callSummary: await callSummaryFor(hikyakuDirectory(), mine.find((task) => task.id === move.id)?.sourceId, newestSummary) }) : { app: mailApp, to: null, said: [], call: null }),
      })));
      const threadText = new Map();
      if (directory) for (const move of moves.filter((m) => m.waiting)) threadText.set(move.id, await readFile(join(directory, move.id, 'THREAD.md'), 'utf8').catch(() => ''));
      const routed = changes.filter((item) => item.workstream === workstream.name);
      const depth = {
        moves,
        waitingOn: waitingOnFor(moves, (id) => threadText.get(id) || '', own),
        latest: latestFor({ items: routed, threads: await readThreads(directory), own }),
        callSteps: await callStepsFor({ home: hikyakuDirectory(), items: routed }).catch(screenFail(null)),
      };
      return { ...card, news: newsFor(changes, saved, workstream.name), estimateUsd: estimateUsd(usageRows, card), windowEnd: windowEnd(card), asks: asksFor(changes, answered, workstream.name), ...depth };
    }));
  });
  // Per-workstream cloud approval (cloud.js): which agent may read it, off by default. The toggle's look is the screen's.
  handleSecure('hikyaku:cloud', async () => (await import('../src/hikyaku/cloud.js')).listCloud(hikyakuDirectory()));
  handleSecure('hikyaku:set-cloud', async (name, value) => {
    validateCloudApproval(name, value);
    return (await import('../src/hikyaku/cloud.js')).setCloud(hikyakuDirectory(), name, value);
  });
  handleSecure('hikyaku:confirm-goal', async (name, text) => {
    if (typeof name !== 'string' || name.length > 200 || typeof text !== 'string' || text.length > 300) throw new Error('Goal is invalid.');
    const saved = await confirmGoal(hikyakuDirectory(), name, text);
    actedOn({ name });
    rankSoon();
    return saved;
  });
  handleSecure('hikyaku:rank', () => rankAll());
  // The cloud AI's spend today (usage.js): tokens and dollars across call notes, ranking, finding workstreams and next moves.
  // The First today card (proposal-one-thing.md, TC2 "Top of Tasks"): the morning's picks still open, and Not this.
  handleSecure('hikyaku:first-today', async () => {
    const { firstToday } = await import('../src/hikyaku/priorities.js');
    const retired = await readRetired(hikyakuDirectory());
    const open = new Set((await coreClient.listTasks()).filter((task) => task.status !== 'done' && !retired[task.id]).map((task) => task.id));
    return firstToday(hikyakuDirectory(), { openIds: open });
  });
  handleSecure('hikyaku:usage', async () => { const { usageToday, usageLine } = await import('../src/hikyaku/usage.js'); const total = await usageToday(hikyakuDirectory()); return { ...total, line: usageLine(total) }; });
  handleSecure('hikyaku:set-goal', async (name, goal) => {
    if (typeof name !== 'string' || typeof goal !== 'string') throw new Error('Goal is invalid.');
    return saveGoal(hikyakuDirectory(), name, goal);
  });
  handleSecure('hikyaku:refresh', () => refreshOnce({ auto: false }));
  // The user's taps on a card: "matters more", "matters less" or back to normal (null), and park until a day.
  handleSecure('hikyaku:set-stake', async (name, stake) => {
    if (typeof name !== 'string' || !name.length || name.length > 200 || !['more', 'less', null].includes(stake)) throw new Error('That stake is not valid.');
    const saved = await saveWorkstreamFields(hikyakuDirectory(), name, { stake });
    rankSoon();
    return saved;
  });
  handleSecure('hikyaku:park', async (name, until) => {
    if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
    const today = new Date().toLocaleDateString('en-CA');
    if (until !== null && !(typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until) && !Number.isNaN(Date.parse(until)) && until > today)) throw new Error('Pick a day after today.');
    const saved = await saveWorkstreamFields(hikyakuDirectory(), name, { parkedUntil: until });
    rankSoon();
    return saved;
  });
  // Edit and Dismiss on a card (Gio, 2026-10-17: found workspaces are edited or dismissed, never added by hand).
  handleSecure('hikyaku:rename-workstream', async (name, label) => {
    if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
    if (label !== null && (typeof label !== 'string' || !label.trim() || label.trim().length > 60)) throw new Error('A name is 1 to 60 characters.');
    const saved = await saveWorkstreamFields(hikyakuDirectory(), name, { label: label === null || label.trim() === name ? null : label });
    logUiAct({ act: 'rename-workstream', name });
    return saved;
  });
  // Retire a workspace (loggie-workspaces-integration, F1). Its open moves are settled first, his way, asked once:
  // 'done' marks them done, 'drop' drops them (each Undo-able as any dropped move), 'move' re-creates each on a live
  // workspace and marks the old one moved. With open moves and no choice, nothing changes and the answer says how many.
  const openMovesOf = async (name) => {
    const project = (await coreClient.listProjects()).find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!project) return [];
    const retired = await readRetired(hikyakuDirectory());
    return (await coreClient.listTasks()).filter((task) => task.projectId === project.id && task.status !== 'done' && !retired[task.id]);
  };
  // The open moves of a workspace that is ending (Retire or Delete), settled his way: null when there are none or they
  // are settled, else { needsChoice, open } and nothing changed.
  const settleMoves = async (name, choice, target) => {
    if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
    if (choice !== null && !['done', 'drop', 'move'].includes(choice)) throw new Error('Pick Mark all done, Move them, or Drop them.');
    const home = hikyakuDirectory();
    const moves = await openMovesOf(name);
    if (moves.length && !choice) return { needsChoice: true, open: moves.length };
    if (choice === 'move') {
      const to = (await readWorkstreams(home)).find((item) => item.name === target && item.name !== name && !item.inbox);
      if (!to) throw new Error('Pick a workspace to move them to.');
      await moveOpenMoves({ core: coreClient, home, from: name, to: to.name, moves });
    } else if (choice) {
      for (const task of moves) await retireByUser(home, { taskId: task.id, title: task.title, workstream: name, why: choice === 'done' ? 'done' : 'dropped' });
    }
    return { moves };
  };
  handleSecure('hikyaku:retire-workstream', async (name, choice = null, target = null) => {
    const settled = await settleMoves(name, choice, target);
    if (settled.needsChoice) return settled;
    const { moves } = settled;
    const home = hikyakuDirectory();
    const result = await retireWorkstream(home, name);
    logUiAct({ act: 'retire-workstream', name, openMoves: moves.length, choice: choice || 'none' });
    rankSoon();
    return { ...result, settled: moves.length, choice };
  });
  // Delete (loggie-delete-workspace): its open moves settled as for Retire, its recordings moved to "No workspace" (notes
  // and audio stay on the Mac), then it is marked deleted and leaves every list for good.
  handleSecure('hikyaku:delete-workstream', async (name, choice = null, target = null) => {
    const settled = await settleMoves(name, choice, target);
    if (settled.needsChoice) return settled;
    const home = hikyakuDirectory();
    const { listCalls } = await import('../src/hikyaku/call-list.js');
    const { refileCall } = await import('../src/hikyaku/refile.js');
    const calls = (await listCalls({ home }).catch(() => [])).filter((call) => String(call.workstream || '').toLowerCase() === name.toLowerCase());
    const workstreams = await readWorkstreams(home);
    for (const call of calls) await refileCall({ home, core: coreClient, id: call.id, workstream: null, workstreams });
    const result = await deleteWorkstream(home, name);
    logUiAct({ act: 'delete-workstream', name, openMoves: settled.moves.length, choice: choice || 'none', recordings: calls.length });
    rankSoon();
    return { ...result, settled: settled.moves.length, choice, unfiled: calls.length };
  });
  handleSecure('hikyaku:unretire-workstream', async (name) => {
    if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
    const result = await unretireWorkstream(hikyakuDirectory(), name);
    logUiAct({ act: 'unretire-workstream', name });
    rankSoon();
    return result;
  });
  // The "Retired · n" fold: each retired workspace with the recordings filed under it (their history stays).
  handleSecure('hikyaku:retired-workstreams', async () => {
    const { listCalls } = await import('../src/hikyaku/call-list.js');
    const calls = await listCalls({ home: hikyakuDirectory() }).catch(() => []);
    return (await retiredWorkstreams(hikyakuDirectory())).map((item) => ({ ...item,
      recordings: calls.filter((call) => String(call.workstream || '').toLowerCase() === item.name.toLowerCase()).map((call) => ({ id: call.id, title: call.title, start: call.start, minutes: call.minutes })) }));
  });
  handleSecure('hikyaku:dismiss-workstream', async (name) => {
    if (typeof name !== 'string' || !name.length || name.length > 200) throw new Error('Workspace name is invalid.');
    const result = await dismissWorkstream(hikyakuDirectory(), name);
    logUiAct({ act: 'dismiss-workstream', name });
    rankSoon();
    return result;
  });
  // The Workstreams screen (screen-data.js): refresh one card, the costs toggle, what the user did on the screen, and
  // the answer to an ask.
  handleSecure('hikyaku:refresh-one', (name) => catchUpOn(screenName(name), { refresh: true }));
  handleSecure('hikyaku:ui-act', async (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !UI_ACTS.includes(payload.act)) throw new Error('Unknown screen action.');
    const { act, name } = payload;
    if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 200)) throw new Error('Workspace name is invalid.');
    // The width tier the act happened in, when a screen sends one.
    const tier = UI_TIERS.includes(payload.tier) ? payload.tier : null;
    // The ask box's read of a sentence on send (loggie-ask-wordmap): counts only, never the words or the names. The
    // falsifier reads how often a sent sentence still had words nobody asked for, and how many fix-it presses it took.
    const read = act === 'box-read' ? {
      action: ['invite', 'message', 'reply', 'said', 'move', 'open', 'unknown'].includes(payload.action) ? payload.action : 'unknown',
      unused: Number.isInteger(payload.unused) && payload.unused >= 0 ? Math.min(payload.unused, 50) : 0,
      fixed: Number.isInteger(payload.fixed) && payload.fixed >= 0 ? Math.min(payload.fixed, 50) : 0,
      recalled: payload.recalled === true,
    } : {};
    await appendFile(join(hikyakuDirectory(), 'ui-acts.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), act, name: name || null, tier, ...read })}\n`);
    return { ok: true };
  });
  // File here (F4): a routed thread moves to another workspace, and that workspace reads it now (its card shows it
  // within the minute, not tomorrow).
  handleSecure('hikyaku:move-thread', async (itemId, workstream) => {
    if (typeof itemId !== 'string' || !itemId || itemId.length > 400) throw new Error('That message is no longer in the list.');
    screenName(workstream);
    const { moveThread } = await import('../src/hikyaku/screen-data.js');
    const result = await moveThread({ home: hikyakuDirectory(), itemId, workstream });
    logUiAct({ act: 'file-here', moved: result.moved, from: result.from, to: result.to });
    if (result.moved) {
      catchUpOn(result.to, { refresh: true }).then(() => panelWindow?.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text: `${result.to} is up to date.` }))
        .catch((error) => console.error(`refresh after File here for ${result.to}: ${error.message}`));
      rankSoon();
    }
    return { ...result, reading: result.moved > 0 };
  });
  handleSecure('hikyaku:answer-ask', async (id, workstream) => {
    const closed = () => new Error('That question is no longer open.');
    if (typeof id !== 'string' || !id.length || id.length > 400) throw closed();
    if (workstream !== null) screenName(workstream);
    const home = hikyakuDirectory();
    const item = (await readChanges(home)).filter((entry) => entry.id === id).at(-1);
    if (!item || item.workstream !== null || (await readAnswered(home)).has(id)) throw closed();
    const result = await answerAsk({ home, item, workstream });
    // A yes files the conversation there now; that workstream is re-read in the background, so its new move (the
    // follow-up the person asked for) reaches the card without waiting for tomorrow's timer read.
    if (workstream) catchUpOn(workstream, { refresh: true }).then(() => panelWindow?.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text: `${workstream} is up to date.` }))
      .catch((error) => console.error(`refresh after a yes for ${workstream}: ${error.message}`));
    rankSoon();
    return result;
  });
  handleSecure('hikyaku:catch-up', (name) => {
    if (typeof name !== 'string' || name.length > 200) throw new Error('Workspace name is invalid.');
    actedOn({ name });
    return catchUpOn(name);
  });
  // New workspace on the Workspaces tab (loggie-new-workspace): the look, then Save. The look reads this Mac's mail,
  // chats (only the apps switched on) and calls by code, sends nothing, and is kept here so Save files only the people
  // it found: the renderer sends back their keys, never an address of its own.
  let lastLook = null;
  handleSecure('hikyaku:workspace-look', async (name) => {
    const input = validateWorkspaceName(name);
    const home = hikyakuDirectory();
    const settings = await readSettings(home);
    const { lookFor } = await import('../src/hikyaku/new-workspace.js');
    const { readInboxMail, readSentMail } = await import('../src/hikyaku/sent-mail.js');
    const { listCalls, searchCalls } = await import('../src/hikyaku/call-list.js');
    const { apps } = await chatApps().catch(() => ({ apps: [] }));
    const seed = await lookFor(input.name, { ownNames: [settings.signName].filter(Boolean), own: await ownAddresses().catch(() => []), readInbox: readInboxMail, readSent: readSentMail,
      readChats: apps.length ? (options) => readChatsNamed({ apps, ...options }) : null, listCalls: () => listCalls({ home }), searchSaid: (word) => searchCalls({ home, query: word, perCall: 0 }) });
    lastLook = { name: input.name, seed };
    logUiAct({ act: 'workspace-look', mail: seed.mail, chats: seed.chats, calls: seed.calls, people: seed.people.length });
    return { name: input.name, words: seed.words, mail: seed.mail, chats: seed.chats, calls: seed.calls, chatsOn: apps.length > 0,
      people: seed.people.map((person) => ({ key: person.address || person.handle, name: person.name || '', at: person.address || person.handle, count: person.count })), notes: seed.notes };
  });
  handleSecure('hikyaku:workspace-new', async (name, keys) => {
    const input = validateWorkspaceNew(name, keys);
    if (!lastLook || lastLook.name !== input.name) throw new Error('Look again first: the name changed since Loggie looked. Nothing was changed.');
    const { keptPeople } = await import('../src/hikyaku/new-workspace.js');
    const { addWorkstream } = await import('../src/hikyaku/entry.js');
    const home = hikyakuDirectory();
    const at = new Date().toISOString();
    const settings = await readSettings(home);
    const cloud = settings.cloudYes?.found === true;
    const { seed } = lastLook;
    const entry = await addWorkstream({ home, name: input.name, words: seed.words, people: keptPeople(seed.people, input.keys),
      extra: { madeFrom: { typed: true, at }, confirmed: at, ...(cloud ? { cloud: 'nebius' } : {}) } });
    lastLook = null;
    // The calls the look found that sit in no workspace are filed here; one that fails stays where it was and is counted.
    const { refileCall } = await import('../src/hikyaku/refile.js');
    let filed = 0;
    for (const id of seed.unfiledCalls) {
      try { filedMoves(await refileCall({ home, core: coreClient, id, workstream: entry.name, workstreams: await readWorkstreams(home) })); filed += 1; }
      catch (error) { console.error(`hikyaku: a call was not filed under the new workspace: ${error.message}`); }
    }
    logUiAct({ act: 'workspace-new', people: input.keys.length, calls: filed, cloud });
    sayChanged();
    if (cloud) {
      catchUpOn(entry.name).then(() => panelWindow?.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text: `${entry.name} is up to date.` }))
        .catch((error) => console.error(`hikyaku: the first read of a new workspace failed: ${error.message}`));
    }
    return { name: entry.name, cloud, calls: filed };
  });
}
