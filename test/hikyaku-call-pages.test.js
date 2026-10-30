// Pages tucked into a recording (loggie-pause-attach I2): addPage copies a readable kind into <call>/pages/ under its
// own name, " 2" on a clash, and refuses other kinds, missing files and files over 50 MB; the listing carries the names.
// Temp folders only.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addPage, listPages, PAGE_KINDS, PAGE_KINDS_TEXT } from '../src/hikyaku/call-pages.js';
import { listCalls } from '../src/hikyaku/call-list.js';

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-pages-'));
  const folder = join(root, 'calls', '2026-10-28-1330-nba-6820');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'event.json'), JSON.stringify({ title: 'NBA 6820', recorded_at: '2026-10-28T13:30:00-04:00' }));
  const src = join(root, 'Week 8 slides.pdf');
  await writeFile(src, '%PDF-1.4 made up');
  return { root, folder, src };
}

test('a page is copied under its own name, a second one with the same name gets " 2"', async () => {
  const { folder, src } = await home();
  assert.deepEqual(await addPage({ folder, path: src }), { added: 'Week 8 slides.pdf', pages: ['Week 8 slides.pdf'] });
  assert.equal(await readFile(join(folder, 'pages', 'Week 8 slides.pdf'), 'utf8'), '%PDF-1.4 made up');
  assert.deepEqual((await addPage({ folder, path: src })).pages, ['Week 8 slides 2.pdf', 'Week 8 slides.pdf']);
});

test('a kind pages.py cannot read, a missing file and a folder are refused with a sentence', async () => {
  const { root, folder } = await home();
  await writeFile(join(root, 'photo.png'), 'x');
  await assert.rejects(addPage({ folder, path: join(root, 'photo.png') }), new RegExp(PAGE_KINDS_TEXT.replace(/[.,]/g, '.')));
  await assert.rejects(addPage({ folder, path: join(root, 'gone.pdf') }), /could not be found/);
  await mkdir(join(root, 'dir.pdf'));
  await assert.rejects(addPage({ folder, path: join(root, 'dir.pdf') }), /could not be found/);
  assert.deepEqual(await listPages(folder), []);
  assert.deepEqual(PAGE_KINDS, ['.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.md']);
});

test('the call listing carries its pages', async () => {
  const { root, folder, src } = await home();
  await addPage({ folder, path: src });
  const [row] = await listCalls({ home: root });
  assert.deepEqual(row.pages, ['Week 8 slides.pdf']);
});

// loggie-pages-anytime: a page tucked into a waiting call makes its send (screened at Stop, no hash for the page)
// unusable, so Summarize screens fresh; a page newer than the notes says so on the call (pagesNewer).
test('a page newer than the waiting send screens the call fresh before the yes', async () => {
  const { summarizeCall } = await import('../src/hikyaku/call-notes.js');
  const { utimes } = await import('node:fs/promises');
  const { root, folder, src } = await home();
  const id = '2026-10-28-1330-nba-6820';
  await mkdir(join(root, 'runs', '20261028-150000-aaaa'), { recursive: true });
  await writeFile(join(root, 'runs', '20261028-150000-aaaa', 'send.json'), JSON.stringify({ v: 1, run: '20261028-150000-aaaa', what: 'call-notes', status: 'pending', created: '2026-10-28T15:00:00Z', folder, outbound: [], sha256: [] }));
  const prepared = [];
  const prepare = async (options) => { prepared.push(options.fresh); return { run: '20261028-160500-bbbb' }; };
  const summarize = async (options) => ({ ok: true, run: options.run });
  assert.equal((await summarizeCall({ home: root, id, transcriber: '/fake', prepare, summarize })).run, '20261028-150000-aaaa', 'no page: the waiting send as it is');
  await addPage({ folder, path: src });
  await utimes(join(folder, 'pages', 'Week 8 slides.pdf'), new Date('2026-10-28T16:00:00Z'), new Date('2026-10-28T16:00:00Z'));
  assert.equal((await summarizeCall({ home: root, id, transcriber: '/fake', prepare, summarize })).run, '20261028-160500-bbbb');
  assert.deepEqual(prepared, [true], 'the page came after the send: screened again, fresh');
});

test('pagesNewer: a page after the summary says so, a summary after the page does not', async () => {
  const { utimes } = await import('node:fs/promises');
  const { root, folder, src } = await home();
  // the older notes shape (notes.md) is a summary too (call-list.js summaryOf), and its file time is the summary's
  await writeFile(join(folder, 'notes.md'), '## Plan\n- hello\n');
  await utimes(join(folder, 'notes.md'), new Date('2026-10-28T15:00:00Z'), new Date('2026-10-28T15:00:00Z'));
  const { callDetail } = await import('../src/hikyaku/call-list.js');
  const detail = async () => callDetail({ home: root, id: '2026-10-28-1330-nba-6820' });
  assert.equal((await detail()).summarized, true)
  assert.equal((await detail()).pagesNewer, false);
  await addPage({ folder, path: src });
  assert.equal((await detail()).pagesNewer, true);
  await utimes(join(folder, 'notes.md'), new Date(), new Date(Date.now() + 60000));
  assert.equal((await detail()).pagesNewer, false);
});
