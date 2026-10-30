// What a right-click menu holds (loggie right-click, 2026-10-28; ~/Loggie/workspace/right-click-proposal.md): for each
// kind of thing, its items' ids in order, and for one thing which of them can run now, what is checked, and the grey
// line Loggie already knows. Pure, no DOM. Only these ids cross to main (ipc-validation.js); the words live in main
// (desktop/menu-template.js), and each id runs the function its visible control already calls. An item that cannot
// run is greyed with its reason, never hidden.

export const MENU_ITEMS = Object.freeze({
  recording: Object.freeze(['guess', 'file', 'share', 'open', 'copy', 'rename', 'trash']),
  share: Object.freeze(['people', 'sheet']),
  workspace: Object.freeze(['catch-up', 'open', 'more', 'less', 'park', 'rename', 'retire']),
  move: Object.freeze(['draft', 'done', 'date', 'drop', 'call']),
  text: Object.freeze(['cut', 'copy', 'paste', 'selectAll']),
});
export const LINE_MAX = 80;
export const MAX_NAMES = 40;
// What still owns a call's folder (call-list.js states): Delete waits, and says why (call-trash.js, the same words).
export const CALL_BUSY = Object.freeze({ recording: 'it is still recording', transcribing: 'its transcript is still being written', writing: 'its notes are still being written', waiting: 'it is waiting for your yes to summarize' });

const clip = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);

// A recording: the line Loggie knows first (its guess with the evidence, one press files it; else where it is), then
// the picker's names (meetings-model.js pickerNames: the guess first) with the current one checked and No workspace
// last, never a new workspace. While it records there is no chip, so nothing files from here either.
function recording({ call = {}, names = [] }) {
  const filed = call.workstream || null;
  const guess = !filed && !call.noWorkspace && call.guess && call.evidence ? call.guess : null;
  const live = call.state === 'recording';
  const early = live || call.state === 'transcribing';
  const kept = [...new Set(names.filter((name) => typeof name === 'string' && name.trim() && name.length <= 60))].slice(0, MAX_NAMES);
  const busy = CALL_BUSY[call.state];
  return [
    guess ? { id: 'guess', enabled: !live, value: guess, line: clip(call.evidence) } : { id: 'guess', enabled: false, value: filed, on: Boolean(filed || call.noWorkspace) },
    { id: 'file', enabled: !live && kept.length > 0, submenu: [...kept.map((value) => ({ value, on: value === filed, ...(value === guess ? { guess: true } : {}) })), { value: null, on: !filed && Boolean(call.noWorkspace) }] },
    { id: 'share', enabled: !early },
    { id: 'open', enabled: true },
    { id: 'copy', enabled: !early },
    { id: 'rename', enabled: true },
    busy ? { id: 'trash', enabled: false, line: `not now: ${busy}` } : { id: 'trash', enabled: true },
  ];
}

// A workspace row: Catch up now with what its row says is new (workspaces-model.js freshLine), Open, the stakes and
// Park checked when on, then its name and Retire, which only a workspace of his has (not Inbox, Chats or a folder).
function workspace({ card = {}, fresh = '' }) {
  const named = !card.inbox && !card.chats && !card.folder;
  const stake = card.stake ?? card.priority?.stake;
  const parked = Boolean(card.priority?.parked);
  const mine = named ? null : 'not one of your workspaces';
  return [
    card.quiet ? { id: 'catch-up', enabled: false, line: 'Just keep me posted: read with the rest' } : { id: 'catch-up', enabled: true, ...(clip(fresh) ? { line: clip(fresh) } : {}) },
    { id: 'open', enabled: true },
    { id: 'more', enabled: true, on: stake === 'more' },
    { id: 'less', enabled: true, on: stake === 'less' },
    { id: 'park', enabled: true, on: parked },
    mine ? { id: 'rename', enabled: false, line: mine } : { id: 'rename', enabled: true },
    mine ? { id: 'retire', enabled: false, line: mine } : card.newFound ? { id: 'retire', enabled: false, line: 'Keep or Dismiss it on its page first' } : { id: 'retire', enabled: true },
  ];
}

// A move on a workspace's page: Draft it and where it would land (only Loggie writes the email in the right app for
// him to send), then the row's hover marks, then the call it came from.
function move({ move: m = {}, toSend = false, appName = 'your mail app' }) {
  const draft = !toSend ? { id: 'draft', enabled: false, line: 'nothing to send for this one' }
    : m.sendable === false ? { id: 'draft', enabled: false, line: 'text it from your iPhone: this Mac cannot send SMS or RCS' }
      : { id: 'draft', enabled: true, line: clip(`in ${appName}${m.to ? `, to ${m.to}` : ''} · unsent, you press Send`) };
  return [
    draft,
    { id: 'done', enabled: true },
    { id: 'date', enabled: true },
    { id: 'drop', enabled: true },
    m.call?.folder ? { id: 'call', enabled: true, ...(clip(m.call.title) ? { line: clip(m.call.title) } : {}) } : { id: 'call', enabled: false, line: 'it did not come from a call' },
  ];
}

const MENUS = {
  recording,
  workspace,
  move,
  // The Share button and Share ▸: main fills in the people count and greys a line that cannot run.
  share: () => [{ id: 'people', enabled: true }, { id: 'sheet', enabled: true }],
  // A text field or selected text: the Mac's own Cut, Copy, Paste and Select All, as each can run there.
  text: ({ editable = false, selected = false }) => [
    { id: 'cut', enabled: editable && selected }, { id: 'copy', enabled: selected }, { id: 'paste', enabled: editable }, { id: 'selectAll', enabled: true },
  ],
};

export function menuFor(kind, state = {}) {
  if (!Object.hasOwn(MENUS, kind)) throw new Error(`No menu for ${kind}.`);
  return MENUS[kind](state);
}
