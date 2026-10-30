import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefFromCall, doIt } from '../src/hikyaku/do-it.js';

const SUMMARY = `# Me / Lena: bank chat
## Interview prep [05:00]
- Map the bank's "teaming for growth" pillar to cross-functional examples for interviews [06:12]
- Ask HR for other roles [07:40]`;

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'callstep-'));
  await mkdir(join(home, 'calls', '2026-10-09-1258-me-lena'), { recursive: true });
  await writeFile(join(home, 'calls', '2026-10-09-1258-me-lena', 'summary-goal.md'), SUMMARY);
  const project = { id: 'p1', name: 'Bank Offer', directoryPath: join(home, 'work', 'bank-offer') };
  const task = { id: 'task_s', projectId: 'p1', title: 'Map the teaming for growth pillar to cross-functional examples', status: 'waiting', sourceId: 'callstep:2026-10-09-1258-me-lena:map-the-teaming' };
  const briefs = [];
  const core = {
    getTask: async () => task, getProject: async () => project,
    getApprovedBrief: async () => { const e = new Error('Resource was not found.'); e.status = 404; throw e; },
    getLatestBrief: async () => { if (briefs.length) return briefs.at(-1); const e = new Error('Resource was not found.'); e.status = 404; throw e; },
    createBrief: async (id, brief) => { const b = { id: `brief_${briefs.length + 1}`, status: 'draft', ...brief }; briefs.push(b); return b; },
    approveBrief: async (id) => { briefs.find((b) => b.id === id).status = 'approved'; },
    transitionTask: async (id, to) => { task.status = to; return task; },
  };
  return { home, project, task, core, briefs };
}

test('briefFromCall: a call-step move gets a brief from its call summary lines, and the summary as CALL.md', async () => {
  const { home, project, task, core, briefs } = await setup();
  const brief = await briefFromCall({ core, task, project, home });
  assert.equal(brief.status, 'draft');
  assert.match(briefs[0].context, /Your step from the call "Me \/ Lena: bank chat" on 2026-10-09/);
  assert.match(briefs[0].context, /"Map the bank's "teaming for growth" pillar to cross-functional examples for interviews"/);
  const folder = join(project.directoryPath, task.id);
  assert.match(await readFile(join(folder, 'BRIEF.md'), 'utf8'), /## Quoted from the call\n- Map the bank's .* \(Interview prep, 06:12\)/);
  assert.equal(await readFile(join(folder, 'CALL.md'), 'utf8'), SUMMARY);
});

test('Do it on a call-step move with no brief writes one and starts the run instead of "Resource was not found."', async () => {
  const { home, core, briefs } = await setup();
  await writeFile(join(home, 'settings.json'), JSON.stringify({ frontier: 'nebius' }));
  let started = null;
  const startImpl = async ({ task }) => { started = { task: task.id, status: task.status }; return { started: true, done: new Promise(() => {}) }; };
  const result = await doIt({ core, taskId: 'task_s', home, startImpl, waitMs: 20 });
  assert.equal(result.phase, 'queued');
  assert.deepEqual(started, { task: 'task_s', status: 'briefed' });
  assert.equal(briefs[0].status, 'approved');
});
