import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { helperPath } from '../src/hikyaku/native-helper.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hikyaku');
const never = async () => { throw new Error('swiftc must not be called'); };

// A source, a prebuilt binary in a root, and a dev helper path, with the prebuilt older than the source.
async function fixture({ prebuiltAge = 'older' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hikyaku-native-'));
  const root = join(dir, 'bin');
  await mkdir(root);
  const source = join(dir, 'thing.swift');
  await writeFile(source, '// swift');
  const file = join(root, 'hikyaku-thing');
  await writeFile(file, 'binary');
  await chmod(file, 0o755);
  const past = new Date(Date.now() - 60000);
  const future = new Date(Date.now() + 60000);
  if (prebuiltAge === 'older') await utimes(file, past, past);
  else await utimes(file, future, future);
  return { dir, root, source, file, devHelper: join(dir, 'dev', 'hikyaku-thing') };
}

test('a packaged app uses its prebuilt helper without swiftc, even when it is older than the source', async () => {
  const f = await fixture({ prebuiltAge: 'older' });
  const got = await helperPath({ name: 'thing', source: f.source, devHelper: f.devHelper, roots: [f.root], packaged: true, execImpl: never });
  assert.equal(got, f.file);
});

test('in dev a fresh prebuilt is used, and an older one falls back to the dev build', async () => {
  const fresh = await fixture({ prebuiltAge: 'newer' });
  assert.equal(await helperPath({ name: 'thing', source: fresh.source, devHelper: fresh.devHelper, roots: [fresh.root], packaged: false, execImpl: never }), fresh.file);

  const old = await fixture({ prebuiltAge: 'older' });
  const calls = [];
  const execImpl = async (command, args) => { calls.push([command, ...args]); await writeFile(args.at(-1), 'built'); return { stdout: '' }; };
  const got = await helperPath({ name: 'thing', source: old.source, devHelper: old.devHelper, roots: [old.root], packaged: false, execImpl });
  assert.equal(got, old.devHelper);
  assert.deepEqual(calls, [['/usr/bin/swiftc', '-O', old.source, '-o', old.devHelper]]);
});

test('a packaged app with nothing prebuilt says so plainly and never calls swiftc', async () => {
  const f = await fixture();
  await assert.rejects(
    helperPath({ name: 'chats', source: f.source, devHelper: f.devHelper, roots: [join(f.dir, 'empty')], packaged: true, execImpl: never }),
    { message: 'Loggie is missing its chats helper. Reinstall Loggie.' },
  );
});

test('a failed dev build names the Xcode command line tools', async () => {
  const f = await fixture();
  const execImpl = async () => { const e = new Error('x'); e.stderr = 'no developer tools\nmore'; throw e; };
  await assert.rejects(helperPath({ name: 'thing', source: f.source, devHelper: f.devHelper, roots: [], packaged: false, execImpl }), /thing helper \(needs Xcode command line tools\): no developer tools$/);
});

test('swiftc is named in native-helper.js only, and every helper module routes through helperPath', async () => {
  for (const file of (await readdir(SRC)).filter((name) => name.endsWith('.js'))) {
    const text = await readFile(join(SRC, file), 'utf8');
    if (file !== 'native-helper.js') assert.doesNotMatch(text, /swiftc/, `${file} must not call swiftc`);
  }
  for (const [file, name] of [['calendar', 'calendar'], ['extract', 'extract'], ['chats', 'chats'], ['outlook', 'outlook'], ['mic', 'mic']]) {
    assert.match(await readFile(join(SRC, `${file}.js`), 'utf8'), new RegExp(`helperPath\\(\\{ name: '${name}'`), `${file} uses helperPath`);
  }
});

test('two callers during one build share it: the launch warm-up and an ask never run swiftc twice', async () => {
  const f = await fixture({ prebuiltAge: 'older' });
  let builds = 0, finish;
  const execImpl = (cmd, args) => { builds += 1; return new Promise((resolve) => { finish = async () => { await writeFile(args.at(-1), 'built'); resolve({ stdout: '' }); }; }); };
  const options = { name: 'thing', source: f.source, devHelper: f.devHelper, roots: [f.root], packaged: false, execImpl };
  const warm = helperPath(options);
  const ask = helperPath(options);
  await new Promise((r) => setTimeout(r, 20));
  await finish();
  assert.deepEqual(await Promise.all([warm, ask]), [f.devHelper, f.devHelper]);
  assert.equal(builds, 1);
  assert.equal(await helperPath({ ...options, execImpl: never }), f.devHelper, 'built once, then fresh');
});
