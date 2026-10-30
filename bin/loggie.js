#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
// The commands there are. Anything else, or nothing, prints them: the terminal UI that ran here was removed in
// debt-cleanup 6.1.
const COMMANDS = ['calendar', 'cloud', 'doctor', 'entry', 'file-call', 'invite', 'record', 'refile', 'retire', 'send', 'try', 'workstream'];
const USAGE = `Usage: loggie <command> [options]. Commands: ${COMMANDS.join(', ')}.`;
if (args[0] === '--help' || args[0] === '-h') { console.log(USAGE); process.exit(0); }
if (!COMMANDS.includes(args[0])) {
  console.error(USAGE);
  process.exit(2);
}

if (args[0] === 'refile') {
  // Puts a call under a workstream, or moves it (refile.js): what it left on the old card is retired as "moved to".
  const id = String(args[1] || '').replace(/\/+$/, '').split('/').pop();
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  if (!id || !flag('--workstream')) { console.error('Usage: loggie refile <call folder> --workstream <name> [--dry-run]'); process.exit(2); }
  const { refileCall } = await import('../src/hikyaku/refile.js');
  const { readWorkstreams } = await import('../src/hikyaku/workstreams.js');
  const { HIKYAKU_HOME } = await import('../src/hikyaku/draft.js');
  const { ensureCoordinator } = await import('../src/core/runtime.js');
  const { homedir } = await import('node:os');
  const core = await ensureCoordinator({ dataDirectory: process.env.LOGGIE_CORE_DIR || join(homedir(), 'Library', 'Application Support', 'Loggie', 'core') });
  try {
    const out = await refileCall({ home: HIKYAKU_HOME, core, id, workstream: flag('--workstream'), workstreams: await readWorkstreams(HIKYAKU_HOME), dryRun: args.includes('--dry-run') });
    if (out.unchanged) console.log(`Already on ${out.to}. Nothing changed.`);
    else if (out.dryRun) {
      console.log(`Would move from ${out.from || 'no workstream'} to ${out.to}: retire ${out.retire.length} move(s)${out.files ? ', then file its next steps there' : ' (no notes yet: steps come when it is written up)'}`);
      for (const task of out.retire) console.log(`  - ${task.title}`);
    } else console.log(`Moved from ${out.from || 'no workstream'} to ${out.to}: ${out.retired.length} move(s) retired as moved, ${out.created.length} filed there.`);
  } catch (error) { console.error(error.message); process.exit(1); }
  process.exit(0);
}

if (args[0] === 'file-call') {
  // Puts a recorded call on its workstream: notes into the workstream folder, the user's next steps as tasks.
  const folder = args[1];
  if (!folder) { console.error('Usage: loggie file-call <call folder> [--workstream <name>] [--dry-run]'); process.exit(2); }
  const { fileCall } = await import('../src/hikyaku/calls.js');
  const { readWorkstreams } = await import('../src/hikyaku/workstreams.js');
  const { HIKYAKU_HOME } = await import('../src/hikyaku/draft.js');
  const workstreams = await readWorkstreams(HIKYAKU_HOME);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  const dryRun = args.includes('--dry-run');
  const { ensureCoordinator } = await import('../src/core/runtime.js');
  const { homedir } = await import('node:os');
  const core = dryRun ? null : await ensureCoordinator({ dataDirectory: process.env.LOGGIE_CORE_DIR || join(homedir(), 'Library', 'Application Support', 'Loggie', 'core') });
  try {
    const log = await fileCall({ folder, core, workRoot: join(HIKYAKU_HOME, 'work'), workstreams, workstream: flag('--workstream'), dryRun });
    console.log(dryRun ? `Would file on ${log.workstream}: ${log.steps.length} next step(s) for you, ${log.others} for others` : `Filed on ${log.workstream}: notes in ${log.notesFile}; ${log.created.length} new task(s), ${log.already} already there, ${log.others} step(s) for others`);
    for (const step of log.created || log.steps) {
      const unsure = Array.isArray(step.notSure) ? step.notSure.length > 0 : step.notSure;
      console.log(`  ${unsure ? '? ' : '  '}${step.title}`);
    }
  } catch (error) { console.error(error.message); process.exit(1); }
  process.exit(0);
}

if (args[0] === 'record') {
  // The transcriber (~/hikyaku/transcriber/spike/call.py), driven from hikyaku: check, start, stop, and arm. `arm` waits
  // for the next class or meeting on the calendar and records it from its start to its end, then transcribes and writes
  // notes; it is the user's click tonight that gives consent for tomorrow's recording, and it names what it will record.
  //   loggie record check | start "<title>" | start --calendar | stop | status
  //   loggie record arm [--title "<title>"]               arm the next calendar event within 24 h: by default only a
  //                                                        class (a course code in its title); a meeting with people
  //                                                        is recorded only when named with --title, never picked
  const { spawn: spawnChild, spawnSync: runSync } = await import('node:child_process');
  const { HIKYAKU_HOME, readSettings } = await import('../src/hikyaku/draft.js');
  const settings = await readSettings();
  const { transcriberRuntime } = await import('../src/hikyaku/send-gate.js');
  const runtime = transcriberRuntime(settings);
  const call = (...callArgs) => runSync(runtime.python, ['call.py', ...callArgs], { cwd: runtime.dir, stdio: 'inherit', env: { ...process.env, ...runtime.env, LOGGIE_DIR: projectRoot } });
  const sub = args[1];
  if (sub === 'check' || sub === 'stop') process.exit(call(sub).status ?? 1);
  if (sub === 'start') { process.exit(call('start', ...(args[2] === '--calendar' ? ['--calendar'] : [args.slice(2).join(' ') || 'Recording'])).status ?? 1); }
  if (sub === 'status') {
    const { readFile } = await import('node:fs/promises');
    const state = await readFile(join(HIKYAKU_HOME, 'calls', 'current.json'), 'utf8').catch(() => '');
    console.log(state ? `Recording: ${JSON.parse(state).dir}` : 'Not recording.');
    process.exit(0);
  }
  if (sub === 'arm') {
    const { listEvents } = await import('../src/hikyaku/calendar.js');
    const { callEvent } = await import('../src/hikyaku/meeting.js');
    const title = args.includes('--title') ? args[args.indexOf('--title') + 1] : null;
    const course = /\b[A-Z]{2,4}\s?\d{4}\b/;
    const now = Date.now();
    const events = (await listEvents({ from: new Date(now - 5 * 60000), days: 1 })).filter((event) => !event.allDay && new Date(event.end).getTime() > now)
      .filter((event) => (title ? event.title.toLowerCase().includes(title.toLowerCase()) : course.test(event.title)))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const next = events[0];
    if (!next) { console.error('No class on the calendar in the next 24 hours to arm. To record a meeting, name it: loggie record arm --title "<words>"'); process.exit(2); }
    const start = new Date(next.start), end = new Date(next.end);
    const fmt = (date) => date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (call('check').status) { console.error('The transcriber check failed; fix it before arming.'); process.exit(1); }
    console.log(`Armed: "${next.title}" ${fmt(start)} to ${fmt(end)}. Recording starts one minute before, stops at the end, then transcribes and writes notes. Leave this window open, or run it with nohup. Ctrl+C disarms.`);
    const until = (when) => new Promise((resolve) => { const tick = () => (Date.now() >= when ? resolve() : setTimeout(tick, 15000)); tick(); });
    await until(start.getTime() - 60000);
    const started = call('start', next.title, JSON.stringify(callEvent(next)));
    if (started.status) { console.error('Recording did not start.'); process.exit(1); }
    await until(end.getTime());
    process.exit(call('stop').status ?? 1);
  }
  console.error('Usage: loggie record check | start "<title>" | start --calendar | stop | status | arm [--title "<words>"]');
  process.exit(2);
}

if (args[0] === 'entry') {
  // The entry run (src/hikyaku/entry.js): catch-up for the window, the calls given by folder, the screen on this Mac,
  // and one pending next-move send per workstream with an open move. Prints the pending sends and exits; sends nothing.
  //   loggie entry run --since YYYY-MM-DD [--home <hikyaku folder>] [--core <Core folder>] [--mail <inbox.json> | --apple-mail]
  //                    [--call <call version folder>]... [--address <your email>] [--real] [--count-only]
  // --apple-mail reads the window's Inbox and Sent mail from Apple Mail, read-only (src/hikyaku/apple-mail-entry.js).
  // --count-only reads and threads the mail, prints counts only (no subject, name or body), and screens, prepares and
  // writes nothing.
  // The home is --home, else HIKYAKU_HOME, else the real one; the Core folder is --core, else LOGGIE_CORE_DIR, else
  // "core" next to the home. Any of them, or a call folder, inside the real Loggie folder is refused without --real.
  const usage = 'Usage: loggie entry run --since YYYY-MM-DD [--home <folder>] [--core <folder>] [--mail <inbox.json> | --apple-mail] [--call <folder>]... [--address <email>] [--real] [--count-only]';
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const since = flag('--since');
  if (args[1] !== 'run' || !since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) { console.error(`${usage}\nThe window starts at --since, a date like 2026-10-01.`); process.exit(2); }
  const { homedir } = await import('node:os');
  const { resolve } = await import('node:path');
  const real = args.includes('--real');
  const realRoot = join(homedir(), 'Library', 'Application Support', 'Loggie');
  const home = resolve(flag('--home') || process.env.HIKYAKU_HOME || join(realRoot, 'hikyaku'));
  const coreDirectory = resolve(flag('--core') || process.env.LOGGIE_CORE_DIR || join(dirname(home), 'core'));
  const calls = args.flatMap((arg, index) => (arg === '--call' && args[index + 1] ? [resolve(args[index + 1])] : []));
  const entry = await import('../src/hikyaku/entry.js');
  try { entry.guardDataRoots({ home, coreDirectory, calls, real, realRoot }); } catch (error) { console.error(error.message); process.exit(2); }
  const appleMail = args.includes('--apple-mail');
  // Full Disk Access is a switch only the user can flip, so its exact pane opens for them (no state file is written).
  const openPaneFor = async (error) => {
    if (!error?.pane) return;
    const { PANES } = await import('../src/hikyaku/settings-panes.js');
    const { spawn } = await import('node:child_process');
    if (PANES[error.pane]) spawn('open', [PANES[error.pane]], { detached: true, stdio: 'ignore' }).unref();
  };
  if (appleMail && flag('--mail')) { console.error(`${usage}\nRead mail from --mail or --apple-mail, not both.`); process.exit(2); }
  if (args.includes('--count-only')) {
    // Reads and threads, nothing more: no settings, no Core, no screen, no run folder.
    try {
      const { readFile } = await import('node:fs/promises');
      let threads, counts;
      if (appleMail) ({ threads, counts } = await (await import('../src/hikyaku/apple-mail-entry.js')).readAppleMail({ since, ownAddress: flag('--address') || '' }));
      else if (flag('--mail')) {
        threads = JSON.parse(await readFile(flag('--mail'), 'utf8')).filter((thread) => (thread.latestTimestamp || '') >= since);
        const days = threads.flatMap((thread) => (thread.messages || []).map((message) => String(message.timestamp || '').slice(0, 10))).filter(Boolean).sort();
        const mine = threads.flatMap((thread) => thread.messages || []).filter((message) => message.fromMe).length;
        counts = { inbox: days.length - mine, sent: mine, threads: threads.length, missing: 0, first: days[0], last: days.at(-1) };
      } else throw new Error('Give a mail source to count: --apple-mail or --mail <inbox.json>.');
      console.log(`${appleMail ? 'Apple Mail' : 'Mail file'} since ${since}: ${counts.inbox + counts.sent} messages (${counts.inbox} inbox, ${counts.sent} sent) in ${counts.threads} threads, ${counts.first} to ${counts.last}.`);
      if (counts.missing) console.log(`${counts.missing} had no message file on disk yet, so the index's preview stood in for the text.`);
      console.log('Nothing was screened, prepared or written.');
      process.exit(0);
    } catch (error) {
      console.error(`Not read: ${error.message}`);
      await openPaneFor(error);
      process.exit(1);
    }
  }
  try {
    const { readFile } = await import('node:fs/promises');
    const { readSettings } = await import('../src/hikyaku/draft.js');
    const { transcriberRuntime } = await import('../src/hikyaku/send-gate.js');
    const { consentFor, thinkWith } = await import('../src/hikyaku/cloud-screen.js');
    const { ensureCoordinator } = await import('../src/core/runtime.js');
    const settings = await readSettings(home);
    const runtime = transcriberRuntime(settings);
    const mailFile = flag('--mail') || (settings.mailSource === 'file' ? join(home, 'inbox.json') : null);
    const mail = mailFile ? JSON.parse(await readFile(mailFile, 'utf8')) : null;
    if (mail && !Array.isArray(mail)) throw new Error(`${mailFile} is not a list of threads.`);
    // Apple Mail is read before anything is written, so no store or no access fails with no run folder and no Core.
    const fromAppleMail = !mail && appleMail ? await (await import('../src/hikyaku/apple-mail-entry.js')).readAppleMail({ since, ownAddress: flag('--address') || '' }) : null;
    const core = await ensureCoordinator({ dataDirectory: coreDirectory });
    // Each workstream's catch-up runs only under its own yes for the cloud (its cloud field); without one it is left out.
    const result = await entry.entryRun({ home, core, since, mail, appleMail: Boolean(fromAppleMail), readAppleMailImpl: async () => fromAppleMail, calls, transcriber: runtime.dir, python: runtime.python,
      thinkFor: (workstream) => thinkWith({ settings, maxTokens: 1500, consent: consentFor('mail', { workstream }), what: `the "${workstream.name}" mail` }),
      me: settings.signName || null, ownAddress: flag('--address') || '', today: settings.today || new Date().toLocaleDateString('en-CA') });
    const read = result.appleMail ? ` Read ${result.appleMail.inbox + result.appleMail.sent} messages from Apple Mail (${result.appleMail.inbox} inbox, ${result.appleMail.sent} sent) in ${result.appleMail.threads} threads.` : '';
    console.log(`Entry run ${result.run}. Nothing was sent.${read}${mail || appleMail ? '' : ' No mail file, so the moves already on your cards were used.'}`);
    for (const item of result.catchUps) console.log(`  Caught up on ${item.workstream}: ${item.threads} thread(s), ${item.written} new move(s), ${item.already} already there.`);
    for (const call of result.calls) console.log(`  ${call.id} joins ${call.workstream || 'no workstream'}.`);
    console.log(`\nWaiting for your Send (${result.sends.length}):`);
    for (const send of result.sends) {
      const what = send.workstream || send.title;
      const offer = send.offer ? `  Start "${send.offer.new_workstream.name}", or put it under one of yours.` : '';
      console.log(`  ${send.run}  ${send.what}  ${what}  ${send.source_ids.length} source(s): ${send.sentences_sent} sentences to send, ${send.sentences_kept} kept on this Mac.${offer}`);
    }
    if (result.sends.some((send) => send.what === 'next-move')) {
      // The free times are read again at Send (the same reader the desktop uses); this says now whether there will be any.
      const { readSlots } = await import('../src/hikyaku/next-move.js');
      const { listEvents } = await import('../src/hikyaku/calendar.js');
      const free = await readSlots({ eventsImpl: () => listEvents({ days: 10 }), settings });
      console.log(free.calendar === 'read'
        ? `\nCalendar read on this Mac: ${free.slots.length} free time(s) to offer, so a next move may offer a time to meet.`
        : `\nCalendar not read: ${free.reason}`);
    }
    if (result.sends.length) console.log('\nReview one, then send it yourself: loggie send <run>');
    process.exit(0);
  } catch (error) { console.error(`Not prepared: ${error.message}`); await openPaneFor(error); process.exit(1); }
}

if (args[0] === 'workstream') {
  // "New workstream?" (src/hikyaku/entry.js): a call the entry run matched to no workstream is started as a new one, or
  // put under one of yours. Its pending send moves under that workstream; nothing is sent until you run loggie send.
  //   loggie workstream start <run> --name "<name>" [--goal "<goal>"] [--address <your email>] [--home <folder>]
  //   loggie workstream file <run> --into "<workstream>" [--home <folder>]
  // The home is --home, else HIKYAKU_HOME, else the real one, as for loggie entry run.
  const usage = 'Usage: loggie workstream start <run> --name "<name>" [--goal "<goal>"] [--address <email>] [--home <folder>]\n       loggie workstream file <run> --into "<workstream>" [--home <folder>]';
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : null);
  const [, sub, run] = args;
  if (!['start', 'file'].includes(sub) || !run) { console.error(usage); process.exit(2); }
  const { resolve } = await import('node:path');
  const { HIKYAKU_HOME, readSettings } = await import('../src/hikyaku/draft.js');
  const home = resolve(flag('--home') || process.env.HIKYAKU_HOME || HIKYAKU_HOME);
  const entry = await import('../src/hikyaku/entry.js');
  try {
    const settings = await readSettings(home);
    const result = sub === 'start'
      ? await entry.startWorkstream({ home, run, name: flag('--name') ?? '', goal: flag('--goal') || null, ownAddress: flag('--address') || '', ownAddresses: settings.ownAddresses || [], ownNames: [settings.signName].filter(Boolean) })
      : await entry.fileUnder({ home, run, stream: flag('--into') ?? '' });
    console.log(sub === 'start'
      ? `Started "${result.workstream}" (words: ${result.entry.words.join(', ') || 'none'}; domains: ${result.entry.domains.join(', ') || 'none'}). No cloud AI is approved for it.`
      : `Put the call under "${result.workstream}".`);
    console.log(`Its send is ${result.run}${result.replaced.length > 1 ? `, replacing ${result.replaced.length - 1} older send(s) for it` : ''}. Nothing was sent. Review it, then: loggie send ${result.run}`);
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(2); }
}

if (args[0] === 'retire') {
  // Stale moves (src/hikyaku/retire.js): each workstream's open moves are checked against its summary, under its own
  // cloud yes; settled, duplicate and past ones leave every list (retired.json), with Undo on the card. Nothing is deleted.
  //   loggie retire [--dry-run] [--home <folder>]
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? '' : null);
  const { resolve, join: joinPath, dirname: dirOf } = await import('node:path');
  const { HIKYAKU_HOME, readSettings } = await import('../src/hikyaku/draft.js');
  const home = resolve(flag('--home') || process.env.HIKYAKU_HOME || HIKYAKU_HOME);
  try {
    const { consentFor, thinkWith } = await import('../src/hikyaku/cloud-screen.js');
    const { readWorkstreams } = await import('../src/hikyaku/workstreams.js');
    const { readState } = await import('../src/hikyaku/headless.js');
    const { retirePastDates, sweepAll } = await import('../src/hikyaku/retire.js');
    const { ensureCoordinator } = await import('../src/core/runtime.js');
    const settings = await readSettings(home);
    const core = await ensureCoordinator({ dataDirectory: resolve(flag('--core') || process.env.LOGGIE_CORE_DIR || joinPath(dirOf(home), 'core')) });
    const dryRun = args.includes('--dry-run');
    const past = await retirePastDates({ home, core, today: new Date().toLocaleDateString('en-CA'), dryRun, stateOf: (project, task) => (project ? readState(joinPath(project.directoryPath, task.id)) : null) });
    console.log(`Dates passed (code only, every workspace): ${past.length} move(s) ${dryRun ? 'would be' : ''} retired`);
    for (const item of past) console.log(`  - ${item.workstream}: ${item.title}  [past: ${item.proof}]`);
    const report = await sweepAll({ home, core, workstreams: await readWorkstreams(home), dryRun, today: new Date().toLocaleDateString('en-CA'),
      askFor: (workstream) => thinkWith({ settings, maxTokens: 1200, consent: consentFor('mail', { workstream }), what: `the "${workstream.name}" moves`, path: 'retire', log: () => {} }),
      stateOf: (project, task) => readState(joinPath(project.directoryPath, task.id)) });
    for (const row of report) {
      console.log(`${row.name}: ${row.skipped ? `left out, ${row.skipped}` : `${row.retired.length} of ${row.offered} open move(s) ${dryRun ? 'would be' : ''} retired`}`);
      for (const item of row.retired) console.log(`  - ${item.title}  [${item.why}: ${item.proof}]`);
    }
    console.log(dryRun ? 'Dry run: nothing was retired.' : 'Retired moves show on their card with Undo.');
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(2); }
}

if (args[0] === 'send') {
  // The send gate (src/hikyaku/send-gate.js): nothing leaves the Mac until the user picks an AI and presses Send.
  //   loggie send                                   what is prepared and waiting for a yes
  //   loggie send <run>                             what would leave, and which AIs are connected
  //   loggie send <run> --with <ai> [--remember]    send it with that AI (remember: for this workstream)
  //   loggie send <run> --hold <source id> <n>      keep sentence n of that source on this Mac (line.hold); sends nothing
  const gate = await import('../src/hikyaku/send-gate.js');
  const { HIKYAKU_HOME, readSettings } = await import('../src/hikyaku/draft.js');
  const { dir: transcriber, python } = gate.transcriberRuntime(await readSettings(HIKYAKU_HOME));
  const checks = gate.defaultChecks({ transcriber, python });
  const run = args[1];
  try {
    if (!run) {
      const sends = await gate.pendingSends(HIKYAKU_HOME);
      if (!sends.length) console.log('Nothing is waiting to be sent.');
      for (const send of sends) console.log(`${send.run}  ${send.what}  ${send.title || ''}  ${send.sentences_sent} sentences to send, ${send.sentences_kept} kept on this Mac${send.status === 'failed' ? `  (last try failed: ${send.reason})` : ''}`);
      process.exit(0);
    }
    if (args.includes('--hold')) {
      const at = args.indexOf('--hold');
      const { holdLine } = await import('../src/hikyaku/hold-line.js');
      const result = await holdLine({ home: HIKYAKU_HOME, run, sourceId: args[at + 1] || '', i: Number(args[at + 2]) });
      console.log(`Kept that line on this Mac. The send is now ${result.run}: ${result.sentences_sent} sentences to send, ${result.sentences_kept} kept on this Mac. Nothing was sent.`);
      process.exit(0);
    }
    if (!args.includes('--with')) {
      const { options, default: chosen, send } = await gate.aiOptions({ home: HIKYAKU_HOME, run, checks });
      console.log(`What would leave your Mac (nothing has been sent):\n${send.outbound.map((path) => `  ${path}`).join('\n')}\n${send.sentences_sent} sentences to send, ${send.sentences_kept} kept on this Mac.\n`);
      for (const option of options) console.log(`${option.connected ? '✓' : '✗'} ${option.id}: ${option.label}${option.connected ? '' : ' (not connected)'}${option.id === chosen ? '  (default)' : ''}`);
      console.log(`\nSend it: loggie send ${run} --with ${chosen} [--remember]`);
      process.exit(0);
    }
    const provider = args[args.indexOf('--with') + 1];
    // A call's notes go on its card once they are back (the filing step call.py used to run after an automatic send).
    const { fileCall } = await import('../src/hikyaku/calls.js');
    const { readWorkstreams } = await import('../src/hikyaku/workstreams.js');
    const { ensureCoordinator } = await import('../src/core/runtime.js');
    const { homedir } = await import('node:os');
    const coreOf = () => ensureCoordinator({ dataDirectory: process.env.LOGGIE_CORE_DIR || join(homedir(), 'Library', 'Application Support', 'Loggie', 'core') });
    const file = async (folder) => {
      const log = await fileCall({ folder, core: await coreOf(), workRoot: join(HIKYAKU_HOME, 'work'), workstreams: await readWorkstreams(HIKYAKU_HOME) });
      console.log(`Filed on ${log.workstream}: ${log.created.length} new task(s), ${log.already} already there.`);
    };
    // A next move (next-move.js) runs inside approveSend, after the gate; the key is read only at the request.
    const settings = await readSettings(HIKYAKU_HOME);
    const nextMove = async (input) => {
      const { runNextMove } = await import('../src/hikyaku/next-move.js');
      const { createTokenFactory } = await import('../src/hikyaku/nebius.js');
      const { listEvents } = await import('../src/hikyaku/calendar.js');
      const result = await runNextMove({ ...input, core: await coreOf(), client: createTokenFactory(), me: settings.signName || null, settings, eventsImpl: () => listEvents({ days: 10 }) });
      if (result.calendar?.status === 'unreadable') console.log(`Calendar not read: ${result.calendar.reason}`);
      if (result.ok) console.log(`Next move ${result.move_id} is on the card.`);
      return result;
    };
    const result = await gate.approveSend({ home: HIKYAKU_HOME, run, provider, remember: args.includes('--remember'), checks, transcriber, python, file, nextMove,
      runner: (command, commandArgs, options) => new Promise((resolve) => {
        const child = spawn(command, commandArgs, { ...options, stdio: 'inherit' });
        child.on('close', (code) => resolve({ code: code ?? 1, stdout: '', stderr: code ? `exit ${code}, see above` : '' }));
        child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: error.message }));
      }) });
    if (!result.ok) {
      console.error(`Not sent: ${result.reason}`);
      const kept = join(gate.runDirectoryOf(HIKYAKU_HOME, run), 'REPLY.json');
      if (await access(kept).then(() => true, () => false)) console.error(`The answer and why it was refused are kept on this Mac: ${kept}`);
      process.exit(1);
    }
    console.log(result.fileError ? `Sent. Not filed: ${result.fileError}` : 'Sent.');
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(2); }
}

if (args[0] === 'cloud') {
  // Per-workstream cloud approval: whether the cloud AI may read a workstream. Off is the default for every workstream.
  //   loggie cloud                                 list
  //   loggie cloud "<workstream>" nebius|off
  const { listCloud, setCloud } = await import('../src/hikyaku/cloud.js');
  const { HIKYAKU_HOME } = await import('../src/hikyaku/draft.js');
  if (args.length === 1) {
    const list = await listCloud(HIKYAKU_HOME);
    if (!list.length) console.log('No workstreams yet (workstreams.json).');
    for (const item of list) console.log(item.cloud === 'nebius' ? `✓ ${item.name}: the cloud AI may read this workspace` : `✗ ${item.name}: off (local AI only)`);
    console.log('\nSet one: loggie cloud "<workstream>" nebius|off');
    process.exit(0);
  }
  if (args.length !== 3) { console.error('Usage: loggie cloud ["<workstream>" nebius|off]'); process.exit(2); }
  try {
    const result = await setCloud(HIKYAKU_HOME, args[1], args[2]);
    console.log(result.cloud === 'off' ? `"${result.name}": cloud off. Only the local AI reads it now.`
      : `"${result.name}": the cloud AI may read this workspace when you press Draft it or Send. Nothing is sent by Loggie.`);
    process.exit(0);
  } catch (error) { console.error(error.message); process.exit(1); }
}

if (args[0] === 'try') {
  // Try one draft from a terminal, without the app: the same run Do it starts, on the cloud AI under the workspace's
  // own yes, with nothing recorded in Core. --dry-run checks Outlook for the email but opens and pastes nothing.
  const tryTaskId = args[1];
  if (!tryTaskId || !/^[a-zA-Z0-9_-]{1,100}$/.test(tryTaskId)) {
    console.error('Usage: loggie try <task-id> [--dry-run]   (run it in the task\'s project folder)');
    process.exit(2);
  }
  const { startHeadless } = await import('../src/hikyaku/headless.js');
  const { HIKYAKU_HOME, openDraft, readSettings } = await import('../src/hikyaku/draft.js');
  const { CHATS_NAME, cloudCalendarText } = await import('../src/hikyaku/cloud.js');
  const { consentFor, thinkWith } = await import('../src/hikyaku/cloud-screen.js');
  const { readWorkstreams } = await import('../src/hikyaku/workstreams.js');
  const { slug } = await import('../src/hikyaku/util.js');
  const settings = await readSettings();
  const voiceDirectory = join(HIKYAKU_HOME, 'voice');
  const quiet = async () => ({ id: 'cli' });
  const core = { listSessions: async () => [], getApprovedBrief: quiet, createSession: quiet, transitionSession: quiet, transitionTask: quiet, createWriteUp: quiet };
  const dryRun = args.includes('--dry-run');
  // The same screened request Do it makes (desktop/main-ipc-moves.js draftCompleteFor), under the same yes.
  const draftComplete = async (directoryPath) => {
    const folder = basename(directoryPath);
    if (folder === slug(CHATS_NAME)) return thinkWith({ settings, maxTokens: 3000, consent: consentFor('chats', { settings }), what: 'your chats', path: 'do-it' });
    const found = (await readWorkstreams(HIKYAKU_HOME)).find((item) => slug(item.name) === folder) || null;
    return thinkWith({ settings, maxTokens: 3000, consent: consentFor('mail', { workstream: found }), what: `the "${found?.name || folder}" mail`, path: 'do-it' });
  };
  console.log(`Loggie is drafting ${tryTaskId}, with no window...`);
  const started = Date.now();
  const run = await startHeadless({ core, task: { id: tryTaskId, status: 'running' }, directoryPath: process.cwd(), voiceDirectory, home: HIKYAKU_HOME,
    calendarText: ({ allowed } = {}) => cloudCalendarText(settings, { allowed }),
    openDraftImpl: (options) => openDraft({ ...options, dryRun }), draftComplete });
  const state = await run.done;
  console.log(`${state.phase} after ${Math.round((Date.now() - started) / 1000)} s. ${state.question || state.detail || ''}`);
  const draft = await import('node:fs/promises').then((fs) => fs.readFile(join(process.cwd(), tryTaskId, 'DRAFT.md'), 'utf8').catch(() => ''));
  if (draft && ['in-mail-app', 'ready'].includes(state.phase)) console.log(`\n${draft.trim()}`);
  process.exit(state.phase === 'failed' ? 1 : 0);
}

if (args[0] === 'calendar') {
  const calendar = await import('../src/hikyaku/calendar.js');
  try {
    if (args[1] === 'free') {
      const flag = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
      const days = flag('--days', 7), minutes = flag('--minutes', 30);
      if (!Number.isInteger(days) || days < 1 || days > 21 || !Number.isInteger(minutes) || minutes < 15 || minutes > 240) throw new Error('Usage: loggie calendar free [--days 1-21] [--minutes 15-240]');
      const { readSettings } = await import('../src/hikyaku/draft.js');
      const hours = { startHour: 9, endHour: 17, timeZone: 'America/New_York', ...(await readSettings()).meetingHours };
      const events = await calendar.listEvents({ days });
      console.log(calendar.formatFree(calendar.freeSlots(events, { days, minutes, ...hours }), events, { minutes, ...hours }));
    } else if (args[1] === 'remove') {
      const removed = await calendar.removeEvent(args[2]);
      console.log(`Removed: ${calendar.formatEvents([removed])}`);
    } else {
      const daysIndex = args.indexOf('--days');
      const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7;
      if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('Usage: loggie calendar [--days 1-60] | loggie calendar free [--days 1-21] [--minutes 15-240] | loggie calendar remove <event-id>');
      console.log(calendar.formatEvents(await calendar.listEvents({ days })));
    }
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (args[0] === 'invite' && args[1] && !(await import('node:fs')).existsSync(args[1])) {
  // One sentence to a filled invite (quick-invite.js): loggie invite "Amritha and Jess 2pm Maplewood". Code reads the
  // sentence, the people index finds the addresses, Outlook's window (or Google's page) is filled. Stops before Send.
  //   loggie invite "<who> <when> [where] [weekly] [room in X floor 2] [with notes] [on google]" [--dry-run]
  const sentence = args.slice(1).filter((a) => a !== '--dry-run').join(' ');
  try {
    const { readSentence, quickInvite, describe } = await import('../src/hikyaku/quick-invite.js');
    const { loadPeople } = await import('../src/hikyaku/people.js');
    const plan = readSentence(sentence, { people: await loadPeople() });
    if (args.includes('--dry-run')) {
      console.log(JSON.stringify({ ...plan, start: plan.start ? plan.start.toString() : 'to be found: the first time free for everyone', day: plan.day?.toDateString() }, null, 2));
      process.exit(0);
    }
    const result = await quickInvite(plan);
    for (const line of describe(result)) console.log(line);
    process.exit(result.status === 'ready' ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

if (args[0] === 'invite') {
  // The next meeting from a recorded call: Outlook's invite to the same people, the call's summary and action items
  // as the body, a free room picked from Outlook's own list. Stops before Send.
  //   loggie invite <call-folder> --start 2026-10-14T17:30 --end 18:20 [--room Breazzano] [--floors 23] [--title "..."] [--pace slow]
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : '');
  if (!args[1] || args[1].startsWith('-')) {
    console.error('Usage: loggie invite <call-folder> --start YYYY-MM-DDTHH:MM --end HH:MM [--room <building>] [--floors 23] [--title "<subject>"]');
    process.exit(2);
  }
  try {
    const { invite } = await import('../src/hikyaku/invite.js');
    const { readSettings } = await import('../src/hikyaku/draft.js');
    const settings = await readSettings();
    const result = await invite({ folder: args[1], start: flag('--start'), end: flag('--end'), room: flag('--room'), floors: flag('--floors'),
      title: flag('--title'), pace: flag('--pace'), signName: settings.signName || '' });
    console.log(`Invite: ${result.subject}`);
    console.log(`To: ${result.attendees.join(', ')}`);
    console.log(`Body: notes and ${result.actions.length} action item${result.actions.length === 1 ? '' : 's'} from ${result.notesFrom}`);
    if (result.slot) console.log(`When: ${result.slot}`);
    if (result.rooms) console.log(`Rooms Outlook listed: ${result.rooms.length}, ${result.rooms.filter((line) => line.endsWith(': Available')).length} free`);
    if (result.room_picked) console.log(`Room: ${result.room_picked}${result.room_status ? ` (${result.room_status.replace(`${result.room_picked} is `, '')})` : ''}`);
    console.log(result.status === 'ready' ? 'Ready in Outlook. Read it, then press Send. Loggie did not send it.' : `Stopped: ${result.detail}`);
    process.exit(result.status === 'ready' ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (args[0] === 'doctor') {
  console.log('Loggie doctor\n');
  console.log(`✓ Node.js ${process.version}`);
  const { hikyakuChecks, formatChecks, failures } = await import('../src/hikyaku/doctor.js');
  const hikyaku = await hikyakuChecks();
  console.log(formatChecks(hikyaku));
  process.exit(failures(hikyaku) ? 1 : 0);
}
