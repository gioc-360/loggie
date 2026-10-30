// The one router for every language-model call: Nemotron on Nebius only. Fakes only: a fake Nebius client. No network.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NEBIUS_MODEL } from '../src/hikyaku/nebius.js';
import { createThinker, forCloud } from '../src/hikyaku/thinker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFUSAL = 'Loggie stopped this: the text was not screened on this Mac, so it was not sent.';

function fakeClient(content = '{"ok":true}') {
  const calls = [];
  return { calls, async post(bodyText) { calls.push(bodyText); return { content, finish_reason: 'stop' }; } };
}

async function sourceFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'renderer') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

// Gio, 2026-10-18: "fully remove nemotron on mac". No source file may reach a model on this Mac again.
test('no file under src, bin or desktop talks to a model on this Mac', async () => {
  const offenders = [];
  for (const directory of ['src', 'bin', 'desktop']) {
    for (const file of await sourceFiles(join(ROOT, directory))) {
      if (/createLocalModel|ensureModelServer|localModelWanted|createScreenModel|HIKYAKU_MODEL_URL|127\.0\.0\.1:8080|mlx_lm/.test(await readFile(file, 'utf8'))) offenders.push(file.replace(`${ROOT}/`, ''));
    }
  }
  assert.deepEqual(offenders, []);
});

test('the cloud path refuses a plain string and makes no request', async () => {
  const client = fakeClient();
  const thinker = createThinker({ settings: { thinker: 'cloud' }, nebiusClient: client });
  assert.equal(thinker.where, 'cloud');
  await assert.rejects(() => thinker.complete('raw mail text', { maxTokens: 100 }), { message: REFUSAL });
  await assert.rejects(() => thinker.complete({ text: 'raw mail text' }, { maxTokens: 100 }), { message: REFUSAL });
  assert.equal(client.calls.length, 0);
});

test('forCloud needs a screen and a consent, and its brand cannot be copied', async () => {
  assert.throws(() => forCloud('x', { screenedBy: '', consent: 'yes' }), /screen/);
  assert.throws(() => forCloud('x', { screenedBy: 'screen-thread' }), /no yes/);
  const screened = forCloud('x', { screenedBy: 'screen-thread', consent: 'workstream approval' });
  assert.deepEqual(Object.keys(screened), ['text']);
  const client = fakeClient();
  const thinker = createThinker({ settings: { thinker: 'cloud' }, nebiusClient: client });
  await assert.rejects(() => thinker.complete({ ...screened }, {}), { message: REFUSAL });
  assert.equal(client.calls.length, 0);
});

test('a forCloud input reaches the client with thinking off and the Super model', async () => {
  const client = fakeClient('{"summary":"fine"}');
  const thinker = createThinker({ settings: { thinker: 'cloud' }, nebiusClient: client });
  const reply = await thinker.complete(forCloud('screened text', { screenedBy: 'screen-thread', consent: 'workstream approval' }), { maxTokens: 900 });
  assert.equal(reply, '{"summary":"fine"}');
  assert.equal(client.calls.length, 1);
  assert.deepEqual(JSON.parse(client.calls[0]), {
    model: NEBIUS_MODEL, messages: [{ role: 'user', content: 'screened text' }], max_tokens: 900, temperature: 0, chat_template_kwargs: { enable_thinking: false },
  });
  assert.equal(NEBIUS_MODEL, 'nvidia/nemotron-3-super-120b-a12b');
});

test('an old settings.json asking for local thinking still thinks in the cloud', async () => {
  const client = fakeClient('ok');
  for (const settings of [{}, { thinker: 'local' }, { thinker: 'moon' }, { screenModel: 'local' }]) {
    const thinker = createThinker({ settings, nebiusClient: client });
    assert.equal(thinker.where, 'cloud');
    await assert.rejects(() => thinker.complete('a plain prompt'), { message: REFUSAL });
  }
  assert.equal(client.calls.length, 0);
});
