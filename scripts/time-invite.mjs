#!/usr/bin/env node
// The speed eval for one-sentence invites, run against the real Outlook on this Mac. Each sentence is filled the way
// `loggie invite "..."` fills it, timed from the start of the command to the read-back, checked field by field
// against what the sentence asked for, then discarded (every subject starts "Loggie test", the only invites the
// helper's discard will close). Nothing is ever sent.
//   node scripts/time-invite.mjs [--limit 10] [--goal 4]
// Exit 0 only if every run is under the limit (10 s) and every read-back is right. Runs over the goal (4 s) are named.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { loadPeople } from '../src/hikyaku/people.js';
import { quickInvite, readSentence } from '../src/hikyaku/quick-invite.js';

const flag = (name, fallback) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback);
const LIMIT = flag('--limit', 10), GOAL = flag('--goal', 4);
const HELPER = new URL('../dist-native/bin/hikyaku-outlook-event', import.meta.url).pathname;
const SENTENCES = [
  'Amritha and Jess 2pm Maplewood "Loggie test 1"',
  'Jess tomorrow 9:30am for 30 min "Loggie test 2"',
  'Amritha and Jess monday 2pm Maplewood weekly "Loggie test 3"',
  'Amritha and Jess monday 3pm room in Breazzano floor 2 or 3 "Loggie test 4"',
  'Amritha and Jess monday 4pm Maplewood with notes "Loggie test 5"',
  'Amritha and Jess monday 10am Maplewood "Loggie test 6"',          // 10:00 is taken on Gio's calendar: a time is found
  'Amritha and Jess at Maplewood next week "Loggie test 7"',         // no time: the first time free for everyone
  'Amritha and Jess room in Sage next week "Loggie test 8"',          // no time and no room: both found together
  'Amritha and Jess every tuesday and thursday 4pm for 6 weeks "Loggie test 9"',   // a custom repeat
];

const people = await loadPeople();
const rows = [];
for (const sentence of SENTENCES) {
  const t0 = performance.now();
  const plan = readSentence(sentence, { people });
  const result = await quickInvite(plan, { helper: HELPER });
  const seconds = (performance.now() - t0) / 1000;
  const wrong = [];
  if (result.status !== 'ready') wrong.push(`${result.status}: ${result.detail}`);
  if (result.status === 'ready') {
    // the slot must start where the plan ended up (a found time moves it) and keep the length Outlook gave it
    const hhmm = `${String(plan.start.getHours()).padStart(2, '0')}:${String(plan.start.getMinutes()).padStart(2, '0')}`;
    if (!result.slot?.startsWith(`${hhmm} - `) || !result.slot.includes(`${(result.slot.match(/, (\d+) min,/) || [])[1]} min`)) wrong.push(`slot ${result.slot}`);
    if (!result.time_found && !result.slot?.startsWith(`${hhmm} - ${result.end_set},`)) wrong.push(`end ${result.slot}`);
    if (plan.place && !String(result.location || '').toLowerCase().startsWith(plan.place.toLowerCase())) wrong.push(`location ${result.location}`);
    if (plan.repeat && !/^Occurs every/.test(result.repeat_rule || '')) wrong.push(`repeat ${result.repeat_rule}`);
    if (plan.on?.length && !plan.on.every((d) => new RegExp({ sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' }[d]).test(result.repeat_rule || ''))) wrong.push(`weekdays ${result.repeat_rule}`);
    if (plan.times && result.repeat_times !== plan.times) wrong.push(`times ${result.repeat_times}`);
    if (plan.until && result.repeat_until !== plan.until) wrong.push(`until ${result.repeat_until}`);
    if (plan.room && !result.room_picked) wrong.push('no room');
    if (plan.notes && !(result.body_chars > 20)) wrong.push('no body');
    if (result.send_button === 'absent') wrong.push('no Send button: the people did not land');
    if (!plan.timeGiven || result.time_asked_free === false) {
      if (!result.time_found || !/Everyone is available/.test(result.slot || '')) wrong.push(`no time found for everyone: ${result.slot}`);
    }
  }
  const discard = spawnSync(HELPER, ['discard', '--subject', plan.title], { encoding: 'utf8' });
  if (!/"status":"ok"/.test(discard.stdout)) wrong.push(`discard: ${discard.stdout.trim()}`);
  rows.push({ sentence, seconds, steps: result.steps || {}, wrong });
  console.log(`${seconds.toFixed(2)} s  ${wrong.length ? 'WRONG ' + wrong.join('; ') : 'ok'}  ${sentence}  ${JSON.stringify(result.steps || {})}`);
}
const slow = rows.filter((r) => r.seconds > LIMIT), overGoal = rows.filter((r) => r.seconds > GOAL), wrong = rows.filter((r) => r.wrong.length);
console.log(`\n${rows.length} runs, slowest ${Math.max(...rows.map((r) => r.seconds)).toFixed(2)} s; ${overGoal.length} over the ${GOAL} s goal, ${slow.length} over the ${LIMIT} s limit, ${wrong.length} wrong.`);
process.exit(slow.length || wrong.length ? 1 : 0);
