// The nine-step setup (docs/teammate-ready/spec.md B5), pure: the steps in the mock-up's order, which ones a Mac can
// skip because it already has what they ask for, and the Ready checklist. No DOM, so node tests it and main.js reads
// the same rule at launch. `status` is setup-status.js setupStatus().

export const STEPS = Object.freeze(['welcome', 'email', 'calendar', 'disk', 'apps', 'voice', 'keys', 'calls', 'ready']);
export const LABELS = Object.freeze({ welcome: 'Welcome', email: 'Email', calendar: 'Calendar', disk: 'Disk', apps: 'Apps', voice: 'Voice', keys: 'Keys', calls: 'Calls', ready: 'Ready' });
// What a setup step may ask main for (ipc-validation.js validateSetupAsk).
export const SETUP_ASKS = Object.freeze(['calendar', 'fullDisk', 'automation', 'accessibility', 'speech', 'microphone', 'screen', 'mailAccounts']);

// Done only when setup said so (2026-10-28, Gio). An install from before setup existed (no setup record, but a name, a
// mail app, a yes or a workstreams.json) used to read as done, so Jess never saw setup; now it opens once, prefilled.
export function isSetupDone(raw) {
  return raw?.setup?.done === true;
}

// Whether the background (looks, reads, ranking) runs: when setup is done, and on an install from before setup, which
// already has workspaces, so it keeps running while setup is open (2026-10-28). `existing`: a name, a mail app, a yes
// or a workstreams.json, read before any record; once there is one, its `existing` says it (saveSetup). A fresh Mac
// waits for Done (spec C3), even after Welcome saved its name.
export function backgroundRuns(raw, { existing = false } = {}) {
  if (isSetupDone(raw)) return true;
  return raw?.setup && typeof raw.setup === 'object' ? raw.setup.existing === true : Boolean(existing);
}

const granted = (status, name) => status?.permissions?.[name] === 'granted';

// The Email step (2026-10-28, teammates' mail fix 2): one question, two tiles. Three tiles (Outlook, Apple Mail, Gmail)
// read as "where is my mail" when they meant "where do drafts open", and the Gmail one placed no reply on any Mac. The
// line says where the mail is read from, whichever tile is pressed.
export const EMAIL_QUESTION = 'Where do you write email?';
export const EMAIL_LINE = 'Loggie reads your mail through Apple Mail, whichever you pick: Gmail, school and work accounts all go there.';
export const MAIL_APP_TILES = Object.freeze([Object.freeze(['outlook', 'Outlook']), Object.freeze(['apple-mail', 'Apple Mail'])]);

// What the Apps step asks for: Outlook takes a draft only through Accessibility; Apple Mail through Mail and System
// Events control and Accessibility for the paste; chat drafts need Accessibility.
export function appsAsks({ mailApp, chats = false } = {}) {
  const asks = { outlook: ['accessibility'], 'apple-mail': ['automation', 'accessibility'] }[mailApp] || [];
  return chats && !asks.includes('accessibility') ? [...asks, 'accessibility'] : asks;
}

// The steps this Mac does not need: what they turn on is already on. Welcome, Email, Voice and Ready always show.
export function skipped(status = {}) {
  const out = new Set();
  if (granted(status, 'calendar')) out.add('calendar');
  if (granted(status, 'fullDisk') && Number(status.mail?.accounts) > 0) out.add('disk');
  if (appsAsks(status).every((ask) => granted(status, ask))) out.add('apps');
  if (status.keys?.nebius && status.keys?.tavily && status.yes?.ai && (!status.chats || status.yes?.chats)) out.add('keys');
  // Calls also holds the speech switch (first-run-polish B5.2, K19): with both grants it still shows until the switch
  // has an answer, unless this Mac always downloads the models.
  if (granted(status, 'microphone') && granted(status, 'screen') && (status.speech?.always || status.speech?.chosen !== null)) out.add('calls');
  return out;
}

// The Calls step's speech switch starts on (D3); a saved answer is kept.
export const speechSwitchOn = (status = {}) => status.speech?.chosen ?? true;

export function nextStep(current, status = {}) {
  const at = STEPS.indexOf(current);
  if (at < 0) throw new Error(`Unknown setup step "${current}".`);
  if (current === 'ready') return 'ready';
  const skip = skipped(status);
  return STEPS.slice(at + 1).find((step) => !skip.has(step)) || 'ready';
}

// Back (2026-10-28): the nearest step before `current` that was shown this run (`seen`), even if what it asks for is on
// by now (it shows as granted), or that this Mac still needs. Welcome is never skipped, so Back always reaches it.
export function backStep(current, status = {}, seen = []) {
  const at = STEPS.indexOf(current);
  if (at < 0) throw new Error(`Unknown setup step "${current}".`);
  if (at === 0) return null;
  const skip = skipped(status);
  return STEPS.slice(0, at).reverse().find((step) => seen.includes(step) || !skip.has(step));
}

// Where setup opens: nowhere when done; the saved step (or the next one, when what it asks for is on by now); else
// Welcome. A relaunch from step 8 lands here.
export function firstStep(status = {}) {
  if (status.done) return null;
  if (!STEPS.includes(status.step)) return 'welcome';
  if (status.step !== 'welcome' && status.step !== 'ready' && skipped(status).has(status.step)) return nextStep(status.step, status);
  return status.step;
}

export function pills(current) {
  const at = current === 'ready' ? STEPS.length : STEPS.indexOf(current);
  return STEPS.map((id, index) => ({ id, label: LABELS[id], state: index < at ? 'done' : index === at ? 'now' : 'todo' }));
}

// A step opened from Ready or the Found step (a key added later): every pill done but that one, which is now.
export function pillsDetour(current) {
  return STEPS.map((id) => ({ id, label: LABELS[id], state: id === current ? 'now' : 'done' }));
}

// The next meeting worth naming on the Calendar step: not all-day, not over, not a read-only feed with nobody on it.
export function nextMeeting(events = [], now = Date.now()) {
  const next = (events || []).filter((event) => event && !event.allDay && Date.parse(event.start) > now
    && !(event.writable === false && !(event.attendees || []).length)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  return next ? { title: next.title || 'Untitled event', start: next.start } : null;
}
export function nextMeetingLine(next, now = new Date()) {
  if (!next) return 'No meetings in the next 7 days.';
  const start = new Date(next.start);
  const time = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const sameDay = start.toDateString() === new Date(now).toDateString();
  return sameDay ? `Next: ${time}, ${next.title}` : `Next: ${start.toLocaleDateString('en-US', { weekday: 'short' })} ${time}, ${next.title}`;
}

export function accountsLine(mail = {}) {
  const n = Number(mail?.accounts) || 0;
  if (!n) return 'No mail account in Apple Mail yet';
  return n === 1 ? '1 account in Apple Mail' : `${n} accounts in Apple Mail`;
}

// The Disk step's live mail check (2026-10-28, teammates' mail fix 1): one line per kind of account in Internet
// Accounts, with the newest mail, read again every second, so a teammate sees her mail arrive before Continue. A
// teammate once pressed on with nothing in Apple Mail and got no workspaces, and nothing on the page had said why.
// `mail` is setup-status.js mailState (kinds); `now` sets what "today" is.
const KIND_NAMES = Object.freeze({ exchange: 'Microsoft Exchange', google: 'Google', icloud: 'iCloud', imap: 'Other mail' });
export function newestLine(iso, now = new Date()) {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return 'no mail yet: open Mail once and let it sync';
  const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const ago = Math.round((day(new Date(now)) - day(at)) / 86400000);
  return `newest mail ${ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
export function mailCheckLines(mail = {}, now = new Date()) {
  return (mail?.kinds || []).map((row) => {
    const count = `${row.accounts} account${row.accounts === 1 ? '' : 's'}`;
    return { kind: row.kind, text: `${KIND_NAMES[row.kind] || row.kind}: ${count}, ${row.read === false ? 'not read by Loggie' : newestLine(row.newest, now)}` };
  });
}
// With no account read: the plain steps, in the order System Settings shows them. Outlook, school and work accounts go
// in as Microsoft Exchange; Gmail as Google.
export const NO_MAIL_STEPS = Object.freeze([
  'Open System Settings > Internet Accounts.',
  'Add your account: Microsoft Exchange for Outlook, school and work mail; Google for Gmail.',
  'Turn on Mail for that account.',
  'Open Mail once and let it sync. This page checks again every second.',
]);
// The way past the Disk step with no mail says what it costs (fix 3): "Continue without mail" hid that nothing gets
// found until the mail is there.
export const SKIP_NO_MAIL = 'Skip for now: no workspaces until your mail is in Apple Mail';

// The Ready checklist: everything Loggie uses and its state; anything off carries the button that turns it on.
// `download` is the last setup.download event's data seen while Ready shows (B5.2), or null. Every row has `fill`: a
// number from 0 to 1 for the speech row's bar while it downloads, else null.
const MB = (bytes) => Math.round((Number(bytes) || 0) / 1e6).toLocaleString('en-US');
const SPEECH = 'NVIDIA speech on this Mac';
function speechRow(status, download) {
  if (status.speech?.ready || download?.state === 'ready') return { key: 'speech', label: SPEECH, state: 'on', button: null, note: null, fill: null };
  const note = (label, fill) => ({ key: 'speech', label: `${SPEECH} · ${label}`, state: 'note', button: null, note: null, fill });
  const fraction = Number(download?.total_bytes) > 0 ? Math.min(1, Math.max(0, Number(download.done_bytes) / Number(download.total_bytes))) : 0;
  if (download?.state === 'downloading') return note(`${MB(download.done_bytes)} of ${MB(download.total_bytes)} MB`, fraction);
  if (download?.state === 'paused') return note('Paused, trying again in a minute', fraction);
  return note('starting', 0);
}
function pythonRow(status) {
  const python = status.python || {};
  const label = 'Python with numpy: call notes';
  if (python.numpy) return { key: 'python', label, state: 'on', button: null, note: null, fill: null };
  const note = python.packaged ? 'Reinstall Loggie: its own Python is missing numpy.' : !python.ok ? 'Run in Terminal: xcode-select --install' : 'Run in Terminal: python3 -m pip install numpy';
  return { key: 'python', label, state: 'off', button: null, note, fill: null };
}

export function readyRows(status = {}, { screenOpened = false, download = null } = {}) {
  const row = (key, label, on, button = null, note = null) => ({ key, label, state: on ? 'on' : 'off', button: on ? null : button, note: on ? null : note, fill: null });
  const turnOn = (ask) => ({ label: 'Turn on', ask });
  const rows = [
    row('calendar', 'Calendar: meetings and record offers', granted(status, 'calendar'), turnOn('calendar')),
    row('fullDisk', 'Full Disk Access: mail, texts, contacts, files', granted(status, 'fullDisk'), turnOn('fullDisk')),
    row('mail', accountsLine(status.mail), Number(status.mail?.accounts) > 0, { label: 'Add an account', ask: 'mailAccounts' }, 'No workspaces until your mail is in Apple Mail.'),
  ];
  if (status.mailApp) {
    const asks = appsAsks({ mailApp: status.mailApp });
    const missing = asks.find((ask) => !granted(status, ask));
    rows.push(row('mailApp', status.mailApp === 'outlook' ? 'Outlook: drafts in their thread' : 'Apple Mail: drafts in their thread', !missing, missing ? turnOn(missing) : null));
  }
  if (status.chats) rows.push(row('chats', status.installed?.whatsapp ? 'Messages and WhatsApp: chat drafts' : 'Messages: chat drafts', granted(status, 'accessibility'), turnOn('accessibility')));
  const voiceOn = status.voice?.answer === 'granted';
  rows.push(status.voice?.helper === 'missing' && !voiceOn
    ? { key: 'voice', label: 'Voice typing: the ask bar’s mic', state: 'off', button: null, note: 'Run npm run build:voice once, then press Turn on.', fill: null }
    : row('voice', 'Voice typing: the ask bar’s mic', voiceOn, turnOn('speech')));
  rows.push(row('nebius', 'Nebius key: notes and replies', Boolean(status.keys?.nebius), { label: 'Add key', go: 'keys' }));
  rows.push(row('tavily', 'Tavily key: facts and names', Boolean(status.keys?.tavily), { label: 'Add key', go: 'keys' }));
  rows.push(row('yes', 'Cloud AI: finds workspaces, sorts mail, writes call notes', Boolean(status.yes?.ai) && (!status.chats || Boolean(status.yes?.chats)), { label: 'Yes', yes: true }));
  rows.push(row('mic', 'Microphone: your side of calls', granted(status, 'microphone'), turnOn('microphone')));
  const screen = row('screen', 'Screen audio: their side', granted(status, 'screen'), turnOn('screen'));
  rows.push(screenOpened && screen.state === 'off' ? { ...screen, state: 'after-reopen', button: { label: 'Reopen now', relaunch: true } } : screen);
  if (status.speech?.wanted) rows.push(speechRow(status, download), pythonRow(status));
  rows.push(row('fileVault', 'FileVault: stored mail encrypted', status.fileVault === 'on' || status.fileVault?.on === true, null, 'Turn it on in System Settings, Privacy & Security, FileVault.'));
  return rows;
}

// Settings, "Your Mac" (loggie-diagnostics): the same checks as Ready, for any install, set up through the setup page
// or not. Chats get a switch row of their own: an install that already had workspaces never saw setup's chats switch
// (2026-10-22: chats were never on, and "message leah nakaima" found no one). The cloud yes row covers the AI only;
// texts to the cloud AI are an optional row that never makes the section say something is off. States: on, off,
// optional, note, after-reopen.
export function macRows(status = {}) {
  // An install that skipped setup saved no mail app: the row reads the one Loggie uses (draft.js resolveSettings:
  // Outlook when it is installed, else Apple Mail), so Outlook's row is never missing (2026-10-22, the real Settings).
  const mailApp = status.mailApp || (status.installed?.outlook ? 'outlook' : 'apple-mail');
  const rows = readyRows({ ...status, mailApp, chats: false }).filter((row) => row.key !== 'chats');
  // The mail app can be changed here (loggie-mail-app-switch, Gio 2026-10-23: "in the setting i want a change button
  // for apple mail, gmail or outlook"); before, only setup asked, and a setup test left him on Apple Mail. Two choices
  // since 2026-10-28 (fix 2: Gmail drafts were a dead end). Apple Mail ships with macOS, so only Outlook can be missing.
  const mailRow = rows.find((row) => row.key === 'mailApp');
  if (mailRow) mailRow.change = { current: mailApp, choices: [
    { id: 'outlook', label: 'Outlook', installed: status.installed?.outlook !== false },
    { id: 'apple-mail', label: 'Apple Mail', installed: true },
  ] };
  // Voice typing: setup records the answer; with no answer recorded it is not known, so not checked yet, never Off.
  const voice = rows.findIndex((row) => row.key === 'voice');
  if (voice >= 0 && rows[voice].state === 'off' && !status.voice?.answer && status.voice?.helper !== 'missing') {
    rows[voice] = { ...rows[voice], state: 'note', note: 'Not checked on this Mac yet: Turn on asks macOS.', button: { label: 'Turn on', ask: 'speech' } };
  }
  const label = status.installed?.whatsapp ? 'Messages and WhatsApp: read and draft texts on this Mac' : 'Messages: read and draft texts on this Mac';
  const typing = granted(status, 'accessibility');
  const chats = !status.chats ? { key: 'chats', label, state: 'off', button: null, note: 'Off: Loggie cannot find anyone to text.', fill: null, toggle: false }
    : typing ? { key: 'chats', label, state: 'on', button: null, note: null, fill: null, toggle: true }
    : { key: 'chats', label, state: 'off', button: { label: 'Turn on', ask: 'accessibility' }, note: 'Accessibility is off, so a draft cannot be typed into Messages.', fill: null, toggle: true };
  // Right under mail: a missing text source is the first thing to notice.
  const under = Math.max(rows.findIndex((row) => row.key === 'mailApp'), rows.findIndex((row) => row.key === 'mail'));
  rows.splice(under >= 0 ? under + 1 : 0, 0, chats);
  if (status.chats) {
    const yes = Boolean(status.yes?.chats);
    rows.splice(rows.findIndex((row) => row.key === 'yes') + 1, 0, { key: 'textsCloud', label: 'Texts to the cloud AI: sort and summarize chats', state: yes ? 'on' : 'optional',
      button: yes ? null : { label: 'Yes', yes: 'chats' }, note: yes ? null : 'Optional: texts are read and drafted on this Mac without it.', fill: null });
  }
  if (status.helpers && Number.isFinite(status.helpers.native)) {
    const all = status.helpers.native >= status.helpers.of;
    // Not off: a helper that is missing builds itself the first time it is used (doctor.js says the same).
    rows.push({ key: 'helpers', label: `Helpers: ${status.helpers.native} of ${status.helpers.of} built (Outlook, calendar, chats, mic)`, state: all ? 'on' : 'note', button: null,
      note: all ? null : 'The rest build the first time they are used, or now with npm run build:native.', fill: null });
  }
  return rows;
}
// The line above the rows: what is off, in the words of the first off row, or that everything is on.
export function macSummary(rows = []) {
  const off = rows.filter((row) => row.state === 'off' || row.state === 'after-reopen');
  if (!off.length) return 'Everything Loggie uses is on.';
  const first = off[0];
  const what = first.label.split(':')[0];
  return `${off.length === 1 ? '1 thing is off' : `${off.length} things are off`}: ${what}.${first.note ? ` ${first.note.replace(/^Off: /, '')}` : ''}`;
}

const clockOf = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export function readyHeading(status = {}, rows = []) {
  const name = status.signName || 'there';
  const all = !rows.some((item) => item.state === 'off' || item.state === 'after-reopen');
  const took = Date.parse(status.readyAt) - Date.parse(status.startedAt);
  const words = all ? 'All set' : 'Nearly set';
  return Number.isFinite(took) && took >= 0 ? `${words} in ${clockOf(took)}, ${name}` : `${words}, ${name}`;
}
