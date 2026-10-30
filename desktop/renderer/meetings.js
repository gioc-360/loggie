// The Notes & Meetings tab (loggie-meetings-tab, spec b; redesigned for focus in loggie-meetings-focus). Three places:
// Day (home: one card, quiet rows; meetings-day.js), Recordings (every call by day, a "to file" filter), and one
// recording open: its next steps, its summary by section, and its transcript. Yellow means Loggie is not sure of a
// line, and nothing else is yellow; a time jumps to the transcript line it came from, which turns green.

import { busy, clock, groupByDay, headerLine, lineIndexAt, matches, metaLine, pickerNames, searchWords } from './meetings-model.js';
import { recordingHelp } from './recording-help.js';
import { icon } from './icons.js';
import { createDayView } from './meetings-day.js';
import { fusenTab, guardDrops, pauseButton, pencil, recordedSeconds, takeDrops } from './recording-controls.js';
import { chipNode, payoffNode, pickerNode } from './meetings-row.js';
import { CALL_BUSY, menuFor } from './context-menu-model.js';
import { registerMenu } from './context-menu.js';

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const plainOf = (text) => String(text || '').replace(/\s+\(unclear\)/g, '');
// Text with every searched word wrapped in a mark: underlined and bold, no new color (yellow and green are taken).
function highlighted(text, query, words = searchWords(query)) {
  const out = document.createDocumentFragment();
  const source = String(text || '');
  if (!words.length) { out.append(source); return out; }
  const re = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let last = 0;
  for (const m of source.matchAll(re)) {
    out.append(source.slice(last, m.index));
    const mark = document.createElement('mark');
    mark.className = 'mt-found';
    mark.textContent = m[0];
    out.append(mark);
    last = m.index + m[0].length;
  }
  out.append(source.slice(last));
  return out;
}
// The words around the first match in a long line, so the rail shows why the call matched.
function snippet(text, query) {
  const source = String(text || '');
  const first = Math.max(0, Math.min(...searchWords(query).map((word) => { const at = source.toLowerCase().indexOf(word); return at < 0 ? Infinity : at; })));
  if (source.length <= 90 || !Number.isFinite(first)) return source.slice(0, 90);
  const start = Math.max(0, first - 30);
  return `${start ? '…' : ''}${source.slice(start, start + 90).trim()}…`;
}
const button = (text, onClick, className = '') => {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
};

// onRecording(on): the tab's red dot.
// workstreams(): the cards the panel last loaded, for the picker's names.
export function createMeetingsView({ root, api, onRecording = () => {}, workstreams = () => [], isVisible = () => !root.hidden }) {
  // view: 'day' (home), 'recordings' (every call) or 'call' (one call's notes and transcript); from: where Back and Esc
  // in the search return to. filter: 'all' or 'tofile' on Recordings (the tab's old badge, as a filter: TC2).
  // picking: the recording whose picker is open on Recordings; payoff: what filing did, by recording (cycle 2).
  const state = { view: 'day', from: 'day', filter: 'all', picking: null, payoff: new Map(), calls: [], details: new Map(), selected: null, sub: 'notes', query: '', hit: null, error: '', starting: false, notice: '', recovery: null, resummarizing: null, found: null, find: '', findAt: 0, asking: null, fixing: null, exact: false, dating: null, told: null };
  // "Exact words" on the Transcript page: the words as said, filler and "(unclear)" marks and all; off by default.
  try { state.exact = localStorage.getItem('loggie.exactWords') === '1'; } catch { state.exact = false; }
  const shownSaid = (line) => (state.exact ? line.raw ?? line.text : line.text);
  // What each call has already drawn, so only new lines ease in (a draft line, a live transcript turn), and the state
  // it was in, so the checked notes settle in once when the draft is done.
  const drawnDraft = new Map();
  const drawnTurns = new Map();
  const lastState = new Map();
  // A transcript line being fixed, or the title being renamed: polls never redraw under the caret.
  const editing = () => Boolean(document.activeElement?.closest?.('.mt-said-text.is-editing, .mt-title-wrap'));
  // The meetings near each call's time, the choices under its title, read once per call (main reads the calendar).
  const nearby = new Map();
  let timer = null;
  let ticker = null;
  let shownId = null;
  // One notes box per call, kept across redraws so a poll never takes the caret away mid-sentence.
  const notesBoxes = new Map();
  const typing = () => [...notesBoxes.values()].includes(document.activeElement);
  // A box whose save is still waiting out its 600 ms, by call: Summarize saves it first, and no redraw puts the older
  // notes back over it (Codex review, 2026-10-23: notes typed, then Summarize at once, were erased and left out).
  const notesWaiting = new Map();
  const flushNotes = async (id) => { await notesWaiting.get(id)?.(); };

  root.replaceChildren();
  // The top row on every place: Day | Recordings (or, on a recording, the way back), Search, and Record.
  const top = el('div', 'mt-top');
  const views = el('div', 'mt-views');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Show');
  const dayButton = button('Day', () => showPlace('day'), 'mt-view');
  const recordingsButton = button('Recordings', () => showPlace('recordings'), 'mt-view');
  views.append(dayButton, recordingsButton);
  const back = button('', () => showPlace(state.from), 'mt-back');
  guardDrops(document);
  const day = createDayView({
    api,
    calls: () => state.calls,
    names: (guess) => [...new Set(pickerNames(workstreams(), guess))],
    onOpenCall: (id) => showCall(id),
    onRecord: (title, source, workspace, eventId, alsoEventId) => startRecording(title, source, workspace, eventId, alsoEventId),
    onStop: (id) => stopRecording(id),
    onChanged: (error) => recordingChanged(error),
    onSummarize: async (id) => { await showCall(id); await summarizeNow(id); },
    onFile: async (id, name, source) => fileUnder(state.calls.find((call) => call.id === id) || { id, workstream: null }, name, source),
    onOpenWorkspace: (name) => openWorkspace(name),
    onFileEvent: (item, name) => api.fileEvent(item.id, item.start, name),
    // New workspace… on a meeting with no recording (first-run-polish B3.3): only the meeting's id, start and the name.
    onNewWorkspace: (item, name) => api.workspaceFromEvent(item.id, item.start, name),
  });
  const rail = el('section', 'mt-rail');
  rail.setAttribute('aria-label', 'Recordings');
  const railTop = el('div', 'mt-rail-top');
  const search = el('input', 'mt-search');
  search.type = 'search';
  search.placeholder = 'Search';
  search.setAttribute('aria-label', 'Search meetings');
  // The search box looks through every call's transcript too (call-list.js searchCalls): a call matches on its title,
  // workstream, notes or summary, or on a line said in it, which shows under its title with the words marked.
  let searching = null;
  search.addEventListener('input', () => {
    state.query = search.value;
    // Typing anywhere shows Recordings, the results; clearing the box goes back to where it began.
    if (state.query && state.view !== 'recordings') { state.from = state.view === 'call' ? state.from : state.view; state.view = 'recordings'; applyView(); }
    if (!state.query && state.from !== 'recordings' && state.view === 'recordings') { state.view = state.from; applyView(); }
    clearTimeout(searching);
    if (!searchWords(state.query).length) { state.found = null; drawList(); return; }
    drawList();
    searching = setTimeout(async () => {
      const asked = state.query;
      try { const found = await api.searchCalls(asked); if (asked === state.query) { state.found = new Map(found.map((item) => [item.id, item])); drawList(); } }
      catch (error) { state.notice = error.message; drawRecord(); }
    }, 150);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault();
    event.stopPropagation();
    search.value = '';
    search.dispatchEvent(new Event('input'));
  });
  const recordSlot = el('div', 'mt-record-slot');
  top.append(views, back, search, recordSlot);
  // Recordings' filter: every recording, or only the ones in no workspace yet (the old tab badge, TC2).
  const filters = el('div', 'mt-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter recordings');
  railTop.append(filters);
  const list = el('div', 'mt-list');
  rail.append(railTop, list);
  const canvas = el('section', 'mt-canvas');
  // A file dropped on an open call's page is tucked into that call (loggie-pages-anytime).
  takeDrops(canvas, () => (state.view === 'call' ? state.details.get(state.selected) : null), { api, where: 'page', onDone: (error, id) => pageAdded(id, error) });
  canvas.setAttribute('aria-label', 'Meeting');
  root.append(top, day.node, rail, canvas);
  let built = false;   // drawRecord reads state set up below; the first applyView runs before it is
  function applyView() {
    const call = state.view === 'call';
    root.dataset.view = state.view;
    views.hidden = call;
    back.hidden = !call;
    back.replaceChildren(icon('back'), state.from === 'recordings' ? 'Recordings' : 'Day');
    dayButton.setAttribute('aria-pressed', String(state.view === 'day'));
    recordingsButton.setAttribute('aria-pressed', String(state.view === 'recordings'));
    day.node.hidden = state.view !== 'day';
    rail.hidden = state.view !== 'recordings';
    canvas.hidden = !call;
    if (built) drawRecord();
  }
  applyView();
  async function showCall(id) {
    if (!id) return;
    if (state.view !== 'call') state.from = state.view;
    state.view = 'call';
    applyView();
    await open(id);
    root.scrollTop = 0;
  }
  function showPlace(place) {
    state.view = place;
    if (place === 'day') day.load();
    applyView();
    drawList();
  }

  async function load() {
    try {
      state.calls = await api.calls();
      state.error = '';
    } catch (error) { state.error = error.message; }
    if (state.view === 'day' && isVisible()) day.load();
    if (!state.selected || !state.calls.some((call) => call.id === state.selected)) state.selected = state.calls.find((call) => call.state !== 'empty')?.id || state.calls[0]?.id || null;
    drawRecord();
    drawList();
    if (state.selected) await open(state.selected, { keepSub: true });
    else drawCanvas();
    schedule();
  }

  const recordingCall = () => state.calls.find((call) => call.state === 'recording') || null;

  // The top row's end: Record (a call with no meeting on the calendar), or while a call records, its clock and Stop.
  // On Day the card is the recording strip, so the top row stays quiet there.
  function drawRecord() {
    const live = recordingCall();
    onRecording(Boolean(live));
    clearInterval(ticker);
    if (live && state.view === 'day') { recordSlot.replaceChildren(); return; }
    if (!live) {
      const record = button('', () => startRecording(null, 'top'), 'mt-record');
      record.append(pencil(false, { still: true }), 'Record');
      record.disabled = state.starting;
      recordSlot.replaceChildren(record);
      if (state.notice) {
        const help = el('div', 'mt-record-help');
        help.setAttribute('role', 'alert');
        help.append(el('p', 'mt-notice', state.notice));
        if (state.recovery?.permission) help.append(button('Open Settings', async () => {
          try { await api.openPermissionSettings(state.recovery.permission); }
          catch (error) { state.notice = error.message; drawRecord(); }
        }, 'mt-record'));
        if (state.recovery?.detail) {
          const details = el('details'); details.append(el('summary', '', 'Technical details'), el('p', '', state.recovery.detail)); help.append(details);
        }
        recordSlot.append(help);
      }
      return;
    }
    const bar = el('div', `mt-recording${live.paused ? ' is-paused' : ''}`);
    const clockText = el('span', 'mt-clock', '00:00');
    const tick = () => { clockText.textContent = clock(recordedSeconds(live)); };
    tick();
    if (!live.paused) ticker = setInterval(tick, 1000);
    const stop = button('', () => stopRecording(live.id), 'mt-stop');
    stop.setAttribute('aria-label', 'Stop and write it up');
    stop.title = 'Stop and write it up';
    stop.append(el('i'));
    bar.append(pencil(live.paused, { still: state.view === 'day' }), clockText, fusenTab(live, { api, className: 'mt-fusen', onDone: recordingChanged, where: 'strip' }), pauseButton(live, { api, className: 'mt-pause', onDone: recordingChanged }), stop);
    bar.addEventListener('click', (event) => { if (event.target === bar) showCall(live.id); });
    recordSlot.replaceChildren(bar);
  }

  // Record from the Day card or a row (the meeting's own title) or the top row ("Meeting 7:21 PM"). A started call
  // opens on its notes, the box focused (TC2: "The notes page"); `source` goes to ui-acts for the bet. The card and a
  // row pass their event's id, so the meeting pressed is the one recorded (2026-10-27).
  // Record both (2026-10-28) passes the second meeting's id as alsoEventId; `eventId` is then the one in the room.
  async function startRecording(title = null, source = 'top', workspace = null, eventId = null, alsoEventId = null) {
    state.starting = true;
    state.recovery = null;
    state.notice = '';
    drawRecord();
    let started = null;
    try {
      const named = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const result = await api.recordStart(named || `Meeting ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`, source, workspace, eventId, alsoEventId);
      if (result?.blocked) { state.recovery = recordingHelp(result); state.notice = state.recovery.message; }
      if (result?.call) { state.selected = result.call; started = result.call; }
    } catch (error) { state.recovery = recordingHelp({ error: error.message }); state.notice = state.recovery.message; }
    state.starting = false;
    if (started) { await showCall(started); return; }
    await load();
  }

  // A pause, resume or page answered (recording-controls.js): the state comes back with the next load; a refusal is the notice.
  async function recordingChanged(error) {
    state.notice = error ? error.message : '';
    await load();
  }

  async function stopRecording(id) {
    try { await api.meetingEnd(id, 'stop'); }
    catch (error) { state.notice = error.message; }
    state.selected = id;
    await load();
  }

  function schedule() {
    clearTimeout(timer);
    // While the notes are being written the page looks often, so a line or two arrives at a time (byo.py writes the
    // draft every 150 ms); otherwise every 2 s while anything moves.
    const writing = state.calls.some((call) => call.state === 'writing');
    if (busy(state.calls) && isVisible()) timer = setTimeout(load, writing ? 600 : 2000);
  }

  // The Workspaces tab, opened on one workspace (the result line's "Open the workspace").
  function openWorkspace(name) {
    document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'workspaces', workspace: name } }));
  }

  function drawList() {
    // The picker is drawn from state.picking, so the 2 s reload while a call records redraws it in place (2026-10-23).
    const toFile = state.calls.filter((call) => call.state === 'done' && !call.workstream && !call.noWorkspace);
    const all = button(`All · ${state.calls.length}`, () => { state.filter = 'all'; drawList(); }, 'mt-filter');
    all.setAttribute('aria-pressed', String(state.filter === 'all'));
    const unfiled = button(`${toFile.length} to file`, () => { state.filter = 'tofile'; drawList(); }, 'mt-filter');
    unfiled.setAttribute('aria-pressed', String(state.filter === 'tofile'));
    filters.replaceChildren(all, ...(toFile.length || state.filter === 'tofile' ? [unfiled] : []));
    const pool = state.filter === 'tofile' ? toFile : state.calls;
    const shown = pool.filter((call) => matches(call, state.query, state.details.get(call.id)) || state.found?.has(call.id));
    const parts = [];
    if (state.error) parts.push(el('p', 'mt-empty', state.error));
    for (const group of groupByDay(shown)) {
      parts.push(el('h3', 'mt-day', group.day));
      for (const call of group.calls) parts.push(row(call));
    }
    if (!shown.length && !state.error) parts.push(el('p', 'mt-empty', state.query ? 'Nothing matches.' : state.filter === 'tofile' ? 'Every recording is in a workspace.' : 'Your first recording shows here. Press Record on a meeting.'));
    list.replaceChildren(...parts);
  }

  // A recording on Recordings: the same row as the Day's (time, title and minutes, the shared chip; meetings-row.js),
  // and under it the open picker or what filing did.
  function row(call) {
    const item = el('div', 'mt-item');
    item.dataset.call = call.id;
    item.setAttribute('aria-current', String(call.id === state.selected));
    const found = state.query ? state.found?.get(call.id) : null;
    // A call found by what was said opens on its transcript, at the first line that says it.
    const openButton = button('', async () => {
      await showCall(call.id);
      if (!found?.count) return;
      state.sub = 'transcript';
      setFind(state.query);
      drawCanvas();
    }, 'mt-item-open');
    const time = call.start ? new Date(call.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    const title = el('span', 'mt-item-title', call.title);
    const meta = metaLine(call).replace(`${time} · `, '').replace(time, '');
    if (meta) title.append(el('span', 'mt-item-meta', ` · ${meta}`));
    openButton.append(title);
    if (found?.count) {
      const hit = el('span', 'mt-item-hit');
      hit.append(el('span', 'mt-at', clock(found.hits[0].at)), ' ', highlighted(snippet(found.hits[0].text, state.query), state.query));
      if (found.count > 1) hit.append(el('span', 'mt-hit-more', ` +${found.count - 1}`));
      openButton.append(hit);
    }
    item.append(el('span', 'mt-item-time', time), openButton);
    const result = state.payoff.get(call.id);
    if (call.state !== 'recording' && !result) {
      item.append(chipNode(call, { loud: true, open: state.picking === call.id, onPress: () => { state.picking = state.picking === call.id ? null : call.id; drawList(); } }));
    }
    if (state.picking === call.id) {
      item.append(pickerNode({ names: [...new Set(pickerNames(workstreams(), call.workstream ? null : call.guess))], workstream: call.workstream, guess: call.guess, evidence: call.evidence,
        noWorkspace: call.noWorkspace, onPick: (name) => fileUnder(call, name, 'recordings'), onNone: () => fileUnder(call, null, 'recordings'), onCancel: () => { state.picking = null; drawList(); } }));
    } else if (result) item.append(payoffNode(result, { onOpenWorkspace: openWorkspace }));
    if (state.told?.id === call.id && state.view !== 'call') { const said = el('p', 'mt-shared mt-item-told', state.told.text); said.setAttribute('role', 'status'); item.append(said); }
    return item;
  }

  // File one recording, from wherever it was pressed (`source` for the bet); returns what filing did, which the row or
  // card shows in the chip's place (payoff).
  async function fileUnder(call, name, source = 'recordings') {
    state.picking = null;
    // `name` null is "No workspace" (refile.js): nothing to do when the call is already there.
    if (name === null ? !call.workstream && call.noWorkspace : name === call.workstream) { drawList(); return null; }
    let result = null;
    try {
      result = await api.fileCall(call.id, name, source);
      if (name !== null && !call.workstream && call.guessItem) await api.answerAsk(call.guessItem, name).catch(() => null);
      if (result?.to || result?.none) state.payoff.set(call.id, result);
      state.notice = '';
    } catch (error) { state.notice = error.message; }
    await load();
    return result;
  }
  const closePicker = () => { if (state.picking) { state.picking = null; drawList(); } };
  root.addEventListener('click', (event) => {
    if (!event.target.isConnected) return;
    if (!event.target.closest('.mr-picker, .mr-chip')) closePicker();
  });
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closePicker(); closeNamePop(); if (state.asking) { state.asking = null; state.fixing = null; drawCanvas(); } } });
  root.addEventListener('click', (event) => { if (state.asking && event.target.isConnected && !event.target.closest('.mt-ask-pop, .mt-row.is-source')) { state.asking = null; state.fixing = null; drawCanvas(); } });
  root.addEventListener('click', (event) => { if (event.target.isConnected && !event.target.closest('.mt-name-pop, .mt-unclear.has')) closeNamePop(); });

  async function open(id, { keepSub = false } = {}) {
    // Another call opens at its top; the same call redrawn by a poll keeps where the user scrolled.
    const other = id !== shownId;
    shownId = id;
    state.selected = id;
    if (!keepSub) { state.sub = 'notes'; state.hit = null; if (other) setFind(''); }
    if (other) { state.asking = null; state.fixing = null; state.dating = null; }
    // The list is read on every poll, so its state (recording, waiting for the yes, ...) is the newer one.
    const row = state.calls.find((call) => call.id === id);
    const moving = row ? { state: row.state, run: row.run, reason: row.reason, since: row.since } : {};
    try { state.details.set(id, { ...(await api.call(id)), ...moving }); }
    catch (error) { state.details.set(id, { ...state.calls.find((call) => call.id === id), error: error.message, sections: [], steps: [], transcript: [] }); }
    drawList();
    if (!(typing() && notesBoxes.get(id) === document.activeElement) && !editing() && document.activeElement !== findBox && !document.activeElement?.classList.contains('mt-ask-fix')) drawCanvas();
    if (other) canvas.scrollTop = 0;
    // Logged when another call opens, not on every 2 s refresh of the same one (2026-10-26: 40,116 rows on his Mac).
    if (other) api.uiAct?.({ act: 'call-open' });
  }

  // While the open call records and its transcript is in front of the user, the page reads the live transcript alone
  // every LIVE_MS (one small file, hikyaku:call-live) and patches only the lines that changed: the words stream in about
  // a second behind the voices (proposal-live-stream.md), while the full reload stays at its 2 s pace.
  const LIVE_MS = 300;
  let liveTimer = null;
  function scheduleLive() {
    clearTimeout(liveTimer);
    const call = state.details.get(state.selected);
    if (call?.state === 'recording' && state.sub === 'transcript' && isVisible() && api.callLive) liveTimer = setTimeout(pollLive, LIVE_MS);
  }
  async function pollLive() {
    const id = state.selected;
    try {
      const live = await api.callLive(id);
      const call = state.details.get(id);
      if (live && call && id === state.selected && call.state === 'recording') patchTranscript(call, live.transcript);
    } catch { /* the 2 s reload shows any error */ }
    scheduleLive();
  }
  // New turns ease in; a turn that grew or was settled by the 30 s reader changes in place, a find's matches marked as
  // the full draw marks them. Never under the caret (that waits for the 2 s redraw).
  function patchTranscript(call, turns) {
    const same = (a, b) => a && b && a.at === b.at && a.who === b.who && a.raw === b.raw;
    let from = 0;
    while (from < turns.length && same(turns[from], call.transcript[from])) from += 1;
    if (from === turns.length && turns.length === call.transcript.length) return;
    call.transcript = turns; call.transcriptLive = true;
    const ol = canvas.querySelector('ol.mt-said');
    if (!ol || editing() || typing() || document.activeElement === findBox) { if (!ol && !editing() && !typing()) drawCanvas(); return; }
    const hits = findHits(call);
    const following = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 80;
    const before = drawnTurns.get(call.id) ?? call.transcript.length;
    drawnTurns.set(call.id, turns.length);
    while (ol.children.length > turns.length) ol.lastElementChild.remove();
    for (let index = from; index < turns.length; index += 1) {
      const li = saidItem(call, turns[index], index, hits, before);
      if (ol.children[index]) ol.children[index].replaceWith(li); else ol.append(li);
    }
    if (following) canvas.scrollTo({ top: canvas.scrollHeight, behavior: 'auto' });
  }

  // A page tucked into an open call: its row and page load again; a refusal is the notice.
  async function pageAdded(id, error) {
    state.notice = error ? error.message : '';
    state.details.delete(id);
    await load();
    if (state.selected === id) await showCall(id);
  }

  function drawCanvas() {
    const call = state.details.get(state.selected);
    scheduleLive();
    if (!call) { canvas.replaceChildren(el('p', 'mt-empty', 'No calls yet.')); return; }
    const head = el('header', 'mt-head');
    const titles = el('div', 'mt-titles');
    titles.append(titleField(call), el('p', 'mt-meta', headerLine(call)));
    const who = themLine(call);
    if (who) titles.append(who);
    // Its pages by name (loggie-pages-anytime); the fusen tab and a drop anywhere on the call add one. While it records
    // the top strip carries the tab, so the head does not show a second one.
    if (call.pages?.length) titles.append(el('p', 'mt-pages', call.pages.join(' · ')));
    const seg = el('div', 'mt-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'View');
    for (const [sub, label] of [['notes', 'Notes'], ['transcript', 'Transcript']]) {
      const b = button(label, () => { state.sub = sub; drawCanvas(); }, 'mt-seg-button');
      b.dataset.sub = sub;
      b.setAttribute('aria-pressed', String(state.sub === sub));
      seg.append(b);
    }
    head.append(titles, seg);
    const again = againButton(call);
    if (again) head.append(again);
    const copy = copyButton(call);
    if (copy) head.append(copy);
    const share = shareButton(call);
    if (share) head.append(share);
    if (call.state !== 'recording') head.append(fusenTab(call, { api, className: 'mt-fusen mt-icon-act', onDone: (error) => pageAdded(call.id, error), where: 'page' }));
    // A live transcript follows its newest line, unless the user scrolled up to read.
    const following = state.sub === 'transcript' && call.transcriptLive && canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 80;
    const body = state.sub === 'transcript' ? transcriptView(call) : notesView(call);
    canvas.replaceChildren(head, body, footOf(call));
    if (following) canvas.scrollTo({ top: canvas.scrollHeight, behavior: calm() ? 'auto' : 'smooth' });
    lastState.set(call.id, call.state);
    if (toastBar) canvas.append(toastBar);
    if (state.sub === 'transcript' && state.hit != null) canvas.querySelector('.mt-line.is-hit')?.scrollIntoView({ block: 'center' });
  }

  // The title is his to rename on every call, recording or done (meetings-granola-proposal c 2A, 2026-10-27; Gio chose
  // the title itself over a button): it looks editable on hover and focus, Enter saves, Escape puts it back, leaving it
  // saves. While it is being edited, the meetings near the call's time are one-click choices under it: a choice names
  // the call after that meeting and makes it the call's event. No motion: the choices are there or not.
  function titleField(call) {
    const wrap = el('div', 'mt-title-wrap');
    const heading = el('h2', 'mt-title is-editable', call.title);
    heading.contentEditable = 'plaintext-only';
    heading.setAttribute('role', 'textbox');
    heading.setAttribute('aria-label', 'Call title');
    heading.dataset.tip = 'Click to rename';
    const choices = el('div', 'mt-title-choices');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', 'Name it after a meeting');
    choices.hidden = true;
    let done = false;
    const save = async (title, choice = null) => {
      if (done) return;
      done = true;
      choices.hidden = true;
      // The caret leaves the title, so the reload after the save may redraw the page (a choice keeps it there until now).
      if (document.activeElement === heading) heading.blur();
      if (!title || (title === call.title && !choice)) { heading.textContent = call.title; return; }
      try { const saved = await api.callTitle(call.id, title, choice); call.title = saved?.title || title; state.notice = ''; } catch (error) { heading.textContent = call.title; state.notice = error.message; }
      await load();
    };
    const typed = () => heading.textContent.replace(/\s+/g, ' ').trim();
    const drawChoices = (list) => {
      if (!list?.length || document.activeElement !== heading && !wrap.contains(document.activeElement)) return;
      choices.replaceChildren(el('span', 'mt-title-hint', 'Or the meeting it was:'), ...list.map((meeting) => {
        const at = new Date(meeting.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const pick = button(`${meeting.title} · ${at}`, () => save(meeting.title, { id: meeting.id, start: meeting.start }), 'mt-link mt-title-choice');
        pick.dataset.event = meeting.id;
        pick.addEventListener('mousedown', (event) => event.preventDefault());   // the caret stays in the title until the click lands
        return pick;
      }));
      choices.hidden = false;
    };
    heading.addEventListener('focus', async () => {
      done = false;
      if (!nearby.has(call.id)) nearby.set(call.id, api.callMeetings ? api.callMeetings(call.id).catch(() => []) : Promise.resolve([]));
      drawChoices(await nearby.get(call.id));
    });
    heading.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); save(typed()); heading.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done = true; heading.textContent = call.title; choices.hidden = true; heading.blur(); }
    });
    // Leaving the title saves it, unless the caret went to one of the choices under it.
    wrap.addEventListener('focusout', (event) => { if (!wrap.contains(event.relatedTarget)) save(typed()); });
    wrap.append(heading, choices);
    return wrap;
  }

  // Who Them was, when Loggie was not sure (them.py at Stop): a quiet line under the heading with at most three names,
  // one press each, and "someone else" to type one. The press relabels the call on this Mac and is remembered.
  function themLine(call) {
    const them = call.them;
    if (!them || ['recording', 'transcribing'].includes(call.state)) return null;
    const line = el('p', 'mt-them');
    const name = async (who) => {
      try { await api.themName(call.id, who); state.notice = ''; } catch (error) { state.notice = error.message; }
      await load();
    };
    if (state.naming === call.id) {
      const box = el('input', 'mt-them-box');
      box.type = 'text';
      box.maxLength = 80;
      box.setAttribute('aria-label', 'Who was this');
      box.placeholder = 'Their name';
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && box.value.trim()) { event.preventDefault(); state.naming = null; name(box.value.trim()); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.naming = null; drawCanvas(); }
      });
      line.append(el('span', 'mt-them-ask', 'Who was this?'), box);
      queueMicrotask(() => box.focus());
      return line;
    }
    line.append(el('span', 'mt-them-ask', them.invite && them.choices.length <= 1 ? `Them (invite: ${them.invite}?)` : 'Who was this?'));
    for (const who of them.choices) line.append(button(who, () => name(who), 'mt-link mt-them-pick'));
    line.append(button('someone else', () => { state.naming = call.id; drawCanvas(); }, 'mt-link mt-them-pick is-other'));
    return line;
  }

  // Summarize, on every call that has a transcript (Gio, 2026-10-12: "have a re-summarize button"; 2026-10-23: "it should
  // be a one click summarize notes"). The press is the yes (main-ipc-meetings.js hikyaku:summarize): a waiting call's
  // send, or a fresh screen with your notes and transcript fixes, goes to the AI you picked before. It stands out when
  // the call has no notes yet or your fixes are newer than them.
  // The Summarize press itself, shared by the call page and the Day card (one action, one path: the Day card used to
  // click the call page's button through the page, and did nothing when it was disabled).
  async function summarizeNow(id) {
    if (state.resummarizing === id) return;
    state.resummarizing = id;
    state.notice = '';
    drawCanvas();
    try {
      // Notes typed a moment ago are saved first, so main sees they are newer than the waiting send and screens again.
      await flushNotes(id);
      const result = await api.summarize(id);
      if (result?.picker) state.notice = 'No cloud AI is connected. Add a key in Settings, then press Summarize.';
    } catch (error) { state.notice = error.message; }
    state.resummarizing = null;
    await load();
  }

  // The call page's actions as icons (loggie-pause-attach, Gio: "i want these as icons as well"): the mark is what a
  // press does, its name is the aria-label and the hover label, so a screen reader and a pointer read the same words.
  function iconButton(name, label, onClick, className) {
    const b = button('', onClick, `${className} mt-icon-act`);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.append(icon(name));
    return b;
  }

  function againButton(call) {
    if (!call.transcript.length || call.transcriptLive || ['recording', 'transcribing'].includes(call.state)) return null;
    const busyNow = state.resummarizing === call.id || call.state === 'writing';
    const stale = call.summarized && (call.notesNewer || call.transcriptNewer || call.pagesNewer);
    const label = state.resummarizing === call.id ? 'Getting it ready' : call.state === 'writing' ? 'Writing' : call.summarized ? 'Summarize again' : 'Summarize';
    const b = iconButton('loggie', label, () => summarizeNow(call.id), `mt-again${(stale || !call.summarized) && !busyNow ? ' is-due' : ''}${busyNow ? ' is-busy' : ''}`);
    b.disabled = busyNow;
    if (stale) b.title = `${label}: your fixes are not in these notes yet`;
    return b;
  }

  // One Copy on a call, for the page it is on (Gio, 2026-10-23: "i want the copy button to be just one and it should change
  // if user is looking at notes or transcript"). Notes: yours, then the summary, then next steps. Transcript: "[mm:ss]
  // Who: words", as the page shows them (Exact words on or off). It says Copied until the next draw; no motion.
  // Notes: yours, then the summary, then next steps. Copy notes and the menu's Copy notes both copy this (copyNotes).
  const notesText = (call) => [notesBoxes.get(call.id)?.value || call.notes || '', ...(call.sections || []).map((s) => [`${s.heading}`, ...s.lines.map((l) => `- ${l.text}`)].join('\n')),
    call.steps?.length ? ['Next steps', ...call.steps.map((s) => `- ${s.text}${s.mine ? '' : ` (${s.who || s.owner})`}`)].join('\n') : ''].filter(Boolean).join('\n\n');
  // Notices draw at the top (drawRecord), not on the canvas: a failed copy redrew the canvas and said nothing (Codex
  // review, 2026-10-23). Only a copy that happened is logged. True when it copied.
  async function copyText(text, act) {
    try {
      await navigator.clipboard.writeText(text);
      if (state.notice) { state.notice = ''; drawRecord(); }
      api.uiAct?.({ act });
      return true;
    } catch (error) { state.notice = `Could not copy: ${error.message}`; drawRecord(); return false; }
  }
  // A call's notes to the clipboard, its page loaded first when it is not open (the menu on a row).
  async function copyNotes(id) {
    let call = state.details.get(id);
    if (!call?.sections) {
      try { call = await api.call(id); } catch (error) { state.notice = error.message; drawRecord(); return false; }
    }
    const text = notesText(call);
    if (!text) { state.notice = 'This call has no notes to copy yet.'; drawRecord(); return false; }
    return copyText(text, 'call-copy');
  }
  function copyButton(call) {
    const onTranscript = state.sub === 'transcript';
    if (onTranscript ? !call.transcript.length : !(call.notes || call.sections.length || call.steps.length)) return null;
    const b = iconButton('copy', onTranscript ? 'Copy transcript' : 'Copy notes', async () => {
      const copied = onTranscript ? await copyText(call.transcript.map((line) => `[${clock(line.at)}] ${line.who}: ${shownSaid(line)}`).join('\n'), 'call-copy-transcript') : await copyNotes(call.id);
      // Copied: the mark becomes a check and the name says so, until the next draw; no motion.
      if (copied) { b.replaceChildren(icon('check')); b.setAttribute('aria-label', 'Copied'); b.title = 'Copied'; b.classList.add('is-done'); }
    }, 'mt-copy');
    return b;
  }

  // Share (2026-10-28, Gio: "we have to have an easy share button"): beside Copy, the same family. One press shows the
  // Mac's menu with the two lines Share ▸ holds on a right-click; the pick runs shareCall, the one function both use.
  function shareButton(call) {
    if (!call.sections.length && !call.steps.length) return null;
    return iconButton('share', 'Share', () => shareMenu(call), 'mt-share');
  }
  async function shareMenu(call) {
    let picked = null;
    try { picked = await api.contextMenu({ kind: 'share', target: { id: call.id }, items: menuFor('share') }); }
    catch (error) { state.notice = error.message; drawRecord(); return; }
    if (picked?.id) await shareCall(call, picked.id);
  }
  // how 'people': an unsent email in his mail app to the people on the call (main reads who); 'sheet': the Mac's share
  // sheet. What leaves is the notes as written to disk (call-share.js). What it did is said at the page's foot.
  async function shareCall(call, how) {
    try {
      const result = await api.callShare(call.id, how);
      state.told = result?.line ? { id: call.id, text: result.line } : null;
      if (state.notice) { state.notice = ''; drawRecord(); }
    } catch (error) { state.notice = error.message; drawRecord(); }
    if (state.view === 'call' && state.selected === call.id) drawCanvas();
  }
  // The page's foot: what Share did, still text until the next one, and the quiet Delete recording link, greyed with its
  // reason while anything still owns the call.
  function footOf(call) {
    const foot = el('footer', 'mt-foot');
    const said = el('p', 'mt-shared', state.told?.id === call.id ? state.told.text : '');
    said.setAttribute('role', 'status');
    const busy = CALL_BUSY[call.state];
    const remove = button('Delete recording', () => trashCall(call), 'mt-link is-quiet mt-trash');
    remove.disabled = Boolean(busy);
    foot.append(said, remove);
    if (busy) foot.append(el('span', 'mt-trash-why', `Not now: ${busy}`));
    return foot;
  }
  // Delete recording (2026-10-28, Gio: yes, to the macOS Trash, after a native confirm): main refuses while anything
  // still owns the call, asks the Mac's own confirm, sets it in No workspace, then hands its folder to the Trash
  // (call-trash.js). After it, the row is simply gone.
  async function trashCall(call) {
    let result = null;
    try { result = await api.callTrash(call.id); } catch (error) { state.notice = error.message; drawRecord(); return; }
    if (result?.refused) { state.notice = `Not deleted: ${result.reason}.`; drawRecord(); return; }
    if (!result?.trashed) return;
    state.details.delete(call.id); state.payoff.delete(call.id); notesBoxes.delete(call.id);
    if (state.picking === call.id) state.picking = null;
    if (state.selected === call.id) { state.selected = null; shownId = null; if (state.view === 'call') state.view = state.from === 'call' ? 'recordings' : state.from; }
    state.notice = '';
    applyView();
    await load();
  }
  // Rename from a row: its page, with the caret at the end of the title titleField draws (whose Enter and leaving save).
  async function renameCall(id) {
    await showCall(id);
    const title = canvas.querySelector('.mt-title');
    if (!title) return;
    title.focus();
    const range = document.createRange();
    range.selectNodeContents(title);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
  // Said under a row after a pick that has no other mark there (Copy notes from the menu).
  const tell = (id, text) => { state.told = { id, text }; drawList(); };

  // The right-click on a recording (context-menu.js): a row on Recordings, or the title of the open call when it is
  // not being edited. Each id runs what its visible control runs: the chip and picker (fileUnder), the Share button
  // (shareCall), the row (showCall), Copy notes (copyNotes), the title (renameCall), Delete recording (trashCall).
  const RECORDING_MENU = {
    guess: (call) => fileUnder(call, call.guess, 'menu'),
    file: (call, value) => fileUnder(call, value, 'menu'),
    share: (call, value) => shareCall(call, value),
    open: (call) => showCall(call.id),
    copy: async (call) => { if (await copyNotes(call.id)) tell(call.id, `Copied the notes of ${call.title}`); },
    rename: (call) => renameCall(call.id),
    trash: (call) => trashCall(call),
  };
  const callRow = (id) => state.calls.find((call) => call.id === id) || state.details.get(id) || { id, title: '', state: 'done' };
  registerMenu({
    kind: 'recording',
    find: (node) => {
      if (!root.contains(node)) return null;
      const row = node.closest('.mt-item[data-call]');
      if (row) return row.dataset.call;
      return state.view === 'call' && state.selected && node.closest('.mt-titles') && !node.closest('.mt-them, .mt-title-choices') ? state.selected : null;
    },
    state: (id) => { const call = callRow(id); return { call, names: pickerNames(workstreams(), call.workstream ? null : call.guess) }; },
    run: (id, picked) => RECORDING_MENU[picked.id]?.(callRow(id), picked.value),
    failed: (error) => { state.notice = error.message; drawRecord(); },
  });

  function timeButton(seconds) {
    const b = button(clock(seconds), () => jump(seconds), 'mt-time');
    b.setAttribute('aria-label', `Open the transcript at ${clock(seconds)}`);
    return b;
  }

  function jump(seconds) {
    const call = state.details.get(state.selected);
    state.sub = 'transcript';
    state.asking = null;
    state.hit = lineIndexAt(call?.transcript || [], seconds);
    drawCanvas();
    api.uiAct?.({ act: 'call-jump' });
  }

  // A line's words, with each one the speech readers were unsure of drawn as the name check left it (name-check.js):
  // heard right or kept -> plain; accepted -> the new spelling; a suggestion -> yellow with a dot, opening on a click;
  // a name, or nothing found -> yellow, saying why on hover. A call not checked keeps every one yellow.
  function marked(text, call) {
    const out = document.createDocumentFragment();
    const source = String(text || '');
    const check = call?.nameCheck || null;
    let last = 0;
    for (const m of source.matchAll(/(\S+)\s+\(unclear\)/g)) {
      const raw = m[1];
      const lead = raw.match(/^[^\w&]*/)[0];
      const core = raw.slice(lead.length).replace(/[^\w&']+$/, '');
      const tail = raw.slice(lead.length + core.length);
      const heard = core.replace(/'s$/i, '');
      out.append(source.slice(last, m.index) + lead);
      last = m.index + m[0].length;
      const word = check?.status === 'done' ? check.words?.[heard] : null;
      const accepted = check?.accepted?.[heard];
      // A spelling your own words proved (loggie-auto-spelling): written that way, saying where from; a click offers ✕.
      const auto = !accepted && !check?.kept?.[heard] ? check?.auto?.[heard] : null;
      if (accepted) out.append(core.replace(heard, accepted));
      else if (auto) {
        const span = el('span', 'mt-auto', core.replace(heard, auto.to));
        span.tabIndex = 0;
        span.setAttribute('role', 'button');
        span.title = `Heard as "${heard}" · spelled from ${auto.source}`;
        span.setAttribute('aria-label', `${auto.to}, heard as ${heard}, spelled from ${auto.source}. Open to keep what was heard`);
        const show = (event) => { event.stopPropagation(); openNamePop(span, call, heard, { to: auto.to, source: { label: auto.source } }, true); };
        span.addEventListener('click', show);
        span.addEventListener('keydown', (event) => { if (event.key === 'Enter') show(event); });
        out.append(span);
      }
      else if (check?.kept?.[heard] || word?.kind === 'sure') out.append(core);
      else {
        const span = el('span', 'mt-unclear', core);
        if (word?.kind === 'fix') {
          span.classList.add('has');
          span.tabIndex = 0;
          span.setAttribute('role', 'button');
          span.setAttribute('aria-label', `Loggie is not sure of ${heard}. Open the suggestion`);
          span.dataset.heard = heard;
          span.addEventListener('click', (event) => { event.stopPropagation(); openNamePop(span, call, heard, word); });
          span.addEventListener('keydown', (event) => { if (event.key === 'Enter') openNamePop(span, call, heard, word); });
        } else span.title = word?.kind === 'person' ? 'A name: never searched' : word?.why || (check?.status === 'checking' ? 'Checking' : 'Loggie is not sure of this word');
        out.append(span);
      }
      out.append(tail);
    }
    out.append(source.slice(last));
    return out;
  }

  // The suggestion on one word: what was heard, the fix, where it came from; ✓ uses it everywhere in the call and
  // teaches your words, ✕ keeps what was heard.
  function closeNamePop() { canvas.querySelectorAll('.mt-name-pop').forEach((node) => node.remove()); }
  function openNamePop(anchor, call, heard, word, made = false) {
    closeNamePop();
    const pop = el('div', 'mt-name-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Suggestion for ${heard}`);
    pop.append(el('span', 'mt-name-heard', `Heard as "${heard}"`), el('strong', 'mt-name-to', word.to));
    const src = el('span', 'mt-name-src');
    if (word.source?.url) {
      const link = el('a', '', `${word.source.label} ↗`);
      link.href = word.source.url;
      link.target = '_blank';
      link.rel = 'noopener';
      src.append('Source: ', link);
    } else src.append(`${made ? 'Spelled from' : 'From'} ${word.source?.label || 'your words'}`);
    const acts = el('div', 'mt-name-acts');
    const ok = button('✓', async () => {
      closeNamePop();
      try { await api.nameAccept(call.id, heard); toast(`${word.to} everywhere in this call · added to your words`, () => api.nameUndo(call.id, heard)); }
      catch (error) { state.notice = error.message; drawRecord(); }
      await open(call.id, { keepSub: true });
    }, 'mt-name-ok');
    ok.setAttribute('aria-label', `Use ${word.to}`);
    ok.title = `Use ${word.to} everywhere in this call`;
    const no = button('✕', async () => {
      closeNamePop();
      try { await api.nameKeep(call.id, heard); } catch (error) { state.notice = error.message; drawRecord(); }
      await open(call.id, { keepSub: true });
    }, 'mt-name-no');
    no.setAttribute('aria-label', `Keep ${heard}`);
    no.title = `Keep ${heard}`;
    // A spelling already made has nothing to accept: only ✕, keep what was heard.
    if (made) acts.append(no); else acts.append(ok, no);
    pop.append(src, acts);
    const box = anchor.getBoundingClientRect();
    const host = canvas.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(box.left - host.left, canvas.clientWidth - 288))}px`;
    pop.style.top = `${box.bottom - host.top + canvas.scrollTop + 6}px`;
    canvas.append(pop);
    (made ? no : ok).focus();
  }

  // The toast after a ✓: kept across redraws (drawCanvas puts it back) until Undo or six seconds.
  let toastBar = null;
  function toast(text, undo) {
    toastBar?.remove();
    const bar = el('div', 'mt-toast');
    const gone = () => { bar.remove(); if (toastBar === bar) toastBar = null; };
    bar.setAttribute('role', 'status');
    bar.append(el('span', '', text), button('Undo', async () => { gone(); try { await undo(); } catch (error) { state.notice = error.message; drawRecord(); } await open(state.selected, { keepSub: true }); }, 'mt-toast-undo'));
    toastBar = bar;
    canvas.append(bar);
    setTimeout(gone, 6000);
  }

  function lineItem(line, extra = [], call = state.details.get(state.selected)) {
    const li = el('li', `mt-row${line.detail ? ' is-detail' : ''}`);
    const text = el('span', 'mt-text');
    text.append(marked(line.text, call));
    li.append(text, ...extra);
    if (line.at != null) li.append(timeButton(line.at));
    askable(li, line, call);
    if (line.fixed) li.title = `Your words. The notes said: ${line.original}`;
    return li;
  }

  // Click any point to see where it came from (2026-10-12, Gio, after the rival app's transcript summary: "we need to be
  // better"): a short context from the AI, then the sentences said, each with who and when, the minute opening the
  // transcript there. Every sentence is checked against the transcript (byo.py explain_points); until the AI's part
  // arrives, the line the checker matched is shown. A point Loggie could not confirm is a link rather than a warning (a
  // dashed green underline): its popup says so first, and "It's right" and "Fix it" are yours (note-marks.js).
  const askKey = (line) => `${line.text}|${line.at ?? ''}`;
  const explainRun = new Map();
  function askable(li, line, call) {
    if (['writing', 'recording', 'transcribing'].includes(call.state)) return;
    li.classList.add('is-source');
    if (line.unsure) li.classList.add('is-ask');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const open_ = state.asking === askKey(line);
    li.setAttribute('aria-expanded', String(open_));
    li.setAttribute('aria-label', `${line.text}. ${line.unsure ? 'Loggie could not confirm this. ' : ''}Open to see where it came from.`);
    const toggle = (event) => {
      if (event.target.closest('button, input, .mt-ask-pop')) return;
      state.asking = open_ ? null : askKey(line);
      state.fixing = null;
      drawCanvas();
    };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target === li) { event.preventDefault(); toggle(event); } });
    // The invitation: every point looks the same at rest; on hover a small magnifier says it opens (a step's own
    // buttons take that place on its row).
    if (!li.classList.contains('mt-move')) li.append(icon('look', 'mt-look'));
    if (!open_) return;
    li.classList.add('is-open');
    const pop = askPop(line, call);
    li.append(pop);
    // Below the point, unless that runs off the bottom of the page: then above it.
    requestAnimationFrame(() => { const box = pop.getBoundingClientRect(), view = canvas.getBoundingClientRect(); if (box.bottom > view.bottom - 8 && box.height < box.top - view.top - 70) pop.classList.add('is-above'); });
    // Notes written before explanations existed: the first open asks for them, for every point of the call at once.
    if (!call.explained && !call.explaining && call.summarized && !explainRun.has(call.id)) {
      explainRun.set(call.id, 'running');
      api.explainCall(call.id).then(() => { explainRun.set(call.id, 'done'); }, (error) => { explainRun.set(call.id, error.message); })
        .then(() => { if (state.selected === call.id) open(call.id, { keepSub: true }); });
    }
  }

  function saidBlock(said, label) {
    const quote = el('blockquote', 'mt-said-quote');
    if (label) quote.append(el('span', 'mt-said-label', label));
    quote.append(el('span', 'mt-said-words', said.text));
    const by = el('span', 'mt-said-by', said.who);
    if (said.at != null) { by.append(' · '); by.append(timeButton(said.at)); }
    quote.append(by);
    return quote;
  }

  function askPop(line, call) {
    const pop = el('div', 'mt-ask-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Where this came from');
    const source = line.source || { context: '', said: [], near: null };
    // For a point the checks could not confirm, the AI's look at the whole call leads: the call says it, partly, or not.
    // It never clears the mark: that is still yours to press.
    const verdict = { yes: 'The call says this', partly: 'The call says part of this', no: 'The call doesn’t say this' }[source.holds];
    pop.append(el('p', 'mt-ask-head', line.unsure ? verdict || 'Loggie couldn’t confirm this line' : 'Where this came from'));
    if (line.unsure && source.instead) pop.append(el('p', 'mt-ask-instead', source.instead));
    const run = explainRun.get(call.id);
    if (source.context) pop.append(el('p', 'mt-ask-read', source.context));
    else if (call.explaining || run === 'running') { const wait = el('p', 'mt-working'); wait.append(el('span', 'mt-spin'), 'Looking into it'); pop.append(wait); }
    else if (run && run !== 'done') pop.append(el('p', 'mt-ask-note', run));
    for (const said of source.said) pop.append(saidBlock(said));
    if (!source.said.length && source.near) pop.append(saidBlock(source.near, 'The closest thing said'));
    if (!source.said.length && !source.near && !source.context) pop.append(el('p', 'mt-ask-note', 'Loggie couldn’t find where this was said.'));
    // The point's own answers (It's right, Fix it) follow what was said; a step's actions close the popup.
    const acts = stepActions(line, pop);
    if (!line.unsure) { pop.append(...acts); return pop; }
    const answer = async (action, value, done) => {
      try { await api.noteLine(call.id, line.text, action, value); state.asking = null; state.fixing = null; toast(done, () => api.noteLine(call.id, line.text, 'undo')); }
      catch (error) { state.notice = error.message; drawRecord(); }
      await open(state.selected, { keepSub: true });
    };
    if (state.fixing === askKey(line)) {
      const input = el('input', 'mt-ask-fix');
      input.value = line.text;
      input.setAttribute('aria-label', 'Your words for this line');
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); if (input.value.trim() && input.value.trim() !== line.text) answer('fix', input.value.trim(), 'Saved your words'); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.fixing = null; drawCanvas(); }
      });
      pop.append(input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    const actions = el('div', 'mt-ask-actions');
    if (state.fixing === askKey(line)) actions.append(
      button('Save', () => { const value = pop.querySelector('.mt-ask-fix')?.value.trim(); if (value && value !== line.text) answer('fix', value, 'Saved your words'); }, 'mt-ask-yes'),
      button('Cancel', () => { state.fixing = null; drawCanvas(); }, 'mt-ask-no'),
    );
    else actions.append(
      button('It’s right', () => answer('right', '', 'Marked right'), 'mt-ask-yes'),
      button('Fix it', () => { state.fixing = askKey(line); drawCanvas(); }, 'mt-ask-no'),
    );
    pop.append(actions, ...acts);
    return pop;
  }

  // A call still moving: what it is doing, and for one waiting on the yes, the yes card itself.
  function statusBlock(call) {
    const block = el('div', 'mt-status');
    const line = (text) => { const p = el('p', 'mt-working'); p.append(el('span', 'mt-spin'), text); return p; };
    if (call.nameCheck?.status === 'checking' && !['recording', 'transcribing', 'waiting', 'writing'].includes(call.state)) { block.append(line('Checking names')); return block; }
    if (call.state === 'recording') block.append(el('p', 'mt-live', 'Recording'));
    else if (call.state === 'transcribing') block.append(line('Writing the transcript'));
    else if (call.state === 'writing') block.append(line(call.draft?.sections.length || call.draft?.steps.length ? 'Writing your notes' : call.draft || !call.summarized ? 'Starting to write' : 'Looking into the lines Loggie couldn’t confirm'));
    else if (call.state === 'failed') block.append(el('p', 'mt-empty', call.reason || 'The write-up failed.'));
    else if (call.state === 'waiting') block.append(el('p', 'mt-empty', 'Not summarized yet. Summarize sends the transcript, screened on this Mac, to your cloud AI.'));
    else return null;
    return block;
  }

  // The user's own notes: saved as they type (600 ms after the last key), into the call folder. While the call records
  // the box is big and takes the caret; after, it is one line until it is used.
  function notesBox(call) {
    let box = notesBoxes.get(call.id);
    if (!box) {
      box = el('textarea', 'mt-notes');
      box.setAttribute('aria-label', 'Your notes');
      box.value = call.notes || '';
      let wait = null;
      const save = async () => {
        clearTimeout(wait);
        const text = box.value;
        try { await api.callNotes(call.id, text); box.classList.remove('is-unsaved'); }
        catch (error) { box.classList.add('is-unsaved'); box.title = error.message; }
        finally { if (box.value === text) notesWaiting.delete(call.id); }
      };
      box.addEventListener('input', () => {
        clearTimeout(wait);
        notesWaiting.set(call.id, save);
        wait = setTimeout(save, 600);
      });
      notesBoxes.set(call.id, box);
    } else if (document.activeElement !== box && !notesWaiting.has(call.id) && typeof call.notes === 'string' && !box.classList.contains('is-unsaved')) box.value = call.notes;
    box.placeholder = call.state === 'recording' ? 'Notes' : 'Add notes';
    box.classList.toggle('is-big', call.state === 'recording');
    return box;
  }

  // One of the user's next steps that became a move: the move row Workspaces draws (workspaces.js moveRow), the same signs and
  // calls. Hover shows ✓ done, 📅 new date, ✕ drop; the round button opens "What should it say?" and drafts it.
  // A step already done, dropped or moved reads struck through with Undo.
  // One of your next steps (2026-10-12, Gio picked mock A, then "do we need the write it?"): a round box on the row is
  // Done, with Undo; everything else is in the line's popup (askPop): Draft it on a step that is a message to someone,
  // New date and Drop. Nothing floats over the row, so every minute stays in line. Another person's step only explains.
  async function moveAct(run, done, undo) {
    try { await run(); state.notice = ''; if (done) toast(done, undo); } catch (error) { state.notice = error.message; drawRecord(); }
    await open(state.selected, { keepSub: true });
  }
  function stepRow(step) {
    const li = lineItem(step);
    li.classList.add('mt-move');
    if (step.closed) li.classList.add('is-closed');
    if (step.mine && step.moveId) {
      const done = step.closed === 'done';
      const box = button('', (event) => {
        event.stopPropagation();
        if (step.closed) moveAct(() => api.unretire(step.moveId));
        else moveAct(() => api.markMove(step.moveId, 'done'), 'Marked done', () => api.unretire(step.moveId));
      }, `mt-done${done ? ' is-on' : ''}`);
      box.setAttribute('aria-label', `${done ? 'Not done' : 'Done'}: ${step.text}`);
      box.title = done ? 'Not done' : 'Done';
      box.setAttribute('aria-pressed', String(done));
      box.append(icon('check'));
      li.prepend(box);
      // A step dropped or moved elsewhere reads struck through; its box brings it back.
      if (step.closed && !done) box.title = `${step.closed === 'dropped' ? 'Dropped' : 'Moved'}. Click to bring it back.`;
    } else li.prepend(el('span', 'mt-done-space'));
    return [li];
  }

  // What a step of yours can do, at the bottom of its popup.
  const drafted = new Map();
  function stepActions(line, pop) {
    if (!line.mine || !line.moveId || line.closed) return [];
    const acts = el('div', 'mt-step-acts');
    if (state.dating === line.moveId) {
      const input = el('input', 'mt-step-date');
      input.type = 'date';
      input.id = `mt-date-${line.moveId}`;
      input.setAttribute('aria-label', 'New date');
      setTimeout(() => input.focus(), 0);
      acts.append(input,
        button('Save', () => { state.dating = null; state.asking = null; moveAct(() => api.moveDate(line.moveId, input.value || null), input.value ? 'New date saved' : 'Date cleared'); }, 'mt-step-go'),
        button('Cancel', () => { state.dating = null; drawCanvas(); }, 'mt-link'));
      return [el('div', 'mt-pop-rule'), acts];
    }
    if (line.message) {
      const sent = drafted.get(line.moveId);
      if (sent) acts.append(el('span', 'mt-drafted', sent), button('Draft again', () => draftIt(line), 'mt-link'));
      else {
        const go = button('', () => draftIt(line), 'mt-step-go');
        go.append('Draft it');
        if (line.message.to) go.append(el('small', '', ` to ${line.message.to}`));
        acts.append(go);
      }
    }
    acts.append(
      button('New date', () => { state.dating = line.moveId; drawCanvas(); }, 'mt-link'),
      button('Drop', () => { state.asking = null; moveAct(() => api.markMove(line.moveId, 'dropped'), 'Dropped', () => api.unretire(line.moveId)); }, 'mt-link'),
    );
    return [el('div', 'mt-pop-rule'), acts];
  }
  // Draft it: Loggie writes the message from the call and leaves it unsent in the mail app (do-it.js); the popup says so.
  async function draftIt(line) {
    drafted.set(line.moveId, 'Drafting it…');
    drawCanvas();
    try {
      const result = await api.doIt(line.moveId, null);
      drafted.set(line.moveId, result?.phase === 'queued' || result?.started ? `Drafting${line.message?.to ? ` to ${line.message.to}` : ''} in your mail app. Nothing is sent.` : (result?.text || 'Done.'));
    } catch (error) { drafted.set(line.moveId, error.message); }
    drawCanvas();
  }

  // The notes while the AI writes them: the draft's lines, each new one easing in, a caret after the last, and grey
  // bars before the first line comes (the cloud AI answers all at once, so it shows the bars until then). A draft line has
  // not been checked yet, so it carries no minute and no move buttons: the checked notes replace it in a few seconds.
  function draftView(call) {
    const part = el('div', 'mt-draft');
    const seen = drawnDraft.get(call.id) || new Set();
    drawnDraft.set(call.id, seen);
    // In the order the AI writes them, so the newest line is always the last one: topics, then the next steps.
    const groups = [...(call.draft?.sections || []), ...(call.draft?.steps.length ? [{ heading: 'Next steps', lines: call.draft.steps, steps: true }] : [])];
    if (!groups.length) {
      part.setAttribute('aria-label', 'Writing your notes');
      for (const width of [72, 88, 64, 80]) { const bar = el('i', 'mt-ghost'); bar.style.width = `${width}%`; part.append(bar); }
      return part;
    }
    let order = 0;
    groups.forEach((group) => {
      const section = el('section', 'mt-topic');
      section.append(el('h3', group.steps ? 'mt-label' : 'mt-topic-head', group.heading));
      const ul = el('ul', 'mt-lines');
      for (const line of group.lines) {
        const li = el('li', `mt-row${line.detail ? ' is-detail' : ''}`);
        li.append(el('span', 'mt-text', line.text));
        if (line.who && !line.mine) li.append(el('span', 'mt-owner', line.who));
        const key = `${group.heading}\n${line.text}`;
        if (!seen.has(key)) { li.classList.add('is-arriving'); li.style.animationDelay = `${Math.min(order++, 3) * 60}ms`; seen.add(key); }
        ul.append(li);
      }
      section.append(ul);
      part.append(section);
    });
    [...part.querySelectorAll('.mt-row .mt-text')].at(-1)?.append(el('i', 'mt-caret'));
    part.append(el('p', 'mt-draft-note', 'Draft. Each line is checked against the call next.'));
    return part;
  }

  function notesView(call) {
    const body = el('div', 'mt-body');
    // One appearance (2026-10-12): the checked notes are laid out exactly as the draft was, topics then next steps. When
    // they replace it, a line the checks kept word for word stays still; only a line they reworded fades in its new words.
    const settling = lastState.get(call.id) === 'writing' && call.state !== 'writing' && call.summarized ? drawnDraft.get(call.id) || new Set() : null;
    if (settling) drawnDraft.delete(call.id);
    const settle = (li, heading, text) => { if (settling && !settling.has(`${heading}\n${text}`)) li.classList.add('is-revised'); return li; };
    if (call.error) body.append(el('p', 'mt-empty', call.error));
    const status = statusBlock(call);
    if (status) body.append(status);
    if (call.summarized && call.state === 'done' && (call.transcriptNewer || call.notesNewer || call.pagesNewer)) body.append(el('p', 'mt-stale', `Your ${call.transcriptNewer ? 'transcript fixes' : call.notesNewer ? 'notes' : 'new page'} ${call.transcriptNewer || call.notesNewer ? 'are' : 'is'} not in these notes yet. Summarize again to add ${call.transcriptNewer || call.notesNewer ? 'them' : 'it'}.`));
    if ((call.state === 'writing' && call.draft) || state.resummarizing === call.id) { body.append(notesBox(call), draftView(call)); return body; }
    const box = notesBox(call);
    body.append(box);
    if (call.state === 'recording' && !typing()) setTimeout(() => box.focus(), 0);
    for (const part of call.sections) {
      const section = el('section', 'mt-topic');
      const head = el('h3', 'mt-topic-head');
      head.append(marked(part.heading, call));
      section.append(head);
      const ul = el('ul', 'mt-lines');
      for (const line of part.lines) ul.append(settle(lineItem(line), part.heading, line.text));
      section.append(ul);
      body.append(section);
    }
    const mine = call.steps.filter((step) => step.mine);
    const theirs = call.steps.filter((step) => !step.mine);
    if (mine.length || theirs.length) {
      const section = el('section', 'mt-steps');
      section.append(el('h3', 'mt-label', 'Next steps'));
      const ul = el('ul', 'mt-lines');
      for (const step of mine) { const rows = step.moveId ? stepRow(step) : [lineItem(step)]; settle(rows[0], 'Next steps', step.text); ul.append(...rows); }
      for (const step of theirs) ul.append(settle(lineItem(step, [el('span', 'mt-owner', step.who || step.owner || '')]), 'Next steps', step.text));
      section.append(ul);
      body.append(section);
    }
    if (!call.summarized && !call.error && !status) body.append(el('p', 'mt-empty', call.transcript.length ? 'No summary yet.' : 'Nothing written for this call yet.'));
    return body;
  }

  // Find in the transcript: every line holding all the words typed, the words marked in place, the current one green
  // (the same green a minute in the notes jumps to). Enter or ↓ goes to the next, Shift+Enter or ↑ back, Esc clears.
  // The box is kept across redraws so typing in it never loses the caret.
  const findBox = el('input', 'mt-find-box');
  findBox.type = 'search';
  findBox.placeholder = 'Find in transcript';
  findBox.setAttribute('aria-label', 'Find in transcript');
  findBox.addEventListener('input', () => { setFind(findBox.value); drawCanvas(); findBox.focus(); });
  findBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); findStep(event.key === 'ArrowUp' || event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape' && findBox.value) { event.preventDefault(); event.stopPropagation(); setFind(''); drawCanvas(); findBox.focus(); }
  });
  function setFind(query) { state.find = query; state.findAt = 0; findBox.value = query; const call = state.details.get(state.selected); state.hit = call ? findHits(call)[0] ?? null : null; }
  function findHits(call) {
    const words = searchWords(state.find);
    if (!words.length) return [];
    return call.transcript.flatMap((line, index) => { const hay = plainOf(shownSaid(line)).toLowerCase(); return words.every((word) => hay.includes(word)) ? [index] : []; });
  }
  function findStep(by) {
    const call = state.details.get(state.selected);
    const hits = call ? findHits(call) : [];
    if (!hits.length) return;
    state.findAt = (state.findAt + by + hits.length) % hits.length;
    state.hit = hits[state.findAt];
    drawCanvas();
    findBox.focus();
  }
  function findBar(call) {
    const bar = el('div', 'mt-find');
    const hits = findHits(call);
    const count = el('span', 'mt-find-count', !state.find ? '' : hits.length ? `${state.findAt + 1} of ${hits.length}` : 'No lines say that');
    count.setAttribute('role', 'status');
    const prev = button('↑', () => findStep(-1), 'mt-find-step'); prev.setAttribute('aria-label', 'Previous line'); prev.title = 'Previous line'; prev.disabled = hits.length < 2;
    const next = button('↓', () => findStep(1), 'mt-find-step'); next.setAttribute('aria-label', 'Next line'); next.title = 'Next line'; next.disabled = hits.length < 2;
    const exact = button('Exact words', () => {
      state.exact = !state.exact;
      try { localStorage.setItem('loggie.exactWords', state.exact ? '1' : '0'); } catch { /* the switch still works for this session */ }
      state.findAt = 0; state.hit = findHits(call)[0] ?? null;
      drawCanvas();
    }, 'mt-exact');
    exact.setAttribute('aria-pressed', String(state.exact));
    exact.title = state.exact ? 'Showing the words as said, with ums and unsure words marked' : 'Show the words exactly as said';
    bar.append(findBox, count, prev, next, exact);
    return bar;
  }
  // Marks each typed word inside a line already drawn (its unclear marks stay as they are).
  function markFound(node, query) {
    const words = searchWords(query);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const text of texts) {
      const parts = highlighted(text.nodeValue, query, words);
      if (parts.childNodes.length > 1) text.replaceWith(parts);
    }
  }

  // The transcript. While the call records, the live lines: words about a second behind the voices (patchTranscript),
  // each new turn easing in and followed to the bottom. After, any line is the user's to fix: a click turns it into plain text to edit, Enter
  // or a click away saves it (transcript-edit.js), Esc puts it back. A fix feeds the next Summarize again.
  function transcriptView(call) {
    const body = el('div', 'mt-transcript');
    if (call.transcriptLive) {
      const live = el('p', 'mt-live-line');
      live.append(el('i', 'mt-rec-dot'), call.state === 'recording' ? 'Live.' : 'Writing the full transcript. These are the live lines.');
      body.append(live);
    }
    if (!call.transcript.length) { body.append(el('p', 'mt-empty', call.state === 'recording' ? 'Words show up here as people talk.' : 'No transcript for this call.')); return body; }
    body.append(findBar(call));
    if (call.transcriptEditable) body.append(el('p', 'mt-edit-hint', 'Click any line to fix a word.'));
    const hits = findHits(call);
    const before = drawnTurns.get(call.id);
    drawnTurns.set(call.id, call.transcript.length);
    const ol = el('ol', 'mt-said');
    call.transcript.forEach((line, index) => ol.append(saidItem(call, line, index, hits, before, call.transcript[index - 1])));
    body.append(ol);
    return body;
  }

  // One row per burst of speech (a pause, a sentence's end or 40 words). A turn is the bursts one speaker says in a row:
  // the speaker is named on its first row only and space falls between turns, not boxes (data-display: erase the
  // repeated "Them", let empty space group; Gio 2026-10-27, "not very similar to granola").
  function saidItem(call, line, index, hits, before, previous) {
    const same = Boolean(previous) && previous.who === line.who;
    const li = el('li', `mt-line${index === state.hit ? ' is-hit' : ''}${same ? ' is-same' : previous ? ' is-turn' : ''}`);
    if (call.transcriptLive && before != null && index >= before) { li.classList.add('is-arriving'); li.style.animationDelay = `${Math.min(index - before, 3) * 60}ms`; }
    const said = el('span', 'mt-said-text');
    said.append(marked(shownSaid(line), call));
    if (hits.includes(index)) markFound(said, state.find);
    if (call.transcriptEditable) editable(said, call, line, index);
    li.append(el('span', 'mt-at', clock(line.at)), el('span', `mt-who${/^me\b/i.test(line.who) ? ' is-me' : ''}`, line.who), said);
    return li;
  }

  // One transcript line made fixable. The words show as plain text while edited ("(unclear)" marks come off: the user
  // has read the line); nothing is saved when nothing changed.
  function editable(said, call, line, index) {
    const plain = String(shownSaid(line) || '').replace(/\s+\(unclear\)/g, '');
    said.tabIndex = 0;
    said.setAttribute('role', 'textbox');
    said.setAttribute('aria-label', `Line at ${clock(line.at)}, ${line.who}. Press Enter to edit.`);
    const begin = () => {
      if (said.classList.contains('is-editing')) return;
      said.classList.add('is-editing');
      said.contentEditable = 'plaintext-only';
      said.textContent = plain;
      said.focus();
      const range = document.createRange();
      range.selectNodeContents(said);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    };
    const end = async (save) => {
      if (!said.classList.contains('is-editing')) return;
      const text = said.textContent.replace(/\s+/g, ' ').trim();
      said.classList.remove('is-editing');
      said.contentEditable = 'false';
      if (!save || !text || text === plain.replace(/\s+/g, ' ').trim()) { said.replaceChildren(marked(shownSaid(line), call)); return; }
      said.textContent = text;
      said.classList.add('is-saving');
      try {
        await api.transcriptLine(call.id, index, text);
        line.text = text; line.raw = text;
        said.classList.replace('is-saving', 'is-saved');
        setTimeout(() => said.classList.remove('is-saved'), 1200);
        api.uiAct?.({ act: 'transcript-edit' });
      } catch (error) {
        said.classList.remove('is-saving');
        said.replaceChildren(marked(shownSaid(line), call));
        state.notice = error.message;
        drawRecord();
      }
      await open(state.selected, { keepSub: true });
    };
    said.addEventListener('click', begin);
    said.addEventListener('keydown', (event) => {
      if (!said.classList.contains('is-editing')) { if (event.key === 'Enter') { event.preventDefault(); begin(); } return; }
      if (event.key === 'Enter') { event.preventDefault(); end(true); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); end(false); }
    });
    said.addEventListener('blur', () => end(true));
  }

  document.addEventListener('loggie:open-call', async (event) => {
    const id = event.detail?.call;
    if (!id) return;
    state.selected = id;
    state.sub = 'notes';
    state.hit = null;
    // From a Needs-you guess the picker opens on the list; anything else opens the call's own page.
    if (state.view !== 'call') state.from = state.view;
    state.view = event.detail.picker ? 'recordings' : 'call';
    applyView();
    await load();
    // From a Needs-you guess: the picker opens on that call, guess first.
    if (event.detail.picker && state.calls.some((c) => c.id === id)) {
      state.picking = id;
      drawList();
      list.querySelector(`.mt-item[data-call="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
    }
  });

  built = true;
  return {
    load,
    // The yes card's own redraw (an AI pick list after the first Yes) reaches the canvas too.
    redraw() { if (!root.hidden && state.selected) drawCanvas(); },
    onEvent(event) {
      const type = String(event?.type || '');
      if (/^meeting\./.test(type) || (/^(run|step|screen|send)\./.test(type) && isVisible())) load();
    },
    stop() { clearTimeout(timer); },
  };
}
