import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export function createVoiceInput({ helper, emit, spawnImpl = spawn }) {
  let child;
  return {
    start({ authorizeOnly = false } = {}) {
      if (process.platform !== 'darwin') throw new Error('Voice input currently supports macOS.');
      if (child) throw new Error('Voice is already starting or listening. Finish it before changing voice permissions.');
      child = spawnImpl(helper, authorizeOnly ? ['--authorize'] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const active = child;
      let reported = false;
      createInterface({ input: active.stdout }).on('line', line => { try { const data = JSON.parse(line); if (data.error) reported = true; emit(data); } catch {} });
      active.stderr.resume();
      active.once('error', () => { if (child === active) child = null; reported = true; emit({ error: 'Voice helper could not start. Install the updated Loggie build (source users: npm run build:voice).' }); });
      active.once('exit', code => { if (child === active) child = null; if (reported) return; emit(code ? { error: 'Voice capture stopped. Check Microphone and Speech Recognition access in System Settings.' } : { status: authorizeOnly ? 'permissions-complete' : 'stopped' }); });
      return { status: 'starting' };
    },
    stop() { if (child) { child.stdin.write('stop\n'); const active = child; const timer = setTimeout(() => active.kill(), 2000); timer.unref(); active.once('exit', () => clearTimeout(timer)); } return { status: 'stopping' }; },
  };
}
