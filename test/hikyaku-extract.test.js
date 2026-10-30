import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureExtractHelper, extractText, readAttachments, safeName, sandboxProfile, zipUnpackedBytes } from '../src/hikyaku/extract.js';

// A zip with one entry whose index claims `unpacked` bytes: enough for the central-directory reader.
function fakeZip(unpacked) {
  const name = Buffer.from('word/document.xml');
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(100, 20); central.writeUInt32LE(unpacked, 24); central.writeUInt16LE(name.length, 28);
  const local = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(26 + name.length)]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, name, end]);
}

// A one-page PDF with real text, built by hand with correct offsets.
function tinyPdf(text) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((body, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('file names can never leave their folder', () => {
  assert.equal(safeName(0, '../../.zshrc'), '01-__.._.zshrc');
  assert.equal(safeName(9, 'Syllabus (final).pdf'), '10-Syllabus__final_.pdf');
  assert.doesNotMatch(safeName(2, '/etc/passwd'), /\//);
});

test('the sandbox allows no network, reads only the input and helper inside home, writes only the output', () => {
  const profile = sandboxProfile({ input: '/Users/u/x/01.raw', output: '/Users/u/x/01.txt', helper: '/Users/u/bin/extract', home: '/Users/u' });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-read-data \(require-all \(subpath "\/Users\/u"\) \(require-not \(require-any \(literal "\/Users\/u\/x\/01\.raw"\) \(literal "\/Users\/u\/bin\/extract"\)\)\)\)\)/);
  assert.match(profile, /\(deny file-write\* \(require-not \(require-any \(literal "\/Users\/u\/x\/01\.txt"\)/);
});

test('a zip bomb is measured from its own index, without unpacking it', () => {
  assert.equal(zipUnpackedBytes(fakeZip(400 * 1024 * 1024)), 400 * 1024 * 1024);
  assert.equal(zipUnpackedBytes(Buffer.from('not a zip')), null);
});

test('only readable files are read; the raw file is deleted; bombs and oversize files never reach the reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hikyaku-extract-'));
  const calls = [];
  const bytes = { pdf: Buffer.from('%PDF-fake'), bomb: fakeZip(400 * 1024 * 1024), big: Buffer.alloc(21 * 1024 * 1024) };
  const files = [
    { name: '../Syllabus.pdf', kind: 'pdf', readable: true, attachmentId: 'a1', messageId: 'm1' },
    { name: 'photo.png', kind: 'image', readable: false, attachmentId: 'a2', messageId: 'm1' },
    { name: 'bomb.docx', kind: 'word', readable: true, attachmentId: 'bomb', messageId: 'm1' },
    { name: 'big.pdf', kind: 'pdf', readable: true, attachmentId: 'big', messageId: 'm1' },
    { name: 'gone.pdf', kind: 'pdf', readable: true, attachmentId: 'missing', messageId: 'm1' },
  ];
  const fetchBytes = async (_m, id) => { if (id === 'a1') return bytes.pdf; if (id === 'bomb') return bytes.bomb; if (id === 'big') return bytes.big; throw new Error('Gmail request failed (404)'); };
  const extract = async ({ input, output, kind }) => { calls.push({ input, kind, raw: await readFile(input) }); await writeFile(output, 'Week 1: Introduction'); return { status: 'ok', detail: '20 characters' }; };
  const out = await readAttachments({ files, taskId: 'task_1', extractedRoot: root, fetchBytes, helper: '/h', extract });
  assert.equal(calls.length, 1, 'only the real PDF reached the reader'); assert.match(calls[0].input, /task_1\/01-__Syllabus\.pdf\.raw$/);
  assert.deepEqual(out.map((file) => file.read?.status ?? null), ['ok', null, 'unreadable', 'unreadable', 'unreadable']);
  assert.match(out[2].read.detail, /unpacks to 400 MB inside: not read \(a possible zip bomb\)/);
  assert.match(out[3].read.detail, /over 20 MB/); assert.match(out[4].read.detail, /could not download it: Gmail request failed \(404\)/);
  assert.equal(out[0].read.chars, 20);
  assert.deepEqual((await readdir(join(root, 'task_1'))).sort(), ['01-__Syllabus.pdf.txt'], 'raw files and sandbox profiles are deleted; only text stays');
});

const canBuild = existsSync('/usr/bin/swiftc') && existsSync('/usr/bin/sandbox-exec');
test('end to end: the real helper reads a real PDF inside the sandbox', { skip: !canBuild && 'needs Xcode tools and sandbox-exec' }, async () => {
  const helper = await ensureExtractHelper();
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-e2e-'));
  await writeFile(join(dir, 'in.raw'), tinyPdf('Office hours are on Tuesday'));
  const result = await extractText({ input: join(dir, 'in.raw'), output: join(dir, 'out.txt'), kind: 'pdf', helper, profilePath: join(dir, 'p.sb') });
  assert.equal(result.status, 'ok');
  assert.match(await readFile(join(dir, 'out.txt'), 'utf8'), /Office hours are on Tuesday/);
  await writeFile(join(dir, 'bad.raw'), Buffer.from('not a pdf at all'));
  assert.equal((await extractText({ input: join(dir, 'bad.raw'), output: join(dir, 'bad.txt'), kind: 'pdf', helper, profilePath: join(dir, 'p2.sb') })).status, 'unreadable');
  await writeFile(join(dir, 'scan.raw'), tinyPdf(''));
  assert.equal((await extractText({ input: join(dir, 'scan.raw'), output: join(dir, 'scan.txt'), kind: 'pdf', helper, profilePath: join(dir, 'p3.sb') })).status, 'no-text', 'a PDF with no text layer says so');
});
