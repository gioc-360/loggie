// The Today page (docs/prototype-port/spec-b.md): the first pick open with the one filled button, the other picks one
// line each, drafts ready to open, then the "?" rows Loggie stopped on. It keeps which pick is open and which box is
// up across redraws, and sends every press to the api panel.js passes in; nothing is sent from here (drafts open in
// the mail app, unsent).
import { localToday } from './icons.js';
import { button, el, moveCard } from './move-view.js';
import { buttonOf, firstNameOf, questionFor, todayItems } from './today-model.js';

const FIRST_RUN = 'No workspaces yet. They come from your mail once Loggie may read it.';

export function createTodayView({ root, heading, api, outcomes, questionCard, onChanged = async () => {}, replies = null }) {
  let openId = null;   // null: the first pick is open; '': none; else that pick's task id
  let box = null;      // { id, kind: 'say' | 'date' }
  let openRow = null;  // the "?" row whose card is open
  let rowCard = null;  // { key, text, node }: the open row's card, kept across redraws so a half-typed answer stays
  let last = { picks: [], source: null, cards: [], rows: [] };

  function draw(data = last) {
    last = data;
    const today = localToday();
    const { state, entries, ready, rows } = todayItems(data);
    if (openId && !entries.some((entry) => entry.pick.taskId === openId)) openId = null;
    if (box && !entries.some((entry) => entry.pick.taskId === box.id)) box = null;
    if (openRow && !rows.some((row) => row.key === openRow)) { openRow = null; rowCard = null; }
    heading.textContent = entries.length ? 'First today' : 'Nothing first today.';
    // Words typed into an open box, and its focus, survive a redraw (the lists reload every few seconds).
    const prior = root.querySelector('.today-say, .today-date');
    const typed = box && !box.fresh && prior ? prior.value : null;
    const hadFocus = Boolean(prior) && document.activeElement === prior;
    const caret = hadFocus && prior.type === 'text' ? [prior.selectionStart, prior.selectionEnd] : null;
    const isOpen = (entry, index) => (openId === null ? index === 0 : openId === entry.pick.taskId);
    // The one open card holds the page's one filled button; with none open, the first live card does (today.css).
    root.closest('[data-page]')?.toggleAttribute('data-first', entries.some(isOpen));
    const items = entries.map((entry, index) => {
      const id = entry.pick.taskId;
      const open = isOpen(entry, index);
      const question = questionFor(entry);
      return moveCard({
        entry, open, first: open, source: data.source, today,
        status: outcomes.get(id) || '', box: box?.id === id ? box.kind : null,
        typed: box?.id === id ? typed : null, focus: box?.id === id && Boolean(box.fresh),
        questionNode: open && question && buttonOf(entry).kind === 'answer' ? questionCard(entry.card, question) : null,
        act: (name, value) => act(entry, name, value),
        replyNode: entry.move ? replies?.node(entry.move.id, { app: entry.move.app }) : null,
      });
    });
    if (state === 'first-run') items.push(el('li', 'today-empty', FIRST_RUN));
    for (const { active } of ready) {
      const line = el('li', 'today-ready');
      line.dataset.ready = active.id;
      const again = active.phase === 'in-mail-app';
      const open = button(again ? 'Open again' : 'Open', () => run(active.id, () => api.openDraft(active.id, { again })));
      open.setAttribute('aria-label', `${again ? 'Open again' : 'Open'} in your mail app: ${active.title}`);
      line.append(el('span', '', `▸ ${active.title}`), open);
      if (outcomes.get(active.id)) line.append(el('p', 'move-status', outcomes.get(active.id)));
      items.push(line);
    }
    for (const row of rows) items.push(rowItem(row));
    root.replaceChildren(...items);
    if (box) box.fresh = false;
    if (hadFocus) {
      const again = root.querySelector('.today-say, .today-date');
      again?.focus();
      if (again && caret) again.setSelectionRange(...caret);
    }
  }

  // One thing Loggie stopped on: the row opens its card under it (the same cards as before), or a call's guess opens
  // that call's picker on Notes & Meetings.
  function rowItem(row) {
    const item = el('li', 'today-row');
    item.dataset.key = row.key;
    const line = button('', () => {
      if (row.go) { row.go(); return; }
      openRow = openRow === row.key ? null : row.key;
      rowCard = null;
      if (openRow) api.uiAct?.({ act: 'needs-open', name: row.key.split(':')[0] }).catch(() => {});
      draw();
    }, `qrow${row.guess ? ' is-guess' : ''}`);
    if (row.render) line.setAttribute('aria-expanded', String(openRow === row.key));
    line.title = row.text;
    const mark = el('span', '', row.mark);
    mark.setAttribute('aria-hidden', 'true');
    line.append(mark, el('span', 'qtext', row.text));
    item.append(line);
    if (openRow === row.key && row.render) {
      if (!rowCard || rowCard.key !== row.key || rowCard.text !== row.text) {
        const card = el('div', 'today-row-card');
        card.append(...row.render());
        rowCard = { key: row.key, text: row.text, node: card };
      }
      item.append(rowCard.node);
    }
    return item;
  }

  // A press on a pick: the box opens or closes with no call; everything else reaches the app, then the lists reload.
  async function act(entry, name, value) {
    const id = entry.pick.taskId;
    if (name === 'toggle') { const isOpen = openId === null ? todayItems(last).entries[0]?.pick.taskId === id : openId === id; openId = isOpen ? '' : id; box = null; draw(); return; }
    if (name === 'app') { box = { id, kind: 'say', fresh: true }; draw(); return; }
    if (name === 'date') { box = { id, kind: 'date', fresh: true }; draw(); return; }
    if (name === 'reply') { box = { id, kind: 'reply', fresh: true }; draw(); return; }
    if (name === 'close') { box = null; draw(); return; }
    if (name === 'quote') { if (value) document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'meetings', call: value } })); return; }
    if (name === 'say' || name === 'do-it') {
      box = null;
      const line = name === 'say' ? String(value || '').trim() : '';
      const taskId = name === 'say' ? entry.move.id : id;
      await run(id, () => api.doIt(taskId, line || null), { pending: 'Sending it to Loggie…', said: true });
      return;
    }
    // Reply on a To do move: a reply to the email it came from, unsent; the move stays (do-it.js replyToMove).
    // The yes is asked on the card's own reply row (reply-row.js), never in the ask box.
    if (name === 'send-reply') {
      box = null;
      outcomes.delete(id);
      api.uiAct?.({ act: 'reply-to' }).catch(() => {});
      await replies?.send(entry.move.id, String(value || '').trim(), firstNameOf(entry.move.from));
      draw();
      return;
    }
    if (name === 'save-date') { box = null; await run(id, () => api.moveDate(entry.move.id, value || null)); return; }
    if (name === 'done') { await run(id, () => api.markMove(entry.move.id, 'done')); return; }
    if (name === 'not-this') { await run(id, () => api.notThis(id)); return; }
    if (name === 'open') { await run(id, () => api.openDraft(entry.active.id, { again: entry.active.phase === 'in-mail-app' })); }
  }

  // pending: shown at once. said: the outcome's words stay on the card (Do it); otherwise only a failure is shown.
  async function run(id, call, { pending = '', said = false } = {}) {
    if (pending) { outcomes.set(id, pending); draw(); }
    try {
      const outcome = await call();
      if (said) outcomes.set(id, outcome?.text || 'Nothing happened. Try again?');
    } catch (error) { outcomes.set(id, error.message); }
    draw();
    await onChanged();
  }

  return { draw };
}
