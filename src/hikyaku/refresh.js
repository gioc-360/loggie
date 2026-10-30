// The refresh (docs/workstream-integration/proposal.md, increment 4): which workstreams have something new in the
// change log that their summary has not folded in yet, and what to hand the re-read besides new threads. Pure: the
// app (desktop/main.js) reads the files, runs the readers and the model; this decides.
//
// A workstream's catchup-state entry keeps `seen`, the change ids its summary already includes. An item is unseen
// when it is routed to that workstream and its id is not in `seen`. Ids, not times: a calendar item's time is the
// event's start, often in the future, so "newer than the last read" would call it new forever.
export const MAX_SEEN = 500;

export function unseenFor(items, state, name) {
  const seen = new Set(state?.[name]?.seen || []);
  return items.filter((item) => item.workstream === name && !seen.has(item.id));
}

// Workstreams with unseen items, skipping one parked past today. Returns [{ name, items }].
export function changedWorkstreams({ items, state, workstreams, today }) {
  return workstreams
    .filter((workstream) => !workstream.inbox && !workstream.chats && !workstream.folder)
    .filter((workstream) => !(workstream.parkedUntil && workstream.parkedUntil > today))
    .map((workstream) => ({ name: workstream.name, items: unseenFor(items, state, workstream.name) }))
    .filter((entry) => entry.items.length);
}

// A found workspace's first read is the Found step's alone (first-run-polish B4.3, D1): the refresh never reads a found
// card that has no catch-up state yet, kept or not. Its Keep reads it; after that it refreshes like any other. A card
// without `found` (named, or made from a meeting) is never dropped.
export function firstReadsOut(changed, { workstreams = [], state = {} } = {}) {
  const firstRead = new Set(workstreams.filter((workstream) => workstream?.found && !(state && workstream.name in state)).map((workstream) => workstream.name));
  return changed.filter((entry) => !firstRead.has(entry.name));
}

// The re-read's extra lines: each new call with its goal line and next steps (gather.js eventLines), and each dated
// calendar item ahead of now. `callLines` maps a call folder to its lines.
export function contextLines({ items, callLines = new Map(), now }) {
  const lines = [];
  for (const item of items) {
    if (item.source === 'call') {
      const rows = callLines.get(item.thread) || [];
      lines.push(`- Call "${item.title}" on ${item.at.slice(0, 10)}${rows.length ? `:\n${rows.map((row) => `  - ${row}`).join('\n')}` : ' (no summary yet)'}`);
    } else if (item.source === 'calendar' && Date.parse(item.at) >= now) {
      lines.push(`- On the calendar: "${item.title}" on ${item.at.slice(0, 10)}`);
    }
  }
  return lines;
}

// Dated things ahead, for the bars' diamonds: calendar items only, so a date shown came from the calendar.
export function milestonesFrom(items, now) {
  return items.filter((item) => item.source === 'calendar' && Date.parse(item.at) >= now)
    .map((item) => ({ at: item.at, title: item.title, source: 'calendar' }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// The state entry after a refresh: the ids now included (newest MAX_SEEN kept), the milestones merged and past
// ones dropped, and asOf.
export function nextState(previous = {}, { items, now, ...fields }) {
  const seen = [...new Set([...(previous.seen || []), ...items.map((item) => item.id)])].slice(-MAX_SEEN);
  const byKey = new Map([...(previous.milestones || []), ...milestonesFrom(items, now)].map((m) => [`${m.at}|${m.title}`, m]));
  const milestones = [...byKey.values()].filter((m) => Date.parse(m.at) >= now).sort((a, b) => a.at.localeCompare(b.at));
  return { ...previous, ...fields, seen, milestones, asOf: new Date(now).toISOString() };
}

// Chats routed here: their ids, newest first, at most `limit`, so the re-read can fetch each one.
export function routedChats(items, limit = 5) {
  const newest = new Map();
  for (const item of items.filter((i) => i.source === 'messages' || i.source === 'whatsapp').sort((a, b) => b.at.localeCompare(a.at))) {
    if (!newest.has(item.thread)) newest.set(item.thread, item);
  }
  return [...newest.values()].slice(0, limit);
}

// Which changed workstreams the refresh re-reads, and why the others wait (increment 5). `auto` is the timer's run: a
// workspace with something new is re-read within the hour, at most AUTO_READS times a day (loggie-workspaces-
// integration, Gio 10-26 "Within the hour"; before it was once a day: 776 timer runs made 6 reads in 7 days), none for
// a just-keep-me-posted one. `overBudget` holds back the cloud ones once today's spend reached the limit. First rule
// that matches wins. The goal string is workstreams.js QUIET_GOAL, written out so this file stays free of imports.
export const AUTO_READS = 6;
export const AUTO_GAP_MS = 60 * 60000;
export function refreshPlan({ changed, state, workstreams, today, auto = false, overBudget = false, now = Date.now() }) {
  return changed.map(({ name, items }) => {
    const workstream = workstreams.find((w) => w.name === name) || {};
    const reads = state?.[name]?.autoReads?.day === today ? state[name].autoReads : null;
    let reason = '';
    if (auto && reads && reads.count >= AUTO_READS) reason = `${AUTO_READS} reads today already`;
    else if (auto && reads && now - Date.parse(reads.last) < AUTO_GAP_MS) reason = 'read within the last hour';
    else if (auto && workstream.goal === 'Just keep me posted') reason = 'just keep me posted';
    else if (overBudget && workstream.cloud === 'nebius') reason = "over today's cloud limit";
    return { name, items, action: reason ? 'skip' : 'read', reason };
  });
}
