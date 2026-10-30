// One recording or meeting looks and files the same in every place (loggie-meetings-focus cycle 2, the 5S of it: one
// chip, one picker, one result line), on the Day card, the Day's rows and Recordings. Scope:
// ~/Loggie/workspace/meetings-integration-scope.md. No motion: a press redraws to a still end state.

function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}
function button(label, onClick, className = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', (event) => { event.stopPropagation(); onClick(event); });
  return node;
}

// The chip, three looks: placed (a dot and the name), Loggie's guess (the name and "?", shown only with evidence, which
// follows it in muted words; yellow when `loud`), none (dashed "Pick a workspace", also for a guess nothing backs). A
// press opens the picker; it never files by itself, so a wrong guess costs a second press, not a wrong filing.
export function chipNode({ workstream = null, guess = null, evidence = '', retired = false, noWorkspace = false } = {}, { loud = true, open = false, onPress = () => {} } = {}) {
  const wrap = el('span', 'mr-chipline');
  let chip;
  if (!workstream && noWorkspace) {
    // In no workspace on purpose (a one-time recording, or taken off a wrong one): said plainly, muted, still changeable.
    chip = button('No workspace', onPress, 'mr-chip is-placed is-nows');
    chip.setAttribute('aria-label', 'No workspace. Change');
  } else if (workstream) {
    // A retired workspace keeps its name on its recordings, muted, with the word (his choice for gone names, 10-25).
    chip = button('', onPress, `mr-chip is-placed${retired ? ' is-retired' : ''}`);
    chip.append(el('i'), retired ? `${workstream} · retired` : workstream);
    chip.setAttribute('aria-label', `Workspace: ${workstream}${retired ? ', retired' : ''}. Change`);
  } else if (guess && evidence) {
    chip = button(`${guess}?`, onPress, `mr-chip${loud ? ' is-guess' : ''}`);
    chip.setAttribute('aria-label', `Loggie guesses ${guess}: ${evidence}. Confirm or change`);
  } else {
    chip = button('Pick a workspace', onPress, 'mr-chip is-none');
  }
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', String(open));
  wrap.append(chip);
  if (!workstream && guess && evidence) wrap.append(el('span', 'mr-evidence', evidence));
  return wrap;
}

// The picker: a row of pills under the row or card, inline (no overlay): the guess first, the workspaces by name,
// "New workspace…" only where a meeting has no recording (a recording never adds a workspace, Gio 10-17, kept 10-25),
// Cancel. `names` are the live workspaces (meetings-model.js pickerNames).
// A guess nothing backs is still first, but plain: only evidence earns the yellow.
// `onNone`: a recording's "No workspace", last before Cancel, for a one-time call or one filed by mistake (2026-10-26).
export function pickerNode({ names = [], workstream = null, guess = null, evidence = '', noWorkspace = false, onPick = () => {}, onNew = null, onNone = null, onCancel = () => {} } = {}) {
  const menu = el('div', 'mr-picker');
  menu.setAttribute('role', 'menu');
  for (const name of names) {
    const pill = button(name, () => onPick(name), `mr-pick${name === workstream ? ' is-on' : ''}${!workstream && evidence && name === guess ? ' is-guess' : ''}`);
    pill.setAttribute('role', 'menuitem');
    menu.append(pill);
  }
  if (!names.length) menu.append(el('span', 'mr-note', 'Open Workspaces once to load your workspaces.'));
  if (onNew) menu.append(button('New workspace…', onNew, 'mr-pick is-new'));
  if (onNone) {
    const none = button('No workspace', onNone, `mr-pick is-nows${noWorkspace && !workstream ? ' is-on' : ''}`);
    none.setAttribute('role', 'menuitem');
    none.title = workstream ? `Take it off ${workstream}: its moves there are set aside, with Undo` : 'A one-time recording: it stays out of every workspace';
    menu.append(none);
  }
  menu.append(button('Cancel', onCancel, 'mr-pick is-cancel'));
  return menu;
}

// What filing did, from hikyaku:file-call's answer (refile.js: to, created, notes): the workspace, what landed on its
// card, and the way there. Still text; it stays until the next redraw of that row's mode.
export function payoffText(result = {}) {
  if (result.none) {
    const moved = Array.isArray(result.retired) ? result.retired.length : 0;
    return result.from ? `Taken off ${result.from}${moved ? ` · ${moved} ${moved === 1 ? 'move' : 'moves'} set aside there` : ''}` : 'In no workspace';
  }
  const steps = Array.isArray(result.created) ? result.created.length : 0;
  const parts = [`Filed under ${result.to}`];
  if (result.notes) parts.push('notes on its card');
  if (steps) parts.push(`${steps} next ${steps === 1 ? 'step' : 'steps'} on its card`);
  if (!result.notes && result.summarized === false) parts.push('notes will land on its card when written');
  if (result.reading) parts.push('its card reads it now');
  return parts.join(' · ');
}
export function payoffNode(result, { onOpenWorkspace = () => {} } = {}) {
  const line = el('p', 'mr-payoff');
  line.setAttribute('role', 'status');
  // "No workspace" has no workspace to open: the line alone (the moves set aside come back with Undo on their card).
  if (result.none) line.append(el('span', '', payoffText(result)));
  else line.append(el('span', '', `${payoffText(result)} · `), button('Open the workspace', () => onOpenWorkspace(result.to), 'mr-link'));
  return line;
}
