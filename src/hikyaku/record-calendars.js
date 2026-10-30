// "Record from these calendars" on Settings (meetings-granola-proposal.md c 1.4, 2026-10-27): one checkhouse per calendar
// this Mac syncs. A meeting he is invited to is his on any calendar (meeting.js isMine); this list decides only an event
// with nobody on it, so the school's shared "MBA I" block never names, offers or catches a recording again. Nothing
// saved means each account's main calendar (meeting.js recordCalendarsOf); his first change saves the whole list.
//   recordCalendarsView(calendars, raw) -> { calendars: [{ id, title, account, type, on }], saved }
//   saveRecordCalendars(home, ids, { readImpl, writeImpl }) -> the view's `saved` list, written into settings.json
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HIKYAKU_HOME } from './draft.js';
import { recordCalendarsOf, recordCalendarsSaved } from './meeting.js';
import { readRawSettings } from './setup-status.js';

// calendars: the helper's `calendars` rows; raw: settings.json as written.
export function recordCalendarsView(calendars = [], raw = {}) {
  const saved = recordCalendarsSaved(raw);
  const on = new Set(saved || recordCalendarsOf(calendars));
  return {
    calendars: calendars.map(({ id, title, account, type }) => ({ id, title, account, type, on: on.has(id) })),
    saved: saved !== null,
  };
}

// settings.json read as written (a file that cannot be read is refused and nothing is written, as saveAvailability
// does); only "recordCalendars" changes. `ids` is already checked (ipc-validation.js validateRecordCalendars).
export async function saveRecordCalendars(home = HIKYAKU_HOME, ids = [], { readImpl, writeImpl = writeFile } = {}) {
  const raw = await readRawSettings(home, readImpl ? { readImpl } : {});
  raw.recordCalendars = [...new Set(ids)];
  await writeImpl(join(home, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`);
  return raw;
}
