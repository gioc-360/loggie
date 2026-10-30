import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommandService } from '../desktop/command-service.js';

test('resolves and opens a natural-language VS Code request with structured arguments', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-command-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'AI Terminal Tool');
  await mkdir(target);
  let invocation;
  const service = createCommandService({
    coreClient: { listProjects: async () => [] },
    shell: {},
    roots: [root],
    spawnImpl(command, args) {
      invocation = { command, args };
      return { once(event, listener) { if (event === 'exit') queueMicrotask(() => listener(0)); } };
    },
  });
  const result = await service.execute('幫我在 Visual Studio Code 中開啟 AI Terminal Tool 這個資料夾');
  assert.equal(result.status, 'completed');
  assert.equal(result.target.path, target);
  assert.deepEqual(invocation, { command: '/usr/bin/open', args: ['-a', 'Visual Studio Code', target] });
});

test('returns choices instead of opening when names are ambiguous', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-command-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'One', 'Report'), { recursive: true });
  await mkdir(join(root, 'Two', 'Report'), { recursive: true });
  const service = createCommandService({ coreClient: { listProjects: async () => [] }, shell: {}, roots: [root] });
  const result = await service.execute('Open report in Finder');
  assert.equal(result.status, 'needs_choice');
  assert.equal(result.candidates.length, 2);
});

test('an invite sentence goes to the invite filler, and its readout comes back as lines', async () => {
  const asked = [];
  const service = createCommandService({ coreClient: { listProjects: async () => { throw new Error('an invite reads no projects'); } }, shell: {},
    invite: async (text) => { asked.push(text); return { status: 'invited', lines: ['Invite: Meeting with Nina', 'The invite is filled in Outlook and waiting for you. Nothing was sent. (3.9 s)'] }; } });
  const result = await service.execute('invite Nina and Jules 2pm Maplewood');
  assert.deepEqual(asked, ['invite Nina and Jules 2pm Maplewood']);
  assert.equal(result.status, 'invited');
  assert.match(result.lines.at(-1), /Nothing was sent/);
});


test('standard folders open without search permissions, projects, or AI', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-home-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  for (const name of ['Desktop', 'Downloads', 'Documents']) await mkdir(join(home, name));
  const opened = [];
  const service = createCommandService({ home, folderAccess: { roots: () => [] },
    coreClient: { listProjects: async () => { throw new Error('must not search'); } },
    shell: { openPath: async (path) => { opened.push(path); return ''; } } });
  for (const name of ['Desktop', 'Downloads', 'Documents']) {
    const result = await service.execute(`Loggie, can you open my ${name} folder?`);
    assert.equal(result.status, 'completed');
    assert.equal(result.target.path, join(home, name));
  }
  assert.deepEqual(opened, ['Desktop', 'Downloads', 'Documents'].map(name => join(home, name)));
});


test('natural Excel location question finds nested copies and shows paths without opening', async (context) => {
  const { writeFile } = await import('node:fs/promises');
  const { readAsk } = await import('../src/hikyaku/ask.js');
  const { searchMacFiles } = await import('../src/commands/mac-file-search.js');
  const home = await mkdtemp(join(tmpdir(), 'loggie-file-search-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'Documents');
  for (let i = 0; i < 10; i++) {
    const folder = join(root, `marketing${i}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'CLV.xlsx'), '');
    await writeFile(join(folder, 'CLV.pdf'), '');
  }
  const question = 'where is my CLV excel file?';
  assert.equal(readAsk(question).action, 'open');
  const service = createCommandService({ home, folderAccess: { roots: () => [] }, searchMac: args => searchMacFiles({ ...args, roots: [home], execImpl: async () => ({ stdout: '' }) }),
    coreClient: { listProjects: async () => [] }, shell: { openPath: () => { throw new Error('search must not open'); } } });
  const result = await service.execute(question);
  assert.equal(result.status, 'needs_choice');
  assert.equal(result.candidates.length, 10);
  assert.ok(result.candidates.every(item => item.path.endsWith('/CLV.xlsx')));
});
