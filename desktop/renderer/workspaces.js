// The Workspaces tab in the mock-up's look (docs/prototype-port/spec.md, Workspaces list and detail): a list of the
// user's workspaces, and one workspace's page with its moves, drafts to send, goal and settings. It replaces the date
// runway (runway.js) and keeps every action that worked there. Every press goes through `api` (the preload bridge, or
// a fake in preview/); nothing here sends anything anywhere: a draft opens in the mail app, unsent.
import { APP_ICON, icon, localToday } from './icons.js';
import { button, el, isDay } from './move-view.js';
import { APP_NAMES, BUSY, canReplyTo, dayLabel, firstNameOf, isNamed, moveGroup, READY, replyTip, titleAndTime } from './today-model.js';
import { listRows, newsLines, retiredWhy, SOURCE_WORD, stakeOf, voiceLine } from './workspaces-model.js';
import { countsLine, evidenceLine } from './found-model.js';
import { CLOUD_YES, HEALTH_LINE } from './setup-cards.js';
import { chipNode, payoffNode, pickerNode } from './meetings-row.js';
import { registerMenu } from './context-menu.js';

const EMPTY = 'No workspaces yet. They come from your mail once Loggie may read it.';

export function createWorkspacesView({ root, api, onChanged = async () => {}, today = localToday(), settingsFor = null, replies = null, picks = () => [] }) {
  let cards = [];
  let openName = null;    // the workspace whose page is open; null = the list
  let moreOpen = false;   // the "..." row: stake, park, refresh, edit, dismiss, goal and cloud
  let parkOpen = false;
  let editOpen = false;
  let dismissArmed = '';  // Dismiss pressed once, waiting for the second press (no modal dialog)
  let deleteArmed = '';   // Delete pressed once, the same way
  // Retire (loggie-workspaces-integration F1): the card being retired while its open moves wait for his choice
  // ({ name, open, moving }); the retired workspaces for the "Retired · n" fold; the retired page open, by name.
  let retiring = null;
  let retiredCards = [];
  let retiredName = null;
  // Recordings on a card (F3): the one whose picker is open, and what filing one elsewhere did, by recording.
  let pickingRec = null;
  const recPayoff = new Map();
  // File here (F4): the New line whose picker is open, and what moving one did, by line.
  let pickingNews = null;
  const newsPayoff = new Map();
  let busy = '';
  let note = '';          // the last look for workspaces: what it found, or why it waits (spec B2)
  let openMove = null;    // the move whose conversation is shown
  let writeMove = null;   // the move whose line box is open
  let dateMove = null;    // the move whose date box is open
  const rowStatus = new Map();
  let boxFresh = false;   // the line or date box was just opened: focus it once
  let typedNow = null;    // what was typed in the open box before a redraw
  let typedName = null;   // what was typed in the name box before a redraw
  const retiredOpen = new Set();
  // New workspace (loggie-new-workspace): the open box, kept across redraws (the same input node, so nothing typed is
  // lost), the look's answer for the name it was asked about, and the people left checked.
  let making = null;
  const log = (payload) => Promise.resolve(api.uiAct?.(payload)).catch(() => {});

  const view = el('section', 'ws-view');
  view.setAttribute('aria-label', 'Workspaces');
  root.replaceChildren(view);
  // One live status line for the whole tab, kept across redraws so "Saving…" and errors are announced.
  const status = el('p', 'ws-status');
  status.setAttribute('aria-live', 'polite');

  async function act(name, workstream, run) {
    busy = name === 'refresh' ? 'Checking every source…' : name === 'refresh-one' ? `Checking ${workstream}…` : 'Saving…';
    draw();
    try {
      await log({ act: name, ...(workstream ? { name: workstream } : {}) });
      const outcome = await run();
      busy = name === 'do-it' && typeof outcome?.text === 'string' ? outcome.text : '';
      await onChanged();
    } catch (error) {
      busy = error.message;
      draw();
    }
  }

  // A press on one move: its outcome said on that row. `keep` leaves the row's status for the queued run to finish
  // (moved(), from onMoved); otherwise the page redraws from fresh data.
  async function rowAct(item, move, name, run, { keep = false } = {}) {
    try {
      await log({ act: name, name: item.name });
      const outcome = await run();
      if (name === 'do-it') rowStatus.set(move.id, { writing: outcome?.phase === 'queued' || outcome?.phase === 'drafting', failed: ['failed', 'phone-only'].includes(outcome?.phase), text: outcome?.phase === 'queued' ? '' : String(outcome?.text || '') });
      if (name === 'move-date') dateMove = null;
      if (!keep) await onChanged(); else draw();
    } catch (error) {
      rowStatus.set(move.id, { writing: false, failed: true, text: error.message });
      draw();
    }
  }
  const focusSoon = (node) => setTimeout(() => { node.focus(); if (node.type === 'text' && node.value) node.setSelectionRange(node.value.length, node.value.length); }, 0);
  // An icon-only button: its tooltip (title) names what it does, the same words its aria-label starts with.
  const iconButton = (name, label, onClick, className = 'ws-act', tip = label) => { const node = button('', onClick, className); node.setAttribute('aria-label', label); node.title = tip; node.append(icon(name)); return node; };
  // A call named on the page opens on the Notes & Meetings tab (workspace.js loggie:navigate).
  const openCall = (folder) => document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'meetings', call: folder } }));
  const callLink = (folder, text, className) => {
    const link = button('', () => openCall(folder), `${className} ws-open-call`);
    link.append(icon('phone'), el('span', '', text));
    link.title = 'Open this call';
    return link;
  };

  function open(name) {
    openName = name;
    moreOpen = false; parkOpen = false; editOpen = false; dismissArmed = ''; deleteArmed = ''; retiring = null; retiredName = null;
    openMove = null; writeMove = null; dateMove = null;
    log({ act: 'focus', name }).catch(() => {});
    draw();
    view.querySelector('.ws-back')?.focus();
  }

  function head(titleText, { back = false } = {}) {
    const top = el('header', 'ws-head');
    if (back) {
      const home = button('', () => { const was = openName || retiredName || ''; openName = null; retiredName = null; draw(); view.querySelector(`.ws-row[data-name="${CSS.escape(was)}"]`)?.focus(); }, 'ws-back');
      home.append(icon('back'), el('span', '', 'Workspaces'));
      top.append(home);
    } else {
      const title = el('h2', 'ws-title', titleText);
      title.id = 'workstream-heading';
      top.append(title);
    }
    status.textContent = busy || note;
    const refreshAll = button('↻ Refresh', () => act('refresh', null, () => api.refresh()), 'ws-refresh');
    refreshAll.setAttribute('aria-label', 'Check every source for anything new');
    top.append(status);
    if (!back && api.workspaceLook) top.append(button('+ New workspace', () => { if (!making) openMaking(); else making.input.focus(); }, 'ws-refresh ws-new-open'));
    top.append(refreshAll);
    return top;
  }

  function listPage() {
    const rows = listRows(cards, today);
    const list = el('ul', 'ws-list');
    for (const row of rows) {
      const item = el('li');
      const node = button('', () => open(row.name), `ws-row${row.changed ? ' is-changed' : ''}`);
      node.dataset.name = row.name;
      const name = el('span', 'ws-name');
      name.append(el('span', 'ws-label', row.label));
      // A workspace Loggie found that nobody kept yet (first-run-polish B4.8): its page asks Keep or Dismiss.
      if (row.newFound) name.append(el('span', 'ws-found-new', 'New'));
      if (row.stake === 'more' || row.stake === 'less') name.append(el('span', 'ws-stake', row.stake === 'more' ? 'matters more' : 'matters less'));
      // The mock-up's row: name, goal, next date, how many to send; what is new shows only when something is.
      if (row.changed) name.append(el('span', 'ws-new', row.fresh));
      node.append(name, el('span', 'ws-goal', row.goal), el('span', 'ws-due-col', row.when), el('span', 'ws-count', row.toSend ? `${row.toSend} to send` : ''));
      item.append(node);
      list.append(item);
    }
    const parts = [head('Workspaces')];
    if (making) parts.push(makingBox());
    if (!rows.some((row) => row.named)) parts.push(el('p', 'ws-empty', EMPTY));
    parts.push(list);
    if (retiredCards.length) parts.push(retiredFold());
    return parts;
  }

  function detailPage(item) {
    const card = el('article', 'ws-focus');
    const top = el('header', 'ws-card-head');
    const more = iconButton('dots', `More for ${item.label || item.name}`, () => { moreOpen = !moreOpen; parkOpen = false; editOpen = false; dismissArmed = ''; deleteArmed = ''; draw(); }, 'ws-more', 'More');
    more.setAttribute('aria-expanded', String(moreOpen));
    top.append(el('h2', 'ws-card-title', item.label || item.name), more);
    card.append(top);
    if (item.newFound) card.append(foundBand(item));
    else if (item.readYes) card.append(readYesBand(item));
    const row = listRows([item], today)[0];
    const goal = el('p', 'ws-goal-line', [row.goal, row.when ? row.when.replace(/^by /, 'next due ') : '', row.fresh].filter(Boolean).join(' · '));
    card.append(goal);
    // What it is for, drafted from a sentence code found in its own mail (F2): the source shown, one Yes makes it his.
    if (item.goalText && !item.goalConfirmed && item.goalQuote && api.confirmGoal) {
      const forLine = el('p', 'ws-for');
      forLine.append(el('span', '', `for: ${item.goalText} `), el('span', 'ws-for-from', `· from “${item.goalQuote}” · `),
        button('Yes', () => act('goal-yes', item.name, () => api.confirmGoal(item.name, item.goalText)), 'ws-for-yes'));
      card.append(forLine);
    }
    // The workspace's own calendar dates, the first two (the runway's diamonds, kept as words).
    const dates = (item.milestones || []).slice(0, 2);
    if (dates.length) card.append(el('p', 'ws-dates', dates.map((m) => `◆ ${dayLabel(m.at)} ${m.title}`).join('   ')));
    if (moreOpen) card.append(...moreParts(item));
    card.append(...depthParts(item));
    return [head('', { back: true }), card];
  }

  // A found workspace nobody kept yet (first-run-polish B4.8): what Loggie found, then Keep (its mail is read only
  // now, main D1) or Dismiss, which asks for a second press. The band is the only Dismiss.
  function foundBand(item) {
    const band = el('div', 'ws-found');
    band.append(el('p', 'ws-found-head', 'Loggie found this in your mail.'));
    const evidence = evidenceLine(item.foundRow || {});
    if (evidence) band.append(el('p', 'ws-hint', evidence));
    const counts = countsLine(item.foundRow || {});
    if (counts) band.append(el('p', 'ws-hint', counts));
    const actions = el('div', 'ws-actions');
    const keep = button('Keep', async () => {
      busy = 'Saving…';
      draw();
      try {
        await api.foundKeep({ keep: [item.name], dismiss: [], end: null });
        busy = '';
        await onChanged();
      } catch (error) { busy = error.message; draw(); }
    }, 'ws-do');
    const armed = dismissArmed === item.name;
    const dismiss = button(armed ? 'Press again to dismiss' : 'Dismiss', () => {
      if (!armed) { dismissArmed = item.name; draw(); return; }
      dismissArmed = '';
      openName = null;
      act('dismiss', item.name, () => api.dismissWorkstream(item.name));
    }, armed ? 'ws-dismiss is-armed' : 'ws-dismiss');
    actions.append(keep, dismiss);
    band.append(actions);
    return band;
  }

  // A kept found card nothing may read yet (found.js needsReadYes): where Keep was, the cloud yes and one Yes. The yes
  // is setup's (cloudYesAnswer 'ai'); then the card gets its approval and its first read starts (main found-read).
  function readYesBand(item) {
    const band = el('div', 'ws-read-yes');
    band.append(el('p', 'ws-found-head', CLOUD_YES.ai), el('p', 'ws-hint', `Only text screened on this Mac leaves it. ${HEALTH_LINE}`));
    const actions = el('div', 'ws-actions');
    actions.append(button('Yes', async () => {
      busy = 'Saving…';
      draw();
      try {
        await api.cloudYesAnswer('ai', 'yes');
        await api.foundRead(item.name);
        busy = '';
        await onChanged();
      } catch (error) { busy = error.message; draw(); }
    }, 'ws-do'));
    band.append(actions);
    return band;
  }

  // One More action as an icon with its name on hover and for a screen reader (the Meetings head's way, 2026-10-29):
  // seven text buttons in a row read as clutter on the workspace page.
  function iconAct(name, label, onClick, className = '') {
    const node = button('', onClick, `ws-icon-act ${className}`.trim());
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(name));
    return node;
  }

  // The "..." row: how much it matters, park, re-read, the name, dismiss, and the goal and cloud settings.
  function moreParts(item) {
    const parts = [];
    const stake = stakeOf(item);
    const actions = el('div', 'ws-actions');
    const tap = (value, label) => {
      const on = stake === value;
      const node = iconAct(value === 'more' ? 'up' : 'down', label, () => tapStake(item, value), on ? 'is-on' : '');
      node.setAttribute('aria-pressed', String(on));
      return node;
    };
    actions.append(tap('more', 'Matters more'), tap('less', 'Matters less'));
    const parkButton = iconAct('clock', item.priority?.parked ? `Parked until ${dayLabel(item.priority.parkedUntil)}` : 'Park until…', () => (parkOpen ? (parkOpen = false, draw()) : showPark(item)), item.priority?.parked ? 'ws-park is-on' : 'ws-park');
    parkButton.setAttribute('aria-expanded', String(parkOpen));
    actions.append(parkButton);
    if (!item.quiet) actions.append(iconAct('refresh', 'Refresh this', () => refreshThis(item), 'ws-refresh-one'));
    // A workspace Loggie found is edited or dismissed, never made by hand (Gio, 2026-10-17). Inbox, Chats and folder
    // cards are not the user's workspaces, so they have neither.
    if (!item.inbox && !item.chats && !item.folder) {
      const editButton = iconAct('pencil', 'Edit name', () => (editOpen ? (editOpen = false, draw()) : showEdit(item)), 'ws-edit');
      editButton.setAttribute('aria-expanded', String(editOpen));
      actions.append(editButton);
      // A found card he never kept is dismissed from its band, beside Keep (one action, one place; cleanup 2026-10-27).
      if (!item.newFound && api.retireWorkstream) {
        // A workspace he kept ends by Retire: its history stays, it stops filing, and Bring back undoes it.
        actions.append(iconAct('archive', 'Retire', () => retire(item, null, null, 'retire'), 'ws-retire'));
        // Or by Delete, for good (loggie-delete-workspace): a second press, as Dismiss asks, then the same moves choice.
        if (api.deleteWorkstream) {
          const armed = deleteArmed === item.name;
          const del = () => {
            if (!armed) { deleteArmed = item.name; draw(); return; }
            deleteArmed = '';
            retire(item, null, null, 'delete');
          };
          // armed, it says so in words: a second press deletes for good
          actions.append(armed ? button('Press again to delete', del, 'ws-delete is-armed') : iconAct('trash', 'Delete', del, 'ws-delete'));
        }
      }
    }
    parts.push(actions);
    if (retiring?.name === item.name) parts.push(retireChoice(item));
    if (parkOpen) parts.push(parkPicker(item));
    if (editOpen) parts.push(nameEditor(item));
    const settings = settingsFor ? settingsFor(item) : [];
    // the goal stays in view; why it ranks, the quiet switch and the cloud setting fold under Settings
    const shown = settings.filter((node) => node.classList?.contains('goal-block'));
    const folded = settings.filter((node) => !shown.includes(node));
    parts.push(...shown);
    if (folded.length) {
      const box = el('details', 'ws-settings');
      box.append(el('summary', 'ws-settings-head', 'Settings'), ...folded);
      parts.push(box);
    }
    return parts;
  }

  // What the More row's taps do, each one function its tap and the row's right-click both call.
  const tapStake = (item, value) => act('tap', item.name, () => api.setStake(item.name, stakeOf(item) === value ? null : value));
  const refreshThis = (item) => act('refresh-one', item.name, () => api.refreshOne(item.name));
  // Park until… and Edit name open on the workspace's page, under More, from its row too.
  function showMore(item) { if (openName !== item.name) open(item.name); moreOpen = true; }
  function showPark(item) { showMore(item); parkOpen = true; draw(); }
  function showEdit(item) { showMore(item); editOpen = true; dismissArmed = ''; boxFresh = true; draw(); }

  // The right-click on a workspace row (context-menu.js, loggie right-click 2026-10-28): Catch up now is Refresh this,
  // Open is the row, the stakes are the More taps, Park and Edit name open what their More buttons open, and Retire is
  // More > Retire, which still asks about the open moves on the page. Delete stays on the page: its "press again" has
  // no native twin.
  const WORKSPACE_MENU = {
    'catch-up': (item) => refreshThis(item),
    open: (item) => open(item.name),
    more: (item) => tapStake(item, 'more'),
    less: (item) => tapStake(item, 'less'),
    park: (item) => showPark(item),
    rename: (item) => showEdit(item),
    retire: (item) => { showMore(item); retire(item, null, null, 'retire'); },
  };
  registerMenu({
    kind: 'workspace',
    find: (node) => (root.contains(node) ? node.closest('.ws-row[data-name]')?.dataset.name ?? null : null),
    state: (name) => { const card = cards.find((item) => item.name === name) || { name }; return { card, fresh: listRows([card], today)[0]?.fresh || '' }; },
    run: (name, picked) => { const item = cards.find((card) => card.name === name); if (item) WORKSPACE_MENU[picked.id]?.(item); },
    failed: (error) => { busy = error.message; draw(); },
  });

  function depthParts(item) {
    const parts = [];
    if (item.summary) parts.push(el('p', 'ws-summary', item.summary));
    if ((item.news || []).length) {
      parts.push(el('p', 'ws-label-line', 'New'));
      const list = el('ul', 'ws-news');
      // Each line carries the one chip (meetings-row.js): it says where the thread files, and a pick moves the whole
      // thread there (File here). Inbox and Chats lines file nowhere yet, so their chip reads Pick a workspace.
      const here = !item.inbox && !item.chats && !item.folder ? item.name : null;
      const names = cards.filter((card) => isNamed(card) && !card.newFound && card.name !== here).map((card) => card.name);
      for (const n of newsLines(item.news)) {
        const li = el('li', 'ws-news-line');
        li.append(el('span', 'ws-news-text', `${SOURCE_WORD[n.source] || n.source} · ${n.title || '(no title)'}${n.count > 1 ? ` (${n.count})` : ''} · ${dayLabel(n.at)}`));
        const result = n.id ? newsPayoff.get(n.id) : null;
        if (n.id && !result && api.moveThread) li.append(chipNode({ workstream: here }, { open: pickingNews === n.id, onPress: () => { pickingNews = pickingNews === n.id ? null : n.id; draw(); } }));
        if (pickingNews === n.id) {
          li.append(pickerNode({ names, onCancel: () => { pickingNews = null; draw(); }, onPick: async (name) => {
            pickingNews = null;
            try { const done = await api.moveThread(n.id, name); newsPayoff.set(n.id, done); await onChanged(); }
            catch (error) { busy = error.message; draw(); }
          } }));
        } else if (result) li.append(payoffNode(result, { onOpenWorkspace: (name) => open(name) }));
        list.append(li);
      }
      parts.push(list);
    }
    if (Array.isArray(item.recordings) && !item.inbox && !item.chats && !item.folder) parts.push(...recordingsBlock(item));
    if ((item.waitingOn || []).length) parts.push(el('p', 'ws-waiting', `Waiting on you: ${item.waitingOn.join(', ')}`));
    // To send: drafts Loggie finished, each one Open away from the mail app, where the user presses Send, then the
    // moves that make a draft. To do: the moves only the user can do (today-model.js moveGroup, the rule Today uses).
    const ready = (item.active || []).filter((x) => READY.includes(x.phase));
    const sendMoves = (item.moves || []).filter((move) => moveGroup(move) === 'send');
    const doMoves = (item.moves || []).filter((move) => moveGroup(move) === 'do');
    if (ready.length || sendMoves.length) parts.push(el('p', 'ws-label-line ws-to-send-head', 'To send'));
    if (ready.length || sendMoves.length) {
      if (ready.length) {
        const list = el('ul', 'ws-to-send');
        for (const a of ready) list.append(toSendRow(a));
        parts.push(list);
      }
      for (const a of (item.active || []).filter((x) => !READY.includes(x.phase) && !['needs-you', 'failed'].includes(x.phase))) parts.push(el('p', 'ws-hint', `${BUSY[a.phase] || a.phase}: ${a.title}`));
      if (sendMoves.length) {
        const list = el('ul', 'ws-moves');
        for (const move of sendMoves) list.append(moveRow(item, move));
        parts.push(list);
      }
    }
    if (doMoves.length) {
      parts.push(el('p', 'ws-label-line ws-to-do-head', 'To do'));
      const list = el('ul', 'ws-moves ws-to-do');
      for (const move of doMoves) list.append(moveRow(item, move));
      parts.push(list);
    }
    const voice = voiceLine(item.voice);
    if (voice) parts.push(el('p', 'ws-label-line', 'How you write here'), el('p', 'ws-voice', voice));
    // Moves Loggie retired (retire.js), each with why and Undo, so a wrong call costs one click.
    if ((item.retired || []).length) {
      const fold = el('details', 'ws-retired-fold');
      fold.open = retiredOpen.has(item.name);
      fold.addEventListener('toggle', () => { if (fold.open) retiredOpen.add(item.name); else retiredOpen.delete(item.name); });
      fold.append(el('summary', '', `Retired · ${item.retired.length}`));
      const list = el('ul', 'ws-moves');
      for (const r of item.retired) {
        const line = el('li', 'ws-move ws-retired');
        line.append(el('span', 'ws-move-title', `${r.title} · ${retiredWhy(r)}`));
        const undo = button('Undo', () => act('unretire', item.name, () => api.unretire(r.id)), 'ws-do');
        undo.setAttribute('aria-label', `Undo retiring: ${r.title}`);
        line.append(undo);
        list.append(line);
      }
      fold.append(list);
      parts.push(fold);
    }
    return parts;
  }

  function toSendRow(active) {
    const line = el('li', 'ws-move ws-send');
    line.append(el('span', 'ws-move-title', `▸ ${active.title}`));
    const again = active.phase === 'in-mail-app';
    const openButton = button(again ? 'Open again' : 'Open', () => act('open-draft', null, () => api.openDraft(active.id, { again })), 'ws-do');
    openButton.setAttribute('aria-label', `${again ? 'Open again' : 'Open'} in your mail app: ${active.title}`);
    line.append(openButton);
    return line;
  }

  // One move: the title opens what was said; on a To send move the app button opens a one-line box (prefilled for a
  // move from a text) and Enter drafts; Done, New date and Drop it on hover. A To do move has no app button: nothing to
  // draft. A To do move that came from a person's email has Reply instead (today-model.js canReplyTo): the same line
  // box, and Enter drafts a reply to that email, unsent, while the move stays To do. A date already past shows a clock
  // and stays red.
  function moveRow(item, move) {
    const line = el('li', `ws-move${move.notSure ? ' is-unsure' : ''}`);
    line.dataset.move = move.id;
    if (move.notSure) line.title = `Not sure: ${move.notSure}`;
    const late = Boolean(move.due && move.due < today);
    const top = el('div', 'ws-move-top');
    const title = button('', () => { openMove = openMove === move.id ? null : move.id; draw(); }, 'ws-move-open');
    title.setAttribute('aria-expanded', String(openMove === move.id));
    // The date lives on the tag: a date phrase naming the move's own day leaves the title, its time joins the tag.
    const shown = titleAndTime(move.title, move.due);
    title.append(el('span', 'ws-tri', '▸'));
    // One of Today's picks wears Today's ★, so the two tabs point at the same move (F7).
    if (picks().includes(move.id)) { const star = el('span', 'ws-pick', '★'); star.title = "One of today's picks"; title.append(star); }
    title.append(el('span', 'ws-move-title', `${move.waiting ? '↩ ' : ''}${shown.title}`));
    top.append(title);
    if (move.due) {
      const chip = el('span', `ws-due${late ? ' is-late' : ''}`);
      if (late) chip.append(icon('clock'));
      const when = shown.time ? `${dayLabel(move.due)} · ${shown.time}` : dayLabel(move.due);
      chip.append(when);
      chip.title = `${late ? 'Was due' : 'Due'} ${when}`;
      top.append(chip);
    }
    const marks = el('span', 'ws-marks');
    const mark = (name, label, run) => iconButton(name, `${label}: ${move.title}`, run, 'ws-act', label);
    marks.append(
      mark('check', 'Done', () => closeMove(item, move, 'done')),
      mark('cal', 'New date', () => dateBox(move)),
      mark('x', 'Drop it', () => closeMove(item, move, 'dropped')),
    );
    top.append(marks);
    const appName = APP_NAMES[move.app] || 'your mail app';
    // A To do move gets no app button: Done, New date and Drop it only. A green-bubble chat (SMS or RCS) this Mac reads
    // but cannot send: the app sign stays, grayed, and does nothing.
    const toSend = moveGroup(move) === 'send';
    const replyable = canReplyTo(move);
    if (toSend && move.sendable === false) {
      const off = iconButton(APP_ICON[move.app] || 'chat', `Text from your iPhone: ${move.title}; this Mac cannot send SMS or RCS`, () => {}, 'ws-go is-off', 'Text from your iPhone (SMS/RCS)');
      off.disabled = true;
      top.append(off);
    } else if (toSend) {
      const go = iconButton(APP_ICON[move.app] || 'mail', `Draft it in ${appName}: ${move.title}`, () => lineBox(move), 'ws-go', `Draft it in ${appName}`);
      top.append(go);
    } else if (replyable) {
      const go = iconButton('reply', `${replyTip(move)}: ${move.title}`, () => lineBox(move), 'ws-go ws-reply', replyTip(move));
      top.append(go);
    }
    line.append(top);
    // The same thing from other threads, merged into this one move (F5): where else it came up, muted.
    if (Array.isArray(move.also) && move.also.length) line.append(el('p', 'ws-also', `also in ${move.also.join(' · ')}`));
    if (openMove === move.id) line.append(moveDetail(move, appName));
    if (dateMove === move.id) {
      const box = el('div', 'ws-line');
      const input = el('input', 'ws-date');
      input.type = 'date'; input.min = today; input.value = isDay(typedNow) ? typedNow : (move.due && move.due >= today ? move.due : today);
      input.setAttribute('aria-label', `New date for ${move.title}`);
      const save = iconButton('check', 'Save the new date', () => rowAct(item, move, 'move-date', () => api.moveDate(move.id, input.value || null)), 'ws-go');
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') save.click(); if (event.key === 'Escape') { dateMove = null; draw(); } });
      box.append(input, save);
      line.append(box);
      if (boxFresh) focusSoon(input);
    }
    if (writeMove === move.id && (toSend || replyable)) {
      const box = el('div', 'ws-line');
      const input = el('input', 'ws-say');
      input.placeholder = 'What should it say?';
      input.maxLength = 1000;
      input.setAttribute('aria-label', toSend ? `What the draft to ${appName} should say` : `What the reply to ${firstNameOf(move.from)} in ${appName} should say`);
      // A move from a text opens with what the text asked, cursor at the end, for the user to finish (move-card.js askLineOf).
      input.value = typedNow ?? (toSend ? move.askLine || '' : '');
      const send = iconButton('up', toSend ? 'Draft it' : 'Draft the reply', () => {
        const said = input.value.trim();
        writeMove = null;
        if (toSend) { rowStatus.set(move.id, { writing: true, text: '' }); rowAct(item, move, 'do-it', () => api.doIt(move.id, said || null), { keep: true }); return; }
        // A Reply: the shared reply row (reply-row.js) asks the yes on this row and shows where the reply is.
        rowStatus.delete(move.id);
        log({ act: 'reply-to', name: item.name });
        replies?.send(move.id, said, firstNameOf(move.from));
      }, 'ws-go');
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) send.click(); if (event.key === 'Escape') { writeMove = null; draw(); } });
      box.append(input, send);
      line.append(box);
      if (boxFresh) focusSoon(input);
    }
    const status = rowStatus.get(move.id);
    if (status) {
      const said = el('p', 'ws-row-status');
      said.setAttribute('role', 'status');
      // Writing: a spinner. Landed: a check. Failed or refused: an x, so a failure never wears a check.
      said.append(status.writing ? icon('ring', 'is-spin') : icon(status.failed ? 'x' : 'check'), icon(APP_ICON[move.app] || 'mail'));
      if (status.failed) said.classList.add('is-failed');
      if (status.text) said.append(el('span', '', status.text));
      line.append(said);
    }
    // A Reply going on this move: its yes, its progress and where it landed (reply-row.js), the same on Today.
    const reply = replyable ? replies?.node(move.id, { app: move.app }) : null;
    if (reply) line.append(reply);
    return line;
  }

  // A move row's own presses, each one function its mark or button and the row's right-click both call: Done and Drop
  // it, the date box, and the line box (Draft it; Reply on a To do move). `open` null toggles, as the buttons do.
  const closeMove = (item, move, why) => rowAct(item, move, why === 'done' ? 'move-done' : 'move-drop', () => api.markMove(move.id, why));
  function dateBox(move, open = null) { dateMove = (open ?? dateMove !== move.id) ? move.id : null; writeMove = null; boxFresh = Boolean(dateMove); draw(); }
  function lineBox(move, open = null) { writeMove = (open ?? writeMove !== move.id) ? move.id : null; dateMove = null; boxFresh = Boolean(writeMove); draw(); }

  // The right-click on a move of the open workspace (context-menu.js, loggie right-click 2026-10-28): Draft it opens the
  // row's line box (Enter drafts), Done, New date and Drop it are its hover marks, and the call it came from is the
  // call line in the opened move. A To do move has nothing to draft, said greyed.
  const MOVE_MENU = {
    draft: (item, move) => lineBox(move, true),
    done: (item, move) => closeMove(item, move, 'done'),
    date: (item, move) => dateBox(move, true),
    drop: (item, move) => closeMove(item, move, 'dropped'),
    call: (item, move) => { if (move.call?.folder) openCall(move.call.folder); },
  };
  const openMoveOf = (id) => { const item = cards.find((card) => card.name === openName); const move = (item?.moves || []).find((one) => one.id === id); return move ? { item, move } : null; };
  registerMenu({
    kind: 'move',
    find: (node) => (root.contains(node) && openName ? node.closest('.ws-move[data-move]')?.dataset.move ?? null : null),
    state: (id) => { const move = openMoveOf(id)?.move || { id }; return { move, toSend: moveGroup(move) === 'send', appName: APP_NAMES[move.app] || 'your mail app' }; },
    run: (id, picked) => { const found = openMoveOf(id); if (found) MOVE_MENU[picked.id]?.(found.item, found.move); },
    failed: (error) => { busy = error.message; draw(); },
  });

  // The last messages of the move's conversation and the call it came from, read from its files (move-card.js).
  function moveDetail(move, appName) {
    const box = el('div', 'ws-detail');
    if (move.to || (move.said || []).length) {
      const who = el('p', 'ws-detail-who');
      who.append(icon(APP_ICON[move.app] || 'mail'), el('span', '', [move.to, appName].filter(Boolean).join(' · ')));
      box.append(who);
    }
    for (const m of move.said || []) {
      const bubble = el('div', `ws-bubble${m.who === 'me' ? ' is-mine' : ''}`);
      bubble.append(el('span', '', m.text), el('span', 'ws-when', `${m.who === 'me' ? 'You · ' : ''}${dayLabel(m.at)}`));
      box.append(bubble);
    }
    if (move.call) {
      const text = `${move.call.title}${move.call.at ? ` · ${dayLabel(move.call.at)}` : ''}${move.call.step ? `. ${move.call.step}` : ''}`;
      const call = move.call.folder ? callLink(move.call.folder, text, 'ws-callnote') : el('p', 'ws-callnote');
      if (!move.call.folder) call.append(icon('phone'), el('span', '', text));
      box.append(call);
      for (const line of move.call.lines || []) {
        const bubble = el('div', 'ws-bubble');
        bubble.append(el('span', '', line.text), el('span', 'ws-when', [line.section, line.time].filter(Boolean).join(' · ')));
        box.append(bubble);
      }
    }
    if (!(move.said || []).length && !move.call) box.append(el('p', 'ws-when', 'Nothing quoted for this move.'));
    return box;
  }

  // New workspace: type a name, Look (or Enter), see what Loggie found with its words and who is in it, leave anyone out,
  // Save. A name changed after the look needs Look again; Esc or Cancel writes nothing.
  function openMaking() {
    const input = el('input', 'ws-new-name');
    input.type = 'text';
    input.maxLength = 60;
    input.placeholder = 'Name it, like Hilton hackathon';
    input.setAttribute('aria-label', 'Name for the new workspace');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); if (making?.look && making.look.name === clean(input.value)) save(); else look(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); making = null; draw(); }
    });
    input.addEventListener('input', () => { if (making?.look && making.look.name !== clean(input.value)) { making.look = null; draw(); } });
    making = { input, look: null, kept: new Set(), phase: '', error: '' };
    draw();
    input.focus();
  }
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  async function look() {
    const name = clean(making?.input.value);
    if (!making || !name || making.phase) return;
    making.phase = 'looking'; making.error = ''; making.look = null;
    draw();
    try {
      const found = await api.workspaceLook(name);
      if (!making || clean(making.input.value) !== found.name) return;
      making.look = found;
      making.kept = new Set(found.people.map((person) => person.key));
    } catch (error) { if (making) making.error = error.message; }
    if (making) making.phase = '';
    draw();
  }
  async function save() {
    if (!making?.look || making.phase) return;
    making.phase = 'saving'; making.error = '';
    draw();
    try {
      const made = await api.workspaceNew(making.look.name, [...making.kept]);
      await log({ act: 'workspace-new', name: made.name });
      making = null;
      note = `Made ${made.name}.${made.calls ? ` ${made.calls === 1 ? 'One call' : `${made.calls} calls`} filed there.` : ''}${made.cloud ? ' Reading its mail now.' : ''}`;
      await onChanged();
      open(made.name);
    } catch (error) {
      if (making) { making.phase = ''; making.error = error.message; }
      draw();
    }
  }
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  function makingBox() {
    const box = el('div', 'ws-new-box');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'New workspace');
    const row = el('div', 'ws-new-row');
    const lookButton = button(making.phase === 'looking' ? 'Looking…' : 'Look', look, 'ws-new-look');
    lookButton.disabled = Boolean(making.phase);
    row.append(making.input, lookButton, button('Cancel', () => { making = null; draw(); }, 'ws-new-cancel'));
    box.append(row);
    if (making.error) box.append(el('p', 'ws-new-error', making.error));
    const found = making.look;
    if (!found) {
      box.append(el('p', 'ws-new-hint', making.phase === 'looking' ? 'Looking through the last 30 days of your mail, chats and calls…' : 'Loggie looks through the last 30 days of your mail, chats and calls for the name, then shows who it found.'));
      return box;
    }
    const words = found.words.map((word) => `“${word}”`).join(' or ');
    const counts = [plural(found.mail, 'email'), ...(found.chatsOn ? [plural(found.chats, 'chat')] : []), plural(found.calls, 'call')];
    box.append(el('p', 'ws-new-found', `${counts.slice(0, -1).join(', ')} and ${counts.at(-1)} say ${words}.${found.chatsOn ? '' : ' Chats are off, so none were read.'}`));
    if (found.people.length) {
      const list = el('ul', 'ws-new-people');
      list.setAttribute('aria-label', 'People to follow in this workspace');
      for (const person of found.people) {
        const item = el('li');
        const label = el('label', 'ws-new-person');
        const tick = el('input');
        tick.type = 'checkhouse';
        tick.checked = making.kept.has(person.key);
        tick.addEventListener('change', () => { if (tick.checked) making.kept.add(person.key); else making.kept.delete(person.key); });
        label.append(tick, el('span', 'ws-new-who', person.name || person.at), el('span', 'ws-new-at', person.name ? person.at : ''), el('span', 'ws-new-count', plural(person.count, 'match', 'matches')));
        item.append(label);
        list.append(item);
      }
      box.append(el('p', 'ws-new-hint', 'Their new mail and chats will file here. Uncheck anyone who does not belong.'), list);
    } else box.append(el('p', 'ws-new-hint', 'No one yet: mail and chats that say the name will file here.'));
    for (const line of found.notes || []) box.append(el('p', 'ws-new-hint', line));
    const saveButton = button(making.phase === 'saving' ? 'Saving…' : `Save ${found.name}`, save, 'ws-new-save');
    saveButton.disabled = Boolean(making.phase);
    box.append(saveButton);
    return box;
  }

  // Retire or Delete, asked once when open moves remain (TC2: "Ask once"): Mark all done, Move them to…, Drop them, or
  // Cancel. `kind` 'delete' ends it for good: its recordings move to "No workspace", and it is not under Retired.
  async function retire(item, choice = null, target = null, kind = retiring?.kind || 'retire') {
    busy = 'Saving…';
    draw();
    try {
      const out = await (kind === 'delete' ? api.deleteWorkstream : api.retireWorkstream)(item.name, choice, target);
      if (out?.needsChoice) { retiring = { name: item.name, open: out.open, moving: false, kind }; busy = ''; draw(); return; }
      retiring = null; openName = null; moreOpen = false;
      busy = '';
      const unfiled = out?.unfiled ? ` ${out.unfiled} ${out.unfiled === 1 ? 'recording is' : 'recordings are'} under No workspace, notes kept.` : '';
      note = kind === 'delete' ? `Deleted ${item.label || item.name}. It no longer files anything and will not be suggested again.${unfiled}`
        : `Retired ${item.label || item.name}. It no longer files new mail or chats; Bring back is under Retired.`;
      await loadRetired();
      await onChanged();
    } catch (error) { busy = error.message; draw(); }
  }
  function retireChoice(item) {
    const row = el('div', 'ws-retire-choice');
    row.append(el('p', '', `${retiring.open} open ${retiring.open === 1 ? 'move' : 'moves'}. Before it ${retiring.kind === 'delete' ? 'is deleted' : 'retires'}:`));
    const buttons = el('div', 'ws-actions');
    if (retiring.moving) {
      const others = cards.filter((card) => isNamed(card) && card.name !== item.name && !card.newFound && !card.inbox && !card.chats && !card.folder);
      for (const card of others) buttons.append(button(card.label || card.name, () => retire(item, 'move', card.name)));
      if (!others.length) buttons.append(el('span', 'ws-muted', 'No other workspace to move them to.'));
      buttons.append(button('Back', () => { retiring.moving = false; draw(); }, 'ws-cancel'));
    } else {
      buttons.append(button('Mark all done', () => retire(item, 'done')), button('Move them to…', () => { retiring.moving = true; draw(); }), button('Drop them', () => retire(item, 'drop')),
        button('Cancel', () => { retiring = null; draw(); }, 'ws-cancel'));
    }
    row.append(buttons);
    return row;
  }
  async function loadRetired() {
    if (!api.retiredWorkstreams) return;
    try {
      const next = await api.retiredWorkstreams();
      const changedNow = JSON.stringify(next) !== JSON.stringify(retiredCards);
      retiredCards = Array.isArray(next) ? next : [];
      if (changedNow) draw();
    } catch { /* the fold just stays as it was */ }
  }
  // The "Retired · n" fold under the list: each retired workspace opens its read-only page.
  function retiredFold() {
    const fold = el('details', 'ws-retired-fold');
    if (retiredName) fold.open = true;
    fold.append(el('summary', '', `Retired · ${retiredCards.length}`));
    const list = el('ul', 'ws-list ws-retired-list');
    for (const card of retiredCards) {
      const li = el('li');
      const node = button('', () => { retiredName = card.name; openName = null; draw(); }, 'ws-row is-retired');
      node.dataset.name = card.name;
      const recordings = card.recordings?.length || 0;
      node.append(el('span', 'ws-label', card.label || card.name), el('span', 'ws-goal', `Retired ${dayLabel(String(card.retired).slice(0, 10))}${recordings ? ` · ${recordings} ${recordings === 1 ? 'recording' : 'recordings'} kept` : ''}`), el('span', 'ws-due-col', ''), el('span', 'ws-count', ''));
      li.append(node);
      list.append(li);
    }
    fold.append(list);
    return fold;
  }
  // A retired workspace's page, read-only: when it retired, Bring back, and the recordings filed under it.
  function retiredPage(card) {
    const page = el('article', 'ws-focus is-retired');
    const top = el('header', 'ws-card-head');
    top.append(el('h2', 'ws-card-title', card.label || card.name), button('Bring back', async () => {
      busy = 'Saving…'; draw();
      try { await api.unretireWorkstream(card.name); retiredName = null; busy = ''; note = `${card.label || card.name} is back. It files new mail and chats again from the next refresh.`; await loadRetired(); await onChanged(); }
      catch (error) { busy = error.message; draw(); }
    }, 'ws-bring-back'));
    page.append(top, el('p', 'ws-goal-line', `Retired ${dayLabel(String(card.retired).slice(0, 10))} · new mail and chats no longer file here`));
    page.append(el('p', 'ws-label-line', `Recordings · ${card.recordings?.length || 0}`));
    if (card.recordings?.length) {
      const list = el('ul', 'ws-recordings');
      for (const call of card.recordings) {
        const li = el('li', 'ws-recording');
        li.append(el('span', 'ws-recording-when', dayLabel(String(call.start || '').slice(0, 10))), el('span', 'ws-recording-title', `${call.title}${call.minutes ? ` · ${call.minutes} min` : ''}`), callLink(call.id, 'Notes', 'ws-recording-open'));
        list.append(li);
      }
      page.append(list);
    } else page.append(el('p', 'ws-muted', 'No recordings were filed here.'));
    return page;
  }

  // Recordings · n (loggie-workspaces-integration F3): the recordings filed here, the same chip and picker as Meetings
  // (meetings-row.js), Notes opening the recording on Meetings, and how many of its next steps are moves here.
  function recordingsBlock(item) {
    // an empty section says nothing (2026-10-29): the heading comes with the first recording
    if (!item.recordings.length) return [];
    const parts = [el('p', 'ws-label-line', `Recordings · ${item.recordings.length}`)];
    const list = el('ul', 'ws-recordings');
    const names = cards.filter((card) => isNamed(card) && !card.newFound).map((card) => card.name);
    for (const call of item.recordings) {
      const li = el('li', 'ws-recording');
      li.dataset.call = call.id;
      li.append(el('span', 'ws-recording-when', dayLabel(String(call.start || '').slice(0, 10))), el('span', 'ws-recording-title', `${call.title}${call.minutes ? ` · ${call.minutes} min` : ''}`));
      const right = el('span', 'ws-recording-right');
      const result = recPayoff.get(call.id);
      if (!result) right.append(chipNode(call, { open: pickingRec === call.id, onPress: () => { pickingRec = pickingRec === call.id ? null : call.id; draw(); } }));
      right.append(callLink(call.id, 'Notes', 'ws-recording-open'));
      li.append(right);
      if (call.steps) li.append(el('span', 'ws-recording-steps', `${call.steps} next ${call.steps === 1 ? 'step' : 'steps'} on this card`));
      if (pickingRec === call.id) {
        li.append(pickerNode({ names, workstream: call.workstream, onCancel: () => { pickingRec = null; draw(); }, onPick: async (name) => {
          pickingRec = null;
          try { const done = await api.fileCall(call.id, name, 'workspace'); if (done?.to) recPayoff.set(call.id, done); await onChanged(); }
          catch (error) { busy = error.message; draw(); }
        } }));
      } else if (result) li.append(payoffNode(result, { onOpenWorkspace: (name) => open(name) }));
      list.append(li);
    }
    parts.push(list);
    return parts;
  }

  function nameEditor(item) {
    const form = el('form', 'ws-name-edit');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 60;
    input.value = typedName ?? (item.label || item.name);
    input.setAttribute('aria-label', `New name for ${item.label || item.name}`);
    const save = () => { const value = input.value.replace(/\s+/g, ' ').trim(); if (!value) return; editOpen = false; act('rename', item.name, () => api.renameWorkstream(item.name, value === item.name ? null : value)); };
    form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
    form.append(input, button('Save', save), button('Cancel', () => { editOpen = false; draw(); }));
    if (boxFresh) focusSoon(input);
    return form;
  }

  function parkPicker(item) {
    const row = el('div', 'ws-park-pick');
    const at = (days) => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() + days); return localToday(d); };
    for (const [label, days] of [['1 week', 7], ['2 weeks', 14]]) row.append(button(`${label} · ${dayLabel(at(days))}`, () => { parkOpen = false; act('park', item.name, () => api.park(item.name, at(days))); }));
    const input = el('input');
    input.type = 'date';
    input.min = at(1);
    input.setAttribute('aria-label', `Park ${item.name} until`);
    input.addEventListener('change', () => { if (input.value) { parkOpen = false; act('park', item.name, () => api.park(item.name, input.value)); } });
    row.append(input);
    if (item.priority?.parked) row.append(button('Unpark', () => { parkOpen = false; act('park', item.name, () => api.park(item.name, null)); }));
    return row;
  }

  function draw(next = null) {
    if (next) cards = next;
    const item = openName ? cards.find((c) => c.name === openName) : null;
    if (openName && !item) openName = null;
    view.dataset.mode = item ? 'detail' : 'list';
    // Words typed into an open box, and its focus, survive a redraw (the lists reload every few seconds).
    const prior = view.querySelector('.ws-say, .ws-date');
    typedNow = !boxFresh && (writeMove || dateMove) && prior ? prior.value : null;
    const nameBox = view.querySelector('.ws-name-edit input');
    typedName = !boxFresh && editOpen && nameBox ? nameBox.value : null;
    const makingFocus = making && document.activeElement === making.input ? [making.input.selectionStart, making.input.selectionEnd] : null;
    const focused = [prior, nameBox].find((node) => node && document.activeElement === node) || null;
    const selector = focused === nameBox ? '.ws-name-edit input' : '.ws-say, .ws-date';
    const caret = focused && focused.type === 'text' ? [focused.selectionStart, focused.selectionEnd] : null;
    const retiredCard = !item && retiredName ? retiredCards.find((card) => card.name === retiredName) : null;
    if (!item && retiredName && !retiredCard) retiredName = null;
    view.replaceChildren(...(item ? detailPage(item) : retiredCard ? [head('', { back: true }), retiredPage(retiredCard)] : listPage()));
    typedNow = null;
    typedName = null;
    boxFresh = false;
    if (makingFocus && making.input.isConnected) { making.input.focus(); making.input.setSelectionRange(...makingFocus); }
    if (focused) {
      const again = view.querySelector(selector);
      again?.focus();
      // A right-click can swap the line box for the date box with the caret still in it (2026-10-28): a caret only goes
      // back into a text box.
      if (again && caret && again.type === 'text') again.setSelectionRange(...caret);
    }
  }

  return {
    draw: (next) => { draw(next || cards); loadRetired(); },
    // A queued Do it landed (onMoved): its row says where the draft went, or why it stopped.
    moved(text, taskId, phase) {
      if (!taskId) return;
      rowStatus.set(taskId, { writing: false, failed: ['failed', 'phone-only'].includes(phase), text: String(text || '') });
      draw();
    },
    // The look for workspaces said something (main.js discoverAndSay): it stays on the status line until the next one.
    say(text) { note = String(text || ''); draw(); },
    open,
    get shown() { return openName; },
  };
}
