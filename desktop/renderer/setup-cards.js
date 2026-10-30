// The setup cards (cloud-first C6): a permission an action needs, and the cloud yes. Pure, like meeting-cards.js: the
// panel draws what these return and the tests need neither a DOM nor Electron. Plain words, no AI named.
// The sentence the plan's WL1 fallback (4.4, edit 3) puts on every cloud yes: no health word list passed the test,
// so the screen says what it does not do, and no stronger claim is made anywhere.
export const HEALTH_LINE = 'Health lines are not checked on this Mac.';

// The same shape as meeting-cards.js actionFor (one IPC call as data), kept here so the two files do not import each other.
const actionFor = (method, ...args) => ({ method, args });

const HEADINGS = {
  calendar: 'Allow Calendar', fullDisk: 'Allow Full Disk Access', microphone: 'Allow the microphone',
  screen: 'Allow screen recording', accessibility: 'Allow Accessibility', automation: 'Allow Mail control',
};

export function setupCard({ data }) {
  return {
    key: `setup:${data.permission}`, kind: 'setup', heading: HEADINGS[data.permission] || 'Allow access', why: data.why,
    buttons: [
      { label: 'Open Settings', primary: true, action: actionFor('setupAnswer', data.permission, 'open') },
      { label: 'Not now', action: actionFor('setupAnswer', data.permission, 'later') },
    ],
  };
}

export const CLOUD_YES = {
  ai: 'Let Loggie send screened mail and call transcripts to Nemotron, to find your workspaces, sort new mail, write your call notes and learn how you write?',
  chats: 'Let Loggie use the cloud AI to read your chats?',
  // An install whose yes came before call notes wrote themselves (first-run-polish B5.4): asked once, on Today.
  calls: 'Write call notes on their own after each call?',
};
// The setup page's Keys step shows the two asks together, so the chats ask is short there; Today's card keeps
// CLOUD_YES.chats, since it stands alone as that card's heading.
export const SETUP_YES = Object.freeze({ ai: CLOUD_YES.ai, chats: 'And your chats?' });

export function cloudYesCard(group) {
  return {
    key: `cloud-yes:${group}`, kind: 'cloud-yes', heading: CLOUD_YES[group],
    body: 'Only text screened on this Mac leaves it.', note: HEALTH_LINE,
    buttons: [
      { label: 'Yes', primary: true, action: actionFor('cloudYesAnswer', group, 'yes') },
      { label: 'Not now', action: actionFor('cloudYesAnswer', group, 'later') },
    ],
  };
}

// The speech download (speech-download.js, plan 4.1): one card, drawn again on every progress event, gone at ready. It
// has no buttons because there is nothing to press: email and calendar work while it runs.
const megabytes = (bytes) => Math.round(bytes / 1e6);
export function downloadCard({ done_bytes: done, total_bytes: total, state }) {
  if (state === 'paused') return { key: 'setup:download', kind: 'download', heading: 'Meeting transcription is paused.', body: 'Loggie will try again. Email and calendar work now.', buttons: [] };
  return { key: 'setup:download', kind: 'download', heading: 'Getting meeting transcription ready', body: `(${megabytes(done)} of ${megabytes(total)} MB). Email and calendar work now.`, buttons: [] };
}
