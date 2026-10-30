// The Day view, home of the Notes & Meetings tab (loggie-meetings-focus; picture: the canvas's v2 row; scope
// ~/Loggie/workspace/meetings-focus-scope.md). One day at a time: the week as dots, one card (recording now, just ended,
// next, or nothing left), then the rest of the day as quiet rows, each with Record, and what was hidden as one line.
// No motion: every change is one redraw to a still end state, but for the recording's pencil (loggie-pause-attach),
// whose ink scrolls while Loggie takes notes. Decisions are meetings-day-model.js; data is
// hikyaku:events (week-events.js joinWeek) and the calls meetings.js already loads.
import { cardFor, dayRows, hiddenLine, isoDay, mondayOf, seedLine, weekDays, weekDots, whenLine } from './meetings-day-model.js';
import { chipNode, payoffNode, pickerNode } from './meetings-row.js';
import { fusenTab, pauseButton, pencil, recordedSeconds, takeDrops } from './recording-controls.js';

const DAY_MS = 86400000;
function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}
function button(label, onClick, className = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const shortTime = (iso) => timeOf(iso).replace(/ (AM|PM)$/, '');
const dateLine = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const minutesOf = (item) => (item.end ? Math.round((Date.parse(item.end) - Date.parse(item.start)) / 60000) : 0);
const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const withWho = (item) => (item.who?.length ? `${item.title} · ${item.who.join(', ')}` : item.title);
// The calendar's id of an event row (2026-10-27): Record hands it on, so the press records that event and no other.
const eventIdOf = (item) => (item.kind === 'event' && item.id ? item.id : null);

// calls(): the calls meetings.js loaded last; names(guess): the workspace names for a picker, guess first.
export function createDayView({ api, calls = () => [], names = () => [], now = () => new Date(), onOpenCall = () => {}, onRecord = async () => {}, onStop = async () => {}, onChanged = () => {},
  onSummarize = async () => {}, onFile = async () => null, onFileEvent = async () => {}, onNewWorkspace = async () => null, onOpenWorkspace = () => {} } = {}) {
  // picking: the item or call id whose workspace picker is open; making: the open New workspace… box; both survive
  // the 2 s reload while a call records (the 2026-10-23 picker lesson). left: calls he moved off the card (Leave it);
  // payoff: what filing a call did, by call id, shown where its chip was until the day changes.
  const state = { day: isoDay(now()), items: [], hidden: [], calendar: 'granted', error: '', showHidden: false, picking: null, making: null, left: new Set(), payoff: new Map() };
  const node = el('section', 'dy');
  node.setAttribute('aria-label', 'Day');
  const nav = el('div', 'dy-nav');
  const card = el('div', 'dy-card-slot');
  const rows = el('ol', 'dy-rows');
  rows.setAttribute('aria-label', 'The rest of the day');
  const foot = el('p', 'dy-foot');
  node.append(nav, card, rows, foot);
  let asked = 0;
  let ticker = null;
  let loadedWeek = '';

  async function load() {
    const monday = isoDay(mondayOf(new Date(`${state.day}T12:00:00`)));
    const ask = ++asked;
    try {
      const week = await api.events(monday, isoDay(new Date(Date.parse(`${monday}T12:00:00`) + 7 * DAY_MS)));
      if (ask !== asked) return;
      state.items = week.items || [];
      state.hidden = week.hidden || [];
      state.calendar = week.calendar;
      state.error = '';
      loadedWeek = monday;
    } catch (error) { if (ask !== asked) return; state.items = []; state.hidden = []; state.error = error.message; }
    if (!busyHere()) draw();
  }
  // A day in another week loads that week; one in the loaded week only redraws.
  function go(day) {
    state.day = day;
    state.showHidden = false;
    state.picking = null;
    state.making = null;
    state.payoff.clear();
    if (isoDay(mondayOf(new Date(`${day}T12:00:00`))) === loadedWeek) draw(); else load();
  }
  const today = () => isoDay(now());

  function draw() {
    clearInterval(ticker);
    drawNav();
    const isToday = state.day === today();
    const shown = isToday ? cardFor({ items: state.items, calls: calls(), now: now(), left: state.left }) : null;
    card.replaceChildren(...(shown ? [cardNode(shown)] : []));
    const onCard = shown?.item?.id || null;
    const recordedNow = shown?.call?.id || null;
    rows.replaceChildren(...dayRows(state.items, state.day).filter((item) => item.id !== onCard && !(recordedNow && item.call === recordedNow)).map(rowNode));
    if (!rows.children.length && !shown) rows.append(el('li', 'dy-empty', state.calendar === 'denied' ? '' : 'Nothing with people this day.'));
    drawFoot();
  }

  function drawNav() {
    const prev = button('‹', () => go(isoDay(new Date(Date.parse(`${state.day}T12:00:00`) - DAY_MS))), 'dy-step');
    prev.setAttribute('aria-label', 'Previous day');
    prev.title = 'Previous day';
    const next = button('›', () => go(isoDay(new Date(Date.parse(`${state.day}T12:00:00`) + DAY_MS))), 'dy-step');
    next.setAttribute('aria-label', 'Next day');
    next.title = 'Next day';
    const strip = el('div', 'dy-strip');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'This week');
    const monday = mondayOf(new Date(`${state.day}T12:00:00`));
    const dots = weekDots(state.items, monday);
    weekDays(monday).forEach((date, index) => {
      const day = isoDay(date);
      const b = button('', () => go(day), `dy-daypick${day === state.day ? ' is-picked' : ''}${day === today() ? ' is-today' : ''}`);
      b.dataset.day = day;
      b.setAttribute('aria-pressed', String(day === state.day));
      const count = dots[index].count;
      b.setAttribute('aria-label', `${date.toLocaleDateString('en-US', { weekday: 'long' })}${day === today() ? ', today' : ''}, ${count} ${count === 1 ? 'meeting or class' : 'meetings and classes'}`);
      b.append(el('span', 'dy-dayletter', date.toLocaleDateString('en-US', { weekday: 'narrow' })), el('span', 'dy-dots', dots[index].mark));
      strip.append(b);
    });
    const parts = [prev, el('strong', 'dy-date', dateLine(state.day)), next, strip];
    if (state.day !== today()) parts.push(button('Today', () => go(today()), 'dy-today'));
    nav.replaceChildren(...parts);
  }

  // The one card. Its first line names the mode: Recording, Just ended, Next, or nothing left.
  function cardNode(shown) {
    const box = el('section', `dy-card is-${shown.mode}`);
    box.setAttribute('aria-label', shown.mode === 'recording' ? 'Recording now' : shown.mode === 'ended' ? 'Just ended' : shown.mode === 'next' ? 'Next' : shown.mode === 'both' ? 'Two at once' : 'Nothing else today');
    if (shown.mode === 'recording') {
      const call = shown.call;
      const time = el('span', 'dy-clock', '00:00');
      // Paused (loggie-pause-attach): the clock holds and the pencil lifts; Stop still writes it up from either state.
      const tick = () => { time.textContent = clock(recordedSeconds(call)); };
      tick();
      if (!call.paused) ticker = setInterval(tick, 1000);
      const words = el('div', 'dy-card-words');
      words.append(el('span', 'dy-card-mode', call.paused ? 'Paused' : 'Taking notes'), el('strong', 'dy-card-title', call.title));
      const stop = button('', () => onStop(call.id), 'dy-stop');
      stop.setAttribute('aria-label', 'Stop and write it up');
      stop.title = 'Stop and write it up';
      stop.append(el('i'));
      const pause = pauseButton(call, { api, className: 'dy-pause', onDone: (error) => onChanged(error) });
      if (call.paused) box.classList.add('is-paused');
      // Pages tucked in so far, by name under the title; the fusen tab adds one, and so does a file dropped on the card.
      if (call.pages?.length) words.append(el('span', 'dy-card-pages', call.pages.join(' · ')));
      const tab = fusenTab(call, { api, className: 'dy-fusen', onDone: (error) => onChanged(error) });
      takeDrops(box, call, { api, onDone: (error) => onChanged(error) });
      box.append(pencil(call.paused), time, words, button('Open notes', () => onOpenCall(call.id), 'dy-link'), tab, pause, stop);
      return box;
    }
    if (shown.mode === 'ended') {
      const call = shown.call;
      const target = targetOf(call);
      const words = el('div', 'dy-card-words');
      const top = el('div', 'dy-card-top');
      top.append(el('span', 'dy-card-mode', 'Just ended'), el('span', 'dy-card-meta', `${timeOf(call.start)} · ${shown.minutes} min`));
      const status = el('div', 'dy-card-line');
      const waiting = call.state === 'waiting';
      status.append(el('span', '', waiting ? 'Transcript ready. Not summarized yet.' : call.state === 'done' ? 'Notes ready.' : 'Writing your notes…'));
      // One color cue at a time: while Summarize is due (blue) the guess draws plain.
      if (!state.payoff.has(call.id)) status.append(chip(target, { loud: !waiting }));
      words.append(top, el('h2', 'dy-card-title', call.title), status);
      // A page after Stop (loggie-pages-anytime): the fusen tab and a drop on the card; Summarize adds it to the notes.
      if (call.pages?.length) words.append(el('span', 'dy-card-pages', call.pages.join(' · ')));
      takeDrops(box, call, { api, where: 'ended', onDone: (error) => onChanged(error) });
      const acts = el('div', 'dy-card-acts');
      acts.append(button('Open', () => onOpenCall(call.id), 'dy-link'), fusenTab(call, { api, className: 'dy-fusen', where: 'ended', onDone: (error) => onChanged(error) }));
      if (!call.workstream && !call.noWorkspace) acts.append(button('Leave it', () => { state.left.add(call.id); state.picking = null; draw(); }, 'dy-link is-quiet'));
      if (waiting) acts.append(button('Summarize', () => onSummarize(call.id), 'dy-summarize'));
      box.append(words, acts);
      under(box, target);
      return box;
    }
    if (shown.mode === 'next') {
      const item = shown.item;
      const words = el('div', 'dy-card-words');
      const top = el('div', 'dy-card-top');
      const long = minutesOf(item);
      top.append(el('span', 'dy-card-time', timeOf(item.start)), el('span', 'dy-card-meta', `Next · ${whenLine(shown.inMinutes, item.start)}${long ? ` · ${long} min long` : ''}`));
      const who = el('div', 'dy-card-line');
      if (item.who?.length) who.append(el('span', '', item.who.join(', ')));
      if (item.sort === 'class') who.append(el('span', '', 'Class'));
      const target = targetOf(item);
      if (!state.payoff.has(target.key)) who.append(chip(target, { loud: true }));
      words.append(top, el('h2', 'dy-card-title', item.title), who);
      // Record carries the meeting's workspace when he filed the meeting (never a guess), so the call is filed from
      // its first second (cycle 2, jidoka at the source). The event's id goes too: the card's meeting is the one recorded.
      // A page before it starts (loggie-pages-anytime): held for this meeting until Record moves it into the call.
      const eventId = eventIdOf(item);
      let tab = null;
      if (eventId) {
        const meeting = { id: eventId, pages: item.pages || [], state: 'before' };
        const held = { callPagePick: () => api.eventPagePick(eventId, item.start), callPageAdd: (_, file) => api.eventPageAdd(eventId, item.start, file) };
        if (item.pages?.length) words.append(el('span', 'dy-card-pages', `${item.pages.join(' · ')} · ready for Record`));
        tab = fusenTab(meeting, { api: held, className: 'dy-fusen', where: 'next', onDone: (error) => onChanged(error) });
        takeDrops(box, meeting, { api: held, where: 'next', onDone: (error) => onChanged(error) });
      }
      const record = button('', () => onRecord(item.title, 'card', item.workstream || null, eventIdOf(item)), 'dy-record');
      // Record's mark is the pencil, still (loggie-pages-anytime, Gio's pick A): the same pencil then writes.
      record.append(pencil(false, { still: true }), 'Record');
      box.append(words, ...(tab ? [tab] : []), record);
      under(box, target);
      return box;
    }
    if (shown.mode === 'both') {
      // Record both (2026-10-28): one recording, two calls; the room's meeting on the mic, the other on the Mac's sound.
      // Both rows keep their own Record, for one alone. A tie asks which one is in the room, one button each.
      const words = el('div', 'dy-card-words');
      const top = el('div', 'dy-card-top');
      top.append(el('span', 'dy-card-mode', 'Two at once'));
      words.append(top);
      const both = (room, mac) => onRecord(room.title, 'card', room.workstream || null, eventIdOf(room), eventIdOf(mac));
      if (shown.tie) {
        for (const item of shown.tie) words.append(el('h2', 'dy-card-title', item.title));
        words.append(el('div', 'dy-card-line', 'Which one is in the room? Loggie records both.'));
        const acts = el('div', 'dy-card-acts');
        const [a, b] = shown.tie;
        for (const [room, mac] of [[a, b], [b, a]]) {
          const pick = button(room.title, () => both(room, mac), 'dy-link dy-both-pick');
          pick.setAttribute('aria-label', `Record both, ${room.title} in the room`);
          acts.append(pick);
        }
        box.append(words, acts);
        return box;
      }
      for (const [item, side] of [[shown.room, 'Room'], [shown.mac, 'Mac sound']]) {
        const line = el('div', 'dy-card-line dy-both-line');
        line.append(el('strong', 'dy-both-title', item.title), el('span', '', `${shortTime(item.start)} · ${side}`));
        words.append(line);
      }
      const record = button('', () => both(shown.room, shown.mac), 'dy-record dy-both');
      record.append(pencil(false, { still: true }), 'Record both');
      box.append(words, record);
      return box;
    }
    box.append(el('p', 'dy-card-title', 'Nothing else with people today.'));
    if (shown.tomorrow) box.append(el('p', 'dy-card-meta', `Tomorrow ${timeOf(shown.tomorrow.start)} · ${withWho(shown.tomorrow)}`));
    return box;
  }

  // The router's reason for a calendar meeting's guess, in words (its evidence); a 'suggested' guess has none.
  const HOW_WORDS = { domain: 'invitees share its mail domain', word: 'the title names it', person: 'someone on it is in it', thread: 'same thread as its mail' };
  // What a chip and its picker act on: a recording (call id) or a calendar meeting with none (event id and start).
  function targetOf(entity) {
    const callId = entity.call && typeof entity.call === 'string' ? entity.call : entity.state && entity.id && !entity.kind ? entity.id : null;
    const call = callId ? calls().find((one) => one.id === callId) : null;
    return { key: callId || entity.id, call: callId, eventId: entity.kind === 'event' ? entity.id : null, start: entity.start, title: entity.title,
      workstream: call ? call.workstream : entity.workstream, guess: call ? call.guess : entity.guess, evidence: call ? call.evidence || '' : HOW_WORDS[entity.how] || '', retired: Boolean(call?.retired),
      noWorkspace: Boolean(call?.noWorkspace) };
  }
  // The shared chip (meetings-row.js); a press opens the shared picker under its row or card.
  function chip(target, { loud }) {
    return chipNode(target, { loud, open: state.picking === target.key, onPress: () => { state.picking = state.picking === target.key ? null : target.key; draw(); } });
  }
  // Under a row or the card: the open picker, the New workspace… box, or what filing did.
  function under(container, target) {
    if (state.making?.id === target.key) { container.append(state.making.box); return; }
    if (state.picking === target.key) {
      container.append(pickerNode({ names: names(target.workstream ? null : target.guess), workstream: target.workstream, guess: target.guess, evidence: target.evidence,
        noWorkspace: target.noWorkspace, onPick: (name) => file(target, name), onCancel: () => { state.picking = null; draw(); },
        // "No workspace": a recording only (refile.js); a calendar meeting with no recording keeps its own picker.
        onNone: target.call ? () => file(target, null) : null,
        // A recording never adds a workspace (Gio 10-17, kept 10-25); a meeting with no recording may.
        onNew: target.call ? null : () => openNew({ id: target.key, title: target.title, start: target.start }) }));
      return;
    }
    const result = state.payoff.get(target.key);
    if (result) container.append(payoffNode(result, { onOpenWorkspace }));
  }
  async function file(target, name) {
    state.picking = null;
    try {
      if (target.call) {
        if (name === null && !target.workstream && target.noWorkspace) { draw(); return; }
        const result = await onFile(target.call, name, target.key === cardKey() ? 'card' : 'row');
        if (result?.to || result?.none) state.payoff.set(target.key, result);
      } else {
        await onFileEvent({ id: target.eventId || target.key, start: target.start }, name);
      }
      state.error = '';
    } catch (error) { state.error = error.message; }
    await load();
  }
  const cardKey = () => { const shown = state.day === today() ? cardFor({ items: state.items, calls: calls(), now: now(), left: state.left }) : null; return shown?.call?.id || shown?.item?.id || null; };
  function openNew(item) {
    const box = el('div', 'dy-new');
    const input = el('input', 'dy-new-name');
    input.type = 'text';
    input.maxLength = 60;
    input.value = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    input.setAttribute('aria-label', 'Name for the new workspace');
    const seed = el('p', 'dy-muted', '');
    const save = button('Save', () => saveNew(item), 'mr-pick is-on');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); saveNew(item); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.making = null; draw(); }
    });
    box.append(input, save, button('Cancel', () => { state.making = null; draw(); }, 'mr-pick is-cancel'), seed);
    state.making = { id: item.id, box, input, save, saving: false };
    draw();
    input.focus();
    Promise.resolve().then(() => api.eventSeed(item.id, item.start)).then((answer) => seedLine(answer), () => seedLine(null)).then((line) => { seed.textContent = line; });
  }
  async function saveNew(item) {
    const making = state.making;
    const name = making?.input.value.replace(/\s+/g, ' ').trim();
    if (!making || making.saving || !name) return;
    making.saving = true;
    making.save.disabled = true;
    try { await onNewWorkspace(item, name); } catch (error) { making.saving = false; making.save.disabled = false; state.error = error.message; drawFoot(); return; }
    state.making = null;
    state.picking = null;
    await load();
  }

  // One quiet row: time, what it is (a band for a block, grey for a class, bold for people), and on the right either
  // the recording's mark (opens its notes) or Record, for anything today still ahead or under way.
  function rowNode(item) {
    const li = el('li', `dy-row is-${item.sort}${item.call ? ' has-call' : ''}`);
    li.dataset.event = item.id;
    li.append(el('span', 'dy-time', shortTime(item.start)));
    const label = item.sort === 'block' ? withWho(item) : item.sort === 'class' ? item.title : withWho(item);
    li.append(el('span', 'dy-what', label));
    const right = el('span', 'dy-right');
    if (item.call) {
      // A recording on the day carries the same chip as everywhere else, so it can be filed where it is seen.
      const target = targetOf(item);
      if (item.state !== 'recording' && !state.payoff.has(target.key)) right.append(chip(target, { loud: true }));
      const open = button('', () => onOpenCall(item.call), 'dy-open');
      open.append(el('i', 'dy-rec-mark'), item.state === 'recording' ? 'Recording' : 'Notes');
      open.setAttribute('aria-label', `Open the notes of ${item.title}`);
      right.append(open);
      li.append(right);
      const below = el('div', 'dy-under');
      under(below, target);
      if (below.childElementCount) li.append(below);
      return li;
    } else if (state.day === today() && Date.parse(item.end || item.start) >= now().getTime()) {
      const record = button('Record', () => onRecord(item.title, 'row', null, eventIdOf(item)), 'dy-row-record');
      record.setAttribute('aria-label', `Record ${item.title}`);
      right.append(record);
    }
    li.append(right);
    return li;
  }

  function drawFoot() {
    const parts = [];
    if (state.error) parts.push(el('span', 'dy-error', state.error));
    if (state.calendar === 'denied') {
      parts.push(el('span', '', 'Loggie cannot read your calendar, so only your recordings show. '));
      parts.push(button('Open Settings', () => api.openPermissionSettings?.('calendars'), 'dy-link'));
    }
    const line = hiddenLine(state.hidden, state.day);
    if (line) {
      parts.push(el('span', '', `${line} · `), button(state.showHidden ? 'Hide' : 'Show', () => { state.showHidden = !state.showHidden; draw(); }, 'dy-link'));
      if (state.showHidden) {
        const list = el('ul', 'dy-hidden');
        for (const item of state.hidden.filter((entry) => entry.day === state.day).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
          list.append(el('li', '', `${shortTime(item.start)}  ${item.title} · ${item.why}`));
        }
        parts.push(list);
      }
    }
    foot.replaceChildren(...parts);
    foot.hidden = !parts.length;
  }

  // While the picker or the New workspace… box is open, a reload keeps it (the card redraws only on a load).
  const busyHere = () => Boolean(state.picking || state.making);
  return { node, load, draw: () => { if (!busyHere()) draw(); }, go, today: () => go(today()), get day() { return state.day; } };
}
