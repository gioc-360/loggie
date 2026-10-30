// The screen and the yes before the five raw-mail paths reach the cloud (cloud-first C2b, plan section 5): mail
// catch-up, chats catch-up, finding new workstreams, sorting new mail, and the intros and texting style. Every prompt
// those paths build goes through screenText() on this Mac, code only (no model), and the cloud router takes nothing
// else: thinkWith() is the one function that makes a `complete` for them, and the one place forCloud() is called.
// test/hikyaku-cloud-screen.test.js scans the source for any other way in.
//   screenText   addresses, links and phone numbers are cut from every sentence ("[address kept on this Mac]", as
//                privacy.py clean_body cuts them); a sentence the code layer flags is replaced whole by
//                "[<category> kept on this Mac]", the marker hold-line.js and privacy.py write. The code layer is
//                sensitive.js's rules plus the money identifiers of the transcriber's word lists (wordlists.py, C1),
//                ported here: card numbers (Luhn), IBANs, account and routing numbers, SSN and tax ids, a password
//                with its value. No health list is ported: C1's lists held 1 of 10 health lines, so the yes screen
//                says health lines are not checked on this Mac (plan 4.4, edit 3; C6). The health holds sensitive.js
//                already makes stay, and none is added that would claim more.
//   consentFor   the yes, read from settings.json and workstreams.json, never asked for here (C6 builds the screens):
//                mail: the workstream's cloud field is "nebius"; chats: settings.chatsCloud is "nebius"; discover,
//                triage, style, rank: settings.cloudYes.<path> is true. Absent is no. rank (priorities.js) orders
//                the workstreams from their summaries and open moves, under the same yes card as discover.
//   thinkWith    local: the plain prompt, as before, no screen. Cloud without a yes: null, and one plain line in the
//                log, once; the caller then does nothing, as when there is nothing to do. Cloud with a yes: the
//                screened text, wrapped by forCloud with the screen and the yes named.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codeScreen } from './sensitive.js';
import { createThinker, forCloud } from './thinker.js';

export const CLOUD_PROVIDER = 'nebius';
export const CLOUD_PATHS = Object.freeze(['mail', 'chats', 'discover', 'triage', 'style', 'rank', 'box', 'ask', 'names', 'assistant', 'errands']);
export const mark = (category) => `[${category} kept on this Mac]`;

// Inline cuts: links and addresses before the rules (as privacy.py cuts them), phone numbers after, from the sentences
// that go. A phone number is what the cloud gate's exit check calls one (cloud.js): 7 to 15 digits with the usual
// separators or none, since a chat handle is +15550100 with no separator at all. A date is not one. The rules run
// first so that an account number, a card or an SSN holds its sentence under its own name, not as a phone number.
const URL_IN = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]*[^\s<>"')\].,;:!?]/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?<!\w)\+?\d[\d\s().-]{5,18}\d(?!\w)/g;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2})?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const isPhone = (run) => { const digits = run.replace(/\D/g, ''); return digits.length >= 7 && digits.length <= 15 && !DATE.test(run.trim()); };

// wordlists.py's money identifiers. Card numbers are sensitive.js's own "card" rule (the Luhn check), run first.
// JS has no inline case flag, so the whole account rule and the PIN of the password rule read case-insensitively
// where Python reads only the first word so; wider, never narrower.
const DIGITS = '(?:\\d[ -]?){5,}';
const SECRET_WORD = '(?:password|passcode|passphrase|pin|pin code|pin number)';
const NOT_A_VALUE = '(?:required|reset|resets|manager|managers|policy|policies|expired|expires|wrong|incorrect|correct|changed|change|too|not|strong|weak|protected|field|screen|prompt|flow|page|rule|rules|link|email|emails|check|checks|issue|issues|problem|problems|there|here|a|an|the|for|in|on|and|or|but|so|because)';
const MONEY_IDS = Object.freeze([
  ['wl-iban', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/],
  ['wl-account', new RegExp(`\\b(?:account|acct|routing|aba|swift|sort code)\\b(?:\\W+(?:number|no|num|#))?\\W+(?:is |was )?${DIGITS}`, 'i')],
  ['wl-tax-id', /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|\b(?:ssn|social security(?: number)?|tax id|taxpayer id|itin|ein|tin)\b\W+(?:is |was |number )?(?:\d[ -]?){8,}/i],
  ['wl-password', new RegExp(`\\b(?:my|his|her|their|your|the|new|temporary|wifi|wi-fi|login|admin)\\s+${SECRET_WORD}(?:\\s+(?:is|was|will be|:|=)\\s*|\\s*[:=]\\s*)(?!${NOT_A_VALUE}\\b)\\S+`, 'i')],
]);

// The code layer on one sentence: sensitive.js's rules first (steering, grades, identity, money, health, a third
// party, confidential), then the ported money identifiers. First hit wins.
function codeHit(sentence) {
  const hit = codeScreen({ text: sentence });
  if (hit) return { category: hit.category, rule: hit.rule };
  for (const [rule, test] of MONEY_IDS) if (test.test(sentence)) return { category: 'money', rule };
  return null;
}

// One prompt, screened: { text, held: [{ index, category, rule }] }, index counting sentences through the text.
// Line breaks stay (a prompt's tags and lists are lines); sentences split on . ! ? inside a line.
export function screenText(text) {
  const held = [];
  let index = 0;
  const lines = String(text).split('\n').map((line) => line.split(/(?<=[.!?])\s+(?=\S)/).map((piece) => {
    const i = index++;
    const cut = piece.replace(URL_IN, mark('link')).replace(EMAIL, mark('address'));
    const hit = codeHit(cut);
    if (!hit) return cut.replace(PHONE, (run) => (isPhone(run) ? mark('phone') : run));
    held.push({ index: i, ...hit });
    return mark(hit.category);
  }).join(' '));
  return { text: lines.join('\n'), held };
}

// The yes for one path, as a plain name of where it was read, or null. Read only; nothing here asks.
// 'box' is the ask box's email reply (ask-run.js): "Always for replies" saves settings.cloudYes.box; "Yes, this time"
// is `once`, good for that one reply and never saved.
export function consentFor(path, { settings = {}, workstream = null, once = false } = {}) {
  if (!CLOUD_PATHS.includes(path)) throw new Error(`Loggie has no cloud path named "${path}".`);
  if (path === 'mail') return workstream?.cloud === CLOUD_PROVIDER ? `workstream "${workstream.name}" approved for ${CLOUD_PROVIDER}` : null;
  if (path === 'chats') return settings.chatsCloud === CLOUD_PROVIDER ? `settings.chatsCloud is ${CLOUD_PROVIDER}` : null;
  if (path === 'box') return settings.cloudYes?.box === true ? 'settings.cloudYes.box' : once === true ? 'ask box: yes for this one reply' : null;
  // 'ask': a sentence the box's code could not read; only the sentence goes (ask-cloud.js).
  if (path === 'ask') return settings.cloudYes?.ask === true ? 'settings.cloudYes.ask' : once === true ? 'ask box: yes for this one sentence' : null;
  // 'names': a call's unclear words (name-check.js), only right after the user's yes on that call's summary, which the
  // yes card says covers them; never saved as a standing yes.
  if (path === 'names') return once === true ? "the call's yes (its card says names are checked too)" : null;
  // 'assistant': a question answered from the user's email and calendar (desktop/assistant-service.js); the matching
  // emails and events go, screened. Yes this time from the ask box, or always (settings.cloudYes.assistant).
  if (path === 'assistant') return settings.cloudYes?.assistant === true ? 'settings.cloudYes.assistant' : once === true ? 'ask box: yes for this one question' : null;
  // 'errands': the user's own next steps a web search can do (look-outside.js runErrands), only right after the user's
  // yes on that call's summary, which the yes card says covers them; never saved as a standing yes.
  if (path === 'errands') return once === true ? "the call's yes (its card says your web steps are checked too)" : null;
  return settings.cloudYes?.[path] === true ? `settings.cloudYes.${path}` : null;
}

// The yes screen's "Yes" for sorting new mail, finding workstreams and reading their mail, ordering them and learning
// the user's style: settings.cloudYes gets the four paths and `found` set to true, merged into what is there, and no
// other setting is touched. `found` is no path of its own: discover.js writes each card it finds with cloud "nebius",
// the same approval a yes on the card gives. Cards there before the yes keep their own.
// The file is read and written raw (readSettings would add its defaults). Chats and a workstream's mail have their own yes (cloud.js setCloud).
// The same Yes covers call notes (first-run-polish B5.4): `calls` true, and `callsAt` the first time only, so a call
// prepared before the yes is never summarized on its own (send-gate.js autoDecide reads both through main's standing).
export async function grantCloudYes(home, { now = new Date() } = {}) {
  return changeCloudYes(home, (yes) => ({ ...yes, discover: true, triage: true, style: true, rank: true, found: true, ...callsYes(yes, now) }));
}
const callsYes = (yes, now) => ({ calls: true, ...(yes.calls === true ? {} : { callsAt: now.toISOString() }) });
// The Today card for call notes on an install whose yes came before B5.4: Yes is grantCalls, Not now is laterCalls.
// Either answer sets callsAsked, so the card never shows again.
export async function grantCalls(home, { now = new Date() } = {}) {
  return changeCloudYes(home, (yes) => ({ ...yes, ...callsYes(yes, now), callsAsked: true }));
}
export async function laterCalls(home) {
  return changeCloudYes(home, (yes) => ({ ...yes, callsAsked: true }));
}
async function changeCloudYes(home, change) {
  const file = join(home, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(file, 'utf8')); } catch { settings = {}; }
  settings.cloudYes = change(settings.cloudYes || {});
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return settings.cloudYes;
}

// The `complete` a raw-mail path runs with, or null when the cloud has no yes for it. `what` is the plain name of
// what would be read ("your new mail"), said once per run of the app, and then `onNeedYes(path)` is called once so the
// panel can ask for the yes (C6). `options` go to the router (a fake client, a fake local model in tests).
const said = new Set();
export function thinkWith({ settings = {}, maxTokens, consent = null, what, path = null, onNeedYes = () => {}, log = console.log, ...options }) {
  // `label` names the path on the cloud AI's usage log (usage.js), so the day's total can say what it was spent on.
  const thinker = createThinker({ settings, label: path || 'other', ...options });
  if (!consent) {
    if (!said.has(what)) { said.add(what); log(`Loggie needs your yes before it reads ${what} with the cloud AI.`); onNeedYes(path); }
    return null;
  }
  return (prompt) => thinker.complete(forCloud(screenText(prompt).text, { screenedBy: 'code', consent }), { maxTokens });
}
