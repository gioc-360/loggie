// A reply in Apple Mail, on the email it answers, in that email's thread (workspaces-outlook W11). Mail's own Reply on
// the exact message, then the draft is pasted at the top of the reply (Cmd+V, the clipboard holding it), read back
// through Accessibility. It never sends: the script has no send command (test/hikyaku-apple-mail-reply.test.js checks),
// and the user presses Send in Mail.
//
// Why a paste and not Mail's own scripting: a reply's `content` reads empty to a script while its window shows the
// quoted email, and writing `content` (or making a paragraph in it) replaces the whole body, quote and all (measured
// 2026-10-17 on "Re: Class recording | Financial modeling"). A paste keeps the quote. It needs Accessibility, which the
// Outlook helper needs too, and Mail in front: the script checks that Mail and this reply are in front before Cmd+V.
//
// Finding the email: the Envelope Index row (sent-mail.js findInboxMessage, read only) names its account, its Inbox
// and its Message-ID. Mail's message `id` is that row's ROWID (found in 1.3 s in an 11,000-message Inbox), so the
// script asks the Inbox for it, and for the Message-ID only if that fails. Before anything is pasted, the reply's To
// line must hold the person; if not, the reply is closed unsaved. macOS asks once whether Loggie may control Mail.
import { execFile } from 'node:child_process';
import { findInboxMessage, mailAddresses } from './sent-mail.js';

export const APPLE_MAIL_TIMEOUT_MS = 20000;

export const APPLE_MAIL_REASONS = {
  'no-match': 'Apple Mail has no copy of the email this answers in your Inbox, so Loggie did not guess.',
  'reply-wrong-recipient': 'The reply Mail opened was not addressed to the person, so Loggie put nothing in it and closed it. Nothing was sent.',
  'not-trusted': 'macOS has not let Loggie control Mail yet. The Automation settings are open: under the app you run Loggie from, switch on Mail, then try again.',
  'not-trusted-paste': 'macOS has not let Loggie type into Mail yet. The Accessibility settings are open: switch on the app you run Loggie from, then try again.',
  timeout: 'Apple Mail took longer than 20 seconds to find the email.',
  error: 'Apple Mail could not open the reply.',
};

// Arguments: account id, Inbox path ("Inbox", "INBOX"), Mail's message id (the ROWID), the Message-ID without
// brackets, the person's address. The draft is already on the clipboard.
export const SCRIPT = `on run argv
	set acctId to item 1 of argv
	set boxPath to item 2 of argv
	set rowId to (item 3 of argv) as integer
	set headerId to item 4 of argv
	set wantTo to item 5 of argv
	tell application "Mail"
		set acct to first account whose id is acctId
		set mbox to acct
		set AppleScript's text item delimiters to "/"
		set parts to text items of boxPath
		set AppleScript's text item delimiters to ""
		repeat with part in parts
			set mbox to mailbox (part as text) of mbox
		end repeat
		set found to missing value
		try
			set found to first message of mbox whose id is rowId
		end try
		if found is missing value and headerId is not "" then
			try
				set found to first message of mbox whose message id is headerId
			end try
		end if
		if found is missing value then return "no-match"
		set theReply to reply found with opening window
		set replySubject to subject of theReply
		set addressed to false
		repeat with who in (to recipients of theReply)
			ignoring case
				if ((address of who) as text) is wantTo then set addressed to true
			end ignoring
		end repeat
		if not addressed then
			try
				close (first window whose name is replySubject) saving no
			end try
			return "reply-wrong-recipient"
		end if
		delay 1
		activate
		set index of (first window whose name is replySubject) to 1
	end tell
	delay 0.5
	tell application "System Events"
		set frontApp to name of first application process whose frontmost is true
		if frontApp is not "Mail" then return "reply-open-draft-on-clipboard"
		set frontName to name of front window of process "Mail"
		if frontName is not replySubject then return "reply-open-draft-on-clipboard"
		keystroke "v" using command down
	end tell
	return "pasted"
end run`;

// Read-only: the first lines of the reply's body, through Accessibility, stopping once enough is read (a whole walk
// took 12 s on a long thread). -> the text, or '' when the window or its body is not found.
export const READ_BACK = `function run(argv) {
  const want = argv[0];
  const mail = Application('System Events').processes.byName('Mail');
  const win = mail.windows().find((w) => w.name() === want);
  if (!win) return '';
  const lines = [];
  let web = null;
  const find = (el, depth) => { if (web || depth > 9) return; let role = ''; try { role = el.role(); } catch (e) {} if (role === 'AXWebArea') { web = el; return; } let kids = []; try { kids = el.uiElements(); } catch (e) {} for (const k of kids) find(k, depth + 1); };
  find(win, 0);
  if (!web) return '';
  const read = (el, depth) => { if (lines.length >= 6 || depth > 12) return; let v = null; try { if (el.role() === 'AXStaticText') v = el.value(); } catch (e) {} if (v) lines.push(String(v)); let kids = []; try { kids = el.uiElements(); } catch (e) {} for (const k of kids) read(k, depth + 1); };
  read(web, 0);
  return lines.join('\\n');
}`;

const STATUSES = new Set(['pasted', 'reply-open-draft-on-clipboard', 'reply-wrong-recipient', 'no-match']);

function osascript(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout = '', stderr = '') => {
      resolve({ error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const runScript = (args, timeoutMs) => osascript(['-e', SCRIPT, ...args], timeoutMs);
const readBackScript = (subject, timeoutMs) => osascript(['-l', 'JavaScript', '-e', READ_BACK, subject], timeoutMs);

// -> { status, detail? }: replied | reply-open-draft-on-clipboard | reply-wrong-recipient | no-match | not-trusted |
// timeout | error | dry-run. `own` is the user's addresses; every Apple Mail account is added so the email is found in
// whichever account it reached. `copy` puts the draft on the clipboard before the script runs (the paste uses it, and
// the user can paste it by hand when anything stops short).
export async function appleMailReply({ original = {}, body = '', own = [], copy, dryRun = false, timeoutMs = APPLE_MAIL_TIMEOUT_MS,
  find = findInboxMessage, accounts = mailAddresses, run = runScript, readBack = readBackScript } = {}) {
  const address = [...new Set([...own, ...(await accounts().catch(() => []))].map((item) => String(item || '').toLowerCase()).filter(Boolean))];
  let located;
  try {
    located = await find({ address, from: original.from, subject: original.subject, date: original.date, rowId: original.rowId });
  } catch (error) { return { status: 'error', detail: error.message }; }
  if (!located) return { status: 'no-match' };
  if (dryRun) return { status: 'dry-run', detail: `Would open Mail's reply on the email in ${located.mailbox}, paste the draft at its top, and send nothing.` };
  await copy(body);
  const { error, stdout, stderr } = await run([located.accountId, located.mailbox, String(located.rowId), located.header || '', String(original.from || '').toLowerCase()], timeoutMs);
  const said = stdout.trim();
  const trouble = `${stderr} ${error?.message || ''}`;
  if (/-1743|not authori[sz]ed to send apple events/i.test(trouble)) return { status: 'not-trusted', pane: 'automation' };
  if (/-1719|-25211|assistive access|not allowed to send keystrokes/i.test(trouble)) return { status: 'not-trusted', pane: 'accessibility' };
  if (error?.killed || error?.signal === 'SIGTERM') return { status: 'timeout' };
  if (!STATUSES.has(said)) return { status: 'error', detail: (stderr || error?.message || said || '').trim().split('\n')[0] };
  if (said !== 'pasted') return { status: said };
  // Read back: the draft's first line first, and the quoted email still under it.
  const subject = /^re:/i.test(String(original.subject || '')) ? String(original.subject) : `Re: ${original.subject || ''}`;
  const firstLine = String(body).split('\n').map((line) => line.trim()).find(Boolean) || '';
  const back = await readBack(subject, 8000).then((result) => String(result.stdout || '')).catch(() => '');
  const first = back.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const head = firstLine.slice(0, 60);
  if (first && head && (first.startsWith(head) || firstLine.startsWith(first.slice(0, 60)))) return { status: 'replied' };
  // The draft is there with something before it: typing that reached Mail as it came forward (2026-10-17: "com" landed
  // before the draft). The reply opens; the user is told to check its top before sending.
  if (first && head && first.includes(head)) return { status: 'replied', finding: `Something else was typed at the top of the reply as Mail came forward ("${first.slice(0, first.indexOf(head)).slice(0, 40)}"). Delete it before sending.` };
  return { status: 'reply-open-draft-on-clipboard' };
}
