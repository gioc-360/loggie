// Speech in the background (cloud-first C7, plan 4.1): the speech engine and the two speech files download on first
// launch, resume after a dropped connection, are checked against a sha256 before they are used, and say how far they
// are on a panel card. Email and calendar never wait for them. A fake fetch stands in for the network: no real download,
// temp folders only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkEvents, emitEvent, NAMES_A_MODEL, readEvents, TYPES } from '../src/hikyaku/events.js';
import { createMeetingWatch } from '../src/hikyaku/meeting-watch.js';
import { downloadSpeech, readManifest, speechStatus } from '../src/hikyaku/speech-download.js';
import { applyEvent, notifyEvent, surfaceFor } from '../desktop/renderer/meeting-cards.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (path) => access(path).then(() => true, () => false);
const bytesOf = (size, seed) => Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed) % 251);

// Two small "models" and one "engine" archive, each with its url, sha256 and size, in the manifest's shape.
const FILES = { 'https://example.org/a.gguf': bytesOf(5000, 1), 'https://example.org/b.gguf': bytesOf(3000, 2), 'https://example.org/engine.tar.gz': bytesOf(1000, 3) };
const manifestOf = (files = FILES) => ({
  version: 1,
  items: [
    { id: 'engine', kind: 'engine', url: 'https://example.org/engine.tar.gz', sha256: sha(files['https://example.org/engine.tar.gz']), size: files['https://example.org/engine.tar.gz'].length,
      dest: 'downloads/engine.tar.gz', provides: 'nemo-speech/engine/bin/engine', extractTo: 'nemo-speech' },
    { id: 'words', kind: 'model', url: 'https://example.org/a.gguf', sha256: sha(files['https://example.org/a.gguf']), size: files['https://example.org/a.gguf'].length,
      dest: 'hf/models--org--a/snapshots/rev1/a.gguf', provides: 'hf/models--org--a/snapshots/*/a.gguf' },
    { id: 'second', kind: 'model', url: 'https://example.org/b.gguf', sha256: sha(files['https://example.org/b.gguf']), size: files['https://example.org/b.gguf'].length,
      dest: 'hf/models--org--b/snapshots/rev1/b.gguf', provides: 'hf/models--org--b/snapshots/*/b.gguf' },
  ],
});
const TOTAL = 5000 + 3000 + 1000;

// A fake fetch that serves FILES in 700-byte chunks and honours Range, like the real servers. `served` counts bytes sent.
function fakeFetch({ files = FILES, ignoreRange = false, corrupt = null, fail = null } = {}) {
  const log = { requests: [], served: 0 };
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.Range || options.headers?.range || null;
    log.requests.push({ url, range });
    if (fail && fail(url, log)) throw new TypeError('fetch failed');
    let body = files[url];
    if (!body) return new Response('', { status: 404 });
    if (corrupt === url) body = body.map((byte) => byte ^ 1);
    const start = range && !ignoreRange ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const part = body.slice(start);
    log.served += part.length;
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < part.length; i += 700) controller.enqueue(part.slice(i, i + 700)); controller.close(); } });
    return new Response(stream, { status: start > 0 ? 206 : 200, headers: { 'content-length': String(part.length) } });
  };
  return { fetchImpl, log };
}
// extract(archive, into): unpack the engine; here it writes the file the manifest says the engine provides.
const fakeExtract = async (archive, into) => {
  await mkdir(join(into, 'engine', 'bin'), { recursive: true });
  await writeFile(join(into, 'engine', 'bin', 'engine'), `unpacked from ${(await readFile(archive)).length} bytes`);
};
const root = () => mkdtemp(join(tmpdir(), 'hikyaku-download-'));
const collect = () => { const events = []; return { events, emit: async (event) => { events.push(event); } }; };

// --- the real manifest
test('the manifest lists the engine and the two speech files with real https urls, sha256s and sizes', async () => {
  const manifest = await readManifest();
  assert.deepEqual(manifest.items.map((item) => item.id), ['engine', 'parakeet', 'nemotron']);
  for (const item of manifest.items) {
    assert.match(item.url, /^https:\/\/(github\.com|huggingface\.co)\//, item.id);
    assert.match(item.sha256, /^[0-9a-f]{64}$/, item.id);
    assert.ok(Number.isInteger(item.size) && item.size > 0, item.id);
    assert.doesNotMatch(JSON.stringify(item), /TODO|example\.|placeholder/i, item.id);
  }
  const model = manifest.items.find((item) => item.id === 'parakeet');
  assert.match(model.url, /\/resolve\/[0-9a-f]{40}\/parakeet-tdt-0\.6b-v3\.q8_0\.gguf$/, 'pinned to one revision');
  assert.equal(model.dest, 'hf/models--nvidia--parakeet-tdt-0.6b-v3/snapshots/' + /resolve\/([0-9a-f]{40})/.exec(model.url)[1] + '/parakeet-tdt-0.6b-v3.q8_0.gguf', 'where nvidia_engine.py looks');
  assert.ok(manifest.items.reduce((sum, item) => sum + item.size, 0) > 1.4e9);
});

// --- download, verify, events
test('a fresh download writes each file, checks it, unpacks the engine, and reports progress up to ready', async () => {
  const dir = await root();
  const { fetchImpl } = fakeFetch();
  const { events, emit } = collect();
  const manifest = manifestOf();
  assert.deepEqual((await speechStatus({ root: dir, manifest })), { ready: false, missing: ['engine', 'words', 'second'] });
  await downloadSpeech({ root: dir, manifest, fetchImpl, emit, extract: fakeExtract, everyBytes: 1000 });
  assert.deepEqual(await speechStatus({ root: dir, manifest }), { ready: true, missing: [] });
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf'))), FILES['https://example.org/a.gguf']);
  assert.ok(await exists(join(dir, 'nemo-speech/engine/bin/engine')));
  assert.ok(!(await exists(join(dir, 'downloads/engine.tar.gz'))), 'the archive is removed once unpacked');
  assert.ok(!(await readdir(join(dir, 'hf/models--org--a/snapshots/rev1'))).some((name) => name.endsWith('.part')));
  const progress = events.filter((event) => event.type === 'setup.download');
  assert.equal(progress.length, events.length);
  assert.ok(progress.length >= 5, 'more than the start and the end');
  assert.deepEqual(progress[0].data, { done_bytes: 0, total_bytes: TOTAL, state: 'downloading' });
  const done = progress.map((event) => event.data.done_bytes);
  assert.deepEqual(done, [...done].sort((a, b) => a - b), 'progress only goes forward');
  assert.deepEqual(progress.at(-1).data, { done_bytes: TOTAL, total_bytes: TOTAL, state: 'ready' });
  assert.ok(progress.every((event) => !NAMES_A_MODEL.test(event.text)), 'the text names no model');
});

test('setup.download passes the event contract, written by the real emitter', async () => {
  assert.deepEqual(TYPES['setup.download'], ['done_bytes', 'total_bytes']);
  const dir = await root();
  const run = '20261008-120000-abcd';
  const { fetchImpl } = fakeFetch();
  await downloadSpeech({ root: dir, manifest: manifestOf(), fetchImpl, emit: (event) => emitEvent(join(dir, 'runs', run), event), extract: fakeExtract, everyBytes: 2000 });
  const events = await readEvents(join(dir, 'runs', run));
  assert.ok(events.length >= 3);
  assert.ok(checkEvents(events).ok, JSON.stringify(checkEvents(events)));
});

test('a partial file resumes with a Range request and only the rest is fetched', async () => {
  const dir = await root();
  const manifest = manifestOf();
  const partial = join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf.part');
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(partial, FILES['https://example.org/a.gguf'].slice(0, 3000));
  const { fetchImpl, log } = fakeFetch();
  const { events, emit } = collect();
  await downloadSpeech({ root: dir, manifest, fetchImpl, emit, extract: fakeExtract, everyBytes: 1000 });
  assert.deepEqual(log.requests.find((request) => request.url.endsWith('a.gguf')), { url: 'https://example.org/a.gguf', range: 'bytes=3000-' });
  assert.equal(log.served, TOTAL - 3000, 'the 3000 bytes already on disk are not fetched again');
  assert.equal(events[0].data.done_bytes, 3000, 'the card starts where the last run stopped');
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf'))), FILES['https://example.org/a.gguf']);
});

test('a server that ignores Range sends the whole file and the download starts that file over', async () => {
  const dir = await root();
  const partial = join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf.part');
  await mkdir(dirname(partial), { recursive: true });
  await writeFile(partial, FILES['https://example.org/a.gguf'].slice(0, 3000));
  const { fetchImpl } = fakeFetch({ ignoreRange: true });
  await downloadSpeech({ root: dir, manifest: manifestOf(), fetchImpl, emit: async () => {}, extract: fakeExtract });
  assert.deepEqual(new Uint8Array(await readFile(join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf'))), FILES['https://example.org/a.gguf']);
});

test('a dropped connection leaves the part file, says paused, and the next run resumes it', async () => {
  const dir = await root();
  const manifest = manifestOf();
  let cut = true;
  const real = fakeFetch();
  const fetchImpl = async (url, options) => {
    const response = await real.fetchImpl(url, options);
    if (!cut || !url.endsWith('a.gguf')) return response;
    const reader = response.body.getReader();
    let sent = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      const { value, done } = await reader.read();
      if (done) return controller.close();
      if (sent >= 2100) return controller.error(new TypeError('terminated'));
      sent += value.length; controller.enqueue(value);
    } }), { status: response.status });
  };
  const first = collect();
  await assert.rejects(downloadSpeech({ root: dir, manifest, fetchImpl, emit: first.emit, extract: fakeExtract, everyBytes: 500 }), /terminated|dropped|interrupted/);
  assert.equal(first.events.at(-1).data.state, 'paused');
  const left = await readFile(join(dir, 'hf/models--org--a/snapshots/rev1/a.gguf.part'));
  assert.ok(left.length > 0 && left.length < 5000, 'the bytes that arrived are kept');
  cut = false;
  const second = collect();
  await downloadSpeech({ root: dir, manifest, fetchImpl, emit: second.emit, extract: fakeExtract, everyBytes: 500 });
  assert.equal(second.events.at(-1).data.state, 'ready');
  assert.equal(real.log.requests.filter((request) => request.url.endsWith('a.gguf')).at(-1).range, `bytes=${left.length}-`);
});

test('a file that does not match its sha256 is refused and deleted, nothing is left to use, and the card says paused', async () => {
  const dir = await root();
  const manifest = manifestOf();
  const { fetchImpl } = fakeFetch({ corrupt: 'https://example.org/a.gguf' });
  const { events, emit } = collect();
  await assert.rejects(downloadSpeech({ root: dir, manifest, fetchImpl, emit, extract: fakeExtract }), /did not match/);
  const folder = join(dir, 'hf/models--org--a/snapshots/rev1');
  assert.deepEqual(await readdir(folder).catch(() => []), [], 'neither the file nor its part is kept');
  assert.equal(events.at(-1).data.state, 'paused');
  assert.equal((await speechStatus({ root: dir, manifest })).ready, false);
});

test('files already on the Mac, even from another revision, are not fetched again and no event is written', async () => {
  const dir = await root();
  const manifest = manifestOf();
  const { fetchImpl, log } = fakeFetch();
  await downloadSpeech({ root: dir, manifest, fetchImpl, emit: async () => {}, extract: fakeExtract });
  await mkdir(join(dir, 'hf/models--org--a/snapshots/rev0'), { recursive: true });
  const { events, emit } = collect();
  const before = log.requests.length;
  await downloadSpeech({ root: dir, manifest, fetchImpl, emit, extract: fakeExtract });
  assert.equal(log.requests.length, before);
  assert.deepEqual(events, []);
});

// --- the panel card and the offer
const downloadEvent = (done, total, state = 'downloading') => ({ type: 'setup.download', text: 'Getting meeting transcription ready', data: { done_bytes: done, total_bytes: total, state } });

test('the card says how many MB of how many, and that email and calendar work now', () => {
  const card = surfaceFor(downloadEvent(512e6, 1460e6));
  assert.equal(`${card.heading} ${card.body}`, 'Getting meeting transcription ready (512 of 1460 MB). Email and calendar work now.');
  assert.deepEqual(card.buttons, []);
  assert.equal(card.key, 'setup:download');
  const paused = surfaceFor(downloadEvent(512e6, 1460e6, 'paused'));
  assert.equal(`${paused.heading} ${paused.body}`, 'Meeting transcription is paused. Loggie will try again. Email and calendar work now.');
});

test('the card is one card that updates in place, and leaves when the download is ready', () => {
  let cards = applyEvent([], downloadEvent(100e6, 1460e6));
  cards = applyEvent(cards, downloadEvent(900e6, 1460e6));
  assert.equal(cards.length, 1);
  assert.match(cards[0].body, /^\(900 of 1460 MB\)/);
  assert.deepEqual(applyEvent(cards, downloadEvent(1460e6, 1460e6, 'ready')), []);
});

test('a download card never raises a system notification', () => {
  let made = 0;
  class Fake { constructor() { made += 1; } on() {} show() {} }
  assert.equal(notifyEvent(downloadEvent(1, 2), { Notification: Fake, isCollapsed: () => true, expand: () => {} }), false);
  assert.equal(made, 0);
});

const T0 = Date.parse('2026-10-01T14:00:00Z');
const MEETING = { id: 'e1', title: 'Chat with Sam', start: new Date(T0).toISOString(), end: new Date(T0 + 3600000).toISOString(), allDay: false, calendar: 'Calendar',
  account: 'me@example.org', writable: true, attendees: ['sam@example.org'], attendeeNames: ['Sam Example'], recurring: false, location: '', myStatus: 'accepted' };   // his invite (meeting.js isMine)

test('a meeting offer while speech is still downloading says so, a record press waits instead of failing, and works once it is ready', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-download-watch-'));
  const runs = [];
  let ready = false;
  const watch = createMeetingWatch({
    home, listEvents: async () => [MEETING], now: () => new Date(T0), log: () => {}, transcriber: async () => '/fake/spike', loggieDirectory: '/fake', speechReady: async () => ready,
    runner: async (command, args) => { runs.push([command, args]); return { code: 0, stdout: `Recording both sides to ${join(home, 'calls', 'c1')}\n`, stderr: '' }; },
  });
  await watch.poll();
  const offer = watch.state.live;
  const [run] = await readdir(join(home, 'runs'));
  const [offered] = await readEvents(join(home, 'runs', run));
  assert.equal(offered.type, 'meeting.offered');
  assert.equal(offered.text, 'Transcription is still downloading');
  assert.ok(checkEvents([offered]).ok);
  const blocked = await watch.answer(offer.offer_id, 'record');
  assert.deepEqual(blocked, { offer_id: offer.offer_id, answer: 'record', call: null, blocked: 'speech' });
  assert.deepEqual(runs, [], 'nothing started');
  assert.equal(watch.state.live?.offer_id, offer.offer_id, 'the offer stays for the next press');
  ready = true;
  const answered = await watch.answer(offer.offer_id, 'record');
  assert.equal(answered.call, 'c1');
  assert.equal(runs.length, 1);
});

test('with speech ready the offer keeps its usual text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hikyaku-download-watch-'));
  const watch = createMeetingWatch({ home, listEvents: async () => [MEETING], now: () => new Date(T0), log: () => {}, transcriber: async () => '/fake/spike', speechReady: async () => true });
  await watch.poll();
  const [run] = await readdir(join(home, 'runs'));
  assert.equal((await readEvents(join(home, 'runs', run)))[0].text, 'A meeting is starting. Transcribe it?');
});
