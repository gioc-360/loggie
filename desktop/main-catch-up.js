// Reading a workspace: the mail and chat catch-ups, the refresh, the voice files, the sent check and the ranking.
// Moved out of main.js in debt-cleanup 6.6.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listEvents } from '../src/hikyaku/calendar.js';
import { parseJsonReply } from '../src/hikyaku/model.js';
import { consentFor, thinkWith } from '../src/hikyaku/cloud-screen.js';
import { contactNames, nameChats } from '../src/hikyaku/contacts.js';
import { suggestHomes } from '../src/hikyaku/suggest.js';
import { catchUpGoal, rankInput, rankWorkstreams, readPriorities, recordFirstAct } from '../src/hikyaku/priorities.js';
import { demoteTaskGoals } from '../src/hikyaku/goal-shape.js';
import { readChanges } from '../src/hikyaku/changes.js';
import { changedWorkstreams, contextLines, firstReadsOut, nextState, refreshPlan, routedChats, unseenFor } from '../src/hikyaku/refresh.js';
import { foundCatchUp, isNewFound, needCatchUp } from '../src/hikyaku/found.js';
import { usageToday } from '../src/hikyaku/usage.js';
import { eventLines, newestSummary } from '../src/hikyaku/gather.js';
import { transcriberRuntime } from '../src/hikyaku/send-gate.js';
import { baseSubject, cutQuoted, readInboxMail, readMailPeople, readSentMail, recoverSentMail } from '../src/hikyaku/sent-mail.js';
import { createOwedTask, createStepTasks, ownCallSteps, readHabits, readReplaced, recentEvents, recordReplaced } from '../src/hikyaku/gather.js';
import { recordDeltas, taskDirectoriesUnder } from '../src/hikyaku/delta.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { closeSent, currentState } from '../src/hikyaku/headless.js';
import { notRetired, readRetired, retirePastDates, retireStale } from '../src/hikyaku/retire.js';
import { addPeople, belongsTo, cardList, catchUp, catchUpLog, dismissedNames, goalsFor, isKept, readWorkstreams, updateWorkstreams } from '../src/hikyaku/workstreams.js';
import { introsIn, mailNames, movable } from '../src/hikyaku/introduced.js';
import { readDueDates } from '../src/hikyaku/move-card.js';
import { returnParked } from '../src/hikyaku/park.js';
import { collectIntros, introsMarkdown, patternPrompt } from '../src/hikyaku/voice.js';
import { catchUpChats, chatAsThread, chatCounts, checkApps, CHATS_WORKSTREAM, emptyChatsLog, readChats, recordChatDeltas } from '../src/hikyaku/chats.js';
import { textingMarkdown, textingPatternPrompt, textingSample } from '../src/hikyaku/voice.js';
import { codeScreen } from '../src/hikyaku/sensitive.js';
import { coreClient, hikyakuDirectory, withWorkstreams, askCloudYes } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { ownAddresses, OUTLOOK_CATCHUP_DAYS, mailSource } from './main-helpers.js';

// The chat apps the user switched on in settings.json ("chats": ["messages", "whatsapp"]); off by default.
export async function chatApps() {
  const settings = await readSettings(hikyakuDirectory());
  return { settings, apps: checkApps(settings.chats) };
}

// The chat reader with Contacts names filled in (contacts.js): a text from someone not on iMessage arrives as a bare
// number, and the card, the router's ask and the cloud prompt should all say who it is. Unreadable Contacts: no names.
export async function readChatsNamed(options) {
  const [read, names] = await Promise.all([readChats(options), contactNames().catch(() => new Map())]);
  return nameChats(read, names);
}

// Catch up on chats: the same path as a workstream, with the chats' own reader in front (chats.js catchUpChats).
export async function catchUpOnChats() {
  const { settings, apps } = await chatApps();
  const complete = thinkWith({ settings, maxTokens: 1500, consent: consentFor('chats', { settings }), what: 'your chats', path: 'chats', onNeedYes: askCloudYes });
  if (!complete) return { ...emptyChatsLog(), found: 0 };
  const profile = await readFile(join(hikyakuDirectory(), 'profile.md'), 'utf8').catch(() => '');
  const log = await catchUpChats({ apps, settings, self: { names: [settings.signName].filter(Boolean) }, complete, core: coreClient, readChatsImpl: readChatsNamed,
    workRoot: join(hikyakuDirectory(), 'work'), profile: profile.trim() });
  await appendFile(join(hikyakuDirectory(), 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), catchUp: CHATS_WORKSTREAM.name, ...log, summary: Boolean(log.summary) })}\n`);
  const stateFile = join(hikyakuDirectory(), 'catchup-state.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
  saved[CHATS_WORKSTREAM.name] = { found: log.threads, threads: log.threads, sent: log.sent, summary: log.summary, goal: CHATS_WORKSTREAM.goal, window: log.window, waiting: log.waiting, spam: log.spam, groups: log.groups, at: new Date().toISOString() };
  await writeFile(stateFile, JSON.stringify(saved, null, 2));
  return { ...log, found: log.threads };
}

// `refresh`: fold in only what the change log routed here since the last read (refresh.js): threads newer than the
// summary, new calls' next steps, dates ahead, and routed chats when their cloud yes allows, with the old summary as
// the base. Nothing new means no model call. Without it, the full catch-up it always was.
export async function catchUpOn(name, { refresh = false } = {}) {
  if (name === CHATS_WORKSTREAM.name) return catchUpOnChats();
  const found = (await readWorkstreams(hikyakuDirectory())).find((item) => item.name === name);
  if (!found) throw new Error(`"${name}" has no search terms yet, so it cannot be caught up on. Add it to workstreams.json with its domains or words.`);
  // A workspace Loggie found is read only after the person keeps it (first-run-polish D1), whatever asks for the read.
  if (isNewFound(found, JSON.parse(await readFile(join(hikyakuDirectory(), 'catchup-state.json'), 'utf8').catch(() => '{}')))) {
    throw new Error(`Keep "${found.label || name}" first. Loggie reads a workspace it found only after you keep it.`);
  }
  // The catch-up ranks moves toward the goal in the user's terms when there is one (priorities.js), else the label.
  const milestones = JSON.parse(await readFile(join(hikyakuDirectory(), 'catchup-state.json'), 'utf8').catch(() => '{}'))[name]?.milestones || [];
  const workstream = { ...found, goal: catchUpGoal(found, goalsFor(found.kind)[0], milestones) };
  const settings = await readSettings(hikyakuDirectory());
  const complete = thinkWith({ settings, maxTokens: 1500, consent: consentFor('mail', { workstream: found }), what: `the "${name}" mail`, path: 'mail', onNeedYes: askCloudYes });
  if (!complete) return { ...catchUpLog(workstream), found: 0, needsYes: true };
  const source = await mailSource();
  if (source.kind === 'none') throw new Error(source.why);
  // Apple Mail is the one source (2026-10-28, no Gmail sign-in): its Inbox and Sent fill the threads below.
  const query = `outlook:${OUTLOOK_CATCHUP_DAYS}d`;
  const threads = [];
  const home = hikyakuDirectory();
  const profile = await readFile(join(home, 'profile.md'), 'utf8').catch(() => '');
  const stateFile = join(home, 'catchup-state.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
  const now = Date.now();
  const unseen = unseenFor(await readChanges(home), saved, name);
  // Mail in any Apple Mail account joins its thread, or starts one (sent-mail.js). This is the whole read (W4): 120
  // days, and an email the change log already filed here belongs too, so a thread the router placed by person or
  // thread is read even when no domain or word matches.
  const filed = new Set(unseen.filter((item) => item.source === 'outlook').map((item) => item.thread));
  const matches = belongsTo(workstream);
  const belongs = (message) => matches(message) || filed.has(baseSubject(message.subject || ''));
  // The Sent rows the read already makes are kept (loggie-intros 1.4): who the user wrote to decides who can introduce
  // someone, and whether an introduced person was written to since. A Sent read that fails keeps none: no pair.
  const sentRows = [];
  const sentMail = await recoverSentMail(threads, source.own, { belongs, readSent: async (options) => { const rows = await readSentMail(options); sentRows.push(...rows); return rows; },
    days: OUTLOOK_CATCHUP_DAYS });
  // Introductions, by code on this Mac, in a kept workspace only: every pair is saved to its people, and one the user has
  // not written to since becomes a move (catchUp). runs.jsonl gets the counts, never a name or an address.
  // A To or Cc address with no name in the header takes the newest name Apple Mail has for it (I3); none readable: none.
  const names = isKept(found) ? mailNames(await readMailPeople({ address: source.own, days: OUTLOOK_CATCHUP_DAYS }).catch(() => [])) : new Map();
  const intros = isKept(found) ? introsIn(threads, { own: source.own, writtenTo: new Set(sentRows.flatMap((row) => row.to || [])), names }) : [];
  const { added } = intros.length ? await addPeople(home, name, intros.map((intro) => ({ name: intro.name, address: intro.address }))) : { added: 0 };
  const introMoves = movable(intros, sentRows);
  const taskDirectories = await taskDirectoriesUnder(join(home, 'work'));
  const deltas = await recordDeltas({ taskDirectories, threads, ownAddress: source.own, home });
  await closeSent({ core: coreClient, taskDirectories });
  const previous = refresh && saved[name]?.summary ? { summary: saved[name].summary, at: saved[name].asOf || saved[name].at } : null;
  const read = previous ? threads.filter((thread) => (thread.latestTimestamp || '') > previous.at) : threads;
  const callLines = new Map();
  for (const item of unseen.filter((i) => i.source === 'call')) callLines.set(item.thread, eventLines(await newestSummary(join(home, 'calls', item.thread))));
  const context = contextLines({ items: unseen, callLines, now });
  // A routed chat joins the re-read only where its own cloud yes holds: local reads always, the cloud only when chats
  // are approved for it (settings.chatsCloud), the same rule the Chats card follows.
  const chatsAllowed = found.cloud !== 'nebius' || settings.chatsCloud === 'nebius';
  const chatNote = [];
  if (chatsAllowed) {
    const { apps } = await chatApps();
    for (const item of routedChats(unseen)) {
      if (!apps.includes(item.source)) continue;
      const result = await readChatsNamed({ apps: [item.source], days: 14, chat: item.thread }).catch((error) => { chatNote.push(error.message); return {}; });
      const chat = result[item.source]?.chats?.find((c) => c.id === item.thread);
      if (chat) read.push(chatAsThread(chat));
    }
  } else if (routedChats(unseen).length) chatNote.push('routed chats not read: chats are not approved for the cloud');
  let log;
  if (previous && !read.length && !context.length) log = { ...catchUpLog(workstream), summary: previous.summary, unchanged: true };
  // Apple Mail threads carry no attachments (v2), so no fetcher: only the Gmail sign-in ever fetched one.
  else log = await catchUp({ sentMail, workstream, threads: read, complete, core: coreClient, workRoot: join(home, 'work'), ownAddress: source.own, profile: profile.trim(),
    previous, context, intros: introMoves });
  log.intros = { pairs: intros.length, saved: added, movable: [...introMoves.values()].flat().length, moves: log.intros?.moves ?? 0 };
  await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), catchUp: name, refresh, query, found: threads.length, read: read.length, items: unseen.length, context: context.length, chatNote, ...log, summary: Boolean(log.summary), sentMail, deltas: deltas.length })}\n`);
  saved[name] = nextState(saved[name], { items: unseen, now, found: threads.length, threads: log.threads, sent: log.sent, summary: log.summary || previous?.summary || null, goal: workstream.goal, at: new Date(now).toISOString() });
  await writeFile(stateFile, JSON.stringify(saved, null, 2));
  // What the new mail settled leaves the list (retire.js): a summary that changed is checked against the open moves.
  // What this workspace is for, from a quote code found in what it read (F2): kept as a draft he confirms with Yes,
  // never over his own goal or a draft already waiting.
  if (log.goalFor) {
    await updateWorkstreams(home, (list) => {
      const item = (list || []).find((entry) => entry.name === name);
      if (!item || item.goalText) return { result: null };
      Object.assign(item, { goalText: log.goalFor.phrase, goalQuote: log.goalFor.quote, goalConfirmed: false });
      return { list, result: item.name };
    }).catch((error) => console.error(`hikyaku goal line for ${name}: ${error.message}`));
  }
  if (!log.unchanged && saved[name].summary) await retireAfterCatchUp(found, saved[name].summary, settings).catch((error) => console.error(`hikyaku retire for ${name}: ${error.message}`));
  rankSoon();
  return { ...log, found: threads.length, ...await prepareEntryMove(name) };
}

export async function retireAfterCatchUp(workstream, summary, settings) {
  const home = hikyakuDirectory();
  const project = (await coreClient.listProjects()).find((item) => item.name.toLowerCase() === workstream.name.toLowerCase());
  if (!project) return;
  const mine = (await coreClient.listTasks()).filter((task) => task.projectId === project.id && task.status !== 'done');
  const complete = thinkWith({ settings, maxTokens: 1200, consent: consentFor('mail', { workstream }), what: `the "${workstream.name}" moves`, path: 'retire', onNeedYes: askCloudYes });
  const result = await retireStale({ home, name: workstream.name, summary, tasks: mine, complete, today: new Date().toLocaleDateString('en-CA'), stateOf: (task) => currentState(join(project.directoryPath, task.id)) });
  await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), retire: workstream.name, offered: result.offered, retired: result.retired.map((item) => ({ task: item.taskId, why: item.why })) })}\n`);
}

// The change check, then the refresh (docs/workstream-integration/proposal.md): every connected source read since
// its watermark, routed and logged (sources.js, no model, no cost), then each workstream with something new re-read.
// A source that is not connected is skipped; one that fails is reported and read again next time. runs.jsonl gets one
// line with the counts per source. `auto` is the timer's run (startRefreshing); the user's own refresh passes false.
// Past today's cloud limit (settings.cloudDailyLimitUsd, default $3) the cloud workstreams wait for tomorrow. First, a
// workstream parked until today or earlier comes back (park.js), so this same run reads it as changed.
export async function runRefresh({ auto = false } = {}) {
  const home = hikyakuDirectory();
  // A park that cannot come back is reported with the run, never stops the change check (it retries next run).
  const parkErrors = [];
  const returned = await returnParked({ home, workstreams: await readWorkstreams(home), today: new Date().toLocaleDateString('en-CA') })
    .catch((error) => { parkErrors.push({ source: 'park', message: error.message }); return []; });
  const settings = await readSettings(home);
  const { apps } = await chatApps();
  const inMail = await ownAddresses().catch(() => []);
  const ownAddressList = [...new Set([...inMail, ...(settings.ownAddresses || [])].filter(Boolean).map((a) => a.toLowerCase()))];
  const { listEvents } = await import('../src/hikyaku/calendar.js');
  const { checkChanges } = await import('../src/hikyaku/sources.js');
  const workstreams = await readWorkstreams(home);
  // What the router cannot place goes to the cloud AI for a suggested home (suggest.js), under the yes each kind of
  // item already has: chats under the Chats approval, mail under "sorting new mail". Past today's limit, nothing goes.
  const limitNow = Number(settings.cloudDailyLimitUsd) > 0 ? Number(settings.cloudDailyLimitUsd) : 3;
  const summaries = Object.fromEntries(Object.entries(JSON.parse(await readFile(join(home, 'catchup-state.json'), 'utf8').catch(() => '{}'))).map(([name, entry]) => [name, entry?.summary || '']));
  const suggest = (await usageToday(home)).usd >= limitNow ? null : (items) => suggestHomes({ items, workstreams, summaries,
    thinkFor: (kind) => (kind === 'chats'
      ? thinkWith({ settings, maxTokens: 800, consent: consentFor('chats', { settings }), what: 'your chats', path: 'chats', onNeedYes: askCloudYes })
      : thinkWith({ settings, maxTokens: 800, consent: consentFor('triage', { settings }), what: 'your new mail', path: 'triage', onNeedYes: askCloudYes })) });
  const check = await checkChanges({ home, workstreams, ownAddresses: ownAddressList,
    readInbox: inMail.length ? readInboxMail : null,
    readChats: apps.length ? (options) => readChatsNamed({ apps, ...options }) : null, listEvents, suggest });
  // A text that asks the user to email someone else becomes an email move, by code on this Mac (chat-email.js, W5):
  // no model reads the chat. Only with chats switched on.
  const emailMoves = apps.length ? await (async () => {
    const { emailAsksIn, makeEmailMoves } = await import('../src/hikyaku/chat-email.js');
    const read = await readChatsNamed({ apps, days: 3, maxChats: 80, maxMessages: 40 });
    return makeEmailMoves({ core: coreClient, asks: emailAsksIn(read), workRoot: join(home, 'work'), projectName: CHATS_WORKSTREAM.name });
  })().catch((error) => { parkErrors.push({ source: 'chat-email', message: error.message }); return []; }) : [];
  const limitUsd = Number(settings.cloudDailyLimitUsd) > 0 ? Number(settings.cloudDailyLimitUsd) : 3;
  const overBudget = (await usageToday(home)).usd >= limitUsd;
  const refreshed = await refreshChanged({ auto, overBudget });
  const usdToday = (await usageToday(home)).usd;
  const line = { at: new Date().toISOString(), refresh: true, auto, returned, counts: check.counts, errors: [...parkErrors, ...check.errors], kept: check.items.length, ms: check.ms, refreshed, usdToday, limitUsd, emailMoves: emailMoves.length };
  await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify(line)}\n`);
  return line;
}

// Re-reads every workstream the change log has something new for (refresh.js changedWorkstreams), one at a time.
// A failure on one is logged and never stops the others. refresh.js refreshPlan says which wait (once a day for the
// timer, quiet goals, the cloud limit); a timer read that worked stamps `autoDay` so the next tick today skips it.
export async function refreshChanged({ auto = false, overBudget = false } = {}) {
  const home = hikyakuDirectory();
  const stateFile = join(home, 'catchup-state.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
  const workstreams = await readWorkstreams(home);
  const today = new Date().toLocaleDateString('en-CA');
  // A found card's first read is the Found step's (catchUpFound), never the refresh's (D1).
  const changed = firstReadsOut(changedWorkstreams({ items: await readChanges(home), state: saved, workstreams, today }), { workstreams, state: saved });
  const results = [];
  for (const { name, items, action, reason } of refreshPlan({ changed, state: saved, workstreams, today, auto, overBudget })) {
    if (action === 'skip') { results.push({ name, items: items.length, ok: false, skipped: reason }); continue; }
    try {
      const log = await catchUpOn(name, { refresh: true });
      // No cloud yes and no local model: nothing was read, and it stays unread rather than reported as done.
      const result = log.needsYes ? { name, items: items.length, ok: false, skipped: 'needs a yes to use the cloud AI for this workstream' } : { name, items: items.length, ok: true, ...(log.unchanged ? { unchanged: true } : {}) };
      if (auto && result.ok) {
        const fresh = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
        const before = fresh[name]?.autoReads?.day === today ? fresh[name].autoReads.count : 0;
        fresh[name] = { ...fresh[name], autoDay: today, autoReads: { day: today, count: before + 1, last: new Date().toISOString() } };
        await writeFile(stateFile, JSON.stringify(fresh, null, 2));
      }
      results.push(result);
    }
    catch (error) { results.push({ name, items: items.length, ok: false, error: error.message }); console.error(`hikyaku refresh: "${name}" failed: ${error.message}`); }
  }
  return results;
}

// In the entry (settings.json "frontier": "nebius"), a catch-up ends with the workstream's open moves screened on
// this Mac and one next-move send prepared (entry.js prepareWorkstreamMove). Nothing is sent: the send waits in the
// send gate for the user's Send. A screen that cannot run is reported on the log, never worked around.
export async function prepareEntryMove(name) {
  const settings = await readSettings(hikyakuDirectory());
  if (settings.frontier !== 'nebius') return {};
  try {
    const { prepareWorkstreamMove } = await import('../src/hikyaku/entry.js');
    const runtime = transcriberRuntime(settings);
    const send = await prepareWorkstreamMove({ home: hikyakuDirectory(), core: coreClient, workstream: name, transcriber: runtime.dir, python: runtime.python, me: settings.signName || null });
    return { prepared: send ? send.run : null };
  } catch (error) { return { prepared: null, prepareError: error.message }; }
}

export async function learnIntros() {
  const source = await mailSource();
  if (source.kind === 'none') return { scanned: 0, intros: 0, pattern: false, file: null, skipped: source.why };
  const emailAddress = source.address;
  const threads = [];
  // Apple Mail (workspaces-outlook W7): the user's own Sent copy, 180 days, each email its own thread. Sent rows carry
  // no display name, so the first name comes from settings.signName; collectIntros keeps only real intros.
  const firstName = String((await readSettings(hikyakuDirectory())).signName || '').trim().split(/\s+/)[0] || '';
  for (const message of await readSentMail({ address: source.own, days: 180 }).catch(() => [])) {
    threads.push({ id: message.id, subject: message.subject, messages: [{ id: message.id, from: message.from || emailAddress, to: message.to.join(', '), cc: '', subject: message.subject, timestamp: message.timestamp, body: cutQuoted(message.body) }] });
  }
  const intros = collectIntros(threads, emailAddress, firstName);
  const settings = await readSettings(hikyakuDirectory());
  const complete = intros.length ? thinkWith({ settings, maxTokens: 700, consent: consentFor('style', { settings }), what: 'how you introduce yourself', path: 'style', onNeedYes: askCloudYes }) : null;
  const pattern = complete ? parseJsonReply(await complete(patternPrompt(intros.slice(0, 25)))) : null;
  const directory = join(hikyakuDirectory(), 'voice');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'intros.md');
  await writeFile(file, introsMarkdown({ account: emailAddress, intros, pattern, scanned: threads.length }));
  await writeFile(join(directory, 'intros.json'), JSON.stringify({ account: emailAddress, scanned: threads.length, pattern, intros }, null, 2));
  return { scanned: threads.length, intros: intros.length, pattern: Boolean(pattern), file };
}

// Drafts waiting in the mail app are checked for a sent copy every 10 minutes, so a card closes on its own after
// the user presses Send (or a scheduled send goes out). Only those tasks' own threads are read.
export async function checkSent() {
  const projects = new Map((await coreClient.listProjects()).map((project) => [project.id, project.directoryPath]));
  const waiting = [], chatsWaiting = [];
  for (const task of await coreClient.listTasks()) {
    const directory = projects.get(task.projectId) && join(projects.get(task.projectId), task.id);
    if (!directory || task.status === 'done') continue;
    if (['messages', 'whatsapp'].includes(task.sourceType)) {
      if ((await currentState(directory))?.phase !== 'in-mail-app') continue;
      // An email move from a chat (W5) waits on the email, found in Sent by its recipient, not on the chat.
      const reply = JSON.parse(await readFile(join(directory, 'REPLY.json'), 'utf8').catch(() => 'null'));
      if (reply?.ask && reply.to) waiting.push({ task, directory }); else chatsWaiting.push(directory);
      continue;
    }
    if (!['gmail', 'manual'].includes(task.sourceType)) continue;
    if ((await currentState(directory))?.phase === 'in-mail-app') waiting.push({ task, directory });
  }
  // A chat move is sent when the user's own next message appears in that chat (chats.js); the chat is re-read, nothing else.
  if (chatsWaiting.length) {
    const chatDeltas = await recordChatDeltas({ taskDirectories: chatsWaiting, home: hikyakuDirectory() });
    const closedChats = await closeSent({ core: coreClient, taskDirectories: chatsWaiting });
    if (closedChats.length) console.log(`hikyaku: ${closedChats.length} chat reply(ies) sent, closed (${chatDeltas.length} texting deltas recorded)`);
  }
  if (!waiting.length) return;
  // Apple Mail's Sent copy closes the move (workspaces-outlook W6), found by recipient.
  const source = await mailSource();
  if (source.kind === 'none') return;
  const found = [];
  await recoverSentMail(found, source.own);
  const sentMail = await readSentMail({ address: source.own, days: 30 }).catch(() => []);
  const taskDirectories = waiting.map(({ directory }) => directory);
  const deltas = await recordDeltas({ taskDirectories, threads: found, ownAddress: source.own, home: hikyakuDirectory(), sentMail });
  const closed = await closeSent({ core: coreClient, taskDirectories });
  if (closed.length) console.log(`hikyaku: ${closed.length} sent, closed (${deltas.length} voice deltas recorded)`);
}

// The texting voice: the user's own chat messages (both apps), screened by code, measured, and described once by the
// local model, into voice/texting.md. Built the way intros.md is, and only when chats are switched on.
export async function learnTexting() {
  const { apps } = await chatApps();
  if (!apps.length) throw new Error('No chat app is switched on in settings.json ("chats").');
  const read = await readChats({ apps, days: 180, maxChats: 200, maxMessages: 80 });
  const { samples, scanned } = textingSample(read, { screen: codeScreen, max: 40 });
  const settings = await readSettings(hikyakuDirectory());
  const complete = samples.length ? thinkWith({ settings, maxTokens: 500, consent: consentFor('style', { settings }), what: 'how you text', path: 'style', onNeedYes: askCloudYes }) : null;
  const pattern = complete ? parseJsonReply(await complete(textingPatternPrompt(samples))) : null;
  const directory = join(hikyakuDirectory(), 'voice');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'texting.md'), textingMarkdown({ samples, scanned, pattern }));
  await writeFile(join(directory, 'texting.json'), JSON.stringify({ apps: chatCounts(read), scanned, pattern, samples }, null, 2));
  return { apps: chatCounts(read), scanned, samples: samples.length, pattern: Boolean(pattern) };
}

// Every card in the order to work on it (priorities.js): the cloud AI reads each workstream's goal, summary, open moves
// and what was finished in the last 14 days; code checks the answer and writes priorities.json. Drafted goals go onto
// workstreams.json lines with no confirmed goal. With no yes, or when the AI fails, the order is by date and says so.
export let rankTimer = null;
export async function rankAll() {
  const home = hikyakuDirectory();
  const settings = await readSettings(home);
  const complete = thinkWith({ settings, maxTokens: 2000, consent: consentFor('rank', { settings }), what: 'your workstreams to put them in order', path: 'rank', onNeedYes: askCloudYes });
  // A drafted goal that is really a step becomes a move before anything reads the goals (goal-shape.js).
  const demoted = await demoteTaskGoals({ home, core: coreClient, update: withWorkstreams }).catch((error) => ({ error: error.message }));
  if (demoted.error || demoted.demoted.length || demoted.skipped.length) await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), goalShape: true, ...demoted })}\n`);
  // Moves whose event date is over leave first (retire.js, code only, no cloud call), so the pick never ranks them.
  const past = await retirePastDates({ home, core: coreClient, today: new Date().toLocaleDateString('en-CA'), stateOf: (project, task) => (project ? currentState(join(project.directoryPath, task.id)) : null) }).catch((error) => { console.error(`hikyaku past dates: ${error.message}`); return []; });
  if (past.length) await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), retirePast: past.map((item) => ({ task: item.taskId, date: item.proof })) })}\n`);
  const allProjects = await coreClient.listProjects();
  const tasks = (await coreClient.listTasks()).filter(notRetired(await readRetired(home)));
  const saved = JSON.parse(await readFile(join(home, 'catchup-state.json'), 'utf8').catch(() => '{}'));
  const { apps } = await chatApps();
  const workstreams = cardList({ workstreams: await readWorkstreams(home), projects: allProjects, tasks: tasks.filter((task) => task.status !== 'done'), extra: apps.length ? [{ ...CHATS_WORKSTREAM }] : [], hidden: await dismissedNames(home) });
  // What the pick reads besides open moves (gather.js): the last two weeks of calls with the words already written
  // about them, whether the user wrote to those people since (Outlook's Sent, read only; unreadable is "unknown",
  // never "no"), the user's habits, and the moves a newer call replaced.
  const ownAddressList = await ownAddresses().catch(() => []);
  const sent = ownAddressList.length ? await readSentMail({ address: ownAddressList, days: 14 }).catch(() => null) : null;
  const events = await recentEvents({ callsHome: join(home, 'calls'), now: new Date(), sent });
  // The user's own steps from those calls become moves first (bookkeeping: the notes already say whose step it is).
  const made = await createStepTasks({ core: coreClient, steps: ownCallSteps(events, settings.signName || 'me', new Date().toLocaleDateString('en-CA')) });
  if (made.length) tasks.push(...(await coreClient.listTasks()).filter((task) => made.includes(task.id)));
  const streams = rankInput({ workstreams, saved, projects: new Map(allProjects.map((project) => [project.name.toLowerCase(), project.id])), tasks, now: new Date(),
    events, replaced: await readReplaced(home), dueDates: await readDueDates(home) });
  const result = await rankWorkstreams({ streams, complete, home, habits: await readHabits(home) });
  // A replaced move is recorded with the call that replaced it, never deleted; the new move becomes a task Do it can
  // work on, and priorities.json is written again with its id.
  await recordReplaced(home, result.replaced || []);
  const fresh = result.picks.find((pick) => pick.isNew);
  if (fresh) {
    const event = [...events.values()].flat().find((item) => item.call === fresh.call);
    fresh.taskId = event ? await createOwedTask({ core: coreClient, workRoot: join(home, 'work'), pick: fresh, event, ownAddress: ownAddressList[0] || '' }).catch((error) => { console.error(`hikyaku owed move: ${error.message}`); return null; }) : null;
    await writeFile(join(home, 'priorities.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  await appendFile(join(home, 'runs.jsonl'), `${JSON.stringify({ at: result.at, rank: true, source: result.source, seconds: result.seconds ?? null, count: result.ranked.length, picks: result.picks.map((pick) => pick.name), replaced: (result.replaced || []).map((row) => row.name), dropped: result.dropped, note: result.note })}\n`);
  // The panel drew its cards before this ranking existed (2026-10-09: it showed file order); it draws them again now.
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:ranked', { source: result.source, at: result.at });
  return result;
}

// The one change signal (Gio, 2026-10-23: "I have to refresh Workspaces for the Today tab to update"): Today and
// Workspaces reload their cards and picks (panel.js reloadShared). Sent after anything off Today changes what they show.
export function sayChanged(text = '') {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text });
}

// Ranks again 30 s after the last catch-up of a burst, so a run of catch-ups costs one ranking.
export function rankSoon() {
  clearTimeout(rankTimer);
  rankTimer = setTimeout(() => rankAll().catch((error) => console.error(`hikyaku rank failed: ${error.message}`)), 30000);
  rankTimer.unref?.();
}

// Once a day: the first check of a new day (or with no priorities.json yet) ranks; the rest find today's and stop.
export function startRanking() {
  const tick = async () => {
    const saved = await readPriorities(hikyakuDirectory());
    if (saved?.at && new Date(saved.at).toLocaleDateString('en-CA') === new Date().toLocaleDateString('en-CA')) return;
    await rankAll();
  };
  const run = () => tick().catch((error) => console.error(`hikyaku rank failed: ${error.message}`));
  setTimeout(run, 20000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}

// The falsifier's instrument: the first workstream the user acts on today (priorities.js recordFirstAct). Never in
// the way of the act itself.
export async function actedOn({ name = null, taskId = null }) {
  try {
    let stream = name;
    if (!stream && taskId) {
      const task = await coreClient.getTask(taskId);
      stream = task?.projectId ? (await coreClient.getProject(task.projectId))?.name : null;
    }
    if (stream) await recordFirstAct(hikyakuDirectory(), stream);
  } catch (error) {
    console.error(`hikyaku first-act log: ${error.message}`);
  }
}

// The kept cards' first reads (first-run-polish B4.3, D1): one at a time, never awaited by an IPC reply; each one read
// redraws the cards. The only first read a found card gets.
export const catchUpFound = foundCatchUp({
  catchUpOn: (name) => catchUpOn(name),
  onRead: () => { if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text: '' }); },
  onError: (name, error) => console.error(`hikyaku found: catch-up on "${name}" failed: ${error.message}`),
});
export const resumeFoundCatchUp = async () => catchUpFound(await needCatchUp({ home: hikyakuDirectory() }));
