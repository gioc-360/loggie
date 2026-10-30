// The availability check (loggie-availability I2, docs/availability/spec.md section 3), read only: every free range an
// availability ask wrote into a draft (ASK.json `results[0].availability`), or with --replay every email from someone
// the user wrote to that asked for times, read again through the build, held against the calendar on this Mac as it is
// now. One overlap with an event that blocks is WRONG. Writes no file; prints dates, counts and domains, and with
// --show the ranges and the overlapping events' times (never a title, a calendar, an account or an attendee).
//   node scripts/availability/check.mjs [--since YYYY-MM-DD] [--replay] [--days 120] [--min n] [--show] [--home <hikyaku home>]
// Exit 0 clean, 1 on any WRONG, 2 when a read fails, 3 when fewer than --min records were judged (10 with --replay, else 1).
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HIKYAKU_HOME, readSettings } from '../../src/hikyaku/draft.js';
import { calendarStatus, listEvents, zonedTime } from '../../src/hikyaku/calendar.js';
import { THREAD_CUE, availabilityFor, availabilitySettings, readWindow } from '../../src/hikyaku/availability.js';
import { checkReport } from '../../src/hikyaku/availability-check.js';
import { mailAddresses, readInboxMail, readSentMail } from '../../src/hikyaku/sent-mail.js';
import { ownText } from '../../src/hikyaku/voice.js';

const argv = process.argv.slice(2);
const value = (flag, fallback) => { const at = argv.indexOf(flag); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };
const replay = argv.includes('--replay');
const show = argv.includes('--show');
const days = Number(value('--days', 120));
const min = Number(value('--min', replay ? 10 : 1));
const since = value('--since', null);
const home = value('--home', process.env.LOGGIE_DATA_DIRECTORY ? join(process.env.LOGGIE_DATA_DIRECTORY, 'hikyaku') : HIKYAKU_HOME);
const fail = (message) => { console.log(`availability check: a read failed, nothing was judged: ${message}`); process.exit(2); };
if (!Number.isFinite(days) || days <= 0) fail('--days takes a number of days');
if (!Number.isInteger(min) || min < 0) fail('--min takes a whole number');
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) fail('--since takes YYYY-MM-DD');

// The calendar helper that is already built, called directly: the check never builds one (a build writes a file).
async function builtHelper() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const file of [join(root, 'dist-native', 'bin', 'hikyaku-calendar'), join(homedir(), 'Library', 'Application Support', 'Loggie', 'bin', 'hikyaku-calendar')]) {
    if (await stat(file).then((s) => s.isFile(), () => false)) return file;
  }
  throw new Error('the calendar helper is not built yet; open Loggie once so it builds it');
}

const dayKey = (date, timeZone) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

let records, events;
try {
  const helper = await builtHelper();
  const status = await calendarStatus({ helper });
  if (status !== 'granted') throw new Error('no calendar access');
  const settings = availabilitySettings(await readSettings(home));
  if (replay) {
    const own = (await mailAddresses()).map((address) => address.toLowerCase());
    if (!own.length) throw new Error('Apple Mail has no mail account on this Mac.');
    const sent = await readSentMail({ address: own, days });
    const writtenTo = new Set(sent.flatMap((row) => row.to || []));
    const senderOf = (message) => (String(message.from).match(/[^\s<>,;"]+@[^\s<>,;"]+/) || [''])[0].toLowerCase();
    const inbox = await readInboxMail({ address: own, days, keep: (message) => writtenTo.has(senderOf(message)) && !own.includes(senderOf(message)) });
    const asks = inbox.filter((message) => THREAD_CUE.test(ownText(message.body || '')));
    records = [];
    for (const message of asks) {
      const now = new Date(message.timestamp);
      const window = readWindow({ typed: '', email: ownText(message.body || ''), emailAt: message.timestamp, now, settings });
      const read = await availabilityFor({ window, settings, now, eventsImpl: (options) => listEvents({ ...options, helper }), statusImpl: async () => status });
      records.push({ kind: 'replay', at: message.timestamp, domain: senderOf(message).split('@')[1] || '', ...read });
    }
  } else {
    const folder = join(home, 'asks');
    const ids = await readdir(folder).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    records = [];
    for (const id of ids.sort()) {
      const text = await readFile(join(folder, id, 'ASK.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (!text) continue;
      let ask;
      try { ask = JSON.parse(text); } catch { continue; }
      const record = ask.results?.[0]?.availability;
      if (record?.read !== 'read') continue;
      const timeZone = record.window?.timeZone || settings.timeZone;
      if (since) {
        const [y, m, d] = since.split('-').map(Number);
        if (Date.parse(ask.at) < zonedTime(y, m, d, 0, 0, timeZone).getTime()) continue;
      }
      records.push({ kind: 'ask', at: ask.at, ...record });
    }
  }
  // The days' events as they are now, one read from the first offered day to the last.
  const keys = records.flatMap((r) => (r.days || []).map((d) => d.day)).sort();
  events = [];
  if (keys.length) {
    const [y, m, d] = keys[0].split('-').map(Number);
    const from = zonedTime(y, m, d, 0, 0, settings.timeZone);
    const span = Math.round((Date.parse(`${keys.at(-1)}T12:00:00Z`) - Date.parse(`${keys[0]}T12:00:00Z`)) / 86400000) + 2;
    events = await listEvents({ from, days: span, helper });
  }
  records.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!replay && !records.length) console.log(`no availability ask with read times${since ? ` since ${since}` : ''} (today ${dayKey(new Date(), settings.timeZone)})`);
} catch (error) {
  fail(error.message);
}

const report = checkReport({ records, events, min, show });
for (const line of report.lines) console.log(line);
process.exit(report.exit);
