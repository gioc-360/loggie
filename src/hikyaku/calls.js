// Files a recorded call onto its workstream. The notes go into the workstream folder (calls/<call>.md), and each
// next step the user owns becomes a Loggie task with its own folder, ready for Do it: the same path email cards take
// (workstreams.js catchUp), so the screen shows call moves like any other. Running it twice adds nothing twice.
// The call folder comes from the transcriber: event.json (derived by code: me, with, category, workstream),
// notes.md, and checks.json (each next step with owner, action, quote and why it is not sure, if it is).
// With local notes off (settings.json "frontier": "nebius", the hackathon entry) there is no notes.md: the call is filed
// from the newest cloud summary byo.py wrote instead (fromSummary below). A folder with notes.md files as it always did.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isClass } from './class-names.js';
import { projectFor } from './util.js';
import { sameThing } from './workstreams.js';

const CLASSMATE = /\bStudents? \d+\b/i;
const first = (name = '') => String(name).trim().toLowerCase().split(/\s+/)[0] || '';

// Next steps the user owns: owner "Me", or the user's own first name ("Lena Park" for me = "Lena").
export function ownSteps(checks, me = '') {
  return checks.filter((check) => check.next_step && (first(check.owner) === 'me' || (first(me) && first(check.owner) === first(me))));
}

const sentence = (text = '') => text.charAt(0).toUpperCase() + text.slice(1);

// The summaries byo.py writes (summary-<provider>.md, recorded in summary-runs.json). The newest run of one of these
// stands in for notes.md, and its Next Steps checks stand in for checks.json. byo.py has already dropped every next
// step it could not find in the transcript, so what is left is verified; a name never said stays as a "not sure" reason.
const SUMMARY_PROVIDERS = ['nebius'];

export async function fromSummary(read) {
  const runs = JSON.parse(await read('summary-runs.json').catch(() => '[]'));
  const run = [...runs].reverse().find((item) => SUMMARY_PROVIDERS.includes(item.provider) && item.output);
  if (!run) throw new Error('No notes.md and no cloud summary in this call folder. Write one with byo.py (python3 byo.py <folder> --with nebius), then file again.');
  const file = basename(run.output);
  const checks = (run.checks || []).filter((check) => /^next steps?$/i.test(check.section || '')).map((check) => ({
    next_step: check.text || '', owner: check.owner || '', quote: check.quote || '', not_sure: check.reasons || [],
  }));
  return { notes: await read(file), checks, notesFrom: file };
}

async function notesOf(read) {
  // notes.md when local notes ran (daily use, unchanged); the cloud summary when they did not.
  const notes = await read('notes.md').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (notes === null) return fromSummary(read);
  return { notes, checks: JSON.parse(await read('checks.json').catch(() => '[]')), notesFrom: 'notes.md' };
}

// retired: retired.json; a step retired earlier (a call moved away and back) is filed again. Steps already in another
// workstream's project do not stop this one getting them (refile.js retires those first).
export async function fileCall({ folder, core, workRoot, workstreams, ownAddress = '', workstream: chosen = '', dryRun = false, transcriptOnly = false, retired = {} }) {
  const read = (file) => readFile(join(folder, file), 'utf8');
  const event = JSON.parse(await read('event.json'));
  // transcriptOnly: the user said No to a cloud summary (send gate). The card says so and links the transcript; no tasks.
  const { notes, checks, notesFrom } = transcriptOnly
    ? { notes: `Kept on this Mac with no summary.\n\nTranscript: ${join(folder, 'transcript.md')}\n`, checks: [], notesFrom: 'transcript.md' }
    : await notesOf(read);
  const name = chosen || event.filed?.workstream || (event.workstream !== 'none' ? event.workstream : '') || '';
  const workstream = workstreams.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!workstream) throw new Error(`No workstream for this call ("${name || 'none'}"). Run again with --workstream and one of: ${workstreams.map((item) => item.name).join(', ') || '(none in workstreams.json)'}.`);
  const call = basename(folder);
  const owned = ownSteps(checks, event.me).map((step, index) => ({
    sourceId: `call:${call}#${index + 1}`, title: sentence(step.next_step || step.action), quote: step.quote, owner: step.owner,
    notSure: (step.not_sure || []).map((reason) => `Not sure: ${reason}`),
  }));
  // A class (loggie-class-notes I3): a step naming a classmate keeps its "Student N" on disk, and a filed task is read
  // by the drafter, so it is not filed; it stays in the notes. Each other step keeps its number, so filing again matches.
  const named = (step) => isClass(event) && CLASSMATE.test(`${step.title || ''} ${step.quote || ''}`);
  const steps = owned.filter((step) => !named(step));
  const classmateSteps = owned.length - steps.length;
  const others = checks.filter((check) => check.next_step).length - owned.length;
  const classmates = isClass(event) ? { classmateSteps } : {};
  if (dryRun) return { dryRun: true, workstream: workstream.name, call, steps, others, notesFrom, ...classmates };

  const project = await projectFor(core, workstream.name, { workRoot, summary: 'Workstream from email and calls.', sub: 'calls' });
  const { directoryPath } = project;
  const header = [`# Call: ${event.title}`, '', `${(event.start || '').slice(0, 10) || 'Date unknown'} · with ${event.with || 'unknown'} · ${event.category || 'call'}`,
    `Recording and transcript: ${folder}`, ''].join('\n');
  const notesFile = join(directoryPath, 'calls', `${call}.md`);
  await writeFile(notesFile, `${header}\n${notes.replace(/^# .*\n+/, '')}`);

  const open = (await core.listTasks()).filter((task) => task.projectId === project.id && !retired[task.id]);
  const existing = new Set(open.map((task) => `${task.sourceType}:${task.sourceId}`));
  // Summarize again (2026-10-29): a new run numbers its steps afresh, so the same step came back under another number
  // and the card showed it twice. A step that is the same thing as an open task from this call is already filed.
  const plain = (text) => String(text || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\W+/g, ' ').trim();
  const fromThisCall = open.filter((task) => String(task.sourceId || '').startsWith(`call:${call}#`));
  const log = { workstream: workstream.name, call, notesFile, notesFrom, created: [], already: 0, others, ...classmates };
  // The recipient is filled only when the step names the one other person on the call ("send Sam the deck"). A step
  // about someone else ("follow up with Dana") opens with To empty: a blank To is a nuisance, a wrong one is a mistake.
  // Found live 2026-10-04: a follow-up about a third person was addressed to the person on the call.
  const other = (event.emails || []).length === 1 ? { email: event.emails[0], first: first(event.names || event.with) } : null;
  const recipient = (step) => (other?.first && new RegExp(`\\b${other.first}\\b`, 'i').test(`${step.title} ${step.quote}`) ? other.email : '');
  for (const [rank, step] of steps.entries()) {
    if (fromThisCall.some((task) => plain(task.title) === plain(step.title) || sameThing({ title: step.title }, task)) || (existing.has(`manual:${step.sourceId}`) && !fromThisCall.length)) { log.already += 1; continue; }
    // a different step on a number an earlier run used gets its own id, so both stay told apart
    for (let n = 2; existing.has(`manual:${step.sourceId}`); n += 1) step.sourceId = `${step.sourceId.replace(/-\d+$/, '')}-${n}`;
    existing.add(`manual:${step.sourceId}`);
    const task = await core.createTask({ projectId: project.id, title: step.title, description: `${step.title}\n\nFrom the call "${event.title}". Workstream: ${workstream.name}.`,
      sourceType: 'manual', sourceId: step.sourceId, priority: Math.max(-100, 45 - rank * 5 - (step.notSure.length ? 30 : 0)) });
    await core.createBrief(task.id, {
      objective: step.title,
      context: `Next step from the call "${event.title}" with ${event.with || 'unknown'}.\nQuoted from the call:\n${step.quote ? `"${step.quote}"` : 'No words quoted.'}`,
      constraints: ['Never send email. Write drafts only; the user sends them.'],
      suggestedSteps: ['Read CALL.md for what was said', 'Do the step, or write the email it needs'],
      completionCriteria: ['DRAFT.md holds an email the user can send as is, or DONE.md says why nothing needs writing.'],
      assumptions: step.notSure,
    });
    const taskFolder = join(directoryPath, task.id);
    await mkdir(taskFolder, { recursive: true });
    await writeFile(join(taskFolder, 'BRIEF.md'), [
      `# ${step.title}`, '', `Workstream: **${workstream.name}**. This step comes from a call; CALL.md next to this file has the notes.`, '',
      '## Quoted from the call', step.quote ? `> ${step.quote}` : '_No words quoted._', '',
      '## Done when', '- DRAFT.md holds an email the user can send as is, or DONE.md says why nothing needs writing (for example the step is a text message or a task, not an email).', '',
      '## Rules', '- Never send email. Write drafts only; the user sends them.', '- Facts come from CALL.md and this brief only.',
      ...(step.notSure.length ? ['', '## Check', ...step.notSure.map((line) => `- ${line}`)] : []), '',
    ].join('\n'));
    await writeFile(join(taskFolder, 'CALL.md'), `${header}\n${notes.replace(/^# .*\n+/, '')}`);
    await writeFile(join(taskFolder, 'THREAD.md'), `# ${event.title}\n\nNo thread: this step comes from a call, so any email is a new one the user starts. Everything needed is in BRIEF.md and CALL.md.\n`);
    await writeFile(join(taskFolder, 'REPLY.json'), JSON.stringify({ to: recipient(step), subject: `Following up: ${event.title}`, account: ownAddress }, null, 2));
    log.created.push({ id: task.id, title: step.title, notSure: step.notSure.length > 0 });
  }
  return log;
}
