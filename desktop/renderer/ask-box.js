// The ask box in the panel (loggie-ask-box, mock https://claude.ai/artifact/RSXjGnPZXo6zxyB3osA2sS; the word map,
// loggie-ask-wordmap, mock https://claude.ai/artifact/Qj9k6p9QVpDDf6hCKPBUiR). While typing, every word is underlined
// in the color of the role it plays (who, when, where, about, message), and the strip under the box fills one slot
// per role, in any word order; the last small word typed says what it expects next. A word nobody asked for is
// dotted, with a button to make it the subject or the place, or to drop it. On send, the box becomes one status line
// with the step count and Stop; at the end one card says where the draft is, unsent. Up and Down bring back earlier
// asks; Esc clears. Invites and file opens go to the panel's old command path.
const APP = { messages: 'Messages', whatsapp: 'WhatsApp', outlook: 'Outlook', 'apple-mail': 'Mail', gmail: 'Gmail', google: 'Google Calendar' };
const ACTION_LABEL = { invite: 'Invite', message: 'Text', reply: 'Email', said: 'Read', move: 'Move', open: 'Open' };
const ROLE_LABEL = { action: '', who: 'who', when: 'when', where: 'where', about: 'about', kind: 'about', room: 'where', notes: 'about', message: 'message', app: 'app', unused: 'not used' };
const clock = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
// The examples start a sentence and leave the name to the user: a made-up name in an example matched a real contact
// and texted her (2026-10-11).
const EXAMPLES = [['Text someone…', 'Text '], ['Reply to someone…', 'Reply to '], ['WhatsApp a group…', 'WhatsApp the '], ['Invite someone…', 'Invite ']];
// What the last small word typed expects next (the word map's signal words).
const HINTS = {
  and: 'another person', '&': 'another person', '+': 'another person', ',': 'another person', with: 'a person',
  to: 'a person, or the kind of meeting (to lunch)', at: 'a time (at 5) or a place (at Maplewood)', '@': 'a time or a place',
  in: 'a place (in Birch Hall)', on: 'a day (on friday), the app (on whatsapp), or the subject', for: 'a length (for 30 min), the kind (for a call), or the subject',
  about: 'the subject', re: 'the subject', regarding: 'the subject', saying: 'the words they will read', that: 'the words they will read',
  by: 'a time (by 5pm)', every: 'a repeat (every monday)', until: 'when the repeat ends',
};
// The word map as a table for the fold under the empty box (the mock's right column).
const WORD_MAP = [
  ['invite · schedule · meet', 'an invite in Outlook: who, when, where, about', 'invite lena'],
  ['text · message · tell', 'a text in Messages: who, then the words', 'text lena running late'],
  ['whatsapp', 'a text in WhatsApp', 'whatsapp the acme team'],
  ['email', 'a reply in their latest email', 'email jamie the deck is ready'],
  ['and · & · , · with', 'another person', 'lena and jamie'],
  ['to', 'a person, the kind of meeting, or the place', 'to lunch · to Elm Hall'],
  ['at · @', 'a time if a number follows, else the place', 'at 5 · at Maplewood'],
  ['in', 'a place', 'in Birch Hall'],
  ['on', 'a day, the app, else the subject', 'on friday · on whatsapp · on the budget'],
  ['for', 'a length, the kind, else the subject', 'for 30 min · for a call · for the hackathon'],
  ['about · re · regarding', 'the subject, up to the next part', 'about hackathon rules'],
  ['saying · that · :', 'the words they will read', 'text lena: on my way'],
  ['every · weekly · until', 'a repeat and its end', 'every monday until dec 4'],
  ['"quotes"', 'taken word for word as the subject', 'invite lena "Q3 plan"'],
];
const HISTORY_KEY = 'loggie.askHistory';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const badge = (app) => el('span', `ask-app ask-app-${app}`, APP[app] || app);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'no recent message');
// A "which one?" choice: the name and the address (ask-run.js choiceLabel), so two Rowena Patels are told apart.
export const choiceText = (candidate) => candidate.label || (candidate.address ? `${candidate.name} <${candidate.address}>` : candidate.name);
const APP_PHRASE = /\s*\b(?:on|in|via|over|through|using)\s+(?:whats\s?app|wa|i\s?message|imessage|messages|sms|google(?: calendar)?|outlook)\b/gi;

export function readHistory(storage) { try { const list = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]'); return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []; } catch { return []; } }
export function pushHistory(storage, text) {
  const list = readHistory(storage).filter((x) => x !== text);
  list.push(text);
  try { storage?.setItem(HISTORY_KEY, JSON.stringify(list.slice(-50))); } catch {}
  return list.slice(-50);
}

// The sentence with one word changed by a fix-it button: the word made the subject ("about X" in quotes), the place
// ("at X"), dropped, or a person's name swapped for one of their other addresses.
export function rewrite(text, { word, start, end }, how, value = '') {
  const before = text.slice(0, start), after = text.slice(end);
  const bare = word.replace(/[.,;:!?]+$/, '');
  const tail = word.slice(bare.length);
  if (how === 'about') return `${before}"${bare}"${tail}${after}`;
  if (how === 'where') return `${before}at ${bare}${tail}${after}`;
  if (how === 'swap') return `${before}${value}${tail}${after}`;
  return `${before}${after}`.replace(/\s{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
}
// The same sentence in another app: the app phrase replaced ("on whatsapp", "on google"), or removed for the default.
export function withApp(text, action, app) {
  const bare = text.replace(APP_PHRASE, '').replace(/\s{2,}/g, ' ').trim();
  if (action === 'invite') return app === 'google' ? `${bare} on google` : bare;
  return app === 'whatsapp' ? `${bare} on whatsapp` : `${bare} on imessage`;
}
// What a word underline says under it: the role, once per run of the same role.
export function underlineLabels(marks) {
  let last = null;
  return marks.map((w) => {
    const role = w.role === 'kind' ? 'about' : w.role;
    if (['filler', 'mark', 'action'].includes(role)) { if (role !== 'mark') last = role === 'action' ? 'action' : last; return ''; }
    const label = role === last && role !== 'who' ? '' : ROLE_LABEL[role] || '';
    last = role;
    return label;
  });
}

export function attachAskBox({ form, input, sendButton, under, card, status, ask, runOther, mirror = null, storage = globalThis.localStorage, uiAct = () => {}, unwrap = (r) => r }) {
  const box = { timer: 0, preview: null, choices: {}, cloud: null, askId: null, text: '', history: readHistory(storage), at: -1, draft: '', fixed: 0, recalled: false, thread: null, threadOpen: false };

  function showExamples() {
    const chips = EXAMPLES.map(([label, start]) => {
      const chip = el('button', 'ask-chip', label);
      chip.type = 'button';
      chip.addEventListener('click', () => { input.value = start; input.focus(); input.setSelectionRange(start.length, start.length); input.dispatchEvent(new Event('input')); });
      return chip;
    });
    const keys = el('span', 'ask-keys', box.history.length ? '↑ your last ask · Esc clears' : 'Start with invite, text, WhatsApp or email');
    under.replaceChildren(...chips, keys, wordMap());
    under.dataset.state = 'examples';
    paintMirror(null);
  }

  // The word map itself, folded under the empty box: each small word and what it expects next, with an example.
  function wordMap() {
    const fold = el('details', 'ask-map');
    fold.open = box.mapOpen === true;
    fold.addEventListener('toggle', () => { box.mapOpen = fold.open; });
    fold.append(el('summary', '', 'Word map: what each small word means'));
    const table = el('table');
    for (const [words, means, example] of WORD_MAP) {
      const row = el('tr');
      row.append(el('th', '', words), el('td', '', means), el('td', 'ask-muted', example));
      table.append(row);
    }
    fold.append(table);
    return fold;
  }

  // The underline layer: the same words as the box, transparent, each word underlined in its role's color.
  function paintMirror(preview) {
    if (!mirror) return;
    const text = input.value;
    const marks = preview?.marks || [];
    // while the next reading is on its way, the last one still holds for the words it covered
    if (!marks.length || !text.startsWith(preview.text)) { mirror.replaceChildren(document.createTextNode(text)); syncMirror(); return; }
    const labels = underlineLabels(marks);
    const nodes = [];
    let at = 0;
    marks.forEach((w, i) => {
      if (w.start > at) nodes.push(document.createTextNode(text.slice(at, w.start)));
      const role = w.role === 'kind' ? 'about' : w.role === 'room' ? 'where' : w.role === 'notes' ? 'about' : w.role;
      if (['filler', 'mark'].includes(role)) nodes.push(document.createTextNode(text.slice(w.start, w.end)));
      else {
        const span = el('span', `ask-u ask-u-${role}`, text.slice(w.start, w.end));
        if (labels[i]) span.dataset.label = labels[i];
        nodes.push(span);
      }
      at = w.end;
    });
    if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
    mirror.replaceChildren(...nodes);
    syncMirror();
  }
  function syncMirror() { if (mirror) mirror.style.transform = `translateY(${-input.scrollTop}px)`; }
  function grow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
    if (mirror) mirror.parentElement.style.minHeight = input.style.height;
    syncMirror();
  }

  function chooser(item, onPick) {
    const row = el('div', 'ask-choices');
    for (const candidate of item.candidates) {
      const button = el('button', 'ask-choice');
      button.type = 'button';
      button.append(badge(candidate.app), el('span', '', item.twins ? `${choiceText(candidate)}, last message ${day(candidate.last)}` : choiceText(candidate)));
      button.addEventListener('click', () => onPick(candidate));
      row.append(button);
    }
    return row;
  }

  // The email thread an ask answers (loggie-ask-thread): Loggie's pick, or the user's, one press from the others and
  // from a new email. The pick is kept for this person only; another name drops it.
  const reSubject = (subject) => String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '');
  function threadNow(preview) {
    const key = preview.who?.[0]?.key || '';
    if (box.thread && box.thread.key !== key) { box.thread = null; box.threadOpen = false; }
    if (box.thread?.id === 'new') return null;
    const all = [preview.thread, ...(preview.thread.others || [])].filter((t) => t?.id);
    return (box.thread && all.find((t) => t.id === box.thread.id)) || (preview.thread.id ? preview.thread : null);
  }
  function threadSlot(preview) {
    const current = threadNow(preview);
    const button = el('button', 'ask-in');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(box.threadOpen));
    button.setAttribute('aria-label', `${current ? `Answers ${current.subject}` : 'A new email'}. Choose another thread`);
    button.title = box.thread ? 'You picked this' : preview.thread.why;
    button.append(el('span', '', current ? `Re: ${current.subject} · ${day(current.at)}` : 'New email'), el('span', 'ask-act-caret', '▾'));
    button.addEventListener('click', () => { box.threadOpen = !box.threadOpen; showPreview(box.preview); });
    return slot('about', 'In', button, 'quiet');
  }
  function threadChoices(preview) {
    const key = preview.who?.[0]?.key || '';
    const current = threadNow(preview);
    const row = el('div', 'ask-choices ask-threads');
    const pick = (id) => { box.thread = { key, id }; box.threadOpen = false; box.fixed += 1; showPreview(box.preview); input.focus(); };
    for (const t of [preview.thread, ...(preview.thread.others || [])].filter((x) => x?.id)) {
      const button = el('button', 'ask-choice', `${t.subject} · ${day(t.at)}${t.ccOnly ? ' · you were on Cc' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(current?.id === t.id));
      button.addEventListener('click', () => pick(t.id));
      row.append(button);
    }
    const fresh = el('button', 'ask-choice', 'New email');
    fresh.type = 'button';
    fresh.setAttribute('aria-pressed', String(!current));
    fresh.addEventListener('click', () => pick('new'));
    row.append(fresh);
    return row;
  }

  // The action chip: what will happen and in which app. A press moves it to the other app by changing the sentence
  // itself ("on whatsapp", "on google"), so what the box shows is what runs.
  function actionChip(preview) {
    const app = preview.action === 'invite' ? preview.app : preview.action === 'reply' ? 'outlook' : (preview.who?.find((w) => w.app)?.app || preview.app || 'messages');
    const other = preview.action === 'invite' ? (app === 'google' ? 'outlook' : 'google') : preview.action === 'message' ? (app === 'whatsapp' ? 'messages' : 'whatsapp') : null;
    const chip = el(other ? 'button' : 'span', 'ask-act');
    if (other) {
      chip.type = 'button';
      chip.title = `Use ${APP[other]} instead`;
      chip.setAttribute('aria-label', `${ACTION_LABEL[preview.action]} in ${APP[app]}. Switch to ${APP[other]}`);
      chip.addEventListener('click', () => { setText(withApp(input.value, preview.action, other)); box.fixed += 1; });
    }
    chip.append(el('span', 'ask-act-verb', ACTION_LABEL[preview.action] || preview.action), el('span', 'ask-act-app', APP[app] || app));
    if (other) chip.append(el('span', 'ask-act-caret', '▾'));
    return chip;
  }
  // One slot: its label and its value; empty slots are dashed, defaults (first free time, "Meeting with ...") quiet.
  function slot(role, label, value, mode = value ? 'on' : 'empty') {
    const node = el('span', `ask-slot ask-slot-${role} ask-slot-${mode}`);
    node.append(el('b', '', label));
    const v = el('span', 'ask-slot-v');
    if (value instanceof Node) v.append(value); else v.textContent = value || '┄┄┄┄';
    node.append(v);
    return node;
  }
  function setText(text) { input.value = text; input.focus(); input.setSelectionRange(text.length, text.length); input.dispatchEvent(new Event('input')); }

  // The last small word typed: what it expects next, and which slot is listening.
  function hintFor(preview) {
    const text = input.value;
    const marks = preview.marks || [];
    const last = marks[marks.length - 1];
    if (!last) return null;
    const word = text.slice(last.start, last.end).toLowerCase().replace(/[.!?]+$/, '');
    const typedSpace = /\s$/.test(text);
    if (last.role === 'action' && typedSpace) return { line: preview.action === 'invite' ? 'Now who. Then when, where and what it is about, in any order.' : 'Now who, then what to say.', listen: ['who'] };
    if (!typedSpace && word !== ',' && word !== ':') return null;
    const hint = HINTS[word] || (word === ':' ? 'the words they will read' : null);
    if (!hint) return null;
    const listen = { at: ['when', 'where'], '@': ['when', 'where'], in: ['where'], on: ['when', 'about'], for: ['when', 'about'], about: ['about'], re: ['about'], regarding: ['about'], saying: ['message'], that: ['message'], ':': ['message'], by: ['when'], every: ['when'], until: ['when'] }[word] || ['who'];
    return { line: `${word} → ${hint}`, listen };
  }

  function showPreview(preview) {
    box.preview = preview;
    under.dataset.state = preview.status;
    paintMirror(preview);
    if (!input.value.trim()) { showExamples(); return; }
    const parts = [];
    const hint = hintFor(preview);
    // a slot listens when the last word points at it and the sentence has not filled it yet (a default still listens)
    const mode = (role, value, quiet = false) => (hint?.listen.includes(role) && (!value || quiet) ? 'listen' : value ? (quiet ? 'quiet' : 'on') : 'empty');
    if (preview.action === 'invite') {
      const inv = preview.invite || {};
      const row = el('div', 'ask-slots');
      const who = el('span', '');
      inv.who?.forEach((person, i) => {
        if (i) who.append(document.createTextNode(' · '));
        who.append(document.createTextNode(person.name));
      });
      row.append(actionChip(preview), slot('who', 'Who', inv.who?.length ? who : '', mode('who', inv.who?.length)));
      row.append(slot('when', 'When', inv.when, mode('when', inv.when, !inv.timeGiven)));
      row.append(slot('where', inv.room ? 'Room' : 'Where', inv.where, mode('where', inv.where)));
      row.append(slot('about', 'About', inv.title, mode('about', inv.title, !inv.titleSaid)));
      parts.push(row);
      if (hint) parts.push(el('div', 'ask-hint', hint.line));
      if (preview.status === 'question') parts.push(el('div', 'ask-flag', preview.line));
      // a person with two addresses: the one used most is picked, the others one press away
      for (const person of inv.who || []) {
        if (!person.alternates?.length) continue;
        const flag = el('div', 'ask-flag');
        flag.append(el('span', '', `${person.name} has ${person.alternates.length + 1} addresses. Using the one you use most:`));
        for (const address of [person.address, ...person.alternates]) {
          const button = el('button', 'ask-fix', address);
          button.type = 'button';
          button.setAttribute('aria-pressed', String(address === person.address));
          button.addEventListener('click', () => {
            if (address === person.address) return;
            const who = (preview.marks || []).filter((w) => w.role === 'who');
            const group = who.filter((w) => w.group === (inv.who || []).indexOf(person));
            if (!group.length) return;
            setText(rewrite(input.value, { word: input.value.slice(group[0].start, group[group.length - 1].end), start: group[0].start, end: group[group.length - 1].end }, 'swap', address));
            box.fixed += 1;
          });
          flag.append(button);
        }
        parts.push(flag);
      }
      // a word nobody asked for: make it the subject, the place, or drop it
      for (const w of (preview.marks || []).filter((m) => m.role === 'unused')) {
        const word = input.value.slice(w.start, w.end);
        const flag = el('div', 'ask-flag');
        flag.append(el('span', '', `"${word.replace(/[.,;:!?]+$/, '')}" isn't a person, time or place Loggie knows.`));
        for (const [how, label] of [['about', 'Make it the subject'], ['where', 'Make it the place'], ['drop', 'Drop it']]) {
          const button = el('button', 'ask-fix', label);
          button.type = 'button';
          button.addEventListener('click', () => { setText(rewrite(input.value, { word, start: w.start, end: w.end }, how)); box.fixed += 1; });
          flag.append(button);
        }
        parts.push(flag);
      }
      under.replaceChildren(...parts);
      sendButton.disabled = !canSend();
      return;
    }
    if (preview.status === 'other' || preview.action === 'open') { under.replaceChildren(el('span', 'ask-line ask-muted', preview.action === 'open' ? 'Find or open a file on this Mac' : '')); sendButton.disabled = false; return; }
    if (preview.status === 'unknown') { under.replaceChildren(el('span', 'ask-line ask-muted', 'Code can\'t read this one. Press Enter and Loggie will ask before the cloud AI reads it.')); sendButton.disabled = false; return; }
    if (preview.action === 'move' || preview.action === 'said') {
      const line = el('div', 'ask-line');
      line.append(badge(preview.action === 'move' ? 'outlook' : (preview.who?.[0]?.app || 'messages')), el('span', '', preview.line.replace(/ · Outlook$/, '')));
      under.replaceChildren(line);
      sendButton.disabled = !canSend();
      return;
    }
    // a text or an email reply: who, and what it says
    const row = el('div', 'ask-slots');
    row.append(actionChip(preview));
    const names = (preview.who || []).filter((w) => w.status === 'one').map((w) => w.name).join(' · ');
    row.append(slot('who', 'Who', names, mode('who', names)));
    if (preview.action === 'reply' && preview.thread) row.append(threadSlot(preview));
    else if (preview.action === 'reply' && preview.who?.[0]?.subject) row.append(slot('about', 'In', `Re: ${reSubject(preview.who[0].subject)}`, 'quiet'));
    if (preview.who?.length > 1 && preview.action === 'message') row.append(slot('about', 'As', preview.separate ? 'a draft for each' : 'one group message', 'quiet'));
    row.append(slot('message', 'Says', preview.words ? `"${preview.words}"` : '', mode('message', preview.words)));
    parts.push(row);
    if (preview.action === 'reply' && preview.thread && box.threadOpen) parts.push(threadChoices(preview));
    // Not their newest email: say why, once, quietly.
    else if (preview.action === 'reply' && preview.thread && !box.thread && ['not-cc', 'words'].includes(preview.thread.how)) {
      parts.push(el('div', 'ask-why', preview.thread.how === 'words' ? `In this thread because your words are in it: ${preview.thread.matched.slice(0, 3).join(', ')}.` : 'Not their newest email: that one went to someone else and only copied you.'));
    }
    if (hint) parts.push(el('div', 'ask-hint', hint.line));
    if (preview.status === 'which') {
      const item = preview.who.find((who) => who.status === 'many');
      parts.push(el('div', 'ask-flag', item.twins ? `${item.candidates.length} ${item.candidates[0]?.app === 'outlook' ? 'people' : 'chats'} share this name. Which one?` : `Which ${item.text}?`));
      parts.push(chooser(item, (candidate) => { box.choices[item.text] = candidate.key; submit(); }));
    } else if (preview.status === 'none') parts.push(el('div', 'ask-flag', preview.line));
    under.replaceChildren(...parts);
    sendButton.disabled = !canSend();
  }

  // Enter runs only what can run: an invite with someone in it, a text with someone and words.
  function canSend() {
    const p = box.preview;
    if (!input.value.trim()) return false;
    if (!p || p.text !== input.value) return true;
    if (p.action === 'invite') return p.status === 'ready';
    if (['message', 'reply'].includes(p.action)) return ['ready', 'which'].includes(p.status);
    return p.status !== 'needs-words' && p.status !== 'none';
  }

  async function refresh() {
    const value = input.value;
    const text = value.trim();
    box.choices = {};
    box.cloud = null;
    if (!text) { box.preview = null; showExamples(); sendButton.disabled = false; return; }
    try { const preview = unwrap(await ask.preview(value)); if (input.value === value) showPreview({ ...preview, text: value }); }
    catch { under.replaceChildren(el('span', 'ask-line ask-muted', '')); paintMirror(null); }
  }

  function working(on) {
    form.classList.toggle('ask-working', on);
    input.disabled = on;
    sendButton.disabled = on;
    status.hidden = !on;
  }

  function step({ askId, step: n, of, label }) {
    if (askId !== box.askId) return;
    status.querySelector('.ask-status-label').textContent = `${label}…`;
    status.querySelector('.ask-status-count').textContent = `step ${n} of ${of}`;
    const bar = status.querySelector('.ask-steps');
    bar.replaceChildren(...Array.from({ length: of }, (_, i) => el('span', i < n ? 'on' : '')));
  }

  // The email draft, as soon as it is written (loggie-ask-thread): the user reads it while Outlook places it.
  function emailWhere(thread, subject) {
    return thread?.id ? `In Re: ${thread.subject} · ${day(thread.at)}` : `New email${subject ? `: ${subject}` : ''}`;
  }
  function showDraft(draft) {
    if (draft.askId !== box.askId) return;
    card.hidden = false;
    card.dataset.outcome = 'drafting';
    const list = el('dl', 'ask-to');
    const dt = el('dt'); dt.append(badge(draft.app));
    list.append(dt, el('dd', '', draft.to));
    const parts = [el('h3', 'ask-card-head', `Placing it in ${APP[draft.app] || 'Outlook'}…`), list, el('p', 'ask-muted', emailWhere(draft.thread, draft.subject)), el('p', 'ask-draft', draft.body)];
    if (draft.how === 'words-after-ai-dropped-line') parts.push(el('p', 'ask-muted', 'The cloud AI left out your point, so your words go as typed.'));
    card.replaceChildren(...parts);
  }

  function done(result) {
    if (result.askId !== box.askId) return;
    box.askId = null;
    working(false);
    card.hidden = false;
    const placed = result.outcome === 'placed' || result.outcome === 'partly';
    card.dataset.outcome = result.outcome;
    const asked = result.action === 'question';
    const head = el('h3', 'ask-card-head', asked && result.outcome === 'answered' ? 'From your email and calendar'
      : asked && result.status === 'needs-yes' ? 'Answer from your email and calendar?'
      : result.outcome === 'answered' ? (result.lines?.[0] || 'Their latest')
      : result.outcome === 'placed' ? `✓ Ready. You send it there.`
      : result.outcome === 'partly' ? 'Some are ready. You send them there.'
      : result.outcome === 'clipboard' && result.action === 'reply' ? `Written, but not opened in ${APP[(result.results || [])[0]?.app] || 'Outlook'}.`
      : result.outcome === 'clipboard' ? 'On your clipboard. Paste it in the chat and send.'
      : result.outcome === 'stopped' ? 'Stopped.'
      : result.status === 'did-you-mean' ? 'Did you mean'
      : result.status === 'needs-yes' && result.yesFor === 'sentence' ? 'Ask the cloud AI to read it?'
      : result.status === 'needs-yes' ? `Write the reply to ${result.to} with the cloud AI?`
      : result.status === 'needs-time' ? 'One time first'
      : result.outcome === 'question' ? 'One question first' : 'That didn\'t work');
    const parts = [head];
    if (asked && result.outcome === 'answered') {
      // A question answered from email and calendar (assistant-service.js): the answer, then the emails and events it
      // used, so each claim can be checked where it came from.
      parts.push(el('p', 'ask-answer', result.lines?.[0] || ''));
      if (result.sources?.length) {
        const list = el('ul', 'ask-sources');
        for (const source of result.sources) {
          const when = source.kind === 'email' ? source.date : source.start;
          list.append(el('li', '', `${source.id} · ${source.title || (source.kind === 'email' ? 'An email' : 'An event')}${when ? ` · ${clock(when)}` : ''}`));
        }
        parts.push(list);
      }
    } else if (result.outcome === 'answered') {
      // What they said: each place they write, newest place first, the last few messages as written.
      for (const r of result.results) {
        const block = el('div', 'ask-said');
        const top = el('div', 'ask-said-head'); top.append(badge(r.app), el('strong', '', r.to));
        block.append(top);
        for (const m of r.messages) {
          const row = el('p', m.fromMe ? 'ask-said-line ask-mine' : 'ask-said-line');
          row.append(el('span', 'ask-muted', `${clock(m.at)} · ${m.from}: `), document.createTextNode(m.text));
          block.append(row);
        }
        parts.push(block);
      }
    } else if (result.results?.length) {
      const list = el('dl', 'ask-to');
      for (const r of result.results) {
        const dt = el('dt'); dt.append(badge(r.app));
        list.append(dt, el('dd', r.outcome === 'placed' ? '' : 'ask-muted', r.outcome === 'placed' ? (r.kind === 'meeting' ? `${r.to}: moved in its window. Press Send there.` : `${r.to}: "${String(result.words || '').replace(/\s+/g, ' ').trim().slice(0, 140)}"`) : `${r.to}: ${r.detail}`));
      }
      parts.push(list);
      const mailed = result.results.find((r) => r.app === 'outlook' && r.thread);
      if (mailed) parts.push(el('p', 'ask-muted', emailWhere(mailed.thread, '')));
      // What to look at before Send (ask-run.js checkOf, the helper's read-back; a draft that fell back to the words).
      for (const r of result.results) {
        if (/^words-after-ai/.test(r.drafted || '') && r.outcome === 'placed') parts.push(el('p', 'ask-check', 'The cloud AI left out your point, so your words went in as typed. Read it before you send.'));
        if (r.check) parts.push(el('p', 'ask-check', `Check before sending: ${r.check}`));
      }
    } else {
      for (const line of result.lines || []) parts.push(el('p', 'ask-muted', line));
    }
    // The box's cloud yes (an email reply): always, this one, or the note as typed with nothing sent to the cloud.
    if (result.status === 'needs-yes') {
      const row = el('div', 'ask-choices');
      const answers = result.yesFor === 'sentence'
        ? [['Yes, this time', 'once', true], ['Always for sentences', 'always'], ['Cancel', null]]
        : result.yesFor === 'question'
        ? [['Yes, this time', 'once', true], ['Always for questions', 'always'], ['Cancel', null]]
        // The same three answers, in the same order, as a Reply's own row (reply-row.js): one vocabulary for one yes.
        : [['Always write my replies', 'always', true], ['Just this one', 'once'], ['Send my note as typed', 'words']];
      for (const [label, cloud, primary] of answers) {
        const button = el('button', primary ? 'ask-choice ask-primary' : 'ask-choice', label);
        button.type = 'button';
        button.addEventListener('click', () => { if (!cloud) { card.hidden = true; input.focus(); return; } box.cloud = cloud; submit(box.text); });
        row.append(button);
      }
      parts.push(row);
    }
    // A draft held for a time (ask-run.js fill, loggie-reply-yes): nothing with a gap reaches the mail app; the time
    // typed here goes in by code and the draft opens, unsent.
    if (result.status === 'needs-time') {
      const row = el('div', 'ask-choices');
      const time = el('input', 'ask-time');
      time.placeholder = 'e.g. 3 PM EST';
      time.maxLength = 120;
      time.setAttribute('aria-label', 'The time the draft should say');
      const put = el('button', 'ask-choice ask-primary', 'Put it in');
      put.type = 'button';
      const go = async () => {
        if (!time.value.trim()) { time.focus(); return; }
        put.disabled = true;
        let filled;
        try { filled = unwrap(await ask.fill(result.askId, time.value.trim())); } catch (error) { filled = { askId: result.askId, outcome: 'failed', lines: [error.message] }; }
        box.askId = filled.askId;
        done(filled);
      };
      put.addEventListener('click', go);
      time.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); go(); } });
      row.append(time, put);
      parts.push(row);
      setTimeout(() => time.focus(), 0);
    }
    // An email written but not opened (Outlook on the Calendar): Try again opens the same draft (ask-run.js again).
    if (result.outcome === 'clipboard' && result.action === 'reply' && result.askId) {
      const row = el('div', 'ask-choices');
      const retry = el('button', 'ask-choice ask-primary', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        let opened;
        try { opened = unwrap(await ask.again(result.askId)); } catch (error) { opened = { askId: result.askId, outcome: 'failed', lines: [error.message] }; }
        box.askId = opened.askId;
        done(opened);
      });
      row.append(retry);
      parts.push(row);
    }
    // The cloud AI's reading, as a sentence code can run: Yes runs it as a new ask; No puts the user back in the box.
    if (result.status === 'did-you-mean') {
      const row = el('div', 'ask-choices');
      const yes = el('button', 'ask-choice ask-primary', 'Yes, do that');
      yes.type = 'button';
      yes.addEventListener('click', () => { box.choices = {}; box.cloud = null; input.value = result.rewrite; submit(); });
      const no = el('button', 'ask-choice', 'No');
      no.type = 'button';
      no.addEventListener('click', () => { card.hidden = true; input.focus(); });
      row.append(yes, no);
      parts.push(row);
    }
    const which = (result.who || []).find((who) => who.status === 'many');
    if (result.outcome === 'question' && which) parts.push(chooser(which, (candidate) => { box.choices[which.text] = candidate.key; submit(box.text); }));
    if (result.did?.length) {
      const details = el('details', 'ask-did');
      const summary = el('summary', '', 'What I did');
      const list = el('ol');
      for (const line of result.did) list.append(el('li', '', line));
      details.append(summary, list);
      parts.push(details);
    }
    // Undo: clears a chat draft Loggie typed (only if it is still exactly Loggie's words), discards a meeting move.
    if (result.undoable) {
      const undoButton = el('button', 'ask-close', 'Undo');
      undoButton.type = 'button';
      undoButton.addEventListener('click', async () => {
        undoButton.disabled = true;
        undoButton.textContent = 'Undoing…';
        let lines;
        try { lines = unwrap(await ask.undo(result.askId)).lines; } catch (error) { lines = [error.message]; }
        undoButton.replaceWith(...lines.map((line) => el('p', 'ask-muted', line)));
      });
      parts.push(undoButton);
    } else if ((result.results || []).some((r) => r.undo?.kind === 'reply')) {
      const app = (result.results || []).find((r) => r.undo?.kind === 'reply').undo.app || 'Outlook';
      parts.push(el('p', 'ask-muted', `To take it back, ${app === 'Mail' ? 'delete' : 'press Discard in'} the ${app} reply.`));
    }
    const close = el('button', 'ask-close', 'Done');
    close.type = 'button';
    close.addEventListener('click', () => { card.hidden = true; input.focus(); });
    parts.push(close);
    card.replaceChildren(...parts);
    if (placed) { input.value = ''; box.cloud = null; box.thread = null; box.threadOpen = false; grow(); showExamples(); }
  }

  // One ui-acts row per send: what the box read, never the words: the action, how many words were left unused, how
  // many fix-it presses it took, and whether the sentence came back with the up arrow.
  function logRead(text) {
    const p = box.preview && box.preview.text?.trim() === text ? box.preview : null;
    try { uiAct({ act: 'box-read', action: p?.action || 'unknown', unused: (p?.marks || []).filter((w) => w.role === 'unused').length, fixed: box.fixed, recalled: box.recalled }); } catch {}
    box.fixed = 0; box.recalled = false;
  }

  async function submit(again = null) {
    const text = again || input.value.trim();
    if (!text || box.askId) return;
    if (!again && !canSend()) return;
    const preview = again ? box.preview : (box.preview && box.preview.text?.trim() === text ? box.preview : { ...unwrap(await ask.preview(text)), text });
    box.text = text;
    if (!again) { box.history = pushHistory(storage, text); box.at = -1; logRead(text); }
    if (preview && (preview.action === 'invite' || preview.action === 'open' || preview.status === 'other') && !again) { input.value = ''; grow(); showExamples(); return runOther(text); }
    card.hidden = true;
    working(true);
    status.querySelector('.ask-status-label').textContent = 'Starting…';
    status.querySelector('.ask-status-count').textContent = '';
    const choices = { ...box.choices };
    if (box.thread && preview?.who?.[0]?.key === box.thread.key) choices['@thread'] = box.thread.id;
    try { box.askId = unwrap(await ask.run(text, choices, box.cloud)).askId; }
    catch (error) { working(false); done({ askId: null, outcome: 'failed', lines: [error.message] }); }
  }

  // Up brings back the last ask, again for the one before; Down goes forward, then back to what was being typed.
  // Up only recalls from an empty box or one showing a recalled ask, so it never takes over a line being written.
  function recall(event) {
    if (event.key === 'Escape') {
      if (!input.value) return;
      event.preventDefault();
      input.value = ''; box.at = -1; card.hidden = true; grow(); refresh();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const browsing = box.at >= 0 && input.value === box.history[box.at];
    if (event.key === 'ArrowUp') {
      if (!box.history.length || (!browsing && input.value !== '')) return;
      if (input.value.slice(0, input.selectionStart).includes('\n')) return;
      event.preventDefault();
      if (!browsing) { box.draft = input.value; box.at = box.history.length; }
      box.at = Math.max(0, box.at - 1);
    } else {
      if (!browsing) return;
      event.preventDefault();
      box.at += 1;
      if (box.at >= box.history.length) { box.at = -1; input.value = box.draft; grow(); refresh(); return; }
    }
    input.value = box.history[box.at];
    box.recalled = true;
    input.setSelectionRange(input.value.length, input.value.length);
    grow();
    refresh();
  }

  status.querySelector('.ask-stop').addEventListener('click', () => { if (box.askId) ask.stop(box.askId); status.querySelector('.ask-status-label').textContent = 'Stopping after this step…'; });
  input.addEventListener('input', () => {
    if (box.at >= 0 && input.value !== box.history[box.at]) box.at = -1;
    grow();
    paintMirror(box.preview);
    clearTimeout(box.timer);
    box.timer = setTimeout(refresh, 120);
  });
  input.addEventListener('scroll', syncMirror);
  input.addEventListener('keydown', recall);
  // A run the box did not start (origin 'row': a Reply on a To do move, reply-row.js) has its own row for the yes, the
  // steps and the outcome; the box never draws a card for it (loggie-reply-yes).
  const mine = (data) => data?.origin !== 'row';
  ask.onStep((data) => { if (mine(data)) step(data); });
  ask.onDraft?.((data) => { if (mine(data)) showDraft(data); });
  ask.onDone((result) => { if (!mine(result)) return; if (!box.askId) box.askId = result.askId; done(result); });
  showExamples();
  return { submit, refresh, canSend };
}
