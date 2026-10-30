// A stand-in for the preload bridge so the real panel (panel.html + panel.js) runs in a plain window for the click
// check (click-check.cjs). Made-up data only: this folder ships in a public repo. Every call is recorded in
// window.__calls as "area.method"; anything not listed here answers an empty success.
import { CARDS } from './fixture-cards.js';

const ACTIVE = {
  'Bank Offer': [{ id: 'task_ty', title: 'Thank the recruiter for the referral', phase: 'ready', at: '2026-10-10T09:00:00.000Z' }, { id: 'task_q1', title: 'Follow up with the recruiter', phase: 'needs-you', question: 'The Outlook helper failed. Command failed: /tmp/helper reply --sender ana@bank.example --background The draft is kept. Answer "again" to look for the email again, or "new" to open it as a new message instead.' }],
  'Hotel Hackathon': [{ id: 'task_q2', title: 'Confirm the build day plan', phase: 'needs-you', question: 'You wrote after this draft was made. Answer "open anyway" to open it as it is.' }],
  'Pharma Case': [{ id: 'task_q3', title: 'Register the team', phase: 'failed', question: 'Mail could not be read.' }],
};
// Workspaces made from a meeting in this run (hikyaku.workspaceFromEvent), by event id, so the week then shows them filed.
const made = {};
const workstreams = CARDS.map((card) => ({ ...card, goals: ['Get an offer', 'Just keep me posted'], active: ACTIVE[card.name] || [], caughtUp: true }));
const DATA = {
  'hikyaku.workstreams': workstreams,
  // Today's picks point at real fixture tasks (spec-b): a move from a text with its ask line, a move with a thread,
  // and a task Loggie stopped on, so the pick-to-card match is exercised.
  'hikyaku.firstToday': { picks: [
    { taskId: 'task_c', name: 'Bank Offer', move: 'Email Lucky Star: ask about the bar tab', due: null, why: 'Sam asked about the bar tab today.', quote: 'did you ask Lucky Star about the bar tab?' },
    { taskId: 'task_a', name: 'Bank Offer', move: 'Follow up with the recruiter on interview status', due: '2026-10-15', why: null, quote: null, rule: 'replies first' },
    { taskId: 'task_q1', name: 'Bank Offer', move: 'Follow up with the recruiter', due: null, why: null, quote: null },
  ], source: 'ai', note: null, at: '2026-10-10T08:00:00.000Z' },
  'hikyaku.sends': ['run_1', 'run_2', 'run_3'].map((run, i) => ({ run, what: 'call-notes', status: 'pending', title: `Weekly sync ${i + 1}` })),
  'hikyaku.nextMeeting': { call: 'call_1', title: 'Weekly sync 1', people: 1, date: '2026-10-16', start: '13:00', end: '13:50', room: 'Hall', floors: [2] },
  'folders.status': [{ path: '/tmp/Documents', accessible: true }],
  'hikyaku.decide': { picker: true, options: [{ id: 'cloud', label: 'Cloud AI', connected: true }], default: 'cloud' },
  // Do it and an answer answer with what happened (do-it.js), as the real main process does.
  'hikyaku.doIt': { started: true, phase: 'queued', kind: null, text: 'Queued. Loggie is drafting it and will open the reply in Outlook. Keep working; this card updates when it lands.' },
  // Reply on a To do move (do-it.js replyToMove): the reply to the email it came from, open and unsent.
  'hikyaku.replyTo': { started: true, phase: 'in-mail-app', kind: null, text: 'Answering "Video interview", Oct 9: their newest email. Ready in Outlook: Robin Park. You send it there.' },
  // The reply's yes (loggie-reply-yes): not given yet, so the row asks; the offer was never shown. A held draft's time
  // fills it and opens it.
  'hikyaku.replyYes': { always: false, offered: false },
  'hikyaku.setReplyYes': { always: true, offered: true },
  'hikyaku.replyFill': { started: true, phase: 'in-mail-app', kind: null, text: 'Ready in Outlook: Robin Park. You send it there.' },
  'hikyaku.replyAgain': { started: true, phase: 'in-mail-app', kind: null, text: 'Ready in Outlook: Robin Park. You send it there.' },
  'ask.again': { askId: '2026-10-11-abcdef12', outcome: 'placed', action: 'reply', words: 'Hi Jamie, Tuesday works.', lines: ['Ready in Outlook: Jamie Park. You send it there.'], results: [{ to: 'Jamie Park', app: 'outlook', kind: 'person', outcome: 'placed', detail: '', undo: { kind: 'reply', app: 'Outlook' } }], did: ['Opened the same draft again'] },
  // The ask box (ask-box.js): a name that matched two people, so the line offers both; a run answers with its id.
  // Each choice carries its address (ask-run.js choiceLabel), as the real runner sends it (loggie-intros fix 1).
  'ask.preview': { action: 'message', status: 'which', line: 'Which lena? Lena Ortiz <+13235550100> or Lena Brooks <lena.brooks@example.org>', words: 'Running late', app: null,
    who: [{ text: 'lena', status: 'many', twins: false, candidates: [{ name: 'Lena Ortiz', app: 'messages', kind: 'person', key: 'messages:1', last: '', address: '+13235550100', label: 'Lena Ortiz <+13235550100>' }, { name: 'Lena Brooks', app: 'whatsapp', kind: 'person', key: 'whatsapp:5', last: '', address: 'lena.brooks@example.org', label: 'Lena Brooks <lena.brooks@example.org>' }] }] },
  'ask.run': { askId: '2026-10-11-abcdef12' },
  'ask.stop': true,
  'ask.undo': { lines: ['Cleared the draft in Messages.'] },
  // A held draft's time (loggie-reply-yes): it goes in and the reply opens.
  'ask.fill': { askId: '2026-10-11-abcdef12', outcome: 'placed', action: 'reply', words: 'Hi Jamie, Tuesday at 3 PM works.', lines: ['Ready in Outlook: Jamie Park. You send it there.'], results: [{ to: 'Jamie Park', app: 'outlook', kind: 'person', outcome: 'placed', detail: '', undo: { kind: 'reply', app: 'Outlook' } }], did: ['Put "3 PM" in the draft'] },
  // The Notes & Meetings tab (meetings.js): three calls, one written up, one with Loggie's guess, one waiting for a yes.
  'hikyaku.calls': [
    { id: '2026-10-09-1300-weekly-sync', title: 'Weekly sync with Lena', start: '2026-10-09T17:00:00Z', minutes: 32, people: 2, workstream: 'Bank Offer', guess: null, guessItem: null, state: 'done', run: null },
    { id: '2026-10-08-0900-coffee-chat', title: 'Coffee chat with Yuki', start: '2026-10-08T13:00:00Z', minutes: 21, people: 2, workstream: null, guess: 'Hotel Hackathon', evidence: 'said “hackathon” 4 times', guessItem: 'call:2026-10-08-0900-coffee-chat@none', state: 'done', run: null },
    { id: '2026-10-07-1600-team-readout', title: 'Team readout', start: '2026-10-07T20:00:00Z', minutes: 55, people: 4, workstream: 'Hotel Hackathon', guess: null, guessItem: null, state: 'waiting', run: 'run_1' },
  ],
  'hikyaku.call': {
    id: '2026-10-09-1300-weekly-sync', title: 'Weekly sync with Lena', start: '2026-10-09T17:00:00Z', minutes: 32, people: 2, workstream: 'Bank Offer', guess: null, state: 'done', run: null,
    summarized: true, notes: '', notesNewer: true, transcriptNewer: false, transcriptLive: false, transcriptEditable: true, draft: null,
    steps: [
      { text: 'Send Lena the deck', owner: 'Me', who: 'Me', mine: true, at: 754, unsure: false, why: '', moveId: 'task_m1', closed: null, message: { to: 'Lena' } },
      { text: 'Ask Jamie about the start date', owner: 'Me', who: 'Me', mine: true, at: 1210, unsure: true, why: 'Quote not found in the call', moveId: 'task_m2', closed: null, message: null },
      { text: 'Share the team list', owner: 'Speaker 2 (Lena)', who: 'Lena', mine: false, at: 1500, unsure: false, why: '', moveId: null, closed: null },
    ],
    sections: [{ heading: 'The role', lines: [
      { text: 'The team owns the analytics roadmap', owner: null, at: 120, unsure: false, why: '', source: { context: 'Lena opened with what the team is for.', said: [{ text: 'The team owns the analytics roadmap.', who: 'Lena', at: 120 }], near: null } },
      { text: 'Start date is flexible into June', owner: null, at: 300, unsure: true, why: 'Words not found near that minute', source: { context: 'Gio asked whether the start could move; Lena did not answer with a month, and nobody named June.', said: [{ text: 'Could the start move?', who: 'You', at: 300 }], near: null } },
      { text: 'The offer comes through MNT (unclear) and Jamy (unclear) signs it', owner: null, at: 420, unsure: false, why: '' },
    ] }],
    transcript: [
      { at: 120, who: 'Lena', text: 'The team owns the analytics roadmap.' },
      { at: 300, who: 'Me', text: 'Could the start move?' },
      { at: 420, who: 'Lena', text: 'It comes through MNT (unclear), Jamy (unclear) signs it.' },
      { at: 754, who: 'Me', text: "I'll send you the deck tonight." },
      { at: 1210, who: 'Lena', text: 'Jamie decides the date.' },
      { at: 1500, who: 'Lena', text: "I'll share the team list." },
    ],
    // The name check (name-check.js): one suggestion with its source, one person never searched.
    nameCheck: { v: 1, status: 'done', words: { MNT: { kind: 'fix', to: 'M&T', from: 'web', source: { label: 'bank.example', url: 'https://www.bank.example/' } }, Jamy: { kind: 'person' } }, queries: [], accepted: {}, kept: {}, added: {} },
  },
  // The meetings near a call's time, the choices under its title (2A): made-up, title, start, id and a count only.
  'hikyaku.callMeetings': [{ id: 'ev_mt', start: '2026-10-09T17:00:00Z', title: 'Video Meeting with Northwind', people: 1 }],
  // The Meetings week (week-events.js joinWeek): a filed call, Loggie's guess waiting to be filed, a call with no notes
  // and one still ahead, placed on the week asked for so every week shows the four marks.
  'hikyaku.fileEvent': (id, start, workstream) => ({ saved: 0, logged: 1, workstream }),
  // New workspace… on a meeting with no recording (first-run-polish B3.3): the seed's counts, then the made workspace.
  'hikyaku.eventSeed': () => ({ people: 3, domains: ['bank.example'], words: ['Case'] }),
  // Retire (loggie-workspaces-integration F1): Bank Offer has open moves, so the first press asks; the choice retires it.
  'hikyaku.retireWorkstream': (name, choice) => (choice ? { name, choice } : { needsChoice: true, open: 2 }),
  'hikyaku.deleteWorkstream': (name, choice) => (choice ? { name, choice, unfiled: 1 } : { needsChoice: true, open: 2 }),
  'hikyaku.retiredWorkstreams': [],
  // Filing a recording answers what it did (refile.js): the workspace, the next steps made on it, and its notes.
  'hikyaku.fileCall': (id, name) => (name === null ? { from: 'Acme Bank', to: null, none: true, retired: ['task_step1'], created: [], notes: false }
    : { from: null, to: name, retired: [], created: ['task_step1', 'task_step2'], notes: true }),
  // New workspace on the Workspaces tab (loggie-new-workspace): the look's counts and people, then the made card; the keys
  // Save sent are kept for the check.
  'hikyaku.workspaceLook': (name) => ({ name, words: ['Hotel', 'hackathon'], mail: 4, chats: 1, calls: 1, chatsOn: true, notes: [], people: [
    { key: 'dana@hotel.example', name: 'Dana Wu', at: 'dana@hotel.example', count: 3 }, { key: '+15550001', name: 'Kim Ito', at: '+15550001', count: 1 }, { key: 'lee@hotel.example', name: '', at: 'lee@hotel.example', count: 1 }] }),
  'hikyaku.workspaceNew': (name, keys) => { window.__madeWith = keys; DATA['hikyaku.workstreams'].push({ ...CARDS[0], name, label: null, moves: [], active: [] }); return { name, cloud: false, calls: 1 }; },
  'hikyaku.workspaceFromEvent': (id, start, name) => { made[id] = name; DATA['hikyaku.workstreams'].push({ ...CARDS[0], name, label: null, moves: [], active: [] }); return { name, cloud: false }; },
  'hikyaku.events': (from) => {
    const day = (offset, time) => { const [y, m, d] = from.split('-').map(Number); return new Date(y, m - 1, d + offset, ...time.split(':').map(Number)).toISOString(); };
    // Today, around the real clock (the Day view's card and rows, loggie-meetings-focus): a block under way, the next
    // meeting with people in 25 min, a class later; and what the sort hid today.
    const soon = (minutes) => new Date(Math.floor(Date.now() / 60000) * 60000 + minutes * 60000).toISOString();
    const monday = new Date(`${from}T12:00:00`);
    const thisWeek = Math.abs(Date.now() - monday.getTime()) < 7 * 86400000 && Date.now() >= monday.getTime() - 12 * 3600000;
    const today = thisWeek ? [
      { kind: 'event', id: 'ev_block', title: 'Macro: assignment work', start: soon(-30), end: soon(30), allDay: false, people: 0, sort: 'block', who: [], call: null, workstream: null, guess: null, state: null, mark: 'none' },
      { kind: 'event', id: 'ev_now', title: 'Coffee chat with Michael', start: soon(25), end: soon(55), allDay: false, people: 1, sort: 'people', who: ['Michael'], call: null, workstream: null, guess: null, state: null, mark: 'upcoming' },
      { kind: 'event', id: 'ev_class', title: 'NBA 6650 Strategy', start: soon(150), end: soon(240), allDay: false, people: 0, sort: 'class', who: [], call: null, workstream: null, guess: null, state: null, mark: 'upcoming' },
    ] : [];
    const day0 = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    return { calendar: 'granted', hidden: thisWeek ? [{ day: day0(soon(0)), why: 'school feed', title: 'School coffee time', start: soon(-120) }, { day: day0(soon(0)), why: 'duplicate', title: 'Coffee chat with Michael', start: soon(25) }] : [], items: [
      { kind: 'event', id: 'ev_sync', title: 'Weekly sync with Lena', start: day(0, '13:00'), end: null, allDay: false, people: 2, sort: 'people', who: ['Lena'], call: '2026-10-09-1300-weekly-sync', workstream: 'Bank Offer', guess: null, state: 'done', mark: 'filed' },
      { kind: 'event', id: 'ev_coffee', title: 'Coffee chat with Yuki', start: day(1, '09:00'), end: null, allDay: false, people: 2, sort: 'people', who: ['Yuki'], call: '2026-10-08-0900-coffee-chat', workstream: null, guess: 'Hotel Hackathon', state: 'done', mark: 'notes' },
      { kind: 'event', id: 'ev_hours', title: 'Office hours', start: day(1, '13:00'), end: null, allDay: false, people: 3, sort: 'people', who: [], call: null, workstream: null, guess: 'Bank Offer', how: 'domain', filed: false, state: null, mark: 'none' },
      { kind: 'event', id: 'ev_next', title: 'Case team check-in', start: day(4, '11:00'), end: null, allDay: false, people: 3, sort: 'people', who: [], call: null, workstream: null, guess: null, state: null, mark: 'upcoming' },
      ...today,
    ].map((item) => (item.id in made ? { ...item, workstream: made[item.id], guess: null } : item)) };
  },
  // Search through what was said: "deck" is in the weekly sync's transcript only.
  'hikyaku.searchCalls': (query) => (/deck/i.test(query) ? [{ id: '2026-10-09-1300-weekly-sync', count: 1, hits: [{ index: 3, at: 754, who: 'Me', text: "I'll send you the deck tonight." }] }] : []),
  'hikyaku.nameAccept': { heard: 'MNT', to: 'M&T', added: true },
  'hikyaku.answer': { started: true, phase: 'queued', kind: null, text: 'Queued. Loggie is drafting it and will open the reply in Outlook. Keep working; this card updates when it lands.' },
};
// The setup page (setup.js): set up by default, so every other section opens as before. ?setup=outlook or apple-mail
// serves a fresh Mac whose permissions turn on after their ask, each key after its test, the yes after its answer, the
// step after setupSave; Quit & Reopen reloads with the state kept. ?slow=1 holds every ask 400 ms. The Full Disk switch
// finds two accounts (Exchange, newest mail today; Google, yesterday); &mail=0 finds none until Open Internet Accounts
// is pressed, as if the account were added there, and the Disk step's poll reads it (2026-10-28, fix 1).
const setupQuery = new URLSearchParams(location.search);
const dayAt = (daysAgo, hour) => { const at = new Date(); at.setDate(at.getDate() - daysAgo); at.setHours(hour, 0, 1, 0); return at.toISOString(); };
const TWO_ACCOUNTS = () => ({ accounts: 2, addresses: ['alex@school.example', 'alex@gmail.example'], error: null,
  kinds: [{ kind: 'exchange', accounts: 1, newest: dayAt(0, 0), read: true }, { kind: 'google', accounts: 1, newest: dayAt(1, 12), read: true }] });
const NO_ACCOUNTS = () => ({ accounts: 0, addresses: [], kinds: [], error: null });
const freshSetup = (mailApp) => ({ done: false, step: null, startedAt: null, readyAt: null, signName: '', suggestedName: 'Alex', mailApp: null, wants: mailApp, chats: false,
  installed: { outlook: true, whatsapp: true }, hostApp: 'Terminal', mail: NO_ACCOUNTS(), keys: { nebius: false, tavily: false }, yes: { ai: false, chats: false },
  permissions: { calendar: 'unknown', fullDisk: 'unknown', microphone: 'unknown', screen: 'unknown', accessibility: 'unknown', automation: 'unknown' },
  voice: { answer: null, helper: 'built' },
  // The speech models (first-run-polish B5.1): ?speech=wanted serves a Mac that already wants them; python has numpy.
  speech: { wanted: setupQuery.get('speech') === 'wanted', ready: false, always: false, chosen: null, bytes: 1460555318 }, python: { ok: true, numpy: true, packaged: false },
  fileVault: 'on', firstRun: true, found: null });
// ?setup=done (2026-10-28): a Mac that is set up, every switch on, both keys, the yes, Sam on Outlook with texts, for
// Settings' Set up again.
const doneSetup = () => ({ ...freshSetup('outlook'), done: true, step: 'ready', signName: 'Sam', mailApp: 'outlook', chats: true, mail: TWO_ACCOUNTS(),
  keys: { nebius: true, tavily: true }, yes: { ai: true, chats: true }, voice: { answer: 'granted', helper: 'built' },
  permissions: { calendar: 'granted', fullDisk: 'granted', microphone: 'granted', screen: 'granted', accessibility: 'granted', automation: 'granted' },
  speech: { wanted: true, ready: true, always: false, chosen: true, bytes: 1460555318 }, firstRun: false, found: 'done' });
let setupState = null;
if (setupQuery.get('setup')) {
  try { setupState = JSON.parse(sessionStorage.getItem('setup-state')); } catch { setupState = null; }
  setupState ||= setupQuery.get('setup') === 'done' ? doneSetup() : freshSetup(setupQuery.get('setup'));
}
const keepSetup = () => { try { sessionStorage.setItem('setup-state', JSON.stringify(setupState)); } catch { /* the reload starts fresh */ } };
const later = (value) => (setupQuery.get('slow') === '1' ? new Promise((resolve) => setTimeout(() => resolve(value), 400)) : value);
// Each app's own icon (first-run-polish B2.2): ?icons=none gives every app installed with no icon (the bundled marks
// draw), ?icons=missing gives Outlook not installed; absent, every icon is a made-up 1 x 1 PNG.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SETUP_DATA = {
  'hikyaku.setupStatus': (part) => (!setupState ? { done: true } : part === 'permissions' ? structuredClone({ permissions: setupState.permissions, mail: setupState.mail }) : structuredClone(setupState)),
  'hikyaku.setupSave': (patch) => {
    if (!setupState) return {};
    const at = new Date().toISOString();
    if ('signName' in patch) setupState.signName = patch.signName;
    if ('mailApp' in patch) setupState.mailApp = patch.mailApp;
    if ('chats' in patch) setupState.chats = patch.chats;
    if ('voice' in patch) setupState.voice.answer = patch.voice;
    if ('automation' in patch) setupState.permissions.automation = patch.automation;
    // The Calls switch: on makes the models wanted, as main's speechWantedOf does, so Ready shows the speech row.
    if ('speechModels' in patch) { setupState.speech.chosen = patch.speechModels; if (patch.speechModels === true) setupState.speech.wanted = true; }
    const step = patch.done ? 'ready' : patch.step;
    if (step) { setupState.step = step; if (step !== 'welcome') setupState.startedAt ||= at; if (step === 'ready') setupState.readyAt ||= at; }
    // As main: only a first Done (no workspaces yet) opens the Found step, and never twice.
    if (patch.done) { setupState.done = true; if (setupState.firstRun && !setupState.found) setupState.found = 'pending'; }
    keepSetup();
    return { setup: { step: setupState.step, found: setupState.found }, signName: setupState.signName, mailApp: setupState.mailApp, chats: setupState.chats ? ['messages'] : [] };
  },
  'hikyaku.setupAsk': (what) => {
    const p = setupState.permissions;
    const tomorrow = new Date(Date.now() + 86400000); tomorrow.setHours(14, 0, 0, 0);
    const answers = {
      calendar: () => { p.calendar = 'granted'; return { status: 'granted', next: { title: 'Case team sync', start: tomorrow.toISOString() } }; },
      fullDisk: () => { p.fullDisk = 'granted'; setupState.mail = setupQuery.get('mail') === '0' ? NO_ACCOUNTS() : TWO_ACCOUNTS(); return { opened: true }; },
      screen: () => { p.screen = 'granted'; return { opened: true }; },
      mailAccounts: () => { setupState.mail = TWO_ACCOUNTS(); return { opened: true }; },
      automation: () => { p.automation = 'granted'; return { status: 'granted', mail: 'granted', systemEvents: 'granted' }; },
      accessibility: () => { p.accessibility = 'granted'; return { status: 'granted' }; },
      microphone: () => { p.microphone = 'granted'; return { status: 'granted' }; },
      speech: () => { setTimeout(() => (window.__listeners['voice.onUpdate'] || []).forEach((listener) => listener({ status: 'permissions-complete' })), 80); return { status: 'starting' }; },
    };
    const answer = answers[what]();
    keepSetup();
    return later(answer);
  },
  'hikyaku.testKey': () => { if (setupState) { setupState.keys.nebius = true; keepSetup(); } return { ok: true, message: 'The key works.' }; },
  'hikyaku.testTavilyKey': () => { if (setupState) { setupState.keys.tavily = true; keepSetup(); } return { ok: true, message: 'The key works.' }; },
  // As main does, the answer is also written as setup.cloud_answered, which takes Today's yes card away.
  'hikyaku.cloudYesAnswer': (group, answer) => {
    if (setupState) { setupState.yes[group] = answer === 'yes'; keepSetup(); }
    if (group === 'ai' && answer === 'yes') foundYes = true;
    setTimeout(() => (window.__listeners['hikyaku.onEntry'] || []).forEach((listener) => listener({ type: 'setup.cloud_answered', data: { group, answer } })), 0);
    return { group, answer };
  },
  'hikyaku.relaunch': () => { keepSetup(); setTimeout(() => location.reload(), 60); return { relaunching: true }; },
  'hikyaku.appIcon': (app) => { const mode = setupQuery.get('icons'); const off = mode === 'none' || (mode === 'missing' && app === 'outlook'); return { app, installed: !(mode === 'missing' && app === 'outlook'), icon: off ? null : TINY_PNG }; },
};
Object.assign(DATA, SETUP_DATA);
// Find your files (2026-10-28): ?folders=new serves a Mac with no folder chosen; Enable file search grants the three
// defaults, kept in sessionStorage so a reload reads them as already granted, as a relaunch does.
if (setupQuery.get('folders') === 'new') {
  let roots = [];
  try { roots = JSON.parse(sessionStorage.getItem('folder-roots')) || []; } catch { roots = []; }
  DATA['folders.status'] = () => roots.map((path) => ({ path, accessible: true }));
  DATA['folders.allowDefaults'] = () => {
    roots = ['/tmp/Documents', '/tmp/Desktop', '/tmp/Downloads'];
    try { sessionStorage.setItem('folder-roots', JSON.stringify(roots)); } catch { /* the reload starts fresh */ }
    return roots.map((path) => ({ path, accessible: true }));
  };
  DATA['folders.choose'] = () => DATA['folders.status']();
}
// "Your free times" (loggie-availability I3): the defaults view as main answers it for an empty settings.json, and a
// save that echoes the patch into it (timeZone null is This Mac).
const freeTimes = { resolved: { startHour: 9, endHour: 17, timeZone: 'America/New_York', minMinutes: 30, daysAhead: 5, selfBlocks: true }, stored: {}, macZone: 'America/New_York', zones: ['America/Chicago', 'America/New_York', 'Europe/London', 'UTC'] };
Object.assign(DATA, {
  'hikyaku.availabilitySettings': () => structuredClone(freeTimes),
  'hikyaku.setAvailability': (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'timeZone' && value === null) { delete freeTimes.stored.timeZone; freeTimes.resolved.timeZone = freeTimes.macZone; continue; }
      freeTimes.stored[key] = value; freeTimes.resolved[key] = value;
    }
    return structuredClone(freeTimes);
  },
});
// "Record from these calendars" (2026-10-27): made-up calendars in the shapes of his Mac, the main ones on by default
// (record-calendars.js), and a save that echoes the checked ids.
const recordCalendars = [
  { id: 'cal-ex-main', title: 'Calendar', account: 'Exchange', type: 'exchange', on: true },
  { id: 'cal-ex-school', title: 'School I', account: 'Exchange', type: 'exchange', on: false },
  { id: 'cal-google', title: 'me@school.example', account: 'me@school.example', type: 'caldav', on: true },
  { id: 'cal-icloud-work', title: 'Work', account: 'iCloud', type: 'caldav', on: false },
];
Object.assign(DATA, {
  'hikyaku.recordCalendars': () => ({ calendars: structuredClone(recordCalendars), saved: false }),
  'hikyaku.setRecordCalendars': (ids) => { for (const calendar of recordCalendars) calendar.on = ids.includes(calendar.id); return { calendars: structuredClone(recordCalendars), saved: true }; },
});
// The Found step (first-run-polish B4): the look runs until the check fires a discover done:true on hikyaku.onMoved;
// then two made-up found cards join the cards, and the step shows them, or the zero ?found= names (zero-key, zero-mail,
// zero-yes, zero-failed, zero-none). Keep and Later act on the cards as main does: dismissed ones go, kept ones stop
// being new.
const foundMode = setupQuery.get('found') || 'rows';
// The found yes (settings.cloudYes.found): an install from before it has none until a cloud yes says Yes.
let foundYes = false;
let lookDone = false;
const FOUND_ROWS = [
  { name: 'Robotics Club Treasurer', label: null, quote: 'You have been elected treasurer of the Robotics Club.', sender: 'Dana', date: '2026-10-09T15:00:00Z', subject: 'Club officers', fromSent: 0, threads: 3, yours: 2 },
  { name: 'Teaching Assistant ECON 1110', label: null, quote: '', sender: '', date: '2026-10-12T15:00:00Z', subject: 'TA hours', fromSent: 4, threads: 0, yours: 4 },
];
const ZEROS = { 'zero-key': { reason: 'no-key' }, 'zero-mail': { reason: 'no-mail' }, 'zero-yes': { reason: 'no-yes' }, 'zero-failed': { reason: 'failed', message: 'Mail did not answer in time.' }, 'zero-none': { reason: 'none', read: 1204 } };
const foundCard = (row, rank) => ({ ...CARDS[4], name: row.name, kind: 'other', goal: 'Get it done', goals: ['Get it done', 'Just keep me posted'], goalText: null, quiet: false, cloud: 'nebius', unread: 0,
  priority: { rank, due: null, idle: false, stake: 'normal' }, label: null, moves: [], active: [], caughtUp: false, found: { quote: row.quote, subject: row.subject, date: row.date }, confirmed: null, newFound: true, foundRow: row });
const looked = (outcome) => {
  if (outcome?.phase !== 'discover' || !outcome.done || lookDone) return;
  lookDone = true;
  if (foundMode === 'rows') FOUND_ROWS.forEach((row, i) => { if (!DATA['hikyaku.workstreams'].some((card) => card.name === row.name)) DATA['hikyaku.workstreams'].push(foundCard(row, 7 + i)); });
};
Object.assign(DATA, {
  'hikyaku.foundStatus': () => {
    if (!lookDone) return { phase: 'searching', progress: null, rows: [], zero: null };
    if (foundMode !== 'rows') return { phase: 'zero', progress: null, rows: [], zero: ZEROS[foundMode] };
    const rows = DATA['hikyaku.workstreams'].filter((card) => card.newFound).map((card) => ({ ...card.foundRow, label: card.label || null }));
    return rows.length ? { phase: 'found', progress: null, rows, zero: null } : { phase: 'zero', progress: null, rows: [], zero: { reason: 'none', read: 0 } };
  },
  'hikyaku.foundLook': () => ({ started: true }),
  'hikyaku.foundKeep': ({ keep, dismiss, end }) => {
    const cards = DATA['hikyaku.workstreams'];
    const counted = (name) => cards.find((card) => card.name === name && card.newFound);
    const kept = keep.filter(counted);
    const gone = dismiss.filter(counted);
    // As main's card does (found.js needsReadYes): a kept card with no approval, on an install with no found yes.
    for (const name of kept) { const card = counted(name); Object.assign(card, { newFound: false, foundRow: null, confirmed: '2026-10-18T11:00:00.000Z', readYes: card.cloud !== 'nebius' && !foundYes }); }
    DATA['hikyaku.workstreams'] = cards.filter((card) => !gone.includes(card.name));
    if (setupState && end) { setupState.found = end; keepSetup(); }
    return { kept: kept.length, dismissed: gone.length };
  },
  // The read yes on a kept found card (main found-read): every kept found card without one gets its approval, so
  // every such line goes.
  'hikyaku.foundRead': (name) => {
    const kept = DATA['hikyaku.workstreams'].filter((item) => item.found && item.confirmed);
    if (!foundYes || !kept.some((item) => item.name === name)) throw new Error("Loggie reads a workspace's mail only after your yes.");
    const waiting = kept.filter((item) => item.cloud !== 'nebius');
    for (const item of waiting) Object.assign(item, { cloud: 'nebius', readYes: false });
    return { name, cloud: 'nebius', approved: waiting.map((item) => item.name) };
  },
  // A row's new name (Edit name): main answers with the saved workstream.
  'hikyaku.renameWorkstream': (name, label) => ({ name, label }),
});
// The check may change an answer mid-run (a call that starts recording), as main's data would.
window.__data = DATA;
// Listeners the panel registers (onMoved, onRanked, ...) are kept so the check can fire them like main does.
window.__listeners = {};
// The bridge hears main's pushes too (registered first, so it runs before the panel's own listener).
window.__listeners['hikyaku.onMoved'] = [looked];
const RAW = new Set(['toggleFullScreen']);   // desktop/main-ipc-app.js: ipcMain.handle('loggie:toggle-full-screen') -> a boolean
const node = (path) => new Proxy(function () {}, {
  get: (_, key) => (typeof key === 'symbol' ? undefined : node(path ? `${path}.${String(key)}` : String(key))),
  apply: (_, __, args) => {
    if (/^on[A-Z]/.test(path.split('.').pop())) { (window.__listeners[path] ||= []).push(args[0]); return () => {}; }
    window.__calls = (window.__calls || []).concat(path);
    // The arguments too, so a check can say what a press sent (an undefined argument reads as null).
    window.__args = (window.__args || []).concat([{ path, args: JSON.parse(JSON.stringify(args.map((arg) => (arg === undefined ? null : arg)))) }]);
    const value = DATA[path];
    // A channel main answers with ipcMain.handle directly (no handleSecure envelope) answers its plain value here too.
    if (RAW.has(path)) return Promise.resolve(path in DATA ? structuredClone(value) : null);
    return Promise.resolve({ ok: true, data: typeof value === 'function' ? value(...args) : path in DATA ? structuredClone(value) : /list|search|history|results/i.test(path) ? [] : null });
  },
});
window.loggie = node('');
// A failure the panel does not catch is printed with where it came from, so the check can name it.
window.addEventListener('unhandledrejection', (event) => console.error(String(event.reason?.stack || event.reason).split('\n').slice(0, 3).join(' | ')));
window.addEventListener('error', (event) => console.error(String(event.error?.stack || event.message).split('\n').slice(0, 3).join(' | ')));
