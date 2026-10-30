// One pick on Today, drawn as an open card or a one-line row (docs/prototype-port/spec-b.md, the mock-up's MoveCard).
// The open card says what, for which workspace, why, in whose words, and holds one button; the first card's button is
// the only filled one on the page (today.css). Every press goes to today.js through act(name, value); this file calls
// nothing itself.
import { icon } from './icons.js';
import { APP_NAMES, buttonOf, canReplyTo, firstNameOf, metaOf, quoteOf, replyTip, titleOf, whyOf } from './today-model.js';

export function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}
export function button(label, onClick, className = '') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// entry: today-model matchPick's { pick, card, move, active }. box: 'say', 'date' or null. status: the last outcome
// for this task, or ''. questionNode: the question card (panel.js needsCard) when Loggie stopped on this pick.
export function moveCard({ entry, open, first, source, today, status = '', box = null, act, questionNode = null, typed = null, focus = false, replyNode = null }) {
  const id = entry.pick.taskId;
  const title = titleOf(entry);
  const meta = metaOf(entry, { source, today });
  if (!open) {
    const row = el('li', 'today-line');
    row.dataset.taskId = id;
    // A pick Loggie stopped on says so even closed: "?" and the question waits inside.
    const asking = buttonOf(entry).kind === 'answer';
    const line = button(`${asking ? '?' : '★'} ${title} · ${asking ? 'Loggie needs your answer · ' : ''}${meta.text}`, () => act('toggle'), `today-line-open${asking ? ' is-asking' : ''}`);
    line.setAttribute('aria-expanded', 'false');
    line.title = title;
    row.append(line);
    if (status) row.append(statusLine(status));
    return row;
  }
  const card = el('li', `today-card${first ? ' is-first' : ''}${entry.move?.notSure ? ' is-unsure' : ''}`);
  card.dataset.taskId = id;
  if (entry.move?.notSure) card.title = `Not sure: ${entry.move.notSure}`;
  const head = el('header');
  const name = button(title, () => act('toggle'), 'today-title');
  name.setAttribute('aria-expanded', 'true');
  // The workspace's name is a door to its card (loggie-workspaces-integration F7), the rest of the line as before.
  const metaNode = el('span', `today-meta${meta.late ? ' is-late' : ''}`);
  const wsName = entry.card ? entry.card.label || entry.card.name : entry.pick.name;
  if (wsName && meta.text.startsWith(wsName)) {
    const door = button(wsName, () => document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'workspaces', workspace: entry.card?.name || entry.pick.name } })), 'today-ws');
    door.title = `Open ${wsName}`;
    metaNode.append(door, meta.text.slice(wsName.length));
  } else metaNode.textContent = meta.text;
  head.append(name, metaNode);
  card.append(head);
  const why = whyOf(entry.pick);
  if (why) card.append(el('p', 'today-why', why));
  const quote = quoteOf(entry);
  if (quote) {
    // A quote from a call opens that call on Notes & Meetings; one from mail or a chat has nowhere to go here.
    const said = quote.folder ? button('', () => act('quote', quote.folder), 'today-quote is-call') : el('p', 'today-quote');
    if (quote.folder) said.title = 'Open this call';
    said.append(el('span', '', `“${quote.text}”`));
    const by = [quote.who, quote.when].filter(Boolean).join(', ');
    if (by) said.append(el('small', '', ` ${by}`));
    card.append(said);
  }
  const kind = buttonOf(entry);
  if (kind.kind === 'answer' && questionNode) card.append(questionNode);
  const foot = el('footer');
  if (kind.kind === 'app' || kind.kind === 'phone') {
    const go = button(kind.label, () => act('app'), 'primary today-go');
    go.disabled = kind.kind === 'phone';
    foot.append(go);
  } else if (kind.kind === 'open') foot.append(button(kind.label, () => act('open'), 'primary today-open'));
  else if (kind.kind === 'do-it') {
    // The Loggie mark and the word: Loggie drafts it, the person sends it (D2).
    const draft = button('', () => act('do-it'), 'primary today-do');
    draft.append(icon('loggie', 'today-mark'), kind.label);
    draft.setAttribute('aria-label', 'Draft it with Loggie');
    foot.append(draft);
  }
  foot.append(button('Not this', () => act('not-this'), 'today-not'));
  if (entry.move) {
    const marks = el('span', 'ws-marks');
    const mark = (sign, label, name) => { const node = button('', () => act(name), 'ws-act'); node.setAttribute('aria-label', `${label}: ${title}`); node.title = label; node.append(icon(sign)); return node; };
    marks.append(mark('check', 'Done', 'done'), mark('cal', 'New date', 'date'));
    // A To do move from a person's email: Reply opens the line box for a reply to that email (today-model.js canReplyTo).
    if (canReplyTo(entry.move)) marks.append(mark('reply', replyTip(entry.move), 'reply'));
    foot.append(marks);
  }
  card.append(foot);
  if (box === 'say' && entry.move) card.append(sayBox(entry, act, { typed, focus }));
  if (box === 'reply' && entry.move && canReplyTo(entry.move)) card.append(sayBox(entry, act, { typed, focus, reply: true }));
  if (box === 'date' && entry.move) card.append(dateBox(entry, today, act, { typed, focus }));
  // A Reply going on this move (reply-row.js): its yes, progress and outcome, the same row as on Workspaces.
  if (replyNode) card.append(replyNode);
  card.append(statusLine(status || (kind.kind === 'busy' ? kind.label : '')));
  return card;
}

function statusLine(text) {
  const line = el('p', 'move-status', text || '');
  line.setAttribute('role', 'status');
  line.hidden = !text;
  return line;
}

// What the draft should say. A move from a text opens with what the text asked (move-card.js askLine), caret at the
// end, for the user to finish; nothing goes anywhere before Enter. reply: the same box for a To do move's Reply, whose
// Enter drafts a reply to the email the move came from.
function sayBox(entry, act, { typed = null, focus = false, reply = false } = {}) {
  const box = el('div', 'today-box');
  const input = el('input', 'today-say');
  input.type = 'text';
  input.maxLength = 1000;
  input.placeholder = 'What should it say?';
  const app = APP_NAMES[entry.move.app] || 'your mail app';
  input.setAttribute('aria-label', reply ? `What the reply to ${firstNameOf(entry.move.from)} in ${app} should say` : `What the draft to ${app} should say`);
  input.value = typed ?? (reply ? '' : entry.move.askLine || '');
  const press = reply ? 'send-reply' : 'say';
  const send = button('', () => act(press, input.value), 'today-send');
  send.setAttribute('aria-label', reply ? 'Draft the reply' : 'Draft it');
  send.title = reply ? 'Draft the reply' : 'Draft it';
  send.append(icon('up'));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); act(press, input.value); }
    if (event.key === 'Escape') act('close');
  });
  box.append(input, send);
  if (focus) setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  return box;
}

export const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));

function dateBox(entry, today, act, { typed = null, focus = false } = {}) {
  const box = el('div', 'today-box');
  const input = el('input', 'today-date');
  input.type = 'date';
  input.min = today;
  // Text typed into the open line box is not a date (2026-10-21: it threw when New date opened over it).
  input.value = isDay(typed) ? typed : (entry.move.due && entry.move.due >= today ? entry.move.due : today);
  input.setAttribute('aria-label', `New date for ${entry.move.title}`);
  const save = button('', () => act('save-date', input.value), 'today-send');
  save.setAttribute('aria-label', 'Save the new date');
  save.title = 'Save the new date';
  save.append(icon('check'));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); act('save-date', input.value); }
    if (event.key === 'Escape') act('close');
  });
  box.append(input, save);
  if (focus) setTimeout(() => input.focus(), 0);
  return box;
}
