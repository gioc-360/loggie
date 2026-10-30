# The two sides on one clock at stop (2026-10-28): an AirPods mic (24 kHz) started 6.16 s after the system audio (48 kHz)
# on 2026-10-27 and every Me line was 6 s early. Both stop together, so the shorter side started late by the difference:
# stop says so in one line, and its wav gets that much silence in front, so every Me word moves by it. A recorder that
# wrote timing.json lined the starts up itself, and nothing is padded twice. Real ffmpeg on made-up CAFs in temp folders;
# no engine, no network.
#   python3 test_call_align.py   (exit 0 = pass)
import json, tempfile, wave
from pathlib import Path
import numpy as np
import call, live
import fixtures
from test_live_stop import World, Reader, hour_folder

def late_mic(folder, me_s=24.0, them_s=30.0):
    # them.caf 48 kHz from the first instant; me.caf 24 kHz, the same end, `them_s - me_s` seconds late
    fixtures.write_caf(folder / 'them.caf', fixtures.tone(them_s), rate=48000)
    fixtures.write_caf(folder / 'me.caf', fixtures.tone(me_s, rate=24000), rate=24000)

def wav(path):
    with wave.open(str(path)) as w: rate, x = w.getframerate(), np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')
    return len(x) / rate, int(np.argmax(np.abs(x) > 3000)) / rate   # seconds, first loud sample

def onset_reader(folder, out):
    # call.read_first as Parakeet would: a sentence where each wav's sound begins, on that wav's clock
    first = {'words': {}, 'runs': {}, 'timings_s': {}}
    for side, text in (('me', 'Hello there friend.'), ('them', 'Can you hear me?')):
        first['words'][side] = fixtures.W(text, wav(Path(folder) / f'{side}.wav')[1])
        first['runs'][f'{side}_parakeet'], first['timings_s'][f'{side}_parakeet'] = {'pieces': 1, 'peak_gb': 0.0}, 0.1
    return first

def stamps(text, me):
    # each turn's stamp, Me's (me=True) or the other side's, whatever them.py named it
    return [l[1:6] for l in text.splitlines() if l.startswith('[') and (l[8:11] == 'Me:') == me]

def test_a_mic_six_seconds_late_gets_six_seconds_of_silence_in_front():
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d); late_mic(folder)
        assert call.align(folder) == {'me': 6.0, 'them': 0.0}, call.align(folder)
        call.convert_wavs(folder)
        me_s, me_on = wav(folder / 'me.wav'); them_s, them_on = wav(folder / 'them.wav')
        assert abs(me_s - 30.0) <= 0.02 and abs(me_on - 6.0) <= 0.02, (me_s, me_on)
        assert abs(them_s - 30.0) <= 0.02 and them_on <= 0.01, (them_s, them_on)

def test_sides_within_half_a_second_or_lined_up_by_the_recorder_are_left_alone():
    with tempfile.TemporaryDirectory() as d:
        folder = Path(d); late_mic(folder, me_s=29.6)
        assert call.align(folder) == {'me': 0.0, 'them': 0.0}, 'the normal 30 to 100 ms mic lag is no reason to pad'
        late_mic(folder); (folder / 'timing.json').write_text(json.dumps({'me': {'rate': 24000, 'first_s': 6.0, 'padded_s': 6.0}}))
        assert call.align(folder) == {'me': 0.0, 'them': 0.0}, 'the recorder padded the start: never twice'
        call.convert_wavs(folder)
        assert abs(wav(folder / 'me.wav')[0] - 24.0) <= 0.02
        (folder / 'me.caf').write_bytes(b'caff'); (folder / 'timing.json').unlink()
        assert call.align(folder) == {'me': 0.0, 'them': 0.0}, 'a header that cannot be read pads nothing'

def test_stop_says_it_once_and_every_me_word_moves_six_seconds():
    # the batch path: Parakeet reads the padded wavs, so Me's first word is at 6.0 on Them's clock, not 0.0
    with tempfile.TemporaryDirectory() as d:
        root = Path(d); (root / 'calls').mkdir(); folder = root / 'calls' / '2026-10-27-1458-talk'; folder.mkdir()
        (folder / 'event.json').write_text(json.dumps(fixtures.sam.EVENT)); late_mic(folder)
        w = World(d, folder, reader_pid=None)
        w.go(convert_wavs=call.convert_wavs, read_first=onset_reader, refine=lambda *a, **kw: 0)
        out = w.out['tee'].getvalue()
        assert out.count('sides differ by 6.00 s; padding me by 6.00 s') == 1, out
        text = (folder / 'transcript.md').read_text()
        assert stamps(text, True) == ['00:06'] and stamps(text, False) == ['00:00'], text

def test_the_live_words_move_with_the_late_side():
    # the live path: the reader read each CAF on its own clock, so stop moves the late side's words before the transcript
    with tempfile.TemporaryDirectory() as d:
        folder = hour_folder(d, pieces=1); late_mic(folder); w = World(d, folder)
        for side, text in (('me', 'Hello there friend.'), ('them', 'Can you hear me?')):   # one sentence each, at 0.0 on its own file
            (folder / 'live' / f'{side}-words.jsonl').unlink()
            fixtures.put(folder, f'{side}-words.jsonl', [{'piece': 0, 'from': 0.0, 'to': 30.0, 'reason': 'pause', 'words': fixtures.W(text), 'engine_s': 0.6, 'peak_gb': 1.4, 'at': 'T'}])
        Reader(folder, w.log, speech=True, engine=w.engine).start(); w.go()
        text = (folder / 'transcript.md').read_text()
        me, them = stamps(text, True), stamps(text, False)
        assert me == ['00:06'] and them == ['00:00'], text
        assert w.out['tee'].getvalue().count('padding me by 6.00 s') == 1

if __name__ == '__main__':
    fixtures.run(globals())
