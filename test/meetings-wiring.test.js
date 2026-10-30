// The Notes & Meetings tab's channels are wired end to end (loggie-meetings-tab): each has a handler in main.js, a
// method in preload.cjs, and a wrapper the tab calls in panel.js. A missing hop is a dead button the click check (which
// talks to a stand-in bridge) cannot see.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertWired, mainText } from './helpers/main-files.js';

const CHANNELS = [
  ['hikyaku:calls', 'calls'],
  ['hikyaku:events', 'events'],
  ['hikyaku:file-event', 'fileEvent'],
  ['hikyaku:call', 'call'],
  ['hikyaku:call-live', 'callLive'],
  ['hikyaku:record-start', 'recordStart'],
  ['hikyaku:record-calendars', 'recordCalendars'],
  ['hikyaku:set-record-calendars', 'setRecordCalendars'],
  ['hikyaku:call-notes', 'callNotes'],
  ['hikyaku:file-call', 'fileCall'],
  ['hikyaku:summarize', 'summarize'],
  ['hikyaku:transcript-line', 'transcriptLine'],
  ['hikyaku:search-calls', 'searchCalls'],
  ['hikyaku:note-line', 'noteLine'],
  ['hikyaku:explain-call', 'explainCall'],
  ['hikyaku:call-title', 'callTitle'],
  ['hikyaku:name-accept', 'nameAccept'],
  ['hikyaku:name-keep', 'nameKeep'],
  ['hikyaku:name-undo', 'nameUndo'],
  ['hikyaku:event-seed', 'eventSeed'],
  ['hikyaku:workspace-from-event', 'workspaceFromEvent'],
  ['hikyaku:workspace-look', 'workspaceLook'],
  ['hikyaku:workspace-new', 'workspaceNew'],
];

test('every meetings channel has a main handler, a preload method and a panel wrapper', async () => {
  await assertWired(CHANNELS);
});

test('the call picker cannot add a workspace: workspaces come from mail, Messages and WhatsApp (decision 13)', async () => {
  const meetings = await readFile(new URL('../desktop/renderer/meetings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(meetings, /api\.addWorkstream|New workstream…/);
});

test('a new workspace from a meeting takes the meeting and a name of 1 to 60 characters, nothing else (first-run-polish B3.3)', async () => {
  const { validateWorkspaceFromEvent } = await import('../desktop/ipc-validation.js');
  const start = '2026-10-13T13:00:00Z';
  assert.deepEqual(validateWorkspaceFromEvent('E1', start, '  Case   Team '), { id: 'E1', start, name: 'Case Team' });
  assert.equal(validateWorkspaceFromEvent('E1', start, 'x'.repeat(60)).name.length, 60);
  assert.throws(() => validateWorkspaceFromEvent('E1', start, 'x'.repeat(61)), /A workspace name is 1 to 60 characters/);
  assert.throws(() => validateWorkspaceFromEvent('E1', start, ''), /A workspace name is 1 to 60 characters/);
  assert.throws(() => validateWorkspaceFromEvent('E1', start, '   '), /A workspace name is 1 to 60 characters/);
  assert.throws(() => validateWorkspaceFromEvent('E1', start, 'Case\nTeam'), /A workspace name is 1 to 60 characters/);
  assert.throws(() => validateWorkspaceFromEvent('x'.repeat(301), start, 'Case Team'), /not a meeting on your calendar/);
  assert.throws(() => validateWorkspaceFromEvent('E1', 'soon', 'Case Team'), /not a meeting on your calendar/);
});

test('the Day view sends a new workspace only the meeting\'s id, start and the name; main reads who is invited', async () => {
  const meetings = await readFile(new URL('../desktop/renderer/meetings.js', import.meta.url), 'utf8');
  const week = await readFile(new URL('../desktop/renderer/meetings-day.js', import.meta.url), 'utf8');
  const main = await mainText();
  assert.match(meetings, /onNewWorkspace: \(item, name\) => api\.workspaceFromEvent\(item\.id, item\.start, name\)/);
  assert.match(week, /api\.eventSeed\(item\.id, item\.start\)/);
  // The seed's reply is counts, domains and words: never the people themselves.
  assert.match(main, /return \{ people: seed\.people\.length, domains: seed\.domains, words: seed\.words \};/);
  assert.match(main, /logUiAct\(\{ act: 'workspace-from-event', people: seed\.people\.length, domains: seed\.domains\.length, words: seed\.words\.length \}\)/);
});
