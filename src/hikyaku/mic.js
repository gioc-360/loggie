// The app-in-meeting signal (spec-c.md B13): which apps hold the microphone, reduced to the meeting apps among them.
// micOwners runs the native helper (it lists processes, it reads no audio); the rest is pure.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { helperPath } from './native-helper.js';

const run = promisify(execFile);
export const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'native', 'mic.swift');
export const HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-mic');
export const HOLD_S = 10;   // an app must hold the mic this long before it is offered: a quick permission check is not a call

export const MEETING_APPS = {
  'us.zoom.xos': 'Zoom', 'com.microsoft.teams2': 'Teams', 'com.microsoft.teams': 'Teams', 'com.cisco.webexmeetingsapp': 'Webex',
  'com.google.Chrome': 'Chrome', 'com.apple.Safari': 'Safari', 'org.mozilla.firefox': 'Firefox', 'com.microsoft.edgemac': 'Edge',
  'company.thebrowser.Browser': 'Arc', 'com.brave.Browser': 'Brave', 'com.tinyspeck.slackmacgap': 'Slack', 'com.apple.FaceTime': 'FaceTime',
};
// Dictation listens through the mic too; it is never a call.
export const IGNORE = new Set(['com.apple.CoreSpeech']);

// { at, using_mic: [{bundle, pid}] }; a helper that is missing or fails throws a plain message (as calendar.js does).
export async function micOwners({ execImpl = run, helper } = {}) {
  try {
    const binary = helper || await helperPath({ name: 'mic', source: SOURCE, devHelper: HELPER, execImpl });
    const { stdout } = await execImpl(binary, [], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(String(error.stderr || error.message).trim());
  }
}

// Allow list only. The recorder's own pid is ignored (it has no bundle id, and would be ignored for that too).
export function meetingApps(owners, { ignorePids = [] } = {}) {
  const apps = [];
  for (const { bundle, pid } of owners?.using_mic || []) {
    if (!bundle || IGNORE.has(bundle) || ignorePids.includes(pid) || !MEETING_APPS[bundle]) continue;
    if (!apps.some((app) => app.bundle === bundle)) apps.push({ bundle, label: MEETING_APPS[bundle], pid });
  }
  return apps;
}

// `seen` is the caller's Map, one entry per app: { since, label, held }. held: every app on the mic now, with the first
// poll it was seen. released: every app that was held and is gone now, with the first poll it was gone; it stays
// listed until it holds the mic again.
export function appSignal({ apps, now, seen }) {
  const at = new Date(now).toISOString();
  const present = new Set(apps.map((app) => app.bundle));
  for (const app of apps) {
    const entry = seen.get(app.bundle);
    if (!entry || !entry.held) seen.set(app.bundle, { since: at, label: app.label, held: true });
  }
  for (const [bundle, entry] of seen) if (!present.has(bundle) && entry.held) seen.set(bundle, { since: at, label: entry.label, held: false });
  const pick = (held) => [...seen].filter(([, entry]) => entry.held === held).map(([bundle, entry]) => ({ bundle, label: entry.label, since: entry.since }));
  return { held: pick(true), released: pick(false) };
}
