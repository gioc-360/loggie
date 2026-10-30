// The Mac permissions Loggie needs, each asked when the action that needs it first runs (cloud-first C6, plan 4.2):
//   calendar      meeting offers and free times       (the calendar helper; asked by macOS on its first read)
//   fullDisk      Apple Mail's local store            (every mail read goes through it)
//   microphone, screen   both sides of a meeting      (the first recording)
//   accessibility placing a reply in Outlook          (the first Outlook draft)
//   automation    "Loggie wants to control Mail"      (the first Apple Mail draft; macOS has no way to ask first)
// permissionStatus reads the five that can be read, as "granted", "denied" or "unknown" (not asked yet, or not
// readable). Only "denied" blocks an action: an unknown permission lets the action run, and macOS asks then. A blocked
// action does not run; the guard says why with one setup.need event, and the panel draws a card (renderer/setup-cards.js).
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PANES } from './settings-panes.js';

const PANE_OF = Object.freeze({ calendar: 'calendars', fullDisk: 'full-disk-access', microphone: 'microphone', screen: 'screen-recording', accessibility: 'accessibility', automation: 'automation' });

const ACTIONS = Object.freeze({
  'calendar-offer': { permissions: ['calendar'], why: 'Loggie needs your calendar to offer to record your meetings and to find free times.' },
  'apple-mail-read': { permissions: ['fullDisk'], why: 'Loggie needs Full Disk Access to read your mail in Apple Mail.' },
  record: { permissions: ['microphone', 'screen'], why: 'Loggie needs the microphone and screen audio to record both sides of this meeting.' },
  'outlook-draft': { permissions: ['accessibility'], why: 'Loggie needs Accessibility access to place your reply in Outlook.' },
  'apple-mail-draft': { permissions: ['automation'], why: 'Loggie places the draft in Apple Mail. macOS will ask the first time.' },
});

export function needFor(action) {
  if (!ACTIONS[action]) throw new Error(`Loggie has no action named "${action}".`);
  return { permissions: [...ACTIONS[action].permissions], why: ACTIONS[action].why };
}

export function paneUrl(permission) {
  if (!PANE_OF[permission]) throw new Error(`Loggie has no permission named "${permission}".`);
  return PANES[PANE_OF[permission]];
}

// The permission action a draft in this mail app needs, or null (Gmail needs none).
export const draftActionFor = (mailApp) => ({ outlook: 'outlook-draft', 'apple-mail': 'apple-mail-draft' })[mailApp] || null;

// What the app asks for as it opens: Calendar, and Full Disk whatever the mail app, since every mail read goes through
// Apple Mail's store (workspaces-outlook W10). Nothing else.
export const launchNeeds = () => ['calendar-offer', 'apple-mail-read'];

const media = (value) => (value === 'granted' ? 'granted' : value === 'denied' || value === 'restricted' ? 'denied' : 'unknown');
const soft = async (read) => { try { return await read(); } catch { return 'unknown'; } };

// Full Disk Access has no API: try to open Apple Mail's Envelope Index read-only. macOS refusing is the answer "denied".
// With no Mail store yet, Messages' chat.db answers the same question (spec C11); with neither, it is unknown.
async function fullDisk({ fsImpl, home }) {
  const mail = await mailStore({ fsImpl, home });
  if (mail !== 'unknown') return mail;
  try {
    const handle = await fsImpl.open(join(home, 'Library', 'Messages', 'chat.db'), 'r');
    await handle.close();
    return 'granted';
  } catch (error) { return ['EPERM', 'EACCES'].includes(error?.code) ? 'denied' : 'unknown'; }
}
async function mailStore({ fsImpl, home }) {
  const root = join(home, 'Library', 'Mail');
  const refused = (error) => ['EPERM', 'EACCES'].includes(error?.code);
  let names;
  try { names = await fsImpl.readdir(root); } catch (error) { return refused(error) ? 'denied' : 'unknown'; }
  const newest = names.filter((name) => /^V\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
  if (!newest) return 'unknown';
  try {
    const handle = await fsImpl.open(join(root, newest, 'MailData', 'Envelope Index'), 'r');
    await handle.close();
    return 'granted';
  } catch (error) { return refused(error) ? 'denied' : 'unknown'; }
}

export async function permissionStatus({ systemPreferences, fsImpl = { readdir, open }, calendarStatusImpl = null, home = homedir() } = {}) {
  return {
    calendar: calendarStatusImpl ? media(await soft(calendarStatusImpl)) : 'unknown',
    fullDisk: await soft(() => fullDisk({ fsImpl, home })),
    microphone: await soft(() => media(systemPreferences.getMediaAccessStatus('microphone'))),
    screen: await soft(() => media(systemPreferences.getMediaAccessStatus('screen'))),
    accessibility: await soft(() => (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied')),
  };
}

// The check before an action. null: go ahead. Otherwise the first denied permission, { permission, why, pane }, after
// one setup.need event, and the caller does not run the action. A check on a timer passes { once: true } so a denial
// is said once until the permission is granted; a check on the user's own action says it every time.
export function createSetupGuard({ status, emit }) {
  const announced = new Set();
  return {
    async check(action, { once = false } = {}) {
      const { permissions, why } = needFor(action);
      const have = await status();
      for (const permission of permissions) {
        if (have[permission] !== 'denied') { announced.delete(permission); continue; }
        const need = { permission, why, pane: paneUrl(permission) };
        if (!(once && announced.has(permission))) {
          announced.add(permission);
          await emit({ type: 'setup.need', text: why, data: need });
        }
        return need;
      }
      return null;
    },
  };
}
