# Spike: record a call, then turn it into notes, all on this Mac.
#   python3 call.py start "<title>" '<event json>'   starts recording both sides
#   python3 call.py start "<title>" '<event json>' --also '<event json>'
#                                                     one recording, two meetings: the room's mic and the Mac's sound, each its own call
#   python3 call.py start --calendar [--at ISO]       starts recording the meeting on the calendar now, names from the invite
#   python3 call.py check [--no-recording]            everything the day-of run needs, including a 3 s test recording (unless told not to)
#   python3 call.py live <call-folder>                the live reader, started by start: reads both growing files into <call>/live/
#   python3 call.py stop                              stops, transcribes (Me/Them), writes notes
#   python3 call.py pause | resume                    the recorder saves silence until resume; the same recording goes on
#   python3 call.py redo <call-folder> [--against <version-folder>] [--materials <dir>]
#                                                     transcript again into <call>/vN-nvidia/ (Parakeet + Nemotron, gap check,
#                                                     ear-check.md against the previous version)
#   python3 call.py prepare <version-folder>         frontier nebius: screens on this Mac and records a pending send (sendgate.py); sends nothing
import json, os, re, shutil, signal, subprocess, sys, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import tools
HOME = Path(os.environ.get('LOGGIE_HIKYAKU_HOME') or Path.home() / 'Library' / 'Application Support' / 'Loggie' / 'hikyaku') / 'calls'
STATE = HOME / 'current.json'

PROFILE = HOME.parent / 'profile.md'
SETTINGS = HOME.parent / 'settings.json'   # Loggie's; read, never written here

def settings():
    try: return json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}
    except json.JSONDecodeError as error: sys.exit(f'{SETTINGS} is not JSON: {error}')

def frontier():
    # settings.json "frontier": who writes the call summary (spec-entry-b.md section 6), byo.py after the user's Yes;
    # nebius when absent. There is no model on this Mac (Gio, 2026-10-18), so an old "local" is nebius too.
    pick = settings().get('frontier') or 'nebius'
    return 'nebius' if pick == 'local' else pick
WORKSTREAMS = HOME.parent / 'workstreams.json'
COURSE = re.compile(r'\b[A-Z]{2,4}\s?\d{4}\b')

def my_name():
    # profile.md first, then Loggie's sign-off name (settings "signName"): since the fresh start of 2026-10-14 there is no
    # profile.md, every call was saved as "Me", and the notes wrote "the person who recorded the call" as an owner.
    m = re.search(r'The user is ([A-Z][a-z]+)', PROFILE.read_text() if PROFILE.exists() else '')
    if m: return m.group(1)
    try: sign = str(settings().get('signName') or '').strip()
    except SystemExit: sign = ''
    return sign.split()[0] if sign else 'Me'

def category(event):
    # From calendar data alone, by code (I3 refines it): a course code is a class, one other person a one-on-one,
    # four or more a team meeting, otherwise an informal chat.
    if COURSE.search(event.get('title', '')): return 'class'
    people = event.get('emails') or [n for n in event.get('attendees', '').split(', ') if n]
    return 'one-on-one' if len(people) == 1 else 'team' if len(people) >= 4 else 'chat'

def workstream_hits(event):
    # The workstreams this event could file under, at the level that decides (spec-c.md B16). A workstream word is a
    # whole word, any case, in a name or an email local part (a surname "Lee" must not match "Sleep"), or a substring of
    # the title as before. Words beat domains: only when no word hits does a shared domain decide. One name is a filing;
    # more than one is a tie, and the notes step asks.
    try: workstreams = json.loads(WORKSTREAMS.read_text())
    except Exception: return []
    emails = [e.lower() for e in event.get('emails', [])]
    domains = {e.split('@')[-1] for e in emails}
    people = [n.lower() for n in event.get('names', '').split(', ')] + [re.sub(r'[._-]', ' ', e.split('@')[0]) for e in emails]
    title = event.get('title', '').lower()
    def word_hit(word):
        word = word.lower()
        return bool(word) and (word in title or any(re.search(rf'(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])', p) for p in people))
    words = [w['name'] for w in workstreams if any(word_hit(x) for x in w.get('words', []))]
    if words: return words
    return [w['name'] for w in workstreams if any(d == x.lower() or d.endswith('.' + x.lower()) for d in domains for x in w.get('domains', []))]

def workstream_of(event):
    hits = workstream_hits(event)
    return hits[0] if len(hits) == 1 else 'none'

def derive(event):
    # The notes prompt needs me, with, category and workstream; the calendar gives none of them. Derived by code,
    # never by the model. Missing them crashed the notes step on every calendar-started call (found 2026-10-04).
    e = {'names': '', **event}
    e.setdefault('me', my_name())
    if 'workstream' not in e:   # filed on the whole invite, before the names are capped for the voice hint
        hits = workstream_hits(e)
        e['workstream'] = hits[0] if len(hits) == 1 else 'none'
        if len(hits) > 1: e['workstream_candidates'] = hits
    for key in ('names', 'attendees'):
        if e.get(key): e[key] = ', '.join(e[key].split(', ')[:MAX_NAMED])
    e['with'] = e.get('with') or e.get('names') or e.get('attendees') or 'the other person'
    e.setdefault('category', category(e))
    return e

def clear_stale_state():
    if not STATE.exists(): return
    try:
        state = json.loads(STATE.read_text())
        pid = int(state['pid'])
        if pid <= 0: raise ValueError('invalid recording pid')
        os.kill(pid, 0)
    except ProcessLookupError:
        # Preserve the old pointer and call files; only a process confirmed gone is stale.
        STATE.rename(STATE.with_name(f'current-stale-{time.time_ns()}.json'))
        return
    except (ValueError, KeyError, json.JSONDecodeError):
        sys.exit('Recording state could not be read. Reopen Loggie and check the recording folder.')
    except PermissionError:
        pass
    sys.exit(f'Already recording: {state.get("dir", "another call")}')

# A join link in the event (meeting.js LINK, and the Teams marker that has no URL): that meeting is on the Mac's sound.
JOIN = re.compile(r'zoom\.us/|teams\.microsoft\.com/l/meetup-join|teams\.live\.com|meet\.google\.com/|microsoft teams meeting', re.I)
LINK_WAIT_S = 15.0   # how long start waits for the recorder's them.caf before the split's second folder can link it (stream.CAF_WAIT_S)

def in_room(event):
    # The meeting he sits in (split-recording-proposal.md, 2026-10-28): a course code or a room, and no join link.
    place = str(event.get('location') or '').strip()
    if JOIN.search(' '.join(str(event.get(k) or '') for k in ('title', 'location', 'notes', 'url'))): return False
    return bool(COURSE.search(event.get('title', '')) or (place and not re.match(r'https?://', place)))

def new_folder(title):
    base = HOME / (time.strftime('%Y-%m-%d-%H%M-') + re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:50])
    folder, n = base, 1
    while folder.exists(): n += 1; folder = base.with_name(f'{base.name}-{n}')   # two meetings of one name in one minute
    folder.mkdir(parents=True)
    return folder

def start_args(argv):
    # The argv after "start": "<title>" ['<event json>'] [--also '<event json>'] -> (title, event, also).
    a, also = list(argv), None
    if '--also' in a:
        i = a.index('--also')
        if i + 1 >= len(a): sys.exit("usage: call.py start \"<title>\" '<event json>' --also '<other event json>'")
        also = a[i + 1]; del a[i:i + 2]
    if not a: sys.exit("usage: call.py start \"<title>\" '<event json>' [--also '<other event json>']")
    return a[0], a[1] if len(a) > 1 else '{}', also

def start(title, event, also=None):
    # One recorder. With `also` (split recording, 2026-10-28) the recording is two meetings: folder B, the one in the room
    # (in_room; a tie keeps the caller's order), is where the recorder writes and reads only the mic ("sides": ["me"]);
    # folder A reads only the Mac's sound ("sides": ["them"]), its them.caf a hard link to B's. Each has its own live reader;
    # stop writes up B, then A.
    HOME.mkdir(parents=True, exist_ok=True)
    clear_stale_state()
    # The call's time is the press (2026-10-27): the header, the call row and the week join read recorded_at first, so
    # a call pressed at 14:58 for a 15:00 meeting says 14:58, not the 14:30 start of whatever block it was named after.
    pressed = datetime.now().astimezone().isoformat(timespec='seconds')
    event, other = {**json.loads(event), 'title': title, 'recorded_at': pressed}, None
    if also:
        other = {**json.loads(also), 'recorded_at': pressed}
        if not str(other.get('title') or '').strip(): sys.exit("--also needs the other meeting's title in its event json")
        if in_room(other) and not in_room(event): event, other = other, event
    folder = new_folder(event['title'])
    second = new_folder(other['title']) if other else None
    if other:
        event = {**event, 'sides': ['me'], 'split': {'with': second.name}}
        (second / 'event.json').write_text(json.dumps(derive({**other, 'sides': ['them'], 'split': {'with': folder.name}}), indent=2))
    event = derive(event)
    (folder / 'event.json').write_text(json.dumps(event, indent=2))
    # The MacBook's own mic for a class and for a split (Gio, 2026-10-28): AirPods as the default input hear only him, and
    # a class on them loses the professor.
    mic = ['--mic', 'builtin'] if other or event['category'] == 'class' else []
    log = open(folder / 'recorder.log', 'w')
    proc = subprocess.Popen([str(HERE / 'recorder'), str(folder), *mic], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(3)
    if proc.poll() is not None: sys.exit('Recorder did not start: ' + (folder / 'recorder.log').read_text())
    state = {'pid': proc.pid, 'dir': str(folder), 'started': time.time(), **({'also': str(second)} if second else {})}
    STATE.write_text(json.dumps(state))
    # The live reader (live.py) reads the growing files while the meeting runs, so stop only has the last piece left.
    def reader(f):
        (f / 'live').mkdir()
        return subprocess.Popen([sys.executable, str(HERE / 'call.py'), 'live', str(f)], stdout=open(f / 'live' / 'live.log', 'w'), stderr=subprocess.STDOUT, start_new_session=True).pid
    state['live_pid'] = reader(folder); STATE.write_text(json.dumps(state))
    if second:
        import live
        t0 = time.time()
        while not live.link_split(second) and time.time() - t0 < LINK_WAIT_S: time.sleep(0.1)
        if not (second / 'them.caf').exists(): print(f'{folder / "them.caf"} not there after {LINK_WAIT_S:.0f} s; the reader of {second.name} links it when it comes', flush=True)
        state['also_live_pid'] = reader(second); STATE.write_text(json.dumps(state))
    print(f'Recording the room to {folder} and the Mac\'s sound to {second}' if second else f'Recording both sides to {folder}')

def live_command(folder):
    # `call.py live <folder>`: the live reader, until live/stop or until the recorder (the pid STATE holds for this folder
    # when the reader starts) is gone. Without a recording under this folder only live/stop ends it.
    import live
    pid = None
    try:
        state = json.loads(STATE.read_text())
        if str(folder) in (state.get('dir'), state.get('also')): pid = state['pid']   # a split's second folder has the same recorder
    except (OSError, ValueError, KeyError): pass
    def alive():
        if pid is None: return True
        try: os.kill(pid, 0)
        except ProcessLookupError: return False
        except PermissionError: pass
        return True
    import stream
    # words on screen within about a second (proposal-live-stream.md)
    return live.run(Path(folder), recorder_alive=alive, events_home=HOME.parent, streamer=stream.Streams.start)   # Loggie's panel tails <hikyaku home>/runs

# The Loggie this transcriber ships in: LOGGIE_DIR, which every spawn from the app sets, else the repo it sits in
# (transcriber/spike, since 2026-10-09). The old ~/Loggie-cloud fallback named a folder that no longer exists.
LOGGIE = Path(os.environ.get('LOGGIE_DIR') or HERE.parents[1])
MAX_NAMED = 8   # a big invite (a class, an all-hands) would drown the hint and the voice count with names; emails are never capped (derive files by them)

def untitled(at):
    # A call with no meeting behind it: named by the time, and marked so the notes step names and files it from what was
    # said (byo.file_call) after the user's Yes.
    when = datetime.fromisoformat(at)
    return f"Untitled call, {when.strftime('%-I:%M %p')}", {'start': when.astimezone().isoformat(timespec='seconds'), 'untitled': True}

def from_calendar(at=None):
    # The meeting on the calendar now (or starting within 10 minutes) becomes the recording's event: its title, and the
    # invite's other people as the names the readers are boosted with. Only an event the app
    # would offer counts (meeting.js isMeeting: a join link, or invitees and at most 4 hours): on 2026-10-09 a 37-hour
    # "MBA Veterans Career Conference & Expo" block on the MBA I calendar, no invitees, named a Loggie working session
    # Gio never left his desk for. Nothing that counts means an untitled call, never the nearest block. Only his events
    # count (meeting.js isMine, settings "recordCalendars", 2026-10-27), so `loggie record` and the app agree.
    at = at or datetime.now().astimezone().isoformat(timespec='seconds')
    js = ("Promise.all([import(process.argv[1]), import(process.argv[2])]).then(async ([c, m]) => { const at = new Date(process.argv[3]);"
          " const recordCalendars = m.recordCalendarsSaved(JSON.parse(process.argv[4])); m.setCalendarOwner(JSON.parse(process.argv[4]).owner || []);"
          " const e = (await c.listEvents({ from: new Date(at - 48 * 3600e3), days: 3 })).filter(x => new Date(x.start) - at <= 600e3 && new Date(x.end) > at);"
          " console.log(JSON.stringify(e.map(x => ({ ...x, meeting: m.isMine(x, { recordCalendars }) && m.isMeeting(m.candidateOf(x)) })))); })")
    out = subprocess.run(['node', '-e', js, str(LOGGIE / 'src' / 'hikyaku' / 'calendar.js'), str(LOGGIE / 'src' / 'hikyaku' / 'meeting.js'), at,
                          json.dumps({'recordCalendars': settings().get('recordCalendars'), 'owner': [settings().get('signName') or '']})], capture_output=True, text=True)
    if out.returncode: sys.exit('Could not read the calendar: ' + out.stderr.strip().splitlines()[-1])
    now_on = json.loads(out.stdout)
    skipped = sorted({e['title'] for e in now_on if not e['meeting']})
    richest = {}   # the same meeting on two calendars: keep the copy with the most invitees (spec-c.md 9.3)
    for e in now_on:
        if not e['meeting']: continue
        key = (e['title'], e['start'])
        if key not in richest or len(e['attendees']) > len(richest[key]['attendees']): richest[key] = e
    events = list(richest.values())
    events = [e for e in events if e['attendees']] or events
    if not events:
        title, event = untitled(at)
        print(f'No meeting on the calendar now' + (f" (not meetings: {', '.join(skipped)})" if skipped else '') + f'. Recording as "{title}"; Loggie names it from what was said when you send it.')
        return title, json.dumps(event)
    e = min(events, key=lambda e: (len(e['attendees']) > MAX_NAMED, abs((datetime.fromisoformat(e['start'].replace('Z', '+00:00')) - datetime.fromisoformat(at)).total_seconds())))
    names = [n.replace(',', '') for n in e.get('attendeeNames', [])][:MAX_NAMED]
    event = {'title': e['title'], 'start': e['start'], 'emails': e['attendees'], 'names': ', '.join(names), 'attendees': ', '.join(names)}
    print(f"From the calendar: {e['title']}" + (f" with {event['names']}" if names else ' (no names to match voices against)'))
    return e['title'], json.dumps(event)

def merge(me, them):
    # Without headphones the mic hears the other side too. Drop a Me line whose words Them said at the same moment:
    # word by word within 1.5 s when the engine gives word times (NVIDIA lines are a sentence long, 11.7 words on the
    # class, so the old line-level +-6 s window matched too much and too little), else the old line window.
    # Retuned 2026-10-07 on the class: 646 of 669 Me lines dropped, Gio's answer at 12:15 kept.
    import nvidia_engine
    index = nvidia_engine.echo_index(them)
    kept = [{**m, 'who': 'Me'} for m in me if not nvidia_engine.is_echo(m, index) and not re.fullmatch(r'\[.*\]|\(.*\)', m['text'])]
    lines = sorted(kept + [{**t, 'who': 'Them'} for t in them if not re.fullmatch(r'\[.*\]|\(.*\)', t['text'])], key=lambda s: s['t'])
    return lines, len(me) - len(kept)

def merge_sides(tracks, sides):
    # Both sides: merge, echo filter and all. One side of a split recording (2026-10-28): its own lines under its own
    # label, nothing to interleave and no other track to hear an echo in, so 0 lines dropped.
    import transcript
    if len(sides) == 2: return merge(tracks['me'], tracks['them'])
    who = transcript.label_of(sides, sides[0])
    return sorted(({**l, 'who': who} for l in tracks[sides[0]] if not re.fullmatch(r'\[.*\]|\(.*\)', l['text'])), key=lambda s: s['t']), 0

def sides_in(folder):
    # The tracks a call folder reads (transcript.sides_of its event.json): both, or one side of a split recording.
    import transcript
    path = Path(folder) / 'event.json'
    return transcript.sides_of(json.loads(path.read_text()) if path.exists() else {})

START = time.time()   # stop's clock: "ready for the question in X s" counts from the moment this process started

def wait_gone(pid, cap=3.0, probe=os.kill, sleep=time.sleep, now=time.time):
    # The recorder closes its files when it gets SIGINT. Go on the moment it is gone; after `cap` seconds go on anyway
    # (the old fixed 3 s sleep was the cap). True when it is gone.
    t0 = now()
    while True:
        try: probe(pid, 0)
        except ProcessLookupError: return True
        except PermissionError: pass
        if now() - t0 >= cap: return False
        sleep(0.05)

def alive(pid, probe=os.kill):
    if not pid: return False
    try: probe(pid, 0)
    except ProcessLookupError: return False
    except PermissionError: pass
    return True

ALIGN_S = 0.5   # two sides further apart than this at stop did not start together (2026-10-28)

def align(folder):
    # The silence each side needs in front so both run on one clock, {'me': s, 'them': s}. Both stop together
    # (stopCapture), so the shorter side started late by the difference: 2026-10-27's AirPods mic (24 kHz) began 6.16 s
    # after the system audio and every Me line was 6 s early. A recorder that wrote timing.json padded its start itself.
    # Lengths from each CAF's own header rate and size; a header that cannot be read pads nothing (ffmpeg says why).
    import live
    pads = {'me': 0.0, 'them': 0.0}
    if (folder / 'timing.json').exists() or len(sides_in(folder)) < 2: return pads   # one side of a split has no other clock to meet
    try: length = {side: live.heard_s(folder / f'{side}.caf', live.caf_info(folder / f'{side}.caf')) for side in pads}
    except (live.LiveFormat, OSError): return pads
    gap = round(abs(length['me'] - length['them']), 2)
    if gap > ALIGN_S: pads[min(length, key=length.get)] = gap
    return pads

def convert_wavs(folder):
    # me.caf and them.caf to 16 kHz mono wavs, the form the engine, the gap check and the ear check read. The side that
    # started late gets align's silence in front (2026-10-28), so both wavs and every stamp read off them share one clock.
    pads = align(folder)
    for side in sides_in(folder):
        delay = ['-af', f'adelay={round(pads[side] * 1000)}:all=1'] if pads[side] else []
        subprocess.run([tools.FFMPEG, '-v', 'error', '-y', '-i', str(folder / f'{side}.caf'), *delay, '-ar', '16000', '-ac', '1', str(folder / f'{side}.wav')], check=True)

def pause(resume=False, kill=os.kill, now=time.time):
    # Pause or resume the one recording (2026-10-28). The recorder (SIGUSR1 / SIGUSR2) writes silence while paused and keeps
    # pauses.json itself; current.json keeps paused_at (epoch s, None when running) and paused_s (closed pauses, s) so the
    # card's clock can hold. Asking for the state it is already in changes nothing.
    if not STATE.exists(): sys.exit('Nothing is recording.')
    state = json.loads(STATE.read_text())
    if resume == (state.get('paused_at') is not None):
        try: kill(state['pid'], signal.SIGUSR2 if resume else signal.SIGUSR1)
        except ProcessLookupError: sys.exit('The recorder is not running. Stop writes up what it recorded.')
        t = now()
        if resume: state['paused_s'], state['paused_at'] = round(state.get('paused_s', 0) + t - state['paused_at'], 1), None
        else: state['paused_at'] = t
        STATE.write_text(json.dumps(state))
    out = {'paused': state.get('paused_at') is not None, 'paused_s': state.get('paused_s', 0)}
    print(json.dumps(out))
    return out

def stop(started=None, **deps):
    # SIGINT the recorder, then turn the recording into a transcript and a prepared send. With a live folder (the reader
    # ran while the meeting did) only the last piece is left to read, so the question can be asked within seconds
    # (stop_live); without one, or when the live words cannot be used, every file is read now (stop_batch).
    t0 = START if started is None else started
    kill, probe, sleep, now = deps.get('kill', os.killpg), deps.get('probe', os.kill), deps.get('sleep', time.sleep), deps.get('now', time.time)
    if not STATE.exists(): sys.exit('Nothing is recording.')
    state = json.loads(STATE.read_text())
    try:
        kill(state['pid'], signal.SIGINT)
        if not wait_gone(state['pid'], 3.0, probe, sleep, now): print('stop: the recorder was still closing its files after 3 s, going on', flush=True)
    except ProcessLookupError: print('stop: the recorder had already quit, writing up what it recorded', flush=True)
    STATE.unlink()
    if not state.get('also'): return write_up(Path(state['dir']), t0, state.get('live_pid'), None, **deps)
    # A split recording (2026-10-28): the room's call, then the Mac-sound call, one at a time on the one GPU. Both questions
    # come before either check pass (`later`), and a folder that cannot be written up never costs the other its notes.
    import live
    folder, second = Path(state['dir']), Path(state['also'])
    live.link_split(second)   # again: a late them.caf, or a recorder that replaced it
    for name in ('timing.json', 'pauses.json'):
        if (folder / name).exists(): shutil.copy2(folder / name, second / name)
    later, codes, failed = [], [], []
    for f, pid in ((folder, state.get('live_pid')), (second, state.get('also_live_pid'))):
        try: codes.append(write_up(f, t0, pid, later, **deps))
        except (Exception, SystemExit) as error:
            why = error.code if isinstance(error, SystemExit) else f'{type(error).__name__}: {error}'
            failed.append(f'{f.name}: {why}'); print(f'stop: {f.name} NOT WRITTEN UP: {why}', flush=True)
    codes += [run() for run in later]
    if failed: sys.exit('; '.join(failed))
    return max([c or 0 for c in codes] + [0])

def write_up(folder, t0, live_pid, later, **deps):
    # One call folder after its recorder stopped: the live words when there are some (stop_live), else every file read
    # now (stop_batch). Only its own sides (event.json "sides").
    event = json.loads((folder / 'event.json').read_text())
    for side in sides_in(folder):
        if not (folder / f'{side}.caf').exists(): sys.exit(f'No {side} audio was recorded. Check Microphone and Screen & System Audio Recording permissions.')
    for side, pad in align(folder).items():
        if pad: print(f'stop: sides differ by {pad:.2f} s; padding {side} by {pad:.2f} s (the recorder did not line them up)', flush=True)
    if (folder / 'live').is_dir(): return stop_live(folder, event, t0, live_pid, later=later, **deps)
    return stop_batch(folder, event, t0, later=later, **deps)

MARKS_COMING = 'No word is marked yet: Nemotron is still reading the call, and this transcript is rewritten with its marks when it is done.'
REFINE_DIR = '.refine'   # the marks pass writes here, and its files replace the call's only once all of them are written
SENDING_WAIT_S = 900     # a send being written reads transcript.md: the marked one waits this long for it at most

def write_json(path, data):
    # Whole file or none: the card reads version.json while stop works.
    tmp = Path(str(path) + '.tmp'); tmp.write_text(json.dumps(data, indent=1)); os.replace(tmp, path)

def stop_batch(folder, event, t0, reason=None, later=None, **deps):
    # Both files whole, read at stop. The question comes after one reader (2026-10-27: six engine runs one after another
    # put it 1228.6 s after Stop): Parakeet on both sides, the transcript, the screen and "ready"; then Nemotron and the
    # marks (refine) rewrite the transcript. `reason` is why a call that had a live reader comes here; it goes into
    # version.json and onto the screen. With `later` (a split's list) the marks wait there until every question is out.
    import nvidia_engine, transcript
    now = deps.get('now', time.time)
    convert_wavs(folder)
    first = read_first(folder, folder)
    tracks = {side: nvidia_engine.lines_of([dict(w) for w in first['words'][side]]) for side in transcript.sides_of(event)}
    version = {'version': 'v1', 'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'engine': 'nvidia', 'model': nvidia_engine.PARAKEET.name,
               'second_reader': nvidia_engine.NEMOTRON.name, 'mark_rule': MARKS_COMING, 'chunk_s': nvidia_engine.CHUNK_S, 'threshold': transcript.THRESHOLD,
               'timings_s': dict(first['timings_s']), 'runs': first['runs'], 'agreement': {}, 'filled': {}, 'gap_check': 'deferred', 'gaps': {}, 'refine': {'status': 'running'}}
    if reason: version['live_fallback'] = {'whole_call': True, 'why': reason}
    write_json(folder / 'version.json', version)
    finish(folder, event, tracks, folder, version, with_notes=False)
    prepare(folder, event)
    version = json.loads((folder / 'version.json').read_text())   # finish adds the line check
    version['timings_s']['ready'] = round(now() - t0, 2); write_json(folder / 'version.json', version)
    print(f'stop: ready for the question in {now() - t0:.1f} s (Parakeet read every file at stop' + (f': {reason}' if reason else '') + '; the marks come next)', flush=True)
    if later is not None: later.append(lambda: refine(folder, event, first, version, **deps)); return 0
    return refine(folder, event, first, version, **deps)

def refine(folder, event, first, quick, **deps):
    # After the question: Nemotron on both sides, the fills, the marks, the boosted label pass and the gap check, written
    # into <call>/.refine and moved over the call's files only when all of them are, transcript.md last, so the card never
    # shows a half-written transcript; until then version.json says refine "running". A send still waiting is then
    # prepared again from the marked transcript, the older one superseded (call-notes.js prepareCall's rule: one question).
    sleep, now = deps.get('sleep', time.sleep), deps.get('now', time.time)
    t = now(); stage = folder / REFINE_DIR
    shutil.rmtree(stage, ignore_errors=True); stage.mkdir()
    try:
        tracks, version = transcribe(folder, event, stage, 'v1', first=first)
        version = {**version, **{k: quick[k] for k in ('live_fallback',) if k in quick}, 'timings_s': {**quick['timings_s'], **version['timings_s']}}
        write_json(stage / 'version.json', version)
        finish(folder, event, tracks, stage, version, with_notes=False)
        version = json.loads((stage / 'version.json').read_text())
        version['refine'] = {'status': 'done', 'seconds': round(now() - t, 1)}; write_json(stage / 'version.json', version)
    except (Exception, SystemExit) as error:
        shutil.rmtree(stage, ignore_errors=True)
        write_json(folder / 'version.json', {**quick, 'refine': {'status': 'failed', 'why': str(error)}})
        print(f'MARKS DID NOT RUN: {error}. The transcript is Parakeet\'s reading alone, with nothing marked (unclear).', flush=True)
        return 1
    waited = wait_sending(folder, sleep, now)
    for f in sorted(stage.iterdir(), key=lambda p: p.name == 'transcript.md'): os.replace(f, folder / f.name)
    stage.rmdir()
    print(f"stop: marks done in {version['refine']['seconds']:.1f} s" + (f' (waited {waited:.0f} s for the notes being written)' if waited else '') + '; transcript.md now carries them', flush=True)
    gap_report(version)
    reprepare(folder, event)
    return 0

def sends_of(folder):
    # The call-notes sends of this call: (send.json path, send).
    import sendgate
    out = []
    for path in sorted(sendgate.runs_root(SETTINGS.parent).glob('*/send.json')):
        try: send = json.loads(path.read_text())
        except (OSError, ValueError): continue
        if send.get('what') == 'call-notes' and Path(str(send.get('folder', ''))) == Path(folder).resolve(): out.append((path, send))
    return out

def wait_sending(folder, sleep, now, every=1.0):
    # Seconds waited while a send of this call is being written (byo.py checks its quotes against transcript.md); 0 when none was.
    t0, polls = now(), 0
    while any(s.get('status') == 'sending' for _, s in sends_of(folder)) and now() - t0 < SENDING_WAIT_S: sleep(every); polls += 1
    return max(now() - t0, every * polls) if polls else 0.0

def reprepare(folder, event):
    # A send still waiting for the yes was screened from the unmarked transcript, and the rewrite made it stale (byo.py
    # would refuse it): screen again, and mark the waiting ones superseded by the new one. A send already answered stays.
    waiting = [path for path, send in sends_of(folder) if send.get('status') == 'pending']
    if not waiting: return None
    send = prepare(folder, event)
    if not send: return None
    for path in waiting:
        old = json.loads(path.read_text())
        if old.get('status') != 'pending': continue   # answered meanwhile
        path.write_text(json.dumps({**old, 'status': 'superseded', 'superseded_by': send['run']}, indent=1, ensure_ascii=False) + '\n')
    return send

def stop_live(folder, event, t0, live_pid=None, later=None, **deps):
    # The fast path (spec-live-transcription.md L3): ask the reader for the tail, build the transcript from the live words,
    # screen it and prepare the send, print that the question can be asked; only then run the full check (check_pass).
    # Any range the reader did not cover is read here; a reader that left nothing usable sends the call to stop_batch.
    import live
    probe, sleep, now = deps.get('probe', os.kill), deps.get('sleep', time.sleep), deps.get('now', time.time)
    engine, cut = deps.get('engine', live.ne.run), deps.get('cut', live.ffmpeg_cut)
    timings, mark = {}, [now()]
    def lap(name):
        timings[name] = round(now() - mark[0], 2); mark[0] = now()
    (folder / 'live' / 'stop').write_text('')
    heard = live.wait_for(folder / 'live' / 'done.json', live.TAIL_WAIT_S, lambda: alive(live_pid, probe), sleep, now)
    if not heard and alive(live_pid, probe):
        print(f'stop: the reader did not finish the last piece in {live.TAIL_WAIT_S} s, reading it here', flush=True)
        probe(live_pid, signal.SIGTERM)
    lap('wait_tail')
    done = live.read_json(folder / 'live' / 'done.json') if heard else None
    ranges, whole = live.gaps(folder, done)
    covered = {}
    if whole is None:
        try:
            for side, spans in ranges.items():
                for a, b in spans:
                    print(f'stop: reading {side} {a:.0f}-{b:.0f} s the reader left unread', flush=True)
                    live.read_range(folder, side, a, b, engine=engine, cut=cut); covered.setdefault(side, []).append([a, b])
        except (Exception, SystemExit) as error: whole = f'{side} {a:.0f}-{b:.0f} s could not be read: {error}'
    lap('fallback')
    if whole is not None:
        print(f'stop: the live words cannot be used ({whole}), reading the whole call', flush=True)
        return stop_batch(folder, event, t0, reason=whole, later=later, **deps)
    tracks, version = live.build_tracks(folder)
    for side, pad in align(folder).items():   # the live words are on each CAF's own clock: the late side moves as its wav does (2026-10-28)
        if pad: tracks[side] = live.ne.lines_of([{**w, 'start': round(w['start'] + pad, 2), 'end': round(w['end'] + pad, 2)} for l in tracks[side] for w in l['words']])
    lap('build')
    if covered:
        version['live_fallback'] = {'whole_call': False, 'ranges': covered}
        print(f'stop: read {sum(b - a for spans in covered.values() for a, b in spans):.0f} s the live reader left unread; noted in version.json', flush=True)
    seconds = live.call_seconds(folder)
    finish(folder, event, tracks, folder, version, with_notes=False, seconds=seconds); lap('finish')
    prepare(folder, event); lap('screen')
    timings['ready'] = round(now() - t0, 2)
    version['timings_s'] = {**version['timings_s'], **timings}
    (folder / 'version.json').write_text(json.dumps(version, indent=1))
    print(f"stop: ready for the question in {timings['ready']:.1f} s", flush=True)
    if later is not None: later.append(lambda: check_pass(folder, event, version, **deps)); return 0
    return check_pass(folder, event, version, **deps)

def check_pass(folder, event, v1, **deps):
    # After the question is out: the whole batch reading into v2-check (both readers, label pass, gap check), then the
    # guard (live.live_check, F7) writes live-check.json. v1's transcript.md and outbound.md are never written here.
    import live, transcript
    now = deps.get('now', time.time); timings = {}; t = began = now(); v2 = None
    try:
        convert_wavs(folder); timings['convert'] = round(now() - t, 1); t = now()
        v2 = transcript.new_version(folder, 'check')
        tracks, version = transcribe(folder, event, v2, v2.name); timings['read'] = round(now() - t, 1)
        finish(folder, event, tracks, v2, version, with_notes=False)
        result = live.live_check(folder, v2=v2)
    except (Exception, SystemExit) as error:
        result = {'pass': False, 'error': str(error), 'at': datetime.now().astimezone().isoformat(timespec='seconds')}
        (folder / 'live-check.json').write_text(json.dumps(result, indent=1))
        print(f'LIVE CHECK DID NOT RUN: {error}. The transcript above is the live reading, unchecked.', flush=True)
        return 1
    result['check_s'] = {**timings, 'total': round(now() - began, 1)}
    (folder / 'live-check.json').write_text(json.dumps(result, indent=1))
    ag, wr = result['agreement'], result['words_ratio']
    print(f"live check: {'pass' if result['pass'] else 'FAILED'}, word agreement {' '.join(f'{s} {a:.3f}' for s, a in ag.items())}, words kept {' '.join(f'{s} {wr[s]}' for s in ag)}, gap check {result['gap_check']}, in {result['check_s']['total']} s", flush=True)
    if not result['pass']: print(f'LIVE CHECK FAILED: the live transcript is worse than the full reading on this call (limits in live-check.json). The full reading is in {v2}.', flush=True)
    gap_report(version)
    return 0 if result['pass'] else 1

def read_first(folder, out):
    # Parakeet on both tracks, in minute-long pieces: the first reader, and all the question needs (stop_batch). Its json
    # lands in `out`. Returns {'words': {side: words}, 'runs', 'timings_s'} for transcribe(first=...).
    import nvidia_engine
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    first = {'words': {}, 'runs': {}, 'timings_s': {}}
    for side in sides_in(folder):   # one side of a split: the other track is another meeting, never read here
        t0 = time.time(); words, run = nvidia_engine.parakeet(folder / f'{side}.wav', out / f'{side}-parakeet.json'); seconds = round(time.time() - t0, 1)
        first['words'][side], first['runs'][f'{side}_parakeet'], first['timings_s'][f'{side}_parakeet'] = words, run, seconds
        print(f"{side}: Parakeet {len(words)} words in {seconds}s, {run['pieces']} pieces, peak {run['peak_gb']} GB")
    return first

def transcribe(folder, event, out, version, first=None):
    # Both tracks through the NVIDIA engine (nvidia_engine.py): Parakeet reads each track in minute-long pieces (read_first,
    # or `first` when it already ran), Nemotron reads it whole, a stretch Parakeet left empty is filled from Nemotron,
    # every name or number the two heard differently is marked, and the gap check looks for sound with no words.
    # Everything lands in `out` (the call folder for a new call, a version subfolder for a redo); the wavs are read only.
    # One GPU: the model runs go one at a time.
    import nvidia_engine, transcript
    load = [round(x, 1) for x in os.getloadavg()]   # timings mean little without it: another session loaded this Mac to 18 on 2026-10-06
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    first = first or read_first(folder, out)
    tracks, runs, agreement, fills, gaps, timings, peak, read = {}, dict(first['runs']), {}, {}, {}, dict(first['timings_s']), 0.0, {}
    own = transcript.sides_of(event)
    for side in own:
        wav = folder / f'{side}.wav'; words = [dict(w) for w in first['words'][side]]
        t0 = time.time(); other, runs[f'{side}_nemotron'] = nvidia_engine.nemotron(wav, out / f'{side}-nemotron.json'); timings[f'{side}_nemotron'] = round(time.time() - t0, 1)
        print(f"{side}: Nemotron {len(other)} words in {timings[f'{side}_nemotron']}s, peak {runs[f'{side}_nemotron']['peak_gb']} GB")
        peak = max(peak, runs[f'{side}_parakeet']['peak_gb'], runs[f'{side}_nemotron']['peak_gb'])
        words, fills[side] = nvidia_engine.fill(words, other)
        read[side] = (words, other)
    # Marks after both tracks are read: a word both readers agreed on 3+ times anywhere in the call is established, and
    # the meeting's written name list (lexicon.json) is not in doubt (cycle 3, proposal-c.md).
    established, lexicon = nvidia_engine.confirmed(read.values()), nvidia_engine.lexicon_keys(folder)
    names, suggested = nvidia_engine.boost_names(folder), {}
    for side in own:
        wav = folder / f'{side}.wav'; words, other = read[side]
        words, agreement[side] = nvidia_engine.agree(words, other, transcript.markable, established=established, lexicon=lexicon)
        words, clues = nvidia_engine.capital_clue(words, established, lexicon); agreement[side]['capital_clue'] = clues; agreement[side]['marked'] += len(clues)
        if names:   # a third reading, boosted with the meeting's people, that may only add "likely <name>" labels; never for the user's own name alone
            t0 = time.time(); boosted, runs[f'{side}_nemotron_boosted'] = nvidia_engine.nemotron(wav, out / f'{side}-nemotron-boosted.json', phrases=names)
            timings[f'{side}_nemotron_boosted'] = round(time.time() - t0, 1)
            words, suggested[side] = nvidia_engine.suggest(words, boosted, names, transcript.markable, lexicon)
        gaps[side] = nvidia_engine.gap_check(wav, words)
        tracks[side] = nvidia_engine.lines_of(words)
        print(f"{side}: {len(tracks[side])} lines, {agreement[side]['marked']} words marked (unclear) of {agreement[side]['differ']} the readers differ on"
              + (f", {len(fills[side])} stretch(es) filled from Nemotron ({sum(f['words'] for f in fills[side])} words)" if fills[side] else ''))
        print(nvidia_engine.gap_banner(side, gaps[side]))
    info = {'version': version, 'created': datetime.now().astimezone().isoformat(timespec='seconds'), 'engine': 'nvidia', 'runtime': nvidia_engine.version(),
            'model': nvidia_engine.PARAKEET.name, 'second_reader': nvidia_engine.NEMOTRON.name, 'mark_rule': transcript.NVIDIA_RULE,
            'chunk_s': nvidia_engine.CHUNK_S, 'echo_s': nvidia_engine.ECHO_S, 'echo_share': nvidia_engine.ECHO_SHARE, 'fill_s': nvidia_engine.FILL_S,
            'prompt': '', 'prompt_tokens': 0, 'terms': sorted(lexicon), 'established_min': nvidia_engine.ESTABLISHED, 'threshold': transcript.THRESHOLD,
            'boost': nvidia_engine.BOOST if names else None, 'boosted_names': names, 'suggested': suggested, 'timings_s': timings, 'peak_gb': peak, 'load_avg_at_start': load, 'runs': runs, 'agreement': agreement, 'filled': fills,
            'gap_check': 'FAILED' if any(g['gaps'] for g in gaps.values()) else 'clean', 'gaps': gaps}
    (out / 'version.json').write_text(json.dumps(info, indent=1))
    return tracks, info

def gap_report(version):
    # The last thing printed at stop or redo: a gap is the falsifier (proposal-b.md), it must not scroll away.
    import nvidia_engine, transcript
    for side, g in version.get('gaps', {}).items():
        if g['gaps']: print(nvidia_engine.gap_banner(side, g))
    for side, fills in version.get('filled', {}).items():
        for f in fills: print(f"filled from Nemotron on {side}: [{transcript.stamp(f['from'])}] to [{transcript.stamp(f['to'])}], {f['words']} words: {f['text'][:120]}")

def finish(folder, event, tracks, out, version, with_notes=True, seconds=None):
    import transcript
    event = derive(event)
    own = transcript.sides_of(event)
    lines, echoes = merge_sides(tracks, own)
    # Names written with "&" in the call's title or mail (M&T) put back over their spoken forms ("MNT"), before any
    # transcript is written, so the notes model reads the user's spelling (nvidia_engine.respell, 2026-10-09).
    import nvidia_engine
    import lexicon
    terms, respelled, heard = nvidia_engine.amp_terms(folder), 0, lexicon.heard_as()
    for l in lines:
        if l.get('words'): l['words'], k = nvidia_engine.respell_words(l['words'], terms, transcript.THRESHOLD, heard); respelled += k
        l['text'] = nvidia_engine.respell_heard(nvidia_engine.respell(l['text'], terms)[0], heard)[0]
    # Then every line its own check: a word that sounds like one of the user's own words is marked (unclear), never
    # changed, so the name check can offer the spelling (bubble_check.py).
    import bubble_check, spelling
    kept = set((spelling.read_json(Path(folder) / 'name-checks.json', {}) or {}).get('kept') or {})
    if not bubble_check.dictionary(): print(f'no line check: {bubble_check.WORDS} is missing')
    lines, near = bubble_check.check(lines, bubble_check.terms(folder, event, kept), kept)
    if near:
        print(f"line check: marked {len(near)} word(s) that sound like your own: {', '.join(sorted({m['word'] + ' ~ ' + m['near'] for m in near}))}")
        if (out / 'version.json').exists():
            info = json.loads((out / 'version.json').read_text()); info['line_check'] = {'count': len(near), 'words': near}
            (out / 'version.json').write_text(json.dumps(info, indent=1))
    if respelled:
        print(f"respelled {respelled} spoken form(s) of {', '.join(list(terms) + list(heard))}")
        if (out / 'version.json').exists():
            info = json.loads((out / 'version.json').read_text()); info['respelled'] = {'terms': terms, 'count': respelled}
            (out / 'version.json').write_text(json.dumps(info, indent=1))
    import them   # who Them was, by code, before any label is written; event.json only for the call itself (2026-10-27)
    event = them.settle(folder, event, lines, write=out == folder)
    other = event.get('them_label', 'Them')
    stamp = transcript.stamp
    who = lambda l: l['who'] if l['who'] in ('Me', 'Room') else other
    (out / 'transcript-timed.txt').write_text('\n'.join(f"[{stamp(l['t'])}] {who(l)}: {l['text']}" for l in lines) + '\n')
    plain = '\n'.join(f"{who(l)}: {l['text']}" for l in lines)
    (out / 'transcript.txt').write_text(plain + '\n')
    # The readable one: a header, one paragraph per turn, (unclear) after a weak name or number.
    filled = sum(f['words'] for fs in version.get('filled', {}).values() for f in fs)
    note = (f"{filled} words in {sum(len(fs) for fs in version.get('filled', {}).values())} stretch(es) Parakeet skipped come from Nemotron's reading." if filled else '')
    md = transcript.header(event, folder, seconds if seconds is not None else transcript.duration(folder / f"{own[-1]}.wav"), version['version'], model=version.get('model', ''), rule=version.get('mark_rule', transcript.NVIDIA_RULE), note=note) \
        + '\n' + transcript.markdown(lines, who)
    (out / 'transcript.md').write_text(md)
    found = transcript.marks(lines)
    print(f'transcript: {len(lines)} lines, {echoes} echo lines dropped, {len(found)} words marked (unclear)')
    if not with_notes: return lines
    # The entry: the call summary is written in the cloud, but nothing leaves the Mac until the user picks an AI and
    # presses Send (spec-entry-b.md A7). So the call is only PREPARED here: screened on the Mac and recorded as a
    # pending send (sendgate.py); byo.py runs from Loggie's send gate, with the approval, and the filing follows it.
    # The screen is code and word lists (privacy.py). A screen that cannot run keeps the transcript and says what to
    # run; it never crashes the call.
    prepare(out, event)
    return lines

def prepare(out, event):
    # The send, prepared and not sent: one line says where to review what would leave and how to approve it.
    import sendgate
    try: send = sendgate.prepare_call(SETTINGS.parent, out, event)
    except SystemExit as error:
        why = error.code if isinstance(error.code, str) else 'the screen did not run'
        print(f'call notes not prepared ({why}); the transcript is kept. Nothing has left your Mac. Screen it again with: python3 {HERE / "call.py"} prepare "{out}"')
        return None
    print(f"Nothing has left your Mac: {send['sentences_sent']} sentences are ready to send, {send['sentences_kept']} kept here. Review what would leave in {send['outbound'][0]}, "
          f"then press Send in Loggie, or run: node {LOGGIE / 'bin' / 'loggie.js'} send {send['run']} --with nebius")
    return send

def check(record=True):
    # Run before a real call. Each line is a thing that would otherwise fail after the call, when it is too late.
    ok = lambda good, what, fix='': print(('ok    ' if good else 'FAIL  ') + what + ('' if good else f'  -> {fix}')) or good
    import nvidia_engine
    runtime = nvidia_engine.version() if nvidia_engine.NSC.exists() else ''
    results = [
        ok(nvidia_engine.NSC.exists() and runtime.startswith('nemo-speech'), f'NVIDIA speech runtime ({runtime or "not found"})', f'unpack NeMo-Speech.cpp at {nvidia_engine.NSC}'),
        ok(nvidia_engine.PARAKEET.exists(), f'words model Parakeet ({nvidia_engine.PARAKEET.name})', f'nemo-speech pull parakeet-tdt into {nvidia_engine.MODELS}'),
        ok(nvidia_engine.NEMOTRON.exists(), f'second reader Nemotron ({nvidia_engine.NEMOTRON.name})', f'nemo-speech pull nemotron-3.5 into {nvidia_engine.MODELS}'),
        ok((HERE / 'recorder').exists(), 'recorder', 'build recorder.swift'),
        ok(tools.FFMPEG != 'ffmpeg' and Path(tools.FFMPEG).exists() or shutil.which('ffmpeg') is not None, f'ffmpeg ({tools.FFMPEG})', 'install ffmpeg, or set HIKYAKU_FFMPEG to one'),
        ok(not STATE.exists(), 'nothing already recording', f'run call.py stop, or delete {STATE}'),
    ]
    try:
        # the runtime on the GPU, end to end, on a second of silence: a missing Metal device or a broken model file fails here, not after the call
        import tempfile, wave
        with tempfile.TemporaryDirectory() as d:
            silent = Path(d) / 'silent.wav'
            with wave.open(str(silent), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000)
            t0 = time.time(); words, run = nvidia_engine.run(nvidia_engine.PARAKEET, silent)
        results.append(ok(not words, f'Parakeet runs on Metal and invents nothing on silence ({round(time.time() - t0, 1)}s)', f'it wrote {words[:3]}'))
    except SystemExit as error:
        results.append(ok(False, 'Parakeet runs on Metal', str(error)[:300]))
    try:
        sample = derive({'title': 'Check - Coffee Chat', 'start': '2026-01-01T15:00:00Z', 'emails': ['sam@example.com'], 'names': 'Sam Lee', 'attendees': 'Sam Lee'})
        results.append(ok(True, f"a calendar event files ({sample['category']}, me = {sample['me']})"))
    except Exception as error:
        results.append(ok(False, 'a calendar event files', f'{type(error).__name__}: {error}'))
    if not record:
        print('skip  the 3 s test recording (--no-recording)')
        print('READY (without the recording test)' if all(results) else 'NOT READY')
        return all(results)
    folder = Path('/tmp') / f'hk-check-{os.getpid()}'; folder.mkdir()
    proc = subprocess.Popen([str(HERE / 'recorder'), str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(4); os.killpg(proc.pid, signal.SIGINT); time.sleep(2)
    for side, fix in (('me', 'allow Microphone for the app running this'), ('them', 'allow Screen & System Audio Recording for the app running this')):
        caf = folder / f'{side}.caf'
        results.append(ok(caf.exists() and caf.stat().st_size > 4096, f'records the {side} side', fix))
    print('READY' if all(results) else 'NOT READY')
    return all(results)

def previous_version(folder):
    # The version the ear check compares against: the newest vN-* folder with a transcript, else the call folder (v1).
    versions = sorted((d for d in folder.iterdir() if d.is_dir() and re.match(r'v(\d+)-', d.name) and (d / 'transcript-timed.txt').exists()),
                      key=lambda d: int(re.match(r'v(\d+)-', d.name).group(1)))
    return versions[-1] if versions else folder

def redo(folder, materials=None, against=None):
    # The transcript again on an existing recording, into a new version subfolder (v3-nvidia, ...). The call folder's
    # own files (v1) and the raw audio are never written. No notes model: the transcript is the product being
    # measured. ear-check.md compares against `against` (default: the previous version).
    import nvidia_engine, transcript
    folder = Path(folder).resolve()
    if not (folder / 'event.json').exists(): sys.exit(f'not a call folder: {folder}')
    for side in sides_in(folder):
        if not (folder / f'{side}.wav').exists(): sys.exit(f'missing {side}.wav in {folder}; redo reads the wavs the call left behind')
    event = json.loads((folder / 'event.json').read_text())
    if materials: event['materials'] = materials
    previous = Path(against).resolve() if against else previous_version(folder)
    out = transcript.new_version(folder, 'nvidia')
    t0 = time.time()
    tracks, version = transcribe(folder, event, out, out.name)
    lines = finish(folder, event, tracks, out, version, with_notes=False)
    n = nvidia_engine.ear_check(lines, previous / 'transcript-timed.txt', folder, out, transcript.markable, previous_name=previous.name if previous != folder else 'v1')
    version['ear_check_against'] = previous.name if previous != folder else 'v1'
    version['timings_s']['total'] = round(time.time() - t0, 1)
    (out / 'version.json').write_text(json.dumps(version, indent=1))
    print(f"{out.name} in {version['timings_s']['total']}s: {out / 'transcript.md'}; {n} moments to hear in {out / 'ear-check.md'}")
    gap_report(version)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'start' and sys.argv[2:3] == ['--calendar']:
        start(*from_calendar(sys.argv[4] if sys.argv[3:4] == ['--at'] else None))
    elif cmd == 'start': start(*start_args(sys.argv[2:]))
    elif cmd == 'stop':
        if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(line_buffering=True)   # stop.log fills as stop goes, not at its end
        sys.exit(stop())
    elif cmd in ('pause', 'resume'): pause(resume=cmd == 'resume')
    elif cmd == 'live':
        if len(sys.argv) < 3: sys.exit('usage: call.py live <call-folder>')
        sys.exit(live_command(Path(sys.argv[2]).resolve()))
    elif cmd == 'check': sys.exit(0 if check(record='--no-recording' not in sys.argv) else 1)
    elif cmd == 'redo':
        a = sys.argv[2:]
        redo(a[0], a[a.index('--materials') + 1] if '--materials' in a else None, a[a.index('--against') + 1] if '--against' in a else None)
    elif cmd == 'prepare':
        # The send prepared by hand (sendgate.py): screen on this Mac, record the pending send, send nothing.
        import summary
        if len(sys.argv) < 3: sys.exit('usage: call.py prepare <version-folder>')
        sys.exit(0 if prepare(Path(sys.argv[2]).resolve(), derive(summary.event_of(Path(sys.argv[2]).resolve()))) else 1)
    else: sys.exit('usage: call.py start|live|stop|pause|resume|check|redo|prepare')
