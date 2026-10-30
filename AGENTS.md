# AGENTS.md - Build Orders (loggie-workstreams-screen)

Read this whole file before writing code. It is the source of truth. Current build: loggie-ask-thread (which email
thread an ask answers, docs/ask-box/thread.md); before it loggie-ask-wordmap (the word map in the
ask box, docs/ask-box/wordmap.md); before that loggie-workstreams-screen, the
Workstreams screen (`docs/archive/workstreams-screen/proposal.md`). It sits on the backend of the previous build,
loggie-workstream-integration (`docs/workstream-integration/proposal.md`), whose contracts below still hold. The build
logs are kept private, outside the repo. Where a design doc disagrees with this file, this file wins.

## Source of Truth

When sources conflict, honor the higher-precedence one. Note the assumption in your report. Do not stop to ask.

1. A direct message from the Founding Agent in this session
2. ARCHITECTURAL INVARIANTS below
3. SPEC below
4. CONSTRAINTS below
5. Autonomous Decision Heuristics below
6. Sensible engineering judgment

**Reporting path:** your final message to the Founding Agent (see ADAPTER), plus the diff in your worktree.

---

## ADAPTER

A delegated Claude agent, launched by the Founding Agent through the Agent tool with `isolation: "worktree"`.

| Property | This adapter |
|---|---|
| Launch | The Founding Agent starts it. |
| Report channel | Your final message (in the REPORTING format) returns to the Founding Agent, plus the diff in your worktree. Commit your work in the worktree; do not push. |
| Subagents | Allowed, but do not use them to review your own diff. |
| Directive channel | The Founding Agent may message you mid-run. Follow directives without renegotiation. |

Runtime singletons you must not touch: the running Loggie app, its data folder
`~/Library/Application Support/Loggie/` (never write there), the user's Mail, Messages, WhatsApp and Calendar apps.
Tests use fakes and temp folders only.

---

## Scope of This Session

You are building exactly one increment, named in your brief and specced under INCREMENT PLAN.

- Do not start the next increment.
- Do not refactor code outside the files this increment touches.
- Do not fix unrelated bugs you notice. List them in your report.
- Do not add dependencies.

---

## ENVIRONMENT

Run from the repo root. Verified by the Founding Agent on 2026-10-10.

```bash
# install: a delegated worktree lacks node_modules; symlink it: ln -s "$HOME/Loggie/gio-updates/node_modules" node_modules (do not run npm ci)
npm test                   # the standing suite: node --test over test/*.test.js (678 tests, 677 pass, 1 skipped on 2026-10-10 after inc 6), ~10 s, DETERMINISTIC 5/5
node --test test/<file>    # one file
```

No build step for these modules (plain ES modules, Node 20+). No lint script exists; match the surrounding style.
Do not start the Electron app (`npm start`); this increment has no screen. "Start the app and use it" is replaced by
the live read-only check named in your brief, if any.

---

## ARCHITECTURAL INVARIANTS

Drafting is Nebius only (B7): no CLI drafter, no "agent" setting; an old approval reads as off.

### Ask box: sentence -> one action, unsent (loggie-ask-box, built 2026-10-11; docs/ask-box/proposal.md)
**Contract:** `readAsk(sentence, { names })` (src/hikyaku/ask.js, pure) -> `{ action, who: [text], app, words, meeting?,
when?, separate, original }`, `action` one of `message | reply | said | move | invite | open | unknown`. `names` are
the who index's names (ask-who.js `indexNames`). Graded set: test/ask-read.test.js (40 sentences, bar 36).
- Who: `buildWhoIndex({ chats, inbox, mail, people, own })` -> entries `{ name, kind: person | group, app: messages |
  whatsapp | outlook, chatId?, address?, email?, members?, last }`; `resolveWho(text, entries, { app, action })` ->
  `one | many | none`. Two people, or two same-named chats, are ALWAYS `many` (a question), never a guess. A one-word
  name starts at the word tier; a person beats a group named after them; a named app narrows the pool first.
- `mail` = sent-mail.js `readMailPeople` (headers only): who the user sent to, at any size, and who else was on To or
  Cc of Inbox mail with at most `FEW` (10) people; a sender keeps its own entry. 2026-10-12, 60 days: 468 -> 577
  Outlook people (556 with no cap, mostly class lists). Test: test/ask-who-mail.test.js.
- Runner: `createAsker({ home, loadIndex, openChat, email, readLatest, think, calendar, clearChat, emit, now })`
  (ask-run.js) -> `{ preview(text), run(text, { choices, cloud }), stop(askId), undo(askId) }`; `run` answers
  `{ askId }` at once, then `ask:step` `{ askId, step, of, label }` and one `ask:done` `{ askId, outcome: placed |
  partly | clipboard | answered | question | stopped | failed | other, status?, lines, results, did, undoable, path }`.
  IPC: `ask:preview`, `ask:run (text, choices, cloud)`, `ask:stop`, `ask:undo`; inputs checked in ipc-validation.js.
- Several people in one message = one group message (Messages: `chatLink` with an array of handles ->
  `sms:/open?addresses=`; WhatsApp: the group with exactly them), else a draft each, said in `did`. `separately` keeps
  one each. Messages groups cannot be selected through Accessibility on this macOS: a group draft by name falls to the
  clipboard and says so.
- Cloud: only after a yes through `consentFor('box' | 'ask', { settings, once })` (cloud-screen.js; the source scan in
  test/hikyaku-cloud-screen.test.js fails a hand-written consent). `box` = an email reply (that one email + the line).
  `ask` = a sentence code could not read (the sentence + the action list only); the pick is checked by `parsePick`
  (names must be in the sentence) and runs only after "Did you mean" -> Yes.
- Move: `findMeeting` + `readWhen` (ask-move.js), then native/outlook-move.swift `move` (week view -> one real click
  -> Edit Event -> day buttons + Start time menu, length kept) and `discard` (close + exactly "Discard Changes").
- NEVER: send, press Send / Send update, or let a model write or run an action. Undo clears a chat box only when it
  holds exactly Loggie's words (`composer-clear --expect-file`).
- One ui-acts.jsonl row per ask (`act: "box"`): action, outcome, path, placed, to, apps, ms. Never the words or names.
- Tests run the real placers with only the app calls faked (2026-10-11: a stubbed opener hid a missing folder).

### The word map: one sentence read in any order (loggie-ask-wordmap, built 2026-10-12; docs/ask-box/wordmap.md)
**Contract:** `readWords(sentence, { isName, places, action })` (src/hikyaku/wordmap.js, pure) -> `{ action, app, words:
[{ text, start, end, role, group?, for? }], who, when, where, about, quote, kind, room, notes, unused }`, `role` one of
`action | who | when | where | about | kind | room | notes | message | app | mark | filler | unused`. `start`/`end` are
offsets in the sentence AS TYPED (a mistyped key word is fixed before reading, word for word, so offsets hold).
- Invites: `readSentence(sentence, { people, now, places })` (quick-invite.js) reads its values out of the word map's
  parts with the SAME `PATTERNS`; `plan.words` carries the roles, `plan.leftOut` the unused words (reported, not used).
  An unused word right after a verb, "and", "&", "+", "," or "with" is a person Loggie does not know: an Error.
- Texts and replies: `readAsk` (ask.js) runs its verb-first shapes, then `readMessage` (any order: "running late, text
  lena"); the word map's reading wins when the verb-first one names no one known or fewer people. `markAsk(sentence,
  ask)` puts the answer back on the words. The first action word decides the action (`actionOf`); "text", "message",
  "schedule", "book", "meet" act only as the first real word, before a name, or as the last word.
- Names: the longest run of up to 3 words that is someone known; mid-sentence only a whole or first name, after a verb /
  joiner / comma also a name's start or a one-letter slip (people.js `oneEdit`, adjacent swaps count). Names join one
  group only through and / & / + / comma. The word after at / in / @ is never a person.
- Places the user has used (places.js): calendar locations (last 60 days, next 30) + places typed into filled invites
  (hikyaku/places.json). A bare place is the place only when it is one of these; else it is flagged unused.
- Preview: `asker.preview(text)` -> adds `marks` (the words with roles) to every answer; an invite answers `{ action:
  'invite', status: 'ready' | 'question', line, app, marks, invite: { who: [{ name, address, alternates }], when,
  timeGiven, where, room, title, titleSaid, leftOut, repeat } }`. Invites still RUN through command-service.
- Box (desktop/renderer/ask-box.js): underlines in a transparent copy of the textarea (#askMirror, same font and wrap),
  one slot per role, a hint from the last small word, fix-it buttons that REWRITE THE SENTENCE (so what shows is what
  runs), the app chip rewrites "on whatsapp" / "on google", Esc clears, Up/Down recall (localStorage
  `loggie.askHistory`, 50). Enter runs only `canSend()` sentences.
- Bar: every Gemini Flash round in test/fixtures/ask-corpus/ (test/ask-corpus.test.js, graded by
  scripts/ask-corpus/grade.mjs); corrections to Flash's answers only in corrections.json with a reason. `npm run
  check:ask` presses every box button on the real panel with the real readers (made-up people).
- One ui-acts.jsonl row per send (`act: "box-read"`): action, unused, fixed, recalled. Counts only, never words.

### Email asks: the thread the words point at, the line kept, the draft first (loggie-ask-thread, built 2026-10-12; docs/ask-box/thread.md)
**Contract:** `threadsFrom(mail, address, own)` (src/hikyaku/ask-thread.js, pure) -> the person's threads newest first
`{ id, key, subject, at, ccOnly, count, target, words }`; `key` = `threadKey(subject)` (Re:/Fwd:/回覆:/calendar answers
folded); `target` = the newest email from the person that is not a calendar answer (a thread of only those is dropped);
`ccOnly` = the user is on Cc and not To. `pickThread(line, threads)` -> `{ thread | null, how: only | newest | not-cc |
words | none, matched, others }`: default = the newest thread that is not ccOnly; another thread only when the line's
words (STOP list, the person's name out) score >= SWITCH_SCORE (sum of 1/threads-holding-the-word) there and none are
in the default. NEVER a new email by guess: only when the user picks it or the person has no thread.
- Runner: `email.threads(address)` replaces `findEmail` (cached 60 s per address in ask-run); `preview` adds `thread:
  { id, subject, at, ccOnly, how, why, matched, others }` (no bodies); `run` takes `choices['@thread']` = a thread id
  or `'new'`; emits `ask:draft { askId, to, app, thread, subject, body, how, ms }` BEFORE openDraft. A new email writes
  REPLY.json `{ to, subject, account, fresh: true }` + SUBJECT.txt and opens through draft.js's compose path.
- Draft check: `keepsLine(line, body)` (ask-reply.js): every number in the line and half of its other words must be in
  the cloud draft, else the typed words are used (`how: 'words-after-ai-dropped-line'`, said in `did`).
- Box: the In slot is a button (`.ask-in`) that opens the threads + New email (`.ask-threads`, the "which one" chooser's
  buttons); a pick is kept for that person only; `.ask-why` says why when the pick is not the newest. The card shows
  the draft on `ask:draft` ("Placing it in Outlook…") while the status line still runs.
- Helpers: `helperPath` shares one build per helper (native-helper.js); main.js `warmOutlookHelpers()` builds the
  Outlook and move helpers at launch (a 7.6 s swiftc once sat inside an ask).
- ui-acts `box` row for an email adds `thread` (how), `drafted`, `draftMs`. Counts only, never words.
- Bar: `node scripts/ask-thread/replay.mjs` replays the user's own sent replies (read-only): typed lines >= 80% and
  never under the newest-email rule (2026-10-12: 23/26 vs 23/26). Tests: test/ask-thread.test.js, test/ask-reply.test.js,
  `npm run check:ask` checks 11-12.

### Replies at his length, in his email voice (replies-quality, built 2026-10-17; docs/replies/spec-a.md)
- Email drafts read `EMAIL_VOICE` (rules, recent, intros); chat drafts `CHAT_VOICE` (rules, recent, texting)
  (nebius-draft.js `draftPrompt({ chat })`). texting.md in an email prompt lowercased drafts.
- `lengthFor(entries, { taskIds })` (delta.js): median sentWords of email sends, the workstream's at >= 3 sends, else
  all, else null. recent.md opens with a `## Length` block; `length.json` `{ median, sends, at }` sits beside it
  (writeRecentVoice, voiceForWorkstream). Numbers only.
- `draftOnce({ complete, text, chat, length })`: at most 2 calls. Out of shape -> one retry; else a DRAFT.md over
  `REASK_OVER` (1.2) x median -> one re-ask, shorter valid draft kept. Code never cuts words; chat is never re-asked.
- `outcomeOf({ finished, notes })`: a DONE on a move with notes is `needs-you / nothing-to-do` with "write it anyway"
  and "done"; `answerTask` "done" closes it with no run. No notes -> closes as before.
- Offline bar: `node scripts/draft-eval.mjs --archive <home copy> --out <scratch>` then `--score`; data stays outside
  the repo. Tests: test/replies-quality.test.js.

### Introductions: a person named in an email becomes a person, a move and an unsent email (loggie-intros I1, built 2026-10-20; docs/intros/spec.md)
**Contract:** `introducedIn(message, { own, writtenTo, few = FEW, names })` (src/hikyaku/introduced.js, pure) -> `[{
name, address, shape: 'body' | 'to', by, at }]` (body pairs first). Gates: a parseable timestamp; the sender (first From address) not own, not router.js
`MACHINE`, and in `writtenTo` (the lowercased `to` of the Sent rows the catch-up read, nothing else); at most `few`
To + Cc. Body shape (spec 1.1 rule 3): an address in `ownText(body)` (mailto copies cut) on no header, not own or a
machine or a service domain, local part starting with a letter, 1 to 3 capitalised words right before it on its line
(not "Email", "Hi", ...), and an introduction cue in the 200 characters before it. One pair per address; two or more
in a message is a list: none. To shape (I3, rule 4): exactly one other To + Cc address (not own, the sender or a
machine), `/\bintroduc/i` in the subject or the first 600 characters, and a name: the header's own ("Name <addr>",
the text since the previous address, at most one comma) else `names.get(address)` (catchUpOn: `mailNames` of
readMailPeople over OUTLOOK_CATCHUP_DAYS; the replay: of its 60-day `mail`), through `flipName`. No name: none. A To
pair is saved, never movable: its move is the reply. `flipName(name)` (ask-who.js, D7): exactly one comma and no
suffix after it (jr sr ii iii iv phd md mba cpa esq) -> "First Last"; buildWhoIndex flips inbox sender and mail row
names, so one person stored both ways is the `twins` question. Fixtures: test/fixtures/intros/*.json (B1-B5, T1-T3,
N1-N2, D1-D3), test/hikyaku-intros-fixtures.test.js: 8 of 10 at least (B5 the known miss) and every decoy.
- `introsIn(threads, { own, writtenTo, few, names })` -> Intros (`Pair & { thread, message }`): only threads with a message
  of the user's (workstreams.js `isOwn`), one per address across the call, the earliest. `movable(intros, sent)` ->
  `Map<thread id, Intro[]>`: body only, and not when a Sent row has the address in `to` after `at`.
- `addPeople(home, name, people)` (workstreams.js) -> `{ added }`, inside `updateWorkstreams`: merged by lowercased
  address, a person already there left as is, new ones first under the 200 cap; an unknown name throws.
  `isNamed(w)` = no inbox / chats / folder flag; `isKept(w)` = named and not (`found` without a string `confirmed`).
- catchUpOn (desktop/main-catch-up.js): `recoverSentMail` gets a `readSent` that keeps the Sent rows it read; in a
  kept workspace only, `introsIn` -> `addPeople` (every Intro) -> `movable` -> `catchUp({ intros })`. runs.jsonl
  `intros: { pairs, saved, movable, moves }`, numbers only. A failed Sent read keeps no rows: no pair (fails closed).
- The move is CODE-MADE (spike S-C, 2026-10-20: on the screened made-up body thread Nemotron proposed only a reply, 0
  of 3 runs). catchUp adds, after the model's actions and not on "Just keep me posted", one action per movable Intro on
  a thread it read: title `Email <name> (introduced by <first name>, <Mon D>)` (TC3; `introTitle`: the sender's
  display name, the part after the comma for "Last, First"; no usable name -> `(introduced <Mon D>)`; the email's day
  on this Mac; never an address or a pronoun), sourceId `<thread id>:email:<slug(name)>`, the quote = the sentence holding
  the name in `screenText(ownText(body))` (dropped if any "@" is left), completion "A new email to the person
  introduced in this thread is open in the user's mail app, unsent." REPLY.json `{ ask: { line: "email <name>", to,
  ask: "", address, from: "intro", by, at }, fromChat: null }`. The catch-up prompt is unchanged: a model email action
  on an email thread still drops.
- NEVER an introduced or introducer address in a prompt, title, description, Core brief, BRIEF.md, `ask.line` or the
  askMove text; it lives in workstreams.json `people` and REPLY.json only (tests: test/hikyaku-intros.test.js 1.2).
- `moveDetail` `to` = REPLY.json `to`, else `ask.address` when `ask.from === 'intro'`. Draft it (do-it.js askMove): an
  intro with no line stops on "Type what to say to <name> in the line box, then Draft it." and never calls the ask
  box; with a line it calls `ask("email <name>: <line>", { choices: { <name>: "outlook:<address>" } })`. The main
  wrapper (main-ipc-moves.js) passes the choice only when `entryKey` of some who-index entry equals it (one reload with
  `maxAgeMs: 0`), else answers `failed` "<name>'s address is not in Loggie yet. Refresh the workspace": never a name guess.
- Who index (D1): `whoPeople({ workstreams, threadPeople })` (ask-who.js) = the kept workspaces' people with an
  address, in file order, then the THREAD.md pairs not already there, one per address; loadWhoIndex feeds it to
  `buildWhoIndex` as `people`. Tests: test/hikyaku-intros-move.test.js, test/ask-who.test.js.
- Replay (I2): `npm run check:intros` = `node scripts/intros/replay.mjs --days 60 [--domain d] [--show] [--move-check]
  [--home h]`, READ ONLY (the source scan in test/hikyaku-intros-replay.test.js: from node:fs only readFile, readdir,
  stat; no child_process; no write call). It routes `outlookItems` by date (afterRow null, nothing skipped) with the
  live home's router context, and builds threads from Inbox candidates (gates 2-3 on headers) and Sent 120 days by
  Apple Mail conversation. Pure half `replayReport(input, { days, ms, show, domain })` (src/hikyaku/intro-replay.js)
  -> `{ lines, summary, exit }`: one `file` line per workspace-domain email with its reason (`in log`, `logged
  elsewhere`, `logged unsure`, `routed elsewhere`, `unsure`, `before the workspace`, `not in window`, `stored late`,
  `not looked yet`; a domain of two workspaces is `shared domain`, out of the exit), one summary per domain (absent =
  seen minus in log), one `intro` line per Intro (move: `reply (existing)`, `none (no workspace)`, `none (not kept)`,
  `none (written <date>)`, `email`). `moveCheck(thread, intro, { own })` runs checkActions + `introActions` on answers
  naming her (must bind her address) and the introducer (must bind nothing); `adversarialCheck` tries every
  capitalised run. Exit 1 on a WRONG line (a domain email routed elsewhere or unsure, a wrong or missing binding, the
  introducer bound, adversarial wrong > 0; `--domain` limits the file and intro lines to that domain), 2 on a failed
  read. Prints domains unless `--show`.

### Availability: free times in an email, from the calendar on this Mac (loggie-availability I1, built 2026-10-21; docs/availability/spec.md)
**Contract:** src/hikyaku/availability.js, pure except `availabilityFor` (injected readers) and `askAvailability`. Every
time is computed in `timeZone`, never the process zone. The model never writes or sees a time: it writes `[your
times]`, code fills it after the model answers.
- Cue (1.1): `availabilityAsked({ typed, line, email })` -> `'typed' | 'thread' | null`. `TYPED_CUE` (THREAD_CUE or bare
  availability/available) on what the user typed or `ask.words`; else `THREAD_CUE` (request shapes only: "your
  availability", "time slots", "what times work for you", ...) on `ownText` of the ANSWERED email only, never older
  messages. Only the cue fires availability; a guard placeholder in any other draft stays `[your times]`.
- Window (1.2): `readWindow({ typed, email, emailAt, now, settings })` -> `{ days: ['YYYY-MM-DD'], startMinute,
  endMinute, minutes, timeZone, notice: 60, from: { days, hours, minutes: typed | thread | settings }, stale, named }`, never
  throws. Each field from typed, then the email (its own day as reference), then Settings. Days, first kind found:
  today/tomorrow (`PATTERNS.today`), weekday names (`DAY`, exported from wordmap.js; "next" or a typed same-day weekday
  whose hours are over moves 7), dates (`PATTERNS.date`), this/next week; then past days, today when its hours are over
  (`ceil15(now + 60) + minutes > endMinute`), and days over 60 ahead drop; at most 10. Nothing left from the email:
  Settings days with `stale: true`. Hours: clock words (between / X to Y / after / before; bare 1-7 pm, 8-11 am) before
  part of day (morning start-12, afternoon 12-end, evening 17-20, plurals too: "this week mornings"); a reading not
  running forward or past 20:00 is ignored. A typed time is the window's (TC3): "friday after 2pm" fills only what is
  free from 2pm to the Settings end hour; fully booked there gives the none-free note, never a range outside it. Minutes: `PATTERNS.length` / `lengthBare`, kept 15 to 240.
- Rules (1.3): `availabilitySettings(raw, { macZone })` -> `{ startHour 9 (6-12), endHour 17 (12-22, > start),
  timeZone (meetingHours.timeZone, else the Mac's), minMinutes 30 (15/30/45/60/90), daysAhead 5 (1-10), selfBlocks true }`,
  each invalid value taking its default alone; `availabilityView` adds `stored`, `macZone`, `zones`. Keys:
  settings.json `meetingHours.{startHour,endHour,timeZone}` (the key next-move.js and cloud.js already read) and
  `availability.{minMinutes,daysAhead,selfBlocks}`. Invites keep `FIND_HOURS`.
- Read (1.4): `availabilityFor({ window, settings, eventsImpl, statusImpl, now, timeoutMs = 5000 })` never rejects ->
  `{ read: read | unreadable | empty, reason, window, rules: { selfBlocks, minMinutes }, days: [{ day, ranges: [{ start,
  end }] }], text, ms }`. `statusImpl` first (never a dialog): not granted is unreadable. One `eventsImpl` call from 00:00
  seven days before the first day through the last, raced against the timeout. A throw, the timeout or zero events
  keep `[your times]`, never all-free; `reason` is a fixed string (`REASONS`), never the helper's text. Busy =
  `blocksTime` (calendar.js, which now holds the marker rule, D1: `isMarker` = no attendees and over `MARKER_MS` 8 h;
  quick-invite.js imports it), minus uninvited events when `selfBlocks` is false. `freeSlots` one day a call from that
  day's opening hour (D4), clipped to the window and to `ceil15(now + 60 min)` today, start rounded up and end down to
  15 min, shorter than `minutes` dropped. Overlap: `[a, b)` and `[s, e)` when `s < b && e > a`.
- Words (1.5): `formatAvailability(days, { timeZone })`: one line per day "Fri Oct 23: 9 to 11:15am, 12:30 to 1pm",
  am/pm on the end and on the start only when it differs, whole hours without ":00", the zone once at the end
  (`zoneLabel`: shortGeneric when 2-4 capitals, else short: ET, GMT+1, UTC). `daysLabel`, `hoursLabel`.
- Prompt (1.6): `replyPrompt` / `newEmailPrompt` take `times`; true adds exactly `TIMES_RULE` after the FINISH rules;
  false gives the 48cdf3e string (saved in test/ask-reply.test.js). No slot, range, day of the block, event, title,
  calendar, account or attendee is ever in a prompt. `keepsLine(line, body, { skip })`: `lineSkip(line)` (cue, day,
  part-of-day, clock ("after 2pm", "before noon", "between 10 and 2", "2 to 4pm") and length words) is left out of the
  check in an availability draft; guardTimes and strayTimes still judge every time the draft names.
- Fill (1.7, prepareEmailReply `asked`, `availability`): model -> keepsLine -> `guardTimes` (unchanged, never after
  the fill) -> await the read (started by the caller before the model call) -> `fillTimes(body, availability, {
  signName })` -> `{ text, how: line | inline | inserted | left, block: [from, to] }` (a line of only `[your times]`
  becomes the block; else the first inline one is cut and the block follows its paragraph; else the block goes before
  the sign-off line or the signName line or at the end; not read with a placeholder: left) -> `strayTimes(text, days, {
  skip: block, timeZone })` takes out any time outside every offered range, whoever wrote it. Words mode fills the
  typed words the same way.
- Notes and record (1.8, 1.9): `availabilityReport` -> `{ note, did, record }`; the ask's note is filled '' (or the stale
  line, or "<days> has no open N minutes; the other days are in the draft." only when `window.named`: the words
  named the days, not a week or Settings days, fixture F7), none free "Your calendar has no open N
  minutes on <days> from <hours>; [your times] is left for you.", not read "Loggie could not read your calendar
  (<reason>); [your times] is left for you."; did "Read your calendar on this Mac for <days> (<hours>, N min or
  longer): n open time(s) written into the draft". ask-run replyByEmail (one person) puts `results[0].availability =
  { asked, read, reason, window, rules, days, how, stray, ms }` in ASK.json: times and the window only, never a title,
  calendar, account or attendee. It runs only when the app gave `email.events` (main-ask.js `...askAvailability({ home:
  hikyakuDirectory })` -> `{ events, status, availability }`).
- ui-acts: `boxActRow(data, { draftMs, at })` (ask-run.js) is the one `box` row; an availability ask adds `times:
  filled | none-free | unreadable | empty`. Tests: test/availability.test.js, test/availability-ask.test.js,
  test/availability-wiring.test.js, test/ask-reply.test.js (1.6).
- Check (I2): `npm run check:availability` = `node scripts/availability/check.mjs [--since YYYY-MM-DD] [--replay] [--days
  120] [--min n] [--show] [--home h]`, READ ONLY (source scan in test/availability-check.test.js: from node:fs only
  readFile, readdir, stat; no child_process; no write call; the calendar helper already built is called directly, never
  rebuilt). Live: every `asks/<id>/ASK.json` whose `results[0].availability.read === 'read'` (`--since` on its `at`,
  local midnight). `--replay`: Inbox mail through sent-mail.js `readInboxMail` from people in some `readSentMail` row's
  `to`, whose `ownText` matches THREAD_CUE, through readWindow and availabilityFor at the email's own time. Pure half
  `checkReport({ records, events, min, show })` (src/hikyaku/availability-check.js) -> `{ lines, judged, wrong, notes,
  exit }`: each range against the days' events read now; overlap with an event that blocks (blocksTime, and
  `rules.selfBlocks`) is WRONG; with a marker, an all-day item, an uninvited read-only feed or (selfBlocks off) an
  uninvited event a note. Lines `ask <date> <n> ranges ok|WRONG|note`, `replay <date> @<domain> ...`, then `judged: n,
  wrong: w, notes: k`; `--show` adds the ranges and the overlapping times, never a title, calendar, account or attendee.
  Exit 1 on any WRONG, 2 on a failed read, 3 when judged < `--min` (10 with --replay, else 1), else 0. Fixtures:
  test/fixtures/availability/F1-F14.json (the spec's answers), test/availability-fixtures.test.js, 14 of 14.
  2026-10-21 replay, 120 days: judged 20, wrong 0, notes 54 (26 all-day, 28 marker), exit 0.
- Settings (I3): "Your free times" on the Settings page (panel.html `#timesSection`, after Cloud analysis), five
  `.settings-row.times-row` rows: Working hours (`#timesStart` 6-12, `#timesEnd` 12-22), Time zone (`#timesZone`, "This
  Mac (<zone>)" sends null), Shortest opening (`#timesShortest` 15/30/45/60/90), Days ahead (`#timesDays` 1-10),
  Events with no one invited (`#timesSelf`, Count as busy). Each saves its one key on change and writes "Saved" or the
  thrown message in its own span; filled when Settings opens. `validateAvailabilityPatch(patch)` (ipc-validation.js,
  the values of availability.js `AVAILABILITY_VALID`) -> the patch or "That is not a setting Loggie offers.".
  `saveAvailability(home, patch, { macZone, readImpl, writeImpl })` -> view: `readRawSettings` first (empty,
  unparsable or non-object refused, nothing written); an hour patch with end <= start (against the stored or default
  one) "The end of your hours must be after the start.", nothing written; only the patch's group (`meetingHours` or
  `availability`) is rewritten from its valid stored fields plus the patch (timeZone null deletes, an empty group
  deletes the key); every other key untouched; 2 spaces, trailing newline. IPC (main-ask.js registerAsk, both
  handleSecure): `hikyaku:availability-settings` -> `availabilityView(readRawSettings(home))`;
  `hikyaku:set-availability (patch)` -> `inSettings(() => saveAvailability(...))`. Preload `availabilitySettings`,
  `setAvailability`; panel.js wrappers of the same names. Tests: test/availability-settings.test.js; `npm run
  check:clicks` "Settings, Your free times" (each row's patch and "Saved").

### Class notes: classmates leave as Student N, names come back on this Mac (loggie-class-notes I1, built 2026-10-21; docs/class-notes/spec.md)
**Contract:** `privacy.mask_classmates(text, event, own=(), protect=()) -> (masked_text, names)` (transcriber/spike/privacy.py,
pure), run inside `privacy.screen(header, turns, names, mask=None)` when `summary.kind_of(event) == 'class'` (screen_folder
builds `mask = (event, *class_inputs(folder, event))`). `names` = `{ "Student N": { name, forms, unclear, likely, rule, at } }`,
numbered by the first position of any form (header first); one person one label; written into held.json as `names`
(`{}` when nobody was found) with `counts.masked = { labels, mentions }`. Not a class: no `names` key, output byte for byte.
- Rules (code only, the Mac has no model): `invitee` (lexicon.invitee_names: full name and each 3+ letter word, one
  label), `addressed` (YES-word before; filler-led start "So Jay, what..."; "Name?"; "uh Name."; a name closing a sentence
  after a lowercase word and a comma "together, Steve."), `unclear-name` (Name (unclear) not after a capitalized word, a
  TITLE or a STOPPER), `joined` (and/& next to a found name, 3 rounds). Filters: own (the user's names, lexicon.json own
  entries), protect (title words, transcript.DATES), NEVER, PLACES (countries, states, peoples), figure (two capitalized
  words in a row), ordinary (said in lowercase in the call; unclear-name and joined only). Only personal names (A1,
  2026-10-23, the 10-22 class: 38 labels, 22 not people): `person(w)` turns away a dictionary word that is not a first
  name (`ordinary`, /usr/share/dict) unless spoken to by ADDRESSED 0 or 3 or joined, a word said `FREQUENT` (6)+ times and
  never spoken to, an `acronym` (capitals somewhere, or initials of words said within 300 chars); a variant (unclear at
  every mention, ratio >= 0.7 to a turned-away frequent word) is dropped; an unclear name after "at/of/called X and" is a
  firm or case; protect adds the event description's and course materials' (.txt/.md) capitalized non-first-names.
  Fixture: fixtures/class-mask-content.json. Review fixes (MASK_VERSION 2026-10-23b): a question opened by the name
  ("Rain, could you explain?") is strong; a first name is never turned away as frequent; a name spoken to is never a
  variant; `about_words(event)` (description, materials) protects unclear-name and joined words only, never an invitee
  or a name spoken to; the typed notes (my-notes.md) are the mask's 4th item, searched with the transcript (`at:
  ["notes"]`), and notes newer than held.json make a class pair not fresh; Dr/Doctor/Mr/Mrs/Ms before a name mark a
  figure only for the event's professor or organizer (Professor and public titles still do). Review round 2
  (MASK_VERSION 2026-10-23c, `classmates_in` + `merge_found`): the transcript, the notes and both together are searched
  apart and merged, so notes only add; a name spoken to (or invited) beats the figure, title-word, acronym and frequency
  filters, and a date or place only when thanked or greeted ("Thanks, Georgia."), except a figure word said FREQUENT+
  times (a guest); Mr/Mrs/Ms name a figure; accents, hyphens, two-letter names spoken to, "Thanks, X for", full names
  spoken to, imperatives, invitee nicknames (`NICKNAMES`) and the word after a found name (its surname) are read; in typed
  notes only, "X said/had the best answer" and "- X:" (`MENTIONED`); frequency rejects only with topic evidence
  (`TOPIC_BEFORE`/`TOPIC_AFTER`); "case was X and Y" and `FRAMEWORKS` stay; `form_re` also matches the form in capitals,
  in lowercase when it is no English word, and with a bare apostrophe; `relabel` keeps a word/date/place form after
  "the company", "in", "of" (`WORD_USE`, `TIME_PLACE_USE`).
- `relabel(text, names)` (forms longest first, whole word, possessive kept, "(unclear)" folded in), `unmask(text, names)`
  ("Student N" -> name, "(unclear)" when every mention was; "Students 1 and 2" joined; unknown labels stay),
  `relabel_record(value, names)`. JS twin: src/hikyaku/class-names.js `unmask`, `isClass`; parity on
  transcriber/spike/fixtures/class-unmask-cases.json (both test files read it).
- lines[]: a sent row's text is its relabeled text (the review and Keep this line read it); held rows keep their words.
  `screen_notes(folder, classmates)` relabels the typed notes with the call's map. `sendgate.fresh_pair(folder, event)`:
  a class pair with no `names` is not fresh (screened again before review).
- byo.py: no `--allow-class`; `classmates_of(event, held)` refuses a class pair with no map (`CLASS_UNMASKED`, exit 2)
  after `screened()` and after filing; `build_prompt(..., classmates)` uses `CLASS_PEOPLE`; a filed title matching
  `privacy.LABEL_WORD` is dropped (`title_dropped`); goal passes skip a class; `LABEL` adds `Students? \d+` (a label the
  map lacks is a recording label, not sure). Order after the reply: `unmask_quotes` (each quote's labels -> the form said
  within 30 s of its stamp; a label cut at the end goes) -> `privacy.unmask` -> parse/check against transcript.md ->
  `relabel` the notes text and `relabel_record` summary-runs.json (`privacy.classmates` = labels) -> explain on labels,
  its result relabeled. Every notes file keeps labels: six readers send the notes on to a model (spec C1).
- Long calls and the shape (A2-A5, 2026-10-23): summary-clean.txt asks `shape_for(span)` (about one heading per 20
  minutes, 3 to 12; bullets one per 2 to 3 minutes) and `{cover}` (every minute in order, the last 30 too); a class gets
  `CLASS_NEXT_STEPS` (assignments, deadlines, logistics such as "no class next week", never an in-class exercise's
  steps). `plan_prompts` -> parts: a clean-prompt call over `CHUNK_OVER` (45 min) is split by `chunks_of` on turns into
  ceil(span / 30 min) parts, each its own request with real stamps, then `build_merge_prompt` (prompts/summary-merge.txt)
  joins them; `ask_in_parts` returns the merged reply, which goes through unmask_quotes, parse and check unchanged.
  summary-runs.json `chunks` = `{ minutes, parts: [{ part, from, to, turns, chars, reply_chars, headings, bullets,
  seconds, model, finish_reason, tokens, retried, failed: [same fields per failed attempt] }], merge: {..., max_tokens,
  retried, failed}, chars: every request's prompt chars }` (null for one pass; summary-runs.json `chars.prompt` is
  `chunks.chars`); raw folder adds part-N.md and
  merge-prompt.txt. Review fixes: a part that is not `usable` (a control token, or no bullet with a stamp) is asked
  once more with a changed request, then the run exits with nothing written; the merge gets `merge_budget` (parts'
  output x 1.25 + 1000, 4000 to 32000) and a "length" answer (`ask_nebius(allow_length=True)`) is asked once more at
  twice the budget, else nothing written; `goal_of` is None for a class. `notes_model(event)`: Ultra for team, goal and class calls. A dry run prints the shape and the parts.
  Round 2 (2026-10-23): `ask_nebius` raises `Unanswered` (a SystemExit with `meta`) for an empty reply or a stream with
  no finish_reason; parts and merge catch it as a failed attempt. A merge that is not usable or leaves out a part
  (`left_out`: no stamp of the part's non-Next-Steps bullets in the merge) is asked once more, then nothing written. A
  one-pass class that is not usable is asked once more, then nothing written; a team retry must be usable. Every retry
  (part, merge, class, team, goal) strips the old "Request" line and adds a changed instruction, so its saved answer is
  stable. `read_md` ends the last turn at the header's "N min." when later. `build_merge_prompt` fills in one pass.
  Read-only check: `python3 -B scripts/class-notes/plan-check.py --truth <file> [--calls <dir>] [--keep W,W]` (check.py's
  judge, then the prompts built and never sent: keep words unmasked and in a prompt, every turn in one part, the
  merge's heading count and span). Tests: test_byo.py (long calls), test_class_check.py (plan check).
- Display only: call-list.js `newestRun` adds `names` (the map of `run.privacy.held_file`); `callDetail` restores the text,
  checks, live draft and explain lines. name-check.js: a class sorts and searches nothing (`ask`, `search` never called).
- summary.names_for on a class: the user by name when the event knows it, else "a student" (D1).
- Tests: transcriber/spike/test_class_notes.py (fixtures/class-mask-cases.json, made-up people), test_byo.py (D7),
  test_summary.py (D1), test/class-names.test.js. Real classmates' names never in the repo (spec C8).
- I3 (built 2026-10-21), what the user sees: the screen.summary text adds `, N classmates written as Student 1 to N`
  only when `counts.masked.labels > 0` (sendgate.py `summary_text`, events.js `summaryText`, same words; one label reads
  `, 1 classmate written as Student 1`), and sendgate.py's send.json gets `classmates` = labels. meeting-cards.js
  `decisionCards`: a send with `classmates > 0` (a bundle: any call, the largest count) shows `classmatesLine(n)`
  ("Classmates' names stay on this Mac: the AI reads them as Student 1 to n, and your notes show the names.") in place
  of NAMES_LINE. calls.js `fileCall`: for `isClass(event)` an own step whose title or quote matches
  `/\bStudents? \d+\b/i` is not filed (it stays in the notes; the other steps keep their `#n`) and the result (and the
  dry run) carries `classmateSteps`; not a class: no such key. screen-depth.js `callStepsFor`: the summary is unmasked
  with `summaryOf(folder).names` before `eventLines`. hold-line.js unchanged: `heldRecord` clones the record, so the
  new held-N.json keeps `names` and `counts.masked`, and a sent row's text is already its labeled text. Tests:
  test_send_gate.py, test/hikyaku-entry-events, -offer-surface, -calls, -screen-depth (.test.js each).

**Class check (I2, read only):** `python3 -B scripts/class-notes/check.py --truth <file> [--calls <dir>] [--show]
[--notes] [<folder> ...]`. Truth `{ "<folder relative to calls>": { students, others, own: { name, spoken, header } } }`
("_" keys skipped; no folder args = every key; a folder arg must be a truth key). `--calls` defaults to
`<LOGGIE_DATA_DIRECTORY or ~/Library/Application Support/Loggie>/hikyaku/calls`; LOGGIE_HIKYAKU_HOME is set to its
hikyaku folder only when unset. Per folder: transcript.md there or in the highest-numbered `v*` with one, event.json
via `summary.event_of`, then in memory `privacy.screen` twice (unmasked, and with `mask = (event, *class_inputs)`).
One line per folder plus a total: classmates, mentions before / left after (truth student forms: full name and each
3+ letter word of a multi-word name, whole word by `privacy.form_re`, a hit inside a longer hit not counted), own
places kept (own.name masked vs unmasked), labels written, content masked (truth `others` gone after the mask), other
words masked (map names in neither list). `--notes`: the newest run with an `output` in summary-runs.json; map forms
(its `privacy.held_file`) plus truth student forms counted in the notes file, that run's record and `<stem>-explain.json`;
cited_verified of bullets. Exit 1 (line starts `WRONG`) on a mention left, an own place lost, more than 3 content
names masked in a class, or a form in a notes file; exit 2 on any failed read (all reads happen before any judging).
Prints counts and folder names only; `--show` adds `Student N -> name (rule)` and the leftover names. Writes nothing,
sends nothing: test_class_check.py runs it on a made-up calls folder (every exit, a file tree unchanged) and scans its
source (no write, path change, subprocess, urllib, socket or screen_folder; privacy.screen with the mask).

### Right-click menus and Share (loggie right-click, built 2026-10-28; ~/Loggie/workspace/right-click-proposal.md)
**Contract:** `menuFor(kind, state)` (desktop/renderer/context-menu-model.js, pure) -> `[{ id, enabled, on?, value?, line?,
submenu? }]`, ids only from `MENU_ITEMS` (recording: guess file share open copy rename trash; share: people sheet;
workspace: catch-up open more less park rename retire; move: draft done date drop call; text: cut copy paste selectAll).
- One `contextmenu` listener (context-menu.js `attachContextMenu`, panel.js): a text field, focused editable text or
  selected text under the pointer -> kind `text` (Electron roles); else the first `registerMenu` provider whose `find`
  names the thing (meetings.js `.mt-item[data-call]` and the open call's `.mt-titles`; workspaces.js `.ws-row[data-name]`
  and, on an open workspace, `.ws-move[data-move]`). Day rows, the Day card, `.ws-recording` and Today: no menu yet.
- IPC `hikyaku:context-menu (menu)`: `validateContextMenu` (known kind, target id per kind, known unique ids, no other
  keys, line <= 80 on one line, submenu only on recording `file`: <= 40 names + one null). Main writes every label
  (desktop/menu-template.js), draws `Menu.popup` and answers `{ id, value }` or `{ id: null }` (Esc, 150 ms grace); ui-acts
  `menu { kind, id, ms }` only on a pick. The page runs its own table (RECORDING_MENU, WORKSPACE_MENU, MOVE_MENU), each id
  the function its visible control calls; test/context-menu-model.test.js fails a menu-only action.
- Share (`hikyaku:call-share (id, how)`, `validateShare`; src/hikyaku/call-share.js): `people` = event.json emails minus
  `ownAddresses()`, one compose window via draft.js `composeCommand`, subject "Notes: <title>", unsent; `sheet` = ShareMenu
  with the same text and a copy of it in the OS temp folder. Body = `shareText`: parseSummary of the notes file as
  written (Student N kept, quotes and minutes off), owners, signName; never transcript, audio, my-notes.md, held names.
  The page gets a count only. ui-acts `call-share { how, people }`.
- Delete recording (`hikyaku:call-trash (id)`; src/hikyaku/call-trash.js): refused while listCalls says recording,
  transcribing, writing or waiting (`TRASH_REFUSED`, the menu's `CALL_BUSY` words); else the native confirm, the state
  read again, `refileCall(workstream: null)`, then `shell.trashItem(<home>/calls/<id>)`, `sayChanged()`. Never rm.
- Visible twins: Share button (`.mt-share`, beside Copy notes) and the quiet `Delete recording` link at the call page's
  foot (`.mt-foot`, greyed with its reason). "Add to workspace" is the menu's word; the chip, picker and payoff keep
  theirs. Tests: test/context-menu-model, main-ipc-menu, call-share, call-trash (.test.js); `npm run check:clicks`
  "Right-click and Share".

### ChangeItem: any source -> router -> changes.jsonl (src/hikyaku/changes.js, built)
**Contract:** `makeItem(raw)` returns a frozen
`{ id: "<source>:<ref>", source, at, title, who, ref, thread, workstream, how, candidates }`.
- `source` is one of `gmail | outlook | messages | whatsapp | calendar | call | park`.
- `at` is the ISO time of the item itself (the email's date, the chat's newest message, the event's start, the call's
  start), normalized with `new Date(x).toISOString()`.
- `who` is `[{ name, address? , handle? }]`, address lowercased.
- `ref` is unique per change: a source's id for the newest thing seen (see SPEC per source).
- `thread` is the continuation key: Gmail thread id, `baseSubject(subject)` for Outlook, chat id, event id, call folder.
- `workstream` is one workstream name or `null`. When null, `how` is `"none"` and `candidates` lists possibilities.
- `how` is one of `thread | filed | domain | word | person | asked | none`.
**Example:** `{ id: "outlook:apple-mail-123", source: "outlook", at: "2026-10-09T15:00:00.000Z", title: "RE: Introductions", who: [{ name: "Ana", address: "ana@bank.example" }], ref: "apple-mail-123", thread: "introductions", workstream: "Bank Offer", how: "domain", candidates: [] }`
`makeItem` keeps only the fields above and ignores any other (`text`, `recipients`, `filed`); it THROWS on an unknown
source, an unparseable `at`, an empty `ref`, or a routed item whose `how` is missing or `"none"`. `who` entries keep
`name` ("" allowed), a lowercased `address`, and a `handle` as given (trimmed). `appendChanges(home, items)` creates
the file if needed (the home folder must exist), skips ids already in the log or repeated in the same batch, and
returns the written items in input order. `readChanges(home, { since?, workstream? })` returns the logged items.
Message text (email bodies, chat message text) is never stored; titles (subject, chat title, event title) are.

### Watermarks: <home>/looked.json (src/hikyaku/changes.js, built)
**Contract (keys on disk):** `{ gmail: { "<workstream name>": ISO }, outlook: ISO, messages: ISO, calendar: { at: ISO, events: { "<event id>@<start ISO>": "<title>" } }, call: ISO }`.
The key `messages` holds the one watermark for both chat apps. Read with `readLooked(home)` (missing file -> `{}`;
corrupt file -> throws; `checkChanges` lets that throw). Write with `writeLooked(home, source, value)`, which
REPLACES that key's value; for gmail, pass the merged object `{ ...old.gmail, ...updated }`. A source's watermark
advances only when that source read without error, and the value written is `nowISO` (the `now` captured at the start
of `checkChanges`), never an item's time. First run (no value, or a workstream with no gmail entry):
`since = now - 7 * 86400000`. The calendar has no `since`: with no snapshot, every kept event in the window is a change.
**Row cursors (fix-late-mail, 2026-10-20):** Apple Mail, Messages and WhatsApp store things late (Exchange mail in
batches hours late, SMS relayed from the phone days late), so those sources are read by what the store added, not by
date. `outlookRow` is the newest Apple Mail ROWID read (from `apple-mail-<ROWID>`); `messagesRow` is
`{ messages?: chat.db ROWID, whatsapp?: Z_PK }` (the chat message `id`). With a cursor, a message is new when its row
is above it and it is at most `LATE_DAYS` (14) old, whatever its date; `outlookItems` passes `afterRow` to the reader.
Without one, by date: `since = now - 7 days` on a first run, `now - 3 days` (the one-time backfill) when the date
watermark exists. Either way an id already in changes.jsonl is skipped. A cursor moves only when its source (or app)
read without error. `writeLooked` accepts these two keys beside the sources.
**Chat sorts (2026-10-23, the Renée miss):** `chatSorted` = `{ "<source>:<chat id>": { at, home } }`, the newest
message time among the words the cloud sort (suggest.js) read of each chat (`linesAt`) and its answer (a workspace
name or null), kept LATE_DAYS; only an explicit answer is remembered (suggestHomes `answered`: a checked home or a
`null`; a broken reply or a message left out answers nothing). A chat placed nowhere is sent again only when its
newest message is newer than `at`. `chatResorted` = the ISO time the re-sort last finished: every chat with a message
in the past 7 days, with no routed or unsure line in the log and no remembered home, routed nowhere and with nothing
new that run, sorted once more, MAX_SUGGEST a call. It is set only when every sortable chat that run (new or re-sort)
got an answer, and set back to null when one did not (failed call, no yes or budget, past the caps), so the next run
sorts it. `chatPending` = `{ "<source>:<chat id>": at }`, those unanswered chats, kept until answered or LATE_DAYS old:
`chatItems({ pending })` reads them back LATE_DAYS (not the week) and the re-sort scans them to LATE_DAYS, so a
late-stored row older than the week whose sort failed is retried, not dropped once the cursor passes it. `chatItems` reads at least 8 days (the past week) whatever the cursor; its items carry `lines` (the past
week's texts and the new ones, oldest first, never stored) and `linesAt`, and it returns `chats` (one per chat with a
message in the past week); the sort reads `newestWords(lines)`: whole messages from the newest back within 1,200
characters, the newest always whole. `writeLooked` writes a temporary file and renames it over looked.json.

### Router: item -> { workstream, how, candidates } (src/hikyaku/router.js, built)
**Contract:** `route(item, { workstreams, learned, threads })`. Input item:
`{ source, title, text?, who, thread?, filed?, recipients? }`. Context built once per check with
`learnPeople({ home, workstreams, ownAddresses })`, `learnThreads({ home, workstreams, ownAddresses })` and
`threadMap(await readChanges(home), await learnThreads(...))` (the second argument is the seed of known threads).
`learnPeople` gives `learned`, `threadMap` gives `threads`. Pass the full workstreams list; `route` itself ignores
`inbox`, `chats` and `folder` workstreams. `route` is synchronous. Precedence: filed > thread > domain/word (split narrowed by people) >
confirmed person > unsure with suggested candidates. Do not change router.js in increment 3.

### Workstream fields (src/hikyaku/workstreams.js, built)
`readWorkstreams(home)` returns `{ name, kind, goal, domains, words, cloud, goalText?, people?, stake?, parkedUntil?, label?, confirmed?, inbox?, found? }`.
`stake` is absent (normal) or `"more" | "less"`. `parkedUntil` is `"YYYY-MM-DD"`. `confirmed` is the ISO time the person
kept a found workspace (first-run-polish B4). Named workstreams are those with no `inbox`, `chats` or `folder` flag.
Writes that race (discover, the goal demotion, keepFound, saveWorkstreamFields, dismissWorkstream, addWorkstream) go
through `updateWorkstreams(home, mutate)`, one chain per file; `setCloud`, `rememberPick`, `saveGoal` and `confirmGoal`
are still unlocked (a follow-up). A found card's mail is read only after Keep (`catchUpOn` refuses a found card that is
neither kept nor read; the refresh drops a found card's first read, refresh.js `firstReadsOut`).
A kept found card with `cloud` not "nebius" on an install with no `settings.cloudYes.found` has `readYes: true` (found.js
`needsReadYes`); its Workspaces page shows `CLOUD_YES.ai` and one Yes where Keep was (`.ws-read-yes`), which calls
`cloudYesAnswer('ai', 'yes')` then `hikyaku:found-read (name)`: `approveFound` (refuses without the found yes, only a
kept found card) sets `cloud: "nebius"` on EVERY kept found card without it (the yes covers found workspaces), then
`needCatchUp({ newest: true })` -> `catchUpFound` (newest kept first, one at a time, never awaited by the reply).

### Readers (existing, do not change their signatures)
- Gmail: `gmail.findMessages(query, { limit })` -> `[{ id, threadId }]` newest first, max 20;
  `gmail.getThread(threadId)` -> `{ id, subject, latestTimestamp, messages: [{ id, from, to, cc, timestamp, ... }] }`.
  Query syntax is Gmail's; `after:<epoch seconds>` works. `workstreamQuery(workstream)` gives the workstream's query.
  `gmail.getThreadHeaders(threadId)` (increment 5) returns the same shape from a `format=metadata` fetch (From, To,
  Cc, Subject, Date; `body` is ""); `gmailItems` uses it when the client has it.
- Outlook: `readInboxMail({ address, days, bodies: false })` (src/hikyaku/sent-mail.js) ->
  `[{ id: "apple-mail-<n>", conversation, from: "Name <addr>" | "addr", to: "a, b", cc: "c", subject, timestamp, body, snippet, source: "outlook" }]`.
  Day granularity: filter `timestamp > since` yourself. `baseSubject(subject)` is exported from the same file.
  Optional `afterRow` (an integer): only rows above that ROWID, and never a second copy (same `global_message_id`)
  of a message stored at or below it.
- Chats: `readChats({ days, maxChats, maxMessages })` (src/hikyaku/chats.js) ->
  `{ messages: { status, chats: [...] }, whatsapp: { status, chats: [...] } }`; a chat is
  `{ app, id, title, isGroup, participants: [{ handle, name | null }], messages: [{ fromMe, from, timestamp, text }] }`.
  An app whose `status` is not `"ok"` is an error for that app.
- Calendar: `listEvents({ from, days })` (src/hikyaku/calendar.js) ->
  `[{ id, title, start, end, allDay, calendar, account, writable, attendees: [email], attendeeNames: [name], recurring, location,
  calendarId, calendarType: local | caldav | exchange | subscription | birthday, isDefault, organizerIsMe, myStatus: accepted |
  tentative | pending | declined | ... | null }]` (the last five since 2026-10-27, for meeting.js `isMine`); `listCalendars()` ->
  `[{ id, title, account, type, writable, isDefault }]`. His events: `isMine(event, { recordCalendars })` = he organized it
  or is invited and has not declined, or nobody is on it and its calendar is in settings.json `recordCalendars` (absent:
  each account's main calendar, `recordCalendarsOf`; never the store default, iCloud Work on his Mac). Offers, the typed
  press (`pickNow`), the Day card, the week join and `call.py from_calendar` read it; a card or row press records its own
  event (`startManual(title, { eventId })`). call.py start writes `recorded_at` (the press); the header, call rows and the
  week join read it before `start`.
- Calls: `<home>/calls/<YYYY-MM-DD-HHMM-slug>/event.json` with `{ title?: string, start?: ISO string, workstream: name | "none", filed?: { workstream: name | null, at: ISO }, emails?: [address], names?: "Name A, Name B" }`. (`attendees` there is a display string; ignore it.)
- All reader timestamps are ISO strings (Gmail `latestTimestamp` and message `timestamp`, Outlook `timestamp`, chat
  message `timestamp`, calendar `start`). Compare with `Date.parse`. Chat `messages` are oldest first; still take the
  newest by the largest `Date.parse`. Gmail `thread.messages` are oldest first; "newest" is `messages.at(-1)`.
  Gmail and Outlook `from`/`to`/`cc` are strings like `"Name <a@b.com>, c@d.com"`: extract addresses with
  `/[^\s<>,;"]+@[^\s<>,;"]+/g`, lowercase, dedupe, and drop the user's own addresses; a name is taken only from a
  `Name <addr>` form in `from`, otherwise `""`.

---

## SPEC

### Function Signature

`checkChanges({ home, workstreams, ownAddresses, gmail, readInbox, readChats, listEvents, now }) -> { items: ChangeItem[], counts, errors, ms }`

Input: the hikyaku home, the workstreams, the user's own addresses, and the five readers (any may be `null`, meaning
that source is not connected and is skipped without error). Output: the ChangeItems newly appended to the log, per
source counts, per source errors, and total milliseconds.

### Product Requirements (increment 3, DONE: reference only)

`now` is a number (ms since epoch); `nowISO = new Date(now).toISOString()`. `ownAddresses` is an array of strings,
lowercased before use. `DAY_MS = 86400000`, `FIRST_LOOK_MS = 7 * DAY_MS`. `daysSince(since) = Math.ceil((now - Date.parse(since)) / DAY_MS) + 1`.

1. New file `src/hikyaku/sources.js` exporting `gmailItems`, `outlookItems`, `chatItems`, `calendarItems`,
   `callItems`, `checkChanges`. Each `*Items` returns raw items (plain objects, not yet `makeItem`d) and throws if its
   reader throws as a whole.
2. `gmailItems({ gmail, workstreams, since, ownAddresses, now })` -> `{ items, looked, errors }`. `since` is the gmail
   watermark object or `{}`. For each workstream without `inbox`/`chats`/`folder`:
   `query = workstreamQuery(w) + " after:" + Math.floor(Date.parse(since[w.name] ?? new Date(now - FIRST_LOOK_MS).toISOString()) / 1000)`
   (`workstreamQuery` from `./workstreams.js`); `gmail.findMessages(query, { limit: 20 })`. A workstream whose
   findMessages throws adds `{ source: "gmail", message: "<name>: <error.message>" }` to errors and is not in `looked`.
   For each distinct threadId, `gmail.getThread` once (cache across workstreams); a getThread that throws skips that
   thread, adds an error, and keeps every workstream that returned it out of `looked`. One raw item per thread:
   `{ source: "gmail", at: thread.latestTimestamp, title: thread.subject, ref: newest.id, thread: thread.id, who, workstream, how }`
   where `newest = thread.messages.at(-1)`, `who` = the newest message's from (with name) then to and cc, as
   `{ name, address }`. `how = "domain"` when any `who` address equals `x@<domain>` or ends with `.<domain>` for a
   domain in `w.domains` (lowercase), else `"word"`. A thread found by two or more workstreams becomes
   `{ workstream: null, how: "none", candidates: [every such name] }`. `looked = { [name]: nowISO }` for each
   workstream that succeeded. If more than 20 messages are new, the oldest are not seen; accepted (the re-read reads
   the whole window).
3. `outlookItems({ readInbox, address, since, now, ownAddresses = [address] })` -> `{ items }` (checkChanges passes every own address). `readInbox({ address, days: daysSince(since), bodies: false })`;
   keep `Date.parse(timestamp) > Date.parse(since)`. Item: `{ source: "outlook", at: timestamp, title: subject, ref: id,
   thread: baseSubject(subject), who, recipients }`, `who` = from then to then cc addresses (rule above), `recipients` =
   number of distinct to + cc addresses that are not the user's. `address` is `ownAddresses[0]`; with no address the
   source is skipped.
4. `chatItems({ readChats, since, now })` -> `{ items, errors, ok }`. `readChats({ days: daysSince(since), maxChats: 80, maxMessages: 5 })`.
   For each app result: `status !== "ok"` adds `{ source: <app>, message: "<app>: <result.detail || result.status>" }`
   and sets `ok = false`; its chats are ignored. For each chat in an ok app, `newer` = its messages with
   `Date.parse(timestamp) > Date.parse(since)` (any sender, including the user). No newer messages -> no item. Item:
   `{ source: chat.app, at: <newest newer timestamp>, title: chat.title?.trim() || participants.map(p => p.name || p.handle).join(", "),
   ref: chat.id + "@" + new Date(<newest>).toISOString(), thread: chat.id, who: participants as { name: name || "", handle },
   text: newer.map(m => m.text).join(" ") }`. Older chats past the 80 limit are not seen; accepted.
5. `calendarItems({ listEvents, snapshot, now })` -> `{ items, snapshot }`. `listEvents({ from: new Date(now - DAY_MS), days: 46 })`.
   In this order: drop events with `writable === false` and (no `attendees` or an empty array) (undefined `writable`
   counts as writable); drop later duplicates with the same `title` and `start`; key each event `id + "@" + new Date(start).toISOString()`.
   A change is a key not in `snapshot.events`, or one whose title differs. Item: `{ source: "calendar", at: start,
   title, ref: key, thread: id, recipients: attendees.length, who: attendees.map((a, i) => ({ name: attendeeNames?.[i] || "", address: a.toLowerCase() })) }`.
   Returned snapshot: `{ at: nowISO, events: { [key]: title } }` for every kept event (deleted events simply drop out;
   they make no item). No snapshot (first run): every kept event is a change.
6. `callItems({ home, since })` -> `{ items, errors }`. Read `<home>/calls` (missing folder -> no items, no error; any
   other read error throws). For each entry named `/^\d{4}-\d{2}-\d{2}-\d{4}-/` that holds event.json: parse it
   (malformed -> `{ source: "call", message: "<folder>: <error>" }` and skip). The call's time is `event.start`, else
   the folder's `YYYY-MM-DD-HHMM` as local time (`new Date(y, m - 1, d, hh, mm)`). Keep it when that time or
   `event.filed?.at` is after `since`. `filedTo = event.filed?.workstream || (event.workstream && event.workstream !== "none" ? event.workstream : null)`.
   Item: `{ source: "call", at: <call time ISO>, title: event.title || folder, ref: folder + "@" + (filedTo || "none"),
   thread: folder, filed: filedTo, who: (event.emails || []).map((a, i) => ({ name: (event.names || "").split(", ")[i] || "", address: a })) }`.
   (A re-filing is a new ref, so it reaches the log.)
7. `checkChanges({ home, workstreams, ownAddresses = [], gmail = null, readInbox = null, readChats = null, listEvents = null, now = Date.now() })`
   -> `{ items, counts, errors, ms }`.
   - `ms` is wall-clock duration (`Date.now()` at end minus at start); `now` is only the logical time.
   - Read `looked.json`. Build the router context BEFORE appending: `learned = await learnPeople({ home, workstreams, ownAddresses })`,
     `threads = threadMap(await readChanges(home), await learnThreads({ home, workstreams, ownAddresses }))`.
   - Run the five sources concurrently with `Promise.allSettled`. A null reader: that source is skipped (`skipped: true`
     in its counts, no error). A rejected source: one error `{ source, message: error.message }`, no items, no
     watermark. (Chats report as sources `messages` and `whatsapp`.)
   - Gmail items are already routed (or unsure by rule 2) and do not go through `route()`. Every other item goes
     through `route(item, { workstreams, learned, threads })` (synchronous; returns `{ workstream, how, candidates }`)
     and becomes `makeItem({ ...item, ...result })`. `makeItem` ignores extra fields such as `text`, `recipients`,
     `filed`. An item whose `route` or `makeItem` throws is dropped; each such source adds one error
     `"<n> invalid items: <first message>"`.
   - Keep only items with a workstream or at least one candidate. Items with neither are dropped on purpose (noise and
     privacy) and their source's watermark still advances.
   - `appendChanges(home, kept)` first; then `writeLooked` for each successful source: `gmail` merged object (only
     when at least one workstream succeeded), `outlook`, `messages` (only when no chat app errored), `calendar`
     snapshot, `call` (only when no call folder was malformed, so a half-written event.json is read again).
     Invalid items do not hold a watermark back. A whole chat-reader failure reports as source `messages`. If `appendChanges` or
     `writeLooked` throws, `checkChanges` throws.
   - `counts`: always every key `gmail, outlook, messages, whatsapp, calendar, call`, each
     `{ seen, routed, unsure, kept, skipped }`: `seen` = raw items the source produced, `routed` = items with a
     workstream after routing, `unsure` = no workstream but at least one candidate, `kept` = items actually appended
     (after the log's dedupe), `skipped` = reader was null (or outlook had no address).
   - `items` = what `appendChanges` returned, in source order gmail, outlook, messages, whatsapp, calendar, call.
8. In `src/hikyaku/calls.js`, in `fileCall`, change
   `const name = chosen || event.workstream || '';` to
   `const name = chosen || event.filed?.workstream || (event.workstream !== 'none' ? event.workstream : '') || '';`
   so filing and the morning ranking (gather.js:73) agree. Add to `test/hikyaku-calls.test.js`: an event.json with
   `workstream: "A"` and `filed: { workstream: "B" }` files under B.

Tests: `test/hikyaku-sources.test.js`, temp folders and fake readers only. Testing the call source's failure: make
`<home>/calls` a file (readdir throws ENOTDIR) for the whole-source failure; a malformed event.json for the per-folder
error. Message text check: give a fake chat a message text "SECRET-BODY-123" and a fake Outlook body
"SECRET-BODY-456", then assert `changes.jsonl` contains neither string and no line has a `text` key.

### Product Requirements (increment 5, DONE: reference only): timer, daily cloud limit, headers-only Gmail check

Built since increment 3 (read these before writing code): `src/hikyaku/refresh.js` (unseenFor, changedWorkstreams,
contextLines, milestonesFrom, nextState, routedChats); `desktop/main.js` functions `catchUpOn(name, { refresh })`
(returns a log; `log.needsYes === true` when no model may read it; `log.unchanged === true` when nothing new),
`refreshChanged()` and `runRefresh()`, the IPC `hikyaku:refresh`, the launch hook `HIKYAKU_REFRESH_ON_START`.
`usageToday(home)` in `src/hikyaku/usage.js` returns `{ day, calls, in, out, usd, byPath }` for the Mac's calendar day.
Settings are read with `readSettings(home)` and unknown keys pass through.

1. **Headers-only Gmail check.** Add to `src/integrations/gmail/client.js` a method
   `getThreadHeaders(threadId)` that GETs `/threads/<id>?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`
   (same id validation as `getThread`) and returns `parseGmailThread(<response>)`. In `src/hikyaku/sources.js`
   `gmailItems`, call `gmail.getThreadHeaders` when the client has it, else `gmail.getThread`. Nothing else changes.
   (Live run 1 took 10.5 s, almost all of it 45 full-thread fetches.)
2. **The plan, pure, in `src/hikyaku/refresh.js`:** export
   `refreshPlan({ changed, state, workstreams, today, auto, overBudget })` -> `[{ name, items, action: "read" | "skip", reason }]`
   where `changed` is `changedWorkstreams(...)`'s output, in that order. Rules, first match wins:
   - `auto && state[name]?.autoDay === today` -> skip, reason `"already refreshed today"`.
   - `auto && workstream.goal === "Just keep me posted"` -> skip, reason `"just keep me posted"`.
   - `overBudget && workstream.cloud === "nebius"` -> skip, reason `"over today's cloud limit"`.
   - otherwise read, reason `""`.
   (`workstream` = the entry of `workstreams` with that name. `today` is `"YYYY-MM-DD"`, the Mac's local day.)
3. **Budget:** `limitUsd = Number(settings.cloudDailyLimitUsd) > 0 ? Number(settings.cloudDailyLimitUsd) : 3`.
   `overBudget = (await usageToday(home)).usd >= limitUsd`, computed once per run, after the change check.
4. **`refreshChanged({ auto = false, overBudget = false } = {})`** in desktop/main.js uses `refreshPlan`: skipped
   entries are returned as `{ name, items, ok: false, skipped: reason }` without calling catchUpOn; read entries call
   `catchUpOn(name, { refresh: true })` as today. After a read with `ok: true` and `auto`, write
   `autoDay: today` into that workstream's catchup-state entry (read the file again, set the one key, write it back).
5. **`runRefresh({ auto = false } = {})`**: as today, plus `overBudget` from rule 3 passed to `refreshChanged`, and the
   runs.jsonl line gains `auto`, `usdToday` (number, after the run, from usageToday) and `limitUsd`.
6. **Timer `startRefreshing()`** in desktop/main.js, started next to `startDiscovery()` in the app's ready path unless
   `process.env.HIKYAKU_REFRESH === "0"`: first tick 120 s after launch, then every 10 minutes
   (`setInterval(tick, 10 * 60 * 1000)`, `.unref?.()` on both, like startDiscovery). A tick runs
   `runRefresh({ auto: true })`, never two at once (a module-level `refreshing` flag; a tick while one runs does
   nothing), and logs failures with `console.error("hikyaku refresh failed: " + error.message)`. The IPC
   `hikyaku:refresh` and the launch hook call `runRefresh({ auto: false })` (user-asked: no once-a-day rule; the
   budget rule still applies).

Tests: `test/hikyaku-refresh-schedule.test.js`: every `refreshPlan` rule and their order (an auto run on a
quiet workstream that already ran today reports "already refreshed today"); a manual run ignores autoDay and quiet;
over budget skips only cloud workstreams. In `test/gmail-client.test.js`: `getThreadHeaders` requests
`format=metadata` with the five headers and returns the parsed subject. In `test/hikyaku-sources.test.js`: gmailItems
prefers `getThreadHeaders` when present and falls back to `getThread`. desktop/main.js has no unit tests: verify it
with `node --check desktop/main.js`.

### Product Requirements (increment 6, DONE: reference only): your taps, park, taps-first order

The user decided at TC2 that taps-first ordering goes live now. Read first: `src/hikyaku/priorities.js` (rankInput,
pickPrompt, pickable, rankByDate, idleLast, listOrder, recordFirstAct), `src/hikyaku/workstreams.js`
(workstreamFields, STAKES, saveWorkstreamFields), `src/hikyaku/changes.js` (appendChanges), `src/hikyaku/refresh.js`,
and in `desktop/main.js` `runRefresh` and the `handleSecure('hikyaku:refresh', ...)` line; `desktop/preload.cjs`.

`today` is always the Mac's local day `"YYYY-MM-DD"` (priorities.js `localDay`). A workstream is **parked** when
`parkedUntil` exists and `parkedUntil > today`. `STAKE_ORDER = { more: 0, normal: 1, less: 2 }`; an absent stake is
`"normal"`.

1. **rankInput** adds to each stream `stake: workstream.stake || "normal"` and
   `parked: Boolean(workstream.parkedUntil && workstream.parkedUntil > localDay(now))`, and
   `parkedUntil: workstream.parkedUntil || null`. Nothing else in rankInput changes.
2. **Order.** Export `rankByStake(streams, today)` = `rankByDate(streams, today)` re-sorted stably by
   `STAKE_ORDER[s.stake ?? "normal"]` (so within one stake the date order is kept exactly). `listOrder` uses
   `rankByStake` instead of `rankByDate`, and puts groups in this order: not idle and not parked; then parked (sorted
   by `parkedUntil` ascending); then idle. Ranks are counted 1..n over the whole list as today. Each `ranked` row gains
   `stake` and, when parked, `parked: true, parkedUntil`. With no stakes and nothing parked, the result is identical
   to today's (the existing tests in `test/hikyaku-priorities.test.js` must pass unchanged).
3. **Picks.** `pickable` also excludes parked streams. In `pickPrompt`'s `block`, add the line
   `stake: the user marked this "matters more"` when `s.stake === "more"`, and
   `stake: the user marked this "matters less"` when `s.stake === "less"` (no line for normal), placed right after the
   goal line. In the task text, replace the sentence that starts "Weigh, in this order:" with exactly:
   `Weigh, in this order: the user's own stake (a workstream marked "matters more" comes before others unless another move is due today and someone is waiting on it; one marked "matters less" comes last), how much the user's goal is at stake, how soon the move is due, and whether someone is waiting on the user.`
   Keep the following sentence "A workstream the user keeps finishing moves in is one they care about." unchanged.
4. **First-act rows.** `recordFirstAct` adds `order: "taps"` to every row it writes (rows written before this
   increment have no field, which means date order).
5. **Park return.** New file `src/hikyaku/park.js` exporting
   `returnParked({ home, workstreams, today })` -> `[name]`: for each workstream with `parkedUntil <= today`, append one
   change item `{ source: "park", at: new Date(parkedUntil + "T09:00:00").toISOString(), title: "Back from park (" + parkedUntil + ")", ref: name + "@" + parkedUntil, thread: name, who: [], workstream: name, how: "asked" }`
   with `appendChanges`, then `saveWorkstreamFields(home, name, { parkedUntil: null })`. Returns the names returned.
   Running it twice the same day adds nothing (the ref repeats and the date is already cleared).
6. **Wiring in desktop/main.js.** `runRefresh` calls `returnParked({ home, workstreams: await readWorkstreams(home), today })`
   first, before the change check, and adds `returned: [names]` to its runs.jsonl line. Two IPC handlers next to
   `hikyaku:refresh`:
   - `hikyaku:set-stake` `(name, stake)`: `name` a string of 1-200 characters, `stake` one of `"more"`, `"less"`, `null`
     (null = normal); calls `saveWorkstreamFields(hikyakuDirectory(), name, { stake })`, then `rankSoon()`, and returns
     the saved workstream. Anything else throws `Error("That stake is not valid.")`.
   - `hikyaku:park` `(name, until)`: `until` a `"YYYY-MM-DD"` string after today, or `null` to unpark; calls
     `saveWorkstreamFields(hikyakuDirectory(), name, { parkedUntil: until })`, then `rankSoon()`, and returns the saved
     workstream. A date that is not after today throws `Error("Pick a day after today.")`.
   In `desktop/preload.cjs`, next to `refresh`: `setStake: (name, stake) => ipcRenderer.invoke('hikyaku:set-stake', name, stake),`
   and `park: (name, until) => ipcRenderer.invoke('hikyaku:park', name, until),`.

Tests: `test/hikyaku-stakes.test.js`: rankInput carries stake/parked; a "more" workstream due later outranks a
"normal" one due sooner; "less" goes after normal; parked rows come after the active ones and before idle ones,
sorted by date; with no stakes and no parks `listOrder` equals the old result for the same input; pickPrompt shows the
stake lines and the new Weigh sentence and leaves parked streams out; recordFirstAct writes `order: "taps"`;
returnParked appends once, clears the date, and adds nothing on a second run.
Verification: `node --test test/hikyaku-stakes.test.js test/hikyaku-priorities.test.js && node --check desktop/main.js && npm test`

### Product Requirements (screen increment 1): backend for the screen

Read first: `src/hikyaku/changes.js` (makeItem, appendChanges, readChanges), `src/hikyaku/refresh.js` (unseenFor),
`src/hikyaku/workstreams.js` (saveWorkstreamFields, workstreamFields), `src/hikyaku/usage.js` (USAGE_FILE), and in
`desktop/main.js` the `hikyaku:workstreams` handler, `catchUpOn`, and the `hikyaku:refresh` handler; `desktop/preload.cjs`.

1. New file `src/hikyaku/screen-data.js`, pure except where it says it writes:
   - `newsFor(items, state, name, limit = 5)` -> `[{ id, source, title, at }]`: `unseenFor(items, state, name)` newest
     first by `at`, at most `limit`.
   - `estimateUsd(usageRows, workstream)` -> number: `0` when `workstream.cloud !== "nebius"`; otherwise the mean `usd`
     of the last 10 rows with `path === "mail"` and a numeric `usd`, rounded to 4 decimals; `null` when there are none.
   - `windowEnd(card)` -> `"YYYY-MM-DD" | null`: the latest of `card.milestones[].at` (date part) and
     `card.priority?.due`, or null when neither exists.
   - `readAnswered(home)` -> `Set` of item ids from `<home>/asked.jsonl` (missing file -> empty set; a bad line is skipped).
   - `asksFor(items, answered, name, limit = 3)` -> `[{ id, source, title, at, who }]`: items with `workstream === null`
     whose `candidates` include `name` and whose id is not in `answered`, newest first, at most `limit`.
   - `answerAsk({ home, item, workstream })` (writes): appends `{ at, id: item.id, answer: workstream }` to
     `<home>/asked.jsonl` (answer null = No). When `workstream` is a name: (a) the people to save are, for a chat item
     (`messages` or `whatsapp`) with exactly one `who`, that one `{ name, handle }`; for any other item, the first `who`
     entry that has an address, as `{ name, address }`; none otherwise; they are merged into the workstream's `people`
     with `saveWorkstreamFields` (no duplicates by address or handle); (b) a routed copy is logged with
     `appendChanges(home, [{ ...item, ref: item.ref + "#asked", workstream, how: "asked", candidates: [] }])` so the
     thread continues there. Returns `{ saved: <number of people added>, logged: <0 or 1> }`.
2. In `hikyaku:workstreams`, each card gains `news`, `estimateUsd`, `windowEnd`, `asks` (computed with the functions
   above from the change log, catchup-state, nebius-usage.jsonl rows and asked.jsonl, read once per call).
3. IPC handlers next to `hikyaku:refresh`, each with input checks like the existing ones:
   - `hikyaku:refresh-one` `(name)` -> `catchUpOn(name, { refresh: true })`.
   - `hikyaku:screen-settings` `()` -> `{ showCosts: Boolean(settings.showCosts), limitUsd, usdToday }` (limit rule as
     in runRefresh, usdToday from usageToday).
   - `hikyaku:set-show-costs` `(on: boolean)` -> writes `showCosts` into settings.json (read the raw file, set the one
     key, write it back), returns the screen settings.
   - `hikyaku:ui-act` `({ act, name? })` -> appends `{ at, act, name: name || null }` to `<home>/ui-acts.jsonl`; `act`
     must be one of `sweep-start, sweep-step, sweep-done, peek, focus, tap, park, ask, fold-open, refresh, costs-on,
     costs-off, clash-open`, else throws `Error("Unknown screen action.")`.
   - `hikyaku:answer-ask` `(id, workstream | null)` -> finds the item by id in the change log, calls `answerAsk`,
     then `rankSoon()`; an unknown id throws `Error("That question is no longer open.")`.
   Preload, next to `refresh`: `refreshOne`, `screenSettings`, `setShowCosts`, `uiAct`, `answerAsk`.
Tests: `test/hikyaku-screen-data.test.js` for every function in item 1 (temp folders), including: a No is never asked
again, a Yes on a 1:1 WhatsApp item saves the handle and logs one routed copy, a Yes on an email saves the sender's
address, saving twice adds no duplicate person. desktop/main.js: `node --check`.
Verification: `node --test test/hikyaku-screen-data.test.js && node --check desktop/main.js && npm test`

Rules that settle the open questions (screen increment 1):
- Inputs: `items` is every ChangeItem from `readChanges(home)` (file order, oldest first; missing file -> `[]`; its
  `workstream` filter matches only the routed `workstream`, never candidates, so pass all items). `state` is the whole
  parsed `<home>/catchup-state.json` object. `unseenFor(items, state, name)` returns that workstream's routed items
  whose id is not in `state[name].seen`, in log order. Sort ties keep the later log line first. `limit` is used as
  `Math.max(0, Math.floor(limit))`.
- "Date part" everywhere in this build (here and in runway-model.js) = the first 10 characters of the ISO string.
- Usage rows: add `readUsageRows(home)` to screen-data.js: parsed lines of `<home>/nebius-usage.jsonl` in file order,
  bad lines skipped, missing file -> `[]`. `estimateUsd`: cloud check first (`workstream.cloud !== "nebius"` -> `0`,
  including undefined); then rows with `path === "mail"` and `typeof usd === "number" && Number.isFinite(usd)`; the
  last 10 of those; mean; `Math.round(mean * 1e4) / 1e4` (a number); none -> `null`.
- `windowEnd`: milestones with an unparseable `at`, and a missing `milestones` array, are ignored; past dates count.
- `readAnswered`: a line that is not JSON or has no string `id` is skipped; `answer: null` still counts as answered;
  a read error other than ENOENT throws.
- `asksFor`: `who` is copied as stored; an unknown `name` gives `[]`.
- `answerAsk({ home, item, workstream, now = new Date() })`: `at = now.toISOString()`. `workstream` must be a named
  workstream from `readWorkstreams(home)`, else throw `Error("No workstream named \"<name>\".")`; it need not be in
  `item.candidates`. People rule: a chat item (`messages`/`whatsapp`) with exactly one `who` that has a `handle` ->
  `{ name, handle }`; any other chat item -> none (no fall-through); a non-chat item -> the first `who` with an
  `address`, as `{ name, address: address.toLowerCase() }`. Merge into the workstream's current `people` (from
  `readWorkstreams`) and save the whole merged list with `saveWorkstreamFields(home, name, { people })` (it replaces
  the list). Duplicate = same lowercased address, or same handle digits (`handle.replace(/\D/g, "")`, or the lowercased
  handle when it has no digits). `makeItem` recomputes `id` from `source` and `ref`, so the `#asked` copy has a new id.
  Write order: validate, save people, append the copy, then append the asked.jsonl line last (a failure before it
  leaves the question open). Errors propagate. `saved` = people actually added (0 or 1); `logged` = 1 when
  appendChanges wrote the copy, else 0 (No answers, or a copy already logged).
- Cards: every card (including inbox, chats and folder cards) gets the four fields, computed after the existing
  fields, from one read each of the change log, catchup-state, usage rows and asked.jsonl. A missing file -> empty;
  any other read error -> empty plus `console.error("hikyaku screen data: " + error.message)`.
- IPC: all five use `handleSecure`. A workstream name argument must be a string of 1-200 characters, else
  `Error("Workstream name is invalid.")`. `refresh-one` calls `catchUpOn(name, { refresh: true })` directly (no budget
  rule, no autoDay, no runs.jsonl line) and returns its result. `screen-settings` returns `usdToday` unrounded.
  `set-show-costs`: a non-boolean throws `Error("Show costs must be on or off.")`; the file is
  `join(hikyakuDirectory(), "settings.json")`; missing -> start from `{}`; not JSON -> `Error("settings.json could not be read.")`;
  returns the screen settings. `ui-act`: the payload must be an object; `name` optional, a string of at most 200;
  `at` ISO; returns `{ ok: true }`. `answer-ask`: `id` a string of 1-400, `workstream` null or a name; an id not in
  the log, or whose item is routed (not unsure), or already in asked.jsonl -> `Error("That question is no longer open.")`;
  if the id appears twice the last line wins; returns `answerAsk`'s result; `rankSoon()` only after success.
- Preload lines, exactly: `refreshOne: (name) => ipcRenderer.invoke('hikyaku:refresh-one', name),`
  `screenSettings: () => ipcRenderer.invoke('hikyaku:screen-settings'),` `setShowCosts: (on) => ipcRenderer.invoke('hikyaku:set-show-costs', on),`
  `uiAct: (act) => ipcRenderer.invoke('hikyaku:ui-act', act),` `answerAsk: (id, workstream) => ipcRenderer.invoke('hikyaku:answer-ask', id, workstream),`
- Checks for this increment: one test per rule above for screen-data.js, plus failure paths: readAnswered skips a bad
  line, answerAsk with an unknown workstream throws and writes nothing, estimateUsd with no mail rows returns null.
  The handlers are verified by `node --check` only. Commit message: `hikyaku: <what> (workstreams-screen inc 1)`.

### Product Requirements (screen increment 2): runway math, pure

> Retired: the date runway was removed in c74abd3 (the S2 Workspaces redesign). `desktop/renderer/runway-model.js` and
> `test/workstreams-runway-model.test.js` no longer exist; this section and the plan rows that name them are history.

New file `desktop/renderer/runway-model.js` (ES module, no DOM, no imports from desktop/main.js or src/), used by the
renderer and by node tests. A card is what `hikyaku:workstreams` returns: `{ name, priority: { rank, due, idle, parked?, parkedUntil? } | null, stake?, quiet, current, unread, milestones: [{ at, title, source }], windowEnd, ... }`
(`stake` may be read from `card.stake` or `card.priority.stake`; absent means "normal").

1. `DAYS = 32`. `dayIndex(isoDate, today)` -> whole days from `today` ("YYYY-MM-DD") to the date part of `isoDate`,
   using UTC noon of each date so time zones never shift a day.
2. `scaleFor({ today, width, days = DAYS })` -> `{ x(isoDate) -> px, ticks: [{ date, label, x }] }`: `x = clamp(dayIndex, 0, days) / days * width`;
   ticks every 7 days from today (labels "today", then "Oct 17" style from `toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })`).
3. `rowsFor(cards, today, days = DAYS)` -> `{ dated: Row[], undated: Row[] }`, order kept from `cards`. A card goes to
   `undated` when it has no `windowEnd`, or `quiet`, or `priority.parked`; else `dated` with
   `Row = { name, rank, stake, shade, start: today, end, clipped, marks: [{ day, title }], changed, parked, quiet }`:
   `end = windowEnd`, `clipped = dayIndex(end) > days` (end then drawn at the edge), `marks` = milestones within the
   window plus `priority.due` (title "due"), as day indexes, deduped by day+title; `shade` = `"s1"` for stake more,
   `"s2"` normal, `"s3"` less; `changed = unread > 0 && !current`. Undated rows carry `name, rank, changed, quiet, parked, parkedUntil`.
4. `clashesFor(dated, span = 3)` -> `[{ from, to, names }]`: every maximal run of days where marks from two or more
   different workstreams fall within `span` days of each other; `from`/`to` are day indexes, `names` sorted unique.
   Merge overlapping runs. No marks -> `[]`.
5. `sweepOrder(cards)` -> names with `unread > 0` and not parked, in card order.
6. `defaultFocus(cards)` -> the first name in `sweepOrder`, else the first card's name, else null.
Tests: `test/workstreams-runway-model.test.js` covering each item, including a clipped bar, a stake shade, a quiet
card going to undated, two workstreams with dates 2 days apart forming one clash, three days apart with span 3
forming one clash, and five days apart forming none.
Verification: `node --test test/workstreams-runway-model.test.js && npm test`

Rules that settle the open questions (screen increment 2):
- Exports are named: `DAYS, dayIndex, scaleFor, rowsFor, clashesFor, sweepOrder, defaultFocus`. Inputs are never
  mutated; outputs are plain objects. `cards` null or undefined is treated as `[]`.
- Card fields: `quiet` and `current` are read as booleans (`Boolean(...)`); `unread` as a number (`Number(...) || 0`);
  missing `milestones` -> `[]`; `priority: null` -> rank `null`, not parked, no due; `windowEnd` null, absent or ""
  -> undated; `priority.idle` is ignored. Stake = `card.stake ?? card.priority?.stake ?? "normal"`; any other value
  is treated as "normal".
- `dayIndex(isoDate, today)`: both take their first 10 characters, each becomes `Date.UTC(y, m - 1, d, 12)`, and the
  result is `Math.round(diff / 86400000)` (negative for the past). An unparseable date throws `Error("Not a date: <value>")`.
- `scaleFor`: `days` must be > 0 and `width` >= 0, else throw `Error("Bad runway scale.")`; `x` is not rounded. Ticks
  at days 0, 7, 14, 21, 28 (every 7 while `<= days`); `date` is `"YYYY-MM-DD"`; tick `x` = `x(date)`; the label of day
  0 is `"today"`, others format UTC noon of the tick date with `timeZone: "UTC"`.
- `rowsFor`: a `windowEnd` before today (dayIndex < 0) -> undated; equal to today -> dated. Dated rows:
  `start = today`, `end = windowEnd.slice(0, 10)` (the real date, even when clipped), `endDay = Math.min(dayIndex(end), days)`,
  `clipped = dayIndex(end) > days`. Marks: milestones and `priority.due` whose day is within `0 <= day <= days`,
  `{ day, title }` (missing title -> ""), sorted by day then title, deduped by day+title keeping the first. Dated rows
  carry `parked: false, quiet: false`. Undated rows: `{ name, rank, changed, quiet, parked, parkedUntil }` with
  `parked = Boolean(priority?.parked)` and `parkedUntil = priority?.parkedUntil ?? null`. Duplicate names are kept.
- `clashesFor(dated, span = 3)`: take every mark of every dated row as `{ day, name }`; sort by day (ties by name);
  walk them, starting a new cluster whenever `mark.day - previousMark.day > span`; a cluster is a clash when it holds
  two or more distinct names. `from` = its first mark's day, `to` = its last mark's day, `names` = distinct names sorted
  with `localeCompare`. Output sorted by `from`. Chaining is intended: marks on days 1, 3, 5 from three workstreams
  make one clash 1-5. A cluster with one workstream's marks only is not a clash.
- `sweepOrder`: `Number(unread) > 0` and not `priority?.parked`; quiet cards are included. `defaultFocus`: as written;
  a parked first card is fine.
- Checks: one test per item 1-6 and the listed cases, with `today = "2026-10-10"`. Expected clashes follow the rule
  above (2 apart -> one clash from the first day to the second; 3 apart with span 3 -> one; 5 apart -> none). No
  failure-path-per-source or invariant checks apply to this pure module. Commit message:
  `hikyaku: <what> (workstreams-screen inc 2)`.

---

## CONSTRAINTS

### In Scope
Only the increment named in your brief. Screen increment 1: new `src/hikyaku/screen-data.js`, `desktop/main.js` (card
fields, five IPC handlers), `desktop/preload.cjs` (five lines), `test/hikyaku-screen-data.test.js`. Screen increment 2:
new `desktop/renderer/runway-model.js` and `test/workstreams-runway-model.test.js` only. The two run in parallel and
touch no common file.

### Out of Scope
Any screen or renderer change (desktop/renderer/*) except the new `desktop/renderer/runway-model.js` in screen increment 2; calling any model from new code; sending anything; class
sites, Slack, Teams messages, LinkedIn; Gmail History API; Contacts lookup; changes to router.js or changes.js.

### Tech Stack
Node 20+ ES modules, `node:test`, `node:assert/strict`. No new dependencies.

### Architecture
```
readers (injected) -> sources.js (*Items: raw items + new watermark) -> router.js (route) -> changes.js (appendChanges, writeLooked)
```
Readers are always passed in as arguments so tests inject fakes; sources.js never imports the Electron app.

---

## INCREMENT PLAN

Current build, loggie-workstreams-screen:
1. Backend for the screen (news, estimateUsd, windowEnd, asks; five IPC). Colossal.
   Verification: `node --test test/hikyaku-screen-data.test.js && node --check desktop/main.js && npm test`
2. Runway math, pure (desktop/renderer/runway-model.js). Colossal, in parallel with 1.
   Verification: `node --test test/workstreams-runway-model.test.js && npm test`
3. [CORE] The runway and focus card on screen, peek / click / keys, refresh, the fold. Founding Agent.
4. The sweep: steps, ask-once, more / less, park, All caught up. Founding Agent.
5. Show costs meter and prices; the clash band compare card. Founding Agent.
6. Accessibility floor on the rendered screen, visual audit. Founding Agent.

Previous build, loggie-workstream-integration: increments 1-7 DONE, pushed as 0c074f6.

---

## EVALS

### The standing suite

```bash
npm test     # DETERMINISTIC 5/5 on 2026-10-10 (passk.py). Must stay green.
```

Never delete a check to make a build pass. If a check is wrong, say so and leave it failing.

### Every increment adds to the suite

1. One check per acceptance condition in the increment (SPEC items 2-7 each get at least one test in the new file; item 8's test goes in `test/hikyaku-calls.test.js`).
2. One check per invariant touched: assert that what `checkChanges` appends passes `makeItem` and that no stored line
   contains message text.
3. One failure-path check per source: a reader that throws leaves that source's watermark unchanged and adds an
   error, while the other sources still append.
4. Run the full suite, not just your new checks.

---

## DOCUMENTATION

Your report is the increment's permanent record. If you change a contract, update ARCHITECTURAL INVARIANTS here in
the same diff. If a decision was left open, write it in your report's Decisions field. No changelog, no new docs.
Never mark something verified that you did not run.

---

## EXECUTION PROTOCOL

1. Read ARCHITECTURAL INVARIANTS, then SPEC and CONSTRAINTS.
2. `npm ci` if node_modules is missing, then `npm test`; it must be green before you start.
3. Build the one increment. 4. Run the standing suite and your new checks. 5. Commit in your worktree. 6. Report.

### Autonomous Decision Heuristics

**Do not ask me an engineering question.** Choose the simpler option, note the choice and your reasoning in your
report, and keep going. Ask only if a wrong guess would create product risk you cannot reverse.

1. Simpler implementation. 2. Clarity for the end user. 3. Maintainability over novelty. 4. Explicit over magic.
5. One strong default over options. 6. No speculative architecture. 7. No placeholders, dead code, half-wired features.
Match the surrounding code: short header comment per file saying what it is for and why, few inline comments.

---

## THERMAL MONITORING

Report immediately, do not push through: SPIN (3 failed fixes, same bug), REGRESSION (fix A breaks B), BLEED (long
stretch, no test progress), DRIFT (3+ decisions without checking the signature), CASCADE (old tests now failing),
DEPENDENCY (wanting a library). Recovery: revert to last green, reread SPEC, retry simpler. Never delete or
force-reset work you did not write.

---

## REPORTING

```markdown
## Increment [N]: [Description]
**Status:** COMPLETE | PARTIAL | BLOCKED
**Evals:** each standing command and result; new checks added (what they assert, where)
**Ran it:** what you exercised beyond tests
**What changed:** 2-4 sentences
**Decisions made:** every choice the spec left open, with reasoning
**Spec gaps hit:** anything you had to guess, or "none"
**Docs updated:** files and why, or "none required, because ___"
**Noticed, not fixed:** unrelated bugs and smells
**Tests:** covered / not covered
**Commit:** the worktree branch name and commit hash (message: `hikyaku: <what changed> (workstreams-screen inc <N>)`, with no Co-Authored-By or Claude-Session line)
```

Directives: PROCEED, REROUTE, REWRITE, COOL_AND_RETRY, DEFER, RETURN. Execute without renegotiation.

---

## DEFINITION OF DONE

- [ ] Full standing suite green
- [ ] New checks for each acceptance condition, the invariants touched, and a failure path per source
- [ ] The change matches the function signature in SPEC
- [ ] No TODOs, placeholders or stubs; errors handled, not swallowed
- [ ] Nothing outside this increment's concern changed
- [ ] The diff is reviewable in one sitting (aim under 600 changed lines)

"Decisions made" = choices among options the spec left open. "Spec gaps hit" = places the spec was missing or contradicted itself.

If an item fails and you cannot fix it, file with Status: PARTIAL and say which and why.

## What You Are Not

You do not scope, design the architecture or make taste decisions. If the spec is wrong or thin, say so in the
report rather than guessing well.
