// The Meetings doors: the next meeting, invites, sends, recordings, calls, notes and names.
// Moved out of main.js in debt-cleanup 6.6.
import { join } from 'node:path';
import { dialog } from 'electron';
import { validateDecide, validateRecordTitle, validateRecordEvent, validateRecordAlso, validateRecordCalendars, validateCallNotes, validateFileCall, fileSource, validateFileEvent, validateWorkspaceFromEvent, validateNameWord, validateCallId, validateMeetingAnswer, validateMeetingEnd, validateMeetingPause, validateSendApproval, validateTitleChoice } from './ipc-validation.js';
import { listEvents } from '../src/hikyaku/calendar.js';
import { readChanges } from '../src/hikyaku/changes.js';
import { answerAsk } from '../src/hikyaku/screen-data.js';
import { readSettings } from '../src/hikyaku/draft.js';
import { readRetired } from '../src/hikyaku/retire.js';
import { readWorkstreams } from '../src/hikyaku/workstreams.js';
import { coreClient, hikyakuDirectory, calendarState, handleSecure, inSettings, logUiAct, setCalendarState } from './main-state.js';
import { panelWindow } from './main-windows.js';
import { ownAddresses, sendGateOptions, startNameCheck, startErrands, decideGateOptions, nextMoveHook, filedMoves } from './main-helpers.js';
import { catchUpOn, sayChanged } from './main-catch-up.js';
import { meetingWatch, prepareManualRecording } from './main-background.js';

// When a call ended (its start plus its minutes), for the filing ui-act; null when the list does not know it.
async function callEndedAt(id) {
  const { listCalls } = await import('../src/hikyaku/call-list.js');
  const call = (await listCalls({ home: hikyakuDirectory() })).find((item) => item.id === id);
  return call?.start ? Date.parse(call.start) + (Number(call.minutes) || 0) * 60000 : null;
}

// A workspace name Record may carry: one that exists now, else none.
async function liveWorkspace(name) {
  if (typeof name !== 'string') return null;
  return (await readWorkstreams(hikyakuDirectory())).find((item) => item.name === name)?.name || null;
}

export function registerMeetingsIpc() {
  // "Set up the next meeting?" (invite.js): the newest recorded call with a checked summary and no invite yet, its fields
  // filled in; Fill in Outlook opens Outlook's own invite, picks a free room, and stops before Send. Never sends.
  const callsHome = () => join(hikyakuDirectory(), 'calls');
  handleSecure('hikyaku:next-meeting', async () => {
    const { nextMeetingCandidate } = await import('../src/hikyaku/invite.js');
    const settings = await readSettings(hikyakuDirectory());
    return nextMeetingCandidate({ callsHome: callsHome(), place: settings.invitePlace || {} });
  });
  handleSecure('hikyaku:invite', async (call, fields) => {
    const invites = await import('../src/hikyaku/invite.js');
    const input = invites.validateInviteFields(call, fields);
    const settings = await readSettings(hikyakuDirectory());
    await invites.rememberPlace(hikyakuDirectory(), { room: input.room, floors: input.floors });
    const result = await invites.invite({ folder: join(callsHome(), input.call), start: `${input.date}T${input.start}`, end: input.end, room: input.room, floors: input.floors, signName: settings.signName || '' });
    return { status: result.status, detail: result.detail, subject: result.subject, people: result.attendees.length, room: result.room_picked || '', actions: result.actions.length };
  });
  handleSecure('hikyaku:skip-next-meeting', async (call) => (await import('../src/hikyaku/invite.js')).skipNextMeeting({ callsHome: callsHome(), call }));
  handleSecure('hikyaku:sends', async () => (await import('../src/hikyaku/send-gate.js')).pendingSends(hikyakuDirectory()));
  // "Summarize with cloud AI? Yes / No" (send-gate.js decideSend): Yes with a remembered pick sends at once, the first
  // Yes returns the picker, No sends nothing.
  handleSecure('hikyaku:decide', async (run, decision) => {
    validateDecide(run, decision);
    const { gate, options } = await decideGateOptions();
    return gate.decideSend({ ...options, run, decision });
  });
  handleSecure('hikyaku:send', async (run, provider, remember) => {
    validateSendApproval(run, provider, remember);
    const { gate, transcriber, python, checks } = await sendGateOptions();
    const { fileCall } = await import('../src/hikyaku/calls.js');
    const file = async (folder) => { const filed = await fileCall({ folder, core: coreClient, workRoot: join(hikyakuDirectory(), 'work'), workstreams: await readWorkstreams(hikyakuDirectory()) }); startNameCheck(folder); startErrands(folder); return filedMoves(filed); };
    return gate.approveSend({ home: hikyakuDirectory(), run, provider, remember, checks, transcriber, python, file, nextMove: await nextMoveHook() });
  });
  // A meeting offer's answer (meeting-watch.js, spec-c.md B14): "record" is the one thing that starts a recording; it
  // runs call.py start in the transcriber folder and waits for it. "dismiss" only records the answer. No surface here.
  handleSecure('hikyaku:meeting-answer', async (offerId, answer) => {
    const input = validateMeetingAnswer(offerId, answer);
    if (!meetingWatch) throw new Error('Loggie is not watching your calendar yet.');
    return meetingWatch.answer(input.offerId, input.answer);
  });
  // The end ask's answer (meeting-watch.js, spec-c.md B15): "stop" is the one thing that ends a recording; it starts
  // call.py stop detached, because stop transcribes for minutes. "keep" only records the answer. No surface here.
  handleSecure('hikyaku:meeting-end', async (call, answer) => {
    const input = validateMeetingEnd(call, answer);
    if (!meetingWatch) throw new Error('Loggie is not watching your calendar yet.');
    const result = await meetingWatch.endAnswer(input.call, input.answer);
    if (input.answer === 'stop') logUiAct({ act: 'record-stop', call: input.call });
    return result;
  });
  // A page tucked into a call (loggie-pause-attach, any state since loggie-pages-anytime): picked from the fusen tab
  // (the Mac's open panel, here in main) or dropped (the page sends the dropped file's path). `where` is the place it
  // was pressed (strip, card, ended, page) and the call's state goes with it, for the bet's ui-acts.
  const PAGE_PLACES = ['strip', 'card', 'ended', 'page'];
  const callState = async (call) => {
    const { listCalls } = await import('../src/hikyaku/call-list.js');
    const found = (await listCalls({ home: hikyakuDirectory() })).find((item) => item.id === call);
    if (!found) throw new Error('That call is not on this Mac.');
    return found.state;
  };
  const tuckIn = async (call, paths, source, where) => {
    const { addPage, listPages } = await import('../src/hikyaku/call-pages.js');
    const state = await callState(call);
    let result = { added: null, pages: await listPages(join(callsHome(), call)) };
    for (const path of paths) {
      result = await addPage({ folder: join(callsHome(), call), path });
      logUiAct({ act: 'page-add', call, source, where: PAGE_PLACES.includes(where) ? where : null, state });
    }
    return result;
  };
  handleSecure('hikyaku:call-page-pick', async (call, where) => {
    const id = validateCallId(call);
    await callState(id);
    const { PAGE_KINDS } = await import('../src/hikyaku/call-pages.js');
    const options = { title: 'Tuck a page into this call', buttonLabel: 'Tuck it in', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Pages', extensions: PAGE_KINDS.map((kind) => kind.slice(1)) }] };
    const picked = panelWindow && !panelWindow.isDestroyed() ? await dialog.showOpenDialog(panelWindow, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return { added: null, pages: null };
    return tuckIn(id, picked.filePaths, 'tab', where);
  });
  handleSecure('hikyaku:call-page-add', async (call, path, where) => {
    const id = validateCallId(call);
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) throw new Error('That page could not be found.');
    return tuckIn(id, [path], 'drop', where);
  });
  // A page for a meeting not started yet (pages-waiting.js): held under its occurrence until Record moves it in.
  const stage = async (eventId, start, paths, source) => {
    const { stagePage, listStaged } = await import('../src/hikyaku/pages-waiting.js');
    let result = { added: null, pages: await listStaged({ home: hikyakuDirectory(), eventId, start }) };
    for (const path of paths) {
      result = await stagePage({ home: hikyakuDirectory(), eventId, start, path });
      logUiAct({ act: 'page-add', call: null, source, where: 'next', state: 'before' });
    }
    return result;
  };
  handleSecure('hikyaku:event-page-pick', async (eventId, start) => {
    const id = validateRecordEvent(eventId);
    if (!id || !Number.isFinite(Date.parse(start))) throw new Error('Invalid calendar event.');
    const { PAGE_KINDS } = await import('../src/hikyaku/call-pages.js');
    const options = { title: 'Tuck a page into this meeting', buttonLabel: 'Tuck it in', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Pages', extensions: PAGE_KINDS.map((kind) => kind.slice(1)) }] };
    const picked = panelWindow && !panelWindow.isDestroyed() ? await dialog.showOpenDialog(panelWindow, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return { added: null, pages: null };
    return stage(id, start, picked.filePaths, 'tab');
  });
  handleSecure('hikyaku:event-page-add', async (eventId, start, path) => {
    const id = validateRecordEvent(eventId);
    if (!id || !Number.isFinite(Date.parse(start))) throw new Error('Invalid calendar event.');
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) throw new Error('That page could not be found.');
    return stage(id, start, [path], 'drop');
  });
  // Pause or resume the recording (loggie-pause-attach): the recorder saves silence until resume, one recording throughout.
  handleSecure('hikyaku:meeting-pause', async (call, answer) => {
    const input = validateMeetingPause(call, answer);
    if (!meetingWatch) throw new Error('Loggie is not watching your calendar yet.');
    const result = await meetingWatch.pauseAnswer(input.call, input.answer);
    logUiAct({ act: `record-${input.answer}`, call: input.call });
    return result;
  });
  // The Notes & Meetings tab (call-list.js, loggie-meetings-tab): every call with its state, and one call opened with
  // its summary, next steps (tied to the moves they became), transcript and typed notes.
  handleSecure('hikyaku:calls', async () => (await import('../src/hikyaku/call-list.js')).listCalls({ home: hikyakuDirectory() }));
  // The Meetings week (week-events.js): the calendar's events for the days asked, each joined to its call's notes. A
  // calendar macOS refused is not asked again until the app restarts; the week then shows the calls alone.
  handleSecure('hikyaku:events', async (from, to) => {
    const { checkRange, joinWeek, routeEvents } = await import('./week-events.js');
    const days = checkRange(from, to);
    const home = hikyakuDirectory();
    const calls = await (await import('../src/hikyaku/call-list.js')).listCalls({ home });
    let events = [];
    if (calendarState !== 'denied') {
      try { events = await listEvents({ from: new Date(`${from}T00:00:00`), days }); setCalendarState('granted'); } catch (error) {
        if (!/cannot read your calendars/.test(error.message)) throw error;
        setCalendarState('denied');
      }
    }
    // Each meeting's workspace (spec B3): read once per week, routed now, with no cloud call. The router needs the
    // people and threads the change check learns; attendee names stay here, the page gets a count.
    const { learnPeople, learnThreads, threadMap } = await import('../src/hikyaku/router.js');
    const workstreams = await readWorkstreams(home);
    const own = await ownAddresses().catch(() => []);
    const lines = await readChanges(home).catch(() => []);
    const learned = await learnPeople({ home, workstreams, ownAddresses: own }).catch(() => new Map());
    const threads = threadMap(lines, await learnThreads({ home, workstreams, ownAddresses: own }).catch(() => new Map()));
    const routes = routeEvents(events, { lines, workstreams, learned, threads });
    const { recordCalendarsSaved } = await import('../src/hikyaku/meeting.js');
    const week = joinWeek(events, calls, { from, to, now: Date.now(), calendar: calendarState === 'denied' ? 'denied' : 'granted', routes, recordCalendars: recordCalendarsSaved(await readSettings(home)) });
    // A meeting with no recording yet carries the pages waiting for it (pages-waiting.js), by name.
    const { listStaged } = await import('../src/hikyaku/pages-waiting.js');
    for (const item of week.items) if (item.kind === 'event' && !item.call && item.id) item.pages = await listStaged({ home, eventId: item.id, start: item.start });
    return week;
  });
  // One meeting on the calendar, by the id and start the week carries; main reads it itself, so the page never sends
  // (or gets) who is invited.
  const meetingOf = async ({ id: eventId, start: eventStart }) => {
    if (calendarState === 'denied') throw new Error('Loggie cannot read your calendar, so this meeting cannot be filed.');
    const at = Date.parse(eventStart);
    const event = (await listEvents({ from: new Date(at - 60000), days: 1 })).find((item) => item.id === eventId && Date.parse(item.start) === at);
    if (!event) throw new Error('That meeting is no longer on your calendar.');
    return event;
  };
  // A meeting filed under a workspace: one routed line in changes.jsonl and one answer in asked.jsonl, through the same
  // answerAsk as an unsure email, with its own ref, so the meeting and its repeats file there (week-events.js routes by
  // thread). A name not in workstreams.json throws. Returns answerAsk's { saved, logged }.
  const fileEventTo = async (event, workstream) => {
    const { answerRef, eventItem, eventKey } = await import('./week-events.js');
    const { makeItem } = await import('../src/hikyaku/changes.js');
    const home = hikyakuDirectory();
    const item = makeItem(eventItem(event, { ref: answerRef(await readChanges(home), event) }));
    const result = await answerAsk({ home, item, workstream });
    logUiAct({ act: 'event-file', again: item.ref !== eventKey(event) });
    return result;
  };
  // A meeting with no recording filed under a workspace from the week (spec B3).
  handleSecure('hikyaku:file-event', async (id, start, workstream) => {
    const input = validateFileEvent(id, start, workstream);
    const result = await fileEventTo(await meetingOf(input), input.workstream);
    return { ...result, workstream: input.workstream };
  });
  // What a new workspace made from this meeting would follow (first-run-polish B3.3): counts, domains and title words,
  // never an address.
  handleSecure('hikyaku:event-seed', async (id, start) => {
    const input = validateFileEvent(id, start, 'x');
    const event = await meetingOf(input);
    const { seedFromEvent } = await import('./week-events.js');
    const settings = await readSettings(hikyakuDirectory());
    const seed = seedFromEvent(event, { ownAddresses: await ownAddresses(), ownNames: [settings.signName].filter(Boolean) });
    return { people: seed.people.length, domains: seed.domains, words: seed.words };
  });
  // New workspace… on a meeting with no recording (first-run-polish B3.3, R3's one exception): a workspace seeded only
  // from that meeting as main reads it, named by the person, the person's own (confirmed), then the meeting filed there.
  // The cloud reads its mail only when the person already said yes to found workspaces; else its card asks as today.
  // Nothing is sent. A filing that fails leaves the workspace made and says so; it never throws after the write.
  const noAddress = (text) => String(text || '').replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g, 'an address');
  handleSecure('hikyaku:workspace-from-event', async (id, start, name) => {
    const input = validateWorkspaceFromEvent(id, start, name);
    const event = await meetingOf(input);
    const { eventKey, seedFromEvent } = await import('./week-events.js');
    const { addWorkstream } = await import('../src/hikyaku/entry.js');
    const home = hikyakuDirectory();
    const at = new Date().toISOString();
    const settings = await readSettings(home);
    const seed = seedFromEvent(event, { ownAddresses: await ownAddresses(), ownNames: [settings.signName].filter(Boolean) });
    const cloud = settings.cloudYes?.found === true;
    const entry = await addWorkstream({ home, name: input.name, domains: seed.domains, words: seed.words, people: seed.people,
      extra: { madeFrom: { event: eventKey(event), at }, confirmed: at, ...(cloud ? { cloud: 'nebius' } : {}) } });
    logUiAct({ act: 'workspace-from-event', people: seed.people.length, domains: seed.domains.length, words: seed.words.length });
    let failed = null;
    try { await fileEventTo(event, entry.name); } catch (error) { failed = noAddress(error.message); }
    const refreshed = (text) => { if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('hikyaku:moved', { taskId: null, phase: 'refreshed', text }); };
    refreshed(`Made ${entry.name}.`);
    if (cloud) {
      catchUpOn(entry.name).then(() => refreshed(`${entry.name} is up to date.`))
        .catch((error) => console.error(`hikyaku: the first read of "${entry.name}" failed: ${noAddress(error.message)}`));
    }
    return failed === null ? { name: entry.name, cloud, filed: true } : { name: entry.name, cloud, filed: false, message: failed };
  });
  // "Record from these calendars" on Settings (record-calendars.js, 2026-10-27): every calendar with its checkhouse, and a
  // change that saves the whole checked list. A calendar macOS refused gives no rows and says so.
  handleSecure('hikyaku:record-calendars', async () => {
    const [{ listCalendars }, { recordCalendarsView }, { readRawSettings }] = await Promise.all([import('../src/hikyaku/calendar.js'), import('../src/hikyaku/record-calendars.js'), import('../src/hikyaku/setup-status.js')]);
    return recordCalendarsView(await listCalendars(), await readRawSettings(hikyakuDirectory()));
  });
  handleSecure('hikyaku:set-record-calendars', (ids) => inSettings(async () => {
    const [{ listCalendars }, { recordCalendarsView, saveRecordCalendars }] = await Promise.all([import('../src/hikyaku/calendar.js'), import('../src/hikyaku/record-calendars.js')]);
    return recordCalendarsView(await listCalendars(), await saveRecordCalendars(hikyakuDirectory(), validateRecordCalendars(ids)));
  }));
  // Record on the Notes & Meetings tab: the press starts call.py start (meeting-watch.js startManual). Stop is the end
  // ask's own answer, hikyaku:meeting-end with "stop".
  // `source`: where the press was (the Day card, a Day row, the top row), logged for loggie-meetings-focus's bet.
  // `workspace`: the meeting's workspace when he filed the meeting (never a guess), so the recording is filed from its
  // first second (cycle 2, jidoka at the source); a name no live workspace has is dropped.
  // `eventId`: the card's or row's event (2026-10-27), recorded as pressed; the top row sends none.
  // `alsoEventId`: Record both (2026-10-28), the meeting on the Mac's sound; `eventId` is then the one in the room.
  handleSecure('hikyaku:record-start', async (title, source = 'top', workspace = null, eventId = null, alsoEventId = null) => {
    validateRecordTitle(title);
    const event = validateRecordEvent(eventId);
    const also = validateRecordAlso(event, alsoEventId);
    await prepareManualRecording();
    const result = await meetingWatch.startManual(validateRecordTitle(title), { workstream: await liveWorkspace(workspace), eventId: event, alsoEventId: also });
    // Pages tucked into this meeting before it started (loggie-pages-anytime) move into the new call now, so the stop's
    // spelling and the notes read them as if they had been tucked in while it recorded.
    if (result.call && event) {
      const { moveStaged } = await import('../src/hikyaku/pages-waiting.js');
      const moved = await moveStaged({ home: hikyakuDirectory(), eventId: event, callFolder: join(callsHome(), result.call) }).catch((error) => { console.error(`pages-waiting: ${error.message}`); return 0; });
      if (moved) logUiAct({ act: 'page-move', call: result.call, pages: moved });
    }
    logUiAct({ act: 'record-start', call: result.call || null, blocked: result.blocked || null, source: ['card', 'row', 'top'].includes(source) ? source : 'top' });
    return result;
  });
  // Typed notes on a call (call-notes.js): saved as my-notes.md. A call already waiting for the yes is screened again
  // with them, so the pending send carries them and the yes covers them.
  handleSecure('hikyaku:call-notes', async (id, text) => {
    const input = validateCallNotes(id, text);
    const { prepareCall, saveCallNotes } = await import('../src/hikyaku/call-notes.js');
    const saved = await saveCallNotes({ home: hikyakuDirectory(), ...input });
    const row = (await (await import('../src/hikyaku/call-list.js')).listCalls({ home: hikyakuDirectory() })).find((call) => call.id === input.id);
    if (row?.state !== 'waiting') return saved;
    const { transcriber, python } = await sendGateOptions();
    return { ...saved, ...(await prepareCall({ home: hikyakuDirectory(), id: input.id, transcriber, python })) };
  });
  // The picker under a call (refile.js): put it under a workstream, or move it, retiring what it left on the old card.
  handleSecure('hikyaku:file-call', async (id, workstream, source = 'other') => {
    const input = validateFileCall(id, workstream);
    const { refileCall } = await import('../src/hikyaku/refile.js');
    const result = await refileCall({ home: hikyakuDirectory(), core: coreClient, ...input, workstreams: await readWorkstreams(hikyakuDirectory()) });
    // The bet counts how soon after a call ends it is filed, and from where (numbers only).
    const ended = await callEndedAt(input.id).catch(() => null);
    logUiAct({ act: 'call-file', call: input.id, from: result.from || null, to: result.to, source: fileSource(source), minutesSinceEnd: ended === null ? null : Math.max(0, Math.round((Date.now() - ended) / 60000)) });
    // A call moved to another card retires and makes moves: both tabs reload, and the new ones may be ranked.
    filedMoves(result);
    sayChanged();
    return result;
  });
  // Summarize (the one button on a call, loggie-one-click-summarize): the press is the yes. The call's waiting send, or
  // a fresh screen with the newest notes and transcript fixes, goes to the AI picked before (else Nebius) and is filed
  // as a click's yes is (names check and errands included). The AI is asked again, never answered from the saved copy.
  handleSecure('hikyaku:summarize', async (id) => {
    const { summarizeCall } = await import('../src/hikyaku/call-notes.js');
    const { options } = await decideGateOptions();
    logUiAct({ act: 'call-summarize', call: id });
    return summarizeCall({ ...options, id: validateCallId(id) });
  });
  // The first click on a point not confirmed, for notes written before explanations existed (send-gate.js explainCall):
  // one request for every such point in the call, once at a time per call.
  const explaining = new Map();
  handleSecure('hikyaku:explain-call', async (id) => {
    const call = validateCallId(id);
    if (!explaining.has(call)) {
      const { transcriber, python } = await sendGateOptions();
      explaining.set(call, (async () => (await import('../src/hikyaku/send-gate.js')).explainCall({ home: hikyakuDirectory(), id: call, transcriber, python }))().finally(() => explaining.delete(call)));
      logUiAct({ act: 'note-explain', call });
    }
    return explaining.get(call);
  });
  // Your answer on a point Loggie could not confirm (note-marks.js): "right", "fix" with your words, or "undo".
  handleSecure('hikyaku:note-line', async (id, text, action, value) => {
    const result = await (await import('../src/hikyaku/note-marks.js')).markLine({ home: hikyakuDirectory(), id: validateCallId(id), text, action, value });
    logUiAct({ act: `note-${action}`, call: id });
    return result;
  });
  // The rail's search box: every call's transcript, title, notes and summary (call-list.js searchCalls).
  handleSecure('hikyaku:search-calls', async (query) => {
    if (typeof query !== 'string' || query.length > 200) throw new Error('A search is at most 200 characters.');
    return (await import('../src/hikyaku/call-list.js')).searchCalls({ home: hikyakuDirectory(), query });
  });
  // One edited line of a call's transcript (transcript-edit.js). A call already waiting for the yes is screened again,
  // so the pending send carries the edit and the yes covers it (as with typed notes).
  handleSecure('hikyaku:transcript-line', async (id, index, text) => {
    const call = validateCallId(id);
    const { editLine } = await import('../src/hikyaku/transcript-edit.js');
    const result = await editLine({ home: hikyakuDirectory(), id: call, index, text });
    if (result.changed) logUiAct({ act: 'transcript-edit', call });
    const row = (await (await import('../src/hikyaku/call-list.js')).listCalls({ home: hikyakuDirectory() })).find((item) => item.id === call);
    if (!result.changed || row?.state !== 'waiting') return result;
    const { prepareCall } = await import('../src/hikyaku/call-notes.js');
    const { transcriber, python } = await sendGateOptions();
    return { ...result, ...(await prepareCall({ home: hikyakuDirectory(), id: call, transcriber, python })) };
  });
  // A call's title, edited in place on its page, recording or done (meetings-granola-proposal c 2A, 2026-10-27); `choice`
  // is one of the meetings under it ({ id, start }): main reads that event itself, and them.py decides again on its invite.
  handleSecure('hikyaku:call-title', async (id, title, choice = null) => {
    const call = validateCallId(id);
    const picked = validateTitleChoice(choice);
    const meeting = picked ? await meetingOf(picked) : null;
    const { transcriber, python } = await sendGateOptions();
    const result = await (await import('../src/hikyaku/call-notes.js')).renameCall({ home: hikyakuDirectory(), id: call, title: meeting ? meeting.title : validateRecordTitle(title), meeting, transcriber, python });
    logUiAct({ act: 'call-rename', call, from: meeting ? 'meeting' : 'typed' });
    return result;
  });
  // The meetings near a call's time, the one-click choices under its title: title, start, id and a count, never names.
  handleSecure('hikyaku:call-meetings', async (id) => {
    const call = validateCallId(id);
    if (calendarState === 'denied') return [];
    const { callTimeOf, nearbyMeetings } = await import('../src/hikyaku/call-notes.js');
    const { readFile } = await import('node:fs/promises');
    const event = JSON.parse(await readFile(join(callsHome(), call, 'event.json'), 'utf8').catch(() => '{}'));
    const at = callTimeOf(call, event);
    if (!Number.isFinite(at)) return [];
    return nearbyMeetings(await listEvents({ from: new Date(at - 3600e3), days: 1 }), { at, title: event.title || '' });
  });
  // Who Them was, his pick under the heading (them.py pick): relabels the call and is remembered for that person.
  handleSecure('hikyaku:them-name', async (id, name) => {
    const call = validateCallId(id);
    const { transcriber, python } = await sendGateOptions();
    const result = await (await import('../src/hikyaku/call-notes.js')).nameThem({ home: hikyakuDirectory(), id: call, name: validateRecordTitle(name), transcriber, python });
    logUiAct({ act: 'them-name', call });
    return result;
  });
  // A suggestion on an unclear word (name-check.js): ✓ uses it everywhere in the call and teaches my-words.txt, ✕ keeps
  // the heard spelling, Undo takes ✓ back.
  handleSecure('hikyaku:name-accept', async (id, heard) => {
    const input = validateNameWord(id, heard);
    const result = await (await import('../src/hikyaku/name-check.js')).acceptName({ home: hikyakuDirectory(), ...input });
    logUiAct({ act: 'name-accept', call: input.id });
    return result;
  });
  handleSecure('hikyaku:name-keep', async (id, heard) => {
    const input = validateNameWord(id, heard);
    const result = await (await import('../src/hikyaku/name-check.js')).keepName({ home: hikyakuDirectory(), ...input });
    logUiAct({ act: 'name-keep', call: input.id });
    return result;
  });
  handleSecure('hikyaku:name-undo', async (id, heard) => (await import('../src/hikyaku/name-check.js')).undoName({ home: hikyakuDirectory(), ...validateNameWord(id, heard) }));
  handleSecure('hikyaku:call-live', async (id) => (await import('../src/hikyaku/call-list.js')).liveTranscript({ home: hikyakuDirectory(), id: validateCallId(id) }));
  handleSecure('hikyaku:call', async (id) => {
    const { callDetail } = await import('../src/hikyaku/call-list.js');
    return callDetail({ home: hikyakuDirectory(), id: validateCallId(id), tasks: await coreClient.listTasks(), retired: await readRetired(hikyakuDirectory()) });
  });
}
