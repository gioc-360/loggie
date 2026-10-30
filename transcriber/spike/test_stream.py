# Live stream tests (proposal-live-stream.md, I1 and I2): the standard-library socket against a fake engine that speaks
# the realtime protocol, and one side's stream on a CAF that grows while it is read. No model, no network beyond 127.0.0.1.
#   python3 test_stream.py   (exit 0 = pass)
import base64, hashlib, json, socket, struct, tempfile, threading, time
from pathlib import Path
import numpy as np
import live, stream
from fixtures import caf_bytes

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

class FakeEngine:
    # A realtime endpoint: session.created on connect, records session.update, counts the PCM16 bytes it is sent, and per
    # whole second of audio sends a delta ("w<n>") and then a final whose one word ends 0.2 s before that second. With
    # `drop_after_s` it closes the first connection once that much audio arrived. `ping` sends a ping first.
    def __init__(self, rate=48000, drop_after_s=None, ping=False, key='k'):
        self.rate, self.drop_after_s, self.ping, self.key = rate, drop_after_s, ping, key
        self.sessions, self.received, self.pongs, self.refused = [], [], 0, 0
        self.srv = socket.socket(); self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(('127.0.0.1', 0)); self.srv.listen(4); self.port = self.srv.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        n = 0
        while True:
            try: conn, _ = self.srv.accept()
            except OSError: return
            threading.Thread(target=self.handle, args=(conn, n), daemon=True).start(); n += 1

    def frame(self, conn, opcode, data):
        n = len(data); head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack('>H', n))
        conn.sendall(head + data)

    def read_frame(self, f):
        b0, b1 = f.read(2); n = b1 & 0x7f
        if n == 126: n = struct.unpack('>H', f.read(2))[0]
        elif n == 127: n = struct.unpack('>Q', f.read(8))[0]
        assert b1 & 0x80, 'a client frame must be masked'
        mask = f.read(4); data = bytes(b ^ mask[i % 4] for i, b in enumerate(f.read(n)))
        return b0 & 0x0f, data

    def handle(self, conn, n):
        f = conn.makefile('rb')
        head = b''
        while not head.endswith(b'\r\n\r\n'): head += f.read(1)
        lines = head.decode().split('\r\n'); hdr = {l.split(': ', 1)[0].lower(): l.split(': ', 1)[1] for l in lines[1:] if ': ' in l}
        if hdr.get('authorization') != f'Bearer {self.key}':
            self.refused += 1; conn.sendall(b'HTTP/1.1 401 Unauthorized\r\n\r\n'); conn.close(); return
        accept = base64.b64encode(hashlib.sha1((hdr['sec-websocket-key'] + GUID).encode()).digest()).decode()
        conn.sendall(f'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n'.encode())
        if self.ping: self.frame(conn, 0x9, b'hi')
        self.frame(conn, 0x1, json.dumps({'type': 'session.created'}).encode())
        got, said = 0, 0
        self.received.append(0)
        try:
            while True:
                op, data = self.read_frame(f)
                if op == 0xA: self.pongs += 1; continue
                if op == 0x8: break
                if op == 0x1:
                    e = json.loads(data)
                    if e['type'] == 'session.update': self.sessions.append(e['session'])
                    if e['type'] == 'input_audio_buffer.commit':
                        self.frame(conn, 0x1, json.dumps({'type': 'input_audio_buffer.committed'}).encode()); break
                    continue
                got += len(data); self.received[n] = got
                while (got / 2) // self.rate > said:
                    said += 1
                    self.frame(conn, 0x1, json.dumps({'type': 'conversation.item.input_audio_transcription.delta', 'delta': f' w{said}'}).encode())
                    self.frame(conn, 0x1, json.dumps({'type': 'conversation.item.input_audio_transcription.completed', 'transcript': f'w{said}',
                                                      'words': [{'word': f'w{said}', 'start': said - 0.5, 'end': said - 0.2, 'confidence': 1}]}).encode())
                if n == 0 and self.drop_after_s and got / 2 / self.rate >= self.drop_after_s: break
        except (ValueError, OSError): pass
        conn.close()

class Growing:
    # A CAF the way the recorder writes it: the header, then float32 frames appended in real time on a thread.
    def __init__(self, path, seconds, rate=48000, chunk_s=0.05):
        self.path, self.rate = Path(path), rate
        self.path.write_bytes(caf_bytes(b'')); self.info = live.caf_info(self.path)
        x = (0.2 * np.sin(np.arange(int(seconds * rate)) / rate * 2 * np.pi * 300)).astype('<f4').tobytes()
        def write():
            step = int(rate * chunk_s) * 4
            for i in range(0, len(x), step):
                with open(self.path, 'ab') as f: f.write(x[i:i + step])
                time.sleep(chunk_s / 10)   # ten times real time: the test takes a tenth of the audio's length
        self.thread = threading.Thread(target=write, daemon=True); self.thread.start()

def wait(cond, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        time.sleep(0.02)
    return False

def test_the_socket_shakes_hands_masks_its_frames_answers_pings_and_reads_text():
    engine = FakeEngine(ping=True)
    ws = stream.Socket('127.0.0.1', engine.port, '/v1/audio/transcriptions/realtime', {'Authorization': 'Bearer k'})
    assert ws.recv() == {'type': 'session.created'}
    ws.send_text({'type': 'session.update', 'session': {'sample_rate': 48000}})
    ws.send_binary(b'\x00\x01' * 48000)   # one second of PCM16: a 96,000-byte frame (64-bit length)
    assert ws.recv()['delta'] == ' w1' and ws.recv()['words'][0]['end'] == 0.8
    assert wait(lambda: engine.pongs == 1 and engine.sessions == [{'sample_rate': 48000}])
    ws.close()

def test_the_socket_refuses_a_wrong_key_loudly():
    engine = FakeEngine(key='right')
    try: stream.Socket('127.0.0.1', engine.port, '/', {'Authorization': 'Bearer wrong'}); assert False, 'a refused handshake must raise'
    except stream.Closed as error: assert '401' in str(error)

def test_pcm16_clips_and_scales_the_recorders_floats():
    raw = np.array([0.0, 0.5, -1.0, 2.0, -3.0], '<f4').tobytes()
    assert list(np.frombuffer(stream.pcm16(raw), '<i2')) == [0, 16383, -32767, 32767, -32767]

def test_a_side_streams_a_growing_file_and_its_words_land_on_the_calls_clock():
    with tempfile.TemporaryDirectory() as d:
        engine = FakeEngine(); caf = Growing(Path(d) / 'them.caf', 5.0)
        changes = []
        s = stream.SideStream('them', caf.path, 48000, caf.info['data_offset'], lambda: stream.Socket('127.0.0.1', engine.port, '/', {'Authorization': 'Bearer k'}),
                              on_change=lambda side: changes.append(side.snapshot()))
        s.start(); caf.thread.join(); assert wait(lambda: len(s.snapshot()['words']) == 5), s.snapshot()
        s.stop()
        snap = s.snapshot()
        assert [w['text'] for w in snap['words']] == [' w1', ' w2', ' w3', ' w4', ' w5'] and [w['end'] for w in snap['words']] == [0.8, 1.8, 2.8, 3.8, 4.8]
        # each word ends 0.2 s before the second that makes the engine say it; at ten times real time the sender catches
        # up half a second at a time, so up to two such sends can land before the word is seen
        assert all(0.2 <= w['lag'] <= 0.2 + 2 * 5 * stream.FRAME_S for w in snap['words']), snap['words']
        assert snap['sent_s'] == 5.0 and engine.received == [5.0 * 48000 * 2] and snap['connects'] == 1 and snap['errors'] == 0
        assert engine.sessions == [{'sample_rate': 48000, 'language': 'en', 'word_timestamps': True}]
        assert changes and changes[-1]['words'] == snap['words']
        assert stream.stream_lag(snap['words'])['words'] == 5

def test_a_dropped_socket_reconnects_from_the_byte_it_reached_and_keeps_the_clock():
    with tempfile.TemporaryDirectory() as d:
        engine = FakeEngine(drop_after_s=2.0); caf = Growing(Path(d) / 'me.caf', 6.0)
        stream.RETRY_S, retry = 0.05, stream.RETRY_S
        try:
            s = stream.SideStream('me', caf.path, 48000, caf.info['data_offset'], lambda: stream.Socket('127.0.0.1', engine.port, '/', {'Authorization': 'Bearer k'}))
            s.start(); caf.thread.join(); assert wait(lambda: s.snapshot()['sent_s'] == 6.0 and len(engine.received) == 2 and engine.received[1] > 0)
            assert wait(lambda: s.snapshot()['words'] and s.snapshot()['words'][-1]['end'] >= 5.0), s.snapshot()
            s.stop()
        finally: stream.RETRY_S = retry
        snap = s.snapshot(); ends = [w['end'] for w in snap['words']]
        assert snap['connects'] == 2 and snap['errors'] == 1 and ends == sorted(ends), snap
        total = 6.0 * 48000 * 2   # no audio is sent twice; what was in flight when the socket dropped is lost to the stream (Parakeet still reads it)
        assert total - 0.6 * 48000 * 2 <= sum(engine.received) <= total, engine.received
        base = (total - engine.received[1]) / 2 / 48000   # the second connection began where the first one stopped sending
        assert all(abs((e - base) % 1 - 0.8) < 0.01 for e in ends if e > base), (base, ends)   # the second connection's words moved by where it started

def test_stream_lag_reports_none_without_words():
    assert stream.stream_lag([]) == {'words': 0, 'p50': None, 'p90': None}
    assert stream.stream_lag([{'lag': x} for x in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 3.0)]) == {'words': 10, 'p50': 0.6, 'p90': 3.0}

def words(*spec):
    # ('hello', 1.0, 1.4), ... -> engine-shaped words
    return [{'text': ' ' + t, 'start': a, 'end': b, 'p': 1.0} for t, a, b in spec]

def call_folder(d, me_pieces=(), them_pieces=(), me_stream=None, them_stream=None):
    folder = Path(d) / 'call'; (folder / 'live').mkdir(parents=True)
    for side, pieces in (('me', me_pieces), ('them', them_pieces)):
        for n, (a, b, ws) in enumerate(pieces): live.append_line(folder / 'live' / f'{side}-words.jsonl', {'piece': n, 'from': a, 'to': b, 'reason': 'pause', 'words': ws})
    for side, data in (('me', me_stream), ('them', them_stream)):
        if data is not None: live.write_json(folder / 'live' / f'{side}-stream.json', data)
    return folder

def test_the_readable_transcript_is_parakeet_where_a_piece_was_read_then_the_stream_then_the_utterance_still_heard():
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d, them_pieces=[(0.0, 30.0, words(('Settled', 1.0, 1.4), ('words.', 1.5, 2.0)))],
                             them_stream={'words': words(('settld', 1.0, 1.4), ('twice', 29.8, 30.4), ('streamed', 31.0, 31.5), ('line.', 31.6, 32.0)),
                                          'partial': {'text': 'still being', 't': 33.0}, 'sent_s': 34.0})
        live.write_readable(folder)
        text = (folder / 'live' / 'transcript-live.md').read_text()
        assert 'Settled words.' in text and 'settld' not in text, text            # the piece's words win where it read
        assert 'twice' in text and 'streamed line.' in text, text                  # a word across the piece's end stays once, from the stream
        assert text.rstrip().endswith('still being'), text                         # the utterance still heard comes last
        assert text.count('Them:') >= 1 and 'Me:' not in text

def test_a_partial_that_began_before_the_last_piece_ended_loses_its_settled_part():
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d, me_pieces=[(0.0, 30.0, words(('one', 26.0, 26.5), ('two', 27.0, 27.5)))],
                             me_stream={'words': [], 'partial': {'text': 'one two three four', 't': 26.0, }, 'sent_s': 34.0})
        assert [w['text'] for w in live.streamed_words(folder, 'me', 30.0)] == [' three', ' four']
        assert live.streamed_words(folder, 'them', 30.0) == []                     # no stream file: nothing, no error

def test_the_check_passes_a_fast_close_stream_and_fails_a_slow_or_wrong_one():
    settled = words(*[(f'w{i}', i, i + 0.5) for i in range(30)])
    fast = [{**w, 'lag': 0.4} for w in settled]
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d, me_pieces=[(0.0, 31.0, settled)], me_stream={'words': fast, 'connects': 1, 'errors': 0})
        out = stream.check(folder, now='t')
        assert out['pass'] is True and out['sides']['me']['agreement'] == 1.0 and out['sides']['me']['lag']['p90'] == 0.4
        assert out['sides']['them'] == {'judged': False, 'why': 'no stream file'}
        assert json.loads((folder / 'live' / 'stream-check.json').read_text())['pass'] is True
    with tempfile.TemporaryDirectory() as d:
        folder = call_folder(d, me_pieces=[(0.0, 31.0, settled)], me_stream={'words': [{**w, 'lag': 2.5} for w in settled]})
        assert stream.check(folder)['pass'] is False                               # p90 2.5 s > 2.0 s
    with tempfile.TemporaryDirectory() as d:
        wrong = [{**w, 'text': ' x'} if i % 5 == 0 else w for i, w in enumerate(fast)]
        folder = call_folder(d, me_pieces=[(0.0, 31.0, settled)], me_stream={'words': wrong})
        out = stream.check(folder); assert out['pass'] is False and out['sides']['me']['agreement'] == 0.8, out

if __name__ == '__main__':
    import fixtures; fixtures.run(globals())
