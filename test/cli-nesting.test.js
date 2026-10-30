import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The terminal UI and its --task option were removed in debt-cleanup 6.1: no command, or one that is not there,
// prints the usage line and exits 2. Both reach the one not-a-command branch of bin/loggie.js, so one test holds both.
test('with no command, or the removed --task option, prints the usage line instead of starting a terminal UI', () => {
  for (const args of [[], ['--task']]) {
    const result = spawnSync(process.execPath, [join(projectRoot, 'bin/loggie.js'), ...args], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: loggie <command> \[options\]\. Commands: calendar, cloud, doctor, /);
  }
});
