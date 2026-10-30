import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// hikyaku never sends. The Outlook helper is the one piece of code that drives a mail window, so its source is
// checked directly: the only keys it may post are Cmd+R (Reply), Cmd+V (paste) and typed search text, and nothing
// it presses or looks for may be named Send. Return (36) and keypad Enter (76) would send a reply; so would
// Cmd+Return.
const ALLOWED_KEYS = new Map([[0, 'typed text (unicode string)'], [9, 'V, for Cmd+V paste'], [15, 'R, for Cmd+R reply']]);

export function sendRisks(source) {
  const risks = [];
  for (const match of source.matchAll(/virtualKey:\s*(\d+)/g)) {
    const key = Number(match[1]);
    if (!ALLOWED_KEYS.has(key)) risks.push(`posts key ${key}`);
  }
  if (/kVK_Return|kVK_ANSI_KeypadEnter|keyCode\s*[:=]\s*(36|76)\b/.test(source)) risks.push('names Return or Enter');
  // Any string literal mentioning send, other than the word sender and the helper's own messages and comments.
  for (const line of source.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*(emit|note)\(|FileHandle\.standardError/.test(code)) continue;
    for (const literal of code.match(/"[^"]*"/g) || []) {
      if (/send(?!er)/i.test(literal)) risks.push(`looks for ${literal}`);
    }
  }
  if (/AXUIElementPerformAction\([^)]*[Ss]end/.test(source)) risks.push('presses something named send');
  return risks;
}

test('the Outlook helper cannot press Send or post Return', async () => {
  const source = await readFile(new URL('../src/hikyaku/native/outlook.swift', import.meta.url), 'utf8');
  assert.deepEqual(sendRisks(source), []);
  assert.ok(/virtualKey: 9/.test(source) && /virtualKey: 15/.test(source), 'the check is reading the real helper');
});

test('the check fails on a helper that could send', () => {
  const safe = 'let e = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: down)\nemit("replied", "Nothing was sent.")';
  assert.deepEqual(sendRisks(safe), []);
  assert.deepEqual(sendRisks(`${safe}\nlet r = CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: true)`), ['posts key 36']);
  assert.deepEqual(sendRisks(`${safe}\nlet b = find(window) { identifier($0) == "sendButton" }`), ['looks for "sendButton"']);
  assert.deepEqual(sendRisks(`${safe}\nlet m = menuItem(titled: "Send")`), ['looks for "Send"']);
});

test('the Outlook helper is told the user\'s own address, and a reply to the user is refused, never pasted', async () => {
  const { outlookReply, REASONS } = await import('../src/hikyaku/outlook.js');
  const { readFile } = await import('node:fs/promises');
  let seen = null;
  const execImpl = async (file, args) => { if (file === '/usr/bin/defaults') return { stdout: '16.1\n' }; seen = args; return { stdout: '{"status":"reply-includes-you","detail":"x"}\n' }; };
  const result = await outlookReply({ original: { from: 'sam@example.com', subject: 'Deck', date: '2026-10-04T12:00:00Z' }, body: 'Hi', me: 'lena@school.edu', helper: '/h', execImpl, writeBody: async () => '/tmp/b' });
  assert.deepEqual(seen.slice(seen.indexOf('--me'), seen.indexOf('--me') + 2), ['--me', 'lena@school.edu']);
  assert.equal(result.status, 'reply-includes-you'); assert.match(REASONS['reply-includes-you'], /addressed to you/);
  const swift = await readFile(new URL('../src/hikyaku/native/outlook.swift', import.meta.url), 'utf8');
  assert.match(swift, /finding\("reply-includes-you", [^\n]*stop: true\)/, 'a reply addressed to the user is a stop finding');
  assert.match(swift, /finding\("reply-wrong-recipient", [^\n]*stop: true\)/, 'a reply without the person on To is a stop finding');
  assert.match(swift, /messageHeaderContextualControlsReplyAllButton/, 'the user\'s own message is answered with Reply all');
  const stopAt = swift.indexOf('if let stop = findings.first(where: { $0["severity"] == "stop" })');
  assert.ok(stopAt > 0 && stopAt < swift.indexOf('// --- 6. focus the reply body and paste the draft'), 'stop findings end the run before the paste');
  assert.ok(swift.indexOf('auditBeforePaste(pre, expect') < stopAt, 'the recipients are audited before that stop');
});

// The Gmail client and its draft file left with the Gmail sign-in (2026-10-28); what places a draft now, in Outlook or
// Apple Mail, is held to the same rule, and the Gmail files must not come back.
test('nothing that places a draft can send: no send endpoint, no send method, and no Gmail client', async () => {
  for (const file of ['../src/hikyaku/draft.js', '../src/hikyaku/apple-mail-reply.js', '../src/hikyaku/outlook.js']) {
    const source = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\/send\b|messages\.send|drafts\.send|sendMessage|sendDraft|async send\w*\(/i, `${file} must have no way to send`);
  }
  for (const file of ['../src/integrations/gmail/client.js', '../src/hikyaku/gmail-draft.js']) {
    await assert.rejects(readFile(new URL(file, import.meta.url), 'utf8'), { code: 'ENOENT' }, `${file} is gone`);
  }
});

// The chat helper reads two databases and two windows; the only thing it may ever set is a message box's text, and
// the only actions it may perform are opening a chat row and scrolling the chat list. No key is posted, nothing
// named send is pressed or looked for, and no AppleScript drives Messages. The JS side may open one link with
// "send" in it, whatsapp://send, which only opens a composer.
export function chatHelperRisks(source) {
  const risks = [];
  if (/CGEvent|virtualKey|keyCode|kVK_|CGEventPost|keyDown/.test(source)) risks.push('posts keys');
  if (/osascript|NSAppleScript|tell application/i.test(source)) risks.push('scripts an app');
  for (const match of source.matchAll(/AXUIElementPerformAction\(([^,]+),\s*([^)]+)\)/g)) {
    const action = match[2].trim();
    if (!['kAXPressAction as CFString', '"AXScrollDownByPage" as CFString', '"AXScrollUpByPage" as CFString', '"AXScrollToVisible" as CFString'].includes(action)) risks.push(`performs ${action}`);
  }
  for (const match of source.matchAll(/AXUIElementSetAttributeValue\([^,]+,\s*([^,]+),/g)) {
    const attribute = match[1].trim();
    if (!['kAXValueAttribute as CFString', '"AXSelectedChildren" as CFString'].includes(attribute)) risks.push(`sets ${attribute}`);
  }
  for (const line of source.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    // Sentences for the person (printJSON, fail) may say "nothing was sent"; the guard that refuses anything named send is the guard.
    if (/printJSON\(|fail\(|safeToAct|!words\.contains\("send"\)/.test(code)) continue;
    for (const literal of code.match(/"[^"]*"/g) || []) if (/send(?!er)/i.test(literal)) risks.push(`looks for ${literal}`);
  }
  return risks;
}

test('the chat helper cannot send: no keys, no scripting, only a row press, a list scroll and a text box value', async () => {
  const source = await readFile(new URL('../src/hikyaku/native/chats.swift', import.meta.url), 'utf8');
  assert.deepEqual(chatHelperRisks(source), []);
  assert.match(source, /SQLITE_OPEN_READONLY/, 'Messages is opened read-only');
  assert.match(source, /copyItem\(atPath: WHATSAPP_DB/, 'WhatsApp is read from a copy');
  assert.match(source, /guard safeToAct\(row\)/, 'the row is checked before it is pressed');
  assert.ok(source.indexOf('guard header != nil') < source.indexOf('AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, body'), 'the header is verified before any text is set');
  assert.ok(source.indexOf('composer-not-empty') < source.indexOf('AXUIElementSetAttributeValue(box, kAXValueAttribute as CFString, body'), 'a box with text is never overwritten');
  assert.deepEqual(chatHelperRisks('AXUIElementPerformAction(b, kAXPressAction as CFString)\nlet e = CGEvent(keyboardEventSource: s, virtualKey: 36, keyDown: true)'), ['posts keys']);
  assert.deepEqual(chatHelperRisks('AXUIElementPerformAction(b, "AXConfirm" as CFString)'), ['performs "AXConfirm" as CFString']);
  assert.deepEqual(chatHelperRisks('let b = byId(w, "ChatBar_SendButton")'), ['looks for "ChatBar_SendButton"']);
  assert.ok(chatHelperRisks('tell application "Messages" to activate').includes('scripts an app'));
});

test('nothing on the JS side of chats can send: no AppleScript, no keystrokes, and the only "send" URL is whatsapp://send, which opens a composer', async () => {
  // Comments go, but not the // inside a URL.
  const source = (await readFile(new URL('../src/hikyaku/chats.js', import.meta.url), 'utf8')).replace(/(^|\s)\/\/.*$/gm, '');
  assert.doesNotMatch(source, /osascript|tell application|keystroke|key code|CGEvent|\.send\(|sendMessage|sendText|imessage:\/\/|sms:\/\/[^&]*send/i);
  const sendUrls = [...source.matchAll(/["'`][^"'`]*send[^"'`]*["'`]/gi)].map((match) => match[0]).filter((literal) => /:\/\//.test(literal));
  assert.deepEqual(sendUrls, ['`whatsapp://send?phone=${digits}&text=${encodeURIComponent(text)}`']);
  const draft = (await readFile(new URL('../src/hikyaku/draft.js', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(draft, /osascript|keystroke|CGEvent/i);
});
