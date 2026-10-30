// File here (loggie-workspaces-integration F4): a routed thread moves to another workspace, the whole thread; the old
// workspace stops counting it and later messages in the thread follow it. Made-up chats only.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendChanges, readChanges } from '../src/hikyaku/changes.js';
import { threadMap } from '../src/hikyaku/router.js';
import { moveThread } from '../src/hikyaku/screen-data.js';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'file-here-'));
  await writeFile(join(root, 'workstreams.json'), JSON.stringify([
    { name: 'Karaoke Night', kind: 'other', domains: [], words: ['karaoke'] },
    { name: 'Hotel Hackathon', kind: 'other', domains: [], words: [] },
  ]));
  const chat = (n, at) => ({ source: 'messages', ref: `msg-${n}`, at, title: 'Hackathon squad', who: [{ name: 'Kim', handle: '+15550001' }], thread: 'chat-9', workstream: 'Karaoke Night', how: n === 1 ? 'word' : 'thread' });
  await appendChanges(root, [chat(1, '2026-10-21T10:00:00Z'), chat(2, '2026-10-22T10:00:00Z'), chat(3, '2026-10-23T10:00:00Z'),
    { source: 'messages', ref: 'msg-k', at: '2026-10-22T11:00:00Z', title: 'Karaoke crew', who: [], thread: 'chat-1', workstream: 'Karaoke Night', how: 'word' }]);
  return root;
}

test('the whole thread moves: the old workspace drops it, the target holds it, later messages follow', async () => {
  const root = await home();
  const result = await moveThread({ home: root, itemId: 'messages:msg-2', workstream: 'Hotel Hackathon' });
  assert.deepEqual(result, { moved: 3, from: 'Karaoke Night', to: 'Hotel Hackathon' });
  assert.deepEqual((await readChanges(root, { workstream: 'Karaoke Night' })).map((item) => item.ref), ['msg-k'], 'the other chat stays');
  assert.equal((await readChanges(root, { workstream: 'Hotel Hackathon' })).length, 3);
  const map = threadMap(await readChanges(root));
  assert.equal(map.get('messages:chat-9').workstream, 'Hotel Hackathon', 'the next message in the chat files there');
  assert.equal(map.get('messages:chat-1').workstream, 'Karaoke Night');
  // A message already seen is not appended again, though its line moved.
  assert.equal((await appendChanges(root, [{ source: 'messages', ref: 'msg-1', at: '2026-10-21T10:00:00Z', title: 'Hackathon squad', who: [], thread: 'chat-9', workstream: 'Karaoke Night', how: 'thread' }])).length, 0);
});

test('only a live workspace takes it; moving to where it is changes nothing', async () => {
  const root = await home();
  await assert.rejects(moveThread({ home: root, itemId: 'messages:msg-2', workstream: 'Nope' }), /No workspace named/);
  await assert.rejects(moveThread({ home: root, itemId: 'messages:none', workstream: 'Hotel Hackathon' }), /no longer in the list/);
  assert.equal((await moveThread({ home: root, itemId: 'messages:msg-2', workstream: 'Karaoke Night' })).moved, 0);
});
