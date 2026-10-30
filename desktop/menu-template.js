// The Mac's own right-click menu, from the ids a page sent (loggie right-click, 2026-10-28;
// ~/Loggie/workspace/right-click-proposal.md). The words live here, never on the page: an item crosses as its id and
// its pick comes back as that id, so the menu cannot say one thing and do another. Every item says what happens (a
// macOS toolTip); a line Loggie knows (who it would reach, why an item cannot run) is a grey line under it, as Finder
// does. No electron import: main-ipc-menu.js passes Menu in, so the tests build the menu with a fake. No motion of ours.

const APP_WORD = { outlook: 'Outlook', 'apple-mail': 'Mail' };
const NO_NOTES = 'no notes yet · Summarize first';

// The Share lines, the same on the Share button and under Share ▸ (one function on the page, shareCall).
function shareEntries(share, onPick) {
  const people = share?.people || 0;
  const notes = Boolean(share?.notes);
  const app = APP_WORD[share?.app] || 'your mail app';
  return [
    { label: people === 1 ? 'Send notes to the person on this call' : `Send notes to the ${people} people on this call`, enabled: notes && people > 0,
      toolTip: `Opens an email in ${app} with the notes, to the people on this call, unsent. You press Send.`, click: () => onPick('people'),
      line: !notes ? NO_NOTES : people ? `an email in ${app}, unsent · you press Send` : 'no addresses on this call' },
    { label: 'Share sheet…', enabled: notes, toolTip: 'The Mac’s share sheet with the notes: Mail, Messages, AirDrop, Notes, Copy.', click: () => onPick('sheet'),
      line: notes ? 'Mail, Messages, AirDrop, Notes, Copy' : NO_NOTES },
  ];
}

// A built entry and its grey line under it, as two menu items: the line is a disabled item, never pressable.
const withLine = ({ line, ...entry }) => (line ? [entry, { label: line, enabled: false }] : [entry]);

// A recording's first line: its guess to press, else where it is.
const guessLabel = (item) => (item.enabled ? `${item.value}?` : item.value ? `In ${item.value}` : item.on ? 'In no workspace' : 'Not filed yet');
// Add to workspace ▸: the picker's names, the guess marked as the chip marks it, the current one checked, No workspace
// last after a rule.
const fileEntries = (entries, pick) => entries.flatMap((entry) => {
  const one = { label: entry.value === null ? 'No workspace' : entry.guess ? `${entry.value}?` : entry.value, type: 'checkhouse', checked: Boolean(entry.on), click: () => pick({ id: 'file', value: entry.value }),
    toolTip: entry.value === null ? 'Keeps it out of every workspace; its moves there are set aside, with Undo.' : `Files it under ${entry.value}: its next steps land on that card.` };
  return entry.guess ? [one, { label: 'Loggie’s guess', enabled: false }] : entry.value === null ? [{ type: 'separator' }, one] : [one];
});
const RECORDING = {
  open: ['Open notes', 'Opens its notes page.'],
  copy: ['Copy notes', 'Copies its notes: yours, the summary and the next steps.'],
  rename: ['Rename', 'Opens it with the caret in its title.'],
  trash: ['Delete recording', 'Moves its folder (notes, audio, transcript) to the Trash, after you confirm. Recoverable from Finder.'],
};
// A workspace row's words and what each does; the stakes and Park are checks, as the More row's pressed taps are.
const WORKSPACE = {
  'catch-up': ['Catch up now', 'Loggie reads what is new here and writes what changed.'],
  open: ['Open', 'Opens its page.'],
  more: ['Matters more', 'Ranks it above the others. Again to take it off.'],
  less: ['Matters less', 'Ranks it below the others. Again to take it off.'],
  park: ['Park until…', 'Opens its page with the days to park it until.'],
  rename: ['Edit name', 'Opens its page with the name box open.'],
  retire: ['Retire', 'It stops filing new mail and chats; its history stays. Its open moves are asked about on its page.'],
};
const CHECKS = new Set(['more', 'less', 'park']);
// A move's words: the row's own presses.
const MOVE = {
  draft: ['Draft it with Loggie', 'Opens the line box on the row; Enter has Loggie write it in your mail app, unsent.'],
  done: ['Done', 'Marks it done, with Undo.'],
  date: ['New date…', 'Opens the date box on the row.'],
  drop: ['Drop it', 'Drops it, with Undo.'],
  call: ['Open the call it came from', 'Opens that call on Notes & Meetings.'],
};
// A rule after these, as the proposal's groups: what Loggie knows and where it goes; what to do with it; the Trash.
const SPLIT_AFTER = { recording: ['file', 'rename'], workspace: ['open', 'park'], move: ['draft', 'drop'] };

const KINDS = {
  recording: (menu, { share, pick }) => menu.items.flatMap((item) => {
    let entry;
    if (item.id === 'guess') entry = { label: guessLabel(item), enabled: item.enabled, click: () => pick({ id: 'guess', value: item.value ?? null }), line: item.enabled && item.line ? `${item.line} · one press files it` : null, toolTip: item.enabled ? `Files it under ${item.value}: its next steps land on that card.` : 'Where this recording is.' };
    else if (item.id === 'file') entry = { label: 'Add to workspace', enabled: item.enabled, submenu: fileEntries(item.submenu || [], pick), toolTip: 'Files it under one of your workspaces.' };
    else if (item.id === 'share') entry = { label: 'Share', enabled: item.enabled, submenu: shareEntries(share, (value) => pick({ id: 'share', value })).flatMap(withLine), toolTip: 'Sends its notes to the people on it, or through the share sheet.' };
    else entry = { label: RECORDING[item.id][0], enabled: item.enabled, toolTip: RECORDING[item.id][1], click: () => pick({ id: item.id, value: null }), line: item.line || null };
    return SPLIT_AFTER.recording.includes(item.id) ? [entry, { type: 'separator' }] : [entry];
  }),
  workspace: (menu, { pick }) => menu.items.flatMap((item) => {
    const [label, toolTip] = WORKSPACE[item.id];
    const entry = { label, enabled: item.enabled, toolTip, click: () => pick({ id: item.id, value: null }), line: item.line || null, ...(CHECKS.has(item.id) ? { type: 'checkhouse', checked: Boolean(item.on) } : {}) };
    return SPLIT_AFTER.workspace.includes(item.id) ? [entry, { type: 'separator' }] : [entry];
  }),
  move: (menu, { pick }) => menu.items.flatMap((item) => {
    const [label, toolTip] = MOVE[item.id];
    const entry = { label, enabled: item.enabled, toolTip, click: () => pick({ id: item.id, value: null }), line: item.line || null };
    return SPLIT_AFTER.move.includes(item.id) ? [entry, { type: 'separator' }] : [entry];
  }),
  share: (menu, { share, pick }) => shareEntries(share, (id) => pick({ id, value: null }))
    .filter((_entry, index) => menu.items.some((item) => item.id === ['people', 'sheet'][index])),
  // The Mac's own roles act on the field; the pick needs nothing of the page.
  text: (menu) => menu.items.map((item) => ({ role: item.id, enabled: item.enabled })),
};

export function menuTemplate(menu, { share = null, pick = () => {} } = {}) {
  if (!KINDS[menu.kind]) throw new Error(`No menu for ${menu.kind}.`);
  return KINDS[menu.kind](menu, { share, pick }).flatMap((entry) => (entry.type === 'separator' ? [entry] : withLine(entry)));
}

// Draws the menu at the pointer and answers { id, value } for the pick, or { id: null } when it closed with none (Esc,
// a click away). The close can come just before the click on macOS, so a close waits `delayMs` for a click.
export function popupMenu({ Menu, window = null, menu, share = null, delayMs = 150 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (picked) => { if (!done) { done = true; resolve(picked); } };
    const built = Menu.buildFromTemplate(menuTemplate(menu, { share, pick: (picked) => finish({ id: picked.id, value: picked.value ?? null }) }));
    built.popup({ ...(window ? { window } : {}), callback: () => setTimeout(() => finish({ id: null, value: null }), delayMs) });
  });
}
