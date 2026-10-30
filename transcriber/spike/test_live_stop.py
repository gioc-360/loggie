# Stop with a live reader (increment L3 of spec-live-transcription.md, B23 and B25): stop asks the reader for the tail,
# builds the transcript from the live words, screens it and prepares the send, says the question can be asked, and only
# then reads the whole recording into v2-check and writes live-check.json (the F7 guard). A reader that left nothing
# usable sends stop back to today's path. Deterministic: a hand-built live folder (one hour, 2 sides x 120 pieces of
# made-up words), a fake recorder (os.kill), a fake reader thread that writes done.json when it sees live/stop, a fake
# engine, a fake ffmpeg, a fake screen, no network, temp folders only, no real sleep except the 0.1 s poll.
#   python3 test_live_stop.py   (exit 0 = pass)
import contextlib, hashlib, io, json, signal, sys, tempfile, threading, time, wave
from pathlib import Path
import numpy as np
import call, live, privacy, transcript
import fixtures
from fixtures import sam as entry

VOCAB = 'river window orchard paper ladder copper harbor lemon signal marble garden ticket planet anchor velvet candle meadow bridge pocket saddle'.split()
SENTENCES = 6   # per piece, 10 words each: 30 s of talk

def made_up_words(side, piece, a, b):
    # one piece of made-up words at 2 words a second on the call's clock; Them and Me use different words so no echo is dropped
    offset = 0 if side == 'me' else 7
    words = []
    for i in range(int((b - a) * 2)):
        text = VOCAB[(piece * 3 + i + offset) % len(VOCAB)]
        if i % 20 == 0: text = text.capitalize()
        if i % 20 == 19: text += '.'
        words.append({'text': ' ' + text, 'start': round(a + i * 0.5, 2), 'end': round(a + i * 0.5 + 0.3, 2), 'p': 1.0})
    return words

def hour_folder(root, pieces=120, done=False, speech_tail=True):
    # 2 sides x `pieces` pieces of 30 s (the last one is the tail), the reader's state.json, the recorder's two files as stubs
    calls = Path(root) / 'calls'; calls.mkdir()
    folder = calls / '2026-10-05-1400-coffee-chat-with-sam-lee'; folder.mkdir()
    (folder / 'event.json').write_text(json.dumps(entry.EVENT))
    (folder / 'live').mkdir()
    sides = {}
    for side in ('me', 'them'):
        for n in range(pieces):
            a, b = n * 30.0, (n + 1) * 30.0
            fixtures.put(folder, f'{side}-words.jsonl', [{'piece': n, 'from': a, 'to': b, 'reason': 'pause', 'words': made_up_words(side, n, a, b), 'engine_s': 0.6, 'peak_gb': 1.4, 'at': 'T'}])
        sides[side] = {'heard_s': pieces * 30.0, 'read_s': pieces * 30.0, 'pieces': pieces, 'engine_s': 72.0, 'peak_gb': 1.4, 'skipped_silent': 0, 'errors': 0, 'failed': []}
        (folder / f'{side}.caf').write_bytes(b'caff')   # the recorder's file exists; the live words are what stop reads
    state = {'pid': 1, 'started': 'T', 'sides': sides, 'behind_s': 0.0, 'lexicon': 'written', 'updated': 'T'}
    (folder / 'live' / 'state.json').write_text(json.dumps(state))
    return folder

def tail_record(side, speech, engine_s=0.5):
    return {'from_s': 3570.0, 'to_s': 3600.0, 'words': 60 if speech else 0, 'engine_s': engine_s if speech else 0.0, 'skipped': not speech}

class Reader(threading.Thread):
    # The live reader as stop sees it: waits for live/stop, then (reading the tail through the engine when it has speech)
    # writes done.json. `log` is the shared order of events.
    def __init__(self, folder, log, speech=True, engine=None):
        super().__init__(daemon=True); self.folder, self.log, self.speech, self.engine = folder, log, speech, engine
    def run(self):
        stop = self.folder / 'live' / 'stop'
        while not stop.exists(): time.sleep(0.005)
        self.log.append('reader saw stop')
        if self.speech:
            for side in ('me', 'them'): self.engine(side)
        (self.folder / 'live' / 'done.json').write_text(json.dumps({'tail': {s: tail_record(s, self.speech) for s in ('me', 'them')}, 'seconds': 1.0, 'at': 'T'}))

class Tee(io.StringIO):
    # stdout that remembers what had been written each time flush() was called: proves a line reached stop.log as it was printed
    def __init__(self): super().__init__(); self.flushed = []
    def flush(self): self.flushed.append(self.getvalue()); super().flush()

def fake_transcribe(log, out, fail=None, differ=0):
    # call.transcribe for the check pass (or the batch path): records the call, writes v2's reader files from the live words
    # (so the guard has something to compare), a version.json with a clean gap check, and returns the tracks.
    def transcribe(folder, event, target, version, *a, **kw):
        log.append(('transcribe', version)); out['stdout_at_transcribe'] = out['tee'].getvalue(); out.setdefault('hashes_at_transcribe', hashes(folder))
        if fail: raise SystemExit(fail)
        target = Path(target); target.mkdir(parents=True, exist_ok=True)
        sides, _, _ = live.live_sides(folder)
        for side in ('me', 'them'):
            words = [dict(w) for w in sides[side][0]]
            for i in range(differ): words[i * 11 + 1]['text'] = ' zzz'
            for reader in ('parakeet', 'nemotron'):
                (target / f'{side}-{reader}.json').write_text(json.dumps({'words': [{'word': w['text'].strip(), 'start': w['start'], 'end': w['end']} for w in (words if reader == 'parakeet' else sides[side][0])]}))
        tracks, info = live.build_tracks(folder)
        info = {**info, 'version': version, 'live': False, 'gap_check': 'clean', 'gaps': {}}
        (target / 'version.json').write_text(json.dumps(info))
        return tracks, info
    return transcribe

def hashes(folder):
    return {n: (hashlib.sha256((Path(folder) / n).read_bytes()).hexdigest(), (Path(folder) / n).stat().st_mtime_ns) for n in ('transcript.md', 'outbound.md') if (Path(folder) / n).exists()}

def fake_read_first(log):
    # call.read_first (Parakeet on both whole files) for the batch path: the live words as Parakeet's
    def read_first(folder, out):
        log.append('parakeet'); sides, _, _ = live.live_sides(folder)
        return {'words': {s: [dict(w) for w in sides[s][0]] for s in ('me', 'them')}, 'runs': {f'{s}_parakeet': {'pieces': 1, 'peak_gb': 0.0} for s in ('me', 'them')},
                'timings_s': {f'{s}_parakeet': 0.1 for s in ('me', 'them')}}
    return read_first

def no_engine(*a, **kw): raise AssertionError('a test reached the real speech engine')

def fake_convert(log):
    def convert(folder):
        log.append('convert')
        with wave.open(str(Path(folder) / 'them.wav'), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b'\x00\x00' * 16000)
    return convert

class World:
    # Everything stop touches, pointed at a temp home. Used as a context manager; `go()` runs call.stop.
    def __init__(self, root, folder, reader_pid=4242, recorder_gone=True):
        self.root, self.folder, self.log, self.out = Path(root), folder, [], {'tee': Tee()}
        self.reader_pid, self.recorder_gone = reader_pid, recorder_gone
        self.kills, self.probes, self.sleeps, self.engine_calls = [], [], [], []
        self.clock = 1000.0
    def kill(self, pid, sig): self.kills.append((pid, sig)); self.log.append(('kill', pid, sig))
    def probe(self, pid, sig=0):
        self.probes.append((pid, sig)); self.log.append(('probe', pid, sig))
        if sig == 0 and pid == 7777 and self.recorder_gone: raise ProcessLookupError
        if sig == 0 and pid == self.reader_pid and not self.reader_alive: raise ProcessLookupError
    reader_alive = True
    ne_run = None   # nemo-speech never runs here: a test that reads through nvidia_engine sets its own fake
    def engine(self, model, wav=None, *a, **kw):
        # called by the fake reader as engine('me') and by read_range as engine(model, wav)
        self.engine_calls.append(model if wav is None else Path(wav).name); self.log.append(('engine', model if wav is None else Path(wav).name))
        return fixtures.W('hello there friend', 1.0), fixtures.RUN
    def sleep(self, s): self.sleeps.append(s); self.clock += s; time.sleep(min(s, 0.01))
    def patches(self, **extra):
        settings = self.root / 'settings.json'; settings.write_text(json.dumps({'frontier': 'nebius'}))
        screen = lambda folder: (self.log.append('screen'), entry.fake_screen(folder))[1]
        base = dict(HOME=self.root / 'calls', STATE=self.root / 'calls' / 'current.json', SETTINGS=settings, PROFILE=self.root / 'profile.md', WORKSTREAMS=self.root / 'workstreams.json',
                    convert_wavs=fake_convert(self.log), read_first=fake_read_first(self.log), transcribe=fake_transcribe(self.log, self.out))
        base.update(extra)
        return base
    def go(self, started=None, **patch):
        (self.root / 'calls' / 'current.json').write_text(json.dumps({'pid': 7777, 'dir': str(self.folder), 'started': 0, **({'live_pid': self.reader_pid} if self.reader_pid else {})}))
        stack = contextlib.ExitStack()
        patches = self.patches(**patch)
        stack.enter_context(entry.patched(call, **patches))
        stack.enter_context(entry.patched(privacy, screen_folder=lambda f: (self.log.append('screen'), entry.fake_screen(f))[1]))
        stack.enter_context(entry.patched(live.ne, run=self.ne_run or no_engine, version=lambda: 'nemo-speech (fake)'))
        stack.enter_context(contextlib.redirect_stdout(self.out['tee']))
        with stack:
            t0 = time.time()
            code = call.stop(started=started if started is not None else t0, kill=self.kill, probe=self.probe, sleep=self.sleep, engine=self.engine, cut=getattr(self, 'cut', None) or live.ffmpeg_cut)
        self.seconds = time.time() - t0
        return code
    def order(self): return [e if isinstance(e, str) else e[0] for e in self.log]

def prepared_runs(root): return sorted((Path(root) / 'runs').glob('*/send.json'))

# ---------- the fast path ----------

def test_one_hour_call_is_prepared_before_any_batch_read_and_inside_the_five_second_budget():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=True, engine=w.engine).start()
        code = w.go()
        out = w.out['tee'].getvalue()
        order = w.order()
        # the recorder was asked to stop, polled (not slept on), then the reader was told, then the question, then the batch
        assert w.kills == [(7777, signal.SIGINT)] and all(s <= 0.1 for s in w.sleeps), (w.kills, w.sleeps)   # only the 0.1 s poll for done.json sleeps; the recorder is polled, not slept on
        assert order.index('kill') < order.index('reader saw stop') < order.index('screen') < order.index('transcribe'), order
        assert 'convert' in order and order.index('screen') < order.index('convert'), 'the whole-file ffmpeg conversions are batch work and come after the question'
        # engine calls before the screen: the tail on both sides and nothing else
        before = order[:order.index('screen')]
        assert before.count('engine') == 2, before
        # the question is on screen before the check starts, and was flushed as it was printed (stop.log fills as it goes)
        assert 'stop: ready for the question in' in w.out['stdout_at_transcribe'], w.out['stdout_at_transcribe']
        ready = [s for s in w.out['tee'].flushed if 'stop: ready for the question in' in s]
        assert ready and ready[0].rstrip().endswith('s'), 'the ready line was not flushed when printed'
        line = [l for l in out.splitlines() if l.startswith('stop: ready for the question in')][0]
        said = float(line.split(' in ')[1].split(' s')[0])
        assert said < 5.0 and w.seconds < 20, (said, w.seconds)
        # one pending send, made from the live transcript
        sends = prepared_runs(d); assert len(sends) == 1, sends
        send = json.loads(sends[0].read_text())
        assert send['status'] == 'pending' and Path(send['outbound'][0]).exists() and send['folder'] == str(folder.resolve())
        text = (folder / 'transcript.md').read_text()
        assert text.startswith('# Coffee chat with Sam Lee') and ', 60 min.' in text and 'Me:' in text and 'Sam Lee:' in text, text[:300]
        assert 'River' in text or 'Window' in text or 'Orchard' in text
        assert code == 0

def test_v1_version_json_says_live_and_times_each_step():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=True, engine=w.engine).start(); w.go()
        v = json.loads((folder / 'version.json').read_text())
        assert v['live'] is True and v['gap_check'] == 'deferred' and 'live_fallback' not in v, v.keys()
        t = v['timings_s']
        assert set(t) >= {'tail_me', 'tail_them', 'build', 'wait_tail', 'fallback', 'finish', 'screen', 'ready'}, t
        assert t['tail_me'] == 0.5 and t['tail_them'] == 0.5 and t['ready'] < 5.0 and all(isinstance(t[k], (int, float)) for k in t), t

def test_a_silent_tail_costs_no_engine_call_before_the_question():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=False, engine=w.engine).start(); w.go()
        order = w.order()
        assert order[:order.index('screen')].count('engine') == 0 and w.engine_calls == [], order
        assert json.loads((folder / 'version.json').read_text())['timings_s']['tail_me'] == 0.0

def test_the_check_pass_reads_into_v2_check_and_never_touches_v1s_transcript_or_outbound():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=True, engine=w.engine).start(); code = w.go()
        assert hashes(folder) == w.out['hashes_at_transcribe'] and len(hashes(folder)) == 2, 'v1 transcript.md/outbound.md changed (bytes or mtime) after the question'
        v2 = folder / 'v2-check'
        assert (v2 / 'transcript.md').exists() and (v2 / 'version.json').exists() and not (v2 / 'outbound.md').exists()
        check = json.loads((folder / 'live-check.json').read_text())
        assert check['pass'] is True and code == 0, check
        assert check['agreement'] == {'me': 1.0, 'them': 1.0} and check['gap_check'] == 'clean' and set(check['check_s']) == {'convert', 'read', 'total'}, check
        assert check['thresholds'] == live.THRESHOLD and check['v1']['me']['words'] == 7200 == check['v2']['me']['words']
        assert 'live check: pass' in w.out['tee'].getvalue()

def test_a_worse_live_transcript_fails_the_check_loudly_and_exits_nonzero():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=True, engine=w.engine).start()
        code = w.go(transcribe=fake_transcribe(w.log, w.out, differ=40))
        check = json.loads((folder / 'live-check.json').read_text())
        assert check['pass'] is False and code == 1, check
        assert 'LIVE CHECK FAILED' in w.out['tee'].getvalue()
        assert prepared_runs(d), 'the send was already prepared; a failed check does not unprepare it'

def test_a_check_pass_that_cannot_run_says_so_and_keeps_the_prepared_send():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        Reader(folder, w.log, speech=True, engine=w.engine).start()
        code = w.go(transcribe=fake_transcribe(w.log, w.out, fail='nemo-speech not found'))
        check = json.loads((folder / 'live-check.json').read_text())
        assert code == 1 and check['pass'] is False and 'nemo-speech not found' in check['error'], check
        assert 'LIVE CHECK DID NOT RUN' in w.out['tee'].getvalue() and prepared_runs(d)

# ---------- the recorder poll ----------

def test_wait_gone_polls_without_sleeping_when_the_recorder_is_already_gone_and_stops_at_the_cap():
    sleeps = []
    def gone(pid, sig): raise ProcessLookupError
    assert call.wait_gone(5, probe=gone, sleep=sleeps.append) is True and sleeps == []
    clock = [0.0]
    def advance(s): sleeps.append(s); clock[0] += s
    assert call.wait_gone(5, cap=3.0, probe=lambda pid, sig: None, sleep=advance, now=lambda: clock[0]) is False
    assert 2.9 <= sum(sleeps) <= 3.1, sum(sleeps)
    clock[0], sleeps[:] = 0.0, []
    n = [0]
    def exits_on_third(pid, sig):
        n[0] += 1
        if n[0] == 3: raise ProcessLookupError
    assert call.wait_gone(5, probe=exits_on_third, sleep=advance, now=lambda: clock[0]) is True and len(sleeps) == 2

# ---------- when the reader is not enough ----------

def short_signal_folder(d, seconds=40.0, state_read=30.0, failed=()):
    # one 30 s piece read (both sides), the recording holds `seconds` of tone: a reader that died before its tail
    folder = hour_folder(d, pieces=1)
    signal_ = {side: fixtures.speech(seconds) for side in ('me', 'them')}
    for side, x in signal_.items(): fixtures.write_caf(folder / f'{side}.caf', np.concatenate([np.zeros(0, np.float32), np.repeat(x, 3)]))
    state = json.loads((folder / 'live' / 'state.json').read_text())
    for side in ('me', 'them'): state['sides'][side].update({'heard_s': state_read, 'read_s': state_read, 'failed': [list(f) for f in failed]})
    (folder / 'live' / 'state.json').write_text(json.dumps(state))
    return folder, signal_

def cut_of(signal_, log=None):
    def cut(ffmpeg, caf, from_s, length, wav):
        x = signal_[Path(caf).stem][int(from_s * 16000):int((from_s + length) * 16000)]
        with wave.open(str(wav), 'wb') as f: f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000); f.writeframes((x * 32767).astype(np.int16).tobytes())
    return cut

def test_a_dead_reader_makes_stop_read_the_unread_tail_itself_and_say_so():
    with tempfile.TemporaryDirectory() as d:
        folder, signal_ = short_signal_folder(d); w = World(d, folder, reader_pid=None)
        w.cut = cut_of(signal_)
        code = w.go()
        assert w.engine_calls == ['me-fb0001.wav', 'them-fb0001.wav'], w.engine_calls   # the tail of each side, after the one piece already read
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        assert [l['piece'] for l in lines] == [0, 1] and lines[1]['from'] == 30.0 and lines[1]['to'] == 40.0, lines[1]
        order = w.order(); assert order.index('engine') < order.index('screen') < order.index('transcribe')
        v = json.loads((folder / 'version.json').read_text())
        assert v['live_fallback'] == {'whole_call': False, 'ranges': {'me': [[30.0, 40.0]], 'them': [[30.0, 40.0]]}}, v.get('live_fallback')
        assert 'the live reader left unread' in w.out['tee'].getvalue() and not (folder / 'live' / 'done.json').exists()
        assert (folder / 'transcript.md').exists() and ', 1 min.' in (folder / 'transcript.md').read_text()

def test_a_range_the_reader_failed_is_read_by_stop_and_lands_in_time_order():
    with tempfile.TemporaryDirectory() as d:
        folder, signal_ = short_signal_folder(d, seconds=70.0, state_read=70.0, failed=[(30.0, 55.0)])
        (folder / 'live' / 'done.json').write_text(json.dumps({'tail': {s: tail_record(s, False) for s in ('me', 'them')}, 'seconds': 1.0, 'at': 'T'}))
        w = World(d, folder); w.cut = cut_of(signal_)
        w.go()
        assert w.engine_calls == ['me-fb0001.wav', 'them-fb0001.wav'], w.engine_calls
        file_order = [(l['from'], l['to']) for l in live.read_words(folder / 'live' / 'me-words.jsonl')]
        assert file_order == [(0.0, 30.0), (30.0, 55.0)], file_order
        assert json.loads((folder / 'version.json').read_text())['live_fallback']['ranges']['me'] == [[30.0, 55.0]]
        sides, _, _ = live.live_sides(folder)
        starts = [wd['start'] for wd in sides['me'][0]]; assert starts == sorted(starts)

def test_a_long_unread_range_is_read_in_pieces_cut_at_pauses():
    with tempfile.TemporaryDirectory() as d:
        folder, signal_ = short_signal_folder(d, seconds=100.0, state_read=0.0)
        calls = []
        def engine(model, wav, *a, **kw): calls.append(Path(wav).name); return fixtures.W('one two three', 0.5), fixtures.RUN
        total = live.read_range(folder, 'me', 30.0, 100.0, engine=engine, cut=cut_of(signal_))
        lines = [l for l in live.read_words(folder / 'live' / 'me-words.jsonl') if l['piece'] > 0]
        assert len(lines) == total['pieces'] == 3 and lines[0]['from'] == 30.0 and lines[-1]['to'] == 100.0 and lines[-1]['reason'] == 'tail', lines
        assert all(a['to'] == b['from'] for a, b in zip(lines, lines[1:])) and all(l['to'] - l['from'] <= 30.0 for l in lines)
        assert lines[0]['reason'] == 'pause' and 50.0 <= lines[0]['to'] <= 60.0, lines[0]

def test_a_reader_that_never_wrote_state_sends_stop_to_the_whole_call_the_old_way():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); (folder / 'live' / 'state.json').unlink(); w = World(d, folder, reader_pid=None)
        code = w.go()
        order = w.order()
        assert order.index('convert') < order.index('parakeet') < order.index('screen') < order.index('transcribe'), order   # Parakeet, the question, then the marks
        v = json.loads((folder / 'version.json').read_text())
        assert v['live_fallback']['whole_call'] is True and 'state.json' in v['live_fallback']['why'], v
        assert not (folder / 'live-check.json').exists() and not (folder / 'v2-check').exists(), 'the batch already is the full reading'
        assert 'reading the whole call' in w.out['tee'].getvalue() and prepared_runs(d)

def test_words_files_that_lost_lines_or_a_recorder_file_the_reader_cannot_parse_go_the_old_way():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d, pieces=3); w = World(d, folder, reader_pid=None)
        lines = (folder / 'live' / 'me-words.jsonl').read_text().splitlines()
        (folder / 'live' / 'me-words.jsonl').write_text('\n'.join(lines[:2]) + '\n')   # state counts 3, the file holds 2
        w.go()
        assert json.loads((folder / 'version.json').read_text())['live_fallback']['why'].startswith('me-words.jsonl holds 2 of the 3')
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d, pieces=1); w = World(d, folder, reader_pid=None)
        (folder / 'me.caf').write_bytes(fixtures.caf_bytes(np.zeros(1600, '<i2').tobytes(), rate=16000, flags=0, bits=16))
        w.go()
        why = json.loads((folder / 'version.json').read_text())['live_fallback']['why']
        assert '16000' in why, why

def test_an_engine_failure_while_stop_reads_the_gap_sends_the_whole_call_the_old_way():
    with tempfile.TemporaryDirectory() as d:
        folder, signal_ = short_signal_folder(d); w = World(d, folder, reader_pid=None); w.cut = cut_of(signal_)
        def broken(model, wav=None, *a, **kw): raise SystemExit('nemo-speech failed (1)')
        w.engine = broken
        w.go()
        v = json.loads((folder / 'version.json').read_text())
        assert v['live_fallback']['whole_call'] is True and 'nemo-speech failed' in v['live_fallback']['why'], v

def test_a_reader_still_running_after_the_wait_is_stopped_and_its_tail_read_here():
    with tempfile.TemporaryDirectory() as d:
        folder, signal_ = short_signal_folder(d); w = World(d, folder, reader_pid=4242); w.cut = cut_of(signal_)
        clock = [1000.0]
        def sleep(s): clock[0] += s
        w.sleep = sleep
        # the reader is alive and never writes done.json: after TAIL_WAIT_S stop terminates it and reads the tail itself
        (Path(d) / 'calls' / 'current.json').write_text(json.dumps({'pid': 7777, 'dir': str(folder), 'started': 0, 'live_pid': 4242}))
        with entry.patched(call, **w.patches()), entry.patched(privacy, screen_folder=lambda f: entry.fake_screen(f)), contextlib.redirect_stdout(w.out['tee']):
            call.stop(started=1000.0, kill=w.kill, probe=w.probe, sleep=sleep, now=lambda: clock[0], engine=w.engine, cut=w.cut)
        assert (4242, signal.SIGTERM) in w.probes and clock[0] - 1000.0 >= live.TAIL_WAIT_S - 0.2, (w.probes, clock[0])
        assert w.engine_calls == ['me-fb0001.wav', 'them-fb0001.wav'] and 'did not finish the last piece' in w.out['tee'].getvalue()

def test_a_recorder_that_already_died_still_gets_written_up():
    # 10-23: the recorder quit mid-call ("Failed to find any displays or windows to capture") and every Stop after that
    # crashed on kill() with ProcessLookupError, so the call was never written up. A gone recorder means it is stopped.
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); w = World(d, folder)
        def gone(pid, sig): w.kills.append((pid, sig)); raise ProcessLookupError
        w.kill = gone
        w.go()
        assert (folder / 'transcript.md').exists() and not (Path(d) / 'calls' / 'current.json').exists(), sorted(p.name for p in folder.iterdir())

# ---------- the whole call read at stop: the question after Parakeet, the marks after it (3C, 2026-10-27) ----------

def batch_folder(d):
    # four pieces a side and no state.json: the reader left nothing, so stop reads every file
    folder = hour_folder(d, pieces=4); (folder / 'live' / 'state.json').unlink()
    return folder

def reader_fake(w, runs):
    # nvidia_engine.run on the whole files: Parakeet hears "Priya" where Nemotron hears "Pria" (a mark), and each run
    # records what the card could read at that moment: stop's output so far, transcript.md, version.json's refine
    def run(model, wav, out_json=None, language=None, device='metal', chunk=None, phrases=None, boost=None):
        folder, side = Path(wav).parent, Path(wav).stem
        reader = 'parakeet' if 'parakeet' in Path(model).name else 'nemotron'
        md, version = folder / 'transcript.md', live.read_json(folder / 'version.json') or {}
        runs.append({'reader': reader, 'side': side, 'out': Path(out_json).parent.name if out_json else None, 'said': w.out['tee'].getvalue(),
                     'md': md.read_text() if md.exists() else None, 'refine': version.get('refine'), 'sends': [json.loads(p.read_text())['status'] for p in prepared_runs(w.root)]})
        if w.at_second_reader and reader == 'nemotron' and len([r for r in runs if r['reader'] == 'nemotron']) == 1: w.at_second_reader()
        words = [dict(x) for x in live.live_sides(folder)[0][side][0]]
        words[3]['text'] = ' Priya' if reader == 'parakeet' else ' Pria'
        if out_json: Path(out_json).write_text('{}')
        return words, {'model': Path(model).name, 'pieces': 1, 'seconds': 0.1, 'peak_gb': 0.5, 'words': len(words)}
    return run

def batch_world(d):
    folder = batch_folder(d); w = World(d, folder, reader_pid=None); w.runs = []; w.at_second_reader = None
    w.ne_run = reader_fake(w, w.runs)
    return folder, w

def go_batch(w):
    quiet = lambda wav, words, threshold=None: {'threshold_s': threshold, 'floor_rms': 0.0, 'loud_s': 0.0, 'gaps': []}
    with entry.patched(live.ne, gap_check=quiet):
        return w.go(read_first=call.read_first, transcribe=call.transcribe)

def test_the_whole_call_read_at_stop_asks_the_question_after_parakeet_and_marks_it_after():
    # 2026-10-27: six engine runs one after another, 1228.6 s, before the question. Now one reader, then the question.
    with tempfile.TemporaryDirectory() as d:
        folder, w = batch_world(d)
        code = go_batch(w)
        readers = [(r['reader'], r['side']) for r in w.runs]
        assert readers == [('parakeet', 'me'), ('parakeet', 'them'), ('nemotron', 'me'), ('nemotron', 'them')], readers
        second = w.runs[2]
        assert 'stop: ready for the question in' in second['said'] and 'stop: ready' not in w.runs[1]['said'], 'the question waits for Parakeet only'
        # what the card shows while Nemotron reads: Parakeet's whole transcript, said to be unmarked, never a half-written one
        assert second['md'] and '(unclear)' not in second['md'] and call.MARKS_COMING in second['md'] and second['refine'] == {'status': 'running'}, second['refine']
        assert all(r['out'] == call.REFINE_DIR for r in w.runs if r['reader'] == 'nemotron'), [r['out'] for r in w.runs]
        assert second['sends'] == ['pending'], second['sends']   # the question is out
        md = (folder / 'transcript.md').read_text()
        assert '(unclear)' in md and call.MARKS_COMING not in md, md[:400]   # rewritten with the marks
        v = json.loads((folder / 'version.json').read_text())
        assert v['refine']['status'] == 'done' and v['live_fallback']['whole_call'] is True and v['agreement']['me']['marked'] >= 1 and 'ready' in v['timings_s'], v.get('refine')
        assert not (folder / call.REFINE_DIR).exists() and (folder / 'me-nemotron.json').exists() and (folder / 'me-parakeet.json').exists()
        # the waiting send was screened from the unmarked transcript: screened again, the old one superseded
        sends = [json.loads(p.read_text()) for p in prepared_runs(d)]
        assert sorted(s['status'] for s in sends) == ['pending', 'superseded'], [s['status'] for s in sends]
        old, new = sorted(sends, key=lambda s: s['status'] == 'pending')
        assert old['superseded_by'] == new['run'] and Path(new['outbound'][0]).exists() and new['outbound'] != old['outbound']
        assert 'stop: marks done in' in w.out['tee'].getvalue() and code == 0

def test_the_marks_wait_for_notes_being_written_and_an_answered_send_is_not_asked_again():
    with tempfile.TemporaryDirectory() as d:
        folder, w = batch_world(d)
        def answered():   # he said Yes while Nemotron read: the notes are being written from the unmarked transcript
            path = prepared_runs(d)[0]; path.write_text(json.dumps({**json.loads(path.read_text()), 'status': 'sending'}))
        w.at_second_reader = answered
        polls, seen = [], {}
        def sleep(s):
            polls.append(s)
            if len(polls) == 3:
                seen['md'] = (folder / 'transcript.md').read_text()
                path = prepared_runs(d)[0]; path.write_text(json.dumps({**json.loads(path.read_text()), 'status': 'sent'}))
        w.sleep = sleep
        assert go_batch(w) == 0
        assert len(polls) >= 3 and '(unclear)' not in seen['md'], 'transcript.md changed while the notes were being written'
        assert '(unclear)' in (folder / 'transcript.md').read_text()
        assert [json.loads(p.read_text())['status'] for p in prepared_runs(d)] == ['sent'], 'an answered send is never prepared again'

def test_marks_that_cannot_run_keep_the_question_and_parakeets_transcript_and_say_so():
    with tempfile.TemporaryDirectory() as d:
        folder, w = batch_world(d)
        fake = w.ne_run
        def broken(model, wav, *a, **kw):
            if 'parakeet' not in Path(model).name: raise SystemExit('nemo-speech failed (1)')
            return fake(model, wav, *a, **kw)
        w.ne_run = broken
        assert go_batch(w) == 1
        out = w.out['tee'].getvalue()
        assert 'stop: ready for the question in' in out and 'MARKS DID NOT RUN: nemo-speech failed (1)' in out
        v = json.loads((folder / 'version.json').read_text())
        assert v['refine'] == {'status': 'failed', 'why': 'nemo-speech failed (1)'} and not (folder / call.REFINE_DIR).exists()
        assert (folder / 'transcript.md').exists() and [json.loads(p.read_text())['status'] for p in prepared_runs(d)] == ['pending']

# ---------- without a live folder ----------

def test_without_a_live_folder_stop_runs_todays_path_and_writes_no_live_files():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d)
        import shutil; shutil.rmtree(folder / 'live')
        w = World(d, folder, reader_pid=None)
        code = w.go()
        order = w.order()
        assert order.index('convert') < order.index('parakeet') < order.index('screen') < order.index('transcribe'), order
        assert not (folder / 'live').exists() and not (folder / 'live-check.json').exists() and not (folder / 'v2-check').exists()
        assert 'stop: ready for the question' in w.out['stdout_at_transcribe'], 'the question comes before the marks pass'
        assert 'live_fallback' not in json.loads((folder / 'version.json').read_text())
        assert code is None or code == 0

def test_a_missing_side_still_stops_loudly():
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d); (folder / 'them.caf').unlink(); w = World(d, folder)
        try: w.go(); raise AssertionError('no audio on a side must exit')
        except SystemExit as e: assert 'No them audio was recorded' in str(e.code), e.code

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
