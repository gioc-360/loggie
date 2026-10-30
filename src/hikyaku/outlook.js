// Real replies in the new Outlook. The new Outlook exposes no messages to AppleScript, so a native helper drives
// its window through macOS accessibility: find the email, verify sender and date, press Reply, audit the reply,
// paste the draft, audit the body, stop. It never sends. Anything it cannot verify comes back as a status, and
// openDraft asks the user what to do (docs/hikyaku-outlook-eval.md).
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { helperPath } from './native-helper.js';

const run = promisify(execFile);
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'native', 'outlook.swift');
const HELPER = join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-outlook');
// The pane recent macOS calls "Device Control and Data Access". Opened for the user, never described.
export const ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility';

export const REASONS = {
  'not-trusted': 'macOS has not let Loggie control Outlook yet. The Accessibility settings are open: switch on the app you ran this from, then try again.',
  'no-outlook': 'Outlook is not open, so the reply could not be threaded.',
  'not-front': 'Outlook did not stay in front, so hikyaku stopped before typing anything.',
  'no-window': 'Outlook has no open window.',
  'no-search': 'Outlook\'s search box was not where hikyaku expects it (Outlook may have changed).',
  'no-match': 'Outlook search found no email with this subject.',
  'no-verified-match': 'No email with this subject was from the right sender on the right day, so hikyaku did not guess.',
  'reply-includes-you': 'The reply opened addressed to you, so hikyaku pasted nothing and stopped. Close that reply; it was not sent.',
  'reply-wrong-recipient': 'The reply opened without the right person on its To line, so hikyaku pasted nothing and stopped. Close that reply; it was not sent.',
  'audit-forward-not-reply': 'Outlook opened a forward instead of a reply, so hikyaku pasted nothing and stopped. Close it; it was not sent.',
  'audit-subject-mismatch': 'The reply that opened belongs to a different thread, so hikyaku pasted nothing and stopped. Close it; it was not sent.',
  'reply-did-not-open': 'hikyaku found the email, but Outlook opened no reply.',
  'background-reply-did-not-open': 'hikyaku found the email, but Outlook ignored the Reply press.',
  'background-search-failed': 'Outlook did not take the search text.',
  'no-draft': 'The draft is empty.',
  timeout: 'Outlook took too long to answer, so the reply was not placed.',
  error: 'The Outlook helper failed.',
};

// The helper's source hash goes into every attempt, so a metric or a gate can tell which version made a reply.
export async function helperSha(source = SOURCE) {
  return createHash('sha1').update(await readFile(source).catch(() => '')).digest('hex').slice(0, 12);
}

// Built ahead (main.js at launch), so no reply waits on a build after outlook.swift changes.
export const ensureOutlookHelper = (options = {}) => helperPath({ name: 'outlook', source: SOURCE, devHelper: HELPER, ...options });

export async function outlookReply({ original, body, me = '', dryRun = false, execImpl = run, helper, writeBody, expectFile = null, snapshotDir = null, timeoutMs = 60000, inline = false } = {}) {
  const binary = helper || await ensureOutlookHelper({ execImpl });
  const args = ['reply', '--sender', original.from, '--subject', original.subject || ''];
  if (original.date) args.push('--date', original.date);
  if (me) args.push('--me', me);
  // What the reply must look like (To, Cc, the user's addresses), written by draft.js; and where the helper saves
  // the copies of the tree it decided on, so a wrong reply can be replayed offline.
  if (expectFile) args.push('--expect', expectFile);
  if (snapshotDir) args.push('--snapshot-dir', snapshotDir);
  // Find and verify in the background; Outlook comes forward only for the Reply press and the paste (about 2-3 s),
  // then the user's app gets the front back. The new Outlook will not reply while hidden (measured 2026-10-03).
  args.push('--background');
  // The checked reply pops out into its own window unless settings.json "replyWindow" is "inline" (draft.js).
  if (inline) args.push('--inline');
  if (dryRun) args.push('--dry-run');
  else args.push('--body-file', await writeBody(body));
  // The version goes into every attempt: when Outlook updates and the helper stops finding things, the log shows when.
  const outlookVersion = await execImpl('/usr/bin/defaults', ['read', '/Applications/Microsoft Outlook.app/Contents/Info', 'CFBundleShortVersionString'])
    .then(({ stdout }) => stdout.trim(), () => null);
  const sha = await helperSha();
  try {
    // timeoutMs kills the helper itself (execFile timeout), so a reply that is too slow never lands after the floor (C4b).
    const { stdout } = await execImpl(binary, args, { timeout: timeoutMs });
    return { ...JSON.parse(stdout.trim().split('\n').at(-1)), outlookVersion, helperSha: sha };
  } catch (error) {
    return { status: 'error', detail: String(error.stderr || error.message).trim().split('\n')[0], outlookVersion, helperSha: sha };
  }
}

// Always opens: this runs only when the user asked for a draft just now, so the pane is the answer to their action.
export function openAccessibilitySettings(spawnImpl = spawn) {
  const child = spawnImpl('open', [ACCESSIBILITY_SETTINGS], { detached: true, stdio: 'ignore' });
  child.unref?.();
}
