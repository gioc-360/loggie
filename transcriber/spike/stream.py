# Live stream (proposal-live-stream.md): the words of a call on screen within about a second. A warm NVIDIA engine
# (NeMo-Speech.cpp `serve`, Nemotron 3.5 ASR Streaming) is fed each side's growing CAF a tenth of a second at a time over
# its realtime socket, and its words land in live/<side>-stream.json for the readable transcript. The screen only: the
# final transcript is still built from live.py's Parakeet pieces, which replace these words every piece.
#   Server        the engine process: a free port on 127.0.0.1, a random key, endpointing on; started and stopped by live.run
#   Socket        a WebSocket client on the standard library alone (the bundled Python is pinned by hash, no new packages)
#   SideStream    one side: tails the CAF, sends PCM16 frames, keeps finals and the partial, reconnects from where it is
#   stream_lag    the falsifier's first number, from a stream file: how long after a word ended it was first seen
#   check         both numbers for a finished call, into live/stream-check.json (lag p90 <= 2.0 s, agreement >= 0.85)
import base64, json, os, secrets, socket, struct, subprocess, threading, time, urllib.request
from pathlib import Path
import numpy as np
import nvidia_engine as ne
from nvidia_asr import NSC

FRAME_S = 0.1        # how much audio each send carries, and how often the file is looked at
READY_S = 20.0       # how long the engine gets to load, on its own thread (4.1 to 18.4 s on 28 calls; 2026-10-27, cut from 60
                     # s: at load 100+ it never answered, and a later engine only competes with the pieces for the GPU)
WRITE_EVERY_S = 0.25 # the stream file is rewritten at most this often per side (the panel reads it about every 0.3 s)
RETRY_S = 2.0        # a dropped socket is reopened after this long, from the byte the stream had reached
FINISH_S = 3.0       # at stop, how long the last utterance gets to come back after the commit
RIGHT_CONTEXT = -1   # the model's widest look-ahead: 3 steps of 320 ms. On 180 s of a real call (2026-10-14) agreement with
                     # Parakeet 0.841 -> 0.854 (both sides, by words) for word lag p90 0.18 -> 0.32 s, well inside the 2.0 s mark
LANGUAGE = 'en'      # unset, the multilingual model switched to Devanagari mid-call (agreement 0.233 -> 0.867 pinned, S3)

# ---------- the engine process ----------

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

class Server:
    # `nemo-speech serve` with the streaming model, local only. start() returns once /ready answers, or raises.
    def __init__(self, model=None, binary=NSC, log=None):
        self.model, self.binary, self.log = Path(model or ne.NEMOTRON), Path(binary), log
        self.port, self.key, self.proc = free_port(), secrets.token_hex(16), None

    def start(self, timeout=READY_S):
        if not self.model.exists(): raise RuntimeError(f'missing NVIDIA model {self.model}')
        if not self.binary.exists(): raise RuntimeError(f'missing NVIDIA runtime {self.binary}')
        out = open(self.log, 'w') if self.log else subprocess.DEVNULL
        self.proc = subprocess.Popen([str(self.binary), 'serve', '--asr-model', str(self.model), '--host', '127.0.0.1', '--port', str(self.port),
                                      '--no-ui', '--device', 'metal', '--api-key', self.key, '--asr.endpointing.enable=true',
                                      f'--asr.streaming.rnnt_right_context={RIGHT_CONTEXT}'],
                                     stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < timeout:
            if self.proc.poll() is not None: raise RuntimeError(f'the stream engine exited ({self.proc.returncode}) before it was ready')
            try:
                req = urllib.request.Request(f'http://127.0.0.1:{self.port}/ready', headers={'Authorization': f'Bearer {self.key}'})
                with urllib.request.urlopen(req, timeout=1) as r:
                    if json.loads(r.read() or b'{}').get('ready'): return round(time.time() - t0, 2)
            except (OSError, ValueError): pass
            time.sleep(0.25)
        self.stop(); raise RuntimeError(f'the stream engine was not ready after {timeout:.0f} s')

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(5)
            except subprocess.TimeoutExpired: self.proc.kill()

# ---------- the socket ----------

class Closed(Exception): pass

class Socket:
    # RFC 6455, client side: one connection, text and binary out (masked, as a client must), text in. Pings are answered.
    def __init__(self, host, port, path, headers=None, timeout=10.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [f'GET {path} HTTP/1.1', f'Host: {host}:{port}', 'Upgrade: websocket', 'Connection: Upgrade',
                 f'Sec-WebSocket-Key: {key}', 'Sec-WebSocket-Version: 13'] + [f'{k}: {v}' for k, v in (headers or {}).items()]
        self.sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(4096)
            if not chunk: raise Closed('the engine closed the socket during the handshake')
            head += chunk
        head, self.buf = head.split(b'\r\n\r\n', 1)
        status = head.split(b'\r\n', 1)[0]
        if b' 101 ' not in status + b' ': raise Closed(f'the engine refused the socket: {status.decode(errors="replace")}')
        self.lock = threading.Lock()
        self.sock.settimeout(None)

    def _send(self, opcode, data):
        mask = os.urandom(4); n = len(data)
        head = bytes([0x80 | opcode]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
        body = (np.frombuffer(data, np.uint8) ^ np.resize(np.frombuffer(mask, np.uint8), n)).tobytes() if n else b''
        with self.lock: self.sock.sendall(head + mask + body)

    def send_text(self, obj): self._send(0x1, json.dumps(obj).encode())
    def send_binary(self, data): self._send(0x2, data)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk: raise Closed('the engine closed the socket')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        # The next text message as a dict. Raises Closed when the engine closes.
        parts = []
        while True:
            b0, b1 = self._read(2); n = b1 & 0x7f
            if n == 126: n = struct.unpack('>H', self._read(2))[0]
            elif n == 127: n = struct.unpack('>Q', self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask: data = (np.frombuffer(data, np.uint8) ^ np.resize(np.frombuffer(mask, np.uint8), n)).tobytes()
            op = b0 & 0x0f
            if op == 0x8: raise Closed('the engine closed the socket')
            if op == 0x9: self._send(0xA, data); continue
            if op == 0xA: continue
            parts.append(data)
            if b0 & 0x80: return json.loads(b''.join(parts))

    def close(self):
        try: self._send(0x8, b'')
        except OSError: pass
        try: self.sock.close()
        except OSError: pass

# ---------- one side ----------

def pcm16(raw):
    # The recorder's float32 little-endian samples as PCM16 little-endian, clipped.
    return (np.clip(np.frombuffer(raw, '<f4'), -1, 1) * 32767).astype('<i2').tobytes()

class SideStream:
    # One side's stream, on two threads (send, receive). `info` is live.caf_info's (rate, channels, offset, ...) for the
    # side's CAF; `connect()` returns a Socket. Every change goes to `on_change(self)`, at most every WRITE_EVERY_S.
    # Words are on the call's clock: the engine's times plus where this connection started in the file.
    def __init__(self, side, caf, rate, offset, connect, on_change=lambda s: None, now=time.time, sleep=time.sleep):
        self.side, self.caf, self.rate, self.offset = side, Path(caf), rate, offset
        self.connect, self.on_change, self.now, self.sleep = connect, on_change, now, sleep
        self.words, self.partial, self.partial_t, self.seen = [], '', None, []   # seen: (audio sent, words in the partial) per delta
        self.sent_s, self.base_s, self.connects, self.errors, self.error = 0.0, 0.0, 0, 0, None
        self.stopping, self.finished = threading.Event(), threading.Event()
        self.lock, self.wrote, self.thread = threading.Lock(), 0.0, None

    def start(self):
        self.thread = threading.Thread(target=self.run, name=f'stream-{self.side}', daemon=True); self.thread.start()

    def stop(self, wait=FINISH_S + 2):
        self.stopping.set()
        if self.thread: self.thread.join(wait)
        self.changed(force=True)

    def snapshot(self):
        with self.lock:
            return {'words': list(self.words), 'partial': {'text': self.partial.strip(), 't': self.partial_t} if self.partial.strip() else None,
                    'sent_s': round(self.sent_s, 2), 'connects': self.connects, 'errors': self.errors, 'error': self.error}

    def changed(self, force=False):
        if force or self.now() - self.wrote >= WRITE_EVERY_S:
            self.wrote = self.now(); self.on_change(self)

    def run(self):
        sent_bytes = self.offset; step = int(self.rate * FRAME_S) * 4
        while not self.stopping.is_set():
            try:
                ws = self.connect(); self.connects += 1; self.base_s = (sent_bytes - self.offset) / 4 / self.rate
                ws.recv()   # session.created
                ws.send_text({'type': 'session.update', 'session': {'sample_rate': int(self.rate), 'language': LANGUAGE, 'word_timestamps': True}})
                receiver = threading.Thread(target=self.receive, args=(ws,), daemon=True); receiver.start()
                with open(self.caf, 'rb') as f:
                    while not self.stopping.is_set() and receiver.is_alive():
                        f.seek(sent_bytes); raw = f.read(step * 5)   # catch up up to half a second at once, else one frame
                        raw = raw[:len(raw) // 4 * 4]
                        if raw:
                            ws.send_binary(pcm16(raw)); sent_bytes += len(raw)
                            with self.lock: self.sent_s = (sent_bytes - self.offset) / 4 / self.rate
                        if len(raw) < step: self.sleep(FRAME_S)
                if self.stopping.is_set() and receiver.is_alive():
                    ws.send_text({'type': 'input_audio_buffer.commit'}); receiver.join(FINISH_S)
                ws.close(); receiver.join(1)
                if self.stopping.is_set(): break
                raise Closed(self.error or 'the receive side ended')
            except (OSError, Closed, ValueError) as error:
                self.errors += 1; self.error = str(error)
                with self.lock: self.partial, self.partial_t, self.seen = '', None, []
                self.changed(force=True)
                if self.stopping.wait(RETRY_S): break
        self.finished.set()

    def receive(self, ws):
        try:
            while True:
                e = ws.recv(); kind = e.get('type', '')
                if kind.endswith('transcription.delta'):
                    with self.lock:
                        if self.partial_t is None: self.partial_t = round(max(0.0, self.sent_s - 0.3), 2)
                        self.partial += e.get('delta') or ''
                        self.seen.append((self.sent_s, len(self.partial.split())))
                    self.changed()
                elif kind.endswith('transcription.completed'):
                    with self.lock:
                        for i, w in enumerate(e.get('words') or []):
                            first = next((s for s, n in self.seen if n > i), self.sent_s)   # the audio sent when this word first showed
                            end = round(self.base_s + float(w['end']), 2)
                            self.words.append({'text': ' ' + str(w['word']).strip(), 'start': round(self.base_s + float(w['start']), 2), 'end': end, 'p': 1.0,
                                               'lag': round(max(0.0, first - end), 2)})
                        self.partial, self.partial_t, self.seen = '', None, []
                    self.changed(force=True)
                elif kind == 'error':
                    self.error = str(e.get('error') or e)
        except (OSError, Closed, ValueError) as error:
            if not self.stopping.is_set(): self.error = str(error)

def connector(server, path='/v1/audio/transcriptions/realtime'):
    return lambda: Socket('127.0.0.1', server.port, path, {'Authorization': f'Bearer {server.key}'})

LAG_P90_S = 2.0      # the falsifier (proposal-live-stream.md), set before the build: either number failing fails the bet
AGREEMENT_MIN = 0.85

def check(folder, now=None):
    # The stream's words against the pieces' Parakeet words over the same seconds, per side, and the lag of the words.
    # Seconds of audio only; nothing of what was said. A side with fewer than 20 settled words is not judged.
    import live
    from datetime import datetime
    folder = Path(folder); out = {'sides': {}, 'lag_p90_max_s': LAG_P90_S, 'agreement_min': AGREEMENT_MIN}
    for side in live.sides_in(folder):
        data = live.read_json(folder / 'live' / f'{side}-stream.json')
        if not isinstance(data, dict): out['sides'][side] = {'judged': False, 'why': 'no stream file'}; continue
        words = data.get('words') or []; end = max([w['end'] for w in words] + [0.0])
        settled = [w for l in live.read_words(folder / 'live' / f'{side}-words.jsonl') for w in l['words'] if w['end'] <= end]
        lag = stream_lag(words); agree = round(live.agreement(words, settled), 3) if settled else None
        judged = len(settled) >= 20 and lag['words'] > 0
        out['sides'][side] = {'judged': judged, 'words': len(words), 'settled_words': len(settled), 'lag': lag, 'agreement': agree,
                              'connects': data.get('connects'), 'errors': data.get('errors'),
                              'pass': (lag['p90'] <= LAG_P90_S and agree >= AGREEMENT_MIN) if judged else None}
    verdicts = [v['pass'] for v in out['sides'].values() if v.get('judged')]
    out['pass'] = all(verdicts) if verdicts else None
    out['at'] = now or datetime.now().astimezone().isoformat(timespec='seconds')
    live.write_json(folder / 'live' / 'stream-check.json', out)
    return out

CAF_WAIT_S = 15.0    # how long a side's file gets to appear before that side streams nothing (the recorder makes both at once)

class Streams:
    # A call's stream: the engine, then one SideStream per side as its CAF appears. Each change writes
    # live/<side>-stream.json and the readable transcript. Built by start(folder); live.run calls stats() and stop().
    def __init__(self, folder, server):
        self.folder, self.server, self.sides, self.status, self.ready_s = Path(folder), server, {}, 'starting', None

    @classmethod
    def start(cls, folder, server=None):
        import live
        folder = Path(folder); server = server or Server(log=folder / 'live' / 'stream-engine.log')
        self = cls(folder, server); self.ready_s = server.start(); self.status = 'streaming'
        def wire(side):
            caf = folder / f'{side}.caf'; t0 = time.time()
            while not caf.exists() and time.time() - t0 < CAF_WAIT_S: time.sleep(0.1)
            try: info = live.caf_info(caf)
            except (OSError, live.LiveFormat) as error: self.sides[side] = None; print(f'live: {side} not streamed: {error}', flush=True); return
            s = SideStream(side, caf, info['rate'], info['data_offset'], connector(server), on_change=self.changed)
            self.sides[side] = s; s.start()
        for side in live.sides_in(folder): threading.Thread(target=wire, args=(side,), daemon=True).start()   # one side of a split streams only its own file
        return self

    def changed(self, side):
        import live
        live.write_json(self.folder / 'live' / f'{side.side}-stream.json', side.snapshot())
        live.write_readable(self.folder)

    def stats(self):
        out = {'status': self.status, 'ready_s': self.ready_s}
        for name, s in list(self.sides.items()):
            if s is None: out[name] = {'status': 'no file'}; continue
            snap = s.snapshot(); out[name] = {'sent_s': snap['sent_s'], 'words': len(snap['words']), 'connects': snap['connects'], 'errors': snap['errors'],
                                              'error': snap['error'], 'lag': stream_lag(snap['words'])}
        return out

    def stop(self):
        for s in list(self.sides.values()):
            if s: s.stopping.set()
        for s in list(self.sides.values()):
            if s: s.stop()
        self.server.stop(); self.status = 'stopped'

# ---------- the falsifier's numbers ----------

def stream_lag(words):
    # p50 and p90 of how long after each word ended it was first seen in the stream (seconds of audio sent). The recorder's
    # write lag (about 0.5 s, spec S-L1) and the panel's poll come on top and are measured on their own.
    lags = sorted(w['lag'] for w in words if 'lag' in w)
    if not lags: return {'words': 0, 'p50': None, 'p90': None}
    return {'words': len(lags), 'p50': lags[len(lags) // 2], 'p90': lags[min(len(lags) - 1, int(len(lags) * 0.9))]}
