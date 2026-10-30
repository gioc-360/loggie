// The nine-step setup page (docs/teammate-ready/spec.md B5, Gio's mock loggie-first-run-d.html): everything Loggie
// uses, turned on once, in the order that never wastes a trip; the calls last, because the screen switch counts only
// after a reopen. Each card has one filled button; anything skipped waits on Ready with its own button. Every press
// answers at once (the waiting line draws in the same frame); the only waits are macOS's own dialogs and the key tests.
// The rules (which step is next, the Ready rows) are setup-model.js; every call goes through `api`.
import { icon } from './icons.js';
import { checklistItem } from './checklist.js';
import { SETUP_YES } from './setup-cards.js';
import { countsLine, evidenceLine, keepLabel, progressFraction, progressLine, zeroCopy } from './found-model.js';
import { accountsLine, appsAsks, backStep, EMAIL_LINE, EMAIL_QUESTION, firstStep, MAIL_APP_TILES, mailCheckLines, nextMeetingLine, nextStep, NO_MAIL_STEPS, pills, pillsDetour, readyHeading, readyRows, SKIP_NO_MAIL, speechSwitchOn, STEPS } from './setup-model.js';

const POLL_MS = 1000;
const POLL_LIMIT_MS = 5 * 60 * 1000;
const PAY_MS = 750;
// The apps whose own icon main reads (hikyaku:app-icon, first-run-polish B2.2), and the four Gio drew a mark for, drawn
// whenever the Mac gives no icon (desktop/renderer/marks, copies of docs/first-run-polish/marks).
const APP_ICON_IDS = ['outlook', 'apple-mail', 'calendar', 'system-settings', 'messages', 'whatsapp'];
const BUNDLED = new Set(['outlook', 'apple-mail', 'messages', 'whatsapp']);
const DRAFTS_OPEN = { outlook: 'Drafts will open in Outlook, unsent.', 'apple-mail': 'Drafts will open in Apple Mail, unsent.' };

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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createSetupView({ root, api, onDone = () => {} }) {
  const state = { status: null, step: null, poll: null, voiceOff: null, returnTo: null, screenOpened: false, drawn: 0, icons: new Map(), settledAt: 0, readyCascaded: false,
    // The Found step (first-run-polish B4.7): the phase drawn, its rows in the order first shown, the rows dismissed
    // here (local until Keep or Later), the row whose name is being edited, and a redraw that waits for that editor.
    found: null, foundRows: [], dismissed: new Set(), editing: null, pendingFound: null,
    // The Calls step's speech switch (first-run-polish B5.2): on or off, whether this card drew it, the last
    // setup.download data seen, and the unsubscribe of the run events heard while Ready shows.
    speechOn: true, speechRow: false, download: null, entryOff: null,
    // Back and Forward (2026-10-28): the steps shown this run, the Email and Calls answers not saved yet (kept across a
    // Back), the Calendar step's next meeting, and the voice ask's listener, which outlives a Back so its answer is kept.
    seen: [], draft: {}, calendarNext: undefined, voiceAsk: null };
  try { state.screenOpened = sessionStorage.getItem('loggie.setup.screenOpened') === '1'; } catch { /* no storage: shown again */ }
  // Every app icon is asked for at once and nothing waits on them: a card uses the replies already in when it draws.
  for (const id of APP_ICON_IDS) {
    let asked;
    try { asked = api.appIcon(id); } catch (error) { asked = Promise.reject(error); }
    Promise.resolve(asked).then((reply) => state.icons.set(id, reply), () => state.icons.set(id, { app: id, installed: true, icon: null }));
  }

  // An app's mark, decided once at draw (B2.3): its own icon, else Gio's bundled mark for the four he drew, else none.
  // The one cloud yes (CLOUD_YES.ai, and the chats' own when chats were picked), the same from every setup step that
  // asks it: the found step, Your mail and the Ready row (cleanup 2026-10-27: three copies read "chats" two ways).
  async function sayCloudYes() {
    const chats = state.status.chats === true;
    await api.cloudYesAnswer('ai', 'yes');
    if (chats) await api.cloudYesAnswer('chats', 'yes');
    state.status.yes = { ai: true, chats };
  }

  function markOf(id) {
    const reply = state.icons.get(id);
    const src = reply ? reply.icon || (BUNDLED.has(id) ? `marks/${id}.png` : null) : null;
    if (!src) return null;
    const img = el('img');
    img.src = src;
    img.alt = '';
    return img;
  }
  const LOGOS = {
    welcome: () => icon('loggie'),
    calendar: () => markOf('calendar'),
    disk: () => markOf('system-settings'),
    apps: () => markOf(state.status.mailApp),
    voice: () => icon('mic'),
    calls: () => markOf('system-settings'),
    found: () => icon('loggie'),
  };
  // The top of a card: Back on every step after Welcome, its mark, the chat apps' small marks on Apps, then which step
  // this is. Back is a link, the quietest button setup has, so each card keeps its one filled button.
  function top(step) {
    const row = el('div', 'su-top');
    if (STEPS.includes(step) && (state.returnTo || backStep(step, state.status, state.seen))) row.append(link('‹ Back', back));
    const mark = LOGOS[step]?.();
    if (mark) { const logo = el('span', 'su-logo'); logo.append(mark); row.append(logo); }
    if (step === 'apps' && state.status.chats) {
      for (const id of state.status.installed?.whatsapp ? ['messages', 'whatsapp'] : ['messages']) {
        const small = markOf(id);
        if (small) { small.className = 'su-logo-small'; row.append(small); }
      }
    }
    if (STEPS.includes(step)) row.append(el('p', 'su-k', `Step ${STEPS.indexOf(step) + 1} of 9`));
    return row;
  }
  // A grant's tick on the card's mark, once per card; false when there is no mark to tick or it is already ticked.
  function markTick(card, still = false) {
    const logo = card.querySelector('.su-logo');
    if (!logo || logo.querySelector('.su-tick')) return false;
    const tick = el('span', `su-tick${still ? ' is-still' : ''}`, '✓');
    tick.setAttribute('aria-hidden', 'true');
    logo.append(tick);
    return true;
  }

  function stopWaiting() {
    clearInterval(state.poll); state.poll = null;
    state.voiceOff?.(); state.voiceOff = null;
  }
  function stopHearing() { state.entryOff?.(); state.entryOff = null; }
  function stopVoiceAsk() { state.voiceAsk?.(); state.voiceAsk = null; }

  // One step drawn: the pills, then the card. `draw` is a fresh frame each time; a card's own presses change it in place.
  // Motion (first-run-polish B2.4): when the step before and this one both have a now pill, the light moves from the
  // one to the other (pill-move), then the card comes in; the first draw of a page load draws the pill lit, at once.
  // The Found step shows every pill done (Ready's); a key added from Ready or Found lights only that step.
  const pillsFor = (step) => (step === 'found' ? pills('ready') : state.returnTo ? pillsDetour(step) : pills(step));
  const hasNow = (step) => pillsFor(step).some((pill) => pill.state === 'now');
  function show(step) {
    stopWaiting();
    stopHearing();
    const before = state.step;
    const moved = before !== null && before !== step && hasNow(before) && hasNow(step);
    const again = state.seen.includes(step);
    if (STEPS.includes(step) && !again) state.seen.push(step);
    state.step = step;
    state.drawn += 1;
    state.settledAt = performance.now() + 260;
    state.readyCascaded = false;
    const list = el('ol', 'su-steps');
    list.setAttribute('aria-label', 'Setup steps');
    for (const pill of pillsFor(step)) {
      const item = el('li', pill.state === 'todo' ? '' : pill.state, pill.label);
      if (pill.state === 'now') { item.setAttribute('aria-current', 'step'); if (!moved) item.classList.add('is-still'); }
      if (moved && pill.id === before) item.className = 'done was-now';
      list.append(item);
    }
    const card = el('section', `su-card${calm() ? ' is-still' : ''}${moved ? ' after-pill' : ''}`);
    card.dataset.step = step;
    card.append(top(step));
    root.replaceChildren(list, card);
    DRAW[step](card);
    const typeFirst = step === 'welcome' || step === 'keys';
    (typeFirst ? card.querySelector('input:not([readonly])') : card.querySelector('.btn-big:not(:disabled)'))?.focus({ preventScroll: true });
    if (again && step !== 'ready') recheck();
  }

  // A step shown again reads macOS again (2026-10-28): a grant made while away draws as granted, and nothing waits on
  // an ask the step started before a Back. A grant already seen stays granted: Back never undoes one, and a save in
  // flight (Mail control) is not read back as unknown. Ready reads the whole status itself.
  async function recheck() {
    const drawn = state.drawn;
    try {
      const fresh = await api.setupStatus('permissions');
      if (!fresh || drawn !== state.drawn) return;
      const was = JSON.stringify([state.status.permissions, state.status.mail?.accounts, state.status.mail?.kinds]);
      for (const [name, value] of Object.entries(fresh.permissions || {})) if (state.status.permissions[name] !== 'granted') state.status.permissions[name] = value;
      if (fresh.mail) state.status.mail = fresh.mail;
      if (JSON.stringify([state.status.permissions, state.status.mail?.accounts, state.status.mail?.kinds]) !== was) show(state.step);
    } catch { /* the step as drawn stands */ }
  }

  // Back (2026-10-28): the step before, with its answers as saved or as left; a detour from Ready or Found goes back
  // there. Leaving saves nothing: the Calls switch is kept as a draft, so Back never starts the speech download.
  function back() {
    if (state.returnTo === 'found') { state.returnTo = null; startFound(state.status); return; }
    if (state.returnTo === 'ready') { state.returnTo = null; show('ready'); return; }
    if (state.step === 'calls' && state.speechRow) state.draft.speechOn = state.speechOn;
    const to = backStep(state.step, state.status, state.seen);
    if (to) show(to);
  }

  // Leaves a step: the next one this Mac needs (or Ready, when a key was added from Ready), saved without waiting.
  function go(patch = {}) {
    // A key added from the Found step goes back to it and looks again; nothing is saved for it.
    if (state.returnTo === 'found') { state.returnTo = null; startFound(state.status, { look: true }); return; }
    const next = state.returnTo || nextStep(state.step, state.status);
    state.returnTo = null;
    // Every way out of Calls saves the speech switch it drew (B5.2); the same save moves the step on.
    if (state.step === 'calls' && state.speechRow) {
      patch = { ...patch, speechModels: state.speechOn };
      state.status.speech = { ...state.status.speech, chosen: state.speechOn };
      delete state.draft.speechOn;
    }
    api.setupSave({ ...patch, step: next }).catch((error) => console.error(`setup: ${error.message}`));
    show(next);
  }
  const head = (card, title, why) => { card.append(el('h3', '', title)); if (why) card.append(el('p', 'why', why)); };
  // A pay line: one per card. A card with a mark ticks the mark instead of drawing the line's own ✓. The line beside
  // Disk's mirror takes the waiting line's place; any other goes at the end of the card.
  // `cue` is the delay class of a line that follows a motion: `after-cue` (a tick or the mirror), `after-lift`.
  function pay(card, text, ok = false, cue = '') {
    const old = card.querySelector('.su-pay');
    const line = el('div', `su-pay${ok ? ' ok' : ''}${cue ? ` ${cue}` : ''}`);
    if (ok && !card.querySelector('.su-logo')) { const tick = el('span', 'tick', '✓'); tick.setAttribute('aria-hidden', 'true'); line.append(tick); }
    line.append(el('span', '', text));
    line.setAttribute('role', 'status');
    if (old?.parentElement?.classList.contains('su-wait')) old.replaceWith(line);
    else { old?.remove(); card.append(line); }
    return line;
  }
  const big = (label, onClick) => button(label, onClick, 'btn-big');
  const plain = (label, onClick) => button(label, onClick, 'su-plain');
  const link = (label, onClick) => button(label, onClick, 'linkish');
  const after = async (ms, then) => { const drawn = state.drawn; await wait(ms); if (drawn === state.drawn) then(); };
  const fail = (card, error, again) => { pay(card, error?.message || String(error)); if (again) again.disabled = false; };

  // Contract C: a pane is open; the status is read every second while this step shows, up to five minutes.
  function pollFor(card, permission, { onGranted, again }) {
    const line = pay(card, 'Waiting for the switch…');
    const started = Date.now();
    clearInterval(state.poll);
    const drawn = state.drawn;
    state.poll = setInterval(async () => {
      if (drawn !== state.drawn) { clearInterval(state.poll); return; }
      if (Date.now() - started > POLL_LIMIT_MS) {
        clearInterval(state.poll); state.poll = null;
        line.lastChild.textContent = 'Still off. Press the button to open the pane again.';
        if (again) again.disabled = false;
        return;
      }
      try {
        const fresh = await api.setupStatus('permissions');
        if (!fresh || drawn !== state.drawn) return;
        Object.assign(state.status.permissions, fresh.permissions || {});
        if (fresh.mail) state.status.mail = fresh.mail;
        if (fresh.permissions?.[permission] === 'granted') { clearInterval(state.poll); state.poll = null; onGranted(); }
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return line;
  }

  const DRAW = {
    welcome(card) {
      head(card, 'Set up Loggie once', 'Loggie reads your mail, chats and calls, finds your work, and writes each reply in your own mail app. You press Send. Nine steps, about a minute. Nothing leaves this Mac until you say yes.');
      const label = el('label', 'su-label', 'Your first name');
      const name = el('input', 'su-name');
      name.type = 'text';
      name.maxLength = 40;
      name.autocomplete = 'given-name';
      name.value = state.status.signName || state.status.suggestedName || '';
      label.append(name);
      const start = () => { state.status.signName = name.value.replace(/\s+/g, ' ').trim(); go({ signName: state.status.signName }); };
      name.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); start(); } });
      card.append(label, el('p', 'su-note', 'Signs your drafts and spots when a chat names you.'), big('Start', start));
    },

    email(card) {
      head(card, EMAIL_QUESTION, EMAIL_LINE);
      // A pick not continued yet is kept as a draft, so a Back and a Start bring it back (2026-10-28).
      let chosen = state.draft.mailApp ?? state.status.mailApp;
      let chats = state.draft.chats ?? Boolean(state.status.chats);
      const row = el('div', 'choice-row');
      const next = big('Continue', () => { state.status.mailApp = chosen; state.status.chats = chats; state.draft = {}; go({ mailApp: chosen, chats }); });
      next.disabled = !chosen;
      for (const [id, label] of MAIL_APP_TILES) {
        const choice = button('', () => {
          chosen = id;
          state.draft.mailApp = id;
          row.querySelectorAll('.choice').forEach((node) => node.setAttribute('aria-pressed', String(node === choice)));
          // The first choice lifts Continue, then the pay line says where drafts open; a later choice swaps its words.
          const lifting = next.disabled;
          next.disabled = false;
          const line = card.querySelector('.su-pay');
          if (line) line.lastChild.textContent = DRAFTS_OPEN[id];
          else pay(card, DRAFTS_OPEN[id], false, lifting ? 'after-lift' : '');
          next.focus();
        }, 'choice');
        choice.setAttribute('aria-pressed', String(chosen === id));
        const mark = markOf(id);
        if (mark) { const tile = el('span', 'su-tile-icon'); tile.append(mark); choice.append(tile); }
        choice.append(el('span', 'su-tile-name', label));
        if (state.icons.get(id)?.installed === false) { choice.classList.add('is-missing'); choice.append(el('small', 'su-tile-note', 'not installed')); }
        row.append(choice);
      }
      const texts = el('div', 'rowx-plain');
      const words = el('div');
      words.append(el('strong', '', 'Texts too'));
      const toggle = button('', () => { chats = !chats; state.draft.chats = chats; toggle.setAttribute('aria-checked', String(chats)); }, 'switch');
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(chats));
      toggle.setAttribute('aria-label', 'Texts too');
      texts.append(words, toggle);
      card.append(row, texts, next);
    },

    calendar(card) {
      head(card, 'Your calendar', 'Loggie sees your next meeting and offers to record it.');
      // Shown again with Calendar on (a Back, 2026-10-28): it reads as on, and Continue goes on.
      if (state.status.permissions.calendar === 'granted') {
        markTick(card, true);
        pay(card, state.calendarNext === undefined ? 'Calendar: on.' : nextMeetingLine(state.calendarNext), true);
        card.append(big('Continue', () => go()));
        return;
      }
      const allow = big('Allow Calendar', async () => {
        allow.disabled = true;
        const line = pay(card, 'macOS is asking. Press OK.');
        const slow = setTimeout(() => { if (line.isConnected) line.lastChild.textContent = 'Building the calendar helper, once. This can take a minute.'; }, 1500);
        try {
          const answer = await api.setupAsk('calendar');
          clearTimeout(slow);
          state.status.permissions.calendar = answer?.status || 'unknown';
          if (answer?.status === 'granted') { state.calendarNext = answer.next ?? null; const cue = markTick(card); pay(card, nextMeetingLine(answer.next), true, cue ? 'after-cue' : ''); }
          else pay(card, 'Calendar is off for now. It waits at the end.');
          after(PAY_MS, () => go());
        } catch (error) { clearTimeout(slow); fail(card, error, allow); }
      });
      card.append(allow);
    },

    disk(card) {
      const host = state.status.hostApp || 'Loggie';
      head(card, 'One switch reads your mail, texts, contacts and files', `macOS opens the pane. Switch on ${host} and confirm with Touch ID.`);
      // The live mail check (2026-10-28, teammates' mail fix 1): after the switch, one line per kind of account with its
      // newest mail, then Continue; with none read, the plain steps and a skip that says what it costs. The mail is read
      // again every second while this card shows, so an account added now turns the card into the found one.
      const checkLines = () => {
        const list = el('ul', 'su-mail-check');
        list.setAttribute('aria-label', 'Mail in Apple Mail');
        for (const line of mailCheckLines(state.status.mail)) { const item = el('li', '', line.text); item.dataset.kind = line.kind; list.append(item); }
        if (state.status.mail?.error && state.status.mail.error !== 'full-disk') list.append(el('li', 'su-mail-error', `Apple Mail could not be read: ${state.status.mail.error}`));
        return list;
      };
      const mailCheck = (cue = '') => {
        card.querySelectorAll('.su-mail-check, .su-mail-steps, .su-plain-row').forEach((node) => node.remove());
        const found = Number(state.status.mail?.accounts) > 0;
        card.querySelectorAll(':scope > .su-note, :scope > .linkish').forEach((node) => node.remove());
        pay(card, found ? accountsLine(state.status.mail) : 'Your mail is not in Apple Mail yet.', found, cue);
        if (state.status.mail?.kinds?.length || state.status.mail?.error) card.append(checkLines());
        const row = el('div', 'su-foot su-plain-row');
        if (found) row.append(big('Continue', () => go()));
        else {
          const steps = el('ol', 'su-mail-steps');
          for (const step of NO_MAIL_STEPS) steps.append(el('li', '', step));
          card.append(steps);
          row.append(plain('Open Internet Accounts', () => api.setupAsk('mailAccounts').catch((error) => fail(card, error))), big(SKIP_NO_MAIL, () => go()));
        }
        card.append(row);
        row.querySelector('.btn-big').focus({ preventScroll: true });
        watchMail();
      };
      // The step's own poll: the mail part of the status, every second, up to five minutes; a change redraws the lines.
      const watchMail = () => {
        if (state.poll) return;
        const drawn = state.drawn;
        const started = Date.now();
        state.poll = setInterval(async () => {
          if (drawn !== state.drawn || Date.now() - started > POLL_LIMIT_MS) { clearInterval(state.poll); state.poll = null; return; }
          try {
            const fresh = await api.setupStatus('permissions');
            if (!fresh?.mail || drawn !== state.drawn) return;
            const before = JSON.stringify([state.status.mail?.accounts, state.status.mail?.kinds, state.status.mail?.error]);
            state.status.mail = fresh.mail;
            if (JSON.stringify([fresh.mail.accounts, fresh.mail.kinds, fresh.mail.error]) !== before) mailCheck();
          } catch { /* the next tick tries again */ }
        }, POLL_MS);
      };
      // The poll read the switch on: the mirror moves, then the pay line follows it.
      const granted = () => mailCheck('after-cue');
      const open = big('Open Full Disk Access', async () => {
        open.disabled = true;
        try {
          await api.setupAsk('fullDisk');
          // A small switch beside the waiting line mirrors the real one: it turns on when the poll reads it on.
          const mirror = el('span', 'switch su-mirror');
          mirror.setAttribute('aria-hidden', 'true');
          const line = pollFor(card, 'fullDisk', { onGranted: () => { mirror.dataset.on = 'true'; granted(); }, again: open });
          const waiting = el('div', 'su-wait');
          line.replaceWith(waiting);
          waiting.append(line, mirror);
          card.append(el('p', 'su-note', `Not in the list? Press + and add ${host}.`));
          const later = link('Not now', () => go());
          card.append(later);
        } catch (error) { fail(card, error, open); }
      });
      card.append(open);
      if (state.status.permissions.fullDisk === 'granted') { open.remove(); mailCheck(); }
    },

    apps(card) {
      const app = state.status.mailApp;
      head(card, { outlook: 'Let Loggie place drafts in Outlook', 'apple-mail': 'Let Loggie place drafts in Apple Mail' }[app] || 'Your drafts', 'Every draft lands in the right thread, unsent. You press Send.');
      const todo = appsAsks(state.status).filter((ask) => state.status.permissions[ask] !== 'granted');
      const block = el('div', 'su-ask');
      card.append(block);
      const nextAsk = () => { todo.shift(); if (todo.length) after(PAY_MS, drawAsk); else after(PAY_MS, () => go()); };
      function drawAsk() {
        block.replaceChildren();
        card.querySelector('.su-pay')?.remove();
        card.querySelector(':scope > .linkish')?.remove();
        const ask = todo[0];
        if (ask === 'automation') {
          block.append(el('p', 'why', 'Loggie opens the reply in Mail and pastes the draft. Mail comes forward for a moment.'));
          const allow = big('Allow Mail control', async () => {
            allow.disabled = true;
            pay(card, 'macOS is asking. Press OK.');
            try {
              const answer = await api.setupAsk('automation');
              const status = answer?.status || 'unknown';
              state.status.permissions.automation = status;
              api.setupSave({ automation: status }).catch(() => {});
              if (status === 'granted') { const cue = markTick(card); pay(card, 'Drafts will open in Apple Mail, unsent.', true, cue ? 'after-cue' : ''); }
              else pay(card, 'Mail control is off for now. It waits at the end.');
              nextAsk();
            } catch (error) { fail(card, error, allow); }
          });
          block.append(allow);
          allow.focus();
        } else if (ask === 'accessibility') {
          const why = app === 'outlook' ? 'Outlook takes a draft only the way you would type it, so Loggie needs Accessibility.'
            : app === 'apple-mail' ? 'The paste needs Accessibility.' : 'Chat drafts go into the chat window, which needs Accessibility.';
          block.append(el('p', 'why', why));
          const allow = big('Allow Accessibility', async () => {
            allow.disabled = true;
            try {
              const answer = await api.setupAsk('accessibility');
              const on = () => { const cue = markTick(card); pay(card, 'Accessibility: on.', true, cue ? 'after-cue' : ''); nextAsk(); };
              if (answer?.status === 'granted') { state.status.permissions.accessibility = 'granted'; on(); return; }
              pollFor(card, 'accessibility', { onGranted: on, again: allow });
              card.append(link('Not now', () => { todo.shift(); if (todo.length) drawAsk(); else go(); }));
            } catch (error) { fail(card, error, allow); }
          });
          block.append(allow);
          allow.focus();
        }
      }
      if (!todo.length) {
        block.append(el('p', 'why', DRAFTS_OPEN[app] || 'Every draft opens unsent.'));
        block.append(big('Continue', () => go()));
      } else drawAsk();
    },

    voice(card) {
      head(card, 'Talk to Loggie', 'Press the mic in the ask bar and say it. Recognized on this Mac.');
      // Shown again after voice typing was turned on (a Back, 2026-10-28): it reads as on, and Continue goes on.
      if (state.status.voice?.answer === 'granted') {
        markTick(card, true);
        pay(card, 'Voice typing is on.', true);
        card.append(big('Continue', () => go()));
        return;
      }
      const drawn = state.drawn;
      const done = (answer) => {
        state.status.voice = { ...state.status.voice, answer };
        if (answer === 'granted') { const cue = markTick(card); pay(card, 'Voice typing is on.', true, cue ? 'after-cue' : ''); }
        else pay(card, 'Voice typing is off for now. It comes back at the end.');
        after(PAY_MS, () => go({ voice: answer }));
      };
      // macOS answers on the voice channel. A Back while it asks keeps listening (2026-10-28): the answer is saved, and
      // the step shown again draws it, so a second ask never meets the first one still running.
      const hear = () => {
        stopVoiceAsk();
        state.voiceAsk = api.onVoice?.((data) => {
          const answer = data?.status === 'permissions-complete' ? 'granted' : data?.error ? 'denied' : null;
          if (!answer) return;
          stopVoiceAsk();
          if (drawn === state.drawn) { done(answer); return; }
          state.status.voice = { ...state.status.voice, answer };
          api.setupSave({ voice: answer }).catch((error) => console.error(`setup: ${error.message}`));
          if (state.step === 'voice') show('voice');
        }) || null;
      };
      const allow = big('Allow voice typing', async () => {
        allow.disabled = true;
        pay(card, 'macOS asks twice: Speech Recognition, then the microphone.');
        hear();
        try {
          const answer = await api.setupAsk('speech');
          if (answer?.status === 'missing') {
            stopVoiceAsk();
            pay(card, 'Voice typing needs one build: run npm run build:voice in Terminal. It waits at the end.');
            allow.remove();
            const next = big('Continue', () => go());
            card.append(next);
            next.focus();
          }
        } catch (error) { stopVoiceAsk(); fail(card, error, allow); }
      });
      card.append(allow, link('Not now', () => go()));
      // Still asking from before a Back: the button waits for that answer instead of asking again.
      if (state.voiceAsk) { allow.disabled = true; pay(card, 'macOS asks twice: Speech Recognition, then the microphone.'); hear(); }
    },

    keys(card) {
      head(card, 'Paste your two keys');
      const boxes = el('div', 'keys');
      const yes = button('Yes', () => sayYes(), 'su-plain su-yes');
      const done = { nebius: Boolean(state.status.keys?.nebius), tavily: Boolean(state.status.keys?.tavily) };
      // Both keys work: Yes fills in (lift) and becomes the one filled button. At draw the classes go on before Yes is
      // in the page, so nothing moves; focus goes to Yes unless the person is typing in a key box.
      const lift = ({ drawing = false } = {}) => {
        if (!done.nebius || !done.tavily || yes.disabled || yes.classList.contains('is-lifted')) return;
        yes.classList.add('is-lifted', 'btn-big');
        if (!drawing && !document.activeElement?.matches?.('.keyrow input:not([readonly])')) yes.focus();
      };
      const box = (id, label, save, test) => {
        const wrap = el('label', 'keybox');
        wrap.append(el('span', 'su-label', label));
        const row = el('span', 'keyrow');
        const input = el('input');
        input.type = 'password';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', label);
        input.dataset.key = id;
        const said = el('span', `state${done[id] ? ' ok' : ''}`, done[id] ? 'Saved' : '');
        said.setAttribute('role', 'status');
        row.append(input, said);
        wrap.append(row);
        // Contract D: the key leaves the field at once; the page never draws any part of it.
        input.addEventListener('input', async () => {
          const value = input.value.trim();
          if (value.length < 8) return;
          done[id] = false;
          yes.classList.remove('is-lifted', 'btn-big');
          input.value = '';
          input.readOnly = true;
          said.className = 'state';
          said.textContent = 'Checking…';
          const started = performance.now();
          try {
            await save(value);
            const result = await test();
            if (!result?.ok) throw new Error(result?.message || 'The test did not work. Check the key and try again.');
            done[id] = true;
            // Kept for the step shown again after a Back (2026-10-28): the key reads Saved, never asked for twice.
            state.status.keys = { ...state.status.keys, [id]: true };
            said.className = 'state ok';
            said.textContent = `Works, ${((performance.now() - started) / 1000).toFixed(1)} s`;
            if (done.nebius && done.tavily) lift();
            else (boxes.querySelector('input:not([readonly])') || yes).focus();
          } catch (error) {
            said.className = 'state';
            said.textContent = error.message;
            input.readOnly = false;
            input.focus();
          }
        });
        return wrap;
      };
      boxes.append(box('nebius', 'Nebius · Nemotron writes your notes and replies', api.saveKey, api.testKey),
        box('tavily', 'Tavily · looks up facts and company names, never a person', api.saveTavilyKey, api.testTavilyKey));
      const consent = el('div', 'su-yes-block');
      consent.append(el('p', 'su-strong', SETUP_YES.ai));
      if (state.status.chats) consent.append(el('p', 'su-strong', SETUP_YES.chats));
      const foot = el('div', 'su-foot');
      foot.append(yes, link('Skip for now', () => go()));
      async function sayYes() {
        yes.disabled = true;
        try {
          await sayCloudYes();
          pay(card, 'Yes saved. Loggie starts reading when setup ends.', true);
          after(PAY_MS, () => go());
        } catch (error) { fail(card, error, yes); }
      }
      lift({ drawing: true });
      card.append(boxes, consent, foot);
      if (state.status.yes?.ai && (!state.status.chats || state.status.yes?.chats)) { yes.textContent = 'Continue'; yes.onclick = null; yes.replaceWith(big('Continue', () => go())); pay(card, 'Yes saved. Loggie starts reading when setup ends.', true); }
    },

    calls(card) {
      head(card, 'Record your calls, both sides', 'Microphone for you, screen audio for them. Loggie reopens once at the end.');
      const host = state.status.hostApp || 'Loggie';
      // The speech switch (B5.2, D3): on unless saved off; nothing is saved until the person leaves Calls. A Mac that
      // always downloads the models (packaged, or the env) has nothing to choose.
      state.speechRow = !state.status.speech?.always;
      if (state.speechRow) {
        state.speechOn = state.draft.speechOn ?? speechSwitchOn(state.status);
        const row = el('div', 'rowx-plain');
        const words = el('div');
        const note = el('span', 'su-note');
        const gb = (Number(state.status.speech?.bytes) / 1e9 || 0).toFixed(2);
        note.append(el('span', 'su-nvidia', 'NVIDIA'), ` Parakeet and Nemotron speech, ${gb} GB, in the background.`);
        words.append(el('strong', '', 'Write down my calls on this Mac'), note);
        const toggle = button('', () => { state.speechOn = !state.speechOn; toggle.setAttribute('aria-checked', String(state.speechOn)); }, 'switch');
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(state.speechOn));
        toggle.setAttribute('aria-label', 'Write down my calls on this Mac');
        row.append(words, toggle);
        card.append(row);
      }
      const screenPart = () => {
        const open = big('Open Screen & System Audio Recording', async () => {
          open.disabled = true;
          try {
            await api.setupAsk('screen');
            state.screenOpened = true;
            try { sessionStorage.setItem('loggie.setup.screenOpened', '1'); } catch { /* shown again */ }
            open.remove();
            card.append(el('p', 'why', `Switch on ${host}. If macOS offers Quit & Reopen, press Later, then press it here.`));
            const foot = el('div', 'su-foot');
            foot.append(big('Quit & Reopen', reopen), plain('Later', () => go()));
            card.append(foot);
            foot.querySelector('.btn-big').focus();
          } catch (error) { fail(card, error, open); }
        });
        card.append(open);
        return open;
      };
      // Both grants in already: the step shows only for the switch, so it ends on a filled Continue.
      if (state.status.permissions.microphone === 'granted' && state.status.permissions.screen === 'granted') {
        markTick(card, true); pay(card, 'Microphone: on.', true); card.append(big('Continue', () => go())); return;
      }
      if (state.status.permissions.microphone === 'granted') { markTick(card, true); pay(card, 'Microphone: on.', true); screenPart(); return; }
      const mic = big('Allow the microphone', async () => {
        mic.disabled = true;
        pay(card, 'macOS is asking. Press OK.');
        try {
          const answer = await api.setupAsk('microphone');
          state.status.permissions.microphone = answer?.status || 'unknown';
          const cue = answer?.status === 'granted' && markTick(card);
          pay(card, answer?.status === 'granted' ? 'Microphone: on.' : 'The microphone is off for now. It waits at the end.', answer?.status === 'granted', cue ? 'after-cue' : '');
          mic.remove();
          screenPart().focus();
        } catch (error) { fail(card, error, mic); }
      });
      card.append(mic);
    },

    found(card) { drawFoundCard(card); },

    ready(card) {
      head(card, 'Getting your checklist…', 'Anything off says how to turn it on.');
      // The speech download's events while Ready shows (B5.2): only the speech row changes, in place.
      state.entryOff = api.onEntry?.((event) => heardDownload(card, event)) || null;
      api.setupSave({ step: 'ready' }).catch(() => {}).then(() => api.setupStatus()).then((fresh) => {
        if (fresh) state.status = fresh;
        drawReady(card);
      }, () => drawReady(card));
    },
  };

  // Contract F: the step is saved before the reopen, so the new window lands on Ready.
  async function reopen() {
    // From Calls, the switch is saved first: the new process starts the download from it (B5.2).
    const speech = state.step === 'calls' && state.speechRow ? { speechModels: state.speechOn } : {};
    try { await api.setupSave({ step: 'ready', ...speech }); } catch { /* the reopen still lands near Ready */ }
    root.replaceChildren(el('p', 'reopening', 'Reopening Loggie…'));
    await api.relaunch();
  }

  function drawReady(card) {
    if (state.step !== 'ready' || !card.isConnected) return;
    const rows = readyRows(state.status, { screenOpened: state.screenOpened, download: state.download });
    card.querySelector('h3').textContent = readyHeading(state.status, rows);
    card.querySelector('.su-checklist')?.remove();
    card.querySelector('.su-ready-foot')?.remove();
    const list = el('ul', 'checklist su-checklist');
    // The first draw of Ready lights its On pills one after another, once the card has come in; a redraw draws them still.
    const cascade = !state.readyCascaded;
    state.readyCascaded = true;
    const base = Math.max(0, state.settledAt - performance.now());
    let lit = 0;
    for (const row of rows) {
      const delay = cascade && row.state === 'on' ? base + 40 * lit : null;
      if (delay !== null) lit += 1;
      list.append(readyItem(row, delay));
    }
    const foot = el('div', 'su-ready-foot');
    // A first run ends on the Found step: Ready says so and its button names it (first-run-polish B4.7).
    const firstRun = Boolean(state.status.firstRun);
    if (firstRun) foot.append(el('p', 'su-note', 'Next, Loggie reads your last 30 days of mail and shows what it found. A few minutes.'));
    const done = big(firstRun ? 'Find my workspaces' : 'Done', async () => {
      done.disabled = true;
      try {
        const reply = await api.setupSave({ done: true });
        stopWaiting();
        if (reply?.setup?.found === 'pending') startFound(state.status);
        else finish({ later: false });
      } catch (error) { fail(card, error, done); }
    });
    foot.append(done);
    card.append(list, foot);
    done.focus({ preventScroll: true });
  }

  // One Ready row: its state pill (lit in the cascade when `delay` is a number), label, note, button, and the speech
  // row's bar while it downloads (B5.2).
  function readyItem(row, delay = null) {
    return checklistItem(row, { delay, onPress: (pressed, item) => rowPress(pressed, item) });
  }
  // A setup.download event: kept for the next draw, and on a drawn Ready only the speech row changes (its label and
  // bar in place; a new li when its state pill flips, Note to On), with no list redraw and no cascade.
  function heardDownload(card, event) {
    if (event?.type !== 'setup.download' || !event.data) return;
    state.download = event.data;
    if (state.step !== 'ready' || !card.isConnected) return;
    const item = card.querySelector('.su-checklist li[data-row="speech"]');
    const row = readyRows(state.status, { screenOpened: state.screenOpened, download: state.download }).find((one) => one.key === 'speech');
    if (!item || !row) return;
    if (!item.querySelector('.st')?.classList.contains(row.state)) { item.replaceWith(readyItem(row)); return; }
    item.querySelector('.lbl').textContent = row.label;
    const bar = item.querySelector('.su-fill > i');
    if (bar && row.fill !== null) bar.style.transform = `scaleX(${row.fill})`;
  }

  // --- The Found step (first-run-polish B4.7): what the look found since Done, kept, renamed or dismissed before
  // Today. Every phase draws a whole new card; only the bar changes in place. A found card's mail is read only after
  // Keep (main, D1): nothing here asks for a read.
  function finish({ later }) {
    state.step = null;
    state.foundRows = []; state.dismissed = new Set(); state.editing = null; state.pendingFound = null;
    stopWaiting();
    stopHearing();
    stopVoiceAsk();
    onDone({ later });
  }
  // Rows keep the order they were first shown in; a later look's new names go at the end.
  function drawFound(found) {
    if (found.phase === 'found') {
      const fresh = new Map(found.rows.map((row) => [row.name, row]));
      const kept = state.foundRows.filter((row) => fresh.has(row.name)).map((row) => fresh.get(row.name));
      state.foundRows = [...kept, ...found.rows.filter((row) => !kept.some((old) => old.name === row.name))];
    }
    state.found = found;
    state.pendingFound = null;
    show('found');
  }
  const failedZero = (message) => ({ phase: 'zero', progress: null, rows: [], zero: { reason: 'failed', message } });
  // One error line at the card's foot, the last one replaced; the phase stays.
  function cardError(card, error, again) {
    card.querySelector(':scope > .su-error')?.remove();
    const line = el('p', 'su-error', error?.message || String(error));
    line.setAttribute('role', 'alert');
    card.append(line);
    if (again) again.disabled = false;
  }
  // The result comes only from the look's done event (onDiscover), so a look that ends before this reply cannot
  // leave the card on searching.
  async function lookFlow() {
    drawFound({ phase: 'searching', progress: null, rows: [], zero: null });
    try { await api.foundLook(); } catch (error) { if (state.step === 'found') drawFound(failedZero(error.message)); }
  }
  function startFound(status, { look = false } = {}) {
    state.status = { ...(status || {}), permissions: { ...(status?.permissions || {}) } };
    state.step = 'found';
    if (look) { lookFlow(); return; }
    api.foundStatus().then((found) => {
      if (state.step !== 'found') return;
      if (!found || found.phase === 'idle') lookFlow(); else drawFound(found);
    }, (error) => { if (state.step === 'found') drawFound(failedZero(error.message)); });
  }
  const keepChoice = () => ({
    keep: state.foundRows.filter((row) => !state.dismissed.has(row.name)).map((row) => row.name),
    dismiss: state.foundRows.filter((row) => state.dismissed.has(row.name)).map((row) => row.name),
  });
  function laterLink(card) {
    const later = link('Later', async () => {
      later.disabled = true;
      try { await api.foundKeep({ keep: [], dismiss: keepChoice().dismiss, end: 'later' }); finish({ later: true }); } catch (error) { cardError(card, error, later); }
    });
    return later;
  }
  const setFill = (bar, progress) => { bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progressFraction(progress)))})`; };

  function foundRow(card, row, recount) {
    const item = el('li');
    item.dataset.name = row.name;
    const gone = state.dismissed.has(row.name);
    if (gone) item.classList.add('is-dismissed');
    const shown = () => row.label || row.name;
    const title = el('strong', '', shown());
    item.append(title);
    const evidence = evidenceLine(row);
    if (evidence) item.append(el('p', 'su-note', evidence));
    const counts = countsLine(row);
    if (counts) item.append(el('p', 'su-note', counts));
    const acts = el('div', 'su-foot');
    const redraw = () => { item.replaceWith(foundRow(card, row, recount)); recount(); };
    const toggle = button(gone ? 'Undo' : 'Dismiss', () => { if (gone) state.dismissed.delete(row.name); else state.dismissed.add(row.name); redraw(); }, 'su-plain small');
    if (!gone) {
      acts.append(link('Edit name', () => {
        state.editing = row.name;
        const input = el('input', 'su-name');
        input.type = 'text';
        input.maxLength = 60;
        input.value = shown();
        input.setAttribute('aria-label', `New name for ${shown()}`);
        const close = () => {
          state.editing = null;
          if (state.pendingFound) { drawFound(state.pendingFound); return; }
          redraw();
        };
        const save = async () => {
          const v = input.value.replace(/\s+/g, ' ').trim();
          if (!v) return;
          if (v === shown()) { close(); return; }
          saveButton.disabled = true;
          try {
            const reply = await api.renameWorkstream(row.name, v === row.name ? null : v);
            row.label = reply?.label || null;
            close();
          } catch (error) {
            saveButton.disabled = false;
            item.querySelector('.su-error')?.remove();
            const line = el('p', 'su-error', error.message);
            line.setAttribute('role', 'alert');
            item.append(line);
          }
        };
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(); }
          if (event.key === 'Escape') { event.preventDefault(); close(); }
        });
        const saveButton = button('Save', save, 'su-plain small');
        const editor = el('div', 'su-foot');
        editor.append(input, saveButton, link('Cancel', close));
        title.replaceWith(editor);
        acts.remove();
        input.focus();
      }));
    }
    acts.append(toggle);
    item.append(acts);
    return item;
  }

  function drawFoundCard(card) {
    const found = state.found || { phase: 'searching', progress: null, rows: [], zero: null };
    if (found.phase === 'searching') {
      head(card, 'Looking through your last 30 days of mail…', 'A few minutes. You can wait here or press Later.');
      const bar = el('div', 'su-fill');
      const fill = el('i');
      bar.append(fill);
      setFill(fill, found.progress);
      const foot = el('div', 'su-foot');
      foot.append(laterLink(card));
      card.append(bar, el('p', 'su-note', progressLine(found.progress)), foot);
      return;
    }
    if (found.phase === 'found') {
      head(card, 'Here is the work Loggie found', 'From your last 30 days of mail. Keep what is yours.');
      const list = el('ul', 'su-found');
      const foot = el('div', 'su-ready-foot');
      const keep = big('', async () => {
        keep.disabled = true;
        try { await api.foundKeep({ ...keepChoice(), end: 'done' }); finish({ later: false }); } catch (error) { cardError(card, error, keep); }
      });
      const recount = () => { const { keep: kept } = keepChoice(); keep.textContent = keepLabel(kept.length, state.foundRows.length); };
      for (const row of state.foundRows) list.append(foundRow(card, row, recount));
      recount();
      foot.append(keep, laterLink(card));
      card.append(list, foot);
      return;
    }
    const copy = zeroCopy(found.zero);
    head(card, 'Nothing to keep yet', copy.line);
    const run = (act, control) => async () => {
      control.disabled = true;
      try {
        if (act === 'ask') { await api.setupAsk('mailAccounts'); control.disabled = false; return; }
        if (act === 'yes') {
          await sayCloudYes();
          lookFlow();
          return;
        }
        if (act === 'key') { state.returnTo = 'found'; show('keys'); return; }
        if (act === 'look') { lookFlow(); return; }
        await api.foundKeep({ keep: [], dismiss: [], end: 'done' });
        finish({ later: false });
      } catch (error) { cardError(card, error, control); }
    };
    const foot = el('div', 'su-ready-foot');
    const filled = big(copy.button.label, () => run(copy.button.act, filled)());
    foot.append(filled);
    for (const item of copy.links) { const node = link(item.label, () => run(item.act, node)()); foot.append(node); }
    card.append(foot);
  }

  // Contract G: a row's button runs its ask and redraws from a fresh status.
  async function rowPress(row, item) {
    const press = item.querySelector('button');
    if (press) press.disabled = true;
    const card = item.closest('.su-card');
    const redraw = async () => { try { state.status = (await api.setupStatus()) || state.status; } catch { /* keep the last */ } drawReady(card); };
    try {
      if (row.button.go) { state.returnTo = 'ready'; show(row.button.go); return; }
      if (row.button.relaunch) { await reopen(); return; }
      if (row.button.yes) {
        await sayCloudYes();
        await redraw();
        return;
      }
      const answer = await api.setupAsk(row.button.ask);
      if (row.button.ask === 'speech' && answer?.status === 'starting') {
        state.voiceOff = api.onVoice?.(async (data) => {
          if (!data?.status && !data?.error) return;
          stopWaiting();
          await api.setupSave({ voice: data.status === 'permissions-complete' ? 'granted' : 'denied' }).catch(() => {});
          await redraw();
        }) || null;
        return;
      }
      if (answer?.opened) {
        const permission = row.button.ask === 'mailAccounts' ? 'fullDisk' : row.button.ask;
        pollFor(card, permission, { onGranted: redraw });
        return;
      }
      await redraw();
    } catch (error) { fail(card, error, press); }
  }

  return {
    // `again`: Settings' Set up again (2026-10-28) opens Welcome on a Mac that is set up, filled in with what is
    // saved; nothing is cleared, and Ready's Done marks it done again.
    start(status, { again = false } = {}) {
      state.status = { ...status, permissions: { ...(status?.permissions || {}) } };
      state.seen = []; state.draft = {}; state.returnTo = null; state.step = null;
      show(again ? 'welcome' : firstStep(state.status) || 'ready');
    },
    startFound,
    // A look's events (panel onMoved, phase discover): progress moves the bar in place; the end draws its result.
    onDiscover(outcome) {
      if (state.step !== 'found') return;
      if (outcome?.data) {
        if (state.found?.phase !== 'searching') return;
        state.found.progress = outcome.data;
        const card = root.querySelector('.su-card[data-step="found"]');
        const fill = card?.querySelector('.su-fill > i');
        if (fill) setFill(fill, outcome.data);
        const line = card?.querySelector('.su-fill + .su-note');
        if (line) line.textContent = progressLine(outcome.data);
        return;
      }
      if (!outcome?.done) return;
      api.foundStatus().then((found) => {
        if (state.step !== 'found') return;
        const next = !found || found.phase === 'idle' ? failedZero('The look ended without a result.') : found;
        if (state.editing) state.pendingFound = next; else drawFound(next);
      }, (error) => { if (state.step === 'found') drawFound(failedZero(error.message)); });
    },
    stop() { stopWaiting(); stopHearing(); stopVoiceAsk(); },
  };
}
