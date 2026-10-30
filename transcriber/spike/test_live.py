# Live reader tests, increment L1: the pure parts of live.py (spec-live-transcription.md, B20 to B25). Deterministic: a CAF
# written by the test with the recorder's header bytes, synthetic RMS, made-up words; no engine, no ffmpeg, no clock.
#   python3 test_live.py   (exit 0 = pass)
import contextlib, io, json, os, sys, tempfile, threading, time, wave
from pathlib import Path
import numpy as np
import call, live, stream, transcript, nvidia_engine as ne
from nvidia_asr import rms_frames
from fixtures import RUN, W, caf_bytes, put, speech, tone, write_caf   # the recorder's CAF and the words files

def test_caf_info_reads_the_recorders_header_and_refuses_anything_else():
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / 'me.caf'; write_caf(f, tone(1))
        info = live.caf_info(f)
        assert info == {'rate': 48000, 'channels': 1, 'bits': 32, 'float': True, 'data_offset': 0x1000}, info
        write_caf(f, tone(1), data_at=0x400)   # parsed, not assumed
        assert live.caf_info(f)['data_offset'] == 0x400 + 16
        g = Path(d) / 'old.caf'; g.write_bytes(caf_bytes(np.zeros(1600, '<i2').tobytes(), rate=16000, flags=0, bits=16))
        try: live.caf_info(g); raise SystemExit('a 16 kHz int16 CAF must be refused')
        except live.LiveFormat as e: assert '16000' in str(e) and '16' in str(e), e
        h = Path(d) / 'junk.caf'; h.write_bytes(b'RIFF' + bytes(100))
        try: live.caf_info(h); raise SystemExit('not a CAF')
        except live.LiveFormat as e: assert 'caff' in str(e), e
        k = Path(d) / 'short.caf'; k.write_bytes(caf_bytes(b'')[:0x80])
        try: live.caf_info(k); raise SystemExit('a header with no data chunk yet')
        except live.LiveFormat: pass

def test_an_airpods_mic_at_24_khz_is_read_live_at_its_own_rate():
    # 2026-10-27: AirPods Pro record the mic at 24 kHz; live reading refused it and the call showed no live words.
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / 'me.caf'; write_caf(f, tone(10, rate=24000), rate=24000)
        info = live.caf_info(f)
        assert info['rate'] == 24000, info
        assert abs(live.heard_s(f, info) - 10) < 0.01, live.heard_s(f, info)
        g = Path(d) / 'stereo.caf'; g.write_bytes(caf_bytes(np.zeros(4800, '<f4').tobytes(), rate=24000, channels=2))
        try: live.caf_info(g); raise SystemExit('two channels must be refused')
        except live.LiveFormat as e: assert '2 channel' in str(e), e

def test_heard_seconds_follow_the_file_size():
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / 'them.caf'; write_caf(f, tone(10))
        info = live.caf_info(f)
        assert live.heard_s(f, info) == 10.0
        with open(f, 'ab') as w: w.write(tone(2.5).astype('<f4').tobytes())
        assert live.heard_s(f, info) == 12.5
        f.write_bytes(caf_bytes(b'')[:0xff8])   # header written, no frames yet
        assert live.heard_s(f, info) == 0.0

def frames(seconds, loud=0.3, quiet=()):
    # synthetic RMS at the 30 ms hop: `loud` everywhere, 0.0005 in the `quiet` (from, to) stretches (seconds in the stretch)
    r = np.full(int(round(seconds / live.HOP)), loud, np.float32)
    for a, b in quiet: r[int(round(a / live.HOP)):int(round(b / live.HOP))] = 0.0005
    return r

FLOOR = 0.004

def test_a_piece_is_cut_at_the_quietest_frame_in_the_last_ten_seconds():
    rms = frames(31, quiet=[(5, 6)])   # a deeper pause early on is outside the search window
    rms[int(24.0 / live.HOP)] = 0.0001   # the quietest single frame, 24.0 s in, inside the last 10 s
    rms[int(26.0 / live.HOP):int(26.5 / live.HOP)] = 0.0003
    to, reason = live.next_piece(100.0, 131.0, rms, FLOOR)
    assert reason == 'pause' and to == 124.0, (to, reason)
    assert live.next_piece(100.0, 129.9, frames(29.9), FLOOR) == (None, 'none')   # under 30 s and no pause: wait
    # the cut lands on a frame inside the stretch, never past what has been heard
    to, _ = live.next_piece(0.0, 30.0, frames(30, quiet=[(29.9, 30.0)]), FLOOR)
    assert 20.0 <= to <= 30.0

def test_a_paused_meeting_flushes_after_ten_seconds_and_short_stretches_wait():
    to, reason = live.next_piece(40.0, 52.0, frames(12, quiet=[(9, 12)]), FLOOR)   # 12 s, last 3 s quiet
    assert (to, reason) == (52.0, 'quiet'), (to, reason)
    assert live.next_piece(40.0, 52.0, frames(12, quiet=[(9.5, 12)]), FLOOR) == (None, 'none')   # 2.5 s of quiet is not a pause yet
    assert live.next_piece(0.0, 8.0, frames(8, quiet=[(2, 8)]), FLOOR) == (None, 'none')   # 8 s: nothing yet, quiet or not
    assert live.next_piece(0.0, 12.0, frames(12), FLOOR) == (None, 'none')   # 12 s of speech: keep listening

def test_silence_is_counted_in_loud_seconds_and_a_quiet_piece_is_skipped():
    rate = 16000
    x = np.zeros(rate * 10, np.float32)
    x[rate * 2:int(rate * 2.5)] = (0.3 * np.sin(np.arange(int(rate * 0.5)) / 7)).astype(np.float32)   # 0.5 s of sound in 10 s
    rms = rms_frames(x)
    floor = live.floor_of(rms)
    assert floor == 0.004, floor   # a silent room: the 0.004 minimum
    assert abs(live.loud_seconds(rms, floor) - 0.5) < 0.1 and live.is_silent(rms, floor)
    x[rate * 5:int(rate * 6.5)] = (0.3 * np.sin(np.arange(int(rate * 1.5)) / 7)).astype(np.float32)
    rms = rms_frames(x)
    assert live.loud_seconds(rms, live.floor_of(rms)) > 1.9 and not live.is_silent(rms, live.floor_of(rms))
    # the same rule nvidia_engine.loudness applies: a noisy room raises the floor to 3x its 20th percentile
    noisy = frames(10, loud=0.02)
    assert abs(live.floor_of(noisy) - 0.06) < 1e-6

def test_the_cut_rule_reads_the_frames_the_gap_check_reads():
    x = (0.1 * np.sin(np.arange(16000 * 3) / 5)).astype(np.float32)
    assert len(rms_frames(x)) == 100 and np.allclose(rms_frames(x[:480]), np.sqrt((x[:480] ** 2).mean()))

# ---------- words files and build_tracks ----------

def rel(words, from_s): return [{**w, 'start': round(w['start'] - from_s, 2), 'end': round(w['end'] - from_s, 2)} for w in words]   # the engine's clock: zero at the piece

# Per side: three pieces. Piece 1 is empty for Parakeet but Nemotron heard four words (a fill). Piece 2 is the tail,
# with Parakeet's words only. Names and numbers differ so marks exist.
PIECES = [(0, 0.0, 30.0, 'pause'), (1, 30.0, 60.0, 'pause'), (2, 60.0, 70.0, 'tail')]
PARAKEET = {'them': [W('Hello Sam Lee from Citi. We start at 24 dollars.', 0.5), [], W('Then Priya spoke about Siecor and Dell.', 61.0)],
            'me': [W('Thanks for joining Sam Lee today.', 1.0), W('We agree on ten oh two now.', 31.0), W('Sure sounds good.', 62.0)]}
NEMOTRON = {'them': [W('Hello Sam Li from Citi. We start at twenty four dollars.', 0.6), W('and then something was said here', 40.0), []],
            'me': [W('Thanks for joining Sam Lee today.', 1.0), W('We agree on ten oh two now.', 31.0), []]}

def live_folder(d):
    folder = Path(d) / '2026-10-08-0900-test'; folder.mkdir()
    (folder / 'event.json').write_text(json.dumps({'title': 'Test call', 'names': 'Sam Lee', 'attendees': ''}))
    for side in ('me', 'them'):
        for (n, a, b, reason), pk, nm in zip(PIECES, PARAKEET[side], NEMOTRON[side]):
            put(folder, f'{side}-words.jsonl', [live.words_line(n, a, b, reason, rel(pk, a), RUN, at='2026-10-08T09:00:00-04:00')])
            if reason != 'tail': put(folder, f'{side}-doubt.jsonl', [live.words_line(n, a, b, reason, rel(nm, a), RUN, at='2026-10-08T09:00:00-04:00')])
    return folder

def test_words_lines_put_the_pieces_words_on_the_calls_clock_and_read_back():
    with tempfile.TemporaryDirectory() as d:
        l = live.words_line(3, 90.0, 120.5, 'pause', [{'text': ' Hi', 'start': 0.5, 'end': 0.8, 'p': 1.0}], {'seconds': 0.6, 'peak_gb': 1.2}, at='T')
        assert l == {'piece': 3, 'from': 90.0, 'to': 120.5, 'reason': 'pause', 'words': [{'text': ' Hi', 'start': 90.5, 'end': 90.8, 'p': 1.0}], 'engine_s': 0.6, 'peak_gb': 1.2, 'at': 'T'}, l
        put(d, 'me-words.jsonl', [l, {**l, 'piece': 4}])
        assert [x['piece'] for x in live.read_words(Path(d) / 'live' / 'me-words.jsonl')] == [3, 4]
        assert live.read_words(Path(d) / 'live' / 'nothing.jsonl') == []

def reference(folder):
    # What transcribe() returns on the same words: its own steps, with the readers replaced by the words as one list.
    flat = lambda src: {'x' + side: [w for piece in src[side] for w in piece] for side in src}
    p, n = flat(PARAKEET), flat(NEMOTRON)
    # transcribe() calls readers with <folder>/<side>.wav: key the fakes on the side
    key = lambda wav: 'x' + Path(wav).stem
    real = (ne.parakeet, ne.nemotron, ne.gap_check, ne.version)
    ne.parakeet = lambda wav, out_json=None: ([dict(x) for x in p[key(wav)]], {'pieces': 1, 'peak_gb': 0.0})
    ne.nemotron = lambda wav, out_json=None, phrases=None: ([dict(x) for x in n[key(wav)]], {'pieces': 1, 'peak_gb': 0.0})
    ne.gap_check = lambda wav, words, threshold=ne.GAP_S: {'threshold_s': threshold, 'floor_rms': 0.0, 'loud_s': 0.0, 'gaps': []}
    ne.version = lambda: 'fake'
    try:
        with tempfile.TemporaryDirectory() as o:
            with contextlib.redirect_stdout(io.StringIO()): tracks, info = call.transcribe(folder, {}, Path(o), 'v1')
    finally: ne.parakeet, ne.nemotron, ne.gap_check, ne.version = real
    return tracks, info

def test_build_tracks_equal_what_transcribe_returns_on_the_same_words():
    with tempfile.TemporaryDirectory() as d:
        folder = live_folder(d)
        tracks, info = live.build_tracks(folder, now='2026-10-08T09:30:00-04:00')
        want, want_info = reference(folder)
        assert tracks == want, (tracks, want)
        assert sum(len(t) for t in tracks.values()) > 0
        words = [w for l in tracks['them'] for w in l['words']]
        assert any(w.get('filled') for w in words), 'the empty piece must be filled from the second reader'
        marked = transcript.marks(tracks['them'])
        assert {m['word'] for m in marked} >= {'Lee'}, marked
        assert info['agreement'] == want_info['agreement'] and info['filled'] == want_info['filled']
        assert info['version'] == 'v1' and info['engine'] == 'nvidia' and info['live'] is True and info['gap_check'] == 'deferred'
        assert info['pieces'] == {'me': 3, 'them': 3} and info['created'] == '2026-10-08T09:30:00-04:00'
        assert info['model'] == ne.PARAKEET.name and info['second_reader'] == ne.NEMOTRON.name and info['mark_rule'] == transcript.NVIDIA_RULE
        assert set(info['timings_s']) >= {'tail_me', 'tail_them', 'build'}

def test_the_tail_without_doubt_words_stays_unmarked_and_is_counted():
    with tempfile.TemporaryDirectory() as d:
        folder = live_folder(d)
        tracks, info = live.build_tracks(folder)
        assert info['tail_unmarked_s'] == 20.0, info['tail_unmarked_s']   # a 10 s tail on each side
        tail = [w for l in tracks['them'] for w in l['words'] if w['start'] >= 60.0]
        assert tail and all(w['p'] == 1.0 and 'heard' not in w for w in tail), tail
        (folder / 'live' / 'done.json').write_text(json.dumps({'tail': {'me': {'engine_s': 0.7}, 'them': {'engine_s': 0.9}}}))
        assert live.build_tracks(folder)[1]['timings_s']['tail_them'] == 0.9

def test_build_tracks_with_no_doubt_files_marks_nothing_and_reports_everything_unmarked():
    with tempfile.TemporaryDirectory() as d:
        folder = live_folder(d)
        for f in (folder / 'live').glob('*-doubt.jsonl'): f.unlink()
        tracks, info = live.build_tracks(folder)
        assert transcript.marks(tracks['them']) == [] and info['tail_unmarked_s'] == 140.0   # 70 s on each side

# ---------- the agreement and the guard ----------

def test_agreement_is_equal_words_over_the_second_lists_count():
    b = W(' '.join(f'w{i}' for i in range(50)))
    a = [dict(w) for w in b]
    for i in (3, 20, 41): a[i]['text'] = ' other'
    assert live.agreement(a, b) == 47 / 50
    assert live.agreement(b, b) == 1.0 and live.agreement([], []) == 1.0 and live.agreement(a, []) == 1.0

def check_folder(d, wrong):
    # 50 batch words per side; the live words (v1) differ on `wrong` of them. v2-check holds the batch readers' json.
    folder = Path(d) / 'call'; folder.mkdir(); (folder / 'event.json').write_text('{}')
    v2 = folder / 'v2-check'; v2.mkdir()
    base = [f'word{i}' for i in range(50)]
    for side in ('me', 'them'):
        batch = W(' '.join(base))
        (v2 / f'{side}-parakeet.json').write_text(json.dumps({'words': [{'word': w['text'].strip(), 'start': w['start'], 'end': w['end']} for w in batch]}))
        (v2 / f'{side}-nemotron.json').write_text(json.dumps({'words': [{'word': w['text'].strip(), 'start': w['start'], 'end': w['end']} for w in batch]}))
        liv = [dict(w) for w in batch]
        for i in range(wrong): liv[i * 7 + 1]['text'] = ' zzz'
        put(folder, f'{side}-words.jsonl', [live.words_line(0, 0.0, 30.0, 'pause', liv, RUN, at='T')])
        put(folder, f'{side}-doubt.jsonl', [live.words_line(0, 0.0, 30.0, 'pause', batch, RUN, at='T')])
    (v2 / 'version.json').write_text(json.dumps({'gap_check': 'clean'}))
    return folder

def test_live_check_passes_at_49_of_50_and_fails_at_47_of_50():
    with tempfile.TemporaryDirectory() as d:
        r = live.live_check(check_folder(d, 1), now='2026-10-08T10:00:00-04:00')
        assert r['agreement'] == {'me': 49 / 50, 'them': 49 / 50} and r['pass'] is True and r['gap_check'] == 'clean', r
        assert r['v1']['me']['words'] == 50 and r['v2']['them']['words'] == 50 and r['at'] == '2026-10-08T10:00:00-04:00'
        assert r['thresholds'] == {'agreement': 0.95, 'words': 0.96, 'marks': '1.3x + 2'} and set(r['marks_ratio']) == {'me', 'them'}
        assert json.loads((Path(d) / 'call' / 'live-check.json').read_text()) == r
    with tempfile.TemporaryDirectory() as d:
        r = live.live_check(check_folder(d, 3))
        assert r['agreement']['me'] == 47 / 50 and r['pass'] is False, r

def test_live_check_fails_on_lost_words_on_extra_marks_and_on_a_failed_batch_gap_check():
    with tempfile.TemporaryDirectory() as d:
        folder = check_folder(d, 0)
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        (folder / 'live' / 'me-words.jsonl').write_text(json.dumps({**lines[0], 'words': lines[0]['words'][:-3]}) + '\n')   # 47 of 50 words, all equal
        r = live.live_check(folder)
        assert r['agreement']['me'] == 47 / 50 and r['pass'] is False   # also under 0.96 x 50 = 48
    with tempfile.TemporaryDirectory() as d:
        folder = check_folder(d, 0)
        (folder / 'v2-check' / 'version.json').write_text(json.dumps({'gap_check': 'FAILED'}))
        r = live.live_check(folder)
        assert r['gap_check'] == 'FAILED' and r['pass'] is False and r['agreement']['me'] == 1.0
    with tempfile.TemporaryDirectory() as d:
        folder = check_folder(d, 0)   # live marks: Names the batch reader heard the same are not marked; make 6 live-only doubts
        liv = live.read_words(folder / 'live' / 'them-words.jsonl')[0]
        doubt = live.read_words(folder / 'live' / 'them-doubt.jsonl')[0]
        for i in range(0, 12, 2):
            liv['words'][i]['text'] = f' Name{i}'; doubt['words'][i]['text'] = f' Other{i}'
        (folder / 'live' / 'them-words.jsonl').write_text(json.dumps(liv) + '\n'); (folder / 'live' / 'them-doubt.jsonl').write_text(json.dumps(doubt) + '\n')
        r = live.live_check(folder)
        assert r['v1']['them']['marks'] >= 5 and r['v2']['them']['marks'] == 0 and r['pass'] is False, r


# ---------- the reader's loop (increment L2) ----------
# A fake engine, a fake cut (slices the 16 kHz signal the test holds), a fake sleep that grows the CAF by 2 s per tick and
# sets the clock. No ffmpeg, no engine, no real sleep, temp folders only.

class Meeting:
    second_s = 0.0
    # One side-by-side recording that grows 2 s per tick; `signal` holds each side's 16 kHz audio for the fake cut.
    def __init__(self, folder, signal, stop_at=None, stop_file=True, alive_until=None):
        self.folder, self.signal, self.clock, self.stop_at, self.stop_file, self.alive_until = Path(folder), signal, 0.0, stop_at, stop_file, alive_until
        self.engine_calls, self.cuts, self.states, self.fail, self.kws = [], [], [], [], []
        for side in signal: write_caf(self.folder / f'{side}.caf', np.zeros(0, np.float32))
    def now(self): return 1000.0 + self.clock
    def sleep(self, s):
        self.clock += s; self.grow()
        state = self.folder / 'live' / 'state.json'
        self.states.append(json.loads(state.read_text()) if state.exists() else None)
        self.maybe_stop()
        assert self.clock < 400, 'the loop never ended'
    def grow(self):
        for side, x in self.signal.items():
            have = live.heard_s(self.folder / f'{side}.caf', live.caf_info(self.folder / f'{side}.caf'))
            want = min(len(x) / 16000, self.clock)
            if want > have:
                with open(self.folder / f'{side}.caf', 'ab') as f: f.write(np.zeros(int((want - have) * 48000), '<f4').tobytes())
    def maybe_stop(self):
        if self.stop_at is not None and self.clock >= self.stop_at and self.stop_file: (self.folder / 'live' / 'stop').write_text('')
    def cut(self, ffmpeg, caf, from_s, length, wav):
        side = Path(caf).stem; self.cuts.append((side, from_s, length))
        x = self.signal[side][int(from_s * 16000):int((from_s + length) * 16000)]
        with wave.open(str(wav), 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((x * 32767).astype(np.int16).tobytes())
    def engine(self, model, wav, *a, **kw):
        self.engine_calls.append((Path(model).name, Path(wav).name, Path(wav).exists())); self.kws.append(kw)
        if self.fail:
            self.fail.pop(); sys.exit('nemo-speech failed (1) on piece')
        side = Path(wav).name.split('-')[0]; lead = live.CONTEXT_S if [c for c in self.cuts if c[0] == side][-1][1] > 0 else 0.0   # the wav starts with the context
        if Path(model).name == ne.NEMOTRON.name:
            self.clock += self.second_s; self.grow(); self.maybe_stop()   # a slow second reader: the meeting goes on while it reads
            return W('hello there friend' if side == 'me' else 'okay sure thing', lead + 1.0), {'seconds': 1.3, 'peak_gb': 1.8}
        return W('hello there friend' if side == 'me' else 'okay sure thing', lead + 1.0), RUN
    def alive(self): return self.alive_until is None or self.clock < self.alive_until
    def run(self, builder=None, **kw):
        lexed = []
        def lexicon(folder):
            lexed.append(folder); (Path(folder) / 'lexicon.json').write_text('{"entries": []}')
            return builder(folder) if builder else None
        code = live.run(self.folder, engine=self.engine, cut=self.cut, sleep=self.sleep, now=self.now, lexicon=lexicon, recorder_alive=self.alive, **kw)
        self.lexed = lexed
        return code

def meeting_folder(d):
    folder = Path(d) / 'call'; folder.mkdir(); (folder / 'event.json').write_text('{"title": "T"}')
    return folder

def test_the_loop_reads_one_piece_at_each_pause_and_the_tail_at_stop():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        assert m.run() == 0
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        assert [l['reason'] for l in lines] == ['pause', 'pause', 'tail'], lines
        assert lines[0]['from'] == 0.0 and 20.0 <= lines[0]['to'] <= 21.0 and lines[1]['from'] == lines[0]['to'] and lines[2]['from'] == lines[1]['to'] and lines[2]['to'] == 70.0
        assert [l['piece'] for l in lines] == [0, 1, 2]
        w = lines[1]['words']   # the engine says 1.0 s into the piece: the call's clock is the piece's start plus that
        assert w[0]['start'] == round(lines[1]['from'] + 1.0, 2) and w[0]['text'] == ' hello', w
        assert [l['piece'] for l in live.read_words(folder / 'live' / 'them-words.jsonl')] == [0, 1, 2]   # both sides, one engine at a time
        parakeet = [c for c in m.engine_calls if c[0] == ne.PARAKEET.name]; second = [c for c in m.engine_calls if c[0] == ne.NEMOTRON.name]
        assert len(parakeet) == 6 and len(second) == 4, m.engine_calls   # Parakeet reads every piece; the second reader every piece but the tail
        assert not list((folder / 'live' / 'pieces').glob('*.wav')), 'a piece that was read is deleted'
        assert m.lexed == [folder] and (folder / 'lexicon.json').exists()   # built once at start

def test_state_is_rewritten_every_tick_and_the_readable_transcript_after_each_piece():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        m.run()
        states = [s for s in m.states if s]
        assert len(states) >= 30 and states[0]['sides']['me']['heard_s'] == 0.0, len(states)   # one write per 2 s tick, from the first
        heard = [s['sides']['me']['heard_s'] for s in states]
        assert heard == sorted(heard) and heard[-1] >= 68.0
        mid = next(s for s in states if s['sides']['me']['pieces'] == 1)
        assert 20.0 <= mid['sides']['me']['read_s'] <= 21.0 and mid['behind_s'] == round(max(mid['sides'][k]['heard_s'] - mid['sides'][k]['read_s'] for k in mid['sides']), 2)
        assert mid['lexicon'] == 'written' and mid['pid'] == os.getpid()
        last = json.loads((folder / 'live' / 'state.json').read_text())
        assert last['sides']['me']['pieces'] == 3 and last['sides']['them']['pieces'] == 3 and last['sides']['me']['engine_s'] == 1.8
        text = (folder / 'live' / 'transcript-live.md').read_text()
        assert text.startswith('[00:') and 'Me:' in text and 'Them:' in text and 'hello there friend' in text and 'okay sure thing' in text, text[:200]

def test_a_silent_stretch_spawns_nothing_and_a_silent_tail_is_skipped():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(40), 'them': np.zeros(16000 * 70, np.float32)}, stop_at=72)
        m.signal['me'] = np.concatenate([m.signal['me'], np.zeros(16000 * 30, np.float32)])   # speech to 40 s, then 30 s of quiet room
        assert m.run() == 0
        assert not any('them' in c[1] for c in m.engine_calls), m.engine_calls   # nothing for the quiet side
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert state['sides']['them']['skipped_silent'] >= 1 and state['sides']['them']['pieces'] == 0 and state['sides']['me']['skipped_silent'] >= 1
        assert live.read_words(folder / 'live' / 'them-words.jsonl') == []
        done = json.loads((folder / 'live' / 'done.json').read_text())
        assert done['tail']['them']['skipped'] is True and done['tail']['me']['skipped'] is True and set(done['tail']['me']) == {'from_s', 'to_s', 'words', 'engine_s', 'skipped'}, done

def test_an_engine_failure_keeps_the_piece_wav_and_the_loop_goes_on():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72); m.fail = [1]
        assert m.run() == 0
        kept = sorted(p.name for p in (folder / 'live' / 'pieces').glob('*.wav'))
        assert kept == ['me-0000.wav'], kept   # the first piece (me, first engine call) failed: its wav stays for the fallback
        me = live.read_words(folder / 'live' / 'me-words.jsonl')
        assert [l['piece'] for l in me] == [1, 2] and len(live.read_words(folder / 'live' / 'them-words.jsonl')) == 3
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert state['sides']['me']['errors'] == 1 and 'nemo-speech failed' in state['error'] and state['sides']['them']['errors'] == 0, state
        assert state['sides']['me']['failed'] == [[0.0, me[0]['from']]], state['sides']['me']   # the range stop's fallback must read itself

def test_the_stop_file_reads_the_tail_and_writes_done_json_once():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(20), 'them': speech(20)}, stop_at=22)
        assert m.run() == 0
        done = json.loads((folder / 'live' / 'done.json').read_text())
        assert done['tail']['me'] == {'from_s': 0.0, 'to_s': 20.0, 'words': 3, 'engine_s': 0.6, 'skipped': False}, done
        assert done['seconds'] >= 0 and 'at' in done
        assert [l['reason'] for l in live.read_words(folder / 'live' / 'me-words.jsonl')] == ['tail']

def test_a_gone_recorder_with_no_stop_file_ends_the_reader_after_five_seconds():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(30), 'them': speech(30)}, alive_until=40)
        assert m.run() == 0
        assert (folder / 'live' / 'done.json').exists() and 44.0 <= m.clock <= 48.0, m.clock   # 40 s gone, 5 s of grace for stop to write its file

def test_a_recorder_file_that_is_not_48k_float_stops_the_reader_loudly():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {})
        (folder / 'me.caf').write_bytes(caf_bytes(np.zeros(1600, '<i2').tobytes(), rate=16000, flags=0, bits=16))
        assert m.run() == 2
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert '16000' in state['error'] and not (folder / 'live' / 'done.json').exists() and m.engine_calls == []

# ---------- overlapped reads: each piece is read with the seconds before it as context ----------

class Heard(Meeting):
    lengths = []; second_lengths = []
    # An engine that hears one fixed meeting: a word every 0.7 s whose text is its call-clock start, so a word read twice or
    # out of order shows. It answers for exactly the audio it was given (the wav's length, from the last cut's start).
    def engine(self, model, wav, *a, **kw):
        side = Path(wav).name.split('-')[0]; a = [c for c in self.cuts if c[0] == side][-1][1]
        with wave.open(str(wav)) as w: length = w.getnframes() / 16000
        self.engine_calls.append((Path(model).name, Path(wav).name, Path(wav).exists()))
        if Path(model).name == ne.PARAKEET.name: self.lengths.append((side, a, length))
        else: self.second_lengths.append((side, a, length))
        times = [k * 0.7 + 0.1 for k in range(1, 400)]
        return [{'text': f' w{t:07.2f}', 'start': round(t - a, 2), 'end': round(t - a + 0.3, 2), 'p': 1.0} for t in times if a <= t < a + length], RUN

def test_overlapped_words_are_kept_once_and_in_order_across_pieces():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Heard(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72); m.lengths = []; m.second_lengths = []
        assert m.run() == 0
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        assert [l['reason'] for l in lines] == ['pause', 'pause', 'tail'] and lines[1]['from'] == lines[0]['to']   # the piece itself is still recorded
        words = [w for l in lines for w in l['words']]
        starts = [w['start'] for w in words]
        assert starts == sorted(starts) and len({w['text'] for w in words}) == len(words), 'a word was kept twice or out of order'
        want = [round(k * 0.7 + 0.1, 2) for k in range(1, 100) if k * 0.7 + 0.1 < 70]
        assert starts == want, (len(starts), len(want), sorted(set(want) ^ set(starts)))   # nothing lost at a cut, nothing doubled
        me = [x for x in m.lengths if x[0] == 'me']   # the engine's audio per piece: context + piece + the audio already on disk past the cut
        for (side, a, length), l in zip(me, lines):
            ahead = round(a + length - l['to'], 2)
            assert (ahead == 0.0) == (l['reason'] == 'tail') and 0.0 <= ahead <= live.LOOKAHEAD_S + 0.01, (l['reason'], ahead)   # the tail has nothing past it

def test_the_first_piece_starts_at_zero_and_later_pieces_and_the_tail_read_the_context_before_them():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        m.run()
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        me = [c for c in m.cuts if c[0] == 'me']   # the loop also cuts a stretch that is not ready yet, every tick
        assert me[0][1] == 0.0 and all(c[1] >= 0 for c in me), me[:3]   # no negative context before the start
        for l in lines:
            ctx = max(0.0, round(l['from'] - live.CONTEXT_S, 2))
            assert any(c[1] == ctx and c[1] + c[2] >= l['to'] - 0.01 for c in me), (l['from'], l['to'], ctx)
        assert lines[2]['reason'] == 'tail' and any(c[1] == round(lines[2]['from'] - live.CONTEXT_S, 2) and abs(c[1] + c[2] - 70) < 0.01 for c in me)   # the tail has context too
        assert all(l['engine_s'] == RUN['seconds'] for l in lines)   # engine_s is the engine's own seconds, context included

def test_words_line_drops_the_context_and_a_word_the_last_piece_already_has():
    engine_words = [{'text': ' a', 'start': 1.0, 'end': 1.3, 'p': 1.0}, {'text': ' b', 'start': 4.9, 'end': 5.2, 'p': 1.0},
                    {'text': ' c', 'start': 5.0, 'end': 5.3, 'p': 1.0}, {'text': ' d', 'start': 6.0, 'end': 6.3, 'p': 1.0}]
    lead = 5.0; at = lambda t: round(5.0 - lead + t, 2)
    previous = [{'text': ' b', 'start': at(4.95), 'end': at(5.2), 'p': 1.0}]
    l = live.words_line(2, 5.0, 9.0, 'pause', engine_words, RUN, at='T', lead=lead, previous=previous)
    assert [w['text'] for w in l['words']] == [' c', ' d'], l   # a is context, b is the previous piece's word at the cut
    assert l['words'][0]['start'] == at(5.0) and l['from'] == 5.0 and l['to'] == 9.0
    solo = live.words_line(0, 0.0, 9.0, 'pause', engine_words, RUN, at='T')
    assert len(solo['words']) == 4   # no context, no filter
    ahead = live.words_line(2, 5.0, 5.5, 'pause', engine_words, RUN, at='T', lead=lead, previous=previous, ahead=3.0)
    assert [w['text'] for w in ahead['words']] == [' c'], ahead   # d starts after the piece's end: the next piece reads it

def test_a_range_read_by_stop_reads_the_same_context():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Heard(folder, {'me': speech(100)})
        write_caf(folder / 'me.caf', np.zeros(100 * 48000, np.float32))
        live.read_range(folder, 'me', 30.0, 100.0, engine=m.engine, cut=m.cut)
        lines = live.read_words(folder / 'live' / 'me-words.jsonl')
        starts = [w['start'] for l in lines for w in l['words']]
        assert starts == sorted(starts) and len(set(starts)) == len(starts) and starts[0] >= 30.0 - live.EDGE_S, starts[:5]
        assert m.cuts[0][1] == 30.0 - live.CONTEXT_S, m.cuts[0]
        assert {c[0] for c in m.engine_calls} == {ne.PARAKEET.name} and not (folder / 'live' / 'me-doubt.jsonl').exists()   # stop's fallback never waits for the second reader

# ---------- the name list reaches the engine (L5) ----------

def test_every_engine_call_of_the_reader_gets_the_name_list_and_no_boost():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        assert m.run(builder=lambda f: ['Gio', 'Tianxin Chen']) == 0
        assert len(m.kws) == 10 and all(kw.get('phrases') == ['Gio', 'Tianxin Chen'] and 'boost' not in kw for kw in m.kws), m.kws   # both readers, the tail too
        assert json.loads((folder / 'live' / 'state.json').read_text())['lexicon'] == 'written'

def test_a_failed_lexicon_logs_one_line_and_the_reader_goes_on_with_no_phrases():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        def broken(f): raise RuntimeError('no mail index')
        out = io.StringIO()
        with contextlib.redirect_stdout(out): assert m.run(builder=broken) == 0
        assert len(m.kws) == 10 and all('phrases' not in kw and 'boost' not in kw for kw in m.kws), m.kws
        assert out.getvalue().count('no name list') == 1, out.getvalue()
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert state['lexicon'] == 'failed: no mail index' and len(live.read_words(folder / 'live' / 'me-words.jsonl')) == 3, state

def test_a_lexicon_that_exits_does_not_stop_the_reader():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70)}, stop_at=72)
        def exits(f): sys.exit('not a call folder')
        with contextlib.redirect_stdout(io.StringIO()): assert m.run(builder=exits) == 0
        assert json.loads((folder / 'live' / 'state.json').read_text())['lexicon'] == 'failed: not a call folder'

def test_a_range_read_by_stop_gets_the_names_the_lexicon_wrote():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        (folder / 'lexicon.json').write_text(json.dumps({'entries': [{'text': 'Tianxin Chen', 'source': 'invitee'}, {'text': 'Core Strategy', 'source': 'title'}]}))
        m = Heard(folder, {'me': speech(100)}); seen = []
        write_caf(folder / 'me.caf', np.zeros(100 * 48000, np.float32))
        live.read_range(folder, 'me', 30.0, 100.0, engine=lambda *a, **kw: (seen.append(kw), m.engine(*a))[1], cut=m.cut)
        assert seen and all(kw.get('phrases') == ['Tianxin Chen', 'Tianxin', 'Chen'] and 'boost' not in kw for kw in seen), seen

# ---------- the second reader: Nemotron reads each piece right after Parakeet (L4) ----------

def names(calls, model): return [c[1] for c in calls if c[0] == model.name]

def test_two_engine_calls_per_piece_in_order_and_the_wav_goes_after_both():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70)}, stop_at=72)
        assert m.run() == 0
        order = [(c[0], c[1]) for c in m.engine_calls]
        assert order[:4] == [(ne.PARAKEET.name, 'me-0000.wav'), (ne.NEMOTRON.name, 'me-0000.wav'), (ne.PARAKEET.name, 'me-0001.wav'), (ne.NEMOTRON.name, 'me-0001.wav')], order
        assert order[4] == (ne.PARAKEET.name, 'me-0002.wav') and len(order) == 5, order   # the tail is read by Parakeet alone
        assert all(c[2] for c in m.engine_calls), 'the piece wav must still exist for the second reader'
        assert not list((folder / 'live' / 'pieces').glob('*.wav'))
        first, doubt = live.read_words(folder / 'live' / 'me-words.jsonl'), live.read_words(folder / 'live' / 'me-doubt.jsonl')
        assert [(l['piece'], l['from'], l['to'], l['reason']) for l in doubt] == [(l['piece'], l['from'], l['to'], l['reason']) for l in first[:2]], doubt
        assert doubt[0]['engine_s'] == 1.3 and doubt[0]['peak_gb'] == 1.8 and first[0]['engine_s'] == 0.6   # engine seconds per piece, for both readers
        assert doubt[1]['words'][0]['start'] == round(doubt[1]['from'] + 1.0, 2)   # the same call clock as the first reader

def test_the_second_reader_gets_the_same_window_and_the_same_keep_rule():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Heard(folder, {'me': speech(70)}, stop_at=72); m.lengths = []; m.second_lengths = []
        assert m.run() == 0
        assert m.second_lengths == m.lengths[:2], (m.lengths, m.second_lengths)   # context, piece and the audio past the cut: the same wav
        first, doubt = live.read_words(folder / 'live' / 'me-words.jsonl'), live.read_words(folder / 'live' / 'me-doubt.jsonl')
        for a, b in zip(first[:2], doubt): assert a['words'] == b['words'] and b['words'], 'the same fixed meeting: the same words kept'
        starts = [w['start'] for l in doubt for w in l['words']]
        assert starts == sorted(starts) and len(set(starts)) == len(starts), 'a word kept twice across the second reader\'s pieces'

def test_state_counts_the_second_readers_pieces_seconds_and_the_duty_cycle():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        m.run()
        state = json.loads((folder / 'live' / 'state.json').read_text())
        me = state['sides']['me']
        assert me['pieces'] == 3 and me['doubt_pieces'] == 2 and me['engine_s'] == 1.8 and me['doubt_engine_s'] == 2.6 and me['doubt_peak_gb'] == 1.8 and me['doubt_errors'] == 0, me
        heard = max(s['heard_s'] for s in state['sides'].values())
        # engine seconds of both sides over the seconds of meeting: 3.6 s first reader, 5.2 s second reader
        assert state['duty'] == {'first': round(3.6 / heard, 3), 'second': round(5.2 / heard, 3), 'both': round(8.8 / heard, 3)}, state['duty']

def test_a_second_reader_that_falls_behind_never_holds_up_the_tail_and_those_pieces_stay_unmarked():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(100), 'them': speech(100)}, stop_at=90); m.second_s = 30.0   # each Nemotron read takes 30 s of meeting
        assert m.run() == 0
        done = json.loads((folder / 'live' / 'done.json').read_text())
        assert set(done['tail']) == {'me', 'them'} and done['tail']['me']['to_s'] > 0
        for side in ('me', 'them'):
            first, doubt = live.read_words(folder / 'live' / f'{side}-words.jsonl'), live.read_words(folder / 'live' / f'{side}-doubt.jsonl')
            assert 0 < len(doubt) < len(first) - 1, (len(doubt), len(first))   # behind: some pieces never reached the second reader
        calls = m.engine_calls
        after_stop = calls[[i for i, c in enumerate(calls) if c[0] == ne.NEMOTRON.name][-1] + 1:]
        assert after_stop and all(c[0] == ne.PARAKEET.name for c in after_stop), calls   # once stop was asked, only the tail's Parakeet reads ran
        assert not list((folder / 'live' / 'pieces').glob('*.wav')), 'unread pieces leave no wav behind'
        tracks, info = live.build_tracks(folder)
        first_t = sum(l['to'] - l['from'] for l in live.read_words(folder / 'live' / 'me-words.jsonl'))
        second_t = sum(l['to'] - l['from'] for l in live.read_words(folder / 'live' / 'me-doubt.jsonl'))
        assert info['tail_unmarked_s'] > 0 and abs(info['tail_unmarked_s'] - ((first_t - second_t) * 2)) < 0.1, info['tail_unmarked_s']

def test_a_second_reader_failure_leaves_the_piece_to_the_first_reader_alone():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        class Fails(Meeting):
            def engine(self, model, wav, *a, **kw):
                if Path(model).name == ne.NEMOTRON.name and not self.engine_calls.count('boom'):
                    self.engine_calls.append('boom'); sys.exit('nemo-speech failed (1) on piece')
                return Meeting.engine(self, model, wav, *a, **kw)
        m = Fails(folder, {'me': speech(70)}, stop_at=72)
        assert m.run() == 0
        assert [l['piece'] for l in live.read_words(folder / 'live' / 'me-words.jsonl')] == [0, 1, 2]
        assert [l['piece'] for l in live.read_words(folder / 'live' / 'me-doubt.jsonl')] == [1]
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert state['sides']['me']['doubt_errors'] == 1 and state['sides']['me']['errors'] == 0 and state['sides']['me']['failed'] == [], state['sides']['me']
        assert 'nemo-speech failed' in state['error'] and not list((folder / 'live' / 'pieces').glob('*.wav'))   # nothing for stop's fallback to redo

def test_live_words_get_the_fills_and_marks_transcribe_gives_and_the_unread_tail_none():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        class Names(Meeting):
            def engine(self, model, wav, *a, **kw):
                side = Path(wav).name.split('-')[0]; lead = live.CONTEXT_S if [c for c in self.cuts if c[0] == side][-1][1] > 0 else 0.0
                heard = 'Hello Sam Li from Citi.' if Path(model).name == ne.NEMOTRON.name else 'Hello Sam Lee from Citi.'
                self.engine_calls.append((Path(model).name, Path(wav).name, True))
                return W(heard, lead + 1.0), RUN
        m = Names(folder, {'me': speech(70)}, stop_at=72)
        assert m.run() == 0
        tracks, info = live.build_tracks(folder)
        marked = transcript.marks(tracks['me'])
        assert {x['word'] for x in marked} == {'Lee'} and len(marked) == 2, marked   # the two pieces the second reader read; the tail is unmarked
        assert any('Lee' in l['text'] and '(unclear' in transcript.markdown([{**l, 'who': 'Me'}], lambda l: l['who']) for l in tracks['me']), 'transcript.md carries the (unclear) mark'
        edge = live.read_words(folder / 'live' / 'me-doubt.jsonl')[-1]['to']
        tail = [w for l in tracks['me'] for w in l['words'] if w['start'] >= edge]
        assert tail and all(w['p'] == 1.0 for w in tail) and info['tail_unmarked_s'] > 0
        assert info['agreement']['me']['marked'] == 2

def heard_events(home):
    runs = sorted((Path(home) / 'runs').glob('*'))
    return runs, [json.loads(l) for r in runs for l in (r / 'events.jsonl').read_text().splitlines() if l.strip()]

def test_the_reader_writes_meeting_heard_at_most_every_30_seconds_into_its_own_run():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d); home = Path(d) / 'home'
        m = Meeting(folder, {'me': speech(100), 'them': speech(100)}, stop_at=102)
        assert m.run(events_home=home) == 0
        runs, events = heard_events(home)
        assert len(runs) == 1 and [e['type'] for e in events][:2] == ['run.started', 'meeting.heard'], events[:2]
        assert events[0]['data'] == {'source': 'call', 'title': 'T', 'workstream': None}
        heard = [e for e in events if e['type'] == 'meeting.heard']
        assert 3 <= len(heard) <= 4, len(heard)   # a 102 s meeting, one per 30 s: never one per 2 s tick
        assert [e['seq'] for e in events] == list(range(1, len(events) + 1))
        for e in heard:
            assert e['text'] == 'Loggie is listening' and e['step'] is None and set(e) == {'v', 'run', 'seq', 'at', 'type', 'step', 'text', 'data'}
            assert set(e['data']) == {'call', 'heard_s', 'read_s', 'behind_s', 'pieces'} and e['data']['call'] == 'call'
        assert [e['data']['heard_s'] for e in heard] == sorted(e['data']['heard_s'] for e in heard) and heard[-1]['data']['heard_s'] > 60 and heard[-1]['data']['pieces'] >= 2
        assert all(e['data']['behind_s'] >= 0 for e in heard)
        text = (runs[0] / 'events.jsonl').read_text()
        assert 'hello' not in text and 'okay sure' not in text, 'no transcript words in an event'

def test_no_events_home_writes_no_events_and_a_broken_one_does_not_stop_the_reader():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(40), 'them': speech(40)}, stop_at=42)
        assert m.run() == 0 and not (Path(d) / 'runs').exists()
        blocked = Path(d) / 'blocked'; blocked.write_text('a file where the folder should be')
        folder2 = Path(d) / 'call2'; folder2.mkdir(); (folder2 / 'event.json').write_text('{"title": "T"}')
        m2 = Meeting(folder2, {'me': speech(40), 'them': speech(40)}, stop_at=42)
        assert m2.run(events_home=blocked) == 0 and (folder2 / 'live' / 'done.json').exists()

# ---------- the stream engine on its own thread (3A) and a reader that dies (3D), 2026-10-27 ----------

class FakeStreams:
    # stream.Streams as the reader sees it: stats() each save, stop() once at the end
    def __init__(self): self.stopped = 0
    def stats(self): return {'status': 'stopped' if self.stopped else 'streaming'}
    def stop(self): self.stopped += 1

def until(cond, timeout=2.0):
    t0 = time.time()
    while not cond() and time.time() - t0 < timeout: time.sleep(0.01)
    return cond()

def test_the_stream_engine_loads_on_its_own_thread_and_the_first_piece_never_waits_for_it():
    # 2026-10-27: the reader waited up to 60 s for the stream engine before its first piece; at load 100+ it never answered
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        read, seen, streams, engine = threading.Event(), {}, FakeStreams(), m.engine
        def first_piece(model, wav, *a, **kw): read.set(); return engine(model, wav, *a, **kw)
        m.engine = first_piece
        def slow(f):
            seen['piece_first'] = read.wait(2.0)   # an engine that is ready only once the reader has read a piece
            return streams
        with contextlib.redirect_stdout(io.StringIO()): assert m.run(streamer=slow) == 0
        assert seen['piece_first'] is True, 'the first piece waited for the stream engine'
        assert m.states[0]['stream'] == {'status': 'starting'}, m.states[0].get('stream')   # the first tick saves while the engine loads
        assert streams.stopped == 1 and len(live.read_words(folder / 'live' / 'me-words.jsonl')) == 3
        assert stream.READY_S == 20.0

def test_a_stream_engine_ready_only_after_the_reader_ended_is_stopped_and_never_judged():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        m = Meeting(folder, {'me': speech(20), 'them': speech(20)}, stop_at=22)
        streams, seen, out = FakeStreams(), {}, io.StringIO()
        def late(f):
            seen['done_first'] = until(lambda: (folder / 'live' / 'done.json').exists())
            return streams
        with contextlib.redirect_stdout(out): assert m.run(streamer=late) == 0
        assert seen['done_first'] is True and streams.stopped == 1, (seen, streams.stopped)   # the run waits for it, then stops it: no engine left running
        assert not (folder / 'live' / 'stream-check.json').exists() and 'ready only after the reader ended' in out.getvalue()

def test_a_reader_that_dies_on_a_file_not_ready_yet_says_why_and_starts_once_more():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        class Late(Meeting):
            fixed = False
            def sleep(self, s):
                if not self.fixed: self.fixed = True; write_caf(self.folder / 'me.caf', np.zeros(0, np.float32))   # the recorder catches up
                Meeting.sleep(self, s)
        m = Late(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        (folder / 'me.caf').write_bytes(caf_bytes(b'')[:0x80])   # the header, no data chunk yet
        out = io.StringIO()
        with contextlib.redirect_stdout(out): assert m.run() == 0
        assert 'no data chunk yet' in out.getvalue() and 'starting it again, once' in out.getvalue(), out.getvalue()[-400:]
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert len(state['restarts']) == 1 and 'no data chunk yet' in state['restarts'][0]['why'], state.get('restarts')
        assert [l['piece'] for l in live.read_words(folder / 'live' / 'me-words.jsonl')] == [0, 1, 2] and (folder / 'live' / 'done.json').exists()
        assert m.lexed == [folder], 'the name list is built once'

def test_a_reader_whose_loop_raises_starts_once_more_and_never_reads_a_piece_twice():
    with tempfile.TemporaryDirectory() as d:
        folder = meeting_folder(d)
        class Dies(Meeting):
            died = False
            def sleep(self, s):
                Meeting.sleep(self, s)
                if not self.died and self.clock >= 40: self.died = True; raise OSError('disk hiccup')
        m = Dies(folder, {'me': speech(70), 'them': speech(70)}, stop_at=72)
        out = io.StringIO()
        with contextlib.redirect_stdout(out): assert m.run() == 0
        assert m.died and 'OSError: disk hiccup' in out.getvalue() and 'starting it again, once' in out.getvalue()
        for side in ('me', 'them'):
            lines = live.read_words(folder / 'live' / f'{side}-words.jsonl')
            assert [l['piece'] for l in lines] == [0, 1, 2] and lines[0]['from'] == 0.0 and lines[-1]['to'] == 70.0, lines
            assert all(a['to'] == b['from'] for a, b in zip(lines, lines[1:])), [(l['from'], l['to']) for l in lines]
        state = json.loads((folder / 'live' / 'state.json').read_text())
        assert state['restarts'][0]['why'] == 'OSError: disk hiccup' and state['sides']['me']['pieces'] == 3
        assert live.gaps(folder, json.loads((folder / 'live' / 'done.json').read_text())) == ({'me': [], 'them': []}, None)   # stop can use every live word
        assert not list((folder / 'live' / 'pieces').glob('*.wav'))

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
