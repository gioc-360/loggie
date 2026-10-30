// A manual step opens its own window: when hikyaku needs the user to switch something on, it opens that exact
// System Settings pane instead of describing where it is. Checks that repeat on a timer (the sent check every
// 10 minutes) open a pane at most once every 6 hours, so a "not yet" never turns into a pane that keeps popping up.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from './draft.js';

// Each link checked by opening it and reading System Settings' window title (2026-10-04).
export const PANES = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
  'internet-accounts': 'x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension',
  'full-disk-access': 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
  calendars: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars',
  // Added with the just-in-time cards (C6), not yet opened on a Mac: the standard Privacy_ names.
  microphone: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone',
  'screen-recording': 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation',
});
const QUIET_MS = 6 * 3600 * 1000;

export async function openPane(name, { home = HIKYAKU_HOME, spawnImpl = spawn, now = () => Date.now(), force = false } = {}) {
  if (!PANES[name]) throw new Error(`Unknown settings pane: ${name}`);
  const file = join(home, 'opened-panes.json');
  const opened = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
  if (!force && opened[name] && now() - opened[name] < QUIET_MS) return false;
  const child = spawnImpl('open', [PANES[name]], { detached: true, stdio: 'ignore' });
  child.unref?.();
  await mkdir(home, { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...opened, [name]: now() })}\n`);
  return true;
}
