// A home for what the router could not place (loggie-do-it-context cycle 2, TC1 2026-10-11: "Nebius suggests, I tap
// once"). The router files only on proof (router.js); a text from someone new, like a recruiter's colleague writing
// "Hit me up Sunday evening", has none, so it was dropped without a trace and its follow-up never reached a card.
//
// Here the cloud AI reads those items, with each workstream's name, goal and summary, and names at most one workstream
// per item, with the exact words that show it. Code then checks the words are really in the item and the workstream
// really exists; anything else is no suggestion. A suggestion files nothing: it makes the item unsure with that one
// candidate, so the existing ask (screen-data.js answerAsk) asks once, and a yes saves the person to the workstream,
// after which the router files them itself and nothing is asked again.
import { screenText } from './cloud-screen.js';
import { BIG_CHAT, MACHINE } from './router.js';
import { localDay } from './util.js';

export const MAX_SUGGEST = 20;
const TEXT_CHARS = 1200;
const CHAT_SOURCES = new Set(['messages', 'whatsapp']);
const SOURCE_WORD = { messages: 'Text message', whatsapp: 'WhatsApp message', outlook: 'Email', gmail: 'Email' };

const flat = (value) => String(value || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const plain = (value) => flat(value).toLowerCase().replace(/^[\s"'.,!?:;-]+|[\s"'.,!?:;-]+$/g, '');

// A chat's newest words: whole messages from the newest back, while they fit in `max` characters; the newest is
// always whole. 2026-10-23: the sort kept the FIRST 1,200 characters of a week of texts, so Renée's 10-21 ask to help
// prep for a company interview (from character 1,103, after older jokes and a Venmo) was cut and the chat answered null.
export function newestWords(lines, max = TEXT_CHARS) {
  const kept = [];
  let size = -1;
  for (const line of [...(lines || [])].map(flat).filter(Boolean).reverse()) {
    if (kept.length && size + 1 + line.length > max) break;
    kept.unshift(line);
    size += 1 + line.length;
  }
  return kept.join(' ');
}

// What the sort reads of one item, and what its quote is checked against: a chat's newest words (`lines`, the past
// week from sources.js chatItems, never stored), else an email's subject and first words.
const said = (item) => (CHAT_SOURCES.has(item.source)
  ? (item.lines?.length ? newestWords(item.lines) : flat(item.text).slice(-TEXT_CHARS))
  : flat(`${item.title || ''}. ${item.text || ''}`).slice(0, TEXT_CHARS));

// An item the router placed nowhere and gave no candidate, that a person wrote: not a big list, not a machine sender,
// with words to read. Only these are ever sorted (sources.js counts the rest as nothing to do).
export const sortable = (item) => !item.workstream && !(item.candidates || []).length && !item.big && (item.who || []).length <= BIG_CHAT
  && !(item.who || []).some((person) => person.address && MACHINE.test(person.address))
  && flat(`${item.title || ''} ${item.text || ''}`).length > 0;

// The sortable items, newest first, at most MAX_SUGGEST.
export function unplaced(items) {
  return items
    .filter(sortable)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_SUGGEST);
}

const named = (workstreams) => workstreams.filter((w) => w && w.name && !w.inbox && !w.chats && !w.folder);

export function suggestPrompt({ workstreams, items, summaries = {}, today }) {
  const homes = named(workstreams).map((w, i) => {
    const summary = flat(summaries[w.name]).slice(0, 300);
    return `${i + 1}. "${w.name}"${w.goal ? `: goal "${flat(w.goal).slice(0, 200)}"` : ''}${summary ? `. Where it stands: ${summary}` : ''}`;
  });
  const lines = items.map((item, i) => {
    const who = (item.who || []).map((p) => p.name || p.address || p.handle).filter(Boolean).join(', ') || 'unknown';
    return `[${i + 1}] ${SOURCE_WORD[item.source] || 'Message'} from ${who}, ${String(item.at || '').slice(0, 10)}: ${said(item)}`;
  });
  return `Today is ${today}. The user keeps these workstreams:
${homes.join('\n')}

These messages arrived and nothing linked them to a workstream:
${lines.join('\n')}

For each message, name the one workstream it belongs to, or null. Name one only when the message itself shows it: the same company, event, interview, deadline, date or people as that workstream's goal or where it stands. A text message shows the chat's newest words, oldest first. Who writes does not decide it: a friend helping with a workstream's goal, like prep for its interview, belongs there. Answer null only when nothing in the newest words is about a workstream's goal, people, company or event; family news, social plans, shopping and ads that touch none are null. For each workstream you name, copy the exact words from the message that show it, at most 20 words.
Return only JSON: {"homes": [{"message": 1, "workstream": "<exact workstream name or null>", "quote": "<exact words from the message, or null>"}]}`;
}

// The model's answer, checked: a known message number, an exact workstream name, and a quote found in that message.
// `answered` holds the messages it really answered: a home that passed those checks, or an explicit null. A reply that
// is not JSON, leaves a message out or names something else answers nothing for it (Codex review, 2026-10-23: a
// broken reply was remembered as null, so the chat was never asked again).
function readAnswers(raw, items, workstreams) {
  const names = new Set(named(workstreams).map((w) => w.name));
  const found = new Map();
  const answered = new Set();
  let parsed;
  try { parsed = JSON.parse(String(raw || '').replace(/^```(?:json)?|```$/gm, '').trim()); } catch { return { found, answered }; }
  for (const row of Array.isArray(parsed?.homes) ? parsed.homes : []) {
    const index = Number(row?.message) - 1;
    const item = items[index];
    if (!item) continue;
    if (row.workstream === null) { answered.add(index); continue; }
    if (found.has(index) || !names.has(row.workstream)) continue;
    const quote = flat(row.quote).replace(/^["']+|["']+$/g, '').trim();
    // Checked against the words the model was shown: as written (a local model) or as the cloud screen sent them
    // (cloud-screen.js thinkWith), and never a chat's title, which is not in the prompt (Codex review, 2026-10-23: a
    // quote holding "[address kept on this Mac]" never matched the raw address, so the chat was resent every refresh).
    if (quote.length < 3 || ![said(item), screenText(said(item)).text].some((words) => plain(words).includes(plain(quote)))) continue;
    found.set(index, { workstream: row.workstream, quote: quote.slice(0, 300) });
    answered.add(index);
  }
  return { found, answered };
}
export const parseSuggestions = (raw, items, workstreams) => readAnswers(raw, items, workstreams).found;

// One call per kind of yes: chats under the Chats approval, email under the mail-sorting approval. `thinkFor`
// gives the `complete` for 'chats' or 'mail', or null when that yes is missing, and then those items stay unplaced.
// Returns the items it found a home for, each now unsure with that one candidate and the quote, and `answered`: every
// item the model answered explicitly, home or null (sources.js remembers each chat's answer, so it is not resent
// without new words). A failed call is reported in `errors`, places nothing and answers nothing.
export async function suggestHomes({ items, workstreams, thinkFor, summaries = {}, today = localDay() }) {
  const pool = unplaced(items);
  const placed = [];
  const errors = [];
  const answered = [];
  for (const kind of ['chats', 'mail']) {
    const group = pool.filter((item) => (kind === 'chats') === CHAT_SOURCES.has(item.source));
    if (!group.length) continue;
    const complete = thinkFor(kind);
    if (!complete) continue;
    try {
      const reply = readAnswers(await complete(suggestPrompt({ workstreams, items: group, summaries, today })), group, workstreams);
      for (const [index, { workstream, quote }] of reply.found) placed.push({ ...group[index], workstream: null, how: 'none', candidates: [workstream], quote });
      answered.push(...group.filter((_, index) => reply.answered.has(index)));
    } catch (error) {
      errors.push({ source: kind === 'chats' ? 'messages' : 'outlook', message: `suggesting a workstream: ${error.message}` });
    }
  }
  return { placed, errors, answered, asked: pool.length };
}
