# One recording, two meetings (split-recording-proposal.md, 2026-10-28): the room's mic is one call, the Mac's sound the
# other. Fail-first plan a and b, and the start that makes the two folders. Deterministic: made-up word lists ONE and
# TWO, a fake engine, a fake ffmpeg, the code screen on temp folders, a fake recorder, no network, no real sleep.
#   python3 test_split.py   (exit 0 = pass)
import contextlib, io, json, os, re, tempfile, wave
from pathlib import Path
import numpy as np
import call, live, privacy, them
import nvidia_engine as ne
import fixtures
from fixtures import W, RUN, patched, speech, write_caf

ONE = 'apricot basalt cinder dovetail ember fjord gravel heron indigo juniper kelp lantern'.split()   # said in the room
TWO = 'quartz rafter saffron tundra umber vellum wicker yarrow zephyr bramble cobalt dune'.split()     # on the Mac's sound
CLASS = {'title': 'ZZZ 9999-001 Made-up Seminar', 'start': '2026-10-29T15:40:00Z', 'location': 'Hall 223', 'emails': [], 'names': '', 'attendees': '', 'me': 'Gio'}
KICKOFF = {'title': 'Made-up Case Kickoff', 'start': '2026-10-29T15:30:00Z', 'emails': [], 'names': '', 'attendees': '', 'me': 'Gio'}
SECONDS = 20.0

def home_in(d):
    root = Path(d); (root / 'calls').mkdir()
    (root / 'settings.json').write_text(json.dumps({'frontier': 'nebius'}))
    return root

def settings_of(root):
    return dict(HOME=root / 'calls', STATE=root / 'calls' / 'current.json', SETTINGS=root / 'settings.json', PROFILE=root / 'profile.md', WORKSTREAMS=root / 'workstreams.json')

def split_folders(root):
    # What start leaves: B (the class) holds the recorder's two files, A (the kickoff) them.caf as a hard link to B's.
    b, a = root / 'calls' / '2026-10-29-1140-zzz-9999-001-made-up-seminar', root / 'calls' / '2026-10-29-1140-made-up-case-kickoff'
    b.mkdir(); a.mkdir()
    (b / 'event.json').write_text(json.dumps(call.derive({**CLASS, 'sides': ['me'], 'split': {'with': a.name}})))
    (a / 'event.json').write_text(json.dumps(call.derive({**KICKOFF, 'sides': ['them'], 'split': {'with': b.name}})))
    for side in ('me', 'them'): write_caf(b / f'{side}.caf', np.zeros(int(SECONDS * 48000), np.float32))   # on disk whole; the fake cut holds the sound
    os.link(b / 'them.caf', a / 'them.caf')
    for f in (b, a): (f / 'live').mkdir()
    return b, a

SIGNAL = {'me': speech(SECONDS), 'them': speech(SECONDS)}

def cut(ffmpeg, caf, from_s, length, wav):
    x = SIGNAL[Path(caf).stem][int(from_s * 16000):int((from_s + length) * 16000)]
    with wave.open(str(wav), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((x * 32767).astype(np.int16).tobytes())

def engine(model, wav, *a, **kw):
    # the room's mic says list ONE, the Mac's sound list TWO, whichever folder reads them
    words = ONE if Path(wav).name.startswith('me-') else TWO
    return W(' '.join(w.capitalize() if i % 6 == 0 else w + ('.' if i % 6 == 5 else '') for i, w in enumerate(words)), 1.0), RUN

def read_live(folder):
    clock = [1000.0]
    def sleep(s): clock[0] += s
    return live.run(folder, engine=engine, cut=cut, sleep=sleep, now=lambda: clock[0], lexicon=lambda f: [], recorder_alive=lambda: False)

def fake_convert(folder):
    for side in live.live_sides(folder)[0]:
        with wave.open(str(Path(folder) / f'{side}.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000)

def fake_transcribe(log):
    # the check pass's batch reading, from the live words of whatever sides the folder reads
    def transcribe(folder, event, target, version, *a, **kw):
        log.append(('check', Path(folder).name)); target = Path(target); target.mkdir(parents=True, exist_ok=True)
        sides, _, _ = live.live_sides(folder)
        for side, (words, _) in sides.items():
            for reader in ('parakeet', 'nemotron'):
                (target / f'{side}-{reader}.json').write_text(json.dumps({'words': [{'word': w['text'].strip(), 'start': w['start'], 'end': w['end']} for w in words]}))
        tracks, info = live.build_tracks(folder)
        info = {**info, 'version': version, 'live': False, 'gap_check': 'clean', 'gaps': {}}
        (target / 'version.json').write_text(json.dumps(info))
        return tracks, info
    return transcribe

def turns(folder, name='transcript.md'):
    return re.findall(r'^\[\d\d:\d\d\] ([^:]+): (.*)$', (Path(folder) / name).read_text(), re.M)

def words_in(text): return {w.strip('.,').lower() for w in text.split()}

def no_engine(*a, **kw): raise AssertionError('a test reached the real speech engine')

def spy_on_detect():
    seen, real = [], them.detect
    def detect(lines, *a, **kw): seen.append([l['who'] for l in lines]); return real(lines, *a, **kw)
    return seen, detect

# ---------- a: two folders, each its own side, from the reader to the prepared send ----------

def test_a_each_folder_reads_transcribes_screens_and_sends_only_its_own_side():
    with tempfile.TemporaryDirectory() as d:
        root = home_in(d); b, a = split_folders(root)
        with patched(live.ne, run=no_engine), contextlib.redirect_stdout(io.StringIO()):
            assert read_live(b) == 0 and read_live(a) == 0
        for folder, mine, other, label in ((b, ONE, TWO, 'Room'), (a, TWO, ONE, 'Them')):
            live_turns = turns(folder / 'live', 'transcript-live.md')
            said = words_in(' '.join(t for _, t in live_turns))
            assert live_turns and {w for w, _ in live_turns} == {label} and said & set(mine) and not said & set(other), (folder.name, live_turns)
        (root / 'calls' / 'current.json').write_text(json.dumps({'pid': 7777, 'dir': str(b), 'started': 0, 'live_pid': None, 'also': str(a), 'also_live_pid': None}))
        log, out, seen, detect = [], io.StringIO(), *spy_on_detect()
        real_prepare = call.prepare
        def prepare(folder, event): log.append(('prepare', Path(folder).name)); return real_prepare(folder, event)
        def gone(pid, sig=0): raise ProcessLookupError
        with patched(call, **settings_of(root), convert_wavs=fake_convert, transcribe=fake_transcribe(log), prepare=prepare), patched(them, detect=detect), \
             patched(live.ne, run=no_engine), contextlib.redirect_stdout(out):
            code = call.stop(started=0, kill=lambda pid, sig: None, probe=gone)
        printed = out.getvalue()
        assert code in (0, None), printed[-2000:]
        assert not (root / 'calls' / 'current.json').exists()
        for folder, mine, other, label in ((b, ONE, TWO, 'Room'), (a, TWO, ONE, 'Them')):
            said = turns(folder)
            text = words_in(' '.join(t for _, t in said))
            assert said and {w for w, _ in said} == {label}, (folder.name, said)
            assert text & set(mine) and not text & set(other), (folder.name, text)
            assert not list((folder / 'v2-check').glob(f"{'them' if label == 'Room' else 'me'}-*.json")), 'the check pass read the other side'
        assert 'Recorded in the room' in (b / 'transcript.md').read_text() and 'Me (' not in (b / 'transcript.md').read_text()
        assert "the Mac's sound" in (a / 'transcript.md').read_text()
        assert re.findall(r'transcript: \d+ lines, (\d+) echo lines dropped', printed) == ['0', '0', '0', '0'], printed   # two folders, the fast path and the check pass
        held_b, held_a = (json.loads(privacy.latest_pair(f)[1].read_text()) for f in (b, a))
        assert isinstance(held_b.get('names'), dict) and 'names' not in held_a, (held_b.keys(), held_a.keys())
        sends = [json.loads(p.read_text()) for p in sorted((root / 'runs').glob('*/send.json'))]
        assert sorted(s['folder'] for s in sends) == sorted([str(b.resolve()), str(a.resolve())]) and all(s['status'] == 'pending' for s in sends), sends
        assert log == [('prepare', b.name), ('prepare', a.name), ('check', b.name), ('check', a.name)], log   # both questions before either check pass
        assert all('Room' not in who for who in seen), seen

# ---------- b: Them naming never reads the room, and only runs when the meeting has an invitee ----------

def line_of(text, t0): return ne.lines_of(W(text, t0))

def finish_in(root, name, event, tracks):
    folder = root / 'calls' / name; folder.mkdir()
    (folder / 'event.json').write_text(json.dumps(event))
    (folder / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Marcus Bell', 'source': 'mail', 'count': 2}]}))
    with patched(call, **settings_of(root)), contextlib.redirect_stdout(io.StringIO()): call.finish(folder, event, tracks, folder, {'version': 'v1'}, with_notes=False, seconds=60)
    return folder

def test_b_them_settle_never_sees_a_room_line_and_needs_an_invitee():
    interview = {'title': 'Interview with Northwind', 'me': 'Gio', 'names': 'Marcus Bell', 'emails': ['marcus@northwind.example'], 'category': 'one-on-one'}
    room = line_of('So Marcus, how do you think about the first year?', 1.0) + line_of('Thanks, Marcus.', 20.0)
    mac = line_of("Hi, I'm Marcus from Northwind.", 8.0)
    with tempfile.TemporaryDirectory() as d:
        root = home_in(d); seen, detect = spy_on_detect()
        with patched(them, detect=detect):
            # an in-person interview on the mic alone: every line Room, nobody named from it
            f = finish_in(root, '2026-10-29-1000-room', {**interview, 'sides': ['me']}, {'me': room, 'them': mac})
            assert seen == [] and {w for w, _ in turns(f)} == {'Room'} and 'them_label' not in json.loads((f / 'event.json').read_text()), (seen, turns(f))
            # the Mac's sound of a call with one invitee: named, from Them lines only, the room never read
            f = finish_in(root, '2026-10-29-1001-mac', {**interview, 'sides': ['them']}, {'me': room, 'them': mac})
            assert seen == [['Them']] and json.loads((f / 'event.json').read_text())['them_label'] == 'Marcus Bell', seen
            assert {w for w, _ in turns(f)} == {'Marcus Bell'}
            # an ordinary call with nobody on the invite stays Them (Gio, 2026-10-28): one "I'm X" no longer names a group Zoom
            f = finish_in(root, '2026-10-29-1002-zoom', {'title': 'Zoom call', 'me': 'Gio', 'names': '', 'emails': []}, {'me': room, 'them': mac})
            assert len(seen) == 1 and {w for w, _ in turns(f)} == {'Me', 'Them'} and 'Me (Gio) and Them.' in (f / 'transcript.md').read_text(), seen
        assert all('Room' not in who for who in seen), seen

def test_room_is_a_recording_label_in_the_notes_never_a_person():
    import byo, summary
    assert byo.LABEL.search('Room') and byo.LABEL.search('Room said the case is due Friday'), 'an owner "Room" becomes Team'
    assert not byo.LABEL.search('Book a room for Friday') and not byo.LABEL.search('Room 223 moved to Hall B'), 'a room is a place'
    assert 'Room' in privacy.NEVER, 'never a classmate'
    lines = [{'t': 0, 'who': 'Room', 'text': 'Welcome back.'}]
    assert byo.shown(lines, summary.names_for({'title': 'ZZZ 9999 Seminar', 'me': 'Gio'})) == '[00:00] Room: Welcome back.', 'the professor is not Gio'

# ---------- start --also: one recorder, two folders ----------

class Recorder:
    # subprocess.Popen as start sees it: the recorder makes its two files at once, the live readers do nothing
    def __init__(self): self.spawned, self.pid = [], 500
    def __call__(self, args, **kw):
        self.spawned.append([str(x) for x in args]); self.pid += 1
        if Path(args[0]).name == 'recorder':
            for side in ('me', 'them'): (Path(args[1]) / f'{side}.caf').write_bytes(b'caff')
        proc = type('Proc', (), {'pid': self.pid, 'poll': lambda self: None})()
        return proc

def started(root, argv):
    rec = Recorder()
    with patched(call, **settings_of(root)), patched(call.subprocess, Popen=rec), patched(call.time, sleep=lambda s: None), contextlib.redirect_stdout(io.StringIO()):
        call.start(*call.start_args(argv))
    return rec, json.loads((root / 'calls' / 'current.json').read_text())

def test_start_also_makes_two_folders_one_recorder_a_hard_link_and_two_readers():
    with tempfile.TemporaryDirectory() as d:
        root = home_in(d)
        # the caller put the kickoff first: the class (a course code and a room, no join link) still takes the mic
        rec, state = started(root, [KICKOFF['title'], json.dumps(KICKOFF), '--also', json.dumps(CLASS)])
        b, a = Path(state['dir']), Path(state['also'])
        eb, ea = (json.loads((f / 'event.json').read_text()) for f in (b, a))
        assert eb['title'] == CLASS['title'] and eb['sides'] == ['me'] and eb['category'] == 'class' and eb['split'] == {'with': a.name}, eb
        assert ea['title'] == KICKOFF['title'] and ea['sides'] == ['them'] and ea['split'] == {'with': b.name} and ea['recorded_at'] == eb['recorded_at'], ea
        assert os.stat(a / 'them.caf').st_ino == os.stat(b / 'them.caf').st_ino and not (a / 'me.caf').exists()
        recorders = [s for s in rec.spawned if Path(s[0]).name == 'recorder']; readers = [s for s in rec.spawned if s[1:3] == [str(call.HERE / 'call.py'), 'live']]
        assert recorders == [[str(call.HERE / 'recorder'), str(b), '--mic', 'builtin']], rec.spawned
        assert [r[3] for r in readers] == [str(b), str(a)] and (a / 'live').is_dir() and (b / 'live').is_dir(), readers
        assert set(state) == {'pid', 'dir', 'started', 'live_pid', 'also', 'also_live_pid'} and state['live_pid'] != state['also_live_pid'], state
    with tempfile.TemporaryDirectory() as d:
        # a tie (neither is in a room): the caller's order stands
        rec, state = started(home_in(d), ['Chat A', json.dumps({'title': 'Chat A'}), '--also', json.dumps({'title': 'Chat B'})])
        assert json.loads((Path(state['dir']) / 'event.json').read_text())['title'] == 'Chat A'
        assert json.loads((Path(state['also']) / 'event.json').read_text())['title'] == 'Chat B'

def test_a_lone_class_gets_the_built_in_mic_and_a_lone_call_does_not():
    with tempfile.TemporaryDirectory() as d:
        rec, state = started(home_in(d), [CLASS['title'], json.dumps(CLASS)])
        assert [s for s in rec.spawned if Path(s[0]).name == 'recorder'][0][2:] == ['--mic', 'builtin'] and 'also' not in state, rec.spawned
        assert 'sides' not in json.loads((Path(state['dir']) / 'event.json').read_text()), 'a lone recording keeps both sides'
    with tempfile.TemporaryDirectory() as d:
        rec, _ = started(home_in(d), ['Coffee chat', '{}'])
        assert [s for s in rec.spawned if Path(s[0]).name == 'recorder'][0][2:] == [], rec.spawned

if __name__ == '__main__':
    fixtures.run(globals())
