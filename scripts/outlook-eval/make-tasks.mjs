// Creates the eval task folders and the setup sheet, outside the repo (they hold real addresses).
//   node scripts/outlook-eval/make-tasks.mjs --other you@personal.example.com --self you@school.example.com --third you@other.example.com [--other-b ADDR]
// Writes <hikyaku>/work/outlook-eval/task_<S>/ (THREAD.md, REPLY.json, DRAFT.md) and SETUP.md: the emails to send once.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from '../../src/hikyaku/draft.js';
import { EVAL_DIR_NAME, scenarios } from './scenarios.mjs';

export const EVAL_ROOT = join(HIKYAKU_HOME, 'work', EVAL_DIR_NAME);

export function draftText(id, runId) {
  return `hkeval ${id} ${runId}\n\nThis is an eval draft from hikyaku. It is never sent; discard it.\n\nBest regards,\n`;
}

export async function makeTasks({ other, self, third, otherB = third, root = EVAL_ROOT, now = new Date() }) {
  const a = { other: other.toLowerCase(), self: self.toLowerCase(), third: third.toLowerCase(), otherB: otherB.toLowerCase() };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'ADDRESSES.json'), `${JSON.stringify(a, null, 2)}\n`);
  const list = scenarios(a);
  for (const s of list) {
    const dir = join(root, `task_${s.id}`);
    await mkdir(dir, { recursive: true });
    // The original's date is the run's own: the real email is sent around now, and the helper accepts any message
    // from that day or newer.
    const reply = { ...s.reply, original: { ...s.reply.original, date: now.toISOString(), messageId: null } };
    await writeFile(join(dir, 'REPLY.json'), `${JSON.stringify(reply, null, 2)}\n`);
    await writeFile(join(dir, 'THREAD.md'), `# ${s.subject}\n\n## ${reply.original.from} · ${now.toISOString()}\nTo: ${a.self}\n\n(eval thread: ${s.title})\n`);
    await writeFile(join(dir, 'DRAFT.md'), draftText(s.id, 'setup'));
  }
  const sheet = ['# Outlook eval: emails to send once', '', `"other" is ${a.other}, "self" is your Outlook account ${a.self}.`, 'Send these, wait until they arrive in Outlook, then run the scenarios. hikyaku sends nothing.', '',
    ...list.flatMap((s) => [`## ${s.id}: ${s.title}${s.optional ? ' (optional)' : ''}`, ...s.setup.map((line) => `- ${line}`), ''])].join('\n');
  await writeFile(join(root, 'SETUP.md'), `${sheet}\n`);
  return { root, scenarios: list.map((s) => s.id), sheet };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
  if (!flag('--other') || !flag('--self') || !flag('--third')) { console.error('usage: make-tasks.mjs --other ADDR --self ADDR --third ADDR [--other-b ADDR]'); process.exit(2); }
  const out = await makeTasks({ other: flag('--other'), self: flag('--self'), third: flag('--third'), otherB: flag('--other-b') || flag('--third') });
  console.log(out.sheet);
  console.log(`\nTasks in ${out.root}`);
}
