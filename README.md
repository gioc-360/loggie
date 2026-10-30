# Loggie

Loggie is a desktop assistant for macOS. It reads your email, chats, calendar and calls, keeps each piece of work as a workspace, takes notes on your meetings, and turns one typed sentence into a draft in the right app. Loggie never sends anything: every reply, message and invite opens in its own app, unsent, and you press Send. Press `⌘⇧L` to summon the assistant while Loggie runs in the background. Terminal utilities remain available as legacy tools.

Built by Jess Lu, Gio Caballero and Amritha P for the Nebius x NVIDIA Global AI Hackathon (Personal AI track). This is the public copy of the team's private working repo, with the private design docs left out and real contacts in tests replaced by made-up ones.

## How Loggie uses NVIDIA models on Nebius Token Factory

Every cloud step in Loggie is an NVIDIA Nemotron model on Nebius Token Factory, and the listening happens on the Mac
with NVIDIA's open speech models. Nothing goes to the cloud until you say yes, and only screened text goes.

| Job | Model | Where it runs |
|---|---|---|
| Live words while a call records | `nvidia/nemotron-3.5-asr-streaming-0.6b` (NeMo-Speech.cpp) | on the Mac |
| The call's transcript after Stop | `nvidia/parakeet-tdt-0.6b-v3` | on the Mac |
| Sorting each new email, text and chat into its workspace, drafting replies, the next move | `nvidia/nemotron-3-super-120b-a12b` | Nebius Token Factory |
| Call notes with a quote and minute behind every point, and the name check | `nvidia/Nemotron-3-Ultra-550b-a55b` | Nebius Token Factory |
| Checking a company or product name on the web | Tavily search | Tavily (Nebius) |

Token Factory's OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`, `src/hikyaku/nebius.js`) let
one transport serve both models: Super for the fast, everyday calls and Ultra where the notes need reasoning, chosen
per job (the comment at `src/hikyaku/nebius.js:15` records the measurement behind using Ultra for the name check).
Each call's cost is counted from Token Factory's published prices (`src/hikyaku/usage.js`), and the cloud re-reads stop
for the day at a limit you set.

## For judges: testing Loggie

Loggie is a macOS app for Apple silicon Macs. Install it from the test build linked on the Devpost
submission, or run it from source with [Teammates: first run](#teammates-first-run). The setup page asks for a Nebius
Token Factory key and a Tavily key; the submission's testing instructions include keys for judges. Loggie never sends
anything: every draft and invite opens unsent in its own app.

## What's in this version

| Part | What it does |
|---|---|
| Ask box | One sentence in any word order, such as `text lena running late` or `reply to Ana about the offer`, becomes a draft in the right Outlook thread, Messages chat or WhatsApp chat, an Outlook or Google invite, a moved meeting, or an opened file. Each word is underlined with the role Loggie read it as while you type. Two people with the same name is a question, never a guess. A question about your calendar or meetings is answered by the assistant, with the events it used. |
| Today | The first thing to do today, with its one filled button (Draft in Outlook, Mail or the chat app) and the line box filled in; the other picks one line each, drafts ready to open, and the questions Loggie stopped on. |
| Workspaces | Your workspaces by next due date, Inbox and Chats last. A workspace's page holds its drafts to send, its moves with Done, New date and Drop, and how you write there. Stale moves retire themselves, with the reason and Undo. |
| Meetings | Your week on a calendar. Records a call and shows its words on the Transcript page about a second after they are said, streams the notes in, explains every point, and keeps next steps' actions in one popup. A name check fixes misheard names from your own words first and the web second. A recorded call is filed under one workspace. |
| Settings (in the three dots) | Your Mac's checks and mail app, folder access, voice input, the cloud analysis key. |

While a call records, a local NVIDIA streaming model (Nemotron 3.5 ASR Streaming, in NeMo-Speech.cpp on 127.0.0.1) writes the newest words, and every 30 seconds the more accurate Parakeet reader replaces them; the transcript after Stop is built from Parakeet as before. Each call's `live/stream-check.json` records how far behind the words were and how often they matched. `LOGGIE_LIVE_STREAM=0` turns the stream off.

The cloud AI runs only after your yes, for this time or always. The build contracts are in `AGENTS.md`; the team's working design docs stay in the private repo.

## Teammates: first run

You need a Mac with your mail in Apple Mail (Outlook, Gmail and other accounts all work there), Node.js 20 or newer,
the Xcode command line tools, and your own Nebius and Tavily keys.

    git clone https://github.com/Gumball0110/Loggie.git loggie && cd loggie
    npm ci
    xcode-select -p || xcode-select --install
    npm run build:native
    npm run doctor
    npm run desktop

`npm run build:native` builds the calendar, chats, mic, Outlook and voice helpers once, in about a minute.
`npm run doctor` says what is ready; a line marked ! is something the setup page turns on. `npm run desktop` opens
Loggie on its setup page, nine steps, about a minute:

1. Welcome: your first name, which signs your drafts.
2. Email: where you write email, Outlook or Apple Mail, and whether to read Messages and WhatsApp.
3. Calendar: one macOS dialog.
4. Full Disk Access: one switch for your mail, texts, contacts and files, then a live check of the accounts in Apple Mail.
5. Apps: Accessibility (Outlook, chats) or Mail control (Apple Mail), so drafts land in the right thread.
6. Voice: Speech Recognition and the microphone, for voice typing.
7. Keys: paste the Nebius key and the Tavily key; each checks itself. Then your yes for the cloud AI.
8. Calls: the microphone and screen audio, then Loggie reopens.
9. Ready: everything and its state; anything off has its Turn on button.

Run from Terminal, macOS lists Terminal, not Loggie, in Privacy & Security: switch on the app the setup page names.
After Ready, Loggie reads your last 30 days of mail and shows the workspaces it found: keep, rename or
dismiss each, then Today. Meetings shows your week with Loggie's guess for each meeting in yellow until you press Yes. A meeting can also start a workspace: Change, then
New workspace…, seeded from that meeting. Loggie reads Gmail, school and work mail through
Apple Mail: add each account in System Settings > Internet Accounts. Calls record in this copy; the Calls step's switch downloads the NVIDIA
speech models (1.46 GB) for their transcripts, which also need python3 with numpy (python3 -m pip install numpy).

Workspaces stay current on their own. Every 10 minutes, and when the app opens with `HIKYAKU_REFRESH_ON_START=1`, Loggie checks your mail in Apple Mail, Messages, WhatsApp, the calendar and recorded calls for anything new since it last looked. That check costs nothing. Each new item is filed to one workspace, by its thread, a filed call, a domain or a word, or a person you confirmed; anything else stays unsure. Only workspaces with something new are re-read, with just the new items and the old summary, at most once a day each on the timer. The re-reads stop for the day at `cloudDailyLimitUsd` in settings.json (default 3). A workspace you mark "matters more" sorts first, and one you park comes back on its date. `HIKYAKU_REFRESH=0` turns the timer off. The details are in `AGENTS.md`.

## Requirements

- macOS
- Node.js 20 or newer

## Install for local development

```bash
npm install
npm link
```

## Desktop app

Launch the standalone desktop app:

```bash
npm run desktop
```

After initial setup, Loggie starts quietly in the background. Press `Command+Shift+L` (`⌘⇧L`) to open or restore the assistant on the display under your pointer and focus the request box. Press it again while Loggie is in front to hide the window. `⌘K` still focuses the request box within Loggie.

Closing the window, pressing `⌘W`, or using **Hide Loggie** keeps the app and its background work running, preserving the page, draft and window size. Click the blue L in the Dock or the L in the menu bar to reopen it; right-click the menu bar icon for Open, Hide and Quit. **Quit Loggie** stops the app and its global shortcut. If the shortcut is unavailable, Loggie shows a notice and these other entry points remain available.

The blue L logo PNGs, app icon and monochrome menu bar marks are built from `assets/branding/loggie-logo.svg`. Run `npm run build:icons` on macOS to regenerate their PNG sizes and the packaged `.icns` icon with the system tools; no extra dependency is required.

The desktop uses a command-first interface. Ask Loggie to open a local file, folder, or project in Visual Studio Code, Finder, Terminal, or its default app—for example, `Open AI Terminal Tool in VS Code`. Loggie searches known projects plus Documents, Desktop, and Downloads; it opens a unique match directly and asks you to choose when names are ambiguous. Commands run locally and structured process arguments are used instead of passing natural language to a shell.

Email content is rendered as inert text. Background behavior depends on settings and launch flags. Review approvals before sharing selected content with cloud AI.

Quick desktop verification:

```bash
npm run desktop:smoke
```

The smoke check opens the secure assistant window, verifies hiding and restoring it, then quits automatically. On macOS you may be asked to allow the global keyboard shortcut the first time you use it.

### Manual Milestone 1 test

1. Run `npm install`, then `npm run desktop`.
2. After setup, confirm Loggie waits in the background with a blue L Dock icon and no floating character.
3. From another app, press `Command+Shift+L` and confirm Loggie opens with the request box focused; press again to hide it.
4. Minimize the assistant, then summon it again; confirm the page and unsent text are preserved. Also check Close / `⌘W`, the Dock, and the menu bar.
5. Summon on another display or Space, check full screen and return, then quit and relaunch; confirm the chosen window size is retained.
6. Ask a question about your email and confirm Loggie says it cannot search email there rather than claiming to read it.

## Invites and replies in seconds

Type a sentence in the panel's box, or in a terminal:

```bash
loggie invite "Amritha and Jess monday 2pm Maplewood"
loggie invite "Amritha and Jess room in Sage next week"
loggie invite "Jess every tuesday and thursday 4pm for 6 weeks with notes"
loggie invite "Nina oct 14 noon on google"
loggie invite "..." --dry-run      # what Loggie understood, without opening Outlook
```

Loggie reads the sentence with code, not a model: who (names are matched to addresses from your own mail, and two
people with the same name is a question, never a guess), when (or no time, and Loggie finds one), how long, where
(a place, or a free room in a building), how often (daily, every other week, Tuesdays and Thursdays, until a date,
a number of times), the last call's notes, and Google Calendar instead of Outlook. Outlook checks every time for
everyone on the invite; when the time asked is taken, the first time that works for everyone is filled and two more
are listed. Outlook's window is filled and read back; you press Send. Loggie never sends.

Replies to a next move are found in the Inbox, checked for sender and date, and pasted, in about 7 seconds.

Speed check against your own Outlook (each test invite is discarded): `node scripts/time-invite.mjs` (10 s limit,
4 s goal).

## Development

```bash
npm test
```

## Voice requests on macOS

Click the microphone beside the request box to start on-device speech recognition. On first use, allow Microphone and Speech Recognition access. Click again to stop, review the text, then submit. If on-device recognition is unavailable, enable macOS Dictation and use Fn twice in the text box.

Opening Loggie from the Dock, menu bar or shortcut focuses the request box, so Fn twice also works without clicking the microphone.

### First run on a teammate’s Mac
Start with [Teammates: first run](#teammates-first-run): the setup page asks for each permission in its own step. To search other folders, open Settings (in the three dots) → Choose folders and select the folders Loggie should search. Each Mac keeps its own selections; search now reports blocked access rather than treating it as a missing file. If macOS denies access, enable Loggie in Privacy & Security → Files and Folders, then re-select the folder.

Click the composer microphone to grant Speech Recognition and Microphone access and start on-device speech. Click again to stop; text is never submitted automatically. Denied access and unavailable microphones produce visible errors. On-device speech requires an available language model; Fn-twice Dictation remains a fallback. Source users must run `npm run build:voice`; `npm run dist:mac` bundles the helper in the installed app. Teammates must install a newly built app to receive these fixes.

### Guided permission setup
On a fresh Mac, Connections opens the setup cards. **Enable file search** checks Documents, Desktop and Downloads, triggering native macOS access prompts for protected locations whose permission is undecided. **Choose other folders** opens the native folder picker. Blocked access reveals **Open folder permissions**, with **Check access again** after changing it. **Enable voice input** requests Speech Recognition followed by Microphone access without recording. Denial reveals a button for the specific Settings pane. macOS controls whether a consent prompt appears; an already denied permission requires Settings rather than another prompt.

## License

Loggie is released under the MIT License: see [LICENSE](LICENSE).
