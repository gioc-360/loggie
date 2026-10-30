// Offline draft evaluation on the user's own archived sends (docs/replies/spec-a.md R4). Dev tool, not in npm test.
//   node scripts/draft-eval.mjs --archive <hikyaku home copy> --out <folder> [--rule "<one rules.md line>"]
//     redrafts the frozen set through Loggie's real prompt path (headlessPrompt, draftPrompt, screenText, draftOnce),
//     Super at temperature 0, and writes <out>/results.json. Usage and saved answers stay in <out>. Nothing opens,
//     nothing is sent, nothing is written outside <out>.
//   node scripts/draft-eval.mjs --score <results.json> --archive <hikyaku home copy>
//     prints the scorecard per arm; no cloud call.
// The archive holds real mail: keep it, and every results file, outside the repo.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SET_A, SET_R, scorecard } from './draft-eval-score.mjs';
import { headlessPrompt, outcomeOf } from '../src/hikyaku/headless.js';
import * as draft from '../src/hikyaku/nebius-draft.js';
import { screenText } from '../src/hikyaku/cloud-screen.js';
import { createTokenFactory, NEBIUS_MODEL } from '../src/hikyaku/nebius.js';
import { lengthFor, recentMarkdown } from '../src/hikyaku/delta.js';

const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const archive = arg('--archive');
if (!archive) throw new Error('Pass --archive <hikyaku home copy>.');
const deltas = (await readFile(join(archive, 'deltas.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
const rowOf = (short) => deltas.find((row) => row.task.slice(5, 13) === short);
async function taskDir(taskId) {
  for (const folder of await readdir(join(archive, 'work'))) {
    if (folder.startsWith('.')) continue;
    const dir = join(archive, 'work', folder, taskId);
    if (existsSync(dir)) return { dir, folder };
  }
  throw new Error(`No task folder for ${taskId} in the archive.`);
}
const read = (path) => readFile(path, 'utf8').catch(() => '');

if (arg('--score')) {
  const results = JSON.parse(await readFile(arg('--score'), 'utf8'));
  const arms = [...new Set(results.map((row) => row.arm || 'run'))];
  for (const arm of arms) {
    const rows = [];
    for (const result of results.filter((row) => (row.arm || 'run') === arm)) {
      const delta = rowOf(result.task);
      if (!delta) continue;
      const { dir } = await taskDir(delta.task);
      rows.push({ task: result.task, file: result.file, draft: result.draft, reasked: result.reasked, sent: delta.sent, brief: await read(join(dir, 'BRIEF.md')), notes: await read(join(dir, 'NOTES.md')) });
    }
    const card = scorecard(rows);
    // C12: a DONE on a task with notes must come back as a question, never a silent done.
    card.c12 = rows.filter((row) => row.file === 'DONE.md' && row.notes.trim())
      .map((row) => `${row.task}: ${outcomeOf({ run: { ok: true, denied: [], text: '' }, finished: 'nothing to do', notes: row.notes }).phase}`);
    console.log(`\n## ${arm}`);
    console.log(JSON.stringify(card, null, 1));
  }
  process.exit(0);
}

const out = arg('--out');
if (!out) throw new Error('Pass --out <folder> (outside the repo).');
const rule = arg('--rule');
await mkdir(out, { recursive: true });
const client = createTokenFactory({ usageHome: out, answersHome: out });
const complete = async (text) => (await client.post(JSON.stringify({ model: NEBIUS_MODEL, messages: [{ role: 'user', content: screenText(text).text }], max_tokens: 4000, temperature: 0, chat_template_kwargs: { enable_thinking: false } }), { path: 'draft-eval' })).content;
const results = [];
for (const short of [...SET_A, ...SET_R]) {
  const delta = rowOf(short);
  const taskId = delta.task;
  const { dir, folder } = await taskDir(taskId);
  // The room as cloud.js builds it: CONTEXT.md and the task's inputs; the old draft is never shown.
  const room = join(out, 'rooms', taskId);
  await rm(room, { recursive: true, force: true });
  await mkdir(join(room, taskId), { recursive: true });
  if (existsSync(join(archive, 'work', folder, 'CONTEXT.md'))) await cp(join(archive, 'work', folder, 'CONTEXT.md'), join(room, 'CONTEXT.md'));
  for (const file of ['BRIEF.md', 'THREAD.md', 'NOTES.md', 'SYLLABUS.txt', 'CALL.md', 'ATTACHMENTS.json', 'CALENDAR.md']) {
    if (existsSync(join(dir, file))) await cp(join(dir, file), join(room, taskId, file));
  }
  // Voice: rules.md and intros.md as archived; recent.md is the Length block only, leave-one-out, because the
  // archived recent.md was built from these same edits and would hand the model the answer.
  const source = existsSync(join(archive, 'voice', 'by-workstream', folder)) ? join(archive, 'voice', 'by-workstream', folder) : join(archive, 'voice');
  const voice = join(out, 'voice', taskId);
  await rm(voice, { recursive: true, force: true });
  await mkdir(voice, { recursive: true });
  for (const file of ['rules.md', 'intros.md', 'texting.md']) if (existsSync(join(source, file))) await cp(join(source, file), join(voice, file));
  if (rule) await writeFile(join(voice, 'rules.md'), `${await read(join(voice, 'rules.md'))}\n- ${rule}\n`);
  const others = deltas.filter((row) => row.task !== taskId);
  const sameStream = new Set((await readdir(join(archive, 'work', folder))).filter((name) => name.startsWith('task_') && name !== taskId));
  const length = lengthFor(others, { taskIds: sameStream });
  await writeFile(join(voice, 'recent.md'), recentMarkdown([], { length }));
  if (length) await writeFile(join(voice, 'length.json'), JSON.stringify({ ...length, at: new Date().toISOString() }));
  const known = await draft.knownContact(dir);
  const { text } = await draft.draftPrompt({ prompt: headlessPrompt(taskId, { voiceDirectory: voice, hold: true }), room, taskId, voiceDirectory: voice, known });
  let answer, reasked = false;
  try {
    ({ answer, reasked } = await draft.draftOnce({ complete, text, length }));
  } catch (error) { answer = { ok: false, error: error.message }; }
  const result = { task: short, folder, arm: 'eval', file: answer.ok ? answer.file : `error: ${answer.error}`, reasked, draft: answer.ok && answer.file === 'DRAFT.md' ? answer.content : '', target: length?.median ?? null, sentWords: delta.sentWords };
  results.push(result);
  console.log(short, folder.padEnd(16), result.file.padEnd(10), result.draft ? `${result.draft.split(/\s+/).length} words (target ${result.target}, sent ${delta.sentWords})` : '', reasked ? 're-asked' : '');
}
await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\nWrote ${join(out, 'results.json')}. Score it with --score.`);
