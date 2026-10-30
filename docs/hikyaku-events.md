# hikyaku events: what the entry screens render

Every step of the entry flow writes events, one JSON object per line, to `<hikyaku home>/runs/<run>/events.jsonl`.
The screens draw from these events and nothing else. Events never leave the Mac.

```
call.py / byo.py ─┐                                   ┌─▶ IPC hikyaku:entry ─▶ loggie.hikyaku.onEntry(listener)
                  ├─▶ runs/<run>/events.jsonl ─▶ main.js tail
send gate, entry ─┘        (one seq per run)          └─▶ loggie.hikyaku.entryEvents(runId)  (one run, whole)
```

- Node writes through one emitter, `src/hikyaku/events.js` (`emitEvent`). Python writes through `sendgate.emit`
  (call.py prepares a call, byo.py writes call notes). Both count the lines already in the file, so seq is one numbering.
- `emitEvent` checks each event before it writes it and refuses one that breaks the contract, so nothing half-right lands
  in the file. `checkEvents` runs the same check over a whole file: a real run, or the fixture below.
- Fixture to design against: `demo/entry/fixtures/events-example.jsonl` (made-up text). It holds four runs: a call
  screened, a line kept back, the call notes sent and checked, a next move picked, and a catch-up that failed.
- Tests: `node --test test/hikyaku-entry-events.test.js` and, in the transcriber, `python3 test_events.py`.

## The envelope

| Field | Meaning |
|---|---|
| `v` | contract version, 1 |
| `run` | run id, `YYYYMMDD-HHMMSS-<4 hex>` |
| `seq` | 1, 2, 3 ... per run, no gaps |
| `at` | ISO time it happened |
| `type` | one of the types below |
| `step` | `read`, `screen`, `ask`, `check`, `file`, `move`, `pick`, or null |
| `text` | plain words a person can read, or null. Never names a model, a model maker or a provider |
| `data` | per type, below (fields listed are always there; a few events add more) |

The text rule is a test: no match for
`/nemotron|parakeet|titanet|nvidia|nebius|token factory|claude|super|lightning|model|llm/i`.
An AI is named only in `data`, and only in `ai.options`, `ai.picked`, `ai.connect` (the user is choosing one) and
`outbound.sent` (`provider_id`, for logs, never for display).

Bubble texts, the `text` of `step.started`, are fixed:

| step | text |
|---|---|
| read | "Reading your call" or "Reading your inbox" |
| screen | "Screening on your Mac" |
| ask | "Writing your call notes" or "Writing your next move" |
| check | "Checking every line against the source" |
| file | "Putting it on your card" |

## Events, by screen

Screen numbers are the mock's (loggie-mock-e.html). Direction: every event below is Loggie to screen; the screen's
own actions (Send, Connect, Keep this line, Open draft) are IPC calls that write the event.

| type | fires when | data | written by | screen |
|---|---|---|---|---|
| `run.started` | a run starts: a call screened, a catch-up, a re-prepared send | `source` (call or inbox), `title`, `workstream` | sendgate.py, entry.js, send-gate.js, hold-line.js | 3 |
| `step.started` | each step starts; `text` is the bubble | `step`, `index`, `of` | all | 3 |
| `step.progress` | each screen batch, thread read, workstream read | `step`, `done`, `total`, `unit` (sentences, batches, threads, workstreams) | entry.js, send-gate.js | 3 |
| `step.finished` | each step ends | `step`, `ok`, `seconds` | all | 3 |
| `screen.line` | once per sentence, when one source's screen is done | `source` (call or thread), `source_id`, `i`, `turn`, `time`, `speaker`, `text` (the sentence), `status` (sent or kept), `category`, `layer`, `rule`, `reason` | events.js `emitScreen`, sendgate.py `screen_lines` | 5 |
| `screen.summary` | after the last `screen.line` of a source | `source`, `source_id`, `counts` (held.json counts as is), `outbound_file`, `held_file`, `seconds`, `lines` | same | 5 |
| `ai.options` | "Send to cloud AI" is tapped | `options[]` (`id`, `label`, `connected`, `plan`), `default` | send-gate.js `aiOptions` | 6 |
| `ai.connect` | Connect on a greyed-out AI. Recorded only: connecting from Loggie is not built | `run`, `provider` | send-gate.js `connectRequest` | 6 |
| `line.hold` | "Keep another line on this Mac", then a tapped line. The send is prepared again without it as a new run; nothing is sent | `run` (old), `moved_to` (new), `source_id`, `i`, `category` | hold-line.js | 5 |
| `send.decided` | the user answered "Summarize with cloud AI? Yes / No" for a call. `text` is fixed: "You decided". Exactly one per run, and no provider field. `auto` is there, and true, only when the workstream's remembered yes decided it with no card (L6: a pending call-notes send whose workstream has a connected `cloud` pick; the tail calls `autoDecide` when the screen step finishes ok). A click writes no `auto`, and a click after an auto yes is refused as already decided. `ai.options` fires after it only on the first Yes (no pick remembered, or the remembered AI is not connected); a Yes with a remembered pick goes straight to `ai.picked`. A No sets `send.json` status `declined`, runs nothing and files nothing | `run`, `decision` (yes or no), `picker_shown`; `auto` (true only for the remembered yes) | send-gate.js `decideSend`, `autoDecide` | 5 |
| `ai.picked` | Send is pressed with a connected AI | `run`, `provider`, `remember`, `stream_id` | send-gate.js `approveSend` | 6 |
| `outbound.sent` | right before the request leaves the Mac. The only event that means data crossed | `what` (call-notes or next-move), `attempt` (optional; next-move only, 1 or 2), `source_ids[]`, `sentences_sent`, `sentences_kept`, `chars`, `bytes`, `sha256`, `receipt`, `destination`, `provider_id` | next-move.js, byo.py | 5 |
| `outbound.returned` | the reply arrived, or did not. A next move refused for its content is asked once more: a second pair, `attempt` 2 | `what`, `attempt` (optional, as above), `ok`, `seconds`, `finish_reason`, `tokens` (`prompt`, `completion`, `reasoning`) | next-move.js, byo.py | 5 |
| `check.result` | call notes were checked against the call | `bullets`, `verified`, `not_sure`, `dropped`, `next_steps_kept`, `deadlines_dropped` | byo.py | 4 |
| `move.ready` | a next move passed every check | `move_id`, `stream_id`, `task_id`, `thread_id`, `kind`, `why[]`, `drafts_count`, `slots[]` | next-move.js | 4 |
| `move.failed` | the move failed a check or the cloud step failed; no move is written. A refusal about the move's content, or a read or wait answer, also writes `NOMOVE.json` (`at`, `run`, `reason_code`, `because`) in the task folder; the card then reads "Loggie read this thread: no move yet, because ..." until a later `MOVE.json` replaces it | `step`, `reason`, `fix` | next-move.js | 4 |
| `mail.apps` | the move opens: which mail apps can take this draft | `move_id`, `apps[]` (`id`, `label`, `connected`, `threaded`, `why`), `default` | pick.js | 4 |
| `draft.open` | "Open draft in" is tapped. Loggie opens it; the user sends it | `move_id`, `draft`, `app` | pick.js | 4 |
| `pick.recorded` | a pick was saved (copied n, skipped, handled elsewhere, snooze) | the Signal: `move_id`, `choice`, `at`, `sent_seen`, `edit_ratio` | pick.js | 4 |
| `run.finished` | the run ends; draws the "Your move" card | `ok`, `seconds`, `moves`, `sentences_sent`, `sentences_kept` | all | 3 |
| `run.failed` | anything stopped. Show it with the fix, never go blank | `step`, `reason`, `fix` | all | 3 |
| `workstream.offer` | a call matched no workstream ("New workstream?") | `run`, `source_id`, `new_workstream`, `existing[]` | entry.js | 3 |
| `workstream.started`, `workstream.filed` | Start it, or Put it under one of yours | `run`, `moved_to`, `source_id`, `workstream`, `stream_id`, `created`, `replaced[]` | entry.js | 3 |
| `meeting.offered` | a calendar meeting enters its window (2 minutes before its start, until its end) and nothing is recording. `text` is fixed: "A meeting is starting. Transcribe it?"; the title stays in `data` | `offer_id` (the run), `source` (calendar or mic), `key`, `title`, `start`, `end`, `people`, `names[]`, `emails[]`, `place`, `link_kind` (zoom, teams, meet, marker or null), `reason` (link, teams, people or mic), `expires` (= `end`) | meeting-watch.js | the offer (where it shows is decided in increment 16) |
| `meeting.answered` | the user answered the offer, or its window closed. Only `record` starts a recording, and only through `hikyaku:meeting-answer` | `offer_id`, `answer` (record, dismiss or expired), `call` (the call folder name after `record`, else null) | meeting-watch.js | the offer |
| `meeting.end_asked` | the recording may be over: a meeting app seen during it has let go of the mic for 2 minutes, or a calendar call is 10 minutes past its event end with no meeting app on the mic. Never twice inside 30 minutes, never when nothing records. `text` is fixed: "Done? Write it up." | `call` (the call folder name), `reason` (mic_released or event_ended), `since` (when the mic was released, or the event end), `asked_before` (asks already made for this call) | meeting-watch.js | the end ask |
| `meeting.end_answered` | the user answered the end ask. Only `stop` ends a recording, and only through `hikyaku:meeting-end`; `keep` writes this event and nothing else | `call`, `answer` (stop or keep) | meeting-watch.js | the end ask |
| `meeting.heard` | the live reader is still listening to a recording. At most one every 30 s, written in its own run (`run.started` with source call comes first). `text` is fixed: "Loggie is listening"; nothing from the call, no words, no model | `call` (the call folder name), `heard_s` (seconds of audio on disk, the longer side), `read_s` (seconds read, the longer side), `behind_s` (the most either side is behind), `pieces` (both sides) | transcriber live.py | the end ask card's line: "Heard so far: 52 min. Ready in seconds.", or "Catching up: about N s behind." when behind_s is over 30 |
| `setup.need` | an action needs a Mac permission macOS has refused: recording (microphone, screen), the calendar, Apple Mail's store (Full Disk Access), or an Outlook draft (Accessibility). The action did not run. `text` is the plain why | `permission` (calendar, fullDisk, microphone, screen, accessibility, automation), `why`, `pane` (the System Settings link) | permissions.js | the setup card: Open Settings, Not now |
| `setup.answered` | the user pressed Open Settings (`open`) or Not now (`later`) on a setup card | `permission`, `answer` | main.js (`hikyaku:setup-answer`) | the setup card |
| `setup.cloud_yes` | sorting new mail, finding workstreams or learning the style (`ai`), or reading chats (`chats`), would run in the cloud with no yes yet | `group` (ai or chats) | main.js | the cloud yes card, with the health sentence |
| `setup.download` | the speech engine and its two speech files are downloading in the background (first launch, resumable): sent at the start, about every 4 MB, and at the end. `text` is "Getting meeting transcription ready" | `done_bytes`, `total_bytes` (all files together), `state` (downloading, paused, ready) | speech-download.js | one card, drawn again on each event, gone at ready; a meeting offer made before ready says "Transcription is still downloading" |
| `setup.cloud_answered` | the user answered the cloud yes card. Yes writes `settings.cloudYes` (ai) or the Chats approval (chats); Not now writes nothing | `group`, `answer` (yes or later) | main.js (`hikyaku:cloud-yes-answer`) | the cloud yes card |

### Why a line was kept

`screen.line` has a `reason` only when it is kept. A sent line has `category`, `layer`, `rule` and `reason` all null.

| category | reason |
|---|---|
| health | "a health detail" |
| money | "personal money" |
| identity | "an ID number" |
| grades | "grades or scores" |
| third-party | "someone else's private matter" |
| confidential | "asked to keep it quiet" |
| injection | "text that tried to steer the screen" |
| unchecked | "the check could not finish, so it stayed" |
| unsure | "the check was unsure, so it stayed" |
| (layer `user`, from line.hold) | "you chose to keep it" |

The lines come from the screen record's `lines[]` (privacy.py). An older record without `lines[]` gives its kept
sentences only. Footers and quoted replies cut from a thread are not sentences: they are counted in
`screen.summary` `counts.removed`, not shown as lines.

### Renderer API (preload)

| call | what it does |
|---|---|
| `onEntry(listener)` | every new event as it is written, any run; returns an unsubscribe function. Old runs are not replayed |
| `entryEvents(runId)` | all events of one run, in order, for drawing a run from its file |
| `aiConnect(run, provider)` | writes `ai.connect` |
| `holdLine(run, sourceId, i, category)` | writes `line.hold` and returns the new run to show; `category` is optional |
| `decide(run, decision)` | writes `send.decided`. `no` declines; `yes` sends with the remembered AI, or returns `{picker: true, options, default}` the first time |
| `sendOptions(run)`, `send(run, provider, remember)` | write `ai.options`, `ai.picked` and what follows |
| `mailApps(taskId)`, `openMoveDraft(taskId, n, app)`, `pick(taskId, choice)` | write `mail.apps`, `draft.open`, `pick.recorded` |
| `meetingAnswer(offerId, answer)` | writes `meeting.answered`. `record` runs `call.py start` with the full event, waits for it, and returns the call folder name; `dismiss` only records the answer. The one way a recording starts from Loggie |
| `meetingEnd(call, answer)` | writes `meeting.end_answered`. `stop` runs `call.py stop` detached (it transcribes for minutes; its output goes to `stop.log` in the call folder) and returns at once; `keep` only records the answer. The one way a recording ends from Loggie |

## Not built yet

Proposed in the mock for screens 0 to 2, not in the contract, so the emitter refuses them until they are agreed:
`goals.drafted`, `goal.verdict`, `goal.added`, `onboarding.done`, `mail.read`, `streams.updated`, `stream.open`,
`ask.sent`, `cards.sorted`, `card.moved`. Also proposed on screen 4: `draft.viewed`.
The proposed `call.record` became `meeting.offered` and `meeting.answered` above.

Known gaps in what is built:
- Call notes: `outbound.sent` is written by byo.py just before the prompt leaves; its `sha256`, `chars` and `bytes`
  are of the prompt text, not of the whole HTTPS body. Next moves hash the exact body.
- Next moves have no `check.result`: their check is `move.ready` or `move.failed`. No step emits the "check" bubble yet.
- `ai.connect` records the tap only. The option stays greyed until the AI is connected by hand.
- A `reason` in `move.failed` or `run.failed` is plain words but is not held to the text rule: an error from a lower
  layer can still name what failed.
