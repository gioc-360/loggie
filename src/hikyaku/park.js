// Park return (docs/workstream-integration/proposal.md, increment 6). A parked workstream waits, off the picks and
// with no automatic re-read, until its day; on that day it comes back with one change item in the log, so the
// refresh treats it as changed and the user sees it return. The date is then cleared. The ref repeats on a second run
// the same day and the date is already gone, so running it twice adds nothing.
import { appendChanges } from './changes.js';
import { saveWorkstreamFields } from './workstreams.js';

// `today` is the Mac's local day "YYYY-MM-DD". Returns the names that came back.
export async function returnParked({ home, workstreams, today }) {
  const returned = [];
  for (const { name, parkedUntil } of workstreams) {
    if (!parkedUntil || parkedUntil > today) continue;
    await appendChanges(home, [{ source: 'park', at: new Date(`${parkedUntil}T09:00:00`).toISOString(), title: `Back from park (${parkedUntil})`,
      ref: `${name}@${parkedUntil}`, thread: name, who: [], workstream: name, how: 'asked' }]);
    await saveWorkstreamFields(home, name, { parkedUntil: null });
    returned.push(name);
  }
  return returned;
}
