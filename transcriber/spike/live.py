# Live transcription, the pure parts (increment L1 of spec-live-transcription.md): what the live reader decides, as
# functions on bytes, arrays and files, with no engine, no ffmpeg and no clock of their own.
#   caf_info, heard_s      the recorder's growing CAF: its header, and how many seconds are on disk (B20)
#   next_piece, loud_seconds, floor_of, is_silent
#                          where the next piece of the meeting is cut, and whether it holds any speech (B21)
#   words_line, read_words one line per piece in live/<side>-words.jsonl and -doubt.jsonl, times on the call's clock (B21)
#   build_tracks           the live words into the tracks transcribe() returns, same fill, agree and marks (B23)
#   run                    the live reader process: the loop, the engine calls, the state, the stop handshake (increment L2, B21, B22)
#   agreement, live_check  the quality guard against the batch reading of the same audio (B25, falsifier F7)
#   streamed_words, write_readable
#                          the readable live transcript: Parakeet's words where a piece was read, the stream's after (stream.py)
import difflib, json, os, struct, subprocess, sys, threading, time, wave
from datetime import datetime
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
import nvidia_engine as ne, sendgate, tools, transcript
from nvidia_asr import read_wav, rms_frames

PIECE_S = 30.0      # a piece is cut once this much new audio is on disk: the tail at stop is at most one piece, and pieces of
                    # 30 s kept more of the whole file's words than 60 s (spec 2.2)
CONTEXT_S = 8.0     # each piece is read with this much of the audio before it, and only the piece's own words are kept: a piece read
                    # cold lost words at both ends and dropped quiet speech at the start (measured on 3 min of a real call: agreement 0.889 -> 0.927, spec 2.2)
LOOKAHEAD_S = 10.0  # a pause-cut piece also gets up to this much of the audio already on disk after its cut (never waited for: the
                    # cut lands up to SEARCH_S before the end of what is heard). 0.64 s of opening speech came back with it
EDGE_S = 0.3        # a word that starts this close before the piece still counts as its own (the cut can land inside a word)
DUP_S = 0.5         # the same word within this many seconds of one the previous piece kept is that word, read twice
SEARCH_S = 10.0     # the cut lands at the quietest frame in the last this-many seconds of the stretch
PIECE_MIN_S = 10.0  # a stretch this long that ends in QUIET_S of quiet is cut at once, so a paused meeting flushes
QUIET_S = 3.0       # how much quiet at the end counts as a pause
MIN_LOUD_S = 1.0    # a piece with less sound than this is never sent to an engine (no spawn for silence, D6)
TAIL_WAIT_S = 20    # how long stop waits for the reader to read the tail (L2, L3)
TICK_S = 2.0        # how often the loop looks at the two files: a stretch is read within this long of being cut-ready
GRACE_S = 5.0       # the recorder is gone and no live/stop yet: stop is still unlinking STATE and polling, wait this long for its file
HOP = 0.03          # the same 30 ms frame as nvidia_asr.cuts and nvidia_engine.loudness
HEARD_EVERY_S = 30.0  # meeting.heard (L7): at most one event this often; the end card in Loggie shows the latest
HEARD_TEXT = 'Loggie is listening'   # fixed, plain: never a model, never a word of the call
THRESHOLD = {'agreement': 0.95, 'words': 0.96, 'marks': '1.3x + 2'}   # F7; the builder may tighten these, never loosen them

# ---------- the recorder's file (B20) ----------

class LiveFormat(Exception):
    # The recorder's file is not the one live reading is written for; the reader stops loudly and stop falls back to batch.
    pass

def caf_info(path):
    # Chunks after the 8-byte file header: type (4 bytes), size (signed 64-bit, -1 = open-ended); `desc` holds the format.
    # The first sample is 4 bytes (the edit count) after the data chunk's header; every file seen has it at 0x1000.
    with open(path, 'rb') as f:
        head = f.read(8)
        if head[:4] != b'caff': raise LiveFormat(f'{path}: not a CAF file (no caff magic, found {head[:4]!r})')
        desc, pos = None, 8
        while True:
            f.seek(pos); h = f.read(12)
            if len(h) < 12: raise LiveFormat(f'{path}: no data chunk yet ({pos} bytes read)')
            kind, size = h[:4], struct.unpack('>q', h[4:])[0]
            if kind == b'desc':
                rate, fmt, flags, _, _, channels, bits = struct.unpack('>d4sIIIII', f.read(32)); desc = (rate, fmt, flags, channels, bits)
            elif kind == b'data':
                if desc is None: raise LiveFormat(f'{path}: data chunk before the desc chunk')
                break
            if size < 0: raise LiveFormat(f'{path}: open-ended {kind!r} chunk before the data chunk')
            pos += 12 + size
    rate, fmt, flags, channels, bits = desc
    # Any mic rate the Mac gives: the recorder asks for 48 kHz, but a Bluetooth headset's mic (AirPods Pro, 2026-10-27)
    # records at its own 24 kHz, and the call showed no live words. Pieces are cut by seconds and the stream sends the rate.
    if (channels, bits, fmt, flags) != (1, 32, b'lpcm', 3) or not 8000 <= rate <= 192000:
        raise LiveFormat(f'{path}: live reading needs 1 channel, 32-bit float little endian, 8 to 192 kHz; found {rate:g} Hz, {channels} channel(s), {bits}-bit, format {fmt!r}, flags {flags}')
    return {'rate': int(rate), 'channels': 1, 'bits': 32, 'float': True, 'data_offset': pos + 12 + 4}

def heard_s(path, info):
    # Seconds of audio on disk, from the file size alone (the write lag is about 0.5 s). Whole frames only.
    frames = max(0, Path(path).stat().st_size - info['data_offset']) // 4
    return frames / info['rate']

# ---------- the cut rule (B21) ----------

def floor_of(rms):
    # Which frames are louder than the room: nvidia_engine.loudness's rule (max(0.004, 3x the 20th percentile)).
    return float(max(0.004, np.percentile(rms, 20) * 3)) if len(rms) else 0.004

def loud_seconds(rms, floor): return float((rms > floor).sum()) * HOP

def is_silent(rms, floor): return loud_seconds(rms, floor) < MIN_LOUD_S

def next_piece(from_s, heard_s, rms, floor):
    # `rms` is the RMS of the new stretch [from_s, heard_s], frame i starting at from_s + i * HOP (the 16 kHz audio ffmpeg
    # just cut). Returns (to_s, reason): 'pause' = the quietest frame in the last SEARCH_S of a stretch of PIECE_S or more,
    # 'quiet' = PIECE_MIN_S reached and the last QUIET_S under the floor (cut at heard_s), else (None, 'none').
    length = round(heard_s - from_s, 3)   # sums of floats must still reach PIECE_S exactly
    if length >= PIECE_S:
        a = max(0, int((length - SEARCH_S) / HOP)); b = min(len(rms), int(length / HOP))
        return round(from_s + (a + int(np.argmin(rms[a:b]))) * HOP, 2), 'pause'
    n = int(round(QUIET_S / HOP))
    if length >= PIECE_MIN_S and len(rms) >= n and bool((rms[-n:] <= floor).all()): return round(heard_s, 2), 'quiet'
    return None, 'none'

# ---------- the words files (B21) ----------

def own_words(words, from_s, previous=()):
    # The words of a piece read with context, already on the call's clock: those that start at the piece (EDGE_S of slack)
    # and are not one the previous piece's words already hold (same word, within DUP_S).
    held = [(ne.key(p['text']), p['start']) for p in previous]
    return [w for w in words if w['start'] >= from_s - EDGE_S and not any(k == ne.key(w['text']) and abs(t - w['start']) <= DUP_S for k, t in held)]

def context_from(from_s): return round(max(0.0, from_s - CONTEXT_S), 2)

def words_line(piece, from_s, to_s, reason, words, info, at=None, lead=0.0, previous=(), ahead=0.0):
    # One line of live/<side>-words.jsonl (or -doubt.jsonl): the engine's words for the piece [from_s, to_s], moved from the
    # audio's clock onto the call's. The audio began `lead` seconds before the piece (its context) and ran `ahead` seconds past
    # it: the words outside the piece are dropped.
    # `info` is the run's info dict from nvidia_engine.run; `previous` the words the piece before it kept.
    base = from_s - lead
    moved = [{'text': w['text'], 'start': round(base + w['start'], 2), 'end': round(base + w['end'], 2), 'p': w.get('p', 1.0)} for w in words]
    if lead: moved = own_words(moved, from_s, previous)
    if ahead: moved = [w for w in moved if w['start'] < to_s]
    return {'piece': piece, 'from': round(from_s, 2), 'to': round(to_s, 2), 'reason': reason,
            'words': moved,
            'engine_s': info.get('seconds'), 'peak_gb': info.get('peak_gb'), 'at': at or datetime.now().astimezone().isoformat(timespec='seconds')}

def last_words(path, before_s):
    # The words of the piece that ends last at or before `before_s` in a words file: the ones a piece starting there must not repeat.
    lines = [l for l in read_words(path) if l['to'] <= before_s + HOP]
    return max(lines, key=lambda l: l['to'])['words'] if lines else []

def read_words(path):
    path = Path(path)
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []

# ---------- the tracks transcribe() would return (B23) ----------

def assemble(folder, sides, markable=transcript.markable):
    # The pure steps of call.transcribe, in its order, over {side: (parakeet words, second reader's words)}: fill, then
    # what both readers established, then agree, the capital clue, and the lines. Returns tracks, agreement, fills.
    read, fills = {}, {}
    for side, (words, other) in sides.items():
        words, fills[side] = ne.fill(words, other)
        read[side] = (words, other)
    established, lexicon = ne.confirmed(read.values()), ne.lexicon_keys(folder)
    tracks, agreement = {}, {}
    for side, (words, other) in read.items():
        words, agreement[side] = ne.agree(words, other, markable, established=established, lexicon=lexicon)
        words, clues = ne.capital_clue(words, established, lexicon); agreement[side]['capital_clue'] = clues; agreement[side]['marked'] += len(clues)
        tracks[side] = ne.lines_of(words)
    return tracks, agreement, fills, lexicon

def sides_in(folder):
    # The sides this call folder reads (transcript.sides_of its event.json): both, or one side of a split recording.
    return transcript.sides_of(read_json(Path(folder) / 'event.json') or {})

def link_split(folder):
    # The Mac-sound folder of a split recording ("sides" ["them"], "split" {"with": <the room's folder>}) reads the room
    # folder's them.caf under its own name: a hard link, the same file growing as the recorder writes it, nothing copied
    # (2026-10-28). Linked again when the recorder replaced the file. True once this folder's them.caf is that file.
    folder = Path(folder); event = read_json(folder / 'event.json') or {}
    other = (event.get('split') or {}).get('with')
    if not other or transcript.sides_of(event) != ('them',): return False
    src, dst = folder.parent / other / 'them.caf', folder / 'them.caf'
    if not src.exists(): return False
    if dst.exists() and dst.stat().st_ino == src.stat().st_ino: return True
    dst.unlink(missing_ok=True)
    try: os.link(src, dst)
    except FileExistsError: pass   # the start and the reader both linked it
    return dst.stat().st_ino == src.stat().st_ino

def live_sides(folder):
    # The live words and the second reader's words per side, and the pieces that have no second-reader line (the tail
    # at stop, or every piece when the second reader does not run live), as seconds: those words stay unmarked.
    sides, pieces, unmarked = {}, {}, 0.0
    for side in sides_in(folder):
        lines = sorted(read_words(Path(folder) / 'live' / f'{side}-words.jsonl'), key=lambda l: l['from']); doubt = read_words(Path(folder) / 'live' / f'{side}-doubt.jsonl')   # a range stop read itself lands last in the file
        sides[side] = ([w for l in lines for w in l['words']], [w for l in doubt for w in l['words']])
        pieces[side] = len(lines)
        have = {l['piece'] for l in doubt}
        unmarked += sum(l['to'] - l['from'] for l in lines if l['piece'] not in have)
    return sides, pieces, round(unmarked, 2)

def build_tracks(folder, markable=transcript.markable, now=None):
    # live/*.jsonl -> (tracks, info) as call.transcribe returns them, info shaped for version.json (call.py:223-229) with
    # gap_check 'deferred' (the check pass runs it).
    t0 = time.perf_counter(); folder = Path(folder)
    sides, pieces, unmarked = live_sides(folder)
    tracks, agreement, fills, lexicon = assemble(folder, sides, markable)
    done = json.loads((folder / 'live' / 'done.json').read_text()) if (folder / 'live' / 'done.json').exists() else {}
    tail = lambda side: done.get('tail', {}).get(side, {}).get('engine_s')
    info = {'version': 'v1', 'created': now or datetime.now().astimezone().isoformat(timespec='seconds'), 'engine': 'nvidia', 'live': True,
            'model': ne.PARAKEET.name, 'second_reader': ne.NEMOTRON.name, 'mark_rule': transcript.NVIDIA_RULE, 'piece_s': PIECE_S,
            'echo_s': ne.ECHO_S, 'echo_share': ne.ECHO_SHARE, 'fill_s': ne.FILL_S, 'prompt': '', 'prompt_tokens': 0, 'terms': sorted(lexicon),
            'established_min': ne.ESTABLISHED, 'threshold': transcript.THRESHOLD, 'pieces': pieces, 'tail_unmarked_s': unmarked,
            'timings_s': {**{f'tail_{side}': tail(side) for side in sides}, 'build': round(time.perf_counter() - t0, 2)},
            'agreement': agreement, 'filled': fills, 'gap_check': 'deferred'}
    return tracks, info

# ---------- the quality guard (B25, F7) ----------

def agreement(a_words, b_words):
    # Words that are equal (ne.key, difflib's matching blocks) over b's word count: 1.0 when b has no words.
    a = [ne.key(w['text']) for w in a_words]; b = [ne.key(w['text']) for w in b_words]
    if not b: return 1.0
    return sum(m.size for m in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks()) / len(b)

def batch_sides(v2, sides=transcript.SIDES):
    # The check pass's two readers per side, from the json it kept (nvidia_engine.words_of_json).
    out = {}
    for side in sides:
        out[side] = tuple(ne.words_of_json(json.loads((Path(v2) / f'{side}-{reader}.json').read_text()))[0] for reader in ('parakeet', 'nemotron'))
    return out

def live_check(folder, now=None, v2=None):
    # v1 (the live words, as build_tracks reads them) against v2-check (the batch readers on the same audio), per side.
    # Writes <folder>/live-check.json and returns it. The marks of both go through the same steps, so a difference is the
    # reading, not the rule. v2's boosted label pass is not repeated here.
    folder = Path(folder); v2 = Path(v2) if v2 else folder / 'v2-check'
    sides, _, _ = live_sides(folder); batch = batch_sides(v2, tuple(sides))
    live_tracks, _, _, _ = assemble(folder, sides); batch_tracks, _, _, _ = assemble(folder, batch)
    flat = lambda tracks, side: [w for l in tracks[side] for w in l['words']]
    gap = json.loads((v2 / 'version.json').read_text()).get('gap_check') if (v2 / 'version.json').exists() else None
    out = {'v1': {}, 'v2': {}, 'agreement': {}, 'words_ratio': {}, 'marks_ratio': {}}; ok = gap == 'clean'
    for side in sides:
        a, b = flat(live_tracks, side), flat(batch_tracks, side)
        ma, mb = len(transcript.marks(live_tracks[side])), len(transcript.marks(batch_tracks[side]))
        out['v1'][side] = {'words': len(a), 'marks': ma}; out['v2'][side] = {'words': len(b), 'marks': mb}
        out['agreement'][side] = agreement(a, b)
        out['words_ratio'][side] = round(len(a) / len(b), 3) if b else None
        out['marks_ratio'][side] = round(ma / mb, 3) if mb else None
        ok = ok and out['agreement'][side] >= THRESHOLD['agreement'] and len(a) >= THRESHOLD['words'] * len(b) and ma <= 1.3 * mb + 2
    out.update({'gap_check': 'clean' if gap == 'clean' else 'FAILED', 'pass': ok, 'thresholds': THRESHOLD, 'at': now or datetime.now().astimezone().isoformat(timespec='seconds')})
    (folder / 'live-check.json').write_text(json.dumps(out, indent=1))
    return out

# ---------- stop: what the reader left behind (B23, increment L3) ----------

def read_json(path):
    try: return json.loads(Path(path).read_text())
    except (OSError, ValueError): return None

def call_seconds(folder):
    # How long the call is, from what the reader recorded (no wav exists yet at stop): the most seconds any side heard.
    state = read_json(Path(folder) / 'live' / 'state.json') or {}
    heard = [s.get('heard_s', 0) for s in state.get('sides', {}).values()]
    lines = [l['to'] for side in sides_in(folder) for l in read_words(Path(folder) / 'live' / f'{side}-words.jsonl')]
    return max(heard + lines + [0.0])

def wait_for(path, timeout, alive, sleep=time.sleep, now=time.time, every=0.1):
    # True once `path` exists. Gives up at `timeout` seconds, or as soon as the process that should write it is gone.
    t0 = now()
    while True:
        if Path(path).exists(): return True
        if now() - t0 >= timeout or not alive(): return Path(path).exists()
        sleep(every)

def gaps(folder, done):
    # What the live words do not cover, per side, as [from_s, to_s] ranges stop must read itself: ranges the reader failed
    # (state.json), and the unread end when the reader never wrote done.json. Returns (ranges, why_not): `why_not` is a
    # sentence when the live words cannot be used at all (no state, a file the reader cannot parse, a words file that lost
    # lines) and stop must read the whole call the way it always did.
    folder = Path(folder); state = read_json(folder / 'live' / 'state.json')
    if not isinstance(state, dict) or 'sides' not in state: return {}, 'the reader left no state.json'
    ranges = {side: [] for side in sides_in(folder)}
    for side in ranges:
        s = state['sides'].get(side) or {}
        lines = read_words(folder / 'live' / f'{side}-words.jsonl')
        if s.get('pieces', 0) > len(lines): return {}, f'{side}-words.jsonl holds {len(lines)} of the {s["pieces"]} pieces the reader counted'
        ranges[side] += [list(r) for r in s.get('failed', [])]
        if done is None:
            caf = folder / f'{side}.caf'
            if not caf.exists(): continue
            try: heard = heard_s(caf, caf_info(caf))
            except LiveFormat as error: return {}, str(error)
            start = max([s.get('read_s', 0.0)] + [l['to'] for l in lines])
            if heard - start >= HOP: ranges[side].append([round(start, 2), round(heard, 2)])
    return ranges, None

# ---------- the reader process (B21, B22) ----------

def ffmpeg_cut(ffmpeg, caf, from_s, length, wav):
    # The same conversion as call.py's whole-file one (16 kHz mono), for the stretch [from_s, from_s + length] of the growing CAF.
    subprocess.run([ffmpeg, '-v', 'error', '-y', '-ss', f'{from_s:.2f}', '-t', f'{length:.2f}', '-i', str(caf), '-ar', '16000', '-ac', '1', str(wav)], check=True)

def build_lexicon(folder):
    # The names the meeting is likely to say, built once at start (0.2 to 0.3 s measured on three real calls) and written where the
    # readers look for them. Returns the person names, which every engine call carries as its speech context.
    import lexicon
    lexicon.write(folder, lexicon.build(folder))
    return ne.people(folder)

def speech_context(names):
    # The engine's phrases for a name list; nothing at all when there is no list. Never the boost: ne.BOOST 4 on the live second
    # reader planted the names (Ryan 106 times, Jungbauer 49 in 2 min, agreement 0.941 -> 0.932), the same as nvidia_engine.BOOST's note.
    return {'phrases': names} if names else {}

def iso(t): return datetime.fromtimestamp(t).astimezone().isoformat(timespec='seconds')

def write_json(path, data):
    # Whole file or none: a reader of state.json (stop, the card) never sees half of it.
    tmp = Path(str(path) + '.tmp'); tmp.write_text(json.dumps(data, indent=1)); os.replace(tmp, path)

def append_line(path, line):
    with open(path, 'a') as f: f.write(json.dumps(line) + '\n')

def write_piece(wav, x):
    with wave.open(str(wav), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())

def read_range(folder, side, from_s, to_s, engine=ne.run, cut=ffmpeg_cut, ffmpeg=tools.FFMPEG):
    # Read one range of a side's growing file the way the reader would have: pieces cut at the quietest frame (next_piece),
    # Parakeet on each, a line per piece appended to live/<side>-words.jsonl (build_tracks sorts by time). A silent piece is
    # skipped. An engine or ffmpeg failure raises with the piece wav kept. Returns {'words', 'engine_s', 'pieces'}.
    folder = Path(folder); live = folder / 'live'; (live / 'pieces').mkdir(parents=True, exist_ok=True)
    words_file = live / f'{side}-words.jsonl'; speech = speech_context(ne.people(folder))
    n = max([l['piece'] for l in read_words(words_file)] + [-1]) + 1
    total = {'words': 0, 'engine_s': 0.0, 'pieces': 0}; pos = from_s
    while to_s - pos >= HOP:
        window = min(to_s - pos, PIECE_S); probe = live / 'pieces' / f'{side}-range.wav'
        ctx = context_from(pos); lead = round(pos - ctx, 2); lead_n = int(round(lead * 16000))
        cut(ffmpeg, folder / f'{side}.caf', ctx, lead + window, probe); full = read_wav(probe); probe.unlink(); x = full[lead_n:]
        rms = rms_frames(x); floor = floor_of(rms)
        if to_s - pos > PIECE_S:
            end, reason = next_piece(pos, pos + window, rms, floor)
        else: end, reason = round(pos + len(x) / 16000, 2), 'tail'
        n_own = int(round((end - pos) * 16000)); ahead = x[n_own:n_own + int(LOOKAHEAD_S * 16000)]; x = x[:n_own]
        if end <= pos: break
        if not is_silent(rms_frames(x), floor):
            wav = live / 'pieces' / f'{side}-fb{n:04d}.wav'; write_piece(wav, np.concatenate([full[:lead_n], x, ahead]))
            words, info = engine(ne.PARAKEET, wav, **speech); wav.unlink()
            append_line(words_file, words_line(n, pos, end, reason, words, info, at=iso(time.time()), lead=lead, previous=last_words(words_file, pos), ahead=len(ahead) / 16000))
            n += 1; total['words'] += len(words); total['engine_s'] = round(total['engine_s'] + (info.get('seconds') or 0), 2); total['pieces'] += 1
        pos = end
    return total

def heard_announcer(folder, events_home, now):
    # meeting.heard for Loggie's panel, in a run of its own under <events_home>/runs (opened with run.started on the first
    # event), at most one per HEARD_EVERY_S on the reader's clock. Seconds and counts only; nothing of the transcript. A
    # failure to write is logged once and never stops the reader. Returns announce(state); a no-op without an events_home.
    folder, last, run_dir, failed = Path(folder), [None], [], [False]
    def announce(state):
        if events_home is None or failed[0]: return
        sides = state['sides'].values(); heard = max(s['heard_s'] for s in sides)
        if heard <= 0 or (last[0] is not None and now() - last[0] < HEARD_EVERY_S): return
        try:
            if not run_dir:
                run_dir.append(sendgate.runs_root(events_home) / sendgate.new_run_id(datetime.fromtimestamp(now())))
                event = read_json(folder / 'event.json') or {}
                sendgate.emit(run_dir[0], 'run.started', None, None, {'source': 'call', 'title': event.get('title') or folder.name, 'workstream': event.get('workstream')})
            sendgate.emit(run_dir[0], 'meeting.heard', None, HEARD_TEXT, {'call': folder.name, 'heard_s': round(heard, 2), 'read_s': round(max(s['read_s'] for s in sides), 2),
                                                                        'behind_s': state['behind_s'], 'pieces': sum(s['pieces'] for s in sides)})
            last[0] = now()
        except Exception as error:
            failed[0] = True; print(f'live: no meeting.heard events: {error}', flush=True)
    return announce

RESTARTS = 1   # a reader that dies is started once more (2026-10-27: it died on the AirPods file and the call had no live words)

def run(folder, engine=ne.run, cut=ffmpeg_cut, ffmpeg=tools.FFMPEG, sleep=time.sleep, now=time.time, lexicon=build_lexicon, recorder_alive=lambda: True, stop_file=None, events_home=None, streamer=None):
    # The live reader: every TICK_S, per side, look at how much audio is on disk and read each stretch that is ready as one
    # piece (cut at a pause), with Parakeet, one engine call at a time. Ends on live/stop, or GRACE_S after the recorder is
    # gone, by reading what is left (the tail) and writing done.json. With an events_home it also tells Loggie it is still
    # listening (meeting.heard, at most every 30 s). With a `streamer` (stream.Streams.start: call.py passes it) the words also
    # stream onto the screen within about a second while the pieces still build the transcript. A reader that dies (an
    # exception, or a file it cannot read) says why and is started once more, going on from what it had read, never reading
    # a piece twice (2026-10-27). Returns the exit code: 0, 1 for a crash, or 2 for a file it cannot read.
    import traceback
    folder = Path(folder); announce = heard_announcer(folder, events_home, now); restarts = []
    for attempt in range(RESTARTS + 1):
        try: code = read_call(folder, engine, cut, ffmpeg, sleep, now, lexicon, recorder_alive, stop_file, announce, streamer, restarts)
        except Exception as error:
            code, why = 1, f'{type(error).__name__}: {error}'; print(traceback.format_exc().rstrip(), flush=True)
        else: why = (read_json(folder / 'live' / 'state.json') or {}).get('error') or f'exit {code}'
        if code == 0 or attempt == RESTARTS: return code
        restarts.append({'why': why, 'at': iso(now())})
        print(f'live: the reader stopped ({why}); starting it again, once', flush=True)
        sleep(TICK_S)
    return code

def read_call(folder, engine, cut, ffmpeg, sleep, now, lexicon, recorder_alive, stop_file, announce, streamer, restarts):
    # One run of the reader (run's loop). After a restart (`restarts` not empty) it goes on from state.json and the words files.
    folder = Path(folder); live = folder / 'live'; (live / 'pieces').mkdir(parents=True, exist_ok=True)
    stop_file = Path(stop_file or live / 'stop'); started = now()
    side_state = lambda: {'heard_s': 0.0, 'read_s': 0.0, 'pieces': 0, 'engine_s': 0.0, 'peak_gb': 0.0, 'skipped_silent': 0, 'errors': 0, 'failed': [],
                                 'doubt_pieces': 0, 'doubt_engine_s': 0.0, 'doubt_peak_gb': 0.0, 'doubt_errors': 0}
    own = sides_in(folder)   # one side of a split recording reads only its own file (2026-10-28)
    state = {'pid': os.getpid(), 'started': iso(started), 'sides': {side: side_state() for side in own}, 'behind_s': 0.0, 'lexicon': '', 'updated': iso(started)}
    infos, cuts_made, queue = {}, {side: 0 for side in own}, []   # queue: the pieces Parakeet read that the second reader has not, oldest first
    if restarts: state['restarts'] = list(restarts); resume(live, state, side_state, cuts_made)
    box, box_lock = {'streams': None, 'over': False}, threading.Lock()
    def save():
        state['behind_s'] = round(max(s['heard_s'] - s['read_s'] for s in state['sides'].values()), 2); state['updated'] = iso(now())
        # the readers' duty cycle: engine seconds of both sides over the seconds of meeting heard (spec 2.3: under 0.5 or L4 is cut)
        heard = max(s['heard_s'] for s in state['sides'].values()); first = sum(s['engine_s'] for s in state['sides'].values()); second = sum(s['doubt_engine_s'] for s in state['sides'].values())
        state['duty'] = {k: round(v / heard, 3) if heard else 0.0 for k, v in (('first', first), ('second', second), ('both', first + second))}
        state['cuts'] = dict(cuts_made)
        if box['streams']: state['stream'] = box['streams'].stats()
        with READABLE: write_json(live / 'state.json', state)
        announce(state)
    names = []
    if restarts and (folder / 'lexicon.json').exists(): names = ne.people(folder)   # written by the first run: not built twice
    else:
        try: names = lexicon(folder) or []; state['lexicon'] = 'written'
        except (Exception, SystemExit) as error: state['lexicon'] = f'failed: {error}'; print(f'live: no name list: {error}', flush=True)
    speech = speech_context(names)
    # The stream engine loads on its own thread and the pieces start on the first tick (2026-10-27): at load 100+ the engine
    # never answered in 60 s, and the reader sat idle the whole time. A late engine (stream.READY_S) is dropped.
    def start_stream():
        try: streams = streamer(folder)
        except Exception as error:
            state['stream'] = {'status': f'failed: {error}'}; print(f'live: no stream: {error}', flush=True); return
        with box_lock:
            late = box['over']
            if not late: box['streams'] = streams
        if late: streams.stop(); print('live: the stream engine was ready only after the reader ended; stopped', flush=True)
    def end_stream():
        # Once: no engine starts streaming after this. Returns the streams that ran, stopped, or None.
        with box_lock:
            if box['over']: return None
            box['over'] = True; streams = box['streams']
        if streams: streams.stop()
        return streams
    starter = threading.Thread(target=start_stream, name='stream-start', daemon=True) if streamer else None
    if starter: state['stream'] = {'status': 'starting'}; starter.start()
    save()
    try: return read_loop(folder, live, stop_file, state, infos, cuts_made, queue, save, speech, engine, cut, ffmpeg, sleep, now, recorder_alive, end_stream)
    finally:
        end_stream()
        if starter and starter.is_alive():
            import stream
            starter.join(stream.READY_S + 5)   # the engine process lives in its own session: never leave it running

def resume(live, state, side_state, cuts_made):
    # A restarted reader takes the sides from the state.json the first run left, and trusts the words files over it: a
    # piece whose line was written is read, whatever the last save said. Pieces Parakeet read that waited for the second
    # reader lose their wavs (they stay unmarked); a failed piece's wav stays for stop's fallback.
    old = read_json(live / 'state.json') or {}
    state['lexicon'] = old.get('lexicon', '')
    done = set()
    for side in list(state['sides']):
        s = {**side_state(), **((old.get('sides') or {}).get(side) or {})}
        lines = read_words(live / f'{side}-words.jsonl')
        s['pieces'] = len(lines); s['read_s'] = max([s['read_s']] + [l['to'] for l in lines])
        state['sides'][side] = s
        cuts_made[side] = max([int((old.get('cuts') or {}).get(side, 0))] + [l['piece'] + 1 for l in lines])
        done |= {(side, l['piece']) for l in lines}
    for wav in (live / 'pieces').glob('*-[0-9][0-9][0-9][0-9].wav'):
        side, n = wav.stem.split('-')
        if (side, int(n)) in done: wav.unlink()

def read_loop(folder, live, stop_file, state, infos, cuts_made, queue, save, speech, engine, cut, ffmpeg, sleep, now, recorder_alive, end_stream):
    # The loop itself, as it was before the restart and the stream thread: the pieces, the second reader, the tail.
    def stretch(side, from_s, to_s):
        # The audio [from_s, to_s] of the side as 16 kHz samples, through ffmpeg (or the injected cut), with the CONTEXT_S
        # before from_s in front. Returns (the piece's own samples, the context's sample count).
        wav = live / 'pieces' / f'{side}-probe.wav'; ctx = context_from(from_s)
        cut(ffmpeg, folder / f'{side}.caf', ctx, to_s - ctx, wav)
        x = read_wav(wav); wav.unlink(); lead_n = int(round((from_s - ctx) * 16000))
        return x[lead_n:], x[:lead_n]

    def read_piece(side, from_s, x, reason, context, ahead):
        # One piece, read with its context, to Parakeet and its words line. A failure keeps the wav (the fallback reads that
        # range) and goes on. The wav of a piece waits in the queue for the second reader; the tail has none (it would hold up stop).
        s = state['sides'][side]; n = cuts_made[side]; cuts_made[side] += 1
        to_s = round(from_s + len(x) / 16000, 2); wav = live / 'pieces' / f'{side}-{n:04d}.wav'
        try:
            write_piece(wav, np.concatenate([context, x, ahead]))
            words, info = engine(ne.PARAKEET, wav, **speech)
        except (Exception, SystemExit) as error:
            s['errors'] += 1; s['failed'].append([round(from_s, 2), to_s]); state['error'] = f'{side} {from_s:.2f}-{to_s:.2f}: {error}'
            print(f'live: {state["error"]}', flush=True)
            return {'from_s': round(from_s, 2), 'to_s': to_s, 'words': 0, 'engine_s': 0.0, 'skipped': False}
        append_line(live / f'{side}-words.jsonl', words_line(n, from_s, to_s, reason, words, info, at=iso(now()), lead=len(context) / 16000, previous=last_words(live / f'{side}-words.jsonl', from_s), ahead=len(ahead) / 16000))
        if reason == 'tail': wav.unlink()
        else: queue.append({'side': side, 'n': n, 'wav': wav, 'from_s': from_s, 'to_s': to_s, 'reason': reason, 'lead': len(context) / 16000, 'ahead': len(ahead) / 16000})
        s['pieces'] += 1; s['engine_s'] = round(s['engine_s'] + (info.get('seconds') or 0), 2); s['peak_gb'] = max(s['peak_gb'], info.get('peak_gb') or 0)
        write_readable(folder)
        return {'from_s': round(from_s, 2), 'to_s': to_s, 'words': len(words), 'engine_s': info.get('seconds'), 'skipped': False}

    def read_second(piece):
        # The same wav (context, piece, the audio past the cut) to the second reader, kept by the same rule. A failure costs the
        # piece its marks and nothing else: the first reader's words stand, and stop has nothing to redo.
        side, s = piece['side'], state['sides'][piece['side']]
        try:
            words, info = engine(ne.NEMOTRON, piece['wav'], language='en', chunk=ne.CHUNK_S, **speech)
            path = live / f'{side}-doubt.jsonl'
            append_line(path, words_line(piece['n'], piece['from_s'], piece['to_s'], piece['reason'], words, info, at=iso(now()), lead=piece['lead'], previous=last_words(path, piece['from_s']), ahead=piece['ahead']))
            s['doubt_pieces'] += 1; s['doubt_engine_s'] = round(s['doubt_engine_s'] + (info.get('seconds') or 0), 2); s['doubt_peak_gb'] = max(s['doubt_peak_gb'], info.get('peak_gb') or 0)
        except (Exception, SystemExit) as error:
            s['doubt_errors'] += 1; state['error'] = f'{side} {piece["from_s"]:.2f}-{piece["to_s"]:.2f}: second reader: {error}'
            print(f'live: {state["error"]}', flush=True)
        piece['wav'].unlink(missing_ok=True)

    def step(side, tail=False):
        # Read what is ready on one side. Returns the tail's record at stop, else None.
        s = state['sides'][side]; caf = folder / f'{side}.caf'
        if side not in infos:
            if not caf.exists() and side == 'them': link_split(folder)   # a split's Mac-sound folder: the recorder's file came late
            if not caf.exists(): return {'from_s': 0.0, 'to_s': 0.0, 'words': 0, 'engine_s': 0.0, 'skipped': True} if tail else None
            infos[side] = caf_info(caf)
        heard = heard_s(caf, infos[side]); s['heard_s'] = round(heard, 2)
        while True:
            length = heard - s['read_s']
            if tail and length < HOP: return {'from_s': s['read_s'], 'to_s': s['read_s'], 'words': 0, 'engine_s': 0.0, 'skipped': True}
            if not tail and length < PIECE_MIN_S: return None
            try: x, context = stretch(side, s['read_s'], heard)
            except (Exception, SystemExit) as error:
                s['errors'] += 1; state['error'] = f'{side} {s["read_s"]:.2f}-{heard:.2f}: ffmpeg: {error}'; print(f'live: {state["error"]}', flush=True)
                return None
            rms = rms_frames(x); floor = floor_of(rms)
            ahead = x[:0]
            if tail: to_s, reason = round(s['read_s'] + len(x) / 16000, 2), 'tail'
            else:
                to_s, reason = next_piece(s['read_s'], heard, rms, floor)
                if to_s is None: return None
                n_own = int(round((to_s - s['read_s']) * 16000)); ahead = x[n_own:n_own + int(LOOKAHEAD_S * 16000)]; x = x[:n_own]; rms = rms_frames(x)
            from_s = s['read_s']; s['read_s'] = to_s
            if is_silent(rms, floor):
                s['skipped_silent'] += 1; cuts_made[side] += 1
                print(f'live: {side} {from_s:.2f}-{to_s:.2f} silent, not read', flush=True)
                record = {'from_s': from_s, 'to_s': to_s, 'words': 0, 'engine_s': 0.0, 'skipped': True}
            else: record = read_piece(side, from_s, x, reason, context, ahead)
            if tail: return record
            if heard - s['read_s'] < PIECE_MIN_S: return None   # a stretch may hold more than one piece (a reader that fell behind)

    gone_at = None
    while True:
        if stop_file.exists() or (gone_at is not None and now() - gone_at >= GRACE_S): break
        if gone_at is None and not recorder_alive(): gone_at = now()
        try:
            for side in state['sides']: step(side)
            while queue and not stop_file.exists():   # the second reader works only while nobody waits: Parakeet's pieces first, no new read once stop is asked
                read_second(queue.pop(0)); save()
                for side in state['sides']: step(side)
        except LiveFormat as error:
            state['error'] = str(error); save(); print(f'live: {error}', flush=True); return 2
        save(); sleep(TICK_S)
    streams = end_stream()   # the last utterance comes back first, then the pieces' tail settles every word
    t0 = now(); tail = {}
    try:
        for side in state['sides']: tail[side] = step(side, tail=True)
    except LiveFormat as error:
        state['error'] = str(error); save(); print(f'live: {error}', flush=True); return 2
    for side, r in tail.items(): state['sides'][side]['read_s'] = max(state['sides'][side]['read_s'], r['to_s'])
    for piece in queue: piece['wav'].unlink(missing_ok=True)   # pieces the second reader never reached are built from Parakeet alone
    save(); write_readable(folder)
    write_json(live / 'done.json', {'tail': tail, 'seconds': round(now() - t0, 2), 'at': iso(now())})
    if streams:
        import stream
        try: stream.check(folder)   # after done.json: stop never waits on it
        except Exception as error: print(f'live: no stream check: {error}', flush=True)
    return 0

READABLE = threading.Lock()   # the reader's loop and the two stream threads write transcript-live.md and state.json in turn
STREAM_EDGE_S = 0.3           # a streamed word whose middle falls this close before a piece's end is still the piece's (read twice)

def streamed_words(folder, side, settled_s):
    # The stream's words for one side after the stretch Parakeet has read (live/<side>-stream.json, stream.py), and the
    # utterance still being heard as words spread over the seconds it covers. The part of that utterance that began before
    # `settled_s` is dropped in proportion: Parakeet already has those words.
    data = read_json(Path(folder) / 'live' / f'{side}-stream.json')
    if not isinstance(data, dict): return []
    words = [w for w in data.get('words') or [] if (w['start'] + w['end']) / 2 >= settled_s - STREAM_EDGE_S]
    partial, sent = data.get('partial'), float(data.get('sent_s') or 0)
    if partial and partial.get('text') and partial.get('t') is not None and sent > partial['t']:
        said, t = partial['text'].split(), float(partial['t'])
        if t < settled_s: said = said[min(len(said), round(len(said) * (settled_s - t) / (sent - t))):]; t = max(t, settled_s)
        after = max([w['end'] for w in words] + [t])
        step = max(0.01, (sent - after) / max(1, len(said)))
        words += [{'text': ' ' + x, 'start': round(after + i * step, 2), 'end': round(after + (i + 1) * step, 2), 'p': 1.0} for i, x in enumerate(said)]
    return words

def write_readable(folder):
    # live/transcript-live.md: the lines so far, merged and written the way transcript.md is (no header). Only the first
    # reader's words go in where a piece was read, so nothing is marked here (the marks come at stop, from build_tracks);
    # after the last piece, the stream's words, newest about a second old. Written whole (os.replace): the panel never reads half.
    # One side of a split recording writes its own lines only, labelled as transcript.md labels them (Room or Them).
    import call
    folder = Path(folder)
    with READABLE:
        sides, _, _ = live_sides(folder); tracks = {}
        for side in sides:
            settled = max([l['to'] for l in read_words(folder / 'live' / f'{side}-words.jsonl')] + [0.0])
            tracks[side] = ne.lines_of(sides[side][0] + streamed_words(folder, side, settled))
        lines, _ = call.merge_sides(tracks, tuple(sides))
        out = folder / 'live' / 'transcript-live.md'; tmp = out.with_name(out.name + '.tmp')
        tmp.write_text(transcript.markdown(lines, lambda l: l['who'])); os.replace(tmp, out)
