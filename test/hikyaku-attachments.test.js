import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachmentsMarkdown, describeAttachment, describeAttachments, taskAttachments } from '../src/hikyaku/attachments.js';
import { catchUp } from '../src/hikyaku/workstreams.js';

test('only PDF and Word up to 20 MB are marked readable; everything else says why not', () => {
  const kinds = describeAttachments([{ name: 'a.pdf', size: 1e5 }, { name: 'b.docx', size: 1e5 }, { name: 'c.pptx', size: 1e5 }, { name: 'd.zip', size: 1e5 }, { name: 'e.dmg', size: 1e5 }, { name: 'f.pdf', size: 25 * 1024 * 1024 }, { name: 'g.png', type: 'image/png', size: 1e4 }]);
  assert.deepEqual(kinds.map((file) => [file.kind, file.readable, file.skipped || '']), [
    ['pdf', true, ''], ['word', true, ''], ['slides', false, 'slides are not read yet'], ['archive', false, 'archives are never opened'],
    ['program', false, 'programs and scripts are never opened'], ['pdf', false, 'too large to read (over 20 MB)'], ['image', false, 'images are not read'],
  ]);
});

test('the classic disguises are caught, and a disguised file is never readable', () => {
  const rtl = describeAttachment({ name: 'invoice‮fdp.exe', size: 9000 });
  assert.equal(rtl.name, 'invoicefdp.exe'); assert.equal(rtl.readable, false); assert.match(rtl.warnings[0], /invisible characters/);
  const twice = describeAttachment({ name: 'Grades.pdf.exe', size: 9000 });
  assert.match(twice.warnings[0], /double extension/); assert.equal(twice.skipped, 'never opened: the name is disguised');
  assert.equal(describeAttachment({ name: 'invoice‮fdp.exe', size: 9000 }).warnings.length, 1, 'the check gives the same answer every time');
  assert.equal(describeAttachment({ name: 'plain.pdf', size: 9000 }).warnings.length, 0);
});

test('catch-up lists each email\'s attachments in the thread and beside the task, marked not opened', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'hikyaku-att-'));
  const tasks = [], projects = [];
  const core = { listProjects: async () => projects, listTasks: async () => tasks, createBrief: async () => ({}),
    createProject: async (input) => { const project = { id: 'p1', ...input }; projects.push(project); return project; },
    createTask: async (input) => { const task = { id: `task_${tasks.length + 1}`, ...input }; tasks.push(task); return task; } };
  const threads = [{ id: 't1', subject: 'Syllabus', latestTimestamp: '2026-10-04T12:00:00Z', messages: [{ id: 'm1', from: 'Prof <prof@example.edu>', to: 'me@school.edu', timestamp: '2026-10-04T12:00:00Z',
    body: 'Please read the syllabus before class.', attachments: [{ name: 'Syllabus.pdf', type: 'application/pdf', size: 300000 }, { name: 'setup.exe', size: 500000 }] }] }];
  const complete = async () => JSON.stringify({ summary: 'A class.', promised: [], open: [], actions: [{ title: 'Read the syllabus', kind: 'prep', thread: 1, due: null, quote: 'Please read the syllabus before class.', steps: [] }] });
  await catchUp({ workstream: { name: 'Class', goal: 'Get the grade', domains: [], words: [] }, threads, complete, core, workRoot, ownAddress: 'me@school.edu' });
  const folder = join(projects[0].directoryPath, tasks[0].id);
  assert.deepEqual((await taskAttachments(folder)).map((file) => [file.name, file.readable]), [['Syllabus.pdf', true], ['setup.exe', false]]);
  assert.match(await readFile(join(folder, 'THREAD.md'), 'utf8'), /Attachments \(hikyaku has not opened them\):\n- Syllabus\.pdf \(pdf, 293 KB\)\n- setup\.exe \(program, 488 KB\) {2}\(programs and scripts are never opened\)/);
  assert.deepEqual(attachmentsMarkdown([]), []);
});
