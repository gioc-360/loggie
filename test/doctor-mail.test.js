// Teammates' mail fix 6 (2026-10-28): `npm run doctor` names the Mail store version, Outlook's version and whether it is
// the new Outlook, and which app needs Full Disk Access. Fakes only: no real Mail store, no real defaults.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChecks, hikyakuChecks } from '../src/hikyaku/doctor.js';

const OUTLOOK = '/Applications/Microsoft Outlook.app';
function mac({ outlook = true, newOutlook = '1', version = 'V11', open = 'on', term = 'iTerm.app' } = {}) {
  const index = `/u/Library/Mail/${version || 'V10'}/MailData/Envelope Index`;
  const asked = [];
  return {
    asked,
    home: '/fake/hikyaku', env: { TERM_PROGRAM: term }, userHome: '/u', memoryGB: 16,
    readImpl: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    existsImpl: async (path) => path === '/fake/hikyaku' || (outlook && path === OUTLOOK),
    execImpl: async (file, args) => {
      asked.push([file, ...args]);
      if (file === 'defaults' && args[1] === `${OUTLOOK}/Contents/Info`) return { stdout: '16.114.1\n' };
      if (file === 'defaults' && args[1] === 'com.microsoft.Outlook') { if (newOutlook === null) throw new Error('does not exist'); return { stdout: `${newOutlook}\n` }; }
      throw new Error('not found');
    },
    openImpl: async (path) => {
      if (path !== index || open === 'missing') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (open === 'off') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
    storeImpl: async () => ({ version, index }),
    mailImpl: async () => [{ address: 'sam@school.edu', kind: 'exchange', inbox: 3, sent: 1, newest: null, skipped: null }],
    keysImpl: async () => ({ nebius: true, tavily: true }), helpersImpl: async () => ({ voice: 'built', native: 7 }), pythonImpl: async () => ({ ok: true, numpy: true }),
  };
}
const line = (result, name) => result.checks.find((check) => check.name === name);

test('the doctor names the Mail store, the new Outlook with its version, and the app holding Full Disk Access', async () => {
  const fake = mac();
  const result = await hikyakuChecks(fake);
  assert.match(line(result, 'Mail store').detail, /^V11 /);
  assert.equal(line(result, 'Outlook').detail, '16.114.1, the new Outlook');
  assert.equal(line(result, 'Full Disk Access').detail, 'on for iTerm');
  assert.equal(line(result, 'Full Disk Access').ok, true);
  const text = formatChecks(result);
  assert.match(text, /✓ Mail store: V11/);
  assert.match(text, /✓ Outlook: 16\.114\.1, the new Outlook/);
  // Reads only: two defaults reads, nothing written.
  assert.ok(fake.asked.filter(([file]) => file === 'defaults').every(([, verb]) => verb === 'read'));
});

test('legacy Outlook, no Outlook, and a Full Disk refusal each read plainly', async () => {
  assert.equal(line(await hikyakuChecks(mac({ newOutlook: '0' })), 'Outlook').detail, '16.114.1, legacy Outlook');
  assert.equal(line(await hikyakuChecks(mac({ newOutlook: null })), 'Outlook').detail, '16.114.1, new or legacy not recorded yet');
  assert.equal(line(await hikyakuChecks(mac({ outlook: false })), 'Outlook').detail, 'not installed');
  const off = await hikyakuChecks(mac({ version: null, open: 'off', term: 'Apple_Terminal' }));
  assert.equal(line(off, 'Full Disk Access').ok, false);
  assert.equal(line(off, 'Full Disk Access').detail, 'off for Terminal');
  assert.match(line(off, 'Mail store').detail, /Full Disk Access is off for Terminal/);
  const never = await hikyakuChecks(mac({ version: null, open: 'missing' }));
  assert.match(line(never, 'Mail store').detail, /Apple Mail has not been opened/);
  assert.equal(line(never, 'Mail store').warn, true);
});
