import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
test('Python recorder uses the app home and preserves stale state while refusing a live process', async t => {
  const home = await mkdtemp(join(tmpdir(), 'loggie-record-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'calls'));
  const source = fileURLToPath(new URL('../transcriber/spike/call.py', import.meta.url));
  const output = execFileSync('python3', ['-c', `
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('loggie_call_test', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert module.HOME == pathlib.Path(os.environ['LOGGIE_HIKYAKU_HOME']) / 'calls'
module.STATE.write_text(json.dumps({'pid': 123, 'dir': 'saved-call'}))
def missing(pid, signal): raise ProcessLookupError()
module.os.kill = missing
module.clear_stale_state()
assert not module.STATE.exists()
assert len(list(module.HOME.glob('current-stale-*.json'))) == 1
module.STATE.write_text(json.dumps({'pid': 123, 'dir': 'active-call'}))
module.os.kill = lambda pid, signal: None
try: module.clear_stale_state()
except SystemExit as error: assert 'Already recording' in str(error)
else: raise AssertionError('live recording must block')
assert module.STATE.exists()
print('ok')
`, source], { env: { ...process.env, LOGGIE_HIKYAKU_HOME: home, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.equal(output.trim(), 'ok');
});
