import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { callDetail, isFiller, listCalls, parseBullet, parseDraft, parseStamp, parseSummary, parseTranscript, searchCalls, searchWords, liveTranscript, withSpelled } from '../src/hikyaku/call-list.js';
import { editLine, ORIGINAL } from '../src/hikyaku/transcript-edit.js';
import { validateCallId } from '../desktop/ipc-validation.js';

test('missing speech models show a failed transcript without a pending cloud send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-speech-missing-'));
  const id = '2026-10-12-1842-test';
  const folder = join(root, 'calls', id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'Test' }));
  await writeFile(join(folder, 'stop.log'), 'missing NVIDIA model /models/MISSING.gguf');
  const [row] = await listCalls({ home: root });
  assert.equal(row.state, 'failed');
  assert.equal(row.run, null);
  assert.match(row.reason, /recording is saved/);
  await writeFile(join(folder, 'transcript.md'), '# Recovered transcript');
  assert.equal((await listCalls({ home: root }))[0].state, 'done');
});

test('stamps: one time, lists and ranges take the first, hours count, ?? is none', () => {
  assert.equal(parseStamp('[04:42]'), 282);
  assert.equal(parseStamp('[04:42, 05:10]'), 282);
  assert.equal(parseStamp('[00:00–59:14]'), 0);
  assert.equal(parseStamp('[1:02:03]'), 3723);
  assert.equal(parseStamp('[170:25]'), 10225);
  assert.equal(parseStamp('[??:??]'), null);
});

test('a bullet of either format gives its text, owner, minute and not-sure', () => {
  assert.deepEqual(parseBullet('- Send the deck to Lena (Me (Lena)) [12:34] (not sure)'), { text: 'Send the deck to Lena', owner: 'Me (Lena)', at: 754, unsure: true, why: '' });
  assert.deepEqual(parseBullet('- **share the team list** (Speaker 2 (Yuki))  _not sure: quote not found in transcript_'), { text: 'share the team list', owner: 'Speaker 2 (Yuki)', at: null, unsure: true, why: 'quote not found in transcript' });
  assert.equal(parseBullet('- Acme (unclear) Bank grows lending [03:00]').text, 'Acme (unclear) Bank grows lending');
  assert.equal(parseBullet('- Acme (unclear) Bank grows lending [03:00]').owner, null);
  assert.deepEqual(parseBullet('- Team leans one way [07:21, 08:13] [??:??] (not sure)'), { text: 'Team leans one way', owner: null, at: 441, unsure: true, why: '' });
  assert.equal(parseBullet('- Bots handle retrieval [09:30, 30:44] [08:13]').at, 493);
});

test('filler lines the model writes when it found nothing are dropped', () => {
  assert.ok(isFiller('No explicit next step recorded in transcript'));
  assert.ok(isFiller('No explicit decisions or work agreements were stated during the call.'));
  assert.ok(!isFiller('Note the decisions from Monday'));
});

test('a summary splits into sections and next steps; mine is "Me" or my first name; checks give the reason', () => {
  const md = ['# Weekly sync', '_summary by a model_', '', '## The role', '- Team owns the roadmap [02:00]', '- Start is flexible [05:00] (not sure)',
    '', '## Next Steps', '- Send the deck (Lena) [12:34]', '- Share the team list (Yuki) [25:00]', '- No explicit next step recorded [??:??]'].join('\n');
  const checks = [{ section: 'The role', text: 'Start is flexible', backed: false, why: 'quote not said within 30 s of the stamp' }];
  const { sections, steps } = parseSummary(md, { me: 'Lena Park', checks });
  assert.equal(sections.length, 1);
  assert.equal(sections[0].lines[1].why, 'Words not found near that minute');
  assert.deepEqual(steps.map((s) => [s.text, s.mine, s.who]), [['Send the deck', true, 'Lena'], ['Share the team list', false, 'Yuki']]);
});

test('transcript lines keep their minute and speaker', () => {
  assert.deepEqual(parseTranscript('[00:05] Me: hello there\n[01:10] Speaker 2: hi: yes\nnoise'), [{ at: 5, who: 'Me', text: 'hello there' }, { at: 70, who: 'Speaker 2', text: 'hi: yes' }]);
});

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-calls-'));
  const call = async (id, files) => {
    await mkdir(join(root, 'calls', id), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(root, 'calls', id, name.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(root, 'calls', id, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
  };
  await call('2026-10-09-1300-weekly-sync', {
    'event.json': { title: 'Weekly sync', start: '2026-10-09T17:00:00Z', emails: ['lena@example.com'], me: 'Yuki', workstream: 'none', filed: { workstream: 'Acme Bank' } },
    'transcript.md': '# Weekly sync\n\nFriday, October 9, 2026, 13:00, 33 min. Me (Yuki) and Them.\n',
    'transcript-timed.txt': '[12:34] Me: I will send the deck\n',
    'summary-runs.json': [{ output: 'summary-nebius.md', created: '2026-10-09T18:00:00Z', checks: [] }, { output: 'summary-nebius-2.md', created: '2026-10-09T19:00:00Z', checks: [] }],
    'summary-nebius.md': '# Weekly sync\n\n## Next Steps\n- Send the deck (Yuki) [12:34]\n',
    'summary-nebius-2.md': '',
    'my-notes.md': 'deck by friday',
  });
  await call('2026-10-08-0900-coffee', { 'event.json': { title: 'Coffee', workstream: 'none' }, 'transcript.md': '# Coffee\n\nThursday, 9:00, 21 min.\n' });
  await call('2026-10-07-1600-readout', { 'event.json': { title: 'Readout', start: '2026-10-07T20:00:00Z', end: '2026-10-07T20:55:00Z', workstream: 'Hotel' }, 'transcript.md': '# Readout\n' });
  await call('2026-10-06-1000-live', { 'event.json': { title: 'Live one', workstream: 'none' } });
  await call('2026-10-05-1000-stopped', { 'event.json': { title: 'Stopped', workstream: 'none' }, 'stop.log': '' });
  await mkdir(join(root, 'calls', 'not-a-call'), { recursive: true });
  await writeFile(join(root, 'calls', 'current.json'), JSON.stringify({ dir: join(root, 'calls', '2026-10-06-1000-live') }));
  await mkdir(join(root, 'runs', 'run_a'), { recursive: true });
  await writeFile(join(root, 'runs', 'run_a', 'send.json'), JSON.stringify({ run: 'run_a', what: 'call-notes', status: 'pending', created: '2026-10-07T21:00:00Z', folder: join(root, 'calls', '2026-10-07-1600-readout') }));
  await writeFile(join(root, 'changes.jsonl'), `${JSON.stringify({ id: 'call:2026-10-08-0900-coffee@none', source: 'call', thread: '2026-10-08-0900-coffee', workstream: null, candidates: ['Hotel', 'Acme Bank'] })}\n`);
  return root;
}

test('every call is listed newest first with its state, minutes, workstream and guess', async () => {
  const rows = await listCalls({ home: await home() });
  assert.deepEqual(rows.map((r) => [r.id.slice(11), r.state, r.minutes, r.workstream, r.guess]), [
    ['1300-weekly-sync', 'done', 33, 'Acme Bank', null],
    ['0900-coffee', 'done', 21, null, 'Hotel'],
    ['1600-readout', 'waiting', 55, 'Hotel', null],
    ['1000-live', 'recording', null, null, null],
    ['1000-stopped', 'transcribing', null, null, null],
  ]);
  assert.equal(rows[2].run, 'run_a');
  assert.equal(rows[0].people, 2);
});

test('an opened call reads the newest summary that is not empty, ties my step to its move, and carries my notes', async () => {
  const root = await home();
  const tasks = [{ id: 'task_9', title: 'Send the deck', sourceId: 'call:2026-10-09-1300-weekly-sync#1', status: 'waiting' }];
  const call = await callDetail({ home: root, id: '2026-10-09-1300-weekly-sync', tasks, retired: { task_9: { why: 'done' } } });
  assert.equal(call.summarized, true);
  assert.deepEqual(call.steps.map((s) => [s.text, s.mine, s.moveId, s.closed, s.at]), [['Send the deck', true, 'task_9', 'done', 754]]);
  assert.equal(call.notes, 'deck by friday');
  assert.equal(call.transcript.length, 1);
  await assert.rejects(callDetail({ home: root, id: '../etc' }), /Invalid call/);
});

test('an opened call asks who Them was only while code was unsure, and a renamed call says it is his title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-them-'));
  const id = '2026-10-27-1500-video-interview';
  const folder = join(root, 'calls', id);
  await mkdir(folder, { recursive: true });
  const unsure = { title: 'Video interview', title_by_hand: true, them_label: 'Them', them_found: { by: 'code', decided: false, choices: ['Tomas Reyes', 'Elena Ortiz', 'Ana Li', 'Extra One'], invite: null } };
  await writeFile(join(folder, 'event.json'), JSON.stringify(unsure));
  await writeFile(join(folder, 'transcript.md'), '# Video interview\n\n[00:01] Them: Hi.\n');
  const [row] = await listCalls({ home: root });
  assert.equal(row.titleByHand, true);
  assert.deepEqual((await callDetail({ home: root, id })).them, { label: 'Them', choices: ['Tomas Reyes', 'Elena Ortiz', 'Ana Li'], invite: null });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ ...unsure, them_found: { by: 'code', decided: false, choices: ['Elena Ortiz'], invite: 'Elena Ortiz' } }));
  assert.equal((await callDetail({ home: root, id })).them.invite, 'Elena Ortiz');
  for (const event of [{ ...unsure, them_label: 'Tomas Reyes', them_by_hand: true }, { ...unsure, them_label: 'Marcus Bell', them_found: { by: 'code', decided: true, choices: [] } }, { title: 'Old call' }]) {
    await writeFile(join(folder, 'event.json'), JSON.stringify(event));
    assert.equal((await callDetail({ home: root, id })).them, null, JSON.stringify(event));
  }
});

test('a call id cannot leave the calls folder', () => {
  for (const bad of ['../x', 'a/b', 'x'.repeat(121), '', 5]) assert.throws(() => validateCallId(bad), /Invalid call/);
  assert.equal(validateCallId('2026-10-09-1300-weekly-sync'), '2026-10-09-1300-weekly-sync');
});

test('a step worded differently from its move still finds it by shared words, and two steps never share one move', async () => {
  const root = await home();
  const id = '2026-10-09-1300-weekly-sync';
  await writeFile(join(root, 'calls', id, 'summary-nebius.md'), '# Weekly sync\n\n## Next Steps\n- Confirm the hackathon sign-up link is the 2026 one (Yuki) [12:34]\n- Send the deck (Yuki) [13:00]\n- Book the room (Yuki) [14:00]\n');
  const tasks = [
    { id: 'task_a', title: 'Check sign-up status for hackathon (2025 vs 2026)', sourceId: `call:${id}#1`, status: 'waiting' },
    { id: 'task_b', title: 'Send the deck', sourceId: `callstep:${id}:send-the-deck`, status: 'waiting' },
    { id: 'task_c', title: 'Plan the offsite', sourceId: `call:${id}#3`, status: 'waiting' },
  ];
  const call = await callDetail({ home: root, id, tasks });
  assert.deepEqual(call.steps.map((s) => s.moveId), ['task_a', 'task_b', null]);
});

test('Summarize again is offered only when my notes are newer than the summary', async () => {
  const { utimes } = await import('node:fs/promises');
  const root = await home();
  const id = '2026-10-09-1300-weekly-sync';
  const folder = join(root, 'calls', id);
  await utimes(join(folder, 'my-notes.md'), new Date('2026-10-09T18:00:00Z'), new Date('2026-10-09T18:00:00Z'));
  await utimes(join(folder, 'summary-nebius.md'), new Date('2026-10-09T19:00:00Z'), new Date('2026-10-09T19:00:00Z'));
  assert.equal((await callDetail({ home: root, id })).notesNewer, false);
  await utimes(join(folder, 'my-notes.md'), new Date('2026-10-09T20:00:00Z'), new Date('2026-10-09T20:00:00Z'));
  assert.equal((await callDetail({ home: root, id })).notesNewer, true);
});

// The notes as they are written (2026-10-12): only whole lines, the cited quote cut, the minute kept.
test('a draft shows whole lines only, without the quotes the AI cites', () => {
  const draft = parseDraft('## Plans\n- Ship the demo [01:00] "we ship the demo" / [01:05] "yes"\n- Record the vid', { me: 'Gio' });
  assert.deepEqual(draft.sections, [{ heading: 'Plans', lines: [{ text: 'Ship the demo', owner: null, at: 60, unsure: false, why: '' }] }]);
  const more = parseDraft('## Plans\n- Ship it [01:00] "ship it" <!-- ship it -->\n\n## Next Steps\n- Record the video (Gio) [02:00] "record"\n- Send the link (Amri', { me: 'Gio' });
  assert.deepEqual(more.steps.map((step) => [step.text, step.mine]), [['Record the video', true]]);
  assert.equal(parseDraft('').sections.length, 0);
});

// The page's fast look while a call records (proposal-live-stream.md): the live file alone, cleaned like the full read.
test('the live transcript alone is read for the fast look, and stops once the full transcript exists', async () => {
  const root = await home();
  const id = '2026-10-14-0900-streaming';
  await mkdir(join(root, 'calls', id, 'live'), { recursive: true });
  await writeFile(join(root, 'calls', id, 'live', 'transcript-live.md'), '[00:01] Them: Um, so so the plan is.\n\n[00:03] Me: Yes\n');
  const live = await liveTranscript({ home: root, id });
  assert.deepEqual(live.transcript.map((turn) => [turn.at, turn.who, turn.raw]), [[1, 'Them', 'Um, so so the plan is.'], [3, 'Me', 'Yes']]);
  assert.notEqual(live.transcript[0].text, live.transcript[0].raw);   // cleaned for reading, as callDetail does
  await writeFile(join(root, 'calls', id, 'transcript.md'), '[00:01] Them: The plan.\n');
  assert.equal(await liveTranscript({ home: root, id }), null);
  await assert.rejects(liveTranscript({ home: root, id: '../x' }), /Invalid call/);
});

test('a call being recorded shows the live lines; a call being written shows its draft', async () => {
  const root = await home();
  await mkdir(join(root, 'calls', '2026-10-06-1000-live', 'live'), { recursive: true });
  await writeFile(join(root, 'calls', '2026-10-06-1000-live', 'live', 'transcript-live.md'), '[00:04] Me: Alright. Let us go.\n\n[00:09] Them: Yes.\n');
  const live = await callDetail({ home: root, id: '2026-10-06-1000-live' });
  assert.equal(live.state, 'recording');
  assert.equal(live.transcriptLive, true);
  assert.equal(live.transcriptEditable, false, 'a live line is not the transcript yet');
  assert.deepEqual(live.transcript.map((line) => line.text), ['Alright. Let us go.', 'Yes.']);

  const id = '2026-10-08-0900-coffee';
  await mkdir(join(root, 'runs', 'run_b'), { recursive: true });
  await writeFile(join(root, 'runs', 'run_b', 'send.json'), JSON.stringify({ run: 'run_b', what: 'call-notes', status: 'sending', created: '2026-10-09T21:00:00Z', folder: join(root, 'calls', id) }));
  await writeFile(join(root, 'calls', id, 'summary-live.md'), '## Coffee plans\n- Meet again Friday [00:30] "friday"\n- Bring the');
  const writing = await callDetail({ home: root, id });
  assert.equal(writing.state, 'writing');
  assert.deepEqual(writing.draft.sections.map((section) => section.lines.map((line) => line.text)), [['Meet again Friday']]);
  assert.equal((await callDetail({ home: root, id: '2026-10-09-1300-weekly-sync' })).draft, null, 'a call that is not being written has no draft');
});

test('a fixed transcript line is saved in transcript.md, the original kept once, and the notes say they are behind', async () => {
  const { readFile: read, utimes } = await import('node:fs/promises');
  const root = await home();
  const id = '2026-10-09-1300-weekly-sync';
  const folder = join(root, 'calls', id);
  await writeFile(join(folder, 'transcript.md'), '# Weekly sync\n\nFriday.\n\n[00:05] Me: we ship on frieday (unclear)\n\n[00:09] Them: ok\n');
  await utimes(join(folder, 'transcript.md'), new Date('2026-10-09T17:00:00Z'), new Date('2026-10-09T17:00:00Z'));
  const before = await callDetail({ home: root, id });
  assert.equal(before.transcriptEditable, true);
  assert.equal(before.transcriptNewer, false);
  assert.deepEqual(await editLine({ home: root, id, index: 0, text: '  we ship on   Friday ' }), { changed: true, index: 0, text: 'we ship on Friday' });
  assert.equal(await read(join(folder, 'transcript.md'), 'utf8'), '# Weekly sync\n\nFriday.\n\n[00:05] Me: we ship on Friday\n\n[00:09] Them: ok\n');
  await editLine({ home: root, id, index: 1, text: 'okay' });
  assert.match(await read(join(folder, ORIGINAL), 'utf8'), /frieday \(unclear\)/, 'the first edit keeps the original, the second does not overwrite it');
  const after = await callDetail({ home: root, id });
  assert.deepEqual(after.transcript.map((line) => line.text), ['We ship on Friday', 'Okay'], 'shown cleaned (clean-said.js)');
  assert.deepEqual(after.transcript.map((line) => line.raw), ['we ship on Friday', 'okay'], 'and as said, for Exact words');
  assert.equal(after.transcriptNewer, true);
  assert.deepEqual(await editLine({ home: root, id, index: 1, text: 'okay' }), { changed: false, index: 1, text: 'okay' });
  await assert.rejects(editLine({ home: root, id, index: 5, text: 'x' }), /not in this transcript/);
  await assert.rejects(editLine({ home: root, id, index: 0, text: '   ' }), /needs words/);
  await assert.rejects(editLine({ home: root, id: '2026-10-06-1000-live', index: 0, text: 'x' }), /no transcript to edit/);
});

// Search (2026-10-12): every word, any order, any case; "(unclear)" marks do not get in the way; a title or notes match
// lists the call with no lines.
test('search finds the lines that say every word typed, in every call', async () => {
  const root = await home();
  const id = '2026-10-09-1300-weekly-sync';
  await writeFile(join(root, 'calls', id, 'transcript.md'), '# Weekly sync\n\n[00:05] Me: the demo is three minutes (unclear) long\n\n[00:09] Them: Three MINUTES, ok\n\n[00:12] Me: minutes later\n');
  assert.deepEqual(searchWords('  Three  three a 3 '), ['three', '3']);
  const found = await searchCalls({ home: root, query: 'minutes three' });
  assert.deepEqual(found.map((call) => [call.id, call.count, call.hits.map((hit) => hit.index)]), [[id, 2, [0, 1]]]);
  assert.equal(found[0].hits[0].text, 'The demo is three minutes long', 'the unclear mark is not in the line shown');
  assert.deepEqual((await searchCalls({ home: root, query: 'deck friday' })).map((call) => [call.id, call.count]), [[id, 0]], 'my notes say it, no line does');
  assert.deepEqual(await searchCalls({ home: root, query: ' ' }), []);
});

// One appearance (2026-10-12): the page shows a checked point as the draft did, without the quote byo.py records.
test('a checked point shows without its recorded quote; a short quoted name and a point in parentheses stay', () => {
  assert.equal(parseBullet('- Drop Enterprise; build B2C for normies "we shouldn\'t do Enterprise because" [00:04] (not sure)').text, 'Drop Enterprise; build B2C for normies');
  assert.equal(parseBullet('- License pending "No, we haven\'t got it" / "Yeah, we should do it" [10:26]').text, 'License pending');
  assert.equal(parseBullet('- Target the "8 GB normies" [02:30]').text, 'Target the "8 GB normies"');
  const { sections } = parseSummary('## Demo\n- Invite flow (type "invite") [15:50]\n  - Under 30 seconds [15:52]\n');
  assert.deepEqual(sections[0].lines.map((line) => [line.text, line.owner, Boolean(line.detail)]), [['Invite flow (type "invite")', null, false], ['Under 30 seconds', null, true]]);
});

// Click to learn more (2026-10-12): a point not confirmed carries the AI's read of it; your "It's right" or "Fix it"
// (note-marks.js) clears it; Undo brings it back; the summary file is never changed.
test('a point not confirmed carries its explanation, and your answer clears it until undone', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const { markLine } = await import('../src/hikyaku/note-marks.js');
  const root = await home();
  const id = '2026-10-09-1300-weekly-sync';
  const folder = join(root, 'calls', id);
  await writeFile(join(folder, 'summary-nebius.md'), '# Weekly sync\n\n## Plans\n- Ship by June [05:00] (not sure)\n- Demo is three minutes [06:00]\n\n## Next Steps\n- Send the deck (Yuki) [12:34] (not sure)\n');
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', created: '2026-10-09T18:00:00Z', checks: [] }]));
  await writeFile(join(folder, 'summary-nebius-explain.json'), JSON.stringify({ output: 'summary-nebius.md', lines: [{ text: 'Ship by June', context: 'June was never said; Friday was.', said: [{ text: 'We ship it on Friday.', who: 'Them', at: '05:02' }] }, { text: 'Send the deck', context: '', said: [] }] }));
  await writeFile(join(folder, 'summary-runs.json'), JSON.stringify([{ output: 'summary-nebius.md', created: '2026-10-09T18:00:00Z', checks: [{ text: 'Demo is three minutes', line: '[06:00] Me: the demo is three minutes (unclear) long' }] }]));
  let call = await callDetail({ home: root, id });
  assert.deepEqual(call.sections[0].lines.map((line) => [line.text, line.unsure, line.source.context, line.source.said]), [
    ['Ship by June', true, 'June was never said; Friday was.', [{ text: 'We ship it on Friday.', who: 'Them', at: 302 }]],
    ['Demo is three minutes', false, '', [{ text: 'The demo is three minutes long', who: 'You', at: 360 }]]]);
  assert.deepEqual(call.steps[0].source.said, [], 'no quote found: nothing said is shown');
  await markLine({ home: root, id, text: 'Ship by June', action: 'right' });
  await markLine({ home: root, id, text: 'Send the deck', action: 'fix', value: 'Send Lena the deck tonight' });
  call = await callDetail({ home: root, id });
  assert.deepEqual([call.sections[0].lines[0].unsure, call.sections[0].lines[0].confirmed], [false, true]);
  assert.deepEqual([call.steps[0].text, call.steps[0].original, call.steps[0].unsure], ['Send Lena the deck tonight', 'Send the deck', false]);
  await markLine({ home: root, id, text: 'Ship by June', action: 'undo' });
  assert.equal((await callDetail({ home: root, id })).sections[0].lines[0].unsure, true);
  assert.match(await read(join(folder, 'summary-nebius.md'), 'utf8'), /Ship by June \[05:00\] \(not sure\)/, 'the record is never changed');
  await assert.rejects(markLine({ home: root, id, text: 'Ship by June', action: 'fix', value: '  ' }), /1 to 500/);
  await assert.rejects(markLine({ home: root, id, text: 'Ship by June', action: 'delete' }), /Unknown answer/);
});

// "Draft it" only on a step that is a message to someone (2026-10-12), read from the step's own words.
test('a next step is a message when its words say so, and the name after the verb is who it goes to', async () => {
  const { messageOf } = await import('../src/hikyaku/call-list.js');
  const cases = [
    ['Create hackathon team, handle license, invite Jules', { to: 'Jules' }],
    ['Email Lena the deck', { to: 'Lena' }],
    ['Send the deck to Sam Park tonight', { to: 'Sam Park' }],
    ['Follow up with the recruiter', { to: null }],
    ['Thank Dana for the intro', { to: 'Dana' }],
    ['Share the team list with Nina', { to: 'Nina' }],
    ['Ask Jamie about the start date', { to: 'Jamie' }],
    ['Finish UI button-by-button test and make every link clickable', null],
    ['Draft three-minute demo storyboard in agreed order', null],
    ['Build one-click permission/API-key repair flow', null],
    ['Send updates on Friday', null],
    ['Update the API key flow', null],
  ];
  for (const [text, want] of cases) assert.deepEqual(messageOf(text), want, text);
});

// Poka-yoke (loggie-meetings-focus cycle 2): a guess carries the words that back it, read from what was said or who
// was on the call; with none it is not shown as a guess (2026-10-24: "M&T Bank Outreach" on a hackathon call whose only
// clue was the title "Meeting 3:25 PM").
test('a guess carries its evidence: the workspace said in the call, or a person on it; none, no evidence', async () => {
  const root = await home();
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([
    { name: 'Hotel', words: ['hotel', 'guest stay'], domains: [], people: [] },
    { name: 'Acme Bank', words: ['acme'], domains: [], people: [{ name: 'Sam Lee', address: 'sam@acme.example' }] },
  ]));
  await writeFile(join(root, 'calls', '2026-10-08-0900-coffee', 'transcript.md'), 'Them: The hotel data is late. Me: Hotel scores first. Them: Every hotel in the set, and the guest stay length.\n');
  let coffee = (await listCalls({ home: root })).find((r) => r.id.endsWith('0900-coffee'));
  assert.equal(coffee.evidence, 'said “Hotel” 3 times');
  await writeFile(join(root, 'calls', '2026-10-08-0900-coffee', 'transcript.md'), 'Them: nothing to see.\n');
  coffee = (await listCalls({ home: root })).find((r) => r.id.endsWith('0900-coffee'));
  assert.equal(coffee.evidence, '', 'said once or never: no evidence');
  await writeFile(join(root, 'changes.jsonl'), `${JSON.stringify({ id: 'call:2026-10-08-0900-coffee@none', source: 'call', thread: '2026-10-08-0900-coffee', workstream: null, candidates: ['Acme Bank'] })}\n`);
  const event = JSON.parse(await readFile(join(root, 'calls', '2026-10-08-0900-coffee', 'event.json'), 'utf8'));
  await writeFile(join(root, 'calls', '2026-10-08-0900-coffee', 'event.json'), JSON.stringify({ ...event, emails: ['sam@acme.example'] }));
  coffee = (await listCalls({ home: root })).find((r) => r.id.endsWith('0900-coffee'));
  assert.equal(coffee.evidence, 'Sam Lee is on it');
});

test('a recording filed under a retired workspace says so, and keeps the name', async () => {
  const root = await home();
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([{ name: 'Acme Bank', words: [], domains: [], retired: '2026-10-26T12:00:00Z' }, { name: 'Hotel', words: [], domains: [] }]));
  const rows = await listCalls({ home: root });
  const acme = rows.find((r) => r.workstream === 'Acme Bank');
  assert.equal(acme.retired, true);
  assert.equal(rows.find((r) => r.workstream === 'Hotel').retired, undefined);
});

test('spellings made on their own reach the page as `auto`, less any kept as heard', () => {
  const spelled = { MNT: { to: 'M&T', rule: 'ampersand', source: 'workspace "M&T Bank"' }, MT: { to: 'M&T', rule: 'ampersand', source: 'workspace "M&T Bank"' } };
  assert.equal(withSpelled(null, null), null);
  assert.deepEqual(withSpelled(null, spelled).auto, spelled, 'no name check yet: a record to draw them from');
  const check = { v: 1, status: 'done', words: { Kwalt: { kind: 'fix', to: 'Qualtrics' } }, accepted: {}, kept: { MT: true } };
  const out = withSpelled(check, spelled);
  assert.deepEqual(Object.keys(out.auto), ['MNT'], 'MT was kept as heard with ✕');
  assert.deepEqual(out.words, check.words, 'the name check itself is untouched');
});

// The call's time is the press (recorded_at, call.py start, 2026-10-27): a call pressed at 14:58 for the 15:00 meeting
// says 14:58 on its row and joins the week by it, never the 14:30 start of the block it was once named after.
test('1D a call row starts at the press, and carries the event it was pressed on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-recorded-at-'));
  const id = '2026-10-27-1458-video-meeting-with-example-bank';
  await mkdir(join(root, 'calls', id), { recursive: true });
  await writeFile(join(root, 'calls', id, 'event.json'), JSON.stringify({ title: 'Video Meeting with Example Bank', start: '2026-10-27T14:30:00-04:00', recorded_at: '2026-10-27T14:58:07-04:00', id: 'mt-exchange' }));
  const [row] = await listCalls({ home: root });
  assert.deepEqual([row.start, row.eventId], ['2026-10-27T14:58:07-04:00', 'mt-exchange']);
});

// Before recorded_at (2026-10-28): the folder name is the press, so an old call pressed at 12:54 for the 11:40 class says 12:54.
test('1D an old call with no recorded_at starts at its folder name, not the event it was named after', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loggie-folder-time-'));
  const id = '2026-10-27-1254-macro-class';
  await mkdir(join(root, 'calls', id), { recursive: true });
  await writeFile(join(root, 'calls', id, 'event.json'), JSON.stringify({ title: 'Macro class', start: '2026-10-27T11:40:00-04:00' }));
  const [row] = await listCalls({ home: root });
  assert.equal(row.start, new Date(2026, 9, 27, 12, 54).toISOString());
});
