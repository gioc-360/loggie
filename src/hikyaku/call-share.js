// Share a call's notes (loggie right-click, 2026-10-28; ~/Loggie/workspace/right-click-proposal.md): an unsent email to
// the people on the call in his mail app, or the Mac's share sheet. What leaves is the notes as the AI wrote them to
// disk, parsed as the page parses them: a class keeps Student N, an interview keeps first names, and the quotes a point
// rests on come off with its minute. Never the transcript, the audio, his typed notes or the names map. Nothing here
// sends: the compose window waits for his Send, and both openers are passed in.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CALL_ID, parseSummary, summaryOf } from './call-list.js';
import { composeCommand } from './draft.js';

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const APP_WORD = { outlook: 'Outlook', 'apple-mail': 'Mail' };

async function callOf(home, id) {
  if (typeof id !== 'string' || !CALL_ID.test(id)) throw new Error('Invalid call.');
  const folder = join(home, 'calls', id);
  const event = JSON.parse(await readFile(join(folder, 'event.json'), 'utf8'));
  return { folder, event, summary: await summaryOf(folder) };
}

// Who the notes would go to (event.json's addresses, his own left out, once each) and whether there are notes. The
// addresses stay in main: the menu shows their count.
export async function shareInfo({ home, id, own = [] }) {
  const { event, summary } = await callOf(home, id);
  const mine = new Set(own.map((address) => String(address).toLowerCase()));
  const people = [...new Set((Array.isArray(event.emails) ? event.emails : []).map((address) => String(address).trim().toLowerCase()))]
    .filter((address) => ADDRESS.test(address) && !mine.has(address));
  return { title: event.title || id, people, notes: Boolean(summary?.text?.trim()) };
}

// The notes as text: each topic and its points, then Next steps with who owns each, signed. His own steps carry his
// sign name. `withTitle` heads the share sheet's copy, which has no subject line.
export function shareText({ title, notes, signName = '', withTitle = false }) {
  const { sections, steps } = parseSummary(notes, { me: signName });
  const parts = withTitle ? [`Notes: ${title}`] : [];
  for (const section of sections) parts.push([section.heading, ...section.lines.map((line) => `- ${line.text}`)].join('\n'));
  if (steps.length) parts.push(['Next steps', ...steps.map((step) => { const who = step.mine ? signName : step.who || step.owner; return `- ${step.text}${who ? ` (${who})` : ''}`; })].join('\n'));
  if (signName) parts.push(signName);
  return parts.join('\n\n');
}

// how 'people': one compose window in his mail app, To the people on the call, unsent. how 'sheet': the share sheet
// with the same text and a copy of it as a file in `tmp` (never the call folder's notes file, which keeps the quotes).
export async function shareCall({ home, id, how, own = [], settings = {}, compose, sheet, tmp }) {
  const info = await shareInfo({ home, id, own });
  const { summary } = await callOf(home, id);
  if (!info.notes) throw new Error('This call has no notes yet. Summarize it, then share.');
  const n = info.people.length;
  if (how === 'people') {
    if (!n) throw new Error('No addresses on this call, so there is no one to send the notes to.');
    const body = shareText({ title: info.title, notes: summary.text, signName: settings.signName || '' });
    const [command, args] = composeCommand({ mailApp: settings.mailApp, to: info.people.join(', '), subject: `Notes: ${info.title}`, body });
    await compose(command, args);
    return { how, people: n, line: `Open in ${APP_WORD[settings.mailApp] || 'your mail app'}, unsent: ${n} ${n === 1 ? 'person' : 'people'}. You send it there.` };
  }
  if (how !== 'sheet') throw new Error('Share by email or the share sheet.');
  const text = shareText({ title: info.title, notes: summary.text, signName: settings.signName || '', withTitle: true });
  const file = join(await mkdtemp(join(tmp, 'loggie-share-')), `${info.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'Notes'}.md`);
  await writeFile(file, `${text}\n`);
  await sheet({ texts: [text], filePaths: [file] });
  return { how, people: n, line: '' };
}
