// One checklist row, drawn the same on setup's Ready step and on Settings' "Your Mac" (loggie-diagnostics): its state
// pill, label, note, one button, a switch when the row has one, and a bar while a download runs. The caller says what a
// press does. Still: the pill is simply there (setup's first draw adds its own cascade through `delay`).
import { el } from './move-view.js';

const WORDS = { on: 'On', off: 'Off', optional: 'Optional', note: 'Note', 'after-reopen': 'After reopen' };

export function checklistItem(row, { onPress = () => {}, onToggle = null, onChange = null, delay = null, buttonClass = 'su-plain small' } = {}) {
  const item = el('li');
  item.dataset.row = row.key;
  const pill = el('span', `st ${row.state}`, WORDS[row.state] || row.state);
  if (delay !== null) { pill.classList.add('is-cascade'); pill.style.animationDelay = `${delay}ms`; }
  item.append(pill, el('span', 'lbl', row.label));
  // A row that switches (chats): its switch is the control; a button still shows for what the switch needs (a pane).
  if ('toggle' in row && onToggle) {
    const on = row.toggle === true;
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', `${row.label.split(':')[0]}: ${on ? 'on' : 'off'}`);
    sw.addEventListener('click', () => onToggle(row, !on, item));
    item.append(sw);
  }
  if (row.note) item.append(el('span', 'su-note', row.note));
  if (row.button) {
    const press = el('button', buttonClass, row.button.label);
    press.type = 'button';
    press.addEventListener('click', () => onPress(row, item));
    item.append(press);
  }
  // A row with a choice (the mail app on Settings' Your Mac): Change opens the choices in the row, the current one
  // pressed; a pick goes to onChange. An app that is not on this Mac is shown, greyed, and cannot be picked.
  if (row.change && onChange) {
    const open = el('button', buttonClass, 'Change');
    open.type = 'button';
    open.setAttribute('aria-expanded', 'false');
    const choices = el('div', 'mac-choices');
    choices.hidden = true;
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', `${row.label.split(':')[0]}: change`);
    for (const choice of row.change.choices) {
      const pick = el('button', 'choice', choice.installed ? choice.label : `${choice.label} · not on this Mac`);
      pick.type = 'button';
      pick.dataset.choice = choice.id;
      pick.setAttribute('aria-pressed', String(choice.id === row.change.current));
      pick.disabled = !choice.installed;
      if (choice.installed && choice.id !== row.change.current) pick.addEventListener('click', () => onChange(row, choice.id, item));
      choices.append(pick);
    }
    open.addEventListener('click', () => { choices.hidden = !choices.hidden; open.setAttribute('aria-expanded', String(!choices.hidden)); });
    item.append(open, choices);
  }
  if (row.fill !== null && row.fill !== undefined) {
    const bar = el('div', 'su-fill');
    const fill = el('i');
    fill.style.transform = `scaleX(${row.fill})`;
    bar.append(fill);
    item.append(bar);
  }
  return item;
}
