// Places the user has used before (loggie-ask-wordmap): the word map reads a bare place ("2pm maplewood") as the place
// only when it is one of these, and "about X in Y" keeps Y in the subject unless Y is one. Two sources, both already
// on this Mac: the locations on the user's own calendar events, and the places typed into invites Loggie filled
// (places.json beside settings.json). Nothing leaves the Mac.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from './draft.js';

const NOT_A_PLACE = /https?:|www\.|zoom|teams|meet\.google|webex|microsoft|online|virtual|tbd|call|phone|\+?\d[\d\s().-]{6,}/i;

// One location as the user would type it: before the first comma or semicolon, without a room number at the end
// ("Birch Hall 101, Example University" is "Birch Hall"); online meeting links and phone numbers are not places.
export function placeName(location) {
  const head = String(location || '').split(/[,;\n(]/)[0].replace(/\s+(?:rm\.?|room)?\s*#?\d+[a-z]?$/i, '').replace(/\s+/g, ' ').trim();
  if (!head || head.length > 40 || NOT_A_PLACE.test(head) || !/\p{L}/u.test(head)) return '';
  return head;
}

// The distinct places in a list of calendar events (calendar.js shape), most used first.
export function placesFrom(events = []) {
  const counts = new Map();
  for (const event of events) {
    const name = placeName(event.location);
    if (!name) continue;
    const key = name.toLowerCase();
    const seen = counts.get(key) || { name, n: 0 };
    seen.n += 1;
    counts.set(key, seen);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((p) => p.name);
}

export async function loadPlaces({ home = HIKYAKU_HOME } = {}) {
  const list = JSON.parse(await readFile(join(home, 'places.json'), 'utf8').catch(() => '[]'));
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

// A place typed into an invite Loggie filled: kept, newest first, at most 100.
export async function rememberPlace(place, { home = HIKYAKU_HOME } = {}) {
  const name = placeName(place);
  if (!name) return;
  const list = (await loadPlaces({ home })).filter((p) => p.toLowerCase() !== name.toLowerCase());
  await writeFile(join(home, 'places.json'), `${JSON.stringify([name, ...list].slice(0, 100), null, 2)}\n`).catch(() => {});
}
