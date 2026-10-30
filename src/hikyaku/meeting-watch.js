// The meeting watch (spec-c.md increment 12, B11 to B14): every 60 s it reads the calendar for the next day, folds the
// events into candidates and asks offerDecision (meeting.js) whether a meeting is starting. An offer is one run folder,
// <home>/runs/<run>/events.jsonl, holding meeting.offered and then meeting.answered: record, dismiss, or expired at the
// window's end. The watcher never starts a recording. Only answerOffer does, on the user's "record" through IPC
// hikyaku:meeting-answer, by running `<python> call.py start "<title>" '<event json>'` in the transcriber folder and
// waiting for it (call.py sleeps 3 s and exits; the recorder keeps running in its own session). The recording state is
// call.py's current.json under <home>/calls. Watch state is memory only: a restart offers again a meeting still in its
// window. An app holding the mic (B13, micOwners given) for HOLD_S gets the same offer, polled every MIC_POLL_S against
// the last calendar read; it only offers, like the calendar. With `permissions` given (C6) a denied calendar is not read
// and a "record" without the microphone and screen permissions starts nothing, each saying so with a setup.need. The same goes for the end (B15): from the offer a recording
// came from and the mic, endDecision (meeting.js) asks "Done? Write it up." with meeting.end_asked and nothing more. Only
// endAnswer ends a recording, on the user's "stop" through IPC hikyaku:meeting-end: it starts `call.py stop` detached,
// because stop transcribes for minutes, with its output in <call folder>/stop.log. The calendar, the mic, the clock, the timer, the emitter
// and the runner are all injectable, so tests run none of them.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { emitEvent } from './events.js';
import { callEvent, candidates, END_TEXT, endDecision, offerDecision, pickNow } from './meeting.js';
import { appSignal, HOLD_S, meetingApps } from './mic.js';
import { execRunner } from './screen-thread.js';
import { newRunId as runIdAt, runsRoot } from './send-gate.js';

export const OFFER_TEXT = 'A meeting is starting. Transcribe it?';
export const DOWNLOADING_TEXT = 'Transcription is still downloading';   // the offer's text while the speech files are not on this Mac yet (C7)
export const POLL_S = 60;
export const MIC_POLL_S = 5;
const LOOKBACK_MS = 5 * 60000;        // listEvents({from: now - 5 min, days: 1}), as `loggie record arm` reads it
const DAY_MS = 86400000;
const START_TIMEOUT_MS = 30000;       // call.py start returns in about 3 s; the recorder outlives it
const PAUSE_TIMEOUT_MS = 10000;       // call.py pause/resume signals the recorder and returns at once

// call.py's recording state (call.py STATE): { pid, dir, started } while a recording runs, else no file. A file that
// cannot be read still means something is recording: no offer is safer than two recorders.
// Record both (2026-10-28): call.py's `also`, the second meeting's folder (or a list of them) the one recording feeds.
export const alsoCalls = (state) => [].concat(state?.also || []).filter((dir) => typeof dir === 'string' && dir).map((dir) => basename(dir));
export async function readRecording(home) {
  const raw = await readFile(join(home, 'calls', 'current.json'), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw);
    // The call's own event.json too: its start and end survive an app restart and a recording not started from the
    // offer, which the in-memory origins do not (the Oct 9 7:12 PM call had none and never asked "Done?").
    const saved = state.dir ? await readFile(join(String(state.dir), 'event.json'), 'utf8').then(JSON.parse).catch(() => null) : null;
    return { call: basename(String(state.dir || '')) || null, startedAt: new Date((Number(state.started) || 0) * 1000).toISOString(), pid: state.pid ?? null,
      event: saved?.end ? { start: saved.start ?? null, end: saved.end } : null, also: alsoCalls(state) };
  } catch {
    return { call: null, startedAt: null, pid: null };
  }
}

// Starts a command that outlives this call, its output appended to `log`. A command that cannot start throws here.
export function detachedRunner(command, args, { cwd, env, log }) {
  const fd = openSync(log, 'a');
  try {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', (error) => console.error(`hikyaku meeting watch: ${command} could not run: ${error.message}`));
    child.unref();
  } finally {
    closeSync(fd);
  }
}

// call.py start's line naming the call's folder: "Recording both sides to <folder>", or on a split (2026-10-28)
// "Recording the room to <room folder> and the Mac's sound to <Mac folder>": the room folder is the call that opens.
const STARTED = /Recording (?:both sides|the room) to (.+?)(?: and the Mac's sound to .+)?$/m;
export function createMeetingWatch({
  home, listEvents, now = () => new Date(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, emit = emitEvent, newRunId = runIdAt,
  onOffer = () => {}, runner = execRunner, transcriber = async () => { throw new Error('No transcriber folder was given to the meeting watch.'); },
  loggieDirectory = null, log = console.error, micOwners = null, detach = detachedRunner, permissions = null, python = 'python3', speechReady = async () => true,
  recordCalendars = async () => null,   // settings.json "recordCalendars" (meeting.js isMine), read each poll; null = the default rule
}) {
  const state = { live: null, liveEvent: null, dismissed: new Set(), lastCalendarRead: null, list: [], events: [], micSeen: new Map(), micApps: [], micSignal: { held: [], released: [] },
    origins: new Map(), recMic: null, asks: new Map() };   // origins: call folder -> the offer it came from; asks: call -> last ask
  let calendarFailed = false;
  let micFailed = false;
  const runDirectory = (run) => join(runsRoot(home), run);

  // A calendar that cannot be read is logged once and gives no offer; polling goes on so the offer comes once it can.
  async function readCalendar(at) {
    // A calendar macOS has refused is not read; permissions says so once with a setup.need (permissions.js).
    if (permissions && await permissions.check('calendar-offer', { once: true })) return [];
    try {
      const events = await listEvents({ from: new Date(at.getTime() - LOOKBACK_MS), days: 1 });
      state.lastCalendarRead = at.toISOString();
      calendarFailed = false;
      return events;
    } catch (error) {
      if (!calendarFailed) log(`hikyaku meeting watch: the calendar could not be read, so nothing is offered until it can: ${error.message}`);
      calendarFailed = true;
      return [];
    }
  }

  // The apps that have held the mic for HOLD_S. A helper that is missing or fails gives an empty signal, logged once.
  // An app that let go can be offered again by a later call, so its dismissal is lifted.
  async function readMic(at, recording) {
    let apps = [];
    try {
      apps = meetingApps(await micOwners(), { ignorePids: recording?.pid ? [recording.pid] : [] });
      micFailed = false;
    } catch (error) {
      if (!micFailed) log(`hikyaku meeting watch: the microphone could not be read, so no call is detected from it: ${error.message}`);
      micFailed = true;
    }
    const { held, released } = appSignal({ apps, now: at, seen: state.micSeen });
    for (const app of released) state.dismissed.delete(`mic|${app.bundle}`);
    state.micSignal = { held, released };
    state.micApps = held.filter((app) => at.getTime() - Date.parse(app.since) >= HOLD_S * 1000);
  }

  // The window closed with no answer: the offer expires and its key is not offered again.
  async function expire(at) {
    if (!state.live || !state.live.end || at.getTime() < Date.parse(state.live.end)) return;
    const { offer_id: offerId, key } = state.live;
    state.live = null;
    state.liveEvent = null;
    state.dismissed.add(key);
    await emit(runDirectory(offerId), { type: 'meeting.answered', data: { offer_id: offerId, answer: 'expired', call: null } });
  }

  // B15: while a recording runs, remember which meeting apps held the mic during it and ask when endDecision says so.
  async function askIfDone(at, recording) {
    if (!recording?.call) { state.recMic = null; return; }
    if (state.recMic?.call !== recording.call) state.recMic = { call: recording.call, seen: new Set() };
    for (const app of state.micSignal.held) state.recMic.seen.add(app.bundle);
    const origin = state.origins.get(recording.call) || null;
    const last = state.asks.get(recording.call) || null;
    const decision = endDecision({
      recording: { call: recording.call, startedAt: recording.startedAt, source: origin?.source ?? (recording.event ? 'calendar' : null),
        event: origin?.end ? { start: origin.start ?? null, end: origin.end } : recording.event ?? null, seen: [...state.recMic.seen] },
      now: at, apps: state.micSignal, asked: last ? new Date(last.at).toISOString() : null,
    });
    if (!decision.ask) return;
    const run = newRunId(at);
    const ask = { at: at.getTime(), count: (last?.count || 0) + 1, run };
    state.asks.set(recording.call, ask);
    await emit(runDirectory(run), { type: 'meeting.end_asked', text: END_TEXT, data: { call: recording.call, reason: decision.reason, since: decision.since, asked_before: ask.count - 1 } });
  }

  async function poll({ calendar = true } = {}) {
    const at = now();
    const recording = await readRecording(home);
    if (calendar) {
      state.events = await readCalendar(at);
      state.list = candidates(state.events, { recordCalendars: await recordCalendars() });
    }
    if (micOwners) await readMic(at, recording);
    await askIfDone(at, recording);
    await expire(at);
    const list = state.list;
    const decision = offerDecision({ candidates: list, now: at, recording, dismissed: state.dismissed, live: state.live, micApps: state.micApps });
    if (decision.offer && decision.offer !== state.live) {
      const offerId = newRunId(at);
      const offer = { offer_id: offerId, ...decision.offer };
      state.live = offer;
      state.liveEvent = list.find((candidate) => candidate.key === offer.key)?.event || null;
      // Speech still downloading (C7): the offer says so; a press of Transcribe waits (answerOffer) instead of failing.
      await emit(runDirectory(offerId), { type: 'meeting.offered', text: await speechReady() ? OFFER_TEXT : DOWNLOADING_TEXT, data: { ...offer, expires: offer.end } });
      onOffer(offer);
    }
    return decision;
  }

  // The only place a recording starts (F4). "record" runs call.py start with the FULL event (B14) and waits for it;
  // "dismiss" only writes the answer. Either way the offer is gone and its key is not offered again.
  async function answerOffer(offerId, answer) {
    if (answer !== 'record' && answer !== 'dismiss') throw new Error('Answer record or dismiss.');
    const offer = state.live;
    if (!offer || offer.offer_id !== offerId) throw new Error('That offer is gone.');
    // Without the microphone and screen permissions nothing starts: permissions.check emits setup.need, the offer stays
    // shown, and the user's next "record" (after Open Settings) tries again.
    if (answer === 'record' && permissions) {
      const need = await permissions.check('record');
      if (need) return { offer_id: offerId, answer, call: null, blocked: need.permission };
    }
    if (answer === 'record' && !await speechReady()) return { offer_id: offerId, answer, call: null, blocked: 'speech' };
    const event = offer.source === 'mic' ? { source: 'mic', title: offer.title } : state.liveEvent;
    state.live = null;
    state.liveEvent = null;
    state.dismissed.add(offer.key);
    const done = async (call) => {
      await emit(runDirectory(offerId), { type: 'meeting.answered', data: { offer_id: offerId, answer, call } });
      return { offer_id: offerId, answer, call };
    };
    if (answer !== 'record') return done(null);
    const result = await runner(python, ['call.py', 'start', offer.title, JSON.stringify(callEvent(event, { now: now() }))],
      { cwd: await transcriber(), env: { ...process.env, LOGGIE_DIR: loggieDirectory, LOGGIE_HIKYAKU_HOME: home }, timeout: START_TIMEOUT_MS });
    if (result.code !== 0) {
      await done(null);
      const said = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim()).filter(Boolean);
      throw new Error(said.at(-1) || 'Recording did not start.');
    }
    const folder = STARTED.exec(result.stdout);
    const call = folder ? basename(folder[1].trim()) : null;
    if (call) state.origins.set(call, { source: offer.source, start: offer.start, end: offer.end });
    return done(call);
  }

  // Record pressed on the Notes & Meetings tab (loggie-meetings-tab): the press is the consent, as Transcribe is on an
  // offer. The Day card and a row hand their event's id (2026-10-27: the card said "Video Meeting with M&T Bank" and the
  // press recorded the school's Sage Hall block, because the title was thrown away for the first event running): that
  // event is recorded, his pick even on a shared calendar, and an offer for another meeting is dismissed. A press with
  // no id (the top row) answers an offer on screen as if Transcribe was pressed; else pickNow (meeting.js) names it from
  // his calendar; with none it is a mic call named by the panel.
  // Record both (alsoEventId, 2026-10-28): eventId is the meeting in the room, alsoEventId the one on the Mac's sound;
  // call.py start --also makes its second folder. A second meeting no calendar holds starts nothing.
  async function startManual(title, { workstream = null, eventId = null, alsoEventId = null } = {}) {
    if ((await readRecording(home))?.call) throw new Error('A call is already recording.');
    const at = now();
    const picked = eventId ? await pressed(eventId, at) : null;
    const other = alsoEventId ? await pressed(alsoEventId, at) : null;
    if (alsoEventId && (!picked || !other)) throw new Error('The other meeting is not on your calendar any more. Record one of them.');
    if (state.live && !other && (!eventId || (picked && state.live.key === picked.key))) return answerOffer(state.live.offer_id, 'record');
    if (permissions) {
      const need = await permissions.check('record');
      if (need) return { call: null, blocked: need.permission };
    }
    if (!await speechReady()) return { call: null, blocked: 'speech' };
    if (state.live) await answerOffer(state.live.offer_id, 'dismiss');
    const happening = picked || (eventId ? null : pickNow(state.list, at, state.micApps));
    const event = happening ? happening.event : { source: 'mic', title };
    const name = happening ? happening.title : title;
    // A workspace he set on the meeting rides into event.json, and call.py keeps it (derive leaves a set workstream).
    const also = other ? ['--also', JSON.stringify(callEvent(other.event, { now: at }))] : [];
    const result = await runner(python, ['call.py', 'start', name, JSON.stringify({ ...callEvent(event, { now: at }), ...(workstream ? { workstream } : {}) }), ...also],
      { cwd: await transcriber(), env: { ...process.env, LOGGIE_DIR: loggieDirectory, LOGGIE_HIKYAKU_HOME: home }, timeout: START_TIMEOUT_MS });
    if (result.code !== 0) {
      const said = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim()).filter(Boolean);
      throw new Error(said.at(-1) || 'Recording did not start.');
    }
    const folder = STARTED.exec(result.stdout);
    const call = folder ? basename(folder[1].trim()) : null;
    if (call) {
      if (happening) state.dismissed.add(happening.key);
      if (other) state.dismissed.add(other.key);
      state.origins.set(call, happening ? { source: 'calendar', start: happening.start, end: happening.end } : { source: 'mic', start: at.toISOString(), end: null });
    }
    return { call, title: name };
  }

  // The event a card or row pressed: its occurrence nearest now (a repeating event keeps one id), from the last read or,
  // for a row outside it (earlier today), one read of the day around now. Folded to its candidate, so the copy with the
  // join link and the people is the one recorded. An id no calendar holds any more records a mic call with the title.
  async function pressed(eventId, at) {
    const nearest = (events) => events.filter((event) => event.id === eventId)
      .sort((a, b) => Math.abs(Date.parse(a.start) - at.getTime()) - Math.abs(Date.parse(b.start) - at.getTime()))[0] || null;
    let raw = nearest(state.events);
    let list = state.list;
    if (!raw) {
      const events = await listEvents({ from: new Date(at.getTime() - DAY_MS / 2), days: 1 }).catch(() => []);
      raw = nearest(events);
      list = candidates(events, { recordCalendars: await recordCalendars() });
    }
    if (!raw) return null;
    const key = `${raw.title}|${raw.start}`;
    return list.find((candidate) => candidate.key === key) || candidates([raw])[0];
  }

  // The only place a recording stops (M4). "stop" starts call.py stop detached and returns at once; "keep" only writes
  // the answer. The call must be the one recording now, so a stale card cannot stop a later call.
  async function endAnswer(call, answer) {
    if (answer !== 'stop' && answer !== 'keep') throw new Error('Answer stop or keep.');
    const recording = await readRecording(home);
    // Either call of a Record both stops the one recording; its log is the recording's folder's.
    if (!recording?.call || (recording.call !== call && !recording.also.includes(call))) throw new Error('That call is not recording.');
    if (answer === 'stop') {
      detach(python, ['call.py', 'stop'], { cwd: await transcriber(), env: { ...process.env, LOGGIE_DIR: loggieDirectory, LOGGIE_HIKYAKU_HOME: home }, log: join(home, 'calls', recording.call, 'stop.log') });
    }
    await emit(runDirectory(state.asks.get(call)?.run || newRunId(now())), { type: 'meeting.end_answered', data: { call, answer } });
    return { call, answer };
  }

  // Pause or resume the one recording (loggie-pause-attach): `call.py pause|resume`, waited for. The recorder writes
  // silence while paused, so the recording, its clock and Stop are unchanged. The call must be the one recording now.
  async function pauseAnswer(call, answer) {
    if (answer !== 'pause' && answer !== 'resume') throw new Error('Answer pause or resume.');
    const recording = await readRecording(home);
    if (!recording?.call || (recording.call !== call && !recording.also.includes(call))) throw new Error('That call is not recording.');
    const result = await runner(python, ['call.py', answer], { cwd: await transcriber(), env: { ...process.env, LOGGIE_DIR: loggieDirectory, LOGGIE_HIKYAKU_HOME: home }, timeout: PAUSE_TIMEOUT_MS });
    const said = `${result.stdout}\n${result.stderr}`.split('\n').map((line) => line.trim()).filter(Boolean);
    if (result.code !== 0) throw new Error(said.at(-1) || `Loggie could not ${answer} the recording.`);
    let out = {};
    try { out = JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { /* the state is read again on the next load */ }
    return { call, paused: Boolean(out.paused), pausedSeconds: Number(out.paused_s) || 0 };
  }

  // One poll now, then the calendar every 60 s and the mic every 5 s; a poll still running is not doubled. Returns the stop.
  function start() {
    let busy = false;
    const tickOf = (options) => async () => {
      if (busy) return;
      busy = true;
      try { await poll(options); } catch (error) { log(`hikyaku meeting watch: ${error.message}`); } finally { busy = false; }
    };
    tickOf({ calendar: true })();
    const timers = [setIntervalImpl(tickOf({ calendar: true }), POLL_S * 1000)];
    if (micOwners) timers.push(setIntervalImpl(tickOf({ calendar: false }), MIC_POLL_S * 1000));
    for (const timer of timers) timer.unref?.();
    return () => timers.forEach((timer) => clearIntervalImpl(timer));
  }

  return { poll, answer: answerOffer, endAnswer, pauseAnswer, startManual, start, state };
}
