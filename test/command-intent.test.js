import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandIntent } from '../src/commands/intent-parser.js';

test('natural folder opening uses automatic search', () => {
  const intent = parseCommandIntent('i need to open the tc-website folder');
  assert.equal(intent.target, 'tc-website');
  assert.equal(intent.mode, 'search');
  assert.equal(parseCommandIntent('I want to open my Downloads folder').target, 'Downloads');
});

test('file questions separate the filename, file type and trailing action', () => {
  for (const text of ['where is my tesla scoring excel, open it', 'find my tesla scoring spreadsheet and open it', 'where is my tesla scoring workbook then show it please']) {
    const intent = parseCommandIntent(text);
    assert.equal(intent.target, 'tesla scoring');
    assert.deepEqual(intent.extensions, ['.xlsx', '.xls', '.xlsm', '.xlsb']);
  }
  assert.equal(parseCommandIntent('find my CLV.xlsx, open it').target, 'CLV.xlsx');
});

test('parses the requested Chinese VS Code command', () => {
  const intent = parseCommandIntent('幫我在Visual Studio Code中開啟AI Terminal Tool這個檔案');
  assert.equal(intent.type, 'open');
  assert.equal(intent.application, 'vscode');
  assert.equal(intent.target, 'AI Terminal Tool');
});

test('parses English open commands and rejects unsupported work', () => {
  assert.deepEqual(parseCommandIntent('Open AI Terminal Tool in VS Code'), {
    type: 'open', application: 'vscode', applicationLabel: 'Visual Studio Code', target: 'AI Terminal Tool', original: 'Open AI Terminal Tool in VS Code',
  });
  assert.equal(parseCommandIntent('Fix the tests').type, 'unsupported');
});

test('does not remove an app-like word from the target name', () => {
  assert.equal(parseCommandIntent('Open Code Samples in VS Code').target, 'Code Samples');
});

test('invite and meeting sentences are invites; opening a file is still opening', async () => {
  const { parseCommandIntent } = await import('../src/commands/intent-parser.js');
  for (const text of ['invite Amritha and Jess 2pm Maplewood', 'send amritha and jess an outlook invite for 2pm', 'schedule Nina tomorrow 10am',
    'set up a meeting with Nina next week', 'book a room in Sage for Nina monday 3pm']) assert.equal(parseCommandIntent(text).type, 'invite', text);
  assert.equal(parseCommandIntent('open the Loggie folder in VS Code').type, 'open');
});
