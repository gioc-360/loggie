// The cloud AI key, set from inside the app (cloud-first C6, plan 7): Save puts it in the macOS keychain under the
// service and account nebius.js reads it from (Test key, which makes one tiny request, lives in nebius.js with the
// other client code: cloud-screen.test.js allows a cloud request in no other file). The key goes
// from the field to `security` and nowhere else: not a log line, not an event, not a file, not a reply to the panel,
// and not an error message (security's own output can echo what it was asked, so it is never repeated).
// Both calls take { keychain }, the item's { service, account }: Nebius's (nebius.js) unless the caller passes another,
// such as Tavily's (tavily.js KEYCHAIN).
import { execFile } from 'node:child_process';
import { KEYCHAIN } from './nebius.js';

const MAX_KEY = 500;

export async function saveCloudKey(key, { keychain = KEYCHAIN, execFileImpl = execFile, log = console.log } = {}) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) throw new Error('Paste the key first.');
  if (/\s/.test(value) || value.length > MAX_KEY) throw new Error('The key should be one line of letters and numbers. Paste it again.');
  await new Promise((resolve, reject) => {
    execFileImpl('security', ['add-generic-password', '-U', '-s', keychain.service, '-a', keychain.account, '-w', value], { timeout: 30000 }, (error) => {
      if (error) reject(new Error('Loggie could not save the key in the keychain. Allow the keychain prompt if one appeared, then try again.'));
      else resolve();
    });
  });
  log('Cloud key saved in the keychain.');
  return { saved: true };
}

// Whether a key is in the keychain. `find-generic-password` without -w or -g prints the item's attributes, never the secret.
export function keyStatus({ keychain = KEYCHAIN, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('security', ['find-generic-password', '-s', keychain.service, '-a', keychain.account], { timeout: 30000 }, (error) => resolve({ saved: !error }));
  });
}
