// A text that asks the user to email someone else becomes an email move, found by code on this Mac
// (workspaces-outlook W5). Gio, 2026-10-17: "we don't need text to be done by cloud ai", so no model reads the chat.
// Code finds the request ("Can you email K-House and ask if we can set up a $500 bar tab for Thursday?"), and the move
// carries one ask-box line ("email K-House: ask if we can set up a $500 bar tab for Thursday"). Do it runs that line
// (do-it.js askMove): the ask box finds K-House's thread and writes the email; only the line and K-House's email reach
// the cloud, under the ask box's own yes. Narrow on purpose: someone else's words, aimed at the user ("can you",
// "please"), a contact verb, and a name with a capital letter right after it.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chatAsThread, chatReplyTarget } from './chats.js';
import { slug } from './util.js';

// Aimed at the user. Texts nudge more than they ask: "Did you get a chance to ... ask KHouse about $500 bar tab?" was
// the real request (Liam, 2026-10-17), so "did you" and "have you" count too.
const AT_YOU = /\b(can|could|would|will|did|have) (you|u)\b/i;
const AT_USER = new RegExp(`${AT_YOU.source}|\\bplease\\b|\\bpls\\b|\\bplz\\b`, 'i');
// A request is short, and in a group it is said to someone ("can you", "did you"): "please" in a group is said to
// everyone. 120 days of Gio's texts (2026-10-17): 10 messages found, 3 real requests (all at most 184 characters); the
// other 7 were class-wide posts ("please reach out to Kai", "Hey all, please try to get in touch with CMC") and pasted
// text. These two rules keep the 3 and drop the 7.
const MAX_CHARS = 200;
// The user said it is done, later in the same chat ("Just sent khouse email"): no move.
const DONE = /\b(sent|emailed|e-mailed|asked|done|did it|reached out|wrote)\b/i;
const squash = (text = '') => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const NAME = String.raw`[A-Z][\w&'.-]*`;
const VERB = new RegExp(String.raw`\b(?:e-?mail|ask|reach out to|contact|write to|check with|confirm with|follow up with|get in touch with)\s+(?:the\s+)?(${NAME}(?:\s+(?:&\s+)?${NAME}){0,2})`);
// Capitalized words that are not someone to email: pronouns, days, months, words that start a sentence.
const NOT_NAMES = new Set(`I Me Us You Them Him Her It Everyone Anyone Someone Somebody Everybody All Them Their This That
Monday Tuesday Wednesday Thursday Friday Saturday Sunday Today Tomorrow Tonight January February March April May June
July August September October November December If Whether About When What Why How`.split(/\s+/));

// The request in one message, or null: { to, ask }. `ask` is what to ask them, as a line the ask box reads.
export function emailAskOf(text = '') {
  const said = String(text).replace(/\s+/g, ' ').trim();
  if (!said || !AT_USER.test(said)) return null;
  const match = VERB.exec(said);
  if (!match) return null;
  const words = match[1].split(/\s+/);
  while (words.length && NOT_NAMES.has(words.at(-1).replace(/[.,!?]+$/, ''))) words.pop();
  const to = words.join(' ').replace(/[.,!?:;]+$/, '');
  if (!to || NOT_NAMES.has(to.split(/\s+/)[0])) return null;
  let rest = said.slice(match.index + match[0].length).replace(/^[\s,:;-]+/, '').replace(/^and\s+/i, '').replace(/[\s?!.]+$/, '');
  rest = rest.replace(/^(re|regarding|on)\b:?\s*/i, 'about ');
  if (/^(about|if|whether|to|for)\b/i.test(rest)) rest = `ask ${rest}`;
  const ask = (rest.length >= 6 ? rest : said.replace(/[\s?!.]+$/, '')).slice(0, 300);
  return { to, ask };
}

// Every request in the chats read, newest first, one per chat and person: [{ thread, message, to, ask, line }].
// `days`: only messages this recent count (the 10-minute check reads the last few days).
export function emailAsksIn(read = {}, { now = Date.now(), days = 3 } = {}) {
  const since = now - days * 86400000;
  const found = [];
  const seen = new Set();
  for (const answer of Object.values(read || {})) {
    for (const chat of answer?.chats || []) {
      const thread = chatAsThread(chat);
      for (const message of [...thread.messages].reverse()) {
        if (message.fromMe || Date.parse(message.timestamp) < since) continue;
        const body = String(message.body || '');
        if (body.length > MAX_CHARS || (chat.isGroup && !AT_YOU.test(body))) continue;
        const asked = emailAskOf(body);
        if (!asked) continue;
        const key = `${thread.id}:${slug(asked.to)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const answered = thread.messages.some((other) => other.fromMe && String(other.timestamp) > String(message.timestamp)
          && DONE.test(other.body || '') && squash(other.body).includes(squash(asked.to)));
        if (answered) continue;
        found.push({ thread, message, ...asked, line: `email ${asked.to}: ${asked.ask}` });
      }
    }
  }
  return found;
}

// Each request becomes a move in the Chats card, once (Core keeps one task per source: `<chat>:email:<person>`).
// The task folder holds the chat (THREAD.md), the brief, and REPLY.json { ask, fromChat } for Do it.
export async function makeEmailMoves({ core, asks, workRoot, projectName }) {
  const made = [];
  if (!asks.length) return made;
  const seen = new Set((await core.listTasks()).map((task) => `${task.sourceType}:${task.sourceId}`));
  let project = (await core.listProjects()).find((item) => item.name.toLowerCase() === projectName.toLowerCase());
  const directoryPath = project?.directoryPath || join(workRoot, slug(projectName));
  await mkdir(directoryPath, { recursive: true });
  for (const item of asks) {
    const sourceType = item.thread.sourceType;
    const sourceId = `${item.thread.id}:email:${slug(item.to)}`;
    if (seen.has(`${sourceType}:${sourceId}`)) continue;
    seen.add(`${sourceType}:${sourceId}`);
    if (!project) project = await core.createProject({ name: projectName, directoryPath, summary: 'Chats waiting on you.' });
    const who = item.message.from || 'Someone';
    const title = `Email ${item.to}: ${item.ask}`.slice(0, 200);
    const task = await core.createTask({ projectId: project.id, title, description: `${title}\n\n${who} asked in ${item.thread.subject}: "${item.message.body}"`, sourceType, sourceId, priority: 45, dueAt: null });
    await core.createBrief(task.id, {
      objective: title,
      context: `${who} asked in the chat "${item.thread.subject}":\n"${item.message.body}"`,
      constraints: ['Never send email. Write the draft only; the user presses Send.'],
      suggestedSteps: [`Email ${item.to} in their existing thread.`],
      completionCriteria: [`The email to ${item.to} is open in the user's mail app, in their thread, unsent.`],
      assumptions: [],
    });
    const folder = join(directoryPath, task.id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'THREAD.md'), [`# ${item.thread.subject}`, '', ...item.thread.messages.slice(-8).flatMap((message) => [`## ${message.fromMe ? 'You' : message.from} · ${message.timestamp}`, '', message.body || '', ''])].join('\n'));
    await writeFile(join(folder, 'REPLY.json'), `${JSON.stringify({ ask: { line: item.line, to: item.to, ask: item.ask }, fromChat: chatReplyTarget(item.thread) }, null, 2)}\n`);
    made.push({ task: task.id, to: item.to, line: item.line });
  }
  return made;
}
