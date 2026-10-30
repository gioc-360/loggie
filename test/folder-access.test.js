import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderAccess } from '../desktop/folder-access.js';
import { createCommandService } from '../desktop/command-service.js';
test('folder setup persists selections for this computer and checks accessibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-access-'));
  try {
    const config = { file: join(root, 'folders.json'), window: () => null, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) } };
    const access = createFolderAccess(config); await access.load(); assert.deepEqual(access.roots(), []);
    assert.deepEqual(await access.choose(), [{ path: root, accessible: true }]);
    const restored = createFolderAccess(config); await restored.load(); assert.deepEqual(restored.roots(), [root]);
    config.dialog.showOpenDialog = async () => ({ canceled: true }); await restored.choose(); assert.deepEqual(restored.roots(), [root]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('fresh installation requests folder setup before executing search', async () => {
  const service = createCommandService({ folderAccess: { roots: () => [] }, coreClient: { listProjects: () => { throw new Error('should not scan'); } }, shell: {} });
  assert.equal((await service.execute('open project in vscode')).status, 'access_needed');
});

test('enable file search checks protected defaults and retains blocked paths for recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-onboarding-'));
  try {
    const missing = join(root, 'unavailable');
    const access = createFolderAccess({ file: join(root, 'folders.json'), defaults: [root, missing], dialog: {}, window: () => null });
    await access.load();
    assert.deepEqual(await access.allowDefaults(), [{ path: root, accessible: true }, { path: missing, accessible: false }]);
    const reload = createFolderAccess({ file: join(root, 'folders.json') }); await reload.load(); assert.deepEqual(reload.roots(), [root, missing]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
