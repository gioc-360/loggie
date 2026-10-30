import { askParts } from './needs-model.js';
import { applyEvent, decisionCards, inviteResultLine, nextMeetingCard, runAction } from './meeting-cards.js';
import { HEALTH_LINE } from './setup-cards.js';
import { icon } from './icons.js';
import { attachVoiceInput } from './voice-input.js';
import { createWorkspacesView } from './workspaces.js';
import { createTodayView } from './today.js';
import { createReplies } from './reply-row.js';
import { createMacCheck } from './mac-check.js';
import { attachAskBox } from './ask-box.js';
import { createSetupView } from './setup.js';
import { createMeetingsView } from './meetings.js';
import { todayRowText } from './found-model.js';
import { attachTooltip } from './tooltip.js';
import { attachContextMenu } from './context-menu.js';

// One tooltip for the panel, at once on hover and keyboard focus (tooltip.js): before any view draws a button.
attachTooltip(document.body);

const elements = Object.fromEntries([
  'askResults', 'clearCommands', 'commandHistory', 'composer', 'composerHint',
  'message', 'notice', 'searchButton',
  'workstreamStatus', 'usageLine', 'batchActions', 'liveCards', 'workstreamView', 'todayView', 'todayHeading',
  'cloudKey', 'keyForm', 'keyStatus', 'saveKey', 'testKey',
].map((id) => [id, document.querySelector(`#${id}`)]));

const state = { workstream: null, busy: false };

// What waits for the user, drawn on Today (today.js): First today's picks, the questions Loggie stopped on, the
// people and calls with a suggested home, the calls to summarize and the next meeting.
const queue = { picks: [], source: null, asks: [], homes: [], surface: [] };
// Later on the Found step (first-run-polish B4.7) leaves its found cards waiting: Today then shows one row for them.
let foundLater = false;
function queueItems() {
  // A pick opens its workspace's card (loggie-workspaces-integration F7: the doors between Today and Workspaces).
  const picks = queue.picks.map((pick) => ({ key: `pick:${pick.taskId}`, mark: '★', text: `${pick.name}: ${pick.move}`,
    go: () => document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'workspaces', workspace: pick.name } })) }));
  const asks = queue.asks.map(({ workstream, item }) => ({ key: `ask:${item.id}`, mark: item.phase === 'failed' || /failed/i.test(item.question || '') ? '!' : '?', text: `${workstream.name}: ${item.title}`, render: () => [needsCard(workstream, item)] }));
  // Someone the router could not place, with the workstream the cloud AI suggested (suggest.js): one tap files them.
  // A call no workstream holds, with Loggie's guess (yellow: not sure): the line opens that call's picker on the Notes &
  // Meetings tab, guess first, so a call is filed in one place.
  const seenCalls = new Set();
  const homes = queue.homes.filter(({ ask }) => !String(ask.id).startsWith('call:') || (!seenCalls.has(ask.id) && seenCalls.add(ask.id)))
    .map(({ workstream, ask }) => (String(ask.id).startsWith('call:')
      ? { key: `home:${ask.id}`, mark: '●', guess: true, text: `${ask.title || 'A call'} → ${workstream.name}`,
        go: () => document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: { view: 'meetings', call: String(ask.id).replace(/^call:/, '').replace(/@.*$/, ''), picker: true } })) }
      : { key: `home:${ask.id}`, mark: '?', text: `${whoOf(ask)} · ${workstream.name}?`, render: () => [homeCard(workstream, ask)] }));
  const surfaced = queue.surface.map((card) => ({
    key: card.kind === 'decide-bundle' ? 'calls' : card.key || card.kind,
    mark: card.kind === 'decide-bundle' || card.kind === 'decide' ? '☁' : card.kind === 'next-done' ? '✓' : '⌚',
    text: card.kind === 'decide-bundle' ? `${card.calls.length} calls to summarize` : card.kind === 'decide' ? `Summarize ${card.title || 'a call'}?` : card.kind === 'next-done' ? 'Next meeting set' : `Next meeting: ${card.title || ''}`,
    render: () => [surfaceCard(card)],
  }));
  // After the Found step's Later (first-run-polish B4.7): the found cards still waiting for an answer, one row that
  // opens the step again.
  const waiting = foundLater ? lastWorkstreams.filter((card) => card.newFound).length : 0;
  const found = waiting > 0 ? [{ key: 'found', mark: '?', text: todayRowText(waiting), go: () => openFound() }] : [];
  return [...picks, ...homes, ...asks, ...surfaced, ...found];
}
let todayView = null;
// Reply on a To do move (reply-row.js): one state per move, shared by Today and Workspaces, so a reply started on one
// tab shows the same row on the other. The yes is asked there, never in the ask box (loggie-reply-yes).
const replies = createReplies({
  api: {
    replyTo: async (taskId, line = null, cloud = null) => unwrap(await hikyaku().replyTo(taskId, line, cloud)),
    replyYes: async () => unwrap(await hikyaku().replyYes()),
    setReplyYes: async (what) => unwrap(await hikyaku().setReplyYes(what)),
    replyFill: async (taskId, askId, time) => unwrap(await hikyaku().replyFill(taskId, askId, time)),
    replyAgain: async (taskId, askId) => unwrap(await hikyaku().replyAgain(taskId, askId)),
  },
  onChange: () => { todayView?.draw(); workstreamsView?.draw(); },
});
function renderQueue() {
  todayView ||= createTodayView({
    root: elements.todayView,
    heading: elements.todayHeading,
    api: {
      doIt: async (taskId, line = null) => unwrap(await hikyaku().doIt(taskId, undefined, line)),
      markMove: async (taskId, why) => unwrap(await hikyaku().markMove(taskId, why)),
      moveDate: async (taskId, date) => unwrap(await hikyaku().moveDate(taskId, date)),
      notThis: async (taskId) => unwrap(await hikyaku().notThis(taskId)),
      openDraft: async (taskId, options) => unwrap(await hikyaku().openDraft(taskId, options)),
      uiAct: async (act) => (hikyaku().uiAct ? unwrap(await hikyaku().uiAct(act)) : null),
    },
    outcomes: moveOutcomes, questionCard: needsCard, replies,
    onChanged: () => reloadShared(),
  });
  const items = queueItems();
  if (cardsLoaded) todayView.draw({ picks: queue.picks, source: queue.source, cards: lastWorkstreams, rows: items });
  const tab = document.querySelector('#taskCount');
  const total = items.length + (elements.liveCards?.children.length || 0);
  if (tab) tab.textContent = total ? String(total) : '';
}

function unwrap(response) {
  if (!response?.ok) throw new Error(response?.error || 'Loggie could not complete that request.');
  return response.data;
}

function setNotice(message, kind = 'error') {
  elements.notice.hidden = !message;
  elements.notice.className = `notice ${kind}`;
  elements.notice.textContent = message || '';
}

function setBusy(busy, hint = null) {
  state.busy = busy;
  elements.message.disabled = busy;
  elements.searchButton.disabled = busy;
  elements.composerHint.textContent = hint || '';
}

function addCommandMessage(kind, message, { detail = null, candidates = null, application = null } = {}) {
  const article = document.createElement('article');
  article.className = `command-message ${kind}`;
  const copy = document.createElement('p');
  copy.textContent = message;
  article.append(copy);
  if (detail) {
    const metadata = document.createElement('code');
    metadata.textContent = detail;
    article.append(metadata);
  }
  if (candidates?.length) {
    const choices = document.createElement('div');
    choices.className = 'command-choices';
    for (const candidate of candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = candidate.path;
      button.addEventListener('click', () => openChoice(application, candidate));
      choices.append(button);
    }
    article.append(choices);
  }
  elements.commandHistory.append(article);
  // What a request led to shows under the ask bar, on whatever page is open (the Activity tab is gone).
  elements.askResults.hidden = false;
  article.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function openChoice(application, candidate) {
  setBusy(true, 'Opening your selection…');
  try {
    const result = unwrap(await window.loggie.command.openResolved({ application, path: candidate.path }));
    addCommandMessage('assistant success', result.message, { detail: candidate.path });
  } catch (error) { addCommandMessage('assistant error', error.message); }
  finally { setBusy(false); }
}

async function runCommand(text) {
  addCommandMessage('user', text);
  setBusy(true, /\b(?:invite|meeting|schedule)\b/i.test(text) ? 'Filling the invite in Outlook…' : 'Understanding your request…');
  try {
    const result = unwrap(await window.loggie.command.execute(text));
    // An invite: the readout, line by line, read back from Outlook. Loggie never sends it.
    if (result.status === 'invited' || result.status === 'invite_stopped') addCommandMessage(result.status === 'invited' ? 'assistant success' : 'assistant error', result.lines.join('\n'));
    else if (result.status === 'invite_question') addCommandMessage('assistant error', result.message);
    else if (result.status === 'completed') addCommandMessage('assistant success', result.message, { detail: result.target.path });
    else if (result.status === 'needs_choice') addCommandMessage('assistant', result.message, { candidates: result.candidates, application: result.intent.application });
    else if (['not_found', 'access_needed'].includes(result.status)) addCommandMessage('assistant error', result.message);
    else if (result.type === 'invalid') addCommandMessage('assistant error', result.message);
    else addCommandMessage('assistant', 'Loggie can text, message on WhatsApp, invite, or open a file. Try "text Lena running late".');
  } catch (error) { addCommandMessage('assistant error', error.message); }
  finally { setBusy(false); }
}

function taskButton(label, onClick, { primary = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await onClick(); }
    catch (error) { elements.workstreamStatus.textContent = error.message; }
    finally { button.disabled = false; }
  });
  return button;
}

function textLine(text, className = '') {
  const line = document.createElement('p');
  if (className) line.className = className;
  line.textContent = text;
  return line;
}

// The yes for this workstream's mail (cloud = nebius).
function cloudToggle(workstream) {
  const label = document.createElement('label');
  label.className = 'workstream-cloud';
  const box = document.createElement('input');
  box.type = 'checkhouse';
  box.checked = workstream.cloud === 'nebius';
  box.addEventListener('change', async () => {
    box.disabled = true;
    try { unwrap(await window.loggie.hikyaku.setCloud(workstream.name, box.checked ? 'nebius' : 'off')); await loadWorkstreams({ autoCatchUp: false }); }
    catch (error) { box.checked = !box.checked; elements.workstreamStatus.textContent = error.message; }
    finally { box.disabled = false; }
  });
  label.append(box, 'Use the cloud AI for this workspace');
  label.append(textLine(HEALTH_LINE, 'task-quote'));
  return label;
}

// The goal in the user's terms (priorities.js): a draft waits for Keep or a rewrite; a confirmed one shows with Change.
function goalBlock(workstream) {
  const box = document.createElement('div');
  box.className = 'goal-block';
  const save = async (text) => { unwrap(await window.loggie.hikyaku.confirmGoal(workstream.name, text)); await loadWorkstreams(); };
  const edit = () => {
    const form = document.createElement('form');
    form.className = 'compact-form goal-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 300;
    input.value = workstream.goalText || '';
    input.setAttribute('aria-label', `Goal for ${workstream.name}`);
    form.append(input, taskButton('Save', () => save(input.value), { primary: true }));
    form.addEventListener('submit', (event) => { event.preventDefault(); save(input.value).catch((error) => { elements.workstreamStatus.textContent = error.message; }); });
    box.replaceChildren(textLine('Your goal', 'move-label'), form);
    input.focus();
  };
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (workstream.goalText && !workstream.goalConfirmed) {
    box.append(textLine('Goal, drafted for you', 'move-label'), textLine(workstream.goalText, 'move-title'));
    if (workstream.goalQuote) box.append(textLine(`“${workstream.goalQuote}”`, 'task-quote'));
    actions.append(taskButton('Keep', () => save(workstream.goalText), { primary: true }), taskButton('Change', async () => edit()));
  } else if (workstream.goalText) {
    // a kept goal is one line with a pencil (2026-10-29): the label, a block and a Change button read as clutter
    const line = document.createElement('div');
    line.className = 'goal-line';
    const text = textLine(`Goal: ${workstream.goalText}`, 'goal-text');
    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'ws-icon-act goal-change';
    pencil.setAttribute('aria-label', 'Change goal');
    pencil.title = 'Change goal';
    pencil.append(icon('pencil'));
    pencil.addEventListener('click', edit);
    line.append(text, pencil);
    box.append(line);
    return box;
  } else return null;
  box.append(actions);
  return box;
}

// Why this card sits where it does today, with the words from its own mail that back it.
function whyBlock(priority) {
  if (!priority?.why) return null;
  const box = document.createElement('div');
  box.className = 'why-block';
  box.append(textLine(priority.due ? `${priority.why} Due ${priority.due}.` : priority.why));
  if (priority.quote) box.append(textLine(`“${priority.quote}”`, 'task-quote'));
  return box;
}

// A workstream's goal and cloud settings (docs/archive/tasks-space/proposal.md): the goal in his words, the kind of goal, why it
// was picked, and the cloud switch. They used to live only in the folded card list; the focused card now hosts them.
function goalSettings(workstream) {
  const nodes = [];
  const why = whyBlock(workstream.priority);
  if (why) nodes.push(why);
  const goal = goalBlock(workstream);
  if (goal) nodes.push(goal);
  // The kind's goal chips are gone (loggie-workspaces-integration F2: 8 of 8 were labels nobody chose); the goal line
  // comes from evidence. One switch stays: "Just keep me posted", which keeps a workspace quiet.
  const quiet = (workstream.goals || []).find((option) => option === 'Just keep me posted');
  if (quiet) {
    const on = workstream.goal === quiet;
    const chips = document.createElement('div');
    chips.className = 'goal-chips';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = on ? 'goal-chip selected' : 'goal-chip';
    chip.setAttribute('aria-pressed', String(on));
    chip.textContent = quiet;
    chip.addEventListener('click', async () => {
      try { unwrap(await window.loggie.hikyaku.setGoal(workstream.name, on ? workstream.goals.find((option) => option !== quiet) : quiet)); await loadWorkstreams({ autoCatchUp: false }); }
      catch (error) { elements.workstreamStatus.textContent = error.message; }
    });
    chips.append(chip);
    nodes.push(chips);
  }
  if (!workstream.folder && workstream.name !== 'Chats') nodes.push(cloudToggle(workstream));
  return nodes;
}

// One thing Loggie stopped on, shown in the big card: where it is, what it is, the question in plain words (a helper's
// command line taken out, needs-model.js), and the answers the question names as buttons, with Something else… for
// anything the buttons do not cover. A failure with no named answers offers Try again.
// A group chat is named by its title ("nebius x nvidia: loggie"), never by whichever member happens to be listed first.
const whoOf = (ask) => ((ask.who || []).length > 1 && ask.title ? ask.title : (ask.who || []).map((p) => p.name || p.address || p.handle).filter(Boolean)[0] || ask.title || 'Someone');
// The ask for a suggested home: who, where it came from, the words that suggest it, and two icons. ✓ saves the person
// to the workstream (screen-data.js answerAsk), so the router files them itself from then on; ✕ never asks again.
function homeCard(workstream, ask) {
  const card = document.createElement('article');
  card.className = 'task-card needs-card';
  const who = whoOf(ask);
  const from = { messages: 'Messages', whatsapp: 'WhatsApp', outlook: 'Outlook', gmail: 'Gmail' }[ask.source] || ask.source;
  card.append(textLine(`${from} · ${String(ask.at || '').slice(0, 10)}`, 'move-label'), textLine(`${who} · ${workstream.name}?`, 'move-title'));
  if (ask.quote) card.append(textLine(`“${ask.quote}”`, 'task-quote'));
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const answer = (target) => async () => { unwrap(await hikyaku().answerAsk(ask.id, target)); await loadWorkstreams(); };
  const yes = taskButton('✓', answer(workstream.name), { primary: true });
  yes.setAttribute('aria-label', `Yes, ${who} belongs to ${workstream.name}`);
  yes.title = `${who} belongs to ${workstream.name}`;
  const no = taskButton('✕', answer(null));
  no.setAttribute('aria-label', `No, ${who} is not part of ${workstream.name}`);
  no.title = 'Not part of it';
  actions.append(yes, no);
  card.append(actions);
  return card;
}

function needsCard(workstream, item) {
  const card = document.createElement('article');
  card.className = 'task-card needs-card';
  const failed = item.phase === 'failed';
  const { plain, options } = askParts(item.question);
  card.append(textLine(`${workstream.name} · ${failed || /failed/i.test(plain) ? 'Loggie could not finish' : 'Loggie needs your answer'}`, 'move-label'), textLine(item.title, 'move-title'));
  if (plain) card.append(textLine(plain, 'needs-why'));
  if (item.detail) card.append(textLine(item.detail, 'task-quote'));
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const send = async (text) => {
    const outcome = unwrap(await window.loggie.hikyaku.answer(item.id, text));
    if (outcome?.text) { moveOutcomes.set(item.id, outcome.text); elements.workstreamStatus.textContent = `${item.title}: ${outcome.text}`; }
    await loadWorkstreams();
    await drawFirstToday();
  };
  const openField = () => {
    const answer = document.createElement('textarea');
    answer.rows = 2;
    answer.setAttribute('aria-label', `Your answer for ${item.title}`);
    const row = document.createElement('div');
    row.className = 'task-actions';
    row.append(taskButton('Send to Loggie', () => send(answer.value.trim() || 'Try again.'), { primary: true }));
    actions.replaceWith(answer, row);
    answer.focus();
  };
  const choices = options.length ? options : failed ? ['Try again'] : [];
  choices.forEach((option, i) => actions.append(taskButton(option[0].toUpperCase() + option.slice(1), () => send(option === 'Try again' ? 'Try again.' : option), { primary: i === 0 })));
  actions.append(taskButton(choices.length ? 'Something else…' : 'Answer', openField, { primary: !choices.length }));
  card.append(actions);
  return card;
}

// What needs his answer across every workstream: the moves Loggie stopped on (a question, or a failure), labelled
// with their workstream, and the batch buttons. Drafting and drafted moves are not asks; they show in their card.
function renderNeedsYou(workstreams) {
  const asks = workstreams.flatMap((workstream) => (workstream.active || []).filter((item) => item.phase === 'needs-you' || item.phase === 'failed').map((item) => ({ workstream, item })));
  queue.asks = asks;
  queue.homes = workstreams.flatMap((workstream) => (workstream.asks || []).map((ask) => ({ workstream, ask })));
  renderBatchActions(workstreams);
  renderQueue();
}

// Draft every next move quietly, then open all the drafts in one sitting.
function renderBatchActions(workstreams) {
  const moves = workstreams.filter((workstream) => workstream.caughtUp && !workstream.quiet && workstream.top).map((workstream) => workstream.top.id);
  const ready = workstreams.flatMap((workstream) => workstream.active || []).filter((item) => item.phase === 'ready').length;
  const buttons = [];
  if (moves.length > 1) buttons.push(taskButton(`Draft all ${moves.length} quietly`, async () => {
    const { started } = unwrap(await window.loggie.hikyaku.draftAll(moves));
    elements.workstreamStatus.textContent = `Drafting ${started.length} in the background. Nothing opens until you press Open my replies.`;
    await loadWorkstreams();
  }));
  if (ready) buttons.push(taskButton(`Open my replies (${ready})`, async () => {
    elements.workstreamStatus.textContent = 'Opening your replies one by one. Outlook comes forward for each.';
    const results = unwrap(await window.loggie.hikyaku.openReplies());
    const opened = results.filter((result) => ['reply', 'new-message', 'already-open'].includes(result.mode)).length;
    elements.workstreamStatus.textContent = `${opened} of ${results.length} open in your mail app. Read each one and press Send.`;
    await loadWorkstreams();
  }, { primary: true }));
  elements.batchActions.replaceChildren(...buttons);
}

const catchingUp = new Set();

async function catchUpQuietly(name) {
  if (catchingUp.has(name)) return;
  catchingUp.add(name);
  try { unwrap(await window.loggie.hikyaku.catchUp(name)); }
  catch (error) { elements.workstreamStatus.textContent = `${name}: ${error.message}`; }
  finally { catchingUp.delete(name); await loadWorkstreams(); }
}


// The Workspaces tab (workspaces.js): the list of workspaces and one workspace's page, with its moves, drafts to send,
// goal and cloud settings (goalSettings), from the same card data.
const hikyaku = () => window.loggie.hikyaku;
let workstreamsView = null;
// "Open the workspace" from Meetings: the Workspaces tab opens on that card once its view exists.
// Before the Workspaces view exists (the first visit), the name waits and opens once the view draws.
let pendingWorkspace = null;
document.addEventListener('loggie:open-workspace', (event) => {
  const name = event.detail?.name;
  if (!name) return;
  if (workstreamsView && lastWorkstreams.some((card) => card.name === name)) workstreamsView.open(name); else pendingWorkspace = name;
});
async function drawWorkspaces(workstreams) {
  workstreamsView ||= createWorkspacesView({
    root: elements.workstreamView,
    api: {
      refresh: async () => unwrap(await hikyaku().refresh()),
      workspaceLook: async (name) => unwrap(await hikyaku().workspaceLook(name)),
      workspaceNew: async (name, keys) => unwrap(await hikyaku().workspaceNew(name, keys)),
      refreshOne: async (name) => unwrap(await hikyaku().refreshOne(name)),
      setStake: async (name, stake) => unwrap(await hikyaku().setStake(name, stake)),
      park: async (name, until) => unwrap(await hikyaku().park(name, until)),
      doIt: async (taskId, line = null) => unwrap(await hikyaku().doIt(taskId, undefined, line)),
      markMove: async (taskId, why) => unwrap(await hikyaku().markMove(taskId, why)),
      moveDate: async (taskId, date) => unwrap(await hikyaku().moveDate(taskId, date)),
      unretire: async (taskId) => unwrap(await hikyaku().unretire(taskId)),
      openDraft: async (taskId, options) => unwrap(await hikyaku().openDraft(taskId, options)),
      renameWorkstream: async (name, label) => unwrap(await hikyaku().renameWorkstream(name, label)),
      dismissWorkstream: async (name) => unwrap(await hikyaku().dismissWorkstream(name)),
      retireWorkstream: async (name, choice, target) => unwrap(await hikyaku().retireWorkstream(name, choice, target)),
      unretireWorkstream: async (name) => unwrap(await hikyaku().unretireWorkstream(name)),
      deleteWorkstream: async (name, choice, target) => unwrap(await hikyaku().deleteWorkstream(name, choice, target)),
      retiredWorkstreams: async () => unwrap(await hikyaku().retiredWorkstreams()),
      fileCall: async (id, workstream, source) => unwrap(await hikyaku().fileCall(id, workstream, source)),
      moveThread: async (itemId, workstream) => unwrap(await hikyaku().moveThread(itemId, workstream)),
      confirmGoal: async (name, text) => unwrap(await hikyaku().confirmGoal(name, text)),
      foundKeep: async (choice) => unwrap(await hikyaku().foundKeep(choice)),
      cloudYesAnswer: async (group, answer) => unwrap(await hikyaku().cloudYesAnswer(group, answer)),
      foundRead: async (name) => unwrap(await hikyaku().foundRead(name)),
      uiAct: async (act) => (hikyaku().uiAct ? unwrap(await hikyaku().uiAct(act)) : null),
    },
    onChanged: () => reloadShared(),
    // Today's picks, so the card marks the same moves with Today's ★ (F7).
    picks: () => queue.picks.map((pick) => pick.taskId),
    settingsFor: goalSettings,
    replies,
  });
  workstreamsView.draw(workstreams);
  if (pendingWorkspace && workstreams.some((card) => card.name === pendingWorkspace)) workstreamsView.open(pendingWorkspace);
  pendingWorkspace = null;
}

let lastWorkstreams = [];
// Today draws once the cards have answered (or failed), so it never says "No workspaces yet" before they load.
let cardsLoaded = false;
async function loadWorkstreams({ autoCatchUp = false } = {}) {
  try {
    const workstreams = unwrap(await window.loggie.hikyaku.workstreams());
    lastWorkstreams = workstreams;
    cardsLoaded = true;
    await drawWorkspaces(workstreams);
    // The order's source: when it is by date, the card list says why (no yes yet, or the cloud AI failed).
    const note = workstreams.find((workstream) => workstream.priority?.note)?.priority.note;
    if (note) elements.workstreamStatus.textContent = note;
    // What the cloud AI cost today (usage.js); hidden before the first call of the day.
    const usage = await window.loggie.hikyaku.usage().then(unwrap).catch(() => null);
    elements.usageLine.hidden = !usage?.line;
    elements.usageLine.textContent = usage?.line || '';
    renderNeedsYou(workstreams);
    // The "drafting" line is only true while a run is going; the card carries the outcome after that.
    const drafting = workstreams.some((workstream) => (workstream.active || []).some((item) => item.phase === 'drafting'));
    if (!drafting && /^Loggie is preparing drafts|^Drafting \d+ in the background/.test(elements.workstreamStatus.textContent)) elements.workstreamStatus.textContent = '';
    if (autoCatchUp) {
      for (const workstream of workstreams) {
        if (!workstream.caughtUp && !workstream.quiet) await catchUpQuietly(workstream.name);
      }
    }
  } catch (error) { cardsLoaded = true; elements.workstreamStatus.textContent = error.message; renderQueue(); }
}

// The one reload for every shared change (Gio, 2026-10-23: "I have to refresh Workspaces for the Today tab to update"):
// Today draws the cards and a separate list of picks, and the signals that reloaded only the cards left a Done move on
// Today. Signals in a burst (a refresh, its ranking, Core's events) wait 150 ms and cost one reload; one that comes while
// a reload runs gets one more after it. Nothing moves: the lists are drawn again in place.
let reloadTimer = null;
let reloading = null;
let reloadAgain = false;
let reloadWaiters = [];
async function reloadNow() {
  if (reloading) { reloadAgain = true; return reloading; }
  reloading = (async () => {
    do {
      reloadAgain = false;
      await loadWorkstreams();
      await drawFirstToday();
    } while (reloadAgain);
  })().finally(() => { reloading = null; });
  return reloading;
}
function reloadShared() {
  clearTimeout(reloadTimer);
  return new Promise((resolve) => {
    reloadWaiters.push(resolve);
    reloadTimer = setTimeout(() => {
      const waiters = reloadWaiters;
      reloadWaiters = [];
      reloadNow().finally(() => waiters.forEach((done) => done()));
    }, 150);
  });
}
window.loggie.core.onEvents(() => reloadShared());
// A new order from the cloud AI (priorities.js) redraws the cards in it.
window.loggie.hikyaku.onRanked(() => reloadShared());

// The cards at the top of the panel (renderer/meeting-cards.js): a meeting offer, the end ask, and the one question
// after a call. The first two come from live hikyaku:entry events and leave on their answer event; the question is
// drawn from the prepared sends (hikyaku.sends) and leaves when the send is no longer pending.
const surface = { cards: [], sends: [], picking: new Map(), errors: new Map(), heard: {}, next: null, nextDone: null, off: new Set(), bundlePick: null, bundleBusy: '', chooseOpen: false };

// A card's answer that fails says why on the card: the Today status line is out of sight on the Meetings tab,
// and a click there looked like it did nothing (2026-10-12).
const runKey = (runs) => [runs].flat().join(',');
function onCard(runs, onClick) {
  return async () => {
    surface.errors.delete(runKey(runs));
    try { await onClick(); }
    catch (error) { surface.errors.set(runKey(runs), error.message); drawSurface(); throw error; }
  };
}
function cardError(runs) {
  const message = surface.errors.get(runKey(runs));
  if (!message) return null;
  const line = textLine(message, 'form-status form-error');
  line.setAttribute('role', 'alert');
  return line;
}

function pickList(runs, { options, default: chosen }) {
  const box = document.createElement('div');
  box.className = 'next-move';
  box.append(textLine('Pick the AI to use', 'move-label'));
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  for (const option of options) {
    const button = taskButton(option.label, onCard(runs, async () => {
      for (const run of [runs].flat()) {
        unwrap(await window.loggie.hikyaku.send(run, option.id, true));
        surface.picking.delete(run);
      }
      surface.bundlePick = null;
      await loadSends();
    }), { primary: option.id === chosen });
    button.disabled = !option.connected;
    actions.append(button);
  }
  box.append(actions);
  const error = cardError(runs);
  if (error) box.append(error);
  return box;
}

// The next-meeting card's form: labeled fields, Fill in Outlook, Not now. While Outlook is being filled every field is
// locked and the button says so; the answer replaces the form with one line, or shows the reason and unlocks it.
function nextMeetingForm(card) {
  const form = document.createElement('form');
  form.className = 'compact-form next-meeting-form';
  const inputs = {};
  for (const field of card.fields) {
    const label = document.createElement('label');
    label.className = `field field-${field.name}`;
    const name = document.createElement('span');
    name.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.type; input.name = field.name; input.value = field.value || '';
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.type === 'text') { input.maxLength = 60; input.spellcheck = false; input.autocomplete = 'off'; }
    inputs[field.name] = input;
    label.append(name, input);
    form.append(label);
  }
  const status = textLine('', 'form-status');
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const submit = document.createElement('button');
  submit.type = 'submit'; submit.className = 'primary'; submit.textContent = card.submit.label;
  const skip = taskButton(card.skip.label, async () => { unwrap(await runAction(window.loggie.hikyaku, card.skip.action)); surface.next = null; drawSurface(); });
  actions.append(submit, skip);
  form.append(actions, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
    const lock = (on) => { for (const input of Object.values(inputs)) input.disabled = on; submit.disabled = on; skip.disabled = on; };
    lock(true); submit.textContent = card.submit.busy; status.textContent = ''; status.className = 'form-status';
    try {
      const line = inviteResultLine(unwrap(await window.loggie.hikyaku.invite(card.call, fields)), fields);
      if (line.ok) { surface.nextDone = { key: card.key, heading: 'Next meeting ready', title: card.title, text: line.text }; surface.next = null; drawSurface(); return; }
      status.textContent = line.text; status.className = 'form-status form-error';
    } catch (error) { status.textContent = error.message; status.className = 'form-status form-error'; }
    lock(false); submit.textContent = card.submit.label;
  });
  return form;
}

function doneCard(done) {
  const article = document.createElement('article');
  article.className = 'task-card decision-card';
  const heading = document.createElement('strong');
  heading.textContent = done.heading;
  const header = document.createElement('header');
  header.append(heading);
  article.append(header, textLine(done.title, 'move-title'), textLine(done.text));
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  actions.append(taskButton('Done', async () => { surface.nextDone = null; drawSurface(); }));
  article.append(actions);
  return article;
}

// Several calls asking the same question: each call is a switch, Yes answers the ones left on in turn, and when the
// first answer asks which AI to use, the pick is asked once for all of them (pickList below, with every run).
function bundleCard(card, article) {
  const list = document.createElement('div');
  list.className = 'call-switches';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Calls to summarize');
  for (const call of card.calls) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = call.on ? 'goal-chip selected' : 'goal-chip';
    chip.setAttribute('aria-pressed', String(call.on));
    chip.textContent = call.title;
    chip.addEventListener('click', () => { if (call.on) surface.off.add(call.run); else surface.off.delete(call.run); drawSurface(); });
    list.append(chip);
  }
  const choose = document.createElement('details');
  choose.className = 'call-choose';
  choose.open = surface.chooseOpen;
  choose.addEventListener('toggle', () => { surface.chooseOpen = choose.open; });
  const on = card.calls.filter((call) => call.on).length;
  const summary = document.createElement('summary');
  summary.textContent = `Choose calls (${on} of ${card.calls.length})`;
  choose.append(summary, list);
  article.append(choose);
  if (surface.bundleBusy) { article.append(textLine(surface.bundleBusy, 'task-quote')); return article; }
  if (surface.bundlePick) { article.append(pickList(surface.bundlePick.runs, surface.bundlePick)); return article; }
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  for (const spec of card.buttons) {
    const node = taskButton(spec.label, async () => {
      const asking = [];
      surface.bundleBusy = `Answering ${spec.actions.length} call${spec.actions.length === 1 ? '' : 's'}…`;
      drawSurface();
      try {
        for (const action of spec.actions) {
          const result = unwrap(await runAction(window.loggie.hikyaku, action));
          if (result?.picker) asking.push({ run: action.args[0], options: result.options, default: result.default });
        }
      } finally { surface.bundleBusy = ''; }
      if (asking.length) surface.bundlePick = { runs: asking.map((a) => a.run), options: asking[0].options, default: asking[0].default };
      await loadSends();
    }, { primary: spec.primary });
    node.disabled = Boolean(spec.disabled);
    actions.append(node);
  }
  article.append(actions);
  return article;
}

function surfaceCard(card) {
  if (card.kind === 'next-done') return doneCard(card);
  const article = document.createElement('article');
  article.className = 'task-card decision-card';
  const header = document.createElement('header');
  const heading = document.createElement('strong');
  heading.textContent = card.heading;
  header.append(heading);
  article.append(header);
  if (card.title) article.append(textLine(card.title, 'move-title'));
  const detail = [card.when, card.people, card.place].filter(Boolean).join(' · ');
  if (detail) article.append(textLine(detail));
  if (card.why) article.append(textLine(card.why));
  if (card.body) article.append(textLine(card.body));
  if (card.note) article.append(textLine(card.note, 'task-quote'));
  if (card.fields) { article.append(nextMeetingForm(card)); return article; }
  if (card.kind === 'decide-bundle') return bundleCard(card, article);
  const picker = surface.picking.get(card.run);
  if (picker) { article.append(pickList(card.run, picker)); return article; }
  const actions = document.createElement('div');
  actions.className = 'task-actions';
  for (const spec of card.buttons) {
    actions.append(taskButton(spec.label, onCard(card.run, async () => {
      const result = unwrap(await runAction(window.loggie.hikyaku, spec.action));
      // The first Yes returns the pick list; every other answer is written as an event, which takes the card away.
      if (card.kind === 'decide' && result?.picker) { surface.picking.set(card.run, result); drawSurface(); }
      else if (card.kind === 'decide') await loadSends();
    }), { primary: spec.primary }));
  }
  if (card.buttons.length) article.append(actions);
  const error = card.run ? cardError(card.run) : null;
  if (error) article.append(error);
  return article;
}

let redrawMeetings = () => {};
function drawSurface() {
  const next = surface.nextDone ? [{ ...surface.nextDone, kind: 'next-done' }] : [nextMeetingCard(surface.next)].filter(Boolean);
  elements.liveCards.replaceChildren(...surface.cards.map(surfaceCard));
  queue.surface = [...decisionCards(surface.sends, surface.off), ...next];
  renderQueue();
  redrawMeetings();
}

async function loadNextMeeting() {
  try { surface.next = unwrap(await window.loggie.hikyaku.nextMeeting()); }
  catch { surface.next = null; }
  drawSurface();
}

async function loadSends() {
  try { surface.sends = unwrap(await window.loggie.hikyaku.sends()); }
  catch (error) { surface.sends = []; elements.workstreamStatus.textContent = error.message; }
  drawSurface();
}


// The cloud AI key (cloud-key.js). The field is emptied the moment Save is pressed, before the answer comes back; the
// reply is only { saved: true } or a plain error, so the key is never drawn anywhere.
async function loadKeyStatus() {
  try { elements.keyStatus.textContent = unwrap(await window.loggie.hikyaku.keyStatus()).saved ? 'Saved' : 'Not saved'; }
  catch { elements.keyStatus.textContent = 'Not saved'; }
}
elements.keyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = elements.cloudKey.value;
  elements.cloudKey.value = '';
  elements.saveKey.disabled = true;
  try { unwrap(await window.loggie.hikyaku.saveKey(key)); elements.keyStatus.textContent = 'Saved'; }
  catch (error) { elements.keyStatus.textContent = error.message; }
  finally { elements.saveKey.disabled = false; }
});
elements.testKey.addEventListener('click', async () => {
  elements.testKey.disabled = true;
  elements.keyStatus.textContent = 'Testing…';
  try {
    const said = unwrap(await window.loggie.hikyaku.testKey()).message;
    elements.keyStatus.textContent = said;
  }
  catch (error) { elements.keyStatus.textContent = error.message; }
  finally { elements.testKey.disabled = false; }
});
loadKeyStatus();

// "Your free times" (loggie-availability I3): the five rules an availability ask uses when the typed words or the email
// name none, read from settings.json each time Settings opens. A change saves that one row at once and writes "Saved",
// or why not, in the row; the controls then show what was saved.
const freeTimesApi = {
  availabilitySettings: async () => unwrap(await hikyaku().availabilitySettings()),
  setAvailability: async (patch) => unwrap(await hikyaku().setAvailability(patch)),
};
const freeTimes = Object.fromEntries(['timesStart', 'timesEnd', 'timesZone', 'timesShortest', 'timesDays', 'timesSelf', 'timesHoursSaid', 'timesZoneSaid', 'timesShortestSaid', 'timesDaysSaid', 'timesSelfSaid'].map((id) => [id, document.querySelector(`#${id}`)]));
const hourLabel = (hour) => `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
const optionsOf = (select, list) => select.replaceChildren(...list.map(([value, label]) => Object.assign(document.createElement('option'), { value: String(value), textContent: label })));
const numbersFrom = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
function drawFreeTimes(view) {
  if (!view?.resolved) return;
  const { resolved, stored, macZone, zones } = view;
  optionsOf(freeTimes.timesStart, numbersFrom(6, 12).map((hour) => [hour, hourLabel(hour)]));
  optionsOf(freeTimes.timesEnd, numbersFrom(12, 22).map((hour) => [hour, hourLabel(hour)]));
  optionsOf(freeTimes.timesZone, [['', `This Mac (${macZone})`], ...(zones || []).map((zone) => [zone, zone])]);
  optionsOf(freeTimes.timesShortest, [15, 30, 45, 60, 90].map((n) => [n, `${n} min`]));
  optionsOf(freeTimes.timesDays, numbersFrom(1, 10).map((n) => [n, `${n} weekday${n === 1 ? '' : 's'}`]));
  freeTimes.timesStart.value = String(resolved.startHour);
  freeTimes.timesEnd.value = String(resolved.endHour);
  freeTimes.timesZone.value = stored?.timeZone || '';
  freeTimes.timesShortest.value = String(resolved.minMinutes);
  freeTimes.timesDays.value = String(resolved.daysAhead);
  freeTimes.timesSelf.checked = resolved.selfBlocks;
}
let freeTimesView = null;
async function loadFreeTimes() {
  try { freeTimesView = await freeTimesApi.availabilitySettings(); drawFreeTimes(freeTimesView); }
  catch (error) { freeTimes.timesHoursSaid.textContent = error.message; }
}
const FREE_TIME_ROWS = [
  ['timesStart', 'timesHoursSaid', (el) => ({ startHour: Number(el.value) })],
  ['timesEnd', 'timesHoursSaid', (el) => ({ endHour: Number(el.value) })],
  ['timesZone', 'timesZoneSaid', (el) => ({ timeZone: el.value || null })],
  ['timesShortest', 'timesShortestSaid', (el) => ({ minMinutes: Number(el.value) })],
  ['timesDays', 'timesDaysSaid', (el) => ({ daysAhead: Number(el.value) })],
  ['timesSelf', 'timesSelfSaid', (el) => ({ selfBlocks: el.checked })],
];
for (const [id, said, patchOf] of FREE_TIME_ROWS) {
  freeTimes[id].addEventListener('change', async () => {
    freeTimes[said].textContent = '';
    try { freeTimesView = await freeTimesApi.setAvailability(patchOf(freeTimes[id])); drawFreeTimes(freeTimesView); freeTimes[said].textContent = 'Saved'; }
    catch (error) { drawFreeTimes(freeTimesView); freeTimes[said].textContent = error.message; }
  });
}
document.querySelectorAll('[data-view="settings"]').forEach((button) => button.addEventListener('click', loadFreeTimes));
// "Record from these calendars" (record-calendars.js, 2026-10-27): one checkhouse per calendar, read each time Settings
// opens; a change saves every checked calendar at once and writes "Saved", or why not, under the list.
const recordApi = {
  recordCalendars: async () => unwrap(await hikyaku().recordCalendars()),
  setRecordCalendars: async (ids) => unwrap(await hikyaku().setRecordCalendars(ids)),
};
const recordList = document.querySelector('#recordCalendars');
const recordSaid = document.querySelector('#recordCalendarsSaid');
function drawRecordCalendars(view) {
  recordList.replaceChildren(...(view?.calendars || []).map((calendar) => {
    const row = Object.assign(document.createElement('label'), { className: 'settings-row times-row record-row' });
    const box = Object.assign(document.createElement('input'), { type: 'checkhouse', checked: calendar.on });
    box.dataset.calendar = calendar.id;
    const copy = Object.assign(document.createElement('span'), { className: 'row-copy' });
    copy.append(Object.assign(document.createElement('strong'), { textContent: calendar.title }), Object.assign(document.createElement('span'), { textContent: calendar.account }));
    row.append(copy, box);
    box.addEventListener('change', async () => {
      recordSaid.textContent = '';
      const ids = [...recordList.querySelectorAll('input[type="checkhouse"]')].filter((input) => input.checked).map((input) => input.dataset.calendar);
      try { drawRecordCalendars(await recordApi.setRecordCalendars(ids)); recordSaid.textContent = 'Saved'; }
      catch (error) { box.checked = !box.checked; recordSaid.textContent = error.message; }
    });
    return row;
  }));
}
async function loadRecordCalendars() {
  try { drawRecordCalendars(await recordApi.recordCalendars()); recordSaid.textContent = ''; }
  catch (error) { recordList.replaceChildren(); recordSaid.textContent = error.message; }
}
document.querySelectorAll('[data-view="settings"]').forEach((button) => button.addEventListener('click', loadRecordCalendars));
// Settings, Your Mac (loggie-diagnostics): every system checked each time Settings opens, one press to fix each.
const macCheck = createMacCheck({
  root: document.querySelector('#macCheck'),
  api: {
    setupStatus: async () => unwrap(await hikyaku().setupStatus()),
    setupSave: async (patch) => unwrap(await hikyaku().setupSave(patch)),
    setupAsk: async (what) => unwrap(await hikyaku().setupAsk(what)),
    cloudYesAnswer: async (group, answer) => unwrap(await hikyaku().cloudYesAnswer(group, answer)),
    openKeys: () => document.querySelector('#keySection')?.scrollIntoView({ block: 'start' }),
    onVoice: (listener) => window.loggie.voice.onUpdate(listener),
  },
});
document.querySelectorAll('[data-view="settings"]').forEach((button) => button.addEventListener('click', () => macCheck.check()));
// Settings opened any other way (a loggie:navigate, as LOGGIE_OPEN_VIEW=settings does) checks too; before, only the click did.
document.addEventListener('loggie:navigate', (event) => { if ((typeof event.detail === 'string' ? event.detail : event.detail?.view) === 'settings') { loadFreeTimes(); macCheck.check(); } });
loadFreeTimes();

document.querySelector('#minimize').addEventListener('click', () => window.loggie.minimizePanel());
document.querySelector('#fullscreen').addEventListener('click', async (event) => {
  // The button is held before the await: event.currentTarget is null once the handler resumes, so the label never
  // changed and the first setAttribute threw.
  const button = event.currentTarget;
  const fullScreen = await window.loggie.toggleFullScreen();
  button.setAttribute('aria-pressed', String(fullScreen));
  button.setAttribute('aria-label', fullScreen ? 'Exit full screen' : 'Enter full screen');
  button.title = fullScreen ? 'Exit full screen' : 'Enter full screen';
});
document.querySelector('#hide').addEventListener('click', () => window.loggie.hide());
elements.clearCommands.addEventListener('click', () => { elements.commandHistory.replaceChildren(); elements.askResults.hidden = true; });
// The ask box (ask-box.js): messages run through the ask runner with a status line and a card; invites and file
// opens keep runCommand.
const askBox = attachAskBox({
  form: elements.composer, input: elements.message, sendButton: elements.searchButton,
  under: document.querySelector('#askUnder'), card: document.querySelector('#askCard'), status: document.querySelector('#askStatus'),
  ask: window.loggie.ask, unwrap, runOther: (text) => runCommand(text),
  mirror: document.querySelector('#askMirror'), uiAct: (act) => hikyaku().uiAct(act),
});
// The nine-step setup (setup.js, docs/teammate-ready/spec.md B5): a Mac that has not finished it opens on it, with the
// tabs, the dots and the ask bar out of the way; Done hands over to Today, where the first look for workspaces says
// it started. A preview with no setup status, or a Mac that is set up, never sees it.
const setupApi = {
  setupStatus: async (part) => unwrap(await hikyaku().setupStatus(part)),
  setupSave: async (patch) => unwrap(await hikyaku().setupSave(patch)),
  setupAsk: async (what) => unwrap(await hikyaku().setupAsk(what)),
  saveTavilyKey: async (key) => unwrap(await hikyaku().saveTavilyKey(key)),
  testTavilyKey: async () => unwrap(await hikyaku().testTavilyKey()),
  relaunch: async () => unwrap(await hikyaku().relaunch()),
  saveKey: async (key) => unwrap(await hikyaku().saveKey(key)),
  testKey: async () => unwrap(await hikyaku().testKey()),
  cloudYesAnswer: async (group, answer) => unwrap(await hikyaku().cloudYesAnswer(group, answer)),
  appIcon: async (app) => unwrap(await hikyaku().appIcon(app)),
  onVoice: (listener) => window.loggie.voice.onUpdate(listener),
  // The run events (preload onEntry, which returns its unsubscribe): Ready hears the speech download's setup.download.
  onEntry: (listener) => window.loggie.hikyaku.onEntry(listener),
  // The Found step (first-run-polish B4.5): what the look found, a look now, Keep or Later, and a row's new name.
  foundStatus: async () => unwrap(await hikyaku().foundStatus()),
  foundLook: async () => unwrap(await hikyaku().foundLook()),
  foundKeep: async (choice) => unwrap(await hikyaku().foundKeep(choice)),
  renameWorkstream: async (name, label) => unwrap(await hikyaku().renameWorkstream(name, label)),
};
const setupRoot = document.querySelector('[data-page="setup"]');
let lastSetupStatus = null;
const setupView = createSetupView({ root: setupRoot, api: setupApi, onDone: ({ later = false } = {}) => {
  foundLater = later;
  document.body.classList.remove('is-setup');
  document.querySelector('#brandHome').disabled = false;
  setupView.stop();
  document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'today' }));
  loadWorkstreams();
  drawFirstToday();
  refreshFolders(null, { jump: false }).catch(console.error);
} });
// The setup page over everything, for the nine steps or for the Found step alone.
function openSetupPage() {
  document.body.classList.add('is-setup');
  document.querySelector('#brandHome').disabled = true;
  document.dispatchEvent(new CustomEvent('loggie:navigate', { detail: 'setup' }));
}
async function openFound() {
  try { lastSetupStatus = (await setupApi.setupStatus()) || lastSetupStatus; } catch { /* the last status still names the chats and the host app */ }
  openSetupPage();
  setupView.startFound(lastSetupStatus || {});
}
// Settings, Set up again (2026-10-28): setup from Welcome, filled in with what this Mac has saved. Nothing is cleared,
// so a Mac that is set up stays set up whatever the walk; Done marks it done again and lands on Today.
document.querySelector('#setupAgain').addEventListener('click', async () => {
  let status;
  try { status = await setupApi.setupStatus(); }
  catch (error) { const line = document.querySelector('#macSummary'); line.classList.remove('is-ok'); line.textContent = `Setup could not open: ${error.message}`; return; }
  lastSetupStatus = status;
  openSetupPage();
  setupView.start(status, { again: true });
});
const setupChecked = (async () => {
  let status;
  try { status = await setupApi.setupStatus(); }
  catch (error) { elements.workstreamStatus.textContent = `Setup could not read this Mac: ${error.message}`; return false; }
  lastSetupStatus = status;
  foundLater = status?.found === 'later';
  // Setup done, but its Found step not answered yet (a relaunch mid-step): the step opens again.
  if (status?.done && status.found === 'pending') { openSetupPage(); setupView.startFound(status); return true; }
  if (!status || status.done) return false;
  openSetupPage();
  setupView.start(status);
  return true;
})();
elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!elements.message.value.trim() || state.busy || !askBox.canSend()) return;
  askBox.submit();
});
elements.message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); elements.composer.requestSubmit(); }
});

loadWorkstreams({ autoCatchUp: false });
// The Notes & Meetings tab (meetings.js): drawn the first time it opens, reloaded each time it is shown or a call moves.
const meetingsRoot = document.querySelector('#viewMeetings');
const meetings = createMeetingsView({
  root: meetingsRoot,
  api: {
    calls: async () => unwrap(await hikyaku().calls()),
    events: async (from, to) => unwrap(await hikyaku().events(from, to)),
    fileEvent: async (id, start, workstream) => unwrap(await hikyaku().fileEvent(id, start, workstream)),
    eventSeed: async (id, start) => unwrap(await hikyaku().eventSeed(id, start)),
    workspaceFromEvent: async (id, start, name) => unwrap(await hikyaku().workspaceFromEvent(id, start, name)),
    call: async (id) => unwrap(await hikyaku().call(id)),
    callLive: async (id) => unwrap(await hikyaku().callLive(id)),
    openPermissionSettings: async (permission) => unwrap(await window.loggie.permissions.openSettings(permission)),
    recordStart: async (title, source, workspace, eventId, alsoEventId) => unwrap(await hikyaku().recordStart(title, source, workspace, eventId, alsoEventId)),
    meetingEnd: async (call, answer) => unwrap(await hikyaku().meetingEnd(call, answer)),
    meetingPause: async (call, answer) => unwrap(await hikyaku().meetingPause(call, answer)),
    callPagePick: async (call, where) => unwrap(await hikyaku().callPagePick(call, where)),
    callPageAdd: async (call, file, where) => unwrap(await hikyaku().callPageAdd(call, file, where)),
    eventPagePick: async (eventId, start) => unwrap(await hikyaku().eventPagePick(eventId, start)),
    eventPageAdd: async (eventId, start, file) => unwrap(await hikyaku().eventPageAdd(eventId, start, file)),
    callNotes: async (id, text) => unwrap(await hikyaku().callNotes(id, text)),
    fileCall: async (id, workstream, source) => unwrap(await hikyaku().fileCall(id, workstream, source)),
    contextMenu: async (menu) => unwrap(await hikyaku().contextMenu(menu)),
    callShare: async (id, how) => unwrap(await hikyaku().callShare(id, how)),
    callTrash: async (id) => unwrap(await hikyaku().callTrash(id)),
    summarize: async (id) => unwrap(await hikyaku().summarize(id)),
    transcriptLine: async (id, index, text) => unwrap(await hikyaku().transcriptLine(id, index, text)),
    searchCalls: async (query) => unwrap(await hikyaku().searchCalls(query)),
    noteLine: async (id, text, action, value) => unwrap(await hikyaku().noteLine(id, text, action, value)),
    explainCall: async (id) => unwrap(await hikyaku().explainCall(id)),
    nameAccept: async (id, heard) => unwrap(await hikyaku().nameAccept(id, heard)),
    nameKeep: async (id, heard) => unwrap(await hikyaku().nameKeep(id, heard)),
    nameUndo: async (id, heard) => unwrap(await hikyaku().nameUndo(id, heard)),
    callTitle: async (id, title, choice = null) => unwrap(await hikyaku().callTitle(id, title, choice)),
    callMeetings: async (id) => unwrap(await hikyaku().callMeetings(id)),
    themName: async (id, name) => unwrap(await hikyaku().themName(id, name)),
    answerAsk: async (id, workstream) => unwrap(await hikyaku().answerAsk(id, workstream)),
    markMove: async (taskId, why) => unwrap(await hikyaku().markMove(taskId, why)),
    moveDate: async (taskId, date) => unwrap(await hikyaku().moveDate(taskId, date)),
    doIt: async (taskId, line = null) => unwrap(await hikyaku().doIt(taskId, undefined, line)),
    unretire: async (taskId) => unwrap(await hikyaku().unretire(taskId)),
    uiAct: async (act) => { try { return unwrap(await hikyaku().uiAct(act)); } catch { return null; } },
  },
  onRecording: (on) => { document.querySelector('#meetingsDot').hidden = !on; },
  workstreams: () => lastWorkstreams,
});
redrawMeetings = () => meetings.redraw();
// Right-click anywhere in the panel (context-menu.js): a text field's Cut, Copy, Paste, Select All, or the menu of the
// thing under the pointer, drawn by the Mac (hikyaku:context-menu).
attachContextMenu({ popup: async (menu) => unwrap(await hikyaku().contextMenu(menu)) });
// ⌘K (Ctrl K) puts the caret in the ask bar from any page, as the mock-up's hint says.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k' && !document.body.classList.contains('is-setup')) {
    event.preventDefault();
    document.querySelector('#message')?.focus();
  }
});
meetings.load();
new MutationObserver(() => { if (!meetingsRoot.hidden) meetings.load(); else meetings.stop(); }).observe(meetingsRoot, { attributes: true, attributeFilter: ['hidden'] });
window.loggie.hikyaku.onEntry((event) => {
  meetings.onEvent(event);
  if (event?.type === 'meeting.heard') surface.heard = { ...surface.heard, [event.data.call]: event.data };
  surface.cards = applyEvent(surface.cards, event, surface.heard);
  drawSurface();
  // A call's notes are prepared when its screen finishes; the answer or a send ends the question.
  if (['step.finished', 'run.finished', 'send.decided', 'ai.picked'].includes(event?.type)) loadSends();
  // A summary that came back can make a call ready for its next meeting.
  if (['run.finished', 'check.result'].includes(event?.type)) loadNextMeeting();
  // A call filed on its card: Today and Workspaces show its steps without a Refresh (Codex review, 2026-10-23).
  if (event?.type === 'step.finished' && event.data?.step === 'file' && event.data.ok) reloadShared();
});
loadSends();
loadNextMeeting();

attachVoiceInput({ button: document.querySelector('#voiceButton'), input: elements.message, status: document.querySelector('#voiceStatus'), start: () => window.loggie.voice.start(), stop: () => window.loggie.voice.stop(), subscribe: listener => window.loggie.voice.onUpdate(listener) });
window.loggie.onFocusComposer(() => elements.message.focus());

let folderGranted = false;
async function refreshFolders(result, { jump = true } = {}) {
  const folders = unwrap(result || await window.loggie.folders.status());
  // Granted, the button says so and rests, with no paths under it, on first grant and on every relaunch (2026-10-28).
  folderGranted = folders.length > 0 && folders.every(f => f.accessible);
  const allow = document.querySelector('#allowFolders');
  allow.textContent = folderGranted ? 'Enabled' : 'Enable file search';
  allow.disabled = folderGranted;
  document.querySelector('#folderStatus').textContent = folderGranted ? '' : folders.length ? folders.map(f => `${f.accessible ? 'Allowed' : 'Access blocked'}: ${f.path}`).join(' · ') : 'Setup needed: choose the folders you want to search.';
  document.querySelector('#folderSettings').hidden = !folders.some(f => !f.accessible);
  // No folder chosen yet sends the user to Settings, but never over the setup page or right after it.
  if (!folders.length && jump && !(await setupChecked)) { document.querySelector('[data-view="settings"]').click(); }
}
document.querySelector('#chooseFolders').addEventListener('click', async () => { try { await refreshFolders(await window.loggie.folders.choose()); } catch (error) { document.querySelector('#folderStatus').textContent = error.message; } });
refreshFolders().catch(console.error);

document.querySelector('#allowFolders').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  document.querySelector('#folderStatus').textContent = 'Checking folder access… Choose Allow if macOS asks.';
  try { await refreshFolders(await window.loggie.folders.allowDefaults()); }
  catch (error) { document.querySelector('#folderStatus').textContent = error.message; }
  finally { document.querySelector('#allowFolders').disabled = folderGranted; }
});
document.querySelector('#recheckFolders').addEventListener('click', () => refreshFolders().catch(console.error));
document.querySelector('#folderSettings').addEventListener('click', () => window.loggie.permissions.openSettings('folders'));
let deniedVoicePermission = 'microphone';
const voiceSetup = document.querySelector('#voiceSetupStatus');
const enableVoice = document.querySelector('#enableVoice');
window.loggie.voice.onUpdate(update => {
  if (update.status === 'permissions-granted') { voiceSetup.textContent = 'Voice access enabled. Use the mic beside your request when you want to speak.'; enableVoice.disabled = false; document.querySelector('#voiceSettings').hidden = true; }
  if (update.status === 'permissions-complete') enableVoice.disabled = false;
  if (update.error) { voiceSetup.textContent = update.error; enableVoice.disabled = false; deniedVoicePermission = update.permission; document.querySelector('#voiceSettings').hidden = !['microphone', 'speech'].includes(update.permission); }
});
enableVoice.addEventListener('click', async () => {
  enableVoice.disabled = true;
  voiceSetup.textContent = 'Choose Allow in the macOS speech and microphone prompts.';
  try { unwrap(await window.loggie.voice.authorize()); }
  catch (error) { voiceSetup.textContent = error.message; enableVoice.disabled = false; }
});
document.querySelector('#voiceSettings').addEventListener('click', () => window.loggie.permissions.openSettings(deniedVoicePermission));

// First today (docs/goal-priorities/proposal-one-thing.md): the morning's picks, best first, drawn by today.js. Not this
// sets a pick aside for the day, logged, with no new call. moveOutcomes keeps what the last Do it on a move led to.
const moveOutcomes = new Map();
window.loggie.hikyaku.onMoved?.((outcome) => {
  if (outcome?.phase === 'refreshed') { reloadShared(); return; }
  // The look for workspaces: its line on Today and Workspaces, and the new cards once it is done.
  if (outcome?.phase === 'discover') {
    // A look's progress goes to the Found step only (its bar); the start and the end say their line as before.
    if (outcome.data) { setupView.onDiscover(outcome); return; }
    // Only the end of a look speaks, and only when it found something or waits on him (Gio, 2026-10-28): no "Looking
    // at this week's mail" and no "No new workspaces" line.
    const line = outcome.done ? outcome.text || '' : '';
    elements.workstreamStatus.textContent = line;
    workstreamsView?.say(line);
    if (outcome.done) reloadShared();
    setupView.onDiscover(outcome);
    return;
  }
  if (!outcome?.taskId) return;
  moveOutcomes.set(outcome.taskId, outcome.text);
  workstreamsView?.moved(outcome.text, outcome.taskId, outcome.phase);
  reloadShared();
});
async function drawFirstToday() {
  try { const first = unwrap(await window.loggie.hikyaku.firstToday()); queue.picks = first.picks || []; queue.source = first.source ?? null; }
  catch (error) { queue.picks = []; queue.source = null; elements.workstreamStatus.textContent = error.message; }
  renderQueue();
}
drawFirstToday();
